import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { HttpAgent, type Tool } from '@ag-ui/client'
import { EventType } from '@ag-ui/core'
import { ask, lastAssistantText, pendingTool, reservePort, runAgentEvents, waitForServer } from './harness.ts'
import { durableSessionId } from '../src/session-id.ts'

/**
 * Subprocess seam for durable binding: a fixture host is SIGKILLed mid-flight
 * and relaunched over the same persistence root, proving the session survives
 * the process boundary, keeps identities off disk, and reports an interrupted
 * parked Tool call distinctly.
 */

const fixtureStart = fileURLToPath(new URL('./fixtures/durable/start.mjs', import.meta.url))
const SECRET = 'durable-fixture-shared-secret'
const PRINCIPAL = { tenantId: 'tenant-durable', userId: 'user-durable' }
const HEADERS = {
  authorization: `Bearer ${SECRET}`,
  'x-dsh-tenant-id': PRINCIPAL.tenantId,
  'x-dsh-user-id': PRINCIPAL.userId,
}
const CHAT_THREAD = 'encounter-durable'
const CRASH_THREAD = 'encounter-crash'

const NOTE_TOOL: Tool = {
  name: 'ui_draft_note',
  description: 'Render the durable note draft for sign-off.',
  parameters: {
    type: 'object',
    properties: { subject: { type: 'string' } },
    required: ['subject'],
    additionalProperties: false,
  },
}

interface Host {
  readonly child: ChildProcessWithoutNullStreams
  readonly base: string
}

const children: ChildProcessWithoutNullStreams[] = []
const roots: string[] = []

afterEach(() => {
  for (const child of children.splice(0)) child.kill('SIGKILL')
  for (const root of roots.splice(0)) void rm(root, { recursive: true, force: true })
})

describe('Durable session binding across a killed process', () => {
  it('continues the same session after a kill and keeps identities off disk', async () => {
    const root = await freshRoot()
    const first = await launch(root)
    const agent = new HttpAgent({ url: `${first.base}/ag-ui`, headers: HEADERS, threadId: CHAT_THREAD })
    await ask(agent, 'durable-user-1', 'durable-run-1', 'Set the codeword.', [])
    expect(lastAssistantText(agent.messages)).toBe('The codeword is pine-cone-7.')

    await drainThenKill(first.child)
    const log = await readSessionLog(root, CHAT_THREAD)
    expect(log).toContain('pine-cone-7')
    expect(log).toContain('ag-ui:user:durable-user-1')
    expect(log).not.toContain('tenant-durable')
    expect(log).not.toContain('user-durable')
    expect(log).not.toContain('encounter-durable')

    const second = await launch(root)
    const resumed = new HttpAgent({ url: `${second.base}/ag-ui`, headers: HEADERS, threadId: CHAT_THREAD })
    resumed.addMessage({ id: 'durable-user-1', role: 'user', content: 'Set the codeword.' })
    resumed.addMessage({ id: 'durable-user-2', role: 'user', content: 'Repeat the codeword.' })
    const events = await runAgentEvents(resumed, 'durable-run-2', [])

    // the scripted model only names the codeword when the resumed history reached it
    expect(lastAssistantText(resumed.messages)).toBe('History kept the codeword pine-cone-7.')
    const snapshot = events.find(event => event.type === EventType.MESSAGES_SNAPSHOT)
    expect(snapshot).toMatchObject({
      messages: expect.arrayContaining([
        { id: 'durable-user-1', role: 'user', content: 'Set the codeword.' },
        { id: `ag-ui:${String(durableSessionId(PRINCIPAL, CHAT_THREAD, SECRET))}:1:1:assistant`,
          role: 'assistant', content: 'The codeword is pine-cone-7.' },
      ]),
    })
  }, 60_000)

  it('reports an interrupted parked Tool call once, then keeps serving the thread', async () => {
    const root = await freshRoot()
    const first = await launch(root)
    const agent = new HttpAgent({ url: `${first.base}/ag-ui`, headers: HEADERS, threadId: CRASH_THREAD })
    await ask(agent, 'crash-user-1', 'crash-run-1', 'Draft the note.', [NOTE_TOOL])
    expect(pendingTool(agent.messages, NOTE_TOOL.name)?.function.name).toBe(NOTE_TOOL.name)
    expect(lastAssistantText(agent.messages)).toBeUndefined()

    await drainThenKill(first.child)
    const log = await readSessionLog(root, CRASH_THREAD)
    expect(log).toContain('fixture-draft-note')

    const second = await launch(root)
    const resumed = new HttpAgent({ url: `${second.base}/ag-ui`, headers: HEADERS, threadId: CRASH_THREAD })
    resumed.addMessage({ id: 'crash-user-1', role: 'user', content: 'Draft the note.' })
    resumed.addMessage({
      id: 'crash-result-1',
      role: 'tool',
      toolCallId: 'fixture-draft-note',
      content: JSON.stringify({ status: 'signed-off' }),
    })
    const events = await runAgentEvents(resumed, 'crash-run-2', [NOTE_TOOL])
    expect(events.map(event => event.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.MESSAGES_SNAPSHOT,
      EventType.RUN_ERROR,
    ])
    expect(events.at(-1)).toMatchObject({ code: 'THREAD_INTERRUPTED' })

    resumed.addMessage({ id: 'crash-user-3', role: 'user', content: 'Ping.' })
    const after = await runAgentEvents(resumed, 'crash-run-3', [NOTE_TOOL])
    expect(after.at(-1)).toMatchObject({ type: EventType.RUN_FINISHED })
    expect(lastAssistantText(resumed.messages)).toBe('pong.')
  }, 60_000)
})

async function freshRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ag-ui-durable-'))
  roots.push(root)
  return root
}

async function launch(root: string): Promise<Host> {
  const port = await reservePort()
  const child = spawn(process.execPath, [fixtureStart], {
    env: {
      ...process.env,
      PORT: String(port),
      DSH_AG_UI_FIXTURE_ROOT: root,
      DSH_AG_UI_FIXTURE_SECRET: SECRET,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  children.push(child)
  child.stdin.end()
  const stderr: string[] = []
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => { stderr.push(chunk) })
  const base = `http://127.0.0.1:${String(port)}`
  await waitForServer(`${base}/health`, child, stderr, 'Durable fixture')
  return { child, base }
}

/** Let the write-behind window close, then terminate without any cleanup. */
async function drainThenKill(child: ChildProcessWithoutNullStreams): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 600))
  child.kill('SIGKILL')
  await once(child, 'exit')
}

async function sessionLogPath(root: string, threadId: string): Promise<string> {
  const sessionId = String(durableSessionId(PRINCIPAL, threadId, SECRET))
  const projects = await readdir(root, { withFileTypes: true })
  for (const project of projects) {
    if (!project.isDirectory()) continue
    const entries = await readdir(join(root, project.name), { withFileTypes: true })
    const match = entries.find(entry => entry.isDirectory() && entry.name === sessionId)
    if (match !== undefined) return join(root, project.name, match.name, 'session.v3.jsonl')
  }
  throw new Error(`no persisted session for ${threadId} under ${root}`)
}

async function readSessionLog(root: string, threadId: string): Promise<string> {
  return readFile(await sessionLogPath(root, threadId), 'utf8')
}
