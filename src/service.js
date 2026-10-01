/**
 * `wechat-ilink` — the WeChat (iLink ClawBot) channel service.
 *
 * Owns the account connection: the inbound long poll, the outbound send path,
 * the typing indicator, and the `wechat-ilink/message` event other rows consume.
 *
 * Deliberately a *functional* Cordis plugin with **zero `@deepseek-ai/*`
 * imports**: a third-party plugin cannot resolve those packages from its
 * realpath, and a failed import would take the whole bundle row down. Every
 * host service is read through `ctx.get(...)` and degrades when absent. See
 * docs/INTERFACES.md §2.0.
 *
 * The live instance is published through `../registry.js`, because the bridge
 * row must not depend on Cordis service lookup either.
 *
 * @module wechat-feishu-linker/service
 */

import fs from 'node:fs'
import path from 'node:path'

import { withDefaults } from './config.js'
import { HostAccess } from './bridge/host.js'
import { registerWechatSendTool } from './bridge/tool.js'
import { clearService, getService, setService } from './registry.js'
import { mountWebApi } from './web/index.js'

export const name = 'wechat-ilink'

/**
 * No hard service dependencies: the channel works without `tools` /
 * `systemPrompt` (the `wechat_send` tool and its prompt guidance are simply
 * skipped), and a hard `inject` would turn a missing optional service into a
 * plugin load failure.
 */
export const inject = []

/**
 * Memoized protocol-layer import.
 *
 * The barrel is imported lazily (rather than statically) so this module — and
 * therefore the plugin entry — stays importable when the protocol layer is
 * absent, and so tests can inject a fake protocol layer through
 * {@link apply}'s `deps`. The specifier is the frozen barrel from
 * docs/INTERFACES.md §3.7.
 *
 * @type {Promise<object> | undefined}
 */
let ilinkModule

/**
 * @returns {Promise<object>} the protocol-layer barrel.
 */
function loadIlink() {
  ilinkModule ??= import('./ilink/index.js')
  return ilinkModule
}

/**
 * The WeChat channel: one bot account, one long poll, one send path.
 *
 * Constructed by {@link apply}; also directly constructible in tests with
 * injected protocol factories.
 */
export class WechatIlinkChannel {
  /** @type {Set<(message: object) => void>} */
  #handlers = new Set()
  /** @type {boolean} whether the persisted default target has been read. */
  #targetLoaded = false

  /**
   * @param {object} options - construction inputs.
   * @param {object} options.ctx - plugin context (used for `emit`).
   * @param {object} options.config - resolved service config.
   * @param {object} [options.deps] - protocol factories / test seams.
   * @param {(level: string, message: string) => void} [options.log] - logger.
   */
  constructor({ ctx, config, deps = {}, log }) {
    this.ctx = ctx
    this.config = config
    this.deps = deps
    this.log = log ?? (() => {})
    /** @type {object | undefined} */ this.ilink = deps.ilink
    /** @type {object | undefined} */ this.store = undefined
    /** @type {object | undefined} */ this.account = undefined
    /** @type {object | undefined} */ this.client = deps.client
    /** @type {{ stop: Function, done: Promise<void> } | undefined} */ this.poll = undefined
    /** @type {AbortController | undefined} */ this.controller = undefined
    /** @type {string | undefined} */ this.dataDir = deps.dataDirectory
    /** Guarded read-only host access (workspaces / existing sessions). */
    this.host = deps.host ?? new HostAccess({ ctx, log: this.log })
    /** @type {{ workspace?: string, sessionId?: string } | undefined} UI-bound default target. */
    this.target = undefined
    /** @type {string | undefined} last surfaced failure (never contains the token). */
    this.lastError = undefined
    this.started = false
    this.stopped = false
    this.#targetLoaded = false
  }

  /** The resolved data directory backing this channel (bridge session memo). */
  get dataDirectory() {
    return this.dataDir
  }

  /** Whether an inbound long poll is currently running. */
  get connected() {
    return Boolean(this.poll)
  }

  /** Whether the inbound long poll is running (the Web UI probes this name). */
  get polling() {
    return this.connected
  }

  /** The connected account id, when one was loaded. */
  get accountId() {
    const value =
      this.account?.accountId ??
      this.account?.botId ??
      this.account?.bot_id ??
      this.account?.userId ??
      this.account?.user_id
    return typeof value === 'string' && value ? value : 'default'
  }

  /**
   * The bot's own iLink user id, used as the bridge's echo guard and as
   * `msg.from_user_id` on every send.
   *
   * `scripts/login.mjs` stores `{ accountId, botToken, botId, savedAt }`, so
   * the bot id is the only identity available; an explicit user id wins when a
   * future login flow records one.
   */
  get selfUserId() {
    const value =
      this.account?.userId ??
      this.account?.user_id ??
      this.account?.fromUserId ??
      this.account?.botId ??
      this.account?.bot_id ??
      ''
    return typeof value === 'string' ? value.trim() : ''
  }

