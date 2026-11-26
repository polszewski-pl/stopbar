import assert from 'node:assert/strict'
import {mkdirSync, rmSync, writeFileSync} from 'node:fs'
import {dirname, join, resolve} from 'node:path'
import {test} from 'node:test'
import {fileURLToPath, pathToFileURL} from 'node:url'
import {ProbeError, loadTarget, shrink} from '../../dist/probe/index.js'
import {createRng, defineModel, MismatchError} from '../../dist/probe/sdk.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const TMP = join(ROOT, '.e2e-tmp', 'unit-probe')
rmSync(TMP, {recursive: true, force: true}); mkdirSync(TMP, {recursive: true})

test('createRng: the same seed gives the same sequence, pinned values (equal on every platform)', () => {
  const a = createRng(7), b = createRng(7), c = createRng(8)
  const xs = Array.from({length: 1000}, () => a.next()), ys = Array.from({length: 1000}, () => b.next())
  assert.deepEqual(xs, ys)
  assert.notDeepEqual(xs.slice(0, 10), Array.from({length: 10}, () => c.next()))
  assert.ok(xs.every((x) => x >= 0 && x < 1))
  const r1 = createRng(1)
  assert.deepEqual([r1.next(), r1.next(), r1.next()], [0.3170971313957125, 0.7506774193607271, 0.866621796740219])
  const r42 = createRng(42)
  assert.equal(Array.from({length: 8}, () => r42.int(0, 9)).join(','), '7,2,6,8,9,9,3,0')
})

test('createRng: int is inclusive, bool, pick and weighted (weight 0 is never chosen)', () => {
  const r = createRng(3)
  const ints = new Set(Array.from({length: 2000}, () => r.int(-2, 2)))
  assert.deepEqual([...ints].sort((a, b) => a - b), [-2, -1, 0, 1, 2])
  assert.ok(Array.from({length: 200}, () => r.bool(0)).every((b) => b === false))
  assert.ok(Array.from({length: 200}, () => r.bool(1)).every((b) => b === true))
  assert.ok(Array.from({length: 200}, () => r.pick(['a', 'b'] as const)).every((x) => x === 'a' || x === 'b'))
  const w = Array.from({length: 2000}, () => r.weighted([{value: 'x', weight: 0}, {value: 'y'}, {value: 'z', weight: 3}]))
  assert.ok(!w.includes('x'))
  const z = w.filter((v) => v === 'z').length
  assert.ok(z > 1300 && z < 1700, `z chosen ${z} of 2000`)
  assert.throws(() => r.int(3, 1), RangeError)
  assert.throws(() => r.pick([]), RangeError)
  assert.throws(() => r.weighted([{value: 1, weight: 0}]), RangeError)
})

type Log = string[]
function counter(log: Log, opts: {bugAt?: number; throwAt?: number; invariantBreaksAt?: number} = {}) {
  return defineModel<{n: number; model: number}>({
    name: 'counter', description: 'a counter', minSteps: 5, maxSteps: 9,
    setup: (ctx) => { log.push(`setup ${ctx.seed}${ctx.mutant ? ' ' + ctx.mutant : ''}`); return {n: 0, model: 0} },
    teardown: (_s, ctx) => { log.push(`teardown ${ctx.seed}`) },
    actions: [
      {name: 'inc', weight: 2, gen: (r) => ({by: r.int(1, 3)}), run: (s, {by}, check) => {
        log.push('inc')
        if (opts.throwAt === s.model) throw new Error('boom')
        s.n += opts.bugAt === s.model ? by + 1 : by; s.model += by
        check.eq('value', s.n, s.model)
      }},
      {name: 'read', gen: () => null, run: (s, _a, check) => { log.push('read'); check.ok('non-negative', s.n >= 0, s.n, '>= 0') }},
    ],
    invariants: [
      (s) => { log.push('inv') ; void s },
      {name: 'limit', check: (s, check) => { if (opts.invariantBreaksAt !== undefined && s.model >= opts.invariantBreaksAt) check.fail('model below limit', `< ${opts.invariantBreaksAt}`, s.model) }},
    ],
    mutants: {
      M_offByOne: () => { log.push('mutant setup'); return {n: 1, model: 0} },
      M_object: {description: 'same as the original', setup: () => ({n: 0, model: 0})},
    },
  })
}

