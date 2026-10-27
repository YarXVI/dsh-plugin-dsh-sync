// Local availability probes for profile manifests.
//
// Why this exists: the profile set mirrors `profiles/<profile>/plugins/` but
// never `node_modules/`. Blindly unioning the peer's `dependencies` and
// `dsh.profile.bundles` therefore makes DSH show plugins that are not installed
// on this machine ("包不可用"). A remote-only entry only crosses over when this
// machine can actually load it.
//
// The probes are plain filesystem checks (injectable roots) so merge.js stays a
// pure module and the engine owns all IO.
import { existsSync, readFileSync, statSync } from 'node:fs'
import { delimiter, basename, dirname, isAbsolute, join, resolve } from 'node:path'

/** Extra package roots, `;`-separated (path.delimiter) — escape hatch for custom installs. */
export const BUNDLE_ROOTS_ENV = 'DSH_SYNC_BUNDLE_ROOTS'

// Entry points a package can expose. DSH loads a bundle through one of these;
// an installed directory without any of them is not loadable.
const ENTRY_FILES = ['index.js', 'index.mjs', 'index.cjs', 'cordis.patch.yml']
const ENTRY_FIELDS = ['exports', 'main', 'module']

/**
 * Candidate directories that hold installed packages for one profile.
 * Electron can read inside `app.asar`, so the packaged DSH install is a valid
 * root there; plain `node --test` simply skips the roots that do not exist.
 */
export function bundleRootsFor({
  profileDir,
  env = process.env,
  resourcesPath = typeof process !== 'undefined' ? process.resourcesPath : undefined,
  execPath = typeof process !== 'undefined' ? process.execPath : undefined,
} = {}) {
  const roots = []
  const add = (dir) => {
    if (!dir) return
    const abs = resolve(dir)
    if (!roots.includes(abs)) roots.push(abs)
  }
  if (profileDir) {
    const profile = resolve(profileDir)
    add(join(profile, 'node_modules'))
    // profiles/<profile> -> <DSH_HOME>
    add(join(profile, '..', '..', 'node_modules'))
  }
  for (const candidate of [resourcesPath, execPath ? dirname(resolve(execPath)) : '']) {
    if (!candidate) continue
    const resources = basename(resolve(candidate)) === 'resources' ? resolve(candidate) : join(resolve(candidate), 'resources')
    // Official bundles live inside the asar archive: resources/app.asar/dsh/node_modules.
    add(join(resources, 'app.asar', 'dsh', 'node_modules'))
    // Older / future layouts keep packages at the archive root or unpacked.
    add(join(resources, 'app.asar', 'node_modules'))
    add(join(resources, 'app.asar.unpacked', 'dsh', 'node_modules'))
  }
  const extra = String((env && env[BUNDLE_ROOTS_ENV]) || '')
  for (const part of extra.split(delimiter)) {
    const trimmed = part.trim()
    if (trimmed) add(trimmed)
  }
  return roots
}

/** True when a package.json exposes at least one entry point DSH could load. */
export function hasLoadableEntry(manifest, dir) {
  if (!manifest || typeof manifest !== 'object') return false
  for (const field of ENTRY_FIELDS) {
    const value = manifest[field]
    if (typeof value === 'string' ? value.trim() : value && typeof value === 'object') return true
  }
  return ENTRY_FILES.some((name) => existsSync(join(dir, name)))
}

/**
 * Build the resolver the engine hands to `mergePackageJson`.
 *
 * `resolveBundle(name)` answers "could this package be loaded here?" and
 * `linkTargetExists(spec)` answers "does a `link:`/`file:` target exist?".
 * Results are cached because a sync cycle asks the same questions repeatedly.
 * Pass `roots` explicitly to bypass the auto-detected list (tests do this).
 */
export function createBundleResolver({ profileDir = '', roots = null, extraRoots = [], env = process.env, resourcesPath = undefined, execPath = undefined } = {}) {
  const searchRoots = (Array.isArray(roots) ? roots : bundleRootsFor({ profileDir, env, resourcesPath, execPath }))
    .concat(Array.isArray(extraRoots) ? extraRoots : [])
    .map((root) => resolve(String(root)))
  const base = profileDir ? resolve(profileDir) : ''
  const bundleCache = new Map()
  const linkCache = new Map()

  function probe(name) {
    const key = String(name || '')
    if (bundleCache.has(key)) return bundleCache.get(key)
    let result = { ok: false, reason: 'not-installed' }
    const packageName = key.trim()
    if (!packageName || packageName.includes('..')) {
      result = { ok: false, reason: 'invalid-name' }
    } else {
      for (const root of searchRoots) {
        const dir = join(root, ...packageName.split('/'))
        let manifest
        try {
          manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
        } catch {
          continue
        }
        if (hasLoadableEntry(manifest, dir)) {
          result = { ok: true, dir, manifest }
          break
        }
      }
    }
    bundleCache.set(key, result)
    return result
  }

  return {
    profileDir: base,
    roots: searchRoots,
    /** True when the bundle package exists here and exposes a loadable entry. */
    resolveBundle(name) {
      return probe(name).ok
    },
    /** Same as resolveBundle but with the reason and resolved directory. */
    probeBundle(name) {
      return probe(name)
    },
    /**
     * `link:./plugins/x` / `file:../x` dependencies are only usable when the
     * target exists locally; registry specs (versions, `npm:`, tarballs, git)
     * are kept so a later `pnpm install` can fetch them.
     */
    linkTargetExists(spec) {
      const key = String(spec || '')
      if (linkCache.has(key)) return linkCache.get(key)
      const result = probeLink(key, base)
      linkCache.set(key, result)
      return result
    },
    clearCache() {
      bundleCache.clear()
      linkCache.clear()
    },
  }
}

function probeLink(spec, base) {
  const raw = String(spec || '').trim()
  const match = /^(link|file|portal|workspace):(.+)$/i.exec(raw)
  if (!match) return true // registry range, npm alias, git/tarball — installable later
  if (match[1].toLowerCase() === 'workspace') return true
  let target = match[2].trim().replace(/[?#].*$/, '')
  if (!target || /[*{}]/.test(target)) return true
  if (!isAbsolute(target)) {
    if (!base) return false
    target = resolve(base, target)
  }
  try {
    const st = statSync(target)
    return st.isDirectory() || st.isFile()
  } catch {
    return false
  }
}
