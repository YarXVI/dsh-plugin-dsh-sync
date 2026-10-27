// Sync engine: discovery, pairing, reconciliation and merging.
//
// Pull-based mesh: every device periodically asks each paired peer for a
// manifest of every enabled set, then decides per file with the same pure
// rules (see merge.js) so both sides converge without a coordinator.
import { EventEmitter } from 'node:events'
import fs from 'node:fs/promises'
import { networkInterfaces } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { deriveSharedSecret, sasCode, sha256hex } from './crypto.js'
import { Discovery, parseSeed } from './discovery.js'
import { PeerClient, SyncServer } from './transport.js'
import { FileIndex } from './index-store.js'
import { Journal } from './journal.js'
import { Tombstones } from './tombstones.js'
import { buildSets, isIgnored, isIgnoredForSet, isInside, joinInside } from './paths.js'
import { matchesAny, matchesInclude } from './glob.js'
import { createBundleResolver } from './bundles.js'
import {
  appendBytes,
  ensureDir,
  hashFileStream,
  listFiles,
  prefixEquals,
  readJsonDetailed,
  statSafe,
  writeAtomic,
  writeJson,
} from './fsutil.js'
import { CONFLICT, EQUAL, MERGE, PULL, SKIP, conflictName, decide, mergePackageJson, mergeWorkspace } from './merge.js'
import { mergeModelBlocks, modelBlockNames } from './modelconfig.js'
import { mergeCredentialRefs } from './credentials.js'

export const DEFAULTS = {
  enabled: true,
  autoStart: true,
  intervalMs: 15000,
  stableAfterMs: 2000,
  discovery: true,
  discoveryPort: 47821,
  seeds: [],
  listenPort: 0,
  deviceName: '',
  group: '',
  sets: null,
  maxBlobBytes: 48 * 1024 * 1024,
  sessionMaxBytes: 96 * 1024 * 1024,
  keepBackups: true,
  propagateDeletes: true,
  debug: false,
  bundleRoots: null,
  repairProfile: true,
  maxModulesBytes: 256 * 1024 * 1024,
  mergeModelConfig: true,
  // Extension RPCs (`ext.*`, served by the dshSync broker) are denied unless
  // explicitly whitelisted here: op names, prefixes ending in `*`, or `*`.
  extRpcAllow: [],
  // Master kill switch: when true, even plugin-declared (`allow: true`) ext ops
  // are refused — one switch for a user who wants the channel fully closed.
  extRpcDisableAll: false,
}

const CONFLICT_FILE = 'conflicts.json'
const CLEANUP_FILE = 'cleanup.json'
const SETTINGS_FILE = 'sync-settings.json'
const MANUAL_FILE = 'manual-peers.json'
const PUSH_GUARD_FILE = 'push-guard.json'
const RECYCLE_DIR = 'recycle'
const CONFLICT_DIR = 'conflicts'
const MAX_LOGS = 200
const MAX_CONFLICTS = 200
const MAX_CLEANUP_RECORDS = 500
// The four retention choices the panel offers. 0 means "delete everything that
// is not explicitly kept".
const RETENTION_DAYS = new Set([0, 7, 30, 45, 90])
const MAX_PREVIEW_FILES = 200
const MAX_CATALOG_ITEMS = 300
// Engine-scheduled cycles are the automatic triggers the realtime switch gates.
// Explicit calls from the panel or from tools (tests) run regardless, and the
// pull/push paths below bypass cycles entirely.
const AUTO_CYCLE_REASONS = new Set(['interval', 'startup', 'peer-discovered', 'paired', 'sets', 'pending', 'enabled', 'manual-peer'])
// Sets that existed before set-file versioning. Everything else is "new" and is
// auto-enabled during migration when the profile set (its reason to exist) is on.
const LEGACY_SET_IDS = new Set(['sessions', 'workspace', 'storages', 'profile', 'attachments', 'cache'])
// Version in which each non-legacy set was introduced, so a v1 file enables
// `modules` and a v2 file enables `credentials` without losing explicit choices.
const SET_INTRODUCED = { modules: 2, credentials: 3 }
const SETS_VERSION = 3

// Machine-owned configuration: a peer copy is parked, never applied over the
// local file. `package.json` is different: its dependency and bundle lists are
// additive, handled separately.
const PROTECTED_PROFILE_FILES = new Set(['cordis.patch.yml', 'cordis.yml', 'pnpm-workspace.yaml'])

