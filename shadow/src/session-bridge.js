// A-side (sharing machine) Shadow Workspace bridge.
//
// Responsibilities:
//   - create / prompt / cancel Sessions through `ctx.sessionController`;
//   - mirror their durable `session/event` stream and live
//     `agent/assistant-stream` frames into per-session EventLogs;
//   - answer `approval/request` only from an explicit display-machine (B) user
//     click, falling back to the local official UI when B is offline or the
//     60 s window expires;
//   - serve the `ext.shadow.*` operations the dsh-sync broker exposes;
//   - own the sharing state (enabled + workspace whitelist) and the kill switch.
//
// Everything Host-specific is read through `ctx.get(...)` at call time, so the
// whole bridge runs against the fake context in scripts/selftest.mjs.
import { createHash, randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { CODES, LIMITS, OPS, PLUGIN_VERSION, PROTOCOL_VERSION, UPLOADS_DIR } from './constants.js'
import { EventLog } from './event-log.js'
import { SessionRegistry, modelSelectionOf } from './registry.js'
import { RateLimiter, assertAnswer, assertPromptText, normalizeOutcome } from './security.js'
import { UploadReceiver } from './uploads.js'
import { normalizeEvent, normalizeStreamFrame, textOfMessage, trimTurnEndReason } from './normalize.js'
import { ShadowError, asFailure, errorText, fail, int, isObject, newId, truncate } from './util.js'

/**
 * Coerce an approval reason field to display text. DSH passes `displayReason`
 * as a structured object (`{ text, ... }`), and naive String() turns that into
 * "[object Object]" on the approval card.
 * @param {any} value - raw reason/displayReason.
 * @returns {string} human-readable text (possibly empty).
 */
function reasonText(value) {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'object') {
    for (const key of ['zh', 'text', 'message', 'description', 'title', 'summary', 'reason', 'en']) {
      const candidate = value[key]
      if (typeof candidate === 'string' && candidate.trim()) return candidate
    }
    try {
      return JSON.stringify(value)
    } catch {
      return String(value)
    }
  }
  return String(value)
}

/**
 * Bridge that owns the sharing machine's shadow sessions, event mirrors,
 * approvals and sharing state.
 */
export class ShadowHostBridge {
  /**
   * @param {object} options - bridge wiring.
   * @param {object} options.ctx - Cordis Host context (or a fake in tests).
   * @param {import('./state.js').ShadowStateStore} options.state - product state.
   * @param {import('./audit.js').AuditLog} [options.audit] - audit sink.
   * @param {object} [options.log] - logger.
   * @param {object} [options.sync] - `dshSync` service when available.
   * @param {() => number} [options.now] - clock.
   * @param {string|object} [options.store] - sessions registry path/options.
   * @param {object} [options.config] - optional tuning overrides (tests).
   */
  constructor(options = {}) {
    this.ctx = options.ctx
    this.state = options.state
    this.auditSink = options.audit || null
    this.log = options.log || null
    this.sync = options.sync || null
    this.now = typeof options.now === 'function' ? options.now : () => Date.now()
    this.config = options.config || {}
    this.epoch = randomUUID()
    /**
     * Receive-side chunked file transfer (0.9.0). Disabled unless the operator
     * opted in through `shadow.uploads.enabled` or an explicit per-peer grant;
     * the receiver enforces naming/size/sha256 rules on its own.
     */
    this.uploadConfig = normalizeUploadConfig(this.config.uploads)
    this.uploadsDir = resolveUploadsDir(options, this.state)
    this.uploads = this.uploadsDir
      ? new UploadReceiver({
        dir: this.uploadsDir,
        maxBytes: this.uploadConfig.maxBytes,
        chunkBytes: this.uploadConfig.chunkBytes,
        ttlMs: this.uploadConfig.ttlMs,
        maxTransfers: this.uploadConfig.maxTransfers,
        now: this.now,
        audit: (row) => this.audit(row),
        log: typeof this.log?.child === 'function' ? this.log.child('uploads') : this.log,
      })
      : null
    this.registry = options.registry instanceof SessionRegistry
      ? options.registry
      : new SessionRegistry({
        file: typeof options.store === 'string' ? options.store : options.config?.sessionsFile,
        log: this.log,
      })
    /** @type {Map<string, EventLog>} */
    this.logs = new Map()
    /** @type {Map<string, object>} */
    this.pendingApprovals = new Map()
    /** @type {Map<string, object>} Interactive user questions awaiting an answer (0.8.0). */
    this.pendingQuestions = new Map()
    /**
     * In-memory composer-attachment staging (0.10.25). One entry per
     * `ext.shadow.attach` begin/chunk/commit transfer; keyed by `transferId`,
     * owned by the (device, session) pair that started it, and expired after
     * `LIMITS.attachTtlMs`. No bytes ever touch the filesystem: the Host
     * admission stores the final image/file once the prompt is accepted.
     * @type {Map<string, {transferId: string, sessionId: string, peerId: string, kind: 'image'|'file', name: string, mediaType: string, size: number, bytes: number, chunks: Buffer[], sha256: string, createdAt: number, committed: boolean}>}
     */
    this.stagedAttachments = new Map()
    this.disposers = []
    this.requestIds = new Map()
    this.disposed = false
    this.started = false
    this.rateLimiter = new RateLimiter({
      limit: Number(this.config.promptsPerMinute) || LIMITS.defaultPromptsPerMinute,
      now: this.now,
    })
    /**
     * Display-machine presence. dsh-sync only discovers peers in one direction:
     * when B manually added A, A's own `peers()` shows B as offline even though
     * B is actively calling our `ext.shadow.*` ops. Every inbound RPC therefore
     * refreshes this map, and approvals treat a fresh entry as "B is attached".
     * @type {Map<string, {deviceId: string, name: string, lastSeenAt: number}>}
     */
    this.presence = new Map()
  }

  // ---------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------

  /** Register Host listeners once. Idempotent. */
  start() {
    if (this.started || this.disposed) return this
    this.started = true
    this.disposers.push(this.#listen('session/event', (session, event) => this.#onSessionEvent(session, event)))
    this.disposers.push(this.#listen('agent/assistant-stream', (payload) => this.#onAssistantStream(payload)))
    this.disposers.push(this.#listen('agent/status', (payload) => this.#onAgentStatus(payload)))
    // Decision #3: register the approval answerer per Agent (agent.ctx) after
    // `agent/created`, instead of a global listener. `prepend: true` is scoped
    // by the dispatch filter, so it only wins for that one agent — needed
    // because the official Web forwarding listener was registered at boot,
    // before this plugin, and would otherwise hold the request for A's UI.
    this.disposers.push(this.#listen('agent/created', (payload) => this.#onAgentCreated(payload)))
    this.log?.info?.('start', { managedSessions: this.registry.list().length, approvalTtlMs: this.approvalTtlMs })
    return this
  }

  /** Attach the dsh-sync service after it appears (or for the self-test). */
  attachSync(sync) {
    this.sync = sync || null
    return this
  }

  /** True while the operator has enabled sharing with a non-empty whitelist. */
  get sharingActive() {
    return Boolean(this.state?.sharingActive)
  }

  /** The effective approval TTL (tests shrink it; production default is 60 s). */
  get approvalTtlMs() {
    const value = Number(this.config.approvalTtlMs)
    return Number.isFinite(value) && value > 0 ? Math.max(50, Math.floor(value)) : LIMITS.defaultApprovalTtlMs
  }

  /** How long one inbound RPC counts as "the display machine is attached". */
  get presenceTtlMs() {
    const value = Number(this.config.presenceTtlMs)
    return Number.isFinite(value) && value > 0 ? Math.max(1_000, Math.floor(value)) : LIMITS.defaultPresenceTtlMs
  }

  /**
   * Record that `peer` just called us. Only `ext.shadow.*` RPCs reach this
   * method (dsh-sync guarantees a paired, authenticated peer), so this is a
   * trustworthy presence signal.
   * @param {{deviceId?: string, name?: string}} [peer] - dsh-sync peer facts.
   */
  notePeer(peer) {
    const deviceId = typeof peer?.deviceId === 'string' ? peer.deviceId : ''
    if (!deviceId) return
    const previous = this.presence.get(deviceId)
    const name = typeof peer?.name === 'string' && peer.name ? peer.name : previous?.name || ''
    if (!previous) this.log?.info?.('display presence attached', { deviceId, name })
    this.presence.set(deviceId, { deviceId, name, lastSeenAt: this.now() })
  }

  /**
   * Presence rows for the panel / diagnostics, newest first.
   * @returns {Array<{deviceId: string, name: string, lastSeenAt: number, ageMs: number, attached: boolean}>}
   */
  peerPresence() {
    const ttl = this.presenceTtlMs
    return [...this.presence.values()]
      .map((row) => ({
        deviceId: row.deviceId,
        name: row.name,
        lastSeenAt: row.lastSeenAt,
        ageMs: Math.max(0, this.now() - row.lastSeenAt),
        attached: this.now() - row.lastSeenAt <= ttl,
      }))
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
  }

  /**
   * Whether a display machine is attached or dsh-sync reports one online.
   * @param {string} [deviceId] - when set, only that device counts (the session owner).
   * @returns {boolean} true when the display half can still answer.
   */
  #peerReachable(deviceId = '') {
    const now = this.now()
    const wanted = typeof deviceId === 'string' ? deviceId : ''
    for (const row of this.presence.values()) {
      if (wanted && row.deviceId !== wanted) continue
      if (now - row.lastSeenAt <= this.presenceTtlMs) return true
    }
    if (!this.sync || typeof this.sync.peers !== 'function') return false
    try {
      const peers = this.sync.peers()
      return Array.isArray(peers) && peers.some((peer) => (
        peer?.trusted && peer?.online && (!wanted || peer?.deviceId === wanted)
      ))
    } catch {
      return false
    }
  }

  /** Dispose listeners, timers and pending approvals. */
  dispose() {
    if (this.disposed) return
    this.disposed = true
    this.log?.info?.('dispose', { pendingApprovals: this.pendingApprovals.size, managedSessions: this.logs.size })
    for (const off of this.disposers.splice(0)) {
      try { off?.() } catch {}
    }
    for (const pending of [...this.pendingApprovals.values()]) {
      pending.settle?.('unavailable', 'bridge-disposed')
    }
    this.pendingApprovals.clear()
    for (const pending of [...this.pendingQuestions.values()]) {
      pending.settleError?.(Object.assign(new Error('shadow bridge disposed before the question was answered'), { code: 'ASK_CANCELLED' }))
    }
    this.pendingQuestions.clear()
    for (const log of this.logs.values()) log.dispose()
    this.logs.clear()
    this.uploads?.dispose()
    // Staged attachment bytes are in-memory only: drop them with the bridge.
    this.stagedAttachments.clear()
  }

  /** Register one Host event listener; a fake ctx may return a boolean. */
  #listen(name, handler) {
    try {
      const off = this.ctx.on(name, handler)
      if (typeof off === 'function') return off
    } catch (error) {
      this.log?.warn?.(`[shadow-workspace] cannot listen to ${name}:`, errorText(error))
    }
    return () => {}
  }

  /** Called by index.js after the operator changes sharing state. */
  syncFromState() {
    if (this.disposed) return
    if (!this.sharingActive) {
      // Pause/kill: reject every pending approval now, and wake A-side polls so
      // the display half learns about it without waiting for the long poll.
      const pendingCount = this.pendingApprovals.size
      for (const pending of [...this.pendingApprovals.values()]) {
        pending.settle?.('rejected', 'sharing-disabled')
      }
      for (const log of this.logs.values()) log.interrupt()
      this.log?.info?.('sharing paused: pending approvals rejected', { pendingCount })
      // Questions cannot be answered by the display machine anymore. Release
      // them to the local official UI instead of silently approving anything.
      for (const pending of [...this.pendingQuestions.values()]) {
        pending.fallbackToLocal?.('sharing-disabled')
      }
    } else {
      this.log?.info?.('sharing active', { workspaces: this.state?.snapshot().sharing.workspaceIds.length })
    }
  }

  /**
   * Kill switch: reject all pending approvals, stop sharing and clear the
   * workspace whitelist. Returns the audit row written.
   */
  killSwitch(reason = 'panel') {
    const snapshot = this.state.kill(this.now())
    this.syncFromState()
    const row = this.audit({
      action: 'sharing.kill',
      reason,
      workspacesCleared: true,
      pendingRejected: true,
      ok: true,
    })
    this.log?.warn?.('kill switch engaged', { reason, managedSessions: this.registry.list().length })
    return { state: snapshot, audit: row }
  }

  // ---------------------------------------------------------------------
  // Host service helpers
  // ---------------------------------------------------------------------

  #service(name) {
    try {
      return this.ctx && typeof this.ctx.get === 'function' ? this.ctx.get(name) : undefined
    } catch {
      return undefined
    }
  }

  #controller() {
    const service = this.#service('sessionController')
    if (!service) fail(CODES.notReady, 'sessionController is not available yet')
    return service
  }