  /**
   * The stored bot token, tolerating both the login script's `botToken` and
   * the protocol layer's `token`/`bot_token` spellings.
   *
   * @returns {string} the token, or `''`.
   */
  get token() {
    const value = this.account?.botToken ?? this.account?.token ?? this.account?.bot_token
    return typeof value === 'string' ? value.trim() : ''
  }

  /**
   * A diagnostic snapshot for `/status` and the settings surface.
   *
   * Never contains the bot token or any other credential: this value is served
   * to the Web UI and rendered into WeChat replies.
   *
   * @returns {{ bound: boolean, botId: string | undefined, accountId: string, connected: boolean,
   *   polling: boolean, lastError: string | undefined, hasToken: boolean, dataDirectory: string | undefined }} the status.
   */
  getStatus() {
    return {
      bound: Boolean(this.getTarget()),
      botId: this.selfUserId || undefined,
      accountId: this.accountId,
      connected: this.connected,
      polling: Boolean(this.poll),
      lastError: this.lastError,
      hasToken: this.token !== '',
      dataDirectory: this.dataDir,
    }
  }

  /**
   * The deployment-level target the UI bound (workspace and/or session).
   *
   * Read lazily from `<dataDir>/target.json` so the Web UI and the bridge row
   * agree across restarts.
   *
   * @returns {{ workspace?: string, sessionId?: string } | undefined} the target.
   */
  getTarget() {
    if (!this.#targetLoaded) {
      this.#targetLoaded = true
      this.target = readTargetFile(this.dataDir)
    }
    return this.target
  }

  /**
   * Bind the deployment default workspace and/or session (Web UI, `/cwd`).
   *
   * Validates the workspace through the host when it can, and persists the
   * result so a restart keeps the binding. Never throws.
   *
   * @param {{ workspace?: string, sessionId?: string }} [target] - the target to bind.
   * @returns {Promise<{ available: boolean, ok: boolean, target?: object, persisted?: boolean, reason?: string }>} the outcome.
   */
  async bindTarget(target = {}) {
    const next = {}
    if (typeof target.workspace === 'string' && target.workspace.trim() !== '') next.workspace = target.workspace.trim()
    if (typeof target.sessionId === 'string' && target.sessionId.trim() !== '') next.sessionId = target.sessionId.trim()
    if (Object.keys(next).length === 0) {
      return { available: true, ok: false, reason: 'empty-target', message: '请至少提供 workspace 或 sessionId' }
    }
    if (next.workspace) {
      const resolved = await this.host.ensureWorkspace(next.workspace)
      if (!resolved.ok) {
        return {
          available: true,
          ok: false,
          reason: resolved.reason,
          message: `工作区不可用（${resolved.reason ?? '未知原因'}）`,
        }
      }
    }
    if (next.sessionId) {
      const listing = await this.host.listSessions({ limit: 500 })
      if (listing.available && !listing.items.some((item) => item.id === next.sessionId)) {
        return { available: true, ok: false, reason: 'session-not-found', message: `未找到会话 ${next.sessionId}` }
      }
    }
    this.target = { ...(this.getTarget() ?? {}), ...next }
    const persisted = this.#persistTarget()
    this.log('info', `wechat-ilink: default target bound (${JSON.stringify(this.target)})`)
    return {
      available: true,
      ok: true,
      workspace: this.target.workspace,
      sessionId: this.target.sessionId,
      target: { ...this.target },
      persisted,
      message: '已绑定',
    }
  }

  /**
   * Aliases the host Web UI probes by duck typing (`bind` / `setBinding` /
   * `selectBinding`). Kept as thin delegations so one implementation owns the
   * behaviour.
   *
   * @param {{ workspace?: string, sessionId?: string }} [target] - the target to bind.
   * @returns {Promise<object>} the {@link bindTarget} outcome.
   */
  bind(target) {
    return this.bindTarget(target)
  }

  /** @param {{ workspace?: string, sessionId?: string }} [target] - the target to bind. */
  setBinding(target) {
    return this.bindTarget(target)
  }

  /** @param {{ workspace?: string, sessionId?: string }} [target] - the target to bind. */
  selectBinding(target) {
    return this.bindTarget(target)
  }

