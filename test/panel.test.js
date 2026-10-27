import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Identity } from '../src/identity.js'
import { SyncEngine } from '../src/engine.js'
import { registerPanel } from '../src/panel.js'

async function makeHome(label = '') {
  const home = await mkdtemp(join(tmpdir(), `dsh-sync-panel-${label}`))
  for (const dir of ['sessions', 'storages', 'profiles/desktop', 'attachments', 'cache']) await mkdir(join(home, dir), { recursive: true })
  return home
}

function newEngine(home, config = {}) {
  const stateDir = join(home, 'dsh-sync')
  const identity = new Identity({ stateDir }).load()
  return identity.then((loaded) => new SyncEngine({
    home,
    profile: 'desktop',
    stateDir,
    identity: loaded,
    config: { discovery: false, autoCycle: false, stableAfterMs: 0, keepBackups: false, repairProfile: false, ...config },
  }))
}

async function makeEngine() {
  return newEngine(await makeHome())
}

async function bootEngine(home) {
  const engine = await newEngine(home)
  await engine.start()
  return engine
}

function mockResponse() {
  const res = {
    status: 0,
    headers: {},
    body: '',
    writeHead(status, headers) { this.status = status; this.headers = headers },
    end(body) { this.body = String(body) },
  }
  return res
}

function mockRequest(body) {
  const listeners = new Map()
  const req = {
    method: 'POST',
    headers: {},
    socket: { remoteAddress: '127.0.0.1' },
    on(event, fn) {
      const list = listeners.get(event) || []
      list.push(fn)
      listeners.set(event, list)
      return req
    },
    destroy() {},
  }
  setImmediate(() => {
    if (body !== undefined) {
      const chunk = Buffer.from(JSON.stringify(body))
      for (const fn of listeners.get('data') || []) fn(chunk)
    }
    for (const fn of listeners.get('end') || []) fn()
  })
  return req
}

function registerRoute(engine) {
  let route = null
  const ctx = {
    inject: (deps, callback) => {
      if (deps.includes('webServer')) {
        callback({ get: () => ({ register: (value) => { route = value; return () => {} } }), effect: (fn) => fn() })
      }
    },
  }
  const dispose = registerPanel(ctx, { getEngine: () => engine })
  return { route, dispose }
}

async function exists(path) {
  try {
    await readFile(path)
    return true
  } catch {
    return false
  }
}

async function call(route, payload, method = 'POST') {
  const res = mockResponse()
  const req = method === 'GET'
    ? { method, url: route.path, headers: {}, socket: { remoteAddress: '127.0.0.1' } }
    : mockRequest(payload)
  await route.handler(req, res)
  return { status: res.status, value: JSON.parse(res.body) }
}

test('panel: registers a prefix route and serves state over loopback', async () => {
  const engine = await makeEngine()
  let route = null
  const ctx = {
    inject: (deps, callback) => {
      if (deps.includes('webServer')) {
        callback({ get: () => ({ register: (value) => { route = value; return () => {} } }), effect: (fn) => fn() })
      }
    },
  }
  const dispose = registerPanel(ctx, { getEngine: () => engine })
  assert.ok(route, 'route must be registered')
  assert.equal(route.kind, 'prefix')
  assert.match(route.path, /^\/plugins\/dsh-plugin-dsh-sync\/panel$/)

  const res = mockResponse()
  await route.handler({ method: 'GET', url: route.path, headers: {}, socket: { remoteAddress: '127.0.0.1' } }, res)
  assert.equal(res.status, 200)
  const value = JSON.parse(res.body)
  assert.equal(value.ok, true)
  assert.equal(value.state.device.deviceId, engine.identity.deviceId)
  assert.ok(Array.isArray(value.state.sets))
  assert.ok(value.state.sets.some((set) => set.id === 'sessions'))

  const denied = mockResponse()
  await route.handler({ method: 'GET', url: route.path, headers: {}, socket: { remoteAddress: '10.0.0.9' } }, denied)
  assert.equal(denied.status, 403)

  dispose()
})

