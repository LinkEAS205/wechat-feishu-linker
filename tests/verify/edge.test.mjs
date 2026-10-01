/**
 * Verifier-owned edge-case suite.
 *
 * Targets the failure paths the A/B suites do not exercise: malformed wire
 * bodies, missing fields, oversized text, newline normalization on the wire,
 * echo suppression through the *service* (not just `normalize`), invalid AES
 * keys, an unwritable store directory, `errcode:-14`, and the `ret:-2` resend.
 *
 * Findings are recorded in `docs/VERIFICATION.md`.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { createIlinkClient, IlinkApiError, IlinkAuthError } from '../../src/ilink/client.js'
import { beginLogin } from '../../src/ilink/login.js'
import { normalizeInboundMessage, readRawMessages } from '../../src/ilink/normalize.js'
import { decryptCdnMedia, parseAesKey } from '../../src/ilink/media.js'
import { createAccountStore } from '../../src/ilink/store.js'
import { WechatIlinkChannel } from '../../src/service.js'
import * as ilink from '../../src/ilink/index.js'

/** Minimal `Response` stand-in: the client only reads `ok`/`status`/`text()`. */
function response(body, status = 200) {
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  return { ok: status >= 200 && status < 300, status, text: async () => text }
}

/** A fetch stub that plays back one scripted response per call and records the request. */
function stubFetch(script) {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: init?.body === undefined ? undefined : JSON.parse(init.body) })
    const next = script[Math.min(calls.length - 1, script.length - 1)]
    if (typeof next === 'function') return next(url, init, calls.length)
    return next
  }
  fetchImpl.calls = calls
  return fetchImpl
}

// ---------------------------------------------------------------------------
// 1. malformed / non-JSON responses
// ---------------------------------------------------------------------------

test('malformed JSON: an HTML error page served as 200 does not throw, and does not invent data', async () => {
  const fetchImpl = stubFetch([response('<html><body>502 Bad Gateway</body></html>')])
  const client = createIlinkClient({ token: 'tok', fetchImpl })

  // A non-object payload cannot carry ret/errcode, so `assertApiOk` lets it through.
  const config = await client.getConfig()
  assert.deepEqual(config, {}, 'a non-JSON body must degrade to "no config", not throw')

  const sent = await client.sendMessage({ toUserId: 'peer', text: 'hi' })
  assert.equal(typeof sent, 'string', 'the raw body is returned for diagnostics')

  const updates = await client.getUpdates()
  assert.deepEqual(updates.rawMessages, [])
  assert.equal(updates.buf, '')
})

test('malformed JSON: a truncated JSON body on getupdates keeps the previous cursor', async () => {
  const fetchImpl = stubFetch([response('{"ret":0,"msgs":[{"from_user_id":"peer"')])
  const client = createIlinkClient({ token: 'tok', fetchImpl })
  const updates = await client.getUpdates({ buf: 'cursor-1' })
  assert.equal(updates.buf, 'cursor-1', 'an unparsable body must never rewind the stream')
  assert.deepEqual(updates.rawMessages, [])
})

test('malformed JSON: the login GET surface rejects a non-JSON payload', async () => {
  const fetchImpl = stubFetch([response('<html>maintenance</html>')])
  await assert.rejects(
    () => beginLogin({ fetchImpl }),
    (error) => error instanceof IlinkApiError && /non-JSON/u.test(error.errmsg),
  )
})

test('malformed JSON: HTTP 200 with an empty body stays a success (sendmessage has no body)', async () => {
  const fetchImpl = stubFetch([response('')])
  const client = createIlinkClient({ token: 'tok', fetchImpl })
  assert.deepEqual(await client.sendMessage({ toUserId: 'peer', text: 'hi' }), {})
})

// ---------------------------------------------------------------------------
// 2. missing fields
// ---------------------------------------------------------------------------

test('missing fields: an empty getupdates payload yields nothing and no cursor', async () => {
  const client = createIlinkClient({ token: 'tok', fetchImpl: stubFetch([response({})]) })
  const updates = await client.getUpdates()
  assert.deepEqual(updates.rawMessages, [])
  assert.equal(updates.buf, '')
  assert.equal(updates.serverLongpollingTimeoutMs, null)
})

