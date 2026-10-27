// Minimal glob matching for include/exclude rules (`*` never crosses `/`).
export function globToRegExp(pattern) {
  let out = '^'
  const text = String(pattern).replace(/\\/g, '/')
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '*') {
      if (text[i + 1] === '*') {
        i++
        if (text[i + 1] === '/') i++
        out += '.*'
      } else {
        out += '[^/]*'
      }
    } else if (ch === '?') {
      out += '[^/]'
    } else if ('\\^$+.()|{}[]'.includes(ch)) {
      out += '\\' + ch
    } else {
      out += ch
    }
  }
  out += '$'
  return new RegExp(out)
}

export function matches(relPath, pattern) {
  return globToRegExp(pattern).test(String(relPath).replace(/\\/g, '/'))
}

export function matchesAny(relPath, patterns) {
  return (patterns || []).some((pattern) => matches(relPath, pattern))
}

/** An include entry such as "plugins" also selects everything beneath it. */
export function matchesInclude(relPath, include) {
  const rel = String(relPath).replace(/\\/g, '/')
  return include.some((pattern) => {
    if (matches(rel, pattern)) return true
    if (!/[*?]/.test(pattern)) return rel === pattern || rel.startsWith(pattern + '/')
    return false
  })
}
