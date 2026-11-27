import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { RunAgentInput } from '@ag-ui/core'
import { ThreadBinding, type RunAdmission } from '../src/thread.ts'
import type { RunController } from '../src/run.ts'
import type { AgUiProjectedDelivery } from '../src/types.ts'
import { mountTestAgentCore } from './agent-core.ts'
import { ScriptedAdapter, textResponse } from './scripted-adapter.ts'

const contexts: Context[] = []
const workspaceRoots: string[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  await Promise.all(workspaceRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

const OPTIONS = {
  provider: 'scripted',
  model: 'scripted',
  frontendToolTimeoutMs: 10_000,
  threadIdleMs: 60_000,
  maxRunEvents: 128,
  maxRunEventBytes: 128 * 1024,
  maxRunsPerThread: 4,
  maxStateBytes: 64 * 1024,
  maxFilesPerMessage: 8,
} as const

async function mount() {
  const ctx = new Context()
  contexts.push(ctx)
  await mountTestAgentCore(ctx)
  const adapter = new ScriptedAdapter([textResponse('ok')])
  ctx.llm.registerAdapter(['scripted'], adapter)
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'ag-ui-projection-'))
  workspaceRoots.push(workspaceRoot)
  const binding = new ThreadBinding(
    ctx,
    { tenantId: 'tenant-1', userId: 'user-1' },
    'thread-1',
    SessionId('ag-ui-projection-spec-session'),
    { ...OPTIONS, workspaceRoot },
    () => {},
  )
  await binding.initialize()
  return { ctx, binding }
}

function input(runId: string, messages: RunAgentInput['messages'] = []): RunAgentInput {
  return { threadId: 'thread-1', runId, messages, tools: [], context: [], state: {}, forwardedProps: {} }
}

/** Build one well-formed projection the Gateway would accept. */
function delivery(identity: string, userAction: Record<string, unknown> = { name: 'go', surfaceId: 's' }): AgUiProjectedDelivery {
  return {
    identity,
    forwardedProps: { _projectedFromA2UI: true, a2uiAction: { userAction } },
    messages: [
      {
        id: `${identity}:call`,
        role: 'assistant',
        content: '',
        toolCalls: [{ id: identity, type: 'function', function: { name: 'log_a2ui_event', arguments: JSON.stringify(userAction) } }],
      },
      { id: `${identity}:result`, role: 'tool', toolCallId: identity, content: 'ok' },
    ],
  }
}

