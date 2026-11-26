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

function gitHooks(repo: Repo, runtimeRoot: string, force: boolean): string[] {
  const rel = git(repo.root, ['rev-parse', '--git-path', 'hooks'])
  const dir = isAbsolute(rel) ? rel : resolve(repo.root, rel)
  mkdirSync(dir, {recursive: true})
  const bin = join(runtimeRoot, 'bin', 'stopbar.mjs').replace(/\\/g, '/')
  const out: string[] = []
  for (const name of ['pre-commit', 'pre-push']) {
    const f = join(dir, name)
    const body = `#!/bin/sh\n# Stopbar fallback gate, written by \`stopbar init --hooks git\`.\nexec node "${bin}" git-hook ${name}\n`
    if (existsSync(f) && !readFileSync(f, 'utf8').includes('stopbar.mjs" git-hook')) {
      if (!force) throw new FailClosed(`${f} exists and is not a Stopbar hook; not overwriting it`, 'remove it, chain it by hand, or run init again with --force-hooks (the old hook is kept as <name>.stopbar-backup)')
      renameSync(f, `${f}.stopbar-backup`)
    }
    writeFileSync(f, body)
    chmodSync(f, 0o755)
    out.push(f)
  }
  return out
}

/** Installs every target; returns one line per written file. */
export function installHooks(repo: Repo, targets: Target[], runtimeRoot: string, force: boolean): string[] {
  const lines: string[] = []
  for (const t of targets) {
    if (t === 'claude') lines.push(`claude: ${claudeFile(repo.root, 'settings.local.json', hookCommand(runtimeRoot))}`)
    else if (t === 'claude-project') lines.push(`claude: ${claudeFile(repo.root, 'settings.json', hookCommand(runtimeRoot))}`)
    else if (t === 'cursor') lines.push(`cursor: ${cursorFile(repo.root, hookCommand(runtimeRoot, 'cursor'))}`)
    else if (t === 'codex') lines.push(`codex: ${codexFile(repo.root, hookCommand(runtimeRoot, 'codex'))}`)
    else if (t === 'gemini') lines.push(`gemini: ${geminiFile(repo.root, hookCommand(runtimeRoot, 'gemini'))}`)
    else if (t === 'antigravity') lines.push(`antigravity: ${antigravityFile(repo.root, hookCommand(runtimeRoot, 'antigravity'))}`)
    else if (t === 'git') for (const f of gitHooks(repo, runtimeRoot, force)) lines.push(`git: ${f}`)
  }
  return lines
}
