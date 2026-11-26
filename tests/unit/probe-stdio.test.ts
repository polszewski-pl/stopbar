import assert from 'node:assert/strict'
import {spawn, spawnSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {existsSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
import {dirname, join, resolve} from 'node:path'
import {test} from 'node:test'
import {fileURLToPath, pathToFileURL} from 'node:url'
import {loadCmd, probe, ProbeError, shrink} from '../../dist/probe/index.js'
import {initProbe} from '../../dist/probe/init.js'
import {CmdClient, commandFile, splitCommand} from '../../dist/probe/stdio.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const TMP = join(ROOT, '.e2e-tmp', 'unit-probe-stdio')
const STUB = join(ROOT, 'tests', 'fixtures', 'ndjson-stack.mjs')
const cmd = (...flags: string[]) => [`"${process.execPath}"`, `"${STUB}"`, ...flags].join(' ')
rmSync(TMP, {recursive: true, force: true}); mkdirSync(TMP, {recursive: true})

/** Settles within `ms` or fails the test: an error of the external process must never hang the client. */
function within<T>(p: Promise<T>, ms = 15000): Promise<T> {
  let t: ReturnType<typeof setTimeout>
  return Promise.race([p, new Promise<T>((_, bad) => { t = setTimeout(() => bad(new Error(`hung for ${ms} ms`)), ms) })]).finally(() => clearTimeout(t))
}

test('splitCommand and commandFile: quotes group words, the first existing file after the interpreter is the target', () => {
  assert.deepEqual(splitCommand(`python  "my dir/x.py" --flag 'a b' c""d`), ['python', 'my dir/x.py', '--flag', 'a b', 'cd'])
  assert.deepEqual(splitCommand(`""`), [''])
  assert.equal(commandFile(cmd('--bug')), STUB)
  assert.equal(commandFile(`python -m some.module`), null)
  assert.equal(commandFile(`"${STUB}"`), null, 'the interpreter itself is never the target')
})

test('CmdClient: info, generate (deterministic), execute ok and mismatch, mutants, unknown mutant; one process for all', async () => {
  const c = new CmdClient(cmd())
  try {
    assert.deepEqual(await c.info(), {name: 'ndjson-stack', description: 'a stack vs an array, over NDJSON', mutants: ['M1_popBottom', 'M2_pushTwice']})
    const r1 = await c.generate(7), r2 = await c.generate(7), r3 = await c.generate(8)
    assert.deepEqual(r1, r2)
    assert.notDeepEqual(r1.actions, r3.actions)
    assert.ok(r1.seed === 7 && r1.actions.length >= 10)
    const ok = await c.execute(r1, TMP)
    assert.ok(ok.ok && ok.steps === r1.actions.length && Object.values(ok.cov).reduce((s, v) => s + v, 0) === r1.actions.length)
    const twice = await c.execute({seed: 1, actions: [1, 2, 3].map((x) => ({t: 'push', args: x}))}, TMP, 'M2_pushTwice')
    assert.ok(!twice.ok && twice.mismatch.what === 'invariant size: size' && twice.mismatch.step === 2 && twice.mismatch.expected === 3 && twice.mismatch.actual === 4)
    const bottom = await c.execute({seed: 1, actions: [{t: 'push', args: 1}, {t: 'push', args: 2}, {t: 'pop', args: null}]}, TMP, 'M1_popBottom')
    assert.deepEqual(bottom, {ok: false, mismatch: {step: 2, action: {t: 'pop', args: null}, what: 'pop result', expected: 2, actual: 1}})
    const unknown = await c.execute(r1, TMP, 'M9')
    assert.ok(!unknown.ok && unknown.mismatch.what === 'unknown mutant' && unknown.mismatch.step === -1)
  } finally { await c.close() }
})

test('loadCmd + shrink: a failing run over NDJSON shrinks (chunked, then single) to the minimal 3 steps', async () => {
  const R = await loadCmd(cmd('--bug'))
  try {
    assert.equal(R.t.name, 'ndjson-stack')
    assert.equal(R.file, STUB)
    assert.equal(R.sha256, createHash('sha256').update(readFileSync(STUB)).digest('hex'))
    const actions = [...Array.from({length: 40}, (_, i) => ({t: 'push', args: i})), ...Array.from({length: 40}, () => ({t: 'pop', args: null}))]
    const x = await R.t.execute({seed: 0, actions}, TMP)
    assert.ok(!x.ok && x.mismatch.what === 'pop result')
    const min = await shrink(R.t, {seed: 0, actions}, join(TMP, 'shrink'), 'pop result')
    assert.equal(min.actions.length, 3, JSON.stringify(min.actions))
    assert.deepEqual(min.actions.map((a: any) => a.t), ['push', 'push', 'pop'])
    const again = await R.t.execute(min, TMP)
    assert.ok(!again.ok && again.mismatch.what === 'pop result')
  } finally { await R.t.close!() }
})

test('loadCmd: --target-file is hashed instead; a missing --target-file and an empty command are refused', async () => {
  const other = join(TMP, 'model.txt'); writeFileSync(other, 'the model\n')
  const R = await loadCmd(cmd(), {targetFile: other})
  await R.t.close!()
  assert.ok(R.file === other && R.sha256 === createHash('sha256').update('the model\n').digest('hex'))
  await assert.rejects(loadCmd(cmd(), {targetFile: join(TMP, 'missing.py')}), (e: Error) => e instanceof ProbeError && /does not exist/.test(e.message))
  assert.throws(() => new CmdClient('  '), ProbeError)
})

test('errors of the external process are ProbeErrors with the end of stderr, never a hang; close() always ends it', async () => {
  const cases: [string[], string, RegExp, number?][] = [
    [['--crash', 'info'], 'info', /exited with code 3 before answering[\s\S]*boom: crash on info/],
    [['--crash', 'execute'], 'execute', /exited with code 3 before answering \(waiting for the answer to execute\)[\s\S]*boom/],
    [['--garbage', 'generate'], 'generate', /printed a line that is not JSON: "this is not json"/],
    // the shell that starts the command may hold stdout open too (cmd.exe does): then the timeout ends the wait
    [['--close', 'generate'], 'generate', /closed stdout|did not answer within 1500 ms/, 1500],
    [['--hang', 'generate'], 'generate', /did not answer within 700 ms/, 700],
    [['--error', 'generate'], 'generate', /answered generate with an error: no generate today/],
    [['--bad', 'info'], 'info', /bad answer to info: name must be a non-empty string/],
    [['--bad', 'generate'], 'generate', /bad answer to generate: seed must be 5/],
    [['--bad', 'execute'], 'execute', /bad answer to execute: ok must be true or false/],
  ]
  for (const [flags, op, re, timeoutMs] of cases) {
    const c = new CmdClient(cmd(...flags), {timeoutMs: timeoutMs ?? 10000})
    const call = op === 'info' ? c.info() : op === 'generate' ? c.generate(5) : c.execute({seed: 5, actions: []}, TMP)
    await within(assert.rejects(call, (e: Error) => e instanceof ProbeError && re.test(e.message) || assert.fail(`${flags.join(' ')}: ${e.message}`)))
    await within(c.close(500))
  }
  // a command that does not exist: the shell reports it, the client does not hang
  const nx = new CmdClient('stopbar-no-such-program-xyz --x')
  await within(assert.rejects(nx.info(), (e: Error) => e instanceof ProbeError && /exited with code \d+ before answering/.test(e.message)))
  await nx.close()
})

test('kill(): a failed taskkill still ends the target, and the client never holds the event loop open', async () => {
  // A child Node process runs a target that never answers and ignores the end of stdin (a stuck process); the answer
  // times out, which kills the target. On Windows the child has no taskkill on PATH: spawnSync then returns an error
  // status instead of throwing (as in a sandbox or with too few rights), so the tree kill fails. The child must still
  // exit by itself: no process.exit, nothing left that keeps its event loop alive.
  const stuck = join(TMP, 'stuck-target.mjs'), pidFile = join(TMP, 'stuck-target.pid')
  rmSync(pidFile, {force: true})
  writeFileSync(stuck, [
    "import {writeFileSync} from 'node:fs'",
    'writeFileSync(process.argv[2], String(process.pid))',
    "process.stdin.resume(); process.stdin.on('end', () => {})",
    'setInterval(() => {}, 1000); setTimeout(() => process.exit(0), 60000)',
  ].join('\n') + '\n')
  const script = join(TMP, 'hang-check.mjs')
  writeFileSync(script, [
    `import {CmdClient} from ${JSON.stringify(pathToFileURL(join(ROOT, 'dist', 'probe', 'stdio.js')).href)}`,
    `const c = new CmdClient(${JSON.stringify([`"${process.execPath}"`, `"${stuck}"`, `"${pidFile}"`].join(' '))}, {timeoutMs: 1500})`,
    "c.generate(5).then(() => console.log('answered'), (e) => { console.log('rejected: ' + e.message); c.close(300) })",
  ].join('\n') + '\n')
  const env: Record<string, string | undefined> = {...process.env}
  if (process.platform === 'win32') {
    for (const k of Object.keys(env)) if (k.toLowerCase() === 'path') delete env[k]
    env.PATH = join(TMP, 'no-taskkill'); mkdirSync(env.PATH, {recursive: true})
    assert.ok(spawnSync('taskkill', ['/?'], {env, stdio: 'ignore'}).error, 'taskkill must not be found on the PATH of the child')
  }
  const ch = spawn(process.execPath, [script], {env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true})
  let out = ''
  ch.stdout.on('data', (d) => { out += d }); ch.stderr.on('data', (d) => { out += d })
  const exited = new Promise<number | null>((ok) => ch.on('exit', (code) => ok(code)))
  try {
    const code = await within(exited, 20000)
    assert.equal(code, 0, out)
    assert.match(out, /rejected: probe command .* did not answer within 1500 ms/)
    assert.doesNotMatch(out, /answered/)
    assert.ok(existsSync(pidFile), 'the target ran')
  } finally {
    if (ch.exitCode === null) {
      if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(ch.pid), '/T', '/F'], {stdio: 'ignore'})
      else ch.kill('SIGKILL')
    }
    // the target itself may outlive a failed tree kill (a grandchild of the shell): end it here
    try { process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGKILL') } catch { /* already gone */ }
  }
})

test('probe(): --cmd runs workers over NDJSON with mutants and summary; --cmd with --target, or --target-file alone, is refused', async () => {
  const work = join(TMP, 'work'), logs: string[] = []
  const r = await probe({cmd: cmd(), runs: 12, jobs: 2, checkMutants: true, mutantRuns: 30, work, record: false, log: (s) => logs.push(s)})
  assert.ok(r.ok, logs.join('\n'))
  assert.ok(r.summary.passed === 12 && r.summary.regressions === 0 && r.summary.targetCmd === cmd() && r.summary.target === 'ndjson-stack')
  assert.equal(r.summary.targetSha256, createHash('sha256').update(readFileSync(STUB)).digest('hex'))
  assert.deepEqual(r.summary.mutants && {killed: r.summary.mutants.killed, total: r.summary.mutants.total}, {killed: 2, total: 2})
  await assert.rejects(probe({cmd: cmd(), target: 'wrapper', record: false, log: () => {}}), (e: Error) => e instanceof ProbeError && /exclude each other/.test(e.message))
  await assert.rejects(probe({targetFile: STUB, record: false, log: () => {}}), (e: Error) => e instanceof ProbeError && /--target-file needs --cmd/.test(e.message))
  // a process that crashes in a worker: a ProbeError with its stderr, not a hung run
  await within(assert.rejects(probe({cmd: cmd('--crash', 'execute'), runs: 4, jobs: 2, work, record: false, log: () => {}}),
    (e: Error) => e instanceof ProbeError && /exited with code 3[\s\S]*boom: crash on execute/.test(e.message)), 30000)
})

test('probe init --lang ts|py: writes the template, refuses to overwrite without --force, rejects unknown languages and unsafe names', () => {
  const base = join(TMP, 'init')
  const ts = initProbe({out: base})
  assert.ok(ts.lang === 'ts' && ts.file === join(base, 'sample.probe.ts') && existsSync(ts.file))
  const tsText = readFileSync(ts.file, 'utf8')
  assert.match(tsText, /import \{defineModel\} from 'stopbar\/probe'/)
  assert.match(tsText, /name: 'sample'/)
  assert.match(tsText, /M1_allowDuplicates[\s\S]*M2_removeKeeps/)
  assert.match(tsText, /Zero false positives/)
  assert.match(ts.command, /^stopbar probe --target .*sample\.probe\.ts --check-mutants$/)
  const py = initProbe({lang: 'py', name: 'cart_2', out: base})
  assert.ok(py.file === join(base, 'cart_2_probe.py') && existsSync(py.file))
  const pyText = readFileSync(py.file, 'utf8')
  assert.match(pyText, /^import json\nimport random\nimport sys$/m)
  assert.doesNotMatch(pyText.replace(/^import (json|random|sys)$/gm, ''), /^\s*(import|from) /m, 'standard library only: json, random, sys')
  assert.match(pyText, /NAME = "cart_2"/)
  assert.match(py.command, /^stopbar probe --cmd "python3? .*cart_2_probe\.py" --check-mutants$/)
  assert.throws(() => initProbe({out: base}), (e: Error) => e instanceof ProbeError && /exists; pass --force/.test(e.message))
  writeFileSync(ts.file, 'changed\n')
  initProbe({out: base, force: true})
  assert.equal(readFileSync(ts.file, 'utf8'), tsText)
  assert.throws(() => initProbe({lang: 'go', out: base}), (e: Error) => e instanceof ProbeError && /--lang must be ts or py/.test(e.message))
  for (const name of ['../evil', '..', 'a/b', 'a\\b', '.hidden', '', '1abc', 'x'.repeat(65), 'a b'])
    assert.throws(() => initProbe({name, out: base}), (e: Error) => e instanceof ProbeError && /--name/.test(e.message), name)
  assert.ok(!existsSync(join(TMP, 'evil.probe.ts')) && !existsSync(join(base, '..', 'evil.probe.ts')))
  // --out is relative to --repo, else to the current directory
  const repo = join(TMP, 'init-repo'); mkdirSync(repo, {recursive: true})
  assert.equal(initProbe({repo, cwd: TMP}).file, join(repo, 'probes', 'sample.probe.ts'))
})
