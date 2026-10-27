// Bounded per-session frame log with cursor reads and long-poll waits.
//
// A side: durable `session/event` frames (ordered by `seq`) plus transient
// frames (live assistant chunks, approvals, status) numbered by a local
// monotonic `rev`. B side: the same class holds the mirror B received, so the
// B Web client can long-poll its own Host without another machine hop.
import { LIMITS } from './constants.js'
import { byteLength } from './util.js'

/**
 * One session's frame buffer.
 *
 * Cursor = `{seq, rev}`. `seq` advances only on durable events (so a missed
 * WebSocket/long-poll can always be repaired from the Session log); `rev`
 * covers process-local frames that are presentation-only.
 */
export class EventLog {
  /**
   * @param {object} [options] - limits and cold-read hook.
   * @param {number} [options.maxEvents] - durable ring size.
   * @param {number} [options.maxTransient] - transient ring size.
   * @param {(sinceSeq: number) => Promise<any[]>} [options.onColdRead] - replay hook (A side).
   */
  constructor(options = {}) {
    this.maxEvents = options.maxEvents ?? LIMITS.maxBufferedEvents
    this.maxTransient = options.maxTransient ?? LIMITS.maxBufferedTransient
    this.onColdRead = typeof options.onColdRead === 'function' ? options.onColdRead : null
    this.events = []
    this.transient = []
    this.lastSeq = -1
    this.lastRev = 0
    this.earliestSeq = 0
    this.waiters = new Set()
    this.coldPending = null
    this.coldChecked = -2
    // Set when the display machine closed the page: a pending long poll must
    // return immediately instead of holding the A-side request for `waitMs`.
    this.paused = false
    this.disposed = false
  }

  /** Assign the next transient revision (A side). */
  nextRev() {
    this.lastRev += 1
    return this.lastRev
  }

  /**
   * Append one durable frame. Frames with an already-known seq are ignored, so
   * live delivery and a cold replay can both feed the same log.
   * @param {object} frame - normalized event frame with numeric `seq`.
   * @returns {boolean} true when the frame was new.
   */
  appendEvent(frame) {
    const seq = Number(frame?.seq)
    if (!Number.isFinite(seq) || seq <= this.lastSeq) return false
    this.events.push(frame)
    this.lastSeq = seq
    if (seq < this.earliestSeq || this.events.length === 1) this.earliestSeq = seq
    while (this.events.length > this.maxEvents) {
      this.events.shift()
      this.earliestSeq = this.events[0]?.seq ?? this.lastSeq + 1
    }
    this.notify()
    return true
  }

  /**
   * Append one transient frame. A side passes a partial and receives the
   * stamped frame; B side passes frames that already carry A's `rev`.
   * @param {object} frame - transient frame.
   * @param {boolean} [stamped] - true when `frame.rev` is already authoritative.
   * @returns {object} the stored frame.
   */
  appendTransient(frame, stamped = false) {
    const out = stamped ? { ...frame } : { ...frame, rev: this.nextRev() }
    const rev = Number(out.rev)
    if (!Number.isFinite(rev)) return out
    if (rev > this.lastRev) this.lastRev = rev
    this.transient.push(out)
    while (this.transient.length > this.maxTransient) this.transient.shift()
    this.notify()
    return out
  }

  /** Replace all transient frames (B side, after an A epoch change). */
  dropTransient() {
    this.transient = []
  }

  /** Resolve once something changed, aborted, or after the timeout. */
  waitForChange(timeoutMs, signal) {
    const wait = Math.max(0, Number(timeoutMs) || 0)
    if (wait === 0 || this.paused || this.disposed) return Promise.resolve()
    if (signal?.aborted) return Promise.resolve()
    return new Promise((resolve) => {
      let timer = null
      const done = () => {
        this.waiters.delete(done)
        if (timer) clearTimeout(timer)
        signal?.removeEventListener?.('abort', done)
        resolve()
      }
      this.waiters.add(done)
      timer = setTimeout(() => {
        timer = null
        done()
      }, wait)
      signal?.addEventListener?.('abort', done, { once: true })
    })
  }

  /**
   * Pause / resume long polls for one session.
   *
   * The display half sends a final `events` call with `closing:true` when its
   * page closes; setting `paused` wakes the in-flight A-side poll so the
   * encrypted request does not sit for the full wait window. The next normal
   * `events` call resumes it.
   */
  setPaused(paused) {
    const next = paused === true
    if (this.paused === next) return
    this.paused = next
    if (next) this.notify()
  }

  /** Wake every pending reader (used by pause / shutdown). */
  interrupt() {
    this.notify()
  }

  /** Wake every pending reader. */
  notify() {
    for (const waiter of [...this.waiters]) waiter()
    this.waiters.clear()
  }

