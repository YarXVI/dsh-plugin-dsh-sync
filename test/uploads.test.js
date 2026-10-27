// Chunked file transfer receiver (0.9.0): name sanitization, size limit,
// sha256 verification, disabled-by-default gate and the full
// `ext.shadow.push-file` begin/chunk/commit path over a fake broker.
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { ShadowHostBridge } from '../shadow/src/session-bridge.js'
import { ShadowClientProxy } from '../shadow/src/b-proxy.js'
import { ShadowStateStore } from '../shadow/src/state.js'
import {
  UploadReceiver,
  decodeUploadChunk,
  sanitizeUploadName,
  sha256Of,
  uniqueUploadName,
} from '../shadow/src/uploads.js'
import { runDataAction } from '../shadow/src/local-route.js'

const PEER = { deviceId: 'peer-device-1', name: 'PC-B' }
const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex')

async function makeHome(label) {
  const home = await mkdtemp(join(tmpdir(), `dsh-upload-${label}-`))
  for (const dir of ['sessions', 'storages', 'profiles/desktop', 'attachments', 'cache']) {
    await mkdir(join(home, dir), { recursive: true })
  }
  return home
}

/** Record every log call so tests can assert the debug.log lines. */
function makeLog() {
  const rows = []
  const logger = {
    rows,
    info: (...args) => rows.push({ level: 'info', text: args.join(' ') }),
    warn: (...args) => rows.push({ level: 'warn', text: args.join(' ') }),
    error: (...args) => rows.push({ level: 'error', text: args.join(' ') }),
    debug: (...args) => rows.push({ level: 'debug', text: args.join(' ') }),
  }
  logger.child = () => logger
  return logger
}

/**
 * Build one Host bridge on a temp home. The uploads dir is the real layout
 * (`<home>/shadow-uploads`); `config.uploads` drives the opt-in gate.
 */
async function makeBridge(home, { config = {}, state = null, log = null } = {}) {
  const handlers = new Map()
  const ctx = {
    get: () => undefined,
    on(name, handler) { handlers.set(name, handler); return () => handlers.delete(name) },
  }
  const store = state || new ShadowStateStore({ dir: join(home, 'shadow-workspace') })
  const auditRows = []
  const bridge = new ShadowHostBridge({
    ctx,
    state: store,
    store: join(home, 'shadow-workspace', 'sessions.json'),
    uploadsDir: join(home, 'shadow-uploads'),
    config,
    log: log || null,
    audit: { record: (row) => auditRows.push(row), last: (count) => auditRows.slice(-count) },
  })
  bridge.start()
  const sync = {
    identity: () => ({ deviceId: 'device-a', name: 'PC-A' }),
    peers: () => [{ ...PEER, online: true, trusted: true }],
    rpc: async (_deviceId, op, payload) => bridge.handleRpc(op, payload, PEER),
  }
  bridge.attachSync(sync)
  return { bridge, state: store, sync, auditRows, handlers }
}

/** Display-side proxy sharing the same state store + fake broker. */
function makeProxy(bridge, state, config = {}) {
  state.setDisplay(true)
  state.setPeer(PEER.deviceId, PEER.name)
  const sync = {
    peers: () => [{ ...PEER, online: true, trusted: true }],
    rpc: async (_deviceId, op, payload) => bridge.handleRpc(op, payload, PEER),
  }
  return new ShadowClientProxy({ sync, state, config })
}

/** Push one buffer through `ext.shadow.push-file` begin/chunk/commit. */
async function pushThroughBridge(bridge, payload, name, transferId, chunkBytes = 1024) {
  const hash = sha256(payload)
  await bridge.handleRpc('ext.shadow.push-file', { action: 'begin', transferId, name, size: payload.length, sha256: hash }, PEER)
  const chunks = []
  for (let offset = 0; offset < payload.length; offset += chunkBytes) {
    chunks.push(payload.subarray(offset, Math.min(payload.length, offset + chunkBytes)))
  }
  for (let index = 0; index < chunks.length; index += 1) {
    const result = await bridge.handleRpc('ext.shadow.push-file', {
      action: 'chunk', transferId, index, data: chunks[index].toString('base64'),
    }, PEER)
    assert.equal(result.receivedBytes, Math.min(payload.length, (index + 1) * chunkBytes))
  }
  return await bridge.handleRpc('ext.shadow.push-file', { action: 'commit', transferId, sha256: hash }, PEER)
}

