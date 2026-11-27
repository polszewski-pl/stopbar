import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
import {dirname, join, resolve} from 'node:path'
import {test} from 'node:test'
import {fileURLToPath} from 'node:url'
import {decode, encodeInput, initKernel, kstep, MACHINE} from '../../dist/engine.js'
import * as G from '../../dist/kernel.gen.js'
import {changesSinceHead, changesSinceRef, digest, diffEntries, FailClosed, findRepo, inRef, oidOf, parseIndex, readHooksPath, refEntries} from '../../dist/repo.js'
import {appendEvent, readEvents, validateState} from '../../dist/store.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const TMP = join(ROOT, '.e2e-tmp', 'unit')
const g = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.name=u', '-c', 'user.email=u@x.invalid', '-c', 'commit.gpgsign=false', ...a], {cwd, encoding: 'utf8'})

function repo(name: string, initArgs: string[] = []) {
  const d = join(TMP, name)
  rmSync(d, {recursive: true, force: true}); mkdirSync(join(d, 'src', 'deep', 'er'), {recursive: true})
  g(d, 'init', '-q', ...initArgs)
  writeFileSync(join(d, 'src', 'a.ts'), 'a\n'); writeFileSync(join(d, 'src', 'deep', 'er', 'b with space ü.ts'), 'b\n')
  for (let i = 0; i < 40; i++) writeFileSync(join(d, 'src', `f${String(i).padStart(3, '0')}.txt`), `${i}\n`)
  return d
}
/** Entries as git itself lists them, for comparison. */
function gitEntries(d: string, index: string) {
  const out = execFileSync('git', ['-c', 'core.quotepath=false', 'ls-files', '-s', '-z'], {cwd: d, encoding: 'utf8', env: {...process.env, GIT_INDEX_FILE: index}})
  const m = new Map<string, string>()
  for (const rec of out.split('\0').filter(Boolean)) { const [meta, p] = rec.split('\t'); const [mode, oid] = meta.split(' '); m.set(p, `${mode} ${oid}`) }
  return m
}

for (const [name, cfg, initArgs] of [['v2', 'index.version=2', []], ['v3', 'index.version=3', []], ['v4', 'index.version=4', []], ['sha256', 'index.version=2', ['--object-format=sha256']]] as const) {
  test(`parseIndex reads a git index (${name}) exactly as git ls-files does`, () => {
    const d = repo(`idx-${name}`, [...initArgs])
    const index = join(d, '.git', 'test.index')
    execFileSync('git', ['-c', cfg, 'read-tree', '--empty'], {cwd: d, env: {...process.env, GIT_INDEX_FILE: index}})
    execFileSync('git', ['-c', cfg, 'add', '-A'], {cwd: d, env: {...process.env, GIT_INDEX_FILE: index}})
    if (name === 'v3') execFileSync('git', ['update-index', '--skip-worktree', 'src/a.ts'], {cwd: d, env: {...process.env, GIT_INDEX_FILE: index}})
    const mine = parseIndex(readFileSync(index))
    assert.deepEqual([...mine], [...gitEntries(d, index)])
    assert.equal(mine.size, 42)
  })
}

test('parseIndex rejects a damaged index (checksum)', () => {
  const d = repo('idx-bad')
  const index = join(d, '.git', 'test.index')
  execFileSync('git', ['add', '-A'], {cwd: d, env: {...process.env, GIT_INDEX_FILE: index}})
  const b = readFileSync(index); b[40] ^= 0xff
  assert.throws(() => parseIndex(b), /checksum/)
  assert.throws(() => parseIndex(b.subarray(0, b.length - 30)), /checksum|truncated/)
})