  /**
   * Replay from the Session log when the caller asks for a seq the ring no
   * longer holds (A restarted, ring trimmed, B offline for a long time).
   * @param {number} sinceSeq - caller cursor.
   */
  async ensureCold(sinceSeq) {
    if (!this.onColdRead) return
    const cursor = Math.max(-1, Number(sinceSeq) || -1)
    const covered = this.lastSeq !== -1 && cursor >= this.earliestSeq - 1
    if (covered) return
    // A reset log (A restart, epoch change) has no frames but a cursor may
    // already have been cold-read; do not replay the same prefix twice unless
    // the ring was trimmed past it (then a fresh replay is required).
    if (cursor === this.coldChecked && cursor >= this.earliestSeq - 1) return
    if (this.coldPending) return this.coldPending
    this.coldPending = (async () => {
      const events = await this.onColdRead(cursor)
      for (const event of Array.isArray(events) ? events : []) this.appendEvent(event)
      this.coldChecked = cursor
    })().finally(() => {
      this.coldPending = null
    })
    return this.coldPending
  }

  /**
   * Read one cursor page, long-polling until a frame above the cursor arrives
   * or `waitMs` elapses.
   * @param {object} request - read options.
   * @param {number} [request.sinceSeq] - last durable seq delivered (-1 = none).
   * @param {number} [request.sinceRev] - last transient rev delivered (0 = none).
   * @param {number} [request.waitMs] - long-poll budget in ms.
   * @param {number} [request.maxFrames] - durable frame cap.
   * @param {number} [request.maxTransient] - transient frame cap.
   * @param {number} [request.maxBytes] - response byte budget.
   * @returns {Promise<{events: object[], transient: object[], cursor: {seq: number, rev: number}, more: boolean, pendingEvents: number, pendingTransient: number}>}
   */
  async read(request = {}) {
    const sinceSeq = Number.isFinite(Number(request.sinceSeq)) ? Number(request.sinceSeq) : -1
    const sinceRev = Number.isFinite(Number(request.sinceRev)) ? Number(request.sinceRev) : 0
    const waitMs = Math.max(0, Math.min(LIMITS.maxWaitMs, Number(request.waitMs) || 0))
    const signal = request.signal
    const deadline = Date.now() + waitMs
    await this.ensureCold(sinceSeq)
    for (;;) {
      const page = this.page(sinceSeq, sinceRev, request)
      if (page.events.length > 0 || page.transient.length > 0) return page
      const remaining = deadline - Date.now()
      if (remaining <= 0 || this.paused || this.disposed || signal?.aborted) return page
      await this.waitForChange(remaining, signal)
    }
  }

  /**
   * Non-blocking page build. Cursors in the result cover only delivered frames.
   * @param {number} sinceSeq - durable cursor.
   * @param {number} sinceRev - transient cursor.
   * @param {object} [request] - caps.
   * @returns {{events: object[], transient: object[], cursor: {seq: number, rev: number}, more: boolean, pendingEvents: number, pendingTransient: number}}
   */
  page(sinceSeq, sinceRev, request = {}) {
    const maxFrames = Math.max(1, Math.min(500, Number(request.maxFrames) || LIMITS.maxEventFrames))
    const maxTransient = Math.max(0, Math.min(500, Number(request.maxTransient) || LIMITS.maxTransientFrames))
    const maxBytes = Math.max(1024, Math.min(4 * 1024 * 1024, Number(request.maxBytes) || LIMITS.maxBatchBytes))
    const pendingEvents = this.events.filter((frame) => frame.seq > sinceSeq)
    const pendingTransient = this.transient.filter((frame) => frame.rev > sinceRev)
    const events = []
    const transientFrames = []
    let bytes = 0
    let more = false
    for (const frame of pendingEvents) {
      const size = byteLength(frame)
      if (events.length >= maxFrames || bytes + size > maxBytes) {
        more = true
        break
      }
      events.push(frame)
      bytes += size
    }
    for (const frame of pendingTransient) {
      if (transientFrames.length >= maxTransient) {
        more = true
        break
      }
      const size = byteLength(frame)
      if (bytes + size > maxBytes) {
        more = true
        break
      }
      transientFrames.push(frame)
      bytes += size
    }
    const lastDeliveredEvent = events.length > 0 ? events[events.length - 1] : null
    const lastDeliveredTransient = transientFrames.length > 0 ? transientFrames[transientFrames.length - 1] : null
    return {
      events,
      transient: transientFrames,
      cursor: {
        seq: lastDeliveredEvent === null ? Math.max(-1, Math.min(sinceSeq, this.lastSeq)) : lastDeliveredEvent.seq,
        rev: lastDeliveredTransient === null ? sinceRev : lastDeliveredTransient.rev,
      },
      more,
      pendingEvents: Math.max(0, pendingEvents.length - events.length),
      pendingTransient: Math.max(0, pendingTransient.length - transientFrames.length),
    }
  }

  /** Drop every frame (epoch/reset handling). */
  reset() {
    this.events = []
    this.transient = []
    this.lastSeq = -1
    this.lastRev = 0
    this.earliestSeq = 0
    this.coldChecked = -2
    this.paused = false
    this.notify()
  }

  /** Dispose pending waiters. */
  dispose() {
    this.disposed = true
    this.notify()
    this.onColdRead = null
  }
}
