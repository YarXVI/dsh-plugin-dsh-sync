// Append-only audit log (JSONL) for the sharing (A) half.
//
// What is recorded: operation, peer device id, session/workspace ids, outcome,
// sizes and character counts. What is never recorded: prompt text, assistant
// text, tool arguments, file contents. The panel shows the newest rows; the
// file keeps a bounded history for later investigation.
import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { LIMITS } from './constants.js'
import { errorText } from './util.js'

/** Keys that must never appear in an audit row. */
const FORBIDDEN_KEYS = new Set(['text', 'prompt', 'content', 'arguments', 'result', 'body', 'message'])

/** Strip anything that could carry prompt/assistant content. */
export function sanitizeAuditRow(row) {
  const out = {}
  for (const [key, value] of Object.entries(row || {})) {
    if (FORBIDDEN_KEYS.has(key)) continue
    if (value === undefined) continue
    if (typeof value === 'string') out[key] = value.slice(0, 300)
    else if (typeof value === 'number' || typeof value === 'boolean' || value === null) out[key] = value
    else if (Array.isArray(value)) out[key] = value.slice(0, 20).map((item) => typeof item === 'string' ? item.slice(0, 120) : String(item).slice(0, 120))
    else out[key] = String(value).slice(0, 300)
  }
  return out
}

/**
 * Bounded JSONL audit sink with an in-memory ring for the panel.
 */
export class AuditLog {
  /**
   * @param {object} [options] - sink options.
   * @param {string} [options.file] - `$DSH_HOME/shadow-workspace/audit.jsonl`.
   * @param {number} [options.maxRows] - in-memory ring size.
   * @param {number} [options.maxFileBytes] - rotate when the file grows past this.
   * @param {object} [options.log] - logger.
   * @param {() => number} [options.now] - clock.
   */
  constructor(options = {}) {
    this.file = typeof options.file === 'string' ? options.file : ''
    this.maxRows = options.maxRows ?? LIMITS.maxAuditRows
    this.maxFileBytes = options.maxFileBytes ?? LIMITS.maxAuditFileBytes
    this.log = options.log || null
    this.now = typeof options.now === 'function' ? options.now : () => Date.now()
    this.rows = []
    this.loadTail()
  }

  /** Load the last rows from disk so the panel survives a restart. */
  loadTail() {
    if (!this.file) return
    let text
    try {
      text = readFileSync(this.file, 'utf8')
    } catch {
      return
    }
    const lines = text.split('\n').filter(Boolean).slice(-this.maxRows)
    for (const line of lines) {
      try {
        const row = JSON.parse(line)
        if (row && typeof row === 'object') this.rows.push(row)
      } catch {}
    }
  }

  /**
   * Record one audit row.
   * @param {object} row - op/session/peer/outcome/details.
   * @returns {object} the stored row.
   */
  record(row) {
    const entry = { at: new Date(this.now()).toISOString(), ...sanitizeAuditRow(row) }
    this.rows.push(entry)
    while (this.rows.length > this.maxRows) this.rows.shift()
    if (!this.file) return entry
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      this.#rotateIfNeeded()
      appendFileSync(this.file, JSON.stringify(entry) + '\n', 'utf8')
    } catch (error) {
      this.log?.warn?.('[shadow-workspace] audit append failed:', errorText(error))
    }
    return entry
  }

  /** Rotate `audit.jsonl` to a timestamped sibling when it exceeds the cap. */
  #rotateIfNeeded() {
    let size = 0
    try {
      size = statSync(this.file).size
    } catch {
      return
    }
    if (size < this.maxFileBytes) return
    const rotated = `${this.file}.${Date.now()}.bak`
    try {
      renameSync(this.file, rotated)
    } catch (error) {
      this.log?.warn?.('[shadow-workspace] audit rotate failed:', errorText(error))
    }
  }

  /** Newest `count` rows, oldest first. */
  last(count = LIMITS.panelAuditRows) {
    const limit = Math.max(1, Math.min(this.maxRows, Number(count) || LIMITS.panelAuditRows))
    return this.rows.slice(-limit).map((row) => ({ ...row }))
  }

  /** Remove the in-memory ring and the file (panel action). */
  clear() {
    this.rows = []
    if (!this.file) return
    try {
      rmSync(this.file, { force: true })
    } catch (error) {
      this.log?.warn?.('[shadow-workspace] audit clear failed:', errorText(error))
    }
  }
}

/** Best-effort unique temp path helper (kept here so audit owns no other module). */
export function auditTempName(file) {
  return `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`
}
