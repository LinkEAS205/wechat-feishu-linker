/**
 * Implementation notes for the iLink protocol layer (task-1 deliverable #4).
 *
 * Scope: `src/ilink/{client,login,normalize,media,store,poll}.js` — pure ESM, zero third-party
 * runtime dependencies (Node builtins only: `fetch`, `node:crypto`, `node:fs/promises`,
 * `node:path`, `node:os`, `node:buffer`).
 *
 * Protocol truth source: ZCode `weixinProvider.ts` / `weixinRegistration.ts`, cross-checked
 * against 8 independent implementations (the eight independent open-source iLink clients) and frozen in
 * `docs/INTERFACES.md` §1 + §3.1–3.6.
 *
 * Design decisions worth knowing:
 *   - Every network call goes through an injectable `fetchImpl` (default `globalThis.fetch`).
 *     This test file NEVER touches the network: each test injects a fake fetch.
 *   - `msgs` is the primary message-array field; `data` / `messages` / `msg_list` / `updates` /
 *     `items` / `list` are compatibility fallbacks.
 *   - Long poll: client timeout starts at 45 000 ms and is re-adopted from the server's
 *     `longpolling_timeout_ms` (+10 s safety margin, clamped to 38 000–60 000 ms).
 *   - Errors: non-2xx → `IlinkHttpError`; `ret !== 0 || errcode !== 0` → `IlinkApiError`;
 *     `errcode === -14` → `IlinkAuthError` (subclass, "scan again"); `sendmessage ret === -2`
 *     (stale `context_token`) → retried once without the token.
 *   - `X-WECHAT-UIN` = `base64(decimal random uint32)`, regenerated for every request.
 *   - `chunkText` never splits a UTF-16 surrogate pair and guarantees `chunks.join('') === text`.
 *
 * Run: `node --test tests/ilink.test.mjs`
 */
import assert from 'node:assert/strict'
import { createCipheriv, randomBytes } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { after, describe, it } from 'node:test'

import {
  CHANNEL_VERSION,
  DEFAULT_GET_UPDATES_TIMEOUT_MS,
  DEFAULT_ILINK_BASE_URL,
  ILINK_BOT_API_PREFIX,
  IlinkApiError,
  IlinkAuthError,
  IlinkHttpError,
  buildHeaders,
  createIlinkClient,
  resolveLongPollTimeout,
} from '../src/ilink/client.js'
import {
  DEFAULT_QR_EXPIRES_IN_SECONDS,
  beginLogin,
  normalizeQrStatus,
  pollLogin,
} from '../src/ilink/login.js'
import {
  buildSendBody,
  chunkText,
  extractNextBuf,
  normalizeInboundMessage,
  normalizeOutboundText,
  readRawMessages,
} from '../src/ilink/normalize.js'
import { ILINK_CDN_BASE_URL, decryptCdnMedia, guessMimeFromFilename, parseAesKey } from '../src/ilink/media.js'
import { createAccountStore, resolveDataDir } from '../src/ilink/store.js'
import { computeBackoff, startPollLoop } from '../src/ilink/poll.js'

// ---------------------------------------------------------------------------
// Test helpers — fake fetch only, never the real network.
// ---------------------------------------------------------------------------

/**
 * Build a minimal `Response`-like object.
 *
 * @param {unknown} payload JSON payload (or raw string).
 * @param {{ status?: number }} [options]
 * @returns {{ ok: boolean, status: number, text: () => Promise<string> }}
 */
function jsonResponse(payload, { status = 200 } = {}) {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload)
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return text
    },
  }
}

/**
 * Recording fetch stub.
 *
 * @param {(call: object, index: number) => unknown} handler
 * @returns {{ fetchImpl: (url: string, init?: object) => Promise<unknown>, calls: object[] }}
 */
function createFetchStub(handler) {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    const call = {
      url: String(url),
      method: init.method ?? 'GET',
      headers: init.headers ?? {},
      body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body,
      signal: init.signal,
    }
    calls.push(call)
    return handler(call, calls.length - 1)
  }
  return { fetchImpl, calls }
}

/**
 * Poll a predicate until it holds.
 *
 * @param {() => boolean} predicate
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<void>}
 */
async function waitFor(predicate, { timeoutMs = 3_000 } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('waitFor timed out')
}

/**
 * Reject when `promise` does not settle in time (keeps a hanging loop from stalling the suite).
 *
 * @template T
 * @param {Promise<T>} promise
 * @param {number} [ms]
 * @returns {Promise<T>}
 */
function withTimeout(promise, ms = 3_000) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timed out')), ms)),
  ])
}

// ---------------------------------------------------------------------------
// client.js
// ---------------------------------------------------------------------------

describe('client: headers and envelope', () => {
  it('builds the frozen authenticated header set', () => {
    const headers = buildHeaders('tok-1', { randomUin: 12345 })
    assert.equal(headers['content-type'], 'application/json')
    assert.equal(headers.AuthorizationType, 'ilink_bot_token')
    assert.equal(headers.Authorization, 'Bearer tok-1')
    assert.equal(headers['X-WECHAT-UIN'], Buffer.from('12345', 'utf8').toString('base64'))
    assert.equal(headers['iLink-App-Id'], 'bot')
  })

  it('accepts a randomUin function and regenerates the UIN on every request', async () => {
    let counter = 0
    const { fetchImpl, calls } = createFetchStub(() => jsonResponse({ ret: 0 }))
    const client = createIlinkClient({ token: 'tok', fetchImpl, randomUin: () => (counter += 1) })
    await client.getConfig()
    await client.getConfig()
    assert.equal(calls[0].headers['X-WECHAT-UIN'], Buffer.from('1').toString('base64'))
    assert.equal(calls[1].headers['X-WECHAT-UIN'], Buffer.from('2').toString('base64'))
  })

  it('POSTs to the /ilink/bot prefix with a base_info envelope', async () => {
    const { fetchImpl, calls } = createFetchStub(() => jsonResponse({ ret: 0, typing_ticket: 't' }))
    const client = createIlinkClient({ token: 'tok', fetchImpl })
    await client.getConfig({ ilinkUserId: 'u@im.wechat', contextToken: 'ctx' })

    assert.equal(calls[0].method, 'POST')
    assert.equal(calls[0].url, `${DEFAULT_ILINK_BASE_URL}${ILINK_BOT_API_PREFIX}/getconfig`)
    assert.deepEqual(calls[0].body.base_info, { channel_version: CHANNEL_VERSION })
    assert.equal(calls[0].body.ilink_user_id, 'u@im.wechat')
    assert.equal(calls[0].body.context_token, 'ctx')
  })

  it('omits optional getconfig fields when they are not supplied', async () => {
    const { fetchImpl, calls } = createFetchStub(() => jsonResponse({ ret: 0 }))
    await createIlinkClient({ token: 'tok', fetchImpl }).getConfig()
    assert.deepEqual(calls[0].body, { base_info: { channel_version: CHANNEL_VERSION } })
  })

  it('merges a nested getconfig data object', async () => {
    const { fetchImpl } = createFetchStub(() => jsonResponse({ ret: 0, data: { typing_ticket: 'nested' } }))
    const config = await createIlinkClient({ token: 'tok', fetchImpl }).getConfig()
    assert.equal(config.typing_ticket, 'nested')
  })
})

