// Deterministic merge decisions shared by both peers.
//
// Both sides run the same pure rules over the same three inputs (local entry,
// remote entry, last agreed base), so they converge without a coordinator.
import { join, basename, dirname, extname } from 'node:path'

export const EQUAL = 'equal'
export const PULL = 'pull'
export const PUSH = 'push' // local is ahead; the peer will pull on its own cycle
export const MERGE = 'merge'
export const CONFLICT = 'conflict'
export const SKIP = 'skip'

/** Last-writer-wins on mtime, device id as the deterministic tie-breaker. */
export function lwwWinner(local, remote, localDevice, remoteDevice) {
  const lm = Number(local?.m || local?.mtimeMs || 0)
  const rm = Number(remote?.m || remote?.mtimeMs || 0)
  if (lm !== rm) return lm > rm ? 'local' : 'remote'
  return String(localDevice) >= String(remoteDevice) ? 'local' : 'remote'
}

/**
 * Classify one path.
 * `base` is the hash recorded after the last successful sync with this peer.
 */
export function decide({ local, remote, base, mode, localDevice, remoteDevice }) {
  if (!local && !remote) return { action: SKIP, reason: 'gone' }
  if (local && remote && local.h && local.h === remote.h) {
    return { action: EQUAL, reason: 'same' }
  }
  if (!local && remote) {
    if (mode === 'append') return { action: PULL, reason: 'remote-only' }
    return { action: PULL, reason: 'remote-only' }
  }
  if (local && !remote) {
    // Deletions are not propagated automatically: never destroy locally.
    return { action: SKIP, reason: 'local-only' }
  }
  const baseHash = base?.h || null
  // A previously parked divergence stays parked until the peer's file changes.
  if (base?.divergedH && base.divergedH === remote.h && (!baseHash || baseHash === local.h)) {
    return { action: SKIP, reason: 'conflict-parked' }
  }
  const localChanged = !baseHash || local.h !== baseHash
  const remoteChanged = !baseHash || remote.h !== baseHash
  if (!localChanged && remoteChanged) return { action: PULL, reason: 'remote-newer' }
  if (localChanged && !remoteChanged) return { action: SKIP, reason: 'local-ahead' }
  if (mode === 'merge-workspace') return { action: MERGE, reason: 'both-changed-mergeable' }
  if (mode === 'append') return { action: PULL, reason: 'session-check' }
  const winner = lwwWinner(local, remote, localDevice, remoteDevice)
  if (winner === 'remote') return { action: PULL, reason: 'both-changed-remote-wins' }
  return { action: SKIP, reason: 'both-changed-local-wins' }
}

/** Union-based merge for storages/workspace.json. */
export function mergeWorkspace(local, remote) {
  if (!isObject(local) || !isObject(remote)) return { value: local ?? remote, changed: false }
  const merged = structuredCloneSafe(local)
  merged.global = merged.global || {}
  const lg = local.global || {}
  const rg = remote.global || {}
  merged.global.initialized = Boolean(lg.initialized || rg.initialized)
  merged.global.workspaceIds = union(lg.workspaceIds, rg.workspaceIds)
  // Archived / pinned are per-machine UI state. Unioning them archives the
  // peer's sessions on this machine, and DSH then hides them from the
  // workspace list ("会话列表变空"). Only the local value survives.
  merged.global.archivedSessionIds = copyList(lg.archivedSessionIds)
  merged.global.pinnedSessionIds = copyList(lg.pinnedSessionIds)
  merged.tables = merged.tables || {}
  const localWorkspaces = local.tables?.workspaces || {}
  const remoteWorkspaces = remote.tables?.workspaces || {}
  const workspaces = {}
  for (const id of union(Object.keys(localWorkspaces), Object.keys(remoteWorkspaces))) {
    const a = localWorkspaces[id]
    const b = remoteWorkspaces[id]
    if (!a) { workspaces[id] = b; continue }
    if (!b) { workspaces[id] = a; continue }
    const newer = newerByUpdatedAt(a, b)
    workspaces[id] = {
      ...newer,
      path: newer.path || a.path || b.path,
      title: newer.title || a.title || b.title,
      sessionIds: union(a.sessionIds, b.sessionIds),
      createdAt: earliest(a.createdAt, b.createdAt),
      updatedAt: latest(a.updatedAt, b.updatedAt),
    }
  }
  merged.tables.workspaces = workspaces
  // A stale `defaultWorkspaceId` (pointing at a workspace that was deleted on
  // either side) makes DSH open an empty workspace, so fall back to a known id.
  merged.global.defaultWorkspaceId = pickDefaultWorkspaceId({
    candidates: [lg.defaultWorkspaceId || rg.defaultWorkspaceId, lg.defaultWorkspaceId, rg.defaultWorkspaceId],
    workspaceIds: merged.global.workspaceIds,
    workspaceKeys: Object.keys(workspaces),
  })
  return { value: merged, changed: JSON.stringify(merged) !== JSON.stringify(local) }
}

/** First candidate that names a workspace that exists after the merge, else the first one. */
function pickDefaultWorkspaceId({ candidates, workspaceIds, workspaceKeys }) {
  const known = new Set([...(Array.isArray(workspaceIds) ? workspaceIds : []), ...workspaceKeys].filter(Boolean))
  for (const id of candidates) {
    if (id && known.has(id)) return id
  }
  return (Array.isArray(workspaceIds) && workspaceIds[0]) || workspaceKeys[0] || ''
}

