// PROBE target "wrapper": the stateful self-fuzzer of the Stopbar hooks. Random sequences of 20-30 steps run on the
// REAL wrapper (runHook and the human commands, in process) against a REAL git repository with real files:
// PreToolUse, PostToolUse, PostToolUseFailure, Stop, approve-tests, approve-shell, resume, edits of code, tests and
// config, human edits, deletions, a lost snapshot copy, torn events.jsonl lines and a damaged state.json.
// After every step the result is compared with a reference model: gdp-wired's interpreter of the proven kernel (not
// the generated step the wrapper runs), driven by an independent description of what each tool call means (file roles
// are known by construction, no glob code). Compared: exit code, every kernel field, kernel steps in events.jsonl.
import {execFileSync} from 'node:child_process'
import {appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
import {dirname, join} from 'node:path'
import * as C from '../commands.ts'
import {runHook} from '../hook.ts'
import type {Outcome, ProbeTarget} from './index.ts'

// ---------------------------------------------------------------- actions (pure data, generated from a seed)
type Action =
  | {t: 'edit'; tool: 'Write' | 'Edit'; file: string; content: string}
  | {t: 'shellEdit'; file: string; content: string}
  | {t: 'shellDelete'; file: string}
  | {t: 'humanEdit'; file: string; content: string}
  | {t: 'build'; outcome: 'pass' | 'fail' | 'interrupt' | 'interrupted'}
  | {t: 'fulltest'; outcome: 'pass' | 'fail' | 'interrupt' | 'interrupted'}
  | {t: 'partial'; pass: boolean}
  | {t: 'shell'; cmd: 'ls -la' | 'curl --version' | 'cat .env' | 'git status'}
  | {t: 'read'; file: string}
  | {t: 'web'}
  | {t: 'commit'; heredoc: boolean; msg: string}
  | {t: 'chained'; cmd: string}
  | {t: 'protected'; tool: string; input: Record<string, string>}
  | {t: 'stop'; active: boolean}
  | {t: 'approveTests'; stale: number}
  | {t: 'approveShell'}
  | {t: 'resume'; extra: number}
  | {t: 'tornLog'}
  | {t: 'loseCounted'}
  | {t: 'corruptState'; how: 'empty' | 'truncated' | 'garbage'}

export type Run = {seed: number; params: {maxRetries: number; cap: number; cost: number}; actions: Action[]}

function rng(seed: number) { let x = (seed * 2654435761) >>> 0 || 7; return () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 2 ** 32 } }

const CODE = ['src/c0.mjs', 'src/c1.mjs', 'src/c2.mjs']
const TESTS = ['tests/t0.test.mjs', 'tests/t1.test.mjs']
const CONFIG = 'pytest.ini'

