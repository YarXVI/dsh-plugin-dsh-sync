import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { mkdtemp, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Identity } from '../src/identity.js'
import { SyncEngine } from '../src/engine.js'
import { PeerClient } from '../src/transport.js'
import { DEFAULT_EXT_TIMEOUT_MS, EXT_OP_PATTERN, SERVICE_NAME, createSyncService, isExtOp } from '../src/broker.js'

async function createHome(label) {
  const home = await mkdtemp(join(tmpdir(), `dsh-sync-broker-${label}-`))
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
    config: { discovery: false, autoCycle: false, stableAfterMs: 0, keepBackups: false, ...extra },
  })
  await engine.start()
  const broker = createSyncService({ getEngine: () => engine, config: engine.config })
  const unhook = engine.setExtRpcHandler(broker.handleExtRpc)
  return { engine, broker, unhook }
}

async function createPair(extraA = {}, extraB = {}) {
  const homeA = await createHome('a')
  const homeB = await createHome('b')
  const a = await createEngine(homeA, extraA)
  const b = await createEngine(homeB, extraB)
  a.engine.discovery.addPeer({ deviceId: b.engine.identity.deviceId, host: '127.0.0.1', port: b.engine.port, name: 'PC-B' })
  b.engine.discovery.addPeer({ deviceId: a.engine.identity.deviceId, host: '127.0.0.1', port: a.engine.port, name: 'PC-A' })
  const pairA = await a.engine.pairStart(b.engine.identity.deviceId)
  const pairB = await b.engine.pairStart(a.engine.identity.deviceId)
  assert.equal(pairA.sas, pairB.sas)
  await a.engine.pairConfirm(b.engine.identity.deviceId)
  await b.engine.pairConfirm(a.engine.identity.deviceId)
  return { a, b, homeA, homeB }
}

async function stopPair(a, b) {
  a.broker.dispose()
  b.broker.dispose()
  await a.engine.stop()
  await b.engine.stop()
}

test('broker: exposes the documented service shape', async () => {
  const { a, b } = await createPair()
  try {
    const api = a.broker.api
    assert.equal(SERVICE_NAME, 'dshSync')
    for (const method of ['identity', 'peers', 'rpc', 'registerRpc', 'onPeerEvent']) {
      assert.equal(typeof api[method], 'function', `${method} must be a function`)
    }
    assert.equal(api.engine, undefined, 'the engine must not be exposed through the service')

    const identity = api.identity()
    assert.equal(identity.deviceId, a.engine.identity.deviceId)
    assert.equal(identity.name, a.engine.identity.name)
    assert.equal(identity.group, a.engine.identity.groupId)
    assert.deepEqual(Object.keys(identity).sort(), ['deviceId', 'group', 'name'])

    const peer = api.peers().find((item) => item.deviceId === b.engine.identity.deviceId)
    assert.ok(peer, 'the paired peer must be listed')
    assert.equal(peer.trusted, true)
    assert.equal(peer.online, true)
    assert.equal(peer.port, b.engine.port)
    assert.deepEqual(Object.keys(peer).sort(), ['deviceId', 'host', 'lastSyncAt', 'name', 'online', 'port', 'trusted'])
  } finally {
    await stopPair(a, b)
  }
})

test('broker: registers an ext op and answers a call from the peer', async () => {
  const { a, b } = await createPair({ extRpcAllow: ['ext.echo'] })
  try {
    const seen = []
    a.broker.api.registerRpc('ext.echo', async (request, context) => {
      seen.push({ op: request.op, payload: request.payload, peer: context.peer })
      return { echo: request.payload, from: context.peer.deviceId }
    })

    const result = await b.broker.api.rpc(a.engine.identity.deviceId, 'ext.echo', { hello: 'lan', n: 1 })
    assert.deepEqual(result.echo, { hello: 'lan', n: 1 })
    assert.equal(result.from, b.engine.identity.deviceId)
    assert.equal(seen.length, 1)
    assert.equal(seen[0].op, 'ext.echo')
    assert.equal(seen[0].peer.deviceId, b.engine.identity.deviceId)
    assert.equal(seen[0].peer.port, b.engine.port)
  } finally {
    await stopPair(a, b)
  }
})

