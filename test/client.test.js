import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

function makeReact() {
  return {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useEffect: () => {},
    useState: (value) => [value, () => {}],
    useMemo: (fn) => fn(),
    useCallback: (fn) => fn,
    useRef: (value) => ({ current: value }),
  }
}

const root = fileURLToPath(new URL('..', import.meta.url))
let clientModule = null

test('client: one loader call registers the device-sync UI and the shadow UI', async () => {
  const originalWindow = globalThis.window
  const originalDocument = globalThis.document
  const originalFetch = globalThis.fetch
  let definition = null
  globalThis.window = { __ModuleLoader__: { load: (def) => { definition = def } } }
  globalThis.document = {
    visibilityState: 'visible',
    getElementById: () => null,
    createElement: () => ({ id: '', textContent: '' }),
    head: { appendChild: () => {} },
    addEventListener: () => {},
    removeEventListener: () => {},
  }
  // The shadow sidebar refresh reads the panel API from apply(); answer it with
  // one peer workspace group so registration order can be asserted offline.
  const panelState = {
    sync: { available: true },
    display: {
      groups: [{
        deviceId: 'peer-device-1',
        deviceName: 'PC-B',
        workspaceId: 'workspace-1',
        workspaceTitle: '工作区',
        sessionCount: 1,
        sessions: [],
      }],
    },
  }
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ ok: true, state: panelState }),
  })
  try {
    await import('../client.js')
    // The merge must not leave a second module-loader call behind.
    const source = await readFile(join(root, 'client.js'), 'utf8')
    assert.equal(source.split('__ModuleLoader__.load').length - 1, 1)

    assert.ok(definition, 'client module must call __ModuleLoader__.load')
    assert.equal(definition.id, 'dsh-plugin-dsh-sync')
    const module = definition.factory((name) => {
      if (name === 'react') return makeReact()
      throw new Error('unexpected require: ' + name)
    })
    clientModule = module
    assert.equal(typeof module.apply, 'function')
    assert.deepEqual(module.inject, ['slots', 'layout', 'locale'])

    const registrations = []
    const disposers = []
    const locale = { register: () => () => {}, bind: () => (key) => key }
    const ctx = {
      effect: (fn) => { disposers.push(fn()) },
      get: (name) => (name === 'locale' ? locale : undefined),
      slots: {
        inject: (_name, fn) => fn(),
        register: (options, component) => {
          registrations.push({ options, component })
          return () => {}
        },
      },
      layout: { selectPanel: () => {} },
    }
    module.apply(ctx)
    // Give the shadow panel's first refresh (which drives its sidebar entries)
    // a tick to settle; it is deterministic because fetch is stubbed.
    await new Promise((resolve) => setTimeout(resolve, 20))

    // device-sync: main panel + sidebar icon; shadow: one main page only. The
    // shadow launcher is parked inside the native workspace list DOM (the
    // sidebar.workspaces slot is kind=single and owned by the native list), so
    // it must not register any extra slot entry.
    assert.equal(registrations.length, 3, 'device-sync page+icon and the shadow main page')
    const names = registrations.map((entry) => entry.options.name).sort()
    assert.deepEqual(names, ['main', 'main', 'sidebar.panellist'])
    const mainKeys = registrations.filter((entry) => entry.options.name === 'main').map((entry) => entry.options.key).sort()
    assert.deepEqual(mainKeys, ['dsh-sync-panel', 'shadow-workspace'].sort(),
      'slot keys must stay distinct')

    const sidebar = registrations.filter((entry) => entry.options.name === 'sidebar.panellist')
    assert.equal(sidebar.length, 1, 'only the device-sync sidebar icon remains')
    assert.ok(!sidebar.some((entry) => String(entry.options.id).startsWith('shadow-workspace')),
      'shadow workspaces only use the launcher, not sidebar rows')

    // Both style blocks are injected under distinct ids.
    assert.deepEqual(disposers.length >= 2, true)

    for (const dispose of disposers.reverse()) {
      try { dispose?.() } catch {}
    }
  } finally {
    // Restore the globals exactly: other test files in this process still need
    // the real fetch (and must not see a loaded client module).
    globalThis.window = originalWindow
    globalThis.document = originalDocument
    globalThis.fetch = originalFetch
  }
})

