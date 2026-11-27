// `stopbar doctor`: environment, configuration, state, hooks, and a dry run of the real hook pipeline on a scratch repo.
import {execFileSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {existsSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
import {isAbsolute, join, relative} from 'node:path'
import {hasChain} from './classify.ts'
import {fresh, HOOK_MATCHERS} from './commands.ts'
import {cliOf, DEFAULT_SAFE_TOOLS, makeConfig} from './config.ts'
import {decode, MACHINE} from './engine.ts'
import {runHook} from './hook.ts'
import {gitHooksDir, portableHookHint} from './integrations.ts'
import {PKG_ROOT} from './pkg.ts'
import {FailClosed, findRepo, git, hasRefTree, type Repo} from './repo.ts'
import {type EventEntry, paths, readConfig, readEvents, readState, VERSION, writeConfig, writeState} from './store.ts'

type Check = {status: 'OK' | 'WARN' | 'FAIL'; name: string; detail: string}
type Ev = EventEntry
const sha = (f: string) => createHash('sha256').update(readFileSync(f)).digest('hex')

type Obj = Record<string, unknown>
const isObj = (x: unknown): x is Obj => !!x && typeof x === 'object' && !Array.isArray(x)

function hooksIn(file: string): Obj | null {
  if (!existsSync(file)) return null
  try { const j: unknown = JSON.parse(readFileSync(file, 'utf8')); return isObj(j) && isObj(j.hooks) ? j.hooks : {} } catch { return {__invalid: []} }
}

function checkHooks(root: string, add: (s: Check['status'], n: string, d: string) => void) {
  const files = ['settings.json', 'settings.local.json'].map((n) => join(root, '.claude', n))
  const merged: Record<string, {matcher?: string; command: string; file: string}[]> = {}
  for (const f of files) {
    const h = hooksIn(f)
    if (!h) continue
    if ('__invalid' in h) { add('FAIL', 'hooks', `${f} is not valid JSON: Claude Code will not load the hooks`); continue }
    for (const [ev, entries] of Object.entries(h)) {
      for (const e of Array.isArray(entries) ? entries : []) {
        if (!isObj(e)) continue
        for (const x of Array.isArray(e.hooks) ? e.hooks : []) {
          if (isObj(x) && typeof x.command === 'string' && /stopbar(\.mjs)?"?\s+hook\b/.test(x.command)) {
            (merged[ev] ??= []).push({matcher: typeof e.matcher === 'string' ? e.matcher : undefined, command: x.command, file: f})
          }
        }
      }
    }
  }
  const covers = (m: string | undefined, tools: string[]) => m === undefined || m === '*' || m === '' || tools.every((t) => new RegExp(`^(?:${m})$`).test(t))
  const need: [string, string[]][] = [['PreToolUse', ['Bash', 'Edit', 'Write', 'Read', 'WebFetch']], ['PostToolUse', HOOK_MATCHERS.post.split('|')],
    ['PostToolUseFailure', ['Bash', 'PowerShell']], ['Stop', []]]
  for (const [ev, tools] of need) {
    const hs = merged[ev] ?? []
    if (!hs.length) { add('FAIL', `hook ${ev}`, `no Stopbar hook in ${files.join(' or ')}`); continue }
    if (!hs.some((h) => covers(h.matcher, tools))) { add('FAIL', `hook ${ev}`, `matcher ${JSON.stringify(hs[0].matcher)} misses some of ${tools.join(', ')}`); continue }
    const script = /node\s+"?([^"]+?stopbar\.mjs)"?\s+hook/.exec(hs[0].command)?.[1]
    if (script && !existsSync(script)) { add('FAIL', `hook ${ev}`, `script not found: ${script}`); continue }
    add('OK', `hook ${ev}`, `${hs[0].command} (${hs[0].file.replace(/\\/g, '/').split('/').slice(-2).join('/')})`)
  }
}

