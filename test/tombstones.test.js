import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Tombstones } from '../src/tombstones.js'

test('tombstones: record, group by set, reload and expire', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-sync-tomb-'))
  const now = Date.now()
  const tombstones = await new Tombstones({ stateDir: dir }).load()
  tombstones.add('attachments', 'a.txt', 'hash-a', { at: now - 3000, device: 'dev-1' })
  tombstones.add('attachments', 'b.txt', 'hash-b', { at: now - 2000 })
  tombstones.add('profile', 'cordis.patch.yml', 'hash-c', { at: now - 1000 })
  await tombstones.save()

  const reloaded = await new Tombstones({ stateDir: dir }).load()
  assert.deepEqual(Object.keys(reloaded.bySet('attachments')).sort(), ['a.txt', 'b.txt'])
  assert.equal(reloaded.get('profile', 'cordis.patch.yml').h, 'hash-c')

  // Same hash is idempotent; a new hash replaces the entry.
  const before = reloaded.get('attachments', 'a.txt')
  assert.equal(reloaded.add('attachments', 'a.txt', 'hash-a', { at: now }), before)
  reloaded.add('attachments', 'a.txt', 'hash-a2', { at: now - 500 })
  assert.equal(reloaded.get('attachments', 'a.txt').h, 'hash-a2')

  // Expired entries disappear on prune.
  reloaded.prune(now + 60 * 24 * 60 * 60 * 1000)
  assert.equal(Object.keys(reloaded.bySet('attachments')).length, 0)
})
