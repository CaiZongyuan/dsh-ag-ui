import { request as httpRequest, type Server } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RunAgentInput, Tool } from '@ag-ui/core'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { ScriptedAdapter, type ScriptedResponse, textResponse } from './scripted-adapter.ts'
import { mountTestAgentCore } from './agent-core.ts'
import AgUiGateway, { type Config } from 'dsh-ag-ui'
import { SessionId } from '@deepseek-ai/dsh-session'
import { ThreadBinding } from '../src/thread.ts'

const SECRET = 'test-only-ag-ui-shared-secret'
const HEADERS = {
  authorization: `Bearer ${SECRET}`,
  'x-dsh-tenant-id': 'tenant-1',
  'x-dsh-user-id': 'user-1',
}

const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
})

async function mount(
  overrides: Partial<Config> = {},
  script: ScriptedResponse[] = [textResponse('ok')],
  host: '127.0.0.1' | '0.0.0.0' = '127.0.0.1',
) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(WebServer, { host, port: 0 })
  await mountTestAgentCore(ctx)
  ctx.llm.registerAdapter(['scripted'], new ScriptedAdapter(script))
  const gateway = await ctx.plugin(AgUiGateway, {
    provider: 'scripted',
    model: 'scripted',
    sharedSecret: SECRET,
    maxRunEvents: 128,
    maxRunEventBytes: 128 * 1024,
    frontendToolTimeoutMs: 10_000,
    threadIdleMs: 60_000,
    ...overrides,
  })
  return { ctx, gateway, url: `http://127.0.0.1:${String(ctx.webServer.port)}${overrides.path ?? '/ag-ui'}` }
}

function input(overrides: Partial<RunAgentInput> = {}): RunAgentInput {
  return {
    threadId: 'thread-1',
    runId: 'run-1',
    messages: [{ id: 'message-1', role: 'user', content: 'hello' }],
    tools: [],
    context: [],
    state: {},
    forwardedProps: {},
    ...overrides,
  }
}

async function request(url: string, options: RequestInit = {}): Promise<{ status: number; body: string; headers: Headers }> {
  const response = await fetch(url, options)
  return { status: response.status, body: await response.text(), headers: response.headers }
}

async function postChunked(url: string, chunks: string[]): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, {
      method: 'POST',
      headers: { ...HEADERS, 'content-type': 'application/json', 'transfer-encoding': 'chunked' },
    }, (response) => {
      const body: Buffer[] = []
      response.on('data', (chunk: Buffer) => { body.push(chunk) })
      response.on('end', () => { resolve({ status: response.statusCode ?? 0, body: Buffer.concat(body).toString() }) })
    })
    request.on('error', reject)
    for (const chunk of chunks) request.write(chunk)
    request.end()
  })
}

async function post(url: string, value: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  const result = await request(url, {
    method: 'POST',
    headers: { ...HEADERS, 'content-type': 'application/json', ...headers },
    body: typeof value === 'string' ? value : JSON.stringify(value),
  })
  return result
}

/** Start one run over a raw socket so a test can order requests, observe the run start, and drop the client. */
function postStreaming(url: string, value: RunAgentInput) {
  const started = Promise.withResolvers<void>()
  const { promise, resolve, reject } = Promise.withResolvers<{ status: number; body: string }>()
  promise.catch(() => {})
  const request = httpRequest(url, {
    method: 'POST',
    headers: { ...HEADERS, 'content-type': 'application/json' },
  }, (response) => {
    started.resolve()
    const body: Buffer[] = []
    response.on('data', (chunk: Buffer) => { body.push(chunk) })
    response.on('end', () => { resolve({ status: response.statusCode ?? 0, body: Buffer.concat(body).toString() }) })
  })
  request.on('error', reject)
  request.end(JSON.stringify(value))
  return { started: started.promise, result: () => promise, abort: () => { request.destroy() } }
}

function secondRun(): RunAgentInput {
  return input({ runId: 'run-2', messages: [{ id: 'message-2', role: 'user', content: 'second' }] })
}

function expectCode(result: { status: number; body: string }, status: number, code: string): void {
  expect(result.status).toBe(status)
  expect(JSON.parse(result.body)).toMatchObject({ code })
}

const TOOL: Tool = {
  name: 'ui_test',
  description: 'Test Tool.',
  parameters: { type: 'object', properties: {} },
}