test('client: transcript helpers classify tools, summarise arguments and build diffs', () => {
  assert.ok(clientModule, 'client module must have been loaded by the previous test')
  const helpers = clientModule.__shadowTesting
  assert.ok(helpers, 'client exposes its pure helpers for tests')

  assert.equal(helpers.toolKind('read_file'), 'read')
  assert.equal(helpers.toolKind('write'), 'write')
  assert.equal(helpers.toolKind('str_replace_editor'), 'edit')
  assert.equal(helpers.toolKind('edit_file'), 'edit')
  assert.equal(helpers.toolKind('grep'), 'grep')
  assert.equal(helpers.toolKind('glob'), 'glob')
  assert.equal(helpers.toolKind('pwsh'), 'command')
  assert.equal(helpers.toolKind('background_job'), 'job')
  assert.equal(helpers.toolKind('mystery_tool'), 'other')

  const editArgs = JSON.stringify({
    path: 'src/app.js',
    old_string: 'const a = 1\nconst b = 2',
    new_string: 'const a = 1\nconst b = 3\nconst c = 4',
  })
  assert.equal(helpers.toolSummary('edit', 'edit', editArgs), 'src/app.js · +2 -1')
  const edit = helpers.extractEdit(editArgs)
  assert.equal(edit.path, 'src/app.js')
  assert.equal(edit.diff.added, 2)
  assert.equal(edit.diff.removed, 1)
  assert.ok(edit.diff.rows.some((row) => row.kind === 'add' && row.text === 'const c = 4'))
  assert.ok(edit.diff.rows.some((row) => row.kind === 'del' && row.text === 'const b = 2'))

  const write = helpers.extractWrite(JSON.stringify({ path: 'a.txt', content: 'one\ntwo\nthree' }))
  assert.equal(write.path, 'a.txt')
  assert.equal(write.content.split('\n').length, 3)

  assert.match(helpers.toolSummary('command', 'pwsh', JSON.stringify({ command: 'pnpm test', args: ['-r'] })), /pnpm test -r/)
  assert.match(helpers.toolSummary('read', 'read', JSON.stringify({ path: 'a/b.js', offset: 10, limit: 20 })), /a\/b\.js · 10:20/)
  assert.equal(helpers.firstLine('**head**\nbody', 60), '**head**')
  assert.equal(helpers.formatDuration(1500), '1.5s')
  assert.equal(helpers.formatDuration(62_000), '1m 2s')

  const diff = helpers.lineDiff('a\nb\nc', 'a\nB\nc')
  assert.equal(diff.added, 1)
  assert.equal(diff.removed, 1)
  assert.equal(diff.total, 4, 'context lines plus the changed pair')

  const catalog = {
    default: { provider: 'deepseek', model: 'deepseek-chat' },
    groups: [{ id: 'deepseek', label: 'DeepSeek', models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }, { id: 'other', name: 'Other' }] }],
  }
  assert.equal(helpers.modelKey({ provider: 'deepseek', model: 'deepseek-chat' }), 'deepseek::deepseek-chat')
  assert.equal(helpers.findCatalogModel(catalog, { provider: 'deepseek', model: 'other' }).model.name, 'Other')
  assert.equal(helpers.modelLabel(catalog, { provider: 'deepseek', model: 'deepseek-chat' }), 'DeepSeek · DeepSeek Chat')
  assert.equal(helpers.modelLabel(catalog, { provider: 'missing', model: 'x' }), 'x')
})

test('client: interactive questions normalize, validate and build answer batches', () => {
  const helpers = clientModule?.__shadowTesting
  assert.ok(helpers, 'client exposes its pure helpers for tests')

  const asked = helpers.normalizeQuestionRequest({
    questionId: 'shadow-question-1',
    sessionId: 'session-1',
    createdAt: 1,
    expiresAt: 60_001,
    ttlMs: 60_000,
    questions: [
      { id: 'q1', question: '选哪个方案？', header: '方案', options: [{ label: '方案 A', description: '快' }, { label: '方案 B' }], multiSelect: false },
      { id: 'q2', title: '备注', options: [], multiSelect: true },
    ],
  })
  assert.equal(asked.questionId, 'shadow-question-1')
  assert.equal(asked.planReview, false)
  assert.equal(asked.questions.length, 2)
  assert.equal(asked.questions[0].title, '选哪个方案？')
  assert.equal(asked.questions[0].options[0].description, '快')
  assert.equal(asked.questions[1].title, '备注')
  assert.equal(asked.questions[1].multiSelect, true)
  assert.equal(helpers.normalizeQuestionRequest({ questionId: 'x', questions: [] }), null)

  const drafts = helpers.blankQuestionDrafts(asked)
  assert.deepEqual(helpers.questionAnswerErrors(asked, drafts), ['选哪个方案？', '备注'])
  drafts.q1 = { selected: ['方案 A'], custom: '', skipped: false }
  assert.deepEqual(helpers.questionAnswerErrors(asked, drafts), ['备注'])
  drafts.q2 = { selected: [], custom: '补充说明', skipped: false }
  assert.deepEqual(helpers.questionAnswerErrors(asked, drafts), [])

  // Single-select custom overrides the option; multi-select keeps both.
  drafts.q1 = { selected: ['方案 B'], custom: '自定义', skipped: false }
  assert.deepEqual(helpers.buildQuestionAnswers(asked, drafts), [
    { id: 'q1', selected: [], custom: '自定义' },
    { id: 'q2', selected: [], custom: '补充说明' },
  ])
  drafts.q2 = { selected: ['标注一', '标注二'], custom: '补充说明', skipped: false }
  assert.deepEqual(helpers.buildQuestionAnswers(asked, drafts)[1], { id: 'q2', selected: ['标注一', '标注二'], custom: '补充说明' })
  drafts.q2 = { selected: [], custom: '', skipped: true }
  assert.deepEqual(helpers.buildQuestionAnswers(asked, drafts)[1], { id: 'q2', selected: [] })

  const lines = helpers.questionAnswerLines(asked, [
    { id: 'q1', selected: ['方案 A'] },
    { id: 'q2', selected: [] },
  ])
  assert.equal(lines[0].text, '方案 A')
  assert.equal(lines[1].skipped, true)

  // plan-review intent: dedicated card facts, two-line summary, approve batch.
  const planDetail = '# 计划标题\n第一步：修改 A\n第二步：运行测试\n第三步：收尾'
  const planRequest = helpers.normalizeQuestionRequest({
    questionId: 'shadow-question-plan',
    questions: [{
      id: 'plan',
      question: '计划待审',
      header: '计划待审',
      detail: planDetail,
      options: [{ label: '同意执行' }, { label: '要求修改' }],
      intent: { kind: 'plan-review', approve: '同意执行', detail: planDetail },
    }],
  })
  assert.equal(planRequest.planReview, true)
  const plan = helpers.planReviewOf(planRequest)
  assert.equal(plan.title, '计划待审')
  assert.equal(plan.approve, '同意执行')
  assert.equal(helpers.planReviewSummary(plan.detail), '计划标题 / 第一步：修改 A')
  assert.deepEqual(helpers.approvePlanAnswers(planRequest, plan), [{ id: 'plan', selected: ['同意执行'] }])
  assert.equal(helpers.planReviewOf(asked), null)
})

