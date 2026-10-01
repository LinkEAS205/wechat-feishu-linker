/**
 * iLink payload normalization: inbound messages → bridge shape, outbound text → send body.
 *
 * Protocol truth source (read-only reference):
 *   `zai-org/ZCode` `packages/services/src/bots/providers/packages/services/src/bots/providers/weixinProvider.ts:160-514`
 *   cross-checked against the eight independent open-source iLink clients (message array field is `msgs`).
 * Frozen contract: `docs/INTERFACES.md` §1 + §3.3.
 *
 * @module wechat-feishu-linker/ilink/normalize
 */
import { randomUUID } from 'node:crypto'
import { guessMimeFromFilename } from './media.js'

/** `message_type` of a message the bot itself sent → must be skipped (echo guard). */
export const MESSAGE_TYPE_BOT = 2

/** `message_state` of a finished message. 对齐 ZCode weixinProvider.ts:17 */
export const MESSAGE_STATE_FINISH = 2

/** `item_list[].type` of a text item. 对齐 ZCode weixinProvider.ts:622 */
export const ITEM_TYPE_TEXT = 1

/** Default `client_id` prefix for outbound messages. */
export const CLIENT_ID_PREFIX = 'dsh-wechat-'

/** Keys that may hold the inbound message array, in priority order (`msgs` first). */
const MESSAGE_ARRAY_KEYS = ['msgs', 'messages', 'msg_list', 'updates', 'items', 'list']

/** Keys that may hold the next sync cursor, in priority order. */
const CURSOR_KEYS = ['get_updates_buf', 'buf', 'next_buf', 'nextBuf', 'getUpdatesBuf', 'syncKey', 'sync_buf']

/** `item_list[]` keys that hold a media payload. */
const MEDIA_ITEM_KEYS = ['image_item', 'file_item', 'video_item', 'audio_item', 'voice_item', 'media_item']

/** Sentence terminators preferred as chunk boundaries (checked after hard line breaks). */
const SENTENCE_END_CHARS = '。！？；!?;'

/**
 * Extract the inbound message array from a `getupdates` payload.
 *
 * The wire field is **`msgs`**; `data` (as a wrapper), `messages` and `msg_list` are kept as
 * compatibility fallbacks. 对齐 docs/INTERFACES.md §1 + weclaw ilink/types.go:62-69.
 *
 * @param {unknown} payload Parsed `getupdates` response.
 * @returns {object[]} Message records (non-objects are dropped).
 */
export function readRawMessages(payload) {
  if (Array.isArray(payload)) return payload.filter(isRecord)
  if (!isRecord(payload)) return []

  const data = payload.data
  if (Array.isArray(data)) return data.filter(isRecord)
  const container = isRecord(data) ? data : payload

  for (const key of MESSAGE_ARRAY_KEYS) {
    const value = container[key]
    if (Array.isArray(value)) return value.filter(isRecord)
    if (isRecord(value)) return [value]
  }
  return []
}

/**
 * Extract the next `get_updates_buf` cursor from a `getupdates` payload.
 *
 * An empty cursor is reported as `undefined` so callers keep the previous value (returning `''`
 * would silently rewind the stream and duplicate messages).
 *
 * @param {unknown} payload Parsed `getupdates` response.
 * @returns {string | undefined} New cursor, or `undefined` when absent/empty.
 */
export function extractNextBuf(payload) {
  if (!isRecord(payload)) return undefined
  const containers = []
  if (isRecord(payload.data)) containers.push(payload.data)
  containers.push(payload)
  for (const container of containers) {
    for (const key of CURSOR_KEYS) {
      const value = container[key]
      if (typeof value === 'string' && value !== '') return value
    }
  }
  return undefined
}

