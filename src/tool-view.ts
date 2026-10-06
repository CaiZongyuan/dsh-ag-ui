/**
 * Presenter projection: DSH render-intent cards wrapped as AG-UI CUSTOM events.
 * @module dsh-ag-ui/src/tool-view
 */

import { EventType, type CustomEvent } from '@ag-ui/core'
import type { ContentBlock, ToolResultMessage } from '@deepseek-ai/dsh-llm'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { ToolCallView, ToolDefinition, ToolResultView } from '@deepseek-ai/dsh-tools'

/** CUSTOM event name carrying one presenter card beside the standard tool events. */
export const TOOL_VIEW_NAME = 'dsh:tool:view'

/** Envelope version; bumps whenever the wrapped card vocabulary changes. */
const TOOL_VIEW_VERSION = 1

/** Whether an envelope presents the pending call or its completed result. */
export type ToolViewPhase = 'call' | 'result'

/** Versioned wrapper around one DSH render-intent card. */
export interface ToolViewEnvelope {
  readonly version: number
  readonly callId: string
  readonly toolName: string
  readonly phase: ToolViewPhase
  readonly card: ToolCallView | ToolResultView
}

/** The durable outcome handed to a tool's present-result intent. */
interface ToolViewResult {
  readonly content: ContentBlock[]
  readonly isError: boolean
  readonly meta?: JsonValue
}

/**
 * The context-aware seam the pure projection evaluates intents through: it
 * resolves the definition the executing scope sees, and names the client-owned
 * frontend Tools that present themselves and stay out of card projection.
 */
export interface ToolPresenter {
  /** The definition the owning scope resolves for one tool name, or undefined when none is visible. */
  resolve(name: string): ToolDefinition | undefined
  /** Whether a name is a client-declared frontend Tool excluded from card projection. */
  isFrontendTool(name: string): boolean
}

/** Parse one durable tool call's raw model arguments; an unparseable body stays raw. */
export function parseToolArguments(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

/** Assemble the durable outcome one present-result intent reads, from its logged copy. */
export function toolViewResultOf(block: ToolResultMessage, meta: JsonValue | undefined): ToolViewResult {
  return {
    content: [...block.content],
    isError: block.isError === true,
    ...(meta === undefined ? {} : { meta }),
  }
}

/** Evaluate one presenter intent, soft-falling to undefined on any failure. */
function soft<T>(evaluate: () => T | undefined): T | undefined {
  try {
    return evaluate()
  } catch {
    return undefined
  }
}

/** Present the pending state of one backend call, soft-falling to the generic card. */
export function toolViewCallEnvelope(callId: string, toolName: string, args: unknown, presenter: ToolPresenter): ToolViewEnvelope {
  const card = soft(() => presenter.resolve(toolName)?.presentCall?.(args))
  return {
    version: TOOL_VIEW_VERSION,
    callId,
    toolName,
    phase: 'call',
    card: card ?? { card: 'generic', title: toolName, rawInput: args },
  }
}

/** Present the completed state of one backend call, soft-falling to the generic result card. */
export function toolViewResultEnvelope(
  callId: string,
  toolName: string,
  args: unknown,
  result: ToolViewResult,
  presenter: ToolPresenter,
): ToolViewEnvelope {
  const card = soft(() => presenter.resolve(toolName)?.presentResult?.(args, result))
  return {
    version: TOOL_VIEW_VERSION,
    callId,
    toolName,
    phase: 'result',
    card: card ?? { card: 'generic' },
  }
}

/** Wrap one card envelope as the CUSTOM event a UI renders it from. */
export function toolViewEvent(envelope: ToolViewEnvelope): CustomEvent {
  return { type: EventType.CUSTOM, name: TOOL_VIEW_NAME, value: envelope }
}