describe('AG-UI configuration', () => {
  it.each([
    [{ path: 'relative' }, 'path must be an absolute'],
    [{ path: '/' }, 'path must be an absolute'],
    [{ path: '/trailing/' }, 'path must be an absolute'],
    [{ tenantHeader: 'X-Tenant' }, 'identity header names'],
    [{ userHeader: 'bad_header' }, 'identity header names'],
    [{ sharedSecret: 'short' }, 'at least 16 UTF-8 bytes'],
    [{ maxThreads: 0 }, 'maxThreads must be positive'],
    [{ threadIdleMs: 0 }, 'threadIdleMs must be positive'],
    [{ maxRunEvents: 1 }, 'maxRunEvents must retain opening and terminal events'],
    [{ maxRunEventBytes: 1 }, 'maxRunEventBytes cannot retain mandatory opening and terminal events'],
  ] as const)('rejects invalid configuration %#', async (overrides, message) => {
    await expect(mount(overrides)).rejects.toThrow(message)
  })

  it('requires explicit permission for a non-loopback bind', async () => {
    await expect(mount({}, [textResponse('unused')], '0.0.0.0')).rejects.toThrow('non-loopback WebServer bind')
    const allowed = await mount({ allowNonLoopback: true }, [textResponse('ok')], '0.0.0.0')
    expect(allowed.ctx.webServer.host).toBe('0.0.0.0')
  })
})

describe('AG-UI HTTP validation', () => {
  it('rejects non-POST methods with Allow', async () => {
    const { url } = await mount()
    const result = await request(url, { method: 'GET' })
    expectCode(result, 405, 'METHOD_NOT_ALLOWED')
    expect(result.headers.get('allow')).toBe('POST')
  })

  it('requires application/json and accepts a parameterized media type', async () => {
    const { url } = await mount({}, [textResponse('ok')])
    expectCode(await request(url, { method: 'POST', headers: HEADERS, body: '{}' }), 415, 'UNSUPPORTED_MEDIA_TYPE')
    const accepted = await post(url, input(), { 'content-type': ' Application/JSON ; charset=utf-8' })
    expect(accepted.status).toBe(200)
  })

  it('rejects declared and streamed bodies over the byte bound', async () => {
    const first = await mount({ maxRequestBytes: 10 })
    expectCode(await request(first.url, {
      method: 'POST',
      headers: { ...HEADERS, 'content-type': 'application/json', 'content-length': '11' },
      body: '12345678901',
    }), 413, 'REQUEST_TOO_LARGE')

    const second = await mount({ maxRequestBytes: 10 })
    expectCode(await postChunked(second.url, ['12345', '678901']), 413, 'REQUEST_TOO_LARGE')
  })

  it('rejects malformed JSON and schema-invalid input', async () => {
    const { url } = await mount()
    expectCode(await post(url, '{'), 400, 'INVALID_AGUI_INPUT')
    expectCode(await post(url, {}), 400, 'INVALID_AGUI_INPUT')
  })

  it('rejects invalid credentials and scalar identity headers', async () => {
    const { url } = await mount()
    expectCode(await post(url, input(), { authorization: 'Bearer wrong' }), 401, 'UNAUTHORIZED')
    expectCode(await post(url, input(), { 'x-dsh-tenant-id': 'bad id' }), 400, 'INVALID_IDENTITY')
    expectCode(await post(url, input(), { 'x-dsh-user-id': '' }), 400, 'INVALID_IDENTITY')
  })

  it('rejects thread, run, and parent identities by syntax or UTF-8 bytes', async () => {
    const { url } = await mount({ maxIdentityBytes: 4 })
    expectCode(await post(url, input({ threadId: 'abcde' })), 400, 'INVALID_IDENTITY')
    expectCode(await post(url, input({ runId: '-bad' })), 400, 'INVALID_IDENTITY')
    expectCode(await post(url, input({ parentRunId: 'abcde' })), 400, 'INVALID_IDENTITY')
  })

  it.each([
    ['messages by count', { maxMessages: 1 }, input({ messages: [
      { id: 'm1', role: 'user', content: 'one' },
      { id: 'm2', role: 'user', content: 'two' },
    ] }), 'MESSAGE_LIMIT_EXCEEDED'],
    ['messages by bytes', { maxMessageBytes: 1 }, input(), 'MESSAGE_LIMIT_EXCEEDED'],
    ['context by count', { maxContexts: 1 }, input({ context: [
      { description: 'one', value: '1' },
      { description: 'two', value: '2' },
    ] }), 'CONTEXT_LIMIT_EXCEEDED'],
    ['context by bytes', { maxContextBytes: 1 }, input({ context: [{ description: 'one', value: '1' }] }), 'CONTEXT_LIMIT_EXCEEDED'],
    ['tools by count', { maxTools: 1 }, input({ tools: [TOOL, { ...TOOL, name: 'ui_other' }] }), 'TOOL_LIMIT_EXCEEDED'],
    ['tools by bytes', { maxToolBytes: 1 }, input({ tools: [TOOL] }), 'TOOL_LIMIT_EXCEEDED'],
    ['forwarded props', { maxForwardedPropsBytes: 1 }, input({ forwardedProps: { value: 'large' } }), 'FORWARDED_PROPS_LIMIT_EXCEEDED'],
    ['state', { maxStateBytes: 1 }, input({ state: { value: 'large' } }), 'STATE_LIMIT_EXCEEDED'],
  ] as const)('applies the %s limit', async (_name, config, value, code) => {
    const { url } = await mount(config)
    expectCode(await post(url, value), 413, code)
  })

  it('measures the complete shared-state baseline in UTF-8 bytes', async () => {
    const state = { value: 'é' }
    const bytes = Buffer.byteLength(JSON.stringify(state))
    const exact = await mount({ maxStateBytes: bytes })
    expect((await post(exact.url, input({ state }))).status).toBe(200)
    const oversized = await mount({ maxStateBytes: bytes - 1 })
    expectCode(await post(oversized.url, input({ state })), 413, 'STATE_LIMIT_EXCEEDED')
  })

  it('rejects empty context and Tool descriptions and deep Tool schemas', async () => {
    const { url } = await mount({ maxToolSchemaDepth: 2 })
    expectCode(await post(url, input({ context: [{ description: ' ', value: 'x' }] })), 400, 'INVALID_CONTEXT')
    expectCode(await post(url, input({ tools: [{ ...TOOL, description: ' ' }] })), 400, 'INVALID_FRONTEND_TOOL')
    expectCode(await post(url, input({ tools: [{ ...TOOL, parameters: { type: 'object', properties: { nested: { type: 'object', properties: {} } } } }] })), 413, 'TOOL_SCHEMA_TOO_DEEP')
  })
})

