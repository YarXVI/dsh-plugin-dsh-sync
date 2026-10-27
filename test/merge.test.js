import test from 'node:test'
import assert from 'node:assert/strict'
import { CONFLICT, EQUAL, MERGE, PULL, SKIP, conflictName, decide, lwwWinner, mergePackageJson, mergeWorkspace } from '../src/merge.js'

const e = (hash, mtime = 1000) => ({ h: hash, s: 10, m: mtime })

test('merge: equal hashes short-circuit', () => {
  assert.equal(decide({ local: e('a'), remote: e('a'), base: null, mode: 'lww' }).action, EQUAL)
})

test('merge: remote-only files are pulled, local-only files are kept', () => {
  assert.equal(decide({ local: null, remote: e('a'), base: null, mode: 'lww' }).action, PULL)
  assert.equal(decide({ local: e('a'), remote: null, base: null, mode: 'lww' }).action, SKIP)
})

test('merge: only the side that changed wins', () => {
  assert.equal(decide({ local: e('a'), remote: e('b'), base: e('a'), mode: 'lww' }).action, PULL)
  assert.equal(decide({ local: e('b'), remote: e('a'), base: e('a'), mode: 'lww' }).action, SKIP)
})

test('merge: workspace changes merge, sessions conflict, plain files use LWW', () => {
  assert.equal(decide({ local: e('a'), remote: e('b'), base: e('base'), mode: 'merge-workspace' }).action, MERGE)
  const sessionCheck = decide({ local: e('a'), remote: e('b'), base: e('base'), mode: 'append' })
  assert.equal(sessionCheck.action, PULL)
  assert.equal(sessionCheck.reason, 'session-check')
  const remoteNewer = decide({ local: e('a', 10), remote: e('b', 20), base: null, mode: 'lww', localDevice: 'aa', remoteDevice: 'bb' })
  assert.equal(remoteNewer.action, PULL)
  const localNewer = decide({ local: e('a', 30), remote: e('b', 20), base: null, mode: 'lww', localDevice: 'aa', remoteDevice: 'bb' })
  assert.equal(localNewer.action, SKIP)
})

test('merge: a parked divergence stays parked', () => {
  const decision = decide({ local: e('a'), remote: e('b'), base: { h: 'a', divergedH: 'b' }, mode: 'append' })
  assert.equal(decision.action, SKIP)
  assert.equal(decision.reason, 'conflict-parked')
})

test('merge: LWW tie-breaks deterministically on device id', () => {
  assert.equal(lwwWinner(e('a', 5), e('b', 5), 'aaa', 'bbb'), 'remote')
  assert.equal(lwwWinner(e('a', 5), e('b', 5), 'ccc', 'bbb'), 'local')
})

