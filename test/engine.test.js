import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Identity } from '../src/identity.js'
import { SyncEngine } from '../src/engine.js'
import { PeerClient } from '../src/transport.js'
import { sha256hex } from '../src/crypto.js'

async function createHome(label) {
  const home = await mkdtemp(join(tmpdir(), `dsh-sync-${label}-`))
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
    // Self-healing is covered by its own tests; keep the sync-focused fixtures
    // pristine so cycles only move data.
    config: { discovery: false, autoCycle: false, stableAfterMs: 0, keepBackups: false, repairProfile: false, ...extra },
  })
  await engine.start()
  return engine
}

async function createPair() {
  const homeA = await createHome('a')
  const homeB = await createHome('b')
  const a = await createEngine(homeA)
  const b = await createEngine(homeB)
  a.discovery.addPeer({ deviceId: b.identity.deviceId, host: '127.0.0.1', port: b.port, name: 'PC-B' })
  b.discovery.addPeer({ deviceId: a.identity.deviceId, host: '127.0.0.1', port: a.port, name: 'PC-A' })
  const pairA = await a.pairStart(b.identity.deviceId)
  const pairB = await b.pairStart(a.identity.deviceId)
  assert.equal(pairA.sas, pairB.sas, 'both devices must show the same SAS')
  await a.pairConfirm(b.identity.deviceId)
  await b.pairConfirm(a.identity.deviceId)
  return { a, b, homeA, homeB }
}

async function createRolePair(roleA, roleB) {
  const homeA = await createHome('ra')
  const homeB = await createHome('rb')
  const a = await createEngine(homeA)
  const b = await createEngine(homeB)
  await a.setRole(roleA)
  await b.setRole(roleB)
  a.discovery.addPeer({ deviceId: b.identity.deviceId, host: '127.0.0.1', port: b.port, name: 'PC-B' })
  b.discovery.addPeer({ deviceId: a.identity.deviceId, host: '127.0.0.1', port: a.port, name: 'PC-A' })
  const pairA = await a.pairStart(b.identity.deviceId)
  const pairB = await b.pairStart(a.identity.deviceId)
  assert.equal(pairA.sas, pairB.sas, 'both devices must show the same SAS')
  await a.pairConfirm(b.identity.deviceId)
  await b.pairConfirm(a.identity.deviceId)
  return { a, b, homeA, homeB }
}

async function stopAll(...engines) {
  for (const engine of engines) await engine.stop()
}

const sessionRel = 'proj-x/session-1/session.v4.jsonl.zstd'

test('engine: sessions, profile files and attachments replicate to the peer', async () => {
  const { a, b, homeA, homeB } = await createPair()
  try {
    const sessionBytes = Buffer.from('{"event":"header"}\n{"event":"user"}\n')
    await mkdir(join(homeA, 'sessions', 'proj-x', 'session-1'), { recursive: true })
    await writeFile(join(homeA, 'sessions', sessionRel), sessionBytes)
    await writeFile(join(homeA, 'profiles', 'desktop', 'cordis.patch.yml'), 'a: 1\n')
    await writeFile(join(homeA, 'attachments', 'note.txt'), 'hello from A\n')

    await a.cycle('test')
    await b.cycle('test')

    assert.deepEqual(await readFile(join(homeB, 'sessions', sessionRel)), sessionBytes)
    assert.equal(await readFile(join(homeB, 'profiles', 'desktop', 'cordis.patch.yml'), 'utf8'), 'a: 1\n')
    assert.equal(await readFile(join(homeB, 'attachments', 'note.txt'), 'utf8'), 'hello from A\n')

    // Idempotent second pass: nothing changes.
    const before = await fs.stat(join(homeB, 'sessions', sessionRel))
    await b.cycle('test')
    const after = await fs.stat(join(homeB, 'sessions', sessionRel))
    assert.equal(before.size, after.size)
    assert.equal(sha256hex(await readFile(join(homeB, 'sessions', sessionRel))), sha256hex(sessionBytes))
  } finally {
    await stopAll(a, b)
  }
})

test('engine: an appended session tail is merged by appending, not rewriting', async () => {
  const { a, b, homeA, homeB } = await createPair()
  try {
    const base = Buffer.from('{"seq":0}\n{"seq":1}\n')
    await mkdir(join(homeA, 'sessions', 'proj-x', 'session-1'), { recursive: true })
    await writeFile(join(homeA, 'sessions', sessionRel), base)
    await a.cycle('test')
    await b.cycle('test')

    const extended = Buffer.concat([base, Buffer.from('{"seq":2}\n{"seq":3}\n')])
    await writeFile(join(homeB, 'sessions', sessionRel), extended)
    await a.cycle('test')

    assert.deepEqual(await readFile(join(homeA, 'sessions', sessionRel)), extended)
    const conflictsDir = join(homeA, 'sessions', 'proj-x', 'session-1', 'conflicts')
    assert.equal(await exists(conflictsDir), false)
  } finally {
    await stopAll(a, b)
  }
})

