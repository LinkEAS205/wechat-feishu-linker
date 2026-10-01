/**
 * Read-only access to the host's workspaces, existing sessions, and their
 * history — the capability behind `/workspaces`, `/cwd`, `/sessions`, `/use`,
 * `/peek`, and `/current`.
 *
 * Every accessor is guarded: a service that the deployment does not mount
 * degrades to `{ available: false, items: [] }` (or `undefined`) instead of
 * throwing, because a third-party plugin must never assume a composition.
 *
 * Verified host surface (read from the 0.2.0-rc.2 runtime, never guessed):
 * - `workspaceRegistry` — `@deepseek-ai/dsh-workspace`, `super(ctx, "workspaceRegistry")`
 *   at `lib/index.js:374`; `list()` at `:452`, `get archivedSessionIds` at
 *   `:504`, `async resolveByPath(path)` at `:635`; entities expose `id`,
 *   `get path` `:90`, `get title` `:93`, `get sessionIds` `:102`,
 *   `async attachSession(sessionId)` `:111`.
 * - `sessionQuery` — `@deepseek-ai/dsh-session-query`, `super(ctx, "sessionQuery")`
 *   at `lib/index.js:1046`; `listSessions(signal)` at `:1070` returns
 *   `[{ header, live, persisted }]` newest-first, `async readSession(sessionId)`
 *   at `:1079` returns `{ session, inheritedEventCount, events }`, and
 *   `async listEvents(sessionId)` at `:1141` is metadata-only.
 * - Session header keys (`@deepseek-ai/dsh-session-persistence-jsonl`
 *   `lib/index.js:777-790`): required `type, version, id, createdAt, isSeeded,
 *   delegationDepth`; optional `cwd, parentSession, origin, agentPreset`.
 * - `sessionProjectionCache` — `@deepseek-ai/dsh-session-projection-cache`,
 *   `super(ctx, "sessionProjectionCache")` at `lib/index.js:147`;
 *   `cachedSnapshot(meta, keys)` at `:193` is the GUI sidebar's zero-I/O
 *   listing hint.
 * - `sessionTitle` — `@deepseek-ai/dsh-session-title`, `super(ctx, "sessionTitle")`
 *   at `lib/index.js:214`; `get(session)` at `:281`.
 * - `session.snapshotEvents(fromSeq, toSeqExclusive)` —
 *   `@deepseek-ai/dsh-session` `lib/index.js`; `session/title` is a known
 *   session event type at `:113`.
 *
 * @module wechat-feishu-linker/bridge/host
 */

/** Maximum rows any list command renders (WeChat is a small screen). */
export const LIST_ROW_LIMIT = 12

/** Maximum history entries `/peek` renders. */
export const PEEK_ENTRY_LIMIT = 8

/** Maximum characters kept from one history entry. */
export const PEEK_ENTRY_CHARS = 400

/**
 * Read one service from the context without ever throwing.
 *
 * @param {object} ctx - plugin context.
 * @param {string} name - service name.
 * @returns {object | undefined} the service, or undefined.
 */
export function safeGet(ctx, name) {
  try {
    const service = ctx?.get?.(name)
    return service && typeof service === 'object' ? service : undefined
  } catch {
    return undefined
  }
}

/**
 * Render a workspace path compactly (WeChat shows one line per row).
 *
 * @param {unknown} value - the path.
 * @returns {string} the path, or `'?'`.
 */
export function shortPath(value) {
  if (typeof value !== 'string' || value === '') return '?'
  const normalized = value.replace(/[\\/]+$/, '')
  const parts = normalized.split(/[\\/]/).filter(Boolean)
  if (parts.length <= 2) return normalized
  return `…${normalized.slice(normalized.indexOf(parts[parts.length - 2]) - 1)}`
}

/**
 * Truncate one line for WeChat.
 *
 * @param {unknown} value - the text.
 * @param {number} [max] - maximum length.
 * @returns {string} the possibly-truncated text.
 */
export function clip(value, max = 60) {
  const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''
  if (text.length <= max) return text
  return `${text.slice(0, max - 1)}…`
}

/**
 * Extract display text from one session event's `data` payload.
 *
 * Mirrors the host shapes the GUI history uses: `data.message.content[]`,
 * a flattened `data.content[]`, and the plain `data.text` fallback.
 *
 * @param {unknown} data - `event.data`.
 * @returns {string} the text, or `''`.
 */
