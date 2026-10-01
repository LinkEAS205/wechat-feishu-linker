/**
 * Session routing: binds a WeChat conversation to a live DSH agent.
 *
 * Responsibilities, in one place:
 * - conversation → session key (`per-peer` or `shared`);
 * - session creation/resume through `ctx.get('agents')` with a `pendingAgents`
 *   dedup so two messages from one contact cannot both mint a session;
 * - durable memo of the session a conversation settled on, so continuity
 *   survives a DSH restart;
 * - the agent-scoped composition every WeChat-bound session gets (channel
 *   prompt + model routing);
 * - the live `sessionId → peer` map the outbound relay reads.
 *
 * Zero `@deepseek-ai/*` imports (docs/INTERFACES.md §2.0): message values are
 * constructed locally, every host service is read through `ctx.get(...)` with
 * an undefined check, and a missing service degrades instead of failing load.
 *
 * @module wechat-feishu-linker/bridge/sessions
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { getService } from '../registry.js'
import { readSessionSelection, selectPermission } from './capabilities.js'
import { channelConfig } from './config-bridge.js'

/** Prompt section telling the model its reply is delivered over WeChat. */
export const CHANNEL_PROMPT_SECTION = 'wechat-ilink-channel'

/** Section text injected into every WeChat-bound agent. */
export const CHANNEL_PROMPT_TEXT =
  '你的回复会通过微信投递给用户。请保持简洁、自包含：过长的回答会被拆成多条微信消息，' +
  '附件无法回传。不要输出仅对终端有意义的内容（表格宽度、ANSI 颜色、长路径清单）。'

/** Prompt section order — late, so the channel note reads as an addendum. */
export const CHANNEL_PROMPT_ORDER = 90

/**
 * Deep-freeze a detached value, mirroring the host's message immutability.
 *
 * @param {any} value - value to freeze.
 * @returns {any} the same value, frozen in place.
 */
export function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const key of Object.keys(value)) deepFreeze(value[key])
  }
  return value
}

/**
 * Create one identified user-role message.
 *
 * Vendored from `@deepseek-ai/dsh-llm`'s `createUserMessage` (spread the input,
 * mint a fresh `crypto.randomUUID()` id, deep-freeze) so the bridge adds no
 * runtime dependency on host packages.
 *
 * @param {{ content: unknown[], source?: object }} input - message body.
 * @returns {object} the frozen message.
 */
export function createUserMessage(input) {
  return deepFreeze({ ...input, id: crypto.randomUUID(), role: 'user' })
}

/**
 * Mint a durable session id in the same format the DSH GUI uses.
 *
 * Uniform ids keep WeChat-created sessions indistinguishable from GUI-created
 * ones in session lists, workspace accounting, and log exports.
 *
 * @returns {string} a fresh `session-<uuid>` id.
 */
export function mintSessionId() {
  return `session-${crypto.randomUUID()}`
}

/**
 * Read a session id out of an `agents.get` result / agent handle.
 *
 * @param {unknown} agent - live agent.
 * @returns {string | undefined} the agent's session id.
 */
export function sessionIdOfAgent(agent) {
  if (!agent || typeof agent !== 'object') return undefined
  const candidates = [agent.id, agent.session?.id, agent.session?.header?.id]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate
  }
  return undefined
}

/**
 * Normalize one stored conversation binding.
 *
 * The store predates workspace support and held a bare session-id string;
 * both shapes are accepted so an existing `bridge-sessions.json` keeps working
 * across the upgrade.
 *
 * @param {unknown} value - the raw stored value.
 * @returns {{ sessionId?: string, cwd?: string } | undefined} the normalized binding.
 */
export function normalizeBinding(value) {
  if (typeof value === 'string' && value.length > 0) return { sessionId: value }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const sessionId = typeof value.sessionId === 'string' && value.sessionId !== '' ? value.sessionId : undefined
  const cwd = typeof value.cwd === 'string' && value.cwd !== '' ? value.cwd : undefined
  if (sessionId === undefined && cwd === undefined) return undefined
  return { ...(sessionId ? { sessionId } : {}), ...(cwd ? { cwd } : {}) }
}

/**
 * Merge a patch into a stored binding.
 *
 * @param {{ sessionId?: string, cwd?: string } | undefined} current - existing binding.
 * @param {string | { sessionId?: string, cwd?: string }} patch - string session id or partial binding.
 * @returns {{ sessionId?: string, cwd?: string }} the merged binding.
 */
