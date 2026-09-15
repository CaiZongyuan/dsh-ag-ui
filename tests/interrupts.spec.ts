import { afterEach, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Approval from '@deepseek-ai/dsh-user-approval'
import * as AskUser from '@deepseek-ai/dsh-tool-ask-user'
import type { ThreadOptions } from '../src/thread.ts'
import Questions from '@deepseek-ai/dsh-user-questions'
import { SessionId } from '@deepseek-ai/dsh-session'
import { EventType, type Interrupt, type RunAgentInput } from '@ag-ui/core'
import { PendingInterrupts } from '../src/interrupts.ts'
import { ThreadBinding } from '../src/thread.ts'
import { mountTestAgentCore } from './agent-core.ts'
import { ScriptedAdapter, textResponse, toolCallsResponse } from './scripted-adapter.ts'

const contexts: Context[] = []
afterEach(async () => { for (const ctx of contexts.splice(0)) await ctx.fiber.dispose() })
const frontend = { name: 'ui_action', description: 'A frontend action.', parameters: { type: 'object', properties: {} } }
function input(runId: string, extra: Partial<RunAgentInput> = {}): RunAgentInput {
  return { threadId: 'human', runId, messages: [], tools: [frontend], context: [], state: {}, forwardedProps: {}, ...extra }
}
async function mount(calls = [{ callId: 'approval-call', name: 'effect', args: {} }, { callId: 'frontend-call', name: frontend.name, args: {} }], options: Partial<ThreadOptions> = {}, policy: 'ask' | 'never' = 'ask') {
  const ctx = new Context()
  contexts.push(ctx)
  await mountTestAgentCore(ctx)
  await ctx.plugin(Approval, { policy })
  await ctx.plugin(Questions)
  await ctx.plugin(AskUser)
  let effects = 0
  ctx.tools.register({ name: 'effect', description: 'A protected effect.', parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
    isConcurrencySafe: () => true, execute: () => { effects++; return Promise.resolve('done') } })
  const unguard = ctx.on('tools/pre-execute', (exec, next) => exec.name === 'effect' ? Promise.resolve({ kind: 'ask', reason: 'Allow the effect?' }) : next())
  const adapter = new ScriptedAdapter([toolCallsResponse(calls), textResponse('finished')])
  ctx.llm.registerAdapter(['scripted'], adapter)
  const binding = new ThreadBinding(ctx, { tenantId: 't', userId: 'u' }, 'human', SessionId('human-session'), {
    provider: 'scripted', model: 'scripted', frontendToolTimeoutMs: 10000, threadIdleMs: 60000,
    maxRunEvents: 128, maxRunEventBytes: 128 * 1024, maxRunsPerThread: 16, maxStateBytes: 65536, ...options,
  }, () => {})
  await binding.initialize()
  return { ctx, binding, adapter, unguard, effects: () => effects }
}
function interrupts(events: { type: string; [key: string]: unknown }[]): Interrupt[] {
  const terminal = events.at(-1)
  expect(terminal).toMatchObject({ type: EventType.RUN_FINISHED, outcome: { type: 'interrupt' } })
  return (terminal!.outcome as { interrupts: Interrupt[] }).interrupts
}
async function run(binding: ThreadBinding, request: RunAgentInput) {
  const controller = await binding.admit(request, JSON.stringify(request), new AbortController().signal)
  if ('replay' in controller) return controller.replay.events
  binding.drive(controller)
  await controller.done
  return controller.record.events
}
it('resumes an approval parked in native scheduler prepare before starting the adjacent parallel frontend tool', async () => {
  const { binding, effects, adapter } = await mount()
  const first = await run(binding, input('first', { messages: [{ id: 'user', role: 'user', content: 'Do it' }] }))
  const [approval] = interrupts(first)
  expect(approval).toMatchObject({ reason: 'approval', toolCallId: 'approval-call' })
  expect(effects()).toBe(0)
  expect(binding.liveAgent.status).toBe('running')
  expect(first.filter(event => event.type === EventType.TOOL_CALL_START)).toHaveLength(1)
  const history = await run(binding, input('history'))
  expect(interrupts(history)).toEqual([approval])
  const second = await run(binding, input('second', { resume: [{ interruptId: approval!.id, status: 'resolved', payload: { approved: true } }] }))
  expect(effects()).toBe(1)
  expect(second.filter(event => event.type === EventType.TOOL_CALL_START).map(event => event.toolCallId)).toEqual(['frontend-call'])
  const third = await run(binding, input('third', { messages: [{ id: 'front-result', role: 'tool', toolCallId: 'frontend-call', content: 'selected' }] }))
  expect(third.at(-1)).toMatchObject({ outcome: { type: 'success' } })
  expect(adapter.requests).toHaveLength(2)
  expect(binding.liveAgent.session.snapshotEvents().filter(event => event.type === 'turn/start')).toHaveLength(1)
  expect(binding.liveAgent.session.snapshotEvents().filter(event => event.type === 'approval/decided').map(event => event.data)).toMatchObject([{ outcome: 'allowed-once' }])
})

const user = { id: 'user', role: 'user' as const, content: 'Do it' }
const effectCall = { callId: 'approval-call', name: 'effect', args: {} }
it.each([
  { status: 'resolved' as const, payload: { approved: false }, outcome: 'rejected' },
  { status: 'cancelled' as const, outcome: 'cancelled' },
])('maps human $outcome to the native approval audit without executing', async ({ status, payload, outcome }) => {
  const { binding, effects } = await mount([effectCall])
  const [approval] = interrupts(await run(binding, input('first', { messages: [user] })))
  await run(binding, input('answer', { resume: [{ interruptId: approval!.id, status, ...(payload === undefined ? {} : { payload }) }] }))
  expect(effects()).toBe(0)
  expect(binding.liveAgent.session.snapshotEvents().filter(event => event.type === 'approval/decided').map(event => event.data)).toMatchObject([{ outcome }])
})
it('keeps the native never policy authoritative', async () => {
  const { binding, effects } = await mount([effectCall], {}, 'never')
  expect((await run(binding, input('first', { messages: [user] }))).at(-1)).toMatchObject({ outcome: { type: 'success' } })
  expect(effects()).toBe(0)
})
it.each([
  { label: 'wrong payload', resume: (id: string) => [{ interruptId: id, status: 'resolved' as const, payload: { approved: 'yes' } }] },
  { label: 'missing answer', resume: () => [{ interruptId: 'unknown', status: 'cancelled' as const }] },
  { label: 'duplicate answer', resume: (id: string) => [0, 1].map(() => ({ interruptId: id, status: 'resolved' as const, payload: { approved: true } })) },
])('rejects $label before SSE without changing the parked native work', async ({ resume }) => {
  const { binding, effects } = await mount([effectCall])
  const [approval] = interrupts(await run(binding, input('first', { messages: [user] })))
  const invalid = input('answer', { resume: resume(approval!.id), context: [{ description: 'must not inject', value: 'bad' }], state: { bad: true } })
  await expect(binding.admit(invalid, JSON.stringify(invalid), new AbortController().signal)).rejects.toBeInstanceOf(Error)
  expect(binding.getRun('answer')).toBeUndefined()
  expect(binding.liveAgent.status).toBe('running')
  expect(effects()).toBe(0)
  expect(interrupts(await run(binding, input('reload')))).toEqual([approval])
  await run(binding, input('answer', { resume: [{ interruptId: approval!.id, status: 'resolved', payload: { approved: true } }, { interruptId: 'unknown', status: 'cancelled' }] }))
  expect(effects()).toBe(1)
})
it('replays exact resumes and serializes two concurrent responses without repeating the effect', async () => {
  const { binding, effects } = await mount([effectCall])
  const [approval] = interrupts(await run(binding, input('first', { messages: [user] })))
  const resume = [{ interruptId: approval!.id, status: 'resolved' as const, payload: { approved: true } }]
  const request = input('answer', { resume })
  const [first] = await Promise.all([run(binding, request), run(binding, input('other-tab', { resume }))])
  expect(await run(binding, request)).toEqual(first)
  expect(effects()).toBe(1)
  expect(() => binding.getRun('answer', 'different')).toThrow('different input')
})
const questionCall = { callId: 'question-call', name: 'ask_user_question', args: { questions: [
  { id: 'choice', question: 'Choose', options: [{ label: 'A' }, { label: 'B' }], multi_select: true },
  { id: 'free', question: 'Explain' },
] } }
it('uses the official question tool and preserves native answer structure', async () => {
  const { binding, adapter } = await mount([questionCall])
  const [question] = interrupts(await run(binding, input('first', { messages: [user] })))
  expect(question).toMatchObject({ reason: 'user_question', metadata: { dsh: { questions: [{ id: 'choice', multiSelect: true }, { id: 'free' }] } } })
  const payload = { answers: [{ id: 'choice', selected: ['A', 'B'], custom: 'C' }, { id: 'free', selected: [], custom: 'reason' }] }
  const result = await run(binding, input('answer', { resume: [{ interruptId: question!.id, status: 'resolved', payload }] }))
  expect(result.find(event => event.type === EventType.TOOL_CALL_RESULT)).toMatchObject({ content: JSON.stringify(payload) })
  expect(adapter.requests).toHaveLength(2)
})
it.each([
  { answers: [] },
  { answers: [{ id: 'choice', selected: ['A'] }, { id: 'choice', selected: ['A'] }] },
  { answers: [{ id: 'choice', selected: ['other'] }, { id: 'free', selected: [], custom: 'ok' }] },
  { answers: [{ id: 'choice', selected: ['A', 'A'] }, { id: 'free', selected: [], custom: 'ok' }] },
  { answers: [{ id: 'choice', selected: [] }, { id: 'free', selected: [], custom: 'ok' }] },
  { answers: [{ id: 'choice', selected: ['A'] }, { id: 'free', selected: [], custom: ' ' }] },
  { answers: [{ id: 'choice', selected: ['A'] }, { id: 'free', selected: ['anything'], custom: 'ok' }] },
])('rejects invalid question semantics %# without consuming any answer', async payload => {
  const { binding } = await mount([questionCall])
  const [question] = interrupts(await run(binding, input('first', { messages: [user] })))
  await expect(run(binding, input('invalid', { resume: [{ interruptId: question!.id, status: 'resolved', payload }] }))).rejects.toMatchObject({ code: 'INVALID_INTERRUPT_RESPONSE' })
  await run(binding, input('cancel', { resume: [{ interruptId: question!.id, status: 'cancelled' }] }))
  await binding.liveAgent.whenIdle()
})
it('allows cancel of an expired question to clear the client gate without executing', async () => {
  const { binding, effects, adapter } = await mount([effectCall], { humanInteractionTimeoutMs: 25 })
  const [approval] = interrupts(await run(binding, input('first', { messages: [user] })))
  await binding.liveAgent.whenIdle()
  await expect(run(binding, input('late', { resume: [{ interruptId: approval!.id, status: 'resolved', payload: { approved: true } }] }))).rejects.toMatchObject({ code: 'INTERRUPT_UNAVAILABLE' })
  expect(interrupts(await run(binding, input('reload')))).toEqual([approval])
  expect((await run(binding, input('cancel', { resume: [{ interruptId: approval!.id, status: 'cancelled' }] }))).at(-1)).toMatchObject({ outcome: { type: 'success' } })
  expect(effects()).toBe(0)
  await run(binding, input('new', { messages: [{ ...user, id: 'new-user' }] }))
  expect(adapter.requests).toHaveLength(2)
})
it('does not let a stale HTTP disconnect cancel the suspended native turn', async () => {
  const { binding, effects } = await mount([effectCall])
  const request = input('first', { messages: [user] })
  const controller = await binding.admit(request, 'first', new AbortController().signal)
  if ('replay' in controller) throw new Error('Unexpected replay')
  binding.drive(controller)
  await controller.done
  binding.disconnect(controller)
  const [approval] = interrupts(controller.record.events)
  await run(binding, input('answer', { resume: [{ interruptId: approval!.id, status: 'resolved', payload: { approved: true } }] }))
  expect(effects()).toBe(1)
})

it('keeps one published cohort through reload while later questions wait for the next resume', async () => {
  const { ctx, binding } = await mount([{ callId: 'many', name: 'many_questions', args: {} }])
  ctx.tools.register({ name: 'many_questions', description: 'Ask concurrently.', parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
    execute: async (_args, exec) => {
      const requests = ['one', 'two'].map(id => ctx.userQuestions.ask({ agent: exec.agent!, signal: exec.signal,
        questions: [{ id, question: id, detail: 'The plan', options: [{ label: 'Approve' }, { label: 'Reject' }], intent: { kind: 'plan-review', approve: 'Approve' } }] }))
      await Promise.all(requests)
      return 'answered'
    } })
  const [one] = interrupts(await run(binding, input('first', { messages: [user] })))
  await new Promise(resolve => setImmediate(resolve))
  expect(interrupts(await run(binding, input('reload')))).toEqual([one])
  expect(one).toMatchObject({ metadata: { dsh: { questions: [{ intent: { kind: 'plan-review' } }] } } })
  const [two] = interrupts(await run(binding, input('answer-one', { resume: [{ interruptId: one!.id, status: 'resolved', payload: { answers: [{ id: 'one', selected: ['Approve'] }] } }] })))
  expect(two!.id).not.toBe(one!.id)
  expect(interrupts(await run(binding, input('reload-two')))).toEqual([two])
  await run(binding, input('answer-two', { resume: [{ interruptId: two!.id, status: 'resolved', payload: { answers: [{ id: 'two', selected: ['Reject'] }] } }] }))
})
it('validates server-result echoes together with the entire human response before consuming either', async () => {
  const { ctx, binding, effects } = await mount([{ callId: 'backend', name: 'backend', args: {} }, effectCall])
  ctx.tools.register({ name: 'backend', description: 'First backend.', parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] }, execute: () => Promise.resolve('recorded') })
  const [approval] = interrupts(await run(binding, input('first', { messages: [user] })))
  const messages = [{ id: 'echo', role: 'tool' as const, toolCallId: 'backend', content: 'recorded' }]
  await expect(run(binding, input('invalid', { messages, resume: [{ interruptId: approval!.id, status: 'resolved', payload: { approved: 42 } }] }))).rejects.toMatchObject({ code: 'INVALID_INTERRUPT_RESPONSE' })
  await run(binding, input('valid', { messages, resume: [{ interruptId: approval!.id, status: 'resolved', payload: { approved: true } }] }))
  expect(effects()).toBe(1)
})
it('can answer frontend and human waits atomically in the same native turn', async () => {
  const { binding, effects } = await mount([{ callId: 'frontend-call', name: frontend.name, args: {} }, effectCall])
  const first = await run(binding, input('first', { messages: [user] }))
  expect(first.at(-1)).toMatchObject({ outcome: { type: 'success' } })
  await new Promise(resolve => setImmediate(resolve))
  const [approval] = interrupts(await run(binding, input('reload')))
  const messages = [{ id: 'frontend-result', role: 'tool' as const, toolCallId: 'frontend-call', content: 'done' }]
  await expect(run(binding, input('missing', { messages }))).rejects.toMatchObject({ code: 'INCOMPLETE_INTERRUPT_RESPONSE' })
  await expect(run(binding, input('mixed', { messages: [{ ...user, id: 'new' }], resume: [{ interruptId: approval!.id, status: 'cancelled' }] }))).rejects.toMatchObject({ code: 'INVALID_MESSAGE_BATCH' })
  const result = await run(binding, input('both', { messages, resume: [{ interruptId: approval!.id, status: 'resolved', payload: { approved: true } }] }))
  expect(result.at(-1)).toMatchObject({ outcome: { type: 'success' } })
  expect(effects()).toBe(1)
})
it('cancels the native owner if the interrupt itself cannot fit in the terminal event budget', async () => {
  const { ctx, binding, effects, unguard } = await mount([effectCall], { maxRunEventBytes: 4096 })
  unguard()
  ctx.on('tools/pre-execute', () => Promise.resolve({ kind: 'ask', reason: 'x'.repeat(10000) }))
  const events = await run(binding, input('first', { messages: [user] }))
  expect(events.at(-1)).toMatchObject({ type: EventType.RUN_ERROR, code: 'AG_UI_EVENT_BUFFER_OVERFLOW' })
  await binding.liveAgent.whenIdle()
  expect(effects()).toBe(0)
})