test('merge: workspace union keeps both workspaces and session ids', () => {
  const local = {
    unit: { name: 'workspace', version: 2 },
    global: { initialized: true, defaultWorkspaceId: 'w1', workspaceIds: ['w1'], archivedSessionIds: ['s0'], pinnedSessionIds: [] },
    tables: { workspaces: { w1: { path: 'D:/A', title: 'A', sessionIds: ['s1'], createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z' } } },
  }
  const remote = {
    unit: { name: 'workspace', version: 2 },
    global: { initialized: true, workspaceIds: ['w1', 'w2'], archivedSessionIds: ['s9'], pinnedSessionIds: ['s1'] },
    tables: { workspaces: {
      w1: { path: 'D:/A', title: 'A', sessionIds: ['s2'], createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-03T00:00:00Z' },
      w2: { path: 'D:/B', title: 'B', sessionIds: ['s3'], createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
    } },
  }
  const { value, changed } = mergeWorkspace(local, remote)
  assert.equal(changed, true)
  assert.deepEqual(value.global.workspaceIds.sort(), ['w1', 'w2'])
  // Archived / pinned are per-machine UI state: the local list wins, the peer's
  // entries must never be adopted (that hides the peer's sessions here).
  assert.deepEqual(value.global.archivedSessionIds, ['s0'])
  assert.deepEqual(value.global.pinnedSessionIds, [])
  assert.deepEqual(value.tables.workspaces.w1.sessionIds.sort(), ['s1', 's2'])
  assert.equal(value.tables.workspaces.w1.updatedAt, '2026-01-03T00:00:00Z')
  assert.ok(value.tables.workspaces.w2)
})

test('merge: archived sessions are never adopted from the peer, session ids still union', () => {
  const local = {
    global: { workspaceIds: ['w1'], archivedSessionIds: ['a-local'], pinnedSessionIds: ['p-local'] },
    tables: { workspaces: { w1: { path: 'D:/A', sessionIds: ['s1'] } } },
  }
  const remote = {
    global: { workspaceIds: ['w2'], archivedSessionIds: ['b-remote'], pinnedSessionIds: ['p-remote'] },
    tables: { workspaces: { w1: { path: 'D:/A', sessionIds: ['s2'] }, w2: { path: 'D:/B', sessionIds: ['s3'] } } },
  }
  const { value } = mergeWorkspace(local, remote)
  assert.deepEqual(value.global.archivedSessionIds, ['a-local'])
  assert.deepEqual(value.global.pinnedSessionIds, ['p-local'])
  assert.deepEqual(value.global.workspaceIds.sort(), ['w1', 'w2'])
  assert.deepEqual(value.tables.workspaces.w1.sessionIds.sort(), ['s1', 's2'])
  // The peer keeps its own archived list when it runs the same merge.
  const peer = mergeWorkspace(remote, local)
  assert.deepEqual(peer.value.global.archivedSessionIds, ['b-remote'])
})

test('merge: a dangling defaultWorkspaceId is replaced by a workspace that exists', () => {
  const local = {
    global: { workspaceIds: ['w1'], defaultWorkspaceId: 'ghost-workspace', archivedSessionIds: [], pinnedSessionIds: [] },
    tables: { workspaces: { w1: { path: 'D:/A', sessionIds: ['s1'] } } },
  }
  const remote = { global: { workspaceIds: ['w2'], archivedSessionIds: [], pinnedSessionIds: [] }, tables: { workspaces: { w2: { path: 'D:/B' } } } }
  const { value } = mergeWorkspace(local, remote)
  assert.equal(value.global.defaultWorkspaceId, 'w1', 'the dangling id is dropped in favour of a real workspace')

  // A valid local default is preserved.
  const valid = mergeWorkspace({ ...local, global: { ...local.global, defaultWorkspaceId: 'w1' } }, remote)
  assert.equal(valid.value.global.defaultWorkspaceId, 'w1')

  // No usable workspace at all: the field is cleared instead of kept dangling.
  const empty = mergeWorkspace(
    { global: { workspaceIds: [], defaultWorkspaceId: 'gone', archivedSessionIds: [], pinnedSessionIds: [] }, tables: { workspaces: {} } },
    { global: { workspaceIds: [], defaultWorkspaceId: 'also-gone', archivedSessionIds: [], pinnedSessionIds: [] }, tables: { workspaces: {} } },
  )
  assert.equal(empty.value.global.defaultWorkspaceId, '')
})

test('merge: package.json unions dependencies and bundles, local version wins', () => {
  const local = {
    name: 'p',
    dependencies: { 'dsh-plugin-qqbot': 'link:./plugins/qqbot', shared: '1.0.0' },
    dsh: { profile: { bundles: ['base', 'dsh-plugin-qqbot'] } },
  }
  const remote = {
    name: 'p',
    dependencies: { 'dsh-experimental': '2.0.0', shared: '9.9.9' },
    dsh: { profile: { bundles: ['base', 'dsh-experimental'] } },
  }
  const { value, changed } = mergePackageJson(local, remote)
  assert.equal(changed, true)
  assert.equal(value.dependencies['dsh-plugin-qqbot'], 'link:./plugins/qqbot')
  assert.equal(value.dependencies['dsh-experimental'], '2.0.0')
  assert.equal(value.dependencies.shared, '1.0.0')
  assert.deepEqual(value.dsh.profile.bundles.sort(), ['base', 'dsh-experimental', 'dsh-plugin-qqbot'])
  assert.equal(mergePackageJson(value, remote).changed, false, 'merge is idempotent')
})

test('merge: only locally resolvable peer bundles are adopted', () => {
  const local = { name: 'p', dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-plugin-qqbot'] } } }
  const remote = {
    name: 'p',
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-plugin-qqbot', 'dsh-npu', 'dsh-npu-extra'] } },
  }
  const resolvable = new Set(['dsh-npu'])
  const { value, skipped } = mergePackageJson(local, remote, { resolveBundle: (name) => resolvable.has(name) })
  assert.deepEqual(value.dsh.profile.bundles, ['@deepseek-ai/dsh-base', 'dsh-plugin-qqbot', 'dsh-npu'])
  assert.equal(skipped.length, 1)
  assert.equal(skipped[0].kind, 'bundle-unavailable')
  assert.equal(skipped[0].name, 'dsh-npu-extra')
  assert.match(skipped[0].note, /本机未安装/)

  // Local bundles stay even when this machine cannot resolve them right now.
  const unresolvableLocal = { name: 'p', dsh: { profile: { bundles: ['dsh-local-only'] } } }
  const kept = mergePackageJson(unresolvableLocal, remote, { resolveBundle: () => false })
  assert.ok(kept.value.dsh.profile.bundles.includes('dsh-local-only'))
  assert.deepEqual(kept.value.dsh.profile.bundles, ['dsh-local-only'])
})

test('merge: link dependencies without a local target are dropped, registry versions kept', () => {
  const local = { name: 'p', dependencies: { 'dsh-plugin-qqbot': 'link:./plugins/qqbot' } }
  const remote = {
    name: 'p',
    dependencies: {
      'dsh-plugin-qqbot': 'link:./plugins/qqbot',
      'dsh-npu': 'link:./plugins/dsh-npu',
      '@liustack/modsearch': '5.10.10',
      'dsh-connect-workbuddy': '^1.2.0',
    },
    devDependencies: { 'dsh-plugin-missing-dev': 'file:./plugins/missing-dev', typescript: '^5.0.0' },
  }
  const existing = new Set(['link:./plugins/qqbot'])
  const linkTargetExists = (spec) => /^(link|file|portal):/i.test(spec) ? existing.has(spec) : true
  const { value, skipped } = mergePackageJson(local, remote, { linkTargetExists })
  assert.deepEqual(Object.keys(value.dependencies).sort(), ['@liustack/modsearch', 'dsh-connect-workbuddy', 'dsh-plugin-qqbot'])
  assert.equal(value.dependencies['dsh-plugin-qqbot'], 'link:./plugins/qqbot', 'local spec wins')
  assert.deepEqual(Object.keys(value.devDependencies), ['typescript'])
  const kinds = skipped.map((item) => `${item.kind}:${item.name}`).sort()
  assert.deepEqual(kinds, ['dependency-unavailable:dsh-npu', 'dependency-unavailable:dsh-plugin-missing-dev'])
})

test('merge: a peer bundle that is also a newer local one keeps the local entry', () => {
  const local = { name: 'p', dsh: { profile: { bundles: ['dsh-npu'] } } }
  const remote = { name: 'p', dsh: { profile: { bundles: ['dsh-npu'] } } }
  const { changed, skipped } = mergePackageJson(local, remote, { resolveBundle: () => false })
  assert.equal(changed, false)
  assert.equal(skipped.length, 0)
})

test('merge: conflict names stay inside a conflicts directory for sessions', () => {
  const name = conflictName('proj/session-x/session.v4.jsonl.zstd', 'abcdef123456', { now: Date.UTC(2026, 0, 1), session: true })
  assert.match(name.replace(/\\/g, '/'), /^proj\/session-x\/conflicts\/session\.v4\.jsonl\.zstd\./i)
  const other = conflictName('profiles/desktop/cordis.patch.yml', 'abcdef123456', { now: 0 })
  assert.match(other.replace(/\\/g, '/'), /^profiles\/desktop\/cordis\.patch\.yml\.conflict-/i)
})
