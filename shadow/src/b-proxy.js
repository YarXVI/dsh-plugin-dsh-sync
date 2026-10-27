// B-side (display machine) Shadow Workspace proxy.
//
// The display half never runs A's session: it calls `ext.shadow.*` on A through
// dsh-sync's encrypted broker, keeps a per-session mirror of the frames A
// produced, and serves that mirror to this machine's Web client through a
// same-origin Host route.
//
// Transport shape is pull-only: one long-polling `events` call per open session,
// cursor = `{seq, rev}`. A restart is detected by `epoch` and repaired by
// resetting the mirror and replaying from A's durable log. Open polls are
// capped (`maxEventOpenSessions`), paused when the page is hidden, and a closing
// page tells A to release its long poll immediately.
import { CODES, LIMITS, OPS, PROTOCOL_VERSION } from './constants.js'
import { EventLog } from './event-log.js'
import { ShadowError, delay, errorText, fail, int } from './util.js'

/**
 * Client-side proxy state and RPC driver.
 */
export class ShadowClientProxy {
  /**
   * @param {object} options - wiring.
   * @param {object} [options.sync] - `dshSync` service (may appear later).
   * @param {import('./state.js').ShadowStateStore} options.state - product state.
   * @param {object} [options.log] - logger.
   * @param {() => number} [options.now] - clock.
   * @param {object} [options.config] - tuning overrides (tests).
   */
  constructor(options = {}) {
    this.sync = options.sync || null
    this.store = options.state
    this.logger = options.log || null
    this.now = typeof options.now === 'function' ? options.now : () => Date.now()
    this.config = options.config || {}
    this.online = false
    this.lastError = ''
    this.epoch = ''
    this.device = { deviceId: '', name: '' }
    this.workspaces = []
    this.sharing = { enabled: false }
    this.limits = null
    /** Peer composer capabilities (`ext.shadow.info.capabilities`, 0.10.25). */
    this.capabilities = {}
    /** Peer permission-preset catalog; null against a peer without the service. */
    this.permissionCatalog = null
    /** Peer composer attachment limits (`ext.shadow.info.attachmentLimits`, 0.10.25). */
    this.attachmentLimits = null
    /** Peer's receive-side upload facts (`ext.shadow.info.uploads`, 0.9.0). */
    this.peerUploads = { enabled: false, maxBytes: 0, chunkBytes: LIMITS.uploadChunkBytes }
    this.storeCache = { at: 0, value: null }
    /** Cached model catalogue (`ext.shadow.models`); provider lists change rarely. */
    this.modelCache = { at: 0, value: null }
    this.mirrors = new Map()
    this.disposed = false
    this.refreshPromise = null
    this.pauseRequested = false
  }

  /** Effective peer id (explicit first, then the state file, then auto). */
  get peerDeviceId() {
    const configured = typeof this.config.peerDeviceId === 'string' ? this.config.peerDeviceId.trim() : ''
    if (configured) return configured
    return String(this.store?.snapshot().display.peerDeviceId || '')
  }

  /** Whether the display half should be active. */
  get enabled() {
    return Boolean(this.store?.displayActive)
  }

  /** Replace the sync service (e.g. when dsh-sync loads after this plugin). */
  attachSync(sync) {
    this.sync = sync || null
    return this
  }

  /** Whether the dsh-sync extension channel is available. */
  get syncAvailable() {
    return Boolean(this.sync && typeof this.sync.rpc === 'function')
  }

  /** Discover the peer to talk to. */
  resolvePeerId() {
    const configured = this.peerDeviceId
    if (configured) return configured
    const peers = this.#peers()
    const trusted = peers.filter((peer) => peer && peer.trusted && peer.online)
    if (trusted.length === 1) return String(trusted[0].deviceId)
    if (trusted.length === 0) fail(CODES.peerOffline, 'no paired and online device is available for shadow workspaces')
    fail(CODES.peerRequired, 'multiple paired devices are online; choose one in the Shadow Workspace panel')
  }

