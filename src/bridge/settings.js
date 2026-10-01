/**
 * The bridge settings the GUI is allowed to change at runtime.
 *
 * Both surfaces — the settings page and the bridge that actually relays — must
 * never hold separate copies of these values: the bridge's resolved config IS
 * the value, and the page renders whatever it is told. That is the whole reason
 * this module exposes `read`/`apply` over one config object instead of letting
 * the web layer keep its own state.
 *
 * Zero `@deepseek-ai/*` imports (docs/INTERFACES.md §2.0).
 *
 * @module wechat-feishu-linker/bridge/settings
 */

import { PER_CHANNEL_KEYS } from './config-bridge.js'

/** Settings the settings page may write, in display order. */
export const EDITABLE_SETTINGS = Object.freeze([
  'displayMode',
  'typingIndicator',
  'provider',
  'model',
  'reasoningEffort',
  'permissionPreset',
])

/** The only `displayMode` values, matching `DEFAULT_CONFIG`. */
const DISPLAY_MODES = Object.freeze(['compact', 'quiet'])

/** Keys whose value is a plain string (empty means "fall back to the deployment default"). */
const STRING_SETTINGS = Object.freeze(['provider', 'model', 'reasoningEffort', 'permissionPreset'])

/**
 * Reject one value that no setting could use.
 *
 * @param {string} key - the setting name.
 * @param {unknown} value - the candidate.
 * @returns {string | null} an error message, or null when it is acceptable.
 */
function validateValue(key, value) {
  if (key === 'displayMode') {
    if (typeof value !== 'string' || !DISPLAY_MODES.includes(value)) {
      return `displayMode 只能是 ${DISPLAY_MODES.join(' 或 ')}`
    }
    return null
  }
  if (key === 'typingIndicator') return typeof value === 'boolean' ? null : 'typingIndicator 必须是布尔值'
  if (STRING_SETTINGS.includes(key)) {
    return typeof value === 'string' ? null : `${key} 必须是字符串（空字符串表示用部署默认）`
  }
  if (key === 'compactFlushMs' || key === 'replyMaxChars' || key === 'typingRefreshMs') {
    return Number.isFinite(value) && value >= 0 ? null : `${key} 必须是非负数字`
  }
  return `不支持的设置项：${key}`
}

/**
 * A model default is a provider AND a model, or neither.
 *
 * Half a pair is silently ignored by the resolver, which looks exactly like a
 * save that did nothing — so it is refused instead.
 *
 * @param {object} entry - the settings being validated.
 * @returns {string | null} an error message, or null when the pair is coherent.
 */
function checkModelPair(entry) {
  // Key presence is not enough: a merged entry carries the key with an
  // `undefined` value when nothing supplied it, and `Object.hasOwn` is true for
  // that — which would skip the very check this exists to perform.
  const provider = entry?.provider === undefined ? undefined : entry.provider
  const model = entry?.model === undefined ? undefined : entry.model
  if (provider !== undefined && model !== undefined && Boolean(provider) !== Boolean(model)) {
    return 'provider 和 model 必须同时给出，或同时留空'
  }
  return null
}

/** The channels the settings page can configure separately. */
export const KNOWN_CHANNELS = Object.freeze(['wechat-ilink', 'feishu'])

/**
 * Read the settings a client should render.
 *
 * Values are normalized exactly the way the relay reads them, so the page can
 * never show `quiet` while the relay treats the mode as `compact`.
 *
 * The model and permission entries are the **defaults for sessions this bridge
 * creates** — not the live value of any conversation. A conversation that has
 * chosen for itself keeps its choice, which is what makes these defaults safe to
 * change at any time.
 *
 * `channels` carries what each channel overrides. Only keys a channel actually
 * sets appear there, so the page can show "inheriting" rather than a copy of the
 * fallback — two copies of a value is how one surface ends up displaying
 * something nobody is using.
 *
 * @param {object} config - the bridge's resolved config.
 * @returns {object} the live settings, top level being the fallback.
 */
export function readSettings(config) {
  const text = (value) => (typeof value === 'string' ? value.trim() : '')
  const channels = {}
  for (const name of KNOWN_CHANNELS) {
    const overrides = config?.channels?.[name]
    if (!overrides || typeof overrides !== 'object') continue
    const entry = {}
    for (const key of PER_CHANNEL_KEYS) {
      if (overrides[key] === undefined) continue
      entry[key] = typeof overrides[key] === 'string' ? overrides[key].trim() : overrides[key]
    }
    if (Object.keys(entry).length > 0) channels[name] = entry
  }
  return {
    displayMode: config?.displayMode === 'quiet' ? 'quiet' : 'compact',
    typingIndicator: config?.typingIndicator !== false,
    provider: text(config?.provider),
    model: text(config?.model),
    reasoningEffort: text(config?.reasoningEffort),
    permissionPreset: text(config?.permissionPreset),
    channels,
    channelNames: [...KNOWN_CHANNELS],
  }
}

/**
 * Validate one client-supplied patch.
 *
 * Rejects unknown keys and wrong types rather than coercing them: a typo in a
 * settings page must not silently become "the default", because the caller
 * cannot tell that apart from a successful write.
 *
 * @param {unknown} patch - parsed request body.
 * @param {object} [config] - the live config, so a channel's pair can be checked
 * against what it will actually inherit.
 * @returns {{ ok: true, patch: object } | { ok: false, message: string }} the outcome.
 */
