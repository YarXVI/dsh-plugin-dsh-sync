import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { mkdtemp, mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Identity } from '../src/identity.js'
import { SyncEngine } from '../src/engine.js'

const linkType = process.platform === 'win32' ? 'junction' : 'dir'

async function createHome(label) {
  const home = await mkdtemp(join(tmpdir(), `dsh-sync-mod-${label}-`))
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
    config: { discovery: false, autoCycle: false, stableAfterMs: 0, keepBackups: false, repairProfile: true, ...extra },
  })
  await engine.start()
  return engine
}

async function pairEngines(a, b) {
  a.discovery.addPeer({ deviceId: b.identity.deviceId, host: '127.0.0.1', port: b.port, name: 'PC-B' })
  b.discovery.addPeer({ deviceId: a.identity.deviceId, host: '127.0.0.1', port: a.port, name: 'PC-A' })
  const pairA = await a.pairStart(b.identity.deviceId)
  const pairB = await b.pairStart(a.identity.deviceId)
  assert.equal(pairA.sas, pairB.sas)
  await a.pairConfirm(b.identity.deviceId)
  await b.pairConfirm(a.identity.deviceId)
}

async function createPair(extraA = {}, extraB = {}) {
  const homeA = await createHome('a')
  const homeB = await createHome('b')
  const a = await createEngine(homeA, extraA)
  const b = await createEngine(homeB, extraB)
  await pairEngines(a, b)
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

async function writePluginSource(home, name, manifest = {}) {
  const dir = join(profileOf(home), 'plugins', name)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0', main: 'index.js', ...manifest }, null, 2))
  await writeFile(join(dir, 'index.js'), 'export default 1\n')
}

async function listLinks(dir) {
  const out = []
  for (const name of await readdir(dir).catch(() => [])) {
    const st = await fs.lstat(join(dir, name))
    if (st.isSymbolicLink()) out.push(name)
  }
  return out
}

async function exists(path) {
  try { await fs.access(path); return true } catch { return false }
}

// ---------------------------------------------------------------------------
// repairLocalProfile
// ---------------------------------------------------------------------------

test('repair: creates missing junctions for link: dependencies and is idempotent', async () => {
  const home = await createHome('repair-link')
  await writePluginSource(home, 'demo')
  await writeProfilePackage(home, {
    name: 'p',
    dependencies: { demo: 'link:./plugins/demo' },
    dsh: { profile: { bundles: ['demo'] } },
  })
  const engine = await createEngine(home)
  try {
    const first = await engine.repairLocalProfile()
    assert.equal(first.changed, true)
    assert.equal(first.linksCreated, 1)
    const dest = join(nodeModulesOf(home), 'demo')
    const st = await fs.lstat(dest)
    assert.equal(st.isSymbolicLink(), true)
    const target = await fs.readlink(dest)
    assert.ok(target && target.startsWith(profileOf(home)), 'the junction must point inside this profile')
    assert.equal(await exists(join(dest, 'package.json')), true)

    const second = await engine.repairLocalProfile()
    assert.equal(second.changed, false, 'repair must be idempotent')
    const backups = (await readdir(profileOf(home))).filter((name) => name.includes('.bak-prune-'))
    assert.equal(backups.length, 1)
  } finally {
    await engine.stop()
  }
})

test('repair: adds a bundle for a linked plugin that is missing from the manifest', async () => {
  const home = await createHome('repair-add')
  await writePluginSource(home, 'demo')
  await writeProfilePackage(home, {
    name: 'p',
    dependencies: { demo: 'link:./plugins/demo' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
  })
  const engine = await createEngine(home)
  try {
    const result = await engine.repairLocalProfile()
    assert.equal(result.bundlesAdded, 1)
    const value = await readProfilePackage(home)
    assert.deepEqual(value.dsh.profile.bundles, ['@deepseek-ai/dsh-base', 'demo'])
  } finally {
    await engine.stop()
  }
})

test('repair: prunes stale links/declarations but keeps @deepseek-ai and resolvable bundles', async () => {
  const home = await createHome('repair-prune')
  await writePluginSource(home, 'demo')
  await writePluginSource(home, 'live')
  await writeProfilePackage(home, {
    name: 'p',
    dependencies: { demo: 'link:./plugins/demo', gone: 'link:./plugins/gone', live: 'link:./plugins/live' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'demo', 'gone', 'live', 'dsh-npu'] } },
  })
  // A stale link pointing at a directory that no longer exists.
  await mkdir(nodeModulesOf(home), { recursive: true })
  await symlink(join(profileOf(home), 'plugins', 'gone'), join(nodeModulesOf(home), 'gone'), linkType).catch(() => {})

  const engine = await createEngine(home)
  try {
    const result = await engine.repairLocalProfile()
    assert.equal(result.changed, true)
    assert.equal(result.depsPruned, 1, 'the missing link dependency is removed')
    assert.ok(result.bundlesPruned >= 2, 'gone and dsh-npu cannot be loaded here')
    assert.equal(await exists(join(nodeModulesOf(home), 'gone')), false, 'the stale link itself is removed')

    const value = await readProfilePackage(home)
    assert.equal(value.dependencies.gone, undefined)
    assert.equal(value.dependencies.demo, 'link:./plugins/demo')
    assert.deepEqual(value.dsh.profile.bundles, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'demo', 'live'])
    assert.ok(engine.conflicts.some((item) => item.kind === 'link-pruned'))
    assert.ok(engine.conflicts.some((item) => item.kind === 'bundle-pruned' && item.item === 'dsh-npu'))

    const bytes = await readFile(join(profileOf(home), 'package.json'))
    assert.notDeepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'the rewritten manifest must be BOM-free')
    JSON.parse(bytes.toString('utf8'))
    const backups = (await readdir(profileOf(home))).filter((name) => name.startsWith('package.json.bak-prune-'))
    assert.equal(backups.length, 1)
  } finally {
    await engine.stop()
  }
})

