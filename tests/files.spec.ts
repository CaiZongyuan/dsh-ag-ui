import { Readable } from 'node:stream'
import type { ThreadBinding } from '../src/thread.ts'
import { createHash } from 'node:crypto'
import { request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import AgUiGateway, { type Config } from 'dsh-ag-ui'
import { createFileRoute, sanitizeFileName, verifiedFileUrl } from '../src/files.ts'
import { mountTestAgentCore } from './agent-core.ts'
import { mountNativeFiles } from './native-files.ts'
import { ScriptedAdapter } from './scripted-adapter.ts'

const SECRET = 'test-only-ag-ui-shared-secret'
const PRINCIPAL = { tenantId: 'tenant-1', userId: 'user-1' }
const HEADERS = {
  authorization: `Bearer ${SECRET}`,
  'x-dsh-tenant-id': PRINCIPAL.tenantId,
  'x-dsh-user-id': PRINCIPAL.userId,
}
const contexts: Context[] = []
const roots: string[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function mount(overrides: Partial<Config> = {}, persistenceRoot?: string, nativeHome?: string) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  await mountTestAgentCore(ctx)
  const nativeRoot = nativeHome ?? await mkdtemp(join(tmpdir(), 'ag-ui-native-files-'))
  if (nativeHome === undefined) roots.push(nativeRoot)
  await mountNativeFiles(ctx, nativeRoot)
  ctx.llm.registerAdapter(['scripted'], new ScriptedAdapter([]))
  if (persistenceRoot !== undefined) await ctx.plugin(JsonlSessionPersistence, { root: persistenceRoot, compression: 'none' })
  await ctx.plugin(AgUiGateway, {
    provider: 'scripted',
    model: 'scripted',
    sharedSecret: SECRET,
    maxRunEvents: 128,
    maxRunEventBytes: 128 * 1024,
    frontendToolTimeoutMs: 10_000,
    threadIdleMs: 60_000,
    ...overrides,
  })
  return { ctx, nativeRoot, url: `http://127.0.0.1:${String(ctx.webServer.port)}${overrides.path ?? '/ag-ui'}` }
}

async function upload(
  url: string,
  body: BodyInit,
  name = 'note.txt',
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${url}/threads/thread-1/files`, {
    method: 'POST',
    headers: { ...HEADERS, 'content-type': 'text/plain', 'x-file-name': encodeURIComponent(name), ...headers },
    body,
  })
}

async function expectCode(response: Response, status: number, code: string): Promise<void> {
  expect(response.status).toBe(status)
  expect(await response.json()).toMatchObject({ code })
}

function rawRequest(
  url: string,
  options: { method?: string, headers?: Record<string, string>, writes?: readonly Buffer[], abort?: boolean } = {},
): Promise<{ status: number, body: Buffer, headers: import('node:http').IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    let settled = false
    const settle = (result: { status: number, body: Buffer, headers: import('node:http').IncomingHttpHeaders }): void => {
      if (settled) return
      settled = true
      resolve(result)
    }
    const request = httpRequest(url, { method: options.method ?? 'POST', headers: options.headers }, (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => { chunks.push(chunk) })
      response.on('end', () => settle({ status: response.statusCode ?? 0, body: Buffer.concat(chunks), headers: response.headers }))
    })
    request.on('error', (error) => {
      if (options.abort === true) settle({ status: 0, body: Buffer.alloc(0), headers: {} })
      else reject(error)
    })
    request.on('close', () => {
      if (options.abort === true) settle({ status: 0, body: Buffer.alloc(0), headers: {} })
    })
    for (const chunk of options.writes ?? []) request.write(chunk)
    if (options.abort === true) setTimeout(() => request.destroy(), 10)
    else request.end()
  })
}

describe('file name sanitizing', () => {
  it('keeps only a clean direct basename', () => {
    expect(sanitizeFileName('../../etc/passwd')).toBe('passwd')
    expect(sanitizeFileName('folder\\report\u0000.txt\u007f ')).toBe('report.txt')
  })

  it.each(['', ' ', '.', '..', '.hidden', '/\u0000', 'x'.repeat(256)])('rejects invalid name %j', (name) => {
    expect(() => sanitizeFileName(name)).toThrow(expect.objectContaining({ code: 'INVALID_FILE_NAME' }))
  })
})

describe('native thread file HTTP routes', () => {
  it('streams exact bytes and native hash metadata with authenticated downloads', async () => {
    const mounted = await mount()
    const bytes = Buffer.alloc(1024 * 1024, 0x5a)
    const response = await upload(mounted.url, bytes, 'sample.json')
    expect(response.status).toBe(201)
    const source = await response.json() as { value: string, metadata: { filename: string, size: number, sha256: string } }
    expect(source.metadata).toEqual({ filename: 'sample.json', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })
    const location = new URL(source.value, mounted.url)
    const downloaded = await fetch(location, { headers: HEADERS })
    expect(downloaded.status).toBe(200)
    expect(Buffer.from(await downloaded.arrayBuffer())).toEqual(bytes)
    expect(downloaded.headers.get('content-type')).toBe('application/json')
    expect(downloaded.headers.get('content-disposition')).toBe("attachment; filename*=UTF-8''sample.json")
    await expectCode(await fetch(location, { headers: { ...HEADERS, 'x-dsh-user-id': 'other' } }), 404, 'FILE_NOT_FOUND')
    await expectCode(await fetch(location, { headers: { ...HEADERS, 'x-dsh-tenant-id': 'other' } }), 404, 'FILE_NOT_FOUND')
    await expectCode(await fetch(location.href.replace('thread-1', 'thread-2'), { headers: HEADERS }), 404, 'FILE_NOT_FOUND')
    location.searchParams.set('file', `${location.searchParams.get('file')}x`)
    await expectCode(await fetch(location, { headers: HEADERS }), 404, 'FILE_NOT_FOUND')
  }, 15000)

  it('rejects download authority before allocating a thread slot', async () => {
    const mounted = await mount({ maxThreads: 1 })
    for (const thread of ['invalid-1', 'invalid-2']) {
      await expectCode(await fetch(`${mounted.url}/threads/${thread}/files/x?file=bogus`, { headers: HEADERS }), 404, 'FILE_NOT_FOUND')
    }
    const created = await upload(mounted.url, 'authorized')
    expect(created.status).toBe(201)
    const source = await created.json() as { value: string }
    await expectCode(await fetch(new URL(source.value, mounted.url), {
      headers: { ...HEADERS, 'x-dsh-user-id': 'foreign' },
    }), 404, 'FILE_NOT_FOUND')
    expect((await fetch(new URL(source.value, mounted.url), { headers: HEADERS })).status).toBe(200)
  })

  it('retains distinct same-name uploads without filename collision storage', async () => {
    const mounted = await mount()
    const first = await (await upload(mounted.url, 'one', 'name.txt')).json() as { value: string }
    const second = await (await upload(mounted.url, 'two', 'name.txt')).json() as { value: string }
    expect(first.value).not.toBe(second.value)
    expect(await (await fetch(new URL(first.value, mounted.url), { headers: HEADERS })).text()).toBe('one')
    expect(await (await fetch(new URL(second.value, mounted.url), { headers: HEADERS })).text()).toBe('two')
  })

  it('supports empty uploads and sanitizes display names', async () => {
    const mounted = await mount()
    const empty = await upload(mounted.url, '', '../../empty.txt')
    expect(empty.status).toBe(201)
    expect(await empty.json()).toMatchObject({ metadata: { filename: 'empty.txt', size: 0, sha256: createHash('sha256').digest('hex') } })
  })

  it('rejects invalid headers, lengths, names and identity before native intake', async () => {
    const mounted = await mount({ maxFileBytes: 4 })
    expect((await upload(mounted.url, '1234')).status).toBe(201)
    await expectCode(await upload(mounted.url, '12345'), 413, 'FILE_TOO_LARGE')
    await expectCode(await upload(mounted.url, 'x', '..'), 400, 'INVALID_FILE_NAME')
    await expectCode(await upload(mounted.url, 'x', 'x', { authorization: 'Bearer bad' }), 401, 'UNAUTHORIZED')
    const missingLength = await rawRequest(`${mounted.url}/threads/thread-1/files`, { headers: { ...HEADERS, 'transfer-encoding': 'chunked', 'x-file-name': 'x' } })
    expect(missingLength.status).toBe(411)
  })

  it('lets native storage clean cancelled intake and accepts its retry', async () => {
    const mounted = await mount()
    await rawRequest(`${mounted.url}/threads/thread-1/files`, {
      headers: { ...HEADERS, 'content-length': '100000', 'x-file-name': 'cancelled.txt' },
      writes: [Buffer.alloc(100)], abort: true,
    })
    const retry = await upload(mounted.url, 'complete', 'cancelled.txt')
    expect(retry.status).toBe(201)
    const source = await retry.json() as { value: string }
    expect(await (await fetch(new URL(source.value, mounted.url), { headers: HEADERS })).text()).toBe('complete')
    const files = await readdir(mounted.nativeRoot, { recursive: true })
    expect(files.filter(name => name.endsWith('.tmp') || name.endsWith('.part'))).toEqual([])
  })

  it('downloads a durable upload after a cold restart without a gateway files index', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ag-ui-native-cold-'))
    roots.push(root)
    const first = await mount({}, join(root, 'sessions'), join(root, 'native'))
    const source = await (await upload(first.url, 'durable')).json() as { value: string }
    await first.ctx.fiber.dispose()
    contexts.splice(contexts.indexOf(first.ctx), 1)
    const second = await mount({}, join(root, 'sessions'), join(root, 'native'))
    const download = await fetch(new URL(source.value, second.url), { headers: HEADERS })
    expect(download.status).toBe(200)
    expect(await download.text()).toBe('durable')
  })
})

describe('file route admission failures', () => {
  it('rejects malformed headers and route shapes', async () => {
    const cases: Array<[string, string, Record<string, string>, string]> = [
      ['/other', 'POST', {}, 'NOT_FOUND'],
      ['/ag-ui/threads', 'POST', {}, 'NOT_FOUND'],
      ['/ag-ui/threads/t/files', 'GET', {}, 'METHOD_NOT_ALLOWED'],
      ['/ag-ui/threads/t/files/x', 'POST', {}, 'METHOD_NOT_ALLOWED'],
      ['/ag-ui/threads/%/files', 'POST', {}, 'INVALID_IDENTITY'],
      ['/ag-ui/threads/t/files', 'POST', { 'content-length': '0' }, 'INVALID_FILE_NAME'],
      ['/ag-ui/threads/t/files', 'POST', { 'content-length': '-1' }, 'INVALID_CONTENT_LENGTH'],
      ['/ag-ui/threads/t/files', 'POST', { 'content-length': '99999999999999999' }, 'FILE_TOO_LARGE'],
      ['/ag-ui/threads/t/files', 'POST', { 'content-length': '0', 'x-file-name': '%' }, 'INVALID_FILE_NAME'],
      ['/ag-ui/threads/t/files/x%2Fy', 'GET', {}, 'INVALID_FILE_NAME'],
    ]
    for (const [url, method, headers, expected] of cases) {
      const result = await directRoute(url, method, headers)
      expect(result).toBe(expected)
    }
  })

  it('rejects byte overflow and truncation before native storage can commit', async () => {
    expect(await directRoute('/ag-ui/threads/t/files', 'POST', { 'content-length': '4', 'x-file-name': 'x' }, [new Uint8Array(5)])).toBe('FILE_TOO_LARGE')
    expect(await directRoute('/ag-ui/threads/t/files', 'POST', { 'content-length': '4', 'x-file-name': 'x' }, [Buffer.alloc(3)])).toBe('CONTENT_LENGTH_MISMATCH')
  })

  it('surfaces a storage error and verifies filename and secret binding', async () => {
    expect(await directRoute('/ag-ui/threads/t/files', 'POST', { 'content-length': '1', 'x-file-name': 'x' }, [Buffer.alloc(1)], true)).toBe('AGENT_EXECUTION_ERROR')
    const mounted = await mount()
    const source = await (await upload(mounted.url, 'hello', 'opaque.bin')).json() as { value: string }
    const downloaded = await fetch(new URL(source.value, mounted.url), { headers: HEADERS })
    expect(downloaded.headers.get('content-type')).toBe('application/octet-stream')
    expect(await downloaded.text()).toBe('hello')
    const renamed = source.value.replace('/opaque.bin?', '/other.bin?')
    await expectCode(await fetch(new URL(renamed, mounted.url), { headers: HEADERS }), 404, 'FILE_NOT_FOUND')
    expect(() => verifiedFileUrl(source.value, 'thread-1', String(durableSessionId(PRINCIPAL, 'thread-1', SECRET)), 'rotated')).toThrow()
  })
})

/** HTTP framing failures need a synthetic stream because Node rejects invalid framing before routing. */
async function directRoute(url: string, method: string, headers: Record<string, string>, chunks: Uint8Array[] = [], fail = false) {
  const request = Object.assign(Readable.from(chunks), { url, method, headers, aborted: false })
  let code: string | undefined
  const binding = {
    async uploadFile(data: AsyncIterable<Uint8Array>) {
      for await (const _chunk of data) { /* consume with native-style backpressure */ }
      if (fail) throw new Error('storage unavailable')
      throw new Error('framing should reject this input')
    },
  } as unknown as ThreadBinding
  const route = createFileRoute({
    path: '/ag-ui', maxFileBytes: 4, authenticate: () => PRINCIPAL, validateThreadId: () => {},
    verifyFileUrl: () => { throw new Error('unexpected file authorization') },
    bindingFor: async () => binding,
    respondError: (_response, error) => { code = error.code },
  })
  await route(request as unknown as IncomingMessage, { setHeader() {} } as unknown as ServerResponse)
  return code
}
