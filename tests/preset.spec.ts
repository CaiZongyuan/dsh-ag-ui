import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { HttpAgent } from '@ag-ui/client'
import { EventType } from '@ag-ui/core'
import { Context } from '@deepseek-ai/cordis'
import AgentPresets from '@deepseek-ai/dsh-agent-presets'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import type { Config } from 'dsh-ag-ui'
import AgUiGateway from 'dsh-ag-ui'
import { ScriptedAdapter, textResponse, toolCallsResponse } from './scripted-adapter.ts'
import { runAgentEvents } from './harness.ts'
import { mountTestAgentCore } from './agent-core.ts'
import { durableSessionId } from '../src/session-id.ts'
import { sessionPresetOf } from '../src/presets.ts'
import { ThreadBinding, type ThreadOptions } from '../src/thread.ts'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'

/**
 * Preset mounting: a configured roster composes each thread's agent inside
 * the setup window, per-tenant overrides take precedence, an unresolvable id
 * fails plugin activation loudly, and a resumed thread keeps the composition
 * its own durable log recorded.
 */

const SECRET = 'preset-test-shared-secret'
const ROOT = fileURLToPath(new URL('./fixtures/presets/roots/', import.meta.url))
const PRINCIPAL = { tenantId: 'tenant-1', userId: 'user-1' }