test('defineModel: generate is deterministic, step counts in [minSteps, maxSteps], actions are {t, args} JSON data', () => {
  const t = counter([])
  assert.equal(t.name, 'counter')
  assert.deepEqual(t.mutants, ['M_offByOne', 'M_object'])
  for (let seed = 1; seed <= 50; seed++) {
    const run = t.generate(seed)
    assert.deepEqual(run, t.generate(seed))
    assert.equal(run.seed, seed)
    assert.ok(run.actions.length >= 5 && run.actions.length <= 9, `${run.actions.length} steps`)
    assert.deepEqual(JSON.parse(JSON.stringify(run)), run)
    for (const a of run.actions) assert.ok(a.t === 'inc' ? typeof (a.args as any).by === 'number' : a.t === 'read' && a.args === null)
  }
  const d = defineModel({name: 'd', description: '', setup: () => 0, actions: [{name: 'a', gen: () => undefined, run: () => {}}]})
  const n = d.generate(1).actions.length
  assert.ok(n >= 15 && n <= 40, 'default steps 15..40')
  assert.deepEqual(d.generate(1).actions[0], {t: 'a'})
})

test('defineModel: setup, invariants after setup and after every step, actions, teardown; cov counts actions', async () => {
  const log: Log = []
  const t = counter(log)
  const run = {seed: 5, actions: [{t: 'inc', args: {by: 2}}, {t: 'read', args: null}, {t: 'inc', args: {by: 1}}]}
  const x = await t.execute(run, TMP)
  assert.deepEqual(x, {ok: true, steps: 3, cov: {inc: 2, read: 1}})
  assert.deepEqual(log, ['setup 5', 'inv', 'inc', 'inv', 'read', 'inv', 'inc', 'inv', 'teardown 5'])
})

test('defineModel: a failed check.eq, check.ok, check.fail and an exception become {ok: false, mismatch}; teardown still runs', async () => {
  const log: Log = []
  const eq = await counter(log, {bugAt: 2}).execute({seed: 1, actions: [{t: 'inc', args: {by: 2}}, {t: 'inc', args: {by: 1}}, {t: 'read', args: null}]}, TMP)
  assert.deepEqual(eq, {ok: false, mismatch: {step: 1, action: {t: 'inc', args: {by: 1}}, what: 'value', expected: 3, actual: 4}})
  assert.equal(log.at(-1), 'teardown 1')

  log.length = 0
  const ex = await counter(log, {throwAt: 0}).execute({seed: 2, actions: [{t: 'read', args: null}, {t: 'inc', args: {by: 1}}]}, TMP)
  assert.deepEqual(ex, {ok: false, mismatch: {step: 1, action: {t: 'inc', args: {by: 1}}, what: 'exception', expected: 'no error', actual: 'Error: boom'}})
  assert.equal(log.at(-1), 'teardown 2')

  log.length = 0
  const inv = await counter(log, {invariantBreaksAt: 3}).execute({seed: 3, actions: [{t: 'inc', args: {by: 2}}, {t: 'inc', args: {by: 2}}, {t: 'inc', args: {by: 2}}]}, TMP)
  assert.deepEqual(inv, {ok: false, mismatch: {step: 1, action: {t: 'inc', args: {by: 2}}, what: 'invariant limit: model below limit', expected: '< 3', actual: 4}})
  assert.equal(log.at(-1), 'teardown 3')

  const okT = defineModel({name: 'k', description: '', setup: () => ({}), actions: [{name: 'a', gen: () => 1, run: (_s, _a, check) => check.ok('flag', 0)}]})
  assert.deepEqual(await okT.execute({seed: 1, actions: [{t: 'a', args: 1}]}, TMP), {ok: false, mismatch: {step: 0, action: {t: 'a', args: 1}, what: 'flag', expected: 'truthy', actual: 0}})
  const unknown = await okT.execute({seed: 1, actions: [{t: 'nope'}]}, TMP)
  assert.equal(!unknown.ok && unknown.mismatch.what, 'unknown action')

  // an exception in setup: no teardown (there is no state), step -1
  const bad = defineModel({name: 'b', description: '', setup: () => { throw new TypeError('no db') }, teardown: () => { throw new Error('must not run') },
    actions: [{name: 'a', gen: () => 1, run: () => {}}]})
  assert.deepEqual(await bad.execute({seed: 1, actions: [{t: 'a', args: 1}]}, TMP), {ok: false, mismatch: {step: -1, action: null, what: 'exception', expected: 'no error', actual: 'TypeError: no db'}})
  // an exception in teardown after a passing run is a mismatch, not a crash
  const td = defineModel({name: 'td', description: '', setup: () => 0, teardown: () => { throw new Error('leak') }, actions: [{name: 'a', gen: () => 1, run: () => {}}]})
  const tdx = await td.execute({seed: 1, actions: [{t: 'a', args: 1}]}, TMP)
  assert.equal(!tdx.ok && tdx.mismatch.what, 'teardown: exception')

  assert.throws(() => check0(), MismatchError)
})
const check0 = () => { throw new MismatchError('x', 1, 2) }

