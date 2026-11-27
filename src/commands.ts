// Human commands: init, upgrade, status, approve-tests, approve-shell, resume, reset. The agent cannot run them
// through its shell (classify.ts protectedCommand) and cannot edit their files (protectedPath).
import {cpSync, existsSync, mkdirSync, rmSync} from 'node:fs'
import {join} from 'node:path'
import {hasChain, protectedCommand} from './classify.ts'
import {CLAUDE_POST_MATCHER, claudeHooks, hookCommand, installHooks, parseTargets, type Target} from './integrations.ts'
import {cliOf, type Config, ConfigError, DEFAULT_SAFE_TOOLS, makeConfig, PROFILES} from './config.ts'
import {decode, initKernel, kstep, MACHINE, type Req} from './engine.ts'
import {classifyChanges, whyBlocked} from './hook.ts'
import {CODE_PARTS, PKG_ROOT} from './pkg.ts'
import {changesSinceRef, findRepo, forgetSnapshots, hasRefTree, markCounted, type Repo, type Snap, snapshot} from './repo.ts'
import {appendEvent, paths, readConfig, readEvents, readState, type Saved, VERSION, withLock, writeConfig, writeState} from './store.ts'

export type Out = {code: number; msg?: string}

function freshWithSnap(r: Repo, c: Config): {s: Saved; snap: Snap} {
  forgetSnapshots(r)
  const params = {maxRetries: c.maxRetries, cap: c.cap}
  const snap = snapshot(r)
  markCounted(r)
  return {s: {version: 2, kernel: initKernel(params), snapshot: snap.id, params}, snap}
}
export const fresh = (r: Repo, c: Config): Saved => freshWithSnap(r, c).s

/** `init --force` and `reset` start a fresh kernel on the current working tree. Uncommitted changes of existing tests or
 *  of test config (against baseRef, else HEAD) must not vanish with the old state: they are counted as one suspicious
 *  EDIT_TEST step of the kernel (testsTainted until `stopbar approve-tests`), written to state.json and to events.jsonl
 *  with every kernel field, so `stopbar attest` stays consistent.
 *  `dirtyTests` only reads (it fails closed on a broken baseRef before anything is written); `countDirtyTests` runs under
 *  the lock, after the human:init / human:reset entry. */