describe('client: error mapping', () => {
  it('throws IlinkHttpError on a non-2xx response', async () => {
    const { fetchImpl } = createFetchStub(() => jsonResponse('server exploded', { status: 502 }))
    const client = createIlinkClient({ token: 'tok', fetchImpl })
    await assert.rejects(
      () => client.request('/getupdates', {}),
      (error) => {
        assert.ok(error instanceof IlinkHttpError, 'expected IlinkHttpError')
        assert.equal(error.status, 502)
        assert.equal(error.path, '/getupdates')
        assert.equal(error.bodyText, 'server exploded')
        return true
      },
    )
  })

  it('throws IlinkApiError with ret/errcode/errmsg/path when ret !== 0', async () => {
    const { fetchImpl } = createFetchStub(() => jsonResponse({ ret: 11001, errmsg: 'bad token' }))
    const client = createIlinkClient({ token: 'tok', fetchImpl })
    await assert.rejects(
      () => client.getUpdates(),
      (error) => {
        assert.ok(error instanceof IlinkApiError, 'expected IlinkApiError')
        assert.equal(error.ret, 11001)
        assert.equal(error.errcode, null)
        assert.equal(error.errmsg, 'bad token')
        assert.equal(error.path, '/getupdates')
        return true
      },
    )
  })

  it('throws IlinkApiError when errcode !== 0 and falls back to `message`', async () => {
    const { fetchImpl } = createFetchStub(() => jsonResponse({ ret: 0, errcode: 40001, message: 'nope' }))
    const client = createIlinkClient({ token: 'tok', fetchImpl })
    await assert.rejects(
      () => client.getConfig(),
      (error) => {
        assert.ok(error instanceof IlinkApiError)
        assert.equal(error.errcode, 40001)
        assert.equal(error.errmsg, 'nope')
        return true
      },
    )
  })

  it('flags errcode -14 as IlinkAuthError (subclass of IlinkApiError)', async () => {
    const { fetchImpl } = createFakeSequence([
      { ret: 0, errcode: -14, errmsg: 'session timeout' },
    ])
    const client = createIlinkClient({ token: 'tok', fetchImpl })
    await assert.rejects(
      () => client.getUpdates(),
      (error) => {
        assert.ok(error instanceof IlinkAuthError, 'expected IlinkAuthError')
        assert.ok(error instanceof IlinkApiError, 'IlinkAuthError must extend IlinkApiError')
        assert.equal(error.errcode, -14)
        return true
      },
    )
  })

  it('accepts an empty 200 body without throwing (sendmessage has no response body)', async () => {
    const { fetchImpl } = createFetchStub(() => jsonResponse(''))
    const result = await createIlinkClient({ token: 'tok', fetchImpl }).request('/sendmessage', {})
    assert.deepEqual(result, {})
  })

  it('refuses to call the API without a token', async () => {
    const { fetchImpl, calls } = createFetchStub(() => jsonResponse({ ret: 0 }))
    const client = createIlinkClient({ token: '   ', fetchImpl })
    await assert.rejects(() => client.getConfig(), IlinkApiError)
    assert.equal(calls.length, 0)
  })

  it('exposes the trimmed token', () => {
    assert.equal(createIlinkClient({ token: '  tok  ' }).token, 'tok')
  })
})

describe('client: getupdates', () => {
  it('reads msgs and the new cursor, and echoes the request cursor', async () => {
    const { fetchImpl, calls } = createFetchStub(() =>
      jsonResponse({
        ret: 0,
        msgs: [{ from_user_id: 'u@im.wechat', item_list: [{ type: 1, text_item: { text: 'hi' } }] }],
        get_updates_buf: 'cursor-2',
        longpolling_timeout_ms: 35000,
      }),
    )
    const client = createIlinkClient({ token: 'tok', fetchImpl })
    const result = await client.getUpdates({ buf: 'cursor-1' })

    assert.equal(result.rawMessages.length, 1)
    assert.equal(result.buf, 'cursor-2')
    assert.equal(calls[0].body.get_updates_buf, 'cursor-1')
    assert.deepEqual(calls[0].body.base_info, { channel_version: CHANNEL_VERSION })
  })

  it('keeps the previous cursor when the response carries none', async () => {
    const { fetchImpl } = createFetchStub(() => jsonResponse({ ret: 0, msgs: [] }))
    const result = await createIlinkClient({ token: 'tok', fetchImpl }).getUpdates({ buf: 'keep-me' })
    assert.equal(result.buf, 'keep-me')
    assert.deepEqual(result.rawMessages, [])
  })

  it('adopts longpolling_timeout_ms with a 10s margin, clamped to [38s, 60s]', async () => {
    const { fetchImpl } = createFakeSequence([
      { ret: 0, msgs: [], get_updates_buf: 'b1', longpolling_timeout_ms: 35000 },
      { ret: 0, msgs: [], get_updates_buf: 'b2', longpolling_timeout_ms: 20000 },
      { ret: 0, msgs: [], get_updates_buf: 'b3', longpolling_timeout_ms: 55000 },
    ])
    const client = createIlinkClient({ token: 'tok', fetchImpl })

    const first = await client.getUpdates({ buf: '' })
    assert.equal(first.longpollingTimeoutMs, DEFAULT_GET_UPDATES_TIMEOUT_MS)
    assert.equal(first.serverLongpollingTimeoutMs, 35000)

    const second = await client.getUpdates({ buf: 'b1' })
    assert.equal(second.longpollingTimeoutMs, 45000, '35000 + 10000 margin')
    assert.equal(second.serverLongpollingTimeoutMs, 20000)

    const third = await client.getUpdates({ buf: 'b2' })
    assert.equal(third.longpollingTimeoutMs, 38000, '20000 + 10000 clamped up to the 38s floor')

    const fourth = await client.getUpdates({ buf: 'b3' })
    assert.equal(fourth.longpollingTimeoutMs, 60000, '55000 + 10000 clamped down to the 60s ceiling')
  })

  it('resolveLongPollTimeout keeps the fallback for unusable server values', () => {
    assert.equal(resolveLongPollTimeout(0, 45_000), 45_000)
    assert.equal(resolveLongPollTimeout(Number.NaN, 45_000), 45_000)
    assert.equal(resolveLongPollTimeout(35_000), 45_000)
    assert.equal(resolveLongPollTimeout(5_000), 38_000)
  })
})