test('refEntries and changesSinceRef: blob ids from git ls-tree, fail closed for a ref that does not resolve', () => {
  const d = repo('ref-entries')
  mkdirSync(join(d, 'tests'), {recursive: true})
  writeFileSync(join(d, 'tests', 'a.test.mjs'), 'a\n'); writeFileSync(join(d, 'tests', 'b c ü.test.mjs'), 'b\n'); writeFileSync(join(d, 'pytest.ini'), '[pytest]\n')
  // before the first commit: HEAD is an empty tree, any other ref fails closed
  assert.equal(refEntries(d, 'HEAD', ['tests/a.test.mjs']).size, 0)
  assert.throws(() => refEntries(d, 'main-not-yet', ['tests/a.test.mjs']), FailClosed)
  g(d, 'add', '-A'); g(d, 'commit', '-q', '-m', 'base')
  const blob = (p: string) => g(d, 'rev-parse', `HEAD:${p}`).trim()
  const e = refEntries(d, 'HEAD', ['tests/a.test.mjs', 'tests/b c ü.test.mjs', 'pytest.ini', 'tests/missing.test.mjs', 'src/*.txt'])
  assert.deepEqual([...e.keys()].sort(), ['pytest.ini', 'tests/a.test.mjs', 'tests/b c ü.test.mjs']) // literal pathspecs: no glob
  assert.equal(e.get('tests/a.test.mjs'), `100644 ${blob('tests/a.test.mjs')}`)
  assert.equal(oidOf(e.get('tests/b c ü.test.mjs')), blob('tests/b c ü.test.mjs'))
  assert.equal(oidOf(undefined), undefined)
  assert.equal(refEntries(d, 'HEAD', []).size, 0)
  g(d, 'branch', 'base')
  assert.deepEqual(refEntries(d, 'base', ['tests/a.test.mjs']), new Map([['tests/a.test.mjs', `100644 ${blob('tests/a.test.mjs')}`]]))
  assert.throws(() => refEntries(d, 'no-such-ref', ['tests/a.test.mjs']), (x: unknown) => x instanceof FailClosed && /baseRef "no-such-ref" could not be resolved/.test((x as Error).message))
  assert.throws(() => inRef(d, 'no-such-ref', ['tests/a.test.mjs']), FailClosed) // the 1.1.2 export keeps its contract
  assert.deepEqual([...inRef(d, 'base', ['tests/a.test.mjs', 'tests/x.test.mjs'])], ['tests/a.test.mjs'])
  // changesSinceRef: entries against the whole tree of a ref (M, A, D)
  const r = findRepo(d)
  const files = g(d, 'ls-files', '-z').split('\0').filter(Boolean)
  const cur = new Map(refEntries(d, 'HEAD', files))
  assert.equal(cur.size, files.length)
  cur.set('tests/a.test.mjs', '100644 ' + '0'.repeat(40)); cur.set('tests/new.test.mjs', '100644 ' + '1'.repeat(40)); cur.delete('pytest.ini')
  const want = [{status: 'D', path: 'pytest.ini'}, {status: 'M', path: 'tests/a.test.mjs'}, {status: 'A', path: 'tests/new.test.mjs'}]
  assert.deepEqual(changesSinceRef(r, 'base', cur), want)
  assert.deepEqual(changesSinceRef(r, 'HEAD', cur), want)
  assert.deepEqual(changesSinceHead(r, cur), want)
  assert.throws(() => changesSinceRef(r, 'no-such-ref', cur), FailClosed)
})

test('digest and diffEntries', () => {
  const a = new Map([['x', '100644 aa'], ['y', '100644 bb']]), b = new Map([['x', '100644 aa'], ['y', '100755 bb'], ['z', '100644 cc']])
  assert.notEqual(digest(a), digest(b))
  assert.equal(digest(a), digest(new Map(a)))
  assert.deepEqual(diffEntries(a, b), [{status: 'M', path: 'y'}, {status: 'A', path: 'z'}])
  assert.deepEqual(diffEntries(b, a), [{status: 'M', path: 'y'}, {status: 'D', path: 'z'}])
})

test('findRepo: no git process, worktree gitdir file, /c/ paths on Windows', () => {
  const d = repo('find')
  const r = findRepo(join(d, 'src', 'deep'))
  assert.equal(r.root, d)
  assert.equal(r.stateDir, join(d, '.git', 'stopbar'))
  g(d, 'add', '-A'); g(d, 'commit', '-qm', 'base')
  const wt = join(TMP, 'find-wt'); rmSync(wt, {recursive: true, force: true})
  g(d, 'worktree', 'add', '-q', wt)
  const w = findRepo(wt)
  assert.equal(w.root, wt)
  assert.match(w.gitDir.replace(/\\/g, '/'), /\.git\/worktrees\/find-wt$/)
  if (process.platform === 'win32') assert.equal(findRepo('/' + d[0].toLowerCase() + d.slice(2).replace(/\\/g, '/')).root.toLowerCase(), d.toLowerCase())
})

