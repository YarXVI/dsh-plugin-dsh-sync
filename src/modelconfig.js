// Targeted merge for the model-related blocks of `cordis.patch.yml`.
//
// `cordis.patch.yml` is machine-owned (paths like `flm.exe` or ports must never
// cross machines), but the model provider / default-model blocks are user
// settings that should sync. This module is pure: it parses the top-level list
// items, and only touches blocks whose `name:` is whitelisted. Every byte
// outside those blocks is preserved.
import { createHash } from 'node:crypto'

/** Patch entries whose `name:` is a model/provider setting worth syncing. */
export const MODEL_PATCH_NAMES = [
  /^@deepseek-ai\/dsh-agent-default-model$/,
  /^@deepseek-ai\/dsh-llm-/,
]

const BLOCK_START = /^-\s/
const BLOCK_ID = /^-\s+id:\s*(.+?)\s*$/
// The entry-level `name:` sits right under `- id:`; nested `name:` fields
// (model display names) are indented much deeper and must not be picked up.
const BLOCK_NAME = /^\s{1,4}name:\s*"?([^"\r\n]+?)"?\s*$/

/** Split text into `{ body, eol }` pieces so line endings survive untouched. */
export function splitLines(text) {
  const out = []
  const source = String(text ?? '')
  let start = 0
  for (let i = 0; i < source.length; i++) {
    const ch = source[i]
    if (ch !== '\n' && ch !== '\r') continue
    const eol = ch === '\r' && source[i + 1] === '\n' ? '\r\n' : ch
    out.push({ body: source.slice(start, i), eol })
    i += eol.length - 1
    start = i + 1
  }
  if (start < source.length) out.push({ body: source.slice(start), eol: '' })
  return out
}

export function joinLines(lines) {
  return lines.map((line) => line.body + line.eol).join('')
}

/** Stable sha256 over block bodies (line endings normalised away). */
export function blockHash(text) {
  const bodies = splitLines(text).map((line) => line.body)
  while (bodies.length && bodies[bodies.length - 1].trim() === '') bodies.pop()
  return createHash('sha256').update(bodies.join('\n')).digest('hex')
}

/**
 * Parse the top-level list items of a patch file.
 * `start`/`end` are line indices; `end` excludes trailing blank lines so the
 * separators between blocks stay byte-identical when a block is replaced.
 */
export function parsePatchBlocks(text) {
  const lines = splitLines(text)
  const starts = []
  for (let i = 0; i < lines.length; i++) {
    if (BLOCK_START.test(lines[i].body)) starts.push(i)
  }
  const blocks = []
  for (let index = 0; index < starts.length; index++) {
    const start = starts[index]
    const nextStart = index + 1 < starts.length ? starts[index + 1] : lines.length
    let end = nextStart
    while (end > start + 1 && lines[end - 1].body.trim() === '') end--
    const body = lines.slice(start, end)
    let id = null
    let name = null
    for (const line of body) {
      if (id === null) {
        const match = BLOCK_ID.exec(line.body)
        if (match) id = unquote(match[1])
      }
      if (name === null) {
        const named = BLOCK_NAME.exec(line.body)
        if (named) name = named[1].trim()
      }
      if (id !== null && name !== null) break
    }
    blocks.push({ start, end, nextStart, id, name, text: joinLines(body) })
  }
  return blocks
}

export function isModelPatchName(name) {
  if (!name) return false
  return MODEL_PATCH_NAMES.some((pattern) => pattern.test(name))
}

/** Names of the whitelisted model blocks present in `text`. */
export function modelBlockNames(text) {
  return parsePatchBlocks(text)
    .filter((block) => isModelPatchName(block.name))
    .map((block) => block.name)
}

/**
 * Three-way merge of the whitelisted model blocks.
 *
 * `baseHashes` maps block name -> hash agreed on the last successful sync.
 * Rules: adopt the peer block when this machine has no base and the peer file
 * is newer (an older peer copy must not roll this machine back); adopt when
 * only the peer changed; keep the local block when only this machine changed;
 * keep the local block and report a conflict when both changed. Blocks that
 * only exist on the peer are appended (additive, no mtime needed).
 *
 * Returns `{ text, changed, bases, adopted, conflicts }` where `conflicts` is a
 * list of `{ name, reason }`.
 */