test('defineModel: a mutant replaces setup (teardown sees ctx.mutant); an unknown mutant is a mismatch', async () => {
  const log: Log = []
  const t = counter(log)
  const run = {seed: 9, actions: [{t: 'inc', args: {by: 1}}]}
  const x = await t.execute(run, TMP, 'M_offByOne')
  assert.equal(!x.ok && x.mismatch.what, 'value')
  assert.deepEqual(log, ['mutant setup', 'inv', 'inc', 'teardown 9'])
  assert.equal((await t.execute(run, TMP, 'M_object')).ok, true)
  const u = await t.execute(run, TMP, 'M_none')
  assert.equal(!u.ok && u.mismatch.what, 'unknown mutant')
})

test('defineModel refuses a bad spec', () => {
  assert.throws(() => defineModel({name: '', description: '', setup: () => 0, actions: [{name: 'a', gen: () => 1, run: () => {}}]}), TypeError)
  assert.throws(() => defineModel({name: 'x', description: '', setup: () => 0, actions: []}), TypeError)
  assert.throws(() => defineModel({name: 'x', description: '', setup: () => 0, actions: [{name: 'a', gen: () => 1, run: () => {}}, {name: 'a', gen: () => 1, run: () => {}}]}), /twice/)
  assert.throws(() => defineModel({name: 'x', description: '', minSteps: 5, maxSteps: 2, setup: () => 0, actions: [{name: 'a', gen: () => 1, run: () => {}}]}), /minSteps/)
})

test('shrink (chunked): 200 steps where only #17 and #143 together fail -> exactly those 2, with far fewer executes than single deletions', async () => {
  let calls = 0
  const t = {
    name: 'synthetic', description: '', generate: (seed: number) => ({seed, actions: Array.from({length: 200}, (_, i) => i)}),
    async execute(run: {seed: number; actions: number[]}) {
      calls++
      const a = run.actions.indexOf(17), b = run.actions.indexOf(143)
      return a >= 0 && b >= 0 ? {ok: false as const, mismatch: {step: Math.max(a, b), action: run.actions[Math.max(a, b)], what: 'bad', expected: 0, actual: 1}} : {ok: true as const, steps: run.actions.length, cov: {}}
    },
  }
  const dir = join(TMP, 'shrink')
  const min = await shrink(t, t.generate(1), dir, 'bad')
  assert.deepEqual(min.actions, [17, 143])
  const chunked = calls
  // the single-deletion algorithm of 1.1.x, for comparison: cut after the failing step, then single deletions to a fixed point
  calls = 0
  let cur = t.generate(1).actions.slice(0, 144)
  for (let changed = true; changed;) {
    changed = false
    for (let i = cur.length - 1; i >= 0; i--) { const c = cur.filter((_, j) => j !== i); if (c.length && !(await t.execute({seed: 1, actions: c})).ok) { cur = c; changed = true } }
  }
  assert.deepEqual(cur, [17, 143])
  const single = calls + 1
  assert.ok(chunked * 2 < single, `chunked ${chunked} executes, single deletions ${single}`)
  assert.ok(chunked <= 60, `chunked ${chunked} executes`)
  // deterministic: the same input gives the same result and the same number of executes
  calls = 0
  assert.deepEqual((await shrink(t, t.generate(1), dir, 'bad')).actions, [17, 143])
  assert.equal(calls, chunked)
})

test('loadTarget: a known name, a file with default or `target` export, and clear errors', async () => {
  const w = await loadTarget('wrapper')
  assert.equal(w.t.name, 'wrapper'); assert.equal(w.file, null); assert.equal(w.sha256, null)
  const sdk = pathToFileURL(join(ROOT, 'dist', 'probe', 'sdk.js')).href
  writeFileSync(join(TMP, 'named.mjs'), `import {defineModel} from '${sdk}'\nexport const target = defineModel({name: 'named', description: 'd', setup: () => 0, actions: [{name: 'a', gen: () => 1, run: () => {}}]})\n`)
  const n = await loadTarget('named.mjs', TMP)
  assert.equal(n.t.name, 'named'); assert.match(n.sha256!, /^[0-9a-f]{64}$/)
  writeFileSync(join(TMP, 'bad.mjs'), 'export default {name: 1}\n')
  await assert.rejects(loadTarget('bad.mjs', TMP), (e: Error) => e instanceof ProbeError && /no valid export/.test(e.message))
  await assert.rejects(loadTarget('missing.probe.ts', TMP), (e: Error) => e instanceof ProbeError && /neither a known target/.test(e.message))
  writeFileSync(join(TMP, 'x.txt'), '')
  await assert.rejects(loadTarget('x.txt', TMP), (e: Error) => e instanceof ProbeError && /must end in/.test(e.message))
  writeFileSync(join(TMP, 'throws.mjs'), 'throw new Error("broken module")\n')
  await assert.rejects(loadTarget('throws.mjs', TMP), (e: Error) => e instanceof ProbeError && /does not load: broken module/.test(e.message))
})
