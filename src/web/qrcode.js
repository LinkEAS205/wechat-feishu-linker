/**
 * Dependency-free QR Code encoder — byte mode, error-correction level L,
 * versions 1–10, rendered as SVG.
 *
 * **Why this exists.** The iLink login payload's `qrcode_img_content` is an
 * HTML lite-app page URL (`https://liteapp.weixin.qq.com/q/...`), *not* an
 * image: fetched live on 2026-09-30 it answered `200 text/html`, so an
 * `<img src={qrUrl}>` renders a broken image and the user can never scan.
 * The QR therefore has to be rendered here. The plugin ships **no third-party
 * runtime dependency** (docs/INTERFACES.md §4.2), so the encoder is written
 * from ISO/IEC 18004 instead of pulling in a library.
 *
 * **Mask selection.** The penalty score is computed on the symbol with the
 * format/version modules blanked, which is the semantics of the canonical
 * `qrcode-generator` (MIT) implementation. Matching those semantics is what
 * lets `tests/web.test.mjs` pin the emitted matrix against fixtures generated
 * by that independent implementation. Any of the eight masks produces a
 * decodable symbol; this choice is about verifiability, not scannability.
 *
 * @module wechat-feishu-linker/web/qrcode
 */

/** Highest version this encoder supports (v10-L holds 271 bytes). */
export const MAX_VERSION = 10

/** Error-correction level L, encoded as its two-bit indicator. */
const EC_LEVEL_L_BITS = 0b01

/** Total codewords per version (ISO/IEC 18004 table 1). */
const TOTAL_CODEWORDS = [0, 26, 44, 70, 100, 134, 172, 196, 242, 292, 346]

/**
 * Error-correction level L block structure per version:
 * `[ecCodewordsPerBlock, [[blockCount, dataCodewordsPerBlock], ...]]`.
 */
const EC_L = [
  null,
  [7, [[1, 19]]],
  [10, [[1, 34]]],
  [15, [[1, 55]]],
  [20, [[1, 80]]],
  [26, [[1, 108]]],
  [18, [[2, 68]]],
  [20, [[2, 78]]],
  [24, [[2, 97]]],
  [30, [[2, 116]]],
  [18, [[2, 68], [2, 69]]],
]

/** Alignment-pattern centre coordinates per version. */
const ALIGNMENT = [
  null,
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
]

/** 18-bit version information, required from version 7 up. */
const VERSION_BITS = [null, null, null, null, null, null, null, 0x07c94, 0x085bc, 0x09a99, 0x0a4d3]

/** Remainder bits appended after the interleaved codewords. */
const REMAINDER_BITS = [0, 0, 7, 7, 7, 7, 7, 0, 0, 0, 0]

