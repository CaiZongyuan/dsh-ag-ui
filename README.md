# dsh-ag-ui

English | [简体中文](README.zh.md)

[![CI](https://github.com/CaiZongyuan/dsh-ag-ui/actions/workflows/ci.yml/badge.svg)](https://github.com/CaiZongyuan/dsh-ag-ui/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/dsh-ag-ui.svg)](https://www.npmjs.com/package/dsh-ag-ui)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A community [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Host plugin that exposes DSH Agents through the [AG-UI protocol](https://github.com/ag-ui-protocol/ag-ui). It provides an authenticated HTTP/SSE Gateway, AG-UI thread-to-DSH Agent bindings, streamed text and Tool events, browser-owned Tools, and continuation of the same DSH turn after a browser Tool result returns. The same projection core is also available in an embedding form: the separate `dsh-ag-ui-adapter` package spawns a private loopback micro-host behind an AG-UI `AbstractAgent`.

> This is a community project. It is not an official DeepSeek or AG-UI package.

## Features

- Standard Cordis `Service` plugin exposed as `ctx.agUi`
- Transport-neutral Agent-scoped browser Tool broker exposed as `ctx.browserTools`
- Installable DSH Profile Bundle through `dsh plugin add`
- Floored AG-UI protocol range (`~0.0.58`)
- Authenticated BFF-to-Gateway requests with trusted tenant and user headers
- Process-local `(tenantId, userId, threadId)` bindings to DSH Agents
- AG-UI text streaming and backend Tool result projection
- Agent-scoped browser Tools supplied by `RunAgentInput.tools`
- Frontend Tool Promise parking and ToolMessage continuation across HTTP runs
- Bidirectional shared state through `RunAgentInput.state`, `ag_ui_update_state`, and `STATE_SNAPSHOT`
- Presenter cards for backend Tool calls as versioned `dsh:tool:view` CUSTOM events, live and on cold replay
- React renderers for every card kind in the separate `dsh-ag-ui-cards` package, with component tests against recorded gateway events
- An embedding adapter in the separate `dsh-ag-ui-adapter` package that spawns a loopback DSH micro-host and serves it as an AG-UI `AbstractAgent`
- A keyless Dojo-compatible example for five standard AG-UI features
- Run and message idempotency
- Bounded requests, context, Tool schemas, event buffers, threads, and run ledgers
- Complete Cordis disposal of routes, Agents, Tools, timers, and pending calls

## Requirements

- Node.js `^22.19.0` or `>=24.0.0`
- A DSH Profile containing the standard Host services
- A registered DSH model provider and model
- An authenticated Backend-for-Frontend that keeps the Gateway secret away from browsers

## Installation

Install the bundle into a DSH Profile:

```bash
dsh plugin --profile web add dsh-ag-ui
```

For the GitHub checkout before an npm release:

```bash
dsh plugin --profile web add github:CaiZongyuan/dsh-ag-ui
```

The bundle always mounts the lightweight `browser-tools` row. The AG-UI Gateway row stays dormant until all required environment variables are present, so native DSH integrations can lease browser-owned Tools without configuring a second model route or Gateway secret.

```bash
export DSH_AG_UI_PROVIDER='openai'
export DSH_AG_UI_MODEL='gpt-5.6-sol'
export DSH_AG_UI_SHARED_SECRET="$(openssl rand -hex 32)"
export DSH_AG_UI_PATH='/ag-ui' # optional

dsh --profile web
```

The bundle inserts an always-on `browser-tools` row and a conditional Host-plane `ag-ui` row. The first never creates an Agent: another integration selects an existing Agent and supplies a browser transport. The package also exports `dsh-ag-ui/invariant`; compositions that provide a process-global `invariants` service may load that optional companion explicitly. The default web Profile does not provide that service, so the installable bundle does not mount the companion automatically.

## Browser Tool broker

`dsh-ag-ui/browser-tools` hides provider-safe name checks, object-rooted schema validation, exact Agent-scope registration, catalog replacement, collisions, cancellation, timeout, and lease teardown behind one interface. A caller owns Agent selection and transport:

```ts
const lease = ctx.browserTools.bind(agent, owner, tools, {
  invoke: (call, signal) => browserTransport.invoke(call, signal),
})

lease.update(nextTools)
lease.dispose()
```

Browser context and Tool results are capability data, not authorization. Durable actions still require server-owned identity, resource checks, and any domain confirmation flow.

## Profile configuration

Environment variables are the shortest setup path. A Profile can instead override the bundle row in its own `cordis.patch.yml`:

```yaml
- id: ag-ui
  disabled: false
  config:
    provider: openai
    model: gpt-5.6-sol
    sharedSecret: !!js process.env.DSH_AG_UI_SHARED_SECRET
    path: /ag-ui
    maxThreads: 100
    frontendToolTimeoutMs: 300000
```

A later Profile patch replaces the bundle row's complete `config`; include every value that deployment needs.

## Configuration

`provider`, `model`, and `sharedSecret` are required. `sharedSecret` must contain at least 16 UTF-8 bytes.

| Field | Default | Purpose |
| --- | --- | --- |
| `path` | `/ag-ui` | Exact Host HTTP route |
| `provider` | required | Registered DSH model provider route |
| `model` | required | Model ID owned by the provider |
| `agentPreset` | none | Deployment-default agent preset id composed into every thread |
| `tenantPresets` | `{}` | Per-tenant preset ids taking precedence over `agentPreset` |
| `sharedSecret` | required | Bearer secret shared only with the trusted BFF |
| `tenantHeader` | `x-dsh-tenant-id` | Trusted tenant identity header |
| `userHeader` | `x-dsh-user-id` | Trusted user identity header |
| `allowNonLoopback` | `false` | Permit a non-loopback Host bind explicitly |
| `maxRequestBytes` | `262144` | Maximum request body bytes |
| `maxIdentityBytes` | `256` | Maximum bytes per protocol or identity ID |
| `maxMessages` | `256` | Maximum message count per request |
| `maxMessageBytes` | `524288` | Maximum combined message JSON bytes |
| `maxContexts` | `32` | Maximum context entry count |
| `maxContextBytes` | `131072` | Maximum combined context JSON bytes |
| `maxTools` | `32` | Maximum browser Tool count |
| `maxToolBytes` | `131072` | Maximum browser Tool JSON bytes |
| `maxToolSchemaDepth` | `16` | Maximum browser Tool schema depth |
| `maxForwardedPropsBytes` | `65536` | Maximum `forwardedProps` JSON bytes |
| `maxStateBytes` | `65536` | Maximum state JSON bytes |
| `maxThreads` | `100` | Maximum process-local live threads |
| `threadIdleMs` | `1800000` | Idle thread lifetime |
| `frontendToolTimeoutMs` | `300000` | Maximum browser Tool result wait |
| `maxRunEvents` | `4096` | Maximum events retained per run |
| `maxRunEventBytes` | `2097152` | Maximum retained event bytes per run |
| `maxRunsPerThread` | `32` | Maximum retained run ledger entries and, separately, waiting requests per thread |

`agentPreset` composes each thread's agent from the host's agent-presets roster (mount the roster plugin before this Gateway); an unresolvable id fails Gateway activation loudly, a per-tenant entry overrides the deployment default for that tenant's threads, and a resumed thread keeps the composition its own durable session recorded. Without `agentPreset`, threads keep the host composition unchanged.

`maxRunEvents` must retain at least the mandatory opening and terminal events. `maxRunEventBytes` bounds the complete retained Run record, including `RUN_STARTED` and its terminal event, and must be large enough for the configured maximum identity length. A non-loopback DSH WebServer requires `allowNonLoopback: true`. Prefer a loopback Gateway behind a same-host authenticated BFF.

Opening and final durable history snapshots both count toward this bound. Buffer overflow ends the HTTP run and cancels only its currently claimed native turn. An overflowing history-only read does not cancel another active turn. Completed duplicate requests still replay the exact retained events.

## Architecture

One projection core, two supported shapes. The core is the `dsh-ag-ui` Host service: it binds AG-UI threads to DSH Agents and translates runs, events, tools, shared state, and presenter cards in both directions. Everything around it is packaging.

```text
Deployment form — BFF Gateway            Embedding form — dsh-ag-ui-adapter

Browser                                   Node.js application
  -> authenticated application BFF         -> DshAgent (an AG-UI AbstractAgent)
       bearer secret and trusted                spawns a private micro-host child:
       identity headers                         - loopback webserver, ephemeral port
  -> POST /ag-ui on the Host                    - the same published dsh-ag-ui
  -> dsh-ag-ui Host Service                       gateway row, per-process secret
  -> DSH Agent / Session / Tool runtime         - the application's Agent core and
  -> model provider and backend Tools              model plugin rows
                                             -> run() over loopback HTTP to the
                                                same gateway service
```

The deployment form fronts a shared Host with an authenticated BFF for browser clients. The embedding form ([`dsh-ag-ui-adapter`](packages/dsh-ag-ui-adapter)) composes a throwaway Host per application process — nothing is spawned before the first run, and the child never outlives the process. Both shapes speak the same protocol to the same projection core, so run semantics, browser Tools, shared state, presenter cards, idempotency, and disposal behave identically.

In both forms the gateway binding key is the exact `(tenantId, userId, threadId)` tuple supplied through trusted identity headers.

## Trust posture

- The gateway listens on the Host webserver. Keep that webserver loopback and behind a same-host authenticated BFF; a non-loopback bind requires the explicit `allowNonLoopback` setting and is almost always a mistake.
- The bearer secret authenticates **one service-to-service hop** — the BFF (or, in the embedding form, the adapter process) to the gateway. It is not end-user authentication: the gateway never sees a user credential and by itself grants nothing user-scoped.
- End-user identity travels in the trusted `tenantHeader`/`userHeader` headers. Whoever holds the secret can assert any identity, so the secret holder must itself be trustworthy — in the deployment form, authenticating the user before injecting those headers is the BFF's whole job; in the embedding form the adapter process is the trusted principal.
- Browser-supplied identity, permission, patient ID, resource ID, `context`, `state`, `forwardedProps`, Tool schemas, and IDs inside messages are untrusted wire input and never grant backend authority.
- Backend Tools can derive the authenticated thread identity from the Agent:

```ts
const identity = ctx.agUi.identityFor(exec.agent)
if (identity === undefined) {
  throw new Error('This Tool requires an authenticated AG-UI thread.')
}

const { principal, threadId } = identity
```

The application should map this tuple to its server-owned resource authorization state.

## BFF proxy

The browser must not call the private Gateway directly. A BFF should authenticate the user, authorize the application resource, retain the browser request body exactly, and inject trusted identity headers.

```ts
app.post('/api/agent', async (c) => {
  const user = await authenticateApplicationRequest(c.req.raw)
  const body = new Uint8Array(await c.req.raw.arrayBuffer())

  const upstream = await fetch('http://127.0.0.1:3080/ag-ui', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${process.env.DSH_AG_UI_SHARED_SECRET}`,
      'content-type': 'application/json',
      'x-dsh-tenant-id': user.tenantId,
      'x-dsh-user-id': user.userId,
    },
    body,
  })

  return new Response(upstream.body, {
    status: upstream.status,
    headers: upstream.headers,
  })
})
```

The BFF owns login, sessions, CSRF protection, tenant policy, resource authorization, audit, and rate limits. Do not treat the Gateway bearer secret as end-user authentication.

### Proxying Host service-plugin remotes

The AG-UI gateway is one Host-plane service with an HTTP remote; other DSH service plugins can mount routes on the same loopback webserver. The same rule covers every one of them: the browser never reaches the Host directly. Expose each remote through the application backend under an application-owned route, with the authenticate → authorize → forward shape above and the credentials that service expects. The Host port itself stays loopback and unadvertised to clients.

## Browser client

Install the official client in the frontend application. Any release in the supported protocol range (`>=0.0.58 <0.1.0`) works; the gateway never requires an exact client pin:

```bash
pnpm add @ag-ui/client
```

Send page-specific browser Tools and current context on every run:

```ts
import { HttpAgent, randomUUID } from '@ag-ui/client'

