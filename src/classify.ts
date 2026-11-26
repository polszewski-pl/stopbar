// Deterministic classification rules of the wrapper: file paths and the text of a shell command. No AST.
// Everything here is enforced by the wrapper, not by the proof (see SECURITY.md).
import type {Config, Paths} from './config.ts'
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
// git global options before the subcommand: -c k=v, -C dir, --git-dir=..., --work-tree ..., --no-pager, -p (values may be quoted)
const GIT_GLOBALS = String.raw`(?:\s+(?:-[cC]\s*(?:"[^"]*"|'[^']*'|\S+)|--(?:git-dir|work-tree|namespace|exec-path|config-env)(?:=|\s+)(?:"[^"]*"|'[^']*'|\S+)|--[\w-]+|-[A-Za-z]))*`
const gitSub = (sub: string, flags = 'i') => new RegExp(String.raw`\bgit(?:\.exe)?${GIT_GLOBALS}\s+(?:${sub})\b`, flags)
const COMMIT_RE = gitSub('commit|push'), PUSH_RE = gitSub('push'), CONFIG_RE = gitSub('config')
const COMMIT_ONLY_RE = new RegExp(String.raw`^git(?:\.exe)?${GIT_GLOBALS}\s+commit\b`, 'i')
const CONFIG_READ = /\s(--get|--get-all|--get-regexp|--list|-l|--show-origin|--show-scope|get|list)(\s|=|$)/i

/** Text a commit/push decision is made on: for a safe heredoc commit only the prefix (the message is data). */
const commandPart = (cmd: string) => parseSafeHeredocCommit(cmd)?.prefix ?? cmd
export const isCommitCmd = (cmd: string) => COMMIT_RE.test(commandPart(cmd))
export const isPushCmd = (cmd: string) => PUSH_RE.test(commandPart(cmd))
export const isGitConfigWrite = (cmd: string) => CONFIG_RE.test(cmd) && !CONFIG_READ.test(cmd)

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

/** The first secret path named in a command (e.g. `cat .env`, `type secrets\\db.txt`), with the pattern it matched. */
export function secretInCommand(cmd: string, paths: Paths, exists: (p: string) => boolean = () => true): SecretHit | null {
  const words = (s: string) => s.split(/[\s'"=(),;|&<>@:]+/).filter(Boolean)
  // the words as written, then as bash joins them (`.e""nv` is `.env`)
  for (const tok of new Set([...words(cmd), ...words(unsplice(cmd))])) {
    const hits = paths.secrets.filter((g) => matchesSecretGlob(tok, g))
    if (!hits.length) continue
    const strong = hits.find((g) => !EXT_ONLY.test(g))
    if (strong) return {token: tok, pattern: strong}
    if (/[\\/]/.test(tok) || exists(tok)) return {token: tok, pattern: hits[0]}
  }
  return null
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
  if (COMMIT_RE.test(scan.heredoc ? commandPart(c) : c)) {
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
  return {kind: 'shell', risky: isRiskyShell(c), partialTests: looksLikeTests(c), secret: secretInCommand(c, cfg.paths, exists)}
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
export type Protect = {gitDir: string; stateDir: string; codeDirs: string[]}

const lc = (p: string) => norm(p).toLowerCase().replace(/\/+$/, '')
const under = (a: string, dir: string) => a === dir || a.startsWith(dir + '/')

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
  for (const d of pr.codeDirs) if (under(a, lc(d))) return `Stopbar code (${d})`
  return null
}

const SEG = (name: string) => new RegExp(String.raw`(^|[^a-z0-9_.\-])${name.replace(/\./g, '\\.')}([^a-z0-9_\-]|$)`, 'i')
const DOT_GIT = SEG('.git')
const AGENT_DIRS: [RegExp, string][] = [[SEG('.claude'), '.claude'], [SEG('.cursor'), '.cursor'], [SEG('.codex'), '.codex'], [SEG('.gemini'), '.gemini'], [SEG('.agents'), '.agents']]
const HUMAN_ONLY = /\b(approve-tests|approve-shell)\b|\bSTOPBAR_[A-Z_]+/i
const STOPBAR_ADMIN = /stopbar[^\n]*\b(init|resume|reset|upgrade|doctor\s+--fix)\b/i

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

/** Shell command text. Returns the reason for a block, or null. Text matching only: see SECURITY.md.
 *  Every check runs on the text as written and as bash joins quoted parts of a word (`.g""it`). For bash, the body of
 *  one single-quoted heredoc that is plain stdin data (withoutStdinHeredoc) is skipped by the human-only checks only:
 *  .git, the agent settings directories and Stopbar code stay protected in it. */
export function protectedCommand(cmd: string, pr: Protect, shell: 'bash' | 'powershell' = 'bash'): string | null {
  const texts = [...new Set([cmd, unsplice(cmd)])]
  for (const t of texts) {
    const c = norm(t).toLowerCase()
    if (DOT_GIT.test(c)) return 'the command names a .git directory (Stopbar state, git hooks, git config live there)'
    for (const [re, d] of AGENT_DIRS) if (re.test(c)) return `the command names a ${d} directory (agent settings there hold the Stopbar hooks)`
  }
  for (const t of texts) {
    const c = norm(t).toLowerCase()
    if (isGitConfigWrite(t)) return '`git config` writes .git/config; only reads (--get, --list) are allowed'
    if (GIT_ALIAS.test(t) || GIT_ALIAS_ENV.test(t)) return '`git -c alias.<name>=...` defines a one-off git alias, which hides the real git subcommand'
    if (c.includes(lc(pr.stateDir)) || c.includes(lc(pr.gitDir) + '/')) return 'the command names the git directory'
    for (const d of pr.codeDirs) if (c.includes(lc(d))) return `the command names Stopbar code (${d})`
  }
  const admin = (shell === 'bash' ? withoutStdinHeredoc(cmd) : null) ?? cmd
  for (const t of new Set([admin, unsplice(admin)])) if (HUMAN_ONLY.test(t) || STOPBAR_ADMIN.test(t)) return 'human-only Stopbar command or setting'
  return null
}
