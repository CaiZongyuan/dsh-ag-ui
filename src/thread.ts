import type { Context } from '@deepseek-ai/cordis'
import {
  EventType,
  type Message as AgUiMessage,
  type RunAgentInput,
  type Tool as AgUiTool,
  type ToolMessage as AgUiToolMessage,
  type UserMessage as AgUiUserMessage,
} from '@ag-ui/core'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import { createUserMessage, errorChain } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, ToolResultBlock } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import {
  assertObjectJsonSchema,
  validateJsonSchemaValue,
  type ObjectJsonSchema,
  type ToolDefinition,
  type ToolRunContext,
} from '@deepseek-ai/dsh-tools'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { AgUiGatewayError } from './errors.ts'
import { jsonBytes, valueDigest } from './json.ts'
import { RunController, type RunRecord } from './run.ts'
import type { AgUiPrincipal, AgUiThreadIdentity } from './types.ts'

const FRONTEND_TOOL_NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/
const STATE_TOOL_NAME = 'ag_ui_update_state'

/** Runtime limits and model route resolved from Gateway config. */
export interface ThreadOptions {
  readonly provider: string
  readonly model: string
  readonly frontendToolTimeoutMs: number
  readonly threadIdleMs: number
  readonly maxRunEvents: number
  readonly maxRunEventBytes: number
  readonly maxRunsPerThread: number
  readonly maxStateBytes: number
}

interface AcceptedMessage {
  readonly role: 'user' | 'tool'
  readonly digest: string
}

interface FrontendToolRegistration {
  readonly dispose: () => void
  readonly fingerprint: string
}

interface PendingFrontendCall {
  readonly turn: number
  resolve(value: string): void
  reject(error: Error): void
}

interface ToolCallPosition {
  readonly turn: number
  readonly step: number
  readonly name: string
}

type ToolCallLifecycle =
  | ({ readonly kind: 'backend' } & ToolCallPosition)
  | ({ readonly kind: 'frontend'; readonly parked: true } & ToolCallPosition)
  | ({ readonly kind: 'state'; commit?: PendingStateCommit } & ToolCallPosition)

interface TextProjection {
  readonly messageId: string
  started: boolean
}

interface PreparedFrontendTool {
  readonly tool: AgUiTool
  readonly fingerprint: string
  readonly schema: ObjectJsonSchema & Record<string, unknown>
}

interface SharedStateBaseline {
  readonly active: boolean
  readonly value: unknown
}

interface PendingStateCommit {
  readonly value: unknown
  readonly changed: boolean
}

/** One authenticated process-local AG-UI thread and its owned DSH Agent. */
export class ThreadBinding {
  /** Random DSH Agent and Session identity, never derived from a client thread id. */
  readonly sessionId = SessionId(`ag-ui-${randomUUID()}`)
  /** Authenticated principal and client thread tuple owning this binding. */
  readonly identity: AgUiThreadIdentity

  private handle: AgentHandle | undefined
  private agent: Agent | undefined
  private disposed = false
  private activeRun: RunController | undefined
  private idleTimer: ReturnType<typeof setTimeout> | undefined
  private readonly acceptedMessages = new Map<string, AcceptedMessage>()
  private readonly frontendTools = new Map<string, FrontendToolRegistration>()
  private stagedTools: AgUiTool[] | undefined
  private readonly pendingCalls = new Map<string, PendingFrontendCall>()
  private readonly serverResultCallIds = new Set<string>()
  private readonly runLedger = new Map<string, RunRecord>()
  private readonly toolCallLifecycles = new Map<string, ToolCallLifecycle>()
  private readonly frontendSteps = new Set<string>()
  private readonly text = new Map<string, TextProjection>()
  private sharedState: unknown
  private sharedStateActive = false
  private stateToolDispose: (() => void) | undefined

  constructor(
    private readonly ctx: Context,
    principal: AgUiPrincipal,
    threadId: string,
    private readonly options: ThreadOptions,
    private readonly onExpired: (binding: ThreadBinding) => void,
  ) {
    this.identity = { principal, threadId }
  }