const STOPBAR = /stopbar(\.mjs)?"?\s+(hook|git-hook)\b/
const scriptOf = (cmd: string) => /node\s+"?([^"]+?stopbar\.mjs)"?\s+(?:git-)?hook/.exec(cmd)?.[1]
const INVALID = Symbol('invalid JSON')
/** undefined: no file; INVALID: not JSON; else the parsed value. */
function readJsonOrInvalid(f: string): unknown {
  if (!existsSync(f)) return undefined
  try { return JSON.parse(readFileSync(f, 'utf8')) as unknown } catch { return INVALID }
}
const hooksOf = (j: unknown) => (isObj(j) && isObj(j.hooks) ? j.hooks : undefined)
/** Commands of Stopbar hooks per event, from any nesting of {command} objects under each event. */
function stopbarCommands(events: Record<string, unknown> | undefined): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  const walk = (ev: string, x: unknown) => {
    if (Array.isArray(x)) { for (const y of x) walk(ev, y); return }
    if (!x || typeof x !== 'object') return
    const o = x as Record<string, unknown>
    if (typeof o.command === 'string' && STOPBAR.test(o.command)) (out[ev] ??= []).push(o.command)
    if (o.hooks) walk(ev, o.hooks)
  }
  for (const [ev, v] of Object.entries(events ?? {})) walk(ev, v)
  return out
}

/** Other clients and the git fallback. Returns how many clients have Stopbar hooks, and how many Stopbar git hooks exist. */
function checkOtherClients(repo: Repo, ev: Ev[], add: (s: Check['status'], n: string, d: string) => void): {clients: number; git: number} {
  let found = 0
  const clients: [string, string, (j: unknown) => Obj | undefined, string[]][] = [
    ['cursor', join(repo.root, '.cursor', 'hooks.json'), hooksOf, ['preToolUse', 'postToolUse', 'postToolUseFailure', 'stop']],
    ['codex', join(repo.root, '.codex', 'hooks.json'), hooksOf, ['PreToolUse', 'PostToolUse', 'Stop']],
    ['gemini', join(repo.root, '.gemini', 'settings.json'), hooksOf, ['BeforeTool', 'AfterTool', 'AfterAgent']],
    ['antigravity', join(repo.root, '.agents', 'hooks.json'), (j) => (isObj(j) ? Object.assign({}, ...Object.values(j).filter((v) => isObj(v) && v.enabled !== false)) : undefined), ['PreToolUse', 'PostToolUse', 'Stop']],
  ]
  for (const [name, f, events, need] of clients) {
    const j = readJsonOrInvalid(f)
    if (j === undefined) continue
    if (j === INVALID) { add('FAIL', `hooks ${name}`, `${f} is not valid JSON`); found++; continue }
    const cmds = stopbarCommands(events(j))
    if (!Object.keys(cmds).length) continue
    found++
    const missing = need.filter((e) => !cmds[e]?.length)
    const script = scriptOf(Object.values(cmds)[0][0])
    if (missing.length) add('FAIL', `hooks ${name}`, `${f}: no Stopbar hook for ${missing.join(', ')}`)
    else if (script && !existsSync(script)) add('FAIL', `hooks ${name}`, `script not found: ${script}`)
    else if (name === 'cursor' && JSON.stringify(hooksOf(j) ?? {}).includes('"failClosed":false')) add('WARN', `hooks ${name}`, `${f}: failClosed is false, so a crash of the hook lets the action run`)
    else add('OK', `hooks ${name}`, `${need.join(', ')} (${f.replace(/\\/g, '/').split('/').slice(-2).join('/')})`)
  }
  let hd: {dir: string; customHooksPath: string | null} = {dir: join(repo.gitDir, 'hooks'), customHooksPath: null}
  try { hd = gitHooksDir(repo) } catch { /* default */ }
  const {dir} = hd
  // a Stopbar line that is not a comment: the hook init writes, or `stopbar git-hook <name>` chained by hand (Husky, Lefthook)
  const calls = (n: string) => new RegExp(`^[^#\\n]*stopbar(\\.mjs)?"?\\s+git-hook\\s+${n}\\b`, 'm')
  const NAMES = ['pre-commit', 'pre-push']
  const gh = NAMES.filter((n) => existsSync(join(dir, n)) && calls(n).test(readFileSync(join(dir, n), 'utf8')))
  const lacking = NAMES.filter((n) => !gh.includes(n))
  const verb = (ns: string[]) => `git ${ns.map((n) => (n === 'pre-commit' ? 'commit' : 'push')).join(' and git ')} ${ns.length > 1 ? 'are' : 'is'}`
  // the git hooks close what an agent hook cannot see: git aliases, and on pre-push merge, cherry-pick, am and commit-tree
  if (!lacking.length) { add('OK', 'hooks git', `pre-commit, pre-push in ${dir}`); return {clients: found, git: gh.length} }
  let cli = cliOf({})
  try { cli = cliOf(readConfig(repo)) } catch { /* reported by the config.json check */ }
  const pinned = existsSync(join(repo.stateDir, 'runtime', 'bin', 'stopbar.mjs'))
  const hint = portableHookHint(dir, repo.root, cli, pinned, lacking)
  // a git hook that was there and is gone is a FAIL (an agent or a tool removed the gate); never configured is a WARN
  const gone = lacking.map((n) => ({n, why: hookWasThere(repo, dir, n, ev, calls(n), gh.length === 1)})).filter((x) => x.why)
  if (gone.length) {
    add('FAIL', 'hooks git', `the Stopbar ${gone.map((g) => g.n).join(' and ')} hook ${gone.length > 1 ? 'were' : 'was'} configured and ${gone.length > 1 ? 'are' : 'is'} gone from ${dir} ` +
      `(${gone.map((g) => `${g.n}: ${g.why}`).join('; ')}): ${verb(gone.map((g) => g.n))} NOT gated by Stopbar. A human restores ${hd.customHooksPath !== null ? `the line: ${hint}` : 'it: `stopbar upgrade --hooks git`'}`)
  } else if (hd.customHooksPath !== null) {
    add('WARN', 'hooks git', `no Stopbar ${lacking.join(' and ')} hook in the custom core.hooksPath (${dir}): ${verb(lacking)} NOT gated by Stopbar in this repository. ` +
      `Stopbar does not write shared or tracked hooks; a human chains them in the existing hook manager: ${hint}; ` +
      'or runs `stopbar upgrade --hooks git --force-hooks` to write them there, keeping a .stopbar-backup')
  } else add('WARN', 'hooks git', `no Stopbar ${lacking.join(' and ')} hook in ${dir}: the git hooks close git aliases, and on pre-push merge, cherry-pick, am and commit-tree, which an agent hook does not see; a human runs \`stopbar upgrade --hooks git\``)
  return {clients: found, git: gh.length}
}