describe('client: sendmessage', () => {
  it('builds the mandatory silent-drop-proof envelope', async () => {
    const { fetchImpl, calls } = createFetchStub(() => jsonResponse(''))
    const client = createIlinkClient({ token: 'tok', fetchImpl })
    await client.sendMessage({ toUserId: 'peer@im.wechat', text: 'line1\nline2', contextToken: 'ctx-1' })

    const body = calls[0].body
    assert.deepEqual(body.base_info, { channel_version: CHANNEL_VERSION })
    assert.equal(body.msg.from_user_id, '')
    assert.equal(body.msg.to_user_id, 'peer@im.wechat')
    assert.match(body.msg.client_id, /^dsh-wechat-[0-9a-f-]{36}$/)
    assert.equal(body.msg.message_type, 2)
    assert.equal(body.msg.message_state, 2)
    assert.equal(body.msg.context_token, 'ctx-1')
    assert.deepEqual(body.msg.item_list, [{ type: 1, text_item: { text: 'line1\r\nline2' } }])
  })

  it('omits context_token when the caller has none', async () => {
    const { fetchImpl, calls } = createFetchStub(() => jsonResponse(''))
    await createIlinkClient({ token: 'tok', fetchImpl }).sendMessage({ toUserId: 'peer', text: 'x' })
    assert.ok(!('context_token' in calls[0].body.msg))
  })

  it('uses a fresh client_id per message and honours an explicit one', async () => {
    const { fetchImpl, calls } = createFetchStub(() => jsonResponse(''))
    const client = createIlinkClient({ token: 'tok', fetchImpl })
    await client.sendMessage({ toUserId: 'peer', text: 'a' })
    await client.sendMessage({ toUserId: 'peer', text: 'b' })
    assert.notEqual(calls[0].body.msg.client_id, calls[1].body.msg.client_id)

    const fixed = createIlinkClient({ token: 'tok', fetchImpl, clientId: 'dsh-wechat-fixed' })
    await fixed.sendMessage({ toUserId: 'peer', text: 'c' })
    assert.equal(calls[2].body.msg.client_id, 'dsh-wechat-fixed')
  })

  it('retries once without context_token when the server answers ret === -2', async () => {
    const { fetchImpl, calls } = createFetchStub((_call, index) =>
      index === 0 ? jsonResponse({ ret: -2, errmsg: 'context token expired' }) : jsonResponse({ ret: 0 }),
    )
    const client = createIlinkClient({ token: 'tok', fetchImpl })
    const result = await client.sendMessage({ toUserId: 'peer', text: 'hi', contextToken: 'stale' })

    assert.deepEqual(result, { ret: 0 })
    assert.equal(calls.length, 2)
    assert.equal(calls[0].body.msg.context_token, 'stale')
    assert.ok(!('context_token' in calls[1].body.msg), 'retry must drop the stale context_token')
  })

  it('does not retry ret === -2 when there was no context_token to drop', async () => {
    const { fetchImpl, calls } = createFetchStub(() => jsonResponse({ ret: -2 }))
    const client = createIlinkClient({ token: 'tok', fetchImpl })
    await assert.rejects(
      () => client.sendMessage({ toUserId: 'peer', text: 'hi' }),
      (error) => {
        assert.ok(error instanceof IlinkApiError)
        assert.equal(error.ret, -2)
        return true
      },
    )
    assert.equal(calls.length, 1)
  })

  it('sends the bot user id when one is configured', async () => {
    const { fetchImpl, calls } = createFetchStub(() => jsonResponse(''))
    await createIlinkClient({ token: 'tok', fetchImpl, fromUserId: 'bot@im.bot' })
      .sendMessage({ toUserId: 'peer', text: 'x' })
    assert.equal(calls[0].body.msg.from_user_id, 'bot@im.bot')
  })
})

describe('client: sendtyping', () => {
  it('returns false when no typing_ticket is available', async () => {
    const { fetchImpl, calls } = createFetchStub(() => jsonResponse({ ret: 0 }))
    const ok = await createIlinkClient({ token: 'tok', fetchImpl }).sendTyping({ toUserId: 'peer' })
    assert.equal(ok, false)
    assert.equal(calls.length, 1)
    assert.match(calls[0].url, /\/getconfig$/)
  })

  it('posts /sendtyping with the ticket and status 1', async () => {
    const { fetchImpl, calls } = createFetchStub((call) =>
      call.url.endsWith('/getconfig') ? jsonResponse({ ret: 0, typing_ticket: 'ticket-1' }) : jsonResponse({ ret: 0 }),
    )
    const ok = await createIlinkClient({ token: 'tok', fetchImpl })
      .sendTyping({ toUserId: 'peer', contextToken: 'ctx' })

    assert.equal(ok, true)
    assert.equal(calls.length, 2)
    assert.match(calls[1].url, /\/sendtyping$/)
    assert.equal(calls[1].body.ilink_user_id, 'peer')
    assert.equal(calls[1].body.typing_ticket, 'ticket-1')
    assert.equal(calls[1].body.status, 1)
  })

  it('[REGRESSION] reuses the ticket instead of re-minting it on every heartbeat', async () => {
    // `getconfig` needs the peer's `context_token`, which is short-lived. A turn
    // that runs for minutes outlives it, so re-minting per heartbeat is exactly
    // how the indicator dies mid-turn: the first refresh works and every later
    // one fails on a stale token. The client therefore caches the ticket.
    const { fetchImpl, calls } = createFetchStub((call) =>
      call.url.endsWith('/getconfig') ? jsonResponse({ ret: 0, typing_ticket: 'ticket-1' }) : jsonResponse({ ret: 0 }),
    )
    const client = createIlinkClient({ token: 'tok', fetchImpl })

    await client.sendTyping({ toUserId: 'peer', contextToken: 'ctx' })
    await client.sendTyping({ toUserId: 'peer', contextToken: 'ctx' })
    await client.sendTyping({ toUserId: 'peer', contextToken: 'ctx' })

    const configCalls = calls.filter((call) => call.url.endsWith('/getconfig'))
    const typingCalls = calls.filter((call) => call.url.endsWith('/sendtyping'))
    assert.equal(configCalls.length, 1, 'getconfig must be spent once, while the token is still fresh')
    assert.equal(typingCalls.length, 3, 'every heartbeat still signals')
  })

  it('drops a rejected ticket so the next attempt re-mints it', async () => {
    let sendtypingCalls = 0
    const { fetchImpl, calls } = createFetchStub((call) => {
      if (call.url.endsWith('/getconfig')) return jsonResponse({ ret: 0, typing_ticket: 'ticket-1' })
      sendtypingCalls += 1
      return sendtypingCalls === 1 ? jsonResponse({ ret: -2, errmsg: 'prepare failed' }) : jsonResponse({ ret: 0 })
    })
    const client = createIlinkClient({ token: 'tok', fetchImpl })

    await assert.rejects(() => client.sendTyping({ toUserId: 'peer', contextToken: 'ctx' }))
    // The dead ticket is gone, so this one has to fetch a fresh one first.
    await client.sendTyping({ toUserId: 'peer', contextToken: 'ctx' })

    assert.equal(calls.filter((call) => call.url.endsWith('/getconfig')).length, 2)
  })
})

/**
 * Fetch stub returning one scripted response per call (last one repeats).
 *
 * @param {unknown[]} responses
 * @returns {{ fetchImpl: (url: string, init?: object) => Promise<unknown>, calls: object[] }}
 */
function createFakeSequence(responses) {
  return createFetchStub((_call, index) =>
    jsonResponse(responses[Math.min(index, responses.length - 1)]),
  )
}

// ---------------------------------------------------------------------------
// login.js
// ---------------------------------------------------------------------------

describe('login: normalizeQrStatus', () => {
  it('maps the numeric codes', () => {
    assert.equal(normalizeQrStatus(0), 'pending')
    assert.equal(normalizeQrStatus(1), 'scanned')
    assert.equal(normalizeQrStatus(2), 'success')
    assert.equal(normalizeQrStatus(3), 'expired')
    assert.equal(normalizeQrStatus(4), 'expired')
    assert.equal(normalizeQrStatus(99), 'pending')
  })

  it('maps the string statuses', () => {
    assert.equal(normalizeQrStatus('confirmed'), 'success')
    assert.equal(normalizeQrStatus('ok'), 'success')
    assert.equal(normalizeQrStatus('scaned'), 'scanned')
    assert.equal(normalizeQrStatus('SCANNED'), 'scanned')
    assert.equal(normalizeQrStatus('expired'), 'expired')
    assert.equal(normalizeQrStatus('timeout'), 'expired')
    assert.equal(normalizeQrStatus('failed'), 'error')
    assert.equal(normalizeQrStatus('wait'), 'pending')
    assert.equal(normalizeQrStatus('2'), 'success', 'numeric strings are accepted too')
  })

  it('falls back to pending for unknown or missing values', () => {
    assert.equal(normalizeQrStatus(undefined), 'pending')
    assert.equal(normalizeQrStatus(null), 'pending')
    assert.equal(normalizeQrStatus({}), 'pending')
    assert.equal(normalizeQrStatus('whatever'), 'pending')
  })
})

