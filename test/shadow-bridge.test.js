// Shadow-workspace Host bridge: session list integrity, model catalogue and
// per-session model selection (0.7.0), permission presets, chunked composer
// attachments and the B-local speech bridge (0.10.25).
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ShadowHostBridge,
  assertModelSelection,
  normalizeAttachmentRefs,
  slimModelCatalog,
} from '../shadow/src/session-bridge.js'
import { ShadowClientProxy } from '../shadow/src/b-proxy.js'
import { ShadowStateStore } from '../shadow/src/state.js'
import { CODES, LIMITS, OPS } from '../shadow/src/constants.js'
import { createSpeechBridge } from '../shadow/src/speech.js'
import { DATA_ACTIONS, createDataHandler, runDataAction } from '../shadow/src/local-route.js'

const WORKSPACE = 'workspace-1'
const PEER = { deviceId: 'peer-device-1', name: 'PC-B' }
const OTHER_PEER = { deviceId: 'other-device', name: 'PC-C' }
const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex')

function makeController() {
  const calls = { create: [], selectModel: [], prompt: [], cancel: [], inspect: [] }
  return {
    calls,
    async modelCatalog() {
      return {
        default: { provider: 'deepseek', model: 'deepseek-chat' },
        routableProviders: ['deepseek'],
        groups: [{
          id: 'deepseek',
          name: 'DeepSeek',
          models: [
            { id: 'deepseek-chat', name: 'DeepSeek Chat' },
            {
              id: 'deepseek-reasoner',
              name: 'DeepSeek Reasoner',
              reasoning: { defaultEffort: 'medium', efforts: [{ id: 'low', name: 'Low' }, { id: 'medium', name: 'Medium' }] },
            },
          ],
        }],
        failures: [{ id: 'broken-provider', name: 'Broken', message: 'no api key' }],
      }
    },
    async create(args) {
      calls.create.push(args)
      return { sessionId: 'session-created-1' }
    },
    async selectModel(args) {
      calls.selectModel.push(args)
      return {
        selected: {
          provider: args.provider,
          model: args.model,
          ...(args.reasoningEffort === undefined ? {} : { reasoningEffort: args.reasoningEffort }),
        },
      }
    },
    async prompt(args) { calls.prompt.push(args) },
    async cancel(args) { calls.cancel.push(args) },
    async inspect(sessionId) { calls.inspect.push(sessionId); return { events: [] } },
  }
}

async function makeHome(label) {
  const home = await mkdtemp(join(tmpdir(), `dsh-shadow-${label}-`))
  for (const dir of ['sessions', 'storages', 'profiles/desktop', 'attachments', 'cache']) {
    await mkdir(join(home, dir), { recursive: true })
  }
  return home
}

/** Fake Host `permissionPresets` service recording every call (0.10.25). */
function makePermissionPresets() {
  const calls = { catalog: 0, current: [], set: [] }
  const state = { preset: 'workspace-write' }
  const option = (value, name, description) => ({ value, name, ...(description ? { description } : {}) })
  return {
    calls,
    names: ['read-only', 'workspace-write', 'danger-full-access'],
    catalog() {
      calls.catalog += 1
      return {
        options: [
          option('read-only', 'Read-only', 'no writes'),
          option('workspace-write', 'Workspace write'),
          option('danger-full-access', 'Full access', 'no sandbox'),
        ],
        defaultOptions: [option('read-only', 'Read-only'), option('workspace-write', 'Workspace write')],
        defaultPreset: 'workspace-write',
      }
    },
    current(session) {
      calls.current.push(session)
      return state.preset
    },
    set(session, name) {
      calls.set.push({ session, name })
      state.preset = name
    },
  }
}

/** Fake `fileUploads` Host service: mints deterministic receipts. */
function makeFileUploads() {
  const calls = []
  return {
    calls,
    async upload(agent, payload) {
      calls.push({ agent, ...payload })
      return { receiptId: `receipt-${calls.length}`, file: { attachmentId: `attachment-${calls.length}` } }
    },
  }
}

async function makeBridge(home, config = {}, overrides = {}) {
  const controller = makeController()
  const workspaceRegistry = {
    list: () => [{ id: WORKSPACE, title: '工作区', sessionIds: [] }],
  }
  /** Fake Host services; tests may delete one entry to simulate a Host gap. */
  const services = {
    sessionController: controller,
    workspaceRegistry,
    permissionPresets: makePermissionPresets(),
    fileUploads: makeFileUploads(),
    attachments: {
      imageLimits: {
        maxImageBytes: 20 * 1024 * 1024,
        maxImagesPerMessage: 5,
        maxMessageImageBytes: 40 * 1024 * 1024,
        mediaTypes: ['image/png', 'image/jpeg'],
      },
    },
    agents: {
      get: (sessionId) => ({ session: { id: sessionId }, status: 'idle' }),
    },
    sessions: {
      get: (sessionId) => ({ id: sessionId }),
      list: () => [],
    },
  }
  /** Host event handlers registered through the fake context. */
  const hostHandlers = new Map()
  const ctx = {
    get(name) {
      return services[name]
    },
    on(name, handler) {
      hostHandlers.set(name, handler)
      return () => hostHandlers.delete(name)
    },
  }
  const state = new ShadowStateStore({ dir: join(home, 'shadow-workspace') })
  state.setSharing(true)
  state.setWorkspaces([WORKSPACE])
  const sync = {
    identity: () => ({ deviceId: 'device-a', name: 'PC-A' }),
    peers: () => [{ ...PEER, online: true, trusted: true }],
  }
  const bridge = new ShadowHostBridge({
    ctx,
    state,
    store: join(home, 'shadow-workspace', 'sessions.json'),
    config,
    ...(typeof overrides.now === 'function' ? { now: overrides.now } : {}),
  })
  bridge.attachSync(sync)
  bridge.start()
  return { bridge, controller, sync, state, hostHandlers, services }
}

/** A display-side proxy wired to the bridge through a fake dshSync broker. */
async function makeProxy(home, bridge) {
  const state = new ShadowStateStore({ dir: join(home, 'shadow-display') })
  state.setDisplay(true)
  state.setPeer(PEER.deviceId, PEER.name)
  const sync = {
    peers: () => [{ ...PEER, online: true, trusted: true }],
    rpc: async (_deviceId, op, payload) => bridge.handleRpc(op, payload, PEER),
  }
  const proxy = new ShadowClientProxy({ sync, state, config: {} })
  return { proxy, state }
}

test('shadow sessions: listSessions keeps every registry row and adopts legacy owners', async () => {
  const home = await makeHome('sessions')
  const { bridge } = await makeBridge(home)
  try {
    bridge.registry.add({ sessionId: 'session-old', workspaceId: WORKSPACE, title: '工作区', creatorPeerId: 'peer-device-1' })
    bridge.registry.add({ sessionId: 'session-new', workspaceId: WORKSPACE, title: '工作区', creatorPeerId: 'peer-device-1' })
    // Regression: rows written before ownership existed have no creatorPeerId
    // and used to be filtered out of the display machine's list.
    bridge.registry.update('session-old', { creatorPeerId: '' })

    const rows = bridge.listSessions(PEER)
    assert.equal(rows.length, 2, 'both sessions must be listed')
    assert.deepEqual(rows.map((row) => row.sessionId).sort(), ['session-new', 'session-old'])

    await bridge.prompt({ sessionId: 'session-old', text: 'hello from B', peer: PEER })
    assert.equal(bridge.registry.get('session-old').creatorPeerId, PEER.deviceId, 'first write adopts the legacy row')

    // A session owned by another display device stays hidden.
    bridge.registry.add({ sessionId: 'session-other', workspaceId: WORKSPACE, title: '工作区', creatorPeerId: 'other-device' })
    assert.deepEqual(bridge.listSessions(PEER).map((row) => row.sessionId).sort(), ['session-new', 'session-old'])
  } finally {
    bridge.dispose()
    await rm(home, { recursive: true, force: true }).catch(() => {})
  }
})

