# wechat-feishu-linker

**中文：** [README.zh-CN.md](README.zh-CN.md)



A **DeepSeek Harness (DSH)** plugin that bridges **two** chat channels to real DSH
agent sessions — **WeChat ClawBot** (Tencent's iLink personal-bot protocol) and
**Feishu / Lark**. Bind once, message the bot from either client, and the reply
comes back where you sent it.

**Both channels share one relay.** The relay is channel-agnostic: it only asks a
channel for `sendText` / `sendTyping` / `dataDirectory` / `getStatus`, so adding a
channel means adding a service row and changing nothing in the relay. Reply
behaviour and new-session defaults are **configurable per channel**.

| | WeChat | Feishu / Lark |
| --- | --- | --- |
| Binding | QR scan (iLink) | **QR scan that creates the app for you** (Feishu issues the App ID / Secret) |
| Inbound | long polling | long connection (WebSocket, no public URL needed) |
| Typing indicator | one-shot signal → needs a heartbeat | a message reaction, persistent → no heartbeat |
| Outbound limits | conversation window; closed windows need parking | must **reply** to a received message (fresh pushes are refused) |

The WeChat protocol is ported from ZCode's iLink provider
([`zai-org/ZCode`](https://github.com/zai-org/ZCode)
`packages/services/src/bots/providers/weixinProvider.ts` and `weixinRegistration.ts`)
and corrected against eight independent open-source implementations. The Feishu
side follows the same project's `feishuProvider.ts` and `feishuAppRegistration.ts`.

---

## 1. What it does

### Both channels

| Capability | Status |
| --- | --- |
| **Settings page grouped by channel** — one section each, with its own status, binding, reply settings and new-session defaults | ✅ §5 |
| **Per-channel reply behaviour** (`displayMode`, typing indicator, message length) | ✅ §7 |
| **Per-channel new-session defaults** (model, reasoning effort, permission preset) | ✅ §7 |
| **Inbound messages steer the running turn** (`agent.steer` → `next-step`) instead of queueing behind it | ✅ |
| Reuse existing workspaces and conversations (`/workspaces` `/cwd` `/sessions` `/use` `/peek` `/current`) | ✅ §6 |
| One DSH session per contact (`per-peer`), or a shared one | ✅ |
| Slash commands: `/new` `/status` `/stop` `/help` `/model` `/effort` `/permission` | ✅ |
| Allowlists and group policy | ✅ |
| **Approval and question requests mirrored into the chat** — answered from either side, first answer wins | ✅ §6.1 |
| **Every outbound attempt is logged** (`send-log.jsonl`), so a silent failure is still traceable | ✅ §8 |
| **Host compatibility self-check** — a DSH update that drops a capability is visible instead of silent | ✅ §8 |

### WeChat

| Capability | Status |
| --- | --- |
| QR login, long polling, reply delivery | ✅ verified end to end |
| **The "typing" indicator is re-signalled while a turn runs** (`typingRefreshMs`) | ✅ §8 |
| **A reply a closed window refused is parked and delivered on the next inbound message** | ✅ §8 |
| `wechat_send` host tool (the model can start a message) | ✅ |
| Media (AES-128-ECB CDN attachments) | ⚠️ protocol layer only (`src/ilink/media.js`); the channel service does not fetch attachments yet, and the related config keys are reserved |
| Proactive push when nobody has spoken first | ⚠️ see §8, "conversation window" |

### Feishu

| Capability | Status |
| --- | --- |
| **One-click app creation and binding by QR** (Feishu's device-code registration issues the credentials) | ✅ §5.1 |
| Long connection receiving `im.message.receive_v1` | ✅ verified end to end |
| **Replies to the message received** (`/messages/{id}/reply`) | ✅ verified end to end |
| Rich-text (`post`) and `@`-mention parsing | ✅ |
| Typing indicator (message reaction) | ⚠️ needs the reaction scope; degrades silently without it |
| Binding an existing self-built app by hand | ✅ |

---

## 2. Architecture: no `@deepseek-ai/*` imports

DSH loads a plugin through its **realpath** (`link:` points at
`~/.dsh/plugins/<name>`), and there is no `@deepseek-ai` package above that
directory — so an import of a host package cannot resolve. Everything the plugin
needs from the host is read structurally through `ctx.get(...)`, guarded, and
degraded when absent. See [docs/INTERFACES.en.md](docs/INTERFACES.md).

One dependency is deliberate: `@larksuiteoapi/node-sdk`, used only for Feishu's
WebSocket transport. Every Feishu HTTP call is plain `fetch`. The same realpath
rule is why it must be installed **beside** the plugin — see §3.1.

---

## 3. Install

Requires a DSH desktop build that has run once (`~/.dsh/profiles/desktop`
exists), `pnpm`, and Node ≥ 22.

```
plugin_manager install_bundle  target = <this checkout>
```

Or with the script:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install.ps1 -DryRun   # preview
powershell -ExecutionPolicy Bypass -File scripts\install.ps1           # apply
```

The script adds a `link:` dependency to the profile, appends the package to
`dsh.profile.bundles`, and runs `pnpm install`.

> **Restart DSH** afterwards — bundle rows are loaded at startup.
>
> **If you changed `client.js`, also hard-refresh the page (Ctrl+Shift+R).**
> Host-side changes (`src/**`, `cordis.patch.yml`) take effect on restart, but the
> client module is loaded by the browser, and a restart does not make an open tab
> re-fetch it. The symptom is a settings page that is present but missing the card
> you just added.

### 3.1 The Feishu dependency

Feishu's long connection needs `@larksuiteoapi/node-sdk`. **It must be installed
somewhere Node can reach from the plugin's realpath** — the host loads this
plugin through a junction, so resolution walks up from the real directory and
never reaches the profile's `node_modules`.

```powershell
cd <the directory containing this checkout>
npm install @larksuiteoapi/node-sdk --ignore-scripts --prefix <that directory>
```

Two things that cost real time to discover:

- **`--ignore-scripts` is required.** Without it the install fails with
  `EPERM: syscall: 'spawn'`: npm runs package lifecycle scripts through piped
  stdio, which a confined environment forbids. This is *not* a permissions
  problem, however much it looks like one.
- **The dependency cannot go inside the plugin directory** when running confined:
  a child process can write in the workspace root but not in its subdirectories.
  Installing one level up is both allowed and exactly where resolution looks.

If it is missing, the plugin still loads: the Feishu row reports why, and the
WeChat channel is unaffected.

---

## 4. Binding

### WeChat

Settings → **ClawBot 设置** → 微信 → **扫码绑定**, then scan with the WeChat
mobile client. Or from a terminal:

```powershell
node scripts\login.mjs
```

### Feishu

Settings → **ClawBot 设置** → 飞书 → **扫码绑定**, then scan with Feishu. The
platform creates a `PersonalAgent` app and hands back its credentials — no
developer console, no scope ticking, no version to release.

One step is **not** skippable: the app version still has to be **approved and
released** (Feishu admin console → app management → pending apps). An unreleased
app receives events but cannot send messages.

---

## 5. Settings page

One `settings.section`, titled **ClawBot 设置**, containing:

- **所有通道的兜底** — the fallback every channel inherits
- **微信** — status, QR binding, reply settings, new-session defaults, workspaces
- **飞书** — status and one-click binding, reply settings, new-session defaults
- **诊断** — host compatibility, and any replies a closed window is holding

The page keeps **no copy** of any setting: it renders what `GET /status` returns,
and that comes from the same config object the relay reads. Two copies of a value
is how one surface ends up displaying something nobody is using.

---

## 6. Commands

| Command | Effect |
| --- | --- |
| `/new` | Start a fresh session for this contact |
| `/status` | Channel, binding, session, current selection |
| `/stop` | Cancel the running turn |
| `/model`, `/effort` | Switch **this conversation's** model and reasoning effort |
| `/permission` | Switch **this conversation's** permission preset |
| `/workspaces`, `/cwd` | List and switch workspaces |
| `/sessions`, `/use` | List and adopt an existing DSH session |
| `/peek` | Read recent history |
| `/help` | Everything above |

`/model`, `/effort` and `/permission` append the **same session events the GUI
appends**, so the desktop UI follows along — there is no second source of truth.

---

## 7. Configuration

```yaml
displayMode: compact          # the fallback for any channel not listed below
channels:
  wechat-ilink:
    displayMode: quiet        # fewer messages, which WeChat meters
  feishu:
    displayMode: compact
    compactFlushMs: 3000      # no window to conserve, so send sooner
```

Per-channel keys: `displayMode`, `compactFlushMs`, `replyMaxChars`,
`typingIndicator`, `typingRefreshMs`, `provider`, `model`, `reasoningEffort`,
`permissionPreset`. Anything unset falls back to the top-level value, so the
block is optional and additive.

The settings page can only set **defaults for new sessions**; it has no concept
of "the current conversation" because it is global. Precedence is:

```
the conversation's own choice  >  per-channel default  >  top-level default  >  deployment default
```

so a switch made from WeChat is never silently undone by a default.

---

## 8. Things that were learned the hard way

- **A conversation window is short.** WeChat only accepts a send for a few
  minutes after the contact's last message, and the notice that would report a
  refusal travels the same closed channel — so a reply simply vanishes. Replies a
  closed window refused are parked and delivered when the contact next writes.
- **Silence is the default failure mode.** `send-log.jsonl` exists because every
  other diagnostic was invisible: a desktop build writes no log file, so a
  diagnostic that only calls `log()` is a diagnostic nobody can read. The Feishu
  channel's event counters ride the status endpoint for the same reason.
- **A "typing" signal is not always persistent.** WeChat's dies after seconds and
  needs re-signalling; Feishu's is a reaction that stays until deleted, so it
  needs the opposite — an explicit clear at turn end.
- **Sending is not one operation.** Feishu refuses a fresh push with
  `230101 Sending messages to users is temporarily unavailable` even for a
  published, enabled app, while a reply to a received message is always allowed.
- **HTTP 200 is not success.** Feishu returns business refusals with status 200
  and a non-zero `code`; reading the status alone makes a message that was never
  delivered look sent.
- **A host capability read at load time may not be there yet.** The plugin row is
  constructed while DSH is still bringing services up, so the compatibility probe
  runs lazily and re-probes until its answer is complete.
- **Two owners of one value always drift.** Model and permission state live in
  the session log, which both the chat commands and the desktop UI project from.

---

## 9. Verification

| What | How |
| --- | --- |
| Unit and integration tests | Run per file: **459 pass / 0 fail** |
| Live WeChat | QR login, long polling, reply delivery, and a reply refused by a closed window all observed end to end |
| Live Feishu | Event received, session created, reply delivered — verified end to end |
| Frozen contract | `tests/verify/contract.test.mjs` asserts no undeclared bare import, and that every `cordis.patch.yml` row resolves to a loadable module |

---

## 10. License

MIT — see [LICENSE](LICENSE).
