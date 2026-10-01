/**
 * Verifier-owned host-integration suite (round 2).
 *
 * The bridge's workspace/session commands talk to host services by *name*, so a
 * wrong name or a wrong argument shape degrades silently. This file drives
 * `src/bridge/host.js` against fakes that mirror the real host contracts, with
 * each contract traced to the runtime package it was read from:
 *
 *   - `workspaceRegistry`   @deepseek-ai/dsh-workspace  lib/index.js:374 (service),
 *                           :406 create(path,title), :452 list(),
 *                           :504 get archivedSessionIds, :635 resolveByPath(path),
 *                           entity :90 path, :93 title, :102 sessionIds, :111 attachSession(id)
 *   - `sessionQuery`        @deepseek-ai/dsh-session-query lib/index.js:1046 (service),
 *                           :1070 listSessions → [{header,live,persisted}] (:101-113),
 *                           :1079 readSession → {inheritedEventCount,events} (:1084-1085),
 *                           :1141 listEvents
 *   - `sessionProjectionCache` @deepseek-ai/dsh-session-projection-cache lib/index.js:147
 *                           (service), :193 cachedSnapshot(meta, keys?)
 *                           → viewRecord → sessionProjections.viewCheckpoint(rows, keys),
 *                           and @deepseek-ai/dsh-session-projection lib/index.js:246 does
 *                           `keys === undefined ? undefined : new Set(keys)`.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { HostAccess, clip, eventText, historyEntries, isHumanUserMessage, shortPath } from '../../src/bridge/host.js'

/**
 * A `sessionProjectionCache` faithful to the real implementation, including the
 * `new Set(keys)` step that rejects a non-iterable second argument.
 *
 * @param {Record<string, unknown>} rows - projection rows.
 * @returns {{ cachedSnapshot: Function, calls: unknown[][] }} the fake + call log.
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

/** A ctx whose `get(name)` returns the given services. */
const ctxWith = (services) => ({
  get: (name) => services[name],
})

test('[REGRESSION V2-1] cachedHint omits `keys` so the host can serve the projection', () => {
  const header = { id: 'session-1', cwd: 'C:/work', createdAt: 1 }
  const cache = hostShapedProjectionCache({
    title: '修复登录',
    sessionListMetadata: { lastPromptAt: 1_700_000_000_123 },
  })
  const host = new HostAccess({ ctx: ctxWith({ sessionProjectionCache: cache }), log: () => {} })

  const hint = host.cachedHint(header)

  assert.deepEqual(
    hint,
    { title: '修复登录', lastActivityAt: 1_700_000_000_123 },
    'the projection hint must reach the caller',
  )
  assert.equal(cache.calls.length, 1, 'the cache is consulted once')
  assert.equal(
    cache.calls[0][1],
    undefined,
    'keys must be OMITTED: the host runs `new Set(keys)` on anything but undefined',
  )
  // The host step this mirrors (`dsh-session-projection:246`): a falsy
  // placeholder such as `0` is not iterable and throws into cachedHint's catch,
  // which is exactly the bug this regression net pins down.
  assert.throws(() => new Set(0), TypeError, 'the host step this mirrors (dsh-session-projection:246)')
  assert.equal(cache.calls[0][0], header, 'the header is still the identity witness')

  // A cache that returns nothing still yields an empty hint, not a throw.
  const empty = new HostAccess({
    ctx: ctxWith({ sessionProjectionCache: { cachedSnapshot: () => undefined } }),
    log: () => {},
  })
  assert.deepEqual(empty.cachedHint(header), {})

  // A throwing cache is logged and degrades instead of emptying the listing.
  const warnings = []
  const broken = new HostAccess({
    ctx: ctxWith({
      sessionProjectionCache: {
        cachedSnapshot() {
          throw new TypeError('projection exploded')
        },
      },
    }),
    log: (level, message) => warnings.push([level, message]),
  })
  assert.deepEqual(broken.cachedHint(header), {})
  assert.equal(warnings.length, 1)
  assert.match(warnings[0][1], /projection cache hint failed/)
})

test('listSessions: reads {header, live, persisted}, drops archived and subagent rows', async () => {
  const records = [
    { header: { id: 's-live', cwd: 'C:/a', createdAt: 3, origin: 'user' }, live: true, persisted: true },
    { header: { id: 's-persisted', cwd: 'C:/a', createdAt: 2 }, live: false, persisted: true },
    { header: { id: 's-archived', cwd: 'C:/a', createdAt: 1 }, live: false, persisted: true },
    { header: { id: 's-subagent', cwd: 'C:/a', createdAt: 4, origin: 'subagent' }, live: false, persisted: true },
    { header: { id: 's-other', cwd: 'C:/b', createdAt: 5 }, live: false, persisted: true },
    { header: {}, live: false, persisted: true },
  ]
  const query = { listSessions: async () => records }
  const registry = { archivedSessionIds: ['s-archived'] }
  const host = new HostAccess({ ctx: ctxWith({ sessionQuery: query, workspaceRegistry: registry }), log: () => {} })

  const all = await host.listSessions()
  assert.deepEqual(all.items.map((item) => item.id), ['s-live', 's-persisted', 's-other'])
  assert.equal(all.available, true)

  const filtered = await host.listSessions({ workspacePath: 'C:/a' })
  assert.deepEqual(filtered.items.map((item) => item.id), ['s-live', 's-persisted'])

  const limited = await host.listSessions({ limit: 1 })
  assert.equal(limited.items.length, 1)
})

