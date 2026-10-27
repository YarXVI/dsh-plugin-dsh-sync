// `dshSync` service: a controlled cross-machine RPC broker for other plugins.
//
// dsh-sync already has LAN discovery, pairing and an authenticated/encrypted
// RPC channel. Other plugins in the same profile (e.g. the shadow-workspace
// plugin) must not re-implement that: they consume this service instead.
//
// The broker intentionally does NOT expose the engine: callers get a small set
// of functions, and remote peers may only call explicitly registered `ext.*`
// operations that the local config whitelists (`extRpcAllow`, empty = disabled).
import { PeerClient } from './transport.js'

export const SERVICE_NAME = 'dshSync'

/** Extension ops: forced `ext.` prefix, no way to shadow built-in ops. */
export const EXT_OP_PATTERN = /^ext\.[a-z0-9][a-z0-9._-]{0,63}$/

export const EXT_REQUEST_MAX_BYTES = 1024 * 1024 // 1 MB inbound payload
export const EXT_RESPONSE_MAX_BYTES = 8 * 1024 * 1024 // 8 MB returned value
export const DEFAULT_EXT_TIMEOUT_MS = 10_000

export function isExtOp(op) {
  return EXT_OP_PATTERN.test(String(op || ''))
}

function rpcError(code, message) {
  return Object.assign(new Error(message), { code })
}

function byteLength(value) {
  try {
    return Buffer.byteLength(JSON.stringify(value ?? null))
  } catch {
    return Infinity
  }
}

function pickPeer(peer) {
  if (!peer) return null
  return {
    deviceId: String(peer.deviceId || ''),
    name: String(peer.name || ''),
    host: String(peer.host || ''),
    port: Number(peer.port) || 0,
  }
}

/**
 * Build the `dshSync` service.
 *
 * `getEngine` is a getter because the engine is created asynchronously during
 * plugin boot while `ctx.provide()` must run synchronously during apply.
 */
