// Persistent per-device file index: path -> {size, mtime, sha256}.
// Hashing is skipped while a file is still being written (unstable mtime).
import { join } from 'node:path'
import fs from 'node:fs/promises'
import { hashFileStream, listFiles, readJsonDetailed, statSafe, writeJson } from './fsutil.js'
import { matchesAny, matchesInclude } from './glob.js'
import { isIgnoredForSet } from './paths.js'

const INDEX_FILE = 'index.json'

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, items.length || 1) }, async () => {
    while (cursor < items.length) {
      const index = cursor++
      results[index] = await fn(items[index], index)
    }
  })
  await Promise.all(workers)
  return results
}

export class FileIndex {
  constructor({ stateDir, logger = null }) {
    this.file = join(stateDir, INDEX_FILE)
    this.logger = logger
    this.sets = {}
    this.dirty = false
  }

  async load() {
    const { value } = await readJsonDetailed(this.file, null)
    if (value && value.version === 1 && value.sets) this.sets = value.sets
    return this
  }

  async save() {
    await writeJson(this.file, { version: 1, sets: this.sets, savedAt: new Date().toISOString() })
    this.dirty = false
  }

  entries(setId) {
    return this.sets[setId] || {}
  }

  get(setId, rel) {
    return this.sets[setId]?.[rel] || null
  }

  /** Set an entry after a successful local write or sync. */
  put(setId, rel, entry) {
    ;(this.sets[setId] ||= {})[rel] = { s: entry.size, m: Math.round(entry.mtimeMs), h: entry.hash, at: Date.now() }
    this.dirty = true
  }

  drop(setId, rel) {
    if (this.sets[setId]?.[rel]) {
      delete this.sets[setId][rel]
      this.dirty = true
    }
  }

  /**
   * Rebuild one set. Returns the relative paths that currently exist.
   * `stableAfterMs` keeps the previous hash for files written moments ago.
   */
  async refresh(set, { stableAfterMs = 1500, maxFileBytes = 256 * 1024 * 1024, concurrency = 6, now = Date.now(), onDelete = null } = {}) {
    const previous = this.sets[set.id] || {}
    const next = {}
    // A missing root (or a transient read failure) must never look like a mass
    // deletion: keep the previous snapshot and wait for the next round.
    try {
      const rootStat = await fs.stat(set.root)
      if (!rootStat.isDirectory()) return Object.keys(previous)
      await fs.readdir(set.root)
    } catch {
      return Object.keys(previous)
    }
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
    if (set.dereferencePluginLinks) {
      for (const rel of await this.dereferencedPluginFiles(set, { filter, shouldEnter })) rels.add(rel)
    }
    await mapLimit([...rels], concurrency, async (rel) => {
      const abs = join(set.root, ...rel.split('/'))
      const st = await statSafe(abs)
      if (!st) return
      const old = previous[rel]
      if (st.size > maxFileBytes) {
        if (old) next[rel] = old
        return
      }
      const size = st.size
      const mtime = Math.round(st.mtimeMs)
      if (old && old.s === size && old.m === mtime && old.h) {
        next[rel] = old
        return
      }
      if (old && now - mtime < stableAfterMs) {
        // File is still hot: keep the previous coherent snapshot for now.
        next[rel] = old
        return
      }
      try {
        const hash = await hashFileStream(abs)
        next[rel] = { s: size, m: mtime, h: hash, at: Date.now() }
      } catch (error) {
        // Locked or unreadable right now: keep the previous entry if any.
        if (old) next[rel] = old
      }
    })
    for (const rel of Object.keys(previous)) {
      if (!next[rel] && onDelete) {
        try { onDelete(set, rel, previous[rel]) } catch {}
      }
    }
    this.sets[set.id] = next
    this.dirty = true
    return Object.keys(next)
  }

  /**
   * List files behind first-level `plugins/<name>` junctions.
   *
   * Plugin sources are often symlinked/junctioned into a developer checkout, and
   * `listFiles` intentionally skips links. For the profile set we dereference
   * exactly that one level so the peer can receive real files: the target is
   * read-only here, only `plugins/<name>/...` relative paths are produced, and
   * nested links inside the target are still skipped by `listFiles`.
   */
  async dereferencedPluginFiles(set, { filter, shouldEnter }) {
    const pluginsDir = join(set.root, 'plugins')
    let entries
    try {
      entries = await fs.readdir(pluginsDir, { withFileTypes: true })
    } catch {
      return []
    }
    const out = []
    for (const entry of entries) {
      if (!entry.isSymbolicLink()) continue
      const name = entry.name
      if (!name || name.startsWith('.') || name.includes('/') || name.includes('\\')) continue
      const linkPath = join(pluginsDir, name)
      let real
      try {
        real = await fs.realpath(linkPath)
        const stat = await fs.stat(real)
        if (!stat.isDirectory()) continue
        await fs.readdir(real)
      } catch (error) {
        this.logger?.warn?.('[dsh-sync] cannot dereference plugin link', name + ':', String(error?.message || error))
        continue
      }
      const prefix = `plugins/${name}/`
      let files = []
      try {
        files = await listFiles(real, {
          filter: (rel) => filter(prefix + rel),
          shouldEnter: (rel) => shouldEnter(prefix + rel),
        })
      } catch (error) {
        this.logger?.warn?.('[dsh-sync] cannot list plugin link target', name + ':', String(error?.message || error))
        continue
      }
      for (const rel of files) out.push(prefix + rel)
    }
    return out
  }
}