describe('login: beginLogin', () => {
  it('fetches a QR code over the unauthenticated GET surface', async () => {
    const { fetchImpl, calls } = createFetchStub(() =>
      jsonResponse({ ret: 0, qrcode: 'qr-abc', qrcode_img_content: 'https://liteapp.weixin.qq.com/q/x' }),
    )
    const result = await beginLogin({ fetchImpl })

    assert.equal(result.qrcode, 'qr-abc')
    assert.equal(result.qrUrl, 'https://liteapp.weixin.qq.com/q/x')
    assert.equal(result.expiresIn, DEFAULT_QR_EXPIRES_IN_SECONDS)
    assert.ok(result.expiresAt > Date.now())
    assert.equal(calls[0].method, 'GET')
    assert.equal(calls[0].url, `${DEFAULT_ILINK_BASE_URL}${ILINK_BOT_API_PREFIX}/get_bot_qrcode?bot_type=3`)
    assert.equal(calls[0].headers['iLink-App-ClientVersion'], '1')
    assert.equal(calls[0].headers['iLink-App-Id'], 'bot')
  })

  it('honours expires_in and the qrcode_url fallback', async () => {
    const { fetchImpl } = createFetchStub(() =>
      jsonResponse({ ret: 0, qr_code: 'qr-2', qrcode_url: 'https://example/qr.png', expires_in: 300 }),
    )
    const result = await beginLogin({ fetchImpl })
    assert.equal(result.qrcode, 'qr-2')
    assert.equal(result.qrUrl, 'https://example/qr.png')
    assert.equal(result.expiresIn, 300)
  })

  it('throws when no QR code is returned', async () => {
    const { fetchImpl } = createFetchStub(() => jsonResponse({ ret: 0 }))
    await assert.rejects(() => beginLogin({ fetchImpl }), IlinkApiError)
  })

  it('throws IlinkHttpError on a non-2xx response', async () => {
    const { fetchImpl } = createFetchStub(() => jsonResponse('nope', { status: 503 }))
    await assert.rejects(() => beginLogin({ fetchImpl }), IlinkHttpError)
  })
})

describe('login: pollLogin', () => {
  it('reports pending and scanned states', async () => {
    const pending = createFetchStub(() => jsonResponse({ ret: 0, status: 'wait' }))
    assert.deepEqual(await pollLogin({ qrcode: 'qr', fetchImpl: pending.fetchImpl }), { status: 'pending' })

    const scanned = createFetchStub(() => jsonResponse({ ret: 0, status: 'scaned' }))
    assert.deepEqual(await pollLogin({ qrcode: 'qr', fetchImpl: scanned.fetchImpl }), { status: 'scanned' })
  })

  it('returns the token and bot id on success', async () => {
    const { fetchImpl, calls } = createFetchStub(() =>
      jsonResponse({ ret: 0, status: 'confirmed', bot_token: 'tok-9', ilink_bot_id: 'bot-9' }),
    )
    const result = await pollLogin({ qrcode: 'qr with space', fetchImpl })
    assert.deepEqual(result, { status: 'success', botToken: 'tok-9', botId: 'bot-9' })
    assert.match(calls[0].url, /qrcode=qr%20with%20space$/)
  })

  it('accepts the `token`/`bot_id` aliases', async () => {
    const { fetchImpl } = createFetchStub(() => jsonResponse({ ret: 0, status: 2, token: 'tok-alias', bot_id: 'bot-alias' }))
    assert.deepEqual(await pollLogin({ qrcode: 'qr', fetchImpl }), {
      status: 'success',
      botToken: 'tok-alias',
      botId: 'bot-alias',
    })
  })

  it('reports error when success carries no token', async () => {
    const { fetchImpl } = createFetchStub(() => jsonResponse({ ret: 0, status: 'confirmed' }))
    const result = await pollLogin({ qrcode: 'qr', fetchImpl })
    assert.equal(result.status, 'error')
    assert.match(result.message, /bot_token/)
  })

  it('reports expired', async () => {
    const { fetchImpl } = createFetchStub(() => jsonResponse({ ret: 0, status: 'expired' }))
    assert.deepEqual(await pollLogin({ qrcode: 'qr', fetchImpl }), { status: 'expired' })
  })

  it('treats a hanging/timeout status call as pending, not as an error', async () => {
    const { fetchImpl } = createFetchStub(() => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError')
    })
    assert.deepEqual(await pollLogin({ qrcode: 'qr', fetchImpl }), { status: 'pending' })
  })

  it('reports transport failures as status error instead of throwing', async () => {
    const { fetchImpl } = createFetchStub(() => jsonResponse('boom', { status: 500 }))
    const result = await pollLogin({ qrcode: 'qr', fetchImpl })
    assert.equal(result.status, 'error')
    assert.match(result.message, /HTTP 500/)
  })

  it('requires a qrcode', async () => {
    await assert.rejects(() => pollLogin({}), TypeError)
  })
})

// ---------------------------------------------------------------------------
// normalize.js
// ---------------------------------------------------------------------------

describe('normalize: readRawMessages', () => {
  it('prefers `msgs` over the compatibility fields', () => {
    const payload = { msgs: [{ id: 'a' }], messages: [{ id: 'b' }], msg_list: [{ id: 'c' }] }
    assert.deepEqual(readRawMessages(payload), [{ id: 'a' }])
  })

  it('reads data / messages / msg_list / updates / items / list', () => {
    assert.deepEqual(readRawMessages({ data: { msgs: [{ id: 1 }] } }), [{ id: 1 }])
    assert.deepEqual(readRawMessages({ messages: [{ id: 2 }] }), [{ id: 2 }])
    assert.deepEqual(readRawMessages({ msg_list: [{ id: 3 }] }), [{ id: 3 }])
    assert.deepEqual(readRawMessages({ updates: [{ id: 4 }] }), [{ id: 4 }])
    assert.deepEqual(readRawMessages({ items: [{ id: 5 }] }), [{ id: 5 }])
    assert.deepEqual(readRawMessages({ list: [{ id: 6 }] }), [{ id: 6 }])
  })

  it('accepts a bare array, a single record, and returns [] for junk', () => {
    assert.deepEqual(readRawMessages([{ id: 1 }, 'junk', null]), [{ id: 1 }])
    assert.deepEqual(readRawMessages({ msgs: { id: 7 } }), [{ id: 7 }])
    assert.deepEqual(readRawMessages({ ret: 0 }), [])
    assert.deepEqual(readRawMessages(undefined), [])
  })
})

describe('normalize: extractNextBuf', () => {
  it('reads every supported cursor key', () => {
    for (const key of ['get_updates_buf', 'buf', 'next_buf', 'nextBuf', 'getUpdatesBuf', 'syncKey', 'sync_buf']) {
      assert.equal(extractNextBuf({ [key]: 'cursor-x' }), 'cursor-x', `key ${key}`)
    }
  })

  it('reads the cursor from a nested data object and falls back to the top level', () => {
    assert.equal(extractNextBuf({ data: { get_updates_buf: 'inner' } }), 'inner')
    assert.equal(extractNextBuf({ data: { msgs: [] }, get_updates_buf: 'outer' }), 'outer')
  })

  it('reports undefined for an empty or missing cursor', () => {
    assert.equal(extractNextBuf({ get_updates_buf: '' }), undefined)
    assert.equal(extractNextBuf({ ret: 0, msgs: [] }), undefined)
    assert.equal(extractNextBuf(null), undefined)
  })
})

describe('normalize: echo filtering', () => {
  it('skips message_type === 2 (the bot own echo)', () => {
    const echo = {
      message_type: 2,
      from_user_id: 'bot@im.bot',
      item_list: [{ type: 1, text_item: { text: 'my own reply' } }],
    }
    assert.equal(normalizeInboundMessage(echo), null)
  })

  it('keeps message_type === 1', () => {
    const message = normalizeInboundMessage({
      message_type: 1,
      from_user_id: 'u@im.wechat',
      item_list: [{ type: 1, text_item: { text: 'hello' } }],
    })
    assert.equal(message.fromUserId, 'u@im.wechat')
    assert.equal(message.text, 'hello')
  })

  it('skips echoes nested in msg/message and empty messages', () => {
    assert.equal(normalizeInboundMessage({ msg: { message_type: 2 }, from_user_id: 'u' }), null)
    assert.equal(normalizeInboundMessage({ message_type: 1, from_user_id: 'u' }), null)
    assert.equal(normalizeInboundMessage({ message_type: 1, text: 'hi' }), null, 'no sender → skip')
    assert.equal(normalizeInboundMessage(null), null)
  })
})