// ---------------------------------------------------------------------------
// Name sanitization
// ---------------------------------------------------------------------------

test('uploads: names become one Windows-safe segment and traversal is rejected', () => {
  assert.equal(sanitizeUploadName('dsh-plugin-dsh-sync-0.9.0.zip'), 'dsh-plugin-dsh-sync-0.9.0.zip')
  assert.equal(sanitizeUploadName('  report .txt  '), 'report .txt')
  assert.equal(sanitizeUploadName('bad:name?.txt'), 'bad_name_.txt')
  assert.equal(sanitizeUploadName('CON.txt'), '_CON.txt')
  assert.equal(sanitizeUploadName('lpt9'), '_lpt9')
  // Traversal / path forms are hard errors, not silent rewrites.
  for (const name of ['../../etc/passwd', '..\\evil.txt', 'dir/file.txt', 'C:\\Windows\\x.txt', '..', '.']) {
    assert.throws(
      () => sanitizeUploadName(name),
      (error) => error.code === 'shadow/bad-request',
      `must reject ${name}`,
    )
  }
  assert.throws(() => sanitizeUploadName('a\u0000b.txt'), (error) => error.code === 'shadow/bad-request')
  assert.throws(() => sanitizeUploadName('   '), (error) => error.code === 'shadow/bad-request')
  const long = sanitizeUploadName(`${'x'.repeat(400)}.txt`)
  assert.ok(long.length <= 180, `name must be truncated, got ${long.length}`)
  assert.ok(long.endsWith('.txt'), 'the extension survives truncation')
  // Unique naming never overwrites an existing file.
  const dir = join(tmpdir(), `dsh-upload-names-${process.pid}-${Date.now()}`)
  return (async () => {
    try {
      await mkdir(dir, { recursive: true })
      assert.equal(uniqueUploadName(dir, 'same.txt'), 'same.txt')
      await writeFile(join(dir, 'same.txt'), 'one')
      assert.equal(uniqueUploadName(dir, 'same.txt'), 'same (1).txt')
      await writeFile(join(dir, 'same (1).txt'), 'two')
      assert.equal(uniqueUploadName(dir, 'same.txt'), 'same (2).txt')
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  })()
})

test('uploads: base64 chunk decoding is strict', () => {
  assert.deepEqual(decodeUploadChunk(Buffer.from('hello').toString('base64')), Buffer.from('hello'))
  for (const bad of ['', 'abc', '!!!!', Buffer.from('hi').toString('base64') + '=']) {
    assert.throws(() => decodeUploadChunk(bad), (error) => error.code === 'shadow/bad-request', `must reject ${JSON.stringify(bad)}`)
  }
})

// ---------------------------------------------------------------------------
// Receiver limits: size + sha256
// ---------------------------------------------------------------------------

test('uploads: receiver enforces the 64 MB default cap and the declared size', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-upload-limits-'))
  const audits = []
  const receiver = new UploadReceiver({ dir, audit: (row) => audits.push(row) })
  try {
    const big = Buffer.alloc(1024)
    assert.throws(
      () => receiver.begin({ transferId: 't-big', name: 'big.bin', size: 64 * 1024 * 1024 + 1, sha256: sha256(big), peer: PEER }),
      (error) => error.code === 'shadow/payload-too-large',
    )
    receiver.begin({ transferId: 't-small', name: 'small.txt', size: 4, sha256: sha256(Buffer.from('abcd')), peer: PEER })
    assert.throws(
      () => receiver.chunk({ transferId: 't-small', index: 0, data: Buffer.from('abcdef').toString('base64'), peer: PEER }),
      (error) => error.code === 'shadow/payload-too-large',
      'a chunk may never exceed the declared size',
    )
    assert.throws(
      () => receiver.chunk({ transferId: 't-small', index: 2, data: Buffer.from('ab').toString('base64'), peer: PEER }),
      (error) => error.code === 'shadow/bad-request',
      'chunks must arrive in order',
    )
    assert.ok(audits.some((row) => row.action === 'begin' && row.ok === false))
    assert.equal(existsSync(join(dir, 'small.txt')), false)
  } finally {
    receiver.dispose()
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

test('uploads: a sha256 mismatch at commit drops the transfer and publishes nothing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-upload-hash-'))
  const audits = []
  const receiver = new UploadReceiver({ dir, audit: (row) => audits.push(row) })
  try {
    const good = Buffer.from('the expected bytes')
    const tampered = Buffer.from('the expected bytez')
    receiver.begin({ transferId: 't-hash', name: 'evil.txt', size: good.length, sha256: sha256(good), peer: PEER })
    receiver.chunk({ transferId: 't-hash', index: 0, data: tampered.toString('base64'), peer: PEER })
    assert.throws(
      () => receiver.commit({ transferId: 't-hash', sha256: sha256(good), peer: PEER }),
      (error) => error.code === 'shadow/upload-hash-mismatch',
    )
    assert.equal(existsSync(join(dir, 'evil.txt')), false, 'nothing is published on mismatch')
    assert.equal(receiver.transfers.size, 0, 'the transfer is dropped')
    assert.equal((await readdir(dir)).filter((name) => name.includes('.part')).length, 0, 'no temp file is left')
    assert.ok(audits.some((row) => row.action === 'commit' && row.ok === false && row.code === 'shadow/upload-hash-mismatch'))
  } finally {
    receiver.dispose()
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

// ---------------------------------------------------------------------------
// Disabled by default + explicit grants
// ---------------------------------------------------------------------------

test('uploads: ext.shadow.push-file is disabled by default and needs an explicit opt-in', async () => {
  const home = await makeHome('default')
  const log = makeLog()
  const { bridge, state, auditRows } = await makeBridge(home, { log })
  try {
    const begin = {
      action: 'begin',
      transferId: 'shadow-upload-default-1',
      name: 'a.txt',
      size: 5,
      sha256: sha256(Buffer.from('hello')),
    }
    await assert.rejects(
      () => bridge.handleRpc('ext.shadow.push-file', begin, PEER),
      (error) => error.code === 'shadow/uploads-disabled',
    )
    assert.equal(existsSync(join(home, 'shadow-uploads')), false, 'nothing is created while disabled')
    assert.equal((await bridge.handleRpc('ext.shadow.info', {}, PEER)).uploads.enabled, false)

    // Audit records the refusal (name/peer/ok, no content).
    assert.ok(auditRows.some((row) => (
      row.op === 'ext.shadow.push-file'
      && row.action === 'begin'
      && row.ok === false
      && row.code === 'shadow/uploads-disabled'
      && row.peer === PEER.deviceId
      && row.name === 'a.txt'
    )))
    assert.ok(log.rows.some((row) => /push-file rejected: uploads disabled/.test(row.text)))

    // Explicit per-peer grant (state.json) is enough while the global switch is off.
    state.grantUploadPeer(PEER.deviceId)
    assert.equal((await bridge.handleRpc('ext.shadow.info', {}, PEER)).uploads.enabled, true)
    const begun = await bridge.handleRpc('ext.shadow.push-file', begin, PEER)
    assert.equal(begun.ok, true)
    assert.equal(begun.name, 'a.txt')
    await bridge.handleRpc('ext.shadow.push-file', { action: 'abort', transferId: begin.transferId }, PEER)

    // Revoking the grant disables it again.
    state.revokeUploadPeer(PEER.deviceId)
    await assert.rejects(
      () => bridge.handleRpc('ext.shadow.push-file', { ...begin, transferId: 'shadow-upload-default-2' }, PEER),
      (error) => error.code === 'shadow/uploads-disabled',
    )
  } finally {
    bridge.dispose()
    await rm(home, { recursive: true, force: true }).catch(() => {})
  }
})

// ---------------------------------------------------------------------------
// Successful begin/chunk/commit over the fake broker
// ---------------------------------------------------------------------------

test('uploads: begin/chunk/commit stores the file, reports {size,sha256} and audits', async () => {
  const home = await makeHome('success')
  const log = makeLog()
  const { bridge, auditRows } = await makeBridge(home, {
    config: { uploads: { enabled: true, maxBytes: 8 * 1024 * 1024, chunkBytes: 16 * 1024 } },
    log,
  })
  try {
    const payload = Buffer.from('dsh-sync 0.9.0 file push payload\n'.repeat(200))
    const info = await bridge.handleRpc('ext.shadow.info', {}, PEER)
    assert.equal(info.uploads.enabled, true)
    assert.ok(info.uploads.maxBytes >= payload.length)
    assert.ok(info.uploads.chunkBytes > 0)

    const committed = await pushThroughBridge(bridge, payload, 'payload.txt', 'shadow-upload-ok-1')
    assert.equal(committed.ok, true)
    assert.equal(committed.name, 'payload.txt')
    assert.equal(committed.size, payload.length)
    assert.equal(committed.sha256, sha256(payload))
    assert.equal(await readFile(join(home, 'shadow-uploads', 'payload.txt'), 'utf8'), payload.toString())

    // Same name again: the receiver never overwrites, it suffixes.
    const again = await pushThroughBridge(bridge, payload, 'payload.txt', 'shadow-upload-ok-2')
    assert.equal(again.name, 'payload (1).txt')
    assert.equal(existsSync(join(home, 'shadow-uploads', 'payload (1).txt')), true)

    // Audit: name/bytes/peer/ok only; no file contents in any row.
    const beginRow = auditRows.find((row) => row.op === 'ext.shadow.push-file' && row.action === 'begin' && row.ok === true)
    assert.ok(beginRow, 'begin audit row')
    assert.equal(beginRow.name, 'payload.txt')
    assert.equal(beginRow.peer, PEER.deviceId)
    const commitRow = auditRows.find((row) => row.op === 'ext.shadow.push-file' && row.action === 'commit' && row.ok === true)
    assert.ok(commitRow, 'commit audit row')
    assert.equal(commitRow.bytes, payload.length)
    assert.equal(commitRow.peer, PEER.deviceId)
    assert.equal(commitRow.sha256, undefined, 'audit rows never carry file contents')
    assert.ok(!JSON.stringify(auditRows).includes(payload.toString().slice(0, 40)), 'no content in the audit log')

    // shadow debug.log lines cover the transfer without content.
    assert.ok(log.rows.some((row) => row.level === 'info' && /push-file begin/.test(row.text)))
    assert.ok(log.rows.some((row) => row.level === 'info' && /push-file commit/.test(row.text)))
    assert.ok(!log.rows.some((row) => row.text.includes(payload.toString().slice(0, 40))), 'no content in debug lines')
  } finally {
    bridge.dispose()
    await rm(home, { recursive: true, force: true }).catch(() => {})
  }
})

test('uploads: local data route uploads-enable + push-file reach the peer receiver', async () => {
  const home = await makeHome('route')
  const state = new ShadowStateStore({ dir: join(home, 'shadow-workspace') })
  // Real plugin wiring: bridge and proxy share ONE state store.
  const { bridge } = await makeBridge(home, {
    state,
    config: { uploads: { enabled: false, maxBytes: 4 * 1024 * 1024, chunkBytes: 1024 } },
  })
  const proxy = makeProxy(bridge, state, { uploads: { enabled: false, maxBytes: 4 * 1024 * 1024, chunkBytes: 1024 } })
  try {
    // Off by default even through the data route.
    assert.equal((await runDataAction({ proxy, action: 'state', body: {} })).uploads.enabled, false)

    const enabled = await runDataAction({ proxy, action: 'uploads-enable', body: { enabled: true } })
    assert.equal(enabled.uploads.enabled, true)
    assert.equal(state.uploadsEnabled, true, 'the switch is persisted in state.json')

    const payload = Buffer.from('route push works for 0.9.0')
    const hash = sha256(payload)
    const transferId = 'shadow-upload-route-1'
    const begin = await runDataAction({ proxy, action: 'push-file', body: { action: 'begin', transferId, name: 'route.txt', size: payload.length, sha256: hash } })
    assert.equal(begin.push.name, 'route.txt')
    await runDataAction({ proxy, action: 'push-file', body: { action: 'chunk', transferId, index: 0, data: payload.toString('base64') } })
    const committed = await runDataAction({ proxy, action: 'push-file', body: { action: 'commit', transferId, sha256: hash } })
    assert.equal(committed.push.size, payload.length)
    assert.equal(committed.push.sha256, hash)
    assert.equal(await readFile(join(home, 'shadow-uploads', 'route.txt'), 'utf8'), payload.toString())

    // The panel view advertises the local switch plus the peer's readiness
    // (refresh past the 1.5 s info cache, as the panel's poll does).
    await proxy.refreshInfo(true)
    const view = await runDataAction({ proxy, action: 'state', body: {} })
    assert.equal(view.uploads.enabled, true)
    assert.equal(view.uploads.peer.enabled, true)
    assert.ok(view.uploads.chunkBytes > 0)

    // Disabling again stops the peer immediately.
    await runDataAction({ proxy, action: 'uploads-enable', body: { enabled: false } })
    await assert.rejects(
      () => runDataAction({ proxy, action: 'push-file', body: { action: 'begin', transferId: 'shadow-upload-route-2', name: 'x.txt', size: 0, sha256: sha256(Buffer.alloc(0)) } }),
      (error) => error.code === 'shadow/uploads-disabled',
    )
  } finally {
    proxy.dispose()
    bridge.dispose()
    await rm(home, { recursive: true, force: true }).catch(() => {})
  }
})

test('uploads: sha256 mismatch over the fake broker surfaces the coded error', async () => {
  const home = await makeHome('mismatch')
  const { bridge } = await makeBridge(home, {
    config: { uploads: { enabled: true, maxBytes: 1024 * 1024, chunkBytes: 1024 } },
  })
  try {
    const declared = Buffer.from('declared-payload')
    const actual = Buffer.from('tampered-payload')
    const transferId = 'shadow-upload-bad-1'
    await bridge.handleRpc('ext.shadow.push-file', {
      action: 'begin', transferId, name: 'tampered.bin', size: declared.length, sha256: sha256(declared),
    }, PEER)
    await bridge.handleRpc('ext.shadow.push-file', { action: 'chunk', transferId, index: 0, data: actual.toString('base64') }, PEER)
    await assert.rejects(
      () => bridge.handleRpc('ext.shadow.push-file', { action: 'commit', transferId, sha256: sha256(declared) }, PEER),
      (error) => error.code === 'shadow/upload-hash-mismatch',
    )
    assert.equal(existsSync(join(home, 'shadow-uploads', 'tampered.bin')), false)
    assert.equal((await readdir(join(home, 'shadow-uploads'))).filter((name) => name.includes('.part')).length, 0)
  } finally {
    bridge.dispose()
    await rm(home, { recursive: true, force: true }).catch(() => {})
  }
})

test('uploads: receiver sweeps expired transfers and dispose removes temp files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-upload-ttl-'))
  let now = 1_000
  const receiver = new UploadReceiver({ dir, ttlMs: 1_000, now: () => now })
  try {
    receiver.begin({ transferId: 't-ttl', name: 'slow.bin', size: 10, sha256: sha256(Buffer.alloc(10)), peer: PEER })
    assert.equal(receiver.transfers.size, 1)
    now += 5_000
    receiver.begin({ transferId: 't-ttl-2', name: 'other.bin', size: 10, sha256: sha256(Buffer.alloc(10)), peer: PEER })
    assert.equal(receiver.transfers.has('t-ttl'), false, 'expired transfer is dropped')
    receiver.dispose()
    assert.equal(receiver.transfers.size, 0)
    assert.equal((await readdir(dir)).filter((name) => name.includes('.part')).length, 0)
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

test('uploads: sha256Of matches node crypto for empty and non-empty buffers', () => {
  assert.equal(sha256Of(Buffer.alloc(0)), sha256(Buffer.alloc(0)))
  assert.equal(sha256Of(Buffer.from('abc')), sha256(Buffer.from('abc')))
})
