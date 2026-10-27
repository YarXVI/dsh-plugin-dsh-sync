// Settings panel route — the "install and use" control surface for both halves.
//
// GET returns everything the panel needs: this device, sharing state + local
// workspaces, paired devices, display peer + shadow groups, recent audit rows,
// and whether dsh-sync's extension channel is available.
//
// POST actions are deliberately tiny and validated here:
//   set-sharing, set-workspaces, kill, set-display, set-peer, clear-audit, refresh
//
// There is no file/path/exec action: the panel cannot become a generic RPC.
import { PLUGIN_VERSION } from './constants.js'
import { createAuthorizer, readJsonBody, sendJson } from './http.js'
import { errorText } from './util.js'

/** Actions the panel route accepts. */
export const PANEL_ACTIONS = Object.freeze([
  'set-sharing', 'set-workspaces', 'kill', 'set-display', 'set-peer', 'clear-audit', 'refresh', 'client-log',
])

/**
 * Build the panel route handler.
 * @param {object} options - wiring.
 * @param {object} options.ctx - Host context.
 * @param {import('./state.js').ShadowStateStore} options.state - product state.
 * @param {import('./audit.js').AuditLog} options.audit - audit sink.
 * @param {import('./session-bridge.js').ShadowHostBridge} options.bridge - sharing bridge.
 * @param {import('./b-proxy.js').ShadowClientProxy} options.proxy - display proxy.
 * @param {object} [options.log] - logger.
 * @returns {(req: any, res: any) => Promise<void>}
 */
export function createPanelHandler(options = {}) {
  const { ctx, state, audit, bridge, proxy, log = null, debug = null } = options
  const authorize = createAuthorizer(ctx)
  return async function handlePanel(req, res) {
    const started = Date.now()
    const admission = authorize(req)
    if (!admission.ok) {
      log?.warn?.('panel request forbidden', { status: admission.status, remote: String(req?.socket?.remoteAddress || '') })
      sendJson(res, admission.status, { ok: false, error: { code: 'forbidden', message: 'shadow panel is available to the local GUI only' } })
      return
    }
    if (req.method === 'GET') {
      const panelState = await buildPanelState({ ctx, state, audit, bridge, proxy, debug })
      log?.debug?.('panel GET', {
        peers: panelState.peers.length,
        workspaces: panelState.sharing.workspaces.length,
        groups: panelState.display.groups.length,
        sessions: panelState.display.state?.sessions?.length || 0,
        ms: Date.now() - started,
      })
      sendJson(res, 200, { ok: true, state: panelState })
      return
    }
    if (req.method !== 'POST') {
      log?.warn?.('panel method not allowed', { method: String(req?.method || '') })
      sendJson(res, 405, { ok: false, error: { code: 'method', message: 'GET or POST' } })
      return
    }
    let body
    try {
      body = await readJsonBody(req)
    } catch (error) {
      log?.warn?.('panel body invalid', { error })
      sendJson(res, error.statusCode || 400, { ok: false, error: { code: 'bad-json', message: String(error?.message || error) } })
      return
    }
    const action = String(body?.action ?? '')
    try {
      await runPanelAction({ ctx, state, audit, bridge, proxy, action, body, log, debug })
      const panelState = await buildPanelState({ ctx, state, audit, bridge, proxy, debug })
      log?.info?.('panel action ok', {
        action,
        sharing: panelState.sharing.enabled,
        workspaces: panelState.sharing.workspaceIds.length,
        peer: panelState.display.peerDeviceId || '',
        ms: Date.now() - started,
      })
      sendJson(res, 200, { ok: true, state: panelState })
    } catch (error) {
      const status = error?.code === 'shadow/bad-request' ? 400 : 500
      log?.warn?.('panel action failed', { action, error })
      sendJson(res, status, {
        ok: false,
        error: { code: typeof error?.code === 'string' ? error.code : 'shadow/internal', message: errorText(error) },
      })
    }
  }
}

/** Read the display proxy's grouped state without failing the whole panel. */
async function proxyState(proxy) {
  try {
    return await proxy.state()
  } catch (error) {
    return { ok: false, online: false, workspaces: [], sessions: [], lastError: errorText(error) }
  }
}