describe('normalize: text extraction', () => {
  it('reads item_list[].text_item.text', () => {
    const message = normalizeInboundMessage({
      from_user_id: 'u',
      item_list: [{ type: 1, text_item: { text: 'from text_item' } }],
    })
    assert.equal(message.text, 'from text_item')
    assert.deepEqual(message.itemTypes, ['1'])
    assert.deepEqual(message.attachments, [])
  })

  it('joins multiple text items with a newline', () => {
    const message = normalizeInboundMessage({
      from_user_id: 'u',
      item_list: [
        { type: 1, text_item: { text: 'first' } },
        { type: 1, text_item: { text: 'second' } },
      ],
    })
    assert.equal(message.text, 'first\nsecond')
    assert.deepEqual(message.itemTypes, ['1', '1'])
  })

  it('falls back to item.text / item.content and to direct fields', () => {
    assert.equal(
      normalizeInboundMessage({ from_user_id: 'u', item_list: [{ text: 'item text' }] }).text,
      'item text',
    )
    assert.equal(
      normalizeInboundMessage({ from_user_id: 'u', item_list: [{ content: 'item content' }] }).text,
      'item content',
    )
    assert.equal(normalizeInboundMessage({ from_user_id: 'u', text: 'direct text' }).text, 'direct text')
    assert.equal(normalizeInboundMessage({ from_user_id: 'u', content: 'direct content' }).text, 'direct content')
  })

  it('reads item_list from a nested msg/message envelope', () => {
    const message = normalizeInboundMessage({
      from_user_id: 'u',
      msg: { item_list: [{ type: 1, text_item: { text: 'nested' } }] },
    })
    assert.equal(message.text, 'nested')
  })

  it('trims the text and drops whitespace-only messages', () => {
    assert.equal(normalizeInboundMessage({ from_user_id: 'u', text: '  padded  ' }).text, 'padded')
    assert.equal(normalizeInboundMessage({ from_user_id: 'u', text: '   ' }), null)
  })
})

describe('normalize: sender, context and ids', () => {
  it('reads the sender id through the fallback chain', () => {
    assert.equal(normalizeInboundMessage({ from_user_id: 'a', text: 'x' }).fromUserId, 'a')
    assert.equal(normalizeInboundMessage({ fromUserId: 'b', text: 'x' }).fromUserId, 'b')
    assert.equal(normalizeInboundMessage({ from: 'c', text: 'x' }).fromUserId, 'c')
    assert.equal(normalizeInboundMessage({ from: { id: 'd' }, text: 'x' }).fromUserId, 'd')
    assert.equal(normalizeInboundMessage({ sender: { wxid: 'e' }, text: 'x' }).fromUserId, 'e')
  })

  it('reads context_token from the top level or the inner envelope', () => {
    assert.equal(normalizeInboundMessage({ from_user_id: 'u', text: 'x', context_token: 'top' }).contextToken, 'top')
    assert.equal(
      normalizeInboundMessage({ from_user_id: 'u', text: 'x', msg: { context_token: 'inner' } }).contextToken,
      'inner',
    )
    assert.ok(!('contextToken' in normalizeInboundMessage({ from_user_id: 'u', text: 'x' })))
  })

  it('reads message_id in string and numeric form', () => {
    assert.equal(normalizeInboundMessage({ from_user_id: 'u', text: 'x', message_id: 1234 }).messageId, '1234')
    assert.equal(normalizeInboundMessage({ from_user_id: 'u', text: 'x', id: 'abc' }).messageId, 'abc')
  })

  it('reads chatId from room/chat/group_id only', () => {
    assert.equal(normalizeInboundMessage({ from_user_id: 'u', text: 'x', room_id: 'r1' }).chatId, 'r1')
    assert.equal(normalizeInboundMessage({ from_user_id: 'u', text: 'x', chat_id: 'c1' }).chatId, 'c1')
    assert.equal(normalizeInboundMessage({ from_user_id: 'u', text: 'x', group_id: 'g1' }).chatId, 'g1')
    assert.ok(!('chatId' in normalizeInboundMessage({ from_user_id: 'u', text: 'x', session_id: 's1' })))
  })
})

describe('normalize: attachments', () => {
  it('normalizes an image_item with a nested media payload', () => {
    const message = normalizeInboundMessage({
      from_user_id: 'u',
      item_list: [
        {
          type: 2,
          image_item: {
            media: {
              full_url: `${ILINK_CDN_BASE_URL}/download?encrypted_query_param=abc`,
              aes_key: 'MDAxMTIyMzM0NDU1NjY3Nzg4OTlhYWJiY2NkZGVlZmY=',
              mid_size: 1234,
            },
          },
        },
      ],
    })
    assert.deepEqual(message.itemTypes, ['2'])
    assert.equal(message.text, '')
    assert.deepEqual(message.attachments, [
      {
        id: `${ILINK_CDN_BASE_URL}/download?encrypted_query_param=abc`,
        kind: 'image',
        filename: 'wechat-image-1.jpg',
        mimeType: 'image/jpeg',
        downloadUrl: `${ILINK_CDN_BASE_URL}/download?encrypted_query_param=abc`,
        aesKey: 'MDAxMTIyMzM0NDU1NjY3Nzg4OTlhYWJiY2NkZGVlZmY=',
        sizeBytes: 1234,
      },
    ])
  })

  it('normalizes a file_item (encrypt_query_param id, file_name, len as string)', () => {
    const message = normalizeInboundMessage({
      from_user_id: 'u',
      item_list: [
        {
          type: 4,
          file_item: {
            media: { encrypt_query_param: 'param-1', aes_key: 'a2V5' },
            file_name: 'report.pdf',
            len: '2048',
          },
        },
      ],
    })
    assert.deepEqual(message.attachments, [
      {
        id: 'param-1',
        kind: 'file',
        filename: 'report.pdf',
        mimeType: 'application/pdf',
        aesKey: 'a2V5',
        sizeBytes: 2048,
      },
    ])
  })

  it('normalizes a voice_item as audio', () => {
    const message = normalizeInboundMessage({
      from_user_id: 'u',
      item_list: [{ type: 3, voice_item: { media: { full_url: 'https://cdn.example/v.m4a', aes_key: 'k2' } } }],
    })
    assert.equal(message.attachments[0].kind, 'audio')
    assert.equal(message.attachments[0].mimeType, 'audio/mpeg')
    assert.equal(message.attachments[0].downloadUrl, 'https://cdn.example/v.m4a')
  })

  it('does not treat text items as attachments', () => {
    const message = normalizeInboundMessage({
      from_user_id: 'u',
      item_list: [
        { type: 1, text_item: { text: 'caption' } },
        { type: 2, image_item: { media: { full_url: 'https://cdn/i.png', aes_key: 'k' } } },
      ],
    })
    assert.equal(message.text, 'caption')
    assert.equal(message.attachments.length, 1)
    assert.deepEqual(message.itemTypes, ['1', '2'])
  })

  it('keeps an attachment-only message (no text)', () => {
    const message = normalizeInboundMessage({
      from_user_id: 'u',
      item_list: [{ type: 2, image_item: { media: { full_url: 'https://cdn/i.png' } } }],
    })
    assert.equal(message.text, '')
    assert.equal(message.attachments.length, 1)
  })

  it('accepts an explicit attachments array', () => {
    const message = normalizeInboundMessage({
      from_user_id: 'u',
      text: 'see file',
      attachments: [
        {
          kind: 'file',
          id: 'f1',
          filename: 'a.txt',
          downloadUrl: 'https://cdn/a.txt',
          providerMetadata: { weixinAesKey: 'a2V5' },
        },
      ],
    })
    assert.equal(message.attachments.length, 1)
    assert.equal(message.attachments[0].aesKey, 'a2V5')
    assert.equal(message.attachments[0].mimeType, 'text/plain')
  })

  it('drops media items without any id or download url', () => {
    const message = normalizeInboundMessage({
      from_user_id: 'u',
      text: 'x',
      item_list: [{ type: 5, video_item: {} }],
    })
    assert.deepEqual(message.attachments, [])
  })
})