  #peers() {
    try {
      const peers = this.sync?.peers?.()
      return Array.isArray(peers) ? peers : []
    } catch {
      return []
    }
  }

  /** Known peers for the panel (never includes keys). */
  peers() {
    return this.#peers().map((peer) => ({
      deviceId: String(peer?.deviceId ?? ''),
      name: String(peer?.name ?? ''),
      online: Boolean(peer?.online),
      trusted: Boolean(peer?.trusted),
      lastSyncAt: peer?.lastSyncAt ?? null,
    }))
  }

  /**
   * One encrypted broker call with local bookkeeping.
   * @param {string} op - `ext.shadow.*` op.
   * @param {any} payload - JSON payload.
   * @param {object} [options] - call options.
   * @param {number} [options.timeoutMs] - broker timeout.
   * @returns {Promise<any>}
   */
  async call(op, payload = null, options = {}) {
    if (this.disposed) fail(CODES.disabled, 'shadow proxy is disposed')
    if (!this.syncAvailable) {
      fail(CODES.notReady, 'dsh-sync 0.5.1+ is not available; its extension channel is required')
    }
    const deviceId = this.resolvePeerId()
    const timeout = Math.max(1_000, int(options.timeoutMs, this.config.rpcTimeoutMs || 20_000))
    try {
      const result = await this.sync.rpc(deviceId, op, payload, { timeoutMs: timeout })
      this.online = true
      this.lastError = ''
      return result
    } catch (error) {
      const code = typeof error?.code === 'string' ? error.code : CODES.internal
      if (code === 'peer-offline' || code === 'peer-unreachable' || code === 'network') this.online = false
      this.lastError = errorText(error)
      if (error instanceof ShadowError) throw error
      throw new ShadowError(code, errorText(error))
    }
  }

  /** Fetch device/workspace/limit facts from the display peer. */
  async refreshInfo(force = false) {
    if (!this.enabled) return this.#offlineState('display disabled')
    if (this.refreshPromise) return this.refreshPromise
    const cached = this.storeCache.value
    if (!force && cached && this.now() - this.storeCache.at < 1500) return cached
    this.refreshPromise = (async () => {
      try {
        const info = await this.call(OPS.info, {}, { timeoutMs: 8_000 })
        if (!info || info.protocol !== PROTOCOL_VERSION) {
          fail(CODES.badRequest, `protocol mismatch: peer speaks ${String(info?.protocol)}, expected ${PROTOCOL_VERSION}`)
        }
        this.epoch = String(info.epoch ?? '')
        this.device = { deviceId: String(info.device?.deviceId ?? ''), name: String(info.device?.name ?? '') }
        this.workspaces = Array.isArray(info.workspaces) ? info.workspaces : []
        this.sharing = { enabled: Boolean(info.sharing?.enabled) }
        this.limits = info.limits || null
        this.capabilities = normalizeCapabilities(info.capabilities)
        this.permissionCatalog = normalizePermissionCatalog(info.permissions)
        this.attachmentLimits = normalizeAttachmentLimits(info.attachmentLimits)
        this.peerUploads = info.uploads && typeof info.uploads === 'object'
          ? {
            enabled: info.uploads.enabled === true,
            maxBytes: int(info.uploads.maxBytes, 0),
            chunkBytes: int(info.uploads.chunkBytes, LIMITS.uploadChunkBytes),
          }
          : { enabled: false, maxBytes: 0, chunkBytes: LIMITS.uploadChunkBytes }
        const list = await this.call(OPS.list, {}, { timeoutMs: 8_000 })
        const sessions = Array.isArray(list?.sessions) ? list.sessions : []
        const value = this.#buildState(sessions, info)
        this.storeCache = { at: this.now(), value }
        this.logger?.info?.('info/list ok', {
          peer: this.device.name || this.device.deviceId,
          sharing: this.sharing.enabled,
          workspaces: this.workspaces.length,
          sessions: sessions.length,
        })
        return value
      } catch (error) {
        this.online = false
        this.lastError = errorText(error)
        this.storeCache = { at: this.now(), value: this.#offlineState(this.lastError) }
        this.logger?.warn?.('info/list failed', { peer: this.peerDeviceId, error })
        throw error
      } finally {
        this.refreshPromise = null
      }
    })()
    return this.refreshPromise
  }

  /** Build the grouped view the sidebar renders. */
  #buildState(sessions, info) {
    const workspaces = this.workspaces.map((workspace) => ({
      workspaceId: String(workspace.workspaceId),
      title: String(workspace.title ?? workspace.workspaceId),
      sessionCount: int(workspace.sessionCount, 0),
    }))
    const byWorkspace = new Map(workspaces.map((workspace) => [workspace.workspaceId, []]))
    for (const session of sessions) {
      const workspaceId = String(session.workspaceId ?? '')
      if (!byWorkspace.has(workspaceId)) byWorkspace.set(workspaceId, [])
      byWorkspace.get(workspaceId).push({
        sessionId: String(session.sessionId),
        workspaceId,
        title: String(session.title ?? ''),
        status: session.status === 'running' ? 'running' : 'idle',
        createdAt: String(session.createdAt ?? ''),
        updatedAt: String(session.updatedAt ?? ''),
        lastText: String(session.lastText ?? ''),
        turnReason: session.turnReason ?? null,
        model: session.model && typeof session.model === 'object' ? session.model : null,
        pendingApprovals: int(session.pendingApprovals, 0),
      })
    }
    // A workspace row the peer did not advertise (e.g. its workspace registry
    // changed, or an old session outlived it) must never swallow sessions: the
    // rows are still rendered under a synthetic workspace heading. Hiding them
    // is exactly the "my old session disappeared" bug.
    const known = new Set(workspaces.map((workspace) => workspace.workspaceId))
    for (const [workspaceId, rows] of byWorkspace) {
      if (known.has(workspaceId) || rows.length === 0) continue
      workspaces.push({ workspaceId, title: workspaceId, sessionCount: rows.length, synthetic: true })
      this.logger?.warn?.('sessions belong to an unadvertised workspace; keeping them visible', {
        workspaceId,
        sessions: rows.length,
      })
    }
    for (const rows of byWorkspace.values()) {
      rows.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
    }
    return {
      ok: true,
      protocol: PROTOCOL_VERSION,
      online: true,
      syncAvailable: true,
      displayEnabled: true,
      peer: {
        deviceId: String(info?.device?.deviceId ?? ''),
        name: String(info?.device?.name ?? ''),
        version: String(info?.version ?? ''),
        epoch: this.epoch,
      },
      device: { ...this.device },
      sharing: { ...this.sharing },
      workspaces: workspaces.map((workspace) => ({
        ...workspace,
        sessions: byWorkspace.get(workspace.workspaceId) || [],
      })),
      sessions: sessions.map((session) => ({ ...session })),
      uploads: { ...this.peerUploads },
      // Composer capabilities travel with the cached state so the page can
      // render (or hide) the permission menu and the `+` attachment rail
      // without another round trip.
      capabilities: { ...this.capabilities },
      permissions: this.permissionCatalog,
      attachmentLimits: this.attachmentLimits,
      lastError: '',
      updatedAt: new Date(this.now()).toISOString(),
    }
  }

  /** State shown while the display peer is unreachable / not selected. */
  #offlineState(error = '') {
    return {
      ok: false,
      protocol: PROTOCOL_VERSION,
      online: false,
      syncAvailable: this.syncAvailable,
      displayEnabled: this.enabled,
      peer: { deviceId: this.peerDeviceId, name: '', epoch: this.epoch },
      device: { ...this.device },
      sharing: { ...this.sharing },
      workspaces: this.workspaces.map((workspace) => ({ ...workspace, sessions: [] })),
      sessions: [],
      uploads: { ...this.peerUploads },
      capabilities: { ...this.capabilities },
      permissions: this.permissionCatalog,
      attachmentLimits: this.attachmentLimits,
      lastError: error || this.lastError,
      updatedAt: new Date(this.now()).toISOString(),
    }
  }

  /** Cached grouped state for the local routes. */
  async state() {
    if (!this.enabled) return this.#offlineState('display disabled')
    try {
      return await this.refreshInfo(false)
    } catch {
      return this.storeCache.value || this.#offlineState()
    }
  }

  /** Create a session on the display peer (user picked a shared workspace). */
  async createSession(request = {}) {
    const workspaceId = String(request.workspaceId ?? '')
    const created = await this.call(OPS.create, {
      workspaceId,
      ...(typeof request.agentPreset === 'string' && request.agentPreset ? { agentPreset: request.agentPreset } : {}),
      // A preselected model from the new-session page; the sharing peer installs
      // it right after creating the Session.
      ...(request.model && typeof request.model === 'object' ? { model: request.model } : {}),
    }, { timeoutMs: 20_000 })
    const sessionId = String(created?.sessionId ?? '')
    if (!sessionId) fail(CODES.internal, 'the display peer returned no sessionId')
    await this.openSession(sessionId).catch(() => {})
    await this.refreshInfo(true).catch(() => {})
    return {
      sessionId,
      workspaceId,
      title: String(created?.title ?? workspaceId),
      ...(created?.model && typeof created.model === 'object' ? { model: created.model } : {}),
      ...(typeof created?.modelError === 'string' && created.modelError ? { modelError: created.modelError } : {}),
    }
  }

  /**
   * Admit a prompt on the display peer for one open shadow session.
   *
   * 0.10.25 adds `attachments: [{transferId}]`: transfers already staged on the
   * peer through {@link attachStep}. Text may be empty when at least one
   * attachment is present (the peer keeps the same rule).
   * @param {{sessionId: string, text?: string, requestId?: string, attachments?: Array<{transferId: string}|string>}} request - prompt input.
   * @returns {Promise<object>} peer result (`{accepted, requestId, duplicate?}`).
   */
  async prompt(request = {}) {
    const sessionId = String(request.sessionId ?? '')
    if (!sessionId) fail(CODES.badRequest, 'sessionId is required')
    const text = typeof request.text === 'string' ? request.text.trim() : ''
    const attachments = normalizePromptAttachments(request.attachments)
    if (!text && attachments.length === 0) fail(CODES.badRequest, 'prompt text must not be empty')
    const result = await this.call(OPS.prompt, {
      sessionId,
      ...(text ? { text } : {}),
      ...(typeof request.requestId === 'string' && request.requestId ? { requestId: request.requestId } : {}),
      ...(attachments.length > 0 ? { attachments } : {}),
    }, { timeoutMs: 20_000 })
    this.logger?.info?.('prompt sent', {
      sessionId,
      chars: text.length,
      attachments: attachments.length,
      requestId: String(result?.requestId || ''),
    })
    return result
  }

  /**
   * Read the peer's permission-preset catalog or switch one session's preset.
   * `op: 'catalog'` (default) also returns the session's `current` preset;
   * `op: 'set'` needs an explicit `confirmed: true` for the loosening presets,
   * which the peer enforces again.
   * @param {{sessionId: string, op?: 'catalog'|'set', preset?: string, confirmed?: boolean}} request - preset request.
   * @returns {Promise<object>} `{options, defaultPreset, current}` or `{current, preset}`.
   */
  async permissions(request = {}) {
    const sessionId = String(request.sessionId ?? '')
    if (!sessionId) fail(CODES.badRequest, 'sessionId is required')
    const op = request.op === 'set' ? 'set' : 'catalog'
    const payload = { sessionId, op }
    if (op === 'set') {
      const preset = String(request.preset ?? '')
      if (!preset) fail(CODES.badRequest, 'preset is required')
      payload.preset = preset
      if (request.confirmed === true) payload.confirmed = true
    }
    const result = await this.call(OPS.permissions, payload, { timeoutMs: 15_000 })
    if (op === 'set') {
      this.logger?.info?.('permission preset sent', { sessionId, preset: payload.preset })
    } else {
      this.logger?.debug?.('permission catalog fetched', {
        sessionId,
        options: Array.isArray(result?.options) ? result.options.length : 0,
        current: String(result?.current || ''),
      })
    }
    return result && typeof result === 'object' ? result : {}
  }

  /**
   * Forward one attachment staging step (`begin` / `chunk` / `commit` /
   * `abort`) to the peer over `ext.shadow.attach`. A chunk is at most 512 KiB
   * raw (≈700 KB as base64), so the 20 s call budget is generous.
   * @param {{action: string, sessionId: string, transferId?: string, kind?: 'image'|'file', name?: string, size?: number, mediaType?: string, index?: number, data?: string}} step - staging step.
   * @returns {Promise<object>} peer step result.
   */
  async attachStep(step = {}) {
    const action = String(step.action ?? '')
    if (action !== 'begin' && action !== 'chunk' && action !== 'commit' && action !== 'abort') {
      fail(CODES.badRequest, `unknown attach action: ${action || '(missing)'}`)
    }
    const sessionId = String(step.sessionId ?? '')
    if (!sessionId) fail(CODES.badRequest, 'sessionId is required')
    const payload = { action, sessionId }
    if (step.transferId !== undefined) payload.transferId = String(step.transferId)
    if (action === 'begin') {
      payload.kind = String(step.kind ?? '')
      payload.name = String(step.name ?? '')
      payload.size = Number(step.size)
      if (step.mediaType !== undefined) payload.mediaType = String(step.mediaType)
    } else if (action === 'chunk') {
      payload.index = Number(step.index)
      payload.data = String(step.data ?? '')
    }
    const result = await this.call(OPS.attach, payload, { timeoutMs: 20_000 })
    if (action === 'chunk') {
      this.logger?.debug?.('attachment chunk sent', {
        sessionId,
        transferId: payload.transferId,
        index: payload.index,
        received: Number(result?.received) || 0,
      })
    } else {
      this.logger?.info?.(`attachment ${action} sent`, {
        sessionId,
        transferId: payload.transferId,
        ...(action === 'begin' ? { kind: payload.kind, size: payload.size } : {}),
      })
    }
    return result && typeof result === 'object' ? result : {}
  }

  /** Stop the running turn on the display peer. */
  async cancel(request = {}) {
    const sessionId = String(request.sessionId ?? '')
    if (!sessionId) fail(CODES.badRequest, 'sessionId is required')
    const result = await this.call(OPS.cancel, { sessionId }, { timeoutMs: 10_000 })
    this.logger?.info?.('cancel sent', { sessionId })
    return result
  }

  /** Send the display user's explicit approval decision. */
  async answer(request = {}) {
    const sessionId = String(request.sessionId ?? '')
    const approvalId = String(request.approvalId ?? '')
    if (!sessionId || !approvalId) fail(CODES.badRequest, 'sessionId and approvalId are required')
    const outcome = String(request.outcome ?? '')
    if (outcome !== 'allowed-once' && outcome !== 'rejected') fail(CODES.badRequest, 'outcome must be "allowed-once" or "rejected"')
    const result = await this.call(OPS.answer, { sessionId, approvalId, outcome }, { timeoutMs: 10_000 })
    this.logger?.info?.('approval answer sent', { sessionId, approvalId, outcome })
    return result
  }

  /**
   * Model catalogue of the display peer (`{default, groups, failures}`).
   * Cached briefly: provider/model lists rarely change while a chat is open.
   * @param {boolean} [force] - bypass the cache.
   * @returns {Promise<object>}
   */
  async models(force = false) {
    const cached = this.modelCache
    if (!force && cached.value && this.now() - cached.at < 60_000) return cached.value
    const raw = await this.call(OPS.models, {}, { timeoutMs: 15_000 })
    const value = {
      default: raw?.default && typeof raw.default === 'object' ? raw.default : null,
      groups: Array.isArray(raw?.groups) ? raw.groups : [],
      failures: Array.isArray(raw?.failures) ? raw.failures : [],
    }
    this.modelCache = { at: this.now(), value }
    this.logger?.info?.('model catalogue fetched', {
      peer: this.device.name || this.device.deviceId,
      groups: value.groups.length,
      models: value.groups.reduce((total, group) => total + (Array.isArray(group.models) ? group.models.length : 0), 0),
      failures: value.failures.length,
    })
    return value
  }

  /**
   * Select the model for one open shadow session.
   * @param {{sessionId: string, provider: string, model: string, reasoningEffort?: string}} request - selection.
   * @returns {Promise<{selected: {provider: string, model: string, reasoningEffort?: string}}>}
   */
  async selectModel(request = {}) {
    const sessionId = String(request.sessionId ?? '')
    const provider = String(request.provider ?? '').trim()
    const model = String(request.model ?? '').trim()
    if (!sessionId) fail(CODES.badRequest, 'sessionId is required')
    if (!provider) fail(CODES.badRequest, 'provider is required')
    if (!model) fail(CODES.badRequest, 'model is required')
    const reasoningEffort = typeof request.reasoningEffort === 'string' ? request.reasoningEffort.trim() : ''
    const result = await this.call(OPS.selectModel, {
      sessionId,
      provider,
      model,
      ...(reasoningEffort ? { reasoningEffort } : {}),
    }, { timeoutMs: 20_000 })
    const selected = result?.selected && typeof result.selected === 'object'
      ? result.selected
      : { provider, model, ...(reasoningEffort ? { reasoningEffort } : {}) }
    const mirror = this.mirrors.get(sessionId)
    if (mirror) mirror.model = selected
    this.#patchCachedSession(sessionId, { model: selected })
    this.logger?.info?.('model selection sent', { sessionId, provider: selected.provider, model: selected.model })
    return { selected }
  }

  /** Patch one session row in the cached grouped state (best effort). */
  #patchCachedSession(sessionId, patch) {
    const cached = this.storeCache.value
    if (!cached || !patch) return
    const apply = (row) => {
      if (row && row.sessionId === sessionId) Object.assign(row, patch)
    }
    for (const workspace of Array.isArray(cached.workspaces) ? cached.workspaces : []) {
      for (const row of Array.isArray(workspace.sessions) ? workspace.sessions : []) apply(row)
    }
    for (const row of Array.isArray(cached.sessions) ? cached.sessions : []) apply(row)
  }

  /** Pending approvals known to the local mirror. */
  approvals() {
    const out = []
    for (const mirror of this.mirrors.values()) {
      for (const approval of mirror.approvals || []) out.push(approval)
    }
    return out
  }

  /** Pending interactive questions known to the local mirror. */
  questions() {
    const out = []
    for (const mirror of this.mirrors.values()) {
      for (const question of mirror.questions || []) out.push(question)
    }
    return out
  }

  /**
   * Submit an answer batch (or request changes) for one pending question.
   * @param {{sessionId: string, questionId: string, answers?: object[], cancel?: boolean, reason?: string}} request - answer input.
   * @returns {Promise<{accepted: true, answers?: object[], cancelled?: true}>}
   */
  async answerQuestion(request = {}) {
    const sessionId = String(request.sessionId ?? '')
    const questionId = String(request.questionId ?? '')
    if (!sessionId) fail(CODES.badRequest, 'sessionId is required')
    if (!questionId) fail(CODES.badRequest, 'questionId is required')
    const payload = { sessionId, questionId }
    if (request.cancel === true) {
      payload.cancel = true
      const reason = typeof request.reason === 'string' ? request.reason.trim() : ''
      if (reason) payload.reason = reason.slice(0, 200)
    } else {
      if (!Array.isArray(request.answers)) fail(CODES.badRequest, 'answers must be an array')
      payload.answers = request.answers
    }
    const result = await this.call(OPS.answerQuestion, payload, { timeoutMs: 15_000 })
    const mirror = this.mirrors.get(sessionId)
    if (mirror) {
      mirror.questions = (mirror.questions || []).filter((row) => row.questionId !== questionId)
    }
    this.logger?.info?.('question answer sent', {
      sessionId,
      questionId,
      cancelled: result?.cancelled === true,
      answers: Array.isArray(result?.answers) ? result.answers.length : 0,
    })
    return result && typeof result === 'object' ? result : { accepted: true }
  }

  /**
   * Turn this machine's receive-side file uploads on/off (local data route
   * `uploads-enable`). This is the A half's switch, not a remote call: it only
   * changes what this device accepts from paired peers.
   * @param {boolean} enabled - new switch value.
   * @returns {object} persisted state snapshot.
   */
  setUploadsEnabled(enabled) {
    const snapshot = this.store?.setUploads(enabled === true)
    this.logger?.info?.('uploads receive switch changed', { enabled: enabled === true })
    return snapshot
  }

  /**
   * Upload facts for the local panel / data route: this device's receive
   * switch plus the selected peer's readiness (so the panel can hide the push
   * control until the peer accepts files).
   * @returns {object} upload state view.
   */
  uploadsState() {
    const snapshot = this.store?.snapshot() || {}
    const local = snapshot.uploads || {}
    const configEnabled = this.config?.uploads?.enabled === true
    return {
      enabled: local.enabled === true || configEnabled,
      configEnabled,
      grantedPeers: Array.isArray(local.peers) ? local.peers.length : 0,
      maxBytes: int(this.config?.uploads?.maxBytes, LIMITS.maxUploadBytes) || LIMITS.maxUploadBytes,
      chunkBytes: int(this.config?.uploads?.chunkBytes, LIMITS.uploadChunkBytes) || LIMITS.uploadChunkBytes,
      dir: typeof this.config?.uploadsDir === 'string' ? this.config.uploadsDir : '',
      peer: {
        enabled: this.peerUploads.enabled === true,
        maxBytes: int(this.peerUploads.maxBytes, 0),
        chunkBytes: int(this.peerUploads.chunkBytes, LIMITS.uploadChunkBytes) || LIMITS.uploadChunkBytes,
      },
    }
  }

  /**
   * Forward one `push-file` step (begin/chunk/commit/abort) to the selected
   * peer over `ext.shadow.push-file`. File bytes travel as base64 chunks; the
   * peer verifies size + sha256 on commit.
   * @param {{action: string, transferId: string, name?: string, size?: number, sha256?: string, index?: number, data?: string}} step - transfer step.
   * @returns {Promise<object>} peer result (`commit` reports `{name, size, sha256}`).
   */
  async pushFileStep(step = {}) {
    if (!this.enabled) fail(CODES.disabled, 'the display half is disabled')
    const action = String(step.action ?? '')
    const transferId = String(step.transferId ?? '')
    if (!action) fail(CODES.badRequest, 'push-file action is required')
    if (!transferId) fail(CODES.badRequest, 'transferId is required')
    const payload = { action, transferId }
    if (action === 'begin') {
      payload.name = String(step.name ?? '')
      payload.size = Number(step.size)
      payload.sha256 = String(step.sha256 ?? '')
    } else if (action === 'chunk') {
      payload.index = Number(step.index)
      payload.data = String(step.data ?? '')
    } else if (action === 'commit') {
      payload.sha256 = String(step.sha256 ?? '')
    } else if (action !== 'abort') {
      fail(CODES.badRequest, `unknown push-file action: ${action}`)
    }
    const result = await this.call(OPS.pushFile, payload, { timeoutMs: 45_000 })
    if (action === 'begin') {
      this.logger?.info?.('file push begin', {
        transferId,
        name: payload.name,
        size: payload.size,
        peer: this.peerDeviceId,
        chunkBytes: result?.chunkBytes,
      })
    } else if (action === 'chunk') {
      this.logger?.debug?.('file push chunk', {
        transferId,
        index: payload.index,
        receivedBytes: result?.receivedBytes,
      })
    } else if (action === 'commit') {
      this.logger?.info?.('file push commit', {
        transferId,
        name: result?.name,
        size: result?.size,
        sha256: result?.sha256,
      })
    } else {
      this.logger?.info?.('file push abort', { transferId })
    }
    return result && typeof result === 'object' ? result : { ok: true }
  }

  /** Polling/limit statistics for the panel and tests. */
  stats() {
    const mirrors = [...this.mirrors.values()]
    return {
      mirrors: mirrors.length,
      polling: mirrors.filter((mirror) => mirror.polling).length,
      maxOpenSessions: Number(this.config.maxOpenSessions) || LIMITS.maxEventOpenSessions,
    }
  }

  /** Whether polling is currently paused (page hidden / panel closed). */
  setPaused(paused) {
    this.pauseRequested = paused === true
    this.logger?.debug?.('polling pause changed', { paused: this.pauseRequested })
    if (this.pauseRequested) {
      for (const mirror of this.mirrors.values()) mirror.log.interrupt()
    }
  }

  /** Called by index.js after the display state changed (peer switched/off). */
  syncFromState() {
    if (this.disposed) return
    if (!this.enabled) {
      this.logger?.info?.('display disabled; closing mirrors', { mirrors: this.mirrors.size })
      for (const mirror of this.mirrors.values()) this.closeSession(mirror.sessionId)
      this.storeCache = { at: 0, value: null }
      return
    }
    this.logger?.info?.('display state changed; refreshing peer info', { peer: this.peerDeviceId })
    this.storeCache = { at: 0, value: null }
    void this.refreshInfo(true).catch(() => {})
  }

  // ---------------------------------------------------------------------
  // Mirror + polling
  // ---------------------------------------------------------------------

  /** Enforce the open-poll cap by closing the least-recently-used mirror poll. */
  #enforceOpenLimit() {
    const limit = Math.max(1, Number(this.config.maxOpenSessions) || LIMITS.maxEventOpenSessions)
    const polling = [...this.mirrors.values()].filter((mirror) => mirror.polling && !mirror.closed)
    if (polling.length < limit) return
    polling.sort((a, b) => Number(a.lastUsedAt || 0) - Number(b.lastUsedAt || 0))
    const evicted = polling[0]
    if (evicted) {
      evicted.evicted = true
      this.closeSession(evicted.sessionId)
      this.logger?.warn?.('open-poll limit reached; paused least recently used session', {
        limit,
        evictedSessionId: evicted.sessionId,
      })
    }
  }

  /**
   * Start (idempotently) mirroring one session.
   * @param {string} sessionId - shadow session id.
   * @returns {Promise<{sessionId: string, epoch: string}>}
   */
  async openSession(sessionId) {
    const id = String(sessionId ?? '')
    if (!id) fail(CODES.badRequest, 'sessionId is required')
    let mirror = this.mirrors.get(id)
    if (!mirror) {
      this.#enforceOpenLimit()
      mirror = {
        sessionId: id,
        log: new EventLog({ onColdRead: null }),
        epoch: '',
        polling: false,
        closed: false,
        evicted: false,
        lost: '',
        error: '',
        status: 'idle',
        title: '',
        workspaceId: '',
        lastText: '',
        turnReason: null,
        model: null,
        version: '',
        approvals: [],
        questions: [],
        lastUsedAt: this.now(),
      }
      this.mirrors.set(id, mirror)
    }
    mirror.closed = false
    mirror.evicted = false
    mirror.lastUsedAt = this.now()
    this.logger?.info?.('session mirror open', { sessionId: id, mirrors: this.mirrors.size })
    if (!mirror.polling) void this.#pollLoop(mirror)
    return { sessionId: id, epoch: mirror.epoch }
  }

  /**
   * Stop polling one session. Sends a final `closing` events call so the
   * sharing machine releases its in-flight long poll instead of waiting for
   * the whole window.
   */
  closeSession(sessionId) {
    const mirror = this.mirrors.get(String(sessionId ?? ''))
    if (!mirror) return { closed: false }
    mirror.closed = true
    mirror.log.interrupt()
    this.logger?.info?.('session mirror close (closing handshake)', { sessionId: mirror.sessionId, polls: this.stats().polling })
    // Best effort: no await, a missed call only costs one A-side wait window.
    void this.call(OPS.events, {
      sessionId: mirror.sessionId,
      sinceSeq: mirror.log.lastSeq,
      sinceRev: mirror.log.lastRev,
      epoch: mirror.epoch,
      waitMs: 0,
      closing: true,
    }, { timeoutMs: 5_000 }).catch(() => {})
    return { closed: true }
  }

  /** One long-poll iteration chain for a mirror. */
  async #pollLoop(mirror) {
    if (mirror.polling) return
    mirror.polling = true
    let backoff = 500
    while (!this.disposed && !mirror.closed) {
      if (this.pauseRequested) {
        await delay(400)
        continue
      }
      try {
        const waitMs = Math.max(1_000, int(this.config.eventsWaitMs, LIMITS.defaultWaitMs))
        mirror.lastUsedAt = this.now()
        this.logger?.debug?.('long poll start', { sessionId: mirror.sessionId, sinceSeq: mirror.log.lastSeq, waitMs })
        const started = this.now()
        const batch = await this.call(OPS.events, {
          sessionId: mirror.sessionId,
          sinceSeq: mirror.log.lastSeq,
          sinceRev: mirror.log.lastRev,
          epoch: mirror.epoch,
          waitMs,
        }, { timeoutMs: waitMs + LIMITS.rpcTimeoutMarginMs })
        this.#applyBatch(mirror, batch)
        this.logger?.debug?.('long poll end', {
          sessionId: mirror.sessionId,
          frames: (batch?.events?.length || 0) + (batch?.transient?.length || 0),
          reset: batch?.reset === true,
          ms: this.now() - started,
        })
        backoff = 500
        mirror.error = ''
      } catch (error) {
        mirror.error = errorText(error)
        if (error instanceof ShadowError && (
          error.code === CODES.notManaged
          || error.code === CODES.notFound
          || error.code === CODES.notShared
          || error.code === CODES.sharingOff
        )) {
          mirror.lost = error.code
          this.logger?.warn?.('session mirror lost', { sessionId: mirror.sessionId, code: error.code })
          break
        }
        this.logger?.warn?.('long poll failed; retrying with backoff', {
          sessionId: mirror.sessionId,
          code: String(error?.code || ''),
          backoff,
          error,
        })
        await delay(backoff)
        backoff = Math.min(10_000, Math.round(backoff * 1.7))
      }
    }
    mirror.polling = false
    this.logger?.debug?.('poll loop ended', { sessionId: mirror.sessionId, closed: mirror.closed, lost: mirror.lost || '' })
  }

  /** Merge one `events` response into the local mirror. */
  #applyBatch(mirror, batch) {
    if (!batch || typeof batch !== 'object') return
    if (batch.reset) {
      mirror.log.reset()
      mirror.epoch = String(batch.epoch ?? '')
      mirror.approvals = []
      mirror.questions = []
    }
    if (!mirror.epoch && typeof batch.epoch === 'string') mirror.epoch = batch.epoch
    for (const frame of Array.isArray(batch.events) ? batch.events : []) mirror.log.appendEvent(frame)
    for (const frame of Array.isArray(batch.transient) ? batch.transient : []) {
      if (Number.isFinite(Number(frame?.rev))) mirror.log.appendTransient(frame, true)
    }
    if (typeof batch.status === 'string') mirror.status = batch.status
    if (typeof batch.title === 'string') mirror.title = batch.title
    if (typeof batch.workspaceId === 'string') mirror.workspaceId = batch.workspaceId
    if (typeof batch.lastText === 'string') mirror.lastText = batch.lastText
    if (batch.turnReason !== undefined) mirror.turnReason = batch.turnReason
    if (batch.model && typeof batch.model === 'object') mirror.model = batch.model
    if (typeof batch.version === 'string') mirror.version = batch.version
    if (Array.isArray(batch.approvals)) mirror.approvals = batch.approvals
    if (Array.isArray(batch.questions)) mirror.questions = batch.questions
    mirror.log.notify()
  }

  /**
   * Long-poll this machine's own Web client against the local mirror.
   * @param {object} request - `{sessionId, sinceSeq, sinceRev, epoch, waitMs, signal}`.
   * @returns {Promise<object>} batch for the renderer.
   */
  async localEvents(request = {}) {
    const id = String(request.sessionId ?? '')
    const mirror = this.mirrors.get(id)
    if (!mirror) fail(CODES.notFound, `shadow session "${id}" is not open on this device`)
    mirror.lastUsedAt = this.now()
    const callerEpoch = typeof request.epoch === 'string' ? request.epoch : ''
    if (callerEpoch && mirror.epoch && callerEpoch !== mirror.epoch) {
      return this.#localEnvelope(mirror, {
        reset: true,
        events: [],
        transient: [],
        cursor: { seq: -1, rev: 0 },
        more: false,
        pendingEvents: 0,
        pendingTransient: 0,
      })
    }
    const waitMs = Math.max(0, Math.min(LIMITS.maxWaitMs, int(request.waitMs, 0)))
    const started = this.now()
    this.logger?.debug?.('local long poll start', { sessionId: id, sinceSeq: int(request.sinceSeq, -1), waitMs })
    const page = await mirror.log.read({
      sinceSeq: int(request.sinceSeq, -1),
      sinceRev: int(request.sinceRev, 0),
      waitMs,
      maxFrames: LIMITS.maxEventFrames,
      maxTransient: LIMITS.maxTransientFrames,
      maxBytes: LIMITS.maxBatchBytes,
      signal: request.signal,
    })
    this.logger?.debug?.('local long poll end', {
      sessionId: id,
      frames: page.events.length + page.transient.length,
      aborted: Boolean(request.signal?.aborted),
      ms: this.now() - started,
    })
    return this.#localEnvelope(mirror, { ...page, reset: false })
  }

  #localEnvelope(mirror, page) {
    return {
      sessionId: mirror.sessionId,
      epoch: mirror.epoch,
      ...page,
      status: mirror.status,
      title: mirror.title,
      workspaceId: mirror.workspaceId,
      lastText: mirror.lastText,
      turnReason: mirror.turnReason,
      model: mirror.model || null,
      version: mirror.version || '',
      approvals: mirror.approvals || [],
      questions: mirror.questions || [],
      // 0.10.25: the chat page learns composer capabilities on its first poll
      // instead of another `state` round trip. Additive for old clients.
      capabilities: this.capabilities || null,
      attachmentLimits: this.attachmentLimits || null,
      online: this.online,
      error: mirror.error || '',
      lost: mirror.lost || '',
      evicted: mirror.evicted === true,
    }
  }

  /** Stop every poll loop and drop mirrors. */
  dispose() {
    if (this.disposed) return
    this.disposed = true
    for (const mirror of this.mirrors.values()) {
      mirror.closed = true
      mirror.log.notify()
      mirror.log.dispose()
    }
    this.mirrors.clear()
  }
}

