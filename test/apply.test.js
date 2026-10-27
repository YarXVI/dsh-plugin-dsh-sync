import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../index.js'

async function makeHome() {
  const home = await mkdtemp(join(tmpdir(), 'dsh-sync-apply-'))
  for (const dir of ['sessions', 'storages', 'profiles/desktop', 'attachments', 'cache']) await mkdir(join(home, dir), { recursive: true })
  await writeFile(join(home, 'storages', 'workspace.json'), JSON.stringify({ unit: { name: 'workspace', version: 2 }, global: {}, tables: { workspaces: {} } }))
  return home
}

function mockRequest(path, headers = {}) {
  return { method: 'GET', url: path, headers, socket: { remoteAddress: '127.0.0.1' } }
}

function mockResponse() {
  return {
    status: 0,
    body: '',
    writeHead(status) { this.status = status },
    end(body) { this.body = String(body) },
  }
}

test('apply: starts the engine, registers sync + shadow routes and stops on dispose', async () => {
  const home = await makeHome()
  const previous = { home: process.env.DSH_HOME, profile: process.env.DSH_PROFILE }
  process.env.DSH_HOME = home
  process.env.DSH_PROFILE = 'desktop'
  const routes = new Map()
  const disposers = []
  const provided = {}
  const provided2 = {}
  const services = {
    webServer: {
      register: (value) => {
        routes.set(value.path, value)
        return () => { routes.delete(value.path) }
      },
    },
    deepseekAccount: { getDeviceIdentity: async () => ({ accountId: 'account-abc', deviceId: 'device-xyz' }) },
    connection: null,
  }
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    sessions: { get: () => undefined },
    effect: (fn) => { disposers.push(fn()) },
    provide: (name, value) => { provided[name] = value },
    inject: (deps, callback) => {
      const scoped = {
        get: (name) => services[name] || null,
        effect: (fn) => fn(),
      }
      callback(scoped)
    },
  }
  try {
    await apply(ctx, { enabled: true, discovery: false, autoCycle: false, intervalMs: 3600000 })
    const route = routes.get('/plugins/dsh-plugin-dsh-sync/panel')
    assert.ok(route, 'dsh-sync panel route registered')

    // The merged plugin also mounts the shadow routes on the same server.
    const shadowPanel = routes.get('/plugins/dsh-plugin-dsh-sync/shadow')
    const shadowData = routes.get('/plugins/dsh-plugin-dsh-sync/shadow/rpc')
    assert.ok(shadowPanel, 'shadow panel route registered')
    assert.ok(shadowData, 'shadow data route registered')
    assert.equal(shadowPanel.kind, 'prefix')

    // Local GUI only: no own-client header -> 403; with it -> 200.
    const denied = mockResponse()
    await shadowPanel.handler(mockRequest('/plugins/dsh-plugin-dsh-sync/shadow'), denied)
    assert.equal(denied.status, 403)
    const allowed = mockResponse()
    await shadowPanel.handler(mockRequest('/plugins/dsh-plugin-dsh-sync/shadow', { 'x-shadow-client': '1' }), allowed)
    assert.equal(allowed.status, 200)
    const shadowState = JSON.parse(allowed.body)
    assert.equal(shadowState.ok, true)
    assert.equal(shadowState.state.device.name !== undefined, true)
    assert.ok(Array.isArray(shadowState.state.peers))

    // The broker is exposed as a Cordis service for other plugins.
    const api = provided.dshSync
    assert.ok(api, 'ctx.provide("dshSync", api) must be called')
    for (const method of ['identity', 'peers', 'rpc', 'registerRpc', 'onPeerEvent']) {
      assert.equal(typeof api[method], 'function', `dshSync.${method} must be a function`)
    }
    assert.equal(api.engine, undefined, 'the engine must stay private')
    const identity = api.identity()
    assert.equal(identity.deviceId.length > 0, true)
    assert.ok(Array.isArray(api.peers()))
    assert.throws(() => api.registerRpc('echo', async () => 1), /ext\./, 'only ext.* ops can be served')
    const disposeEcho = api.registerRpc('ext.test.echo', async () => 1)
    disposeEcho()

    const res = mockResponse()
    await route.handler(mockRequest('/plugins/dsh-plugin-dsh-sync/panel'), res)
    const value = JSON.parse(res.body)
    assert.equal(value.ok, true)
    assert.equal(value.state.running, true)
    assert.equal(value.state.device.groupSource, 'account')
    assert.ok(value.state.port > 0)
    assert.ok(value.state.sets.length >= 5)

    // A second application of the same bundle must reuse the engine, not bind
    // a second port for the same device id.
    const secondDisposers = []
    const ctx2 = {
      logger: ctx.logger,
      sessions: ctx.sessions,
      effect: (fn) => { secondDisposers.push(fn()) },
      provide: (name, value) => { provided2[name] = value },
      inject: ctx.inject,
    }
    await apply(ctx2, { enabled: true, discovery: false, autoCycle: false, intervalMs: 3600000 })
    assert.equal(provided2.dshSync, api, 'a reload must reuse the same dshSync service')
    const res2 = mockResponse()
    await routes.get('/plugins/dsh-plugin-dsh-sync/panel').handler(mockRequest('/plugins/dsh-plugin-dsh-sync/panel'), res2)
    const second = JSON.parse(res2.body)
    assert.equal(second.state.port, value.state.port, 'the engine must not start twice')
    for (const dispose of secondDisposers) {
      try { await dispose() } catch {}
    }
  } finally {
    for (const dispose of disposers) {
      try { await dispose() } catch {}
    }
    if (previous.home === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous.home
    if (previous.profile === undefined) delete process.env.DSH_PROFILE
    else process.env.DSH_PROFILE = previous.profile
  }
})