/** Why the git hook `n` counts as configured before (so its absence is a FAIL), or null:
 *  - the last `human:init`, or an upgrade after it, wrote it (event field gitHooksWritten, since 1.2.2);
 *  - a `git-hook` run of it is logged since the last init or reset;
 *  - a tracked hook file (custom core.hooksPath inside the tree) calls it in HEAD;
 *  - the other hook is in place and the log does not say that Stopbar left this one out (`partial`).
 *  Reads only: the event log is never written here. */
function hookWasThere(repo: Repo, dir: string, n: string, ev: Ev[], call: RegExp, partial: boolean): string | null {
  let lastInit = -1, lastStart = -1
  ev.forEach((e, i) => { if (e.source === 'human:init') lastInit = i; if (e.source === 'human:init' || e.source === 'human:reset') lastStart = i })
  let wroteBy: string | null = null, skipped = false
  for (const e of ev.slice(Math.max(lastInit, 0))) {
    if ((e.source !== 'human:init' && e.source !== 'human:upgrade') || !Array.isArray(e.gitHooksWritten)) continue
    if ((e.gitHooksWritten as unknown[]).includes(n)) wroteBy = e.source === 'human:upgrade' ? 'upgrade' : 'init'
    else if (e.source === 'human:init') skipped = true
  }
  if (wroteBy) return `written by stopbar ${wroteBy}`
  if (ev.slice(lastStart + 1).some((e) => e.source === 'hook-timing' && e.adapter === 'git' && e.gitHook === n)) return 'it ran since the last init or reset'
  const rel = relative(repo.root, join(dir, n))
  if (rel && !rel.startsWith('..') && !isAbsolute(rel)) {
    try { if (call.test(git(repo.root, ['show', `HEAD:${rel.replace(/\\/g, '/')}`]))) return `HEAD:${rel.replace(/\\/g, '/')} calls it` } catch { /* not tracked */ }
  }
  if (partial && !skipped) return 'only the other hook is in place'
  return null
}

/** On Windows, a gate command `bash ...` with a bare `bash` may start WSL's bash (System32 or WindowsApps) instead of Git
 *  Bash: another file system and PATH, so the gate fails or tests something else. */
