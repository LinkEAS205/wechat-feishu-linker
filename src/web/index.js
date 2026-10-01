/**
 * Cordis wiring for the plugin's host-side HTTP API.
 *
 * The webServer row activates *after* this plugin in a normal profile, so
 * `ctx.get('webServer')` is undefined at apply time. Registration therefore goes
 * through Cordis' conditional-injection pattern (`ctx.inject([...], cb)` — a
 * context method, not an import), which is the same shape the shipped
 * `dsh-wechat` plugin uses. When no webServer is composed the callback never
 * runs: the plugin still loads, and the settings UI reports "当前宿主未启用 Web
 * 服务" from its own failed fetch.
 *
 * @module wechat-feishu-linker/web
 */

import { DEFAULT_CHANNEL, getService as getRegistryService } from '../registry.js'
import { createWebApi, WEB_API_PREFIX } from './routes.js'

export { WEB_API_PREFIX, createWebApi } from './routes.js'
export { createQrMatrix, qrSvg } from './qrcode.js'

/**
 * The one mounted API, and how to tear it down.
 *
 * Process-level on purpose: the host serves one route per prefix, and every
 * channel row asks for this API. First one in mounts it; the rest are no-ops
 * until it is disposed.
 *
 * @type {{ dispose: () => void } | undefined}
 */
let mounted

/**
 * Forget the mounted API, so a later row can mount a fresh one.
 *
 * @returns {void}
 */
export function resetWebApiMount() {
  mounted = undefined
}

/**
 * Mount the API on the host webServer.
 *
 * @param {object} ctx - plugin context.
 * @param {object} [options] - mount options.
 * @param {object} [options.service] - the channel service instance; defaults to
 * the process-local registry lookup.
 * @param {object} [options.config] - resolved plugin config.
 * @param {(level: string, message: string) => void} [options.log] - logger.
 * @param {object} [options.deps] - protocol/store test seams.
 * @returns {() => void} disposer removing the route and the event listener.
 */
export function mountWebApi(ctx, options = {}) {
  // One route per prefix, so this is a process-level singleton: every channel
  // row wants the API and whichever starts first actually mounts it. Without the
  // guard the second row's `register` would be a duplicate, and without the
  // second row calling in at all, a profile that disables the WeChat row leaves
  // the Feishu card with no routes — which it then reports as "the channel is
  // not loaded", a misdiagnosis of a perfectly healthy channel.
  if (mounted !== undefined) return () => {}

  const log = typeof options.log === 'function' ? options.log : () => {}
  const api = createWebApi({
    config: options.config,
    log,
    deps: options.deps,
    /**
     * Resolve a channel service for one route.
     *
     * The registry is authoritative — it is keyed by channel and both rows
     * publish into it. The service handed in by the mounting row is only a
     * fallback, and only for the channel it actually is: mount order must not
     * decide which service answers, or a Feishu-first mount would hand the
     * WeChat routes the Feishu service. (The reverse already happened once: a
     * lookup that ignored the argument answered a Feishu route with the WeChat
     * service, and because both have `beginLogin` it replied with a *plausible*
     * payload — a WeChat QR where a Feishu device code belonged.)
     */
    getService: (channel) => {
      const key = channel ?? DEFAULT_CHANNEL
      const fromRegistry = getRegistryService(key)
      if (fromRegistry !== undefined) return fromRegistry
      const own = typeof options.service === 'function' ? options.service(key) : options.service
      if (own === undefined) return undefined
      return (own.channel ?? DEFAULT_CHANNEL) === key ? own : undefined
    },
    onError: (event) => {
      try {
        ctx?.emit?.('wechat-ilink/web-error', event)
      } catch {
        // An emit failure must not break the response.
      }
    },
  })

  /** @type {(() => void) | undefined} */
  let disposeRoute

  /**
   * @param {object} scope - context that owns the webServer.
   * @returns {void}
   */
  const register = (scope) => {
    let webServer
    try {
      webServer = scope?.get?.('webServer')
    } catch {
      webServer = undefined
    }
    if (!webServer) {
      try {
        webServer = ctx?.get?.('webServer')
      } catch {
        webServer = undefined
      }
    }
    if (!webServer || typeof webServer.register !== 'function') return
    try {
      disposeRoute = webServer.register({
        kind: 'prefix',
        path: WEB_API_PREFIX,
        handler: api.handler,
      })
    } catch (error) {
      log('warn', `wechat-ilink: could not register ${WEB_API_PREFIX}: ${String(error)}`)
    }
  }

  if (typeof ctx?.inject === 'function') {
    try {
      ctx.inject(['webServer'], (scoped) => register(scoped))
    } catch (error) {
      log('warn', `wechat-ilink: webServer injection failed: ${String(error)}`)
    }
  } else {
    register(ctx)
  }

  // Channel poll failures surface as `wechat-ilink/error` (see src/service.js);
  // mirroring them here is what fills `/status.lastError`.
  /** @type {(() => void) | undefined} */
  let disposeErrorListener
  if (typeof ctx?.on === 'function') {
    try {
      disposeErrorListener = ctx.on('wechat-ilink/error', (event) => {
        api.recordError(typeof event?.message === 'string' ? event.message : String(event))
      })
    } catch {
      // Event subscription is best-effort.
    }
  }

  const dispose = () => {
    try {
      disposeRoute?.()
    } catch {
      // Already disposed by the webServer teardown.
    }
    disposeRoute = undefined
    try {
      disposeErrorListener?.()
    } catch {
      // Already disposed by the context teardown.
    }
    disposeErrorListener = undefined
    api.dispose()
    // Release the singleton so the next channel row to start mounts a fresh API.
    if (mounted?.dispose === dispose) mounted = undefined
  }

  mounted = { dispose }

  if (typeof ctx?.effect === 'function') {
    try {
      ctx.effect(() => dispose, 'wechat-ilink: web api')
    } catch {
      // The caller still owns the returned disposer.
    }
  }

  return dispose
}

export default mountWebApi
