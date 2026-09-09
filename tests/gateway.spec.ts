import { afterEach, describe, expect, it } from 'vitest'
import { HttpAgent } from '@ag-ui/client'
import { EventType, type BaseEvent, type RunAgentInput, type Tool } from '@ag-ui/core'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { disposeMountedContexts, mountGateway, runAgentEvents } from './harness.ts'
import { textResponse, toolCallsResponse, toolResponse } from './scripted-adapter.ts'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

const SECRET = 'test-only-ag-ui-shared-secret'
const HEADERS = {
  authorization: `Bearer ${SECRET}`,
  'x-dsh-tenant-id': 'hospital-demo',
  'x-dsh-user-id': 'clinician-1',
}

afterEach(() => disposeMountedContexts())

const mount = (script: StreamChunk[][]) =>
  mountGateway(script, SECRET, { persona: 'You assist a clinician with the current consultation draft.' })

const BACKEND_TOOL: ToolDefinition = {
  name: 'lookup_backend_record',
  description: 'Look up one backend record.',
  parameters: {
    type: 'object',
    properties: { recordId: { type: 'string' } },
    required: ['recordId'],
    additionalProperties: false,
  },
  output: {
    schema: { type: 'string' },
    render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : 'unexpected' }],
  },
  execute: (args) => {
    const recordId = typeof args === 'object' && args !== null && 'recordId' in args
      && typeof args.recordId === 'string' ? args.recordId : 'invalid'
    return Promise.resolve(JSON.stringify({ recordId, status: 'ready' }))
  },
}

