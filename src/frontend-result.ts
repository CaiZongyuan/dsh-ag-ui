import { createHash } from 'node:crypto'
import type { ToolMessage } from '@ag-ui/core'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

/** Gateway-owned durable identity. Never expose this field as client metadata. */
const FRONTEND_RESULT_ID = '@dsh-ag-ui/frontend-result-id'

type ResultIdentity = { id: string, hasMetadata: boolean, encryptedValue?: string, subagentRunId?: string }

/** Called only after admission validates the result metadata as lossless JSON. */
export function frontendResultMeta(message: ToolMessage): JsonValue {
  const identity: ResultIdentity = {
    id: message.id,
    hasMetadata: message.metadata !== undefined,
    ...(message.encryptedValue === undefined ? {} : { encryptedValue: message.encryptedValue }),
    ...(message.subagentRunId === undefined ? {} : { subagentRunId: message.subagentRunId }),
  }
  return { ...structuredClone(message.metadata), [FRONTEND_RESULT_ID]: identity }
}

function isResultIdentity(value: JsonValue | undefined): value is ResultIdentity {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && typeof value.id === 'string' && typeof value.hasMetadata === 'boolean'
    && (value.encryptedValue === undefined || typeof value.encryptedValue === 'string')
    && (value.subagentRunId === undefined || typeof value.subagentRunId === 'string')
}

/** Recover accepted fields and strip only the private field, preserving native presentation metadata. */
export function projectedResultMeta(meta: JsonValue | undefined): Partial<Pick<ToolMessage, 'id' | 'encryptedValue' | 'subagentRunId'>> & { metadata: JsonValue | undefined } {
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return { metadata: meta }
  const { [FRONTEND_RESULT_ID]: value, ...metadata } = structuredClone(meta)
  if (!isResultIdentity(value)) return { metadata }
  return {
    id: value.id,
    ...(value.encryptedValue === undefined ? {} : { encryptedValue: value.encryptedValue }),
    ...(value.subagentRunId === undefined ? {} : { subagentRunId: value.subagentRunId }),
    metadata: !value.hasMetadata && Object.keys(metadata).length === 0 ? undefined : metadata,
  }
}

/** Compare the public result, including optional fields, independently of JSON object key order. */
export function frontendResultDigest(message: ToolMessage): string {
  const metadata = message.metadata === undefined ? undefined
    : Object.fromEntries(Object.entries(message.metadata).filter(([key]) => key !== FRONTEND_RESULT_ID))
  const serialized = JSON.stringify({ ...message, metadata }, (_key, value: unknown) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return value
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)))
  })
  return createHash('sha256').update(serialized).digest('hex')
}
