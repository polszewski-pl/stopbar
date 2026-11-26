// ATTEST: a deterministic attestation of the session from the current state and the event log. The same state and log
// give the same report byte for byte (no clock, no machine name). The sha256 of events.jsonl is the anchor for signing in
// a later version. Probe evidence: the latest `probe:result` per target, and whether its tree is the current one.
// Read-only for Stopbar state: it refreshes only the private snapshot index to see the working tree.
import {createHash} from 'node:crypto'
import {existsSync, readFileSync} from 'node:fs'
import {decode, initKernel, MACHINE, type View} from './engine.ts'
import {secretReason} from './commands.ts'
import {whyBlocked} from './hook.ts'
import {findRepo, git, snapshot} from './repo.ts'
import {paths, readConfig, readState, VERSION, withLock} from './store.ts'

const FIELDS = ['treeRev', 'buildOkRev', 'testsOkRev', 'spent', 'capNow', 'testFails', 'buildFails', 'halted', 'testsTainted', 'secretTainted', 'shellToken'] as const

export function attestation(repoDir: string) {
  const repo = findRepo(repoDir)
  return withLock(repo, () => {
    const cfg = readConfig(repo), s = readState(repo), v = decode(s.kernel)
    const f = paths(repo).events
    const raw = existsSync(f) ? readFileSync(f) : Buffer.alloc(0)
    const events: {line: number; e: Record<string, any>}[] = [], torn: number[] = []
    raw.toString('utf8').split('\n').forEach((l, i) => { if (!l) return; try { events.push({line: i + 1, e: JSON.parse(l)}) } catch { torn.push(i + 1) } })
    let head: string | null = null, headTree: string | null = null
    try { head = git(repo.root, ['rev-parse', '-q', '--verify', 'HEAD']); headTree = git(repo.root, ['rev-parse', 'HEAD^{tree}']) } catch { /* no commit yet */ }
    const now = snapshot(repo)

    const steps = events.filter(({e}) => e.req && typeof e.req.op === 'string')
    const human = events.filter(({e}) => typeof e.source === 'string' && e.source.startsWith('human:'))
    const approvals = human.map(({line, e}) => ({line, ts: e.ts, action: e.source.slice('human:'.length),
      ...(e.req?.approveRev !== undefined && e.source === 'human:approve-tests' ? {revision: e.req.approveRev} : {}),
      ...(e.req?.extra !== undefined && e.source === 'human:resume' ? {extra: e.req.extra} : {}),
      ...(e.decision ? {decision: e.decision} : {}), ...(e.shellToken !== undefined && e.source === 'human:approve-shell' ? {granted: e.shellToken} : {})}))
    // a block is a wrapper BLOCK/PAUSE (self-protection, chained command, halted) or a kernel decision other than ALLOW on an agent action
    const blocks = events.filter(({e}) => e.wrapper === 'BLOCK' || e.wrapper === 'PAUSE' || (e.req && e.decision && e.decision !== 'ALLOW' && !String(e.source).startsWith('human:'))).length
    const decisions: Record<string, number> = {}
    for (const {e} of steps) decisions[`${e.req.op}:${e.decision}`] = (decisions[`${e.req.op}:${e.decision}`] ?? 0) + 1
    const commitsAllowed = steps.filter(({e}) => e.req.op === 'COMMIT' && e.decision === 'ALLOW' && String(e.source).startsWith('pre:')).length

    // consistency: the state must be what the log says the last kernel step (or the last init/reset) left behind
    const checks: {name: string; ok: boolean; detail: string}[] = []
    const lastIdx = Math.max(...events.map((x, i) => (x.e.req || x.e.source === 'human:init' || x.e.source === 'human:reset' ? i : -1)), -1)
    if (lastIdx < 0) checks.push({name: 'log matches state', ok: false, detail: 'no kernel step and no init in events.jsonl'})
    else {
      const last = events[lastIdx]
      const expected: Record<string, unknown> = last.e.req ? last.e : decode(initKernel(s.params)) as View
      const diff = FIELDS.filter((k) => k in expected && expected[k] !== v[k])
      checks.push({name: 'log matches state', ok: diff.length === 0, detail: diff.length ? `differs at ${diff.join(', ')} (line ${last.line})` : `last entry line ${last.line}`})
    }
    checks.push({name: 'config params = state params', ok: cfg.maxRetries === s.params.maxRetries && cfg.cap === s.params.cap, detail: `${JSON.stringify(s.params)}`})
    checks.push({name: 'working tree counted', ok: now.id === s.snapshot, detail: now.id === s.snapshot ? 'no change the kernel has not seen' : 'uncounted change (counted at the next hook)'})

    // probe evidence: the latest probe:result per target since the last init / reset (not kernel steps: no req)
    let since = 0
    events.forEach(({e}, i) => { if (e.source === 'human:init' || e.source === 'human:reset') since = i + 1 })
    const latest = new Map<string, {line: number; e: Record<string, any>}>()
    for (const x of events.slice(since)) if (x.e.source === 'probe:result' && typeof x.e.target === 'string') latest.set(x.e.target, x)
    const probes = [...latest.keys()].sort().map((k) => {
      const {line, e} = latest.get(k)!
      const m = e.mutants && typeof e.mutants === 'object' ? e.mutants : null
      return {target: k, targetPath: e.targetPath ?? null, ...(typeof e.targetCmd === 'string' ? {targetCmd: e.targetCmd} : {}), targetSha256: e.targetSha256 ?? null, ok: e.ok === true, runs: e.runs ?? 0, regressions: e.regressions ?? 0,
        passed: e.passed ?? 0, failed: e.failed ?? 0, steps: e.steps ?? 0,
        mutants: m ? {killed: m.killed ?? 0, total: m.total ?? 0, survived: Array.isArray(m.survived) ? m.survived : []} : null,
        treeSnapshot: e.treeSnapshot ?? null, atCurrentSnapshot: e.treeSnapshot === now.id, summarySha256: e.summarySha256 ?? null, line, ts: e.ts ?? null}
    })

    const commitNow = !v.halted && v.buildOkRev === v.treeRev && v.testsOkRev === v.treeRev && !v.testsTainted
    return {
      stopbar: VERSION,
      kernel: MACHINE,
      repository: {head, headTree, snapshot: s.snapshot, workingTreeSnapshot: now.id, treeRevision: v.treeRev},
      config: {profile: cfg.profile, buildCmd: cfg.buildCmd, fullTestCmd: cfg.fullTestCmd, maxRetries: cfg.maxRetries, cap: cfg.cap, costPerCall: cfg.costPerCall, ...(cfg.baseRef ? {baseRef: cfg.baseRef} : {}),
        stopGate: cfg.stopGate ?? 'block', ...(cfg.cliCmd ? {cliCmd: cfg.cliCmd} : {}), ...(cfg.requireRun ? {requireRun: true} : {})},
      gates: {build: v.buildOkRev === v.treeRev, fullTests: v.testsOkRev === v.treeRev, tainted: v.testsTainted, secretRead: v.secretTainted,
        ...(v.secretTainted ? {secretReadBy: secretReason(repo)?.text ?? 'not in the event log'} : {}),
        shellApprovalHeld: v.shellToken, halted: v.halted, commitAllowedNow: commitNow, ...(commitNow ? {} : {why: v.halted ? 'session halted' : whyBlocked(v, cfg)}),
        budget: {spent: v.spent, cap: v.capNow}, failures: {tests: v.testFails, builds: v.buildFails}},
      humanActions: approvals,
      probes,
      log: {file: 'events.jsonl', sha256: createHash('sha256').update(raw).digest('hex'), bytes: raw.length, entries: events.length, tornLines: torn,
        kernelSteps: steps.length, blocks, commitsAllowed, decisions: Object.fromEntries(Object.entries(decisions).sort())},
      consistent: checks.every((c) => c.ok || c.name === 'working tree counted'),
      checks,
    }
  })
}

