/**
 * Feishu app credentials on disk.
 *
 * Same data directory as the WeChat channel — one plugin, one place for
 * credentials — but its own file, because the two channels are bound
 * independently and one being unbound must not disturb the other.
 *
 * A missing or unparsable file resolves to `null` rather than throwing, so a
 * corrupt file degrades into "bind again" instead of a plugin that will not
 * load.
 *
 * Zero `@deepseek-ai/*` imports (docs/INTERFACES.md §2.0).
 *
 * @module wechat-feishu-linker/feishu/store
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { resolveDataDir } from '../ilink/store.js'

/** The credentials file, beside the WeChat channel's `account.json`. */
export const FEISHU_FILE_NAME = 'feishu.json'

/**
 * Is this a plain object?
 *
 * @param {unknown} value - candidate.
 * @returns {boolean} whether it is a record.
 */
const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * Create a file-backed Feishu credential store.
 *
 * Writes are serialized and atomic: the long-connection row and the settings
 * page can both touch this, and a half-written credentials file would unbind a
 * working channel.
 *
 * @param {{ dataDir?: string }} [options] - `dataDir` defaults to the shared one.
 * @returns {{ load: () => Promise<object|null>, save: (value: object) => Promise<void>, clear: () => Promise<void>, path: string }} the store.
 */
export function createFeishuStore(options = {}) {
  const dataDir =
    typeof options.dataDir === 'string' && options.dataDir.trim() !== ''
      ? options.dataDir.trim()
      : resolveDataDir({})
  const filePath = path.join(dataDir, FEISHU_FILE_NAME)

  /** @type {Promise<unknown>} */
  let queue = Promise.resolve()

  /**
   * Run `task` after every previously queued write.
   *
   * @template T
   * @param {() => Promise<T>} task - the write.
   * @returns {Promise<T>} its result.
   */
  const serialize = (task) => {
    const run = queue.then(task, task)
    queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  /**
   * Read the saved credentials.
   *
   * @returns {Promise<object | null>} the credentials, or null.
   */
  const load = async () => {
    try {
      const parsed = JSON.parse(await readFile(filePath, 'utf8'))
      return isRecord(parsed) ? parsed : null
    } catch {
      return null
    }
  }

  /**
   * Write the credentials.
   *
   * @param {object} value - what to persist.
   * @returns {Promise<void>} resolves once the file is in place.
   */
  const save = (value) =>
    serialize(async () => {
      await mkdir(dataDir, { recursive: true })
      // Write beside the target and rename, so a reader never sees a partial file.
      const temporary = `${filePath}.${process.pid}.tmp`
      await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
      await rename(temporary, filePath)
    })

  /**
   * Forget the credentials.
   *
   * @returns {Promise<void>} resolves once the file is gone.
   */
  const clear = () =>
    serialize(async () => {
      const { rm } = await import('node:fs/promises')
      await rm(filePath, { force: true })
    })

  return { clear, load, path: filePath, save }
}
