/**
 * Bridge + channel unit tests.
 *
 * The suite runs on a bare Node install with **no DSH host and no network**:
 * every host capability is a fake injected through the plugin's public seams
 * (`apply(ctx, config, deps)`, the process-local service registry, and the
 * protocol factories), and the modules under test import nothing from
 * `@deepseek-ai/*` (docs/INTERFACES.md §2.0).
 *
 * @module wechat-feishu-linker/tests/bridge
 */

import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { apply as applyBridge } from '../src/bridge/index.js'
import { HostAccess } from '../src/bridge/host.js'
import {
  TurnBuffer,
  assistantTextOf,
  bufferKey,
  deliverReply,
  deliveryHint,
  isStaleWindow,
  sessionIdOf,
} from '../src/bridge/relay.js'
import {
  MemorySessionChoiceStore,
  createUserMessage,
  decideAccess,
  isEchoMessage,
  resolveAgentOptions,
} from '../src/bridge/sessions.js'
import { checkHostCompat, describeCompat, HOST_SURFACES } from '../src/bridge/compat.js'
import { DEFAULT_CONFIG, PER_CHANNEL_KEYS, channelConfig } from '../src/bridge/config-bridge.js'
import { parseCommand } from '../src/bridge/commands.js'
import {
  DEFAULT_CHANNEL,
  clearService,
  getBridgeSettings,
  getService,
  setService,
} from '../src/registry.js'
import { WechatIlinkChannel, apply as applyService, withPollTimeout } from '../src/service.js'

// ────────────────────────────── harness ──────────────────────────────

/** Let every pending promise chain settle. */
const settle = async () => {
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
}

/**
 * Build a fake Cordis context.
 *
 * @param {object} [services] - service name → instance.
 * @returns {object} the fake context plus `emit` and `listeners`.
 */
function createCtx(services = {}) {
  const listeners = new Map()
  const ctx = {
    logger: undefined,
    get(name) {
      return services[name]
    },
    on(event, handler) {
      const set = listeners.get(event) ?? new Set()
      set.add(handler)
      listeners.set(event, set)
      return () => set.delete(handler)
    },
    emit(event, ...args) {
      for (const handler of listeners.get(event) ?? []) handler(...args)
    },
  }
  return { ctx, listeners, services }
}

/** A normalized inbound message, as the channel emits it. */
const inbound = (over = {}) => ({
  accountId: 'default',
  fromUserId: 'peer-1',
  text: '你好',
  itemTypes: ['text'],
  attachments: [],
  createdAt: Date.now(),
  ...over,
})

/**
 * Fake agent registry mirroring `ctx.get('agents')`.
 *
 * @param {object} [options] - behaviour switches.
 * @returns {object} the registry plus recorded calls.
 */
function createAgents(options = {}) {
  const live = new Map()
  const calls = { get: [], resume: [], create: [] }
  const sections = []
  const agentListeners = new Map()
  return {
    live,
    calls,
    sections,
    agentListeners,
    get(id) {
      calls.get.push(id)
      return live.get(id)
    },
    async resume(request) {
      calls.resume.push(request)
      // A real host resumes any durable session; the fake resumes only the ids
      // a test declares, so the "not resumable → reopen the same id" fallback
      // stays covered too.
      if (options.resumeAll === true || (options.resumable ?? []).includes(request.resumeSessionId)) {
        const agent = createAgent(request.resumeSessionId, agentListeners)
        live.set(request.resumeSessionId, agent)
        await request.setup?.({ get: () => undefined, on: () => () => {} }, agent)
        return { agent }
      }
      throw new Error('no persisted session')
    },
    async create(request) {
      calls.create.push(request)
      if (options.failCreate) throw new Error(options.failCreate)
      const agent = createAgent(request.sessionId, agentListeners)
      live.set(request.sessionId, agent)
      const agentCtx = {
        get(name) {
          if (name === 'systemPrompt') {
            return {
              section(section) {
                sections.push(section)
              },
            }
          }
          return undefined
        },
        on(event, handler) {
          const set = agentListeners.get(event) ?? new Set()
          set.add(handler)
          agentListeners.set(event, set)
          return () => set.delete(handler)
        },
      }
      await request.setup?.(agentCtx, agent)
      return { agent }
    },
  }
}

/**
 * @param {string} sessionId - session id.
 * @param {Map<string, Set<Function>>} agentListeners - waterfall registry.
 * @returns {object} a fake agent.
 */
function createAgent(sessionId, agentListeners) {
  return {
    id: sessionId,
    session: { id: sessionId },
    status: 'idle',
    sent: [],
    cancels: [],
    send(message, target, wakeup) {
      this.sent.push({ message, target, wakeup })
      this.status = 'running'
    },
    cancel(cause) {
      this.cancels.push(cause)
      this.status = 'idle'
    },
    ctx: {
      get: () => undefined,
      on(event, handler) {
        const set = agentListeners.get(event) ?? new Set()
        set.add(handler)
        agentListeners.set(event, set)
        return () => set.delete(handler)
      },
    },
  }
}

/**
 * Fake channel service (the thing the bridge reaches through the registry).
 *
 * @param {object} [options] - behaviour switches.
 * @returns {object} the channel plus recorded sends.
 */
function createChannel(options = {}) {
  const sent = []
  const typing = []
  let remainingFailures = Number.isFinite(options.failSendTimes) ? options.failSendTimes : 0
  return {
    dataDirectory: options.dataDirectory,
    sent,
    typing,
    async sendText(peerId, text, opts) {
      if (remainingFailures > 0) {
        remainingFailures -= 1
        throw options.failSendError ?? new Error(options.failSend ?? 'send failed')
      }
      if (options.failSend) throw options.failSendError ?? new Error(options.failSend)
      sent.push({ peerId, text, opts })
      return { messageIds: [`m${sent.length}`], chunkCount: 1 }
    },
    async sendTyping(peerId, contextToken) {
      typing.push({ peerId, contextToken })
      return options.typingResult ?? true
    },
  }
}

/** An iLink-style API failure, shaped like `IlinkApiError` (no import needed). */
const ilinkError = (ret, message = 'prepare failed') =>
  Object.assign(new Error(message), { ret, name: 'IlinkApiError' })

/**
 * Mount the bridge against fakes.
 *
 * @param {object} [options] - harness options.
 * @returns {object} handles for assertions.
 */
function harness(options = {}) {
  const agents = createAgents(options.agents)
  const channel = options.channel ?? createChannel(options.channelOptions)
  // `sessionPersistence` is what gates `agents.resume`; the default harness
  // mounts it so the resume path is exercised, and a test can opt out.
  const services = { agents, sessionPersistence: options.sessionPersistence ?? {}, ...(options.services ?? {}) }
  if (options.tools) services.tools = options.tools
  const { ctx, listeners } = createCtx(services)
  const logs = []
  const log = (level, message) => logs.push({ level, message })
  setService(channel)
  const dispose = applyBridge(ctx, { enabled: true, ...options.config }, {
    choices: options.choices ?? new MemorySessionChoiceStore(),
    cwd: 'C:/work',
    log,
  })
  return {
    agents,
    channel,
    ctx,
    listeners,
    logs,
    services,
    dispose,
    emit: (event, ...args) => ctx.emit(event, ...args),
    cleanup() {
      dispose()
      clearService()
    },
  }
}

/**
 * Fake `workspaceRegistry` (`@deepseek-ai/dsh-workspace`).
 *
 * Mirrors the verified surface: `list()`, `archivedSessionIds`,
 * `resolveByPath(path)`, `create(path)`, and entity `attachSession(id)`.
 *
 * @param {object} [options] - behaviour switches.
 * @returns {object} the registry plus recorded calls.
 */
function createWorkspaceRegistry(options = {}) {
  const calls = { list: 0, resolveByPath: [], create: [], attach: [] }
  const workspaces = (options.workspaces ?? []).map((entry) => makeWorkspace(entry, calls))
  return {
    calls,
    workspaces,
    archivedSessionIds: options.archivedSessionIds ?? [],
    list() {
      calls.list += 1
      return workspaces
    },
    async resolveByPath(path) {
      calls.resolveByPath.push(path)
      return workspaces.find((workspace) => workspace.path === path)
    },
    async create(path) {
      calls.create.push(path)
      if (options.failCreate) throw new Error('create refused')
      const workspace = makeWorkspace({ path }, calls)
      workspaces.push(workspace)
      return workspace
    },
  }
}

/**
 * @param {{ id?: string, path: string, title?: string, sessionIds?: string[] }} entry - seed.
 * @param {object} calls - recorder.
 * @returns {object} a workspace entity.
 */
function makeWorkspace(entry, calls) {
  const sessionIds = [...(entry.sessionIds ?? [])]
  return {
    id: entry.id ?? entry.path,
    path: entry.path,
    title: entry.title ?? '',
    createdAt: 0,
    updatedAt: 0,
    get sessionIds() {
      return sessionIds
    },
    async attachSession(sessionId) {
      calls.attach.push({ path: entry.path, sessionId })
      if (!sessionIds.includes(sessionId)) sessionIds.push(sessionId)
    },
  }
}

/**
 * Fake `sessionQuery` (`@deepseek-ai/dsh-session-query`).
 *
 * Mirrors the verified surface: `listSessions()` → `[{header, live, persisted}]`
 * newest-first, and `readSession(id)` → `{session, events}`.
 *
 * @param {object} [options] - behaviour switches.
 * @returns {object} the service plus recorded calls.
 */
function createSessionQuery(options = {}) {
  const calls = { listSessions: 0, readSession: [] }
  return {
    calls,
    async listSessions() {
      calls.listSessions += 1
      if (options.failList) throw new Error('list failed')
      return options.records ?? []
    },
    async readSession(sessionId) {
      calls.readSession.push(sessionId)
      const events = (options.histories ?? {})[sessionId]
      if (!events) throw new Error('no such session')
      return { session: { id: sessionId }, inheritedEventCount: 0, events }
    },
  }
}

/**
 * One `sessionQuery.listSessions()` record.
 *
 * @param {string} id - session id.
 * @param {object} [header] - extra header fields.
 * @param {object} [extra] - `live` / `persisted` flags.
 * @returns {object} the record.
 */
const sessionRecord = (id, header = {}, extra = {}) => ({
  header: { type: 'session', version: 4, id, createdAt: 1_700_000_000_000, isSeeded: false, delegationDepth: 0, ...header },
  live: extra.live ?? false,
  persisted: extra.persisted ?? true,
})

/** A `user/message` session event. */
const userEvent = (text, extra = {}) => ({
  type: 'user/message',
  seq: 0,
  time: 1_700_000_000_000,
  data: { message: { role: 'user', content: [{ type: 'text', text }] }, ...(extra.source ? { source: extra.source } : {}) },
})

/** An `assistant/message` session event. */
const assistantEvent = (text) => ({
  type: 'assistant/message',
  seq: 1,
  time: 1_700_000_001_000,
  data: { message: { role: 'assistant', content: [{ type: 'text', text }] } },
})

// ────────────────────────────── inbound dispatch ──────────────────────────────

test('[REGRESSION] an inbound line steers the running turn instead of queueing', async (t) => {
  // `send(message, 'next-turn', true)` parks the line until the running turn
  // ends, so on a long turn the contact writes a follow-up and watches nothing
  // happen. `steer` injects it at the next step boundary instead.
  const h = harness()
  t.after(() => h.cleanup())
  h.emit('wechat-ilink/message', inbound({ text: '你好' }))
  await settle()

  const sessionId = h.agents.calls.create[0].sessionId
  const agent = h.agents.live.get(sessionId)
  const steered = []
  agent.steer = (message) => steered.push(message)

  h.emit('wechat-ilink/message', inbound({ text: '插一句' }))
  await settle()

  assert.equal(steered.length, 1, 'agent.steer must win over the raw send fallback')
  assert.deepEqual(steered[0].content, [{ type: 'text', text: '插一句' }])
  assert.equal(agent.sent.length, 1, 'the fallback must not also fire')
})

test('inbound message is dispatched to a freshly created agent session', async (t) => {
  const h = harness()
  t.after(() => h.cleanup())
  h.emit('wechat-ilink/message', inbound({ text: '你好' }))
  await settle()

  assert.equal(h.agents.calls.create.length, 1)
  const request = h.agents.calls.create[0]
  assert.match(request.sessionId, /^session-[0-9a-f-]{36}$/)
  assert.deepEqual(request.meta, { cwd: 'C:/work' })

  const agent = h.agents.live.get(request.sessionId)
  assert.equal(agent.sent.length, 1)
  const [entry] = agent.sent
  assert.equal(
    entry.target,
    'next-step',
    'a WeChat line must interrupt the running turn, not queue behind it',
  )
  assert.equal(entry.wakeup, true)
  assert.equal(entry.message.role, 'user')
  assert.match(entry.message.id, /^[0-9a-f-]{36}$/)
  assert.deepEqual(entry.message.source, {
    kind: 'wechat-ilink',
    accountId: 'default',
    peerId: 'peer-1',
  })
  assert.deepEqual(entry.message.content, [{ type: 'text', text: '你好' }])
  assert.ok(Object.isFrozen(entry.message), 'message must be frozen like the host builds it')
})

test('attachments are described to the agent instead of being dropped', async (t) => {
  const h = harness()
  t.after(() => h.cleanup())
  h.emit(
    'wechat-ilink/message',
    inbound({ text: '', attachments: [{ kind: 'image' }, { kind: 'file' }] }),
  )
  await settle()
  const agent = h.agents.live.get(h.agents.calls.create[0].sessionId)
  const text = agent.sent[0].message.content.map((block) => block.text).join('\n')
  assert.match(text, /2 个附件/)
  assert.match(text, /image、file/)
})

test('an empty message is acknowledged instead of silently dropped', async (t) => {
  const h = harness()
  t.after(() => h.cleanup())
  h.emit('wechat-ilink/message', inbound({ text: '   ', attachments: [] }))
  await settle()
  assert.equal(h.agents.calls.create.length, 0)
  assert.equal(h.channel.sent.length, 1)
  assert.match(h.channel.sent[0].text, /只支持文本消息/)
})

// ────────────────────────────── session reuse ──────────────────────────────

test('a second message from the same peer reuses the live session', async (t) => {
  const h = harness()
  t.after(() => h.cleanup())
  h.emit('wechat-ilink/message', inbound({ text: '第一条' }))
  await settle()
  h.emit('wechat-ilink/message', inbound({ text: '第二条' }))
  await settle()

  assert.equal(h.agents.calls.create.length, 1)
  const agent = h.agents.live.get(h.agents.calls.create[0].sessionId)
  assert.equal(agent.sent.length, 2)
  assert.equal(agent.sent[1].message.content[0].text, '第二条')
})

test('concurrent messages from one peer mint exactly one session (pendingAgents dedup)', async (t) => {
  const h = harness()
  t.after(() => h.cleanup())
  h.emit('wechat-ilink/message', inbound({ text: 'A' }))
  h.emit('wechat-ilink/message', inbound({ text: 'B' }))
  h.emit('wechat-ilink/message', inbound({ text: 'C' }))
  await settle()

  assert.equal(h.agents.calls.create.length, 1)
  const agent = h.agents.live.get(h.agents.calls.create[0].sessionId)
  assert.deepEqual(
    agent.sent.map((entry) => entry.message.content[0].text),
    ['A', 'B', 'C'],
  )
})

test('different peers get independent sessions', async (t) => {
  const h = harness()
  t.after(() => h.cleanup())
  h.emit('wechat-ilink/message', inbound({ fromUserId: 'peer-1' }))
  h.emit('wechat-ilink/message', inbound({ fromUserId: 'peer-2' }))
  await settle()
  assert.equal(h.agents.calls.create.length, 2)
  assert.notEqual(h.agents.calls.create[0].sessionId, h.agents.calls.create[1].sessionId)
})

test('shared session mode routes every peer to one session', async (t) => {
  const h = harness({ config: { sessionMode: 'shared' } })
  t.after(() => h.cleanup())
  h.emit('wechat-ilink/message', inbound({ fromUserId: 'peer-1' }))
  h.emit('wechat-ilink/message', inbound({ fromUserId: 'peer-2' }))
  await settle()
  assert.equal(h.agents.calls.create.length, 1)
})

test('a memoized session is resumed when it is not live in this process', async (t) => {
  const choices = new MemorySessionChoiceStore()
  choices.set('wechat-ilink:default:peer-1', 'session-remembered')
  const h = harness({ choices })
  t.after(() => h.cleanup())
  h.emit('wechat-ilink/message', inbound())
  await settle()
  // resume rejects in the fake, so the bridge reopens the same id via create.
  assert.equal(h.agents.calls.resume.length, 1)
  assert.equal(h.agents.calls.resume[0].resumeSessionId, 'session-remembered')
  assert.equal(h.agents.calls.create[0].sessionId, 'session-remembered')
})

test('an unrecoverable bound session falls back to a freshly minted id', async (t) => {
  const choices = new MemorySessionChoiceStore()
  choices.set('wechat-ilink:default:peer-1', 'session-remembered')
  const agents = createAgents()
  const originalCreate = agents.create.bind(agents)
  agents.create = async (request) => {
    if (request.sessionId === 'session-remembered') {
      agents.calls.create.push(request)
      throw new Error('id already held by another instance')
    }
    return originalCreate(request)
  }
  const channel = createChannel()
  const { ctx } = createCtx({ agents, sessionPersistence: {} })
  setService(channel)
  const dispose = applyBridge(ctx, { enabled: true }, { choices, log: () => {} })
  t.after(() => {
    dispose()
    clearService()
  })
  ctx.emit('wechat-ilink/message', inbound())
  await settle()
  assert.equal(agents.calls.create.length, 2)
  assert.equal(agents.calls.create[0].sessionId, 'session-remembered')
  assert.match(agents.calls.create[1].sessionId, /^session-[0-9a-f-]{36}$/)
})