export function attestMarkdown(a: ReturnType<typeof attestation>): string {
  const yn = (b: boolean) => (b ? 'yes' : 'no')
  const g = a.gates
  return [
    `# Stopbar attestation`, '',
    `| Field | Value |`, `|---|---|`,
    `| Stopbar | ${a.stopbar} |`, `| Kernel | ${a.kernel.name}, kernel.ts sha256 \`${a.kernel.kernelSha256}\` |`,
    `| HEAD | \`${a.repository.head ?? '(none)'}\` |`, `| HEAD tree | \`${a.repository.headTree ?? '(none)'}\` |`,
    ...(a.config.baseRef ? [`| Base ref | \`${a.config.baseRef}\` |`] : []),
    ...(a.config.stopGate === 'warn' ? ['| Stop gate | warn (Stop does not block a turn; git commit and git push stay gated) |'] : []),
    ...(a.config.requireRun ? ['| requireRun | true (the build and full test gates count only through `stopbar run build` and `stopbar run test`) |'] : []),
    `| Counted snapshot | \`${a.repository.snapshot}\` (revision ${a.repository.treeRevision}) |`,
    `| Build gate | ${yn(g.build)} (\`${a.config.buildCmd}\`) |`, `| Full test gate | ${yn(g.fullTests)} (\`${a.config.fullTestCmd}\`) |`,
    `| Tests tainted | ${yn(g.tainted)} |`, `| Secret read | ${g.secretRead ? `yes: ${g.secretReadBy}` : 'no'} |`, `| Halted | ${yn(g.halted)} |`,
    `| Commit allowed now | ${yn(g.commitAllowedNow)}${g.why ? `: ${g.why}` : ''} |`,
    `| Budget | ${g.budget.spent}/${g.budget.cap} |`,
    `| events.jsonl sha256 | \`${a.log.sha256}\` (${a.log.bytes} bytes, ${a.log.entries} entries, torn lines: ${a.log.tornLines.length ? a.log.tornLines.join(', ') : 'none'}) |`,
    `| Kernel steps / blocks / commits allowed | ${a.log.kernelSteps} / ${a.log.blocks} / ${a.log.commitsAllowed} |`,
    `| Consistent | ${yn(a.consistent)} |`, '',
    `## Human actions`, '', ...(a.humanActions.length ? a.humanActions.map((h) => `- line ${h.line}, ${h.ts}: ${h.action}${'revision' in h ? ` revision ${h.revision}` : ''}${'extra' in h ? ` extra ${h.extra}` : ''}${h.decision ? ` -> ${h.decision}` : ''}`) : ['- none']), '',
    `## Probe evidence`, '', ...(a.probes.length ? a.probes.map((p) => `- ${p.target}: ${p.ok ? 'PASS' : 'FAIL'}, ${p.runs} runs, ${p.steps} steps` +
      `${p.mutants ? `, mutants ${p.mutants.killed}/${p.mutants.total} killed${p.mutants.survived.length ? ` (survived: ${p.mutants.survived.join(', ')})` : ''}` : ''}` +
      `, at current snapshot: ${yn(p.atCurrentSnapshot)}${p.targetSha256 ? `, target sha256 \`${String(p.targetSha256).slice(0, 16)}\`` : ''} (line ${p.line})`) : ['- none']), '',
    `## Checks`, '', ...a.checks.map((c) => `- [${c.ok ? 'x' : ' '}] ${c.name}: ${c.detail}`), '',
  ].join('\n')
}

export function attest(o: {repo?: string; format?: string}) {
  const fmt = o.format ?? 'json'
  if (fmt !== 'json' && fmt !== 'md') return {code: 1, msg: '--format must be json or md'}
  const a = attestation(o.repo ?? process.cwd())
  return {code: a.consistent ? 0 : 1, msg: fmt === 'md' ? attestMarkdown(a) : JSON.stringify(a, null, 1)}
}