  #workspaces() {
    return this.#service('workspaceRegistry')
  }

  /** Live Agent for one session (file staging, status), when the Host exposes one. */
  #agentOf(sessionId) {
    try {
      return this.#service('agents')?.get?.(sessionId)
    } catch {
      return undefined
    }
  }

  /**
   * The durable Session object the Host permission services expect. Prefers the
   * live Agent's session (what the native UI passes) and falls back to the
   * sessions registry. Idle sessions are not materialized in DSH until their
   * Agent exists, so resume through `sessionController.resume()` — the same
   * path the native UI takes when it opens a persisted session. Without this,
   * a display machine could only change permissions on a session that was
   * already running on the sharing machine.
   * @param {string} sessionId - shadow session id.
   * @returns {Promise<object>} live Host session object.
   */
  async #sessionObject(sessionId) {
    const live = this.#agentOf(sessionId)?.session
    if (live) return live
    let fromRegistry
    try {
      fromRegistry = this.#service('sessions')?.get?.(sessionId)
    } catch {
      fromRegistry = undefined
    }
    if (fromRegistry) return fromRegistry
    const controller = this.#service('sessionController')
    if (typeof controller?.resume === 'function') {
      try {
        const resumed = await controller.resume(sessionId)
        const session = resumed?.session || resumed?.agent?.session || resumed
        if (session && typeof session === 'object') return session
      } catch (error) {
        this.log?.warn?.('permission session resume failed', {
          sessionId,
          error: errorText(error),
        })
      }
    }
    fail(CODES.notReady, 'session is not materialized yet')
  }

  /** Workspaces this machine could share (panel lists all; `shared` flags the whitelist). */
  listWorkspaces() {
    const registry = this.#workspaces()
    const rows = typeof registry?.list === 'function' ? registry.list() : []
    const whitelist = new Set(this.state?.snapshot().sharing.workspaceIds || [])
    const out = []
    for (const workspace of Array.isArray(rows) ? rows : []) {
      const workspaceId = String(workspace?.id ?? workspace?.workspaceId ?? '')
      if (!workspaceId) continue
      const sessionIds = Array.isArray(workspace?.sessionIds) ? workspace.sessionIds : []
      out.push({
        workspaceId,
        title: String(workspace?.title ?? workspaceId),
        sessionCount: sessionIds.length,
        shared: whitelist.has(workspaceId),
      })
    }
    return out
  }

  /** Workspaces visible to the display machine (shared + currently active only). */
  #sharedWorkspaces() {
    if (!this.sharingActive) return []
    return this.listWorkspaces().filter((workspace) => workspace.shared)
  }

  identity() {
    try {
      const identity = this.sync?.identity?.()
      if (identity && typeof identity === 'object') {
        return { deviceId: String(identity.deviceId ?? ''), name: String(identity.name ?? '') }
      }
    } catch {}
    return { deviceId: 'local', name: 'this device' }
  }

  /** Current Host-side running status of one session. */
  statusOf(sessionId) {
    const record = this.registry.get(sessionId)
    let live
    try {
      live = this.#service('agents')?.get?.(sessionId)
    } catch {}
    const status = live?.status
    if (status === 'running' || status === 'idle') return status
    return record?.lastStatus === 'running' ? 'running' : 'idle'
  }

  // ---------------------------------------------------------------------
  // Session lifecycle
  // ---------------------------------------------------------------------

  #ensureLog(sessionId) {
    const existing = this.logs.get(sessionId)
    if (existing) return existing
    const record = this.registry.get(sessionId)
    const log = new EventLog({
      onColdRead: (sinceSeq) => this.#coldRead(sessionId, sinceSeq),
    })
    this.logs.set(sessionId, log)
    if (record) {
      void this.#coldRead(sessionId, -1).then((events) => {
        for (const event of events) log.appendEvent(event)
      }).catch(() => {})
    }
    return log
  }

  /**
   * Rebuild the in-memory mirror for a registry session after an A restart.
   * `#ensureLog` schedules a cold replay from `sessionController.inspect`; the
   * first `events` read then blocks on `ensureCold` until the replay lands.
   * @param {string} sessionId - registered shadow session id.
   * @returns {EventLog} the newly attached log.
   */
  #rehydrate(sessionId) {
    const record = this.registry.get(sessionId)
    if (!record) fail(CODES.notFound, `session "${sessionId}" is not managed by this shadow bridge; start a new shadow session`)
    const log = this.#ensureLog(sessionId)
    this.registry.update(sessionId, { rehydrated: true })
    this.log?.info?.('session rehydrated from durable log', { sessionId, workspaceId: record.workspaceId })
    return log
  }

  async #coldRead(sessionId, sinceSeq) {
    const controller = this.#controller()
    let inspected
    try {
      inspected = await controller.inspect(sessionId)
    } catch (error) {
      if (isStaleSession(error)) {
        this.registry.remove(sessionId)
        fail(CODES.notFound, `session "${sessionId}" no longer exists on this device; start a new shadow session`)
      }
      throw error
    }
    const record = this.registry.get(sessionId)
    const events = Array.isArray(inspected?.events) ? inspected.events : []
    const frames = []
    for (const event of events) {
      if (Number(event?.seq) <= sinceSeq) continue
      const frame = normalizeEvent(event, { workspaceId: record?.workspaceId })
      if (frame) frames.push(frame)
    }
    return frames
  }

  /**
   * Create one real Session on the sharing machine and register it.
   * @param {{workspaceId: string, agentPreset?: string, model?: object, peer?: object}} request - creation input.
   * @returns {Promise<{sessionId: string, workspaceId: string, title: string, model?: object, modelError?: string}>}
   */
  async createSession(request = {}) {
    this.#assertSharing()
    const workspaceId = String(request.workspaceId ?? '')
    this.#assertSharedWorkspace(workspaceId)
    const controller = this.#controller()
    const preset = typeof request.agentPreset === 'string' && request.agentPreset.trim() ? request.agentPreset.trim() : ''
    const requestedModel = request.model === undefined ? null : assertModelSelection(request.model)
    const created = await controller.create({
      workspaceId,
      ...(preset ? { agentPreset: preset } : {}),
    })
    const sessionId = typeof created?.sessionId === 'string' ? created.sessionId : ''
    if (!sessionId) fail(CODES.internal, 'sessionController.create() returned no sessionId')
    const workspace = this.listWorkspaces().find((row) => row.workspaceId === workspaceId)
    this.registry.add({
      sessionId,
      workspaceId,
      title: workspace?.title ?? workspaceId,
      creatorPeerId: typeof request.peer?.deviceId === 'string' && request.peer.deviceId ? request.peer.deviceId : 'local',
    })
    this.#ensureLog(sessionId)
    this.audit({ op: OPS.create, sessionId, workspaceId, ok: true, peer: String(request.peer?.deviceId ?? '') })
    this.log?.info?.('session created', { sessionId, workspaceId, preset: preset || '(default)' })
    const result = { sessionId, workspaceId, title: workspace?.title ?? workspaceId }
    if (requestedModel) {
      try {
        const selected = await this.#installModelSelection(controller, sessionId, requestedModel)
        this.registry.update(sessionId, { lastModel: selected })
        this.audit({ op: OPS.selectModel, sessionId, provider: selected.provider, model: selected.model, peer: String(request.peer?.deviceId ?? ''), ok: true, via: 'create' })
        result.model = selected
      } catch (error) {
        // The Session exists; report the model failure instead of pretending the
        // whole creation failed (the display can still retry the selection).
        result.modelError = errorText(error)
        this.log?.warn?.('model selection failed during create', { sessionId, error })
      }
    }
    return result
  }

  /**
   * Normalize + install one validated model selection through the controller.
   * @param {object} controller - `sessionController` service.
   * @param {string} sessionId - target Session.
   * @param {{provider: string, model: string, reasoningEffort?: string}} selection - requested selection.
   * @returns {Promise<object>} the installed selection.
   */
  async #installModelSelection(controller, sessionId, selection) {
    if (typeof controller?.selectModel !== 'function') {
      fail(CODES.notReady, 'sessionController.selectModel() is unavailable on this Host')
    }
    const raw = await controller.selectModel({ sessionId, ...selection })
    const selected = modelSelectionOf(raw?.selected) || modelSelectionOf(selection)
    if (!selected) fail(CODES.internal, 'sessionController.selectModel() returned no selection')
    return selected
  }

  /**
   * Admit one prompt into a managed session.
   *
   * Text alone is the 0.5.x protocol; 0.10.25 adds ordered `attachments`
   * references to transfers staged through `ext.shadow.attach`. Images are
   * inlined as canonical base64 (exactly what the native composer sends) and
   * files are minted into Host file-upload receipts on this machine, so the
   * Session Controller's own attachment admission still applies.
   * @param {{sessionId: string, text?: string, requestId?: string, attachments?: Array<{transferId: string}|string>, peer?: object}} request - prompt input.
   * @returns {Promise<{accepted: true, requestId: string, duplicate?: boolean}>}
   */
  async prompt(request = {}) {
    this.#assertSharing()
    const sessionId = this.#requireSession(request.sessionId)
    this.#assertRecordShared(sessionId)
    this.#assertOwner(sessionId, request.peer)
    const refs = normalizeAttachmentRefs(request.attachments)
    if (refs.length > LIMITS.maxPromptAttachments) {
      fail(CODES.payloadTooLarge, `a prompt may carry at most ${LIMITS.maxPromptAttachments} attachments`)
    }
    let text
    if (refs.length === 0) {
      text = assertPromptText(request.text)
    } else {
      // An attachments-only prompt is legitimate: 0.10.25 allows empty text
      // when at least one attachment exists, but the character budget stays.
      text = typeof request.text === 'string' ? request.text.trim() : ''
      if (text.length > LIMITS.maxPromptChars) {
        fail(CODES.payloadTooLarge, `prompt exceeds ${LIMITS.maxPromptChars} characters`)
      }
    }
    const peerId = String(request.peer?.deviceId ?? 'peer')
    const peerKey = String(request.peer?.deviceId ?? '')
    this.rateLimiter.hit(`${peerId}|${sessionId}`)
    const requestId = typeof request.requestId === 'string' && request.requestId.length > 0
      ? request.requestId.slice(0, 120)
      : newId('shadow-req-')
    const set = this.requestIds.get(sessionId) || new Set()
    this.requestIds.set(sessionId, set)
    if (set.has(requestId)) return { accepted: true, requestId, duplicate: true }
    set.add(requestId)
    if (set.size > 500) set.delete(set.values().next().value)
    const controller = this.#controller()
    const signal = new AbortController().signal
    // Resolve staged transfers only after the duplicate check: a retried prompt
    // returns "already accepted" instead of failing on transfers the first call
    // already consumed.
    this.#purgeStagedAttachments()
    const content = []
    const used = []
    let inlineImageBytes = 0
    for (const ref of refs) {
      const transferId = ref.transferId
      const staged = this.stagedAttachments.get(transferId)
      if (!staged || staged.committed !== true || staged.sessionId !== sessionId || staged.peerId !== peerKey) {
        fail(CODES.attachNotFound, `attachment transfer "${transferId}" is not staged and committed for this session`)
      }
      const bytes = Buffer.concat(staged.chunks, staged.bytes)
      if (staged.kind === 'image') {
        if (bytes.length > LIMITS.maxPromptImageBytes) {
          fail(CODES.attachTooLarge, `image "${staged.name}" exceeds ${LIMITS.maxPromptImageBytes} bytes`)
        }
        inlineImageBytes += bytes.length
        if (inlineImageBytes > LIMITS.maxAttachBytes) {
          fail(CODES.attachTooLarge, `inline image bytes exceed ${LIMITS.maxAttachBytes}`)
        }
        content.push({
          type: 'image',
          mediaType: staged.mediaType,
          data: bytes.toString('base64'),
          ...(staged.name ? { name: staged.name } : {}),
        })
      } else {
        const fileUploads = this.#service('fileUploads')
        const agent = this.#agentOf(sessionId)
        if (!fileUploads || typeof fileUploads.upload !== 'function' || !agent) {
          fail(CODES.notReady, 'file uploads are unavailable on this host')
        }
        const minted = await fileUploads.upload(
          agent,
          { data: bytes.toString('base64'), ...(staged.name ? { name: staged.name } : {}) },
          new AbortController().signal,
        )
        const receiptId = String(minted?.receiptId ?? '')
        if (!receiptId) fail(CODES.internal, 'fileUploads.upload() returned no receiptId')
        content.push({ type: 'file', receiptId })
      }
      used.push(transferId)
    }
    if (text) content.push({ type: 'text', text })
    try {
      await controller.prompt({
        requestId,
        sessionId,
        mode: 'queue',
        content,
      }, signal)
    } catch (error) {
      if (isStaleSession(error)) {
        this.registry.remove(sessionId)
        fail(CODES.notFound, `session "${sessionId}" no longer exists on this device; start a new shadow session`)
      }
      // A failed admission keeps the staged transfers so the display can retry.
      throw error
    }
    for (const transferId of used) this.stagedAttachments.delete(transferId)
    this.#ensureLog(sessionId)
    this.registry.update(sessionId, { lastStatus: 'running' })
    this.audit({ op: OPS.prompt, sessionId, requestId, peer: peerId, ok: true, chars: text.length, attachments: used.length })
    this.log?.info?.('prompt accepted', { sessionId, requestId, chars: text.length, attachments: used.length, peer: peerId })
    return { accepted: true, requestId }
  }

  /** Cancel the running turn of one managed session. */
  async cancelSession(request = {}) {
    this.#assertSharing()
    const sessionId = this.#requireSession(request.sessionId)
    this.#assertRecordShared(sessionId)
    this.#assertOwner(sessionId, request.peer)
    await this.#controller().cancel({ sessionId })
    this.registry.update(sessionId, { lastStatus: 'idle' })
    this.audit({ op: OPS.cancel, sessionId, peer: String(request.peer?.deviceId ?? ''), ok: true })
    this.log?.info?.('session cancelled', { sessionId, peer: String(request.peer?.deviceId ?? '') })
    return { accepted: true }
  }

  // ---------------------------------------------------------------------
  // Model catalogue + selection (0.7.0)
  // ---------------------------------------------------------------------

  /**
   * Slim model catalogue for the display machine's chat header / new-session
   * picker. Host LLM registries can expose a lot of metadata; only provider
   * groups (id/label/models) plus the deployment default and provider failures
   * cross the machine boundary.
   * @returns {Promise<{default: object|null, groups: Array<object>, failures: Array<object>}>}
   */
  async modelCatalog() {
    const controller = this.#controller()
    if (typeof controller.modelCatalog !== 'function') {
      fail(CODES.notReady, 'sessionController.modelCatalog() is unavailable on this Host')
    }
    return slimModelCatalog(await controller.modelCatalog())
  }

  /**
   * Install one model selection for a shadow Session owned by the caller.
   * @param {{sessionId: string, provider: string, model: string, reasoningEffort?: string, peer?: object}} request - selection input.
   * @returns {Promise<{selected: {provider: string, model: string, reasoningEffort?: string}}>}
   */
  async selectModel(request = {}) {
    this.#assertSharing()
    const sessionId = this.#requireSession(request.sessionId)
    this.#assertRecordShared(sessionId)
    this.#assertOwner(sessionId, request.peer)
    const selection = assertModelSelection(request)
    const controller = this.#controller()
    const selected = await this.#installModelSelection(controller, sessionId, selection)
    this.registry.update(sessionId, { lastModel: selected })
    this.audit({
      op: OPS.selectModel,
      sessionId,
      provider: selected.provider,
      model: selected.model,
      peer: String(request.peer?.deviceId ?? ''),
      ok: true,
    })
    this.log?.info?.('model selection installed', {
      sessionId,
      provider: selected.provider,
      model: selected.model,
      peer: String(request.peer?.deviceId ?? ''),
    })
    return { selected }
  }

  // ---------------------------------------------------------------------
  // Chunked file transfer (0.9.0)
  // ---------------------------------------------------------------------

  /**
   * Whether this device currently accepts files from `peer`.
   *
   * Two independent gates, both opt-in and off by default:
   *   1. Host config `shadow.uploads.enabled === true` (operator edited the
   *      plugin config), or
   *   2. the local state switch `uploads.enabled` (panel/data route), or an
   *      explicit per-device grant `uploads.peers.includes(peer.deviceId)`.
   * @param {{deviceId?: string}} [peer] - calling dsh-sync peer.
   * @returns {boolean} true when a transfer may start.
   */
  uploadsAllowedFor(peer) {
    if (this.disposed || !this.uploads) return false
    if (this.uploadConfig.enabled === true) return true
    if (this.state?.uploadsEnabled === true) return true
    return this.state?.uploadPeerAllowed?.(String(peer?.deviceId ?? '')) === true
  }

  /**
   * Upload facts advertised to a display machine (`ext.shadow.info`). The B
   * panel only shows its "push file" control when `enabled` is true here.
   * @param {object} [peer] - calling dsh-sync peer.
   * @returns {{enabled: boolean, maxBytes: number, chunkBytes: number}}
   */
  uploadInfo(peer) {
    if (!this.uploads) return { enabled: false, maxBytes: 0, chunkBytes: 0 }
    return {
      enabled: this.uploadsAllowedFor(peer),
      maxBytes: this.uploads.maxBytes,
      chunkBytes: this.uploads.chunkBytes,
    }
  }

  /**
   * Serve `ext.shadow.push-file` (`begin` / `chunk` / `commit` / `abort`).
   *
   * The permission check happens before any filesystem work; the receiver owns
   * naming, size limits, sequential chunks and the commit-time sha256 check,
   * and writes one audit row per begin/commit/abort/rejection (name, bytes,
   * peer, ok — never file contents).
   * @param {{action?: string, transferId?: string, name?: string, size?: number, sha256?: string, index?: number, data?: string, peer?: object}} request - transfer step.
   * @returns {object} receiver result (`commit` reports `{name, size, sha256}`).
   */
  pushFile(request = {}) {
    const action = String(request.action ?? '')
    const peerId = String(request.peer?.deviceId ?? '')
    if (!this.uploads || !this.uploadsAllowedFor(request.peer)) {
      this.audit({
        op: OPS.pushFile,
        action,
        transferId: String(request.transferId ?? '').slice(0, 120),
        name: String(request.name ?? '').slice(0, 200),
        bytes: 0,
        peer: peerId,
        ok: false,
        code: CODES.uploadsDisabled,
      })
      this.log?.warn?.('push-file rejected: uploads disabled', { action, peer: peerId })
      const error = new ShadowError(CODES.uploadsDisabled, 'file uploads are disabled on this device (enable shadow.uploads.enabled or grant this peer)')
      error.audited = true
      throw error
    }
    switch (action) {
      case 'begin':
        return this.uploads.begin(request)
      case 'chunk':
        return this.uploads.chunk(request)
      case 'commit':
        return this.uploads.commit(request)
      case 'abort':
        return this.uploads.abort(request)
      default:
        fail(CODES.badRequest, `unknown push-file action: ${action || '(missing)'}`)
    }
  }

  // ---------------------------------------------------------------------
  // Composer controls (0.10.25): permission presets + attachment staging
  // ---------------------------------------------------------------------

  /**
   * Capability gates advertised to a display machine (`ext.shadow.info`).
   * Everything is additive: a 0.10.24 display peer ignores these fields and the
   * controls that depend on them stay hidden.
   * @returns {{permissions: boolean, attachments: boolean}}
   */
  capabilitiesInfo() {
    const presets = Boolean(this.#service('permissionPresets'))
    // The preset methods need a live Host Session object, which comes from the
    // agents (live Agent) or sessions registry.
    const sessions = this.#service('sessions')
    const agents = this.#service('agents')
    const reachable = Boolean(sessions && typeof sessions.get === 'function')
      || Boolean(agents && typeof agents.get === 'function')
    return {
      permissions: presets && reachable,
      attachments: Boolean(this.#service('fileUploads')) && Boolean(this.#service('attachments')),
    }
  }

  /**
   * Preset catalog for `info` (best effort): `{options, defaultOptions,
   * defaultPreset}` or null when the service is absent/broken. `current` is
   * session-scoped and only returned by the `permissions` op.
   * @returns {object|null} serializable catalog or null.
   */
  permissionCatalogInfo() {
    const service = this.#service('permissionPresets')
    if (!service || typeof service.catalog !== 'function') return null
    try {
      const catalog = service.catalog()
      if (!catalog || typeof catalog !== 'object') return null
      const options = (Array.isArray(catalog.options) ? catalog.options : []).map(permissionOptionOf).filter(Boolean)
      const defaultOptions = (Array.isArray(catalog.defaultOptions) ? catalog.defaultOptions : []).map(permissionOptionOf).filter(Boolean)
      return {
        options,
        defaultOptions,
        defaultPreset: typeof catalog.defaultPreset === 'string' ? catalog.defaultPreset : '',
      }
    } catch (error) {
      this.log?.warn?.('permission catalog unavailable', { error: errorText(error) })
      return null
    }
  }

  /**
   * Composer attachment limits for `info` / `localEvents`. The Host's own
   * `attachments.imageLimits` (per-message image count, pixels, dimensions) is
   * passed through untouched: admission enforces it, the display only shows it.
   * @returns {object} serializable limit view.
   */
  attachmentLimitInfo() {
    const attachmentsService = this.#service('attachments')
    const imageLimits = attachmentsService?.imageLimits && typeof attachmentsService.imageLimits === 'object'
      ? attachmentsService.imageLimits
      : null
    return {
      chunkBytes: LIMITS.attachChunkBytes,
      maxBytes: LIMITS.maxAttachBytes,
      maxAttachments: LIMITS.maxPromptAttachments,
      maxImageBytes: LIMITS.maxPromptImageBytes,
      ...(imageLimits ? { imageLimits } : {}),
    }
  }

  /**
   * `ext.shadow.permissions`: read the Host preset catalog (`op: 'catalog'`) or
   * switch one session's preset (`op: 'set'`).
   *
   * A preset bundles a sandbox mode plus an approval policy, so loosening ones
   * (`danger-full-access`, `auto`) additionally require the display user's
   * explicit `confirmed: true` — matching native's risk confirmation.
   * @param {{sessionId: string, op?: string, preset?: string, confirmed?: boolean, peer?: object}} request - preset request.
   * @returns {Promise<{options?: object[], defaultPreset?: string, current: string, preset?: string}>}
   */
  async permissions(request = {}) {
    this.#assertSharing()
    const sessionId = this.#requireSession(request.sessionId)
    this.#assertRecordShared(sessionId)
    this.#assertOwner(sessionId, request.peer)
    const session = await this.#sessionObject(sessionId)
    const service = this.#service('permissionPresets')
    if (!service) fail(CODES.permissionUnavailable, 'permission presets are unavailable on this host')
    const peerId = String(request.peer?.deviceId ?? '')
    const action = typeof request.op === 'string' && request.op ? request.op : 'catalog'
    if (action === 'catalog') {
      if (typeof service.catalog !== 'function') {
        fail(CODES.permissionUnavailable, 'permissionPresets.catalog() is unavailable on this Host')
      }
      const catalog = service.catalog()
      const current = typeof service.current === 'function' ? String(service.current(session)) : ''
      this.audit({ op: OPS.permissions, action, sessionId, peer: peerId, ok: true })
      this.log?.info?.('permission catalog served', {
        sessionId,
        peer: peerId,
        options: Array.isArray(catalog?.options) ? catalog.options.length : 0,
        current,
      })
      return {
        options: Array.isArray(catalog?.options) ? catalog.options : [],
        defaultPreset: typeof catalog?.defaultPreset === 'string' ? catalog.defaultPreset : '',
        current,
      }
    }
    if (action !== 'set') fail(CODES.badRequest, `unknown permissions op: ${action}`)
    if (typeof service.set !== 'function') {
      fail(CODES.permissionUnavailable, 'permissionPresets.set() is unavailable on this Host')
    }
    const preset = String(request.preset ?? '')
    const names = Array.isArray(service.names) ? service.names : []
    if (!preset || !names.includes(preset)) {
      fail(CODES.badRequest, `unknown permission preset: ${preset || '(missing)'}`)
    }
    if ((preset === 'danger-full-access' || preset === 'auto') && request.confirmed !== true) {
      fail(CODES.badRequest, 'high-risk preset needs explicit confirmation')
    }
    // The service appends the durable `permission/preset` + sandbox/approval
    // events itself; the mirrored frames then confirm the switch on the display.
    service.set(session, preset)
    const current = typeof service.current === 'function' ? String(service.current(session)) : preset
    this.audit({ op: OPS.permissions, action, sessionId, peer: peerId, preset, ok: true })
    this.log?.info?.('permission preset set', { sessionId, peer: peerId, preset, current })
    return { current, preset }
  }

  /**
   * `ext.shadow.attach`: one chunked staging step for a composer attachment.
   *
   * Bytes live only in this Map until the prompt consumes them; the Host
   * admission persists the final image/file. `begin`/`commit`/`abort` write one
   * audit row each and `chunk` only on failure — a 64 MiB file is up to 128
   * chunks and must not flood the audit ring (same rule as `push-file`).
   * @param {{action: string, sessionId: string, transferId?: string, kind?: string, name?: string, size?: number, mediaType?: string, index?: number, data?: string, peer?: object}} request - staging step.
   * @returns {object} step result.
   */
  attachStep(request = {}) {
    const action = String(request.action ?? '')
    const transferId = String(request.transferId ?? '')
    const peerId = String(request.peer?.deviceId ?? '')
    try {
      this.#assertSharing()
      const sessionId = this.#requireSession(request.sessionId)
      this.#assertRecordShared(sessionId)
      this.#assertOwner(sessionId, request.peer)
      // Attachments are only advertised when the Host can mint upload receipts.
      if (!this.#service('fileUploads')) {
        fail(CODES.notReady, 'file uploads are unavailable on this host')
      }
      this.#purgeStagedAttachments()
      switch (action) {
        case 'begin':
          return this.#attachBegin(request, sessionId, peerId)
        case 'chunk':
          return this.#attachChunk(request, sessionId, peerId)
        case 'commit':
          return this.#attachCommit(request, sessionId, peerId)
        case 'abort':
          return this.#attachAbort(request, sessionId, peerId)
        default:
          fail(CODES.badRequest, `unknown attach action: ${action || '(missing)'}`)
      }
    } catch (error) {
      // One audit row per failed step, instead of the generic `handleRpc` row
      // (which would double-log chunk errors).
      if (typeof error?.code === 'string' && error.audited !== true) {
        this.audit({
          op: OPS.attach,
          action,
          transferId: transferId.slice(0, LIMITS.maxUploadTransferIdChars),
          sessionId: String(request.sessionId ?? ''),
          peer: peerId,
          ok: false,
          code: error.code,
        })
        if (error instanceof ShadowError) error.audited = true
      }
      throw error
    }
  }

  /** Drop staged transfers past their TTL. */
  #purgeStagedAttachments() {
    if (this.stagedAttachments.size === 0) return
    const now = this.now()
    for (const [transferId, staged] of this.stagedAttachments) {
      if (now - staged.createdAt > LIMITS.attachTtlMs) this.stagedAttachments.delete(transferId)
    }
  }

  /** Look up one staged transfer, enforcing session + device ownership. */
  #stagedFor(transferId, sessionId, peerId) {
    const id = String(transferId ?? '')
    const staged = this.stagedAttachments.get(id)
    if (!staged || staged.sessionId !== sessionId || staged.peerId !== peerId) {
      fail(CODES.attachNotFound, `attachment transfer "${id}" is not staged for this session`)
    }
    return staged
  }

  /** `attach` begin: reserve one transfer and advertise the chunk size. */
  #attachBegin(request, sessionId, peerId) {
    const kind = request.kind === 'image' || request.kind === 'file' ? request.kind : ''
    if (!kind) fail(CODES.attachBadKind, 'attachment kind must be "image" or "file"')
    const size = Number(request.size)
    if (!Number.isInteger(size) || size < 0 || size > LIMITS.maxAttachBytes) {
      fail(CODES.attachTooLarge, `attachment size must be an integer between 0 and ${LIMITS.maxAttachBytes} bytes`)
    }
    if (this.stagedAttachments.size >= LIMITS.maxAttachTransfers) {
      fail(CODES.attachBusy, `too many staged attachment transfers (max ${LIMITS.maxAttachTransfers})`)
    }
    const name = String(request.name ?? '').trim().slice(0, LIMITS.maxUploadNameChars)
    let mediaType = ''
    if (kind === 'image') {
      mediaType = typeof request.mediaType === 'string' ? request.mediaType.trim().slice(0, 100) : ''
      if (!mediaType) fail(CODES.attachBadKind, 'image attachments require a mediaType')
    }
    const transferId = newId('shadow-attach-')
    this.stagedAttachments.set(transferId, {
      transferId,
      sessionId,
      peerId,
      kind,
      name,
      mediaType,
      size,
      bytes: 0,
      chunks: [],
      sha256: '',
      createdAt: this.now(),
      committed: false,
    })
    this.audit({ op: OPS.attach, action: 'begin', sessionId, peer: peerId, transferId, kind, name, size, ok: true })
    this.log?.info?.('attachment staging begin', { sessionId, peer: peerId, transferId, kind, size, name })
    return {
      transferId,
      chunkBytes: LIMITS.attachChunkBytes,
      maxBytes: LIMITS.maxAttachBytes,
      ttlMs: LIMITS.attachTtlMs,
    }
  }

  /** `attach` chunk: append one canonical base64 chunk at the next index. */
  #attachChunk(request, sessionId, peerId) {
    const transferId = String(request.transferId ?? '')
    const staged = this.#stagedFor(transferId, sessionId, peerId)
    if (staged.committed) fail(CODES.attachBadChunk, 'attachment transfer is already committed')
    const raw = typeof request.data === 'string' ? request.data : ''
    const bytes = Buffer.from(raw, 'base64')
    if (bytes.toString('base64') !== raw) {
      fail(CODES.attachBadChunk, 'attachment chunk must be canonical base64')
    }
    if (bytes.length > LIMITS.attachChunkBytes) {
      fail(CODES.attachBadChunk, `attachment chunk exceeds ${LIMITS.attachChunkBytes} bytes`)
    }
    const index = Number(request.index)
    if (!Number.isInteger(index) || index !== staged.chunks.length) {
      fail(CODES.attachBadChunk, `attachment chunk index ${String(request.index)} is out of order (expected ${staged.chunks.length})`)
    }
    if (staged.bytes + bytes.length > staged.size || staged.bytes + bytes.length > LIMITS.maxAttachBytes) {
      fail(CODES.attachTooLarge, `attachment transfer exceeds its declared size (${staged.size} bytes)`)
    }
    staged.chunks.push(bytes)
    staged.bytes += bytes.length
    return { received: staged.bytes, index: staged.chunks.length - 1 }
  }

  /** `attach` commit: verify the declared size and hash the staged bytes. */
  #attachCommit(request, sessionId, peerId) {
    const transferId = String(request.transferId ?? '')
    const staged = this.#stagedFor(transferId, sessionId, peerId)
    const result = {
      transferId,
      kind: staged.kind,
      name: staged.name,
      size: staged.size,
      sha256: staged.sha256,
    }
    // Idempotent retry: the bytes and the hash cannot change after a commit.
    if (staged.committed) return result
    if (staged.bytes !== staged.size) {
      fail(CODES.attachBadChunk, `attachment transfer received ${staged.bytes} of ${staged.size} bytes`)
    }
    const hash = createHash('sha256')
    for (const chunk of staged.chunks) hash.update(chunk)
    staged.sha256 = hash.digest('hex')
    staged.committed = true
    result.sha256 = staged.sha256
    this.audit({
      op: OPS.attach,
      action: 'commit',
      sessionId,
      peer: peerId,
      transferId,
      kind: staged.kind,
      name: staged.name,
      size: staged.size,
      sha256: staged.sha256,
      ok: true,
    })
    this.log?.info?.('attachment staging commit', { sessionId, peer: peerId, transferId, kind: staged.kind, size: staged.size })
    return result
  }

  /** `attach` abort: drop staged bytes without touching the Host. */
  #attachAbort(request, sessionId, peerId) {
    const transferId = String(request.transferId ?? '')
    const staged = this.#stagedFor(transferId, sessionId, peerId)
    this.stagedAttachments.delete(transferId)
    this.audit({ op: OPS.attach, action: 'abort', sessionId, peer: peerId, transferId, kind: staged.kind, name: staged.name, ok: true })
    this.log?.info?.('attachment staging abort', { sessionId, peer: peerId, transferId })
    return { aborted: true }
  }

  // ---------------------------------------------------------------------
  // Event mirror
  // ---------------------------------------------------------------------

  #onSessionEvent(session, event) {
    if (this.disposed) return
    try {
      const sessionId = typeof session?.id === 'string' ? session.id : ''
      if (!sessionId) return
      const log = this.logs.get(sessionId)
      if (!log) return
      const frame = normalizeEvent(event, { workspaceId: this.registry.get(sessionId)?.workspaceId })
      if (frame) log.appendEvent(frame)
      this.#observeEvent(sessionId, event)
    } catch (error) {
      this.log?.warn?.('[shadow-workspace] session event handling failed:', errorText(error))
    }
  }

  #observeEvent(sessionId, event) {
    const type = event?.type
    if (type === 'turn/start') {
      this.registry.update(sessionId, { lastStatus: 'running' })
      return
    }
    if (type === 'turn/end') {
      const reason = trimTurnEndReason(event?.data?.reason)
      this.registry.update(sessionId, { lastStatus: 'idle', lastTurnReason: reason })
      for (const pending of [...this.pendingApprovals.values()]) {
        if (pending.sessionId === sessionId) pending.settle?.('cancelled', 'turn-ended')
      }
      for (const pending of [...this.pendingQuestions.values()]) {
        if (pending.sessionId === sessionId) {
          pending.settleError?.(Object.assign(new Error('the turn ended before the question was answered'), { code: 'ASK_CANCELLED' }), 'turn-ended')
        }
      }
      return
    }
    if (type === 'assistant/message') {
      const text = textOfMessage(event?.data?.message)
      if (text) this.registry.update(sessionId, { lastText: truncate(text, LIMITS.maxTextChars) })
      return
    }
    if (type === 'session/title') {
      const title = typeof event?.data?.title === 'string' ? event.data.title : ''
      if (title) this.registry.update(sessionId, { title })
      return
    }
    if (type === 'model/selection') {
      const selection = modelSelectionOf(event?.data)
      if (selection) this.registry.update(sessionId, { lastModel: selection })
    }
  }

  #onAssistantStream(payload) {
    if (this.disposed) return
    try {
      const frame = normalizeStreamFrame(payload)
      if (!frame) return
      const log = this.logs.get(frame.sessionId)
      if (!log) return
      log.appendTransient({
        kind: 'stream',
        sessionId: frame.sessionId,
        attemptId: frame.attemptId,
        revision: frame.revision,
        type: frame.type,
        ...(frame.index === undefined ? {} : { index: frame.index }),
        ...(frame.turn === undefined ? {} : { turn: frame.turn }),
        ...(frame.step === undefined ? {} : { step: frame.step }),
        ...(frame.time === undefined ? {} : { time: frame.time }),
        ...(frame.chunk === undefined ? {} : { chunk: frame.chunk }),
        ...(frame.outcome === undefined ? {} : { outcome: frame.outcome }),
      })
      this.registry.update(frame.sessionId, { lastStatus: 'running' })
    } catch (error) {
      this.log?.warn?.('[shadow-workspace] stream frame handling failed:', errorText(error))
    }
  }

  #onAgentStatus(payload) {
    if (this.disposed) return
    try {
      const sessionId = payload?.agent?.session?.id ?? payload?.agent?.id
      if (typeof sessionId !== 'string' || !this.logs.has(sessionId)) return
      const status = payload?.status === 'running' ? 'running' : 'idle'
      this.registry.update(sessionId, { lastStatus: status })
      this.logs.get(sessionId)?.appendTransient({ kind: 'status', sessionId, status, time: this.now() })
    } catch {}
  }

  // ---------------------------------------------------------------------
  // Approvals
  // ---------------------------------------------------------------------

  /**
   * Register the per-Agent approval answerer (decision #3).
   * Runs for every Agent; non-shadow Agents delegate immediately.
   */
  #onAgentCreated(payload) {
    if (this.disposed) return
    const agent = payload?.agent
    const sessionId = agent?.session?.id
    if (typeof sessionId !== 'string' || !agent?.ctx) return
    try {
      agent.ctx.on('approval/request', (request, next) => this.#onApprovalRequest(request, next), { prepend: true })
      agent.ctx.on('user-questions/request', (request, next) => this.#onUserQuestionRequest(request, next), { prepend: true })
      this.log?.debug?.('approval + question answerers registered on agent.ctx', { sessionId, prepend: true })
    } catch (error) {
      this.log?.warn?.('cannot register approval/question answerer', { sessionId, error })
    }
  }

  /**
   * Approval waterfall answerer for one Agent.
   *
   * Returns an outcome only when the Agent belongs to a bridge-managed shadow
   * session. Otherwise it delegates with `next()`. A shadow session's approval
   * is answered by an explicit display-machine click; when B is offline, or
   * when the 60 s window expires, the request is handed to the local official
   * UI through `next()` (still a human confirmation, still fail closed if no
   * UI answers).
   * @param {any} request - `{agent, toolName, callId?, reason?, displayReason?, signal}`.
   * @param {() => Promise<string>} next - next waterfall listener.
   * @returns {Promise<string>} approval outcome.
   */
  async #onApprovalRequest(request, next) {
    if (this.disposed) return next()
    const sessionId = request?.agent?.session?.id
    if (typeof sessionId !== 'string' || !this.logs.has(sessionId)) return next()
    if (!this.sharingActive) {
      // Sharing paused/killed: shadow sessions fail closed without popping the
      // local UI for a session B created.
      this.log?.info?.('approval rejected: sharing disabled', { sessionId, toolName: String(request?.toolName ?? '') })
      return 'rejected'
    }
    // Do NOT fall back immediately when dsh-sync reports the display peer as
    // offline: with a manually-added peer A never sees B in its own discovery
    // list even while B is actively calling us. Presence is refreshed by every
    // inbound ext.shadow.* RPC, so wait for the display machine up to the TTL;
    // the timeout below is the only local-UI fallback.
    const attached = this.#peerReachable(this.registry.get(sessionId)?.creatorPeerId || '')
    if (!attached) {
      this.log?.warn?.('approval waiting without fresh display presence; will fall back to local UI after TTL', {
        sessionId,
        toolName: String(request?.toolName ?? ''),
        ttlMs: this.approvalTtlMs,
      })
    }
    const approvalId = newId('shadow-appr-')
    const expiresAt = this.now() + this.approvalTtlMs
    const pending = {
      approvalId,
      sessionId,
      toolName: String(request?.toolName ?? 'tool'),
      callId: request?.callId === undefined ? undefined : String(request.callId),
      reason: truncate(reasonText(request?.reason), 2000),
      displayReason: truncate(reasonText(request?.displayReason), 2000),
      createdAt: this.now(),
      expiresAt,
      signal: request?.signal,
      settle: null,
      timer: null,
      abortListener: null,
      done: false,
      next,
    }
    this.pendingApprovals.set(approvalId, pending)
    const log = this.logs.get(sessionId)
    log?.appendTransient({ kind: 'approval', phase: 'asked', ...this.#approvalView(pending) })
    this.audit({ action: 'approval.asked', sessionId, approvalId, toolName: pending.toolName, ok: true })
    this.log?.info?.('approval asked', {
      sessionId,
      approvalId,
      toolName: pending.toolName,
      callId: pending.callId || '',
      reasonChars: (pending.reason || pending.displayReason || '').length,
      ttlMs: this.approvalTtlMs,
    })
    return await new Promise((resolve) => {
      pending.settle = (outcome, why) => {
        if (pending.done) return
        pending.done = true
        if (pending.timer) clearTimeout(pending.timer)
        if (pending.abortListener && typeof pending.signal?.removeEventListener === 'function') {
          try { pending.signal.removeEventListener('abort', pending.abortListener) } catch {}
        }
        this.pendingApprovals.delete(approvalId)
        const final = normalizeOutcome(outcome)
        log?.appendTransient({ kind: 'approval', phase: 'decided', approvalId, sessionId, outcome: final, ...(why === undefined ? {} : { reason: why }) })
        this.audit({ action: 'approval.decided', sessionId, approvalId, outcome: final, why: why ?? '', ok: final === 'allowed-once' })
        this.log?.info?.('approval decided', { sessionId, approvalId, outcome: final, why: why || '' })
        resolve(final)
      }
      pending.timer = setTimeout(() => {
        pending.timer = null
        if (pending.done) return
        // 60 s window elapsed: hand the same request to the local official UI
        // (still a real user confirmation). If no UI answers, fail closed.
        this.audit({ action: 'approval.fallback-local', sessionId, approvalId, reason: 'ttl', ok: true })
        this.log?.warn?.('approval window elapsed; falling back to local UI', { sessionId, approvalId, ttlMs: this.approvalTtlMs })
        Promise.resolve()
          .then(() => pending.next())
          .then((outcome) => pending.settle(normalizeOutcome(outcome), 'ttl-local-fallback'))
          .catch((error) => {
            this.log?.warn?.('local UI fallback failed; failing closed', { sessionId, approvalId, error })
            pending.settle('unavailable', 'ttl-local-fallback-error')
          })
      }, this.approvalTtlMs)
      pending.timer.unref?.()
      if (request?.signal && typeof request.signal.addEventListener === 'function') {
        pending.abortListener = () => pending.settle('cancelled', 'aborted')
        request.signal.addEventListener('abort', pending.abortListener, { once: true })
      }
    })
  }

  #approvalView(row) {
    return {
      approvalId: row.approvalId,
      sessionId: row.sessionId,
      toolName: row.toolName,
      ...(row.callId === undefined ? {} : { callId: row.callId }),
      ...(row.reason === undefined ? {} : { reason: row.reason }),
      ...(row.displayReason === undefined ? {} : { displayReason: row.displayReason }),
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
      ttlMs: this.approvalTtlMs,
    }
  }

  /** Pending approvals visible to one display device. */
  listApprovals(request = {}) {
    const sessionId = typeof request.sessionId === 'string' && request.sessionId ? request.sessionId : ''
    if (sessionId) {
      this.#requireSession(sessionId)
      this.#assertOwner(sessionId, request.peer)
    }
    return {
      approvals: [...this.pendingApprovals.values()]
        .filter((row) => !sessionId || row.sessionId === sessionId)
        .filter((row) => {
          if (sessionId) return true
          const record = this.registry.get(row.sessionId)
          return this.#isOwner(record, request.peer)
        })
        .map((row) => this.#approvalView(row)),
    }
  }

  /**
   * Record the display machine's explicit decision.
   * @param {{sessionId: string, approvalId: string, outcome: string, peer?: object}} request - answer input.
   * @returns {Promise<{accepted: true, outcome: string}>}
   */
  async answerApproval(request = {}) {
    const sessionId = this.#requireSession(request.sessionId)
    this.#assertRecordShared(sessionId)
    this.#assertOwner(sessionId, request.peer)
    const { approvalId, outcome } = assertAnswer(request)
    const pending = this.pendingApprovals.get(approvalId)
    if (!pending || pending.sessionId !== sessionId) {
      fail(CODES.approvalGone, `approval "${approvalId}" is no longer pending`)
    }
    if (this.now() > pending.expiresAt) {
      pending.settle('unavailable', 'timeout')
      fail(CODES.approvalTtl, `approval "${approvalId}" expired`)
    }
    pending.settle(outcome, 'answered')
    this.log?.info?.('approval answer accepted', { sessionId, approvalId, outcome })
    return { accepted: true, outcome }
  }

  // ---------------------------------------------------------------------
  // Interactive user questions / plan review (0.8.0)
  // ---------------------------------------------------------------------

  /**
   * Question waterfall answerer for one Agent (`'user-questions/request'`).
   *
   * Only bridge-managed shadow sessions are claimed; every other Agent
   * delegates with `next()`. A claimed question is answered by an explicit
   * display-machine submission. When B stays offline, or the 60 s window
   * elapses, the same request is handed to the local official UI through
   * `next()` — never auto-approved, and never silently skipped.
   * @param {any} request - `{agent, questions, signal, wait?}`.
   * @param {() => Promise<{answers: Array<object>}>} next - next waterfall listener.
   * @returns {Promise<{answers: Array<object>}>} accepted answer batch.
   */
  async #onUserQuestionRequest(request, next) {
    if (this.disposed) return next()
    const sessionId = request?.agent?.session?.id
    if (typeof sessionId !== 'string' || !this.logs.has(sessionId)) return next()
    const normalized = normalizeQuestionRequest(request)
    if (!normalized) {
      this.log?.warn?.('user-questions request could not be normalized; delegating to local UI', { sessionId })
      return next()
    }
    if (!this.sharingActive) {
      this.log?.info?.('question delegated to local UI: sharing disabled', { sessionId })
      return next()
    }
    const attached = this.#peerReachable(this.registry.get(sessionId)?.creatorPeerId || '')
    if (!attached) {
      this.log?.warn?.('question waiting without fresh display presence; will fall back to local UI after TTL', {
        sessionId,
        ttlMs: this.approvalTtlMs,
      })
    }
    const questionId = newId('shadow-question-')
    const expiresAt = this.now() + this.approvalTtlMs
    const pending = {
      questionId,
      sessionId,
      callId: normalized.callId,
      questions: normalized.questions,
      intent: normalized.intent,
      planReview: normalized.planReview,
      createdAt: this.now(),
      expiresAt,
      signal: request?.signal,
      done: false,
      timer: null,
      abortListener: null,
      next,
      settleAnswer: null,
      settleError: null,
      fallbackToLocal: null,
    }
    this.pendingQuestions.set(questionId, pending)
    const log = this.logs.get(sessionId)
    log?.appendTransient({ kind: 'question', phase: 'asked', ...this.#questionView(pending) })
    this.audit({
      action: 'question.asked',
      sessionId,
      questionId,
      questions: pending.questions.length,
      planReview: pending.planReview,
      ok: true,
    })
    this.log?.info?.('question asked', {
      sessionId,
      questionId,
      questions: pending.questions.length,
      options: pending.questions.reduce((total, question) => total + (question.options?.length || 0), 0),
      planReview: pending.planReview,
      callId: pending.callId || '',
      ttlMs: this.approvalTtlMs,
    })
    return await new Promise((resolve, reject) => {
      const clear = () => {
        if (pending.timer) clearTimeout(pending.timer)
        pending.timer = null
        if (pending.abortListener && typeof pending.signal?.removeEventListener === 'function') {
          try { pending.signal.removeEventListener('abort', pending.abortListener) } catch {}
        }
        this.pendingQuestions.delete(questionId)
      }
      pending.settleAnswer = (answers, why) => {
        if (pending.done) return
        pending.done = true
        clear()
        log?.appendTransient({ kind: 'question', phase: 'answered', questionId, sessionId, answers })
        this.audit({ action: 'question.answered', sessionId, questionId, answers: answers.length, why: why || '', ok: true })
        this.log?.info?.('question answered', { sessionId, questionId, answers: answers.length, why: why || '' })
        resolve({ answers })
      }
      pending.settleError = (error, why) => {
        if (pending.done) return
        pending.done = true
        clear()
        log?.appendTransient({ kind: 'question', phase: 'cancelled', questionId, sessionId, reason: why || '' })
        this.audit({ action: 'question.cancelled', sessionId, questionId, why: why || '', ok: true })
        this.log?.info?.('question cancelled', { sessionId, questionId, why: why || '' })
        reject(error)
      }
      pending.fallbackToLocal = (why = 'ttl') => {
        if (pending.done) return
        this.audit({ action: 'question.fallback-local', sessionId, questionId, reason: why, ok: true })
        this.log?.warn?.('question released to local UI', { sessionId, questionId, reason: why })
        Promise.resolve()
          .then(() => pending.next())
          .then((value) => {
            const batch = normalizeQuestionAnswers(pending.questions, value?.answers)
            if (!batch) {
              pending.settleError(Object.assign(new Error('no user-questions answerer accepted the request'), { code: 'NO_PROVIDER' }), 'local-fallback-invalid')
              return
            }
            pending.settleAnswer(batch.answers, 'local-fallback')
          })
          .catch((error) => pending.settleError(error, 'local-fallback-error'))
      }
      pending.timer = setTimeout(() => {
        pending.timer = null
        if (!pending.done) pending.fallbackToLocal('ttl')
      }, this.approvalTtlMs)
      pending.timer.unref?.()
      if (request?.signal && typeof request.signal.addEventListener === 'function') {
        pending.abortListener = () => pending.settleError(
          Object.assign(new Error('ask_user_question was aborted before the user answered'), { code: 'ASK_ABORTED' }),
          'aborted',
        )
        request.signal.addEventListener('abort', pending.abortListener, { once: true })
      }
    })
  }

  /** Transport-safe view of one pending question batch. */
  #questionView(row) {
    return {
      questionId: row.questionId,
      sessionId: row.sessionId,
      ...(row.callId ? { callId: row.callId } : {}),
      questions: row.questions,
      ...(row.intent ? { intent: row.intent } : {}),
      planReview: row.planReview === true,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
      ttlMs: this.approvalTtlMs,
    }
  }

  /** Pending questions visible to one display device. */
  listQuestions(request = {}) {
    const sessionId = typeof request.sessionId === 'string' && request.sessionId ? request.sessionId : ''
    if (sessionId) {
      this.#requireSession(sessionId)
      this.#assertOwner(sessionId, request.peer)
    }
    return {
      questions: [...this.pendingQuestions.values()]
        .filter((row) => !sessionId || row.sessionId === sessionId)
        .filter((row) => {
          if (sessionId) return true
          return this.#isOwner(this.registry.get(row.sessionId), request.peer)
        })
        .map((row) => this.#questionView(row)),
    }
  }

  /**
   * Submit one answer batch (or request changes) for a pending question.
   * @param {{sessionId: string, questionId: string, answers?: object[], cancel?: boolean, reason?: string, peer?: object}} request - answer input.
   * @returns {Promise<{accepted: true, answers?: object[], cancelled?: true}>}
   */
  async answerQuestion(request = {}) {
    const sessionId = this.#requireSession(request.sessionId)
    this.#assertRecordShared(sessionId)
    this.#assertOwner(sessionId, request.peer)
    const questionId = typeof request.questionId === 'string' ? request.questionId : ''
    if (!questionId) fail(CODES.badRequest, 'questionId is required')
    const pending = this.pendingQuestions.get(questionId)
    if (!pending || pending.sessionId !== sessionId) {
      fail(CODES.questionGone, `question "${questionId}" is no longer pending`)
    }
    if (this.now() > pending.expiresAt) {
      pending.settleError(Object.assign(new Error('the question expired before it was answered'), { code: 'ASK_CANCELLED' }), 'timeout')
      fail(CODES.questionTtl, `question "${questionId}" expired`)
    }
    if (request.cancel === true) {
      const reason = typeof request.reason === 'string' && request.reason ? request.reason.slice(0, 200) : 'modify-requested'
      // "Request changes": reject the waterfall so the agent returns to its
      // editor instead of recording an approval.
      pending.settleError(Object.assign(new Error('用户要求先修改，再重新提交。'), { code: 'ASK_CANCELLED' }), reason)
      this.log?.info?.('question answered with cancel', { sessionId, questionId, reason })
      return { accepted: true, cancelled: true }
    }
    const batch = normalizeQuestionAnswers(pending.questions, request.answers)
    if (!batch) {
      fail(CODES.questionBadAnswer, 'the answer batch must name each question exactly once with valid option labels')
    }
    pending.settleAnswer(batch.answers, 'answered')
    this.log?.info?.('question answer accepted', { sessionId, questionId, answers: batch.answers.length })
    return { accepted: true, answers: batch.answers }
  }

  // ---------------------------------------------------------------------
  // Event reads
  // ---------------------------------------------------------------------

  /**
   * Read one cursor page for the display machine.
   * @param {object} request - `{sessionId, sinceSeq, sinceRev, epoch, waitMs, closing}`.
   * @returns {Promise<object>} batch (events, transient, cursor, status, approvals).
   */
  async readEvents(request = {}) {
    const started = this.now()
    const sessionId = this.#requireSession(request.sessionId)
    let log = this.logs.get(sessionId)
    if (!log) {
      // A restart keeps the durable registry but not the in-memory mirror.
      // Rebuild the mirror from the Session log on first access instead of
      // answering `session-not-managed`.
      log = this.#rehydrate(sessionId)
    }
    if (request.closing === true) {
      // Display half closed its page: stop holding the long poll and let the
      // request return now. The next real `events` call resumes.
      this.#assertOwner(sessionId, request.peer)
      log.setPaused(true)
      this.log?.debug?.('long poll closed by display page', { sessionId })
      return this.#batchEnvelope(sessionId, { reset: false, events: [], transient: [], cursor: { seq: int(request.sinceSeq, -1), rev: int(request.sinceRev, 0) }, more: false, pendingEvents: 0, pendingTransient: 0 })
    }
    this.#assertSharing()
    this.#assertRecordShared(sessionId)
    this.#assertOwner(sessionId, request.peer)
    log.setPaused(false)
    const callerEpoch = typeof request.epoch === 'string' ? request.epoch : ''
    if (callerEpoch && callerEpoch !== this.epoch) {
      this.log?.info?.('epoch mismatch; display mirror reset', { sessionId })
      return this.#batchEnvelope(sessionId, { reset: true, events: [], transient: [], cursor: { seq: -1, rev: 0 }, more: false, pendingEvents: 0, pendingTransient: 0 })
    }
    const sinceSeq = int(request.sinceSeq, -1)
    try {
      await log.ensureCold(sinceSeq)
    } catch (error) {
      if (error instanceof ShadowError) throw error
      if (isStaleSession(error)) {
        this.registry.remove(sessionId)
        fail(CODES.notFound, `session "${sessionId}" no longer exists on this device; start a new shadow session`)
      }
      throw error
    }
    if (sinceSeq > log.lastSeq) {
      this.log?.info?.('cursor ahead of local log; display mirror reset', { sessionId, sinceSeq, lastSeq: log.lastSeq })
      return this.#batchEnvelope(sessionId, { reset: true, events: [], transient: [], cursor: { seq: -1, rev: 0 }, more: false, pendingEvents: 0, pendingTransient: 0 })
    }
    const waitMs = Math.max(0, Math.min(LIMITS.maxWaitMs, int(request.waitMs, 0)))
    this.log?.debug?.('long poll start', { sessionId, sinceSeq, sinceRev: int(request.sinceRev, 0), waitMs })
    let page
    try {
      page = await log.read({
        sinceSeq,
        sinceRev: int(request.sinceRev, 0),
        waitMs,
        maxFrames: LIMITS.maxEventFrames,
        maxTransient: LIMITS.maxTransientFrames,
        maxBytes: LIMITS.maxBatchBytes,
      })
    } catch (error) {
      this.log?.warn?.('long poll failed', { sessionId, error })
      if (error instanceof ShadowError) throw error
      if (isStaleSession(error)) {
        this.registry.remove(sessionId)
        fail(CODES.notFound, `session "${sessionId}" no longer exists on this device; start a new shadow session`)
      }
      throw error
    }
    this.log?.debug?.('long poll end', {
      sessionId,
      frames: page.events.length + page.transient.length,
      more: page.more,
      ms: this.now() - started,
    })
    return this.#batchEnvelope(sessionId, { reset: false, ...page })
  }

  #batchEnvelope(sessionId, page) {
    const record = this.registry.get(sessionId)
    const pending = [...this.pendingApprovals.values()]
      .filter((row) => row.sessionId === sessionId)
      .map((row) => this.#approvalView(row))
    const questions = [...this.pendingQuestions.values()]
      .filter((row) => row.sessionId === sessionId)
      .map((row) => this.#questionView(row))
    return {
      sessionId,
      epoch: this.epoch,
      version: PLUGIN_VERSION,
      status: this.statusOf(sessionId),
      workspaceId: record?.workspaceId ?? '',
      title: record?.title ?? '',
      lastText: record?.lastText ?? '',
      turnReason: record?.lastTurnReason ?? null,
      model: record?.lastModel ?? null,
      approvals: pending,
      questions,
      ...page,
    }
  }

  // ---------------------------------------------------------------------
  // RPC dispatch
  // ---------------------------------------------------------------------

  /**
   * Serve one `ext.shadow.*` op from a paired peer.
   * @param {string} op - operation name.
   * @param {any} payload - JSON payload.
   * @param {object} peer - dsh-sync peer facts.
   * @returns {Promise<any>} JSON result.
   */
  async handleRpc(op, payload, peer) {
    if (this.disposed) fail(CODES.disabled, 'shadow bridge is not running')
    this.notePeer(peer)
    const body = isObject(payload) ? payload : {}
    try {
      let result
      switch (op) {
        case OPS.ping:
          result = {
            ok: true,
            protocol: PROTOCOL_VERSION,
            epoch: this.epoch,
            role: 'a',
            device: this.identity(),
            sharing: { enabled: this.sharingActive, workspaceCount: this.#sharedWorkspaces().length },
            now: this.now(),
          }
          break
        case OPS.info:
          result = {
            protocol: PROTOCOL_VERSION,
            version: PLUGIN_VERSION,
            epoch: this.epoch,
            role: 'a',
            device: this.identity(),
            sharing: { enabled: this.sharingActive },
            workspaces: this.#sharedWorkspaces(),
            // 0.10.25 composer controls: purely additive, a 0.10.24 display peer
            // ignores them and keeps its read-only chips.
            capabilities: this.capabilitiesInfo(),
            permissions: this.permissionCatalogInfo(),
            attachmentLimits: this.attachmentLimitInfo(),
            limits: {
              maxEventFrames: LIMITS.maxEventFrames,
              maxTransientFrames: LIMITS.maxTransientFrames,
              maxPromptChars: LIMITS.maxPromptChars,
              defaultWaitMs: LIMITS.defaultWaitMs,
              maxWaitMs: LIMITS.maxWaitMs,
              approvalTtlMs: this.approvalTtlMs,
              questionTtlMs: this.approvalTtlMs,
            },
            uploads: this.uploadInfo(peer),
          }
          break
        case OPS.list:
          result = { sharing: { enabled: this.sharingActive }, sessions: this.listSessions(peer) }
          break
        case OPS.create:
          result = await this.createSession({ ...body, peer })
          break
        case OPS.prompt:
          result = await this.prompt({ ...body, peer })
          break
        case OPS.cancel:
          result = await this.cancelSession({ ...body, peer })
          break
        case OPS.events:
          result = await this.readEvents({ ...body, peer })
          break
        case OPS.approvals:
          result = this.listApprovals({ ...body, peer })
          break
        case OPS.answer:
          result = await this.answerApproval({ ...body, peer })
          break
        case OPS.models:
          result = await this.modelCatalog()
          break
        case OPS.selectModel:
          result = await this.selectModel({ ...body, peer })
          break
        case OPS.questions:
          result = this.listQuestions({ ...body, peer })
          break
        case OPS.answerQuestion:
          result = await this.answerQuestion({ ...body, peer })
          break
        case OPS.pushFile:
          result = this.pushFile({ ...body, peer })
          break
        case OPS.permissions:
          // Audited inside the method (`action` + `preset`), one row per call.
          result = await this.permissions({ ...body, peer })
          break
        case OPS.attach:
          // Audited per staging step inside `attachStep`.
          result = this.attachStep({ ...body, peer })
          break
        default:
          fail(CODES.badRequest, `unknown shadow op: ${op}`)
      }
      // `events` is a long poll and `push-file`/`attach`/`permissions` audit
      // inside their own handlers: none may add one generic row per call.
      if (op !== OPS.events && op !== OPS.pushFile && op !== OPS.attach && op !== OPS.permissions) {
        this.audit({ op: op.replace(/^ext\.shadow\./, ''), ok: true, peer: String(peer?.deviceId ?? ''), sessionId: String(body.sessionId ?? '') })
        this.log?.debug?.('rpc ok', { op, peer: String(peer?.deviceId ?? ''), sessionId: String(body.sessionId ?? '') })
      }
      return result
    } catch (error) {
      const failure = error instanceof ShadowError ? { code: error.code, message: error.message } : asFailure(error)
      // Receiver failures carry `audited: true`: one audit row per failed step
      // is enough, and chunk errors must not flood the audit ring.
      if (error?.audited !== true) {
        this.audit({
          op: op.replace(/^ext\.shadow\./, ''),
          ok: false,
          peer: String(peer?.deviceId ?? ''),
          sessionId: String(body.sessionId ?? ''),
          code: failure.code,
          message: failure.message,
        })
      }
      this.log?.warn?.('rpc failed', {
        op,
        peer: String(peer?.deviceId ?? ''),
        sessionId: String(body.sessionId ?? ''),
        code: failure.code,
        error,
      })
      throw error instanceof ShadowError ? error : new ShadowError(failure.code, failure.message)
    }
  }

  /** Managed sessions visible to one display machine (owner-filtered). */
  listSessions(peer) {
    if (this.disposed) fail(CODES.disabled, 'shadow bridge is not running')
    if (!this.sharingActive) return []
    return this.registry.list()
      .filter((row) => this.state.workspaceAllowed(row.workspaceId))
      .filter((row) => this.#isOwner(row, peer))
      .map((row) => ({
        sessionId: row.sessionId,
        workspaceId: row.workspaceId,
        title: row.title,
        status: this.statusOf(row.sessionId),
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        lastText: truncate(row.lastText ?? '', 400),
        turnReason: row.lastTurnReason ?? null,
        model: row.lastModel ?? null,
        pendingApprovals: [...this.pendingApprovals.values()].filter((pending) => pending.sessionId === row.sessionId).length,
        pendingQuestions: [...this.pendingQuestions.values()].filter((pending) => pending.sessionId === row.sessionId).length,
      }))
  }

  // ---------------------------------------------------------------------
  // Guards + audit
  // ---------------------------------------------------------------------

  #assertSharing() {
    if (!this.sharingActive) fail(CODES.sharingOff, 'this device is not sharing any shadow workspace')
  }

  #assertSharedWorkspace(workspaceId) {
    if (!this.state.workspaceAllowed(workspaceId)) {
      fail(CODES.notShared, `workspace "${String(workspaceId)}" is not shared by this device`)
    }
  }

  #assertRecordShared(sessionId) {
    const record = this.registry.get(sessionId)
    if (!record) fail(CODES.notManaged, `session "${sessionId}" is not managed by this shadow bridge`)
    if (!this.state.workspaceAllowed(record.workspaceId)) {
      fail(CODES.notShared, `workspace of session "${sessionId}" is no longer shared`)
    }
  }

  /**
   * Whether `peer` may act on this shadow session. Explicitly local rows (or
   * rows created by another display device) are refused. Legacy rows written
   * before ownership existed carry no creator id: they stay visible and become
   * owned by the first paired device that writes to them (see `#assertOwner`).
   * @param {object|null} record - registry row.
   * @param {{deviceId?: string}} [peer] - calling dsh-sync peer.
   * @returns {boolean} true when the caller owns the session.
   */
  #isOwner(record, peer) {
    if (!record) return false
    const owner = typeof record.creatorPeerId === 'string' ? record.creatorPeerId : ''
    const caller = typeof peer?.deviceId === 'string' ? peer.deviceId : ''
    if (!caller) return false
    if (owner === 'local') return false
    if (!owner) return true
    return owner === caller
  }

  /** Fail with `shadow/not-owner` unless the display device owns the session. */
  #assertOwner(sessionId, peer) {
    const record = this.registry.get(sessionId)
    if (!record) fail(CODES.notManaged, `session "${sessionId}" is not managed by this shadow bridge`)
    const caller = typeof peer?.deviceId === 'string' ? peer.deviceId : ''
    if (caller && !record.creatorPeerId) {
      // Legacy registry row: adopt the first paired device that proves ownership
      // by acting on it, so old sessions survive the 0.6.x ownership filter.
      this.registry.update(sessionId, { creatorPeerId: caller })
      this.log?.info?.('legacy session owner adopted', { sessionId, deviceId: caller })
      return
    }
    if (!this.#isOwner(record, peer)) {
      fail(CODES.notOwner, `shadow session "${sessionId}" belongs to another display device`)
    }
  }

  #requireSession(sessionId) {
    const id = String(sessionId ?? '')
    if (!id) fail(CODES.badRequest, 'sessionId is required')
    if (!this.registry.get(id)) {
      fail(CODES.notManaged, `session "${id}" is not managed by this shadow bridge`)
    }
    return id
  }

  /** Append one audit row through the sink (also keeps a local ring when no sink). */
  audit(row) {
    if (this.auditSink) return this.auditSink.record(row)
    if (!this.localAudit) this.localAudit = []
    const entry = { at: new Date(this.now()).toISOString(), ...row }
    this.localAudit.push(entry)
    if (this.localAudit.length > LIMITS.maxAuditRows) this.localAudit.shift()
    return entry
  }

  /** Snapshot of the local audit ring (tests / fallback). */
  auditRows() {
    if (this.auditSink) return this.auditSink.last(LIMITS.maxAuditRows)
    return (this.localAudit || []).slice(-LIMITS.maxAuditRows)
  }
}

