/**
 * Verifier-owned contract / checklist suite (independent of the A and B suites).
 *
 * Everything here re-derives a claim from `docs/INTERFACES.md` against the
 * files on disk instead of trusting the implementation notes:
 *   - package.json manifest targets exist and self-resolve;
 *   - both `cordis.patch.yml` rows resolve to a loadable plugin module;
 *   - the §2.0 "zero `@deepseek-ai/*` import" freeze holds for every src file;
 *   - the frozen barrels export every contracted symbol.
 *
 * Findings discovered while writing this file are recorded in
 * `docs/VERIFICATION.md`; the assertions below encode the *observed* state so
 * the suite stays a regression net rather than a wish list.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..', '..')

const readJson = async (file) => JSON.parse(await readFile(file, 'utf8'))

async function listJsFiles(dir) {
  const out = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...(await listJsFiles(full)))
    else if (entry.name.endsWith('.js')) out.push(full)
  }
  return out
}

const exists = async (file) => {
  try {
    await stat(file)
    return true
  } catch {
    return false
  }
}

test('manifest: main / exports / dsh.bundle.patch point at real files', async () => {
  const pkg = await readJson(path.join(root, 'package.json'))
  assert.equal(pkg.type, 'module', 'the plugin must stay pure ESM')

  const targets = [
    ['main', pkg.main],
    ['exports["."]', pkg.exports['.']?.default],
    ['exports["./bridge"]', pkg.exports['./bridge']?.default],
    ['exports["./package.json"]', pkg.exports['./package.json']],
    ['dsh.bundle.patch', pkg.dsh?.bundle?.patch],
  ]
  for (const [label, target] of targets) {
    assert.equal(typeof target, 'string', `${label} must be declared`)
    const resolved = path.resolve(root, target)
    assert.ok(await exists(resolved), `${label} -> ${target} does not exist on disk`)
  }
})

test('manifest: every path in `files` exists (a published tarball must not reference ghosts)', async () => {
  const pkg = await readJson(path.join(root, 'package.json'))
  const missing = []
  for (const entry of pkg.files ?? []) {
    if (!(await exists(path.join(root, entry)))) missing.push(entry)
  }
  assert.deepEqual(missing, [], `\`files\` references paths that do not exist: ${JSON.stringify(missing)}`)
  // FINDING V-6 (fixed during verification): README.md was listed but
  // absent. `files` is a publish-only allowlist, so the DSH `link:` install
  // never depended on it; `docs/` and `scripts/` are deliberately not shipped.
})

test('manifest: the package self-resolves through its own `exports` map', async () => {
  const main = await import('wechat-feishu-linker')
  assert.equal(main.name, 'wechat-ilink')
  assert.equal(typeof main.apply, 'function')
  assert.equal(typeof main.default, 'function', 'default export must be the plugin body')

  const bridge = await import('wechat-feishu-linker/bridge')
  assert.equal(bridge.name, 'wechat-ilink-bridge')
  assert.equal(typeof bridge.apply, 'function')
  assert.equal(typeof bridge.BridgeConfig, 'object')
})

test('manifest: the peer gate is satisfied by the zero-import architecture', async () => {
  const pkg = await readJson(path.join(root, 'package.json'))
  const peers = pkg.peerDependencies ?? {}
  // INTERFACES.md §4.4 asks for a peer range covering 0.2.0-rc.2, but the
  // frozen §2.0 architecture forbids importing @deepseek-ai/* at all — with no
  // import there is no peer gate to declare. The conditional below accepts
  // either reading; the literal §4.4 checklist item is reported as a
  // documentation inconsistency in docs/VERIFICATION.md (V-5).
  const dshPeers = Object.entries(peers).filter(([name]) => name.startsWith('@deepseek-ai/'))
  if (dshPeers.length > 0) {
    const source = JSON.stringify(dshPeers)
    assert.ok(
      /0\.2\.0-rc\.2|\^0\.2|>=0\.2/.test(source),
      `declared DSH peers must cover 0.2.0-rc.2: ${source}`,
    )
  } else {
    assert.deepEqual(dshPeers, [], 'no DSH peers declared')
  }
})

test('freeze §2.0: not one src file imports @deepseek-ai/* or an undeclared bare specifier', async () => {
  const files = await listJsFiles(path.join(root, 'src'))
  assert.ok(files.length >= 8, `expected the whole protocol + bridge layer, found ${files.length} files`)

  // The rule is about resolution hazards at a third-party realpath: the host
  // loads this plugin through a junction, so Node resolves from the realpath and
  // a bare specifier that is not installed *there* fails at load.
  //
  // `@larksuiteoapi/node-sdk` is the one deliberate exception, and it is not a
  // loophole: it is declared in package.json, it is installed on the realpath's
  // parent chain (see README §安装), and the allowlist is asserted against the
  // manifest below so it cannot drift into a second undeclared import.
  const ALLOWED_BARE = ['@larksuiteoapi/node-sdk']

  const violations = []
  for (const file of files) {
    const text = await readFile(file, 'utf8')
    // Any `from '<spec>'`, `import('<spec>')` or `require('<spec>')` whose
    // specifier is neither `node:*` nor relative is a resolution hazard.
    for (const match of text.matchAll(/(?:^|\s)(?:from|import|require)\s*\(?\s*['"]([^'"]+)['"]/gmu)) {
      const spec = match[1]
      if (spec.startsWith('node:') || spec.startsWith('./') || spec.startsWith('../')) continue
      if (ALLOWED_BARE.includes(spec)) continue
      violations.push(`${path.relative(root, file)} -> ${spec}`)
    }
  }
  assert.deepEqual(violations, [], `bare imports found:\n${violations.join('\n')}`)

  // Every allowed bare specifier must actually be a declared dependency, so an
  // import can never be added without the manifest and the install step to match.
  const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
  for (const spec of ALLOWED_BARE) {
    assert.ok(
      Object.hasOwn(manifest.dependencies ?? {}, spec),
      `${spec} is allowed to be imported but is not a declared dependency`,
    )
  }

  // And specifically: no @deepseek-ai import statement anywhere (comments may
  // mention the namespace; statements may not).
  const aiImports = []
  for (const file of files) {
    const text = await readFile(file, 'utf8')
    for (const match of text.matchAll(/(?:from|import|require)\s*\(?\s*['"]@deepseek-ai\//gu)) {
      aiImports.push(`${path.relative(root, file)}: ${match[0]}`)
    }
  }
  assert.deepEqual(aiImports, [])
})

test('cordis.patch.yml: every row resolves to a loadable plugin module', async () => {
  const yml = await readFile(path.join(root, 'cordis.patch.yml'), 'utf8')

  // Minimal structural read of the `- id: / name:` pairs (no YAML dependency is
  // available and none may be installed).
  const rows = []
  let current = null
  for (const line of yml.split(/\r?\n/u)) {
    const id = /^\s*-\s*id:\s*['"]?([^'"\s]+)['"]?\s*$/u.exec(line)
    if (id) {
      current = { id: id[1], name: undefined }
      rows.push(current)
      continue
    }
    const name = /^\s*name:\s*['"]([^'"]+)['"]\s*$/u.exec(line)
    if (name && current) current.name = name[1]
  }
  assert.deepEqual(
    rows.map((row) => row.id),
    ['wechat-ilink', 'feishu', 'wechat-ilink-bridge'],
    'the patch must insert exactly the documented rows',
  )
  assert.deepEqual(
    rows.map((row) => row.name),
    ['wechat-feishu-linker', 'wechat-feishu-linker/feishu', 'wechat-feishu-linker/bridge'],
  )

  // A row `name` is a module specifier the host resolves from the profile.
  // Self-reference proves it resolves to a real module in this checkout.
  for (const row of rows) {
    const mod = await import(row.name)
    assert.equal(typeof mod.apply, 'function', `${row.name} must export apply()`)
    assert.equal(typeof mod.name, 'string', `${row.name} must export a plugin name`)
  }
  assert.equal((await import('wechat-feishu-linker')).name, 'wechat-ilink')
  assert.equal((await import('wechat-feishu-linker/feishu')).name, 'feishu')
  assert.equal((await import('wechat-feishu-linker/bridge')).name, 'wechat-ilink-bridge')

  // The bridge row must find the service rows without Cordis service lookup,
  // and the two channels must be filed under distinct keys.
  const registry = await import('../../src/registry.js')
  assert.equal(typeof registry.setService, 'function')
  assert.equal(typeof registry.getService, 'function')
  assert.equal(typeof registry.clearService, 'function')
  assert.equal(registry.DEFAULT_CHANNEL, 'wechat-ilink')
})

test('barrels: src/index.js and src/ilink/index.js export the frozen surface', async () => {
  const barrel = await import('../../src/index.js')
  const required = [
    'DEFAULT_ILINK_BASE_URL',
    'ILINK_BOT_API_PREFIX',
    'CHANNEL_VERSION',
    'buildHeaders',
    'createIlinkClient',
    'beginLogin',
    'pollLogin',
    'normalizeQrStatus',
    'readRawMessages',
    'extractNextBuf',
    'normalizeInboundMessage',
    'buildSendBody',
    'normalizeOutboundText',
    'chunkText',
    'parseAesKey',
    'decryptCdnMedia',
    'guessMimeFromFilename',
    'createAccountStore',
    'resolveDataDir',
    'startPollLoop',
    'apply',
    'default',
    'setService',
    'getService',
    'clearService',
    'withDefaults',
    'DEFAULT_CONFIG',
    'IlinkApiError',
    'IlinkHttpError',
    'IlinkAuthError',
  ]
  const missing = required.filter((key) => !(key in barrel))
  assert.deepEqual(missing, [], `src/index.js is missing: ${missing.join(', ')}`)

  const ilinkBarrel = await import('../../src/ilink/index.js')
  const frozen = [
    'DEFAULT_ILINK_BASE_URL',
    'ILINK_BOT_API_PREFIX',
    'CHANNEL_VERSION',
    'buildHeaders',
    'createIlinkClient',
    'beginLogin',
    'pollLogin',
    'normalizeQrStatus',
    'readRawMessages',
    'extractNextBuf',
    'normalizeInboundMessage',
    'buildSendBody',
    'normalizeOutboundText',
    'chunkText',
    'parseAesKey',
    'decryptCdnMedia',
    'guessMimeFromFilename',
    'resolveDataDir',
    'createAccountStore',
    'startPollLoop',
  ]
  const missingIlink = frozen.filter((key) => !(key in ilinkBarrel))
  assert.deepEqual(missingIlink, [], `src/ilink/index.js is missing: ${missingIlink.join(', ')}`)
})

test('[FINDING V-4] config keys declared in DEFAULT_CONFIG but never read by src', async () => {
  const { DEFAULT_CONFIG } = await import('../../src/config.js')
  const files = await listJsFiles(path.join(root, 'src'))
  const text = (await Promise.all(files.map((file) => readFile(file, 'utf8')))).join('\n')

  const inert = Object.keys(DEFAULT_CONFIG).filter((key) => {
    // `config.<key>` / `config?.<key>` / `this.config.<key>` — any real read.
    const read = new RegExp(`(?:this\\.)?config\\??\\.${key}\\b`, 'u')
    return !read.test(text)
  })

  // Remaining inert keys on the fixed revision: media support is declared but
  // not implemented (`mediaEnabled` / `mediaMaxBytes` / `mediaCacheDir` /
  // `cdnBaseUrl` are placeholders) and multi-account `accounts` is not
  // supported. `autoConnect` and `pollTimeoutMs` USED to be inert too — V-4a /
  // V-4b were fixed in task-4, so they must now be read (asserted below).
  const known = ['accounts', 'cdnBaseUrl', 'mediaCacheDir', 'mediaEnabled', 'mediaMaxBytes']
  const sorted = [...inert].sort()
  assert.deepEqual(
    sorted.filter((key) => !known.includes(key)),
    [],
    `new inert config key(s) appeared: ${sorted.filter((k) => !known.includes(k)).join(', ')}`,
  )
  assert.deepEqual(sorted, known, 'the inert-key list changed — update docs/VERIFICATION.md')
  // REGRESSION V-4a / V-4b: these two must be read by src again.
  assert.ok(!sorted.includes('autoConnect'), 'autoConnect must be read (V-4a)')
  assert.ok(!sorted.includes('pollTimeoutMs'), 'pollTimeoutMs must be read (V-4b)')
})

test('[REGRESSION V-4a] autoConnect:false stops apply() from opening the long poll', async () => {
  const { apply } = await import('../../src/service.js')

  let pollStarted = false
  const ilink = {
    resolveDataDir: () => 'C:/tmp/never-used',
    createAccountStore: () => ({ load: async () => ({ botToken: 'tok' }), readBuf: async () => '', writeBuf: async () => {} }),
    startPollLoop: () => {
      pollStarted = true
      return { stop() {}, done: Promise.resolve() }
    },
    normalizeInboundMessage: () => null,
    readRawMessages: () => [],
    chunkText: (text) => [text],
    normalizeOutboundText: (text) => text,
    createIlinkClient: () => ({ sendMessage: async () => ({}) }),
  }

  const listeners = new Map()
  const ctx = {
    on: (event, handler) => {
      listeners.set(event, handler)
      return () => listeners.delete(event)
    },
    get: () => undefined,
    emit: () => {},
    logger: { info() {}, warn() {}, error() {} },
  }

  const dispose = apply(ctx, { autoConnect: false, toolEnabled: false }, { ilink, log: () => {} })
  // start() is fire-and-forget inside apply(); give it a microtask turn.
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(pollStarted, false, 'autoConnect:false must not open the long poll')

  // The switch, not the ability to connect, is what changed: the default still
  // opens the poll.
  const disposeDefault = apply(ctx, { toolEnabled: false }, { ilink, log: () => {} })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(pollStarted, true, 'the default must still open the long poll')

  disposeDefault()
  dispose()
})

test('repo hygiene: no stray `-test.mjs` script can be auto-discovered by `node --test`', async () => {
  // FINDING V-1: `scripts/live-test.mjs` matched the default test glob
  // `**/*-test.?(c|m)js`, so `npm test` executed a live network script and
  // reported a failure. This test is the regression net for that class.
  const scripts = await readdir(path.join(root, 'scripts'))
  const offenders = scripts.filter((name) => /(^test[-.]|[-._]test\.|^test\.)/u.test(name))
  assert.deepEqual(offenders, [], `scripts/ contains node --test-discoverable names: ${offenders.join(', ')}`)
})
