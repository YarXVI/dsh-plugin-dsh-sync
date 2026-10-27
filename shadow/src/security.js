// Security helpers used by the sharing (A) bridge.
//
// The dsh-sync broker already guarantees: the caller is a paired device, the
// transport is encrypted, only `ext.*` ops with `{allow:true}` (or an explicit
// `extRpcAllow` entry) run, and payload sizes are bounded. The rules here are
// the ones a paired peer must still satisfy:
//
//   1. Sharing must be explicitly enabled and the workspace explicitly listed.
//   2. Only sessions registered by this bridge can be addressed.
//   3. There is no filesystem/path/exec operation anywhere in the protocol.
//   4. Prompts are rate limited per peer+session.
import { CODES, LIMITS } from './constants.js'
import { fail } from './util.js'

/**
 * Sliding-window rate limiter (one window per key).
 */
export class RateLimiter {
  /**
   * @param {object} [options] - limiter options.
   * @param {number} [options.limit] - allowed events per window.
   * @param {number} [options.windowMs] - window length.
   * @param {() => number} [options.now] - clock.
   */
  constructor(options = {}) {
    this.limit = Math.max(1, Number(options.limit) || LIMITS.defaultPromptsPerMinute)
    this.windowMs = Math.max(1000, Number(options.windowMs) || 60_000)
    this.now = typeof options.now === 'function' ? options.now : () => Date.now()
    this.windows = new Map()
  }

  /**
   * Count one event or throw `shadow/rate-limited`.
   * @param {string} key - bucket key (peer + session).
   * @returns {number} events in the current window, including this one.
   */
  hit(key) {
    const now = this.now()
    const bucket = (this.windows.get(key) || []).filter((at) => now - at < this.windowMs)
    if (bucket.length >= this.limit) {
      this.windows.set(key, bucket)
      fail(CODES.rateLimited, `prompt rate exceeded (${this.limit}/minute for this session)`)
    }
    bucket.push(now)
    this.windows.set(key, bucket)
    // Opportunistic cleanup so a long-lived process does not grow one bucket
    // per session forever.
    if (this.windows.size > 200) {
      for (const [candidate, times] of this.windows) {
        if (times.every((at) => now - at >= this.windowMs)) this.windows.delete(candidate)
      }
    }
    return bucket.length
  }

  /** Drop one bucket (session removed / sharing restarted). */
  reset(key) {
    this.windows.delete(key)
  }
}

/**
 * Validate one prompt body.
 * @param {any} text - untrusted prompt text.
 * @returns {string} trimmed text.
 */
export function assertPromptText(text) {
  const value = typeof text === 'string' ? text.trim() : ''
  if (!value) fail(CODES.badRequest, 'prompt text must not be empty')
  if (value.length > LIMITS.maxPromptChars) {
    fail(CODES.payloadTooLarge, `prompt exceeds ${LIMITS.maxPromptChars} characters`)
  }
  return value
}

/**
 * Validate one approval answer payload.
 * @param {{outcome?: any, approvalId?: any}} request - untrusted answer.
 * @returns {{approvalId: string, outcome: 'allowed-once'|'rejected'}}
 */
export function assertAnswer(request = {}) {
  const approvalId = String(request.approvalId ?? '')
  const outcome = String(request.outcome ?? '')
  if (!approvalId) fail(CODES.badRequest, 'approvalId is required')
  if (outcome !== 'allowed-once' && outcome !== 'rejected') {
    fail(CODES.badRequest, 'outcome must be "allowed-once" or "rejected"')
  }
  return { approvalId, outcome }
}

/** Normalize one waterfall outcome; unknown values fail closed. */
export function normalizeOutcome(value) {
  return value === 'allowed-once' || value === 'rejected' || value === 'cancelled' || value === 'unavailable'
    ? value
    : 'unavailable'
}
