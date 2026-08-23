# dsh-ag-ui

[English](README.md) | 简体中文

[![CI](https://github.com/CaiZongyuan/dsh-ag-ui/actions/workflows/ci.yml/badge.svg)](https://github.com/CaiZongyuan/dsh-ag-ui/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/dsh-ag-ui.svg)](https://www.npmjs.com/package/dsh-ag-ui)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

一个社区维护的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Host 插件，通过 [AG-UI protocol](https://github.com/ag-ui-protocol/ag-ui) 暴露 DSH Agent。它提供经过认证的 HTTP/SSE Gateway、AG-UI thread 到 DSH Agent 的绑定、流式文本和 Tool event、浏览器持有的 Tools，以及浏览器返回 Tool result 后继续同一个 DSH turn 的能力。

> 这是社区项目，不是 DeepSeek 或 AG-UI 官方 package。

## 功能

- 通过 `ctx.agUi` 暴露的标准 Cordis `Service` 插件
- 可使用 `dsh plugin add` 安装的 DSH Profile Bundle
- 精确锁定 AG-UI `0.0.58` protocol packages
- 使用可信 tenant/user headers 的 BFF-to-Gateway 认证
- `(tenantId, userId, threadId)` 到 DSH Agent 的进程内绑定
- AG-UI 文本流与 backend Tool result 投影
- 由 `RunAgentInput.tools` 提供的 Agent-scoped browser Tools
- 跨 HTTP runs 的 Frontend Tool Promise park 与 ToolMessage continuation
- 通过 `RunAgentInput.state`、`ag_ui_update_state` 和 `STATE_SNAPSHOT` 实现的双向 shared state
- 覆盖五项标准 AG-UI feature 的 keyless Dojo-compatible example
- Run 和 message 幂等
- Request、context、Tool schema、event buffer、thread 和 run ledger 上限
- 完整回收 route、Agent、Tool、timer 和 pending call 的 Cordis disposal

## 运行要求

- Node.js `^22.19.0` 或 `>=24.0.0`
- 包含标准 Host services 的 DSH Profile
- 已注册的 DSH model provider 与 model
- 一个经过认证的 Backend-for-Frontend，确保浏览器无法获得 Gateway secret

## 安装

将 bundle 安装到 DSH Profile：

```bash
dsh plugin --profile web add dsh-ag-ui
```

npm 发布前可直接从 GitHub checkout 安装：

```bash
dsh plugin --profile web add github:CaiZongyuan/dsh-ag-ui
```

在全部必需环境变量存在之前，bundle 保持 dormant。这样安装 package 不会在 deployment 尚未选择 model route 和 secret 时破坏 Profile。

```bash
export DSH_AG_UI_PROVIDER='openai'
export DSH_AG_UI_MODEL='gpt-5.6-sol'
export DSH_AG_UI_SHARED_SECRET="$(openssl rand -hex 32)"
export DSH_AG_UI_PATH='/ag-ui' # 可选

dsh --profile web
```

Bundle 插入一个 Host-plane `ag-ui` row 来加载 Gateway service。Package 仍导出 `dsh-ag-ui/invariant`；提供 process-global `invariants` service 的 composition 可以显式加载该可选 companion。默认 web Profile 不提供该 service，因此 installable bundle 不会自动挂载 companion。

## Profile 配置

环境变量是最短配置路径。Profile 也可以在自己的 `cordis.patch.yml` 中覆盖 bundle row：

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

后应用的 Profile patch 会替换 bundle row 的完整 `config`；请包含 deployment 所需的全部配置值。

## 配置

`provider`、`model` 和 `sharedSecret` 必填。`sharedSecret` 至少包含 16 个 UTF-8 bytes。

| 字段 | 默认值 | 用途 |
| --- | --- | --- |
| `path` | `/ag-ui` | 精确 Host HTTP route |
| `provider` | 必填 | 已注册 DSH model provider route |
| `model` | 必填 | Provider 持有的 model ID |
| `sharedSecret` | 必填 | 仅与可信 BFF 共享的 bearer secret |
| `tenantHeader` | `x-dsh-tenant-id` | 可信 tenant identity header |
| `userHeader` | `x-dsh-user-id` | 可信 user identity header |
| `allowNonLoopback` | `false` | 显式允许非 loopback Host bind |
| `maxRequestBytes` | `262144` | 最大 request body bytes |
| `maxIdentityBytes` | `256` | 每个 protocol 或 identity ID 的最大 bytes |
| `maxMessages` | `256` | 每次 request 的最大 message 数量 |
| `maxMessageBytes` | `524288` | Message JSON 最大总 bytes |
| `maxContexts` | `32` | 最大 context entry 数量 |
| `maxContextBytes` | `131072` | Context JSON 最大总 bytes |
| `maxTools` | `32` | 最大 browser Tool 数量 |
| `maxToolBytes` | `131072` | Browser Tool JSON 最大 bytes |
| `maxToolSchemaDepth` | `16` | Browser Tool schema 最大深度 |
| `maxForwardedPropsBytes` | `65536` | `forwardedProps` JSON 最大 bytes |
| `maxStateBytes` | `65536` | State JSON 最大 bytes |
| `maxThreads` | `100` | 最大进程内 live threads |
| `threadIdleMs` | `1800000` | Idle thread lifetime |
| `frontendToolTimeoutMs` | `300000` | Browser Tool result 最大等待时间 |
| `maxRunEvents` | `4096` | 每个 run 最大保留 events |
| `maxRunEventBytes` | `2097152` | 每个 run 最大保留 event bytes |
| `maxRunsPerThread` | `32` | 每个 thread 最大 run ledger entries |

`maxRunEvents` 必须至少容纳 mandatory opening 与 terminal events。`maxRunEventBytes` 会限制包含 `RUN_STARTED` 和 terminal event 在内的完整 retained Run record，并且必须足以容纳已配置的最大 identity length。非 loopback DSH WebServer 需要设置 `allowNonLoopback: true`。推荐把 Gateway 保持在 loopback，并放在同 Host 的 authenticated BFF 后面。

## 架构

```text
Browser
  -> authenticated application BFF
  -> POST /ag-ui，携带 bearer secret 与可信 identity headers
  -> dsh-ag-ui Host Service
  -> DSH Agent / Session / Tool runtime
  -> model provider 与 backend Tools
```

Gateway binding key 是精确的 `(tenantId, userId, threadId)` tuple。浏览器提供的 identity、permission、patient ID、resource ID、`context` 或 `forwardedProps` 永远不能授予 backend authority。

Backend Tool 可以从 Agent 推导经过认证的 thread identity：

```ts
const identity = ctx.agUi.identityFor(exec.agent)
if (identity === undefined) {
  throw new Error('This Tool requires an authenticated AG-UI thread.')
}

const { principal, threadId } = identity
```

应用应当把这个 tuple 映射到服务端持有的 resource authorization state。

## BFF proxy

浏览器不能直接调用 private Gateway。BFF 应当认证用户、验证应用资源权限、原样保留 browser request body，并注入可信 identity headers。

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

BFF 持有 login、session、CSRF、tenant policy、resource authorization、audit 和 rate limits。不要把 Gateway bearer secret 当作 end-user authentication。

## 浏览器客户端

在 frontend application 中安装锁定版本的官方 client：

```bash
pnpm add @ag-ui/client@0.0.58
```

在每个 run 中发送页面相关的 browser Tools 与当前 context：

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

模型调用 browser-owned Tool 时，当前 HTTP run 成功结束，但 DSH Tool Promise 仍然 pending。浏览器执行 Tool、追加一条使用相同 `toolCallId` 的标准 AG-UI ToolMessage，再开始另一个 run。Gateway resolve 原始 Promise，并继续同一个 DSH turn。

普通 browser Tool result 不要通过 AG-UI `resume[]` 发送；该字段保留给显式 interrupt/HITL flow。

## Shared state

在第一次 run 前设置非空初始值以激活 shared state：

```ts
agent.setState({
  recipe: {
    title: 'Draft',
    ingredients: [],
  },
})
```

Gateway 把已接受 state 注入 DSH Session，在精确 Agent scope 注册保留 Tool `ag_ui_update_state`，并发送 `STATE_SNAPSHOT`。每个 snapshot 到达时，官方 client 会替换 `agent.state`。

State Tool 接受：

```json
{
  "state_updates": {
    "recipe": {
      "title": "Pasta Primavera"
    }
  }
}
```

更新采用 top-level shallow merge：未提供的 top-level key 保留，提供的 nested value 会替换此前 nested value。Gateway 使用 `maxStateBytes` 检查 merge 后的完整 state。只有在 DSH 追加 durable `tool/result` 后，Gateway 才 commit model update 并发送 snapshot；相等更新会保留 Tool result，但不会发送重复的 changed-state snapshot。

Client 不使用 shared state 时发送的默认空 state 不会触发首次激活。激活后，空 object、array 或 `null` 都是合法的完整 baseline；省略 `state` 则保留当前 thread state。

Shared state 是 model/UI collaboration data。它永远不授予 backend authority，也不应替代应用的 durable database state。当前尚未实现 `STATE_DELTA`。

## Dojo-compatible example

Package 以 `dsh-ag-ui/dojo-host` 发布 framework-free BFF plugin。Keyless scripted model、launcher 和五项 feature suite 仍是仅供 source checkout 使用的 fixtures。命令、routes、upstream Dojo 兼容方式、real-model 配置与安全限制见 [examples/dojo/README.zh.md](examples/dojo/README.zh.md)。

## HTTP 与 run 语义

- Request 必须为 `POST application/json`，并且符合 AG-UI `RunAgentInput`。
- 普通 run 接受一条新的 text user message。
- Continuation 接受属于一个 pending DSH turn 的一条或多条新 frontend ToolMessages。
- 一个 DSH turn 可以跨多个 AG-UI HTTP runs。
- 每个 run 发出一个 `RUN_STARTED` 和恰好一个 `RUN_FINISHED` 或 `RUN_ERROR`。
- `runId` 是 exact-request idempotency key。已完成的相同 request 会重放 retained events，不再次驱动 DSH。
- 一个 thread 同时只能有一个 active HTTP run。
- Active shared-state run 会在 model events 前发送 synchronization snapshot。
- V1 每个 DSH step 允许一个 frontend Tool call。

## Client-provided Tools

Browser Tool name 必须匹配：

```text
[A-Za-z_][A-Za-z0-9_-]{0,63}
```

该保守子集遵循常见 model-provider function-name limits；AG-UI 本身并不要求这条精确正则。`ag_ui_update_state` 是 protocol shared state 的保留名。Browser Tool parameter 必须使用 DSH Tools 实际执行验证的 object-rooted JSON Schema 子集。Gateway 拒绝与 inherited/global Tool 冲突的 name，并仅在精确 Agent 的 Tool scope 注册已接受 definition。

Backend Tool result 会发出 `TOOL_CALL_RESULT`。Frontend Tool result 不在 AG-UI wire 上回显，因为浏览器已经追加 ToolMessage；DSH 仍会记录真实 durable `tool/result`。

## 生命周期

所有 effect 都属于 Cordis plugin fiber。Route removal、idle expiry、timeout 和 plugin disposal 会注销 browser Tools、拒绝 pending calls、取消 active work、dispose Agent handles，并等待完全停稳。

意外 HTTP disconnect 会取消 Gateway-owned DSH turn。`HttpAgent@0.0.58` 不支持 partial SSE reconnect。Frontend Tool handoff 是 intentional completed run，不会取消 parked turn。

## 兼容性

| 组件 | 支持版本 |
| --- | --- |
| AG-UI core/client/encoder | `0.0.58` |
| Node.js | `^22.19.0` 或 `>=24.0.0` |
| DeepSeek Harness | `peerDependencies` 中列出的 developer preview packages |

DSH 仍处于 developer preview，可能引入 breaking changes。在这些 API 稳定前，本 package 使用精确 DSH peer versions。

## Model Experience

### 注入的 AG-UI context

#### 模型看到什么

每个非空 `RunAgentInput.context` 都会成为一条 user-role snapshot，包含有序 `## <description>` sections。Source 是 `{ kind: "plugin", plugin: "ag-ui", form: "snapshot", sections }`。

#### Token 影响

有条件且保留。每个被接受的普通或 continuation run 都会把有界 context snapshot 追加到 DSH Session 和后续 model history。

#### KV cache 影响

Append-only context 保留较早的可复用 history。变化后的当前 context 添加新 suffix；provider cache 是否可用不属于本 package 的职责。

### Shared application state

#### 模型看到什么

激活后，完整有界 state 会出现在 `Current Shared State` section 中，保留 Tool `ag_ui_update_state` 会进入 Agent schema。成功的 state update 会把完整 merge 后 state 作为 durable DSH Tool result 返回。

#### Token 影响

有条件且保留。每个 shared state active 的 accepted run 都会追加完整 state baseline。Model update 还会追加一组包含完整 merge 后 state 的 Tool call/result。

#### KV cache 影响

此前不变的 history 仍可复用，但每个当前 state baseline 和 changed Tool result 都会增加 suffix。体积大或频繁变化的 state 会降低 cache reuse，并增加 Session 保留 tokens。

### Client-provided capabilities

#### 模型看到什么

当前 Agent-scoped browser Tool definitions 会进入普通 DSH Tool schema 列表。Name、description 和经过验证的 parameter schemas 来自 authenticated client request；execution 仍由浏览器持有。

#### Token 影响

有条件且替换。每个 model request 都会发送 visible Tool schema list；页面声明不同 capability set 时，该列表发生变化。

#### KV cache 影响

Tool set 不变时保留 Tool-schema prefix。添加、删除或修改 Tool 可能使 provider 从该部分开始无法复用 cache。

## 已知限制

- Thread、run 和 shared state 都是 process-local。
- Host restart 不会调用 `agents.resume()`、恢复 parked browser Tool，或在没有新 client baseline 时恢复 shared state。
- 只适配 text user input、assistant text 和 string Tool results。
- 每个 DSH step 只允许一个 frontend Tool call。
- 不支持 partial SSE reconnect。
- 尚未适配 `STATE_DELTA`、AG-UI interrupt/HITL `resume[]`、multimodal messages、reasoning events 和 activity events。
- Shared-state update 使用 top-level shallow merge，不提供 version、deep merge 或 conflict resolution。

## 开发

```bash
git clone https://github.com/CaiZongyuan/dsh-ag-ui.git
cd dsh-ag-ui
corepack enable
pnpm install
pnpm check
```

`pnpm check` 会运行 lint、strict TypeScript、per-file coverage、runtime/type builds 和 publint。Dojo fixture 仅用于 source checkout，不包含在 npm tarball 中。

贡献和发布要求见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可证

[MIT](LICENSE)。部分代码改编自 DeepSeek Harness，详情见 [NOTICE](NOTICE)。