/** Mask evaluation functions, indexed by mask pattern. */
const MASK_FUNCTIONS = [
  (row, col) => (row + col) % 2 === 0,
  (row) => row % 2 === 0,
  (_row, col) => col % 3 === 0,
  (row, col) => (row + col) % 3 === 0,
  (row, col) => (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0,
  (row, col) => ((row * col) % 2) + ((row * col) % 3) === 0,
  (row, col) => (((row * col) % 2) + ((row * col) % 3)) % 2 === 0,
  (row, col) => (((row + col) % 2) + ((row * col) % 3)) % 2 === 0,
]

// ────────────────────────────── GF(256) ──────────────────────────────

const GF_EXP = new Uint8Array(512)
const GF_LOG = new Uint8Array(256)

for (let i = 0, x = 1; i < 255; i += 1) {
  GF_EXP[i] = x
  GF_LOG[x] = i
  x <<= 1
  if (x & 0x100) x ^= 0x11d
}
for (let i = 255; i < 512; i += 1) GF_EXP[i] = GF_EXP[i - 255]

/**
 * Multiply two GF(256) elements.
 *
 * @param {number} a - first operand.
 * @param {number} b - second operand.
 * @returns {number} the product.
 */
function gfMul(a, b) {
  if (a === 0 || b === 0) return 0
  return GF_EXP[GF_LOG[a] + GF_LOG[b]]
}

/**
 * Build the Reed-Solomon generator polynomial of the given degree.
 *
 * @param {number} degree - number of error-correction codewords.
 * @returns {Uint8Array} coefficients, highest degree first (`gen[0] === 1`).
 */
function generatorPolynomial(degree) {
  let poly = new Uint8Array([1])
  for (let i = 0; i < degree; i += 1) {
    const next = new Uint8Array(poly.length + 1)
    for (let j = 0; j < poly.length; j += 1) {
      next[j] ^= poly[j]
      next[j + 1] ^= gfMul(poly[j], GF_EXP[i])
    }
    poly = next
  }
  return poly
}

/**
 * Compute the Reed-Solomon remainder of one block.
 *
 * @param {Uint8Array} data - data codewords.
 * @param {Uint8Array} generator - generator polynomial from
 * {@link generatorPolynomial}.
 * @returns {Uint8Array} `generator.length - 1` error-correction codewords.
 */
function reedSolomon(data, generator) {
  const degree = generator.length - 1
  const remainder = new Uint8Array(degree)
  for (const byte of data) {
    const factor = byte ^ remainder[0]
    remainder.copyWithin(0, 1)
    remainder[degree - 1] = 0
    if (factor !== 0) {
      for (let i = 0; i < degree; i += 1) remainder[i] ^= gfMul(generator[i + 1], factor)
    }
  }
  return remainder
}

// ────────────────────────── bit-stream helpers ──────────────────────────

/**
 * @param {number} version - QR version.
 * @returns {{ ec: number, blocks: number, data: number }} block layout.
 */
function layoutOf(version) {
  const [ec, groups] = EC_L[version]
  let blocks = 0
  let data = 0
  for (const [count, perBlock] of groups) {
    blocks += count
    data += count * perBlock
  }
  return { ec, blocks, data }
}

/**
 * @param {number} version - QR version.
 * @returns {number} bytes representable in byte mode at EC level L.
 */
export function byteCapacity(version) {
  const { data } = layoutOf(version)
  const lengthBits = version < 10 ? 8 : 16
  return Math.floor((data * 8 - 4 - lengthBits) / 8)
}

/**
 * @param {number} byteLength - payload size in bytes.
 * @returns {number} the smallest supported version that fits.
 * @throws {RangeError} when the payload exceeds version {@link MAX_VERSION}.
 */
export function pickVersion(byteLength) {
  for (let version = 1; version <= MAX_VERSION; version += 1) {
    if (byteCapacity(version) >= byteLength) return version
  }
  throw new RangeError(
    `qr: payload of ${byteLength} bytes exceeds the version-${MAX_VERSION} capacity of ${byteCapacity(MAX_VERSION)} bytes`,
  )
}

/**
 * Encode bytes into the padded data-codeword stream.
 *
 * @param {Uint8Array} bytes - payload.
 * @param {number} version - QR version.
 * @returns {Uint8Array} `layoutOf(version).data` codewords.
 */
function encodeDataCodewords(bytes, version) {
  const { data } = layoutOf(version)
  const capacityBits = data * 8
  const bits = []
  const push = (value, length) => {
    for (let i = length - 1; i >= 0; i -= 1) bits.push((value >>> i) & 1)
  }
  push(0b0100, 4)
  push(bytes.length, version < 10 ? 8 : 16)
  for (const byte of bytes) push(byte, 8)
  push(0, Math.min(4, capacityBits - bits.length))
  while (bits.length % 8 !== 0) bits.push(0)
  const out = new Uint8Array(data)
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0
    for (let j = 0; j < 8; j += 1) byte = (byte << 1) | bits[i + j]
    out[i / 8] = byte
  }
  const pad = [0xec, 0x11]
  for (let i = bits.length / 8, k = 0; i < data; i += 1, k += 1) out[i] = pad[k % 2]
  return out
}

/**
 * Build the interleaved codeword stream (data blocks first, then EC blocks).
 *
 * @param {Uint8Array} bytes - payload.
 * @param {number} version - QR version.
 * @returns {Uint8Array} interleaved codewords.
 */
function buildCodewords(bytes, version) {
  const { ec, data } = layoutOf(version)
  const [, groups] = EC_L[version]
  const dataCodewords = encodeDataCodewords(bytes, version)
  const generator = generatorPolynomial(ec)
  const blocks = []
  let offset = 0
  for (const [count, perBlock] of groups) {
    for (let i = 0; i < count; i += 1) {
      const chunk = dataCodewords.slice(offset, offset + perBlock)
      offset += perBlock
      blocks.push({ data: chunk, ec: reedSolomon(chunk, generator) })
    }
  }
  const out = new Uint8Array(data + blocks.length * ec)
  let at = 0
  const maxData = Math.max(...blocks.map((block) => block.data.length))
  for (let i = 0; i < maxData; i += 1) {
    for (const block of blocks) {
      if (i < block.data.length) out[at++] = block.data[i]
    }
  }
  for (let i = 0; i < ec; i += 1) {
    for (const block of blocks) out[at++] = block.ec[i]
  }
  return out
}

