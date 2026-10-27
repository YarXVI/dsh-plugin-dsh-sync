// Shadow composer controls (0.10.25): permission preset labels, attachment
// classification, the native-like answered-question row model, the voice WAV
// encoder and the tool classifier. Pure helpers only: the browser half is
// exercised by the headless harness (_chat_harness/controls_probe.js).
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

test('shadow composer helpers: permission labels, attachments, question row, WAV, tool kind', async () => {
  const originalWindow = globalThis.window
  const originalDocument = globalThis.document
  const originalFetch = globalThis.fetch
  let definition = null
  globalThis.window = { __ModuleLoader__: { load: (def) => { definition = def } } }
  globalThis.document = {
    visibilityState: 'visible',
    getElementById: () => null,
    createElement: () => ({ id: '', textContent: '', style: {} }),
    head: { appendChild: () => {} },
    addEventListener: () => {},
    removeEventListener: () => {},
    querySelector: () => null,
  }
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, state: { sync: { available: true }, display: { groups: [] } } }) })
  try {
    await import('../client.js?shadow-composer=1')
    assert.ok(definition, 'client module must call __ModuleLoader__.load')
    const module = definition.factory((name) => {
      if (name === 'react') return makeReact()
      throw new Error('unexpected require: ' + name)
    })
    const testing = module.__shadowTesting
    assert.ok(testing, '__shadowTesting must be exported')
    const zh = testing.strings.zh
    const en = testing.strings.en
    const t = (key) => zh[key] || key
    const te = (key) => en[key] || key

    // --- permission preset labels (native wording) ----------------------
    assert.equal(testing.permissionLabelOf('read-only', t), '仅可查看')
    assert.equal(testing.permissionLabelOf('workspace-write', t), '工作区内修改')
    assert.equal(testing.permissionLabelOf('danger-full-access', t), '完全权限')
    assert.equal(testing.permissionLabelOf('auto', t), '自动审查')
    assert.equal(testing.permissionLabelOf('custom', t), '自定义')
    assert.equal(testing.permissionLabelOf('org-policy', t), 'Org Policy', 'host-custom presets title-case')
    assert.equal(testing.permissionLabelOf('', t), '')
    assert.equal(testing.permissionLabelOf('workspace-write', te), 'Workspace Write')

    // --- attachment classification --------------------------------------
    assert.equal(testing.attachmentKindOf({ type: 'image/png' }), 'image')
    assert.equal(testing.attachmentKindOf({ type: 'image/svg+xml' }), 'image')
    assert.equal(testing.attachmentKindOf({ type: 'application/pdf' }), 'file')
    assert.equal(testing.attachmentKindOf({}), 'file')
    assert.equal(testing.attachmentKindOf(null), 'file')

    // --- answered-question row model ------------------------------------
    const args = JSON.stringify({ questions: [
      { id: 'q1', question: '本次审计的类型是？' },
      { id: 'q2', question: '本次审计涉及的范围？', multi_select: true },
      { id: 'q3', question: '整体可用性打分？' },
    ] })
    const result = JSON.stringify({ answers: [
      { id: 'q1', selected: ['合规检查'] },
      { id: 'q2', selected: ['供应商管理', '财务'] },
      { id: 'q3', selected: [], custom: '4 分' },
    ] })
    const answered = testing.questionRowModel({ name: 'ask_user_question', args, result }, t)
    assert.equal(answered.total, 3)
    assert.equal(answered.answered, 3)
    assert.equal(answered.pending, false)
    assert.equal(answered.summary, '3/3 已回答')
    assert.deepEqual(answered.pairs.map((pair) => pair.answer), ['合规检查', '供应商管理 · 财务', '4 分'])
    const pending = testing.questionRowModel({ name: 'ask_user_question', args }, t)
    assert.equal(pending.pending, true)
    assert.equal(pending.summary, '等待回答')
    assert.equal(pending.answered, 0)
    const skipped = testing.questionRowModel({ name: 'ask_user_question', args, result: JSON.stringify({ answers: [{ id: 'q1', selected: [] }] }) }, t)
    assert.equal(skipped.answered, 0)
    assert.equal(skipped.pairs[0].answer, '')
    const broken = testing.questionRowModel({ name: 'ask_user_question', args: 'not json', result: 'also not json' }, t)
    assert.equal(broken.total, 0)
    assert.equal(broken.pending, true)

    // --- 16 kHz mono PCM16 WAV ------------------------------------------
    const wav = testing.encodeWav16k(new Float32Array([0, 1, -1]))
    assert.equal(wav.length, 44 + 3 * 2)
    const ascii = (start, length) => String.fromCharCode(...wav.slice(start, start + length))
    assert.equal(ascii(0, 4), 'RIFF')
    assert.equal(ascii(8, 4), 'WAVE')
    assert.equal(ascii(12, 4), 'fmt ')
    assert.equal(ascii(36, 4), 'data')
    const view = new DataView(wav.buffer)
    assert.equal(view.getUint16(20, true), 1, 'PCM format')
    assert.equal(view.getUint16(22, true), 1, 'mono')
    assert.equal(view.getUint32(24, true), 16000, 'sample rate')
    assert.equal(view.getUint16(34, true), 16, 'bit depth')
    assert.equal(view.getUint32(40, true), 6, 'data byte length')
    assert.equal(view.getInt16(44, true), 0)
    assert.equal(view.getInt16(46, true), 32767)
    assert.equal(view.getInt16(48, true), -32768)

    // --- recording clock -------------------------------------------------
    assert.equal(testing.clockText(0), '00:00')
    assert.equal(testing.clockText(75), '01:15')
    assert.equal(testing.clockText(-3), '00:00')

    // --- tool classifier + label ----------------------------------------
    assert.equal(testing.toolKind('ask_user_question'), 'question')
    assert.equal(testing.toolKind('ask_user'), 'question')
    assert.notEqual(testing.toolKind('read_file'), 'question')
    assert.equal(zh.toolQuestion, '提问')
    assert.equal(zh.questionUnanswered, '未回答')
    // New composer copy exists in both dictionaries.
    for (const key of ['permAuto', 'permWorkspace', 'addMenuFile', 'attachUploading', 'voiceRecording', 'voiceFailed', 'questionWaiting']) {
      assert.ok(typeof zh[key] === 'string' && zh[key].length > 0, `zh.${key}`)
      assert.ok(typeof en[key] === 'string' && en[key].length > 0, `en.${key}`)
    }
    // The old pinned-card copy must not linger as the only representation.
    assert.equal(zh.voiceInput, '语音输入')

    // --- follow threshold helper stays backward compatible --------------
    assert.equal(testing.scrollFollow({ scrollTop: 170, scrollHeight: 700, clientHeight: 500 }).following, true)
    assert.equal(testing.scrollFollow({ scrollTop: 0, scrollHeight: 700, clientHeight: 500 }).following, false)

    const source = await readFile(join(root, 'client.js'), 'utf8')
    assert.ok(source.includes('data-permmenu'), 'permission menu hook is rendered')
    assert.ok(source.includes('data-attach-input'), 'attachment input hook is rendered')
    assert.ok(!source.includes("h(QuestionAnsweredCard"), 'the pinned answered card must be gone')
  } finally {
    globalThis.window = originalWindow
    globalThis.document = originalDocument
    globalThis.fetch = originalFetch
  }
})


