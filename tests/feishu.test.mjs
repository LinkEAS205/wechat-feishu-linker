/**
 * Feishu Open Platform client tests.
 *
 * The client is plain `fetch`, so every case here runs against a stub with no
 * network, no SDK and no Feishu tenant.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  FEISHU_HOSTS,
  FeishuApiError,
  createFeishuClient,
  receiveIdTypeOf,
} from '../src/feishu/client.js'

import {
  FEISHU_CHANNEL,
  chatTypeOf,
  normalizeInbound,
  postText,
  stripMentions,
} from '../src/feishu/normalize.js'
import { FeishuChannel, withDefaults } from '../src/service-feishu.js'
import { beginRegistration, pollRegistration } from '../src/feishu/registration.js'

/**
 * A `im.message.receive_v1` payload shaped the way Feishu sends it.
 *
 * @param {object} [over] - overrides for `message` fields.
 * @returns {object} the payload.
 */
const inboundEvent = (over = {}) => ({
  header: { event_type: 'im.message.receive_v1', event_id: 'ev-1' },
  event: {
    sender: { sender_id: { open_id: 'ou_alice' }, sender_type: 'user' },
    message: {
      message_id: 'om_1',
      chat_id: 'oc_group',
      chat_type: 'p2p',
      message_type: 'text',
      create_time: '1759300000000',
      content: JSON.stringify({ text: '你好' }),
      ...over,
    },
  },
})

describe('feishu normalize: text', () => {
  it('turns a plain text message into the bridge shape', () => {
    const message = normalizeInbound(inboundEvent())
    assert.equal(message.channel, FEISHU_CHANNEL)
    assert.equal(message.fromUserId, 'ou_alice')
    assert.equal(message.senderId, 'ou_alice')
    assert.equal(message.text, '你好')
    assert.equal(message.contextToken, 'om_1', 'the reaction needs the contact message id')
    assert.equal(message.createdAt, 1759300000000)
    assert.equal(message.groupId, undefined, 'a direct chat is not a group')
  })

  it('[REGRESSION] a payload the SDK flattened still parses', () => {
    // EventDispatcher has been seen handing the event's fields to the top level
    // instead of under `event`. Reading only `payload.event.message` parses every
    // real message into nothing, which the contact experiences as being ignored.
    const nested = inboundEvent()
    const flattened = { header: nested.header, ...nested.event }
    const message = normalizeInbound(flattened)
    assert.ok(message, 'a flattened payload must still be recognised')
    assert.equal(message.text, '你好')
    assert.equal(message.fromUserId, 'ou_alice')
  })

  it('[REGRESSION] a rich-text message is read instead of dropped as empty', () => {
    // A message that looks like ordinary text in the Feishu client arrives as
    // message_type=post. Reading only content.text yields "" and an empty body
    // is discarded — so the message vanishes with no error anywhere.
    const post = {
      zh_cn: {
        title: '标题',
        content: [
          [{ tag: 'text', text: '看这个 ' }, { tag: 'a', href: 'https://example.com', text: '链接' }],
          [{ tag: 'text', text: '第二行' }],
        ],
      },
    }
    const message = normalizeInbound(inboundEvent({ message_type: 'post', content: JSON.stringify(post) }))
    assert.ok(message, 'a post message must not be dropped')
    assert.match(message.text, /标题/)
    assert.match(message.text, /看这个/)
    assert.match(message.text, /https:\/\/example\.com/, 'a link keeps its target')
    assert.match(message.text, /第二行/)
  })
})

describe('feishu normalize: mentions', () => {
  it('removes a mention but keeps an address the contact typed', () => {
    assert.equal(stripMentions('@_user_1 帮我看下'), '帮我看下')
    assert.equal(stripMentions('<at id="ou_bot"></at> 你好'), '你好')
    // The reference implementation strips every `@word`, which eats this.
    assert.equal(stripMentions('发到 alice@example.com'), '发到 alice@example.com')
  })

  it('drops the mention-only message a group sends when someone taps the bot', () => {
    const message = normalizeInbound(inboundEvent({ chat_type: 'group', content: JSON.stringify({ text: '@_user_1' }) }))
    assert.equal(message, null, 'there is nothing to act on')
  })
})

