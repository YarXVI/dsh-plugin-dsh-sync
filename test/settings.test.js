import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { mkdtemp, mkdir, readFile, readdir, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Identity } from '../src/identity.js'
import { SyncEngine } from '../src/engine.js'
import { PeerClient } from '../src/transport.js'
import { sha256hex } from '../src/crypto.js'

const linkType = process.platform === 'win32' ? 'junction' : 'dir'

async function createHome(label) {
  const home = await mkdtemp(join(tmpdir(), `dsh-sync-set-${label}-`))
  for (const dir of ['sessions', 'storages', 'profiles/desktop', 'attachments', 'cache']) {
    await mkdir(join(home, dir), { recursive: true })
  }
  return home
}

async function createEngine(home, extra = {}) {
  const stateDir = join(home, 'dsh-sync')
  const identity = await new Identity({ stateDir }).load()
  const engine = new SyncEngine({
    home,
    profile: 'desktop',
    stateDir,
    identity,
    config: { discovery: false, autoCycle: false, stableAfterMs: 0, keepBackups: true, repairProfile: true, ...extra },
  })
  await engine.start()
  return engine
}

async function createPair(extraA = {}, extraB = {}) {
  const homeA = await createHome('a')
  const homeB = await createHome('b')
  const a = await createEngine(homeA, extraA)
  const b = await createEngine(homeB, extraB)
  a.discovery.addPeer({ deviceId: b.identity.deviceId, host: '127.0.0.1', port: b.port, name: 'PC-B' })
  b.discovery.addPeer({ deviceId: a.identity.deviceId, host: '127.0.0.1', port: a.port, name: 'PC-A' })
  const pairA = await a.pairStart(b.identity.deviceId)
  const pairB = await b.pairStart(a.identity.deviceId)
  assert.equal(pairA.sas, pairB.sas)
  await a.pairConfirm(b.identity.deviceId)
  await b.pairConfirm(a.identity.deviceId)
  return { a, b, homeA, homeB }
}

const profileOf = (home) => join(home, 'profiles', 'desktop')
const nodeModulesOf = (home) => join(profileOf(home), 'node_modules')

async function writeProfilePackage(home, value) {
  await writeFile(join(profileOf(home), 'package.json'), JSON.stringify(value, null, 2))
}

async function readProfilePackage(home) {
  return JSON.parse(await readFile(join(profileOf(home), 'package.json'), 'utf8'))
}

async function exists(path) {
  try { await fs.access(path); return true } catch { return false }
}

async function bumpAhead(path, offsetMs = 5000) {
  const when = new Date(Date.now() + offsetMs)
  await utimes(path, when, when)
}

const CORDIS_BASE = (model, exePath) => `# machine patch layer
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: opencode-go
    model: ${model}
- id: npu-runtime
  name: 'dsh-npu'
  config:
    exePath: '${exePath}'
`

const CREDENTIALS = (token, apiKey) => `version: 1
records:
  deepseek-account-platform/default:
    kind: oauth
    payload:
      token: ${token}
refs:
  OPENCODE_GO_API_KEY: ${apiKey}
  BUDDY_ACCOUNT_0225AAB5: buddy-${token}
`

// ---------------------------------------------------------------------------
// A. plugins junction dereference
// ---------------------------------------------------------------------------