/**
 * Normalize one raw inbound message.
 *
 * Returns `null` (skip) when the message is the bot's own echo (`message_type === 2`), when it
 * carries neither text nor attachments, or when no sender id can be found.
 * 对齐 ZCode weixinProvider.ts:488-514.
 *
 * @param {unknown} raw One element of the `msgs` array.
 * @returns {null | {
 *   fromUserId: string,
 *   text: string,
 *   contextToken?: string,
 *   messageId?: string,
 *   chatId?: string,
 *   itemTypes: string[],
 *   attachments: Array<{ id?: string, kind: 'image'|'audio'|'video'|'file', filename?: string, mimeType?: string, downloadUrl?: string, aesKey?: string, sizeBytes?: number }>,
 * }}
 */
export function normalizeInboundMessage(raw) {
  if (!isRecord(raw)) return null
  const inner = readInnerMessage(raw)
  if (readNumber(raw, 'message_type') === MESSAGE_TYPE_BOT) return null
  if (inner && readNumber(inner, 'message_type') === MESSAGE_TYPE_BOT) return null

  const text = readMessageText(raw, inner).trim()
  const attachments = readAttachments(raw, inner)
  const fromUserId = readFromUserId(raw).trim()
  if ((!text && attachments.length === 0) || !fromUserId) return null

  const contextToken = readContextToken(raw, inner)
  const messageId = readMessageId(raw, inner)
  const chatId = readChatId(raw)
  return {
    fromUserId,
    text,
    ...(contextToken ? { contextToken } : {}),
    ...(messageId ? { messageId } : {}),
    ...(chatId ? { chatId } : {}),
    itemTypes: readItemTypes(raw, inner),
    attachments,
  }
}

/**
 * Build the `sendmessage` request body.
 *
 * `from_user_id` is always written — even as `''` — and `client_id` always has a value, because
 * a `sendmessage` missing either of them (or the top-level `base_info`) can answer HTTP 200 + `{}`
 * without ever being delivered. 对齐 docs/INTERFACES.md §1 + ZCode weixinProvider.ts:610-629.
 *
 * @param {object} params
 * @param {string} [params.fromUserId] Bot's own iLink user id (`''` is valid).
 * @param {string} params.toUserId Peer iLink user id.
 * @param {string} params.text Message text (newlines are normalized to CRLF).
 * @param {string} [params.contextToken] `context_token` from the inbound message.
 * @param {string} [params.clientId] Client id; defaults to `dsh-wechat-<uuid>`.
 * @returns {{ msg: Record<string, unknown> }} Request body without `base_info` (the client adds it).
 * @throws {TypeError} When `toUserId` is missing.
 */
export function buildSendBody({ fromUserId = '', toUserId, text, contextToken, clientId } = {}) {
  if (typeof toUserId !== 'string' || toUserId.trim() === '') {
    throw new TypeError('buildSendBody requires toUserId')
  }
  const msg = {
    from_user_id: typeof fromUserId === 'string' ? fromUserId : '',
    to_user_id: toUserId,
    client_id: typeof clientId === 'string' && clientId !== '' ? clientId : `${CLIENT_ID_PREFIX}${randomUUID()}`,
    message_type: MESSAGE_TYPE_BOT,
    message_state: MESSAGE_STATE_FINISH,
    ...(typeof contextToken === 'string' && contextToken !== '' ? { context_token: contextToken } : {}),
    item_list: [
      {
        type: ITEM_TYPE_TEXT,
        text_item: { text: normalizeOutboundText(text) },
      },
    ],
  }
  return { msg }
}

/**
 * Normalize newlines to CRLF before sending.
 *
 * WeChat clients disagree on how they render LF, so `\r\n|\r|\n` all become `\r\n`.
 * 对齐 ZCode weixinProvider.ts:482-486.
 *
 * @param {unknown} text Raw text.
 * @returns {string} Text with CRLF newlines.
 */
export function normalizeOutboundText(text) {
  const value = typeof text === 'string' ? text : text === null || text === undefined ? '' : String(text)
  return value.replace(/\r\n|\r|\n/g, '\r\n')
}

/**
 * Split long text into sendable chunks.
 *
 * Boundaries are preferred in this order: hard line break → sentence terminator → whitespace →
 * hard cut at `maxLength`. Cuts never split a UTF-16 surrogate pair (nor a `\r\n` pair), and
 * `chunks.join('') === text` always holds.
 *
 * @param {string} text Text to split.
 * @param {number} maxLength Maximum chunk length in UTF-16 code units.
 * @returns {string[]} Chunks; `[]` for empty input.
 * @throws {RangeError} When `maxLength` is not a positive number.
 */
