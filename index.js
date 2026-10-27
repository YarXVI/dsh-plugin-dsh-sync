// dsh-plugin-dsh-sync — host half.
//
// LAN peer-to-peer sync for one DSH account: sessions, workspace index,
// settings data, profile/plugin files and attachments. Discovery runs over UDP
// multicast; every authenticated request body is encrypted with X25519 +
// AES-256-GCM. See README.md and DESIGN.md.
import { resolveDshHome, stateDirFor } from './src/paths.js'
import { DEFAULTS, SyncEngine } from './src/engine.js'
import { Identity } from './src/identity.js'
import { registerPanel } from './src/panel.js'
import { SERVICE_NAME, createSyncService } from './src/broker.js'
import { attachShadow } from './shadow/index.js'

export const name = 'dsh-plugin-dsh-sync'
export const inject = []

function logOf(ctx) {
  const base = ctx?.logger || console
  return {
    info: (...args) => { try { base.info?.(...args) } catch {} },
    warn: (...args) => { try { base.warn?.(...args) } catch {} },
    error: (...args) => { try { base.error?.(...args) } catch {} },
  }
}

/**
 * Expose the broker as a Cordis service (`ctx.provide`). Older hosts / test
 * contexts may not implement `provide`: skip with a warning instead of failing
 * plugin boot, so dsh-sync keeps working standalone.
 */
function provideDshSync(ctx, api, log) {
  try {
    if (typeof ctx?.provide !== 'function') {
      log.warn('[dsh-sync] ctx.provide is unavailable; the dshSync service is not exposed to other plugins')
      return false
    }
    ctx.provide(SERVICE_NAME, api)
    return true
  } catch (error) {
    log.warn('[dsh-sync] failed to provide dshSync service:', String(error?.message || error))
    return false
  }
}

// One engine per DSH home even when Cordis applies the plugin twice (reload,
// duplicate rows). Otherwise two engines would bind two ports and announce
// conflicting beacon ports for the same device id.
function registry() {
  if (!globalThis.__dshSyncRegistry) globalThis.__dshSyncRegistry = new Map()
  return globalThis.__dshSyncRegistry
}

export function apply(ctx, rawConfig = {}) {
  const cfg = { ...DEFAULTS, ...(rawConfig || {}) }
  if (cfg.enabled === false) return
  const log = logOf(ctx)
  const home = resolveDshHome()
  const profile = process.env.DSH_PROFILE || 'desktop'
  const stateDir = stateDirFor(home)
  const key = `${home}|${profile}`

  const previous = registry().get(key)
  if (previous?.engine?.running) {
    previous.refs++
    if (previous.broker) provideDshSync(ctx, previous.broker.api, log)
    // A reload may dispose the previous fiber (and with it the shadow routes)
    // before applying this one, so re-attach the merged shadow feature against
    // the shared engine's broker.
    let sharedShadowDispose = null
    if (previous.broker) {
      try {
        sharedShadowDispose = attachShadow(ctx, { rpc: previous.broker.api, config: cfg.shadow || {}, logger: log }) || null
      } catch (error) {
        log.warn('[dsh-sync] failed to attach the shadow workspace feature (shared engine):', String(error?.message || error))
      }
    }
    ctx.effect(() => () => {
      try { sharedShadowDispose?.() } catch {}
      previous.refs--
      if (previous.refs <= 0) {
        registry().delete(key)
        previous.dispose()
      }
    }, 'dsh-sync: shared engine ref')
    return previous.ready
  }
  if (previous) {
    registry().delete(key)
    try { previous.dispose() } catch {}
  }

  let identity = null
  let engine = null
  let stopped = false
  let accountService = null
  let accountTimer = null
  // Disposer of the merged Shadow Workspace feature (see `shadow/index.js`).
  let shadowDispose = null

  // Created before the async boot because `ctx.provide()` must run during
  // apply(); the getter returns null until the engine exists.
  const broker = createSyncService({ getEngine: () => engine, config: cfg, logger: log })

  const readAccountId = async () => {
    try {
      const result = await accountService?.getDeviceIdentity?.()
      return result?.accountId || result?.account?.id || null
    } catch {
      return null
    }
  }

  async function boot() {
    identity = new Identity({
      stateDir,
      name: cfg.deviceName || '',
      group: cfg.group || '',
      logger: log,
    })
    await identity.load()
    const accountId = await readAccountId()
    if (accountId) identity.setAccountId(accountId)
    if (!identity.verifyKeyPair()) log.warn('[dsh-sync] device key pair is inconsistent')
    engine = new SyncEngine({
      home, profile, stateDir, identity, config: cfg, logger: log, accountId,
      hooks: {
        isSessionLive: (sessionId) => {
          try { return Boolean(ctx.sessions?.get?.(sessionId)) } catch { return false }
        },
      },
    })
    engine.setExtRpcHandler(broker.handleExtRpc)
    if (stopped) return
    if (cfg.autoStart !== false) await engine.start()
    log.info(`[dsh-sync] ready: device ${identity.name} (${identity.deviceId.slice(0, 8)}), group ${identity.groupId.slice(0, 8)}, port ${engine.port}`)
    accountTimer = setInterval(async () => {
      if (stopped || !identity) return
      const nextAccount = await readAccountId()
      if (!nextAccount) return
      if (identity.setAccountId(nextAccount)) {
        try {
          engine?.discovery?.setGroup(identity.groupId)
          engine?.emit?.('status')
        } catch {}
      }
    }, 60_000)
    accountTimer.unref?.()
  }

  try {
    ctx.inject(['deepseekAccount'], (scoped) => {
      try { accountService = scoped.get('deepseekAccount') || null } catch {}
    })
  } catch {}

  const ready = boot().catch((error) => {
    log.warn('[dsh-sync] failed to start:', String(error?.message || error))
  })

  const entry = {
    refs: 1,
    ready,
    broker,
    get engine() { return engine },
    dispose() {
      stopped = true
      if (accountTimer) clearInterval(accountTimer)
      try { shadowDispose?.() } catch {}
      try { broker.dispose() } catch {}
      Promise.resolve(engine?.stop?.()).catch(() => {})
    },
  }
  registry().set(key, entry)

  provideDshSync(ctx, broker.api, log)

  ctx.effect(() => () => {
    entry.refs--
    if (entry.refs <= 0) {
      registry().delete(key)
      entry.dispose()
    }
  }, 'dsh-sync: engine lifecycle')

  registerPanel(ctx, { getEngine: () => engine, logger: log })

  // Shadow Workspace ships inside this bundle now (formerly
  // dsh-plugin-shadow-workspace). It shares the broker exposed as `dshSync`
  // above, so one install gives both the device-sync UI and the shadow UI.
  try {
    shadowDispose = attachShadow(ctx, { rpc: broker.api, config: cfg.shadow || {}, logger: log }) || null
  } catch (error) {
    log.warn('[dsh-sync] failed to attach the shadow workspace feature:', String(error?.message || error))
  }

  return ready
}