// ────────────────────────────── echo + policy ──────────────────────────────

test('the bot never answers its own message (echo guard)', async (t) => {
  const h = harness()
  t.after(() => h.cleanup())
  h.emit('wechat-ilink/message', inbound({ fromUserId: 'bot-1', selfUserId: 'bot-1' }))
  h.emit('wechat-ilink/message', inbound({ fromUserId: '' }))
  await settle()
  assert.equal(h.agents.calls.create.length, 0)
  assert.equal(h.channel.sent.length, 0)
})

test('allowlist policy refuses an unlisted peer and tells them', async (t) => {
  const h = harness({ config: { dmPolicy: 'allowlist', allowlist: ['peer-2'] } })
  t.after(() => h.cleanup())
  h.emit('wechat-ilink/message', inbound({ fromUserId: 'peer-1' }))
  await settle()
  assert.equal(h.agents.calls.create.length, 0)
  assert.equal(h.channel.sent.length, 1)
  assert.match(h.channel.sent[0].text, /不在本助手的允许列表/)
  assert.equal(h.channel.sent[0].peerId, 'peer-1')

  h.emit('wechat-ilink/message', inbound({ fromUserId: 'peer-2' }))
  await settle()
  assert.equal(h.agents.calls.create.length, 1)
})

test('a disabled direct-message policy drops traffic without replying', async (t) => {
  const h = harness({ config: { dmPolicy: 'disabled' } })
  t.after(() => h.cleanup())
  h.emit('wechat-ilink/message', inbound())
  await settle()
  assert.equal(h.agents.calls.create.length, 0)
  assert.equal(h.channel.sent.length, 0)
})

test('group traffic defaults to disabled and honors the group allowlist', async (t) => {
  const h = harness({ config: { groupPolicy: 'allowlist', groupAllowlist: ['group-9'] } })
  t.after(() => h.cleanup())
  h.emit('wechat-ilink/message', inbound({ groupId: 'group-1' }))
  await settle()
  assert.equal(h.agents.calls.create.length, 0)
  assert.match(h.channel.sent[0].text, /本群未授权/)

  h.emit('wechat-ilink/message', inbound({ groupId: 'group-9' }))
  await settle()
  assert.equal(h.agents.calls.create.length, 1)
})

test('a failing session open reaches the contact as an error notice', async (t) => {
  const h = harness({ agents: { failCreate: 'boom' } })
  t.after(() => h.cleanup())
  h.emit('wechat-ilink/message', inbound())
  await settle()
  assert.equal(h.channel.sent.length, 1)
  assert.match(h.channel.sent[0].text, /处理失败/)
  assert.ok(
    h.logs.some((entry) => entry.level === 'error'),
    'the failure must also be logged',
  )
})

// ────────────────────────────── turn buffering + reply ──────────────────────────────

/**
 * Dispatch one message and return the session id it landed on.
 *
 * @param {object} h - harness.
 * @returns {Promise<string>} the session id.
 */
async function dispatchOne(h, text = '你好') {
  h.emit('wechat-ilink/message', inbound({ text }))
  await settle()
  return h.agents.calls.create[0].sessionId
}

test('quiet: assistant text is buffered per turn and flushed as one reply on turn/end', async (t) => {
  const h = harness({ config: { displayMode: 'quiet' } })
  t.after(() => h.cleanup())
  const sessionId = await dispatchOne(h)

  h.emit(
    'session/event',
    { id: sessionId },
    { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: '第一段' }] } } },
  )
  h.emit(
    'session/event',
    { id: sessionId },
    {
      type: 'assistant/message',
      data: {
        turn: 1,
        message: { content: [{ type: 'tool_use', id: 't1' }, { type: 'text', text: '第二段' }] },
      },
    },
  )
  await settle()
  assert.equal(h.channel.sent.length, 0, 'nothing may be sent before the turn ends')

  h.emit('session/event', { id: sessionId }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  await settle()
  assert.equal(h.channel.sent.length, 1)
  assert.equal(h.channel.sent[0].text, '第一段\n\n第二段')
  assert.equal(h.channel.sent[0].peerId, 'peer-1')
})

test('a fast follow-up turn keeps its own buffer', async (t) => {
  const h = harness()
  t.after(() => h.cleanup())
  const sessionId = await dispatchOne(h)
  const frame = (turn, text, type = 'assistant/message') => [
    { id: sessionId },
    type === 'assistant/message'
      ? { type, data: { turn, message: { content: [{ type: 'text', text }] } } }
      : { type, data: { turn, reason: { kind: 'completed' } } },
  ]
  h.emit('session/event', ...frame(1, 'turn-1'))
  h.emit('session/event', ...frame(2, 'turn-2'))
  h.emit('session/event', ...frame(1, '', 'turn/end'))
  h.emit('session/event', ...frame(2, '', 'turn/end'))
  await settle()
  assert.deepEqual(
    h.channel.sent.map((entry) => entry.text),
    ['turn-1', 'turn-2'],
  )
})

test('a turn that ends abnormally without text notifies the contact', async (t) => {
  const h = harness()
  t.after(() => h.cleanup())
  const sessionId = await dispatchOne(h)
  h.emit('session/event', { id: sessionId }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'error' } } })
  await settle()
  assert.equal(h.channel.sent.length, 1)
  assert.match(h.channel.sent[0].text, /没有产生文本回复/)
})

test('a normally completed empty turn stays silent', async (t) => {
  const h = harness()
  t.after(() => h.cleanup())
  const sessionId = await dispatchOne(h)
  h.emit('session/event', { id: sessionId }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  await settle()
  assert.equal(h.channel.sent.length, 0)
})

test('session events for unbound sessions are ignored', async (t) => {
  const h = harness()
  t.after(() => h.cleanup())
  h.emit(
    'session/event',
    { id: 'session-other' },
    { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: 'x' }] } } },
  )
  h.emit('session/event', { id: 'session-other' }, { type: 'turn/end', data: { turn: 1 } })
  await settle()
  assert.equal(h.channel.sent.length, 0)
})

test('agent errors are reported to the bound peer', async (t) => {
  const h = harness()
  t.after(() => h.cleanup())
  const sessionId = await dispatchOne(h)
  h.emit('agent/error', { agent: { id: sessionId }, error: new Error('provider exploded') })
  await settle()
  assert.equal(h.channel.sent.length, 1)
  assert.match(h.channel.sent[0].text, /provider exploded/)
})

// ─────────────── reply delivery failure (V-2: never lose a reply silently) ───────────────

/**
 * Dispatch a message and drive one complete turn that produces `text`.
 *
 * @param {object} h - harness.
 * @param {string} text - assistant text for the turn.
 * @returns {Promise<string>} the session id.
 */
async function runOneTurn(h, text = '答案') {
  const sessionId = await dispatchOne(h)
  h.emit(
    'session/event',
    { id: sessionId },
    { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text }] } } },
  )
  h.emit('session/event', { id: sessionId }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  await settle()
  return sessionId
}

test('[REGRESSION] a reply a closed window refused is parked, then delivered when it reopens', async (t) => {
  // `context_token` is short-lived, so the answer to a long turn is routinely
  // the one refused with `ret:-2` — and nothing can be retried into a closed
  // window. Dropping it is what made WeChat show half a turn while the desktop
  // had the whole thing; the failure notice was refused the same way, so the
  // contact saw nothing at all.
  const channel = createChannel({ failSendTimes: 1, failSendError: ilinkError(-2) })
  const h = harness({ channel })
  t.after(() => h.cleanup())
  await runOneTurn(h, '长回合的答案')

  assert.equal(channel.sent.length, 0, 'a closed window refuses the notice too, so none may be attempted')
  assert.ok(
    h.logs.some((entry) => /parked a reply/.test(entry.message)),
    'parking must be visible in the log',
  )

  // The contact's next message refreshes the token; the parked reply goes out.
  h.emit('wechat-ilink/message', inbound({ text: '在吗' }))
  await settle()
  assert.ok(
    channel.sent.some((entry) => /长回合的答案/.test(entry.text)),
    'the parked reply must be delivered once the window reopens',
  )
})

test('a stale window is recognised from the code or from the message', () => {
  assert.equal(isStaleWindow(ilinkError(-2)), true)
  assert.equal(isStaleWindow({ ret: -2, errcode: 0 }), true, 'a trailing errcode must not hide it')
  assert.equal(isStaleWindow(new Error('iLink /sendmessage failed: prepare failed')), true)
  assert.equal(isStaleWindow(new Error('socket hang up')), false)
  assert.equal(isStaleWindow({ ret: 0, errcode: -14 }), false, 'an expired login is not a closed window')
  assert.equal(isStaleWindow(undefined), false)
})

test('an expired login (errcode -14) gets its own actionable hint', async (t) => {
  // The real `IlinkAuthError` carries `errcode: -14` while `ret` stays `0`.
  const channel = createChannel({
    failSendTimes: 1,
    failSendError: Object.assign(new Error('session expired'), { ret: 0, errcode: -14, name: 'IlinkAuthError' }),
  })
  const h = harness({ channel })
  t.after(() => h.cleanup())
  await runOneTurn(h)
  assert.equal(h.channel.sent.length, 1)
  assert.match(h.channel.sent[0].text, /重新扫码登录/)
})

test('deliveryHint reads ret:-2 even when a trailing errcode is present', () => {
  assert.match(deliveryHint({ ret: -2, errcode: 0 }), /会话窗口已过期/)
})

test('a reply failure with an unrecognized error still gets a generic hint', async (t) => {
  const channel = createChannel({ failSendTimes: 1, failSendError: new Error('socket hang up') })
  const h = harness({ channel })
  t.after(() => h.cleanup())
  await runOneTurn(h)
  assert.equal(h.channel.sent.length, 1)
  assert.match(h.channel.sent[0].text, /本轮回复发送失败/)
  assert.match(h.channel.sent[0].text, /再发一条消息重试/)
})

test('a failure notice that also fails is logged at error level and never throws', async (t) => {
  const rejections = []
  const onRejection = (reason) => rejections.push(reason)
  process.on('unhandledRejection', onRejection)
  t.after(() => process.off('unhandledRejection', onRejection))

  const channel = createChannel({ failSend: 'gateway down' })
  const h = harness({ channel })
  t.after(() => h.cleanup())
  await runOneTurn(h)

  assert.equal(h.channel.sent.length, 0)
  assert.ok(
    h.logs.some((entry) => entry.level === 'error' && /both failed/.test(entry.message)),
    `expected a "both failed" error log, got: ${JSON.stringify(h.logs)}`,
  )
  await settle()
  assert.deepEqual(rejections, [])
})

test('a successful reply sends exactly one message and no notice', async (t) => {
  const h = harness()
  t.after(() => h.cleanup())
  await runOneTurn(h, '正常回复')
  assert.equal(h.channel.sent.length, 1)
  assert.equal(h.channel.sent[0].text, '正常回复')
})

test('a failed empty-turn notice is logged at error level', async (t) => {
  const channel = createChannel({ failSend: 'gateway down' })
  const h = harness({ channel })
  t.after(() => h.cleanup())
  const sessionId = await dispatchOne(h)
  h.emit('session/event', { id: sessionId }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'error' } } })
  await settle()
  assert.ok(
    h.logs.some((entry) => entry.level === 'error' && /empty-turn notice/.test(entry.message)),
    `expected an empty-turn notice error log, got: ${JSON.stringify(h.logs)}`,
  )
})

test('a reply capped by replyMaxChars is passed through as a chunk limit', async (t) => {
  const h = harness({ config: { replyMaxChars: 500 } })
  t.after(() => h.cleanup())
  const sessionId = await dispatchOne(h)
  h.emit(
    'session/event',
    { id: sessionId },
    { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: 'hi' }] } } },
  )
  h.emit('session/event', { id: sessionId }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  await settle()
  assert.equal(h.channel.sent[0].opts.maxChars, 500)
})

// ────────────────────────────── commands ──────────────────────────────

test('/help replies with the command list and never touches the agent', async (t) => {
  const h = harness()
  t.after(() => h.cleanup())
  h.emit('wechat-ilink/message', inbound({ text: '/help' }))
  await settle()
  assert.equal(h.agents.calls.create.length, 0)
  assert.equal(h.channel.sent.length, 1)
  assert.match(h.channel.sent[0].text, /\/new/)
  assert.match(h.channel.sent[0].text, /\/stop/)
})

test('/status reports the current session once one exists', async (t) => {
  const h = harness()
  t.after(() => h.cleanup())
  h.emit('wechat-ilink/message', inbound({ text: '/status' }))
  await settle()
  assert.match(h.channel.sent[0].text, /尚未创建/)

  const sessionId = await dispatchOne(h)
  h.emit('wechat-ilink/message', inbound({ text: '/status' }))
  await settle()
  assert.match(h.channel.sent.at(-1).text, new RegExp(sessionId))
  assert.match(h.channel.sent.at(-1).text, /正在处理|空闲/)
})

test('/stop cancels the running turn exactly once and does not double-notify', async (t) => {
  const h = harness()
  t.after(() => h.cleanup())
  const sessionId = await dispatchOne(h)
  const agent = h.agents.live.get(sessionId)
  assert.equal(agent.status, 'running')

  h.emit('wechat-ilink/message', inbound({ text: '/stop' }))
  await settle()
  assert.deepEqual(agent.cancels, [{ kind: 'user' }])
  assert.equal(h.channel.sent.length, 1)
  assert.match(h.channel.sent[0].text, /已请求中断/)

  // The aborted turn ends with a non-completed reason; the command already
  // explained it, so no second notice may follow.
  h.emit('session/event', { id: sessionId }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'cancelled' } } })
  await settle()
  assert.equal(h.channel.sent.length, 1)
})

test('/new makes the next message open a fresh session', async (t) => {
  const h = harness()
  t.after(() => h.cleanup())
  const first = await dispatchOne(h)
  h.emit('wechat-ilink/message', inbound({ text: '/new' }))
  await settle()
  assert.match(h.channel.sent.at(-1).text, /已开启新会话/)
  assert.match(h.channel.sent.at(-1).text, new RegExp(first))

  h.emit('wechat-ilink/message', inbound({ text: '新会话第一句' }))
  await settle()
  assert.equal(h.agents.calls.create.length, 2)
  assert.notEqual(h.agents.calls.create[1].sessionId, first)
})

test('an unknown slash command is forwarded to the agent as text', async (t) => {
  const h = harness()
  t.after(() => h.cleanup())
  h.emit('wechat-ilink/message', inbound({ text: '/compact please' }))
  await settle()
  assert.equal(h.agents.calls.create.length, 1)
  const agent = h.agents.live.get(h.agents.calls.create[0].sessionId)
  assert.deepEqual(agent.sent[0].message.content, [{ type: 'text', text: '/compact please' }])
})

test('the command prefix is configurable', async (t) => {
  const h = harness({ config: { commandPrefix: '!' } })
  t.after(() => h.cleanup())
  h.emit('wechat-ilink/message', inbound({ text: '!help' }))
  await settle()
  assert.equal(h.agents.calls.create.length, 0)
  assert.match(h.channel.sent[0].text, /!new/)
  assert.equal(parseCommand('!help', '!').name, 'help')
})

// ────────────────────────────── typing indicator ──────────────────────────────

test('the typing indicator is shown while a turn is running', async (t) => {
  const h = harness()
  t.after(() => h.cleanup())
  const sessionId = await dispatchOne(h)
  assert.ok(h.channel.typing.length >= 1, 'dispatch must show typing')
  assert.equal(h.channel.typing[0].peerId, 'peer-1')

  h.emit('session/event', { id: sessionId }, { type: 'turn/start', data: { turn: 2 } })
  await settle()
  assert.ok(h.channel.typing.length >= 2, 'turn/start must refresh typing')
})

test('the typing indicator can be switched off', async (t) => {
  const h = harness({ config: { typingIndicator: false } })
  t.after(() => h.cleanup())
  await dispatchOne(h)
  assert.equal(h.channel.typing.length, 0)
})

test('[REGRESSION] a running turn keeps re-signalling typing, so a long silence is never idle', async (t) => {
  // `sendtyping` is a one-shot with no duration: one signal at turn/start and
  // the client forgets it seconds later. A turn that spends ten minutes inside
  // tool calls then looks completely idle from WeChat — which is exactly when
  // the contact concludes the agent has stopped.
  const h = harness({ config: { typingRefreshMs: 15 } })
  t.after(() => h.cleanup())
  const sessionId = await dispatchOne(h)
  h.channel.typing.length = 0

  h.emit('session/event', { id: sessionId }, { type: 'turn/start', data: { turn: 2 } })
  await settle()
  assert.equal(h.channel.typing.length, 1, 'turn/start signals once immediately')

  await new Promise((resolve) => setTimeout(resolve, 60))
  const during = h.channel.typing.length
  assert.ok(during >= 3, `the heartbeat must keep signalling while the turn runs (saw ${during})`)

  h.emit('session/event', { id: sessionId }, { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } })
  await settle()
  const atEnd = h.channel.typing.length
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(h.channel.typing.length, atEnd, 'the heartbeat must stop when the turn ends')
})

