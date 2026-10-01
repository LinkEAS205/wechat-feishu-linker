/**
 * WeChat ↔ DSH agent bridge (Cordis functional plugin row `wechat-ilink-bridge`).
 *
 * Turns inbound WeChat direct messages into agent turns and pushes the agent's
 * reply back to the same conversation. Session routing is `per-peer` by
 * default: every contact gets an independent agent and session, so memories
 * never bleed between conversations.
 *
 * This is a consumer plugin: it owns no protocol code and reads the channel
 * service from the process-local registry (`../registry.js`) rather than from
 * Cordis, because a third-party plugin cannot resolve `@deepseek-ai/*` and
 * therefore cannot import a service type. See docs/INTERFACES.md §2.0.
 *
 * @module wechat-feishu-linker/bridge
 */

import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { DEFAULT_CHANNEL, clearBridgeSettings, getService, setBridgeSettings } from '../registry.js'
import {
  APPROVAL_REPLY_HINT,
  CARD_TIMEOUT_NOTICE,
  CardRegistry,
  cardCommandHint,
  formatApprovalCard,
  formatQuestionCard,
  parseApprovalReply,
  parseQuestionReply,
} from './cards.js'
import { DEFAULT_CONFIG, channelConfig, withDefaults } from './config-bridge.js'
import {
  UNAVAILABLE_TEXT,
  currentText,
  cwdFailureText,
  describeSelection,
  effortListText,
  flattenModels,
  helpText,
  isKnownCommand,
  modelListText,
  parseCommand,
  parseModelChoice,
  peekText,
  permissionText,
  sessionsText,
  statusText,
  switchedText,
  workspacesText,
} from './commands.js'
import {
  findModel,
  readModelCatalog,
  readPermissionState,
  readSessionSelection,
  selectModel,
  selectPermission,
} from './capabilities.js'
import { checkHostCompat, describeCompat } from './compat.js'
import { HostAccess, PEEK_ENTRY_LIMIT, clip } from './host.js'
import {
  SEND_LOG_LIMIT,
  TurnBuffer,
  UNDELIVERED_LIMIT,
  assistantTextOf,
  bufferKey,
  deliverReply,
  deliveryHint,
  isStaleWindow,
  reasonKindOf,
  sessionIdOf,
} from './relay.js'
import { applySettings, readSettings, validateSettings } from './settings.js'
import { SessionRouter, createSessionChoiceStore, createUserMessage, decideAccess, isEchoMessage } from './sessions.js'

export const name = 'wechat-ilink-bridge'

/**
 * The agent registry is the one hard requirement; the channel service is found
 * through the registry and the remaining host services are optional.
 */
export const inject = ['agents']

export { DEFAULT_CONFIG, DEFAULT_CONFIG as BridgeConfig, withDefaults } from './config-bridge.js'

/** Reply sent when the DSH side fails to handle a message. */
const FAILURE_NOTICE =
  '⚠️ 你的消息已收到，但 DSH 侧处理失败（会话无法打开或 agent 出错）。请稍后重试，或查看 DSH 日志。'

/** Reply sent when an unauthorized peer messages a `allowlist` deployment. */
const DENIED_NOTICE = '⚠️ 你不在本助手的允许列表中，无法使用。请联系管理员把你的微信 id 加入 allowlist。'

/** Reply sent when an unauthorized group is addressed. */
const DENIED_GROUP_NOTICE = '⚠️ 本群未授权使用本助手。'

/** Reply sent when a message carries nothing the agent can act on. */
const EMPTY_NOTICE = '⚠️ 目前只支持文本消息，收到的内容无法处理。'

/** Reply sent when a turn's assembled reply could not be delivered. */
const REPLY_FAILED_NOTICE = '⚠️ 本轮回复发送失败（会话窗口可能已过期）。'

/** Reply sent when a turn ends abnormally without producing any text. */
const EMPTY_TURN_NOTICE = '⚠️ 本轮没有产生文本回复（可能已中断或出错）。发送 /status 查看状态。'

/**
 * Mount the bridge.
 *
 * @param {object} ctx - Cordis context (must expose `on`, `get`, and `emit`).
 * @param {object} [rawConfig] - the `wechat-ilink-bridge` row's config.
 * @param {object} [deps] - test seams; production passes nothing.
 * @param {object} [deps.choices] - conversation → session-id memo override.
 * @param {string} [deps.cwd] - working directory for created sessions.
 * @param {(level: string, message: string) => void} [deps.log] - logger override.
 * @returns {() => void} disposer removing every listener and dropping buffers.
 */
