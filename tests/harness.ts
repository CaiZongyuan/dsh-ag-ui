import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { firstValueFrom, from } from 'rxjs'
import { toArray } from 'rxjs/operators'
import { verifyEvents, type HttpAgent, type Message, type Tool, type ToolCall } from '@ag-ui/client'
import { EventType, type BaseEvent, type CustomEvent } from '@ag-ui/core'
import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { expect } from 'vitest'
import AgUiGateway, { TOOL_VIEW_NAME } from 'dsh-ag-ui'
import { ScriptedAdapter } from './scripted-adapter.ts'
import { mountTestAgentCore } from './agent-core.ts'

/** Shared plumbing for specs that drive a real host through the official client. */

export async function reservePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Port reservation returned no TCP address.')
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) resolve()
      else reject(error)
    })
  })
  return address.port
}

export async function waitForServer(url: string, child: ChildProcessWithoutNullStreams, stderr: string[], label: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`${label} exited ${String(child.exitCode)}: ${stderr.join('')}`)
    try {
      const response = await fetch(url)
      if (response.ok) return
    } catch {
      // Connection refusal means the real WebServer has not bound yet.
    }
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`${label} did not become ready: ${stderr.join('')}`)
}

export async function ask(
  agent: HttpAgent,
  messageId: string,
  runId: string,
  content: string,
  tools: Tool[],
): Promise<BaseEvent[]> {
  agent.addMessage({ id: messageId, role: 'user', content })
  return runAgentEvents(agent, runId, tools)
}

export async function runAgentEvents(agent: HttpAgent, runId: string, tools: Tool[]): Promise<BaseEvent[]> {
  const events: BaseEvent[] = []
  await agent.runAgent({ runId, tools, context: [], forwardedProps: {} }, {
    onEvent: ({ event }) => { events.push(event) },
  })
  return events
}

export function pendingTool(messages: Message[], name: string): ToolCall | undefined {
  const results = new Set(messages
    .filter((message): message is Extract<Message, { role: 'tool' }> => message.role === 'tool')
    .map(message => message.toolCallId))
  return messages.flatMap(message => message.role === 'assistant' ? message.toolCalls ?? [] : [])
    .find(call => call.function.name === name && !results.has(call.id))
}

export function readArgs<T>(call: ToolCall | undefined): T {
  if (call === undefined) throw new Error('The expected frontend Tool call is missing.')
  return JSON.parse(call.function.arguments) as T
}

export function lastAssistantText(messages: Message[]): string | undefined {
  return messages.findLast(message => message.role === 'assistant' && typeof message.content === 'string')?.content as string | undefined
}

const mounted: Context[] = []
const workspaceRoots: string[] = []

/** Dispose every context mounted through this module; call from afterEach. */
export async function disposeMountedContexts(): Promise<void> {
  for (const ctx of mounted.splice(0).reverse()) await ctx.fiber.dispose()
  await Promise.all(workspaceRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
}

/** Standard resource limits shared by the in-process gateway specs. */
const STANDARD_LIMITS = {
  maxRunEvents: 128,
  maxRunEventBytes: 128 * 1024,
  frontendToolTimeoutMs: 10_000,
  threadIdleMs: 60_000,
} as const

export interface MountedGateway {
  readonly ctx: Context
  readonly adapter: ScriptedAdapter
  readonly gateway: ReturnType<Context['plugin']>
  readonly url: string
}

export interface GatewayMountOptions {
  /** Persona forwarded to the test Agent core; omitted uses the helper default. */
  readonly persona?: string
  /** Backend tools registered before the scripted model adapter. */
  readonly tools?: readonly ToolDefinition[]
  /** Resource-limit overrides for specs that record larger event streams. */
  readonly limits?: { maxRunEvents: number, maxRunEventBytes: number }
  /** Optional stable workspace root shared by process-lifetime recovery tests. */
  readonly workspaceRoot?: string
  /** Optional durable JSONL root shared by process-lifetime recovery tests. */
  readonly persistenceRoot?: string
}

/** Mount one loopback WebServer, test Agent core, scripted model, and Gateway. */
export async function mountGateway(
  script: StreamChunk[][],
  secret: string,
  options: GatewayMountOptions = {},
): Promise<MountedGateway> {
  const ctx = new Context()
  mounted.push(ctx)
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  await mountTestAgentCore(ctx, options.persona)
  if (options.persistenceRoot !== undefined) {
    await ctx.plugin(JsonlSessionPersistence, { root: options.persistenceRoot, compression: 'none' })
  }
  for (const tool of options.tools ?? []) ctx.tools.register(tool)
  const adapter = new ScriptedAdapter(script)
  ctx.llm.registerAdapter(['scripted'], adapter)
  const workspaceRoot = options.workspaceRoot ?? await mkdtemp(join(tmpdir(), 'ag-ui-workspaces-'))
  if (options.workspaceRoot === undefined) workspaceRoots.push(workspaceRoot)
  const gateway = await ctx.plugin(AgUiGateway, {
    provider: 'scripted',
    model: 'scripted',
    sharedSecret: secret,
    workspaceRoot,
    ...STANDARD_LIMITS,
    ...options.limits,
  })
  return { ctx, adapter, gateway, url: `http://127.0.0.1:${String(ctx.webServer.port)}/ag-ui` }
}

/** Assert a recorded stream satisfies the official lifecycle validator. */
export async function expectLifecycleValid(events: BaseEvent[]): Promise<void> {
  const replayed = await firstValueFrom(from([...events]).pipe(verifyEvents(), toArray()))
  expect(replayed).toEqual(events)
}

/** Card envelopes of one recorded stream, optionally filtered by phase. */
export function toolViewEnvelopes(events: BaseEvent[], phase?: 'call' | 'result'): CustomEvent[] {
  return events.filter((event): event is CustomEvent =>
    event.type === EventType.CUSTOM && event.name === TOOL_VIEW_NAME
    && (phase === undefined || (event.value as { phase?: string }).phase === phase))
}