/**
 * Merge dsh-sync's peer list with inbound-RPC presence.
 *
 * dsh-sync only discovers peers in one direction: a manually-added display
 * device never appears online in A's own `peers()` even though it is actively
 * calling us. Presence rows therefore make the device visible and mark it
 * "attached", which is what the approval logic trusts.
 * @param {Array<object>} peers - `sync.peers()` rows.
 * @param {Array<object>} presence - `bridge.peerPresence()` rows.
 * @returns {Array<object>} merged rows with `attached`/`lastSeenAt`/`ageMs`.
 */
export function mergePeerPresence(peers, presence) {
  const list = Array.isArray(peers) ? peers : []
  const rows = Array.isArray(presence) ? presence : []
  const byId = new Map()
  for (const peer of list) {
    const deviceId = String(peer?.deviceId ?? '')
    if (!deviceId) continue
    byId.set(deviceId, {
      ...peer,
      deviceId,
      attached: false,
      lastSeenAt: 0,
      ageMs: null,
      online: peer?.online === true,
      trusted: peer?.trusted === true,
    })
  }
  for (const row of rows) {
    const deviceId = String(row?.deviceId ?? '')
    if (!deviceId) continue
    const existing = byId.get(deviceId)
    if (existing) {
      existing.attached = row.attached === true
      existing.lastSeenAt = Number(row.lastSeenAt) || 0
      existing.ageMs = Number.isFinite(Number(row.ageMs)) ? Number(row.ageMs) : null
      if (row.name) existing.name = row.name
    } else {
      byId.set(deviceId, {
        deviceId,
        name: String(row?.name ?? ''),
        online: false,
        trusted: false,
        attached: row.attached === true,
        lastSeenAt: Number(row.lastSeenAt) || 0,
        ageMs: Number.isFinite(Number(row.ageMs)) ? Number(row.ageMs) : null,
      })
    }
  }
  return [...byId.values()].sort((a, b) => Number(b.lastSeenAt || 0) - Number(a.lastSeenAt || 0))
}

/** Snapshot for the panel page. */
export async function buildPanelState({ ctx, state, audit, bridge, proxy, debug = null }) {
  const snapshot = state.snapshot()
  const sync = syncOf()
  const syncAvailable = Boolean(sync && (typeof sync.rpc === 'function' || typeof sync.peers === 'function'))
  const display = await proxyState(proxy)
  const peers = mergePeerPresence(proxy.peers(), typeof bridge.peerPresence === 'function' ? bridge.peerPresence() : [])
  const selectedPeer = snapshot.display.peerDeviceId
  const selected = peers.find((peer) => peer.deviceId === selectedPeer)
  const groups = (display.workspaces || []).map((workspace) => ({
    deviceId: display.peer?.deviceId || selectedPeer,
    deviceName: display.peer?.name || selected?.name || '',
    workspaceId: workspace.workspaceId,
    workspaceTitle: workspace.title,
    sessionCount: workspace.sessionCount,
    sessions: workspace.sessions || [],
  }))
  let identity = { deviceId: '', name: '' }
  try {
    identity = sync?.identity?.() || identity
  } catch {}
  const uploads = typeof proxy.uploadsState === 'function'
    ? proxy.uploadsState()
    : { enabled: false, configEnabled: false, grantedPeers: 0, maxBytes: 0, chunkBytes: 0, dir: '', peer: { enabled: false, maxBytes: 0, chunkBytes: 0 } }
  return {
    version: PLUGIN_VERSION,
    updatedAt: new Date().toISOString(),
    device: { deviceId: String(identity.deviceId ?? ''), name: String(identity.name ?? '') },
    sync: {
      available: syncAvailable,
      message: syncAvailable ? '' : '设备同步引擎尚未就绪',
    },
    paths: {
      state: state.file || '',
      audit: audit.file || '',
      debug: debug?.path || '',
    },
    sharing: {
      enabled: snapshot.sharing.enabled === true,
      active: Boolean(bridge.sharingActive),
      workspaceIds: snapshot.sharing.workspaceIds,
      pausedAt: snapshot.sharing.pausedAt,
      killedAt: snapshot.sharing.killedAt,
      workspaces: bridge.listWorkspaces(),
      managedSessions: bridge.registry.list().length,
      pendingApprovals: [...bridge.pendingApprovals.values()].length,
      pendingQuestions: [...bridge.pendingQuestions.values()].length,
    },
    display: {
      enabled: snapshot.display.enabled !== false,
      peerDeviceId: selectedPeer,
      peerName: snapshot.display.peerName || selected?.name || '',
      // Peer plugin version (from `ext.shadow.info`); shown next to our own
      // version for diagnosing mixed-version pairs.
      peerVersion: String(display.peer?.version ?? ''),
      selectedOnline: Boolean(selected?.online),
      state: display,
      groups,
    },
    peers,
    // 0.9.0: receive switch (this device) + selected peer readiness. The push
    // control is only rendered when `uploads.peer.enabled` is true.
    uploads,
    audit: audit.last(20),
  }
}