test('the typing heartbeat is off when the indicator is off, or the interval is zero', async (t) => {
  const off = harness({ config: { typingIndicator: false, typingRefreshMs: 10 } })
  t.after(() => off.cleanup())
  const offSession = await dispatchOne(off)
  off.emit('session/event', { id: offSession }, { type: 'turn/start', data: { turn: 2 } })
  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.equal(off.channel.typing.length, 0, 'a disabled indicator must not heartbeat')

  const zero = harness({ config: { typingRefreshMs: 0 } })
  t.after(() => zero.cleanup())
  const zeroSession = await dispatchOne(zero)
  zero.channel.typing.length = 0
  zero.emit('session/event', { id: zeroSession }, { type: 'turn/start', data: { turn: 2 } })
  await settle()
  assert.equal(zero.channel.typing.length, 1, 'the first signal still goes out')
  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.equal(zero.channel.typing.length, 1, 'an interval of 0 means no refresh')
})

test('disposing the bridge stops every typing heartbeat', async (t) => {
  const h = harness({ config: { typingRefreshMs: 10 } })
  const sessionId = await dispatchOne(h)
  h.emit('session/event', { id: sessionId }, { type: 'turn/start', data: { turn: 2 } })
  await settle()

  h.cleanup()
  const after = h.channel.typing.length
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(h.channel.typing.length, after, 'a disposed bridge must leave no timer behind')
})

// ────────────────────────────── agent composition ──────────────────────────────

test('created agents receive the WeChat channel prompt section', async (t) => {
  const h = harness()
  t.after(() => h.cleanup())
  await dispatchOne(h)
  assert.equal(h.agents.sections.length, 1)
  assert.equal(h.agents.sections[0].name, 'wechat-ilink-channel')
  assert.match(h.agents.sections[0].text, /微信/)
  assert.match(h.agents.sections[0].text, /简洁/)
})

test('agent options follow config first, then the deployment default model', async (t) => {
  const explicit = harness({ config: { provider: 'deepseek', model: 'deepseek-chat' } })
  t.after(() => explicit.cleanup())
  await dispatchOne(explicit)
  assert.deepEqual(explicit.agents.calls.create[0].agentOptions, {
    provider: 'deepseek',
    model: 'deepseek-chat',
  })

  const agents = createAgents()
  const { ctx } = createCtx({
    agents,
    agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm', reasoningEffort: 'high' }) },
  })
  setService(createChannel())
  const dispose = applyBridge(ctx, { enabled: true }, { log: () => {} })
  t.after(() => {
    dispose()
    clearService()
  })
  ctx.emit('wechat-ilink/message', inbound())
  await settle()
  assert.deepEqual(agents.calls.create[0].agentOptions, {
    provider: 'p',
    model: 'm',
    reasoningEffort: 'high',
  })
})

test('[REGRESSION] a default model published after construction still reaches prompt assembly', async (t) => {
  // Live failure (2026-09-30, first real WeChat turn): the bridge row was
  // constructed before the host published `agentDefaultModel`, so the selection
  // captured at construction was undefined, no `system-prompt/assemble`
  // waterfall was installed, and the turn aborted with
  //   prompt variable "{{model}}" has no value for this assembly
  //   (section "deployment:persona-prefix")
  // The host renders that section for every agent, so a bridge-created agent
  // must always end up supplying the variable.
  const agents = createAgents()
  const { ctx } = createCtx({ agents })
  const baseGet = ctx.get.bind(ctx)
  let published // not published yet while the bridge row is constructed
  ctx.get = (name) => (name === 'agentDefaultModel' ? published : baseGet(name))

  setService(createChannel())
  const dispose = applyBridge(ctx, { enabled: true }, { log: () => {} })
  t.after(() => {
    dispose()
    clearService()
  })

  // The host finishes booting only after the row already exists.
  published = { currentSelection: () => ({ provider: 'late-provider', model: 'late-model' }) }

  ctx.emit('wechat-ilink/message', inbound())
  await settle()

  const assemble = [...(agents.agentListeners.get('system-prompt/assemble') ?? [])]
  assert.equal(assemble.length, 1, 'the assemble waterfall must be installed for a bridge-created agent')

  const assembled = await assemble[0]({}, {}, async () => ({ sections: [], variables: {} }))
  assert.equal(assembled.variables.model, 'late-model', '{{model}} must resolve or the host aborts the turn')
  assert.equal(assembled.variables.provider, 'late-provider')

  assert.equal(
    [...(agents.agentListeners.get('agent/request') ?? [])].length,
    1,
    'the request waterfall must be installed too, or the request has no provider',
  )
})

test('[REGRESSION] a session\'s own selection outranks the configured default', () => {
  const session = {
    requestHeader: () => ({ config: { provider: 'logged-p', model: 'logged-m', reasoningEffort: 'high' } }),
  }
  assert.deepEqual(resolveAgentOptions({ get: () => undefined }, {}, session), {
    provider: 'logged-p',
    model: 'logged-m',
    reasoningEffort: 'high',
  })
  // The session wins over the config. The configured pair is a DEFAULT for
  // sessions that never chose; letting it outrank an explicit switch would
  // silently undo a model switched from WeChat on the very next turn — the
  // contact would see their choice ignored with nothing to explain why.
  assert.deepEqual(resolveAgentOptions({ get: () => undefined }, { provider: 'cfg-p', model: 'cfg-m' }, session), {
    provider: 'logged-p',
    model: 'logged-m',
    reasoningEffort: 'high',
  })
  // With no session of its own, the configured default is what applies.
  assert.deepEqual(
    resolveAgentOptions({ get: () => undefined }, { provider: 'cfg-p', model: 'cfg-m', reasoningEffort: 'low' }),
    { provider: 'cfg-p', model: 'cfg-m', reasoningEffort: 'low' },
  )
  assert.equal(
    resolveAgentOptions(
      { get: () => undefined },
      {},
      {
        requestHeader: () => {
          throw new Error('gone')
        },
      },
    ),
    undefined,
  )
})

test('a switch that has not been used yet outranks what the session last ran with', () => {
  const events = {
    0: { type: 'model/selection', data: { provider: 'new-p', model: 'new-m', reasoningEffort: 'max' } },
  }
  const session = {
    seq: 1,
    eventAt: (index) => events[index],
    requestHeader: () => ({ config: { provider: 'old-p', model: 'old-m' } }),
  }
  assert.deepEqual(resolveAgentOptions({ get: () => undefined }, { provider: 'cfg-p', model: 'cfg-m' }, session), {
    provider: 'new-p',
    model: 'new-m',
    reasoningEffort: 'max',
  })
})

// ────────────────────────────── robustness ──────────────────────────────

test('a broken outbound channel never produces an unhandled rejection', async (t) => {
  const rejections = []
  const onRejection = (reason) => rejections.push(reason)
  process.on('unhandledRejection', onRejection)
  t.after(() => process.off('unhandledRejection', onRejection))

  const h = harness({ channelOptions: { failSend: 'gateway down' } })
  t.after(() => h.cleanup())
  h.emit('wechat-ilink/message', inbound({ text: '/help' }))
  h.emit('wechat-ilink/message', inbound({ text: 'hi' }))
  await settle()
  const sessionId = h.agents.calls.create[0].sessionId
  h.emit(
    'session/event',
    { id: sessionId },
    { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: 'reply' }] } } },
  )
  h.emit('session/event', { id: sessionId }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  await settle()
  assert.deepEqual(rejections, [])
})

test('a message arriving before the channel is registered is logged, not thrown', async (t) => {
  const agents = createAgents()
  const { ctx } = createCtx({ agents })
  clearService()
  const dispose = applyBridge(ctx, { enabled: true }, { log: () => {} })
  t.after(() => {
    dispose()
    clearService()
  })
  ctx.emit('wechat-ilink/message', inbound({ text: '/help' }))
  await settle()
  assert.equal(agents.calls.create.length, 0)
})

test('the bridge can be disabled by config', async (t) => {
  const h = harness({ config: { enabled: false } })
  t.after(() => h.cleanup())
  h.emit('wechat-ilink/message', inbound())
  await settle()
  assert.equal(h.agents.calls.create.length, 0)
})

test('disposing the bridge removes every listener', async (t) => {
  const h = harness()
  const sessionId = await dispatchOne(h)
  h.dispose()
  h.emit('session/event', { id: sessionId }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'error' } } })
  h.emit('wechat-ilink/message', inbound({ text: 'after dispose' }))
  await settle()
  assert.equal(h.channel.sent.length, 0)
  assert.equal(h.agents.calls.create.length, 1)
  clearService()
})

// ────────────────────────────── pure helpers ──────────────────────────────

test('relay helpers handle the host shapes they claim to', () => {
  assert.equal(sessionIdOf({ id: 'a' }), 'a')
  assert.equal(sessionIdOf({ header: { id: 'b' } }), 'b')
  assert.equal(sessionIdOf({ session: { header: { id: 'c' } } }), 'c')
  assert.equal(sessionIdOf({}), undefined)
  assert.equal(sessionIdOf(null), undefined)

  assert.equal(
    assistantTextOf({ content: [{ type: 'text', text: 'a' }, { type: 'tool_use' }, { type: 'text', text: 'b' }] }),
    'a\nb',
  )
  assert.equal(assistantTextOf({ content: [] }), '')
  assert.equal(assistantTextOf(undefined), '')

  const buffer = new TurnBuffer()
  buffer.append('s', 1, 'x')
  buffer.append('s', 1, 'y')
  assert.equal(buffer.size, 1)
  assert.equal(buffer.take('s', 1), 'x\n\ny')
  assert.equal(buffer.take('s', 1), '')
  // Missing turn ordinals fall back to the session's last known turn.
  buffer.append('s', undefined, 'z')
  assert.equal(buffer.take('s', undefined), 'z')
  buffer.clear()
  assert.equal(buffer.size, 0)
  assert.equal(bufferKey('s', 2), 's#2')
})

test('createUserMessage matches the host contract', () => {
  const message = createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'x' } })
  assert.equal(message.role, 'user')
  assert.match(message.id, /^[0-9a-f-]{36}$/)
  assert.deepEqual(message.source, { kind: 'x' })
  assert.ok(Object.isFrozen(message))
  assert.ok(Object.isFrozen(message.content))
  assert.notEqual(message.id, createUserMessage({ content: [] }).id)
})

test('echo detection and access policy cover the documented cases', () => {
  assert.equal(isEchoMessage({ fromUserId: 'a' }), false)
  assert.equal(isEchoMessage({ fromUserId: 'a', selfUserId: 'a' }), true)
  assert.equal(isEchoMessage({ fromUserId: 'a', botUserId: ' a ' }), true)
  assert.equal(isEchoMessage({ fromUserId: '' }), true)
  assert.equal(isEchoMessage({}), true)

  const open = { dmPolicy: 'open' }
  assert.equal(decideAccess({ fromUserId: 'x' }, open).allowed, true)
  const list = { dmPolicy: 'allowlist', allowlist: ['x'] }
  assert.equal(decideAccess({ fromUserId: 'x' }, list).allowed, true)
  const denied = decideAccess({ fromUserId: 'y' }, list)
  assert.equal(denied.allowed, false)
  assert.equal(denied.notify, true)
  const disabled = decideAccess({ fromUserId: 'x' }, { dmPolicy: 'disabled' })
  assert.equal(disabled.allowed, false)
  assert.equal(disabled.notify, false)
})

test('parseCommand only claims well-formed bridge-shaped commands', () => {
  assert.deepEqual(parseCommand('/new', '/'), { name: 'new', args: '', raw: '/new' })
  assert.equal(parseCommand('  /Status now ', '/').name, 'status')
  assert.equal(parseCommand('/status now', '/').args, 'now')
  assert.equal(parseCommand('/compact', '/').name, 'compact')
  assert.equal(parseCommand('hello', '/'), null)
  assert.equal(parseCommand('/123', '/'), null)
  assert.equal(parseCommand('/', '/'), null)
  assert.equal(parseCommand('', '/'), null)
  assert.equal(parseCommand(null, '/'), null)
  assert.equal(parseCommand('/help', ''), null)
})

// ────────────────────────────── channel service ──────────────────────────────

/**
 * Fake protocol layer implementing docs/INTERFACES.md §3.1–3.6.
 *
 * @param {object} [options] - overrides.
 * @returns {object} the fake barrel plus recorded calls.
 */
function createIlink(options = {}) {
  const calls = { sendMessage: [], sendTyping: [], polls: [], clientOptions: undefined, saved: [], cleared: 0 }
  // The exact record `scripts/login.mjs` persists.
  const account = options.account ?? {
    accountId: 'bot-1',
    botToken: 'tok-1',
    botId: 'bot-1',
    savedAt: '2026-01-01T00:00:00.000Z',
  }
  const store = {
    path: 'C:/tmp/wechat-ilink',
    loaded: 0,
    bufs: new Map(),
    account,
    async load() {
      store.loaded += 1
      return store.account
    },
    async save(next) {
      if (options.saveFails) throw new Error('disk full')
      calls.saved.push(next)
      store.account = next
    },
    async clear() {
      calls.cleared += 1
      store.account = null
    },
    async readBuf(key) {
      return store.bufs.get(key) ?? ''
    },
    async writeBuf(key, buf) {
      store.bufs.set(key, buf)
    },
  }
  const client = {
    token: account.token,
    async sendMessage(request) {
      calls.sendMessage.push(request)
      if (options.failSendMessage) throw new Error(options.failSendMessage)
      return { message_id: `msg-${calls.sendMessage.length}` }
    },
    async sendTyping(request) {
      calls.sendTyping.push(request)
      if (options.failSendTyping) throw new Error(options.failSendTyping)
      return options.typingResult ?? true
    },
  }
  return {
    calls,
    store,
    client,
    account,
    resolveDataDir: () => 'C:/tmp/wechat-ilink',
    createAccountStore: () => store,
    createIlinkClient: (opts) => {
      calls.clientOptions = opts
      return client
    },
    beginLogin: async () => ({
      qrcode: 'qr-1',
      qrUrl: 'https://example.invalid/qr',
      expiresIn: 300,
      expiresAt: Date.now() + 300_000,
    }),
    pollLogin: async () => ({ status: 'pending' }),
    startPollLoop: (loopOptions) => {
      calls.polls.push(loopOptions)
      return { stop() {}, done: Promise.resolve() }
    },
    readRawMessages: (payload) => (Array.isArray(payload) ? payload : (payload?.data ?? [])),
    normalizeInboundMessage: (raw) => {
      if (!raw || raw.message_type === 2) return null
      const text = raw.item_list?.[0]?.text_item?.text ?? ''
      if (!raw.from_user_id || !text) return null
      return {
        fromUserId: raw.from_user_id,
        text,
        itemTypes: ['text'],
        attachments: [],
        ...(raw.context_token ? { contextToken: raw.context_token } : {}),
        ...(raw.message_id ? { messageId: raw.message_id } : {}),
      }
    },
    normalizeOutboundText: (text) => String(text).replace(/\r\n|\r|\n/g, '\r\n'),
    chunkText: (text, max) => {
      const out = []
      for (let i = 0; i < text.length; i += max) out.push(text.slice(i, i + max))
      return out.length > 0 ? out : ['']
    },
    ...options.overrides,
  }
}

/**
 * Mount the channel service against a fake protocol layer.
 *
 * @param {object} [options] - harness options.
 * @returns {object} handles for assertions.
 */
function serviceHarness(options = {}) {
  const ilink = options.ilink ?? createIlink(options.ilinkOptions)
  const tools = options.tools ?? { registered: [], register(definition) { this.registered.push(definition) } }
  const systemPrompt = options.systemPrompt ?? { sections: [], section(section) { this.sections.push(section) } }
  const { ctx, listeners } = createCtx({ tools, systemPrompt, ...(options.services ?? {}) })
  const logs = []
  const dispose = applyService(ctx, { ...options.config }, {
    ilink,
    log: (level, message) => logs.push({ level, message }),
    ...(options.deps ?? {}),
  })
  return {
    ilink,
    tools,
    systemPrompt,
    ctx,
    listeners,
    logs,
    channel: getService(),
    dispose,
    emit: (event, ...args) => ctx.emit(event, ...args),
  }
}

test('channel start opens the long poll and publishes inbound messages', async (t) => {
  const h = serviceHarness()
  t.after(() => h.dispose())
  await settle()

  assert.ok(h.channel, 'the channel must be published in the registry')
  assert.equal(h.channel.connected, true)
  assert.equal(h.ilink.calls.polls.length, 1)
  assert.equal(h.channel.dataDirectory, 'C:/tmp/wechat-ilink')
  // The client is built from the record `scripts/login.mjs` writes.
  assert.equal(h.ilink.calls.clientOptions.token, 'tok-1')
  assert.equal(h.ilink.calls.clientOptions.fromUserId, 'bot-1')

  const received = []
  h.channel.onMessage((message) => received.push(message))
  const published = h.channel.ingest([
    { from_user_id: 'peer-1', message_type: 1, context_token: 'ctx-1', item_list: [{ text_item: { text: '你好' } }] },
    // bot's own message — protocol-level echo guard
    { from_user_id: 'bot-1', message_type: 2, item_list: [{ text_item: { text: 'echo' } }] },
    // self-addressed message — identity echo guard
    { from_user_id: 'bot-1', message_type: 1, item_list: [{ text_item: { text: 'self' } }] },
    // no text
    { from_user_id: 'peer-1', message_type: 1, item_list: [] },
  ])

  assert.equal(published, 1)
  assert.equal(received.length, 1)
  assert.deepEqual(received[0], {
    accountId: 'bot-1',
    fromUserId: 'peer-1',
    selfUserId: 'bot-1',
    text: '你好',
    itemTypes: ['text'],
    attachments: [],
    createdAt: received[0].createdAt,
    contextToken: 'ctx-1',
  })
  assert.equal(typeof received[0].createdAt, 'number')
})

