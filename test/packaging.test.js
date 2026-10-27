import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { copyFile, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const root = fileURLToPath(new URL('..', import.meta.url))
const installScript = join(root, 'packaging', 'install.ps1')
const installCmd = join(root, 'packaging', 'install.cmd')

const BOM = Buffer.from([0xef, 0xbb, 0xbf])

test('packaging: install.ps1 writes package.json as UTF-8 without a BOM', async () => {
  const script = await readFile(installScript, 'utf8')
  assert.ok(script.includes('UTF8Encoding($false)'), 'must use a BOM-less UTF8 encoder')
  assert.ok(script.includes('[IO.File]::WriteAllText'), 'must write through .NET instead of Set-Content')
  // Comments may name the old API; only executable lines matter.
  const code = script.split(/\r?\n/).filter((line) => !line.trimStart().startsWith('#')).join('\n')
  assert.doesNotMatch(code, /Set-Content[^\r\n]*-Encoding\s+utf8/i, 'Set-Content -Encoding utf8 writes a BOM on PowerShell 5.1')
  const scriptBytes = await readFile(installScript)
  assert.notDeepEqual(scriptBytes.subarray(0, 3), BOM, 'the installer script itself must stay BOM-free')
})

test('packaging: install.cmd uses Windows PowerShell 5.1', async () => {
  const cmd = await readFile(installCmd, 'utf8')
  assert.match(cmd, /powershell(\.exe)?\s/i)
  assert.doesNotMatch(cmd, /\bpwsh\b/i)
})

test('packaging: running install.ps1 produces a BOM-free package.json', async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'dsh-sync-install-'))
  const stage = join(tmp, 'stage')
  const dshHome = join(tmp, 'home')
  const profileDir = join(dshHome, 'profiles', 'desktop')
  try {
    await mkdir(join(stage, 'dsh-plugin-dsh-sync'), { recursive: true })
    await mkdir(profileDir, { recursive: true })
    await writeFile(join(stage, 'dsh-plugin-dsh-sync', 'package.json'), JSON.stringify({ name: 'dsh-plugin-dsh-sync', version: '0.4.2' }))
    await writeFile(join(profileDir, 'package.json'), JSON.stringify({
      name: 'dsh-profile-desktop',
      dependencies: { 'dsh-plugin-qqbot': 'link:./plugins/qqbot' },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-plugin-qqbot'] } },
    }, null, 2))
    await copyFile(installScript, join(stage, 'install.ps1'))

    try {
      await run('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', join(stage, 'install.ps1'),
        '-Profile', 'desktop',
        '-DshHome', dshHome,
      ], { timeout: 120_000 })
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'EPERM' || error?.code === 'EACCES') {
        t.skip('Windows PowerShell is not runnable in this environment')
        return
      }
      throw error
    }

    const bytes = await readFile(join(profileDir, 'package.json'))
    assert.notDeepEqual(bytes.subarray(0, 3), BOM, 'package.json must not start with a UTF-8 BOM')
    const value = JSON.parse(bytes.toString('utf8')) // JSON.parse must accept it as-is
    assert.equal(value.dependencies['dsh-plugin-dsh-sync'], 'link:./plugins/dsh-plugin-dsh-sync')
    assert.equal(value.dependencies['dsh-plugin-qqbot'], 'link:./plugins/qqbot', 'existing dependencies must survive')
    assert.ok(value.dsh.profile.bundles.includes('dsh-plugin-dsh-sync'))
    assert.ok(value.dsh.profile.bundles.includes('dsh-plugin-qqbot'))
    const backups = (await readdir(profileDir)).filter((name) => name.startsWith('package.json.bak-sync-install-'))
    assert.equal(backups.length, 1)
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {})
  }
})
