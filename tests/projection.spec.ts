import { describe, expect, it } from 'vitest'
import { EventType, type BaseEvent } from '@ag-ui/core'
import { LlmAttemptId, ToolCallId, createAssistantMessage, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, SessionSeq, interruptedTurnClosers, TOOL_NOT_STARTED, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { durableUserId, SessionProjection, STATE_TOOL_NAME, type ToolCallLifecycle } from '../src/projection.ts'
import { TOOL_VIEW_NAME, type ToolPresenter, type ToolViewEnvelope } from '../src/tool-view.ts'

/** Presenter stub: nothing resolves and no client tools, so every card takes the generic fallback. */
const presenter: ToolPresenter = { resolve: () => undefined, isFrontendTool: () => false }

/** The card envelope of one projection step, which always trails its standard events. */
function trailingEnvelope(events: readonly BaseEvent[]): ToolViewEnvelope {
  const last = events.at(-1)
  if (last?.type !== EventType.CUSTOM) throw new Error('expected a trailing tool view card event')
  return last.value as ToolViewEnvelope
}

function backendLifecycle(projection: SessionProjection, callId: string): ToolCallLifecycle & { kind: 'backend' } {
  const lifecycle = projection.lifecycleOf(callId)
  if (lifecycle?.kind !== 'backend') throw new Error(`expected a backend lifecycle for ${callId}`)
  return lifecycle
}

/** Unit tests for the pure session-event → AG-UI wire-event projection. */

const sessionId = SessionId('ag-ui-projection-test')
const messageId = 'ag-ui:ag-ui-projection-test:1:1:assistant'

function event(type: string, data: unknown): SessionEvent {
  return { type, seq: 0, time: 0, data, ...(['system/message', 'user/message', 'assistant/message', 'tool/result'].includes(type) ? { surfaceOp: 'append' } : {}) } as unknown as SessionEvent
}

function textMessage(text: string): SessionEvent {
  return event('assistant/message', {
    turn: 1,
    step: 1,
    message: createAssistantMessage({
      content: [{ type: 'text', text }],
      source: { provider: 'scripted', model: 'scripted' },
    }),
  })
}

function toolCall(callId: string, name: string): SessionEvent {
  return event('tool/call', { turn: 1, step: 1, callId: ToolCallId(callId), name, arguments: '{"x":1}' })
}

/** One assistant message announcing several tool calls in a single step. */
function assistantToolAnnouncement(turn: number, count: number): SessionEvent {
  return event('assistant/message', {
    turn,
    step: 1,
    message: createAssistantMessage({
      content: Array.from({ length: count }, (_, index) => ({
        type: 'tool-call',
        id: ToolCallId(`announced-${String(index)}`),
        name: 'ui_action',
        arguments: '{}',
      })),
      source: { provider: 'scripted', model: 'scripted' },
    }),
  })
}

function toolResult(callId: string, isError = false, meta?: unknown): SessionEvent {
  return event('tool/result', {
    turn: 1,
    step: 1,
    message: createToolResultMessage({
      callId: ToolCallId(callId),
      isError,
      content: [{ type: 'text', text: `result of ${callId}` }],
    }),
    ...(meta === undefined ? {} : { meta }),
  })
}

function userMessage(durableId: string, text: string, kind = 'user'): SessionEvent {
  return event('user/message', {
    id: durableId,
    source: { kind },
    content: [{ type: 'text', text }],
  })
}

describe('SessionProjection text', () => {
  it('opens one message across deltas and closes it at the assembled message', () => {
    const projection = new SessionProjection(sessionId, presenter)
    projection.projectStream({ type: 'start', attemptId: LlmAttemptId('attempt'), revision: 1, turn: 1, step: 1 }, 1)
    const first = projection.projectStream({
      type: 'chunk', attemptId: LlmAttemptId('attempt'), revision: 1, index: 0, time: 0,
      chunk: { type: 'text-delta', index: 0, text: 'hello ' },
    }, 1)
    const second = projection.projectStream({
      type: 'chunk', attemptId: LlmAttemptId('attempt'), revision: 1, index: 1, time: 1,
      chunk: { type: 'text-delta', index: 0, text: 'world' },
    }, 1)
    const closed = projection.project(textMessage('hello world'), 1)

    expect([...first.events, ...second.events, ...closed.events]).toEqual([
      { type: EventType.TEXT_MESSAGE_START, messageId, role: 'assistant' },
      { type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta: 'hello ' },
      { type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta: 'world' },
      { type: EventType.TEXT_MESSAGE_END, messageId },
    ])
    expect(first.outcome).toBeUndefined()
  })

  it('ignores inactive streams and non-text frames, and clears an ended stream', () => {
    const projection = new SessionProjection(sessionId, presenter)
    const attemptId = LlmAttemptId('attempt')
    const chunk = {
      type: 'chunk' as const, attemptId, revision: 1, index: 0, time: 0,
      chunk: { type: 'text-delta' as const, index: 0, text: 'hello' },
    }
    expect(projection.projectStream(chunk, 1).events).toEqual([])
    projection.projectStream({ type: 'start', attemptId, revision: 1, turn: 1, step: 1 }, undefined)
    expect(projection.projectStream(chunk, undefined).events).toEqual([])
    expect(projection.projectStream(chunk, 2).events).toEqual([])
    expect(projection.projectStream({ ...chunk, chunk: { type: 'block-start', index: 0, blockType: 'text' } }, 1).events).toEqual([])
    expect(projection.projectStream({
      type: 'end', attemptId, revision: 1, index: 1, outcome: { kind: 'abandoned' },
    }, 1).events).toEqual([])
    expect(projection.projectStream(chunk, 1).events).toEqual([])
  })

  it('projects an assembled-only message as one start/content/end triple', () => {
    const projection = new SessionProjection(sessionId, presenter)
    const step = projection.project(textMessage('assembled only'), 1)
    expect(step.events).toEqual([
      { type: EventType.TEXT_MESSAGE_START, messageId, role: 'assistant' },
      { type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta: 'assembled only' },
      { type: EventType.TEXT_MESSAGE_END, messageId },
    ])
  })

  it('emits nothing for a text-less step', () => {
    const projection = new SessionProjection(sessionId, presenter)
    const empty = projection.project(textMessage(''), 1)
    expect(empty.events).toEqual([])
  })
})

describe('SessionProjection tool calls', () => {
  it('projects a backend call start/args/end triple, its card, and its durable result', () => {
    const projection = new SessionProjection(sessionId, presenter)
    const call = projection.project(toolCall('call-1', 'backend_tool'), 1)
    expect(call.events.map(item => item.type)).toEqual([
      EventType.TOOL_CALL_START,
      EventType.TOOL_CALL_ARGS,
      EventType.TOOL_CALL_END,
      EventType.CUSTOM,
    ])
    expect(call.events[0]).toMatchObject({
      toolCallId: 'call-1',
      toolCallName: 'backend_tool',
      parentMessageId: messageId,
    })
    expect(call.events[3]).toEqual({
      type: EventType.CUSTOM,
      name: TOOL_VIEW_NAME,
      value: {
        version: 1,
        callId: 'call-1',
        toolName: 'backend_tool',
        phase: 'call',
        card: { card: 'generic', title: 'backend_tool', rawInput: { x: 1 } },
      },
    })

    const result = projection.project(toolResult('call-1'), 1)
    expect(result.events).toEqual([{
      type: EventType.TOOL_CALL_RESULT,
      messageId: 'ag-ui:ag-ui-projection-test:call-1:result',
      toolCallId: 'call-1',
      content: 'result of call-1',
      role: 'tool',
    }, {
      type: EventType.CUSTOM,
      name: TOOL_VIEW_NAME,
      value: {
        version: 1,
        callId: 'call-1',
        toolName: 'backend_tool',
        phase: 'result',
        card: { card: 'generic' },
      },
    }])
    expect(projection.consumeServerResult('call-1')).toBe(true)
    expect(projection.consumeServerResult('call-1')).toBe(false)
  })

  it('records the reserved state call without wire events', () => {
    const projection = new SessionProjection(sessionId, presenter)
    const call = projection.project(toolCall('state-call', STATE_TOOL_NAME), 1)
    expect(call.events).toEqual([])
    expect(projection.lifecycleOf('state-call')).toMatchObject({ kind: 'state', turn: 1, step: 1 })
  })

  it('stays silent for a parked frontend call result but records its id', () => {
    const projection = new SessionProjection(sessionId, presenter)
    projection.project(toolCall('frontend-call', 'ui_action'), 1)
    projection.markParked('frontend-call', backendLifecycle(projection, 'frontend-call'))
    expect(projection.project(toolResult('frontend-call'), 1).events).toEqual([])
    expect(projection.consumeServerResult('frontend-call')).toBe(true)
  })
})

describe('SessionProjection tool view cards', () => {
  /** Minimal definition whose declared intents echo their inputs. */
  const definition = {
    presentCall: (args: unknown) => ({ card: 'generic', title: `probing ${(args as { subject: string }).subject}`, kind: 'search' }),
    presentResult: (args: unknown, result: { meta?: unknown }) => ({
      card: 'generic',
      title: `probed ${(args as { subject: string }).subject}`,
      content: [{ type: 'text', text: `meta ${JSON.stringify(result.meta)}` }],
    }),
  } as unknown as ToolDefinition
  const declaring: ToolPresenter = {
    resolve: name => (name === 'view_tool' ? definition : undefined),
    isFrontendTool: name => name === 'ui_action',
  }

  it('carries the declared call and result intents, including the durable meta', () => {
    const projection = new SessionProjection(sessionId, declaring)
    const call = projection.project(event('tool/call', {
      turn: 1, step: 1, callId: ToolCallId('view-1'), name: 'view_tool', arguments: '{"subject":"files"}',
    }), 1)
    expect(call.events.at(-1)).toMatchObject({
      type: EventType.CUSTOM,
      name: TOOL_VIEW_NAME,
      value: {
        version: 1,
        callId: 'view-1',
        toolName: 'view_tool',
        phase: 'call',
        card: { card: 'generic', title: 'probing files', kind: 'search' },
      },
    })
    const result = projection.project(event('tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({ callId: ToolCallId('view-1'), content: [{ type: 'text', text: 'raw' }] }),
      meta: { kept: true },
    }), 1)
    expect(result.events.at(-1)).toMatchObject({
      type: EventType.CUSTOM,
      name: TOOL_VIEW_NAME,
      value: {
        phase: 'result',
        card: { card: 'generic', title: 'probed files', content: [{ type: 'text', text: 'meta {"kept":true}' }] },
      },
    })
  })

  it('soft-falls throwing or absent intents to the generic card and keeps raw unparseable arguments', () => {
    const throwing: ToolPresenter = {
      resolve: name => (name === 'throwing'
        ? {
          presentCall: () => { throw new Error('boom') },
          presentResult: () => { throw new Error('boom') },
        } as unknown as ToolDefinition
        : name === 'silent'
          ? {} as ToolDefinition
          : undefined),
      isFrontendTool: () => false,
    }
    const projection = new SessionProjection(sessionId, throwing)
    const malformed = projection.project(event('tool/call', {
      turn: 1, step: 1, callId: ToolCallId('bad-args'), name: 'throwing', arguments: '{oops',
    }), 1)
    expect(malformed.events.at(-1)).toMatchObject({
      type: EventType.CUSTOM,
      value: { phase: 'call', card: { card: 'generic', title: 'throwing', rawInput: '{oops' } },
    })
    const silent = projection.project(event('tool/call', {
      turn: 1, step: 1, callId: ToolCallId('silent-1'), name: 'silent', arguments: '{}',
    }), 1)
    expect(trailingEnvelope(silent.events).card).toEqual({ card: 'generic', title: 'silent', rawInput: {} })

    projection.project(toolCall('throw-result', 'throwing'), 1)
    const thrown = projection.project(toolResult('throw-result'), 1)
    expect(trailingEnvelope(thrown.events).card).toEqual({ card: 'generic' })
  })

  it('excludes client-owned frontend calls from cards on the wire', () => {
    const projection = new SessionProjection(sessionId, declaring)
    const call = projection.project(toolCall('frontend-1', 'ui_action'), 1)
    expect(call.events.map(item => item.type)).toEqual([
      EventType.TOOL_CALL_START,
      EventType.TOOL_CALL_ARGS,
      EventType.TOOL_CALL_END,
    ])
  })

  it('emits a bare result when its call position was never projected', () => {
    const projection = new SessionProjection(sessionId, presenter)
    const result = projection.project(toolResult('orphan'), 1)
    expect(result.events.map(item => item.type)).toEqual([EventType.TOOL_CALL_RESULT])
  })

  it('re-derives identical settled cards from a cold log, skipping excluded, unresolvable, and unresulted calls', () => {
    const projection = new SessionProjection(sessionId, declaring)
    const log = [
      event('tool/call', {
        turn: 1, step: 1, callId: ToolCallId('view-1'), name: 'view_tool', arguments: '{"subject":"files"}',
      }),
      event('tool/result', {
        turn: 1,
        step: 1,
        message: createToolResultMessage({ callId: ToolCallId('view-1'), content: [{ type: 'text', text: 'raw' }] }),
        meta: { kept: true },
      }),
      toolCall('state-1', STATE_TOOL_NAME),
      toolResult('state-1'),
      toolCall('client-1', 'ui_action'),
      toolResult('client-1'),
      toolCall('gone-1', 'vanished_tool'),
      toolResult('gone-1'),
      toolCall('unresulted', 'view_tool'),
    ]
    const cold = projection.toolViewEvents(log)
    expect(cold).toEqual([{
      type: EventType.CUSTOM,
      name: TOOL_VIEW_NAME,
      value: {
        version: 1,
        callId: 'view-1',
        toolName: 'view_tool',
        phase: 'result',
        card: { card: 'generic', title: 'probed files', content: [{ type: 'text', text: 'meta {"kept":true}' }] },
      },
    }])
  })

  it('retains original transcript cards and excludes model-only surface replacements', () => {
    const projection = new SessionProjection(sessionId, declaring)
    const original = toolResult('retained')
    const replacement = { ...toolResult('retained'), surfaceOp: { op: 'replace', startSeq: 1, endSeq: 1 } } as SessionEvent
    const log = [toolCall('retained', 'view_tool'), original, replacement]
    expect(projection.toolViewEvents(log)).toEqual(projection.toolViewEvents(log.slice(0, 2)))
    expect(projection.toolViewEvents(log)).toHaveLength(1)
    const transcript = [textMessage('original visible answer'), { ...textMessage('model-only compaction'), surfaceOp: { op: 'replace', startSeq: 0, endSeq: 0 } } as SessionEvent]
    expect(projection.messagesSnapshot(transcript, () => undefined)).toEqual([{ id: messageId, role: 'assistant', content: 'original visible answer' }])
    expect(projection.messagesSnapshot(log, () => undefined)).toHaveLength(1)
  })

  it('skips a durable result whose call event is absent', () => {
    const projection = new SessionProjection(sessionId, declaring)
    expect(projection.toolViewEvents([toolResult('orphan')])).toEqual([])
  })
})

