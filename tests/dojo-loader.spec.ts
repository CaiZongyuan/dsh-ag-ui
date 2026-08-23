import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { once } from 'node:events'
import { request as httpRequest } from 'node:http'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { HttpAgent, type Message, type Tool, type ToolCall } from '@ag-ui/client'
import { EventType, type BaseEvent } from '@ag-ui/core'

const exampleStart = fileURLToPath(new URL('../examples/dojo/start.mjs', import.meta.url))
const children: ChildProcessWithoutNullStreams[] = []

const TASK_TOOL: Tool = {
  name: 'generate_task_steps',
  description: 'Render task steps for user review and approval.',
  parameters: {
    type: 'object',
    properties: {
      steps: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            description: { type: 'string' },
            status: { type: 'string', enum: ['enabled', 'disabled'] },
          },
          required: ['description', 'status'],
          additionalProperties: false,
        },
      },
    },
    required: ['steps'],
    additionalProperties: false,
  },
}

interface TaskArgs {
  steps: Array<{ description: string; status: string }>
}

interface HaikuArgs {
  japanese: string[]
  english: string[]
  image: string
  gradient: string
}

const HAIKU_TOOL: Tool = {
  name: 'generate_haiku',
  description: 'Render a structured bilingual haiku card.',
  parameters: {
    type: 'object',
    properties: {
      japanese: { type: 'array', items: { type: 'string' } },
      english: { type: 'array', items: { type: 'string' } },
      image: { type: 'string' },
      gradient: { type: 'string' },
    },
    required: ['japanese', 'english', 'image', 'gradient'],
    additionalProperties: false,
  },
}

afterEach(() => {
  for (const child of children.splice(0)) child.kill('SIGKILL')
})

describe('Dojo-compatible feature suite', () => {
  it('serves all five features through the built Gateway', async () => {
    const port = await reservePort()
    const child = spawn(process.execPath, [exampleStart], {
      env: {
        ...process.env,
        HOST: '0.0.0.0',
        PORT: String(port),
        DSH_AG_UI_DOJO_DEBUG: '1',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    children.push(child)
    child.stdin.end()
    const stderr: string[] = []
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => { stderr.push(chunk) })
    const base = `http://127.0.0.1:${String(port)}`

    await waitForServer(`${base}/health`, child, stderr)
    const health = await fetch(`${base}/health`).then(response => response.json()) as { agents: string[] }
    expect(health.agents).toEqual([
      'agentic_chat',
      'backend_tool_rendering',
      'shared_state',
      'human_in_the_loop',
      'tool_based_generative_ui',
    ])
    expect((await fetch(`${base}/agentic_chat`, { method: 'OPTIONS' })).status).toBe(204)
    expect((await fetch(`${base}/_internal/ag-ui`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })).status).toBe(401)
    expect((await fetch(`${base}/_internal/ag-ui`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer dojo-local-only-shared-secret',
        'content-type': 'application/json',
      },
      body: '{}',
    })).status).toBe(401)

    await verifyAgenticChat(base)
    await verifyConcurrentChat(base)
    await verifyDisconnectCancellation(base)
    await verifyBackendTool(base)
    await verifySharedState(base)
    await verifyHumanInTheLoop(base)
    await verifyGenerativeUi(base)

    const debug = await fetch(`${base}/debug/state`).then(response => response.json()) as {
      bffRuns: Record<string, number>
      modelRequests: Record<string, number>
      backendToolCalls: Array<{ feature: string; threadId: string; args: { location: string } }>
      abortedRequests: Record<string, number>
    }
    expect(debug.bffRuns).toMatchObject({
      agentic_chat: 5,
      backend_tool_rendering: 1,
      shared_state: 2,
      human_in_the_loop: 2,
      tool_based_generative_ui: 2,
    })
    expect(debug.modelRequests).toMatchObject({
      agentic_chat: 5,
      backend_tool_rendering: 2,
      shared_state: 3,
      human_in_the_loop: 2,
      tool_based_generative_ui: 2,
    })
    expect(debug.abortedRequests).toEqual({ agentic_chat: 1 })
    expect(debug.backendToolCalls).toEqual([expect.objectContaining({
      feature: 'backend_tool_rendering',
      threadId: 'dojo-weather',
      args: { location: 'San Francisco' },
    })])

    children.splice(children.indexOf(child), 1)
    expect((await fetch(`${base}/debug/shutdown`, { method: 'POST' })).status).toBe(202)
    const [code, signal] = await once(child, 'exit') as [number | null, NodeJS.Signals | null]
    expect({ code, signal }).toEqual({ code: 0, signal: null })
  }, 60_000)
})