export function chunkText(text, maxLength) {
  const source = typeof text === 'string' ? text : text === null || text === undefined ? '' : String(text)
  if (source.length === 0) return []
  const limit = Math.floor(Number(maxLength))
  if (!Number.isFinite(limit) || limit < 1) {
    throw new RangeError('chunkText requires maxLength >= 1')
  }
  if (source.length <= limit) return [source]

  const chunks = []
  let start = 0
  while (start < source.length) {
    let end = Math.min(start + limit, source.length)
    if (end < source.length) {
      const boundary = findBoundary(source, start, end)
      if (boundary > start) end = boundary
      end = adjustCut(source, start, end)
    }
    chunks.push(source.slice(start, end))
    start = end
  }
  return chunks
}

/**
 * Find the best cut position in `(start, end]`.
 *
 * Scans backwards so the latest boundary wins, preferring a line break over a sentence
 * terminator over whitespace.
 *
 * @param {string} source
 * @param {number} start
 * @param {number} end
 * @returns {number} Cut position (equal to `end` when no boundary is found).
 */
function findBoundary(source, start, end) {
  let sentence = -1
  let space = -1
  for (let index = end; index > start; index -= 1) {
    const char = source[index - 1]
    if (char === '\n') return index
    if (sentence < 0 && SENTENCE_END_CHARS.includes(char)) sentence = index
    if (space < 0 && (char === ' ' || char === '\t')) space = index
  }
  if (sentence > start) return sentence
  if (space > start) return space
  return end
}

/**
 * Pull a cut position back so it never splits a `\r\n` pair or a surrogate pair.
 *
 * When the window is too small to hold a whole code point, one full code point is taken even if
 * that exceeds `maxLength` — never splitting a surrogate pair is the stronger guarantee.
 *
 * @param {string} source
 * @param {number} start
 * @param {number} cut
 * @returns {number} Adjusted cut position, strictly greater than `start`.
 */
function adjustCut(source, start, cut) {
  let end = cut
  if (end > start && source[end - 1] === '\r' && source[end] === '\n') end -= 1
  if (end > start && isHighSurrogate(source.charCodeAt(end - 1))) end -= 1
  if (end <= start) {
    end = start + (isHighSurrogate(source.charCodeAt(start)) && start + 1 < source.length ? 2 : 1)
  }
  return end
}

/**
 * @param {number} code
 * @returns {boolean} Whether the code unit is a UTF-16 high surrogate.
 */
function isHighSurrogate(code) {
  return code >= 0xd800 && code <= 0xdbff
}

/**
 * @param {Record<string, unknown>} raw
 * @returns {Record<string, unknown> | null} Nested `msg`/`message` object, when present.
 */
function readInnerMessage(raw) {
  if (isRecord(raw.msg)) return raw.msg
  if (isRecord(raw.message)) return raw.message
  return null
}

/**
 * Read the `item_list` array from the message or its inner envelope.
 *
 * @param {Record<string, unknown>} raw
 * @param {Record<string, unknown> | null} inner
 * @returns {unknown[]}
 */
function readItemList(raw, inner) {
  if (Array.isArray(raw.item_list)) return raw.item_list
  if (inner && Array.isArray(inner.item_list)) return inner.item_list
  return []
}

/**
 * Read the text of one `item_list` entry.
 *
 * @param {unknown} item
 * @returns {string}
 */
function readTextItem(item) {
  if (!isRecord(item)) return ''
  const textItem = isRecord(item.text_item) ? item.text_item : null
  return readString(textItem, 'text') || readString(item, 'text') || readString(item, 'content')
}

/**
 * Read the message text: direct fields first, then `item_list` text items joined by `\n`.
 * 对齐 ZCode weixinProvider.ts:343-351.
 *
 * @param {Record<string, unknown>} raw
 * @param {Record<string, unknown> | null} inner
 * @returns {string}
 */
