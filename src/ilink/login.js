/**
 * iLink QR-code login (unauthenticated GET surface).
 *
 * Protocol truth source (read-only reference):
 *   `zai-org/ZCode` `packages/services/src/bots/providers/packages/services/src/bots/providers/weixinRegistration.ts`
 * Frozen contract: `docs/INTERFACES.md` §1 + §3.2.
 *
 * @module wechat-feishu-linker/ilink/login
 */
import {
  DEFAULT_ILINK_BASE_URL,
  ILINK_APP_ID,
  ILINK_BOT_API_PREFIX,
  IlinkApiError,
  IlinkHttpError,
} from './client.js'

/** Header sent on unauthenticated login GETs. 对齐 ZCode weixinRegistration.ts:89 */
export const ILINK_APP_CLIENT_VERSION = '1'

/** Default timeout for the QR endpoints. */
export const DEFAULT_LOGIN_TIMEOUT_MS = 30_000

/** QR code lifetime assumed when the server does not return `expires_in`. */
export const DEFAULT_QR_EXPIRES_IN_SECONDS = 120

/**
 * Suggested interval between {@link pollLogin} calls.
 * The QR endpoints are short GETs (the status call may hang while waiting for the phone),
 * so the caller polls serially.
 */
export const LOGIN_POLL_INTERVAL_MS = 3_000

/** `status` values accepted by {@link normalizeQrStatus}. */
const SUCCESS_STATUSES = new Set(['confirmed', 'confirm', 'authorized', 'success', 'ok'])
const SCANNED_STATUSES = new Set(['scaned', 'scanned', 'scan', 'confirmed_wait'])
const EXPIRED_STATUSES = new Set(['expired', 'expire', 'timeout', 'cancel', 'cancelled', 'canceled'])
const ERROR_STATUSES = new Set(['error', 'failed', 'fail'])
const PENDING_STATUSES = new Set(['pending', 'wait', 'waiting', 'new'])

/**
 * Start a QR login: fetch a fresh QR code and its image URL.
 *
 * @param {{ baseUrl?: string, fetchImpl?: typeof fetch, timeoutMs?: number }} [options]
 * @returns {Promise<{ qrcode: string, qrUrl: string, expiresIn: number, expiresAt: number }>}
 *   `expiresIn` is in seconds, `expiresAt` is an absolute epoch millisecond timestamp.
 * @throws {IlinkHttpError} Non-2xx response.
 * @throws {IlinkApiError} `ret !== 0 || errcode !== 0`, or a payload without a QR code.
 */
export async function beginLogin(options = {}) {
  const {
    baseUrl = DEFAULT_ILINK_BASE_URL,
    fetchImpl = globalThis.fetch,
    timeoutMs = DEFAULT_LOGIN_TIMEOUT_MS,
  } = options
  const payload = await loginGet('/get_bot_qrcode?bot_type=3', { baseUrl, fetchImpl, timeoutMs })
  const qrcode = readString(payload, 'qrcode') || readString(payload, 'qr_code')
  const qrUrl = readString(payload, 'qrcode_img_content') || readString(payload, 'qrcode_url') || qrcode
  if (!qrcode || !qrUrl) {
    throw new IlinkApiError('/get_bot_qrcode', {
      errmsg: 'iLink login did not return a QR code.',
      payload,
    })
  }
  const expiresIn = toFiniteNumber(payload.expires_in) ?? DEFAULT_QR_EXPIRES_IN_SECONDS
  return { qrcode, qrUrl, expiresIn, expiresAt: Date.now() + expiresIn * 1000 }
}

/**
 * Poll the QR login status once.
 *
 * A hanging/timing-out status call is **not** an error — it is normal while the server waits
 * for the phone to confirm — so it is reported as `pending`.
 * 对齐 ZCode weixinRegistration.ts:157-163.
 *
 * @param {{ qrcode: string, baseUrl?: string, fetchImpl?: typeof fetch, timeoutMs?: number }} options
 * @returns {Promise<{ status: 'pending'|'scanned'|'success'|'expired'|'error', botToken?: string, botId?: string, message?: string }>}
 * @throws {TypeError} When `qrcode` is missing.
 */
export async function pollLogin(options = {}) {
  const {
    qrcode,
    baseUrl = DEFAULT_ILINK_BASE_URL,
    fetchImpl = globalThis.fetch,
    timeoutMs = DEFAULT_LOGIN_TIMEOUT_MS,
  } = options
  if (typeof qrcode !== 'string' || qrcode.trim() === '') {
    throw new TypeError('pollLogin requires a qrcode')
  }

  let payload
  try {
    payload = await loginGet(`/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`, {
      baseUrl,
      fetchImpl,
      timeoutMs,
    })
  } catch (error) {
    // The status endpoint holds the connection while waiting for the phone; a timeout means
    // "keep polling", not "login failed". Transport errors are surfaced as `status: 'error'`
    // so the caller can keep its loop running.
    if (isTimeoutLike(error)) return { status: 'pending' }
    return { status: 'error', message: errorMessage(error) }
  }

  const status = normalizeQrStatus(
    payload.status ?? payload.qrcode_status ?? payload.qr_status,
  )
  if (status === 'success') {
    const botToken = readString(payload, 'bot_token') || readString(payload, 'token')
    if (!botToken) {
      return { status: 'error', message: 'iLink login succeeded but did not return bot_token.' }
    }
    const botId = readString(payload, 'ilink_bot_id') || readString(payload, 'bot_id')
    return { status: 'success', botToken, ...(botId ? { botId } : {}) }
  }
  if (status === 'expired') return { status: 'expired' }
  if (status === 'error') {
    return {
      status: 'error',
      message: readString(payload, 'errmsg') || readString(payload, 'message') || 'iLink login failed.',
    }
  }
  return { status }
}