test('shadow proxy: grouped state keeps sessions from unadvertised workspaces', async () => {
  const home = await makeHome('grouping')
  const state = new ShadowStateStore({ dir: join(home, 'shadow-display') })
  state.setDisplay(true)
  state.setPeer(PEER.deviceId, PEER.name)
  // A peer whose workspace list omits one workspace the session list still
  // returns (transient registry/info divergence): those sessions must not vanish.
  const sync = {
    peers: () => [{ ...PEER, online: true, trusted: true }],
    rpc: async (_deviceId, op) => {
      if (op === 'ext.shadow.info') {
        return {
          protocol: 1,
          epoch: 'epoch-1',
          device: { deviceId: PEER.deviceId, name: PEER.name },
          sharing: { enabled: true },
          workspaces: [{ workspaceId: WORKSPACE, title: '工作区', sessionCount: 2 }],
        }
      }
      if (op === 'ext.shadow.list') {
        return {
          sharing: { enabled: true },
          sessions: [
            { sessionId: 'session-a', workspaceId: WORKSPACE, title: 'A', status: 'idle', updatedAt: '2026-01-01T00:00:02Z' },
            { sessionId: 'session-b', workspaceId: WORKSPACE, title: 'B', status: 'idle', updatedAt: '2026-01-01T00:00:01Z' },
            { sessionId: 'session-orphan', workspaceId: 'workspace-gone', title: 'Orphan', status: 'idle', updatedAt: '2026-01-01T00:00:03Z' },
          ],
        }
      }
      throw new Error(`unexpected op ${op}`)
    },
  }
  const proxy = new ShadowClientProxy({ sync, state, config: {} })
  try {
    const view = await proxy.state()
    const workspace = view.workspaces.find((row) => row.workspaceId === WORKSPACE)
    assert.ok(workspace, 'shared workspace row')
    assert.equal(workspace.sessions.length, 2, 'both sessions of the shared workspace are listed')
    const orphan = view.workspaces.find((row) => row.workspaceId === 'workspace-gone')
    assert.ok(orphan, 'unadvertised workspace is synthesised instead of dropping sessions')
    assert.deepEqual(orphan.sessions.map((row) => row.sessionId), ['session-orphan'])
    assert.equal(view.sessions.length, 3)
  } finally {
    proxy.dispose()
    await rm(home, { recursive: true, force: true }).catch(() => {})
  }
})

test('shadow models: slimming keeps groups/default/failures only', () => {
  const slim = slimModelCatalog({
    default: { provider: 'deepseek', model: 'deepseek-chat' },
    routableProviders: ['deepseek'],
    groups: [{
      id: 'deepseek',
      name: 'DeepSeek',
      models: [
        { id: 'deepseek-chat', name: 'DeepSeek Chat', description: 'x' },
        { id: 'deepseek-reasoner', name: 'Reasoner', reasoning: { defaultEffort: 'medium', efforts: [{ id: 'low', name: 'Low' }] } },
      ],
    }],
    failures: [{ id: 'p2', name: 'P2', message: 'boom' }],
  })
  assert.deepEqual(slim.default, { provider: 'deepseek', model: 'deepseek-chat' })
  assert.equal(slim.groups.length, 1)
  assert.equal(slim.groups[0].id, 'deepseek')
  assert.equal(slim.groups[0].label, 'DeepSeek')
  assert.equal(slim.groups[0].name, 'DeepSeek')
  assert.deepEqual(slim.groups[0].models.map((model) => model.id), ['deepseek-chat', 'deepseek-reasoner'])
  assert.equal(slim.groups[0].models[1].reasoning.defaultEffort, 'medium')
  assert.deepEqual(slim.failures, [{ id: 'p2', name: 'P2', message: 'boom' }])
  assert.deepEqual(assertModelSelection({ provider: ' p ', model: ' m ', reasoningEffort: ' low ' }), {
    provider: 'p', model: 'm', reasoningEffort: 'low',
  })
  assert.throws(() => assertModelSelection({ provider: 'p' }), (error) => error.code === 'shadow/bad-request')
})

test('shadow models: catalog and select-model RPC honour owner checks and audit', async () => {
  const home = await makeHome('models')
  const { bridge, controller } = await makeBridge(home)
  const { proxy } = await makeProxy(home, bridge)
  try {
    const catalog = await bridge.modelCatalog()
    assert.equal(catalog.groups.length, 1)
    assert.equal(catalog.default.provider, 'deepseek')

    const viaProxy = await proxy.models()
    assert.equal(viaProxy.groups[0].models.length, 2, 'display machine sees the same catalogue')

    bridge.registry.add({ sessionId: 'session-a', workspaceId: WORKSPACE, title: 'A', creatorPeerId: PEER.deviceId })
    const selected = await proxy.selectModel({
      sessionId: 'session-a',
      provider: 'deepseek',
      model: 'deepseek-reasoner',
      reasoningEffort: 'low',
    })
    assert.deepEqual(selected.selected, { provider: 'deepseek', model: 'deepseek-reasoner', reasoningEffort: 'low' })
    assert.deepEqual(controller.calls.selectModel.at(-1), {
      sessionId: 'session-a', provider: 'deepseek', model: 'deepseek-reasoner', reasoningEffort: 'low',
    })
    assert.deepEqual(bridge.registry.get('session-a').lastModel, {
      provider: 'deepseek', model: 'deepseek-reasoner', reasoningEffort: 'low',
    })
    assert.ok(bridge.auditRows().some((row) => row.op === 'ext.shadow.select-model' && row.ok === true))

    // Another device's session is refused before reaching the controller.
    bridge.registry.add({ sessionId: 'session-other', workspaceId: WORKSPACE, title: 'Other', creatorPeerId: 'other-device' })
    const before = controller.calls.selectModel.length
    await assert.rejects(
      () => proxy.selectModel({ sessionId: 'session-other', provider: 'deepseek', model: 'deepseek-chat' }),
      (error) => error.code === 'shadow/not-owner',
    )
    assert.equal(controller.calls.selectModel.length, before, 'refused selections never reach the controller')

    await assert.rejects(
      () => proxy.selectModel({ sessionId: 'session-a', provider: '', model: 'deepseek-chat' }),
      (error) => error.code === 'shadow/bad-request',
    )
    await assert.rejects(
      () => proxy.selectModel({ sessionId: 'session-missing', provider: 'deepseek', model: 'deepseek-chat' }),
      (error) => error.code === 'shadow/session-not-managed',
    )
  } finally {
    bridge.dispose()
    proxy.dispose()
    await rm(home, { recursive: true, force: true }).catch(() => {})
  }
})