test('profile: a first-level plugins junction is copied to the peer as real files', async () => {
  const { a, b, homeA, homeB } = await createPair()
  try {
    // A developer checkout outside the profile, linked in via a junction.
    const checkout = join(homeA, 'checkout', 'dsh-x')
    await mkdir(join(checkout, 'lib'), { recursive: true })
    await writeFile(join(checkout, 'package.json'), JSON.stringify({ name: 'dsh-x', version: '1.0.0', main: 'index.js' }))
    await writeFile(join(checkout, 'index.js'), 'export default "dsh-x"\n')
    await writeFile(join(checkout, 'lib', 'util.js'), 'export const n = 1\n')
    await mkdir(join(profileOf(homeA), 'plugins'), { recursive: true })
    await symlink(checkout, join(profileOf(homeA), 'plugins', 'dsh-x'), linkType)
    await writeProfilePackage(homeA, {
      name: 'p',
      dependencies: { 'dsh-x': 'link:./plugins/dsh-x' },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-x'] } },
    })
    await writeProfilePackage(homeB, { name: 'p' })

    await a.cycle('test')
    await b.cycle('test')

    const copied = join(profileOf(homeB), 'plugins', 'dsh-x')
    assert.equal(await readFile(join(copied, 'index.js'), 'utf8'), 'export default "dsh-x"\n')
    assert.equal(await readFile(join(copied, 'lib', 'util.js'), 'utf8'), 'export const n = 1\n')
    assert.equal((await fs.lstat(copied)).isSymbolicLink(), false, 'the peer must receive a real directory')

    // Self-healing restores the declaration, the bundle and the node_modules link.
    const pkg = await readProfilePackage(homeB)
    assert.equal(pkg.dependencies['dsh-x'], 'link:./plugins/dsh-x')
    assert.ok(pkg.dsh.profile.bundles.includes('dsh-x'))
    const link = join(nodeModulesOf(homeB), 'dsh-x')
    assert.equal((await fs.lstat(link)).isSymbolicLink(), true)
    const target = await fs.readlink(link)
    assert.ok(target.startsWith(profileOf(homeB)), 'the junction must point into B')

    // A is untouched.
    assert.equal((await fs.lstat(join(profileOf(homeA), 'plugins', 'dsh-x'))).isSymbolicLink(), true)
    assert.equal(await readFile(join(checkout, 'index.js'), 'utf8'), 'export default "dsh-x"\n')
  } finally {
    await a.stop()
    await b.stop()
  }
})

// ---------------------------------------------------------------------------
// C. cordis.patch.yml model blocks
// ---------------------------------------------------------------------------

test('profile: cordis.patch.yml merges model blocks and keeps machine blocks', async () => {
  const { a, b, homeA, homeB } = await createPair()
  try {
    await writeFile(join(profileOf(homeA), 'cordis.patch.yml'), CORDIS_BASE('deepseek-v4.1-flash', 'E:\\a-machine\\flm.exe'))
    await writeFile(join(profileOf(homeB), 'cordis.patch.yml'), CORDIS_BASE('old-model', 'E:\\b-machine\\flm.exe'))
    await bumpAhead(join(profileOf(homeA), 'cordis.patch.yml'))

    await a.cycle('test')
    await b.cycle('test')

    const merged = await readFile(join(profileOf(homeB), 'cordis.patch.yml'), 'utf8')
    assert.ok(merged.includes('model: deepseek-v4.1-flash'), 'the peer model block is adopted')
    assert.ok(!merged.includes('model: old-model'))
    assert.ok(merged.includes("exePath: 'E:\\b-machine\\flm.exe'"), "B's machine-only block must not change")
    assert.ok(!merged.includes('a-machine'))
    assert.strictEqual(merged[0], '#', 'no BOM')
    const backups = (await readdir(profileOf(homeB))).filter((name) => name.includes('.bak-model-'))
    assert.equal(backups.length, 1)

    // Second cycle is a no-op: same bytes, no extra backup.
    await b.cycle('test')
    assert.equal(await readFile(join(profileOf(homeB), 'cordis.patch.yml'), 'utf8'), merged)
    assert.equal((await readdir(profileOf(homeB))).filter((name) => name.includes('.bak-model-')).length, 1)
  } finally {
    await a.stop()
    await b.stop()
  }
})

test('profile: model blocks merge even when the local file is newer (runtime rewrite)', async () => {
  const { a, b, homeA, homeB } = await createPair()
  try {
    await writeFile(join(profileOf(homeA), 'cordis.patch.yml'), CORDIS_BASE('peer-model', 'E:\\a-machine\\flm.exe'))
    // B's runtime-rewritten copy only has its machine block: no model blocks yet.
    await writeFile(join(profileOf(homeB), 'cordis.patch.yml'), `# machine patch layer
- id: npu-runtime
  name: 'dsh-npu'
  config:
    exePath: 'E:\\b-machine\\flm.exe'
`)
    // DSH rewrites this file at runtime, so B's copy is usually the newer one.
    await bumpAhead(join(profileOf(homeB), 'cordis.patch.yml'))

    await a.cycle('test')
    await b.cycle('test')

    const merged = await readFile(join(profileOf(homeB), 'cordis.patch.yml'), 'utf8')
    assert.ok(merged.includes('model: peer-model'), 'a newer local mtime must not block the additive merge')
    assert.ok(merged.includes('name: "@deepseek-ai/dsh-agent-default-model"'))
    assert.ok(merged.includes("exePath: 'E:\\b-machine\\flm.exe'"), "B's machine block must stay")
    assert.ok(!merged.includes('a-machine'))
    const backups = (await readdir(profileOf(homeB))).filter((name) => name.includes('.bak-model-'))
    assert.equal(backups.length, 1)

    // Parked: a second cycle neither rewrites nor makes another backup.
    const before = await fs.stat(join(profileOf(homeB), 'cordis.patch.yml'))
    await b.cycle('test')
    const after = await fs.stat(join(profileOf(homeB), 'cordis.patch.yml'))
    assert.equal(after.mtimeMs, before.mtimeMs)
    assert.equal((await readdir(profileOf(homeB))).filter((name) => name.includes('.bak-model-')).length, 1)
  } finally {
    await a.stop()
    await b.stop()
  }
})

