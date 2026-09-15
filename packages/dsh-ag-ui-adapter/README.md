# dsh-ag-ui-adapter

[![CI](https://github.com/CaiZongyuan/dsh-ag-ui/actions/workflows/ci.yml/badge.svg)](https://github.com/CaiZongyuan/dsh-ag-ui/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

An [`@ag-ui/client`](https://www.npmjs.com/package/@ag-ui/client) `AbstractAgent` that embeds [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) in a Node.js application. Instead of deploying a Host and proxying through a BFF, `DshAgent` spawns a DSH micro-host as a child process and speaks AG-UI to it over a loopback HTTP connection.

> This is a community project. It is not an official DeepSeek or AG-UI package.

## How it works

The adapter is a process manager plus a thin agent shell:

1. It composes a Cordis overlay — the same `cordis.yml` row format the documented Cordis-Loader overlay mechanism reads — containing a `@deepseek-ai/dsh-host-webserver` row bound to `127.0.0.1` on an ephemeral port, your plugin rows (Agent core, model adapter), the published `dsh-ag-ui` gateway row with a freshly generated per-process bearer secret, and a readiness reporter.
2. It writes that overlay into a clean temporary directory and spawns the child-side bootstrap through the current Node executable. The bootstrap mirrors `@deepseek-ai/cordis/bin.js` and loads the overlay with `@deepseek-ai/cordis-plugin-include`. No upstream package is patched or re-implemented.
3. Once the webserver and the gateway service are both active, the reporter writes the actually bound address, and `start()` resolves.
4. `run(input)` is composed entirely from the official client primitives — `runHttpRequest` over `fetch` and `transformHttpEventStream` — exactly like `HttpAgent.run`, so the adapter adds zero protocol translation code. Its only couplings are the published `dsh-ag-ui` gateway, the AG-UI client, and the DSH loader/webserver peers.

No child process exists until the first run needs one: `run()` starts the micro-host lazily, so an agent that is never run costs nothing.

## Usage

```bash
pnpm add dsh-ag-ui-adapter @ag-ui/client dsh-ag-ui \
  @deepseek-ai/cordis@4.0.2 \
  @deepseek-ai/dsh-host-webserver@0.1.5-alpha.2 \
  @deepseek-ai/dsh-agent@0.1.5-alpha.2 \
  @deepseek-ai/dsh-agent-loop@0.1.5-alpha.2 \
  @deepseek-ai/dsh-invariants@0.1.5-alpha.2 \
  @deepseek-ai/dsh-llm@0.1.5-alpha.2 \
  @deepseek-ai/dsh-session@0.1.5-alpha.2 \
  @deepseek-ai/dsh-session-persistence@0.1.5-alpha.2 \
  @deepseek-ai/dsh-session-projection@0.1.5-alpha.2 \
  @deepseek-ai/dsh-system-prompt@0.1.5-alpha.2 \
  @deepseek-ai/dsh-tools@0.1.5-alpha.2 \
  @deepseek-ai/dsh-util-values@0.1.5-alpha.2
```

```ts
import { DshAgent } from 'dsh-ag-ui-adapter'
import { randomUUID } from '@ag-ui/client'

const agent = new DshAgent({
  threadId: 'embedded-thread',
  gateway: {
    provider: 'my-provider', // registered by one of the plugin rows below
    model: 'my-model',
    path: '/ag-ui',
    overrides: { threadIdleMs: 60000 },
  },
  plugins: [
    // Minimal supported Agent core. Add optional DSH capabilities as their own rows.
    { id: 'llm', name: '@deepseek-ai/dsh-llm' },
    { id: 'session', name: '@deepseek-ai/dsh-session' },
    { id: 'session-projection', name: '@deepseek-ai/dsh-session-projection' },
    {
      id: 'system-prompt',
      name: '@deepseek-ai/dsh-system-prompt',
      config: { persona: 'You are a helpful assistant.' },
    },
    { id: 'tools', name: '@deepseek-ai/dsh-tools' },
    { id: 'agent', name: '@deepseek-ai/dsh-agent' },
    { id: 'agent-loop', name: '@deepseek-ai/dsh-agent-loop', config: { agents: [] } },

    // Application-owned model provider.
    { id: 'my-provider', name: 'file:///abs/path/to/provider-plugin.mjs' },
  ],
  tenantId: 'my-app',
  userId: 'local-user',
})

// the first run spawns the micro-host on demand; await agent.start() pre-warms instead
agent.addMessage({ id: randomUUID(), role: 'user', content: 'Hello!' })
await agent.runAgent({ runId: randomUUID(), tools: [], context: [], forwardedProps: {} })

await agent.stop() // terminates the child and removes its temporary directory
```

`DshAgent` extends `AbstractAgent`, so `messages`, `state`, `subscribe`, middlewares, and the verified `runAgent` pipeline behave exactly as with `HttpAgent`.

### Plugin row names

The micro-host runs from a clean temporary directory, so a row `name` must be:

- a `file:` URL or an absolute path — used verbatim, or
- a bare specifier — resolved from this package's own module graph, so the plugin must be installed next to `dsh-ag-ui-adapter` (resolve it on your side with `import.meta.resolve` or `require.resolve` when in doubt).

### Gateway options

`gateway` builds the gateway row: `provider` and `model` are required (directly or through their environment fallbacks below), `preset` becomes the gateway's deployment-default `agentPreset`, `path` defaults to `/ag-ui`, and `overrides` is merged after the adapter-owned values for resource bounds such as `maxRunEvents` or `threadIdleMs`. The per-process `sharedSecret` is always generated by the adapter and never configured or exposed.

### Environment fallback

Explicit constructor options always win; the environment fills the gaps. Values missing from both sources fail at construction, not at the first run.

| Option | Environment variable | Default |
| --- | --- | --- |
| `gateway.provider` | `DSH_AG_UI_ADAPTER_PROVIDER` | required from one source |
| `gateway.model` | `DSH_AG_UI_ADAPTER_MODEL` | required from one source |
| `gateway.preset` | `DSH_AG_UI_ADAPTER_PRESET` | omitted |
| `readyTimeoutMs` | `DSH_AG_UI_ADAPTER_READY_TIMEOUT_MS` | `20000` |
| `idleShutdownMs` | `DSH_AG_UI_ADAPTER_IDLE_SHUTDOWN_MS` | disabled |

The timeout variables must be positive integers in canonical form (`1500`, not `1.5e3`); anything else is rejected by name at construction.

## Trust posture

- The child binds `127.0.0.1` only, on an OS-assigned ephemeral port. `allowNonLoopback` is never set.
- The gateway bearer secret is 32 random bytes generated per host process, held in parent memory, and sent only over the loopback connection.
- The adapter sends the trusted `x-dsh-tenant-id` / `x-dsh-user-id` identity headers the gateway expects; in the embedded shape these name the embedding application's own principal, exactly as a BFF would inject them in the deployment shape.
- The general gateway rules apply unchanged: browser-supplied context, state, or tool schemas never grant backend authority. If you bridge an embedded agent to a browser, keep an authenticated BFF in front of it.

## Lifecycle

- Nothing is spawned until the first run: `run()` starts the micro-host lazily inside its HTTP request, and a failed start rejects that run. `start()` pre-warms the same host idempotently.
- With `idleShutdownMs` set, a host with no run inside the window shuts itself down; the next run lazily spawns a fresh child. Idle shutdown discards the child's process-local sessions — treat it as a recycle valve, not a persistence mechanism.
- `stop()` terminates the child (SIGTERM, then SIGKILL after a grace period) and removes the temporary directory; it is safe to call twice, after a failed `start()`, and while a start is still pending. `DshAgent` is `AsyncDisposable`, so `await using agent = new DshAgent(...)` stops it at scope exit.
- If the embedding process exits without stopping its agents, every live child is killed on exit — the child never outlives the app.
- Host threads, runs, and shared state are process-local, as in the gateway: a stopped micro-host keeps nothing.
- `abortRun()` aborts the active run's HTTP request; the next `runAgent` proceeds normally.

## Compatibility

| Component | Supported version |
| --- | --- |
| AG-UI client | `>=0.0.58 <0.1.0` (`~0.0.58`; tested with `0.0.58`) |
| Node.js | `^22.19.0 || >=24.0.0` |
| DeepSeek Harness | `0.1.5-alpha.2` (exact developer-preview peers) |

## Development

The package is part of the `dsh-ag-ui` pnpm workspace. `pnpm check` inside this directory runs lint, strict TypeScript, coverage-gated tests, the build, and publint; the end-to-end specs spawn a real micro-host with a keyless scripted model and assert the agentic-chat scenario, session memory across runs, and the failure and shutdown paths.

## License

[MIT](LICENSE). Copyright (c) 2026 Cai Zongyuan. See [NOTICE](NOTICE).