type Dirty = {ref: string; suspicious: boolean; files: string[]}
function dirtyTests(r: Repo, cfg: Config, snap: Snap): Dirty {
  const ref = cfg.baseRef ?? 'HEAD'
  const cls = classifyChanges(r, cfg, changesSinceRef(r, ref, snap.entries), snap.entries)
  return {ref, suspicious: cls.suspicious, files: cls.why.filter((w) => !w.startsWith('new test') && !w.endsWith('(same as base ref)'))}
}
function countDirtyTests(r: Repo, s: Saved, d: Dirty, source: string): string[] {
  if (!d.suspicious) return []
  const req: Req = {op: 'EDIT_TEST', suspicious: true, cost: 0}
  s.kernel = kstep(s.params, s.kernel, req)
  writeState(r, s)
  const a = decode(s.kernel)
  appendEvent(r, {source, req, decision: a.decision, halted: a.halted, testsTainted: a.testsTainted,
    secretTainted: a.secretTainted, shellToken: a.shellToken, treeRev: a.treeRev, buildOkRev: a.buildOkRev, testsOkRev: a.testsOkRev,
    spent: a.spent, capNow: a.capNow, testFails: a.testFails, buildFails: a.buildFails, commitExecuted: a.commitExecuted, ref: d.ref, changes: d.files})
  return [`WARN: uncommitted test or test-config changes against ${d.ref}: ${d.files.join(', ')}`,
    `  the session starts with testsTainted = true (revision ${a.treeRev}); a commit stays blocked until a human reviews them and runs \`stopbar approve-tests\``]
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
  // the .d.ts files in dist/ only type the tests (npm run typecheck); the runtime never loads them
  for (const n of ['bin', 'dist']) cpSync(join(PKG_ROOT, n), join(dst, n), {recursive: true, filter: (f) => !f.endsWith('.d.ts')})
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
  for (const f of ['cli', 'stop-gate', 'hooks']) if (o.has(f) && o.get(f) === undefined) return {code: 1, msg: `--${f} needs a value`}
  let cfg: Config
  try {
    cfg = makeConfig({buildCmd, fullTestCmd, profile: o.get('profile'), maxRetries: o.int('max-retries', 3), cap: o.int('cap', 500), costPerCall: o.int('cost', 1), baseRef: o.get('base-ref'),
      cliCmd: o.get('cli'), stopGate: o.get('stop-gate'), requireRun: o.has('require-run')})
  } catch (e) { if (e instanceof ConfigError) return {code: 1, msg: e.message}; throw e }
  if (existsSync(paths(repo).config) && !o.has('force')) return {code: 1, msg: `already initialised (${paths(repo).config}); use --force to replace config and state`}
  const pin = !o.has('no-pin')
  if (cfg.cliCmd) {
    // the hint `<cli> run test` must pass self-protection with the runtime the hooks will use
    const rt = pin ? join(repo.stateDir, 'runtime') : PKG_ROOT
    const protect = {gitDir: repo.gitDir, stateDir: repo.stateDir, codeDirs: CODE_PARTS.map((n) => join(rt, n))}
    const why = protectedCommand(`${cfg.cliCmd} run test`, protect)
    if (why) return {code: 1, msg: `--cli ${JSON.stringify(cfg.cliCmd)}: the agent could not run \`${cfg.cliCmd} run test\` (${why}); point --cli at a Stopbar install outside the hook runtime`}
  }
  if (cfg.baseRef && !hasRefTree(repo.root, cfg.baseRef)) {
    return {code: 1, msg: `--base-ref ${JSON.stringify(cfg.baseRef)} does not resolve to a commit/tree in ${repo.root}`}
  }
  const hooksOpt = o.get('hooks')
  const named = hooksOpt === undefined ? [] : parseTargets(hooksOpt) // validated before anything is written
  if (o.has('no-git-hooks') && named.includes('git')) return {code: 1, msg: '--no-git-hooks and --hooks ...git exclude each other'}
  // the git hooks close what an agent hook cannot see (git aliases, merge, cherry-pick, am, commit-tree before a push):
  // added to every --hooks <client> unless --no-git-hooks
  const gitByDefault = named.length > 0 && !named.includes('git') && !o.has('no-git-hooks')
  const targets: Target[] = gitByDefault ? [...named, 'git'] : named
  mkdirSync(repo.stateDir, {recursive: true})
  return withLock(repo, () => {
    const {s, snap} = freshWithSnap(repo, cfg)
    const dirty = dirtyTests(repo, cfg, snap)
    writeConfig(repo, cfg)
    writeState(repo, s)
    const runtime = pin ? pinRuntime(repo) : PKG_ROOT
    const command = hookCommand(runtime)
    appendEvent(repo, {source: 'human:init', cfg, runtime, version: VERSION, kernel: MACHINE, ...(targets.length ? {hooks: targets} : {})})
    const warn = countDirtyTests(repo, s, dirty, 'init:dirty-tests')
    const lines = [`Stopbar ${VERSION} initialised in ${repo.stateDir}`, `  profile ${cfg.profile}; build: ${cfg.buildCmd}; full tests: ${cfg.fullTestCmd}${cfg.baseRef ? `; base ref: ${cfg.baseRef}` : ''}`,
      `  stop gate: ${cfg.stopGate ?? 'block'}; gate hints use: ${cliOf(cfg)} run build|test${cfg.requireRun ? '; requireRun: true (gates count only through stopbar run build|test)' : ''}`,
      `  hooks run: ${command}`]
    const warns: string[] = []
    if (targets.length) for (const l of installHooks(repo, targets, runtime, o.has('force-hooks'), {gitByDefault, warn: (w) => warns.push(w)})) lines.push(`  hooks written: ${l}`)
    else lines.push('  add these hooks to .claude/settings.local.json (or run init again with --hooks claude,cursor,codex,gemini,antigravity,git):', JSON.stringify(hooksConfig(command), null, 2))
    if (gitByDefault) lines.push('  git hooks (pre-commit, pre-push) were added to --hooks by default; pass --no-git-hooks to skip them')
    else if (named.length && o.has('no-git-hooks')) lines.push('  WARN: --no-git-hooks: git aliases, merge, cherry-pick, am and commit-tree are not gated before a push; stopbar doctor reports it')
    lines.push(...warns.map((w) => `  ${w}`), ...warn, 'Next: restart the agent in this repository and run `stopbar doctor`.')
    return {code: 0, msg: lines.join('\n')}
  })
}