/** Dispatch one panel action. */
export async function runPanelAction({ ctx, state, audit, bridge, proxy, action, body = {}, log = null, debug = null }) {
  switch (action) {
    case 'set-sharing': {
      const enabled = body.enabled === true
      const snapshot = state.setSharing(enabled)
      bridge.syncFromState()
      audit.record({ action: 'sharing.set', enabled, ok: true })
      log?.info?.('sharing toggled', { enabled })
      return snapshot
    }
    case 'set-workspaces': {
      const known = new Set(bridge.listWorkspaces().map((workspace) => workspace.workspaceId))
      const requested = Array.isArray(body.workspaceIds) ? body.workspaceIds.map(String) : []
      const accepted = requested.filter((workspaceId) => known.has(workspaceId))
      const snapshot = state.setWorkspaces(accepted)
      bridge.syncFromState()
      audit.record({ action: 'sharing.workspaces', count: accepted.length, ok: true })
      log?.info?.('shared workspaces changed', { requested: requested.length, accepted: accepted.length })
      return snapshot
    }
    case 'kill': {
      const result = bridge.killSwitch('panel')
      audit.record({ action: 'sharing.kill', ok: true, reason: String(body.reason ?? 'panel') })
      log?.warn?.('kill switch used from panel')
      return result
    }
    case 'set-display': {
      const enabled = body.enabled === true
      state.setDisplay(enabled)
      proxy.syncFromState()
      if (enabled) proxy.refreshInfo(true).catch((error) => log?.warn?.('refresh after display enable failed', { error }))
      audit.record({ action: 'display.set', enabled, ok: true })
      log?.info?.('display toggled', { enabled })
      return state.snapshot()
    }
    case 'set-peer': {
      const deviceId = String(body.deviceId ?? '').trim()
      const peer = proxy.peers().find((candidate) => candidate.deviceId === deviceId)
      if (!deviceId) {
        state.setPeer('', '')
      } else if (!peer) {
        throw Object.assign(new Error('the selected device is not a paired dsh-sync peer'), { code: 'shadow/bad-request' })
      } else {
        state.setPeer(peer.deviceId, peer.name)
      }
      proxy.syncFromState()
      await proxy.refreshInfo(true).catch(() => {})
      audit.record({ action: 'display.peer', deviceId, ok: true })
      log?.info?.('display peer selected', { deviceId, name: peer?.name || '' })
      return state.snapshot()
    }
    case 'clear-audit': {
      audit.clear()
      log?.info?.('audit cleared')
      return { ok: true }
    }
    case 'refresh': {
      await proxy.refreshInfo(true).catch(() => {})
      log?.debug?.('panel refresh requested')
      return state.snapshot()
    }
    case 'client-log': {
      // Browser-side diagnostics (slot registration, page open/close, fetch
      // failures). The client never sends prompt/assistant text; still clamp.
      const scope = String(body.scope ?? 'client').slice(0, 40)
      const message = String(body.message ?? '').slice(0, 2000)
      debug?.write(body.level === 'error' ? 'error' : body.level === 'warn' ? 'warn' : 'debug', `client/${scope}`, message)
      return { ok: true }
    }
    default:
      throw Object.assign(new Error(`unknown panel action: ${action}`), { code: 'shadow/bad-request' })
  }
}

// The `dshSync` service is owned by this same plugin, not injected into this
// module's Host context. `attachShadow()` hands it over once; the panel then
// reads it through this module-level slot (never the Host context).
let sharedSync = null

/** Record the `dshSync` service used by the panel (null clears it). */
export function setShadowSync(api) {
  sharedSync = api || null
  return sharedSync
}

/** Read the dshSync service recorded by `attachShadow`. */
export function syncOf() {
  return sharedSync
}