async function verifyAgenticChat(base: string): Promise<void> {
  const agent = new HttpAgent({ url: `${base}/agentic_chat`, threadId: 'dojo-chat' })
  await ask(agent, 'chat-user-1', 'chat-run-1', 'Hi, my name is Alex.', [])
  expect(lastAssistantText(agent.messages)).toContain('Alex')
  await ask(agent, 'chat-user-2', 'chat-run-2', 'What is my name?', [])
  expect(lastAssistantText(agent.messages)).toBe('Your name is Alex.')
}

async function verifyConcurrentChat(base: string): Promise<void> {
  const first = new HttpAgent({ url: `${base}/agentic_chat`, threadId: 'dojo-chat-concurrent-1' })
  const second = new HttpAgent({ url: `${base}/agentic_chat`, threadId: 'dojo-chat-concurrent-2' })
  await Promise.all([
    ask(first, 'concurrent-user-1', 'concurrent-run-1', 'Hello from thread one.', []),
    ask(second, 'concurrent-user-2', 'concurrent-run-2', 'Hello from thread two.', []),
  ])
  expect(lastAssistantText(first.messages)).toContain('Hello from the DSH AG-UI Dojo example.')
  expect(lastAssistantText(second.messages)).toContain('Hello from the DSH AG-UI Dojo example.')
}