function readMessageText(raw, inner) {
  const direct = readString(raw, 'text') || readString(raw, 'content') || readString(raw, 'message')
  if (direct) return direct
  const fromItems = readItemList(raw, inner).map(readTextItem).filter(Boolean).join('\n')
  if (fromItems) return fromItems
  return readString(inner, 'text') || readString(inner, 'content')
}

/**
 * Describe each `item_list` entry: the numeric `type` when present, otherwise the media key name.
 *
 * @param {Record<string, unknown>} raw
 * @param {Record<string, unknown> | null} inner
 * @returns {string[]}
 */
function readItemTypes(raw, inner) {
  return readItemList(raw, inner)
    .filter(isRecord)
    .map((item) => {
      const numeric =
        readNumber(item, 'type') ?? readNumber(item, 'item_type') ?? readNumber(item, 'message_type')
      if (numeric !== null) return String(numeric)
      return inferItemKeyName(item) ?? 'unknown'
    })
}

/**
 * @param {Record<string, unknown>} item
 * @returns {string | null} Name of the media/text payload carried by the item.
 */
function inferItemKeyName(item) {
  if (isRecord(item.text_item)) return 'text'
  for (const key of MEDIA_ITEM_KEYS) {
    if (isRecord(item[key])) return key.replace(/_item$/u, '')
  }
  return null
}

/**
 * Read the sender id, following the ZCode fallback chain plus `fromUserId`.
 *
 * @param {Record<string, unknown>} raw
 * @returns {string}
 */
function readFromUserId(raw) {
  const from = isRecord(raw.from) ? raw.from : null
  const sender = isRecord(raw.sender) ? raw.sender : null
  return (
    readString(raw, 'from_user_id') ||
    readString(raw, 'fromUserId') ||
    readString(raw, 'from_user') ||
    readString(raw, 'fromUser') ||
    readString(raw, 'from') ||
    readString(raw, 'user') ||
    readString(raw, 'user_id') ||
    readString(raw, 'userId') ||
    readString(from, 'id') ||
    readString(from, 'wxid') ||
    readString(sender, 'id') ||
    readString(sender, 'wxid')
  )
}

/**
 * Read the conversation id (group chats only).
 *
 * `session_id` is deliberately **not** consulted: it is present on 1:1 messages too and would
 * make every private chat look like a group.
 *
 * @param {Record<string, unknown>} raw
 * @returns {string | undefined}
 */
function readChatId(raw) {
  const value =
    readString(raw, 'room') ||
    readString(raw, 'room_id') ||
    readString(raw, 'roomId') ||
    readString(raw, 'chat') ||
    readString(raw, 'chat_id') ||
    readString(raw, 'chatId') ||
    readString(raw, 'group_id')
  return value || undefined
}

/**
 * Read `context_token` from the message or its inner envelope.
 *
 * @param {Record<string, unknown>} raw
 * @param {Record<string, unknown> | null} inner
 * @returns {string | undefined}
 */
function readContextToken(raw, inner) {
  const value =
    readString(raw, 'context_token') ||
    readString(raw, 'contextToken') ||
    readString(raw, 'context') ||
    readString(inner, 'context_token') ||
    readString(inner, 'contextToken')
  return value || undefined
}

/**
 * Read the provider message id (string or numeric form).
 *
 * @param {Record<string, unknown>} raw
 * @param {Record<string, unknown> | null} inner
 * @returns {string | undefined}
 */
function readMessageId(raw, inner) {
  const asString =
    readString(raw, 'id') ||
    readString(raw, 'msgid') ||
    readString(raw, 'msgId') ||
    readNumberOrString(raw, 'message_id') ||
    readString(inner, 'id') ||
    readString(inner, 'msgid') ||
    readString(inner, 'msgId') ||
    readNumberOrString(inner, 'message_id')
  if (asString) return asString
  const numeric =
    readNumber(raw, 'id') ??
    readNumber(raw, 'msgid') ??
    readNumber(raw, 'msgId') ??
    readNumber(inner, 'id') ??
    readNumber(inner, 'msgid') ??
    readNumber(inner, 'msgId')
  return numeric === null ? undefined : String(numeric)
}