test('event log: a torn last line never swallows the next entry', () => {
  const d = repo('log')
  const r = findRepo(d); mkdirSync(r.stateDir, {recursive: true})
  appendEvent(r, {n: 1})
  appendFileSync(join(r.stateDir, 'events.jsonl'), '{"n": 2, "torn')
  appendEvent(r, {n: 3})
  appendEvent(r, {n: 4})
  const ev = readEvents(r)
  assert.deepEqual(ev.events.map((e: any) => e.n), [1, 3, 4])
  assert.equal(ev.torn.length, 1)
  assert.equal(ev.torn[0].line, 2)
})

test('state validation rejects damaged kernel state', () => {
  const ok = {version: 2, snapshot: 'a'.repeat(64), params: {maxRetries: 2, cap: 5}, kernel: initKernel({maxRetries: 2, cap: 5})}
  assert.ok(validateState(ok))
  assert.throws(() => validateState({...ok, version: 1}), /version/)
  assert.throws(() => validateState({...ok, params: {maxRetries: 0, cap: 5}}), /params/)
  assert.throws(() => validateState({...ok, kernel: {scalars: {...ok.kernel.scalars, decision: 3}, maps: {}}}), /decision/)
  assert.throws(() => validateState({...ok, kernel: {scalars: {...ok.kernel.scalars, extra: 1}, maps: {}}}), /unknown/)
  const {treeRev: _t, ...missing} = ok.kernel.scalars
  assert.throws(() => validateState({...ok, kernel: {scalars: missing, maps: {}}}), /treeRev/)
})

test('engine: the generated step is the unmutated kernel and refuses inputs outside its assumptions', () => {
  assert.equal(MACHINE.name, 'stopbar_kernel_none')
  assert.equal(G.KERNEL_SOURCE_SHA256, createHash('sha256').update(readFileSync(join(ROOT, 'src', 'kernel.ts'))).digest('hex'), 'dist/kernel.gen.js is stale: run npm run build')
  const p = {maxRetries: 2, cap: 10}
  let s = initKernel(p)
  for (const op of ['EDIT_CODE', 'RUN_BUILD', 'RUN_TESTS', 'COMMIT'] as const) s = kstep(p, s, {op, cost: 1, passed: true, fullSuite: true})
  assert.equal(decode(s).commitExecuted, true)
  assert.throws(() => kstep(p, s, {op: 'RESUME', cost: 1}), RangeError) // human actions cost nothing (assume)
  assert.throws(() => encodeInput({op: 'NOPE' as any}), /unknown op/)
  assert.throws(() => encodeInput({op: 'SHELL', cost: -1}), /cost/)
})

test('engine: compileJs of src/kernel.ts equals dist/kernel.gen.js, and it replays like the interpreter', async () => {
  const {checkGenerated} = await import('../../dist/verify.js')
  const r: any = await checkGenerated(2000)
  assert.equal(r.sameMachine, true)
  assert.equal(r.sameSource, true)
  assert.equal(r.differential.mismatches, 0)
  assert.ok(r.differential.steps >= 2000)
})

test('each of the 10 mutants has a concrete counterexample run: a law fails on it and every law holds on the original', async () => {
  const {KNOWN_RUNS, loadKernel} = await import('../../dist/verify.js')
  const {k, gw} = await loadKernel()
  const REQ0 = {op: 'EDIT_CODE', cost: 0, passed: false, fullSuite: false, suspicious: false, risky: false, treeChanged: false, approveRev: 0, extra: 0}
  const mutants = k.MUTANTS.filter((m: string) => m !== 'none')
  assert.equal(mutants.length, 10)
  for (const m of mutants) {
    const run = KNOWN_RUNS[m]
    const replay = (rule: any) => { const l = k.laws(rule); return gw.replayRefutation(rule, l.laws, l.stepLaws, rule.encodeParams(run.params), run.trace.map((q: object) => rule.encodeInput({...REQ0, ...q}, run.params)), 1000) }
    assert.equal(replay(k.kernel(m)), true, `${m}: the counterexample must break the mutant`)
    assert.equal(replay(k.kernel('none')), false, `${m}: the counterexample must not break the original`)
  }
})

