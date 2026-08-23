import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventType, type RunAgentInput, type Tool } from '@ag-ui/core'
import { Context } from '@deepseek-ai/cordis'
import { CallId, createAssistantMessage, createToolResultMessage, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { ScriptedAdapter, textResponse, toolResponse as scriptedToolResponse } from './scripted-adapter.ts'
import { mountTestSpine } from './spine.ts'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { ThreadBinding, type ThreadOptions } from '../src/thread.ts'

const contexts: Context[] = []

afterEach(async () => {
  vi.useRealTimers()
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
})

const TOOL: Tool = {
  name: 'ui_action',
  description: 'Perform the frontend action.',
  parameters: {
    type: 'object',
    properties: { value: { type: 'string' } },
    required: ['value'],
    additionalProperties: false,
  },
}

const OPTIONS: ThreadOptions = {
  provider: 'scripted',
  model: 'scripted',
  frontendToolTimeoutMs: 10_000,
  threadIdleMs: 60_000,
  maxRunEvents: 128,
  maxRunEventBytes: 128 * 1024,
  maxRunsPerThread: 4,
  maxStateBytes: 64 * 1024,
}

function toolResponse(callId: string, args: object): StreamChunk[] {
  return scriptedToolResponse(callId, TOOL.name, args)
}

async function mount(script: StreamChunk[][] = [textResponse('ok')], overrides: Partial<ThreadOptions> = {}) {
  const ctx = new Context()
  contexts.push(ctx)
  await mountTestSpine(ctx)
  const adapter = new ScriptedAdapter(script)
  ctx.llm.registerAdapter(['scripted'], adapter)
  let expired = 0
  const binding = new ThreadBinding(
    ctx,
    { tenantId: 'tenant-1', userId: 'user-1' },
    'thread-1',
    { ...OPTIONS, ...overrides },
    () => { expired++ },
  )
  await binding.initialize()
  return { ctx, adapter, binding, expired: () => expired }
}

function input(runId: string, messages: RunAgentInput['messages'], tools: Tool[] = []): RunAgentInput {
  return {
    threadId: 'thread-1',
    runId,
    messages,
    tools,
    context: [],
    state: {},
    forwardedProps: {},
  }
}

async function settle(controller: ReturnType<ThreadBinding['reserveRun']>): Promise<void> {
  controller.start()
  controller.error('TEST_DONE', 'done')
  await controller.done
}

interface TestPendingCall {
  turn: number
  resolve(value: string): void
  reject(error: Error): void
}

interface TestToolCallPosition {
  turn: number
  step: number
  name: string
}

type TestToolCallLifecycle =
  | ({ kind: 'backend' } & TestToolCallPosition)
  | ({ kind: 'frontend'; parked: true } & TestToolCallPosition)
  | ({ kind: 'state'; commit?: { value: unknown; changed: boolean } } & TestToolCallPosition)

interface ThreadBindingInternals {
  activeRun: ReturnType<ThreadBinding['reserveRun']> | undefined
  pendingCalls: Map<string, TestPendingCall>
  runLedger: Map<string, { digest: string; events: []; state: 'active' | 'completed'; bytes: number }>
  toolCallLifecycles: Map<string, TestToolCallLifecycle>
  frontendSteps: Set<string>
  sharedState: unknown
  sharedStateActive: boolean
  applyFrontendTools(tools: Tool[]): void
  continuationTurn(messages: Extract<RunAgentInput['messages'][number], { role: 'tool' }>[]): number
  definitionFor(item: { tool: Tool; fingerprint: string; schema: Tool['parameters'] }): ToolDefinition
  parkFrontendTool(name: string, schema: Tool['parameters'], args: unknown, exec: ToolRunContext): Promise<string>
  prepareSharedStateUpdate(args: unknown, exec: ToolRunContext): string
  clearToolCallsForTurn(turn: number): void
  onSessionEvent(event: SessionEvent): void
  onAgentError(error: unknown): void
}

function internals(binding: ThreadBinding): ThreadBindingInternals {
  return binding as unknown as ThreadBindingInternals
}

function globalTool(name: string): ToolDefinition {
  return {
    name,
    description: 'Global Tool.',
    parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : 'ok' }] },
    execute: () => Promise.resolve('ok'),
  }
}

