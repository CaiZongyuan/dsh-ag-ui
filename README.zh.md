# dsh-ag-ui

[English](README.md) | 简体中文

[![CI](https://github.com/CaiZongyuan/dsh-ag-ui/actions/workflows/ci.yml/badge.svg)](https://github.com/CaiZongyuan/dsh-ag-ui/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/dsh-ag-ui.svg)](https://www.npmjs.com/package/dsh-ag-ui)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

一个社区维护的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Host 插件，通过 [AG-UI protocol](https://github.com/ag-ui-protocol/ag-ui) 暴露 DSH Agent。它提供经过认证的 HTTP/SSE Gateway、AG-UI thread 到 DSH Agent 的绑定、流式文本和 Tool event、浏览器持有的 Tools，以及浏览器返回 Tool result 后继续同一个 DSH turn 的能力。同一套投影核心另有一种嵌入形态：独立的 `dsh-ag-ui-adapter` 包在 AG-UI `AbstractAgent` 背后 spawn 一个私有的环回微型 Host。

> 这是社区项目，不是 DeepSeek 或 AG-UI 官方 package。

## 功能

- 通过 `ctx.agUi` 暴露的标准 Cordis `Service` 插件
- 通过 `ctx.browserTools` 暴露的传输无关 Agent-scoped browser Tool broker
- 可使用 `dsh plugin add` 安装的 DSH Profile Bundle
- 下限式 AG-UI 协议范围（`~0.0.59`）
- 使用可信 tenant/user headers 的 BFF-to-Gateway 认证
- `(tenantId, userId, threadId)` 到 DSH Agent 的进程内绑定
- AG-UI 文本流与 backend Tool result 投影
- 由 `RunAgentInput.tools` 提供的 Agent-scoped browser Tools
- 跨 HTTP runs 的 Frontend Tool Promise park 与 ToolMessage continuation
- 通过 `RunAgentInput.state`、`ag_ui_update_state` 和 `STATE_SNAPSHOT` 实现的双向 shared state
- 后端 Tool 调用以带版本的 `dsh:tool:view` CUSTOM 事件携带 presenter card，live 与冷回放一致
- 独立的 `dsh-ag-ui-cards` React 包渲染全部 card 种类，组件测试基于录制自真实 Gateway 的事件
- 独立的 `dsh-ag-ui-adapter` 嵌入适配包，spawn 环回 DSH 微型 Host 并以 AG-UI `AbstractAgent` 形式提供服务
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

Bundle 始终挂载轻量的 `browser-tools` row。只有 AG-UI Gateway row 会在全部必需环境变量存在前保持 dormant，因此原生 DSH 集成可以租用 browser-owned Tools，而不必再配置一套 model route 或 Gateway secret。

```bash
export DSH_AG_UI_PROVIDER='openai'
export DSH_AG_UI_MODEL='gpt-5.6-sol'
export DSH_AG_UI_SHARED_SECRET="$(openssl rand -hex 32)"
export DSH_AG_UI_PATH='/ag-ui' # 可选

dsh --profile web
```

Bundle 插入一个始终启用的 `browser-tools` row 和一个按条件启用的 Host-plane `ag-ui` row。前者从不创建 Agent：调用方负责选择已有 Agent 并提供浏览器传输。Package 仍导出 `dsh-ag-ui/invariant`；提供 process-global `invariants` service 的 composition 可以显式加载该可选 companion。默认 web Profile 不提供该 service，因此 installable bundle 不会自动挂载 companion。

## Browser Tool broker

`dsh-ag-ui/browser-tools` 用一个接口隐藏 provider-safe 名称检查、object-rooted schema 校验、精确 Agent scope 注册、目录替换、冲突、取消、超时和租约回收。调用方拥有 Agent 选择与传输：

```ts
const lease = ctx.browserTools.bind(agent, owner, tools, {
  invoke: (call, signal) => browserTransport.invoke(call, signal),
})

lease.update(nextTools)
lease.dispose()
```

浏览器上下文和 Tool result 是能力数据，不是授权。持久化动作仍必须经过服务端身份、资源校验和领域确认流程。

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
| `agentPreset` | 无 | 组合进每个线程的部署级默认 agent preset id |
| `tenantPresets` | `{}` | 按租户覆盖 `agentPreset` 的 preset id 映射 |
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
| `maxRunsPerThread` | `32` | 每个 thread 保留的 run ledger entries 上限，同时也分别限制等待请求的数量 |

`agentPreset` 让每个线程的 agent 从宿主的 agent-presets roster 组合而来（需在本 Gateway 之前挂载 roster 插件）；无法解析的 id 会让 Gateway 激活响亮失败，按租户条目覆盖该租户线程的部署默认值，而恢复的线程保持其持久 session 自己记录的组合。不配置 `agentPreset` 时，线程保持宿主组合不变。

`maxRunEvents` 必须至少容纳 mandatory opening 与 terminal events。`maxRunEventBytes` 会限制包含 `RUN_STARTED` 和 terminal event 在内的完整 retained Run record，并且必须足以容纳已配置的最大 identity length。非 loopback DSH WebServer 需要设置 `allowNonLoopback: true`。推荐把 Gateway 保持在 loopback，并放在同 Host 的 authenticated BFF 后面。

开始和结束时的持久化历史快照都会计入该上限。事件缓冲区溢出会结束 HTTP run，并且只取消该 run 当前已领取的原生 turn。只读历史请求溢出不会取消其他活跃 turn。已完成的重复请求仍精确重放所保留的 events。

## 架构

一套投影核心，两种支持的形态。核心是 `dsh-ag-ui` Host service：它把 AG-UI thread 绑定到 DSH Agent，并在两个方向上翻译 run、event、Tool、shared state 与 presenter card。其余一切只是包装。

```text
部署形态 — BFF Gateway                     嵌入形态 — dsh-ag-ui-adapter

Browser                                    Node.js 应用
  -> 经过认证的应用 BFF                      -> DshAgent（AG-UI AbstractAgent）
       bearer secret 与可信                       spawn 一个私有微型 Host 子进程：
       identity headers                           - 环回 webserver，临时端口
  -> POST /ag-ui 到 Host                         - 同一个已发布的 dsh-ag-ui
  -> dsh-ag-ui Host Service                        gateway row，按进程 secret
  -> DSH Agent / Session / Tool runtime          - 应用自己的 Agent 核心与
  -> model provider 与 backend Tools                model plugin rows
                                            -> run() 经环回 HTTP 访问同一个
                                               gateway service
```

部署形态用经过认证的 BFF 为浏览器客户端挡在共享 Host 之前。嵌入形态（[`dsh-ag-ui-adapter`](packages/dsh-ag-ui-adapter)）为每个应用进程组合一个一次性的 Host——首次 run 之前不 spawn 任何东西，子进程也绝不会比宿主进程活得更久。两种形态以同一协议访问同一投影核心，因此 run 语义、browser Tools、shared state、presenter card、幂等与 disposal 行为完全一致。

两种形态下，gateway binding key 都是由可信 identity headers 提供的精确 `(tenantId, userId, threadId)` tuple。

## 信任姿态

- Gateway 监听在 Host webserver 上。让该 webserver 保持 loopback 并放在同 Host 的经过认证的 BFF 之后；非 loopback bind 需要显式设置 `allowNonLoopback`，而这几乎总是错误的。
- Bearer secret 认证的是**一跳 service-to-service 通信**——BFF（嵌入形态下则是 adapter 进程）到 gateway。它不是 end-user authentication：gateway 永远看不到用户凭据，其本身也不授予任何用户级权限。
- End-user identity 经由可信的 `tenantHeader`/`userHeader` headers 传递。持有 secret 的人可以断言任意 identity，因此 secret 持有者本身必须可信——部署形态下，注入这些 headers 之前先认证用户正是 BFF 的全部职责；嵌入形态下，adapter 进程本身就是可信主体。
- 浏览器提供的 identity、permission、patient ID、resource ID、`context`、`state`、`forwardedProps`、Tool schema 以及 message 内的 ID 都是不可信的 wire input，永远不能授予 backend authority。
- Backend Tool 可以从 Agent 推导经过认证的 thread identity：

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

### 代理 Host 服务插件 remote

AG-UI gateway 只是众多带 HTTP remote 的 Host-plane service 之一；其他 DSH 服务插件也可以在同一个环回 webserver 上挂载路由。同一条规则覆盖所有这些 remote：浏览器永远不直接访问 Host。每个 remote 都经应用 backend 暴露在应用自己的路由之下，采用上文"认证 → 授权 → 转发"的形态并附带该服务期望的凭据。Host 端口本身保持 loopback，也不向客户端公开。

## 浏览器客户端

在 frontend application 中安装官方 client。支持协议范围（`>=0.0.59 <0.1.0`）内的任意版本均可；网关不要求 client 精确锁版：

```bash
pnpm add @ag-ui/client
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

Upstream Dojo 的 integration registry 是静态源码，目前没有 `deepseek-harness` 条目，因此本地 upstream 测试暂时复用 Claude Agent SDK TypeScript 菜单项作为纯 URL/path 别名。该别名在注册 DeepSeek Harness 条目的 upstream integration PR 被接受后即会消失；过程中不涉及任何 Claude 运行时、模型或凭据。

下面的录像展示 upstream Dojo demo viewer 上的 shared-state feature 对接本仓库 keyless fixture 的效果。两轮对话都经过网关：第一轮读取共享状态，第二轮发出改写菜谱表单的 `STATE_SNAPSHOT` 事件。播放速度为 3 倍速并附英文字幕。

<video controls muted playsinline width="800">
  <source src="docs/demo/dojo-shared-state.mp4" type="video/mp4" />
  <track src="docs/demo/dojo-shared-state.vtt" kind="captions" srclang="en" label="English" default />
</video>

若当前宿主不渲染内嵌播放器，可下载 [docs/demo/dojo-shared-state.mp4](docs/demo/dojo-shared-state.mp4)（字幕：[docs/demo/dojo-shared-state.vtt](docs/demo/dojo-shared-state.vtt)）。

## 嵌入适配器

独立的 [`dsh-ag-ui-adapter`](packages/dsh-ag-ui-adapter) 包是本部署形态网关的嵌入形态对应物。`DshAgent`（`AbstractAgent` 子类）spawn 一个 DSH 微型 Host 子进程——由 Cordis overlay 组合环回 webserver（临时端口）、本网关（按进程生成的 secret）以及调用方显式提供的 Agent 核心与 model rows——并通过环回 HTTP 以官方 client 原语实现 `run()`，不新增任何协议翻译代码。Host 在首次 run 时才惰性启动，可按空闲窗口自动关闭，且绝不会比宿主进程活得更久。用法、plugin row 解析、环境变量回退、生命周期与嵌入形态的信任姿态见其 README。

## HTTP 与 run 语义

- Request 必须为 `POST application/json`，并且符合 AG-UI `RunAgentInput`。
- 普通 run 接受一条或多条新的文本 user message，它们按到达顺序进入同一个 DSH turn。没有新消息的 run（包括重发完整已接纳 transcript）只返回历史 snapshot，不会在活跃 run 后面等待。
- Continuation 接受属于一个 pending DSH turn 的一条或多条新 frontend ToolMessages。
- 已认证 pending frontend Tool result 上的标准对象 metadata 会通过原生 DSH presentation metadata 持久化，并由后续 message snapshot 返回；没有 metadata 的结果在 wire 上保持不变。
- 一个 DSH turn 可以跨多个 AG-UI HTTP runs。
- 每个 run 发出一个 `RUN_STARTED` 和恰好一个 `RUN_FINISHED` 或 `RUN_ERROR`。
- frontend call 等待期间，native turn 可以在 HTTP response 结束后继续存在。持久化结果、共享状态更新和 turn 结束事件仍会更新 thread projection。无效的 continuation 不会消费 pending call，客户端可修正后重试。
- user batch 失败时会取消 native inbox 中的待处理输入。已丢弃且尚未 claimed 的消息可以沿用原 message ID 重试；已 claimed 的消息保持 accepted，包括重启之后。失败的 run ID 仍重放原错误，因此重试输入须使用新的 run ID。
- `runId` 是 exact-request idempotency key。已完成的相同 request（包括只读历史 run）会重放 retained events，不再次驱动 DSH。所有 run 共用有界 ledger；活跃记录不会被淘汰，ledger 已满时以 `429 RUN_LEDGER_FULL` 拒绝 admission。
- 每个 thread 最多允许 `maxRunsPerThread` 个请求排队等待，超出时返回 `429 RUN_QUEUE_FULL`。等待客户端断开连接会释放队列位置。排队请求在被接纳或断开连接前阻止 thread 空闲过期，包括等待已取消的原生 turn 收敛期间。一起排队的相同请求会重放同一份保留结果，不会重复驱动 DSH。
- 一个 thread 同时只驱动一个 HTTP run。在另一个 run 活跃时到达的 run 会等待它以及 Agent turn 结束，因此同一 thread 的 runs 按到达顺序执行；等待中断开连接的客户端不会被接纳。
- Active shared-state run 会在 model events 前发送 synchronization snapshot。
- 一个 DSH step 可挂起多个 frontend Tool call；续跑可只回答其中一部分。

## Client-provided Tools

Browser Tool name 必须匹配：

```text
[A-Za-z_][A-Za-z0-9_-]{0,63}
```

该保守子集遵循常见 model-provider function-name limits；AG-UI 本身并不要求这条精确正则。`ag_ui_update_state` 是 protocol shared state 的保留名。Browser Tool parameter 必须使用 DSH Tools 实际执行验证的 object-rooted JSON Schema 子集。Gateway 拒绝与 inherited/global Tool 冲突的 name，并仅在精确 Agent 的 Tool scope 注册已接受 definition。

Backend Tool result 会发出 `TOOL_CALL_RESULT`。Frontend Tool result 不在 AG-UI wire 上回显，因为浏览器已经追加 ToolMessage；DSH 仍会记录真实 durable `tool/result`。

## Tool view cards

每个后端 Tool 调用都会在标准 tool 事件旁携带其 DSH render-intent card，即名为 `dsh:tool:view` 的 CUSTOM 事件：

```json
{
  "version": 1,
  "callId": "call-42",
  "toolName": "read_file",
  "phase": "call",
  "card": { "card": "generic", "title": "Reading src/index.ts", "kind": "read" }
}
```

- Gateway 在实际执行调用的 Agent scope 内解析 Tool definition，再求值其 `presentCall`（pending 状态，`TOOL_CALL_END` 之后发出）与 `presentResult`（completed 状态，`TOOL_CALL_RESULT` 之后发出）intent。二者都是入参与 durable result 的纯函数，包含该 Tool 的 `output.presentationMeta` 投影进 session log 的 presentation metadata。
- 未声明 intent、intent 返回 undefined 或 intent 抛错的 Tool 会软回退到 generic card：pending 状态为 `{ "card": "generic", "title": "<toolName>", "rawInput": <args> }`，completed 状态为 `{ "card": "generic" }`（保留 pending 标题，直接渲染原始 result）。
- card 词汇表是 DSH provider-neutral 的 `ToolCallView`/`ToolResultView` union（`generic`、`terminal`、`diff`、`search`、`read`、`web` card），UI 无需按 Tool 名特判即可渲染。
- 保留 Tool `ag_ui_update_state` 与客户端提供的 frontend Tool 被排除：state Tool 经 `STATE_SNAPSHOT` 投影，客户端本来就了解如何呈现自己的 Tool。
- 每个 run 开始时，Gateway 会从 durable session log 重新推导整个转录的已结算 card——与 live 路径使用相同的求值器与输入——并在 `MESSAGES_SNAPSHOT` 之后立即发出，因此错过 live 流的客户端也能渲染出完全一致的 card。冷读取只会为仍在该 thread scope 内可解析的 Tool 重新推导 card，因此重启后由崩溃恢复物化的 frontend Tool 调用不会带 card。card 计入 run 的事件预算。

保留的 `ag_ui_update_state` 调用与结果仅用于协议状态管理，不会出现在实时事件或恢复的消息历史中。

独立的 [`dsh-ag-ui-cards`](packages/dsh-ag-ui-cards) React 包基于这些 envelope 渲染全部 card 种类，不依赖任何 DSH runtime，并给出了事件接线配方。其组件测试渲染录制自本 Gateway 的事件，录制场景由本仓库的测试套件持续守护。

## 生命周期

所有 effect 都属于 Cordis plugin fiber。Route removal、idle expiry、timeout 和 plugin disposal 会注销 browser Tools、拒绝 pending calls、取消 active work、dispose Agent handles，并等待完全停稳。

意外 HTTP disconnect 会取消 Gateway-owned DSH turn。`HttpAgent` 不支持 partial SSE reconnect。Frontend Tool handoff 是 intentional completed run，不会取消 parked turn。

## 兼容性

| 组件 | 支持版本 |
| --- | --- |
| AG-UI core/client/encoder | `>=0.0.59 <0.1.0`（`~0.0.59`；已用 `0.0.59` 验证） |
| Node.js | `^22.19.0` 或 `>=24.0.0` |
| DeepSeek Harness | `0.1.5-alpha.1`（精确的 developer-preview peers） |

DSH `0.1.5-alpha.1` 使用 v3 会话日志。实时文本通过 `agent/assistant-stream` 接收，已结算历史通过 `snapshotEvents()` 读取。配置 JSONL 持久化插件后，DSH 在恢复时迁移旧日志（已用 `0.1.1-rc.2` 录制验证）。图片和文件 Tool 结果分别投影为 `[image result]` 和 `[file result]` 占位符，不传输附件字节。

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

- 活跃 thread 绑定、run 重放缓冲和 shared state 保存在进程内；会话历史可通过 Host 持久化插件保留。
- Host 重启后通过 `agents.resume()` 恢复已保存的会话。不会恢复挂起的 browser Tool：被中断的回合返回 `THREAD_INTERRUPTED`，shared state 需要新的 client baseline。
- 只适配 text user input、assistant text 和 string Tool results。
- 不支持 partial SSE reconnect。
- 尚未适配 `STATE_DELTA`、AG-UI interrupt/HITL `resume[]`、multimodal messages、reasoning events 和 activity events。
- Shared-state update 使用 top-level shallow merge，不提供 version、deep merge 或 conflict resolution。

## 开发

```bash
git clone https://github.com/CaiZongyuan/dsh-ag-ui.git
cd dsh-ag-ui
corepack enable
pnpm install
pnpm -r --workspace-root check
```

本仓库是 pnpm workspace：根 package 即 Gateway，`packages/` 下是 `dsh-ag-ui-cards` React card 渲染包与 `dsh-ag-ui-adapter` 嵌入适配包。`pnpm -r --workspace-root check` 会在每个 workspace project 内运行 lint、strict TypeScript、per-file coverage、runtime/type builds 和 publint。Dojo fixture 仅用于 source checkout，不包含在 npm tarball 中。

贡献和发布要求见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可证

[MIT](LICENSE)。部分代码改编自 DeepSeek Harness，详情见 [NOTICE](NOTICE)。
