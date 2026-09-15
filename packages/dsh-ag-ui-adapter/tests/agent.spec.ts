import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomUUID, RunAgentInputSchema, type RunAgentInput } from '@ag-ui/client'
import { DshAgent } from '../src/agent.ts'
import { MODEL_ENV, PROVIDER_ENV } from '../src/config.ts'
import { AGENT_CORE_ROWS, SCRIPTED_MODEL_ROW } from './rows.ts'

/**
 * The keyless scripted agentic-chat scenario, end to end through the adapter:
 * a spawned micro-host, the official client pipeline, and session memory
 * across runs inside the child.
 */

const agents: DshAgent[] = []

afterEach(async () => {
  await Promise.all(agents.splice(0).map(agent => agent.stop()))
})

function scriptedAgent(): DshAgent {
  const agent = new DshAgent({
    threadId: 'adapter-thread',
    gateway: { provider: 'scripted', model: 'scripted' },
    plugins: [...AGENT_CORE_ROWS, SCRIPTED_MODEL_ROW],
  })
  agents.push(agent)
  return agent
}

function ask(agent: DshAgent, content: string): Promise<void> {
  agent.addMessage({ id: randomUUID(), role: 'user', content })
  return agent.runAgent({ runId: randomUUID(), tools: [], context: [], forwardedProps: {} }).then(() => {})
}

function assistantText(agent: DshAgent): string | undefined {
  return agent.messages.findLast(message => message.role === 'assistant' && typeof message.content === 'string')?.content as string | undefined
}

class InspectableDshAgent extends DshAgent {
  requestBody(input: RunAgentInput): RunAgentInput {
    return RunAgentInputSchema.parse(JSON.parse(String(this.requestInit(input).body)))
  }
}