  /**
   * Persist the default target; a disk failure only costs continuity.
   *
   * @returns {boolean} true when the file was written.
   */
  #persistTarget() {
    if (!this.dataDir) return false
    try {
      fs.mkdirSync(this.dataDir, { recursive: true })
      fs.writeFileSync(
        path.join(this.dataDir, 'target.json'),
        `${JSON.stringify(this.target ?? {}, null, 2)}\n`,
        'utf-8',
      )
      return true
    } catch (error) {
      this.log('warn', `wechat-ilink: could not persist the default target: ${String(error)}`)
      return false
    }
  }

  /**
   * List the host's registered workspaces (Web UI panel).
   *
   * @returns {{ available: boolean, items: Array<object>, reason?: string }} the listing.
   */
  listWorkspaces() {
    return this.host.listWorkspaces()
  }

  /**
   * Alias the host Web UI probes by duck typing.
   *
   * @returns {{ available: boolean, items: Array<object>, reason?: string }} the listing.
   */
  getWorkspaces() {
    return this.listWorkspaces()
  }

  /**
   * List existing DSH sessions (Web UI panel).
   *
   * @param {{ limit?: number, workspace?: string }} [options] - filters.
   * @returns {Promise<{ available: boolean, items: Array<object>, reason?: string }>} the listing.
   */
  async listSessions(options = {}) {
    const limit = Number.isFinite(options.limit) && options.limit > 0 ? options.limit : 20
    const result = await this.host.listSessions({ limit, workspacePath: options.workspace })
    return { available: result.available, items: result.items, ...(result.reason ? { reason: result.reason } : {}) }
  }

  /**
   * Alias the host Web UI probes by duck typing.
   *
   * @param {{ limit?: number, workspace?: string }} [options] - filters.
   * @returns {Promise<{ available: boolean, items: Array<object>, reason?: string }>} the listing.
   */
  getSessions(options) {
    return this.listSessions(options)
  }

  /**
   * Read the recent conversation of one session (Web UI panel).
   *
   * @param {string} sessionId - session id.
   * @param {number} [limit] - maximum entries.
   * @returns {Promise<{ available: boolean, items: Array<object>, reason?: string }>} the history.
   */
  async readSessionHistory(sessionId, limit) {
    const result = await this.host.readHistory(sessionId, limit)
    return { available: result.available, items: result.items, ...(result.reason ? { reason: result.reason } : {}) }
  }

  /**
   * Start the QR login flow (Web UI).
   *
   * @returns {Promise<{ available: boolean, ok: boolean, qrcode?: string, qrUrl?: string, expiresAt?: number, reason?: string, message?: string }>} the QR challenge.
   */
  async beginLogin() {
    try {
      const ilink = await this.#protocol()
      if (typeof ilink.beginLogin !== 'function') return { available: false, ok: false, reason: 'login-unavailable' }
      const qr = await ilink.beginLogin({ baseUrl: this.config.baseUrl })
      this.lastError = undefined
      return {
        available: true,
        ok: true,
        qrcode: qr?.qrcode,
        qrUrl: qr?.qrUrl,
        expiresAt: qr?.expiresAt,
      }
    } catch (error) {
      this.lastError = `login: ${String(error)}`
      this.log('warn', `wechat-ilink: beginLogin failed: ${String(error)}`)
      return { available: true, ok: false, reason: 'login-failed', message: String(error) }
    }
  }

  /**
   * Poll one QR login attempt, storing the credentials on success and
   * reconnecting the channel (Web UI).
   *
   * @param {string} qrcode - the challenge id from {@link beginLogin}.
   * @returns {Promise<{ available: boolean, ok: boolean, status?: string, botId?: string, reason?: string, message?: string }>} the poll result.
   */
  async pollLogin(qrcode) {
    if (typeof qrcode !== 'string' || qrcode === '') return { available: true, ok: false, reason: 'missing-qrcode' }
    try {
      const ilink = await this.#protocol()
      if (typeof ilink.pollLogin !== 'function') return { available: false, ok: false, reason: 'login-unavailable' }
      const result = await ilink.pollLogin({ qrcode, baseUrl: this.config.baseUrl })
      if (result?.status !== 'success') {
        return { available: true, ok: true, status: result?.status ?? 'pending' }
      }
      // A `success` without a credential is not a success. Reporting one here
      // made the UI say 「绑定成功」 for a bind that had stored nothing, which is
      // exactly the state the contact then discovers on the next restart.
      const botToken = typeof result.botToken === 'string' ? result.botToken : ''
      if (!botToken) {
        return { available: true, ok: false, reason: 'missing-credential', message: '登录成功但没有拿到凭据，请重新扫码' }
      }
      const account = {
        accountId: result.botId || 'default',
        botToken,
        botId: result.botId,
        savedAt: new Date().toISOString(),
      }
      if (this.dataDir) {
        try {
          const store = await this.#accountStore(ilink)
          await store.save(account)
        } catch (error) {
          // Swallowing this is what let a bind report success while the
          // credential never reached the disk: the channel would run until the
          // next restart and then be unbound again. Fail loudly instead.
          this.lastError = `login persist: ${String(error)}`
          this.log('warn', `wechat-ilink: could not persist the new credentials: ${String(error)}`)
          return {
            available: true,
            ok: false,
            reason: 'persist-failed',
            message: `凭据写入失败，未完成绑定：${String(error)}`,
          }
        }
      }
      this.account = account
      this.client = this.#createClient(ilink, account)
      this.lastError = undefined
      // Reconnect with the fresh credentials.
      await this.stop()
      this.started = false
      this.stopped = false
      void this.start().catch((error) => {
        this.log('warn', `wechat-ilink: reconnect after login failed: ${String(error)}`)
      })
      return { available: true, ok: true, status: 'success', botId: result.botId }
    } catch (error) {
      this.lastError = `login poll: ${String(error)}`
      this.log('warn', `wechat-ilink: pollLogin failed: ${String(error)}`)
      return { available: true, ok: false, reason: 'login-poll-failed', message: String(error) }
    }
  }

  /**
   * Log out: stop polling, drop the stored credentials and the live client
   * (Web UI). The row stays mounted and can log in again.
   *
   * @returns {Promise<{ available: boolean, ok: boolean, reason?: string }>} the outcome.
   */
  async logout() {
    await this.stop()
    this.account = undefined
    this.client = undefined
    this.started = false
    this.stopped = false
    this.lastError = undefined
    try {
      const ilink = await this.#protocol()
      const store = await this.#accountStore(ilink)
      await store.clear()
    } catch (error) {
      this.log('warn', `wechat-ilink: could not clear the stored account: ${String(error)}`)
      return { available: true, ok: false, reason: 'logout-clear-failed', message: String(error) }
    }
    this.log('info', 'wechat-ilink: logged out')
    return { available: true, ok: true }
  }

  /**
   * Subscribe to normalized inbound messages without going through Cordis.
   *
   * @param {(message: object) => void} handler - called for every inbound message.
   * @returns {() => void} disposer removing the handler.
   */
  onMessage(handler) {
    this.#handlers.add(handler)
    return () => this.#handlers.delete(handler)
  }

  /**
   * Resolve the protocol layer (injected fake, or the real barrel).
   *
   * @returns {Promise<object>} the protocol layer.
   */
  async #protocol() {
    if (!this.ilink) this.ilink = this.deps.ilink ?? (await loadIlink())
    return this.ilink
  }

  /**
   * Resolve the account store.
   *
   * @param {object} ilink - protocol layer.
   * @returns {Promise<object>} the store.
   */
  async #accountStore(ilink) {
    if (this.store) return this.store
    if (typeof this.deps.storeFactory === 'function') {
      this.store = this.deps.storeFactory({ dataDir: this.dataDir, config: this.config, ilink })
      return this.store
    }
    this.store = ilink.createAccountStore({ dataDir: this.dataDir })
    return this.store
  }

  /**
   * Resolve the outbound client, loading the stored account on first use.
   *
   * `sendText`/`sendTyping` work without {@link start} (proactive sends), so
   * the client is created lazily and cached.
   *
   * @returns {Promise<object>} the iLink client.
   * @throws when no stored account carries a token.
   */
  async #requireClient() {
    if (this.client) return this.client
    const ilink = await this.#protocol()
    if (!this.dataDir) {
      this.dataDir = this.deps.dataDirectory ?? ilink.resolveDataDir(this.config)
    }
    const store = await this.#accountStore(ilink)
    const account = await store.load()
    if (!this.#tokenOf(account)) {
      throw new Error('wechat-ilink: no stored account/token; run the login flow first')
    }
    this.account = account
    this.client = this.#createClient(ilink, account)
    return this.client
  }

  /**
   * Read the bot token from an account record.
   *
   * @param {object | null | undefined} account - stored account.
   * @returns {string} the token, or `''`.
   */
  #tokenOf(account) {
    const value = account?.botToken ?? account?.token ?? account?.bot_token
    return typeof value === 'string' ? value.trim() : ''
  }

  /**
   * Build the iLink client for one account.
   *
   * @param {object} ilink - protocol layer.
   * @param {object} account - stored account.
   * @returns {object} the client.
   */
  #createClient(ilink, account) {
    const baseUrl =
      (typeof account.baseUrl === 'string' && account.baseUrl) ||
      (typeof account.base_url === 'string' && account.base_url) ||
      this.config.baseUrl
    const options = {
      token: this.#tokenOf(account),
      baseUrl,
      requestTimeoutMs: this.config.requestTimeoutMs,
      // Forwarded so a protocol layer that learns to honour it does so without
      // another bridge change; `withPollTimeout` enforces it today.
      pollTimeoutMs: this.pollTimeoutMs,
      // `msg.from_user_id` must be present (an empty string is valid but must
      // be explicit) or the gateway can accept the call without delivering it.
      fromUserId: typeof account.fromUserId === 'string' ? account.fromUserId : this.selfUserId,
      logger: { warn: (message) => this.log('warn', String(message)) },
    }
    const raw = typeof this.deps.clientFactory === 'function' ? this.deps.clientFactory(options) : ilink.createIlinkClient(options)
    // `lastError` used to latch: the poll loop reports every failure and nothing
    // reported recovery, so the status card kept showing an error that had
    // already healed (a transient `-14`, a socket blip). A server-confirmed
    // `getUpdates` proves the credential and the transport both work again, so
    // it is the recovery signal. Wrapped INSIDE `withPollTimeout` on purpose: a
    // synthesized idle cycle is not a server response and must not clear it.
    return withPollTimeout(
      withHealthSignal(raw, () => {
        this.lastError = undefined
      }),
      this.pollTimeoutMs,
    )
  }

  /** The configured long-poll window, or `undefined` when unset/invalid. */
  get pollTimeoutMs() {
    const value = this.config?.pollTimeoutMs
    return Number.isFinite(value) && value > 0 ? value : undefined
  }

  /**
   * Start the channel: load the stored account and open the inbound long poll.
   *
   * Never throws. A missing token is a normal state (the operator has not run
   * the login flow yet) and is logged, not raised: failing here would take the
   * whole plugin row down.
   *
   * @returns {Promise<boolean>} true when a poll loop was started.
   */
  async start() {
    if (this.started) return this.connected
    this.started = true
    let ilink
    try {
      ilink = await this.#protocol()
      if (!this.dataDir) {
        this.dataDir = this.deps.dataDirectory ?? ilink.resolveDataDir(this.config)
      }
    } catch (error) {
      this.log(
        'warn',
        `wechat-ilink: protocol layer unavailable (${String(error)}); inbound polling disabled`,
      )
      this.lastError = `protocol: ${String(error)}`
      return false
    }
    let account
    try {
      const store = await this.#accountStore(ilink)
      account = await store.load()
    } catch (error) {
      this.log('error', `wechat-ilink: could not read the stored account: ${String(error)}`)
      this.lastError = `account: ${String(error)}`
      return false
    }
    if (!this.#tokenOf(account)) {
      this.log('warn', 'wechat-ilink: no stored account; run scripts/login.mjs before inbound messages can arrive')
      return false
    }
    this.account = account
    this.client = this.#createClient(ilink, account)
    const controller = new AbortController()
    this.controller = controller
    const bufKey = this.accountId
    const startPollLoop = typeof this.deps.pollFactory === 'function' ? this.deps.pollFactory : ilink.startPollLoop
    try {
      this.poll = startPollLoop({
        client: this.client,
        getBuf: () => this.store.readBuf(bufKey),
        setBuf: (buf) => this.store.writeBuf(bufKey, buf),
        onMessages: (messages) => this.ingest(messages),
        onError: (error) => {
          this.log('warn', `wechat-ilink: poll error: ${String(error)}`)
          this.lastError = `poll: ${String(error)}`
          try {
            this.ctx?.emit?.('wechat-ilink/error', { message: String(error) })
          } catch {
            // An emit failure must not kill the poll loop.
          }
        },
        signal: controller.signal,
        logger: { warn: (message) => this.log('warn', String(message)) },
        ...(Number.isFinite(this.deps.backoffMs) ? { backoffMs: this.deps.backoffMs } : {}),
      })
    } catch (error) {
      this.log('error', `wechat-ilink: could not start the inbound poll: ${String(error)}`)
      this.lastError = `poll-start: ${String(error)}`
      this.poll = undefined
      return false
    }
    this.lastError = undefined
    this.log('info', `wechat-ilink: connected as ${this.accountId}`)
    return true
  }

  /**
   * Stop the inbound long poll and wait for it to drain.
   *
   * @returns {Promise<void>} resolves once the loop has settled.
   */
  async stop() {
    if (this.stopped) return
    this.stopped = true
    try {
      this.controller?.abort()
    } catch {
      // Aborting a finished controller is a no-op.
    }
    const poll = this.poll
    this.poll = undefined
    this.controller = undefined
    if (poll) {
      try {
        poll.stop?.()
      } catch (error) {
        this.log('warn', `wechat-ilink: poll stop failed: ${String(error)}`)
      }
      try {
        await poll.done
      } catch (error) {
        this.log('warn', `wechat-ilink: poll loop ended with an error: ${String(error)}`)
      }
    }
  }

  /**
   * Normalize and publish a batch of raw inbound messages.
   *
   * One malformed element never discards the batch.
   *
   * @param {unknown} batch - raw messages array, or a raw `getupdates` payload.
   * @returns {number} the number of messages published.
   */
  ingest(batch) {
    const ilink = this.ilink
    if (!ilink) {
      this.log('warn', 'wechat-ilink: inbound batch dropped — protocol layer not loaded')
      return 0
    }
    let list
    try {
      list = Array.isArray(batch) ? batch : ilink.readRawMessages(batch)
    } catch (error) {
      this.log('warn', `wechat-ilink: could not read the inbound batch: ${String(error)}`)
      return 0
    }
    if (!Array.isArray(list)) return 0
    let published = 0
    for (const raw of list) {
      try {
        if (this.#ingestOne(raw, ilink)) published += 1
      } catch (error) {
        this.log('warn', `wechat-ilink: dropping malformed inbound message: ${String(error)}`)
      }
    }
    return published
  }

  /**
   * Normalize and publish one raw inbound message.
   *
   * @param {unknown} raw - one element of `getupdates`.
   * @param {object} ilink - protocol layer.
   * @returns {boolean} true when the message was published.
   */
  #ingestOne(raw, ilink) {
    if (!raw || typeof raw !== 'object') return false
    // Protocol-level echo guard. `normalizeInboundMessage` also drops these;
    // checking here keeps a normalize regression from starting a self-loop.
    const messageType = raw.message_type ?? raw.messageType
    if (Number(messageType) === 2) return false
    const normalized = ilink.normalizeInboundMessage(raw)
    if (!normalized) return false
    const fromUserId = typeof normalized.fromUserId === 'string' ? normalized.fromUserId.trim() : ''
    if (!fromUserId) return false
    const selfUserId = this.selfUserId
    if (selfUserId && selfUserId === fromUserId) return false
    const groupId = raw.group_id ?? raw.groupId
    const message = {
      accountId: this.accountId,
      fromUserId,
      ...(selfUserId ? { selfUserId } : {}),
      text: typeof normalized.text === 'string' ? normalized.text : '',
      itemTypes: Array.isArray(normalized.itemTypes) ? normalized.itemTypes : [],
      attachments: Array.isArray(normalized.attachments) ? normalized.attachments : [],
      createdAt: Date.now(),
      ...(typeof normalized.contextToken === 'string' && normalized.contextToken
        ? { contextToken: normalized.contextToken }
        : {}),
      ...(typeof normalized.messageId === 'string' && normalized.messageId
        ? { messageId: normalized.messageId }
        : {}),
      ...(typeof groupId === 'string' && groupId ? { groupId } : {}),
    }
    for (const handler of this.#handlers) {
      try {
        handler(message)
      } catch (error) {
        this.log('warn', `wechat-ilink: message handler failed: ${String(error)}`)
      }
    }
    try {
      this.ctx?.emit?.('wechat-ilink/message', message)
    } catch (error) {
      this.log('warn', `wechat-ilink: could not emit wechat-ilink/message: ${String(error)}`)
    }
    return true
  }

  /**
   * Send text to a WeChat peer, chunking long text.
   *
   * @param {string} toUserId - target peer id.
   * @param {string} text - message body.
   * @param {{ contextToken?: string, maxChars?: number }} [opts] - send options.
   * @returns {Promise<{ messageIds: string[], chunkCount: number }>} send result.
   * @throws when the target, the text, or the stored account is missing.
   */
  async sendText(toUserId, text, opts = {}) {
    const peerId = typeof toUserId === 'string' ? toUserId.trim() : ''
    if (!peerId) throw new Error('wechat-ilink: sendText requires a target user id')
    const body = typeof text === 'string' ? text : ''
    if (!body.trim()) throw new Error('wechat-ilink: sendText requires non-empty text')
    const client = await this.#requireClient()
    const ilink = await this.#protocol()
    const maxChars =
      Number.isFinite(opts?.maxChars) && opts.maxChars > 0
        ? opts.maxChars
        : Number.isFinite(this.config.maxMessageLength) && this.config.maxMessageLength > 0
          ? this.config.maxMessageLength
          : 1_800
    const chunks = ilink.chunkText(ilink.normalizeOutboundText(body), maxChars)
    const messageIds = []
    for (const chunk of chunks) {
      const response = await client.sendMessage({
        toUserId: peerId,
        text: chunk,
        ...(typeof opts?.contextToken === 'string' && opts.contextToken
          ? { contextToken: opts.contextToken }
          : {}),
      })
      const id = extractMessageId(response)
      if (id) messageIds.push(id)
    }
    return { messageIds, chunkCount: chunks.length }
  }

  /**
   * Push the native "正在输入" indicator. Best-effort: never throws.
   *
   * @param {string} toUserId - target peer id.
   * @param {string} [contextToken] - the peer's latest context token.
   * @returns {Promise<boolean>} true when the indicator was accepted.
   */
  async sendTyping(toUserId, contextToken) {
    const peerId = typeof toUserId === 'string' ? toUserId.trim() : ''
    if (!peerId) return false
    try {
      const client = await this.#requireClient()
      return Boolean(
        await client.sendTyping({
          toUserId: peerId,
          ...(typeof contextToken === 'string' && contextToken ? { contextToken } : {}),
        }),
      )
    } catch (error) {
      this.log('warn', `wechat-ilink: sendtyping for ${peerId} failed: ${String(error)}`)
      return false
    }
  }
}

