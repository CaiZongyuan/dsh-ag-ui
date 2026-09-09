import type { Context } from '@deepseek-ai/cordis'

/**
 * Optional host-side agent-preset roster, accessed structurally so a
 * deployment without presets keeps working and the package stays optional.
 * @module
 */

/** The subset of the roster's surface this Gateway depends on. */
interface AgentPresetsLike {
  /** Resolve one preset id to its canonical roster row. */
  resolve(id?: string): Promise<{ readonly id: string }>
  /** Compose one agent from a preset; call inside the agent factory's setup window. */
  mount(agentCtx: Context, id?: string): Promise<unknown>
}

/** Resolve the host's agent-preset roster without requiring one. */
export function agentPresetsOf(ctx: Context): AgentPresetsLike | undefined {
  return (ctx as Context & { get(name: string): unknown }).get('agentPresets') as AgentPresetsLike | undefined
}

interface PresetBearingSession {
  readonly header: { readonly agentPreset?: string }
  snapshotEvents(): ReadonlyArray<{ readonly type: string; readonly data: unknown }>
}

/**
 * The composition a durable session actually runs: the newest logged preset
 * selection wins over the creation header, because a session that switched
 * while blank ran its turns under the newer composition. Mirrors the upstream
 * resolver without depending on the roster package.
 */
export function sessionPresetOf(session: PresetBearingSession): string | undefined {
  const events = session.snapshotEvents()
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type !== 'agent-preset/selected') continue
    if (typeof event.data === 'object' && event.data !== null
      && typeof (event.data as { agentPreset?: unknown }).agentPreset === 'string') {
      return (event.data as { agentPreset: string }).agentPreset
    }
  }
  return session.header.agentPreset
}