/** `stopbar upgrade`: re-pins the hook runtime (<git-dir>/stopbar/runtime) from this package and, with --hooks, rewrites
 *  the hook configuration. state.json, config.json and the snapshots stay as they are (revision, gates, taint, budget), so
 *  active sessions keep their green gates. The log entry has no `req`: it is no kernel step and attest stays consistent. */
export function upgrade(o: Opts): Out {
  const repo = findRepo(o.get('repo') ?? process.cwd())
  const hooksOpt = o.get('hooks')
  if (o.has('hooks') && hooksOpt === undefined) return {code: 1, msg: '--hooks needs a value'}
  const targets = hooksOpt === undefined ? [] : parseTargets(hooksOpt) // validated before anything is written
  return withLock(repo, () => {
    const cfg = readConfig(repo)
    readState(repo) // a missing or damaged state fails closed here, with the fix
    const had = existsSync(join(repo.stateDir, 'runtime'))
    const runtime = pinRuntime(repo)
    appendEvent(repo, {source: 'human:upgrade', version: VERSION, runtime, kernel: MACHINE, ...(targets.length ? {hooks: targets} : {})})
    const lines = [`Stopbar ${VERSION}: hook runtime re-pinned in ${runtime}`, '  state.json, config.json and the snapshots are unchanged (revision, gates, taint, budget)']
    if (targets.length) for (const l of installHooks(repo, targets, runtime, o.has('force-hooks'))) lines.push(`  hooks written: ${l}`)
    else if (!had) lines.push(`  there was no pinned runtime (init --no-pin): the hooks still run what they ran; add --hooks <targets> to point them at ${hookCommand(runtime)}`)
    const missing = DEFAULT_SAFE_TOOLS.filter((t) => !(cfg.safeTools ?? DEFAULT_SAFE_TOOLS).includes(t))
    if (missing.length) lines.push(`  hint: config.safeTools lacks the default ${missing.join(', ')}; a human adds them to config.json (stopbar doctor shows it)`)
    lines.push('Next: run `stopbar doctor`.')
    return {code: 0, msg: lines.join('\n')}
  })
}

/** Why the secret gate is on: the first secret read since the last init or reset, from the event log. */
export function secretReason(repo: Repo): {text: string; pattern?: string; path?: string; tool?: string; revision?: number} | null {
  const ev = readEvents(repo).events
  let start = 0
  ev.forEach((e, i) => { if (e.source === 'human:init' || e.source === 'human:reset') start = i + 1 })
  const hit = ev.slice(start).find((e) => e.req?.op === 'READ_SECRET' && e.secretTainted === true)
  if (!hit) return null
  if (!hit.secret) return {text: `${hit.source} at rev ${hit.treeRev} (pattern not recorded)`, revision: hit.treeRev}
  const {pattern, path, tool} = hit.secret
  return {text: `matched ${pattern} (${path}) in ${tool} at rev ${hit.treeRev}`, pattern, path, tool, revision: hit.treeRev}
}

/** `now`: the working tree as it is now. A change no hook has counted yet (now.id !== s.snapshot) keeps a commit blocked
 *  at the next hook (pre:commit-sync), so status never says `allowed` then. */