describe('normalize: outbound text and send body', () => {
  it('normalizes CRLF, LF and CR to CRLF', () => {
    assert.equal(normalizeOutboundText('a\nb'), 'a\r\nb')
    assert.equal(normalizeOutboundText('a\rb'), 'a\r\nb')
    assert.equal(normalizeOutboundText('a\r\nb'), 'a\r\nb')
    assert.equal(normalizeOutboundText('a\n\r\nb\rc'), 'a\r\n\r\nb\r\nc')
    assert.equal(normalizeOutboundText(undefined), '')
  })

  it('builds the sendmessage body exactly as the contract requires', () => {
    const body = buildSendBody({ toUserId: 'peer', text: 'a\nb', contextToken: 'ctx' })
    assert.deepEqual(body, {
      msg: {
        from_user_id: '',
        to_user_id: 'peer',
        client_id: body.msg.client_id,
        message_type: 2,
        message_state: 2,
        context_token: 'ctx',
        item_list: [{ type: 1, text_item: { text: 'a\r\nb' } }],
      },
    })
    assert.match(body.msg.client_id, /^dsh-wechat-[0-9a-f-]{36}$/)
  })

  it('omits context_token when absent and honours a custom client_id', () => {
    const body = buildSendBody({ toUserId: 'peer', text: 'x', clientId: 'dsh-wechat-fixed' })
    assert.ok(!('context_token' in body.msg))
    assert.equal(body.msg.client_id, 'dsh-wechat-fixed')
  })

  it('requires toUserId', () => {
    assert.throws(() => buildSendBody({ text: 'x' }), TypeError)
  })
})

describe('normalize: chunkText', () => {
  it('returns short text unchanged and [] for empty input', () => {
    assert.deepEqual(chunkText('hello', 10), ['hello'])
    assert.deepEqual(chunkText('', 10), [])
  })

  it('rejects an invalid maxLength', () => {
    assert.throws(() => chunkText('abc', 0), RangeError)
    assert.throws(() => chunkText('abc', Number.NaN), RangeError)
  })

  it('never exceeds maxLength and preserves the exact content', () => {
    const text = 'The quick brown fox jumps over the lazy dog. '.repeat(40)
    const chunks = chunkText(text, 64)
    assert.ok(chunks.length > 1)
    for (const chunk of chunks) assert.ok(chunk.length <= 64, `chunk too long: ${chunk.length}`)
    assert.equal(chunks.join(''), text)
  })

  it('prefers hard line breaks', () => {
    assert.deepEqual(chunkText('aaa\nbbb\nccc', 5), ['aaa\n', 'bbb\n', 'ccc'])
  })

  it('prefers sentence terminators when there is no line break', () => {
    assert.deepEqual(chunkText('你好。世界。再见', 4), ['你好。', '世界。', '再见'])
    assert.deepEqual(chunkText('one. two. three', 6), ['one. ', 'two. ', 'three'])
  })

  it('prefers whitespace when there is no other boundary', () => {
    const chunks = chunkText('alpha beta gamma', 8)
    assert.deepEqual(chunks, ['alpha ', 'beta ', 'gamma'])
    assert.equal(chunks.join(''), 'alpha beta gamma')
  })

  it('hard-cuts text without boundaries', () => {
    const chunks = chunkText('abcdefghij', 4)
    assert.deepEqual(chunks, ['abcd', 'efgh', 'ij'])
  })

  it('never splits a UTF-16 surrogate pair', () => {
    const emoji = '😀'.repeat(50)
    const chunks = chunkText(emoji, 5)
    assert.equal(chunks.join(''), emoji)
    for (const chunk of chunks) {
      assert.ok(chunk.length <= 5, `chunk too long: ${chunk.length}`)
      assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(chunk), 'lone high surrogate')
      assert.ok(!/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(chunk), 'lone low surrogate')
    }
  })

  it('keeps surrogate pairs intact with mixed text and boundaries', () => {
    const text = `😀😀😀\n😀😀😀😀😀\n😀 end`
    const chunks = chunkText(text, 7)
    assert.equal(chunks.join(''), text)
    for (const chunk of chunks) {
      assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(chunk))
      assert.ok(!/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(chunk))
    }
  })

  it('takes a whole code point rather than splitting when maxLength is 1', () => {
    const chunks = chunkText('😀😀', 1)
    assert.equal(chunks.join(''), '😀😀')
    for (const chunk of chunks) {
      assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(chunk))
    }
  })

  it('never splits a CRLF pair', () => {
    const text = 'abc\r\ndef'
    const chunks = chunkText(text, 4)
    assert.equal(chunks.join(''), text)
    for (const chunk of chunks) assert.ok(!chunk.endsWith('\r'), 'chunk must not end on a bare CR')
  })
})

// ---------------------------------------------------------------------------
// media.js
// ---------------------------------------------------------------------------

describe('media: parseAesKey', () => {
  const key = Buffer.from('00112233445566778899aabbccddeeff', 'hex')

  it('accepts raw 32-char hex', () => {
    assert.deepEqual(parseAesKey('00112233445566778899aabbccddeeff'), key)
  })

  it('accepts base64 of the raw 16 key bytes', () => {
    assert.deepEqual(parseAesKey(key.toString('base64')), key)
  })

  it('accepts base64 of the 32-char hex text', () => {
    assert.deepEqual(parseAesKey(Buffer.from('00112233445566778899aabbccddeeff', 'utf8').toString('base64')), key)
  })

  it('rejects unusable values', () => {
    assert.equal(parseAesKey(''), null)
    assert.equal(parseAesKey('   '), null)
    assert.equal(parseAesKey('too-short'), null)
    assert.equal(parseAesKey('zzzz'), null)
    assert.equal(parseAesKey(null), null)
    assert.equal(parseAesKey(42), null)
  })
})

describe('media: decryptCdnMedia', () => {
  /** @param {Buffer} buf @param {Buffer} key @returns {Buffer} */
  function encrypt(buf, key) {
    const cipher = createCipheriv('aes-128-ecb', key, null)
    return Buffer.concat([cipher.update(buf), cipher.final()])
  }

  it('round-trips AES-128-ECB + PKCS7 for all three key encodings', () => {
    const key = randomBytes(16)
    const plaintext = Buffer.from('iLink attachment payload 😀\r\nsecond line', 'utf8')
    const ciphertext = new Uint8Array(encrypt(plaintext, key))
    const hexKey = key.toString('hex')

    assert.deepEqual(decryptCdnMedia(ciphertext, hexKey), new Uint8Array(plaintext))
    assert.deepEqual(decryptCdnMedia(ciphertext, key.toString('base64')), new Uint8Array(plaintext))
    assert.deepEqual(decryptCdnMedia(ciphertext, Buffer.from(hexKey, 'utf8').toString('base64')), new Uint8Array(plaintext))
  })

  it('returns a plain Uint8Array and does not mutate the input', () => {
    const key = randomBytes(16)
    const plaintext = Buffer.from('payload')
    const ciphertext = new Uint8Array(encrypt(plaintext, key))
    const snapshot = Uint8Array.from(ciphertext)
    const out = decryptCdnMedia(ciphertext, key.toString('hex'))
    assert.equal(Object.getPrototypeOf(out), Uint8Array.prototype)
    assert.deepEqual(ciphertext, snapshot)
  })

  it('throws on an invalid key and on a corrupt ciphertext', () => {
    const key = randomBytes(16)
    assert.throws(() => decryptCdnMedia(new Uint8Array(16), 'not-a-key'), /AES key is invalid/)
    assert.throws(() => decryptCdnMedia(new Uint8Array(encrypt(Buffer.from('x'), key)), randomBytes(16).toString('hex')))
  })
})

