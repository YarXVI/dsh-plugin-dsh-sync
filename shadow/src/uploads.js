// Chunked file-transfer receiver (0.9.0).
//
// The dsh-sync broker already authenticates the caller and encrypts the
// transport; this module only implements the receive half of one paired-peer
// flow (all four actions travel over the single `ext.shadow.push-file` op):
//
//   begin  {transferId, name, size, sha256}      reserve a transfer + temp file
//   chunk  {transferId, index, data(base64)}     append one sequential chunk
//   commit {transferId, sha256?}                 verify size + sha256, rename
//   abort  {transferId}                          drop the temp file
//
// Safety rules:
//   * the caller (session-bridge) only reaches this module when uploads are
//     explicitly enabled (config `shadow.uploads.enabled` or a per-peer grant);
//   * a received name is sanitized into ONE Windows-safe path segment;
//     separators, drive letters, `.`/`..` and control characters are rejected,
//     and the resolved target must stay inside the upload dir (defense in
//     depth) — a transfer can never write outside `<DSH_HOME>/shadow-uploads`;
//   * at most `maxBytes` per file and `maxTransfers` in flight, chunks are
//     sequential and never exceed the declared size;
//   * the temp file lives inside the upload dir as `.incoming-<id>.part` and is
//     renamed only after the sha256 matches; an existing target is never
//     overwritten (a numeric suffix is added instead);
//   * audit rows carry the name, byte counts, peer and outcome only — never
//     file contents; the same fields go to the Shadow debug.log.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { isAbsolute, relative, resolve } from 'node:path'
import { CODES, LIMITS, OPS } from './constants.js'
import { ShadowError } from './util.js'

/** Characters that are unsafe in a Windows file name. */
const UNSAFE_NAME = /[<>:"|?*]/g

/** Control characters (including DEL) are never part of a legitimate name. */
const CONTROL = /[\u0000-\u001f\u007f]/

/** Windows reserved device names (case-insensitive, extension ignored). */
const RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

/** One accepted sha256 (lowercase hex). */
const SHA256 = /^[0-9a-f]{64}$/

/**
 * Normalize one peer-provided file name into a single safe path segment.
 *
 * This is a hard validation, not a silent rewrite: names that could address a
 * path (separators, drive letters, `.`/`..`) are rejected, so a caller cannot
 * even express a traversal. The remaining characters are made Windows-safe.
 * @param {any} raw - untrusted `name` from `begin`.
 * @returns {string} safe base name.
 */
export function sanitizeUploadName(raw) {
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (!text) failWith(CODES.badRequest, 'file name is required')
  if (text.length > LIMITS.maxUploadNameChars * 4) {
    failWith(CODES.badRequest, 'file name is too long')
  }
  if (CONTROL.test(text)) failWith(CODES.badRequest, 'file name contains control characters')
  if (text === '.' || text === '..') failWith(CODES.badRequest, 'file name must not be a path segment')
  if (/[\\/]/.test(text)) failWith(CODES.badRequest, 'file name must not contain a path separator')
  if (/^[A-Za-z]:/.test(text)) failWith(CODES.badRequest, 'file name must not contain a drive letter')
  let name = text
    .replace(UNSAFE_NAME, '_')
    .replace(/\s+/g, ' ')
    .trim()
    // Windows silently drops trailing dots/spaces, which can turn "a." into an
    // unrelated name; strip them explicitly instead.
    .replace(/[. ]+$/g, '')
  if (!name) failWith(CODES.badRequest, 'file name is empty after sanitizing')
  if (RESERVED_NAME.test(name.split('.')[0])) name = `_${name}`
  if (name.length > LIMITS.maxUploadNameChars) {
    const dot = name.lastIndexOf('.')
    const ext = dot > 0 && name.length - dot <= 16 ? name.slice(dot) : ''
    const base = ext ? name.slice(0, dot) : name
    name = `${base.slice(0, Math.max(1, LIMITS.maxUploadNameChars - ext.length))}${ext}`
  }
  return name
}

/** Raise a coded error without an audit context. */
function failWith(code, message) {
  throw new ShadowError(code, message)
}

/**
 * Throw unless `target` resolves to a direct child of `dir`.
 * @param {string} dir - upload directory.
 * @param {string} target - candidate path.
 */
export function assertInsideUploadDir(dir, target) {
  const root = resolve(dir)
  const rel = relative(root, resolve(target))
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
    failWith(CODES.badRequest, 'file name escapes the upload directory')
  }
}

