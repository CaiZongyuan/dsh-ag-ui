/**
 * Authenticated AG-UI HTTP/SSE gateway over Gateway-owned DSH Agents.
 * @module dsh-ag-ui
 */

import { timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { EventType, RunAgentInputSchema, type RunAgentInput } from '@ag-ui/core'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-tools'
import { AgUiGatewayError, publicError } from './errors.ts'
import { jsonBytes, jsonDepth, requestDigest, utf8Bytes } from './json.ts'
import { replayRun } from './run.ts'
import { ThreadBinding, type ThreadOptions } from './thread.ts'
import type { AgUiAgentLookup, AgUiPrincipal, AgUiThreadIdentity } from './types.ts'

export type { AgUiAgentLookup, AgUiPrincipal, AgUiThreadIdentity } from './types.ts'
export { AgUiGatewayError } from './errors.ts'

const HEADER_NAME = /^[a-z0-9-]+$/
const IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/

/** AG-UI HTTP, identity, lifecycle, and resource limits. */
export interface Config {
  /** Exact HTTP route. */
  path?: string
  /** Provider route for Gateway-created Agents. */
  provider: string
  /** Model id for Gateway-created Agents. */
  model: string
  /** Bearer secret shared only with the trusted BFF. */
  sharedSecret: string
  /** Header carrying the BFF-authenticated tenant id. */
  tenantHeader?: string
  /** Header carrying the BFF-authenticated user id. */
  userHeader?: string
  /** Explicitly permit a non-loopback WebServer bind. */
  allowNonLoopback?: boolean
  /** Maximum request body bytes. */
  maxRequestBytes?: number
  /** Maximum bytes in each identity or AG-UI id. */
  maxIdentityBytes?: number
  /** Maximum messages retained in one AG-UI request. */
  maxMessages?: number
  /** Maximum combined message JSON bytes. */
  maxMessageBytes?: number
  /** Maximum context entries in one run. */
  maxContexts?: number
  /** Maximum combined context JSON bytes. */
  maxContextBytes?: number
  /** Maximum client-provided Tools in one run. */
  maxTools?: number
  /** Maximum combined client Tool JSON bytes. */
  maxToolBytes?: number
  /** Maximum client Tool JSON Schema nesting depth. */
  maxToolSchemaDepth?: number
  /** Maximum forwardedProps JSON bytes. */
  maxForwardedPropsBytes?: number
  /** Maximum state JSON bytes. */
  maxStateBytes?: number
  /** Maximum process-local live threads. */
  maxThreads?: number
  /** Idle thread lifetime in milliseconds. */
  threadIdleMs?: number
  /** Frontend Tool result timeout in milliseconds. */
  frontendToolTimeoutMs?: number
  /** Maximum retained events in one run ledger entry. */
  maxRunEvents?: number
  /** Maximum retained event bytes in one run ledger entry. */
  maxRunEventBytes?: number
  /** Maximum retained run ledger entries per thread. */
  maxRunsPerThread?: number
}

/** Validated Gateway configuration. */
export const Config: z<Config> = z.object({
  path: z.string().default('/ag-ui'),
  provider: z.string().required(),
  model: z.string().required(),
  sharedSecret: z.string().required(),
  tenantHeader: z.string().default('x-dsh-tenant-id'),
  userHeader: z.string().default('x-dsh-user-id'),
  allowNonLoopback: z.boolean().default(false),
  maxRequestBytes: z.natural().default(256 * 1024),
  maxIdentityBytes: z.natural().default(256),
  maxMessages: z.natural().default(256),
  maxMessageBytes: z.natural().default(512 * 1024),
  maxContexts: z.natural().default(32),
  maxContextBytes: z.natural().default(128 * 1024),
  maxTools: z.natural().default(32),
  maxToolBytes: z.natural().default(128 * 1024),
  maxToolSchemaDepth: z.natural().default(16),
  maxForwardedPropsBytes: z.natural().default(64 * 1024),
  maxStateBytes: z.natural().default(64 * 1024),
  maxThreads: z.natural().default(100),
  threadIdleMs: z.natural().default(30 * 60 * 1000),
  frontendToolTimeoutMs: z.natural().default(5 * 60 * 1000),
  maxRunEvents: z.natural().default(4096),
  maxRunEventBytes: z.natural().default(2 * 1024 * 1024),
  maxRunsPerThread: z.natural().default(32),
})

declare module '@deepseek-ai/cordis' {
  interface Context {
    agUi: AgUiGateway
  }
}

/** Authenticated AG-UI Gateway and process-local thread owner. */
export class AgUiGateway extends Service implements AgUiAgentLookup {
  static inject = ['webServer', 'agents', 'tools']
  static Config = Config

  private readonly bindings = new Map<string, ThreadBinding>()
  private readonly creations = new Map<string, Promise<ThreadBinding>>()
  private readonly owners = new WeakMap<Agent, ThreadBinding>()
  private readonly resolved: Required<Config>

  /**
   * Register the route and own every Agent created through it.
   * @param ctx - Host context carrying WebServer, Agent registry, and Tool runtime.
   * @param config - validated route, identity, model, and resource configuration.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'agUi')
    this.resolved = config as Required<Config>
    assertConfig(ctx, this.resolved)
    ctx.effect(() => {
      const unregister = ctx.webServer.register({
        kind: 'exact',
        path: this.resolved.path,
        handler: (request, response) => this.handle(request, response),
      })
      return async () => {
        unregister()
        await this.disposeAll()
      }
    }, 'ag-ui.routeAndThreads')
  }

  /**
   * Resolve an exact live Gateway-owned Agent.
   * @param agent - candidate live Agent.
   * @returns its authenticated thread identity, or undefined when another subsystem owns it.
   */
  identityFor(agent: Agent): AgUiThreadIdentity | undefined {
    const binding = this.owners.get(agent)
    return binding?.liveAgent === agent ? binding.identity : undefined
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      if (request.method !== 'POST') {
        response.setHeader('allow', 'POST')
        throw new AgUiGatewayError('METHOD_NOT_ALLOWED', 'AG-UI accepts POST requests only.', 405)
      }
      const principal = this.authenticate(request)
      const body = await readBody(request, this.resolved.maxRequestBytes)
      const digest = requestDigest(body)
      const input = parseInput(body)
      validateLimits(input, this.resolved)
      const binding = await this.bindingFor(principal, input.threadId)
      const prior = binding.getRun(input.runId)
      if (prior !== undefined) {
        if (prior.digest !== digest) {
          throw new AgUiGatewayError('RUN_ID_CONFLICT', 'The runId was reused with different input.', 409)
        }
        await replayRun(response, prior)
        return
      }
      const controller = binding.reserveRun(input, digest)
      /* v8 ignore next -- normal response close is covered; abnormal ownership is tested through Binding.disconnect. */
      const onClose = (): void => {
        /* v8 ignore next -- abnormal close is covered at the Binding boundary; normal end is already writableEnded. */
        if (!response.writableEnded) binding.disconnect(controller)
      }
      response.on('close', onClose)
      /* v8 ignore next 4 -- writeTo contains Node response failures and otherwise settles through awaited drain/close. */
      const writer = controller.writeTo(response).catch((error: unknown) => {
        this.ctx.logger.warn(error instanceof Error ? error : new Error(String(error)))
        binding.disconnect(controller)
      })
      binding.drive(controller)
      await Promise.all([controller.done, writer])
      response.off('close', onClose)
    } catch (error) {
      this.respondError(response, publicError(error))
    }
  }

  private authenticate(request: IncomingMessage): AgUiPrincipal {
    const authorization = singleHeader(request.headers.authorization)
    const expected = `Bearer ${this.resolved.sharedSecret}`
    if (authorization === undefined || !safeEqual(authorization, expected)) {
      throw new AgUiGatewayError('UNAUTHORIZED', 'The AG-UI proxy credentials are invalid.', 401)
    }
    const tenantId = singleHeader(request.headers[this.resolved.tenantHeader])
    const userId = singleHeader(request.headers[this.resolved.userHeader])
    validateIdentity(tenantId, 'tenant', this.resolved.maxIdentityBytes)
    validateIdentity(userId, 'user', this.resolved.maxIdentityBytes)
    return { tenantId, userId }
  }

  private async bindingFor(principal: AgUiPrincipal, threadId: string): Promise<ThreadBinding> {
    const key = bindingKey(principal, threadId)
    const existing = this.bindings.get(key)
    if (existing !== undefined) return existing
    const pending = this.creations.get(key)
    /* v8 ignore next -- simultaneous requests behavior-test this map; local scheduling may publish before the second read. */
    if (pending !== undefined) return pending
    if (this.bindings.size + this.creations.size >= this.resolved.maxThreads) {
      throw new AgUiGatewayError('THREAD_LIMIT_REACHED', 'The AG-UI thread limit is reached.', 429)
    }
    const creation = this.createBinding(key, principal, threadId)
    this.creations.set(key, creation)
    /* v8 ignore next -- the request awaits the original rejection; this observes the derived finally Promise. */
    const observeFinallyFailure = (): void => {}
    void creation.finally(() => { this.creations.delete(key) }).catch(observeFinallyFailure)
    return creation
  }

  private async createBinding(key: string, principal: AgUiPrincipal, threadId: string): Promise<ThreadBinding> {
    const options: ThreadOptions = {
      provider: this.resolved.provider,
      model: this.resolved.model,
      frontendToolTimeoutMs: this.resolved.frontendToolTimeoutMs,
      threadIdleMs: this.resolved.threadIdleMs,
      maxRunEvents: this.resolved.maxRunEvents,
      maxRunEventBytes: this.resolved.maxRunEventBytes,
      maxRunsPerThread: this.resolved.maxRunsPerThread,
      maxStateBytes: this.resolved.maxStateBytes,
    }
    const binding = new ThreadBinding(this.ctx, principal, threadId, options, (expired) => {
      /* v8 ignore next -- one binding instance owns its idle timer; stale callbacks are contained defensively. */
      if (this.bindings.get(key) !== expired) return
      this.bindings.delete(key)
      this.owners.delete(expired.liveAgent)
      /* v8 ignore next 3 -- ThreadBinding disposal is idempotent and contains every owned settlement. */
      void expired.dispose().catch((error: unknown) => {
        this.ctx.logger.warn(error instanceof Error ? error : new Error(String(error)))
      })
    })
    await binding.initialize()
    /* v8 ignore next 4 -- the creations map serializes publication for one exact authenticated key. */
    if (this.bindings.has(key)) {
      await binding.dispose()
      return this.bindings.get(key) as ThreadBinding
    }
    this.bindings.set(key, binding)
    this.owners.set(binding.liveAgent, binding)
    return binding
  }

  private respondError(response: ServerResponse, error: AgUiGatewayError): void {
    /* v8 ignore next 4 -- streamed failures terminate through RunController; this contains only unexpected post-header faults. */
    if (response.headersSent) {
      if (!response.writableEnded) response.destroy(error)
      return
    }
    const body = JSON.stringify({ code: error.code, message: error.message })
    response.writeHead(error.status, {
      'content-length': Buffer.byteLength(body),
      'content-type': 'application/json; charset=utf-8',
    })
    response.end(body)
  }

  private async disposeAll(): Promise<void> {
    const pending = await Promise.allSettled(this.creations.values())
    this.creations.clear()
    const bindings = [...this.bindings.values()]
    this.bindings.clear()
    for (const result of pending) {
      /* v8 ignore next -- a fulfilled creation publishes before disposal can snapshot the binding table. */
      if (result.status === 'fulfilled' && !bindings.includes(result.value)) bindings.push(result.value)
    }
    await Promise.allSettled(bindings.map(binding => binding.dispose()))
  }
}

