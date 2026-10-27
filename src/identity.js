// Persistent device identity and the peer trust store.
import { hostname } from 'node:os'
import { join } from 'node:path'
import { fingerprint, generateDeviceKeyPair, groupIdForAccount, publicKeyFromPrivate, randomId, sha256hex } from './crypto.js'
import { ensureDir, readJsonDetailed, writeJson } from './fsutil.js'

const DEVICE_FILE = 'device.json'
const TRUST_FILE = 'trust.json'

export class Identity {
  constructor({ stateDir, name = '', group = '', accountId = null, logger = null }) {
    this.stateDir = stateDir
    this.logger = logger
    this.deviceFile = join(stateDir, DEVICE_FILE)
    this.trustFile = join(stateDir, TRUST_FILE)
    this.device = null
    this.trust = { version: 1, peers: {} }
    this.configuredName = String(name || '').trim()
    this.configuredGroup = String(group || '').trim()
    this.accountId = accountId || null
  }

  async load() {
    await ensureDir(this.stateDir)
    const { value, error } = await readJsonDetailed(this.deviceFile, null)
    if (value && value.publicKey && value.privateKey) {
      this.device = value
      // Repair identity fields that older builds may have missed.
      const expectedId = sha256hex(value.publicKey).slice(0, 32)
      if (this.device.deviceId !== expectedId) this.device.deviceId = expectedId
    } else {
      if (error && error.code !== 'ENOENT') this.logger?.warn?.('[dsh-sync] device.json unreadable, regenerating:', error.message)
      this.device = this.createDevice()
      await this.saveDevice()
    }
    if (this.configuredName) this.device.name = this.configuredName
    if (!this.device.name) this.device.name = hostname()
    if (!this.configuredGroup && this.device.configuredGroup) this.configuredGroup = this.device.configuredGroup
    const trust = await readJsonDetailed(this.trustFile, { version: 1, peers: {} })
    this.trust = trust.value && typeof trust.value === 'object' && trust.value.peers ? trust.value : { version: 1, peers: {} }
    return this
  }

  createDevice() {
    const keys = generateDeviceKeyPair()
    const now = new Date().toISOString()
    return {
      version: 1,
      deviceId: sha256hex(keys.publicKey).slice(0, 32),
      name: this.configuredName || hostname(),
      publicKey: keys.publicKey,
      privateKey: keys.privateKey,
      createdAt: now,
      fallbackGroup: 'local-' + randomId(8),
    }
  }

  async saveDevice() {
    await writeJson(this.deviceFile, this.device)
  }

  get deviceId() {
    return this.device.deviceId
  }

  get name() {
    return this.device.name
  }

  get publicKey() {
    return this.device.publicKey
  }

  get privateKey() {
    return this.device.privateKey
  }

  get publicKeyFingerprint() {
    return fingerprint(this.device.publicKey)
  }

  /** Stable group label: explicit config > account > per-install fallback. */
  get groupId() {
    if (this.configuredGroup) return this.configuredGroup
    if (this.accountId) return groupIdForAccount(this.accountId)
    return this.device.fallbackGroup || 'local'
  }

  get groupSource() {
    if (this.configuredGroup) return 'config'
    if (this.accountId) return 'account'
    return 'local'
  }

  setAccountId(accountId) {
    const next = accountId || null
    if (next === this.accountId) return false
    this.accountId = next
    return true
  }

  async rename(name) {
    const next = String(name || '').trim()
    if (!next) throw new Error('empty device name')
    this.device.name = next.slice(0, 64)
    await this.saveDevice()
    return this.device.name
  }

  async setGroup(group) {
    this.configuredGroup = String(group || '').trim().slice(0, 96)
    this.device.configuredGroup = this.configuredGroup
    await this.saveDevice()
    return this.groupId
  }

  peel() {
    return {
      deviceId: this.deviceId,
      name: this.name,
      publicKey: this.publicKey,
      publicKeyFingerprint: this.publicKeyFingerprint,
      group: this.groupId,
      groupSource: this.groupSource,
      accountId: this.accountId ? sha256hex(this.accountId).slice(0, 12) : null,
    }
  }

  verifyKeyPair() {
    return publicKeyFromPrivate(this.privateKey) === this.publicKey
  }

  trustedPeers() {
    return Object.values(this.trust.peers || {})
  }

  getPeer(deviceId) {
    return this.trust.peers?.[deviceId] || null
  }

  async trustPeer({ deviceId, name, publicKey, group, sas = '', auto = false }) {
    if (!deviceId || !publicKey) throw new Error('deviceId and publicKey are required')
    const existing = this.getPeer(deviceId)
    const record = {
      deviceId,
      name: String(name || existing?.name || deviceId).slice(0, 64),
      publicKey,
      publicKeyFingerprint: fingerprint(publicKey),
      group: String(group || ''),
      sas: String(sas || existing?.sas || ''),
      auto: Boolean(auto || existing?.auto),
      trustedAt: existing?.trustedAt || new Date().toISOString(),
      lastSeen: new Date().toISOString(),
    }
    this.trust.peers[deviceId] = record
    await this.saveTrust()
    return record
  }

  async touchPeer(deviceId) {
    const peer = this.getPeer(deviceId)
    if (!peer) return
    peer.lastSeen = new Date().toISOString()
  }

  async untrustPeer(deviceId) {
    if (!this.trust.peers?.[deviceId]) return false
    delete this.trust.peers[deviceId]
    await this.saveTrust()
    return true
  }

  async saveTrust() {
    this.trust.version = 1
    await writeJson(this.trustFile, this.trust)
  }
}
