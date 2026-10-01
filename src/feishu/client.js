/**
 * Feishu (Lark) Open Platform client — plain `fetch`, no SDK.
 *
 * The official `@larksuiteoapi/node-sdk` is used by this plugin for one thing
 * only: the long-connection transport in `ws.js`. Every HTTP call here is a
 * documented Open Platform endpoint, so keeping it as `fetch` means the API
 * layer is testable without a network, without the SDK, and without a mock of
 * somebody else's client object.
 *
 * Protocol notes, all verified against the reference implementation
 * (`zcode/packages/services/src/bots/providers/feishuProvider.ts`):
 *
 * - `tenant_access_token` lives ~2 hours; it is cached and re-minted with a
 *   safety margin rather than fetched per call.
 * - `receive_id_type` is decided by the id's prefix: `oc_` is a group chat,
 *   anything else is a user `open_id`. Sending with the wrong type is refused,
 *   so the prefix is the only reliable signal available at this layer.
 * - **HTTP 200 can still carry a business refusal** (`code !== 0`). Treating
 *   status alone as success is how a failed send looks like a delivered one.
 * - The `Typing` indicator is a *reaction on the contact's own message*, and it
 *   persists until deleted — so it is added once per turn and removed at the
 *   end, with no refresh loop. (WeChat's is a one-shot that dies after seconds
 *   and needs a heartbeat; this one does not.)
 *
 * Zero `@deepseek-ai/*` imports (docs/INTERFACES.md §2.0).
 *
 * @module wechat-feishu-linker/feishu/client
 */

/** Open Platform hosts. `lark` is the international deployment of the same API. */
export const FEISHU_HOSTS = Object.freeze({
  feishu: 'https://open.feishu.cn',
  lark: 'https://open.larksuite.com',
})

/** How long a tenant token is reused before it is minted again. */
const TOKEN_TTL_MS = 90 * 60_000

/** Refresh this long before the token would actually expire. */
const TOKEN_SAFETY_MS = 60_000

/** The emoji type Feishu renders as "typing…". */
const TYPING_EMOJI = 'Typing'

/**
 * A refusal from the Open Platform.
 *
 * Carries the business code, message and `log_id` because Feishu's HTTP 400
 * body holds all three, and dropping them is what makes a failure impossible to
 * diagnose later.
 */
export class FeishuApiError extends Error {
  /**
   * @param {string} operation - what was being attempted.
   * @param {object} detail - `{ status, code, msg, logId }`.
   */
  constructor(operation, detail) {
    const parts = [
      typeof detail?.status === 'number' ? `HTTP ${detail.status}` : null,
      typeof detail?.code === 'number' ? `code=${detail.code}` : null,
      detail?.msg ? `msg=${detail.msg}` : null,
      detail?.logId ? `log_id=${detail.logId}` : null,
    ].filter(Boolean)
    super(`Feishu ${operation} failed: ${parts.join(', ') || 'unknown error'}`)
    this.name = 'FeishuApiError'
    this.status = detail?.status
    this.code = detail?.code
    this.msg = detail?.msg
    this.logId = detail?.logId
  }
}

/**
 * Which `receive_id_type` an id needs.
 *
 * @param {string} receiveId - a chat id or a user open id.
 * @returns {'chat_id' | 'open_id'} the type.
 */
export function receiveIdTypeOf(receiveId) {
  return String(receiveId ?? '').startsWith('oc_') ? 'chat_id' : 'open_id'
}

/**
 * Create a Feishu API client.
 *
 * @param {object} options - client options.
 * @param {string} options.appId - the app's `cli_…` id.
 * @param {string} options.appSecret - the app secret.
 * @param {'feishu' | 'lark'} [options.domain] - which deployment; defaults to `feishu`.
 * @param {typeof fetch} [options.fetchImpl] - injectable for tests.
 * @param {(level: string, message: string) => void} [options.log] - logger.
 * @returns {object} the client.
 */
