import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentPresets from '@deepseek-ai/dsh-agent-presets'
import { join, resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { HttpAgent } from '@ag-ui/client'
import { ActivityMessageSchema, EventType, type ActivityMessage } from '@ag-ui/core'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { FsError } from '@deepseek-ai/dsh-fs'
import * as Present from '@deepseek-ai/dsh-tool-present'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import AgUiGateway from 'dsh-ag-ui'
import { durableSessionId } from '../src/session-id.ts'
import { isPresentedEvent } from '../src/deliverables.ts'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { mountTestAgentCore } from './agent-core.ts'
import { ScriptedAdapter, textResponse, toolResponse } from './scripted-adapter.ts'
import { ask, runAgentEvents } from './harness.ts'

const SECRET = 'test-deliverables-secret'
const PRINCIPAL = { tenantId: 't', userId: 'u' }
const HEADERS = { authorization: `Bearer ${SECRET}`, 'x-dsh-tenant-id': 't', 'x-dsh-user-id': 'u' }
const contexts: Context[] = []
const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function mount(root?: string, maxFileBytes = 1024, filePath = 'report.txt', isolatedPreset = false) {
  if (root === undefined) { root = await mkdtemp(join(tmpdir(), 'ag-ui-deliverables-')); roots.push(root) }
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  await mountTestAgentCore(ctx)
  await ctx.plugin(LocalFileSystem, { cwd: root })
  if (isolatedPreset) {
    ctx.baseUrl = new URL('./fixtures/presets/roots/', import.meta.url).href
    await ctx.plugin(Loader)
    await ctx.plugin(AgentPresets, { default: 'deliverables', includeUserRoot: false,
      roots: [{ path: fileURLToPath(new URL('./fixtures/presets/roots/', import.meta.url)), trust: 'system' }] })
  } else {
    await ctx.plugin(Present, { maxFiles: 8 })
  }
  await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions'), compression: 'none' })
  ctx.llm.registerAdapter(['scripted'], new ScriptedAdapter([
    toolResponse('outer', 'nested_present', {}), textResponse('Done'),
  ]))
  // An enclosing tool failure must not erase a successful nested present declaration.
  ctx.tools.register(defineTool({
    name: 'nested_present', description: 'Present then fail', parameters: {},
    output: { schema: { type: 'object', properties: {}, additionalProperties: false }, render: () => [] },
    async execute(_args, exec) {
      await ctx.tools.execute({ name: 'present', arguments: { files: [{ path: filePath, description: 'Report' }] },
        callId: ToolCallId('nested'), rootCallId: exec.rootCallId, parent: exec.token, agent: exec.agent, signal: exec.signal })
      throw new Error('enclosing tool failed')
    },
  }))
  const workspaceRoot = join(root, 'workspaces')
  const cwd = join(workspaceRoot, String(durableSessionId(PRINCIPAL, 'thread-1', SECRET)))
  await mkdir(cwd, { recursive: true })
  await writeFile(resolve(cwd, filePath), 'result')
  await ctx.plugin(AgUiGateway, { provider: 'scripted', model: 'scripted', sharedSecret: SECRET,
    path: '/custom', workspaceRoot, maxFileBytes, threadIdleMs: 60_000,
    ...(isolatedPreset ? { agentPreset: 'deliverables' } : {}) })
  const url = `http://127.0.0.1:${String(ctx.webServer.port)}/custom`
  const client = new HttpAgent({ url, headers: HEADERS, threadId: 'thread-1' })
  return { ctx, client, url, root, cwd }
}

async function present(mounted: Awaited<ReturnType<typeof mount>>) {
  const events = await ask(mounted.client, 'user-1', 'run-1', 'Make a report', [])
  const activity = mounted.client.messages.find((message): message is ActivityMessage => message.role === 'activity')
  expect(activity).toBeDefined()
  ActivityMessageSchema.parse(activity)
  const file = (activity!.content as { files: Array<{ url: string }> }).files[0]!
  return { events, activity: activity!, location: new URL(file.url, mounted.url) }
}

async function expectCode(response: Response, status: number, code: string) {
  expect(response.status).toBe(status)
  expect(await response.json()).toMatchObject({ code })
}

describe('native deliverable adoption', () => {
  it('keeps nested present activities through live, history, restart and authenticated download', async () => {
    const first = await mount()
    const { events, activity, location } = await present(first)
    expect(activity.activityType).toBe('dsh-deliverables')
    expect(events.filter(event => event.type === EventType.ACTIVITY_SNAPSHOT)).toEqual([{
      type: EventType.ACTIVITY_SNAPSHOT, replace: true, messageId: activity.id, activityType: activity.activityType, content: activity.content,
    }])
    const response = await fetch(location, { headers: HEADERS })
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('result')
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('content-disposition')).toBe("attachment; filename*=UTF-8''report.txt")
    await expectCode(await fetch(location), 401, 'UNAUTHORIZED')
    for (const headers of [{ ...HEADERS, 'x-dsh-user-id': 'other' }, { ...HEADERS, 'x-dsh-tenant-id': 'other' }]) {
      await expectCode(await fetch(location, { headers }), 404, 'FILE_NOT_FOUND')
    }
    await expectCode(await fetch(location.href.replace('thread-1', 'thread-2'), { headers: HEADERS }), 404, 'FILE_NOT_FOUND')
    await runAgentEvents(first.client, 'history', [])
    expect(first.client.messages.filter(message => message.role === 'activity')).toEqual([activity])
    await first.ctx.fiber.dispose()
    const second = await mount(first.root)
    await runAgentEvents(second.client, 'cold', [])
    expect(second.client.messages.filter(message => message.role === 'activity')).toEqual([activity])
    await writeFile(join(second.cwd, 'report.txt'), 'updated')
    const restored = new URL(location.pathname, second.url)
    expect(await (await fetch(restored, { headers: HEADERS })).text()).toBe('updated')
    await rm(join(second.cwd, 'report.txt'))
    await expectCode(await fetch(restored, { headers: HEADERS }), 404, 'FILE_NOT_FOUND')
  })

  it('downloads through the native preset isolate instead of the host filesystem', async () => {
    const mounted = await mount(undefined, 1024, 'report.txt', true)
    const { location } = await present(mounted)
    const agent = mounted.ctx.agents.list()[0]!
    const hostFs = agent.ctx.get('fs')!
    const presetFs = mounted.ctx.agentPresets.serviceFor(agent, 'fs')!
    expect(presetFs).toBeDefined()
    expect(presetFs).not.toBe(hostFs)
    const hostTarget = await hostFs.resolve('report.txt', { cwd: mounted.cwd })
    expect(Buffer.from(await hostFs.readBytes(hostTarget, undefined, 1024)).toString()).toBe('result')
    const response = await fetch(location, { headers: HEADERS })
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('preset-result')
  })

  it('preserves absolute declarations outside cwd when the native provider allows them', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ag-ui-deliverables-absolute-'))
    roots.push(root)
    const path = join(root, 'outside.txt')
    const mounted = await mount(root, 1024, path)
    const { activity, location } = await present(mounted)
    expect(activity.content).toMatchObject({ files: [{ path }] })
    expect(await (await fetch(location, { headers: HEADERS })).text()).toBe('result')
  })

  it.each(['.report.csv', '\u0001', 'opaque.bin'])('downloads native source %j without upload-only name restrictions', async filePath => {
    const mounted = await mount(undefined, 1024, filePath)
    const { location } = await present(mounted)
    const response = await fetch(location, { headers: HEADERS })
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('result')
    expect(response.headers.get('content-disposition')).toBe(`attachment; filename*=UTF-8''${encodeURIComponent(filePath === '\u0001' ? 'download' : filePath)}`)
  })

  it('rejects bad coordinates, non-files and bounded reads without accepting arbitrary paths', async () => {
    const mounted = await mount(undefined, 8)
    const { location } = await present(mounted)
    await expectCode(await fetch(location, { method: 'POST', headers: HEADERS }), 405, 'METHOD_NOT_ALLOWED')
    for (const pathname of [location.pathname.replace(/files\/0$/, 'files/9'),
      '/custom/threads/thread-1/deliverables/0/files/0',
      '/custom/threads/thread-1/deliverables/999999999999999999999/files/0',
      '/custom/threads/thread-1/deliverables/0/files/999999999999999999999']) {
      await expectCode(await fetch(new URL(pathname, mounted.url), { headers: HEADERS }), 404, 'FILE_NOT_FOUND')
    }
    await writeFile(join(mounted.cwd, 'report.txt'), 'more than eight')
    await expectCode(await fetch(location, { headers: HEADERS }), 413, 'FILE_TOO_LARGE')
    await rm(join(mounted.cwd, 'report.txt'))
    await symlink(join(mounted.root, 'outside'), join(mounted.cwd, 'report.txt'))
    await expectCode(await fetch(location, { headers: HEADERS }), 404, 'FILE_NOT_FOUND')
  })

  it('aborts a bounded native read on disconnect and permits a subsequent download', async () => {
    const mounted = await mount()
    const { location } = await present(mounted)
    const fs = mounted.ctx.agents.list()[0]!.ctx.get('fs')!
    const entered = Promise.withResolvers<void>()
    const aborted = Promise.withResolvers<void>()
    vi.spyOn(fs, 'readBytes').mockImplementationOnce(async (_target, signal) => {
      entered.resolve()
      await new Promise<void>((_resolve, reject) => signal!.addEventListener('abort', () => {
        aborted.resolve()
        reject(new Error('cancelled native read'))
      }, { once: true }))
      return new Uint8Array()
    })
    const controller = new AbortController()
    const request = fetch(location, { headers: HEADERS, signal: controller.signal })
    const rejection = expect(request).rejects.toThrow()
    await entered.promise
    controller.abort()
    await rejection
    await aborted.promise
    expect(await (await fetch(location, { headers: HEADERS })).text()).toBe('result')
  })

  it('uses the session provider and contains its denied, missing and oversized read failures', async () => {
    const mounted = await mount()
    const { location } = await present(mounted)
    const agent = mounted.ctx.agents.list().find(agent => agent.session.id === durableSessionId(PRINCIPAL, 'thread-1', SECRET))!
    const fs = agent.ctx.get('fs')!
    for (const [native, status, code] of [
      ['FS_PERMISSION_DENIED', 403, 'FILE_ACCESS_DENIED'], ['FS_SANDBOX_DENIED', 403, 'FILE_ACCESS_DENIED'],
      ['FS_NOT_FOUND', 404, 'FILE_NOT_FOUND'], ['FS_NOT_REGULAR_FILE', 404, 'FILE_NOT_FOUND'],
      ['FS_TOO_LARGE', 413, 'FILE_TOO_LARGE'], ['FS_IO_ERROR', 500, 'AGENT_EXECUTION_ERROR'],
    ] as const) {
      const read = vi.spyOn(fs, 'readBytes').mockRejectedValueOnce(new FsError('native failure', native))
      await expectCode(await fetch(location, { headers: HEADERS }), status, code)
      expect(read).toHaveBeenCalledWith(expect.anything(), expect.any(AbortSignal), 1024)
      read.mockRestore()
    }
    vi.spyOn(fs, 'stat').mockResolvedValueOnce(undefined)
    await expectCode(await fetch(location, { headers: HEADERS }), 404, 'FILE_NOT_FOUND')
    vi.spyOn(fs, 'stat').mockResolvedValueOnce({ type: 'directory', version: (await fs.stat(await fs.resolve(mounted.cwd)))!.version })
    await expectCode(await fetch(location, { headers: HEADERS }), 404, 'FILE_NOT_FOUND')
  })
})

describe('recovered declaration validation', () => {
  it.each([null, {}, { turn: 0, callId: 'c', files: [{ path: 'x' }] }, { turn: 1, callId: '', files: [{ path: 'x' }] }, { turn: 1 }, { turn: 1, callId: 'c', files: [] },
    { turn: 1, callId: 'c', files: [null] }, { turn: 1, callId: 'c', files: [{ path: ' ' }] },
    { turn: 1, callId: 'c', files: [{ path: 'x', description: 1 }] }])('rejects malformed declaration %j', data => {
    expect(isPresentedEvent({ type: 'deliverables/presented', data } as SessionEvent)).toBe(false)
  })
})
