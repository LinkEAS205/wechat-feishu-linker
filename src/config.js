/**
 * Configuration defaults for the wechat-feishu-linker channel service.
 *
 * This plugin deliberately does NOT import `@deepseek-ai/schemastery`: a
 * third-party plugin cannot resolve `@deepseek-ai/*` from its realpath, and a
 * failed import would take the whole bundle row down. Defaults therefore live
 * here as plain data and are merged by {@link withDefaults}.
 *
 * Keys marked RESERVED are accepted and preserved but have no effect in this
 * version — they exist so a future release can wire them without a config
 * migration. Independent verification flagged them as misleading when they
 * looked live (docs/VERIFICATION.md V-4).
 *
 * See docs/INTERFACES.md §2.0.
 *
 * @module wechat-feishu-linker/config
 */

/** Default values for the `id: wechat-ilink` row. */
export const DEFAULT_CONFIG = Object.freeze({
  /** Empty resolves to `$DSH_HOME/wechat-ilink` (fallback `~/.dsh/wechat-ilink`). */
  dataDir: '',
  /** RESERVED — this version connects the single stored account only. */
  accounts: [],
  /** `false` loads the service without opening the long poll (outbound still works). */
  autoConnect: true,
  toolEnabled: true,
  /** Long-poll window. The protocol layer caps a single request at 45s. */
  pollTimeoutMs: 45_000,
  requestTimeoutMs: 30_000,
  /** Outbound text is split at this length (WeChat renders long text poorly). */
  maxMessageLength: 1_800,
  /** RESERVED — inbound media download is not wired into the channel service yet. */
  mediaEnabled: true,
  /** RESERVED — see mediaEnabled. */
  mediaMaxBytes: 20 * 1024 * 1024,
  /** RESERVED — see mediaEnabled. */
  mediaCacheDir: '',
  /** iLink bot API base URL. */
  baseUrl: 'https://ilinkai.weixin.qq.com',
  /** RESERVED — media CDN base, used once media download is wired. */
  cdnBaseUrl: 'https://novac2c.cdn.weixin.qq.com/c2c',
})

/** Config keys that are accepted but have no effect in this version. */
export const RESERVED_CONFIG_KEYS = Object.freeze([
  'accounts',
  'mediaEnabled',
  'mediaMaxBytes',
  'mediaCacheDir',
  'cdnBaseUrl',
])

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