test('repair: invalid package.json is never touched, and peer-absolute link targets are ignored', async () => {
  const home = await createHome('repair-invalid')
  const broken = '{"name":"p","dependencies":{'
  await writeFile(join(profileOf(home), 'package.json'), broken)
  const engine = await createEngine(home)
  try {
    const result = await engine.repairLocalProfile()
    assert.equal(result.changed, false)
    assert.equal(await readFile(join(profileOf(home), 'package.json'), 'utf8'), broken)
  } finally {
    await engine.stop()
  }

  const home2 = await createHome('repair-outside')
  await mkdir(join(home2, 'elsewhere'), { recursive: true })
  await writeProfilePackage(home2, {
    name: 'p',
    dependencies: { external: `link:${join(home2, 'elsewhere')}` },
    dsh: { profile: { bundles: [] } },
  })
  const engine2 = await createEngine(home2)
  try {
    await engine2.repairLocalProfile()
    assert.equal(await exists(join(nodeModulesOf(home2), 'external')), false, 'a target outside the profile must not be linked')
  } finally {
    await engine2.stop()
  }
})

test('repair: runs automatically at the end of a cycle', async () => {
  const home = await createHome('repair-cycle')
  await writePluginSource(home, 'demo')
  await writeProfilePackage(home, {
    name: 'p',
    dependencies: { demo: 'link:./plugins/demo' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
  })
  const engine = await createEngine(home)
  try {
    await engine.cycle('test')
    assert.equal(await exists(join(nodeModulesOf(home), 'demo', 'package.json')), true)
    const value = await readProfilePackage(home)
    assert.ok(value.dsh.profile.bundles.includes('demo'))
  } finally {
    await engine.stop()
  }
})

// ---------------------------------------------------------------------------
// modules set: sync, deletion and backup policy
// ---------------------------------------------------------------------------

test('modules: a real node_modules package syncs to the peer without .bak files', async () => {
  const { a, b, homeA, homeB } = await createPair({ keepBackups: true }, { keepBackups: true })
  try {
    await mkdir(join(nodeModulesOf(homeA), 'dsh-lib'), { recursive: true })
    await writeFile(join(nodeModulesOf(homeA), 'dsh-lib', 'package.json'), JSON.stringify({ name: 'dsh-lib', main: 'index.js' }))
    await writeFile(join(nodeModulesOf(homeA), 'dsh-lib', 'index.js'), 'module.exports = 42\n')
    // A junction inside node_modules must stay machine-local.
    await writePluginSource(homeA, 'demo')
    await mkdir(nodeModulesOf(homeA), { recursive: true })
    await symlink(join(profileOf(homeA), 'plugins', 'demo'), join(nodeModulesOf(homeA), 'demo'), linkType)

    await a.cycle('test')
    await b.cycle('test')

    assert.equal(await readFile(join(nodeModulesOf(homeB), 'dsh-lib', 'index.js'), 'utf8'), 'module.exports = 42\n')
    assert.equal(await exists(join(nodeModulesOf(homeB), 'demo')), false, 'junctions are never synced as content')
    const all = await readdir(nodeModulesOf(homeB), { recursive: true })
    assert.ok(!all.some((name) => String(name).includes('.bak-sync-')), 'modules must not create backups')
    assert.ok(!all.some((name) => String(name).includes('.sync-tmp-')), 'no temp files must be left behind')

    const modulesSet = a.sets.find((set) => set.id === 'modules')
    assert.equal(a.deletesEnabled(modulesSet), false, 'module deletions are never propagated')
  } finally {
    await a.stop()
    await b.stop()
  }
})

test('modules: package resources ending in .bin sync while .bin shim dirs do not', async () => {
  const { a, b, homeA, homeB } = await createPair()
  try {
    const assets = join(nodeModulesOf(homeA), '@liustack', 'modsearch', 'dist', 'assets')
    await mkdir(assets, { recursive: true })
    await writeFile(join(assets, 'tool.bin'), 'resource payload\n')
    await mkdir(join(nodeModulesOf(homeA), 'foo', '.bin'), { recursive: true })
    await writeFile(join(nodeModulesOf(homeA), 'foo', '.bin', 'shim.js'), '#!/usr/bin/env node\n')
    await mkdir(join(nodeModulesOf(homeA), '.bin'), { recursive: true })
    await writeFile(join(nodeModulesOf(homeA), '.bin', 'top-shim'), '#!/usr/bin/env node\n')

    await a.cycle('test')
    await b.cycle('test')

    assert.equal(await readFile(join(nodeModulesOf(homeB), '@liustack', 'modsearch', 'dist', 'assets', 'tool.bin'), 'utf8'), 'resource payload\n')
    assert.equal(await exists(join(nodeModulesOf(homeB), 'foo', '.bin', 'shim.js')), false)
    assert.equal(await exists(join(nodeModulesOf(homeB), '.bin', 'top-shim')), false)
  } finally {
    await a.stop()
    await b.stop()
  }
})

// ---------------------------------------------------------------------------
// End-to-end: empty node_modules is healed by one sync round
// ---------------------------------------------------------------------------
test('modules: one round heals an empty profile (packages + junctions + stale declarations)', async () => {
  const { a, b, homeA, homeB } = await createPair()
  try {
    // A: plugin source + a hoisted registry package + a stale declaration.
    await writePluginSource(homeA, 'demo')
    await mkdir(join(nodeModulesOf(homeA), 'dsh-lib'), { recursive: true })
    await writeFile(join(nodeModulesOf(homeA), 'dsh-lib', 'package.json'), JSON.stringify({ name: 'dsh-lib', main: 'index.js' }))
    await writeFile(join(nodeModulesOf(homeA), 'dsh-lib', 'index.js'), 'module.exports = 1\n')
    await writeProfilePackage(homeA, {
      name: 'p',
      dependencies: { demo: 'link:./plugins/demo', 'dsh-lib': '1.0.0', ghost: 'link:./plugins/ghost' },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'demo', 'dsh-lib', 'ghost'] } },
    })

    // B: same declarations, empty node_modules, no plugin sources.
    await writeProfilePackage(homeB, {
      name: 'p',
      dependencies: { demo: 'link:./plugins/demo', 'dsh-lib': '1.0.0', ghost: 'link:./plugins/ghost' },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'demo', 'dsh-lib', 'ghost'] } },
    })
    await mkdir(nodeModulesOf(homeB), { recursive: true })

    await a.cycle('test')
    await b.cycle('test')

    // 1) dependency files arrived
    assert.equal(await readFile(join(nodeModulesOf(homeB), 'dsh-lib', 'index.js'), 'utf8'), 'module.exports = 1\n')
    // 2) junction created on B, pointing at B's own plugins directory
    const demoLink = join(nodeModulesOf(homeB), 'demo')
    assert.equal((await fs.lstat(demoLink)).isSymbolicLink(), true)
    const demoTarget = await fs.readlink(demoLink)
    assert.ok(demoTarget.startsWith(profileOf(homeB)), `junction must point at B (${demoTarget})`)
    assert.ok(!demoTarget.toLowerCase().includes(homeA.toLowerCase()), 'never point at the peer path')
    assert.equal(await exists(join(demoLink, 'package.json')), true)
    // 3) stale declarations were pruned
    const value = await readProfilePackage(homeB)
    assert.equal(value.dependencies.ghost, undefined)
    assert.ok(!value.dsh.profile.bundles.includes('ghost'))
    assert.ok(value.dsh.profile.bundles.includes('demo'))
    assert.ok(value.dsh.profile.bundles.includes('dsh-lib'))
    assert.ok(value.dsh.profile.bundles.includes('@deepseek-ai/dsh-base'))
    // 4) the equivalent DSH resolution check passes for every declared bundle
    for (const name of value.dsh.profile.bundles) {
      const inModules = await exists(join(nodeModulesOf(homeB), ...name.split('/'), 'package.json'))
      const inPlugins = await exists(join(profileOf(homeB), 'plugins', ...name.split('/'), 'package.json'))
      const builtin = name.startsWith('@deepseek-ai/')
      assert.ok(inModules || inPlugins || builtin, `bundle ${name} must be resolvable`)
    }
    // 5) A was not damaged by B's pull
    const onA = await readProfilePackage(homeA)
    assert.equal(onA.dependencies.demo, 'link:./plugins/demo')
    assert.equal(await exists(join(nodeModulesOf(homeA), 'demo', 'package.json')), true)
    assert.equal(await exists(join(profileOf(homeA), 'plugins', 'demo', 'package.json')), true)
  } finally {
    await a.stop()
    await b.stop()
  }
})