export function eventText(data) {
  if (typeof data === 'string') return data.trim()
  if (!data || typeof data !== 'object') return ''
  const blocks = Array.isArray(data.message?.content)
    ? data.message.content
    : Array.isArray(data.content)
      ? data.content
      : []
  const parts = []
  for (const block of blocks) {
    if (block && block.type === 'text' && typeof block.text === 'string' && block.text !== '') {
      parts.push(block.text)
    }
  }
  if (parts.length > 0) return parts.join('\n').trim()
  if (typeof data.text === 'string') return data.text.trim()
  if (typeof data.prompt === 'string') return data.prompt.trim()
  if (typeof data.input === 'string') return data.input.trim()
  return ''
}

/**
 * Whether a `user/message` payload is a real human turn.
 *
 * Synthesized user-role messages carry a `source.kind` other than `user`
 * (plugin injections, goal rounds, session references, relays); the GUI
 * sidebar hides them and so does `/peek`.
 *
 * @param {unknown} data - `event.data` of a `user/message`.
 * @returns {boolean} true when the message is human.
 */
export function isHumanUserMessage(data) {
  const kind = data?.source?.kind ?? data?.message?.source?.kind
  return kind === undefined || kind === 'user'
}

/**
 * Fold `user/message` / `assistant/message` events into display entries.
 *
 * @param {unknown} events - session events, oldest first.
 * @param {number} limit - maximum entries kept (newest win).
 * @returns {Array<{ role: string, text: string, time: number }>} the entries.
 */
export function historyEntries(events, limit) {
  if (!Array.isArray(events)) return []
  const entries = []
  for (const event of events) {
    if (!event || typeof event !== 'object') continue
    if (event.type !== 'user/message' && event.type !== 'assistant/message') continue
    if (event.type === 'user/message' && !isHumanUserMessage(event.data)) continue
    const text = eventText(event.data)
    if (!text) continue
    entries.push({
      role: event.type === 'user/message' ? 'user' : 'assistant',
      text: clip(text, PEEK_ENTRY_CHARS),
      time: typeof event.time === 'number' ? event.time : 0,
    })
  }
  return entries.slice(-Math.max(1, limit))
}

/** Guarded reader over the host's workspace / session / history services. */
export class HostAccess {
  /**
   * @param {object} options - inputs.
   * @param {object} options.ctx - plugin context.
   * @param {(level: string, message: string) => void} [options.log] - logger.
   */
  constructor({ ctx, log }) {
    this.ctx = ctx
    this.log = log
  }

  /** @returns {object | undefined} the `workspaceRegistry` service. */
  get workspaceRegistry() {
    return safeGet(this.ctx, 'workspaceRegistry')
  }

  /** @returns {object | undefined} the `sessionQuery` service. */
  get sessionQuery() {
    return safeGet(this.ctx, 'sessionQuery')
  }

  /** @returns {object | undefined} the `agents` registry. */
  get agents() {
    return safeGet(this.ctx, 'agents')
  }

  /**
   * Which host capabilities are mounted.
   *
   * @returns {{ workspaces: boolean, sessions: boolean, history: boolean }} the flags.
   */
  capabilities() {
    return {
      workspaces: typeof this.workspaceRegistry?.list === 'function',
      sessions: typeof this.sessionQuery?.listSessions === 'function',
      history:
        typeof this.sessionQuery?.readSession === 'function' ||
        typeof this.agents?.get === 'function',
    }
  }

  /**
   * List the deployment's registered workspaces.
   *
   * @returns {{ available: boolean, items: Array<object>, reason?: string }} the listing.
   */
  listWorkspaces() {
    const registry = this.workspaceRegistry
    if (typeof registry?.list !== 'function') {
      return { available: false, items: [], reason: 'workspace-registry-unavailable' }
    }
    let entities
    try {
      entities = registry.list()
    } catch (error) {
      this.log?.('warn', `wechat-ilink bridge: workspaceRegistry.list() failed: ${String(error)}`)
      return { available: false, items: [], reason: 'workspace-list-failed' }
    }
    if (!Array.isArray(entities)) return { available: true, items: [] }
    const items = []
    for (const entity of entities) {
      try {
        const path = typeof entity?.path === 'string' ? entity.path : ''
        if (!path) continue
        const sessionIds = Array.isArray(entity?.sessionIds) ? entity.sessionIds : []
        items.push({
          id: typeof entity?.id === 'string' ? entity.id : path,
          path,
          title: typeof entity?.title === 'string' ? entity.title : '',
          sessionCount: sessionIds.length,
          updatedAt: typeof entity?.updatedAt === 'number' ? entity.updatedAt : 0,
        })
      } catch (error) {
        this.log?.('warn', `wechat-ilink bridge: skipping an unreadable workspace entity: ${String(error)}`)
      }
    }
    return { available: true, items }
  }

