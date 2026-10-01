# wechat-feishu-linker — interface contract

**中文：** [INTERFACES.zh-CN.md](INTERFACES.zh-CN.md)


The rules that must not be broken, and why each one exists. Every entry here is
something that already went wrong once.

---

## 0. Environment facts (measured, not assumed)

- DSH loads a plugin through its **realpath**: `~/.dsh/plugins/<name>` is a
  junction to the checkout, and `link:` in the profile points at the package name.
- Node resolves imports from the **real** directory upward, so the profile's
  `node_modules` is never on that path.
- Cordis scopes `ctx.on` / `ctx.effect` / `ctx.inject` to the plugin fiber.

---

## 1. iLink protocol (WeChat)

Verified against the reference implementation and eight independent clients:

| Operation | Endpoint |
| --- | --- |
| QR login | `get_bot_qrcode` / `get_qrcode_status` |
| Receive | `getupdates` with a persisted cursor |
| Send | `sendmessage` with the contact's `context_token` |
| Typing | `getconfig` → `typing_ticket` → `sendtyping` |

Two properties drive most of the design:

- **`context_token` is short-lived.** Only a new inbound message mints a fresh
  one, so a send is only accepted for a few minutes after the contact last wrote.
  `ret: -2` / `"prepare failed"` means the window has closed.
- **`sendtyping` is a one-shot with no duration.** The client shows the indicator
  for a few seconds and forgets it, so it has to be re-signalled.

---

## 2. DSH integration surface

### 2.0 【frozen】No `@deepseek-ai/*` imports

**The plugin must not import any `@deepseek-ai/*` package at runtime.**

Three independent findings agree:

- DSH loads plugins by realpath, and a third-party checkout has no
  `@deepseek-ai` above it, so the packages do not resolve.
- The host's own versions are ambiguous on a real machine (app.asar ships
  `0.2.0-rc.2`, `profiles/node_modules` an older `0.1.5-rc.1`, and a bundled
  plugin its own `0.1.5-rc.2`). Any import risks a peer gate or a different
  instance from the host's.
- The most mature precedent (`dsh-wechat@0.9.6`) deliberately imports nothing and
  goes entirely through `ctx.get('<service>')`.

Rules:

1. `src/service.js`, `src/service-feishu.js` and `src/bridge/index.js` export
   **functional Cordis plugins**: `export const name`, `export function apply(ctx, config)`,
   `export default apply`. No Service subclass, no Schemastery `Config`; defaults
   are filled in code by `withDefaults(config)`.
2. Messages are constructed inline, with a session id in the GUI's own format
   (`session-${crypto.randomUUID()}`).
3. Service discovery goes through the process-local registry `src/registry.js`,
   never through `ctx.wechatIlink`.
4. Every host capability is read with `ctx.get(...)`, null-guarded, and degraded.
   **A missing capability may never make the plugin fail to load.**
   The authoritative list is `HOST_SURFACES` in `src/bridge/compat.js` — do not
   maintain a second copy here. It has already drifted once: this document listed
   seven surfaces while the plugin depended on twice that.

   | Surface | What stops working without it |
   | --- | --- |
   | `agents` | creating and resuming sessions — the whole relay |
   | `sessionPersistence` | resuming after a restart (falls back to a new session) |
   | `agentDefaultModel` | the deployment default when no model is configured |
   | `tools` | the `wechat_send` tool |
   | `systemPrompt` | prompt injection |
   | `sessionQuery` | `/peek` |
   | `sessionProjectionCache` | session titles and similar hints |
   | `workspaceRegistry` | `/workspaces`, `/cwd` |
   | `configEditor` | writing settings back to the profile (they then last until restart) |
   | `llm` | `/model`, `/effort` |
   | `permissionPresets` | `/permission` |
   | `on` (a `ctx` capability, not a service) | event listening — the whole relay |
   | `waterfall` (likewise) | mirroring approval and question cards |

   **Method-level surfaces** (not services; probed at use, degraded with an
   explanation): `agent.steer` (falls back to `send(msg, 'next-step', true)`),
   `session.append` (model and permission switches), `session.eventAt` /
   `session.requestHeader` (reading the current selection).

