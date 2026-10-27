import test from 'node:test'
import assert from 'node:assert/strict'
import { Discovery } from '../src/discovery.js'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('discovery: beacons reach a seeded peer and expire after the TTL', async () => {
  const portA = 47901
  const portB = 47902
  const a = new Discovery({
    deviceId: 'device-a',
    name: 'PC-A',
    group: 'group-1',
    port: 50001,
    discoveryPort: portA,
    seeds: [`127.0.0.1:${portB}`],
  })
  const b = new Discovery({
    deviceId: 'device-b',
    name: 'PC-B',
    group: 'group-1',
    port: 50002,
    discoveryPort: portB,
    seeds: [`127.0.0.1:${portA}`],
  })
  try {
    await a.start()
    await b.start()
    a.announce()
    b.announce()

    let peersOnA = []
    let peersOnB = []
    for (let i = 0; i < 30; i++) {
      peersOnA = a.list()
      peersOnB = b.list()
      if (peersOnA.some((peer) => peer.deviceId === 'device-b') && peersOnB.some((peer) => peer.deviceId === 'device-a')) break
      await sleep(100)
    }
    const peerB = peersOnA.find((peer) => peer.deviceId === 'device-b')
    const peerA = peersOnB.find((peer) => peer.deviceId === 'device-a')
    assert.ok(peerB, 'A must see B')
    assert.ok(peerA, 'B must see A')
    assert.equal(peerB.port, 50002)
    assert.equal(peerB.host, '127.0.0.1')
    assert.equal(peerB.group, 'group-1')

    // A beacon from the same device does not create a duplicate entry.
    assert.equal(peersOnA.filter((peer) => peer.deviceId === 'device-b').length, 1)
  } finally {
    a.stop()
    b.stop()
  }
})

test('discovery: known peers receive a direct beacon, not only group traffic', () => {
  const discovery = new Discovery({
    deviceId: 'self',
    name: 'self',
    group: 'g',
    port: 50000,
    discoveryPort: 47904,
    enabled: false,
  })
  const sent = []
  discovery.socket = { send: (buffer, port, host) => sent.push({ port, host, text: buffer.toString('utf8') }) }
  discovery.peers.set('peer-b', {
    deviceId: 'peer-b',
    name: 'B',
    host: '192.168.1.9',
    port: 5100,
    discoveryPort: 47905,
    lastSeen: Date.now(),
  })
  discovery.announce()
  const direct = sent.filter((item) => item.host === '192.168.1.9')
  assert.equal(direct.length, 1)
  assert.equal(direct[0].port, 47905)
  assert.equal(JSON.parse(direct[0].text).deviceId, 'self')
})

test('discovery: self beacons are ignored and malformed packets are dropped', async () => {
  const discovery = new Discovery({
    deviceId: 'self',
    name: 'self',
    group: 'g',
    port: 50000,
    discoveryPort: 47903,
    enabled: false,
  })
  const emitted = []
  discovery.on('peer', (peer) => emitted.push(peer))
  discovery.onMessage(Buffer.from(JSON.stringify({ v: 1, deviceId: 'self', port: 1 })), { address: '127.0.0.1' })
  discovery.onMessage(Buffer.from('not json'), { address: '127.0.0.1' })
  discovery.onMessage(Buffer.from(JSON.stringify({ v: 2, deviceId: 'other', port: 1 })), { address: '127.0.0.1' })
  assert.equal(emitted.length, 0)
})