test('missing fields: null / scalar / junk elements never produce a message', () => {
  assert.deepEqual(readRawMessages(null), [])
  assert.deepEqual(readRawMessages('nope'), [])
  assert.deepEqual(readRawMessages({ msgs: [null, 3, 'x'] }), [])
  // `isRecord` accepts arrays, so a stray `[]` element survives the array
  // filter — harmless, because normalizeInboundMessage drops it below.
  assert.deepEqual(readRawMessages({ msgs: [null, 3, 'x', []] }), [[]])

  for (const raw of [null, undefined, 42, 'text', [], {}]) {
    assert.equal(normalizeInboundMessage(raw), null, `raw=${JSON.stringify(raw)}`)
  }
  // Text without a sender, and a sender without any content: both unusable.
  assert.equal(normalizeInboundMessage({ text: 'hello' }), null)
  assert.equal(normalizeInboundMessage({ from_user_id: 'peer' }), null)
  assert.equal(normalizeInboundMessage({ from_user_id: 'peer', item_list: [{ type: 1, text_item: { text: '   ' } }] }), null)
})

test('missing fields: buildSendBody refuses a missing target, and the client surfaces it', async () => {
  const fetchImpl = stubFetch([response({})])
  const client = createIlinkClient({ token: 'tok', fetchImpl })
  await assert.rejects(() => client.sendMessage({ text: 'hi' }), TypeError)
  assert.equal(fetchImpl.calls.length, 0, 'a missing target must not reach the network')
})

// ---------------------------------------------------------------------------
// 3. long text chunking
// ---------------------------------------------------------------------------

test('chunking: 100k characters are split, lossless, ordered and within the cap', async () => {
  const sent = []
  const client = { sendMessage: async (options) => (sent.push(options.text), {}) }
  const channel = new WechatIlinkChannel({
    ctx: {},
    config: { maxMessageLength: 512 },
    deps: { ilink, client },
    log: () => {},
  })

  const source = `${'段落一。'.repeat(2000)}\n${'x'.repeat(20_000)}`
  const result = await channel.sendText('peer', source)

  assert.ok(result.chunkCount > 10, `expected many chunks, got ${result.chunkCount}`)
  assert.equal(sent.length, result.chunkCount)
  // sendText normalizes newlines BEFORE chunking, so the lossless comparison is
  // against the CRLF form (the client would normalize again, idempotently).
  assert.equal(sent.join(''), ilink.normalizeOutboundText(source), 'concatenated chunks must reproduce the input exactly')
  for (const chunk of sent) {
    assert.ok(chunk.length <= 512, `chunk of ${chunk.length} exceeds the cap`)
    assert.equal(/(?<!\r)\n/u.test(chunk), false, 'chunks must already carry CRLF newlines')
  }
})

test('chunking: an emoji straddling the boundary is never split across messages', async () => {
  const sent = []
  const client = { sendMessage: async (options) => (sent.push(options.text), {}) }
  const channel = new WechatIlinkChannel({
    ctx: {},
    config: { maxMessageLength: 5 },
    deps: { ilink, client },
    log: () => {},
  })
  // 4 code units then a surrogate pair starting exactly at the cap.
  const source = 'abcd😀efgh😀'
  await channel.sendText('peer', source)
  assert.equal(sent.join(''), source)
  for (const chunk of sent) {
    const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(chunk)
    assert.equal(lone, false, `chunk contains a lone surrogate: ${JSON.stringify(chunk)}`)
  }
})

test('chunking: a per-call maxChars override wins over the configured cap', async () => {
  const sent = []
  const client = { sendMessage: async (options) => (sent.push(options.text), {}) }
  const channel = new WechatIlinkChannel({
    ctx: {},
    config: { maxMessageLength: 1000 },
    deps: { ilink, client },
    log: () => {},
  })
  const result = await channel.sendText('peer', 'y'.repeat(50), { maxChars: 10 })
  assert.equal(result.chunkCount, 5)
  assert.equal(sent.join(''), 'y'.repeat(50))
})