test('shadow models: createSession installs a preselected model and reports failures', async () => {
  const home = await makeHome('create')
  const { bridge, controller } = await makeBridge(home)
  try {
    const created = await bridge.createSession({
      workspaceId: WORKSPACE,
      model: { provider: 'deepseek', model: 'deepseek-chat' },
      peer: PEER,
    })
    assert.equal(created.sessionId, 'session-created-1')
    assert.deepEqual(created.model, { provider: 'deepseek', model: 'deepseek-chat' })
    assert.deepEqual(controller.calls.create.at(-1), { workspaceId: WORKSPACE })
    assert.deepEqual(controller.calls.selectModel.at(-1), {
      sessionId: 'session-created-1', provider: 'deepseek', model: 'deepseek-chat',
    })
    assert.deepEqual(bridge.registry.get('session-created-1').lastModel, { provider: 'deepseek', model: 'deepseek-chat' })

    // A failing selectModel must not pretend the whole creation failed.
    controller.selectModel = async () => { throw new Error('model unavailable') }
    const second = await bridge.createSession({
      workspaceId: WORKSPACE,
      model: { provider: 'deepseek', model: 'missing-model' },
      peer: PEER,
    })
    assert.equal(second.sessionId, 'session-created-1')
    assert.match(second.modelError, /model unavailable/)
  } finally {
    bridge.dispose()
    await rm(home, { recursive: true, force: true }).catch(() => {})
  }
})

// ---------------------------------------------------------------------------
// Interactive user questions / plan review (0.8.0)
// ---------------------------------------------------------------------------

/** Create a shadow session, then route a fake agent through bridge.start listeners. */
async function makeAgent(bridge, hostHandlers) {
  const created = await bridge.createSession({ workspaceId: WORKSPACE, peer: PEER })
  const sessionId = created.sessionId
  const handlers = new Map()
  const agent = {
    session: { id: sessionId },
    ctx: {
      on(name, handler) { handlers.set(name, handler); return () => {} },
    },
  }
  hostHandlers.get('agent/created')({ agent })
  return { sessionId, agent, handlers }
}

const SIMPLE_QUESTION = {
  id: 'q1',
  question: '选哪个方案？',
  header: '方案',
  options: [{ label: '方案 A', description: '快' }, { label: '方案 B' }],
}

test('shadow questions: waterfall claim, list, answer and audit', async () => {
  const home = await makeHome('question-answer')
  const { bridge, hostHandlers } = await makeBridge(home)
  try {
    const { sessionId, agent, handlers } = await makeAgent(bridge, hostHandlers)
    const questionHandler = handlers.get('user-questions/request')
    assert.equal(typeof questionHandler, 'function', 'question waterfall answerer registered next to approvals')

    let nextCalls = 0
    const next = async () => { nextCalls += 1; return { answers: [] } }
    const asked = questionHandler({
      agent,
      questions: [SIMPLE_QUESTION, { id: 'q2', question: '还有吗？', options: [{ label: '有' }, { label: '没有' }] }],
    }, next)
    await new Promise((resolve) => setTimeout(resolve, 10))
    assert.equal(nextCalls, 0, 'a managed shadow question is claimed, not delegated')

    const list = await bridge.handleRpc('ext.shadow.questions', { sessionId }, PEER)
    assert.equal(list.questions.length, 1)
    const pending = list.questions[0]
    assert.match(pending.questionId, /^shadow-question-/)
    assert.equal(pending.sessionId, sessionId)
    assert.equal(pending.planReview, false)
    assert.equal(pending.questions.length, 2)
    assert.equal(pending.questions[0].question, '选哪个方案？')
    assert.deepEqual(pending.questions[0].options.map((option) => option.label), ['方案 A', '方案 B'])

    const answers = [
      { id: 'q1', selected: ['方案 A'] },
      { id: 'q2', selected: [], custom: '补充一句' },
    ]
    const result = await bridge.handleRpc('ext.shadow.answer-question', {
      sessionId,
      questionId: pending.questionId,
      answers,
    }, PEER)
    assert.equal(result.accepted, true)
    assert.deepEqual(await asked, { answers })
    assert.equal(bridge.pendingQuestions.size, 0)
    assert.equal((await bridge.handleRpc('ext.shadow.questions', { sessionId }, PEER)).questions.length, 0)

    const audit = bridge.auditRows()
    assert.ok(audit.some((row) => row.action === 'question.asked' && row.questions === 2 && row.planReview === false))
    assert.ok(audit.some((row) => row.action === 'question.answered' && row.answers === 2))
  } finally {
    bridge.dispose()
    await rm(home, { recursive: true, force: true }).catch(() => {})
  }
})

test('shadow questions: plan-review intent and "request changes" cancel ASK_CANCELLED', async () => {
  const home = await makeHome('question-plan')
  const { bridge, hostHandlers } = await makeBridge(home)
  try {
    const { sessionId, agent, handlers } = await makeAgent(bridge, hostHandlers)
    const questionHandler = handlers.get('user-questions/request')
    const planDetail = '# 计划\n1. 改 A\n2. 跑测试'
    const asked = questionHandler({
      agent,
      questions: [{
        id: 'plan',
        question: '计划待审',
        header: '计划待审',
        detail: planDetail,
        options: [{ label: '同意执行' }, { label: '要求修改' }],
        intent: { kind: 'plan-review', approve: '同意执行', detail: planDetail },
      }],
    }, async () => ({ answers: [] }))
    await new Promise((resolve) => setTimeout(resolve, 10))

    const list = await bridge.handleRpc('ext.shadow.questions', { sessionId }, PEER)
    const pending = list.questions[0]
    assert.equal(pending.planReview, true)
    assert.equal(pending.intent.kind, 'plan-review')
    assert.equal(pending.intent.approve, '同意执行')

    const result = await bridge.handleRpc('ext.shadow.answer-question', {
      sessionId,
      questionId: pending.questionId,
      cancel: true,
      reason: 'modify-requested',
    }, PEER)
    assert.deepEqual(result, { accepted: true, cancelled: true })
    await assert.rejects(asked, (error) => error.code === 'ASK_CANCELLED' && /修改/.test(error.message))
    assert.equal(bridge.pendingQuestions.size, 0)
    assert.ok(bridge.auditRows().some((row) => row.action === 'question.cancelled' && row.why === 'modify-requested'))
  } finally {
    bridge.dispose()
    await rm(home, { recursive: true, force: true }).catch(() => {})
  }
})

test('shadow questions: non-shadow agents delegate and the timeout falls back to the local UI', async () => {
  const home = await makeHome('question-fallback')
  const { bridge, hostHandlers } = await makeBridge(home, { approvalTtlMs: 50 })
  try {
    // 1) A session this bridge does not manage is passed straight through.
    const foreignHandlers = new Map()
    const foreignAgent = {
      session: { id: 'session-not-managed' },
      ctx: { on(name, handler) { foreignHandlers.set(name, handler); return () => {} } },
    }
    hostHandlers.get('agent/created')({ agent: foreignAgent })
    let foreignNext = 0
    const foreign = await foreignHandlers.get('user-questions/request')({
      agent: foreignAgent,
      questions: [SIMPLE_QUESTION],
    }, async () => { foreignNext += 1; return { answers: [{ id: 'q1', selected: ['方案 A'] }] } })
    assert.equal(foreignNext, 1)
    assert.deepEqual(foreign.answers[0].selected, ['方案 A'])

    // 2) A managed question with no display answer is released to the local UI
    //    after the approval TTL (never silent auto-approve).
    const { sessionId, agent, handlers } = await makeAgent(bridge, hostHandlers)
    const localAnswers = { answers: [{ id: 'q1', selected: ['方案 B'] }] }
    const asked = handlers.get('user-questions/request')({
      agent,
      questions: [SIMPLE_QUESTION],
    }, async () => localAnswers)
    await new Promise((resolve) => setTimeout(resolve, 10))
    assert.equal(bridge.pendingQuestions.size, 1)
    const resolved = await asked
    assert.deepEqual(resolved, localAnswers)
    assert.equal(bridge.pendingQuestions.size, 0)
    assert.ok(bridge.auditRows().some((row) => row.action === 'question.fallback-local' && row.reason === 'ttl'))
    assert.ok(bridge.auditRows().some((row) => row.action === 'question.answered' && row.why === 'local-fallback'))
  } finally {
    bridge.dispose()
    await rm(home, { recursive: true, force: true }).catch(() => {})
  }
})

