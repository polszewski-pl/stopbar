// Claude Code hooks: PreToolUse, PostToolUse, PostToolUseFailure, Stop. JSON on stdin; exit 0 = allow,
// exit 2 = block (stderr goes to the agent). Any wrapper error is exit 2 (fail closed).
import {resolve} from 'node:path'
import * as K from './classify.ts'
import type {Config} from './config.ts'
import {decode, kstep, type Req, type View} from './engine.ts'
import {changesSinceHead, countedEntries, diffEntries, differsFromHead, FailClosed, findRepo, gitCalls, inHead, markCounted, type Repo, type Snap, snapshot} from './repo.ts'
import {appendEvent, readConfig, readState, type Saved, withLock, writeState} from './store.ts'
import {codeDirs} from './pkg.ts'

export type Out = {code: number; msg?: string}
type Ctx = {repo: Repo; cfg: Config; s: Saved; protect: K.Protect; dirty: boolean; now?: Snap}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS'])
const SHELL_TOOLS = new Set(['Bash', 'PowerShell'])
const OUTBOUND = (t: string) => t === 'WebFetch' || t === 'WebSearch' || t.startsWith('mcp__')

function step(ctx: Ctx, req: Req, source: string): {before: View; after: View} {
  const before = decode(ctx.s.kernel)
  ctx.s.kernel = kstep(ctx.s.params, ctx.s.kernel, req)
  ctx.dirty = true
  const after = decode(ctx.s.kernel)
  appendEvent(ctx.repo, {source, req, decision: after.decision, halted: after.halted, testsTainted: after.testsTainted,
    secretTainted: after.secretTainted, shellToken: after.shellToken, treeRev: after.treeRev, buildOkRev: after.buildOkRev,
    testsOkRev: after.testsOkRev, spent: after.spent, capNow: after.capNow, testFails: after.testFails, buildFails: after.buildFails,
    commitExecuted: after.commitExecuted})
  return {before, after}
}

export function whyBlocked(v: View, cfg: Pick<Config, 'buildCmd' | 'fullTestCmd'>): string {
  const r: string[] = []
  if (v.buildOkRev !== v.treeRev) r.push(`no passing build at revision ${v.treeRev} (run \`${cfg.buildCmd}\` exactly, alone)`)
  if (v.testsOkRev !== v.treeRev) r.push(`no passing FULL test suite at revision ${v.treeRev} (run \`${cfg.fullTestCmd}\` exactly, alone)`)
  if (v.testsTainted) r.push(`existing tests or test config changed: a human must review and run \`stopbar approve-tests --rev ${v.treeRev}\``)
  return r.join('; ') || 'kernel decision'
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
  const testPaths = changes.map((c) => c.path).filter((p) => K.isTestPath(p, cfg.paths) && !K.isTestConfigPath(p, cfg.paths))
  const head = testPaths.length ? inHead(repo.root, testPaths) : new Set<string>()
  const cls = K.classifyTreeChange(changes, (p) => head.has(p), cfg.paths)
  const {before, after} = step(ctx, {op: cls.op, suspicious: cls.suspicious, cost}, `${source}:tree ${cls.why.join(', ') || `${changes.length} file(s)`}`)
  // not executed (halted or over budget): the change stays pending and is counted later
  if (after.treeRev > before.treeRev) { s.snapshot = snap.id; markCounted(repo); ctx.dirty = true }
  return {cls, after}
}

const block = (reason: string): Out => ({code: 2, msg: `BLOCK (stopbar): ${reason}`})