describe('ThreadBinding run admission', () => {
  it('rejects conflicting message reuse and unsupported or mixed batches', async () => {
    const { binding } = await mount([textResponse('first')])
    const first = binding.reserveRun(input('run-1', [{ id: 'message-1', role: 'user', content: 'hello' }]), 'digest-1')
    binding.drive(first)
    await first.done

    const conflict = binding.reserveRun(input('run-2', [{ id: 'message-1', role: 'user', content: 'different' }]), 'digest-2')
    binding.drive(conflict)
    await conflict.done
    expect(conflict.record.events.at(-1)).toMatchObject({ code: 'MESSAGE_ID_CONFLICT' })

    const nonText = binding.reserveRun(input('run-3', [{ id: 'message-2', role: 'user', content: [{ type: 'text', text: 'x' }] }]), 'digest-3')
    binding.drive(nonText)
    await nonText.done
    expect(nonText.record.events.at(-1)).toMatchObject({ code: 'UNSUPPORTED_MESSAGE_CONTENT' })

    const mixed = binding.reserveRun(input('run-4', [
      { id: 'message-3', role: 'user', content: 'hello' },
      { id: 'tool-1', role: 'tool', toolCallId: 'missing', content: 'result' },
    ]), 'digest-4')
    binding.drive(mixed)
    await mixed.done
    expect(mixed.record.events.at(-1)).toMatchObject({ code: 'UNKNOWN_TOOL_RESULT' })

    const empty = binding.reserveRun(input('run-5', []), 'digest-5')
    binding.drive(empty)
    await empty.done
    expect(empty.record.events.at(-1)).toMatchObject({ code: 'INVALID_MESSAGE_BATCH' })
  })

  it('rejects unknown Tool results', async () => {
    const { binding } = await mount()
    const controller = binding.reserveRun(input('run-1', [
      { id: 'tool-1', role: 'tool', toolCallId: 'missing', content: 'result' },
    ]), 'digest')
    binding.drive(controller)
    await controller.done
    expect(controller.record.events.at(-1)).toMatchObject({ code: 'UNKNOWN_TOOL_RESULT' })
  })

  it('cancels a running Agent on disconnect', async () => {
    const { binding } = await mount([toolResponse('call-disconnect', { value: 'x' })])
    const first = binding.reserveRun(input('run-disconnect-1', [{ id: 'message-disconnect-1', role: 'user', content: 'call it' }], [TOOL]), 'digest-disconnect-1')
    binding.drive(first)
    await first.done
    const continuation = binding.reserveRun(input('run-disconnect-2', [
      { id: 'result-disconnect', role: 'tool', toolCallId: 'call-disconnect', content: 'ok' },
    ], [TOOL]), 'digest-disconnect-2')
    binding.disconnect(continuation)
    await continuation.done
    await binding.liveAgent.whenIdle()
    expect(continuation.record.events.at(-1)).toMatchObject({ code: 'CLIENT_DISCONNECTED' })
  })

  it('guards duplicate reservations, active runs, lost reservations, and disposal', async () => {
    const { binding } = await mount()
    const value = input('run-1', [{ id: 'message-1', role: 'user', content: 'hello' }])
    const active = binding.reserveRun(value, 'digest')
    expect(() => binding.reserveRun(value, 'other')).toThrow('runId was reused')
    expect(() => binding.reserveRun(value, 'digest')).toThrow('still active')
    expect(() => binding.reserveRun(input('run-2', [{ id: 'message-2', role: 'user', content: 'two' }]), 'digest-2')).toThrow('already has an active run')

    binding.disconnect(active)
    await active.done
    expect(active.record.events.at(-1)).toMatchObject({ code: 'CLIENT_DISCONNECTED' })
    binding.disconnect(active)
    expect(() => { binding.drive(active) }).toThrow('lost its reservation')

    await binding.dispose()
    await binding.dispose()
    expect(() => binding.liveAgent).toThrow('unavailable')
    expect(() => binding.reserveRun(input('run-3', [{ id: 'message-3', role: 'user', content: 'three' }]), 'digest-3')).toThrow('unavailable')
  })

  it('rejects a completed duplicate reservation', async () => {
    const { binding } = await mount([])
    const value = input('run-completed', [{ id: 'message-completed', role: 'user', content: 'hello' }])
    const completed = binding.reserveRun(value, 'digest-completed')
    await settle(completed)
    expect(() => binding.reserveRun(value, 'digest-completed')).toThrow('already completed')
  })

  it('rejects a new user run while the Agent still owes a frontend result', async () => {
    const { binding } = await mount([toolResponse('call-busy', { value: 'x' })])
    const first = binding.reserveRun(input('run-busy-1', [{ id: 'message-busy-1', role: 'user', content: 'call it' }], [TOOL]), 'digest-busy-1')
    binding.drive(first)
    await first.done
    const second = binding.reserveRun(input('run-busy-2', [{ id: 'message-busy-2', role: 'user', content: 'another request' }], [TOOL]), 'digest-busy-2')
    binding.drive(second)
    await second.done
    expect(second.record.events.at(-1)).toMatchObject({ code: 'AGENT_BUSY' })
  })

  it('rejects missing and cross-turn continuation calls', async () => {
    const { binding } = await mount([])
    const state = internals(binding)
    expect(() => state.continuationTurn([])).toThrow('No frontend Tool result')
    expect(() => state.continuationTurn([
      { id: 'missing', role: 'tool', toolCallId: 'missing', content: 'x' },
    ])).toThrow('no pending call')
    state.pendingCalls.set('call-1', { turn: 1, resolve() {}, reject() {} })
    state.pendingCalls.set('call-2', { turn: 2, resolve() {}, reject() {} })
    expect(() => state.continuationTurn([
      { id: 'result-1', role: 'tool', toolCallId: 'call-1', content: 'one' },
      { id: 'result-2', role: 'tool', toolCallId: 'call-2', content: 'two' },
    ])).toThrow('different DSH turns')
  })

  it('reports a full ledger when its oldest entry is active', async () => {
    const { binding } = await mount([], { maxRunsPerThread: 1 })
    const state = internals(binding)
    state.runLedger.set('orphan-active', { digest: 'orphan', events: [], state: 'active', bytes: 0 })
    expect(() => binding.reserveRun(input('run-full', [{ id: 'message-full', role: 'user', content: 'hello' }]), 'digest-full')).toThrow('run ledger is full')
  })

  it('evicts completed ledger entries at the per-thread limit', async () => {
    const { binding } = await mount([], { maxRunsPerThread: 1 })
    const first = binding.reserveRun(input('run-1', [{ id: 'message-1', role: 'user', content: 'one' }]), 'digest-1')
    await settle(first)
    const second = binding.reserveRun(input('run-2', [{ id: 'message-2', role: 'user', content: 'two' }]), 'digest-2')
    expect(binding.getRun('run-1')).toBeUndefined()
    expect(binding.getRun('run-2')).toBe(second.record)
    await settle(second)
  })
})