test('inbound messages reach the bridge through the cordis event bus', async (t) => {
  const h = serviceHarness()
  t.after(() => h.dispose())
  await settle()
  const seen = []
  h.ctx.on('wechat-ilink/message', (message) => seen.push(message))
  h.channel.ingest([{ from_user_id: 'peer-9', message_type: 1, item_list: [{ text_item: { text: 'hi' } }] }])
  assert.equal(seen.length, 1)
  assert.equal(seen[0].fromUserId, 'peer-9')
})

test('channel sendText normalizes newlines before sending', async (t) => {
  const h = serviceHarness({ config: { maxMessageLength: 40 } })
  t.after(() => h.dispose())
  await settle()
  const result = await h.channel.sendText('peer-1', 'a\nb\r\nc', { contextToken: 'ctx-1' })
  assert.equal(result.chunkCount, 1)
  assert.deepEqual(result.messageIds, ['msg-1'])
  assert.equal(h.ilink.calls.sendMessage[0].text, 'a\r\nb\r\nc')
  assert.equal(h.ilink.calls.sendMessage[0].toUserId, 'peer-1')
  assert.equal(h.ilink.calls.sendMessage[0].contextToken, 'ctx-1')
})

test('channel sendText splits long text at maxMessageLength', async (t) => {
  const h = serviceHarness({ config: { maxMessageLength: 5 } })
  t.after(() => h.dispose())
  await settle()
  const result = await h.channel.sendText('peer-1', 'abcdefghijkl')
  assert.equal(result.chunkCount, 3)
  assert.deepEqual(result.messageIds, ['msg-1', 'msg-2', 'msg-3'])
  assert.deepEqual(
    h.ilink.calls.sendMessage.map((call) => call.text),
    ['abcde', 'fghij', 'kl'],
  )
})

test('channel sendText honours a per-call chunk cap and rejects empty input', async (t) => {
  const h = serviceHarness()
  t.after(() => h.dispose())
  await settle()
  await h.channel.sendText('peer-1', 'abcdef', { maxChars: 2 })
  assert.equal(h.ilink.calls.sendMessage.length, 3)
  await assert.rejects(() => h.channel.sendText('', 'hi'), /target user id/)
  await assert.rejects(() => h.channel.sendText('peer-1', '   '), /non-empty text/)
})

test('channel sendTyping is best-effort and never throws', async (t) => {
  const h = serviceHarness({ ilinkOptions: { failSendTyping: 'no ticket' } })
  t.after(() => h.dispose())
  await settle()
  assert.equal(await h.channel.sendTyping('peer-1', 'ctx-1'), false)
  assert.equal(await h.channel.sendTyping(''), false)
  assert.ok(h.logs.some((entry) => entry.level === 'warn'))
})

test('channel start without a stored token degrades instead of failing', async (t) => {
  const h = serviceHarness({ ilinkOptions: { account: {} } })
  t.after(() => h.dispose())
  await settle()
  assert.equal(h.channel.connected, false)
  assert.equal(h.ilink.calls.polls.length, 0)
  assert.ok(h.logs.some((entry) => entry.message.includes('no stored account')))
})

test('channel start survives an unavailable protocol layer', async (t) => {
  const ilink = createIlink()
  ilink.createAccountStore = () => {
    throw new Error('store exploded')
  }
  const h = serviceHarness({ ilink })
  t.after(() => h.dispose())
  await settle()
  assert.equal(h.channel.connected, false)
  assert.ok(h.logs.some((entry) => entry.level === 'error'))
})

test('channel stop aborts the poll and drops the registry entry', async (t) => {
  let aborted = false
  const ilink = createIlink()
  ilink.startPollLoop = (options) => {
    options.signal.addEventListener('abort', () => {
      aborted = true
    })
    return { stop() {}, done: Promise.resolve() }
  }
  const h = serviceHarness({ ilink })
  await settle()
  h.dispose()
  await settle()
  assert.equal(aborted, true)
  assert.equal(getService(), undefined)
})

// ─────────────── V-4a: autoConnect / V-4b: pollTimeoutMs must be real ───────────────

test('autoConnect=false does not start the long poll but keeps the row usable', async (t) => {
  const h = serviceHarness({ config: { autoConnect: false } })
  t.after(() => h.dispose())
  await settle()

  assert.equal(h.ilink.calls.polls.length, 0, 'no long poll may be opened')
  assert.equal(h.channel.connected, false)
  assert.equal(getService(), h.channel, 'the row must still publish itself')
  assert.ok(
    h.logs.some((entry) => /autoConnect=false/.test(entry.message)),
    'the operator decision must be logged',
  )

  // Outbound is independent of the inbound poll: the client is created lazily.
  const result = await h.channel.sendText('peer-1', 'proactive')
  assert.deepEqual(result.messageIds, ['msg-1'])

  // An explicit start() still connects.
  assert.equal(await h.channel.start(), true)
  assert.equal(h.ilink.calls.polls.length, 1)
  assert.equal(h.channel.connected, true)
})

test('autoConnect defaults to true and still connects', async (t) => {
  const h = serviceHarness()
  t.after(() => h.dispose())
  await settle()
  assert.equal(h.ilink.calls.polls.length, 1)
})

test('pollTimeoutMs is forwarded to the client factory', async (t) => {
  const h = serviceHarness({ config: { pollTimeoutMs: 12_345 } })
  t.after(() => h.dispose())
  await settle()
  assert.equal(h.ilink.calls.clientOptions.pollTimeoutMs, 12_345)
})

test('pollTimeoutMs defaults to the config default when unset', async (t) => {
  const h = serviceHarness()
  t.after(() => h.dispose())
  await settle()
  assert.equal(h.ilink.calls.clientOptions.pollTimeoutMs, 45_000)
})

test('withPollTimeout bounds getUpdates and treats an expired window as an idle cycle', async () => {
  let calls = 0
  const base = {
    token: 'tok',
    async getUpdates({ signal } = {}) {
      calls += 1
      return new Promise((_resolve, reject) => {
        signal?.addEventListener(
          'abort',
          () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
          { once: true },
        )
      })
    },
  }
  const wrapped = withPollTimeout(base, 20)
  assert.equal(wrapped.token, 'tok', 'the wrapper must keep the client surface')
  const startedAt = Date.now()
  const result = await wrapped.getUpdates({ buf: 'cursor-1' })
  assert.ok(Date.now() - startedAt >= 15, 'the call must be bounded by the configured window')
  assert.deepEqual(result.rawMessages, [])
  assert.equal(result.buf, 'cursor-1', 'the cursor must be preserved across an idle cycle')
  assert.equal(result.longpollingTimeoutMs, 20)
  assert.equal(calls, 1)
})

test('withPollTimeout is a no-op without a usable window or a pollable client', () => {
  const pollable = { async getUpdates() {} }
  assert.equal(withPollTimeout(pollable, undefined), pollable)
  assert.equal(withPollTimeout(pollable, 0), pollable)
  assert.equal(withPollTimeout(pollable, Number.NaN), pollable)
  const notPollable = { token: 't' }
  assert.equal(withPollTimeout(notPollable, 1_000), notPollable)
})

test('withPollTimeout does not swallow real protocol failures', async () => {
  const wrapped = withPollTimeout(
    {
      async getUpdates() {
        throw ilinkError(-14, 'session expired')
      },
    },
    50,
  )
  await assert.rejects(() => wrapped.getUpdates({}), /session expired/)
})

test('withPollTimeout stops the deadline when the loop signal aborts', async () => {
  const controller = new AbortController()
  const wrapped = withPollTimeout(
    {
      async getUpdates({ signal } = {}) {
        // An already-aborted signal never fires its listener, so mirror what
        // fetch does: reject immediately.
        if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' })
        return new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), {
            once: true,
          })
        })
      },
    },
    10_000,
  )
  controller.abort()
  await assert.rejects(() => wrapped.getUpdates({ buf: '', signal: controller.signal }), /aborted/)
})

test('the wechat_send tool is registered and sends through the channel', async (t) => {
  const h = serviceHarness()
  t.after(() => h.dispose())
  await settle()
  assert.equal(h.tools.registered.length, 1)
  const tool = h.tools.registered[0]
  assert.equal(tool.name, 'wechat_send')
  assert.deepEqual(tool.parameters.required, ['text'])
  assert.equal(h.systemPrompt.sections[0].name, 'tool:wechat_send')

  const result = await tool.execute({ toUserId: 'peer-1', text: 'hello' })
  assert.equal(result.ok, true)
  assert.match(result.message, /peer-1/)
  assert.equal(h.ilink.calls.sendMessage[0].text, 'hello')

  const missing = await tool.execute({ text: 'hello' })
  assert.equal(missing.ok, false)
  assert.match(missing.message, /toUserId/)
  const empty = await tool.execute({ toUserId: 'peer-1', text: '  ' })
  assert.equal(empty.ok, false)
})

test('toolEnabled=false skips tool registration entirely', async (t) => {
  const h = serviceHarness({ config: { toolEnabled: false } })
  t.after(() => h.dispose())
  await settle()
  assert.equal(h.tools.registered.length, 0)
})

test('a failing send surfaces as a failed tool result, not a throw', async (t) => {
  const h = serviceHarness({ ilinkOptions: { failSendMessage: 'gateway down' } })
  t.after(() => h.dispose())
  await settle()
  const result = await h.tools.registered[0].execute({ toUserId: 'peer-1', text: 'hello' })
  assert.equal(result.ok, false)
  assert.match(result.message, /gateway down/)
})

test('WechatIlinkChannel can be driven directly with injected factories', async (t) => {
  const ilink = createIlink()
  const channel = new WechatIlinkChannel({
    ctx: { emit() {} },
    config: { maxMessageLength: 10, requestTimeoutMs: 1000, baseUrl: 'https://example.invalid' },
    deps: { ilink, dataDirectory: 'C:/tmp/direct' },
    log: () => {},
  })
  assert.equal(channel.dataDirectory, 'C:/tmp/direct')
  assert.equal(channel.getStatus().connected, false)
  assert.equal(await channel.start(), true)
  assert.equal(channel.getStatus().connected, true)
  await channel.stop()
  assert.equal(channel.connected, false)
})

// ───────────────────── integration with the real protocol layer ─────────────────────

/**
 * Whether the real `src/ilink/**` barrel is importable.
 *
 * The integration test below drives the *real* poll loop and the *real*
 * normalizer with an injected fake client, so it still touches no network. It
 * is skipped (rather than failed) when the protocol layer is absent, keeping
 * this suite runnable while that layer is developed in parallel.
 */
let protocolLayerAvailable = true
/** The real poll loop, so the error path is exercised end to end. */
let realStartPollLoop
try {
  const barrel = await import('../src/ilink/index.js')
  realStartPollLoop = barrel.startPollLoop
} catch {
  protocolLayerAvailable = false
}

