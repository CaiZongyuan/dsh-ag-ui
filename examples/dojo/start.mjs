import { randomBytes } from 'node:crypto'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

process.env.DSH_AG_UI_SHARED_SECRET ||= randomBytes(32).toString('hex')
process.chdir(dirname(fileURLToPath(import.meta.url)))
await import(new URL('../../node_modules/@deepseek-ai/cordis/bin.js', import.meta.url))
