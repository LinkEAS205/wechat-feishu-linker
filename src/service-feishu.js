/**
 * Feishu channel service — the counterpart of `src/service.js` for Lark.
 *
 * Publishes the same interface the bridge already talks to, so the bridge needs
 * no Feishu-specific branch anywhere: it asks the conversation's channel for
 * `sendText` / `sendTyping`, and this is one of the answers it can get.
 *
 * Two differences from the WeChat channel are worth stating, because the bridge
 * has to accommodate both:
 *
 * - **The typing indicator is a reaction, and it persists.** WeChat's signal is
 *   one-shot and dies after a few seconds, so the bridge refreshes it on a timer.
 *   A reaction stays until deleted, so adding it is idempotent and the refresh
 *   loop is harmless — but `clearTyping` must actually be called at turn end, or
 *   the contact keeps seeing "typing…" forever.
 * - **There is no conversation window.** Feishu accepts a send whenever the app
 *   is in the chat, so nothing here parks replies.
 *
 * Zero `@deepseek-ai/*` imports (docs/INTERFACES.md §2.0).
 *
 * @module wechat-feishu-linker/service-feishu
 */

import { createFeishuClient, receiveIdTypeOf } from './feishu/client.js'
import { FEISHU_CHANNEL, normalizeInbound } from './feishu/normalize.js'
import { beginRegistration, pollRegistration } from './feishu/registration.js'
import { createFeishuStore } from './feishu/store.js'
import { FEISHU_APP_ID_PATTERN, startFeishuWebSocket } from './feishu/ws.js'
import { clearService, setService } from './registry.js'
import { mountWebApi } from './web/index.js'

/** The Cordis plugin name for this row. */
export const name = 'feishu'

/** The channel key this service is filed under. */
export const CHANNEL = FEISHU_CHANNEL

/** Config defaults, merged over whatever the profile provides. */
export const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  /** The `cli_…` app id. The secret lives in the data directory, never here. */
  appId: '',
  /** `feishu` (open.feishu.cn) or `lark` (open.larksuite.com). */
  domain: 'feishu',
  /** Where credentials live; empty uses the shared data directory. */
  dataDir: '',
})

/**
 * Merge user config over the defaults.
 *
 * @param {object} [config] - raw config.
 * @returns {object} the resolved config.
 */
export function withDefaults(config) {
  const merged = { ...DEFAULT_CONFIG, ...(config ?? {}) }
  if (merged.domain !== 'lark') merged.domain = 'feishu'
  return merged
}

/**
 * The Feishu channel.
 */
export class FeishuChannel {
  /**
   * @param {object} options - construction options.
   * @param {object} options.ctx - plugin context.
   * @param {object} options.config - resolved config.
   * @param {(level: string, message: string) => void} [options.log] - logger.
   * @param {{ startSocket?: Function, store?: Function }} [options.deps] - injectable seams for tests.
   */
  constructor({ ctx, config, log, deps = {} }) {
    this.ctx = ctx
    this.config = config
    this.log = log
    this.channel = CHANNEL
    // Injectable so the channel can be tested without opening a real socket or
    // needing the SDK installed.
    this.startSocket = deps.startSocket ?? startFeishuWebSocket
    this.makeStore = deps.store ?? ((options) => createFeishuStore(options))
    /** @type {object | undefined} */
    this.account = undefined
    /** @type {object | undefined} */
    this.client = undefined
    /** @type {{ close: () => void, terminated: Promise<void> } | undefined} */
    this.socket = undefined
    /** @type {((message: object) => void) | undefined} */
    this.handler = undefined
    this.lastError = undefined
    this.connectionState = 'idle'
    this.started = false
    /** @type {AbortController | undefined} */
    this.abort = undefined
    /**
     * Registrations this process issued, keyed by device code.
     *
     * Held so a poll can only ever complete a QR this process minted — an
     * arbitrary device code from a request body must not be able to bind the
     * channel to somebody else's app.
     */
    this.pendingLogins = new Map()
    /**
     * What actually arrived, counted where it can be read.
     *
     * The plugin's `log` goes to the host's logger, and a desktop build does not
     * write that anywhere a human can open — so a diagnostic that only logs is a
     * diagnostic nobody can read. These counters ride the status endpoint
     * instead, which is reachable over HTTP while the host is running.
     *
     * `received` and `ignored` together separate the two failures that otherwise
     * look identical from the outside: the event never arriving, and the event
     * arriving and being discarded.
     */
    this.events = { received: 0, ignored: 0, lastShape: null, lastAt: null }
  }