/** `link:` / `file:` / `portal:` spec -> target path, or null for registry specs. */
function linkTargetOf(spec, profileDir) {
  const match = /^(link|file|portal|workspace):(.+)$/i.exec(String(spec || '').trim())
  if (!match) return null
  if (match[1].toLowerCase() === 'workspace') return null
  let target = match[2].trim().replace(/[?#].*$/, '')
  if (!target || /[*{}]/.test(target)) return null
  if (!isAbsolute(target)) target = resolve(profileDir, target)
  return resolve(target)
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/** Small helper so panel actions can map engine refusals onto HTTP statuses. */
function refusal(code, message) {
  return Object.assign(new Error(message), { code })
}

/** Fresh `sync-settings.json` value; also the migration baseline for old users. */
function defaultSyncSettings() {
  return {
    version: 1,
    role: 'host',
    roleLocked: false,
    realtime: false,
    localOnlyExcluded: false,
    shadowWorkspace: { enabled: false },
    peerRoles: {},
    cleanup: { enabled: true, retentionDays: 7, backups: true, backupDays: 45, recycle: true, recycleMax: 100 },
    sets: {},
  }
}

function normalizeRole(value) {
  return value === 'sub' ? 'sub' : 'host'
}

function normalizePeerRoles(value) {
  const out = {}
  if (!isPlainObject(value)) return out
  for (const [deviceId, role] of Object.entries(value)) {
    if (!deviceId || (role !== 'host' && role !== 'sub')) continue
    out[String(deviceId)] = role
  }
  return out
}

function normalizeInt(value, { min, max, fallback }) {
  const number = Number(value)
  if (!Number.isInteger(number) || number < min || number > max) return fallback
  return number
}

/** Merge a persisted settings document with the defaults, rejecting bad values. */
function normalizeSettings(value) {
  const base = defaultSyncSettings()
  if (!isPlainObject(value)) return base
  const cleanup = isPlainObject(value.cleanup) ? value.cleanup : {}
  const sets = {}
  if (isPlainObject(value.sets)) {
    for (const [setId, entry] of Object.entries(value.sets)) {
      if (!isPlainObject(entry) || !Array.isArray(entry.items)) continue
      sets[String(setId)] = { items: entry.items.map(String) }
    }
  }
  const retentionDays = Number(cleanup.retentionDays)
  return {
    version: 1,
    role: normalizeRole(value.role),
    roleLocked: value.roleLocked === true,
    realtime: value.realtime === true,
    localOnlyExcluded: value.localOnlyExcluded === true,
    shadowWorkspace: {
      enabled: isPlainObject(value.shadowWorkspace) && value.shadowWorkspace.enabled === true,
    },
    peerRoles: normalizePeerRoles(value.peerRoles),
    cleanup: {
      enabled: cleanup.enabled !== false,
      retentionDays: RETENTION_DAYS.has(retentionDays) ? retentionDays : base.cleanup.retentionDays,
      backups: cleanup.backups !== false,
      backupDays: normalizeInt(cleanup.backupDays, { min: 1, max: 3650, fallback: base.cleanup.backupDays }),
      recycle: cleanup.recycle !== false,
      recycleMax: normalizeInt(cleanup.recycleMax, { min: 1, max: 1000, fallback: base.cleanup.recycleMax }),
    },
    sets,
  }
}

/**
 * Give every conflict a stable record shape. Legacy entries only had `at`; the
 * deterministic id keeps panel selections and "keep" flags stable across
 * restarts even before the record is rewritten once.
 */
function normalizeConflictRecord(item) {
  if (!isPlainObject(item)) return null
  const createdAt = item.createdAt || item.at || new Date().toISOString()
  const key = [item.kind, item.set, item.rel, item.peer, item.hash, item.item].join('|')
  return {
    ...item,
    id: item.id || 'c-' + sha256hex(key).slice(0, 12),
    createdAt,
    lastAccessAt: item.lastAccessAt || createdAt,
    keep: item.keep === true,
    size: Math.max(0, Number(item.size ?? item.bytes ?? 0) || 0),
  }
}

/** Normalize a set-relative path for item id comparison. */
function itemPath(rel) {
  return String(rel || '').replace(/\\/g, '/')
}

// Parked conflict copies produced by `merge.conflictName()`:
//   `<rel>.conflict-<peer8>-<ISO stamp>`  (non-session)
// The second pattern also accepts simpler `<token>-<epoch ms>` variants.
const CONFLICT_COPY_RE = /\.conflict-[A-Za-z0-9]{2,12}-\d{10,16}$/
const CONFLICT_COPY_STAMP_RE = /\.conflict-[A-Za-z0-9]{2,12}-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/
// Sync backups: `<file>.bak-sync-<peer6>-<epoch>`,
// `<file>.bak-sync-deleted-<peer6>-<epoch>` and `.bak-sync-<syncStamp>`.
const BACKUP_FILE_RE = /\.bak-sync-(?:deleted-)?[A-Za-z0-9-]*\d{8,}$/

function isConflictCopyName(name) {
  const value = String(name || '')
  return CONFLICT_COPY_RE.test(value) || CONFLICT_COPY_STAMP_RE.test(value)
}

function isBackupFileName(name) {
  return BACKUP_FILE_RE.test(String(name || ''))
}

/**
 * Aggregate one set-relative file into its item id.
 * sessions -> one item per `<project>/<session>`; profile -> `plugins/<name>`
 * prefixes plus root files; modules -> `node_modules/<pkg>`; other sets -> rel.
 */
function catalogItemFor(setId, relRaw) {
  const rel = itemPath(relRaw)
  if (setId === 'sessions') {
    const parts = rel.split('/')
    if (parts.length >= 2) {
      const id = parts.slice(0, 2).join('/')
      return { id, label: id, group: parts[0] }
    }
    return { id: rel, label: rel }
  }
  if (setId === 'profile') {
    if (rel.startsWith('plugins/')) {
      const parts = rel.split('/')
      let name = parts[1] || ''
      if (name.startsWith('@') && parts[2]) name += '/' + parts[2]
      if (!name) return null
      return { id: 'plugins/' + name, label: name, group: 'plugins' }
    }
    return { id: rel, label: rel.split('/').pop() || rel, group: 'root' }
  }
  if (setId === 'modules') {
    const parts = rel.split('/')
    if (parts[0] !== 'node_modules' || parts.length < 2) return null
    let name = parts[1]
    if (name.startsWith('@') && parts[2]) name += '/' + parts[2]
    return { id: 'node_modules/' + name, label: name, group: 'node_modules' }
  }
  return { id: rel, label: rel }
}

function sortPreviewFiles(files) {
  return files.sort((a, b) => (a.set === b.set ? a.rel.localeCompare(b.rel) : a.set.localeCompare(b.set)))
}

function summarizePreviewFiles(files) {
  const limited = sortPreviewFiles(files).slice(0, MAX_PREVIEW_FILES)
  return {
    files: limited,
    count: limited.length,
    bytes: limited.reduce((sum, file) => sum + (Number(file.size) || 0), 0),
  }
}

/**
 * True when a set would index this relative path.
 *
 * `joinInside()` only proves "below the set root", but some set roots are broad
 * (`credentials` is `$DSH_HOME`, `modules` and `profile` share the profile
 * directory), so a paired peer must not be able to address arbitrary files via
 * RPC. The same include/exclude/ignore rules used by the index decide.
 */
function setAllowsRel(set, relPath) {
  const rel = String(relPath || '').replace(/\\/g, '/')
  if (!rel) return false
  if (/^[a-zA-Z]:/.test(rel) || rel.startsWith('//')) return false
  const parts = rel.split('/').filter((part) => part && part !== '.')
  if (!parts.length || parts.includes('..')) return false
  if (isIgnoredForSet(rel, set)) return false
  if (set.include && !matchesInclude(rel, set.include)) return false
  if (set.exclude && matchesAny(rel, set.exclude)) return false
  return true
}

export class SyncEngine extends EventEmitter {
  constructor({ home, profile, stateDir, identity, config = {}, logger = null, accountId = null, hooks = {} }) {
    super()
    this.home = home
    this.profile = profile
    this.stateDir = stateDir
    this.identity = identity
    this.config = { ...DEFAULTS, ...config }
    this.logger = logger
    this.accountId = accountId
    this.hooks = hooks || {}
    this.sets = buildSets({ home, profile, sets: this.config.sets })
    this.index = null
    this.journal = null
    this.tombstones = null
    this.server = null
    this.discovery = null
    this.timer = null
    this.cleanupTimer = null
    this.cleanupFirstTimer = null
    this.running = false
    this.busy = false
    this.startedAt = null
    this.port = 0
    this.lastCycle = null
    this.currentCyclePromise = null
    this.progress = null
    this.pushEnabled = false
    this.settings = defaultSyncSettings()
    this.changesPreview = null
    this.recycleCount = 0
    this.peerState = new Map()
    this.logs = []
    this.conflicts = []
    this.manualPeers = []
    this.lastError = null
    this.bundleResolver = null
    this.extRpcHandler = null
  }

  /**
   * Install the extension-RPC dispatcher (the dshSync broker provides it).
   * Only `ext.*` ops reach it; built-in ops are handled before the hook.
   * Returns a dispose function so a reloaded plugin can unhook cleanly.
   */
  setExtRpcHandler(handler) {
    this.extRpcHandler = typeof handler === 'function' ? handler : null
    if (typeof handler !== 'function') return () => {}
    return () => {
      if (this.extRpcHandler === handler) this.extRpcHandler = null
    }
  }

  enabledSets() {
    return this.sets.filter((set) => set.enabled)
  }

  stableAfterMs() {
    const value = Number(this.config.stableAfterMs)
    return Number.isFinite(value) ? Math.max(0, value) : 2000
  }

  profileDir() {
    return join(this.home, 'profiles', this.profile)
  }

  /**
   * Local availability probe used to filter what the peer's package.json may
   * add. Cached for the engine lifetime: a newly installed plugin is picked up
   * after a restart or via `bundleResolver.clearCache()`.
   */
  profileBundleResolver() {
    if (this.bundleResolver) return this.bundleResolver
    this.bundleResolver = this.hooks.bundleResolver || createBundleResolver({
      profileDir: this.profileDir(),
      roots: Array.isArray(this.config.bundleRoots) ? this.config.bundleRoots : null,
    })
    return this.bundleResolver
  }

  setById(id) {
    const set = this.sets.find((item) => item.id === id)
    if (!set || !set.enabled) return null
    return set
  }

  /**
   * Configured per-item scope for a set: `null` when everything is selected
   * (never configured), otherwise the selected item ids. `credentials` is
   * always set-level and never scoped.
   */
  itemScope(setId) {
    if (setId === 'credentials') return null
    const entry = this.settings.sets?.[setId]
    if (!entry || !Array.isArray(entry.items)) return null
    return entry.items
  }

  /** True when `rel` is inside the selected items of its set. */
  itemAllowed(set, rel) {
    const items = this.itemScope(set.id)
    if (items === null) return true
    const path = itemPath(rel)
    return items.some((id) => path === id || path.startsWith(id + '/'))
  }

  /**
   * True only when an explicit item covers `rel`. Used by the local-only rule:
   * "all selected" must not count as a manual choice.
   */
  itemExplicitlySelected(set, rel) {
    const items = this.itemScope(set.id)
    if (items === null) return false
    const path = itemPath(rel)
    return items.some((id) => path === id || path.startsWith(id + '/'))
  }

  /** Entries of a set filtered by the item scope (manifest, deletes, previews). */
  filterSetEntries(set, entries) {
    if (this.itemScope(set.id) === null) return entries || {}
    const out = {}
    for (const [rel, entry] of Object.entries(entries || {})) {
      if (!this.itemAllowed(set, rel)) continue
      out[rel] = entry
    }
    return out
  }

  /**
   * Local, network-free profile self-healing (0.4.3).
   *
   * Plugin *sources* sync through the `profile` set and packages through the
   * `modules` set, but a `link:` dependency still needs a `node_modules/<name>`
   * junction on this machine. This method creates/repoints those junctions from
   * local sources only (never from a peer's absolute path), re-adds bundles for
   * linked plugins, and prunes declarations this machine cannot load so DSH
   * stops showing "包不可用". It is idempotent: nothing is written when nothing
   * changed.
   */
  async repairLocalProfile({ now = Date.now() } = {}) {
    if (this.config.repairProfile === false) return { changed: false, skipped: 'disabled' }
    const profileSet = this.setById('profile')
    if (!profileSet) return { changed: false, skipped: 'profile-disabled' }
    const profileDir = this.profileDir()
    const abs = join(profileDir, 'package.json')
    const buf = await fs.readFile(abs).catch(() => null)
    if (!buf) return { changed: false, skipped: 'missing' }
    let pkg
    try {
      pkg = JSON.parse(buf.toString('utf8'))
    } catch {
      // The file may be the user's only copy: never rewrite what we cannot parse.
      this.log('warn', 'profile/package.json is not valid JSON; skipping profile repair')
      return { changed: false, error: 'invalid-json' }
    }
    if (!isPlainObject(pkg)) return { changed: false, error: 'invalid-shape' }

    const nodeModules = join(profileDir, 'node_modules')
    const deps = []
    const seen = new Set()
    for (const field of ['dependencies', 'devDependencies']) {
      if (!isPlainObject(pkg[field])) continue
      for (const [name, spec] of Object.entries(pkg[field])) {
        if (seen.has(name)) continue
        seen.add(name)
        deps.push({ name, spec })
      }
    }

    // Plugin sources that arrived as real directories (or were checked out by
    // hand) must get their `link:` declaration back, otherwise DSH never loads
    // them after the peer's copy lands.
    let depsAdded = 0
    for (const name of await listPluginSourceNames(profileDir)) {
      if (seen.has(name)) continue
      seen.add(name)
      if (!isPlainObject(pkg.dependencies)) pkg.dependencies = {}
      pkg.dependencies[name] = `link:./plugins/${name}`
      deps.push({ name, spec: `link:./plugins/${name}` })
      depsAdded++
    }

    let linksCreated = 0
    let linksPruned = 0
    let depsPruned = 0
    let bundlesAdded = 0
    let bundlesPruned = 0
    const linkedPackages = []

    for (const { name, spec } of deps) {
      const target = linkTargetOf(spec, profileDir)
      // Only manage links whose target lives inside this profile: a peer's
      // absolute path must never become a junction target here.
      if (!target || !isInside(profileDir, target)) continue
      const dest = join(nodeModules, ...name.split('/'))
      const existing = await lstatSafe(dest)
      const targetStat = await statKind(target)
      if (targetStat === 'dir' || targetStat === 'file') {
        if (existing?.isSymbolicLink()) {
          const current = await fs.readlink(dest).catch(() => null)
          // Accept a link that already resolves to the same physical directory:
          // pnpm may have pointed it straight at an out-of-profile source.
          if (current && await sameTarget(current, target)) {
            linkedPackages.push(name)
            continue
          }
          await removeLinkOnly(dest)
          if (await createLink(target, dest)) linksCreated++
          linkedPackages.push(name)
          continue
        }
        if (existing) {
          // A real directory is already there: never delete it, just use it.
          linkedPackages.push(name)
          continue
        }
        if (await createLink(target, dest)) linksCreated++
        linkedPackages.push(name)
        continue
      }
      // Target missing: drop the stale link (link only, never the directory).
      if (existing?.isSymbolicLink()) {
        await removeLinkOnly(dest)
        linksPruned++
        await this.addConflict({
          kind: 'link-pruned',
          set: 'profile',
          rel: `node_modules/${name}`,
          peer: this.identity.deviceId,
          at: new Date().toISOString(),
          note: `本机没有 ${name} 的插件源码，已移除 node_modules 链接；安装后可再次同步`,
        })
      }
      for (const field of ['dependencies', 'devDependencies']) {
        if (isPlainObject(pkg[field]) && name in pkg[field]) {
          delete pkg[field][name]
          depsPruned++
        }
      }
      await this.addConflict({
        kind: 'link-pruned',
        set: 'profile',
        rel: `package.json#${name}`,
        peer: this.identity.deviceId,
        at: new Date().toISOString(),
        note: `本机没有 ${name} 的插件源码，已从依赖中移除；安装后可再次同步`,
      })
    }

    const dsh = isPlainObject(pkg.dsh) ? pkg.dsh : null
    const profileSection = dsh && isPlainObject(dsh.profile) ? dsh.profile : null
    let bundles = profileSection && Array.isArray(profileSection.bundles) ? [...profileSection.bundles] : []
    // Links may have just been created, so re-probe the package roots.
    const resolver = this.profileBundleResolver()
    resolver.clearCache()

    for (const name of linkedPackages) {
      if (bundles.includes(name)) continue
      if (!resolver.resolveBundle(name)) continue
      bundles.push(name)
      bundlesAdded++
    }

    const kept = []
    for (const name of bundles) {
      if (typeof name !== 'string' || !name) continue
      if (name.startsWith('@deepseek-ai/')) {
        // Bundles shipped inside the DSH install cannot be verified from a plain
        // node process; keeping them is the safe choice.
        kept.push(name)
        continue
      }
      if (resolver.resolveBundle(name)) {
        kept.push(name)
        continue
      }
      if (await pluginSourceExists(profileDir, name)) {
        kept.push(name)
        continue
      }
      bundlesPruned++
      await this.addConflict({
        kind: 'bundle-pruned',
        set: 'profile',
        rel: 'package.json',
        item: name,
        peer: this.identity.deviceId,
        at: new Date().toISOString(),
        note: `本机没有该插件（${name}），已从清单移除；安装后可再次同步`,
      })
    }

    const bundlesChanged = bundlesAdded || bundlesPruned
    if (!linksCreated && !linksPruned && !depsPruned && !depsAdded && !bundlesChanged) {
      return { changed: false, linksCreated: 0, linksPruned: 0, depsPruned: 0, depsAdded: 0, bundlesAdded: 0, bundlesPruned: 0 }
    }

    if (bundlesChanged) {
      if (!dsh) pkg.dsh = {}
      if (!isPlainObject(pkg.dsh)) pkg.dsh = {}
      if (!isPlainObject(pkg.dsh.profile)) pkg.dsh.profile = {}
      pkg.dsh.profile.bundles = kept
    }

    const serialized = JSON.stringify(pkg, null, 2) + '\n'
    if (serialized === buf.toString('utf8')) {
      return { changed: false, linksCreated, linksPruned, depsPruned, depsAdded, bundlesAdded, bundlesPruned }
    }
    const backup = `${abs}.bak-prune-${syncStamp(now)}`
    try { await fs.copyFile(abs, backup) } catch {}
    await writeAtomic(abs, serialized)
    const written = await fs.readFile(abs)
    this.index.put('profile', 'package.json', {
      size: written.length,
      mtimeMs: Math.round((await statSafe(abs))?.mtimeMs || Date.now()),
      hash: sha256hex(written),
    })
    this.log('info', `profile repaired: +${linksCreated} links, +${depsAdded} deps, ${linksPruned} stale links, ${depsPruned} stale deps, +${bundlesAdded}/-${bundlesPruned} bundles (restart DSH to apply)`)
    this.emit('status')
    return { changed: true, linksCreated, linksPruned, depsPruned, depsAdded, bundlesAdded, bundlesPruned, backup }
  }

  async start() {
    if (this.running) return this.state()
    await ensureDir(this.stateDir)
    this.index = await new FileIndex({ stateDir: this.stateDir, logger: this.logger }).load()
    this.journal = new Journal({ stateDir: this.stateDir, logger: this.logger })
    this.tombstones = await new Tombstones({ stateDir: this.stateDir, logger: this.logger }).load()
    await this.loadSets()
    await this.loadConflicts()
    await this.loadCleanup()
    await this.loadManualPeers()
    await this.loadPushGuard()
    await this.loadSettings()

    this.server = new SyncServer({
      identity: this.identity,
      logger: this.logger,
      port: Number(this.config.listenPort) || 0,
      handler: (request, context) => this.handleRpc(request, context),
    })
    this.port = await this.server.start()
    this.log('info', `sync server listening on 0.0.0.0:${this.port}`)

    this.discovery = new Discovery({
      deviceId: this.identity.deviceId,
      name: this.identity.name,
      group: this.identity.groupId,
      port: this.port,
      discoveryPort: Number(this.config.discoveryPort) || 47821,
      seeds: this.config.seeds || [],
      logger: this.logger,
      enabled: this.config.discovery !== false,
    })
    this.discovery.on('peer', (peer) => {
      this.emit('peer', peer)
      this.scheduleCycle('peer-discovered')
    })
    this.discovery.on('peer-lost', (peer) => this.emit('peer-lost', peer))
    await this.discovery.start()

    this.running = true
    this.startedAt = new Date().toISOString()
    if (this.config.autoCycle !== false) {
      this.timer = setInterval(() => this.scheduleCycle('interval'), Math.max(3000, Number(this.config.intervalMs) || 15000))
      this.timer.unref?.()
      setTimeout(() => this.scheduleCycle('startup'), 600).unref?.()
      // Conflict-copy retention runs on its own slow clock. `autoCycle: false`
      // (used by tests and embedded tools) keeps the engine timer-free.
      if (this.settings.cleanup.enabled) this.scheduleCleanupTimer()
    }
    this.emit('status')
    return this.state()
  }

  async stop() {
    this.running = false
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.stopCleanupTimer()
    try { this.discovery?.stop() } catch {}
    try { await this.server?.stop() } catch {}
    try { await this.index?.save() } catch {}
    try { await this.journal?.flush() } catch {}
    this.emit('status')
  }

  /**
   * Automatic conflict-copy retention: one first pass shortly after boot, then
   * every six hours. Both timers are unref'd so they never keep the process
   * alive; `stop()` clears them.
   */
  scheduleCleanupTimer() {
    if (this.cleanupTimer || this.config.autoCycle === false) return
    this.cleanupTimer = setInterval(() => { this.runAutoCleanup() }, 6 * 60 * 60 * 1000)
    this.cleanupTimer.unref?.()
    this.cleanupFirstTimer = setTimeout(() => { this.runAutoCleanup() }, 10_000)
    this.cleanupFirstTimer.unref?.()
  }

  stopCleanupTimer() {
    if (this.cleanupFirstTimer) clearTimeout(this.cleanupFirstTimer)
    if (this.cleanupTimer) clearInterval(this.cleanupTimer)
    this.cleanupFirstTimer = null
    this.cleanupTimer = null
  }

  async runAutoCleanup() {
    if (!this.running) return
    try {
      await this.cleanupNow()
    } catch (error) {
      this.log('warn', `automatic cleanup failed: ${error.message}`)
    }
  }

  scheduleCycle(reason) {
    if (!this.running || !this.config.enabled) return
    if (this.config.autoCycle === false && reason !== 'manual') return
    if (this.busy) {
      this.pendingCycle = true
      return
    }
    this.cycle(reason).catch((error) => {
      this.lastError = String(error?.message || error)
      this.log('error', 'cycle failed: ' + this.lastError)
    })
  }

  /**
   * Run one reconciliation cycle, or join the one already in flight.
   * Joining matters for the panel: a manual "sync now" must wait for the
   * running cycle instead of returning immediately while transfers continue.
   */
  async cycle(reason = 'manual') {
    if (!this.running) return this.lastCycle
    if (this.currentCyclePromise) return this.currentCyclePromise
    const promise = this.runCycle(reason).finally(() => {
      this.currentCyclePromise = null
    })
    this.currentCyclePromise = promise
    return promise
  }

  /**
   * A user-triggered sync: let any in-flight cycle finish, then run a fresh
   * one so newly changed files are included. The panel keeps showing "syncing"
   * for the whole sequence.
   */
  async syncNow(reason = 'manual') {
    if (this.currentCyclePromise) {
      try { await this.currentCyclePromise } catch {}
    }
    return this.cycle(reason)
  }

  async runCycle(reason) {
    if (this.busy) return this.lastCycle
    const automatic = AUTO_CYCLE_REASONS.has(reason)
    // Realtime is opt-in: an engine-scheduled cycle must not touch the network
    // before the user has explicitly enabled it. Explicit entry points
    // (manual cycles, pushTo, forcePull, immediateSync) bypass this switch.
    if (automatic && this.settings.realtime !== true) return { skipped: 'realtime-off' }
    // Automatic cycles follow the device role; without a locked identity there
    // is no safe direction to move data in.
    if (automatic && !this.settings.roleLocked) return { skipped: 'role-unlocked' }
    this.busy = true
    this.pendingCycle = false
    const started = Date.now()
    // A plugin installed since the last cycle must become adoptable without
    // restarting DSH, so re-probe the local package roots every cycle.
    this.bundleResolver?.clearCache?.()
    this.progress = { reason, startedAt: new Date(started).toISOString(), pushed: 0, pulled: 0, merged: 0, deleted: 0, conflicts: 0, bytes: 0, files: 0 }
    const cycle = {
      at: new Date().toISOString(),
      reason,
      direction: automatic ? (this.settings.role === 'sub' ? 'pull' : 'push') : null,
      peers: 0,
      pushed: 0,
      pulled: 0,
      merged: 0,
      deleted: 0,
      conflicts: 0,
      deferred: 0,
      skipped: 0,
      skippedUnique: 0,
      bytes: 0,
      errors: [],
      durationMs: 0,
    }
    try {
      await this.probeManualPeers()
      if (automatic) {
        // Role-directed sync: a host pushes to its subs, a sub pulls from its
        // host. The bidirectional mesh below stays for explicit/manual cycles.
        await this.runRoleCycle(cycle)
      } else {
        await this.refreshIndex()
        const peers = this.discovery?.list() || []
        for (const peer of peers) {
          if (!this.identity.getPeer(peer.deviceId)) {
            await this.probe(peer).catch(() => {})
            continue
          }
          cycle.peers++
          const result = await this.syncPeer(peer)
          cycle.pulled += result.pulled
          cycle.merged += result.merged
          cycle.deleted += result.deleted
          cycle.conflicts += result.conflicts
          cycle.deferred += result.deferred
          cycle.skipped += result.skipped
          cycle.errors.push(...result.errors)
        }
      }
      // Profile self-healing is local-only and runs after the transfers so it
      // also sees plugin sources and packages that just arrived this cycle.
      try {
        const repaired = await this.repairLocalProfile()
        if (repaired?.changed) cycle.repaired = true
      } catch (error) {
        this.log('warn', `profile repair failed: ${String(error?.message || error)}`)
      }
      await this.index.save()
      await this.journal.flush()
      await this.tombstones?.save()
      this.lastError = cycle.errors[0] || null
    } catch (error) {
      cycle.errors.push(String(error?.message || error))
      this.lastError = cycle.errors[0]
      this.log('error', 'cycle error: ' + this.lastError)
    } finally {
      cycle.durationMs = Date.now() - started
      this.lastCycle = cycle
      this.busy = false
      if (this.progress) this.progress = { ...this.progress, finishedAt: new Date().toISOString(), durationMs: cycle.durationMs }
      this.emit('status')
      if (this.pendingCycle) {
        this.pendingCycle = false
        setTimeout(() => this.scheduleCycle('pending'), 500).unref?.()
      }
    }
    return cycle
  }

  /** One automatic, role-directed pass (host pushes / sub pulls). */
  async runRoleCycle(cycle) {
    if (this.settings.role === 'sub') {
      const hostId = this.hostPeerId()
      if (!hostId || !this.isPeerOnline(hostId)) {
        cycle.skipped++
        return
      }
      cycle.peers++
      try {
        const result = await this.forcePull(hostId, { automatic: true })
        this.mergeCycleResult(cycle, result)
      } catch (error) {
        cycle.errors.push(String(error?.message || error))
      }
      return
    }
    for (const peer of this.identity.trustedPeers()) {
      if (this.peerRoleFor(peer.deviceId) !== 'sub') continue
      if (!this.isPeerOnline(peer.deviceId)) continue
      cycle.peers++
      try {
        const result = await this.pushTo(peer.deviceId, { automatic: true })
        this.mergeCycleResult(cycle, result)
      } catch (error) {
        cycle.errors.push(`${peer.deviceId.slice(0, 8)}: ${error.message}`)
      }
    }
  }

  mergeCycleResult(cycle, result) {
    if (!result) return
    cycle.pushed += Number(result.pushed) || 0
    cycle.pulled += Number(result.pulled) || 0
    cycle.merged += Number(result.merged) || 0
    cycle.deleted += Number(result.deleted) || 0
    cycle.conflicts += Number(result.conflicts) || 0
    cycle.deferred += Number(result.deferred) || 0
    cycle.skipped += Number(result.skipped) || 0
    cycle.skippedUnique += Number(result.skippedUnique) || 0
    cycle.bytes += Number(result.bytes) || 0
    cycle.errors.push(...(Array.isArray(result.errors) ? result.errors : []))
  }

  async refreshIndex() {
    for (const set of this.enabledSets()) {
      try {
        await this.refreshSet(set)
      } catch (error) {
        this.log('warn', `index refresh failed for ${set.id}: ${error.message}`)
      }
    }
  }

  /** Deletion propagation is limited to plain file sets, never to session logs or synced packages. */
  deletesEnabled(set) {
    if (this.config.propagateDeletes === false) return false
    // `modules` is a dependency mirror: a peer must never delete packages that
    // this machine installed locally (and vice versa).
    return set.mode === 'lww' && set.id !== 'workspace' && set.id !== 'modules'
  }

  /** Serialize index refreshes so a peer request cannot interleave a scan. */
  refreshSet(set) {
    this.refreshChains ||= new Map()
    const previous = this.refreshChains.get(set.id) || Promise.resolve()
    const next = previous
      .catch(() => {})
      .then(() => this.index.refresh(set, {
        stableAfterMs: this.stableAfterMs(),
        maxFileBytes: Number(this.config.maxBlobBytes) || DEFAULTS.maxBlobBytes,
        onDelete: (target, rel, entry) => {
          // Profile deletions are remembered locally so a peer copy cannot
          // resurrect a plugin the user just removed. They are not propagated:
          // `deletesEnabled` stays false for profile sets. Synced packages never
          // get tombstones at all.
          if (target.id === 'modules') return
          if (this.deletesEnabled(target) || target.mode === 'profile') {
            this.tombstones?.add(target.id, rel, entry.h, { device: this.identity.deviceId })
          }
        },
      }))
    this.refreshChains.set(set.id, next)
    return next
  }

  /** Fetch identity details for a discovered but unpaired peer and precompute its SAS. */
  async probe(peer) {
    const client = new PeerClient({ identity: this.identity, peer, logger: this.logger, timeoutMs: 6000 })
    const hello = await client.hello()
    const shared = deriveSharedSecret(this.identity.privateKey, hello.publicKey)
    const sas = sasCode(shared, this.identity.publicKey, hello.publicKey)
    const state = this.peerState.get(peer.deviceId) || {}
    this.peerState.set(peer.deviceId, {
      ...state,
      hello,
      sas,
      name: hello.name,
      group: hello.group,
      lastSeen: Date.now(),
    })
    this.emit('peer-updated', peer)
    return { hello, sas }
  }

  async loadManualPeers() {
    const { value } = await readJsonDetailed(join(this.stateDir, MANUAL_FILE), null)
    if (value && Array.isArray(value.endpoints)) {
      this.manualPeers = value.endpoints
        .filter((entry) => entry && entry.host && Number(entry.port) > 0)
        .map((entry) => ({ host: String(entry.host), port: Number(entry.port) }))
    }
  }

  async saveManualPeers() {
    await writeJson(join(this.stateDir, MANUAL_FILE), { version: 1, endpoints: this.manualPeers }).catch(() => {})
  }

  /** Resolve manually entered endpoints through the same public /hello handshake. */
  async probeManualPeers() {
    for (const endpoint of this.manualPeers) {
      const known = this.discovery?.list().some((peer) => peer.host === endpoint.host && Number(peer.port) === endpoint.port)
      if (known) continue
      try {
        const client = new PeerClient({
          identity: this.identity,
          peer: { deviceId: '', host: endpoint.host, port: endpoint.port },
          logger: this.logger,
          timeoutMs: 6000,
        })
        const hello = await client.hello()
        this.discovery?.addPeer({
          deviceId: hello.deviceId,
          host: endpoint.host,
          port: endpoint.port,
          name: hello.name,
          group: hello.group,
          discoveryPort: Number(this.config.discoveryPort) || 47821,
          source: 'manual',
        })
        this.peerState.set(hello.deviceId, {
          ...(this.peerState.get(hello.deviceId) || {}),
          hello,
          name: hello.name,
          group: hello.group,
          lastSeen: Date.now(),
        })
        this.log('info', `manual peer reachable: ${endpoint.host}:${endpoint.port}`)
      } catch (error) {
        this.manualLogAt ||= new Map()
        const key = endpoint.host + ':' + endpoint.port
        const last = this.manualLogAt.get(key) || 0
        if (Date.now() - last > 60_000) {
          this.manualLogAt.set(key, Date.now())
          this.log('warn', `manual peer ${key} unreachable: ${error.message}`)
        }
      }
    }
  }

  async addManualPeer(address) {
    const parsed = parseSeed(address)
    if (!parsed) throw new Error('地址格式应为 IP:端口，例如 192.168.1.20:49683')
    if (!this.manualPeers.some((entry) => entry.host === parsed.host && entry.port === parsed.port)) {
      this.manualPeers.push({ host: parsed.host, port: parsed.port })
      await this.saveManualPeers()
    }
    this.discovery?.addSeed(`${parsed.host}:${Number(this.config.discoveryPort) || 47821}`)
    await this.probeManualPeers()
    const reachable = Boolean(this.discovery?.list().some((peer) => peer.host === parsed.host && Number(peer.port) === parsed.port))
    this.scheduleCycle('manual-peer')
    this.emit('status')
    return { state: this.state(), reachable, endpoint: parsed }
  }

  async loadPushGuard() {    const { value } = await readJsonDetailed(join(this.stateDir, PUSH_GUARD_FILE), null)
    this.pushEnabled = Boolean(value?.enabled)
  }

  async setPushGuard(enabled) {
    this.pushEnabled = Boolean(enabled)
    await this.persistPushGuard()
    this.emit('status')
    return this.pushEnabled
  }

  async persistPushGuard() {
    try {
      await writeJson(join(this.stateDir, PUSH_GUARD_FILE), { version: 1, enabled: this.pushEnabled })
    } catch (error) {
      this.log('warn', `push guard write failed: ${error.message}`)
    }
  }

  /** Host + locked is the only combination that may push; keep it in sync. */
  async refreshPushEnabled() {
    const next = this.settings.role === 'host' && this.settings.roleLocked === true
    const changed = this.pushEnabled !== next
    this.pushEnabled = next
    await this.persistPushGuard()
    return changed
  }

  async loadSettings() {
    const { value, error } = await readJsonDetailed(join(this.stateDir, SETTINGS_FILE), null)
    const missing = Boolean(error) && error.code === 'ENOENT'
    if (!missing && !isPlainObject(value)) this.log('warn', 'sync-settings.json is not valid JSON; using defaults until it is rewritten')
    this.settings = normalizeSettings(value)
    const peers = this.identity.trustedPeers()
    // Old users paired before roles existed: their peers must not be asked to
    // pick a role again. The machine with the peers becomes the host.
    if (missing && peers.length > 0 && !this.settings.roleLocked) {
      this.settings.role = 'host'
      this.settings.roleLocked = true
      for (const peer of peers) this.settings.peerRoles[peer.deviceId] = 'sub'
      this.log('info', `migrated sync settings: ${peers.length} paired peer(s) pinned this device as host`)
    }
    const before = JSON.stringify(this.settings.peerRoles)
    this.normalizePeerRoles()
    const changed = missing || JSON.stringify(this.settings.peerRoles) !== before
    if (changed) await this.saveSettings()
    await this.refreshPushEnabled()
  }

  async saveSettings() {
    try {
      await writeJson(join(this.stateDir, SETTINGS_FILE), this.settings)
    } catch (error) {
      this.log('warn', `sync settings write failed: ${error.message}`)
    }
  }

  /**
   * Fill in peer roles from the trust store: a host's peers are sub-devices and
   * a sub's single peer is its host. Stale entries for untrusted peers are
   * dropped so `disconnectAll()` really forgets them.
   */
  normalizePeerRoles() {
    const peers = this.identity.trustedPeers()
    const roles = this.settings.peerRoles
    for (const deviceId of Object.keys(roles)) {
      if (!peers.some((peer) => peer.deviceId === deviceId)) delete roles[deviceId]
    }
    let hostAssigned = false
    for (const peer of peers) {
      if (!roles[peer.deviceId]) {
        roles[peer.deviceId] = this.settings.role === 'sub' ? (hostAssigned ? 'sub' : 'host') : 'sub'
      }
      if (roles[peer.deviceId] === 'host') {
        // A sub-device may only have one host peer.
        if (this.settings.role === 'sub' && hostAssigned) roles[peer.deviceId] = 'sub'
        else hostAssigned = true
      }
    }
  }

  peerRoleFor(deviceId) {
    const explicit = this.settings.peerRoles[deviceId]
    if (explicit === 'host' || explicit === 'sub') return explicit
    return this.settings.role === 'sub' ? 'host' : 'sub'
  }

  publicSettings() {
    return {
      role: this.settings.role,
      roleLocked: this.settings.roleLocked === true,
      realtime: this.settings.realtime === true,
      localOnlyExcluded: this.settings.localOnlyExcluded === true,
      shadowWorkspace: { enabled: this.settings.shadowWorkspace?.enabled === true },
      cleanup: { ...this.settings.cleanup },
      peerRoles: { ...this.settings.peerRoles },
      sets: JSON.parse(JSON.stringify(this.settings.sets || {})),
    }
  }

  /** Pick this device's identity. Refused while locked (disconnect first). */
  async setRole(role) {
    const next = String(role || '')
    if (next !== 'host' && next !== 'sub') throw refusal('bad-value', '角色只能是 host 或 sub')
    if (this.settings.roleLocked) throw refusal('role-locked', '身份已锁定；请先断开全部连接再切换角色')
    this.settings.role = next
    this.normalizePeerRoles()
    await this.saveSettings()
    await this.refreshPushEnabled()
    this.log('info', `device role set to ${next}`)
    this.emit('status')
    return this.state()
  }

  /** Drop every peer and unlock the role. Synced data stays where it is. */
  async disconnectAll() {
    const peers = this.identity.trustedPeers()
    for (const peer of peers) {
      try { await this.identity.untrustPeer(peer.deviceId) } catch {}
      this.peerState.delete(peer.deviceId)
    }
    this.settings.roleLocked = false
    this.settings.peerRoles = {}
    this.pushEnabled = false
    await this.saveSettings()
    await this.persistPushGuard()
    this.log('info', `disconnected ${peers.length} peer(s); identity unlocked`)
    this.emit('status')
    return this.state()
  }

  async setRealtime(enabled) {
    this.settings.realtime = Boolean(enabled)
    await this.saveSettings()
    this.log('info', `realtime sync ${this.settings.realtime ? 'enabled' : 'disabled'}`)
    this.emit('status')
    return this.state()
  }

  async setLocalOnly(enabled) {
    this.settings.localOnlyExcluded = Boolean(enabled)
    await this.saveSettings()
    this.emit('status')
    return this.state()
  }

  async setShadowWorkspace(enabled) {
    this.settings.shadowWorkspace = { enabled: Boolean(enabled) }
    await this.saveSettings()
    this.emit('status')
    return this.state()
  }

  async setCleanup(patch = {}) {
    if (!isPlainObject(patch)) throw refusal('bad-value', '清理设置格式不正确')
    const next = { ...this.settings.cleanup }
    if ('enabled' in patch) next.enabled = Boolean(patch.enabled)
    if ('backups' in patch) next.backups = Boolean(patch.backups)
    if ('recycle' in patch) next.recycle = Boolean(patch.recycle)
    if ('retentionDays' in patch) {
      const days = Number(patch.retentionDays)
      if (!RETENTION_DAYS.has(days)) throw refusal('bad-value', '保留天数只能是 0/7/30/45/90')
      next.retentionDays = days
    }
    if ('backupDays' in patch) {
      next.backupDays = normalizeInt(patch.backupDays, { min: 1, max: 3650, fallback: NaN })
      if (!Number.isInteger(next.backupDays)) throw refusal('bad-value', '备份保留天数需为 1-3650 的整数')
    }
    if ('recycleMax' in patch) {
      next.recycleMax = normalizeInt(patch.recycleMax, { min: 1, max: 1000, fallback: NaN })
      if (!Number.isInteger(next.recycleMax)) throw refusal('bad-value', '回收站上限需为 1-1000 的整数')
    }
    this.settings.cleanup = next
    await this.saveSettings()
    await this.saveCleanup()
    await this.pruneRecycle()
    // Keep the automatic retention timer in sync with the toggle.
    if (this.running && this.config.autoCycle !== false) {
      if (this.settings.cleanup.enabled) this.scheduleCleanupTimer()
      else this.stopCleanupTimer()
    }
    this.emit('status')
    return this.state()
  }

  peerFor(deviceId) {
    const peer = this.discovery?.list().find((item) => item.deviceId === deviceId)
    if (!peer) throw new Error('设备不在线，无法执行')
    if (!this.identity.getPeer(deviceId)) throw new Error('设备尚未配对')
    return peer
  }

  /** Force this device to adopt the peer's files (config files stay protected). */
  async forcePull(deviceId, { automatic = false } = {}) {
    const peer = this.peerFor(deviceId)
    const client = new PeerClient({ identity: this.identity, peer, logger: this.logger })
    const result = { pulled: 0, merged: 0, conflicts: 0, skipped: 0, skippedUnique: 0, bytes: 0, errors: [] }
    const unique = automatic && this.settings.localOnlyExcluded === true
    this.bundleResolver?.clearCache?.()
    this.progress = { reason: 'force-pull', startedAt: new Date().toISOString(), pulled: 0, merged: 0, deleted: 0, conflicts: 0, bytes: 0, files: 0 }
    await client.hello()
    await this.refreshIndex()
    for (const set of this.enabledSets()) {
      let manifest
      try {
        manifest = await client.rpc('manifest', { set: set.id })
      } catch (error) {
        result.errors.push(`${set.id}: ${error.message}`)
        continue
      }
      for (const [rel, remote] of Object.entries(manifest.entries || {})) {
        if (isIgnoredForSet(rel, set)) continue
        if (!this.itemAllowed(set, rel)) { result.skipped++; continue }
        // Local-only rule: an automatic pull may only adopt files this device
        // already has (the peer's copy is newer) or items the user selected.
        if (unique && !this.index.get(set.id, rel) && !this.itemExplicitlySelected(set, rel)) {
          result.skippedUnique++
          continue
        }
        try {
          const local = this.index.get(set.id, rel)
          const special = await this.applyProfileSpecial(set, rel, remote, peer, client, local, null, { action: 'PULL' })
          if (special) {
            if (special.kind === 'merged') { result.merged++; result.bytes += special.bytes || 0; this.bumpProgress('merged', special.bytes) }
            else if (special.kind === 'conflict') { result.conflicts++; this.bumpProgress('conflicts') }
            else result.skipped++
            if (special.conflicts) { result.conflicts += special.conflicts; this.bumpConflicts(special.conflicts) }
            continue
          }
          const applied = await this.applyPull(set, rel, remote, peer, client)
          if (applied?.conflict) { result.conflicts++; this.bumpProgress('conflicts') }
          else if (applied?.pulled) { result.pulled++; result.bytes += applied.bytes || 0; this.bumpProgress('pulled', applied.bytes) }
          else result.skipped++
        } catch (error) {
          result.errors.push(`${set.id}/${rel}: ${error.message}`)
        }
      }
    }
    await this.index.save()
    await this.journal.flush()
    await this.tombstones?.save()
    this.progress = { ...this.progress, finishedAt: new Date().toISOString() }
    this.emit('status')
    return result
  }

  /**
   * Push local files to a peer. Only a locked host may push, and only to a peer
   * that has been assigned the sub role by this device.
   */
  async pushTo(deviceId, { automatic = false } = {}) {
    const targetId = String(deviceId || '')
    if (this.settings.role !== 'host' || !this.settings.roleLocked) {
      throw refusal('push-not-allowed', '只有已锁定为主机的设备可以向子机推送')
    }
    if (this.peerRoleFor(targetId) !== 'sub') throw refusal('push-not-allowed', '目标设备不是子机，不能推送')
    const peer = this.peerFor(targetId)
    const client = new PeerClient({ identity: this.identity, peer, logger: this.logger })
    const result = { pushed: 0, skipped: 0, skippedUnique: 0, bytes: 0, errors: [] }
    const unique = automatic && this.settings.localOnlyExcluded === true
    this.progress = { reason: 'push', startedAt: new Date().toISOString(), pushed: 0, merged: 0, deleted: 0, conflicts: 0, bytes: 0, files: 0 }
    await client.hello()
    await this.refreshIndex()
    const maxBytes = Number(this.config.maxBlobBytes) || DEFAULTS.maxBlobBytes
    for (const set of this.enabledSets()) {
      let manifest
      try {
        manifest = await client.rpc('manifest', { set: set.id })
      } catch (error) {
        result.errors.push(`${set.id}: ${error.message}`)
        continue
      }
      const remote = manifest.entries || {}
      for (const [rel, entry] of Object.entries(this.index.entries(set.id))) {
        if (isIgnoredForSet(rel, set)) continue
        if (!this.itemAllowed(set, rel)) { result.skipped++; continue }
        // Local-only rule: an automatic push must not create files on the peer
        // that only exist here, unless the user explicitly selected the item.
        if (unique && !remote[rel] && !this.itemExplicitlySelected(set, rel)) {
          result.skippedUnique++
          continue
        }
        if (remote[rel]?.h === entry.h) { result.skipped++; continue }
        const abs = joinInside(set, rel)
        if (!abs) continue
        const data = await fs.readFile(abs).catch(() => null)
        if (!data) continue
        if (data.length > maxBytes) {
          result.errors.push(`${set.id}/${rel}: file too large`)
          continue
        }
        try {
          const response = await client.rpc('push', { set: set.id, rel, data: data.toString('base64'), m: entry.m, h: entry.h })
          // The receiver may refuse an item outside its own scope without
          // failing the whole push.
          if (response?.applied === 'skipped') { result.skipped++; continue }
          result.pushed++
          result.bytes += data.length
          this.bumpProgress('pushed', data.length)
        } catch (error) {
          result.errors.push(`${set.id}/${rel}: ${error.message}`)
        }
      }
    }
    this.progress = { ...this.progress, finishedAt: new Date().toISOString() }
    this.emit('status')
    return result
  }

  /**
   * User-triggered sync with an explicit direction: a host pushes to every
   * online sub-device, a sub pulls from its host. Never gated by the realtime
   * switch — this is exactly the explicit path the switch leaves open.
   */
  async immediateSync() {
    if (!this.settings.roleLocked) throw refusal('not-ready', '身份尚未锁定，请先完成配对')
    if (this.settings.role === 'sub') {
      const hostId = this.hostPeerId()
      if (!hostId) throw refusal('not-ready', '尚未连接主机')
      if (!this.isPeerOnline(hostId)) throw refusal('not-ready', '主机不在线')
      const result = await this.forcePull(hostId)
      return { direction: 'pull', target: hostId, result }
    }
    const targets = this.identity.trustedPeers().filter((peer) =>
      this.peerRoleFor(peer.deviceId) === 'sub' && this.isPeerOnline(peer.deviceId))
    if (!targets.length) throw refusal('not-ready', '没有在线的子机')
    const results = []
    for (const peer of targets) {
      try {
        results.push({ deviceId: peer.deviceId, name: peer.name, result: await this.pushTo(peer.deviceId) })
      } catch (error) {
        results.push({ deviceId: peer.deviceId, name: peer.name, error: String(error?.message || error) })
      }
    }
    this.emit('status')
    return { direction: 'push', results }
  }

  isPeerOnline(deviceId) {
    return Boolean(this.discovery?.list().some((peer) => peer.deviceId === deviceId))
  }

  hostPeerId() {
    const hosts = this.identity.trustedPeers().filter((peer) => this.peerRoleFor(peer.deviceId) === 'host')
    if (!hosts.length) return null
    const online = hosts.find((peer) => this.isPeerOnline(peer.deviceId))
    return (online || hosts[0]).deviceId
  }

  /**
   * Local changes that the given peer has not acknowledged yet. Compares this
   * device's index with the per-peer journal base, so it works offline and
   * stays cheap for the huge `modules` set.
   */
  async previewChanges(deviceId, { refresh = true } = {}) {
    const peerId = String(deviceId || '')
    if (!peerId) throw refusal('bad-value', '缺少目标设备')
    if (!this.index) throw refusal('not-ready', '同步引擎尚未启动')
    if (refresh) await this.refreshIndex()
    const files = []
    for (const set of this.enabledSets()) {
      const entries = this.index.entries(set.id)
      for (const [rel, entry] of Object.entries(entries)) {
        if (isIgnoredForSet(rel, set)) continue
        if (!this.itemAllowed(set, rel)) continue
        const base = await this.journal.base(peerId, set.id, rel)
        if (base && base.h === entry.h) continue
        files.push({ rel, size: Number(entry.s) || 0, set: set.id })
      }
    }
    const summary = summarizePreviewFiles(files)
    this.changesPreview = { direction: 'push', target: peerId, ...summary }
    return summary
  }

  /**
   * Files that "覆盖本地" (force pull) would replace, newest-first irrelevant:
   * the peer's manifest compared with this device's index. Unlike
   * `previewChanges` this needs the peer online, because the manifest is remote.
   */
  async previewPull(deviceId) {
    const peerId = String(deviceId || '')
    if (!peerId) throw refusal('bad-value', '缺少目标设备')
    if (!this.index) throw refusal('not-ready', '同步引擎尚未启动')
    if (!this.identity.getPeer(peerId)) throw refusal('not-ready', '设备尚未配对，无法预览覆盖清单')
    if (!this.isPeerOnline(peerId)) throw refusal('not-ready', '设备不在线，无法预览覆盖清单')
    const peer = this.peerFor(peerId)
    const client = new PeerClient({ identity: this.identity, peer, logger: this.logger })
    await client.hello()
    await this.refreshIndex()
    const files = []
    for (const set of this.enabledSets()) {
      let manifest
      try {
        manifest = await client.rpc('manifest', { set: set.id })
      } catch (error) {
        this.log('warn', `preview manifest failed for ${set.id}: ${error.message}`)
        continue
      }
      for (const [rel, remote] of Object.entries(manifest.entries || {})) {
        if (isIgnoredForSet(rel, set)) continue
        if (!this.itemAllowed(set, rel)) continue
        const local = this.index.get(set.id, rel)
        if (local && local.h === remote.h) continue
        files.push({ rel, size: Number(remote.s ?? remote.size ?? 0) || 0, set: set.id })
      }
    }
    const summary = summarizePreviewFiles(files)
    this.changesPreview = { direction: 'pull', target: peerId, ...summary }
    return summary
  }

  /** Changes the host would have to send for a sub: remote manifest vs journal base. */
  async previewRemoteChanges(deviceId) {
    const peer = this.peerFor(deviceId)
    const client = new PeerClient({ identity: this.identity, peer, logger: this.logger })
    await client.hello()
    const files = []
    for (const set of this.enabledSets()) {
      let manifest
      try {
        manifest = await client.rpc('manifest', { set: set.id })
      } catch (error) {
        this.log('warn', `preview manifest failed for ${set.id}: ${error.message}`)
        continue
      }
      for (const [rel, remote] of Object.entries(manifest.entries || {})) {
        if (isIgnoredForSet(rel, set)) continue
        if (!this.itemAllowed(set, rel)) continue
        const base = await this.journal.base(deviceId, set.id, rel)
        if (base && base.h === remote.h) continue
        files.push({ rel, size: Number(remote.s ?? remote.size ?? 0) || 0, set: set.id })
      }
    }
    return summarizePreviewFiles(files)
  }

  /**
   * What "sync now" would move right now: a host aggregates the unsent changes
   * of all its sub-devices (deduplicated), a sub shows what its host changed.
   */
  async previewImmediate() {
    if (this.settings.role === 'sub') {
      const hostId = this.hostPeerId()
      let summary = { files: [], count: 0, bytes: 0 }
      if (hostId) {
        try {
          summary = await this.previewRemoteChanges(hostId)
        } catch (error) {
          this.log('warn', `preview from host failed: ${error.message}`)
        }
      }
      const preview = { direction: 'pull', target: hostId || null, ...summary }
      this.changesPreview = preview
      return preview
    }
    if (!this.index) throw refusal('not-ready', '同步引擎尚未启动')
    await this.refreshIndex()
    const merged = new Map()
    const targets = []
    for (const peer of this.identity.trustedPeers()) {
      if (this.peerRoleFor(peer.deviceId) !== 'sub') continue
      targets.push(peer.deviceId)
      try {
        const summary = await this.previewChanges(peer.deviceId, { refresh: false })
        for (const file of summary.files) merged.set(file.set + '|' + file.rel, file)
      } catch (error) {
        this.log('warn', `preview failed for peer ${peer.deviceId.slice(0, 8)}: ${error.message}`)
      }
    }
    const summary = summarizePreviewFiles([...merged.values()])
    const preview = {
      direction: 'push',
      target: targets.length > 1 ? targets : (targets[0] || null),
      ...summary,
    }
    this.changesPreview = preview
    return preview
  }

  async syncPeer(peer) {
    const trusted = this.identity.getPeer(peer.deviceId)
    const result = { pulled: 0, merged: 0, deleted: 0, conflicts: 0, deferred: 0, skipped: 0, bytes: 0, errors: [] }
    const state = this.peerState.get(peer.deviceId) || {}
    const client = new PeerClient({ identity: this.identity, peer, logger: this.logger })
    try {
      const hello = await client.hello()
      if (trusted && hello.publicKey !== trusted.publicKey) {
        throw new Error('peer presented a different public key than the paired one')
      }
      this.peerState.set(peer.deviceId, {
        ...state,
        hello,
        name: hello.name,
        group: hello.group,
        lastSyncAt: new Date().toISOString(),
        status: 'syncing',
        error: null,
      })
      // One byte budget per peer cycle for the modules set: plugin
      // dependencies can be tens of MB, and a cold peer would otherwise pull
      // everything in a single burst.
      const modulesLimit = Number(this.config.maxModulesBytes) || DEFAULTS.maxModulesBytes
      let modulesBytes = 0
      let modulesLimitHit = false
      for (const set of this.enabledSets()) {
        let manifest
        try {
          manifest = await client.rpc('manifest', { set: set.id })
        } catch (error) {
          result.errors.push(`${set.id}: ${error.message}`)
          continue
        }
        const remoteEntries = manifest.entries || {}
        const localEntries = this.index.entries(set.id)
        const deletes = this.deletesEnabled(set) ? (manifest.deletes || {}) : {}
        for (const [rel, tomb] of Object.entries(deletes)) {
          if (isIgnoredForSet(rel, set)) continue
          if (!this.itemAllowed(set, rel)) continue
          try {
            const applied = await this.applyDelete(set, rel, tomb, peer)
            if (applied?.deleted) {
              result.deleted++
              this.bumpProgress('deleted')
              delete localEntries[rel]
            } else if (applied?.conflict) {
              result.conflicts++
              this.bumpProgress('conflicts')
            }
          } catch (error) {
            result.errors.push(`${set.id}/${rel}: ${error.message}`)
          }
        }
        const rels = unionKeys(localEntries, remoteEntries)
        for (const rel of rels) {
          if (isIgnoredForSet(rel, set)) continue
          // The index keeps unselected files so they are never mistaken for
          // deletions; the sync decision just skips them.
          if (!this.itemAllowed(set, rel)) continue
          const local = localEntries[rel] || null
          const remote = remoteEntries[rel] || null
          if (set.id === 'modules' && remote && local?.h !== remote.h) {
            const remoteSize = Number(remote.s ?? remote.size ?? 0)
            if (modulesBytes + remoteSize > modulesLimit) {
              result.skipped++
              if (!modulesLimitHit) {
                modulesLimitHit = true
                const added = await this.addConflict({
                  kind: 'modules-over-limit',
                  set: set.id,
                  rel: 'node_modules',
                  peer: peer.deviceId,
                  at: new Date().toISOString(),
                  note: `插件依赖本轮同步达到上限（${formatBytes(modulesLimit)}），剩余文件留待下一轮；可调大 maxModulesBytes`,
                })
                if (added) {
                  result.conflicts++
                  this.bumpProgress('conflicts')
                }
                this.log('warn', `modules set over maxModulesBytes (${modulesLimit}) for peer ${peer.deviceId.slice(0, 8)}; deferring the rest`)
              }
              continue
            }
          }
          if (!local && remote) {
            // We deleted it earlier. If the peer still has the exact bytes we
            // deleted, keep waiting for its tombstone instead of resurrecting
            // the file; different bytes mean the peer edited it after us.
            const tomb = this.tombstones?.get(set.id, rel)
            if (tomb && tomb.h === remote.h) {
              result.skipped++
              continue
            }
            if (tomb) {
              // Peer edited a file we deleted: their newer content wins, but
              // tell the user why a deleted file came back.
              await this.addConflict({
                kind: 'resurrect',
                set: set.id,
                rel,
                peer: peer.deviceId,
                hash: remote.h,
                at: new Date().toISOString(),
                note: '本机删除的文件在对端被修改，已用对端版本恢复',
              })
              this.tombstones.remove(set.id, rel)
            }
          }
          // Credentials are a merge-only set: the merge never clobbers a local
          // value, so LWW must not gate it. DSH rewrites this file at runtime,
          // which makes the local mtime newer than the peer's almost always —
          // deciding PULL by mtime would silently never sync the peer's keys.
          if (set.mode === 'merge-credentials' && remote && (!local || local.h !== remote.h)) {
            const parked = await this.journal.base(peer.deviceId, set.id, rel)
            const isParked = parked?.divergedH === remote.h && (!parked?.h || parked.h === local?.h)
            if (!isParked) {
              try {
                const applied = await this.applyPull(set, rel, remote, peer, client)
                if (applied?.conflicts) {
                  result.conflicts += applied.conflicts
                  this.bumpConflicts(applied.conflicts)
                }
                if (applied?.deferred) result.deferred++
                else if (applied?.merged) {
                  result.merged++
                  result.bytes += applied.bytes || 0
                  this.bumpProgress('merged', applied.bytes)
                } else if (applied?.pulled) {
                  result.pulled++
                  result.bytes += applied.bytes || 0
                  this.bumpProgress('pulled', applied.bytes)
                } else result.skipped++
              } catch (error) {
                result.errors.push(`${set.id}/${rel}: ${error.message}`)
              }
              continue
            }
          }
          const base = await this.journal.base(peer.deviceId, set.id, rel)
          const decision = decide({
            local,
            remote,
            base,
            mode: set.mode,
            localDevice: this.identity.deviceId,
            remoteDevice: peer.deviceId,
          })
          const special = await this.applyProfileSpecial(set, rel, remote, peer, client, local, base, decision)
          if (special) {
            if (special.kind === 'merged') {
              result.merged++
              result.bytes += special.bytes || 0
              this.bumpProgress('merged', special.bytes)
            } else if (special.kind === 'conflict') {
              result.conflicts++
              this.bumpProgress('conflicts')
            } else {
              result.skipped++
            }
            if (special.conflicts) {
              result.conflicts += special.conflicts
              this.bumpConflicts(special.conflicts)
            }
            continue
          }
          try {
            if (decision.action === PULL) {
              const applied = await this.applyPull(set, rel, remote, peer, client)
              if (applied?.conflicts) {
                result.conflicts += applied.conflicts
                this.bumpConflicts(applied.conflicts)
              }
              if (applied?.conflict) { result.conflicts++; this.bumpProgress('conflicts') }
              else if (applied?.deferred) result.deferred++
              else if (applied?.merged) {
                result.merged++
                result.bytes += applied.bytes || 0
                this.bumpProgress('merged', applied.bytes)
              } else if (applied?.pulled) {
                result.pulled++
                result.bytes += applied.bytes || 0
                if (set.id === 'modules') modulesBytes += applied.bytes || 0
                this.bumpProgress('pulled', applied.bytes)
              } else result.skipped++
            } else if (decision.action === MERGE) {
              const applied = await this.applyWorkspaceMerge(set, rel, remote, client, peer)
              if (applied?.merged) {
                result.merged++
                result.bytes += applied.bytes || 0
                this.bumpProgress('merged', applied.bytes)
              } else if (applied?.conflict) {
                result.conflicts++
                this.bumpProgress('conflicts')
              } else result.skipped++
            } else if (decision.action === CONFLICT) {
              const saved = await this.parkConflict(set, rel, remote, peer, client, local)
              if (saved) { result.conflicts++; this.bumpProgress('conflicts') }
              else result.skipped++
            } else if (decision.action === EQUAL) {
              await this.journal.record(peer.deviceId, set.id, rel, remote)
              result.skipped++
            } else {
              result.skipped++
            }
          } catch (error) {
            result.errors.push(`${set.id}/${rel}: ${error.message}`)
          }
        }
      }
      await this.journal.touch(peer.deviceId)
      await this.identity.touchPeer(peer.deviceId)
      const current = this.peerState.get(peer.deviceId) || state
      this.peerState.set(peer.deviceId, { ...current, status: 'idle', lastSyncAt: new Date().toISOString(), error: result.errors[0] || null, result })
    } catch (error) {
      result.errors.push(String(error?.message || error))
      this.peerState.set(peer.deviceId, { ...state, status: 'error', error: String(error?.message || error), lastSyncAt: new Date().toISOString() })
    }
    if (trusted) this.emit('status')
    return result
  }

  /** Serve one authenticated RPC from a paired peer. */
  async handleRpc(request, context) {
    const op = request?.op
    if (op === 'ping') {
      return { ok: true, name: this.identity.name, group: this.identity.groupId, port: this.port, sets: this.enabledSets().map((set) => set.id) }
    }
    if (op === 'manifest') {
      const set = this.setById(String(request.set || ''))
      if (!set) throw Object.assign(new Error('unknown set'), { code: 'unknown-set' })
      if (request.fresh !== false) {
        await this.refreshSet(set)
      }
      return {
        set: set.id,
        // Only items inside this device's scope are advertised. The local index
        // stays complete so unselected files are never seen as deletions.
        entries: this.filterSetEntries(set, this.index.entries(set.id)),
        deletes: this.deletesEnabled(set) ? this.filterSetEntries(set, this.tombstones?.bySet(set.id) || {}) : {},
        time: Date.now(),
      }
    }
    if (op === 'pull') {
      const set = this.setById(String(request.set || ''))
      if (!set) throw Object.assign(new Error('unknown set'), { code: 'unknown-set' })
      const rel = String(request.rel || '')
      // A set may only expose paths its index would select (include/exclude and
      // global ignore rules). Without this a paired peer could read anything
      // under the set root — e.g. `credentials` root is $DSH_HOME.
      if (!setAllowsRel(set, rel)) throw Object.assign(new Error('invalid path'), { code: 'invalid-path' })
      if (!this.itemAllowed(set, rel)) throw Object.assign(new Error('item excluded'), { code: 'not-selected' })
      const abs = joinInside(set, rel)
      if (!abs) throw Object.assign(new Error('invalid path'), { code: 'invalid-path' })
      const st = await statSafe(abs)
      if (!st) throw Object.assign(new Error('not found'), { code: 'missing' })
      if (st.size > Number(this.config.maxBlobBytes)) throw Object.assign(new Error('file too large'), { code: 'too-large' })
      const data = await fs.readFile(abs)
      return { set: set.id, rel, s: st.size, m: Math.round(st.mtimeMs), h: sha256hex(data), data: data.toString('base64') }
    }
    if (op === 'push') {
      const set = this.setById(String(request.set || ''))
      if (!set) throw Object.assign(new Error('unknown set'), { code: 'unknown-set' })
      const rel = String(request.rel || '')
      if (!setAllowsRel(set, rel)) throw Object.assign(new Error('invalid path'), { code: 'invalid-path' })
      // Files outside this device's item scope are refused, but not as an
      // error: the pushing side just reports them as skipped.
      if (!this.itemAllowed(set, rel)) return { ok: true, applied: 'skipped' }
      const data = Buffer.from(String(request.data || ''), 'base64')
      if (data.length > Number(this.config.maxBlobBytes)) throw Object.assign(new Error('file too large'), { code: 'too-large' })
      if (!request.h || sha256hex(data) !== request.h) throw Object.assign(new Error('push hash mismatch'), { code: 'corrupt' })
      const applied = await this.applyPushedFile(set, rel, data, Number(request.m) || Date.now(), request.h, context.peer)
      return { ok: true, ...applied }
    }
    // Extension ops (`ext.*`) are served by the dshSync broker if one is
    // installed; everything else is unknown. Default-deny lives in the broker.
    if (String(op).startsWith('ext.')) {
      if (!this.extRpcHandler) throw Object.assign(new Error('unknown op: ' + op), { code: 'unknown-op' })
      return this.extRpcHandler(request, context)
    }
    throw Object.assign(new Error('unknown op: ' + op), { code: 'unknown-op' })
  }

  /** Apply one file pushed by a paired peer. Machine config stays protected. */
  async applyPushedFile(set, rel, data, mtimeMs, hash, peer) {
    if (!setAllowsRel(set, rel)) throw Object.assign(new Error('invalid path'), { code: 'invalid-path' })
    const abs = joinInside(set, rel)
    if (!abs) throw Object.assign(new Error('invalid path'), { code: 'invalid-path' })
    const local = await statSafe(abs)

    if (set.mode === 'profile' && rel === 'package.json' && local) {
      const peerId = peer?.deviceId || 'peer'
      let localRaw = null
      let localParseError = null
      try { localRaw = JSON.parse(await fs.readFile(abs, 'utf8')) } catch (error) { localParseError = error }
      let remoteValue = null
      try { remoteValue = JSON.parse(data.toString('utf8')) } catch { throw Object.assign(new Error('invalid package.json'), { code: 'invalid' }) }
      if (localParseError) {
        // Never "repair" an unreadable local manifest by replacing it: the file
        // may hold the user's only copy. Park the peer version instead.
        const file = await this.parkInvalidLocal(set, rel, abs, peer, {
          mtimeMs: mtimeMs, hash: hash,
        }, await this.statEntry(abs), data)
        return { applied: 'conflict', file, bytes: 0 }
      }
      const merged = this.mergeLocalPackageJson(localRaw || {}, remoteValue)
      const recorded = await this.recordMergeSkips(set, rel, peer, merged.skipped)
      if (!merged.changed) return { applied: 'unchanged', conflicts: recorded }
      await writeAtomic(abs, JSON.stringify(merged.value, null, 2) + '\n', { mtimeMs: Math.max(mtimeMs, Math.round(local.mtimeMs)) })
      const written = await fs.readFile(abs)
      const writtenHash = sha256hex(written)
      const mtime = Math.round((await statSafe(abs))?.mtimeMs || Date.now())
      this.tombstones?.remove(set.id, rel)
      this.index.put(set.id, rel, { size: written.length, mtimeMs: mtime, hash: writtenHash })
      await this.journal.record(peerId, set.id, rel, { h: writtenHash, size: written.length, mtimeMs: mtime })
      return { applied: 'merged', bytes: written.length, conflicts: recorded }
    }

    if (set.mode === 'merge-credentials') {
      const result = await this.applyCredentials(set, rel, abs, { data, size: data.length, mtimeMs, hash }, peer)
      const applied = result.pulled ? 'merged' : result.deferred ? 'deferred' : 'unchanged'
      return { applied, bytes: result.bytes || 0, conflicts: result.conflicts }
    }

    if (set.mode === 'profile' && rel === 'cordis.patch.yml' && local && this.config.mergeModelConfig !== false) {
      const merged = await this.mergeLocalModelPatch(set, rel, abs, peer, await this.statEntry(abs), { data, size: data.length, mtimeMs, hash })
      if (merged) {
        return merged.kind === 'merged'
          ? { applied: 'merged', bytes: merged.bytes || 0, conflicts: merged.conflicts }
          : { applied: 'unchanged', conflicts: merged.conflicts }
      }
    }

    if (set.mode === 'profile' && PROTECTED_PROFILE_FILES.has(rel) && local) {
      const duplicate = this.conflicts.some((item) =>
        item.kind === 'protected' && item.set === set.id && item.rel === rel && item.peer === peer.deviceId && item.hash === hash)
      if (duplicate) return { applied: 'protected' }
      const file = join(dirname(abs), basename(conflictName(rel, peer.deviceId)))
      await writeAtomic(file, data, { mtimeMs })
      await this.addConflict({
        kind: 'protected',
        set: set.id,
        rel,
        peer: peer.deviceId,
        hash,
        file,
        at: new Date().toISOString(),
        note: '对端推送的配置未覆盖本机；对端版本已另存',
      })
      this.log('warn', `push kept local ${rel}; peer copy saved as ${basename(file)}`)
      return { applied: 'protected' }
    }

    if (set.mode === 'append' && local) {
      const localData = await fs.readFile(abs)
      if (localData.length <= data.length && data.subarray(0, localData.length).equals(localData)) {
        const tail = data.subarray(localData.length)
        if (tail.length) await appendBytes(abs, tail)
        const written = await fs.readFile(abs)
        const writtenHash = sha256hex(written)
        const mtime = Math.round((await statSafe(abs))?.mtimeMs || Date.now())
        this.tombstones?.remove(set.id, rel)
      this.index.put(set.id, rel, { size: written.length, mtimeMs: mtime, hash: writtenHash })
        await this.journal.record(peer.deviceId, set.id, rel, { h: writtenHash, size: written.length, mtimeMs: mtime })
        return { applied: 'appended', bytes: tail.length }
      }
      const file = join(dirname(abs), basename(conflictName(rel, peer.deviceId, { session: true })))
      await writeAtomic(file, data, { mtimeMs })
      await this.addConflict({ kind: 'push-session', set: set.id, rel, peer: peer.deviceId, hash, file, at: new Date().toISOString(), note: '对端推送的会话与本机分叉，已另存' })
      return { applied: 'conflict' }
    }

    if (set.mode === 'merge-workspace' && local) {
      const localBuf = await fs.readFile(abs)
      let localValue = null
      let localParseError = null
      try { localValue = JSON.parse(localBuf.toString('utf8')) } catch (error) { localParseError = error }
      let remoteValue = null
      try { remoteValue = JSON.parse(data.toString('utf8')) } catch { throw Object.assign(new Error('invalid workspace JSON'), { code: 'invalid' }) }
      if (localParseError) {
        const file = await this.parkInvalidLocal(set, rel, abs, peer, {
          mtimeMs: Math.round(local.mtimeMs), hash,
        }, await this.statEntry(abs), data)
        return { applied: 'conflict', file, bytes: 0 }
      }
      const merged = mergeWorkspace(localValue || {}, remoteValue)
      if (!merged.changed) return { applied: 'unchanged' }
      await writeAtomic(abs, JSON.stringify(merged.value, null, 2) + '\n', { mtimeMs: Math.max(mtimeMs, Math.round(local.mtimeMs)) })
      const written = await fs.readFile(abs)
      const writtenHash = sha256hex(written)
      const mtime = Math.round((await statSafe(abs))?.mtimeMs || Date.now())
      this.tombstones?.remove(set.id, rel)
      this.index.put(set.id, rel, { size: written.length, mtimeMs: mtime, hash: writtenHash })
      await this.journal.record(peer.deviceId, set.id, rel, { h: writtenHash, size: written.length, mtimeMs: mtime })
      return { applied: 'merged', bytes: written.length }
    }

    if (local && set.id !== 'modules' && Number(this.config.keepBackups) !== 0) {
      try {
        const backup = join(dirname(abs), `${basename(abs)}.bak-sync-${peer.deviceId.slice(0, 6)}-${Date.now()}`)
        await fs.copyFile(abs, backup)
      } catch {}
    }
    await writeAtomic(abs, data, { mtimeMs })
    const writtenHash = sha256hex(await fs.readFile(abs))
    const mtime = Math.round((await statSafe(abs))?.mtimeMs || Date.now())
    this.tombstones?.remove(set.id, rel)
    this.index.put(set.id, rel, { size: data.length, mtimeMs: mtime, hash: writtenHash })
    await this.journal.record(peer.deviceId, set.id, rel, { h: writtenHash, size: data.length, mtimeMs: mtime })
    this.log('info', `push applied ${set.id}/${rel} (${data.length} bytes)`)
    return { applied: 'written', bytes: data.length }
  }

  async fetchRemote(set, rel, remoteEntry, client) {
    // Enforce this device's inbound limit *before* and *after* the transfer: a
    // peer with a larger maxBlobBytes must not be able to fill our disk, and a
    // wrong size declaration must fail loudly instead of being swallowed.
    const limit = Number(this.config.maxBlobBytes) || DEFAULTS.maxBlobBytes
    const declared = Number(remoteEntry?.s ?? remoteEntry?.size ?? 0)
    if (declared > limit) {
      throw new Error(`peer file too large for this device: ${declared} bytes > maxBlobBytes ${limit}`)
    }
    const pulled = await client.rpc('pull', { set: set.id, rel })
    const size = Number(pulled.s)
    if (size > limit) {
      throw new Error(`peer returned ${size} bytes, over this device's maxBlobBytes ${limit}`)
    }
    const data = Buffer.from(String(pulled.data || ''), 'base64')
    if (data.length !== size || sha256hex(data) !== pulled.h) {
      throw new Error('peer returned a corrupted payload')
    }
    if (remoteEntry?.h && remoteEntry.h !== pulled.h) throw new Error('file changed during transfer, retry later')
    return { data, size, mtimeMs: Number(pulled.m), hash: pulled.h }
  }

  async applyPull(set, rel, remoteEntry, peer, client) {
    if (!setAllowsRel(set, rel)) throw new Error('invalid path')
    const abs = joinInside(set, rel)
    if (!abs) throw new Error('invalid path')
    const remote = await this.fetchRemote(set, rel, remoteEntry, client)
    if (set.mode === 'append') return this.applySession(set, rel, abs, remote, peer)
    if (set.mode === 'merge-workspace') return this.applyWorkspace(set, rel, abs, remote, peer)
    if (set.mode === 'merge-credentials') return this.applyCredentials(set, rel, abs, remote, peer)
    return this.applyReplace(set, rel, abs, remote, peer)
  }

  /**
   * Merge `$DSH_HOME/.credentials.yaml`: only `*API_KEY` refs travel, `records:`
   * and account tokens stay local, and an existing different value is never
   * overwritten. Values are never logged.
   */
  async applyCredentials(set, rel, abs, remote, peer) {
    // This merge mode only ever serves the credentials store.
    if (rel !== '.credentials.yaml') throw new Error('merge-credentials only handles .credentials.yaml')
    const peerId = peer?.deviceId || 'peer'
    const localStat = await statSafe(abs)
    const localBuf = localStat ? await fs.readFile(abs) : null
    const localText = localBuf ? localBuf.toString('utf8') : ''
    const remoteText = remote.data.toString('utf8')
    const merged = mergeCredentialRefs(localText, remoteText)
    let recorded = 0
    for (const item of merged.conflicts) {
      const added = await this.addConflict({
        kind: 'credential-conflict',
        set: set.id,
        rel,
        peer: peerId,
        item: item.name,
        at: new Date().toISOString(),
        note: `${item.name}: ${item.reason || '本机已有不同取值，未覆盖'}`,
      })
      if (added) recorded++
    }
    for (const name of merged.skipped) {
      const added = await this.addConflict({
        kind: 'credential-skipped',
        set: set.id,
        rel,
        peer: peerId,
        item: name,
        at: new Date().toISOString(),
        note: `${name}: 该 ref 是多行/块格式，未自动合并，请手动处理`,
      })
      if (added) recorded++
    }
    if (!merged.changed) {
      // Nothing to add: remember the local hash with the peer hash as
      // `divergedH` so later cycles skip the fetch until the peer file changes.
      if (localBuf) {
        this.journal.record(peerId, set.id, rel, {
          h: sha256hex(localBuf),
          size: localBuf.length,
          mtimeMs: Math.round(localStat.mtimeMs),
          divergedH: remote.hash,
        })
      }
      return { pulled: false, conflicts: recorded || undefined }
    }
    // DSH keeps this file in memory and rewrites it on exit: never fight a file
    // that changed moments ago. A future mtime (clock skew / test fixtures) is
    // not "recently changed", so it must not defer forever.
    const age = localStat ? Date.now() - localStat.mtimeMs : Infinity
    if (localStat && age >= 0 && age < this.stableAfterMs()) {
      this.log('info', 'credentials changed recently; deferring merge until next cycle (a DSH restart may be required)')
      return { pulled: false, deferred: true, conflicts: recorded || undefined }
    }
    if (localStat && Number(this.config.keepBackups) !== 0) {
      try {
        await fs.copyFile(abs, `${abs}.bak-sync-${syncStamp()}`)
      } catch {}
    }
    const text = merged.text.endsWith('\n') ? merged.text : merged.text + '\n'
    await writeAtomic(abs, text, { mtimeMs: remote.mtimeMs })
    const written = await fs.readFile(abs)
    const hash = sha256hex(written)
    const mtimeMs = Math.round((await statSafe(abs))?.mtimeMs || Date.now())
    this.journal.record(peerId, set.id, rel, { h: hash, size: written.length, mtimeMs, divergedH: remote.hash })
    this.index.put(set.id, rel, { size: written.length, mtimeMs, hash })
    this.log('info', `merged ${merged.added.length} apiKey ref(s) into .credentials.yaml from ${peerId.slice(0, 8)}; restart DSH to apply`)
    this.emit('merged', { set: set.id, rel, from: peerId })
    return { pulled: true, merged: true, bytes: written.length, conflicts: recorded || undefined }
  }

  async applyReplace(set, rel, abs, remote, peer) {
    const local = await statSafe(abs)
    if (local) {
      const localHash = await hashFileStream(abs).catch(() => null)
      if (localHash === remote.hash) {
        await this.journal.record(peer.deviceId, set.id, rel, journalFetched(remote))
        this.index.put(set.id, rel, { size: remote.size, mtimeMs: remote.mtimeMs, hash: remote.hash })
        return { pulled: false }
      }
      // `modules` mirrors dependency packages: backing them up would multiply
      // the disk footprint for no recovery value.
      if (set.id !== 'modules' && Number(this.config.keepBackups) !== 0) {
        try {
          const backup = join(dirname(abs), `${basename(abs)}.bak-sync-${this.identity.deviceId.slice(0, 6)}-${Date.now()}`)
          await fs.copyFile(abs, backup)
        } catch {}
      }
    }
    try {
      await writeAtomic(abs, remote.data, { mtimeMs: remote.mtimeMs })
    } catch (error) {
      throw new Error(`cannot write ${rel}: ${error.message}`)
    }
    const hash = sha256hex(await fs.readFile(abs))
    await this.journal.record(peer.deviceId, set.id, rel, { h: hash, size: remote.size, mtimeMs: remote.mtimeMs })
    this.index.put(set.id, rel, { size: remote.size, mtimeMs: remote.mtimeMs, hash })
    this.tombstones?.remove(set.id, rel)
    this.log('info', `pulled ${set.id}/${rel} (${remote.size} bytes) from ${peer.deviceId.slice(0, 8)}`)
    this.emit('pulled', { set: set.id, rel, from: peer.deviceId })
    return { pulled: true, bytes: remote.size }
  }

  async applyWorkspace(set, rel, abs, remote, peer) {
    const peerId = peer?.deviceId || 'peer'
    const localStat = await statSafe(abs)
    const localBuf = localStat ? await fs.readFile(abs) : null
    let localValue = null
    let localParseError = null
    if (localBuf) {
      try { localValue = JSON.parse(localBuf.toString('utf8')) } catch (error) { localParseError = error }
    }
    let remoteValue = null
    try { remoteValue = JSON.parse(remote.data.toString('utf8')) } catch { throw new Error('peer sent invalid workspace JSON') }
    if (localParseError) {
      // A local file we cannot parse must never be replaced by the peer copy:
      // the union merge would silently drop whatever is in there.
      if (localBuf.equals(remote.data)) {
        await this.journal.record(peerId, set.id, rel, journalFetched(remote))
        return { merged: false, conflict: false }
      }
      const localHash = sha256hex(localBuf)
      const file = await this.parkInvalidLocal(set, rel, abs, peer, remote, {
        h: localHash, s: localBuf.length, m: Math.round(localStat.mtimeMs),
      }, remote.data)
      return { merged: false, conflict: true, file, bytes: 0 }
    }
    const merged = mergeWorkspace(localValue || {}, remoteValue)
    const serialized = JSON.stringify(merged.value, null, 2) + '\n'
    if (localStat && localBuf && localBuf.toString('utf8') === serialized) {
      // No local change: remember the peer's version as the agreed base so the
      // next cycle does not re-fetch the same file.
      await this.journal.record(peerId, set.id, rel, { h: remote.hash, size: remote.size, mtimeMs: remote.mtimeMs })
      return { merged: false }
    }
    await writeAtomic(abs, serialized, { mtimeMs: Math.max(remote.mtimeMs, Math.round(localStat?.mtimeMs || 0)) })
    const data = await fs.readFile(abs)
    const hash = sha256hex(data)
    await this.journal.record(peerId, set.id, rel, { h: hash, size: data.length, mtimeMs: Date.now() })
    this.index.put(set.id, rel, { size: data.length, mtimeMs: Math.round((await statSafe(abs))?.mtimeMs || Date.now()), hash })
    this.log('info', `merged workspace from ${peerId.slice(0, 8)} (${merged.changed ? 'changed' : 'unchanged'})`)
    this.emit('merged', { set: set.id, rel, from: peerId })
    return { merged: merged.changed, bytes: merged.changed ? Buffer.byteLength(serialized) : 0 }
  }

  async applyWorkspaceMerge(set, rel, remoteEntry, client, peer = null) {
    const abs = joinInside(set, rel)
    if (!abs) throw new Error('invalid path')
    const remote = await this.fetchRemote(set, rel, remoteEntry, client)
    return this.applyWorkspace(set, rel, abs, remote, peer || { deviceId: 'peer' })
  }

  /**
   * Profile files are not plain last-write-wins:
   * - package.json merges dependencies and bundles additively;
   * - cordis.patch.yml merges only the whitelisted model blocks, everything
   *   else in the file stays byte-identical;
   * - other machine-owned config files keep the local copy and park the peer copy.
   */
  async applyProfileSpecial(set, rel, remote, peer, client, local, base, decision) {
    if (set.mode !== 'profile' || !remote) return null
    const abs = joinInside(set, rel)
    if (!abs) return null
    if (rel === 'package.json') {
      if (!local || (decision.action !== PULL && decision.action !== MERGE)) return null
      const pulled = await this.fetchRemote(set, rel, remote, client)
      const peerId = peer?.deviceId || 'peer'
      let localRaw = null
      let localParseError = null
      if (await statSafe(abs)) {
        try { localRaw = JSON.parse(await fs.readFile(abs, 'utf8')) } catch (error) { localParseError = error }
      }
      let remoteValue = null
      try { remoteValue = JSON.parse(pulled.data.toString('utf8')) } catch { throw new Error('peer sent invalid package.json') }
      if (localParseError) {
        // The local manifest exists but does not parse: keep it verbatim (it may
        // be the only copy of the user's plugin list) and park the peer's.
        const file = await this.parkInvalidLocal(set, rel, abs, peer, pulled, local, pulled.data)
        return { kind: 'conflict', file }
      }
      const merged = this.mergeLocalPackageJson(localRaw || {}, remoteValue)
      const conflicts = await this.recordMergeSkips(set, rel, peer, merged.skipped)
      if (!merged.changed) {
        // Record the agreed local hash but *not* `divergedH`: when entries were
        // skipped because this machine lacks them, the next cycle must try again
        // so installing the plugin (or `dsh plugin install`) is picked up.
        await this.journal.record(peerId, set.id, rel, { h: local.h, s: local.s, m: local.m })
        return { kind: 'skipped', conflicts }
      }
      const serialized = JSON.stringify(merged.value, null, 2) + '\n'
      await writeAtomic(abs, serialized, { mtimeMs: Date.now() })
      const data = await fs.readFile(abs)
      const hash = sha256hex(data)
      const mtimeMs = Math.round((await statSafe(abs))?.mtimeMs || Date.now())
      await this.journal.record(peerId, set.id, rel, { h: hash, size: data.length, mtimeMs })
      this.index.put(set.id, rel, { size: data.length, mtimeMs, hash })
      this.log('info', `merged profile/package.json from ${peerId.slice(0, 8)}${conflicts ? ` (${conflicts} skipped entries)` : ''}`)
      this.emit('merged', { set: set.id, rel, from: peerId })
      return { kind: 'merged', bytes: data.length, conflicts }
    }
    // Model blocks are merged three-way (block-level bases), so this must not be
    // gated by `decide() === PULL`: a locally rewritten file (DSH does that at
    // runtime) has a newer mtime and would otherwise never pick up peer changes.
    if (rel === 'cordis.patch.yml' && local && this.config.mergeModelConfig !== false) {
      const parked = base?.divergedH === remote.h && (!base?.h || base.h === local.h)
      if (!parked) {
        const pulled = await this.fetchRemote(set, rel, remote, client)
        const merged = await this.mergeLocalModelPatch(set, rel, abs, peer, local, pulled)
        if (merged) return merged
      }
    }
    if (PROTECTED_PROFILE_FILES.has(rel) && local && decision.action === PULL) {
      const duplicate = this.conflicts.some((item) =>
        item.kind === 'protected' && item.set === set.id && item.rel === rel && item.peer === peer.deviceId && item.hash === remote.h)
      // Park the divergence so later cycles skip it; the local file wins.
      await this.journal.record(peer.deviceId, set.id, rel, { h: local.h, s: local.s, m: local.m, divergedH: remote.h })
      if (duplicate) return { kind: 'skipped' }
      const pulled = await this.fetchRemote(set, rel, remote, client)
      const name = basename(conflictName(rel, peer.deviceId))
      const file = join(dirname(abs), name)
      await writeAtomic(file, pulled.data, { mtimeMs: pulled.mtimeMs })
      await this.addConflict({
        kind: 'protected',
        set: set.id,
        rel,
        peer: peer.deviceId,
        hash: remote.h,
        file,
        at: new Date().toISOString(),
        note: '本机配置按机器保护，未覆盖；对端版本已另存',
      })
      this.log('warn', `kept local ${rel}; peer copy saved as ${name}`)
      this.emit('protected', { set: set.id, rel, peer: peer.deviceId, file })
      return { kind: 'conflict' }
    }
    return null
  }

  /**
   * Merge the whitelisted model blocks of a local `cordis.patch.yml`.
   * Shared by the pull path and the push path. `remote` is the fetched payload
   * `{data,size,mtimeMs,hash}`; `localEntry` is the index entry for the file.
   */
  async mergeLocalModelPatch(set, rel, abs, peer, localEntry, remote) {
    const peerId = peer?.deviceId || 'peer'
    const localText = await fs.readFile(abs, 'utf8').catch(() => null)
    if (localText === null) return null
    const remoteText = remote.data.toString('utf8')
    const baseHashes = {}
    const names = new Set([...modelBlockNames(localText), ...modelBlockNames(remoteText)])
    for (const name of names) {
      const stored = await this.journal.base(peerId, set.id, `cordis.patch.yml::${name}`)
      if (stored?.h) baseHashes[name] = stored.h
    }
    const localStat = await statSafe(abs)
    const merged = mergeModelBlocks(localText, remoteText, baseHashes, {
      localUpdatedAt: Math.round(localStat?.mtimeMs || 0),
      remoteUpdatedAt: Math.round(Number(remote.mtimeMs) || 0),
    })
    let conflicts = 0
    for (const conflict of merged.conflicts) {
      const added = await this.addConflict({
        kind: 'model-config-conflict',
        set: set.id,
        rel,
        peer: peerId,
        item: conflict.name,
        at: new Date().toISOString(),
        note: `${conflict.reason}（块 ${conflict.name}）`,
      })
      if (added) conflicts++
    }
    if (!merged.changed) {
      // Park the whole file until one side changes again: the only thing that
      // could change is a whitelisted block, which is tracked separately.
      await this.journal.record(peerId, set.id, rel, {
        h: localEntry?.h,
        s: localEntry?.s,
        m: localEntry?.m,
        divergedH: remote.hash,
      })
      return { kind: 'skipped', conflicts: conflicts || undefined }
    }
    if (Number(this.config.keepBackups) !== 0) {
      try { await fs.copyFile(abs, `${abs}.bak-model-${syncStamp()}`) } catch {}
    }
    const text = merged.text.endsWith('\n') ? merged.text : merged.text + '\n'
    await writeAtomic(abs, text)
    const written = await fs.readFile(abs)
    const hash = sha256hex(written)
    const mtimeMs = Math.round((await statSafe(abs))?.mtimeMs || Date.now())
    for (const [name, blockHashValue] of Object.entries(merged.bases)) {
      await this.journal.record(peerId, set.id, `cordis.patch.yml::${name}`, { h: blockHashValue })
    }
    await this.journal.record(peerId, set.id, rel, { h: hash, size: written.length, mtimeMs, divergedH: remote.hash })
    this.index.put(set.id, rel, { size: written.length, mtimeMs, hash })
    this.log('info', `merged model config blocks from ${peerId.slice(0, 8)} (${merged.adopted.length}); restart DSH to apply`)
    this.emit('merged', { set: set.id, rel, from: peerId })
    return { kind: 'merged', bytes: written.length, conflicts: conflicts || undefined }
  }

  async applySession(set, rel, abs, remote, peer) {
    const local = await statSafe(abs)
    if (local && this.config.skipLiveSessions !== false) {
      const sessionDir = rel.split('/').slice(-2, -1)[0] || ''
      let live = false
      try { live = Boolean(this.hooks.isSessionLive?.(sessionDir)) } catch {}
      if (live) {
        this.log('info', `deferring ${rel}: session is open in this process`)
        return { pulled: false, deferred: true }
      }
    }
    if (!local) {
      await writeAtomic(abs, remote.data, { mtimeMs: remote.mtimeMs })
      const hash = sha256hex(remote.data)
      await this.journal.record(peer.deviceId, set.id, rel, { h: hash, size: remote.size, mtimeMs: remote.mtimeMs })
      this.index.put(set.id, rel, { size: remote.size, mtimeMs: remote.mtimeMs, hash })
      this.tombstones?.remove(set.id, rel)
      this.log('info', `pulled new session ${rel}`)
      this.emit('pulled', { set: set.id, rel, from: peer.deviceId })
      return { pulled: true, bytes: remote.size }
    }
    if (Date.now() - local.mtimeMs < this.stableAfterMs()) {
      return { pulled: false, deferred: true }
    }
    if (local.size === remote.size) {
      const hash = await hashFileStream(abs)
      if (hash === remote.hash) {
        await this.journal.record(peer.deviceId, set.id, rel, journalFetched(remote))
        return { pulled: false }
      }
      return this.parkSessionConflict(set, rel, abs, remote, peer)
    }
    if (local.size < remote.size) {
      const head = await fs.open(abs, 'r')
      let isPrefix = false
      try {
        const length = local.size
        const localBuf = Buffer.alloc(length)
        const { bytesRead } = await head.read(localBuf, 0, length, 0)
        isPrefix = bytesRead === length && remote.data.subarray(0, length).equals(localBuf)
      } finally {
        await head.close().catch(() => {})
      }
      if (!isPrefix) return this.parkSessionConflict(set, rel, abs, remote, peer)
      const tail = remote.data.subarray(local.size)
      await appendBytes(abs, tail)
      const hash = await hashFileStream(abs)
      if (hash !== remote.hash) {
        throw new Error('append verification failed for ' + rel)
      }
      await this.journal.record(peer.deviceId, set.id, rel, { h: hash, size: remote.size, mtimeMs: remote.mtimeMs })
      this.index.put(set.id, rel, { size: remote.size, mtimeMs: remote.mtimeMs, hash })
      this.log('info', `appended ${tail.length} bytes to ${rel}`)
      this.emit('pulled', { set: set.id, rel, from: peer.deviceId, append: tail.length })
      return { pulled: true, bytes: tail.length }
    }
    // Local is longer: it is ahead unless the two diverged.
    const localBuf = await fs.readFile(abs).catch(() => null)
    if (localBuf && localBuf.subarray(0, remote.size).equals(remote.data)) {
      await this.journal.record(peer.deviceId, set.id, rel, journalFetched(remote))
      return { pulled: false }
    }
    return this.parkSessionConflict(set, rel, abs, remote, peer)
  }

  async parkSessionConflict(set, rel, abs, remote, peer, localEntry = null) {
    let entry = localEntry || this.index.get(set.id, rel)
    if (!entry?.h) {
      const st = await statSafe(abs)
      if (st) entry = { h: await hashFileStream(abs), s: st.size, m: Math.round(st.mtimeMs) }
    }
    const duplicate = this.conflicts.some((item) => item.set === set.id && item.rel === rel && item.peer === peer.deviceId && item.hash === remote.hash)
    if (duplicate) {
      await this.journal.record(peer.deviceId, set.id, rel, { h: entry?.h, s: entry?.s, m: entry?.m, divergedH: remote.hash })
      return { conflict: false, deferred: true }
    }
    const target = join(dirname(abs), 'conflicts')
    await ensureDir(target)
    const name = basename(conflictName(rel, peer.deviceId, { session: true }))
    const file = join(target, name)
    await writeAtomic(file, remote.data, { mtimeMs: remote.mtimeMs })
    await this.journal.record(peer.deviceId, set.id, rel, {
      h: entry?.h,
      size: entry?.s,
      mtimeMs: entry?.m,
      divergedH: remote.hash,
    })
    await this.addConflict({ set: set.id, rel, peer: peer.deviceId, file, hash: remote.hash, at: new Date().toISOString(), bytes: remote.size })
    this.log('warn', `session diverged: ${rel}; peer copy saved to conflicts/${name}`)
    this.emit('conflict', { set: set.id, rel, peer: peer.deviceId, file })
    return { conflict: true }
  }

  async parkConflict(set, rel, remoteEntry, peer, client, local) {
    const remote = await this.fetchRemote(set, rel, remoteEntry, client)
    const abs = joinInside(set, rel)
    const name = basename(conflictName(rel, peer.deviceId, { session: false }))
    const file = join(dirname(abs), name)
    await writeAtomic(file, remote.data, { mtimeMs: remote.mtimeMs })
    await this.journal.record(peer.deviceId, set.id, rel, { h: local?.h, s: local?.s, m: local?.m, divergedH: remote.hash })
    await this.addConflict({ set: set.id, rel, peer: peer.deviceId, file, at: new Date().toISOString(), bytes: remote.size })
    this.log('warn', `conflict parked for ${rel}: ${file}`)
    return { conflict: true }
  }

  /** Merge profile manifests with this machine's bundle/link probes injected. */
  mergeLocalPackageJson(localValue, remoteValue) {
    const resolver = this.profileBundleResolver()
    return mergePackageJson(localValue, remoteValue, {
      resolveBundle: (name) => resolver.resolveBundle(name),
      linkTargetExists: (spec) => resolver.linkTargetExists(spec),
    })
  }

  async statEntry(abs) {
    const st = await statSafe(abs)
    if (!st) return null
    return { h: await hashFileStream(abs).catch(() => null), s: st.size, m: Math.round(st.mtimeMs) }
  }

  /**
   * Park the peer copy of a local file that exists but cannot be parsed.
   * The local bytes are never rewritten: an unreadable manifest may still hold
   * settings that only exist there, so the safe move is to keep it and leave a
   * recovery copy next to it.
   */
  async parkInvalidLocal(set, rel, abs, peer, remote, localEntry, data) {
    const peerId = peer?.deviceId || 'peer'
    const remoteHash = remote?.hash || remote?.h || sha256hex(data)
    const existing = this.conflicts.find((item) =>
      item.kind === 'invalid-local' && item.set === set.id && item.rel === rel && item.peer === peerId && item.hash === remoteHash)
    if (existing?.file) return existing.file
    const name = basename(conflictName(rel, peerId))
    const file = join(dirname(abs), name)
    await writeAtomic(file, data, { mtimeMs: remote?.mtimeMs || remote?.m || 0 })
    if (localEntry?.h) {
      // Recording the local hash as the base with the peer hash as `divergedH`
      // parks the divergence, so later cycles do not re-park the same file.
      await this.journal.record(peerId, set.id, rel, {
        h: localEntry.h,
        s: localEntry.s ?? localEntry.size ?? 0,
        m: localEntry.m ?? localEntry.mtimeMs ?? 0,
        divergedH: remoteHash,
      })
    }
    await this.addConflict({
      kind: 'invalid-local',
      set: set.id,
      rel,
      peer: peerId,
      hash: remoteHash,
      file,
      at: new Date().toISOString(),
      note: '本机文件不是合法 JSON，未覆盖本机内容；对端版本已另存',
    })
    this.log('warn', `kept unparsable local ${rel}; peer copy saved as ${name}`)
    this.emit('conflict', { set: set.id, rel, peer: peerId, file })
    return file
  }

  /** Record manifest entries the merge refused to adopt instead of dropping them. */
  async recordMergeSkips(set, rel, peer, skipped) {
    let recorded = 0
    for (const item of Array.isArray(skipped) ? skipped : []) {
      const added = await this.addConflict({
        kind: item.kind || 'bundle-unavailable',
        set: set.id,
        rel,
        peer: peer?.deviceId || 'peer',
        item: item.name || '',
        at: new Date().toISOString(),
        note: item.note || `对端条目 ${item.name || ''} 未并入本机`,
      })
      if (added) recorded++
    }
    return recorded
  }

  async addConflict(item) {
    if (!isPlainObject(item)) return false
    const duplicate = this.conflicts.some((entry) =>
      entry.set === item.set && entry.rel === item.rel && entry.peer === item.peer &&
      entry.kind === item.kind && entry.hash === item.hash && (entry.item || '') === (item.item || ''))
    if (duplicate) return false
    const record = normalizeConflictRecord(item)
    if (record.file && !record.size) {
      const stat = await statSafe(resolve(record.file))
      if (stat) record.size = stat.size
    }
    this.conflicts.unshift(record)
    if (this.conflicts.length > MAX_CONFLICTS) this.conflicts.length = MAX_CONFLICTS
    await this.saveConflicts()
    await this.saveCleanup()
    return true
  }

  async saveConflicts() {
    try {
      await writeJson(join(this.stateDir, CONFLICT_FILE), { version: 1, items: this.conflicts })
    } catch (error) {
      this.log('warn', `conflicts write failed: ${error.message}`)
    }
  }

  /**
   * Cleanup state mirror (atomic, capped). `cleanup.json` lets the panel read
   * the conflict list even when `conflicts.json` was written by an older build.
   */
  async saveCleanup() {
    try {
      await writeJson(join(this.stateDir, CLEANUP_FILE), {
        version: 1,
        savedAt: new Date().toISOString(),
        settings: { ...this.settings.cleanup },
        conflicts: this.conflicts.slice(0, MAX_CLEANUP_RECORDS),
      })
    } catch (error) {
      this.log('warn', `cleanup.json write failed: ${error.message}`)
    }
  }

  async loadCleanup() {
    const { value } = await readJsonDetailed(join(this.stateDir, CLEANUP_FILE), null)
    if (value && Array.isArray(value.conflicts) && this.conflicts.length === 0) {
      this.conflicts = value.conflicts.map(normalizeConflictRecord).filter(Boolean)
    }
    this.recycleCount = await this.scanRecycle()
  }

  cleanupStats() {
    const conflictBytes = this.conflicts.reduce((sum, item) => sum + (Number(item.size) || 0), 0)
    return {
      conflictCount: this.conflicts.length,
      conflictBytes,
      recycleCount: Number(this.recycleCount) || 0,
    }
  }

  /** Days since the conflict copy was last accessed, falling back to creation. */
  conflictActiveDays(conflict, now = Date.now()) {
    const stamp = Date.parse(conflict?.lastAccessAt || conflict?.createdAt || conflict?.at || '')
    if (!Number.isFinite(stamp) || stamp <= 0) return 0
    return Math.max(0, (now - stamp) / 86_400_000)
  }

  /**
   * Path-level allowlist for conflict/backup cleanup:
   *   a) `<stateDir>/conflicts/**` (engine-owned conflict area, always allowed);
   *   b) inside the root of the *exact* set the conflict record belongs to
   *      (`setId`), and only when the name matches one of the engine's parked
   *      copy patterns or the path lives in a `conflicts/` directory.
   * A missing/disabled set id, a path in another set's root, parent escapes,
   * unrelated names — all refused.
   */
  managedConflictScope(file, setId = null) {
    if (!file) return null
    const raw = String(file)
    // Reject traversal before resolve() hides it: `..` can never be legitimate.
    if (raw.split(/[\\/]+/).includes('..')) return null
    const abs = resolve(raw)
    const stateConflicts = join(this.stateDir, CONFLICT_DIR)
    if (isInside(stateConflicts, abs)) return stateConflicts
    if (!setId) return null
    // `setById` only resolves enabled sets, so a disabled set is refused too.
    const set = this.setById(String(setId))
    if (!set || !set.root) return null
    if (!isInside(set.root, abs)) return null
    const rel = relative(set.root, abs).split(sep).join('/')
    if (!rel || rel.startsWith('../') || isAbsolute(rel)) return null
    const parts = rel.split('/')
    const name = parts[parts.length - 1] || ''
    const inConflictsDir = parts.slice(0, -1).includes('conflicts')
    if (!inConflictsDir && !isConflictCopyName(name) && !isBackupFileName(name)) return null
    return set.root
  }

  /**
   * Async containment check: resolves symlinks on both sides so a link planted
   * inside a set root can never expose a file outside it.
   */
  async isManagedConflictPath(file, setId = null) {
    const scope = this.managedConflictScope(file, setId)
    if (!scope) return false
    const abs = resolve(String(file))
    const realScope = await fs.realpath(scope).catch(() => null)
    if (!realScope) return false
    const realFile = await fs.realpath(abs).catch(() => null)
    if (!realFile) return false
    return isInside(realScope, realFile)
  }

  async scanRecycle() {
    const files = await this.listRecycleFiles()
    this.recycleCount = files.length
    return this.recycleCount
  }

  async listRecycleFiles() {
    const root = join(this.stateDir, RECYCLE_DIR)
    const out = []
    const walk = async (dir) => {
      let entries
      try {
        entries = await fs.readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        const abs = join(dir, entry.name)
        if (entry.isDirectory()) {
          await walk(abs)
        } else if (entry.isFile()) {
          const stat = await statSafe(abs)
          out.push({ abs, mtimeMs: stat?.mtimeMs || 0, size: stat?.size || 0 })
        }
      }
    }
    await walk(root)
    return out
  }

  /** Keep the recycle bin below `recycleMax`, dropping the oldest entries first. */
  async pruneRecycle() {
    const max = normalizeInt(this.settings.cleanup.recycleMax, { min: 1, max: 1000, fallback: 100 })
    const files = await this.listRecycleFiles()
    if (files.length <= max) {
      this.recycleCount = files.length
      return 0
    }
    files.sort((a, b) => a.mtimeMs - b.mtimeMs)
    let removed = 0
    for (const file of files.slice(0, files.length - max)) {
      try {
        await fs.rm(file.abs, { force: true })
        removed++
      } catch {}
    }
    this.recycleCount = files.length - removed
    return removed
  }

  async recycleConflictFile(abs) {
    const dir = join(this.stateDir, RECYCLE_DIR, syncStamp())
    await ensureDir(dir)
    const target = join(dir, `${Date.now()}-${basename(abs)}`)
    try {
      await fs.rename(abs, target)
    } catch {
      await fs.copyFile(abs, target)
      await fs.rm(abs, { force: true })
    }
    await this.pruneRecycle()
    return target
  }

  /** Move/remove one conflict copy; reports whether the record can be dropped. */
  async releaseConflictFile(conflict, { recycle } = {}) {
    if (!conflict?.file) return { removed: true, freed: 0 }
    const abs = resolve(String(conflict.file))
    const stat = await statSafe(abs)
    if (!stat) return { removed: true, freed: 0 }
    // b) is scoped to the set the record claims; a forged record pointing into
    // another set's tree is refused.
    if (!await this.isManagedConflictPath(abs, conflict.set)) return { removed: false, freed: 0, skipped: true }
    const useRecycle = recycle === undefined ? this.settings.cleanup.recycle : Boolean(recycle)
    try {
      if (useRecycle) {
        await this.recycleConflictFile(abs)
      } else {
        await fs.rm(abs, { force: true })
        await this.pruneRecycle()
      }
    } catch (error) {
      this.log('warn', `cannot remove conflict copy: ${error.message}`)
      return { removed: false, freed: 0, skipped: true }
    }
    return { removed: true, freed: stat.size }
  }

  /** Files named `*.bak-sync-*` below one set root, skipping ignored dirs. */
  async findBackupFiles(root) {
    const out = []
    const walk = async (dir, prefix) => {
      let entries
      try {
        entries = await fs.readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        const rel = prefix ? prefix + '/' + entry.name : entry.name
        if (entry.isSymbolicLink()) continue
        if (entry.isDirectory()) {
          if (isIgnored(rel)) continue
          await walk(join(dir, entry.name), rel)
        } else if (entry.isFile() && isBackupFileName(entry.name)) {
          out.push(join(dir, entry.name))
        }
      }
    }
    await walk(resolve(root), '')
    return out
  }

  /**
   * Recycle/remove `.bak-sync-*` files older than `backupDays`. Scans the roots
   * of enabled sets, one set at a time so every file is checked against the
   * set it is found in. `credentials` (root = `$DSH_HOME`) is skipped on
   * purpose: scanning the whole home for backups would be expensive and could
   * touch user files, and credentials backups follow the same 45-day policy
   * only when the set-level cleanup is revisited in a later phase.
   */
  async cleanupBackups({ now = Date.now() } = {}) {
    const result = { removed: 0, freed: 0, skipped: 0 }
    if (this.settings.cleanup.backups === false) return result
    const days = normalizeInt(this.settings.cleanup.backupDays, { min: 1, max: 3650, fallback: 45 })
    const cutoff = now - days * 86_400_000
    const scanned = new Set()
    for (const set of this.enabledSets()) {
      if (set.id === 'credentials' || set.id === 'modules') continue
      const root = resolve(set.root)
      if (scanned.has(root)) continue
      scanned.add(root)
      for (const abs of await this.findBackupFiles(root)) {
        // Re-check the exact engine naming pattern before touching the file.
        if (!isBackupFileName(basename(abs))) continue
        const stat = await statSafe(abs)
        if (!stat || stat.mtimeMs >= cutoff) continue
        const released = await this.releaseConflictFile({ file: abs, set: set.id })
        if (!released.removed) {
          if (released.skipped) result.skipped++
          continue
        }
        result.removed++
        result.freed += released.freed || 0
      }
    }
    return result
  }

  /** Delete expired conflict copies (never ones marked "keep") plus old backups. */
  async cleanupNow({ now = Date.now() } = {}) {
    const retention = Number(this.settings.cleanup.retentionDays) || 0
    let removed = 0
    let freed = 0
    let skipped = 0
    // 0 means "keep conflicts forever". Backups still follow their own
    // `backupDays` setting and are handled below.
    if (retention > 0) {
      const kept = []
      for (const conflict of this.conflicts) {
        const expired = !conflict.keep && this.conflictActiveDays(conflict, now) >= retention
        if (!expired) {
          kept.push(conflict)
          continue
        }
        const released = await this.releaseConflictFile(conflict)
        if (!released.removed) {
          kept.push(conflict)
          if (released.skipped) skipped++
          continue
        }
        removed++
        freed += released.freed || 0
      }
      this.conflicts = kept
      if (removed) {
        await this.saveConflicts()
        await this.saveCleanup()
      }
    }
    const backups = await this.cleanupBackups({ now })
    removed += backups.removed
    freed += backups.freed
    skipped += backups.skipped
    await this.scanRecycle()
    this.emit('status')
    return { removed, freed, skipped }
  }

  /** Mark/unmark conflict copies as "keep" (accepts record ids or rel paths). */
  async setConflictKeep(idsOrRel, keep = true) {
    const wanted = new Set((Array.isArray(idsOrRel) ? idsOrRel : [idsOrRel]).map(String).filter(Boolean))
    if (!wanted.size) return { updated: 0 }
    let updated = 0
    const now = new Date().toISOString()
    for (const conflict of this.conflicts) {
      if (!wanted.has(conflict.id) && !wanted.has(conflict.rel)) continue
      conflict.keep = Boolean(keep)
      conflict.lastAccessAt = now
      updated++
    }
    if (updated) {
      await this.saveConflicts()
      await this.saveCleanup()
      this.emit('status')
    }
    return { updated }
  }

  /** Manual removal used by the panel; recycles by default like automatic cleanup. */
  async deleteConflicts(ids, { recycle } = {}) {
    const wanted = new Set()
    const collect = (value) => {
      if (Array.isArray(value)) for (const entry of value) collect(entry)
      else if (value != null && typeof value === 'object') {
        collect(value.ids)
        collect(value.rels)
      } else if (value != null) wanted.add(String(value))
    }
    collect(ids)
    if (!wanted.size) return { removed: 0, freed: 0, skipped: 0 }
    const kept = []
    let removed = 0
    let freed = 0
    let skipped = 0
    for (const conflict of this.conflicts) {
      if (!wanted.has(conflict.id) && !wanted.has(conflict.rel)) {
        kept.push(conflict)
        continue
      }
      const released = await this.releaseConflictFile(conflict, { recycle })
      if (!released.removed) {
        kept.push(conflict)
        if (released.skipped) skipped++
        continue
      }
      removed++
      freed += released.freed || 0
    }
    this.conflicts = kept
    if (removed) {
      await this.saveConflicts()
      await this.saveCleanup()
    }
    await this.scanRecycle()
    this.emit('status')
    return { removed, freed, skipped }
  }

  /** Keep a local recovery copy before a tombstone removes a file. */
  async parkDeletionBackup(abs) {
    if (Number(this.config.keepBackups) === 0) return
    try {
      const name = `${basename(abs)}.bak-sync-deleted-${this.identity.deviceId.slice(0, 6)}-${Date.now()}`
      await fs.copyFile(abs, join(dirname(abs), name))
    } catch {}
  }

  /**
   * Apply a peer's deletion tombstone.
   * Refuses to delete unless the local bytes still match the tombstone hash and
   * this file was actually synced with that peer before.
   */
  async applyDelete(set, rel, tomb, peer) {
    if (!this.deletesEnabled(set) || !tomb?.h) return null
    if (!this.itemAllowed(set, rel)) return null
    const abs = joinInside(set, rel)
    if (!abs) return null
    const st = await statSafe(abs)
    if (!st) return null
    const local = this.index.get(set.id, rel)
    if (!local?.h) return null
    // A local recreation after the deletion must survive.
    if (Number(local.m || 0) > Number(tomb.at || 0) + 5000) return null
    const base = await this.journal.base(peer.deviceId, set.id, rel)
    if (!base?.h) return null
    if (base.h !== tomb.h || local.h !== tomb.h) {
      const added = await this.addConflict({
        kind: 'delete',
        set: set.id,
        rel,
        peer: peer.deviceId,
        hash: tomb.h,
        at: new Date().toISOString(),
        note: '对端已删除该文件，但本机内容不同，已保留本机',
      })
      return added ? { conflict: true } : null
    }
    await this.parkDeletionBackup(abs)
    await fs.rm(abs, { force: true })
    this.index.drop(set.id, rel)
    await this.journal.record(peer.deviceId, set.id, rel, null)
    this.tombstones?.add(set.id, rel, tomb.h, { at: tomb.at, device: peer.deviceId })
    this.log('info', `deleted ${set.id}/${rel} (peer ${peer.deviceId.slice(0, 8)})`)
    this.emit('deleted', { set: set.id, rel, peer: peer.deviceId })
    return { deleted: true }
  }

  async loadConflicts() {
    const { value } = await readJsonDetailed(join(this.stateDir, CONFLICT_FILE), null)
    if (value && Array.isArray(value.items)) {
      this.conflicts = value.items.map(normalizeConflictRecord).filter(Boolean)
    }
  }

  async clearConflicts() {
    this.conflicts = []
    await this.saveConflicts()
    await this.saveCleanup()
    this.emit('status')
  }

  async pairStart(deviceId) {
    const peer = this.discovery?.list().find((item) => item.deviceId === deviceId)
    if (!peer) throw new Error('device not found on the LAN')
    const { hello, sas } = await this.probe(peer)
    const state = this.peerState.get(deviceId) || {}
    this.peerState.set(deviceId, { ...state, hello, sas, pendingAt: new Date().toISOString() })
    this.emit('status')
    return { deviceId, name: hello.name, sas }
  }

  async pairConfirm(deviceId) {
    const state = this.peerState.get(deviceId)
    const hello = state?.hello
    if (!hello) throw new Error('run pairing first')
    if (this.settings.role === 'sub') {
      const others = this.identity.trustedPeers().filter((peer) => peer.deviceId !== hello.deviceId)
      if (others.length > 0) throw refusal('sub-single-host', '子机只能连接一台主机；请先断开全部连接')
    }
    const record = await this.identity.trustPeer({
      deviceId: hello.deviceId,
      name: hello.name,
      publicKey: hello.publicKey,
      group: hello.group,
      sas: state.sas,
    })
    this.settings.peerRoles[hello.deviceId] = this.settings.role === 'sub' ? 'host' : 'sub'
    this.normalizePeerRoles()
    // Pairing is the moment the identity becomes binding: no role switch until
    // every connection is dropped again.
    this.settings.roleLocked = true
    await this.saveSettings()
    await this.refreshPushEnabled()
    this.emit('status')
    this.scheduleCycle('paired')
    return record
  }

  async unpair(deviceId) {
    await this.identity.untrustPeer(deviceId)
    this.peerState.delete(deviceId)
    this.emit('status')
  }

  async setSets(ids) {
    const allowed = new Set(this.sets.map((set) => set.id))
    const wanted = new Set()
    const itemMap = {}
    const cleared = []
    let explicitItems = false
    const list = Array.isArray(ids) ? ids : (isPlainObject(ids) && Array.isArray(ids.sets) ? ids.sets : [])
    for (const entry of list) {
      if (isPlainObject(entry)) {
        const id = String(entry.id || '')
        if (!allowed.has(id)) continue
        if (entry.enabled !== false) wanted.add(id)
        // `credentials` is set-level: an item list for it is ignored.
        if (id === 'credentials') continue
        if (Array.isArray(entry.items)) {
          itemMap[id] = { items: [...new Set(entry.items.map((item) => itemPath(item)).filter(Boolean))] }
          explicitItems = true
        } else if (entry.items === null) {
          // Explicit "select all": drop the persisted scope entry.
          cleared.push(id)
          explicitItems = true
        }
      } else if (allowed.has(String(entry))) {
        wanted.add(String(entry))
      }
    }
    // Plugin dependencies are a mirror of the profile: without the profile set
    // the modules set would sync packages nobody declared.
    if (!wanted.has('profile')) wanted.delete('modules')
    for (const set of this.sets) set.enabled = wanted.has(set.id)
    // Per-item scope drives manifest/push/pull/preview filtering; the index
    // itself stays complete.
    if (explicitItems) {
      const next = { ...this.settings.sets, ...itemMap }
      for (const id of cleared) delete next[id]
      this.settings.sets = next
      await this.saveSettings()
    }
    await this.saveSets()
    this.emit('status')
    this.scheduleCycle('sets')
    return this.enabledSets().map((set) => set.id)
  }

  /**
   * Real catalog for the per-item drawer: scans the set root with the same
   * include/exclude/ignore rules as the index and aggregates files into item
   * ids (`rel` for file sets, `plugins/<name>` / `node_modules/<pkg>` prefixes,
   * one item per session for `sessions`). Capped at 300 items.
   */
  async listItems(setId) {
    const id = String(setId || '')
    const set = this.sets.find((item) => item.id === id)
    if (!set) throw refusal('bad-value', '未知同步范围：' + id)
    const scope = this.itemScope(id)
    if (id === 'credentials') return { items: [], selected: scope || [], all: scope === null }
    const items = await this.buildItemCatalog(set)
    return { items, selected: scope === null ? [] : [...scope], all: scope === null }
  }

  async buildItemCatalog(set) {
    const include = set.include || null
    const exclude = set.exclude || null
    const filter = (rel) => {
      if (isIgnoredForSet(rel, set)) return false
      if (include && !matchesInclude(rel, include)) return false
      if (exclude && matchesAny(rel, exclude)) return false
      return true
    }
    const shouldEnter = (rel) => {
      if (isIgnoredForSet(rel, set)) return false
      if (exclude && matchesAny(rel, exclude)) return false
      if (include && !matchesInclude(rel, include)) return false
      return true
    }
    const rels = new Set(await listFiles(set.root, { filter, shouldEnter }))
    if (set.dereferencePluginLinks && this.index?.dereferencedPluginFiles) {
      try {
        for (const rel of await this.index.dereferencedPluginFiles(set, { filter, shouldEnter })) rels.add(rel)
      } catch {}
    }
    const groups = new Map()
    for (const rel of rels) {
      const item = catalogItemFor(set.id, rel)
      if (!item) continue
      let group = groups.get(item.id)
      if (!group) {
        group = { id: item.id, label: item.label, size: 0, files: 0 }
        if (item.group) group.group = item.group
        groups.set(item.id, group)
      }
      const parts = rel.split('/')
      const st = await statSafe(join(set.root, ...parts))
      group.size += st?.size || 0
      group.files++
    }
    return [...groups.values()]
      .sort((a, b) => a.label.localeCompare(b.label))
      .slice(0, MAX_CATALOG_ITEMS)
  }

  async saveSets() {
    const enabled = this.sets.filter((set) => set.enabled).map((set) => set.id)
    await writeJson(join(this.stateDir, 'sets.json'), { version: SETS_VERSION, enabled }).catch(() => {})
  }

  /**
   * Load the enabled sets, migrating older set files.
   *
   * A saved list only knows the sets that existed when it was written, so new
   * sets would stay off forever. Each non-legacy set starts enabled when its
   * default says so and the profile set (its reason to exist) is on: `modules`
   * for v1 files, `credentials` for v1/v2 files.
   */
  async loadSets() {
    const { value } = await readJsonDetailed(join(this.stateDir, 'sets.json'), null)
    if (!value || !Array.isArray(value.enabled)) return
    const wanted = new Set(value.enabled.map(String))
    const version = Number(value.version) || 1
    const profileOn = wanted.has('profile')
    for (const set of this.sets) {
      if (LEGACY_SET_IDS.has(set.id)) {
        set.enabled = wanted.has(set.id)
        continue
      }
      const introduced = SET_INTRODUCED[set.id] ?? SETS_VERSION
      if (version < introduced) {
        set.enabled = profileOn && set.defaultEnabled !== false
      } else {
        set.enabled = wanted.has(set.id)
      }
    }
    if (version < SETS_VERSION) {
      const enabled = this.sets.filter((set) => set.enabled).map((set) => set.id)
      this.log('info', `migrated sets.json to v${SETS_VERSION}: ${enabled.join(', ')}`)
      await this.saveSets()
    }
  }

  log(level, message) {
    const line = { at: new Date().toISOString(), level, message: String(message) }
    this.logs.push(line)
    if (this.logs.length > MAX_LOGS) this.logs.splice(0, this.logs.length - MAX_LOGS)
    if (level === 'error') this.logger?.warn?.('[dsh-sync]', message)
    else if (this.config.debug) this.logger?.info?.('[dsh-sync]', message)
    const file = join(this.stateDir, 'sync.log')
    fs.appendFile(file, JSON.stringify(line) + '\n').catch(() => {})
  }

  /** Accumulate live progress so the client can show what a running cycle is doing. */
  bumpProgress(kind, bytes = 0) {
    if (!this.progress) return
    this.progress[kind] = (this.progress[kind] || 0) + 1
    if (kind === 'pulled' || kind === 'merged' || kind === 'pushed') this.progress.files = (this.progress.files || 0) + 1
    this.progress.bytes = (this.progress.bytes || 0) + (Number(bytes) || 0)
    this.emit('progress', this.progress)
  }

  bumpConflicts(count = 1) {
    for (let i = 0; i < Number(count || 0); i++) this.bumpProgress('conflicts')
  }

  state() {
    const sets = this.sets.map((set) => {
      const entries = this.index?.entries(set.id) || {}
      const files = Object.values(entries)
      const items = this.settings.sets?.[set.id]?.items
      return {
        id: set.id,
        label: set.label,
        detail: set.detail,
        mode: set.mode,
        enabled: Boolean(set.enabled),
        files: files.length,
        bytes: files.reduce((sum, entry) => sum + (entry.s || 0), 0),
        items: Array.isArray(items) ? [...items] : null,
      }
    })
    const peers = []
    const seen = new Set()
    for (const peer of this.discovery?.list() || []) {
      const trusted = this.identity.getPeer(peer.deviceId)
      const state = this.peerState.get(peer.deviceId) || {}
      seen.add(peer.deviceId)
      peers.push({
        deviceId: peer.deviceId,
        name: trusted?.name || state.name || peer.name,
        host: peer.host,
        port: peer.port,
        group: state.group || peer.group || '',
        sameAccount: Boolean(state.group) && state.group === this.identity.groupId,
        trusted: Boolean(trusted),
        role: this.peerRoleFor(peer.deviceId),
        sas: trusted ? trusted.sas || '' : state.sas || '',
        lastSeen: new Date(peer.lastSeen).toISOString(),
        lastSyncAt: state.lastSyncAt || null,
        status: state.status || (trusted ? 'idle' : 'unpaired'),
        error: state.error || null,
        online: true,
      })
    }
    for (const trusted of this.identity.trustedPeers()) {
      if (seen.has(trusted.deviceId)) continue
      const state = this.peerState.get(trusted.deviceId) || {}
      peers.push({
        deviceId: trusted.deviceId,
        name: trusted.name,
        host: '',
        port: 0,
        group: trusted.group,
        sameAccount: Boolean(trusted.group) && trusted.group === this.identity.groupId,
        trusted: true,
        role: this.peerRoleFor(trusted.deviceId),
        sas: trusted.sas || '',
        lastSeen: trusted.lastSeen || null,
        lastSyncAt: state.lastSyncAt || null,
        status: 'offline',
        error: state.error || null,
        online: false,
      })
    }
    const device = this.identity.peel()
    return {
      enabled: Boolean(this.config.enabled),
      running: this.running,
      startedAt: this.startedAt,
      device: { ...device, name: this.identity.name },
      port: this.port,
      addresses: localAddresses(),
      sets,
      peers,
      conflicts: this.conflicts.slice(0, 50),
      conflictCount: this.conflicts.length,
      allowPush: this.pushEnabled,
      settings: this.publicSettings(),
      immediate: this.settings.role === 'sub' ? 'pull' : 'push',
      cleanupStats: this.cleanupStats(),
      changesPreview: this.changesPreview,
      lastCycle: this.lastCycle,
      syncing: Boolean(this.busy),
      progress: this.progress,
      lastError: this.lastError,
      logs: this.logs.slice(-60),
      config: {
        intervalMs: Number(this.config.intervalMs) || DEFAULTS.intervalMs,
        discovery: this.config.discovery !== false,
        discoveryPort: this.config.discoveryPort,
        listenPort: this.server?.port || 0,
        autoStart: this.config.autoStart !== false,
        stableAfterMs: this.config.stableAfterMs,
      },
    }
  }
}

function unionKeys(a, b) {
  return [...new Set([...Object.keys(a || {}), ...Object.keys(b || {})])]
}

async function lstatSafe(path) {
  try { return await fs.lstat(path) } catch { return null }
}

/** 'dir' | 'file' | null (follows links). */
async function statKind(path) {
  try {
    const st = await fs.stat(path)
    return st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'other'
  } catch {
    return null
  }
}

/** Remove a link or junction itself; never a real directory tree. */
async function removeLinkOnly(dest) {
  try { await fs.unlink(dest); return true } catch {}
  try { await fs.rmdir(dest); return true } catch {}
  return false
}

/** Create a directory junction (Windows) / symlink pointing at a local target. */
async function createLink(target, dest) {
  try {
    await fs.mkdir(dirname(dest), { recursive: true })
    await fs.symlink(target, dest, process.platform === 'win32' ? 'junction' : 'dir')
    return true
  } catch {
    return false
  }
}

/** Compare two paths, tolerating Windows junction readlink forms (`\\?\`). */
function samePath(a, b) {
  const normalize = (value) => {
    let text = String(value || '')
    if (text.startsWith('\\\\?\\')) text = text.slice(4)
    const resolved = resolve(text)
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved
  }
  return normalize(a) === normalize(b)
}

/** True when `current` already resolves to the same physical directory as `target`. */
async function sameTarget(current, target) {
  if (samePath(current, target)) return true
  try {
    const [a, b] = await Promise.all([fs.realpath(current), fs.realpath(target)])
    return samePath(a, b)
  } catch {
    return false
  }
}

/** `yyyyMMdd-HHmmss` in local time, used for local backup file names. */
function syncStamp(now = Date.now()) {
  const date = new Date(now)
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

async function pluginSourceExists(profileDir, name) {
  const dir = join(profileDir, 'plugins', ...String(name || '').split('/'))
  return Boolean(await statKind(join(dir, 'package.json')))
}

/**
 * Direct `plugins/<name>` children that look like a real package directory
 * (real dir, valid npm name, package.json whose `name` matches the folder).
 * Junctions are ignored: they either come from the peer dereference (copied as
 * real dirs) or point at a developer checkout that already has a declaration.
 */
async function listPluginSourceNames(profileDir) {
  const pluginsDir = join(profileDir, 'plugins')
  let entries
  try {
    entries = await fs.readdir(pluginsDir, { withFileTypes: true })
  } catch {
    return []
  }
  const names = []
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue
    const name = entry.name
    if (!name || name.startsWith('.') || name === 'node_modules') continue
    if (!/^[a-z0-9][\w.-]*$/i.test(name)) continue
    let manifest
    try {
      manifest = JSON.parse(await fs.readFile(join(pluginsDir, name, 'package.json'), 'utf8'))
    } catch {
      continue
    }
    if (!manifest || manifest.name !== name) continue
    names.push(name)
  }
  return names
}

/** Journal entry for a payload returned by `fetchRemote` ({hash,size,mtimeMs}). */
function journalFetched(remote) {
  return { h: remote.hash, size: remote.size, mtimeMs: remote.mtimeMs }
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0
  if (value >= 1024 * 1024 * 1024) return (value / (1024 * 1024 * 1024)).toFixed(1) + ' GB'
  if (value >= 1024 * 1024) return (value / (1024 * 1024)).toFixed(1) + ' MB'
  if (value >= 1024) return Math.round(value / 1024) + ' KB'
  return value + ' B'
}

function localAddresses() {
  const out = []
  for (const items of Object.values(networkInterfaces())) {
    for (const item of items || []) {
      if (item.family !== 'IPv4' || item.internal) continue
      if (item.address.startsWith('169.254.')) continue
      out.push(item.address)
    }
  }
  return [...new Set(out)]
}



