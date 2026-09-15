import { randomUUID } from 'node:crypto'
import type { Interrupt, ResumeEntry } from '@ag-ui/core'
import type { AskUserQuestionRequestEvent, AskUserQuestionAnswer, AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions/types'
import type { ApprovalRequestEvent, ApprovalOutcome } from '@deepseek-ai/dsh-user-approval/types'
import { validateJsonSchemaValue, type ObjectJsonSchema } from '@deepseek-ai/dsh-tools'
import { AgUiGatewayError } from './errors.ts'

interface PendingInterrupt {
  readonly interrupt: Interrupt
  readonly turn: number
  validate(payload: unknown): void
  answer(entry: ResumeEntry): void
  cancel(): void
}

/** One validated batch. Applying it is synchronous, after every admission check. */
export interface PreparedResume {
  readonly turn: number | undefined
  apply(): void
}

/** The binding owns native answers; the published set stays fixed until an accepted resume. */
export class PendingInterrupts {
  private readonly pending = new Map<string, PendingInterrupt>()
  private published: Interrupt[] = []

  constructor(
    private readonly timeoutMs: number,
    private readonly limit: number,
    private readonly onReady: () => void,
    private readonly onUnavailable: (turn: number, reason: string) => void,
    private readonly warn: (message: string) => void,
  ) {}

  get waiting(): boolean { return this.pending.size !== 0 }
  get visible(): readonly Interrupt[] { return this.published }

  /** Freeze only the requests currently known; reconnect never grows this set. */
  publish(): readonly Interrupt[] {
    if (this.published.length === 0) this.published = [...this.pending.values()].map(item => item.interrupt)
    return this.published
  }

  questions(request: AskUserQuestionRequestEvent, turn: number): Promise<AskUserQuestionAnswer> {
    const questions = structuredClone(request.questions)
    const schema = questionResponseSchema(questions)
    return this.add<AskUserQuestionAnswer>({
      id: randomUUID(), reason: 'user_question',
      metadata: { dsh: { questions } }, responseSchema: schema,
    }, turn, request.signal, payload => validateQuestionAnswer(schema, questions, payload),
    async entry => {
      if (entry.status === 'resolved') return entry.payload as AskUserQuestionAnswer
      // The wait is already settled before loading this optional native error.
      const { UserQuestionError } = await import('@deepseek-ai/dsh-user-questions')
      throw new UserQuestionError('The user question was cancelled before an answer was received.', 'ASK_ABORTED')
    })
  }

  approval(request: ApprovalRequestEvent, turn: number): Promise<ApprovalOutcome> {
    const schema: ObjectJsonSchema = {
      type: 'object', properties: { approved: { type: 'boolean' } }, required: ['approved'], additionalProperties: false,
    }
    return this.add<ApprovalOutcome>({
      id: randomUUID(), reason: 'approval',
      ...(request.callId === undefined ? {} : { toolCallId: String(request.callId) }),
      ...(request.reason === undefined ? {} : { message: request.reason }),
      metadata: { dsh: { toolName: request.toolName } }, responseSchema: schema,
    }, turn, request.signal, payload => validateAnswer(schema, payload),
    entry => entry.status === 'cancelled' ? 'cancelled' : (entry.payload as { approved: boolean }).approved ? 'allowed-once' : 'rejected')
  }

  /** Check every entry and the entire visible set without consuming any answer. */
  prepare(entries: readonly ResumeEntry[]): PreparedResume {
    const seen = new Set<string>()
    const answers: Array<{ entry: ResumeEntry; pending: PendingInterrupt }> = []
    let turn: number | undefined
    for (const entry of entries) {
      if (seen.has(entry.interruptId)) throw new AgUiGatewayError('DUPLICATE_INTERRUPT_RESPONSE', 'Each interrupt must be answered once.')
      seen.add(entry.interruptId)
      if (!this.published.some(item => item.id === entry.interruptId)) {
        this.warn(`ag-ui: ignoring unknown interrupt ${entry.interruptId}`)
        continue
      }
      const pending = this.pending.get(entry.interruptId)
      if (pending === undefined) {
        if (entry.status !== 'cancelled') throw new AgUiGatewayError('INTERRUPT_UNAVAILABLE', 'The interrupt is no longer available; cancel it to continue.', 409)
        continue
      }
      if (entry.status === 'resolved') pending.validate(entry.payload)
      turn = pending.turn
      answers.push({ entry, pending })
    }
    if (this.published.some(item => !seen.has(item.id))) {
      throw new AgUiGatewayError('INCOMPLETE_INTERRUPT_RESPONSE', 'The run must answer every published interrupt.', 409)
    }
    return { turn, apply: () => {
      this.published = []
      for (const { entry, pending } of answers) pending.answer(entry)
    } }
  }

  /** Release all native waits. Published descriptors survive until acknowledgement or binding eviction. */
  cancel(): void {
    for (const pending of this.pending.values()) pending.cancel()
  }

  private add<T>(
    interrupt: Interrupt, turn: number, signal: AbortSignal | undefined,
    validate: (payload: unknown) => void, answer: (entry: ResumeEntry) => T | Promise<T>,
  ): Promise<T> {
    if (this.pending.size >= this.limit) {
      this.onUnavailable(turn, 'AG-UI pending interrupt limit exceeded')
      return Promise.reject(new AgUiGatewayError('INTERRUPT_LIMIT_EXCEEDED', 'Too many pending human requests.', 429))
    }
    const deferred = Promise.withResolvers<T>()
    let settled = false
    const settle = (entry: ResumeEntry): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      this.pending.delete(interrupt.id)
      deferred.resolve(answer(entry))
    }
    const cancel = (): void => { settle({ interruptId: interrupt.id, status: 'cancelled' }) }
    const onAbort = (): void => { cancel(); this.onUnavailable(turn, 'AG-UI native human request aborted') }
    const timer = setTimeout(() => {
      cancel()
      this.onUnavailable(turn, 'AG-UI human request timed out')
    }, this.timeoutMs)
    this.pending.set(interrupt.id, { interrupt, turn, validate, answer: settle, cancel })
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()
    else this.onReady()
    return deferred.promise
  }
}

