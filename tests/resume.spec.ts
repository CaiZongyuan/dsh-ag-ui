import { afterEach, describe, expect, it, vi } from 'vitest'
import { copyFile, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { SessionId } from '@deepseek-ai/dsh-session'
import { EventType, type RunAgentInput } from '@ag-ui/core'
import { ScriptedAdapter, textResponse } from './scripted-adapter.ts'
import { mountTestAgentCore } from './agent-core.ts'
import { durableSessionId } from '../src/session-id.ts'
import { ThreadBinding, type ThreadOptions } from '../src/thread.ts'

/**
 * Durable binding and cold resume across Context lifetimes: one thread binds a
 * deterministic session id, a later Context resumes the persisted session, and
 * the client's resent history deduplicates against the recovered log.
 */

const PRINCIPAL = { tenantId: 'tenant-resume', userId: 'user-resume' }
const SECRET = 'resume-test-shared-secret'
const SESSION = durableSessionId(PRINCIPAL, 'thread-resume', SECRET)
const RC2_SESSION = SessionId('ag-ui-0c27b585ac1d7528dde9c37ee11ef9ff51f4d310')
const RC2_FIXTURE = fileURLToPath(new URL('./fixtures/sessions/dsh-0.1.1-rc.2.jsonl', import.meta.url))

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

const roots: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function mountDurable(script: ScriptedAdapter['script'], root?: string): Promise<{ ctx: Context, adapter: ScriptedAdapter, root: string }> {
  const ctx = new Context()
  contexts.push(ctx)
  const durableRoot = root ?? await mkdtemp(join(tmpdir(), 'ag-ui-resume-'))
  if (root === undefined) roots.push(durableRoot)
  await mountTestAgentCore(ctx)
  const adapter = new ScriptedAdapter(script)
  ctx.llm.registerAdapter(['scripted'], adapter)
  await ctx.plugin(JsonlSessionPersistence, { root: durableRoot, compression: 'none' })
  return { ctx, adapter, root: durableRoot }
}

function bindingFor(ctx: Context, root: string, sessionId: SessionId = SESSION, workspaceRoot = join(root, 'workspaces')): ThreadBinding {
  return new ThreadBinding(ctx, PRINCIPAL, 'thread-resume', sessionId, {
    ...OPTIONS,
    workspaceRoot,
  }, () => {})
}

function input(runId: string, messages: RunAgentInput['messages']): RunAgentInput {
  return { threadId: 'thread-resume', runId, messages, tools: [], context: [], state: {}, forwardedProps: {} }
}

function eventsOf(controller: ReturnType<ThreadBinding['reserveRun']>) {
  return controller.record.events
}

describe('ThreadBinding durable resume', () => {
  it('resumes the persisted session, deduplicates resent history, and keeps identities off disk', async () => {
    const first = await mountDurable([textResponse('The codeword is pine-cone-7.')])
    const binding = bindingFor(first.ctx, first.root)
    await binding.initialize()
    const cwd = await realpath(join(first.root, 'workspaces', String(SESSION)))
    expect(binding.liveAgent.session.header.cwd).toBe(cwd)
    expect((await stat(cwd)).isDirectory()).toBe(true)
    const run = binding.reserveRun(input('run-resume-1', [{ id: 'user-resume-1', role: 'user', content: 'Set the codeword.' }]), 'digest-resume-1')
    binding.drive(run)
    await run.done
    expect(eventsOf(run).at(-1)).toMatchObject({ type: EventType.RUN_FINISHED })
    await binding.dispose()
    // the write-behind window closes within its bounded delay
    await new Promise(resolve => setTimeout(resolve, 300))
    await first.ctx.fiber.dispose()
    contexts.splice(contexts.indexOf(first.ctx), 1)

    const log = await readSessionLog(first.root)
    expect(log).toContain('pine-cone-7')
    expect(log).toContain('ag-ui:user:user-resume-1')
    // the session identity itself carries no tenant, user, or thread string
    expect(String(SESSION)).not.toContain('tenant-resume')
    expect(String(SESSION)).not.toContain('thread-resume')
    expect(log).not.toContain('tenant-resume')
    expect(await readdir(first.root)).not.toContain('_no-cwd')

    const second = await mountDurable([textResponse('History kept the codeword pine-cone-7.')], first.root)
    const resumed = bindingFor(second.ctx, second.root)
    await resumed.initialize()
    expect(resumed.liveAgent.session.header.cwd).toBe(cwd)
    expect(String(resumed.sessionId)).toBe(String(SESSION))
    expect(resumed.liveAgent.session.snapshotEvents().some(item =>
      item.type === 'assistant/message' && JSON.stringify(item.data).includes('pine-cone-7'))).toBe(true)

    const continuation = resumed.reserveRun(input('run-resume-2', [
      { id: 'user-resume-1', role: 'user', content: 'Set the codeword.' },
      { id: 'user-resume-2', role: 'user', content: 'Repeat the codeword.' },
    ]), 'digest-resume-2')
    resumed.drive(continuation)
    await continuation.done
    expect(eventsOf(continuation).at(-1)).toMatchObject({ type: EventType.RUN_FINISHED })
    const snapshot = eventsOf(continuation).find(event => event.type === EventType.MESSAGES_SNAPSHOT)
    expect(snapshot).toMatchObject({
      messages: expect.arrayContaining([
        { id: 'user-resume-1', role: 'user', content: 'Set the codeword.' },
        { id: `ag-ui:${String(SESSION)}:1:1:assistant`, role: 'assistant', content: 'The codeword is pine-cone-7.' },
      ]),
    })
    expect(second.adapter.requests).toHaveLength(1)
    expect(JSON.stringify(second.adapter.requests[0]?.messages)).toContain('pine-cone-7')
  })

  it('resumes and continues a session recorded by DSH 0.1.1-rc.2', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ag-ui-rc2-resume-'))
    roots.push(root)
    const sessionDir = join(root, '_no-cwd', String(RC2_SESSION))
    await mkdir(sessionDir, { recursive: true })
    await copyFile(RC2_FIXTURE, join(sessionDir, 'session.jsonl'))

    const mounted = await mountDurable([textResponse('History kept the codeword pine-cone-7.')], root)
    const resumed = bindingFor(mounted.ctx, mounted.root, RC2_SESSION)
    const warn = vi.spyOn(mounted.ctx.logger, 'warn')
    await resumed.initialize()
    expect(resumed.liveAgent.session.header.cwd).toBeUndefined()
    expect(warn).toHaveBeenCalledOnce()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('without a workspace cwd'))
    expect(resumed.liveAgent.session.snapshotEvents().some(event =>
      event.type === 'assistant/message' && JSON.stringify(event.data).includes('pine-cone-7'))).toBe(true)

    const continuation = resumed.reserveRun(input('run-rc2-resume', [
      { id: 'rc2-user-1', role: 'user', content: 'Set the codeword.' },
      { id: 'rc2-user-2', role: 'user', content: 'Repeat the codeword.' },
    ]), 'digest-rc2-resume')
    resumed.drive(continuation)
    await continuation.done

    expect(eventsOf(continuation).at(-1)).toMatchObject({ type: EventType.RUN_FINISHED })
    expect(JSON.stringify(mounted.adapter.requests[0]?.messages)).toContain('pine-cone-7')
  })

  it('rejects a resent user message whose content changed after the restart', async () => {
    const first = await mountDurable([textResponse('first exchange')])
    const binding = bindingFor(first.ctx, first.root)
    await binding.initialize()
    const run = binding.reserveRun(input('run-conflict-1', [{ id: 'user-conflict-1', role: 'user', content: 'original' }]), 'digest-conflict-1')
    binding.drive(run)
    await run.done
    await binding.dispose()
    await new Promise(resolve => setTimeout(resolve, 300))
    await first.ctx.fiber.dispose()
    contexts.splice(contexts.indexOf(first.ctx), 1)

    const second = await mountDurable([textResponse('unreachable')], first.root)
    const resumed = bindingFor(second.ctx, second.root)
    await resumed.initialize()
    const conflict = resumed.reserveRun(input('run-conflict-2', [
      { id: 'user-conflict-1', role: 'user', content: 'edited after restart' },
      { id: 'user-conflict-2', role: 'user', content: 'next' },
    ]), 'digest-conflict-2')
    resumed.drive(conflict)
    await conflict.done
    expect(eventsOf(conflict).at(-1)).toMatchObject({
      type: EventType.RUN_ERROR,
      code: 'MESSAGE_ID_CONFLICT',
    })
  })

  it('disposes a resumed handle when the configured workspace changed', async () => {
    const first = await mountDurable([textResponse('persist this session')])
    const binding = bindingFor(first.ctx, first.root)
    await binding.initialize()
    const run = binding.reserveRun(input('run-cwd-mismatch', [
      { id: 'user-cwd-mismatch', role: 'user', content: 'Persist this session.' },
    ]), 'digest-cwd-mismatch')
    binding.drive(run)
    await run.done
    await binding.dispose()
    await new Promise(resolve => setTimeout(resolve, 300))
    await first.ctx.fiber.dispose()
    contexts.splice(contexts.indexOf(first.ctx), 1)

    const second = await mountDurable([], first.root)
    const changedRoot = await mkdtemp(join(tmpdir(), 'ag-ui-changed-workspace-'))
    roots.push(changedRoot)
    const resumed = bindingFor(second.ctx, second.root, SESSION, changedRoot)
    await expect(resumed.initialize()).rejects.toMatchObject({
      code: 'SESSION_CWD_MISMATCH',
      status: 409,
    })
    expect(second.ctx.agents.list().some(agent => agent.id === SESSION)).toBe(false)
  })

  it('keeps a corrupted persisted artifact loud instead of replacing it', async () => {
    const first = await mountDurable([textResponse('to be corrupted')])
    const sessionId = durableSessionId(PRINCIPAL, 'thread-corrupt', SECRET)
    const binding = bindingFor(first.ctx, first.root, sessionId)
    await binding.initialize()
    const run = binding.reserveRun(input('run-corrupt-1', [{ id: 'user-corrupt-1', role: 'user', content: 'hello' }]), 'digest-corrupt-1')
    binding.drive(run)
    await run.done
    await binding.dispose()
    await new Promise(resolve => setTimeout(resolve, 300))
    await first.ctx.fiber.dispose()
    contexts.splice(contexts.indexOf(first.ctx), 1)

    const path = await sessionLogPath(first.root, sessionId)
    const lines = (await readFile(path, 'utf8')).split('\n')
    lines[1] = '{ this line is not valid json'
    await writeFile(path, lines.join('\n'), 'utf8')

    const second = await mountDurable([], first.root)
    const create = vi.spyOn(second.ctx.agents, 'create')
    const replacement = bindingFor(second.ctx, second.root, sessionId)
    await expect(replacement.initialize()).rejects.toThrow()
    expect(create).not.toHaveBeenCalled()
    expect(await readFile(path, 'utf8')).toBe(lines.join('\n'))
    expect(second.ctx.agents.list().some(agent => agent.id === sessionId)).toBe(false)
  })
})

async function sessionLogPath(root: string, sessionId: SessionId = SESSION): Promise<string> {
  const projects = await readdir(join(root), { withFileTypes: true })
  for (const project of projects) {
    if (!project.isDirectory()) continue
    const entries = await readdir(join(root, project.name), { withFileTypes: true })
    const match = entries.find(entry => entry.isDirectory() && entry.name === String(sessionId))
    if (match !== undefined) return join(root, project.name, match.name, 'session.v3.jsonl')
  }
  throw new Error(`no persisted session ${String(sessionId)} under ${root}`)
}

async function readSessionLog(root: string, sessionId: SessionId = SESSION): Promise<string> {
  return readFile(await sessionLogPath(root, sessionId), 'utf8')
}
