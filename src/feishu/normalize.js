/**
 * Feishu inbound event → the bridge's one message shape.
 *
 * Two failure modes from the reference implementation are load-bearing here,
 * because both present to the contact as "I sent a message and the bot ignored
 * me" — the hardest kind of bug to trace back from the symptom:
 *
 * 1. **The SDK does not always nest the payload.** `EventDispatcher` has been
 *    observed handing the event's fields to the top level instead of under
 *    `event`, so reading only `payload.event.message` parses every real message
 *    into nothing.
 * 2. **A rich-text or link message arrives as `message_type: "post"`**, not
 *    `text`. Reading only `content.text` yields an empty string, and an empty
 *    string is dropped as "not a message" — so an ordinary-looking message in
 *    the Feishu client disappears without a trace.
 *
 * Zero `@deepseek-ai/*` imports (docs/INTERFACES.md §2.0).
 *
 * @module wechat-feishu-linker/feishu/normalize
 */

/** The channel key every message from here carries. */
export const FEISHU_CHANNEL = 'feishu'

/**
 * Is this a plain object?
 *
 * @param {unknown} value - candidate.
 * @returns {boolean} whether it is a record.
 */
const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * Read a non-empty string field.
 *
 * @param {unknown} source - object to read from.
 * @param {string} key - field name.
 * @returns {string} the value, or an empty string.
 */
