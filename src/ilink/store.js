/**
 * Account / cursor persistence for the iLink bridge.
 *
 * Frozen contract: `docs/INTERFACES.md` §3.5.
 *
 * Layout inside the data directory:
 *   `account.json`   — the logged-in account (bot token, bot id, login time).
 *   `sync-buf.json`  — `{ "<key>": "<get_updates_buf>" }`, the long-poll cursors.
 *
 * Both files are written atomically (temp file + rename) with mode `0600`, because
 * `account.json` holds a bearer token.
 *
 * @module wechat-feishu-linker/ilink/store
 */
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

/** File name of the account record. */
export const ACCOUNT_FILE_NAME = 'account.json'

/** File name of the sync-cursor map. */
export const SYNC_BUF_FILE_NAME = 'sync-buf.json'

/** Key used by {@link createAccountStore} when no cursor key is supplied. */
export const DEFAULT_BUF_KEY = 'default'

/**
 * Resolve the directory that holds the account file and the sync cursors.
 *
 * Order: `config.dataDir` → `$DSH_HOME/wechat-ilink` → `~/.dsh/wechat-ilink`.
 * A configured value is returned verbatim (no normalization) so callers keep control.
 * 对齐 docs/INTERFACES.md §3.5.
 *
 * @param {{ dataDir?: string } | null | undefined} [config]
 * @returns {string} Absolute or configured data directory.
 */
export function resolveDataDir(config) {
  const configured = typeof config?.dataDir === 'string' ? config.dataDir.trim() : ''
  if (configured) return configured
  const dshHome = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : ''
  if (dshHome) return path.join(dshHome, 'wechat-ilink')
  return path.join(homedir(), '.dsh', 'wechat-ilink')
}

/**
 * Create a file-backed account store.
 *
 * All writes are serialized through an internal queue and performed atomically, so a poll loop
 * and a login flow can share one store without interleaving.
 *
 * @param {{ dataDir?: string }} [options] `dataDir` defaults to {@link resolveDataDir}.
 * @returns {{
 *   load: () => Promise<object|null>,
 *   save: (account: object) => Promise<void>,
 *   clear: () => Promise<void>,
 *   readBuf: (key?: string) => Promise<string>,
 *   writeBuf: (key: string, buf: string) => Promise<void>,
 *   path: string,
 * }} Store handle. `path` is the absolute `account.json` path.
 */
export function createAccountStore(options = {}) {
  const dataDir = typeof options.dataDir === 'string' && options.dataDir.trim() !== ''
    ? options.dataDir.trim()
    : resolveDataDir({})
  const accountPath = path.join(dataDir, ACCOUNT_FILE_NAME)
  const syncBufPath = path.join(dataDir, SYNC_BUF_FILE_NAME)

  /** @type {Promise<unknown>} */
  let queue = Promise.resolve()

  /**
   * Run `task` after every previously queued write.
   *
   * @template T
   * @param {() => Promise<T>} task
   * @returns {Promise<T>}
   */
  function serialize(task) {
    const run = queue.then(task, task)
    queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  /**
   * Load the saved account.
   *
   * A missing or unparsable file resolves to `null` (treated as "not logged in") rather than
   * throwing, so a corrupt file degrades into a re-login instead of a crash.
   *
   * @returns {Promise<object|null>}
   */
  async function load() {
    const parsed = await readJsonFile(accountPath)
    return isPlainRecord(parsed) ? parsed : null
  }

  /**
   * Persist the account record.
   *
   * @param {object} account
   * @returns {Promise<void>}
   * @throws {TypeError} When `account` is not a plain object.
   */
  async function save(account) {
    if (!isPlainRecord(account)) throw new TypeError('createAccountStore.save requires an object')
    return serialize(() => writeJsonFile(accountPath, account))
  }

  /**
   * Remove the stored account **and** the sync cursors.
   *
   * Clearing the cursors too is deliberate: after a re-login a stale cursor would skip messages
   * from the new session.
   *
   * @returns {Promise<void>}
   */
  async function clear() {
    return serialize(async () => {
      await Promise.all([removeIfExists(accountPath), removeIfExists(syncBufPath)])
    })
  }

  /**
   * Read a persisted long-poll cursor.
   *
   * @param {string} [key] Cursor key (defaults to `default`).
   * @returns {Promise<string>} Cursor, or `''` when unknown.
   */
  async function readBuf(key) {
    const map = await readJsonFile(syncBufPath)
    if (!isPlainRecord(map)) return ''
    const value = map[bufKey(key)]
    return typeof value === 'string' ? value : ''
  }

  /**
   * Persist a long-poll cursor.
   *
   * @param {string} key Cursor key (e.g. the peer/bot id).
   * @param {string} buf Cursor value from `get_updates_buf`.
   * @returns {Promise<void>}
   */
  async function writeBuf(key, buf) {
    const resolvedKey = bufKey(key)
    const value = typeof buf === 'string' ? buf : String(buf ?? '')
    return serialize(async () => {
      const existing = await readJsonFile(syncBufPath)
      const map = isPlainRecord(existing) ? { ...existing } : {}
      map[resolvedKey] = value
      await writeJsonFile(syncBufPath, map)
    })
  }

  return { load, save, clear, readBuf, writeBuf, path: accountPath }
}

/**
 * @param {unknown} key
 * @returns {string} Non-empty cursor key.
 */
function bufKey(key) {
  return typeof key === 'string' && key.trim() !== '' ? key.trim() : DEFAULT_BUF_KEY
}

/**
 * Read and parse a JSON file.
 *
 * @param {string} file Absolute path.
 * @returns {Promise<unknown>} Parsed value, or `null` when missing/unreadable/invalid.
 */
async function readJsonFile(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch {
    return null
  }
}

/**
 * Write a JSON file atomically with restrictive permissions.
 *
 * @param {string} file Absolute path.
 * @param {unknown} value JSON-serializable value.
 * @returns {Promise<void>}
 */
async function writeJsonFile(file, value) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  try {
    await chmod(tmp, 0o600)
  } catch {
    // Best effort: chmod is a no-op on some platforms/filesystems.
  }
  try {
    await rename(tmp, file)
  } catch (error) {
    await unlink(tmp).catch(() => {})
    throw error
  }
}

/**
 * Delete a file, ignoring a missing one.
 *
 * @param {string} file Absolute path.
 * @returns {Promise<void>}
 */
async function removeIfExists(file) {
  try {
    await unlink(file)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>} Whether the value is a non-array object.
 */
function isPlainRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