describe('feishu normalize: conversations', () => {
  it('replies to the chat in a group and to the person in a direct chat', () => {
    const group = normalizeInbound(inboundEvent({ chat_type: 'group' }))
    assert.equal(group.fromUserId, 'oc_group', 'a group reply goes to the chat')
    assert.equal(group.senderId, 'ou_alice', 'but we still know who spoke')
    assert.equal(group.groupId, 'oc_group')

    const direct = normalizeInbound(inboundEvent({ chat_type: 'p2p' }))
    assert.equal(direct.fromUserId, 'ou_alice')
    assert.equal(direct.groupId, undefined)
  })

  it('treats group_chat as a group', () => {
    assert.equal(chatTypeOf('group_chat'), 'group')
    assert.equal(chatTypeOf('group'), 'group')
    assert.equal(chatTypeOf('p2p'), 'private')
    assert.equal(chatTypeOf(''), 'private')
  })
})

describe('feishu normalize: what to ignore', () => {
  it('ignores the bot talking to itself', () => {
    // Bot messages arrive on the same event type; mirroring them makes the
    // channel answer its own replies forever.
    const message = normalizeInbound(inboundEvent(), { botOpenId: 'ou_alice' })
    assert.equal(message, null)
  })

  it('ignores a payload with no sender, no message, or no text', () => {
    assert.equal(normalizeInbound(null), null)
    assert.equal(normalizeInbound({}), null)
    assert.equal(normalizeInbound({ event: { message: { message_id: 'om_1' } } }), null)
    const noText = inboundEvent({ content: JSON.stringify({}) })
    assert.equal(normalizeInbound(noText), null)
  })

  it('survives content that is not valid JSON', () => {
    const message = normalizeInbound(inboundEvent({ content: 'not json' }))
    assert.equal(message, null, 'unparseable content is not a crash')
  })
})

describe('feishu normalize: post extraction', () => {
  it('returns an empty string for an absent body', () => {
    assert.equal(postText(null), '')
    assert.equal(postText({}), '')
  })
})

describe('feishu service: binding', () => {
  /** A channel with an in-memory store and a socket that never really opens. */
  const createService = (over = {}) => {
    const saved = []
    let cleared = false
    const sockets = []
    const service = new FeishuChannel({
      ctx: {},
      config: withDefaults(over.config),
      log: over.log,
      deps: {
        store: () => ({
          path: 'C:/tmp/feishu.json',
          load: async () => over.stored ?? null,
          save: async (value) => saved.push(value),
          clear: async () => {
            cleared = true
          },
        }),
        startSocket: async (options) => {
          sockets.push(options)
          if (over.socketFails) throw new Error('socket refused')
          return { close: () => {}, terminated: new Promise(() => {}) }
        },
      },
    })
    return { service, saved, sockets, wasCleared: () => cleared }
  }

  it('refuses a malformed app id without touching the working binding', async () => {
    // Validation runs before anything is torn down: a rejected form must not
    // take down a channel that is currently fine.
    const { service, saved, sockets } = createService()
    const result = await service.bind({ appId: 'nope', appSecret: 'sec' })
    assert.equal(result.ok, false)
    assert.match(result.message, /cli_/)
    assert.equal(saved.length, 0)
    assert.equal(sockets.length, 0)
  })

  it('refuses an empty app secret', async () => {
    const { service } = createService()
    const result = await service.bind({ appId: 'cli_0123456789abcdef', appSecret: '   ' })
    assert.equal(result.ok, false)
    assert.match(result.message, /App Secret/)
  })

  it('saves the credentials and opens the connection', async () => {
    const { service, saved, sockets } = createService()
    const result = await service.bind({ appId: 'cli_0123456789abcdef', appSecret: 'sec', domain: 'lark' })
    assert.equal(result.ok, true)
    assert.deepEqual(saved, [{ appId: 'cli_0123456789abcdef', appSecret: 'sec', domain: 'lark' }])
    assert.equal(sockets.length, 1)
    assert.equal(sockets[0].domain, 'lark')
    assert.equal(service.connected, true)
    assert.equal(service.accountId, 'cli_0123456789abcdef')
  })

  it('reports a failed connection instead of pretending to be healthy', async () => {
    const { service } = createService({ socketFails: true })
    const result = await service.bind({ appId: 'cli_0123456789abcdef', appSecret: 'sec' })
    assert.equal(result.ok, true, 'the credentials were accepted')
    const status = service.getStatus()
    assert.equal(status.connected, false)
    assert.equal(status.connectionState, 'failed')
    assert.match(status.lastError, /socket refused/)
  })

  it('starts unbound with no credentials, and says so', async () => {
    const { service } = createService()
    await service.start()
    const status = service.getStatus()
    assert.equal(status.bound, false)
    assert.equal(status.connectionState, 'unbound')
    assert.equal(status.domain, 'feishu')
  })

  it('unbinding clears the stored credentials', async () => {
    const { service, wasCleared } = createService({ stored: { appId: 'cli_0123456789abcdef', appSecret: 's' } })
    await service.start()
    await service.logout()
    assert.equal(wasCleared(), true)
    assert.equal(service.accountId, '')
  })
})

