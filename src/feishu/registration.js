/**
 * Feishu one-click app registration — scan a QR, get the credentials.
 *
 * The platform will create a `PersonalAgent` app for the signed-in user and
 * hand back its `client_id` / `client_secret`, so nobody has to open the
 * developer console, tick scopes and publish a version by hand.
 *
 * The flow is a device-code flow (`/oauth/v1/app/registration`, form-encoded),
 * not a plain OAuth authorize:
 *
 *   init  → does this environment support `client_secret` registration at all
 *   begin → a device code and a URL to encode as a QR
 *   poll  → pending until the user confirms, then the credentials
 *
 * Two details are load-bearing and were each a bug in the reference
 * implementation:
 *
 * 1. **`begin` always goes to the Feishu issuer, even for a Lark tenant.** The
 *    QR is minted there; the tenant's brand only becomes known during `poll`, so
 *    a Lark tenant is discovered then and the polling host switches to
 *    `accounts.larksuite.com` from that point on. Starting at the Lark host
 *    fails for tenants the other way around.
 * 2. **`slow_down` means poll less often, not fail.** Treating it as an error
 *    aborts a registration that is proceeding normally.
 *
 * Zero `@deepseek-ai/*` imports (docs/INTERFACES.md §2.0).
 *
 * @module wechat-feishu-linker/feishu/registration
 */

/** Where the registration endpoints live. */
export const ACCOUNTS_HOSTS = Object.freeze({
  feishu: 'https://accounts.feishu.cn',
  lark: 'https://accounts.larksuite.com',
})

/** The registration path, identical on both hosts. */
export const REGISTRATION_PATH = '/oauth/v1/app/registration'

/** How long one registration request may take, in ms. */
export const REQUEST_TIMEOUT_MS = 10_000

/** Identifies this client to the platform, for their diagnostics. */
export const REGISTRATION_SOURCE = 'wechat-feishu-linker'

/** Poll cadence when the platform does not name one, in ms. */
const DEFAULT_INTERVAL_MS = 5_000

/** Poll cadence after `slow_down`, in ms. */
const SLOW_DOWN_INTERVAL_MS = 10_000

/** How long a QR stays valid when the platform does not say, in ms. */
const DEFAULT_EXPIRES_MS = 600_000

/**
 * Read a non-empty string field.
 *
 * @param {unknown} source - object to read from.
 * @param {string} key - field name.
 * @returns {string} the value, or an empty string.
 */