/** Structural schema uses the same enforced subset as native tool inputs. */
function questionResponseSchema(questions: readonly AskUserQuestionItem[]): ObjectJsonSchema {
  return {
    type: 'object', required: ['answers'], additionalProperties: false,
    properties: {
      answers: { type: 'array', items: {
        type: 'object', required: ['id', 'selected'], additionalProperties: false,
        properties: {
          id: { type: 'string', enum: questions.map(question => question.id) },
          selected: { type: 'array', items: { type: 'string' } },
          custom: { type: 'string' },
        },
      } },
    },
  }
}

function validateAnswer(schema: ObjectJsonSchema, payload: unknown): void {
  const errors = validateJsonSchemaValue(schema, payload, '')
  if (errors.length !== 0) throw new AgUiGatewayError('INVALID_INTERRUPT_RESPONSE', 'The human response does not match the requested answer.')
}

/** Enforce the native per-question option and custom-answer semantics after structural validation. */
function validateQuestionAnswer(schema: ObjectJsonSchema, questions: readonly AskUserQuestionItem[], payload: unknown): void {
  validateAnswer(schema, payload)
  const { answers } = payload as AskUserQuestionAnswer
  if (answers.length !== questions.length || new Set(answers.map(answer => answer.id)).size !== answers.length) {
    throw new AgUiGatewayError('INVALID_INTERRUPT_RESPONSE', 'Every question needs one distinct answer.')
  }
  for (const answer of answers) {
    const question = questions.find(question => question.id === answer.id)!
    const choices = answer.selected.length + (answer.custom === undefined ? 0 : 1)
    if (choices === 0 || (question.multiSelect !== true && choices > 1)
      || new Set(answer.selected).size !== answer.selected.length
      || answer.selected.some(value => !question.options?.some(option => option.label === value))
      || (answer.custom !== undefined && answer.custom.trim() === '')) {
      throw new AgUiGatewayError('INVALID_INTERRUPT_RESPONSE', 'The selected answers are not valid for this question.')
    }
  }
}