describe('SessionProjection shared state', () => {
  it('commits a changed state update after its durable result', () => {
    const projection = new SessionProjection(sessionId, presenter)
    projection.project(toolCall('state-call', STATE_TOOL_NAME), 1)
    projection.sharedState = { count: 1 }
    projection.stageCommit('state-call', { value: { count: 2 }, changed: true })
    const step = projection.project(toolResult('state-call'), 1)
    expect(step.events).toEqual([{ type: EventType.STATE_SNAPSHOT, snapshot: { count: 2 } }])
    expect(projection.sharedState).toEqual({ count: 2 })
  })

  it('ignores commits staged for missing or non-state calls', () => {
    const projection = new SessionProjection(sessionId, presenter)
    projection.project(toolCall('backend-call', 'backend_tool'), 1)
    projection.stageCommit('backend-call', { value: { count: 9 }, changed: true })
    projection.stageCommit('missing-call', { value: { count: 9 }, changed: true })
    expect(projection.lifecycleOf('backend-call')).toMatchObject({ kind: 'backend' })
    expect(projection.project(toolResult('backend-call'), 1).events).toEqual([
      expect.objectContaining({ type: EventType.TOOL_CALL_RESULT, toolCallId: 'backend-call' }),
      expect.objectContaining({ type: EventType.CUSTOM }),
    ])
  })

  it('skips unchanged and failed state results', () => {    const projection = new SessionProjection(sessionId, presenter)
    projection.sharedState = { count: 1 }
    projection.project(toolCall('state-unchanged', STATE_TOOL_NAME), 1)
    projection.stageCommit('state-unchanged', { value: { count: 1 }, changed: false })
    expect(projection.project(toolResult('state-unchanged'), 1).events).toEqual([])

    projection.project(toolCall('state-failed', STATE_TOOL_NAME), 1)
    projection.stageCommit('state-failed', { value: { count: 3 }, changed: true })
    expect(projection.project(toolResult('state-failed', true), 1).events).toEqual([])
    expect(projection.sharedState).toEqual({ count: 1 })
  })
})