/**
 * Pick a non-existing file name inside `dir` (never overwrites).
 * @param {string} dir - upload directory.
 * @param {string} name - already sanitized base name.
 * @returns {string} free base name.
 */
export function uniqueUploadName(dir, name) {
  const target = resolve(dir, name)
  assertInsideUploadDir(dir, target)
  if (!existsSync(target)) return name
  const dot = name.lastIndexOf('.')
  const base = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  for (let index = 1; index <= 999; index += 1) {
    const candidate = `${base} (${index})${ext}`
    if (!existsSync(resolve(dir, candidate))) return candidate
  }
  failWith(CODES.uploadBusy, 'no free file name in the upload directory')
}

/**
 * sha256 hex digest of a buffer.
 * @param {Buffer|Uint8Array|string} value - bytes to hash.
 * @returns {string} lowercase hex digest.
 */
export function sha256Of(value) {
  return createHash('sha256').update(value).digest('hex')
}

/**
 * Strict base64 decode for one chunk.
 * @param {any} value - untrusted chunk payload.
 * @returns {Buffer} decoded bytes.
 */
export function decodeUploadChunk(value) {
  const text = typeof value === 'string' ? value : ''
  if (!text) failWith(CODES.badRequest, 'chunk data is required')
  if (text.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(text)) {
    failWith(CODES.badRequest, 'chunk data must be canonical base64')
  }
  const buffer = Buffer.from(text, 'base64')
  // Reject non-canonical input that Buffer.from would silently accept.
  if (buffer.toString('base64') !== text) failWith(CODES.badRequest, 'chunk data must be canonical base64')
  return buffer
}

/** Normalize one peer device id for audit rows. */
function peerIdOf(peer) {
  return typeof peer?.deviceId === 'string' ? peer.deviceId : ''
}

/**
 * Receive-side transfer manager (one upload directory, in-memory transfers).
 */
export class UploadReceiver {
  /**
   * @param {object} options - receiver options.
   * @param {string} options.dir - absolute `$DSH_HOME/shadow-uploads`.
   * @param {number} [options.maxBytes] - per-file cap.
   * @param {number} [options.chunkBytes] - maximum raw bytes per chunk.
   * @param {number} [options.ttlMs] - idle transfer expiry.
   * @param {number} [options.maxTransfers] - concurrent transfer cap.
   * @param {(row: object) => void} [options.audit] - audit sink callback.
   * @param {object} [options.log] - logger.
   * @param {() => number} [options.now] - clock.
   */
  constructor(options = {}) {
    this.dir = resolve(String(options.dir || ''))
    this.maxBytes = Math.max(0, Number(options.maxBytes) || LIMITS.maxUploadBytes)
    this.chunkBytes = Math.max(1024, Number(options.chunkBytes) || LIMITS.uploadChunkBytes)
    this.ttlMs = Math.max(1_000, Number(options.ttlMs) || LIMITS.uploadTtlMs)
    this.maxTransfers = Math.max(1, Number(options.maxTransfers) || LIMITS.maxUploadTransfers)
    this.audit = typeof options.audit === 'function' ? options.audit : null
    this.log = options.log || null
    this.now = typeof options.now === 'function' ? options.now : () => Date.now()
    /** @type {Map<string, object>} */
    this.transfers = new Map()
    /** @type {Map<string, object>} */
    this.completed = new Map()
  }

  /** Absolute upload directory. */
  get path() {
    return this.dir
  }

  /** Advertised limits for `ext.shadow.info` / the panel. */
  limits() {
    return {
      enabled: true,
      maxBytes: this.maxBytes,
      chunkBytes: this.chunkBytes,
      dir: this.dir,
    }
  }

  /** Diagnostics: active/completed counts. */
  stats() {
    return {
      active: this.transfers.size,
      completed: this.completed.size,
      maxBytes: this.maxBytes,
      chunkBytes: this.chunkBytes,
      dir: this.dir,
    }
  }