test('profile: a local-only model block edit is not rolled back on the next cycle', async () => {
  const { a, b, homeA, homeB } = await createPair()
  try {
    await writeFile(join(profileOf(homeA), 'cordis.patch.yml'), CORDIS_BASE('peer-model', 'E:\\a-machine\\flm.exe'))
    await writeFile(join(profileOf(homeB), 'cordis.patch.yml'), CORDIS_BASE('old-model', 'E:\\b-machine\\flm.exe'))
    await bumpAhead(join(profileOf(homeA), 'cordis.patch.yml'))
    await a.cycle('test')
    await b.cycle('test')
    // B makes a local choice after the merge; the peer has not changed.
    const localChoice = (await readFile(join(profileOf(homeB), 'cordis.patch.yml'), 'utf8')).replace('peer-model', 'b-choice')
    await writeFile(join(profileOf(homeB), 'cordis.patch.yml'), localChoice)
    await bumpAhead(join(profileOf(homeB), 'cordis.patch.yml'))
    await b.cycle('test')
    const after = await readFile(join(profileOf(homeB), 'cordis.patch.yml'), 'utf8')
    assert.ok(after.includes('model: b-choice'), 'the local edit must survive')
    assert.ok(!after.includes('model: peer-model'))
  } finally {
    await a.stop()
    await b.stop()
  }
})

// ---------------------------------------------------------------------------
// B. credentials
// ---------------------------------------------------------------------------

test('credentials: only *API_KEY refs merge, records and account tokens stay local', async () => {
  const { a, b, homeA, homeB } = await createPair()
  try {
    await writeFile(join(homeA, '.credentials.yaml'), CREDENTIALS('token-from-a', 'sk-a-key'))
    await writeFile(join(homeB, '.credentials.yaml'), CREDENTIALS('token-from-b', 'sk-b-key'))
    await bumpAhead(join(homeA, '.credentials.yaml'))

    await a.cycle('test')
    await b.cycle('test')

    const merged = await readFile(join(homeB, '.credentials.yaml'), 'utf8')
    assert.ok(merged.includes('token: token-from-b'), "B's device token must survive")
    assert.ok(!merged.includes('token-from-a'))
    assert.ok(merged.includes('BUDDY_ACCOUNT_0225AAB5: buddy-token-from-b'))
    assert.ok(!merged.includes('buddy-token-from-a'))
    // A different local value is never overwritten; a conflict is recorded.
    assert.ok(merged.includes('OPENCODE_GO_API_KEY: sk-b-key'))
    assert.ok(!merged.includes('sk-a-key'))
    assert.ok(b.conflicts.some((item) => item.kind === 'credential-conflict' && item.item === 'OPENCODE_GO_API_KEY'))
    // Conflict notes never contain the secret value.
    assert.ok(!b.conflicts.some((item) => String(item.note || '').includes('sk-')))
    assert.strictEqual(merged[0], 'v', 'no BOM')
  } finally {
    await a.stop()
    await b.stop()
  }
})