  /** Create the Agent and install scoped listeners before publication. */
  async initialize(): Promise<void> {
    const handle = await this.ctx.agents.create({
      sessionId: this.sessionId,
      agentOptions: { provider: this.options.provider, model: this.options.model },
      setup: (agentCtx) => {
        const agent = agentCtx.agent
        /* v8 ignore next -- AgentRegistry setup always carries its unpublished Agent association. */
        if (agent === undefined) throw new Error('ag-ui: unpublished Agent context has no Agent association')
        this.agent = agent
        agentCtx.on('session/event', (session, event) => {
          /* v8 ignore next -- the Agent-scoped listener receives only its exact owned Session. */
          if (session === agent.session) this.onSessionEvent(event)
        })
        agentCtx.on('agent/inbox/claimed', ({ agent: subject, message, turn }) => {
          const active = this.activeRun
          if (subject === agent && active?.messageId === String(message.id)) active.turn = turn
        })
        agentCtx.on('agent/error', ({ agent: subject, error }) => {
          /* v8 ignore next -- scope-filtered Agent errors carry this exact Agent. */
          if (subject === agent) this.onAgentError(error)
        })
        agentCtx.on('tools/change', () => { this.checkGlobalCollisions() })
      },
    })
    this.handle = handle
    this.agent = handle.agent
    this.scheduleIdleExpiry()
  }

  /** The live Agent after successful initialization. */
  get liveAgent(): Agent {
    if (this.agent === undefined || this.handle === undefined || this.disposed) {
      throw new AgUiGatewayError('AGENT_NOT_AVAILABLE', 'The AG-UI thread Agent is unavailable.', 410)
    }
    return this.agent
  }

  /**
   * Read one retained run for duplicate handling.
   * @param runId - client run identity.
   * @returns active or completed record, or undefined for a fresh id.
   */
  getRun(runId: string): RunRecord | undefined {
    return this.runLedger.get(runId)
  }

  /**
   * Reserve one run before accepting DSH input.
   * @param input - validated AG-UI request.
   * @param digest - exact request-body digest.
   * @returns the sole active controller for this thread.
   */
  reserveRun(input: RunAgentInput, digest: string): RunController {
    this.assertLive()
    this.clearIdleExpiry()
    const existing = this.runLedger.get(input.runId)
    if (existing !== undefined) {
      if (existing.digest !== digest) {
        throw new AgUiGatewayError('RUN_ID_CONFLICT', 'The runId was reused with different input.', 409)
      }
      throw new AgUiGatewayError(
        existing.state === 'active' ? 'RUN_IN_PROGRESS' : 'RUN_ALREADY_COMPLETED',
        existing.state === 'active' ? 'The AG-UI run is still active.' : 'The AG-UI run already completed.',
        409,
      )
    }
    if (this.activeRun !== undefined) {
      throw new AgUiGatewayError('RUN_IN_PROGRESS', 'This AG-UI thread already has an active run.', 409)
    }
    this.evictCompletedRuns()
    if (this.runLedger.size >= this.options.maxRunsPerThread) {
      throw new AgUiGatewayError('RUN_LEDGER_FULL', 'The AG-UI thread run ledger is full.', 429)
    }
    const record: RunRecord = { digest, events: [], state: 'active', bytes: 0 }
    this.runLedger.set(input.runId, record)
    const controller = new RunController(
      input,
      record,
      this.options.maxRunEvents,
      this.options.maxRunEventBytes,
    )
    this.activeRun = controller
    void controller.done.then(() => {
      /* v8 ignore next -- terminal settlement runs before another HTTP run can reserve this binding. */
      if (this.activeRun === controller) this.activeRun = undefined
      if (this.pendingCalls.size === 0) this.scheduleIdleExpiry()
    })
    return controller
  }