test('shadow questions: answer validation, ownership and pending state', async () => {
  const home = await makeHome('question-validation')
  const { bridge, hostHandlers } = await makeBridge(home)
  try {
    const { sessionId, agent, handlers } = await makeAgent(bridge, hostHandlers)
    const asked = handlers.get('user-questions/request')({ agent, questions: [SIMPLE_QUESTION] }, async () => ({ answers: [] }))
    await new Promise((resolve) => setTimeout(resolve, 10))
    const pending = (await bridge.handleRpc('ext.shadow.questions', { sessionId }, PEER)).questions[0]

    // Missing an answer item for one of the asked questions.
    await assert.rejects(
      () => bridge.handleRpc('ext.shadow.answer-question', { sessionId, questionId: pending.questionId, answers: [] }, PEER),
      (error) => error.code === 'shadow/question-invalid-answer',
    )
    // Unknown option label.
    await assert.rejects(
      () => bridge.handleRpc('ext.shadow.answer-question', {
        sessionId,
        questionId: pending.questionId,
        answers: [{ id: 'q1', selected: ['不存在的选项'] }],
      }, PEER),
      (error) => error.code === 'shadow/question-invalid-answer',
    )
    // Another display device may not list or answer it.
    await assert.rejects(
      () => bridge.handleRpc('ext.shadow.questions', { sessionId }, { deviceId: 'other-device' }),
      (error) => error.code === 'shadow/not-owner',
    )
    await assert.rejects(
      () => bridge.handleRpc('ext.shadow.answer-question', {
        sessionId,
        questionId: pending.questionId,
        answers: [{ id: 'q1', selected: ['方案 A'] }],
      }, { deviceId: 'other-device' }),
      (error) => error.code === 'shadow/not-owner',
    )
    // Unknown pending id.
    await assert.rejects(
      () => bridge.handleRpc('ext.shadow.answer-question', {
        sessionId,
        questionId: 'shadow-question-unknown',
        answers: [{ id: 'q1', selected: ['方案 A'] }],
      }, PEER),
      (error) => error.code === 'shadow/question-not-pending',
    )
    // A valid batch still settles it afterwards.
    const okay = await bridge.handleRpc('ext.shadow.answer-question', {
      sessionId,
      questionId: pending.questionId,
      answers: [{ id: 'q1', selected: ['方案 A'] }],
    }, PEER)
    assert.equal(okay.accepted, true)
    assert.deepEqual((await asked).answers, [{ id: 'q1', selected: ['方案 A'] }])
  } finally {
    bridge.dispose()
    await rm(home, { recursive: true, force: true }).catch(() => {})
  }
})

// ---------------------------------------------------------------------------
// Composer controls (0.10.25): permission presets
// ---------------------------------------------------------------------------

test('shadow permissions: catalog passthrough, guards, risk confirmation and audit', async () => {
  const home = await makeHome('permissions')
  const { bridge, services } = await makeBridge(home)
  const { proxy } = await makeProxy(home, bridge)
  try {
    bridge.registry.add({ sessionId: 'session-perm', workspaceId: WORKSPACE, title: 'P', creatorPeerId: PEER.deviceId })

    const info = await bridge.handleRpc(OPS.info, {}, PEER)
    assert.equal(info.capabilities.permissions, true)
    assert.equal(info.capabilities.attachments, true)
    assert.equal(info.permissions.options.length, 3)
    assert.equal(info.permissions.defaultPreset, 'workspace-write')
    assert.deepEqual(info.attachmentLimits.imageLimits.mediaTypes, ['image/png', 'image/jpeg'])

    const catalog = await bridge.handleRpc(OPS.permissions, { sessionId: 'session-perm', op: 'catalog' }, PEER)
    assert.deepEqual(catalog.options.map((option) => option.value), ['read-only', 'workspace-write', 'danger-full-access'])
    assert.equal(catalog.defaultPreset, 'workspace-write')
    assert.equal(catalog.current, 'workspace-write')
    // The durable Session object handed to the service is the live Agent's.
    assert.deepEqual(services.permissionPresets.calls.current.at(-1), { id: 'session-perm' })
    // One call for `info` (capability advertisement) plus one for this op.
    assert.equal(services.permissionPresets.calls.catalog, 2)

    const set = await proxy.permissions({ sessionId: 'session-perm', op: 'set', preset: 'read-only' })
    assert.deepEqual(set, { current: 'read-only', preset: 'read-only' })
    assert.deepEqual(services.permissionPresets.calls.set.at(-1), {
      session: { id: 'session-perm' },
      name: 'read-only',
    })

    // Unknown preset, then a loosening preset without explicit confirmation.
    await assert.rejects(
      () => proxy.permissions({ sessionId: 'session-perm', op: 'set', preset: 'root' }),
      (error) => error.code === CODES.badRequest,
    )
    await assert.rejects(
      () => proxy.permissions({ sessionId: 'session-perm', op: 'set', preset: 'danger-full-access' }),
      (error) => error.code === CODES.badRequest,
    )
    assert.equal(services.permissionPresets.calls.set.length, 1, 'refused presets never reach the service')
    const risky = await proxy.permissions({
      sessionId: 'session-perm',
      op: 'set',
      preset: 'danger-full-access',
      confirmed: true,
    })
    assert.deepEqual(risky, { current: 'danger-full-access', preset: 'danger-full-access' })

    // Owner guard: another display device may not read or switch the preset.
    await assert.rejects(
      () => bridge.handleRpc(OPS.permissions, { sessionId: 'session-perm', op: 'catalog' }, OTHER_PEER),
      (error) => error.code === CODES.notOwner,
    )
    // Unmanaged session id.
    await assert.rejects(
      () => bridge.handleRpc(OPS.permissions, { sessionId: 'session-missing', op: 'catalog' }, PEER),
      (error) => error.code === CODES.notManaged,
    )

    const rows = bridge.auditRows().filter((row) => row.op === OPS.permissions)
    assert.ok(rows.some((row) => row.action === 'catalog' && row.ok === true))
    assert.ok(rows.some((row) => row.action === 'set' && row.preset === 'danger-full-access' && row.ok === true))
    assert.ok(rows.every((row) => row.text === undefined && row.content === undefined), 'no prompt content in audit')
  } finally {
    bridge.dispose()
    proxy.dispose()
    await rm(home, { recursive: true, force: true }).catch(() => {})
  }
})