it('revalidates an admitted answer after native cancellation before drive', async () => {
  const { binding, effects } = await mount([effectCall])
  const [approval] = interrupts(await run(binding, input('first', { messages: [user] })))
  const request = input('answer', { resume: [{ interruptId: approval!.id, status: 'resolved', payload: { approved: true } }] })
  const controller = await binding.admit(request, 'answer', new AbortController().signal)
  if ('replay' in controller) throw new Error('Unexpected replay')
  binding.liveAgent.cancel({ kind: 'hook', reason: 'Native cancellation between admission and drive' })
  await binding.liveAgent.whenIdle()
  binding.drive(controller)
  await controller.done
  expect(controller.record.events.at(-1)).toMatchObject({ code: 'INTERRUPT_UNAVAILABLE' })
  expect(controller.turn).toBeUndefined()
  expect(effects()).toBe(0)
})

it('bounds concurrent native questions and cancels the same owner on overflow', async () => {
  const { ctx, binding, effects } = await mount([{ callId: 'many', name: 'many', args: {} }], { maxPendingInterrupts: 1 })
  ctx.tools.register({ name: 'many', description: 'Concurrent questions.', parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'string' }, render: () => [{ type: 'text', text: 'done' }] },
    execute: async (_args, exec) => {
      await Promise.all(['one', 'two'].map(id => ctx.userQuestions.ask({ agent: exec.agent!, signal: exec.signal, questions: [{ id, question: id }] })))
      return 'done'
    } })
  const [question] = interrupts(await run(binding, input('first', { messages: [user] })))
  await binding.liveAgent.whenIdle()
  await expect(run(binding, input('answer', { resume: [{ interruptId: question!.id, status: 'resolved', payload: { answers: [{ id: 'one', selected: [], custom: 'yes' }] } }] }))).rejects.toMatchObject({ code: 'INTERRUPT_UNAVAILABLE' })
  expect(effects()).toBe(0)
})
it('supports native approval requests without an optional call id, reason or signal', async () => {
  const { ctx, binding } = await mount([{ callId: 'ask', name: 'ask', args: {} }])
  ctx.tools.register({ name: 'ask', description: 'Ask without call metadata.', parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
    execute: (_args, exec) => ctx.approval.request({ agent: exec.agent!, toolName: 'ask' }) })
  const [approval] = interrupts(await run(binding, input('first', { messages: [user], state: { kept: 'baseline' } })))
  expect(approval).not.toHaveProperty('toolCallId')
  expect(approval).not.toHaveProperty('message')
  const history = await run(binding, input('reload', { state: { mustNotReplace: true } }))
  expect(history.find(event => event.type === EventType.STATE_SNAPSHOT)).toMatchObject({ snapshot: { kept: 'baseline' } })
  await run(binding, input('answer', { resume: [{ interruptId: approval!.id, status: 'cancelled' }] }))
})
it('contains late settlement and already-aborted signals at the pending-request boundary', async () => {
  const { binding } = await mount()
  const owner = new PendingInterrupts(10000, 16, () => {}, () => {}, () => {})
  const pending = owner.approval({ agent: binding.liveAgent, toolName: 'effect' }, 1)
  const [approval] = owner.publish()
  const prepared = owner.prepare([{ interruptId: approval!.id, status: 'resolved', payload: { approved: true } }])
  owner.cancel()
  prepared.apply()
  expect(await pending).toBe('cancelled')
  const aborted = AbortSignal.abort()
  expect(await owner.approval({ agent: binding.liveAgent, toolName: 'effect', signal: aborted }, 1)).toBe('cancelled')
  expect(owner.waiting).toBe(false)
})
it.each([
  { messages: [user, user], code: 'INVALID_MESSAGE_BATCH' },
  { messages: [
    { id: 'result-one', role: 'tool' as const, toolCallId: 'frontend-call', content: 'ok' },
    { id: 'result-two', role: 'tool' as const, toolCallId: 'frontend-call', content: 'ok' },
  ], code: 'INVALID_TOOL_RESULT_BATCH' },
])('rejects duplicate work entries atomically: $code', async ({ messages, code }) => {
  const { binding } = await mount([{ callId: 'frontend-call', name: frontend.name, args: {} }])
  await run(binding, input('first', { messages: [user] }))
  await expect(run(binding, input('duplicate', { messages }))).rejects.toMatchObject({ code })
  await run(binding, input('answer', { messages: [{ id: 'correct', role: 'tool', toolCallId: 'frontend-call', content: 'ok' }] }))
})
it('declines questions and approvals outside a gateway-owned native turn', async () => {
  const { ctx, binding } = await mount()
  await expect(ctx.userQuestions.ask({ agent: binding.liveAgent, questions: [{ id: 'idle', question: 'Outside a run?' }] })).rejects.toMatchObject({ code: 'NO_PROVIDER' })
  binding.liveAgent.session.append('turn/start', { turn: 1 })
  expect(await ctx.approval.request({ agent: binding.liveAgent, toolName: 'outside' })).toBe('unavailable')
  binding.liveAgent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
})
it('rejects a new user transcript that exceeds the run event budget before model dispatch', async () => {
  const { binding, adapter } = await mount([effectCall], { maxRunEventBytes: 4096 })
  const events = await run(binding, input('oversized', { messages: [{ ...user, content: 'x'.repeat(10000) }] }))
  expect(events.at(-1)).toMatchObject({ code: 'AG_UI_EVENT_BUFFER_OVERFLOW' })
  expect(adapter.requests).toHaveLength(0)
})
it('contains an inherited tool collision that appears after a continuation was admitted', async () => {
  const { ctx, binding } = await mount([{ callId: 'frontend-call', name: frontend.name, args: {} }])
  await run(binding, input('first', { messages: [user] }))
  ctx.on('tools/result', () => {
    ctx.tools.register({ name: 'new_frontend', description: 'New backend collision.', parameters: { type: 'object', properties: {} },
      output: { schema: { type: 'string' }, render: () => [{ type: 'text', text: 'done' }] }, execute: () => Promise.resolve('done') })
  })
  const events = await run(binding, input('resume', {
    messages: [{ id: 'answer', role: 'tool', toolCallId: 'frontend-call', content: 'ok' }], tools: [{ ...frontend, name: 'new_frontend' }],
  }))
  expect(events.at(-1)).toMatchObject({ code: 'FRONTEND_TOOL_SYNC_FAILED' })
  await binding.liveAgent.whenIdle()
})

