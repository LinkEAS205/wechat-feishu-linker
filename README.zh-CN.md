# wechat-feishu-linker

**English:** [README.md](README.md)

**English:** [README.en.md](README.zh-CN.md)

把 **微信 ClawBot（腾讯 iLink 官方个人号 Bot 协议）** 和 **飞书 / Lark** 两条通道
一起桥接到 **DeepSeek Harness（DSH）**：绑定后，在微信或飞书里给机器人发消息，
消息进入一个真实的 DSH agent 会话，回复再回到你发消息的那个客户端。

**两条通道共用同一套桥接。** 桥接是通道无关的——它只要求通道提供
`sendText` / `sendTyping` / `dataDirectory` / `getStatus`，所以新增一条通道等于新增一个服务行，
桥接一行都不用改。回复行为和新会话默认值**可以按通道分别设置**（见 §7）。

| | 微信 | 飞书 / Lark |
| --- | --- | --- |
| 绑定方式 | 扫码（iLink 二维码） | **扫码一键创建应用**（飞书直接下发 App ID / Secret） |
| 收消息 | 长轮询 | 长连接（WebSocket，无需公网地址） |
| 输入中提示 | `sendtyping`，一次性信号 → 需续发 | 消息 reaction，持久 → 无需续发 |
| 发送限制 | 有会话窗口，关闭后需暂存补发 | 需**回复**收到的消息（主动推送受限） |

