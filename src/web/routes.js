/**
 * Host-side HTTP API of the WeChat iLink plugin.
 *
 * One fenced route, `prefix /wechat-ilink/api`, registered on the host
 * `webServer` (see `./index.js` for the Cordis wiring). Every path is served by
 * this module so the plugin contributes a single route registration and a single
 * disposer.
 *
 * Two contracts this module keeps deliberately:
 *
 * 1. **No secrets over HTTP.** `bot_token` never appears in a response body.
 *    `/status` reports only whether an account is bound plus its ids.
 * 2. **No `@deepseek-ai/*` runtime import.** The live channel service is read
 *    through the process-local registry (`../registry.js`), and every optional
 *    service capability is duck-typed: a missing capability degrades to a
 *    documented `{ available: false, items: [] }` body instead of an error.
 *
 * The iLink login surface is reached directly through the frozen protocol layer
 * (`../ilink/login.js`, `../ilink/store.js`); when the channel service grows its
 * own `beginLogin`/`pollLogin`/`logout`/`reload` methods they take precedence.
 *
 * @module wechat-feishu-linker/web/routes
 */

import { LOGIN_POLL_INTERVAL_MS, beginLogin, pollLogin } from '../ilink/login.js'
import { createAccountStore, resolveDataDir } from '../ilink/store.js'
import { getBridgeSettings as getRegistryBridgeSettings, getService as getRegistryService } from '../registry.js'
import { qrSvg } from './qrcode.js'

/** Route prefix owned by this plugin. */
export const WEB_API_PREFIX = '/wechat-ilink/api'

/** Suggested client poll interval for `/login/poll`, in milliseconds. */
export const DEFAULT_LOGIN_INTERVAL_MS = LOGIN_POLL_INTERVAL_MS

/** Largest accepted JSON request body. */
export const MAX_BODY_BYTES = 64 * 1024

/** How many concurrent QR logins are remembered. */
export const MAX_PENDING_LOGINS = 8

/** QR lifetime assumed when iLink does not report `expires_in`. */
const FALLBACK_QR_TTL_MS = 120_000

/** Fields copied out of a workspace record. */
const WORKSPACE_FIELDS = ['id', 'name', 'path', 'cwd', 'current', 'sessionCount', 'updatedAt']

/** Fields copied out of a session record. */
const SESSION_FIELDS = ['sessionId', 'id', 'title', 'name', 'cwd', 'workspace', 'updatedAt', 'createdAt', 'live', 'current']

/**
 * Build the API surface.
 *
 * @param {object} [options] - construction options.
 * @param {object} [options.deps] - test seams.
 * @param {() => object | undefined} [options.getService] - live channel service
 * lookup; defaults to the process-local registry.
 * @param {object} [options.config] - resolved plugin config (used for `baseUrl`
 * and `dataDir` when the service is absent).
 * @param {(level: string, message: string) => void} [options.log] - logger.
 * @param {(message: object) => void} [options.onError] - optional observer for
 * recorded errors (the plugin entry wires this to `ctx.on`).
 * @returns {{
 *   prefix: string,
 *   handler: (req: object, res: object) => Promise<void>,
 *   recordError: (message: string) => void,
 *   dispose: () => void,
 * }} the API handle.
 */
