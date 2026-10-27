#!/usr/bin/env node
// Install this bundle into a DSH profile without plugin_manager.
//
//   node scripts/install-profile.mjs [--profile desktop] [--link] [--dry-run]
//
// Steps: copy/link the package into <profile>/plugins, register it in
// package.json (dependency + dsh.profile.bundles), link node_modules, and keep
// a .bak-sync-install-* backup of package.json. The DSH application must be
// restarted afterwards.
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const packageDir = resolve(here, '..')
const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const value = (name, fallback) => {
  const index = args.indexOf(name)
  if (index < 0) return fallback
  return args[index + 1] || fallback
}

const dryRun = flag('--dry-run')
const link = flag('--link')
const profile = value('--profile', process.env.DSH_PROFILE || 'desktop')
const home = resolve(process.env.DSH_HOME?.trim() || join(homedir(), '.dsh'))
const profileDir = join(home, 'profiles', profile)
const pluginTarget = join(profileDir, 'plugins', 'dsh-plugin-dsh-sync')
const packageJsonPath = join(profileDir, 'package.json')
const nodeModulesLink = join(profileDir, 'node_modules', 'dsh-plugin-dsh-sync')
const NAME = 'dsh-plugin-dsh-sync'
const DEP = 'link:./plugins/dsh-plugin-dsh-sync'

function log(...items) {
  console.log('[install]', ...items)
}

async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true })
}

async function exists(path) {
  try { await fsp.access(path); return true } catch { return false }
}

async function copyTree(from, to) {
  await fsp.rm(to, { recursive: true, force: true })
  await fsp.cp(from, to, {
    recursive: true,
    filter: (source) => !source.includes('node_modules') && !source.includes(`${join(from, '_ref')}`) && !source.endsWith('_debug-engine.mjs'),
  })
}

async function main() {
  if (!(await exists(profileDir))) {
    throw new Error(`profile not found: ${profileDir}`)
  }
  log(`source:  ${packageDir}`)
  log(`profile: ${profileDir}${dryRun ? ' (dry run)' : ''}`)

  const raw = JSON.parse(await fsp.readFile(packageJsonPath, 'utf8'))
  const before = JSON.stringify(raw, null, 2)
  raw.dependencies ||= {}
  raw.dependencies[NAME] = DEP
  raw.dsh ||= {}
  raw.dsh.profile ||= {}
  raw.dsh.profile.bundles ||= []
  if (!raw.dsh.profile.bundles.includes(NAME)) raw.dsh.profile.bundles.push(NAME)
  const after = JSON.stringify(raw, null, 2) + '\n'

  if (dryRun) {
    log('would write package.json:')
    console.log(after)
    return
  }

  if (await exists(packageJsonPath)) {
    const backup = `${packageJsonPath}.bak-sync-install-${new Date().toISOString().replace(/[:.]/g, '-')}`
    await fsp.copyFile(packageJsonPath, backup)
    log('backup:', backup)
  }

  await ensureDir(dirname(pluginTarget))
  if (link) {
    await fsp.rm(pluginTarget, { recursive: true, force: true })
    await fsp.symlink(packageDir, pluginTarget, 'junction')
    log('linked:', pluginTarget)
  } else {
    await copyTree(packageDir, pluginTarget)
    log('copied:', pluginTarget)
  }

  await fsp.writeFile(packageJsonPath, after)
  log('package.json updated (dependency + bundle)')

  await ensureDir(dirname(nodeModulesLink))
  await fsp.rm(nodeModulesLink, { recursive: true, force: true })
  await fsp.symlink(join('..', 'plugins', NAME), nodeModulesLink, 'junction')
  log('node_modules link:', nodeModulesLink)

  log('')
  log('done. Restart DeepSeek Harness, then open 设备同步 in the left sidebar.')
  log(`if pnpm reports missing links later, run: dsh plugin --profile ${profile} install`)
}

main().catch((error) => {
  console.error('[install] failed:', error.message)
  process.exit(1)
})