  /**
   * Reserve one transfer (`begin`).
   * @param {{transferId: any, name: any, size: any, sha256: any, peer?: object}} request - begin payload.
   * @returns {object} transfer view.
   */
  begin(request = {}) {
    const transferId = this.#assertTransferId(request.transferId)
    const name = sanitizeUploadName(request.name)
    const size = this.#assertSize(request.size)
    const sha256 = this.#assertSha256(request.sha256)
    const peer = peerIdOf(request.peer)
    this.sweep()
    const active = this.transfers.get(transferId)
    if (active) {
      // A retried begin for the same transfer is idempotent.
      if (active.name === name && active.size === size && active.sha256 === sha256) return this.#view(active)
      this.#fail('begin', CODES.badRequest, `transfer "${transferId}" already exists for a different file`, active)
    }
    const done = this.completed.get(transferId)
    if (done) {
      if (done.name === name && done.size === size && done.sha256 === sha256) {
        return { ok: true, transferId, name: done.name, size: done.size, sha256: done.sha256, completed: true, receivedBytes: done.size, chunkBytes: this.chunkBytes, chunks: 0, expectedChunks: 0, expiresAt: done.at + this.ttlMs }
      }
      this.#fail('begin', CODES.badRequest, `transfer "${transferId}" was already committed for a different file`)
    }
    if (this.transfers.size >= this.maxTransfers) {
      this.#fail('begin', CODES.uploadBusy, `too many active file transfers (${this.maxTransfers})`)
    }
    try {
      mkdirSync(this.dir, { recursive: true })
    } catch (error) {
      this.#fail('begin', CODES.internal, `cannot create the upload directory: ${String(error?.message || error)}`)
    }
    const tempPath = resolve(this.dir, `.incoming-${transferId}.part`)
    assertInsideUploadDir(this.dir, tempPath)
    try {
      writeFileSync(tempPath, Buffer.alloc(0))
    } catch (error) {
      this.#fail('begin', CODES.internal, `cannot create the transfer file: ${String(error?.message || error)}`)
    }
    const now = this.now()
    const row = {
      transferId,
      name,
      size,
      sha256,
      peer,
      received: 0,
      chunks: 0,
      expectedChunks: Math.ceil(size / this.chunkBytes),
      tempPath,
      createdAt: now,
      updatedAt: now,
      expiresAt: now + this.ttlMs,
    }
    this.transfers.set(transferId, row)
    this.#audit(row, 'begin', true)
    this.log?.info?.('push-file begin', {
      transferId,
      name,
      size,
      sha256,
      peer,
      chunks: row.expectedChunks,
      dir: this.dir,
    })
    return this.#view(row)
  }

  /**
   * Append one chunk (`chunk`).
   * @param {{transferId: any, index: any, data: any, peer?: object}} request - chunk payload.
   * @returns {object} progress view.
   */
  chunk(request = {}) {
    const transferId = this.#assertTransferId(request.transferId, 'chunk')
    const row = this.#requireActive(transferId, 'chunk', request.peer)
    const index = Number(request.index)
    if (!Number.isSafeInteger(index) || index < 0) {
      this.#fail('chunk', CODES.badRequest, 'chunk index must be a non-negative integer', row)
    }
    if (index !== row.chunks) {
      this.#fail('chunk', CODES.badRequest, `chunk ${index} arrived out of order; expected ${row.chunks}`, row)
    }
    let data
    try {
      data = decodeUploadChunk(request.data)
    } catch (error) {
      this.#fail('chunk', error?.code || CODES.badRequest, String(error?.message || error), row)
    }
    if (data.length > this.chunkBytes) {
      this.#fail('chunk', CODES.payloadTooLarge, `chunk exceeds ${this.chunkBytes} bytes`, row)
    }
    if (row.received + data.length > row.size) {
      this.#fail('chunk', CODES.payloadTooLarge, `chunk would exceed the declared size (${row.size} bytes)`, row)
    }
    try {
      appendFileSync(row.tempPath, data)
    } catch (error) {
      this.#fail('chunk', CODES.internal, `cannot write the transfer file: ${String(error?.message || error)}`, row)
    }
    row.received += data.length
    row.chunks += 1
    row.updatedAt = this.now()
    this.log?.debug?.('push-file chunk', {
      transferId,
      index,
      bytes: data.length,
      received: row.received,
      size: row.size,
    })
    return {
      ok: true,
      transferId,
      receivedBytes: row.received,
      chunks: row.chunks,
      expectedChunks: row.expectedChunks,
      chunkBytes: this.chunkBytes,
    }
  }

