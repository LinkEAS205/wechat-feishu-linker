/**
 * Long-poll loop for `getupdates`.
 *
 * Frozen contract: `docs/INTERFACES.md` §3.6.
 *
 * Resilience rules (hard requirements):
 *   - a long-poll timeout or any network error must **back off and retry**, never exit the loop;
 *   - `signal.aborted` (or {@link PollLoop.stop}) must end the loop immediately, including an
 *     in-flight long poll;
 *   - `done` never rejects.
 *
 * @module wechat-feishu-linker/ilink/poll
 */

/** Initial retry delay. 对齐 docs/INTERFACES.md §3.6. */
export const DEFAULT_POLL_BACKOFF_MS = 3_000

/** Ceiling for the exponential backoff. */
export const DEFAULT_MAX_BACKOFF_MS = 30_000

/**
 * Start polling `client.getUpdates` until stopped.
 *
 * @param {object} options
 * @param {{ getUpdates: (options: { buf: string, signal: AbortSignal }) => Promise<{ rawMessages?: object[], buf?: string }> }} options.client
 *   iLink client (see `createIlinkClient`).
 * @param {() => string | Promise<string>} options.getBuf Reads the persisted cursor.
 * @param {(buf: string) => void | Promise<void>} options.setBuf Persists the new cursor.
 * @param {(rawMessages: object[]) => void | Promise<void>} options.onMessages Called with each non-empty batch.
 * @param {(error: unknown, phase?: string) => void} [options.onError] Error sink (never awaited).
 * @param {AbortSignal} [options.signal] External stop signal.
 * @param {{ debug?: Function, warn?: Function }} [options.logger] Optional logger.
 * @param {number} [options.backoffMs] Initial retry delay (default 3000).
 * @param {number} [options.maxBackoffMs] Backoff ceiling (default 30000).
 * @returns {{ stop: () => void, done: Promise<void> }} `stop()` aborts the in-flight poll and resolves `done`.
 * @throws {TypeError} When a required callback is missing.
 */
export function startPollLoop(options = {}) {
  const {
    client,
    getBuf,
    setBuf,
    onMessages,
    onError,
    signal,
    logger,
    backoffMs = DEFAULT_POLL_BACKOFF_MS,
    maxBackoffMs = DEFAULT_MAX_BACKOFF_MS,
  } = options

  if (!client || typeof client.getUpdates !== 'function') {
    throw new TypeError('startPollLoop requires a client with getUpdates()')
  }
  if (typeof getBuf !== 'function' || typeof setBuf !== 'function') {
    throw new TypeError('startPollLoop requires getBuf() and setBuf()')
  }
  if (typeof onMessages !== 'function') {
    throw new TypeError('startPollLoop requires onMessages()')
  }

  // Own controller so stop() can abort an in-flight long poll even when the caller passes no signal.
  const controller = new AbortController()
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
  let stopped = false

  /** @returns {boolean} */
  function isAborted() {
    return stopped || combined.aborted
  }

  /**
   * Report a failure without ever throwing out of the loop.
   *
   * @param {unknown} error
   * @param {string} phase
   */
  function reportError(error, phase) {
    const message = error instanceof Error ? error.message : String(error)
    try {
      logger?.warn?.(`[wechat-ilink] poll ${phase} failed: ${message}`)
    } catch {
      // A broken logger must not stop the loop.
    }
    if (typeof onError === 'function') {
      try {
        const result = onError(error, phase)
        if (result && typeof result.then === 'function') result.then(undefined, () => {})
      } catch {
        // An error sink that throws is still just a sink.
      }
    }
  }

  /**
   * Abortable delay. Resolves immediately when the loop is already stopping.
   *
   * @param {number} ms
   * @returns {Promise<void>}
   */
  function sleep(ms) {
    if (isAborted()) return Promise.resolve()
    return new Promise((resolve) => {
      let timer = null
      const finish = () => {
        if (timer !== null) clearTimeout(timer)
        timer = null
        combined.removeEventListener('abort', finish)
        resolve()
      }
      timer = setTimeout(finish, ms)
      combined.addEventListener('abort', finish, { once: true })
    })
  }

  /** @returns {Promise<string>} */
  async function readBufSafe() {
    try {
      const value = await getBuf()
      return typeof value === 'string' ? value : ''
    } catch (error) {
      reportError(error, 'getBuf')
      return ''
    }
  }

  const done = (async () => {
    let failures = 0
    try {
      while (!isAborted()) {
        try {
          const buf = await readBufSafe()
          const result = await client.getUpdates({ buf, signal: combined })
          if (isAborted()) break
          failures = 0

          const nextBuf = typeof result?.buf === 'string' ? result.buf : ''
          if (nextBuf !== '' && nextBuf !== buf) {
            try {
              await setBuf(nextBuf)
            } catch (error) {
              reportError(error, 'setBuf')
            }
          }

          const rawMessages = Array.isArray(result?.rawMessages) ? result.rawMessages : []
          if (rawMessages.length > 0) {
            try {
              await onMessages(rawMessages)
            } catch (error) {
              reportError(error, 'onMessages')
            }
          }

          // Always hand the event loop back between iterations. Without this a server that
          // answers instantly keeps the loop inside the microtask queue, which starves timers,
          // abort handling and the rest of the plugin (observed as a hung test process).
          await yieldToEventLoop()
        } catch (error) {
          if (isAborted()) break
          failures += 1
          reportError(error, 'getUpdates')
          const delay = computeBackoff(failures, backoffMs, maxBackoffMs)
          logger?.debug?.(`[wechat-ilink] poll retry #${failures} in ${delay}ms`)
          await sleep(delay)
        }
      }
    } catch (error) {
      // Defensive: nothing below should throw, but `done` must never reject.
      reportError(error, 'loop')
    }
  })()

  /** Stop the loop and abort any in-flight long poll. Idempotent. */
  function stop() {
    if (stopped) return
    stopped = true
    controller.abort()
  }

  return { stop, done }
}

/**
 * Yield to the macrotask queue exactly once.
 *
 * @returns {Promise<void>}
 */
function yieldToEventLoop() {
  return new Promise((resolve) => {
    setImmediate(resolve)
  })
}

/**
 * Exponential backoff with a ceiling: `base, base*2, base*4, …` capped at `max`.
 *
 * @param {number} failures Consecutive failure count (1-based).
 * @param {number} base Initial delay.
 * @param {number} max Ceiling.
 * @returns {number} Delay in milliseconds.
 */
export function computeBackoff(failures, base = DEFAULT_POLL_BACKOFF_MS, max = DEFAULT_MAX_BACKOFF_MS) {
  const safeBase = Number.isFinite(base) && base > 0 ? base : DEFAULT_POLL_BACKOFF_MS
  const safeMax = Number.isFinite(max) && max > 0 ? max : DEFAULT_MAX_BACKOFF_MS
  const exponent = Math.min(Math.max(failures, 1) - 1, 30)
  return Math.min(safeBase * 2 ** exponent, Math.max(safeBase, safeMax))
}
