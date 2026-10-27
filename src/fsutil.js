// Small async filesystem helpers shared by the engine.
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import fs from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'

export async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true })
}

export async function readJson(file, fallback = null) {
  try {
    const text = await fs.readFile(file, 'utf8')
    return JSON.parse(text)
  } catch {
    return fallback
  }
}

export async function readJsonDetailed(file, fallback = null) {
  try {
    return { value: JSON.parse(await fs.readFile(file, 'utf8')), error: null }
  } catch (error) {
    return { value: fallback, error }
  }
}

/** Atomic replace: same directory temp file, fsync, rename. */
export async function writeAtomic(file, data, { mtimeMs = 0 } = {}) {
  const dir = dirname(file)
  await fs.mkdir(dir, { recursive: true })
  const tmp = join(dir, `.sync-tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  const handle = await fs.open(tmp, 'w')
  try {
    await handle.writeFile(data)
    await handle.sync()
  } finally {
    await handle.close()
  }
  await fs.rename(tmp, file)
  if (mtimeMs > 0) {
    const date = new Date(mtimeMs)
    await fs.utimes(file, date, date).catch(() => {})
  }
}

export async function writeJson(file, value) {
  await writeAtomic(file, JSON.stringify(value, null, 2) + '\n')
}

/** Append bytes without rewriting the existing log. */
export async function appendBytes(file, buffer) {
  await fs.mkdir(dirname(file), { recursive: true })
  await fs.appendFile(file, buffer)
}

export async function statSafe(file) {
  try {
    const st = await fs.stat(file)
    return st.isFile() ? st : null
  } catch {
    return null
  }
}

export async function exists(file) {
  try {
    await fs.access(file)
    return true
  } catch {
    return false
  }
}

export function hashFileStream(file, { signal } = {}) {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(file, { signal })
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolvePromise(hash.digest('hex')))
  })
}

/**
 * Compare the first `length` bytes of two files.
 * Returns true only when both files are at least `length` bytes and equal.
 */
export async function prefixEquals(a, b, length) {
  if (length === 0) return true
  const left = await fs.open(a, 'r')
  const right = await fs.open(b, 'r')
  try {
    const chunk = 1024 * 512
    let offset = 0
    while (offset < length) {
      const size = Math.min(chunk, length - offset)
      const [bufA, bufB] = await Promise.all([
        left.read(Buffer.alloc(size), 0, size, offset),
        right.read(Buffer.alloc(size), 0, size, offset),
      ])
      if (bufA.bytesRead !== size || bufB.bytesRead !== size) return false
      if (!bufA.buffer.equals(bufB.buffer)) return false
      offset += size
    }
    return true
  } finally {
    await left.close().catch(() => {})
    await right.close().catch(() => {})
  }
}

export async function readTail(file, from, to) {
  const handle = await fs.open(file, 'r')
  try {
    const length = to - from
    const buffer = Buffer.alloc(length)
    const { bytesRead } = await handle.read(buffer, 0, length, from)
    return bytesRead === length ? buffer : buffer.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}

/**
 * Recursively list regular files under `root`.
 * Symlinks and ignored directories are skipped; returns set-relative paths.
 */
export async function listFiles(root, { filter = () => true, shouldEnter = () => true } = {}) {
  const out = []
  async function walk(dir, prefix) {
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const rel = prefix ? prefix + '/' + entry.name : entry.name
      const abs = join(dir, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        if (!shouldEnter(rel, entry.name)) continue
        await walk(abs, rel)
      } else if (entry.isFile()) {
        if (!filter(rel, entry.name)) continue
        out.push(rel)
      }
    }
  }
  await walk(resolve(root), '')
  return out
}

export function relPath(root, abs) {
  return relative(resolve(root), resolve(abs)).split(sep).join('/')
}
