import { afterEach, describe, expect, it } from 'vitest'
import { HttpAgent } from '@ag-ui/client'
import { EventType, type BaseEvent, type Tool, type ToolCallResultEvent, type ToolCallStartEvent } from '@ag-ui/core'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { disposeMountedContexts, expectLifecycleValid, mountGateway, runAgentEvents } from './harness.ts'
import { textResponse, toolCallsResponse, toolResponse } from './scripted-adapter.ts'

/**
 * Conformance suite for the five AG-UI feature scenarios. Every scenario runs
 * end-to-end through the official client against a real HTTP server, and its
 * recorded event stream must pass the client's lifecycle validator — the same
 * arbiter any compliant frontend applies.
 */

const SECRET = 'test-only-ag-ui-shared-secret'
const HEADERS = {
  authorization: `Bearer ${SECRET}`,
  'x-dsh-tenant-id': 'hospital-demo',
  'x-dsh-user-id': 'clinician-1',
}

const mount = (script: StreamChunk[][]) =>
  mountGateway(script, SECRET, { persona: 'You assist a clinician with the current consultation draft.' })

afterEach(() => disposeMountedContexts())

/** Backend tool whose durable result is a fixed JSON payload. */
function backendTool(name: string, description: string, properties: Record<string, unknown>, required: string[], result: object): ToolDefinition {
  return {
    name,
    description,
    parameters: { type: 'object', properties, required, additionalProperties: false },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : 'unexpected' }],
    },
    execute: () => Promise.resolve(JSON.stringify(result)),
  }
}

const BACKEND_TOOL = backendTool(
  'lookup_backend_record',
  'Look up one backend record.',
  { recordId: { type: 'string' } },
  ['recordId'],
  { recordId: 'record-7', status: 'ready' },
)

const RECIPE_TOOL = backendTool(
  'compose_recipe_card',
  'Compose a structured recipe card for the frontend to render.',
  { dish: { type: 'string' }, servings: { type: 'integer' } },
  ['dish', 'servings'],
  { dish: 'Pasta Primavera', servings: 2, steps: ['Boil the pasta', 'Toss with vegetables'] },
)

const DRAFT_TOOL: Tool = {
  name: 'ui_patch_consultation_draft',
  description: 'Patch the current consultation draft.',
  parameters: {
    type: 'object',
    properties: {
      expectedVersion: { type: 'integer' },
      assessment: { type: 'string' },
    },
    required: ['expectedVersion', 'assessment'],
    additionalProperties: false,
  },
}