/**
 * Normalize the `shadow.uploads` config block (0.9.0).
 *
 * The uploads feature is deliberately off unless `enabled === true`; limits are
 * clamped to values the dsh-sync broker can carry (a base64 chunk travels in a
 * 1 MB request body, so the raw chunk cap is 700 KiB).
 * @param {any} raw - untrusted `config.uploads`.
 * @returns {{enabled: boolean, maxBytes: number, chunkBytes: number, ttlMs: number, maxTransfers: number}}
 */
export function normalizeUploadConfig(raw) {
  const input = raw && typeof raw === 'object' ? raw : {}
  const maxChunkBytes = 700 * 1024
  return {
    enabled: input.enabled === true,
    maxBytes: positiveInt(input.maxBytes, LIMITS.maxUploadBytes),
    chunkBytes: Math.min(maxChunkBytes, positiveInt(input.chunkBytes, LIMITS.uploadChunkBytes)),
    ttlMs: positiveInt(input.ttlMs, LIMITS.uploadTtlMs),
    maxTransfers: positiveInt(input.maxTransfers, LIMITS.maxUploadTransfers),
  }
}

/** Positive integer or fallback. */
function positiveInt(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}

/**
 * Resolve the receive directory: `<DSH_HOME>/shadow-uploads`.
 * @param {{uploadsDir?: string}} options - bridge options.
 * @param {import('./state.js').ShadowStateStore|null} state - product state store.
 * @returns {string} absolute directory, or '' when unknown (uploads disabled).
 */