const agent = new HttpAgent({
  url: '/api/agent',
  threadId: 'application-thread-123',
})

agent.addMessage({
  id: randomUUID(),
  role: 'user',
  content: 'Review the current draft.',
})

await agent.runAgent({
  runId: randomUUID(),
  tools: browserTools,
  context: [{
    description: 'Current page state',
    value: JSON.stringify(readPageSnapshot()),
  }],
  forwardedProps: {},
})
```

If the model calls a browser-owned Tool, the current HTTP run finishes successfully while the DSH Tool Promise remains pending. The browser executes the Tool, appends one standard AG-UI ToolMessage with the same `toolCallId`, and starts another run. The Gateway resolves the original Promise and continues the same DSH turn.

Do not send ordinary browser Tool results through AG-UI `resume[]`; that field is reserved for explicit interrupt/HITL flows.

## Shared state

Activate shared state by setting a non-empty initial value before the first run:

```ts
agent.setState({
  recipe: {
    title: 'Draft',
    ingredients: [],
  },
})
```

The Gateway injects the accepted state into the DSH Session, registers the reserved `ag_ui_update_state` Tool in the exact Agent scope, and emits `STATE_SNAPSHOT`. The official client replaces `agent.state` when each snapshot arrives.

The state Tool accepts:

```json
{
  "state_updates": {
    "recipe": {
      "title": "Pasta Primavera"
    }
  }
}
```

Updates use a shallow top-level merge: omitted top-level keys remain, while supplied nested values replace the previous nested value. The Gateway measures the complete merged state against `maxStateBytes`. It commits a model update and emits its snapshot only after DSH appends the durable `tool/result`; equal updates retain the Tool result but emit no redundant changed-state snapshot.

Initial activation ignores the default empty state sent by clients that do not use shared state. After activation, later empty objects, arrays, or `null` are valid complete baselines. Omitting `state` retains the current thread state.

Shared state is model/UI collaboration data. It never grants backend authority and should not replace an application's durable database state. `STATE_DELTA` is not implemented yet.

## Dojo-compatible example

The package ships the framework-free BFF plugin as `dsh-ag-ui/dojo-host`. The keyless scripted model, launcher, and five-feature suite remain source-checkout fixtures. See [examples/dojo/README.md](examples/dojo/README.md) for commands, routes, upstream Dojo compatibility, real-model configuration, and security limitations.

The upstream Dojo integration registry is static and has no `deepseek-harness` entry yet, so local upstream testing temporarily reuses the Claude Agent SDK TypeScript menu entry purely as a URL/path alias. The alias disappears once the upstream integration PR registering a DeepSeek Harness entry is accepted; no Claude runtime, model, or credential is involved.

The recording below shows the shared-state feature on the upstream Dojo demo viewer against this repository's keyless fixture. Both chat turns flow through the gateway: the first reads the shared state, the second emits `STATE_SNAPSHOT` events that rewrite the recipe form. Playback is sped up 3x and carries English captions.

<video controls muted playsinline width="800">
  <source src="docs/demo/dojo-shared-state.mp4" type="video/mp4" />
  <track src="docs/demo/dojo-shared-state.vtt" kind="captions" srclang="en" label="English" default />
</video>

If the inline player does not render on this host, download [docs/demo/dojo-shared-state.mp4](docs/demo/dojo-shared-state.mp4) (captions: [docs/demo/dojo-shared-state.vtt](docs/demo/dojo-shared-state.vtt)).

## Embedded adapter

The separate [`dsh-ag-ui-adapter`](packages/dsh-ag-ui-adapter) package is the embedded counterpart of this deployment-form Gateway. A `DshAgent` (`AbstractAgent` subclass) spawns a DSH micro-host child — a Cordis overlay composing the loopback webserver on an ephemeral port, this Gateway with a per-process generated secret, and the caller's explicit Agent-core and model rows — and passes `run()` through loopback HTTP using the official client primitives, adding no protocol translation code. The host starts lazily on the first run, can idle-shut-down, and never outlives the embedding process. See its README for usage, plugin row resolution, environment fallback, lifecycle, and the trust posture of the embedded shape.

## HTTP and run semantics

- Requests must be `POST application/json` and match AG-UI `RunAgentInput`.
- A normal run accepts one or more new text user messages; they join one DSH turn in arrival order. A run without new messages, including a full already-accepted transcript, only returns the history snapshot; it never waits behind an active run.
- A continuation accepts one or more new frontend ToolMessages for one pending DSH turn.
- One DSH turn can cross multiple AG-UI HTTP runs.
- Each run emits one `RUN_STARTED` and exactly one `RUN_FINISHED` or `RUN_ERROR`.
- Native turns can outlive their HTTP response while frontend calls are parked. Their durable results, shared-state updates, and completion continue to update the thread projection. Invalid continuations leave pending calls available for a corrected request.
- A failed user batch cancels its pending native inbox input. Discarded, unclaimed messages can be retried with their original message IDs; already claimed messages remain accepted, including after restart. A failed run ID still replays its recorded error, so retry input with a new run ID.
- `runId` is an exact-request idempotency key. Completed identical requests, including history-only runs, replay retained events without driving DSH again. All runs share the bounded ledger; active records are never evicted, and a full ledger rejects admission with `429 RUN_LEDGER_FULL`.
- One thread drives one HTTP run at a time. A run that arrives while another is active waits for it and for the Agent turn to settle, so the runs of one thread are served in arrival order; a waiting client that disconnects is never admitted. Waiting and reservation happen together, so several queued runs all get their turn. At most `maxRunsPerThread` requests may wait per thread; excess requests receive `429 RUN_QUEUE_FULL`, and disconnect frees a queue slot. A waiting request keeps the thread alive until admission or disconnect, including while a cancelled native turn settles. Identical requests that queued together replay the same retained result.
- An active shared-state run emits its synchronization snapshot before model events.
- One DSH step can park multiple frontend Tool calls; continuation runs may answer a subset.

## Client-provided Tools

Browser Tool names must match:

```text
[A-Za-z_][A-Za-z0-9_-]{0,63}
```

This conservative subset follows common model-provider function-name limits; AG-UI itself does not require this exact regular expression. The name `ag_ui_update_state` is reserved for protocol shared state. Browser Tool parameters must use the object-rooted JSON Schema subset enforced by DSH Tools. The Gateway rejects collisions with inherited or global Tools and registers each accepted definition only in the exact Agent's Tool scope.

Backend Tool results are emitted as `TOOL_CALL_RESULT`. Frontend Tool results are not echoed on the AG-UI wire because the browser already added the ToolMessage; DSH still records the real durable `tool/result`.

## Tool view cards

Every backend Tool call carries its DSH render-intent card next to the standard tool events, as a CUSTOM event named `dsh:tool:view`:

```json
{
  "version": 1,
  "callId": "call-42",
  "toolName": "read_file",
  "phase": "call",
  "card": { "card": "generic", "title": "Reading src/index.ts", "kind": "read" }
}
```

- The Gateway resolves the Tool definition in the Agent scope that executed the call, then evaluates its `presentCall` (pending state, emitted after `TOOL_CALL_END`) and `presentResult` (completed state, emitted after `TOOL_CALL_RESULT`) intents. Both are pure functions of the arguments and the durable result, including the presentation metadata the Tool's `output.presentationMeta` projected into its session log.
- A Tool without intents, a returning intent, or a throwing intent soft-falls to the generic card: `{ "card": "generic", "title": "<toolName>", "rawInput": <args> }` for the pending state and `{ "card": "generic" }` (keep the pending title, render the raw result) for the completed state.
- The card vocabulary is DSH's provider-neutral `ToolCallView`/`ToolResultView` union (`generic`, `terminal`, `diff`, `search`, `read`, `web` cards), so a UI renders cards without special-casing Tool names.
- The reserved `ag_ui_update_state` Tool and client-provided frontend Tools are excluded: the state Tool projects through `STATE_SNAPSHOT`, and the client already knows how to present its own Tools.
- At each run start, the Gateway re-derives the settled cards of the whole transcript from the durable session log — the same evaluator and inputs as the live path — and emits them right after `MESSAGES_SNAPSHOT`, so a client that missed the live stream renders identical cards. A cold read only re-derives cards for Tools that still resolve in the thread's scope, so a crash-materialized frontend Tool call after a restart stays cardless. Cards count against the per-run event budget.

The reserved `ag_ui_update_state` call and result remain protocol-only in live events and restored message history.

The separate [`dsh-ag-ui-cards`](packages/dsh-ag-ui-cards) React package renders every card kind from these envelopes with no DSH runtime dependency, and documents the event-wiring recipe. Its component tests render events recorded from this Gateway, and the recording scenario stays guarded by this package's test suite.

## Lifecycle

All effects belong to the Cordis plugin fiber. Route removal, idle expiry, timeout, and plugin disposal unregister browser Tools, reject pending calls, cancel active work, dispose Agent handles, and wait for quiescence.

An unexpected HTTP disconnect cancels the Gateway-owned DSH turn. `HttpAgent` does not implement partial SSE reconnect. A frontend Tool handoff is an intentional completed run and does not cancel the parked turn.

## Compatibility

| Component | Supported version |
| --- | --- |
| AG-UI core/client/encoder | `>=0.0.58 <0.1.0` (`~0.0.58`; tested with `0.0.58`) |
| Node.js | `^22.19.0` or `>=24.0.0` |
| DeepSeek Harness | `0.1.5-alpha.1` (exact developer-preview peers) |

DSH `0.1.5-alpha.1` uses session log v3. Live text arrives through `agent/assistant-stream`; settled history is read with `snapshotEvents()`. With the JSONL persistence plugin configured, DSH migrates older logs on resume (tested with a `0.1.1-rc.2` recording). Image and file Tool results are represented by `[image result]` and `[file result]` placeholders; attachment bytes are not transported.

DSH is in developer preview and can introduce breaking changes. This package uses exact DSH peer versions until those APIs stabilize.

## Model Experience

### Injected AG-UI context

#### What the model sees

Each non-empty `RunAgentInput.context` becomes one user-role snapshot containing ordered `## <description>` sections. The source is `{ kind: "plugin", plugin: "ag-ui", form: "snapshot", sections }`.