describe('DshAgent', () => {
  it('omits presentation messages while retaining all user input', () => {
    const agent = new InspectableDshAgent({
      threadId: 'adapter-thread',
      gateway: { provider: 'scripted', model: 'scripted' },
    })
    const nextUser = { id: 'next-user', role: 'user' as const, content: 'next' }
    const input: RunAgentInput = {
      threadId: 'adapter-thread',
      runId: 'adapter-run',
      messages: [
        { id: 'old-user', role: 'user', content: 'x'.repeat(300_000) },
        { id: 'settled-assistant', role: 'assistant', content: 'settled' },
        nextUser,
      ],
      tools: [],
      context: [],
      state: {},
      forwardedProps: {},
    }

    expect(agent.requestBody(input).messages).toEqual([input.messages[0], nextUser])
    expect(input.messages).toHaveLength(3)
  })

  it('streams a keyless scripted agentic chat with session memory through the spawned micro-host', async () => {
    const agent = scriptedAgent()
    await agent.start()

    expect(agent.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/ag-ui$/)
    // starting again is a no-op on the same host
    await agent.start()
    expect(agent.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/ag-ui$/)

    await ask(agent, 'My name is Ada.')
    expect(assistantText(agent)).toBe('Hello Ada.')

    // a second run answers from the durable session inside the same child
    await ask(agent, 'What is my name?')
    expect(assistantText(agent)).toBe('Your name is Ada.')

    // an aborted run leaves the agent usable for the next one, with a caller-owned abort signal
    agent.abortRun()
    agent.addMessage({ id: randomUUID(), role: 'user', content: 'Hello again.' })
    await agent.runAgent({
      runId: randomUUID(),
      tools: [],
      context: [],
      forwardedProps: {},
      abortController: new AbortController(),
    })
    expect(assistantText(agent)).toBe('Hello from the DSH AG-UI adapter.')

    await agent.stop()
  })

  it('refuses to expose a URL before the micro-host has started, but starts lazily on the first run', async () => {
    // a bare config exercises the optional constructor fields at their defaults
    const agent = new DshAgent({
      threadId: 'adapter-thread',
      gateway: { provider: 'scripted', model: 'scripted' },
      readyTimeoutMs: 500,
    })
    agents.push(agent)
    expect(() => agent.url).toThrow('has not started')
    // the first run spawns the micro-host on demand; the bare config without
    // plugins can never activate it, so the run rejects with the start failure
    await expect(ask(agent, 'hello')).rejects.toThrow('did not become ready in time')
    await expect(agent.stop()).resolves.toBeUndefined()
    expect(() => agent.url).toThrow('has not started')
  })

  it('starts lazily on the first run and keeps the explicit start as a pre-warm', async () => {
    const agent = scriptedAgent()
    expect(() => agent.url).toThrow('has not started')
    await ask(agent, 'Hello again.')
    expect(assistantText(agent)).toBe('Hello from the DSH AG-UI adapter.')
    expect(agent.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/ag-ui$/)
    await agent.stop()
  })

  it('configures the gateway from environment variables', async () => {
    const saved = { [PROVIDER_ENV]: process.env[PROVIDER_ENV], [MODEL_ENV]: process.env[MODEL_ENV] }
    process.env[PROVIDER_ENV] = 'scripted'
    process.env[MODEL_ENV] = 'scripted'
    try {
      const agent = new DshAgent({ threadId: 'adapter-thread', plugins: [...AGENT_CORE_ROWS, SCRIPTED_MODEL_ROW] })
      agents.push(agent)
      await ask(agent, 'Hello again.')
      expect(assistantText(agent)).toBe('Hello from the DSH AG-UI adapter.')
      await agent.stop()
    } finally {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) {
          delete process.env[name]
        } else {
          process.env[name] = value
        }
      }
    }
  })

  it('shuts the host down after an idle window and spawns a fresh one on the next run', async () => {
    const agent = new DshAgent({
      threadId: 'adapter-thread',
      gateway: { provider: 'scripted', model: 'scripted' },
      plugins: [...AGENT_CORE_ROWS, SCRIPTED_MODEL_ROW],
      idleShutdownMs: 150,
    })
    agents.push(agent)
    await ask(agent, 'My name is Ada.')
    expect(assistantText(agent)).toBe('Hello Ada.')
    await vi.waitFor(() => {
      expect(() => agent.url).toThrow('has not started')
    })
    // The replacement child is empty, but the client resends its complete transcript.
    await ask(agent, 'What is my name?')
    expect(assistantText(agent)).toBe('Your name is Ada.')
    await agent.stop()
  })

  it('disposes through Symbol.asyncDispose', async () => {
    const agent = scriptedAgent()
    await agent.start()
    const url = agent.url
    await agent[Symbol.asyncDispose]()
    expect(() => agent.url).toThrow('has not started')
    await expect(fetch(url, { method: 'POST' })).rejects.toThrow()
  })

  it('cleans up after a failed start and stops cleanly', async () => {
    const agent = new DshAgent({
      threadId: 'adapter-thread',
      // without the Agent core the gateway never activates, so readiness times out
      gateway: { provider: 'scripted', model: 'scripted' },
      plugins: [SCRIPTED_MODEL_ROW],
      readyTimeoutMs: 500,
      env: { DSH_AG_UI_ADAPTER_PROBE: 'fixture' },
    })
    agents.push(agent)
    await expect(agent.start()).rejects.toThrow('did not become ready in time')
    await expect(agent.stop()).resolves.toBeUndefined()
    expect(() => agent.url).toThrow('has not started')
  })

  it('stops cleanly while a failing start is still pending', async () => {
    const agent = new DshAgent({
      threadId: 'adapter-thread',
      gateway: { provider: 'scripted', model: 'scripted' },
      plugins: [SCRIPTED_MODEL_ROW],
      readyTimeoutMs: 500,
    })
    agents.push(agent)
    const starting = agent.start()
    const stopping = agent.stop()
    await expect(starting).rejects.toThrow('did not become ready in time')
    await expect(stopping).resolves.toBeUndefined()
    expect(() => agent.url).toThrow('has not started')
  })
})