test('client: file push helpers chunk, hash and drive begin/chunk/commit', async () => {
  const helpers = clientModule?.__shadowTesting
  assert.ok(helpers, 'client exposes its pure helpers for tests')

  assert.equal(helpers.formatFileSize(512), '512 B')
  assert.equal(helpers.formatFileSize(1536), '1.5 KB')
  assert.equal(helpers.formatFileSize(2 * 1024 * 1024), '2 MB')
  assert.equal(helpers.formatFileSize(10 * 1024 * 1024), '10 MB')

  const text = 'dsh-sync 0.9.0 push payload'
  const bytes = new TextEncoder().encode(text)
  const chunks = helpers.uploadChunksOf(bytes, 8)
  assert.equal(chunks.length, Math.ceil(bytes.length / 8))
  const rejoined = chunks
    .map((chunk) => Buffer.from(chunk, 'base64'))
    .reduce((all, part) => Buffer.concat([all, part]), Buffer.alloc(0))
  assert.equal(rejoined.toString(), text, 'chunks must round-trip the file bytes')

  const hash = await helpers.sha256HexOf(bytes)
  assert.match(hash, /^[0-9a-f]{64}$/)
  assert.equal(hash, Buffer.from(await crypto.subtle.digest('SHA-256', bytes)).toString('hex'))

  // A successful push: begin -> one sequential chunk per slice -> commit.
  const calls = []
  const result = await helpers.pushLocalFile({
    chunkBytes: 8,
    file: { name: 'payload.txt', arrayBuffer: async () => bytes.slice().buffer },
    push: async (payload) => {
      calls.push(payload)
      if (payload.action === 'begin') return { chunkBytes: 8 }
      if (payload.action === 'chunk') return { receivedBytes: 8 }
      if (payload.action === 'commit') return { name: 'payload.txt', size: bytes.length, sha256: hash }
      return { ok: true }
    },
  })
  assert.equal(result.name, 'payload.txt')
  assert.equal(result.size, bytes.length)
  assert.equal(result.sha256, hash)
  assert.equal(result.chunks, chunks.length)
  assert.deepEqual(calls.map((call) => call.action), ['begin', ...Array(chunks.length).fill('chunk'), 'commit'])
  assert.equal(calls[0].sha256, hash, 'begin declares the sha256')
  assert.equal(calls.at(-1).sha256, hash, 'commit repeats the sha256 for verification')
  assert.equal(new Set(calls.filter((call) => call.action === 'chunk').map((call) => call.index)).size, chunks.length)

  // A failing push aborts the peer-side transfer instead of leaving it open.
  const seen = []
  await assert.rejects(
    () => helpers.pushLocalFile({
      chunkBytes: 8,
      file: { name: 'payload.txt', arrayBuffer: async () => bytes.slice().buffer },
      push: async (payload) => {
        seen.push(payload.action)
        if (payload.action === 'chunk') throw new Error('network down')
        return { chunkBytes: 8 }
      },
    }),
    /network down/,
  )
  assert.deepEqual(seen, ['begin', 'chunk', 'abort'])
})

test('client: push-file card renders only with a selected peer that accepts files', () => {
  const helpers = clientModule?.__shadowTesting
  assert.ok(helpers, 'client exposes its pure helpers for tests')
  const t = (key) => key
  const push = (panel) => helpers.PushFileCard({ panel, t, busy: '', push: null, onPush: () => {} })

  // No peer selected -> no control.
  assert.equal(push({ display: { peerDeviceId: '' }, uploads: { peer: { enabled: true } } }), null)
  // Peer selected but uploads disabled -> no control.
  assert.equal(push({ display: { peerDeviceId: 'peer-1' }, uploads: { peer: { enabled: false } } }), null)
  assert.equal(push({ display: { peerDeviceId: 'peer-1' } }), null)
  // Peer selected + uploads enabled -> card with the file picker and button.
  const card = push({
    display: { peerDeviceId: 'peer-1' },
    uploads: { peer: { enabled: true, maxBytes: 64 * 1024 * 1024, chunkBytes: 512 * 1024 } },
  })
  assert.ok(card, 'the push control must appear')
  const text = JSON.stringify(card)
  assert.match(text, /uploadsTitle/)
  assert.match(text, /uploadsSend/)
  assert.match(text, /"type":"file"/)
  assert.match(text, /64 MB/, 'the peer file-size limit is shown')
})

test('client: markdown block parser keeps fences, tables, lists and nesting', () => {
  const helpers = clientModule?.__shadowTesting
  assert.ok(helpers, 'client exposes its pure helpers for tests')
  const blocks = helpers.markdownBlocks([
    '## 标题',
    '',
    '一个段落，带 `inline` 和 **粗体**。',
    '',
    '```js',
    'const a = 1',
    '```',
    '',
    '| 列一 | 列二 |',
    '| --- | --- |',
    '| a | b |',
    '',
    '- 第一项',
    '  - 嵌套项',
    '- 第二项',
    '',
    '> 引用',
    '',
    '---',
    '',
    '```',
    'unclosed fence',
  ].join('\n'))
  assert.deepEqual(blocks.map((block) => block.type), [
    'heading', 'paragraph', 'code', 'table', 'list', 'quote', 'hr', 'code',
  ])
  assert.equal(blocks[0].level, 2)
  assert.equal(blocks[2].lang, 'js')
  assert.equal(blocks[2].code, 'const a = 1')
  assert.deepEqual(blocks[3].head, ['列一', '列二'])
  assert.deepEqual(blocks[3].rows, [['a', 'b']])
  assert.deepEqual(blocks[4].items.map((item) => [item.text, item.depth]), [['第一项', 0], ['嵌套项', 1], ['第二项', 0]])
  assert.equal(blocks[7].code, 'unclosed fence', 'an unclosed fence flushes to the end')
})

