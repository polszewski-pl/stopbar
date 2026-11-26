// A PROBE target over the NDJSON protocol of `stopbar probe --cmd`, in plain Node, so the tests need no Python:
// a stack checked against an array, with mutants M1_popBottom and M2_pushTwice.
// Flags: --bug (the original pops the bottom item when it holds 2 or more), and for the error tests, each with the op
// it applies to: --crash <op> (stderr, exit 3), --garbage <op> (a line that is not JSON), --close <op> (closes stdout
// and stays alive), --hang <op> (never answers), --error <op> ({"error": ...}), --bad <op> (an answer of the wrong shape).
import {closeSync} from 'node:fs'
import {createInterface} from 'node:readline'

const flag = (n) => { const i = process.argv.indexOf(`--${n}`); return i < 0 ? undefined : process.argv[i + 1] }
const bug = process.argv.includes('--bug')
const MUTANTS = {M1_popBottom: 'bottom', M2_pushTwice: 'twice'}

/** xorshift32: the same runs on every platform. */
function rng(seed) {
  let x = Math.imul(seed | 0, 0x9e3779b1) >>> 0 || 7
  return (n) => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x % n }
}

function generate(seed) {
  const r = rng(seed), n = 10 + r(16), actions = []
  for (let i = 0; i < n; i++) actions.push(r(3) < 2 ? {t: 'push', args: r(100)} : {t: 'pop', args: null})
  return {seed, actions}
}

function execute(run, mutant) {
  const mode = mutant === undefined ? (bug ? 'bottom' : '') : MUTANTS[mutant]
  if (mode === undefined) return {ok: false, mismatch: {step: -1, action: null, what: 'unknown mutant', expected: Object.keys(MUTANTS), actual: mutant}}
  const items = [], model = [], cov = {}
  for (let step = 0; step < run.actions.length; step++) {
    const a = run.actions[step]
    cov[a.t] = (cov[a.t] ?? 0) + 1
    if (a.t === 'push') {
      items.push(a.args); model.push(a.args)
      if (mode === 'twice' && items.length === 3) items.push(a.args)
    } else {
      const got = (mode === 'bottom' && items.length >= 2 ? items.shift() : items.pop()) ?? null, want = model.pop() ?? null
      if (got !== want) return {ok: false, mismatch: {step, action: a, what: 'pop result', expected: want, actual: got}}
    }
    if (items.length !== model.length) return {ok: false, mismatch: {step, action: a, what: 'invariant size: size', expected: model.length, actual: items.length}}
  }
  return {ok: true, steps: run.actions.length, cov}
}

const out = (v) => process.stdout.write(JSON.stringify(v) + '\n')
const rl = createInterface({input: process.stdin})
rl.on('line', (line) => {
  if (!line.trim()) return
  const req = JSON.parse(line)
  if (flag('crash') === req.op) { process.stderr.write(`boom: crash on ${req.op}\n`); process.exit(3) }
  if (flag('garbage') === req.op) { process.stdout.write('this is not json\n'); return }
  if (flag('close') === req.op) { closeSync(1); setInterval(() => {}, 1000); return }
  if (flag('hang') === req.op) return
  if (flag('error') === req.op) return out({error: `no ${req.op} today`})
  if (flag('bad') === req.op) return out(req.op === 'info' ? {description: 'no name'} : req.op === 'generate' ? {seed: -1, actions: []} : {ok: 'yes'})
  if (req.op === 'info') return out({name: 'ndjson-stack', description: 'a stack vs an array, over NDJSON', mutants: Object.keys(MUTANTS)})
  if (req.op === 'generate') return out(generate(req.seed))
  if (req.op === 'execute') return out(execute(req.run, req.mutant))
  out({error: `unknown op ${req.op}`})
})
rl.on('close', () => { if (flag('close') === undefined) process.exit(0) })
