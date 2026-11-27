// Deterministic classification rules of the wrapper: file paths and the text of a shell command. No AST.
// Everything here is enforced by the wrapper, not by the proof (see SECURITY.md).
import type {Config, Paths} from './config.ts'
import {posix} from 'node:path'
import {matchAny, matchAnySuffix} from './glob.ts'

const norm = (p: string) => p.replace(/\\/g, '/')

export const isTestPath = (p: string, paths: Paths) => matchAny(norm(p), paths.tests)
export const isTestConfigPath = (p: string, paths: Paths) => matchAny(norm(p), paths.testConfig)
// Source-code extensions that a wildcard `secrets.*` pattern must not treat as secret data files
// (e.g. `src/integration/secrets.ts` is a TypeScript module, not a secret store).
const CODE_EXT = /\.(?:[cm]?[jt]sx?|py|go|rs|java|cs|rb|php|swift|kt|scala|c|cc|cpp|h|hpp|md)$/i
const WILDCARD_EXT_SECRET = /^(?:\*\*\/)?secrets\.\*$/i

function matchesSecretGlob(p: string, g: string): boolean {
  const n = norm(p)
  if (!matchAnySuffix(n, [g])) return false
  if (WILDCARD_EXT_SECRET.test(g) && CODE_EXT.test(n)) return false
  return true
}

/** The first secret pattern a path matches, or null. Absolute paths match too (a pattern may match any suffix). */
export function secretPattern(p: string, paths: Paths): string | null {
  for (const g of paths.secrets) if (matchesSecretGlob(p, g)) return g
  return null
}
export const isSecretPath = (p: string, paths: Paths) => secretPattern(p, paths) !== null

// ---------------------------------------------------------------- safe heredoc commit
// The one form of command substitution the wrapper lets through, the way Claude Code writes commit messages:
//   git commit [args] -m "$(cat <<'EOF'
//   ...message...
//   EOF
//   )"
// The delimiter is in single quotes, so bash expands nothing in the body: no variables, no $(...), no backticks.
// The prefix before -m must be a plain git commit without operators; nothing may follow `)"`.
// Only spaces and tabs between tokens: a newline is a command separator in bash.
const HEREDOC_RE = /^([^\n]*?)[ \t]+-m[ \t]+"\$\(cat[ \t]*<<[ \t]*'([A-Za-z_][A-Za-z0-9_]*)'\n((?:[^\n]*\n)*?)\2\n\)"[ \t]*\n?$/

export type SafeHeredoc = {prefix: string; message: string; delimiter: string}

export function parseSafeHeredocCommit(cmd: string): SafeHeredoc | null {
  if (cmd.includes('\r') || cmd.includes('\0')) return null
  const m = HEREDOC_RE.exec(cmd.replace(/^\s+/, ''))
  if (!m) return null
  const [, prefix, delimiter, message] = m
  if (scanPlain(prefix).chain) return null
  if (!COMMIT_ONLY_RE.test(prefix.trim())) return null
  // the body may not contain the delimiter line (the lazy match already guarantees this; checked again for clarity)
  if (message.split('\n').some((l) => l === delimiter)) return null
  return {prefix: prefix.trim(), message: message.replace(/\n$/, ''), delimiter}
}

/** Shell scan as bash sees it: operators and redirections count only outside quotes. Inside '...' everything is literal.
 *  Inside "..." the escapes \" \\ \$ \` work, but $(...) and `...` still run, so they are a chain.
 *  An unterminated quote is a chain (fail closed). Outside quotes \x is a literal x. */
function scanPlain(cmd: string): {chain: boolean; reason?: string} {
  let q: '' | "'" | '"' = ''
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i], n = cmd[i + 1]
    if (q === "'") { if (c === "'") q = ''; continue }
    if (q === '"') {
      if (c === '\\') { i++; continue }
      if (c === '"') { q = ''; continue }
      if (c === '`' || (c === '$' && n === '(')) return {chain: true, reason: 'command substitution inside double quotes'}
      continue
    }
    if (c === '\\') { i++; continue }
    if (c === "'" || c === '"') { q = c; continue }
    if (c === '`' || (c === '$' && n === '(')) return {chain: true, reason: 'command substitution'}
    if ('&|;<>\r\n'.includes(c)) return {chain: true, reason: `operator ${JSON.stringify(c)} outside quotes`}
  }
  return q ? {chain: true, reason: 'unterminated quote'} : {chain: false}
}

export function scanShell(cmd: string): {chain: boolean; reason?: string; heredoc?: boolean} {
  if (parseSafeHeredocCommit(cmd)) return {chain: false, heredoc: true}
  return scanPlain(cmd)
}
export const hasChain = (cmd: string) => scanShell(cmd).chain

/** The command text as bash joins quoted parts of one word: `.e""nv`, `.g''it`, `.e"n"v` and `.cl''aude` become `.env`,
 *  `.git`, `.env` and `.claude`. For the text scans of secrets and self-protection only (never for gate matching):
 *  empty quote pairs are dropped, and so is a quote between two characters of a word. */
export function unsplice(cmd: string): string {
  return cmd.replace(/""|''/g, '').replace(/(?<=[\w.\-/\\~])["'](?=[\w.\-/\\~])/g, '')
}

/** The command text with the quote pairs of every word removed, as bash joins the parts of a word: `'.cl'"aude"` is
 *  `.claude`, `.g"i"'t'` is `.git`, `gi"t"` is `git`. Separators (spaces, operators) and the spaces inside quotes stay as
 *  they are, so words are never joined across whitespace. Inside "..." the escapes \" \\ \$ \` work; inside '...' nothing.
 *  Outside quotes a backslash is kept as written (`g\it` is a known limit, SECURITY.md). An unterminated quote runs to the
 *  end. For the text scans (self-protection, secrets, the git subcommand) only; give it the command without the data
 *  bodies the caller skips (a plain `-m` message: commandForSelfProtect; a safe heredoc: its prefix). */
export function unquoteShellWords(cmd: string): string {
  let out = ''
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]
    if (c === "'") {
      const j = cmd.indexOf("'", i + 1)
      out += j < 0 ? cmd.slice(i + 1) : cmd.slice(i + 1, j)
      i = j < 0 ? cmd.length : j
    } else if (c === '"') {
      let j = i + 1
      for (; j < cmd.length && cmd[j] !== '"'; j++) {
        if (cmd[j] === '\\' && j + 1 < cmd.length && '"\\$`'.includes(cmd[j + 1])) j++
        out += cmd[j]
      }
      i = j
    } else if (c === '\\' && i + 1 < cmd.length) { out += c + cmd[i + 1]; i++ } else out += c
  }
  return out
}

