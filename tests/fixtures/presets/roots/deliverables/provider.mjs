import { fileURLToPath } from 'node:url'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import * as Present from '@deepseek-ai/dsh-tool-present'

const cwd = fileURLToPath(new URL('./files/', import.meta.url))

/** A distinct filesystem execution world backed by fixture files, not the host workspace. */
class PresetFileSystem extends LocalFileSystem {
  resolve(path, options) {
    return super.resolve(path, { ...options, cwd })
  }

  lstat(path, _options, signal) {
    return super.lstat(path, { cwd }, signal)
  }
}

export const name = 'isolated-deliverables'

export async function apply(ctx) {
  await ctx.plugin(PresetFileSystem, { cwd })
  await ctx.plugin(Present, { maxFiles: 8 })
}