describe('feishu service: ingest', () => {
  const createService = (over = {}) => {
    const logs = []
    const seen = []
    const service = new FeishuChannel({
      ctx: {},
      config: withDefaults(over.config),
      log: (level, message) => logs.push({ level, message }),
      deps: { store: () => ({ path: 'C:/tmp/feishu.json', load: async () => null, save: async () => {}, clear: async () => {} }) },
    })
    service.onMessage((message) => seen.push(message))
    return { service, seen, logs }
  }

  it('hands a normalized message to the bridge', () => {
    const { service, seen } = createService()
    service.ingest(inboundEvent())
    assert.equal(seen.length, 1)
    assert.equal(seen[0].text, '你好')
    assert.equal(seen[0].channel, 'feishu')
  })

  it('logs rather than silently dropping an unusable event', () => {
    // "I sent a message and the bot ignored me" is the symptom this line exists
    // to make traceable, so the drop has to be visible somewhere.
    const { service, seen, logs } = createService()
    service.ingest({ event: { message: { message_id: 'om_1' } } })
    assert.equal(seen.length, 0)
    assert.ok(logs.some((entry) => /ignored an inbound event/.test(entry.message)))
  })

  it('[REGRESSION] hands a message to the bridge by emitting the event it listens on', () => {
    // The bridge subscribes to `wechat-ilink/message`. Calling a local handler
    // instead is how this channel swallowed every message: `this.handler` was a
    // callback nobody had registered, so the message went into a void — no
    // error, no log, no reply, and a perfectly healthy-looking status.
    const emitted = []
    const service = new FeishuChannel({
      ctx: { emit: (name, message) => emitted.push({ name, message }) },
      config: withDefaults(),
      deps: {
        store: () => ({ path: 'C:/tmp/feishu.json', load: async () => null, save: async () => {}, clear: async () => {} }),
      },
    })
    service.ingest(inboundEvent())

    assert.equal(emitted.length, 1, 'exactly one hand-off per message')
    assert.equal(emitted[0].name, 'wechat-ilink/message')
    assert.equal(emitted[0].message.text, '你好')
    assert.equal(emitted[0].message.channel, 'feishu', 'the bridge routes by this')
  })

  it('survives a handler that throws', () => {
    const logs = []
    const service = new FeishuChannel({
      ctx: {},
      config: withDefaults(),
      log: (level, message) => logs.push({ level, message }),
      deps: { store: () => ({ path: 'C:/tmp/feishu.json', load: async () => null, save: async () => {}, clear: async () => {} }) },
    })
    service.onMessage(() => {
      throw new Error('handler exploded')
    })
    assert.doesNotThrow(() => service.ingest(inboundEvent()))
    assert.ok(logs.some((entry) => /inbound handler failed/.test(entry.message)))
  })
})

