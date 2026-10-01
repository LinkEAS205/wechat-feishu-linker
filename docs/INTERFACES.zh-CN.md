
**English:** [INTERFACES.md](INTERFACES.md)
\n**English:** [INTERFACES.en.md](INTERFACES.md)

把微信 ClawBot（腾讯 iLink 官方协议）桥接到 DeepSeek Harness（DSH）agent 会话。
本文件是**唯一接口契约**，改动请先更新这里。

## 0. 运行环境事实（已实测，不要重新猜）

- DSH desktop profile: `<dsh-home>\profiles\desktop\`
  - `package.json` → `dependencies`（`link:` 本地插件）+ `dsh.profile.bundles`（加载顺序）
  - `cordis.patch.yml` → 补丁层：`- insert: [{id, name, config}]` / `{id, disabled}` / `{id, config}`
  - 安装：在 profile 目录 `pnpm install`；**宿主插件热生效，客户端插件需重启**
- 当前运行时包版本（**peer 闸门**必须覆盖）：`@deepseek-ai/dsh-*@0.2.0-rc.2`、`@deepseek-ai/cordis@4.0.4`、`@deepseek-ai/schemastery@3.18.4`
- Node: v24.18.1（要求 `>=22`）。插件必须是 **纯 ESM**，无构建步骤。
- 网络：本机无直连外网，代理 `http://127.0.0.1:7890`（`$env:HTTP_PROXY`/`$env:HTTPS_PROXY`）。
  iLink 接口在**规则模式代理下实测可达**（返回 `ret:0`）。

## 1. iLink ClawBot 协议（来源：ZCode `packages/services/src/bots/providers/weixinProvider.ts` + `weixinRegistration.ts`，并已实测）

- Base URL：`https://ilinkai.weixin.qq.com`，前缀 `/ilink/bot`
- 媒体 CDN：`https://novac2c.cdn.weixin.qq.com/c2c`（8/8 独立实现一致，**不是** ilinkai 域名）
- **未登录**（无需 token，头 `iLink-App-ClientVersion: 1`，GET）：
  - `GET /ilink/bot/get_bot_qrcode?bot_type=3`
    → `{ qrcode, qrcode_img_content, ret: 0 }`（`qrcode_img_content` 是二维码图片 URL；也可能是 `qrcode_url`）
  - `GET /ilink/bot/get_qrcode_status?qrcode=<qrcode>`
    → `status`：数字 `0=pending 1=scanned 2=success 3|4=expired`，或字符串 `confirmed/scaned/expired/...`；
      成功时带 `bot_token`（或 `token`）与 `ilink_bot_id`（或 `bot_id`）
  - 该状态接口可能长时间挂起等待手机确认 → 超时必须当成 `pending`，不是错误
- **已登录**（POST，JSON）请求头：
  ```
  content-type: application/json
  AuthorizationType: ilink_bot_token
  Authorization: Bearer <bot_token>
  X-WECHAT-UIN: <base64(random uint32 十进制字符串)>
  iLink-App-Id: bot
  ```
  body 统一加前缀：`{ base_info: { channel_version: "2.0.0" }, ...body }`
  （`channel_version` 的**取值不被服务端校验**——1.0.0/2.4.6 等都能用；`base_info` 本身必须存在，见下）
- 业务码：`ret !== 0 || errcode !== 0` 即失败（读 `errmsg`/`message`）
  - `ret === -2`（sendmessage）＝ context_token 过期 → **去掉 context_token 重发一次**
  - `errcode === -14` ＝ 登录态失效 → 需要重新扫码
- 端点：
  - `POST /ilink/bot/getconfig`（可带 `{ilink_user_id, context_token}`）→ 含 `typing_ticket`
  - `POST /ilink/bot/getupdates` body `{ get_updates_buf: <cursor 或 ""> }`
    → **长轮询：服务端最多挂 35s**；客户端超时取 38–45s（本插件默认 45000），并读响应里的 `longpolling_timeout_ms` 动态调整
    → 消息数组字段名是 **`msgs`**（兼容 `data`/`messages`/`msg_list`）；
      新 cursor：`get_updates_buf | buf | next_buf | nextBuf | getUpdatesBuf | syncKey`，**必须持久化**
  - `POST /ilink/bot/sendmessage`
    ```json
    { "msg": {
        "from_user_id": "<bot 自己的 ilink user id，可为空串>",
        "to_user_id": "<对方 ilink user id>",
        "client_id": "dsh-wechat-<uuid>",
        "message_type": 2,
        "message_state": 2,
        "context_token": "<可选，来自入站消息>",
        "item_list": [ { "type": 1, "text_item": { "text": "<CRLF 归一化后的文本>" } } ]
    } }
    ```
  - `POST /ilink/bot/sendtyping` body `{ ilink_user_id, typing_ticket, status: 1 }`
  - ⚠️ **静默失败**：`sendmessage` 缺 `base_info` / `from_user_id` / `client_id` 时可能返回 HTTP 200 + `{}` 但**不投递**。
    因此 `from_user_id` 即使为空也要显式写 `""`，`client_id` 必须每次生成（`dsh-wechat-<uuid>`），`base_info` 必须存在。
  - 发送后无法从响应确认送达；如需确认只能靠对方回复。
