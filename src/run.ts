import type { ServerResponse } from 'node:http'
import { once } from 'node:events'
import { EventEncoder } from '@ag-ui/encoder'
import { EventType, type BaseEvent, type RunAgentInput } from '@ag-ui/core'
import { AgUiGatewayError } from './errors.ts'
import { utf8Bytes } from './json.ts'

/** Bounded event history retained for one idempotent run. */
export interface RunRecord {
  readonly digest: string
  readonly events: BaseEvent[]
  state: 'active' | 'completed'
  bytes: number
}

/** One AG-UI HTTP run, independent from the DSH turn it observes. */
export class RunController {
  private readonly settled = Promise.withResolvers<void>()
  private readonly terminalReserveBytes: number
  private waiter: PromiseWithResolvers<void> | undefined
  private cursor = 0
  private terminal = false

  /** DSH turn projected into this HTTP run. */
  turn: number | undefined
  /** DSH inbox message whose claim assigns a normal run's turn. */
  messageId: string | undefined

  constructor(
    readonly input: RunAgentInput,
    readonly record: RunRecord,
    private readonly maxEvents: number,
    private readonly maxBytes: number,
  ) {
    this.terminalReserveBytes = Math.max(
      eventBytes(this.successEvent()),
      eventBytes(overflowEvent()),
    )
  }

  /** Resolution after a terminal event has been recorded. */
  get done(): Promise<void> {
    return this.settled.promise
  }

  /** Append the run's required opening event before DSH is driven. */
  start(): void {
    const event: BaseEvent = {
      type: EventType.RUN_STARTED,
      threadId: this.input.threadId,
      runId: this.input.runId,
      ...this.input.parentRunId === undefined ? {} : { parentRunId: this.input.parentRunId },
    }
    const bytes = eventBytes(event)
    if (this.maxEvents < 2 || bytes + this.terminalReserveBytes > this.maxBytes) {
      throw new AgUiGatewayError('RUN_EVENT_LIMIT_TOO_SMALL', 'The AG-UI run event bounds cannot retain mandatory events.')
    }
    this.append(event, bytes)
  }

  /**
   * Append one non-terminal event within the retained bounds.
   * @param event - owned AG-UI event projection.
   */
  emit(event: BaseEvent): void {
    if (this.terminal) return
    try {
      this.assertCanEmit(event)
    } catch (error) {
      const failure = error as AgUiGatewayError
      this.error(failure.code, failure.message)
      return
    }
    this.append(event)
  }

  /**
   * Reject an event that cannot fit while preserving one terminal-event slot.
   * @param event - candidate non-terminal event.
   */
  assertCanEmit(event: BaseEvent): void {
    const bytes = eventBytes(event)
    if (this.terminal
      || this.record.events.length + 1 >= this.maxEvents
      || this.record.bytes + bytes + this.terminalReserveBytes > this.maxBytes) {
      throw new AgUiGatewayError('AG_UI_EVENT_BUFFER_OVERFLOW', 'The AG-UI run exceeded its event buffer.')
    }
  }

  /** Finish the run with a successful AG-UI outcome. */
  success(): void {
    this.finish(this.successEvent())
  }

  /**
   * Finish the run with one public AG-UI error.
   * @param code - stable failure category.
   * @param message - client-safe diagnostic.
   */
  error(code: string, message: string): void {
    this.finish({ type: EventType.RUN_ERROR, code, message })
  }

  /**
   * Stream queued events to this Run\'s single live HTTP response and close after the terminal event.
   * @param response - Node response owning this SSE transport.
   */
  async writeTo(response: ServerResponse): Promise<void> {
    const encoder = new EventEncoder({ accept: 'text/event-stream' })
    response.writeHead(200, {
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'content-type': encoder.getContentType(),
      'x-accel-buffering': 'no',
    })
    response.flushHeaders()
    while (!response.destroyed && !response.writableEnded) {
      const event = this.record.events[this.cursor]
      if (event !== undefined) {
        this.cursor += 1
        if (!response.write(encoder.encodeSSE(event))) {
          await Promise.race([once(response, 'drain'), once(response, 'close')])
        }
        continue
      }
      if (this.terminal) break
      const waiter = Promise.withResolvers<void>()
      this.waiter = waiter
      await waiter.promise
    }
    if (!response.destroyed && !response.writableEnded) response.end()
  }

  private successEvent(): BaseEvent {
    return {
      type: EventType.RUN_FINISHED,
      threadId: this.input.threadId,
      runId: this.input.runId,
      outcome: { type: 'success' },
    }
  }

  private append(event: BaseEvent, bytes = eventBytes(event)): void {
    this.record.events.push(event)
    this.record.bytes += bytes
    this.wakeWriter()
  }

  private wakeWriter(): void {
    const waiter = this.waiter
    this.waiter = undefined
    waiter?.resolve()
  }

  private finish(event: BaseEvent): void {
    if (this.terminal) return
    let terminal = event
    let bytes = eventBytes(terminal)
    if (this.record.events.length + 1 > this.maxEvents || this.record.bytes + bytes > this.maxBytes) {
      terminal = overflowEvent()
      bytes = eventBytes(terminal)
    }
    /* v8 ignore next -- validated config and non-terminal reservations guarantee the fallback fits. */
    if (this.record.events.length + 1 > this.maxEvents || this.record.bytes + bytes > this.maxBytes) {
      throw new AgUiGatewayError('RUN_EVENT_LIMIT_TOO_SMALL', 'The AG-UI run event bounds cannot retain a terminal event.')
    }
    this.terminal = true
    this.append(terminal, bytes)
    this.record.state = 'completed'
    this.settled.resolve()
  }
}

/** Stable bounded terminal event used when another event cannot be retained. */
function overflowEvent(): BaseEvent {
  return {
    type: EventType.RUN_ERROR,
    code: 'AG_UI_EVENT_BUFFER_OVERFLOW',
    message: 'The AG-UI run exceeded its event buffer.',
  }
}

/** Measure one complete retained AG-UI event. */
function eventBytes(event: BaseEvent): number {
  return utf8Bytes(JSON.stringify(event))
}

/**
 * Replay one completed run without driving DSH again.
 * @param response - Node response receiving the replayed SSE events.
 * @param record - completed bounded event record.
 */
export async function replayRun(response: ServerResponse, record: RunRecord): Promise<void> {
  if (record.state !== 'completed') throw new AgUiGatewayError('RUN_IN_PROGRESS', 'The AG-UI run is still active.', 409)
  const encoder = new EventEncoder({ accept: 'text/event-stream' })
  response.writeHead(200, {
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'content-type': encoder.getContentType(),
    'x-accel-buffering': 'no',
  })
  response.flushHeaders()
  for (const event of record.events) {
    if (!response.write(encoder.encodeSSE(event))) await Promise.race([once(response, 'drain'), once(response, 'close')])
    if (response.destroyed) return
  }
  response.end()
}