describe('feishu service: outbound', () => {
  it('refuses to send before the channel is connected', async () => {
    const service = new FeishuChannel({
      ctx: {},
      config: withDefaults(),
      deps: { store: () => ({ path: 'C:/tmp/feishu.json', load: async () => null, save: async () => {}, clear: async () => {} }) },
    })
    await assert.rejects(() => service.sendText('ou_peer', 'hi'), /not connected/)
  })

  it('[REGRESSION] answers the contact message rather than pushing a new one', async () => {
    // Feishu refuses a fresh push with `230101 Sending messages to users is
    // temporarily unavailable` even for an app that is published and enabled,
    // while a reply to a message the bot received is always allowed. Pushing was
    // the only path, so every reply was refused and the contact saw silence.
    const calls = []
    const service = new FeishuChannel({ ctx: {}, config: withDefaults(), deps: { store: () => ({}) } })
    service.client = {
      sendText: async (id, body) => {
        calls.push(['send', id, body])
        return { messageId: 'om_new' }
      },
      replyText: async (id, body) => {
        calls.push(['reply', id, body])
        return { messageId: 'om_reply' }
      },
    }

    const answered = await service.sendText('ou_a', 'hi', { contextToken: 'om_in' })
    assert.deepEqual(calls[0], ['reply', 'om_in', 'hi'], 'the inbound message id is what makes this a reply')
    assert.deepEqual(answered.messageIds, ['om_reply'])

    calls.length = 0
    await service.sendText('ou_a', 'hi')
    assert.deepEqual(calls[0], ['send', 'ou_a', 'hi'], 'with no message to answer, a fresh push is the only option')
  })

  it('delegates typing to the client, and retracts it', async () => {
    const calls = []
    const service = new FeishuChannel({ ctx: {}, config: withDefaults(), deps: { store: () => ({}) } })
    service.client = {
      addTypingReaction: async (id) => {
        calls.push(['add', id])
        return true
      },
      removeTypingReaction: async (id) => {
        calls.push(['remove', id])
        return true
      },
    }
    assert.equal(await service.sendTyping('ou_peer', 'om_1'), true)
    assert.equal(await service.clearTyping('ou_peer', 'om_1'), true)
    assert.deepEqual(calls, [
      ['add', 'om_1'],
      ['remove', 'om_1'],
    ])
  })

  it('reports a typing failure instead of throwing into the relay', async () => {
    const service = new FeishuChannel({ ctx: {}, config: withDefaults(), deps: { store: () => ({}) } })
    service.client = {
      addTypingReaction: async () => {
        throw new Error('reaction refused')
      },
      removeTypingReaction: async () => {
        throw new Error('removal refused')
      },
    }
    assert.equal(await service.sendTyping('ou_peer', 'om_1'), false)
    assert.equal(await service.clearTyping('ou_peer', 'om_1'), false)
  })
})

describe('feishu registration: begin', () => {
  const registrationStub = (handler) => {
    const calls = []
    const fetchImpl = async (url, init = {}) => {
      const call = { url: String(url), body: Object.fromEntries(new URLSearchParams(init.body ?? '')) }
      calls.push(call)
      return {
        ok: true,
        status: 200,
        async json() {
          return handler(call)
        },
      }
    }
    return { fetchImpl, calls }
  }
  const okInit = (call) =>
    call.body.action === 'init'
      ? { supported_auth_methods: ['client_secret'] }
      : {
          device_code: 'dc-1',
          verification_uri_complete: 'https://accounts.feishu.cn/qr?code=abc',
          user_code: 'ABCD',
          interval: 5,
          expire_in: 600,
        }

  it('always begins at the Feishu issuer, even when the user asked for Lark', async () => {
    // The QR is minted by the Feishu issuer; a Lark tenant is only discovered
    // during poll. Beginning at the Lark host fails for the other tenant kind.
    const { fetchImpl, calls } = registrationStub(okInit)
    const begun = await beginRegistration({ domain: 'lark', fetchImpl })
    assert.ok(calls.every((call) => call.url.startsWith('https://accounts.feishu.cn')))
    assert.equal(begun.domain, 'lark', 'the requested brand is remembered')
    assert.equal(begun.pollDomain, 'feishu', 'but polling starts at the Feishu host')
  })

  it('returns a QR url the platform can attribute to this client', async () => {
    const { fetchImpl } = registrationStub(okInit)
    const begun = await beginRegistration({ fetchImpl })
    const url = new URL(begun.qrUrl)
    assert.equal(url.searchParams.get('code'), 'abc', 'the original query is preserved')
    assert.equal(url.searchParams.get('from'), 'sdk')
    assert.equal(url.searchParams.get('tp'), 'sdk')
    assert.ok(url.searchParams.get('source'))
    assert.equal(begun.deviceCode, 'dc-1')
    assert.equal(begun.interval, 5000, 'the platform cadence is converted to ms')
    assert.ok(begun.expiresAt > Date.now())
  })

  it('refuses clearly when the environment cannot create apps', async () => {
    const { fetchImpl } = registrationStub(() => ({ supported_auth_methods: ['something_else'] }))
    await assert.rejects(() => beginRegistration({ fetchImpl }), /不支持一键创建应用/)
  })

  it('refuses when no device code comes back', async () => {
    const { fetchImpl } = registrationStub((call) =>
      call.body.action === 'init' ? { supported_auth_methods: ['client_secret'] } : {},
    )
    await assert.rejects(() => beginRegistration({ fetchImpl }), /没有返回设备码/)
  })
})