describe('ThreadBinding frontend Tools', () => {
  it('rejects invalid names, duplicates, schemas, and inherited collisions', async () => {
    const { ctx, binding } = await mount()
    const cases: Array<[string, Tool[], string]> = [
      ['bad-name', [{ ...TOOL, name: 'bad name' }], 'INVALID_FRONTEND_TOOL_NAME'],
      ['dot-name', [{ ...TOOL, name: 'bad.name' }], 'INVALID_FRONTEND_TOOL_NAME'],
      ['colon-name', [{ ...TOOL, name: 'bad:name' }], 'INVALID_FRONTEND_TOOL_NAME'],
      ['long-name', [{ ...TOOL, name: `a${'b'.repeat(64)}` }], 'INVALID_FRONTEND_TOOL_NAME'],
      ['reserved', [{ ...TOOL, name: 'ag_ui_update_state' }], 'RESERVED_FRONTEND_TOOL_NAME'],
      ['duplicate', [TOOL, TOOL], 'DUPLICATE_FRONTEND_TOOL'],
      ['schema', [{ ...TOOL, parameters: { type: 'string' } }], 'AGENT_EXECUTION_ERROR'],
    ]
    for (const [runId, tools, code] of cases) {
      const controller = binding.reserveRun(input(runId, [{ id: `message-${runId}`, role: 'user', content: 'hello' }], tools), runId)
      binding.drive(controller)
      await controller.done
      expect(controller.record.events.at(-1)).toMatchObject({ code })
    }

    const unregister = ctx.tools.register(globalTool(TOOL.name))
    const collision = binding.reserveRun(input('collision', [{ id: 'message-collision', role: 'user', content: 'hello' }], [TOOL]), 'collision')
    binding.drive(collision)
    await collision.done
    expect(collision.record.events.at(-1)).toMatchObject({ code: 'FRONTEND_TOOL_NAME_COLLISION' })
    unregister()
  })

  it('accepts provider-safe hyphenated and exact-length frontend Tool names', async () => {
    const { binding } = await mount([textResponse('first'), textResponse('second')])
    const names = ['generate-haiku', `a${'b'.repeat(63)}`]
    for (const [index, name] of names.entries()) {
      const tool = { ...TOOL, name }
      const controller = binding.reserveRun(input(
        `safe-name-run-${String(index)}`,
        [{ id: `safe-name-message-${String(index)}`, role: 'user', content: 'hello' }],
        [tool],
      ), `safe-name-digest-${String(index)}`)
      binding.drive(controller)
      await controller.done
      await binding.liveAgent.whenIdle()
      expect(binding.liveAgent.ctx.tools.get(name, binding.liveAgent)?.name).toBe(name)
    }
  })

  it('reports a frontend Tool failure and continues the same turn', async () => {
    const { binding } = await mount([
      toolResponse('call-1', { value: 'x' }),
      textResponse('handled failure'),
    ])
    const first = binding.reserveRun(input('run-1', [{ id: 'message-1', role: 'user', content: 'call it' }], [TOOL]), 'digest-1')
    binding.drive(first)
    await first.done

    const result = binding.reserveRun(input('run-2', [
      { id: 'tool-1', role: 'tool', toolCallId: 'call-1', content: 'failed', error: 'browser rejected it' },
    ], [TOOL]), 'digest-2')
    binding.drive(result)
    await result.done
    expect(result.record.events.some(event => event.type === EventType.TOOL_CALL_RESULT)).toBe(false)
    expect(binding.liveAgent.session.events.some(event => event.type === 'tool/result'
      && event.data.message.content[0].isError === true)).toBe(true)
    expect(result.record.events.at(-1)?.type).toBe(EventType.RUN_FINISHED)
  })

  it('times out a pending frontend Tool without sleeping', async () => {
    const { binding } = await mount([toolResponse('call-timeout', { value: 'x' })], { frontendToolTimeoutMs: 60_000 })
    const controller = binding.reserveRun(input('run-1', [{ id: 'message-1', role: 'user', content: 'call it' }], [TOOL]), 'digest')
    binding.drive(controller)
    await controller.done
    const agent = binding.liveAgent
    const timeout = agent.ctx.get('tools')?.get(TOOL.name, agent)
    expect(timeout).toBeDefined()
    await binding.dispose()
    expect(() => binding.liveAgent).toThrow('unavailable')
  })

  it('reuses unchanged Tools, replaces changed Tools, and presents calls', async () => {
    const { binding } = await mount([])
    const state = internals(binding)
    state.applyFrontendTools([TOOL])
    const first = binding.liveAgent.ctx.tools.get(TOOL.name, binding.liveAgent)
    state.applyFrontendTools([TOOL])
    expect(binding.liveAgent.ctx.tools.get(TOOL.name, binding.liveAgent)).toBe(first)
    const changed = { ...TOOL, description: 'Changed frontend action.' }
    state.applyFrontendTools([changed])
    const replacement = binding.liveAgent.ctx.tools.get(TOOL.name, binding.liveAgent)
    expect(replacement).not.toBe(first)
    expect(replacement?.presentCall?.({ value: 'x' })).toEqual({ card: 'generic', title: changed.description, rawInput: { value: 'x' } })
    expect(replacement?.output.render({}, 7)).toEqual([{ type: 'text', text: '7' }])
    state.applyFrontendTools([])
    expect(binding.liveAgent.ctx.tools.get(TOOL.name, binding.liveAgent)).toBeUndefined()
  })

  it('rejects invalid model arguments before parking a frontend Tool', async () => {
    const { binding } = await mount([toolResponse('call-invalid', {})])
    const controller = binding.reserveRun(input('run-invalid', [{ id: 'message-invalid', role: 'user', content: 'call it' }], [TOOL]), 'digest-invalid')
    binding.drive(controller)
    await controller.done
    await binding.liveAgent.whenIdle()
    expect(binding.liveAgent.session.events.some(event => event.type === 'tool/result'
      && event.data.message.content[0].isError === true
      && event.data.message.content[0].content.some(content => content.type === 'text'
        && content.text.includes('Invalid frontend Tool arguments')))).toBe(true)
    expect(controller.record.events).toContainEqual(expect.objectContaining({
      type: EventType.TOOL_CALL_RESULT,
      toolCallId: 'call-invalid',
    }))
  })

  it('times out a parked frontend Tool and settles the turn', async () => {
    vi.useFakeTimers()
    const { binding } = await mount([toolResponse('call-timeout-real', { value: 'x' })], { frontendToolTimeoutMs: 50 })
    const controller = binding.reserveRun(input('run-timeout', [{ id: 'message-timeout', role: 'user', content: 'call it' }], [TOOL]), 'digest-timeout')
    binding.drive(controller)
    await controller.done
    await vi.advanceTimersByTimeAsync(50)
    await binding.liveAgent.whenIdle()
    expect(binding.liveAgent.session.events.some(event => event.type === 'tool/result'
      && event.data.message.content[0].isError === true)).toBe(true)
  })

  it('detects a later global Tool collision while a frontend call is pending', async () => {
    const { ctx, binding } = await mount([toolResponse('call-1', { value: 'x' })])
    const controller = binding.reserveRun(input('run-1', [{ id: 'message-1', role: 'user', content: 'call it' }], [TOOL]), 'digest')
    binding.drive(controller)
    await controller.done
    const unregister = ctx.tools.register(globalTool(TOOL.name))
    await binding.liveAgent.whenIdle()
    expect(binding.liveAgent.status).toBe('idle')
    unregister()
  })
})