test('client: transcript groups turns, steps, reasoning, tools and the reply', () => {
  const helpers = clientModule?.__shadowTesting
  assert.ok(helpers, 'client exposes its pure helpers for tests')
  const events = [
    { type: 'turn/start', seq: 1, time: 1_000, data: {} },
    { type: 'user/message', seq: 2, time: 1_010, data: { message: { content: [{ type: 'text', text: '修一下这个文件' }] } } },
    { type: 'step/start', seq: 3, time: 1_100, data: {} },
    {
      type: 'assistant/message', seq: 4, time: 2_000,
      data: {
        message: {
          content: [
            { type: 'reasoning', text: '先看代码\n再改' },
            { type: 'tool-call', id: 'call-1', name: 'read', arguments: '{"path":"src/a.js"}' },
          ],
        },
      },
    },
    { type: 'tool/call', seq: 5, time: 2_010, data: { callId: 'call-1', name: 'read', arguments: '{"path":"src/a.js"}' } },
    { type: 'tool/result', seq: 6, time: 2_100, data: { message: { toolCallId: 'call-1', content: [{ type: 'text', text: 'line one\nline two' }] } } },
    { type: 'tool/call', seq: 7, time: 2_200, data: { callId: 'call-2', name: 'edit_file', arguments: '{"path":"src/a.js","old_string":"a","new_string":"b"}' } },
    { type: 'tool/result', seq: 8, time: 2_400, data: { message: { toolCallId: 'call-2', content: [{ type: 'text', text: 'ok' }] } } },
    { type: 'todo/write', seq: 9, time: 2_500, data: { todos: [{ content: '改代码', status: 'completed' }, { content: '跑测试', status: 'in_progress' }] } },
    {
      type: 'assistant/message', seq: 10, time: 3_000,
      data: { message: { content: [{ type: 'text', text: '已经改好并跑过测试。' }] } },
    },
    { type: 'turn/end', seq: 11, time: 3_100, data: { reason: 'completed' } },
  ]
  const { turns } = helpers.buildTranscript(events)
  assert.equal(turns.length, 1)
  const turn = turns[0]
  assert.equal(turn.user.text, '修一下这个文件')
  assert.deepEqual(turn.blocks.map((block) => block.kind), ['process', 'response'])
  const process = turn.blocks[0]
  assert.deepEqual(process.items.map((item) => item.kind), ['reasoning', 'tool', 'tool', 'todo'])
  assert.equal(process.items[0].durationMs, 900, 'reasoning duration is the step time')
  assert.equal(process.items[1].row.kind, 'read')
  assert.equal(process.items[2].row.kind, 'edit')
  assert.equal(turn.blocks[1].text, '已经改好并跑过测试。')
  assert.equal(turn.tail.reason, 'completed')

  const stats = helpers.processStats(process)
  assert.equal(stats.tools, 2)
  assert.equal(stats.reads, 1)
  assert.equal(stats.edits, 1)
  assert.equal(stats.reasoningMs, 900)
  assert.equal(stats.running, false)

  // A standalone tool/call without a result stays running.
  const open = helpers.buildTranscript([
    { type: 'user/message', seq: 1, time: 1, data: { message: { content: [{ type: 'text', text: 'go' }] } } },
    { type: 'tool/call', seq: 2, time: 2, data: { callId: 'call-9', name: 'pwsh', arguments: '{"command":"pnpm test"}' } },
  ]).turns
  assert.equal(helpers.processStats(open[0].blocks[0]).running, true)
  assert.equal(open[0].blocks[0].items[0].row.result, undefined)
})

test('client: live reasoning/reply attach to the open turn', () => {
  const helpers = clientModule?.__shadowTesting
  assert.ok(helpers, 'client exposes its pure helpers for tests')
  const { turns } = helpers.buildTranscript([
    { type: 'user/message', seq: 1, time: 1_000, data: { message: { content: [{ type: 'text', text: '你好' }] } } },
  ])
  const live = helpers.attachLive(turns, { reasoning: '正在想', text: '', running: true, startedAt: 1_500, now: 2_000 })
  assert.equal(live.length, 1, 'live content stays inside the open turn')
  const process = live[0].blocks[0]
  assert.equal(process.kind, 'process')
  assert.equal(process.items[0].kind, 'reasoning')
  assert.equal(process.items[0].streaming, true)
  assert.equal(process.items[0].durationMs, 500)
  assert.equal(helpers.processStats(process).running, true)

  const withText = helpers.attachLive(live, { reasoning: '正在想', text: '先说一半', running: true, startedAt: 1_500, now: 2_100 })
  assert.equal(withText[0].blocks[withText[0].blocks.length - 1].kind, 'response')
  assert.equal(withText[0].blocks[withText[0].blocks.length - 1].streaming, true)

  // A finished turn gets a synthetic live turn (never overwrites the answer).
  const closed = [{ ...turns[0], tail: { at: 1_500, reason: 'completed' } }]
  const synthetic = helpers.attachLive(closed, { reasoning: '', text: '下一轮', running: true, now: 3_000 })
  assert.equal(synthetic.length, 2)
  assert.equal(synthetic[1].live, true)
  assert.equal(synthetic[0].tail.reason, 'completed')
})

