import { createHmac, timingSafeEqual } from 'node:crypto'
import type { FileUploadValue } from '@deepseek-ai/dsh-client-file-upload'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { extname } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { AgUiGatewayError, publicError } from './errors.ts'
import type { ThreadBinding } from './thread.ts'
import type { AgUiPrincipal } from './types.ts'

interface FileRouteOptions {
  readonly path: string
  readonly maxFileBytes: number
  authenticate(request: IncomingMessage): AgUiPrincipal
  validateThreadId(threadId: string): void
  verifyFileUrl(principal: AgUiPrincipal, threadId: string, value: string): FileUploadValue
  bindingFor(principal: AgUiPrincipal, threadId: string): Promise<ThreadBinding>
  respondError(response: ServerResponse, error: AgUiGatewayError): void
}

const MEDIA_TYPES: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.md': 'text/markdown',
}

/**
 * Reduce a decoded client file name to one safe direct child name.
 * @param value - decoded UTF-8 file name supplied by the trusted BFF.
 * @returns a basename safe to join below a thread uploads directory.
 */
export function sanitizeFileName(value: string): string {
  const name = safeBaseName(value)
  if (name === '' || name === '.' || name === '..' || name.startsWith('.') || Buffer.byteLength(name) > 255) {
    throw new AgUiGatewayError('INVALID_FILE_NAME', 'The file name is invalid.', 400)
  }
  return name
}

function safeBaseName(value: string): string {
  // oxlint-disable-next-line no-control-regex -- download headers and upload names must not contain control characters.
  return value.split(/[\\/]/).at(-1)!.replace(/[\u0000-\u001f\u007f]/g, '').trim()
}

/**
 * Build the authenticated thread-file prefix handler owned by one Gateway.
 * @param options - Gateway callbacks and resolved file limits.
 * @returns a WebServer route handler for uploads and downloads.
 */
export function createFileRoute(options: FileRouteOptions): (request: IncomingMessage, response: ServerResponse) => Promise<void> {
  return async (request, response) => {
    try {
      const url = new URL(request.url!, 'http://ag-ui.local')
      const pathname = url.pathname
      const relative = pathname.startsWith(`${options.path}/threads/`)
        ? pathname.slice(`${options.path}/threads/`.length)
        : ''
      const upload = /^([^/]+)\/files$/.exec(relative)
      if (upload !== null) {
        if (request.method !== 'POST') {
          response.setHeader('allow', 'POST')
          throw new AgUiGatewayError('METHOD_NOT_ALLOWED', 'File uploads accept POST requests only.', 405)
        }
        const principal = options.authenticate(request)
        const threadId = decodeThreadId(upload[1]!)
        options.validateThreadId(threadId)
        await uploadFile(request, response, principal, threadId, options)
        return
      }

      const deliverable = /^([^/]+)\/deliverables\/(\d+)\/files\/(\d+)$/.exec(relative)
      if (deliverable !== null) {
        if (request.method !== 'GET') {
          response.setHeader('allow', 'GET')
          throw new AgUiGatewayError('METHOD_NOT_ALLOWED', 'File downloads accept GET requests only.', 405)
        }
        const principal = options.authenticate(request)
        const threadId = decodeThreadId(deliverable[1]!)
        options.validateThreadId(threadId)
        const seq = Number(deliverable[2])
        const index = Number(deliverable[3])
        if (!Number.isSafeInteger(seq) || !Number.isSafeInteger(index)) throw fileNotFound()
        const cancelled = new AbortController()
        const onClosed = (): void => { cancelled.abort() }
        response.once('close', onClosed)
        try {
          const binding = await options.bindingFor(principal, threadId)
          const { path, bytes } = await binding.readDeliverable(seq, index, options.maxFileBytes, cancelled.signal)
          // Native present permits dotfiles; upload intake's naming restrictions do not apply.
          const name = safeBaseName(path) || 'download'
          response.writeHead(200, {
            'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
            'content-length': bytes.byteLength,
            'content-type': MEDIA_TYPES[extname(name).toLowerCase()] ?? 'application/octet-stream',
            'cache-control': 'no-store',
          })
          response.end(bytes)
        } finally {
          response.off('close', onClosed)
        }
        return
      }

      const download = /^([^/]+)\/files\/([^/]+)$/.exec(relative)
      if (download !== null) {
        if (request.method !== 'GET') {
          response.setHeader('allow', 'GET')
          throw new AgUiGatewayError('METHOD_NOT_ALLOWED', 'File downloads accept GET requests only.', 405)
        }
        const principal = options.authenticate(request)
        const threadId = decodeThreadId(download[1]!)
        options.validateThreadId(threadId)
        await downloadFile(response, principal, threadId, download[2]!, url, options)
        return
      }

      throw new AgUiGatewayError('NOT_FOUND', 'The requested AG-UI route was not found.', 404)
    } catch (error) {
      options.respondError(response, publicError(error))
    }
  }
}