/**
 * Read a message id out of a `sendmessage` response.
 *
 * The gateway's response shape is not contractually fixed, so every plausible
 * field is tried; an unknown shape simply yields no id (the send still
 * happened).
 *
 * @param {unknown} response - raw response.
 * @returns {string} the id, or `''`.
 */
function extractMessageId(response) {
  if (!response || typeof response !== 'object') return ''
  const candidates = [
    response.message_id,
    response.messageId,
    response.msg_id,
    response.msgId,
    response.msg?.message_id,
    response.msg?.messageId,
    response.data?.message_id,
  ]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate) return candidate
  }
  return ''
}

/**
 * Read the persisted default target.
 *
 * @param {string | undefined} dataDir - the channel's data directory.
 * @returns {{ workspace?: string, sessionId?: string } | undefined} the target, or undefined.
 */
function readTargetFile(dataDir) {
  if (typeof dataDir !== 'string' || dataDir === '') return undefined
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dataDir, 'target.json'), 'utf-8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    const target = {}
    if (typeof parsed.workspace === 'string' && parsed.workspace !== '') target.workspace = parsed.workspace
    if (typeof parsed.sessionId === 'string' && parsed.sessionId !== '') target.sessionId = parsed.sessionId
    return Object.keys(target).length > 0 ? target : undefined
  } catch {
    return undefined
  }
}