function genRun(seed: number): Run {
  const r = rng(seed), pick = <T>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)]
  const n = 20 + Math.floor(r() * 11)
  let k = 0
  const content = () => (r() < 0.08 ? 'same\n' : `// ${seed}-${k++}-${Math.floor(r() * 1e6)}\n`)
  const anyFile = () => pick([...CODE, ...TESTS, `tests/n${Math.floor(r() * 3)}.test.mjs`, `src/n${Math.floor(r() * 3)}.mjs`, CONFIG])
  const actions: Action[] = []
  const W: [number, () => Action][] = [
    [14, () => ({t: 'edit', tool: pick(['Write', 'Edit'] as const), file: pick([...CODE, ...CODE, `src/n${Math.floor(r() * 3)}.mjs`]), content: content()})],
    [6, () => ({t: 'edit', tool: pick(['Write', 'Edit'] as const), file: pick([...TESTS, `tests/n${Math.floor(r() * 3)}.test.mjs`, CONFIG]), content: content()})],
    [4, () => ({t: 'shellEdit', file: anyFile(), content: content()})],
    [2, () => ({t: 'shellDelete', file: anyFile()})],
    [2, () => ({t: 'humanEdit', file: anyFile(), content: content()})],
    [10, () => ({t: 'build', outcome: pick(['pass', 'pass', 'pass', 'fail', 'interrupt', 'interrupted'] as const)})],
    [10, () => ({t: 'fulltest', outcome: pick(['pass', 'pass', 'pass', 'fail', 'fail', 'interrupt', 'interrupted'] as const)})],
    [3, () => ({t: 'partial', pass: r() < 0.6})],
    [5, () => ({t: 'shell', cmd: pick(['ls -la', 'curl --version', 'cat .env', 'git status'] as const)})],
    [4, () => ({t: 'read', file: pick(['.env', 'src/c0.mjs', 'secrets/key.txt', 'README.md'])})],
    [2, () => ({t: 'web'})],
    [9, () => ({t: 'commit', heredoc: r() < 0.5, msg: `fuzz ${seed} ${k++}`})],
    [2, () => ({t: 'chained', cmd: pick(['node --test; echo $?', 'node build.mjs | tail -3', 'git add -A && git commit -q -m x', 'git commit -m "$(id)"', "git commit -m \"$(cat <<EOF\nx\nEOF\n)\""])})],
    [3, () => pick([
      {t: 'protected', tool: 'Write', input: {file_path: '.git/stopbar/state.json'}},
      {t: 'protected', tool: 'Edit', input: {file_path: '.claude/settings.local.json'}},
      {t: 'protected', tool: 'Write', input: {file_path: '.git/hooks/pre-commit'}},
      {t: 'protected', tool: 'Bash', input: {command: 'rm -f .git/stopbar/config.json'}},
      {t: 'protected', tool: 'Bash', input: {command: 'git config core.hooksPath x'}},
      {t: 'protected', tool: 'Bash', input: {command: 'npx stopbar approve-tests'}},
    ] as Action[])],
    [3, () => ({t: 'stop', active: r() < 0.2})],
    [3, () => ({t: 'approveTests', stale: r() < 0.3 ? 1 + Math.floor(r() * 2) : 0})],
    [2, () => ({t: 'approveShell'})],
    [2, () => ({t: 'resume', extra: Math.floor(r() * 12)})],
    [2, () => ({t: 'tornLog'})],
    [1, () => ({t: 'loseCounted'})],
    [1, () => ({t: 'corruptState', how: pick(['empty', 'truncated', 'garbage'] as const)})],
  ]
  const total = W.reduce((s, [w]) => s + w, 0)
  while (actions.length < n) {
    // the honest path as one macro: green build, green full suite, commit (sometimes after an approval)
    if (r() < 0.12) {
      if (r() < 0.3) actions.push({t: 'approveTests', stale: 0})
      actions.push({t: 'build', outcome: 'pass'}, {t: 'fulltest', outcome: 'pass'}, {t: 'commit', heredoc: r() < 0.5, msg: `honest ${seed} ${k++}`})
      continue
    }
    let x = r() * total
    for (const [w, f] of W) { if ((x -= w) < 0) { actions.push(f()); break } }
  }
  return {seed, params: {maxRetries: 1 + Math.floor(r() * 3), cap: 10 + Math.floor(r() * 60), cost: Math.floor(r() * 3)}, actions: actions.slice(0, 30)}
}

