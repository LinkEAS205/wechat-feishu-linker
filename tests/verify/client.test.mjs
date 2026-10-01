/**
 * Verifier-owned client-module contract checks (round 2).
 *
 * `tests/web.test.mjs` executes `client.js` against a stub loader. This file
 * instead pins the *host* rules that a stub cannot prove, by reading the file as
 * text and by cross-checking `package.json`:
 *
 *  - the loader keys factories by package id: `dsh-client-modules/lib/client.js:739`
 *    throws `bundle … loaded without registering "<id>" via __ModuleLoader__.load`
 *    when `id` does not match the graph row, and `stripClientSuffix` (:98) only
 *    tolerates a trailing `/client` — so `id` must be the bare package name;
 *  - `settings.section` is a `kind: "list"` slot declared by
 *    `dsh-client-ui-settings-general/lib/client.js:1136`, so a registration needs
 *    `name` + `id` (`dsh-client-ui-slots/lib/index.js:182`) and a label that is a
 *    string or thunk (`:27`);
 *  - the file must stay import-free except `react` and must not touch the DOM
 *    outside its own component tree.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..', '..')
const clientPath = path.join(root, 'client.js')

const source = await readFile(clientPath, 'utf8')
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))

/** @param {string} line @returns {boolean} whether the line is a comment. */
const isCommentLine = (line) => /^\s*(\/\/|\/\*|\*)/u.test(line)

test('client.js: parses as a script (`node --check`)', () => {
  execFileSync(process.execPath, ['--check', clientPath], { stdio: 'pipe' })
})

test('client.js: registers under the exact package name the loader keys on', () => {
  const match = /__ModuleLoader__\.load\(\s*\{[\s\S]*?id:\s*'([^']+)'/u.exec(source)
  assert.ok(match, 'no __ModuleLoader__.load({ id }) call found')
  assert.equal(match[1], pkg.name, 'the loader keys factories by the bare package id')
  assert.equal(match[1].includes('/'), false, 'a subpath id would never match the graph row')
  assert.equal(match[1], 'wechat-feishu-linker')
})

test('client.js: requires only react and imports nothing from @deepseek-ai', () => {
  const requires = [...source.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/gu)].map((match) => match[1])
  assert.deepEqual([...new Set(requires)], ['react'], `unexpected requires: ${requires.join(', ')}`)

  const statements = source
    .split(/\r?\n/u)
    .filter((line) => !isCommentLine(line))
    .join('\n')
  assert.equal(/@deepseek-ai\//u.test(statements), false, 'a non-comment @deepseek-ai reference exists')
  assert.equal(/(^|\s)(import|export)\s/u.test(statements), false, 'the client half must be a plain script, not an ES module')
})