/** Reject invalid configuration before registering the HTTP route. */
function assertConfig(ctx: Context, config: Required<Config>): void {
  if (!config.path.startsWith('/') || config.path === '/' || config.path.endsWith('/')) {
    throw new Error('ag-ui: path must be an absolute non-root pathname without a trailing slash')
  }
  if (!HEADER_NAME.test(config.tenantHeader) || !HEADER_NAME.test(config.userHeader)) {
    throw new Error('ag-ui: identity header names must contain lowercase letters, digits, or hyphens')
  }
  if (utf8Bytes(config.sharedSecret) < 16) throw new Error('ag-ui: sharedSecret must contain at least 16 UTF-8 bytes')
  if (!config.allowNonLoopback && ctx.webServer.host !== '127.0.0.1') {
    throw new Error('ag-ui: non-loopback WebServer bind requires allowNonLoopback: true')
  }
  for (const [name, value] of Object.entries(config)) {
    if ((name.startsWith('max') || name.endsWith('Ms')) && typeof value === 'number' && value <= 0) {
      throw new Error(`ag-ui: ${name} must be positive`)
    }
  }
  if (config.maxRunEvents < 2) throw new Error('ag-ui: maxRunEvents must retain opening and terminal events')
  const longestId = 'x'.repeat(config.maxIdentityBytes)
  const opening = {
    type: EventType.RUN_STARTED,
    threadId: longestId,
    runId: longestId,
    parentRunId: longestId,
  }
  const success = {
    type: EventType.RUN_FINISHED,
    threadId: longestId,
    runId: longestId,
    outcome: { type: 'success' },
  }
  const failure = {
    type: EventType.RUN_ERROR,
    code: 'AG_UI_EVENT_BUFFER_OVERFLOW',
    message: 'The AG-UI run exceeded its event buffer.',
  }
  const mandatoryBytes = utf8Bytes(JSON.stringify(opening))
    + Math.max(utf8Bytes(JSON.stringify(success)), utf8Bytes(JSON.stringify(failure)))
  if (config.maxRunEventBytes < mandatoryBytes) {
    throw new Error('ag-ui: maxRunEventBytes cannot retain mandatory opening and terminal events')
  }
}

