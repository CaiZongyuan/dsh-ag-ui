import type { Context } from '@deepseek-ai/cordis'
import LocalAttachments from '@deepseek-ai/dsh-attachment-local'
import FileUploads from '@deepseek-ai/dsh-client-file-upload'
import type { HostConnectionHandle } from '@deepseek-ai/dsh-client-connection'
import Commands from '@deepseek-ai/dsh-commands'

/** Actual native storage and receipt services; the unused Connection carrier only registers its route. */
export async function mountNativeFiles(ctx: Context, dshHome: string): Promise<void> {
  await ctx.plugin(LocalAttachments, { dshHome })
  await ctx.plugin(Commands)
  ctx.provide('connection', { fetch: { register: () => () => {} } } as unknown as HostConnectionHandle)
  await ctx.plugin(FileUploads)
}