const PATCH_TOOL: Tool = {
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

describe('AG-UI Gateway', () => {
  it('synchronizes shared state after the durable DSH Tool result', async () => {
    const harness = await mount([
      toolResponse('state-call', 'ag_ui_update_state', {
        state_updates: {
          recipe: { title: 'Pasta Primavera', ingredients: ['Pasta', 'Tomato'] },
          status: 'ready',
        },
      }),
      textResponse('The shared recipe is ready.'),
    ])
    const agent = new HttpAgent({ url: harness.url, headers: HEADERS, threadId: 'shared-state-thread' })
    agent.setState({
      recipe: { title: 'Draft', ingredients: ['Pasta'] },
      status: 'draft',
      tenantId: 'spoofed-tenant',
    })
    agent.addMessage({ id: 'state-user', role: 'user', content: 'Improve the shared recipe.' })
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
    expect(agent.state).toEqual({
      recipe: { title: 'Pasta Primavera', ingredients: ['Pasta', 'Tomato'] },
      status: 'ready',
      tenantId: 'spoofed-tenant',
    })
    expect(events.some(event => event.type === EventType.TOOL_CALL_START
      || event.type === EventType.TOOL_CALL_RESULT)).toBe(false)
    expect(harness.adapter.requests[0]?.messages.some(message => message.content.some(block =>
      block.type === 'text' && block.text.includes('"title":"Draft"')))).toBe(true)
    expect(harness.adapter.requests[0]?.tools.some(tool => tool.name === 'ag_ui_update_state')).toBe(true)
    expect(harness.adapter.requests[1]?.messages.some(message => message.content.some(block =>
      block.type === 'tool-result' && block.content.some(content =>
        content.type === 'text' && content.text.includes('Pasta Primavera'))))).toBe(true)

    const dshAgent = harness.ctx.agents.list()[0]
    expect(dshAgent).toBeDefined()
    expect(dshAgent?.session.snapshotEvents().filter(event => event.type === 'tool/call')).toHaveLength(1)
    expect(dshAgent?.session.snapshotEvents().filter(event => event.type === 'tool/result')).toHaveLength(1)
    expect(harness.ctx.agUi.identityFor(dshAgent as NonNullable<typeof dshAgent>)).toEqual({
      principal: { tenantId: 'hospital-demo', userId: 'clinician-1' },
      threadId: 'shared-state-thread',
    })
  })

  it('records an unchanged shared-state Tool result without a redundant snapshot', async () => {
    const harness = await mount([
      toolResponse('state-unchanged-call', 'ag_ui_update_state', {
        state_updates: { nested: { second: 2, first: 1 } },
      }),
      textResponse('The shared state is unchanged.'),
    ])
    const agent = new HttpAgent({ url: harness.url, headers: HEADERS, threadId: 'shared-state-unchanged' })
    agent.setState({ status: 'draft', nested: { first: 1, second: 2 } })
    agent.addMessage({ id: 'state-unchanged-user', role: 'user', content: 'Keep the state unchanged.' })
    const events = await runAgentEvents(agent, 'state-unchanged-run', [])

    expect(events.filter(event => event.type === EventType.STATE_SNAPSHOT)).toEqual([
      { type: EventType.STATE_SNAPSHOT, snapshot: { status: 'draft', nested: { first: 1, second: 2 } } },
    ])
    expect(harness.ctx.agents.list()[0]?.session.snapshotEvents().filter(event => event.type === 'tool/result')).toHaveLength(1)
  })

  it('parks one frontend Tool across two HTTP runs and resumes the same DSH turn', async () => {
    const harness = await mount([
      toolResponse('call-draft', PATCH_TOOL.name, {
        expectedVersion: 3,
        assessment: 'Likely viral upper respiratory infection.',
      }),
      textResponse('Draft updated. Please review it before submitting.'),
    ])
    const agent = new HttpAgent({ url: harness.url, headers: HEADERS, threadId: 'encounter-e001' })
    agent.addMessage({ id: 'user-1', role: 'user', content: 'Write the assessment here.' })

    const firstEvents: BaseEvent[] = []
    await agent.runAgent({
      runId: 'run-1',
      tools: [PATCH_TOOL],
      context: [{
        description: 'Current consultation page',
        value: JSON.stringify({ encounterId: 'e001', focusedField: 'assessment', draftVersion: 3 }),
      }],
      forwardedProps: {},
    }, { onEvent: ({ event }) => { firstEvents.push(event) } })

    expect(firstEvents.map(event => event.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.MESSAGES_SNAPSHOT,
      EventType.TOOL_CALL_START,
      EventType.TOOL_CALL_ARGS,
      EventType.TOOL_CALL_END,
      EventType.RUN_FINISHED,
    ])
    const dshAgent = harness.ctx.agents.list()[0]
    expect(dshAgent?.status).toBe('running')
    expect(dshAgent?.session.snapshotEvents().filter(event => event.type === 'turn/start')).toHaveLength(1)
    expect(dshAgent?.session.snapshotEvents().filter(event => event.type === 'tool/call')).toHaveLength(1)
    expect(dshAgent?.session.snapshotEvents().filter(event => event.type === 'tool/result')).toHaveLength(0)

    agent.addMessage({
      id: 'tool-result-1',
      role: 'tool',
      toolCallId: 'call-draft',
      content: JSON.stringify({ status: 'applied', version: 4 }),
    })
    const secondEvents: BaseEvent[] = []
    await agent.runAgent({
      runId: 'run-2',
      tools: [PATCH_TOOL],
      context: [{
        description: 'Current consultation page',
        value: JSON.stringify({ encounterId: 'e001', focusedField: 'assessment', draftVersion: 4 }),
      }],
      forwardedProps: {},
    }, { onEvent: ({ event }) => { secondEvents.push(event) } })

    expect(secondEvents.map(event => event.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.MESSAGES_SNAPSHOT,
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END,
      EventType.RUN_FINISHED,
    ])
    expect(dshAgent?.status).toBe('idle')
    expect(dshAgent?.session.snapshotEvents().filter(event => event.type === 'turn/start')).toHaveLength(1)
    expect(dshAgent?.session.snapshotEvents().filter(event => event.type === 'turn/end')).toHaveLength(1)
    expect(dshAgent?.session.snapshotEvents().filter(event => event.type === 'tool/result')).toHaveLength(1)
    expect(harness.adapter.requests).toHaveLength(2)
    const secondRequest = harness.adapter.requests[1]
    expect(secondRequest?.messages.some(message => message.content.some(block =>
      block.type === 'text' && block.text.includes('"draftVersion":4')))).toBe(true)
    expect(secondRequest?.messages.some(message => message.content.some(block =>
      block.type === 'tool-result' && block.content.some(content =>
        content.type === 'text' && content.text.includes('"version":4'))))).toBe(true)
  })

  it('parks several frontend Tools in one step and resumes in subset runs', async () => {
    const harness = await mount([
      toolCallsResponse([
        { callId: 'call-draft-a', name: PATCH_TOOL.name, args: { expectedVersion: 3, assessment: 'First assessment.' } },
        { callId: 'call-draft-b', name: PATCH_TOOL.name, args: { expectedVersion: 3, assessment: 'Second assessment.' } },
      ]),
      textResponse('Both drafts applied within one turn.'),
    ])
    const agent = new HttpAgent({ url: harness.url, headers: HEADERS, threadId: 'encounter-multi' })
    agent.addMessage({ id: 'multi-user-1', role: 'user', content: 'Write two assessments.' })
    const tools = [PATCH_TOOL]

    const firstEvents = await runAgentEvents(agent, 'multi-run-1', tools)
    expect(firstEvents.map(event => event.type)).toEqual([
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
    const dshAgent = harness.ctx.agents.list()[0]
    expect(dshAgent?.status).toBe('running')
    expect(dshAgent?.session.snapshotEvents().filter(event => event.type === 'tool/call')).toHaveLength(2)
    expect(dshAgent?.session.snapshotEvents().filter(event => event.type === 'tool/result')).toHaveLength(0)

    agent.addMessage({
      id: 'multi-result-a',
      role: 'tool',
      toolCallId: 'call-draft-a',
      content: JSON.stringify({ status: 'applied', version: 4 }),
    })
    const secondEvents = await runAgentEvents(agent, 'multi-run-2', tools)
    expect(secondEvents.map(event => event.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.MESSAGES_SNAPSHOT,
      EventType.RUN_FINISHED,
    ])
    expect(dshAgent?.status).toBe('running')
    expect(dshAgent?.session.snapshotEvents().filter(event => event.type === 'tool/result')).toHaveLength(1)

    agent.addMessage({
      id: 'multi-result-b',
      role: 'tool',
      toolCallId: 'call-draft-b',
      content: JSON.stringify({ status: 'applied', version: 5 }),
    })
    const thirdEvents = await runAgentEvents(agent, 'multi-run-3', tools)
    expect(thirdEvents.map(event => event.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.MESSAGES_SNAPSHOT,
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END,
      EventType.RUN_FINISHED,
    ])
    expect(dshAgent?.status).toBe('idle')
    expect(dshAgent?.session.snapshotEvents().filter(event => event.type === 'turn/start')).toHaveLength(1)
    expect(dshAgent?.session.snapshotEvents().filter(event => event.type === 'turn/end')).toHaveLength(1)
    expect(dshAgent?.session.snapshotEvents().filter(event => event.type === 'tool/result')).toHaveLength(2)
    expect(harness.adapter.requests).toHaveLength(2)
  })

  it('settles a mixed frontend/backend step once the exclusive backend call cannot start', async () => {
    const harness = await mount([
      toolCallsResponse([
        { callId: 'mixed-frontend', name: PATCH_TOOL.name, args: { expectedVersion: 3, assessment: 'Mixed step.' } },
        { callId: 'mixed-backend', name: BACKEND_TOOL.name, args: { recordId: 'record-7' } },
      ]),
      textResponse('The mixed step completed.'),
    ])
    harness.ctx.tools.register(BACKEND_TOOL)
    const agent = new HttpAgent({ url: harness.url, headers: HEADERS, threadId: 'encounter-mixed' })
    agent.addMessage({ id: 'mixed-user-1', role: 'user', content: 'Patch and look up.' })

    const firstEvents = await runAgentEvents(agent, 'mixed-run-1', [PATCH_TOOL])
    expect(firstEvents.map(event => event.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.MESSAGES_SNAPSHOT,
      EventType.TOOL_CALL_START,
      EventType.TOOL_CALL_ARGS,
      EventType.TOOL_CALL_END,
      EventType.RUN_FINISHED,
    ])

    agent.addMessage({
      id: 'mixed-result-frontend',
      role: 'tool',
      toolCallId: 'mixed-frontend',
      content: JSON.stringify({ status: 'applied', version: 4 }),
    })
    const secondEvents = await runAgentEvents(agent, 'mixed-run-2', [PATCH_TOOL])
    expect(secondEvents.map(event => event.type)).toEqual([
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
    const dshAgent = harness.ctx.agents.list()[0]
    expect(dshAgent?.session.snapshotEvents().filter(event => event.type === 'tool/result')).toHaveLength(2)
    expect(dshAgent?.session.snapshotEvents().filter(event => event.type === 'turn/start')).toHaveLength(1)
  })

  it('accepts official-client backend ToolMessage history without echoing frontend results', async () => {
    const harness = await mount([
      toolResponse('backend-call', BACKEND_TOOL.name, { recordId: 'record-7' }),
      textResponse('Backend lookup completed.'),
      toolResponse('frontend-call', PATCH_TOOL.name, {
        expectedVersion: 3,
        assessment: 'Updated assessment.',
      }),
      textResponse('Frontend update completed.'),
    ])
    harness.ctx.tools.register(BACKEND_TOOL)
    const agent = new HttpAgent({ url: harness.url, headers: HEADERS, threadId: 'encounter-history' })
    agent.addMessage({ id: 'user-backend', role: 'user', content: 'Look up record 7.' })

    const backendEvents = await runAgentEvents(agent, 'run-backend', [])
    expect(backendEvents.map(event => event.type)).toContain(EventType.TOOL_CALL_RESULT)
    expect(agent.messages.some(message => message.role === 'tool' && message.toolCallId === 'backend-call')).toBe(true)

    agent.addMessage({ id: 'user-frontend', role: 'user', content: 'Update the assessment.' })
    const frontendCallEvents = await runAgentEvents(agent, 'run-frontend-call', [PATCH_TOOL])
    agent.addMessage({
      id: 'frontend-result',
      role: 'tool',
      toolCallId: 'frontend-call',
      content: JSON.stringify({ status: 'applied' }),
    })
    const frontendResultEvents = await runAgentEvents(agent, 'run-frontend-result', [PATCH_TOOL])

    expect(frontendCallEvents.map(event => event.type)).toContain(EventType.TOOL_CALL_END)
    expect(frontendResultEvents.some(event => event.type === EventType.TOOL_CALL_RESULT)).toBe(false)
    expect(harness.adapter.requests.at(-1)?.messages.some(message => message.content.some(block =>
      block.type === 'tool-result' && block.content.some(content =>
        content.type === 'text' && content.text.includes('applied'))))).toBe(true)
  })

  it('replays a completed run idempotently and rejects a conflicting reuse', async () => {
    const harness = await mount([textResponse('Hello from DSH.')])
    const input: RunAgentInput = {
      threadId: 'encounter-e001',
      runId: 'run-text',
      messages: [{ id: 'user-text', role: 'user', content: 'Hello' }],
      tools: [],
      context: [],
      state: { value: 1 },
      forwardedProps: {},
    }
    const first = await post(harness.url, input)
    const replay = await post(harness.url, input)

    expect(first.status).toBe(200)
    expect(replay.status).toBe(200)
    expect(replay.body).toBe(first.body)
    expect(first.body).toContain('STATE_SNAPSHOT')
    expect(harness.adapter.requests).toHaveLength(1)

    const conflict = await post(harness.url, {
      ...input,
      messages: [{ id: 'user-text', role: 'user', content: 'Different' }],
    })
    expect(conflict.status).toBe(409)
    expect(conflict.body).toContain('RUN_ID_CONFLICT')
  })

  it('rejects unauthenticated requests before creating an Agent', async () => {
    const harness = await mount([textResponse('unused')])
    const response = await fetch(harness.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    expect(response.status).toBe(401)
    expect(harness.ctx.agents.list()).toEqual([])
  })

  it('unregisters the route and disposes owned Agents with its Fiber', async () => {
    const harness = await mount([textResponse('Disposable response.')])
    const response = await post(harness.url, {
      threadId: 'encounter-dispose',
      runId: 'run-dispose',
      messages: [{ id: 'user-dispose', role: 'user', content: 'Hello' }],
      tools: [],
      context: [],
      state: {},
      forwardedProps: {},
    })
    expect(response.status).toBe(200)
    expect(harness.ctx.agents.list()).toHaveLength(1)

    await harness.gateway.dispose()

    expect(harness.ctx.agents.list()).toEqual([])
    const after = await fetch(harness.url, { method: 'POST' })
    expect(after.status).toBe(404)
  })
})

async function post(url: string, input: RunAgentInput): Promise<{ status: number; body: string }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { ...HEADERS, 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })
  return { status: response.status, body: await response.text() }
}