// ---------------------------------------------------------------------------
// 4. CRLF normalization on the wire
// ---------------------------------------------------------------------------

test('CRLF: mixed newline styles leave the process as pure CRLF', async () => {
  const fetchImpl = stubFetch([response({})])
  const client = createIlinkClient({ token: 'tok', fetchImpl })
  await client.sendMessage({ toUserId: 'peer', text: 'a\nb\r\nc\rd' })

  const wire = fetchImpl.calls[0].body
  const text = wire.msg.item_list[0].text_item.text
  assert.equal(text, 'a\r\nb\r\nc\r\nd')
  assert.equal(/(?<!\r)\n/u.test(text), false, 'a bare LF survived')
  assert.equal(/\r(?!\n)/u.test(text), false, 'a bare CR survived')
  // The silent-drop guards must all be on the wire.
  assert.equal(wire.msg.from_user_id, '')
  assert.ok(wire.msg.client_id.startsWith('dsh-wechat-'))
  assert.deepEqual(wire.base_info, { channel_version: '2.0.0' })
})

test('CRLF: chunk boundaries never split a CRLF pair', async () => {
  const chunks = ilink.chunkText('aaaa\r\nbbbb\r\ncccc', 6)
  assert.equal(chunks.join(''), 'aaaa\r\nbbbb\r\ncccc')
  for (const chunk of chunks) {
    assert.equal(chunk.endsWith('\r'), false, `chunk ends on a bare CR: ${JSON.stringify(chunk)}`)
    assert.equal(chunk.startsWith('\n'), false, `chunk starts on a bare LF: ${JSON.stringify(chunk)}`)
  }
})

// ---------------------------------------------------------------------------
// 5. echo suppression through the service
// ---------------------------------------------------------------------------

test('echo: the service drops message_type 2, numeric-string types, and self-authored messages', () => {
  const channel = new WechatIlinkChannel({
    ctx: {},
    config: {},
    deps: { ilink, client: { sendMessage: async () => ({}) } },
    log: () => {},
  })
  channel.account = { botId: 'bot@im.bot' }

  const published = []
  channel.onMessage((message) => published.push(message))

  const base = { from_user_id: 'peer@im.wechat', item_list: [{ type: 1, text_item: { text: 'hi' } }] }
  assert.equal(channel.ingest([{ ...base, message_type: 2 }]), 0, 'numeric echo must be dropped')
  assert.equal(channel.ingest([{ ...base, message_type: '2' }]), 0, 'string echo must be dropped too')
  assert.equal(channel.ingest([{ ...base, msg: { message_type: 2 } }]), 0, 'nested echo must be dropped')
  assert.equal(channel.ingest([{ ...base, from_user_id: 'bot@im.bot' }]), 0, 'self-authored message must be dropped')
  assert.equal(channel.ingest([{ ...base, from_user_id: 'bot@im.bot', message_type: 1 }]), 0)
  assert.equal(published.length, 0)

  assert.equal(channel.ingest([{ ...base, message_type: 1 }]), 1, 'a real inbound message still lands')
  assert.equal(published.length, 1)
  assert.equal(published[0].fromUserId, 'peer@im.wechat')
})

test('echo: one malformed element never discards the rest of the batch', () => {
  const channel = new WechatIlinkChannel({ ctx: {}, config: {}, deps: { ilink }, log: () => {} })
  const published = []
  channel.onMessage((message) => published.push(message))
  const good = { from_user_id: 'peer@im.wechat', item_list: [{ type: 1, text_item: { text: 'ok' } }] }
  const count = channel.ingest([null, { junk: true }, good, { ...good, message_type: 2 }, good])
  assert.equal(count, 2)
  assert.deepEqual(published.map((message) => message.text), ['ok', 'ok'])
})

// ---------------------------------------------------------------------------
// 6. AES keys
// ---------------------------------------------------------------------------

