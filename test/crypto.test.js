import test from 'node:test'
import assert from 'node:assert/strict'
import { deriveKeys, deriveSharedSecret, fingerprint, generateDeviceKeyPair, groupIdForAccount, open, sasCode, seal, sha256hex } from '../src/crypto.js'

test('crypto: both sides derive the same secret, keys and SAS', () => {
  const a = generateDeviceKeyPair()
  const b = generateDeviceKeyPair()
  const ab = deriveSharedSecret(a.privateKey, b.publicKey)
  const ba = deriveSharedSecret(b.privateKey, a.publicKey)
  assert.deepEqual(ab, ba)
  const ka = deriveKeys(ab, 'transcript')
  const kb = deriveKeys(ba, 'transcript')
  assert.deepEqual(ka.enc, kb.enc)
  assert.equal(sasCode(ab, a.publicKey, b.publicKey), sasCode(ba, b.publicKey, a.publicKey))
  assert.match(sasCode(ab, a.publicKey, b.publicKey), /^\d{6}$/)
})

test('crypto: sealed envelopes round-trip and reject tampering', () => {
  const key = Buffer.alloc(32, 7)
  const sealed = seal(key, { hello: 'world', n: 42 })
  assert.deepEqual(open(key, sealed), { hello: 'world', n: 42 })
  const raw = Buffer.from(sealed, 'base64')
  raw[raw.length - 1] ^= 0xff
  assert.throws(() => open(key, raw.toString('base64')))
  assert.throws(() => open(Buffer.alloc(32, 8), sealed))
})

test('crypto: device id and fingerprints are stable', () => {
  const keys = generateDeviceKeyPair()
  const id = sha256hex(keys.publicKey).slice(0, 32)
  assert.equal(id.length, 32)
  assert.equal(fingerprint(keys.publicKey).length, 32)
  assert.equal(groupIdForAccount('acct-1'), groupIdForAccount('acct-1'))
  assert.notEqual(groupIdForAccount('acct-1'), groupIdForAccount('acct-2'))
})
