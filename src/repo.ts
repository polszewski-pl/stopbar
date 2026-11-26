// Repository discovery without spawning git, the git runner, and the content hash of the working tree.
import {execFileSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {copyFileSync, existsSync, readFileSync, rmSync, statSync} from 'node:fs'
import {dirname, isAbsolute, join, resolve} from 'node:path'

export class FailClosed extends Error {
  fix: string
  constructor(message: string, fix = '') { super(message); this.fix = fix }
}

export type Repo = {root: string; gitDir: string; stateDir: string}

/** Walks up from `cwd` to the first directory with `.git` (a directory, or a file `gitdir: ...` for worktrees and
 *  submodules). Pure file system: no git process in PreToolUse. */
export function findRepo(cwd: string): Repo {
  // Git Bash style /c/x on Windows means C:/x
  if (process.platform === 'win32') cwd = cwd.replace(/^\/([a-zA-Z])(\/|$)/, '$1:/')
  let dir = resolve(cwd)
  for (;;) {
    const dotGit = join(dir, '.git')
    let st
    try { st = statSync(dotGit) } catch { st = undefined }
    if (st?.isDirectory()) return {root: dir, gitDir: dotGit, stateDir: join(dotGit, 'stopbar')}
    if (st?.isFile()) {
      const m = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dotGit, 'utf8'))
      if (!m) throw new FailClosed(`${dotGit} is not a valid gitdir file`)
      const gd = isAbsolute(m[1]) ? m[1] : resolve(dir, m[1])
      return {root: dir, gitDir: gd, stateDir: join(gd, 'stopbar')}
    }
    const up = dirname(dir)
    if (up === dir) throw new FailClosed(`not inside a git repository: ${cwd}`, 'run Claude Code inside a git repository, or run `git init` and `stopbar init`')
    dir = up
  }
}

export let gitCalls = 0
export function git(cwd: string, args: string[], env?: Record<string, string>, input?: string): string {
  gitCalls++
  return execFileSync('git', args, {
    cwd, encoding: 'utf8', input, maxBuffer: 256 << 20, windowsHide: true,
    env: env ? {...process.env, ...env} : process.env, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
  }).replace(/\r?\n$/, '')
}

export function headTree(root: string): string | null {
  try { return git(root, ['rev-parse', '-q', '--verify', 'HEAD^{tree}']) } catch { return null }
}

// ---------------------------------------------------------------- working-tree snapshot
// A private index in the state dir, refreshed by one `git add -A` (it re-hashes only files whose stat data changed, sees
// edits, deletions and untracked non-ignored files, and ignores the user's staging area). The snapshot id is a sha256 over
// the index entries (mode, object id, path): equal ids = equal tree content. Comparing and diffing happen here, by reading
// the index file, so a hook needs one git process instead of three (on Windows each costs 50-70 ms).
export type Entries = Map<string, string> // path -> "<mode> <oid>"
export type Snap = {id: string; entries: Entries}
const GIT_FLAGS = ['-c', 'core.splitIndex=false', '-c', 'index.sparse=false', '-c', 'index.version=2', '-c', 'core.fsmonitor=false']
const idx = (r: Repo) => ({live: join(r.stateDir, 'snapshot.index'), counted: join(r.stateDir, 'snapshot.counted.index')})

/** Parses a git index file (versions 2, 3, 4; SHA-1 or SHA-256 object ids). Throws on anything it does not understand,
 *  including a checksum mismatch, so a damaged or unusual index is rebuilt instead of misread. */
export function parseIndex(buf: Buffer): Entries {
  if (buf.length < 12 || buf.toString('latin1', 0, 4) !== 'DIRC') throw new Error('not a git index')
  const version = buf.readUInt32BE(4), count = buf.readUInt32BE(8)
  if (version < 2 || version > 4) throw new Error(`index version ${version}`)
  let hashLen = 0
  for (const [len, algo] of [[20, 'sha1'], [32, 'sha256']] as const) {
    if (buf.length > 12 + len && createHash(algo).update(buf.subarray(0, buf.length - len)).digest().equals(buf.subarray(buf.length - len))) { hashLen = len; break }
  }
  if (!hashLen) throw new Error('index checksum mismatch')
  const out: Entries = new Map()
  let pos = 12, prev = ''
  for (let i = 0; i < count; i++) {
    const start = pos
    const mode = buf.readUInt32BE(pos + 24)
    const oid = buf.toString('hex', pos + 40, pos + 40 + hashLen)
    const flags = buf.readUInt16BE(pos + 40 + hashLen)
    pos += 40 + hashLen + 2
    if (flags & 0x4000) { if (version < 3) throw new Error('extended flag in index v2'); pos += 2 }
    if ((flags >> 12) & 3) throw new Error('unmerged entry in the private index')
    let path: string
    if (version === 4) {
      let n = 0, b
      do { b = buf[pos++]; n = (n << 7) | (b & 0x7f); if (b & 0x80) n++ } while (b & 0x80)
      const end = buf.indexOf(0, pos)
      if (end < 0 || n > Buffer.byteLength(prev)) throw new Error('bad v4 path')
      const pb = Buffer.from(prev)
      path = Buffer.concat([pb.subarray(0, pb.length - n), buf.subarray(pos, end)]).toString('utf8')
      pos = end + 1
    } else {
      const end = buf.indexOf(0, pos)
      if (end < 0) throw new Error('bad path')
      path = buf.toString('utf8', pos, end)
      pos = start + ((end - start + 8) & ~7)
    }
    if (pos > buf.length - hashLen) throw new Error('index truncated')
    out.set(path, `${mode.toString(8)} ${oid}`)
    prev = path
  }
  return out
}

