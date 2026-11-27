// stopbar/probe: the SDK for PROBE targets of any TS/JS project. A target describes a model as a list of actions
// (each with a generator of pure JSON data and a run that drives the real thing and checks it), invariants that hold
// after every step, and optional mutants (a damaged system under test) that the prober must catch.
// `stopbar probe --target <file>` loads the file (default export or export `target`) and runs it as any other target.
// This module has no imports besides node:util, so its source ships as the type declaration of `stopbar/probe`.
import {isDeepStrictEqual} from 'node:util'

// ---------------------------------------------------------------- the target contract (shared with the runner)
export type Mismatch = {step: number; action: unknown; what: string; expected: unknown; actual: unknown}
export type Outcome = {ok: true; steps: number; hooks?: number; cov: Record<string, number>} | {ok: false; mismatch: Mismatch}
export type ProbeRun = {seed: number; actions: unknown[]}
export interface ProbeTarget<R extends ProbeRun> {
  name: string
  description: string
  /** Names of the mutants `execute` accepts as its third argument (for `stopbar probe --check-mutants`). */
  mutants?: string[]
  generate(seed: number): R
  /** Runs `run` in the empty scratch directory `dir` (against `mutant` if given); never throws for a mismatch, returns it. */
  execute(run: R, dir: string, mutant?: string): Promise<Outcome>
}

// ---------------------------------------------------------------- deterministic random numbers
export interface Rng {
  /** A number in [0, 1). */
  next(): number
  /** An integer in [min, max], both included. */
  int(min: number, max: number): number
  /** true with probability p (default 0.5). */
  bool(p?: number): boolean
  pick<T>(xs: readonly T[]): T
  /** A value chosen by weight (default weight 1). */
  weighted<T>(xs: readonly {weight?: number; value: T}[]): T
}

/** xorshift32 on 32-bit integer arithmetic only: the same seed gives the same numbers on every platform. */
export function createRng(seed: number): Rng {
  if (!Number.isFinite(seed)) throw new TypeError(`createRng: seed must be a finite number, got ${seed}`)
  let x = Math.imul(Math.trunc(seed) | 0, 0x9e3779b1) >>> 0 || 7
  const next = () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 2 ** 32 }
  const int = (min: number, max: number) => {
    if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || max < min) throw new RangeError(`rng.int: need integers min <= max, got ${min}, ${max}`)
    return min + Math.floor(next() * (max - min + 1))
  }
  return {
    next, int,
    bool: (p = 0.5) => next() < p,
    pick: <T>(xs: readonly T[]): T => {
      if (!xs.length) throw new RangeError('rng.pick: empty list')
      return xs[Math.floor(next() * xs.length)]
    },
    weighted: <T>(xs: readonly {weight?: number; value: T}[]): T => {
      const w = xs.map((e) => e.weight ?? 1)
      if (w.some((v) => !Number.isFinite(v) || v < 0)) throw new RangeError('rng.weighted: weights must be finite numbers >= 0')
      const total = w.reduce((s, v) => s + v, 0)
      if (!(total > 0)) throw new RangeError('rng.weighted: no value with a weight > 0')
      let r = next() * total
      for (let i = 0; i < xs.length; i++) { if (w[i] > 0 && r < w[i]) return xs[i].value; r -= w[i] }
      for (let i = xs.length - 1; ; i--) if (w[i] > 0) return xs[i].value // rounding at the upper end
    },
  }
}

// ---------------------------------------------------------------- checks
/** Thrown by a failed check; `execute` turns it into `{ok: false, mismatch}` with the step and the action. */
export class MismatchError extends Error {
  what: string
  expected: unknown
  actual: unknown
  constructor(what: string, expected: unknown, actual: unknown) {
    super(`${what}: expected ${show(expected)}, actual ${show(actual)}`)
    this.name = 'MismatchError'
    this.what = what; this.expected = expected; this.actual = actual
  }
}

export interface Check {
  /** Fails when `cond` is falsy. `actual` and `expected` (optional) go into the report. */
  ok(what: string, cond: unknown, actual?: unknown, expected?: unknown): void
  /** Fails unless `actual` and `expected` are deeply and strictly equal (node:util isDeepStrictEqual). */
  eq(what: string, actual: unknown, expected: unknown): void
  fail(what: string, expected: unknown, actual: unknown): never
}