test('panel: exposes sync settings and validates role/cleanup/shadow actions', async () => {
  const engine = await makeEngine()
  const { route, dispose } = registerRoute(engine)
  try {
    const initial = await call(route, null, 'GET')
    assert.equal(initial.status, 200)
    const state = initial.value.state
    assert.equal(state.settings.role, 'host')
    assert.equal(state.settings.roleLocked, false)
    assert.equal(state.settings.realtime, false)
    assert.deepEqual(state.settings.shadowWorkspace, { enabled: false })
    assert.equal(state.immediate, 'push')
    assert.deepEqual(state.cleanupStats, { conflictCount: 0, conflictBytes: 0, recycleCount: 0 })
    assert.equal(state.changesPreview, null)

    const role = await call(route, { action: 'set-role', role: 'sub' })
    assert.equal(role.status, 200)
    assert.equal(role.value.state.settings.role, 'sub')
    assert.equal(role.value.state.immediate, 'pull')

    const badRole = await call(route, { action: 'set-role', role: 'peer' })
    assert.equal(badRole.status, 400)
    assert.equal(badRole.value.error.code, 'bad-value')

    const realtime = await call(route, { action: 'set-realtime', enabled: true })
    assert.equal(realtime.value.state.settings.realtime, true)

    const shadow = await call(route, { action: 'set-shadow', enabled: true })
    assert.equal(shadow.status, 200)
    assert.deepEqual(shadow.value.state.settings.shadowWorkspace, { enabled: true })
    const shadowOff = await call(route, { action: 'set-shadow', enabled: false })
    assert.deepEqual(shadowOff.value.state.settings.shadowWorkspace, { enabled: false })

    const localOnly = await call(route, { action: 'set-local-only', enabled: true })
    assert.equal(localOnly.value.state.settings.localOnlyExcluded, true)

    const badRetention = await call(route, { action: 'set-cleanup', patch: { retentionDays: 5 } })
    assert.equal(badRetention.status, 400)
    assert.equal(badRetention.value.error.code, 'bad-value')
    const badRecycle = await call(route, { action: 'set-cleanup', patch: { recycleMax: 1001 } })
    assert.equal(badRecycle.status, 400)
    const badBackup = await call(route, { action: 'set-cleanup', patch: { backupDays: 0 } })
    assert.equal(badBackup.status, 400)

    const cleanup = await call(route, { action: 'set-cleanup', patch: { retentionDays: 90, recycleMax: 800, backupDays: 30, recycle: false } })
    assert.equal(cleanup.status, 200)
    assert.equal(cleanup.value.state.settings.cleanup.retentionDays, 90)
    assert.equal(cleanup.value.state.settings.cleanup.recycleMax, 800)
    assert.equal(cleanup.value.state.settings.cleanup.backupDays, 30)
    assert.equal(cleanup.value.state.settings.cleanup.recycle, false)

    const unknown = await call(route, { action: 'does-not-exist' })
    assert.equal(unknown.status, 400)
    assert.equal(unknown.value.error.code, 'unknown-action')
  } finally {
    dispose()
  }
})

test('panel: cleanup-now and conflict actions honour keep and remove parked copies', async () => {
  const engine = await makeEngine()
  const { route, dispose } = registerRoute(engine)
  try {
    const conflictsDir = join(engine.stateDir, 'conflicts')
    await mkdir(conflictsDir, { recursive: true })
    const parked = join(conflictsDir, 'note.conflict-p1.txt')
    await writeFile(parked, 'parked bytes')
    await engine.addConflict({
      kind: 'test',
      set: 'attachments',
      rel: 'note.txt',
      peer: 'p1',
      hash: 'h1',
      file: parked,
      at: new Date(Date.now() - 10 * 86_400_000).toISOString(),
    })
    const id = engine.conflicts[0].id

    const kept = await call(route, { action: 'conflict-keep', ids: [id], keep: true })
    assert.equal(kept.status, 200)
    assert.equal(kept.value.state.conflicts[0].keep, true)

    const cleanup = await call(route, { action: 'cleanup-now' })
    assert.equal(cleanup.status, 200)
    assert.equal(cleanup.value.removed, 0)
    assert.equal(cleanup.value.state.cleanupStats.conflictCount, 1)

    await call(route, { action: 'conflict-keep', ids: [id], keep: false })
    const deleted = await call(route, { action: 'conflict-delete', ids: [id] })
    assert.equal(deleted.status, 200)
    assert.equal(deleted.value.removed, 1)
    assert.equal(deleted.value.state.cleanupStats.conflictCount, 0)
    assert.equal(await exists(parked), false)
    assert.equal(deleted.value.state.cleanupStats.recycleCount, 1)
  } finally {
    dispose()
  }
})