describe('SessionProjection history snapshot', () => {
  it('hides state-tool crash repairs when the announced call never started', () => {
    const prefix = [
      event('turn/start', { turn: 1 }),
      event('step/start', { turn: 1, step: 1 }),
      event('assistant/message', {
        turn: 1,
        step: 1,
        message: createAssistantMessage({
          content: [
            { type: 'tool-call', id: ToolCallId('state'), name: STATE_TOOL_NAME, arguments: '{}' },
            { type: 'tool-call', id: ToolCallId('visible'), name: 'lookup', arguments: '{}' },
          ],
          source: { provider: 'scripted', model: 'scripted' },
        }),
      }),
    ].map((value, index) => ({ ...value, seq: SessionSeq(index) }))
    const repairs = interruptedTurnClosers(prefix)
    expect(repairs.filter(value => value.type === 'tool/result'))
      .toMatchObject([{ data: { error: { code: TOOL_NOT_STARTED } } }, { data: { error: { code: TOOL_NOT_STARTED } } }])

    const projection = new SessionProjection(sessionId, presenter)
    expect(projection.messagesSnapshot([...prefix, ...repairs], () => undefined)).toEqual([
      { id: messageId, role: 'assistant', toolCalls: [
        { id: 'visible', type: 'function', function: { name: 'lookup', arguments: '{}' } },
      ] },
      { id: 'ag-ui:ag-ui-projection-test:visible:result', role: 'tool', toolCallId: 'visible',
        content: expect.any(String), error: expect.any(String) },
    ])
  })

  it.each([false, true])('keeps state-tool protocol traffic out of live and cold transcripts (mixed: %s)', mixed => {
    const announcement = event('assistant/message', {
      turn: 1,
      step: 1,
      message: createAssistantMessage({
        content: [
          { type: 'tool-call', id: ToolCallId('state'), name: STATE_TOOL_NAME, arguments: '{}' },
          ...(mixed ? [
            { type: 'text' as const, text: 'Working.' },
            { type: 'tool-call' as const, id: ToolCallId('visible'), name: 'lookup', arguments: '{}' },
          ] : []),
        ],
        source: { provider: 'scripted', model: 'scripted' },
      }),
    })
    const events = [announcement, toolCall('state', STATE_TOOL_NAME), toolResult('state'),
      ...(mixed ? [toolCall('visible', 'lookup'), toolResult('visible')] : [])]
    const live = new SessionProjection(sessionId, presenter)
    const streamed = events.flatMap(value => live.project(value, 1).events)
    expect(streamed.filter(value => 'toolCallId' in value).map(value => value.toolCallId))
      .toEqual(mixed ? ['visible', 'visible', 'visible', 'visible'] : [])

    const cold = new SessionProjection(sessionId, presenter)
    const messages = cold.messagesSnapshot(events, () => undefined)
    expect(messages).toEqual(mixed ? [
      { id: messageId, role: 'assistant', content: 'Working.', toolCalls: [
        { id: 'visible', type: 'function', function: { name: 'lookup', arguments: '{}' } },
      ] },
      { id: 'ag-ui:ag-ui-projection-test:visible:result', role: 'tool', toolCallId: 'visible', content: 'result of visible' },
    ] : [])
    expect(live.messagesSnapshot(events, () => undefined)).toEqual(messages)
  })

  it('projects object presentation metadata through live results and restored history', () => {
    const projection = new SessionProjection(sessionId, presenter)
    const metadata = { a2ui: { ownerToolCallId: 'presentation-owner' } }
    const result = toolResult('with-metadata', false, metadata)
    expect(projection.project(result, 1).events).toMatchObject([{ metadata }])
    expect(projection.messagesSnapshot([result], () => undefined)).toMatchObject([{ metadata }])
  })

  it.each([undefined, null, []])('omits non-object presentation metadata (%s)', metadata => {
    const projection = new SessionProjection(sessionId, presenter)
    const result = toolResult('without-metadata', false, metadata)
    expect(projection.project(result, 1).events[0]).not.toHaveProperty('metadata')
    expect(projection.messagesSnapshot([result], () => undefined)[0]).not.toHaveProperty('metadata')
  })

  it('derives the full history, including tool-only assistant messages in durable order', () => {
    const projection = new SessionProjection(sessionId, presenter)
    const events = [
      event('user/message', {
        id: 'sys-1',
        source: { kind: 'system' },
        content: [{ type: 'text', text: 'injected context' }],
      }),
      event('user/message', {
        id: 'user-1',
        source: { kind: 'user' },
        content: [{ type: 'text', text: 'hello' }],
      }),
      event('user/message', {
        id: 'user-unknown',
        source: { kind: 'user' },
        content: [{ type: 'text', text: 'from a cold session' }],
      }),
      textMessage(''),
      textMessage('hello back'),
      event('assistant/message', {
        turn: 1,
        step: 2,
        message: createAssistantMessage({
          content: [
            { type: 'text', text: 'I will render it.' },
            {
              type: 'tool-call',
              id: ToolCallId('call-1'),
              name: 'render_a2ui',
              arguments: '{"surfaceId":"overview","components":[]}',
            },
          ],
          source: { provider: 'scripted', model: 'scripted' },
        }),
      }),
      toolResult('call-1'),
    ]
    expect(projection.messagesSnapshot(events, id => (id === 'user-1' ? 'client-user-1' : undefined))).toEqual([
      { id: 'client-user-1', role: 'user', content: 'hello' },
      { id: messageId, role: 'assistant', content: 'hello back' },
      {
        id: 'ag-ui:ag-ui-projection-test:1:2:assistant',
        role: 'assistant',
        content: 'I will render it.',
        toolCalls: [{
          id: 'call-1',
          type: 'function',
          function: {
            name: 'render_a2ui',
            arguments: '{"surfaceId":"overview","components":[]}',
          },
        }],
      },
      {
        id: 'ag-ui:ag-ui-projection-test:call-1:result',
        role: 'tool',
        toolCallId: 'call-1',
        content: 'result of call-1',
      },
    ])
  })

  it('gives an empty failed durable tool result an explicit error', () => {
    const projection = new SessionProjection(sessionId, presenter)
    expect(projection.messagesSnapshot([event('tool/result', { turn: 1, step: 1, message: createToolResultMessage({ callId: ToolCallId('empty-failure'), isError: true, content: [] }) })], () => undefined)).toMatchObject([{ role: 'tool', error: 'Tool execution failed' }])
  })

  it('keeps a tool-only assistant message so its result is never orphaned', () => {
    const projection = new SessionProjection(sessionId, presenter)
    const announcement = assistantToolAnnouncement(1, 1)

    expect(projection.messagesSnapshot([announcement, toolResult('announced-0')], () => undefined)).toEqual([
      {
        id: messageId,
        role: 'assistant',
        toolCalls: [{
          id: 'announced-0',
          type: 'function',
          function: { name: 'ui_action', arguments: '{}' },
        }],
      },
      {
        id: 'ag-ui:ag-ui-projection-test:announced-0:result',
        role: 'tool',
        toolCallId: 'announced-0',
        content: 'result of announced-0',
      },
    ])
  })
})