test('F4 attestation: an events.jsonl with more than 130000 lines stays consistent (no spread into Math.max)', async () => {
  const {init} = await import('../../dist/commands.js')
  const {attestation} = await import('../../dist/attest.js')
  const d = join(TMP, 'f4-attest-large')
  rmSync(d, {recursive: true, force: true}); mkdirSync(d, {recursive: true})
  g(d, 'init', '-q'); writeFileSync(join(d, 'a.txt'), 'a\n'); g(d, 'add', '-A'); g(d, 'commit', '-qm', 'base')
  const o: Record<string, string> = {repo: d, build: 'node -v', test: 'npm -v', 'no-pin': ''}
  const r = init({get: (k: string) => o[k], has: (k: string) => k in o, int: (k: string, def: number) => (k in o ? Number(o[k]) : def)})
  assert.equal(r.code, 0, r.msg)
  appendFileSync(join(d, '.git', 'stopbar', 'events.jsonl'), '{"ts":"2026-01-01T00:00:00.000Z","source":"hook-timing","event":"PreToolUse","tool":"Read","exit":0}\n'.repeat(140000))
  const a = attestation(d)
  assert.equal(a.consistent, true, JSON.stringify(a.checks))
  assert.ok(a.log.entries > 140000)
})

test('1.2.2 readHooksPath: core.hooksPath from .git/config (and commondir, config.worktree) without a git process', () => {
  const d = join(TMP, 'hooks-path'), gd = join(d, '.git')
  rmSync(d, {recursive: true, force: true}); mkdirSync(gd, {recursive: true})
  const r = {root: d, gitDir: gd, stateDir: join(gd, 'stopbar')}
  assert.equal(readHooksPath(r), null, 'no config')
  writeFileSync(join(gd, 'config'), '[core]\n\trepositoryformatversion = 0\n[remote "o"]\n\thooksPath = nope\n')
  assert.equal(readHooksPath(r), null, 'hooksPath outside [core]')
  writeFileSync(join(gd, 'config'), '[core]\n\tbare = false\n[Core]\n\tHooksPath = .husky ; comment\n')
  assert.deepEqual(readHooksPath(r), {raw: '.husky', dir: resolve(d, '.husky')})
  writeFileSync(join(gd, 'config'), '[core] hooksPath = "custom hooks/x" # c\n')
  assert.deepEqual(readHooksPath(r), {raw: 'custom hooks/x', dir: resolve(d, 'custom hooks/x')})
  writeFileSync(join(gd, 'config'), '[core]\n\thooksPath = .git/hooks\n')
  assert.equal(readHooksPath(r), null, 'the default <common-dir>/hooks is not custom')
  // a worktree: its gitdir has commondir; config.worktree wins over the shared config
  const wt = join(gd, 'worktrees', 'w'), wr = {root: join(TMP, 'hooks-path-wt'), gitDir: wt, stateDir: join(wt, 'stopbar')}
  mkdirSync(wt, {recursive: true}); writeFileSync(join(wt, 'commondir'), '../..\n')
  writeFileSync(join(gd, 'config'), '[core]\n\thooksPath = .husky\n')
  assert.deepEqual(readHooksPath(wr), {raw: '.husky', dir: resolve(wr.root, '.husky')})
  writeFileSync(join(wt, 'config.worktree'), '[core]\n\thooksPath = wt-hooks\n')
  assert.deepEqual(readHooksPath(wr), {raw: 'wt-hooks', dir: resolve(wr.root, 'wt-hooks')})
})

test('1.2.2 stopbar run: on Windows the gate command gets no inherited PWD; doctor warns when a bare bash is WSL', async () => {
  const {gateEnv} = await import('../../dist/run.js')
  const env = {PATH: '/usr/bin', PWD: 'C:/foo', Path: 'x'}
  assert.deepEqual(gateEnv(env, 'win32'), {PATH: '/usr/bin', Path: 'x'})
  assert.equal(gateEnv(env, 'linux'), env)
  const {wslBashWarning} = await import('../../dist/doctor.js')
  const wsl = () => String.raw`C:\Users\u\AppData\Local\Microsoft\WindowsApps\bash.exe`
  assert.match(wslBashWarning(['bash scripts/build.sh', 'npm test'], wsl, 'win32') ?? '', /WSL .*full path to Git Bash/)
  assert.match(wslBashWarning(['npm run build', 'bash -c x'], () => String.raw`C:\Windows\System32\bash.exe`, 'win32') ?? '', /WSL/)
  assert.equal(wslBashWarning(['bash scripts/build.sh', 'npm test'], () => String.raw`C:\Program Files\Git\usr\bin\bash.exe`, 'win32'), null)
  assert.equal(wslBashWarning(['"C:/Program Files/Git/bin/bash.exe" build.sh', 'npm test'], wsl, 'win32'), null)
  assert.equal(wslBashWarning(['bash build.sh', 'npm test'], wsl, 'linux'), null)
})
