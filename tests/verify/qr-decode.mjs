#!/usr/bin/env node
/**
 * Independent QR verification (verifier-owned, NOT a test file).
 *
 * Encodes payloads with the plugin's own encoder (`src/web/qrcode.js`) and
 * decodes the resulting matrix with **jsQR** — an unrelated third-party
 * decoder — then compares the decoded text with the input byte-for-byte.
 *
 * jsQR is deliberately NOT a dependency of this package: point the script at a
 * throwaway install instead (npm i jsqr into %TEMP%), e.g.
 *
 *   $env:VERIFY_JSQR_DIR = "$env:TEMP\ilink-verify-jsqr\node_modules\jsqr"
 *   node tests/verify/qr-decode.mjs
 *
 * Exit code 0 = every payload round-tripped; 1 = a mismatch (details printed).
 */
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

import { byteCapacity, createQrMatrix, MAX_VERSION, pickVersion, qrSvg } from '../../src/web/qrcode.js'

const require = createRequire(import.meta.url)
const jsqrDir = process.env.VERIFY_JSQR_DIR ?? path.join(process.env.TEMP ?? '/tmp', 'ilink-verify-jsqr', 'node_modules', 'jsqr')

if (!existsSync(jsqrDir)) {
  console.error(`[fail] jsQR not found at ${jsqrDir}; set VERIFY_JSQR_DIR or: npm i jsqr`)
  process.exit(2)
}
const jsQR = require(jsqrDir)
const decode = typeof jsQR === 'function' ? jsQR : jsQR.default
if (typeof decode !== 'function') {
  console.error('[fail] jsQR module did not export a decoder function')
  process.exit(2)
}

/**
 * Rasterize a module matrix into the RGBA buffer jsQR consumes.
 *
 * @param {boolean[][]} modules - the matrix.
 * @param {number} scale - pixels per module.
 * @param {number} quiet - quiet zone in modules.
 * @returns {{ data: Uint8ClampedArray, width: number, height: number }} the image.
 */
function rasterize(modules, scale = 8, quiet = 4) {
  const size = modules.length
  const width = (size + quiet * 2) * scale
  const data = new Uint8ClampedArray(width * width * 4).fill(255)
  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) {
      if (!modules[row][col]) continue
      for (let dy = 0; dy < scale; dy += 1) {
        for (let dx = 0; dx < scale; dx += 1) {
          const x = (col + quiet) * scale + dx
          const y = (row + quiet) * scale + dy
          const offset = (y * width + x) * 4
          data[offset] = 0
          data[offset + 1] = 0
          data[offset + 2] = 0
          data[offset + 3] = 255
        }
      }
    }
  }
  return { data, width, height: width }
}

const REAL_ILINK_URL = 'https://liteapp.weixin.qq.com/q/7GiQu1?qrcode=23e78cc308b9fb8b779d8cf4aa024a8e&bot_type=3'

const payloads = [
  { label: 'v1 single byte', text: 'A' },
  { label: 'real iLink qrcode_img_content URL', text: REAL_ILINK_URL },
  { label: '100 ASCII', text: 'x'.repeat(100) },
  { label: '200 ASCII', text: 'wechat-feishu-linker '.repeat(12).slice(0, 200) },
  { label: 'UTF-8 Chinese', text: '微信 ClawBot 绑定测试：请用手机微信扫描此二维码完成绑定。'.repeat(2) },
  { label: 'UTF-8 emoji (4-byte sequences)', text: '😀🎉🚀'.repeat(10) },
  { label: 'exactly v10-L capacity', text: 'z'.repeat(byteCapacity(MAX_VERSION)) },
]

let failures = 0
let checked = 0

console.log(`jsQR from ${jsqrDir}`)
console.log(`MAX_VERSION=${MAX_VERSION} v10-L capacity=${byteCapacity(MAX_VERSION)} bytes\n`)