// ---------------------------------------------------------------- risky / outbound shell
const NET_TOOLS = /\b(curl|wget|nc|ncat|netcat|socat|ssh|scp|sftp|rsync|ftp|tftp|telnet)\b/i
const PS_NET = /Invoke-WebRequest|Invoke-RestMethod|\biwr\b|\birm\b|Start-BitsTransfer|Net\.WebClient|System\.Net\.|Net\.Sockets/i
const INLINE_CODE = /\b(node|deno|bun)\s+(-e|--eval|-p|--print)\b|\bpython[0-9.]*\s+(-I\s+)?(-X\s+\S+\s+)?-c\b|\bperl\s+-e\b|\bruby\s+-e\b/i
const NET_WORDS = /https?:|fetch\(|\bnet\b|socket|urllib|requests|http\.client|dns|XMLHttpRequest|WebSocket/i
const OBFUSCATION = /base64\s+(-d|--decode)|FromBase64String|\beval\b|\biex\b|Invoke-Expression|-EncodedCommand|\bsh\s+-c\b|\bbash\s+-c\b/i
const PUBLISH = /\b(npm|pnpm|yarn)\s+publish\b|\btwine\s+upload\b|\bgit\s+(clone|fetch|pull|remote|ls-remote)\b|\bgh\s+(api|gist|release|pr|issue)\b/i

/** RISKY_OR_OUTBOUND: network tool, inline code with network words, obfuscation or publication. */
export function isRiskyShell(cmd: string): boolean {
  return NET_TOOLS.test(cmd) || PS_NET.test(cmd) || (INLINE_CODE.test(cmd) && NET_WORDS.test(cmd)) ||
    OBFUSCATION.test(cmd) || PUBLISH.test(cmd)
}

// ---------------------------------------------------------------- git commands
// git global options before the subcommand: -c k=v, -C dir, --git-dir=..., --work-tree ..., --no-pager, -p (values may be
// quoted). With a separate value (git 2.56 `git --help` and git.c): --git-dir, --work-tree, --namespace, --config-env,
// --attr-source; --exec-path, --super-prefix (older git) and --list-cmds are listed too. Any other `--opt=value` is one word.
const GV = String.raw`(?:"[^"]*"|'[^']*'|\S+)`
const GIT_GLOBALS = String.raw`(?:\s+(?:-[cC]\s*${GV}|--(?:git-dir|work-tree|namespace|exec-path|config-env|attr-source|super-prefix|list-cmds)(?:=|\s+)${GV}|--[\w-]+=${GV}|--[\w-]+|-[A-Za-z]))*`
const gitSub = (sub: string, flags = 'i') => new RegExp(String.raw`\bgit(?:\.exe)?${GIT_GLOBALS}\s+(?:${sub})\b`, flags)
const COMMIT_RE = gitSub('commit|push'), PUSH_RE = gitSub('push'), CONFIG_RE_G = gitSub('config', 'gi')
const COMMIT_ONLY_RE = new RegExp(String.raw`^git(?:\.exe)?${GIT_GLOBALS}\s+commit\b`, 'i')

/** Text a commit/push decision is made on: for a safe heredoc commit only the prefix (the message is data); as written
 *  and with the quotes of each word removed (`gi"t" commit` is `git commit`). */
const commandPart = (cmd: string) => parseSafeHeredocCommit(cmd)?.prefix ?? cmd
const gitTexts = (part: string) => [part, unquoteShellWords(part)]
export const isCommitCmd = (cmd: string) => gitTexts(commandPart(cmd)).some((t) => COMMIT_RE.test(t))
export const isPushCmd = (cmd: string) => gitTexts(commandPart(cmd)).some((t) => PUSH_RE.test(t))

// `git config` reads: only the tokens right after `config` decide, never a value at the end (`git config core.hooksPath
// list` is a write). A read is the subcommand `list` (no argument) or `get <name>` as the first positional word, or one
// of the options --get, --get-all, --get-regexp <name>, --get-urlmatch <name> <url>, --list / -l before the arguments;
// scope and format flags may stand around them. A write flag, an unknown flag, an expansion or any other argument count
// make it a write (fail closed).
const CFG_WRITE = new Set(['--add', '--unset', '--unset-all', '--replace-all', '--rename-section', '--remove-section', '--edit', '-e'])
const CFG_FLAG = new Set(['--local', '--global', '--system', '--worktree', '--includes', '--no-includes', '--show-origin', '--show-scope', '--null', '-z',
  '--name-only', '--all', '--regexp', '--fixed-value', '--show-names', '--no-show-names', '--bool', '--int', '--bool-or-int', '--path', '--expiry-date', '--no-type'])
const CFG_FLAG_ARG = new Set(['--file', '-f', '--blob', '--default', '--type', '--value', '--url'])
const CFG_READ_OPT = new Map([['--get', 1], ['--get-all', 1], ['--get-regexp', 1], ['--get-urlmatch', 2], ['--list', 0], ['-l', 0]])
const CFG_READ_SUB = new Map([['list', 0], ['get', 1]])

/** The words of one simple command, quotes removed, up to the first operator outside quotes (`;`, `&`, `|`, `(`, `)`,
 *  a newline, a redirection; a file descriptor number right before `<` / `>` is dropped). Null for an expansion ($, `)
 *  outside single quotes: its value is unknown. */
function simpleWords(s: string): string[] | null {
  const words: string[] = []
  let w = '', inWord = false
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === "'") { const j = s.indexOf("'", i + 1); w += j < 0 ? s.slice(i + 1) : s.slice(i + 1, j); inWord = true; i = j < 0 ? s.length : j; continue }
    if (c === '"') {
      let j = i + 1
      for (; j < s.length && s[j] !== '"'; j++) {
        if (s[j] === '\\' && j + 1 < s.length && '"\\$`'.includes(s[j + 1])) j++
        else if (s[j] === '$' || s[j] === '`') return null
        w += s[j]
      }
      inWord = true; i = j; continue
    }
    if (c === '$' || c === '`') return null
    if (c === '\\') { w += s[i + 1] ?? ''; inWord = true; i++; continue }
    if (c === ' ' || c === '\t') { if (inWord) words.push(w); w = ''; inWord = false; continue }
    if (';&|()\r\n'.includes(c)) break
    if (c === '<' || c === '>') { if (inWord && /^\d+$/.test(w)) inWord = false; break }
    w += c; inWord = true
  }
  if (inWord) words.push(w)
  return words
}