describe('feishu registration: poll', () => {
  const pollStub = (payload) => {
    const calls = []
    const fetchImpl = async (url, init = {}) => {
      calls.push({ url: String(url), body: Object.fromEntries(new URLSearchParams(init.body ?? '')) })
      return {
        ok: true,
        status: 200,
        async json() {
          return payload
        },
      }
    }
    return { fetchImpl, calls }
  }

  it('returns the credentials the platform minted', async () => {
    const { fetchImpl } = pollStub({
      client_id: 'cli_0123456789abcdef',
      client_secret: 'sec-1',
      app_name: '我的助手',
      user_info: { open_id: 'ou_me', tenant_brand: 'feishu' },
    })
    const result = await pollRegistration({ deviceCode: 'dc-1', fetchImpl })
    assert.equal(result.status, 'success')
    assert.equal(result.appId, 'cli_0123456789abcdef')
    assert.equal(result.appSecret, 'sec-1')
    assert.equal(result.appName, '我的助手')
    assert.equal(result.openId, 'ou_me')
  })

  it('[REGRESSION] a Lark tenant switches the polling host instead of failing', async () => {
    // The brand only becomes visible during poll. Believing the Feishu host's
    // answer for a Lark tenant, or giving up here, both lose a scan the user has
    // already completed.
    const { fetchImpl } = pollStub({ user_info: { tenant_brand: 'lark' } })
    const result = await pollRegistration({ deviceCode: 'dc-1', domain: 'feishu', pollDomain: 'feishu', fetchImpl })
    assert.equal(result.status, 'pending')
    assert.equal(result.domain, 'lark')
    assert.equal(result.pollDomain, 'lark')
  })

  it('[REGRESSION] slow_down means poll later, not fail', async () => {
    // It is the platform asking us to back off. Treating it as an error aborts a
    // registration that is proceeding normally.
    const { fetchImpl } = pollStub({ error: 'slow_down' })
    const result = await pollRegistration({ deviceCode: 'dc-1', fetchImpl })
    assert.equal(result.status, 'pending')
    assert.equal(result.interval, 10_000)
  })

  it('treats an empty answer and authorization_pending alike', async () => {
    for (const payload of [{}, { error: 'authorization_pending' }]) {
      const { fetchImpl } = pollStub(payload)
      const result = await pollRegistration({ deviceCode: 'dc-1', fetchImpl })
      assert.equal(result.status, 'pending')
    }
  })

  it('reports a refusal and an expiry as their own outcomes', async () => {
    const denied = pollStub({ error: 'access_denied' })
    assert.equal((await pollRegistration({ deviceCode: 'dc-1', fetchImpl: denied.fetchImpl })).status, 'access_denied')

    const expired = pollStub({ error: 'expired_token' })
    assert.equal((await pollRegistration({ deviceCode: 'dc-1', fetchImpl: expired.fetchImpl })).status, 'expired')
  })

  it('carries an unknown error through with its description', async () => {
    const { fetchImpl } = pollStub({ error: 'invalid_request', error_description: 'bad device code' })
    const result = await pollRegistration({ deviceCode: 'dc-1', fetchImpl })
    assert.equal(result.status, 'error')
    assert.match(result.message, /invalid_request: bad device code/)
  })

  it('sends the poll as a form-encoded action', async () => {
    const { fetchImpl, calls } = pollStub({ error: 'authorization_pending' })
    await pollRegistration({ deviceCode: 'dc-9', fetchImpl })
    assert.equal(calls[0].body.action, 'poll')
    assert.equal(calls[0].body.device_code, 'dc-9')
  })
})

describe('feishu service: config', () => {
  it('falls back to feishu for an unknown domain', () => {
    assert.equal(withDefaults({ domain: 'nonsense' }).domain, 'feishu')
    assert.equal(withDefaults({ domain: 'lark' }).domain, 'lark')
    assert.equal(withDefaults().domain, 'feishu')
  })
})

/**
 * A fetch stub that answers each call from a scripted handler.
 *
 * @param {(call: { url: string, method: string, headers: object, body: any }) => object} handler - per-call response.
 * @returns {{ fetchImpl: Function, calls: object[] }} the stub and what it saw.
 */
