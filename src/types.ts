import type { Agent } from '@deepseek-ai/dsh-agent'

/** Authenticated BFF identity that owns an AG-UI thread. */
export interface AgUiPrincipal {
  readonly tenantId: string
  readonly userId: string
}

/** Process-local AG-UI identity associated with one Gateway-owned Agent. */
export interface AgUiThreadIdentity {
  readonly principal: AgUiPrincipal
  readonly threadId: string
}

/** Read-only Gateway lookup used by authenticated backend Tools. */
export interface AgUiAgentLookup {
  /**
   * Resolve an exact live Gateway-owned Agent.
   * @param agent - candidate live Agent.
   * @returns its authenticated thread identity, or undefined when another subsystem owns it.
   */
  identityFor(agent: Agent): AgUiThreadIdentity | undefined
}

/** One A2UI action projection that a Host-side observer asks the Gateway to append. */
export interface AgUiProjectedDelivery {
  /** Stable identity of this exact user action; a replay reuses it. */
  readonly identity: string
  /** AG-UI forwarded props carrying the A2UI action and the projection marker. */
  readonly forwardedProps: {
    readonly a2uiAction: {
      readonly userAction: Record<string, unknown>
    }
  } & Record<string, unknown>
  /** The synthetic assistant call plus its tool result, exactly as the Gateway admits them. */
  readonly messages: readonly Record<string, unknown>[]
}

/** Why one projection request was refused. */
export type AgUiProjectionRefusal =
  | 'invalid-delivery'
  | 'identity-conflict'
  | 'duplicate-identity'
  | 'unknown-thread'
  | 'ambiguous-thread'
  | 'queue-full'
  | 'thread-disposed'

/** Where an accepted projection went: the live run, or the next run's opening. */
export type AgUiProjectionDisposition = 'emitted' | 'queued'

/** Outcome of one Gateway projection request. */
export type AgUiProjectionResult =
  | { readonly accepted: true; readonly disposition: AgUiProjectionDisposition }
  | { readonly accepted: false; readonly reason: AgUiProjectionRefusal }

/** One projection request; a thread id, a durable session id, or both locate its binding. */
export interface AgUiProjectionRequest {
  /** Authenticated client thread id, when the observer knows it. */
  readonly threadId?: string
  /** Durable DSH session id carried by the observed event, when the observer knows it. */
  readonly sessionId?: string
  /** The exact delivery to append. */
  readonly delivery: AgUiProjectedDelivery
}
