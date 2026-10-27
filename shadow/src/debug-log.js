// Durable debug log for the Shadow Workspace plugin.
//
// Why a file: on a user machine the Host log only exists in the DSH process
// console, which the operator cannot open while troubleshooting "the sidebar
// entry never appeared". This log makes every Host-side diagnostic available at
//
//   $DSH_HOME\shadow-workspace\debug.log
//
// Format: one line per entry
//   <ISO-8601 time> <level> <scope> <message>
// Rotation: when the file would grow past 1 MB it becomes `debug.log.1`
// (replacing an older `.1`), and a fresh `debug.log` starts. Two files max.
//
// Content rules: IDs, counts, sizes, error stack first lines only. Callers must
// not pass prompt/assistant text or secrets; sanitizeLine() additionally
// truncates, collapses newlines and redacts common credential shapes.
import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { dirname } from 'node:path'

/** Default max size of one debug log file (1 MB). */
export const DEBUG_LOG_MAX_BYTES = 1024 * 1024

/** How many rotated siblings to keep (debug.log.1 only). */
export const DEBUG_LOG_BACKUPS = 1

/** Longest single message kept after truncation. */
export const DEBUG_LINE_MAX_CHARS = 2000

/**
 * Collapse and redact one debug line.
 * @param {string} text - untrusted text.
 * @returns {string} one safe line.
 */
export function sanitizeLine(text) {
  let value = String(text ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
  value = value
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, 'sk-***')
    .replace(/\b(Bearer)\s+[A-Za-z0-9._~+/-]{8,}=*/gi, '$1 ***')
    .replace(/\b(api[-_]?key|token|secret|password|authorization)\s*[=:]\s*\S+/gi, '$1=***')
    .replace(/\b[A-Fa-f0-9]{48,}\b/g, '***')
  if (value.length > DEBUG_LINE_MAX_CHARS) value = `${value.slice(0, DEBUG_LINE_MAX_CHARS)}…[truncated]`
  return value
}

/** First stack line of an error (or its message) for log lines. */
export function firstStackLine(error) {
  if (!error) return ''
  const stack = typeof error.stack === 'string' ? error.stack : ''
  const line = stack.split('\n').map((entry) => entry.trim()).filter(Boolean)[0]
  return sanitizeLine(line || error.message || String(error))
}

/**
 * Append-only debug log with size-based rotation.
 */
export class DebugLog {
  /**
   * @param {object} [options] - log options.
   * @param {string} [options.file] - absolute `debug.log` path ('' disables).
   * @param {number} [options.maxBytes] - rotate threshold.
   * @param {number} [options.backups] - rotated siblings kept.
   * @param {object} [options.log] - fallback logger (write failures only).
   * @param {() => number} [options.now] - clock.
   */
  constructor(options = {}) {
    this.file = typeof options.file === 'string' ? options.file : ''
    this.maxBytes = Math.max(1024, Number(options.maxBytes) || DEBUG_LOG_MAX_BYTES)
    this.backups = Math.max(0, Math.min(5, Number(options.backups) || DEBUG_LOG_BACKUPS))
    this.log = options.log || null
    this.now = typeof options.now === 'function' ? options.now : () => Date.now()
    this.bytes = 0
    this.disabled = !this.file
    if (this.disabled) return
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      this.bytes = existsSync(this.file) ? statSync(this.file).size : 0
    } catch {
      this.disabled = true
    }
  }

  /** Path shown in the panel (empty when disabled). */
  get path() {
    return this.disabled ? '' : this.file
  }

  /**
   * Write one formatted line.
   * @param {string} level - debug|info|warn|error.
   * @param {string} scope - subsystem (apply/rpc/panel/bridge/proxy/client/...).
   * @param {string} message - already-safe message text.
   * @param {Error} [error] - optional error appended as its first stack line.
   * @returns {string} the written line (without trailing newline).
   */
  write(level, scope, message, error) {
    const levelName = /^(debug|info|warn|error)$/.test(String(level)) ? String(level) : 'info'
    const time = new Date(this.now()).toISOString()
    const scopeName = sanitizeLine(scope || 'host').slice(0, 40)
    let line = `${time} ${levelName} ${scopeName} ${sanitizeLine(message)}`
    if (error) line += ` | ${firstStackLine(error)}`
    if (this.disabled) return line
    try {
      const payload = `${line}\n`
      const size = Buffer.byteLength(payload, 'utf8')
      this.#rotateIfNeeded(size)
      appendFileSync(this.file, payload, 'utf8')
      this.bytes += size
    } catch (error) {
      this.disabled = true
      this.log?.warn?.('[shadow-workspace] debug log disabled after write failure:', firstStackLine(error))
    }
    return line
  }

  /** Rotate when the next line would exceed the cap. */
  #rotateIfNeeded(nextBytes) {
    if (!existsSync(this.file)) {
      this.bytes = 0
      return
    }
    if (this.bytes + nextBytes <= this.maxBytes) return
    try {
      if (this.backups <= 0) {
        rmSync(this.file, { force: true })
      } else {
        const oldest = `${this.file}.${this.backups}`
        try { rmSync(oldest, { force: true }) } catch {}
        for (let index = this.backups - 1; index >= 1; index -= 1) {
          const from = `${this.file}.${index}`
          const to = `${this.file}.${index + 1}`
          if (!existsSync(from)) continue
          try { renameSync(from, to) } catch {}
        }
        try { renameSync(this.file, `${this.file}.1`) } catch {}
      }
      this.bytes = 0
    } catch (error) {
      this.log?.warn?.('[shadow-workspace] debug log rotation failed:', firstStackLine(error))
    }
  }

  /** Current file size (for tests / diagnostics). */
  size() {
    if (this.disabled) return 0
    try {
      return statSync(this.file).size
    } catch {
      return 0
    }
  }
}

/** Default path under the plugin state directory. */
export function debugLogPath(stateDir) {
  return stateDir ? `${stateDir}/debug.log` : ''
}

/** Size cap exported for documentation/tests. */
export const DEBUG_LOG_LIMIT = DEBUG_LOG_MAX_BYTES