- **入站消息**（`getupdates` 的元素）：
  - `message_type === 2` 表示 bot 自己发出的消息 → 必须跳过（防回声）
  - 文本：`item_list[].text_item.text`（也兼容 `text` / `content`）
  - 发送者 id：`from_user_id`（兼容 `fromUserId`/`from`）
  - `context_token`：顶层或 `msg`/`message` 内层
  - 附件：`image_item` / `file_item` / `video_item` / `audio_item` / `media_item`；
    CDN 下载地址在 `url|download_url|full_url`，`aes_key` 为 AES-128-ECB + PKCS7 密钥
- **纯文本换行**：发送前把 `\r\n|\r|\n` 统一成 `\r\n`（微信各端对 LF 处理不一致）

## 2. DSH 插件集成面

### 2.0 【冻结·优先于下文】零 `@deepseek-ai/*` import 架构

**结论：本插件在运行时不得 import 任何 `@deepseek-ai/*` 包。** 下方 2.1 的旧写法仅作背景参考，已废弃。

原因（两个独立研究交叉证实）：
- DSH 按 **realpath** 加载插件（`link:` 指向 `<dsh-home>\plugins\<name>`），插件目录向上没有 `@deepseek-ai`，第三方插件位置**解析不到**这些包。
- 本机 host 运行时版本存在歧义：app.asar 内 `dsh-*@0.2.0-rc.2`、`profiles/node_modules` 里是过期 `0.1.5-rc.1`、`dsh-browser-scope` 自带 `0.1.5-rc.2`。任何 import 都可能踩 peer 闸门或拿到与宿主不同的实例。
- 最成熟的先例 `dsh-wechat@0.9.6`（MIT）刻意零 import，全部走 `ctx.get('<service>')` + 内联消息构造。

落地规则：
1. `src/service.js` / `src/bridge/index.js` 导出**函数式 Cordis 插件**：`export const name`、`export function apply(ctx, config)`、`export default apply`。不继承 Service、不导出 Schemastery `Config`；默认值由 `withDefaults(config)` 在代码里补。
2. 内联消息构造（照抄先例 `dsh-wechat/dist/dsh/messages.js`）：
   ```js
   import crypto from 'node:crypto'
   export function createUserMessage(input) {
     return deepFreeze({ ...input, id: crypto.randomUUID(), role: 'user' })
   }
   ```
   会话 id 用 GUI 同款格式 `session-${crypto.randomUUID()}`。
3. 服务发现用模块级注册表 `src/registry.js`（`setService` / `getService`），**不依赖 `ctx.wechatIlink`**。
4. 宿主能力一律 `ctx.get(...)` 且判空降级。任一缺失只能降级，**绝不能让插件加载失败**。
   **完整清单以 `src/bridge/compat.js` 的 `HOST_SURFACES` 为准**——那是唯一权威列表，
   自检报告、日志和设置页都从它生成，不要再在本文件里维护第二份（会漂移，实测漂移过一次：
   本清单原来只有 7 项，而插件实际依赖已经翻倍）。

   当前依赖的宿主面（2026-10-01）：

   | 面 | 缺了会怎样 |
   | --- | --- |
   | `agents` | 创建/恢复会话——整个桥接不可用 |
   | `sessionPersistence` | 重启后接着原会话（会改为新建） |
   | `agentDefaultModel` | 未显式指定模型时的部署默认 |
   | `tools` | `wechat_send` 工具 |
   | `systemPrompt` | 通道提示词注入 |
   | `sessionQuery` | `/peek` |
   | `sessionProjectionCache` | 会话标题等提示 |
   | `workspaceRegistry` | `/workspaces`、`/cwd` |
   | `configEditor` | 设置写回配置文件（否则只生效到重启） |
   | `llm` | `/model`、`/effort` |
   | `permissionPresets` | `/permission` |
   | `on`（`ctx` 上的能力，不是服务） | 事件监听——整个桥接不可用 |
   | `waterfall`（同上） | 审批卡 / 选择卡镜像 |

   **方法级宿主面**（不是服务，探测不到，用到时降级并在回复里说明）：
   `agent.steer`（缺则退回 `send(msg,'next-step',true)`）、
   `session.append`（模型/权限切换）、`session.eventAt` / `session.requestHeader`（读当前选择）。

