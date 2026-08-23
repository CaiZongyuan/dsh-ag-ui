import { EventEmitter } from 'node:events'
import type { ServerResponse } from 'node:http'
import { EventType, type BaseEvent, type RunAgentInput } from '@ag-ui/core'
import { describe, expect, it } from 'vitest'
import { AgUiGatewayError, publicError } from '../src/errors.ts'
import { jsonBytes, jsonDepth, requestDigest, utf8Bytes, valueDigest } from '../src/json.ts'
import { RunController, replayRun, type RunRecord } from '../src/run.ts'

const INPUT: RunAgentInput = {
  threadId: 'thread-1',
  runId: 'run-1',
  messages: [],
  tools: [],
  context: [],
  state: {},
  forwardedProps: {},
}

class FakeResponse extends EventEmitter {
  readonly chunks: string[] = []
  destroyed = false
  writableEnded = false
  headersSent = false
  backpressure = false

  writeHead(): this {
    this.headersSent = true
    return this
  }

  flushHeaders(): void {}

  write(chunk: string): boolean {
    this.chunks.push(chunk)
    const result = !this.backpressure
    this.backpressure = false
    if (!result) queueMicrotask(() => this.emit('drain'))
    return result
  }

  end(): this {
    this.writableEnded = true
    return this
  }
}

function response(value = new FakeResponse()): ServerResponse {
  return value as unknown as ServerResponse
}

function record(state: RunRecord['state'] = 'active'): RunRecord {
  return { digest: 'digest', events: [], state, bytes: 0 }
}

describe('AG-UI JSON helpers', () => {
  it('measures UTF-8 and hashes exact request bytes', () => {
    expect(utf8Bytes('a😀')).toBe(5)
    expect(requestDigest(Buffer.from('a'))).not.toBe(requestDigest(Buffer.from('A')))
  })

  it('rejects cyclic and undefined JSON values', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(() => jsonBytes(cyclic, 'field')).toThrow(AgUiGatewayError)
    expect(() => jsonBytes(undefined, 'field')).toThrow(TypeError)
    expect(() => valueDigest(undefined)).toThrow(TypeError)
    expect(() => jsonDepth(cyclic)).toThrow('AG-UI input must not contain cyclic values.')
  })

  it('computes maximum object and array nesting', () => {
    expect(jsonDepth({ a: [{ b: 1 }], c: null })).toBe(3)
  })
})

describe('AG-UI errors', () => {
  it('preserves public errors and contains unknown failures', () => {
    const known = new AgUiGatewayError('KNOWN', 'known', 418)
    expect(publicError(known)).toBe(known)
    const unknown = publicError('secret')
    expect(unknown).toMatchObject({ code: 'AGENT_EXECUTION_ERROR', message: 'The Agent run failed.', status: 500 })
    expect(unknown.cause).toBe('secret')
  })
})

