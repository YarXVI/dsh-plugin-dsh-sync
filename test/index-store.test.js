import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileIndex } from '../src/index-store.js'
import { buildSets } from '../src/paths.js'

const linkType = process.platform === 'win32' ? 'junction' : 'dir'

async function makeHome() {
  const home = await mkdtemp(join(tmpdir(), 'dsh-sync-index-'))
  const profileDir = join(home, 'profiles', 'desktop')
  await mkdir(join(profileDir, 'plugins', 'demo'), { recursive: true })
  await writeFile(join(profileDir, 'plugins', 'demo', 'package.json'), JSON.stringify({ name: 'demo', main: 'index.js' }))
  await writeFile(join(profileDir, 'plugins', 'demo', 'index.js'), 'export default 1\n')
  await mkdir(join(profileDir, 'node_modules', 'real', 'lib'), { recursive: true })
  await writeFile(join(profileDir, 'node_modules', 'real', 'index.js'), 'module.exports = 1\n')
  await writeFile(join(profileDir, 'node_modules', 'real', 'lib', 'util.js'), 'module.exports = 2\n')
  await mkdir(join(profileDir, 'node_modules', '@scope', 'pkg'), { recursive: true })
  await writeFile(join(profileDir, 'node_modules', '@scope', 'pkg', 'index.js'), 'module.exports = 3\n')
  // A junction is a link, not a copy: it must never be indexed/synced.
  await symlink(join(profileDir, 'plugins', 'demo'), join(profileDir, 'node_modules', 'demo'), linkType)
  return { home, profileDir }
}

test('index-store: the modules set indexes real packages but never junctions', async () => {
  const { home } = await makeHome()
  const modules = buildSets({ home, profile: 'desktop' }).find((set) => set.id === 'modules')
  const index = await new FileIndex({ stateDir: join(home, 'dsh-sync') }).load()
  await index.refresh(modules, { stableAfterMs: 0 })
  const rels = Object.keys(index.entries('modules')).sort()
  assert.ok(rels.includes('node_modules/real/index.js'))
  assert.ok(rels.includes('node_modules/real/lib/util.js'))
  assert.ok(rels.includes('node_modules/@scope/pkg/index.js'))
  assert.ok(!rels.some((rel) => rel.startsWith('node_modules/demo/')), 'a junction must not be walked into')
})

test('index-store: other sets still ignore node_modules entirely', async () => {
  const { home, profileDir } = await makeHome()
  const index = await new FileIndex({ stateDir: join(home, 'dsh-sync') }).load()
  await index.refresh({ id: 'profile', mode: 'lww', root: profileDir, include: ['node_modules'] }, { stableAfterMs: 0 })
  assert.deepEqual(Object.keys(index.entries('profile')), [])
})

test('index-store: files over maxFileBytes are not indexed', async () => {
  const { home, profileDir } = await makeHome()
  await writeFile(join(profileDir, 'node_modules', 'real', 'big.bin'), Buffer.alloc(4096))
  const modules = buildSets({ home, profile: 'desktop' }).find((set) => set.id === 'modules')
  const index = await new FileIndex({ stateDir: join(home, 'dsh-sync') }).load()
  await index.refresh(modules, { stableAfterMs: 0, maxFileBytes: 1024 })
  const rels = Object.keys(index.entries('modules'))
  assert.ok(!rels.includes('node_modules/real/big.bin'))
  assert.ok(rels.includes('node_modules/real/index.js'))
})

test('index-store: profile dereferences first-level plugin junctions only', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-sync-deref-'))
  const profileDir = join(home, 'profiles', 'desktop')
  await mkdir(join(profileDir, 'plugins'), { recursive: true })
  const checkout = join(home, 'checkout', 'dsh-x')
  await mkdir(join(checkout, 'lib'), { recursive: true })
  await writeFile(join(checkout, 'package.json'), JSON.stringify({ name: 'dsh-x', main: 'index.js' }))
  await writeFile(join(checkout, 'index.js'), 'export default 1\n')
  await writeFile(join(checkout, 'lib', 'util.js'), 'export const n = 1\n')
  // A nested link inside the target must NOT be followed.
  const nestedTarget = join(home, 'checkout', 'nested')
  await mkdir(nestedTarget, { recursive: true })
  await writeFile(join(nestedTarget, 'secret.js'), 'nope\n')
  await symlink(nestedTarget, join(checkout, 'linked'), linkType)
  await symlink(checkout, join(profileDir, 'plugins', 'dsh-x'), linkType)

  const profile = buildSets({ home, profile: 'desktop' }).find((set) => set.id === 'profile')
  const index = await new FileIndex({ stateDir: join(home, 'dsh-sync') }).load()
  await index.refresh(profile, { stableAfterMs: 0 })
  const rels = Object.keys(index.entries('profile')).sort()
  assert.ok(rels.includes('plugins/dsh-x/index.js'))
  assert.ok(rels.includes('plugins/dsh-x/lib/util.js'))
  assert.ok(!rels.some((rel) => rel.includes('linked')), 'nested links inside the target stay out')
  assert.ok(!rels.includes('plugins/dsh-x'), 'the junction itself is not a syncable path')

  // A set without the flag dereferences nothing.
  const other = { id: 'attachments', mode: 'lww', root: join(home, 'attachments') }
  const otherIndex = await new FileIndex({ stateDir: join(home, 'dsh-sync') }).load()
  await otherIndex.refresh(other, { stableAfterMs: 0 })
  assert.deepEqual(Object.keys(otherIndex.entries('attachments')), [])
})

test('index-store: ordinary *.bin resources are indexed, .bin shim dirs are not', async () => {
  const { home, profileDir } = await makeHome()
  const assets = join(profileDir, 'node_modules', '@liustack', 'modsearch', 'dist', 'assets')
  await mkdir(assets, { recursive: true })
  await writeFile(join(assets, 'tool.bin'), 'not a shim, just a resource\n')
  await mkdir(join(profileDir, 'node_modules', 'foo', '.bin'), { recursive: true })
  await writeFile(join(profileDir, 'node_modules', 'foo', '.bin', 'shim.js'), '#!/usr/bin/env node\n')
  await mkdir(join(profileDir, 'node_modules', '.bin'), { recursive: true })
  await writeFile(join(profileDir, 'node_modules', '.bin', 'top-shim'), '#!/usr/bin/env node\n')

  const modules = buildSets({ home, profile: 'desktop' }).find((set) => set.id === 'modules')
  const index = await new FileIndex({ stateDir: join(home, 'dsh-sync') }).load()
  await index.refresh(modules, { stableAfterMs: 0 })
  const rels = Object.keys(index.entries('modules'))
  assert.ok(rels.includes('node_modules/@liustack/modsearch/dist/assets/tool.bin'), 'a data file ending in .bin must sync')
  assert.ok(!rels.some((rel) => rel.includes('/.bin/')), 'files under any .bin shim directory must not sync')
  assert.ok(!rels.some((rel) => rel.startsWith('node_modules/.bin/')), 'top-level node_modules/.bin must not sync')
})