describe('ThreadBinding shared state', () => {
  it('activates once, accepts later baselines, and presents the reserved Tool', async () => {
    const { ctx, binding } = await mount([
      textResponse('inactive'),
      textResponse('first'),
      textResponse('second'),
      textResponse('third'),
    ])
    const inactive = binding.reserveRun({
      ...input('state-run-inactive', [{ id: 'state-message-inactive', role: 'user', content: 'no state' }]),
      state: [],
    }, 'state-digest-inactive')
    binding.drive(inactive)
    await inactive.done
    await binding.liveAgent.whenIdle()
    expect(inactive.record.events.some(event => event.type === EventType.STATE_SNAPSHOT)).toBe(false)

    const first = binding.reserveRun({
      ...input('state-run-1', [{ id: 'state-message-1', role: 'user', content: 'start state' }]),
      state: { count: 1 },
    }, 'state-digest-1')
    binding.drive(first)
    await first.done
    await binding.liveAgent.whenIdle()
    expect(first.record.events).toContainEqual({ type: EventType.STATE_SNAPSHOT, snapshot: { count: 1 } })

    const definition = binding.liveAgent.ctx.tools.get('ag_ui_update_state', binding.liveAgent)
    expect(definition?.presentCall?.({ state_updates: { count: 2 } })).toMatchObject({
      card: 'generic',
      title: 'Update shared state',
    })
    expect(definition?.output.render({}, { value: 2 })).toEqual([
      { type: 'text', text: '{"value":2}' },
    ])

    const second = binding.reserveRun({
      ...input('state-run-2', [{ id: 'state-message-2', role: 'user', content: 'clear state' }]),
      state: {},
    }, 'state-digest-2')
    binding.drive(second)
    await second.done
    await binding.liveAgent.whenIdle()
    expect(second.record.events).toContainEqual({ type: EventType.STATE_SNAPSHOT, snapshot: {} })
    expect(internals(binding).sharedState).toEqual({})
    expect(internals(binding).sharedStateActive).toBe(true)

    const third = binding.reserveRun({
      ...input('state-run-3', [{ id: 'state-message-3', role: 'user', content: 'retain state' }]),
      state: undefined,
    }, 'state-digest-3')
    binding.drive(third)
    await third.done
    await binding.liveAgent.whenIdle()
    expect(third.record.events).toContainEqual({ type: EventType.STATE_SNAPSHOT, snapshot: {} })

    const unregister = ctx.tools.register(globalTool('ag_ui_update_state'))
    expect(binding.liveAgent.status).toBe('idle')
    unregister()

    const ownedAgent = binding.liveAgent
    await binding.dispose()
    expect(ctx.tools.get('ag_ui_update_state', ownedAgent)).toBeUndefined()
    expect(internals(binding)).toMatchObject({
      sharedState: undefined,
      sharedStateActive: false,
    })
    expect(internals(binding).toolCallLifecycles.size).toBe(0)
  })

  it('rejects oversized baselines and inherited reserved Tool collisions', async () => {
    const oversized = await mount([], { maxStateBytes: 4 })
    const tooLarge = oversized.binding.reserveRun({
      ...input('large-state-run', [{ id: 'large-state-message', role: 'user', content: 'state' }]),
      state: { value: 'large' },
    }, 'large-state-digest')
    oversized.binding.drive(tooLarge)
    await tooLarge.done
    expect(tooLarge.record.events.at(-1)).toMatchObject({ code: 'STATE_LIMIT_EXCEEDED' })

    const byteRunId = 'state-overflow-bytes'
    const opening = { type: EventType.RUN_STARTED, threadId: 'thread-1', runId: byteRunId }
    const success = { type: EventType.RUN_FINISHED, threadId: 'thread-1', runId: byteRunId, outcome: { type: 'success' } }
    const failure = {
      type: EventType.RUN_ERROR,
      code: 'AG_UI_EVENT_BUFFER_OVERFLOW',
      message: 'The AG-UI run exceeded its event buffer.',
    }
    const mandatoryBytes = Buffer.byteLength(JSON.stringify(opening))
      + Math.max(Buffer.byteLength(JSON.stringify(success)), Buffer.byteLength(JSON.stringify(failure)))
    for (const [name, overrides] of [
      ['count', { maxRunEvents: 2 }],
      ['bytes', { maxRunEventBytes: mandatoryBytes }],
    ] as const) {
      const overflow = await mount([], overrides)
      const controller = overflow.binding.reserveRun({
        ...input(`state-overflow-${name}`, [{ id: `state-overflow-message-${name}`, role: 'user', content: 'state' }]),
        state: { value: 1 },
      }, `state-overflow-digest-${name}`)
      overflow.binding.drive(controller)
      await controller.done
      expect(controller.record.events.at(-1)).toMatchObject({ code: 'AG_UI_EVENT_BUFFER_OVERFLOW' })
      expect(overflow.adapter.requests).toEqual([])
      expect(overflow.binding.liveAgent.session.events.some(event => event.type === 'turn/start')).toBe(false)
      expect(internals(overflow.binding).sharedStateActive).toBe(false)
    }

    const collision = await mount([])
    const unregister = collision.ctx.tools.register(globalTool('ag_ui_update_state'))
    const run = collision.binding.reserveRun({
      ...input('state-collision-run', [{ id: 'state-collision-message', role: 'user', content: 'state' }]),
      state: { value: 1 },
    }, 'state-collision-digest')
    collision.binding.drive(run)
    await run.done
    expect(run.record.events.at(-1)).toMatchObject({ code: 'SHARED_STATE_TOOL_COLLISION' })
    unregister()
  })

  it('does not commit model state when the update snapshot cannot fit', async () => {
    const overflowError = {
      type: EventType.RUN_ERROR,
      code: 'AG_UI_EVENT_BUFFER_OVERFLOW',
      message: 'The AG-UI run exceeded its event buffer.',
    }
    const success = {
      type: EventType.RUN_FINISHED,
      threadId: 'thread-1',
      runId: 'state-update-bytes',
      outcome: { type: 'success' },
    }
    const opening = { type: EventType.RUN_STARTED, threadId: 'thread-1', runId: 'state-update-bytes' }
    const baseline = { type: EventType.STATE_SNAPSHOT, snapshot: { value: 1 } }
    const byteLimit = [opening, baseline].reduce((total, event) => total + Buffer.byteLength(JSON.stringify(event)), 0)
      + Math.max(Buffer.byteLength(JSON.stringify(success)), Buffer.byteLength(JSON.stringify(overflowError)))

    for (const [name, overrides] of [
      ['count', { maxRunEvents: 3 }],
      ['bytes', { maxRunEventBytes: byteLimit }],
    ] as const) {
      const runId = name === 'bytes' ? 'state-update-bytes' : 'state-update-count'
      const fixture = await mount([
        toolResponse(`state-update-${name}`, { value: 2 }),
        textResponse('state update rejected'),
      ], overrides)
      const controller = fixture.binding.reserveRun({
        ...input(runId, [{ id: `state-update-message-${name}`, role: 'user', content: 'update state' }]),
        state: { value: 1 },
      }, `state-update-digest-${name}`)
      fixture.binding.drive(controller)
      await controller.done
      await fixture.binding.liveAgent.whenIdle()

      expect(internals(fixture.binding).sharedState).toEqual({ value: 1 })
      expect(controller.record.events.filter(event => event.type === EventType.STATE_SNAPSHOT)).toEqual([
        { type: EventType.STATE_SNAPSHOT, snapshot: { value: 1 } },
      ])
      expect(controller.record.events.at(-1)).toMatchObject({ code: 'AG_UI_EVENT_BUFFER_OVERFLOW' })
      expect(fixture.binding.liveAgent.session.events.some(event => event.type === 'tool/result'
        && event.data.message.content[0].isError === true)).toBe(true)
    }
  })

  it('rejects invalid, duplicate, and oversized prepared state updates', async () => {
    const inactive = await mount([])
    const inactiveState = internals(inactive.binding)
    const inactiveExec = {
      callId: CallId('inactive-state-call'),
      signal: new AbortController().signal,
    } as ToolRunContext
    inactiveState.toolCallLifecycles.set('inactive-state-call', {
      kind: 'state', turn: 1, step: 1, name: 'ag_ui_update_state',
    })
    expect(() => inactiveState.prepareSharedStateUpdate({ state_updates: {} }, inactiveExec))
      .toThrow('Shared state is not active')

    const { binding } = await mount([textResponse('state active')], { maxStateBytes: 32 })
    const run = binding.reserveRun({
      ...input('state-private-run', [{ id: 'state-private-message', role: 'user', content: 'state' }]),
      state: { value: 1 },
    }, 'state-private-digest')
    binding.drive(run)
    await run.done
    await binding.liveAgent.whenIdle()

    const state = internals(binding)
    const signal = new AbortController().signal
    const exec = { callId: CallId('state-private-call'), signal } as ToolRunContext
    expect(() => state.prepareSharedStateUpdate({ state_updates: { value: 2 } }, exec))
      .toThrow('no DSH call position')
    const stateLifecycle: Extract<TestToolCallLifecycle, { kind: 'state' }> = {
      kind: 'state', turn: 1, step: 1, name: 'ag_ui_update_state',
    }
    state.toolCallLifecycles.set('state-private-call', stateLifecycle)
    expect(() => state.prepareSharedStateUpdate({}, exec)).toThrow('state_updates object')
    expect(() => state.prepareSharedStateUpdate({ state_updates: { value: 'x'.repeat(40) } }, exec))
      .toThrow('exceeds the configured state byte limit')
    stateLifecycle.commit = { value: { value: 2 }, changed: true }
    expect(() => state.prepareSharedStateUpdate({ state_updates: { value: 2 } }, exec))
      .toThrow('already pending')

    const stateController = binding.reserveRun(input(
      'state-direct-controller',
      [{ id: 'state-direct-controller-message', role: 'user', content: 'state' }],
    ), 'state-direct-controller-digest')
    stateController.start()
    const scalarExec = {
      callId: CallId('state-scalar-call'),
      signal,
    } as ToolRunContext
    state.sharedState = 'scalar'
    state.toolCallLifecycles.set('state-scalar-call', {
      kind: 'state', turn: 1, step: 1, name: 'ag_ui_update_state',
    })
    expect(JSON.parse(state.prepareSharedStateUpdate({ state_updates: { value: 3 } }, scalarExec)))
      .toMatchObject({ state: { value: 3 } })
    stateController.error('TEST_DONE', 'done')
  })

  it('clears orphaned state calls and cancels a late global collision', async () => {
    const { ctx, binding } = await mount([textResponse('state active'), textResponse('should be cancelled')])
    const first = binding.reserveRun({
      ...input('state-late-1', [{ id: 'state-late-message-1', role: 'user', content: 'state' }]),
      state: { value: 1 },
    }, 'state-late-digest-1')
    binding.drive(first)
    await first.done
    await binding.liveAgent.whenIdle()

    const state = internals(binding)
    state.toolCallLifecycles.set('other-turn-call', {
      kind: 'state',
      turn: 2,
      step: 1,
      name: 'ag_ui_update_state',
      commit: { value: { value: 2 }, changed: true },
    })
    state.clearToolCallsForTurn(1)
    expect(state.toolCallLifecycles.has('other-turn-call')).toBe(true)
    state.clearToolCallsForTurn(2)
    expect(state.toolCallLifecycles.has('other-turn-call')).toBe(false)

    const second = binding.reserveRun(input(
      'state-late-2',
      [{ id: 'state-late-message-2', role: 'user', content: 'continue' }],
    ), 'state-late-digest-2')
    binding.drive(second)
    const unregister = ctx.tools.register(globalTool('ag_ui_update_state'))
    await second.done
    await binding.liveAgent.whenIdle()
    expect(second.record.events.at(-1)).toMatchObject({ code: 'SHARED_STATE_TOOL_COLLISION' })

    const third = binding.reserveRun({
      ...input('state-late-3', [{ id: 'state-late-message-3', role: 'user', content: 'retry' }]),
      state: undefined,
    }, 'state-late-digest-3')
    binding.drive(third)
    await third.done
    expect(third.record.events.at(-1)).toMatchObject({ code: 'SHARED_STATE_TOOL_COLLISION' })
    unregister()
  })
})