  /**
   * Verify and publish one transfer (`commit`).
   * @param {{transferId: any, sha256?: any, peer?: object}} request - commit payload.
   * @returns {{ok: true, transferId: string, name: string, size: number, sha256: string}}
   */
  commit(request = {}) {
    const transferId = this.#assertTransferId(request.transferId, 'commit')
    const done = this.completed.get(transferId)
    if (done) {
      const claimed = request.sha256 === undefined ? done.sha256 : this.#assertSha256(request.sha256)
      if (claimed !== done.sha256) {
        this.#fail('commit', CODES.uploadHashMismatch, 'sha256 does not match the committed transfer')
      }
      return { ok: true, transferId, name: done.name, size: done.size, sha256: done.sha256, completed: true }
    }
    const row = this.#requireActive(transferId, 'commit', request.peer)
    const claimed = request.sha256 === undefined ? row.sha256 : this.#assertSha256(request.sha256)
    if (claimed !== row.sha256) {
      this.#fail('commit', CODES.uploadHashMismatch, 'sha256 does not match the begin declaration', row)
    }
    if (row.received !== row.size) {
      this.#fail('commit', CODES.badRequest, `transfer is incomplete: received ${row.received} of ${row.size} bytes`, row)
    }
    let actual
    try {
      actual = sha256Of(readFileSync(row.tempPath))
    } catch (error) {
      this.#discard(row)
      this.#fail('commit', CODES.internal, `cannot read the transfer file: ${String(error?.message || error)}`, row)
    }
    if (actual !== row.sha256) {
      this.#discard(row)
      this.#fail(
        'commit',
        CODES.uploadHashMismatch,
        `sha256 mismatch: declared ${row.sha256}, received ${actual}`,
        row,
        { actual },
      )
    }
    let finalName
    try {
      finalName = uniqueUploadName(this.dir, row.name)
      renameSync(row.tempPath, resolve(this.dir, finalName))
    } catch (error) {
      this.#discard(row)
      this.#fail('commit', error?.code || CODES.internal, `cannot publish the transfer file: ${String(error?.message || error)}`, row)
    }
    this.transfers.delete(transferId)
    this.#rememberCompleted({ transferId, name: finalName, size: row.size, sha256: row.sha256, at: this.now() })
    this.#audit(row, 'commit', true, { bytes: row.size, name: finalName })
    this.log?.info?.('push-file commit', {
      transferId,
      name: finalName,
      size: row.size,
      sha256: row.sha256,
      peer: row.peer,
    })
    return { ok: true, transferId, name: finalName, size: row.size, sha256: row.sha256 }
  }

  /**
   * Drop one transfer (`abort`).
   * @param {{transferId: any, peer?: object}} request - abort payload.
   * @returns {{ok: true, transferId: string, aborted: boolean}}
   */
  abort(request = {}) {
    const transferId = this.#assertTransferId(request.transferId, 'abort')
    const row = this.transfers.get(transferId)
    if (!row) return { ok: true, transferId, aborted: false }
    this.#discard(row)
    this.#audit(row, 'abort', true)
    this.log?.info?.('push-file abort', { transferId, name: row.name, received: row.received, peer: row.peer })
    return { ok: true, transferId, aborted: true }
  }

  /** Drop expired transfers (called before every begin/commit and by tests). */
  sweep() {
    const now = this.now()
    for (const row of [...this.transfers.values()]) {
      if (now <= row.expiresAt) continue
      this.transfers.delete(row.transferId)
      try { rmSync(row.tempPath, { force: true }) } catch {}
      this.#audit(row, 'expire', false, { code: 'shadow/upload-expired' })
      this.log?.warn?.('push-file transfer expired', {
        transferId: row.transferId,
        name: row.name,
        received: row.received,
        size: row.size,
        peer: row.peer,
      })
    }
  }

  /** Remove every temp file and forget transfers (plugin dispose). */
  dispose() {
    for (const row of [...this.transfers.values()]) {
      try { rmSync(row.tempPath, { force: true }) } catch {}
      this.log?.debug?.('push-file transfer dropped on dispose', {
        transferId: row.transferId,
        name: row.name,
        received: row.received,
      })
    }
    this.transfers.clear()
    this.completed.clear()
  }

  /** Transport-safe view of one active transfer. */
  #view(row) {
    return {
      ok: true,
      transferId: row.transferId,
      name: row.name,
      size: row.size,
      sha256: row.sha256,
      chunkBytes: this.chunkBytes,
      receivedBytes: row.received,
      chunks: row.chunks,
      expectedChunks: row.expectedChunks,
      expiresAt: row.expiresAt,
    }
  }

  /** Look up one active transfer or fail `shadow/upload-not-found`. */
  #requireActive(transferId, action, peer) {
    const row = this.transfers.get(transferId)
    if (!row) {
      this.#fail(action, CODES.uploadNotFound, `no active transfer "${transferId}"`, null, { peer: peerIdOf(peer), transferId })
    }
    if (this.now() > row.expiresAt) {
      this.#discard(row)
      this.#fail(action, CODES.uploadNotFound, `transfer "${transferId}" expired`, null, { peer: peerIdOf(peer), transferId })
    }
    return row
  }

  /** Remove one transfer row and its temp file. */
  #discard(row) {
    this.transfers.delete(row.transferId)
    try { rmSync(row.tempPath, { force: true }) } catch {}
  }

  /** Keep a small cache of committed transfers so a retried commit is a no-op. */
  #rememberCompleted(row) {
    this.completed.set(row.transferId, row)
    while (this.completed.size > LIMITS.maxUploadCompleted) {
      this.completed.delete(this.completed.keys().next().value)
    }
  }

  /** Validate one transfer id (also safe as a temp-file component). */
  #assertTransferId(value, action = 'begin') {
    const id = typeof value === 'string' ? value.trim() : ''
    if (!id) this.#fail(action, CODES.badRequest, 'transferId is required')
    if (id.length > LIMITS.maxUploadTransferIdChars || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) {
      this.#fail(action, CODES.badRequest, 'transferId must be 1-120 chars of [A-Za-z0-9._-]')
    }
    return id
  }

  /** Validate the declared file size. */
  #assertSize(value) {
    const size = Number(value)
    if (!Number.isSafeInteger(size) || size < 0) {
      this.#fail('begin', CODES.badRequest, 'size must be a non-negative integer')
    }
    if (size > this.maxBytes) {
      this.#fail('begin', CODES.payloadTooLarge, `file exceeds the ${this.maxBytes} byte limit`, null, { size })
    }
    return size
  }

  /** Validate one sha256 hex digest. */
  #assertSha256(value) {
    const text = typeof value === 'string' ? value.trim().toLowerCase() : ''
    if (!SHA256.test(text)) this.#fail('begin', CODES.badRequest, 'sha256 must be 64 lowercase hex characters')
    return text
  }

  /** Write one audit row and throw the coded error. */
  #fail(action, code, message, row = null, extra = {}) {
    const error = new ShadowError(code, message)
    // The bridge skips its generic per-op audit row for already-audited
    // transfer failures (one row per failed step is enough).
    error.audited = true
    this.audit?.({
      op: OPS.pushFile,
      action,
      transferId: row?.transferId || String(extra.transferId || ''),
      name: row?.name || '',
      bytes: row?.received || 0,
      peer: row?.peer || String(extra.peer || ''),
      ok: false,
      code,
      message,
      ...(extra.actual === undefined ? {} : { actual: extra.actual }),
    })
    this.log?.warn?.('push-file rejected', {
      action,
      code,
      transferId: row?.transferId || extra.transferId || '',
      name: row?.name || '',
      received: row?.received || 0,
      message,
    })
    throw error
  }

  /** Write one success audit row. */
  #audit(row, action, ok, extra = {}) {
    this.audit?.({
      op: OPS.pushFile,
      action,
      transferId: row.transferId,
      name: row.name,
      bytes: extra.bytes === undefined ? row.received : extra.bytes,
      peer: row.peer,
      ok,
      ...(extra.code ? { code: extra.code } : {}),
    })
  }
}