export function validateSettings(patch, config) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return { ok: false, message: '请求体必须是一个对象' }
  }
  for (const key of Object.keys(patch)) {
    if (key !== 'channels' && !EDITABLE_SETTINGS.includes(key)) {
      return { ok: false, message: `不支持的设置项：${key}` }
    }
  }
  const accepted = {}
  for (const key of EDITABLE_SETTINGS) {
    if (!Object.hasOwn(patch, key)) continue
    const problem = validateValue(key, patch[key])
    if (problem) return { ok: false, message: problem }
    accepted[key] = typeof patch[key] === 'string' ? patch[key].trim() : patch[key]
  }
  // The pair rule applies inside a channel too: half a pair is silently ignored
  // by the resolver, which is indistinguishable from a save that did nothing.
  const problem = checkModelPair(accepted)
  if (problem) return { ok: false, message: problem }

  if (Object.hasOwn(patch, 'channels')) {
    const channels = patch.channels
    if (!channels || typeof channels !== 'object' || Array.isArray(channels)) {
      return { ok: false, message: 'channels 必须是一个对象（通道名 → 覆盖项）' }
    }
    const acceptedChannels = {}
    for (const name of Object.keys(channels)) {
      if (!KNOWN_CHANNELS.includes(name)) return { ok: false, message: `未知通道：${name}` }
      const overrides = channels[name]
      if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) {
        return { ok: false, message: `channels.${name} 必须是一个对象` }
      }
      const entry = {}
      for (const key of Object.keys(overrides)) {
        if (!PER_CHANNEL_KEYS.includes(key)) {
          return { ok: false, message: `通道 ${name} 不支持按通道设置：${key}` }
        }
        const invalid = validateValue(key, overrides[key])
        if (invalid) return { ok: false, message: `${name}: ${invalid}` }
        // An empty string is kept, not dropped: it means "inherit the top level",
        // and `applySettings` needs to see it in order to remove the override.
        entry[key] = typeof overrides[key] === 'string' ? overrides[key].trim() : overrides[key]
      }
      const pairProblem = checkModelPair(entry)
      if (pairProblem) return { ok: false, message: `${name}: ${pairProblem}` }
      // A channel may name only one half of the pair, because it inherits the
      // other — but only if the other actually resolves. Checking the group alone
      // would accept `model` with no provider anywhere, and the resolver then
      // ignores the whole thing without saying so.
      // Clearing one half of the pair means "inherit the pair", so the other half
      // is cleared with it rather than refused. Refusing here would make the
      // page's own "inherit" option unusable, which is a worse outcome than the
      // thing the rule protects against.
      if (entry.model === '' && entry.provider === undefined) entry.provider = ''
      if (entry.provider === '' && entry.model === undefined) entry.model = ''
      const inherited = {
        provider: Object.hasOwn(accepted, 'provider') ? accepted.provider : config?.provider,
        model: Object.hasOwn(accepted, 'model') ? accepted.model : config?.model,
      }
      const mergedProvider = Object.hasOwn(entry, 'provider') ? entry.provider : inherited.provider
      const mergedModel = Object.hasOwn(entry, 'model') ? entry.model : inherited.model
      const filled = (value) => typeof value === 'string' && value.trim() !== ''
      if (filled(mergedProvider) !== filled(mergedModel)) {
        return {
          ok: false,
          message: `${name}: provider 和 model 必须同时有值（顶层也没有可继承的另一半，解析器会静默忽略）`,
        }
      }
      acceptedChannels[name] = entry
    }
    accepted.channels = acceptedChannels
  }

  if (Object.keys(accepted).length === 0) return { ok: false, message: '请求体里没有任何可写的设置项' }
  return { ok: true, patch: accepted }
}

/**
 * Apply a validated patch to the live config, in place.
 *
 * In place on purpose: the relay closes over this exact object and reads it on
 * every event, so mutating it is what makes a settings change take effect
 * without a restart.
 *
 * @param {object} config - the bridge's resolved config (mutated).
 * @param {object} patch - a patch already accepted by {@link validateSettings}.
 * @returns {void}
 */
export function applySettings(config, patch) {
  if (!config || typeof config !== 'object') return
  for (const key of EDITABLE_SETTINGS) {
    if (Object.hasOwn(patch, key)) config[key] = patch[key]
  }
  if (!Object.hasOwn(patch, 'channels')) return
  // An empty value means "inherit the top level", which has to *remove* the
  // override — writing a blank would pin the channel to a value no setting can
  // use, and the page would then show it as set rather than inherited.
  const channels = typeof config.channels === 'object' && config.channels !== null ? config.channels : {}
  for (const [name, overrides] of Object.entries(patch.channels ?? {})) {
    const existing = typeof channels[name] === 'object' && channels[name] !== null ? channels[name] : {}
    for (const [key, value] of Object.entries(overrides)) {
      if (typeof value === 'string' && value.trim() === '') delete existing[key]
      else existing[key] = value
    }
    if (Object.keys(existing).length > 0) channels[name] = existing
    else delete channels[name]
  }
  config.channels = channels
}