function statusText(repo: Repo, cfg: Config, s: Saved, now: Snap, differs: boolean | null): string {
  const v = decode(s.kernel)
  const yn = (b: boolean) => (b ? 'yes' : 'no')
  const ok = (rev: number) => (rev === v.treeRev ? `ok at revision ${rev}` : 'not at the current revision')
  const uncounted = now.id !== s.snapshot
  const green = v.buildOkRev === v.treeRev && v.testsOkRev === v.treeRev && !v.testsTainted
  const commit = v.halted ? 'blocked: session halted' : !green ? `blocked: ${whyBlocked(v, cfg)}`
    : uncounted ? 'blocked: uncommitted working-tree changes not yet counted (run build and full tests on the current tree)' : 'allowed'
  const torn = readEvents(repo).torn.length
  return [
    `Stopbar ${VERSION}   repo ${repo.root}`,
    `revision   ${v.treeRev}   (tree ${s.snapshot.slice(0, 12)})${cfg.baseRef ? `   base ref ${cfg.baseRef}` : ''}`,
    ...(uncounted ? [`           working tree has uncounted changes since revision ${v.treeRev}; gates will be re-checked on the next hook`] : []),
    `build      ${ok(v.buildOkRev)}      (${cfg.buildCmd})`,
    `full tests ${ok(v.testsOkRev)}      (${cfg.fullTestCmd})`,
    `tainted    ${yn(v.testsTainted)}   secret read ${v.secretTainted ? `yes (${secretReason(repo)?.text ?? 'reason not in the event log'})` : 'no'}   shell approval held ${yn(v.shellToken)}`,
    ...(differs === false ? [`note: no existing test or test-config file currently differs from ${cfg.baseRef}; if ${cfg.baseRef} advanced after the previous task, a human can run \`stopbar reset\` (or \`stopbar approve-tests\`)`] : []),
    `session    ${v.halted ? 'HALTED' : 'running'}   spent ${v.spent}/${v.capNow}   test failures ${v.testFails}/${s.params.maxRetries}   build failures ${v.buildFails}/${s.params.maxRetries}`,
    `commit     ${commit}`,
    `stop gate  ${cfg.stopGate ?? 'block'}${cfg.stopGate === 'warn' ? '   (Stop only warns; git commit and git push stay blocked until the gates pass)' : ''}`,
    ...(cfg.requireRun ? ['requireRun true   (the build and full test gates count only through stopbar run build|test)'] : []),
    ...(torn ? [`event log  ${torn} torn line(s) kept as they are (see stopbar doctor)`] : []),
  ].join('\n')
}

export function human(cmd: string, o: Opts): Out {
  const repo = findRepo(o.get('repo') ?? process.cwd())
  const cfg = readConfig(repo)
  return withLock(repo, () => {
    if (cmd === 'reset') {
      const {s, snap} = freshWithSnap(repo, cfg)
      const dirty = dirtyTests(repo, cfg, snap)
      writeState(repo, s)
      appendEvent(repo, {source: 'human:reset'})
      const warn = countDirtyTests(repo, s, dirty, 'reset:dirty-tests')
      return {code: 0, msg: ['Stopbar state reset: run the build and the full test suite again before a commit', ...warn].join('\n')}
    }
    const s = readState(repo)
    if (cmd === 'status') {
      // the working tree now (read-only for state.json, as in attest: only the private snapshot index is refreshed)
      const now = snapshot(repo)
      // testsTainted with a baseRef: does the tree still change an existing test or test config against it? A hint for
      // the human only (e.g. baseRef absorbed the change); the taint itself stays until reset or approve-tests (L2.2).
      // Read-only; a baseRef that no longer resolves fails closed, as in the hooks.
      const differs = decode(s.kernel).testsTainted && cfg.baseRef && cfg.baseRef !== 'HEAD' ? dirtyTests(repo, cfg, now).suspicious : null
      return {code: 0, msg: o.has('json') ? JSON.stringify({version: VERSION, repo: repo.root, stateDir: repo.stateDir, config: cfg, stopGate: cfg.stopGate ?? 'block', ...(cfg.requireRun ? {requireRun: true} : {}), snapshot: s.snapshot, params: s.params, kernel: decode(s.kernel),
        secretRead: decode(s.kernel).secretTainted ? secretReason(repo) : null, workingTreeSnapshot: now.id, workingTreeCounted: now.id === s.snapshot, taintedDiffersFromBaseRef: differs}, null, 1) : statusText(repo, cfg, s, now, differs)}
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
