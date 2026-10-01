#!/usr/bin/env node
/**
 * Interactive QR login for the WeChat iLink ClawBot channel.
 *
 *   node scripts/login.mjs [--data-dir <dir>]
 *
 * Prints the QR image URL, then polls `/get_qrcode_status` every 3s until the
 * phone confirms. On success the bot token is written to
 * `<dataDir>/account.json` (mode 0600) where the channel service picks it up.
 */
import { beginLogin, pollLogin } from '../src/ilink/login.js'
import { createAccountStore, resolveDataDir } from '../src/ilink/store.js'

const argv = process.argv.slice(2)
const dataDirFlag = argv.indexOf('--data-dir')
const dataDir = dataDirFlag >= 0 ? argv[dataDirFlag + 1] : resolveDataDir({})
const store = createAccountStore({ dataDir })

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const qr = await beginLogin({ timeoutMs: 30_000 })
process.stdout.write(
  [
    '',
    '  微信 ClawBot 扫码登录',
    '  ─────────────────────────────',
    `  二维码链接 : ${qr.qrUrl}`,
    `  qrcode     : ${qr.qrcode}`,
    `  有效期     : ${qr.expiresIn}s`,
    '',
    '  用手机微信打开上面的链接（或在浏览器打开后扫码），确认绑定。',
    '',
    '',
  ].join('\n'),
)

let last = ''
const deadline = qr.expiresAt
while (Date.now() < deadline) {
  let result
  try {
    result = await pollLogin({ qrcode: qr.qrcode, timeoutMs: 25_000 })
  } catch (error) {
    process.stdout.write(`  [warn] poll failed: ${String(error?.message ?? error)} — retrying\n`)
    await sleep(3_000)
    continue
  }
  if (result.status !== last) {
    process.stdout.write(`  status: ${result.status}\n`)
    last = result.status
  }
  if (result.status === 'success') {
    await store.save({
      accountId: result.botId || 'default',
      botToken: result.botToken,
      botId: result.botId,
      savedAt: new Date().toISOString(),
    })
    process.stdout.write(`\n  ✅ 登录成功，凭据已保存到 ${store.path}\n\n`)
    process.exit(0)
  }
  if (result.status === 'expired') {
    process.stdout.write('\n  ❌ 二维码已过期，请重新运行。\n\n')
    process.exit(1)
  }
  if (result.status === 'error') {
    process.stdout.write(`\n  ❌ 登录失败：${result.message ?? 'unknown'}\n\n`)
    process.exit(1)
  }
  await sleep(3_000)
}

process.stdout.write('\n  ❌ 超时未确认，请重新运行。\n\n')
process.exit(1)
