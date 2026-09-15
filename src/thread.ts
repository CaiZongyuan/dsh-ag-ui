import type { Context } from '@deepseek-ai/cordis'
import {
  EventType,
  type RunAgentInput,
  type Tool as AgUiTool,
  type ToolMessage as AgUiToolMessage,
  type UserMessage as AgUiUserMessage,
} from '@ag-ui/core'
import type { Agent, AgentHandle, AgentSetup } from '@deepseek-ai/dsh-agent'
import { createUserMessage, errorChain, freezeMessage, MessageId, ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { SessionPersistenceNotFoundError } from '@deepseek-ai/dsh-session-persistence'
import {
  assertObjectJsonSchema,
  validateJsonSchemaValue,
  type ObjectJsonSchema,
  type ToolDefinition,
  type ToolRunContext,
} from '@deepseek-ai/dsh-tools'
import { isDeepStrictEqual } from 'node:util'
import { AgUiGatewayError } from './errors.ts'
import { jsonBytes, valueDigest } from './json.ts'
import { consumedMessages, durableUserId, SessionProjection, STATE_TOOL_NAME } from './projection.ts'
import { agentPresetsOf, sessionPresetOf } from './presets.ts'
import { RunController, type RunRecord } from './run.ts'
import type { ToolPresenter } from './tool-view.ts'
import type { AgUiPrincipal, AgUiThreadIdentity } from './types.ts'

export type RunAdmission = RunController | { replay: RunRecord }

const FRONTEND_TOOL_NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/

/** Fixed identity for registry scheduling probes that never dispatch. */
const SCHEDULING_PROBE = {
  callId: ToolCallId('ag-ui-scheduling-probe'),
  arguments: {},
  signal: new AbortController().signal,
}

/** Runtime limits and model route resolved from Gateway config. */
export interface ThreadOptions {
  readonly provider: string
  readonly model: string
  /** Preset id composed into the thread's agents; absent keeps the host composition. */
  readonly presetId?: string
  readonly frontendToolTimeoutMs: number
  readonly threadIdleMs: number
  readonly maxRunEvents: number
  readonly maxRunEventBytes: number
  readonly maxRunsPerThread: number
  readonly maxStateBytes: number
}

/** A new user message the V1 wire contract admits: text only. */
type TextUserMessage = AgUiUserMessage & { content: string }

interface AcceptedMessage {
  readonly role: 'user' | 'tool'
  readonly digest: string
}

interface FrontendToolRegistration {
  readonly dispose: () => void
  readonly fingerprint: string
}

interface PendingFrontendCall {
  readonly turn: number
  resolve(value: string): void
  reject(error: Error): void
}

interface PreparedFrontendTool {
  readonly tool: AgUiTool
  readonly fingerprint: string
  readonly schema: ObjectJsonSchema & Record<string, unknown>
}

interface SharedStateBaseline {
  readonly active: boolean
  readonly value: unknown
}

/** One authenticated process-local AG-UI thread and its owned DSH Agent. */
export class ThreadBinding {
  /** Deterministic durable DSH session identity, derived from the authenticated thread tuple. */
  readonly sessionId: SessionId
  /** Authenticated principal and client thread tuple owning this binding. */
  readonly identity: AgUiThreadIdentity
  /** Pure session-event to wire-event translation owned by this thread. */
  private readonly projection: SessionProjection
  /** Presenter seam: definitions resolve in the owning Agent's scope; client Tools present themselves. */
  private readonly presenter: ToolPresenter = {
    resolve: (name) => this.ctx.tools.get(name, this.liveAgent),
    isFrontendTool: (name) => this.frontendTools.has(name),
  }
  /** Whether an announced Tool would still start while a parked call holds the pool. */
  private readonly startsWhileParked = (name: string): boolean =>
    this.ctx.tools.executionMode({ ...SCHEDULING_PROBE, name, agent: this.liveAgent }).kind === 'parallel'

  private handle: AgentHandle | undefined
  private agent: Agent | undefined
  private disposed = false
  private interrupted = false
  private activeRun: RunController | undefined
  private nativeTurn: number | undefined
  private waitingRuns = 0
  private idleTimer: ReturnType<typeof setTimeout> | undefined
  private readonly acceptedMessages = new Map<string, AcceptedMessage>()
  private readonly frontendTools = new Map<string, FrontendToolRegistration>()
  private stagedTools: AgUiTool[] | undefined
  private readonly pendingCalls = new Map<string, PendingFrontendCall>()
  private readonly runLedger = new Map<string, RunController>()
  private readonly userMessageIds = new Map<string, string>()
  private sharedStateActive = false
  private stateToolDispose: (() => void) | undefined

  constructor(
    private readonly ctx: Context,
    principal: AgUiPrincipal,
    threadId: string,
    sessionId: SessionId,
    private readonly options: ThreadOptions,
    private readonly onExpired: (binding: ThreadBinding) => void,
  ) {
    this.identity = { principal, threadId }
    this.sessionId = sessionId
    this.projection = new SessionProjection(sessionId, this.presenter)
  }

  /** Create the Agent — resuming a persisted session when the host configured one — and install scoped listeners before publication. */
  async initialize(): Promise<void> {
    const handle = await this.restoreOrCreate()
    this.handle = handle
    this.agent = handle.agent
    this.scheduleIdleExpiry()
  }

  private async restoreOrCreate(): Promise<AgentHandle> {
    const agentOptions = { provider: this.options.provider, model: this.options.model }
    // the resolved preset is snapshotted into durable meta at creation, before any await
    const meta = this.options.presetId === undefined ? {} : { meta: { agentPreset: this.options.presetId } }
    const create = () => this.ctx.agents.create({ sessionId: this.sessionId, ...meta, agentOptions, setup: this.agentSetup() })
    if (this.ctx.get('sessionPersistence') === undefined) return create()
    try {
      const handle = await this.ctx.agents.resume({ resumeSessionId: this.sessionId, agentOptions, setup: this.agentSetup() })
      this.recover(handle.agent.session.snapshotEvents())
      return handle
    } catch (error) {
      // A missing log permits creation; corruption, format refusal, and setup failures do not.
      if (!(error instanceof SessionPersistenceNotFoundError)) throw error
      return create()
    }
  }

  private agentSetup(): AgentSetup {
    return async (agentCtx, agent) => {
      this.agent = agent
      agentCtx.on('session/event', (session, event) => {
        /* v8 ignore next -- the Agent-scoped listener receives only its exact owned Session. */
        if (session === agent.session) this.onSessionEvent(event)
      })
      agentCtx.on('agent/assistant-stream', ({ agent: subject, frame }) => {
        /* v8 ignore next -- the Agent-scoped stream belongs to this exact Agent. */
        if (subject !== agent) return
        const active = this.activeRun
        const step = this.projection.projectStream(frame, this.nativeTurn)
        if (active?.record.state !== 'active' || active.turn === undefined || active.turn !== this.nativeTurn) return
        for (const event of step.events) active.emit(event)
      })
      agentCtx.on('agent/inbox/claimed', ({ agent: subject, message, turn }) => {
        const active = this.activeRun
        if (subject === agent && active?.messageId === String(message.id)) {
          active.turn = turn
          this.nativeTurn = turn
        }
      })
      agentCtx.on('agent/error', ({ agent: subject, error }) => {
        /* v8 ignore next -- scope-filtered Agent errors carry this exact Agent. */
        if (subject === agent) this.onAgentError(error)
      })
      agentCtx.on('tools/change', () => { this.checkGlobalCollisions() })
      // mounting inside the setup window rolls a broken preset back with the whole creation
      await this.mountPreset(agentCtx, agent)
    }
  }

  /** Compose the agent from its preset; a thread resumes the composition its own log recorded. */
  private async mountPreset(agentCtx: Context, agent: Agent): Promise<void> {
    const presets = agentPresetsOf(this.ctx)
    if (presets === undefined) {
      if (this.options.presetId === undefined) return
      // a roster that vanished after activation stays loud instead of composing from host tools
      throw new Error('ag-ui: the configured agent preset cannot mount because no agent-presets roster is active')
    }
    const presetId = sessionPresetOf(agent.session) ?? this.options.presetId
    if (presetId !== undefined) await presets.mount(agentCtx, presetId)
  }

  /** Rebuild idempotency bookkeeping from one recovered durable log. */
  private recover(events: readonly SessionEvent[]): void {
    const recovery = this.projection.recoverFrom(events)
    for (const user of recovery.users) {
      this.userMessageIds.set(durableUserId(user.clientId), user.clientId)
      this.acceptedMessages.set(user.clientId, { role: 'user', digest: messageDigest(user.clientId, user.content) })
    }
    this.interrupted = recovery.interrupted
  }

  /** The live Agent after successful initialization. */
  get liveAgent(): Agent {
    if (this.agent === undefined || this.handle === undefined || this.disposed) {
      throw new AgUiGatewayError('AGENT_NOT_AVAILABLE', 'The AG-UI thread Agent is unavailable.', 410)
    }
    return this.agent
  }

  /**
   * Read one retained run for duplicate handling.
   * @param runId - client run identity.
   * @returns active or completed record, or undefined for a fresh id.
   */
  getRun(runId: string, digest?: string): RunRecord | undefined {
    const record = this.runLedger.get(runId)?.record
    if (record !== undefined && digest !== undefined && record.digest !== digest) {
      throw new AgUiGatewayError('RUN_ID_CONFLICT', 'The runId was reused with different input.', 409)
    }
    return record
  }

  /**
   * Admit one run. A history-only run is served at once, even beside an active run, because it
   * only reads the session log. Any other run waits until this thread is free and reserves it in
   * the same tick, so two queued runs never race for one reservation.
   * @param signal - aborted once the waiting client is gone; that run is never admitted.
   */
  async admit(input: RunAgentInput, digest: string, signal: AbortSignal): Promise<RunAdmission> {
    const disconnected = new AgUiGatewayError('CLIENT_DISCONNECTED', 'The AG-UI client left before its queued run started.', 409)
    if (signal.aborted) throw disconnected
    this.assertLive()
    const prior = this.getRun(input.runId, digest)
    if (prior !== undefined) return { replay: prior }
    if (this.classifyMessages(input).kind === 'sync') return this.retainRun(input, digest)
    if (this.waitingRuns >= this.options.maxRunsPerThread) {
      throw new AgUiGatewayError('RUN_QUEUE_FULL', 'The AG-UI thread run queue is full.', 429)
    }
    this.waitingRuns++
    this.clearIdleExpiry()
    const runId = input.runId
    const session = String(this.sessionId)
    const left = Promise.withResolvers<never>()
    const onAbort = (): void => {
      this.ctx.logger.debug(`ag-ui: run ${runId} left the queue of session ${session}`)
      left.reject(disconnected)
    }
    signal.addEventListener('abort', onAbort, { once: true })
    left.promise.catch(() => {})
    try {
      for (;;) {
        // Settlement and disconnect can happen in the same tick; the race alone is insufficient.
        if (signal.aborted) throw disconnected
        if (this.activeRun !== undefined) {
          this.ctx.logger.debug(`ag-ui: run ${runId} waits for the active run of session ${session}`)
          await Promise.race([this.activeRun.done, left.promise])
        } else if (this.pendingCalls.size === 0 && this.liveAgent.status !== 'idle') {
          // a settled run may leave its finishing or cancelled turn converging; parked calls keep a turn open on purpose
          this.ctx.logger.debug(`ag-ui: run ${runId} waits for the Agent of session ${session} to settle`)
          await Promise.race([this.liveAgent.whenIdle(), left.promise])
        } else {
          const replay = this.getRun(input.runId, digest)
          return replay === undefined ? this.reserveRun(input, digest) : { replay }
        }
      }
    } finally {
      signal.removeEventListener('abort', onAbort)
      this.waitingRuns--
      this.scheduleIdleExpiry()
    }
  }

  /**
   * Reserve one run before accepting DSH input; HTTP callers serialize through {@link admit}.
   * @param input - validated AG-UI request.
   * @param digest - exact request-body digest.
   * @returns the sole active controller for this thread.
   */
  reserveRun(input: RunAgentInput, digest: string): RunController {
    this.assertLive()
    const existing = this.getRun(input.runId, digest)
    if (existing !== undefined) {
      throw new AgUiGatewayError(
        existing.state === 'active' ? 'RUN_IN_PROGRESS' : 'RUN_ALREADY_COMPLETED',
        existing.state === 'active' ? 'The AG-UI run is still active.' : 'The AG-UI run already completed.',
        409,
      )
    }
    if (this.activeRun !== undefined) {
      throw new AgUiGatewayError('RUN_IN_PROGRESS', 'This AG-UI thread already has an active run.', 409)
    }
    const controller = this.retainRun(input, digest)
    this.activeRun = controller
    return controller
  }

  /**
   * Start an admitted run after its SSE sink is attached.
   * @param controller - exact controller returned by {@link admit} or {@link reserveRun}; history runs retain their identity without reserving the Agent.
   */
  drive(controller: RunController): void {
    if (controller.record.state !== 'active' || this.runLedger.get(controller.input.runId) !== controller
      || (this.activeRun !== controller && this.classifyMessages(controller.input).kind !== 'sync')) {
      throw new AgUiGatewayError('RUN_NOT_ACTIVE', 'The AG-UI run lost its reservation.', 409)
    }
    controller.start()
    // a restarted thread reports its interrupted turn once, after its history, so the client can drop parked calls
    if (this.interrupted) {
      this.interrupted = false
      this.emitHistory(controller, [])
      controller.error('THREAD_INTERRUPTED', 'The AG-UI thread was interrupted by a restart; its pending frontend Tool calls are closed.')
      return
    }
    try {
      const admission = this.classifyMessages(controller.input)
      if (admission.kind === 'sync') {
        this.commitServerEchoes(admission.echoes)
        this.emitHistory(controller, [])
        controller.success()
        return
      }
      if (admission.kind === 'user') {
        this.assertUserRunReady()
        this.commitUserMessages(controller, admission.messages, admission.echoes)
        return
      }

      const turn = this.continuationTurn(admission.messages)
      this.emitHistory(controller, [])
      /* v8 ignore next -- a continuation whose history snapshot overflowed the run budget is already settled; the user path covers the same guard. */
      if (controller.record.state !== 'active') return
      const baseline = this.prepareSharedState(controller.input)
      this.assertStateToolAvailable(baseline)
      this.prepareFrontendTools(controller.input.tools)
      controller.turn = turn
      this.stagedTools = controller.input.tools
      this.injectContext(controller.input, baseline)
      this.commitSharedStateBaseline(baseline)
      this.commitServerEchoes(admission.echoes)
      for (const message of admission.messages) {
        const pending = this.pendingCalls.get(message.toolCallId)
        /* v8 ignore next 3 -- continuationTurn synchronously verified the identical pending entries. */
        if (pending === undefined) {
          throw new AgUiGatewayError('UNKNOWN_TOOL_RESULT', 'The frontend Tool result has no pending call.', 409)
        }
        this.acceptedMessages.set(message.id, { role: 'tool', digest: valueDigest(message) })
        this.projection.markAwaitingResult(message.toolCallId)
        if (message.error === undefined) pending.resolve(message.content)
        else pending.reject(new Error(`Frontend Tool failed: ${message.error}`))
      }
      // a partial resolution leaves calls parked; finish so the client can answer the rest
      if (this.pendingCalls.size !== 0) controller.success()
    } catch (error) {
      this.failRunAdmission(controller, error)
    }
  }

  private assertUserRunReady(): void {
    if (this.liveAgent.status !== 'idle' || this.pendingCalls.size !== 0) {
      throw new AgUiGatewayError('AGENT_BUSY', 'The thread Agent is not ready for a new user run.', 409)
    }
  }

  /**
   * Emit the durable transcript beside the user messages this run has just
   * admitted; the DSH log records those only once the driver claims them.
   * @param accepted - new client user messages, in arrival order.
   */
  private emitHistory(controller: RunController, accepted: readonly AgUiUserMessage[]): void {
    const events = this.liveAgent.session.snapshotEvents()
    controller.emit({
      type: EventType.MESSAGES_SNAPSHOT,
      messages: [
        ...this.projection.messagesSnapshot(events, id => this.userMessageIds.get(id)),
        ...accepted.map(message => ({ id: message.id, role: 'user' as const, content: message.content })),
      ],
    })
    // the transcript's settled cards ride beside the snapshot, re-derived from the same durable log
    for (const view of this.projection.toolViewEvents(events)) controller.emit(view)
  }

  /** Queue every admitted user message into one DSH turn, in arrival order. */
  private commitUserMessages(controller: RunController, admitted: readonly TextUserMessage[], echoes: readonly AgUiToolMessage[]): void {
    this.emitHistory(controller, admitted)
    // a snapshot that overflowed the run budget already settled the run
    if (controller.record.state !== 'active') return
    const baseline = this.prepareSharedState(controller.input)
    this.assertStateToolAvailable(baseline)
    this.applyFrontendTools(controller.input.tools)
    const durable = admitted.map(admission => freezeMessage({
      id: MessageId(durableUserId(admission.id)),
      role: 'user',
      content: [{ type: 'text', text: admission.content }],
      source: { kind: 'user' },
    }))
    try {
      this.injectContext(controller.input, baseline)
      this.commitSharedStateBaseline(baseline)
      this.commitServerEchoes(echoes)
      // A turn claims one next-turn message plus all pending next-step messages.
      durable.forEach((message, index) => {
        const admission = admitted[index]!
        controller.messageId = String(message.id)
        this.userMessageIds.set(String(message.id), admission.id)
        if (index < durable.length - 1) this.liveAgent.send(message, 'next-step', false)
        else this.liveAgent.followup(message)
        if (controller.record.state !== 'active') throw new Error('Native admission settled the AG-UI run')
        this.acceptedMessages.set(admission.id, { role: 'user', digest: messageDigest(admission.id, admission.content) })
      })
    } catch (error) {
      // Native append may succeed before a notification throws. Cancel pending work,
      // then retain only messages already claimed into the durable transcript.
      this.liveAgent.cancel({ kind: 'hook', reason: 'AG-UI user admission failed' })
      const claimed = new Set(consumedMessages(this.liveAgent.session.snapshotEvents()).map(message => String(message.id)))
      for (const admission of admitted) {
        if (claimed.has(durableUserId(admission.id))) {
          this.acceptedMessages.set(admission.id, { role: 'user', digest: messageDigest(admission.id, admission.content) })
        } else this.acceptedMessages.delete(admission.id)
      }
      throw error
    }
  }

  private failRunAdmission(controller: RunController, error: unknown): void {
    const failure = error instanceof AgUiGatewayError ? error : new AgUiGatewayError('AGENT_EXECUTION_ERROR', 'The AG-UI run could not start.', 500, error)
    controller.error(failure.code, failure.message)
    const terminal = controller.record.events.at(-1)!
    if (terminal.code !== 'AG_UI_EVENT_BUFFER_OVERFLOW' && this.activeRun === controller
      && controller.turn !== undefined && this.liveAgent.status === 'running') {
      this.liveAgent.cancel({ kind: 'hook', reason: `AG-UI run admission failed: ${failure.code}` })
    }
  }

  /**
   * Settle the disconnected run and cancel only its owned Agent work.
   * @param controller - disconnected controller; stale controllers are ignored.
   */
  disconnect(controller: RunController): void {
    if (this.runLedger.get(controller.input.runId) !== controller || controller.record.state !== 'active') return
    // An unopened response has no replayable run; retries must start with RUN_STARTED.
    if (controller.record.events.length === 0) this.runLedger.delete(controller.input.runId)
    controller.error('CLIENT_DISCONNECTED', 'The AG-UI client disconnected before the run completed.')
    if (this.activeRun === controller && this.liveAgent.status === 'running') {
      this.liveAgent.cancel({ kind: 'hook', reason: 'AG-UI client disconnected' })
    }
  }

  /** Reject pending calls and dispose the owned Agent to quiescence. */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.clearIdleExpiry()
    for (const controller of this.runLedger.values()) {
      controller.error('AGENT_NOT_AVAILABLE', 'The AG-UI thread was disposed.')
    }
    for (const pending of this.pendingCalls.values()) {
      pending.reject(new Error('AG-UI thread disposed'))
    }
    this.pendingCalls.clear()
    this.stateToolDispose?.()
    this.stateToolDispose = undefined
    this.projection.sharedState = undefined
    this.sharedStateActive = false
    for (const registration of this.frontendTools.values()) registration.dispose()
    this.frontendTools.clear()
    const handle = this.handle
    this.handle = undefined
    /* v8 ignore next -- initialized live bindings own a handle; repeated disposal returned above. */
    if (handle !== undefined) await handle.dispose()
  }

  /** Retain each HTTP run under the same bounds, independently of native turn ownership. */
  private retainRun(input: RunAgentInput, digest: string): RunController {
    this.evictCompletedRuns()
    if (this.runLedger.size >= this.options.maxRunsPerThread) {
      throw new AgUiGatewayError('RUN_LEDGER_FULL', 'The AG-UI thread run ledger is full.', 429)
    }
    const record: RunRecord = { digest, events: [], state: 'active', bytes: 0 }
    const controller = new RunController(input, record, this.options.maxRunEvents, this.options.maxRunEventBytes, owner => {
      if (this.activeRun === owner && owner.turn !== undefined && this.agent?.status === 'running') {
        this.agent.cancel({ kind: 'hook', reason: 'AG-UI run event buffer overflow' })
      }
    })
    this.runLedger.set(input.runId, controller)
    this.clearIdleExpiry()
    void controller.done.then(() => {
      if (this.activeRun === controller) this.activeRun = undefined
      this.scheduleIdleExpiry()
    })
    return controller
  }

  private assertLive(): void {
    if (this.disposed || this.handle === undefined) {
      throw new AgUiGatewayError('AGENT_NOT_AVAILABLE', 'The AG-UI thread Agent is unavailable.', 410)
    }
  }

  /** Sort a run's new messages: user messages open a turn, Tool results continue one, none at all only synchronizes history. */
  private classifyMessages(input: RunAgentInput):
    | { kind: 'sync'; echoes: AgUiToolMessage[] }
    | { kind: 'user'; messages: TextUserMessage[]; echoes: AgUiToolMessage[] }
    | { kind: 'tools'; messages: AgUiToolMessage[]; echoes: AgUiToolMessage[] } {
    const users: TextUserMessage[] = []
    const tools: AgUiToolMessage[] = []
    const echoes: AgUiToolMessage[] = []
    const ids = new Set<string>()
    const callIds = new Set<string>()
    for (const message of input.messages) {
      if (message.role !== 'user' && message.role !== 'tool') continue
      if (ids.has(message.id)) throw new AgUiGatewayError('INVALID_MESSAGE_BATCH', 'Message ids must be unique within a run.')
      ids.add(message.id)
      const digest = message.role === 'user' ? messageDigest(message.id, message.content) : valueDigest(message)
      const accepted = this.acceptedMessages.get(message.id)
      if (accepted !== undefined) {
        if (accepted.role !== message.role || accepted.digest !== digest) {
          throw new AgUiGatewayError('MESSAGE_ID_CONFLICT', 'A message id was reused with different content.', 409)
        }
        continue
      }
      if (message.role === 'tool') {
        if (callIds.has(message.toolCallId)) throw new AgUiGatewayError('INVALID_TOOL_RESULT_BATCH', 'A Tool call must be answered once.')
        callIds.add(message.toolCallId)
        if (this.pendingCalls.has(message.toolCallId)) tools.push(message)
        else if (this.projection.hasServerResult(message.toolCallId)) {
          echoes.push(message)
        } else {
          throw new AgUiGatewayError('UNKNOWN_TOOL_RESULT', 'The Tool result has no pending or completed server call.', 409)
        }
      } else {
        if (typeof message.content !== 'string') {
          throw new AgUiGatewayError('UNSUPPORTED_MESSAGE_CONTENT', 'V1 accepts text user messages only.')
        }
        users.push(message as TextUserMessage)
      }
    }
    if (users.length > 0 && tools.length > 0) {
      throw new AgUiGatewayError('INVALID_MESSAGE_BATCH', 'A run cannot mix new user messages with new frontend Tool results.')
    }
    if (users.length > 0) return { kind: 'user', messages: users, echoes }
    if (tools.length > 0) return { kind: 'tools', messages: tools, echoes }
    return { kind: 'sync', echoes }
  }

  private commitServerEchoes(echoes: readonly AgUiToolMessage[]): void {
    for (const echo of echoes) {
      this.projection.consumeServerResult(echo.toolCallId)
      this.acceptedMessages.set(echo.id, { role: 'tool', digest: valueDigest(echo) })
    }
  }

  private continuationTurn(messages: AgUiToolMessage[]): number {
    let turn: number | undefined
    for (const message of messages) {
      const pending = this.pendingCalls.get(message.toolCallId)
      if (pending === undefined) {
        throw new AgUiGatewayError('UNKNOWN_TOOL_RESULT', 'The frontend Tool result has no pending call.', 409)
      }
      if (turn !== undefined && pending.turn !== turn) {
        throw new AgUiGatewayError('INVALID_TOOL_RESULT_BATCH', 'Frontend Tool results belong to different DSH turns.', 409)
      }
      turn = pending.turn
    }
    if (turn === undefined) throw new AgUiGatewayError('INVALID_TOOL_RESULT_BATCH', 'No frontend Tool result was supplied.')
    return turn
  }

  private injectContext(input: RunAgentInput, baseline: SharedStateBaseline): void {
    const sections = input.context.map(item => ({ name: item.description, text: item.value }))
    if (baseline.active) {
      sections.push({
        name: 'Current Shared State',
        text: `${JSON.stringify(baseline.value)}\n\nTo update this state, call ${STATE_TOOL_NAME} with a state_updates object.`,
      })
    }
    if (sections.length === 0) return
    const text = sections.map(section => `## ${section.name}\n${section.text}`).join('\n\n')
    this.liveAgent.inject(createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'plugin', plugin: 'ag-ui', form: 'snapshot', sections },
    }))
  }

  private prepareSharedState(input: RunAgentInput): SharedStateBaseline {
    if (!this.sharedStateActive
      && (input.state === undefined || input.state === null || isEmptyStateContainer(input.state))) {
      return { active: false, value: undefined }
    }
    const value = input.state === undefined ? this.projection.sharedState : structuredClone(input.state)
    if (jsonBytes(value, 'state') > this.options.maxStateBytes) {
      throw new AgUiGatewayError('STATE_LIMIT_EXCEEDED', 'state exceeds its limit.', 413)
    }
    const active = this.activeRun
    /* v8 ignore next -- prepareSharedState runs only while drive owns the active controller. */
    if (active === undefined) throw new Error('Shared state has no active AG-UI run')
    active.assertCanEmit({ type: EventType.STATE_SNAPSHOT, snapshot: value })
    return { active: true, value }
  }

  private assertStateToolAvailable(baseline: SharedStateBaseline): void {
    if (!baseline.active) return
    const global = this.ctx.tools.get(STATE_TOOL_NAME)
    const inherited = this.stateToolDispose === undefined
      ? this.ctx.tools.get(STATE_TOOL_NAME, this.liveAgent)
      : undefined
    if (global !== undefined || inherited !== undefined) {
      throw new AgUiGatewayError(
        'SHARED_STATE_TOOL_COLLISION',
        `The reserved shared-state Tool ${STATE_TOOL_NAME} collides with an inherited Tool.`,
        409,
      )
    }
  }

  private commitSharedStateBaseline(baseline: SharedStateBaseline): void {
    if (!baseline.active) return
    const active = this.activeRun
    /* v8 ignore next -- run admission owns the active controller through baseline commit. */
    if (active === undefined) throw new Error('Shared state has no active AG-UI run')
    this.ensureStateTool()
    this.projection.sharedState = structuredClone(baseline.value)
    this.sharedStateActive = true
    active.emit({ type: EventType.STATE_SNAPSHOT, snapshot: structuredClone(baseline.value) })
  }

  private ensureStateTool(): void {
    if (this.stateToolDispose !== undefined) return
    const definition: ToolDefinition = {
      name: STATE_TOOL_NAME,
      description: 'Shallow-merge top-level fields into shared application state. Omitted top-level keys remain; supplied nested values replace their previous values.',
      parameters: {
        type: 'object',
        properties: {
          state_updates: { type: 'object', additionalProperties: true },
        },
        required: ['state_updates'],
        additionalProperties: false,
      },
      output: {
        schema: { type: 'string' },
        render(_args, value) {
          return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }]
        },
      },
      presentCall: args => ({ card: 'generic', title: 'Update shared state', rawInput: args }),
      isConcurrencySafe: () => true,
      execute: (args, exec) => Promise.resolve(this.prepareSharedStateUpdate(args, exec)),
    }
    this.stateToolDispose = this.liveAgent.ctx.tools.register(definition)
  }

  private prepareSharedStateUpdate(args: unknown, exec: ToolRunContext): string {
    if (!this.sharedStateActive) throw new Error('Shared state is not active for this AG-UI thread')
    const callId = String(exec.callId)
    const lifecycle = this.projection.lifecycleOf(callId)
    if (lifecycle?.kind !== 'state' || lifecycle.turn !== this.nativeTurn) throw new Error('Shared-state update has no DSH call position')
    if (lifecycle.commit !== undefined) throw new Error('Shared-state update is already pending')
    const updates = readStateUpdates(args)
    const current = this.projection.sharedState
    const next = isUnknownRecord(current)
      ? { ...current, ...updates }
      : { ...updates }
    if (jsonBytes(next, 'state') > this.options.maxStateBytes) {
      throw new Error('Shared-state update exceeds the configured state byte limit')
    }
    const changed = !isDeepStrictEqual(next, current)
    const active = this.activeRun
    // A native turn may outlive its HTTP response; only a live response has a wire budget.
    if (changed && active?.record.state === 'active' && active.turn === lifecycle.turn) {
      active.assertCanEmit({ type: EventType.STATE_SNAPSHOT, snapshot: next })
    }
    this.projection.stageCommit(callId, { value: structuredClone(next), changed })
    return JSON.stringify({ status: changed ? 'updated' : 'unchanged', state: next })
  }

  private prepareFrontendTools(tools: AgUiTool[]): PreparedFrontendTool[] {
    const prepared: PreparedFrontendTool[] = []
    const names = new Set<string>()
    for (const tool of tools) {
      if (!FRONTEND_TOOL_NAME.test(tool.name)) {
        throw new AgUiGatewayError('INVALID_FRONTEND_TOOL_NAME', 'Frontend Tool names must use a supported ASCII identifier.')
      }
      if (tool.name === STATE_TOOL_NAME) {
        throw new AgUiGatewayError('RESERVED_FRONTEND_TOOL_NAME', `${STATE_TOOL_NAME} is reserved for shared state.`)
      }
      if (names.has(tool.name)) throw new AgUiGatewayError('DUPLICATE_FRONTEND_TOOL', 'Frontend Tool names must be unique.')
      names.add(tool.name)
      assertObjectJsonSchema(tool.parameters)
      const schema = structuredClone(tool.parameters) as ObjectJsonSchema & Record<string, unknown>
      const fingerprint = valueDigest({ name: tool.name, description: tool.description, parameters: schema })
      const own = this.frontendTools.get(tool.name)
      if (own === undefined && this.ctx.tools.get(tool.name, this.liveAgent) !== undefined) {
        throw new AgUiGatewayError('FRONTEND_TOOL_NAME_COLLISION', `Frontend Tool ${tool.name} collides with an inherited Tool.`, 409)
      }
      prepared.push({ tool, fingerprint, schema })
    }
    return prepared
  }

  private applyFrontendTools(tools: AgUiTool[]): void {
    const prepared = this.prepareFrontendTools(tools)
    const incoming = new Map(prepared.map(item => [item.tool.name, item]))
    for (const [name, registration] of this.frontendTools) {
      const next = incoming.get(name)
      if (next !== undefined && next.fingerprint === registration.fingerprint) continue
      registration.dispose()
      this.frontendTools.delete(name)
    }
    for (const item of prepared) {
      if (this.frontendTools.has(item.tool.name)) continue
      const definition = this.definitionFor(item)
      const dispose = this.liveAgent.ctx.tools.register(definition)
      this.frontendTools.set(item.tool.name, {
        dispose,
        fingerprint: item.fingerprint,
      })
    }
  }

  private definitionFor(item: PreparedFrontendTool): ToolDefinition {
    return {
      name: item.tool.name,
      description: item.tool.description,
      parameters: item.schema,
      output: {
        schema: { type: 'string' },
        render(_args, value) {
          return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }]
        },
      },
      presentCall: args => ({ card: 'generic', title: item.tool.description, rawInput: args }),
      // parking holds no server-side resource, so calls of one step may overlap
      isConcurrencySafe: () => true,
      execute: (args, exec) => this.parkFrontendTool(item.tool.name, item.schema, args, exec),
    }
  }

  private parkFrontendTool(
    name: string,
    schema: ObjectJsonSchema,
    args: unknown,
    exec: ToolRunContext,
  ): Promise<string> {
    assertFrontendToolArgs(schema, args)
    const callId = String(exec.callId)
    const lifecycle = this.projection.lifecycleOf(callId)
    if (lifecycle?.kind !== 'backend' || lifecycle.name !== name || lifecycle.turn !== this.nativeTurn) throw new Error('Frontend Tool call has no DSH call position')
    const active = this.activeRun
    this.projection.markParked(callId, lifecycle)

    const deferred = Promise.withResolvers<string>()
    let settled = false
    const settle = (operation: () => void): void => {
      /* v8 ignore next -- late timeout, abort, or browser completion is an idempotent no-op. */
      if (settled) return
      settled = true
      clearTimeout(timer)
      exec.signal.removeEventListener('abort', onAbort)
      this.pendingCalls.delete(callId)
      operation()
      if (this.activeRun === undefined && this.pendingCalls.size === 0) this.scheduleIdleExpiry()
    }
    const pending: PendingFrontendCall = {
      turn: lifecycle.turn,
      resolve: (value) => { settle(() => { deferred.resolve(value) }) },
      reject: (error) => { settle(() => { deferred.reject(error) }) },
    }
    const onAbort = (): void => { pending.reject(new Error('Frontend Tool call aborted')) }
    const timer = setTimeout(() => {
      pending.reject(new Error('Frontend Tool result timed out'))
      /* v8 ignore next -- a pending Tool Promise keeps its owning Agent turn running until settlement. */
      if (this.liveAgent.status === 'running') {
        this.liveAgent.cancel({ kind: 'hook', reason: 'AG-UI frontend Tool timeout' })
      }
    }, this.options.frontendToolTimeoutMs)
    exec.signal.addEventListener('abort', onAbort, { once: true })
    this.pendingCalls.set(callId, pending)
    this.clearIdleExpiry()
    if (active?.record.state === 'active' && active.turn === lifecycle.turn
      && this.projection.parkSettleReady(lifecycle.turn, lifecycle.step, this.startsWhileParked)) {
      this.emitFinalSnapshot(active)
      active.success()
    }
    return deferred.promise
  }

  private onSessionEvent(event: SessionEvent): void {
    const active = this.activeRun
    const ownsTurn = active?.record.state === 'active' && active.turn !== undefined && active.turn === this.nativeTurn
    const step = this.projection.project(event, this.nativeTurn)
    if (event.type === 'step/end' && this.stagedTools !== undefined && this.nativeTurn === event.data.turn) {
      const staged = this.stagedTools
      this.stagedTools = undefined
      try {
        this.applyFrontendTools(staged)
      } catch (error) {
        if (ownsTurn) active.error('FRONTEND_TOOL_SYNC_FAILED', 'The frontend Tool set could not be updated.')
        this.liveAgent.cancel({ kind: 'hook', reason: `AG-UI frontend Tool sync failed: ${errorChain(error)}` })
      }
    }
    if (step.outcome !== undefined) {
      this.nativeTurn = undefined
      this.scheduleIdleExpiry()
    }
    if (!ownsTurn) return
    if (step.outcome !== undefined) {
      // This durable turn is over; a large final snapshot must not cancel a later turn.
      active.turn = undefined
      this.emitFinalSnapshot(active)
      if (step.outcome.kind === 'success') active.success()
      else active.error(step.outcome.code, step.outcome.message)
      return
    }
    for (const wireEvent of step.events) active.emit(wireEvent)
    // a server call completing the announced set settles a run parked earlier;
    // a frontend call settles at its own park instead
    if (event.type === 'tool/call'
      && this.projection.parkSettleReady(event.data.turn, event.data.step, this.startsWhileParked)) {
      this.emitFinalSnapshot(active)
      active.success()
    }
  }

  private emitFinalSnapshot(controller: RunController): void {
    controller.emit({
      type: EventType.MESSAGES_SNAPSHOT,
      messages: this.projection.messagesSnapshot(this.liveAgent.session.snapshotEvents(), id => this.userMessageIds.get(id)),
    })
  }

  private onAgentError(error: unknown): void {
    const active = this.activeRun
    if (active?.record.state !== 'active') return
    // A dispatched user message owns startup errors even before its first inbox claim.
    if (active.turn === undefined ? active.messageId === undefined : active.turn !== this.nativeTurn) return
    this.emitFinalSnapshot(active)
    active.error('AGENT_EXECUTION_ERROR', errorChain(error))
  }

  private checkGlobalCollisions(): void {
    if (this.disposed) return
    if (this.stateToolDispose !== undefined && this.ctx.tools.get(STATE_TOOL_NAME) !== undefined) {
      this.activeRun?.error(
        'SHARED_STATE_TOOL_COLLISION',
        `The reserved shared-state Tool ${STATE_TOOL_NAME} now collides with a global Tool.`,
      )
      if (this.agent?.status === 'running') {
        this.agent.cancel({ kind: 'hook', reason: `AG-UI shared-state Tool ${STATE_TOOL_NAME} collided with a global Tool` })
      }
      return
    }
    for (const name of this.frontendTools.keys()) {
      if (this.ctx.tools.get(name) === undefined) continue
      this.activeRun?.error('FRONTEND_TOOL_NAME_COLLISION', `Frontend Tool ${name} now collides with a global Tool.`)
      if (this.agent?.status === 'running') {
        this.agent.cancel({ kind: 'hook', reason: `AG-UI frontend Tool ${name} collided with a global Tool` })
      }
      return
    }
  }

  private evictCompletedRuns(): void {
    for (const [runId, controller] of this.runLedger) {
      if (this.runLedger.size < this.options.maxRunsPerThread) break
      if (controller.record.state === 'completed') this.runLedger.delete(runId)
    }
  }

  private clearIdleExpiry(): void {
    if (this.idleTimer === undefined) return
    clearTimeout(this.idleTimer)
    this.idleTimer = undefined
  }

  private scheduleIdleExpiry(): void {
    this.clearIdleExpiry()
    if (this.disposed || this.nativeTurn !== undefined || this.pendingCalls.size !== 0 || this.activeRun !== undefined || this.waitingRuns !== 0
      || [...this.runLedger.values()].some(controller => controller.record.state === 'active')) return
    this.idleTimer = setTimeout(() => { this.onExpired(this) }, this.options.threadIdleMs)
  }
}

/** Ignore default empty client state until a thread has activated shared state. */
function isEmptyStateContainer(value: unknown): boolean {
  if (Array.isArray(value)) return value.length === 0
  return isUnknownRecord(value) && Object.keys(value).length === 0
}

/** Digest one accepted user message in a fixed field order, stable across cold resume. */
function messageDigest(clientId: string, content: AgUiUserMessage['content']): string {
  return valueDigest({ id: clientId, role: 'user', content })
}

/** Narrow a JSON object without accepting arrays or null. */
function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function assertFrontendToolArgs(schema: ObjectJsonSchema, args: unknown): void {
  const violations = validateJsonSchemaValue(schema, args, '')
  if (violations.length > 0) throw new Error(`Invalid frontend Tool arguments: ${violations.join('; ')}`)
}

/** Read the state-management Tool input after model-boundary validation. */
function readStateUpdates(args: unknown): Record<string, unknown> {
  if (!isUnknownRecord(args) || !isUnknownRecord(args.state_updates)) {
    throw new Error('Shared-state updates must contain a state_updates object')
  }
  return structuredClone(args.state_updates)
}
