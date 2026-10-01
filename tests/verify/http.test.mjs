/**
 * Verifier-owned HTTP round-trip suite (round 2).
 *
 * Round 1 left "a real socket" unverified: the A/B suites drive the handler with
 * fake `req`/`res` objects. Everything here goes through a real `node:http`
 * server and a real `fetch`, so status codes, headers, body framing, streaming
 * limits and the cross-site guard are exercised end to end.
 *
 * The security assertion that matters: **no response ever contains the bot
 * token**, checked with the exact credential string the fake service holds.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

import { createWebApi, MAX_BODY_BYTES, WEB_API_PREFIX } from '../../src/web/routes.js'
import { mountWebApi } from '../../src/web/index.js'

/** A distinctive credential: if it appears anywhere in a response, the test fails. */
const TOKEN = 'SECRET-BOT-TOKEN-9f3c1a77e2b4d5e6'

/**
 * Start a real HTTP server that delegates the plugin prefix to the API handler.
 *
 * @param {object} api - the `createWebApi()` handle.
 * @param {(base: string) => Promise<any>} fn - body receiving the base URL.
 * @returns {Promise<any>} whatever `fn` returned.
 */
async function withServer(api, fn) {
  const server = http.createServer((req, res) => {
    if (!String(req.url).startsWith(WEB_API_PREFIX)) {
      res.statusCode = 404
      res.end('outside the plugin prefix')
      return
    }
    void api.handler(req, res)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  try {
    return await fn(`http://127.0.0.1:${port}${WEB_API_PREFIX}`)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

/** Build a fake channel service that is bound and healthy. */
function fakeService(overrides = {}) {
  return {
    token: TOKEN,
    account: { botToken: TOKEN, botId: 'bot-123' },
    accountId: 'bot-123',
    dataDirectory: 'C:/tmp/ilink-verify-http',
    connected: true,
    polling: true,
    config: { baseUrl: 'https://ilinkai.weixin.qq.com' },
    getStatus() {
      return { accountId: 'bot-123', connected: true, hasToken: true, dataDirectory: 'C:/tmp/ilink-verify-http' }
    },
    async stop() {},
    async sendText() {
      return {}
    },
    ...overrides,
  }
}

/** Build the API + a store spy over a controllable clock. */
function buildApi({ service = fakeService(), stored = null, poll = { status: 'pending' } } = {}) {
  const state = {
    clock: 1_700_000_000_000,
    saved: null,
    cleared: false,
    stopped: 0,
  }
  const store = {
    async load() {
      return state.saved ?? stored
    },
    async save(account) {
      state.saved = account
    },
    async clear() {
      state.cleared = true
      state.saved = null
    },
  }
  const api = createWebApi({
    config: {},
    log: () => {},
    getService: () => service,
    deps: {
      now: () => state.clock,
      intervalMs: 1000,
      beginLogin: async () => ({
        qrcode: 'QR-ABC',
        qrUrl: 'https://liteapp.weixin.qq.com/q/7GiQu1?qrcode=QR-ABC&bot_type=3',
        expiresAt: state.clock + 120_000,
      }),
      pollLogin: async () => poll,
      storeFactory: () => store,
    },
  })
  return { api, state }
}

test('socket: GET /status answers real HTTP with a bound snapshot and no token', async () => {
  const { api } = buildApi()
  await withServer(api, async (base) => {
    const response = await fetch(`${base}/status`)
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type'), /application\/json/)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    const body = await response.json()
    assert.equal(body.bound, true)
    assert.equal(body.accountId, 'bot-123')
    assert.equal(body.connected, true)
    assert.equal(body.polling, true)
    assert.equal(body.lastError, null)
    assert.equal(JSON.stringify(body).includes(TOKEN), false, 'the token leaked into /status')
  })
})

test('socket: /status falls back to the stored account when the channel has none', async () => {
  const { api } = buildApi({
    service: fakeService({ token: '', account: undefined, getStatus: () => ({ accountId: 'default', connected: false, hasToken: false }) }),
    stored: { accountId: 'bot-777', botToken: TOKEN, botId: 'bot-777' },
  })
  await withServer(api, async (base) => {
    const body = await (await fetch(`${base}/status`)).json()
    assert.equal(body.bound, true, 'a stored credential still counts as bound')
    assert.equal(body.botId, 'bot-777')
    assert.equal(body.accountId, 'bot-777', 'the placeholder `default` must be replaced by the stored id')
    assert.equal(JSON.stringify(body).includes(TOKEN), false)
  })
})

test('socket: POST /login/begin returns a QR + an image URL the browser can fetch', async () => {
  const { api } = buildApi()
  await withServer(api, async (base) => {
    const response = await fetch(`${base}/login/begin`, { method: 'POST' })
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.qrcode, 'QR-ABC')
    assert.match(body.qrUrl, /^https:\/\/liteapp\.weixin\.qq\.com\//)
    assert.equal(body.qrImageUrl, `${WEB_API_PREFIX}/qr.svg?qrcode=QR-ABC`)
    assert.equal(body.intervalMs, 1000)
    // The fake clock is fixed, so the expiry is exact: issued + 120 s TTL.
    assert.equal(body.expiresAt, 1_700_000_000_000 + 120_000)

    // The advertised image URL must really answer with an SVG.
    const image = await fetch(`http://${new URL(base).host}${body.qrImageUrl}`)
    assert.equal(image.status, 200)
    assert.match(image.headers.get('content-type'), /image\/svg\+xml/)
    const svg = await image.text()
    assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/)
    assert.match(svg, /data-qr-version="\d+"/)
    assert.match(svg, /fill="#ffffff"/)
    assert.equal(svg.includes(TOKEN), false)
  })
})

test('socket: GET /login/poll covers pending, unknown, missing and expired', async () => {
  const { api, state } = buildApi()
  await withServer(api, async (base) => {
    assert.equal((await fetch(`${base}/login/poll`)).status, 400, 'a missing qrcode is a 400')

    const unknown = await (await fetch(`${base}/login/poll?qrcode=NOPE`)).json()
    assert.equal(unknown.status, 'error')

    await fetch(`${base}/login/begin`, { method: 'POST' })
    const pending = await (await fetch(`${base}/login/poll?qrcode=QR-ABC`)).json()
    assert.equal(pending.status, 'pending')
    assert.equal(JSON.stringify(pending).includes(TOKEN), false)

    // Move past the QR lifetime: the host must stop polling the service.
    state.clock += 130_000
    const expired = await (await fetch(`${base}/login/poll?qrcode=QR-ABC`)).json()
    assert.equal(expired.status, 'expired')
  })
})

test('socket: a successful poll persists the credential and never echoes it', async () => {
  const { api, state } = buildApi({ poll: { status: 'success', botToken: TOKEN, botId: 'bot-999' } })
  await withServer(api, async (base) => {
    await fetch(`${base}/login/begin`, { method: 'POST' })
    const response = await fetch(`${base}/login/poll?qrcode=QR-ABC`)
    const text = await response.text()
    assert.equal(response.status, 200)
    assert.equal(text.includes(TOKEN), false, 'the login response leaked the bot token')
    const body = JSON.parse(text)
    assert.equal(body.status, 'success')
    assert.equal(body.botId, 'bot-999')
    assert.equal(state.saved?.botToken, TOKEN, 'the credential must be persisted')
    assert.equal(state.saved?.accountId, 'bot-999')

    // And the QR is single-use: polling it again reports an unregistered QR.
    const again = await (await fetch(`${base}/login/poll?qrcode=QR-ABC`)).json()
    assert.equal(again.status, 'error')
  })
})

test('socket: 404 / 405 / 400 / 413 / cross-site 403', async () => {
  const { api } = buildApi()
  await withServer(api, async (base) => {
    assert.equal((await fetch(`${base}/nope`)).status, 404)
    assert.equal((await fetch(`${base}/`)).status, 404, 'the bare prefix is not an endpoint')

    const wrongMethod = await fetch(`${base}/login/begin`)
    assert.equal(wrongMethod.status, 405)
    assert.equal(wrongMethod.headers.get('allow'), 'POST')

    const wrongMethod2 = await fetch(`${base}/status`, { method: 'POST' })
    assert.equal(wrongMethod2.status, 405)
    assert.equal(wrongMethod2.headers.get('allow'), 'GET')

    const badJson = await fetch(`${base}/bind`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not json',
    })
    assert.equal(badJson.status, 400)

    const emptyBind = await fetch(`${base}/bind`, { method: 'POST', body: '{}' })
    assert.equal(emptyBind.status, 400, 'neither workspace nor sessionId is a 400')

    const oversized = await fetch(`${base}/bind`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspace: 'x'.repeat(MAX_BODY_BYTES + 1024) }),
    }).catch((error) => error)
    // Node may reset the socket while the client is still writing the oversized
    // body; both a 413 response and a reset prove the limit fired.
    if (oversized instanceof Error) {
      assert.match(String(oversized.message), /fetch failed|reset|aborted/iu)
    } else {
      assert.equal(oversized.status, 413)
      assert.equal(JSON.stringify(await oversized.json()).includes(TOKEN), false)
    }

    const crossSite = await fetch(`${base}/status`, { headers: { 'Sec-Fetch-Site': 'cross-site' } })
    assert.equal(crossSite.status, 403)

    const crossOrigin = await fetch(`${base}/status`, { headers: { Origin: 'http://evil.example' } })
    assert.equal(crossOrigin.status, 403)

    const sameOrigin = await fetch(`${base}/status`, { headers: { Origin: base } })
    assert.equal(sameOrigin.status, 200, 'a same-origin Origin header must be allowed')
  })
})

