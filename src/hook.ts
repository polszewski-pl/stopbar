// Claude Code hooks: PreToolUse, PostToolUse, PostToolUseFailure, Stop. JSON on stdin; exit 0 = allow,
// exit 2 = block (stderr goes to the agent). Any wrapper error is exit 2 (fail closed).
import {existsSync} from 'node:fs'
import {resolve} from 'node:path'
import * as K from './classify.ts'
import {cliOf, type Config, DEFAULT_SAFE_TOOLS} from './config.ts'
import {matchAny} from './glob.ts'
import {decode, kstep, type Req, type View} from './engine.ts'
import {changesSinceHead, countedEntries, diffEntries, differsFromHead, type Entries, FailClosed, findRepo, gitCalls, markCounted, oidOf, refEntries, type Repo, type Snap, snapshot} from './repo.ts'
import {appendEvent, readConfig, readState, type Saved, withLock, writeState} from './store.ts'
import {codeDirs} from './pkg.ts'

export type Out = {code: number; msg?: string}
type Ctx = {repo: Repo; cfg: Config; s: Saved; protect: K.Protect; dirty: boolean; now?: Snap}
/** A hook event: Claude Code's JSON object (adapters translate other clients into it). Fields are read with guards. */
export type HookEvent = Record<string, unknown>
/** Stopbar's own fields on an event: set by the adapters and by `stopbar run`, never by the agent's client. */
type Meta = {adapter?: string; rawKeys?: unknown; expectedSnapshot?: string; expectedRev?: number; requireExitCode?: boolean}

