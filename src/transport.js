// Encrypted RPC over plain HTTP.
//
// `/hello` is public and only carries identity material. Everything else goes
// through `/rpc`: the caller encrypts a JSON payload with the X25519 shared
// secret it derived with the peer, and the response comes back the same way.
import http from 'node:http'
import { deriveKeys, deriveSharedSecret, open, safeEqualHex, seal, sha256hex } from './crypto.js'

export const PROTOCOL = 1
const MAX_BODY = 64 * 1024 * 1024

export function transcriptFor(pubA, pubB) {
  const [first, second] = [String(pubA), String(pubB)].sort()
  return `dsh-sync/v1\u0000${first}\u0000${second}`
}

export function keysFor(privateKey, ownPublicKey, peerPublicKey) {
  const shared = deriveSharedSecret(privateKey, peerPublicKey)
  return { shared, keys: deriveKeys(shared, transcriptFor(ownPublicKey, peerPublicKey)) }
}

export async function readBody(req, limit = MAX_BODY) {
  return await new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(Object.assign(new Error('request too large'), { statusCode: 413 }))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function send(res, status, value) {
  const body = Buffer.from(JSON.stringify(value))
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length })
  res.end(body)
}

export class SyncServer {
  constructor({ identity, handler, logger = null, port = 0 }) {
    this.identity = identity
    this.handler = handler
    this.logger = logger
    this.port = port
    this.server = null
    this.stats = { requests: 0, errors: 0, lastRequestAt: null, lastError: null }
  }

  async start() {
    this.server = http.createServer((req, res) => {
      this.dispatch(req, res).catch((error) => {
        this.stats.errors++
        this.stats.lastError = String(error?.message || error)
        this.logger?.warn?.('[dsh-sync] request failed:', this.stats.lastError)
        if (!res.headersSent) send(res, error.statusCode || 500, { error: { code: 'internal', message: this.stats.lastError } })
        else res.destroy()
      })
    })
    this.server.keepAliveTimeout = 5000
    await new Promise((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(this.port, '0.0.0.0', () => {
        this.port = this.server.address().port
        resolve()
      })
    })
    return this.port
  }

  async stop() {
    if (!this.server) return
    await new Promise((resolve) => {
      this.server.close(() => resolve())
      this.server.closeAllConnections?.()
    })
    this.server = null
  }