function createFetchStub(handler) {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    const call = {
      url: String(url),
      method: init.method ?? 'GET',
      headers: init.headers ?? {},
      body: init.body ? JSON.parse(init.body) : undefined,
    }
    calls.push(call)
    const scripted = handler(call) ?? {}
    const status = scripted.status ?? 200
    const payload = scripted.payload ?? { code: 0 }
    return {
      ok: status >= 200 && status < 300,
      status,
      async json() {
        if (scripted.raw !== undefined) return scripted.raw
        return payload
      },
    }
  }
  return { fetchImpl, calls }
}

/** Answers the token call, then delegates everything else. */
const withToken = (rest) => (call) =>
  call.url.includes('/tenant_access_token/') ? { payload: { code: 0, tenant_access_token: 'tok-1' } } : rest(call)

describe('feishu client: receive id type', () => {
  it('treats an oc_ id as a group chat and anything else as a person', () => {
    assert.equal(receiveIdTypeOf('oc_abc123'), 'chat_id')
    assert.equal(receiveIdTypeOf('ou_abc123'), 'open_id')
    assert.equal(receiveIdTypeOf(''), 'open_id')
  })
})

describe('feishu client: tenant token', () => {
  it('mints a token once and reuses it', async () => {
    // The token lives ~2 hours. Re-minting per call would double every send's
    // latency and hammer an endpoint that rate-limits.
    const { fetchImpl, calls } = createFetchStub(() => ({ payload: { code: 0, tenant_access_token: 'tok-1' } }))
    const client = createFeishuClient({ appId: 'cli_1', appSecret: 'sec', fetchImpl })

    assert.equal(await client.tenantToken(), 'tok-1')
    assert.equal(await client.tenantToken(), 'tok-1')
    assert.equal(calls.length, 1)
    assert.equal(calls[0].body.app_id, 'cli_1')
    assert.equal(calls[0].body.app_secret, 'sec')
  })

  it('refuses clearly when the app secret is missing', async () => {
    const { fetchImpl } = createFetchStub(() => ({ payload: { code: 0 } }))
    const client = createFeishuClient({ appId: 'cli_1', fetchImpl })
    await assert.rejects(() => client.tenantToken(), /app id or secret is missing/)
  })

  it('treats a token refusal as a failure', async () => {
    const { fetchImpl } = createFetchStub(() => ({ payload: { code: 10003, msg: 'invalid app_secret' } }))
    const client = createFeishuClient({ appId: 'cli_1', appSecret: 'bad', fetchImpl })
    await assert.rejects(() => client.tenantToken(), (error) => {
      assert.ok(error instanceof FeishuApiError)
      assert.equal(error.code, 10003)
      assert.match(error.message, /invalid app_secret/)
      return true
    })
  })
})

describe('feishu client: sendText', () => {
  it('posts the message with the type its id implies and the body as a JSON string', async () => {
    const { fetchImpl, calls } = createFetchStub(
      withToken(() => ({ payload: { code: 0, data: { message_id: 'om_1' } } })),
    )
    const client = createFeishuClient({ appId: 'cli_1', appSecret: 'sec', fetchImpl })

    const result = await client.sendText('ou_peer', '你好')
    assert.equal(result.messageId, 'om_1')

    const send = calls[1]
    assert.match(send.url, /\/open-apis\/im\/v1\/messages\?receive_id_type=open_id$/)
    assert.equal(send.method, 'POST')
    assert.equal(send.headers.authorization, 'Bearer tok-1')
    assert.equal(send.body.receive_id, 'ou_peer')
    assert.equal(send.body.msg_type, 'text')
    // Feishu takes the content as a JSON *string* nested inside the JSON body.
    assert.equal(typeof send.body.content, 'string')
    assert.deepEqual(JSON.parse(send.body.content), { text: '你好' })
  })

  it('addresses a group chat as a chat_id', async () => {
    const { fetchImpl, calls } = createFetchStub(withToken(() => ({ payload: { code: 0 } })))
    const client = createFeishuClient({ appId: 'cli_1', appSecret: 'sec', fetchImpl })
    await client.sendText('oc_group', 'hi')
    assert.match(calls[1].url, /receive_id_type=chat_id$/)
  })

  it('[REGRESSION] a business refusal carried by HTTP 200 is still a failure', async () => {
    // Feishu answers plenty of refusals with 200 and a non-zero `code`. Reading
    // the status alone is how a message that was never delivered looks sent.
    const { fetchImpl } = createFetchStub(
      withToken(() => ({ status: 200, payload: { code: 230002, msg: 'bot is not in the chat', error: { log_id: 'lg-1' } } })),
    )
    const client = createFeishuClient({ appId: 'cli_1', appSecret: 'sec', fetchImpl })

    await assert.rejects(() => client.sendText('ou_peer', 'hi'), (error) => {
      assert.ok(error instanceof FeishuApiError)
      assert.equal(error.code, 230002)
      assert.equal(error.logId, 'lg-1')
      assert.match(error.message, /log_id=lg-1/, 'the log id is the only handle Feishu support can trace')
      return true
    })
  })

  it('surfaces an HTTP 400 body rather than a bare status', async () => {
    const { fetchImpl } = createFetchStub(
      withToken(() => ({ status: 400, payload: { code: 99991663, msg: 'invalid receive_id' } })),
    )
    const client = createFeishuClient({ appId: 'cli_1', appSecret: 'sec', fetchImpl })
    await assert.rejects(() => client.sendText('ou_peer', 'hi'), /HTTP 400, code=99991663, msg=invalid receive_id/)
  })
})

