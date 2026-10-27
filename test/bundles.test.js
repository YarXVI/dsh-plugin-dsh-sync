import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BUNDLE_ROOTS_ENV, bundleRootsFor, createBundleResolver, hasLoadableEntry } from '../src/bundles.js'

async function makeProfile() {
  const home = await mkdtemp(join(tmpdir(), 'dsh-sync-bundles-'))
  const profileDir = join(home, 'profiles', 'desktop')
  await mkdir(join(profileDir, 'node_modules'), { recursive: true })
  return { home, profileDir }
}

async function installPackage(profileDir, name, manifest, files = {}) {
  const dir = join(profileDir, 'node_modules', ...name.split('/'))
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name, ...manifest }, null, 2))
  for (const [file, body] of Object.entries(files)) await writeFile(join(dir, file), body)
  return dir
}

test('bundles: only packages with a loadable entry count as installed', async () => {
  const { profileDir } = await makeProfile()
  await installPackage(profileDir, 'dsh-npu', { main: 'index.js' }, { 'index.js': 'export default 1\n' })
  await installPackage(profileDir, '@scope/with-exports', { exports: './index.js' })
  await installPackage(profileDir, 'dsh-empty', {}) // no exports/main/index.js
  const resolver = createBundleResolver({ profileDir })
  assert.equal(resolver.resolveBundle('dsh-npu'), true)
  assert.equal(resolver.resolveBundle('@scope/with-exports'), true)
  assert.equal(resolver.resolveBundle('dsh-empty'), false)
  assert.equal(resolver.resolveBundle('dsh-not-installed'), false)
  assert.equal(resolver.probeBundle('dsh-not-installed').reason, 'not-installed')
  assert.equal(hasLoadableEntry({}, profileDir), false)
})

test('bundles: link and file specs are only usable when the target exists', async () => {
  const { profileDir } = await makeProfile()
  await mkdir(join(profileDir, 'plugins', 'qqbot'), { recursive: true })
  const resolver = createBundleResolver({ profileDir })
  assert.equal(resolver.linkTargetExists('link:./plugins/qqbot'), true)
  assert.equal(resolver.linkTargetExists('link:./plugins/dsh-npu'), false)
  assert.equal(resolver.linkTargetExists('file:./plugins/qqbot'), true)
  assert.equal(resolver.linkTargetExists('file:./plugins/missing'), false)
  // Registry versions, npm aliases and git/tarball specs stay adoptable.
  assert.equal(resolver.linkTargetExists('5.10.10'), true)
  assert.equal(resolver.linkTargetExists('^1.2.0'), true)
  assert.equal(resolver.linkTargetExists('workspace:*'), true)
  assert.equal(resolver.linkTargetExists('npm:other@1.0.0'), true)
})

test('bundles: official DSH bundles inside app.asar/dsh/node_modules are resolvable', async () => {
  const { home, profileDir } = await makeProfile()
  const resources = join(home, 'DeepSeek', 'resources')
  const official = join(resources, 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-base')
  await mkdir(official, { recursive: true })
  await writeFile(join(official, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-base', main: 'index.js' }))

  const roots = bundleRootsFor({ profileDir, env: {}, resourcesPath: resources, execPath: undefined })
  assert.ok(roots.includes(join(resources, 'app.asar', 'dsh', 'node_modules')), 'asar layout is resources/app.asar/dsh/node_modules')
  assert.ok(roots.includes(join(resources, 'app.asar', 'node_modules')), 'archive-root layout stays supported')
  assert.ok(roots.includes(join(resources, 'app.asar.unpacked', 'dsh', 'node_modules')))

  const resolver = createBundleResolver({ profileDir, env: {}, resourcesPath: resources })
  assert.equal(resolver.resolveBundle('@deepseek-ai/dsh-base'), true, 'bundles shipped inside the asar must count as installed')
})

test('bundles: roots include the profile node_modules and env overrides', async () => {
  const { home, profileDir } = await makeProfile()
  const env = { [BUNDLE_ROOTS_ENV]: join(home, 'extra-root') }
  const roots = bundleRootsFor({ profileDir, env, resourcesPath: undefined, execPath: undefined })
  assert.ok(roots.includes(join(profileDir, 'node_modules')))
  assert.ok(roots.includes(join(home, 'extra-root')), 'env roots must be searchable')

  const extra = join(home, 'extra-root', 'dsh-extra')
  await mkdir(extra, { recursive: true })
  await writeFile(join(extra, 'package.json'), JSON.stringify({ name: 'dsh-extra', main: 'index.js' }))
  const resolver = createBundleResolver({ profileDir, env })
  assert.equal(resolver.resolveBundle('dsh-extra'), true)
})