function configIsRead(args: string[]): boolean {
  let mode: number | undefined
  const pos: string[] = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a.length > 1 && a.startsWith('-')) {
      const eq = a.startsWith('--') ? a.indexOf('=') : -1, name = eq < 0 ? a : a.slice(0, eq)
      if (CFG_WRITE.has(name)) return false
      if (CFG_READ_OPT.has(name)) {
        if (eq >= 0 || pos.length || mode !== undefined) return false
        mode = CFG_READ_OPT.get(name); continue
      }
      if (CFG_FLAG_ARG.has(name)) { if (eq < 0 && ++i >= args.length) return false; continue }
      if (CFG_FLAG.has(name) && eq < 0) continue
      return false
    }
    if (!pos.length && mode === undefined && CFG_READ_SUB.has(a)) { mode = CFG_READ_SUB.get(a); continue }
    pos.push(a)
  }
  return mode !== undefined && pos.length === mode
}

/** Any `git config` in the text that is not a read (see above) is a write. */
export function isGitConfigWrite(cmd: string): boolean {
  for (const m of cmd.matchAll(CONFIG_RE_G)) {
    const rest = cmd.slice(m.index + m[0].length)
    if (rest && !/^[\s;&|()<>]/.test(rest)) return true
    const args = simpleWords(rest)
    if (!args || !configIsRead(args)) return true
  }
  return false
}

// A runner counts only as a command word: `cat pytest.ini` or `vim jest.config.js` is not a test run (fuzzer find, seed 12).
const END = String.raw`(?![\w.\-/\\])`
const TEST_RUNNER = new RegExp([
  String.raw`\bnode(?:\s+\S+)*?\s+--test${END}`,
  String.raw`\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test(?![\w.\-/\\])`,
  String.raw`(?:^|[\s;&|(])(?:npx\s+|pnpm\s+exec\s+|yarn\s+|uv\s+run\s+)?(?:vitest|jest|mocha|ava|py\.test|pytest|tox|nox)${END}`,
  String.raw`\bplaywright\s+test${END}`,
  String.raw`\bpython[0-9.]*(?:\s+\S+)*?\s+-m\s+(?:pytest|unittest)${END}`,
  String.raw`\bgo\s+test${END}`, String.raw`\bcargo\s+test${END}`,
].join('|'), 'i')
export const looksLikeTests = (cmd: string) => TEST_RUNNER.test(cmd)

// Extension-only patterns such as *.key or *.pem: a bare token like `claim.key` or `self.key` is usually code (a field
// access), not a file. Such a token counts only when the file exists; a token with a path separator (`certs/a.key`)
// and every other pattern (`.env*`, `id_rsa*`, `auth.json`, `**/secrets/**`) count always.
const EXT_ONLY = /^\*\.[^/*?{}\[\]]+$/
export type SecretHit = {token: string; pattern: string}

// Commands that print the whole environment (tokens, keys) count as a secret read, as a file would. `env VAR=1 cmd` and a
// bare `set` do not count: the first runs a command, the second is too common in scripts (a known limit, SECURITY.md).
const ENV_DUMP: [RegExp, string][] = [
  [/(?:^|[\s;&|(`])printenv(?![\w.\-])/i, 'env:printenv'],
  [/(?:^|[\s;&|(`])(?:Get-ChildItem|gci|dir|ls|Get-Item|gi|Get-Content|gc|cat|type)\s+(?:-(?:Path|LiteralPath)\s+)?Env:/i, 'env:Get-ChildItem Env:'],
  [/(?:^|[;&|(`\n])\s*env\s*(?:-0\s*)?(?=$|[;&|>)\n])/i, 'env:env'],
  [/\/proc\/(?:self|\d+|\$\$)\/environ\b/i, 'env:/proc/environ'],
]
const HAS_GLOB = /[*?[{]/

/** One path segment of a shell glob (`*`, `?`, `[...]`, `{a,b}`) as a RegExp (case-insensitive: Windows, and wider is
 *  safer here), or null when it cannot be read. */
export function globSegment(seg: string): RegExp | null {
  let re = '', depth = 0
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i]
    if (c === '*') re += '.*'
    else if (c === '?') re += '.'
    else if (c === '[') {
      const j = seg.indexOf(']', i + 2)
      if (j < 0) { re += '\\['; continue }
      const body = seg.slice(i + 1, j).replace(/\\/g, '\\\\')
      re += `[${body[0] === '!' ? '^' + body.slice(1) : body}]`
      i = j
    } else if (c === '{') { re += '(?:'; depth++ }
    else if (c === ',' && depth) re += '|'
    else if (c === '}' && depth) { re += ')'; depth-- }
    else re += c.replace(/[.+^$()|\\/\]]/g, '\\$&')
  }
  if (depth) return null
  try { return new RegExp(`^${re}$`, 'i') } catch { return null }
}