test('shadow permissions: an idle session is resumed before the preset service reads it', async () => {
  const home = await makeHome('permissions-resume')
  const { bridge, services, controller } = await makeBridge(home)
  const { proxy } = await makeProxy(home, bridge)
  try {
    bridge.registry.add({ sessionId: 'session-idle', workspaceId: WORKSPACE, title: 'P', creatorPeerId: PEER.deviceId })
    // Idle persisted session: no live Agent and nothing in the sessions registry.
    services.agents = { get: () => undefined }
    services.sessions = { get: () => undefined }
    const resumed = []
    controller.resume = async (sessionId) => {
      resumed.push(sessionId)
      return { session: { id: sessionId, resumed: true } }
    }

    const catalog = await bridge.handleRpc(OPS.permissions, { sessionId: 'session-idle', op: 'catalog' }, PEER)
    assert.equal(catalog.current, 'workspace-write')
    assert.deepEqual(resumed, ['session-idle'], 'the shadow bridge materializes the idle session')
    assert.deepEqual(services.permissionPresets.calls.current.at(-1), { id: 'session-idle', resumed: true })

    const set = await proxy.permissions({ sessionId: 'session-idle', op: 'set', preset: 'read-only' })
    assert.deepEqual(set, { current: 'read-only', preset: 'read-only' })
    assert.deepEqual(services.permissionPresets.calls.set.at(-1), {
      session: { id: 'session-idle', resumed: true },
      name: 'read-only',
    })
  } finally {
    bridge.dispose()
    proxy.dispose()
    await rm(home, { recursive: true, force: true }).catch(() => {})
  }
})

test('shadow permissions: a Host without the service degrades instead of breaking info', async () => {
  const home = await makeHome('permissions-off')
  const { bridge, services } = await makeBridge(home)
  try {
    bridge.registry.add({ sessionId: 'session-perm', workspaceId: WORKSPACE, title: 'P', creatorPeerId: PEER.deviceId })
    services.permissionPresets = undefined
    await assert.rejects(
      () => bridge.handleRpc(OPS.permissions, { sessionId: 'session-perm', op: 'catalog' }, PEER),
      (error) => error.code === CODES.permissionUnavailable,
    )
    const info = await bridge.handleRpc(OPS.info, {}, PEER)
    assert.equal(info.capabilities.permissions, false)
    assert.equal(info.permissions, null)
    assert.equal(info.capabilities.attachments, true, 'attachments stay available independently')

    // No agents/sessions either: the Session object cannot be materialized.
    services.agents = undefined
    services.sessions = undefined
    services.permissionPresets = makePermissionPresets()
    await assert.rejects(
      () => bridge.handleRpc(OPS.permissions, { sessionId: 'session-perm', op: 'catalog' }, PEER),
      (error) => error.code === CODES.notReady,
    )
    assert.equal((await bridge.handleRpc(OPS.info, {}, PEER)).capabilities.permissions, false)
  } finally {
    bridge.dispose()
    await rm(home, { recursive: true, force: true }).catch(() => {})
  }
})

// ---------------------------------------------------------------------------
// Composer controls (0.10.25): chunked attachment staging
// ---------------------------------------------------------------------------

/** Begin + chunk + commit one buffer over `ext.shadow.attach`. */
async function stageAttachment(bridge, sessionId, {
  buffer,
  kind = 'image',
  name = 'shot.png',
  mediaType = kind === 'image' ? 'image/png' : undefined,
  peer = PEER,
  chunkSize = 4,
} = {}) {
  const begin = await bridge.handleRpc(OPS.attach, {
    sessionId,
    action: 'begin',
    kind,
    name,
    size: buffer.length,
    ...(mediaType === undefined ? {} : { mediaType }),
  }, peer)
  let received = 0
  let index = 0
  for (let offset = 0; offset < buffer.length; offset += chunkSize) {
    const slice = buffer.subarray(offset, Math.min(buffer.length, offset + chunkSize))
    const chunk = await bridge.handleRpc(OPS.attach, {
      sessionId,
      action: 'chunk',
      transferId: begin.transferId,
      index,
      data: slice.toString('base64'),
    }, peer)
    received += slice.length
    assert.equal(chunk.received, received)
    assert.equal(chunk.index, index)
    index += 1
  }
  const commit = await bridge.handleRpc(OPS.attach, {
    sessionId,
    action: 'commit',
    transferId: begin.transferId,
  }, peer)
  return { begin, commit, transferId: begin.transferId }
}

test('shadow attach: begin/chunk/commit hashes the bytes and the prompt consumes the transfer', async () => {
  const home = await makeHome('attach-happy')
  const { bridge, controller } = await makeBridge(home)
  try {
    bridge.registry.add({ sessionId: 'session-attach', workspaceId: WORKSPACE, title: 'A', creatorPeerId: PEER.deviceId })
    const buffer = Buffer.from('hello shadow attachment payload')
    const { begin, commit, transferId } = await stageAttachment(bridge, 'session-attach', { buffer })

    assert.equal(begin.chunkBytes, LIMITS.attachChunkBytes)
    assert.equal(begin.maxBytes, LIMITS.maxAttachBytes)
    assert.equal(begin.ttlMs, LIMITS.attachTtlMs)
    assert.match(transferId, /^shadow-attach-/)
    assert.deepEqual(commit, {
      transferId,
      kind: 'image',
      name: 'shot.png',
      size: buffer.length,
      sha256: sha256(buffer),
    })
    assert.equal(bridge.stagedAttachments.size, 1)

    await bridge.handleRpc(OPS.prompt, { sessionId: 'session-attach', text: 'look', attachments: [{ transferId }] }, PEER)
    const sent = controller.calls.prompt.at(-1)
    assert.equal(sent.mode, 'queue')
    assert.deepEqual(sent.content, [
      { type: 'image', mediaType: 'image/png', data: buffer.toString('base64'), name: 'shot.png' },
      { type: 'text', text: 'look' },
    ])
    assert.equal(bridge.stagedAttachments.size, 0, 'a successful prompt cleans the staged bytes')
    // The consumed transfer cannot be replayed.
    await assert.rejects(
      () => bridge.handleRpc(OPS.prompt, { sessionId: 'session-attach', text: 'again', attachments: [{ transferId }] }, PEER),
      (error) => error.code === CODES.attachNotFound,
    )
    assert.ok(bridge.auditRows().some((row) => row.op === OPS.attach && row.action === 'commit' && row.sha256 === sha256(buffer)))
  } finally {
    bridge.dispose()
    await rm(home, { recursive: true, force: true }).catch(() => {})
  }
})