export function createWebApi(options = {}) {
  const deps = options.deps ?? {}
  const config = options.config ?? {}
  const log = typeof options.log === 'function' ? options.log : () => {}
  const getService = typeof options.getService === 'function' ? options.getService : getRegistryService
  const getBridgeSettings =
    typeof options.getBridgeSettings === 'function' ? options.getBridgeSettings : getRegistryBridgeSettings
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now()
  /**
   * Feishu registrations this process issued, keyed by device code.
   *
   * The QR image route reads the URL from here rather than from the request, so
   * the browser can never be handed a QR for a URL the server did not mint.
   */
  const feishuPending = new Map()
  const beginLoginFn = typeof deps.beginLogin === 'function' ? deps.beginLogin : beginLogin
  const pollLoginFn = typeof deps.pollLogin === 'function' ? deps.pollLogin : pollLogin
  const storeFactory = typeof deps.storeFactory === 'function'
    ? deps.storeFactory
    : (dataDir) => createAccountStore({ dataDir })
  const intervalMs = Number.isFinite(deps.intervalMs) && deps.intervalMs > 0
    ? deps.intervalMs
    : DEFAULT_LOGIN_INTERVAL_MS

  /** @type {Map<string, { qrUrl: string, expiresAt: number }>} */
  const pending = new Map()
  /** @type {{ message: string, at: number } | undefined} */
  let lastError
  /** @type {{ dataDir: string, store: object } | undefined} */
  let storeCache
  let disposed = false

  /**
   * @returns {object | undefined} the live channel service.
   */
  function service() {
    try {
      return getService()
    } catch {
      return undefined
    }
  }

  /**
   * Record the most recent channel/API error, for `/status.lastError`.
   *
   * @param {string} message - human-readable failure.
   * @returns {void}
   */
  function recordError(message) {
    const text = typeof message === 'string' && message ? message : String(message)
    lastError = { message: text, at: now() }
    try {
      options.onError?.({ message: text })
    } catch {
      // An observer failure must never break a response.
    }
  }

  /**
   * @returns {object} the account store for the channel's data directory.
   */
  function accountStore() {
    const svc = service()
    const dataDir = readString(svc?.dataDirectory) || resolveDataDir(config)
    if (storeCache === undefined || storeCache.dataDir !== dataDir) {
      storeCache = { dataDir, store: storeFactory(dataDir) }
    }
    return storeCache.store
  }

  /**
   * @returns {Promise<object | null>} the stored account, or null.
   */
  async function readStoredAccount() {
    try {
      const account = await accountStore().load()
      return account && typeof account === 'object' ? account : null
    } catch (error) {
      log('warn', `wechat-ilink: could not read the stored account: ${errorMessage(error)}`)
      return null
    }
  }

  /**
   * Remember one issued QR code.
   *
   * @param {string} qrcode - iLink QR id.
   * @param {{ qrUrl: string, expiresAt: number }} entry - its login entry.
   * @returns {void}
   */
  function rememberLogin(qrcode, entry) {
    pending.delete(qrcode)
    pending.set(qrcode, entry)
    while (pending.size > MAX_PENDING_LOGINS) {
      const oldest = pending.keys().next()
      if (oldest.done) break
      pending.delete(oldest.value)
    }
  }

  // ────────────────────────────── handlers ──────────────────────────────

  /**
   * `GET /status` — bind state and connection health, never the token.
   *
   * @param {object} _req - request.
   * @param {object} res - response.
   * @returns {Promise<void>}
   */
  async function handleStatus(_req, res) {
    const svc = service()
    const snapshot = safeCall(svc, 'getStatus') ?? {}
    const token = readString(svc?.token)
    let bound = typeof snapshot.hasToken === 'boolean' ? snapshot.hasToken : token !== ''
    let botId =
      readString(svc?.account?.botId) ||
      readString(svc?.account?.bot_id) ||
      readString(snapshot.botId)
    let accountId = readString(snapshot.accountId) || readString(svc?.accountId)

    if (!bound) {
      // The channel only caches the account it started with; a stored account the
      // service has not picked up (for example `autoConnect: false`) is still bound.
      const account = await readStoredAccount()
      if (account) {
        bound = true
        botId ||= readString(account.botId) || readString(account.bot_id)
        // The channel's `getStatus()` reports the placeholder `default` when it
        // has not loaded an account; the stored record is authoritative then.
        const storedAccountId = readString(account.accountId) || readString(account.botId)
        if (storedAccountId && (!accountId || accountId === 'default')) accountId = storedAccountId
      }
    }

    const connected = typeof svc?.connected === 'boolean' ? svc.connected : Boolean(snapshot.connected)
    const polling = typeof svc?.polling === 'boolean' ? svc.polling : connected
    sendJson(res, 200, {
      bound,
      botId,
      accountId: accountId || 'default',
      connected,
      polling,
      lastError: lastError?.message ?? null,
      // Read straight off the bridge row on every request, never cached here:
      // `null` means that row is not mounted, so nothing can be changed and the
      // page must say so instead of offering a control that does nothing.
      settings: readLiveSettings(),
      // Which host surfaces the bridge found at load. A DSH update that drops or
      // renames one is otherwise invisible: the feature just stops working, and
      // the symptom is a long way from the cause.
      hostCompat: readHostCompat(),
      // Replies the closed conversation window is still holding. The notice that
      // would report them travels the same closed channel, so this is the only
      // place the contact can learn they exist.
      undelivered: readUndelivered(),
      // The choices the settings page's "defaults for new sessions" controls
      // offer. Read from the same host services the WeChat commands use, so the
      // page can never offer something the host does not actually have.
      catalog: await readCatalog(),
      permissions: readPermissions(),
    })

    /**
     * Read the model catalog for the settings page.
     *
     * @returns {Promise<object | null>} the catalog, or null when unavailable.
     */
    async function readCatalog() {
      const handle = getBridgeSettings()
      if (!handle || typeof handle.catalog !== 'function') return null
      try {
        return await handle.catalog()
      } catch (error) {
        recordError(`读取模型目录失败：${errorMessage(error)}`)
        return null
      }
    }

    /**
     * Read the permission presets for the settings page.
     *
     * @returns {object | null} the presets, or null when unavailable.
     */
    function readPermissions() {
      const handle = getBridgeSettings()
      if (!handle || typeof handle.permissions !== 'function') return null
      try {
        return handle.permissions()
      } catch (error) {
        recordError(`读取权限预设失败：${errorMessage(error)}`)
        return null
      }
    }

    /**
     * Read how many replies a closed window is holding.
     *
     * @returns {{ count: number, chars: number } | null} the tally, or null.
     */
    function readUndelivered() {
      const handle = getBridgeSettings()
      if (!handle || typeof handle.undelivered !== 'function') return null
      try {
        return handle.undelivered()
      } catch (error) {
        recordError(`读取未送达回复失败：${errorMessage(error)}`)
        return null
      }
    }

    /**
     * Read the bridge's host-compatibility report.
     *
     * @returns {object | null} the report, or null when the bridge is not mounted.
     */
    function readHostCompat() {
      const handle = getBridgeSettings()
      if (!handle || typeof handle.compat !== 'function') return null
      try {
        return handle.compat()
      } catch (error) {
        recordError(`读取宿主兼容性失败：${errorMessage(error)}`)
        return null
      }
    }
  }

  /**
   * Read the live bridge settings.
   *
   * @returns {{ displayMode: string, typingIndicator: boolean } | null} the settings, or null.
   */
  function readLiveSettings() {
    const handle = getBridgeSettings()
    if (!handle || typeof handle.read !== 'function') return null
    try {
      return handle.read()
    } catch (error) {
      recordError(`读取设置失败：${errorMessage(error)}`)
      return null
    }
  }

  /**
   * `POST /settings` — change one runtime setting.
   *
   * The bridge applies the change to the very config it relays from and answers
   * with what it now holds, so the page can render that instead of its own guess
   * about what the write did.
   *
   * @param {object} req - request.
   * @param {object} res - response.
   * @returns {Promise<void>}
   */
  async function handleSettings(req, res) {
    let body
    try {
      body = await readJsonBody(req)
    } catch (error) {
      sendJson(res, error?.status ?? 400, { ok: false, message: errorMessage(error) })
      return
    }
    const handle = getBridgeSettings()
    if (!handle || typeof handle.write !== 'function') {
      sendJson(res, 200, {
        ok: false,
        available: false,
        message: '微信桥接未运行，设置暂时改不了（需要 wechat-ilink-bridge 那一行已启动）',
      })
      return
    }
    const result = await handle.write(body)
    if (!result || result.ok !== true) {
      sendJson(res, 400, { ok: false, message: result?.message ?? '设置未生效' })
      return
    }
    sendJson(res, 200, { ok: true, settings: result.settings, persisted: result.persisted })
  }

  /**
   * `GET /feishu/status` — the Feishu channel's own status.
   *
   * Read straight off the live service in the same process, through the same
   * registry the bridge uses. `null` means the `feishu` row is not mounted, which
   * the card must say out loud rather than render as "unbound" — those are very
   * different problems and only one of them is fixed by typing credentials.
   *
   * @param {object} _req - request.
   * @param {object} res - response.
   * @returns {Promise<void>}
   */
  async function handleFeishuStatus(_req, res) {
    const svc = getService('feishu')
    if (!svc || typeof svc.getStatus !== 'function') {
      sendJson(res, 200, { mounted: false, status: null })
      return
    }
    try {
      sendJson(res, 200, { mounted: true, status: svc.getStatus() })
    } catch (error) {
      recordError(`读取飞书状态失败：${errorMessage(error)}`)
      sendJson(res, 200, { mounted: true, status: null, message: errorMessage(error) })
    }
  }

  /**
   * `POST /feishu/login/begin` — mint a one-click registration QR.
   *
   * @param {object} req - request.
   * @param {object} res - response.
   * @returns {Promise<void>}
   */
  async function handleFeishuLoginBegin(req, res) {
    let body = {}
    try {
      body = await readJsonBody(req)
    } catch {
      // The domain is optional; an unreadable body just means "use the default".
      body = {}
    }
    const svc = getService('feishu')
    if (!svc || typeof svc.beginLogin !== 'function') {
      sendJson(res, 200, {
        ok: false,
        available: false,
        message: '飞书通道未运行（需要配置里多一行 feishu，见 cordis.patch.yml）',
      })
      return
    }
    try {
      const begun = await svc.beginLogin(body?.domain)
      feishuPending.set(begun.deviceCode, begun)
      sendJson(res, 200, {
        ok: true,
        qrcode: begun.deviceCode,
        qrUrl: begun.qrUrl,
        userCode: begun.userCode,
        interval: begun.interval,
        expiresAt: begun.expiresAt,
        qrImageUrl: `${WEB_API_PREFIX}/feishu/qr.svg?qrcode=${encodeURIComponent(begun.deviceCode)}`,
      })
    } catch (error) {
      recordError(`飞书扫码绑定失败：${errorMessage(error)}`)
      sendJson(res, 502, { ok: false, message: errorMessage(error) })
    }
  }

  /**
   * `GET /feishu/login/poll?qrcode=` — has the scan been confirmed yet.
   *
   * @param {object} _req - request.
   * @param {object} res - response.
   * @param {URL} url - parsed request URL.
   * @returns {Promise<void>}
   */
  async function handleFeishuLoginPoll(_req, res, url) {
    const qrcode = readString(url.searchParams.get('qrcode'))
    const svc = getService('feishu')
    if (!qrcode || !svc || typeof svc.pollLogin !== 'function') {
      sendJson(res, 400, { ok: false, status: 'error', message: '缺少 qrcode 参数或飞书通道未运行' })
      return
    }
    try {
      const result = await svc.pollLogin(qrcode)
      if (result.status !== 'pending') feishuPending.delete(qrcode)
      sendJson(res, 200, { ok: true, ...result })
    } catch (error) {
      recordError(`飞书扫码轮询失败：${errorMessage(error)}`)
      sendJson(res, 502, { ok: false, status: 'error', message: errorMessage(error) })
    }
  }

  /**
   * `GET /feishu/qr.svg?qrcode=` — the scannable image for one registration.
   *
   * @param {object} _req - request.
   * @param {object} res - response.
   * @param {URL} url - parsed request URL.
   * @returns {void}
   */
  function handleFeishuQrImage(_req, res, url) {
    const qrcode = readString(url.searchParams.get('qrcode'))
    const entry = qrcode ? feishuPending.get(qrcode) : undefined
    if (entry === undefined) {
      sendText(res, 404, 'no QR available')
      return
    }
    let svg
    try {
      svg = qrSvg(entry.qrUrl, { title: '飞书应用一键创建二维码' })
    } catch (error) {
      recordError(`飞书二维码渲染失败：${errorMessage(error)}`)
      sendText(res, 500, 'could not render the QR code')
      return
    }
    res.statusCode = 200
    res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8')
    res.setHeader('Cache-Control', 'no-store')
    res.end(svg)
  }

  /**
   * `POST /feishu/bind` — save the app credentials and open the connection.
   *
   * @param {object} req - request.
   * @param {object} res - response.
   * @returns {Promise<void>}
   */
  async function handleFeishuBind(req, res) {
    let body
    try {
      body = await readJsonBody(req)
    } catch (error) {
      sendJson(res, error?.status ?? 400, { ok: false, message: errorMessage(error) })
      return
    }
    const svc = getService('feishu')
    if (!svc || typeof svc.bind !== 'function') {
      sendJson(res, 200, {
        ok: false,
        available: false,
        message: '飞书通道未运行（需要配置里多一行 feishu，见 cordis.patch.yml）',
      })
      return
    }
    const result = await svc.bind({
      appId: body?.appId,
      appSecret: body?.appSecret,
      domain: body?.domain,
    })
    if (!result?.ok) {
      sendJson(res, 400, { ok: false, message: result?.message ?? '绑定失败' })
      return
    }
    sendJson(res, 200, { ok: true, status: svc.getStatus() })
  }

  /**
   * `POST /feishu/logout` — forget the credentials and close the connection.
   *
   * @param {object} _req - request.
   * @param {object} res - response.
   * @returns {Promise<void>}
   */
  async function handleFeishuLogout(_req, res) {
    const svc = getService('feishu')
    if (!svc || typeof svc.logout !== 'function') {
      sendJson(res, 200, { ok: false, available: false, message: '飞书通道未运行' })
      return
    }
    await svc.logout()
    sendJson(res, 200, { ok: true, status: svc.getStatus() })
  }

  /**
   * `POST /login/begin` — fetch a fresh QR code.
   *
   * @param {object} _req - request.
   * @param {object} res - response.
   * @returns {Promise<void>}
   */
  async function handleLoginBegin(_req, res) {
    const svc = service()
    const baseUrl = resolveBaseUrl(svc, config)
    let result
    try {
      result = typeof svc?.beginLogin === 'function'
        ? await svc.beginLogin()
        : await beginLoginFn(baseUrl ? { baseUrl } : {})
    } catch (error) {
      const message = `获取二维码失败：${errorMessage(error)}`
      recordError(message)
      sendJson(res, 502, { status: 'error', message })
      return
    }
    const qrcode = readString(result?.qrcode)
    const qrUrl = readString(result?.qrUrl) || readString(result?.qrcode_img_content)
    if (!qrcode || !qrUrl) {
      const message = 'iLink 未返回二维码，请稍后重试'
      recordError(message)
      sendJson(res, 502, { status: 'error', message })
      return
    }
    const expiresInMs = Number.isFinite(result?.expiresAt)
      ? Math.max(0, result.expiresAt - now())
      : Number.isFinite(result?.expiresIn)
        ? result.expiresIn * 1000
        : FALLBACK_QR_TTL_MS
    const expiresAt = Number.isFinite(result?.expiresAt) ? result.expiresAt : now() + expiresInMs
    rememberLogin(qrcode, { qrUrl, expiresAt })
    sendJson(res, 200, {
      qrcode,
      qrUrl,
      // `qrUrl` is the WeChat lite-app link the QR *encodes*, not an image; the
      // host renders the scannable image itself (see `./qrcode.js`).
      qrImageUrl: `${WEB_API_PREFIX}/qr.svg?qrcode=${encodeURIComponent(qrcode)}`,
      expiresAt,
      intervalMs,
    })
  }

  /**
   * `GET /login/poll?qrcode=` — poll one QR login.
   *
   * Persistence is delegated to the channel service when it exposes `pollLogin`
   * (the service stores the credential and reconnects itself, and never returns
   * a token); the protocol fallback stores the credential here, because that is
   * the only path that ever sees one.
   *
   * @param {object} _req - request.
   * @param {object} res - response.
   * @param {URL} url - parsed request URL.
   * @returns {Promise<void>}
   */
  async function handleLoginPoll(_req, res, url) {
    const qrcode = readString(url.searchParams.get('qrcode'))
    if (!qrcode) {
      sendJson(res, 400, { status: 'error', message: '缺少 qrcode 参数' })
      return
    }
    const entry = pending.get(qrcode)
    if (entry === undefined) {
      sendJson(res, 200, { status: 'error', message: '该二维码未登记或已失效，请重新点击「扫码绑定」' })
      return
    }
    if (now() >= entry.expiresAt) {
      pending.delete(qrcode)
      sendJson(res, 200, { status: 'expired' })
      return
    }

    const svc = service()
    const baseUrl = resolveBaseUrl(svc, config)
    // The channel service owns the whole login when it exposes `pollLogin`: it
    // persists the credential and reconnects before returning, and its result
    // deliberately carries NO token — the HTTP surface must never echo one. Only
    // the protocol fallback hands a token to this layer, so only that branch may
    // require one. Demanding a token from the service is what made a genuinely
    // successful bind answer 「登录成功但未取到凭据，请重新扫码」.
    const serviceOwnsLogin = typeof svc?.pollLogin === 'function'
    let result
    try {
      result = serviceOwnsLogin
        ? await svc.pollLogin(qrcode)
        : await pollLoginFn(baseUrl ? { qrcode, baseUrl } : { qrcode })
    } catch (error) {
      const message = `登录状态查询失败：${errorMessage(error)}`
      recordError(message)
      sendJson(res, 200, { status: 'error', message })
      return
    }

    const status = readString(result?.status) || 'error'
    if (status === 'success') {
      const botId = readString(result?.botId) || readString(result?.bot_id)
      if (serviceOwnsLogin) {
        // The service already stored the credential and reconnected, and its
        // result deliberately carries no token. Confirm the credential really
        // landed anyway: 「登录成功但未取到凭据」 is precisely the state where
        // this layer reported success while nothing had been stored, and a
        // success that does not survive a restart is worse than an honest error.
        pending.delete(qrcode)
        const stored = await readStoredAccount()
        if (!readString(stored?.botToken) && !readString(stored?.token)) {
          const message = '登录成功但未取到凭据，请重新扫码'
          recordError(message)
          sendJson(res, 200, { status: 'error', message })
          return
        }
        sendJson(res, 200, { status: 'success', ...(botId ? { botId } : {}) })
        return
      }
      const botToken = readString(result?.botToken) || readString(result?.token)
      if (!botToken) {
        pending.delete(qrcode)
        const message = '登录成功但未取到凭据，请重新扫码'
        recordError(message)
        sendJson(res, 200, { status: 'error', message })
        return
      }
      const account = {
        accountId: botId || 'default',
        botToken,
        botId,
        savedAt: new Date(now()).toISOString(),
      }
      try {
        await accountStore().save(account)
      } catch (error) {
        const message = `凭据写入失败：${errorMessage(error)}`
        recordError(message)
        sendJson(res, 200, { status: 'error', message })
        return
      }
      pending.delete(qrcode)
      await reconnect(svc, account)
      sendJson(res, 200, { status: 'success', ...(botId ? { botId } : {}) })
      return
    }

    if (status === 'expired') pending.delete(qrcode)
    const message = readString(result?.message)
    sendJson(res, 200, { status, ...(botIdOf(result) ? { botId: botIdOf(result) } : {}), ...(message ? { message } : {}) })
  }

  /**
   * `GET /qr.svg?qrcode=` — the scannable image for one issued QR code.
   *
   * @param {object} _req - request.
   * @param {object} res - response.
   * @param {URL} url - parsed request URL.
   * @returns {void}
   */
  function handleQrImage(_req, res, url) {
    const qrcode = readString(url.searchParams.get('qrcode'))
    const entry = qrcode ? pending.get(qrcode) : undefined
    if (entry === undefined) {
      sendText(res, 404, 'no QR available')
      return
    }
    let svg
    try {
      svg = qrSvg(entry.qrUrl, { title: '微信 ClawBot 绑定二维码' })
    } catch (error) {
      recordError(`二维码渲染失败：${errorMessage(error)}`)
      sendText(res, 500, 'could not render the QR code')
      return
    }
    res.statusCode = 200
    res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8')
    res.setHeader('Cache-Control', 'no-store')
    res.end(svg)
  }

  /**
   * `POST /logout` — stop the channel and drop the stored credentials.
   *
   * @param {object} _req - request.
   * @param {object} res - response.
   * @returns {Promise<void>}
   */
  async function handleLogout(_req, res) {
    const svc = service()
    pending.clear()
    try {
      await svc?.stop?.()
    } catch (error) {
      log('warn', `wechat-ilink: stop before logout failed: ${errorMessage(error)}`)
    }
    let cleared = false
    let failure = ''
    try {
      if (typeof svc?.logout === 'function') {
        await svc.logout()
        cleared = true
      } else if (typeof svc?.forgetAccount === 'function') {
        await svc.forgetAccount()
        cleared = true
      }
    } catch (error) {
      failure = errorMessage(error)
    }
    try {
      await accountStore().clear()
      cleared = true
    } catch (error) {
      failure = failure || errorMessage(error)
    }
    if (!cleared) {
      const message = `解绑失败：${failure || '未知错误'}`
      recordError(message)
      sendJson(res, 500, { ok: false, message })
      return
    }
    forgetCachedAccount(svc)
    lastError = undefined
    sendJson(res, 200, { ok: true, bound: false, message: '已解绑微信 ClawBot' })
  }

  /**
   * `GET /workspaces` — workspaces the host exposes to the channel.
   *
   * @param {object} _req - request.
   * @param {object} res - response.
   * @returns {Promise<void>}
   */
  async function handleWorkspaces(_req, res) {
    const svc = service()
    const method = firstMethod(svc, ['listWorkspaces', 'getWorkspaces', 'workspaces'])
    if (method === undefined) {
      sendJson(res, 200, {
        available: false,
        items: [],
        message: '当前宿主未提供工作区能力（微信桥接的工作区支持尚未就绪）',
      })
      return
    }
    try {
      const value = await method()
      sendJson(res, 200, { available: true, items: normalizeItems(value, WORKSPACE_FIELDS) })
    } catch (error) {
      const message = `读取工作区失败：${errorMessage(error)}`
      recordError(message)
      sendJson(res, 500, { available: false, items: [], message })
    }
  }

  /**
   * `GET /sessions[?workspace=]` — sessions the host exposes to the channel.
   *
   * @param {object} _req - request.
   * @param {object} res - response.
   * @param {URL} url - parsed request URL.
   * @returns {Promise<void>}
   */
  async function handleSessions(_req, res, url) {
    const svc = service()
    const method = firstMethod(svc, ['listSessions', 'getSessions', 'sessions'])
    if (method === undefined) {
      sendJson(res, 200, {
        available: false,
        items: [],
        message: '当前宿主未提供会话列表能力（微信桥接的会话复用尚未就绪）',
      })
      return
    }
    const workspace = readString(url.searchParams.get('workspace'))
    try {
      const value = workspace ? await method({ workspace }) : await method()
      sendJson(res, 200, {
        available: true,
        items: normalizeItems(value, SESSION_FIELDS, { aliasSessionId: true }),
      })
    } catch (error) {
      const message = `读取会话失败：${errorMessage(error)}`
      recordError(message)
      sendJson(res, 500, { available: false, items: [], message })
    }
  }

  /**
   * `POST /bind` — choose the workspace/session the channel should reuse.
   *
   * @param {object} req - request.
   * @param {object} res - response.
   * @returns {Promise<void>}
   */
  async function handleBind(req, res) {
    let body
    try {
      body = await readJsonBody(req)
    } catch (error) {
      sendJson(res, error?.status ?? 400, { ok: false, message: errorMessage(error) })
      return
    }
    const workspace = readString(body?.workspace)
    const sessionId = readString(body?.sessionId)
    if (!workspace && !sessionId) {
      sendJson(res, 400, { ok: false, message: '请至少提供 workspace 或 sessionId' })
      return
    }
    const svc = service()
    const method = firstMethod(svc, ['bind', 'setBinding', 'selectBinding'])
    if (method === undefined) {
      sendJson(res, 200, {
        ok: false,
        available: false,
        message: '当前宿主未提供绑定切换能力（微信桥接的工作区/会话切换尚未就绪）',
      })
      return
    }
    try {
      const result = await method({ ...(workspace ? { workspace } : {}), ...(sessionId ? { sessionId } : {}) })
      if (result && typeof result === 'object' && result.ok === false) {
        sendJson(res, 200, { ok: false, available: true, message: readString(result.message) || '切换失败' })
        return
      }
      sendJson(res, 200, {
        ok: true,
        available: true,
        workspace: readString(result?.workspace) || workspace,
        sessionId: readString(result?.sessionId) || sessionId,
        ...(readString(result?.message) ? { message: readString(result.message) } : {}),
      })
    } catch (error) {
      const message = `切换绑定失败：${errorMessage(error)}`
      recordError(message)
      sendJson(res, 500, { ok: false, available: true, message })
    }
  }

  // ────────────────────────────── dispatch ──────────────────────────────

  /** @type {Record<string, { methods: string[], run: Function }>} */
  const routes = {
    '/status': { methods: ['GET'], run: handleStatus },
    '/settings': { methods: ['POST'], run: handleSettings },
    '/login/begin': { methods: ['POST'], run: handleLoginBegin },
    '/login/poll': { methods: ['GET'], run: handleLoginPoll },
    '/qr.svg': { methods: ['GET'], run: handleQrImage },
    '/logout': { methods: ['POST'], run: handleLogout },
    '/workspaces': { methods: ['GET'], run: handleWorkspaces },
    '/sessions': { methods: ['GET'], run: handleSessions },
    '/bind': { methods: ['POST'], run: handleBind },
    '/feishu/status': { methods: ['GET'], run: handleFeishuStatus },
    '/feishu/login/begin': { methods: ['POST'], run: handleFeishuLoginBegin },
    '/feishu/login/poll': { methods: ['GET'], run: handleFeishuLoginPoll },
    '/feishu/qr.svg': { methods: ['GET'], run: handleFeishuQrImage },
    '/feishu/bind': { methods: ['POST'], run: handleFeishuBind },
    '/feishu/logout': { methods: ['POST'], run: handleFeishuLogout },
  }

  /**
   * Serve one request.
   *
   * @param {object} req - node `IncomingMessage`.
   * @param {object} res - node `ServerResponse`.
   * @returns {Promise<void>}
   */
  async function handler(req, res) {
    if (disposed) {
      sendJson(res, 503, { ok: false, message: '插件已卸载' })
      return
    }
    if (!isSameOrigin(req)) {
      sendJson(res, 403, { ok: false, message: 'forbidden' })
      return
    }
    let url
    try {
      url = new URL(readString(req?.url) || '/', 'http://wechat-ilink.invalid')
    } catch {
      sendJson(res, 400, { ok: false, message: 'invalid request url' })
      return
    }
    const path = routePath(url.pathname)
    const route = Object.prototype.hasOwnProperty.call(routes, path) ? routes[path] : undefined
    if (route === undefined) {
      sendJson(res, 404, { ok: false, message: `unknown endpoint ${path}` })
      return
    }
    const method = (readString(req?.method) || 'GET').toUpperCase()
    if (!route.methods.includes(method)) {
      res.setHeader?.('Allow', route.methods.join(', '))
      sendJson(res, 405, { ok: false, message: `method ${method} not allowed` })
      return
    }
    try {
      await route.run(req, res, url)
    } catch (error) {
      const message = `内部错误：${errorMessage(error)}`
      recordError(message)
      if (res.headersSent) {
        res.destroy?.()
        return
      }
      sendJson(res, 500, { ok: false, message })
    }
  }

  return {
    prefix: WEB_API_PREFIX,
    handler,
    recordError,
    dispose() {
      disposed = true
      pending.clear()
    },
  }
}

