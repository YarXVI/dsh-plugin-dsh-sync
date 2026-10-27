// Line-level merge for `$DSH_HOME/.credentials.yaml`.
//
// The credentials store mixes two very different things:
//   - `refs:` entries: named secrets (model API keys among them),
//   - `records:` + account refs: this device's own session/account tokens.
// Only `*API_KEY` refs may travel between machines, and `records:` must never
// be copied. This module is pure (no fs, no YAML dependency) so the policy is
// easy to test: everything outside the merged ref lines is preserved verbatim.

const REF_HEADER = /^refs:\s*(?:#.*)?$/
const REF_LINE = /^(\s+)([A-Za-z0-9_.-]+):\s*(.*)$/
const TOP_LEVEL = /^\S/

export const API_KEY_REF = /API_KEY$/i

/** Split into `{ body, eol }` so CRLF/LF and trailing newlines survive. */
export function splitCredentialLines(text) {
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

export function joinCredentialLines(lines) {
  return lines.map((line) => line.body + line.eol).join('')
}

/** Locate the `refs:` section and its entries (raw line text kept). */
export function parseCredentialRefs(text) {
  const lines = splitCredentialLines(text)
  const refsIndex = lines.findIndex((line) => REF_HEADER.test(line.body))
  const refs = []
  if (refsIndex < 0) return { lines, refsIndex: -1, refsEnd: -1, refs }
  let refsEnd = lines.length
  for (let i = refsIndex + 1; i < lines.length; i++) {
    if (TOP_LEVEL.test(lines[i].body)) {
      refsEnd = i
      break
    }
  }
  for (let i = refsIndex + 1; i < refsEnd; i++) {
    const match = REF_LINE.exec(lines[i].body)
    if (!match) continue
    refs.push({ index: i, name: match[2], indent: match[1], value: match[3], body: lines[i].body })
  }
  return { lines, refsIndex, refsEnd, refs }
}

/** Only API_KEY refs may sync; session/account tokens never cross machines. */
export function isApiKeyRef(name) {
  return API_KEY_REF.test(String(name || ''))
}

/** Block scalars and unbalanced quotes cannot be copied line-by-line safely. */
export function isSelfContainedRefValue(value) {
  const text = String(value ?? '').trim()
  if (!text) return true
  if (text.startsWith('|') || text.startsWith('>')) return false
  if (text.startsWith('"') && !text.endsWith('"')) return false
  if (text.startsWith("'") && !text.endsWith("'")) return false
  return true
}

/**
 * Merge the peer's `*API_KEY` refs into the local credentials file.
 *
 * Returns `{ text, changed, added, conflicts, skipped }`:
 *  - `added`: ref names appended to the local `refs:` section,
 *  - `conflicts`: refs that exist locally with a different value (local wins,
 *    the caller records a conflict note; values are never returned),
 *  - `skipped`: refs that could not be copied safely (multi-line value).
 */
export function mergeCredentialRefs(localText, remoteText) {
  const remote = parseCredentialRefs(remoteText)
  const remoteKeys = remote.refs.filter((ref) => isApiKeyRef(ref.name))
  if (!remoteKeys.length) return { text: String(localText ?? ''), changed: false, added: [], conflicts: [], skipped: [] }

  const local = String(localText ?? '')
  const added = []
  const conflicts = []
  const skipped = []
  const remoteEol = remote.lines.find((line) => line.eol)?.eol || '\n'

  const localParsed = parseCredentialRefs(local)
  const existing = new Map(localParsed.refs.map((ref) => [ref.name, ref]))

  const insert = []
  for (const ref of remoteKeys) {
    const localRef = existing.get(ref.name)
    if (localRef) {
      if (String(localRef.value).trim() === String(ref.value).trim()) continue
      if (!isSelfContainedRefValue(ref.value) || !isSelfContainedRefValue(localRef.value)) {
        skipped.push(ref.name)
        continue
      }
      conflicts.push({ name: ref.name, reason: '本机已有该密钥的不同取值，已保留本机' })
      continue
    }
    if (!isSelfContainedRefValue(ref.value)) {
      skipped.push(ref.name)
      continue
    }
    insert.push(ref.body)
    added.push(ref.name)
  }

  if (!added.length) return { text: local, changed: false, added, conflicts, skipped }

  if (!local.trim()) {
    // Never copy the peer file wholesale (it contains records/device tokens):
    // start a minimal local store and append only the API_KEY refs.
    const eol = remoteEol
    const parts = ['version: 1' + eol, 'records: {}' + eol, 'refs:' + eol, ...insert.map((body) => body + eol)]
    return { text: parts.join(''), changed: true, added, conflicts, skipped }
  }

  const lines = localParsed.lines.map((line) => ({ ...line }))
  const localEol = lines.find((line) => line.eol)?.eol || remoteEol
  const inserted = insert.map((body) => ({ body, eol: localEol }))

  if (localParsed.refsIndex < 0) {
    if (lines.length && lines[lines.length - 1].eol === '') lines[lines.length - 1] = { ...lines[lines.length - 1], eol: localEol }
    lines.push({ body: 'refs:', eol: localEol }, ...inserted)
  } else {
    let insertAt = localParsed.refsEnd >= 0 ? localParsed.refsEnd : lines.length
    while (insertAt > localParsed.refsIndex + 1 && lines[insertAt - 1].body.trim() === '') insertAt--
    if (insertAt > 0 && lines[insertAt - 1].eol === '') lines[insertAt - 1] = { ...lines[insertAt - 1], eol: localEol }
    lines.splice(insertAt, 0, ...inserted)
  }
  const text = joinCredentialLines(lines)
  return { text, changed: text !== local, added, conflicts, skipped }
}

/** Ref names (API_KEY only) mentioned in a credentials file. */
export function credentialApiKeyNames(text) {
  return parseCredentialRefs(text).refs.filter((ref) => isApiKeyRef(ref.name)).map((ref) => ref.name)
}
