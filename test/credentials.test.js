import test from 'node:test'
import assert from 'node:assert/strict'
import { credentialApiKeyNames, mergeCredentialRefs, parseCredentialRefs } from '../src/credentials.js'

const B_LOCAL = [
  'version: 1',
  'records:',
  '  deepseek-account-platform/default:',
  '    kind: oauth',
  '    payload:',
  '      token: b-device-token',
  'refs:',
  '  BUDDY_ACCOUNT_0225AAB5: account-json-from-b',
  '  WORKBUDDY_ACCOUNT_94AB3396: account-json-work',
  '',
].join('\n')

const A_REMOTE = [
  'version: 1',
  'records:',
  '  deepseek-account-platform/default:',
  '    kind: oauth',
  '    payload:',
  '      token: a-device-token-a',
  'refs:',
  '  OPENCODE_GO_API_KEY: sk-a-key',
  '  BUDDY_ACCOUNT_0225AAB5: account-json-from-a',
  '  WORKBUDDY_ACCOUNT_94AB3396: account-json-work-a',
  '',
].join('\n')

test('credentials: parses the refs section only', () => {
  const parsed = parseCredentialRefs(A_REMOTE)
  assert.deepEqual(parsed.refs.map((ref) => ref.name), ['OPENCODE_GO_API_KEY', 'BUDDY_ACCOUNT_0225AAB5', 'WORKBUDDY_ACCOUNT_94AB3396'])
  assert.deepEqual(credentialApiKeyNames(A_REMOTE), ['OPENCODE_GO_API_KEY'])
})

test('credentials: only *API_KEY refs are merged, records and account tokens stay local', () => {
  const result = mergeCredentialRefs(B_LOCAL, A_REMOTE)
  assert.equal(result.changed, true)
  assert.deepEqual(result.added, ['OPENCODE_GO_API_KEY'])
  assert.equal(result.conflicts.length, 0)
  assert.ok(result.text.includes('OPENCODE_GO_API_KEY: sk-a-key'))
  // Local records and account refs are untouched.
  assert.ok(result.text.includes('token: b-device-token'))
  assert.ok(result.text.includes('BUDDY_ACCOUNT_0225AAB5: account-json-from-b'))
  assert.ok(!result.text.includes('a-device-token-a'))
  assert.ok(!result.text.includes('account-json-from-a'))
})

test('credentials: an existing different value is kept and reported as a conflict', () => {
  const local = B_LOCAL.replace('refs:\n', 'refs:\n  OPENCODE_GO_API_KEY: sk-local\n')
  const result = mergeCredentialRefs(local, A_REMOTE)
  assert.equal(result.changed, false)
  assert.deepEqual(result.conflicts.map((item) => item.name), ['OPENCODE_GO_API_KEY'])
  assert.ok(result.text.includes('OPENCODE_GO_API_KEY: sk-local'))
  assert.ok(!result.text.includes('sk-a-key'))
  // No secret value leaks into the conflict record.
  assert.ok(!JSON.stringify(result.conflicts).includes('sk-'))
})

test('credentials: the same value twice is a no-op', () => {
  const local = B_LOCAL.replace('refs:\n', 'refs:\n  OPENCODE_GO_API_KEY: sk-a-key\n')
  const result = mergeCredentialRefs(local, A_REMOTE)
  assert.equal(result.changed, false)
  assert.equal(result.added.length, 0)
})

test('credentials: a missing local file becomes a minimal store, never a copy', () => {
  const result = mergeCredentialRefs('', A_REMOTE)
  assert.equal(result.changed, true)
  assert.equal(result.text, 'version: 1\nrecords: {}\nrefs:\n  OPENCODE_GO_API_KEY: sk-a-key\n')
  assert.ok(!result.text.includes('a-device-token-a'))
  assert.ok(!result.text.includes('BUDDY_ACCOUNT'))
})

test('credentials: a file without a refs section gets one appended', () => {
  const local = 'version: 1\nrecords: {}\n'
  const result = mergeCredentialRefs(local, A_REMOTE)
  assert.equal(result.changed, true)
  assert.ok(result.text.includes('refs:'))
  assert.ok(result.text.includes('OPENCODE_GO_API_KEY: sk-a-key'))
  assert.ok(result.text.startsWith('version: 1\nrecords: {}\n'))
})

test('credentials: no API_KEY on the peer means no change', () => {
  const remote = A_REMOTE.replace('  OPENCODE_GO_API_KEY: sk-a-key\n', '')
  const result = mergeCredentialRefs(B_LOCAL, remote)
  assert.equal(result.changed, false)
  assert.equal(result.text, B_LOCAL)
})

test('credentials: multi-line/block values are not copied blindly', () => {
  const remote = A_REMOTE.replace('  OPENCODE_GO_API_KEY: sk-a-key', '  OPENCODE_GO_API_KEY: |\n    sk-multi-line')
  const parsed = parseCredentialRefs(remote)
  assert.ok(parsed.refs.some((ref) => ref.name === 'OPENCODE_GO_API_KEY'))
  const result = mergeCredentialRefs(B_LOCAL, remote)
  assert.deepEqual(result.skipped, ['OPENCODE_GO_API_KEY'])
  assert.equal(result.changed, false)
})

test('credentials: CRLF files keep their line endings', () => {
  const crlfLocal = B_LOCAL.replace(/\n/g, '\r\n')
  const crlfRemote = A_REMOTE.replace(/\n/g, '\r\n')
  const result = mergeCredentialRefs(crlfLocal, crlfRemote)
  assert.equal(result.changed, true)
  assert.ok(result.text.includes('OPENCODE_GO_API_KEY: sk-a-key\r\n'))
  assert.ok(!/[^\r]\n/.test(result.text))
})