/**
 * Restart the channel so it picks up freshly stored credentials.
 *
 * Preferred order: a service method that owns the reconnect (`reload`,
 * `applyAccount`, `restart`). When none exists, the channel is restarted through
 * its public `started`/`stopped`/`start`/`stop` fields — a compatibility shim
 * that disappears as soon as the service grows `reload()`. A channel that was
 * never started (for example `autoConnect: false`) is left alone: the operator's
 * explicit choice wins over the UI.
 *
 * Never throws: a login must not fail because the reconnect did.
 *
 * @param {object | undefined} svc - the channel service.
 * @param {object} account - the stored account record.
 * @returns {Promise<string>} which path was taken (for tests and logs).
 */
export async function reconnect(svc, account) {
  if (!svc || typeof svc !== 'object') return 'no-service'
  for (const name of ['reload', 'applyAccount', 'restart']) {
    if (typeof svc[name] !== 'function') continue
    try {
      await svc[name](account)
      return name
    } catch {
      return `${name}-failed`
    }
  }
  if (
    typeof svc.start === 'function' &&
    typeof svc.stop === 'function' &&
    'started' in svc &&
    'stopped' in svc
  ) {
    const wasStarted = svc.started === true
    try {
      await svc.stop()
    } catch {
      return 'restart-shim-stop-failed'
    }
    if (!wasStarted) return 'restart-shim-skipped'
    svc.stopped = false
    svc.started = false
    try {
      await svc.start()
      return 'restart-shim'
    } catch {
      return 'restart-shim-start-failed'
    }
  }
  return 'persisted-only'
}