test('broker: a plugin-declared allow:true op works with an empty extRpcAllow', async () => {
  const { a, b } = await createPair() // extRpcAllow = [] (default deny)
  try {
    a.broker.api.registerRpc('ext.auto', async (request) => ({ echoed: request.payload }), { allow: true })
    const result = await b.broker.api.rpc(a.engine.identity.deviceId, 'ext.auto', { n: 2 })
    assert.deepEqual(result.echoed, { n: 2 })
  } finally {
    await stopPair(a, b)
  }
})

test('broker: allow:true only whitelists its own op', async () => {
  const { a, b } = await createPair()
  try {
    a.broker.api.registerRpc('ext.auto', async () => ({ ok: 'auto' }), { allow: true })
    a.broker.api.registerRpc('ext.manual', async () => ({ ok: 'manual' }))
    assert.deepEqual(await b.broker.api.rpc(a.engine.identity.deviceId, 'ext.auto'), { ok: 'auto' })
    await assert.rejects(
      () => b.broker.api.rpc(a.engine.identity.deviceId, 'ext.manual'),
      (error) => error.code === 'ext-disabled',
    )
  } finally {
    await stopPair(a, b)
  }
})

test('broker: disposing an allow:true registration revokes its implicit permission', async () => {
  const { a, b } = await createPair()
  try {
    const off = a.broker.api.registerRpc('ext.auto', async () => 1, { allow: true })
    assert.equal(await b.broker.api.rpc(a.engine.identity.deviceId, 'ext.auto'), 1)
    off()
    // Re-register without allow: the op is served, but still denied.
    a.broker.api.registerRpc('ext.auto', async () => 2)
    await assert.rejects(
      () => b.broker.api.rpc(a.engine.identity.deviceId, 'ext.auto'),
      (error) => error.code === 'ext-disabled',
    )
  } finally {
    await stopPair(a, b)
  }
})

test('broker: extRpcDisableAll closes the channel even for allow:true ops', async () => {
  const { a, b } = await createPair({ extRpcDisableAll: true })
  try {
    a.broker.api.registerRpc('ext.auto', async () => ({ ok: true }), { allow: true })
    await assert.rejects(
      () => b.broker.api.rpc(a.engine.identity.deviceId, 'ext.auto'),
      (error) => error.code === 'ext-disabled',
    )
  } finally {
    await stopPair(a, b)
  }
})

test('broker: ext RPC is disabled by default (extRpcAllow empty)', async () => {
  const { a, b } = await createPair()
  try {
    a.broker.api.registerRpc('ext.echo', async (request) => request.payload)
    await assert.rejects(
      () => b.broker.api.rpc(a.engine.identity.deviceId, 'ext.echo', { n: 1 }),
      (error) => error.code === 'ext-disabled' && /extRpcAllow/.test(error.message),
    )
  } finally {
    await stopPair(a, b)
  }
})

test('broker: a wildcard whitelist enables the prefix only', async () => {
  const { a, b } = await createPair({ extRpcAllow: ['ext.shadow.*'] })
  try {
    a.broker.api.registerRpc('ext.shadow.status', async () => ({ ok: true }))
    a.broker.api.registerRpc('ext.other.status', async () => ({ ok: true }))
    assert.deepEqual(await b.broker.api.rpc(a.engine.identity.deviceId, 'ext.shadow.status'), { ok: true })
    await assert.rejects(
      () => b.broker.api.rpc(a.engine.identity.deviceId, 'ext.other.status'),
      (error) => error.code === 'ext-disabled',
    )
  } finally {
    await stopPair(a, b)
  }
})

test('broker: unknown extension op is refused', async () => {
  const { a, b } = await createPair({ extRpcAllow: ['*'] })
  try {
    await assert.rejects(
      () => b.broker.api.rpc(a.engine.identity.deviceId, 'ext.missing', { n: 1 }),
      (error) => error.code === 'unknown-op' && /未注册/.test(error.message),
    )
  } finally {
    await stopPair(a, b)
  }
})