/**
 * Report recovery when a long poll actually reaches the server.
 *
 * The poll loop has exactly one error sink (`onError`) and no success sink, so a
 * service that only listens for failures can never learn that a transient one
 * healed. This adapter supplies the missing edge: `onHealthy` runs after every
 * `getUpdates` that the *server* answered, and never after a synthesized idle
 * cycle or a transport failure.
 *
 * @param {object} client - the protocol client (or a test fake).
 * @param {() => void} onHealthy - called after each server-confirmed poll.
 * @returns {object} the client, or a wrapper reporting recovery.
 */
export function withHealthSignal(client, onHealthy) {
  if (!client || typeof client.getUpdates !== 'function') return client
  if (typeof onHealthy !== 'function') return client
  const wrapper = Object.create(client)
  wrapper.getUpdates = async (options = {}) => {
    const result = await client.getUpdates(options)
    try {
      onHealthy()
    } catch {
      // A health observer must never break the poll it observes.
    }
    return result
  }
  return wrapper
}

/**
 * Enforce the configured long-poll window on a client.
 *
 * `pollTimeoutMs` used to be a dead config key: the frozen protocol layer
 * hard-codes its own 45 s `/getupdates` timeout and accepts no override, so an
 * operator setting `pollTimeoutMs` saw no effect at all. This adapter makes
 * the key real without touching `src/ilink/**`: the long poll is bounded by an
 * outer deadline, and *expiry of that window is treated as an idle cycle*, not
 * as a failure — the poll loop must re-poll immediately with the same cursor
 * rather than back off, or the bot would grow sluggish after every quiet
 * period.
 *
 * The three exit paths are deliberately distinct, because collapsing them
 * hides real network faults:
 *  1. the caller's `signal` aborted → propagate (the loop is shutting down);
 *  2. *this* deadline expired → idle cycle, same cursor, no backoff;
 *  3. anything else — the client's own transport timeout, a socket error, an
 *     HTTP failure → propagate, so `startPollLoop` reports it through
 *     `onError` and backs off.
 *
 * Residual limitation (protocol layer, not fixable here): the client's own
 * 45 s ceiling still applies to the underlying HTTP request, so a
 * `pollTimeoutMs` above 45 s cannot extend a single request beyond that; that
 * case surfaces as path 3 and is reported rather than silently misrepresented.
 *
 * @param {object} client - the protocol client (or a test fake).
 * @param {number | undefined} pollTimeoutMs - configured window, in ms.
 * @returns {object} the client, or a wrapper enforcing the window.
 */
