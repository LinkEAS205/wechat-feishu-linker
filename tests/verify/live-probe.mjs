#!/usr/bin/env node
/**
 * Verifier-owned raw protocol probe (NOT a test file: the name deliberately
 * does not match the `node --test` discovery globs, so it is never run by CI).
 *
 * Prints the *raw* iLink envelopes (ret / errcode / errmsg included) instead of
 * the normalized shape `scripts/probe-ilink.mjs` reports, so the verification
 * report can quote protocol truth rather than a conclusion.
 *
 *   node tests/verify/live-probe.mjs                # QR surface (unauthenticated)
 *   node tests/verify/live-probe.mjs --auth         # + getconfig with/without ilink_user_id
 *   node tests/verify/live-probe.mjs --auth --to <ilinkUserId>
 *
 * Credentials: --token, $DSH_WECHAT_ILINK_TOKEN, or ~/.cc-connect/config.toml.
 * Requires the proxy env when the machine has no direct egress:
 *   HTTPS_PROXY=http://127.0.0.1:7890 NODE_USE_ENV_PROXY=1
 */
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { buildHeaders, createIlinkClient, ILINK_BOT_API_PREFIX, DEFAULT_ILINK_BASE_URL } from '../../src/ilink/client.js'

const argv = process.argv.slice(2)
const flag = (name) => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}
const has = (name) => argv.includes(name)

const mask = (v) => (typeof v === 'string' && v.length > 8 ? `${v.slice(0, 4)}…${v.slice(-4)}` : String(v))

/** Show only the fields the verification cares about, with ret/errcode intact. */
function summarize(payload) {
  if (!payload || typeof payload !== 'object') return { raw: String(payload).slice(0, 200) }
  const keep = ['ret', 'errcode', 'errmsg', 'message', 'status', 'qrcode', 'qrcode_img_content', 'qrcode_url', 'expires_in', 'ilink_bot_id', 'bot_id', 'longpolling_timeout_ms']
  const out = {}
  for (const key of keep) if (key in payload) out[key] = payload[key]
  out.__otherKeys = Object.keys(payload).filter((k) => !keep.includes(k)).slice(0, 12)
  if (typeof payload.bot_token === 'string') out.bot_token = mask(payload.bot_token)
  if (typeof payload.token === 'string') out.token = mask(payload.token)
  if (typeof payload.typing_ticket === 'string') out.typing_ticket = mask(payload.typing_ticket)
  return out
}

async function rawGet(path, extraHeaders = {}) {
  const res = await fetch(`${DEFAULT_ILINK_BASE_URL}${ILINK_BOT_API_PREFIX}${path}`, {
    headers: { 'iLink-App-ClientVersion': '1', ...extraHeaders },
    signal: AbortSignal.timeout(45_000),
  })
  const text = await res.text()
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = text
  }
  return { http: res.status, payload: parsed }
}

async function rawPost(path, token, body) {
  const res = await fetch(`${DEFAULT_ILINK_BASE_URL}${ILINK_BOT_API_PREFIX}${path}`, {
    method: 'POST',
    headers: buildHeaders(token),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(45_000),
  })
  const text = await res.text()
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = text
  }
  return { http: res.status, payload: parsed }
}

async function resolveToken() {
  const explicit = flag('--token') || process.env.DSH_WECHAT_ILINK_TOKEN
  if (explicit) return { token: explicit, to: flag('--to') }
  const file = join(homedir(), '.cc-connect', 'config.toml')
  const text = await readFile(file, 'utf8')
  const read = (key) => text.match(new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, 'mu'))?.[1]
  return { token: read('token'), to: flag('--to') || read('admin_from') || read('allow_from'), source: file }
}

console.log('== unauthenticated QR surface ==')
const qr = await rawGet('/get_bot_qrcode?bot_type=3')
console.log(`GET /get_bot_qrcode -> HTTP ${qr.http} ${JSON.stringify(summarize(qr.payload))}`)
const qrcode = qr.payload?.qrcode
if (qrcode) {
  const started = Date.now()
  const st = await rawGet(`/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`)
  console.log(
    `GET /get_qrcode_status -> HTTP ${st.http} after ${Date.now() - started}ms ${JSON.stringify(summarize(st.payload))}`,
  )
}

if (has('--auth')) {
  console.log('\n== authenticated POST surface ==')
  const { token, to, source } = await resolveToken()
  if (!token) {
    console.error('no token found')
    process.exit(2)
  }
  console.log(`token ${mask(token)}${source ? ` from ${source}` : ''}  target ${to ? mask(to) : '(unset)'}`)
  if (to) console.log(`target kind: len=${to.length} suffix=${JSON.stringify(to.slice(-12))} chatroom=${to.includes('@chatroom')}`)

  const bare = await rawPost('/getconfig', token, { base_info: { channel_version: '2.0.0' } })
  console.log(`POST /getconfig {} -> HTTP ${bare.http} ${JSON.stringify(summarize(bare.payload))}`)

  if (to) {
    const withUser = await rawPost('/getconfig', token, {
      base_info: { channel_version: '2.0.0' },
      ilink_user_id: to,
    })
    console.log(`POST /getconfig {ilink_user_id} -> HTTP ${withUser.http} ${JSON.stringify(summarize(withUser.payload))}`)
  } else {
    console.log('POST /getconfig {ilink_user_id} -> skipped (no target user id)')
  }

  // Optional single real send, through the PRODUCT client, to isolate whether a
  // non-empty from_user_id changes the outcome. `--from <id>` overrides it.
  const sendText = flag('--send')
  if (sendText) {
    if (!to) {
      console.error('--send needs a target (--to or admin_from in config.toml)')
      process.exit(3)
    }
    const fromUserId = flag('--from') ?? token.slice(0, token.indexOf(':') >= 0 ? token.indexOf(':') : undefined)
    console.log(`\n== single real send (from_user_id=${JSON.stringify(fromUserId)}) ==`)
    const client = createIlinkClient({ token, fromUserId, requestTimeoutMs: 30_000 })
    try {
      const response = await client.sendMessage({ toUserId: to, text: sendText })
      console.log(`POST /sendmessage -> ok, response=${JSON.stringify(summarize(response))}`)
    } catch (error) {
      console.log(`POST /sendmessage -> ${error?.name}: ${error?.message}`)
      console.log(`  ret=${error?.ret} errcode=${error?.errcode} errmsg=${JSON.stringify(error?.errmsg)}`)
      console.log(`  payload=${JSON.stringify(error?.payload)}`)
    }
  }
}
