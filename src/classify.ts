// Deterministic classification rules of the wrapper: file paths and the text of a shell command. No AST.
// Everything here is enforced by the wrapper, not by the proof (see SECURITY.md).
import type {Config, Paths} from './config.ts'
import {matchAny, matchAnySuffix} from './glob.ts'

const norm = (p: string) => p.replace(/\\/g, '/')

export const isTestPath = (p: string, paths: Paths) => matchAny(norm(p), paths.tests)
export const isTestConfigPath = (p: string, paths: Paths) => matchAny(norm(p), paths.testConfig)
/** Secret by file name. Absolute paths match too (a pattern may match any suffix of the path). */
export const isSecretPath = (p: string, paths: Paths) => matchAnySuffix(norm(p), paths.secrets)

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

/** Secret paths named in a command (e.g. `cat .env`, `type secrets\\db.txt`). */
export function mentionsSecret(cmd: string, paths: Paths): boolean {
  return cmd.split(/[\s'"=(),;|&<>@:]+/).filter(Boolean).some((tok) => isSecretPath(tok, paths))
}

export type BashKind =
  | {kind: 'build'} | {kind: 'fulltest'}
  | {kind: 'commit'; heredoc: boolean; push: boolean} | {kind: 'commit-chained'; reason: string}
  | {kind: 'gate-chained'; gate: string; reason: string}
  | {kind: 'shell'; risky: boolean; partialTests: boolean; secret: boolean}

/** Exact match of gate commands: no chain operators, no extra arguments. `shell` is 'bash' or 'powershell'. */
export function classifyBash(cmd: string, cfg: Pick<Config, 'buildCmd' | 'fullTestCmd' | 'paths'>, shell: 'bash' | 'powershell' = 'bash'): BashKind {
  const c = cmd.trim()
  const scan = shell === 'bash' ? scanShell(c) : scanPlain(c)
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
  return {kind: 'shell', risky: isRiskyShell(c), partialTests: looksLikeTests(c), secret: mentionsSecret(c, cfg.paths)}
}

/** Kind of a tree change from a list of (status, path) and a test for "the path exists in HEAD". */
export function classifyTreeChange(changes: {status: string; path: string}[], inHead: (p: string) => boolean, paths: Paths) {
  let anyTest = false, suspicious = false
  const why: string[] = []
  for (const {status, path} of changes) {
    if (isTestConfigPath(path, paths)) { anyTest = true; suspicious = true; why.push(`config ${status} ${path}`); continue }
    if (isTestPath(path, paths)) {
      anyTest = true
      if (inHead(path)) { suspicious = true; why.push(`existing test ${status} ${path}`) } else why.push(`new test ${status} ${path}`)
    }
  }
  return {op: anyTest ? 'EDIT_TEST' as const : 'EDIT_CODE' as const, suspicious, why}
}

// ---------------------------------------------------------------- self-protection
// Unconditional BLOCK in PreToolUse, outside the kernel. Paths are compared normalised: '/' separators, lower case.
export type Protect = {gitDir: string; stateDir: string; codeDirs: string[]}

const lc = (p: string) => norm(p).toLowerCase().replace(/\/+$/, '')
const under = (a: string, dir: string) => a === dir || a.startsWith(dir + '/')

/** File path written by an Edit/Write tool. Returns the reason for a block, or null. */
export function protectedPath(abs: string, root: string, pr: Protect): string | null {
  const a = lc(abs), r = lc(root)
  // inside the repository the .git test runs on the relative path; outside it on the whole path (other repositories)
  const tail = under(a, r) ? a.slice(r.length) : a
  if (/(^|\/)\.git(\/|$)/.test(tail) || under(a, lc(pr.gitDir)) || under(a, lc(pr.stateDir))) return 'git metadata (.git/**, Stopbar state, git hooks, git config)'
  if (/(^|\/)\.claude\/[^/]*settings[^/]*\.json$/.test(a)) return 'Claude Code settings (.claude/settings*.json) hold the Stopbar hooks'
  for (const d of pr.codeDirs) if (under(a, lc(d))) return `Stopbar code (${d})`
  return null
}

const SEG = (name: string) => new RegExp(String.raw`(^|[^a-z0-9_.\-])${name.replace(/\./g, '\\.')}([^a-z0-9_\-]|$)`, 'i')
const DOT_GIT = SEG('.git'), DOT_CLAUDE = SEG('.claude')
const HUMAN_ONLY = /\b(approve-tests|approve-shell)\b|\bSTOPBAR_[A-Z_]+/i
const STOPBAR_ADMIN = /stopbar[^\n]*\b(init|resume|reset|doctor\s+--fix)\b/i

/** Shell command text. Returns the reason for a block, or null. Text matching only: see SECURITY.md. */
export function protectedCommand(cmd: string, pr: Protect): string | null {
  const c = norm(cmd).toLowerCase()
  if (DOT_GIT.test(c)) return 'the command names a .git directory (Stopbar state, git hooks, git config live there)'
  if (DOT_CLAUDE.test(c)) return 'the command names a .claude directory (Claude Code settings hold the Stopbar hooks)'
  if (isGitConfigWrite(cmd)) return '`git config` writes .git/config; only reads (--get, --list) are allowed'
  if (c.includes(lc(pr.stateDir)) || c.includes(lc(pr.gitDir) + '/')) return 'the command names the git directory'
  for (const d of pr.codeDirs) if (c.includes(lc(d))) return `the command names Stopbar code (${d})`
  if (HUMAN_ONLY.test(cmd) || STOPBAR_ADMIN.test(cmd)) return 'human-only Stopbar command or setting'
  return null
}
