/**
 * Process-local registry that lets the bridge row find a channel service
 * without importing `@deepseek-ai/*` (see docs/INTERFACES.md §2.0).
 *
 * Both plugin rows live in the same DSH host process and `src/bridge/index.js`
 * imports this very file, so the ESM module cache guarantees one shared
 * instance — no Cordis service lookup and no package resolution involved.
 *
 * The registry is keyed by channel name because the bridge is channel-agnostic:
 * the WeChat channel and the Feishu channel publish the same interface and the
 * bridge picks the right one per conversation. The default key keeps every
 * single-channel call site — and every existing test — working unchanged.
 *
 * @module wechat-feishu-linker/registry
 */

/** The channel a call means when it does not name one. */
export const DEFAULT_CHANNEL = 'wechat-ilink'

/** @type {Map<string, object>} */
const services = new Map()

/**
 * Publish a live channel service.
 *
 * @param {object} instance - the object returned by the service `apply()`.
 * @param {string} [channel] - channel key; defaults to the instance's own
 * `channel` field, then to {@link DEFAULT_CHANNEL}.
 * @returns {object} the same instance, for chaining.
 */
export function setService(instance, channel) {
  const key = channel ?? (typeof instance?.channel === 'string' ? instance.channel : DEFAULT_CHANNEL)
  services.set(key, instance)
  return instance
}

/**
 * Read a live channel service, if its service row has already started.
 *
 * @param {string} [channel] - channel key; defaults to {@link DEFAULT_CHANNEL}.
 * @returns {object | undefined} the service, or undefined when that row is
 * absent, disabled, or still starting.
 */
export function getService(channel) {
  return services.get(channel ?? DEFAULT_CHANNEL)
}

/**
 * Drop a published service.
 *
 * @param {string} [channel] - channel key; omit to drop every channel, which is
 * what teardown wants.
 * @returns {void}
 */
export function clearService(channel) {
  if (channel === undefined) services.clear()
  else services.delete(channel)
}

/** @type {object | undefined} */
let bridgeSettings

/**
 * Publish the bridge's live settings surface.
 *
 * The bridge row owns the values (it is the one that reads them while relaying),
 * so it publishes a handle rather than a copy: the web API must never hold a
 * second copy of a setting, or a change made on one surface could leave the
 * other showing a value nobody is using.
 *
 * @param {object} handle - `{ read(), write(patch) }` published by the bridge row.
 * @returns {object} the same handle, for chaining.
 */
export function setBridgeSettings(handle) {
  bridgeSettings = handle
  return handle
}

/**
 * Read the live bridge settings surface.
 *
 * @returns {object | undefined} the handle, or undefined when the
 * `wechat-ilink-bridge` row is absent, disabled, or still starting.
 */
export function getBridgeSettings() {
  return bridgeSettings
}

/** Drop the published settings handle (used on plugin dispose and by tests). */
export function clearBridgeSettings() {
  bridgeSettings = undefined
}