// ─────────────────────────── matrix building ───────────────────────────

/**
 * @param {number} data - 5-bit format payload (EC level + mask).
 * @returns {number} the masked 15-bit format information.
 */
function bchTypeInfo(data) {
  let value = data << 10
  while (bitLength(value) - bitLength(0x537) >= 0) {
    value ^= 0x537 << (bitLength(value) - bitLength(0x537))
  }
  return ((data << 10) | value) ^ 0x5412
}

/**
 * @param {number} data - 6-bit version number.
 * @returns {number} the 18-bit version information.
 */
function bchTypeNumber(data) {
  let value = data << 12
  while (bitLength(value) - bitLength(0x1f25) >= 0) {
    value ^= 0x1f25 << (bitLength(value) - bitLength(0x1f25))
  }
  return (data << 12) | value
}

/**
 * @param {number} value - non-negative integer.
 * @returns {number} the number of significant bits.
 */
function bitLength(value) {
  let length = 0
  let remaining = value
  while (remaining !== 0) {
    length += 1
    remaining >>>= 1
  }
  return length
}

/**
 * Create an empty module matrix with a parallel "is a function module" mask.
 *
 * @param {number} size - modules per side.
 * @returns {{ modules: Array<Array<boolean|null>>, reserved: boolean[][] }} the
 * matrix (null = still free for data) and its reservation map.
 */
function createBlankMatrix(size) {
  return {
    modules: Array.from({ length: size }, () => new Array(size).fill(null)),
    reserved: Array.from({ length: size }, () => new Array(size).fill(false)),
  }
}

/**
 * Draw one finder pattern plus its separator.
 *
 * @param {object} target - blank matrix from {@link createBlankMatrix}.
 * @param {number} row - top-left row of the 7×7 finder.
 * @param {number} col - top-left column of the 7×7 finder.
 * @returns {void}
 */
function placeFinder({ modules, reserved }, row, col) {
  const size = modules.length
  for (let r = -1; r <= 7; r += 1) {
    for (let c = -1; c <= 7; c += 1) {
      const y = row + r
      const x = col + c
      if (y < 0 || x < 0 || y >= size || x >= size) continue
      const inside = r >= 0 && r <= 6 && c >= 0 && c <= 6
      const dark = inside && (r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4))
      modules[y][x] = dark
      reserved[y][x] = true
    }
  }
}

/**
 * Draw one 5×5 alignment pattern.
 *
 * @param {object} target - matrix under construction.
 * @param {number} row - centre row.
 * @param {number} col - centre column.
 * @returns {void}
 */
function placeAlignment({ modules, reserved }, row, col) {
  for (let r = -2; r <= 2; r += 1) {
    for (let c = -2; c <= 2; c += 1) {
      modules[row + r][col + c] = Math.max(Math.abs(r), Math.abs(c)) !== 1
      reserved[row + r][col + c] = true
    }
  }
}

/**
 * Reserve (and later write) the two format-information copies.
 *
 * @param {object} target - matrix under construction.
 * @returns {Array<[number, number]>} the module positions, in bit order.
 */
function formatPositions({ reserved }) {
  const size = reserved.length
  const positions = []
  for (let i = 0; i < 15; i += 1) {
    if (i < 6) positions.push([i, 8])
    else if (i < 8) positions.push([i + 1, 8])
    else positions.push([size - 15 + i, 8])
  }
  for (let i = 0; i < 15; i += 1) {
    if (i < 8) positions.push([8, size - 1 - i])
    else if (i === 8) positions.push([8, 7])
    else positions.push([8, 14 - i])
  }
  for (const [row, col] of positions) reserved[row][col] = true
  return positions
}

/**
 * Reserve (and later write) the two version-information blocks (version ≥ 7).
 *
 * @param {object} target - matrix under construction.
 * @returns {Array<[number, number]>} the module positions, in bit order.
 */