test('client: tool facts expose diffs, exit codes, read windows and search counts', () => {
  const helpers = clientModule?.__shadowTesting
  assert.ok(helpers, 'client exposes its pure helpers for tests')
  const labels = { linesUnit: 'lines', matchesUnit: 'matches', filesUnit: 'files', pathsUnit: 'paths' }
  const t = (key) => labels[key] || key

  const edit = helpers.toolRowModel({
    kind: 'edit', name: 'edit_file',
    args: JSON.stringify({ path: 'a.js', old_string: 'one\ntwo', new_string: 'one\nthree' }),
    result: 'ok', isError: false, durationMs: 12,
  }, t)
  assert.equal(edit.path, 'a.js')
  assert.deepEqual(edit.diffStat, { added: 1, removed: 1 })
  assert.equal(edit.diff.rows.length, 3)
  assert.equal(edit.state, 'done')

  const command = helpers.toolRowModel({
    kind: 'command', name: 'pwsh', args: JSON.stringify({ command: 'pnpm test' }),
    result: 'done\nProcess exited with code 1', isError: false,
  }, t)
  assert.equal(command.command.text, 'pnpm test')
  assert.deepEqual(command.exit, { code: 1, failed: true, label: '退出码 1' })

  const failed = helpers.toolRowModel({ kind: 'command', name: 'pwsh', args: '{}', result: 'boom', isError: true }, t)
  assert.equal(failed.exit.label, '未正常退出')

  const read = helpers.toolRowModel({
    kind: 'read', name: 'read', args: JSON.stringify({ path: 'src/a.js', offset: 10, limit: 20 }),
    result: 'x\ny\nz',
  }, t)
  assert.equal(read.read.offset, 10)
  assert.equal(read.read.lines, 3)
  assert.equal(read.suffix, '3 lines')

  const grep = helpers.toolRowModel({
    kind: 'grep', name: 'grep', args: JSON.stringify({ pattern: 'foo' }),
    result: 'src/a.js:3:foo\nsrc/a.js:9:foo bar\nsrc/b.js:1:foo',
  }, t)
  assert.equal(grep.search.matches, 3)
  assert.equal(grep.search.files, 2)
  assert.equal(grep.suffix, '3 matches · 2 files')

  assert.deepEqual(helpers.searchStats('a.js:1:x\nb.js:2:y'), { matches: 2, files: 2, lines: 2 })
  assert.equal(helpers.exitCodeOf('no code here'), null)
  assert.equal(helpers.exitCodeOf('(exit: 0)').code, 0)
  assert.equal(helpers.toolRowRunning({ kind: 'read', result: undefined }), true)
  assert.equal(helpers.toolRowRunning({ kind: 'read', result: '' }), false)
})

test('client: scroll follow and relative time heuristics', () => {
  const helpers = clientModule?.__shadowTesting
  assert.ok(helpers, 'client exposes its pure helpers for tests')

  const bottom = helpers.scrollFollow({ scrollTop: 1_500, scrollHeight: 2_000, clientHeight: 500 })
  assert.equal(bottom.distance, 0)
  assert.equal(bottom.atBottom, true)
  assert.equal(bottom.following, true)
  const near = helpers.scrollFollow({ scrollTop: 1_470, scrollHeight: 2_000, clientHeight: 500 })
  assert.equal(near.distance, 30)
  assert.equal(near.atBottom, false)
  assert.equal(near.following, true, 'within the follow slack still follows')
  const away = helpers.scrollFollow({ scrollTop: 1_200, scrollHeight: 2_000, clientHeight: 500 })
  assert.equal(away.distance, 300)
  assert.equal(away.following, false)
  assert.equal(helpers.scrollFollow({ scrollTop: 0, scrollHeight: 400, clientHeight: 500 }).atBottom, true,
    'content shorter than the viewport is at the bottom')

  const now = Date.parse('2026-10-26T12:00:00Z')
  assert.equal(helpers.relativeTime(now - 5_000, now), '刚刚')
  assert.equal(helpers.relativeTime(now - 5 * 60_000, now), '5 分钟前')
  assert.equal(helpers.relativeTime(now - 3 * 3_600_000, now), '3 小时前')
  assert.match(helpers.relativeTime(now - 3 * 86_400_000, now), /月.*日/)
  assert.equal(helpers.relativeTime(0, now), '')
  assert.equal(helpers.relativeTime(Number.NaN, now), '')
})


test('client: workspace display aliases are local, trimmable and removable', () => {
  const helpers = clientModule.__shadowTesting
  const store = new Map()
  const originalWindow = globalThis.window
  globalThis.window = {
    localStorage: {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => { store.set(key, String(value)) },
      removeItem: (key) => { store.delete(key) },
    },
    dispatchEvent: () => {},
  }
  try {
    const group = { deviceId: 'peer-1', workspaceId: 'ws-a', workspaceTitle: '双工工作区' }
    assert.equal(helpers.aliasKeyOf(group), 'peer-1:ws-a')
    assert.equal(helpers.workspaceAlias(group), '', 'no alias by default')
    helpers.setWorkspaceAlias(group, '  我的双工  ')
    assert.equal(helpers.workspaceAlias(group), '我的双工', 'alias is trimmed and stored')
    assert.equal(helpers.workspaceAlias({ deviceId: 'peer-1', workspaceId: 'ws-b' }), '',
      'aliases are keyed per peer workspace')
    helpers.setWorkspaceAlias(group, '')
    assert.equal(helpers.workspaceAlias(group), '', 'empty name removes the alias')
  } finally {
    globalThis.window = originalWindow
  }
})