/**
 * Normalize `ext.shadow.info.capabilities` (0.10.25). A 0.10.24 peer sends
 * nothing; `{}` keeps the old "unknown → control hidden" behaviour.
 * @param {any} raw - peer capabilities.
 * @returns {{permissions: boolean, attachments: boolean}|object} capability view.
 */
function normalizeCapabilities(raw) {
  if (!raw || typeof raw !== 'object') return {}
  return {
    permissions: raw.permissions === true,
    attachments: raw.attachments === true,
  }
}

/**
 * Normalize the peer's permission-preset catalog (`info.permissions`). Returns
 * null when the peer has no permission service (or sends a malformed catalog).
 * @param {any} raw - peer catalog.
 * @returns {{options: object[], defaultOptions: object[], defaultPreset: string}|null}
 */
function normalizePermissionCatalog(raw) {
  if (!raw || typeof raw !== 'object') return null
  const options = normalizePresetOptions(raw.options)
  if (options.length === 0) return null
  return {
    options,
    defaultOptions: normalizePresetOptions(raw.defaultOptions),
    defaultPreset: typeof raw.defaultPreset === 'string' ? raw.defaultPreset : '',
  }
}

/** Keep the serializable fields of one preset option list. */
function normalizePresetOptions(value) {
  return (Array.isArray(value) ? value : [])
    .map((option) => {
      const optionValue = typeof option?.value === 'string' ? option.value : ''
      if (!optionValue) return null
      return {
        value: optionValue,
        name: String(option?.name ?? optionValue),
        ...(typeof option?.description === 'string' ? { description: option.description } : {}),
      }
    })
    .filter(Boolean)
}