// ---------------------------------------------------------------------------
// Inbound limits
// ---------------------------------------------------------------------------

test('modules: inbound maxBlobBytes is enforced, not silently ignored', async () => {
  const { a, b, homeA, homeB } = await createPair({}, { maxBlobBytes: 1024 })
  try {
    await writeFile(join(homeA, 'attachments', 'big.txt'), 'x'.repeat(4096))
    await a.cycle('test')
    const cycle = await b.cycle('test')
    assert.equal(await exists(join(homeB, 'attachments', 'big.txt')), false)
    assert.ok(cycle.errors.some((message) => /too large|maxBlobBytes/i.test(message)), 'the oversized file must surface as a cycle error')
  } finally {
    await a.stop()
    await b.stop()
  }
})

test('modules: maxModulesBytes defers the rest of the set with one conflict', async () => {
  const { a, b, homeA, homeB } = await createPair({}, { maxModulesBytes: 70 })
  try {
    await mkdir(join(nodeModulesOf(homeA), 'pkg'), { recursive: true })
    await writeFile(join(nodeModulesOf(homeA), 'pkg', 'a.js'), 'a'.repeat(60))
    await writeFile(join(nodeModulesOf(homeA), 'pkg', 'b.js'), 'b'.repeat(60))
    await a.cycle('test')
    const cycle = await b.cycle('test')
    assert.equal(await exists(join(nodeModulesOf(homeB), 'pkg', 'a.js')), true)
    assert.equal(await exists(join(nodeModulesOf(homeB), 'pkg', 'b.js')), false)
    assert.ok(cycle.conflicts >= 1)
    const limits = b.conflicts.filter((item) => item.kind === 'modules-over-limit')
    assert.equal(limits.length, 1, 'one conflict per peer per cycle')
  } finally {
    await a.stop()
    await b.stop()
  }
})

