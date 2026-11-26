// Human commands: init, status, approve-tests, approve-shell, resume, reset. The agent cannot run them
// through its shell (classify.ts protectedCommand) and cannot edit their files (protectedPath).
import {cpSync, existsSync, mkdirSync, rmSync} from 'node:fs'
import {join} from 'node:path'
import {hasChain} from './classify.ts'
import {CLAUDE_POST_MATCHER, claudeHooks, hookCommand, installHooks, parseTargets} from './integrations.ts'
import {type Config, ConfigError, makeConfig, PROFILES} from './config.ts'
import {decode, initKernel, kstep, MACHINE, type Req} from './engine.ts'
import {whyBlocked} from './hook.ts'
import {PKG_ROOT} from './pkg.ts'
import {findRepo, forgetSnapshots, markCounted, type Repo, snapshot} from './repo.ts'
import {appendEvent, paths, readConfig, readEvents, readState, type Saved, VERSION, withLock, writeConfig, writeState} from './store.ts'

export type Out = {code: number; msg?: string}

export function fresh(r: Repo, c: Config): Saved {
  forgetSnapshots(r)
  const params = {maxRetries: c.maxRetries, cap: c.cap}
  const snap = snapshot(r)
  markCounted(r)
  return {version: 2, kernel: initKernel(params), snapshot: snap.id, params}
}

function humanStep(r: Repo, s: Saved, req: Req, source: string) {
  s.kernel = kstep(s.params, s.kernel, req)
  const after = decode(s.kernel)
  appendEvent(r, {source, req, decision: after.decision, halted: after.halted, testsTainted: after.testsTainted,
    shellToken: after.shellToken, treeRev: after.treeRev, spent: after.spent, capNow: after.capNow,
    testFails: after.testFails, buildFails: after.buildFails})
  return after
}

// ---------------------------------------------------------------- hooks config (Claude Code; other clients in integrations.ts)
export const HOOK_MATCHERS = {post: CLAUDE_POST_MATCHER}
export {hookCommand}
export const hooksConfig = (command: string) => ({hooks: claudeHooks(command)})
/** Frozen copy of the runtime (bin/, dist/, package.json) in <git-dir>/stopbar/runtime. The hooks run this copy, so an
 *  agent that edits or rebuilds a Stopbar checkout cannot change the code that judges it. No node_modules needed. */
export function pinRuntime(r: Repo): string {
  const dst = join(r.stateDir, 'runtime')
  rmSync(dst, {recursive: true, force: true})
  mkdirSync(dst, {recursive: true})
  for (const n of ['bin', 'dist']) cpSync(join(PKG_ROOT, n), join(dst, n), {recursive: true})
  for (const n of ['package.json', 'LICENSE']) if (existsSync(join(PKG_ROOT, n))) cpSync(join(PKG_ROOT, n), join(dst, n))
  return dst
}

// ---------------------------------------------------------------- commands
type Opts = {get: (name: string) => string | undefined; int: (name: string, def: number) => number; has: (name: string) => boolean}

export function init(o: Opts): Out {
  const repo = findRepo(o.get('repo') ?? process.cwd())
  const buildCmd = o.get('build') ?? '', fullTestCmd = o.get('test') ?? ''
  if (!buildCmd.trim() || !fullTestCmd.trim()) return {code: 1, msg: 'init needs --build "<cmd>" and --test "<cmd>"'}
  for (const [k, v] of [['--build', buildCmd], ['--test', fullTestCmd]]) {
    if (hasChain(v)) return {code: 1, msg: `${k} ${JSON.stringify(v)} has shell operators; put it in one script (e.g. an npm script) so its exit status is the gate`}
  }
  if (existsSync(paths(repo).config) && !o.has('force')) return {code: 1, msg: `already initialised (${paths(repo).config}); use --force to replace config and state`}
  let cfg: Config
  try {
    cfg = makeConfig({buildCmd, fullTestCmd, profile: o.get('profile'), maxRetries: o.int('max-retries', 3), cap: o.int('cap', 500), costPerCall: o.int('cost', 1)})
  } catch (e) { if (e instanceof ConfigError) return {code: 1, msg: e.message}; throw e }
  const hooksOpt = o.get('hooks')
  const targets = hooksOpt === undefined ? [] : parseTargets(hooksOpt) // validated before anything is written
  mkdirSync(repo.stateDir, {recursive: true})
  return withLock(repo, () => {
    writeConfig(repo, cfg)
    writeState(repo, fresh(repo, cfg))
    const pin = !o.has('no-pin')
    const runtime = pin ? pinRuntime(repo) : PKG_ROOT
    const command = hookCommand(runtime)
    appendEvent(repo, {source: 'human:init', cfg, runtime, version: VERSION, kernel: MACHINE})
    const lines = [`Stopbar ${VERSION} initialised in ${repo.stateDir}`, `  profile ${cfg.profile}; build: ${cfg.buildCmd}; full tests: ${cfg.fullTestCmd}`,
      `  hooks run: ${command}`]
    if (targets.length) for (const l of installHooks(repo, targets, runtime, o.has('force-hooks'))) lines.push(`  hooks written: ${l}`)
    else lines.push('  add these hooks to .claude/settings.local.json (or run init again with --hooks claude,cursor,codex,gemini,antigravity,git):', JSON.stringify(hooksConfig(command), null, 2))
    lines.push('Next: restart the agent in this repository and run `stopbar doctor`.')
    return {code: 0, msg: lines.join('\n')}
  })
}

