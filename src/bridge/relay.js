/**
 * Outbound relay: turn-scoped assistant-text buffering and reply delivery.
 *
 * Assistant output arrives as one `assistant/message` session event per model
 * message. How it leaves depends on `displayMode`: `compact` (default) sends
 * each of those messages the moment it lands, while `quiet` merges the whole
 * turn into ONE reply at `turn/end` — WeChat renders a burst of fragments badly
 * and the iLink gateway counts every send against the peer's interaction budget,
 * so the merged form stays available for operators who prefer it.
 *
 * Either way the buffer is keyed by `${sessionId}#${turn}` (rather than by
 * session) so a fast follow-up message cannot discard the reply still being
 * assembled for the turn before it — and even in `compact` the text is recorded,
 * which is what lets `turn/end` tell a delivered turn from an empty one without
 * ever re-sending what already went out.
 *
 * Zero `@deepseek-ai/*` imports (docs/INTERFACES.md §2.0): every host value
 * here is read structurally off the `session/event` payload.
 *
 * @module wechat-feishu-linker/bridge/relay
 */

/**
 * Extract the session id from a `session/event` subject.
 *
 * The host has moved this identity around between releases (`session.id`,
 * `session.header.id`, a nested `session.session`), so every shape the
 * precedents accept is accepted here too.
 *
 * @param {unknown} session - first argument of a `session/event` listener.
 * @returns {string | undefined} the session id, when one can be found.
 */
export function sessionIdOf(session) {
  if (!session || typeof session !== 'object') return undefined
  const candidates = [session.id, session.header?.id, session.session?.header?.id, session.session?.id]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate
  }
  return undefined
}

/**
 * Buffer key for one turn of one session.
 *
 * @param {string} sessionId - owning session.
 * @param {string | number} turn - turn ordinal within that session.
 * @returns {string} the composite key.
 */
export function bufferKey(sessionId, turn) {
  return `${sessionId}#${String(turn)}`
}

/**
 * Concatenate the text blocks of one assembled assistant message.
 *
 * @param {unknown} message - `event.data.message`.
 * @returns {string} the trimmed text, empty when the message carries none.
 */
export function assistantTextOf(message) {
  const content = message?.content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block && block.type === 'text' && typeof block.text === 'string' && block.text !== '') {
      parts.push(block.text)
    }
  }
  return parts.join('\n').trim()
}

/**
 * Normalize a `turn/end` reason into a comparable kind.
 *
 * `event.data.reason` is `{ kind }` on current hosts and was a bare string on
 * older ones; both are reduced to the kind string.
 *
 * @param {unknown} reason - `event.data.reason`.
 * @returns {string | undefined} the reason kind.
 */
export function reasonKindOf(reason) {
  if (typeof reason === 'string') return reason
  if (reason && typeof reason === 'object' && typeof reason.kind === 'string') return reason.kind
  return undefined
}

/** Turn-scoped assistant text accumulator. */
export class TurnBuffer {
  /** @type {Map<string, string[]>} */
  #buffers = new Map()
  /** @type {Map<string, string | number>} last turn ordinal seen per session. */
  #lastTurn = new Map()

  /**
   * Append one assistant message's text to its turn.
   *
   * @param {string} sessionId - owning session.
   * @param {string | number | undefined} turn - turn ordinal, when the event carries one.
   * @param {string} text - text to append; empty values are ignored.
   * @returns {void}
   */
  append(sessionId, turn, text) {
    if (!text) return
    const resolved = this.#resolveTurn(sessionId, turn)
    const key = bufferKey(sessionId, resolved)
    const buffer = this.#buffers.get(key)
    if (buffer) buffer.push(text)
    else this.#buffers.set(key, [text])
  }

  /**
   * Take (and clear) the accumulated text for one turn.
   *
   * @param {string} sessionId - owning session.
   * @param {string | number | undefined} turn - turn ordinal, when the event carries one.
   * @returns {string} the joined reply, empty when nothing was buffered.
   */
  take(sessionId, turn) {
    const resolved = this.#resolveTurn(sessionId, turn)
    const key = bufferKey(sessionId, resolved)
    const buffer = this.#buffers.get(key)
    if (!buffer) return ''
    this.#buffers.delete(key)
    return buffer.join('\n\n').trim()
  }

  /**
   * Drop every buffered turn (plugin dispose).
   *
   * @returns {void}
   */
  clear() {
    this.#buffers.clear()
    this.#lastTurn.clear()
  }

  /** Number of turns currently holding text. */
  get size() {
    return this.#buffers.size
  }

  /**
   * Fall back to the session's last known turn when an event omits the ordinal,
   * so an `assistant/message` without `turn` still lands in the same bucket as
   * its `turn/end`.
   *
   * @param {string} sessionId - owning session.
   * @param {string | number | undefined} turn - turn ordinal from the event.
   * @returns {string | number} the resolved ordinal.
   */
  #resolveTurn(sessionId, turn) {
    if (turn !== undefined && turn !== null) {
      this.#lastTurn.set(sessionId, turn)
      return turn
    }
    return this.#lastTurn.get(sessionId) ?? 0
  }
}

