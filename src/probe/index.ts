// PROBE: stateful probing with a reference model. A target generates runs (a seed and a list of actions, pure data),
// executes them against the real thing and compares every step with its model. The runner spreads seeds over worker
// processes, replays saved regressions, shrinks a failing run to a minimal one and writes it as JSON.
// Targets: "wrapper" (the Stopbar hooks themselves, in TARGETS) or a file of any TS/JS project
// (`stopbar probe --target path/to/x.probe.ts`, usually written with defineModel from `stopbar/probe`).
// With --check-mutants every mutant the target declares must be caught; a result is recorded in events.jsonl.
import {spawn} from 'node:child_process'
import {createHash} from 'node:crypto'
import {existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
import {availableParallelism, tmpdir} from 'node:os'
import {isAbsolute, join, relative, resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
import {PKG_ROOT} from '../pkg.ts'
import {findRepo, snapshot} from '../repo.ts'
import {appendEvent, paths, readConfig, readState, withLock} from '../store.ts'
import type {Outcome, ProbeRun, ProbeTarget} from './sdk.ts'

export type {Mismatch, Outcome, ProbeRun, ProbeTarget} from './sdk.ts'

export const TARGETS: Record<string, () => Promise<ProbeTarget<any>>> = {
  wrapper: async () => (await import('./wrapper.ts')).wrapperTarget,
}

/** A refusal of the user's input (unknown file, bad export, no mutants): the CLI exits 1 with the message. */
export class ProbeError extends Error {}

const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex')

function isTarget(x: any): x is ProbeTarget<any> {
  return !!x && typeof x === 'object' && typeof x.name === 'string' && !!x.name && typeof x.description === 'string' &&
    typeof x.generate === 'function' && typeof x.execute === 'function' &&
    (x.mutants === undefined || (Array.isArray(x.mutants) && x.mutants.every((m: unknown) => typeof m === 'string')))
}

export type Resolved = {t: ProbeTarget<any>; spec: string; file: string | null; sha256: string | null}

/** A name in TARGETS, else a .ts/.mts/.js/.mjs file (absolute, or relative to `cwd`, then to `repo`) that exports a
 *  ProbeTarget as `default` or as `target`. */
export async function loadTarget(spec: string, cwd = process.cwd(), repo?: string): Promise<Resolved> {
  if (Object.hasOwn(TARGETS, spec)) return {t: await TARGETS[spec](), spec, file: null, sha256: null}
  const cands = isAbsolute(spec) ? [spec] : [resolve(cwd, spec), ...(repo ? [resolve(repo, spec)] : [])]
  const file = cands.find((f) => existsSync(f))
  if (!file) throw new ProbeError(`probe target ${JSON.stringify(spec)} is neither a known target (${Object.keys(TARGETS).join(', ')}) nor an existing file`)
  if (!/\.(ts|mts|js|mjs)$/.test(file)) throw new ProbeError(`probe target ${file}: the file must end in .ts, .mts, .js or .mjs`)
  let mod: any
  try { mod = await import(pathToFileURL(file).href) } catch (e) {
    throw new ProbeError(`probe target ${file} does not load: ${(e as Error)?.message ?? e}`)
  }
  const t = isTarget(mod?.default) ? mod.default : isTarget(mod?.target) ? mod.target : null
  if (!t) throw new ProbeError(`probe target ${file} has no valid export: export default (or export const target) an object with name, description, generate(seed) and execute(run, dir), e.g. defineModel({...}) from 'stopbar/probe'`)
  return {t, spec: file, file, sha256: sha(readFileSync(file))}
}

/** Every execute starts in an empty scratch directory. */
async function exec<R extends ProbeRun>(t: ProbeTarget<R>, run: R, dir: string, mutant?: string): Promise<Outcome> {
  rmSync(dir, {recursive: true, force: true, maxRetries: 5}); mkdirSync(dir, {recursive: true})
  return mutant === undefined ? t.execute(run, dir) : t.execute(run, dir, mutant)
}

/** Delta debugging: the shortest sequence that still fails the same way (same `what`). Deterministic order.
 *  0: cut after the failing step; 1: remove blocks of len/2, len/4, ... (>= 2), from the largest again after every
 *  success; 2: single deletions from the end, to a fixed point. */
export async function shrink<R extends ProbeRun>(t: ProbeTarget<R>, run: R, dir: string, what: string): Promise<R> {
  let cur = run
  const fails = async (r: R) => { const x = await exec(t, r, dir); return !x.ok && x.mismatch.what === what }
  const end = await exec(t, cur, dir)
  if (!end.ok) cur = {...cur, actions: cur.actions.slice(0, end.mismatch.step + 1)}
  phase1: while (cur.actions.length > 2) {
    for (let size = Math.floor(cur.actions.length / 2); size >= 2; size = Math.floor(size / 2)) {
      for (let at = 0; at < cur.actions.length; at += size) {
        const cand = {...cur, actions: [...cur.actions.slice(0, at), ...cur.actions.slice(at + size)]}
        if (cand.actions.length && await fails(cand)) { cur = cand; continue phase1 }
      }
    }
    break
  }
  for (let changed = true; changed;) {
    changed = false
    for (let i = cur.actions.length - 1; i >= 0; i--) {
      const cand = {...cur, actions: cur.actions.filter((_, j) => j !== i)}
      if (cand.actions.length && await fails(cand)) { cur = cand; changed = true }
    }
  }
  return cur
}

type Part = {target: string; seeds: number[]; regs: string[]; work: string; mutant?: string}

/** Worker process: runs its share and prints one JSON line with the results. With `mutant` it runs the seeds in order
 *  against that mutant and stops at the first one that fails (no shrinking). */
export async function worker(p: Part) {
  const {t} = await loadTarget(p.target)
  const res: unknown[] = []
  if (p.mutant !== undefined) {
    let tried = 0
    for (const seed of p.seeds) {
      tried++
      const dir = join(p.work, `mut-${process.pid}-${seed}`)
      const x = await exec(t, t.generate(seed), dir, p.mutant)
      rmSync(dir, {recursive: true, force: true, maxRetries: 5})
      if (!x.ok) { res.push({mutant: p.mutant, killed: true, seed, tried, mismatch: x.mismatch}); break }
    }
    if (!res.length) res.push({mutant: p.mutant, killed: false, tried})
    process.stdout.write(JSON.stringify(res) + '\n')
    return
  }
  for (const f of p.regs) {
    const run = JSON.parse(readFileSync(f, 'utf8')).run
    const dir = join(p.work, `reg-${run.seed}-${process.pid}`)
    const x = await exec(t, run, dir)
    res.push({regression: f, seed: run.seed, ...x, ...(x.ok ? {} : {run})})
    rmSync(dir, {recursive: true, force: true, maxRetries: 5})
  }
  for (const seed of p.seeds) {
    const run = t.generate(seed)
    const dir = join(p.work, `run-${seed}`)
    const x = await exec(t, run, dir)
    if (!x.ok) {
      const min = await shrink(t, run, dir, x.mismatch.what)
      const again = await exec(t, min, dir)
      res.push({seed, ...x, minimal: min, minimalMismatch: again.ok ? null : again.mismatch})
    } else res.push({seed, ...x})
    rmSync(dir, {recursive: true, force: true, maxRetries: 5})
  }
  process.stdout.write(JSON.stringify(res) + '\n')
}

export type ProbeOptions = {target?: string; runs?: number; seed?: number; jobs?: number; work?: string; out?: string; regressions?: string; regressionsOnly?: boolean
  checkMutants?: boolean; mutantRuns?: number; repo?: string; record?: boolean; log?: (s: string) => void}

/** <git-dir>/stopbar/probe in a repository with Stopbar, else a temporary directory (a project without Stopbar gets
 *  no .git/stopbar from the prober). */
function defaultWork(dir: string): string {
  try { const r = findRepo(dir); if (existsSync(r.stateDir)) return join(r.stateDir, 'probe') } catch { /* not a git repository */ }
  return join(tmpdir(), `stopbar-probe-${process.pid}`)
}

function spawnWorker(p: Part): Promise<any[]> {
  return new Promise<any[]>((ok, bad) => {
    const ch = spawn(process.execPath, [join(PKG_ROOT, 'bin', 'stopbar.mjs'), 'probe', '--worker', JSON.stringify(p)], {stdio: ['ignore', 'pipe', 'inherit']})
    let s = ''
    ch.stdout.on('data', (d) => { s += d })
    ch.on('exit', (code) => { try { ok(JSON.parse(s.trim().split('\n').pop()!)) } catch { bad(new Error(`probe worker exit ${code}: ${s.slice(0, 500)}`)) } })
  })
}

/** At most `jobs` promises at a time; results in input order. */
async function pool<T, U>(xs: T[], jobs: number, f: (x: T) => Promise<U>): Promise<U[]> {
  const out: U[] = new Array(xs.length)
  let next = 0
  await Promise.all(Array.from({length: Math.min(jobs, xs.length)}, async () => { while (next < xs.length) { const i = next++; out[i] = await f(xs[i]) } }))
  return out
}

/** A saved reproduction or regression: JSON with a run of actions (summary.json and other files are skipped). */
function isRegression(f: string): boolean {
  try { const j = JSON.parse(readFileSync(f, 'utf8')); return !!j?.run && Array.isArray(j.run.actions) && typeof j.run.seed === 'number' } catch { return false }
}

export async function probe(o: ProbeOptions = {}) {
  const log = o.log ?? ((s: string) => process.stdout.write(s + '\n'))
  const repoDir = o.repo ?? process.cwd()
  const R = await loadTarget(o.target ?? 'wrapper', process.cwd(), o.repo)
  const t = R.t
  const mutantNames = t.mutants ?? []
  if (o.checkMutants && !mutantNames.length) throw new ProbeError(`--check-mutants: target ${t.name} declares no mutants (add mutants: {...} to defineModel, or drop --check-mutants)`)
  const runs = o.runs ?? 200, seed0 = o.seed ?? 1, mutantRuns = o.mutantRuns ?? 50
  if (o.checkMutants && mutantRuns < 1) throw new ProbeError('--mutant-runs must be at least 1')
  const jobs = Math.max(1, o.jobs ?? Math.min(16, Math.max(1, availableParallelism() - 2)))
  const work = o.work ?? defaultWork(repoDir), out = o.out ?? join(work, 'out')
  // a file target replays only the regressions the user names; the wrapper also has Stopbar's own
  const regDir = o.regressions ?? (R.file ? null : join(PKG_ROOT, 'tests', 'regressions'))
  const regs = regDir && existsSync(regDir) ? readdirSync(regDir).filter((f) => f.endsWith('.json')).sort().map((f) => join(regDir, f)).filter(isRegression) : []
  const seeds = o.regressionsOnly ? [] : Array.from({length: runs}, (_, i) => seed0 + i)
  mkdirSync(work, {recursive: true}); mkdirSync(out, {recursive: true})
  for (const f of readdirSync(work)) if (/^(run|reg|mut)-/.test(f)) rmSync(join(work, f), {recursive: true, force: true, maxRetries: 5})
  // old reproductions go, unless they are the regressions of this run
  if (!regDir || resolve(regDir) !== resolve(out)) for (const f of readdirSync(out)) if (/^repro-\d+\.json$/.test(f)) rmSync(join(out, f))
  const targetPath = R.file ? relPath(repoDir, R.file) : t.name
  log(`probe ${t.name}: ${t.description}; ${seeds.length} random runs + ${regs.length} regression(s), ${jobs} jobs${R.sha256 ? `\n  target ${R.file} sha256 ${R.sha256}` : ''}`)
  const t0 = Date.now()
  const parts: Part[] = Array.from({length: jobs}, () => ({target: R.spec, seeds: [], regs: [], work}))
  seeds.forEach((s, i) => parts[i % jobs].seeds.push(s))
  regs.forEach((f, i) => parts[i % jobs].regs.push(f))
  const results = (await Promise.all(parts.filter((p) => p.seeds.length || p.regs.length).map(spawnWorker))).flat()
    .sort((a, b) => (a.regression ? 0 : 1) - (b.regression ? 0 : 1) || a.seed - b.seed)
  const failed = results.filter((r) => !r.ok)
  for (const f of failed) {
    const file = join(out, `repro-${f.seed}.json`)
    const run = f.minimal ?? f.run ?? t.generate(f.seed)
    writeFileSync(file, JSON.stringify({target: t.name, ...(R.file ? {targetPath} : {}), found: new Date().toISOString(), mismatch: f.minimalMismatch ?? f.mismatch, run}, null, 1) + '\n')
    log(`FAIL seed ${f.seed}${f.regression ? ' (regression ' + f.regression + ')' : ''}: ${f.mismatch.what} at step ${f.mismatch.step} ${JSON.stringify(f.mismatch.action)}\n  expected ${JSON.stringify(f.mismatch.expected)}\n  actual   ${JSON.stringify(f.mismatch.actual)}\n  ${f.minimal ? 'minimal ' : ''}reproduction (${run.actions.length} steps): ${file}`)
  }
  const ok = results.filter((r) => r.ok && !r.regression)
  const coverage: Record<string, number> = {}
  for (const r of ok) for (const [k, v] of Object.entries(r.cov as Record<string, number>)) coverage[k] = (coverage[k] ?? 0) + v

  // mutants: only on a passing original; each mutant in its own worker, seeds in order, the first failure kills it
  let mutants: {total: number; killed: number; survived: string[]; runsPerMutant: number; details: Record<string, unknown>[]} | null = null
  if (o.checkMutants && failed.length) log(`mutants: not checked, the original fails`)
  else if (o.checkMutants) {
    const mseeds = Array.from({length: mutantRuns}, (_, i) => seed0 + i)
    const res = (await pool(mutantNames, jobs, (m) => spawnWorker({target: R.spec, seeds: mseeds, regs: [], work, mutant: m}))).flat()
    const details = res.map((r) => r.killed
      ? {name: r.mutant, status: 'KILLED', seed: r.seed, step: r.mismatch.step, what: r.mismatch.what, action: r.mismatch.action, runs: r.tried}
      : {name: r.mutant, status: 'SURVIVED', runs: r.tried})
    const survived = details.filter((d) => d.status === 'SURVIVED').map((d) => d.name as string)
    mutants = {total: details.length, killed: details.length - survived.length, survived, runsPerMutant: mutantRuns, details}
    for (const d of details) log(d.status === 'KILLED' ? `  mutant ${d.name}: KILLED at seed ${d.seed}, step ${d.step}: ${d.what} ${JSON.stringify(d.action)}` : `  mutant ${d.name}: SURVIVED ${d.runs} runs`)
    log(`MUTANTS ${survived.length ? 'FAIL' : 'PASS'}: ${mutants.killed}/${mutants.total} killed${survived.length ? `; survived: ${survived.join(', ')}` : ''} (up to ${mutantRuns} runs each)`)
  }

  const passOk = failed.length === 0 && (!mutants || mutants.survived.length === 0)
  const summary = {target: t.name, ...(R.file ? {targetPath} : {}), targetSha256: R.sha256, ok: passOk, runs: seeds.length, regressions: regs.length,
    passed: results.filter((r) => r.ok).length, failed: failed.length,
    steps: ok.reduce((s, r) => s + r.steps, 0), hookCalls: ok.reduce((s, r) => s + (r.hooks ?? 0), 0), seeds: seeds.length ? `${seed0}..${seed0 + seeds.length - 1}` : '-',
    jobs, seconds: Math.round((Date.now() - t0) / 1000), coverage, ...(mutants ? {mutants} : {})}
  const summaryFile = join(out, 'summary.json'), summaryText = JSON.stringify(summary, null, 1) + '\n'
  writeFileSync(summaryFile, summaryText)
  log(`PROBE ${passOk ? 'PASS' : 'FAIL'}: ${summary.passed}/${seeds.length + regs.length} sequences (${summary.runs} random, ${summary.regressions} regression), ` +
    `${summary.steps} steps${summary.hookCalls ? `, ${summary.hookCalls} hook calls` : ''}, ${summary.seconds} s, ${jobs} jobs\n  coverage ${JSON.stringify(coverage)}\n  summary ${summaryFile}`)
  for (const f of readdirSync(work)) if (/^(run|reg|mut)-/.test(f)) rmSync(join(work, f), {recursive: true, force: true, maxRetries: 5})

  const recorded = o.record === false ? null : record(repoDir, {target: t.name, targetPath, targetSha256: R.sha256, runs: summary.runs, regressions: summary.regressions,
    passed: summary.passed, failed: summary.failed, steps: summary.steps, ok: passOk, mutants: mutants ? {killed: mutants.killed, total: mutants.total, survived: mutants.survived} : null,
    summarySha256: sha(summaryText)})
  if (recorded) log(`recorded probe:result in ${recorded}`)
  return {ok: passOk, summary, recorded}
}

const relPath = (repoDir: string, file: string) => {
  let root = repoDir
  try { root = findRepo(repoDir).root } catch { /* not a git repository */ }
  return relative(root, file).replace(/\\/g, '/') || file
}

/** Appends `probe:result` to events.jsonl if `dir` is in a repository with a valid Stopbar config and state. No `req`:
 *  not a kernel step, state.json is not touched. Anything else (no git, no Stopbar, damaged files) records nothing. */
function record(dir: string, entry: Record<string, unknown>): string | null {
  let repo
  try { repo = findRepo(dir) } catch { return null }
  const p = paths(repo)
  if (!existsSync(p.config) || !existsSync(p.state)) return null
  try {
    return withLock(repo, () => {
      readConfig(repo); readState(repo)
      appendEvent(repo, {source: 'probe:result', target: entry.target, targetPath: entry.targetPath, targetSha256: entry.targetSha256, treeSnapshot: snapshot(repo).id,
        ...Object.fromEntries(Object.entries(entry).filter(([k]) => !['target', 'targetPath', 'targetSha256'].includes(k)))})
      return p.events
    })
  } catch { return null }
}