describe('media: guessMimeFromFilename', () => {
  it('maps common extensions case-insensitively', () => {
    assert.equal(guessMimeFromFilename('a.png'), 'image/png')
    assert.equal(guessMimeFromFilename('a.JPG'), 'image/jpeg')
    assert.equal(guessMimeFromFilename('a.jpeg'), 'image/jpeg')
    assert.equal(guessMimeFromFilename('report.PDF'), 'application/pdf')
    assert.equal(guessMimeFromFilename('clip.mp4'), 'video/mp4')
    assert.equal(guessMimeFromFilename('voice.silk'), 'audio/silk')
  })

  it('ignores query strings and returns "" for unknown names', () => {
    assert.equal(guessMimeFromFilename('a.png?x=1'), 'image/png')
    assert.equal(guessMimeFromFilename('noextension'), '')
    assert.equal(guessMimeFromFilename('a.unknown'), '')
    assert.equal(guessMimeFromFilename(''), '')
    assert.equal(guessMimeFromFilename(undefined), '')
  })

  it('exposes the CDN origin, which is not the bot API origin', () => {
    assert.equal(ILINK_CDN_BASE_URL, 'https://novac2c.cdn.weixin.qq.com/c2c')
    assert.notEqual(ILINK_CDN_BASE_URL, DEFAULT_ILINK_BASE_URL)
  })
})

// ---------------------------------------------------------------------------
// store.js
// ---------------------------------------------------------------------------

describe('store: resolveDataDir', () => {
  const originalDshHome = process.env.DSH_HOME

  after(() => {
    if (originalDshHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = originalDshHome
  })

  it('prefers config.dataDir verbatim', () => {
    process.env.DSH_HOME = 'C:\\fake-dsh'
    assert.equal(resolveDataDir({ dataDir: 'C:\\custom\\dir' }), 'C:\\custom\\dir')
    assert.equal(resolveDataDir({ dataDir: '  C:\\trimmed  ' }), 'C:\\trimmed')
  })

  it('falls back to $DSH_HOME/wechat-ilink', () => {
    process.env.DSH_HOME = 'C:\\fake-dsh'
    assert.equal(resolveDataDir({}), path.join('C:\\fake-dsh', 'wechat-ilink'))
    assert.equal(resolveDataDir(undefined), path.join('C:\\fake-dsh', 'wechat-ilink'))
    assert.equal(resolveDataDir({ dataDir: '   ' }), path.join('C:\\fake-dsh', 'wechat-ilink'))
  })

  it('falls back to ~/.dsh/wechat-ilink without DSH_HOME', () => {
    delete process.env.DSH_HOME
    const resolved = resolveDataDir({})
    assert.match(resolved, /\.dsh[\\/]wechat-ilink$/)
    assert.equal(resolved, path.join(homedir(), '.dsh', 'wechat-ilink'))
    assert.equal(resolveDataDir(null), resolved)
  })
})

describe('store: createAccountStore', () => {
  /** @type {string} */
  let dir

  it('round-trips the account file', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'dsh-ilink-store-'))
    const store = createAccountStore({ dataDir: dir })
    assert.equal(store.path, path.join(dir, 'account.json'))
    assert.equal(await store.load(), null)

    const account = { botToken: 'tok-1', botId: 'bot-1', loginTime: 1234 }
    await store.save(account)
    assert.deepEqual(await store.load(), account)
    assert.deepEqual(JSON.parse(await readFile(store.path, 'utf8')), account)

    await store.clear()
    assert.equal(await store.load(), null)
    await rm(dir, { recursive: true, force: true })
  })

  it('round-trips cursors per key and survives concurrent writes', async () => {
    const cursorDir = await mkdtemp(path.join(tmpdir(), 'dsh-ilink-buf-'))
    const store = createAccountStore({ dataDir: cursorDir })
    assert.equal(await store.readBuf('a'), '')

    await store.writeBuf('a', 'cursor-a')
    await store.writeBuf('b', 'cursor-b')
    assert.equal(await store.readBuf('a'), 'cursor-a')
    assert.equal(await store.readBuf('b'), 'cursor-b')

    await Promise.all([store.writeBuf('c', 'cursor-c'), store.writeBuf('d', 'cursor-d')])
    assert.equal(await store.readBuf('c'), 'cursor-c')
    assert.equal(await store.readBuf('d'), 'cursor-d')
    assert.equal(await store.readBuf('unknown'), '')

    await rm(cursorDir, { recursive: true, force: true })
  })

  it('clear() also resets the cursors (a re-login must not resume a stale stream)', async () => {
    const clearDir = await mkdtemp(path.join(tmpdir(), 'dsh-ilink-clear-'))
    const store = createAccountStore({ dataDir: clearDir })
    await store.save({ botToken: 't' })
    await store.writeBuf('a', 'cursor-a')
    await store.clear()
    assert.equal(await store.load(), null)
    assert.equal(await store.readBuf('a'), '')
    await rm(clearDir, { recursive: true, force: true })
  })

  it('degrades to null/"" for a corrupt file instead of throwing', async () => {
    const corruptDir = await mkdtemp(path.join(tmpdir(), 'dsh-ilink-corrupt-'))
    const store = createAccountStore({ dataDir: corruptDir })
    await writeFile(path.join(corruptDir, 'account.json'), '{not json', 'utf8')
    await writeFile(path.join(corruptDir, 'sync-buf.json'), '[[[', 'utf8')
    assert.equal(await store.load(), null)
    assert.equal(await store.readBuf('a'), '')
    await rm(corruptDir, { recursive: true, force: true })
  })

  it('rejects a non-object account', async () => {
    const dir2 = await mkdtemp(path.join(tmpdir(), 'dsh-ilink-bad-'))
    const store = createAccountStore({ dataDir: dir2 })
    await assert.rejects(() => store.save(null), TypeError)
    await assert.rejects(() => store.save([1, 2]), TypeError)
    await rm(dir2, { recursive: true, force: true })
  })
})

// ---------------------------------------------------------------------------
// poll.js
// ---------------------------------------------------------------------------

describe('poll: computeBackoff', () => {
  it('doubles up to the ceiling', () => {
    assert.equal(computeBackoff(1, 3_000, 30_000), 3_000)
    assert.equal(computeBackoff(2, 3_000, 30_000), 6_000)
    assert.equal(computeBackoff(3, 3_000, 30_000), 12_000)
    assert.equal(computeBackoff(4, 3_000, 30_000), 24_000)
    assert.equal(computeBackoff(5, 3_000, 30_000), 30_000)
    assert.equal(computeBackoff(50, 3_000, 30_000), 30_000)
  })
})