/** Scheduling view where every announced tool would still start while parked. */
const parallel = (): boolean => true

describe('SessionProjection run outcomes', () => {
  it('maps every turn-end reason to its AG-UI run outcome', () => {
    const cases = [
      [{ kind: 'completed' }, { kind: 'success' }],
      [{ kind: 'max-tokens' }, { kind: 'success' }],
      [{ kind: 'error', error: { code: 'MODEL_FAILED', message: 'model failed' } },
        { kind: 'error', code: 'MODEL_FAILED', message: 'model failed' }],
      [{ kind: 'aborted' }, { kind: 'error', code: 'AGENT_ABORTED', message: 'The DSH turn was aborted.' }],
      [{ kind: 'blocked' }, { kind: 'error', code: 'AGENT_BLOCKED', message: 'The DSH turn was blocked before completion.' }],
      [{ kind: 'interrupted' }, { kind: 'error', code: 'AGENT_INTERRUPTED', message: 'The stored DSH turn was interrupted.' }],
      [{ kind: 'extension-reason' }, { kind: 'error', code: 'AGENT_EXECUTION_ERROR', message: 'The DSH turn ended with an unsupported reason.' }],
    ] as const
    for (const [reason, outcome] of cases) {
      const projection = new SessionProjection(sessionId, presenter)
      expect(projection.project(event('turn/end', { turn: 1, reason }), 1).outcome).toEqual(outcome)
    }
  })

  it('ignores events outside the active turn and releases step slots at step end', () => {
    const projection = new SessionProjection(sessionId, presenter)
    const nextTurnCall = event('tool/call', {
      turn: 2, step: 1, callId: ToolCallId('other-turn'), name: 'backend_tool', arguments: '{}',
    })
    expect(projection.project(nextTurnCall, 1).events).toEqual([])
    expect(projection.project(nextTurnCall, undefined).events).toEqual([])
    expect(projection.lifecycleOf('other-turn')).toBeUndefined()
  })

  it('settles a park immediately when the step announced no further calls', () => {
    const projection = new SessionProjection(sessionId, presenter)
    projection.project(toolCall('park-1', 'ui_action'), 1)
    expect(projection.parkSettleReady(1, 1, parallel)).toBe(false)
    projection.markParked('park-1', backendLifecycle(projection, 'park-1'))
    expect(projection.parkSettleReady(1, 1, parallel)).toBe(true)
  })

  it('holds the park settle until every announced call streamed', () => {
    const projection = new SessionProjection(sessionId, presenter)
    projection.project(assistantToolAnnouncement(1, 2), 1)

    projection.project(toolCall('park-1', 'ui_action'), 1)
    projection.markParked('park-1', backendLifecycle(projection, 'park-1'))
    expect(projection.parkSettleReady(1, 1, parallel)).toBe(false)
    // an exclusive follow-up call would never start behind the parked call
    expect(projection.parkSettleReady(1, 1, () => false)).toBe(true)

    projection.project(toolCall('server-1', 'backend_tool'), 1)
    expect(projection.parkSettleReady(1, 1, parallel)).toBe(true)

    projection.markAwaitingResult('park-1')
    expect(projection.parkSettleReady(1, 1, parallel)).toBe(false)
    projection.project(toolResult('server-1'), 1)
    projection.project(event('step/end', { turn: 1, step: 1 }), 1)
  })

  it('ignores awaiting marks on calls that never parked', () => {
    const projection = new SessionProjection(sessionId, presenter)
    projection.project(toolCall('server-2', 'backend_tool'), 1)
    projection.markAwaitingResult('server-2')
    projection.markAwaitingResult('missing-call')
    expect(projection.lifecycleOf('server-2')).toMatchObject({ kind: 'backend', turn: 1 })
  })

  it('settles once every announced call streamed or parked', () => {
    const projection = new SessionProjection(sessionId, presenter)
    projection.project(assistantToolAnnouncement(1, 2), 1)
    projection.project(toolCall('park-1', 'ui_action'), 1)
    projection.markParked('park-1', backendLifecycle(projection, 'park-1'))
    expect(projection.parkSettleReady(1, 1, parallel)).toBe(false)
    projection.project(toolCall('park-2', 'ui_action'), 1)
    expect(projection.parkSettleReady(1, 1, parallel)).toBe(true)
    projection.markParked('park-2', backendLifecycle(projection, 'park-2'))
    expect(projection.parkSettleReady(1, 1, parallel)).toBe(true)
  })

  it('clears step progress for one finished turn only', () => {
    const projection = new SessionProjection(sessionId, presenter)
    projection.project(assistantToolAnnouncement(1, 1), 1)
    projection.project(toolCall('turn-1-park', 'ui_action'), 1)
    projection.markParked('turn-1-park', backendLifecycle(projection, 'turn-1-park'))
    projection.project(assistantToolAnnouncement(2, 1), 2)
    projection.project(event('tool/call', {
      turn: 2, step: 1, callId: ToolCallId('turn-2-park'), name: 'ui_action', arguments: '{}',
    }), 2)
    projection.markParked('turn-2-park', backendLifecycle(projection, 'turn-2-park'))
    projection.clearTurn(1)
    expect(projection.parkSettleReady(1, 1, parallel)).toBe(false)
    expect(projection.parkSettleReady(2, 1, parallel)).toBe(true)
  })

  it('clears call lifecycles only for the finished turn', () => {
    const projection = new SessionProjection(sessionId, presenter)
    projection.project(toolCall('turn-1-call', 'backend_tool'), 1)
    projection.project(event('tool/call', {
      turn: 2, step: 1, callId: ToolCallId('turn-2-call'), name: 'backend_tool', arguments: '{}',
    }), 2)
    projection.clearTurn(1)
    expect(projection.lifecycleOf('turn-1-call')).toBeUndefined()
    expect(projection.lifecycleOf('turn-2-call')).toMatchObject({ kind: 'backend', turn: 2 })
  })
})