test(
  'the real protocol layer drives the channel end to end (fake client, no network)',
  { skip: protocolLayerAvailable ? false : 'src/ilink/** is not available' },
  async (t) => {
    const batches = [
      {
        rawMessages: [
          {
            from_user_id: 'peer-1',
            message_type: 1,
            context_token: 'ctx-9',
            message_id: 'mid-1',
            item_list: [{ type: 1, text_item: { text: '你好' } }],
          },
          // The bot's own message: the real normalizer must drop it.
          { from_user_id: 'bot-1', message_type: 2, item_list: [{ type: 1, text_item: { text: 'echo' } }] },
        ],
        buf: 'buf-1',
      },
      { rawMessages: [], buf: 'buf-2' },
    ]
    let served = 0
    const client = {
      token: 'tok-real',
      async getUpdates() {
        const batch = batches[Math.min(served, batches.length - 1)]
        served += 1
        // Yield so the loop stays cancellable and does not spin.
        await new Promise((resolve) => setTimeout(resolve, 2))
        return batch
      },
      async sendMessage() {
        return {}
      },
      async sendTyping() {
        return true
      },
    }
    const written = []
    const store = {
      path: 'C:/tmp/integration/account.json',
      async load() {
        return { accountId: 'bot-1', botToken: 'tok-real', botId: 'bot-1', savedAt: '2026-01-01T00:00:00.000Z' }
      },
      async save() {},
      async clear() {},
      async readBuf() {
        return ''
      },
      async writeBuf(key, buf) {
        written.push([key, buf])
      },
    }
    const { ctx } = createCtx({})
    const logs = []
    const dispose = applyService(ctx, {}, {
      clientFactory: () => client,
      storeFactory: () => store,
      dataDirectory: 'C:/tmp/integration',
      backoffMs: 5,
      log: (level, message) => logs.push({ level, message }),
    })
    t.after(() => {
      dispose()
      clearService()
    })
    const seen = []
    ctx.on('wechat-ilink/message', (message) => seen.push(message))

    for (let i = 0; i < 200 && seen.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    assert.equal(seen.length, 1, `expected one message, logs: ${JSON.stringify(logs)}`)
    assert.equal(seen[0].fromUserId, 'peer-1')
    assert.equal(seen[0].text, '你好')
    assert.equal(seen[0].contextToken, 'ctx-9')
    assert.equal(seen[0].messageId, 'mid-1')
    assert.equal(seen[0].accountId, 'bot-1')
    assert.equal(seen[0].selfUserId, 'bot-1')

    for (let i = 0; i < 100 && written.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    assert.deepEqual(written[0], ['bot-1', 'buf-1'], 'the poll cursor must be persisted')
    assert.equal(getService()?.connected, true)
  },
)

// ─────────────────── workspace / existing-session reuse (task-5) ───────────────────

test('/workspaces lists the host workspaces and marks the current one', async (t) => {
  const registry = createWorkspaceRegistry({
    workspaces: [
      { path: 'C:/work/alpha', title: 'Alpha', sessionIds: ['s-1', 's-2'] },
      { path: 'C:/work/beta', sessionIds: [] },
    ],
  })
  const h = harness({ services: { workspaceRegistry: registry } })
  t.after(() => h.cleanup())

  h.emit('wechat-ilink/message', inbound({ text: '/cwd C:/work/alpha' }))
  await settle()
  h.emit('wechat-ilink/message', inbound({ text: '/workspaces' }))
  await settle()

  const reply = h.channel.sent.at(-1).text
  assert.match(reply, /DSH 工作区（2 个）/)
  assert.match(reply, /alpha/)
  assert.match(reply, /2 个会话/)
  assert.match(reply, /✅ .*alpha/, 'the current workspace must be marked')
})

test('/workspaces degrades when the host mounts no workspace registry', async (t) => {
  const h = harness()
  t.after(() => h.cleanup())
  h.emit('wechat-ilink/message', inbound({ text: '/workspaces' }))
  await settle()
  assert.match(h.channel.sent[0].text, /当前宿主不提供该能力/)
})

test('/cwd selects the workspace new sessions are created in', async (t) => {
  const registry = createWorkspaceRegistry({ workspaces: [{ path: 'C:/work/alpha' }] })
  const h = harness({ services: { workspaceRegistry: registry } })
  t.after(() => h.cleanup())

  h.emit('wechat-ilink/message', inbound({ text: '/cwd C:/work/alpha' }))
  await settle()
  assert.match(h.channel.sent.at(-1).text, /工作区已切换/)

  h.emit('wechat-ilink/message', inbound({ text: '开始干活' }))
  await settle()
  assert.equal(h.agents.calls.create[0].meta.cwd, 'C:/work/alpha')
  assert.deepEqual(registry.calls.attach.at(-1), {
    path: 'C:/work/alpha',
    sessionId: h.agents.calls.create[0].sessionId,
  })
})

test('/cwd registers a previously unknown directory through the registry', async (t) => {
  const registry = createWorkspaceRegistry({ workspaces: [] })
  const h = harness({ services: { workspaceRegistry: registry } })
  t.after(() => h.cleanup())
  h.emit('wechat-ilink/message', inbound({ text: '/cwd C:/work/new' }))
  await settle()
  assert.deepEqual(registry.calls.create, ['C:/work/new'])
  assert.match(h.channel.sent.at(-1).text, /工作区已切换/)
})

test('/cwd reports a failure instead of binding an unusable workspace', async (t) => {
  const registry = createWorkspaceRegistry({ workspaces: [], failCreate: true })
  const h = harness({ services: { workspaceRegistry: registry } })
  t.after(() => h.cleanup())
  h.emit('wechat-ilink/message', inbound({ text: '/cwd C:/nope' }))
  await settle()
  assert.match(h.channel.sent.at(-1).text, /无法把工作区切换为/)
  assert.equal(h.agents.calls.create.length, 0)
})

test('/cwd without an argument reports the current workspace', async (t) => {
  const registry = createWorkspaceRegistry({ workspaces: [{ path: 'C:/work/alpha' }] })
  const h = harness({ services: { workspaceRegistry: registry } })
  t.after(() => h.cleanup())
  h.emit('wechat-ilink/message', inbound({ text: '/cwd' }))
  await settle()
  assert.match(h.channel.sent.at(-1).text, /C:\/work/, 'the fallback cwd must be shown')
})

test('/sessions lists existing sessions and hides subagent/archived ones', async (t) => {
  const query = createSessionQuery({
    records: [
      sessionRecord('session-a', { cwd: 'C:/work/alpha' }),
      sessionRecord('session-sub', { origin: 'subagent' }),
      sessionRecord('session-archived'),
    ],
  })
  const registry = createWorkspaceRegistry({ archivedSessionIds: ['session-archived'] })
  const h = harness({ services: { sessionQuery: query, workspaceRegistry: registry } })
  t.after(() => h.cleanup())

  h.emit('wechat-ilink/message', inbound({ text: '/sessions' }))
  await settle()
  const reply = h.channel.sent.at(-1).text
  assert.match(reply, /session-a/)
  assert.doesNotMatch(reply, /session-sub/)
  assert.doesNotMatch(reply, /session-archived/)
})

test('/sessions degrades when the host mounts no session query', async (t) => {
  const h = harness()
  t.after(() => h.cleanup())
  h.emit('wechat-ilink/message', inbound({ text: '/sessions' }))
  await settle()
  assert.match(h.channel.sent[0].text, /当前宿主不提供该能力/)
})

test('/use binds the conversation to an existing session and resumes it', async (t) => {
  const query = createSessionQuery({ records: [sessionRecord('session-existing', { cwd: 'C:/work/alpha' })] })
  const h = harness({ agents: { resumable: ['session-existing'] }, services: { sessionQuery: query } })
  t.after(() => h.cleanup())

  h.emit('wechat-ilink/message', inbound({ text: '/use session-existing' }))
  await settle()
  assert.match(h.channel.sent.at(-1).text, /已绑定到会话 session-existing/)
  assert.equal(h.agents.calls.resume.at(-1).resumeSessionId, 'session-existing')

  h.emit('wechat-ilink/message', inbound({ text: '接着聊' }))
  await settle()
  assert.equal(h.agents.calls.create.length, 0, 'no new session may be minted')
  const agent = h.agents.live.get('session-existing')
  assert.equal(agent.sent.at(-1).message.content[0].text, '接着聊')
})

test('/use still binds when the session can only be reopened, not resumed', async (t) => {
  const query = createSessionQuery({ records: [sessionRecord('session-existing')] })
  const h = harness({ services: { sessionQuery: query } })
  t.after(() => h.cleanup())
  h.emit('wechat-ilink/message', inbound({ text: '/use session-existing' }))
  await settle()
  // `resume` failed in the fake, so the bridge reopened the same id.
  assert.equal(h.agents.calls.create[0].sessionId, 'session-existing')
  assert.match(h.channel.sent.at(-1).text, /已绑定到会话/)
})

test('/use refuses an unknown session id', async (t) => {
  const query = createSessionQuery({ records: [sessionRecord('session-existing')] })
  const h = harness({ services: { sessionQuery: query } })
  t.after(() => h.cleanup())
  h.emit('wechat-ilink/message', inbound({ text: '/use session-nope' }))
  await settle()
  assert.match(h.channel.sent.at(-1).text, /未找到会话/)
  assert.equal(h.agents.calls.create.length, 0)
})

test('/use without an argument explains the usage', async (t) => {
  const h = harness({ services: { sessionQuery: createSessionQuery({}) } })
  t.after(() => h.cleanup())
  h.emit('wechat-ilink/message', inbound({ text: '/use' }))
  await settle()
  assert.match(h.channel.sent.at(-1).text, /用法：\/use/)
})

test('/peek renders the recent conversation of the bound session', async (t) => {
  const events = [
    userEvent('你好'),
    assistantEvent('你好，有什么可以帮你？'),
    userEvent('内部注入', { source: { kind: 'plugin' } }),
  ]
  const h = harness()
  t.after(() => h.cleanup())
  const sessionId = await dispatchOne(h)
  h.agents.live.get(sessionId).session.snapshotEvents = () => events

  h.emit('wechat-ilink/message', inbound({ text: '/peek' }))
  await settle()
  const reply = h.channel.sent.at(-1).text
  assert.match(reply, /🙋 用户：你好/)
  assert.match(reply, /🤖 助手：你好，有什么可以帮你？/)
  assert.doesNotMatch(reply, /内部注入/, 'synthesized user messages must stay hidden')
})

test('/peek reads a persisted session through sessionQuery', async (t) => {
  const query = createSessionQuery({ histories: { 'session-old': [userEvent('旧对话'), assistantEvent('旧回复')] } })
  const h = harness({ services: { sessionQuery: query } })
  t.after(() => h.cleanup())
  h.emit('wechat-ilink/message', inbound({ text: '/peek session-old' }))
  await settle()
  assert.deepEqual(query.calls.readSession, ['session-old'])
  assert.match(h.channel.sent.at(-1).text, /旧对话/)
})

test('/peek degrades when neither live nor persisted history is readable', async (t) => {
  const h = harness()
  t.after(() => h.cleanup())
  h.emit('wechat-ilink/message', inbound({ text: '/peek session-gone' }))
  await settle()
  assert.match(h.channel.sent.at(-1).text, /当前宿主不提供该能力/)
})

test('/peek without a bound session explains the usage', async (t) => {
  const h = harness()
  t.after(() => h.cleanup())
  h.emit('wechat-ilink/message', inbound({ text: '/peek' }))
  await settle()
  assert.match(h.channel.sent.at(-1).text, /用法：\/peek/)
})

test('/current reports the bound workspace, session and host capabilities', async (t) => {
  const registry = createWorkspaceRegistry({ workspaces: [{ path: 'C:/work/alpha' }] })
  const query = createSessionQuery({ records: [sessionRecord('session-a')] })
  const h = harness({ services: { workspaceRegistry: registry, sessionQuery: query } })
  t.after(() => h.cleanup())

  h.emit('wechat-ilink/message', inbound({ text: '/cwd C:/work/alpha' }))
  await settle()
  h.emit('wechat-ilink/message', inbound({ text: '/current' }))
  await settle()
  const reply = h.channel.sent.at(-1).text
  assert.match(reply, /工作区：.*alpha/)
  assert.match(reply, /会话：.*尚未创建/)
  assert.match(reply, /工作区✅/)
  assert.match(reply, /会话✅/)
})

test('/current marks missing host capabilities', async (t) => {
  const h = harness()
  t.after(() => h.cleanup())
  h.emit('wechat-ilink/message', inbound({ text: '/current' }))
  await settle()
  const reply = h.channel.sent.at(-1).text
  assert.match(reply, /工作区❌/)
  assert.match(reply, /会话❌/)
})

test('the workspace binding survives a restart (persisted peer state)', async (t) => {
  const choices = new MemorySessionChoiceStore()
  const registry = createWorkspaceRegistry({ workspaces: [{ path: 'C:/work/alpha' }] })
  const h = harness({ choices, services: { workspaceRegistry: registry } })
  h.emit('wechat-ilink/message', inbound({ text: '/cwd C:/work/alpha' }))
  await settle()
  const sessionId = await dispatchOne(h)
  h.cleanup()

  // A fresh bridge over the same memo (as after a DSH restart).
  const restarted = harness({ choices, services: { workspaceRegistry: registry } })
  t.after(() => restarted.cleanup())
  restarted.emit('wechat-ilink/message', inbound({ text: '/current' }))
  await settle()
  const reply = restarted.channel.sent.at(-1).text
  assert.match(reply, /工作区：.*alpha/)
  assert.match(reply, new RegExp(sessionId))
})

test('/new keeps the workspace but forgets the session', async (t) => {
  const registry = createWorkspaceRegistry({ workspaces: [{ path: 'C:/work/alpha' }] })
  const h = harness({ services: { workspaceRegistry: registry } })
  t.after(() => h.cleanup())
  h.emit('wechat-ilink/message', inbound({ text: '/cwd C:/work/alpha' }))
  await settle()
  const first = await dispatchOne(h)

  h.emit('wechat-ilink/message', inbound({ text: '/new' }))
  await settle()
  await dispatchOne(h, '第二段')

  assert.equal(h.agents.calls.create.length, 2)
  assert.notEqual(h.agents.calls.create[1].sessionId, first)
  assert.equal(h.agents.calls.create[1].meta.cwd, 'C:/work/alpha', 'the workspace must survive /new')
})

test('the UI-bound default target seeds a fresh conversation', async (t) => {
  const registry = createWorkspaceRegistry({ workspaces: [{ path: 'C:/ui/picked' }] })
  const h = harness({ services: { workspaceRegistry: registry } })
  t.after(() => h.cleanup())
  // The service row publishes the UI binding through the process-local
  // registry (`getService().getTarget()`), never through Cordis lookup.
  setService({ ...h.channel, getTarget: () => ({ workspace: 'C:/ui/picked' }) })
  h.emit('wechat-ilink/message', inbound({ text: 'hi' }))
  await settle()
  assert.equal(h.agents.calls.create[0].meta.cwd, 'C:/ui/picked')
})

test('a conversation workspace overrides the UI default target', async (t) => {
  const registry = createWorkspaceRegistry({ workspaces: [{ path: 'C:/ui/picked' }, { path: 'C:/peer/picked' }] })
  const h = harness({ services: { workspaceRegistry: registry } })
  t.after(() => h.cleanup())
  setService({ ...h.channel, getTarget: () => ({ workspace: 'C:/ui/picked' }) })
  h.emit('wechat-ilink/message', inbound({ text: '/cwd C:/peer/picked' }))
  await settle()
  h.emit('wechat-ilink/message', inbound({ text: 'hi' }))
  await settle()
  assert.equal(h.agents.calls.create[0].meta.cwd, 'C:/peer/picked')
})

test('a failing workspace attach never blocks the reply path', async (t) => {
  // The registry must own the conversation's cwd, or the bridge would create a
  // fresh workspace instead of exercising the failing attach.
  const registry = createWorkspaceRegistry({ workspaces: [{ path: 'C:/work' }] })
  registry.workspaces[0].attachSession = async () => {
    throw new Error('attach exploded')
  }
  const h = harness({ services: { workspaceRegistry: registry } })
  t.after(() => h.cleanup())
  await dispatchOne(h)
  assert.equal(h.agents.calls.create.length, 1)
  assert.ok(
    h.logs.some((entry) => /could not attach/.test(entry.message)),
    `the failure must be logged, not thrown: ${JSON.stringify(h.logs)}`,
  )
})

test('the session-choice memo accepts the legacy string format', () => {
  const store = new MemorySessionChoiceStore()
  store.set('k', 'session-legacy')
  assert.deepEqual(store.get('k'), { sessionId: 'session-legacy' })
  store.set('k', { cwd: 'C:/w' })
  assert.deepEqual(store.get('k'), { sessionId: 'session-legacy', cwd: 'C:/w' })
  store.set('k2', { cwd: 'C:/only' })
  assert.deepEqual(store.get('k2'), { cwd: 'C:/only' })
  store.delete('k')
  assert.equal(store.get('k'), undefined)
})


// ─────────────── service surface for the host Web UI (task-5 / task-6) ───────────────

test('getStatus exposes the UI contract and never leaks the bot token', async (t) => {
  const h = serviceHarness()
  t.after(() => h.dispose())
  await settle()
  const status = h.channel.getStatus()
  assert.equal(status.connected, true)
  assert.equal(status.polling, true)
  assert.equal(status.botId, 'bot-1')
  assert.equal(status.accountId, 'bot-1')
  assert.equal(status.bound, false)
  assert.equal(status.lastError, undefined)
  assert.equal(status.hasToken, true)
  assert.ok(!('token' in status) && !('botToken' in status), 'no credential may be exposed')
  assert.doesNotMatch(JSON.stringify(status), /tok-1/)
})

test('getStatus surfaces the last poll error', async (t) => {
  const ilink = createIlink()
  let captured
  ilink.startPollLoop = (options) => {
    captured = options
    return { stop() {}, done: Promise.resolve() }
  }
  const h = serviceHarness({ ilink })
  t.after(() => h.dispose())
  await settle()
  captured.onError(new Error('gateway hiccup'))
  assert.match(h.channel.getStatus().lastError, /gateway hiccup/)
})

test('listWorkspaces / listSessions degrade to {available:false, items:[]}', async (t) => {
  const h = serviceHarness()
  t.after(() => h.dispose())
  await settle()
  assert.deepEqual(h.channel.listWorkspaces(), {
    available: false,
    items: [],
    reason: 'workspace-registry-unavailable',
  })
  const sessions = await h.channel.listSessions()
  assert.equal(sessions.available, false)
  assert.deepEqual(sessions.items, [])
})

test('listWorkspaces / listSessions expose the host data to the UI', async (t) => {
  const registry = createWorkspaceRegistry({ workspaces: [{ path: 'C:/ui/ws', sessionIds: ['s-1'] }] })
  const query = createSessionQuery({ records: [sessionRecord('session-ui', { cwd: 'C:/ui/ws' })] })
  const h = serviceHarness({ services: { workspaceRegistry: registry, sessionQuery: query } })
  t.after(() => h.dispose())
  await settle()

  const workspaces = h.channel.listWorkspaces()
  assert.equal(workspaces.available, true)
  assert.equal(workspaces.items[0].path, 'C:/ui/ws')
  assert.equal(workspaces.items[0].sessionCount, 1)

  const sessions = await h.channel.listSessions({ workspace: 'C:/ui/ws' })
  assert.equal(sessions.available, true)
  assert.equal(sessions.items[0].id, 'session-ui')
  const filtered = await h.channel.listSessions({ workspace: 'C:/other' })
  assert.deepEqual(filtered.items, [])
})

test('the UI aliases resolve to the same implementations', async (t) => {
  const registry = createWorkspaceRegistry({ workspaces: [{ path: 'C:/ui/ws' }] })
  const query = createSessionQuery({ records: [sessionRecord('session-ui')] })
  const h = serviceHarness({ services: { workspaceRegistry: registry, sessionQuery: query } })
  t.after(() => h.dispose())
  await settle()

  assert.deepEqual(h.channel.getWorkspaces(), h.channel.listWorkspaces())
  assert.deepEqual(await h.channel.getSessions(), await h.channel.listSessions())
  for (const name of ['bind', 'setBinding', 'selectBinding']) {
    assert.equal(typeof h.channel[name], 'function', `${name} must exist for the UI duck-typing probe`)
  }
})

test('bindTarget persists the UI binding and getTarget reads it back', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wechat-feishu-linker-'))
  t.after(() => fsp.rm(dir, { recursive: true, force: true }))
  const registry = createWorkspaceRegistry({ workspaces: [{ path: 'C:/ui/ws' }] })
  const query = createSessionQuery({ records: [sessionRecord('session-ui')] })
  const h = serviceHarness({
    services: { workspaceRegistry: registry, sessionQuery: query },
    deps: { dataDirectory: dir },
  })
  t.after(() => h.dispose())
  await settle()

  assert.equal(h.channel.getTarget(), undefined)
  const bound = await h.channel.bind({ workspace: 'C:/ui/ws', sessionId: 'session-ui' })
  assert.equal(bound.ok, true)
  assert.equal(bound.workspace, 'C:/ui/ws')
  assert.equal(bound.sessionId, 'session-ui')
  assert.deepEqual(h.channel.getTarget(), { workspace: 'C:/ui/ws', sessionId: 'session-ui' })
  assert.equal(h.channel.getStatus().bound, true)

  const written = JSON.parse(await fsp.readFile(path.join(dir, 'target.json'), 'utf-8'))
  assert.deepEqual(written, { workspace: 'C:/ui/ws', sessionId: 'session-ui' })

  // A second channel over the same directory (a restart) sees the binding.
  const restarted = serviceHarness({
    services: { workspaceRegistry: registry, sessionQuery: query },
    deps: { dataDirectory: dir },
  })
  t.after(() => restarted.dispose())
  await settle()
  assert.deepEqual(restarted.channel.getTarget(), { workspace: 'C:/ui/ws', sessionId: 'session-ui' })
})

test('bindTarget rejects an empty or unusable target without throwing', async (t) => {
  const registry = createWorkspaceRegistry({ workspaces: [{ path: 'C:/ui/ws' }] })
  const query = createSessionQuery({ records: [sessionRecord('session-ui')] })
  const h = serviceHarness({ services: { workspaceRegistry: registry, sessionQuery: query } })
  t.after(() => h.dispose())
  await settle()

  const empty = await h.channel.bindTarget({})
  assert.equal(empty.ok, false)
  assert.match(empty.message, /workspace 或 sessionId/)

  const unknown = await h.channel.bindTarget({ sessionId: 'session-nope' })
  assert.equal(unknown.ok, false)
  assert.match(unknown.message, /未找到会话/)

  assert.equal(h.channel.getTarget(), undefined)
})

test('beginLogin and pollLogin store the fresh credentials', async (t) => {
  const ilink = createIlink()
  ilink.pollLogin = async () => ({ status: 'success', botToken: 'tok-new', botId: 'bot-new' })
  const h = serviceHarness({ ilink })
  t.after(() => h.dispose())
  await settle()

  const begin = await h.channel.beginLogin()
  assert.equal(begin.ok, true)
  assert.equal(begin.qrcode, 'qr-1')
  assert.match(begin.qrUrl, /^https:/)

  const poll = await h.channel.pollLogin('qr-1')
  assert.equal(poll.status, 'success')
  assert.equal(poll.botId, 'bot-new')
  assert.equal(h.ilink.calls.saved.at(-1).botToken, 'tok-new')
  assert.equal(h.ilink.calls.saved.at(-1).accountId, 'bot-new')
})

test('pollLogin reports a non-success status and stores nothing', async (t) => {
  const ilink = createIlink()
  ilink.pollLogin = async () => ({ status: 'scanned' })
  const h = serviceHarness({ ilink })
  t.after(() => h.dispose())
  await settle()
  assert.deepEqual(await h.channel.pollLogin('qr-1'), { available: true, ok: true, status: 'scanned' })
  assert.equal(h.ilink.calls.saved.length, 0)
})

test('[REGRESSION] a success without a credential is not reported as a bind', async (t) => {
  // Reporting `success` here is what let the UI say 「绑定成功」 for a bind that
  // stored nothing — the state the contact then discovers on the next restart.
  const ilink = createIlink()
  ilink.pollLogin = async () => ({ status: 'success', botId: 'bot-new' })
  const h = serviceHarness({ ilink })
  t.after(() => h.dispose())
  await settle()

  const poll = await h.channel.pollLogin('qr-1')
  assert.equal(poll.ok, false)
  assert.equal(poll.reason, 'missing-credential')
  assert.notEqual(poll.status, 'success')
  assert.equal(h.ilink.calls.saved.length, 0, 'nothing may be persisted for a credential-less success')
})

test('[REGRESSION] a credential that cannot be written fails the bind instead of being swallowed', async (t) => {
  // The write failure used to be logged as a warning and the bind still
  // reported success: the channel ran until the next restart, then came back
  // unbound with no explanation.
  const ilink = createIlink({ saveFails: true })
  ilink.pollLogin = async () => ({ status: 'success', botToken: 'tok-new', botId: 'bot-new' })
  const h = serviceHarness({ ilink })
  t.after(() => h.dispose())
  await settle()

  const poll = await h.channel.pollLogin('qr-1')
  assert.equal(poll.ok, false)
  assert.equal(poll.reason, 'persist-failed')
  assert.match(poll.message, /凭据写入失败/)
})

test('beginLogin / pollLogin degrade when the protocol layer has no login flow', async (t) => {
  const ilink = createIlink()
  delete ilink.beginLogin
  delete ilink.pollLogin
  const h = serviceHarness({ ilink })
  t.after(() => h.dispose())
  await settle()
  assert.equal((await h.channel.beginLogin()).available, false)
  assert.equal((await h.channel.pollLogin('qr-1')).available, false)
  assert.equal((await h.channel.pollLogin('')).reason, 'missing-qrcode')
})

test('beginLogin reports a protocol failure instead of throwing', async (t) => {
  const ilink = createIlink()
  ilink.beginLogin = async () => {
    throw new Error('gateway unreachable')
  }
  const h = serviceHarness({ ilink })
  t.after(() => h.dispose())
  await settle()
  const result = await h.channel.beginLogin()
  assert.equal(result.ok, false)
  assert.match(result.message, /gateway unreachable/)
  assert.match(h.channel.getStatus().lastError, /gateway unreachable/)
})

test('logout stops the poll, clears the credentials and allows a fresh start', async (t) => {
  const h = serviceHarness()
  t.after(() => h.dispose())
  await settle()
  assert.equal(h.channel.connected, true)

  const result = await h.channel.logout()
  assert.equal(result.ok, true)
  assert.equal(h.ilink.calls.cleared, 1)
  assert.equal(h.channel.connected, false)
  assert.equal(h.channel.getStatus().hasToken, false)

  // The row is still mounted and can connect again after a new login.
  h.ilink.store.account = { accountId: 'bot-1', botToken: 'tok-2', botId: 'bot-1' }
  assert.equal(await h.channel.start(), true)
  assert.equal(h.channel.connected, true)
})

test('the service mounts the host web API when a webServer is composed', async (t) => {
  const routes = []
  const webServer = {
    register(route) {
      routes.push(route)
      return () => {}
    },
  }
  const h = serviceHarness({ services: { webServer } })
  t.after(() => h.dispose())
  await settle()
  assert.equal(routes.length, 1)
  assert.equal(routes[0].kind, 'prefix')
  assert.equal(routes[0].path, '/wechat-ilink/api')
  assert.equal(typeof routes[0].handler, 'function')
})

test('a missing webServer never blocks the plugin row', async (t) => {
  const h = serviceHarness()
  t.after(() => h.dispose())
  await settle()
  assert.ok(h.channel, 'the channel must still be published')
  assert.equal(h.channel.connected, true)
})


// ───────────── V2-1: projection-cache hint / V2-4: poll timeout semantics ─────────────

/**
 * A host-shaped `sessionProjectionCache`.
 *
 * Mirrors `@deepseek-ai/dsh-session-projection` `lib/index.js:246`
 * (`keys === undefined ? undefined : new Set(keys)`), so passing a falsy
 * placeholder such as `0` throws exactly as the real host does.
 *
 * @param {Record<string, unknown>} rows - projection key → value.
 * @returns {object} the cache plus recorded calls.
 */
function hostShapedProjectionCache(rows) {
  const calls = []
  return {
    calls,
    cachedSnapshot(meta, keys) {
      calls.push([meta, keys])
      const selected = keys === undefined ? undefined : new Set(keys)
      const values = {}
      for (const [key, value] of Object.entries(rows)) {
        if (selected !== undefined && !selected.has(key)) continue
        values[key] = value
      }
      return Object.keys(values).length === 0 ? undefined : { asOfSeq: 7, values }
    },
  }
}

test('cachedHint omits the keys argument and returns title + lastActivityAt', () => {
  const cache = hostShapedProjectionCache({
    title: '修复登录',
    sessionListMetadata: { lastPromptAt: 1_700_000_000_123 },
  })
  const host = new HostAccess({
    ctx: { get: (name) => (name === 'sessionProjectionCache' ? cache : undefined) },
    log: () => {},
  })
  const header = { id: 'session-1', cwd: 'C:/work' }
  assert.deepEqual(host.cachedHint(header), { title: '修复登录', lastActivityAt: 1_700_000_000_123 })
  assert.equal(cache.calls.length, 1)
  assert.equal(cache.calls[0][0], header)
  assert.equal(
    cache.calls[0][1],
    undefined,
    'keys must be omitted — `new Set(0)` throws in the host (V2-1)',
  )
})

test('cachedHint degrades on an empty or throwing cache without emptying the listing', () => {
  const empty = new HostAccess({
    ctx: { get: () => ({ cachedSnapshot: () => undefined }) },
    log: () => {},
  })
  assert.deepEqual(empty.cachedHint({ id: 's' }), {})
  assert.deepEqual(empty.cachedHint(undefined), {})

  const warnings = []
  const broken = new HostAccess({
    ctx: {
      get: () => ({
        cachedSnapshot() {
          throw new TypeError('0 is not iterable')
        },
      }),
    },
    log: (level, message) => warnings.push([level, message]),
  })
  assert.deepEqual(broken.cachedHint({ id: 's' }), {})
  assert.equal(warnings.length, 1)
  assert.match(warnings[0][1], /projection cache hint failed/)
})

test('/sessions shows the projection title and recency for a non-live session', async (t) => {
  const query = createSessionQuery({ records: [sessionRecord('session-a')] })
  const cache = hostShapedProjectionCache({
    title: '修复登录',
    sessionListMetadata: { lastPromptAt: 1_700_000_000_123 },
  })
  const h = harness({ services: { sessionQuery: query, sessionProjectionCache: cache } })
  t.after(() => h.cleanup())
  h.emit('wechat-ilink/message', inbound({ text: '/sessions' }))
  await settle()
  const reply = h.channel.sent.at(-1).text
  assert.match(reply, /修复登录/, 'the cached title must reach the listing')
  assert.doesNotMatch(reply, /（未命名）/)
})

test('withPollTimeout propagates a transport abort that is not its own deadline', async () => {
  const wrapped = withPollTimeout(
    {
      async getUpdates() {
        throw Object.assign(new Error('transport timeout'), { name: 'AbortError' })
      },
    },
    60_000,
  )
  await assert.rejects(
    () => wrapped.getUpdates({ buf: 'cursor-1' }),
    /transport timeout/,
    'a transport abort must reach the poll loop error path, not become an idle cycle',
  )
})

test('withPollTimeout still reports plain network failures', async () => {
  const wrapped = withPollTimeout(
    {
      async getUpdates() {
        throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })
      },
    },
    60_000,
  )
  await assert.rejects(() => wrapped.getUpdates({}), /socket hang up/)
})