export function wslBashWarning(cmds: string[], whereBash: () => string | null, platform: string = process.platform): string | null {
  if (platform !== 'win32' || !cmds.some((c) => /^bash(?:\.exe)?\s/i.test(c.trim()))) return null
  const first = whereBash()
  if (!first || !/\\(?:WindowsApps|System32)\\bash\.exe$/i.test(first)) return null
  return `buildCmd or fullTestCmd starts with a bare \`bash\`, and the first bash on PATH is WSL (${first}): the gate runs in WSL, not in Git Bash. ` +
    'A human runs `stopbar init --force` with the full path to Git Bash in --build / --test (e.g. "C:/Program Files/Git/bin/bash.exe" ...)'
}
function checkWslBash(cmds: string[], add: (s: Check['status'], n: string, d: string) => void) {
  const where = () => {
    try { return execFileSync('where', ['bash'], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true}).split(/\r?\n/)[0].trim() || null } catch { return null }
  }
  const w = wslBashWarning(cmds, where)
  if (w) add('WARN', 'gate shell', w)
}

/** The real hook pipeline (in process) on a scratch repository inside <git-dir>/stopbar/doctor-run. */
function dryRun(base: string, add: (s: Check['status'], n: string, d: string) => void) {
  const dir = join(base, 'doctor-run')
  rmSync(dir, {recursive: true, force: true})
  mkdirSync(join(dir, 'src'), {recursive: true}); mkdirSync(join(dir, 'tests'), {recursive: true})
  const g = (...a: string[]) => execFileSync('git', ['-c', 'user.name=stopbar-doctor', '-c', 'user.email=doctor@stopbar.invalid', '-c', 'commit.gpgsign=false', ...a], {cwd: dir, stdio: 'ignore'})
  try {
    writeFileSync(join(dir, 'src', 'a.mjs'), 'export const a = 1\n')
    writeFileSync(join(dir, 'tests', 'a.test.mjs'), 'export {}\n')
    g('init', '-q'); g('add', '-A'); g('commit', '-q', '-m', 'base')
    const repo: Repo = findRepo(dir)
    const cfg = makeConfig({buildCmd: 'node build.mjs', fullTestCmd: 'node --test'})
    writeConfig(repo, cfg); writeState(repo, fresh(repo, cfg))
    const hook = (ev: string, tool: string, ti: object, extra: object = {}) => runHook(JSON.stringify({hook_event_name: ev, tool_name: tool, tool_input: ti, cwd: dir, ...extra}))
    const steps: [string, () => boolean][] = [
      ['edit code is allowed', () => { const p = hook('PreToolUse', 'Write', {file_path: join(dir, 'src', 'a.mjs')}).code === 0; writeFileSync(join(dir, 'src', 'a.mjs'), 'export const a = 2\n'); return p && hook('PostToolUse', 'Write', {file_path: join(dir, 'src', 'a.mjs')}).code === 0 }],
      ['commit without build and tests is blocked (exit 2)', () => hook('PreToolUse', 'Bash', {command: 'git commit -m "x"'}).code === 2],
      ['passing build and full suite are recorded', () => hook('PostToolUse', 'Bash', {command: 'node build.mjs'}, {tool_response: {stdout: '', stderr: '', interrupted: false}}).code === 0 &&
        hook('PostToolUse', 'Bash', {command: 'node --test'}, {tool_response: {stdout: '', stderr: '', interrupted: false}}).code === 0],
      ["safe heredoc commit git commit -m \"$(cat <<'EOF' ...)\" is allowed", () => hook('PreToolUse', 'Bash', {command: "git commit -m \"$(cat <<'EOF'\nFix a\n\nReviewed-by: Jane Doe <jane@example.invalid>\nEOF\n)\""}).code === 0],
      ['command substitution in a commit is blocked', () => hook('PreToolUse', 'Bash', {command: 'git commit -m "$(rm -rf /)"'}).code === 2],
      ['editing an existing test taints the session', () => { writeFileSync(join(dir, 'tests', 'a.test.mjs'), 'export {} // weakened\n'); return hook('PostToolUse', 'Edit', {file_path: join(dir, 'tests', 'a.test.mjs')}).code === 2 && decode(readState(repo).kernel).testsTainted === true }],
      ['writing .claude/settings.local.json is blocked', () => hook('PreToolUse', 'Write', {file_path: join(dir, '.claude', 'settings.local.json')}).code === 2],
      ['writing .git/hooks/pre-commit is blocked', () => hook('PreToolUse', 'Write', {file_path: join(dir, '.git', 'hooks', 'pre-commit')}).code === 2],
      ['a damaged state.json fails closed (exit 2)', () => { writeFileSync(paths(repo).state, '{"version": 2, "kern'); const r = hook('PreToolUse', 'Read', {file_path: join(dir, 'src', 'a.mjs')}); return r.code === 2 && /FAIL-CLOSED/.test(r.msg ?? '') }],
    ]
    for (const [name, f] of steps) {
      let ok = false
      try { ok = f() } catch { ok = false }
      add(ok ? 'OK' : 'FAIL', 'dry run', name)
    }
  } finally {
    rmSync(dir, {recursive: true, force: true})
  }
}