/**
 * Collect attachments from `item_list` media items and from an explicit `attachments` array.
 *
 * @param {Record<string, unknown>} raw
 * @param {Record<string, unknown> | null} inner
 * @returns {object[]}
 */
function readAttachments(raw, inner) {
  const fromItems = readItemList(raw, inner)
    .map((item, index) => readAttachmentItem(item, index))
    .filter((attachment) => attachment !== null)
  const direct = Array.isArray(raw.attachments)
    ? raw.attachments
    : inner && Array.isArray(inner.attachments)
      ? inner.attachments
      : []
  const fromDirect = direct
    .map((item, index) => readDirectAttachment(item, index))
    .filter((attachment) => attachment !== null)
  return [...fromItems, ...fromDirect]
}

/**
 * Normalize one media `item_list` entry.
 *
 * Nested `media` payloads (`image_item.media.full_url`, `file_item.media.aes_key`, …) are merged
 * over their wrapper. Text items are not attachments. `voice_item` is accepted in addition to the
 * contract's list, because item type 3 uses it on the wire.
 * 对齐 ZCode weixinProvider.ts:203-277.
 *
 * @param {unknown} item
 * @param {number} index Position in `item_list` (used for fallback ids/filenames).
 * @returns {object | null}
 */
function readAttachmentItem(item, index) {
  if (!isRecord(item)) return null
  if (readTextItem(item)) return null

  let media = null
  for (const key of MEDIA_ITEM_KEYS) {
    if (isRecord(item[key])) {
      media = item[key]
      break
    }
  }
  const base = media ?? item
  const nested = isRecord(base.media) ? base.media : null
  const source = nested ? { ...base, ...nested } : base

  const id = firstNumberOrString(source, ['file_id', 'fileId', 'media_id', 'mediaId', 'id', 'encrypt_query_param', 'encryptQueryParam', 'media', 'md5'])
  const downloadUrl = firstString(source, ['url', 'download_url', 'downloadUrl', 'full_url', 'fullUrl'])
  const aesKey = firstString(source, ['aes_key', 'aesKey', 'aeskey'])
  if (!id && !downloadUrl) return null

  const kind = inferAttachmentKind({ ...item, ...source })
  const filename = firstString(source, ['filename', 'file_name', 'name']) || defaultFilename(kind, index)
  const mimeType =
    firstString(source, ['mime_type', 'mimeType']) ||
    guessMimeFromFilename(filename) ||
    defaultMimeType(kind)
  const sizeBytes = firstNumber(source, ['size', 'sizeBytes', 'file_size', 'len', 'mid_size'])

  return {
    id: id || downloadUrl || `wechat-${index + 1}`,
    kind,
    filename,
    mimeType,
    ...(downloadUrl ? { downloadUrl } : {}),
    ...(aesKey ? { aesKey } : {}),
    ...(sizeBytes !== null ? { sizeBytes } : {}),
  }
}

/**
 * Normalize an entry of an explicit `attachments` array (already in bridge shape).
 *
 * @param {unknown} item
 * @param {number} index
 * @returns {object | null}
 */
function readDirectAttachment(item, index) {
  if (!isRecord(item)) return null
  const kind = readString(item, 'kind')
  if (kind !== 'image' && kind !== 'audio' && kind !== 'video' && kind !== 'file') return null
  const id = readString(item, 'id') || readString(item, 'providerFileId') || `wechat-${index + 1}`
  const filename = readString(item, 'filename') || `${id}.${kind}`
  const mimeType =
    readString(item, 'mimeType') ||
    readString(item, 'mime_type') ||
    guessMimeFromFilename(filename) ||
    defaultMimeType(kind)
  const sizeBytes = readNumber(item, 'sizeBytes') ?? readNumber(item, 'size')
  const downloadUrl = readString(item, 'downloadUrl') || readString(item, 'download_url')
  const providerMetadata = isRecord(item.providerMetadata) ? item.providerMetadata : null
  const aesKey =
    readString(item, 'aesKey') ||
    readString(item, 'aes_key') ||
    readString(providerMetadata, 'weixinAesKey')
  return {
    id,
    kind,
    filename,
    mimeType,
    ...(downloadUrl ? { downloadUrl } : {}),
    ...(aesKey ? { aesKey } : {}),
    ...(sizeBytes !== null ? { sizeBytes } : {}),
  }
}

