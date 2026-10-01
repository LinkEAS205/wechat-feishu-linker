/**
 * Plugin entry: the WeChat iLink channel service.
 *
 * Deliberately a *functional* Cordis plugin with zero `@deepseek-ai/*` imports:
 * a third-party plugin cannot resolve those packages from its realpath, and a
 * failed import would take the whole bundle row down. See docs/INTERFACES.md §2.0.
 *
 * The inbound bridge (`wechat-feishu-linker/bridge`) is a separate plugin row so a
 * deployment can run proactive sending without auto-replying.
 *
 * @module wechat-feishu-linker
 */
export const name = 'wechat-ilink'

export { apply, apply as default } from './service.js'
export { DEFAULT_CONFIG, withDefaults } from './config.js'
export { setService, getService, clearService } from './registry.js'

export {
  DEFAULT_ILINK_BASE_URL,
  ILINK_BOT_API_PREFIX,
  CHANNEL_VERSION,
  buildHeaders,
  createIlinkClient,
  IlinkApiError,
  IlinkHttpError,
  IlinkAuthError,
} from './ilink/client.js'

export { beginLogin, pollLogin, normalizeQrStatus } from './ilink/login.js'

export {
  readRawMessages,
  extractNextBuf,
  normalizeInboundMessage,
  buildSendBody,
  normalizeOutboundText,
  chunkText,
} from './ilink/normalize.js'

export { parseAesKey, decryptCdnMedia, guessMimeFromFilename } from './ilink/media.js'
export { createAccountStore, resolveDataDir } from './ilink/store.js'
export { startPollLoop } from './ilink/poll.js'