test('client: device-sync helpers cover roles, scopes, conflicts, paging and fallbacks', () => {
  const helpers = clientModule?.__syncTesting
  assert.ok(helpers, 'client exposes its device-sync pure helpers for tests')

  // Role/lock derivation: explicit settings win, old backends fall back to peers.
  assert.deepEqual(helpers.deriveRole({}), { role: 'host', roleLocked: false })
  assert.deepEqual(helpers.deriveRole({ settings: { role: 'sub', roleLocked: true } }), { role: 'sub', roleLocked: true })
  assert.deepEqual(helpers.deriveRole({ peers: [{ trusted: true, role: 'host' }] }), { role: 'sub', roleLocked: true })
  assert.deepEqual(helpers.deriveRole({ peers: [{ trusted: false }] }), { role: 'host', roleLocked: false })

  // Settings defaults, cleanup validation and the Phase-1 shadow gate.
  const settings = helpers.readSettings({
    settings: {
      realtime: true,
      localOnlyExcluded: true,
      shadowWorkspace: { enabled: true },
      cleanup: { retentionDays: 30, recycleMax: 5000, backupDays: 999, enabled: false, recycle: false },
    },
  })
  assert.equal(settings.realtime, true)
  assert.equal(settings.localOnlyExcluded, true)
  assert.equal(settings.shadowWorkspaceKnown, true)
  assert.equal(settings.shadowWorkspaceEnabled, true)
  assert.equal(settings.cleanup.retentionDays, 30)
  assert.equal(settings.cleanup.backupDays, 45, 'invalid backup days fall back to the default')
  assert.equal(settings.cleanup.recycleMax, 1000, 'the recycle cap clamps to 1000')
  assert.equal(settings.cleanup.enabled, false)
  const legacy = helpers.readSettings({})
  assert.equal(legacy.shadowWorkspaceKnown, false, 'an older backend reports no shadow setting')
  assert.equal(legacy.shadowWorkspaceEnabled, false)
  assert.equal(legacy.role, 'host')
  assert.equal(legacy.roleLocked, false)
  assert.equal(helpers.shadowGate.enabled, null, 'the shared gate stays unknown until reported')
  assert.equal(helpers.clampRecycleMax(0), 1)
  assert.equal(helpers.clampRecycleMax(5000), 1000)
  assert.equal(helpers.clampRecycleMax('abc', 100), 100)

  // Scope drafts beat state; a backend without items gets one placeholder row.
  const state = {
    sets: [
      { id: 'sessions', label: '会话记录', enabled: true, files: 12, bytes: 2048 },
      { id: 'cache', label: '缓存', enabled: false, files: 2, bytes: 10 },
    ],
  }
  const base = helpers.normalizeSets(state, undefined)
  assert.equal(base.length, 2)
  assert.equal(base[0].items.length, 1, 'missing item lists fall back to a placeholder row')
  assert.equal(base[0].items[0].id, 'sessions:all')
  assert.match(base[0].items[0].meta, /后端暂未提供逐项清单/)
  assert.equal(base[0].changed, false)
  assert.deepEqual(helpers.pendingSets(base), [])

  const drafted = helpers.normalizeSets(state, {
    sets: {
      sessions: { enabled: false, items: { 'sessions:all': false } },
      cache: { enabled: true },
    },
  })
  assert.equal(drafted[0].draft, false, 'local draft wins over the state value')
  assert.equal(drafted[0].items[0].draft, false)
  assert.equal(drafted[0].changed, true)
  assert.equal(drafted[1].enabled, false)
  assert.equal(drafted[1].draft, true)
  assert.equal(drafted[1].changed, true)
  assert.equal(helpers.pendingSets(drafted).length, 2)

  const payload = helpers.setsPayload(drafted)
  assert.deepEqual(payload.sets, [
    { id: 'sessions', enabled: false },
    { id: 'cache', enabled: true },
  ], 'placeholder rows are not persisted as fake item ids')
  assert.deepEqual(payload.enabled, ['cache'], 'the legacy id list stays available')
  assert.equal(payload.items.sessions, undefined, 'unscoped placeholder ids never leak into the payload')
  assert.deepEqual(payload.setItems.map((row) => [row.id, row.enabled]), [['sessions', false], ['cache', true]])
  assert.deepEqual(payload.setItems[0].items, [{ id: 'sessions:all', enabled: false }])

  // The engine currently returns item ids as strings; `null` means unconfigured
  // and `[]` means "explicitly nothing selected".
  const engineSets = helpers.normalizeSets({
    sets: [{ id: 'sessions', label: '会话记录', enabled: true, files: 2, bytes: 10, items: ['s1', 's2'] }],
  }, { sets: { sessions: { items: { s2: false } } } })
  assert.deepEqual(engineSets[0].items.map((item) => item.id), ['s1', 's2'])
  assert.equal(engineSets[0].items[0].draft, true)
  assert.equal(engineSets[0].items[1].draft, false, 'string item ids honour item drafts')
  assert.equal(engineSets[0].changed, true)
  assert.equal(engineSets[0].scoped, true)
  assert.deepEqual(helpers.setsPayload(engineSets).sets, [{ id: 'sessions', enabled: true, items: ['s1'] }])
  const explicitEmpty = helpers.normalizeSets({
    sets: [{ id: 'cache', label: '缓存', enabled: true, files: 1, bytes: 1, items: [] }],
  }, undefined)
  assert.equal(explicitEmpty[0].items[0].draft, false, 'items: [] means nothing selected')
  assert.equal(explicitEmpty[0].scoped, true, 'an empty list is still an explicit backend scope')
  assert.deepEqual(helpers.setsPayload(explicitEmpty).sets, [{ id: 'cache', enabled: true, items: [] }])
  const unconfigured = helpers.normalizeSets({
    sets: [{ id: 'cache', label: '缓存', enabled: true, files: 1, bytes: 1, items: null }],
  }, undefined)
  assert.equal(unconfigured[0].items[0].draft, true, 'items: null falls back to everything on')
  assert.equal(unconfigured[0].scoped, true, 'items: null is a known "all" item scope')
  assert.equal(unconfigured[0].explicitItems, false, 'the all-scope omits the items payload')

  // Phase 2: the `list-items` catalogue supplies labels/size/group while the
  // persisted `selected/all` scope decides the baseline.
  const catalog = helpers.normalizeCatalog({
    items: [
      { id: 'plugins/a', label: '插件 A', size: 1024, files: 3, group: '插件' },
      { id: 'package.json', label: 'package.json', size: 2048, files: 1 },
    ],
    selected: ['package.json'],
    all: false,
  })
  assert.equal(catalog.items.length, 2)
  assert.equal(catalog.items[0].label, '插件 A')
  assert.equal(catalog.items[0].type, '插件')
  assert.match(catalog.items[0].meta, /3 个文件 · 1\.0 KB/)
  assert.deepEqual(catalog.selected, ['package.json'])
  assert.equal(catalog.all, false)

  const catalogState = { sets: [{ id: 'profile', label: '配置与插件', enabled: true, files: 4, bytes: 3072, items: ['package.json'] }] }
  const catalogSets = helpers.normalizeSets(catalogState, undefined, { profile: catalog })
  assert.deepEqual(catalogSets[0].items.map((item) => item.id), ['plugins/a', 'package.json'])
  assert.equal(catalogSets[0].items[0].label, '插件 A', 'catalog labels replace raw item ids')
  assert.equal(catalogSets[0].items[0].draft, false)
  assert.equal(catalogSets[0].items[1].draft, true)
  assert.equal(catalogSets[0].catalogLoaded, true)
  assert.equal(catalogSets[0].explicitItems, true)
  assert.deepEqual(helpers.setsPayload(catalogSets).sets, [{ id: 'profile', enabled: true, items: ['package.json'] }])

  // all=true → omit `items`; unchecking one item switches to an explicit list.
  const allState = { sets: [{ id: 'sessions', label: '会话记录', enabled: true, files: 2, bytes: 20, items: null }] }
  const allCatalog = helpers.normalizeCatalog({
    items: [{ id: 'sessions/a.jsonl', label: '会话 A' }, { id: 'sessions/b.jsonl', label: '会话 B' }],
    selected: [],
    all: true,
  })
  const allSets = helpers.normalizeSets(allState, undefined, { sessions: allCatalog })
  assert.equal(allSets[0].explicitItems, false)
  assert.equal(allSets[0].items[0].draft, true)
  assert.equal(allSets[0].changed, false)
  assert.equal(helpers.setsPayload(allSets).sets[0].items, undefined, 'items is omitted for the all-scope')
  const allDraft = helpers.normalizeSets(allState, { sets: { sessions: { items: { 'sessions/a.jsonl': false } } } }, { sessions: allCatalog })
  assert.equal(allDraft[0].explicitItems, true)
  assert.deepEqual(helpers.setsPayload(allDraft).sets, [{ id: 'sessions', enabled: true, items: ['sessions/b.jsonl'] }])
  const selectNone = helpers.normalizeSets(allState, { sets: { sessions: { all: false } } }, { sessions: allCatalog })
  assert.equal(selectNone[0].explicitItems, true)
  assert.deepEqual(selectNone[0].selectedIds, [])
  assert.deepEqual(helpers.setsPayload(selectNone).sets, [{ id: 'sessions', enabled: true, items: [] }])
  const selectAll = helpers.normalizeSets(
    { sets: [{ id: 'sessions', label: '会话记录', enabled: true, items: [] }] },
    { sets: { sessions: { all: true } } },
    { sessions: allCatalog },
  )
  assert.equal(selectAll[0].explicitItems, false, '全选 goes back to the null/all scope')
  assert.equal(selectAll[0].clearItems, true, 'an explicit scope must be cleared with items: null')
  assert.deepEqual(helpers.setsPayload(selectAll).sets, [{ id: 'sessions', enabled: true, items: null }])
  // A scope that is already "all" needs no items field at all.
  assert.equal(allSets[0].clearItems, false)

  // catalogue loading / failure branches keep the drawer usable.
  const loadingCatalog = helpers.normalizeSets(catalogState, undefined, { profile: { loading: true, error: '' } })
  assert.equal(loadingCatalog[0].catalogLoading, true)
  assert.equal(loadingCatalog[0].catalogLoaded, false)
  const failedCatalog = helpers.normalizeSets(catalogState, undefined, { profile: { loading: false, error: '未知操作：list-items' } })
  assert.equal(failedCatalog[0].catalogError, '未知操作：list-items')
  assert.equal(failedCatalog[0].items.length, 1, 'failed catalog falls back to the state rows')
  assert.equal(failedCatalog[0].items[0].id, 'package.json')

  // Conflict retention: lastAccessAt wins; never-accessed rows use createdAt.
  const now = Date.now()
  const daysAgo = (n) => new Date(now - n * 86_400_000).toISOString()
  assert.equal(helpers.conflictActiveDays({ lastAccessAt: daysAgo(2) }), 2)
  assert.equal(helpers.conflictActiveDays({ createdAt: daysAgo(9) }), 9)
  assert.equal(helpers.conflictProducedDays({ createdDays: 4 }), 4)
  const cleanupOn = { enabled: true, retentionDays: 7 }
  const never = helpers.normalizeConflict({ id: 'c1', rel: 'a/b', set: 'sessions', size: 100, createdAt: daysAgo(9), keep: false }, 0, cleanupOn)
  assert.equal(never.neverAccessed, true)
  assert.equal(never.eligible, true)
  assert.match(never.label, /按产生时间 9 天 · 将自动删除/)
  const kept = helpers.normalizeConflict({ id: 'c2', rel: 'c', size: 5, createdAt: daysAgo(30), keep: true }, 1, cleanupOn)
  assert.equal(kept.eligible, false)
  assert.match(kept.label, /已保留/)
  const fresh = helpers.normalizeConflict({ id: 'c3', rel: 'd', size: 5, lastAccessAt: daysAgo(1) }, 2, cleanupOn)
  assert.equal(fresh.eligible, false)
  assert.equal(fresh.tag, 'pending')
  assert.equal(helpers.conflictEligible([never, kept, fresh], cleanupOn).length, 1)

  // 4-per-page file lists with clamping.
  const files = Array.from({ length: 6 }, (_, index) => ({ rel: 'f' + index, size: 10 }))
  const first = helpers.pageOf(files, 0)
  assert.equal(first.pages, 2)
  assert.equal(first.rows.length, 4)
  assert.equal(first.count, 6)
  assert.equal(helpers.pageOf(files, 1).rows.length, 2)
  assert.equal(helpers.pageOf(files, 9).page, 1, 'out-of-range pages clamp to the last page')
  assert.equal(helpers.bytesOfFiles(files), 60)
  assert.equal(helpers.bytesOfFiles(undefined), 0)

  // Action fallback bookkeeping and SAS formatting.
  assert.equal(helpers.isUnknownAction(new Error('未知操作：preview-immediate')), true)
  assert.equal(helpers.isUnknownAction(new Error('unknown-action')), true)
  assert.equal(helpers.isUnknownAction(new Error('role-locked')), false)
  assert.equal(helpers.sasText('482913'), '482 913')
  assert.equal(helpers.sasText('482 913'), '482 913')
  assert.equal(helpers.sasText(''), '')
  assert.equal(helpers.peerRoleOf({}, 'host'), 'sub')
  assert.equal(helpers.peerRoleOf({ role: 'host' }, 'sub'), 'host')

  // Shallow smoke test of the panel's loading branch (no DOM required).
  const rendered = helpers.PanelBody({ ctx: {} })
  assert.equal(rendered.type, 'div')
  assert.equal(rendered.props.className, 'dsync-shell')
})