test('broker: op names must be ext.* and cannot shadow built-ins', async () => {
  const { a, b } = await createPair()
  try {
    const api = a.broker.api
    for (const bad of ['echo', 'ping', 'manifest', 'ext.', 'ext.A', 'ext.a b', 'ext.a/b', 'ext.' + 'x'.repeat(70)]) {
      assert.throws(() => api.registerRpc(bad, async () => null), /ext\./, `must reject ${bad}`)
    }
    assert.equal(isExtOp('ext.shadow.status'), true)
    assert.equal(isExtOp('pull'), false)
    assert.equal(EXT_OP_PATTERN.test('ext.a-1.b_c'), true)
    const off = api.registerRpc('ext.good', async () => 1)
    assert.equal(typeof off, 'function')
    off()
  } finally {
    await stopPair(a, b)
  }
})

test('broker: a disallowed op is not reachable even when registered', async () => {
  const { a, b } = await createPair({ extRpcAllow: ['ext.allowed'] })
  try {
    a.broker.api.registerRpc('ext.hidden', async () => ({ secret: 'nope' }))
    await assert.rejects(
      () => b.broker.api.rpc(a.engine.identity.deviceId, 'ext.hidden', null),
      (error) => error.code === 'ext-disabled',
    )
  } finally {
    await stopPair(a, b)
  }
})

test('broker: an unpaired device cannot call extension ops', async () => {
  const { a, b } = await createPair({ extRpcAllow: ['*'] })
  const homeC = await createHome('c')
  const c = await createEngine(homeC)
  try {
    a.broker.api.registerRpc('ext.echo', async () => ({ ok: true }))
    // 1) transport layer rejects the unpaired caller before the ext table runs.
    const client = new PeerClient({
      identity: c.engine.identity,
      peer: { deviceId: a.engine.identity.deviceId, host: '127.0.0.1', port: a.engine.port },
    })
    await client.hello()
    await assert.rejects(() => client.rpc('ext.echo', { payload: null }), /does not trust/i)

    // 2) even if a request reached the handler, the paired-device assertion holds.
    await assert.rejects(
      () => a.engine.handleRpc({ op: 'ext.echo', payload: null }, { peer: { deviceId: 'not-a-real-device' } }),
      (error) => error.code === 'not-paired',
    )
    assert.equal(b.engine.identity.deviceId.length > 0, true)
  } finally {
    c.broker.dispose()
    await c.engine.stop()
    await stopPair(a, b)
  }
})

test('broker: built-in RPC ops are unchanged', async () => {
  const { a, b } = await createPair()
  try {
    const client = new PeerClient({
      identity: b.engine.identity,
      peer: { deviceId: a.engine.identity.deviceId, host: '127.0.0.1', port: a.engine.port },
    })
    const pong = await client.rpc('ping')
    assert.equal(pong.ok, true)
    assert.equal(pong.name, a.engine.identity.name)
    const manifest = await client.rpc('manifest', { set: 'attachments' })
    assert.equal(manifest.set, 'attachments')
    assert.ok(manifest.entries && typeof manifest.entries === 'object')
    await assert.rejects(() => client.rpc('totally-unknown'), /unknown op/)
  } finally {
    await stopPair(a, b)
  }
})

test('broker: oversized request payloads are refused', async () => {
  const { a, b } = await createPair({ extRpcAllow: ['ext.echo'] })
  try {
    a.broker.api.registerRpc('ext.echo', async (request) => ({ size: String(request.payload?.blob || '').length }))
    const blob = 'x'.repeat(1024 * 1024 + 1024) // just over 1 MB once JSON encoded
    await assert.rejects(
      () => b.broker.api.rpc(a.engine.identity.deviceId, 'ext.echo', { blob }),
      (error) => error.code === 'payload-too-large',
    )
  } finally {
    await stopPair(a, b)
  }
})

test('broker: oversized responses are refused', async () => {
  const { a, b } = await createPair({ extRpcAllow: ['ext.big'] })
  try {
    a.broker.api.registerRpc('ext.big', async () => ({ blob: 'y'.repeat(9 * 1024 * 1024) }))
    await assert.rejects(
      () => b.broker.api.rpc(a.engine.identity.deviceId, 'ext.big', null),
      (error) => error.code === 'response-too-large',
    )
  } finally {
    await stopPair(a, b)
  }
})