/**
 * Merge a peer's profile manifest into the local one.
 *
 * Dependencies and profile bundles are additive: the local value wins on a
 * version conflict, and neither side loses an entry it already had. What the
 * peer adds is filtered, though: a profile mirrors `plugins/` but not
 * `node_modules/`, so a bundle that this machine cannot load would only show up
 * in DSH as "包不可用". Remote-only bundles therefore need a local resolution
 * (`resolveBundle`) and remote-only `link:`/`file:` dependencies need an
 * existing target (`linkTargetExists`).
 *
 * Both probes are injected so this module stays pure; the engine supplies
 * filesystem-backed ones (see src/bundles.js). Without `resolveBundle` every
 * remote bundle is accepted (backwards-compatible union), and without
 * `linkTargetExists` every dependency is accepted.
 *
 * Returns `{ value, changed, skipped }`, where `skipped` lists what was left
 * out so the engine can surface it as a conflict instead of dropping it
 * silently.
 */
export function mergePackageJson(local, remote, { resolveBundle = null, linkTargetExists = null } = {}) {
  if (!isObject(local) || !isObject(remote)) return { value: local ?? remote, changed: false, skipped: [] }
  const skipped = []
  const merged = structuredCloneSafe(local)

  for (const field of ['dependencies', 'devDependencies']) {
    const mergedDeps = mergeDependencyMap(local[field], remote[field], field, { linkTargetExists, skipped })
    if (mergedDeps.count) merged[field] = sortKeys(mergedDeps.value)
    else if (merged[field] !== undefined && !isObject(local[field])) delete merged[field]
  }

  const localDsh = isObject(local.dsh) ? local.dsh : {}
  const remoteDsh = isObject(remote.dsh) ? remote.dsh : {}
  const localProfile = isObject(localDsh.profile) ? localDsh.profile : {}
  const remoteProfile = isObject(remoteDsh.profile) ? remoteDsh.profile : {}
  const bundles = mergeBundles(localProfile.bundles, remoteProfile.bundles, { resolveBundle, skipped })
  const profile = { ...remoteProfile, ...localProfile }
  if (bundles.length) profile.bundles = bundles
  else if (Array.isArray(localProfile.bundles)) profile.bundles = bundles
  else delete profile.bundles
  merged.dsh = { ...remoteDsh, ...localDsh, profile }
  return { value: merged, changed: JSON.stringify(merged) !== JSON.stringify(local), skipped }
}

function mergeBundles(localBundles, remoteBundles, { resolveBundle, skipped }) {
  const out = []
  const seen = new Set()
  for (const name of Array.isArray(localBundles) ? localBundles : []) {
    if (seen.has(name)) continue
    seen.add(name)
    out.push(name)
  }
  for (const name of Array.isArray(remoteBundles) ? remoteBundles : []) {
    if (seen.has(name)) continue
    if (!resolveBundle || resolveBundle(name)) {
      seen.add(name)
      out.push(name)
      continue
    }
    skipped.push({
      kind: 'bundle-unavailable',
      field: 'dsh.profile.bundles',
      name,
      note: `对端启用了 ${name}，但本机未安装，未加入本机 profile；执行 dsh plugin install 或安装该插件后可再次同步`,
    })
  }
  return out
}

function mergeDependencyMap(localMap, remoteMap, field, { linkTargetExists, skipped }) {
  const value = { ...(isObject(remoteMap) ? remoteMap : {}), ...(isObject(localMap) ? localMap : {}) }
  for (const [name, spec] of Object.entries(isObject(remoteMap) ? remoteMap : {})) {
    if (isObject(localMap) && name in localMap) continue // the local version always wins
    if (!linkTargetExists || linkTargetExists(spec)) continue
    delete value[name]
    skipped.push({
      kind: 'dependency-unavailable',
      field,
      name,
      spec: String(spec),
      note: `对端依赖 ${name} 的链接目标在本机不存在，未并入本机 ${field}；补齐 plugins/ 后可再次同步`,
    })
  }
  return { value, count: Object.keys(value).length }
}

function sortKeys(value) {
  const out = {}
  for (const key of Object.keys(value).sort()) out[key] = value[key]
  return out
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function union(a, b) {
  const out = []
  const seen = new Set()
  for (const item of [...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])]) {
    if (seen.has(item)) continue
    seen.add(item)
    out.push(item)
  }
  return out
}

/** Local-only list semantics for per-machine UI state. */
function copyList(value) {
  return Array.isArray(value) ? [...value] : []
}

function newerByUpdatedAt(a, b) {
  const at = Date.parse(a?.updatedAt || '') || 0
  const bt = Date.parse(b?.updatedAt || '') || 0
  return bt > at ? b : a
}

function earliest(a, b) {
  if (!a) return b
  if (!b) return a
  return Date.parse(a) <= Date.parse(b) ? a : b
}

function latest(a, b) {
  if (!a) return b
  if (!b) return a
  return Date.parse(a) >= Date.parse(b) ? a : b
}

function structuredCloneSafe(value) {
  return JSON.parse(JSON.stringify(value))
}

/**
 * Name of the sidecar that preserves the losing copy of a conflict.
 * Session logs go to a `conflicts/` directory so the persistence backend
 * never mistakes them for a generation.
 */
export function conflictName(rel, deviceId, { now = Date.now(), session = false } = {}) {
  const short = String(deviceId || 'peer').slice(0, 8)
  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-')
  if (session) {
    return join(dirname(rel), 'conflicts', `${basename(rel)}.${short}.${stamp}`)
  }
  const ext = extname(rel)
  if (!ext) return `${rel}.conflict-${short}-${stamp}`
  return `${rel}.conflict-${short}-${stamp}`
}
