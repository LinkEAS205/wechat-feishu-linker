/**
 * Verifier-owned QR regression net (round 2).
 *
 * The encoder in `src/web/qrcode.js` is hand-written, so it needs a check that
 * does not come from the same author. The matrices pinned here were produced by
 * this encoder and then **decoded byte-for-byte by jsQR** (an unrelated
 * third-party decoder) via `tests/verify/qr-decode.mjs`; the hashes below freeze
 * that independently-confirmed output.
 *
 * If the encoder changes intentionally, re-run:
 *   $env:VERIFY_JSQR_DIR="$env:TEMP\ilink-verify-jsqr\node_modules\jsqr"
 *   node tests/verify/qr-decode.mjs
 * and update the vectors from its printed `matrix-sha256` lines.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

import { byteCapacity, createQrMatrix, MAX_VERSION, pickVersion, qrSvg } from '../../src/web/qrcode.js'

/** Stable digest of a module matrix (row-major, `1`/`0`, rows joined by `|`). */
function matrixDigest(modules) {
  return createHash('sha256')
    .update(modules.map((row) => row.map((value) => (value ? '1' : '0')).join('')).join('|'))
    .digest('hex')
}

const REAL_ILINK_URL = 'https://liteapp.weixin.qq.com/q/7GiQu1?qrcode=23e78cc308b9fb8b779d8cf4aa024a8e&bot_type=3'

/** Vectors confirmed by an independent jsQR decode (see the module doc). */
const VECTORS = [
  { label: 'v1 single byte', text: 'A', version: 1, size: 21, mask: 0, digest: '1b978666743e500302a9c7aa22ea1ba068595779067c6baa62b0db0df45d912e' },
  { label: 'real iLink qrcode_img_content URL', text: REAL_ILINK_URL, version: 5, size: 37, mask: 2, digest: 'b6ce8f7604b591397d905ce0ef6c5ba07e735b247f12972cf0cac5e12273164e' },
  { label: '100 ASCII', text: 'x'.repeat(100), version: 5, size: 37, mask: 0, digest: 'e6dec439f559dcfd149f552a123969bf0bbfb8a3eb33c3da8ffaee8816c4f203' },
  // Deliberately not built from the package name: this pin is about the encoder,
  // and a rename must not be able to move it. It did once — the literal used to
  // be the package name, so renaming the package silently invalidated the pin.
  { label: '200 ASCII', text: 'qr-fixture-ascii-0000 '.repeat(12).slice(0, 200), version: 9, size: 53, mask: 3, digest: 'c0a5d6e7fae18a4b50ed62e65b8764e9c4a40ef81e3e15e8f4c49353ab63b272' },
  { label: 'UTF-8 Chinese', text: '微信 ClawBot 绑定测试：请用手机微信扫描此二维码完成绑定。'.repeat(2), version: 8, size: 49, mask: 4, digest: '91159cbd1796d02695e15b502768642a449eb4b2051c44cf1ba397798de66447' },
  { label: 'UTF-8 emoji (4-byte sequences)', text: '😀🎉🚀'.repeat(10), version: 6, size: 41, mask: 3, digest: '7614db59fc0042d0434a6919a455bde61d0b1ee170fef5a1939ad1a843ee8d16' },
  { label: 'exactly v10-L capacity', text: 'z'.repeat(byteCapacity(MAX_VERSION)), version: 10, size: 57, mask: 5, digest: '9ee8ef29f310b146c7f55add4fd00a7584ac9e8dc49fe63f62d2fc3172a13a63' },
]

test('qr: jsQR-confirmed matrices stay byte-identical', () => {
  for (const vector of VECTORS) {
    const matrix = createQrMatrix(vector.text)
    assert.equal(matrix.version, vector.version, `${vector.label}: version`)
    assert.equal(matrix.size, vector.size, `${vector.label}: size`)
    assert.equal(matrix.mask, vector.mask, `${vector.label}: mask`)
    assert.equal(matrix.modules.length, matrix.size, `${vector.label}: rows`)
    for (const row of matrix.modules) assert.equal(row.length, matrix.size, `${vector.label}: square matrix`)
    assert.equal(matrixDigest(matrix.modules), vector.digest, `${vector.label}: matrix changed`)
  }
})

test('qr: the version covers at least 5 distinct versions including the real iLink URL', () => {
  const versions = new Set(VECTORS.map((vector) => vector.version))
  assert.ok(versions.size >= 5, `expected ≥5 distinct versions, got ${[...versions].join(', ')}`)
  assert.ok(VECTORS.some((vector) => vector.text === REAL_ILINK_URL), 'the live iLink payload must be one of the vectors')
})

test('qr: capacity boundaries fail loudly instead of emitting a broken symbol', () => {
  assert.equal(byteCapacity(MAX_VERSION), 271)
  assert.throws(() => createQrMatrix(''), TypeError)
  assert.throws(() => createQrMatrix(42), TypeError)
  assert.throws(() => createQrMatrix(null), TypeError)
  assert.throws(() => createQrMatrix('z'.repeat(272)), RangeError)
  // Byte-length, not character-length: 100 CJK chars = 300 bytes.
  assert.throws(() => createQrMatrix('微'.repeat(100)), RangeError)
  // The exact capacity still encodes.
  assert.equal(createQrMatrix('z'.repeat(271)).version, 10)
})

test('qr: pickVersion is monotonic and never under-sizes the payload', () => {
  let previous = 1
  for (let bytes = 1; bytes <= byteCapacity(MAX_VERSION); bytes += 1) {
    const version = pickVersion(bytes)
    assert.ok(version >= previous, `pickVersion(${bytes}) went backwards`)
    assert.ok(byteCapacity(version) >= bytes, `pickVersion(${bytes}) = v${version} is too small`)
    if (version > 1) assert.ok(byteCapacity(version - 1) < bytes, `pickVersion(${bytes}) = v${version} is not minimal`)
    previous = version
  }
  assert.throws(() => pickVersion(272), RangeError)
})

test('qr: the SVG is self-contained, white-backed and XML-safe', () => {
  const svg = qrSvg('A', { scale: 3, quietZone: 4, title: 'a&b<c>"d\'e' })
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/)
  assert.match(svg, /fill="#ffffff"/)
  assert.match(svg, /shape-rendering="crispEdges"/)
  assert.match(svg, /data-qr-version="\d+"/)
  // The title is the only payload-derived text in the document, and it must be
  // escaped — the QR payload itself is encoded as modules, never as markup.
  assert.equal(svg.includes('a&b<c>'), false, 'the title was injected unescaped')
  assert.match(svg, /a&amp;b&lt;c&gt;/u)
  assert.match(svg, /aria-label="a&amp;b&lt;c&gt;&quot;d&apos;e"/u)

  const sized = qrSvg('A', { scale: 4, quietZone: 4 })
  const extent = (21 + 8) * 4
  assert.match(sized, new RegExp(`width="${extent}" height="${extent}"`))
  assert.match(sized, new RegExp(`viewBox="0 0 ${extent} ${extent}"`))
})
