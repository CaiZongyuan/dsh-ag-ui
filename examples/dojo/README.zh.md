# Dojo-compatible keyless example

[English](README.md) | 简体中文

该示例通过以下 paths 暴露 DSH adapter 首批实现的五项 AG-UI features：

- `/agentic_chat`
- `/backend_tool_rendering`
- `/shared_state`
- `/human_in_the_loop`
- `/tool_based_generative_ui`

它通过真实 Cordis Loader 启动构建后的 `dsh-ag-ui` package，使用确定性的 scripted DSH model，并把 private Gateway 放在同进程 BFF mapper 后面。

## 启动

```bash
pnpm build
node examples/dojo/start.mjs
```

本机默认访问地址是 `http://127.0.0.1:8020`。为兼容 Dojo，server 默认绑定 `0.0.0.0`。

需要时可以覆盖精确 host 和 port：

```bash
HOST=0.0.0.0 PORT=8889 node examples/dojo/start.mjs
```

检查 readiness：

```bash
curl http://127.0.0.1:8020/health
```

## 使用 AG-UI client

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

Shared-state route 接受普通 `HttpAgent.state`。HITL 与 generative-UI routes 需要 `tests/dojo-loader.spec.ts` 中使用的 frontend Tool schemas。

## 使用官方 AG-UI Dojo UI 测试

Upstream Claude Agent SDK TypeScript entry 映射相同的五个 paths，并默认连接 `http://localhost:8020`。本地兼容性测试时，先在 `8020` 端口启动该 DSH example，再启动 upstream Dojo，不需要启动 Claude server：

```bash
git clone https://github.com/ag-ui-protocol/ag-ui.git
cd ag-ui
pnpm install
cd apps/dojo
pnpm dev
```

打开 `http://localhost:3000`，选择 **Claude Agent SDK (Typescript)**，然后使用它的五个 feature pages。由于 DSH 尚未注册到 upstream，标签仍显示 Claude，但所有 request 实际进入该 DSH example。使用非默认地址时设置 `CLAUDE_AGENT_SDK_TYPESCRIPT_URL`。

## 使用已配置的 DSH model

默认 source-checkout 命令是确定性 keyless 模式。要复用已安装完整 DSH web Profile 中的 provider、settings 和 credentials，先构建 package，再应用 real-model patch：

```bash
pnpm build
dsh plugin --profile web add .
export DSH_AG_UI_PROVIDER='openai'
export DSH_AG_UI_MODEL='gpt-5.6-sol'
export DSH_AG_UI_SHARED_SECRET="$(openssl rand -hex 32)"
HOST=0.0.0.0 PORT=8020 \
  dsh --profile web --patch ./examples/dojo/cordis.real.patch.yml
```

真实模型接收相同的 frontend Tool schemas 与 shared-state instructions。它的措辞和 Tool 选择具有不确定性；keyless suite 仍是 protocol regression test。

## 安全说明

这是使用合成数据的 keyless example。Public feature routes 充当 BFF，在调用 `/_internal/ag-ui` 前注入 server-owned feature identity。未提供 secret 时，`start.mjs` 会在 Cordis 加载前生成不可预测的 per-process secret。直接请求 private route 仍然需要该 secret。

该紧凑 fixture 会全局注册 synthetic weather Tool，并在 executor 中强制检查 `backend_tool_rendering` feature identity。其他 real-model feature Agents 仍能看到该 schema，因此 trusted feature instructions 会要求它们不要调用。生产 integration 应当提供 per-Agent backend capability sets。不要在生产环境使用宽松 CORS policy、scripted model、debug endpoint 或 synthetic weather Tool。

## Upstream AG-UI Dojo

该 fixture 在不向本 package 引入 CopilotKit 或 Playwright 的情况下验证 DSH behavior。获得 AG-UI maintainer 认可后，可以在 upstream integration 中把这五个 feature paths 注册到 `apps/dojo`，并复用 upstream feature pages 与 E2E suite。
