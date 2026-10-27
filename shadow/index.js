// dsh-plugin-dsh-sync — Shadow Workspace host half (merged from
// dsh-plugin-shadow-workspace 0.1.1).
//
// This module is not a Cordis plugin entry of its own: the top-level
// `index.js` calls `attachShadow(ctx, { rpc: broker.api, config, logger })`
// after it has started its engine and exposed the `dshSync` service. One
// bundle row therefore installs both the device-sync feature and this one.
//
//   sharing half (A)  drives `ctx.sessionController`, mirrors `session/event` +
//                     `agent/assistant-stream`, answers `approval/request` from
//                     this machine's panel/peer, and serves `ext.shadow.*` over
//                     dsh-sync's `dshSync` broker.
//
//   display half (B)  proxies a paired machine's shadow sessions, keeps a local
//                     mirror, and exposes two same-origin routes to this
//                     machine's Web client (settings panel + session data).
//
// Whether a machine shares or displays is operator state under
// `$DSH_HOME/shadow-workspace/state.json`, toggled from the panel. Nothing is
// shared by default; the display half starts enabled but shows nothing until a
// paired device is selected.
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  AUDIT_FILE,
  DATA_ROUTE,
  PANEL_ROUTE,
  PLUGIN_VERSION,
  SESSIONS_FILE,
  UPLOADS_DIR,
} from './src/constants.js'
import { AuditLog } from './src/audit.js'
import { DebugLog, debugLogPath } from './src/debug-log.js'
import { createLogger } from './src/logger.js'
import { ShadowStateStore } from './src/state.js'
import { ShadowHostBridge } from './src/session-bridge.js'
import { ShadowClientProxy } from './src/b-proxy.js'
import { registerShadowRpc } from './src/a-rpc.js'
import { createPanelHandler, setShadowSync } from './src/panel-route.js'
import { createDataHandler } from './src/local-route.js'
import { mountRoute } from './src/http.js'

export const name = 'dsh-plugin-dsh-sync-shadow'
export const inject = []

/**
 * Normalize the Loader config. The merged plugin carries no shadow config by
 * default; `cordis.patch.yml` may set `shadow:` keys as operator overrides.
 * @param {any} raw - plugin config (`dsh-sync` config.shadow in the patch row).
 * @returns {object} complete config.
 */
export function normalizeConfig(raw) {
  const input = raw && typeof raw === 'object' ? raw : {}
  const uploads = input.uploads && typeof input.uploads === 'object' ? input.uploads : {}
  return {
    enabled: input.enabled !== false,
    stateDir: typeof input.stateDir === 'string' ? input.stateDir.trim() : '',
    approvalTtlMs: positive(input.approvalTtlMs, 60_000, 50, 10 * 60 * 1000),
    presenceTtlMs: positive(input.presenceTtlMs, 45_000, 5_000, 5 * 60 * 1000),
    eventsWaitMs: positive(input.eventsWaitMs, 15_000, 1_000, 25_000),
    rpcTimeoutMs: positive(input.rpcTimeoutMs, 25_000, 2_000, 60_000),
    maxOpenSessions: positive(input.maxOpenSessions, 4, 1, 16),
    promptsPerMinute: positive(input.promptsPerMinute, 20, 1, 600),
    uploads: {
      // Receive-side chunked file transfer is opt-in (0.9.0): a peer cannot
      // push files until the operator enables it here or grants that device.
      enabled: uploads.enabled === true,
      maxBytes: positive(uploads.maxBytes, 64 * 1024 * 1024, 1024, 1024 * 1024 * 1024),
      // Keep one base64 chunk inside dsh-sync's 1 MB request budget.
      chunkBytes: positive(uploads.chunkBytes, 512 * 1024, 16 * 1024, 700 * 1024),
    },
    uploadsDir: typeof input.uploadsDir === 'string' ? input.uploadsDir.trim() : '',
    debug: input.debug === true,
  }
}

/** Positive integer within bounds. */
function positive(value, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.max(min, Math.min(max, Math.floor(n)))
}

/** DSH home, matching dsh-sync's convention (`$DSH_HOME` or `~/.dsh`). */
export function resolveDshHome(env = process.env) {
  const configured = typeof env?.DSH_HOME === 'string' ? env.DSH_HOME.trim() : ''
  if (configured) return resolve(configured)
  return join(homedir(), '.dsh')
}

/** Directory holding this plugin's product state. */
export function resolveStateDir(config, env = process.env) {
  if (config?.stateDir) return resolve(config.stateDir)
  return join(resolveDshHome(env), 'shadow-workspace')
}

/**
 * Directory that receives pushed files: `<DSH_HOME>/shadow-uploads`.
 * Explicit config can override it, but it always stays its own directory (not
 * the state dir) so a transfer is a user artifact, not plugin state.
 * @param {object} config - normalized plugin config.
 * @param {object} [env] - environment (`DSH_HOME`).
 * @returns {string} absolute upload directory.
 */