#### Token effect

Conditional and retained. Every accepted normal or continuation run appends its bounded context snapshot to the DSH Session and later model history.

#### KV cache effect

Append-only context preserves earlier reusable history. Changed current context adds a new suffix; provider cache availability is outside this package.

### Shared application state

#### What the model sees

Once activated, the complete bounded state appears in a `Current Shared State` section and the reserved `ag_ui_update_state` Tool joins the Agent schema. A successful state update returns the complete merged state as a durable DSH Tool result.

#### Token effect

Conditional and retained. Every accepted run with active shared state appends the full state baseline. A model update additionally appends one Tool call/result pair containing the complete merged state.

#### KV cache effect

An unchanged earlier history remains reusable, but each current state baseline and changed Tool result adds a suffix. Large or frequently changing state reduces cache reuse and increases retained Session tokens.

### Client-provided capabilities

#### What the model sees

The current Agent-scoped browser Tool definitions join the ordinary DSH Tool schema list. Their names, descriptions, and validated parameter schemas come from the authenticated client request; execution remains browser-owned.

#### Token effect

Conditional and replacing. The visible Tool schema list is sent on every model request and changes when the page advertises a different capability set.

#### KV cache effect

An unchanged Tool set preserves the Tool-schema prefix. Adding, removing, or changing a Tool may invalidate provider reuse from that portion onward.

