import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
import {dirname, join, resolve} from 'node:path'
import {test} from 'node:test'
import {fileURLToPath} from 'node:url'
import {decode, encodeInput, initKernel, kstep, MACHINE} from '../../dist/engine.js'
import * as G from '../../dist/kernel.gen.js'
import {digest, diffEntries, findRepo, parseIndex} from '../../dist/repo.js'
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