export function withPollTimeout(client, pollTimeoutMs) {
  if (!Number.isFinite(pollTimeoutMs) || pollTimeoutMs <= 0) return client
  if (!client || typeof client.getUpdates !== 'function') return client
  const wrapper = Object.create(client)
  wrapper.getUpdates = async (options = {}) => {
    const { buf = '', signal } = options
    const deadline = new AbortController()
    const timer = setTimeout(() => deadline.abort(), pollTimeoutMs)
    const combined = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal
    try {
      return await client.getUpdates({ buf, signal: combined })
    } catch (error) {
      // 1) The poll loop is stopping: never mask it as an idle cycle.
      if (signal?.aborted) throw error
      // 2) Our configured window elapsed with no traffic: a normal idle poll.
      if (deadline.signal.aborted) {
        return {
          rawMessages: [],
          buf: typeof buf === 'string' ? buf : '',
          payload: {},
          longpollingTimeoutMs: pollTimeoutMs,
          serverLongpollingTimeoutMs: null,
        }
      }
      // 3) A transport failure — hand it to the poll loop's error path.
      throw error
    } finally {
      clearTimeout(timer)
    }
  }
  return wrapper
}

/**
 * Register a handler once the named host service exists.
 *
 * `ctx.inject` is the host's own conditional-injection pattern (a service may
 * be composed after this row); when it is unavailable, a direct `ctx.get` is
 * attempted and a miss is simply skipped.
 *
 * @param {object} ctx - plugin context.
 * @param {string} serviceName - service to wait for.
 * @param {(service: object) => void} run - called with the service.
 * @returns {void}
 */