## Known limitations

- Live thread bindings, run replay buffers, and shared state are process-local; session history can persist through the Host persistence plugin.
- Host restart resumes stored sessions with `agents.resume()`. Parked browser Tools are not recovered: an interrupted turn reports `THREAD_INTERRUPTED`, and shared state needs a new client baseline.
- Only text user input, assistant text, and string Tool results are adapted.
- Partial SSE reconnect is not supported.
- `STATE_DELTA`, AG-UI interrupt/HITL `resume[]`, multimodal messages, reasoning events, and activity events are not adapted yet.
- Shared-state updates use shallow top-level merge and do not provide versions, deep merge, or conflict resolution.

## Development

```bash
git clone https://github.com/CaiZongyuan/dsh-ag-ui.git
cd dsh-ag-ui
corepack enable
pnpm install
pnpm -r --workspace-root check
```

The repository is a pnpm workspace: the root package is the Gateway, and `packages/` holds the `dsh-ag-ui-cards` React card renderers and the `dsh-ag-ui-adapter` embedding adapter. `pnpm -r --workspace-root check` runs lint, strict TypeScript checking, per-file coverage, runtime/type builds, and publint in every workspace project. The Dojo fixture is intentionally source-checkout-only and is not included in the npm tarball.

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution and release requirements.

## License

[MIT](LICENSE). Portions are adapted from DeepSeek Harness; see [NOTICE](NOTICE).
