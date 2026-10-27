// Product state for the Shadow Workspace plugin.
//
// Install-and-use means no profile config editing: whether this machine shares
// workspaces (A half) and whether it displays a peer's shadow workspaces (B
// half) live here, under `$DSH_HOME/shadow-workspace/state.json`. The file is
// operator-owned state, not plugin config: it survives upgrades and is easy to
// reset (delete it, or use the panel's buttons).
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { STATE_FILE } from './constants.js'
import { errorText } from './util.js'

/** Current state file format. */
export const STATE_FORMAT = 1

/** Fresh state: sharing off (explicit opt-in), display on but unpaired. */
export function defaultState() {
  return {
    format: STATE_FORMAT,
    sharing: {
      enabled: false,
      workspaceIds: [],
      pausedAt: null,
      killedAt: null,
    },
    display: {
      enabled: true,
      peerDeviceId: '',
      peerName: '',
    },
    // 0.9.0: receive-side chunked file transfer (opt-in). `enabled` is the
    // local "accept files from paired peers" switch; `peers` grants specific
    // device ids when the global switch is off.
    uploads: {
      enabled: false,
      peers: [],
    },
    updatedAt: null,
  }
}

/** Deep-ish clone of the plain state object. */
function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

/** Normalize an untrusted persisted object into the current shape. */
export function normalizeState(raw) {
  const base = defaultState()
  if (!raw || typeof raw !== 'object') return base
  const sharing = raw.sharing && typeof raw.sharing === 'object' ? raw.sharing : {}
  const display = raw.display && typeof raw.display === 'object' ? raw.display : {}
  const uploads = raw.uploads && typeof raw.uploads === 'object' ? raw.uploads : {}
  return {
    format: STATE_FORMAT,
    sharing: {
      enabled: sharing.enabled === true,
      workspaceIds: Array.isArray(sharing.workspaceIds)
        ? [...new Set(sharing.workspaceIds.map(String).filter(Boolean))]
        : [],
      pausedAt: typeof sharing.pausedAt === 'string' ? sharing.pausedAt : null,
      killedAt: typeof sharing.killedAt === 'string' ? sharing.killedAt : null,
    },
    display: {
      enabled: display.enabled !== false,
      peerDeviceId: typeof display.peerDeviceId === 'string' ? display.peerDeviceId.slice(0, 120) : '',
      peerName: typeof display.peerName === 'string' ? display.peerName.slice(0, 120) : '',
    },
    uploads: {
      enabled: uploads.enabled === true,
      peers: Array.isArray(uploads.peers)
        ? [...new Set(uploads.peers.map(String).filter(Boolean).map((id) => id.slice(0, 120)))]
        : [],
    },
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null,
  }
}

/**
 * Atomic, observable state store.
 *
 * Writes are best effort (a read-only `$DSH_HOME` must not break the plugin):
 * failures are logged and the in-memory state still drives this process.
 */
export class ShadowStateStore {
  /**
   * @param {object} [options] - store options.
   * @param {string} [options.dir] - `$DSH_HOME/shadow-workspace`.
   * @param {object} [options.log] - logger.
   * @param {() => number} [options.now] - clock.
   */
  constructor(options = {}) {
    this.dir = typeof options.dir === 'string' ? options.dir : ''
    this.file = this.dir ? `${this.dir}/${STATE_FILE}` : ''
    this.log = options.log || null
    this.now = typeof options.now === 'function' ? options.now : () => Date.now()
    this.listeners = new Set()
    this.data = defaultState()
    this.load()
  }

  /** Read the persisted state; a missing/corrupt file yields safe defaults. */
  load() {
    this.data = defaultState()
    if (!this.file) return this.data
    let raw
    try {
      raw = JSON.parse(readFileSync(this.file, 'utf8'))
    } catch (error) {
      if (error && error.code !== 'ENOENT') this.log?.warn?.('[shadow-workspace] state.json unreadable, using defaults:', errorText(error))
      return this.data
    }
    this.data = normalizeState(raw)
    return this.data
  }