describe('AG-UI five-feature conformance', () => {
  it('the lifecycle arbiter rejects an out-of-order stream', async () => {
    const broken = [
      { type: EventType.RUN_STARTED, threadId: 'conformance-arbiter', runId: 'arbiter-run' },
      { type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'orphan', delta: 'no start event' },
      { type: EventType.RUN_FINISHED, threadId: 'conformance-arbiter', runId: 'arbiter-run' },
    ] as BaseEvent[]
    await expect(expectLifecycleValid(broken)).rejects.toThrow(/No active text message found/)
  })

  it('agentic chat streams one validated text turn', async () => {
    const harness = await mount([textResponse('The consultation draft looks consistent.')])
    const agent = new HttpAgent({ url: harness.url, headers: HEADERS, threadId: 'conformance-chat' })
    agent.addMessage({ id: 'chat-user', role: 'user', content: 'Review my draft.' })
    const events = await runAgentEvents(agent, 'chat-run', [])

    expect(events.map(event => event.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.MESSAGES_SNAPSHOT,
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END,
      EventType.RUN_FINISHED,
    ])
    await expectLifecycleValid(events)
    expect(agent.messages.at(-1)).toMatchObject({ role: 'assistant', content: 'The consultation draft looks consistent.' })
  })

  it('the run-start snapshot reflects the full derived history with ids matching the streamed events', async () => {
    const harness = await mount([
      toolResponse('conformance-history-call', BACKEND_TOOL.name, { recordId: 'record-7' }),
      textResponse('Backend lookup completed.'),
      textResponse('Second answer.'),
    ])
    harness.ctx.tools.register(BACKEND_TOOL)
    const agent = new HttpAgent({ url: harness.url, headers: HEADERS, threadId: 'conformance-history' })
    agent.addMessage({ id: 'history-user', role: 'user', content: 'Look up record 7.' })
    const first = await runAgentEvents(agent, 'history-run-1', [])
    const second = await runAgentEvents(agent, 'history-run-2', [])

    const streamedAssistant = first.find(event => event.type === EventType.TEXT_MESSAGE_START)
    const streamedCall = first.find((event): event is ToolCallStartEvent => event.type === EventType.TOOL_CALL_START)
    const streamedResult = first.find((event): event is ToolCallResultEvent =>
      event.type === EventType.TOOL_CALL_RESULT)
    const snapshot = second.find(event => event.type === EventType.MESSAGES_SNAPSHOT)
    expect(snapshot?.messages).toEqual([
      { id: 'history-user', role: 'user', content: 'Look up record 7.' },
      {
        id: streamedCall?.parentMessageId,
        role: 'assistant',
        toolCalls: [{
          id: 'conformance-history-call',
          type: 'function',
          function: {
            name: BACKEND_TOOL.name,
            arguments: '{"recordId":"record-7"}',
          },
        }],
      },
      {
        id: streamedResult?.messageId,
        role: 'tool',
        toolCallId: 'conformance-history-call',
        content: streamedResult?.content,
      },
      { id: streamedAssistant?.messageId, role: 'assistant', content: 'Backend lookup completed.' },
    ])
    await expectLifecycleValid(second)
  })

  it('backend tool streams a validated call/result pair the client can render', async () => {
    const harness = await mount([
      toolResponse('conformance-backend-call', BACKEND_TOOL.name, { recordId: 'record-7' }),
      textResponse('Backend lookup completed.'),
    ])
    harness.ctx.tools.register(BACKEND_TOOL)
    const agent = new HttpAgent({ url: harness.url, headers: HEADERS, threadId: 'conformance-backend-tool' })
    agent.addMessage({ id: 'backend-user', role: 'user', content: 'Look up record 7.' })
    const events = await runAgentEvents(agent, 'backend-run', [])

    expect(events.map(event => event.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.MESSAGES_SNAPSHOT,
      EventType.TOOL_CALL_START,
      EventType.TOOL_CALL_ARGS,
      EventType.TOOL_CALL_END,
      EventType.CUSTOM,
      EventType.TOOL_CALL_RESULT,
      EventType.CUSTOM,
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END,
      EventType.RUN_FINISHED,
    ])
    await expectLifecycleValid(events)
    const result = events.find((event): event is ToolCallResultEvent =>
      event.type === EventType.TOOL_CALL_RESULT)
    expect(result?.content).toContain('"recordId":"record-7"')
    expect(agent.messages.some(message =>
      message.role === 'tool' && message.toolCallId === 'conformance-backend-call')).toBe(true)
  })

  it('shared state updates stream as validated snapshots after the durable tool result', async () => {
    const harness = await mount([
      toolResponse('conformance-state-call', 'ag_ui_update_state', {
        state_updates: { status: 'ready', recipe: { title: 'Pasta Primavera' } },
      }),
      textResponse('The shared state is ready.'),
    ])
    const agent = new HttpAgent({ url: harness.url, headers: HEADERS, threadId: 'conformance-shared-state' })
    agent.setState({ status: 'draft' })
    agent.addMessage({ id: 'state-user', role: 'user', content: 'Finalize the shared state.' })
    const events = await runAgentEvents(agent, 'state-run', [])

    expect(events.map(event => event.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.MESSAGES_SNAPSHOT,
      EventType.STATE_SNAPSHOT,
      EventType.STATE_SNAPSHOT,
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END,
      EventType.RUN_FINISHED,
    ])
    await expectLifecycleValid(events)
    expect(agent.state).toEqual({ status: 'ready', recipe: { title: 'Pasta Primavera' } })
  })

  it('human-in-the-loop frontend tool parks and resumes across two validated runs', async () => {
    const harness = await mount([
      toolResponse('conformance-frontend-call', DRAFT_TOOL.name, {
        expectedVersion: 3,
        assessment: 'Likely viral upper respiratory infection.',
      }),
      textResponse('Draft updated. Please review it before submitting.'),
    ])
    const agent = new HttpAgent({ url: harness.url, headers: HEADERS, threadId: 'conformance-hitl' })
    agent.addMessage({ id: 'hitl-user', role: 'user', content: 'Write the assessment here.' })
    const parkEvents = await runAgentEvents(agent, 'hitl-run-1', [DRAFT_TOOL])

    expect(parkEvents.map(event => event.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.MESSAGES_SNAPSHOT,
      EventType.TOOL_CALL_START,
      EventType.TOOL_CALL_ARGS,
      EventType.TOOL_CALL_END,
      EventType.RUN_FINISHED,
    ])
    await expectLifecycleValid(parkEvents)

    agent.addMessage({
      id: 'hitl-tool-result',
      role: 'tool',
      toolCallId: 'conformance-frontend-call',
      content: JSON.stringify({ status: 'applied', version: 4 }),
    })
    const resumeEvents = await runAgentEvents(agent, 'hitl-run-2', [DRAFT_TOOL])

    expect(resumeEvents.map(event => event.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.MESSAGES_SNAPSHOT,
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END,
      EventType.RUN_FINISHED,
    ])
    await expectLifecycleValid(resumeEvents)
    expect(agent.messages.at(-1)).toMatchObject({ role: 'assistant', content: 'Draft updated. Please review it before submitting.' })
  })

  it('several frontend tools in one step park together and resume in subset runs', async () => {
    const harness = await mount([
      toolCallsResponse([
        { callId: 'conformance-draft-a', name: DRAFT_TOOL.name, args: { expectedVersion: 3, assessment: 'First.' } },
        { callId: 'conformance-draft-b', name: DRAFT_TOOL.name, args: { expectedVersion: 3, assessment: 'Second.' } },
      ]),
      textResponse('Both drafts applied within one validated turn.'),
    ])
    const agent = new HttpAgent({ url: harness.url, headers: HEADERS, threadId: 'conformance-hitl-multi' })
    agent.addMessage({ id: 'hitl-multi-user', role: 'user', content: 'Write two assessments.' })
    const parkEvents = await runAgentEvents(agent, 'hitl-multi-run-1', [DRAFT_TOOL])

    expect(parkEvents.map(event => event.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.MESSAGES_SNAPSHOT,
      EventType.TOOL_CALL_START,
      EventType.TOOL_CALL_ARGS,
      EventType.TOOL_CALL_END,
      EventType.TOOL_CALL_START,
      EventType.TOOL_CALL_ARGS,
      EventType.TOOL_CALL_END,
      EventType.RUN_FINISHED,
    ])
    await expectLifecycleValid(parkEvents)

    agent.addMessage({
      id: 'hitl-multi-result-a',
      role: 'tool',
      toolCallId: 'conformance-draft-a',
      content: JSON.stringify({ status: 'applied', version: 4 }),
    })
    const subsetEvents = await runAgentEvents(agent, 'hitl-multi-run-2', [DRAFT_TOOL])
    expect(subsetEvents.map(event => event.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.MESSAGES_SNAPSHOT,
      EventType.RUN_FINISHED,
    ])
    await expectLifecycleValid(subsetEvents)

    agent.addMessage({
      id: 'hitl-multi-result-b',
      role: 'tool',
      toolCallId: 'conformance-draft-b',
      content: JSON.stringify({ status: 'applied', version: 5 }),
    })
    const resumeEvents = await runAgentEvents(agent, 'hitl-multi-run-3', [DRAFT_TOOL])
    expect(resumeEvents.map(event => event.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.MESSAGES_SNAPSHOT,
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END,
      EventType.RUN_FINISHED,
    ])
    await expectLifecycleValid(resumeEvents)
    expect(agent.messages.at(-1)).toMatchObject({ role: 'assistant', content: 'Both drafts applied within one validated turn.' })
  })

  it('tool-based generative UI returns a structured payload in a validated tool result', async () => {
    const harness = await mount([
      toolResponse('conformance-recipe-call', RECIPE_TOOL.name, { dish: 'Pasta Primavera', servings: 2 }),
      textResponse('Recipe card composed.'),
    ])
    harness.ctx.tools.register(RECIPE_TOOL)
    const agent = new HttpAgent({ url: harness.url, headers: HEADERS, threadId: 'conformance-generative-ui' })
    agent.addMessage({ id: 'recipe-user', role: 'user', content: 'Compose a recipe card for dinner.' })
    const events = await runAgentEvents(agent, 'recipe-run', [])

    expect(events.map(event => event.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.MESSAGES_SNAPSHOT,
      EventType.TOOL_CALL_START,
      EventType.TOOL_CALL_ARGS,
      EventType.TOOL_CALL_END,
      EventType.CUSTOM,
      EventType.TOOL_CALL_RESULT,
      EventType.CUSTOM,
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END,
      EventType.RUN_FINISHED,
    ])
    await expectLifecycleValid(events)
    const result = events.find((event): event is ToolCallResultEvent =>
      event.type === EventType.TOOL_CALL_RESULT)
    const payload = JSON.parse(result?.content ?? '{}') as { dish?: string, steps?: string[] }
    expect(payload.dish).toBe('Pasta Primavera')
    expect(payload.steps).toContain('Boil the pasta')
  })
})