const contexts: Context[] = []
const roots: string[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function mount(overrides: Partial<Config> = {}, script: StreamChunk[][] = [textResponse('ok')], withRoster = true): Promise<{ url: string, adapter: ScriptedAdapter }> {
  const ctx = new Context()
  ctx.baseUrl = new URL('./fixtures/presets/roots/', import.meta.url).href
  contexts.push(ctx)
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  await mountTestAgentCore(ctx)
  if (withRoster) {
    await ctx.plugin(Loader)
    await ctx.plugin(AgentPresets, { default: 'alpha', roots: [{ path: ROOT, trust: 'system' }], includeUserRoot: false })
  }
  const adapter = new ScriptedAdapter(script)
  ctx.llm.registerAdapter(['scripted'], adapter)
  await ctx.plugin(AgUiGateway, {
    provider: 'scripted',
    model: 'scripted',
    sharedSecret: SECRET,
    agentPreset: 'alpha',
    ...overrides,
  })
  return { url: `http://127.0.0.1:${String(ctx.webServer.port)}/ag-ui`, adapter }
}

function agentFor(url: string, tenantId: string, threadId: string): HttpAgent {
  return new HttpAgent({
    url,
    threadId,
    headers: {
      authorization: `Bearer ${SECRET}`,
      'x-dsh-tenant-id': tenantId,
      'x-dsh-user-id': 'user-1',
    },
  })
}

const collectEvents = async (agent: HttpAgent, runId: string): Promise<Array<{ type: string, [key: string]: unknown }>> =>
  await runAgentEvents(agent, runId, []) as Array<{ type: string, [key: string]: unknown }>

describe('agent preset mounting', () => {
  it('composes a thread from the configured preset and serves its tool', async () => {
    const { url } = await mount({}, [
      toolCallsResponse([{ callId: 'preset-call-1', name: 'preset_alpha_probe', args: { probe: 'thread-1' } }]),
      textResponse('The alpha probe answered.'),
    ])
    const agent = agentFor(url, PRINCIPAL.tenantId, 'preset-default')
    agent.addMessage({ id: 'preset-user-1', role: 'user', content: 'Probe the preset.' })
    const events = await collectEvents(agent, 'preset-run-1')

    const result = events.find(event => event.type === EventType.TOOL_CALL_RESULT)
    expect(result).toMatchObject({ toolCallId: 'preset-call-1', role: 'tool' })
    expect(JSON.parse(String(result?.content))).toMatchObject({ probe: 'thread-1', marker: 'alpha-tool-live' })
    expect(events.at(-1)).toMatchObject({ type: EventType.RUN_FINISHED })
    expect(agent.messages.findLast(message => message.role === 'assistant')?.content).toBe('The alpha probe answered.')
  })

  it('lets a per-tenant override take precedence over the deployment default', async () => {
    const { url } = await mount({ tenantPresets: { 'tenant-2': 'beta' } }, [
      toolCallsResponse([{ callId: 'default-call-1', name: 'preset_alpha_probe', args: { probe: 'default' } }]),
      textResponse('alpha done.'),
      toolCallsResponse([{ callId: 'override-call-1', name: 'preset_beta_probe', args: { probe: 'override' } }]),
      textResponse('beta done.'),
    ])
    const defaultTenant = agentFor(url, 'tenant-1', 'preset-default-tenant')
    defaultTenant.addMessage({ id: 'preset-user-2', role: 'user', content: 'Probe the preset.' })
    const defaultEvents = await collectEvents(defaultTenant, 'preset-run-2')
    expect(JSON.parse(String(defaultEvents.find(event => event.type === EventType.TOOL_CALL_RESULT)?.content)))
      .toMatchObject({ preset: 'alpha', marker: 'alpha-tool-live' })

    const overrideTenant = agentFor(url, 'tenant-2', 'preset-override-tenant')
    overrideTenant.addMessage({ id: 'preset-user-3', role: 'user', content: 'Probe the preset.' })
    const overrideEvents = await collectEvents(overrideTenant, 'preset-run-3')
    expect(JSON.parse(String(overrideEvents.find(event => event.type === EventType.TOOL_CALL_RESULT)?.content)))
      .toMatchObject({ preset: 'beta', marker: 'beta-tool-live' })
  })

  it('fails plugin activation when a configured preset id is unknown', async () => {
    await expect(mount({ agentPreset: 'nope' })).rejects.toThrow(/nope/)
  })

  it('fails plugin activation when presets are configured without a roster', async () => {
    await expect(mount({}, [textResponse('ok')], false)).rejects.toThrow(/no agent-presets roster/)
    await expect(mount({ agentPreset: undefined, tenantPresets: { 'tenant-2': 'beta' } }, [textResponse('ok')], false))
      .rejects.toThrow(/no agent-presets roster/)
  })

  it('skips composition when the roster is mounted but no preset is configured', async () => {
    const { url } = await mount({ agentPreset: undefined }, [textResponse('skeleton beside a roster.')])
    const agent = agentFor(url, PRINCIPAL.tenantId, 'preset-roster-skeleton')
    agent.addMessage({ id: 'preset-user-6', role: 'user', content: 'Hello.' })
    const events = await collectEvents(agent, 'preset-run-6')
    expect(events.at(-1)).toMatchObject({ type: EventType.RUN_FINISHED })
    expect(agent.messages.findLast(message => message.role === 'assistant')?.content).toBe('skeleton beside a roster.')
  })

  it('composes from a tenant override with no deployment default', async () => {
    const { url } = await mount({ agentPreset: undefined, tenantPresets: { 'tenant-2': 'beta' } }, [
      toolCallsResponse([{ callId: 'override-only-call-1', name: 'preset_beta_probe', args: { probe: 'override-only' } }]),
      textResponse('beta without a default.'),
    ])
    const overrideTenant = agentFor(url, 'tenant-2', 'preset-override-only')
    overrideTenant.addMessage({ id: 'preset-user-5', role: 'user', content: 'Probe the preset.' })
    const events = await collectEvents(overrideTenant, 'preset-run-5')
    expect(JSON.parse(String(events.find(event => event.type === EventType.TOOL_CALL_RESULT)?.content)))
      .toMatchObject({ preset: 'beta', marker: 'beta-tool-live' })
  })

  it('keeps every existing behavior when no preset is configured', async () => {
    const { url } = await mount({ agentPreset: undefined }, [textResponse('plain skeleton answer.')], false)
    const agent = agentFor(url, PRINCIPAL.tenantId, 'preset-skeleton')
    agent.addMessage({ id: 'preset-user-4', role: 'user', content: 'Hello.' })
    const events = await collectEvents(agent, 'preset-run-4')
    expect(events.at(-1)).toMatchObject({ type: EventType.RUN_FINISHED })
    expect(agent.messages.findLast(message => message.role === 'assistant')?.content).toBe('plain skeleton answer.')
  })
})

describe('threads refuse a configured preset without a roster', () => {
  it('fails thread initialization loudly when no roster is active', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await mountTestAgentCore(ctx)
    const principal = { tenantId: 'tenant-1', userId: 'user-1' }
    const binding = new ThreadBinding(
      ctx,
      principal,
      'preset-no-roster',
      durableSessionId(principal, 'preset-no-roster', SECRET),
      {
        provider: 'scripted',
        model: 'scripted',
        presetId: 'alpha',
        frontendToolTimeoutMs: 10_000,
        threadIdleMs: 60_000,
        maxRunEvents: 128,
        maxRunEventBytes: 128 * 1024,
        maxRunsPerThread: 4,
        maxStateBytes: 64 * 1024,
      },
      () => {},
    )
    await expect(binding.initialize()).rejects.toThrow(/no agent-presets roster is active/)
  })
})