test('credentials: a missing API_KEY ref is added without touching records', async () => {
  const { a, b, homeA, homeB } = await createPair()
  try {
    await writeFile(join(homeA, '.credentials.yaml'), CREDENTIALS('token-from-a', 'sk-a-key'))
    await writeFile(join(homeB, '.credentials.yaml'), [
      'version: 1',
      'records:',
      '  deepseek-account-platform/default:',
      '    kind: oauth',
      '    payload:',
      '      token: b-token',
      'refs:',
      '  BUDDY_ACCOUNT_0225AAB5: buddy-b',
      '',
    ].join('\n'))
    await bumpAhead(join(homeA, '.credentials.yaml'))

    await a.cycle('test')
    await b.cycle('test')

    const merged = await readFile(join(homeB, '.credentials.yaml'), 'utf8')
    assert.ok(merged.includes('OPENCODE_GO_API_KEY: sk-a-key'))
    assert.ok(merged.includes('token: b-token'))
    assert.ok(!merged.includes('token-from-a'))
    assert.ok(merged.includes('buddy-b'))
    const backups = (await readdir(homeB)).filter((name) => name.startsWith('.credentials.yaml.bak-sync-'))
    assert.equal(backups.length, 1)

    // Idempotent: no second write/backup.
    await b.cycle('test')
    assert.equal((await readdir(homeB)).filter((name) => name.startsWith('.credentials.yaml.bak-sync-')).length, 1)
  } finally {
    await a.stop()
    await b.stop()
  }
})

test('credentials: keys merge even when the local file is newer (runtime rewrite)', async () => {
  const { a, b, homeA, homeB } = await createPair()
  try {
    await writeFile(join(homeA, '.credentials.yaml'), CREDENTIALS('token-from-a', 'sk-a-key'))
    await writeFile(join(homeB, '.credentials.yaml'), [
      'version: 1',
      'records:',
      '  deepseek-account-platform/default:',
      '    kind: oauth',
      '    payload:',
      '      token: b-token',
      'refs:',
      '  BUDDY_ACCOUNT_0225AAB5: buddy-b',
      '',
    ].join('\n'))
    // DSH rewrites this file at runtime, so B's copy is usually the newer one.
    await bumpAhead(join(homeB, '.credentials.yaml'))

    await a.cycle('test')
    await b.cycle('test')

    const merged = await readFile(join(homeB, '.credentials.yaml'), 'utf8')
    assert.ok(merged.includes('OPENCODE_GO_API_KEY: sk-a-key'), 'a newer local mtime must not block the merge')
    assert.ok(merged.includes('token: b-token'))
    assert.ok(merged.includes('buddy-b'))
    assert.equal((await readdir(homeB)).filter((name) => name.startsWith('.credentials.yaml.bak-sync-')).length, 1)

    // Parked: a second cycle neither rewrites nor makes another backup.
    const before = await fs.stat(join(homeB, '.credentials.yaml'))
    await b.cycle('test')
    const after = await fs.stat(join(homeB, '.credentials.yaml'))
    assert.equal(after.mtimeMs, before.mtimeMs)
    assert.equal((await readdir(homeB)).filter((name) => name.startsWith('.credentials.yaml.bak-sync-')).length, 1)
  } finally {
    await a.stop()
    await b.stop()
  }
})

// ---------------------------------------------------------------------------
// D. self-healing picks up plugin directories
// ---------------------------------------------------------------------------

test('repair: a plugin directory without a declaration gets dep + bundle + junction', async () => {
  const home = await createHome('plugin-dir')
  const dir = join(profileOf(home), 'plugins', 'dsh-demo')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'dsh-demo', version: '1.0.0', main: 'index.js' }))
  await writeFile(join(dir, 'index.js'), 'export default 1\n')
  await writeProfilePackage(home, { name: 'p', dependencies: {}, dsh: { profile: { bundles: [] } } })
  const engine = await createEngine(home)
  try {
    const result = await engine.repairLocalProfile()
    assert.equal(result.depsAdded, 1)
    const pkg = await readProfilePackage(home)
    assert.equal(pkg.dependencies['dsh-demo'], 'link:./plugins/dsh-demo')
    assert.ok(pkg.dsh.profile.bundles.includes('dsh-demo'))
    const link = join(nodeModulesOf(home), 'dsh-demo')
    assert.equal((await fs.lstat(link)).isSymbolicLink(), true)
    // Idempotent.
    const second = await engine.repairLocalProfile()
    assert.equal(second.changed, false)
  } finally {
    await engine.stop()
  }
})

