// `stopbar init --hooks <targets>`: writes the hook configuration of each client, merging into existing files (other keys
// and other hooks stay; earlier Stopbar entries are replaced). Targets: claude (alias local), claude-project (alias
// project), cursor, codex, gemini, antigravity (alias agy), git; several at once, comma separated.
import {chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync} from 'node:fs'
import {dirname, isAbsolute, join, resolve} from 'node:path'
import {FailClosed, git, type Repo} from './repo.ts'

export const TARGETS = ['claude', 'claude-project', 'cursor', 'codex', 'gemini', 'antigravity', 'git'] as const
export type Target = (typeof TARGETS)[number]
const ALIAS: Record<string, Target> = {local: 'claude', project: 'claude-project', agy: 'antigravity'}

export function parseTargets(s: string): Target[] {
  const out: Target[] = []
  for (const raw of s.split(',').map((x) => x.trim()).filter(Boolean)) {
    const t = (ALIAS[raw] ?? raw) as Target
    if (!TARGETS.includes(t)) throw new FailClosed(`unknown --hooks target ${JSON.stringify(raw)}; known: ${TARGETS.join(', ')} (aliases: local, project, agy)`)
    if (!out.includes(t)) out.push(t)
  }
  if (!out.length) throw new FailClosed('--hooks needs at least one target')
  return out
}

export const STOPBAR_HOOK = /stopbar(\.mjs)?\\?"?\s+(hook|git-hook)\b/
export const hookCommand = (runtimeRoot: string, adapter?: string) =>
  `node "${join(runtimeRoot, 'bin', 'stopbar.mjs').replace(/\\/g, '/')}" hook${adapter ? ` --adapter ${adapter}` : ''}`

export const CLAUDE_POST_MATCHER = 'Edit|Write|MultiEdit|NotebookEdit|Bash|PowerShell'
export function claudeHooks(command: string) {
  const h = (timeout: number) => [{type: 'command', command, timeout}]
  return {
    PreToolUse: [{matcher: '*', hooks: h(30)}],
    PostToolUse: [{matcher: CLAUDE_POST_MATCHER, hooks: h(60)}],
    PostToolUseFailure: [{matcher: CLAUDE_POST_MATCHER, hooks: h(60)}],
    Stop: [{hooks: h(30)}],
  }
}

function readJson(f: string): any {
  if (!existsSync(f)) return {}
  const raw = readFileSync(f, 'utf8')
  try { return raw.trim() ? JSON.parse(raw) : {} } catch (e) {
    throw new FailClosed(`${f} is not valid JSON (${(e as Error).message}); not overwriting it`, 'fix the file by hand, then run init again')
  }
}
function writeJson(f: string, o: unknown) { mkdirSync(dirname(f), {recursive: true}); writeFileSync(f, JSON.stringify(o, null, 2) + '\n') }
const mentions = (x: unknown) => STOPBAR_HOOK.test(JSON.stringify(x ?? ''))
/** Event arrays: drop earlier Stopbar entries, append ours. */
function mergeEvents(hooks: Record<string, any>, want: Record<string, any[]>) {
  for (const [ev, entries] of Object.entries(want)) {
    const kept = Array.isArray(hooks[ev]) ? hooks[ev].filter((x: unknown) => !mentions(x)) : []
    hooks[ev] = [...kept, ...entries]
  }
}

function claudeFile(root: string, file: string, command: string) {
  const f = join(root, '.claude', file)
  const cur = readJson(f)
  cur.hooks = cur.hooks && typeof cur.hooks === 'object' ? cur.hooks : {}
  mergeEvents(cur.hooks, claudeHooks(command))
  writeJson(f, cur)
  return f
}

function cursorFile(root: string, command: string) {
  const f = join(root, '.cursor', 'hooks.json')
  const cur = readJson(f)
  cur.version = cur.version ?? 1
  cur.hooks = cur.hooks && typeof cur.hooks === 'object' ? cur.hooks : {}
  const e = (timeout: number) => [{command, timeout, failClosed: true}]
  mergeEvents(cur.hooks, {preToolUse: e(30), postToolUse: e(60), postToolUseFailure: e(60), stop: e(30)})
  writeJson(f, cur)
  return f
}

