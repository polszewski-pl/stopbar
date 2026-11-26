// PROBE: stateful probing with a reference model. A target generates runs (a seed and a list of actions, pure data),
// executes them against the real thing and compares every step with its model. The runner spreads seeds over worker
// processes, replays saved regressions, shrinks a failing run to a minimal one and writes it as JSON.
// v1.0 has one target, "wrapper" (the Stopbar hooks themselves). New targets register in TARGETS; the CLI stays
// `stopbar probe --target <name>`.
import {spawn} from 'node:child_process'
import {existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
import {availableParallelism, tmpdir} from 'node:os'
import {join} from 'node:path'
import {PKG_ROOT} from '../pkg.ts'
import {findRepo} from '../repo.ts'

export type Mismatch = {step: number; action: unknown; what: string; expected: unknown; actual: unknown}
export type Outcome = {ok: true; steps: number; hooks: number; cov: Record<string, number>} | {ok: false; mismatch: Mismatch}
export type ProbeRun = {seed: number; actions: unknown[]}
export interface ProbeTarget<R extends ProbeRun> {
  name: string
  description: string
  generate(seed: number): R
  /** Runs `run` in the empty scratch directory `dir`; never throws for a mismatch, returns it. */
  execute(run: R, dir: string): Promise<Outcome>
}

export const TARGETS: Record<string, () => Promise<ProbeTarget<any>>> = {
  wrapper: async () => (await import('./wrapper.ts')).wrapperTarget,
}

/** Delta debugging by single deletions: the shortest sequence that still fails the same way. */
export async function shrink<R extends ProbeRun>(t: ProbeTarget<R>, run: R, dir: string, what: string): Promise<R> {
  let cur = run
  const fails = async (r: R) => { const x = await t.execute(r, dir); return !x.ok && x.mismatch.what === what }
  const end = await t.execute(cur, dir)
  if (!end.ok) cur = {...cur, actions: cur.actions.slice(0, end.mismatch.step + 1)}
  for (let changed = true; changed;) {
    changed = false
    for (let i = cur.actions.length - 1; i >= 0; i--) {
      const cand = {...cur, actions: cur.actions.filter((_, j) => j !== i)}
      if (cand.actions.length && await fails(cand)) { cur = cand; changed = true }
    }
  }
  return cur
}

type Part = {target: string; seeds: number[]; regs: string[]; work: string}

/** Worker process: runs its share and prints one JSON line with the results. */
export async function worker(p: Part) {
  const t = await TARGETS[p.target]()
  const res: unknown[] = []
  for (const f of p.regs) {
    const run = JSON.parse(readFileSync(f, 'utf8')).run
    const dir = join(p.work, `reg-${run.seed}-${process.pid}`)
    res.push({regression: f, seed: run.seed, ...(await t.execute(run, dir))})
    rmSync(dir, {recursive: true, force: true, maxRetries: 5})
  }
  for (const seed of p.seeds) {
    const run = t.generate(seed)
    const dir = join(p.work, `run-${seed}`)
    const x = await t.execute(run, dir)
    if (!x.ok) {
      const min = await shrink(t, run, dir, x.mismatch.what)
      const again = await t.execute(min, dir)
      res.push({seed, ...x, minimal: min, minimalMismatch: again.ok ? null : again.mismatch})
    } else res.push({seed, ...x})
    rmSync(dir, {recursive: true, force: true, maxRetries: 5})
  }
  process.stdout.write(JSON.stringify(res) + '\n')
}

export type ProbeOptions = {target?: string; runs?: number; seed?: number; jobs?: number; work?: string; out?: string; regressions?: string; regressionsOnly?: boolean; log?: (s: string) => void}

function defaultWork(): string {
  try { return join(findRepo(process.cwd()).gitDir, 'stopbar', 'probe') } catch { return join(tmpdir(), `stopbar-probe-${process.pid}`) }
}

export async function probe(o: ProbeOptions = {}) {
  const log = o.log ?? ((s: string) => process.stdout.write(s + '\n'))
  const target = o.target ?? 'wrapper'
  if (!TARGETS[target]) throw new Error(`unknown probe target ${JSON.stringify(target)}; known: ${Object.keys(TARGETS).join(', ')}`)
  const t = await TARGETS[target]()
  const runs = o.runs ?? 200, seed0 = o.seed ?? 1
  const jobs = Math.max(1, o.jobs ?? Math.min(16, Math.max(1, availableParallelism() - 2)))
  const work = o.work ?? defaultWork(), out = o.out ?? join(work, 'out')
  const regDir = o.regressions ?? join(PKG_ROOT, 'tests', 'regressions')
  const regs = existsSync(regDir) ? readdirSync(regDir).filter((f) => f.endsWith('.json')).map((f) => join(regDir, f)) : []
  const seeds = o.regressionsOnly ? [] : Array.from({length: runs}, (_, i) => seed0 + i)
  mkdirSync(work, {recursive: true}); mkdirSync(out, {recursive: true})
  for (const f of readdirSync(work)) if (/^(run|reg)-/.test(f)) rmSync(join(work, f), {recursive: true, force: true, maxRetries: 5})
  for (const f of readdirSync(out)) if (/^repro-\d+\.json$/.test(f)) rmSync(join(out, f))
  log(`probe ${target}: ${t.description}; ${seeds.length} random runs + ${regs.length} regression(s), ${jobs} jobs`)
  const t0 = Date.now()
  const parts: Part[] = Array.from({length: jobs}, () => ({target, seeds: [], regs: [], work}))
  seeds.forEach((s, i) => parts[i % jobs].seeds.push(s))
  regs.forEach((f, i) => parts[i % jobs].regs.push(f))
  const results = (await Promise.all(parts.filter((p) => p.seeds.length || p.regs.length).map((p) => new Promise<any[]>((ok, bad) => {
    const ch = spawn(process.execPath, [join(PKG_ROOT, 'bin', 'stopbar.mjs'), 'probe', '--worker', JSON.stringify(p)], {stdio: ['ignore', 'pipe', 'inherit']})
    let s = ''
    ch.stdout.on('data', (d) => { s += d })
    ch.on('exit', (code) => { try { ok(JSON.parse(s.trim().split('\n').pop()!)) } catch { bad(new Error(`probe worker exit ${code}: ${s.slice(0, 500)}`)) } })
  })))).flat()
  const failed = results.filter((r) => !r.ok)
  for (const f of failed) {
    const file = join(out, `repro-${f.seed}.json`)
    writeFileSync(file, JSON.stringify({target, found: new Date().toISOString(), mismatch: f.minimalMismatch ?? f.mismatch, run: f.minimal ?? t.generate(f.seed)}, null, 1) + '\n')
    log(`FAIL seed ${f.seed}${f.regression ? ' (regression ' + f.regression + ')' : ''}: ${f.mismatch.what} at step ${f.mismatch.step} ${JSON.stringify(f.mismatch.action)}\n  expected ${JSON.stringify(f.mismatch.expected)}\n  actual   ${JSON.stringify(f.mismatch.actual)}\n  minimal reproduction (${(f.minimal?.actions ?? []).length} steps): ${file}`)
  }
  const ok = results.filter((r) => r.ok && !r.regression)
  const coverage: Record<string, number> = {}
  for (const r of ok) for (const [k, v] of Object.entries(r.cov as Record<string, number>)) coverage[k] = (coverage[k] ?? 0) + v
  const summary = {target, runs: seeds.length, regressions: regs.length, passed: results.filter((r) => r.ok).length, failed: failed.length,
    steps: ok.reduce((s, r) => s + r.steps, 0), hookCalls: ok.reduce((s, r) => s + r.hooks, 0), seeds: seeds.length ? `${seed0}..${seed0 + seeds.length - 1}` : '-',
    jobs, seconds: Math.round((Date.now() - t0) / 1000), coverage}
  writeFileSync(join(out, 'summary.json'), JSON.stringify(summary, null, 1) + '\n')
  log(`PROBE ${failed.length ? 'FAIL' : 'PASS'}: ${summary.passed}/${seeds.length + regs.length} sequences (${summary.runs} random, ${summary.regressions} regression), ` +
    `${summary.steps} steps, ${summary.hookCalls} hook calls, ${summary.seconds} s, ${jobs} jobs\n  coverage ${JSON.stringify(coverage)}`)
  for (const f of readdirSync(work)) if (/^(run|reg)-/.test(f)) rmSync(join(work, f), {recursive: true, force: true, maxRetries: 5})
  return {ok: failed.length === 0, summary}
}