export function resolveUploadsDir(options = {}, state = null) {
  if (typeof options.uploadsDir === 'string' && options.uploadsDir.trim()) return options.uploadsDir.trim()
  const stateDir = typeof state?.dir === 'string' ? state.dir : ''
  if (!stateDir) return ''
  return join(dirname(stateDir), UPLOADS_DIR)
}

/**
 * Normalize the `attachments` field of one prompt request.
 *
 * The wire shape is `[{transferId}]`; bare id strings are tolerated too. Empty
 * or unusable entries are dropped and the caller's order is preserved. At most
 * `LIMITS.maxPromptAttachments + 1` entries are kept so the caller can reject
 * an oversized list without allocating an attacker-sized array.
 * @param {any} value - untrusted `request.attachments`.
 * @returns {Array<{transferId: string}>} normalized references.
 */
export function normalizeAttachmentRefs(value) {
  if (!Array.isArray(value)) return []
  const out = []
  for (const entry of value) {
    const raw = typeof entry === 'string'
      ? entry
      : entry && typeof entry === 'object' ? String(entry.transferId ?? '') : ''
    const transferId = raw.trim()
    if (!transferId) continue
    out.push({ transferId: transferId.slice(0, 200) })
    if (out.length > LIMITS.maxPromptAttachments) break
  }
  return out
}

