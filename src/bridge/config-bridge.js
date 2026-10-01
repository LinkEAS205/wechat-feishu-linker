/**
 * Configuration defaults for the inbound bridge row (`id: wechat-ilink-bridge`).
 *
 * Plain data, no `@deepseek-ai/schemastery` import — see docs/INTERFACES.md §2.0.
 *
 * @module wechat-feishu-linker/bridge/config
 */

import { DEFAULT_CARD_TIMEOUT_MS } from './cards.js'

/** Default values for the `id: wechat-ilink-bridge` row. */
export const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  /** `per-peer` gives every WeChat contact its own DSH session. */
  sessionMode: 'per-peer',
  /** `open` answers any private chat; `allowlist` requires an explicit peer id. */
  dmPolicy: 'open',
  allowlist: [],
  groupPolicy: 'disabled',
  groupAllowlist: [],
  /** Optional DSH agent preset name applied to created sessions. */
  agentPreset: '',
  /**
   * Defaults for sessions this bridge creates.
   *
   * These apply only while a conversation has no selection of its own — the
   * session's own choice always wins, so a model switched from WeChat is never
   * silently undone by a default set here.
   */
  provider: '',
  model: '',
  /** Reasoning effort paired with the default model; empty uses the model's own default. */
  reasoningEffort: '',
  /** Permission preset applied when the bridge creates a session; empty uses the deployment default. */
  permissionPreset: '',
  /** Hard cap for a single outbound reply (longer replies are split). */
  replyMaxChars: 1_800,
  /**
   * How much of a turn reaches WeChat, and when.
   *
   * `compact` (default) delivers the turn's text as it lands, so the contact
   * watches it progress instead of waiting for the whole thing. `quiet` merges
   * the whole turn into one message at `turn/end`. Tool calls and reasoning are
   * never mirrored in either mode.
   *
   * Neither mode sends one message per fragment any more: iLink only accepts a
   * send while the contact's `context_token` is live, and that token is
   * short-lived, so a fragment-per-message turn spends the window long before
   * the answer is ready and the answer is exactly what gets refused.
   */
  displayMode: 'compact',
  /**
   * How long `compact` coalesces fragments before sending them, in ms.
   *
   * A turn emits a dozen model messages, most of them one line of narration;
   * sending each as its own WeChat message spent the conversation window roughly
   * an order of magnitude faster than the turn needed, and the *final* answer —
   * the part that matters — was the one refused when the window closed. Merging
   * everything that lands inside this window keeps the progress feel at a
   * fraction of the sends. `0` restores fragment-per-message.
   */
  compactFlushMs: 8_000,
  typingIndicator: true,
  /**
   * How often to re-signal "正在输入" while a turn is running, in ms.
   *
   * `sendtyping` is a one-shot with no duration — the client shows the indicator
   * briefly and forgets it — so a turn that spends ten minutes in tool calls
   * looks completely idle from WeChat, which is exactly when the contact
   * concludes the agent has stopped.
   *
   * Measured on a real client: the indicator lights for roughly five seconds, so
   * the interval must be shorter than that display window — at 45 s it was dark
   * for ~90% of a long turn, which reads as "it stopped". `0` disables it.
   */
  typingRefreshMs: 5_000,
  commandPrefix: '/',
  /** How long a mirrored approval/question card waits for a reply, in ms. */
  cardTimeoutMs: DEFAULT_CARD_TIMEOUT_MS,
})

/** The display modes this bridge implements. */
export const DISPLAY_MODES = Object.freeze(['compact', 'quiet'])

/**
 * The settings that may differ per channel.
 *
 * These describe how a *channel* delivers — how often it may send, how long its
 * typing indicator lasts, how long one message may be — and those differ by
 * transport, not by taste: WeChat meters messages per contact and closes a
 * conversation window, Feishu does neither. Sharing one value between them means
 * one of the two is always being compromised.
 *
 * Everything else (the allowlists, the command prefix, the session mode) stays
 * global, because it describes the *conversation policy* rather than the
 * transport.
 */
export const PER_CHANNEL_KEYS = Object.freeze([
  'displayMode',
  'compactFlushMs',
  'replyMaxChars',
  'typingIndicator',
  'typingRefreshMs',
  // The defaults a session is created with. A conversation's own choice (from
  // `/model`, `/effort`, `/permission`) still outranks these — they only decide
  // what a *new* session starts from, and the two channels reasonably start
  // differently: one is a phone, the other a desktop client.
  'provider',
  'model',
  'reasoningEffort',
  'permissionPreset',
])

/**
 * Resolve the settings that apply to one channel.
 *
 * The top-level keys are the fallback, so an existing profile keeps working
 * unchanged and only the channels that need a different value have to say so.
 *
 * This is the ONLY way those keys may be read. Reading `config.displayMode`
 * directly somewhere would make that one setting silently ignore its channel —
 * which looks exactly like the setting having been applied.
 *
 * @param {object | undefined} config - resolved config.
 * @param {string | undefined} channel - channel key; undefined means the default.
 * @returns {object} the resolved settings for that channel.
 */
export function channelConfig(config, channel) {
  const resolved = config ?? {}
  const perChannel = channel ? resolved.channels?.[channel] : undefined
  if (!perChannel || typeof perChannel !== 'object') return resolved
  const merged = { ...resolved }
  for (const key of PER_CHANNEL_KEYS) {
    if (perChannel[key] !== undefined) merged[key] = perChannel[key]
  }
  return merged
}

/**
 * Merge user config over the defaults.
 *
 * @param {object | undefined} config - raw config from `cordis.patch.yml`.
 * @returns {typeof DEFAULT_CONFIG} resolved config.
 */
export function withDefaults(config) {
  return { ...DEFAULT_CONFIG, ...(config ?? {}) }
}

export default DEFAULT_CONFIG