/** Outbound attempts kept in the bridge's `send-log.jsonl` before it is rewritten. */
export const SEND_LOG_LIMIT = 200

/** Replies parked for a closed conversation window before the oldest is dropped. */
export const UNDELIVERED_LIMIT = 20

/**
 * Whether a send failed because the conversation window closed.
 *
 * iLink answers `ret: -2` (`"prepare failed"`) once the contact's `context_token`
 * is no longer live, and that token is **short-lived**: a turn that spends ten
 * minutes inside tool calls outlives it, so the *final* answer — the part that
 * matters — is exactly the one that fails. Unlike a transport failure this
 * cannot be retried away: no payload variant is accepted until a new inbound
 * message refreshes the window, which is why the only useful response is to keep
 * the text and send it then.
 *
 * @param {unknown} error - the failure returned by {@link deliverReply}.
 * @returns {boolean} true when the window, not the payload, is the problem.
 */
export function isStaleWindow(error) {
  const codes = [error?.ret, error?.errcode, error?.code]
  if (codes.some((code) => code === -2 || code === '-2')) return true
  return /prepare failed/i.test(String(error?.message ?? error ?? ''))
}

/**
 * Turn one outbound failure into an actionable hint for the contact.
 *
 * The iLink gateway overloads `ret: -2`: on `sendmessage` it means the
 * conversation window (the inbound `context_token`) is no longer valid, and
 * *no* payload variant will be delivered without a fresh inbound message — the
 * client's "retry once without the token" fallback therefore cannot succeed.
 * Saying so is the only thing that gets the conversation moving again.
 *
 * Errors are read structurally (`ret` / `errcode` / `code`), never by
 * `instanceof`, so this module keeps its zero-import property.
 *
 * @param {unknown} error - the failure returned by {@link deliverReply}.
 * @returns {string} a one-line, user-facing remedy.
 */
export function deliveryHint(error) {
  // Every code field is inspected, not a `??` chain: `IlinkAuthError` carries
  // `errcode: -14` while `ret` may legitimately be `0`, and `0 ?? x` would
  // hide it.
  const codes = [error?.ret, error?.errcode, error?.code]
  const has = (value) => codes.some((code) => code === value || code === String(value))
  if (has(-2)) {
    return '会话窗口已过期：微信只允许在用户最近一条消息的有效窗口内回复。请在微信里再发一条消息重新激活会话。'
  }
  if (has(-14)) {
    return '机器人登录态已失效（errcode -14）。请在 DSH 侧重新扫码登录后再试。'
  }
  return '请在微信里再发一条消息重试；若持续失败，请查看 DSH 日志。'
}

/**
 * Send one reply to a WeChat peer through the channel service.
 *
 * Never throws: a failed send is logged and reported as `{ ok: false }` so
 * callers can decide whether to surface it — an outbound failure must not
 * become an unhandled rejection inside a session-event listener.
 *
 * @param {object} options - delivery inputs.
 * @param {object | undefined} options.service - channel service (`sendText`).
 * @param {{ peerId?: string, contextToken?: string } | undefined} options.link - peer binding.
 * @param {string} options.text - reply body.
 * @param {number} [options.maxChars] - per-message chunk cap.
 * @param {(level: string, message: string) => void} [options.log] - logger.
 * @param {(entry: object) => void} [options.record] - optional attempt recorder.
 * @returns {Promise<{ ok: boolean, error?: unknown, reason?: string }>} the outcome.
 */
export async function deliverReply({ service, link, text, maxChars, log, record }) {
  const peerId = link?.peerId
  if (!text) return { ok: false, reason: 'empty-text' }
  if (!peerId) {
    log?.('warn', 'reply dropped: no peer id bound to the session')
    return { ok: false, reason: 'no-peer' }
  }
  if (!service || typeof service.sendText !== 'function') {
    log?.('error', `reply to ${peerId} dropped: wechat-ilink channel service unavailable`)
    return { ok: false, reason: 'no-channel' }
  }
  const token = typeof link.contextToken === 'string' && link.contextToken ? link.contextToken : ''
  const chunkLimit = Number.isFinite(maxChars) && maxChars > 0 ? { maxChars } : {}
  try {
    await service.sendText(peerId, text, { ...(token ? { contextToken: token } : {}), ...chunkLimit })
    log?.('info', `replied to ${peerId} (${text.length} chars)`)
    record?.({ peerId, chars: text.length, token: Boolean(token), ok: true })
    return { ok: true }
  } catch (error) {
    log?.('warn', `reply to ${peerId} failed: ${String(error)}`)
    record?.({ peerId, chars: text.length, token: Boolean(token), ok: false, error: String(error) })
    return { ok: false, error, reason: 'send-failed' }
  }
}