function whenService(ctx, serviceName, run) {
  const attempt = (scope) => {
    let service
    try {
      service = (scope ?? ctx)?.get?.(serviceName)
    } catch {
      service = undefined
    }
    if (!service) {
      try {
        service = ctx?.get?.(serviceName)
      } catch {
        service = undefined
      }
    }
    if (service) run(service)
  }
  if (typeof ctx?.inject === 'function') {
    try {
      ctx.inject([serviceName], (scoped) => attempt(scoped))
      return
    } catch {
      // Fall through to the direct lookup.
    }
  }
  attempt(ctx)
}

/**
 * Build a logger from `ctx.logger` with a console fallback.
 *
 * @param {object} ctx - plugin context.
 * @returns {(level: string, message: string) => void} the logger.
 */
function createLogger(ctx) {
  const logger = ctx?.logger
  return (level, message) => {
    const sink = logger?.[level]
    if (typeof sink === 'function') {
      try {
        sink.call(logger, message)
        return
      } catch {
        // Fall through to console.
      }
    }
    if (level === 'error') console.error(`[wechat-ilink] ${message}`)
    else if (level === 'warn') console.warn(`[wechat-ilink] ${message}`)
    else console.log(`[wechat-ilink] ${message}`)
  }
}

/**
 * Mount the channel row.
 *
 * @param {object} ctx - Cordis context.
 * @param {object} [rawConfig] - the `wechat-ilink` row's config.
 * @param {object} [deps] - protocol factories / test seams; production passes nothing.
 * @param {object} [deps.ilink] - fake protocol layer (tests).
 * @param {Function} [deps.clientFactory] - overrides `createIlinkClient`.
 * @param {Function} [deps.storeFactory] - overrides `createAccountStore`.
 * @param {Function} [deps.pollFactory] - overrides `startPollLoop`.
 * @param {string} [deps.dataDirectory] - overrides `resolveDataDir`.
 * @param {number} [deps.backoffMs] - poll backoff override.
 * @param {object} [deps.channel] - a pre-built channel instance (tests).
 * @returns {() => void} disposer stopping the poll and dropping the registry entry.
 */