export function createSyncService({ getEngine, config = {}, logger = null } = {}) {
  const handlers = new Map()
  // Ops a plugin explicitly declared (`registerRpc(..., { allow: true })`).
  // This is what makes "install and use" work without hand-editing the profile
  // config, while still being per-op, not a blanket switch.
  const autoAllowed = new Set()
  const listeners = new Set()
  let disposed = false

  function engine() {
    const current = typeof getEngine === 'function' ? getEngine() : null
    if (!current) throw rpcError('sync-not-ready', 'dsh-sync 引擎尚未就绪，请稍后重试')
    return current
  }

  function settings() {
    const current = typeof getEngine === 'function' ? getEngine() : null
    return (current && current.config) || config || {}
  }

  /**
   * Access check: `extRpcDisableAll` (master kill switch) wins over everything,
   * then the plugin-declared allow list, then the user's `extRpcAllow` config
   * (op names, prefixes ending in `*`, or `*`).
   */
  function extAllowed(op) {
    const current = settings()
    if (current.extRpcDisableAll === true) return false
    if (autoAllowed.has(op)) return true
    const allow = current.extRpcAllow
    const list = Array.isArray(allow) ? allow.map(String) : []
    if (!list.length) return false
    for (const entry of list) {
      if (entry === '*' || entry === op) return true
      if (entry.endsWith('*') && op.startsWith(entry.slice(0, -1))) return true
    }
    return false
  }

  function serviceLog(level, message) {
    try {
      const current = typeof getEngine === 'function' ? getEngine() : null
      if (current?.log) current.log(level, message)
      else logger?.[level === 'error' ? 'warn' : 'info']?.('[dsh-sync]', message)
    } catch {}
  }

  const api = {
    /** This device: `{ deviceId, name, group }`. */
    identity() {
      const current = engine()
      const state = current.state()
      return {
        deviceId: String(state?.device?.deviceId || current.identity.deviceId),
        name: String(state?.device?.name || current.identity.name),
        group: String(current.identity.groupId),
      }
    },

    /**
     * Known peers with the fields a consumer needs (no keys, no internals).
     * Same source as the panel's device list, so online/trusted match the UI.
     */
    peers() {
      const current = engine()
      const state = current.state()
      return (state?.peers || []).map((peer) => ({
        deviceId: String(peer.deviceId || ''),
        name: String(peer.name || ''),
        online: Boolean(peer.online),
        trusted: Boolean(peer.trusted),
        host: String(peer.host || ''),
        port: Number(peer.port) || 0,
        lastSyncAt: peer.lastSyncAt || null,
      }))
    },

    /**
     * Call a registered `ext.*` op on a paired, online peer.
     * Resolves with the peer's JSON result; rejects with a readable error
     * (`error.code` carries the peer's code, e.g. `ext-disabled`).
     */
    async rpc(deviceId, op, payload = null, { timeoutMs } = {}) {
      if (!isExtOp(op)) throw rpcError('invalid-op', '只能调用 ext.* 扩展 op')
      const current = engine()
      const id = String(deviceId || '')
      const trusted = current.identity.getPeer(id)
      if (!trusted) throw rpcError('not-paired', `设备尚未配对: ${id}`)
      const peer = current.discovery?.list().find((item) => item.deviceId === id)
      if (!peer || !peer.host || !Number(peer.port)) throw rpcError('peer-offline', `设备不在线: ${id}`)
      const limit = Number(timeoutMs)
      const client = new PeerClient({
        identity: current.identity,
        peer: { deviceId: id, host: peer.host, port: Number(peer.port) },
        logger,
        timeoutMs: Number.isFinite(limit) && limit > 0 ? limit : DEFAULT_EXT_TIMEOUT_MS,
      })
      await client.hello()
      return client.rpc(op, { payload: payload ?? null })
    },

    /**
     * Serve an `ext.*` op to paired peers. Returns a dispose function.
     *
     * `options.allow: true` adds this op to the local allow set, so a plugin
     * works right after install without hand-editing `extRpcAllow` in the
     * profile config. It only whitelists that one op; the master switch
     * `extRpcDisableAll` still wins.
     *
     * The handler receives `({ op, payload }, context)` and must return
     * JSON-serialisable data; `context.peer` holds `{ deviceId, name, host, port }`.
     */
    registerRpc(op, handler, { allow = false } = {}) {
      if (disposed) throw rpcError('service-disposed', 'dshSync 服务已卸载')
      if (!isExtOp(op)) {
        throw new Error('扩展 op 必须以 ext. 开头并匹配 /^ext\\.[a-z0-9][a-z0-9._-]{0,63}$/（例如 ext.shadow.status）')
      }
      if (typeof handler !== 'function') throw new Error('handler 必须是函数')
      if (handlers.has(op)) throw new Error(`扩展 op 已注册: ${op}`)
      handlers.set(op, handler)
      if (allow === true) autoAllowed.add(op)
      return () => {
        if (handlers.get(op) === handler) handlers.delete(op)
        // Only drop the auto-allow when this exact registration owned it.
        if (!handlers.has(op)) autoAllowed.delete(op)
      }
    },

    /**
     * Subscribe to peer/status events: `{ type, deviceId?, peer? }` where type
     * is one of `peer`, `peer-lost`, `peer-updated`, `status`. Returns dispose.
     */
    onPeerEvent(listener) {
      if (typeof listener !== 'function') throw new Error('listener 必须是函数')
      const current = engine()
      const emit = (type) => (event) => {
        if (disposed) return
        try {
          listener({ type, deviceId: event?.deviceId || null, peer: selectPeerEvent(type, event) })
        } catch (error) {
          logger?.warn?.('[dsh-sync] peer event listener failed:', String(error?.message || error))
        }
      }
      const wrapped = {
        peer: emit('peer'),
        'peer-lost': emit('peer-lost'),
        'peer-updated': emit('peer-updated'),
        status: emit('status'),
      }
      for (const [name, fn] of Object.entries(wrapped)) current.on(name, fn)
      const dispose = () => {
        for (const [name, fn] of Object.entries(wrapped)) {
          try { current.removeListener(name, fn) } catch {}
        }
        listeners.delete(dispose)
      }
      listeners.add(dispose)
      return dispose
    },
  }

  /**
   * Server side hook, installed by the plugin entry via
   * `engine.setExtRpcHandler(service.handleExtRpc)`.
   * Thrown errors become `{ error: { code, message } }` on the wire (the
   * transport already converts them). Returns the raw JSON result on success.
   */
  async function handleExtRpc(request, context) {
    const op = String(request?.op || '')
    if (!isExtOp(op)) return null // not ours: the engine reports unknown-op
    if (disposed) throw rpcError('ext-disabled', 'dshSync 服务已卸载')
    if (!extAllowed(op)) {
      throw rpcError('ext-disabled', 'ext RPC 未启用：op 未以 allow:true 声明，且 extRpcAllow 未授权（或 extRpcDisableAll 已开启）')
    }
    const current = engine()
    const peerId = String(context?.peer?.deviceId || '')
    const trusted = peerId ? current.identity.getPeer(peerId) : null
    if (!trusted) throw rpcError('not-paired', '未配对设备不能调用扩展 RPC')
    if (context.peer.publicKey && trusted.publicKey && context.peer.publicKey !== trusted.publicKey) {
      throw rpcError('identity-mismatch', '对端公钥与配对记录不一致')
    }
    const handler = handlers.get(op)
    if (!handler) throw rpcError('unknown-op', `未注册的扩展 op: ${op}`)
    const requestBytes = byteLength({ op, payload: request?.payload ?? null })
    if (!Number.isFinite(requestBytes) || requestBytes > EXT_REQUEST_MAX_BYTES) {
      throw rpcError('payload-too-large', `请求超过上限 ${EXT_REQUEST_MAX_BYTES} 字节`)
    }
    serviceLog('info', `ext rpc ${op} from ${peerId.slice(0, 8)} (${requestBytes} bytes)`)
    // The transport hands us the trusted identity record (no host/port), so
    // enrich from discovery to give consumers a useful peer descriptor.
    const known = current.discovery?.list().find((item) => item.deviceId === peerId)
    const peerInfo = pickPeer({
      deviceId: peerId,
      name: trusted.name || context.peer.name || known?.name || '',
      host: known?.host || '',
      port: known?.port || 0,
    })
    const result = await handler({ op, payload: request?.payload ?? null }, { peer: peerInfo })
    const responseBytes = byteLength(result)
    if (!Number.isFinite(responseBytes) || responseBytes > EXT_RESPONSE_MAX_BYTES) {
      throw rpcError('response-too-large', `返回值超过上限 ${EXT_RESPONSE_MAX_BYTES} 字节`)
    }
    return result ?? null
  }

  function dispose() {
    disposed = true
    handlers.clear()
    autoAllowed.clear()
    for (const off of [...listeners]) {
      try { off() } catch {}
    }
    listeners.clear()
  }

  return { api, handleExtRpc, dispose, name: SERVICE_NAME }
}

function selectPeerEvent(type, event) {
  if (!event) return null
  if (event.deviceId) return pickPeer(event)
  if (event.peer) return pickPeer(event.peer)
  return null
}