test('panel: locked role returns 409 and preview/immediate sync follow the role', async () => {
  const homeA = await makeHome('host')
  const homeB = await makeHome('sub')
  const a = await bootEngine(homeA)
  const b = await bootEngine(homeB)
  const { route, dispose } = registerRoute(a)
  try {
    await a.setRole('host')
    await b.setRole('sub')
    a.discovery.addPeer({ deviceId: b.identity.deviceId, host: '127.0.0.1', port: b.port, name: 'PC-B' })
    b.discovery.addPeer({ deviceId: a.identity.deviceId, host: '127.0.0.1', port: a.port, name: 'PC-A' })
    await a.pairStart(b.identity.deviceId)
    await b.pairStart(a.identity.deviceId)
    await a.pairConfirm(b.identity.deviceId)
    await b.pairConfirm(a.identity.deviceId)

    const locked = await call(route, { action: 'set-role', role: 'sub' })
    assert.equal(locked.status, 409)
    assert.equal(locked.value.error.code, 'role-locked')

    await writeFile(join(homeA, 'attachments', 'panel.txt'), 'panel push')
    const preview = await call(route, { action: 'preview-push', deviceId: b.identity.deviceId })
    assert.equal(preview.status, 200)
    assert.equal(preview.value.count, 1)
    assert.equal(preview.value.files[0].rel, 'panel.txt')

    const immediatePreview = await call(route, { action: 'preview-immediate' })
    assert.equal(immediatePreview.value.direction, 'push')
    assert.equal(immediatePreview.value.count, 1)

    const pullPreview = await call(route, { action: 'preview-pull', deviceId: b.identity.deviceId })
    assert.equal(pullPreview.status, 200)
    assert.equal(pullPreview.value.count, 0)
    // A sub-only file would be adopted by "覆盖本地".
    await writeFile(join(homeB, 'attachments', 'sub-only.txt'), 'from sub')
    const pullChanges = await call(route, { action: 'preview-pull', deviceId: b.identity.deviceId })
    assert.equal(pullChanges.status, 200)
    assert.equal(pullChanges.value.count, 1)
    assert.equal(pullChanges.value.files[0].rel, 'sub-only.txt')

    const offline = await call(route, { action: 'preview-pull', deviceId: 'missing-device' })
    assert.equal(offline.status, 409)
    assert.equal(offline.value.error.code, 'not-ready')

    const synced = await call(route, { action: 'immediate-sync' })
    assert.equal(synced.status, 200)
    assert.equal(synced.value.direction, 'push')
    assert.equal(synced.value.results.length, 1)
    assert.ok(synced.value.results[0].result.pushed >= 1)
    assert.equal(await readFile(join(homeB, 'attachments', 'panel.txt'), 'utf8'), 'panel push')
  } finally {
    dispose()
    await a.stop()
    await b.stop()
  }
})

test('panel: list-items returns the real catalog and validates the set id', async () => {
  const home = await makeHome('catalog')
  await mkdir(join(home, 'sessions', 'proj-a', 's1'), { recursive: true })
  await writeFile(join(home, 'sessions', 'proj-a', 's1', 'session.v4.jsonl.zstd'), 'abc')
  await writeFile(join(home, 'attachments', 'a.txt'), 'aa')
  const engine = await newEngine(home)
  const { route, dispose } = registerRoute(engine)
  try {
    const sessions = await call(route, { action: 'list-items', setId: 'sessions' })
    assert.equal(sessions.status, 200)
    assert.deepEqual(sessions.value.items.map((item) => item.id), ['proj-a/s1'])
    assert.equal(sessions.value.items[0].size, 3)
    assert.equal(sessions.value.all, true)
    assert.deepEqual(sessions.value.selected, [])

    const attachments = await call(route, { action: 'list-items', setId: 'attachments' })
    assert.deepEqual(attachments.value.items.map((item) => item.id), ['a.txt'])

    const bad = await call(route, { action: 'list-items', setId: 'nope' })
    assert.equal(bad.status, 400)
    assert.equal(bad.value.error.code, 'bad-value')
  } finally {
    dispose()
  }
})

test('panel: cleanup-now reports backup removals and still returns skipped', async () => {
  const home = await makeHome('cleanup-backup')
  const engine = await newEngine(home)
  const { route, dispose } = registerRoute(engine)
  try {
    const backup = join(home, 'attachments', 'note.txt.bak-sync-p1-1700000000000')
    await writeFile(backup, 'old backup')
    const past = new Date(Date.now() - 60 * 86_400_000)
    await fs.utimes(backup, past, past)
    await engine.setCleanup({ backupDays: 7 })
    const result = await call(route, { action: 'cleanup-now' })
    assert.equal(result.status, 200)
    assert.ok(result.value.removed >= 1)
    assert.equal(result.value.skipped, 0)
    assert.equal(await exists(backup), false)
  } finally {
    dispose()
  }
})

test('panel: preview-pull reports an offline peer with a coded error', async () => {
  const engine = await makeEngine()
  const { route, dispose } = registerRoute(engine)
  try {
    const result = await call(route, { action: 'preview-pull', deviceId: 'offline-device' })
    assert.equal(result.status, 409)
    assert.equal(result.value.error.code, 'not-ready')
  } finally {
    dispose()
  }
})