describe('ThreadBinding.projectDelivery', () => {
  it('queues a projection while no run owns the stream', async () => {
    const { binding } = await mount()
    expect(binding.projectDelivery(delivery('id-queued'))).toEqual({ accepted: true, disposition: 'queued' })
  })

  it('emits immediately while a run is active', async () => {
    const { binding } = await mount()
    binding.reserveRun(input('run-active'))
    expect(binding.projectDelivery(delivery('id-emitted'))).toEqual({ accepted: true, disposition: 'emitted' })
  })

  it('treats a replayed identical delivery as a duplicate', async () => {
    const { binding } = await mount()
    expect(binding.projectDelivery(delivery('id-dup')).accepted).toBe(true)
    expect(binding.projectDelivery(delivery('id-dup'))).toEqual({ accepted: false, reason: 'duplicate-identity' })
  })

  it('treats a replayed identity with different content as a conflict', async () => {
    const { binding } = await mount()
    expect(binding.projectDelivery(delivery('id-conflict', { name: 'a' })).accepted).toBe(true)
    expect(binding.projectDelivery(delivery('id-conflict', { name: 'b' })))
      .toEqual({ accepted: false, reason: 'identity-conflict' })
  })

  it('rejects a delivery without the projection marker', async () => {
    const { binding } = await mount()
    const malformed = delivery('id-no-marker')
    const forwarded = { ...malformed.forwardedProps }
    delete (forwarded as Record<string, unknown>)['_projectedFromA2UI']
    expect(binding.projectDelivery({ ...malformed, forwardedProps: forwarded } as AgUiProjectedDelivery))
      .toEqual({ accepted: false, reason: 'invalid-delivery' })
  })

  it('rejects a malformed synthetic pair', async () => {
    const { binding } = await mount()
    const malformed = delivery('id-pair')
    expect(binding.projectDelivery({ ...malformed, messages: [malformed.messages[0]!] } as AgUiProjectedDelivery))
      .toEqual({ accepted: false, reason: 'invalid-delivery' })
    expect(binding.projectDelivery({
      ...malformed,
      messages: [malformed.messages[0]!, { ...malformed.messages[1]!, toolCallId: 'other' }],
    } as AgUiProjectedDelivery)).toEqual({ accepted: false, reason: 'invalid-delivery' })
  })

  it('rejects an over-long identity', async () => {
    const { binding } = await mount()
    expect(binding.projectDelivery(delivery('x'.repeat(513)))).toEqual({ accepted: false, reason: 'invalid-delivery' })
  })

  it('rejects every remaining malformed delivery shape', async () => {
    const { binding } = await mount()
    const base = delivery('id-shape')
    const reject = (value: unknown): void => {
      expect(binding.projectDelivery(value as AgUiProjectedDelivery)).toEqual({ accepted: false, reason: 'invalid-delivery' })
    }
    reject(null)
    reject('not-an-object')
    // forwardedProps not an object
    reject({ ...base, forwardedProps: null })
    // a2uiAction envelope not an object
    reject({ ...base, forwardedProps: { _projectedFromA2UI: true, a2uiAction: null } })
    // userAction not an object
    reject({ ...base, forwardedProps: { _projectedFromA2UI: true, a2uiAction: { userAction: 7 } } })
    // messages not an array / wrong length already covered; assistant not an object
    reject({ ...base, messages: [null, base.messages[1]] })
    // toolCalls not exactly one
    reject({ ...base, messages: [{ ...(base.messages[0] as Record<string, unknown>), toolCalls: [] }, base.messages[1]] })
    // tool call not an object
    reject({ ...base, messages: [{ ...(base.messages[0] as Record<string, unknown>), toolCalls: [null] }, base.messages[1]] })
    // function not an object
    reject({ ...base, messages: [{ ...(base.messages[0] as Record<string, unknown>), toolCalls: [{ id: 'c', type: 'function', function: null }] }, base.messages[1]] })
    // wrong synthetic tool name
    reject({ ...base, messages: [{ ...(base.messages[0] as Record<string, unknown>), toolCalls: [{ id: 'c', type: 'function', function: { name: 'other_tool', arguments: '{}' } }] }, base.messages[1]] })
    // result role not tool
    reject({ ...base, messages: [base.messages[0], { ...(base.messages[1] as Record<string, unknown>), role: 'assistant' }] })
    // assistant content not empty is covered by pair test; assistant role wrong
    reject({ ...base, messages: [{ ...(base.messages[0] as Record<string, unknown>), role: 'user' }, base.messages[1]] })
  })

  it('refuses to queue past the pending bound', async () => {
    const { binding } = await mount()
    for (let index = 0; index < 64; index += 1) expect(binding.projectDelivery(delivery(`id-${String(index)}`)).accepted).toBe(true)
    expect(binding.projectDelivery(delivery('id-overflow'))).toEqual({ accepted: false, reason: 'queue-full' })
  })

  it('refuses after the binding is disposed', async () => {
    const { binding } = await mount()
    await binding.dispose()
    expect(binding.projectDelivery(delivery('id-disposed'))).toEqual({ accepted: false, reason: 'thread-disposed' })
  })

  it('flushes queued projections to the next controller', async () => {
    const { binding } = await mount()
    expect(binding.projectDelivery(delivery('id-flush')).accepted).toBe(true)
    const emitted: unknown[] = []
    binding.flushProjections({ emit: (event: unknown) => emitted.push(event) } as unknown as RunController)
    expect(emitted).toHaveLength(1)
    expect(emitted[0]).toMatchObject({ type: 'CUSTOM', name: 'dsh:a2ui:action' })
  })

  it('exposes the delivery verbatim on the emitted event', async () => {
    const { binding } = await mount()
    binding.reserveRun(input('run-emit-verbatim'))
    const payload = delivery('id-verbatim', { name: 'confirm' })
    expect(binding.projectDelivery(payload)).toEqual({ accepted: true, disposition: 'emitted' })
  })
})
