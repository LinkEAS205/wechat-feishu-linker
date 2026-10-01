/**
 * Approval and question cards mirrored to WeChat.
 *
 * DSH asks its user for two kinds of decisions, each dispatched as a waterfall
 * scoped to the owning agent:
 *
 *   `approval/request`        `{ agent, toolName, callId?, reason?, signal }`
 *                             → `'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'`
 *   `user-questions/request`  `{ questions: [{ id, question, options: [{ label }] }], agent, signal }`
 *                             → `{ answers: [{ id, selected: [label], custom? }] }`
 *
 * A GUI-driven session renders both natively. A WeChat-driven one has nobody
 * looking at the GUI, so without a mirror the agent blocks forever on a prompt
 * the contact cannot see — the request simply never appears. This module renders
 * the cards, parses the reply, and holds the pending card so the contact's next
 * message can settle it.
 *
 * The host validates a question answer batch strictly: it must name each of the
 * batch's questions exactly once, so a partial multi-question reply is refused
 * here (and the card stays open) rather than silently defaulted.
 *
 * @module wechat-feishu-linker/bridge/cards
 */

/** How long a mirrored card waits for a WeChat reply before withdrawing. */
export const DEFAULT_CARD_TIMEOUT_MS = 30 * 60 * 1000

/** The only granting outcome the host's `approval/request` waterfall accepts. */
export const APPROVAL_ALLOW = 'allowed-once'

/** The refusing outcome for one approval request. */
export const APPROVAL_REJECT = 'rejected'

/** Reply words that grant a single approval. */
const ALLOW_WORDS = new Set(['1', 'once', 'allow', 'allowed', 'yes', 'y', 'ok', '允许', '同意', '可以', '好'])

/** Reply words that refuse one approval. */
const REJECT_WORDS = new Set(['2', 'reject', 'rejected', 'deny', 'no', 'n', '拒绝', '不行', '不允许', '不用'])

/** Hint repeated when an approval reply cannot be understood. */
export const APPROVAL_REPLY_HINT = '⚠️ 请回复 1（仅允许这一次）或 2（拒绝）。'

/** Notice sent when a card times out with nobody answering. */
export const CARD_TIMEOUT_NOTICE = '⏰ 之前的请求超时未回复，已撤回；仍可在 DSH 界面处理。'

/**
 * Build the notice for a command-shaped line this bridge does not own.
 *
 * Such a line is almost certainly meant as a command, so submitting it as a
 * free-text answer would silently decide the question with e.g. `/rp`. Naming
 * the offending line is what makes the notice actionable.
 *
 * @param {unknown} text - the line the contact sent.
 * @returns {string} the notice.
 */
export function cardCommandHint(text) {
  const shown = String(text ?? '').trim().slice(0, 40)
  return (
    `⚠️ 「${shown}」以命令前缀开头，但不是本插件认识的命令，所以没有当作卡片回答提交。` +
    '请回复卡片上的选项序号，或直接回复你的答案。'
  )
}

/**
 * Render one approval request as a WeChat card.
 *
 * Mirrors the GUI card's information (tool + reason + the two outcomes) because
 * it answers the same waterfall: WeChat and the GUI race, first answer wins.
 *
 * @param {object} request - the `approval/request` payload.
 * @returns {string} the card text.
 */
export function formatApprovalCard(request) {
  const tool = typeof request?.toolName === 'string' && request.toolName ? request.toolName : '(未知工具)'
  const reason = typeof request?.reason === 'string' ? request.reason.trim() : ''
  const lines = ['🔒 需要权限确认', '', `工具: ${tool}`]
  if (reason) {
    lines.push('', '详情:')
    for (const line of reason.split(/\r?\n/u).slice(0, 20)) lines.push(`  ${line}`)
  }
  lines.push('', '请回复其中一个：', '  1 — 仅允许这一次', '  2 — 拒绝')
  return lines.join('\n')
}