test('engine: workspace.json is merged as a union on both devices', async () => {
  const { a, b, homeA, homeB } = await createPair()
  try {
    const workspaceA = {
      unit: { name: 'workspace', version: 2 },
      global: { initialized: true, defaultWorkspaceId: 'w1', workspaceIds: ['w1'], archivedSessionIds: ['a-archived'], pinnedSessionIds: ['a-pinned'] },
      tables: { workspaces: { w1: { path: 'D:/A', title: 'A', sessionIds: ['s1'], createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z' } } },
    }
    const workspaceB = {
      unit: { name: 'workspace', version: 2 },
      global: { initialized: true, workspaceIds: ['w2'], archivedSessionIds: ['b-archived'], pinnedSessionIds: [] },
      tables: { workspaces: { w2: { path: 'D:/B', title: 'B', sessionIds: ['s3'], createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' } } },
    }
    await writeFile(join(homeA, 'storages', 'workspace.json'), JSON.stringify(workspaceA, null, 2))
    await writeFile(join(homeB, 'storages', 'workspace.json'), JSON.stringify(workspaceB, null, 2))

    await a.cycle('test')
    await b.cycle('test')
    await a.cycle('test')

    const mergedA = JSON.parse(await readFile(join(homeA, 'storages', 'workspace.json'), 'utf8'))
    const mergedB = JSON.parse(await readFile(join(homeB, 'storages', 'workspace.json'), 'utf8'))
    for (const merged of [mergedA, mergedB]) {
      assert.deepEqual(Object.keys(merged.tables.workspaces).sort(), ['w1', 'w2'])
      assert.deepEqual(merged.global.workspaceIds.sort(), ['w1', 'w2'])
      assert.deepEqual(merged.tables.workspaces.w1.sessionIds, ['s1'])
    }
    // Archived / pinned lists are per-machine UI state: they must NOT be unioned,
    // or DSH hides the peer's sessions from the workspace list.
    assert.deepEqual(mergedA.global.archivedSessionIds, ['a-archived'])
    assert.deepEqual(mergedA.global.pinnedSessionIds, ['a-pinned'])
    assert.deepEqual(mergedB.global.archivedSessionIds, ['b-archived'])
    assert.deepEqual(mergedB.global.pinnedSessionIds, [])

    // The workspace base must be journaled under the real peer id, not the
    // placeholder 'peer' used by older builds.
    const journalFiles = await readdir(join(homeA, 'dsh-sync', 'journal'))
    assert.ok(!journalFiles.includes('peer.json'), 'no journal may be written for a placeholder peer')
    assert.ok(journalFiles.includes(`${b.identity.deviceId}.json`), 'journal must use the paired device id')
    const journal = JSON.parse(await readFile(join(homeA, 'dsh-sync', 'journal', `${b.identity.deviceId}.json`), 'utf8'))
    assert.ok(journal.entries['workspace|workspace.json'], 'the workspace base must be recorded')
    assert.equal(journal.entries['workspace|workspace.json'].h.length, 64)
  } finally {
    await stopAll(a, b)
  }
})

test('engine: an unparsable local workspace.json is never overwritten', async () => {
  const { a, b, homeA, homeB } = await createPair()
  try {
    const broken = '{"unit":{"name":"workspace","version":2},"global":{'
    await writeFile(join(homeA, 'storages', 'workspace.json'), broken)
    await writeFile(join(homeB, 'storages', 'workspace.json'), JSON.stringify({
      unit: { name: 'workspace', version: 2 },
      global: { initialized: true, workspaceIds: ['w2'], archivedSessionIds: [], pinnedSessionIds: [] },
      tables: { workspaces: { w2: { path: 'D:/B', title: 'B', sessionIds: ['s3'], updatedAt: '2026-01-01T00:00:00Z' } } },
    }, null, 2))

    const cycle = await a.cycle('test')
    assert.ok(cycle.conflicts >= 1, 'the skipped merge must be reported as a conflict')
    assert.equal(await readFile(join(homeA, 'storages', 'workspace.json'), 'utf8'), broken, 'the local file must stay untouched')
    assert.ok(a.conflicts.some((item) => item.kind === 'invalid-local' && item.rel === 'workspace.json'))
    const parked = (await readdir(join(homeA, 'storages'))).filter((name) => name.startsWith('workspace.json.conflict-'))
    assert.equal(parked.length, 1, 'the peer copy must be parked next to it')
    const parkedValue = JSON.parse(await readFile(join(homeA, 'storages', parked[0]), 'utf8'))
    assert.deepEqual(parkedValue.global.workspaceIds, ['w2'])

    // A second cycle must not pile up more conflict copies.
    await a.cycle('test')
    assert.equal((await readdir(join(homeA, 'storages'))).filter((name) => name.startsWith('workspace.json.conflict-')).length, 1)
  } finally {
    await stopAll(a, b)
  }
})

test('engine: divergent session logs keep the local file and park the peer copy', async () => {
  const { a, b, homeA, homeB } = await createPair()
  try {
    const base = Buffer.from('{"seq":0}\n')
    await mkdir(join(homeA, 'sessions', 'proj-x', 'session-1'), { recursive: true })
    await writeFile(join(homeA, 'sessions', sessionRel), base)
    await a.cycle('test')
    await b.cycle('test')

    await writeFile(join(homeA, 'sessions', sessionRel), Buffer.from('{"seq":0}\n{"who":"A"}\n'))
    await writeFile(join(homeB, 'sessions', sessionRel), Buffer.from('{"seq":0}\n{"who":"B"}\n'))
    await a.cycle('test')

    assert.equal(await readFile(join(homeA, 'sessions', sessionRel), 'utf8'), '{"seq":0}\n{"who":"A"}\n')
    const conflicts = join(homeA, 'sessions', 'proj-x', 'session-1', 'conflicts')
    const names = await readdir(conflicts)
    assert.equal(names.length, 1)
    assert.match(await readFile(join(conflicts, names[0]), 'utf8'), /"who":"B"/)

    await a.cycle('test')
    assert.equal((await readdir(conflicts)).length, 1, 'a parked conflict must not duplicate')
  } finally {
    await stopAll(a, b)
  }
})

test('engine: a session open in this process is never rewritten from the peer', async () => {
  const { a, b, homeA, homeB } = await createPair()
  try {
    const base = Buffer.from('{"seq":0}\n')
    await mkdir(join(homeA, 'sessions', 'proj-x', 'session-1'), { recursive: true })
    await writeFile(join(homeA, 'sessions', sessionRel), base)
    await a.cycle('test')
    await b.cycle('test')

    const extended = Buffer.concat([base, Buffer.from('{"seq":1}\n')])
    await writeFile(join(homeB, 'sessions', sessionRel), extended)
    a.hooks.isSessionLive = () => true
    const cycle = await a.cycle('test')
    assert.equal(await readFile(join(homeA, 'sessions', sessionRel), 'utf8'), '{"seq":0}\n')
    assert.ok(cycle.deferred >= 1, 'the live session must be reported as deferred')

    a.hooks.isSessionLive = () => false
    await a.cycle('test')
    assert.deepEqual(await readFile(join(homeA, 'sessions', sessionRel)), extended)
  } finally {
    await stopAll(a, b)
  }
})

test('engine: deleting a synced attachment propagates to the peer', async () => {
  const { a, b, homeA, homeB } = await createPair()
  try {
    await writeFile(join(homeA, 'attachments', 'old.txt'), 'delete me')
    await a.cycle('test')
    await b.cycle('test')
    assert.equal(await readFile(join(homeB, 'attachments', 'old.txt'), 'utf8'), 'delete me')

    await fs.rm(join(homeA, 'attachments', 'old.txt'))
    await a.cycle('test')
    const cycle = await b.cycle('test')
    assert.equal(await exists(join(homeB, 'attachments', 'old.txt')), false)
    assert.ok(cycle.deleted >= 1, 'the peer must report one deletion')
  } finally {
    await stopAll(a, b)
  }
})

test('engine: a modified peer copy survives a delete tombstone', async () => {
  const { a, b, homeA, homeB } = await createPair()
  try {
    await writeFile(join(homeA, 'attachments', 'keep.txt'), 'original')
    await a.cycle('test')
    await b.cycle('test')
    await writeFile(join(homeB, 'attachments', 'keep.txt'), 'locally changed')

    await fs.rm(join(homeA, 'attachments', 'keep.txt'))
    await a.cycle('test')
    await b.cycle('test')
    assert.equal(await readFile(join(homeB, 'attachments', 'keep.txt'), 'utf8'), 'locally changed')
    assert.equal(await readFile(join(homeA, 'attachments', 'keep.txt'), 'utf8'), 'locally changed')
    assert.ok(a.conflicts.some((item) => item.kind === 'resurrect' && item.rel === 'keep.txt'))
  } finally {
    await stopAll(a, b)
  }
})

test('engine: session logs are never deleted by tombstones', async () => {
  const { a, b, homeA, homeB } = await createPair()
  try {
    await mkdir(join(homeA, 'sessions', 'proj-x', 'session-1'), { recursive: true })
    await writeFile(join(homeA, 'sessions', sessionRel), Buffer.from('{"seq":0}\n'))
    await a.cycle('test')
    await b.cycle('test')

    await fs.rm(join(homeA, 'sessions', sessionRel))
    await a.cycle('test')
    await b.cycle('test')
    assert.equal(await exists(join(homeB, 'sessions', sessionRel)), true, 'session history must survive')
  } finally {
    await stopAll(a, b)
  }
})

test('engine: a manually entered IP:port is resolved over TCP and syncs', async () => {
  const homeA = await createHome('ma')
  const homeB = await createHome('mb')
  const a = await createEngine(homeA)
  const b = await createEngine(homeB)
  try {
    const reachable = await a.addManualPeer(`127.0.0.1:${b.port}`)
    assert.equal(reachable.reachable, true)
    const peer = a.discovery.list().find((item) => item.deviceId === b.identity.deviceId)
    assert.ok(peer, 'the manual endpoint must turn into a real peer')
    assert.equal(peer.port, b.port)

    const reachableB = await b.addManualPeer(`127.0.0.1:${a.port}`)
    assert.equal(reachableB.reachable, true)

    const pairA = await a.pairStart(b.identity.deviceId)
    const pairB = await b.pairStart(a.identity.deviceId)
    assert.equal(pairA.sas, pairB.sas)
    await a.pairConfirm(b.identity.deviceId)
    await b.pairConfirm(a.identity.deviceId)

    await writeFile(join(homeA, 'attachments', 'manual.txt'), 'manual path')
    await a.cycle('test')
    await b.cycle('test')
    assert.equal(await readFile(join(homeB, 'attachments', 'manual.txt'), 'utf8'), 'manual path')
  } finally {
    await stopAll(a, b)
  }
})

test('engine: an unreachable manual endpoint is reported, not thrown', async () => {
  const home = await createHome('mu')
  const engine = await createEngine(home)
  try {
    const result = await engine.addManualPeer('127.0.0.1:1')
    assert.equal(result.reachable, false)
    assert.equal(result.endpoint.port, 1)
  } finally {
    await engine.stop()
  }
})

test('engine: a second manual cycle joins the running one and reports progress', async () => {
  const { a, b, homeB } = await createPair()
  try {
    const payload = 'x'.repeat(4096)
    await writeFile(join(homeB, 'attachments', 'join.txt'), payload)
    const first = a.cycle('manual')
    const second = a.cycle('manual')
    const [resultA, resultB] = await Promise.all([first, second])
    assert.equal(resultA, resultB, 'both callers must observe the same cycle result')
    assert.ok(resultA.pulled >= 1)
    assert.ok(a.progress?.finishedAt, 'progress must be closed when the cycle ends')
    assert.ok(a.progress.pulled >= 1)
    assert.ok(a.progress.bytes >= payload.length)
    assert.equal(a.state().syncing, false)
  } finally {
    await stopAll(a, b)
  }
})

test('engine: profile package.json merges, filters unavailable bundles and protects machine config', async () => {
  const { a, b, homeA, homeB } = await createPair()
  try {
    // A can load `dsh-experimental` (installed in its profile node_modules) but
    // has never seen `dsh-npu`, which only B has.
    const installed = join(homeA, 'profiles', 'desktop', 'node_modules', 'dsh-experimental')
    await mkdir(installed, { recursive: true })
    await writeFile(join(installed, 'package.json'), JSON.stringify({ name: 'dsh-experimental', version: '2.0.0', main: 'index.js' }, null, 2))
    await writeFile(join(installed, 'index.js'), 'export default 1\n')

    const pkgA = {
      name: 'p',
      dependencies: { 'dsh-plugin-qqbot': 'link:./plugins/qqbot' },
      dsh: { profile: { bundles: ['base', 'dsh-plugin-qqbot'] } },
    }
    const pkgB = {
      name: 'p',
      dependencies: { 'dsh-experimental': '2.0.0', 'dsh-npu': 'link:./plugins/dsh-npu' },
      dsh: { profile: { bundles: ['base', 'dsh-experimental', 'dsh-npu'] } },
    }
    const packageA = join(homeA, 'profiles', 'desktop', 'package.json')
    const packageB = join(homeB, 'profiles', 'desktop', 'package.json')
    await writeFile(packageA, JSON.stringify(pkgA, null, 2))
    await writeFile(packageB, JSON.stringify(pkgB, null, 2))
    const future = new Date(Date.now() + 5000)
    await fs.utimes(packageB, future, future)

    const cycle = await a.cycle('test')
    const mergedA = JSON.parse(await readFile(packageA, 'utf8'))
    assert.equal(mergedA.dependencies['dsh-plugin-qqbot'], 'link:./plugins/qqbot')
    assert.equal(mergedA.dependencies['dsh-experimental'], '2.0.0', 'registry dependency is kept')
    assert.equal(mergedA.dependencies['dsh-npu'], undefined, 'missing link target must not be adopted')
    assert.ok(mergedA.dsh.profile.bundles.includes('dsh-plugin-qqbot'))
    assert.ok(mergedA.dsh.profile.bundles.includes('dsh-experimental'), 'locally resolvable bundle is adopted')
    assert.ok(!mergedA.dsh.profile.bundles.includes('dsh-npu'), 'unavailable peer bundle must not be adopted')
    assert.ok(cycle.conflicts >= 2, 'both skipped entries must be reported')
    const skipped = a.conflicts.filter((item) => item.kind === 'bundle-unavailable' || item.kind === 'dependency-unavailable')
    assert.deepEqual(skipped.map((item) => item.item).sort(), ['dsh-npu', 'dsh-npu'])
    assert.ok(skipped.every((item) => item.rel === 'package.json'))

    // Installing the missing plugin must be picked up by the next cycle, even
    // though the merge was skipped the first time.
    await mkdir(join(homeA, 'profiles', 'desktop', 'plugins', 'dsh-npu'), { recursive: true })
    await writeFile(join(homeA, 'profiles', 'desktop', 'plugins', 'dsh-npu', 'index.js'), 'export default 1\n')
    const npuInstalled = join(homeA, 'profiles', 'desktop', 'node_modules', 'dsh-npu')
    await mkdir(npuInstalled, { recursive: true })
    await writeFile(join(npuInstalled, 'package.json'), JSON.stringify({ name: 'dsh-npu', version: '1.0.0', main: 'index.js' }))
    await writeFile(join(npuInstalled, 'index.js'), 'export default 1\n')
    await a.cycle('test')
    const adopted = JSON.parse(await readFile(packageA, 'utf8'))
    assert.equal(adopted.dependencies['dsh-npu'], 'link:./plugins/dsh-npu')
    assert.ok(adopted.dsh.profile.bundles.includes('dsh-npu'), 'a later cycle must adopt the now-installed plugin')

    // `cordis.yml` is still fully machine-protected (cordis.patch.yml only merges
    // its whitelisted model blocks, see settings.test.js).
    const patchA = join(homeA, 'profiles', 'desktop', 'cordis.yml')
    const patchB = join(homeB, 'profiles', 'desktop', 'cordis.yml')
    await writeFile(patchA, '# local A\n')
    await writeFile(patchB, '# remote B\n')
    await fs.utimes(patchB, future, future)
    await a.cycle('test')
    assert.equal(await readFile(patchA, 'utf8'), '# local A\n', 'local config must never be overwritten')
    assert.ok(a.conflicts.some((item) => item.kind === 'protected' && item.rel === 'cordis.yml'))
    const parked = (await readdir(join(homeA, 'profiles', 'desktop'))).filter((name) => name.startsWith('cordis.yml.conflict-'))
    assert.equal(parked.length, 1)
    await a.cycle('test')
    assert.equal(a.conflicts.filter((item) => item.kind === 'protected').length, 1, 'a parked protection must not duplicate')
  } finally {
    await stopAll(a, b)
  }
})

test('engine: an unparsable local profile package.json is never overwritten', async () => {
  const { a, b, homeA, homeB } = await createPair()
  try {
    const broken = '{"name":"p","dependencies":{'
    await writeFile(join(homeA, 'profiles', 'desktop', 'package.json'), broken)
    await writeFile(join(homeB, 'profiles', 'desktop', 'package.json'), JSON.stringify({
      name: 'p',
      dependencies: { 'dsh-experimental': '2.0.0' },
      dsh: { profile: { bundles: ['base', 'dsh-experimental'] } },
    }, null, 2))
    const future = new Date(Date.now() + 5000)
    await fs.utimes(join(homeB, 'profiles', 'desktop', 'package.json'), future, future)

    const cycle = await a.cycle('test')
    assert.ok(cycle.conflicts >= 1)
    assert.equal(await readFile(join(homeA, 'profiles', 'desktop', 'package.json'), 'utf8'), broken, 'the local file must stay untouched')
    assert.ok(a.conflicts.some((item) => item.kind === 'invalid-local' && item.rel === 'package.json'))
    const parked = (await readdir(join(homeA, 'profiles', 'desktop'))).filter((name) => name.startsWith('package.json.conflict-'))
    assert.equal(parked.length, 1)
  } finally {
    await stopAll(a, b)
  }
})

test('engine: push is limited to a locked host targeting a sub device', async () => {
  const { a, b, homeA, homeB } = await createPair()
  const fresh = await createEngine(await createHome('gate'))
  try {
    await writeFile(join(homeA, 'attachments', 'push.txt'), 'from A')
    await writeFile(join(homeB, 'attachments', 'push.txt'), 'from B')
    const future = new Date(Date.now() + 5000)
    await fs.utimes(join(homeB, 'attachments', 'push.txt'), future, future)

    const result = await a.pushTo(b.identity.deviceId)
    assert.ok(result.pushed >= 1)
    assert.equal(await readFile(join(homeB, 'attachments', 'push.txt'), 'utf8'), 'from A')

    // A peer recorded as a host is not a push target.
    a.settings.peerRoles[b.identity.deviceId] = 'host'
    await assert.rejects(() => a.pushTo(b.identity.deviceId), (error) => error.code === 'push-not-allowed')

    // An unlocked device may never push.
    await assert.rejects(() => fresh.pushTo(b.identity.deviceId), (error) => error.code === 'push-not-allowed')
  } finally {
    await stopAll(a, b, fresh)
  }
})

test('engine: sync settings persist across restarts and expose the new state fields', async () => {
  const home = await createHome('cfg')
  const engine = await createEngine(home)
  const settingsFile = join(home, 'dsh-sync', 'sync-settings.json')
  try {
    const state = engine.state()
    assert.equal(state.settings.role, 'host')
    assert.equal(state.settings.roleLocked, false)
    assert.equal(state.settings.realtime, false)
    assert.equal(state.settings.localOnlyExcluded, false)
    assert.deepEqual(state.settings.shadowWorkspace, { enabled: false })
    assert.deepEqual(state.settings.cleanup, {
      enabled: true,
      retentionDays: 7,
      backups: true,
      backupDays: 45,
      recycle: true,
      recycleMax: 100,
    })
    assert.equal(state.immediate, 'push')
    assert.deepEqual(state.cleanupStats, { conflictCount: 0, conflictBytes: 0, recycleCount: 0 })
    assert.equal(state.changesPreview, null)
    assert.ok(await exists(settingsFile), 'the defaults must be persisted on first start')
    assert.ok(state.sets.every((set) => set.items === null))

    await engine.setRealtime(true)
    await engine.setLocalOnly(true)
    await engine.setShadowWorkspace(true)
    await engine.setCleanup({ retentionDays: 30, recycleMax: 25, recycle: false })
    const saved = JSON.parse(await readFile(settingsFile, 'utf8'))
    assert.equal(saved.realtime, true)
    assert.equal(saved.localOnlyExcluded, true)
    assert.deepEqual(saved.shadowWorkspace, { enabled: true })
    assert.equal(saved.cleanup.retentionDays, 30)
    assert.equal(saved.cleanup.recycleMax, 25)
    assert.equal(saved.cleanup.recycle, false)

    await engine.setRole('sub')
    assert.equal(engine.state().immediate, 'pull')
  } finally {
    await engine.stop()
  }

  const again = await createEngine(home)
  try {
    const state = again.state()
    assert.equal(state.settings.realtime, true)
    assert.equal(state.settings.localOnlyExcluded, true)
    assert.deepEqual(state.settings.shadowWorkspace, { enabled: true })
    assert.equal(state.settings.cleanup.retentionDays, 30)
    assert.equal(state.settings.cleanup.recycleMax, 25)
    assert.equal(state.settings.role, 'sub')
    assert.equal(state.immediate, 'pull')
  } finally {
    await again.stop()
  }
})

test('engine: legacy paired devices are pinned to host on first boot', async () => {
  const { a, b, homeA } = await createPair()
  const peerId = b.identity.deviceId
  await stopAll(a, b)
  const settingsFile = join(homeA, 'dsh-sync', 'sync-settings.json')
  assert.ok(await exists(settingsFile))
  await fs.rm(settingsFile)

  const engine = await createEngine(homeA)
  try {
    const state = engine.state()
    assert.equal(state.settings.role, 'host')
    assert.equal(state.settings.roleLocked, true)
    assert.equal(state.settings.peerRoles[peerId], 'sub')
    assert.equal(state.allowPush, true)
    assert.equal(state.peers.find((peer) => peer.deviceId === peerId)?.role, 'sub')
  } finally {
    await engine.stop()
  }
})

test('engine: realtime off stops automatic cycles but keeps explicit paths', async () => {
  const home = await createHome('rt')
  const engine = await createEngine(home)
  try {
    for (const reason of ['interval', 'startup', 'peer-discovered', 'paired', 'sets', 'pending']) {
      assert.deepEqual(await engine.cycle(reason), { skipped: 'realtime-off' }, `${reason} must be gated`)
    }
    const manual = await engine.cycle('manual')
    assert.equal(manual.reason, 'manual')
    assert.notEqual(manual.skipped, 'realtime-off')

    // Realtime on but no locked role: the automatic cycle has no direction.
    await engine.setRealtime(true)
    assert.deepEqual(await engine.cycle('interval'), { skipped: 'role-unlocked' })
    const manualAfter = await engine.cycle('manual')
    assert.equal(manualAfter.reason, 'manual')
  } finally {
    await engine.stop()
  }
})

test('engine: pairing locks the role and disconnectAll unlocks it', async () => {
  const { a, b } = await createPair()
  try {
    assert.equal(a.state().settings.roleLocked, true)
    await assert.rejects(() => a.setRole('sub'), (error) => error.code === 'role-locked')

    const state = await a.disconnectAll()
    assert.equal(state.settings.roleLocked, false)
    assert.deepEqual(state.settings.peerRoles, {})
    assert.equal(state.peers.filter((peer) => peer.trusted).length, 0)
    assert.equal(state.allowPush, false)

    const switched = await a.setRole('sub')
    assert.equal(switched.settings.role, 'sub')
  } finally {
    await stopAll(a, b)
  }
})

test('engine: a sub device cannot push and may only keep one host', async () => {
  const { a, b } = await createRolePair('host', 'sub')
  const homeC = await createHome('extra-host')
  const c = await createEngine(homeC)
  try {
    assert.equal(b.state().settings.role, 'sub')
    await assert.rejects(() => b.pushTo(a.identity.deviceId), (error) => error.code === 'push-not-allowed')

    b.discovery.addPeer({ deviceId: c.identity.deviceId, host: '127.0.0.1', port: c.port, name: 'PC-C' })
    await b.pairStart(c.identity.deviceId)
    await assert.rejects(() => b.pairConfirm(c.identity.deviceId), (error) => error.code === 'sub-single-host')
    assert.equal(b.state().peers.filter((peer) => peer.trusted).length, 1)
  } finally {
    await stopAll(a, b, c)
  }
})

test('engine: immediate sync pushes on the host and pulls on a sub', async () => {
  const { a, b, homeA, homeB } = await createRolePair('host', 'sub')
  const fresh = await createEngine(await createHome('imm'))
  try {
    await writeFile(join(homeA, 'attachments', 'host.txt'), 'host data')
    const pushed = await a.immediateSync()
    assert.equal(pushed.direction, 'push')
    assert.equal(pushed.results.length, 1)
    assert.ok(pushed.results[0].result.pushed >= 1)
    assert.equal(await readFile(join(homeB, 'attachments', 'host.txt'), 'utf8'), 'host data')

    await writeFile(join(homeA, 'attachments', 'host2.txt'), 'second')
    const pulled = await b.immediateSync()
    assert.equal(pulled.direction, 'pull')
    assert.ok(pulled.result.pulled >= 1)
    assert.equal(await readFile(join(homeB, 'attachments', 'host2.txt'), 'utf8'), 'second')

    await assert.rejects(() => fresh.immediateSync(), (error) => error.code === 'not-ready')
  } finally {
    await stopAll(a, b, fresh)
  }
})

test('engine: change previews follow the sync direction and clear after syncing', async () => {
  const { a, b, homeA } = await createRolePair('host', 'sub')
  try {
    await writeFile(join(homeA, 'attachments', 'p1.txt'), 'one')
    await writeFile(join(homeA, 'attachments', 'p2.txt'), 'two!')
    const preview = await a.previewChanges(b.identity.deviceId)
    assert.equal(preview.count, 2)
    assert.equal(preview.bytes, 7)
    assert.deepEqual(preview.files.map((file) => file.rel).sort(), ['p1.txt', 'p2.txt'])
    assert.ok(preview.files.every((file) => file.set === 'attachments'))
    assert.equal(a.state().changesPreview.direction, 'push')
    assert.equal(a.state().changesPreview.count, 2)

    const hostPreview = await a.previewImmediate()
    assert.equal(hostPreview.direction, 'push')
    assert.equal(hostPreview.count, 2)

    await a.immediateSync()
    await a.cycle('test')
    assert.equal((await a.previewChanges(b.identity.deviceId)).count, 0)

    // The sub previews what its host still has to send.
    await writeFile(join(homeA, 'attachments', 'p3.txt'), 'three')
    await a.cycle('test')
    const pullPreview = await b.previewImmediate()
    assert.equal(pullPreview.direction, 'pull')
    assert.ok(pullPreview.files.some((file) => file.rel === 'p3.txt'))
    await b.immediateSync()
    assert.equal((await b.previewImmediate()).count, 0)
  } finally {
    await stopAll(a, b)
  }
})

test('engine: cleanup recycles expired conflicts, keeps flagged ones and caps the recycle bin', async () => {
  const home = await createHome('cleanup')
  const engine = await createEngine(home)
  const stateDir = join(home, 'dsh-sync')
  const conflictsDir = join(stateDir, 'conflicts')
  await mkdir(conflictsDir, { recursive: true })
  const parkCopy = async (name, content, ageDays) => {
    const file = join(conflictsDir, name)
    await writeFile(file, content)
    const when = new Date(Date.now() - ageDays * 86_400_000)
    await fs.utimes(file, when, when)
    return file
  }
  try {
    const oldAt = new Date(Date.now() - 10 * 86_400_000).toISOString()
    const expiredFile = await parkCopy('a.conflict-p1.txt', '12345', 10)
    const keptFile = await parkCopy('b.conflict-p1.txt', '1234567890', 10)
    await engine.addConflict({ kind: 'test', set: 'attachments', rel: 'a.txt', peer: 'p1', hash: 'h1', file: expiredFile, at: oldAt })
    await engine.addConflict({ kind: 'test', set: 'attachments', rel: 'b.txt', peer: 'p1', hash: 'h2', file: keptFile, at: oldAt, keep: true })
    const keptId = engine.conflicts.find((item) => item.rel === 'b.txt').id
    const expiredRecord = engine.conflicts.find((item) => item.rel === 'a.txt')
    assert.ok(engine.conflictActiveDays(expiredRecord) >= 10)
    assert.equal(expiredRecord.keep, false)
    assert.equal(expiredRecord.size, 5)
    assert.ok(expiredRecord.createdAt)

    const result = await engine.cleanupNow()
    assert.equal(result.removed, 1)
    assert.equal(result.freed, 5)
    assert.equal(await exists(expiredFile), false)
    assert.equal(await exists(keptFile), true)
    assert.equal(engine.state().cleanupStats.conflictCount, 1)
    assert.equal(engine.state().cleanupStats.recycleCount, 1)
    assert.equal(await exists(join(stateDir, 'cleanup.json')), true)
    const cleanupDoc = JSON.parse(await readFile(join(stateDir, 'cleanup.json'), 'utf8'))
    assert.ok(Array.isArray(cleanupDoc.conflicts))
    assert.equal(cleanupDoc.settings.retentionDays, 7)

    await engine.setConflictKeep([keptId], false)
    const deleted = await engine.deleteConflicts([keptId])
    assert.equal(deleted.removed, 1)
    assert.equal(engine.state().cleanupStats.conflictCount, 0)

    await engine.setCleanup({ recycleMax: 1 })
    assert.equal(engine.state().cleanupStats.recycleCount, 1)
    for (const name of ['c1', 'c2']) {
      const file = await parkCopy(`${name}.conflict-p1.txt`, 'xxxxxxxxxx', 20)
      await engine.addConflict({ kind: 'test', set: 'attachments', rel: `${name}.txt`, peer: 'p1', hash: name, file, at: oldAt })
    }
    const second = await engine.cleanupNow()
    assert.equal(second.removed, 2)
    assert.equal(second.freed, 20)
    assert.equal(engine.state().cleanupStats.recycleCount, 1)
  } finally {
    await engine.stop()
  }
})

test('engine: cleanup recycles real conflict copies in set roots and refuses malicious paths', async () => {
  const home = await createHome('cleanup-real')
  const engine = await createEngine(home)
  const outsideDir = await mkdtemp(join(tmpdir(), 'dsh-sync-outside-'))
  try {
    const oldAt = new Date(Date.now() - 10 * 86_400_000).toISOString()
    // Real conflict copies: next to a file and inside a session conflicts dir.
    const fileCopy = join(home, 'attachments', 'note.txt.conflict-p1-1700000000')
    await writeFile(fileCopy, 'parked copy')
    const sessionDir = join(home, 'sessions', 'proj-1', 'session-1', 'conflicts')
    await mkdir(sessionDir, { recursive: true })
    const sessionCopy = join(sessionDir, 'session.v4.jsonl.zstd.p1-1700000000')
    await writeFile(sessionCopy, 'session copy')
    // Name produced by merge.conflictName(): `<rel>.conflict-<peer8>-<ISO>`.
    const stampCopy = join(home, 'storages', 'workspace.json.conflict-abcdef12-2026-10-27T11-12-25-775Z')
    await writeFile(stampCopy, 'stamp copy')
    await engine.addConflict({ kind: 'test', set: 'attachments', rel: 'note.txt', peer: 'p1', hash: 'h1', file: fileCopy, at: oldAt })
    await engine.addConflict({ kind: 'test', set: 'sessions', rel: 'proj-1/session-1/session.v4.jsonl.zstd', peer: 'p1', hash: 'h2', file: sessionCopy, at: oldAt })
    await engine.addConflict({ kind: 'test', set: 'storages', rel: 'workspace.json', peer: 'p1', hash: 'h7', file: stampCopy, at: oldAt })

    // Malicious / unrelated candidates must be refused and kept as records.
    const outside = join(outsideDir, 'evil.conflict-p1')
    await writeFile(outside, 'not ours')
    await engine.addConflict({ kind: 'test', set: 'attachments', rel: 'evil.txt', peer: 'p1', hash: 'h3', file: outside, at: oldAt })
    const traversal = join(home, 'attachments', '..', '..', 'traversal.conflict-p1')
    const traversalAbs = join(home, '..', 'traversal.conflict-p1')
    await writeFile(traversalAbs, 'traversal')
    await engine.addConflict({ kind: 'test', set: 'attachments', rel: 'traversal.txt', peer: 'p1', hash: 'h4', file: traversal, at: oldAt })
    const unrelated = join(home, 'attachments', 'normal.txt')
    await writeFile(unrelated, 'ordinary file')
    await engine.addConflict({ kind: 'test', set: 'attachments', rel: 'normal.txt', peer: 'p1', hash: 'h5', file: unrelated, at: oldAt })
    // Forged record: set says storages, path lives in the sessions tree.
    const forged = join(home, 'sessions', 'proj-1', 'session-1', 'forged.conflict-p1-1700000000')
    await writeFile(forged, 'forged')
    await engine.addConflict({ kind: 'test', set: 'storages', rel: 'forged.txt', peer: 'p1', hash: 'h6', file: forged, at: oldAt })

    const result = await engine.cleanupNow()
    assert.equal(result.removed, 3, 'all real conflict copies must be recycled')
    assert.equal(result.freed, 11 + 12 + 10)
    assert.equal(result.skipped, 4)
    assert.equal(await exists(fileCopy), false)
    assert.equal(await exists(sessionCopy), false)
    assert.equal(await exists(stampCopy), false, 'engine conflictName() names must be recognised')
    assert.equal(await exists(outside), true)
    assert.equal(await exists(traversalAbs), true)
    assert.equal(await exists(unrelated), true)
    assert.equal(await exists(forged), true, 'a record pointing into another set root must be refused')
    assert.equal(engine.state().cleanupStats.recycleCount, 3)
    assert.equal(engine.state().cleanupStats.conflictCount, 4)

    // Manual deletion reuses the same allowlist.
    const unrelatedId = engine.conflicts.find((item) => item.rel === 'normal.txt').id
    const deleted = await engine.deleteConflicts([unrelatedId])
    assert.equal(deleted.removed, 0)
    assert.equal(await exists(unrelated), true)
    const forgedId = engine.conflicts.find((item) => item.rel === 'forged.txt').id
    const forgedDeleted = await engine.deleteConflicts([forgedId])
    assert.equal(forgedDeleted.removed, 0)
    assert.equal(await exists(forged), true)
  } finally {
    await engine.stop()
    await fs.rm(outsideDir, { recursive: true, force: true })
    await fs.rm(join(home, '..', 'traversal.conflict-p1'), { force: true }).catch(() => {})
  }
})

test('engine: force pull overwrites the newer local file from the peer', async () => {
  const { a, b, homeA, homeB } = await createPair()
  try {
    await writeFile(join(homeB, 'attachments', 'pull.txt'), 'from B')
    await writeFile(join(homeA, 'attachments', 'pull.txt'), 'from A newer')
    const future = new Date(Date.now() + 5000)
    await fs.utimes(join(homeA, 'attachments', 'pull.txt'), future, future)
    await b.addManualPeer(`127.0.0.1:${a.port}`)
    await a.addManualPeer(`127.0.0.1:${b.port}`)
    const result = await a.forcePull(b.identity.deviceId)
    assert.ok(result.pulled >= 1)
    assert.equal(await readFile(join(homeA, 'attachments', 'pull.txt'), 'utf8'), 'from B')
  } finally {
    await stopAll(a, b)
  }
})

test('engine: pushing machine config keeps the peer copy and parks a conflict', async () => {
  const { a, b, homeA, homeB } = await createPair()
  try {
    await writeFile(join(homeA, 'profiles', 'desktop', 'cordis.yml'), '# A config\n')
    await writeFile(join(homeB, 'profiles', 'desktop', 'cordis.yml'), '# B config\n')
    await a.setPushGuard(true)
    const result = await a.pushTo(b.identity.deviceId)
    assert.ok(result.pushed >= 1)
    assert.equal(await readFile(join(homeB, 'profiles', 'desktop', 'cordis.yml'), 'utf8'), '# B config\n')
    assert.ok(b.conflicts.some((item) => item.kind === 'protected' && item.rel === 'cordis.yml'))
  } finally {
    await stopAll(a, b)
  }
})

test('engine: a plugin deleted locally is not resurrected by the peer', async () => {
  const { a, b, homeA, homeB } = await createPair()
  try {
    const pluginA = join(homeA, 'profiles', 'desktop', 'plugins', 'demo')
    const pluginB = join(homeB, 'profiles', 'desktop', 'plugins', 'demo')
    await fs.mkdir(pluginA, { recursive: true })
    await fs.mkdir(pluginB, { recursive: true })
    await writeFile(join(pluginA, 'index.js'), 'export default 1\n')
    await writeFile(join(pluginB, 'index.js'), 'export default 1\n')
    await a.cycle('test')
    await b.cycle('test')
    await fs.unlink(join(pluginA, 'index.js'))

    await a.cycle('test')
    assert.equal(await exists(join(pluginA, 'index.js')), false, 'local deletion must stick')
    assert.equal(await exists(join(pluginB, 'index.js')), true, 'the peer copy must stay')
    await a.cycle('test')
    assert.equal(await exists(join(pluginA, 'index.js')), false)
  } finally {
    await stopAll(a, b)
  }
})

test('engine: an unpaired device is rejected by the RPC endpoint', async () => {
  const { a, b } = await createPair()
  const homeC = await createHome('c')
  const c = await createEngine(homeC)
  try {
    const client = new PeerClient({
      identity: c.identity,
      peer: { deviceId: a.identity.deviceId, host: '127.0.0.1', port: a.port },
    })
    await client.hello()
    await assert.rejects(() => client.rpc('ping'), /does not trust/i)
  } finally {
    await stopAll(a, b, c)
  }
})

test('engine: retentionDays 0 means conflict copies are kept forever', async () => {
  const home = await createHome('cleanup-zero')
  const engine = await createEngine(home)
  const conflictsDir = join(home, 'dsh-sync', 'conflicts')
  await mkdir(conflictsDir, { recursive: true })
  const parked = join(conflictsDir, 'old.conflict-p1.txt')
  await writeFile(parked, 'keep forever')
  try {
    await engine.addConflict({
      kind: 'test',
      set: 'attachments',
      rel: 'old.txt',
      peer: 'p1',
      hash: 'h0',
      file: parked,
      at: new Date(Date.now() - 30 * 86_400_000).toISOString(),
    })
    await engine.setCleanup({ retentionDays: 0 })
    const result = await engine.cleanupNow()
    assert.equal(result.removed, 0)
    assert.equal(result.freed, 0)
    assert.equal(await exists(parked), true)
    assert.equal(engine.state().cleanupStats.conflictCount, 1)

    // The automatic pass is a no-op too.
    await engine.runAutoCleanup()
    assert.equal(engine.state().cleanupStats.conflictCount, 1)

    // Explicit UI deletion still works while retention is 0.
    const deleted = await engine.deleteConflicts([engine.conflicts[0].id])
    assert.equal(deleted.removed, 1)
  } finally {
    await engine.stop()
  }
})

test('engine: automatic cleanup timers follow cleanup.enabled and are cleared on stop', async () => {
  const homeOn = await createHome('cleanup-timer-on')
  const stateDirOn = join(homeOn, 'dsh-sync')
  const on = new SyncEngine({
    home: homeOn,
    profile: 'desktop',
    stateDir: stateDirOn,
    identity: await new Identity({ stateDir: stateDirOn }).load(),
    config: { discovery: false, autoCycle: true, enabled: false, stableAfterMs: 0, keepBackups: false, repairProfile: false },
  })
  await on.start()
  try {
    assert.ok(on.cleanupFirstTimer, 'the first cleanup pass must be scheduled')
    assert.ok(on.cleanupTimer, 'the periodic cleanup pass must be scheduled')
  } finally {
    await on.stop()
  }
  assert.equal(on.cleanupFirstTimer, null)
  assert.equal(on.cleanupTimer, null)

  const homeOff = await createHome('cleanup-timer-off')
  const stateDirOff = join(homeOff, 'dsh-sync')
  await mkdir(stateDirOff, { recursive: true })
  await writeFile(join(stateDirOff, 'sync-settings.json'), JSON.stringify({
    version: 1,
    role: 'host',
    roleLocked: false,
    realtime: false,
    localOnlyExcluded: false,
    shadowWorkspace: { enabled: false },
    peerRoles: {},
    cleanup: { enabled: false, retentionDays: 7, backups: true, backupDays: 45, recycle: true, recycleMax: 100 },
    sets: {},
  }, null, 2))
  const off = new SyncEngine({
    home: homeOff,
    profile: 'desktop',
    stateDir: stateDirOff,
    identity: await new Identity({ stateDir: stateDirOff }).load(),
    config: { discovery: false, autoCycle: true, enabled: false, stableAfterMs: 0, keepBackups: false, repairProfile: false },
  })
  await off.start()
  try {
    assert.equal(off.cleanupTimer, null)
    assert.equal(off.cleanupFirstTimer, null)
  } finally {
    await off.stop()
  }
})

test('engine: previewPull lists the files a force pull would overwrite', async () => {
  const { a, b, homeA, homeB } = await createRolePair('host', 'sub')
  try {
    // A fresh pair has nothing to overwrite.
    const empty = await a.previewPull(b.identity.deviceId)
    assert.equal(empty.count, 0)
    assert.equal(empty.bytes, 0)
    assert.deepEqual(empty.files, [])

    await writeFile(join(homeB, 'attachments', 'from-sub.txt'), 'sub data')
    await writeFile(join(homeA, 'attachments', 'conflict.txt'), 'host copy')
    await writeFile(join(homeB, 'attachments', 'conflict.txt'), 'sub copy')
    const preview = await a.previewPull(b.identity.deviceId)
    assert.equal(preview.count, 2)
    assert.deepEqual(preview.files.map((file) => file.rel).sort(), ['conflict.txt', 'from-sub.txt'])
    assert.equal(preview.bytes, 16)
    assert.equal(a.state().changesPreview.direction, 'pull')

    const pulled = await a.forcePull(b.identity.deviceId)
    assert.ok(pulled.pulled >= 2)
    assert.equal((await a.previewPull(b.identity.deviceId)).count, 0)

    await assert.rejects(() => a.previewPull('0123456789abcdef'), (error) => error.code === 'not-ready')
  } finally {
    await stopAll(a, b)
  }
})

test('engine: setSets persists per-set item scope for Phase 2', async () => {
  const home = await createHome('items')
  const engine = await createEngine(home)
  const items = ['proj-a/session-1', 'proj-b/session-2']
  try {
    const enabled = await engine.setSets([
      { id: 'sessions', enabled: true, items },
      { id: 'attachments', enabled: true, items: [] },
      { id: 'profile', enabled: true },
    ])
    assert.deepEqual(enabled.sort(), ['attachments', 'profile', 'sessions'])
    const state = engine.state()
    assert.deepEqual(state.sets.find((set) => set.id === 'sessions').items, items)
    assert.deepEqual(state.sets.find((set) => set.id === 'attachments').items, [])
    assert.equal(state.sets.find((set) => set.id === 'profile').items, null)
    const saved = JSON.parse(await readFile(join(home, 'dsh-sync', 'sync-settings.json'), 'utf8'))
    assert.deepEqual(saved.sets.sessions.items, items)
    assert.deepEqual(saved.sets.attachments.items, [])
  } finally {
    await engine.stop()
  }

  const again = await createEngine(home)
  try {
    assert.deepEqual(again.state().sets.find((set) => set.id === 'sessions').items, items)
    assert.deepEqual(again.state().sets.find((set) => set.id === 'attachments').items, [])
  } finally {
    await again.stop()
  }
})

const ALL_SETS_NO_ITEMS = [
  { id: 'sessions', enabled: true },
  { id: 'workspace', enabled: true },
  { id: 'storages', enabled: true },
  { id: 'profile', enabled: true },
  { id: 'attachments', enabled: true },
  { id: 'credentials', enabled: true },
]

test('engine: per-item scope filters manifests, push, pull, preview and deletes', async () => {
  const { a, b, homeA, homeB } = await createPair()
  try {
    await writeFile(join(homeA, 'attachments', 'keep.txt'), 'keep')
    await writeFile(join(homeA, 'attachments', 'keep2.txt'), 'keep2')
    await writeFile(join(homeA, 'attachments', 'drop.txt'), 'drop')
    await a.setSets([
      { id: 'attachments', enabled: true, items: ['keep.txt', 'keep2.txt'] },
      ...ALL_SETS_NO_ITEMS.filter((set) => set.id !== 'attachments'),
    ])
    const attachmentSet = a.setById('attachments')
    assert.equal(a.itemAllowed(attachmentSet, 'keep.txt'), true)
    assert.equal(a.itemAllowed(attachmentSet, 'keep.txt/nested'), true)
    assert.equal(a.itemAllowed(attachmentSet, 'drop.txt'), false)

    // The index itself stays complete, so unselected files are not deletions.
    await a.refreshIndex()
    assert.ok(a.index.get('attachments', 'drop.txt'), 'unselected files must stay indexed')

    const client = new PeerClient({ identity: b.identity, peer: { deviceId: a.identity.deviceId, host: '127.0.0.1', port: a.port } })
    await client.hello()
    const manifest = await client.rpc('manifest', { set: 'attachments' })
    assert.deepEqual(Object.keys(manifest.entries).sort(), ['keep.txt', 'keep2.txt'])

    const pushed = await a.pushTo(b.identity.deviceId)
    assert.ok(pushed.pushed >= 2)
    assert.equal(await exists(join(homeB, 'attachments', 'keep.txt')), true)
    assert.equal(await exists(join(homeB, 'attachments', 'keep2.txt')), true)
    assert.equal(await exists(join(homeB, 'attachments', 'drop.txt')), false)

    const preview = await a.previewChanges(b.identity.deviceId)
    assert.ok(preview.files.every((file) => file.rel !== 'drop.txt'), 'preview must honour the item scope')

    // Tombstones are filtered by the same scope.
    await fs.rm(join(homeA, 'attachments', 'keep.txt'))
    await fs.rm(join(homeA, 'attachments', 'drop.txt'))
    await a.cycle('test')
    const afterDelete = await client.rpc('manifest', { set: 'attachments' })
    assert.ok(afterDelete.deletes['keep.txt'], 'selected deletions are advertised')
    assert.equal(afterDelete.deletes['drop.txt'], undefined, 'unselected deletions stay private')

    // Pull side: B only selects keep2, so a force pull must not adopt drop.txt.
    await writeFile(join(homeA, 'attachments', 'keep3.txt'), 'keep3')
    await a.setSets([{ id: 'attachments', enabled: true, items: null }, ...ALL_SETS_NO_ITEMS.filter((set) => set.id !== 'attachments')])
    await b.setSets([
      { id: 'attachments', enabled: true, items: ['keep3.txt'] },
      ...ALL_SETS_NO_ITEMS.filter((set) => set.id !== 'attachments'),
    ])
    const pullPreview = await b.previewPull(a.identity.deviceId)
    assert.ok(pullPreview.files.every((file) => file.rel === 'keep3.txt'))
    await b.forcePull(a.identity.deviceId)
    assert.equal(await exists(join(homeB, 'attachments', 'keep3.txt')), true)
    assert.equal(await exists(join(homeB, 'attachments', 'drop.txt')), false)
  } finally {
    await stopAll(a, b)
  }
})

test('engine: list-items builds a real catalog for every scoped set', async () => {
  const home = await createHome('catalog')
  await mkdir(join(home, 'sessions', 'proj-a', 's1'), { recursive: true })
  await writeFile(join(home, 'sessions', 'proj-a', 's1', 'session.v4.jsonl.zstd'), 'aaaa')
  await mkdir(join(home, 'sessions', 'proj-b', 's2'), { recursive: true })
  await writeFile(join(home, 'sessions', 'proj-b', 's2', 'session.v4.jsonl.zstd'), 'bb')
  await writeFile(join(home, 'attachments', 'one.txt'), '1')
  await writeFile(join(home, 'attachments', 'two.txt'), '22')
  await mkdir(join(home, 'profiles', 'desktop', 'plugins', 'demo'), { recursive: true })
  await writeFile(join(home, 'profiles', 'desktop', 'plugins', 'demo', 'index.js'), 'export default 1\n')
  await writeFile(join(home, 'profiles', 'desktop', 'package.json'), '{}\n')
  await mkdir(join(home, 'profiles', 'desktop', 'node_modules', 'pkg-a', 'dist'), { recursive: true })
  await writeFile(join(home, 'profiles', 'desktop', 'node_modules', 'pkg-a', 'index.js'), 'x')
  const engine = await createEngine(home)
  try {
    const sessions = await engine.listItems('sessions')
    assert.deepEqual(sessions.items.map((item) => item.id).sort(), ['proj-a/s1', 'proj-b/s2'])
    assert.ok(sessions.items.every((item) => item.files === 1))
    assert.deepEqual(sessions.items.find((item) => item.id === 'proj-a/s1').size, 4)
    assert.equal(sessions.all, true)
    assert.deepEqual(sessions.selected, [])

    const attachments = await engine.listItems('attachments')
    assert.deepEqual(attachments.items.map((item) => item.id).sort(), ['one.txt', 'two.txt'])
    assert.equal(attachments.items.find((item) => item.id === 'two.txt').size, 2)

    const profile = await engine.listItems('profile')
    assert.ok(profile.items.some((item) => item.id === 'plugins/demo'))
    assert.ok(profile.items.some((item) => item.id === 'package.json'))

    const modules = await engine.listItems('modules')
    assert.ok(modules.items.some((item) => item.id === 'node_modules/pkg-a'))

    await engine.setSets([
      { id: 'attachments', enabled: true, items: ['one.txt'] },
      ...ALL_SETS_NO_ITEMS.filter((set) => set.id !== 'attachments'),
    ])
    const scoped = await engine.listItems('attachments')
    assert.equal(scoped.all, false)
    assert.deepEqual(scoped.selected, ['one.txt'])

    // credentials never accepts per-item scope.
    const credentials = await engine.listItems('credentials')
    assert.equal(credentials.all, true)
    assert.deepEqual(credentials.items, [])

    await assert.rejects(() => engine.listItems('nope'), (error) => error.code === 'bad-value')
  } finally {
    await engine.stop()
  }
})

test('engine: local-only exclusion only limits automatic sync and explicit items override it', async () => {
  const { a, b, homeA, homeB } = await createRolePair('host', 'sub')
  try {
    await writeFile(join(homeA, 'attachments', 'unique.txt'), 'unique')
    await writeFile(join(homeA, 'attachments', 'shared.txt'), 'shared')
    await writeFile(join(homeB, 'attachments', 'shared.txt'), 'shared')
    await a.setLocalOnly(true)

    const auto = await a.pushTo(b.identity.deviceId, { automatic: true })
    assert.ok(auto.skippedUnique >= 1)
    assert.equal(await exists(join(homeB, 'attachments', 'unique.txt')), false)

    // Manual push ignores the local-only rule.
    await a.pushTo(b.identity.deviceId)
    assert.equal(await exists(join(homeB, 'attachments', 'unique.txt')), true)

    // Explicitly selected items override the automatic skip.
    await writeFile(join(homeA, 'attachments', 'chosen.txt'), 'chosen')
    await a.setSets([
      { id: 'attachments', enabled: true, items: ['chosen.txt'] },
      ...ALL_SETS_NO_ITEMS.filter((set) => set.id !== 'attachments'),
    ])
    const chosen = await a.pushTo(b.identity.deviceId, { automatic: true })
    assert.equal(chosen.skippedUnique, 0)
    assert.equal(chosen.pushed, 1)
    assert.equal(await exists(join(homeB, 'attachments', 'chosen.txt')), true)

    // Automatic pull: skip host-only files, but adopt files the sub already has.
    await a.setSets([{ id: 'attachments', enabled: true, items: null }, ...ALL_SETS_NO_ITEMS.filter((set) => set.id !== 'attachments')])
    await writeFile(join(homeA, 'attachments', 'hostonly.txt'), 'host only')
    await writeFile(join(homeB, 'attachments', 'existing.txt'), 'old')
    await writeFile(join(homeA, 'attachments', 'existing.txt'), 'new')
    await b.setLocalOnly(true)
    const pulled = await b.forcePull(a.identity.deviceId, { automatic: true })
    assert.ok(pulled.skippedUnique >= 1)
    assert.equal(await exists(join(homeB, 'attachments', 'hostonly.txt')), false)
    assert.equal(await readFile(join(homeB, 'attachments', 'existing.txt'), 'utf8'), 'new')

    // A explicitly selected item is pulled even when the sub does not have it yet.
    await writeFile(join(homeA, 'attachments', 'picked.txt'), 'picked')
    await b.setSets([
      { id: 'attachments', enabled: true, items: ['picked.txt'] },
      ...ALL_SETS_NO_ITEMS.filter((set) => set.id !== 'attachments'),
    ])
    await b.forcePull(a.identity.deviceId, { automatic: true })
    assert.equal(await exists(join(homeB, 'attachments', 'picked.txt')), true)
    assert.equal(await exists(join(homeB, 'attachments', 'hostonly.txt')), false)
  } finally {
    await stopAll(a, b)
  }
})

test('engine: realtime automatic cycles follow the role direction', async () => {
  const { a, b, homeA, homeB } = await createRolePair('host', 'sub')
  try {
    await a.setRealtime(true)
    await b.setRealtime(true)
    await writeFile(join(homeA, 'attachments', 'push-me.txt'), 'from host')
    const pushed = await a.cycle('interval')
    assert.equal(pushed.direction, 'push')
    assert.ok(pushed.pushed >= 1)
    assert.equal(await readFile(join(homeB, 'attachments', 'push-me.txt'), 'utf8'), 'from host')
    assert.equal(a.state().lastCycle.direction, 'push')
    assert.equal(a.state().lastCycle.skippedUnique, 0)

    // The host's automatic push must not pull a sub-only file back.
    await writeFile(join(homeB, 'attachments', 'sub-only.txt'), 'from sub')
    await a.cycle('interval')
    assert.equal(await exists(join(homeA, 'attachments', 'sub-only.txt')), false)

    // A sub's automatic cycle pulls from its host instead of running the mesh.
    await writeFile(join(homeA, 'attachments', 'pull-me.txt'), 'from host 2')
    const pulled = await b.cycle('interval')
    assert.equal(pulled.direction, 'pull')
    assert.ok(pulled.pulled >= 1)
    assert.equal(await readFile(join(homeB, 'attachments', 'pull-me.txt'), 'utf8'), 'from host 2')
  } finally {
    await stopAll(a, b)
  }
})

test('engine: cleanup removes expired .bak-sync-* backups by backupDays and backups flag', async () => {
  const home = await createHome('backup-clean')
  const engine = await createEngine(home)
  try {
    const past = new Date(Date.now() - 60 * 86_400_000)
    const oldBackup = join(home, 'attachments', 'note.txt.bak-sync-p1-1700000000000')
    const freshBackup = join(home, 'attachments', 'note2.txt.bak-sync-p1-1700000000001')
    await writeFile(oldBackup, 'old backup bytes')
    await writeFile(freshBackup, 'fresh backup')
    await fs.utimes(oldBackup, past, past)
    // Non-engine names may never be treated as backups.
    const lookalike = join(home, 'attachments', 'notes.bak-sync-old')
    const conflictLookalike = join(home, 'attachments', 'my.conflict-notes')
    await writeFile(lookalike, 'user file')
    await writeFile(conflictLookalike, 'user file 2')
    await fs.utimes(lookalike, past, past)
    await fs.utimes(conflictLookalike, past, past)
    // A home-root backup belongs to the credentials set (skipped on purpose).
    const homeBackup = join(home, 'x.bak-sync-20260101-120000')
    await writeFile(homeBackup, 'credentials backup')
    await fs.utimes(homeBackup, past, past)

    const result = await engine.cleanupNow()
    assert.ok(result.removed >= 1)
    assert.equal(await exists(oldBackup), false)
    assert.equal(await exists(freshBackup), true)
    assert.equal(await exists(lookalike), true, 'non-matching names must never be deleted')
    assert.equal(await exists(conflictLookalike), true, 'a partial .conflict- name is not a parked copy')
    assert.equal(await exists(homeBackup), true, 'credentials ($DSH_HOME) backups are out of scope')
    assert.ok(await exists(join(home, 'dsh-sync', 'recycle')))

    // backups=false disables the backup pass entirely.
    const old2 = join(home, 'attachments', 'note3.txt.bak-sync-p1-1700000000003')
    await writeFile(old2, 'old backup 2')
    await fs.utimes(old2, past, past)
    await engine.setCleanup({ backups: false })
    await engine.cleanupNow()
    assert.equal(await exists(old2), true)

    // backupDays=1 removes anything older than one day.
    await engine.setCleanup({ backups: true, backupDays: 1 })
    const old3 = join(home, 'attachments', 'note4.txt.bak-sync-deleted-p1-1700000000004')
    await writeFile(old3, 'two days old')
    const twoDays = new Date(Date.now() - 2 * 86_400_000)
    await fs.utimes(old3, twoDays, twoDays)
    await engine.cleanupNow()
    assert.equal(await exists(old3), false)
  } finally {
    await engine.stop()
  }
})

async function exists(path) {
  try {
    await fs.access(path)
    return true
  } catch {
    return false
  }
}