微信协议实现移植自 ZCode 的微信 iLink provider
（[`zai-org/ZCode`](https://github.com/zai-org/ZCode) `packages/services/src/bots/providers/weixinProvider.ts`
与 `weixinRegistration.ts`），并按 8 个独立开源实现的交叉验证结果做了修正；
飞书部分同样以 ZCode 的 `feishuProvider.ts` / `feishuAppRegistration.ts` 为参考。

---

## 1. 能力

### 两条通道共有

| 能力 | 状态 |
| --- | --- |
| **Web UI：设置页按通道分组**（微信一组、飞书一组，各自的状态 / 绑定 / 回复设置 / 新会话默认） | ✅ 见 §5 |
| **回复行为按通道分开**（`displayMode` / 输入中提示 / 消息长度） | ✅ 见 §7 |
| **新会话默认按通道分开**（模型 / 思考档位 / 权限预设） | ✅ 见 §7 |
| **入站消息直接插话**（`agent.steer` → `next-step`，不等当前轮跑完） | ✅ 代码与单测 |
| 复用已有工作区与已有对话（`/workspaces` `/cwd` `/sessions` `/use` `/peek` `/current`） | ✅ 见 §6 |
| 每联系人一个 DSH 会话（`per-peer`）/ 共享会话 | ✅ |
| 斜杠命令 `/new` `/status` `/stop` `/help` `/model` `/effort` `/permission` | ✅ |
| 白名单 / 群聊策略 | ✅ |
| **审批 / 选择请求镜像到聊天窗口**（与 GUI 赛跑，任一侧先答即可） | ✅ 见 §6.1 |
| **发送尝试落盘**（`send-log.jsonl`，静默失败也能事后查） | ✅ 见 §8 |
| **宿主兼容性自检**（DSH 升级后哪个能力没了，一眼可见） | ✅ 见 §8 |

### 微信通道

| 能力 | 状态 |
| --- | --- |
| 扫码登录（`get_bot_qrcode` / `get_qrcode_status`） | ✅ 实测 |
| 长轮询收消息（`getupdates` + 游标持久化） | ✅ 实测 |
| 回复投递（`sendmessage` + `context_token`） | ✅ 端到端实测 |
| **回合运行期间持续续发"正在输入"**（`typingRefreshMs`） | ✅ 见 §8 |
| **窗口关闭时暂存回复，对方下次发消息后补发**（`ret:-2` 不再丢文本） | ✅ 见 §8 |
| `wechat_send` 宿主工具（模型主动发消息） | ✅ |
| 媒体（AES-128-ECB 解密 CDN 附件） | ⚠️ 只有协议层（`src/ilink/media.js` + 单测）；**通道服务尚未接入附件下载**，相关配置键是**预留** |
| 主动推送（无人先说话时） | ⚠️ 见 §8「会话窗口」 |

### 飞书通道

| 能力 | 状态 |
| --- | --- |
| **扫码一键创建并绑定应用**（飞书设备码注册流程，自动下发凭据） | ✅ 见 §5.1 |
| 长连接收事件（`im.message.receive_v1`） | ✅ 端到端实测 |
| **回复收到的消息**（`/messages/{id}/reply`） | ✅ 端到端实测 |
| 富文本（`post`）与 `@` 提及解析 | ✅ |
| 输入中提示（消息 reaction） | ⚠️ 需开通 reaction 权限；未开通时静默降级 |
| 手动填写已有自建应用 | ✅ |

---

## 2. 架构：为什么零 `@deepseek-ai/*` import

DSH 按 **realpath** 加载插件（`link:` 指向 `~/.dsh/plugins/<name>`），插件目录向上没有
`@deepseek-ai` 包树；而且不同 DSH 安装里这些包的版本并不一致。第三方插件只要 `import`
它们，就可能被 peer 闸门拦掉、或拿到与宿主不同的实例。

所以本插件**在运行时 import 任何 `@deepseek-ai/*`**（这也是最成熟的先例 `dsh-wechat` 的做法）：

- 插件是**函数式 Cordis 插件**：`export const name` + `export function apply(ctx, config)`；
- 宿主能力全部走 `ctx.get('agents' | 'tools' | 'systemPrompt' | ...)` 并**判空降级**；
- 用户消息对象内联构造（等价于 `dsh-llm` 的 `createUserMessage`），会话 id 用 GUI 同款 `session-<uuid>`；
- 两个插件行通过进程内注册表（`src/registry.js`）互相发现，不依赖 Cordis 服务名。

```
src/
  index.js            插件入口（service 行）
  config.js           默认值（无 schema 依赖）
  registry.js         进程内服务注册表（按通道分键）
  service.js          iLink 通道服务
  service-feishu.js   飞书通道服务
  ilink/              微信协议层（零依赖、可单测）
    client.js         HTTP/认证/重试
    login.js          扫码登录
    normalize.js      报文归一化、分片、CRLF
    media.js          AES-128-ECB CDN 解密
    store.js          凭据/游标持久化（原子写 + 0600）
    poll.js           长轮询循环（指数退避）
  feishu/             飞书协议层
    client.js         HTTP：token / 发消息 / 回复 / reaction
    normalize.js      入站事件归一化（容忍摊平与 post）
    registration.js   设备码扫码注册（一键创建应用）
    store.js          凭据持久化
    ws.js             SDK 长连接
  bridge/             入站 → agent → 回信（通道无关）
  web/                设置页 API 与二维码渲染
```

---

## 3. 安装

前置：DSH 桌面版已运行过一次（`~/.dsh/profiles/desktop` 存在）、`pnpm` 可用、Node ≥ 22。

**首选方式**：让 DSH 自己的插件管理器安装（官方推荐路径，会自动处理依赖与 bundle 选择）：

```
plugin_manager install_bundle  target = <workspace>\wechat-feishu-linker
```

**等效的脚本方式**（适合没有 `plugin_manager` 工具的环境）：

```powershell
# 先看会改什么
powershell -ExecutionPolicy Bypass -File scripts\install.ps1 -DryRun

# 真正安装（会先备份 profile/package.json）
powershell -ExecutionPolicy Bypass -File scripts\install.ps1
```

脚本做三件事：给 profile 的 `package.json` 加 `link:` 依赖、把包名追加到
`dsh.profile.bundles`、在 profile 目录跑 `pnpm install`。

> **重启 DeepSeek Harness 后生效**（宿主插件在启动时按 bundle 列表加载）。
> 重启会结束当前进程里的会话，请在方便的时候做。

> **改过 `client.js` 的话，还要额外硬刷新一次页面（Ctrl+Shift+R）。**
> 宿主侧（`src/**`、`cordis.patch.yml`）重启即生效；但**客户端模块是浏览器加载的**，
> 重启 DSH 不会让已经开着的标签页重新拉取它——表现是"设置页在、但里面少了新加的卡片"。
> 实测踩过一次：接口 `/wechat-ilink/api/status` 已经返回 `settings`，而界面上那张
> 「回复设置」卡不出现，原因就是标签页还跑着改动前的模块。

回滚：恢复 `package.json.bak-wechat-ilink-*`，并删掉 bundles 里的那一项。

### 3.1 飞书通道的依赖（必须单独装）

飞书的**长连接**用官方 `@larksuiteoapi/node-sdk`（飞书的所有 HTTP 接口仍然是原生 fetch，
SDK 只负责这一件事）。

**这个依赖必须装在插件的 realpath 上溯路径里**——宿主是用 **junction** 加载本插件的
（`profiles/desktop/node_modules/wechat-feishu-linker` → `<workspace>\wechat-feishu-linker`），
Node 从 **realpath** 向上找依赖，**永远走不到 profile 的 `node_modules`**。
这正是本插件坚持零 `@deepseek-ai/*` import 的原因，同一条规则也管住了这个依赖。

```powershell
# 装在本插件的上一级（Node 从插件 realpath 向上查找会命中这里）
cd <workspace>
npm install @larksuiteoapi/node-sdk --ignore-scripts --prefix <workspace>
```

**两个实测踩过的坑**：

- **必须加 `--ignore-scripts`**。不加会失败在 `EPERM: syscall: 'spawn'`——npm 跑包的生命
  周期脚本时用管道 stdio，撞上受限模式的命名管道限制。**这不是权限问题**（我一开始误判成
  ACL 问题，跑了一次权限修复，方向是错的）。
- **依赖装不进插件自己的目录**：受限模式下子进程只能在**工作区根目录**写，
  **任何子目录（含插件目录）都写不了**。装在 `<workspace>\node_modules` 正好落在
  上溯路径上。

未安装时插件**不会加载失败**：飞书那一行会报出明确原因，微信通道不受影响。

---

## 4. 登录

```powershell
node scripts\login.mjs                 # 打印二维码链接，轮询到手机确认为止
node scripts\login.mjs --data-dir D:\dsh-wechat
```

用手机微信打开打印出来的链接（或在浏览器打开后扫码）确认绑定。成功后 `bot_token`
写入 `<dataDir>/account.json`（权限 0600），插件下次启动自动使用。

已有 `cc-connect` 等其他 iLink 客户端登录过的话，凭据在
`~/.cc-connect/config.toml`，可以先用它验证：

```powershell
node scripts\probe-ilink.mjs                    # 只读：拿一个真实二维码
node scripts\live-check.mjs                     # 只读：getconfig
node scripts\live-check.mjs --send "测试"        # 真发一条（需要活跃会话窗口）
```

---

## 5. 界面里扫码绑定（Web UI）

插件带一个客户端模块（`client.js`，`dsh.client.platform = "web"`），注册到 DSH 设置页的
`settings.section` 槽位，标题「微信 ClawBot」。打开 **设置 → 微信 ClawBot** 即可：

- **状态卡**：是否已绑定、bot id / account id、长轮询状态（连接中 / 轮询中 / 空闲 / 错误）
- **扫码绑定**：点「扫码绑定」→ 界面直接显示二维码 → 手机微信扫码确认 → 自动写盘并重连
- **解绑**：清除本机凭据
- **工作区 / 会话**：列出并切换（与 §6 的命令是同一套 service 方法）
- **回复设置**：`displayMode`（逐段发送 / 整轮合并）与输入中提示开关，**改完立即生效、无需重启**，并写回 profile 配置
- **新会话默认**：以后新开的微信会话用哪个**模型**、**思考档位**、**权限预设**
- **诊断行**：宿主兼容性（13 个宿主面缺了哪个）、以及"有 N 条回复因会话窗口关闭未送达"

### 「新会话默认」与微信命令是两件事

| | 改什么 | 存哪 | 生效 |
| --- | --- | --- | --- |
| **微信命令** `/model` `/effort` `/permission` | **当前这个对话** | 会话日志 | 立即，**DSH 界面同步跟着变** |
| **设置页「新会话默认」** | **以后新开的**会话 | 插件配置 | 新会话创建时套用一次 |

设置页做不了"切换当前对话"——它是全局的，没有"当前对话"这个概念（你可能同时有多个联系人）。
而**优先级保证它们不会打架**：`会话自己的选择 > 插件默认 > 部署默认`。
所以你在微信里切过之后，设置页的默认**不会**把它盖回去；权限预设也**只在会话创建时套用**，
不会覆盖你后来用 `/permission` 改过的选择。

### 设置项为什么不会出现"两边不一致"

设置页**不保存任何副本**：它渲染的永远是 `GET /status` 返回的 `settings`，而那个值来自
bridge 那一行持有的**同一个 config 对象**（`src/bridge/settings.js` 只提供 `read`/`apply`，
registry 里传的是句柄而不是快照）。

- **写入**走 `POST /settings` → bridge 直接改自己正在用的那份 config → 下一次事件就生效；
- **响应体里回的是"bridge 现在持有什么"**，页面渲染它、而不是渲染"我刚才请求了什么"——
  所以即使写入被拒绝或只部分生效，界面也不会显示一个中继根本没在用的值；
- 桥接那一行没启动时 `/status` 返回 `settings: null`，页面据此显示"暂时改不了"，
  而不是给一个点了没反应的控件。

这条设计针对的正是**卡片那次的问题**：那个 bug 的根因是同一个决定有**两个所有者**
（微信一个 promise、GUI 一个 promise）；设置项只有一个所有者，页面是纯视图，因此不可能失联。

宿主侧 HTTP API（由插件自己的 `mountWebApi` 注册在 GUI webserver 上）：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/wechat-ilink/api/status` | 状态；**不含 bot_token**；含 `settings`（桥接未启动时为 `null`） |
| POST | `/wechat-ilink/api/settings` | 改运行期设置：`{displayMode?, typingIndicator?}`，回 `{ok, settings, persisted}` |
| POST | `/wechat-ilink/api/login/begin` | 取二维码：`{qrcode, qrUrl, qrImageUrl, expiresAt, intervalMs}` |
| GET | `/wechat-ilink/api/login/poll?qrcode=` | 轮询扫码状态；成功即写盘并重连 |
| GET | `/wechat-ilink/api/qr.svg?qrcode=` | 宿主自渲染的二维码 SVG |
| POST | `/wechat-ilink/api/logout` | 解绑 |
| GET | `/wechat-ilink/api/workspaces` / `/sessions?workspace=` | 工作区 / 会话列表 |
| POST | `/wechat-ilink/api/bind` | `{workspace, sessionId}` |

> **重要协议事实**：`qrcode_img_content` 返回的是 `https://liteapp.weixin.qq.com/q/...` 的
> **liteapp 网页**（`Content-Type: text/html`），**不是图片**——`<img src>` 直接用它必然是坏图。
> 所以宿主用自带零依赖 QR 编码器（`src/web/qrcode.js`，ISO 18004 字节模式/EC-L）把它渲染成
> `/api/qr.svg`，客户端优先用 `qrImageUrl`，并把 `qrUrl` 作为「在微信中打开」的备用链接。

---

## 5.1 飞书通道

同一个插件里并列的第二条通道，与微信**共用同一套桥接**。

### 为什么能共用

`src/bridge/**` 本来就是通道无关的：它只要求通道提供 `sendText` / `sendTyping` /
`dataDirectory` / `getStatus`。所以新增一条通道 = **新增一个服务行**，桥接一行都不用改。

唯一要动的是两处：

1. **注册表按通道分键**（`src/registry.js`）。原来是单槽，两条通道会互相挤掉。
   不传通道名的调用仍然落到微信，所以所有既有调用点和测试原样可用。
2. **桥接按会话解析通道**：`channel(link) = getService(link?.channel)`。
   消息由投递它的服务打上 `channel` 标记，跟着 link 一起存。
   另外所有按对端分键的 Map（未送达暂存、决策卡）改用**复合键**
   `${channel}:${peerId}`——两个通道的 peerId 没有任何机制保证不撞车。

### 与微信的差异，以及微信那一路的教训怎么落地

| 维度 | 微信 | 飞书 | 教训是否用上 |
|---|---|---|---|
| **输入中提示** | `sendtyping` 一次性信号，约 5 秒灭 → 必须 5 秒续发 + 缓存 ticket | **给用户消息加 `Typing` reaction，持久** → 加一次就够，**不需要心跳** | ✅ 桥接的刷新循环直接复用（客户端幂等），另加 `clearTyping` |
| **回合结束** | 信号自己过期，什么都不用做 | **reaction 不会自己消失** | ✅ 桥接在 `turn/end` 调 `clearTyping`；没有该方法的通道自动跳过 |
| **会话窗口** | 短命，关了就发不出去 → 需要暂存 + 补发 | **没有这个概念** | — |
| **发送预算** | 按条数计费 → `compact` 合并发送 | 同样合并（8 秒窗口） | ✅ 同一个 `compactFlushMs` |
| **失败可见性** | 提示走同一通道 → 静默 | 失败带 `code`/`msg`/**`log_id`** | ✅ 全部保留 |

### 从参考实现里带过来的三个坑

ZCode 的 `feishuProvider.ts` 里每条 `Bugfix` 注释都是一个真实故障，这里逐条对应：

1. **SDK 会把 `event` 字段摊平到顶层** —— 只读 `payload.event.message` 会把每一条真实消息
   解析成空。`unwrapEvent()` 两种形状都接受。
2. **富文本/带链接的消息以 `message_type: "post"` 推送** —— 只读 `content.text` 得到空串，
   而空串会被当成"不是消息"丢掉，用户侧表现为**发了消息但机器人没反应**。
   `postText()` 会走二维结构并把链接目标保留下来。
3. **`start()` 在连接完成前就返回，且该 SDK 版本没有 ready 回调** —— 必须轮询
   SDK 真正持有的 WebSocket 的 `readyState`；`isConnecting === false` 且 socket 未开
   表示**重连预算耗尽**，是终态而不是抖动。

### 状态

| 项 | 状态 |
|---|---|
| 协议客户端（token / 发消息 / reaction） | ✅ 13 条用例 |
| 入站解析（含上面两个坑） | ✅ 11 条用例 |
| 通道服务（绑定 / 状态 / 入站 / 出站） | ✅ 13 条用例 |
| 桥接通道路由 + 提示收回 | ✅ 4 条用例 |
| **设置页里填 App ID / Secret 绑定** | ⏳ **还没做**——目前要把凭据写进 `<dataDir>/feishu.json` |
| **真机联调** | ⏳ 未做（需要真实的飞书自建应用） |

---

## 6. 复用已有工作区与已有对话

微信侧不再只能用一个临时会话。所有命令走 `commandPrefix`（默认 `/`）：

| 命令 | 作用 |
| --- | --- |
| `/workspaces` | 列出 DSH 里已有的工作区（`workspaceRegistry.list()`） |
| `/cwd <path>` | 把当前微信联系人切到某个工作区；之后新建的会话 `cwd` 用它 |
| `/sessions` | 列出已有会话（id / 标题 / 时间，截断防刷屏） |
| `/use <sessionId>` | **把当前联系人绑定到某个已有会话**（`agents.resume`），从此在微信里继续那段对话 |
| `/peek [sessionId]` | 把某个会话最近的对话内容发回微信——不切换也能"看" |
| `/current` | 显示当前绑定的工作区 + 会话 |
| `/new` | 开新会话（**保留当前工作区**） |

绑定关系（peer → 工作区 + 会话 id）落盘在 `bridge-sessions.json`，重启后仍然有效；
旧版本存字符串格式会自动升级。宿主不提供某个服务时，命令回
「⚠️ 当前宿主不提供该能力」，不会报错也不会静默失败。

### 入站消息是"插话"，不是"排队"

微信进来的每一行都用 **`agent.steer()`**（即 `send(msg, 'next-step', true)`）投递，
**注入当前正在跑的那一轮的下一步边界**——和 GUI 里"插话"按钮走的是同一条路。

对比宿主的三档投递：

| 方法 | 目标 | 行为 |
| --- | --- | --- |
| `followup(msg)` | `next-turn` | 排队，**等当前轮跑完**才被读到 |
| **`steer(msg)`** | `next-step` | **插话**，当前轮下一步就看到 ← 本插件用这个 |
| `inject(msg)` | `next-step` | 插话但**不唤醒** agent |

用 `next-turn` 的问题在长回合上很直观：用户又发一句，**界面上什么都不发生**，
那行字要等当前这轮干完才被读到——在一轮跑十几分钟的时候，体感就是"它卡住了"。

宿主没有 `steer` 时回退到等价的 `send(msg, 'next-step', true)`；agent 对象是结构化读取的
（docs/INTERFACES.md §2.0），不依赖 `@deepseek-ai/*` 类型。

---

## 6.1 审批卡 / 选择卡（DSH 的决策请求）

DSH 会把两类决策请求派发成**挂在 agent 作用域上的 waterfall**：

| waterfall | 请求 | 回答 |
| --- | --- | --- |
| `approval/request` | `{ agent, toolName, callId?, reason?, signal }` | `allowed-once` / `rejected` / `cancelled` / `unavailable` |
| `user-questions/request` | `{ questions: [{ id, question, options: [{ label }] }], agent, signal }` | `{ answers: [{ id, selected: [label], custom? }] }` |

GUI 驱动的会话由界面原生渲染。**微信驱动的会话没人看界面**——不镜像的话，agent
就永远卡在一张只有 GUI 能显示的卡上，微信侧连"有请求"都看不到。

本插件在插件 ctx 上以 **`prepend: true`** 挂这两个 waterfall，于是自己的监听器
**包在 GUI 应答器外面**：`next()` 就是 GUI 的答案，两边**赛跑，谁先答谁赢**。

- **没有微信对端** → 立刻 `next()`，GUI 仍是唯一应答者（不影响界面里正常用）。
- **GUI 先答** → 微信卡撤回，用户的下一条消息不会被这张卡吃掉。
- **微信先答** → **GUI 那张卡跟着消失**。做法是把 `request.signal` 换成本插件控制的
  fork：两张 GUI 卡都绑它、中止即消失，而请求**原本的** signal 分毫未动——宿主在派发
  waterfall 之前就存了它的引用，中止它会把整个请求判成 `cancelled`，反过来跟微信的答案赛跑。
- **超时**（`cardTimeoutMs`，默认 30 分钟）→ 撤回微信卡并提示，决策权交回 GUI。
- **管理命令优先**：`/status` 这类已知命令永远不会被当成卡片回答；以命令前缀开头但**不是**
  已知命令的文本（比如 `/rp`）会被拒绝并提示，不会被静默当成答案提交。

回复语法：

| 卡片 | 回复 |
| --- | --- |
| 审批卡 | `1` / `允许` / `once` → 仅允许这一次；`2` / `拒绝` / `reject` → 拒绝 |
| 单题选择卡 | 回复**序号**（映射到选项 label），或直接回复自由文本（作为 `custom`） |
| 多题选择卡 | `Q1=2 Q2=1`；缺题会被拒绝并提示补全（宿主强制要求每题恰好答一次，所以不会静默填默认值） |

> **实测（2026-09-30，微信端）**：两张卡都真实出现过、并且都是**从微信答复**的——
> 选择卡回序号后答案回到了 agent；审批卡镜像的是一次**真实**的 `danger-full-access`
> 沙箱升级请求（`dsh-tool-fs` → `ctx.get("approval")` → `approval/request`），
> 从微信批准后写盘**真的执行了**，闭环有副作用可验证。

---

## 7. 配置

两个插件行，都在 `~/.dsh/profiles/<profile>/cordis.patch.yml` 里覆盖：

```yaml
- id: wechat-ilink
  config:
    dataDir: ''                 # 空 = $DSH_HOME/wechat-ilink
    autoConnect: true           # false 时只装载服务、不启动轮询
    pollTimeoutMs: 45000        # 长轮询超时（服务端最多挂 35s）
    maxMessageLength: 1800
    baseUrl: 'https://ilinkai.weixin.qq.com'
    # 以下为预留项，当前版本不生效（媒体下载尚未接入通道服务）
    mediaEnabled: true
    mediaMaxBytes: 20971520
    mediaCacheDir: ''
    cdnBaseUrl: 'https://novac2c.cdn.weixin.qq.com/c2c'
- id: wechat-ilink-bridge
  config:
    enabled: true
    sessionMode: per-peer       # 或 shared
    dmPolicy: open              # open | allowlist | disabled
    allowlist: []
    groupPolicy: disabled
    replyMaxChars: 1800
    displayMode: compact        # compact | quiet，见下
    typingIndicator: true
    typingRefreshMs: 45000      # 回合运行期间续发"正在输入"的间隔；0 = 不续发
    commandPrefix: '/'
    cardTimeoutMs: 1800000      # 审批/选择卡等回复的上限（毫秒）
    provider: ''                # 空 = 用部署的默认模型
    model: ''
```

### `displayMode`：一轮回复怎么发到微信

| 模式 | 行为 |
| --- | --- |
| **`compact`**（默认） | 回合进行中**按窗口合并发送**：`compactFlushMs`（默认 8 秒）内落地的碎片并成一条，`turn/end` 时立即补发剩下的。你发一句话，微信端会随着 agent 干活逐步出现回复，而不是等整轮结束才一次性收到。 |
| `quiet` | 整轮的文本合并成**一条**，在 `turn/end` 时发出。 |

**两种模式都不镜像工具调用和思考。**

> **为什么不是"每段一条"**：最初 `compact` 就是每段碎片单独发一条，**实测证明那是个错误**。
> 一轮会产出十几段模型消息（大多是一行说明），逐段发送把**会话窗口**消耗快了约一个数量级——
> 而窗口正是**最后那条回复**需要的东西，于是"最后产出的东西"成了"最可能被拒绝的东西"，
> 表现为**微信只收到一半**。`compactFlushMs: 0` 可以退回逐段发送，但要知道代价。

想省条数就切回 `quiet`；想要过程感就用 `compact`。

---

## 8. 运维要点（都是实测/交叉验证得到的）

- **会话窗口**：iLink 只在有活跃会话窗口时接受发送。没有窗口（没人先给机器人发过消息）时
  `sendmessage` 返回 `{"ret":-2,"errmsg":"prepare failed"}`。所以**主动推送在对方先说话之前不可用**；
  回复入站消息时插件会自动带上该消息的 `context_token`，因此正常对话不受影响。
- **`context_token` 过期**：`sendmessage` 返回 `ret:-2` 时，客户端会自动**去掉 token 重发一次**。
  （这是**按消息**重试的，在 `sendText` 的分片循环内部；所以超长回复的第 2 片失败时，
  第 1 片不会被重发。）
- **`context_token` 是短命的，只有"对方再发一条"才能刷新**（实测：一轮长回合跑十几分钟，
  token 中途失效，于是**最后那条最重要的回复正好发不出去**）。失效时**任何载荷变体都不被接受**
  ——去掉 token 重发也救不回来，服务端只会用"最近活跃的会话"，可能投错窗口。
  所以桥接的做法是：**`ret:-2` 时不丢文本，暂存起来**，等对方下一条消息刷新窗口后补发
  （上限 `UNDELIVERED_LIMIT = 20` 条，超出丢最旧的）。在此之前这种情况是**静默丢失**：
  连"发送失败"的提示都走同一条通道，所以也发不出去，对方那边彻底安静——
  实测表现就是"**PC 端说完了，微信端说一半**"。
- **发送尝试落盘**：每次出站尝试都会追加一行到 `<数据目录>/send-log.jsonl`
  （`{at, peerId, chars, token, ok, error}`，保留最近 200 条）。
  理由很实际：**回复被丢弃时，本该报告失败的那条提示走的是同一条通道**——
  通道本身出问题时，任何地方都不会留下痕迹。实测中它一次就定位到了上面那个
  `prepare failed` 的分布（连续成功 → 突然全失败 → 对方发消息后恢复）。
- **登录态失效**：`errcode:-14` 会被识别为 `IlinkAuthError`，需要重新扫码。
- **24 小时**：iLink 会话大约 24 小时后失效，服务端不主动通知；表现为 `errcode:-14`。
- **静默失败**：`sendmessage` 缺 `base_info` / `from_user_id` / `client_id` 时可能返回
  HTTP 200 + `{}` 却**不投递**——因此这三个字段必须始终存在（本插件已保证）。
- **换行**：发送前把 `\r\n|\r|\n` 统一成 `\r\n`（微信各端对 LF 处理不一致）。
- **单一轮询者**：同一 bot token 同时被两个客户端长轮询会互相抢消息。装本插件前请停掉
  cc-connect 之类的其他 iLink 客户端。
- **"正在输入"必须续发，而且要够密**：`sendtyping` 是**一次性信号，没有持续时间**——
  实测微信端**大约亮 5 秒**就灭了。所以：
  - 间隔必须**短于显示时长**，否则对方只看到闪一下。默认 `typingRefreshMs: 5000`；
    最初设成 45 秒时，实测反馈是"**只亮了几秒就没再出现**"（一轮十分钟里 90% 时间是黑的）。
  - **`typing_ticket` 要缓存**：`getconfig` 铸 ticket 时要用对方的 `context_token`，
    而那个 token 在长回合里会失效——所以"每次续发都重新铸 ticket"正是**指示器中途死掉**的原因：
    第一次成功，之后全部因 token 过期而失败。客户端现在按对端缓存 ticket（首次趁 token 新鲜时取），
    被拒时才丢弃重铸。
  - 续发失败会记进 `send-log.jsonl`（`kind: "typing"`，**只记失败**，因为间隔很短，
    成功也记会把诊断痕迹冲掉）。
  - 定时器 `unref()`，不会拖住宿主进程退出。

---

## 9. 验证状态

| 项目 | 结果 |
| --- | --- |
| 单元/集成测试 | 逐文件运行 → **459 pass / 0 fail**（含 `tests/verify/**` 的独立契约、边界与二维码用例） |
| 实时接口探测 | `scripts/probe-ilink.mjs` → `ret:0` + 真实二维码，`get_qrcode_status=pending` |
| 实时认证 | `getconfig({ilink_user_id})` → 返回 `typing_ticket`（不带 `ilink_user_id` 会被服务端拒绝） |
| 实时长轮询 | `getupdates` → 返回真实游标 |
| **端到端投递** | 收到微信入站消息 → 带 `context_token` 回信 → **`ret:0` 已投递** |
| **真实 DSH 加载两行插件** | ✅ 2026-09-30：`link:` 装进 `desktop` profile，重启后服务行与桥接行都起来了（`/status` 报 `bound/connected/polling`） |
| **Web UI 扫码绑定** | ✅ 2026-09-30：设置页扫码 → 凭据落盘 `~/.dsh/wechat-ilink/account.json` |
| **审批卡 / 选择卡镜像** | ✅ 2026-09-30 微信端实测（两轮）：选择卡在微信出现并被**从微信**答复；审批卡镜像了**真实**的 `danger-full-access` 升级请求，从微信批准后写盘真的执行 |
| **微信先答时 GUI 卡片消失** | ✅ 2026-09-30 实测：从微信答复/批准后，DSH 界面上对应的卡片跟着消失 |
| **"正在输入"在长回合里持续亮着** | ✅ 2026-10-01 实测（微信端）：一轮跑两分钟，提示基本一直亮着 |
| **窗口关闭时暂存回复、对方发消息后补发** | ✅ 代码与单测（2026-10-01 由 `send-log.jsonl` 定位到 `prepare failed` 的分布后实现） |
| 二维码可扫性 | 自研 QR 编码器生成的矩阵用独立解码器（jsQR）解码 5/5 全部还原原文 |
| 安装面 | `install.ps1 -DryRun` 零写入；临时 profile + junction 后两个入口均可解析 |
| 独立验证 | 第一轮 0 阻断 / 4 重要 / 7 次要（已修）；第二轮见 [`docs/VERIFICATION.md`](docs/VERIFICATION.zh-CN.md) |

未验证（详见 `docs/VERIFICATION.md`）：**多题选择卡与自由文本回答的微信实测**、
**卡片超时撤回**、**GUI 先答时撤回微信卡**（有单测、无实测）、媒体下载、
`sendtyping` 真 POST、群聊策略、24 小时失效后的自动重登、`pnpm install` 实跑。

---

## 10. 安全与许可

- 凭据文件权限 0600、原子写；游标单独存 `sync-buf.json`，重新登录会清掉旧游标。
- 插件不安装任何 npm 依赖，不启动子进程，不开监听端口。
- `dmPolicy: open` 意味着**任何能给这个 bot 发消息的人都驱动一个 DSH 会话**——
  想收紧就设 `dmPolicy: allowlist` + `allowlist: ['<对方 id>@im.wechat']`。
- 本仓库为独立实现，MIT。协议知识来自 ZCode（公开源码）与多个 MIT 开源项目；
  与腾讯无隶属关系，使用须遵守微信/ClawBot 的服务条款。