for (const { label, text } of payloads) {
  let matrix
  try {
    matrix = createQrMatrix(text)
  } catch (error) {
    failures += 1
    console.log(`✖ ${label}: createQrMatrix threw ${error.name}: ${error.message}`)
    continue
  }
  const image = rasterize(matrix.modules)
  const result = decode(image.data, image.width, image.height)
  checked += 1

  if (!result || typeof result.data !== 'string') {
    failures += 1
    console.log(`✖ ${label}: jsQR could not decode v${matrix.version} (${matrix.size}×${matrix.size}, mask ${matrix.mask})`)
    continue
  }
  const expected = Buffer.from(text, 'utf8')
  const actual = Buffer.from(result.data, 'utf8')
  const identical = expected.equals(actual)
  if (!identical) failures += 1
  console.log(
    `${identical ? '✔' : '✖'} ${label}: v${matrix.version} ${matrix.size}×${matrix.size} mask=${matrix.mask} ` +
      `bytes=${expected.length} decoded=${actual.length} ${identical ? 'byte-identical' : 'MISMATCH'}`,
  )
  if (!identical) {
    console.log(`    expected: ${JSON.stringify(text.slice(0, 60))}`)
    console.log(`    decoded : ${JSON.stringify(result.data.slice(0, 60))}`)
  }
  console.log(`    matrix-sha256 ${(await import('node:crypto')).createHash('sha256').update(matrix.modules.map((r) => r.map((v) => (v ? '1' : '0')).join('')).join('|')).digest('hex')}`)
}

// --- boundaries -----------------------------------------------------------------
console.log('\n-- boundaries --')
for (const [label, fn, expectedName] of [
  ['empty string', () => createQrMatrix(''), 'TypeError'],
  ['non-string', () => createQrMatrix(42), 'TypeError'],
  [`${byteCapacity(MAX_VERSION) + 1} bytes (over v10)`, () => createQrMatrix('z'.repeat(byteCapacity(MAX_VERSION) + 1)), 'RangeError'],
  ['multi-byte payload that only overflows in BYTES (not chars)', () => createQrMatrix('微'.repeat(100)), 'RangeError'],
]) {
  try {
    fn()
    failures += 1
    console.log(`✖ ${label}: expected ${expectedName}, but it succeeded`)
  } catch (error) {
    const ok = error.name === expectedName
    if (!ok) failures += 1
    console.log(`${ok ? '✔' : '✖'} ${label}: ${error.name} (expected ${expectedName}) — ${error.message}`)
  }
}

// pickVersion must agree with the encoded version for every payload size.
const mismatches = []
for (let bytes = 1; bytes <= byteCapacity(MAX_VERSION); bytes += 1) {
  const version = pickVersion(bytes)
  if (byteCapacity(version) < bytes || (version > 1 && byteCapacity(version - 1) >= bytes)) {
    mismatches.push(`${bytes}B -> v${version}`)
  }
}
console.log(`${mismatches.length === 0 ? '✔' : '✖'} pickVersion monotonic for 1..${byteCapacity(MAX_VERSION)} bytes${mismatches.length ? `: ${mismatches.slice(0, 5).join(', ')}` : ''}`)
if (mismatches.length > 0) failures += 1

// The SVG must carry a white quiet zone and stay XML-safe.
const svg = qrSvg('a&b<c>"d\'e', { scale: 3, quietZone: 4 })
const svgOk = svg.includes('<rect width=') && svg.includes('fill="#ffffff"') && !/[<]a&b/.test(svg)
console.log(`${svgOk ? '✔' : '✖'} qrSvg escapes XML and keeps an explicit white background`)
if (!svgOk) failures += 1

console.log(`\n${failures === 0 ? '[done] all QR checks passed' : `[done] ${failures} failure(s)`} (${checked}/${payloads.length} payloads decoded)`)
process.exitCode = failures === 0 ? 0 : 1
