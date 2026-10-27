import test from 'node:test'
import assert from 'node:assert/strict'
import { blockHash, mergeModelBlocks, modelBlockNames, parsePatchBlocks } from '../src/modelconfig.js'

const LOCAL = `# machine patch layer
- id: ui-settings
  name: "@deepseek-ai/dsh-client-ui-settings"
  config:
    enabled: false
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: opencode-go
    model: old-model
    reasoningEffort: high
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      opencode-go:
        apiKeyEnv: OPENCODE_GO_API_KEY
- id: npu-runtime
  name: 'dsh-npu'
  config:
    exePath: 'E:\\Bonsai2-Lab\\fastflowlm\\flm.exe'
    frontPort: 47300
`

const REMOTE = `# machine patch layer
- id: ui-settings
  name: "@deepseek-ai/dsh-client-ui-settings"
  config:
    enabled: false
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: opencode-go
    model: deepseek-v4.1-flash
    reasoningEffort: high
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      opencode-go:
        apiKeyEnv: OPENCODE_GO_API_KEY
- id: npu-runtime
  name: 'dsh-npu'
  config:
    exePath: 'E:\\other-machine\\flm.exe'
`

function blockText(text, name) {
  return parsePatchBlocks(text).find((block) => block.name === name)?.text
}

test('modelconfig: parses top-level entries and finds the whitelisted names', () => {
  const blocks = parsePatchBlocks(REMOTE)
  assert.deepEqual(blocks.map((block) => block.id), ['ui-settings', 'agent-default-model', 'llm-pi-ai', 'npu-runtime'])
  assert.deepEqual(modelBlockNames(REMOTE), ['@deepseek-ai/dsh-agent-default-model', '@deepseek-ai/dsh-llm-pi-ai'])
})

test('modelconfig: the first merge adopts the peer model blocks', () => {
  const { text, changed, adopted, bases } = mergeModelBlocks(LOCAL, REMOTE, {}, { localUpdatedAt: 1000, remoteUpdatedAt: 2000 })
  assert.equal(changed, true)
  assert.deepEqual(adopted, ['@deepseek-ai/dsh-agent-default-model'], 'identical blocks need no adoption')
  assert.ok(bases['@deepseek-ai/dsh-agent-default-model'])
  assert.ok(bases['@deepseek-ai/dsh-llm-pi-ai'], 'the identical block is recorded as the base')
  assert.ok(text.includes('model: deepseek-v4.1-flash'))
  assert.ok(!text.includes('model: old-model'))
  // The machine-owned NPU block is never touched.
  assert.equal(blockText(text, 'dsh-npu'), blockText(LOCAL, 'dsh-npu'))
  // Header and other blocks keep their bytes.
  assert.ok(text.startsWith('# machine patch layer\n'))
  assert.equal(blockText(text, '@deepseek-ai/dsh-client-ui-settings'), blockText(LOCAL, '@deepseek-ai/dsh-client-ui-settings'))
})

test('modelconfig: an older peer copy never rolls the local block back', () => {
  // Both sides run the merge, so unconditional "first sync adopts the peer"
  // would let the newer local file be overwritten by an older peer copy.
  const { text, changed, adopted, bases } = mergeModelBlocks(LOCAL, REMOTE, {}, { localUpdatedAt: 5000, remoteUpdatedAt: 1000 })
  assert.equal(changed, false)
  assert.deepEqual(adopted, [])
  assert.ok(text.includes('model: old-model'), 'the newer local block wins')
  assert.ok(!text.includes('deepseek-v4.1-flash'))
  assert.ok(bases['@deepseek-ai/dsh-agent-default-model'], 'base is remembered so a later peer edit is adopted')
})

test('modelconfig: a peer update is adopted when only the peer changed', () => {
  const bases = {
    '@deepseek-ai/dsh-agent-default-model': blockHash(blockText(LOCAL, '@deepseek-ai/dsh-agent-default-model')),
    '@deepseek-ai/dsh-llm-pi-ai': blockHash(blockText(LOCAL, '@deepseek-ai/dsh-llm-pi-ai')),
  }
  const { text, changed } = mergeModelBlocks(LOCAL, REMOTE, bases)
  assert.equal(changed, true)
  assert.ok(text.includes('model: deepseek-v4.1-flash'))
})