function codexFile(root: string, command: string) {
  const f = join(root, '.codex', 'hooks.json')
  const cur = readJson(f)
  cur.hooks = cur.hooks && typeof cur.hooks === 'object' ? cur.hooks : {}
  const h = (timeout: number) => [{hooks: [{type: 'command', command, timeout}]}]
  mergeEvents(cur.hooks, {PreToolUse: h(30), PostToolUse: h(60), Stop: h(30)})
  writeJson(f, cur)
  return f
}

function geminiFile(root: string, command: string) {
  const f = join(root, '.gemini', 'settings.json')
  const cur = readJson(f)
  cur.hooks = cur.hooks && typeof cur.hooks === 'object' ? cur.hooks : {}
  const h = (timeout: number) => [{matcher: '*', hooks: [{name: 'stopbar', type: 'command', command, timeout}]}]
  mergeEvents(cur.hooks, {BeforeTool: h(30000), AfterTool: h(60000), AfterAgent: h(30000)})
  writeJson(f, cur)
  return f
}

function antigravityFile(root: string, command: string) {
  const f = join(root, '.agents', 'hooks.json')
  const cur = readJson(f)
  cur.stopbar = {
    PreToolUse: [{matcher: '*', hooks: [{type: 'command', command, timeout: 30}]}],
    PostToolUse: [{matcher: '*', hooks: [{type: 'command', command, timeout: 60}]}],
    Stop: [{type: 'command', command, timeout: 30}],
  }
  writeJson(f, cur)
  return f
}

/** Where git runs the hooks of this repository (`git rev-parse --git-path hooks`). `customHooksPath`: the
 *  `core.hooksPath` value when it points outside the default <git-common-dir>/hooks (Husky, Lefthook, a shared or tracked
 *  hooks directory), else null. No core.hooksPath entry is no error; any other git config error fails closed. */
export function gitHooksDir(repo: Repo): {dir: string; customHooksPath: string | null} {
  let configured: string | null = null
  try { configured = git(repo.root, ['config', '--get', 'core.hooksPath']) || null } catch (e) {
    if ((e as {status?: number}).status !== 1) throw new FailClosed(`git config --get core.hooksPath failed in ${repo.root}: ${(e as Error).message.split('\n')[0]}`)
  }
  const rel = git(repo.root, ['rev-parse', '--git-path', 'hooks'])
  const dir = isAbsolute(rel) ? rel : resolve(repo.root, rel)
  if (configured === null) return {dir, customHooksPath: null}
  const common = git(repo.root, ['rev-parse', '--git-common-dir'])
  const def = resolve(isAbsolute(common) ? common : resolve(repo.root, common), 'hooks')
  const same = process.platform === 'win32' ? resolve(dir).toLowerCase() === def.toLowerCase() : resolve(dir) === def
  return {dir, customHooksPath: same ? null : configured}
}
type HooksDir = ReturnType<typeof gitHooksDir>

const hookBin = (runtimeRoot: string) => join(runtimeRoot, 'bin', 'stopbar.mjs').replace(/\\/g, '/')
const manualHooks = (hd: HooksDir, bin: string) =>
  `add \`node "${bin}" git-hook pre-commit\` to ${join(hd.dir, 'pre-commit')} and \`node "${bin}" git-hook pre-push\` to ${join(hd.dir, 'pre-push')}`
function customHooksRefusal(hd: HooksDir, runtimeRoot: string) {
  return new FailClosed(`core.hooksPath (${hd.customHooksPath}) points git hooks outside .git/hooks, to ${hd.dir}; not writing shared or tracked hooks there`,
    `chain them by hand: ${manualHooks(hd, hookBin(runtimeRoot))}; or run again with --force-hooks to write them there (a foreign hook is kept as <name>.stopbar-backup)`)
}

/** A foreign pre-commit or pre-push hook: 'fail' (git named in --hooks), 'backup' (--force-hooks: kept as
 *  <name>.stopbar-backup, then replaced) or 'keep' (git added by default: the foreign hook stays, with a warning).
 *  A custom core.hooksPath (shared or tracked hooks) is written only with 'backup'; 'keep' writes nothing there and
 *  warns, 'fail' refuses. */