const readString = (source, key) => {
  if (typeof source !== 'object' || source === null) return ''
  const value = source[key]
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * The app name the platform reported, under any of the keys it has used.
 *
 * @param {object} response - the poll response.
 * @returns {string | undefined} the name, if there is one.
 */
export function readAppName(response) {
  const app = typeof response?.app === 'object' && response.app !== null ? response.app : null
  return (
    readString(response, 'app_name') ||
    readString(response, 'client_name') ||
    readString(response, 'name') ||
    readString(app, 'app_name') ||
    readString(app, 'name') ||
    undefined
  )
}

/**
 * POST one registration action.
 *
 * @param {'feishu' | 'lark'} domain - which accounts host to use.
 * @param {Record<string, string>} body - the form fields.
 * @param {typeof fetch} [fetchImpl] - injectable for tests.
 * @returns {Promise<object>} the parsed response.
 */
async function postRegistration(domain, body, fetchImpl) {
  const host = ACCOUNTS_HOSTS[domain] ?? ACCOUNTS_HOSTS.feishu
  const doFetch = fetchImpl ?? globalThis.fetch
  const response = await doFetch(`${host}${REGISTRATION_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  return (await response.json()) ?? {}
}

/**
 * Start a registration and mint the QR the contact scans.
 *
 * @param {{ domain?: 'feishu' | 'lark', fetchImpl?: typeof fetch }} [options] - options.
 * @returns {Promise<object>} `{ deviceCode, qrUrl, userCode, interval, expiresAt, domain, pollDomain }`.
 */
export async function beginRegistration(options = {}) {
  const domain = options.domain === 'lark' ? 'lark' : 'feishu'
  // Always the Feishu issuer: see the module note. `pollDomain` is what carries
  // the tenant's real brand forward.
  const pollDomain = 'feishu'
  const init = await postRegistration(pollDomain, { action: 'init' }, options.fetchImpl)
  const methods = Array.isArray(init?.supported_auth_methods) ? init.supported_auth_methods : []
  if (!methods.includes('client_secret')) {
    throw new Error('当前飞书环境不支持一键创建应用（缺少 client_secret 注册方式），只能手动创建应用')
  }

  const begun = await postRegistration(
    pollDomain,
    {
      action: 'begin',
      archetype: 'PersonalAgent',
      auth_method: 'client_secret',
      request_user_info: 'open_id',
    },
    options.fetchImpl,
  )
  const deviceCode = readString(begun, 'device_code')
  const verificationUri = readString(begun, 'verification_uri_complete')
  if (!deviceCode || !verificationUri) throw new Error('飞书没有返回设备码，无法开始扫码绑定')

  let qrUrl
  try {
    qrUrl = new URL(verificationUri)
  } catch {
    throw new Error(`飞书返回的扫码地址不可用：${verificationUri}`)
  }
  qrUrl.searchParams.set('from', 'sdk')
  qrUrl.searchParams.set('source', REGISTRATION_SOURCE)
  qrUrl.searchParams.set('tp', 'sdk')

  const expireInSeconds = Number(begun?.expire_in)
  const intervalSeconds = Number(begun?.interval)
  return {
    deviceCode,
    qrUrl: qrUrl.toString(),
    userCode: readString(begun, 'user_code'),
    interval: Number.isFinite(intervalSeconds) && intervalSeconds > 0 ? intervalSeconds * 1000 : DEFAULT_INTERVAL_MS,
    expiresAt: Date.now() + (Number.isFinite(expireInSeconds) && expireInSeconds > 0 ? expireInSeconds * 1000 : DEFAULT_EXPIRES_MS),
    domain,
    pollDomain,
  }
}

/**
 * Poll a registration once.
 *
 * @param {object} params - poll parameters.
 * @param {string} params.deviceCode - from {@link beginRegistration}.
 * @param {'feishu' | 'lark'} [params.domain] - the tenant brand so far.
 * @param {'feishu' | 'lark'} [params.pollDomain] - which host to poll this time.
 * @param {typeof fetch} [params.fetchImpl] - injectable for tests.
 * @returns {Promise<object>} `{ status, ... }` where status is `pending` | `success` | `access_denied` | `expired` | `error`.
 */
export async function pollRegistration(params = {}) {
  const domain = params.domain === 'lark' ? 'lark' : 'feishu'
  const pollDomain = params.pollDomain === 'lark' ? 'lark' : domain
  const response = await postRegistration(
    pollDomain,
    { action: 'poll', device_code: params.deviceCode },
    params.fetchImpl,
  )
  const brand = readString(response?.user_info, 'tenant_brand')
  const resultDomain = brand === 'lark' || brand === 'feishu' ? brand : domain

  // The tenant turned out to be Lark, and we are still asking the Feishu host:
  // switch hosts before believing any answer from here.
  if (brand === 'lark' && pollDomain !== 'lark') {
    return { status: 'pending', interval: 0, domain: resultDomain, pollDomain: 'lark' }
  }

  const appId = readString(response, 'client_id')
  const appSecret = readString(response, 'client_secret')
  if (appId && appSecret) {
    const appName = readAppName(response)
    const openId = readString(response?.user_info, 'open_id')
    return {
      status: 'success',
      appId,
      appSecret,
      domain: resultDomain,
      ...(appName ? { appName } : {}),
      ...(openId ? { openId } : {}),
    }
  }

  const error = readString(response, 'error')
  // No error at all still means "not confirmed yet" — the endpoint answers with
  // an empty body while it waits.
  if (!error || error === 'authorization_pending') {
    return { status: 'pending', interval: DEFAULT_INTERVAL_MS, domain: resultDomain }
  }
  // Not a failure: the platform is asking us to back off.
  if (error === 'slow_down') {
    return { status: 'pending', interval: SLOW_DOWN_INTERVAL_MS, domain: resultDomain }
  }
  if (error === 'access_denied') return { status: 'access_denied', domain: resultDomain }
  if (error === 'expired_token') return { status: 'expired', domain: resultDomain }
  return {
    status: 'error',
    message: `${error}: ${readString(response, 'error_description') || '未知错误'}`,
    domain: resultDomain,
  }
}