it('refuses to drive a detached resume-only controller a second time', async () => {
  const { binding, effects } = await mount([effectCall])
  const [approval] = interrupts(await run(binding, input('first', { messages: [user] })))
  const request = input('answer', { resume: [{ interruptId: approval!.id, status: 'resolved', payload: { approved: true } }] })
  const controller = await binding.admit(request, 'answer', new AbortController().signal)
  if ('replay' in controller) throw new Error('Unexpected replay')
  binding.drive(controller)
  await controller.done
  expect(() => binding.drive(controller)).toThrow('lost its reservation')
  expect(effects()).toBe(1)
})

it.each([false, true])('commits concurrent shared-state work after a human interrupt, with continuation reserved: %s', async (reserveContinuation) => {
  const { ctx, binding } = await mount([
    { callId: 'ask-parallel', name: 'ask_parallel', args: {} },
    { callId: 'state-parallel', name: 'ag_ui_update_state', args: { state_updates: { value: 1 } } },
  ])
  const statePrepared = Promise.withResolvers<void>()
  const releaseState = Promise.withResolvers<void>()
  ctx.on('tools/execute', async (exec, next) => {
    if (exec.name === 'ag_ui_update_state') await releaseState.promise
    try { return await next() } finally { if (exec.name === 'ag_ui_update_state') statePrepared.resolve() }
  })
  ctx.tools.register({ name: 'ask_parallel', description: 'Concurrent human request.', parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
    isConcurrencySafe: () => true,
    execute: async (_args, exec) => {
      await ctx.userQuestions.ask({ agent: exec.agent!, signal: exec.signal, questions: [{ id: 'choice', question: 'Continue?' }] })
      return 'answered'
    } })
  const [question] = interrupts(await run(binding, input('first', { messages: [user], state: { value: 0 } })))
  const request = input('answer', { state: { value: 0 }, resume: [{ interruptId: question!.id, status: 'resolved', payload: { answers: [{ id: 'choice', selected: [], custom: 'yes' }] } }] })
  const reserved = reserveContinuation ? await binding.admit(request, 'answer', new AbortController().signal) : undefined
  releaseState.resolve()
  // A later parallel result is prepared now, but its durable commit waits behind the question.
  await statePrepared.promise
  if (reserved === undefined) await run(binding, request)
  else {
    if ('replay' in reserved) throw new Error('Unexpected replay')
    binding.drive(reserved)
    await reserved.done
  }
  const stateResult = binding.liveAgent.session.snapshotEvents().filter(event => event.type === 'tool/result')
    .find(event => event.data.message.content[0].toolCallId === 'state-parallel')
  expect(stateResult?.data.message.content[0]).toMatchObject({ isError: false, content: [{ type: 'text', text: JSON.stringify({ status: 'updated', state: { value: 1 } }) }] })
  const history = await run(binding, input('history'))
  expect(history.find(event => event.type === EventType.STATE_SNAPSHOT)).toMatchObject({ snapshot: { value: 1 } })
})