/**
 * Keep only the serializable fields of one preset catalog option (the Host
 * catalog also carries internal knobs the display must not render).
 * @param {any} option - `catalog().options[]` entry.
 * @returns {{value: string, name: string, description?: string}|null} option view.
 */
function permissionOptionOf(option) {
  if (!option || typeof option !== 'object') return null
  const value = typeof option.value === 'string' ? option.value : ''
  if (!value) return null
  return {
    value,
    name: String(option.name ?? value),
    ...(typeof option.description === 'string' ? { description: option.description } : {}),
  }
}

/** Whether a failure means the durable Session disappeared. */
export function isStaleSession(error) {
  const message = `${errorText(error)} ${String(error?.cause ?? '')}`
  return /session[/\s_-]*not[- ]?found|not[- ]?found|does not exist|no such session|不存在/i.test(message)
}
/**
 * Validate a requested model selection.
 * @param {any} value - untrusted `{provider, model, reasoningEffort?}`.
 * @returns {{provider: string, model: string, reasoningEffort?: string}}
 */
export function assertModelSelection(value) {
  if (!value || typeof value !== 'object') {
    fail(CODES.badRequest, 'model selection must be an object with provider and model')
  }
  const provider = typeof value.provider === 'string' ? value.provider.trim() : ''
  const model = typeof value.model === 'string' ? value.model.trim() : ''
  if (!provider) fail(CODES.badRequest, 'model selection requires a provider')
  if (!model) fail(CODES.badRequest, 'model selection requires a model')
  const effort = typeof value.reasoningEffort === 'string' ? value.reasoningEffort.trim() : ''
  return {
    provider: provider.slice(0, 200),
    model: model.slice(0, 200),
    ...(effort ? { reasoningEffort: effort.slice(0, 100) } : {}),
  }
}