test('repair: a plugin directory that does not exist is never declared', async () => {
  const home = await createHome('plugin-none')
  await writeProfilePackage(home, { name: 'p', dependencies: {}, dsh: { profile: { bundles: [] } } })
  const engine = await createEngine(home)
  try {
    const result = await engine.repairLocalProfile()
    assert.equal(result.depsAdded, 0)
    const pkg = await readProfilePackage(home)
    assert.deepEqual(pkg.dependencies, {})
  } finally {
    await engine.stop()
  }
})

// ---------------------------------------------------------------------------
// Security: a broad set root must not expose arbitrary files over RPC
// ---------------------------------------------------------------------------

test('security: credentials-set RPC cannot address arbitrary DSH_HOME files', async () => {
  const { a, b, homeA, homeB } = await createPair()
  try {
    const deviceFile = join(homeA, 'dsh-sync', 'device.json')
    const deviceBefore = await readFile(deviceFile, 'utf8')
    assert.ok(JSON.parse(deviceBefore).privateKey, 'fixture sanity: device.json holds the private key')

    const client = new PeerClient({
      identity: b.identity,
      peer: { deviceId: a.identity.deviceId, host: '127.0.0.1', port: a.port },
    })
    await client.hello()

    await assert.rejects(() => client.rpc('pull', { set: 'credentials', rel: 'dsh-sync/device.json' }), /invalid path/)
    await assert.rejects(() => client.rpc('pull', { set: 'credentials', rel: 'profiles/desktop/package.json' }), /invalid path/)
    await assert.rejects(() => client.rpc('pull', { set: 'credentials', rel: '../.credentials.yaml' }), /invalid path/)

    const payload = Buffer.from('{"hijacked":true}')
    const badHash = sha256hex(payload)
    for (const rel of ['dsh-sync/device.json', 'profiles/desktop/package.json']) {
      await assert.rejects(
        () => client.rpc('push', { set: 'credentials', rel, data: payload.toString('base64'), m: Date.now(), h: badHash }),
        /invalid path/,
      )
    }
    assert.equal(await readFile(deviceFile, 'utf8'), deviceBefore, 'device.json must not change')
    assert.equal(JSON.parse(await readFile(deviceFile, 'utf8')).privateKey, JSON.parse(deviceBefore).privateKey)

    // The legitimate credentials file is still served.
    await writeFile(join(homeA, '.credentials.yaml'), CREDENTIALS('token-a', 'sk-a-key'))
    const pulled = await client.rpc('pull', { set: 'credentials', rel: '.credentials.yaml' })
    assert.ok(Buffer.from(pulled.data, 'base64').toString('utf8').includes('OPENCODE_GO_API_KEY: sk-a-key'))

    // Existing sets keep working: the profile manifest is readable as before.
    await writeFile(join(profileOf(homeA), 'package.json'), JSON.stringify({ name: 'p' }, null, 2))
    const pkg = await client.rpc('pull', { set: 'profile', rel: 'package.json' })
    assert.ok(Buffer.from(pkg.data, 'base64').toString('utf8').includes('"name"'))
    // ...and out-of-scope paths are still refused for them too.
    await assert.rejects(() => client.rpc('pull', { set: 'profile', rel: 'package.json.bak-sync-x' }), /invalid path/)
  } finally {
    await a.stop()
    await b.stop()
  }
})

test('sets: a v2 file migrates to v3 and enables credentials', async () => {
  const home = await createHome('migrate-v2')
  await mkdir(join(home, 'dsh-sync'), { recursive: true })
  await writeFile(join(home, 'dsh-sync', 'sets.json'), JSON.stringify({
    version: 2,
    enabled: ['storages', 'profile', 'modules', 'attachments', 'cache'],
  }))
  const engine = await createEngine(home)
  try {
    assert.equal(engine.sets.find((set) => set.id === 'credentials').enabled, true)
    assert.equal(engine.sets.find((set) => set.id === 'modules').enabled, true, 'v2 choices are preserved')
    const saved = JSON.parse(await readFile(join(home, 'dsh-sync', 'sets.json'), 'utf8'))
    assert.equal(saved.version, 3)
    assert.ok(saved.enabled.includes('credentials'))
    assert.ok(saved.enabled.includes('modules'))
    assert.ok(!saved.enabled.includes('sessions'))
  } finally {
    await engine.stop()
  }
})