describe('AG-UI run buffering', () => {
  it('terminates with overflow before exceeding the event count bound', async () => {
    const ledger = record()
    const controller = new RunController(1, INPUT, ledger, 2, 10_000)
    controller.start()
    controller.emit({ type: EventType.RAW, event: { one: true } })
    await controller.done
    expect(ledger.events.map(event => event.type)).toEqual([EventType.RUN_STARTED, EventType.RUN_ERROR])
    expect(ledger.events[1]).toMatchObject({ code: 'AG_UI_EVENT_BUFFER_OVERFLOW' })
    controller.emit({ type: EventType.RAW, event: { ignored: true } })
    controller.success()
    expect(ledger.events).toHaveLength(2)
  })

  it('terminates with overflow without exceeding the complete byte bound', async () => {
    const ledger = record()
    const terminal = {
      type: EventType.RUN_ERROR,
      code: 'AG_UI_EVENT_BUFFER_OVERFLOW',
      message: 'The AG-UI run exceeded its event buffer.',
    } as BaseEvent
    const maxBytes = utf8Bytes(JSON.stringify(terminal))
    const controller = new RunController(1, INPUT, ledger, 10, maxBytes)
    controller.emit({ type: EventType.RAW, event: { too: 'large' } })
    await controller.done
    expect(ledger.events).toEqual([terminal])
    expect(ledger.bytes).toBe(maxBytes)
  })

  it('retains opening, data, and terminal events at the exact byte bound', async () => {
    const ledger = record()
    const opening = { type: EventType.RUN_STARTED, threadId: INPUT.threadId, runId: INPUT.runId } as BaseEvent
    const data = { type: EventType.RAW, event: { value: 1 } } as BaseEvent
    const failure = {
      type: EventType.RUN_ERROR,
      code: 'AG_UI_EVENT_BUFFER_OVERFLOW',
      message: 'The AG-UI run exceeded its event buffer.',
    } as BaseEvent
    const success = {
      type: EventType.RUN_FINISHED,
      threadId: INPUT.threadId,
      runId: INPUT.runId,
      outcome: { type: 'success' },
    } as BaseEvent
    const successIsLargest = utf8Bytes(JSON.stringify(success)) >= utf8Bytes(JSON.stringify(failure))
    const terminal = successIsLargest ? success : failure
    const maxBytes = [opening, data, terminal]
      .reduce((total, event) => total + utf8Bytes(JSON.stringify(event)), 0)
    const controller = new RunController(1, INPUT, ledger, 3, maxBytes)
    controller.start()
    controller.emit(data)
    if (successIsLargest) controller.success()
    else controller.error('AG_UI_EVENT_BUFFER_OVERFLOW', 'The AG-UI run exceeded its event buffer.')
    await controller.done
    expect(ledger.events).toEqual([opening, data, terminal])
    expect(ledger.bytes).toBe(maxBytes)
  })

  it('falls back to a bounded terminal error and rejects impossible opening bounds', async () => {
    const ledger = record()
    const controller = new RunController(1, INPUT, ledger, 2, 10_000)
    controller.start()
    controller.error('X'.repeat(20_000), 'Y'.repeat(20_000))
    await controller.done
    expect(ledger.events.at(-1)).toMatchObject({ code: 'AG_UI_EVENT_BUFFER_OVERFLOW' })
    expect(ledger.bytes).toBeLessThanOrEqual(10_000)

    expect(() => new RunController(1, INPUT, record(), 1, 10_000).start())
      .toThrow('cannot retain mandatory events')
    expect(() => new RunController(1, INPUT, record(), 2, 1).start())
      .toThrow('cannot retain mandatory events')
  })

  it('streams queued events through response backpressure and ends once', async () => {
    const ledger = record()
    const controller = new RunController(1, INPUT, ledger, 10, 10_000)
    const sink = new FakeResponse()
    sink.backpressure = true
    const writing = controller.writeTo(response(sink))
    controller.start()
    controller.error('FAIL', 'failed')
    await Promise.all([controller.done, writing])
    expect(sink.chunks).toHaveLength(2)
    expect(sink.writableEnded).toBe(true)
  })

  it('does not write queued events to an already destroyed response', async () => {
    const ledger = record()
    const controller = new RunController(1, INPUT, ledger, 10, 10_000)
    controller.start()
    controller.success()
    const sink = new FakeResponse()
    sink.destroyed = true
    await controller.writeTo(response(sink))
    expect(sink.chunks).toEqual([])
    expect(sink.writableEnded).toBe(false)
  })

  it('rejects replay of an active run', async () => {
    await expect(replayRun(response(), record())).rejects.toMatchObject({ code: 'RUN_IN_PROGRESS', status: 409 })
  })

  it('replays completed events through backpressure and stops after close', async () => {
    const first = { type: EventType.RUN_STARTED, threadId: 'thread-1', runId: 'run-1' } as BaseEvent
    const second = { type: EventType.RUN_FINISHED, threadId: 'thread-1', runId: 'run-1' } as BaseEvent
    const ledger: RunRecord = { digest: 'digest', events: [first, second], state: 'completed', bytes: 0 }
    const sink = new FakeResponse()
    sink.backpressure = true
    const replay = replayRun(response(sink), ledger)
    queueMicrotask(() => { sink.destroyed = true })
    await replay
    expect(sink.chunks).toHaveLength(1)
    expect(sink.writableEnded).toBe(false)
  })
})