/**
 * Parse a WeChat reply into an approval outcome.
 *
 * @param {unknown} text - the contact's message.
 * @returns {'allowed-once' | 'rejected' | null} the outcome, or null when unclear.
 */
export function parseApprovalReply(text) {
  const value = String(text ?? '').trim().toLowerCase()
  if (value === '') return null
  if (ALLOW_WORDS.has(value)) return APPROVAL_ALLOW
  if (REJECT_WORDS.has(value)) return APPROVAL_REJECT
  return null
}

/**
 * Render a question batch as a WeChat card.
 *
 * @param {object[]} questions - the batch (`{ id, question, options }`).
 * @returns {string} the card text.
 */
export function formatQuestionCard(questions) {
  const lines = ['❓ 需要你选择', '']
  questions.forEach((question, index) => {
    const text = typeof question?.question === 'string' ? question.question : '(未命名问题)'
    lines.push(questions.length > 1 ? `Q${index + 1}. ${text}` : text)
    const choices = Array.isArray(question?.options) ? question.options : []
    choices.forEach((choice, choiceIndex) => {
      const label = typeof choice?.label === 'string' ? choice.label : String(choice?.label ?? '')
      lines.push(`  ${choiceIndex + 1}. ${label}`)
    })
    if (questions.length > 1) lines.push('')
  })
  lines.push('')
  if (questions.length === 1) {
    lines.push('回复序号，或直接回复你的答案。')
  } else {
    lines.push(`回复 ${questions.map((_, index) => `Q${index + 1}=序号`).join(' ')}，例如 Q1=1 Q2=2。`)
  }
  lines.push('（超时未回复会自动撤回，之后可在 DSH 界面继续回答）')
  return lines.join('\n')
}

/**
 * Parse a WeChat reply into one host answer batch.
 *
 * @param {unknown} text - the contact's message.
 * @param {object[]} questions - the same batch that was rendered.
 * @returns {{ ok: true, answers: object[] } | { ok: false, message: string }} the outcome.
 */
export function parseQuestionReply(text, questions) {
  const raw = String(text ?? '').trim()
  const batch = Array.isArray(questions) ? questions : []
  if (raw === '') return { ok: false, message: '⚠️ 回复为空，请选择后再发送。' }
  if (batch.length === 0) return { ok: false, message: '⚠️ 本次提问已失效，请重新发起。' }
  if (batch.length === 1) return { ok: true, answers: [answerFor(batch[0], raw)] }

  const marks = [...raw.matchAll(/Q\s*(\d+)\s*[=:：-]\s*/giu)]
  if (marks.length === 0) {
    return { ok: false, message: '⚠️ 多题请用 Q1=… Q2=… 的格式回复，例如 Q1=1 Q2=2。' }
  }
  const parts = new Map()
  marks.forEach((mark, index) => {
    const start = mark.index + mark[0].length
    const end = index + 1 < marks.length ? marks[index + 1].index : raw.length
    parts.set(Number(mark[1]), raw.slice(start, end).trim())
  })
  const missing = []
  const answers = batch.map((question, index) => {
    const value = parts.get(index + 1)
    if (!value) {
      missing.push(`Q${index + 1}`)
      return null
    }
    return answerFor(question, value)
  })
  if (missing.length > 0) {
    return { ok: false, message: `⚠️ 还差 ${missing.join('、')}，请补全后重发。` }
  }
  return { ok: true, answers }
}

/**
 * One question's answer: a numbered choice, an exact option label, or free text.
 *
 * @param {object} question - the question being answered.
 * @param {string} value - the raw reply segment.
 * @returns {{ id: string, selected: string[], custom?: string }} the host answer item.
 */
function answerFor(question, value) {
  const labels = (Array.isArray(question?.options) ? question.options : [])
    .map((option) => (typeof option?.label === 'string' ? option.label : ''))
    .filter((label) => label !== '')
  const numeric = /^\d+$/u.test(value) ? Number(value) : null
  if (numeric !== null && numeric >= 1 && numeric <= labels.length) {
    return { id: question.id, selected: [labels[numeric - 1]] }
  }
  const exact = labels.find((label) => label === value)
  if (exact !== undefined) return { id: question.id, selected: [exact] }
  // Free text: the host carries it as `custom` alongside an empty selection.
  return { id: question.id, selected: [], custom: value }
}