  /**
   * Start a one-click registration and mint the QR the contact scans.
   *
   * @param {'feishu' | 'lark'} [domain] - which accounts host to begin at.
   * @returns {Promise<object>} `{ deviceCode, qrUrl, userCode, interval, expiresAt }`.
   */
  async beginLogin(domain) {
    const begun = await beginRegistration({ domain: domain ?? this.config?.domain })
    this.pendingLogins.set(begun.deviceCode, begun)
    return {
      deviceCode: begun.deviceCode,
      qrUrl: begun.qrUrl,
      userCode: begun.userCode,
      interval: begun.interval,
      expiresAt: begun.expiresAt,
    }
  }

  /**
   * Poll one registration, and bind the channel when the scan is confirmed.
   *
   * @param {string} deviceCode - from {@link beginLogin}.
   * @returns {Promise<object>} the poll outcome, plus `bound` on success.
   */
  async pollLogin(deviceCode) {
    const entry = this.pendingLogins.get(deviceCode)
    if (entry === undefined) return { status: 'error', message: '这个二维码不是本机发出的' }
    if (Date.now() > entry.expiresAt) {
      this.pendingLogins.delete(deviceCode)
      return { status: 'expired' }
    }
    let result
    try {
      result = await pollRegistration({
        deviceCode,
        domain: entry.domain,
        pollDomain: entry.pollDomain,
      })
    } catch (error) {
      // A transient network failure must not throw away a QR the contact may
      // still be about to scan; report it and let the next poll try again.
      return { status: 'pending', interval: 5_000, message: String(error?.message ?? error) }
    }
    if (result.status === 'pending') {
      // Carry the tenant brand forward — a Lark tenant is discovered here.
      entry.domain = result.domain ?? entry.domain
      entry.pollDomain = result.pollDomain ?? entry.pollDomain
      return result
    }
    this.pendingLogins.delete(deviceCode)
    if (result.status !== 'success') return result

    const account = {
      appId: result.appId,
      appSecret: result.appSecret,
      domain: result.domain === 'lark' ? 'lark' : 'feishu',
      ...(result.appName ? { appName: result.appName } : {}),
    }
    await this.stop()
    await this.store().save(account)
    this.account = account
    await this.start()
    this.log?.('info', `wechat-ilink feishu: registered ${account.appId} by QR`)
    return { ...result, bound: this.connected }
  }

  /** Where credentials and diagnostics live. */
  get dataDirectory() {
    return this.store().path.replace(/[\\/][^\\/]+$/u, '')
  }

  /** Whether the long connection is open. */
  get connected() {
    return this.connectionState === 'connected'
  }

  /**
   * Feishu pushes events over the long connection rather than being polled, so
   * "polling" means "the connection is up and events will arrive".
   */
  get polling() {
    return this.connected
  }

  /** The bound app id, or an empty string. */
  get accountId() {
    return typeof this.account?.appId === 'string' ? this.account.appId : ''
  }

  /**
   * The credential store.
   *
   * @returns {object} the store.
   */
  store() {
    return this.makeStore({ dataDir: this.config?.dataDir })
  }

  /**
   * The status the settings card renders.
   *
   * @returns {object} the status.
   */
  getStatus() {
    return {
      channel: CHANNEL,
      bound: Boolean(this.account?.appId && this.account?.appSecret),
      appId: this.accountId,
      domain: this.config?.domain === 'lark' ? 'lark' : 'feishu',
      connected: this.connected,
      polling: this.polling,
      connectionState: this.connectionState,
      events: { ...this.events },
      lastError: this.lastError ? String(this.lastError.message ?? this.lastError) : null,
    }
  }

  /**
   * Register the inbound handler.
   *
   * @param {(message: object) => void} handler - called per normalized message.
   * @returns {void}
   */
  onMessage(handler) {
    this.handler = handler
  }

  /**
   * Persist credentials and (re)open the connection.
   *
   * @param {{ appId?: string, appSecret?: string, domain?: string }} target - what to bind.
   * @returns {Promise<{ ok: boolean, message?: string }>} the outcome.
   */
  async bind(target = {}) {
    const appId = typeof target.appId === 'string' ? target.appId.trim() : ''
    const appSecret = typeof target.appSecret === 'string' ? target.appSecret.trim() : ''
    const domain = target.domain === 'lark' ? 'lark' : 'feishu'
    // Validate before touching the working binding: a rejected form must not
    // take down a channel that is currently fine.
    if (!FEISHU_APP_ID_PATTERN.test(appId)) {
      return { ok: false, message: 'App ID 必须形如 cli_ 加 16 位十六进制字符' }
    }
    if (!appSecret) return { ok: false, message: 'App Secret 不能为空' }
    await this.stop()
    this.config.domain = domain
    const account = { appId, appSecret, domain }
    await this.store().save(account)
    this.account = account
    await this.start()
    return { ok: true }
  }