export function resolveUploadsDir(config, env = process.env) {
  if (config?.uploadsDir) return resolve(config.uploadsDir)
  return join(resolveDshHome(env), UPLOADS_DIR)
}

/** Console-like logger from a Host context. */
function loggerOf(ctx) {
  const base = ctx?.logger || console
  return {
    info: (...args) => { try { base.info?.(...args) } catch {} },
    warn: (...args) => { try { base.warn?.(...args) } catch {} },
    error: (...args) => { try { base.error?.(...args) } catch {} },
  }
}

/** One-per-state-dir singleton guard: a hot reload must not stack bridges. */
function registry() {
  if (!globalThis.__dshShadowWorkspaceRegistry) globalThis.__dshShadowWorkspaceRegistry = new Map()
  return globalThis.__dshShadowWorkspaceRegistry
}

/**
 * Attach the Shadow Workspace feature to the already-started dsh-sync plugin.
 *
 * The caller owns the `dshSync` service, so this function never probes or
 * injects the service; everything it needs is passed in through `options`.
 *
 * @param {object} ctx - Cordis Host context.
 * @param {object} [options] - integration options.
 * @param {object} [options.rpc] - the `dshSync` broker API (`broker.api`).
 * @param {any} [options.config] - shadow tuning overrides (`config.shadow`).
 * @param {object} [options.logger] - base logger of the owning plugin.
 * @returns {(() => void)|undefined} disposer, or undefined when disabled.
 */