test(
  'a transport timeout reaches the poll loop error path (end to end)',
  { skip: protocolLayerAvailable ? false : 'src/ilink/** is not available' },
  async (t) => {
    const ilink = createIlink()
    // The real loop is what turns a rejection into `onError` + backoff.
    ilink.startPollLoop = realStartPollLoop
    ilink.createIlinkClient = () => ({
      async getUpdates() {
        throw Object.assign(new Error('socket timeout'), { name: 'AbortError' })
      },
      async sendMessage() {
        return {}
      },
      async sendTyping() {
        return true
      },
    })
    const h = serviceHarness({ ilink, config: { pollTimeoutMs: 60_000 }, deps: { backoffMs: 5 } })
    t.after(() => h.dispose())
    for (let i = 0; i < 200 && !h.channel.getStatus().lastError; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    assert.match(
      h.channel.getStatus().lastError,
      /socket timeout/,
      'the transport failure must surface through onError, not be swallowed',
    )
  },
)

test(
  'our own poll window expiring stays an idle cycle (end to end)',
  { skip: protocolLayerAvailable ? false : 'src/ilink/** is not available' },
  async (t) => {
    const ilink = createIlink()
    ilink.startPollLoop = realStartPollLoop
    ilink.createIlinkClient = () => ({
      async getUpdates({ signal } = {}) {
        if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' })
        return new Promise((_resolve, reject) => {
          signal?.addEventListener(
            'abort',
            () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
            { once: true },
          )
        })
      },
      async sendMessage() {
        return {}
      },
      async sendTyping() {
        return true
      },
    })
    const h = serviceHarness({ ilink, config: { pollTimeoutMs: 15 }, deps: { backoffMs: 5 } })
    t.after(() => h.dispose())
    await new Promise((resolve) => setTimeout(resolve, 150))
    assert.equal(h.channel.getStatus().lastError, undefined, 'an idle window must not report an error')
    assert.equal(h.channel.connected, true)
    assert.equal(h.ilink.store.bufs.size, 0, 'an idle cycle must not advance the cursor')
  },
)

test(
  '[REGRESSION] a recovered poll clears the stale lastError',
  { skip: protocolLayerAvailable ? false : 'src/ilink/** is not available' },
  async (t) => {
    // `onError` was the poll loop's only sink, so `lastError` latched: one
    // transient `-14` (or socket blip) left the status card reporting a failure
    // that had already healed, and the operator re-scanned a bot whose session
    // was in fact alive. Recovery has to be observable too.
    const ilink = createIlink()
    ilink.startPollLoop = realStartPollLoop
    let calls = 0
    ilink.createIlinkClient = () => ({
      async getUpdates({ buf = '' } = {}) {
        calls += 1
        // Fail the first poll, then answer normally for good.
        if (calls === 1) throw Object.assign(new Error('session timeout'), { name: 'IlinkAuthError' })
        return {
          rawMessages: [],
          buf,
          payload: {},
          longpollingTimeoutMs: 0,
          serverLongpollingTimeoutMs: null,
        }
      },
      async sendMessage() {
        return {}
      },
      async sendTyping() {
        return true
      },
    })
    const h = serviceHarness({ ilink, config: { pollTimeoutMs: 60_000 }, deps: { backoffMs: 5 } })
    t.after(() => h.dispose())

    // The failure must be visible first...
    for (let i = 0; i < 200 && !h.channel.getStatus().lastError; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    assert.match(h.channel.getStatus().lastError, /session timeout/)

    // ...and must clear once a poll reaches the server again.
    for (let i = 0; i < 200 && h.channel.getStatus().lastError; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    assert.equal(h.channel.getStatus().lastError, undefined, 'recovery must clear the stale error')
    assert.ok(calls >= 2, `expected a retry, saw ${calls} call(s)`)
  },
)

// ───────────────────── approval / question cards (WeChat mirror) ─────────────────────

/**
 * The `next` the host hands a waterfall listener.
 *
 * @param {unknown} answer - what the remaining answerers (the GUI) would return.
 * @param {{ never?: boolean }} [options] - `never` models a GUI nobody is looking at.
 * @returns {{ next: Function, state: object }} the function plus its call count.
 */
function guiAnswerer(answer, options = {}) {
  const state = { calls: 0 }
  return {
    state,
    next: () => {
      state.calls += 1
      return options.never === true ? new Promise(() => {}) : Promise.resolve(answer)
    },
  }
}

/**
 * Invoke the bridge's registered listener for one waterfall.
 *
 * @param {object} h - the harness.
 * @param {string} event - waterfall name.
 * @param {object} request - the payload.
 * @param {Function} next - the host's remaining answerers.
 * @returns {Promise<unknown>} the listener's answer.
 */
function invokeWaterfall(h, event, request, next) {
  const handlers = [...(h.listeners.get(event) ?? [])]
  assert.equal(handlers.length, 1, `${event} must have exactly one bridge listener`)
  return handlers[0](request, next)
}

test('[REGRESSION] an approval request for a WeChat session is mirrored and answerable from WeChat', async (t) => {
  // Live gap: the bridge registered no `approval/request` answerer, so an agent
  // driving a WeChat conversation blocked on a permission card that only the GUI
  // could render — the contact never saw the request at all.
  const h = harness()
  t.after(() => h.cleanup())
  const sessionId = await dispatchOne(h)
  const agent = h.agents.live.get(sessionId)
  h.channel.sent.length = 0

  const gui = guiAnswerer('rejected', { never: true }) // nobody is at the GUI
  const answer = invokeWaterfall(h, 'approval/request', { agent, toolName: 'pwsh', reason: '需要写入文件' }, gui.next)

  await settle()
  assert.equal(gui.state.calls, 1, 'the GUI answerer must still be offered the request')
  assert.equal(h.channel.sent.length, 1, 'the card must reach WeChat')
  assert.match(h.channel.sent[0].text, /需要权限确认/)
  assert.match(h.channel.sent[0].text, /pwsh/)
  assert.match(h.channel.sent[0].text, /需要写入文件/)

  h.emit('wechat-ilink/message', inbound({ text: '1' }))
  await settle()
  assert.equal(await answer, 'allowed-once', 'the contact\'s reply must settle the waterfall')
})

test('an approval card never swallows a management command', async (t) => {
  const h = harness()
  t.after(() => h.cleanup())
  const sessionId = await dispatchOne(h)
  const agent = h.agents.live.get(sessionId)
  h.channel.sent.length = 0

  const gui = guiAnswerer('rejected', { never: true })
  const answer = invokeWaterfall(h, 'approval/request', { agent, toolName: 'pwsh' }, gui.next)
  await settle()

  h.emit('wechat-ilink/message', inbound({ text: '/status' }))
  await settle()
  assert.match(h.channel.sent.at(-1).text, /状态|ClawBot|通道/, 'the command must run, not be eaten as an answer')

  h.emit('wechat-ilink/message', inbound({ text: '2' }))
  await settle()
  assert.equal(await answer, 'rejected')
})

test('a command-shaped line that is not a command is never submitted as the answer', async (t) => {
  // `/rp` is not one of this bridge's commands, so the old flow fell through to
  // the card and submitted the literal text "/rp" as a free-text answer —
  // silently deciding the question with a line the contact meant as a command.
  const h = harness()
  t.after(() => h.cleanup())
  const sessionId = await dispatchOne(h)
  const agent = h.agents.live.get(sessionId)
  h.channel.sent.length = 0

  const questions = [{ id: 'q1', question: '选哪个？', options: [{ label: '甲' }, { label: '乙' }] }]
  const gui = guiAnswerer({ answers: [] }, { never: true })
  const answer = invokeWaterfall(h, 'user-questions/request', { agent, questions }, gui.next)
  await settle()

  h.emit('wechat-ilink/message', inbound({ text: '/rp' }))
  await settle()
  assert.match(h.channel.sent.at(-1).text, /没有当作卡片回答提交/)
  assert.equal(h.channel.sent.at(-1).text.includes('/rp'), true, 'the hint must name the offending line')

  // The card is still open, and a real answer still settles it.
  h.emit('wechat-ilink/message', inbound({ text: '1' }))
  await settle()
  assert.deepEqual(await answer, { answers: [{ id: 'q1', selected: ['甲'] }] })
})

test('an approval for a session with no WeChat peer leaves the GUI as the only answerer', async (t) => {
  const h = harness()
  t.after(() => h.cleanup())
  const gui = guiAnswerer('allowed-once')
  const answer = invokeWaterfall(
    h,
    'approval/request',
    { agent: { id: 'session-elsewhere', session: { id: 'session-elsewhere' } }, toolName: 'pwsh' },
    gui.next,
  )
  assert.equal(await answer, 'allowed-once')
  assert.equal(gui.state.calls, 1)
  assert.equal(h.channel.sent.length, 0, 'no card may be sent for an unbound session')
})

test('the GUI answering first withdraws the WeChat card', async (t) => {
  const h = harness()
  t.after(() => h.cleanup())
  const sessionId = await dispatchOne(h)
  const agent = h.agents.live.get(sessionId)
  h.channel.sent.length = 0

  const gui = guiAnswerer('rejected') // the GUI answers immediately
  const request = { agent, toolName: 'pwsh' }
  const answer = invokeWaterfall(h, 'approval/request', request, gui.next)
  assert.equal(await answer, 'rejected')
  await settle()
  assert.equal(request.signal.aborted, false, 'a GUI win must not abort the card lifetime')

  const before = agent.sent.length
  h.emit('wechat-ilink/message', inbound({ text: '1' }))
  await settle()
  assert.equal(agent.sent.length, before + 1, 'a withdrawn card must not eat the next message')
})

test('[REGRESSION] answering from WeChat dismisses the GUI card', async (t) => {
  // Both GUI cards bind to `request.signal` and remove themselves when it
  // aborts. Returning the WeChat answer without aborting anything left the card
  // on screen for a request that had already been decided — the operation ran,
  // but the desktop UI never cleared.
  //
  // The request's OWN signal must stay untouched while doing that: the host
  // captured it before dispatching and resolves the whole request as
  // `cancelled` when it fires, which would race the answer WeChat just gave.
  const h = harness()
  t.after(() => h.cleanup())
  const sessionId = await dispatchOne(h)
  const agent = h.agents.live.get(sessionId)

  const original = new AbortController()
  const gui = guiAnswerer('rejected', { never: true })
  const request = { agent, toolName: 'pwsh', signal: original.signal }
  const answer = invokeWaterfall(h, 'approval/request', request, gui.next)
  await settle()

  assert.notEqual(request.signal, original.signal, 'the GUI must bind to the fork, not the request signal')
  assert.equal(request.signal.aborted, false, 'the fork must not be pre-aborted')

  h.emit('wechat-ilink/message', inbound({ text: '1' }))
  await settle()

  assert.equal(await answer, 'allowed-once')
  assert.equal(request.signal.aborted, true, 'the GUI card must be dismissed')
  assert.equal(original.signal.aborted, false, 'the request\'s own signal must not be touched')
})

test('a question answered from WeChat dismisses the GUI card too', async (t) => {
  const h = harness()
  t.after(() => h.cleanup())
  const sessionId = await dispatchOne(h)
  const agent = h.agents.live.get(sessionId)

  const original = new AbortController()
  const questions = [{ id: 'q1', question: '选哪个？', options: [{ label: '甲' }, { label: '乙' }] }]
  const gui = guiAnswerer({ answers: [] }, { never: true })
  const request = { agent, questions, signal: original.signal }
  const answer = invokeWaterfall(h, 'user-questions/request', request, gui.next)
  await settle()

  h.emit('wechat-ilink/message', inbound({ text: '2' }))
  await settle()

  assert.deepEqual(await answer, { answers: [{ id: 'q1', selected: ['乙'] }] })
  assert.equal(request.signal.aborted, true, 'the question card must be dismissed')
  assert.equal(original.signal.aborted, false)
})

test('an aborted request signal is forwarded to the fork', async (t) => {
  const h = harness()
  t.after(() => h.cleanup())
  const sessionId = await dispatchOne(h)
  const agent = h.agents.live.get(sessionId)

  const original = new AbortController()
  const gui = guiAnswerer('rejected', { never: true })
  const request = { agent, toolName: 'pwsh', signal: original.signal }
  void invokeWaterfall(h, 'approval/request', request, gui.next)
  await settle()

  original.abort(new Error('turn ended'))
  await settle()
  assert.equal(request.signal.aborted, true, 'a real abort must still dismiss the card')
})

test('a question card maps a numbered reply onto the option label', async (t) => {
  const h = harness()
  t.after(() => h.cleanup())
  const sessionId = await dispatchOne(h)
  const agent = h.agents.live.get(sessionId)
  h.channel.sent.length = 0

  const questions = [
    { id: 'q1', question: '用哪个方案？', options: [{ label: '甲方案' }, { label: '乙方案' }] },
  ]
  const gui = guiAnswerer({ answers: [{ id: 'q1', selected: ['甲方案'] }] }, { never: true })
  const answer = invokeWaterfall(h, 'user-questions/request', { agent, questions }, gui.next)
  await settle()

  assert.match(h.channel.sent[0].text, /需要你选择/)
  assert.match(h.channel.sent[0].text, /甲方案/)

  h.emit('wechat-ilink/message', inbound({ text: '2' }))
  await settle()
  assert.deepEqual(await answer, { answers: [{ id: 'q1', selected: ['乙方案'] }] })
})

test('a free-text question reply is carried as the host\'s custom answer', async (t) => {
  const h = harness()
  t.after(() => h.cleanup())
  const sessionId = await dispatchOne(h)
  const agent = h.agents.live.get(sessionId)

  const questions = [{ id: 'q1', question: '叫什么名字？', options: [{ label: '默认名' }] }]
  const gui = guiAnswerer({ answers: [] }, { never: true })
  const answer = invokeWaterfall(h, 'user-questions/request', { agent, questions }, gui.next)
  await settle()

  h.emit('wechat-ilink/message', inbound({ text: '就叫小蓝吧' }))
  await settle()
  assert.deepEqual(await answer, { answers: [{ id: 'q1', selected: [], custom: '就叫小蓝吧' }] })
})

test('a partial multi-question reply is refused and the card stays open', async (t) => {
  // The host requires an answer batch naming every question exactly once, so a
  // partial reply must not be turned into a silent default.
  const h = harness()
  t.after(() => h.cleanup())
  const sessionId = await dispatchOne(h)
  const agent = h.agents.live.get(sessionId)
  h.channel.sent.length = 0

  const questions = [
    { id: 'q1', question: '第一个？', options: [{ label: 'A' }, { label: 'B' }] },
    { id: 'q2', question: '第二个？', options: [{ label: 'C' }, { label: 'D' }] },
  ]
  const gui = guiAnswerer({ answers: [] }, { never: true })
  const answer = invokeWaterfall(h, 'user-questions/request', { agent, questions }, gui.next)
  await settle()

  h.emit('wechat-ilink/message', inbound({ text: 'Q1=2' }))
  await settle()
  assert.match(h.channel.sent.at(-1).text, /还差 Q2/)

  h.emit('wechat-ilink/message', inbound({ text: 'Q1=2 Q2=1' }))
  await settle()
  assert.deepEqual(await answer, {
    answers: [
      { id: 'q1', selected: ['B'] },
      { id: 'q2', selected: ['C'] },
    ],
  })
})

// ─────────────────────────── display mode (compact / quiet) ───────────────────────────

/** Emit one completed model message for a turn. */
const emitAssistant = (h, sessionId, turn, text) => {
  h.emit(
    'session/event',
    { id: sessionId },
    { type: 'assistant/message', data: { turn, message: { content: [{ type: 'text', text }] } } },
  )
}

test('[REGRESSION] compact coalesces a turn instead of spending the window per fragment', async (t) => {
  // A turn emits a dozen model messages, most of them one line of narration.
  // Sending each as its own message spent the conversation window about an order
  // of magnitude faster than the turn needed — and that window is what the final
  // answer needs, so the answer was the one refused once it closed.
  const h = harness()
  t.after(() => h.cleanup())
  const sessionId = await dispatchOne(h)
  h.channel.sent.length = 0

  emitAssistant(h, sessionId, 1, '第一段')
  emitAssistant(h, sessionId, 1, '第二段')
  await settle()
  assert.equal(h.channel.sent.length, 0, 'fragments wait for the coalescing window instead of going out one by one')

  h.emit('session/event', { id: sessionId }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  await settle()
  assert.equal(h.channel.sent.length, 1, 'the turn leaves as one message, not one per fragment')
  assert.equal(h.channel.sent[0].text, '第一段\n\n第二段')
})

// ───────────────────── switch commands (/model /effort /permission) ─────────────────────

/**
 * A session double with the surface the switch commands need.
 *
 * @param {string} sessionId - the session id.
 * @returns {object} the session, with its `events` exposed for assertions.
 */
function createSessionDouble(sessionId) {
  const events = []
  return {
    id: sessionId,
    events,
    get seq() {
      return events.length
    },
    append(type, data) {
      events.push({ type, data })
    },
    eventAt(index) {
      return events[index]
    },
    requestHeader: () => undefined,
  }
}

/** A model catalog double with two providers and per-model reasoning efforts. */
function createLlm() {
  return {
    listProviders: () => [
      { id: 'prov-a', name: 'Provider A' },
      { id: 'prov-b', name: 'Provider B' },
    ],
    listModels: async (provider) =>
      provider === 'prov-a'
        ? [
            { id: 'model-1', name: 'Model One' },
            { id: 'model-2', name: 'Model Two' },
          ]
        : [{ id: 'model-3', name: 'Model Three' }],
    resolveModelInfo: async (provider, model) =>
      provider === 'prov-a'
        ? {
            provider,
            id: model,
            reasoning: {
              efforts: [
                { id: 'off', name: 'off' },
                { id: 'high', name: 'high' },
              ],
              defaultEffort: 'off',
            },
          }
        : { provider, id: model },
  }
}

/** A `permissionPresets` double. */
function createPermissionPresets() {
  const calls = []
  const state = { current: 'workspace-write' }
  return {
    calls,
    names: ['read-only', 'workspace-write', 'full-access'],
    current: () => state.current,
    catalog: () => ({
      options: [
        { value: 'read-only', label: '只读' },
        { value: 'workspace-write', label: '工作区可写' },
        { value: 'full-access', label: '完全权限' },
      ],
    }),
    set(_session, name) {
      calls.push(name)
      state.current = name
    },
  }
}

/** Build a harness whose conversation already has a switchable session. */
async function switchHarness(options = {}) {
  const llm = 'llm' in options ? options.llm : createLlm()
  const permissionPresets =
    'permissionPresets' in options ? options.permissionPresets : createPermissionPresets()
  const h = harness({ services: { ...(llm ? { llm } : {}), ...(permissionPresets ? { permissionPresets } : {}) } })
  const sessionId = await dispatchOne(h)
  const agent = h.agents.live.get(sessionId)
  const session = createSessionDouble(sessionId)
  agent.session = session
  h.channel.sent.length = 0
  return { h, session, llm, permissionPresets }
}

test('/model lists the catalog and marks the conversation current model', async (t) => {
  const { h } = await switchHarness()
  t.after(() => h.cleanup())

  h.emit('wechat-ilink/message', inbound({ text: '/model' }))
  await settle()

  const text = h.channel.sent.at(-1).text
  assert.match(text, /1\. prov-a\/model-1/)
  assert.match(text, /2\. prov-a\/model-2/)
  assert.match(text, /3\. prov-b\/model-3/)
  assert.match(text, /本对话当前/)
})

test('[REGRESSION] /model appends the very event the GUI appends, so the desktop follows', async (t) => {
  // The desktop renders the `modelSelection` projection of the session log, so
  // appending this event IS the synchronisation — there is no second copy of the
  // selection anywhere for the two surfaces to disagree about.
  const { h, session } = await switchHarness()
  t.after(() => h.cleanup())

  h.emit('wechat-ilink/message', inbound({ text: '/model 2' }))
  await settle()

  assert.deepEqual(session.events, [{ type: 'model/selection', data: { provider: 'prov-a', model: 'model-2' } }])
  assert.match(h.channel.sent.at(-1).text, /已切换模型/)
  assert.match(h.channel.sent.at(-1).text, /prov-a\/model-2/)
})

test('/model <provider>/<model> works and carries a still-supported effort over', async (t) => {
  const { h, session } = await switchHarness()
  t.after(() => h.cleanup())

  // Establish an effort first, then switch models within the same provider.
  h.emit('wechat-ilink/message', inbound({ text: '/model 1' }))
  await settle()
  h.emit('wechat-ilink/message', inbound({ text: '/effort high' }))
  await settle()
  h.emit('wechat-ilink/message', inbound({ text: '/model prov-a/model-2' }))
  await settle()

  assert.deepEqual(session.events.at(-1), {
    type: 'model/selection',
    data: { provider: 'prov-a', model: 'model-2', reasoningEffort: 'high' },
  })
})

test('/model drops an effort the new model does not offer', async (t) => {
  const { h, session } = await switchHarness()
  t.after(() => h.cleanup())

  h.emit('wechat-ilink/message', inbound({ text: '/model 1' }))
  await settle()
  h.emit('wechat-ilink/message', inbound({ text: '/effort high' }))
  await settle()
  // prov-b advertises no reasoning at all, so the effort must not be carried.
  h.emit('wechat-ilink/message', inbound({ text: '/model 3' }))
  await settle()

  assert.deepEqual(session.events.at(-1), {
    type: 'model/selection',
    data: { provider: 'prov-b', model: 'model-3' },
  })
})

test('/effort refuses a level the current model does not offer', async (t) => {
  const { h, session } = await switchHarness()
  t.after(() => h.cleanup())

  h.emit('wechat-ilink/message', inbound({ text: '/model 1' }))
  await settle()
  h.emit('wechat-ilink/message', inbound({ text: '/effort max' }))
  await settle()

  assert.match(h.channel.sent.at(-1).text, /没有档位/)
  assert.match(h.channel.sent.at(-1).text, /off \/ high/)
  assert.equal(session.events.length, 1, 'a refused effort must append nothing')
})

test('/permission lists and switches through the host service', async (t) => {
  const { h, permissionPresets } = await switchHarness()
  t.after(() => h.cleanup())

  h.emit('wechat-ilink/message', inbound({ text: '/permission' }))
  await settle()
  assert.match(h.channel.sent.at(-1).text, /workspace-write/)
  assert.match(h.channel.sent.at(-1).text, /full-access/)

  h.emit('wechat-ilink/message', inbound({ text: '/permission full-access' }))
  await settle()
  assert.deepEqual(permissionPresets.calls, ['full-access'])
  assert.match(h.channel.sent.at(-1).text, /已切换权限预设/)
})

test('a switch command without a session explains itself instead of failing', async (t) => {
  const h = harness({ services: { llm: createLlm(), permissionPresets: createPermissionPresets() } })
  t.after(() => h.cleanup())
  h.emit('wechat-ilink/message', inbound({ text: '/model' }))
  await settle()
  assert.match(h.channel.sent.at(-1).text, /还没有会话/)
})

test('a host without the llm or permission services degrades to a clear message', async (t) => {
  const { h } = await switchHarness({ llm: undefined, permissionPresets: undefined })
  t.after(() => h.cleanup())

  h.emit('wechat-ilink/message', inbound({ text: '/model' }))
  await settle()
  assert.match(h.channel.sent.at(-1).text, /不提供模型目录/)

  h.emit('wechat-ilink/message', inbound({ text: '/permission' }))
  await settle()
  assert.match(h.channel.sent.at(-1).text, /不提供权限预设/)
})

// ─────────────────────────── outbound send recording ───────────────────────────

/**
 * A channel-service double that records every `sendText` call.
 *
 * @param {(n: number, opts: object) => object} behaviour - throws or returns.
 * @returns {object} `{ calls, sendText }`.
 */
function createSendService(behaviour) {
  const calls = []
  return {
    calls,
    async sendText(peerId, text, opts = {}) {
      calls.push({ peerId, text, opts })
      return behaviour(calls.length, opts)
    },
  }
}

test('a delivered reply is recorded as ok, with whether it carried a token', async () => {
  const entries = []
  const service = createSendService(() => ({}))
  const result = await deliverReply({
    service,
    link: { peerId: 'peer-1', contextToken: 'tok-1' },
    text: 'hello',
    record: (entry) => entries.push(entry),
  })
  assert.equal(result.ok, true)
  assert.deepEqual(entries, [{ peerId: 'peer-1', chars: 5, token: true, ok: true }])
})

test('a failed delivery is recorded with the reason it failed', async () => {
  // This log exists because the notice that would report a delivery failure
  // travels the same channel: when the channel is the problem, nothing anywhere
  // says so.
  const entries = []
  const service = createSendService(() => {
    throw new Error('socket hang up')
  })
  const result = await deliverReply({
    service,
    link: { peerId: 'peer-1' },
    text: 'hi',
    record: (entry) => entries.push(entry),
  })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'send-failed')
  assert.equal(entries.length, 1)
  assert.equal(entries[0].ok, false)
  assert.equal(entries[0].token, false)
  assert.match(entries[0].error, /socket hang up/)
})

test('a reply is sent exactly once, so a chunked send cannot duplicate', async () => {
  // The retry the client owns (`ret: -2`) is per-message inside `sendText`; a
  // retry wrapped around the whole call would re-send every earlier chunk too.
  const service = createSendService(() => {
    throw Object.assign(new Error('rejected'), { ret: -3 })
  })
  const result = await deliverReply({
    service,
    link: { peerId: 'peer-1', contextToken: 'tok-1' },
    text: 'hello',
  })
  assert.equal(result.ok, false)
  assert.equal(service.calls.length, 1)
})

test('compact merges the fragments either side of a tool call', async (t) => {
  const h = harness()
  t.after(() => h.cleanup())
  const sessionId = await dispatchOne(h)
  h.channel.sent.length = 0

  emitAssistant(h, sessionId, 1, '先查一下')
  h.emit('session/event', { id: sessionId }, { type: 'tool/call', data: { turn: 1, name: 'pwsh', callId: 't1' } })
  h.emit('session/event', { id: sessionId }, { type: 'tool/result', data: { turn: 1, callId: 't1' } })
  emitAssistant(h, sessionId, 1, '查完了')
  h.emit('session/event', { id: sessionId }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  await settle()

  assert.deepEqual(
    h.channel.sent.map((entry) => entry.text),
    ['先查一下\n\n查完了'],
    'tool activity must not be mirrored, and must not split the turn into fragments',
  )
})

test('a fragment is sent on its own once the coalescing window elapses', async (t) => {
  // Coalescing must not mean "nothing until turn/end": a long turn still shows
  // progress, it just shows it once per window instead of once per fragment.
  const h = harness({ config: { compactFlushMs: 15 } })
  t.after(() => h.cleanup())
  const sessionId = await dispatchOne(h)
  h.channel.sent.length = 0

  emitAssistant(h, sessionId, 1, '第一段')
  await new Promise((resolve) => setTimeout(resolve, 60))

  assert.equal(h.channel.sent.length, 1, 'the window must flush what it collected')
  assert.match(h.channel.sent[0].text, /第一段/)
})

// ─────────────────────────── channel registry ───────────────────────────

test('[REGRESSION] a call that names no channel still means the WeChat one', (t) => {
  // The registry became keyed when the Feishu channel arrived. Every existing
  // call site — and the web API and the tool — names no channel, so the default
  // key is what keeps that change from being a rewrite of all of them.
  t.after(() => clearService())
  const wechat = { channel: DEFAULT_CHANNEL }
  setService(wechat)
  assert.equal(getService(), wechat)
  assert.equal(getService(DEFAULT_CHANNEL), wechat)
})

test('two channels coexist without either displacing the other', (t) => {
  t.after(() => clearService())
  const wechat = { channel: 'wechat-ilink' }
  const feishu = { channel: 'feishu' }
  setService(wechat)
  setService(feishu)

  assert.equal(getService('wechat-ilink'), wechat)
  assert.equal(getService('feishu'), feishu)
  assert.equal(getService(), wechat, 'the default must not have moved')
})

test('an instance that declares its own channel is filed under it', (t) => {
  t.after(() => clearService())
  const feishu = { channel: 'feishu' }
  setService(feishu)
  assert.equal(getService('feishu'), feishu)
  assert.equal(getService('wechat-ilink'), undefined, 'nothing may be filed under the wrong key')
})

test('clearing one channel leaves the other published', (t) => {
  t.after(() => clearService())
  const wechat = { channel: 'wechat-ilink' }
  const feishu = { channel: 'feishu' }
  setService(wechat)
  setService(feishu)

  clearService('feishu')
  assert.equal(getService('feishu'), undefined)
  assert.equal(getService('wechat-ilink'), wechat)

  clearService()
  assert.equal(getService('wechat-ilink'), undefined, 'teardown drops every channel')
})

// ─────────────────────────── channel routing ───────────────────────────

test('[REGRESSION] a reply goes out on the channel its conversation arrived on', async (t) => {
  // The bridge serves every channel, so which service to send through is a
  // property of the conversation, not a global. Getting this wrong sends a
  // Feishu reply through WeChat — which the contact never sees, and which looks
  // exactly like the agent having gone silent.
  const h = harness()
  const feishu = { ...createChannel(), channel: 'feishu' }
  setService(feishu)
  t.after(() => h.cleanup())

  h.emit('wechat-ilink/message', inbound({ channel: 'feishu', text: '你好' }))
  await settle()
  const sessionId = h.agents.calls.create[0].sessionId

  h.emit(
    'session/event',
    { id: sessionId },
    { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: '来自飞书' }] } } },
  )
  h.emit('session/event', { id: sessionId }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  await settle()

  assert.deepEqual(
    feishu.sent.map((entry) => entry.text),
    ['来自飞书'],
  )
  assert.equal(h.channel.sent.length, 0, 'nothing may leave on the WeChat channel for a Feishu conversation')
})

test('a message that names no channel is still served by the WeChat one', async (t) => {
  const h = harness()
  const feishu = { ...createChannel(), channel: 'feishu' }
  setService(feishu)
  t.after(() => h.cleanup())

  const sessionId = await dispatchOne(h)
  h.emit(
    'session/event',
    { id: sessionId },
    { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: '来自微信' }] } } },
  )
  h.emit('session/event', { id: sessionId }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  await settle()

  assert.deepEqual(
    h.channel.sent.map((entry) => entry.text),
    ['来自微信'],
  )
  assert.equal(feishu.sent.length, 0, 'an unlabelled conversation must not reach another channel')
})