  /**
   * Resolve a workspace by its canonical path.
   *
   * @param {string} path - absolute directory path.
   * @returns {Promise<object | undefined>} the workspace entity.
   */
  async resolveWorkspace(path) {
    const registry = this.workspaceRegistry
    if (typeof registry?.resolveByPath !== 'function' || typeof path !== 'string' || path === '') {
      return undefined
    }
    try {
      return (await registry.resolveByPath(path)) ?? undefined
    } catch (error) {
      this.log?.('warn', `wechat-ilink bridge: resolveByPath(${path}) failed: ${String(error)}`)
      return undefined
    }
  }

  /**
   * Resolve a workspace, creating the registration when the directory is not
   * yet known (the same first-use path the GUI's workspace picker takes).
   *
   * @param {string} path - absolute directory path.
   * @returns {Promise<{ ok: boolean, workspace?: object, reason?: string }>} the outcome.
   */
  async ensureWorkspace(path) {
    if (typeof path !== 'string' || path.trim() === '') return { ok: false, reason: 'empty-path' }
    const registry = this.workspaceRegistry
    if (typeof registry?.resolveByPath !== 'function') {
      return { ok: false, reason: 'workspace-registry-unavailable' }
    }
    const existing = await this.resolveWorkspace(path)
    if (existing) return { ok: true, workspace: existing }
    if (typeof registry.create !== 'function') return { ok: false, reason: 'workspace-create-unavailable' }
    try {
      const created = await registry.create(path)
      return created ? { ok: true, workspace: created } : { ok: false, reason: 'workspace-create-refused' }
    } catch (error) {
      this.log?.('warn', `wechat-ilink bridge: workspaceRegistry.create(${path}) failed: ${String(error)}`)
      return { ok: false, reason: 'workspace-create-failed' }
    }
  }

  /**
   * Account a session to the workspace owning `cwd`, exactly like the GUI's
   * `session.create` remote does. Without it, WeChat-created sessions land in
   * the sidebar's "ungrouped" bucket.
   *
   * @param {string | undefined} cwd - the session's working directory.
   * @param {string} sessionId - the session id.
   * @returns {Promise<boolean>} true when the session was attached.
   */
  async attachSession(cwd, sessionId) {
    if (typeof cwd !== 'string' || cwd === '' || typeof sessionId !== 'string' || sessionId === '') return false
    const registry = this.workspaceRegistry
    if (typeof registry?.resolveByPath !== 'function') return false
    try {
      let workspace = await registry.resolveByPath(cwd)
      if (!workspace && typeof registry.create === 'function') workspace = await registry.create(cwd)
      if (typeof workspace?.attachSession !== 'function') return false
      await workspace.attachSession(sessionId)
      return true
    } catch (error) {
      // Non-fatal: the session still works, it just shows ungrouped.
      this.log?.('warn', `wechat-ilink bridge: could not attach ${sessionId} to ${cwd}: ${String(error)}`)
      return false
    }
  }

  /**
   * The GUI sidebar's zero-I/O label hint for one listed session.
   *
   * `keys` must be omitted, never passed as a falsy placeholder: the host
   * treats `undefined` as "every projection key" but runs `new Set(keys)` on
   * anything else (`@deepseek-ai/dsh-session-projection` `lib/index.js:246`),
   * so a `0` throws `TypeError: 0 is not iterable` — which the guard below
   * would swallow, silently emptying every non-live session's title and
   * `lastActivityAt`. The host's own listing call
   * (`dsh-api-session-controller` `lib/index.js:2012`) omits it too.
   *
   * @param {object} header - the session header from `listSessions()`.
   * @returns {{ title?: string, lastActivityAt?: number }} the hint.
   */
  cachedHint(header) {
    const cache = safeGet(this.ctx, 'sessionProjectionCache')
    if (typeof cache?.cachedSnapshot !== 'function' || !header?.id) return {}
    try {
      const snapshot = cache.cachedSnapshot(header)
      const values = snapshot?.values
      if (!values) return {}
      const hint = {}
      if (typeof values.title === 'string' && values.title !== '') hint.title = values.title
      const lastPromptAt = values.sessionListMetadata?.lastPromptAt
      if (typeof lastPromptAt === 'number') hint.lastActivityAt = lastPromptAt
      return hint
    } catch (error) {
      // A cache read is a nicety; a broken one must not empty the whole listing.
      this.log?.('warn', `wechat-ilink bridge: projection cache hint failed for ${header.id}: ${String(error)}`)
      return {}
    }
  }

