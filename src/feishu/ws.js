/**
 * Feishu long connection (WebSocket) — the one place this plugin uses the SDK.
 *
 * Feishu pushes events to a long connection this process opens outward, so a
 * desktop behind NAT needs no public callback URL and no tunnel. The trade-off
 * is the official `@larksuiteoapi/node-sdk`, which is why it is loaded lazily:
 * the HTTP and card paths must not pay for the SDK's source being resident, and
 * a host that never binds Feishu must not need the package at all.
 *
 * Three things here are not obvious and were each a bug in the reference
 * implementation before they were fixed:
 *
 * 1. **`start()` returns before the socket is open**, and this SDK version has
 *    no ready callback. Waiting on the returned promise either resolves too
 *    early or hangs; the connection state has to be read from the socket the
 *    SDK actually holds.
 * 2. **`isConnecting === false` while the socket is closed means the reconnect
 *    budget is spent** — a terminal state, not a blip. Reporting it is what lets
 *    the status card say "reconnecting" instead of showing a dead channel as
 *    healthy.
 * 3. **The dispatcher may hand the event's fields to the top level** instead of
 *    nesting them under `event`. Normalization tolerates both; nothing here may
 *    assume the nested shape.
 *
 * Zero `@deepseek-ai/*` imports (docs/INTERFACES.md §2.0).
 *
 * @module wechat-feishu-linker/feishu/ws
 */

/** A Feishu app id, as the platform issues it. */
export const FEISHU_APP_ID_PATTERN = /^cli_[0-9a-fA-F]{16}$/

/** How long to wait for the socket to open before giving up, in ms. */
export const START_TIMEOUT_MS = 20_000

/** How often to sample the socket's real state while starting, in ms. */
export const READY_POLL_MS = 100

/** `WebSocket.OPEN`. */
const OPEN = 1

/**
 * Load the SDK, with an error that says what to do about it.
 *
 * @returns {Promise<object>} the SDK's module namespace.
 */
async function loadSdk() {
  try {
    const mod = await import('@larksuiteoapi/node-sdk')
    return mod.default ?? mod
  } catch (error) {
    throw new Error(
      'Feishu long connection needs @larksuiteoapi/node-sdk, which is not resolvable from this plugin. ' +
        'Install it beside the plugin (see README §安装), then restart. ' +
        `Underlying error: ${String(error)}`,
    )
  }
}

/**
 * Open the long connection and start dispatching events.
 *
 * Resolves once the socket is genuinely open — not when `start()` returns.
 *
 * @param {object} options - startup options.
 * @param {string} options.appId - the `cli_…` app id.
 * @param {string} options.appSecret - the app secret.
 * @param {'feishu' | 'lark'} [options.domain] - which deployment.
 * @param {Record<string, (payload: unknown) => unknown>} options.handlers - event type → handler.
 * @param {AbortSignal} [options.signal] - abort startup.
 * @param {(level: string, message: string) => void} [options.log] - logger.
 * @param {(state: 'connected' | 'reconnecting') => void} [options.onStateChange] - connection state.
 * @returns {Promise<{ close: () => void, terminated: Promise<void> }>} the live client.
 */
export async function startFeishuWebSocket({
  appId,
  appSecret,
  domain = 'feishu',
  handlers,
  signal,
  log,
  onStateChange,
} = {}) {
  if (!FEISHU_APP_ID_PATTERN.test(String(appId ?? ''))) {
    throw new Error(`Feishu app id must look like cli_ + 16 hex characters, got "${appId ?? ''}"`)
  }
  if (!appSecret) throw new Error('Feishu app secret is required to open the long connection')
  if (signal?.aborted) throw new Error('Feishu long connection startup aborted')

  const Lark = await loadSdk()
  // Loading is async, so the caller may have torn the channel down meanwhile; a
  // late module must not open a socket nobody owns.
  if (signal?.aborted) throw new Error('Feishu long connection startup aborted')

  const dispatcher = new Lark.EventDispatcher({})
  dispatcher.register(handlers ?? {})

  return new Promise((resolve, reject) => {
    let startupSettled = false
    let lifecycleSettled = false
    let clientClosed = false
    let unavailable = false
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let startupTimer
    /** @type {ReturnType<typeof setInterval> | undefined} */
    let poll
    let resolveTerminated
    let rejectTerminated

    const terminated = new Promise((resolveLifecycle, rejectLifecycle) => {
      resolveTerminated = resolveLifecycle
      rejectTerminated = rejectLifecycle
    })

    const finishLifecycle = (error) => {
      if (lifecycleSettled) return
      lifecycleSettled = true
      if (poll) clearInterval(poll)
      if (error) rejectTerminated?.(error)
      else resolveTerminated?.()
    }

    const closeClient = () => {
      if (clientClosed) return
      clientClosed = true
      finishLifecycle()
      client.close()
    }

    const fail = (error) => {
      if (startupSettled) return
      startupSettled = true
      if (startupTimer) clearTimeout(startupTimer)
      signal?.removeEventListener('abort', onAbort)
      closeClient()
      reject(error)
    }

    const onAbort = () => fail(new Error('Feishu long connection startup aborted'))

    const client = new Lark.WSClient({
      appId,
      appSecret,
      domain: domain === 'lark' ? Lark.Domain.Lark : Lark.Domain.Feishu,
      loggerLevel: Lark.LoggerLevel?.info,
    })

    // The SDK exposes no readiness callback and `start()` resolves before the
    // socket opens, so the only honest signal is the socket the SDK holds.
    poll = setInterval(() => {
      const sdk = client
      const connected = sdk?.wsConfig?.getWSInstance?.()?.readyState === OPEN
      if (!connected) {
        if (!startupSettled || clientClosed) return
        if (!unavailable) {
          unavailable = true
          onStateChange?.('reconnecting')
        }
        if (sdk?.isConnecting === false) {
          // The reconnect budget is spent: this is terminal, not a blip.
          const error = new Error('Feishu long connection could not be re-established')
          log?.('warn', `wechat-ilink feishu: ${error.message}`)
          finishLifecycle(error)
          closeClient()
        }
        return
      }
      if (startupSettled) {
        if (unavailable) {
          unavailable = false
          onStateChange?.('connected')
        }
        return
      }
      startupSettled = true
      if (startupTimer) clearTimeout(startupTimer)
      signal?.removeEventListener('abort', onAbort)
      resolve({ close: closeClient, terminated })
    }, READY_POLL_MS)

    startupTimer = setTimeout(() => {
      fail(new Error(`Feishu long connection did not open within ${START_TIMEOUT_MS}ms`))
    }, START_TIMEOUT_MS)

    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) {
      onAbort()
      return
    }

    void client.start({ eventDispatcher: dispatcher }).catch((error) => {
      if (!startupSettled) {
        fail(error)
        return
      }
      finishLifecycle(error)
      closeClient()
    })
  })
}