/** Read a request body without exceeding its configured resident bound. */
async function readBody(request: IncomingMessage, maximum: number): Promise<Buffer> {
  const declared = singleHeader(request.headers['content-length'])
  if (declared !== undefined && Number(declared) > maximum) {
    throw new AgUiGatewayError('REQUEST_TOO_LARGE', 'The AG-UI request body is too large.', 413)
  }
  const mediaType = singleHeader(request.headers['content-type'])?.split(';', 1)[0]?.trim().toLowerCase()
  if (mediaType !== 'application/json') {
    throw new AgUiGatewayError('UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json.', 415)
  }
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of request) {
    /* v8 ignore next -- node:http request async iteration yields Buffer chunks on the Host runtime. */
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
    total += buffer.byteLength
    if (total > maximum) throw new AgUiGatewayError('REQUEST_TOO_LARGE', 'The AG-UI request body is too large.', 413)
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}

/** Parse one body through the pinned AG-UI schema. */
function parseInput(body: Buffer): RunAgentInput {
  let raw: unknown
  try {
    raw = JSON.parse(body.toString('utf8'))
  } catch (error) {
    throw new AgUiGatewayError('INVALID_AGUI_INPUT', 'The AG-UI request body is not valid JSON.', 400, error)
  }
  const parsed = RunAgentInputSchema.safeParse(raw)
  if (!parsed.success) {
    throw new AgUiGatewayError('INVALID_AGUI_INPUT', 'The AG-UI request does not match RunAgentInput.', 400, parsed.error)
  }
  return parsed.data
}

