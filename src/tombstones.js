// Deletion tombstones.
//
// A file that disappears locally is remembered by content hash. The hash is the
// safety interlock: a peer deletes its copy only when that copy still has the
// exact bytes we last synced, and only when it has a sync history for the file.
import { join } from 'node:path'
import { readJsonDetailed, writeJson } from './fsutil.js'

const FILE = 'tombstones.json'
const TTL_MS = 45 * 24 * 60 * 60 * 1000
const MAX_ITEMS = 5000

const keyOf = (setId, rel) => setId + '|' + rel

export class Tombstones {
  constructor({ stateDir, logger = null }) {
    this.file = join(stateDir, FILE)
    this.logger = logger
    this.items = {}
    this.dirty = false
  }

  async load() {
    const { value } = await readJsonDetailed(this.file, null)
    if (value && value.version === 1 && value.items) this.items = value.items
    this.prune()
    return this
  }

  add(setId, rel, hash, { at = Date.now(), device = '' } = {}) {
    if (!setId || !rel || !hash) return null
    const key = keyOf(setId, rel)
    const existing = this.items[key]
    if (existing && existing.h === hash) return existing
    this.items[key] = { set: setId, rel, h: hash, at: Number(at) || Date.now(), device: String(device || '') }
    this.dirty = true
    this.enforceLimit()
    return this.items[key]
  }

  get(setId, rel) {
    return this.items[keyOf(setId, rel)] || null
  }

  /** Tombstones for one set as `{ rel: { at, h } }`, capped to the newest. */
  bySet(setId) {
    const out = {}
    const rows = []
    for (const item of Object.values(this.items)) {
      if (item.set !== setId) continue
      rows.push(item)
    }
    rows.sort((a, b) => b.at - a.at)
    for (const item of rows.slice(0, 2000)) out[item.rel] = { at: item.at, h: item.h }
    return out
  }

  remove(setId, rel) {
    const key = keyOf(setId, rel)
    if (!this.items[key]) return
    delete this.items[key]
    this.dirty = true
  }

  prune(now = Date.now()) {
    let changed = false
    for (const [key, item] of Object.entries(this.items)) {
      if (!item || now - Number(item.at || 0) > TTL_MS) {
        delete this.items[key]
        changed = true
      }
    }
    if (changed) this.dirty = true
  }

  enforceLimit() {
    const rows = Object.entries(this.items)
    if (rows.length <= MAX_ITEMS) return
    rows.sort((a, b) => Number(b[1].at || 0) - Number(a[1].at || 0))
    for (const [key] of rows.slice(MAX_ITEMS)) delete this.items[key]
    this.dirty = true
  }

  async save() {
    this.prune()
    if (!this.dirty) return
    await writeJson(this.file, { version: 1, items: this.items })
    this.dirty = false
  }
}