it('parks a late frontend call while the human continuation is reserved but not driven', async () => {
  const { ctx, binding } = await mount([
    { callId: 'ask-parallel', name: 'ask_parallel', args: {} },
    { callId: 'frontend-call', name: frontend.name, args: {} },
  ])
  const prepareEntered = Promise.withResolvers<void>()
  const releasePrepare = Promise.withResolvers<void>()
  const frontendStarted = Promise.withResolvers<void>()
  ctx.on('tools/pre-execute', async (exec, next) => {
    if (exec.name === frontend.name) { prepareEntered.resolve(); await releasePrepare.promise }
    return next()
  })
  ctx.on('tools/execute', (exec, next) => {
    const result = next()
    if (exec.name === frontend.name) frontendStarted.resolve()
    return result
  })
  ctx.tools.register({ name: 'ask_parallel', description: 'Concurrent human request.', parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
    isConcurrencySafe: () => true,
    execute: async (_args, exec) => {
      await ctx.userQuestions.ask({ agent: exec.agent!, signal: exec.signal, questions: [{ id: 'choice', question: 'Continue?' }] })
      return 'answered'
    } })
  const [question] = interrupts(await run(binding, input('first', { messages: [user] })))
  await prepareEntered.promise
  const request = input('answer', { resume: [{ interruptId: question!.id, status: 'resolved', payload: { answers: [{ id: 'choice', selected: [], custom: 'yes' }] } }] })
  const controller = await binding.admit(request, 'answer', new AbortController().signal)
  if ('replay' in controller) throw new Error('Unexpected replay')
  expect(controller.turn).toBeUndefined()
  releasePrepare.resolve()
  await frontendStarted.promise
  await new Promise(resolve => setImmediate(resolve))
  binding.drive(controller)
  await controller.done
  await run(binding, input('frontend-answer', { messages: [{ id: 'frontend-result', role: 'tool', toolCallId: 'frontend-call', content: 'chosen' }] }))
  const result = binding.liveAgent.session.snapshotEvents().filter(event => event.type === 'tool/result')
    .find(event => event.data.message.content[0].toolCallId === 'frontend-call')
  expect(result?.data.message.content[0]).toMatchObject({ isError: false, content: [{ type: 'text', text: 'chosen' }] })
})