  /**
   * Start a reserved run after its SSE sink is attached.
   * @param controller - exact controller returned by {@link reserveRun}.
   */
  drive(controller: RunController): void {
    if (this.activeRun !== controller) throw new AgUiGatewayError('RUN_NOT_ACTIVE', 'The AG-UI run lost its reservation.', 409)
    controller.start()
    try {
      const admission = this.classifyMessages(controller.input.messages)
      if (admission.kind === 'user') {
        if (this.liveAgent.status !== 'idle' || this.pendingCalls.size !== 0) {
          throw new AgUiGatewayError('AGENT_BUSY', 'The thread Agent is not ready for a new user run.', 409)
        }
        const baseline = this.prepareSharedState(controller.input)
        this.assertStateToolAvailable(baseline)
        this.applyFrontendTools(controller.input.tools)
        this.injectContext(controller.input, baseline)
        this.commitSharedStateBaseline(baseline)
        const message = createUserMessage({
          content: [{ type: 'text', text: admission.message.content }],
          source: { kind: 'user' },
        })
        this.acceptedMessages.set(admission.message.id, {
          role: 'user',
          digest: valueDigest(admission.message),
        })
        controller.messageId = String(message.id)
        this.liveAgent.followup(message)
        return
      }

      const turn = this.continuationTurn(admission.messages)
      controller.turn = turn
      const baseline = this.prepareSharedState(controller.input)
      this.assertStateToolAvailable(baseline)
      this.stagedTools = controller.input.tools
      this.injectContext(controller.input, baseline)
      this.commitSharedStateBaseline(baseline)
      for (const message of admission.messages) {
        const pending = this.pendingCalls.get(message.toolCallId)
        /* v8 ignore next 3 -- continuationTurn synchronously verified the identical pending entries. */
        if (pending === undefined) {
          throw new AgUiGatewayError('UNKNOWN_TOOL_RESULT', 'The frontend Tool result has no pending call.', 409)
        }
        this.acceptedMessages.set(message.id, { role: 'tool', digest: valueDigest(message) })
        if (message.error === undefined) pending.resolve(message.content)
        else pending.reject(new Error(`Frontend Tool failed: ${message.error}`))
      }
    } catch (error) {
      const failure = error instanceof AgUiGatewayError ? error : new AgUiGatewayError('AGENT_EXECUTION_ERROR', 'The AG-UI run could not start.', 500, error)
      controller.error(failure.code, failure.message)
      if (this.liveAgent.status === 'running') {
        this.liveAgent.cancel({ kind: 'hook', reason: `AG-UI run admission failed: ${failure.code}` })
      }
    }
  }

  /**
   * Cancel the exact active Gateway run after an unexpected transport close.
   * @param controller - disconnected controller; stale controllers are ignored.
   */
  disconnect(controller: RunController): void {
    if (this.activeRun !== controller || controller.record.state !== 'active') return
    controller.error('CLIENT_DISCONNECTED', 'The AG-UI client disconnected before the run completed.')
    if (this.liveAgent.status === 'running') {
      this.liveAgent.cancel({ kind: 'hook', reason: 'AG-UI client disconnected' })
    }
  }