describe('poll: startPollLoop', () => {
  it('validates its arguments', () => {
    assert.throws(() => startPollLoop({}), TypeError)
    assert.throws(() => startPollLoop({ client: { getUpdates() {} }, getBuf() {}, setBuf() {} }), TypeError)
  })

  it('yields to the event loop between iterations so a fast server cannot starve timers', async () => {
    // Regression guard: a getUpdates that resolves immediately must not keep the loop inside the
    // microtask queue forever — that starves timers/abort handling (and hung this suite once).
    let calls = 0
    let timerFired = false
    const client = {
      async getUpdates() {
        calls += 1
        return { rawMessages: [], buf: `b${calls}` }
      },
    }
    const loop = startPollLoop({
      client,
      getBuf: () => '',
      setBuf: () => {},
      onMessages: () => {},
    })
    setTimeout(() => {
      timerFired = true
    }, 0)

    // `waitFor` needs a macrotask turn: if the loop regressed to a pure microtask hot loop this
    // would time out (and, historically, hang the suite — which is the symptom being guarded).
    await waitFor(() => calls >= 2 && timerFired)
    assert.equal(timerFired, true, 'a hot loop must let timers run')

    loop.stop()
    await withTimeout(loop.done)
  })

  it('retries a long-poll timeout with exponential backoff and never exits the loop', async () => {
    const callTimes = []
    const errors = []
    const client = {
      async getUpdates() {
        callTimes.push(Date.now())
        if (callTimes.length <= 2) {
          throw new DOMException('The operation was aborted due to timeout', 'TimeoutError')
        }
        return { rawMessages: [], buf: `cursor-${callTimes.length}` }
      },
    }
    let buf = ''
    const loop = startPollLoop({
      client,
      getBuf: () => buf,
      setBuf: (value) => {
        buf = value
      },
      onMessages: () => {},
      onError: (error, phase) => errors.push([error, phase]),
      backoffMs: 20,
      maxBackoffMs: 80,
    })

    await waitFor(() => callTimes.length >= 3)
    assert.equal(errors.length, 2, 'both failures reported')
    assert.equal(errors[0][1], 'getUpdates')
    assert.equal(errors[0][0].name, 'TimeoutError')
    assert.ok(callTimes[1] - callTimes[0] >= 15, `first backoff was ${callTimes[1] - callTimes[0]}ms`)
    assert.ok(callTimes[2] - callTimes[1] >= 35, `second backoff was ${callTimes[2] - callTimes[1]}ms`)

    // The loop must still be alive after the failures.
    const before = callTimes.length
    await waitFor(() => callTimes.length > before)
    assert.equal(buf, `cursor-${callTimes.length}`)

    loop.stop()
    await withTimeout(loop.done)
  })

  it('passes the persisted cursor in and persists the new one', async () => {
    const seenBufs = []
    const client = {
      async getUpdates({ buf }) {
        seenBufs.push(buf)
        return { rawMessages: [], buf: 'next-cursor' }
      },
    }
    let stored = 'stored-cursor'
    const loop = startPollLoop({
      client,
      getBuf: () => stored,
      setBuf: (value) => {
        stored = value
      },
      onMessages: () => {},
      backoffMs: 10,
    })

    await waitFor(() => seenBufs.length >= 2)
    assert.deepEqual(seenBufs.slice(0, 2), ['stored-cursor', 'next-cursor'])
    assert.equal(stored, 'next-cursor')

    loop.stop()
    await withTimeout(loop.done)
  })

  it('delivers each non-empty batch to onMessages', async () => {
    const batches = []
    const client = {
      async getUpdates() {
        return batches.length === 0
          ? { rawMessages: [{ id: 1 }, { id: 2 }], buf: 'b1' }
          : { rawMessages: [], buf: 'b2' }
      },
    }
    const loop = startPollLoop({
      client,
      getBuf: () => '',
      setBuf: () => {},
      onMessages: (messages) => {
        batches.push(messages)
      },
      backoffMs: 10,
    })

    await waitFor(() => batches.length >= 1)
    assert.deepEqual(batches[0], [{ id: 1 }, { id: 2 }])

    loop.stop()
    await withTimeout(loop.done)
  })

  it('survives a throwing onMessages / getBuf / setBuf without exiting', async () => {
    const phases = []
    let calls = 0
    const client = {
      async getUpdates() {
        calls += 1
        return { rawMessages: [{ id: calls }], buf: `b${calls}` }
      },
    }
    const loop = startPollLoop({
      client,
      getBuf: () => {
        if (calls === 0) throw new Error('getBuf exploded')
        return ''
      },
      setBuf: () => {
        throw new Error('setBuf exploded')
      },
      onMessages: () => {
        throw new Error('onMessages exploded')
      },
      onError: (error, phase) => phases.push(phase),
      backoffMs: 10,
    })

    await waitFor(() => calls >= 3)
    assert.ok(phases.includes('getBuf'))
    assert.ok(phases.includes('setBuf'))
    assert.ok(phases.includes('onMessages'))

    loop.stop()
    await withTimeout(loop.done)
  })

  it('stop() aborts an in-flight long poll and resolves done', async () => {
    let started = false
    let aborted = false
    const client = {
      getUpdates({ signal }) {
        started = true
        return new Promise((_, reject) => {
          const onAbort = () => {
            aborted = true
            reject(new DOMException('aborted', 'AbortError'))
          }
          if (signal.aborted) onAbort()
          else signal.addEventListener('abort', onAbort, { once: true })
        })
      },
    }
    const loop = startPollLoop({
      client,
      getBuf: () => '',
      setBuf: () => {},
      onMessages: () => {},
    })

    await waitFor(() => started)
    loop.stop()
    await withTimeout(loop.done)
    assert.equal(aborted, true, 'the in-flight getUpdates must be aborted')
  })

  it('ends immediately when the external signal is aborted', async () => {
    const controller = new AbortController()
    let started = false
    const client = {
      getUpdates({ signal }) {
        started = true
        return new Promise((_, reject) => {
          const onAbort = () => reject(new DOMException('aborted', 'AbortError'))
          if (signal.aborted) onAbort()
          else signal.addEventListener('abort', onAbort, { once: true })
        })
      },
    }
    const loop = startPollLoop({
      client,
      getBuf: () => '',
      setBuf: () => {},
      onMessages: () => {},
      signal: controller.signal,
    })

    await waitFor(() => started)
    controller.abort()
    await withTimeout(loop.done)
  })

  it('does not start a new request once stopped', async () => {
    let calls = 0
    const client = {
      async getUpdates() {
        calls += 1
        return { rawMessages: [], buf: `b${calls}` }
      },
    }
    const loop = startPollLoop({
      client,
      getBuf: () => '',
      setBuf: () => {},
      onMessages: () => {},
      backoffMs: 5,
    })

    await waitFor(() => calls >= 2)
    loop.stop()
    await withTimeout(loop.done)
    const settled = calls
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.equal(calls, settled, 'no further polls after stop()')
  })
})

// ---------------------------------------------------------------------------
// Barrel integration: this only proves the surface resolves.
// ---------------------------------------------------------------------------

describe('barrel: src/ilink/index.js re-exports the frozen surface', () => {
  it('exposes every contract symbol', async () => {
    const barrel = await import('../src/ilink/index.js')
    const expected = [
      'DEFAULT_ILINK_BASE_URL',
      'ILINK_BOT_API_PREFIX',
      'CHANNEL_VERSION',
      'buildHeaders',
      'createIlinkClient',
      'beginLogin',
      'pollLogin',
      'normalizeQrStatus',
      'readRawMessages',
      'extractNextBuf',
      'normalizeInboundMessage',
      'buildSendBody',
      'normalizeOutboundText',
      'chunkText',
      'parseAesKey',
      'decryptCdnMedia',
      'guessMimeFromFilename',
      'resolveDataDir',
      'createAccountStore',
      'startPollLoop',
    ]
    for (const name of expected) {
      assert.ok(name in barrel, `barrel is missing ${name}`)
    }
  })
})