test('broker: handler failures surface as errors without leaking payloads into logs', async () => {
  const { a, b } = await createPair({ extRpcAllow: ['ext.boom'] })
  try {
    a.broker.api.registerRpc('ext.boom', async () => {
      throw Object.assign(new Error('handler exploded'), { code: 'ext-handler' })
    })
    await assert.rejects(
      () => b.broker.api.rpc(a.engine.identity.deviceId, 'ext.boom', { secret: 'do-not-log-me' }),
      (error) => error.code === 'ext-handler' && /handler exploded/.test(error.message),
    )
    const logs = a.engine.logs.map((line) => line.message).join('\n')
    assert.ok(logs.includes('ext rpc ext.boom from'), 'the op and device are logged')
    assert.ok(!logs.includes('do-not-log-me'), 'payload contents are never logged')
  } finally {
    await stopPair(a, b)
  }
})

test('broker: disposing a handler or the whole service revokes access', async () => {
  const { a, b } = await createPair({ extRpcAllow: ['*'] })
  try {
    const off = a.broker.api.registerRpc('ext.tmp', async () => ({ ok: true }))
    assert.deepEqual(await b.broker.api.rpc(a.engine.identity.deviceId, 'ext.tmp'), { ok: true })
    off()
    await assert.rejects(
      () => b.broker.api.rpc(a.engine.identity.deviceId, 'ext.tmp'),
      (error) => error.code === 'unknown-op',
    )

    a.broker.api.registerRpc('ext.tmp2', async () => 1)
    a.broker.dispose()
    await assert.rejects(
      () => b.broker.api.rpc(a.engine.identity.deviceId, 'ext.tmp2'),
      (error) => error.code === 'ext-disabled',
    )
    assert.throws(() => a.broker.api.registerRpc('ext.after', async () => 1), /已卸载/)
  } finally {
    await stopPair(a, b)
  }
})

test('broker: peer events are forwarded and the subscription can be disposed', async () => {
  const { a, b } = await createPair()
  try {
    const events = []
    const off = a.broker.api.onPeerEvent((event) => events.push(event))
    a.engine.emit('peer-updated', { deviceId: b.engine.identity.deviceId, name: 'PC-B' })
    a.engine.emit('peer-lost', { deviceId: b.engine.identity.deviceId })
    a.engine.emit('status')
    assert.equal(events.length, 3)
    assert.equal(events[0].type, 'peer-updated')
    assert.equal(events[0].deviceId, b.engine.identity.deviceId)
    assert.equal(events[0].peer.name, 'PC-B')
    assert.equal(events[1].type, 'peer-lost')
    assert.equal(events[2].type, 'status')
    off()
    a.engine.emit('status')
    assert.equal(events.length, 3, 'disposed listeners stop receiving events')
    assert.equal(DEFAULT_EXT_TIMEOUT_MS, 10_000)
  } finally {
    await stopPair(a, b)
  }
})

test('broker: clears extension ops and hooks when the plugin unloads', async () => {
  const { a, b } = await createPair({ extRpcAllow: ['*'] })
  try {
    a.broker.api.registerRpc('ext.lifecycle', async () => 1)
    a.unhook()
    await assert.rejects(
      () => b.broker.api.rpc(a.engine.identity.deviceId, 'ext.lifecycle'),
      (error) => error.code === 'unknown-op',
    )
    // Reinstalling a fresh broker works again (plugin reload path).
    const broker2 = createSyncService({ getEngine: () => a.engine, config: a.engine.config })
    a.engine.setExtRpcHandler(broker2.handleExtRpc)
    broker2.api.registerRpc('ext.lifecycle', async () => 2)
    assert.equal(await b.broker.api.rpc(a.engine.identity.deviceId, 'ext.lifecycle'), 2)
    broker2.dispose()
  } finally {
    await stopPair(a, b)
  }
})

test('broker: rpc() rejects invalid targets and non-ext ops', async () => {
  const { a, b } = await createPair({ extRpcAllow: ['*'] })
  try {
    await assert.rejects(() => a.broker.api.rpc('missing-device', 'ext.echo'), (error) => error.code === 'not-paired')
    await assert.rejects(() => a.broker.api.rpc(b.engine.identity.deviceId, 'pull'), (error) => error.code === 'invalid-op')
  } finally {
    await stopPair(a, b)
  }
})