describe('AG-UI gateway lifecycle', () => {
  it('projects a valid parent run id into the started event', async () => {
    const { url } = await mount()
    const result = await post(url, input({ parentRunId: 'parent-1' }))
    expect(result.status).toBe(200)
    expect(result.body).toContain('"parentRunId":"parent-1"')
  })

  it('serves the runs of one thread in arrival order', async () => {
    const gate = Promise.withResolvers<StreamChunk[]>()
    const { ctx, url } = await mount({}, [gate.promise, textResponse('second-reply')])
    const debug = vi.spyOn(ctx.logger, 'debug')
    const first = postStreaming(url, input())
    await first.started
    const second = post(url, secondRun())
    await vi.waitFor(() => { expect(debug).toHaveBeenCalledWith(expect.stringContaining('run-2 waits for the active run')) })
    gate.resolve(textResponse('first-reply'))
    const results = await Promise.all([first.result(), second])
    expect(results.map(result => result.status)).toEqual([200, 200])
    expect(results[0].body).toContain('first-reply')
    // the queued run opened after the first reply was durable, so its snapshot already carries it
    expect(results[1].body).toContain('first-reply')
    expect(results[1].body).toContain('second-reply')
    expect(ctx.agents.list()).toHaveLength(1)
  })

  it('admits several queued runs of one thread without one losing the reservation', async () => {
    const gate = Promise.withResolvers<StreamChunk[]>()
    const { ctx, url } = await mount({}, [gate.promise, textResponse('second-reply'), textResponse('third-reply')])
    const debug = vi.spyOn(ctx.logger, 'debug')
    const first = postStreaming(url, input())
    await first.started
    const second = post(url, secondRun())
    const third = post(url, input({ runId: 'run-3', messages: [{ id: 'message-3', role: 'user', content: 'third' }] }))
    await vi.waitFor(() => {
      expect(debug).toHaveBeenCalledWith(expect.stringContaining('run-2 waits for the active run'))
      expect(debug).toHaveBeenCalledWith(expect.stringContaining('run-3 waits for the active run'))
    })
    gate.resolve(textResponse('first-reply'))
    const results = await Promise.all([first.result(), second, third])
    expect(results.map(result => result.status)).toEqual([200, 200, 200])
    expect(results[2].body).toContain('third-reply')
  })

  it('replays identical requests that waited behind another run', async () => {
    const gate = Promise.withResolvers<StreamChunk[]>()
    const { ctx, url } = await mount({}, [gate.promise, textResponse('second-reply')])
    const debug = vi.spyOn(ctx.logger, 'debug')
    const first = postStreaming(url, input())
    await first.started
    const second = post(url, secondRun())
    const duplicate = post(url, secondRun())
    await vi.waitFor(() => {
      expect(debug.mock.calls.filter(([message]) => String(message).includes('run-2 waits for the active run'))).toHaveLength(2)
    })
    gate.resolve(textResponse('first-reply'))
    await first.result()
    const [original, replay] = await Promise.all([second, duplicate])
    expect(original.status).toBe(200)
    expect(replay).toEqual(original)
    expectCode(await post(url, { ...secondRun(), state: { changed: true } }), 409, 'RUN_ID_CONFLICT')
  })

  it('bounds queued requests and releases a queue slot on disconnect', async () => {
    const gate = Promise.withResolvers<StreamChunk[]>()
    const { ctx, url } = await mount({ maxRunsPerThread: 1 }, [gate.promise, textResponse('replacement')])
    const debug = vi.spyOn(ctx.logger, 'debug')
    const first = postStreaming(url, input())
    await first.started
    const waiting = postStreaming(url, secondRun())
    await vi.waitFor(() => { expect(debug).toHaveBeenCalledWith(expect.stringContaining('run-2 waits for the active run')) })
    let overflow: { status: number; body: string } | undefined
    const rejected = post(url, input({ runId: 'overflow', messages: [{ id: 'overflow-user', role: 'user', content: 'overflow' }] })).then(result => { overflow = result })
    try {
      await vi.waitFor(() => { expect(overflow).toBeDefined() })
      expectCode(overflow!, 429, 'RUN_QUEUE_FULL')
      waiting.abort()
      await vi.waitFor(() => { expect(debug).toHaveBeenCalledWith(expect.stringContaining('run-2 left the queue')) })
      const replacement = post(url, input({ runId: 'replacement', messages: [{ id: 'replacement-user', role: 'user', content: 'replacement' }] }))
      await vi.waitFor(() => { expect(debug).toHaveBeenCalledWith(expect.stringContaining('replacement waits for the active run')) })
      gate.resolve(textResponse('first-reply'))
      expect((await replacement).status).toBe(200)
    } finally {
      waiting.abort()
      gate.resolve(textResponse('first-reply'))
      await Promise.all([first.result(), rejected])
    }
  })

  it('serves a history-only run at once while another run is active', async () => {
    const gate = Promise.withResolvers<StreamChunk[]>()
    const { url } = await mount({}, [gate.promise])
    const first = postStreaming(url, input())
    await first.started
    const history = await post(url, input({ runId: 'run-history', messages: [] }))
    expect(history.status).toBe(200)
    expect(history.body).toContain('MESSAGES_SNAPSHOT')
    expect(history.body).toContain('RUN_FINISHED')
    gate.resolve(textResponse('first-reply'))
    expect((await first.result()).status).toBe(200)
  })

  it('rejects a disconnected client after asynchronous thread initialization', async () => {
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const closed = Promise.withResolvers<void>()
    const initialize = ThreadBinding.prototype.initialize
    const initialized = vi.spyOn(ThreadBinding.prototype, 'initialize').mockImplementation(async function (this: ThreadBinding) {
      await initialize.call(this)
      entered.resolve()
      await release.promise
    })
    const admission = vi.spyOn(ThreadBinding.prototype, 'admit')
    try {
      const { ctx, url } = await mount()
      const server = (ctx.webServer as unknown as { server: Server }).server
      server.prependOnceListener('request', (_request, response) => { response.once('close', closed.resolve) })
      const client = postStreaming(url, input())
      await entered.promise
      client.abort()
      await closed.promise
      release.resolve()
      await vi.waitFor(() => { expect(admission).toHaveBeenCalledOnce() })
      await expect(admission.mock.results[0]?.value).rejects.toMatchObject({ code: 'CLIENT_DISCONNECTED' })
      expect(ctx.agents.list()[0]?.session.snapshotEvents().filter(event => event.type === 'user/message')).toHaveLength(0)
    } finally {
      release.resolve()
      initialized.mockRestore()
      admission.mockRestore()
    }
  })

  it('does not drive a reserved run when the response closes before admission returns', async () => {
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const closed = Promise.withResolvers<void>()
    const admit = ThreadBinding.prototype.admit
    const admission = vi.spyOn(ThreadBinding.prototype, 'admit').mockImplementation(async function (this: ThreadBinding, ...args) {
      const controller = await admit.apply(this, args)
      entered.resolve()
      await release.promise
      return controller
    })
    const drive = vi.spyOn(ThreadBinding.prototype, 'drive')
    const disconnect = vi.spyOn(ThreadBinding.prototype, 'disconnect')
    try {
      const { ctx, url } = await mount()
      const server = (ctx.webServer as unknown as { server: Server }).server
      server.prependOnceListener('request', (_request, response) => { response.once('close', closed.resolve) })
      const client = postStreaming(url, input())
      await entered.promise
      client.abort()
      await closed.promise
      release.resolve()
      await vi.waitFor(() => { expect(disconnect).toHaveBeenCalledOnce() })
      expect(drive).not.toHaveBeenCalled()
      expect(ctx.agents.list()[0]?.session.snapshotEvents().filter(event => event.type === 'user/message')).toHaveLength(0)
    } finally {
      release.resolve()
      admission.mockRestore()
      drive.mockRestore()
      disconnect.mockRestore()
    }
  })

  it('never admits a queued run whose client left before its turn', async () => {
    const gate = Promise.withResolvers<StreamChunk[]>()
    const { ctx, url } = await mount({}, [gate.promise, textResponse('third-reply')])
    const debug = vi.spyOn(ctx.logger, 'debug')
    const first = postStreaming(url, input())
    await first.started
    const second = postStreaming(url, secondRun())
    await vi.waitFor(() => { expect(debug).toHaveBeenCalledWith(expect.stringContaining('run-2 waits for the active run')) })
    second.abort()
    await vi.waitFor(() => { expect(debug).toHaveBeenCalledWith(expect.stringContaining('run-2 left the queue')) })
    gate.resolve(textResponse('first-reply'))
    expect((await first.result()).status).toBe(200)
    const third = await post(url, input({ runId: 'run-3', messages: [{ id: 'message-3', role: 'user', content: 'third' }] }))
    expect(third.status).toBe(200)
    expect(third.body).toContain('third-reply')
    expect(third.body).not.toContain('second')
  })

  it('waits for a cancelled turn to settle before admitting the next run', async () => {
    const gate = Promise.withResolvers<StreamChunk[]>()
    const { ctx, url } = await mount({}, [gate.promise, textResponse('second-reply')])
    const debug = vi.spyOn(ctx.logger, 'debug')
    const first = postStreaming(url, input())
    await first.started
    first.abort()
    const second = post(url, secondRun())
    await vi.waitFor(() => { expect(debug).toHaveBeenCalledWith(expect.stringContaining('run-2 waits for the Agent')) })
    gate.resolve(textResponse('first-reply'))
    const result = await second
    expect(result.status).toBe(200)
    expect(result.body).toContain('second-reply')
  })

  it('returns backend errors as streamed run failures', async () => {
    const { url } = await mount({}, [new Error('provider unavailable')])
    const result = await post(url, input())
    expect(result.status).toBe(200)
    expect(result.body).toContain('AGENT_EXECUTION_ERROR')
    expect(result.body).toContain('provider unavailable')
  })

  it('enforces live thread capacity and reclaims an expired thread', async () => {
    const { ctx, url } = await mount({ maxThreads: 1, threadIdleMs: 20 }, [textResponse('one'), textResponse('two')])
    const request = (value: RunAgentInput) => postChunked(url, [JSON.stringify(value)])
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      expect((await request(input())).status).toBe(200)
      expectCode(await request(input({ threadId: 'thread-2', runId: 'run-2', messages: [{ id: 'message-2', role: 'user', content: 'two' }] })), 429, 'THREAD_LIMIT_REACHED')

      const expired = ctx.agents.list()[0]
      expect(expired).toBeDefined()
      const disposed = new Promise<void>((resolve) => {
        const stop = ctx.on('agent/disposed', ({ agent }) => {
          if (agent === expired) {
            stop()
            resolve()
          }
        })
      })
      await vi.advanceTimersByTimeAsync(20)
      await disposed
      expect(ctx.agents.list()).toEqual([])
      expect((await request(input({ threadId: 'thread-2', runId: 'run-2', messages: [{ id: 'message-2', role: 'user', content: 'two' }] }))).status).toBe(200)
    } finally {
      vi.useRealTimers()
    }
  })

  it('returns identity only for the exact live Gateway-owned Agent', async () => {
    const { ctx, gateway, url } = await mount()
    expect((await post(url, input())).status).toBe(200)
    const agent = ctx.agents.list()[0]
    expect(agent).toBeDefined()
    expect(ctx.agUi.identityFor(agent!)).toEqual({ principal: { tenantId: 'tenant-1', userId: 'user-1' }, threadId: 'thread-1' })

    const foreign = await ctx.agents.create({ sessionId: SessionId('foreign-agent'), agentOptions: { provider: 'scripted', model: 'scripted' } })
    expect(ctx.agUi.identityFor(foreign.agent)).toBeUndefined()
    await foreign.dispose()

    await gateway.dispose()
    expect(ctx.agents.list()).not.toContain(agent)
  })
})