async function uploadFile(
  request: IncomingMessage,
  response: ServerResponse,
  principal: AgUiPrincipal,
  threadId: string,
  options: FileRouteOptions,
): Promise<void> {
  const declared = requiredLength(request, options.maxFileBytes)
  const encodedName = singleHeader(request.headers['x-file-name'])
  if (encodedName === undefined) throw new AgUiGatewayError('INVALID_FILE_NAME', 'The x-file-name header is required.', 400)
  const requestedName = sanitizeFileName(decodeFileName(encodedName))
  const mimeType = singleHeader(request.headers['content-type']) ?? 'application/octet-stream'
  const binding = await options.bindingFor(principal, threadId)
  const cancelled = new AbortController()
  const onAborted = (): void => { cancelled.abort() }
  request.once('aborted', onAborted)
  let intakeError: AgUiGatewayError | undefined
  async function* chunks(): AsyncIterable<Uint8Array> {
    let bytes = 0
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
      bytes += buffer.byteLength
      if (bytes > options.maxFileBytes) {
        intakeError = fileTooLarge()
        throw intakeError
      }
      yield buffer
    }
    if (bytes !== declared) {
      intakeError = new AgUiGatewayError('CONTENT_LENGTH_MISMATCH', 'The file body does not match Content-Length.', 400)
      throw intakeError
    }
  }
  let upload: FileUploadValue
  try {
    upload = await binding.uploadFile(chunks(), requestedName, cancelled.signal)
  } catch (error) {
    if (intakeError !== undefined) throw intakeError
    if (request.aborted) return
    throw error
  } finally {
    request.off('aborted', onAborted)
  }
  const { file } = upload
  const body = JSON.stringify({
    type: 'url',
    value: binding.fileUrl(options.path, upload),
    mimeType,
    metadata: { filename: file.name, size: file.bytes, sha256: String(file.attachmentId).replace(/^sha256:/, '') },
  })
  response.writeHead(201, {
    'content-length': Buffer.byteLength(body),
    'content-type': 'application/json; charset=utf-8',
  })
  response.end(body)
}

async function downloadFile(
  response: ServerResponse,
  principal: AgUiPrincipal,
  threadId: string,
  encodedName: string,
  url: URL,
  options: FileRouteOptions,
): Promise<void> {
  const decodedName = decodeFileName(encodedName)
  if (/[\\/]/.test(decodedName)) throw new AgUiGatewayError('INVALID_FILE_NAME', 'The file name is invalid.', 400)
  const name = sanitizeFileName(decodedName)
  const { file } = options.verifyFileUrl(principal, threadId, url.href)
  const binding = await options.bindingFor(principal, threadId)
  response.writeHead(200, {
    'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
    'content-length': file.bytes,
    'content-type': MEDIA_TYPES[extname(name).toLowerCase()] ?? 'application/octet-stream',
  })
  await pipeline(binding.readFile(file), response)
}

function requiredLength(request: IncomingMessage, maximum: number): number {
  const value = singleHeader(request.headers['content-length'])
  if (value === undefined) throw new AgUiGatewayError('LENGTH_REQUIRED', 'Content-Length is required for file uploads.', 411)
  if (!/^\d+$/.test(value)) throw new AgUiGatewayError('INVALID_CONTENT_LENGTH', 'Content-Length must be a non-negative integer.', 400)
  const length = Number(value)
  if (!Number.isSafeInteger(length)) throw fileTooLarge()
  if (length > maximum) throw fileTooLarge()
  return length
}

function decodeThreadId(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch (error) {
    throw new AgUiGatewayError('INVALID_IDENTITY', 'The thread identifier is invalid.', 400, error)
  }
}

function decodeFileName(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch (error) {
    throw new AgUiGatewayError('INVALID_FILE_NAME', 'The file name is invalid.', 400, error)
  }
}

function fileTooLarge(): AgUiGatewayError {
  return new AgUiGatewayError('FILE_TOO_LARGE', 'The uploaded file exceeds its byte limit.', 413)
}

function fileNotFound(): AgUiGatewayError {
  return new AgUiGatewayError('FILE_NOT_FOUND', 'The requested file was not found.', 404)
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/** Sign native file authority for the authenticated thread without a second storage index. */
export function signedFileUrl(path: string, threadId: string, sessionId: string, secret: string, upload: FileUploadValue): string {
  const value = Buffer.from(JSON.stringify(upload)).toString('base64url')
  const signature = signFile(value, sessionId, secret)
  return `${path}/threads/${encodeURIComponent(threadId)}/files/${encodeURIComponent(upload.file.name)}?file=${value}.${signature}`
}

/** Verify thread ownership before returning a host-minted native reference. */
export function verifiedFileUrl(value: string, threadId: string, sessionId: string, secret: string): FileUploadValue {
  const url = new URL(value, 'http://ag-ui.local')
  const match = /\/threads\/([^/]+)\/files\/([^/]+)$/.exec(url.pathname)
  if (match === null || decodeURIComponent(match[1]!) !== threadId) throw fileNotFound()
  const [payload, signature, extra] = (url.searchParams.get('file') ?? '').split('.')
  if (payload === undefined || signature === undefined || extra !== undefined) throw fileNotFound()
  const expected = Buffer.from(signFile(payload, sessionId, secret))
  const actual = Buffer.from(signature)
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw fileNotFound()
  // Only this host can mint a signed payload. It is the native FileUploadValue, without a parallel DTO.
  const upload = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as FileUploadValue
  if (decodeURIComponent(match[2]!) !== upload.file.name) throw fileNotFound()
  return upload
}

function signFile(value: string, sessionId: string, secret: string): string {
  return createHmac('sha256', secret).update(JSON.stringify([sessionId, value])).digest('base64url')
}