  /**
   * The live title of a session, when it is attached in this process.
   *
   * @param {string} sessionId - session id.
   * @returns {string | undefined} the title.
   */
  liveTitle(sessionId) {
    const session = this.agents?.get?.(sessionId)?.session
    if (!session) return undefined
    try {
      const title = safeGet(this.ctx, 'sessionTitle')?.get?.(session)
      return typeof title === 'string' && title !== '' ? title : undefined
    } catch {
      return undefined
    }
  }

  /**
   * List existing sessions, newest first (the GUI sidebar's corpus).
   *
   * @param {object} [options] - filters.
   * @param {number} [options.limit] - maximum rows.
   * @param {string} [options.workspacePath] - only sessions whose `cwd` matches.
   * @returns {Promise<{ available: boolean, items: Array<object>, total: number, reason?: string }>} the listing.
   */
  async listSessions({ limit = LIST_ROW_LIMIT, workspacePath } = {}) {
    const query = this.sessionQuery
    if (typeof query?.listSessions !== 'function') {
      return { available: false, items: [], total: 0, reason: 'session-query-unavailable' }
    }
    let records
    try {
      records = await query.listSessions()
    } catch (error) {
      this.log?.('warn', `wechat-ilink bridge: sessionQuery.listSessions() failed: ${String(error)}`)
      return { available: false, items: [], total: 0, reason: 'session-list-failed' }
    }
    if (!Array.isArray(records)) return { available: true, items: [], total: 0 }
    const archived = new Set(
      Array.isArray(this.workspaceRegistry?.archivedSessionIds) ? this.workspaceRegistry.archivedSessionIds : [],
    )
    const items = []
    for (const record of records) {
      const header = record?.header
      if (!header || typeof header.id !== 'string' || header.id === '') continue
      // Subagent-origin sessions are not conversations a human can join.
      if (header.origin === 'subagent') continue
      if (archived.has(header.id)) continue
      if (typeof workspacePath === 'string' && workspacePath !== '' && header.cwd !== workspacePath) continue
      const hint = this.cachedHint(header)
      items.push({
        id: header.id,
        title: hint.title ?? this.liveTitle(header.id) ?? '',
        cwd: typeof header.cwd === 'string' ? header.cwd : '',
        createdAt: typeof header.createdAt === 'number' ? header.createdAt : 0,
        lastActivityAt: hint.lastActivityAt ?? 0,
        live: record.live === true,
        persisted: record.persisted === true,
      })
      if (items.length >= Math.max(1, limit)) break
    }
    return { available: true, items, total: items.length }
  }

  /**
   * Read the most recent conversation entries of one session.
   *
   * Strategy, in order:
   *  1. the live in-memory log (`agents.get(id).session.snapshotEvents()`),
   *     which needs no persistence;
   *  2. `sessionQuery.readSession(id)`, the complete replayed log.
   *
   * @param {string} sessionId - session id.
   * @param {number} [limit] - maximum entries.
   * @returns {Promise<{ available: boolean, items: Array<object>, source?: string, reason?: string }>} the history.
   */
  async readHistory(sessionId, limit = PEEK_ENTRY_LIMIT) {
    if (typeof sessionId !== 'string' || sessionId === '') {
      return { available: false, items: [], reason: 'no-session-id' }
    }
    const live = this.agents?.get?.(sessionId)?.session
    if (live && typeof live.snapshotEvents === 'function') {
      try {
        const entries = historyEntries(live.snapshotEvents(), limit)
        if (entries.length > 0) return { available: true, items: entries, source: 'live' }
      } catch (error) {
        this.log?.('warn', `wechat-ilink bridge: live event read failed for ${sessionId}: ${String(error)}`)
      }
    }
    const query = this.sessionQuery
    if (typeof query?.readSession !== 'function') {
      return {
        available: live !== undefined,
        items: [],
        reason: 'session-read-unavailable',
      }
    }
    try {
      const snapshot = await query.readSession(sessionId)
      return {
        available: true,
        items: historyEntries(snapshot?.events, limit),
        source: 'persisted',
      }
    } catch (error) {
      this.log?.('warn', `wechat-ilink bridge: readSession(${sessionId}) failed: ${String(error)}`)
      return { available: true, items: [], reason: 'session-read-failed' }
    }
  }
}