  /**
   * Forget the credentials and close the connection.
   *
   * @returns {Promise<void>} resolves once unbound.
   */
  async logout() {
    await this.stop()
    await this.store().clear()
    this.account = undefined
  }

  /**
   * Load credentials and open the long connection.
   *
   * @returns {Promise<void>} resolves once started or deliberately idle.
   */
  async start() {
    if (this.started) return
    this.started = true
    if (!this.account) this.account = (await this.store().load()) ?? undefined
    const appId = this.account?.appId
    const appSecret = this.account?.appSecret
    if (!appId || !appSecret) {
      this.connectionState = 'unbound'
      this.log?.('info', 'wechat-ilink feishu: no credentials yet; bind an app to start the channel')
      return
    }
    this.client = createFeishuClient({
      appId,
      appSecret,
      domain: this.account.domain === 'lark' ? 'lark' : this.config?.domain,
      log: this.log,
    })
    this.abort = new AbortController()
    try {
      this.socket = await this.startSocket({
        appId,
        appSecret,
        domain: this.account.domain === 'lark' ? 'lark' : this.config?.domain,
        signal: this.abort.signal,
        log: this.log,
        onStateChange: (state) => {
          this.connectionState = state
        },
        handlers: {
          'im.message.receive_v1': (payload) => {
            // Counted BEFORE anything can drop it: without this, "the event never
            // arrived" and "it arrived and was discarded" are both simply
            // silence, and they have completely different causes.
            this.events.received += 1
            this.events.lastAt = new Date().toISOString()
            return this.ingest(payload)
          },
        },
      })
      this.connectionState = 'connected'
      this.lastError = undefined
      this.log?.('info', `wechat-ilink feishu: long connection open for ${appId}`)
      // A spent reconnect budget is terminal for the socket; record it so the
      // status card shows a dead channel rather than a healthy one.
      void this.socket.terminated.catch((error) => {
        this.connectionState = 'failed'
        this.lastError = error
        this.log?.('warn', `wechat-ilink feishu: long connection ended: ${String(error)}`)
      })
    } catch (error) {
      this.connectionState = 'failed'
      this.lastError = error
      this.log?.('warn', `wechat-ilink feishu: could not open the long connection: ${String(error)}`)
    }
  }

  /**
   * Close the connection and forget the socket.
   *
   * @returns {Promise<void>} resolves once stopped.
   */
  async stop() {
    this.started = false
    this.abort?.abort()
    this.abort = undefined
    try {
      this.socket?.close()
    } catch {
      // Closing an already-dead socket is not a failure worth reporting.
    }
    this.socket = undefined
    this.client?.reset()
    this.client = undefined
    if (this.connectionState !== 'unbound') this.connectionState = 'idle'
  }

  /**
   * Normalize one dispatcher payload and hand it to the bridge.
   *
   * @param {unknown} payload - what the SDK dispatched.
   * @returns {object | undefined} nothing; the SDK ignores handler return values.
   */
  ingest(payload) {
    let message = null
    try {
      message = normalizeInbound(payload, { accountId: this.accountId || 'default' })
    } catch (error) {
      this.log?.('warn', `wechat-ilink feishu: could not read an inbound event: ${String(error)}`)
      return undefined
    }
    if (!message) {
      // Counted and shaped rather than only logged: "the bot ignored my message"
      // is the symptom this exists to make traceable, and a renamed or flattened
      // field is the likeliest reason an event that *did* arrive produced
      // nothing.
      this.events.ignored += 1
      try {
        this.events.lastShape = JSON.stringify(payload)?.slice(0, 600) ?? String(payload)
      } catch {
        this.events.lastShape = Object.keys(payload ?? {}).join(',')
      }
      this.log?.('info', `wechat-ilink feishu: ignored an inbound event — ${this.events.lastShape}`)
      return undefined
    }
    // Hand it to the bridge the same way the WeChat channel does: by emitting
    // the event the bridge subscribes to. Calling a local handler instead is how
    // this channel silently swallowed every message — the bridge only listens on
    // the event, so `this.handler` was a callback nobody had registered, and the
    // message went into a void with no error anywhere.
    try {
      this.ctx?.emit?.('wechat-ilink/message', message)
    } catch (error) {
      this.log?.('warn', `wechat-ilink feishu: could not emit wechat-ilink/message: ${String(error)}`)
    }
    // Kept as an explicit local subscription for tests and diagnostics; the
    // bridge does not use it, so nothing is delivered twice in production.
    try {
      this.handler?.(message)
    } catch (error) {
      this.log?.('error', `wechat-ilink feishu: inbound handler failed: ${String(error)}`)
    }
    // The shape of the last message that *did* parse, kept for the same reason
    // the ignored one is: a field that is merely absent — the contact's message
    // id, say — does not fail normalization, it just leaves the outbound side
    // without the handle it needs, and "no typing ticket" is the only symptom.
    try {
      this.events.lastShape = JSON.stringify(payload)?.slice(0, 600) ?? String(payload)
    } catch {
      this.events.lastShape = Object.keys(payload ?? {}).join(',')
    }
    return undefined
  }