5. **宿主兼容性自检**（`src/bridge/compat.js`）：插件加载时探测上表所有面，结果记日志，
   并经 `/wechat-ilink/api/status` 的 `hostCompat` 显示在设置页。理由很实际——
   **DSH 升级若改名或去掉某个面，任何地方都不会报错，只是那个功能不再工作**，
   症状（"为什么 /model 不回应"）离病因很远。有这份报告，升级后打开设置页就能看见。
   探测本身也必须容错：`ctx.get` 对未提供的服务会抛异常，而那正是它要报告的情况。
5. 注入与回信仍按 2.1 的三参 `agent.send(...)` / `ctx.on('session/event')` 模式（这些是 `ctx` 上的调用，不需要 import）。

### 2.1 背景参考（已废弃的旧写法，勿照抄 import）

```js
import { Service } from '@deepseek-ai/cordis'          // 宿主插件基类（先例用法）
import Schema from '@deepseek-ai/schemastery'          // 配置 schema
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'wechat-ilink'
export const inject = ['agents']                       // 需要的服务
export function apply(ctx, config) { ... }             // 或 export default class extends Service

// 取/建会话
ctx.agents.get(sessionId)                              // 已存在则直接拿
await ctx.agents.resume({ resumeSessionId, agentOptions, setup })  // → { agent }
await ctx.agents.create({ sessionId, meta: { cwd }, agentOptions, setup })  // → { agent }
// 注入用户消息（第 2 参 'next-turn'，第 3 参 true = 立即唤醒）
agent.send(createUserMessage({ content, source: { kind, accountId, peerId } }), 'next-turn', true)
// 接回复：监听会话事件
ctx.on('session/event', (session, event) => {
  if (event.type === 'assistant/message') { /* event.data.message.content[] 取 type==='text' */ }
  if (event.type === 'turn/end') { /* 该 turn 结束，把缓冲文本发回微信 */ }
})
// 其它
ctx.get('agentDefaultModel')?.currentSelection()       // → { provider, model, reasoningEffort }
ctx.get('sessionPersistence')                          // 存在才可 resume
ctx.get('attachments')?.saveImages([{data, mediaType, name}])
ctx.tools.register(defineTool({ ... }))                // 需要 inject 'tools'
agentCtx.get('systemPrompt')?.section({ name, order, text })   // 需要 inject 'systemPrompt'
ctx.logger?.info?.() / warn / error
```
- `SessionId(id)` 是**可调用工厂**：`SessionId('wechat-ilink:xxx')`
- 每个 turn 的 assistant 文本要按 `sessionId#turn` 缓冲，`turn/end` 时再整体发出（避免碎片消息）
- 先例文件（只读参考，勿修改）：
  - `the `dsh-weixin` reference implementation: bridge\index.js`
  - `the `dsh-weixin` reference implementation: service.js`
  - `the `dsh-weixin` reference implementation: tool.js`
  - 解包后的 DSH 运行时（只读）：`the unpacked DSH runtime (`app.asar`) `node_modules/@deepseek-ai/``

## 3. 模块契约（写死，实现方必须逐字遵守）

### 3.1 `src/ilink/client.js`
```js
export const DEFAULT_ILINK_BASE_URL = 'https://ilinkai.weixin.qq.com'
export const ILINK_BOT_API_PREFIX = '/ilink/bot'
export const CHANNEL_VERSION = '2.0.0'
export function buildHeaders(token, { randomUin } = {}) // → Record<string,string>
export function createIlinkClient(opts) // opts: { token, baseUrl?, fetchImpl?, requestTimeoutMs?, logger? }
// → {
//   token,
//   request(path, body?, { timeoutMs?, signal? } = {}) → Promise<unknown>,
//   getConfig({ ilinkUserId?, contextToken?, signal? } = {}) → Promise<object>,
//   getUpdates({ buf = '', signal } = {}) → Promise<{ rawMessages: object[], buf: string, payload: unknown }>,
//   sendMessage({ toUserId, text, contextToken?, signal? }) → Promise<unknown>,
//   sendTyping({ toUserId, contextToken?, signal? }) → Promise<boolean>,
// }
```
约定：非 2xx → 抛 `IlinkHttpError`；`ret/errcode != 0` → 抛 `IlinkApiError`（含 `ret`、`errcode`、`errmsg`、`path`）。
`sendTyping` 拿不到 `typing_ticket` 时返回 `false`（不抛）。