describe('SessionProjection cold recovery', () => {
  it('recovers derived users and recorded server results from a durable log', () => {
    const projection = new SessionProjection(sessionId, presenter)
    const recovery = projection.recoverFrom([
      userMessage('sys-1', 'injected context', 'system'),
      userMessage(durableUserId('client-user-1'), 'hello'),
      userMessage('foreign-uuid', 'written by another owner'),
      toolResult('call-1'),
      userMessage(durableUserId('client-user-2'), 'again'),
    ])
    expect(recovery.users).toEqual([
      { clientId: 'client-user-1', content: 'hello' },
      { clientId: 'client-user-2', content: 'again' },
    ])
    expect(recovery.interrupted).toBe(false)
    expect(projection.consumeServerResult('call-1')).toBe(true)
    expect(projection.consumeServerResult('call-1')).toBe(false)
  })

  it('recovers a claimed identity before user/message append while leaving discarded input retryable', () => {
    const kept = userMessage(durableUserId('claimed'), 'run once').data
    const dropped = userMessage(durableUserId('discarded'), 'retry me').data
    const events = [
      event('agent/inbox/spliced', { target: 'next-step', start: 0, inserted: [kept, dropped] }),
      event('agent/inbox/spliced', { target: 'next-step', start: 0, removedCount: 1, inserted: [] }),
      event('agent/inbox/spliced', { target: 'next-step', start: 0, removedCount: 1, inserted: [], outcome: 'canceled' }),
    ]
    const recovery = new SessionProjection(sessionId, presenter).recoverFrom(events)
    expect(recovery.users).toEqual([{ clientId: 'claimed', content: 'run once' }])
    expect(new SessionProjection(sessionId, presenter).recoverFrom([
      ...events, userMessage(durableUserId('claimed'), 'run once'),
    ]).users).toEqual(recovery.users)
  })

  it('marks the thread interrupted only when the last turn ended interrupted', () => {
    const turnEnd = (turn: number, kind: string): SessionEvent =>
      event('turn/end', { turn, reason: { kind } })
    const interrupted = new SessionProjection(sessionId, presenter).recoverFrom([
      turnEnd(1, 'interrupted'),
    ])
    expect(interrupted.interrupted).toBe(true)

    const recovered = new SessionProjection(sessionId, presenter).recoverFrom([
      turnEnd(1, 'interrupted'),
      turnEnd(2, 'completed'),
    ])
    expect(recovered.interrupted).toBe(false)

    const stale = new SessionProjection(sessionId, presenter).recoverFrom([
      turnEnd(1, 'interrupted'),
      turnEnd(2, 'completed'),
      turnEnd(3, 'interrupted'),
    ])
    expect(stale.interrupted).toBe(true)
  })
})
