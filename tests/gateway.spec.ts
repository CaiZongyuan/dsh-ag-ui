import { afterEach, describe, expect, it } from 'vitest'
import { HttpAgent } from '@ag-ui/client'
import { EventType, type BaseEvent, type RunAgentInput, type Tool } from '@ag-ui/core'
import { Context } from '@deepseek-ai/cordis'
import type { Fiber } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { ScriptedAdapter, textResponse, toolResponse } from './scripted-adapter.ts'
import { mountTestSpine } from './spine.ts'
import AgUiGateway from 'dsh-ag-ui'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

const SECRET = 'test-only-ag-ui-shared-secret'
const HEADERS = {
  authorization: `Bearer ${SECRET}`,
  'x-dsh-tenant-id': 'hospital-demo',
  'x-dsh-user-id': 'clinician-1',
}

interface Harness {
  readonly ctx: Context
  readonly adapter: ScriptedAdapter
  readonly gateway: Fiber
  readonly url: string
}

const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
})

async function mount(script: StreamChunk[][]): Promise<Harness> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  await mountTestSpine(ctx, 'You assist a clinician with the current consultation draft.')
  const adapter = new ScriptedAdapter(script)
  ctx.llm.registerAdapter(['scripted'], adapter)
  const gateway = await ctx.plugin(AgUiGateway, {
    provider: 'scripted',
    model: 'scripted',
    sharedSecret: SECRET,
    maxRunEvents: 128,
    maxRunEventBytes: 128 * 1024,
    frontendToolTimeoutMs: 10_000,
    threadIdleMs: 60_000,
  })
  return { ctx, adapter, gateway, url: `http://127.0.0.1:${String(ctx.webServer.port)}/ag-ui` }
}

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
    const events: BaseEvent[] = []

    await agent.runAgent({ runId: 'state-run', tools: [], context: [], forwardedProps: {} }, {
      onEvent: ({ event }) => { events.push(event) },
    })

    expect(events.map(event => event.type)).toEqual([
      EventType.RUN_STARTED,
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
    expect(dshAgent?.session.events.filter(event => event.type === 'tool/call')).toHaveLength(1)
    expect(dshAgent?.session.events.filter(event => event.type === 'tool/result')).toHaveLength(1)
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
    const events: BaseEvent[] = []

    await agent.runAgent({ runId: 'state-unchanged-run', tools: [], context: [], forwardedProps: {} }, {
      onEvent: ({ event }) => { events.push(event) },
    })

    expect(events.filter(event => event.type === EventType.STATE_SNAPSHOT)).toEqual([
      { type: EventType.STATE_SNAPSHOT, snapshot: { status: 'draft', nested: { first: 1, second: 2 } } },
    ])
    expect(harness.ctx.agents.list()[0]?.session.events.filter(event => event.type === 'tool/result')).toHaveLength(1)
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
      EventType.TOOL_CALL_START,
      EventType.TOOL_CALL_ARGS,
      EventType.TOOL_CALL_END,
      EventType.RUN_FINISHED,
    ])
    const dshAgent = harness.ctx.agents.list()[0]
    expect(dshAgent?.status).toBe('running')
    expect(dshAgent?.session.events.filter(event => event.type === 'turn/start')).toHaveLength(1)
    expect(dshAgent?.session.events.filter(event => event.type === 'tool/call')).toHaveLength(1)
    expect(dshAgent?.session.events.filter(event => event.type === 'tool/result')).toHaveLength(0)

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
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END,
      EventType.RUN_FINISHED,
    ])
    expect(dshAgent?.status).toBe('idle')
    expect(dshAgent?.session.events.filter(event => event.type === 'turn/start')).toHaveLength(1)
    expect(dshAgent?.session.events.filter(event => event.type === 'turn/end')).toHaveLength(1)
    expect(dshAgent?.session.events.filter(event => event.type === 'tool/result')).toHaveLength(1)
    expect(harness.adapter.requests).toHaveLength(2)
    const secondRequest = harness.adapter.requests[1]
    expect(secondRequest?.messages.some(message => message.content.some(block =>
      block.type === 'text' && block.text.includes('"draftVersion":4')))).toBe(true)
    expect(secondRequest?.messages.some(message => message.content.some(block =>
      block.type === 'tool-result' && block.content.some(content =>
        content.type === 'text' && content.text.includes('"version":4'))))).toBe(true)
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

    const backendEvents: BaseEvent[] = []
    await agent.runAgent({ runId: 'run-backend', tools: [], context: [], forwardedProps: {} }, {
      onEvent: ({ event }) => { backendEvents.push(event) },
    })
    expect(backendEvents.map(event => event.type)).toContain(EventType.TOOL_CALL_RESULT)
    expect(agent.messages.some(message => message.role === 'tool' && message.toolCallId === 'backend-call')).toBe(true)

    agent.addMessage({ id: 'user-frontend', role: 'user', content: 'Update the assessment.' })
    const frontendCallEvents: BaseEvent[] = []
    await agent.runAgent({ runId: 'run-frontend-call', tools: [PATCH_TOOL], context: [], forwardedProps: {} }, {
      onEvent: ({ event }) => { frontendCallEvents.push(event) },
    })
    agent.addMessage({
      id: 'frontend-result',
      role: 'tool',
      toolCallId: 'frontend-call',
      content: JSON.stringify({ status: 'applied' }),
    })
    const frontendResultEvents: BaseEvent[] = []
    await agent.runAgent({ runId: 'run-frontend-result', tools: [PATCH_TOOL], context: [], forwardedProps: {} }, {
      onEvent: ({ event }) => { frontendResultEvents.push(event) },
    })

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
