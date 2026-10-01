/**
 * iLink ClawBot HTTP client (`/ilink/bot/*`) — authenticated POST surface.
 *
 * Protocol truth source (read-only reference):
 *   [`zai-org/ZCode`](https://github.com/zai-org/ZCode) `packages/services/src/bots/providers/weixinProvider.ts`
 *   cross-checked against the eight independent open-source iLink clients (8 independent implementations).
 * Frozen contract: `docs/INTERFACES.md` §1 + §3.1.
 *
 * @module wechat-feishu-linker/ilink/client
 */
import { Buffer } from 'node:buffer'
import { randomInt, randomUUID } from 'node:crypto'
import { buildSendBody, extractNextBuf, readRawMessages } from './normalize.js'

/** iLink bot API origin. 对齐 ZCode weixinProvider.ts:13 */
export const DEFAULT_ILINK_BASE_URL = 'https://ilinkai.weixin.qq.com'

/** Path prefix for every bot endpoint. 对齐 ZCode weixinProvider.ts:14 */
export const ILINK_BOT_API_PREFIX = '/ilink/bot'

/**
 * Value sent as `base_info.channel_version`.
 * The server does not validate this value (1.0.0 / 2.4.6 both work), but `base_info`
 * itself must be present or `sendmessage` silently drops the message.
 * 对齐 ZCode weixinProvider.ts:15 + docs/INTERFACES.md §1.
 */
export const CHANNEL_VERSION = '2.0.0'

/** Default timeout for short POSTs (sendmessage / getconfig / sendtyping). */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000

/**
 * Default client-side timeout for the `/getupdates` long poll.
 * The server holds the connection for at most ~35 s; clients must wait a little longer
 * than the server so a normal idle hold is not mistaken for a failure.
 * 对齐 docs/INTERFACES.md §1 + Cp0204 WeClawBot-API main.go:388 (45 s).
 */
export const DEFAULT_GET_UPDATES_TIMEOUT_MS = 45_000

/** Safety margin added on top of a server-reported `longpolling_timeout_ms`. */
export const LONGPOLL_SAFETY_MARGIN_MS = 10_000

/** Lower/upper bound for the adopted long-poll timeout. */
export const MIN_GET_UPDATES_TIMEOUT_MS = 38_000
export const MAX_GET_UPDATES_TIMEOUT_MS = 60_000

/** App id header expected by the 2.x iLink surface. */
export const ILINK_APP_ID = 'bot'

/**
 * Thrown when the HTTP transport itself fails (non-2xx status).
 *
 * @property {number} status HTTP status code.
 * @property {string} path Endpoint path that was requested.
 * @property {string} bodyText Raw response body (may be empty).
 */
export class IlinkHttpError extends Error {
  /**
   * @param {number} status HTTP status code.
   * @param {string} path Endpoint path (e.g. `/getupdates`).
   * @param {string} [bodyText] Raw response body.
   */
  constructor(status, path, bodyText = '') {
    super(`iLink ${path} failed: HTTP ${status}`)
    this.name = 'IlinkHttpError'
    this.status = status
    this.path = path
    this.bodyText = bodyText
  }
}

/**
 * Thrown when the iLink business envelope reports a failure (`ret !== 0 || errcode !== 0`).
 *
 * @property {number|null} ret Business `ret` code (`null` when absent, e.g. pre-flight failures).
 * @property {number|null} errcode Business `errcode` (`null` when absent).
 * @property {string} errmsg Human readable message from `errmsg`/`message`.
 * @property {string} path Endpoint path that was requested.
 * @property {unknown} payload Full response payload, for diagnostics.
 */
export class IlinkApiError extends Error {
  /**
   * @param {string} path Endpoint path (e.g. `/sendmessage`).
   * @param {{ ret?: number|null, errcode?: number|null, errmsg?: string, payload?: unknown }} [details]
   */
  constructor(path, details = {}) {
    const ret = details.ret ?? null
    const errcode = details.errcode ?? null
    const errmsg = details.errmsg ?? ''
    const detail = errmsg || `ret=${ret ?? ''} errcode=${errcode ?? ''}`.trim()
    super(`iLink ${path} failed: ${detail}`)
    this.name = 'IlinkApiError'
    this.ret = ret
    this.errcode = errcode
    this.errmsg = errmsg
    this.path = path
    this.payload = details.payload
  }
}