/**
 * Reduce a Host LLM model catalogue to the fields the display machine needs.
 * @param {any} raw - `sessionController.modelCatalog()` result.
 * @returns {{default: object|null, groups: Array<object>, failures: Array<object>}}
 */
export function slimModelCatalog(raw) {
  const value = raw && typeof raw === 'object' ? raw : {}
  const groups = (Array.isArray(value.groups) ? value.groups : [])
    .map((group) => {
      const id = String(group?.id ?? '')
      const models = (Array.isArray(group?.models) ? group.models : [])
        .map((model) => {
          const modelId = String(model?.id ?? '')
          if (!modelId) return null
          const reasoning = model?.reasoning && typeof model.reasoning === 'object'
            ? {
              defaultEffort: typeof model.reasoning.defaultEffort === 'string' ? model.reasoning.defaultEffort : undefined,
              efforts: (Array.isArray(model.reasoning.efforts) ? model.reasoning.efforts : [])
                .map((effort) => ({
                  id: String(effort?.id ?? ''),
                  name: String(effort?.name ?? effort?.id ?? ''),
                }))
                .filter((effort) => effort.id),
            }
            : null
          return {
            id: modelId,
            name: String(model?.name ?? modelId),
            ...(reasoning && (reasoning.efforts.length > 0 || reasoning.defaultEffort)
              ? { reasoning }
              : {}),
          }
        })
        .filter(Boolean)
      if (!id) return null
      return {
        id,
        // `label` mirrors the provider display name; keep `name` for parity with
        // the Host schema.
        label: String(group?.label ?? group?.name ?? id),
        name: String(group?.name ?? group?.label ?? id),
        models,
      }
    })
    .filter((group) => group && group.models.length > 0)
  const failures = (Array.isArray(value.failures) ? value.failures : [])
    .map((failure) => ({
      id: String(failure?.id ?? ''),
      name: String(failure?.name ?? failure?.id ?? ''),
      message: truncate(failure?.message ?? '', 500),
    }))
    .filter((failure) => failure.id)
  return {
    default: modelSelectionOf(value.default) || null,
    groups,
    failures,
  }
}