test('AES: unusable keys are rejected without throwing from parseAesKey', () => {
  for (const value of [undefined, null, 42, {}, '', '   ', 'zzzz', 'not-hex-at-all', 'a'.repeat(31), 'a'.repeat(33)]) {
    assert.equal(parseAesKey(value), null, `parseAesKey(${JSON.stringify(value)}) must be null`)
  }
})

test('AES: decryptCdnMedia refuses an invalid key and a corrupt ciphertext', async () => {
  const { createCipheriv, randomBytes } = await import('node:crypto')
  assert.throws(() => decryptCdnMedia(new Uint8Array([1, 2, 3]), 'garbage'), /AES key is invalid/u)

  const key = randomBytes(16)
  const cipher = createCipheriv('aes-128-ecb', key, null)
  const encrypted = Buffer.concat([cipher.update(Buffer.from('hello world')), cipher.final()])

  // Correct key through each accepted encoding.
  assert.deepEqual(
    Buffer.from(decryptCdnMedia(new Uint8Array(encrypted), key.toString('hex'))).toString('utf8'),
    'hello world',
  )
  assert.deepEqual(
    Buffer.from(decryptCdnMedia(new Uint8Array(encrypted), key.toString('base64'))).toString('utf8'),
    'hello world',
  )
  // Truncated ciphertext (not block aligned) must fail loudly, not silently.
  assert.throws(() => decryptCdnMedia(new Uint8Array(encrypted.subarray(0, encrypted.length - 3)), key.toString('hex')))
  // A wrong-but-valid key fails PKCS7 instead of returning mojibake.
  assert.throws(() => decryptCdnMedia(new Uint8Array(encrypted), randomBytes(16).toString('hex')))
})

// ---------------------------------------------------------------------------
// 7. unwritable store directory
// ---------------------------------------------------------------------------

test('store: an unwritable data directory rejects writes and still degrades reads to null', async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), 'dsh-wechat-verify-'))
  try {
    // A regular file where the data directory should be: mkdir() can never succeed.
    const blocker = path.join(tmp, 'blocked')
    await writeFile(blocker, 'not a directory')
    const store = createAccountStore({ dataDir: path.join(blocker, 'data') })

    assert.equal(await store.load(), null, 'a missing/unreadable account degrades to null')
    assert.equal(await store.readBuf('k'), '')
    await assert.rejects(() => store.save({ botToken: 'tok' }), undefined, 'save must surface the IO failure')
    await assert.rejects(() => store.writeBuf('k', 'v'), undefined, 'writeBuf must surface the IO failure')
    assert.equal(await store.load(), null, 'the store stays usable after a failed write')
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
})