function versionPositions({ reserved }) {
  const size = reserved.length
  const positions = []
  for (let i = 0; i < 18; i += 1) positions.push([Math.floor(i / 3), (i % 3) + size - 11])
  for (let i = 0; i < 18; i += 1) positions.push([(i % 3) + size - 11, Math.floor(i / 3)])
  for (const [row, col] of positions) reserved[row][col] = true
  return positions
}

/**
 * Build the complete symbol for one mask pattern.
 *
 * @param {object} input - build inputs.
 * @param {number} input.version - QR version.
 * @param {Uint8Array} input.codewords - interleaved codewords.
 * @param {number} input.mask - mask pattern 0–7.
 * @param {boolean} input.blankFormat - when true the format/version modules and
 * the dark module stay light, matching the reference penalty semantics.
 * @returns {boolean[][]} the module matrix.
 */
function buildMatrix({ version, codewords, mask, blankFormat }) {
  const size = version * 4 + 17
  const target = createBlankMatrix(size)
  const { modules, reserved } = target

  placeFinder(target, 0, 0)
  placeFinder(target, size - 7, 0)
  placeFinder(target, 0, size - 7)

  const centres = ALIGNMENT[version]
  for (const row of centres) {
    for (const col of centres) {
      const overlapsFinder =
        (row === 6 && col === 6) ||
        (row === 6 && col === size - 7) ||
        (row === size - 7 && col === 6)
      if (overlapsFinder) continue
      placeAlignment(target, row, col)
    }
  }

  for (let i = 8; i < size - 8; i += 1) {
    if (modules[6][i] === null) {
      modules[6][i] = i % 2 === 0
      reserved[6][i] = true
    }
    if (modules[i][6] === null) {
      modules[i][6] = i % 2 === 0
      reserved[i][6] = true
    }
  }

  // The dark module sits at (4 * version + 9, 8) and is always set.
  modules[size - 8][8] = !blankFormat
  reserved[size - 8][8] = true

  const format = formatPositions(target)
  const versionInfo = version >= 7 ? versionPositions(target) : []

  // Data placement: two-module columns, right to left, skipping the timing column.
  const bits = []
  for (const codeword of codewords) {
    for (let i = 7; i >= 0; i -= 1) bits.push((codeword >>> i) & 1)
  }
  for (let i = 0; i < REMAINDER_BITS[version]; i += 1) bits.push(0)

  let bitIndex = 0
  let upward = true
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col -= 1
    for (let step = 0; step < size; step += 1) {
      const row = upward ? size - 1 - step : step
      for (let c = 0; c < 2; c += 1) {
        const x = col - c
        if (reserved[row][x]) continue
        const bit = bitIndex < bits.length ? bits[bitIndex] === 1 : false
        bitIndex += 1
        modules[row][x] = MASK_FUNCTIONS[mask](row, x) ? !bit : bit
      }
    }
    upward = !upward
  }

  if (!blankFormat) {
    const info = bchTypeInfo((EC_LEVEL_L_BITS << 3) | mask)
    // `formatPositions` returns the vertical copy first, then the horizontal one;
    // both carry the same 15 bits.
    for (let i = 0; i < 30; i += 1) {
      const dark = ((info >>> (i % 15)) & 1) === 1
      const [row, col] = format[i]
      modules[row][col] = dark
    }
    if (version >= 7) {
      const number = VERSION_BITS[version]
      // Top-right block first, then the bottom-left one; both carry the same 18 bits.
      for (let i = 0; i < 36; i += 1) {
        const dark = ((number >>> (i % 18)) & 1) === 1
        const [row, col] = versionInfo[i]
        modules[row][col] = dark
      }
    }
  }

  return modules.map((row) => row.map((value) => value === true))
}

/**
 * Penalty score of one symbol (N1–N4).
 *
 * @param {boolean[][]} modules - module matrix.
 * @returns {number} the penalty; lower is better.
 */