test('socket: no endpoint ever returns the bot token (full sweep)', async () => {
  const { api } = buildApi({ poll: { status: 'success', botToken: TOKEN, botId: 'bot-999' } })
  await withServer(api, async (base) => {
    await fetch(`${base}/login/begin`, { method: 'POST' })
    const targets = [
      ['GET', `${base}/status`],
      ['GET', `${base}/login/poll?qrcode=QR-ABC`],
      ['GET', `${base}/qr.svg?qrcode=QR-ABC`],
      ['GET', `${base}/workspaces`],
      ['GET', `${base}/sessions`],
      ['POST', `${base}/logout`],
      ['GET', `${base}/nope`],
      ['GET', `${base}/login/poll`],
      ['POST', `${base}/bind`],
    ]
    for (const [method, url] of targets) {
      const response = await fetch(url, { method, ...(method === 'POST' ? { body: '{}' } : {}) })
      const text = await response.text()
      assert.equal(text.includes(TOKEN), false, `${method} ${url} leaked the token`)
      assert.equal(text.toLowerCase().includes('bearer'), false, `${method} ${url} leaked an auth header shape`)
    }
  })
})

test('socket: dispose() turns every endpoint into 503', async () => {
  const { api } = buildApi()
  await withServer(api, async (base) => {
    assert.equal((await fetch(`${base}/status`)).status, 200)
    api.dispose()
    const after = await fetch(`${base}/status`)
    assert.equal(after.status, 503)
  })
})