type Foreign = 'fail' | 'backup' | 'keep'
function gitHooks(repo: Repo, runtimeRoot: string, foreign: Foreign, warn: (s: string) => void, hd: HooksDir = gitHooksDir(repo)): string[] {
  const {dir} = hd
  const bin = hookBin(runtimeRoot)
  if (hd.customHooksPath !== null && foreign !== 'backup') {
    if (foreign === 'fail') throw customHooksRefusal(hd, runtimeRoot)
    warn(`WARN: this repository uses a custom core.hooksPath (${hd.customHooksPath} -> ${dir}); Stopbar did not touch those shared or tracked hooks, so git commit and git push are not gated by Stopbar here. To chain them by hand, ${manualHooks(hd, bin)}; to write them there directly (a foreign hook is kept as <name>.stopbar-backup): stopbar upgrade --hooks git --force-hooks`)
    return []
  }
  mkdirSync(dir, {recursive: true})
  const out: string[] = []
  for (const name of ['pre-commit', 'pre-push']) {
    const f = join(dir, name)
    const body = `#!/bin/sh\n# Stopbar fallback gate, written by \`stopbar init --hooks git\`.\nexec node "${bin}" git-hook ${name}\n`
    if (existsSync(f) && !readFileSync(f, 'utf8').includes('stopbar.mjs" git-hook')) {
      if (foreign === 'keep') {
        warn(`WARN: ${f} exists and is not a Stopbar hook; kept it, so git ${name === 'pre-commit' ? 'commit' : 'push'} is not gated by Stopbar here. To replace it (the old hook is kept as ${name}.stopbar-backup): stopbar upgrade --hooks git --force-hooks`)
        continue
      }
      if (foreign === 'fail') throw new FailClosed(`${f} exists and is not a Stopbar hook; not overwriting it`, 'remove it, chain it by hand, or run init again with --force-hooks (the old hook is kept as <name>.stopbar-backup)')
      renameSync(f, `${f}.stopbar-backup`)
    }
    writeFileSync(f, body)
    chmodSync(f, 0o755)
    out.push(f)
  }
  return out
}

/** Installs every target; returns one line per written file. `gitByDefault`: git was not named in --hooks but added by
 *  init, so a foreign git hook is kept with a warning (`warn`) instead of failing; --force-hooks still replaces it. */
export function installHooks(repo: Repo, targets: Target[], runtimeRoot: string, force: boolean, o: {gitByDefault?: boolean; warn?: (s: string) => void} = {}): string[] {
  const lines: string[] = []
  const foreign: Foreign = force ? 'backup' : o.gitByDefault ? 'keep' : 'fail'
  const hd = targets.includes('git') ? gitHooksDir(repo) : null
  // a refusal (explicit --hooks git into a custom core.hooksPath) comes before any client file is written
  if (hd && foreign === 'fail' && hd.customHooksPath !== null) throw customHooksRefusal(hd, runtimeRoot)
  for (const t of targets) {
    if (t === 'claude') lines.push(`claude: ${claudeFile(repo.root, 'settings.local.json', hookCommand(runtimeRoot))}`)
    else if (t === 'claude-project') lines.push(`claude: ${claudeFile(repo.root, 'settings.json', hookCommand(runtimeRoot))}`)
    else if (t === 'cursor') lines.push(`cursor: ${cursorFile(repo.root, hookCommand(runtimeRoot, 'cursor'))}`)
    else if (t === 'codex') lines.push(`codex: ${codexFile(repo.root, hookCommand(runtimeRoot, 'codex'))}`)
    else if (t === 'gemini') lines.push(`gemini: ${geminiFile(repo.root, hookCommand(runtimeRoot, 'gemini'))}`)
    else if (t === 'antigravity') lines.push(`antigravity: ${antigravityFile(repo.root, hookCommand(runtimeRoot, 'antigravity'))}`)
    else if (t === 'git') for (const f of gitHooks(repo, runtimeRoot, foreign, o.warn ?? (() => {}), hd ?? undefined)) lines.push(`git: ${f}`)
  }
  return lines
}
