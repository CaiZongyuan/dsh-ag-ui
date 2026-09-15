import { afterEach, describe, expect, it, vi } from 'vitest'
import { getEventListeners } from 'node:events'
import { EventType, type RunAgentInput, type Tool } from '@ag-ui/core'
import { Context } from '@deepseek-ai/cordis'
import { LlmAttemptId, ToolCallId, createUserMessage, createAssistantMessage, createToolResultMessage, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { type ScriptedResponse, ScriptedAdapter, textResponse, toolCallsResponse, toolResponse as scriptedToolResponse } from './scripted-adapter.ts'
import { mountTestAgentCore } from './agent-core.ts'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { ThreadBinding, type ThreadOptions } from '../src/thread.ts'
import { AgUiGatewayError } from '../src/errors.ts'

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

async function mount(script: ScriptedResponse[] = [textResponse('ok')], overrides: Partial<ThreadOptions> = {}) {
  const ctx = new Context()
  contexts.push(ctx)
  await mountTestAgentCore(ctx)
  const adapter = new ScriptedAdapter(script)
  ctx.llm.registerAdapter(['scripted'], adapter)
  let expired = 0
  const binding = new ThreadBinding(
    ctx,
    { tenantId: 'tenant-1', userId: 'user-1' },
    'thread-1',
    SessionId('ag-ui-thread-spec-session'),
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

/** Claim the fixture's native turn through the same event used by the Agent loop. */
function claimTurn(binding: ThreadBinding, controller: ReturnType<ThreadBinding['reserveRun']>, turn: number): void {
  const agent = binding.liveAgent
  const message = createUserMessage({ content: [{ type: 'text', text: 'Fixture input.' }], source: { kind: 'user' } })
  controller.messageId = String(message.id)
  agent.ctx.emit('agent/inbox/claimed', { agent, message, turn })
}

async function settle(controller: ReturnType<ThreadBinding['reserveRun']>): Promise<void> {
  controller.start()
  controller.error('TEST_DONE', 'done')
  await controller.done
}

interface TestPendingCall {
  turn: number
  resolve(value: { content: string, presentationMeta?: unknown }): void
  reject(error: Error): void
}

interface ThreadBindingInternals {
  recover(events: readonly SessionEvent[]): void
  nativeTurn: number | undefined
  activeRun: ReturnType<ThreadBinding['reserveRun']> | undefined
  pendingCalls: Map<string, TestPendingCall>
  runLedger: Map<string, ReturnType<ThreadBinding['reserveRun']>>
  projection: { sharedState: unknown }
  sharedStateActive: boolean
  interrupted: boolean
  applyFrontendTools(tools: Tool[]): void
  continuationTurn(messages: Extract<RunAgentInput['messages'][number], { role: 'tool' }>[]): number
  parkFrontendTool(name: string, schema: Tool['parameters'], args: unknown, exec: ToolRunContext): Promise<unknown>
  prepareSharedStateUpdate(args: unknown, exec: ToolRunContext): string
  onSessionEvent(event: SessionEvent): void
  onAgentError(error: unknown): void
  failRunAdmission(controller: ReturnType<ThreadBinding['reserveRun']>, error: unknown): void
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
  it.each([{ messages: [] }, { messages: [{ id: 'aborted-user', role: 'user' as const, content: 'must not run' }] }])('rejects a request already aborted before admission %#', async ({ messages }) => {
    const { binding, adapter } = await mount()
    const gone = new AbortController()
    gone.abort()
    await expect(binding.admit(input('aborted', messages), 'aborted', gone.signal)).rejects.toMatchObject({ code: 'CLIENT_DISCONNECTED' })
    expect(binding.getRun('aborted')).toBeUndefined()
    expect(adapter.requests).toHaveLength(0)
  })

  it('synchronizes a full accepted transcript while another native turn is running', async () => {
    const gate = Promise.withResolvers<StreamChunk[]>()
    const { binding, adapter, ctx } = await mount([
      scriptedToolResponse('server-call', 'backend', {}), textResponse('done'), gate.promise,
    ])
    ctx.tools.register(globalTool('backend'))
    const first = binding.reserveRun(input('first', [{ id: 'known-user', role: 'user', content: 'call backend' }]), 'first')
    binding.drive(first)
    await first.done
    await binding.liveAgent.whenIdle()
    const snapshot = first.record.events.findLast(event => event.type === EventType.MESSAGES_SNAPSHOT)!
    const messages = snapshot.messages as RunAgentInput['messages']
    expect(messages.some(message => message.role === 'tool')).toBe(true)
    // Rejecting a later message must not consume the earlier server-result echo.
    await expect(binding.admit(input('invalid', [
      ...messages, { id: 'invalid-user', role: 'user', content: [{ type: 'text', text: 'unsupported' }] },
    ]), 'invalid', new AbortController().signal)).rejects.toMatchObject({ code: 'UNSUPPORTED_MESSAGE_CONTENT' })
    const active = binding.reserveRun(input('active', [{ id: 'next-user', role: 'user', content: 'wait' }]), 'active')
    binding.drive(active)
    await vi.waitFor(() => expect(adapter.requests).toHaveLength(3))
    const read = binding.admit(input('read', messages), 'read', new AbortController().signal)
    let admitted = false
    void read.then(() => { admitted = true })
    try {
      await vi.waitFor(() => expect(admitted).toBe(true))
      const controller = await read
      if ('replay' in controller) throw new Error('Expected history admission')
      binding.drive(controller)
      expect(controller.record.events.at(-1)?.type).toBe(EventType.RUN_FINISHED)
      expect(active.record.state).toBe('active')
      expect(binding.liveAgent.status).toBe('running')
    } finally {
      gate.resolve(textResponse('finished'))
      await active.done
    }
  })

  it.each(['before-append', 'after-append', 'after-claim'] as const)('contains partial batch failure %s and retries only unconsumed input', async (failure) => {
    const { binding, adapter } = await mount([textResponse('retry')])
    const agent = binding.liveAgent
    const followup = agent.followup.bind(agent)
    const broken = vi.spyOn(agent, 'followup').mockImplementationOnce(message => {
      if (failure === 'after-append') agent.inbox.append('next-turn', message)
      if (failure === 'after-claim') followup(message)
      throw new Error('admission notification failed')
    })
    const messages: RunAgentInput['messages'] = [
      { id: 'prefix', role: 'user', content: 'first' },
      { id: 'tail', role: 'user', content: 'second' },
    ]
    const failed = binding.reserveRun(input('failed', messages), 'failed')
    binding.drive(failed)
    await failed.done
    await agent.whenIdle()
    expect(failed.record.events.at(-1)).toMatchObject({ type: EventType.RUN_ERROR, code: 'AGENT_EXECUTION_ERROR' })
    expect(agent.inbox.nextStep).toEqual([])
    expect(agent.inbox.nextTurn).toEqual([])
    expect(adapter.requests).toHaveLength(0)
    broken.mockRestore()
    const retry = await binding.admit(input('retry', messages), 'retry', new AbortController().signal)
    if ('replay' in retry) throw new Error('Expected retry admission')
    binding.drive(retry)
    await retry.done
    expect(adapter.requests).toHaveLength(failure === 'after-claim' ? 0 : 1)
    if (failure !== 'after-claim') {
      expect(adapter.requests[0]!.messages.filter(message => message.role === 'user' && message.source.kind === 'user'))
        .toHaveLength(2)
    }
  })

  it('rejects duplicate message and tool-call identities without consuming valid work', async () => {
    const { binding } = await mount([toolResponse('pending', { value: 'x' }), textResponse('done')])
    const user = { id: 'user', role: 'user' as const, content: 'call' }
    await expect(binding.admit(input('duplicate-user', [user, user]), 'duplicate-user', new AbortController().signal))
      .rejects.toMatchObject({ code: 'INVALID_MESSAGE_BATCH' })
    const first = binding.reserveRun(input('first', [user], [TOOL]), 'first')
    binding.drive(first)
    await first.done
    const answer = { id: 'answer', role: 'tool' as const, toolCallId: 'pending', content: 'ok' }
    await expect(binding.admit(input('duplicate-answer', [answer, { ...answer, id: 'other' }]), 'duplicate-answer', new AbortController().signal))
      .rejects.toMatchObject({ code: 'INVALID_TOOL_RESULT_BATCH' })
    const next = binding.reserveRun(input('next', [answer]), 'next')
    binding.drive(next)
    await next.done
    expect(next.record.events.at(-1)).toMatchObject({ type: EventType.RUN_FINISHED })
  })

  it('projects backend results and turn completion after a parked frontend call times out without HTTP', async () => {
    vi.useFakeTimers()
    const gate = Promise.withResolvers<string>()
    const { binding, ctx } = await mount([toolCallsResponse([
      { callId: 'frontend', name: TOOL.name, args: { value: 'x' } },
      { callId: 'backend', name: 'backend', args: {} },
    ]), textResponse('done')], { frontendToolTimeoutMs: 20 })
    ctx.tools.register({ ...globalTool('backend'), isConcurrencySafe: () => true, execute: () => gate.promise })
    const first = binding.reserveRun(input('first', [{ id: 'user', role: 'user', content: 'both' }], [TOOL]), 'first')
    binding.drive(first)
    await first.done
    expect(binding.liveAgent.status).toBe('running')
    gate.resolve('late backend result')
    await vi.advanceTimersByTimeAsync(20)
    await binding.liveAgent.whenIdle()
    await vi.waitFor(() => expect(binding.liveAgent.session.snapshotEvents().some(event => event.type === 'tool/result')).toBe(true))
    const echo = { id: 'echo', role: 'tool' as const, toolCallId: 'backend', content: 'late backend result' }
    const history = await binding.admit(input('history', [echo]), 'history', new AbortController().signal)
    if ('replay' in history) throw new Error('Expected history admission')
    binding.drive(history)
    expect(history.record.events.at(-1)).toMatchObject({ type: EventType.RUN_FINISHED })
    expect(internals(binding).nativeTurn).toBeUndefined()
  })

  it('compares named user history by the same identity before and after recovery', async () => {
    const live = await mount()
    const user = { id: 'named-user', role: 'user' as const, content: 'hello', name: 'Nikolay' }
    const first = live.binding.reserveRun(input('first', [user]), 'first')
    live.binding.drive(first)
    await first.done
    await live.binding.liveAgent.whenIdle()
    const snapshot = first.record.events.findLast(event => event.type === EventType.MESSAGES_SNAPSHOT)!
    const transcript = (snapshot.messages as RunAgentInput['messages']).map(message => message.id === user.id ? user : message)
    const recovered = await mount([])
    internals(recovered.binding).recover(live.binding.liveAgent.session.snapshotEvents())
    for (const { binding } of [live, recovered]) {
      const history = await binding.admit(input('history', transcript), 'history', new AbortController().signal)
      if ('replay' in history) throw new Error('Expected history admission')
      binding.drive(history)
      expect(history.record.events.at(-1)).toMatchObject({ type: EventType.RUN_FINISHED })
      await expect(binding.admit(input('changed', [{ ...user, content: 'different' }]), 'changed', new AbortController().signal))
        .rejects.toMatchObject({ code: 'MESSAGE_ID_CONFLICT' })
    }
    expect(live.adapter.requests).toHaveLength(1)
    expect(recovered.adapter.requests).toHaveLength(0)
  })

  it('retains history runs for identical replay, conflicts, and concurrent duplicate admission', async () => {
    const { binding } = await mount()
    const request = input('history', [])
    const [first, duplicate] = await Promise.all([
      binding.admit(request, 'history', new AbortController().signal),
      binding.admit(request, 'history', new AbortController().signal),
    ])
    if ('replay' in first) throw new Error('Expected history admission')
    expect(duplicate).toEqual({ replay: first.record })
    binding.drive(first)
    const retained = structuredClone(first.record.events)
    expect(() => binding.drive(first)).toThrow('lost its reservation')
    expect(first.record.events).toEqual(retained)
    const work = binding.reserveRun(input('work', [{ id: 'user', role: 'user', content: 'hello' }]), 'work')
    binding.drive(work)
    await work.done
    expect(await binding.admit(request, 'history', new AbortController().signal)).toEqual({ replay: first.record })
    expect(first.record.events).toEqual(retained)
    await expect(binding.admit(request, 'different', new AbortController().signal)).rejects.toMatchObject({ code: 'RUN_ID_CONFLICT' })
  })

  it('reclaims completed history records without evicting active history or work', async () => {
    const { binding } = await mount([], { maxRunsPerThread: 3 })
    const active = binding.reserveRun(input('active', [{ id: 'user', role: 'user', content: 'hello' }]), 'active')
    const first = await binding.admit(input('first-history', []), 'first', new AbortController().signal)
    const second = await binding.admit(input('second-history', []), 'second', new AbortController().signal)
    if ('replay' in first || 'replay' in second) throw new Error('Expected history admission')
    binding.drive(first)
    const third = await binding.admit(input('third-history', []), 'third', new AbortController().signal)
    if ('replay' in third) throw new Error('Expected history admission')
    expect(binding.getRun('first-history')).toBeUndefined()
    expect(binding.getRun('active')).toBe(active.record)
    expect(binding.getRun('second-history')).toBe(second.record)
    await expect(binding.admit(input('full', []), 'full', new AbortController().signal)).rejects.toMatchObject({ code: 'RUN_LEDGER_FULL' })
    expect(active.record.state).toBe('active')
    await binding.dispose()
    await Promise.all([active.done, second.done, third.done])
    expect(second.record.events.at(-1)).toMatchObject({ code: 'AGENT_NOT_AVAILABLE' })
    expect(third.record.events.at(-1)).toMatchObject({ code: 'AGENT_NOT_AVAILABLE' })
  })

  it('settles disconnected history independently and releases unopened run IDs for retry', async () => {
    const { binding } = await mount([toolResponse('pending', { value: 'x' })])
    const work = binding.reserveRun(input('work', [{ id: 'user', role: 'user', content: 'call' }], [TOOL]), 'work')
    binding.drive(work)
    await work.done
    const cancel = vi.spyOn(binding.liveAgent, 'cancel')
    const active = binding.reserveRun(input('continue', [{ id: 'result', role: 'tool', toolCallId: 'pending', content: 'ok' }]), 'continue')
    const request = input('history', [])
    const read = await binding.admit(request, 'history', new AbortController().signal)
    if ('replay' in read) throw new Error('Expected history admission')
    binding.disconnect(read)
    await read.done
    expect(binding.getRun('history')).toBeUndefined()
    const retry = await binding.admit(request, 'history', new AbortController().signal)
    if ('replay' in retry) throw new Error('Expected fresh retry')
    retry.start()
    binding.disconnect(retry)
    await retry.done
    expect(await binding.admit(request, 'history', new AbortController().signal)).toEqual({ replay: retry.record })
    expect(retry.record.events.map(event => event.type)).toEqual([EventType.RUN_STARTED, EventType.RUN_ERROR])
    expect(active.record.state).toBe('active')
    expect(cancel).not.toHaveBeenCalled()
  })

  it('keeps an admitted history run alive until its own settlement', async () => {
    vi.useFakeTimers()
    const { binding, expired } = await mount([], { threadIdleMs: 20 })
    const read = await binding.admit(input('history', []), 'history', new AbortController().signal)
    if ('replay' in read) throw new Error('Expected history admission')
    await vi.advanceTimersByTimeAsync(40)
    expect(expired()).toBe(0)
    binding.drive(read)
    await vi.advanceTimersByTimeAsync(20)
    expect(expired()).toBe(1)
  })

  it('keeps a queued run alive through native cancellation and restores expiry when its client leaves', async () => {
    vi.useFakeTimers()
    const gate = Promise.withResolvers<StreamChunk[]>()
    const { binding, adapter, expired } = await mount([gate.promise], { threadIdleMs: 20 })
    const first = binding.reserveRun(input('first', [{ id: 'first-user', role: 'user', content: 'wait' }]), 'first')
    binding.drive(first)
    await vi.waitFor(() => expect(adapter.requests).toHaveLength(1))
    binding.disconnect(first)
    await first.done
    expect(binding.liveAgent.status).toBe('running')
    const gone = new AbortController()
    const queued = binding.admit(input('queued', [{ id: 'queued-user', role: 'user', content: 'next' }]), 'queued', gone.signal)
    const left = expect(queued).rejects.toMatchObject({ code: 'CLIENT_DISCONNECTED' })
    try {
      await vi.advanceTimersByTimeAsync(40)
      expect(expired()).toBe(0)
      gone.abort()
      await left
      expect(binding.getRun('queued')).toBeUndefined()
      await vi.advanceTimersByTimeAsync(20)
      expect(expired()).toBe(0)
      gate.resolve(textResponse('cancelled'))
      await binding.liveAgent.whenIdle()
      await vi.advanceTimersByTimeAsync(20)
      expect(expired()).toBe(1)
    } finally {
      gone.abort()
      await left
      gate.resolve(textResponse('cancelled'))
      await binding.liveAgent.whenIdle()
    }
  })

  it('does not reserve a queued run aborted in the active-run settlement tick', async () => {
    const { binding, adapter } = await mount()
    const first = binding.reserveRun(input('first', [{ id: 'first-user', role: 'user', content: 'first' }]), 'first')
    const gone = new AbortController()
    const queued = binding.admit(input('queued', [{ id: 'queued-user', role: 'user', content: 'must not run' }]), 'queued', gone.signal)
    first.start()
    first.success()
    gone.abort()
    await expect(queued).rejects.toMatchObject({ code: 'CLIENT_DISCONNECTED' })
    expect(binding.getRun('queued')).toBeUndefined()
    expect(adapter.requests).toHaveLength(0)
    expect(getEventListeners(gone.signal, 'abort')).toHaveLength(0)
  })

  it('releases the queue abort listener after admission', async () => {
    const { binding } = await mount()
    const gone = new AbortController()
    const admitted = await binding.admit(input('admitted', [{ id: 'user', role: 'user', content: 'hello' }]), 'admitted', gone.signal)
    expect(getEventListeners(gone.signal, 'abort')).toHaveLength(0)
    if ('replay' in admitted) throw new Error('Expected a fresh admission')
    await settle(admitted)
  })

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

    const mixed = binding.reserveRun(input('run-3b', [
      { id: 'message-3', role: 'user', content: 'hello' },
      { id: 'tool-1', role: 'tool', toolCallId: 'missing', content: 'result' },
    ]), 'digest-3b')
    binding.drive(mixed)
    await mixed.done
    expect(mixed.record.events.at(-1)).toMatchObject({ code: 'UNKNOWN_TOOL_RESULT' })

    // nothing new only synchronizes the client with the durable history
    const sync = binding.reserveRun(input('run-4', []), 'digest-4')
    binding.drive(sync)
    await sync.done
    expect(sync.record.events.map(event => event.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.MESSAGES_SNAPSHOT,
      EventType.RUN_FINISHED,
    ])

    internals(binding).pendingCalls.set('call-pending', { turn: 1, resolve() {}, reject() {} })
    const pending = binding.reserveRun(input('run-5', [
      { id: 'message-5', role: 'user', content: 'hello' },
      { id: 'tool-5', role: 'tool', toolCallId: 'call-pending', content: 'result' },
    ]), 'digest-5')
    binding.drive(pending)
    await pending.done
    expect(pending.record.events.at(-1)).toMatchObject({ code: 'INVALID_MESSAGE_BATCH' })
  })

  it('admits every new user message of one run into the same turn and echoes them in the snapshot', async () => {
    const { binding, adapter } = await mount([textResponse('both'), textResponse('again')])
    // a run that failed before admission leaves its message in the client, so the next run carries two
    const batch = binding.reserveRun(input('run-batch', [
      { id: 'message-a', role: 'user', content: 'first' },
      { id: 'message-b', role: 'user', content: 'second' },
    ]), 'digest-batch')
    binding.drive(batch)
    await batch.done
    await binding.liveAgent.whenIdle()
    expect(batch.record.events.map(event => event.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.MESSAGES_SNAPSHOT,
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END,
      EventType.MESSAGES_SNAPSHOT,
      EventType.RUN_FINISHED,
    ])
    expect(batch.record.events[1]).toEqual({
      type: EventType.MESSAGES_SNAPSHOT,
      messages: [
        { id: 'message-a', role: 'user', content: 'first' },
        { id: 'message-b', role: 'user', content: 'second' },
      ],
    })
    expect(adapter.requests).toHaveLength(1)
    expect(JSON.stringify(adapter.requests[0]?.messages)).toMatch(/first.*second/)

    const next = binding.reserveRun(input('run-next', [
      { id: 'message-a', role: 'user', content: 'first' },
      { id: 'message-b', role: 'user', content: 'second' },
      { id: 'message-c', role: 'user', content: 'third' },
    ]), 'digest-next')
    binding.drive(next)
    await next.done
    expect(next.record.events[1]).toMatchObject({
      type: EventType.MESSAGES_SNAPSHOT,
      messages: [
        { id: 'message-a', role: 'user' },
        { id: 'message-b', role: 'user' },
        { role: 'assistant', content: 'both' },
        { id: 'message-c', role: 'user', content: 'third' },
      ],
    })
    expect(next.record.events.at(-1)).toMatchObject({ type: EventType.RUN_FINISHED })
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

  it('validates every result metadata value before mutating a continuation batch', async () => {
    const { binding } = await mount([])
    const state = internals(binding)
    const firstResolve = vi.fn()
    const secondResolve = vi.fn()
    state.pendingCalls.set('batch-call-1', { turn: 1, resolve: firstResolve, reject: vi.fn() })
    state.pendingCalls.set('batch-call-2', { turn: 1, resolve: secondResolve, reject: vi.fn() })
    const firstMessage = {
      id: 'batch-result-1',
      role: 'tool' as const,
      toolCallId: 'batch-call-1',
      content: 'first',
      metadata: { valid: true },
    }
    const invalid = binding.reserveRun(input('batch-invalid', [firstMessage, {
      id: 'batch-result-2',
      role: 'tool',
      toolCallId: 'batch-call-2',
      content: 'second',
      metadata: { invalid: undefined },
    }]), 'batch-invalid-digest')

    binding.drive(invalid)
    await invalid.done

    expect(invalid.record.events.at(-1)).toMatchObject({ code: 'INVALID_TOOL_RESULT_METADATA' })
    expect(firstResolve).not.toHaveBeenCalled()
    expect(secondResolve).not.toHaveBeenCalled()

    const corrected = binding.reserveRun(input('batch-corrected', [firstMessage, {
      id: 'batch-result-2',
      role: 'tool',
      toolCallId: 'batch-call-2',
      content: 'second',
      metadata: { valid: true },
    }]), 'batch-corrected-digest')
    binding.drive(corrected)
    await corrected.done

    expect(corrected.record.events.at(-1)).toMatchObject({ type: EventType.RUN_FINISHED })
    expect(firstResolve).toHaveBeenCalledWith({ content: 'first', presentationMeta: { valid: true } })
    expect(secondResolve).toHaveBeenCalledWith({ content: 'second', presentationMeta: { valid: true } })
  })

  it('reports a full ledger when its oldest entry is active', async () => {
    const { binding } = await mount([], { maxRunsPerThread: 1 })
    const read = await binding.admit(input('active-history', []), 'history', new AbortController().signal)
    if ('replay' in read) throw new Error('Expected history admission')
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

  it('persists the client message id as the durable user-message id', async () => {
    const { binding } = await mount([textResponse('ok')])
    const controller = binding.reserveRun(input('run-derived', [{ id: 'message-derived', role: 'user', content: 'hello' }]), 'digest-derived')
    binding.drive(controller)
    await controller.done
    const logged = binding.liveAgent.session.snapshotEvents()
      .find(item => item.type === 'user/message' && item.data.source.kind === 'user')
    expect(logged?.data.id).toBe('ag-ui:user:message-derived')
  })

  it('reports an interrupted thread once, after its history snapshot', async () => {
    const { binding } = await mount([textResponse('after restart')])
    internals(binding).interrupted = true
    const first = binding.reserveRun(input('run-restart-1', [{ id: 'message-restart-1', role: 'user', content: 'hello' }]), 'digest-restart-1')
    binding.drive(first)
    await first.done
    expect(first.record.events.map(item => item.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.MESSAGES_SNAPSHOT,
      EventType.RUN_ERROR,
    ])
    expect(first.record.events.at(-1)).toMatchObject({ code: 'THREAD_INTERRUPTED' })
    expect(internals(binding).interrupted).toBe(false)
    const second = binding.reserveRun(input('run-restart-2', [{ id: 'message-restart-2', role: 'user', content: 'hello again' }]), 'digest-restart-2')
    binding.drive(second)
    await second.done
    expect(second.record.events.at(-1)).toMatchObject({ type: EventType.RUN_FINISHED })
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
    expect(binding.liveAgent.session.snapshotEvents().some(event => event.type === 'tool/result'
      && event.data.message.content[0].isError === true)).toBe(true)
    expect(result.record.events.at(-1)?.type).toBe(EventType.RUN_FINISHED)
  })

  it('persists frontend Tool metadata without changing its model-facing content', async () => {
    const { adapter, binding } = await mount([
      toolResponse('call-metadata', { value: 'x' }),
      textResponse('handled metadata'),
    ])
    const first = binding.reserveRun(input(
      'run-metadata-1',
      [{ id: 'message-metadata', role: 'user', content: 'call it' }],
      [TOOL],
    ), 'digest-metadata-1')
    binding.drive(first)
    await first.done
    const metadata = { a2ui: { ownerToolCallId: 'presentation-owner' } }
    const result = binding.reserveRun(input('run-metadata-2', [{
      id: 'result-metadata',
      role: 'tool',
      toolCallId: 'call-metadata',
      content: 'browser-rendered',
      metadata,
    }], [TOOL]), 'digest-metadata-2')

    binding.drive(result)
    await result.done
    await binding.liveAgent.whenIdle()

    const durable = binding.liveAgent.session.snapshotEvents().find(event => event.type === 'tool/result'
      && String(event.data.message.content[0].toolCallId) === 'call-metadata')
    expect(durable).toMatchObject({ data: { meta: metadata } })
    expect(durable?.data.message.content[0].content).toEqual([{ type: 'text', text: 'browser-rendered' }])
    expect(adapter.requests[1]?.messages.some(message => message.content.some(block =>
      block.type === 'tool-result'
      && String(block.toolCallId) === 'call-metadata'
      && block.content.some(content => content.type === 'text' && content.text === 'browser-rendered')))).toBe(true)
  })

  it('rejects non-lossless frontend Tool metadata before settling the pending call', async () => {
    const { binding } = await mount([toolResponse('call-invalid-metadata', { value: 'x' })])
    const first = binding.reserveRun(input(
      'run-invalid-metadata-1',
      [{ id: 'message-invalid-metadata', role: 'user', content: 'call it' }],
      [TOOL],
    ), 'digest-invalid-metadata-1')
    binding.drive(first)
    await first.done
    const result = binding.reserveRun(input('run-invalid-metadata-2', [{
      id: 'result-invalid-metadata',
      role: 'tool',
      toolCallId: 'call-invalid-metadata',
      content: 'browser-rendered',
      metadata: { invalid: undefined },
    }], [TOOL]), 'digest-invalid-metadata-2')

    binding.drive(result)
    await result.done

    expect(result.record.events.at(-1)).toMatchObject({
      type: EventType.RUN_ERROR,
      code: 'INVALID_TOOL_RESULT_METADATA',
    })
    expect(binding.liveAgent.session.snapshotEvents().some(event => event.type === 'tool/result')).toBe(false)
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
    expect(replacement?.output.render({}, { content: '7' })).toEqual([{ type: 'text', text: '7' }])
    expect(replacement?.output.presentationMeta?.({}, { content: '7' })).toBeNull()
    state.applyFrontendTools([])
    expect(binding.liveAgent.ctx.tools.get(TOOL.name, binding.liveAgent)).toBeUndefined()
  })

  it('rejects invalid model arguments before parking a frontend Tool', async () => {
    const { binding } = await mount([toolResponse('call-invalid', {})])
    const controller = binding.reserveRun(input('run-invalid', [{ id: 'message-invalid', role: 'user', content: 'call it' }], [TOOL]), 'digest-invalid')
    binding.drive(controller)
    await controller.done
    await binding.liveAgent.whenIdle()
    expect(binding.liveAgent.session.snapshotEvents().some(event => event.type === 'tool/result'
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
    expect(binding.liveAgent.session.snapshotEvents().some(event => event.type === 'tool/result'
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
    expect(internals(binding).projection.sharedState).toEqual({})
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
      sharedStateActive: false,
    })
    expect(internals(binding).projection.sharedState).toBeUndefined()
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
      expect(overflow.binding.liveAgent.session.snapshotEvents().some(event => event.type === 'turn/start')).toBe(false)
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
    const messagesSnapshot = {
      type: EventType.MESSAGES_SNAPSHOT,
      messages: [{ id: 'state-update-message-bytes', role: 'user', content: 'update state' }],
    }
    const byteLimit = [opening, messagesSnapshot, baseline].reduce((total, event) => total + Buffer.byteLength(JSON.stringify(event)), 0)
      + Math.max(Buffer.byteLength(JSON.stringify(success)), Buffer.byteLength(JSON.stringify(overflowError)))

    for (const [name, overrides] of [
      ['count', { maxRunEvents: 4 }],
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

      expect(internals(fixture.binding).projection.sharedState).toEqual({ value: 1 })
      expect(controller.record.events.filter(event => event.type === EventType.STATE_SNAPSHOT)).toEqual([
        { type: EventType.STATE_SNAPSHOT, snapshot: { value: 1 } },
      ])
      expect(controller.record.events.at(-1)).toMatchObject({ code: 'AG_UI_EVENT_BUFFER_OVERFLOW' })
      expect(fixture.binding.liveAgent.session.snapshotEvents().some(event => event.type === 'tool/result'
        && event.data.message.content[0].isError === true)).toBe(true)
    }
  })

  it('rejects invalid, duplicate, and oversized prepared state updates', async () => {
    const inactive = await mount([])
    const inactiveExec = {
      callId: ToolCallId('inactive-state-call'),
      signal: new AbortController().signal,
    } as ToolRunContext
    expect(() => internals(inactive.binding).prepareSharedStateUpdate({ state_updates: {} }, inactiveExec))
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
    const exec = { callId: ToolCallId('state-private-call'), signal } as ToolRunContext
    expect(() => state.prepareSharedStateUpdate({ state_updates: { value: 2 } }, exec))
      .toThrow('no DSH call position')

    const controller = binding.reserveRun(input(
      'state-direct-controller',
      [{ id: 'state-direct-controller-message', role: 'user', content: 'state' }],
    ), 'state-direct-controller-digest')
    claimTurn(binding, controller, 2)
    controller.start()
    binding.liveAgent.session.append('turn/start', { turn: 2 })
    binding.liveAgent.session.append('step/start', { turn: 2, step: 1 })
    binding.liveAgent.session.append('tool/call', {
      turn: 2, step: 1, callId: ToolCallId('state-private-call'), name: 'ag_ui_update_state', arguments: '{}',
    })
    claimTurn(binding, controller, 3)
    expect(() => state.prepareSharedStateUpdate({ state_updates: {} }, exec)).toThrow('no DSH call position')
    claimTurn(binding, controller, 2)
    expect(() => state.prepareSharedStateUpdate({}, exec)).toThrow('state_updates object')
    expect(() => state.prepareSharedStateUpdate({ state_updates: { value: 'x'.repeat(40) } }, exec))
      .toThrow('exceeds the configured state byte limit')
    expect(JSON.parse(state.prepareSharedStateUpdate({ state_updates: { value: 2 } }, exec)))
      .toMatchObject({ status: 'updated', state: { value: 2 } })
    expect(() => state.prepareSharedStateUpdate({ state_updates: { value: 2 } }, exec))
      .toThrow('already pending')
    controller.error('TEST_DONE', 'done')
    await controller.done

    const scalarController = binding.reserveRun(input(
      'state-scalar-controller',
      [{ id: 'state-scalar-controller-message', role: 'user', content: 'state' }],
    ), 'state-scalar-controller-digest')
    claimTurn(binding, scalarController, 2)
    scalarController.start()
    binding.liveAgent.session.append('step/end', { turn: 2, step: 1 })
    binding.liveAgent.session.append('step/start', { turn: 2, step: 2 })
    binding.liveAgent.session.append('tool/call', {
      turn: 2, step: 2, callId: ToolCallId('state-scalar-call'), name: 'ag_ui_update_state', arguments: '{}',
    })
    const scalarExec = { callId: ToolCallId('state-scalar-call'), signal } as ToolRunContext
    state.projection.sharedState = 'scalar'
    expect(JSON.parse(state.prepareSharedStateUpdate({ state_updates: { value: 3 } }, scalarExec)))
      .toMatchObject({ state: { value: 3 } })
    scalarController.error('TEST_DONE', 'done')
    // Native execution may continue in the microtask before the completed HTTP reservation releases.
    binding.liveAgent.session.append('tool/call', {
      turn: 2, step: 2, callId: ToolCallId('state-after-http'), name: 'ag_ui_update_state', arguments: '{}',
    })
    const afterHttpExec = { callId: ToolCallId('state-after-http'), signal } as ToolRunContext
    expect(() => state.prepareSharedStateUpdate({ state_updates: { value: 'x'.repeat(40) } }, afterHttpExec))
      .toThrow('exceeds the configured state byte limit')
    expect(JSON.parse(state.prepareSharedStateUpdate({ state_updates: { value: 4 } }, afterHttpExec)))
      .toMatchObject({ status: 'updated', state: { value: 4 } })
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
  it('rejects missing, mismatched, and inactive frontend call positions', async () => {
    const { binding } = await mount([])
    const state = internals(binding)
    const controller = binding.reserveRun(input('run-private', [{ id: 'message-private', role: 'user', content: 'hello' }]), 'digest-private')
    claimTurn(binding, controller, 1)
    controller.start()
    const signal = new AbortController().signal
    const exec = { callId: ToolCallId('private-call'), signal } as ToolRunContext
    expect(() => state.parkFrontendTool(TOOL.name, TOOL.parameters, { value: 'x' }, exec)).toThrow('no DSH call position')
    binding.liveAgent.session.append('turn/start', { turn: 1 })
    binding.liveAgent.session.append('step/start', { turn: 1, step: 1 })
    binding.liveAgent.session.append('tool/call', {
      turn: 1, step: 1, callId: ToolCallId('private-call'), name: 'different_tool', arguments: '{}',
    })
    expect(() => state.parkFrontendTool(TOOL.name, TOOL.parameters, { value: 'x' }, exec)).toThrow('no DSH call position')
    binding.liveAgent.session.append('tool/call', {
      turn: 1, step: 1, callId: ToolCallId('private-call'), name: TOOL.name, arguments: '{}',
    })
    claimTurn(binding, controller, 2)
    expect(() => state.parkFrontendTool(TOOL.name, TOOL.parameters, { value: 'x' }, exec)).toThrow('no DSH call position')
    claimTurn(binding, controller, 1)
    controller.error('TEST_DONE', 'done')
  })

  it('holds the park settle until the last announced call of a step parks', async () => {
    const { binding } = await mount([])
    const state = internals(binding)
    state.applyFrontendTools([TOOL])
    const controller = binding.reserveRun(input('run-multi-park', [{ id: 'message-multi-park', role: 'user', content: 'hello' }]), 'digest-multi-park')
    claimTurn(binding, controller, 1)
    controller.start()
    const session = binding.liveAgent.session
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('assistant/message', {
      stream: [],
      turn: 1,
      step: 1,
      message: createAssistantMessage({
        content: [
          { type: 'tool-call', id: ToolCallId('multi-park-1'), name: TOOL.name, arguments: '{}' },
          { type: 'tool-call', id: ToolCallId('multi-park-2'), name: TOOL.name, arguments: '{}' },
        ],
        source: { provider: 'scripted', model: 'scripted' },
      }),
    }, { surfaceOp: 'append' })
    const signal = new AbortController().signal
    session.append('tool/call', { turn: 1, step: 1, callId: ToolCallId('multi-park-1'), name: TOOL.name, arguments: '{}' })
    void state.parkFrontendTool(TOOL.name, TOOL.parameters, { value: 'x' }, {
      callId: ToolCallId('multi-park-1'), signal,
    } as ToolRunContext).catch(() => {})
    expect(controller.record.state).toBe('active')

    session.append('tool/call', { turn: 1, step: 1, callId: ToolCallId('multi-park-2'), name: TOOL.name, arguments: '{}' })
    void state.parkFrontendTool(TOOL.name, TOOL.parameters, { value: 'x' }, {
      callId: ToolCallId('multi-park-2'), signal,
    } as ToolRunContext).catch(() => {})
    expect(controller.record.state).toBe('completed')
    expect(controller.record.events.at(-1)).toMatchObject({ type: EventType.RUN_FINISHED })
    expect(controller.record.events.filter(event => event.type === EventType.TOOL_CALL_END)).toHaveLength(2)
    controller.error('TEST_DONE', 'done')
  })

  it('ignores repeated settlement after aborting a parked call', async () => {
    const { binding } = await mount([])
    const state = internals(binding)
    const controller = binding.reserveRun(input('run-abort', [{ id: 'message-abort', role: 'user', content: 'hello' }]), 'digest-abort')
    claimTurn(binding, controller, 1)
    controller.start()
    binding.liveAgent.session.append('turn/start', { turn: 1 })
    binding.liveAgent.session.append('step/start', { turn: 1, step: 1 })
    binding.liveAgent.session.append('tool/call', {
      turn: 1, step: 1, callId: ToolCallId('abort-call'), name: TOOL.name, arguments: '{}',
    })
    const abort = new AbortController()
    const parked = state.parkFrontendTool(TOOL.name, TOOL.parameters, { value: 'x' }, { callId: ToolCallId('abort-call'), signal: abort.signal } as ToolRunContext)
    abort.abort()
    state.pendingCalls.get('abort-call')?.resolve({ content: 'late' })
    await expect(parked).rejects.toThrow('aborted')
  })
})

describe('ThreadBinding overflow containment', () => {
  it('cancels the exact native turn before a later backend side effect can run', async () => {
    const fixture = await mount([scriptedToolResponse('danger', 'side_effect', {}), textResponse('must not run')], { maxRunEvents: 4 })
    let effects = 0
    const unregister = fixture.ctx.tools.register({ ...globalTool('side_effect'), execute: () => { effects++; return Promise.resolve('applied') } })
    const cancel = vi.spyOn(fixture.binding.liveAgent, 'cancel')
    const controller = fixture.binding.reserveRun(input('overflow-effect', [{ id: 'overflow-user', role: 'user', content: 'execute' }]), 'overflow-effect-digest')
    fixture.binding.drive(controller)
    await controller.done
    await fixture.binding.liveAgent.whenIdle()
    expect(controller.record.events.at(-1)).toMatchObject({ type: EventType.RUN_ERROR, code: 'AG_UI_EVENT_BUFFER_OVERFLOW' })
    expect(cancel).toHaveBeenCalledOnce()
    expect(effects).toBe(0)
    expect(fixture.adapter.requests).toHaveLength(1)
    unregister()
  })

  it.each([false, true])('cancels an admission failure exactly once, converted to overflow=%s', async converted => {
    const { binding } = await mount([toolResponse('pending-admission', { value: 'x' })])
    const first = binding.reserveRun(input('admission-first', [{ id: 'admission-user', role: 'user', content: 'call' }], [TOOL]), 'admission-first-digest')
    binding.drive(first)
    await first.done
    const cancel = vi.spyOn(binding.liveAgent, 'cancel')
    const controller = binding.reserveRun(input('admission-failure', [{ id: 'admission-result', role: 'tool', toolCallId: 'pending-admission', content: 'ok' }], [TOOL]), 'admission-failure-digest')
    claimTurn(binding, controller, first.turn!)
    controller.start()
    internals(binding).failRunAdmission(controller, new AgUiGatewayError('ADMISSION_FAILED', converted ? 'x'.repeat(OPTIONS.maxRunEventBytes) : 'invalid continuation'))
    await controller.done
    await binding.liveAgent.whenIdle()
    expect(controller.record.events.at(-1)).toMatchObject({ type: EventType.RUN_ERROR, code: converted ? 'AG_UI_EVENT_BUFFER_OVERFLOW' : 'ADMISSION_FAILED' })
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('does not cancel an active turn for a concurrent read overflow or a stale controller', async () => {
    const { binding, adapter } = await mount([toolResponse('pending-overflow', { value: 'x' }), textResponse('continued')])
    const first = binding.reserveRun(input('overflow-first', [{ id: 'overflow-first-user', role: 'user', content: 'call' }], [TOOL]), 'overflow-first-digest')
    binding.drive(first)
    await first.done
    const cancel = vi.spyOn(binding.liveAgent, 'cancel')
    const active = binding.reserveRun(input('overflow-next', [{ id: 'overflow-result', role: 'tool', toolCallId: 'pending-overflow', content: 'ok' }], [TOOL]), 'overflow-next-digest')
    claimTurn(binding, active, first.turn!)
    const read = await binding.admit(input('overflow-read', []), 'overflow-read-digest', new AbortController().signal)
    if ('replay' in read) throw new Error('Expected a history controller')
    read.start()
    read.emit({ type: EventType.MESSAGES_SNAPSHOT, messages: [{ id: 'huge', role: 'assistant', content: 'x'.repeat(OPTIONS.maxRunEventBytes) }] })
    first.error('AG_UI_EVENT_BUFFER_OVERFLOW', 'late overflow')
    internals(binding).failRunAdmission(first, new AgUiGatewayError('STALE_ADMISSION', 'late admission failure'))
    expect(read.record.events.at(-1)).toMatchObject({ code: 'AG_UI_EVENT_BUFFER_OVERFLOW' })
    expect(cancel).not.toHaveBeenCalled()
    binding.drive(active)
    await active.done
    await binding.liveAgent.whenIdle()
    expect(adapter.requests).toHaveLength(2)
    expect(cancel).not.toHaveBeenCalled()
  })
})

describe('ThreadBinding session projection', () => {
  it('reads native append-origin transcript after a valid model-surface replacement', async () => {
    const { binding, ctx, adapter } = await mount([])
    const unregister = ctx.tools.register(globalTool('durable_view'))
    const session = binding.liveAgent.session
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('assistant/message', { turn: 1, step: 1, message: createAssistantMessage({
      content: [{ type: 'text', text: 'Visible original' }, { type: 'tool-call', id: ToolCallId('kept'), name: 'durable_view', arguments: '{}' }], source: { provider: 'scripted', model: 'scripted' },
    }) }, { surfaceOp: 'append' })
    session.append('tool/call', { turn: 1, step: 1, callId: ToolCallId('kept'), name: 'durable_view', arguments: '{}' })
    const result = session.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({ callId: ToolCallId('kept'), isError: false, content: [{ type: 'text', text: 'Visible result' }] }) }, { surfaceOp: 'append' })
    session.append('step/end', { turn: 1, step: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    session.append('tool/result', { ...result.data, message: { ...result.data.message, content: [{ ...result.data.message.content[0], content: [{ type: 'text', text: 'Model-only summary' }] }] } }, { surfaceOp: { op: 'replace', startSeq: result.seq, endSeq: result.seq }, sourceEventSeqs: [result.seq] })
    expect(session.deriveMessages()).toHaveLength(2)
    const read = binding.reserveRun(input('read-replaced', []), 'read-replaced-digest')
    binding.drive(read)
    await read.done
    const snapshot = read.record.events.find(event => event.type === EventType.MESSAGES_SNAPSHOT)
    expect(snapshot).toMatchObject({ messages: [{ role: 'assistant', content: 'Visible original' }, { role: 'tool', content: 'Visible result' }] })
    expect(JSON.stringify(read.record.events)).not.toContain('Model-only summary')
    expect(read.record.events.filter(event => event.type === EventType.CUSTOM && event.name === 'dsh:tool:view')).toHaveLength(1)
    expect(adapter.requests).toHaveLength(0)
    unregister()
  })

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
    claimTurn(binding, controller, 1)
    controller.start()
    binding.liveAgent.session.append('turn/start', { turn: 1 })
    binding.liveAgent.session.append('step/start', { turn: 1, step: 1 })
    binding.liveAgent.session.append('assistant/message', { turn: 1, step: 1, message, stream: [] }, { surfaceOp: 'append' })
    binding.liveAgent.session.append('step/end', { turn: 1, step: 1 })
    binding.liveAgent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await controller.done
    expect(controller.record.events.map(event => event.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END,
      EventType.MESSAGES_SNAPSHOT,
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
    claimTurn(binding, controller, 1)
    controller.start()
    binding.liveAgent.session.append('turn/start', { turn: 1 })
    binding.liveAgent.session.append('step/start', { turn: 1, step: 1 })
    const agent = binding.liveAgent
    agent.ctx.emit('agent/assistant-stream', { agent, frame: {
      type: 'start', attemptId: LlmAttemptId('attempt'), revision: 1, turn: 1, step: 1,
    } })
    for (const [index, text] of ['two ', 'deltas'].entries()) {
      agent.ctx.emit('agent/assistant-stream', { agent, frame: {
        type: 'chunk', attemptId: LlmAttemptId('attempt'), revision: 1, index, time: index,
        chunk: { type: 'text-delta', index: 0, text },
      } })
    }
    // Deltas reach the client before the durable assembled message exists.
    expect(controller.record.events.filter(event => event.type === EventType.TEXT_MESSAGE_CONTENT)).toHaveLength(2)
    expect(agent.session.snapshotEvents().some(event => event.type === 'assistant/message')).toBe(false)
    binding.liveAgent.session.append('assistant/message', { turn: 1, step: 1, message, stream: [] }, { surfaceOp: 'append' })
    binding.liveAgent.session.append('step/end', { turn: 1, step: 1 })
    binding.liveAgent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await controller.done
    expect(controller.record.events.filter(event => event.type === EventType.TEXT_MESSAGE_CONTENT)).toHaveLength(2)
  })

  it('replaces an abandoned retry prefix with durable text before finishing', async () => {
    const { binding } = await mount([])
    const controller = binding.reserveRun(input('retry-prefix', [{ id: 'retry-user', role: 'user', content: 'hello' }]), 'retry-digest')
    claimTurn(binding, controller, 1)
    controller.start()
    const agent = binding.liveAgent
    agent.session.append('turn/start', { turn: 1 })
    agent.session.append('step/start', { turn: 1, step: 1 })
    for (const [attempt, text] of ['abandoned prefix ', 'committed answer'].entries()) {
      const attemptId = LlmAttemptId(`retry-${attempt}`)
      agent.ctx.emit('agent/assistant-stream', { agent, frame: {
        type: 'start', attemptId, revision: 0, turn: 1, step: 1,
      } })
      agent.ctx.emit('agent/assistant-stream', { agent, frame: {
        type: 'chunk', attemptId, revision: 0, index: 0, time: 0,
        chunk: { type: 'text-delta', index: 0, text },
      } })
    }
    agent.session.append('assistant/message', { turn: 1, step: 1, message: createAssistantMessage({
      content: [{ type: 'text', text: 'committed answer' }],
      source: { provider: 'scripted', model: 'scripted' },
    }) }, { surfaceOp: 'append' })
    agent.session.append('step/end', { turn: 1, step: 1 })
    agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await controller.done
    expect(controller.record.events.filter(event => event.type === EventType.TEXT_MESSAGE_CONTENT).map(event => event.delta).join('')).toBe('abandoned prefix committed answer')
    expect(controller.record.events.at(-2)).toMatchObject({ type: EventType.MESSAGES_SNAPSHOT, messages: [{ role: 'assistant', content: 'committed answer' }] })
    expect(controller.record.events.at(-1)).toMatchObject({ type: EventType.RUN_FINISHED })
  })

  it('renders every backend Tool result content kind', async () => {
    const { binding } = await mount([])
    const controller = binding.reserveRun(input('run-result', [{ id: 'message-result', role: 'user', content: 'hello' }]), 'digest')
    claimTurn(binding, controller, 1)
    controller.start()
    const nested = createToolResultMessage({
      callId: ToolCallId('nested-result'),
      isError: false,
      content: [{ type: 'text', text: 'nested text' }],
    }).content[0]
    const result = createToolResultMessage({
      callId: ToolCallId('server-result'),
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
        { type: 'file', attachment: { attachmentId: 'test-file' as never, mediaType: 'application/pdf', bytes: 5, name: 'test.pdf' } },
        { type: 'tool-call', id: ToolCallId('nested-call'), name: 'nested_tool', arguments: '{}' },
        nested,
      ],
    })
    binding.liveAgent.session.append('turn/start', { turn: 1 })
    binding.liveAgent.session.append('step/start', { turn: 1, step: 1 })
    binding.liveAgent.session.append('tool/call', { turn: 1, step: 1, callId: ToolCallId('server-result'), name: 'backend_tool', arguments: '{}' })
    binding.liveAgent.session.append('tool/result', { turn: 1, step: 1, message: result }, { surfaceOp: 'append' })
    binding.liveAgent.session.append('step/end', { turn: 1, step: 1 })
    binding.liveAgent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await controller.done
    const projected = controller.record.events.find(event => event.type === EventType.TOOL_CALL_RESULT)
    expect(projected).toMatchObject({
      content: 'plain text\nreasoning text\n[image result]\n[file result]\n[nested tool call: nested_tool]\nnested text',
    })
  })

  it('rejects invalid staged frontend Tools before consuming a continuation', async () => {
    const { binding } = await mount([toolResponse('sync-call', { value: 'x' })])
    const first = binding.reserveRun(input('run-sync-1', [{ id: 'message-sync-1', role: 'user', content: 'call it' }], [TOOL]), 'digest-sync-1')
    binding.drive(first)
    await first.done
    const second = binding.reserveRun(input('run-sync-2', [
      { id: 'result-sync', role: 'tool', toolCallId: 'sync-call', content: 'ok' },
    ], [{ ...TOOL, name: 'invalid name' }]), 'digest-sync-2')
    binding.drive(second)
    await second.done
    expect(second.record.events.at(-1)).toMatchObject({ code: 'INVALID_FRONTEND_TOOL_NAME' })
    expect(internals(binding).pendingCalls.has('sync-call')).toBe(true)
  })

  it('contains a frontend Tool collision introduced after continuation validation', async () => {
    const { binding, ctx } = await mount([toolResponse('sync-call', { value: 'x' })])
    const first = binding.reserveRun(input('first', [{ id: 'user', role: 'user', content: 'call' }], [TOOL]), 'first')
    binding.drive(first)
    await first.done
    const next = binding.reserveRun(input('next', [
      { id: 'answer', role: 'tool', toolCallId: 'sync-call', content: 'done' },
    ], [{ ...TOOL, name: 'new_frontend' }]), 'next')
    binding.drive(next)
    ctx.tools.register(globalTool('new_frontend'))
    await next.done
    await binding.liveAgent.whenIdle()
    expect(next.record.events.at(-1)).toMatchObject({ code: 'FRONTEND_TOOL_SYNC_FAILED' })
  })

  it('does not attach native events to a reserved continuation before it starts', async () => {
    const { binding } = await mount([toolResponse('pending', { value: 'x' }), textResponse('done')])
    const first = binding.reserveRun(input('first', [{ id: 'user', role: 'user', content: 'call' }], [TOOL]), 'first')
    binding.drive(first)
    await first.done
    const next = binding.reserveRun(input('next', [{ id: 'answer', role: 'tool', toolCallId: 'pending', content: 'ok' }]), 'next')
    const agent = binding.liveAgent
    const turn = first.turn!
    agent.ctx.emit('agent/assistant-stream', { agent, frame: {
      type: 'start', attemptId: LlmAttemptId('late-native-stream'), revision: 1, turn, step: 1,
    } })
    agent.ctx.emit('agent/assistant-stream', { agent, frame: {
      type: 'chunk', attemptId: LlmAttemptId('late-native-stream'), revision: 1, index: 0, time: 0,
      chunk: { type: 'text-delta', index: 0, text: 'late native text' },
    } })
    expect(next.record.events).toEqual([])
    agent.ctx.emit('agent/error', { agent, turn, step: 1, error: new Error('late native error') })
    expect(next.record.events).toEqual([])
    expect(next.record.state).toBe('active')
    binding.drive(next)
    await next.done
    expect(next.record.events[0]).toMatchObject({ type: EventType.RUN_STARTED, runId: 'next' })
    expect(next.record.events.at(-1)).toMatchObject({ type: EventType.RUN_FINISHED })
  })

  it('keeps a reserved response untouched when native timeout exposes a staged Tool collision', async () => {
    vi.useFakeTimers()
    const { binding, ctx } = await mount([toolCallsResponse([
      { callId: 'first-call', name: TOOL.name, args: { value: 'one' } },
      { callId: 'last-call', name: TOOL.name, args: { value: 'two' } },
    ])], { frontendToolTimeoutMs: 20 })
    const first = binding.reserveRun(input('first', [{ id: 'user', role: 'user', content: 'both' }], [TOOL]), 'first')
    binding.drive(first)
    await first.done
    await vi.waitFor(() => expect(internals(binding).pendingCalls.size).toBe(2), { interval: 1 })
    const partial = binding.reserveRun(input('partial', [
      { id: 'first-answer', role: 'tool', toolCallId: 'first-call', content: 'ok' },
    ], [{ ...TOOL, name: 'next_frontend' }]), 'partial')
    binding.drive(partial)
    await partial.done
    const next = binding.reserveRun(input('next', [{ id: 'last-answer', role: 'tool', toolCallId: 'last-call', content: 'ok' }]), 'next')
    ctx.tools.register(globalTool('next_frontend'))
    await vi.advanceTimersByTimeAsync(20)
    await binding.liveAgent.whenIdle()
    expect(next.record.events).toEqual([])
    expect(next.record.state).toBe('active')
    expect(internals(binding).nativeTurn).toBeUndefined()
    binding.drive(next)
    await next.done
    expect(next.record.events[0]).toMatchObject({ type: EventType.RUN_STARTED, runId: 'next' })
  })

  it('ignores native errors before any run has started and reports startup errors before the first claim', async () => {
    const { binding, adapter } = await mount([textResponse('retry accepted')])
    const agent = binding.liveAgent
    const controller = binding.reserveRun(input('new', [{ id: 'user', role: 'user', content: 'start' }]), 'new')
    agent.ctx.emit('agent/error', { agent, turn: 0, step: 0, error: new Error('unowned error') })
    expect(controller.record.events).toEqual([])
    const stop = agent.ctx.on('agent/status', ({ status }) => {
      if (status !== 'running') return
      stop()
      vi.spyOn(agent.session, 'append').mockImplementationOnce(() => { throw new Error('turn/start append failed') })
    })
    binding.drive(controller)
    await vi.waitFor(() => expect(controller.record.state).toBe('completed'))
    await agent.whenIdle()
    expect(controller.turn).toBeUndefined()
    expect(controller.record.events[0]).toMatchObject({ type: EventType.RUN_STARTED })
    expect(controller.record.events.at(-1)).toMatchObject({ code: 'AGENT_EXECUTION_ERROR', message: 'turn/start append failed' })
    expect(agent.inbox.nextStep).toEqual([])
    expect(agent.inbox.nextTurn).toEqual([])
    const retry = await binding.admit(input('retry', controller.input.messages), 'retry', new AbortController().signal)
    if ('replay' in retry) throw new Error('Expected fresh retry')
    binding.drive(retry)
    await retry.done
    expect(adapter.requests).toHaveLength(1)
    expect(retry.record.events.at(-1)).toMatchObject({ type: EventType.RUN_FINISHED })
  })

  it('projects an active Agent error and ignores later errors', async () => {
    const { binding } = await mount([])
    const state = internals(binding)
    const controller = binding.reserveRun(input('run-agent-error', [{ id: 'message-agent-error', role: 'user', content: 'hello' }]), 'digest')
    controller.start()
    claimTurn(binding, controller, 1)
    state.onAgentError(new Error('agent failed'))
    await controller.done
    expect(controller.record.events.at(-1)).toMatchObject({ code: 'AGENT_EXECUTION_ERROR', message: 'agent failed' })
    state.onAgentError(new Error('ignored'))
    expect(controller.record.events).toHaveLength(3)
  })

  it('projects an unsupported extended turn reason defensively', async () => {
    const { binding } = await mount([])
    const controller = binding.reserveRun(input('run-unsupported', [{ id: 'message-unsupported', role: 'user', content: 'hello' }]), 'digest')
    claimTurn(binding, controller, 1)
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
    claimTurn(binding, controller, 1)
    controller.start()
    binding.liveAgent.session.append('turn/start', { turn: 1 })
    binding.liveAgent.session.append('turn/end', { turn: 1, reason })
    await controller.done
    expect(controller.record.events.at(-1)).toMatchObject({ type, ...(code === undefined ? {} : { code }) })
  })
})