export function digest(e: Entries): string {
  const h = createHash('sha256')
  for (const [p, v] of e) h.update(`${v} ${p}\0`)
  return h.digest('hex')
}

/** Refreshes the private index and returns the snapshot. One git process (two the first time). */
export function snapshot(r: Repo): Snap {
  const {live} = idx(r)
  const env = {GIT_INDEX_FILE: live}
  const fill = () => {
    if (!existsSync(live)) {
      try { git(r.root, [...GIT_FLAGS, 'read-tree', 'HEAD'], env) } catch { git(r.root, [...GIT_FLAGS, 'read-tree', '--empty'], env) }
    }
    git(r.root, [...GIT_FLAGS, 'add', '-A'], env)
    const entries = parseIndex(readFileSync(live))
    return {id: digest(entries), entries}
  }
  try { return fill() } catch {
    // damaged or unusual private index (torn write, other version): rebuild it once, then fail closed
    rmSync(live, {force: true})
    return fill()
  }
}

/** The entries of the last snapshot the kernel counted, if the saved copy still matches its id. */
export function countedEntries(r: Repo, id: string): Entries | null {
  try {
    const e = parseIndex(readFileSync(idx(r).counted))
    return digest(e) === id ? e : null
  } catch { return null }
}
export function markCounted(r: Repo) { copyFileSync(idx(r).live, idx(r).counted) }
export function forgetSnapshots(r: Repo) { for (const f of Object.values(idx(r))) rmSync(f, {force: true}) }

export function diffEntries(a: Entries, b: Entries): {status: string; path: string}[] {
  const out: {status: string; path: string}[] = []
  for (const [p, v] of b) { const old = a.get(p); if (old === undefined) out.push({status: 'A', path: p}); else if (old !== v) out.push({status: 'M', path: p}) }
  for (const p of a.keys()) if (!b.has(p)) out.push({status: 'D', path: p})
  return out.sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0))
}

/** Fallback diff when the counted copy is gone: the current snapshot against HEAD (one git process). */
export function changesSinceHead(r: Repo, now: Entries): {status: string; path: string}[] {
  try {
    const out = git(r.root, ['-c', 'core.quotepath=false', 'ls-tree', '-r', '-z', '--full-tree', 'HEAD'])
    const head: Entries = new Map()
    for (const rec of out.split('\0')) {
      const m = /^(\d+) \w+ ([0-9a-f]+)\t(.*)$/s.exec(rec)
      if (m) head.set(m[3], `${m[1].replace(/^0+/, '')} ${m[2]}`)
    }
    return diffEntries(head, now)
  } catch { return diffEntries(new Map(), now) }
}

/** Does the current private index differ from HEAD? (one git process; no HEAD = differs unless empty) */
export function differsFromHead(r: Repo, now: Entries): boolean {
  try {
    git(r.root, ['diff-index', '--cached', '--quiet', 'HEAD', '--'], {GIT_INDEX_FILE: idx(r).live})
    return false
  } catch (e) {
    if ((e as {status?: number}).status === 1) return true
    return now.size > 0 || headTree(r.root) !== null
  }
}

/** Which of `paths` exist in HEAD (one git process, only when test files changed). */
export function inHead(root: string, paths: string[]): Set<string> {
  if (!paths.length) return new Set()
  try {
    const out = git(root, ['--literal-pathspecs', '-c', 'core.quotepath=false', 'ls-tree', '-r', '-z', '--name-only', '--full-tree', 'HEAD', '--', ...paths])
    return new Set(out.split('\0').filter(Boolean))
  } catch { return new Set() }
}
