// Durable list of Shadow Sessions A manages.
//
// Persisting the registry is what lets A restart and keep serving the same
// shadow sessions: the Session log survives in DSH's own persistence, and the
// bridge re-reads it cold (`sessionController.inspect`) on the next `events`
// call. The file contains identities and display metadata only — never prompt
// text, tool output, or credentials.
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

/** Registry file name under the plugin's state directory. */
export const REGISTRY_FILE = 'shadow-sessions.json'

/** Bumped when the persisted shape changes. */
const FORMAT = 1

/**
 * Session registry with atomic JSON persistence (best effort: a read-only or
 * missing state dir disables persistence but never breaks the bridge).
 */
export class SessionRegistry {
  /**
   * @param {object} [options] - storage options.
   * @param {string} [options.file] - absolute JSON path; '' disables persistence.
   * @param {object} [options.log] - logger.
   */
  constructor(options = {}) {
    this.file = typeof options.file === 'string' ? options.file : ''
    this.log = options.log || null
    this.sessions = new Map()
    this.load()
  }

  /** Absolute path of one session's registry file (tests use this). */
  static fileFor(dir) {
    return join(dir, REGISTRY_FILE)
  }

  /** Read the persisted registry. */
  load() {
    this.sessions.clear()
    if (!this.file) return
    let parsed
    try {
      parsed = JSON.parse(readFileSync(this.file, 'utf8'))
    } catch {
      return
    }
    if (!parsed || parsed.format !== FORMAT || !Array.isArray(parsed.sessions)) return
    for (const row of parsed.sessions) {
      const sessionId = typeof row?.sessionId === 'string' ? row.sessionId : ''
      const workspaceId = typeof row?.workspaceId === 'string' ? row.workspaceId : ''
      if (!sessionId || !workspaceId) continue
      this.sessions.set(sessionId, {
        sessionId,
        workspaceId,
        title: typeof row.title === 'string' ? row.title : '',
        creatorPeerId: typeof row.creatorPeerId === 'string' ? row.creatorPeerId : '',
        createdAt: typeof row.createdAt === 'string' ? row.createdAt : new Date().toISOString(),
        updatedAt: typeof row.updatedAt === 'string' ? row.updatedAt : new Date().toISOString(),
        lastText: '',
        lastTurnReason: null,
        lastModel: modelSelectionOf(row.lastModel),
      })
    }
  }

  /** Persist the registry atomically; failures only log. */
  persist() {
    if (!this.file) return
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      const body = JSON.stringify({
        format: FORMAT,
        sessions: [...this.sessions.values()].map((row) => ({
          sessionId: row.sessionId,
          workspaceId: row.workspaceId,
          title: row.title,
          creatorPeerId: row.creatorPeerId || '',
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
          ...(row.lastModel === null || row.lastModel === undefined ? {} : { lastModel: row.lastModel }),
        })),
      }, null, 2)
      const tmp = `${this.file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`
      try {
        writeFileSync(tmp, body, 'utf8')
        renameSync(tmp, this.file)
      } catch (error) {
        try { rmSync(tmp, { force: true }) } catch {}
        throw error
      }
    } catch (error) {
      this.log?.warn?.('[shadow-workspace] registry write failed:', String(error?.message || error))
    }
  }

  /** Insert or replace one session row. */
  add(row) {
    const sessionId = String(row?.sessionId ?? '')
    if (!sessionId) return null
    const record = {
      sessionId,
      workspaceId: String(row.workspaceId ?? ''),
      title: String(row.title ?? ''),
      creatorPeerId: String(row.creatorPeerId ?? ''),
      createdAt: String(row.createdAt ?? new Date().toISOString()),
      updatedAt: new Date().toISOString(),
      lastText: '',
      lastTurnReason: null,
      lastModel: modelSelectionOf(row.lastModel),
    }
    this.sessions.set(sessionId, record)
    this.persist()
    return record
  }

  /** Read one session row. */
  get(sessionId) {
    return this.sessions.get(String(sessionId)) || null
  }

  /** Update display metadata (title / last assistant text / turn reason). */
  update(sessionId, patch) {
    const record = this.sessions.get(String(sessionId))
    if (!record) return null
    Object.assign(record, patch, { updatedAt: new Date().toISOString() })
    return record
  }

  /** Remove one session row. */
  remove(sessionId) {
    const removed = this.sessions.delete(String(sessionId))
    if (removed) this.persist()
    return removed
  }

  /** Every row, newest activity first. */
  list() {
    return [...this.sessions.values()].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
  }
}

/**
 * Normalize a persisted/selected model selection (`{provider, model,
 * reasoningEffort?}`) or null when the shape is unusable.
 * @param {any} value - untrusted selection.
 * @returns {{provider: string, model: string, reasoningEffort?: string}|null}
 */
export function modelSelectionOf(value) {
  if (!value || typeof value !== 'object') return null
  const provider = typeof value.provider === 'string' ? value.provider.trim() : ''
  const model = typeof value.model === 'string' ? value.model.trim() : ''
  if (!provider || !model) return null
  const effort = typeof value.reasoningEffort === 'string' && value.reasoningEffort.trim()
    ? value.reasoningEffort.trim()
    : ''
  return { provider, model, ...(effort ? { reasoningEffort: effort } : {}) }
}
