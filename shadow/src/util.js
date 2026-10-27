// Small dependency-free helpers shared by the Host bridge and its self-test.
import { randomUUID } from 'node:crypto'
import { CODES } from './constants.js'

/**
 * An error with a stable, machine-routable `code` (survives the dsh-sync wire
 * as `{ error: { code, message } }`).
 */
export class ShadowError extends Error {
  /**
   * @param {string} code - one of CODES.
   * @param {string} message - developer-facing text.
   */
  constructor(code, message) {
    super(message)
    this.name = 'ShadowError'
    this.code = code
  }
}

/** Raise a coded error. */
export function fail(code, message) {
  throw new ShadowError(code, message)
}

/** New opaque id (request / approval / audit identity). */
export function newId(prefix = '') {
  return `${prefix}${randomUUID()}`
}

/** Whether a value is a plain JSON object. */
export function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Normalize an unknown thrown value into `{ code, message }`.
 * @param {any} error - caught value.
 * @returns {{code: string, message: string}}
 */
export function asFailure(error) {
  const message = errorText(error)
  const code = typeof error?.code === 'string' && error.code.length > 0 ? error.code : CODES.internal
  return { code, message }
}

/** Message text of a thrown value. */
export function errorText(error) {
  if (error instanceof Error) return error.message || String(error)
  return String(error ?? 'unknown error')
}

/** Cut text to a character budget, marking the cut. */
export function truncate(text, limit) {
  const value = String(text ?? '')
  if (!(limit > 0) || value.length <= limit) return value
  return `${value.slice(0, limit)}…[truncated ${value.length - limit}]`
}

/** Whole-number coercion with a floor. */
export function int(value, fallback = 0) {
  const n = Number(value)
  return Number.isFinite(n) ? Math.trunc(n) : fallback
}

/** Clamp a number into [min, max]. */
export function clamp(value, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return min
  return Math.min(max, Math.max(min, n))
}

/** JSON byte length, or Infinity when not serializable. */
export function byteLength(value) {
  try {
    return Buffer.byteLength(JSON.stringify(value ?? null), 'utf8')
  } catch {
    return Infinity
  }
}

/** `true` for a loopback socket address (`127.0.0.1`, `::1`, `::ffff:127.0.0.1`). */
export function isLoopback(address) {
  const text = String(address ?? '')
  return text === '::1'
    || text === '127.0.0.1'
    || text.startsWith('127.')
    || text === '::ffff:127.0.0.1'
    || text.startsWith('::ffff:127.')
}

/** Sleep helper. */
export function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, ms))
  })
}

/** Stable short hash for display ids (not a security primitive). */
export function shortHash(text, length = 10) {
  let h1 = 0x811c9dc5
  let h2 = 0x1000193
  const value = String(text ?? '')
  for (let i = 0; i < value.length; i += 1) {
    const c = value.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0
    h2 = Math.imul(h2 + c, 0x85ebca6b) >>> 0
  }
  const hex = (h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0'))
  return hex.slice(0, Math.max(1, Math.min(16, length)))
}

/**
 * Run one async callback, retaining a bounded memo of in-flight request ids so
 * a retried RPC (same `requestId`) is acknowledged instead of prompting twice.
 */
export class IdempotencySet {
  /**
   * @param {number} [limit] - most recent ids retained.
   */
  constructor(limit = 500) {
    this.limit = limit
    this.seen = new Set()
    this.queue = []
  }

  /** Mark an id; `true` when it was already seen. */
  remember(id) {
    const key = String(id ?? '')
    if (!key) return false
    if (this.seen.has(key)) return true
    this.seen.add(key)
    this.queue.push(key)
    if (this.queue.length > this.limit) {
      const old = this.queue.shift()
      this.seen.delete(old)
    }
    return false
  }
}

/** Resolve a plain value-or-function config field. */
export function valueOf(source, fallback) {
  return typeof source === 'function' ? source() : (source ?? fallback)
}