test('modelconfig: a local edit is not rolled back by an unchanged peer', () => {
  const remote = REMOTE
  const local = LOCAL
  const bases = {
    '@deepseek-ai/dsh-agent-default-model': blockHash(blockText(remote, '@deepseek-ai/dsh-agent-default-model')),
    '@deepseek-ai/dsh-llm-pi-ai': blockHash(blockText(remote, '@deepseek-ai/dsh-llm-pi-ai')),
  }
  const edited = local.replace('model: old-model', 'model: my-local-choice')
  const { text, changed, conflicts } = mergeModelBlocks(edited, remote, bases)
  assert.equal(changed, false)
  assert.equal(conflicts.length, 0)
  assert.ok(text.includes('model: my-local-choice'))
})

test('modelconfig: both sides edited is a conflict and the local block wins', () => {
  const baseText = LOCAL.replace('model: old-model', 'model: base-model')
  const bases = {
    '@deepseek-ai/dsh-agent-default-model': blockHash(blockText(baseText, '@deepseek-ai/dsh-agent-default-model')),
  }
  const local = LOCAL.replace('model: old-model', 'model: local-choice')
  const { text, changed, conflicts } = mergeModelBlocks(local, REMOTE, bases)
  assert.equal(changed, false)
  assert.equal(conflicts.length, 1)
  assert.equal(conflicts[0].name, '@deepseek-ai/dsh-agent-default-model')
  assert.ok(text.includes('model: local-choice'))
})

test('modelconfig: a peer-only model block is appended after the last block', () => {
  const remoteWithExtra = REMOTE.replace(
    "- id: npu-runtime",
    `- id: llm-extra
  name: "@deepseek-ai/dsh-llm-extra"
  config:
    enabled: true
- id: npu-runtime`,
  )
  const { text, adopted, changed } = mergeModelBlocks(LOCAL, remoteWithExtra, {}, { localUpdatedAt: 1000, remoteUpdatedAt: 2000 })
  assert.equal(changed, true)
  assert.ok(adopted.includes('@deepseek-ai/dsh-llm-extra'))
  assert.ok(text.includes('name: "@deepseek-ai/dsh-llm-extra"'))
  assert.equal(blockText(text, 'dsh-npu'), blockText(LOCAL, 'dsh-npu'))
})

test('modelconfig: non-whitelisted blocks are never modified', () => {
  const remoteDifferent = REMOTE.replace('frontPort', 'frontPort')
  const local = `${LOCAL}    extraMachineOnly: true\n`
  const { text, changed } = mergeModelBlocks(local, remoteDifferent, {}, { localUpdatedAt: 1000, remoteUpdatedAt: 2000 })
  assert.equal(changed, true, 'the model blocks still adopt')
  const localNpu = blockText(local, 'dsh-npu')
  const resultNpu = blockText(text, 'dsh-npu')
  assert.equal(resultNpu, localNpu, 'the non-whitelisted block keeps every byte')
})

test('modelconfig: merging is idempotent once the bases are recorded', () => {
  const first = mergeModelBlocks(LOCAL, REMOTE, {}, { localUpdatedAt: 1000, remoteUpdatedAt: 2000 })
  const second = mergeModelBlocks(first.text, REMOTE, first.bases)
  assert.equal(second.changed, false)
  assert.equal(second.text, first.text)
})

test('modelconfig: CRLF files keep their line endings', () => {
  const crlfLocal = LOCAL.replace(/\n/g, '\r\n')
  const crlfRemote = REMOTE.replace(/\n/g, '\r\n')
  const { text } = mergeModelBlocks(crlfLocal, crlfRemote, {}, { localUpdatedAt: 1000, remoteUpdatedAt: 2000 })
  assert.ok(text.includes('\r\n'))
  assert.ok(!/[^\r]\n/.test(text), 'no bare LF should be introduced')
  assert.ok(text.includes('model: deepseek-v4.1-flash'))
})