const obj = (x: unknown): Record<string, unknown> => (x && typeof x === 'object' && !Array.isArray(x) ? x as Record<string, unknown> : {})
const strings = (...xs: unknown[]): string[] => xs.flatMap((x) => (Array.isArray(x) ? x as unknown[] : [x])).filter((x): x is string => typeof x === 'string' && x.length > 0)
function metaOf(x: unknown): Meta {
  const m = obj(x)
  return {
    ...(typeof m.adapter === 'string' ? {adapter: m.adapter} : {}),
    ...(m.rawKeys !== undefined ? {rawKeys: m.rawKeys} : {}),
    ...(typeof m.expectedSnapshot === 'string' ? {expectedSnapshot: m.expectedSnapshot} : {}),
    ...(typeof m.expectedRev === 'number' ? {expectedRev: m.expectedRev} : {}),
    ...(m.requireExitCode === true ? {requireExitCode: true} : {}),
  }
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS'])
const SHELL_TOOLS = new Set(['Bash', 'PowerShell'])
const OUTBOUND = (t: string) => t === 'WebFetch' || t === 'WebSearch' || t.startsWith('mcp__')

function step(ctx: Ctx, req: Req, source: string, extra: Record<string, unknown> = {}): {before: View; after: View} {
  const before = decode(ctx.s.kernel)
  ctx.s.kernel = kstep(ctx.s.params, ctx.s.kernel, req)
  ctx.dirty = true
  const after = decode(ctx.s.kernel)
  appendEvent(ctx.repo, {source, req, decision: after.decision, halted: after.halted, testsTainted: after.testsTainted,
    secretTainted: after.secretTainted, shellToken: after.shellToken, treeRev: after.treeRev, buildOkRev: after.buildOkRev,
    testsOkRev: after.testsOkRev, spent: after.spent, capNow: after.capNow, testFails: after.testFails, buildFails: after.buildFails,
    commitExecuted: after.commitExecuted, ...extra})
  return {before, after}
}

/** `<cli> run build|test`: the Stopbar command that runs a gate and records its real exit status (config.cliCmd). */
export const runHint = (cfg: Pick<Config, 'cliCmd'>, which: 'build' | 'test') => `${cliOf(cfg)} run ${which}`

export function whyBlocked(v: View, cfg: Pick<Config, 'buildCmd' | 'fullTestCmd' | 'cliCmd'>): string {
  const r: string[] = []
  if (v.buildOkRev !== v.treeRev) r.push(`no passing build at revision ${v.treeRev} (run \`${cfg.buildCmd}\` exactly, alone, or \`${runHint(cfg, 'build')}\`)`)
  if (v.testsOkRev !== v.treeRev) r.push(`no passing FULL test suite at revision ${v.treeRev} (run \`${cfg.fullTestCmd}\` exactly, alone, or \`${runHint(cfg, 'test')}\`)`)
  if (v.testsTainted) r.push(`existing tests or test config changed: a human must review and run \`stopbar approve-tests --rev ${v.treeRev}\``)
  return r.join('; ') || 'kernel decision'
}

/** Classifies changed paths against the reference tree (baseRef, else HEAD). One git process, and only when a test or
 *  (with baseRef) a test-config file changed: a code-only change costs no git process here. With baseRef, a test or
 *  test-config file whose blob id equals baseRef's is not suspicious (taken over from baseRef by checkout, rebase or
 *  cherry-pick, or put back to it). Shared by the hooks and by `init --force` / `reset` on a dirty tree. */
export function classifyChanges(repo: Repo, cfg: Config, changes: {status: string; path: string}[], now: Entries) {
  const ref = cfg.baseRef ?? 'HEAD'
  const watched = changes.map((c) => c.path).filter((p) => K.isTestConfigPath(p, cfg.paths) ? !!cfg.baseRef : K.isTestPath(p, cfg.paths))
  const inRef = refEntries(repo.root, ref, watched)
  const same = cfg.baseRef ? (p: string) => oidOf(now.get(p)) === oidOf(inRef.get(p)) : undefined
  return K.classifyTreeChange(changes, (p) => inRef.has(p), cfg.paths, same)
}

/** Counts a working-tree change the kernel has not seen yet. */
function syncTree(ctx: Ctx, cost: number, source: string) {
  const {repo, s, cfg} = ctx
  const snap = snapshot(repo)
  ctx.now = snap
  if (snap.id === s.snapshot) return null
  const base = countedEntries(repo, s.snapshot)
  let changes
  if (base) changes = diffEntries(base, snap.entries)
  else {
    // the copy of the last counted snapshot is gone or damaged: compare with HEAD instead (more changes, never fewer)
    changes = changesSinceHead(repo, snap.entries)
    appendEvent(repo, {source: `${source}:fallback-diff`, note: 'counted snapshot copy missing; diff against HEAD'})
  }
  const cls = classifyChanges(repo, cfg, changes, snap.entries)
  const {before, after} = step(ctx, {op: cls.op, suspicious: cls.suspicious, cost}, `${source}:tree ${cls.why.join(', ') || `${changes.length} file(s)`}`)
  // not executed (halted or over budget): the change stays pending and is counted later
  if (after.treeRev > before.treeRev) { s.snapshot = snap.id; markCounted(repo); ctx.dirty = true }
  return {cls, after}
}

const block = (reason: string): Out => ({code: 2, msg: `BLOCK (stopbar): ${reason}`})

function isBackgroundInput(ti: Record<string, unknown>): boolean {
  return ti.run_in_background === true || ti.run_in_background === 'true' || ti.background === true
}
function isBackgroundResponse(tr: unknown): boolean {
  const r = obj(tr)
  return (typeof r.backgroundTaskId === 'string' && r.backgroundTaskId.length > 0) ||
    (typeof r.background_task_id === 'string' && r.background_task_id.length > 0) ||
    r.isAsync === true || r.background === true
}

// ---------------------------------------------------------------- PreToolUse
function pre(ctx: Ctx, input: HookEvent): Out {
  const tool = String(input.tool_name ?? ''), ti = obj(input.tool_input)
  const {repo, cfg} = ctx
  const shell = tool === 'PowerShell' ? 'powershell' as const : 'bash' as const
  // self-protection: unconditional, before the kernel, also when halted
  if (EDIT_TOOLS.has(tool)) {
    for (const p of strings(ti.file_path, ti.notebook_path, ti.path, ti.file_paths)) {
      const why = K.protectedPath(resolve(repo.root, p), repo.root, ctx.protect)
      if (why) { appendEvent(repo, {source: 'pre', tool, wrapper: 'BLOCK', reason: why, path: p}); return block(`writing ${p} is not allowed: ${why}. Ask the human.`) }
    }
  }
  if (SHELL_TOOLS.has(tool)) {
    const cmd = String(ti.command ?? '')
    const why = K.protectedCommand(K.commandForSelfProtect(cmd, shell), ctx.protect, shell)
    if (why) { appendEvent(repo, {source: 'pre', tool, wrapper: 'BLOCK', reason: why}); return block(`${why}. Ask the human.`) }
  }
  const v = decode(ctx.s.kernel)
  // local tools in config.safeTools (task list, turn summary, messages between local sessions) never take a kernel step,
  // so they stay allowed while halted: the agent can still ask a human for `stopbar resume`. File, shell and every
  // other tool stay paused.
  if (!EDIT_TOOLS.has(tool) && !READ_TOOLS.has(tool) && !SHELL_TOOLS.has(tool) && matchAny(tool, cfg.safeTools ?? DEFAULT_SAFE_TOOLS)) {
    if (v.halted) appendEvent(repo, {source: 'pre', tool, wrapper: 'ALLOW', reason: 'safe tool while halted'})
    return {code: 0}
  }
  if (v.halted) {
    appendEvent(repo, {source: 'pre', tool, wrapper: 'PAUSE', reason: 'halted'})
    return {code: 2, msg: `PAUSE (stopbar): the session is halted (testFails=${v.testFails}, buildFails=${v.buildFails}, spent=${v.spent}/${v.capNow}). A human must run: stopbar resume --extra <n>`}
  }
  const cost = cfg.costPerCall
  if (READ_TOOLS.has(tool)) {
    for (const p of strings(ti.file_path, ti.path, ti.glob, ti.pattern, ti.file_paths)) {
      const pattern = K.secretPattern(p, cfg.paths)
      if (pattern) { step(ctx, {op: 'READ_SECRET', cost}, `pre:${tool}`, {secret: {pattern, path: p, tool}}); break }
    }
    return {code: 0}
  }
  if (EDIT_TOOLS.has(tool)) return {code: 0} // cost and tree change are counted in PostToolUse
  if (SHELL_TOOLS.has(tool)) {
    const cmd = String(ti.command ?? '')
    const base = typeof input.cwd === 'string' && input.cwd ? input.cwd : repo.root
    const exists = (t: string) => existsSync(resolve(base, t)) || existsSync(resolve(repo.root, t))
    const k = K.classifyBash(cmd, cfg, shell, exists)
    if (k.kind === 'commit-chained') {
      appendEvent(repo, {source: 'pre', tool, wrapper: 'BLOCK', reason: `chained commit (${k.reason})`})
      return block(`run \`git commit\` / \`git push\` as a single command (${k.reason}): no &&, ;, |, redirections or $(...). ` +
        `For a multi-line message use -m "..." or exactly: git commit -m "$(cat <<'EOF'\\n<message>\\nEOF\\n)" with the quoted 'EOF' delimiter and nothing else in the command.`)
    }
    if (k.kind === 'gate-chained') {
      appendEvent(repo, {source: 'pre', tool, wrapper: 'BLOCK', reason: `chained gate command (${k.reason})`})
      return block(`run \`${k.gate}\` exactly as configured, alone: no ;, &&, ||, |, redirections or $(...). Chained operators hide its exit status.`)
    }
    if (k.kind === 'build' || k.kind === 'fulltest') {
      if (isBackgroundInput(ti)) {
        const which = k.kind === 'build' ? 'build' : 'test'
        const gate = k.kind === 'build' ? cfg.buildCmd : cfg.fullTestCmd
        appendEvent(repo, {source: 'pre', tool, wrapper: 'BLOCK', reason: `background gate command (${k.kind})`})
        return block(`do not run \`${gate}\` in the background (run_in_background): the hook fires before the process finishes, so its exit status is unknown. Run \`${gate}\` in the foreground, or start \`${runHint(cfg, which)}\` in the background so Stopbar records the real exit status only when it finishes.`)
      }
      return {code: 0} // the result is recorded in PostToolUse
    }
    if (k.kind === 'commit') {
      syncTree(ctx, 0, 'pre:commit-sync') // a change nobody reported (background job, human edit) is counted first
      const {after} = step(ctx, {op: 'COMMIT', cost}, `pre:${tool}:commit${k.heredoc ? ':heredoc' : ''}`)
      if (after.decision !== 'ALLOW') return {code: 2, msg: `${after.decision} (stopbar): commit refused: ${after.halted ? 'session halted' : whyBlocked(after, cfg)}`}
      if (k.push) {
        const r = step(ctx, {op: 'SHELL', risky: true}, `pre:${tool}:push`)
        if (r.after.decision === 'PAUSE') return {code: 2, msg: 'PAUSE (stopbar): git push after a secret was read; a human must run `stopbar approve-shell`'}
      }
      return {code: 0}
    }
    if (k.secret) step(ctx, {op: 'READ_SECRET'}, `pre:${tool}:secret-mention`, {secret: {pattern: k.secret.pattern, path: k.secret.token, tool}})
    const {after} = step(ctx, {op: 'SHELL', risky: k.risky, cost}, `pre:${tool}`)
    if (after.decision === 'PAUSE') {
      return {code: 2, msg: after.halted ? 'PAUSE (stopbar): budget reached; a human must run `stopbar resume --extra <n>`'
        : 'PAUSE (stopbar): risky or outbound command after a secret was read; a human must run `stopbar approve-shell` (one call)'}
    }
    return {code: 0}
  }
  if (OUTBOUND(tool)) { // tools in config.safeTools returned above
    const {after} = step(ctx, {op: 'SHELL', risky: true, cost}, `pre:${tool}`)
    if (after.decision === 'PAUSE') return {code: 2, msg: `PAUSE (stopbar): ${tool} is outbound and a secret was read (or the budget is spent); a human runs \`stopbar approve-shell\` or \`stopbar resume\``}
  }
  return {code: 0}
}

// ---------------------------------------------------------------- PostToolUse / PostToolUseFailure
// Claude Code sends PostToolUse after success and PostToolUseFailure after an error (non-zero exit of Bash).
// PostToolUse carries no exit code: success unless is_error / interrupted. Failure is the event type itself.
function exitCodeOf(tr: unknown): number | undefined {
  const r = obj(tr)
  for (const k of ['exitCode', 'exit_code', 'returnCode', 'code']) { const v = r[k]; if (typeof v === 'number') return v }
  return undefined
}

function post(ctx: Ctx, input: HookEvent, failure: boolean): Out {
  const tool = String(input.tool_name ?? ''), ti = obj(input.tool_input)
  const {repo, cfg} = ctx
  const msgs: string[] = []
  if (SHELL_TOOLS.has(tool)) {
    const k = K.classifyBash(String(ti.command ?? ''), cfg, tool === 'PowerShell' ? 'powershell' : 'bash')
    const tr = input.tool_response, r = obj(tr)
    const meta = metaOf(input.stopbar)
    appendEvent(repo, {source: `payload:${String(input.hook_event_name)}`, tool, ...(meta.adapter ? {adapter: meta.adapter, rawKeys: meta.rawKeys} : {inputKeys: Object.keys(input)}),
      toolResponseKeys: tr && typeof tr === 'object' ? Object.keys(tr) : typeof tr})
    const bg = isBackgroundInput(ti) || isBackgroundResponse(tr)
    const staleRun = typeof meta.expectedSnapshot === 'string' &&
      (meta.expectedSnapshot !== ctx.s.snapshot || (typeof meta.expectedRev === 'number' && meta.expectedRev !== decode(ctx.s.kernel).treeRev))
    const code = exitCodeOf(tr)
    const flagged = input.is_error === true || r.is_error === true || r.interrupted === true
    // some clients send the same post event for success and failure: then only an explicit exit code 0 is a pass
    const unknown = meta.requireExitCode === true && code === undefined
    const passed = failure ? false : code !== undefined ? code === 0 : !flagged && !unknown
    const note = failure ? ' (PostToolUseFailure)' : code !== undefined ? ` (exit ${code})` : unknown ? ' (no exit code: not counted as a pass)' : ` (no exit code; is_error/interrupted=${flagged})`
    if (failure && input.is_interrupt === true) {
      // Ctrl+C by the user: not a failed gate and not a retry; the tree is still checked below
      appendEvent(repo, {source: 'post:user-interrupt', tool, kind: k.kind})
    } else if (cfg.requireRun === true && meta.adapter !== 'run' && (k.kind === 'build' || k.kind === 'fulltest')) {
      // config.requireRun: a gate counts only through `stopbar run build|test`, never from the agent's own shell
      const which = k.kind === 'build' ? 'build' : 'test'
      appendEvent(repo, {source: 'post:require-run', tool, kind: k.kind, ...(meta.adapter ? {adapter: meta.adapter} : {})})
      msgs.push(`NOTE (stopbar): this repository records gates only through \`${runHint(cfg, which)}\` (config.requireRun), so \`${k.kind === 'build' ? cfg.buildCmd : cfg.fullTestCmd}\` run from the agent's shell is not recorded. Run \`${runHint(cfg, which)}\` instead: it runs the same command and records its real exit status.`)
    } else if (!failure && bg && (k.kind === 'build' || k.kind === 'fulltest' || (k.kind === 'shell' && k.partialTests))) {
      // a background launch fires PostToolUse before the process finishes (e.g. Claude Code backgroundTaskId): never count it
      appendEvent(repo, {source: 'post:background-gate-ignored', tool, kind: k.kind === 'shell' ? 'partial-tests' : k.kind,
        ...(typeof r.backgroundTaskId === 'string' ? {backgroundTaskId: r.backgroundTaskId} : typeof r.background_task_id === 'string' ? {backgroundTaskId: r.background_task_id} : {})})
      if (k.kind !== 'shell') {
        const which = k.kind === 'build' ? 'build' : 'test'
        const gate = k.kind === 'build' ? cfg.buildCmd : cfg.fullTestCmd
        msgs.push(`BLOCK (stopbar): \`${gate}\` was started in the background, so its exit status is not known yet and the run is not recorded. Run \`${gate}\` in the foreground, or start \`${runHint(cfg, which)}\` in the background.`)
      }
    } else if (staleRun && (k.kind === 'build' || k.kind === 'fulltest')) {
      const curRev = decode(ctx.s.kernel).treeRev
      appendEvent(repo, {source: 'post:stale-gate-run', tool, kind: k.kind, expectedRev: meta.expectedRev, currentRev: curRev})
      msgs.push(`NOTE (stopbar): working tree changed while \`${k.kind === 'build' ? cfg.buildCmd : cfg.fullTestCmd}\` was running (started at revision ${meta.expectedRev}, now ${curRev}), so the result was not recorded. Re-run on the current tree.`)
    } else if (!failure && unknown && (k.kind === 'build' || k.kind === 'fulltest' || (k.kind === 'shell' && k.partialTests))) {
      // no exit status in the client's post event: neither a pass nor a failure is recorded (no evidence either way)
      appendEvent(repo, {source: 'post:gate-without-exit-code', tool, kind: k.kind})
      if (k.kind !== 'shell') msgs.push(`NOTE (stopbar): this client does not report the exit status of \`${k.kind === 'build' ? cfg.buildCmd : cfg.fullTestCmd}\`, so the run is not recorded. Run \`${runHint(cfg, k.kind === 'build' ? 'build' : 'test')}\` instead: it runs the same command and records its real exit status.`)
    } else if (k.kind === 'build') {
      step(ctx, {op: 'RUN_BUILD', passed, cost: cfg.costPerCall}, `post:build${note}`)
    } else if (k.kind === 'fulltest') {
      step(ctx, {op: 'RUN_TESTS', passed, fullSuite: true, cost: cfg.costPerCall}, `post:fulltest${note}`)
    } else if (k.kind === 'shell' && k.partialTests) {
      step(ctx, {op: 'RUN_TESTS', passed, fullSuite: false}, `post:partial-tests${note}`)
    }
  }
  if (SHELL_TOOLS.has(tool) || EDIT_TOOLS.has(tool)) {
    // after SHELL the cost was paid in PreToolUse; an edit pays here
    const r = syncTree(ctx, EDIT_TOOLS.has(tool) ? cfg.costPerCall : 0, `post:${tool}`)
    if (r?.cls.suspicious) msgs.push(`PAUSE (stopbar): existing tests or test config changed (${r.cls.why.join(', ')}). Commit is blocked until a human reviews the change and runs \`stopbar approve-tests\`.`)
  }
  const v = decode(ctx.s.kernel)
  if (v.halted) msgs.push(`PAUSE (stopbar): session halted (testFails=${v.testFails}, buildFails=${v.buildFails}, spent=${v.spent}/${v.capNow}). A human must run \`stopbar resume --extra <n>\`.`)
  return msgs.length ? {code: 2, msg: msgs.join('\n')} : {code: 0}
}

// ---------------------------------------------------------------- Stop: "I am done" = the COMMIT gate when the tree differs from HEAD
// stopGate 'warn': the turn may end with unverified changes (e.g. to ask the human a question). Only the Stop hook
// changes: no COMMIT step is taken, so `git commit` / `git push` in PreToolUse and the git hooks stay fully gated.
function stop(ctx: Ctx, input: HookEvent): Out {
  if (input.stop_hook_active) return {code: 0}
  syncTree(ctx, 0, 'stop:sync')
  if (!differsFromHead(ctx.repo, ctx.now!.entries)) return {code: 0}
  if (ctx.cfg.stopGate === 'warn') {
    const v = decode(ctx.s.kernel)
    const commitOk = !v.halted && v.buildOkRev === v.treeRev && v.testsOkRev === v.treeRev && !v.testsTainted
    if (!commitOk) {
      const reason = v.halted ? 'session halted' : whyBlocked(v, ctx.cfg)
      appendEvent(ctx.repo, {source: 'stop:warn', reason, treeRev: v.treeRev, buildOkRev: v.buildOkRev, testsOkRev: v.testsOkRev, testsTainted: v.testsTainted, halted: v.halted})
      return {code: 0, msg: `WARN (stopbar): uncommitted changes are not yet verified (${reason}); commit remains blocked until gates pass.`}
    }
  }
  const {after} = step(ctx, {op: 'COMMIT'}, 'stop:declare-done')
  return after.decision === 'ALLOW' ? {code: 0}
    : {code: 2, msg: `Not done (stopbar): uncommitted changes and ${after.halted ? 'the session is halted' : whyBlocked(after, ctx.cfg)}.`}
}

// ---------------------------------------------------------------- entry
export function failMsg(e: unknown): string {
  if (e instanceof FailClosed) return `STOPBAR FAIL-CLOSED: ${e.message}${e.fix ? `\nFix: ${e.fix}` : ''}`
  return `STOPBAR FAIL-CLOSED: ${e instanceof Error ? e.message : String(e)}`
}

/** One hook call with Claude Code's JSON on stdin (the v1.0 interface). Never throws. */
export function runHook(raw: string, t0 = performance.now()): Out {
  let input: unknown
  try { input = JSON.parse(raw) } catch (e) { return {code: 2, msg: `STOPBAR FAIL-CLOSED: hook input is not JSON (${(e as Error).message})`} }
  if (!input || typeof input !== 'object') return {code: 2, msg: 'STOPBAR FAIL-CLOSED: hook input must be a JSON object'}
  return runEvent(input as HookEvent, t0)
}

/** One normalised hook event (Claude Code's shape; adapters translate other clients into it). Never throws. */
export function runEvent(input: HookEvent, t0 = performance.now()): Out {
  try {
    const repo = findRepo(typeof input.cwd === 'string' && input.cwd ? input.cwd : process.cwd())
    const g0 = gitCalls
    return withLock(repo, () => {
      const cfg = readConfig(repo)
      const ctx: Ctx = {repo, cfg, s: readState(repo), protect: {gitDir: repo.gitDir, stateDir: repo.stateDir, codeDirs: codeDirs()}, dirty: false}
      const ev = input.hook_event_name
      const res = ev === 'PreToolUse' ? pre(ctx, input)
        : ev === 'PostToolUse' ? post(ctx, input, false)
          : ev === 'PostToolUseFailure' ? post(ctx, input, true)
            : ev === 'Stop' ? stop(ctx, input) : {code: 0}
      if (ctx.dirty) writeState(repo, ctx.s)
      appendEvent(repo, {source: 'hook-timing', event: ev, tool: input.tool_name, ...(metaOf(input.stopbar).adapter ? {adapter: metaOf(input.stopbar).adapter} : {}), exit: res.code, gitCalls: gitCalls - g0,
        handlerMs: Math.round(performance.now() - t0), processMs: Math.round(process.uptime() * 1000)})
      return res
    })
  } catch (e) {
    return {code: 2, msg: failMsg(e)}
  }
}