export function mergeModelBlocks(localText, remoteText, baseHashes = {}, { localUpdatedAt = 0, remoteUpdatedAt = 0 } = {}) {
  const local = String(localText ?? '')
  const remote = String(remoteText ?? '')
  const localLines = splitLines(local)
  const localEol = dominantEol(localLines)
  const localBlocks = parsePatchBlocks(local).filter((block) => isModelPatchName(block.name))
  const remoteBlocks = parsePatchBlocks(remote).filter((block) => isModelPatchName(block.name))
  const localByName = new Map(localBlocks.map((block) => [block.name, block]))
  const bases = {}
  const adopted = []
  const conflicts = []
  const remoteOnly = []

  for (const block of remoteBlocks) {
    const remoteHash = blockHash(block.text)
    const localBlock = localByName.get(block.name)
    if (!localBlock) {
      remoteOnly.push(block)
      bases[block.name] = remoteHash
      adopted.push(block.name)
      continue
    }
    const localHash = blockHash(localBlock.text)
    if (localHash === remoteHash) {
      bases[block.name] = localHash
      continue
    }
    const baseHash = baseHashes[block.name] || null
    // No base yet (first sync). Adopt only when the peer copy is newer: both
    // machines run this merge, so unconditional adoption would let whichever
    // side pulls first overwrite the other with an older block.
    if (!baseHash) {
      if (remoteUpdatedAt > localUpdatedAt) {
        localByName.set(block.name, { ...localBlock, adopt: block })
        bases[block.name] = remoteHash
        adopted.push(block.name)
      } else {
        bases[block.name] = localHash
      }
      continue
    }
    const localChanged = localHash !== baseHash
    const remoteChanged = remoteHash !== baseHash
    if (remoteChanged && !localChanged) {
      localByName.set(block.name, { ...localBlock, adopt: block })
      bases[block.name] = remoteHash
      adopted.push(block.name)
      continue
    }
    if (remoteChanged && localChanged) {
      conflicts.push({ name: block.name, reason: '本机与对端都修改了该模型配置块，已保留本机' })
      continue
    }
    // Only the local side changed: remember what the peer has so a later peer
    // edit can be adopted, and keep the local bytes.
    bases[block.name] = remoteHash
  }

  // Apply adopted blocks bottom-up so earlier line indices stay valid.
  let output = localLines.map((line) => ({ ...line }))
  const replacements = [...localByName.values()]
    .filter((block) => block.adopt)
    .map((block) => ({ block, remote: block.adopt }))
    .sort((a, b) => b.block.start - a.block.start)
  for (const { block, remote: remoteBlock } of replacements) {
    const remoteLines = remoteBlockLines(remoteBlock, localEol, localLines[block.end - 1]?.eol ?? '')
    output.splice(block.start, block.end - block.start, ...remoteLines)
  }

  if (remoteOnly.length) {
    const appended = []
    for (const block of remoteOnly) appended.push(...remoteBlockLines(block, localEol, localEol))
    let insertAt = output.length
    while (insertAt > 0 && output[insertAt - 1].body.trim() === '') insertAt--
    if (insertAt > 0 && output[insertAt - 1].eol === '') output[insertAt - 1] = { ...output[insertAt - 1], eol: localEol }
    output.splice(insertAt, 0, ...appended)
  }

  const text = joinLines(output)
  return { text, changed: text !== local, bases, adopted, conflicts, eol: localEol }
}

function remoteBlockLines(block, eol, lastEol) {
  const lines = splitLines(block.text).map((line) => ({ body: line.body, eol }))
  while (lines.length && lines[lines.length - 1].body.trim() === '') lines.pop()
  if (!lines.length) return []
  if (lastEol) lines[lines.length - 1] = { ...lines[lines.length - 1], eol: lastEol }
  return lines
}

function dominantEol(lines) {
  for (const line of lines) if (line.eol) return line.eol
  return '\n'
}

function unquote(value) {
  const text = String(value ?? '').trim()
  if (text.length >= 2 && ((text[0] === '"' && text.endsWith('"')) || (text[0] === "'" && text.endsWith("'")))) {
    return text.slice(1, -1)
  }
  return text
}