export function apply(ctx, rawConfig, deps = {}) {
  const config = withDefaults(rawConfig)
  const log = deps.log ?? createLogger(ctx)
  const channel =
    deps.channel ?? new WechatIlinkChannel({ ctx, config, deps, log })
  setService(channel)
  // Host-side HTTP API for the settings/QR UI. `mountWebApi` uses Cordis'
  // conditional injection, so a profile without a webServer simply never runs
  // the registration callback — the plugin still loads. A throw here must not
  // take the row down either.
  let disposeWebApi = () => {}
  try {
    disposeWebApi = mountWebApi(ctx, { service: channel, config, log }) ?? disposeWebApi
  } catch (error) {
    log('warn', `wechat-ilink: could not mount the web API: ${String(error)}`)
  }
  if (config.toolEnabled !== false) {
    whenService(ctx, 'tools', (tools) => {
      let systemPrompt
      try {
        systemPrompt = ctx?.get?.('systemPrompt')
      } catch {
        systemPrompt = undefined
      }
      registerWechatSendTool({ tools, systemPrompt, service: channel, log })
    })
  }
  if (config.autoConnect === false) {
    // `autoConnect: false` is an explicit operator decision: do not open the
    // inbound long poll. The row still mounts, still publishes itself in the
    // registry, and still sends outbound messages (the client is created
    // lazily), so nothing about the plugin load depends on this switch.
    log(
      'info',
      'wechat-ilink: autoConnect=false — inbound polling not started ' +
        '(outbound sending still works; call start() to connect)',
    )
  } else {
    void channel.start().catch((error) => {
      log('error', `wechat-ilink: start failed: ${String(error)}`)
    })
  }
  return () => {
    try {
      disposeWebApi()
    } catch (error) {
      log('warn', `wechat-ilink: web API teardown failed: ${String(error)}`)
    }
    if (getService() === channel) clearService()
    void channel.stop().catch((error) => {
      log('warn', `wechat-ilink: stop failed: ${String(error)}`)
    })
  }
}

export default apply