/** `strict`: a [WARN] fails too (exit 1), for CI. The repository's event log is only read (attest hashes it). */
export async function doctor(o: {repo?: string; json?: boolean; strict?: boolean}): Promise<{code: number; msg: string}> {
  const checks: Check[] = []
  const add = (status: Check['status'], name: string, detail: string) => { checks.push({status, name, detail}) }
  const [maj, min] = process.versions.node.split('.').map(Number)
  add(maj > 22 || (maj === 22 && min >= 18) ? 'OK' : 'FAIL', 'node', `v${process.versions.node} (needs >= 22.18)`)
  try { add('OK', 'git', execFileSync('git', ['--version'], {encoding: 'utf8'}).trim()) } catch { add('FAIL', 'git', 'git not found on PATH') }
  add(MACHINE.name === 'stopbar_kernel_none' ? 'OK' : 'FAIL', 'kernel', `${MACHINE.name}, kernel.ts sha256 ${MACHINE.kernelSha256.slice(0, 16)}, machine sha256 ${MACHINE.machineSha256.slice(0, 16)}`)
  // npm may hoist gdp-wired next to this package (npm install stopbar): resolve it as Node does, never by a fixed path
  let prover = false
  try { import.meta.resolve('gdp-wired/machine'); prover = true } catch { /* not resolvable: a pinned runtime has no node_modules */ }
  if (prover && existsSync(join(PKG_ROOT, 'dist', 'kernel.js'))) {
    try {
      const {checkGenerated} = await import('./verify.ts')
      const g = await checkGenerated(500)
      add(g.ok ? 'OK' : 'FAIL', 'kernel link', `compileJs(kernel.ts) == dist/kernel.gen.js: ${g.sameMachine}; kernel.ts hash: ${g.sameSource}; ${g.differential.steps} steps vs interpreter, ${g.differential.mismatches} mismatches`)
    } catch (e) { add('WARN', 'kernel link', `not checked: ${(e as Error).message}`) }
  } else add('WARN', 'kernel link', 'gdp-wired cannot be resolved from this copy (a pinned runtime has no node_modules): run `stopbar prove` in the package')

  let repo: Repo | null = null
  try { repo = findRepo(o.repo ?? process.cwd()); add('OK', 'repository', `${repo.root} (state in ${repo.stateDir})`) } catch (e) { add('FAIL', 'repository', (e as Error).message) }
  if (repo) {
    let cfgOk = false
    try {
      const cfg = readConfig(repo); cfgOk = true
      add('OK', 'config.json', `profile ${cfg.profile}; build \`${cfg.buildCmd}\`; full tests \`${cfg.fullTestCmd}\`; maxRetries ${cfg.maxRetries}; cap ${cfg.cap}; ` +
        `${cfg.paths.tests.length}/${cfg.paths.testConfig.length}/${cfg.paths.secrets.length} test/config/secret patterns; safeTools ${JSON.stringify(cfg.safeTools ?? DEFAULT_SAFE_TOOLS)}${cfg.baseRef ? `; baseRef ${cfg.baseRef}` : ''}; ` +
        `stopGate ${cfg.stopGate ?? 'block'}; cli ${cliOf(cfg)}${cfg.requireRun ? '; requireRun: true' : ''}; ` +
        (cfg.requireRun ? 'gates: stopbar run only (--require-run)' : 'gates: hook command text (use --require-run for exit-code-only gates)'))
      if (cfg.stopGate === 'warn') add('WARN', 'stopGate', 'warn: Stop does not block a turn with unverified changes (logged as stop:warn); git commit and git push stay blocked until the gates pass')
      const safe = cfg.safeTools ?? DEFAULT_SAFE_TOOLS
      const missing = DEFAULT_SAFE_TOOLS.filter((t) => !safe.includes(t))
      if (missing.length) add('WARN', 'safeTools', `missing default ${missing.join(', ')}: these local tools count as outbound after a secret read; add them to config.safeTools or run \`stopbar init --force ...\``)
      if (cfg.baseRef) add(hasRefTree(repo.root, cfg.baseRef) ? 'OK' : 'FAIL', 'baseRef', hasRefTree(repo.root, cfg.baseRef) ? `${cfg.baseRef} resolves to a tree` : `${cfg.baseRef} does not resolve in git (existing-test checks will fail closed)`)
      for (const [k, v] of [['buildCmd', cfg.buildCmd], ['fullTestCmd', cfg.fullTestCmd]]) if (hasChain(v)) add('FAIL', 'config.json', `${k} has shell operators: it can never pass as a gate`)
      checkWslBash([cfg.buildCmd, cfg.fullTestCmd], add)
      try {
        const s = readState(repo), v = decode(s.kernel)
        add(v.halted ? 'WARN' : 'OK', 'state.json', `revision ${v.treeRev}; ${v.halted ? 'HALTED' : 'running'}; spent ${v.spent}/${v.capNow}; tainted ${v.testsTainted}`)
        if (s.params.maxRetries !== cfg.maxRetries || s.params.cap !== cfg.cap) add('WARN', 'state.json', `state params ${JSON.stringify(s.params)} differ from config; a human runs \`stopbar reset\` to apply the config`)
      } catch (e) { add('FAIL', 'state.json', e instanceof FailClosed ? `${e.message}. Fix: ${e.fix}` : String(e)) }
    } catch (e) { add('FAIL', 'config.json', e instanceof FailClosed ? `${e.message}. Fix: ${e.fix}` : String(e)) }
    const ev = readEvents(repo)
    add(ev.torn.length ? 'WARN' : 'OK', 'events.jsonl', `${ev.events.length} entries${ev.torn.length ? `; ${ev.torn.length} torn line(s) (crash mid-write) at line ${ev.torn.map((t) => t.line).join(', ')}: kept, later entries are intact` : ''}`)
    const rt = join(repo.stateDir, 'runtime', 'dist', 'kernel.gen.js')
    if (existsSync(rt)) {
      const same = existsSync(join(PKG_ROOT, 'dist', 'kernel.gen.js')) && sha(rt) === sha(join(PKG_ROOT, 'dist', 'kernel.gen.js'))
      add(same ? 'OK' : 'WARN', 'pinned runtime', `${join(repo.stateDir, 'runtime')}${same ? ' (same kernel as this package)' : ' differs from this package: a human runs `stopbar upgrade` to re-pin (state and gates are kept)'}`)
    } else if (cfgOk) add('WARN', 'pinned runtime', 'none: hooks run an unpinned copy (init --no-pin)')
    const others = checkOtherClients(repo, ev.events, add)
    const claudeHas = ['settings.json', 'settings.local.json'].some((n) => { const h = hooksIn(join(repo!.root, '.claude', n)); return h !== null && Object.keys(stopbarCommands(h)).length > 0 })
    // Claude Code hooks named at the last init or upgrade must be there, also when other hooks (now the git hooks by
    // default) exist; without any client hooks, the Claude Code ones are reported as missing (v1.0 output)
    const named = ev.events.filter((e) => (e.source === 'human:init' || e.source === 'human:upgrade') && Array.isArray(e.hooks)).at(-1)?.hooks as unknown[] | undefined
    const wantClaude = !!named?.some((t) => t === 'claude' || t === 'claude-project')
    if (claudeHas || (others.clients === 0 && (others.git === 0 || wantClaude))) checkHooks(repo.root, add)
    try { dryRun(repo.stateDir, add) } catch (e) { add('FAIL', 'dry run', String(e)) }
  }
  const fails = checks.filter((c) => c.status === 'FAIL').length, warns = checks.filter((c) => c.status === 'WARN').length
  const strictFail = o.strict === true && warns > 0
  const ok = fails === 0 && !strictFail
  const msg = o.json ? JSON.stringify({version: VERSION, ok, fails, warns, ...(o.strict ? {strict: true} : {}), checks}, null, 1)
    : [`stopbar doctor (Stopbar ${VERSION})${o.strict ? ' --strict' : ''}`, ...checks.map((c) => `[${c.status.padEnd(4)}] ${c.name.padEnd(18)} ${c.detail}`),
      `RESULT: ${fails ? `FAIL (${fails} problem(s), ${warns} warning(s))` : strictFail ? `FAIL (strict: ${warns} warning(s))` : `OK (${warns} warning(s))`}`].join('\n')
  return {code: ok ? 0 : 1, msg}
}