test('shadow attach: canonical base64, sequential index, size overflow, TTL and ownership', async () => {
  const home = await makeHome('attach-guards')
  let clock = 1_000_000
  const { bridge, services } = await makeBridge(home, {}, { now: () => clock })
  try {
    const sessionId = 'session-attach'
    bridge.registry.add({ sessionId, workspaceId: WORKSPACE, title: 'A', creatorPeerId: PEER.deviceId })

    const begin = await bridge.handleRpc(OPS.attach, {
      sessionId, action: 'begin', kind: 'file', name: 'note.txt', size: 6,
    }, PEER)
    // Whitespace/invalid base64 must be rejected, and so must a gap in the index.
    await assert.rejects(
      () => bridge.handleRpc(OPS.attach, { sessionId, action: 'chunk', transferId: begin.transferId, index: 0, data: 'aGVs bG8=' }, PEER),
      (error) => error.code === CODES.attachBadChunk,
    )
    await assert.rejects(
      () => bridge.handleRpc(OPS.attach, { sessionId, action: 'chunk', transferId: begin.transferId, index: 1, data: 'aGVsbG8=' }, PEER),
      (error) => error.code === CODES.attachBadChunk,
    )
    // Non-canonical (unpadded) base64 is rejected too.
    await assert.rejects(
      () => bridge.handleRpc(OPS.attach, { sessionId, action: 'chunk', transferId: begin.transferId, index: 0, data: 'aGVsbG8' }, PEER),
      (error) => error.code === CODES.attachBadChunk,
    )
    const first = await bridge.handleRpc(OPS.attach, {
      sessionId, action: 'chunk', transferId: begin.transferId, index: 0, data: 'aGVsbG8=',
    }, PEER)
    assert.deepEqual(first, { received: 5, index: 0 })
    // Declared size is 6 bytes: a 3-byte chunk would overflow it.
    await assert.rejects(
      () => bridge.handleRpc(OPS.attach, { sessionId, action: 'chunk', transferId: begin.transferId, index: 1, data: 'YWJj' }, PEER),
      (error) => error.code === CODES.attachTooLarge,
    )
    // A short transfer cannot commit.
    await assert.rejects(
      () => bridge.handleRpc(OPS.attach, { sessionId, action: 'commit', transferId: begin.transferId }, PEER),
      (error) => error.code === CODES.attachBadChunk,
    )
    // TTL expiry happens lazily on the next step.
    clock += LIMITS.attachTtlMs + 1
    await assert.rejects(
      () => bridge.handleRpc(OPS.attach, { sessionId, action: 'chunk', transferId: begin.transferId, index: 1, data: 'Yg==' }, PEER),
      (error) => error.code === CODES.attachNotFound,
    )
    assert.equal(bridge.stagedAttachments.size, 0, 'expired transfers are purged')

    // Another display device cannot touch a transfer staged by the owner.
    const other = await bridge.handleRpc(OPS.attach, {
      sessionId, action: 'begin', kind: 'image', name: 'x.png', size: 2, mediaType: 'image/png',
    }, PEER)
    await assert.rejects(
      () => bridge.handleRpc(OPS.attach, { sessionId, action: 'chunk', transferId: other.transferId, index: 0, data: 'YQ==' }, OTHER_PEER),
      (error) => error.code === CODES.notOwner,
    )
    // Invalid kind and oversized declaration.
    await assert.rejects(
      () => bridge.handleRpc(OPS.attach, { sessionId, action: 'begin', kind: 'video', name: 'v.mp4', size: 4 }, PEER),
      (error) => error.code === CODES.attachBadKind,
    )
    await assert.rejects(
      () => bridge.handleRpc(OPS.attach, { sessionId, action: 'begin', kind: 'file', name: 'big.bin', size: LIMITS.maxAttachBytes + 1 }, PEER),
      (error) => error.code === CODES.attachTooLarge,
    )
    // Images require a mediaType.
    await assert.rejects(
      () => bridge.handleRpc(OPS.attach, { sessionId, action: 'begin', kind: 'image', name: 'x.png', size: 2 }, PEER),
      (error) => error.code === CODES.attachBadKind,
    )
    await assert.rejects(
      () => bridge.handleRpc(OPS.attach, { sessionId, action: 'nope' }, PEER),
      (error) => error.code === CODES.badRequest,
    )
    // A Host without the file-upload service cannot stage attachments at all.
    services.fileUploads = undefined
    await assert.rejects(
      () => bridge.handleRpc(OPS.attach, { sessionId, action: 'begin', kind: 'file', name: 'x.txt', size: 1 }, PEER),
      (error) => error.code === CODES.notReady,
    )
    assert.equal((await bridge.handleRpc(OPS.info, {}, PEER)).capabilities.attachments, false)
  } finally {
    bridge.dispose()
    await rm(home, { recursive: true, force: true }).catch(() => {})
  }
})

test('shadow attach: concurrent transfer cap, empty files and abort', async () => {
  const home = await makeHome('attach-cap')
  const { bridge } = await makeBridge(home)
  try {
    const sessionId = 'session-cap'
    bridge.registry.add({ sessionId, workspaceId: WORKSPACE, title: 'A', creatorPeerId: PEER.deviceId })
    const transfers = []
    for (let index = 0; index < LIMITS.maxAttachTransfers; index += 1) {
      transfers.push((await bridge.handleRpc(OPS.attach, {
        sessionId, action: 'begin', kind: 'file', name: `f${index}.txt`, size: 0,
      }, PEER)).transferId)
    }
    await assert.rejects(
      () => bridge.handleRpc(OPS.attach, { sessionId, action: 'begin', kind: 'file', name: 'extra.txt', size: 0 }, PEER),
      (error) => error.code === CODES.attachBusy,
    )
    // An empty file commits with size 0 (sha256 of nothing).
    const empty = await bridge.handleRpc(OPS.attach, { sessionId, action: 'commit', transferId: transfers[0] }, PEER)
    assert.deepEqual(empty, {
      transferId: transfers[0],
      kind: 'file',
      name: 'f0.txt',
      size: 0,
      sha256: sha256(Buffer.alloc(0)),
    })
    const aborted = await bridge.handleRpc(OPS.attach, { sessionId, action: 'abort', transferId: transfers[1] }, PEER)
    assert.deepEqual(aborted, { aborted: true })
    assert.equal(bridge.stagedAttachments.size, LIMITS.maxAttachTransfers - 1)
    // Unknown transfer id on abort.
    await assert.rejects(
      () => bridge.handleRpc(OPS.attach, { sessionId, action: 'abort', transferId: transfers[1] }, PEER),
      (error) => error.code === CODES.attachNotFound,
    )
  } finally {
    bridge.dispose()
    await rm(home, { recursive: true, force: true }).catch(() => {})
  }
})

// ---------------------------------------------------------------------------
// Composer controls (0.10.25): prompt attachments
// ---------------------------------------------------------------------------

test('shadow prompt: file attachments mint host receipts, order is preserved and text is optional', async () => {
  const home = await makeHome('prompt-attach')
  const { bridge, controller, services } = await makeBridge(home)
  try {
    const sessionId = 'session-prompt'
    bridge.registry.add({ sessionId, workspaceId: WORKSPACE, title: 'A', creatorPeerId: PEER.deviceId })
    const imageBuffer = Buffer.from('fake-png-bytes')
    const fileBuffer = Buffer.from('fake-file-bytes')
    const image = await stageAttachment(bridge, sessionId, { buffer: imageBuffer, kind: 'image', name: 'shot.png' })
    const file = await stageAttachment(bridge, sessionId, {
      buffer: fileBuffer,
      kind: 'file',
      name: 'note.txt',
      mediaType: undefined,
    })

    // No text at all: still a valid prompt because attachments exist.
    await bridge.handleRpc(OPS.prompt, {
      sessionId,
      attachments: [{ transferId: file.transferId }, { transferId: image.transferId }],
    }, PEER)
    const sent = controller.calls.prompt.at(-1)
    assert.equal(sent.content.length, 2, 'no empty text part is appended')
    assert.deepEqual(sent.content[0], { type: 'file', receiptId: 'receipt-1' })
    assert.deepEqual(sent.content[1], {
      type: 'image',
      mediaType: 'image/png',
      data: imageBuffer.toString('base64'),
      name: 'shot.png',
    })
    // Only the file mints a receipt, through the Host fileUploads service, for
    // the session's live Agent.
    assert.equal(services.fileUploads.calls.length, 1)
    assert.equal(services.fileUploads.calls[0].name, 'note.txt')
    assert.equal(services.fileUploads.calls[0].data, fileBuffer.toString('base64'))
    assert.equal(services.fileUploads.calls[0].agent.session.id, sessionId)
    assert.equal(bridge.stagedAttachments.size, 0)
    assert.ok(bridge.auditRows().some((row) => row.op === OPS.prompt && row.attachments === 2))

    // Text-only prompts keep the old non-empty rule.
    await assert.rejects(
      () => bridge.handleRpc(OPS.prompt, { sessionId, text: '   ' }, PEER),
      (error) => error.code === CODES.badRequest,
    )
    // Missing / foreign transfer ids are refused before reaching the controller.
    const before = controller.calls.prompt.length
    await assert.rejects(
      () => bridge.handleRpc(OPS.prompt, { sessionId, attachments: [{ transferId: 'shadow-attach-unknown' }] }, PEER),
      (error) => error.code === CODES.attachNotFound,
    )
    assert.equal(controller.calls.prompt.length, before)
    // normalizeAttachmentRefs tolerates the string form and drops junk.
    assert.deepEqual(normalizeAttachmentRefs([{ transferId: ' a ' }, 'b', {}, null, 7]), [
      { transferId: 'a' },
      { transferId: 'b' },
    ])
    assert.deepEqual(normalizeAttachmentRefs(undefined), [])
  } finally {
    bridge.dispose()
    await rm(home, { recursive: true, force: true }).catch(() => {})
  }
})