/**
 * Normalize one `user-questions/request` into the transport shape.
 *
 * The service vocabulary is `{id, question, detail?, header?, options?,
 * multiSelect?, intent?}`; model-facing tool arguments use `multi_select`.
 * Both spellings are accepted. Returns null when the request cannot be shown
 * safely (the caller then delegates to the local UI instead of claiming it).
 * @param {any} request - waterfall request (`{questions, wait?, ...}`).
 * @returns {{questions: object[], intent: object|null, planReview: boolean, callId: string}|null}
 */
export function normalizeQuestionRequest(request) {
  const raw = Array.isArray(request?.questions) ? request.questions : []
  if (raw.length === 0 || raw.length > LIMITS.maxQuestions) return null
  const questions = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') return null
    const id = typeof item.id === 'string' ? item.id.trim().slice(0, 200) : ''
    const title = typeof item.question === 'string'
      ? item.question
      : typeof item.title === 'string' ? item.title : ''
    if (!id || !title.trim()) return null
    const detail = typeof item.detail === 'string' ? item.detail.slice(0, LIMITS.maxQuestionChars) : ''
    const header = typeof item.header === 'string' ? item.header.slice(0, 200) : ''
    const options = (Array.isArray(item.options) ? item.options : [])
      .slice(0, LIMITS.maxQuestionOptions)
      .map((option) => ({
        label: String(option?.label ?? '').slice(0, 200),
        ...(typeof option?.description === 'string' ? { description: option.description.slice(0, 1000) } : {}),
      }))
      .filter((option) => option.label)
    const multiSelect = item.multiSelect === true || item.multi === true || item.multi_select === true
    const intent = normalizeQuestionIntent(item.intent ?? request?.intent, detail)
    questions.push({
      id,
      question: title.trim().slice(0, 2000),
      ...(header ? { header } : {}),
      ...(detail ? { detail } : {}),
      ...(options.length > 0 ? { options } : {}),
      multiSelect,
      ...(intent ? { intent } : {}),
    })
  }
  const intent = questions.find((question) => question.intent)?.intent || null
  const callId = typeof request?.wait?.callId === 'string'
    ? request.wait.callId
    : typeof request?.callId === 'string' ? request.callId : ''
  return {
    questions,
    intent,
    planReview: Boolean(intent && intent.kind === 'plan-review'),
    callId,
  }
}