test('mount: a missing webServer degrades instead of failing the plugin load', () => {
  const ctx = {
    get: () => undefined,
    on: () => () => {},
    emit: () => {},
    logger: { info() {}, warn() {}, error() {} },
  }
  const dispose = mountWebApi(ctx, { config: {}, log: () => {} })
  assert.equal(typeof dispose, 'function', 'mountWebApi must always return a disposer')
  dispose()
})

test('mount: the route registers on a webServer and unregisters on dispose', () => {
  const registered = []
  const unregistered = []
  const webServer = {
    register(options) {
      registered.push(options)
      return () => unregistered.push(options.path)
    },
  }
  const ctx = {
    get: (name) => (name === 'webServer' ? webServer : undefined),
    on: () => () => {},
    emit: () => {},
    effect: (fn) => fn(),
    logger: { info() {}, warn() {}, error() {} },
  }
  const dispose = mountWebApi(ctx, { config: {}, log: () => {} })
  assert.equal(registered.length, 1, 'exactly one route registration')
  assert.equal(registered[0].kind, 'prefix')
  assert.equal(registered[0].path, WEB_API_PREFIX)
  assert.equal(typeof registered[0].handler, 'function')
  dispose()
  assert.deepEqual(unregistered, [WEB_API_PREFIX], 'dispose must unregister the route')
})

test('mount: conditional injection is preferred when the context offers it', () => {
  const injected = []
  const registered = []
  const ctx = {
    inject(deps, callback) {
      injected.push(deps)
      callback({ get: () => ({ register: (options) => (registered.push(options), () => {}) }) })
    },
    get: () => undefined,
    on: () => () => {},
    emit: () => {},
    logger: { info() {}, warn() {}, error() {} },
  }
  const dispose = mountWebApi(ctx, { config: {}, log: () => {} })
  assert.deepEqual(injected, [['webServer']])
  assert.equal(registered.length, 1)
  dispose()
})