  /** Persist the current state atomically (temp file + rename). */
  save() {
    if (!this.file) return false
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      const tmp = `${this.file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`
      try {
        writeFileSync(tmp, JSON.stringify(this.data, null, 2) + '\n', 'utf8')
        renameSync(tmp, this.file)
      } catch (error) {
        try { rmSync(tmp, { force: true }) } catch {}
        throw error
      }
      return true
    } catch (error) {
      this.log?.warn?.('[shadow-workspace] state.json write failed:', errorText(error))
      return false
    }
  }

  /** Detached snapshot for UI/consumers. */
  snapshot() {
    return clone(this.data)
  }

  /** Subscribe to post-save changes. */
  subscribe(listener) {
    if (typeof listener !== 'function') return () => {}
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Notify listeners after a committed state change. */
  #commit() {
    this.data.updatedAt = new Date(this.now()).toISOString()
    this.save()
    for (const listener of [...this.listeners]) {
      try { listener(this.snapshot()) } catch (error) {
        this.log?.warn?.('[shadow-workspace] state listener failed:', errorText(error))
      }
    }
  }

  /** A half: enable/disable sharing without touching the workspace selection. */
  setSharing(enabled) {
    const next = enabled === true
    if (this.data.sharing.enabled === next) return this.snapshot()
    this.data.sharing.enabled = next
    this.data.sharing.pausedAt = next ? null : new Date(this.now()).toISOString()
    if (next) this.data.sharing.killedAt = null
    this.#commit()
    return this.snapshot()
  }

  /** A half: replace the shared workspace whitelist (validated by the caller). */
  setWorkspaces(workspaceIds) {
    const next = [...new Set((Array.isArray(workspaceIds) ? workspaceIds : []).map(String).filter(Boolean))]
    this.data.sharing.workspaceIds = next
    this.#commit()
    return this.snapshot()
  }

  /** A half: kill switch — stop sharing, clear the whitelist, mark the event. */
  kill(now = this.now()) {
    this.data.sharing.enabled = false
    this.data.sharing.workspaceIds = []
    this.data.sharing.killedAt = new Date(now).toISOString()
    this.data.sharing.pausedAt = this.data.sharing.killedAt
    this.#commit()
    return this.snapshot()
  }

  /** B half: display enabled/disabled. */
  setDisplay(enabled) {
    const next = enabled === true
    if (this.data.display.enabled === next) return this.snapshot()
    this.data.display.enabled = next
    this.#commit()
    return this.snapshot()
  }

  /** B half: selected peer device. */
  setPeer(peerDeviceId, peerName = '') {
    const deviceId = String(peerDeviceId ?? '').slice(0, 120)
    const name = String(peerName ?? '').slice(0, 120)
    if (this.data.display.peerDeviceId === deviceId && this.data.display.peerName === name) return this.snapshot()
    this.data.display.peerDeviceId = deviceId
    this.data.display.peerName = name
    this.#commit()
    return this.snapshot()
  }

  /** A half: whether this machine currently serves the display machine. */
  get sharingActive() {
    return this.data.sharing.enabled === true && this.data.sharing.workspaceIds.length > 0
  }

  /** Whether one workspace is explicitly shared. */
  workspaceAllowed(workspaceId) {
    return this.sharingActive && this.data.sharing.workspaceIds.includes(String(workspaceId ?? ''))
  }

  /** B half: whether this machine should render a peer's shadow workspaces. */
  get displayActive() {
    return this.data.display.enabled === true
  }

  // ---------------------------------------------------------------------
  // Receive-side uploads (0.9.0)
  // ---------------------------------------------------------------------

  /**
   * A half: operator switch for accepting files from paired peers. Off by
   * default; the Host config `shadow.uploads.enabled` is the other gate.
   * @param {boolean} enabled - new switch value.
   * @returns {object} state snapshot.
   */
  setUploads(enabled) {
    const next = enabled === true
    if (this.data.uploads.enabled === next) return this.snapshot()
    this.data.uploads.enabled = next
    this.#commit()
    return this.snapshot()
  }

  /**
   * A half: grant one paired device an explicit upload exemption (works while
   * the global uploads switch is off).
   * @param {string} deviceId - paired peer device id.
   * @returns {object} state snapshot.
   */
  grantUploadPeer(deviceId) {
    const id = String(deviceId ?? '').trim().slice(0, 120)
    if (!id || this.data.uploads.peers.includes(id)) return this.snapshot()
    this.data.uploads.peers = [...this.data.uploads.peers, id].slice(-32)
    this.#commit()
    return this.snapshot()
  }

  /**
   * A half: revoke one explicit upload grant.
   * @param {string} deviceId - paired peer device id.
   * @returns {object} state snapshot.
   */
  revokeUploadPeer(deviceId) {
    const id = String(deviceId ?? '').trim()
    const next = this.data.uploads.peers.filter((candidate) => candidate !== id)
    if (next.length === this.data.uploads.peers.length) return this.snapshot()
    this.data.uploads.peers = next
    this.#commit()
    return this.snapshot()
  }

  /** A half: whether `deviceId` was granted file uploads explicitly. */
  uploadPeerAllowed(deviceId) {
    const id = String(deviceId ?? '')
    return Boolean(id) && this.data.uploads.peers.includes(id)
  }

  /** A half: the operator's local "accept uploads" switch. */
  get uploadsEnabled() {
    return this.data.uploads.enabled === true
  }
}