/** Normalize one question `intent` (only `plan-review` has semantics today). */
function normalizeQuestionIntent(intent, fallbackDetail = '') {
  if (!intent || typeof intent !== 'object') return null
  const kind = typeof intent.kind === 'string' ? intent.kind.trim() : ''
  if (!kind) return null
  const approve = typeof intent.approve === 'string' ? intent.approve.slice(0, 200) : ''
  const detail = typeof intent.detail === 'string' && intent.detail
    ? intent.detail.slice(0, LIMITS.maxQuestionChars)
    : fallbackDetail
  if (kind === 'plan-review' && !approve) return null
  return { kind, ...(approve ? { approve } : {}), ...(detail ? { detail } : {}) }
}

/**
 * Validate one answer batch against the asked questions.
 *
 * One item per question (skip = `{id, selected: []}`), labels must be real
 * options, single-select custom overrides the selection, multi-select custom
 * supplements it.
 * @param {object[]} questions - normalized questions of the pending request.
 * @param {any} answers - untrusted answer batch.
 * @returns {{answers: object[]}|null} normalized batch, or null when invalid.
 */
export function normalizeQuestionAnswers(questions, answers) {
  const list = Array.isArray(questions) ? questions : []
  if (!Array.isArray(answers) || answers.length !== list.length) return null
  const byId = new Map()
  for (const item of answers) {
    if (!item || typeof item !== 'object') return null
    const id = typeof item.id === 'string' ? item.id : ''
    if (!id || byId.has(id)) return null
    const selected = (Array.isArray(item.selected) ? item.selected : [])
      .map((label) => String(label).slice(0, 200))
    const custom = typeof item.custom === 'string' ? item.custom.trim().slice(0, LIMITS.maxAnswerChars) : ''
    byId.set(id, { selected, custom })
  }
  const out = []
  for (const question of list) {
    const value = byId.get(question.id)
    if (!value) return null
    const labels = new Set((question.options || []).map((option) => option.label))
    const selected = value.selected.filter((label) => labels.has(label))
    if (selected.length !== value.selected.length) return null
    if (question.multiSelect !== true) {
      const unique = [...new Set(selected)]
      if (unique.length > 1) return null
      out.push({
        id: question.id,
        // Single-select: a custom answer overrides the chosen option.
        selected: value.custom ? [] : unique,
        ...(value.custom ? { custom: value.custom } : {}),
      })
      continue
    }
    out.push({
      id: question.id,
      selected: [...new Set(selected)],
      ...(value.custom ? { custom: value.custom } : {}),
    })
  }
  return { answers: out }
}