### 3.2 `src/ilink/login.js`
```js
export function beginLogin({ baseUrl?, fetchImpl?, timeoutMs? } = {})
// → Promise<{ qrcode: string, qrUrl: string, expiresIn: number, expiresAt: number }>
export function pollLogin({ qrcode, baseUrl?, fetchImpl?, timeoutMs? })
// → Promise<{ status: 'pending'|'scanned'|'success'|'expired'|'error', botToken?, botId?, message? }>
export function normalizeQrStatus(status) // 数字/字符串 → 上面的 status
```

### 3.3 `src/ilink/normalize.js`
```js
export function readRawMessages(payload) → object[]        // 兼容 data / messages / msg_list
export function extractNextBuf(payload) → string | undefined
export function normalizeInboundMessage(raw) → null | {
  fromUserId: string, text: string, contextToken?: string,
  messageId?: string, chatId?: string,
  itemTypes: string[], attachments: Array<{ id?, kind, filename?, mimeType?, downloadUrl?, aesKey?, sizeBytes? }>,
}
export function buildSendBody({ fromUserId?, toUserId, text, contextToken?, clientId? }) → object  // 见 §1 sendmessage
export function normalizeOutboundText(text) → string        // 换行 → CRLF
export function chunkText(text, maxLength) → string[]       // 按段落/长度切分，不破坏代理对
```

### 3.4 `src/ilink/media.js`
```js
export function parseAesKey(value) → Buffer | null
export function decryptCdnMedia(data: Uint8Array, aesKey: string) → Uint8Array
export function guessMimeFromFilename(name) → string
```

### 3.5 `src/ilink/store.js`
```js
export function resolveDataDir(config) → string   // config.dataDir || $DSH_HOME/wechat-ilink || ~/.dsh/wechat-ilink
export function createAccountStore({ dataDir })
// → {
//   load() → Promise<object|null>, save(account) → Promise<void>, clear() → Promise<void>,
//   readBuf(key) → Promise<string>, writeBuf(key, buf) → Promise<void>,
//   path: string,
// }
```

### 3.6 `src/ilink/poll.js`
```js
export function startPollLoop({ client, getBuf, setBuf, onMessages, onError?, signal, logger?, backoffMs = 3000 })
// → { stop(): void, done: Promise<void> }
```
约定：长轮询超时/网络错误必须**退避重试**，不得退出循环；`signal.aborted` 时立刻结束。

### 3.7 `src/ilink/index.js`（barrel）
re-export 上述全部符号。

### 3.8 `src/service.js` + `src/bridge/**`
```js
// src/service.js
export class WechatIlinkService extends Service {
  static inject = ['tools', 'systemPrompt']
  constructor(ctx, config)            // config 来自 cordis.patch.yml 的 wechat-ilink 行
  async start()                       // 登录态检查 + startPollLoop；ctx.emit('wechat-ilink/message', msg)
  async stop()
  async sendText(toUserId, text, opts?)   // 分片发送
  async sendTyping(toUserId, contextToken?)
  get dataDirectory()                 // → store 目录（bridge 用它存 session 选择）
  onMessage(handler)
}
export const name = 'wechat-ilink'
export { Config } from './config.js'
export default WechatIlinkService
```
```js
// src/bridge/index.js
export const inject = ['wechatIlink', 'agents']
export function apply(ctx, config)
export { Config as BridgeConfig } from './config-bridge.js'  
```
bridge 行为：`ctx.on('wechat-ilink/message', onInbound)` → allowlist 判定 → `ensureAgent(canonical)`
→ `agent.send(createUserMessage({content, source:{kind:'wechat-ilink', accountId, peerId}}), 'next-turn', true)`
→ 监听 `ctx.on('session/event')`：`assistant/message` 累积、`turn/end` 整段发回。
命令（默认前缀 `/`）：`/new` 开新会话、`/status` 当前状态、`/stop` 中断、`/help`。

### 3.9 其余模块
`package.json`、`cordis.patch.yml`、`src/config.js`、`src/bridge/config-bridge.js`、`README.md`、`scripts/*`、`docs/*`。

## 4. 硬性验收标准
1. `node --test tests/` 全绿（A/B 各自的测试 + C 的验证测试）。
2. 所有模块在 Node 24 下 `import` 成功，无第三方运行时依赖（除 DSH 提供的 `@deepseek-ai/*`）。
3. `scripts/probe-ilink.mjs` 能真实跑通：拿到 `ret:0` + 二维码 URL。
4. `package.json` 的 peer 范围覆盖 `0.2.0-rc.2`；`dsh.bundle.patch` 指向存在的 `cordis.patch.yml`。
5. 插件目录可被 DSH profile 以 `link:` 方式安装，且 `pnpm install` 不报错（先跑 `-DryRun` 预览）。
