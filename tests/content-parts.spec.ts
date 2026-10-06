import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventType, type InputContent, type RunAgentInput } from '@ag-ui/core'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { AttachmentError } from '@deepseek-ai/dsh-attachment'
import { durableUserId } from '../src/projection.ts'
import { ThreadBinding } from '../src/thread.ts'
import { mountTestAgentCore } from './agent-core.ts'
import { mountNativeFiles } from './native-files.ts'
import { ScriptedAdapter, textResponse } from './scripted-adapter.ts'

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
const contexts: Context[] = []
const roots: string[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function mount(root?: string, threadIdleMs = 60000, onExpired: (binding: ThreadBinding) => void = () => {}, maxRunEvents = 128) {
  const directory = root ?? await mkdtemp(join(tmpdir(), 'native-content-'))
  if (root === undefined) roots.push(directory)
  const ctx = new Context()
  contexts.push(ctx)
  await mountTestAgentCore(ctx)
  await mountNativeFiles(ctx, join(directory, 'native'))
  await ctx.plugin(JsonlSessionPersistence, { root: join(directory, 'sessions'), compression: 'none' })
  ctx.llm.registerAdapter(['scripted'], new ScriptedAdapter(Array.from({ length: 10 }, () => textResponse('ok'))))
  const binding = new ThreadBinding(ctx, { tenantId: 'tenant', userId: 'user' }, 'thread-1', SessionId('native-content'), {
    provider: 'scripted', model: 'scripted', fileSecret: 'test-only-upload-signing-secret', workspaceRoot: join(directory, 'workspaces'),
    frontendToolTimeoutMs: 1000, threadIdleMs, maxRunEvents, maxRunEventBytes: 128 * 1024,
    maxRunsPerThread: 10, maxStateBytes: 64 * 1024, maxFilesPerMessage: 2,
  }, onExpired)
  await binding.initialize()
  return { ctx, binding, directory }
}

async function upload(binding: ThreadBinding, bytes = Buffer.from('report'), name = 'report.txt') {
  const receipt = await binding.uploadFile((async function* () { yield bytes })(), name)
  const source = { type: 'url' as const, value: binding.fileUrl('/ag-ui', receipt), mimeType: 'text/plain' }
  return { receipt, source }
}
function input(id: string, content: string | InputContent[]): RunAgentInput {
  return { threadId: 'thread-1', runId: id, messages: [{ id: `message-${id}`, role: 'user', content }], tools: [], context: [], state: {}, forwardedProps: {} }
}
async function drive(binding: ThreadBinding, id: string, content: string | InputContent[]) {
  const controller = binding.reserveRun(input(id, content), id)
  binding.drive(controller)
  await controller.done
  return controller
}
function users(binding: ThreadBinding) {
  return binding.liveAgent.session.snapshotEvents().flatMap(event => event.type === 'user/message' && event.data.source.kind === 'user' ? [event.data] : [])
}

describe('native file receipt admission', () => {
  it('admits a native file reference and retires its receipt while preserving exact AG-UI content', async () => {
    const { ctx, binding } = await mount()
    const { receipt, source } = await upload(binding)
    const parts: InputContent[] = [{ type: 'text', text: 'Read this' }, { type: 'document', source }]
    const result = await drive(binding, 'first', parts)
    expect(result.record.events.at(-1)?.type).toBe(EventType.RUN_FINISHED)
    expect(users(binding)[0]?.content).toEqual([{ type: 'text', text: 'Read this' }, { type: 'file', attachment: receipt.file }])
    expect(ctx.fileUploads.resolve(binding.liveAgent, receipt.receiptId)).toBeUndefined()
    const replay = await drive(binding, 'history', 'Thanks')
    expect(replay.record.events.find(event => event.type === EventType.MESSAGES_SNAPSHOT)).toMatchObject({ messages: expect.arrayContaining([
      { id: 'message-first', role: 'user', content: parts }, { id: 'message-history', role: 'user', content: 'Thanks' },
    ]) })
    const reuse = await drive(binding, 'reuse', [{ type: 'document', source }])
    expect(reuse.record.events.at(-1)).toMatchObject({ code: 'FILE_NOT_STAGED' })
  })

  it('uses official image admission and preserves the display name', async () => {
    const { binding } = await mount()
    const { source } = await upload(binding, PNG, 'pixel.png')
    const result = await drive(binding, 'image', [{ type: 'image', source: { ...source, mimeType: 'image/png' } }])
    expect(result.record.events.at(-1)?.type).toBe(EventType.RUN_FINISHED)
    expect(users(binding)[0]?.content).toEqual([{ type: 'image', attachment: expect.objectContaining({ name: 'pixel.png', mediaType: 'image/webp', width: 1, height: 1 }) }])
  })

  it('keeps receipt authority on rejected admission so the same upload can retry', async () => {
    const { ctx, binding } = await mount()
    const { receipt, source } = await upload(binding)
    const failed = await drive(binding, 'failed', [
      { type: 'document', source }, { type: 'document', source: { ...source, value: '/ag-ui/threads/thread-1/files/unknown' } },
    ])
    expect(failed.record.events.at(-1)).toMatchObject({ code: 'FILE_NOT_FOUND' })
    expect(users(binding)).toHaveLength(0)
    expect(ctx.fileUploads.resolve(binding.liveAgent, receipt.receiptId)).toEqual(receipt.file)
    expect((await drive(binding, 'retry', [{ type: 'document', source }])).record.events.at(-1)?.type).toBe(EventType.RUN_FINISHED)
  })

  it('rolls back native prompt binding when queue delivery rejects', async () => {
    const { ctx, binding } = await mount()
    const { receipt, source } = await upload(binding)
    vi.spyOn(binding.liveAgent, 'followup').mockImplementationOnce(() => { throw new Error('queue rejected') })
    expect((await drive(binding, 'rejected', [{ type: 'document', source }])).record.events.at(-1)?.type).toBe(EventType.RUN_ERROR)
    ctx.fileUploads.retirePrompt(binding.liveAgent, durableUserId('message-rejected'))
    expect(ctx.fileUploads.resolve(binding.liveAgent, receipt.receiptId)).toEqual(receipt.file)
    expect((await drive(binding, 'retry', [{ type: 'document', source }])).record.events.at(-1)?.type).toBe(EventType.RUN_FINISHED)
  })

  it('cancels a queued file prefix when a later receipt cannot bind and retries only unclaimed messages', async () => {
    const { ctx, binding } = await mount()
    const first = await upload(binding, Buffer.from('first'))
    const second = await upload(binding, Buffer.from('second'))
    const request = input('batch-bind', [{ type: 'document', source: first.source }])
    request.messages.push({ id: 'second-file', role: 'user', content: [{ type: 'document', source: second.source }] })
    const bind = ctx.fileUploads.bindPrompt.bind(ctx.fileUploads)
    vi.spyOn(ctx.fileUploads, 'bindPrompt')
      .mockImplementationOnce(bind)
      .mockImplementationOnce(() => { throw new Error('late binding failure') })
    const failed = binding.reserveRun(request, 'batch-bind')
    binding.drive(failed)
    await failed.done
    expect(failed.record.events.at(-1)).toMatchObject({ code: 'AGENT_EXECUTION_ERROR' })
    expect(users(binding)).toHaveLength(0)
    expect(ctx.fileUploads.resolve(binding.liveAgent, first.receipt.receiptId)).toEqual(first.receipt.file)
    expect(ctx.fileUploads.resolve(binding.liveAgent, second.receipt.receiptId)).toEqual(second.receipt.file)
    // No user message claimed the canceled prefix, so native staged receipts can be bound again.
    const retry = binding.reserveRun({ ...request, runId: 'batch-retry' }, 'batch-retry')
    binding.drive(retry)
    await retry.done
    expect(retry.record.events.at(-1)?.type).toBe(EventType.RUN_FINISHED)
    expect(users(binding).map(message => message.id)).toEqual([
      durableUserId('message-batch-bind'), durableUserId('second-file'),
    ])
    expect(ctx.fileUploads.resolve(binding.liveAgent, second.receipt.receiptId)).toBeUndefined()
  })

  it('does not resurrect explicitly retired native receipts', async () => {
    const { ctx, binding } = await mount()
    const { receipt, source } = await upload(binding)
    using bound = ctx.fileUploads.bindPrompt(binding.liveAgent, [receipt.receiptId], 'cancelled')
    bound.commit()
    ctx.fileUploads.retirePrompt(binding.liveAgent, 'cancelled')
    const result = await drive(binding, 'cancelled-reuse', [{ type: 'document', source }])
    expect(result.record.events.at(-1)).toMatchObject({ code: 'FILE_NOT_STAGED' })
    expect(users(binding)).toHaveLength(0)
  })

  it('restores accepted content on cold resume but requires a new upload for an unsent receipt', async () => {
    const first = await mount()
    const accepted = await upload(first.binding)
    await drive(first.binding, 'accepted', [{ type: 'document', source: accepted.source }])
    const pending = await upload(first.binding, Buffer.from('pending'))
    await first.binding.dispose()
    await first.ctx.fiber.dispose()
    contexts.splice(contexts.indexOf(first.ctx), 1)
    const second = await mount(first.directory)
    expect(users(second.binding)[0]?.content).toEqual([{ type: 'file', attachment: accepted.receipt.file }])
    const result = await drive(second.binding, 'cold-pending', [{ type: 'document', source: pending.source }])
    expect(result.record.events.at(-1)).toMatchObject({ code: 'FILE_NOT_STAGED' })
    const chunks = []
    for await (const chunk of second.binding.readFile(second.binding.fileFromUrl(accepted.source.value).file)) chunks.push(chunk)
    expect(Buffer.concat(chunks).toString()).toBe('report')
  })

  it('rejects another thread, modified signature and unsigned URLs before admission', async () => {
    const { binding } = await mount()
    const { source } = await upload(binding)
    for (const [index, value] of [source.value.replace('thread-1', 'thread-2'), `${source.value}x`, source.value.split('?')[0]!].entries()) {
      const result = await drive(binding, `foreign-${index}`, [{ type: 'document', source: { ...source, value } }])
      expect(result.record.events.at(-1)).toMatchObject({ code: 'FILE_NOT_FOUND' })
    }
    expect(users(binding)).toHaveLength(0)
  })

  it('rejects inline bytes and excessive files at the gateway boundary', async () => {
    const { binding } = await mount()
    expect((await drive(binding, 'inline', [{ type: 'binary', mimeType: 'text/plain', data: 'YQ==' }])).record.events.at(-1)).toMatchObject({ code: 'UNSUPPORTED_CONTENT_PART' })
    const part = { type: 'document' as const, source: { type: 'url' as const, value: '/unused' } }
    expect((await drive(binding, 'limit', [part, part, part])).record.events.at(-1)).toMatchObject({ code: 'FILE_LIMIT_EXCEEDED' })
  })
  it('admits text parts and mixed messages in one run', async () => {
    const { binding } = await mount()
    expect((await drive(binding, 'text-parts', [{ type: 'text', text: 'hello' }])).record.events.at(-1)?.type).toBe(EventType.RUN_FINISHED)
    const { source } = await upload(binding)
    const request = input('mixed', 'first')
    request.messages.push({ id: 'file-message', role: 'user', content: [{ type: 'document', source: { type: 'url', value: source.value } }] })
    const run = binding.reserveRun(request, 'mixed')
    binding.drive(run)
    await run.done
    expect(run.record.events.at(-1)?.type).toBe(EventType.RUN_FINISHED)
  })

  it('contains malformed and oversized image admission before appending messages', async () => {
    const { ctx, binding } = await mount()
    const { source } = await upload(binding, Buffer.from('invalid image'), 'image.bmp')
    const badMedia = await drive(binding, 'bad-media', [{ type: 'image', source: { ...source, mimeType: 'image/bmp' } }])
    expect(badMedia.record.events.at(-1)).toMatchObject({ code: 'UNSUPPORTED_MEDIA_TYPE' })
    const invalid = await drive(binding, 'invalid-image', [{ type: 'image', source: { ...source, mimeType: 'image/png' } }])
    expect(invalid.record.events.at(-1)).toMatchObject({ code: 'INVALID_IMAGE' })
    vi.spyOn(ctx.attachments, 'admitPromptContent').mockRejectedValueOnce(new Error('backend offline'))
    expect((await drive(binding, 'offline', [{ type: 'document', source }])).record.events.at(-1)?.type).toBe(EventType.RUN_ERROR)
    vi.spyOn(ctx.attachments, 'admitPromptContent').mockRejectedValueOnce(new AttachmentError('Rejected', 'INVALID_IMAGE'))
    expect((await drive(binding, 'attachment-error', [{ type: 'document', source }])).record.events.at(-1)).toMatchObject({ code: 'INVALID_IMAGE' })
    const huge = await upload(binding, Buffer.alloc(ctx.attachments.imageLimits.maxImageBytes + 1), 'large.png')
    expect((await drive(binding, 'huge', [{ type: 'image', source: { ...huge.source, mimeType: 'image/png' } }])).record.events.at(-1)).toMatchObject({ code: 'ATTACHMENT_TOO_LARGE' })
    expect(users(binding)).toHaveLength(0)
  })

  it('retains the upload receipt when its accepted-history snapshot cannot fit', async () => {
    const { ctx, binding } = await mount(undefined, 60000, undefined, 2)
    const { receipt, source } = await upload(binding)
    const run = await drive(binding, 'snapshot-overflow', [{ type: 'document', source }])
    expect(run.record.events.at(-1)).toMatchObject({ code: 'AG_UI_EVENT_BUFFER_OVERFLOW' })
    expect(users(binding)).toHaveLength(0)
    expect(ctx.fileUploads.resolve(binding.liveAgent, receipt.receiptId)).toEqual(receipt.file)
  })

  it.each([
    ['ag_ui_update_state', 'SHARED_STATE_TOOL_COLLISION'],
    ['browser_file', 'FRONTEND_TOOL_NAME_COLLISION'],
  ])('rejects a late %s collision before publishing unaccepted files and permits retry', async (name, code) => {
    const { ctx, binding } = await mount()
    const { receipt, source } = await upload(binding)
    const gate = Promise.withResolvers<void>()
    const entered = Promise.withResolvers<void>()
    const admit = ctx.attachments.admitPromptContent.bind(ctx.attachments)
    vi.spyOn(ctx.attachments, 'admitPromptContent').mockImplementationOnce(async parts => {
      entered.resolve()
      await gate.promise
      return admit(parts)
    })
    const request = {
      ...input('collision', [{ type: 'document', source }]), state: { value: 1 },
      tools: [{ name: 'browser_file', description: 'Display a file.', parameters: { type: 'object', properties: {} } }],
    }
    const run = binding.reserveRun(request, 'collision')
    binding.drive(run)
    await entered.promise
    const unregister = ctx.tools.register({
      name, description: 'A newly mounted conflicting Tool.',
      parameters: { type: 'object', properties: {} },
      output: { schema: { type: 'string' }, render: () => [{ type: 'text', text: 'ok' }] },
      execute: () => Promise.resolve('ok'),
    })
    gate.resolve()
    await run.done
    expect(run.record.events.at(-1)).toMatchObject({ code })
    expect(run.record.events.some(event => event.type === EventType.MESSAGES_SNAPSHOT)).toBe(false)
    expect(users(binding)).toHaveLength(0)
    expect(ctx.fileUploads.resolve(binding.liveAgent, receipt.receiptId)).toEqual(receipt.file)
    unregister()
    const retry = binding.reserveRun({ ...request, runId: 'corrected' }, 'corrected')
    binding.drive(retry)
    await retry.done
    expect(retry.record.events.at(-1)?.type).toBe(EventType.RUN_FINISHED)
    expect(users(binding)).toHaveLength(1)
    expect(ctx.fileUploads.resolve(binding.liveAgent, receipt.receiptId)).toBeUndefined()
  })

  it.each([false, true])('does not dispatch or settle twice after disconnect during file admission (late error: %s)', async lateError => {
    const { ctx, binding } = await mount()
    const { source } = await upload(binding)
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const admit = ctx.attachments.admitPromptContent.bind(ctx.attachments)
    vi.spyOn(ctx.attachments, 'admitPromptContent').mockImplementationOnce(async parts => {
      await gate
      if (lateError) throw new Error('late attachment failure')
      return admit(parts)
    })
    const run = binding.reserveRun(input('disconnect', [{ type: 'document', source }]), 'disconnect')
    binding.drive(run)
    binding.disconnect(run)
    release()
    await run.done
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(users(binding)).toHaveLength(0)
    expect(run.record.events.filter(event => event.type === EventType.RUN_ERROR)).toEqual([
      expect.objectContaining({ code: 'CLIENT_DISCONNECTED' }),
    ])
  })

  it('fails clearly when a text-only host has no native files or signing configuration', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await mountTestAgentCore(ctx)
    const binding = new ThreadBinding(ctx, { tenantId: 't', userId: 'u' }, 't', SessionId('text-only'), {
      provider: 'scripted', model: 'scripted', frontendToolTimeoutMs: 1000, workspaceRoot: tmpdir(),
      threadIdleMs: 1000, maxRunEvents: 100, maxRunEventBytes: 100000, maxRunsPerThread: 10,
      maxStateBytes: 1000, maxFilesPerMessage: 2,
    }, () => {})
    const { receipt } = await upload((await mount()).binding)
    await expect(binding.uploadFile((async function* () {})(), 'x')).rejects.toThrow('native file uploads')
    await expect(binding.readFile(receipt.file)[Symbol.asyncIterator]().next()).rejects.toThrow('attachment storage')
    expect(() => binding.fileUrl('/ag-ui', receipt)).toThrow('signing is not configured')
    expect(() => binding.fileFromUrl('/missing')).toThrow('not found')
  })

  it('holds native receipts through slow concurrent file operations and grants fresh idle time after settlement', async () => {
    const expired = vi.fn((binding: ThreadBinding) => { void binding.dispose() })
    const { ctx, binding } = await mount(undefined, 1000, expired)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    // Reset the real initialization timer through one ordinary successful upload.
    const initial = await upload(binding)
    try {
      await vi.advanceTimersByTimeAsync(900)
      let release!: () => void
      let entered!: () => void
      const gate = new Promise<void>(resolve => { release = resolve })
      const reading = new Promise<void>(resolve => { entered = resolve })
      const pending = binding.uploadFile((async function* () {
        entered()
        yield Buffer.from('first')
        await gate
        yield Buffer.from('last')
      })(), 'slow.txt')
      await reading
      await vi.advanceTimersByTimeAsync(2000)
      expect(expired).not.toHaveBeenCalled()
      // Completing a concurrent download must not start expiry while upload is still pending.
      for await (const _chunk of binding.readFile(initial.receipt.file)) { /* drain native read */ }
      await vi.advanceTimersByTimeAsync(2000)
      expect(expired).not.toHaveBeenCalled()
      release()
      const completed = await pending
      expect(ctx.fileUploads.resolve(binding.liveAgent, completed.receiptId)).toEqual(completed.file)
      await vi.advanceTimersByTimeAsync(999)
      expect(expired).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      expect(expired).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  it('releases file activity after canceled intake and abandoned reads', async () => {
    const expired = vi.fn()
    const { binding } = await mount(undefined, 1000, expired)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const initial = await upload(binding)
    try {
      await expect(binding.uploadFile((async function* () { yield Buffer.from('partial'); throw new Error('cancelled intake') })(), 'cancel.txt')).rejects.toThrow()
      await vi.advanceTimersByTimeAsync(999)
      expect(expired).not.toHaveBeenCalled()
      const read = binding.readFile(initial.receipt.file)[Symbol.asyncIterator]()
      await read.next()
      await vi.advanceTimersByTimeAsync(2000)
      expect(expired).not.toHaveBeenCalled()
      await read.return?.()
      await vi.advanceTimersByTimeAsync(1000)
      expect(expired).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

})
