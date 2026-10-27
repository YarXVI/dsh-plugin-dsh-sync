// Small HTTP helpers shared by this plugin's two local routes:
//   - `/panel`  settings/audit/devices (both halves)
//   - `/rpc`    shadow session data (display half)
//
// Both routes are only reachable from the local GUI: authenticated browser
// cookie when a dsh connection service exists, otherwise loopback only.
import { isLoopback } from './util.js'

/** Body cap for both local routes. */
export const MAX_LOCAL_BODY = 1024 * 1024

/** Custom header the bundled Web client sends on every panel/data request. */
export const CLIENT_HEADER = 'x-shadow-client'

/** Value of {@link CLIENT_HEADER} that marks a request as our own client. */
export const CLIENT_HEADER_VALUE = '1'

/** Write one JSON response. */
export function sendJson(res, status, value) {
  const body = Buffer.from(JSON.stringify(value))
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
  })
  res.end(body)
}

/** Read one bounded JSON body. */
export async function readJsonBody(req, limit = MAX_LOCAL_BODY) {
  return await new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(Object.assign(new Error('body too large'), { statusCode: 413 }))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8')
        resolve(text ? JSON.parse(text) : {})
      } catch {
        reject(Object.assign(new Error('body is not JSON'), { statusCode: 400 }))
      }
    })
    req.on('error', reject)
  })
}

/**
 * Build the authorization check for the local routes.
 *
 * Threat model: any local process, and any web page the user visits, can reach
 * loopback. A cookie-only check is not CSRF protection here, so every request
 * must additionally carry our custom header (a cross-site request with a
 * custom header triggers a CORS preflight that this route never approves), and
 * a cross-site `Origin` is rejected even for loopback callers.
 * @param {object} ctx - Host context (may expose `connection`).
 * @returns {(req: any) => {ok: true} | {ok: false, status: number, code?: string}}
 */
export function createAuthorizer(ctx) {
  const connectionOf = () => {
    try {
      return ctx && typeof ctx.get === 'function' ? ctx.get('connection') : undefined
    } catch {
      return undefined
    }
  }
  const reject = (status, code) => ({ ok: false, status, code })
  return (req) => {
    const headers = req?.headers && typeof req.headers === 'object' ? req.headers : {}
    if (String(headers[CLIENT_HEADER] ?? '') !== CLIENT_HEADER_VALUE) {
      return reject(403, 'shadow/client-header-required')
    }
    const origin = typeof headers.origin === 'string' ? headers.origin : ''
    if (origin && !originMatches(origin, headers.host)) {
      return reject(403, 'shadow/cross-origin')
    }
    const connection = connectionOf()
    const cookie = typeof headers.cookie === 'string' ? headers.cookie : ''
    if (cookie && typeof connection?.requestRejection === 'function') {
      try {
        const rejection = connection.requestRejection(req)
        if (rejection !== undefined) return reject(Number(rejection) || 401, 'shadow/connection-rejected')
      } catch {
        return reject(401, 'shadow/connection-rejected')
      }
    }
    if (isLoopback(req?.socket?.remoteAddress)) return { ok: true }
    if (typeof connection?.requestRejection === 'function') {
      try {
        const rejection = connection.requestRejection(req)
        return rejection === undefined ? { ok: true } : reject(Number(rejection) || 401, 'shadow/connection-rejected')
      } catch {
        return reject(401, 'shadow/connection-rejected')
      }
    }
    return reject(403, 'shadow/loopback-only')
  }
}

/** Whether a browser `Origin` header is same-origin with this request. */
function originMatches(origin, hostHeader) {
  try {
    const url = new URL(origin)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
    const host = typeof hostHeader === 'string' ? hostHeader.trim().toLowerCase() : ''
    if (host) return url.host.toLowerCase() === host
    return url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]'
  } catch {
    return false
  }
}

/**
 * Register a prefix route and return a disposer, tolerating a Host without a
 * Web server (the plugin then degrades to "no panel" instead of crashing).
 * @param {object} scoped - injected context owning the route effect.
 * @param {string} path - prefix path.
 * @param {(req: any, res: any) => Promise<void>} handler - request handler.
 * @param {object} [log] - logger.
 * @returns {(() => void)|null} disposer or null.
 */
export function mountRoute(scoped, path, handler, log = null) {
  const server = scoped?.get?.('webServer')
  if (!server || typeof server.register !== 'function') {
    log?.warn?.(`[shadow-workspace] webServer unavailable; route ${path} not mounted`)
    return null
  }
  const dispose = server.register({ kind: 'prefix', path, handler })
  return typeof dispose === 'function' ? dispose : () => {}
}