/**
 * Drop the channel's cached account so `/status` stops reporting "bound".
 *
 * Only used when the service exposes no `logout`/`forgetAccount` of its own.
 *
 * @param {object | undefined} svc - the channel service.
 * @returns {void}
 */
function forgetCachedAccount(svc) {
  if (!svc || typeof svc !== 'object') return
  if (typeof svc.logout === 'function' || typeof svc.forgetAccount === 'function') return
  for (const key of ['account', 'client']) {
    try {
      if (key in svc) svc[key] = undefined
    } catch {
      // A frozen service keeps its cache; `/status` still reads the empty store.
    }
  }
}

/**
 * Resolve the iLink base URL from the service config or the plugin config.
 *
 * @param {object | undefined} svc - channel service.
 * @param {object} config - plugin config.
 * @returns {string} the base URL, or `''` to use the protocol default.
 */
function resolveBaseUrl(svc, config) {
  return readString(svc?.config?.baseUrl) || readString(config?.baseUrl)
}

/**
 * Read the first callable method of the given names.
 *
 * @param {object | undefined} target - service.
 * @param {string[]} names - candidate method names.
 * @returns {((...args: unknown[]) => unknown) | undefined} the bound method.
 */
function firstMethod(target, names) {
  if (!target || typeof target !== 'object') return undefined
  for (const name of names) {
    const candidate = target[name]
    if (typeof candidate === 'function') return candidate.bind(target)
  }
  return undefined
}