/**
 * `IlinkApiError` subclass for `errcode === -14` (login state expired).
 *
 * The upper layer is expected to catch this specific type and trigger a new QR login,
 * instead of retrying the request forever.
 * 对齐 docs/INTERFACES.md §1 + weclaw ilink/monitor.go:91-107, wechat-ilink-demo bot.mjs:382-385.
 */
export class IlinkAuthError extends IlinkApiError {
  /**
   * @param {string} path Endpoint path.
   * @param {{ ret?: number|null, errcode?: number|null, errmsg?: string, payload?: unknown }} [details]
   */
  constructor(path, details = {}) {
    super(path, { errcode: -14, ...details })
    this.name = 'IlinkAuthError'
  }
}

/** `errcode` meaning "login state expired, scan again". */
export const ILINK_ERRCODE_SESSION_EXPIRED = -14

/** `ret` returned by `sendmessage` when the supplied `context_token` is stale. */
export const ILINK_RET_STALE_CONTEXT_TOKEN = -2

/**
 * Build the authenticated request headers for a POST.
 *
 * `X-WECHAT-UIN` is `base64(String(randomUint32))` and is regenerated for every request.
 * 对齐 ZCode weixinProvider.ts:101-112 + docs/INTERFACES.md §1.
 *
 * @param {string} token Bot token (`Authorization: Bearer <token>`).
 * @param {{ randomUin?: number | (() => number) }} [options]
 *   `randomUin` overrides the random source (a uint32, or a function returning one).
 *   Used by tests to make the header deterministic; production leaves it unset.
 * @returns {Record<string, string>} Header map.
 */
export function buildHeaders(token, { randomUin } = {}) {
  return {
    'content-type': 'application/json',
    AuthorizationType: 'ilink_bot_token',
    Authorization: `Bearer ${token}`,
    'X-WECHAT-UIN': buildRandomWechatUin(randomUin),
    'iLink-App-Id': ILINK_APP_ID,
  }
}

/**
 * Create an authenticated iLink client.
 *
 * Every network call goes through the injectable `fetchImpl`, so tests never touch the network.
 *
 * @param {object} opts
 * @param {string} opts.token Bot token from the QR login flow.
 * @param {string} [opts.baseUrl] API origin (default `https://ilinkai.weixin.qq.com`).
 * @param {typeof fetch} [opts.fetchImpl] Fetch implementation (default `globalThis.fetch`).
 * @param {number} [opts.requestTimeoutMs] Default timeout for short POSTs.
 * @param {{ debug?: Function, warn?: Function, error?: Function }} [opts.logger] Optional logger.
 * @param {string} [opts.fromUserId] Bot's own iLink user id (sent as `msg.from_user_id`; `""` is valid).
 * @param {string} [opts.clientId] Fixed `msg.client_id`; by default a fresh `dsh-wechat-<uuid>` per send.
 * @param {number | (() => number)} [opts.randomUin] Override for the `X-WECHAT-UIN` random source.
 * @returns {{
 *   token: string,
 *   request: (path: string, body?: unknown, options?: { timeoutMs?: number, signal?: AbortSignal }) => Promise<unknown>,
 *   getConfig: (options?: { ilinkUserId?: string, contextToken?: string, signal?: AbortSignal }) => Promise<object>,
 *   getUpdates: (options?: { buf?: string, signal?: AbortSignal }) => Promise<{ rawMessages: object[], buf: string, payload: unknown, longpollingTimeoutMs: number, serverLongpollingTimeoutMs: number|null }>,
 *   sendMessage: (options: { toUserId: string, text: string, contextToken?: string, signal?: AbortSignal }) => Promise<unknown>,
 *   sendTyping: (options?: { toUserId?: string, contextToken?: string, signal?: AbortSignal }) => Promise<boolean>,
 * }}
 */
