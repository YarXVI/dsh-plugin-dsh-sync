// Host half of the settings panel: one same-origin JSON endpoint.
import { isLoopback } from './net.js'

export const PANEL_ROUTE = '/plugins/dsh-plugin-dsh-sync/panel'

function json(res, status, value) {
  const body = Buffer.from(JSON.stringify(value))
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length, 'cache-control': 'no-store' })
  res.end(body)
}

async function readJson(req) {
  return await new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > 1024 * 1024) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')) } catch (error) { reject(error) }
    })
    req.on('error', reject)
  })
}

export function registerPanel(ctx, { getEngine, logger = null }) {
  const stops = []
  let connection = null
  const mount = { route: false, authMode: 'loopback', error: '' }

  const authorize = (req) => {
    const hasCookie = typeof req.headers?.cookie === 'string' && req.headers.cookie.length > 0
    if (hasCookie && typeof connection?.requestRejection === 'function') {
      const rejection = connection.requestRejection(req)
      return rejection === undefined ? { ok: true } : { ok: false, status: rejection }
    }
    if (isLoopback(req.socket?.remoteAddress)) return { ok: true }
    return { ok: false, status: 403 }
  }

  const statusForError = (code) => {
    if (code === 'bad-value') return 400
    if (code === 'role-locked' || code === 'push-not-allowed' || code === 'sub-single-host' || code === 'not-ready') return 409
    return 500
  }

  const run = async (action, payload = {}) => {
    const engine = getEngine()
    if (!engine) return { ok: false, status: 409, error: { code: 'not-ready', message: '同步引擎尚未启动' } }
    try {
      switch (action) {
        case 'state':
          return { ok: true, state: engine.state() }
        case 'sync':
        case 'sync-now':
        case 'immediate-sync': {
          const result = await engine.immediateSync()
          return { ok: true, ...result, state: engine.state() }
        }
        case 'set-role':
          return { ok: true, state: await engine.setRole(String(payload.role || '')) }
        case 'disconnect-all':
          return { ok: true, state: await engine.disconnectAll() }
        case 'set-realtime':
          return { ok: true, state: await engine.setRealtime(payload.enabled === true) }
        case 'set-local-only':
          return { ok: true, state: await engine.setLocalOnly(payload.enabled === true) }
        case 'set-shadow':
          return { ok: true, state: await engine.setShadowWorkspace(payload.enabled === true) }
        case 'set-cleanup':
          return { ok: true, state: await engine.setCleanup(payload.patch) }
        case 'cleanup-now': {
          const result = await engine.cleanupNow()
          return { ok: true, removed: result.removed, freed: result.freed, skipped: result.skipped || 0, state: engine.state() }
        }
        case 'conflict-keep': {
          const ids = [...(Array.isArray(payload.ids) ? payload.ids : []), ...(Array.isArray(payload.rels) ? payload.rels : [])]
          await engine.setConflictKeep(ids, payload.keep !== false)
          return { ok: true, state: engine.state() }
        }
        case 'conflict-delete': {
          const result = await engine.deleteConflicts(payload.ids, { recycle: payload.recycle })
          return { ok: true, removed: result.removed, freed: result.freed || 0, skipped: result.skipped || 0, state: engine.state() }
        }
        case 'list-items':
          return { ok: true, ...(await engine.listItems(String(payload.setId || ''))) }
        case 'preview-push':
          return { ok: true, ...(await engine.previewChanges(String(payload.deviceId || ''))) }
        case 'preview-pull':
          return { ok: true, ...(await engine.previewPull(String(payload.deviceId || ''))) }
        case 'preview-immediate':
          return { ok: true, ...(await engine.previewImmediate()) }
        case 'pair-start':
          return { ok: true, pair: await engine.pairStart(String(payload.deviceId || '')) }
        case 'pair-confirm':
          return { ok: true, peer: await engine.pairConfirm(String(payload.deviceId || '')) }
        case 'unpair':
          await engine.unpair(String(payload.deviceId || ''))
          return { ok: true, state: engine.state() }
        case 'set-sets':
          return { ok: true, enabled: await engine.setSets(payload.sets), state: engine.state() }
        case 'rename': {
          const name = await engine.identity.rename(payload.name)
          try { engine.discovery?.setName(name) } catch {}
          return { ok: true, name, state: engine.state() }
        }
        case 'set-group':
          await engine.identity.setGroup(payload.group)
          if (engine.discovery) engine.discovery.setGroup(engine.identity.groupId)
          return { ok: true, state: engine.state() }
        case 'add-manual':
          return { ok: true, ...(await engine.addManualPeer(String(payload.address || ''))) }
        case 'set-push-guard':
          return { ok: true, allowPush: await engine.setPushGuard(Boolean(payload.enabled)), state: engine.state() }
        case 'force-pull':
          return { ok: true, result: await engine.forcePull(String(payload.deviceId || '')), state: engine.state() }
        case 'push':
          return { ok: true, result: await engine.pushTo(String(payload.deviceId || '')), state: engine.state() }
        case 'clear-conflicts':
          await engine.clearConflicts()
          return { ok: true, state: engine.state() }
        case 'set-enabled':
          engine.config.enabled = Boolean(payload.enabled)
          if (engine.config.enabled) engine.scheduleCycle('enabled')
          return { ok: true, state: engine.state() }
        default:
          return { ok: false, status: 400, error: { code: 'unknown-action', message: '未知操作：' + action } }
      }
    } catch (error) {
      const code = String(error?.code || 'panel')
      if (code !== 'bad-value') logger?.warn?.('[dsh-sync] panel action failed:', error?.message)
      return { ok: false, status: statusForError(code), error: { code, message: String(error?.message || error) } }
    }
  }

  try {
    ctx.inject(['connection'], (scoped) => {
      try { connection = scoped.get('connection') || null } catch {}
    })
    ctx.inject(['webServer'], (scoped) => {
      try {
        const server = scoped.get('webServer')
        if (!server?.register) {
          mount.error = 'webServer.register missing'
          return
        }
        const route = {
          kind: 'prefix',
          path: PANEL_ROUTE,
          handler: async (req, res) => {
            const admission = authorize(req)
            if (!admission.ok) return json(res, admission.status, { ok: false, error: { code: 'forbidden', message: '仅允许本机 GUI 访问' } })
            try {
              if (req.method === 'GET') return json(res, 200, await run('state', {}))
              if (req.method === 'POST') {
                const payload = await readJson(req)
                const value = await run(String(payload.action || ''), payload)
                return json(res, value.ok ? 200 : (value.status || 400), value)
              }
              return json(res, 405, { ok: false, error: { code: 'method', message: 'GET or POST' } })
            } catch (error) {
              logger?.warn?.('[dsh-sync] panel request failed:', error?.message)
              return json(res, 500, { ok: false, error: { code: 'panel', message: String(error?.message || error) } })
            }
          },
        }
        stops.push(scoped.effect(() => server.register(route), 'dsh-sync: panel route'))
        mount.route = true
      } catch (error) {
        mount.error = String(error?.message || error)
      }
    })
  } catch (error) {
    mount.error = String(error?.message || error)
  }

  return () => {
    for (const stop of stops.splice(0)) {
      try { stop?.() } catch {}
    }
  }
}

export function panelMount() {
  return { ...mount }
}