/**
 * Call a method, swallowing any throw.
 *
 * @param {object | undefined} target - service.
 * @param {string} name - method name.
 * @returns {unknown} the return value, or undefined.
 */
function safeCall(target, name) {
  const method = firstMethod(target, [name])
  if (method === undefined) return undefined
  try {
    return method()
  } catch {
    return undefined
  }
}

/**
 * Normalize a service list into JSON-safe rows.
 *
 * @param {unknown} value - array, or `{ items | list | sessions | workspaces }`.
 * @param {string[]} fields - fields to copy.
 * @param {{ aliasSessionId?: boolean }} [options] - when `aliasSessionId` is set,
 * a row's `id` is also published as `sessionId` (session records use both
 * spellings across host services).
 * @returns {object[]} normalized rows.
 */
function normalizeItems(value, fields, options = {}) {
  let list = []
  if (Array.isArray(value)) list = value
  else if (value && typeof value === 'object') {
    for (const key of ['items', 'list', 'sessions', 'workspaces', 'rows']) {
      if (Array.isArray(value[key])) {
        list = value[key]
        break
      }
    }
  }
  const out = []
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue
    const row = {}
    for (const field of fields) {
      const raw = entry[field]
      if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') row[field] = raw
    }
    if (options.aliasSessionId === true && row.sessionId === undefined && typeof row.id === 'string') {
      row.sessionId = row.id
    }
    if (Object.keys(row).length > 0) out.push(row)
  }
  return out
}

