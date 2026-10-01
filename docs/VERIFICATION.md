# Verification status

**中文：** [VERIFICATION.zh-CN.md](VERIFICATION.zh-CN.md)


Conclusions and the evidence for them. Raw payloads and per-run command output are
build-log material and are not published with the repository.
**Anything that was not actually exercised is in §6 and must not be read as
passing.**

---

## 1. Summary

| Area | Result |
| --- | --- |
| Unit and integration tests | ✅ **459 pass / 0 fail** (run per file) |
| WeChat, live | ✅ QR login, long-poll receive, reply delivery — all observed |
| Feishu, live | ✅ event received, session created, reply delivered — all observed |
| Frozen contract | ✅ no undeclared bare import; every `cordis.patch.yml` row resolves to a loadable module |
| Hand-written QR encoder | ✅ cross-checked by an independent decoder (jsQR) |
| Host capabilities | ✅ all 13 available (`hostCompat` in `/wechat-ilink/api/status`) |

---

## 2. Test execution

Run per file — under a confined environment `node --test` cannot run at all
(`spawn EPERM`):

```powershell
Get-ChildItem -Path tests -Recurse -Filter '*.test.mjs' |
  ForEach-Object { node $_.FullName }
```

| File | Cases | Covers |
| --- | --- | --- |
| `tests/bridge.test.mjs` | 175 | relay: channel routing, sessions, commands, decision cards, per-channel settings, host self-check |
| `tests/ilink.test.mjs` | 110 | iLink protocol, QR, attachments, storage, long polling |
| `tests/web.test.mjs` | 60 | web API, settings read/write, QR rendering, Feishu routes, client rendering |
| `tests/feishu.test.mjs` | 50 | Feishu protocol, inbound parsing, QR registration, channel service |
| `tests/verify/edge.test.mjs` | 25 | boundaries and degradation |
| `tests/verify/contract.test.mjs` | 10 | frozen contract, manifest, row resolution |
| `tests/verify/qr.test.mjs` | 5 | QR encoder (jsQR cross-check) |
| remaining | 24 | host integration, HTTP, configuration |

---

## 3. WeChat, live

| Step | Evidence |
| --- | --- |
| Pre-login probe | `scripts/probe-ilink.mjs` returns a real QR code, `get_qrcode_status=pending` |
| QR login | the phone confirmation writes credentials and long polling starts |
| Receiving | `getupdates` returns a real cursor, persisted across restarts |
| Reply delivery | a send with the contact's `context_token` returns `ret:0` |
| Closed window | `ret:-2` / `prepare failed` was observed, and is what the park-and-deliver behaviour was built for |
| Typing indicator | observed staying lit for a two-minute turn |

**`send-log.jsonl` is the most valuable thing this path produced.** A send refused
because the window had closed used to be *completely silent* — from the contact's
side, the bot simply stopped talking.

---

## 4. Feishu, live

| Step | Evidence |
| --- | --- |
| One-click app creation | the QR scan made Feishu issue `client_id` / `client_secret` |
| Long connection | event subscription set to "long connection", no public URL required |
| Event received | `events.received` in `/feishu/status` increments |
| Session created | a new session appears on the DSH side |
| Reply delivered | the Feishu client shows the reply, and `send-log.jsonl` records `ok:true` |

### Feishu behaviours established while debugging (all measured)

| Symptom | Conclusion |
| --- | --- |
| `code=230101 Sending messages to users is temporarily unavailable` | **fresh pushes are restricted; replies are allowed.** A reply must go through `/messages/{id}/reply` |
| HTTP 200 with a non-zero `code` | a business refusal hides inside a success status; reading the status alone reports an undelivered message as sent |
| Event arrives, nothing happens | the event must be handed to the relay with **`ctx.emit`**; a local callback is never invoked |
| `status: 1` | **this means published** — this project once misread the enum as "under review" |
| Rich-text message | arrives as `message_type: "post"`; reading only `content.text` yields an empty string, which is then discarded |

---

## 5. Frozen contract checks

- **No undeclared bare import**: `tests/verify/contract.test.mjs` walks `src/**` and
  permits only `node:*`, relative paths, and `@larksuiteoapi/node-sdk` — which must
  itself be a declared dependency.
- **Every row loads**: the three `cordis.patch.yml` rows (`wechat-ilink`, `feishu`,
  `wechat-ilink-bridge`) each resolve to a module exporting `apply` and a plugin name.
- **Host capabilities**: all 13 available; a missing one degrades and **never makes
  the plugin fail to load**.

---

## 6. Not verified — **do not read these as passing**

| Item | Note |
| --- | --- |
| WeChat media (images, voice) | protocol layer only (`src/ilink/media.js`) with unit tests; the channel service does not fetch attachments yet and the related config keys are reserved |
| Feishu typing indicator | the reaction needs an extra scope; it degrades silently, and the **success path was not observed live** |
| Feishu group chats | parsing handles it (`chat_id`, `@` mentions); **not exercised** |
| Proactive push with nobody having spoken first | WeChat is limited by the conversation window, Feishu by `230101` |
| Multiple accounts | config keys reserved, not implemented |
| Feishu international (Lark) | supported in code (`domain: lark`), **not exercised** |

---

## 7. Reproduction

```powershell
# Full suite, per file
Get-ChildItem -Path tests -Recurse -Filter '*.test.mjs' |
  ForEach-Object { node $_.FullName }

# Live iLink probe (needs network; Node 24 needs NODE_USE_ENV_PROXY)
node scripts\probe-ilink.mjs
node scripts\live-check.mjs

# Install dry-run
powershell -ExecutionPolicy Bypass -File scripts\install.ps1 -DryRun

# Host status (while DSH is running)
curl http://127.0.0.1:19387/wechat-ilink/api/status
curl http://127.0.0.1:19387/wechat-ilink/api/feishu/status
```
