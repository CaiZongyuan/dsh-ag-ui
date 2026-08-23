# Dojo-compatible keyless example

English | [简体中文](README.zh.md)

This example exposes the first five AG-UI feature routes implemented by the DSH adapter:

- `/agentic_chat`
- `/backend_tool_rendering`
- `/shared_state`
- `/human_in_the_loop`
- `/tool_based_generative_ui`

It boots the built `dsh-ag-ui` package through the real Cordis Loader, uses a deterministic scripted DSH model, and keeps the private Gateway behind a same-process BFF mapper.

## Start

```bash
pnpm build
node examples/dojo/start.mjs
```

The default address is `http://127.0.0.1:8020` when accessed locally. The server binds to `0.0.0.0` by default for Dojo compatibility.

Override the exact host and port when needed:

```bash
HOST=0.0.0.0 PORT=8889 node examples/dojo/start.mjs
```

Check readiness:

```bash
curl http://127.0.0.1:8020/health
```

## Use an AG-UI client

```ts
import { HttpAgent, randomUUID } from '@ag-ui/client'

const agent = new HttpAgent({
  url: 'http://127.0.0.1:8020/agentic_chat',
  threadId: randomUUID(),
})

agent.addMessage({
  id: randomUUID(),
  role: 'user',
  content: 'Hi, my name is Alex.',
})

await agent.runAgent({
  runId: randomUUID(),
  tools: [],
  context: [],
  forwardedProps: {},
})
```

The shared-state route accepts ordinary `HttpAgent.state`. The HITL and generative-UI routes require the frontend Tool schemas used in `tests/dojo-loader.spec.ts`.

## Test with the official AG-UI Dojo UI

The upstream Claude Agent SDK TypeScript entry maps the same five paths and defaults to `http://localhost:8020`. For local compatibility testing, start this DSH example on port `8020`, then start the upstream Dojo without the Claude server:

```bash
git clone https://github.com/ag-ui-protocol/ag-ui.git
cd ag-ui
pnpm install
cd apps/dojo
pnpm dev
```

Open `http://localhost:3000`, select **Claude Agent SDK (Typescript)**, and use its five feature pages. The label remains Claude because DSH is not registered upstream yet, but every request goes to this DSH example. Set `CLAUDE_AGENT_SDK_TYPESCRIPT_URL` when using a non-default address.

## Run with a configured DSH model

The default source-checkout command is deterministic and keyless. To use the providers, settings, and credentials from an installed full DSH web Profile, build this package and apply the real-model patch:

```bash
pnpm build
dsh plugin --profile web add .
export DSH_AG_UI_PROVIDER='openai'
export DSH_AG_UI_MODEL='gpt-5.6-sol'
export DSH_AG_UI_SHARED_SECRET="$(openssl rand -hex 32)"
HOST=0.0.0.0 PORT=8020 \
  dsh --profile web --patch ./examples/dojo/cordis.real.patch.yml
```

The real model receives the same frontend Tool schemas and shared-state instructions. Its wording and Tool choices are nondeterministic; the keyless suite remains the protocol regression test.

## Security

The example is synthetic and keyless. Its public feature routes act as the BFF and inject server-owned feature identities before calling `/_internal/ag-ui`. When no secret is supplied, `start.mjs` generates an unpredictable per-process secret before Cordis loads. A direct request to the private route still requires that secret.

The compact fixture registers its synthetic weather Tool globally, then enforces the `backend_tool_rendering` feature identity in the executor. Other real-model feature Agents can still see that schema, so the trusted feature instructions tell them not to call it. A production integration should provide per-Agent backend capability sets instead. Do not use the permissive CORS policy, scripted model, debug endpoint, or synthetic weather Tool in production.

## Upstream AG-UI Dojo

This fixture validates DSH behavior without adding CopilotKit or Playwright to this package. A later maintainer-approved AG-UI upstream integration can map these five feature paths into `apps/dojo` and reuse the upstream feature pages and E2E suite.