  /** Reject pending calls and dispose the owned Agent to quiescence. */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.clearIdleExpiry()
    this.activeRun?.error('AGENT_NOT_AVAILABLE', 'The AG-UI thread was disposed.')
    for (const pending of this.pendingCalls.values()) {
      pending.reject(new Error('AG-UI thread disposed'))
    }
    this.pendingCalls.clear()
    this.stateToolDispose?.()
    this.stateToolDispose = undefined
    this.sharedState = undefined
    this.sharedStateActive = false
    this.toolCallLifecycles.clear()
    for (const registration of this.frontendTools.values()) registration.dispose()
    this.frontendTools.clear()
    const handle = this.handle
    this.handle = undefined
    /* v8 ignore next -- initialized live bindings own a handle; repeated disposal returned above. */
    if (handle !== undefined) await handle.dispose()
  }

  private assertLive(): void {
    if (this.disposed || this.handle === undefined) {
      throw new AgUiGatewayError('AGENT_NOT_AVAILABLE', 'The AG-UI thread Agent is unavailable.', 410)
    }
  }

  private classifyMessages(messages: AgUiMessage[]):
    | { kind: 'user'; message: AgUiUserMessage & { content: string } }
    | { kind: 'tools'; messages: AgUiToolMessage[] } {
    const users: Array<AgUiUserMessage & { content: string }> = []
    const tools: AgUiToolMessage[] = []
    for (const message of messages) {
      if (message.role !== 'user' && message.role !== 'tool') continue
      const digest = valueDigest(message)
      const accepted = this.acceptedMessages.get(message.id)
      if (accepted !== undefined) {
        if (accepted.role !== message.role || accepted.digest !== digest) {
          throw new AgUiGatewayError('MESSAGE_ID_CONFLICT', 'A message id was reused with different content.', 409)
        }
        continue
      }
      if (message.role === 'tool') {
        if (this.pendingCalls.has(message.toolCallId)) tools.push(message)
        else if (this.serverResultCallIds.delete(message.toolCallId)) {
          this.acceptedMessages.set(message.id, { role: 'tool', digest })
        } else {
          throw new AgUiGatewayError('UNKNOWN_TOOL_RESULT', 'The Tool result has no pending or completed server call.', 409)
        }
      } else {
        if (typeof message.content !== 'string') {
          throw new AgUiGatewayError('UNSUPPORTED_MESSAGE_CONTENT', 'V1 accepts text user messages only.')
        }
        users.push(message as AgUiUserMessage & { content: string })
      }
    }
    if (users.length === 1 && tools.length === 0) return { kind: 'user', message: users[0] as AgUiUserMessage & { content: string } }
    if (users.length === 0 && tools.length > 0) return { kind: 'tools', messages: tools }
    throw new AgUiGatewayError(
      'INVALID_MESSAGE_BATCH',
      'A run must contain one new user message or one or more new frontend Tool results.',
    )
  }

  private continuationTurn(messages: AgUiToolMessage[]): number {
    let turn: number | undefined
    for (const message of messages) {
      const pending = this.pendingCalls.get(message.toolCallId)
      if (pending === undefined) {
        throw new AgUiGatewayError('UNKNOWN_TOOL_RESULT', 'The frontend Tool result has no pending call.', 409)
      }
      if (turn !== undefined && pending.turn !== turn) {
        throw new AgUiGatewayError('INVALID_TOOL_RESULT_BATCH', 'Frontend Tool results belong to different DSH turns.', 409)
      }
      turn = pending.turn
    }
    if (turn === undefined) throw new AgUiGatewayError('INVALID_TOOL_RESULT_BATCH', 'No frontend Tool result was supplied.')
    return turn
  }

  private injectContext(input: RunAgentInput, baseline: SharedStateBaseline): void {
    const sections = input.context.map(item => ({ name: item.description, text: item.value }))
    if (baseline.active) {
      sections.push({
        name: 'Current Shared State',
        text: `${JSON.stringify(baseline.value)}\n\nTo update this state, call ${STATE_TOOL_NAME} with a state_updates object.`,
      })
    }
    if (sections.length === 0) return
    const text = sections.map(section => `## ${section.name}\n${section.text}`).join('\n\n')
    this.liveAgent.inject(createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'plugin', plugin: 'ag-ui', form: 'snapshot', sections },
    }))
  }

  private prepareSharedState(input: RunAgentInput): SharedStateBaseline {
    if (!this.sharedStateActive
      && (input.state === undefined || input.state === null || isEmptyStateContainer(input.state))) {
      return { active: false, value: undefined }
    }
    const value = input.state === undefined ? this.sharedState : structuredClone(input.state)
    if (jsonBytes(value, 'state') > this.options.maxStateBytes) {
      throw new AgUiGatewayError('STATE_LIMIT_EXCEEDED', 'state exceeds its limit.', 413)
    }
    const active = this.activeRun
    /* v8 ignore next -- prepareSharedState runs only while drive owns the active controller. */
    if (active === undefined) throw new Error('Shared state has no active AG-UI run')
    active.assertCanEmit({ type: EventType.STATE_SNAPSHOT, snapshot: value })
    return { active: true, value }
  }

  private assertStateToolAvailable(baseline: SharedStateBaseline): void {
    if (!baseline.active) return
    const global = this.ctx.tools.get(STATE_TOOL_NAME)
    const inherited = this.stateToolDispose === undefined
      ? this.ctx.tools.get(STATE_TOOL_NAME, this.liveAgent)
      : undefined
    if (global !== undefined || inherited !== undefined) {
      throw new AgUiGatewayError(
        'SHARED_STATE_TOOL_COLLISION',
        `The reserved shared-state Tool ${STATE_TOOL_NAME} collides with an inherited Tool.`,
        409,
      )
    }
  }

  private commitSharedStateBaseline(baseline: SharedStateBaseline): void {
    if (!baseline.active) return
    const active = this.activeRun
    /* v8 ignore next -- run admission owns the active controller through baseline commit. */
    if (active === undefined) throw new Error('Shared state has no active AG-UI run')
    this.ensureStateTool()
    this.sharedState = structuredClone(baseline.value)
    this.sharedStateActive = true
    active.emit({ type: EventType.STATE_SNAPSHOT, snapshot: structuredClone(baseline.value) })
  }

  private ensureStateTool(): void {
    if (this.stateToolDispose !== undefined) return
    const definition: ToolDefinition = {
      name: STATE_TOOL_NAME,
      description: 'Shallow-merge top-level fields into shared application state. Omitted top-level keys remain; supplied nested values replace their previous values.',
      parameters: {
        type: 'object',
        properties: {
          state_updates: { type: 'object', additionalProperties: true },
        },
        required: ['state_updates'],
        additionalProperties: false,
      },
      output: {
        schema: { type: 'string' },
        render(_args, value) {
          return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }]
        },
      },
      presentCall: args => ({ card: 'generic', title: 'Update shared state', rawInput: args }),
      execute: (args, exec) => Promise.resolve(this.prepareSharedStateUpdate(args, exec)),
    }
    this.stateToolDispose = this.liveAgent.ctx.tools.register(definition)
  }

  private prepareSharedStateUpdate(args: unknown, exec: ToolRunContext): string {
    if (!this.sharedStateActive) throw new Error('Shared state is not active for this AG-UI thread')
    const callId = String(exec.callId)
    const lifecycle = this.toolCallLifecycles.get(callId)
    if (lifecycle?.kind !== 'state') throw new Error('Shared-state update has no DSH call position')
    if (lifecycle.commit !== undefined) throw new Error('Shared-state update is already pending')
    const updates = readStateUpdates(args)
    const current = this.sharedState
    const next = isUnknownRecord(current)
      ? { ...current, ...updates }
      : { ...updates }
    if (jsonBytes(next, 'state') > this.options.maxStateBytes) {
      throw new Error('Shared-state update exceeds the configured state byte limit')
    }
    const changed = !isDeepStrictEqual(next, current)
    if (changed) {
      const active = this.activeRun
      /* v8 ignore next -- the state Tool executes only while its owning Run is active. */
      if (active === undefined) throw new Error('Shared-state update has no active AG-UI run')
      active.assertCanEmit({ type: EventType.STATE_SNAPSHOT, snapshot: next })
    }
    lifecycle.commit = { value: structuredClone(next), changed }
    return JSON.stringify({ status: changed ? 'updated' : 'unchanged', state: next })
  }

  private prepareFrontendTools(tools: AgUiTool[]): PreparedFrontendTool[] {
    const prepared: PreparedFrontendTool[] = []
    const names = new Set<string>()
    for (const tool of tools) {
      if (!FRONTEND_TOOL_NAME.test(tool.name)) {
        throw new AgUiGatewayError('INVALID_FRONTEND_TOOL_NAME', 'Frontend Tool names must use a supported ASCII identifier.')
      }
      if (tool.name === STATE_TOOL_NAME) {
        throw new AgUiGatewayError('RESERVED_FRONTEND_TOOL_NAME', `${STATE_TOOL_NAME} is reserved for shared state.`)
      }
      if (names.has(tool.name)) throw new AgUiGatewayError('DUPLICATE_FRONTEND_TOOL', 'Frontend Tool names must be unique.')
      names.add(tool.name)
      assertObjectJsonSchema(tool.parameters)
      const schema = structuredClone(tool.parameters) as ObjectJsonSchema & Record<string, unknown>
      const fingerprint = valueDigest({ name: tool.name, description: tool.description, parameters: schema })
      const own = this.frontendTools.get(tool.name)
      if (own === undefined && this.ctx.tools.get(tool.name, this.liveAgent) !== undefined) {
        throw new AgUiGatewayError('FRONTEND_TOOL_NAME_COLLISION', `Frontend Tool ${tool.name} collides with an inherited Tool.`, 409)
      }
      prepared.push({ tool, fingerprint, schema })
    }
    return prepared
  }

  private applyFrontendTools(tools: AgUiTool[]): void {
    const prepared = this.prepareFrontendTools(tools)
    const incoming = new Map(prepared.map(item => [item.tool.name, item]))
    for (const [name, registration] of this.frontendTools) {
      const next = incoming.get(name)
      if (next !== undefined && next.fingerprint === registration.fingerprint) continue
      registration.dispose()
      this.frontendTools.delete(name)
    }
    for (const item of prepared) {
      if (this.frontendTools.has(item.tool.name)) continue
      const definition = this.definitionFor(item)
      const dispose = this.liveAgent.ctx.tools.register(definition)
      this.frontendTools.set(item.tool.name, {
        dispose,
        fingerprint: item.fingerprint,
      })
    }
  }

  private definitionFor(item: PreparedFrontendTool): ToolDefinition {
    return {
      name: item.tool.name,
      description: item.tool.description,
      parameters: item.schema,
      output: {
        schema: { type: 'string' },
        render(_args, value) {
          return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }]
        },
      },
      presentCall: args => ({ card: 'generic', title: item.tool.description, rawInput: args }),
      execute: (args, exec) => this.parkFrontendTool(item.tool.name, item.schema, args, exec),
    }
  }

  private parkFrontendTool(
    name: string,
    schema: ObjectJsonSchema,
    args: unknown,
    exec: ToolRunContext,
  ): Promise<string> {
    const violations = validateJsonSchemaValue(schema, args, '')
    if (violations.length > 0) throw new Error(`Invalid frontend Tool arguments: ${violations.join('; ')}`)
    const callId = String(exec.callId)
    const lifecycle = this.toolCallLifecycles.get(callId)
    if (lifecycle?.kind !== 'backend' || lifecycle.name !== name) throw new Error('Frontend Tool call has no DSH call position')
    const active = this.activeRun
    if (active === undefined || active.turn !== lifecycle.turn) throw new Error('Frontend Tool call has no active AG-UI run')
    const stepKey = `${String(lifecycle.turn)}:${String(lifecycle.step)}`
    if (this.frontendSteps.has(stepKey)) throw new Error('Only one frontend Tool call is allowed per DSH step')
    this.frontendSteps.add(stepKey)
    this.toolCallLifecycles.set(callId, { ...lifecycle, kind: 'frontend', parked: true })

    const deferred = Promise.withResolvers<string>()
    let settled = false
    const settle = (operation: () => void): void => {
      /* v8 ignore next -- late timeout, abort, or browser completion is an idempotent no-op. */
      if (settled) return
      settled = true
      clearTimeout(timer)
      exec.signal.removeEventListener('abort', onAbort)
      this.pendingCalls.delete(callId)
      operation()
      if (this.activeRun === undefined && this.pendingCalls.size === 0) this.scheduleIdleExpiry()
    }
    const pending: PendingFrontendCall = {
      turn: lifecycle.turn,
      resolve: (value) => { settle(() => { deferred.resolve(value) }) },
      reject: (error) => { settle(() => { deferred.reject(error) }) },
    }
    const onAbort = (): void => { pending.reject(new Error('Frontend Tool call aborted')) }
    const timer = setTimeout(() => {
      pending.reject(new Error('Frontend Tool result timed out'))
      /* v8 ignore next -- a pending Tool Promise keeps its owning Agent turn running until settlement. */
      if (this.liveAgent.status === 'running') {
        this.liveAgent.cancel({ kind: 'hook', reason: 'AG-UI frontend Tool timeout' })
      }
    }, this.options.frontendToolTimeoutMs)
    exec.signal.addEventListener('abort', onAbort, { once: true })
    this.pendingCalls.set(callId, pending)
    active.success()
    return deferred.promise
  }

  private onSessionEvent(event: SessionEvent): void {
    const active = this.activeRun
    if (event.type === 'step/end') {
      this.frontendSteps.delete(`${String(event.data.turn)}:${String(event.data.step)}`)
      if (this.stagedTools !== undefined && active?.turn === event.data.turn) {
        const staged = this.stagedTools
        this.stagedTools = undefined
        try {
          this.applyFrontendTools(staged)
        } catch (error) {
          active.error('FRONTEND_TOOL_SYNC_FAILED', 'The frontend Tool set could not be updated.')
          this.liveAgent.cancel({ kind: 'hook', reason: `AG-UI frontend Tool sync failed: ${errorChain(error)}` })
        }
      }
    }
    if (active === undefined || active.turn === undefined || !eventBelongsToTurn(event, active.turn)) return

    switch (event.type) {
      case 'assistant/chunk': {
        if (event.data.chunk.type !== 'text-delta') break
        const projection = this.textProjection(event.data.turn, event.data.step)
        if (!projection.started) {
          projection.started = true
          active.emit({ type: EventType.TEXT_MESSAGE_START, messageId: projection.messageId, role: 'assistant' })
        }
        active.emit({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: projection.messageId, delta: event.data.chunk.text })
        break
      }
      case 'assistant/message': {
        const projection = this.textProjection(event.data.turn, event.data.step)
        if (!projection.started) {
          const text = event.data.message.content
            .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
            .map(block => block.text)
            .join('')
          if (text !== '') {
            active.emit({ type: EventType.TEXT_MESSAGE_START, messageId: projection.messageId, role: 'assistant' })
            active.emit({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: projection.messageId, delta: text })
            projection.started = true
          }
        }
        if (projection.started) active.emit({ type: EventType.TEXT_MESSAGE_END, messageId: projection.messageId })
        break
      }
      case 'tool/call': {
        const callId = String(event.data.callId)
        this.toolCallLifecycles.set(callId, {
          kind: event.data.name === STATE_TOOL_NAME ? 'state' : 'backend',
          turn: event.data.turn,
          step: event.data.step,
          name: event.data.name,
        })
        if (event.data.name === STATE_TOOL_NAME) break
        active.emit({
          type: EventType.TOOL_CALL_START,
          toolCallId: callId,
          toolCallName: event.data.name,
          parentMessageId: assistantMessageId(this.sessionId, event.data.turn, event.data.step),
        })
        active.emit({ type: EventType.TOOL_CALL_ARGS, toolCallId: callId, delta: event.data.arguments })
        active.emit({ type: EventType.TOOL_CALL_END, toolCallId: callId })
        break
      }
      case 'tool/result': {
        const block = event.data.message.content[0]
        const callId = String(block.toolCallId)
        const lifecycle = this.toolCallLifecycles.get(callId)
        this.toolCallLifecycles.delete(callId)
        if (lifecycle?.kind === 'state') {
          const commit = lifecycle.commit
          if (commit !== undefined && !block.isError && commit.changed) {
            this.sharedState = structuredClone(commit.value)
            active.emit({ type: EventType.STATE_SNAPSHOT, snapshot: structuredClone(commit.value) })
          }
          break
        }
        if (lifecycle?.kind !== 'frontend') {
          this.serverResultCallIds.add(callId)
          active.emit({
            type: EventType.TOOL_CALL_RESULT,
            messageId: `ag-ui:${String(this.sessionId)}:${callId}:result`,
            toolCallId: callId,
            content: renderToolResult(block),
            role: 'tool',
          })
        }
        break
      }
      case 'turn/end': {
        this.clearToolCallsForTurn(event.data.turn)
        switch (event.data.reason.kind) {
          case 'completed':
          case 'max-tokens':
            active.success()
            break
          case 'error':
            active.error(event.data.reason.error.code, event.data.reason.error.message)
            break
          case 'aborted':
            active.error('AGENT_ABORTED', 'The DSH turn was aborted.')
            break
          case 'blocked':
            active.error('AGENT_BLOCKED', 'The DSH turn was blocked before completion.')
            break
          case 'interrupted':
            active.error('AGENT_INTERRUPTED', 'The stored DSH turn was interrupted.')
            break
          default:
            active.error('AGENT_EXECUTION_ERROR', 'The DSH turn ended with an unsupported reason.')
        }
        break
      }
      default:
        break
    }
  }

  private clearToolCallsForTurn(turn: number): void {
    for (const [callId, lifecycle] of this.toolCallLifecycles) {
      if (lifecycle.turn === turn) this.toolCallLifecycles.delete(callId)
    }
  }

  private onAgentError(error: unknown): void {
    const active = this.activeRun
    if (active === undefined || active.record.state !== 'active') return
    active.error('AGENT_EXECUTION_ERROR', errorChain(error))
  }

  private textProjection(turn: number, step: number): TextProjection {
    const key = `${String(turn)}:${String(step)}`
    let projection = this.text.get(key)
    if (projection === undefined) {
      projection = { messageId: assistantMessageId(this.sessionId, turn, step), started: false }
      this.text.set(key, projection)
    }
    return projection
  }

  private checkGlobalCollisions(): void {
    if (this.disposed) return
    if (this.stateToolDispose !== undefined && this.ctx.tools.get(STATE_TOOL_NAME) !== undefined) {
      this.activeRun?.error(
        'SHARED_STATE_TOOL_COLLISION',
        `The reserved shared-state Tool ${STATE_TOOL_NAME} now collides with a global Tool.`,
      )
      if (this.agent?.status === 'running') {
        this.agent.cancel({ kind: 'hook', reason: `AG-UI shared-state Tool ${STATE_TOOL_NAME} collided with a global Tool` })
      }
      return
    }
    for (const name of this.frontendTools.keys()) {
      if (this.ctx.tools.get(name) === undefined) continue
      this.activeRun?.error('FRONTEND_TOOL_NAME_COLLISION', `Frontend Tool ${name} now collides with a global Tool.`)
      if (this.agent?.status === 'running') {
        this.agent.cancel({ kind: 'hook', reason: `AG-UI frontend Tool ${name} collided with a global Tool` })
      }
      return
    }
  }

  private evictCompletedRuns(): void {
    while (this.runLedger.size >= this.options.maxRunsPerThread) {
      const oldest = this.runLedger.entries().next().value
      if (oldest === undefined || oldest[1].state === 'active') return
      this.runLedger.delete(oldest[0])
    }
  }

  private clearIdleExpiry(): void {
    if (this.idleTimer === undefined) return
    clearTimeout(this.idleTimer)
    this.idleTimer = undefined
  }

  private scheduleIdleExpiry(): void {
    this.clearIdleExpiry()
    if (this.disposed || this.pendingCalls.size !== 0 || this.activeRun !== undefined) return
    this.idleTimer = setTimeout(() => { this.onExpired(this) }, this.options.threadIdleMs)
  }
}