describe('session preset resolution', () => {
  it('prefers the newest logged selection over the creation header', () => {
    const selected = (preset: string) => ({ type: 'agent-preset/selected', data: { agentPreset: preset } })
    expect(sessionPresetOf({ header: { agentPreset: 'alpha' }, snapshotEvents: () => [] })).toBe('alpha')
    expect(sessionPresetOf({
      header: { agentPreset: 'alpha' },
      snapshotEvents: () => [selected('beta')],
    })).toBe('beta')
    expect(sessionPresetOf({
      header: { agentPreset: 'alpha' },
      snapshotEvents: () => [selected('beta'), selected('gamma')],
    })).toBe('gamma')
    expect(sessionPresetOf({ header: {}, snapshotEvents: () => [] })).toBeUndefined()
    expect(sessionPresetOf({
      header: { agentPreset: 'alpha' },
      snapshotEvents: () => [{ type: 'agent-preset/selected', data: {} }],
    })).toBe('alpha')
  })
})

describe('resumed threads keep their recorded composition', () => {
  const OPTIONS = (presetId: string): ThreadOptions => ({
    provider: 'scripted',
    model: 'scripted',
    presetId,
    frontendToolTimeoutMs: 10_000,
    threadIdleMs: 60_000,
    maxRunEvents: 128,
    maxRunEventBytes: 128 * 1024,
    maxRunsPerThread: 4,
    maxStateBytes: 64 * 1024,
  })

  it('mounts the log-recorded preset even after the tenant override changed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ag-ui-preset-'))
    roots.push(root)
    const principal = { tenantId: 'tenant-1', userId: 'user-1' }
    const sessionId = durableSessionId(principal, 'preset-resume', SECRET)

    const first = new Context()
    first.baseUrl = new URL('./fixtures/presets/roots/', import.meta.url).href
    contexts.push(first)
    await mountTestAgentCore(first)
    await first.plugin(Loader)
    await first.plugin(AgentPresets, { default: 'alpha', roots: [{ path: ROOT, trust: 'system' }], includeUserRoot: false })
    first.llm.registerAdapter(['scripted'], new ScriptedAdapter([textResponse('alpha turn done.')]))
    await first.plugin(JsonlSessionPersistence, { root, compression: 'none' })
    const original = new ThreadBinding(first, principal, 'preset-resume', sessionId, OPTIONS('alpha'), () => {})
    await original.initialize()
    expect(original.liveAgent.session.header.agentPreset).toBe('alpha')
    const firstRun = original.reserveRun({
      threadId: 'preset-resume',
      runId: 'preset-resume-run-1',
      messages: [{ id: 'preset-resume-user-1', role: 'user', content: 'Run the first turn.' }],
      tools: [],
      context: [],
      state: {},
      forwardedProps: {},
    }, 'digest-preset-resume-1')
    original.drive(firstRun)
    await firstRun.done
    await original.dispose()
    await new Promise(resolve => setTimeout(resolve, 300))
    await first.fiber.dispose()
    contexts.splice(contexts.indexOf(first), 1)

    // the deployment now points this tenant at beta; the resumed session still composes alpha
    const second = new Context()
    second.baseUrl = new URL('./fixtures/presets/roots/', import.meta.url).href
    contexts.push(second)
    await mountTestAgentCore(second)
    await second.plugin(Loader)
    await second.plugin(AgentPresets, { default: 'alpha', roots: [{ path: ROOT, trust: 'system' }], includeUserRoot: false })
    second.llm.registerAdapter(['scripted'], new ScriptedAdapter([
      toolCallsResponse([{ callId: 'resumed-call-1', name: 'preset_alpha_probe', args: { probe: 'resumed' } }]),
      textResponse('alpha still composes the resumed thread.'),
    ]))
    await second.plugin(JsonlSessionPersistence, { root, compression: 'none' })
    const resumed = new ThreadBinding(second, principal, 'preset-resume', sessionId, OPTIONS('beta'), () => {})
    await resumed.initialize()
    expect(sessionPresetOf(resumed.liveAgent.session)).toBe('alpha')

    const run = resumed.reserveRun({
      threadId: 'preset-resume',
      runId: 'preset-resume-run-2',
      messages: [{ id: 'preset-resume-user-1', role: 'user', content: 'Run the first turn.' }, { id: 'preset-resume-user-2', role: 'user', content: 'Probe the preset again.' }],
      tools: [],
      context: [],
      state: {},
      forwardedProps: {},
    }, 'digest-preset-resume-2')
    resumed.drive(run)
    await run.done
    const events = run.record.events as Array<{ type: string, content?: unknown, toolCallId?: unknown }>
    const result = events.find(event => event.type === EventType.TOOL_CALL_RESULT)
    expect(JSON.parse(String(result?.content))).toMatchObject({ preset: 'alpha', marker: 'alpha-tool-live' })
    expect(events.at(-1)).toMatchObject({ type: EventType.RUN_FINISHED })
  })
})
