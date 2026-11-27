// `stopbar prove` (alias `verify`): the inductive proof of src/kernel.ts, the 10 mutants (each must fall with a counterexample run),
// and the link between the proven rule and the step function the hooks run (dist/kernel.gen.js).
// Loads gdp-wired (the prover); hooks never do.
import {createHash} from 'node:crypto'
import {existsSync, readFileSync, writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {pathToFileURL} from 'node:url'
import * as G from './kernel.gen.js'
import {PKG_ROOT} from './pkg.ts'

const OPS = ['EDIT_CODE', 'EDIT_TEST', 'RUN_BUILD', 'RUN_TESTS', 'READ_SECRET', 'SHELL', 'APPROVE_TESTS', 'APPROVE_SHELL', 'RESUME', 'COMMIT']
const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex')

/** Random requests inside the rule's assumption (human actions cost nothing). */
export function randomRequest(rnd: () => number) {
  const op = OPS[Math.floor(rnd() * OPS.length)]
  const human = op === 'APPROVE_TESTS' || op === 'APPROVE_SHELL' || op === 'RESUME'
  const b = () => rnd() < 0.5
  return {op, cost: human ? 0 : Math.floor(rnd() * 4), passed: b(), fullSuite: b(), suspicious: b(), risky: b(), treeChanged: b(),
    approveRev: Math.floor(rnd() * 6), extra: Math.floor(rnd() * 5)}
}
export function lcg(seed: number) { let x = seed >>> 0 || 1; return () => { x = (Math.imul(x, 1103515245) + 12345) >>> 0; return x / 2 ** 32 } }

export async function loadKernel() {
  const k = await import(pathToFileURL(join(PKG_ROOT, 'dist', 'kernel.js')).href)
  const gw = await import('gdp-wired')
  const machine = await import('gdp-wired/machine')
  return {k, gw, machine}
}

export type Generated = {
  machineName: string; machineSha256: string; regeneratedSha256: string; sameMachine: boolean
  kernelSourceSha256: string; kernelSourceNow: string | null; sameSource: boolean | null
  differential: {steps: number; refused: number; mismatches: number}; ok: boolean
}

/** The generated step function is the compileJs output of the unmutated kernel, and it agrees with the interpreter. */
export async function checkGenerated(steps = 3000): Promise<Generated> {
  const {k, machine} = await loadKernel()
  const R = k.kernel('none')
  const js = machine.compileJs(R.machine)
  const src = join(PKG_ROOT, 'src', 'kernel.ts')
  const kernelSha = existsSync(src) ? sha(readFileSync(src)) : null
  const head = {
    machineName: G.MACHINE_NAME, machineSha256: G.MACHINE_SHA256, regeneratedSha256: sha(js),
    sameMachine: sha(js) === G.MACHINE_SHA256 && G.MACHINE_NAME === R.machine.name,
    kernelSourceSha256: G.KERNEL_SOURCE_SHA256, kernelSourceNow: kernelSha, sameSource: kernelSha === null ? null : kernelSha === G.KERNEL_SOURCE_SHA256,
  }
  // differential replay: interpreter of the proven rule vs the generated step, state compared after every step
  const IT = R.interpreter()
  let mismatches = 0, done = 0, refused = 0
  const rnd = lcg(20261126)
  for (let run = 0; done < steps; run++) {
    const params = {maxRetries: 1 + Math.floor(rnd() * 3), cap: 1 + Math.floor(rnd() * 12)}
    const P = R.encodeParams(params)
    let a = IT.init(P), b = G.init(params)
    for (let i = 0; i < 25 && done < steps; i++, done++) {
      const req = randomRequest(rnd)
      const enc = R.encodeInput(req, params)
      let ea: unknown = null, eb: unknown = null
      try { a = IT.step(P, a, enc) } catch (e) { ea = e }
      try { b = G.step(params, G.fork(b), enc) } catch (e) { eb = e }
      if (ea || eb) { refused++; if (!ea !== !eb) mismatches++; break }
      if (JSON.stringify(a.scalars) !== JSON.stringify(b.scalars)) { mismatches++; break }
    }
  }
  return {...head, differential: {steps: done, refused, mismatches}, ok: head.sameMachine && head.sameSource !== false && mismatches === 0}
}

// A concrete counterexample run for each mutant (each one found by the prover). verify
// replays it on the mutant, where a law must fail, and on the original kernel, where every law must hold. The kill is
// then deterministic, also when the prover's own search returns only an inductive witness within its time budget.
const REQ0 = {op: 'EDIT_CODE', cost: 0, passed: false, fullSuite: false, suspicious: false, risky: false, treeChanged: false, approveRev: 0, extra: 0}
export const KNOWN_RUNS: Record<string, {params: {maxRetries: number; cap: number}; trace: Record<string, unknown>[]}> = {
  M1a: {params: {maxRetries: 2, cap: 100}, trace: [{op: 'RUN_TESTS', passed: true, fullSuite: true}, {op: 'RUN_BUILD', passed: true}, {op: 'SHELL', treeChanged: true}, {op: 'COMMIT'}]},
  M1b: {params: {maxRetries: 2, cap: 100}, trace: [{op: 'RUN_TESTS'}, {op: 'RUN_TESTS', passed: true}, {op: 'RUN_TESTS'}]},
  M2: {params: {maxRetries: 2, cap: 100}, trace: [{op: 'EDIT_TEST', suspicious: true}, {op: 'RUN_TESTS', passed: true, fullSuite: true}]},
  M3: {params: {maxRetries: 2, cap: 100}, trace: [{op: 'READ_SECRET'}, {op: 'EDIT_CODE'}]},
  M3b: {params: {maxRetries: 2, cap: 100}, trace: [{op: 'READ_SECRET'}, {op: 'SHELL', risky: true}]},
  M4: {params: {maxRetries: 2, cap: 100}, trace: [{op: 'RUN_TESTS', fullSuite: true}, {op: 'RUN_BUILD', passed: true}, {op: 'RUN_TESTS', fullSuite: true}]},
  M4b: {params: {maxRetries: 2, cap: 100}, trace: [{op: 'RUN_TESTS'}, {op: 'RUN_TESTS', passed: true}, {op: 'RUN_TESTS'}]},
  M5: {params: {maxRetries: 2, cap: 3}, trace: [{op: 'RUN_BUILD', cost: 3, passed: true}, {op: 'APPROVE_SHELL'}]},
  M6: {params: {maxRetries: 1, cap: 1}, trace: [{op: 'SHELL', suspicious: true, treeChanged: true}, {op: 'RUN_TESTS', passed: true, fullSuite: true}, {op: 'APPROVE_TESTS', approveRev: 0}, {op: 'RUN_BUILD', passed: true}, {op: 'COMMIT'}]},
  M7: {params: {maxRetries: 2, cap: 3}, trace: [{op: 'RUN_BUILD', cost: 3, passed: true}, {op: 'APPROVE_SHELL'}]},
}
type Named = {name: string}
const show = (q: Record<string, unknown>) => {
  const flags = Object.entries(q).filter(([k, x]) => k !== 'op' && x).map(([k, x]) => `${k}=${x}`)
  return flags.length ? `${q.op}(${flags.join(',')})` : String(q.op)
}

export async function verify(o: {out?: string; lean?: string; log?: (s: string) => void} = {}) {
  const log = o.log ?? ((s: string) => process.stdout.write(s + '\n'))
  const {k, gw} = await loadKernel()
  const {kernel, laws, lemmas, MUTANTS} = k
  const OPT = {search: {ms: 60000}}
  const head = {gdpWired: '0.60.0', node: process.version, platform: `${process.platform} ${process.arch}`}

  log('1. generated step function vs the proven rule')
  const generated = await checkGenerated()
  log(`   machine ${generated.machineName}: same compileJs output=${generated.sameMachine}, kernel.ts hash matches=${generated.sameSource}, ` +
    `differential ${generated.differential.steps} steps, mismatches=${generated.differential.mismatches}`)

  log('2. inductive proof of the original kernel (laws + lemmas I1-I5)')
  let original: {proven: unknown; checked: unknown; stuck: unknown; goal: unknown; why: unknown; ms: number; laws: string[]; stepLaws: string[]}
  {
    const r = kernel('none'), {laws: L, stepLaws: S} = laws(r)
    const t = Date.now()
    const v = gw.proveSteps(r, [...L, ...lemmas(r)], S, OPT)
    original = {proven: v.proven, checked: v.checked, stuck: v.stuck, goal: v.goal, why: v.why, ms: Date.now() - t,
      laws: [...L, ...lemmas(r)].map((l: Named) => l.name), stepLaws: S.map((l: Named) => l.name)}
    log(`   proven=${v.proven} checked=${v.checked} ${Date.now() - t} ms${v.goal ? ' goal=' + v.goal : ''}`)
  }

  log('3. mutants: each must fall with a counterexample run')
  const mutants: Record<string, {killed: boolean} & Record<string, unknown>> = {}
  for (const m of MUTANTS.filter((x: string) => x !== 'none')) {
    const r = kernel(m), {laws: L, stepLaws: S} = laws(r)
    const t = Date.now()
    const v = gw.proveSteps(r, L, S, OPT)
    const failed = [...L, ...S].find((l: Named) => v.goal?.startsWith(l.name))
    let minimized = false
    if (v.run && failed) { try { v.run = gw.minimizeRun(r, failed, v.run); minimized = true } catch { /* keep the unminimised run */ } }
    const trace = (v.run?.trace ?? []).map((q: Record<string, unknown>) => {
      const op = typeof q.op === 'number' ? OPS[q.op] : String(q.op)
      const flags = Object.entries(q).filter(([kk, x]) => kk !== 'op' && x).map(([kk, x]) => `${kk}=${x}`)
      return flags.length ? `${op}(${flags.join(',')})` : op
    })
    // deterministic replay of the known counterexample: a law fails on the mutant and every law holds on the original
    const known = KNOWN_RUNS[m]
    const r0 = kernel('none'), l0 = laws(r0)
    const enc = (rule: typeof r) => known.trace.map((q) => rule.encodeInput({...REQ0, ...q}, known.params))
    const onMutant = gw.replayRefutation(r, L, S, r.encodeParams(known.params), enc(r), 1000)
    const onOriginal = gw.replayRefutation(r0, l0.laws, l0.stepLaws, r0.encodeParams(known.params), enc(r0), 1000)
    const killed = v.proven === false && onMutant === true && onOriginal === false
    mutants[m] = {killed, proven: v.proven, goal: v.goal, ms: Date.now() - t, minimized, proverRun: v.run ? {params: v.run.params, trace} : null,
      proverWitness: v.run ? undefined : v.witness, counterexample: {params: known.params, trace: known.trace.map(show), breaksMutant: onMutant, breaksOriginal: onOriginal}}
    log(`   ${m.padEnd(4)} ${killed ? 'KILLED' : 'SURVIVED'} by ${v.goal ?? '-'} (${Date.now() - t} ms)` +
      `\n        counterexample ${known.trace.map(show).join(' -> ')} ${JSON.stringify(known.params)}: breaks the mutant=${onMutant}, breaks the original=${onOriginal}` +
      (trace.length ? `\n        prover run (minimized=${minimized}): ${trace.join(' -> ')}` : '\n        prover: inductive witness only (no run within the search budget)'))
  }

  let lean: {file: string; lines: number; theorems: number; sorry: number; leanChecked: false} | undefined
  if (o.lean) {
    const {toLean} = await import('gdp-wired/lean')
    const r = kernel('none'), {laws: L, stepLaws: S} = laws(r)
    const text = toLean([{id: 'stopbar_kernel', machine: r.machine, laws: [...L, ...lemmas(r)], stepLaws: S}], {title: 'Stopbar kernel (gdp-wired 0.60.0)'})
    writeFileSync(o.lean, text)
    lean = {file: o.lean, lines: text.split('\n').length, theorems: (text.match(/^\s*theorem\s/gm) ?? []).length, sorry: (text.match(/\bsorry\b/g) ?? []).length, leanChecked: false}
    log(`4. Lean export ${o.lean}: ${lean.lines} lines, ${lean.theorems} theorems, ${lean.sorry} sorry (not checked by Lean here)`)
  }

  const killed = Object.values(mutants).filter((x) => x.killed).length
  const total = Object.keys(mutants).length
  const ok = generated.ok && original.proven === true && original.checked === true && killed === total && total === 10
  const summary = `original proven=${original.proven} checked=${original.checked}; mutants killed ${killed}/${total}; generated step ok=${generated.ok}`
  const out = {...head, generated, original, mutants, ...(lean ? {lean} : {}), ok, summary}
  log(`RESULT: ${out.ok ? 'PASS' : 'FAIL'}: ${out.summary}`)
  if (o.out) writeFileSync(o.out, JSON.stringify(out, null, 1) + '\n')
  return out
}