test('shadow proxy: prompt forwards staged attachment references and tolerates empty text', async () => {
  const home = await makeHome('proxy-prompt')
  const { bridge, controller } = await makeBridge(home)
  const { proxy } = await makeProxy(home, bridge)
  try {
    const sessionId = 'session-proxy'
    bridge.registry.add({ sessionId, workspaceId: WORKSPACE, title: 'A', creatorPeerId: PEER.deviceId })
    const buffer = Buffer.from('proxy-image-bytes')
    const { transferId } = await stageAttachment(bridge, sessionId, { buffer, kind: 'image', name: 'p.png' })

    const result = await proxy.prompt({ sessionId, text: '   ', attachments: [{ transferId }] })
    assert.equal(result.accepted, true)
    assert.equal(bridge.stagedAttachments.size, 0)
    assert.deepEqual(controller.calls.prompt.at(-1).content, [
      { type: 'image', mediaType: 'image/png', data: buffer.toString('base64'), name: 'p.png' },
    ])

    // Empty text without attachments is still refused locally (no peer call).
    await assert.rejects(() => proxy.prompt({ sessionId, text: '   ' }), (error) => error.code === CODES.badRequest)
    const textOnly = await proxy.prompt({ sessionId, text: 'hello' })
    assert.equal(textOnly.accepted, true)
    assert.deepEqual(controller.calls.prompt.at(-1).content, [{ type: 'text', text: 'hello' }])
  } finally {
    bridge.dispose()
    proxy.dispose()
    await rm(home, { recursive: true, force: true }).catch(() => {})
  }
})

test('shadow prompt: a failed admission keeps staged transfers for a retry', async () => {
  const home = await makeHome('prompt-retry')
  const { bridge, controller } = await makeBridge(home)
  try {
    const sessionId = 'session-retry'
    bridge.registry.add({ sessionId, workspaceId: WORKSPACE, title: 'A', creatorPeerId: PEER.deviceId })
    const buffer = Buffer.from('retry-bytes')
    const { transferId } = await stageAttachment(bridge, sessionId, { buffer, kind: 'file', name: 'r.txt', mediaType: undefined })

    controller.prompt = async () => { throw new Error('admission refused') }
    await assert.rejects(
      () => bridge.handleRpc(OPS.prompt, { sessionId, text: 'x', attachments: [{ transferId }] }, PEER),
      /admission refused/,
    )
    assert.equal(bridge.stagedAttachments.size, 1, 'staged bytes survive a failed admission')
    // Fixing the controller lets the same transfer be sent.
    controller.prompt = async (args) => { controller.calls.prompt.push(args) }
    await bridge.handleRpc(OPS.prompt, { sessionId, text: 'x', attachments: [{ transferId }], requestId: 'req-retry-2' }, PEER)
    assert.equal(bridge.stagedAttachments.size, 0)
  } finally {
    bridge.dispose()
    await rm(home, { recursive: true, force: true }).catch(() => {})
  }
})

// ---------------------------------------------------------------------------
// Composer controls (0.10.25): B-local speech bridge
// ---------------------------------------------------------------------------

test('speech bridge: catalog, canonical transcription passthrough, errors and prepare', async () => {
  const resolveCalls = []
  const transcribeCalls = []
  const prepared = []
  // 16 bytes → canonical base64 ends with "==", so the unpadded variant differs.
  const wav = Buffer.concat([Buffer.from('RIFF'), Buffer.from('audio-bytes!')])
  assert.equal(wav.length, 16)
  const ctx = {
    get(name) {
      if (name === 'speechToText') {
        return {
          snapshot: () => ({
            providers: [{
              id: 'sensevoice',
              name: 'SenseVoice',
              location: 'local',
              languages: ['zh'],
              preparation: { phase: 'ready' },
            }],
            selection: { providerId: 'sensevoice', language: 'zh' },
          }),
          resolve: (input) => {
            resolveCalls.push(input)
            return { provider: { info: { id: 'sensevoice' } }, audio: input.audio, language: input.language }
          },
          transcribe: async (spec, signal) => {
            transcribeCalls.push({ spec, signal })
            return { text: '你好', audioSeconds: 1.5, inferenceSeconds: 0.25 }
          },
          prepare: (providerId) => prepared.push(providerId),
        }
      }
      if (name === 'speechController') return { config: { maxAudioBytes: 1234, maxDurationSeconds: 30 } }
      return undefined
    },
  }
  const speech = createSpeechBridge(ctx)
  const catalog = speech.catalog()
  assert.equal(catalog.available, true)
  assert.equal(catalog.providers[0].id, 'sensevoice')
  assert.equal(catalog.providers[0].preparation.phase, 'ready')
  assert.deepEqual(catalog.selection, { providerId: 'sensevoice', language: 'zh' })
  assert.equal(catalog.maxAudioBytes, 1234)
  assert.equal(catalog.maxDurationSeconds, 30)

  const result = await speech.transcribe({ audioBase64: wav.toString('base64'), providerId: 'sensevoice', language: 'zh' })
  assert.deepEqual(result, { text: '你好', audioSeconds: 1.5, inferenceSeconds: 0.25 })
  assert.equal(resolveCalls.length, 1)
  assert.deepEqual(resolveCalls[0].audio, wav)
  assert.ok(resolveCalls[0].audio instanceof Uint8Array)
  assert.equal(resolveCalls[0].providerId, 'sensevoice')
  assert.equal(resolveCalls[0].language, 'zh')
  assert.equal(transcribeCalls.length, 1)
  assert.ok(transcribeCalls[0].signal instanceof AbortSignal)

  // Bad / non-canonical / oversized audio is refused with the shared code.
  await assert.rejects(() => speech.transcribe({ audioBase64: 'not base64!!' }), (error) => error.code === CODES.attachBadChunk)
  await assert.rejects(
    () => speech.transcribe({ audioBase64: wav.toString('base64').replace(/=+$/, '') }),
    (error) => error.code === CODES.attachBadChunk,
  )
  await assert.rejects(
    () => speech.transcribe({ audioBase64: Buffer.alloc(2000).toString('base64') }),
    (error) => error.code === CODES.attachBadChunk,
  )
  await assert.rejects(() => speech.transcribe({ audioBase64: '' }), (error) => error.code === CODES.attachBadChunk)

  assert.deepEqual(await speech.prepare({ providerId: 'sensevoice' }), { started: true })
  assert.deepEqual(prepared, ['sensevoice'])

  // A Host without voice support: catalog never throws, transcribe is not-ready.
  const bare = createSpeechBridge({ get: () => undefined })
  assert.deepEqual(bare.catalog(), { available: false, providers: [], selection: null, maxAudioBytes: 0, maxDurationSeconds: 0 })
  await assert.rejects(() => bare.transcribe({ audioBase64: wav.toString('base64') }), (error) => error.code === CODES.notReady)
  await assert.rejects(() => bare.prepare({ providerId: 'x' }), (error) => error.code === CODES.notReady)
  // createSpeechBridge tolerates a completely missing ctx.
  assert.equal(createSpeechBridge(undefined).catalog().available, false)
  // Without a speechController the api-speech-to-text defaults are advertised.
  const noController = createSpeechBridge({
    get: (name) => (name === 'speechToText' ? { snapshot: () => ({ providers: [], selection: null }) } : undefined),
  })
  const defaults = noController.catalog()
  assert.equal(defaults.maxAudioBytes, 4 * 1024 * 1024)
  assert.equal(defaults.maxDurationSeconds, 120)
})