// ---------------------------------------------------------------- execution against the real wrapper + the model
type Cov = Record<string, number>
async function execute(run: Run, dir: string): Promise<Outcome> {
  // the model needs the prover package (gdp-wired); the hooks under test never load it
  const {kernel} = await import('../kernel.ts')
  const R = kernel('none'), IT = R.interpreter()
  const {maxRetries, cap, cost} = run.params
  const P = R.encodeParams({maxRetries, cap})

  rmSync(dir, {recursive: true, force: true, maxRetries: 5})
  mkdirSync(join(dir, 'src'), {recursive: true}); mkdirSync(join(dir, 'tests'), {recursive: true})
  const g = (...a: string[]) => execFileSync('git', ['-c', 'user.name=fuzz', '-c', 'user.email=f@x.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...a], {cwd: dir, stdio: 'ignore'})
  const work = new Map<string, string>()
  const put = (f: string, c: string) => { mkdirSync(dirname(join(dir, f)), {recursive: true}); writeFileSync(join(dir, f), c); work.set(f, c) }
  for (const f of [...CODE, ...TESTS]) put(f, `// base ${f}\n`)
  put(CONFIG, '[pytest]\n'); put('README.md', '# fuzz\n')
  writeFileSync(join(dir, '.gitignore'), '.env\nsecrets/\n'); work.set('.gitignore', '.env\nsecrets/\n')
  writeFileSync(join(dir, '.env'), 'X=1\n')
  g('init', '-q'); g('config', 'core.autocrlf', 'false'); g('add', '-A'); g('commit', '-qm', 'base')
  const opts = (o: Record<string, string>) => ({get: (k: string) => o[k], has: (k: string) => k in o, int: (k: string, d: number) => (k in o ? Number(o[k]) : d)})
  const ini = C.init(opts({repo: dir, build: 'node build.mjs', test: 'node --test', 'max-retries': String(maxRetries), cap: String(cap), cost: String(cost), 'no-pin': ''}))
  if (ini.code !== 0) throw new Error(`init failed: ${ini.msg}`)

  // ---- model
  let st = IT.init(P)
  let modelSteps = 0
  let head = new Map(work), counted = new Map(work), countedCopy = true
  const view = () => R.decode(st) as Record<string, any>
  const kstep = (req: Record<string, unknown>) => {
    st = IT.step(P, st, R.encodeInput({op: 'EDIT_CODE', cost: 0, passed: false, fullSuite: false, suspicious: false, risky: false, treeChanged: false, approveRev: 0, extra: 0, ...req}, {maxRetries, cap}))
    modelSteps++
    return view()
  }
  const same = (a: Map<string, string>, b: Map<string, string>) => a.size === b.size && [...a].every(([k, v]) => b.get(k) === v)
  const isTest = (f: string) => f.startsWith('tests/')
  const mSync = (c: number) => {
    if (same(work, counted)) return null
    const base = countedCopy ? counted : head
    const changed = [...new Set([...base.keys(), ...work.keys()])].filter((f) => base.get(f) !== work.get(f))
    if (!changed.length) {
      // the counted copy was lost and the tree equals HEAD: the wrapper still sees a new snapshot id with no changes
    }
    const anyTest = changed.some((f) => isTest(f) || f === CONFIG || f === '.gitignore')
    const suspicious = changed.some((f) => f === CONFIG || f === '.gitignore' || (isTest(f) && head.has(f)))
    const before = view().treeRev
    const after = kstep({op: anyTest ? 'EDIT_TEST' : 'EDIT_CODE', suspicious, cost: c})
    if (after.treeRev > before) { counted = new Map(work); countedCopy = true }
    return {suspicious}
  }

  // ---- real wrapper
  let hooks = 0
  const hook = (ev: string, tool: string, input: object, extra: object = {}) => { hooks++; return runHook(JSON.stringify({session_id: 'fuzz', hook_event_name: ev, tool_name: tool, tool_input: input, cwd: dir, ...extra})).code as number }
  const okResp = {tool_response: {stdout: '', stderr: '', interrupted: false, isImage: false, noOutputExpected: false}}
  const sd = join(dir, '.git', 'stopbar')
  const readKernel = () => JSON.parse(readFileSync(join(sd, 'state.json'), 'utf8')).kernel.scalars
  const loggedSteps = () => readFileSync(join(sd, 'events.jsonl'), 'utf8').split('\n').filter((l) => { try { return !!JSON.parse(l).req } catch { return false } }).length
  const initSteps = loggedSteps()

  const cov: Cov = {}
  const inc = (k: string) => { cov[k] = (cov[k] ?? 0) + 1 }
  for (let i = 0; i < run.actions.length; i++) {
    const a = run.actions[i]
    const v0 = view()
    const halted = () => view().halted
    let expCode = 0, gotCode = 0
    const expectPre = () => (halted() ? 2 : 0)
    // PostToolUse: PAUSE when a suspicious change was counted or the session is halted
    const postCode = (cls: {suspicious: boolean} | null) => (cls?.suspicious || halted() ? 2 : 0)
    switch (a.t) {
      case 'edit': {
        const input = {file_path: join(dir, a.file), content: a.content}
        expCode = expectPre(); gotCode = hook('PreToolUse', a.tool, input)
        if (gotCode !== 0 || expCode !== 0) break
        put(a.file, a.content)
        expCode = postCode(mSync(cost))
        gotCode = hook('PostToolUse', a.tool, input, {tool_response: {filePath: input.file_path, success: true}})
        break
      }
      case 'shellEdit': case 'shellDelete': {
        const command = a.t === 'shellEdit' ? `node -e "require('fs').writeFileSync('${a.file}', 'x')"` : `rm -f ${a.file}`
        expCode = expectPre()
        if (!halted()) { const v = kstep({op: 'SHELL', risky: false, cost}); if (v.decision === 'PAUSE') expCode = 2 }
        gotCode = hook('PreToolUse', 'Bash', {command})
        if (gotCode !== 0 || expCode !== 0) break
        if (a.t === 'shellEdit') put(a.file, a.content)
        else { rmSync(join(dir, a.file), {force: true}); work.delete(a.file) }
        expCode = postCode(mSync(0))
        gotCode = hook('PostToolUse', 'Bash', {command}, okResp)
        break
      }
      case 'humanEdit': put(a.file, a.content); break
      case 'build': case 'fulltest': {
        const command = a.t === 'build' ? 'node build.mjs' : 'node --test'
        expCode = expectPre(); gotCode = hook('PreToolUse', 'Bash', {command})
        if (gotCode !== 0 || expCode !== 0) break
        const op = a.t === 'build' ? 'RUN_BUILD' : 'RUN_TESTS'
        if (a.outcome !== 'interrupt') kstep({op, passed: a.outcome === 'pass', fullSuite: a.t === 'fulltest', cost})
        expCode = postCode(mSync(0))
        gotCode = a.outcome === 'pass' ? hook('PostToolUse', 'Bash', {command}, okResp)
          : a.outcome === 'interrupted' ? hook('PostToolUse', 'Bash', {command}, {tool_response: {...okResp.tool_response, interrupted: true}})
            : hook('PostToolUseFailure', 'Bash', {command}, {error: a.outcome === 'interrupt' ? 'Interrupted by user' : 'Command failed with exit code 1', is_interrupt: a.outcome === 'interrupt'})
        break
      }
      case 'partial': {
        const command = 'node --test tests/t0.test.mjs'
        expCode = expectPre()
        if (!halted()) { const v = kstep({op: 'SHELL', risky: false, cost}); if (v.decision === 'PAUSE') expCode = 2 }
        gotCode = hook('PreToolUse', 'Bash', {command})
        if (gotCode !== 0 || expCode !== 0) break
        kstep({op: 'RUN_TESTS', passed: a.pass, fullSuite: false})
        expCode = postCode(mSync(0))
        gotCode = a.pass ? hook('PostToolUse', 'Bash', {command}, okResp) : hook('PostToolUseFailure', 'Bash', {command}, {error: 'exit 1', is_interrupt: false})
        break
      }
      case 'shell': {
        expCode = expectPre()
        if (!halted()) {
          if (a.cmd === 'cat .env') kstep({op: 'READ_SECRET'})
          const v = kstep({op: 'SHELL', risky: a.cmd === 'curl --version', cost})
          if (v.decision === 'PAUSE') expCode = 2
        }
        gotCode = hook('PreToolUse', 'Bash', {command: a.cmd})
        if (gotCode !== 0 || expCode !== 0) break
        expCode = postCode(mSync(0))
        gotCode = hook('PostToolUse', 'Bash', {command: a.cmd}, okResp)
        break
      }
      case 'read': {
        expCode = expectPre()
        if (!halted() && (a.file === '.env' || a.file.startsWith('secrets/'))) kstep({op: 'READ_SECRET', cost})
        gotCode = hook('PreToolUse', 'Read', {file_path: join(dir, a.file)})
        break
      }
      case 'web': {
        expCode = expectPre()
        if (!halted()) { const v = kstep({op: 'SHELL', risky: true, cost}); if (v.decision === 'PAUSE') expCode = 2 }
        gotCode = hook('PreToolUse', 'WebFetch', {url: 'https://example.invalid', prompt: 'x'})
        break
      }
      case 'commit': {
        const command = a.heredoc ? `git commit -q -m "$(cat <<'EOF'\n${a.msg}\n\nReviewed-by: Jane Doe <jane@example.invalid>\nEOF\n)"` : `git commit -q -m "${a.msg}"`
        expCode = expectPre()
        if (!halted()) { mSync(0); const v = kstep({op: 'COMMIT', cost}); expCode = v.decision === 'ALLOW' ? 0 : 2 }
        gotCode = hook('PreToolUse', 'Bash', {command})
        if (gotCode !== 0 || expCode !== 0) break
        g('add', '-A'); try { g('commit', '-q', '--allow-empty', '-m', a.msg) } catch { /* nothing */ }
        head = new Map(work)
        expCode = postCode(mSync(0))
        gotCode = hook('PostToolUse', 'Bash', {command}, okResp)
        break
      }
      case 'chained': expCode = 2; gotCode = hook('PreToolUse', 'Bash', {command: a.cmd}); break
      case 'protected': expCode = 2; gotCode = hook('PreToolUse', a.tool, a.tool === 'Bash' ? a.input : {file_path: join(dir, a.input.file_path)}); break
      case 'stop': {
        if (a.active) { expCode = 0; gotCode = hook('Stop', '', {}, {stop_hook_active: true}); break }
        mSync(0)
        if (same(work, head)) expCode = 0
        else expCode = kstep({op: 'COMMIT'}).decision === 'ALLOW' ? 0 : 2
        gotCode = hook('Stop', '', {})
        break
      }
      case 'approveTests': {
        const rev = Math.max(0, view().treeRev - a.stale)
        expCode = kstep({op: 'APPROVE_TESTS', approveRev: rev}).decision === 'ALLOW' ? 0 : 1
        gotCode = C.human('approve-tests', opts({repo: dir, rev: String(rev)})).code
        break
      }
      case 'approveShell': expCode = kstep({op: 'APPROVE_SHELL'}).shellToken ? 0 : 1; gotCode = C.human('approve-shell', opts({repo: dir})).code; break
      case 'resume': kstep({op: 'RESUME', extra: a.extra}); expCode = 0; gotCode = C.human('resume', opts({repo: dir, extra: String(a.extra)})).code; break
      case 'tornLog': appendFileSync(join(sd, 'events.jsonl'), `{"ts":"x","source":"pre:Bash","req":{"op":"SHE`); break
      case 'loseCounted': rmSync(join(sd, 'snapshot.counted.index'), {force: true}); countedCopy = false; break
      case 'corruptState': {
        // a crash or a stray write damages state.json: every hook fails closed and changes nothing, then a human resets
        const good = readFileSync(join(sd, 'state.json'), 'utf8')
        writeFileSync(join(sd, 'state.json'), a.how === 'empty' ? '' : a.how === 'truncated' ? good.slice(0, Math.floor(good.length / 2)) : '{"version": 2, "kernel": 7}')
        const logBefore = readFileSync(join(sd, 'events.jsonl'), 'utf8')
        expCode = 2; gotCode = hook('PreToolUse', 'Read', {file_path: join(dir, 'src', 'c0.mjs')})
        if (gotCode !== 2) break
        gotCode = hook('Stop', '', {})
        if (gotCode !== 2) break
        if (readFileSync(join(sd, 'events.jsonl'), 'utf8') !== logBefore) { gotCode = -1; break } // fail closed writes nothing
        st = IT.init(P); counted = new Map(work); countedCopy = true
        expCode = 0; gotCode = C.human('reset', opts({repo: dir})).code
        break
      }
    }
    if (gotCode !== expCode) return {ok: false, mismatch: {step: i, action: a, what: 'exit code', expected: expCode, actual: gotCode}}
    const v1 = view()
    if (a.t === 'commit') inc(expCode === 0 ? 'commitAllowed' : v0.halted ? 'commitPausedHalted' : 'commitBlocked')
    if (a.t === 'stop' && !a.active) inc(expCode === 0 ? 'stopAllowed' : 'stopBlocked')
    if (!v0.halted && v1.halted) inc('halts')
    if (!v0.testsTainted && v1.testsTainted) inc('taints')
    if (v0.testsTainted && !v1.testsTainted) inc('taintCleared')
    if (a.t === 'approveShell' && expCode === 0) inc('shellApproved')
    if (expCode === 2 && v0.secretTainted && (a.t === 'shell' || a.t === 'web') && !v0.halted) inc('exfilPaused')
    if (a.t === 'protected') inc('protectedBlocked')
    if (a.t === 'loseCounted' || a.t === 'tornLog' || a.t === 'corruptState') inc(a.t)
    if (expCode === 2) inc('exit2')
    const real = readKernel()
    if (JSON.stringify(real) !== JSON.stringify(st.scalars)) return {ok: false, mismatch: {step: i, action: a, what: 'kernel state', expected: st.scalars, actual: real}}
    const logged = loggedSteps() - initSteps
    if (logged !== modelSteps) return {ok: false, mismatch: {step: i, action: a, what: 'kernel steps in events.jsonl', expected: modelSteps, actual: logged}}
  }
  return {ok: true, steps: run.actions.length, hooks, cov}
}


export const wrapperTarget: ProbeTarget<Run> = {
  name: 'wrapper',
  description: 'Stopbar hooks and human commands vs the gdp-wired interpreter of the proven kernel, on a real git repository',
  generate: genRun,
  execute,
}
