// Minimal glob matcher for path patterns in config.json. No dependencies.
//   *      any characters except '/'
//   **     any number of path segments (also none), only as a whole segment: '**/x', 'a/**', 'a/**/b'
//   ?      one character except '/'
//   {a,b}  alternatives (no nesting)
// A pattern without '/' matches the base name of the path (like .gitignore). Matching is case-insensitive:
// more matches mean more gates, which is the safe direction on case-insensitive file systems.

const cache = new Map<string, RegExp>()

function esc(c: string): string { return /[\\^$.*+?()[\]{}|/]/.test(c) ? '\\' + c : c }

function body(p: string): string {
  let out = ''
  for (let i = 0; i < p.length; i++) {
    const c = p[i]
    if (c === '*') {
      if (p[i + 1] === '*') {
        const atStart = i === 0 || p[i - 1] === '/'
        const atEnd = i + 2 === p.length || p[i + 2] === '/'
        if (!atStart || !atEnd) throw new Error(`glob ${JSON.stringify(p)}: '**' must be a whole path segment`)
        if (i + 2 === p.length) { out += '.*'; i += 1 } else { out += '(?:[^/]*/)*'; i += 2 }
        continue
      }
      out += '[^/]*'
    } else if (c === '?') {
      out += '[^/]'
    } else if (c === '{') {
      const end = p.indexOf('}', i)
      if (end < 0) throw new Error(`glob ${JSON.stringify(p)}: unclosed '{'`)
      const alts = p.slice(i + 1, end).split(',')
      if (alts.some((a) => a.includes('{'))) throw new Error(`glob ${JSON.stringify(p)}: nested '{' is not supported`)
      out += '(?:' + alts.map(body).join('|') + ')'
      i = end
    } else if (c === '}' ) {
      throw new Error(`glob ${JSON.stringify(p)}: unmatched '}'`)
    } else {
      out += esc(c)
    }
  }
  return out
}

export function globToRegExp(pattern: string): RegExp {
  let re = cache.get(pattern)
  if (re) return re
  if (typeof pattern !== 'string' || pattern.length === 0) throw new Error('glob pattern must be a non-empty string')
  const p = pattern.replace(/\\/g, '/').replace(/^\.\//, '')
  re = p.includes('/') ? new RegExp('^' + body(p.replace(/^\//, '')) + '$', 'i') : new RegExp('(?:^|/)' + body(p) + '$', 'i')
  cache.set(pattern, re)
  return re
}

/** Path relative to the repository (or absolute), '/' or '\\' separated. */
export function matchAny(path: string, patterns: readonly string[]): boolean {
  const s = path.replace(/\\/g, '/').replace(/^\.\//, '')
  for (const p of patterns) if (globToRegExp(p).test(s)) return true
  return false
}

/** Same, but a pattern also matches when it matches any suffix of the path (used for absolute paths). */
export function matchAnySuffix(path: string, patterns: readonly string[]): boolean {
  const s = path.replace(/\\/g, '/')
  const parts = s.split('/')
  for (let i = 0; i < parts.length; i++) if (matchAny(parts.slice(i).join('/'), patterns)) return true
  return false
}