// ---------------------------------------------------------------------------
// Composer controls (0.10.25): data route dispatch and the voice body cap
// ---------------------------------------------------------------------------

test('shadow data route: permissions, attach and voice actions dispatch', async () => {
  const calls = []
  const proxy = {
    async permissions(input) {
      calls.push(['permissions', input])
      return { options: [], defaultPreset: '', current: 'read-only' }
    },
    async attachStep(input) {
      calls.push(['attach', input])
      return { transferId: 'shadow-attach-1', chunkBytes: LIMITS.attachChunkBytes }
    },
    async prompt(input) {
      calls.push(['prompt', input])
      return { accepted: true, requestId: 'req-1' }
    },
  }
  const speech = {
    async catalog() { return { available: true, providers: [], selection: null } },
    async transcribe(input) { calls.push(['transcribe', input]); return { text: 'hi' } },
    async prepare(input) { calls.push(['prepare', input]); return { started: true } },
  }

  assert.deepEqual(
    await runDataAction({ proxy, speech, action: 'permissions', body: { sessionId: 's1', op: 'set', preset: 'read-only', confirmed: true } }),
    { permissions: { options: [], defaultPreset: '', current: 'read-only' } },
  )
  assert.deepEqual(calls[0], ['permissions', { sessionId: 's1', op: 'set', preset: 'read-only', confirmed: true }])

  assert.deepEqual(
    await runDataAction({ proxy, speech, action: 'attach', body: { sessionId: 's1', step: 'begin', kind: 'image', name: 'a.png', size: 10, mediaType: 'image/png' } }),
    { attach: { transferId: 'shadow-attach-1', chunkBytes: LIMITS.attachChunkBytes } },
  )
  assert.deepEqual(calls[1], ['attach', {
    sessionId: 's1',
    action: 'begin',
    transferId: undefined,
    index: undefined,
    data: undefined,
    kind: 'image',
    name: 'a.png',
    size: 10,
    mediaType: 'image/png',
  }])

  assert.deepEqual(
    await runDataAction({ proxy, speech, action: 'voice', body: { op: 'catalog' } }),
    { voice: { available: true, providers: [], selection: null } },
  )
  assert.deepEqual(
    await runDataAction({ proxy, speech, action: 'voice', body: { op: 'transcribe', audioBase64: 'AAAA', providerId: 'p', language: 'zh' } }),
    { voice: { text: 'hi' } },
  )
  assert.deepEqual(calls.at(-1), ['transcribe', { audioBase64: 'AAAA', providerId: 'p', language: 'zh' }])
  assert.deepEqual(
    await runDataAction({ proxy, speech, action: 'voice', body: { op: 'prepare', providerId: 'p' } }),
    { voice: { started: true } },
  )
  // The prompt action must carry `attachments` through unchanged.
  assert.deepEqual(
    await runDataAction({
      proxy,
      speech,
      action: 'prompt',
      body: { sessionId: 's1', text: 'hi', requestId: 'req-1', attachments: [{ transferId: 'shadow-attach-1' }] },
    }),
    { prompt: { accepted: true, requestId: 'req-1' } },
  )
  assert.deepEqual(calls.at(-1), ['prompt', {
    sessionId: 's1',
    text: 'hi',
    requestId: 'req-1',
    attachments: [{ transferId: 'shadow-attach-1' }],
  }])
  await assert.rejects(
    () => runDataAction({ proxy, speech, action: 'voice', body: { op: 'nope' } }),
    (error) => error.code === 'shadow/bad-request',
  )
  await assert.rejects(
    () => runDataAction({ proxy, speech, action: 'nope', body: {} }),
    (error) => error.code === 'shadow/bad-request',
  )
  // No speech bridge injected: refused with not-ready instead of a TypeError.
  await assert.rejects(
    () => runDataAction({ proxy, action: 'voice', body: { op: 'catalog' } }),
    (error) => error.code === CODES.notReady,
  )
  for (const action of ['permissions', 'attach', 'voice']) {
    assert.ok(DATA_ACTIONS.includes(action), `${action} is a documented data action`)
  }
})

/** Minimal fake request/response pair for driving the data route handler. */
function fakeHttpRequest(payload, headers = {}) {
  const req = new EventEmitter()
  req.method = 'POST'
  req.headers = { 'x-shadow-client': '1', ...headers }
  req.socket = { remoteAddress: '127.0.0.1' }
  req.destroy = () => {}
  const body = Buffer.from(JSON.stringify(payload))
  process.nextTick(() => {
    req.emit('data', body)
    req.emit('end')
  })
  return req
}

function fakeHttpResponse() {
  const res = new EventEmitter()
  res.writableEnded = false
  res.writeHead = (status, responseHeaders) => {
    res.status = status
    res.headers = responseHeaders
  }
  res.end = (chunk) => {
    res.writableEnded = true
    res.chunk = chunk
  }
  return res
}

test('shadow data route: only the voice action gets the 8 MB body cap', async () => {
  const seen = []
  const speech = {
    async catalog() { return { available: true } },
    async transcribe(input) {
      seen.push(input.audioBase64.length)
      return { text: 'ok', audioSeconds: 1, inferenceSeconds: 1 }
    },
    async prepare() { return { started: true } },
  }
  const proxy = {
    async state() { return {} },
    approvals: () => [],
    stats: () => ({}),
    uploadsState: () => ({}),
  }
  const handler = createDataHandler({ ctx: {}, proxy, speech, log: null })
  const big = 'A'.repeat(2 * 1024 * 1024)

  const voiceRes = fakeHttpResponse()
  await handler(
    fakeHttpRequest({ action: 'voice', op: 'transcribe', audioBase64: big }, { 'x-shadow-action': 'voice' }),
    voiceRes,
  )
  assert.equal(voiceRes.status, 200, String(voiceRes.chunk || ''))
  assert.equal(seen[0], big.length, 'the 2 MB body reached the speech bridge')

  // The same body without the header keeps the 1 MB default and is rejected.
  const limitedRes = fakeHttpResponse()
  await handler(fakeHttpRequest({ action: 'voice', op: 'transcribe', audioBase64: big }), limitedRes)
  assert.equal(limitedRes.status, 413)
  assert.equal(seen.length, 1)
  assert.deepEqual(
    (await runDataAction({ proxy, speech: { catalog: async () => ({ available: false }) }, action: 'voice', body: { op: 'catalog' } })).voice,
    { available: false },
  )
})