test('client.js: styles live in the component tree and use only --dsw-alias-* tokens', () => {
  const tokens = [...source.matchAll(/var\((--[a-z0-9-]+)/gu)].map((match) => match[1])
  assert.ok(tokens.length > 10, 'expected a themed stylesheet')
  const foreign = [...new Set(tokens)].filter((token) => !token.startsWith('--dsw-alias-'))
  assert.deepEqual(foreign, [], `non-theme tokens: ${foreign.join(', ')}`)

  const domLines = source
    .split(/\r?\n/u)
    .filter((line) => !isCommentLine(line))
    .filter((line) => /document\.(head|body)|appendChild|insertAdjacentHTML|innerHTML|dangerouslySetInnerHTML/u.test(line))
  assert.deepEqual(domLines, [], 'DOM mutation outside the component tree')
  assert.match(source, /h\('style', \{ key: 'wil-style' \}, CSS\)/u, 'the stylesheet must be rendered as a subtree node')
})

test('client.js: the settings.section registration matches the host list-slot contract', () => {
  assert.match(source, /SLOT = 'settings\.section'/u)
  assert.match(source, /ctx\.slots\.inject\(\s*SLOT/u, 'registrations must be gated on the declaration')
  const registration = /ctx\.slots\.register\(\s*\{([\s\S]*?)\}\s*,\s*WechatIlinkSection/u.exec(source)
  assert.ok(registration, 'no slots.register({...}, Component) call found')
  const block = registration[1]
  assert.match(block, /name:\s*SLOT/u, 'list slots key on options.name')
  // The id is a module constant here; resolve it rather than assuming a literal.
  const idRef = /id:\s*(?:'([^']*)'|([A-Z_][A-Z0-9_]*))/u.exec(block)
  assert.ok(idRef, 'a list slot requires options.id')
  const id = idRef[1] ?? new RegExp(`const ${idRef[2]} = '([^']*)'`, 'u').exec(source)?.[1]
  assert.ok(typeof id === 'string' && id.length > 0, `the slot id must resolve to a non-empty string (got ${JSON.stringify(id)})`)
  assert.equal(id, 'wechat-ilink', 'the settings nav id')
  const order = /order:\s*(\d+)/u.exec(block)
  assert.ok(order, 'order must be a number for the settings ledger sort')
  assert.match(block, /label:\s*(?:'[^']*'|SECTION_LABEL)/u, 'the label must be a string or thunk')

  // The component is exported by name for the renderer.
  assert.match(source, /return \{ inject: \['slots'\], apply \}/u)
})

test('client.js: the factory is lazy and side-effect free', () => {
  const factory = /factory:\s*\(require\)\s*=>\s*\{([\s\S]*)\}\s*,?\s*\}\)\s*;?\s*$/u.exec(source)
  assert.ok(factory, 'the module must export a factory')
  // Everything before the first function declaration must be constants only —
  // no fetch, no DOM, no registration at factory-evaluation time.
  const head = factory[1].split(/async function request|function WechatIlinkSection/u)[0]
  assert.equal(/\bfetch\(/u.test(head), false, 'the factory must not fetch at evaluation time')
  assert.equal(/ctx\.slots\./u.test(head), false, 'the factory must not register anything at evaluation time')
})

test('manifest: the dsh.client declaration is what the host needs to serve client.js', () => {
  // dsh-client-modules/lib/index.js:713-719 — a row is only served when the
  // manifest declares `dsh.client.platform === "web"` AND `exports["./client"]`
  // resolves to a string (or `{default: string}`), else the host throws
  // `declares dsh.client but exports no "./client" bundle`.
  assert.equal(pkg.dsh?.client?.platform, 'web')
  assert.ok(Array.isArray(pkg.dsh.client.inject), 'inject must be a string array')

  const clientExport = pkg.exports['./client']
  const resolved = typeof clientExport === 'string' ? clientExport : clientExport?.default
  assert.equal(typeof resolved, 'string', 'exports["./client"] must be a string or { default: string }')
  assert.equal(resolved, './client.js')
  assert.ok(existsSync(path.join(root, resolved)), `${resolved} must exist`)

  // The `slots` service is provided by @deepseek-ai/dsh-client-ui-renderer
  // (lib/client.js:1323 `super(ctx, "slots")`), which the web shell always
  // loads; the plugin descriptor's own inject gate is `['slots']`.
  assert.match(source, /return \{ inject: \['slots'\], apply \}/u)

  // FIXED (was FINDING V2-4): `@deepseek-ai/dsh-client-ui-slots` declares no
  // `dsh.client` and no `./client` export — it is the React-free core, not a
  // client module — so the loader ignored it (an inject name that is not a
  // graph row is inert: dsh-client-modules/lib/client.js:656-658). The real
  // `slots` provider is `@deepseek-ai/dsh-client-ui-renderer`
  // (lib/client.js:1323 `super(ctx, "slots")`), which declares
  // `dsh.client.platform === "web"` and a real `./client` export, so it IS a
  // client graph row the loader will activate.
  assert.ok(
    pkg.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-renderer'),
    'the real `slots` provider must be injected',
  )
  assert.ok(
    !pkg.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-slots'),
    'the inert entry must stay removed',
  )
})
