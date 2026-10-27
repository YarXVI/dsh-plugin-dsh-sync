// Device keys, pairwise shared secrets and authenticated envelopes.
//
// Transport is plain HTTP on the LAN, but every request/response body travels
// inside an AES-256-GCM envelope keyed by an X25519 shared secret, so a peer
// that has not completed pairing learns nothing but the public hello fields.
import crypto from 'node:crypto'

const DER_PUB = { type: 'spki', format: 'der' }
const DER_PRIV = { type: 'pkcs8', format: 'der' }

export function sha256hex(value) {
  const hash = crypto.createHash('sha256')
  hash.update(Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8'))
  return hash.digest('hex')
}

export function randomId(bytes = 16) {
  return crypto.randomBytes(bytes).toString('hex')
}

export function generateDeviceKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519')
  return {
    publicKey: publicKey.export(DER_PUB).toString('base64'),
    privateKey: privateKey.export(DER_PRIV).toString('base64'),
  }
}

export function publicKeyFromPrivate(privateKeyB64) {
  const priv = crypto.createPrivateKey({ key: Buffer.from(privateKeyB64, 'base64'), ...DER_PRIV })
  return crypto.createPublicKey(priv).export(DER_PUB).toString('base64')
}

export function deriveSharedSecret(privateKeyB64, peerPublicKeyB64) {
  const priv = crypto.createPrivateKey({ key: Buffer.from(privateKeyB64, 'base64'), ...DER_PRIV })
  const pub = crypto.createPublicKey({ key: Buffer.from(peerPublicKeyB64, 'base64'), ...DER_PUB })
  return crypto.diffieHellman({ privateKey: priv, publicKey: pub })
}

export function deriveKeys(sharedSecret, transcript) {
  const salt = crypto.createHash('sha256').update(String(transcript)).digest()
  const enc = Buffer.from(crypto.hkdfSync('sha256', sharedSecret, salt, 'dsh-sync/enc/v1', 32))
  const mac = Buffer.from(crypto.hkdfSync('sha256', sharedSecret, salt, 'dsh-sync/mac/v1', 32))
  return { enc, mac }
}

/** Six-digit short authentication string for manual pairing. */
export function sasCode(sharedSecret, pubA, pubB) {
  const [first, second] = [pubA, pubB].sort()
  const digest = crypto
    .createHash('sha256')
    .update(Buffer.from(sharedSecret))
    .update('\u0000')
    .update(first)
    .update('\u0000')
    .update(second)
    .digest()
  const value = digest.readUInt32BE(0) % 1000000
  return String(value).padStart(6, '0')
}

export function fingerprint(publicKeyB64) {
  return sha256hex(publicKeyB64).slice(0, 32)
}

export function seal(key, value) {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const plaintext = Buffer.from(JSON.stringify(value), 'utf8')
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([iv, tag, ciphertext]).toString('base64')
}

export function open(key, payload) {
  const raw = Buffer.from(String(payload || ''), 'base64')
  if (raw.length < 29) throw new Error('envelope too short')
  const iv = raw.subarray(0, 12)
  const tag = raw.subarray(12, 28)
  const ciphertext = raw.subarray(28)
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
  return JSON.parse(plaintext.toString('utf8'))
}

export function safeEqualHex(a, b) {
  const left = Buffer.from(String(a || ''), 'utf8')
  const right = Buffer.from(String(b || ''), 'utf8')
  if (left.length !== right.length) return false
  return crypto.timingSafeEqual(left, right)
}

export function groupIdForAccount(accountId) {
  return sha256hex('dsh-sync/group/v1\u0000' + String(accountId)).slice(0, 32)
}
