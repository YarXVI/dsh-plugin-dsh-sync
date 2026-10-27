// A-side RPC registration: bind the bridge's `handleRpc` to the dsh-sync
// `dshSync` broker.
//
// dsh-sync 0.5.1 lets a plugin declare its own ops with
// `registerRpc(op, handler, { allow: true })`, so installing this bundle is
// enough — no profile `extRpcAllow` editing. dsh-sync still enforces:
//   - paired peers only, encrypted transport, identity match;
//   - op names matching /^ext\.[a-z0-9][a-z0-9._-]{0,63}$/;
//   - the `extRpcDisableAll` master switch;
//   - 1 MB request / 8 MB response / 10 s default timeout.
import { HOST_OPS, OPS } from './constants.js'
import { errorText } from './util.js'

/**
 * Register every shadow op on a `dshSync` service.
 * @param {object} sync - `dshSync` service (`registerRpc(op, handler, {allow})`).
 * @param {import('./session-bridge.js').ShadowHostBridge} bridge - sharing bridge.
 * @param {object} [log] - logger.
 * @returns {() => void} disposer removing every op.
 */
export function registerShadowRpc(sync, bridge, log = null) {
  if (!sync || typeof sync.registerRpc !== 'function') {
    throw new Error('registerShadowRpc: a dshSync service with registerRpc() is required (dsh-sync 0.5.1+)')
  }
  const disposers = []
  const failed = []
  for (const op of HOST_OPS) {
    // Third argument is ignored by older dsh-sync builds; on 0.5.1 it makes the
    // op self-declared and therefore usable without profile config edits.
    try {
      const dispose = sync.registerRpc(op, async (request, context) => {
        const payload = request?.payload ?? null
        const peer = context?.peer ?? null
        const started = Date.now()
        try {
          const result = await bridge.handleRpc(op, payload, peer)
          log?.debug?.('handler ok', { op, peer: String(peer?.deviceId || ''), ms: Date.now() - started })
          return result
        } catch (error) {
          log?.warn?.('handler failed', { op, peer: String(peer?.deviceId || ''), code: String(error?.code || ''), ms: Date.now() - started, error })
          throw error
        }
      }, { allow: true })
      if (typeof dispose === 'function') disposers.push(dispose)
      log?.info?.('registerRpc ok', { op, allow: true })
    } catch (error) {
      failed.push({ op, error })
      log?.error?.('registerRpc failed', { op }, error)
    }
  }
  if (failed.length > 0) {
    const error = new Error(`failed to register ${failed.length} shadow RPC op(s): ${failed.map((row) => `${row.op}: ${errorText(row.error)}`).join('; ')}`)
    error.causes = failed.map((row) => row.error)
    throw error
  }
  return () => {
    for (const dispose of disposers.splice(0)) {
      try { dispose() } catch {}
    }
    log?.info?.('registerRpc disposed', { count: HOST_OPS.length })
  }
}

/** Ops this plugin serves (re-exported for tests and documentation). */
export const SERVED_OPS = HOST_OPS

/** Ops the display half calls (same closed set, from the client side). */
export const CLIENT_OPS = Object.freeze([
  OPS.ping, OPS.info, OPS.list, OPS.create, OPS.prompt, OPS.cancel, OPS.events, OPS.approvals, OPS.answer,
])