/**
 * Normalize a QR status value coming from the server.
 *
 * Numeric codes: `0 = pending`, `1 = scanned`, `2 = success`, `3|4 = expired`.
 * Strings: `confirmed` → success, `scaned`/`scanned` → scanned, `expired` → expired,
 * `error`/`failed` → error; anything unknown (including `null`) → pending.
 * 对齐 ZCode weixinRegistration.ts:104-128 + docs/INTERFACES.md §1.
 *
 * @param {unknown} status Raw `status` / `qrcode_status` / `qr_status` value.
 * @returns {'pending'|'scanned'|'success'|'expired'|'error'}
 */
export function normalizeQrStatus(status) {
  if (typeof status === 'number' && Number.isFinite(status)) return QR_NUMERIC_STATUS[status] ?? 'pending'
  if (typeof status === 'string') {
    const normalized = status.trim().toLowerCase()
    if (/^\d+$/.test(normalized)) return QR_NUMERIC_STATUS[Number(normalized)] ?? 'pending'
    if (SUCCESS_STATUSES.has(normalized)) return 'success'
    if (SCANNED_STATUSES.has(normalized)) return 'scanned'
    if (EXPIRED_STATUSES.has(normalized)) return 'expired'
    if (ERROR_STATUSES.has(normalized)) return 'error'
    if (PENDING_STATUSES.has(normalized)) return 'pending'
  }
  return 'pending'
}

/** @type {Record<number, 'pending'|'scanned'|'success'|'expired'>} */
const QR_NUMERIC_STATUS = {
  0: 'pending',
  1: 'scanned',
  2: 'success',
  3: 'expired',
  4: 'expired',
}

/**
 * GET a JSON endpoint of the login surface.
 *
 * @param {string} path Endpoint path including the query string.
 * @param {{ baseUrl: string, fetchImpl: typeof fetch, timeoutMs: number }} options
 * @returns {Promise<Record<string, unknown>>} Payload with a nested `data` object merged in.
 * @throws {IlinkHttpError|IlinkApiError}
 */
async function loginGet(path, options) {
  const { baseUrl, fetchImpl, timeoutMs } = options
  const origin = String(baseUrl ?? DEFAULT_ILINK_BASE_URL).replace(/\/+$/, '')
  const doFetch = typeof fetchImpl === 'function' ? fetchImpl : globalThis.fetch
  const init = {
    method: 'GET',
    headers: {
      'iLink-App-ClientVersion': ILINK_APP_CLIENT_VERSION,
      'iLink-App-Id': ILINK_APP_ID,
    },
  }
  if (Number.isFinite(timeoutMs) && timeoutMs > 0) init.signal = AbortSignal.timeout(timeoutMs)

  const response = await doFetch(`${origin}${ILINK_BOT_API_PREFIX}${path}`, init)
  const text = typeof response.text === 'function' ? await response.text() : ''
  if (!response.ok) throw new IlinkHttpError(response.status, path, text)
  const payload = parseJsonLoose(text)
  if (!isRecord(payload)) {
    throw new IlinkApiError(path, { errmsg: 'iLink login returned a non-JSON response.', payload })
  }
  const ret = toFiniteNumber(payload.ret)
  const errcode = toFiniteNumber(payload.errcode)
  if ((ret !== null && ret !== 0) || (errcode !== null && errcode !== 0)) {
    throw new IlinkApiError(path, {
      ret,
      errcode,
      errmsg: readString(payload, 'errmsg') || readString(payload, 'message'),
      payload,
    })
  }
  return isRecord(payload.data) ? { ...payload, ...payload.data } : payload
}

/**
 * @param {unknown} error
 * @returns {boolean} Whether the error is a client-side timeout rather than a real failure.
 */
function isTimeoutLike(error) {
  const name = isRecord(error) ? error.name : undefined
  // `AbortSignal.timeout()` rejects with a `TimeoutError` DOMException; some undici versions
  // surface a plain `AbortError`. Both mean "server is still holding the long poll".
  return name === 'TimeoutError' || name === 'AbortError'
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function errorMessage(error) {
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * @param {string} text
 * @returns {unknown} Parsed JSON, `{}` when empty, or the raw text when it is not JSON.
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
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null
}

/**
 * @param {Record<string, unknown>} record
 * @param {string} key
 * @returns {string}
 */
function readString(record, key) {
  const value = record[key]
  return typeof value === 'string' ? value : ''
}

/**
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