export function apply(ctx, rawConfig, deps = {}) {
  const config = withDefaults(rawConfig)
  const log = deps.log ?? createLogger(ctx)
  if (config.enabled === false) {
    log('info', 'wechat-ilink bridge: disabled by config')
    return () => {}
  }

  /**
   * Write the live settings into the profile patch so they survive a restart.
   *
   * The live values are already applied when this runs, so persistence only
   * decides whether they outlive the process. A host without `configEditor`, or
   * a row the editor cannot address, still gets the live change — the caller is
   * told persistence did not happen rather than being told the write failed.
   *
   * @returns {Promise<boolean>} whether the profile patch was written.
   */
  const persistSettings = async () => {
    const editor = typeof ctx?.get === 'function' ? ctx.get('configEditor') : undefined
    const entry = ctx?.fiber?.entry
    if (!editor || typeof editor.edit !== 'function' || entry === undefined) return false
    try {
      await editor.edit(entry, (current) => ({ ...current, ...readSettings(config) }))
      return true
    } catch (error) {
      log('warn', `wechat-ilink bridge: settings applied live but not persisted: ${String(error)}`)
      return false
    }
  }

  /**
   * The settings surface the web API drives.
   *
   * It hands out `read`/`write` over the very config object the relay closes
   * over, so there is exactly one copy of every setting: a page that renders
   * `read()` cannot show a value the relay is not using, and a write takes
   * effect on the next event without a restart.
   */
  /**
   * The host-compatibility report, computed on first use.
   *
   * It must NOT be computed at load. The bridge row is constructed while the host
   * is still bringing services up, so an eager probe reports almost everything as
   * missing — which is exactly what it did the first time it shipped, on a host
   * where every one of those services was present and working. A complete report
   * is cached; an incomplete one is re-probed, so a premature first read cannot
   * freeze a wrong answer.
   *
   * @returns {object} the report.
   */
  let hostCompat
  const hostCompatReport = () => {
    if (hostCompat?.ok) return hostCompat
    hostCompat = checkHostCompat(ctx)
    log('info', `wechat-ilink bridge: ${describeCompat(hostCompat)}`)
    return hostCompat
  }

  const settingsHandle = {
    read: () => readSettings(config),
    compat: () => hostCompatReport(),
    /**
     * Replies the conversation window refused and is still holding.
     *
     * Surfaced because the failure is otherwise invisible by construction: the
     * notice that would report it travels the same closed channel, so the
     * contact sees a half-finished answer and nothing anywhere says why. Only a
     * new inbound WeChat message can flush it, so the count is what tells them
     * to send one.
     */
    undelivered: () => {
      let count = 0
      let chars = 0
      for (const queue of undelivered.values()) {
        count += queue.length
        for (const text of queue) chars += text.length
      }
      return { count, chars }
    },
    /** The model catalog, for the settings page's default-model picker. */
    catalog: () => readModelCatalog(ctx),
    /** The permission presets, for the settings page's default-preset picker. */
    permissions: () => readPermissionState(ctx, undefined),
    write: async (patch) => {
      const checked = validateSettings(patch, config)
      if (!checked.ok) return { ok: false, message: checked.message }
      applySettings(config, checked.patch)
      const persisted = await persistSettings()
      log(
        'info',
        `wechat-ilink bridge: settings changed to ${JSON.stringify(readSettings(config))} (persisted=${persisted})`,
      )
      return { ok: true, settings: readSettings(config), persisted }
    },
  }
  setBridgeSettings(settingsHandle)
  const router = new SessionRouter({
    ctx,
    config,
    choices:
      deps.choices ??
      createSessionChoiceStore(() => {
        const service = getService()
        return typeof service?.dataDirectory === 'string' ? service.dataDirectory : undefined
      }),
    log,
    cwd: deps.cwd,
  })
  const buffer = new TurnBuffer()
  /** Guarded read-only access to the host's workspaces and existing sessions. */
  const host = deps.host ?? new HostAccess({ ctx, log })
  /** Sessions whose next empty `turn/end` must not emit a notice (a command already replied). */
  const quietTurns = new Set()

  log(
    'info',
    `wechat-ilink bridge: enabled (sessionMode=${config.sessionMode}, ` +
      `dmPolicy=${config.dmPolicy}, groupPolicy=${config.groupPolicy}, ` +
      `model=${router.selection ? `${router.selection.provider}/${router.selection.model}` : 'deployment-default'})`,
  )

  /**
   * Read the channel service a conversation belongs to.
   *
   * The bridge serves every channel, so which service to use is a property of
   * the conversation, not a global: a link that names no channel means the
   * WeChat one, which is what keeps every single-channel call site unchanged.
   *
   * @param {{ channel?: string } | undefined} [link] - peer binding.
   * @returns {object | undefined} the channel service.
   */
  const channel = (link) => getService(link?.channel)

  /**
   * The settings that apply to one conversation.
   *
   * One config object serves every channel, so anything describing *delivery*
   * rather than policy has to be resolved per channel — and through this one
   * function. A site that read `config.displayMode` directly would make that one
   * setting silently ignore its channel, which looks exactly like the setting
   * having been applied.
   *
   * @param {{ channel?: string } | undefined} [link] - peer binding.
   * @returns {object} the resolved settings.
   */
  const settingsFor = (link) => channelConfig(config, link?.channel)

  /**
   * Send one outbound message, reporting — never throwing — on failure.
   *
   * @param {{ channel?: string, peerId?: string, contextToken?: string } | undefined} link - peer binding.
   * @param {string} text - message body.
   * @returns {Promise<{ ok: boolean, error?: unknown, reason?: string }>} the outcome.
   */
  const notify = (link, text) =>
    deliverReply({
      service: channel(link),
      link,
      text,
      maxChars: settingsFor(link).replyMaxChars,
      log,
      record: recordSend,
    })

  /**
   * Keep the last few outbound attempts on disk.
   *
   * A dropped reply is invisible by construction: the notice that would report
   * the failure travels the same channel, so when the channel is the problem
   * nothing anywhere says so. This is the trail that makes that diagnosable
   * after the fact — bounded, because a diagnostic that grows without limit is
   * just a leak.
   *
   * @param {object} entry - `{ peerId, chars, token, ok, ... }`.
   * @returns {void}
   */
  const recordSend = (entry) => {
    const dir = getService()?.dataDirectory
    if (typeof dir !== 'string' || !dir) return
    const target = join(dir, 'send-log.jsonl')
    try {
      appendFileSync(target, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`)
      const lines = readFileSync(target, 'utf8').split('\n').filter(Boolean)
      // Trim at twice the limit so the rewrite is amortized over many sends.
      if (lines.length > SEND_LOG_LIMIT * 2) {
        writeFileSync(target, `${lines.slice(-SEND_LOG_LIMIT).join('\n')}\n`)
      }
    } catch {
      // Diagnostics must never break delivery.
    }
  }

  /**
   * Fire-and-forget send for notices whose loss is only worth a log line.
   *
   * Unlike the turn reply, these carry no user-visible payload that would
   * otherwise vanish, so a failure is recorded rather than retried with a
   * second notice (which would recurse on a dead channel).
   *
   * @param {{ peerId?: string, contextToken?: string } | undefined} link - peer binding.
   * @param {string} text - message body.
   * @param {string} what - label used in the error log.
   * @returns {Promise<void>} resolves once the attempt settled.
   */
  const notifyOrLog = async (link, text, what) => {
    const result = await notify(link, text)
    if (!result.ok) {
      log(
        'error',
        `wechat-ilink bridge: ${what} to ${link?.peerId ?? 'unknown'} was not delivered ` +
          `(${result.reason ?? 'unknown'}${result.error ? `: ${String(result.error)}` : ''})`,
      )
    }
  }

  /**
   * Deliver one turn's assembled reply, escalating a delivery failure.
   *
   * A silently dropped reply is the worst outcome this bridge can produce: the
   * contact asked a question and would otherwise wait forever. When the reply
   * fails, a short, actionable notice is sent on a *second* attempt — that
   * second attempt is what usually succeeds once the peer messages again, and
   * even when it also fails the failure is logged at `error` level instead of
   * disappearing into a `warn`.
   *
   * @param {{ peerId?: string, contextToken?: string } | undefined} link - peer binding.
   * @param {string} reply - the assembled turn text.
   * @returns {Promise<void>} resolves once both attempts settled.
   */
  const deliverTurnReply = async (link, reply) => {
    const first = await notify(link, reply)
    if (first.ok) return
    if (isStaleWindow(first.error)) {
      // The contact's conversation window closed — `context_token` is
      // short-lived, so a turn that spends minutes inside tool calls outlives it
      // and the *final* answer is exactly the one refused. Nothing can be
      // retried into that window, and the failure notice below would be refused
      // the same way, so the text is parked until a new inbound message
      // refreshes the token instead of being dropped on the floor.
      queueUndelivered(link, reply)
      log('warn', `wechat-ilink bridge: parked a reply for ${link?.peerId} (conversation window closed)`)
      return
    }
    const notice = `${REPLY_FAILED_NOTICE}\n${deliveryHint(first.error)}`
    const second = await notify(link, notice)
    if (!second.ok) {
      log(
        'error',
        `wechat-ilink bridge: turn reply AND failure notice both failed for ${link?.peerId ?? 'unknown'} ` +
          `(reply: ${String(first.error)}; notice: ${second.reason ?? ''}${second.error ? ` ${String(second.error)}` : ''})`,
      )
      return
    }
    log('warn', `wechat-ilink bridge: turn reply failed; delivered a failure notice to ${link?.peerId}`)
  }

  /**
   * Stop the "正在输入" heartbeat for one session.
   *
   * @param {string} sessionId - owning session.
   * @returns {{ link?: object } | undefined} what it was tracking, so the caller can retract the indicator.
   */
  const stopTypingHeartbeat = (sessionId) => {
    const entry = typingHearts.get(sessionId)
    if (entry === undefined) return undefined
    clearInterval(entry.timer)
    typingHearts.delete(sessionId)
    return entry
  }

  /**
   * Retract the "typing" indicator for one conversation.
   *
   * WeChat's signal expires by itself, so a channel without `clearTyping` needs
   * nothing here. A Feishu reaction does **not** expire: it stays until deleted,
   * so a channel that shows one has to be told the turn is over or the contact
   * watches a bot that is apparently typing forever.
   *
   * @param {{ channel?: string, peerId?: string, contextToken?: string } | undefined} link - peer binding.
   * @returns {Promise<void>} resolves once the attempt is done.
   */
  const clearTyping = async (link) => {
    if (!link?.peerId) return
    const service = channel(link)
    if (typeof service?.clearTyping !== 'function') return
    try {
      await service.clearTyping(link.peerId, link.contextToken)
    } catch (error) {
      log('warn', `wechat-ilink bridge: could not clear the typing indicator for ${link.peerId}: ${String(error)}`)
    }
  }

  /**
   * Keep the "正在输入" indicator alive for as long as the turn runs.
   *
   * `sendtyping` is a one-shot with no duration: the client shows the indicator
   * briefly and then forgets it. A turn that spends ten minutes inside tool
   * calls therefore looks completely idle from WeChat — which is exactly when
   * the contact concludes the agent has stopped. Re-signalling on an interval
   * is the difference between "still working" and silence.
   *
   * A channel whose indicator persists (Feishu's reaction) makes this loop
   * redundant rather than wrong: the call is idempotent, so the first tick shows
   * it and every later tick is a no-op.
   *
   * @param {string} sessionId - the session whose turn is running.
   * @param {{ channel?: string, peerId?: string, contextToken?: string } | undefined} link - peer binding.
   * @returns {void}
   */
  const startTypingHeartbeat = (sessionId, link) => {
    stopTypingHeartbeat(sessionId)
    const settings = settingsFor(link)
    if (settings.typingIndicator === false) return
    const intervalMs = Number.isFinite(settings.typingRefreshMs) ? settings.typingRefreshMs : 0
    if (intervalMs <= 0) return
    const timer = setInterval(() => void typing(link), intervalMs)
    // A heartbeat must never hold the host process open.
    timer.unref?.()
    typingHearts.set(sessionId, { link, timer })
  }

  /**
   * Replies the conversation window refused, kept until it reopens.
   *
   * iLink only accepts a send while the contact's `context_token` is live, and
   * that token is short-lived — so the answer to a long turn is routinely the
   * one that gets refused, and there is no way to retry into a closed window.
   * Parking the text here and flushing it on the next inbound message is the
   * difference between a late reply and a lost one.
   *
   * @type {Map<string, string[]>}
   */
  const undelivered = new Map()

  /**
   * The key a peer is filed under in every per-peer map.
   *
   * A peer id is only unique inside its own channel — nothing stops two channels
   * handing out the same string — so anything keyed by contact keys on both.
   *
   * @param {{ channel?: string, peerId?: string } | undefined} peer - peer binding.
   * @returns {string} the key.
   */
  const peerKey = (peer) => `${peer?.channel ?? DEFAULT_CHANNEL}:${peer?.peerId ?? ''}`

  /**
   * Park one reply until the contact's next message reopens the window.
   *
   * @param {{ channel?: string, peerId?: string }} peer - the peer the reply was for.
   * @param {string} text - the reply body.
   * @returns {void}
   */
  const queueUndelivered = (peer, text) => {
    if (!peer?.peerId || !text) return
    const key = peerKey(peer)
    const queue = undelivered.get(key) ?? []
    queue.push(text)
    // Bounded: a queue nobody ever drains must not grow without limit.
    while (queue.length > UNDELIVERED_LIMIT) queue.shift()
    undelivered.set(key, queue)
  }

  /**
   * Send whatever a closed window refused, now that a message has reopened it.
   *
   * Parked replies keep their order and are joined into one message, because the
   * window that just reopened is the one resource worth spending carefully.
   *
   * @param {{ channel?: string, peerId?: string, contextToken?: string } | undefined} link - peer binding.
   * @returns {Promise<void>} resolves once the flush was attempted.
   */
  const flushUndelivered = async (link) => {
    const key = link?.peerId ? peerKey(link) : undefined
    const queue = key ? undelivered.get(key) : undefined
    if (!queue || queue.length === 0) return
    undelivered.delete(key)
    const result = await notify(link, queue.join('\n\n'))
    if (!result.ok) {
      // Still shut, or shut again: put them back rather than lose them.
      undelivered.set(key, queue)
      log('warn', `wechat-ilink bridge: parked replies for ${link.peerId} still cannot be delivered`)
      return
    }
    log('info', `wechat-ilink bridge: delivered ${queue.length} parked replies to ${link.peerId}`)
  }

  /**
   * Text waiting to be coalesced into one WeChat message, per session.
   *
   * @type {Map<string, { link: object, parts: string[], timer: ReturnType<typeof setTimeout> }>}
   */
  const pendingSegments = new Map()

  /**
   * Send whatever one turn coalesced, now.
   *
   * @param {string} sessionId - the session whose fragments are waiting.
   * @param {string | number | undefined} turn - the turn ordinal.
   * @returns {void}
   */
  const flushSegments = (sessionId, turn) => {
    const key = bufferKey(sessionId, turn ?? 0)
    const pending = pendingSegments.get(key)
    if (pending === undefined) return
    clearTimeout(pending.timer)
    pendingSegments.delete(key)
    const text = pending.parts.join('\n\n').trim()
    if (!text) return
    void deliverTurnReply(pending.link, text).catch((error) => {
      log('error', `wechat-ilink bridge: segment delivery crashed for ${pending.link?.peerId}: ${String(error)}`)
    })
  }

  /**
   * Coalesce one fragment of a running turn, and send the batch when it settles.
   *
   * A turn emits a dozen model messages, most of them one line of narration.
   * Sending each as its own message spent the conversation window about an order
   * of magnitude faster than the turn needed — and that window is what the
   * *final* answer needs, so the answer was the one refused once it closed.
   * Merging everything that lands inside one window keeps the progress feel for
   * a fraction of the sends.
   *
   * @param {string} sessionId - owning session.
   * @param {{ peerId?: string, contextToken?: string } | undefined} link - peer binding.
   * @param {string} text - the fragment.
   * @returns {void}
   */
  const queueSegment = (sessionId, turn, link, text) => {
    if (!text) return
    // Keyed by turn as well as session, like the relay buffer: a fragment must
    // not be able to join a batch belonging to a different turn.
    const key = bufferKey(sessionId, turn ?? 0)
    const pending = pendingSegments.get(key)
    if (pending !== undefined) {
      // Inside a running window: join the batch it is about to carry.
      pending.parts.push(text)
      pending.link = link
      return
    }
    const flushMs = Number.isFinite(settingsFor(link).compactFlushMs) ? settingsFor(link).compactFlushMs : 0
    if (flushMs <= 0) {
      void deliverTurnReply(link, text).catch((error) => {
        log('error', `wechat-ilink bridge: segment delivery crashed for ${link?.peerId}: ${String(error)}`)
      })
      return
    }
    const timer = setTimeout(() => flushSegments(sessionId, turn), flushMs)
    // A pending flush must never hold the host process open.
    timer.unref?.()
    pendingSegments.set(key, { link, parts: [text], timer })
  }

  /** Stop every coalescing timer. */
  const stopAllSegments = () => {
    for (const pending of pendingSegments.values()) clearTimeout(pending.timer)
    pendingSegments.clear()
  }

  /**
   * Best-effort typing indicator for one peer.
   *
   * @param {{ peerId?: string, contextToken?: string } | undefined} link - peer binding.
   * @returns {Promise<boolean>} whether the indicator was accepted.
   */
  const typing = async (link) => {
    if (settingsFor(link).typingIndicator === false || !link?.peerId) return false
    const service = channel(link)
    if (typeof service?.sendTyping !== 'function') return false
    try {
      const accepted = Boolean(await service.sendTyping(link.peerId, link.contextToken))
      if (!accepted) {
        recordSend({ kind: 'typing', peerId: link.peerId, chars: 0, ok: false, error: 'no typing ticket' })
      }
      return accepted
    } catch (error) {
      log('warn', `wechat-ilink bridge: typing indicator for ${link.peerId} failed: ${String(error)}`)
      // Only failures are recorded: the heartbeat runs every few seconds, so
      // recording successes too would flush the diagnostic trail away.
      recordSend({ kind: 'typing', peerId: link.peerId, chars: 0, ok: false, error: String(error) })
      return false
    }
  }

  /**
   * Cards mirrored to WeChat for the host's two decision waterfalls.
   *
   * Without these, an agent created for a WeChat conversation blocks forever on
   * a prompt only the GUI could render: the contact never sees the request at
   * all. Both waterfalls dispatch on the *agent's* scoped context, and an
   * untagged listener registered here is admitted to every such dispatch, so one
   * pair covers every conversation.
   */
  /** @type {Map<string, ReturnType<typeof setInterval>>} live typing heartbeats, per session. */
  const typingHearts = new Map()

  const cards = new CardRegistry({
    timeoutMs: config.cardTimeoutMs,
    onTimeout: (card) => {
      const link = router.linkFor(card.sessionId) ?? { peerId: card.peerId }
      void notifyOrLog(link, CARD_TIMEOUT_NOTICE, 'card timeout notice')
    },
  })

  /**
   * Send one decision card and race the contact against the GUI.
   *
   * `next()` is the GUI's own answerer, so whoever settles first wins. A card
   * that times out is withdrawn rather than answered, which hands the decision
   * back to the GUI exactly as if the mirror did not exist.
   *
   * @param {object} request - the waterfall payload.
   * @param {() => Promise<unknown>} next - the host's remaining answerers.
   * @param {'approval'|'question'} kind - which card this is.
   * @returns {Promise<unknown>} the winning answer.
   */
  const mirrorDecision = async (request, next, kind) => {
    const session = request?.agent?.session ?? request?.agent
    const sessionId = sessionIdOf(session)
    const link = sessionId ? router.linkFor(sessionId) : undefined
    if (!link?.peerId || request?.signal?.aborted) return next()

    const questions = kind === 'question' && Array.isArray(request?.questions) ? request.questions : []
    if (kind === 'question' && questions.length === 0) return next()
    const text = kind === 'approval' ? formatApprovalCard(request) : formatQuestionCard(questions)

    // Swap in a signal this bridge controls BEFORE the GUI sees the request:
    // both GUI cards bind to `request.signal` and remove themselves when it
    // aborts, so answering from WeChat has to abort something to clear the card.
    // The request's own signal must not be used for that — the host captured it
    // before dispatching, and resolving the whole request as `cancelled` when it
    // fires would race the answer this bridge is about to return.
    const guiAbort = forkRequestSignal(request)

    const { promise, card } = cards.open({ peerId: peerKey(link), kind, sessionId, request })
    log('info', `wechat-ilink bridge: mirrored a ${kind} request to ${link.peerId} (session ${sessionId})`)
    void notifyOrLog(link, text, `${kind} card`)

    // The GUI half never rejects into the race: an answerer that cannot answer
    // (no client attached, or it threw) must leave the WeChat card as the only
    // one left, not collapse the request.
    const gui = Promise.resolve()
      .then(() => next())
      .then(
        (answer) => ({ source: 'gui', answer }),
        () => ({ source: 'gui-failed' }),
      )
    const wechat = promise.then(
      (answer) => ({ source: 'wechat', answer }),
      () => ({ source: 'withdrawn' }),
    )

    let winner = await Promise.race([gui, wechat])
    if (winner.source === 'gui-failed') winner = await wechat
    if (winner.source === 'withdrawn') {
      // Nobody answered in WeChat: the GUI is the only answerer left, so wait
      // for it rather than settling the request with nothing.
      const settled = await gui
      if (settled.source === 'gui') return settled.answer
      throw new Error('wechat-ilink bridge: no approval or question answerer accepted the request')
    }
    if (winner.source === 'gui') {
      cards.withdraw(card)
    } else {
      // Answered from WeChat: dismiss the GUI card, or it lingers on screen for
      // a request that has already been decided.
      dismissGuiCard(guiAbort)
    }
    return winner.answer
  }

  /**
   * Turn one inbound message into a pending card's answer.
   *
   * @param {object} card - the pending card.
   * @param {string} text - the contact's message.
   * @returns {{ ok: true, answer: unknown } | { ok: false, message: string }} the outcome.
   */
  const answerCard = (card, text) => {
    if (card.kind === 'approval') {
      const decision = parseApprovalReply(text)
      return decision === null ? { ok: false, message: APPROVAL_REPLY_HINT } : { ok: true, answer: decision }
    }
    const parsed = parseQuestionReply(text, card.request?.questions)
    // Normalize: the registry settles with `answer`, so the question branch must
    // wrap the parser's batch rather than leaking its own `answers` field.
    return parsed.ok ? { ok: true, answer: { answers: parsed.answers } } : parsed
  }

  /**
   * Assemble the model-facing content for one inbound message.
   *
   * @param {object} message - normalized inbound message.
   * @param {string} text - trimmed inbound text.
   * @returns {Array<{ type: string, text: string }>} content blocks.
   */
  const buildContent = (message, text) => {
    const blocks = []
    if (text) blocks.push({ type: 'text', text })
    const attachments = Array.isArray(message?.attachments) ? message.attachments : []
    if (attachments.length > 0) {
      const kinds = attachments.map((item) => (typeof item?.kind === 'string' ? item.kind : 'file'))
      blocks.push({
        type: 'text',
        text:
          `（对方还发送了 ${attachments.length} 个附件：${kinds.join('、')}；` +
          '当前通道暂不支持下载或转写附件内容。）',
      })
    }
    return blocks
  }

  /**
   * Run one bridge-owned command.
   *
   * @param {object} options - command inputs.
   * @param {{ name: string, args: string }} options.command - parsed command.
   * @param {string} options.canonical - conversation key.
   * @param {{ peerId: string, accountId: string, contextToken?: string }} options.peer - peer binding.
   * @returns {Promise<void>} resolves once the reply was attempted.
   */
  /**
   * Resolve the live session backing one conversation.
   *
   * @param {string} canonical - the router's key for this peer.
   * @returns {object | undefined} the session, once one has been opened.
   */
  const sessionFor = (canonical) => {
    const sessionId = router.sessionIdFor(canonical)
    const agent = sessionId ? router.agents()?.get?.(sessionId) : undefined
    return agent?.session
  }

  /**
   * Switch this conversation's model, reasoning effort or permission preset.
   *
   * All three append the very session events the GUI appends, which is why the
   * desktop follows along without being told: it renders projections of that
   * log, so there is no second copy to keep in step. Only the *default* for
   * future sessions lives in this plugin's config, and the settings page edits
   * that separately.
   *
   * @param {object} input - `{ command, canonical, peer }`.
   * @returns {Promise<void>} resolves once the reply was attempted.
   */
  const runSwitchCommand = async ({ command, canonical, peer }) => {
    const prefix = config.commandPrefix
    const session = sessionFor(canonical)
    if (!session) {
      await notify(peer, '⚠️ 本对话还没有会话，先发一条普通消息创建后再切换。')
      return
    }

    if (command.name === 'permission') {
      const state = readPermissionState(ctx, session)
      if (!command.args) {
        await notify(peer, permissionText(state, prefix))
        return
      }
      const result = selectPermission(ctx, session, command.args)
      await notify(peer, result.ok ? switchedText('权限预设', result.name) : `⚠️ ${result.message}`)
      return
    }

    const catalog = await readModelCatalog(ctx)
    const current = readSessionSelection(session).next

    if (command.name === 'effort') {
      const entry = current ? findModel(catalog, current.provider, current.model) : undefined
      if (!command.args) {
        await notify(
          peer,
          effortListText(entry ? { ...entry, provider: current.provider, model: current.model } : undefined, current, prefix),
        )
        return
      }
      const efforts = entry?.reasoning?.efforts ?? []
      const wanted = command.args.trim()
      if (!efforts.some((effort) => effort.id === wanted)) {
        const available = efforts.map((effort) => effort.id).join(' / ') || '（当前模型不支持思考档位）'
        await notify(peer, `⚠️ 当前模型没有档位「${wanted}」。可用：${available}`)
        return
      }
      const result = selectModel(session, { ...current, reasoningEffort: wanted })
      await notify(
        peer,
        result.ok ? switchedText('思考档位', describeSelection(result.selection)) : `⚠️ ${result.message}`,
      )
      return
    }

    if (!command.args) {
      await notify(peer, modelListText(catalog, current, prefix))
      return
    }
    const choice = parseModelChoice(command.args)
    const rows = flattenModels(catalog)
    let picked
    if (choice && 'index' in choice) {
      picked = rows[choice.index - 1]
      if (!picked) {
        await notify(peer, `⚠️ 序号超出范围（1–${rows.length}）。回复 ${prefix}model 看列表。`)
        return
      }
    } else if (choice) {
      const group = (catalog.groups ?? []).find((candidate) => candidate.id === choice.provider)
      const model = group?.models?.find((candidate) => candidate.id === choice.model)
      picked = model ? { provider: choice.provider, model } : undefined
      if (!picked) {
        await notify(peer, `⚠️ 目录里没有 ${choice.provider}/${choice.model}。回复 ${prefix}model 看列表。`)
        return
      }
    } else {
      await notify(peer, `⚠️ 用法：${prefix}model <序号> 或 ${prefix}model <provider>/<model>`)
      return
    }
    // Carry the effort over only when the new model actually offers it;
    // otherwise the model's own default applies rather than a value it rejects.
    const efforts = picked.model.reasoning?.efforts ?? []
    const keepEffort =
      current?.reasoningEffort && efforts.some((effort) => effort.id === current.reasoningEffort)
    const result = selectModel(session, {
      provider: picked.provider,
      model: picked.model.id,
      ...(keepEffort ? { reasoningEffort: current.reasoningEffort } : {}),
    })
    await notify(peer, result.ok ? switchedText('模型', describeSelection(result.selection)) : `⚠️ ${result.message}`)
  }

  const runCommand = async ({ command, canonical, peer }) => {
    switch (command.name) {
      case 'help': {
        await notify(peer, helpText(config.commandPrefix))
        return
      }
      case 'status': {
        const sessionId = router.sessionIdFor(canonical)
        const agent = sessionId ? router.agents()?.get?.(sessionId) : undefined
        const binding = router.bindingFor(canonical)
        await notify(
          peer,
          statusText({
            sessionId,
            agentStatus: agent?.status,
            agentPresent: Boolean(agent),
            selection: router.selection,
            config,
            channelReady: Boolean(channel()?.sendText),
            workspace: binding.cwd ?? router.cwd,
          }),
        )
        return
      }
      case 'new': {
        const previous = router.reset(canonical)
        log('info', `wechat-ilink bridge: ${peer.peerId} started a new session (previous=${previous ?? 'none'})`)
        await notify(
          peer,
          previous
            ? `✅ 已开启新会话。原会话 ${previous} 仍保留在 DSH 中，可随时从 GUI 继续。`
            : '✅ 已开启新会话。下一条消息将创建新的 DSH 会话。',
        )
        return
      }
      case 'model':
      case 'effort':
      case 'permission': {
        await runSwitchCommand({ command, canonical, peer })
        return
      }
      case 'stop': {
        const sessionId = router.sessionIdFor(canonical)
        const agent = sessionId ? router.agents()?.get?.(sessionId) : undefined
        if (!agent) {
          await notify(peer, '当前没有已打开的会话，无需中断。')
          return
        }
        const running = agent.status === 'running'
        try {
          agent.cancel?.({ kind: 'user' })
        } catch (error) {
          log('warn', `wechat-ilink bridge: cancel on ${sessionId} failed: ${String(error)}`)
        }
        // The aborted turn ends with a non-completed reason; the reply below
        // already explains it, so suppress the generic empty-turn notice.
        if (running && sessionId) quietTurns.add(sessionId)
        await notify(peer, running ? '⏹ 已请求中断当前回合。' : '当前没有正在运行的回合。')
        return
      }
      case 'current': {
        await notify(
          peer,
          currentText({
            binding: router.bindingFor(canonical),
            fallbackCwd: router.cwd,
            selection: router.selection,
            capabilities: host.capabilities(),
          }),
        )
        return
      }
      case 'workspaces': {
        const listing = host.listWorkspaces()
        await notify(
          peer,
          workspacesText({
            listing,
            current: router.bindingFor(canonical).cwd,
            prefix: config.commandPrefix,
          }),
        )
        return
      }
      case 'cwd': {
        const requested = command.args.trim()
        if (!requested) {
          const binding = router.bindingFor(canonical)
          await notify(
            peer,
            `📁 当前工作区：${binding.cwd ? binding.cwd : `（未选择，使用 ${router.cwd}）`}\n` +
              `用法：${config.commandPrefix}cwd <绝对路径>`,
          )
          return
        }
        const result = await host.ensureWorkspace(requested)
        if (!result.ok) {
          await notify(peer, cwdFailureText(requested, result.reason))
          return
        }
        router.setCwd(canonical, requested)
        log('info', `wechat-ilink bridge: ${peer.peerId} switched workspace to ${requested}`)
        await notify(
          peer,
          `✅ 工作区已切换为 ${requested}。\n` +
            `下一条消息会在这里新建会话；${config.commandPrefix}new 也会沿用该目录。`,
        )
        return
      }
      case 'sessions': {
        const binding = router.bindingFor(canonical)
        // A bound workspace narrows the listing, matching what the user sees.
        const listing = await host.listSessions({ workspacePath: binding.cwd })
        await notify(
          peer,
          sessionsText({
            listing,
            current: binding.sessionId,
            workspace: binding.cwd,
            prefix: config.commandPrefix,
          }),
        )
        return
      }
      case 'use': {
        const target = command.args.trim()
        if (!target) {
          await notify(peer, `用法：${config.commandPrefix}use <会话id>（用 ${config.commandPrefix}sessions 查看）`)
          return
        }
        const listing = await host.listSessions({ limit: 200 })
        if (!listing.available) {
          await notify(peer, UNAVAILABLE_TEXT)
          return
        }
        const found = listing.items.find((item) => item.id === target)
        if (!found) {
          await notify(peer, `⚠️ 未找到会话 ${target}。用 ${config.commandPrefix}sessions 查看可用的会话 id。`)
          return
        }
        router.adopt(canonical, found.id)
        if (found.cwd) router.setCwd(canonical, found.cwd)
        const opened = await router.ensureAgent(canonical, peer.channel).catch((error) => {
          log('warn', `wechat-ilink bridge: /use ${found.id} could not open the session: ${String(error)}`)
          return undefined
        })
        if (!opened) {
          router.reset(canonical)
          await notify(peer, `⚠️ 会话 ${found.id} 无法在此进程中打开（可能被另一个 DSH 实例占用）。`)
          return
        }
        log('info', `wechat-ilink bridge: ${peer.peerId} bound to existing session ${found.id}`)
        await notify(
          peer,
          `✅ 已绑定到会话 ${found.id}${found.title ? `（${clip(found.title, 40)}）` : ''}。\n` +
            '现在发消息就会接着这个会话聊。',
        )
        return
      }
      case 'peek': {
        const binding = router.bindingFor(canonical)
        const target = command.args.trim() || binding.sessionId || ''
        if (!target) {
          await notify(
            peer,
            `用法：${config.commandPrefix}peek [会话id]（当前还没有会话，先用 ${config.commandPrefix}sessions 选一个）`,
          )
          return
        }
        const history = await host.readHistory(target, PEEK_ENTRY_LIMIT)
        await notify(peer, peekText({ sessionId: target, history, prefix: config.commandPrefix }))
        return
      }
      default:
        return
    }
  }

  /**
   * Handle one inbound WeChat message.
   *
   * Every failure path ends in a WeChat notice: a contact's message must never
   * disappear silently, and a throw here must never surface as an unhandled
   * rejection.
   *
   * @param {object} message - normalized inbound message emitted by the channel.
   * @returns {Promise<void>} resolves once the message was dispatched or refused.
   */
  const onInbound = async (message) => {
    const peer = {
      accountId: typeof message?.accountId === 'string' && message.accountId ? message.accountId : 'default',
      peerId: typeof message?.fromUserId === 'string' ? message.fromUserId : '',
      // Which channel delivered this. The bridge is channel-agnostic, so the
      // service stamps its own key on the payload; an unstamped message means
      // the WeChat channel, which is what keeps the original path unchanged.
      ...(typeof message?.channel === 'string' && message.channel ? { channel: message.channel } : {}),
      ...(typeof message?.contextToken === 'string' && message.contextToken
        ? { contextToken: message.contextToken }
        : {}),
    }
    try {
      if (!message || typeof message !== 'object') return
      if (isEchoMessage(message)) {
        log('info', 'wechat-ilink bridge: ignoring echo of the bot\'s own message')
        return
      }
      const access = decideAccess(message, config)
      if (!access.allowed) {
        log('info', `wechat-ilink bridge: ignoring message from ${peer.peerId} (${access.reason})`)
        if (access.notify) {
          await notify(peer, message?.groupId ? DENIED_GROUP_NOTICE : DENIED_NOTICE)
        }
        return
      }
      const text = typeof message.text === 'string' ? message.text.trim() : ''
      const canonical = router.keyFor(message)
      // This message just refreshed the conversation window, so anything a closed
      // window refused can go out now — before the new turn's own output, so the
      // contact reads the exchange in the order it happened.
      void flushUndelivered(peer)
      const command = text ? parseCommand(text, config.commandPrefix) : null
      if (command && isKnownCommand(command.name)) {
        log('info', `wechat-ilink bridge: command ${config.commandPrefix}${command.name} from ${peer.peerId}`)
        await runCommand({ command, canonical, peer })
        return
      }
      // A pending decision card owns the next message. Management commands are
      // already handled above, so a card can never swallow one.
      const pending = cards.oldest(peerKey(peer))
      if (pending && text) {
        if (text.startsWith(config.commandPrefix)) {
          await notify(peer, cardCommandHint(text))
          return
        }
        const outcome = answerCard(pending, text)
        if (!outcome.ok) {
          await notify(peer, outcome.message)
          return
        }
        cards.resolve(pending, outcome.answer)
        log('info', `wechat-ilink bridge: answered a pending ${pending.kind} card from ${peer.peerId}`)
        return
      }
      const content = buildContent(message, text)
      if (content.length === 0) {
        log('info', `wechat-ilink bridge: ignoring empty message from ${peer.peerId}`)
        await notify(peer, EMPTY_NOTICE)
        return
      }
      const { agent, sessionId } = await router.ensureAgent(canonical, peer.channel)
      router.bind(sessionId, peer)
      dispatchInbound(
        agent,
        createUserMessage({
          content,
          source: { kind: 'wechat-ilink', accountId: peer.accountId, peerId: peer.peerId },
        }),
      )
      log('info', `wechat-ilink bridge: dispatched message from ${peer.peerId} to session ${sessionId}`)
      if (settingsFor(peer).typingIndicator !== false) void typing(peer)
    } catch (error) {
      log('error', `wechat-ilink bridge: failed to handle message from ${peer.peerId}: ${String(error)}`)
      await notify(peer, FAILURE_NOTICE)
    }
  }

  /**
   * Handle one session event for a WeChat-bound session.
   *
   * `assistant/message` is buffered per turn; `turn/end` flushes the whole turn
   * as a single WeChat message.
   *
   * @param {unknown} session - session subject of the event.
   * @param {object} event - the session event (`{ type, data }`).
   * @returns {void}
   */
  const onSessionEvent = (session, event) => {
    const sessionId = sessionIdOf(session)
    if (!sessionId) return
    const link = router.linkFor(sessionId)
    if (!link) return
    const data = event?.data
    if (event?.type === 'assistant/message') {
      const text = assistantTextOf(data?.message)
      if (!text) return
      // The buffer records the turn's text in BOTH modes: `compact` needs it to
      // tell a text-bearing turn from an empty one at `turn/end`, without ever
      // re-sending what incremental delivery already sent.
      buffer.append(sessionId, data?.turn, text)
      if (settingsFor(link).displayMode === 'compact') queueSegment(sessionId, data?.turn, link, text)
      return
    }
    if (event?.type === 'turn/start') {
      if (settingsFor(link).typingIndicator !== false) void typing(link)
      startTypingHeartbeat(sessionId, link)
      return
    }
    if (event?.type !== 'turn/end') return
    const typingEntry = stopTypingHeartbeat(sessionId)
    // Retract the indicator if the channel's does not expire by itself. WeChat's
    // does, so this is a no-op there; a Feishu reaction would otherwise stay.
    void clearTyping(typingEntry?.link ?? link)
    // The turn is over, so nothing more will join the batch: send it now rather
    // than make the contact wait out a coalescing window for the last line.
    flushSegments(sessionId, data?.turn)
    // A `/stop` reply already explained this turn; consume the suppression flag
    // whether or not the turn produced text, so the set cannot grow.
    const suppressed = quietTurns.delete(sessionId)
    const reply = buffer.take(sessionId, data?.turn)
    if (settingsFor(link).displayMode === 'compact') {
      // Incremental delivery already sent every segment as it landed, so the
      // buffered text is only evidence that this turn produced something.
      if (reply || suppressed) return
    } else if (reply) {
      // The reply is the one payload whose loss leaves the contact waiting, so
      // its outcome is inspected: a failure escalates into a second notice.
      void deliverTurnReply(link, reply).catch((error) => {
        log('error', `wechat-ilink bridge: reply delivery crashed for ${link.peerId}: ${String(error)}`)
      })
      return
    } else if (suppressed) {
      return
    }
    const kind = reasonKindOf(data?.reason)
    if (kind && kind !== 'completed') {
      log('info', `wechat-ilink bridge: turn ended without text (${kind}) for ${link.peerId}`)
      void notifyOrLog(link, EMPTY_TURN_NOTICE, 'empty-turn notice')
    }
  }

  /**
   * Surface an agent-loop failure to the bound peer.
   *
   * @param {object} payload - the `agent/error` payload.
   * @returns {void}
   */
  const onAgentError = (payload) => {
    const sessionId =
      typeof payload?.agent?.id === 'string'
        ? payload.agent.id
        : typeof payload?.agent?.session?.id === 'string'
          ? payload.agent.session.id
          : undefined
    const link = sessionId ? router.linkFor(sessionId) : undefined
    if (!link) return
    const detail = payload?.error?.message ?? payload?.error
    log('error', `wechat-ilink bridge: agent error in ${sessionId}: ${String(detail)}`)
    void notifyOrLog(
      link,
      `⚠️ DSH agent 出错：${detail ? String(detail).slice(0, 300) : '未知错误'}`,
      'agent-error notice',
    )
  }

  // Cordis scopes these to the plugin fiber, so they unwind on unload anyway;
  // the returned disposers make that explicit and keep the row usable from a
  // host that does not scope listeners.
  const disposers = [
    ctx.on?.('wechat-ilink/message', (message) => {
      void onInbound(message)
    }),
    ctx.on?.('session/event', onSessionEvent),
    ctx.on?.('agent/error', onAgentError),
    // `prepend` matters: it makes this listener wrap the GUI's own answerer, so
    // `next()` really is the competing answer and the race is a race. Registered
    // after it, `next()` would be the host's "no answerer" fallback instead.
    ctx.on?.(
      'approval/request',
      (request, next) => mirrorDecision(request, next, 'approval').catch(() => next()),
      { prepend: true },
    ),
    ctx.on?.(
      'user-questions/request',
      (request, next) => mirrorDecision(request, next, 'question').catch(() => next()),
      { prepend: true },
    ),
  ]

  return () => {
    for (const remove of disposers) {
      try {
        remove?.()
      } catch {
        // A host disposer that throws must not block the rest of teardown.
      }
    }
    cards.dispose()
    router.dispose()
    clearBridgeSettings()
    for (const sessionId of [...typingHearts.keys()]) stopTypingHeartbeat(sessionId)
    stopAllSegments()
    undelivered.clear()
    buffer.clear()
    quietTurns.clear()
  }
}

/**
 * Hand one inbound message to the agent, interrupting rather than queueing.
 *
 * `send(message, 'next-turn', true)` parks the message until the running turn
 * ends. On a long turn that is a long silence for a chat surface: the contact
 * writes a follow-up, nothing reacts, and the line is only read once the work
 * they were already waiting on has finished. `steer` splices it into the
 * agent's *next step boundary* instead, so the running turn sees it while it is
 * still working — the same thing the GUI's own steer action does.
 *
 * The host exposes this as `agent.steer()`; the raw `send(message, 'next-step',
 * true)` form is its documented equivalent and the fallback here, because the
 * agent object is read structurally (docs/INTERFACES.md §2.0).
 *
 * @param {object} agent - the session's agent.
 * @param {object} message - the user message to deliver.
 * @returns {void}
 */
function dispatchInbound(agent, message) {
  if (typeof agent?.steer === 'function') {
    agent.steer(message)
    return
  }
  if (typeof agent?.send === 'function') agent.send(message, 'next-step', true)
}

/**
 * Give the rest of a decision waterfall a signal this bridge can abort itself.
 *
 * Both GUI cards (`dsh-client-ui-approval`, `dsh-client-ui-user-questions`) bind
 * to `request.signal` and remove themselves when it aborts, so an answer given
 * from WeChat has to abort *something* to clear the card the contact can no
 * longer act on. The request's own signal cannot serve that purpose: the host
 * captures it before dispatching (`dsh-user-approval`'s `decide()`), so aborting
 * it resolves the entire request as `cancelled` — racing the very answer this
 * bridge is about to return. Swapping in a forked signal, with real aborts still
 * forwarded to it, gives the card a lifetime this bridge owns.
 *
 * @param {object} request - the waterfall payload; `signal` is replaced in place.
 * @returns {AbortController} the fork.
 */
function forkRequestSignal(request) {
  const fork = new AbortController()
  const original = request?.signal
  if (original && typeof original.addEventListener === 'function') {
    const forward = () => {
      if (!fork.signal.aborted) fork.abort(original.reason)
    }
    if (original.aborted) forward()
    else original.addEventListener('abort', forward, { once: true })
  }
  if (request && typeof request === 'object') request.signal = fork.signal
  return fork
}

/**
 * Dismiss the GUI card for a request this bridge already answered from WeChat.
 *
 * @param {AbortController} fork - the controller returned by {@link forkRequestSignal}.
 * @returns {void}
 */
function dismissGuiCard(fork) {
  if (!fork || fork.signal.aborted) return
  fork.abort(new Error('wechat-ilink bridge: answered from WeChat'))
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

export default apply