test('client: device-sync panel calls the v4 actions and uses the native tokens', async () => {
  const source = await readFile(join(root, 'client.js'), 'utf8')
  for (const action of [
    'set-role', 'disconnect-all', 'set-realtime', 'set-local-only', 'set-cleanup',
    'cleanup-now', 'conflict-keep', 'conflict-delete', 'preview-push', 'preview-pull',
    'preview-immediate', 'immediate-sync', 'sync-now', 'force-pull', 'pair-start',
    'pair-confirm', 'set-shadow', 'set-sets', 'list-items',
  ]) {
    assert.ok(source.includes("'" + action + "'"), 'the panel must call the ' + action + ' action')
  }
  assert.ok(source.includes('const POLL_MS = 4000'), 'the panel keeps the 4s poll')
  assert.match(source, /const PAGE_SIZE = 4/, 'file lists are paginated 4 per page')
  assert.match(source, /width:36px;height:20px/, 'the switch uses the native 36x20 token')
  assert.match(source, /font-size:14px;font-weight:400;line-height:22px/, 'row titles use 14/22')
  assert.match(source, /font-size:13px;line-height:20px/, 'row descriptions use 13/20')
  assert.match(source, /font-size:15px;font-weight:500;line-height:22px/, 'dialog titles use 15/22')
  assert.ok(source.includes('已同步的数据会保留，不会回滚，也不会自动重连'), 'the unlocked identity copy survives')
  assert.ok(source.includes('开启实时同步前，请先了解这些'), 'the realtime risk dialog is present')
  assert.ok(source.includes('再次确认：开启实时同步'), 'the realtime second confirmation is present')
  assert.ok(source.includes('请稍候（'), 'the realtime countdown label is present')
  assert.ok(source.includes('createShadowClient(require, shadowGate)'), 'the shadow client reads the backend gate')
  // Phase 2: real item catalogue in the drawer + cleanup skipped reporting.
  assert.ok(source.includes('正在读取逐项清单'), 'the drawer shows a catalogue loading state')
  assert.ok(source.includes('逐项清单读取失败，已回退为集合级占位'), 'drawer falls back to placeholder rows')
  assert.ok(source.includes('部分副本不在受管目录，已保留'), 'cleanup reports skipped entries')
  assert.ok(source.includes('preview-pull'), '覆盖本地 previews the remote file list')
  assert.ok(!source.includes("h(Tag, { key: 'unique'"), 'no fabricated unique tag is rendered from catalogue rows')
})
