import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { HttpAgent } from '@ag-ui/client'
import { EventType, type CustomEvent, type Tool } from '@ag-ui/core'
import { Context } from '@deepseek-ai/cordis'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { disposeMountedContexts, expectLifecycleValid, mountGateway, runAgentEvents, toolViewEnvelopes } from './harness.ts'
import { ScriptedAdapter, textResponse, toolCallsResponse } from './scripted-adapter.ts'
import { mountTestAgentCore } from './agent-core.ts'
import { durableSessionId } from '../src/session-id.ts'
import { ThreadBinding, type ThreadOptions } from '../src/thread.ts'

/**
 * Presenter projection: backend tool calls carry their DSH render-intent cards
 * as versioned `dsh:tool:view` CUSTOM events, cold transcript reads re-derive
 * the identical settled cards from the durable log, and the reserved state tool
 * plus client-owned frontend Tools stay out of card projection.
 */

const SECRET = 'tool-view-test-shared-secret'
const HEADERS = {
  authorization: `Bearer ${SECRET}`,
  'x-dsh-tenant-id': 'tool-view-tenant',
  'x-dsh-user-id': 'operator-1',
}

/** Backend tool whose declared intents and durable meta mirror everything a card can carry. */
const VIEW_TOOL: ToolDefinition = {
  name: 'view_probe',
  description: 'Probe one subject with a declared presentation.',
  parameters: {
    type: 'object',
    properties: { subject: { type: 'string' } },
    required: ['subject'],
    additionalProperties: false,
  },
  output: {
    schema: { type: 'string' },
    render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : 'unexpected' }],
    presentationMeta: (_args, value) => ({ echoed: value }),
  },
  presentCall: args => ({ card: 'generic', title: `Probing ${(args as { subject: string }).subject}`, kind: 'search', rawInput: args }),
  presentResult: (args, result) => ({
    card: 'generic',
    title: `Probed ${(args as { subject: string }).subject}`,
    content: [{ type: 'text', text: `settled ${String(JSON.stringify(result.meta))} ${result.isError ? 'failed' : 'ok'}` }],
  }),
  execute: () => Promise.resolve('probe-finished'),
}

/** Backend tool with no declared intents, proving the generic fallback. */
const PLAIN_TOOL: ToolDefinition = {
  name: 'plain_tool',
  description: 'One backend tool without presentation intents.',
  parameters: {
    type: 'object',
    properties: { note: { type: 'string' } },
    required: ['note'],
    additionalProperties: false,
  },
  output: {
    schema: { type: 'string' },
    render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : 'unexpected' }],
  },
  execute: () => Promise.resolve('plain-finished'),
}

const RELAY_TOOL: Tool = {
  name: 'ui_relay',
  description: 'Relay one action to the client.',
  parameters: {
    type: 'object',
    properties: { action: { type: 'string' } },
    required: ['action'],
    additionalProperties: false,
  },
}

const contexts: Context[] = []
const roots: string[] = []