export const check: Check = {
  ok(what, cond, ...rest: unknown[]) {
    if (!cond) throw new MismatchError(what, rest.length >= 2 ? rest[1] : 'truthy', rest.length >= 1 ? rest[0] : cond)
  },
  eq(what, actual, expected) { if (!isDeepStrictEqual(actual, expected)) throw new MismatchError(what, expected, actual) },
  fail(what, expected, actual): never { throw new MismatchError(what, expected, actual) },
}

function show(v: unknown): string {
  try { return JSON.stringify(v, jsonSafe) ?? String(v) } catch { return String(v) }
}
function jsonSafe(_k: string, v: unknown) {
  if (typeof v === 'bigint') return `${v}n`
  if (v instanceof Map) return {Map: [...v.entries()]}
  if (v instanceof Set) return {Set: [...v.values()]}
  if (typeof v === 'function' || typeof v === 'symbol') return String(v)
  return v
}
/** Values of a mismatch travel as JSON between processes: make them plain data (BigInt, Map, Set, cycles). */
function plain(v: unknown): unknown {
  if (v === undefined) return undefined
  try { const s = JSON.stringify(v, jsonSafe); return s === undefined ? String(v) : JSON.parse(s) } catch { return String(v) }
}
function errorText(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`
  return `thrown ${show(e)}`
}

// ---------------------------------------------------------------- defineModel
type Ctx = {seed: number; dir: string; mutant?: string}
type Awaitable<T> = T | Promise<T>
export type ActionSpec<S> = {
  name: string
  /** Relative frequency (default 1). */
  weight?: number
  /** Arguments of one step: pure data that survives JSON (saved in reproductions and regressions). */
  gen(r: Rng): unknown
  run(state: S, args: unknown, check: Check): Awaitable<void>
}
export type Invariant<S> = ((state: S, check: Check) => Awaitable<void>) | {name: string; check(state: S, check: Check): Awaitable<void>}
export type MutantSpec<S> = ((ctx: {seed: number; dir: string}) => Awaitable<S>) | {description?: string; setup(ctx: {seed: number; dir: string}): Awaitable<S>}
export type ModelSpec<S> = {
  name: string
  description: string
  /** Steps per generated run (defaults 15 and 40). */
  minSteps?: number
  maxSteps?: number
  setup(ctx: Ctx): Awaitable<S>
  /** Called in `finally` after every run whose setup returned, also after a failure. */
  teardown?(state: S, ctx: Ctx): Awaitable<void>
  actions: ActionSpec<S>[]
  /** Checked after setup (step -1) and after every step. */
  invariants?: Invariant<S>[]
  /** Each mutant replaces `setup` with a damaged system under test; the prober must find a mismatch on it. */
  mutants?: Record<string, MutantSpec<S>>
}
export type ModelStep = {t: string; args?: unknown}
export type ModelRun = {seed: number; actions: ModelStep[]}

const NAT = (n: unknown) => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0

export function defineModel<S>(spec: ModelSpec<S>): ProbeTarget<ModelRun> & {mutants: string[]} {
  const bad = (why: string): never => { throw new TypeError(`defineModel(${JSON.stringify(spec?.name)}): ${why}`) }
  if (!spec || typeof spec !== 'object') bad('spec must be an object')
  if (typeof spec.name !== 'string' || !spec.name) bad('name must be a non-empty string')
  if (typeof spec.description !== 'string') bad('description must be a string')
  if (typeof spec.setup !== 'function') bad('setup must be a function')
  if (spec.teardown !== undefined && typeof spec.teardown !== 'function') bad('teardown must be a function')
  if (!Array.isArray(spec.actions) || !spec.actions.length) bad('actions must be a non-empty array')
  const byName = new Map<string, ActionSpec<S>>()
  for (const a of spec.actions) {
    if (!a || typeof a.name !== 'string' || !a.name || typeof a.gen !== 'function' || typeof a.run !== 'function') bad('every action needs a name, gen(r) and run(state, args, check)')
    if (byName.has(a.name)) bad(`action ${JSON.stringify(a.name)} is defined twice`)
    if (a.weight !== undefined && !(Number.isFinite(a.weight) && a.weight >= 0)) bad(`action ${a.name}: weight must be a number >= 0`)
    byName.set(a.name, a)
  }
  if (!spec.actions.some((a) => (a.weight ?? 1) > 0)) bad('at least one action needs a weight > 0')
  const minSteps = spec.minSteps ?? 15, maxSteps = spec.maxSteps ?? 40
  if (!NAT(minSteps) || !NAT(maxSteps) || minSteps > maxSteps) bad('minSteps and maxSteps must be integers with 0 <= minSteps <= maxSteps')
  const invariants = (spec.invariants ?? []).map((inv, i) => {
    if (typeof inv === 'function') return {name: '', check: inv}
    if (inv && typeof inv.check === 'function' && typeof inv.name === 'string') return inv
    return bad(`invariant ${i} must be a function or {name, check}`)
  })
  const mutants = new Map<string, (ctx: {seed: number; dir: string}) => Awaitable<S>>()
  for (const [name, m] of Object.entries(spec.mutants ?? {})) {
    if (typeof m === 'function') mutants.set(name, m)
    else if (m && typeof m.setup === 'function') mutants.set(name, (ctx) => m.setup(ctx))
    else bad(`mutant ${name} must be a setup function or {setup}`)
  }
  const weighted = spec.actions.map((a) => ({weight: a.weight ?? 1, value: a}))

  return {
    name: spec.name,
    description: spec.description,
    mutants: [...mutants.keys()],
    generate(seed: number): ModelRun {
      const r = createRng(seed)
      const n = r.int(minSteps, maxSteps)
      const actions: ModelStep[] = []
      for (let i = 0; i < n; i++) {
        const a = r.weighted(weighted)
        const args = a.gen(r)
        // the run in memory must equal its JSON copy (a saved reproduction replays exactly what was found)
        actions.push(args === undefined ? {t: a.name} : {t: a.name, args: JSON.parse(JSON.stringify(args))})
      }
      return {seed, actions}
    },
    async execute(run: ModelRun, dir: string, mutant?: string): Promise<Outcome> {
      const ctx: Ctx = mutant === undefined ? {seed: run.seed, dir} : {seed: run.seed, dir, mutant}
      const cov: Record<string, number> = {}
      let step = -1, action: unknown = null, state: S | undefined, ready = false
      const mismatch = (e: unknown, prefix = ''): Outcome => e instanceof MismatchError
        ? {ok: false, mismatch: {step, action, what: prefix + e.what, expected: plain(e.expected), actual: plain(e.actual)}}
        : {ok: false, mismatch: {step, action, what: prefix ? `${prefix}exception` : 'exception', expected: 'no error', actual: errorText(e)}}
      const checkAll = async () => {
        for (const inv of invariants) {
          try { await inv.check(state as S, check) } catch (e) { throw new Tagged(e, inv.name ? `invariant ${inv.name}: ` : '') }
        }
      }
      let out: Outcome
      try {
        let setup: (c: Ctx) => Awaitable<S> = spec.setup
        if (mutant !== undefined) {
          const m = mutants.get(mutant)
          if (!m) throw new MismatchError('unknown mutant', [...mutants.keys()], mutant)
          setup = m
        }
        state = await setup(mutant === undefined ? ctx : {seed: run.seed, dir})
        ready = true
        await checkAll()
        for (let i = 0; i < run.actions.length; i++) {
          step = i; action = run.actions[i]
          const a = run.actions[i] as ModelStep
          const def = a && typeof a === 'object' ? byName.get(a.t) : undefined
          if (!def) throw new MismatchError('unknown action', [...byName.keys()], a)
          cov[def.name] = (cov[def.name] ?? 0) + 1
          await def.run(state as S, a.args, check)
          await checkAll()
        }
        out = {ok: true, steps: run.actions.length, cov}
      } catch (e) {
        out = e instanceof Tagged ? mismatch(e.cause, e.prefix) : mismatch(e)
      }
      if (ready && spec.teardown) {
        try { await spec.teardown(state as S, ctx) } catch (e) { if (out.ok) out = mismatch(e, 'teardown: ') }
      }
      return out
    },
  }
}

/** An error from an invariant, with the invariant's name for the report. */
class Tagged {
  cause: unknown
  prefix: string
  constructor(cause: unknown, prefix: string) { this.cause = cause; this.prefix = prefix }
}