export function createIlinkClient(opts = {}) {
  const {
    token,
    baseUrl = DEFAULT_ILINK_BASE_URL,
    fetchImpl = globalThis.fetch,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    logger,
    fromUserId = '',
    clientId,
    randomUin,
  } = opts

  const normalizedToken = typeof token === 'string' ? token.trim() : ''
  const base = String(baseUrl ?? DEFAULT_ILINK_BASE_URL).replace(/\/+$/, '')
  const doFetch = typeof fetchImpl === 'function' ? fetchImpl : globalThis.fetch
  const defaultTimeoutMs = Number.isFinite(requestTimeoutMs) && requestTimeoutMs > 0
    ? requestTimeoutMs
    : DEFAULT_REQUEST_TIMEOUT_MS
  const fixedClientId = typeof clientId === 'string' && clientId !== '' ? clientId : ''

  // Adopted from `longpolling_timeout_ms` on each successful /getupdates response.
  let longPollTimeoutMs = DEFAULT_GET_UPDATES_TIMEOUT_MS

  /**
   * `typing_ticket` per peer, fetched once and reused.
   *
   * The ticket is what `/sendtyping` needs, and `getconfig` is what mints it —
   * but `getconfig` takes the peer's `context_token`, which is short-lived. A
   * turn that runs for minutes outlives that token, so re-fetching the ticket on
   * every heartbeat is exactly how the indicator dies mid-turn: the first
   * refresh works and every later one fails on a stale token. Caching the ticket
   * keeps the indicator alive for the whole turn (the precedent implementations
   * cache it per user for the same reason).
   *
   * @type {Map<string, string>}
   */
  const typingTickets = new Map()

  /**
   * POST a JSON body to `/ilink/bot<path>`.
   *
   * @param {string} path Endpoint path, with or without a leading slash.
   * @param {unknown} [body] Business body; `base_info` is always prepended.
   * @param {{ timeoutMs?: number, signal?: AbortSignal }} [options]
   * @returns {Promise<unknown>} Parsed payload (`{}` when the server returns an empty body).
   * @throws {IlinkHttpError} Non-2xx response.
   * @throws {IlinkApiError|IlinkAuthError} `ret !== 0 || errcode !== 0`.
   */
  async function request(path, body, options = {}) {
    const endpoint = normalizePath(path)
    if (!normalizedToken) {
      throw new IlinkApiError(endpoint, {
        errmsg: 'iLink bot token is missing; scan the login QR code first.',
      })
    }
    const { timeoutMs = defaultTimeoutMs, signal } = options
    const init = {
      method: 'POST',
      headers: buildHeaders(normalizedToken, { randomUin }),
      body: JSON.stringify(withBaseInfo(body)),
    }
    const combined = combineSignals(signal, timeoutMs)
    if (combined) init.signal = combined

    logger?.debug?.(`[wechat-ilink] POST ${endpoint}`)
    const response = await doFetch(`${base}${ILINK_BOT_API_PREFIX}${endpoint}`, init)
    const text = typeof response.text === 'function' ? await response.text() : ''
    if (!response.ok) throw new IlinkHttpError(response.status, endpoint, text)
    const payload = parseJsonLoose(text)
    assertApiOk(endpoint, payload)
    return payload
  }

  /**
   * `POST /getconfig` → `{ typing_ticket, ... }`.
   *
   * @param {{ ilinkUserId?: string, contextToken?: string, signal?: AbortSignal }} [options]
   * @returns {Promise<object>} Config payload, with a nested `data` object merged in.
   */
  async function getConfig(options = {}) {
    const { ilinkUserId, contextToken, signal } = options
    const body = {}
    if (ilinkUserId) body.ilink_user_id = ilinkUserId
    if (contextToken) body.context_token = contextToken
    const payload = await request('/getconfig', body, { signal })
    return isRecord(payload)
      ? (isRecord(payload.data) ? { ...payload, ...payload.data } : payload)
      : {}
  }

  /**
   * `POST /getupdates` — long poll for inbound messages.
   *
   * The timeout starts at {@link DEFAULT_GET_UPDATES_TIMEOUT_MS} and is re-adopted from the
   * server's `longpolling_timeout_ms` after every successful response.
   *
   * @param {{ buf?: string, signal?: AbortSignal }} [options] `buf` is the persisted cursor.
   * @returns {Promise<{ rawMessages: object[], buf: string, payload: unknown, longpollingTimeoutMs: number, serverLongpollingTimeoutMs: number|null }>}
   *   `buf` falls back to the input cursor when the response carries no new one.
   */
  async function getUpdates(options = {}) {
    const { buf = '', signal } = options
    const currentBuf = typeof buf === 'string' ? buf : ''
    const usedTimeoutMs = longPollTimeoutMs
    const payload = await request(
      '/getupdates',
      { get_updates_buf: currentBuf },
      { timeoutMs: usedTimeoutMs, signal },
    )
    const serverTimeoutMs = isRecord(payload) ? toFiniteNumber(payload.longpolling_timeout_ms) : null
    if (serverTimeoutMs !== null) longPollTimeoutMs = resolveLongPollTimeout(serverTimeoutMs, longPollTimeoutMs)
    return {
      rawMessages: readRawMessages(payload),
      buf: extractNextBuf(payload) ?? currentBuf,
      payload,
      longpollingTimeoutMs: usedTimeoutMs,
      serverLongpollingTimeoutMs: serverTimeoutMs,
    }
  }

  /**
   * `POST /sendmessage` — send one text message.
   *
   * `base_info`, `msg.from_user_id` (even when empty) and `msg.client_id` are always present:
   * missing any of them makes the server answer HTTP 200 + `{}` without delivering.
   * A `ret === -2` answer means the `context_token` went stale → retried once without it.
   * 对齐 docs/INTERFACES.md §1 + CLI-WeChat-Bridge wechat-transport.ts:254-262.
   *
   * @param {{ toUserId: string, text: string, contextToken?: string, signal?: AbortSignal }} options
   * @returns {Promise<unknown>} Server payload (usually `{}`; delivery is not acknowledged).
   */
  async function sendMessage(options = {}) {
    const { toUserId, text, contextToken, signal } = options
    const sendClientId = fixedClientId || `dsh-wechat-${randomUUID()}`
    const bodyFor = (token) => buildSendBody({ fromUserId, toUserId, text, contextToken: token, clientId: sendClientId })
    try {
      return await request('/sendmessage', bodyFor(contextToken), { signal })
    } catch (error) {
      if (
        error instanceof IlinkApiError &&
        error.ret === ILINK_RET_STALE_CONTEXT_TOKEN &&
        typeof contextToken === 'string' &&
        contextToken !== ''
      ) {
        logger?.warn?.('[wechat-ilink] sendmessage ret=-2 (stale context_token); retrying without context_token')
        return await request('/sendmessage', bodyFor(undefined), { signal })
      }
      throw error
    }
  }

  /**
   * Show "typing…" to a peer.
   *
   * Fetches a `typing_ticket` from `/getconfig` first; when the ticket is unavailable this
   * resolves to `false` instead of throwing (typing is best-effort).
   *
   * @param {{ toUserId?: string, contextToken?: string, signal?: AbortSignal }} [options]
   * @returns {Promise<boolean>} `true` when `/sendtyping` was accepted.
   */
  async function sendTyping(options = {}) {
    const { toUserId, contextToken, signal } = options
    const peerId = typeof toUserId === 'string' ? toUserId.trim() : ''
    let ticket = peerId ? typingTickets.get(peerId) : undefined
    if (!ticket) {
      const config = await getConfig({ ilinkUserId: toUserId, contextToken, signal })
      ticket = readString(config, 'typing_ticket')
      if (!ticket) return false
      if (peerId) typingTickets.set(peerId, ticket)
    }
    try {
      await request(
        '/sendtyping',
        { ilink_user_id: toUserId, typing_ticket: ticket, status: 1 },
        { signal },
      )
      return true
    } catch (error) {
      // A rejected ticket is the one case worth re-minting: drop it so the next
      // heartbeat fetches a fresh one instead of replaying a dead value.
      if (peerId) typingTickets.delete(peerId)
      throw error
    }
  }

  return { token: normalizedToken, request, getConfig, getUpdates, sendMessage, sendTyping }
}