export function createFeishuClient({ appId, appSecret, domain = 'feishu', fetchImpl, log } = {}) {
  const doFetch = fetchImpl ?? globalThis.fetch
  const host = FEISHU_HOSTS[domain] ?? FEISHU_HOSTS.feishu
  /** @type {{ token: string, expiresAt: number } | undefined} */
  let cachedToken
  /** @type {Map<string, string>} message id → reaction id, so the indicator is added once. */
  const typingReactions = new Map()

  /**
   * Read one response body, refusing on a business error.
   *
   * @param {string} operation - what is being attempted.
   * @param {Response} response - the fetch response.
   * @returns {Promise<object>} the parsed body.
   */
  const readJson = async (operation, response) => {
    let body
    try {
      body = await response.json()
    } catch (error) {
      throw new FeishuApiError(operation, { status: response.status, msg: `unreadable body: ${String(error)}` })
    }
    // A business refusal arrives with HTTP 200 often enough that status alone
    // cannot be trusted to mean the call worked.
    if (!response.ok || (typeof body?.code === 'number' && body.code !== 0)) {
      throw new FeishuApiError(operation, {
        status: response.status,
        code: body?.code,
        msg: body?.msg,
        logId: body?.error?.log_id,
      })
    }
    return body ?? {}
  }

  /**
   * Mint or reuse a `tenant_access_token`.
   *
   * @returns {Promise<string>} the token.
   */
  const tenantToken = async () => {
    if (cachedToken && cachedToken.expiresAt > Date.now() + TOKEN_SAFETY_MS) return cachedToken.token
    if (!appId || !appSecret) throw new FeishuApiError('tenant_access_token', { msg: 'app id or secret is missing' })
    const response = await doFetch(`${host}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
    })
    const body = await readJson('tenant_access_token', response)
    const token = body?.tenant_access_token
    if (typeof token !== 'string' || !token) {
      throw new FeishuApiError('tenant_access_token', { status: response.status, code: body?.code, msg: body?.msg })
    }
    cachedToken = { token, expiresAt: Date.now() + TOKEN_TTL_MS }
    return token
  }

  /**
   * Send one text message.
   *
   * @param {string} receiveId - chat id (`oc_…`) or user open id (`ou_…`).
   * @param {string} text - the body.
   * @returns {Promise<{ messageId: string | null }>} the sent message.
   */
  const sendText = async (receiveId, text) => {
    const token = await tenantToken()
    const type = receiveIdTypeOf(receiveId)
    const response = await doFetch(`${host}/open-apis/im/v1/messages?receive_id_type=${type}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        receive_id: receiveId,
        msg_type: 'text',
        // Feishu takes the body as a JSON *string* inside the JSON body.
        content: JSON.stringify({ text: String(text ?? '') }),
      }),
    })
    const body = await readJson('send message', response)
    return { messageId: body?.data?.message_id ?? null }
  }

  /**
   * Reply to one message.
   *
   * Distinct from `sendText` on purpose: Feishu lets a bot answer a message it
   * received, while pushing a brand-new message to a user is refused with
   * `230101 Sending messages to users is temporarily unavailable` even for an
   * app that is published and enabled. Answering is also what the contact sees
   * as a threaded reply rather than a detached message.
   *
   * @param {string} messageId - the contact's message to answer.
   * @param {string} text - the body.
   * @returns {Promise<{ messageId: string | null }>} the sent message.
   */
  const replyText = async (messageId, text) => {
    const token = await tenantToken()
    const response = await doFetch(
      `${host}/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reply`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ msg_type: 'text', content: JSON.stringify({ text: String(text ?? '') }) }),
      },
    )
    const body = await readJson('reply to message', response)
    return { messageId: body?.data?.message_id ?? null }
  }

  /**
   * Add the "typing…" reaction to the contact's message, once.
   *
   * A reaction persists until it is removed, so this is deliberately idempotent:
   * the bridge's refresh loop calls it repeatedly and only the first call does
   * anything. That is the whole reason this channel needs no heartbeat.
   *
   * @param {string} messageId - the contact's message to react to.
   * @returns {Promise<boolean>} whether an indicator is now showing.
   */
  const addTypingReaction = async (messageId) => {
    if (!messageId) return false
    if (typingReactions.has(messageId)) return true
    const token = await tenantToken()
    const response = await doFetch(
      `${host}/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reactions`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ reaction_type: { emoji_type: TYPING_EMOJI } }),
      },
    )
    const body = await readJson('add typing reaction', response)
    const reactionId = body?.data?.reaction_id
    if (typeof reactionId === 'string' && reactionId) typingReactions.set(messageId, reactionId)
    return true
  }

  /**
   * Remove the "typing…" reaction, if one is showing.
   *
   * @param {string} messageId - the message it was added to.
   * @returns {Promise<boolean>} whether one was removed.
   */
  const removeTypingReaction = async (messageId) => {
    const reactionId = typingReactions.get(messageId)
    if (!reactionId) return false
    typingReactions.delete(messageId)
    const token = await tenantToken()
    const response = await doFetch(
      `${host}/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reactions/${encodeURIComponent(reactionId)}`,
      { method: 'DELETE', headers: { authorization: `Bearer ${token}` } },
    )
    await readJson('remove typing reaction', response)
    return true
  }

  /**
   * Read the app's own display name, for the status card.
   *
   * @returns {Promise<string | null>} the name, or null when unavailable.
   */
  const getAppName = async () => {
    const token = await tenantToken()
    const response = await doFetch(`${host}/open-apis/application/v6/applications/${encodeURIComponent(appId)}?lang=zh_cn`, {
      headers: { authorization: `Bearer ${token}` },
    })
    const body = await readJson('read app info', response)
    const app = body?.data?.app
    const named = app?.app_name?.trim()
    if (named) return named
    const primary = app?.primary_language?.trim()
    const localized = app?.i18n?.find((entry) => entry?.i18n_key === primary)?.name?.trim()
    return localized ?? app?.i18n?.find((entry) => entry?.name?.trim())?.name?.trim() ?? null
  }

  /**
   * Drop every cached credential and reaction id.
   *
   * @returns {void}
   */
  const reset = () => {
    cachedToken = undefined
    typingReactions.clear()
  }

  return {
    addTypingReaction,
    getAppName,
    removeTypingReaction,
    replyText,
    reset,
    sendText,
    tenantToken,
    /** Exposed so a caller can report which deployment is in use. */
    host,
    /** Exposed for tests and diagnostics. */
    typingCount: () => typingReactions.size,
    log,
  }
}
