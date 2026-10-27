// Logger wrapper: every Host-side log line goes to the process console *and*
// the durable debug.log, with a scope such as `host`, `host/bridge`,
// `host/panel`, `host/proxy`, `host/rpc`.
//
// The wrapper formats arguments itself (no dependency on inspect being safe):
// strings are kept, numbers/booleans inline, plain objects JSON-stringified
// shallowly, Errors reduced to their first stack line. All lines pass through
// DebugLog.sanitizeLine(), so credentials/prompt-shaped text are redacted even
// if a caller accidentally passes one.
import { inspect } from 'node:util'
import { firstStackLine } from './debug-log.js'

/** Render one argument for a log line. */
function formatArg(value) {
  if (value === undefined) return 'undefined'
  if (value === null) return 'null'
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value)
  if (value instanceof Error) return value.message || String(value)
  try {
    return inspect(value, { depth: 2, breakLength: Infinity, maxArrayLength: 12, maxStringLength: 400 })
  } catch {
    return String(value)
  }
}

/**
 * Create a scoped logger.
 * @param {object} [options] - logger options.
 * @param {object} [options.base] - console-like base logger ({info,warn,error,debug}).
 * @param {import('./debug-log.js').DebugLog} [options.debug] - durable sink.
 * @param {string} [options.scope] - scope label.
 * @returns {{info: Function, warn: Function, error: Function, debug: Function, child: (scope: string) => object}}
 */
export function createLogger(options = {}) {
  const base = options.base || console
  const debug = options.debug || null
  const scope = String(options.scope || 'host')

  const emit = (level) => (...args) => {
    try {
      const fn = base[level] || base.info || base.log
      if (typeof fn === 'function') fn.apply(base, args)
    } catch {}
    if (!debug) return
    try {
      const error = args.find((value) => value instanceof Error)
      const message = args
        .filter((value) => !(value instanceof Error))
        .map(formatArg)
        .join(' ')
      debug.write(level, scope, message || (error ? error.message : ''), error || undefined)
    } catch {}
  }

  const logger = {
    info: emit('info'),
    warn: emit('warn'),
    error: emit('error'),
    debug: emit('debug'),
    /** Derive a nested scope (`host/bridge`). */
    child(nextScope) {
      return createLogger({ base, debug, scope: `${scope}/${String(nextScope || 'child')}` })
    },
    /** The durable sink (or null); useful for the panel route. */
    debugSink: debug,
  }
  return logger
}

/** First line of an unexpected error, for call sites that catch separately. */
export { firstStackLine }