/**
 * @param {unknown} result - a `pollLogin` result.
 * @returns {string} the bot id, or `''`.
 */
function botIdOf(result) {
  return readString(result?.botId) || readString(result?.bot_id)
}

/**
 * Strip the API prefix from a request pathname.
 *
 * @param {string} pathname - raw pathname.
 * @returns {string} the route path (for example `/login/begin`).
 */
function routePath(pathname) {
  let path = pathname
  if (path === WEB_API_PREFIX) path = '/'
  else if (path.startsWith(`${WEB_API_PREFIX}/`)) path = path.slice(WEB_API_PREFIX.length)
  const trimmed = path.replace(/\/+$/, '')
  return trimmed === '' ? '/' : trimmed
}

/**
 * Reject cross-site browser requests while keeping same-origin and non-browser
 * clients working.
 *
 * A browser always attaches `Origin` to a cross-origin request and marks it
 * `Sec-Fetch-Site: cross-site`, so those two headers are enough to block a
 * malicious page from driving the API; the loopback/LAN host is deliberately
 * *not* pinned, because the host webServer may legitimately bind `0.0.0.0`.
 *
 * @param {object} req - request.
 * @returns {boolean} whether the request may proceed.
 */
function isSameOrigin(req) {
  const headers = req?.headers ?? {}
  const site = readString(headers['sec-fetch-site']).toLowerCase()
  if (site === 'cross-site') return false
  const origin = readString(headers.origin)
  if (!origin) return true
  const host = readString(headers.host)
  if (!host) return false
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

/**
 * Read and parse a JSON request body.
 *
 * @param {object} req - request.
 * @param {number} [limit] - maximum accepted size in bytes.
 * @returns {Promise<object>} the parsed body (`{}` when empty).
 */
function readJsonBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let settled = false
    const fail = (status, message) => {
      if (settled) return
      settled = true
      reject(Object.assign(new Error(message), { status }))
    }
    if (typeof req?.on !== 'function') {
      resolve({})
      return
    }
    req.on('data', (chunk) => {
      size += chunk?.length ?? 0
      if (size > limit) {
        fail(413, '请求体过大')
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (settled) return
      const text = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8').trim()
      if (text === '') {
        settled = true
        resolve({})
        return
      }
      try {
        const parsed = JSON.parse(text)
        settled = true
        resolve(parsed && typeof parsed === 'object' ? parsed : {})
      } catch {
        fail(400, '请求体不是合法 JSON')
      }
    })
    req.on('error', (error) => fail(400, `读取请求体失败：${errorMessage(error)}`))
  })
}

/**
 * Send a JSON response.
 *
 * @param {object} res - response.
 * @param {number} status - HTTP status.
 * @param {object} body - JSON-serializable body.
 * @returns {void}
 */
function sendJson(res, status, body) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(body))
}

/**
 * Send a plain-text response.
 *
 * @param {object} res - response.
 * @param {number} status - HTTP status.
 * @param {string} text - body.
 * @returns {void}
 */
function sendText(res, status, text) {
  res.statusCode = status
  res.setHeader('Content-Type', 'text/plain; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(text)
}

/**
 * @param {unknown} value - any value.
 * @returns {string} the value when it is a non-empty string, else `''`.
 */
function readString(value) {
  return typeof value === 'string' ? value : ''
}

/**
 * @param {unknown} error - a thrown value.
 * @returns {string} a human-readable message.
 */
function errorMessage(error) {
  if (error instanceof Error) return error.message
  return String(error)
}
