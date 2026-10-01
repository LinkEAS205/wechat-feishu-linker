#!/usr/bin/env node
/**
 * Real end-to-end test of the protocol layer against the live iLink service,
 * using the bot credential that the local `cc-connect` installation already
 * obtained by scanning the WeChat QR code.
 *
 *   node scripts/live-check.mjs                 # read-only: getconfig
 *   node scripts/live-check.mjs --send "..."    # also deliver one real message
 *   node scripts/live-check.mjs --poll          # also run one getupdates round
 *   node scripts/live-check.mjs --token <t> --to <userId>
 *
 * Credential discovery order: --token, $DSH_WECHAT_ILINK_TOKEN, then
 * `~/.cc-connect/config.toml` (`[projects.platforms.options]`).
 *
 * WARNING: `--send` really delivers a WeChat message to the target. `--poll`
 * advances the server-side cursor, so only run it while no other client
 * (e.g. cc-connect) is polling the same bot.
 */
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { createIlinkClient } from '../src/ilink/client.js'

const argv = process.argv.slice(2)
const flag = (name) => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}
const has = (name) => argv.includes(name)

/** Pull one `key = "value"` out of the TOML without a TOML dependency. */
function readTomlString(text, key) {
  const re = new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, 'mu')
  return text.match(re)?.[1]
}

async function resolveCredentials() {
  const explicit = flag('--token') || process.env.DSH_WECHAT_ILINK_TOKEN
  if (explicit) return { token: explicit, to: flag('--to') }
  const candidates = [
    join(homedir(), '.cc-connect', 'config.toml'),
    join(process.env.APPDATA ?? '', 'cc-connect', 'config.toml'),
  ]
  for (const file of candidates) {
    try {
      const text = await readFile(file, 'utf8')
      const token = readTomlString(text, 'token')
      if (!token) continue
      return {
        token,
        to: flag('--to') || readTomlString(text, 'admin_from') || readTomlString(text, 'allow_from'),
        source: file,
      }
    } catch {
      /* try the next candidate */
    }
  }
  return {}
}

const mask = (value) => (typeof value === 'string' && value.length > 8 ? `${value.slice(0, 4)}…${value.slice(-4)}` : '<empty>')

const { token, to, source } = await resolveCredentials()
if (!token) {
  console.error('[fail] no iLink bot token found (pass --token or set DSH_WECHAT_ILINK_TOKEN)')
  process.exit(1)
}
console.log(`[info] token ${mask(token)}${source ? ` from ${source}` : ''}`)
console.log(`[info] target ${to ? mask(to) : '(unset)'}`)

const client = createIlinkClient({ token, requestTimeoutMs: 30_000 })
let failures = 0

// 1. getconfig — authenticated, read-only.
// `ilink_user_id` is REQUIRED by the live service: without it the server answers
// `{"ret":-2,"errmsg":"ilink_user_id required"}`.
try {
  const config = await client.getConfig(to ? { ilinkUserId: to } : {})
  const keys = Object.keys(config ?? {}).slice(0, 8)
  console.log(`[ok] getconfig → keys=[${keys.join(', ')}] typing_ticket=${config?.typing_ticket ? 'present' : 'absent'}`)
} catch (error) {
  failures += 1
  console.error(`[fail] getconfig → ${String(error?.message ?? error)}`)
}

// 2. optional long-poll round.
if (has('--poll')) {
  try {
    const result = await client.getUpdates({ buf: '', signal: AbortSignal.timeout(45_000) })
    console.log(`[ok] getupdates → ${result.rawMessages.length} message(s), buf=${mask(result.buf)}`)
  } catch (error) {
    failures += 1
    console.error(`[fail] getupdates → ${String(error?.message ?? error)}`)
  }
}

// 3. optional real delivery.
if (has('--send')) {
  const text = flag('--send') || 'wechat-feishu-linker 端到端测试消息'
  if (!to) {
    failures += 1
    console.error('[fail] --send needs a target user id (--to)')
  } else {
    try {
      await client.sendMessage({ toUserId: to, text })
      console.log(`[ok] sendmessage → delivered "${text.slice(0, 40)}" (HTTP accepted; iLink has no delivery receipt)`)
    } catch (error) {
      failures += 1
      console.error(`[fail] sendmessage → ${String(error?.message ?? error)}`)
    }
  }
}

console.log(failures === 0 ? '[done] live test passed' : `[done] ${failures} step(s) failed`)
process.exitCode = failures === 0 ? 0 : 1
