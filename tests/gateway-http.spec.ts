import { request as httpRequest } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import type { RunAgentInput, Tool } from '@ag-ui/core'
import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { LlmAdapter, type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { mountTestSpine } from './spine.ts'
import AgUiGateway, { type Config } from 'dsh-ag-ui'
import { SessionId } from '@deepseek-ai/dsh-session'

const SECRET = 'test-only-ag-ui-shared-secret'
const HEADERS = {
  authorization: `Bearer ${SECRET}`,
  'x-dsh-tenant-id': 'tenant-1',
  'x-dsh-user-id': 'user-1',
}

class ScriptedAdapter extends LlmAdapter {
  constructor(private readonly script: Array<StreamChunk[] | Error>) {
    super()
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  async *stream(_request: GenerateOptions): AsyncIterable<StreamChunk> {
    const response = this.script.shift()
    if (response instanceof Error) throw response
    if (response === undefined) throw new Error('script exhausted')
    for (const chunk of response) yield chunk
  }
}

const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
})

function textResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

async function mount(
  overrides: Partial<Config> = {},
  script: Array<StreamChunk[] | Error> = [textResponse('ok')],
  host: '127.0.0.1' | '0.0.0.0' = '127.0.0.1',
) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(WebServer, { host, port: 0 })
  await mountTestSpine(ctx)
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

  it('shares one pending thread creation across concurrent requests', async () => {
    const { ctx, url } = await mount({}, [textResponse('one')])
    const first = post(url, input())
    const second = post(url, input())
    const results = await Promise.all([first, second])
    expect(results.map(result => result.status)).toEqual([200, 200])
    expect(results[1]?.body).toBe(results[0]?.body)
    expect(ctx.agents.list()).toHaveLength(1)
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
    expect((await post(url, input())).status).toBe(200)
    expectCode(await post(url, input({ threadId: 'thread-2', runId: 'run-2', messages: [{ id: 'message-2', role: 'user', content: 'two' }] })), 429, 'THREAD_LIMIT_REACHED')

    const expired = ctx.agents.list()[0]
    expect(expired).toBeDefined()
    await new Promise<void>((resolve) => {
      const stop = ctx.on('agent/disposed', ({ agent }) => {
        if (agent === expired) {
          stop()
          resolve()
        }
      })
    })
    expect(ctx.agents.list()).toEqual([])
    expect((await post(url, input({ threadId: 'thread-2', runId: 'run-2', messages: [{ id: 'message-2', role: 'user', content: 'two' }] }))).status).toBe(200)
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