5. **Host compatibility self-check** (`src/bridge/compat.js`): the surfaces above
   are probed, the result is logged, and it is exposed through
   `/wechat-ilink/api/status` as `hostCompat` so the settings page can show it.
   The reason is practical: **a DSH update that renames or drops a surface raises
   no error anywhere — the feature simply stops working**, and the symptom ("why
   doesn't `/model` answer?") is a long way from the cause.
   The probe itself must be tolerant: `ctx.get` throws for a service that was
   never provided, which is precisely the case it exists to report.

### 2.1 One relay, two channels

The relay is channel-agnostic and resolves the channel **per conversation**:

```js
const channel = (link) => getService(link?.channel)
const settingsFor = (link) => channelConfig(config, link?.channel)
```

- The service that delivered a message stamps `channel` on it; the relay keeps it
  in the link. An unstamped message means the WeChat channel, which is what keeps
  every single-channel call site unchanged.
- **Anything describing delivery rather than policy must be read through
  `settingsFor`.** Reading `config.displayMode` directly makes that one setting
  silently ignore its channel — indistinguishable from the setting having been
  applied. `PER_CHANNEL_KEYS` in `src/bridge/config-bridge.js` is the list.
- Every per-peer map keys on `${channel}:${peerId}`. Nothing guarantees two
  channels never issue the same peer id.
- The web API is a **process-level singleton** (one route per prefix): whichever
  channel row starts first mounts it, and the rest are no-ops. A profile that
  disables the WeChat row must not take the Feishu card's routes with it.
- The API resolves a channel service from the **keyed registry**; the service
  handed in by the mounting row is only a fallback, and only for the channel it
  actually is. Mount order must not decide which service answers.

### 2.2 Feishu integration surface

- **Long connection** via `@larksuiteoapi/node-sdk` — the only use of the SDK.
  Every HTTP call is plain `fetch`.
- `tenant_access_token` lives ~2 hours and is cached with a safety margin.
- `receive_id_type` follows the id's prefix: `oc_` is a group, anything else is a
  person's `open_id`.
- **A reply and a fresh push are different operations.** A bot may always answer
  a message it received; pushing a new one is refused with
  `230101 Sending messages to users is temporarily unavailable` even for a
  published, enabled app.
- **HTTP 200 can carry a business refusal** (`code !== 0`). Treating status alone
  as success is how an undelivered message looks sent.
- **`start()` returns before the socket is open** and the SDK has no readiness
  callback, so readiness is read from the socket the SDK actually holds.
  `isConnecting === false` with a closed socket means the reconnect budget is
  spent — terminal, not a blip.
- **The dispatcher may flatten the event** to the top level instead of nesting it
  under `event`; normalization accepts both.
- **A rich-text message arrives as `message_type: "post"`**, not `text`. Reading
  only `content.text` yields an empty string, and an empty string is discarded as
  "not a message" — so an ordinary-looking message disappears without a trace.
- **Events are handed to the relay by emitting `wechat-ilink/message`**, the same
  way the WeChat channel does. Calling a local handler instead is how the Feishu
  channel swallowed every message: the relay only listens on the event, so the
  handler was a callback nobody had registered.

---

## 3. Module contract

| Module | Responsibility |
| --- | --- |
| `src/ilink/client.js` | iLink HTTP: login, polling, send, typing |
| `src/ilink/login.js` | QR login flow |
| `src/ilink/normalize.js` | inbound iLink payload → one message shape |
| `src/ilink/media.js` | AES-128-ECB CDN attachment decryption (protocol layer only) |
| `src/ilink/store.js` | credentials and the polling cursor on disk |
| `src/ilink/poll.js` | long polling with cursor persistence |
| `src/ilink/index.js` | barrel |
| `src/feishu/client.js` | Feishu HTTP: token, send, reply, reactions |
| `src/feishu/normalize.js` | inbound event → the same message shape |
| `src/feishu/registration.js` | the device-code app registration flow |
| `src/feishu/store.js` | Feishu credentials on disk |
| `src/feishu/ws.js` | the SDK long connection |
| `src/service.js` | the WeChat channel service |
| `src/service-feishu.js` | the Feishu channel service |
| `src/bridge/**` | the channel-agnostic relay |
| `src/web/**` | the settings API and the QR renderer |
| `src/registry.js` | the process-local channel registry |

---

## 4. Acceptance criteria

1. `node --check` clean on every source file.
2. The test suite passes per file.
3. No undeclared bare import (`tests/verify/contract.test.mjs`).
4. Every `cordis.patch.yml` row resolves to a loadable module exporting `apply`
   and a plugin name.
5. A missing host capability degrades, never fails the load.
6. The data directory and the credentials in it are never committed.