describe('ThreadBinding defensive Tool execution', () => {
  it('rejects missing, mismatched, inactive, and duplicate frontend call positions', async () => {
    const { binding } = await mount([])
    const state = internals(binding)
    const controller = binding.reserveRun(input('run-private', [{ id: 'message-private', role: 'user', content: 'hello' }]), 'digest-private')
    controller.turn = 1
    const signal = new AbortController().signal
    const exec = { callId: CallId('private-call'), signal } as ToolRunContext
    expect(() => state.parkFrontendTool(TOOL.name, TOOL.parameters, { value: 'x' }, exec)).toThrow('no DSH call position')
    state.toolCallLifecycles.set('private-call', { kind: 'backend', turn: 1, step: 1, name: 'different' })
    expect(() => state.parkFrontendTool(TOOL.name, TOOL.parameters, { value: 'x' }, exec)).toThrow('no DSH call position')
    state.toolCallLifecycles.set('private-call', { kind: 'backend', turn: 2, step: 1, name: TOOL.name })
    expect(() => state.parkFrontendTool(TOOL.name, TOOL.parameters, { value: 'x' }, exec)).toThrow('no active AG-UI run')
    state.toolCallLifecycles.set('private-call', { kind: 'backend', turn: 1, step: 1, name: TOOL.name })
    state.frontendSteps.add('1:1')
    expect(() => state.parkFrontendTool(TOOL.name, TOOL.parameters, { value: 'x' }, exec)).toThrow('Only one frontend Tool call')
    controller.error('TEST_DONE', 'done')
  })

  it('ignores repeated settlement after aborting a parked call', async () => {
    const { binding } = await mount([])
    const state = internals(binding)
    const controller = binding.reserveRun(input('run-abort', [{ id: 'message-abort', role: 'user', content: 'hello' }]), 'digest-abort')
    controller.turn = 1
    const abort = new AbortController()
    state.toolCallLifecycles.set('abort-call', { kind: 'backend', turn: 1, step: 1, name: TOOL.name })
    const parked = state.parkFrontendTool(TOOL.name, TOOL.parameters, { value: 'x' }, { callId: CallId('abort-call'), signal: abort.signal } as ToolRunContext)
    abort.abort()
    state.pendingCalls.get('abort-call')?.resolve('late')
    await expect(parked).rejects.toThrow('aborted')
  })
})