export function attachShadow(ctx, options = {}) {
  const shared = options.rpc || null
  const rawConfig = options.config || {}
  const config = normalizeConfig(rawConfig)
  if (!config.enabled) return
  const provided = options.logger
  const baseLog = provided && (typeof provided === 'object' || typeof provided === 'function')
    ? provided
    : loggerOf(ctx)
  const stateDir = resolveStateDir(config)
  const uploadsDir = resolveUploadsDir(config)
  const key = stateDir
  const previous = registry().get(key)
  if (previous?.alive) {
    previous.refs += 1
    previous.logger?.info?.('attachShadow: reused existing instance', { refs: previous.refs, stateDir })
    const release = () => {
      if (previous.refs <= 0) return
      previous.refs -= 1
      if (previous.refs <= 0) {
        registry().delete(key)
        previous.dispose()
      }
    }
    ctx.effect(() => release, 'shadow-workspace: shared instance ref')
    return release
  }
  if (previous) {
    registry().delete(key)
    try { previous.dispose() } catch {}
  }

  const debugLog = new DebugLog({ file: debugLogPath(stateDir), log: baseLog })
  const log = createLogger({ base: baseLog, debug: debugLog, scope: 'host' })
  const hasWebServer = Boolean(safeGet(ctx, 'webServer'))
  log.info('attachShadow: start', {
    version: PLUGIN_VERSION,
    stateDir,
    uploadsDir,
    uploadsEnabled: config.uploads.enabled,
    role: 'both',
    dshSync: Boolean(shared),
    webServer: hasWebServer,
    debugLog: debugLog.path || '(disabled)',
  })

  // The panel route asks `syncOf()` (module-level, set here) instead of reading
  // the Host context, because this module is not injected with the service.
  setShadowSync(shared)

  const state = new ShadowStateStore({ dir: stateDir, log: log.child('state') })
  const audit = new AuditLog({ file: join(stateDir, AUDIT_FILE), log: log.child('audit') })
  const bridge = new ShadowHostBridge({
    ctx,
    state,
    audit,
    log: log.child('bridge'),
    store: join(stateDir, SESSIONS_FILE),
    config,
    uploadsDir,
  })
  const proxy = new ShadowClientProxy({ state, log: log.child('proxy'), config: { ...config, uploadsDir } })
  const disposers = []
  let webServerSeen = hasWebServer

  bridge.start()
  log.info('apply: sharing bridge started', { managedSessions: bridge.registry.list().length, sharing: state.sharingActive })

  const unsubscribe = state.subscribe(() => {
    try { bridge.syncFromState() } catch (error) { log.warn('apply: sharing sync failed', error) }
    try { proxy.syncFromState() } catch (error) { log.warn('apply: display sync failed', error) }
    log.info('apply: state changed', { sharing: state.sharingActive, display: state.displayActive })
  })
  disposers.push(unsubscribe)

  // dsh-sync wiring. The broker is owned by the caller, so it is attached
  // directly here (no `ctx.inject(['dshSync'])`): the merged plugin starts both
  // halves in the same apply() pass.
  try {
    bridge.attachSync(shared)
    proxy.attachSync(shared)
    log.info('apply: dshSync attached', {
      hasRegisterRpc: typeof shared?.registerRpc === 'function',
      hasRpc: typeof shared?.rpc === 'function',
      hasPeerEvents: typeof shared?.onPeerEvent === 'function',
    })
  } catch (error) {
    log.error('apply: failed to attach dshSync', error)
  }
  try {
    if (shared) {
      const disposeRpc = registerShadowRpc(shared, bridge, log.child('rpc'))
      if (typeof disposeRpc === 'function') disposers.push(disposeRpc)
    }
  } catch (error) {
    log.error('apply: failed to register ext.shadow.* ops', error)
  }
  // Peer events refresh the display half when a paired device appears/leaves.
  // attachShadow() runs before the owning plugin's engine has finished booting
  // (`broker.api.onPeerEvent` needs a live engine), so retry briefly until the
  // subscription can be installed instead of losing it for the whole session.
  let peerSubscriptionTimer = null
  let peerSubscriptionAttempts = 0
  const onPeerEvent = (event) => {
    if (!event) return
    if (event.type === 'status' || event.type === 'peer' || event.type === 'peer-lost' || event.type === 'peer-updated') {
      log.debug('apply: peer event', { type: event.type, deviceId: event.deviceId || '' })
      void proxy.refreshInfo(true).catch(() => {})
    }
  }
  const installPeerSubscription = () => {
    peerSubscriptionTimer = null
    if (!shared || typeof shared.onPeerEvent !== 'function') return
    try {
      const disposePeer = shared.onPeerEvent(onPeerEvent)
      if (typeof disposePeer === 'function') disposers.push(disposePeer)
      peerSubscriptionAttempts = 0
      log.info('apply: peer event subscription installed')
    } catch (error) {
      peerSubscriptionAttempts += 1
      if (peerSubscriptionAttempts >= 40) {
        log.warn('apply: peer event subscription unavailable; peer changes will not auto-refresh', error)
        return
      }
      peerSubscriptionTimer = setTimeout(installPeerSubscription, 250)
      peerSubscriptionTimer.unref?.()
    }
  }
  installPeerSubscription()
  void proxy.refreshInfo(true).catch((error) => {
    log.warn('apply: initial peer refresh failed', error)
  })
  log.info('apply: dsh-sync extension channel ready; serving ext.shadow.*')

  // Local routes for this machine's Web client. Registered independently of
  // the sync engine so the panel can explain a missing dependency. The panel
  // route is a strict prefix of the data route; the Host router prefers the
  // longest prefix, so both resolve regardless of registration order.
  ctx.inject(['webServer'], (scoped) => {
    webServerSeen = true
    const panelLog = log.child('panel')
    const dataLog = log.child('data')
    const panelDispose = mountRoute(
      scoped,
      PANEL_ROUTE,
      createPanelHandler({ ctx, state, audit, bridge, proxy, log: panelLog, debug: debugLog }),
      panelLog,
    )
    const dataDispose = mountRoute(
      scoped,
      DATA_ROUTE,
      createDataHandler({ ctx, proxy, log: dataLog }),
      dataLog,
    )
    log.info('apply: local routes mounted', { panel: Boolean(panelDispose), data: Boolean(dataDispose) })
    scoped.effect(() => () => {
      try { panelDispose?.() } catch {}
      try { dataDispose?.() } catch {}
      log.info('apply: local routes disposed')
    }, 'shadow-workspace: local routes')
  })

  const entry = {
    refs: 1,
    alive: true,
    debugLog,
    logger: log,
    state,
    audit,
    bridge,
    proxy,
    dispose() {
      if (!entry.alive) return
      entry.alive = false
      log.info('apply: dispose')
      if (peerSubscriptionTimer) clearTimeout(peerSubscriptionTimer)
      unsubscribe()
      proxy.dispose()
      bridge.dispose()
      for (const dispose of disposers.splice(0)) {
        try { dispose?.() } catch {}
      }
      try { setShadowSync(null) } catch {}
    },
  }
  registry().set(key, entry)

  ctx.effect(() => () => {
    entry.refs -= 1
    if (entry.refs <= 0) {
      registry().delete(key)
      entry.dispose()
    }
  }, 'shadow-workspace: lifecycle')

  log.info('apply: ready', {
    version: PLUGIN_VERSION,
    stateDir,
    uploadsDir,
    uploadsEnabled: config.uploads.enabled,
    sharing: state.sharingActive,
    display: state.displayActive,
    dshSync: Boolean(shared),
    webServer: webServerSeen,
    debugLog: debugLog.path || '(disabled)',
  })

  // Returning the disposer keeps programmatic hosts able to tear the merged
  // feature down deterministically; Cordis ignores a function return.
  return () => entry.dispose()
}

/** Read a Host service without throwing during early startup. */
function safeGet(ctx, name) {
  try {
    return typeof ctx?.get === 'function' ? ctx.get(name) : undefined
  } catch {
    return undefined
  }
}
