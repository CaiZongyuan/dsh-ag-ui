/**
 * The embedded adapter agent: an `AbstractAgent` that spawns a DSH micro-host
 * (a Cordis overlay composing a loopback webserver on an ephemeral port, the
 * published `dsh-ag-ui` gateway with a per-process secret, and the caller's
 * plugin rows), then serves `run()` over loopback HTTP by composing the
 * official client primitives — no new protocol translation code.
 * @module dsh-ag-ui-adapter/src/agent
 */

import { AbstractAgent, runHttpRequest, transformHttpEventStream } from '@ag-ui/client'
import type { AgentConfig, AgentSubscriber, RunAgentParameters, RunAgentResult } from '@ag-ui/client'
import type { BaseEvent, RunAgentInput } from '@ag-ui/core'
import { prepareDshRunInput } from 'dsh-ag-ui/client'
import { finalize } from 'rxjs'
import type { Observable } from 'rxjs'
import { resolveAdapterOptions } from './config.ts'
import { MicroHost } from './host.ts'
import type { MicroHostOptions } from './host.ts'
import type { DshGatewayOptions, HostPluginRow } from './types.ts'

/** Everything an embedding application configures on a `DshAgent`. */
export interface DshAgentConfig extends AgentConfig {
  /**
   * The gateway row of the generated micro-host overlay. `provider` and
   * `model` may instead come from `DSH_AG_UI_ADAPTER_PROVIDER` and
   * `DSH_AG_UI_ADAPTER_MODEL`.
   */
  readonly gateway?: DshGatewayOptions | undefined
  /** Extra overlay rows between the webserver and the gateway (Agent core, model). */
  readonly plugins?: readonly HostPluginRow[] | undefined
  /** Trusted tenant identity sent to the gateway; default `dsh-ag-ui-adapter`. */
  readonly tenantId?: string | undefined
  /** Trusted user identity sent to the gateway; default `local`. */
  readonly userId?: string | undefined
  /**
   * Milliseconds to wait for the micro-host to report readiness; default
   * 20000. Falls back to `DSH_AG_UI_ADAPTER_READY_TIMEOUT_MS`.
   */
  readonly readyTimeoutMs?: number | undefined
  /**
   * Milliseconds of inactivity after which the micro-host shuts down; the
   * next run lazily spawns a fresh one. Disabled by default. Falls back to
   * `DSH_AG_UI_ADAPTER_IDLE_SHUTDOWN_MS`. Idle shutdown discards the child's
   * process-local sessions.
   */
  readonly idleShutdownMs?: number | undefined
  /** Extra environment variables merged into the micro-host child. */
  readonly env?: Readonly<Record<string, string>> | undefined
}

interface RunDshAgentParameters extends RunAgentParameters {
  abortController?: AbortController
}

/** An AG-UI agent backed by a child-process DSH micro-host. */
export class DshAgent extends AbstractAgent {
  public abortController = new AbortController()

  private host: MicroHost | undefined
  private starting: Promise<void> | undefined
  /** Copy of the running host's bearer secret; empty outside a started host. */
  private sharedSecret = ''
  private readonly hostOptions: MicroHostOptions
  private readonly idleShutdownMs: number | undefined
  private idleTimer: NodeJS.Timeout | undefined
  private readonly identityHeaders: Record<string, string>

  constructor(config: DshAgentConfig) {
    super(config)
    const resolved = resolveAdapterOptions(process.env, config)
    this.idleShutdownMs = resolved.idleShutdownMs
    this.hostOptions = {
      gateway: resolved.gateway,
      ...(config.plugins === undefined ? {} : { plugins: config.plugins }),
      ...(resolved.readyTimeoutMs === undefined ? {} : { readyTimeoutMs: resolved.readyTimeoutMs }),
      ...(config.env === undefined ? {} : { env: config.env }),
    }
    this.identityHeaders = {
      'x-dsh-tenant-id': config.tenantId ?? 'dsh-ag-ui-adapter',
      'x-dsh-user-id': config.userId ?? 'local',
    }
  }

  /** Spawn the micro-host and wait for readiness; idempotent. */
  async start(): Promise<void> {
    await this.ensureStarted()
  }

  private async ensureStarted(): Promise<void> {
    // a failed spawn clears the slot so the next run retries with a fresh child
    this.starting ??= this.spawn().catch(error => {
      this.starting = undefined
      throw error
    })
    await this.starting
  }

  private async spawn(): Promise<void> {
    const host = await MicroHost.start(this.hostOptions)
    this.host = host
    this.sharedSecret = host.sharedSecret
    this.armIdleTimer()
  }

  /** The loopback gateway URL of the running micro-host. */
  get url(): string {
    if (this.host === undefined) throw new Error('The DSH micro-host has not started; await start() first.')
    return this.host.url
  }

  /**
   * The fetch config for one run request: gateway bearer authentication and
   * trusted identity headers, mirroring what a BFF would inject.
   */
  protected requestInit(input: RunAgentInput): RequestInit {
    return {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.sharedSecret}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        ...this.identityHeaders,
      },
      body: JSON.stringify(prepareDshRunInput(input)),
      signal: this.abortController.signal,
    }
  }

  run(input: RunAgentInput): Observable<BaseEvent> {
    // the thunk runs per subscription inside runHttpRequest's defer: starting
    // the host there is what makes the first run lazy
    const httpEvents = runHttpRequest(async () => {
      this.disarmIdleTimer()
      await this.ensureStarted()
      return await fetch(this.url, this.requestInit(input))
    })
    return transformHttpEventStream(httpEvents).pipe(finalize(() => this.armIdleTimer()))
  }

  public override async runAgent(
    parameters?: RunDshAgentParameters,
    subscriber?: AgentSubscriber,
  ): Promise<RunAgentResult> {
    this.abortController = parameters?.abortController ?? new AbortController()
    return await super.runAgent(parameters, subscriber)
  }

  override abortRun(): void {
    this.abortController.abort()
    super.abortRun()
  }

  /** Terminate the micro-host and remove its directory; safe to call twice. */
  async stop(): Promise<void> {
    // a failed or still-pending start must not break the teardown
    if (this.starting !== undefined) await this.starting.catch(() => {})
    const host = this.host
    this.disarmIdleTimer()
    // clearing synchronously lets a concurrent run spawn a fresh host instead
    // of posting to the one being terminated
    this.host = undefined
    this.sharedSecret = ''
    this.starting = undefined
    await host?.stop()
  }

  /** `await using agent` support: stopping the agent is disposing it. */
  async [Symbol.asyncDispose](): Promise<void> {
    await this.stop()
  }

  private disarmIdleTimer(): void {
    if (this.idleTimer === undefined) return
    clearTimeout(this.idleTimer)
    this.idleTimer = undefined
  }

  /** Arm the idle timer for a full window; a no-op while it is disabled. */
  private armIdleTimer(): void {
    this.disarmIdleTimer()
    if (this.idleShutdownMs === undefined || this.host === undefined) return
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined
      void this.stop()
    }, this.idleShutdownMs)
    // the timer alone must never keep the embedding process alive
    this.idleTimer.unref()
  }
}