afterEach(async () => {
  await disposeMountedContexts()
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

const mount = (script: StreamChunk[][]) => mountGateway(script, SECRET)

describe('tool view cards over HTTP', () => {
  it('streams declared call and result cards, then re-derives the identical settled card cold', async () => {
    const harness = await mount([
      toolCallsResponse([{ callId: 'view-call-1', name: 'view_probe', args: { subject: 'records' } }]),
      textResponse('Probe complete.'),
      textResponse('Nothing further.'),
    ])
    harness.ctx.tools.register(VIEW_TOOL)
    const agent = new HttpAgent({ url: harness.url, headers: HEADERS, threadId: 'view-live' })
    agent.addMessage({ id: 'view-user-1', role: 'user', content: 'Probe the records.' })
    const first = await runAgentEvents(agent, 'view-run-1', [])

    const liveCall = toolViewEnvelopes(first, 'call')
    expect(liveCall).toHaveLength(1)
    expect(liveCall[0].value).toEqual({
      version: 1,
      callId: 'view-call-1',
      toolName: 'view_probe',
      phase: 'call',
      card: { card: 'generic', title: 'Probing records', kind: 'search', rawInput: { subject: 'records' } },
    })
    const liveResult = toolViewEnvelopes(first, 'result')
    expect(liveResult).toHaveLength(1)
    expect(liveResult[0].value).toMatchObject({
      callId: 'view-call-1',
      toolName: 'view_probe',
      phase: 'result',
      // the durable presentationMeta reached the present-result intent verbatim
      card: { card: 'generic', title: 'Probed records', content: [{ type: 'text', text: 'settled {"echoed":"probe-finished"} ok' }] },
    })
    await expectLifecycleValid(first)

    agent.addMessage({ id: 'view-user-2', role: 'user', content: 'Anything else?' })
    const second = await runAgentEvents(agent, 'view-run-2', [])
    const cold = toolViewEnvelopes(second)
    expect(cold).toHaveLength(1)
    // a cold transcript read derives the identical settled card beside the snapshot
    expect(cold[0].value).toEqual(liveResult[0].value)
    const snapshotAt = second.findIndex(event => event.type === EventType.MESSAGES_SNAPSHOT)
    expect(second[snapshotAt + 1]).toBe(cold[0])
    await expectLifecycleValid(second)
  })

  it('falls back to generic cards and excludes the state and frontend tools, live and cold', async () => {
    const harness = await mount([
      toolCallsResponse([{ callId: 'plain-call-1', name: 'plain_tool', args: { note: 'x' } }]),
      toolCallsResponse([{ callId: 'relay-call-1', name: 'ui_relay', args: { action: 'ping' } }]),
      textResponse('Relay parked.'),
      toolCallsResponse([{ callId: 'state-call-1', name: 'ag_ui_update_state', args: { state_updates: { tone: 'calm' } } }]),
      textResponse('State applied.'),
    ])
    harness.ctx.tools.register(PLAIN_TOOL)
    const agent = new HttpAgent({ url: harness.url, headers: HEADERS, threadId: 'view-excluded' })
    agent.setState({ tone: 'draft' })
    agent.addMessage({ id: 'excluded-user-1', role: 'user', content: 'Do the work.' })
    const first = await runAgentEvents(agent, 'view-mixed-1', [RELAY_TOOL])

    const customs = toolViewEnvelopes(first)
    expect(customs.map(event => (event.value as { toolName: string }).toolName)).toEqual(['plain_tool', 'plain_tool'])
    expect(customs[0].value).toMatchObject({ phase: 'call', card: { card: 'generic', title: 'plain_tool', rawInput: { note: 'x' } } })
    expect(customs[1].value).toMatchObject({ phase: 'result', card: { card: 'generic' } })
    // the frontend and state tools still stream their standard events, without cards
    expect(first.some(event => event.type === EventType.TOOL_CALL_START
      && event.toolCallId === 'relay-call-1')).toBe(true)
    expect(first.at(-1)).toMatchObject({ type: EventType.RUN_FINISHED })

    agent.addMessage({
      id: 'relay-result-1',
      role: 'tool',
      toolCallId: 'relay-call-1',
      content: JSON.stringify({ status: 'relayed' }),
    })
    const second = await runAgentEvents(agent, 'view-mixed-2', [RELAY_TOOL])
    // the cold read re-derives only the plain backend card; the state tool stays cardless
    expect(toolViewEnvelopes(second).map(event => (event.value as { toolName: string }).toolName)).toEqual(['plain_tool'])
    expect(second.some(event => event.type === EventType.STATE_SNAPSHOT)).toBe(true)
    await expectLifecycleValid(second)
  })
})

describe('tool view cards survive a durable restart', () => {
  const OPTIONS = {
    provider: 'scripted',
    model: 'scripted',
    frontendToolTimeoutMs: 10_000,
    threadIdleMs: 60_000,
    maxRunEvents: 128,
    maxRunEventBytes: 128 * 1024,
    maxRunsPerThread: 4,
    maxStateBytes: 64 * 1024,
  } satisfies Omit<ThreadOptions, 'workspaceRoot'>

  it('re-derives the identical settled card in a resumed process', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ag-ui-view-'))
    roots.push(root)
    const principal = { tenantId: 'tool-view-tenant', userId: 'operator-1' }
    const sessionId = durableSessionId(principal, 'view-resume', SECRET)

    const first = new Context()
    contexts.push(first)
    await mountTestAgentCore(first)
    first.tools.register(VIEW_TOOL)
    first.llm.registerAdapter(['scripted'], new ScriptedAdapter([
      toolCallsResponse([{ callId: 'view-call-1', name: 'view_probe', args: { subject: 'durable' } }]),
      textResponse('Durable probe done.'),
    ]))
    await first.plugin(JsonlSessionPersistence, { root, compression: 'none' })
    const options = { ...OPTIONS, workspaceRoot: join(root, 'workspaces') }
    const original = new ThreadBinding(first, principal, 'view-resume', sessionId, options, () => {})
    await original.initialize()
    const runOne = original.reserveRun({
      threadId: 'view-resume',
      runId: 'view-resume-run-1',
      messages: [{ id: 'view-resume-user-1', role: 'user', content: 'Probe durably.' }],
      tools: [],
      context: [],
      state: {},
      forwardedProps: {},
    }, 'digest-view-resume-1')
    original.drive(runOne)
    await runOne.done
    const liveResult = runOne.record.events.filter((event): event is CustomEvent => event.type === EventType.CUSTOM)
    expect(liveResult).toHaveLength(2)
    await original.dispose()
    await new Promise(resolve => setTimeout(resolve, 300))
    await first.fiber.dispose()
    contexts.splice(contexts.indexOf(first), 1)

    const second = new Context()
    contexts.push(second)
    await mountTestAgentCore(second)
    second.tools.register(VIEW_TOOL)
    second.llm.registerAdapter(['scripted'], new ScriptedAdapter([textResponse('Resumed answer.')]))
    await second.plugin(JsonlSessionPersistence, { root, compression: 'none' })
    const resumed = new ThreadBinding(second, principal, 'view-resume', sessionId, options, () => {})
    await resumed.initialize()
    const runTwo = resumed.reserveRun({
      threadId: 'view-resume',
      runId: 'view-resume-run-2',
      messages: [
        { id: 'view-resume-user-1', role: 'user', content: 'Probe durably.' },
        { id: 'view-resume-user-2', role: 'user', content: 'Continue.' },
      ],
      tools: [],
      context: [],
      state: {},
      forwardedProps: {},
    }, 'digest-view-resume-2')
    resumed.drive(runTwo)
    await runTwo.done
    const cold = runTwo.record.events.filter((event): event is CustomEvent => event.type === EventType.CUSTOM)
    expect(cold).toHaveLength(1)
    // the resumed process derived the identical settled card from the durable log
    expect(cold[0].value).toEqual(liveResult[1].value)
    expect(cold[0].value).toMatchObject({ callId: 'view-call-1', phase: 'result' })
  })
})