/**
 * Adopt a server-reported long-poll timeout, leaving a safety margin on top.
 *
 * @param {number} serverMs Value of `longpolling_timeout_ms`.
 * @param {number} fallback Timeout to keep when `serverMs` is unusable.
 * @returns {number} Client-side timeout in milliseconds.
 */
export function resolveLongPollTimeout(serverMs, fallback = DEFAULT_GET_UPDATES_TIMEOUT_MS) {
  if (!Number.isFinite(serverMs) || serverMs <= 0) return fallback
  return Math.min(
    Math.max(serverMs + LONGPOLL_SAFETY_MARGIN_MS, MIN_GET_UPDATES_TIMEOUT_MS),
    MAX_GET_UPDATES_TIMEOUT_MS,
  )
}

/**
 * Wrap a business body with the mandatory `base_info` prefix.
 *
 * @param {unknown} body Business body.
 * @returns {Record<string, unknown>} `{ base_info, ...body }`.
 */
function withBaseInfo(body) {
  if (!isRecord(body)) return { base_info: { channel_version: CHANNEL_VERSION } }
  return { base_info: { channel_version: CHANNEL_VERSION }, ...body }
}

/**
 * `base64(decimal string of a random uint32)`.
 * 对齐 ZCode weixinProvider.ts:101-103.
 *
 * @param {number | (() => number)} [randomUin] Deterministic override.
 * @returns {string} Base64 encoded decimal UIN.
 */