/**
 * Normalize `ext.shadow.info.attachmentLimits`. Null means "the peer did not
 * advertise attachments"; the client then hides the `+` rail.
 * @param {any} raw - peer limits.
 * @returns {object|null} limit view.
 */
function normalizeAttachmentLimits(raw) {
  if (!raw || typeof raw !== 'object') return null
  const imageLimits = raw.imageLimits && typeof raw.imageLimits === 'object' ? raw.imageLimits : null
  return {
    chunkBytes: Math.max(1, int(raw.chunkBytes, LIMITS.attachChunkBytes)),
    maxBytes: Math.max(1, int(raw.maxBytes, LIMITS.maxAttachBytes)),
    maxAttachments: Math.max(1, int(raw.maxAttachments, LIMITS.maxPromptAttachments)),
    maxImageBytes: Math.max(1, int(raw.maxImageBytes, LIMITS.maxPromptImageBytes)),
    ...(imageLimits ? { imageLimits } : {}),
  }
}

/**
 * Normalize the `attachments` field of one local prompt request into the wire
 * shape `[{transferId}]`.
 * @param {any} value - untrusted attachments list.
 * @returns {Array<{transferId: string}>} references in caller order.
 */
function normalizePromptAttachments(value) {
  if (!Array.isArray(value)) return []
  const out = []
  for (const entry of value) {
    const raw = typeof entry === 'string'
      ? entry
      : entry && typeof entry === 'object' ? String(entry.transferId ?? '') : ''
    const transferId = raw.trim()
    if (!transferId) continue
    out.push({ transferId: transferId.slice(0, 200) })
    if (out.length >= LIMITS.maxPromptAttachments) break
  }
  return out
}