/**
 * The cards currently waiting for each contact's next message.
 *
 * One card per contact is answerable at a time (the oldest); the rest stay
 * queued so a batch of parallel requests cannot scramble their replies.
 */
export class CardRegistry {
  /** @type {Map<string, object[]>} */
  #byPeer = new Map()

  #timeoutMs

  #onTimeout

  #disposed = false

  /**
   * @param {{ timeoutMs?: number, onTimeout?: (card: object) => void }} [options] - registry inputs.
   */
  constructor(options = {}) {
    this.#timeoutMs =
      Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : DEFAULT_CARD_TIMEOUT_MS
    this.#onTimeout = typeof options.onTimeout === 'function' ? options.onTimeout : undefined
  }

  /**
   * Register a card and hand back the promise its waterfall awaits.
   *
   * @param {{ peerId: string, kind: 'approval'|'question', sessionId: string, request: object }} entry - card inputs.
   * @returns {{ promise: Promise<unknown>, card: object }} the awaiting promise and its card.
   */
  open(entry) {
    let settle
    let cancel
    const promise = new Promise((resolve, reject) => {
      settle = resolve
      cancel = reject
    })
    const card = {
      peerId: entry.peerId,
      kind: entry.kind,
      sessionId: entry.sessionId,
      request: entry.request,
      settled: false,
      settle,
      cancel,
      timer: null,
    }
    if (!this.#disposed) {
      card.timer = setTimeout(() => {
        if (card.settled) return
        this.#detach(card)
        card.settled = true
        card.cancel(Object.assign(new Error('the WeChat card was withdrawn'), { code: 'ASK_WITHDRAWN' }))
        try {
          this.#onTimeout?.(card)
        } catch {
          // A timeout observer must never break teardown.
        }
      }, this.#timeoutMs)
      const list = this.#byPeer.get(card.peerId) ?? []
      list.push(card)
      this.#byPeer.set(card.peerId, list)
    }
    return { promise, card }
  }

  /**
   * The card a contact's next message should answer.
   *
   * @param {string} peerId - the contact.
   * @returns {object | undefined} the oldest unsettled card.
   */
  oldest(peerId) {
    const list = this.#byPeer.get(peerId)
    if (!list) return undefined
    return list.find((card) => !card.settled)
  }

  /**
   * Answer a card and retire it.
   *
   * @param {object} card - the card to settle.
   * @param {unknown} answer - the host-shaped answer.
   * @returns {void}
   */
  resolve(card, answer) {
    if (!card || card.settled) return
    card.settled = true
    this.#detach(card)
    card.settle(answer)
  }

  /**
   * Retire a card without answering it (the GUI answered first, or teardown).
   *
   * @param {object} card - the card to withdraw.
   * @returns {void}
   */
  withdraw(card) {
    if (!card || card.settled) return
    card.settled = true
    this.#detach(card)
    card.cancel(Object.assign(new Error('the WeChat card was withdrawn'), { code: 'ASK_WITHDRAWN' }))
  }

  /** Withdraw every card; used when the bridge unloads. */
  dispose() {
    this.#disposed = true
    for (const list of this.#byPeer.values()) {
      for (const card of list) this.withdraw(card)
    }
    this.#byPeer.clear()
  }

  /**
   * @param {object} card - the card to unlink.
   * @returns {void}
   */
  #detach(card) {
    if (card.timer !== null) {
      clearTimeout(card.timer)
      card.timer = null
    }
    const list = this.#byPeer.get(card.peerId)
    if (!list) return
    const index = list.indexOf(card)
    if (index >= 0) list.splice(index, 1)
    if (list.length === 0) this.#byPeer.delete(card.peerId)
  }
}