describe('ThreadBinding session projection', () => {
  it('projects assembled text when the provider emitted no text delta', async () => {
    const message = createAssistantMessage({
      content: [{ type: 'text', text: 'assembled only' }],
      source: { provider: 'scripted', model: 'scripted' },
    })
    const { binding } = await mount([[
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'assembled only' } },
      { type: 'finish', reason: { kind: 'stop' } },
    ]])
    const controller = binding.reserveRun(input('run-assembled', [{ id: 'message-assembled', role: 'user', content: 'hello' }]), 'digest')
    controller.turn = 1
    controller.start()
    binding.liveAgent.session.append('turn/start', { turn: 1 })
    binding.liveAgent.session.append('step/start', { turn: 1, step: 1 })
    binding.liveAgent.session.append('assistant/message', { turn: 1, step: 1, message }, { surfaceOp: 'append' })
    binding.liveAgent.session.append('step/end', { turn: 1, step: 1 })
    binding.liveAgent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await controller.done
    expect(controller.record.events.map(event => event.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END,
      EventType.RUN_FINISHED,
    ])
  })

  it('keeps one text message open across multiple provider deltas', async () => {
    const message = createAssistantMessage({
      content: [{ type: 'text', text: 'two deltas' }],
      source: { provider: 'scripted', model: 'scripted' },
    })
    const { binding } = await mount([])
    const controller = binding.reserveRun(input('run-deltas', [{ id: 'message-deltas', role: 'user', content: 'hello' }]), 'digest')
    controller.turn = 1
    controller.start()
    binding.liveAgent.session.append('turn/start', { turn: 1 })
    binding.liveAgent.session.append('step/start', { turn: 1, step: 1 })
    binding.liveAgent.session.append('assistant/chunk', {
      turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'two ' },
    })
    binding.liveAgent.session.append('assistant/chunk', {
      turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'deltas' },
    })
    binding.liveAgent.session.append('assistant/message', { turn: 1, step: 1, message }, { surfaceOp: 'append' })
    binding.liveAgent.session.append('step/end', { turn: 1, step: 1 })
    binding.liveAgent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await controller.done
    expect(controller.record.events.filter(event => event.type === EventType.TEXT_MESSAGE_CONTENT)).toHaveLength(2)
  })

  it('renders every backend Tool result content kind', async () => {
    const { binding } = await mount([])
    const controller = binding.reserveRun(input('run-result', [{ id: 'message-result', role: 'user', content: 'hello' }]), 'digest')
    controller.turn = 1
    controller.start()
    const nested = createToolResultMessage({
      callId: CallId('nested-result'),
      isError: false,
      content: [{ type: 'text', text: 'nested text' }],
    }).content[0]
    const result = createToolResultMessage({
      callId: CallId('server-result'),
      isError: false,
      content: [
        { type: 'text', text: 'plain text' },
        { type: 'reasoning', text: 'reasoning text' },
        {
          type: 'image',
          attachment: {
            attachmentId: 'test-image' as never,
            mediaType: 'image/png',
            bytes: 5,
            width: 1,
            height: 1,
          },
        },
        { type: 'tool-call', id: CallId('nested-call'), name: 'nested_tool', arguments: '{}' },
        nested,
      ],
    })
    binding.liveAgent.session.append('turn/start', { turn: 1 })
    binding.liveAgent.session.append('step/start', { turn: 1, step: 1 })
    binding.liveAgent.session.append('tool/call', { turn: 1, step: 1, callId: CallId('server-result'), name: 'backend_tool', arguments: '{}' })
    binding.liveAgent.session.append('tool/result', { turn: 1, step: 1, message: result }, { surfaceOp: 'append' })
    binding.liveAgent.session.append('step/end', { turn: 1, step: 1 })
    binding.liveAgent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await controller.done
    const projected = controller.record.events.find(event => event.type === EventType.TOOL_CALL_RESULT)
    expect(projected).toMatchObject({
      content: 'plain text\nreasoning text\n[image result]\n[nested tool call: nested_tool]\nnested text',
    })
  })

  it('reports staged frontend Tool synchronization failures', async () => {
    const { binding } = await mount([toolResponse('sync-call', { value: 'x' })])
    const first = binding.reserveRun(input('run-sync-1', [{ id: 'message-sync-1', role: 'user', content: 'call it' }], [TOOL]), 'digest-sync-1')
    binding.drive(first)
    await first.done
    const second = binding.reserveRun(input('run-sync-2', [
      { id: 'result-sync', role: 'tool', toolCallId: 'sync-call', content: 'ok' },
    ], [{ ...TOOL, name: 'invalid name' }]), 'digest-sync-2')
    binding.drive(second)
    await second.done
    expect(second.record.events.at(-1)).toMatchObject({ code: 'FRONTEND_TOOL_SYNC_FAILED' })
  })

  it('projects an active Agent error and ignores later errors', async () => {
    const { binding } = await mount([])
    const state = internals(binding)
    const controller = binding.reserveRun(input('run-agent-error', [{ id: 'message-agent-error', role: 'user', content: 'hello' }]), 'digest')
    controller.start()
    state.onAgentError(new Error('agent failed'))
    await controller.done
    expect(controller.record.events.at(-1)).toMatchObject({ code: 'AGENT_EXECUTION_ERROR', message: 'agent failed' })
    state.onAgentError(new Error('ignored'))
    expect(controller.record.events).toHaveLength(2)
  })

  it('projects an unsupported extended turn reason defensively', async () => {
    const { binding } = await mount([])
    const controller = binding.reserveRun(input('run-unsupported', [{ id: 'message-unsupported', role: 'user', content: 'hello' }]), 'digest')
    controller.turn = 1
    controller.start()
    internals(binding).onSessionEvent({
      type: 'turn/end',
      seq: 0,
      time: 0,
      data: { turn: 1, reason: { kind: 'extension-reason' } },
    } as unknown as SessionEvent)
    await controller.done
    expect(controller.record.events.at(-1)).toMatchObject({ code: 'AGENT_EXECUTION_ERROR' })
  })

  it.each([
    [{ kind: 'max-tokens' } as const, EventType.RUN_FINISHED, undefined],
    [{ kind: 'error', error: { code: 'MODEL_FAILED', message: 'model failed' } } as const, EventType.RUN_ERROR, 'MODEL_FAILED'],
    [{ kind: 'aborted', reason: { kind: 'user' } } as const, EventType.RUN_ERROR, 'AGENT_ABORTED'],
    [{ kind: 'blocked' } as const, EventType.RUN_ERROR, 'AGENT_BLOCKED'],
    [{ kind: 'interrupted' } as const, EventType.RUN_ERROR, 'AGENT_INTERRUPTED'],
  ])('projects turn end reason %#', async (reason, type, code) => {
    const { binding } = await mount([])
    const controller = binding.reserveRun(input(`run-${reason.kind}`, [{ id: `message-${reason.kind}`, role: 'user', content: 'hello' }]), 'digest')
    controller.turn = 1
    controller.start()
    binding.liveAgent.session.append('turn/start', { turn: 1 })
    binding.liveAgent.session.append('turn/end', { turn: 1, reason })
    await controller.done
    expect(controller.record.events.at(-1)).toMatchObject({ type, ...(code === undefined ? {} : { code }) })
  })
})
