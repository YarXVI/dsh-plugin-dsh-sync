// LAN presence: UDP multicast + broadcast beacons, plus optional unicast seeds.
import dgram from 'node:dgram'
import { EventEmitter } from 'node:events'

export const DISCOVERY_PORT = 47821
export const MULTICAST_ADDRESS = '239.255.77.77'
export const BEACON_INTERVAL_MS = 4000
export const PEER_TTL_MS = 20000

export class Discovery extends EventEmitter {
  constructor({
    deviceId,
    name,
    group,
    port = 0,
    discoveryPort = DISCOVERY_PORT,
    multicastAddress = MULTICAST_ADDRESS,
    seeds = [],
    logger = null,
    enabled = true,
  }) {
    super()
    this.deviceId = deviceId
    this.name = name
    this.group = group
    this.port = port
    this.discoveryPort = discoveryPort
    this.multicastAddress = multicastAddress
    this.seeds = normalizeSeeds(seeds)
    this.logger = logger
    this.enabled = enabled
    this.socket = null
    this.timer = null
    this.peers = new Map()
    this.started = false
  }

  setPort(port) {
    this.port = Number(port) || 0
    this.announce()
  }

  setName(name) {
    this.name = name
    this.announce()
  }

  setGroup(group) {
    this.group = group
    this.announce()
  }

  async start() {
    if (!this.enabled || this.started) return
    this.started = true
    this.socket = dgram.createSocket({ type: 'udp4', reuseAddr: true })
    this.socket.on('error', (error) => {
      this.logger?.warn?.('[dsh-sync] discovery socket error:', error.message)
    })
    this.socket.on('message', (buffer, rinfo) => this.onMessage(buffer, rinfo))
    await new Promise((resolve) => {
      const done = () => resolve()
      this.socket.once('listening', () => {
        try { this.socket.setBroadcast(true) } catch {}
        try { this.socket.addMembership(this.multicastAddress) } catch (error) {
          this.logger?.warn?.('[dsh-sync] multicast join failed:', error.message)
        }
        done()
      })
      this.socket.once('error', (error) => {
        this.logger?.warn?.('[dsh-sync] discovery bind failed:', error.message)
        done()
      })
      this.socket.bind(this.discoveryPort, '0.0.0.0')
    })
    this.timer = setInterval(() => {
      this.announce()
      this.prune()
    }, BEACON_INTERVAL_MS)
    this.timer.unref?.()
    this.announce()
  }

  announce() {
    if (!this.socket || !this.port) return
    const payload = Buffer.from(JSON.stringify({
      v: 1,
      proto: 1,
      deviceId: this.deviceId,
      name: this.name,
      group: this.group,
      port: this.port,
      ts: Date.now(),
    }))
    try { this.socket.send(payload, this.discoveryPort, this.multicastAddress) } catch {}
    try { this.socket.send(payload, this.discoveryPort, '255.255.255.255') } catch {}
    const targets = new Set(this.seeds.map((seed) => seed.host + ':' + seed.port))
    for (const seed of this.seeds) {
      try { this.socket.send(payload, seed.port, seed.host) } catch {}
    }
    // A peer that already sees us may sit behind an AP that drops its
    // multicast/broadcast, or its replies may take another interface. Once a
    // peer is known, beacon it directly as well; that makes discovery
    // symmetric even when only one direction of group traffic works.
    for (const peer of this.peers.values()) {
      if (!peer.host) continue
      const port = Number(peer.discoveryPort) || this.discoveryPort
      const key = peer.host + ':' + port
      if (targets.has(key)) continue
      targets.add(key)
      try { this.socket.send(payload, port, peer.host) } catch {}
    }
  }

  onMessage(buffer, rinfo) {
    let msg
    try {
      msg = JSON.parse(buffer.toString('utf8'))
    } catch {
      return
    }
    if (!msg || msg.v !== 1 || !msg.deviceId || !msg.port) return
    if (msg.deviceId === this.deviceId) return
    const previous = this.peers.get(msg.deviceId)
    const peer = {
      deviceId: String(msg.deviceId),
      name: String(msg.name || msg.deviceId).slice(0, 64),
      group: String(msg.group || ''),
      host: rinfo.address,
      port: Number(msg.port),
      discoveryPort: Number(rinfo.port) || this.discoveryPort,
      lastSeen: Date.now(),
      source: previous?.source || 'lan',
    }
    this.peers.set(peer.deviceId, peer)
    if (!previous || previous.host !== peer.host || previous.port !== peer.port || previous.group !== peer.group) {
      this.emit('peer', peer)
    }
  }

  prune() {
    const cutoff = Date.now() - PEER_TTL_MS
    for (const [id, peer] of this.peers) {
      if (peer.lastSeen < cutoff) {
        this.peers.delete(id)
        this.emit('peer-lost', peer)
      }
    }
  }

  /** Peer list, most recently seen first. */
  list() {
    return [...this.peers.values()].sort((a, b) => b.lastSeen - a.lastSeen)
  }

  /** Register a peer discovered by other means (manual address, tests). */
  addPeer(peer, { emit = true } = {}) {
    if (!peer?.deviceId || peer.deviceId === this.deviceId) return
    const next = { source: 'manual', lastSeen: Date.now(), group: '', name: peer.deviceId, discoveryPort: this.discoveryPort, ...peer }
    this.peers.set(next.deviceId, next)
    if (emit) this.emit('peer', next)
  }

  /** Add a unicast discovery target (`host:port`), deduplicated. */
  addSeed(text) {
    const parsed = parseSeed(text)
    if (!parsed) return null
    if (!this.seeds.some((seed) => seed.host === parsed.host && seed.port === parsed.port)) this.seeds.push(parsed)
    return parsed
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    if (this.socket) {
      try { this.socket.close() } catch {}
      this.socket = null
    }
    this.started = false
    this.peers.clear()
  }
}

function normalizeSeeds(seeds) {
  const out = []
  for (const seed of Array.isArray(seeds) ? seeds : []) {
    const parsed = typeof seed === 'object' && seed ? parseSeed(`${seed.host}:${seed.port}`) : parseSeed(seed)
    if (parsed) out.push(parsed)
  }
  return out
}

/** Parse `host:port` (IPv4, hostname, or bracketed IPv6). */
export function parseSeed(value) {
  const text = String(value || '').trim()
  if (!text) return null
  const match = text.match(/^\[([^\]]+)\]:(\d+)$/) || text.match(/^([^:\s]+):(\d+)$/)
  if (!match) return null
  const port = Number(match[2])
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null
  return { host: match[1], port }
}