function mergeBinding(current, patch) {
  const base = current ?? {}
  if (typeof patch === 'string') return { ...base, sessionId: patch }
  const next = { ...base }
  if (typeof patch?.sessionId === 'string' && patch.sessionId !== '') next.sessionId = patch.sessionId
  if (typeof patch?.cwd === 'string' && patch.cwd !== '') next.cwd = patch.cwd
  return next
}

/** In-memory conversation → (session id, workspace) binding (tests, directory-less hosts). */
export class MemorySessionChoiceStore {
  /** @type {Map<string, { sessionId?: string, cwd?: string }>} */
  #entries = new Map()

  /**
   * @param {string} key - conversation key.
   * @returns {{ sessionId?: string, cwd?: string } | undefined} the remembered binding.
   */
  get(key) {
    return normalizeBinding(this.#entries.get(key))
  }

  /**
   * @param {string} key - conversation key.
   * @param {string | { sessionId?: string, cwd?: string }} patch - session id or partial binding.
   * @returns {void}
   */
  set(key, patch) {
    this.#entries.set(key, mergeBinding(normalizeBinding(this.#entries.get(key)), patch))
  }

  /**
   * @param {string} key - conversation key.
   * @returns {void}
   */
  delete(key) {
    this.#entries.delete(key)
  }

  /** @returns {Record<string, object>} a detached snapshot (diagnostics). */
  snapshot() {
    return Object.fromEntries(this.#entries)
  }
}

/**
 * JSON-file-backed conversation → (session id, workspace) binding.
 *
 * Without it, a session that is temporarily unavailable (another live DSH
 * instance holding its write handle) pushes the conversation onto a fresh id,
 * and the next restart silently moves it back — losing everything said in
 * between. A lost memo only costs continuity, never delivery, so every disk
 * failure is swallowed.
 */
export class FileSessionChoiceStore {
  /** @type {string} */
  #file
  /** @type {Record<string, unknown> | undefined} */
  #cache

  /**
   * @param {string} file - absolute path of the memo file.
   */
  constructor(file) {
    this.#file = file
  }

  /**
   * @param {string} key - conversation key.
   * @returns {{ sessionId?: string, cwd?: string } | undefined} the remembered binding.
   */
  get(key) {
    if (this.#cache === undefined) this.#cache = this.#read()
    return normalizeBinding(this.#cache[key])
  }

  /**
   * @param {string} key - conversation key.
   * @param {string | { sessionId?: string, cwd?: string }} patch - session id or partial binding.
   * @returns {void}
   */
  set(key, patch) {
    const next = mergeBinding(this.get(key), patch)
    const serialized = JSON.stringify(next)
    if (JSON.stringify(normalizeBinding(this.#cache?.[key])) === serialized) return
    this.#cache = { ...(this.#cache ?? {}), [key]: next }
    this.#write()
  }

  /**
   * @param {string} key - conversation key.
   * @returns {void}
   */
  delete(key) {
    if (this.#cache === undefined) this.#cache = this.#read()
    if (!(key in this.#cache)) return
    const next = { ...this.#cache }
    delete next[key]
    this.#cache = next
    this.#write()
  }

  /** @returns {void} persists the memo; every disk failure is swallowed. */
  #write() {
    try {
      fs.mkdirSync(path.dirname(this.#file), { recursive: true })
      fs.writeFileSync(this.#file, `${JSON.stringify(this.#cache, null, 2)}\n`, 'utf-8')
    } catch {
      // Losing the memo only costs continuity, never delivery.
    }
  }

  /** @returns {Record<string, unknown>} the on-disk memo, or `{}`. */
  #read() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.#file, 'utf-8'))
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
    } catch {
      return {}
    }
  }
}

/**
 * Build a memo store that resolves its directory lazily.
 *
 * The bridge row can be applied before the channel row has published its
 * `dataDirectory`, so the directory is resolved on first use and the store
 * upgrades from memory to disk as soon as one is available.
 *
 * @param {string | (() => string | undefined) | undefined} resolveDataDir - directory or provider.
 * @returns {{ get: Function, set: Function, delete: Function }} the memo.
 */
export function createSessionChoiceStore(resolveDataDir) {
  /** @type {MemorySessionChoiceStore} */
  const memory = new MemorySessionChoiceStore()
  /** @type {FileSessionChoiceStore | undefined} */
  let file
  const directory = () => {
    try {
      const value = typeof resolveDataDir === 'function' ? resolveDataDir() : resolveDataDir
      return typeof value === 'string' && value.length > 0 ? value : undefined
    } catch {
      return undefined
    }
  }
  const target = () => {
    if (file) return file
    const dir = directory()
    if (!dir) return memory
    file = new FileSessionChoiceStore(path.join(dir, 'bridge-sessions.json'))
    return file
  }
  return {
    get: (key) => target().get(key),
    set: (key, sessionId) => target().set(key, sessionId),
    delete: (key) => target().delete(key),
  }
}

/**
 * Resolve the model for agents this bridge creates.
 *
 * An agent loop applies no default model of its own, so a created agent's very
 * first request fails with an empty provider unless one is supplied — and the
 * host cannot even render its own prompt: `deployment:persona-prefix` contains
 * `{{model}}`, so an assembly without that variable aborts the whole turn with
 * `prompt variable "{{model}}" has no value for this assembly`.
 *
 * Precedence: the session's OWN selection wins, then an explicit provider+model
 * pair in the bridge config, then the deployment's default-model service.
 *
 * The session has to win, and this order is the whole point of the setting being
 * a *default*: a model switched from WeChat (or from the GUI) is appended to the
 * session log, and if the configured pair outranked it, that switch would be
 * silently undone on the very next turn — the contact would see their choice
 * ignored with nothing to explain why.
 *
 * `agentDefaultModel` is optional — not every composition mounts it — so its
 * absence resolves to `undefined` rather than failing the load.
 *
 * Call this LATE, at agent setup: the bridge row is constructed while the host is
 * still bringing services up, so the default model may not be visible yet, and a
 * selection captured at construction time stays undefined forever.
 *
 * @param {object} ctx - plugin context.
 * @param {object} config - resolved bridge config.
 * @param {object} [session] - the live agent's session, when one already exists.
 * @returns {{ provider: string, model: string, reasoningEffort?: string } | undefined} agent options.
 */
export function resolveAgentOptions(ctx, config, session, channel) {
  const selection = readSessionSelection(session)
  if (selection.pending) return selection.pending
  if (selection.lastUsed) return selection.lastUsed

  // The channel's defaults, not the raw config: the two channels reasonably
  // start a new session on different models, and a conversation that chose for
  // itself has already returned above.
  const defaults = channelConfig(config, channel)
  const provider = typeof defaults?.provider === 'string' ? defaults.provider.trim() : ''
  const model = typeof defaults?.model === 'string' ? defaults.model.trim() : ''
  const effort = typeof defaults?.reasoningEffort === 'string' ? defaults.reasoningEffort.trim() : ''
  if (provider && model) return { provider, model, ...(effort ? { reasoningEffort: effort } : {}) }

  try {
    const selected = ctx?.get?.('agentDefaultModel')?.currentSelection?.()
    if (selected && typeof selected.provider === 'string' && typeof selected.model === 'string') {
      if (selected.provider && selected.model) {
        return {
          provider: selected.provider,
          model: selected.model,
          ...(selected.reasoningEffort ? { reasoningEffort: selected.reasoningEffort } : {}),
        }
      }
    }
  } catch {
    // A default-model service mid-teardown simply resolves to none.
  }
  return undefined
}

/**
 * Whether an inbound message is the bot's own message coming back (echo).
 *
 * The protocol layer already drops `message_type === 2`; this is the second
 * gate, keyed on identity, so a normalize regression or a self-addressed
 * message can never start a turn (which would loop forever).
 *
 * @param {object} message - normalized inbound message.
 * @returns {boolean} true when the message must be ignored.
 */
export function isEchoMessage(message) {
  const from = typeof message?.fromUserId === 'string' ? message.fromUserId.trim() : ''
  if (!from) return true
  for (const field of ['selfUserId', 'botUserId', 'botId']) {
    const self = message?.[field]
    if (typeof self === 'string' && self.trim() !== '' && self.trim() === from) return true
  }
  return false
}

/**
 * Decide whether an inbound message may drive an agent.
 *
 * Direct messages and group messages have independent policies; group traffic
 * defaults to disabled because the iLink bot identity usually receives none.
 * A refusal is reported to the sender (`notify`) except when the operator
 * deliberately disabled the channel — replying to a disabled channel would
 * contradict the operator's own switch.
 *
 * @param {object} message - normalized inbound message.
 * @param {object} config - resolved bridge config.
 * @returns {{ allowed: boolean, reason: string, notify: boolean }} the decision.
 */
export function decideAccess(message, config) {
  const groupId = typeof message?.groupId === 'string' ? message.groupId : ''
  if (groupId) {
    const policy = config?.groupPolicy ?? 'disabled'
    if (policy === 'disabled') return { allowed: false, reason: 'group-disabled', notify: false }
    if (policy === 'allowlist') {
      const listed = (config?.groupAllowlist ?? []).includes(groupId)
      return listed
        ? { allowed: true, reason: 'ok', notify: false }
        : { allowed: false, reason: 'group-not-allowlisted', notify: true }
    }
    return { allowed: true, reason: 'ok', notify: false }
  }
  const policy = config?.dmPolicy ?? 'open'
  if (policy === 'disabled') return { allowed: false, reason: 'dm-disabled', notify: false }
  if (policy === 'allowlist') {
    const listed = (config?.allowlist ?? []).includes(message?.fromUserId)
    return listed
      ? { allowed: true, reason: 'ok', notify: false }
      : { allowed: false, reason: 'dm-not-allowlisted', notify: true }
  }
  return { allowed: true, reason: 'ok', notify: false }
}

/**
 * Install the agent-scoped composition every WeChat-bound session receives.
 *
 * Two independent pieces, both optional and both guarded:
 * 1. the channel prompt section, so the model knows its reply is delivered
 *    over WeChat and stays concise;
 * 2. model routing, replicating the GUI's cooperative pattern — snapshot the
 *    selection into prompt assembly and apply it to every request config.
 *    `agents.create({ agentOptions })` is the primary route; these waterfalls
 *    cover hosts where a preset/compaction path re-resolves the request config
 *    without the agent options.
 *
 * @param {object | undefined} agentCtx - the agent's scoped context.
 * @param {object | undefined} agent - the live agent (older hosts pass only the context).
 * @param {{ selection?: object, log?: Function }} [options] - resolved selection + logger.
 * @returns {void}
 */
export function installAgentComposition(agentCtx, agent, options = {}) {
  const ctx = agentCtx ?? agent?.ctx
  const log = options.log
  try {
    const systemPrompt = ctx?.get?.('systemPrompt')
    systemPrompt?.section?.({
      name: CHANNEL_PROMPT_SECTION,
      order: CHANNEL_PROMPT_ORDER,
      text: CHANNEL_PROMPT_TEXT,
    })
  } catch (error) {
    log?.('warn', `wechat-ilink bridge: channel prompt section not installed: ${String(error)}`)
  }
  const selection = options.selection
  if (!selection?.provider || !selection?.model) return
  try {
    ctx?.on?.('system-prompt/assemble', async (_assembly, _context, next) => {
      const assembled = await next()
      return {
        ...assembled,
        variables: {
          ...assembled?.variables,
          provider: selection.provider,
          model: selection.model,
        },
      }
    })
    ctx?.on?.('agent/request', async (_payload, next) => {
      const resolved = await next()
      return {
        ...resolved,
        provider: selection.provider,
        model: selection.model,
        ...(selection.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: selection.reasoningEffort }),
      }
    })
  } catch (error) {
    log?.('warn', `wechat-ilink bridge: model selection waterfall not installed: ${String(error)}`)
  }
}

/** Conversation → live agent router with in-flight creation dedup. */
export class SessionRouter {
  /** @type {Map<string, Promise<{ agent: object, sessionId: string }>>} */
  #pending = new Map()
  /** @type {Map<string, string>} conversation key → session id currently in use. */
  #bound = new Map()
  /** @type {Map<string, string>} conversation key → working directory. */
  #cwd = new Map()
  /** @type {Map<string, object>} session id → peer binding. */
  #links = new Map()

  /**
   * @param {object} options - router inputs.
   * @param {object} options.ctx - plugin context.
   * @param {object} options.config - resolved bridge config.
   * @param {object} [options.choices] - conversation → binding memo.
   * @param {(level: string, message: string) => void} [options.log] - logger.
   * @param {string} [options.cwd] - fallback working directory for created sessions.
   */
  constructor({ ctx, config, choices, log, cwd }) {
    this.ctx = ctx
    this.config = config
    this.choices = choices ?? new MemorySessionChoiceStore()
    this.log = log
    this.cwd = typeof cwd === 'string' && cwd.length > 0 ? cwd : process.cwd()
    this.selection = resolveAgentOptions(ctx, config)
  }

  /**
   * The conversation key one inbound message routes to.
   *
   * @param {object} message - normalized inbound message.
   * @returns {string} the stable per-conversation key.
   */
  keyFor(message) {
    if ((this.config?.sessionMode ?? 'per-peer') === 'shared') return 'wechat-ilink:shared'
    const accountId = typeof message?.accountId === 'string' && message.accountId ? message.accountId : 'default'
    return `wechat-ilink:${accountId}:${message?.fromUserId ?? 'unknown'}`
  }

  /**
   * Bind a live session to the peer it serves (read by the outbound relay).
   *
   * @param {string} sessionId - session id.
   * @param {{ accountId?: string, peerId: string, contextToken?: string }} link - peer binding.
   * @returns {void}
   */
  bind(sessionId, link) {
    if (!sessionId) return
    const previous = this.#links.get(sessionId)
    this.#links.set(sessionId, {
      ...link,
      ...(link?.contextToken ? {} : previous?.contextToken ? { contextToken: previous.contextToken } : {}),
    })
  }

  /**
   * The peer binding for one session, if any.
   *
   * @param {string} sessionId - session id.
   * @returns {{ accountId?: string, peerId: string, contextToken?: string } | undefined} the binding.
   */
  linkFor(sessionId) {
    return sessionId ? this.#links.get(sessionId) : undefined
  }

  /**
   * The stored binding (session + workspace) for one conversation.
   *
   * A live in-process binding wins over the durable memo, so a `/cwd` or
   * `/use` issued in this session is visible immediately even when the memo
   * write fails.
   *
   * @param {string} canonical - conversation key.
   * @returns {{ sessionId?: string, cwd?: string }} the binding (possibly empty).
   */
  bindingFor(canonical) {
    const remembered = this.choices.get(canonical) ?? {}
    const sessionId = this.#bound.get(canonical) ?? remembered.sessionId
    const cwd = this.#cwd.get(canonical) ?? remembered.cwd
    return { ...(sessionId ? { sessionId } : {}), ...(cwd ? { cwd } : {}) }
  }

  /**
   * The session id currently used for a conversation (bound, else memoized).
   *
   * @param {string} canonical - conversation key.
   * @returns {string | undefined} the session id.
   */
  sessionIdFor(canonical) {
    return this.bindingFor(canonical).sessionId
  }

  /**
   * The working directory new sessions of this conversation are created in.
   *
   * Falls back to the deployment-level target the UI may have bound
   * (`service.getTarget()`), then to the router's construction cwd.
   *
   * @param {string} canonical - conversation key.
   * @returns {string} the resolved directory.
   */
  cwdFor(canonical) {
    const own = this.bindingFor(canonical).cwd
    if (own) return own
    const target = this.#defaultTarget()
    if (typeof target?.workspace === 'string' && target.workspace !== '') return target.workspace
    return this.cwd
  }

  /**
   * Remember the working directory for one conversation (`/cwd`).
   *
   * @param {string} canonical - conversation key.
   * @param {string} cwd - absolute directory path.
   * @returns {void}
   */
  setCwd(canonical, cwd) {
    if (typeof cwd !== 'string' || cwd === '') return
    this.#cwd.set(canonical, cwd)
    this.#remember(canonical, { cwd })
  }

  /**
   * Bind a conversation to an existing session (`/use`).
   *
   * @param {string} canonical - conversation key.
   * @param {string} sessionId - an existing durable session id.
   * @returns {void}
   */
  adopt(canonical, sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') return
    this.#bound.set(canonical, sessionId)
    this.#remember(canonical, { sessionId })
  }

  /**
   * The deployment-level target the UI bound, if any.
   *
   * Read through the process-local registry, never `ctx.get('wechatIlink')`:
   * a third-party plugin cannot rely on Cordis service lookup here
   * (docs/INTERFACES.md §2.0).
   *
   * @returns {{ workspace?: string, sessionId?: string } | undefined} the target.
   */
  #defaultTarget() {
    try {
      const service = getService()
      return typeof service?.getTarget === 'function' ? service.getTarget() : undefined
    } catch {
      return undefined
    }
  }

  /**
   * The live agent for a conversation, when one is already running.
   *
   * @param {string} canonical - conversation key.
   * @returns {object | undefined} the live agent.
   */
  agentFor(canonical) {
    const sessionId = this.sessionIdFor(canonical)
    if (!sessionId) return undefined
    return this.agents()?.get?.(sessionId)
  }

  /**
   * Forget a conversation's session binding (`/new`), keeping its workspace.
   *
   * @param {string} canonical - conversation key.
   * @returns {string | undefined} the session id that was bound.
   */
  reset(canonical) {
    const previous = this.sessionIdFor(canonical)
    this.#bound.delete(canonical)
    if (previous) this.#links.delete(previous)
    const remembered = this.choices.get(canonical)
    // Replace, never merge: `set()` merges into the stored entry, so the
    // session id has to be dropped first or `/new` would keep routing to the
    // session it was supposed to forget.
    this.choices.delete(canonical)
    if (remembered?.cwd) {
      // Keep the workspace across `/new`: only the conversation restarts.
      this.choices.set(canonical, { cwd: remembered.cwd })
    }
    return previous
  }

  /**
   * Drop all live state (plugin dispose).
   *
   * @returns {void}
   */
  dispose() {
    this.#pending.clear()
    this.#bound.clear()
    this.#links.clear()
    this.#cwd.clear()
  }

  /**
   * The agent registry, when the host has composed it.
   *
   * @returns {object | undefined} `ctx.get('agents')`.
   */
  agents() {
    try {
      return this.ctx?.get?.('agents')
    } catch {
      return undefined
    }
  }

  /**
   * Resolve the live agent for one conversation, creating or resuming it.
   *
   * Concurrent calls for the same conversation share one in-flight promise, so
   * two messages arriving before the first agent is published cannot both call
   * `agents.create` (the second would fail on a duplicate id). The in-flight
   * entry is dropped once it settles: the registry is authoritative afterwards,
   * and a cached rejection must never wedge the conversation.
   *
   * @param {string} canonical - conversation key.
   * @returns {Promise<{ agent: object, sessionId: string }>} the live agent.
   * @throws when no session could be opened.
   */
  ensureAgent(canonical, channel) {
    const inFlight = this.#pending.get(canonical)
    if (inFlight) return inFlight
    const task = this.#open(canonical, channel).finally(() => {
      if (this.#pending.get(canonical) === task) this.#pending.delete(canonical)
    })
    this.#pending.set(canonical, task)
    return task
  }

  /**
   * Open (or re-open) the session backing one conversation.
   *
   * @param {string} canonical - conversation key.
   * @param {string} [channel] - which channel this conversation arrived on.
   * @returns {Promise<{ agent: object, sessionId: string }>} the live agent.
   */
  async #open(canonical, channel) {
    const agents = this.agents()
    if (!agents || typeof agents.create !== 'function') {
      throw new Error('wechat-ilink bridge: the agents service is unavailable')
    }
    const agentOptions = this.selection
    // Resolve the model AGAIN here, inside setup, rather than trusting the value
    // captured when the bridge row was constructed. The host may not have
    // published `agentDefaultModel` yet at construction time, and a selection
    // captured then stays undefined forever — no `system-prompt/assemble`
    // waterfall is installed, `{{model}}` goes unset, and every turn dies with
    // `prompt variable "{{model}}" has no value ... deployment:persona-prefix`.
    const setup = (agentCtx, agent) => {
      const selection = resolveAgentOptions(this.ctx, this.config, agent?.session, channel) ?? agentOptions
      if (!selection) {
        this.log?.(
          'warn',
          'wechat-ilink bridge: no model resolved (config provider/model empty, the session recorded no ' +
            'request, and agentDefaultModel unavailable) — the agent will fail its first request',
        )
      }
      installAgentComposition(agentCtx, agent, { selection, log: this.log })
    }
    const hasPersistence = Boolean(this.#service('sessionPersistence'))
    const preset = typeof this.config?.agentPreset === 'string' ? this.config.agentPreset.trim() : ''
    // The conversation's own workspace wins over the deployment default, so a
    // `/cwd` (or a UI binding) decides where new sessions are created and where
    // the GUI's sidebar groups them.
    const cwd = this.cwdFor(canonical)
    const meta = { cwd, ...(preset ? { agentPreset: preset } : {}) }
    const bound = this.sessionIdFor(canonical)
    let lastError
    if (bound) {
      const live = agents.get?.(bound)
      if (live) {
        this.#settle(canonical, bound)
        return { agent: live, sessionId: bound }
      }
      if (hasPersistence && typeof agents.resume === 'function') {
        try {
          const handle = await agents.resume({
            resumeSessionId: bound,
            ...(agentOptions ? { agentOptions } : {}),
            setup,
          })
          this.#settle(canonical, bound)
          return { agent: handle.agent, sessionId: bound }
        } catch (error) {
          lastError = error
          this.log?.('info', `wechat-ilink bridge: session ${bound} is not resumable (${String(error)})`)
        }
      }
      try {
        const handle = await agents.create({
          sessionId: bound,
          meta,
          ...(agentOptions ? { agentOptions } : {}),
          setup,
        })
        this.#settle(canonical, bound)
        this.#applyDefaultPermission(handle.agent, channel)
        return { agent: handle.agent, sessionId: bound }
      } catch (error) {
        lastError = error
        this.log?.(
          'warn',
          `wechat-ilink bridge: could not reopen session ${bound} (${String(error)}); minting a new one`,
        )
      }
    }
    const fresh = mintSessionId()
    try {
      const handle = await agents.create({
        sessionId: fresh,
        meta,
        ...(agentOptions ? { agentOptions } : {}),
        setup,
      })
      this.#settle(canonical, fresh)
      this.#applyDefaultPermission(handle.agent, channel)
      return { agent: handle.agent, sessionId: fresh }
    } catch (error) {
      throw lastError ? new AggregateError([lastError, error], 'wechat-ilink bridge: no session could be opened') : error
    }
  }

  /**
   * Apply the configured permission preset to a session the bridge just created.
   *
   * Only on creation. A session that already chose keeps its choice — that is
   * what makes this a *default* rather than an override — and applying it on
   * resume would silently undo a `/permission` the contact ran from WeChat.
   *
   * Best-effort: an unknown preset name must not stop a conversation from
   * starting, it just gets logged.
   *
   * @param {object} agent - the freshly created agent.
   * @param {string} [channel] - which channel this conversation arrived on.
   * @returns {void}
   */
  #applyDefaultPermission(agent, channel) {
    const preset = channelConfig(this.config, channel).permissionPreset
    const trimmed = typeof preset === 'string' ? preset.trim() : ''
    if (!trimmed) return
    const result = selectPermission(this.ctx, agent?.session, trimmed)
    if (!result.ok) {
      this.log?.(
        'warn',
        `wechat-ilink bridge: default permission preset "${trimmed}" was not applied: ${result.message}`,
      )
    }
  }

  /**
   * Remember the session a conversation settled on, and account it to its
   * workspace so the GUI sidebar groups it like any other session.
   *
   * @param {string} canonical - conversation key.
   * @param {string} sessionId - session id in use.
   * @returns {void}
   */
  #settle(canonical, sessionId) {
    this.#bound.set(canonical, sessionId)
    this.#remember(canonical, { sessionId })
    void this.#attachToWorkspace(canonical, sessionId)
  }

  /**
   * Persist a partial binding, never letting a disk failure break the flow.
   *
   * @param {string} canonical - conversation key.
   * @param {{ sessionId?: string, cwd?: string }} patch - fields to merge.
   * @returns {void}
   */
  #remember(canonical, patch) {
    try {
      this.choices.set(canonical, patch)
    } catch (error) {
      this.log?.('warn', `wechat-ilink bridge: could not persist the conversation binding: ${String(error)}`)
    }
  }

  /**
   * Attach a session to the workspace owning the conversation's cwd.
   *
   * Best-effort and never awaited by callers: grouping is a GUI nicety, and a
   * missing `workspaceRegistry` must not delay a reply.
   *
   * @param {string} canonical - conversation key.
   * @param {string} sessionId - session id in use.
   * @returns {Promise<boolean>} true when the session was attached.
   */
  async #attachToWorkspace(canonical, sessionId) {
    const cwd = this.bindingFor(canonical).cwd ?? this.cwd
    const registry = this.#service('workspaceRegistry')
    if (typeof registry?.resolveByPath !== 'function' || typeof cwd !== 'string' || cwd === '') return false
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
   * Read one optional host service.
   *
   * @param {string} name - service name.
   * @returns {unknown} the service, or undefined.
   */
  #service(name) {
    try {
      return this.ctx?.get?.(name)
    } catch {
      return undefined
    }
  }
}