/** Names a wildcard may reach: the literal secret patterns and the `<prefix>*` ones (`.env*` gives .env and .env.local). */
function secretSamples(paths: Paths): string[] {
  const out: string[] = []
  for (const g of paths.secrets) {
    const last = g.split('/').pop() ?? ''
    if (!/^[^*?[{]+\*?$/.test(last)) continue
    const base = last.replace(/\*$/, '')
    out.push(base, ...(last.endsWith('*') ? [`${base}.local`] : []))
  }
  return out
}

/** The first secret path named in a command (e.g. `cat .env`, `type secrets\\db.txt`), with the pattern it matched.
 *  Also: a command that prints the environment (printenv, Get-ChildItem Env:), `..` segments (`src/../.env`), and a
 *  wildcard that reaches a secret name (`.en*`, `.en?`, `src/../.e*`). */
export function secretInCommand(cmd: string, paths: Paths, exists: (p: string) => boolean = () => true, shell: 'bash' | 'powershell' = 'bash'): SecretHit | null {
  cmd = normPwd(cmd)
  const words = (s: string) => s.split(/[\s'"=(),;|&<>@:]+/).filter(Boolean)
  const texts = [cmd, unsplice(cmd), unquoteShellWords(cmd)]
  if (paths.secrets.length) {
    for (const t of texts) for (const [re, pattern] of ENV_DUMP) {
      const m = re.exec(t)
      if (m) return {token: m[0].replace(/^[\s;&|(`]+/, '').trim(), pattern}
    }
  }
  // the words as written, then as bash joins them (`.e""nv` is `.env`); each also with its `..` segments resolved
  for (const tok of new Set(texts.flatMap(words))) {
    const n = posix.normalize(norm(tok))
    for (const cand of n === tok ? [tok] : [tok, n]) {
      const hits = paths.secrets.filter((g) => matchesSecretGlob(cand, g))
      if (!hits.length) continue
      const strong = hits.find((g) => !EXT_ONLY.test(g))
      if (strong) return {token: tok, pattern: strong}
      if (/[\\/]/.test(cand) || exists(cand)) return {token: tok, pattern: hits[0]}
    }
  }
  // wildcards that expand: bash expands none inside quotes or after a backslash; PowerShell -Path expands them quoted too
  const samples = secretSamples(paths)
  for (const tok of new Set(words(shell === 'bash' ? globView(cmd) : unquoteShellWords(cmd)))) {
    // the last segment: dot-leading (bash matches dotfiles only so), or after a literal prefix of 2+ chars
    const last = posix.normalize(norm(tok)).split('/').pop() ?? ''
    const at = last.search(HAS_GLOB)
    if (at < 0 || !(last.startsWith('.') || at >= 2)) continue
    const re = globSegment(last)
    if (!re) continue
    for (const s of samples) {
      const pattern = re.test(s) ? secretPattern(s, paths) : null
      if (pattern) return {token: tok, pattern}
    }
  }
  // find -name/-path <pattern> -exec ...: find expands the pattern itself; also `*.key` (a.key) and `**/x/**` (x/a)
  const extra = paths.secrets.flatMap((g) => {
    const last = g.split('/').pop() ?? ''
    if (EXT_ONLY.test(last)) return [`a${last.slice(1)}`]
    const dir = /^\*\*\/([^*?[{\/]+)\/\*\*$/.exec(g)
    return dir ? [`${dir[1]}/a`] : []
  })
  const f = findReaches(cmd, [...samples, ...extra], false)
  if (f) { const pattern = secretPattern(f.name, paths); if (pattern) return {token: `find ${f.pat}`, pattern} }
  return null
}

/** The command as bash joins its words, with the glob characters that do not expand (inside quotes, after a backslash)
 *  replaced by \x01, so only live wildcards are left. */
function globView(cmd: string): string {
  let out = ''
  const mask = (s: string) => s.replace(/[*?[\]{}]/g, '\x01')
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]
    if (c === "'") {
      const j = cmd.indexOf("'", i + 1)
      out += mask(j < 0 ? cmd.slice(i + 1) : cmd.slice(i + 1, j))
      i = j < 0 ? cmd.length : j
    } else if (c === '"') {
      let j = i + 1
      for (; j < cmd.length && cmd[j] !== '"'; j++) {
        if (cmd[j] === '\\' && j + 1 < cmd.length && '"\\$`'.includes(cmd[j + 1])) j++
        out += mask(cmd[j])
      }
      i = j
    } else if (c === '\\' && i + 1 < cmd.length) { out += mask(cmd[i + 1]); i++ } else out += c
  }
  return out
}
export const mentionsSecret = (cmd: string, paths: Paths, exists?: (p: string) => boolean) => secretInCommand(cmd, paths, exists) !== null

export type BashKind =
  | {kind: 'build'} | {kind: 'fulltest'}
  | {kind: 'commit'; heredoc: boolean; push: boolean} | {kind: 'commit-chained'; reason: string}
  | {kind: 'gate-chained'; gate: string; reason: string}
  | {kind: 'shell'; risky: boolean; partialTests: boolean; secret: SecretHit | null}

/** Exact match of gate commands: no chain operators, no extra arguments. `shell` is 'bash' or 'powershell'. */
export function classifyBash(cmd: string, cfg: Pick<Config, 'buildCmd' | 'fullTestCmd' | 'paths'>, shell: 'bash' | 'powershell' = 'bash', exists?: (p: string) => boolean): BashKind {
  const c = cmd.trim()
  const scan: {chain: boolean; reason?: string; heredoc?: boolean} = shell === 'bash' ? scanShell(c) : scanPlain(c)
  if (gitTexts(scan.heredoc ? commandPart(c) : c).some((t) => COMMIT_RE.test(t))) {
    if (scan.chain) return {kind: 'commit-chained', reason: scan.reason ?? 'chain'}
    return {kind: 'commit', heredoc: !!scan.heredoc, push: isPushCmd(c)}
  }
  // a gate command with operators (`node --test; echo $?`, `|| true`, `| tail`) hides its exit status: blocked in PreToolUse
  if (scan.chain) {
    for (const g of [cfg.fullTestCmd.trim(), cfg.buildCmd.trim()]) if (g && c.includes(g)) return {kind: 'gate-chained', gate: g, reason: scan.reason ?? 'chain'}
  } else {
    if (c === cfg.buildCmd.trim()) return {kind: 'build'}
    if (c === cfg.fullTestCmd.trim()) return {kind: 'fulltest'}
  }
  return {kind: 'shell', risky: isRiskyShell(c), partialTests: looksLikeTests(c), secret: secretInCommand(c, cfg.paths, exists, shell)}
}

/** Kind of a tree change from a list of (status, path) and a test for "the path exists in the reference tree"
 *  (baseRef, else HEAD).
 *  `sameAsRef` (given with an explicit baseRef): "the file now has the same blob id as in baseRef, or is absent from
 *  both". Then a test-config file is suspicious only when its content differs from baseRef, and an existing test only
 *  when it differs from baseRef (changed or deleted), so tests taken over unchanged from baseRef (checkout, rebase,
 *  cherry-pick) do not taint. Without `sameAsRef` (no baseRef: HEAD, which the agent's own git commands can move),
 *  every change of test config and of an existing test is suspicious. */
export function classifyTreeChange(changes: {status: string; path: string}[], inHead: (p: string) => boolean, paths: Paths, sameAsRef?: (p: string) => boolean) {
  let anyTest = false, suspicious = false
  const why: string[] = []
  for (const {status, path} of changes) {
    if (isTestConfigPath(path, paths)) {
      anyTest = true
      if (sameAsRef?.(path)) why.push(`config ${status} ${path} (same as base ref)`)
      else { suspicious = true; why.push(`config ${status} ${path}`) }
      continue
    }
    if (isTestPath(path, paths)) {
      anyTest = true
      if (!inHead(path)) why.push(`new test ${status} ${path}`)
      else if (sameAsRef?.(path)) why.push(`existing test ${status} ${path} (same as base ref)`)
      else { suspicious = true; why.push(`existing test ${status} ${path}`) }
    }
  }
  return {op: anyTest ? 'EDIT_TEST' as const : 'EDIT_CODE' as const, suspicious, why}
}

// ---------------------------------------------------------------- self-protection
// Unconditional BLOCK in PreToolUse, outside the kernel. Paths are compared normalised: '/' separators, lower case.
/** `hooksDir`: the directory a custom `core.hooksPath` points to (absolute; set only when it is outside the default
 *  .git/hooks and not the working tree root or above it); `hooksPathRaw`: the value as written in the git config. */
export type Protect = {gitDir: string; stateDir: string; codeDirs: string[]; hooksDir?: string; hooksPathRaw?: string}

const lc = (p: string) => norm(p).toLowerCase().replace(/\/+$/, '')
const under = (a: string, dir: string) => a === dir || a.startsWith(dir + '/')

/** The Protect fields of a custom core.hooksPath (repo.ts readHooksPath). A value that names the working tree root or a
 *  directory above it would protect the whole tree: then only the raw value is kept (it is ignored when it is `.`). */
export function hooksProtect(root: string, hp: {raw: string; dir: string} | null): Pick<Protect, 'hooksDir' | 'hooksPathRaw'> {
  if (!hp) return {}
  return under(lc(root), lc(hp.dir)) ? {hooksPathRaw: hp.raw} : {hooksDir: hp.dir, hooksPathRaw: hp.raw}
}

// the files of the git hook managers Husky and Lefthook: a tracked hook there calls `stopbar git-hook`
const HOOK_MANAGER_PATH = /(^|\/)(?:\.husky(?:\/|$)|\.lefthook(?:\/|$)|\.?lefthook(?:-local)?\.ya?ml$)/

// the hook configuration of every supported client (project and user level)
const AGENT_CONFIG: [RegExp, string][] = [
  [/(^|\/)\.claude\/[^/]*settings[^/]*\.json$/, 'Claude Code settings (.claude/settings*.json)'],
  [/(^|\/)\.cursor\/hooks\.json$/, 'Cursor hooks (.cursor/hooks.json)'],
  [/(^|\/)\.codex\/(hooks\.json|config\.toml)$/, 'Codex CLI hooks (.codex/hooks.json, .codex/config.toml)'],
  [/(^|\/)\.gemini\/([^/]*settings[^/]*\.json|(.*\/)?hooks\.json)$/, 'Gemini CLI and Antigravity settings (.gemini/settings*.json, .gemini/**/hooks.json)'],
  [/(^|\/)\.agents\/hooks\.json$/, 'Antigravity CLI hooks (.agents/hooks.json)'],
]

/** File path written by an Edit/Write tool. Returns the reason for a block, or null. */
export function protectedPath(abs: string, root: string, pr: Protect): string | null {
  const a = lc(abs), r = lc(root)
  // inside the repository the .git test runs on the relative path; outside it on the whole path (other repositories)
  const tail = under(a, r) ? a.slice(r.length) : a
  if (/(^|\/)\.git(\/|$)/.test(tail) || under(a, lc(pr.gitDir)) || under(a, lc(pr.stateDir))) return 'git metadata (.git/**, Stopbar state, git hooks, git config)'
  for (const [re, what] of AGENT_CONFIG) if (re.test(a)) return `${what} hold the Stopbar hooks`
  if (HOOK_MANAGER_PATH.test(tail)) return 'git hook manager files (.husky/**, lefthook*.yml, .lefthook/**) call the Stopbar git hooks'
  if (pr.hooksDir && under(a, lc(pr.hooksDir))) return `the custom core.hooksPath directory (${pr.hooksPathRaw ?? pr.hooksDir}) holds the git hooks`
  for (const d of pr.codeDirs) if (under(a, lc(d))) return `Stopbar code (${d})`
  return null
}

const SEG = (name: string) => new RegExp(String.raw`(^|[^a-z0-9_.\-])${name.replace(/\./g, '\\.')}([^a-z0-9_\-]|$)`, 'i')
const DOT_GIT = SEG('.git')
const AGENT_DIRS: [RegExp, string][] = [[SEG('.claude'), '.claude'], [SEG('.cursor'), '.cursor'], [SEG('.codex'), '.codex'], [SEG('.gemini'), '.gemini'], [SEG('.agents'), '.agents']]
const HOOK_MANAGERS: [RegExp, string][] = [[SEG('.husky'), '.husky'], [SEG('.lefthook'), '.lefthook'],
  [/(^|[^a-z0-9_.\-])\.?lefthook(?:-local)?\.ya?ml([^a-z0-9_\-]|$)/i, 'lefthook*.yml']]
const LEFTHOOK_FILES = ['lefthook', '.lefthook', 'lefthook-local', '.lefthook-local'].flatMap((b) => [`${b}.yml`, `${b}.yaml`])
const reEsc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const PATH_END = String.raw`(?=[/\s'";&|)<>]|$)`

/** The custom core.hooksPath as a relative value (`./` and trailing `/` dropped), or null when it is empty, `.`, `..`,
 *  `/`, absolute or above the tree. */
function relHooksPath(pr: Protect): string | null {
  const r = norm(pr.hooksPathRaw ?? '').replace(/^(?:\.\/)+/, '').replace(/\/+$/, '')
  if (!r || r === '.' || r.startsWith('../') || r === '..' || /^(?:[a-z]:)?\//i.test(r) || r.startsWith('~')) return null
  return r
}
/** Regular expressions for the custom core.hooksPath in a command (lower case text): the relative value as a path from
 *  the working tree (at a word start or after `./`), and the absolute directory (also as Git Bash writes it, /c/...). */
function hooksPathNeedles(pr: Protect): RegExp[] {
  const out: RegExp[] = []
  const rel = relHooksPath(pr)
  if (rel) out.push(new RegExp(String.raw`(?:^|[\s'"=(;&|<>]|\./)${reEsc(rel.toLowerCase())}${PATH_END}`))
  if (pr.hooksDir) {
    const abs = lc(pr.hooksDir)
    for (const a of new Set([abs, abs.replace(/^([a-z]):/, '/$1')])) out.push(new RegExp(reEsc(a) + PATH_END))
  }
  return out
}
/** Directory names a wildcard or a `find` pattern must not reach: .git, the agent settings and hook managers, and the
 *  first segment of a relative custom core.hooksPath (and its last one, for find). */
function guardedNames(pr: Protect | undefined, forFind: boolean): string[] {
  const out = [...GUARDED]
  const rel = pr ? relHooksPath(pr) : null
  if (rel) {
    const first = rel.split('/')[0]
    if (forFind || first.startsWith('.')) out.push(first)
  }
  if (forFind && pr?.hooksDir) out.push(norm(pr.hooksDir).replace(/\/+$/, '').split('/').pop()!)
  return [...new Set(out.filter(Boolean))]
}
const guardReason = (d: string) => d === '.git' ? 'Stopbar state, git hooks, git config live there'
  : /^\.(?:claude|cursor|codex|gemini|agents)$/.test(d) ? 'agent settings there hold the Stopbar hooks' : 'the git hooks there call Stopbar'

/** `$(pwd)`, `"$(pwd)"`, `${PWD}`, `$PWD`, `` `pwd` `` (each also in double quotes, `pwd -L|-P` too) as `.`: the current
 *  directory, so `rm -rf $(pwd)/.g*` reads as `rm -rf ./.g*`. For the text scans only. */
const PWD_ONE = String.raw`\$\(\s*pwd(?:\s+-[LP])?\s*\)|\$\{PWD\}|\$PWD(?!\w)|\x60\s*pwd(?:\s+-[LP])?\s*\x60`
const PWD_FORMS = new RegExp(`"(?:${PWD_ONE})"|${PWD_ONE}`, 'g')
export const normPwd = (cmd: string) => cmd.replace(PWD_FORMS, '.')

// `find` with a name or path predicate and an action. `find` expands the pattern itself, so a quoted `-name '.g*'` is a
// live wildcard (unlike a quoted word for bash).
const FIND_PRED = /^-i?(?:name|path|wholename)$/i
const FIND_EXEC = /^-(?:exec|execdir|ok|okdir)$/
type FindCall = {preds: {path: boolean; pat: string; re: RegExp}[]; del: boolean; exec: boolean}
function findCalls(cmd: string): FindCall[] {
  const out: FindCall[] = []
  let cur: FindCall | null = null, start = true
  const ws = shellWords(cmd)
  for (let i = 0; i < ws.length; i++) {
    const w = ws[i]
    if (w.length === 1 && ';&|()\n'.includes(w)) { cur = null; start = true; continue }
    const u = unquoteShellWords(w)
    if (start) {
      if (/^\w+=/.test(u) || /^(?:sudo|command|exec|nice|time|xargs|env)$/i.test(u)) continue
      start = false
      if (/^g?find$/i.test(norm(u).split('/').pop()!.replace(/\.exe$/i, ''))) { cur = {preds: [], del: false, exec: false}; out.push(cur) }
      continue
    }
    if (!cur) continue
    if (FIND_PRED.test(u) && i + 1 < ws.length) {
      const pat = unquoteShellWords(ws[++i]).replace(/\\(.)/g, '$1')
      const re = globSegment(pat)
      if (re) cur.preds.push({path: /path|wholename/i.test(u), pat, re})
    } else if (u === '-delete') cur.del = true
    else if (FIND_EXEC.test(u)) cur.exec = true
  }
  return out
}
/** The first name a find pattern reaches (`-name` on the last segment, `-path` on the path below `.`), for the find
 *  calls with -exec/-execdir/-ok/-okdir (and -delete when `withDelete`). */
function findReaches(cmd: string, names: string[], withDelete: boolean): {name: string; pat: string} | null {
  for (const c of findCalls(cmd)) {
    if (!(c.exec || (withDelete && c.del))) continue
    for (const p of c.preds) for (const n of names) {
      if (!p.path && n.includes('/')) continue
      const cands = p.path ? [n, `./${n}`, `./a/${n}`, `./${n}/a`, `./a/${n}/a`] : [n]
      if (cands.some((x) => p.re.test(x))) return {name: n, pat: p.pat}
    }
  }
  return null
}
const HUMAN_ONLY = /\b(approve-tests|approve-shell)\b|\bSTOPBAR_[A-Z_]+/i
// an admin subcommand right after the program word (`stopbar`, `stopbar.mjs`, `stopbar@1.2.0`, `.../stopbar/dist/cli.js`,
// quoted or not): `stopbar init` is human-only, `stopbar probe init` (a prober scaffold, SKILL.md) is the agent's
const STOPBAR_ADMIN = /stopbar[^\s"'|;&]*["']?\s+(?:init|resume|reset|upgrade|doctor\b[^\n;&|]*?\s--fix)\b/i

/** Command text inspected by self-protection. For a plain single-command `git commit` (chain-free, no substitution),
 *  strips the commit message (safe heredoc body or quoted `-m` / `--message` string) because git treats it as data. */
export function commandForSelfProtect(cmd: string, shell: 'bash' | 'powershell' = 'bash'): string {
  if (shell !== 'bash') return cmd
  const c = cmd.trim()
  const hd = parseSafeHeredocCommit(c)
  if (hd) return hd.prefix
  if (!COMMIT_ONLY_RE.test(c) || scanPlain(c).chain) return cmd
  // Quote-aware strip of top-level `-m "..."` / `-am '...'` / `--message="..."` literals.
  let out = ''
  for (let i = 0; i < c.length;) {
    const ch = c[i]
    if (ch === "'" || ch === '"') {
      const start = i++
      while (i < c.length && c[i] !== ch) { if (ch === '"' && c[i] === '\\') i++; i++ }
      i++
      out += c.slice(start, i)
      continue
    }
    if (ch === '\\') { out += c.slice(i, i + 2); i += 2; continue }
    const atWordStart = i === 0 || /\s/.test(c[i - 1])
    if (atWordStart && ch === '-') {
      const m = /^(?:-[a-zA-Z]*m(?:\s+|(?=["']))|--message(?:=|\s+))/.exec(c.slice(i))
      if (m) {
        const after = i + m[0].length
        const q = c[after]
        if (q === '"' || q === "'") {
          let j = after + 1
          while (j < c.length && c[j] !== q) { if (q === '"' && c[j] === '\\') j++; j++ }
          if (j < c.length) { out += '-m ""'; i = j + 1; continue }
        }
      }
    }
    out += ch; i++
  }
  return out
}

// `git -c alias.ci=commit ci` (also `-calias.`, `--config-env alias.`, GIT_CONFIG_KEY_n=alias.): a one-off alias hides
// the real git subcommand from the classification of commits and pushes in PreToolUse.
const GIT_ALIAS = new RegExp(String.raw`\bgit(?:\.exe)?${GIT_GLOBALS}\s+(?:-c\s*|--config-env(?:=|\s+))["']?\s*alias\.`, 'i')
const GIT_ALIAS_ENV = /\bGIT_CONFIG_(?:PARAMETERS\b|KEY_\d+\s*=\s*["']?alias\.)/i

// A single-quoted heredoc fed to a command as stdin, e.g. a prompt for another agent CLI: `agy -p - <<'EOF'` ... `EOF`.
// With the delimiter in quotes bash expands nothing in the body, so the body is data for the command, unless the command
// runs it as code (a shell or an interpreter, xargs, at), hands it to Stopbar, or stores it in a file (> / >>, tee).
const STDIN_HEREDOC = /<<-?[ \t]*'([A-Za-z_][A-Za-z0-9_]*)'/g
const RUNS_STDIN = /^(?:sh|bash|zsh|dash|ksh|fish|pwsh|powershell|cmd|eval|source|\.|node|deno|bun|tsx|ts-node|python[0-9.]*|py|pypy[0-9.]*|perl|ruby|php|lua|osascript|xargs|parallel|at|batch|crontab|tee|dd|stopbar(?:\.mjs)?)$/i

/** The command without the body of its one single-quoted heredoc, when that body is plain stdin data (see above);
 *  else null. The lines before and after the heredoc stay: they are commands. */
export function withoutStdinHeredoc(cmd: string): string | null {
  if (cmd.includes('\r') || cmd.includes('\0')) return null
  const all = [...cmd.matchAll(STDIN_HEREDOC)]
  if (all.length !== 1 || (cmd.match(/<</g) ?? []).length !== 1) return null
  const m = all[0], at = m.index
  const lineStart = cmd.lastIndexOf('\n', at) + 1
  const nl = cmd.indexOf('\n', at)
  if (nl < 0) return null
  const header = cmd.slice(lineStart, at) + ' ' + cmd.slice(at + m[0].length, nl)
  const lines = cmd.slice(nl + 1).split('\n')
  const end = lines.indexOf(m[1])
  if (end < 0) return null // no closing delimiter line: not a heredoc this function understands
  // on the header line, outside quotes: a write redirection (fd duplication such as 2>&1 is fine) or a pipe; outside
  // single quotes: an expansion ($X, $(...), `...`), which may name an interpreter (X=bash; $X <<'EOF')
  if (/>(?!&\d)|&>|\|/.test(header.replace(/'[^']*'|"(?:\\.|[^"\\])*"/g, "''"))) return null
  if (/[$`]/.test(header.replace(/'[^']*'/g, "''"))) return null
  // a word anywhere before the body that runs or stores stdin (also in a function or alias defined on an earlier line)
  for (const w of (cmd.slice(0, at) + ' ' + header).split(/[\s;&|(){}<>=]+/).filter(Boolean)) {
    const base = w.replace(/^["']+|["']+$/g, '').replace(/\\/g, '/').split('/').pop()!.replace(/\.exe$/i, '')
    if (RUNS_STDIN.test(base)) return null
  }
  return [cmd.slice(0, nl), ...lines.slice(end)].join('\n')
}

// A wildcard that reaches .git or an agent settings directory (`rm -rf .g*`, `mv .cl* x`, `Remove-Item .g*`): blocked
// for the commands that delete or move, and for any command when the wildcard is followed by a path inside such a
// directory (`cp x .g*/hooks/pre-commit`). Other wildcards (`rm *.log`, a `.*` in a grep pattern) stay allowed.
const GUARDED = ['.git', '.claude', '.cursor', '.codex', '.gemini', '.agents', '.husky', '.lefthook']
const DESTRUCTIVE = /^(?:rm|rmdir|unlink|shred|mv|del|erase|rd|move|remove-item|ri|move-item|mi)$/i
const INSIDE = /^(?:hooks|config|stopbar|info|refs|head|index|objects|settings[\w.-]*\.json|hooks\.json|pre-commit|pre-push|_)$/i
/** `t`: the command with only live wildcards left (globView for bash). `names`: guardedNames. */
function wildcardGuardedDir(t: string, names: string[] = GUARDED): string | null {
  const globDir = (seg: string) => (HAS_GLOB.test(seg) && /^[.?[]/.test(seg) ? names.find((d) => globSegment(seg)?.test(d)) ?? null : null)
  for (const part of norm(t).split(/[;&|\n()`]+/)) {
    const ws = part.split(/[\s<>='"]+/).filter(Boolean)
    let k = 0
    while (k < ws.length && (/^\w+=/.test(ws[k]) || /^(?:sudo|command|exec|nice|time)$/i.test(ws[k]))) k++
    const destructive = DESTRUCTIVE.test((ws[k] ?? '').split('/').pop()!.replace(/\.exe$/i, ''))
    for (const w of ws.slice(k + 1)) {
      const segs = w.split('/')
      for (let i = 0; i < segs.length; i++) {
        const d = globDir(segs[i])
        if (d && (destructive || (i + 1 < segs.length && INSIDE.test(segs[i + 1])))) return d
      }
    }
  }
  return null
}

/** Shell words with their quotes kept; the operators ; & | ( ) and newline are words of their own. */
function shellWords(cmd: string): string[] {
  const out: string[] = []
  let w = ''
  const flush = () => { if (w) out.push(w); w = '' }
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]
    if (c === ' ' || c === '\t' || c === '\r') { flush(); continue }
    if (';&|()\n'.includes(c)) { flush(); out.push(c); continue }
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1
      for (; j < cmd.length && cmd[j] !== c; j++) if (c !== "'" && cmd[j] === '\\') j++
      w += cmd.slice(i, j + 1); i = j; continue
    }
    if (c === '$' && cmd[i + 1] === '(') {
      let j = i + 2, depth = 1
      for (; j < cmd.length && depth; j++) depth += cmd[j] === '(' ? 1 : cmd[j] === ')' ? -1 : 0
      w += cmd.slice(i, j); i = j - 1; continue
    }
    if (c === '\\' && i + 1 < cmd.length) { w += cmd.slice(i, i + 2); i++; continue }
    w += c
  }
  flush()
  return out
}
// `git $f -m x`, `p=push; git $p`, `git "${cmd}"`, git `echo push`: the subcommand comes from an expansion, so the commit
// and push gates cannot see it. A `git` inside a quoted string is one word with its quotes, so it is no command here.
const GIT_OPT_ARG = /^(?:-[cC]|--(?:git-dir|work-tree|namespace|exec-path|config-env|attr-source|super-prefix))$/
export function dynamicGitSubcommand(cmd: string): string | null {
  const ws = shellWords(cmd)
  for (let i = 0; i < ws.length; i++) {
    if (!/^git(?:\.exe)?$/i.test(unquoteShellWords(ws[i]).replace(/\\/g, '/').split('/').pop()!)) continue
    let j = i + 1
    while (j < ws.length && ws[j].length > 1 && ws[j].startsWith('-')) j += GIT_OPT_ARG.test(ws[j]) ? 2 : 1
    const sub = ws[j]
    if (sub && /^(?:"?\$|"?`)/.test(sub)) return sub
  }
  return null
}

/** Shell command text. Returns the reason for a block, or null. Text matching only: see SECURITY.md.
 *  Every check runs on the text as written and as bash joins quoted parts of a word (`.g""it`, `'.cl'"aude"`, `gi"t"`:
 *  unsplice and unquoteShellWords). For bash, the body of
 *  one single-quoted heredoc that is plain stdin data (withoutStdinHeredoc) is skipped by the human-only checks only:
 *  .git, the agent settings directories and Stopbar code stay protected in it. */
export function protectedCommand(cmd: string, pr: Protect, shell: 'bash' | 'powershell' = 'bash'): string | null {
  const texts = [...new Set([cmd, unsplice(cmd), unquoteShellWords(cmd)])]
  const needles = hooksPathNeedles(pr)
  for (const t of texts) {
    const c = norm(t).toLowerCase()
    if (DOT_GIT.test(c)) return 'the command names a .git directory (Stopbar state, git hooks, git config live there)'
    for (const [re, d] of AGENT_DIRS) if (re.test(c)) return `the command names a ${d} directory (agent settings there hold the Stopbar hooks)`
    for (const [re, d] of HOOK_MANAGERS) if (re.test(c)) return `the command names ${d} (git hook manager files there call the Stopbar git hooks)`
    if (needles.some((re) => re.test(c))) return `the command names the custom core.hooksPath directory (${pr.hooksPathRaw ?? pr.hooksDir}), which holds the git hooks`
  }
  const p = normPwd(cmd)
  const g = wildcardGuardedDir(shell === 'bash' ? globView(p) : unquoteShellWords(p), guardedNames(pr, false))
  if (g) return `the command has a wildcard that reaches the ${g} directory (${guardReason(g)})`
  const f = findReaches(p, [...guardedNames(pr, true), ...LEFTHOOK_FILES], true)
  if (f) return `find ${JSON.stringify(f.pat)} with -delete, -exec, -execdir, -ok or -okdir reaches ${f.name} (${LEFTHOOK_FILES.includes(f.name) ? 'the git hook manager file calls the Stopbar git hooks' : guardReason(f.name)})`
  const dyn = dynamicGitSubcommand(cmd)
  if (dyn) return `the git subcommand comes from an expansion (${dyn}), which hides it from the commit and push gates; write the subcommand out`
  for (const t of texts) {
    const c = norm(t).toLowerCase()
    if (isGitConfigWrite(t)) return '`git config` writes .git/config; only reads (--get, --list) are allowed'
    if (GIT_ALIAS.test(t) || GIT_ALIAS_ENV.test(t)) return '`git -c alias.<name>=...` defines a one-off git alias, which hides the real git subcommand'
    if (c.includes(lc(pr.stateDir)) || c.includes(lc(pr.gitDir) + '/')) return 'the command names the git directory'
    for (const d of pr.codeDirs) if (c.includes(lc(d))) return `the command names Stopbar code (${d})`
  }
  const admin = (shell === 'bash' ? withoutStdinHeredoc(cmd) : null) ?? cmd
  for (const t of new Set([admin, unsplice(admin), unquoteShellWords(admin)])) if (HUMAN_ONLY.test(t) || STOPBAR_ADMIN.test(t)) return 'human-only Stopbar command or setting'
  return null
}