/** Ignore default empty client state until a thread has activated shared state. */
function isEmptyStateContainer(value: unknown): boolean {
  if (Array.isArray(value)) return value.length === 0
  return isUnknownRecord(value) && Object.keys(value).length === 0
}

/** Narrow a JSON object without accepting arrays or null. */
function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Read the state-management Tool input after model-boundary validation. */
function readStateUpdates(args: unknown): Record<string, unknown> {
  if (!isUnknownRecord(args) || !isUnknownRecord(args.state_updates)) {
    throw new Error('Shared-state updates must contain a state_updates object')
  }
  return structuredClone(args.state_updates)
}

/** Whether a durable event carries the selected turn. */
function eventBelongsToTurn(event: SessionEvent, turn: number): boolean {
  if (!('turn' in event.data)) return false
  return event.data.turn === turn
}

/** Deterministic AG-UI assistant message identity for one DSH step. */
function assistantMessageId(sessionId: SessionId, turn: number, step: number): string {
  return `ag-ui:${String(sessionId)}:${String(turn)}:${String(step)}:assistant`
}

/** Flatten DSH model-facing Tool content into the AG-UI string result field. */
function renderToolResult(block: ToolResultBlock): string {
  const text: string[] = []
  for (const content of block.content) {
    if (content.type === 'text') text.push(content.text)
    else if (content.type === 'reasoning') text.push(content.text)
    else if (content.type === 'image') text.push('[image result]')
    else if (content.type === 'tool-call') text.push(`[nested tool call: ${content.name}]`)
    else text.push(renderToolResult(content))
  }
  return text.join('\n')
}