describe('feishu client: typing indicator', () => {
  it('[REGRESSION] the reaction is added once and reused, which is why no heartbeat is needed', async () => {
    // Unlike WeChat's one-shot typing signal, a reaction persists until removed.
    // The bridge calls this on a refresh loop; only the first call may hit the
    // API, or a long turn would add hundreds of reactions to one message.
    const { fetchImpl, calls } = createFetchStub(
      withToken(() => ({ payload: { code: 0, data: { reaction_id: 'rk-1' } } })),
    )
    const client = createFeishuClient({ appId: 'cli_1', appSecret: 'sec', fetchImpl })

    assert.equal(await client.addTypingReaction('om_user'), true)
    assert.equal(await client.addTypingReaction('om_user'), true)
    assert.equal(await client.addTypingReaction('om_user'), true)

    const reactionCalls = calls.filter((call) => call.url.includes('/reactions'))
    assert.equal(reactionCalls.length, 1, 'the API must be touched once per message')
    assert.equal(reactionCalls[0].method, 'POST')
    assert.deepEqual(reactionCalls[0].body, { reaction_type: { emoji_type: 'Typing' } })
  })

  it('removes the reaction it added, and forgets it', async () => {
    const { fetchImpl, calls } = createFetchStub(
      withToken((call) =>
        call.method === 'POST'
          ? { payload: { code: 0, data: { reaction_id: 'rk-1' } } }
          : { payload: { code: 0 } },
      ),
    )
    const client = createFeishuClient({ appId: 'cli_1', appSecret: 'sec', fetchImpl })

    await client.addTypingReaction('om_user')
    assert.equal(await client.removeTypingReaction('om_user'), true)

    const removal = calls.find((call) => call.method === 'DELETE')
    assert.match(removal.url, /\/messages\/om_user\/reactions\/rk-1$/)

    assert.equal(await client.removeTypingReaction('om_user'), false, 'nothing left to remove')
  })

  it('does nothing when there is no message to react to', async () => {
    const { fetchImpl, calls } = createFetchStub(() => ({ payload: { code: 0 } }))
    const client = createFeishuClient({ appId: 'cli_1', appSecret: 'sec', fetchImpl })
    assert.equal(await client.addTypingReaction(''), false)
    assert.equal(calls.length, 0)
  })
})

describe('feishu client: hosts and reset', () => {
  it('targets the international host for lark', async () => {
    const { fetchImpl, calls } = createFetchStub(() => ({ payload: { code: 0, tenant_access_token: 't' } }))
    const client = createFeishuClient({ appId: 'cli_1', appSecret: 's', domain: 'lark', fetchImpl })
    await client.tenantToken()
    assert.ok(calls[0].url.startsWith(FEISHU_HOSTS.lark))
  })

  it('reset drops the cached token and reaction ids', async () => {
    const { fetchImpl, calls } = createFetchStub(
      withToken(() => ({ payload: { code: 0, data: { reaction_id: 'rk-1' } } })),
    )
    const client = createFeishuClient({ appId: 'cli_1', appSecret: 'sec', fetchImpl })
    await client.tenantToken()
    await client.addTypingReaction('om_user')
    assert.equal(client.typingCount(), 1)

    client.reset()
    assert.equal(client.typingCount(), 0)
    await client.tenantToken()
    assert.equal(calls.filter((call) => call.url.includes('/tenant_access_token/')).length, 2, 're-minted after reset')
  })
})
