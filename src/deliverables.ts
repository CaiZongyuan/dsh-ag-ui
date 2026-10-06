import type { ActivityMessage } from '@ag-ui/core'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
// Keep the native session-event augmentation in emitted declarations without a runtime import.
export type { PresentedFile } from '@deepseek-ai/dsh-tool-present/types'

/** Validate recovered declarations before exposing file authority or transcript content. */
export function isPresentedEvent(event: SessionEvent): event is Extract<SessionEvent, { type: 'deliverables/presented' }> {
  if (event.type !== 'deliverables/presented') return false
  const data: unknown = event.data
  return typeof data === 'object' && data !== null
    && 'turn' in data && Number.isSafeInteger(data.turn) && typeof data.turn === 'number' && data.turn >= 1
    && 'callId' in data && typeof data.callId === 'string' && data.callId.length > 0
    && 'files' in data && Array.isArray(data.files) && data.files.length > 0
    && data.files.every((file: unknown) =>
      typeof file === 'object' && file !== null
      && 'path' in file && typeof file.path === 'string' && file.path.trim().length > 0
      && (!('description' in file) || typeof file.description === 'string'))
}

/** Both streaming and cold history derive the same activity from its native declaration. */
export function deliverableMessage(
  sessionId: SessionId,
  event: Extract<SessionEvent, { type: 'deliverables/presented' }>,
  fileUrl: (seq: number, index: number) => string,
): ActivityMessage {
  return {
    id: `ag-ui:${String(sessionId)}:${String(event.seq)}:deliverables`,
    role: 'activity',
    activityType: 'dsh-deliverables',
    content: {
      turn: event.data.turn,
      callId: event.data.callId,
      files: event.data.files.map((file, index) => ({ ...file, url: fileUrl(event.seq, index) })),
    },
  }
}
