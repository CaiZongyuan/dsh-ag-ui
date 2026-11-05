import type { HostPluginRow } from '../src/types.ts'

/** Shared overlay rows for the specs that spawn a real micro-host. */

export const AGENT_CORE_ROWS: readonly HostPluginRow[] = [
  { id: 'llm', name: '@deepseek-ai/dsh-llm' },
  { id: 'session', name: '@deepseek-ai/dsh-session' },
  { id: 'session-projection', name: '@deepseek-ai/dsh-session-projection' },
  {
    id: 'system-prompt',
    name: '@deepseek-ai/dsh-system-prompt',
    config: {
      includeHarnessIdentity: false,
      includeRuntimeContext: false,
      persona: 'You are the deterministic DSH AG-UI adapter test assistant.',
    },
  },
  { id: 'tools', name: '@deepseek-ai/dsh-tools' },
  { id: 'tool-executor-native', name: '@deepseek-ai/dsh-tool-executor-native' },
  { id: 'agent', name: '@deepseek-ai/dsh-agent' },
  { id: 'agent-loop', name: '@deepseek-ai/dsh-agent-loop', config: { agents: [] } },
]

export const SCRIPTED_MODEL_ROW: HostPluginRow = {
  id: 'scripted-model',
  name: new URL('./scripted-model.mjs', import.meta.url).href,
}

export const SIGTERM_SHIELD_ROW: HostPluginRow = {
  id: 'sigterm-shield',
  name: new URL('./fixtures/sigterm-shield.mjs', import.meta.url).href,
}

/** An environment whose child Node exits immediately with a usage error. */
export const BROKEN_NODE_ENV = { NODE_OPTIONS: '--definitely-not-a-node-option' } as const