function buildRandomWechatUin(randomUin) {
  return Buffer.from(String(nextUint32(randomUin)), 'utf8').toString('base64')
}

/**
 * @param {number | (() => number)} [randomUin]
 * @returns {number} Unsigned 32-bit integer.
 */
function nextUint32(randomUin) {
  if (randomUin !== undefined) {
    const raw = typeof randomUin === 'function' ? randomUin() : randomUin
    const value = Number(raw)
    if (Number.isFinite(value)) return Math.abs(Math.trunc(value)) >>> 0
  }
  return randomInt(0, 0x1_0000_0000)
}

/**
 * Throw when the iLink business envelope reports a failure.
 *
 * @param {string} path Endpoint path.
 * @param {unknown} payload Parsed response.
 * @throws {IlinkAuthError|IlinkApiError}
 */
function assertApiOk(path, payload) {
  if (!isRecord(payload)) return
  const ret = toFiniteNumber(payload.ret)
  const errcode = toFiniteNumber(payload.errcode)
  if ((ret !== null && ret !== 0) || (errcode !== null && errcode !== 0)) {
    const errmsg = readString(payload, 'errmsg') || readString(payload, 'message')
    const details = { ret, errcode, errmsg, payload }
    if (errcode === ILINK_ERRCODE_SESSION_EXPIRED) throw new IlinkAuthError(path, details)
    throw new IlinkApiError(path, details)
  }
}

/**
 * Combine a caller signal with a timeout into one abort signal.
 *
 * @param {AbortSignal | undefined} signal
 * @param {number} timeoutMs
 * @returns {AbortSignal | undefined}
 */
function combineSignals(signal, timeoutMs) {
  const signals = []
  if (signal) signals.push(signal)
  if (Number.isFinite(timeoutMs) && timeoutMs > 0) signals.push(AbortSignal.timeout(timeoutMs))
  if (signals.length === 0) return undefined
  if (signals.length === 1) return signals[0]
  return AbortSignal.any(signals)
}

/**
 * Parse a response body that may legitimately be empty (`sendmessage` answers 200 with no body).
 *
 * @param {string} text Raw body.
 * @returns {unknown} Parsed JSON, `{}` for an empty body, or the raw text when it is not JSON.
 */
function parseJsonLoose(text) {
  if (typeof text !== 'string' || text.trim() === '') return {}
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

/**
 * @param {string} path
 * @returns {string} Path with a guaranteed leading slash.
 */
function normalizePath(path) {
  const value = String(path ?? '')
  return value.startsWith('/') ? value : `/${value}`
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null
}

/**
 * Read a string field.
 *
 * @param {Record<string, unknown> | null | undefined} record
 * @param {string} key
 * @returns {string}
 */
function readString(record, key) {
  const value = record?.[key]
  return typeof value === 'string' ? value : ''
}

/**
 * Read a numeric field, accepting numeric strings (some gateways stringify `ret`).
 *
 * @param {unknown} value
 * @returns {number | null}
 */
function toFiniteNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}
