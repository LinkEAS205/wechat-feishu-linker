# 验证状态

**English:** [VERIFICATION.md](VERIFICATION.md)

**English:** [VERIFICATION.en.md](VERIFICATION.md)

本文件只记录**结论与依据**。原始报文与逐次运行的命令输出属于施工日志，不随仓库发布。
**没有实测过的项目一律进 §6，不得当作通过。**

---

## 1. 结论摘要

| 面 | 结论 |
| --- | --- |
| 单元 / 集成测试 | ✅ **459 通过 / 0 失败**（逐文件运行） |
| 微信真实端到端 | ✅ 扫码登录、长轮询收消息、回复投递 —— 均实测 |
| 飞书真实端到端 | ✅ 收到事件、创建会话、回复送达 —— 均实测 |
| 冻结契约 | ✅ 无未声明的裸模块名；`cordis.patch.yml` 每一行都解析为可加载模块 |
| 自研 QR 编码器 | ✅ 由独立解码器（jsQR）交叉验证 |
| 宿主能力 | ✅ 13 项全部可用（`/wechat-ilink/api/status` 的 `hostCompat`） |

---

## 2. 测试执行

逐文件运行（受限环境下 `node --test` 自身会因 `spawn EPERM` 无法运行）：

```powershell
Get-ChildItem -Path tests -Recurse -Filter '*.test.mjs' |
  ForEach-Object { node $_.FullName }
```

| 文件 | 用例 | 覆盖 |
| --- | --- | --- |
| `tests/bridge.test.mjs` | 175 | 桥接：通道路由、会话、命令、决策卡、按通道设置、宿主自检 |
| `tests/ilink.test.mjs` | 110 | iLink 协议、二维码、附件、存储、长轮询 |
| `tests/web.test.mjs` | 60 | Web API、设置读写、二维码渲染、飞书路由、客户端渲染 |
| `tests/feishu.test.mjs` | 50 | 飞书协议、入站解析、扫码注册、通道服务 |
| `tests/verify/edge.test.mjs` | 25 | 边界与降级 |
| `tests/verify/contract.test.mjs` | 10 | 冻结契约、包清单、行解析 |
| `tests/verify/qr.test.mjs` | 5 | QR 编码器（jsQR 交叉验证） |
| 其余 | 24 | 宿主集成、HTTP、配置 |

---

## 3. 微信：真实端到端

| 环节 | 依据 |
| --- | --- |
| 未登录面探测 | `scripts/probe-ilink.mjs` 返回真实二维码，`get_qrcode_status=pending` |
| 扫码登录 | 手机确认后写入凭据，长轮询启动 |
| 收消息 | `getupdates` 返回真实游标并持久化 |
| 回复投递 | 带 `context_token` 回信，`ret:0` |
| 会话窗口关闭 | 实测到 `ret:-2` / `prepare failed`，并据此实现了「暂存 + 补发」 |
| 输入中提示 | 实测微信端持续亮起（一轮两分钟） |

**`send-log.jsonl` 是这一路最有用的产物**：窗口关闭导致 `sendmessage` 被拒这件事，
在它之前是**完全静默**的——对方的感受是"它不说话了"。

---

## 4. 飞书：真实端到端

| 环节 | 依据 |
| --- | --- |
| 一键创建应用 | 扫码后飞书下发 `client_id` / `client_secret` |
| 长连接 | 事件订阅选「长连接」，无需公网地址 |
| 收到事件 | `/feishu/status` 的 `events.received` 计数增加 |
| 创建会话 | DSH 侧出现新会话 |
| 回复送达 | 飞书客户端收到回复，`send-log.jsonl` 记录 `ok:true` |

### 排查过程中确认的飞书行为（均为实测）

| 现象 | 结论 |
| --- | --- |
| `code=230101 Sending messages to users is temporarily unavailable` | **主动推送**受限；**回复收到的消息**放行。必须用 `/messages/{id}/reply` |
| HTTP 200 + 非零 `code` | 业务拒绝藏在成功状态里；只看状态码会把未送达当成已发送 |
| 事件到达但无反应 | 事件必须**用 `ctx.emit` 交给桥接**；调用本地回调是无效的 |
| `status: 1` | **就是「已发布」**——本项目曾把该枚举误读成「审核中」 |
| 富文本消息 | 以 `message_type: "post"` 推送；只读 `content.text` 会得到空串并被丢弃 |

---

## 5. 冻结契约核对

- **无未声明的裸模块名**：`tests/verify/contract.test.mjs` 遍历 `src/**`，
  只允许 `node:*`、相对路径，以及 `package.json` 里声明过的 `@larksuiteoapi/node-sdk`。
- **每一行都能加载**：`cordis.patch.yml` 的三行（`wechat-ilink` / `feishu` /
  `wechat-ilink-bridge`）都解析为导出 `apply` 与插件名的模块。
- **宿主能力**：13 项全部可用；任一缺失只降级，**不会让插件加载失败**。

---

## 6. 未验证项（**不得当作通过**）

| 项 | 说明 |
| --- | --- |
| 微信媒体（图片 / 语音） | 只有协议层（`src/ilink/media.js`）与单测；**通道服务尚未接入附件下载**，相关配置键是预留 |
| 飞书输入中提示 | reaction 需要额外权限；未开通时静默降级，**成功路径未在真实环境验证** |
| 飞书群聊 | 解析层已处理（`chat_id` / `@` 提及），**未实测** |
| 主动推送（无人先说话） | 微信受会话窗口限制；飞书受 `230101` 限制 |
| 多账号 | 配置键预留，未实现 |
| 飞书 Lark 国际版 | 代码支持（`domain: lark`），**未实测** |

---

## 7. 复现命令

```powershell
# 全量测试（逐文件）
Get-ChildItem -Path tests -Recurse -Filter '*.test.mjs' |
  ForEach-Object { node $_.FullName }

# 真实 iLink 探测（需网络；Node 24 需 NODE_USE_ENV_PROXY）
node scripts\probe-ilink.mjs
node scripts\live-check.mjs

# 安装 dry-run
powershell -ExecutionPolicy Bypass -File scripts\install.ps1 -DryRun

# 宿主状态（DSH 运行中）
curl http://127.0.0.1:19387/wechat-ilink/api/status
curl http://127.0.0.1:19387/wechat-ilink/api/feishu/status
```
