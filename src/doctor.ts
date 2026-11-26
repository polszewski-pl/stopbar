// `stopbar doctor`: environment, configuration, state, hooks, and a dry run of the real hook pipeline on a scratch repo.
import {execFileSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {existsSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
import {isAbsolute, join} from 'node:path'
import {hasChain} from './classify.ts'
import {fresh, HOOK_MATCHERS} from './commands.ts'
import {cliOf, DEFAULT_SAFE_TOOLS, makeConfig} from './config.ts'
import {decode, MACHINE} from './engine.ts'
import {runHook} from './hook.ts'
import {PKG_ROOT} from './pkg.ts'
import {FailClosed, findRepo, hasRefTree, type Repo} from './repo.ts'
import {paths, readConfig, readEvents, readState, VERSION, writeConfig, writeState} from './store.ts'

type Check = {status: 'OK' | 'WARN' | 'FAIL'; name: string; detail: string}
const sha = (f: string) => createHash('sha256').update(readFileSync(f)).digest('hex')

function hooksIn(file: string): Record<string, any[]> | null {
  if (!existsSync(file)) return null
  try { return JSON.parse(readFileSync(file, 'utf8')).hooks ?? {} } catch { return {__invalid: []} }
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
        for (const x of Array.isArray(e?.hooks) ? e.hooks : []) {
          if (typeof x?.command === 'string' && /stopbar(\.mjs)?"?\s+hook\b/.test(x.command)) (merged[ev] ??= []).push({matcher: e.matcher, command: x.command, file: f})
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
function readJsonOrInvalid(f: string): any | null | 'invalid' {
  if (!existsSync(f)) return null
  try { return JSON.parse(readFileSync(f, 'utf8')) } catch { return 'invalid' }
}
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

/** Other clients and the git fallback. Returns how many have Stopbar hooks. */
function checkOtherClients(repo: Repo, add: (s: Check['status'], n: string, d: string) => void): number {
  let found = 0
  const clients: [string, string, (j: any) => Record<string, unknown> | undefined, string[]][] = [
    ['cursor', join(repo.root, '.cursor', 'hooks.json'), (j) => j.hooks, ['preToolUse', 'postToolUse', 'postToolUseFailure', 'stop']],
    ['codex', join(repo.root, '.codex', 'hooks.json'), (j) => j.hooks, ['PreToolUse', 'PostToolUse', 'Stop']],
    ['gemini', join(repo.root, '.gemini', 'settings.json'), (j) => j.hooks, ['BeforeTool', 'AfterTool', 'AfterAgent']],
    ['antigravity', join(repo.root, '.agents', 'hooks.json'), (j) => Object.assign({}, ...Object.values(j).filter((v) => v && typeof v === 'object' && (v as any).enabled !== false)), ['PreToolUse', 'PostToolUse', 'Stop']],
  ]
  for (const [name, f, events, need] of clients) {
    const j = readJsonOrInvalid(f)
    if (j === null) continue
    if (j === 'invalid') { add('FAIL', `hooks ${name}`, `${f} is not valid JSON`); found++; continue }
    const cmds = stopbarCommands(events(j))
    if (!Object.keys(cmds).length) continue
    found++
    const missing = need.filter((e) => !cmds[e]?.length)
    const script = scriptOf(Object.values(cmds)[0][0])
    if (missing.length) add('FAIL', `hooks ${name}`, `${f}: no Stopbar hook for ${missing.join(', ')}`)
    else if (script && !existsSync(script)) add('FAIL', `hooks ${name}`, `script not found: ${script}`)
    else if (name === 'cursor' && JSON.stringify(j.hooks).includes('"failClosed":false')) add('WARN', `hooks ${name}`, `${f}: failClosed is false, so a crash of the hook lets the action run`)
    else add('OK', `hooks ${name}`, `${need.join(', ')} (${f.replace(/\\/g, '/').split('/').slice(-2).join('/')})`)
  }
  let dir = join(repo.gitDir, 'hooks')
  try { const rel = execFileSync('git', ['rev-parse', '--git-path', 'hooks'], {cwd: repo.root, encoding: 'utf8'}).trim(); dir = isAbsolute(rel) ? rel : join(repo.root, rel) } catch { /* default */ }
  const gh = ['pre-commit', 'pre-push'].filter((n) => existsSync(join(dir, n)) && readFileSync(join(dir, n), 'utf8').includes('stopbar.mjs" git-hook'))
  if (gh.length) { found++; add(gh.length === 2 ? 'OK' : 'WARN', 'hooks git', `${gh.join(', ')} in ${dir}${gh.length === 2 ? '' : ' (one of pre-commit, pre-push is missing)'}`) }
  return found
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

export async function doctor(o: {repo?: string; json?: boolean}): Promise<{code: number; msg: string}> {
  const checks: Check[] = []
  const add = (status: Check['status'], name: string, detail: string) => { checks.push({status, name, detail}) }
  const [maj, min] = process.versions.node.split('.').map(Number)
  add(maj > 22 || (maj === 22 && min >= 18) ? 'OK' : 'FAIL', 'node', `v${process.versions.node} (needs >= 22.18)`)
  try { add('OK', 'git', execFileSync('git', ['--version'], {encoding: 'utf8'}).trim()) } catch { add('FAIL', 'git', 'git not found on PATH') }
  add(MACHINE.name === 'stopbar_kernel_none' ? 'OK' : 'FAIL', 'kernel', `${MACHINE.name}, kernel.ts sha256 ${MACHINE.kernelSha256.slice(0, 16)}, machine sha256 ${MACHINE.machineSha256.slice(0, 16)}`)
  if (existsSync(join(PKG_ROOT, 'node_modules', 'gdp-wired')) && existsSync(join(PKG_ROOT, 'dist', 'kernel.js'))) {
    try {
      const {checkGenerated} = await import('./verify.ts')
      const g = await checkGenerated(500)
      add(g.ok ? 'OK' : 'FAIL', 'kernel link', `compileJs(kernel.ts) == dist/kernel.gen.js: ${g.sameMachine}; kernel.ts hash: ${g.sameSource}; ${(g.differential as any).steps} steps vs interpreter, ${(g.differential as any).mismatches} mismatches`)
    } catch (e) { add('WARN', 'kernel link', `not checked: ${(e as Error).message}`) }
  } else add('WARN', 'kernel link', 'gdp-wired not installed next to this copy (pinned runtime): run `stopbar prove` in the package')

  let repo: Repo | null = null
  try { repo = findRepo(o.repo ?? process.cwd()); add('OK', 'repository', `${repo.root} (state in ${repo.stateDir})`) } catch (e) { add('FAIL', 'repository', (e as Error).message) }
  if (repo) {
    let cfgOk = false
    try {
      const cfg = readConfig(repo); cfgOk = true
      add('OK', 'config.json', `profile ${cfg.profile}; build \`${cfg.buildCmd}\`; full tests \`${cfg.fullTestCmd}\`; maxRetries ${cfg.maxRetries}; cap ${cfg.cap}; ` +
        `${cfg.paths.tests.length}/${cfg.paths.testConfig.length}/${cfg.paths.secrets.length} test/config/secret patterns; safeTools ${JSON.stringify(cfg.safeTools ?? DEFAULT_SAFE_TOOLS)}${cfg.baseRef ? `; baseRef ${cfg.baseRef}` : ''}; ` +
        `stopGate ${cfg.stopGate ?? 'block'}; cli ${cliOf(cfg)}`)
      if (cfg.stopGate === 'warn') add('WARN', 'stopGate', 'warn: Stop does not block a turn with unverified changes (logged as stop:warn); git commit and git push stay blocked until the gates pass')
      const safe = cfg.safeTools ?? DEFAULT_SAFE_TOOLS
      const missing = DEFAULT_SAFE_TOOLS.filter((t) => !safe.includes(t))
      if (missing.length) add('WARN', 'safeTools', `missing default ${missing.join(', ')}: these local tools count as outbound after a secret read; add them to config.safeTools or run \`stopbar init --force ...\``)
      if (cfg.baseRef) add(hasRefTree(repo.root, cfg.baseRef) ? 'OK' : 'FAIL', 'baseRef', hasRefTree(repo.root, cfg.baseRef) ? `${cfg.baseRef} resolves to a tree` : `${cfg.baseRef} does not resolve in git (existing-test checks will fail closed)`)
      for (const [k, v] of [['buildCmd', cfg.buildCmd], ['fullTestCmd', cfg.fullTestCmd]]) if (hasChain(v)) add('FAIL', 'config.json', `${k} has shell operators: it can never pass as a gate`)
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
    const others = checkOtherClients(repo, add)
    const claudeHas = ['settings.json', 'settings.local.json'].some((n) => { const h = hooksIn(join(repo!.root, '.claude', n)); return h !== null && Object.keys(stopbarCommands(h)).length > 0 })
    if (claudeHas || others === 0) checkHooks(repo.root, add) // without any client hooks, report the Claude Code ones as missing (v1.0 output)
    try { dryRun(repo.stateDir, add) } catch (e) { add('FAIL', 'dry run', String(e)) }
  }
  const fails = checks.filter((c) => c.status === 'FAIL').length, warns = checks.filter((c) => c.status === 'WARN').length
  const msg = o.json ? JSON.stringify({version: VERSION, ok: fails === 0, fails, warns, checks}, null, 1)
    : [`stopbar doctor (Stopbar ${VERSION})`, ...checks.map((c) => `[${c.status.padEnd(4)}] ${c.name.padEnd(18)} ${c.detail}`),
      `RESULT: ${fails ? `FAIL (${fails} problem(s), ${warns} warning(s))` : `OK (${warns} warning(s))`}`].join('\n')
  return {code: fails ? 1 : 0, msg}
}