function lostPoint(modules) {
  const size = modules.length
  let lost = 0

  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) {
      let same = 0
      const dark = modules[row][col]
      for (let r = -1; r <= 1; r += 1) {
        if (row + r < 0 || row + r >= size) continue
        for (let c = -1; c <= 1; c += 1) {
          if (col + c < 0 || col + c >= size) continue
          if (r === 0 && c === 0) continue
          if (dark === modules[row + r][col + c]) same += 1
        }
      }
      if (same > 5) lost += 3 + same - 5
    }
  }

  for (let row = 0; row < size - 1; row += 1) {
    for (let col = 0; col < size - 1; col += 1) {
      let count = 0
      if (modules[row][col]) count += 1
      if (modules[row + 1][col]) count += 1
      if (modules[row][col + 1]) count += 1
      if (modules[row + 1][col + 1]) count += 1
      if (count === 0 || count === 4) lost += 3
    }
  }

  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size - 6; col += 1) {
      if (
        modules[row][col] &&
        !modules[row][col + 1] &&
        modules[row][col + 2] &&
        modules[row][col + 3] &&
        modules[row][col + 4] &&
        !modules[row][col + 5] &&
        modules[row][col + 6]
      ) {
        lost += 40
      }
    }
  }
  for (let col = 0; col < size; col += 1) {
    for (let row = 0; row < size - 6; row += 1) {
      if (
        modules[row][col] &&
        !modules[row + 1][col] &&
        modules[row + 2][col] &&
        modules[row + 3][col] &&
        modules[row + 4][col] &&
        !modules[row + 5][col] &&
        modules[row + 6][col]
      ) {
        lost += 40
      }
    }
  }

  let dark = 0
  for (let col = 0; col < size; col += 1) {
    for (let row = 0; row < size; row += 1) {
      if (modules[row][col]) dark += 1
    }
  }
  const ratio = Math.abs((100 * dark) / size / size - 50) / 5
  return lost + ratio * 10
}

/**
 * Encode `text` into a QR module matrix.
 *
 * @param {string} text - payload (encoded as UTF-8, byte mode).
 * @returns {{ version: number, size: number, modules: boolean[][], mask: number }}
 * the symbol.
 * @throws {RangeError} when the payload does not fit version {@link MAX_VERSION}.
 * @throws {TypeError} when `text` is not a string.
 */
export function createQrMatrix(text) {
  if (typeof text !== 'string' || text === '') {
    throw new TypeError('qr: createQrMatrix requires a non-empty string')
  }
  const bytes = new TextEncoder().encode(text)
  const version = pickVersion(bytes.length)
  const codewords = buildCodewords(bytes, version)

  let best
  let bestMask = 0
  for (let mask = 0; mask < 8; mask += 1) {
    const modules = buildMatrix({ version, codewords, mask, blankFormat: true })
    const score = lostPoint(modules)
    if (best === undefined || score < best) {
      best = score
      bestMask = mask
    }
  }

  const modules = buildMatrix({ version, codewords, mask: bestMask, blankFormat: false })
  return { version, size: modules.length, modules, mask: bestMask }
}

/**
 * Render `text` as a standalone SVG QR image (dark on white, 4-module quiet zone).
 *
 * The quiet zone and the explicit black/white pair are deliberate: a QR code is
 * artwork that a camera has to read, so it must not inherit the host theme.
 *
 * @param {string} text - payload.
 * @param {{ scale?: number, quietZone?: number, title?: string }} [options]
 * rendering options.
 * @returns {string} the SVG document.
 */
export function qrSvg(text, options = {}) {
  const scale = Number.isFinite(options.scale) && options.scale > 0 ? options.scale : 4
  const quiet = Number.isFinite(options.quietZone) && options.quietZone >= 0 ? options.quietZone : 4
  const { modules, size, version } = createQrMatrix(text)
  const extent = (size + quiet * 2) * scale
  const commands = []
  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) {
      if (!modules[row][col]) continue
      const x = (col + quiet) * scale
      const y = (row + quiet) * scale
      commands.push(`M${x} ${y}h${scale}v${scale}h-${scale}z`)
    }
  }
  const title = typeof options.title === 'string' && options.title ? options.title : 'WeChat ClawBot QR code'
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${extent}" height="${extent}" viewBox="0 0 ${extent} ${extent}" role="img" aria-label="${escapeXml(title)}" data-qr-version="${version}">`,
    `<title>${escapeXml(title)}</title>`,
    `<rect width="${extent}" height="${extent}" fill="#ffffff"/>`,
    `<path fill="#000000" shape-rendering="crispEdges" d="${commands.join('')}"/>`,
    '</svg>',
  ].join('')
}

/**
 * @param {string} value - text.
 * @returns {string} XML-escaped text.
 */
function escapeXml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}