  async dispatch(req, res) {
    this.stats.requests++
    this.stats.lastRequestAt = new Date().toISOString()
    const url = new URL(req.url || '/', 'http://localhost')
    if (req.method !== 'POST') return send(res, 405, { error: { code: 'method', message: 'POST only' } })

    if (url.pathname === '/dsh-sync/v1/hello') {
      const body = await readBody(req, 64 * 1024)
      let hello
      try { hello = JSON.parse(body.toString('utf8')) } catch { return send(res, 400, { error: { code: 'bad-json', message: 'body is not JSON' } }) }
      if (!hello?.deviceId || !hello?.publicKey) return send(res, 400, { error: { code: 'bad-hello', message: 'deviceId and publicKey are required' } })
      if (sha256hex(hello.publicKey).slice(0, 32) !== hello.deviceId) {
        return send(res, 400, { error: { code: 'bad-identity', message: 'public key does not match device id' } })
      }
      return send(res, 200, {
        protocol: PROTOCOL,
        deviceId: this.identity.deviceId,
        name: this.identity.name,
        publicKey: this.identity.publicKey,
        publicKeyFingerprint: this.identity.publicKeyFingerprint,
        group: this.identity.groupId,
        port: this.port,
      })
    }

    if (url.pathname !== '/dsh-sync/v1/rpc') {
      return send(res, 404, { error: { code: 'not-found', message: 'unknown endpoint' } })
    }

    const body = await readBody(req)
    let envelope
    try { envelope = JSON.parse(body.toString('utf8')) } catch { return send(res, 400, { error: { code: 'bad-json', message: 'body is not JSON' } }) }
    const from = String(envelope?.from || '')
    const peer = this.identity.getPeer(from)
    if (!peer) return send(res, 403, { error: { code: 'untrusted', message: 'device is not paired' } })
    if (!safeEqualHex(sha256hex(peer.publicKey).slice(0, 32), from)) {
      return send(res, 403, { error: { code: 'identity-mismatch', message: 'stored key does not match device id' } })
    }

    let request
    try {
      const shared = deriveSharedSecret(this.identity.privateKey, peer.publicKey)
      const { enc } = deriveKeys(shared, transcriptFor(this.identity.publicKey, peer.publicKey))
      request = open(enc, envelope.payload)
    } catch (error) {
      return send(res, 400, { error: { code: 'undecryptable', message: 'cannot open envelope' } })
    }
    if (!request || typeof request.op !== 'string') return send(res, 400, { error: { code: 'bad-request', message: 'missing op' } })
    if (Math.abs(Date.now() - Number(request.ts || 0)) > 10 * 60 * 1000) {
      return send(res, 400, { error: { code: 'stale', message: 'request timestamp out of range' } })
    }

    let result
    try {
      result = await this.handler(request, { peer, ip: req.socket.remoteAddress })
    } catch (error) {
      this.stats.errors++
      result = { error: { code: error.code || 'handler', message: String(error?.message || error) } }
    }

    const shared = deriveSharedSecret(this.identity.privateKey, peer.publicKey)
    const { enc } = deriveKeys(shared, transcriptFor(this.identity.publicKey, peer.publicKey))
    return send(res, 200, { v: 1, from: this.identity.deviceId, payload: seal(enc, result) })
  }
}

export class PeerClient {
  constructor({ identity, peer, logger = null, timeoutMs = 30000 }) {
    this.identity = identity
    this.peer = peer
    this.logger = logger
    this.timeoutMs = timeoutMs
    this.remote = null
    this.keys = null
  }

  baseUrl() {
    const host = this.peer.host?.includes(':') ? `[${this.peer.host}]` : this.peer.host
    return `http://${host}:${this.peer.port}`
  }

  async hello() {
    const response = await fetch(`${this.baseUrl()}/dsh-sync/v1/hello`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        deviceId: this.identity.deviceId,
        name: this.identity.name,
        publicKey: this.identity.publicKey,
        group: this.identity.groupId,
        protocol: PROTOCOL,
      }),
      signal: AbortSignal.timeout(Math.min(this.timeoutMs, 8000)),
    })
    if (!response.ok) throw new Error(`hello failed: HTTP ${response.status}`)
    const hello = await response.json()
    if (hello.protocol !== PROTOCOL) throw new Error(`protocol mismatch: ${hello.protocol}`)
    if (sha256hex(hello.publicKey).slice(0, 32) !== hello.deviceId) throw new Error('peer identity mismatch')
    if (this.peer.deviceId && hello.deviceId !== this.peer.deviceId) throw new Error('peer answered with another device id')
    this.remote = hello
    const shared = deriveSharedSecret(this.identity.privateKey, hello.publicKey)
    this.keys = deriveKeys(shared, transcriptFor(this.identity.publicKey, hello.publicKey))
    return hello
  }

  async rpc(op, params = {}) {
    if (!this.keys) await this.hello()
    const payload = seal(this.keys.enc, { op, ...params, ts: Date.now() })
    const response = await fetch(`${this.baseUrl()}/dsh-sync/v1/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ from: this.identity.deviceId, payload }),
      signal: AbortSignal.timeout(this.timeoutMs),
    })
    if (response.status === 403) throw new Error('peer does not trust this device yet')
    if (!response.ok) throw new Error(`rpc failed: HTTP ${response.status}`)
    const envelope = await response.json()
    const result = open(this.keys.enc, envelope.payload)
    if (result?.error) {
      const error = new Error(result.error.message || 'peer error')
      error.code = result.error.code
      throw error
    }
    return result
  }
}
