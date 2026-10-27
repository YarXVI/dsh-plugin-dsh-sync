// Per-peer sync journal: the hash both sides agreed on after the last sync.
// It is the base of the three-way check that distinguishes "changed here",
// "changed there" and "changed on both sides".
import { join } from 'node:path'
import { readJsonDetailed, writeJson } from './fsutil.js'

const key = (setId, rel) => setId + '|' + rel

export class Journal {
  constructor({ stateDir, logger = null }) {
    this.dir = join(stateDir, 'journal')
    this.logger = logger
    this.docs = new Map()
    this.dirty = new Set()
  }

  async doc(peerId) {
    if (this.docs.has(peerId)) return this.docs.get(peerId)
    const { value } = await readJsonDetailed(join(this.dir, peerId + '.json'), null)
    const doc = value && value.version === 1 && value.entries ? value : { version: 1, peerId, entries: {}, lastSyncAt: null }
    this.docs.set(peerId, doc)
    return doc
  }

  async base(peerId, setId, rel) {
    const doc = await this.doc(peerId)
    return doc.entries[key(setId, rel)] || null
  }

  async record(peerId, setId, rel, entry) {
    const doc = await this.doc(peerId)
    if (!entry || !entry.h) {
      if (doc.entries[key(setId, rel)]) {
        delete doc.entries[key(setId, rel)]
        this.dirty.add(peerId)
      }
      return
    }
    doc.entries[key(setId, rel)] = {
      h: entry.h,
      s: entry.size ?? entry.s ?? 0,
      m: Math.round(entry.mtimeMs ?? entry.m ?? 0),
      ...(entry.divergedH ? { divergedH: entry.divergedH } : {}),
      at: Date.now(),
    }
    this.dirty.add(peerId)
  }

  async touch(peerId) {
    const doc = await this.doc(peerId)
    doc.lastSyncAt = new Date().toISOString()
    this.dirty.add(peerId)
  }

  async flush() {
    for (const peerId of [...this.dirty]) {
      const doc = this.docs.get(peerId)
      if (!doc) continue
      try {
        await writeJson(join(this.dir, peerId + '.json'), doc)
        this.dirty.delete(peerId)
      } catch (error) {
        this.logger?.warn?.('[dsh-sync] journal write failed:', error.message)
      }
    }
  }
}
