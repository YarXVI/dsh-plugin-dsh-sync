import test from 'node:test'
import assert from 'node:assert/strict'
import { buildSets, isIgnored, isIgnoredForSet, isInside, joinInside, toRelative } from '../src/paths.js'
import { matches, matchesAny, matchesInclude } from '../src/glob.js'

test('paths: ignore rules cover generated and secret-adjacent files', () => {
  assert.equal(isIgnored('node_modules/x/index.js'), true)
  assert.equal(isIgnored('profiles/desktop/node_modules/pkg/a.js'), true)
  assert.equal(isIgnored('profiles/desktop/cordis.patch.yml.bak-sync-abc-1'), true)
  assert.equal(isIgnored('sessions/p/s/conflicts/session.v4.jsonl.zstd.abc'), true)
  assert.equal(isIgnored('sessions/p/s/session.v4.jsonl.zstd'), false)
  assert.equal(isIgnored('attachments/photo.png'), false)
})

test('paths: only the modules set opts into node_modules', () => {
  const sets = buildSets({ home: 'C:/tmp/home', profile: 'desktop' })
  const byId = Object.fromEntries(sets.map((set) => [set.id, set]))
  const modules = byId.modules
  assert.ok(modules, 'the modules set must exist')
  assert.equal(modules.mode, 'lww')
  assert.equal(modules.allowNodeModules, true)
  assert.ok(modules.include.includes('node_modules'))
  assert.equal(modules.defaultEnabled, true)
  assert.ok(modules.exclude.some((pattern) => pattern.includes('.pnpm')))
  assert.ok(modules.exclude.some((pattern) => pattern.endsWith('*.node')))
  // `**/.bin` would also swallow ordinary resources such as
  // `pkg/dist/assets/tool.bin` (`**/` compiles to `.*`), so only the contents
  // of a `.bin` directory are excluded; `node_modules/.bin` has its own entry.
  assert.ok(modules.exclude.includes('**/.bin/**'))
  assert.ok(!modules.exclude.includes('**/.bin'))
  assert.equal(matches('node_modules/@scope/pkg/dist/assets/tool.bin', '**/.bin/**'), false)
  assert.equal(matches('node_modules/pkg/dist/assets/tool.bin', '**/.bin'), true, 'the bare pattern would be too wide (regression guard)')
  assert.equal(matches('node_modules/pkg/.bin/shim', '**/.bin/**'), true)

  assert.equal(isIgnoredForSet('node_modules/undici/index.js', modules), false)
  assert.equal(isIgnoredForSet('node_modules', modules), false)
  assert.equal(isIgnoredForSet('node_modules/@scope/pkg/index.js', modules), false)
  // Nested real node_modules (hoisted version conflicts) stay walkable.
  assert.equal(isIgnoredForSet('node_modules/pkg/node_modules/inner/index.js', modules), false)
  // Ordinary ignore rules still apply inside the set.
  assert.equal(isIgnoredForSet('node_modules/pkg/.bak-sync-x', modules), true)
  assert.equal(isIgnoredForSet('node_modules/pkg/.sync-tmp-1', modules), true)
  assert.equal(isIgnoredForSet('node_modules/pkg/conflicts/a', modules), true)
  assert.equal(isIgnoredForSet('node_modules/.modules.yaml', modules), true)
  // Every other set keeps blocking node_modules.
  assert.equal(isIgnoredForSet('node_modules/undici/index.js', byId.profile), true)
  assert.equal(isIgnoredForSet('node_modules/undici/index.js', byId.attachments), true)
})

test('paths: sets expose modes and profile include list', () => {
  const sets = buildSets({ home: 'C:/tmp/home', profile: 'desktop' })
  const byId = Object.fromEntries(sets.map((set) => [set.id, set]))
  assert.equal(byId.sessions.mode, 'append')
  assert.equal(byId.workspace.mode, 'merge-workspace')
  assert.equal(byId.profile.mode, 'profile')
  assert.equal(byId.profile.dereferencePluginLinks, true, 'plugin junction sources must be dereferenced')
  assert.ok(byId.profile.include.includes('cordis.patch.yml'))
  assert.ok(byId.profile.include.includes('plugins'))
  assert.equal(byId.credentials.mode, 'merge-credentials')
  assert.equal(byId.credentials.defaultEnabled, true)
  assert.deepEqual(byId.credentials.include, ['.credentials.yaml'])
  assert.equal(byId.credentials.allowNodeModules, undefined)
  assert.deepEqual(sets.map((set) => set.id), ['sessions', 'workspace', 'storages', 'profile', 'modules', 'credentials', 'attachments', 'cache'])
})

test('paths: joinInside refuses traversal and absolute paths', () => {
  const [set] = buildSets({ home: 'C:/tmp/home' })
  assert.equal(joinInside(set, '../etc/passwd'), null)
  assert.equal(joinInside(set, 'a/../../b'), null)
  assert.ok(joinInside(set, 'proj/session/session.v4.jsonl.zstd'))
  assert.equal(toRelative(set, set.root + '/x/y.txt').replace(/\\/g, '/'), 'x/y.txt')
  assert.equal(isInside('C:/a', 'C:/a-b'), false)
})

test('glob: include patterns select whole directories', () => {
  assert.equal(matches('plugins/a.js', 'plugins'), false)
  assert.equal(matchesInclude('plugins/a.js', ['plugins']), true)
  assert.equal(matchesInclude('plugins/deep/a.js', ['plugins']), true)
  assert.equal(matchesInclude('package.json', ['plugins', 'package.json']), true)
  assert.equal(matchesAny('x/node_modules/y.js', ['**/node_modules/**']), true)
})