/**
 * Classify an attachment.
 *
 * `image_item` wins immediately; otherwise the explicit kind / MIME / filename is inspected, and
 * finally the media key name is used. 对齐 ZCode weixinProvider.ts:183-201（扩展 voice/audio）。
 *
 * @param {Record<string, unknown>} item
 * @returns {'image'|'audio'|'video'|'file'}
 */
function inferAttachmentKind(item) {
  if (isRecord(item.image_item)) return 'image'
  const explicit =
    readString(item, 'kind') ||
    readString(item, 'media_type') ||
    readString(item, 'mediaType') ||
    readString(item, 'type_name')
  const mimeType = readString(item, 'mime_type') || readString(item, 'mimeType')
  const filename = readString(item, 'filename') || readString(item, 'file_name') || readString(item, 'name')
  const normalized = `${explicit} ${mimeType} ${filename}`.toLowerCase()
  if (
    normalized.includes('image') ||
    normalized.includes('photo') ||
    normalized.includes('picture') ||
    /\.(svg|png|jpe?g|gif|webp|heic|bmp)$/iu.test(filename)
  ) {
    return 'image'
  }
  if (normalized.includes('audio') || normalized.includes('voice')) return 'audio'
  if (normalized.includes('video')) return 'video'
  if (isRecord(item.voice_item) || isRecord(item.audio_item)) return 'audio'
  if (isRecord(item.video_item)) return 'video'
  return 'file'
}

/**
 * @param {'image'|'audio'|'video'|'file'} kind
 * @param {number} index
 * @returns {string}
 */
function defaultFilename(kind, index) {
  return kind === 'image' ? `wechat-image-${index + 1}.jpg` : `wechat-attachment-${index + 1}`
}

/**
 * @param {'image'|'audio'|'video'|'file'} kind
 * @returns {string}
 */
function defaultMimeType(kind) {
  if (kind === 'image') return 'image/jpeg'
  if (kind === 'audio') return 'audio/mpeg'
  if (kind === 'video') return 'video/mp4'
  return 'application/octet-stream'
}

/**
 * @param {Record<string, unknown> | null | undefined} record
 * @param {string[]} keys
 * @returns {string}
 */
function firstString(record, keys) {
  for (const key of keys) {
    const value = readString(record, key)
    if (value) return value
  }
  return ''
}

/**
 * @param {Record<string, unknown> | null | undefined} record
 * @param {string[]} keys
 * @returns {string}
 */
function firstNumberOrString(record, keys) {
  for (const key of keys) {
    const value = readNumberOrString(record, key)
    if (value) return value
  }
  return ''
}

/**
 * @param {Record<string, unknown> | null | undefined} record
 * @param {string[]} keys
 * @returns {number | null}
 */
function firstNumber(record, keys) {
  for (const key of keys) {
    const value = readNumberOrString(record, key)
    if (value !== '') {
      const parsed = Number(value)
      if (Number.isFinite(parsed)) return parsed
    }
  }
  return null
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null
}

/**
 * @param {Record<string, unknown> | null | undefined} record
 * @param {string} key
 * @returns {string}
 */
function readString(record, key) {
  const value = record?.[key]
  return typeof value === 'string' ? value : ''
}

/**
 * @param {Record<string, unknown> | null | undefined} record
 * @param {string} key
 * @returns {number | null}
 */
function readNumber(record, key) {
  const value = record?.[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * @param {Record<string, unknown> | null | undefined} record
 * @param {string} key
 * @returns {string}
 */
function readNumberOrString(record, key) {
  const value = record?.[key]
  if (typeof value === 'string') return value
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : ''
}