async function verifyDisconnectCancellation(base: string): Promise<void> {
  const body = JSON.stringify({
    threadId: 'dojo-disconnect',
    runId: 'dojo-disconnect-run',
    messages: [{ id: 'dojo-disconnect-user', role: 'user', content: 'Wait for disconnect.' }],
    tools: [],
    context: [],
    state: {},
    forwardedProps: {},
  })
  await new Promise<void>((resolve, reject) => {
    const request = httpRequest(`${base}/agentic_chat`, {
      method: 'POST',
      headers: {
        'content-length': Buffer.byteLength(body),
        'content-type': 'application/json',
      },
    })
    request.once('error', (error) => {
      if ((error as NodeJS.ErrnoException).code === 'ECONNRESET') resolve()
      else reject(error)
    })
    request.once('response', (response) => {
      response.once('data', () => {
        response.destroy()
        resolve()
      })
    })
    request.end(body)
  })

  for (let attempt = 0; attempt < 100; attempt += 1) {
    const debug = await fetch(`${base}/debug/state`).then(response => response.json()) as {
      abortedRequests: Record<string, number>
    }
    if (debug.abortedRequests.agentic_chat === 1) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error('The disconnected Dojo request did not cancel the DSH model stream.')
}

async function verifyBackendTool(base: string): Promise<void> {
  const agent = new HttpAgent({ url: `${base}/backend_tool_rendering`, threadId: 'dojo-weather' })
  const events = await ask(agent, 'weather-user', 'weather-run', 'What is the weather?', [])
  expect(events.some(event => event.type === EventType.TOOL_CALL_RESULT)).toBe(true)
  const result = agent.messages.find(message => message.role === 'tool')
  expect(result?.role === 'tool' ? JSON.parse(result.content) : undefined).toMatchObject({
    temperature: 20,
    conditions: 'sunny',
  })
}

async function verifySharedState(base: string): Promise<void> {
  const agent = new HttpAgent({ url: `${base}/shared_state`, threadId: 'dojo-state' })
  agent.setState({})
  await ask(agent, 'state-user-1', 'state-run-1', 'Create an Italian pasta recipe.', [])
  const state = agent.state as { recipe: { ingredients: Array<{ name: string }> } }
  expect(state.recipe.ingredients.map(item => item.name)).toContain('Pasta')

  agent.setState({
    ...state,
    recipe: {
      ...state.recipe,
      ingredients: [...state.recipe.ingredients, { icon: '🥔', name: 'Potatoes', amount: '2' }],
    },
  })
  await ask(agent, 'state-user-2', 'state-run-2', 'Give me all the ingredients.', [])
  expect(lastAssistantText(agent.messages)).toContain('Potatoes')
}

async function verifyHumanInTheLoop(base: string): Promise<void> {
  const agent = new HttpAgent({ url: `${base}/human_in_the_loop`, threadId: 'dojo-hitl' })
  await ask(agent, 'hitl-user', 'hitl-run-1', 'Plan how to bake brownies.', [TASK_TOOL])
  const call = pendingTool(agent.messages, TASK_TOOL.name)
  expect(call?.function.name).toBe(TASK_TOOL.name)
  const args = readArgs<TaskArgs>(call)
  expect(args.steps).toEqual(expect.arrayContaining([
    expect.objectContaining({ description: expect.stringContaining('eggs') }),
    expect.objectContaining({ description: expect.stringContaining('oven') }),
  ]))
  expect(lastAssistantText(agent.messages)).toBeUndefined()

  agent.addMessage({
    id: 'hitl-result',
    role: 'tool',
    toolCallId: call?.id ?? 'missing-call',
    content: JSON.stringify({ accepted: true, steps: args.steps }),
  })
  await run(agent, 'hitl-run-2', [TASK_TOOL])
  expect(lastAssistantText(agent.messages)).toBe('The approved task plan is ready.')
}

async function verifyGenerativeUi(base: string): Promise<void> {
  const agent = new HttpAgent({ url: `${base}/tool_based_generative_ui`, threadId: 'dojo-generative' })
  await ask(agent, 'haiku-user', 'haiku-run-1', 'Generate a spring haiku.', [HAIKU_TOOL])
  const call = pendingTool(agent.messages, HAIKU_TOOL.name)
  const args = readArgs<HaikuArgs>(call)
  expect(args.japanese).toHaveLength(3)
  expect(args.english).toHaveLength(3)
  expect(args.gradient).toMatch(/^linear-gradient/)

  agent.addMessage({
    id: 'haiku-result',
    role: 'tool',
    toolCallId: call?.id ?? 'missing-call',
    content: 'Haiku generated!',
  })
  await run(agent, 'haiku-run-2', [HAIKU_TOOL])
  expect(lastAssistantText(agent.messages)).toBe('The haiku card is ready.')
}

async function ask(
  agent: HttpAgent,
  messageId: string,
  runId: string,
  content: string,
  tools: Tool[],
): Promise<BaseEvent[]> {
  agent.addMessage({ id: messageId, role: 'user', content })
  return run(agent, runId, tools)
}

async function run(agent: HttpAgent, runId: string, tools: Tool[]): Promise<BaseEvent[]> {
  const events: BaseEvent[] = []
  await agent.runAgent({ runId, tools, context: [], forwardedProps: {} }, {
    onEvent: ({ event }) => { events.push(event) },
  })
  return events
}

function pendingTool(messages: Message[], name: string): ToolCall | undefined {
  const results = new Set(messages
    .filter((message): message is Extract<Message, { role: 'tool' }> => message.role === 'tool')
    .map(message => message.toolCallId))
  return messages.flatMap(message => message.role === 'assistant' ? message.toolCalls ?? [] : [])
    .find(call => call.function.name === name && !results.has(call.id))
}

function readArgs<T>(call: ToolCall | undefined): T {
  if (call === undefined) throw new Error('The expected frontend Tool call is missing.')
  return JSON.parse(call.function.arguments) as T
}

function lastAssistantText(messages: Message[]): string | undefined {
  return messages.findLast(message => message.role === 'assistant' && typeof message.content === 'string')?.content as string | undefined
}

async function reservePort(): Promise<number> {
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

async function waitForServer(url: string, child: ChildProcessWithoutNullStreams, stderr: string[]): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Dojo example exited ${String(child.exitCode)}: ${stderr.join('')}`)
    try {
      const response = await fetch(url)
      if (response.ok) return
    } catch {
      // Connection refusal means the real WebServer has not bound yet.
    }
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`Dojo example did not become ready: ${stderr.join('')}`)
}