  /**
   * Send one message.
   *
   * @param {string} peerId - chat id or user open id.
   * @param {string} text - the body.
   * @returns {Promise<{ messageIds: string[], chunkCount: number }>} what was sent.
   */
  async sendText(peerId, text, opts = {}) {
    if (!this.client) throw new Error('Feishu channel is not connected')
    // Answer the contact's own message when we still have its id. Feishu treats
    // a reply and a fresh push as different operations with different rules: a
    // bot may always reply to a message it received, while pushing a new one is
    // refused with `230101 Sending messages to users is temporarily unavailable`
    // even for an app that is published and enabled. Replying also threads the
    // exchange, which is what the contact expects to see.
    const replyTo = typeof opts?.contextToken === 'string' ? opts.contextToken : ''
    const { messageId } = replyTo
      ? await this.client.replyText(replyTo, text)
      : await this.client.sendText(peerId, text)
    return { messageIds: messageId ? [messageId] : [], chunkCount: 1 }
  }

  /**
   * Show the "typing…" reaction on the contact's message.
   *
   * Idempotent by design: the bridge refreshes the indicator on a timer, and
   * only the first call for a given message reaches Feishu.
   *
   * @param {string} _peerId - unused; the reaction attaches to the message.
   * @param {string} contextToken - the contact's message id.
   * @returns {Promise<boolean>} whether the indicator is showing.
   */
  async sendTyping(_peerId, contextToken) {
    if (!this.client || !contextToken) return false
    try {
      return await this.client.addTypingReaction(contextToken)
    } catch (error) {
      this.log?.('warn', `wechat-ilink feishu: typing indicator failed: ${String(error)}`)
      return false
    }
  }

  /**
   * Remove the "typing…" reaction.
   *
   * Must be called at turn end: unlike WeChat's signal, a reaction does not
   * expire on its own, so leaving it makes the contact watch a bot that is
   * apparently typing forever.
   *
   * @param {string} _peerId - unused; the reaction attaches to the message.
   * @param {string} contextToken - the contact's message id.
   * @returns {Promise<boolean>} whether one was removed.
   */
  async clearTyping(_peerId, contextToken) {
    if (!this.client || !contextToken) return false
    try {
      return await this.client.removeTypingReaction(contextToken)
    } catch (error) {
      this.log?.('warn', `wechat-ilink feishu: could not clear the typing indicator: ${String(error)}`)
      return false
    }
  }
}

/**
 * Cordis plugin entry for the Feishu channel.
 *
 * @param {object} ctx - plugin context.
 * @param {object} [config] - profile config.
 * @returns {object} the live channel.
 */
export function apply(ctx, config) {
  const resolved = withDefaults(config)
  const log = (level, message) => {
    const logger = ctx?.logger
    if (typeof logger?.[level] === 'function') logger[level](message)
    else if (level === 'error' || level === 'warn') console.warn(message)
  }
  const channel = new FeishuChannel({ ctx, config: resolved, log })

  // Publish into the keyed registry, which is how the bridge and the web routes
  // find this channel. Without it the channel runs but nothing can reach it, and
  // the settings card reports "the channel is not loaded" for a row that is
  // perfectly healthy.
  setService(channel)

  // Mount the shared web API if the WeChat row has not already. One route per
  // prefix, so whichever channel row starts first owns it; a profile that
  // disables the WeChat row must not take the Feishu card's routes with it.
  let disposeWebApi
  try {
    disposeWebApi = mountWebApi(ctx, { service: channel, config: resolved, log })
  } catch (error) {
    log('warn', `wechat-ilink feishu: could not mount the web API: ${String(error)}`)
  }

  const dispose = () => {
    try {
      disposeWebApi?.()
    } catch {
      // Already torn down by the host.
    }
    clearService(CHANNEL)
  }
  if (typeof ctx?.effect === 'function') {
    try {
      ctx.effect(() => dispose)
    } catch {
      // A host without effect scoping still gets the returned channel.
    }
  }

  if (resolved.enabled !== false) void channel.start()
  channel.dispose = dispose
  return channel
}

export default apply