test('listSessions / readHistory degrade instead of throwing when the host is bare', async () => {
  const host = new HostAccess({ ctx: ctxWith({}), log: () => {} })
  assert.deepEqual(host.capabilities(), { workspaces: false, sessions: false, history: false })
  assert.deepEqual(host.listWorkspaces(), { available: false, items: [], reason: 'workspace-registry-unavailable' })
  const sessions = await host.listSessions()
  assert.equal(sessions.available, false)
  assert.deepEqual(sessions.items, [])
  const history = await host.readHistory('s-1')
  assert.equal(history.available, false)
  assert.equal(history.reason, 'session-read-unavailable')
  assert.equal(await host.resolveWorkspace('C:/x'), undefined)
  assert.deepEqual(await host.ensureWorkspace('C:/x'), { ok: false, reason: 'workspace-registry-unavailable' })
  assert.equal(await host.attachSession('C:/x', 's-1'), false)
})

test('workspaces: list / resolveByPath / create / attachSession follow the real entity shape', async () => {
  const attached = []
  const created = []
  const entities = [
    {
      id: 'ws-1',
      path: 'C:/work/alpha',
      title: 'alpha',
      sessionIds: ['s-1', 's-2'],
      updatedAt: 42,
      async attachSession(sessionId) {
        attached.push(sessionId)
        this.sessionIds = [...this.sessionIds, sessionId]
      },
    },
  ]
  const registry = {
    list: () => entities,
    async resolveByPath(p) {
      return entities.find((entity) => entity.path === p)
    },
    async create(p) {
      created.push(p)
      const entity = { id: `ws-${entities.length + 1}`, path: p, title: '', sessionIds: [], updatedAt: 0, async attachSession(id) { attached.push(id) } }
      entities.push(entity)
      return entity
    },
  }
  const host = new HostAccess({ ctx: ctxWith({ workspaceRegistry: registry }), log: () => {} })

  const listed = host.listWorkspaces()
  assert.equal(listed.available, true)
  assert.deepEqual(listed.items, [
    { id: 'ws-1', path: 'C:/work/alpha', title: 'alpha', sessionCount: 2, updatedAt: 42 },
  ])

  assert.equal((await host.resolveWorkspace('C:/work/alpha')).id, 'ws-1')
  assert.equal(await host.resolveWorkspace('C:/nope'), undefined)

  const ensured = await host.ensureWorkspace('C:/work/beta')
  assert.equal(ensured.ok, true)
  assert.deepEqual(created, ['C:/work/beta'])

  assert.equal(await host.attachSession('C:/work/alpha', 's-9'), true)
  assert.deepEqual(attached, ['s-9'])
  // A path the registry refuses is a soft failure, never a throw.
  assert.equal(await host.attachSession('', 's-9'), false)
})

test('readHistory: prefers the live log, falls back to the persisted replay', async () => {
  const liveEvents = [
    { type: 'user/message', time: 1, data: { message: { content: [{ type: 'text', text: '你好' }], source: { kind: 'user' } } } },
    { type: 'assistant/message', time: 2, data: { message: { content: [{ type: 'text', text: '在的' }] } } },
    // A plugin-injected user-role message must not show up as a human turn.
    { type: 'user/message', time: 3, data: { message: { content: [{ type: 'text', text: 'goal round' }], source: { kind: 'goal' } } } },
  ]
  const agents = { get: (id) => (id === 's-live' ? { session: { snapshotEvents: () => liveEvents } } : undefined) }
  const query = {
    listSessions: async () => [],
    readSession: async () => ({ inheritedEventCount: 0, events: [{ type: 'assistant/message', time: 9, data: { text: 'from disk' } }] }),
  }
  const host = new HostAccess({ ctx: ctxWith({ agents, sessionQuery: query }), log: () => {} })

  const live = await host.readHistory('s-live')
  assert.equal(live.source, 'live')
  assert.deepEqual(live.items.map((item) => [item.role, item.text]), [
    ['user', '你好'],
    ['assistant', '在的'],
  ])

  const persisted = await host.readHistory('s-old')
  assert.equal(persisted.source, 'persisted')
  assert.deepEqual(persisted.items.map((item) => item.text), ['from disk'])
})

test('helpers: eventText / historyEntries / clip / shortPath keep the documented shapes', () => {
  assert.equal(eventText({ message: { content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] } }), 'a\nb')
  assert.equal(eventText({ content: [{ type: 'text', text: 'flat' }] }), 'flat')
  assert.equal(eventText({ text: 'plain' }), 'plain')
  assert.equal(eventText({ prompt: 'p' }), 'p')
  assert.equal(eventText({ input: 'i' }), 'i')
  assert.equal(eventText({ message: { content: [{ type: 'image' }] } }), '')
  assert.equal(eventText(null), '')

  assert.equal(isHumanUserMessage({ source: { kind: 'user' } }), true)
  assert.equal(isHumanUserMessage({}), true)
  assert.equal(isHumanUserMessage({ source: { kind: 'goal' } }), false)

  const entries = historyEntries(
    [
      { type: 'user/message', time: 5, data: { text: 'x'.repeat(500) } },
      { type: 'assistant/message', time: 6, data: { text: 'ok' } },
      { type: 'tool/result', time: 7, data: { text: 'ignored' } },
    ],
    8,
  )
  assert.deepEqual(entries.map((entry) => entry.role), ['user', 'assistant'])
  assert.equal(entries[0].text.length <= 400, true)
  assert.equal(entries[0].time, 5)

  assert.equal(clip('a  b\nc', 10), 'a b c')
  assert.equal(clip('abcdefghij', 5), 'abcd…')
  assert.equal(shortPath('C:\\work\\alpha\\beta'), '…\\alpha\\beta')
  assert.equal(shortPath('C:\\work'), 'C:\\work')
  assert.equal(shortPath(''), '?')
})