test('the typing indicator follows the conversation channel too', async (t) => {
  const h = harness()
  const feishu = { ...createChannel(), channel: 'feishu' }
  setService(feishu)
  t.after(() => h.cleanup())

  h.emit('wechat-ilink/message', inbound({ channel: 'feishu', text: '你好' }))
  await settle()

  assert.ok(feishu.typing.length > 0, 'the Feishu channel must carry the indicator')
  assert.equal(h.channel.typing.length, 0, 'the WeChat channel must stay untouched')
})

test('[REGRESSION] the typing indicator is retracted when the turn ends', async (t) => {
  // WeChat's signal expires by itself, so doing nothing was correct there. A
  // Feishu reaction does not: it stays until deleted, so a channel that shows
  // one has to be told the turn is over or the contact watches a bot that is
  // apparently typing forever.
  const cleared = []
  const h = harness()
  const feishu = {
    ...createChannel(),
    channel: 'feishu',
    async clearTyping(peerId, contextToken) {
      cleared.push({ peerId, contextToken })
      return true
    },
  }
  setService(feishu)
  t.after(() => h.cleanup())

  h.emit('wechat-ilink/message', inbound({ channel: 'feishu', text: '你好', contextToken: 'om_1' }))
  await settle()
  const sessionId = h.agents.calls.create[0].sessionId

  h.emit('session/event', { id: sessionId }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  await settle()

  assert.deepEqual(cleared, [{ peerId: 'peer-1', contextToken: 'om_1' }])
})

test('a channel whose indicator expires by itself needs no retraction', async (t) => {
  // The WeChat channel has no `clearTyping` at all; asking for one must not be
  // an error on the turn-end path.
  const h = harness()
  t.after(() => h.cleanup())
  const sessionId = await dispatchOne(h)
  h.emit('session/event', { id: sessionId }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  await settle()
  assert.equal(
    h.logs.some((entry) => /could not clear the typing indicator/u.test(entry.message)),
    false,
  )
})

// ─────────────────────────── per-channel delivery settings ───────────────────────────

test('[REGRESSION] a delivery setting follows the conversation channel', async (t) => {
  // One config object serves both channels, so a site that reads `config`
  // directly makes that one setting silently ignore its channel — which looks
  // exactly like the setting having been applied.
  const h = harness({ config: { displayMode: 'compact', channels: { feishu: { displayMode: 'quiet' } } } })
  const feishu = { ...createChannel(), channel: 'feishu' }
  setService(feishu)
  t.after(() => h.cleanup())

  h.emit('wechat-ilink/message', inbound({ channel: 'feishu', text: '你好' }))
  await settle()
  const sessionId = h.agents.calls.create[0].sessionId

  emitAssistant(h, sessionId, 1, '来自飞书')
  await settle()
  assert.equal(feishu.sent.length, 0, 'Feishu is configured quiet, so the text waits for turn/end')

  h.emit('session/event', { id: sessionId }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  await settle()
  assert.deepEqual(
    feishu.sent.map((entry) => entry.text),
    ['来自飞书'],
  )
})

test('the top level stays the fallback for a channel that says nothing', async (t) => {
  const h = harness({ config: { displayMode: 'compact', channels: { feishu: { displayMode: 'quiet' } } } })
  const feishu = { ...createChannel(), channel: 'feishu' }
  setService(feishu)
  t.after(() => h.cleanup())

  const sessionId = await dispatchOne(h)
  emitAssistant(h, sessionId, 1, '来自微信')
  h.emit('session/event', { id: sessionId }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  await settle()
  assert.deepEqual(
    h.channel.sent.map((entry) => entry.text),
    ['来自微信'],
    'the unlisted channel keeps the top-level behaviour',
  )
})

test('[REGRESSION] a new session default follows the channel', () => {
  // The two channels reasonably start on different models — one is a phone, the
  // other a desktop client. A conversation's own later choice still outranks
  // this, so it is only ever a starting point.
  const config = {
    provider: 'deepseek',
    model: 'deepseek-chat',
    reasoningEffort: 'low',
    channels: { feishu: { provider: 'deepseek', model: 'deepseek-reasoner', reasoningEffort: 'max' } },
  }
  const ctx = { get: () => undefined }
  const session = createSessionDouble()

  assert.deepEqual(resolveAgentOptions(ctx, config, session, 'feishu'), {
    provider: 'deepseek',
    model: 'deepseek-reasoner',
    reasoningEffort: 'max',
  })
  assert.deepEqual(
    resolveAgentOptions(ctx, config, session, undefined),
    { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'low' },
    'a channel with no entry keeps the top-level default',
  )
})

test('[REGRESSION] a per-channel default can be set and given back through the settings handle', async (t) => {
  // The page's per-channel controls are only real if the write path keeps the
  // override separate from the fallback — and if clearing one actually removes
  // it, rather than pinning the channel to a blank the resolver ignores.
  const h = harness()
  t.after(() => h.cleanup())
  const handle = getBridgeSettings()

  const set = await handle.write({ channels: { feishu: { provider: 'p', model: 'm-feishu' } } })
  assert.equal(set.ok, true)
  assert.deepEqual(handle.read().channels.feishu, { provider: 'p', model: 'm-feishu' })
  assert.equal(handle.read().model, '', 'the fallback must not be touched by a channel write')

  await handle.write({ channels: { feishu: { model: '' } } })
  assert.equal(handle.read().channels.feishu, undefined, 'a cleared override disappears rather than lingering as blank')
})

test('a per-channel write is refused when it could not take effect', async (t) => {
  const h = harness()
  t.after(() => h.cleanup())
  const handle = getBridgeSettings()

  // Half a pair with nothing to inherit: the resolver would silently ignore it.
  const half = await handle.write({ channels: { feishu: { model: 'm2' } } })
  assert.equal(half.ok, false)
  assert.match(half.message, /provider 和 model 必须同时有值/)

  // A setting that is not per-channel may not be smuggled into a channel group.
  const wrong = await handle.write({ channels: { feishu: { dmPolicy: 'open' } } })
  assert.equal(wrong.ok, false)
  assert.match(wrong.message, /不支持按通道设置/)

  // And an unknown channel is refused rather than silently stored.
  const unknown = await handle.write({ channels: { slack: { model: 'm' } } })
  assert.equal(unknown.ok, false)
  assert.match(unknown.message, /未知通道/)
})

test('[REGRESSION] every per-channel key is actually resolved per channel', () => {
  // The list is what the bridge is allowed to read per channel. If a key is added
  // to it but not honoured — or honoured somewhere that bypasses the resolver —
  // this is the test that has to be updated, deliberately rather than by accident.
  const override = {}
  for (const key of PER_CHANNEL_KEYS) override[key] = key === 'typingIndicator' ? false : 12_345
  const config = { ...DEFAULT_CONFIG, channels: { feishu: override } }

  const feishu = channelConfig(config, 'feishu')
  for (const key of PER_CHANNEL_KEYS) {
    assert.notDeepEqual(feishu[key], DEFAULT_CONFIG[key], `${key} must come from the channel`)
  }
  // A channel with no entry keeps the top-level value for every key.
  const other = channelConfig(config, 'wechat-ilink')
  for (const key of PER_CHANNEL_KEYS) {
    assert.deepEqual(other[key], DEFAULT_CONFIG[key], `${key} must fall back to the top level`)
  }
  // A config with no `channels` at all is still the plain config.
  assert.deepEqual(channelConfig({ displayMode: 'quiet' }, 'feishu'), { displayMode: 'quiet' })
})

// ─────────────────────────── host compatibility self-check ───────────────────────────

test('[REGRESSION] the compatibility report names what is missing, not just that something is', async (t) => {
  // A DSH update that renames or drops a host surface raises no error anywhere:
  // the feature simply stops working. This report is the only place that says so,
  // so it has to name the surface and what it costs.
  const h = harness()
  t.after(() => h.cleanup())

  const report = getBridgeSettings().compat()
  assert.equal(typeof report.total, 'number')
  assert.equal(report.available.length + report.missing.length, report.total)
  assert.equal(report.ok, report.missing.length === 0)

  const missingNames = report.missing.map((entry) => entry.name)
  assert.ok(missingNames.includes('llm'), 'this fixture mounts no llm service')
  assert.ok(
    report.missing.every((entry) => typeof entry.affects === 'string' && entry.affects.length > 0),
    'every gap must say what stops working',
  )
  assert.match(describeCompat(report), /missing:/)
})

test('a host that mounts every surface reports no gaps', () => {
  const mounted = {}
  for (const surface of HOST_SURFACES) mounted[surface.name] = surface.kind === 'ctx' ? () => {} : {}
  const ctx = {
    get: (name) => mounted[name],
    on: () => {},
    waterfall: () => {},
  }
  const report = checkHostCompat(ctx)
  assert.deepEqual(report.missing, [])
  assert.equal(report.ok, true)
  assert.equal(describeCompat(report), `host compatibility: ${report.total}/${report.total} surfaces available`)
})

test('[REGRESSION] an incomplete report is re-probed, not frozen', async (t) => {
  // The bridge row loads while the host is still bringing services up, so an
  // eager probe reports almost everything as missing. It shipped once and did
  // exactly that on a host where every one of those surfaces was present and
  // working — the report has to survive a premature first read.
  const h = harness()
  t.after(() => h.cleanup())

  const first = getBridgeSettings().compat()
  assert.ok(first.missing.length > 0, 'this fixture starts without most services')
  assert.ok(!first.available.includes('llm'))

  h.services.llm = { listProviders: () => [], listModels: async () => [] }
  const second = getBridgeSettings().compat()
  assert.ok(second.available.includes('llm'), 'a later probe must see a service that has since appeared')
  assert.ok(second.missing.length < first.missing.length, 'the report must improve, not stay frozen')
})

test('a host whose service lookup throws is reported as missing, not as a crash', () => {
  // Cordis throws when a service was never provided — the exact case the check
  // exists to report — so the probe itself must not be what breaks the load.
  const report = checkHostCompat({
    get: () => {
      throw new Error('service not provided')
    },
    on: () => {},
    waterfall: () => {},
  })
  assert.equal(report.available.includes('on'), true)
  assert.equal(report.missing.length, report.total - 2)
  assert.equal(report.ok, false)
})

// ─────────────────────────── runtime settings (settings page) ───────────────────────────

/** The settings surface's shape before anything is changed. */
const SETTINGS_DEFAULTS = Object.freeze({
  displayMode: 'compact',
  typingIndicator: true,
  provider: '',
  model: '',
  reasoningEffort: '',
  permissionPreset: '',
  // Per-channel overrides, empty until a channel is given one — the top level is
  // the fallback, and the page must be able to tell "inheriting" from "set to
  // the same value as the fallback".
  channels: {},
  channelNames: ['wechat-ilink', 'feishu'],
})

test('[REGRESSION] a settings write changes what the relay does on the next segment', async (t) => {
  // The settings page and the relay must never hold separate copies: the page
  // renders `read()`, and `write()` mutates the very config object the relay
  // reads. If a write only reached a UI state object, the page would show
  // `quiet` while the relay kept sending per segment — the same class of bug as
  // a decision card that stays on screen after being answered elsewhere.
  const h = harness()
  t.after(() => h.cleanup())
  const sessionId = await dispatchOne(h)
  h.channel.sent.length = 0

  const handle = getBridgeSettings()
  assert.deepEqual(handle.read(), SETTINGS_DEFAULTS)

  const result = await handle.write({ displayMode: 'quiet' })
  assert.equal(result.ok, true)
  assert.deepEqual(result.settings, { ...SETTINGS_DEFAULTS, displayMode: 'quiet' })

  emitAssistant(h, sessionId, 1, '第一段')
  emitAssistant(h, sessionId, 1, '第二段')
  await settle()
  assert.equal(h.channel.sent.length, 0, 'the relay must follow the new mode immediately, without a restart')

  h.emit('session/event', { id: sessionId }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  await settle()
  assert.equal(h.channel.sent.length, 1)
  assert.equal(h.channel.sent[0].text, '第一段\n\n第二段')
})

test('[REGRESSION] the default permission preset is applied to a session the bridge creates', async (t) => {
  // The settings page's permission entry is a DEFAULT for sessions this bridge
  // creates. It is applied once, at creation, precisely so it can never override
  // a preset the contact chose later from WeChat.
  const permissionPresets = createPermissionPresets()
  const h = harness({ services: { permissionPresets }, config: { permissionPreset: 'full-access' } })
  t.after(() => h.cleanup())
  await dispatchOne(h)
  assert.deepEqual(permissionPresets.calls, ['full-access'])
})

test('no default permission preset means no call at all', async (t) => {
  const permissionPresets = createPermissionPresets()
  const h = harness({ services: { permissionPresets } })
  t.after(() => h.cleanup())
  await dispatchOne(h)
  assert.deepEqual(permissionPresets.calls, [])
})

test('a host without permission presets still starts the conversation', async (t) => {
  // An unavailable service must never stop a conversation from opening.
  const h = harness({ config: { permissionPreset: 'full-access' } })
  t.after(() => h.cleanup())
  const sessionId = await dispatchOne(h)
  assert.ok(sessionId, 'the session must still be created')
})

test('a refused settings write changes nothing', async (t) => {
  const h = harness()
  t.after(() => h.cleanup())
  const handle = getBridgeSettings()

  const wrongMode = await handle.write({ displayMode: 'full' })
  assert.equal(wrongMode.ok, false)
  assert.match(wrongMode.message, /displayMode/)

  const wrongType = await handle.write({ typingIndicator: 'yes' })
  assert.equal(wrongType.ok, false)

  const unknownKey = await handle.write({ nope: 1 })
  assert.equal(unknownKey.ok, false)
  assert.match(unknownKey.message, /nope/)

  assert.deepEqual(handle.read(), SETTINGS_DEFAULTS, 'nothing may have changed')
})

test('the typing indicator toggle is readable and writable', async (t) => {
  const h = harness()
  t.after(() => h.cleanup())
  const handle = getBridgeSettings()

  await handle.write({ typingIndicator: false })
  assert.equal(handle.read().typingIndicator, false)

  await handle.write({ typingIndicator: true })
  assert.equal(handle.read().typingIndicator, true)
})

test('disposing the bridge retracts its settings handle', async (t) => {
  const h = harness()
  const sessionId = await dispatchOne(h)
  assert.ok(sessionId)
  assert.ok(getBridgeSettings(), 'the handle must be published while the bridge runs')

  h.cleanup()
  assert.equal(getBridgeSettings(), undefined, 'a disposed bridge must not keep serving settings')
})