const readString = (source, key) => {
  if (!isRecord(source)) return ''
  const value = source[key]
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * Parse a field that Feishu sends as a JSON string.
 *
 * @param {unknown} value - string or already-parsed object.
 * @returns {object | null} the record, or null.
 */
export function parseJsonRecord(value) {
  if (isRecord(value)) return value
  if (typeof value !== 'string' || !value.trim()) return null
  try {
    const parsed = JSON.parse(value)
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

/**
 * Strip the bot mention out of a message body.
 *
 * Deliberately narrower than the reference implementation, which removes every
 * `@word`: that also eats an email address or a handle the contact actually
 * typed. Feishu encodes a mention in text as the placeholder `@_user_N` and in
 * rich text as an `<at>` element, so those two are what get removed.
 *
 * @param {string} text - the raw body.
 * @returns {string} the body without mentions.
 */
export function stripMentions(text) {
  return String(text ?? '')
    .replace(/<at\b[^>]*>[\s\S]*?<\/at>/giu, '')
    .replace(/@_user_\d+/gu, '')
    .replace(/[ \t]{2,}/gu, ' ')
    .trim()
}

/**
 * Flatten one rich-text (`post`) element into plain text.
 *
 * @param {unknown} token - an element, an array of elements, or a string.
 * @returns {string} its text.
 */
export function postTokenText(token) {
  if (typeof token === 'string') return token
  if (Array.isArray(token)) return token.map(postTokenText).filter(Boolean).join('')
  if (!isRecord(token)) return ''
  // An `at` element is a mention, not content.
  if (readString(token, 'tag') === 'at') return ''
  const nested = token.content ?? token.children ?? token.elements
  const nestedText = Array.isArray(nested) ? postTokenText(nested) : ''
  const text = readString(token, 'text') || readString(token, 'un_escape_text') || readString(token, 'name') || nestedText
  if (readString(token, 'tag') === 'a') {
    const href = readString(token, 'href')
    // A link whose label differs from its target must keep both, or the contact
    // sees a word with no idea where it points.
    if (href && href !== text) return text ? `${text} ${href}` : href
  }
  return text
}

/**
 * Read the text of a `post` (rich text) message.
 *
 * The body is nested twice — locale, then an array of lines of elements — and
 * older payloads also nest the whole thing under `post`.
 *
 * @param {object | null} content - the parsed content.
 * @returns {string} the text.
 */
export function postText(content) {
  if (!content) return ''
  const post = isRecord(content.post) ? content.post : null
  const zhCn = isRecord(content.zh_cn) ? content.zh_cn : isRecord(post?.zh_cn) ? post.zh_cn : null
  const enUs = isRecord(content.en_us) ? content.en_us : isRecord(post?.en_us) ? post.en_us : null
  const lines = content.content ?? zhCn?.content ?? enUs?.content
  const title = readString(content, 'title') || readString(zhCn, 'title') || readString(enUs, 'title')
  const body = Array.isArray(lines)
    ? lines
        .map((line) => postTokenText(line).trim())
        .filter(Boolean)
        .join('\n')
    : ''
  return [title, body].filter(Boolean).join('\n')
}

/**
 * Which kind of conversation this is.
 *
 * @param {string} value - Feishu's `chat_type`.
 * @returns {'group' | 'private'} the kind.
 */
export function chatTypeOf(value) {
  return value === 'group' || value === 'group_chat' ? 'group' : 'private'
}

/**
 * Unwrap the event, tolerating the SDK's flattened delivery.
 *
 * @param {unknown} payload - what the dispatcher handed over.
 * @returns {object | null} the event record, or null.
 */
export function unwrapEvent(payload) {
  if (!isRecord(payload)) return null
  return isRecord(payload.event) ? payload.event : payload
}

/**
 * Turn one `im.message.receive_v1` payload into the bridge's message shape.
 *
 * Returns null when there is nothing to act on — no text, no sender, or the
 * message is the bot's own. The caller logs the reason rather than guessing.
 *
 * @param {unknown} payload - the dispatcher payload.
 * @param {{ accountId?: string, botOpenId?: string }} [options] - context.
 * @returns {object | null} the message, or null when it is not actionable.
 */
export function normalizeInbound(payload, options = {}) {
  const event = unwrapEvent(payload)
  if (!event) return null
  const message = isRecord(event.message) ? event.message : null
  if (!message) return null
  const sender = isRecord(event.sender) ? event.sender : null
  const senderId = isRecord(sender?.sender_id) ? sender.sender_id : null

  const openId =
    readString(senderId, 'open_id') ||
    readString(senderId, 'user_id') ||
    readString(senderId, 'union_id') ||
    readString(event, 'open_id') ||
    readString(event, 'user_id') ||
    readString(event, 'union_id')
  if (!openId) return null
  // The bot's own messages arrive on the same event type; mirroring them would
  // make the channel talk to itself forever.
  if (options.botOpenId && openId === options.botOpenId) return null

  const content = parseJsonRecord(message.content)
  const messageType = readString(message, 'message_type') || readString(message, 'msg_type')
  const rawText =
    readString(content, 'text') ||
    postText(content) ||
    readString(event, 'text_without_at_bot') ||
    readString(event, 'text')
  const text = stripMentions(rawText)
  if (!text) return null

  const chatId = readString(message, 'chat_id') || readString(event, 'open_chat_id')
  const chatType = chatTypeOf(readString(message, 'chat_type') || readString(event, 'chat_type'))
  const messageId = readString(message, 'message_id')
  const createTime = Number(readString(message, 'create_time'))

  return {
    channel: FEISHU_CHANNEL,
    accountId: options.accountId || 'default',
    // The bridge sends to `fromUserId`, so it is the reply target: a group's
    // chat id in a group, the person's open id in a direct chat.
    fromUserId: chatType === 'group' && chatId ? chatId : openId,
    // Who actually spoke, which in a group is not the reply target.
    senderId: openId,
    ...(chatType === 'group' && chatId ? { groupId: chatId } : {}),
    text,
    messageType,
    itemTypes: ['text'],
    attachments: [],
    createdAt: Number.isFinite(createTime) && createTime > 0 ? createTime : Date.now(),
    // The contact's own message id — what the "typing" reaction is attached to,
    // and the only handle the outbound side has on this exchange.
    ...(messageId ? { contextToken: messageId } : {}),
  }
}