// ---------------------------------------------------------------------------
// sets.json migration
// ---------------------------------------------------------------------------

test('sets: a v1 file migrates to v3 and enables modules and credentials', async () => {
  const home = await createHome('migrate')
  await mkdir(join(home, 'dsh-sync'), { recursive: true })
  await writeFile(join(home, 'dsh-sync', 'sets.json'), JSON.stringify({
    version: 1,
    enabled: ['storages', 'profile', 'attachments', 'cache'],
  }))
  const engine = await createEngine(home)
  try {
    const modules = engine.sets.find((set) => set.id === 'modules')
    assert.equal(modules.enabled, true, 'modules is auto-enabled for existing installs')
    assert.equal(engine.sets.find((set) => set.id === 'credentials').enabled, true, 'credentials is auto-enabled too')
    assert.equal(engine.sets.find((set) => set.id === 'sessions').enabled, false)
    const saved = JSON.parse(await readFile(join(home, 'dsh-sync', 'sets.json'), 'utf8'))
    assert.equal(saved.version, 3)
    assert.ok(saved.enabled.includes('modules'))
    assert.ok(saved.enabled.includes('credentials'))
    assert.ok(!saved.enabled.includes('sessions'))

    const enabled = await engine.setSets(['profile', 'attachments'])
    assert.ok(!enabled.includes('modules'), 'turning profile off must turn modules off too')
    const savedAgain = JSON.parse(await readFile(join(home, 'dsh-sync', 'sets.json'), 'utf8'))
    assert.equal(savedAgain.version, 3)
    assert.ok(!savedAgain.enabled.includes('modules'))
  } finally {
    await engine.stop()
  }
})

test('sets: asking for modules without profile keeps modules off', async () => {
  const home = await createHome('migrate2')
  const engine = await createEngine(home)
  try {
    const enabled = await engine.setSets(['sessions', 'modules'])
    assert.ok(!enabled.includes('modules'))
    const saved = JSON.parse(await readFile(join(home, 'dsh-sync', 'sets.json'), 'utf8'))
    assert.equal(saved.version, 3)
    assert.ok(!saved.enabled.includes('modules'))
  } finally {
    await engine.stop()
  }
})
