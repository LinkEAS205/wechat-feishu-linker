#!/usr/bin/env node
/**
 * Live protocol probe for the WeChat iLink ClawBot API.
 *
 * Exercises *our own* protocol layer (src/ilink) against the real Tencent
 * endpoint and prints what it saw. This is the end-to-end proof that the port
 * from ZCode's `weixinProvider.ts` still matches the live service.
 *
 *   node scripts/probe-ilink.mjs            # QR begin + one status poll
 *   node scripts/probe-ilink.mjs --json     # machine-readable output
 *
 * Network note: this machine has no direct egress; export HTTPS_PROXY first
 * (Clash Mi mixed port is http://127.0.0.1:7890). Node's fetch honours
 * HTTP_PROXY/HTTPS_PROXY only when started with --use-env-proxy, so this script
 * installs a tiny CONNECT-free fallback: it uses the global fetch as-is and
 * reports the failure verbatim when the proxy is missing.
 */
import { beginLogin, pollLogin } from '../src/ilink/login.js'

const asJson = process.argv.includes('--json')

function out(line) {
  if (!asJson) process.stdout.write(`${line}\n`)
}

const started = Date.now()
const report = { ok: false, base: 'https://ilinkai.weixin.qq.com', steps: [] }

try {
  const qr = await beginLogin({ timeoutMs: 30_000 })
  report.steps.push({
    step: 'get_bot_qrcode',
    ok: true,
    qrcode: qr.qrcode,
    qrUrl: qr.qrUrl,
    expiresIn: qr.expiresIn,
  })
  out(`[ok] get_bot_qrcode → qrcode=${qr.qrcode}`)
  out(`     qr content: ${qr.qrUrl}`)
  out('     (this is a liteapp.weixin.qq.com page URL, NOT an image — encode it')
  out('      into a QR yourself; the plugin UI renders it as SVG at /api/qr.svg)')
  out(`     expires in ${qr.expiresIn}s`)

  const polled = await pollLogin({ qrcode: qr.qrcode, timeoutMs: 20_000 })
  report.steps.push({ step: 'get_qrcode_status', ok: true, status: polled.status })
  out(`[ok] get_qrcode_status → status=${polled.status} (pending is expected: nobody scanned)`)

  report.ok = true
  report.elapsedMs = Date.now() - started
} catch (error) {
  report.error = String(error?.message ?? error)
  report.elapsedMs = Date.now() - started
  out(`[fail] ${report.error}`)
  out('       If this is a network error, set HTTPS_PROXY=http://127.0.0.1:7890 and retry.')
  if (!asJson) process.exitCode = 1
}

if (asJson) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