/** Apply Gateway-owned bounds after protocol parsing. */
function validateLimits(input: RunAgentInput, config: Required<Config>): void {
  validateIdentity(input.threadId, 'thread', config.maxIdentityBytes)
  validateIdentity(input.runId, 'run', config.maxIdentityBytes)
  if (input.parentRunId !== undefined) validateIdentity(input.parentRunId, 'parent run', config.maxIdentityBytes)
  if (input.messages.length > config.maxMessages || jsonBytes(input.messages, 'messages') > config.maxMessageBytes) {
    throw new AgUiGatewayError('MESSAGE_LIMIT_EXCEEDED', 'The AG-UI message history exceeds its limit.', 413)
  }
  if (input.context.length > config.maxContexts || jsonBytes(input.context, 'context') > config.maxContextBytes) {
    throw new AgUiGatewayError('CONTEXT_LIMIT_EXCEEDED', 'The AG-UI context exceeds its limit.', 413)
  }
  for (const context of input.context) {
    if (context.description.trim() === '') throw new AgUiGatewayError('INVALID_CONTEXT', 'Context descriptions must not be empty.')
  }
  if (input.tools.length > config.maxTools || jsonBytes(input.tools, 'tools') > config.maxToolBytes) {
    throw new AgUiGatewayError('TOOL_LIMIT_EXCEEDED', 'The AG-UI Tool catalog exceeds its limit.', 413)
  }
  for (const tool of input.tools) {
    if (tool.description.trim() === '') throw new AgUiGatewayError('INVALID_FRONTEND_TOOL', 'Frontend Tool descriptions must not be empty.')
    if (jsonDepth(tool.parameters) > config.maxToolSchemaDepth) {
      throw new AgUiGatewayError('TOOL_SCHEMA_TOO_DEEP', 'A frontend Tool schema exceeds its depth limit.', 413)
    }
  }
  if (input.forwardedProps !== undefined
    && jsonBytes(input.forwardedProps, 'forwardedProps') > config.maxForwardedPropsBytes) {
    throw new AgUiGatewayError('FORWARDED_PROPS_LIMIT_EXCEEDED', 'forwardedProps exceeds its limit.', 413)
  }
  if (input.state !== undefined && jsonBytes(input.state, 'state') > config.maxStateBytes) {
    throw new AgUiGatewayError('STATE_LIMIT_EXCEEDED', 'state exceeds its limit.', 413)
  }
}

/** Require one ordinary scalar HTTP header. */
function singleHeader(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/** Constant-time equality after a public length check. */
function safeEqual(actual: string, expected: string): boolean {
  const left = Buffer.from(actual)
  const right = Buffer.from(expected)
  return left.byteLength === right.byteLength && timingSafeEqual(left, right)
}

/** Validate a principal or protocol id before using it as a registry key. */
function validateIdentity(value: string | undefined, label: string, maximum: number): asserts value is string {
  if (value === undefined || !IDENTITY.test(value) || utf8Bytes(value) > maximum) {
    throw new AgUiGatewayError('INVALID_IDENTITY', `The ${label} identifier is invalid.`, 400)
  }
}

/** Collision-free process-local key for one authenticated thread tuple. */
function bindingKey(principal: AgUiPrincipal, threadId: string): string {
  return `${principal.tenantId}\u0000${principal.userId}\u0000${threadId}`
}

export default AgUiGateway