// ---------------------------------------------------------------- PreToolUse
function pre(ctx: Ctx, input: any): Out {
  const tool = String(input.tool_name ?? ''), ti = input.tool_input ?? {}
  const {repo, cfg} = ctx
  // self-protection: unconditional, before the kernel, also when halted
  if (EDIT_TOOLS.has(tool)) {
    const list = [ti.file_path, ti.notebook_path, ti.path, ...(Array.isArray(ti.file_paths) ? ti.file_paths : [])]
    for (const p of list.filter((x) => typeof x === 'string' && x)) {
      const why = K.protectedPath(resolve(repo.root, p), repo.root, ctx.protect)
      if (why) { appendEvent(repo, {source: 'pre', tool, wrapper: 'BLOCK', reason: why, path: p}); return block(`writing ${p} is not allowed: ${why}. Ask the human.`) }
    }
  }
  if (SHELL_TOOLS.has(tool)) {
    const cmd = String(ti.command ?? '')
    const hd = tool === 'Bash' ? K.parseSafeHeredocCommit(cmd.trim()) : null
    const why = K.protectedCommand(hd ? hd.prefix : cmd, ctx.protect)
    if (why) { appendEvent(repo, {source: 'pre', tool, wrapper: 'BLOCK', reason: why}); return block(`${why}. Ask the human.`) }
  }
  const v = decode(ctx.s.kernel)
  if (v.halted) {
    appendEvent(repo, {source: 'pre', tool, wrapper: 'PAUSE', reason: 'halted'})
    return {code: 2, msg: `PAUSE (stopbar): the session is halted (testFails=${v.testFails}, buildFails=${v.buildFails}, spent=${v.spent}/${v.capNow}). A human must run: stopbar resume --extra <n>`}
  }
  const cost = cfg.costPerCall
  if (READ_TOOLS.has(tool)) {
    const ps = [ti.file_path, ti.path, ti.glob, ti.pattern, ...(Array.isArray(ti.file_paths) ? ti.file_paths : [])].filter((x) => typeof x === 'string' && x)
    if (ps.some((p: string) => K.isSecretPath(p, cfg.paths))) step(ctx, {op: 'READ_SECRET', cost}, `pre:${tool}`)
    return {code: 0}
  }
  if (EDIT_TOOLS.has(tool)) return {code: 0} // cost and tree change are counted in PostToolUse
  if (SHELL_TOOLS.has(tool)) {
    const cmd = String(ti.command ?? '')
    const k = K.classifyBash(cmd, cfg, tool === 'PowerShell' ? 'powershell' : 'bash')
    if (k.kind === 'commit-chained') {
      appendEvent(repo, {source: 'pre', tool, wrapper: 'BLOCK', reason: `chained commit (${k.reason})`})
      return block(`run \`git commit\` / \`git push\` as a single command (${k.reason}): no &&, ;, |, redirections or $(...). ` +
        `For a multi-line message use -m "..." or exactly: git commit -m "$(cat <<'EOF'\\n<message>\\nEOF\\n)" with the quoted 'EOF' delimiter and nothing else in the command.`)
    }
    if (k.kind === 'gate-chained') {
      appendEvent(repo, {source: 'pre', tool, wrapper: 'BLOCK', reason: `chained gate command (${k.reason})`})
      return block(`run \`${k.gate}\` exactly as configured, alone: no ;, &&, ||, |, redirections or $(...). Chained operators hide its exit status.`)
    }
    if (k.kind === 'build' || k.kind === 'fulltest') return {code: 0} // the result is recorded in PostToolUse
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
    if (k.secret) step(ctx, {op: 'READ_SECRET'}, `pre:${tool}:secret-mention`)
    const {after} = step(ctx, {op: 'SHELL', risky: k.risky, cost}, `pre:${tool}`)
    if (after.decision === 'PAUSE') {
      return {code: 2, msg: after.halted ? 'PAUSE (stopbar): budget reached; a human must run `stopbar resume --extra <n>`'
        : 'PAUSE (stopbar): risky or outbound command after a secret was read; a human must run `stopbar approve-shell` (one call)'}
    }
    return {code: 0}
  }
  if (OUTBOUND(tool)) {
    const {after} = step(ctx, {op: 'SHELL', risky: true, cost}, `pre:${tool}`)
    if (after.decision === 'PAUSE') return {code: 2, msg: `PAUSE (stopbar): ${tool} is outbound and a secret was read (or the budget is spent); a human runs \`stopbar approve-shell\` or \`stopbar resume\``}
  }
  return {code: 0}
}

// ---------------------------------------------------------------- PostToolUse / PostToolUseFailure
// Claude Code sends PostToolUse after success and PostToolUseFailure after an error (non-zero exit of Bash).
// PostToolUse carries no exit code: success unless is_error / interrupted. Failure is the event type itself.
function exitCodeOf(tr: any): number | undefined {
  if (!tr || typeof tr !== 'object') return undefined
  for (const k of ['exitCode', 'exit_code', 'returnCode', 'code']) if (typeof tr[k] === 'number') return tr[k]
  return undefined
}

function post(ctx: Ctx, input: any, failure: boolean): Out {
  const tool = String(input.tool_name ?? ''), ti = input.tool_input ?? {}
  const {repo, cfg} = ctx
  const msgs: string[] = []
  if (SHELL_TOOLS.has(tool)) {
    const k = K.classifyBash(String(ti.command ?? ''), cfg, tool === 'PowerShell' ? 'powershell' : 'bash')
    const tr = input.tool_response
    const meta = input.stopbar ?? {}
    appendEvent(repo, {source: `payload:${input.hook_event_name}`, tool, ...(meta.adapter ? {adapter: meta.adapter, rawKeys: meta.rawKeys} : {inputKeys: Object.keys(input)}),
      toolResponseKeys: tr && typeof tr === 'object' ? Object.keys(tr) : typeof tr})
    const code = exitCodeOf(tr)
    const flagged = input.is_error === true || tr?.is_error === true || tr?.interrupted === true
    // some clients send the same post event for success and failure: then only an explicit exit code 0 is a pass
    const unknown = meta.requireExitCode === true && code === undefined
    const passed = failure ? false : code !== undefined ? code === 0 : !flagged && !unknown
    const note = failure ? ' (PostToolUseFailure)' : code !== undefined ? ` (exit ${code})` : unknown ? ' (no exit code: not counted as a pass)' : ` (no exit code; is_error/interrupted=${flagged})`
    if (failure && input.is_interrupt === true) {
      // Ctrl+C by the user: not a failed gate and not a retry; the tree is still checked below
      appendEvent(repo, {source: 'post:user-interrupt', tool, kind: k.kind})
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
function stop(ctx: Ctx, input: any): Out {
  if (input.stop_hook_active) return {code: 0}
  syncTree(ctx, 0, 'stop:sync')
  if (!differsFromHead(ctx.repo, ctx.now!.entries)) return {code: 0}
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
  let input: any
  try { input = JSON.parse(raw) } catch (e) { return {code: 2, msg: `STOPBAR FAIL-CLOSED: hook input is not JSON (${(e as Error).message})`} }
  if (!input || typeof input !== 'object') return {code: 2, msg: 'STOPBAR FAIL-CLOSED: hook input must be a JSON object'}
  return runEvent(input, t0)
}

/** One normalised hook event (Claude Code's shape; adapters translate other clients into it). Never throws. */
export function runEvent(input: any, t0 = performance.now()): Out {
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
      appendEvent(repo, {source: 'hook-timing', event: ev, tool: input.tool_name, ...(input.stopbar?.adapter ? {adapter: input.stopbar.adapter} : {}), exit: res.code, gitCalls: gitCalls - g0,
        handlerMs: Math.round(performance.now() - t0), processMs: Math.round(process.uptime() * 1000)})
      return res
    })
  } catch (e) {
    return {code: 2, msg: failMsg(e)}
  }
}