test('store: a directory that disappears mid-flight still round-trips', async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), 'dsh-wechat-verify-'))
  try {
    const dir = path.join(tmp, 'nested', 'deeper')
    const store = createAccountStore({ dataDir: dir })
    await store.save({ botToken: 'tok', botId: 'bot-1' })
    assert.deepEqual(await store.load(), { botToken: 'tok', botId: 'bot-1' })
    await store.writeBuf('peer', 'cursor-9')
    assert.equal(await store.readBuf('peer'), 'cursor-9')
    await rm(path.join(tmp, 'nested'), { recursive: true, force: true })
    assert.equal(await store.load(), null)
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 8. errcode -14 → IlinkAuthError
// ---------------------------------------------------------------------------

test('errcode -14: every authenticated endpoint raises IlinkAuthError', async () => {
  for (const [label, call] of [
    ['getconfig', (client) => client.getConfig()],
    ['getupdates', (client) => client.getUpdates()],
    ['sendmessage', (client) => client.sendMessage({ toUserId: 'peer', text: 'hi' })],
    ['sendtyping', (client) => client.sendTyping({ toUserId: 'peer' })],
  ]) {
    const fetchImpl = stubFetch([response({ errcode: -14, errmsg: 'login expired' })])
    const client = createIlinkClient({ token: 'tok', fetchImpl })
    await assert.rejects(call(client), (error) => {
      assert.ok(error instanceof IlinkAuthError, `${label}: expected IlinkAuthError, got ${error.name}`)
      assert.ok(error instanceof IlinkApiError, `${label}: IlinkAuthError must extend IlinkApiError`)
      assert.equal(error.errcode, -14)
      assert.equal(error.name, 'IlinkAuthError')
      return true
    })
    assert.equal(fetchImpl.calls.length, 1, `${label}: an auth failure must not be retried blindly`)
  }
})

test('errcode -14: a stringified errcode is still detected', async () => {
  const fetchImpl = stubFetch([response({ errcode: '-14' })])
  const client = createIlinkClient({ token: 'tok', fetchImpl })
  await assert.rejects(() => client.getConfig(), IlinkAuthError)
})

// ---------------------------------------------------------------------------
// 9. ret -2 → one resend without context_token
// ---------------------------------------------------------------------------

test('ret -2: sendmessage is resent exactly once without the stale context_token', async () => {
  const fetchImpl = stubFetch([
    response({ ret: -2, errmsg: 'stale context_token' }),
    response({}),
  ])
  const client = createIlinkClient({ token: 'tok', fetchImpl })
  await client.sendMessage({ toUserId: 'peer', text: 'hi', contextToken: 'stale-token' })

  assert.equal(fetchImpl.calls.length, 2, 'exactly one resend')
  const first = fetchImpl.calls[0].body.msg
  const second = fetchImpl.calls[1].body.msg
  assert.equal(first.context_token, 'stale-token')
  assert.equal('context_token' in second, false, 'the resend must drop the stale token')
  assert.equal(first.client_id, second.client_id, 'the resend must keep the same client_id (idempotency)')
  assert.equal(second.from_user_id, '')
  assert.equal(second.to_user_id, 'peer')
})

test('ret -2: without a context_token there is nothing to drop, so no resend happens', async () => {
  const fetchImpl = stubFetch([response({ ret: -2, errmsg: 'prepare failed' })])
  const client = createIlinkClient({ token: 'tok', fetchImpl })
  await assert.rejects(
    () => client.sendMessage({ toUserId: 'peer', text: 'hi' }),
    (error) => error instanceof IlinkApiError && error.ret === -2,
  )
  assert.equal(fetchImpl.calls.length, 1, 'a ret:-2 without a token must not be retried')
})

test('ret -2: a second ret:-2 on the resend propagates instead of looping', async () => {
  const fetchImpl = stubFetch([response({ ret: -2 }), response({ ret: -2, errmsg: 'still stale' })])
  const client = createIlinkClient({ token: 'tok', fetchImpl })
  await assert.rejects(() => client.sendMessage({ toUserId: 'peer', text: 'hi', contextToken: 'stale' }))
  assert.equal(fetchImpl.calls.length, 2)
})

test('ret -2: getupdates never retries (the resend rule is sendmessage-only)', async () => {
  const fetchImpl = stubFetch([response({ ret: -2, errmsg: 'ilink_user_id required' })])
  const client = createIlinkClient({ token: 'tok', fetchImpl })
  await assert.rejects(() => client.getUpdates(), (error) => error.ret === -2)
  assert.equal(fetchImpl.calls.length, 1)
})

// ---------------------------------------------------------------------------
// 10. long-poll timeout adoption (contract §1)
// ---------------------------------------------------------------------------

test('long poll: an aborted client timeout is an AbortError, not a business failure', async () => {
  const fetchImpl = stubFetch([
    (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          const error = new Error('This operation was aborted')
          error.name = 'AbortError'
          reject(error)
        })
      }),
  ])
  const client = createIlinkClient({ token: 'tok', fetchImpl })
  // NOTE: getUpdates deliberately overrides the short-POST timeout with the
  // 45 s long-poll budget, so the external signal is the only fast way to
  // cancel it — which is exactly the path `startPollLoop.stop()` uses.
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 20)
  try {
    await assert.rejects(
      () => client.getUpdates({ signal: controller.signal }),
      (error) => error.name === 'AbortError' || error.name === 'TimeoutError',
    )
  } finally {
    clearTimeout(timer)
  }
})