function statusText(repo: Repo, cfg: Config, s: Saved): string {
  const v = decode(s.kernel)
  const yn = (b: boolean) => (b ? 'yes' : 'no')
  const ok = (rev: number) => (rev === v.treeRev ? `ok at revision ${rev}` : 'not at the current revision')
  const commit = v.halted ? 'blocked: session halted' : v.buildOkRev === v.treeRev && v.testsOkRev === v.treeRev && !v.testsTainted ? 'allowed' : `blocked: ${whyBlocked(v, cfg)}`
  const torn = readEvents(repo).torn.length
  return [
    `Stopbar ${VERSION}   repo ${repo.root}`,
    `revision   ${v.treeRev}   (tree ${s.snapshot.slice(0, 12)})`,
    `build      ${ok(v.buildOkRev)}      (${cfg.buildCmd})`,
    `full tests ${ok(v.testsOkRev)}      (${cfg.fullTestCmd})`,
    `tainted    ${yn(v.testsTainted)}   secret read ${yn(v.secretTainted)}   shell approval held ${yn(v.shellToken)}`,
    `session    ${v.halted ? 'HALTED' : 'running'}   spent ${v.spent}/${v.capNow}   test failures ${v.testFails}/${s.params.maxRetries}   build failures ${v.buildFails}/${s.params.maxRetries}`,
    `commit     ${commit}`,
    ...(torn ? [`event log  ${torn} torn line(s) kept as they are (see stopbar doctor)`] : []),
  ].join('\n')
}

export function human(cmd: string, o: Opts): Out {
  const repo = findRepo(o.get('repo') ?? process.cwd())
  const cfg = readConfig(repo)
  return withLock(repo, () => {
    if (cmd === 'reset') {
      writeState(repo, fresh(repo, cfg))
      appendEvent(repo, {source: 'human:reset'})
      return {code: 0, msg: 'Stopbar state reset: run the build and the full test suite again before a commit'}
    }
    const s = readState(repo)
    if (cmd === 'status') {
      return {code: 0, msg: o.has('json') ? JSON.stringify({version: VERSION, repo: repo.root, stateDir: repo.stateDir, config: cfg, snapshot: s.snapshot, params: s.params, kernel: decode(s.kernel)}, null, 1) : statusText(repo, cfg, s)}
    }
    let res: Out
    if (cmd === 'approve-tests') {
      const cur = decode(s.kernel)
      const rev = o.int('rev', cur.treeRev)
      const after = humanStep(repo, s, {op: 'APPROVE_TESTS', approveRev: rev}, 'human:approve-tests')
      res = after.decision === 'ALLOW' ? {code: 0, msg: `approved: test changes up to revision ${rev}; tainted=${after.testsTainted}`}
        : {code: 1, msg: after.halted ? 'refused: the session is halted; run `stopbar resume` first' : `refused: revision ${rev} is not the current revision ${after.treeRev}`}
    } else if (cmd === 'approve-shell') {
      const after = humanStep(repo, s, {op: 'APPROVE_SHELL'}, 'human:approve-shell')
      res = after.shellToken ? {code: 0, msg: 'approved: one risky or outbound call'} : {code: 1, msg: 'refused: the session is halted; run `stopbar resume` first'}
    } else if (cmd === 'resume') {
      const after = humanStep(repo, s, {op: 'RESUME', extra: o.int('extra', 0)}, 'human:resume')
      res = {code: 0, msg: `resumed: budget ${after.spent}/${after.capNow}, failure counters reset`}
    } else return {code: 1, msg: `unknown command ${cmd}`}
    writeState(repo, s)
    return res
  })
}

export const profiles = () => Object.keys(PROFILES)
