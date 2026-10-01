/**
 * iLink CDN media helpers (AES-128-ECB + PKCS7).
 *
 * Protocol truth source (read-only reference):
 *   `zai-org/ZCode` `packages/services/src/bots/providers/packages/services/src/bots/providers/weixinProvider.ts:62-90`
 *   the eight independent open-source iLink clients §1/§2/§8 (CDN base URL + key encodings).
 * Frozen contract: `docs/INTERFACES.md` §1 + §3.4.
 *
 * @module wechat-feishu-linker/ilink/media
 */
import { createDecipheriv } from 'node:crypto'

/**
 * Media CDN origin — deliberately **not** the bot API origin.
 * 8/8 independent implementations agree on this value.
 * 对齐 docs/INTERFACES.md §1 + weclaw messaging/cdn.go:21.
 */
export const ILINK_CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c'

/** Cipher used by the iLink CDN. 对齐 ZCode weixinProvider.ts:18 */
export const ILINK_CDN_AES_ALGORITHM = 'aes-128-ecb'

/** MIME lookup used by {@link guessMimeFromFilename}. */
const MIME_BY_EXTENSION = {
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  jpe: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  heic: 'image/heic',
  heif: 'image/heif',
  bmp: 'image/bmp',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  ico: 'image/x-icon',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/opus',
  amr: 'audio/amr',
  silk: 'audio/silk',
  flac: 'audio/flac',
  mp4: 'video/mp4',
  m4v: 'video/x-m4v',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  avi: 'video/x-msvideo',
  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
  xml: 'application/xml',
  html: 'text/html',
  htm: 'text/html',
  zip: 'application/zip',
  gz: 'application/gzip',
  tar: 'application/x-tar',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
}

/**
 * Parse a CDN `aes_key` into a raw 16-byte key.
 *
 * Three encodings are seen in the wild:
 *   1. raw 32-char hex text            → hex decode (16 bytes)
 *   2. base64 of the raw 16 key bytes  → decode to 16 bytes
 *   3. base64 of the 32-char hex text  → decode to 32 ASCII chars, then hex decode
 * 对齐 ZCode weixinProvider.ts:62-80 + research §1 (`messaging/cdn.go:104-118`).
 *
 * @param {unknown} value `aes_key` / `aeskey` field.
 * @returns {Buffer | null} 16-byte key, or `null` when the value is not a usable key.
 */
export function parseAesKey(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed === '') return null
  if (/^[a-f0-9]{32}$/i.test(trimmed)) return Buffer.from(trimmed, 'hex')

  const decoded = Buffer.from(trimmed, 'base64')
  if (decoded.length === 16) return decoded
  const decodedText = decoded.toString('utf8').trim()
  if (/^[a-f0-9]{32}$/i.test(decodedText)) return Buffer.from(decodedText, 'hex')
  return null
}

/**
 * Decrypt CDN media bytes (AES-128-ECB + PKCS7).
 *
 * The input is left untouched; a fresh `Uint8Array` is returned.
 *
 * @param {Uint8Array} data Ciphertext downloaded from the CDN.
 * @param {string} aesKey `aes_key` value from the inbound attachment item.
 * @returns {Uint8Array} Decrypted plaintext.
 * @throws {Error} When `aesKey` is invalid or the ciphertext/padding is corrupt.
 */
export function decryptCdnMedia(data, aesKey) {
  const key = parseAesKey(aesKey)
  if (!key) throw new Error('iLink CDN attachment AES key is invalid.')
  const input = data instanceof Uint8Array ? data : new Uint8Array(data ?? [])
  // 微信 iLink CDN 返回 AES-128-ECB + PKCS7 的密文；直接保存会得到不可识别的 data 文件。
  const decipher = createDecipheriv(ILINK_CDN_AES_ALGORITHM, key, null)
  const plain = Buffer.concat([decipher.update(input), decipher.final()])
  return new Uint8Array(plain)
}

/**
 * Guess a MIME type from a filename extension.
 *
 * Returns `''` for unknown extensions (callers apply their own default), matching the
 * upstream provider behavior while covering the common iLink media types.
 * 对齐 ZCode weixinProvider.ts:279-296（扩展）。
 *
 * @param {unknown} name Filename or path (query string / fragment is ignored).
 * @returns {string} MIME type, or `''` when it cannot be guessed.
 */
export function guessMimeFromFilename(name) {
  if (typeof name !== 'string') return ''
  const cleaned = name.trim().split(/[?#]/)[0]
  const match = /\.([a-z0-9]+)$/i.exec(cleaned)
  if (!match) return ''
  return MIME_BY_EXTENSION[match[1].toLowerCase()] ?? ''
}
