import type { AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import { EventType, type BaseEvent, type CustomEvent, type Message as AgUiMessage } from '@ag-ui/core'
import type { ContentBlock, ToolResultBlock } from '@deepseek-ai/dsh-llm'
import { type SessionId, type SessionEvent, type TurnEndReason } from '@deepseek-ai/dsh-session'
import {
  parseToolArguments,
  toolViewCallEnvelope,
  toolViewEvent,
  toolViewResultEnvelope,
  toolViewResultOf,
  type ToolPresenter,
  type ToolViewEnvelope,
} from './tool-view.ts'

/** Reserved model-facing Tool that shallow-merges shared application state. */
export const STATE_TOOL_NAME = 'ag_ui_update_state'

/** Prefix marking durable user-message ids derived from client AG-UI ids. */
const USER_ID_PREFIX = 'ag-ui:user:'

/** Durable user-message identity derived from the client's AG-UI message id. */
export function durableUserId(clientId: string): string {
  return `${USER_ID_PREFIX}${clientId}`
}

/** Whether one durable user-message id carries a derived client identity. */
function clientUserId(durableId: string): string | undefined {
  return durableId.startsWith(USER_ID_PREFIX) ? durableId.slice(USER_ID_PREFIX.length) : undefined
}

/** Facts rebuilt from one durable log at cold resume. */
interface ColdRecovery {
  /** The log's last turn ended interrupted by crash recovery. */
  readonly interrupted: boolean
  /** Recovered user messages, as (client id, text content) pairs in log order. */
  readonly users: ReadonlyArray<{ readonly clientId: string; readonly content: string }>
}

/** Where a tool call sits inside its DSH session. */
interface ToolCallPosition {
  readonly turn: number
  readonly step: number
  readonly name: string
}

/** State-tool outcome staged by the thread binding until its durable result. */
interface PendingStateCommit {
  readonly value: unknown
  readonly changed: boolean
}

export type ToolCallLifecycle =
  | ({ readonly kind: 'backend' } & ToolCallPosition)
  | ({ readonly kind: 'frontend'; readonly parked: true } & ToolCallPosition)
  | ({ readonly kind: 'awaiting' } & ToolCallPosition)
  | ({ readonly kind: 'state'; commit?: PendingStateCommit } & ToolCallPosition)

/** How the active AG-UI run should settle after a translated event. */
type RunOutcome =
  | { readonly kind: 'success' }
  | { readonly kind: 'error'; readonly code: string; readonly message: string }

/** Pure translation result for one session event. */
interface ProjectionStep {
  readonly events: BaseEvent[]
  readonly outcome?: RunOutcome
}

interface TextProjection {
  readonly messageId: string
  started: boolean
}

/** Which calls a step's assistant message announced, and how many streamed. */
interface StepToolProgress {
  readonly announced: readonly string[]
  streamed: number
}

const EMPTY_STEP: ProjectionStep = { events: [] }

/**
 * Pure translation of one DSH session's durable events and transient assistant
 * frames into AG-UI wire events, without I/O, timers, or agent handles. The
 * owning thread binding feeds both channels and applies the returned events
 * and run outcome to its active run controller.
 */
export class SessionProjection {
  private stream: Extract<AssistantStreamFrame, { type: 'start' }> | undefined
  private readonly text = new Map<string, TextProjection>()
  private readonly toolCallLifecycles = new Map<string, ToolCallLifecycle>()
  private readonly stepProgress = new Map<string, StepToolProgress>()
  private readonly serverResultCallIds = new Set<string>()
  private readonly callArguments = new Map<string, unknown>()

  /** Shared application state carried between runs; committed by state-tool results. */
  sharedState: unknown

  constructor(private readonly sessionId: SessionId, private readonly presenter: ToolPresenter) {}

  /** Project transient provider chunks using the turn and step of their stream start. */
  projectStream(frame: AssistantStreamFrame, activeTurn: number | undefined): ProjectionStep {
    if (frame.type === 'start') {
      this.stream = frame
      return EMPTY_STEP
    }
    const stream = this.stream
    if (frame.type === 'end') {
      this.stream = undefined
      return EMPTY_STEP
    }
    if (stream === undefined || stream.turn !== activeTurn || frame.chunk.type !== 'text-delta') return EMPTY_STEP
    const projection = this.textProjection(stream.turn, stream.step)
    const events: BaseEvent[] = []
    if (!projection.started) {
      projection.started = true
      events.push({ type: EventType.TEXT_MESSAGE_START, messageId: projection.messageId, role: 'assistant' })
    }
    events.push({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: projection.messageId, delta: frame.chunk.text })
    return { events }
  }

  /**
   * Translate one session event against the active run's DSH turn.
   * @param event - durable session event of any kind.
   * @param activeTurn - turn the active run observes, or undefined while idle.
   */
  project(event: SessionEvent, activeTurn: number | undefined): ProjectionStep {
    if (event.type === 'step/end') {
      this.stepProgress.delete(`${String(event.data.turn)}:${String(event.data.step)}`)
      return EMPTY_STEP
    }
    if (activeTurn === undefined || !eventBelongsToTurn(event, activeTurn)) return EMPTY_STEP

    switch (event.type) {
      case 'assistant/message': {
        const announced = announcedToolNames(event.data.message.content)
        if (announced.length > 0) {
          this.stepProgress.set(`${String(event.data.turn)}:${String(event.data.step)}`, {
            announced,
            streamed: 0,
          })
        }
        const projection = this.textProjection(event.data.turn, event.data.step)
        if (!projection.started) {
          const text = joinText(event.data.message.content)
          if (text !== '') {
            projection.started = true
            return {
              events: [
                { type: EventType.TEXT_MESSAGE_START, messageId: projection.messageId, role: 'assistant' },
                { type: EventType.TEXT_MESSAGE_CONTENT, messageId: projection.messageId, delta: text },
                { type: EventType.TEXT_MESSAGE_END, messageId: projection.messageId },
              ],
            }
          }
        }
        if (projection.started) return { events: [{ type: EventType.TEXT_MESSAGE_END, messageId: projection.messageId }] }
        return EMPTY_STEP
      }
      case 'tool/call': {
        const callId = String(event.data.callId)
        const progress = this.stepProgress.get(`${String(event.data.turn)}:${String(event.data.step)}`)
        if (progress !== undefined) progress.streamed += 1
        this.toolCallLifecycles.set(callId, {
          kind: event.data.name === STATE_TOOL_NAME ? 'state' : 'backend',
          turn: event.data.turn,
          step: event.data.step,
          name: event.data.name,
        })
        if (event.data.name === STATE_TOOL_NAME) return EMPTY_STEP
        const args = parseToolArguments(event.data.arguments)
        this.callArguments.set(callId, args)
        // the client presents its own Tools, so only host and preset calls carry a card
        const view = this.presenter.isFrontendTool(event.data.name)
          ? []
          : [toolViewEvent(toolViewCallEnvelope(callId, event.data.name, args, this.presenter))]
        return {
          events: [
            {
              type: EventType.TOOL_CALL_START,
              toolCallId: callId,
              toolCallName: event.data.name,
              parentMessageId: assistantMessageId(this.sessionId, event.data.turn, event.data.step),
            },
            { type: EventType.TOOL_CALL_ARGS, toolCallId: callId, delta: event.data.arguments },
            { type: EventType.TOOL_CALL_END, toolCallId: callId },
            ...view,
          ],
        }
      }
      case 'tool/result': {
        const block = event.data.message.content[0]
        const callId = String(block.toolCallId)
        const lifecycle = this.toolCallLifecycles.get(callId)
        this.toolCallLifecycles.delete(callId)
        const args = this.callArguments.get(callId)
        this.callArguments.delete(callId)
        if (lifecycle?.kind === 'state') {
          const commit = lifecycle.commit
          if (commit !== undefined && !block.isError && commit.changed) {
            this.sharedState = structuredClone(commit.value)
            return { events: [{ type: EventType.STATE_SNAPSHOT, snapshot: structuredClone(commit.value) }] }
          }
          return EMPTY_STEP
        }
        this.serverResultCallIds.add(callId)
        if (lifecycle?.kind === 'frontend' || lifecycle?.kind === 'awaiting') return EMPTY_STEP
        const result = {
          type: EventType.TOOL_CALL_RESULT,
          messageId: resultMessageId(this.sessionId, callId),
          toolCallId: callId,
          content: renderToolResult(block),
          role: 'tool',
        }
        if (lifecycle === undefined) return { events: [result] }
        return {
          events: [
            result,
            toolViewEvent(toolViewResultEnvelope(callId, lifecycle.name, args, toolViewResultOf(block, event.data.meta), this.presenter)),
          ],
        }
      }
      case 'turn/end': {
        this.clearTurn(event.data.turn)
        return { events: [], outcome: turnOutcome(event.data.reason) }
      }
      default:
        return EMPTY_STEP
    }
  }

  /** Live lifecycle of one tool call, for parking and state-commit validation. */
  lifecycleOf(callId: string): ToolCallLifecycle | undefined {
    return this.toolCallLifecycles.get(callId)
  }

  /** Transition one validated backend call of this session to parked. */
  markParked(callId: string, lifecycle: ToolCallLifecycle & { kind: 'backend' }): void {
    this.toolCallLifecycles.set(callId, { ...lifecycle, kind: 'frontend', parked: true })
  }

  /** Record the client's answer to a parked call; its durable result is pending. */
  markAwaitingResult(callId: string): void {
    const lifecycle = this.toolCallLifecycles.get(callId)
    if (lifecycle?.kind === 'frontend') {
      this.toolCallLifecycles.set(callId, {
        kind: 'awaiting',
        turn: lifecycle.turn,
        step: lifecycle.step,
        name: lifecycle.name,
      })
    }
  }

  /**
   * Whether a run observing this step may finish after a park: a call is
   * parked, no answered call still awaits its durable result, and no further
   * announced call would start while the park holds the scheduler pool.
   * Un-resulted server calls do not block: DSH commits results in model
   * order, so a call after a parked one cannot commit until the parked call
   * resolves, and its result reaches the client through a later run instead.
   * Steps without an announcement settle at the first park.
   * @param startsWhileParked - whether one announced call would still start.
   */
  parkSettleReady(turn: number, step: number, startsWhileParked: (name: string) => boolean): boolean {
    let parked = false
    for (const lifecycle of this.toolCallLifecycles.values()) {
      if (lifecycle.turn !== turn || lifecycle.step !== step) continue
      if (lifecycle.kind === 'awaiting') return false
      if (lifecycle.kind === 'frontend') parked = true
    }
    if (!parked) return false
    const progress = this.stepProgress.get(`${String(turn)}:${String(step)}`)
    if (progress === undefined) return true
    const next = progress.announced[progress.streamed]
    return next === undefined || !startsWhileParked(next)
  }

  /** Attach a prepared shared-state commit to its live state call. */
  stageCommit(callId: string, commit: PendingStateCommit): void {
    const lifecycle = this.toolCallLifecycles.get(callId)
    if (lifecycle?.kind === 'state') this.toolCallLifecycles.set(callId, { ...lifecycle, commit })
  }

  /** Consume one recorded backend result id so a re-sent ToolMessage is accepted. */
  consumeServerResult(callId: string): boolean {
    return this.serverResultCallIds.delete(callId)
  }

  /**
   * Rebuild resume bookkeeping from one recovered durable log: recorded server
   * results accept re-sent ToolMessages again, derived user ids recover the
   * durable-to-client mapping, and an interrupted turn tail marks the thread.
   * @param events - the session's recovered event log, in order.
   * @returns cold-resume facts for the owning thread binding.
   */
  recoverFrom(events: readonly SessionEvent[]): ColdRecovery {
    let interrupted = false
    const users: Array<{ clientId: string, content: string }> = []
    for (const event of events) {
      if (event.type === 'user/message') {
        if (event.data.source.kind !== 'user') continue
        const clientId = clientUserId(String(event.data.id))
        if (clientId !== undefined) users.push({ clientId, content: joinText(event.data.content) })
      } else if (event.type === 'tool/result') {
        this.serverResultCallIds.add(String(event.data.message.content[0].toolCallId))
      } else if (event.type === 'turn/end') {
        interrupted = event.data.reason.kind === 'interrupted'
      }
    }
    return { interrupted, users }
  }

  /** Drop call bookkeeping for one finished turn. */
  clearTurn(turn: number): void {
    for (const [callId, lifecycle] of this.toolCallLifecycles) {
      if (lifecycle.turn === turn) {
        this.toolCallLifecycles.delete(callId)
        this.callArguments.delete(callId)
      }
    }
    for (const key of this.stepProgress.keys()) {
      if (key.startsWith(`${String(turn)}:`)) this.stepProgress.delete(key)
    }
  }

  /**
   * Derive the full AG-UI message history from the durable session log, with
   * ids identical to the streaming projections: user messages keep the ids the
   * client sent, assistant messages use the step identity, tool results use the
   * call identity.
   * @param events - the session's durable event log, in order.
   * @param userMessageId - durable user message id to the client's AG-UI id; unmapped messages (injected context, foreign sessions) are skipped.
   */
  messagesSnapshot(events: readonly SessionEvent[], userMessageId: (durableId: string) => string | undefined): AgUiMessage[] {
    const messages: AgUiMessage[] = []
    for (const event of events) {
      if (event.type === 'user/message') {
        if (event.data.source.kind !== 'user') continue
        const id = userMessageId(String(event.data.id))
        if (id === undefined) continue
        messages.push({ id, role: 'user', content: joinText(event.data.content) })
      } else if (event.type === 'assistant/message') {
        const text = joinText(event.data.message.content)
        if (text === '') continue
        messages.push({
          id: assistantMessageId(this.sessionId, event.data.turn, event.data.step),
          role: 'assistant',
          content: text,
        })
      } else if (event.type === 'tool/result') {
        const block = event.data.message.content[0]
        const callId = String(block.toolCallId)
        messages.push({
          id: resultMessageId(this.sessionId, callId),
          role: 'tool',
          toolCallId: callId,
          content: renderToolResult(block),
        })
      }
    }
    return messages
  }

  /**
   * Derive the settled card projection of one durable log: a result envelope
   * for every completed backend tool call, mirroring the message snapshot,
   * which shows completed calls only. The same evaluator and inputs as the
   * live path, so a cold transcript read renders the identical cards. The
   * reserved state tool, client-owned frontend Tools, and calls whose Tool no
   * longer resolves in the owning scope — a crash-materialized frontend call
   * after a restart — stay excluded.
   * @param events - the session's durable event log, in order.
   * @returns CUSTOM `dsh:tool:view` events for the completed backend calls.
   */
  toolViewEvents(events: readonly SessionEvent[]): CustomEvent[] {
    const envelopes: ToolViewEnvelope[] = []
    const calls = new Map<string, { toolName: string, args: unknown }>()
    for (const event of events) {
      if (event.type === 'tool/call') {
        calls.set(String(event.data.callId), { toolName: event.data.name, args: parseToolArguments(event.data.arguments) })
      } else if (event.type === 'tool/result') {
        const block = event.data.message.content[0]
        const callId = String(block.toolCallId)
        const call = calls.get(callId)
        if (call === undefined) continue
        calls.delete(callId)
        if (call.toolName === STATE_TOOL_NAME
          || this.presenter.isFrontendTool(call.toolName)
          || this.presenter.resolve(call.toolName) === undefined) continue
        envelopes.push(toolViewResultEnvelope(callId, call.toolName, call.args, toolViewResultOf(block, event.data.meta), this.presenter))
      }
    }
    return envelopes.map(toolViewEvent)
  }

  private textProjection(turn: number, step: number): TextProjection {
    const key = `${String(turn)}:${String(step)}`
    let projection = this.text.get(key)
    if (projection === undefined) {
      projection = { messageId: assistantMessageId(this.sessionId, turn, step), started: false }
      this.text.set(key, projection)
    }
    return projection
  }
}

/** Whether a durable event carries the selected turn. */
function eventBelongsToTurn(event: SessionEvent, turn: number): boolean {
  if (!('turn' in event.data)) return false
  return event.data.turn === turn
}

/** Deterministic AG-UI assistant message identity for one DSH step. */
function assistantMessageId(sessionId: SessionId, turn: number, step: number): string {
  return `ag-ui:${String(sessionId)}:${String(turn)}:${String(step)}:assistant`
}

/** Deterministic AG-UI tool-result message identity for one DSH tool call. */
function resultMessageId(sessionId: SessionId, callId: string): string {
  return `ag-ui:${String(sessionId)}:${callId}:result`
}

/** Names of the tool calls one assistant message announced, in model order. */
function announcedToolNames(content: readonly ContentBlock[]): string[] {
  return content.filter(block => block.type === 'tool-call').map(block => block.name)
}

/** Concatenate the text blocks of one message's content. */
function joinText(content: readonly ContentBlock[]): string {
  return content
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('')
}

/** Map one DSH turn-end reason onto the AG-UI run outcome. */
function turnOutcome(reason: TurnEndReason): RunOutcome {
  switch (reason.kind) {
    case 'completed':
    case 'max-tokens':
      return { kind: 'success' }
    case 'error':
      return { kind: 'error', code: reason.error.code, message: reason.error.message }
    case 'aborted':
      return { kind: 'error', code: 'AGENT_ABORTED', message: 'The DSH turn was aborted.' }
    case 'blocked':
      return { kind: 'error', code: 'AGENT_BLOCKED', message: 'The DSH turn was blocked before completion.' }
    case 'interrupted':
      return { kind: 'error', code: 'AGENT_INTERRUPTED', message: 'The stored DSH turn was interrupted.' }
    default:
      return { kind: 'error', code: 'AGENT_EXECUTION_ERROR', message: 'The DSH turn ended with an unsupported reason.' }
  }
}

/** Flatten DSH model-facing Tool content into the AG-UI string result field. */
function renderToolResult(block: ToolResultBlock): string {
  const text: string[] = []
  for (const content of block.content) {
    if (content.type === 'text') text.push(content.text)
    else if (content.type === 'reasoning') text.push(content.text)
    else if (content.type === 'image') text.push('[image result]')
    else if (content.type === 'file') text.push('[file result]')
    else if (content.type === 'tool-call') text.push(`[nested tool call: ${content.name}]`)
    else text.push(renderToolResult(content))
  }
  return text.join('\n')
}
