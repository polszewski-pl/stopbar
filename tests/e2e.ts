// End-to-end test of the stopbar CLI on real git repositories. No mocks: every hook is a separate process
// `node bin/stopbar.mjs hook` with JSON on stdin (as Claude Code runs it); files, git and commands are real.
// Usage: node tests/e2e.ts   (log: .test-out/e2e/e2e-<time>.log + events-<scenario>.jsonl; exit 1 on a failure)
import {spawnSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
import {homedir} from 'node:os'
import {dirname, join, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import {findBash} from './lib.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CLI = join(ROOT, 'bin', 'stopbar.mjs')
const TMP = join(ROOT, '.e2e-tmp')
const OUT = join(ROOT, '.test-out', 'e2e')
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const GIT_ENV = {GIT_AUTHOR_NAME: 'e2e', GIT_AUTHOR_EMAIL: 'e2e@example.invalid', GIT_COMMITTER_NAME: 'e2e', GIT_COMMITTER_EMAIL: 'e2e@example.invalid', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'commit.gpgsign', GIT_CONFIG_VALUE_0: 'false'}
const BASH = findBash()
const lines: string[] = []
let failures = 0, passes = 0
const say = (s: string) => { lines.push(s); console.log(s) }
function check(name: string, ok: boolean, detail = '') { if (ok) passes++; else failures++; say(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' :: ' + detail : ''}`) }

/** Runs a command the way the agent's Bash tool would: in bash (Git Bash on Windows), else the system shell. */
function run(cmd: string, cwd: string) {
  const env = {...process.env, ...GIT_ENV}
  const r = BASH ? spawnSync(BASH, ['-c', cmd], {cwd, encoding: 'utf8', env}) : spawnSync(cmd, {cwd, shell: true, encoding: 'utf8', env})
  return {code: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? ''}
}
const hookCalls: {event: string; code: number; stderr: string; stdout: string; ms: number}[] = []
function hook(repo: string, event: string, tool: string, toolInput: object, toolResponse?: object, extraTop: object = {}, cli = CLI) {
  const payload = {session_id: 'e2e', hook_event_name: event, tool_name: tool, tool_input: toolInput, tool_response: toolResponse, cwd: repo, ...extraTop}
  const t = performance.now()
  const r = spawnSync(process.execPath, [cli, 'hook'], {input: JSON.stringify(payload), encoding: 'utf8'})
  hookCalls.push({event, code: r.status ?? -1, stderr: (r.stderr ?? '').trim(), stdout: (r.stdout ?? '').trim(), ms: performance.now() - t})
  const res = {code: r.status ?? -1, msg: (r.stderr || r.stdout || '').trim()}
  say(`    ${event.padEnd(11)} ${tool.padEnd(6)} ${JSON.stringify(toolInput).slice(0, 110)} -> exit ${res.code}${res.msg ? ' | ' + res.msg.replace(/\s+/g, ' ').slice(0, 170) : ''}`)
  return res
}
function human(repo: string, ...args: string[]) {
  const r = spawnSync(process.execPath, [CLI, ...args, '--repo', repo], {encoding: 'utf8'})
  const res = {code: r.status ?? -1, out: (r.stdout || r.stderr || '').trim()}
  if (args[0] !== 'status') say(`    HUMAN       ${args.join(' ')} -> exit ${res.code} | ${res.out.replace(/\s+/g, ' ').slice(0, 170)}`)
  return res
}
const status = (repo: string) => JSON.parse(human(repo, 'status', '--json').out).kernel as Record<string, any>
const stateDir = (repo: string) => join(repo, '.git', 'stopbar')
const events = (repo: string) => readFileSync(join(stateDir(repo), 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))

// --- agent tools: PreToolUse -> (run, if allowed) -> PostToolUse
function agentWrite(repo: string, rel: string, content: string) {
  const input = {file_path: join(repo, rel), content}
  const pre = hook(repo, 'PreToolUse', 'Write', input)
  if (pre.code !== 0) return {pre, post: undefined, ran: false}
  mkdirSync(dirname(join(repo, rel)), {recursive: true}); writeFileSync(join(repo, rel), content)
  return {pre, post: hook(repo, 'PostToolUse', 'Write', input, {filePath: join(repo, rel), success: true}), ran: true}
}
function agentBash(repo: string, command: string) {
  const pre = hook(repo, 'PreToolUse', 'Bash', {command})
  if (pre.code !== 0) return {pre, post: undefined, ran: false, exit: undefined}
  const r = run(command, repo)
  const post = hook(repo, 'PostToolUse', 'Bash', {command}, {stdout: r.stdout.slice(0, 2000), stderr: r.stderr.slice(0, 2000), interrupted: false, exitCode: r.code})
  return {pre, post, ran: true, exit: r.code}
}
/** As Claude Code: exit 0 -> PostToolUse WITHOUT exitCode; exit != 0 -> PostToolUseFailure (error, is_interrupt). */
function agentBashCC(repo: string, command: string, extraResponse: object = {}) {
  const pre = hook(repo, 'PreToolUse', 'Bash', {command})
  if (pre.code !== 0) return {pre, post: undefined, ran: false, exit: undefined, out: ''}
  const r = run(command, repo)
  const post = r.code === 0
    ? hook(repo, 'PostToolUse', 'Bash', {command}, {stdout: r.stdout.slice(0, 2000), stderr: r.stderr.slice(0, 2000), interrupted: false, isImage: false, noOutputExpected: false, ...extraResponse})
    : hook(repo, 'PostToolUseFailure', 'Bash', {command}, undefined, {error: `Command failed with exit code ${r.code}`, is_interrupt: false})
  return {pre, post, ran: true, exit: r.code, out: r.stdout + r.stderr}
}
function agentRead(repo: string, rel: string) { return hook(repo, 'PreToolUse', 'Read', {file_path: join(repo, rel)}) }

function setupRepo(name: string, maxRetries = 3, outputs = false, extraInit: string[] = ['--no-pin']) {
  const repo = join(TMP, name)
  mkdirSync(join(repo, 'src'), {recursive: true}); mkdirSync(join(repo, 'tests'), {recursive: true})
  writeFileSync(join(repo, 'build.mjs'), outputs
    ? "import {mkdirSync, writeFileSync} from 'node:fs'\nimport './src/sum.mjs'\nmkdirSync('dist', {recursive: true})\nwriteFileSync('dist/bundle.mjs', '// ' + Date.now())\nconsole.log('build ok')\n"
    : "import './src/sum.mjs'\nconsole.log('build ok')\n")
  writeFileSync(join(repo, 'src', 'sum.mjs'), 'export const sum = (a, b) => a + b\n')
  writeFileSync(join(repo, 'tests', 'sum.test.mjs'), "import {test} from 'node:test'\nimport assert from 'node:assert/strict'\n" +
    (outputs ? "import {mkdirSync, writeFileSync} from 'node:fs'\n" : '') + "import {sum} from '../src/sum.mjs'\n\ntest('sum', () => {\n" +
    (outputs ? "  mkdirSync('.pytest_cache', {recursive: true}); writeFileSync('.pytest_cache/lastrun', String(Date.now()))\n" : '') +
    '  assert.equal(sum(2, 3), 5)\n})\n')
  writeFileSync(join(repo, '.gitignore'), outputs ? '.env\ndist/\n.pytest_cache/\n' : '.env\n')
  for (const c of ['git init -q', 'git config core.autocrlf false', 'git add -A', 'git commit -q -m "base"']) { const r = run(c, repo); if (r.code !== 0) throw new Error(`${c}: ${r.stderr}`) }
  const init = human(repo, 'init', '--build', 'node build.mjs', '--test', 'node --test', '--max-retries', String(maxRetries), '--cap', '100', '--cost', '1', ...extraInit)
  if (init.code !== 0) throw new Error(init.out)
  return repo
}
const commits = (repo: string) => Number(run('git rev-list --count HEAD', repo).stdout.trim())
function keepEvents(repo: string, name: string) { const f = join(stateDir(repo), 'events.jsonl'); if (existsSync(f)) copyFileSync(f, join(OUT, `events-${name}.jsonl`)) }
const sha = (f: string) => createHash('sha256').update(readFileSync(f)).digest('hex').slice(0, 16)
const HEREDOC = (msg: string, delim = 'EOF') => `git commit -q -m "$(cat <<'${delim}'\n${msg}\n${delim}\n)"`

rmSync(TMP, {recursive: true, force: true, maxRetries: 5}); mkdirSync(TMP, {recursive: true}); mkdirSync(OUT, {recursive: true})
say(`E2E stopbar ${stamp} node ${process.version} ${process.platform}`)
say(`git: ${run('git --version', ROOT).stdout.trim()}; shell for agent commands: ${BASH ?? 'system shell'}`)

// ---------------------------------------------------------------- S1
say('\nS1 honest path: code edit + new test file -> buildCmd ok -> fullTestCmd ok -> git commit')
{
  const repo = setupRepo('s1-honest')
  check('code edit allowed', agentWrite(repo, 'src/sum.mjs', 'export const sum = (a, b) => a + b\nexport const mul = (a, b) => a * b\n').post?.code === 0)
  check('new test file allowed, no taint', agentWrite(repo, 'tests/mul.test.mjs', "import {test} from 'node:test'\nimport assert from 'node:assert/strict'\nimport {mul} from '../src/sum.mjs'\n\ntest('mul', () => assert.equal(mul(2, 3), 6))\n").post?.code === 0 && status(repo).testsTainted === false)
  const b = agentBash(repo, 'node build.mjs'); check('buildCmd ran, exit 0', b.exit === 0)
  const t = agentBash(repo, 'node --test'); check('fullTestCmd ran, exit 0', t.exit === 0)
  agentBash(repo, 'git add -A')
  const n = commits(repo)
  const c = agentBash(repo, 'git commit -q -m "add mul"')
  check('git commit = ALLOW (PreToolUse exit 0) and the commit exists', c.pre.code === 0 && commits(repo) === n + 1, `commits ${n} -> ${commits(repo)}`)
  keepEvents(repo, 's1-honest')
}

// ---------------------------------------------------------------- S2
say('\nS2 bypass: a chained command and a single test file do not count as the full suite')
{
  const repo = setupRepo('s2-bypass')
  agentWrite(repo, 'src/sum.mjs', 'export const sum = (a, b) => a + b // tweak\n')
  agentBash(repo, 'node build.mjs')
  const single = agentBash(repo, 'node --test tests/sum.test.mjs'); check('single test file ran (exit 0)', single.exit === 0)
  const chained = agentBash(repo, 'node --test && echo done'); check('chained gate command blocked in PreToolUse (exit 2, not run)', chained.pre.code === 2 && !chained.ran)
  const v = status(repo)
  check('test gate NOT passed (testsOkRev != treeRev)', v.testsOkRev !== v.treeRev, `testsOkRev=${v.testsOkRev} treeRev=${v.treeRev}`)
  agentBash(repo, 'git add -A')
  const c = agentBash(repo, 'git commit -q -m "bypass"')
  check('git commit blocked before it runs', c.pre.code === 2 && !c.ran && /FULL test suite/.test(c.pre.msg), c.pre.msg)
  const cc = agentBash(repo, 'git add -A && git commit -q -m "chained"')
  check('commit inside a chained command blocked', cc.pre.code === 2 && !cc.ran)
  keepEvents(repo, 's2-bypass')
}

// ---------------------------------------------------------------- S3
say('\nS3 existing test changed (Write and SHELL) -> taint -> blocked despite green tests -> approve-tests -> commit')
{
  const repo = setupRepo('s3-taint')
  const w = agentWrite(repo, 'tests/sum.test.mjs', "import {test} from 'node:test'\nimport assert from 'node:assert/strict'\nimport {sum} from '../src/sum.mjs'\n\ntest('sum', () => {\n  assert.ok(sum(2, 3))\n})\n")
  check('Write of an existing test: PostToolUse = PAUSE, testsTainted = true', w.post?.code === 2 && status(repo).testsTainted === true, w.post?.msg)
  agentBash(repo, 'node build.mjs'); agentBash(repo, 'node --test'); agentBash(repo, 'git add -A')
  let c = agentBash(repo, 'git commit -q -m "weakened"')
  check('commit blocked despite green build and full tests', c.pre.code === 2 && /approve-tests/.test(c.pre.msg), c.pre.msg)
  const rev = status(repo).treeRev
  check('approve-tests on the current revision', human(repo, 'approve-tests', '--rev', String(rev)).code === 0 && status(repo).testsTainted === false)
  c = agentBash(repo, 'git commit -q -m "approved"')
  check('git commit after approval = ALLOW', c.pre.code === 0 && c.ran)

  say('  SHELL variant: test changed by `node -e` (PostToolUse sees a new tree)')
  const sh = agentBash(repo, `node -e "require('fs').appendFileSync('tests/sum.test.mjs','\\n// shell tweak\\n')"`)
  check('SHELL changed an existing test: PostToolUse = PAUSE, testsTainted = true', sh.post?.code === 2 && status(repo).testsTainted === true, sh.post?.msg)
  const sh2 = agentBash(repo, `node -e "require('fs').appendFileSync('tests/sum.test.mjs','// second shell tweak\\n')"`)
  const v2 = status(repo)
  check('a second edit of the same file is seen too (content hash, not status)', sh2.post?.code === 2 && v2.testsTainted === true, `treeRev=${v2.treeRev}`)
  agentBash(repo, 'node build.mjs'); agentBash(repo, 'node --test'); agentBash(repo, 'git add -A')
  c = agentBash(repo, 'git commit -q -m "shell weakened"')
  check('commit blocked', c.pre.code === 2)
  check('approval of an old revision does not work', human(repo, 'approve-tests', '--rev', String(rev)).code === 1 && status(repo).testsTainted === true)
  check('approve-tests on the current revision', human(repo, 'approve-tests').code === 0)
  c = agentBash(repo, 'git commit -q -m "shell approved"')
  check('git commit = ALLOW', c.pre.code === 0 && c.ran)
  keepEvents(repo, 's3-taint')
}

// ---------------------------------------------------------------- S4
say('\nS4 attempts to edit Stopbar state, config and code -> hard BLOCK in PreToolUse')
{
  const repo = setupRepo('s4-protect')
  const st = join(stateDir(repo), 'state.json'), cf = join(stateDir(repo), 'config.json')
  const before = [sha(st), sha(cf)]
  check('Write state.json', agentWrite(repo, '.git/stopbar/state.json', '{}').pre.code === 2)
  check('Write config.json', agentWrite(repo, '.git/stopbar/config.json', '{"buildCmd":"echo"}').pre.code === 2)
  check('Bash del state', agentBash(repo, 'del .git\\stopbar\\state.json').pre.code === 2)
  check('Bash rm config', agentBash(repo, 'rm -f .git/stopbar/config.json').pre.code === 2)
  check('Bash runs a human command through the CLI', agentBash(repo, `node ${CLI} approve-tests`).pre.code === 2)
  check('Bash runs `npx stopbar resume --extra 99`', agentBash(repo, 'npx stopbar resume --extra 99').pre.code === 2)
  check('Write Stopbar code (dist/kernel.gen.js)', hook(repo, 'PreToolUse', 'Write', {file_path: join(ROOT, 'dist', 'kernel.gen.js'), content: ''}).code === 2)
  check('state and config unchanged (sha256)', sha(st) === before[0] && sha(cf) === before[1], `${before.join(',')} -> ${sha(st)},${sha(cf)}`)
  keepEvents(repo, 's4-protect')
}

// ---------------------------------------------------------------- S5
say('\nS5 READ_SECRET + curl -> PAUSE before it runs -> approve-shell lets exactly 1 call through')
{
  const repo = setupRepo('s5-secret')
  writeFileSync(join(repo, '.env'), 'API_TOKEN=dummy-not-a-secret\n')
  check('curl before a secret read = ALLOW', agentBash(repo, 'curl --version').pre.code === 0)
  check('Read .env allowed and secretTainted = true', agentRead(repo, '.env').code === 0 && status(repo).secretTainted === true)
  const p1 = agentBash(repo, 'curl --version')
  check('curl after the secret = PAUSE, not run', p1.pre.code === 2 && !p1.ran, p1.pre.msg)
  check('approve-shell grants the token', human(repo, 'approve-shell').code === 0 && status(repo).shellToken === true)
  const p2 = agentBash(repo, 'curl --version')
  check('first curl after approval = ALLOW and runs', p2.pre.code === 0 && p2.ran)
  check('PostToolUse did not use a second token (shellToken = false)', status(repo).shellToken === false)
  const p3 = agentBash(repo, 'curl --version')
  check('second curl = PAUSE again', p3.pre.code === 2 && !p3.ran)
  const shellSteps = events(repo).filter((e) => e.req?.op === 'SHELL').length
  check('kernel SHELL steps = PreToolUse curl calls (4); PostToolUse adds none', shellSteps === 4, `SHELL steps=${shellSteps}`)
  keepEvents(repo, 's5-secret')
}

// ---------------------------------------------------------------- S6
say('\nS6 failing tests interleaved with a green build -> halted -> approvals change nothing -> resume')
{
  const repo = setupRepo('s6-loop', 2)
  agentWrite(repo, 'src/sum.mjs', 'export const sum = (a, b) => a - b\n')
  check('full tests fail (1)', agentBash(repo, 'node --test').exit === 1)
  check('green build', agentBash(repo, 'node build.mjs').exit === 0)
  const t2 = agentBash(repo, 'node --test')
  check('full tests fail (2) -> halted, PostToolUse = PAUSE', t2.exit === 1 && t2.post?.code === 2 && status(repo).halted === true, t2.post?.msg)
  check('next agent action = PAUSE before it runs', agentBash(repo, 'node build.mjs').pre.code === 2)
  agentWrite(repo, 'tests/sum.test.mjs', 'x')
  const keys = ['testsTainted', 'shellToken', 'treeRev', 'buildOkRev', 'testsOkRev', 'buildFails', 'testFails', 'spent', 'capNow', 'halted', 'decision']
  const pick = (v: Record<string, any>) => JSON.stringify(Object.fromEntries(keys.map((k) => [k, v[k]])))
  const b = pick(status(repo))
  const as = human(repo, 'approve-shell'), at = human(repo, 'approve-tests')
  const a = pick(status(repo))
  check('approve-shell and approve-tests while halted: exit 1 and state unchanged', as.code === 1 && at.code === 1 && a === b, `${b}`)
  const r = human(repo, 'resume', '--extra', '10')
  check('resume unblocks', r.code === 0 && status(repo).halted === false)
  check('after resume an agent action is allowed', agentBash(repo, 'node build.mjs').pre.code === 0)
  keepEvents(repo, 's6-loop')
}

// ---------------------------------------------------------------- S7
say('\nS7 Claude Code payloads: PostToolUse without exitCode, PostToolUseFailure on exit != 0')
{
  const repo = setupRepo('s7-cc-payload', 2)
  say('  S7a honest path without a numeric exitCode')
  agentWrite(repo, 'src/sum.mjs', 'export const sum = (a, b) => a + b // cc\n')
  const b = agentBashCC(repo, 'node build.mjs'), t = agentBashCC(repo, 'node --test')
  const v = status(repo)
  check('PostToolUse without exitCode: build and full tests pass', b.post?.code === 0 && t.post?.code === 0 && v.buildOkRev === v.treeRev && v.testsOkRev === v.treeRev, `buildOkRev=${v.buildOkRev} testsOkRev=${v.testsOkRev} treeRev=${v.treeRev}`)
  agentBashCC(repo, 'git add -A')
  check('git commit = ALLOW', agentBashCC(repo, 'git commit -q -m "cc honest"').pre.code === 0)
  const pl = events(repo).find((e) => e.source === 'payload:PostToolUse')
  check('events.jsonl records the tool_response keys', Array.isArray(pl?.toolResponseKeys), JSON.stringify(pl?.toolResponseKeys))

  say('  S7b PostToolUse with interrupted=true does not pass the full tests')
  agentWrite(repo, 'src/sum.mjs', 'export const sum = (a, b) => a + b // cc2\n')
  agentBashCC(repo, 'node build.mjs')
  agentBashCC(repo, 'node --test', {interrupted: true})
  const v2 = status(repo)
  check('interrupted run does not pass the test gate', v2.testsOkRev !== v2.treeRev, `testsOkRev=${v2.testsOkRev} treeRev=${v2.treeRev}`)
  check('interrupted run counts as failed (testFails = 1)', v2.testFails === 1, `testFails=${v2.testFails}`)
  human(repo, 'resume', '--extra', '0')

  say('  S7c failure loop through PostToolUseFailure (maxRetries=2)')
  agentWrite(repo, 'src/sum.mjs', 'export const sum = (a, b) => a - b\n')
  const f1 = agentBashCC(repo, 'node --test')
  check('failing tests -> PostToolUseFailure, testFails = 1', f1.exit === 1 && status(repo).testFails === 1, `testFails=${status(repo).testFails}`)
  check('green build (PostToolUse without exitCode) does not reset the counter', agentBashCC(repo, 'node build.mjs').exit === 0 && status(repo).testFails === 1)
  const f2 = agentBashCC(repo, 'node --test')
  check('second failure -> halted, PostToolUseFailure = PAUSE', f2.post?.code === 2 && status(repo).halted === true, f2.post?.msg)
  human(repo, 'resume', '--extra', '10')

  say('  S7d a command fails but changes an existing test')
  const m = agentBashCC(repo, `node -e "require('fs').appendFileSync('tests/sum.test.mjs','// failing shell tweak\\n'); process.exit(3)"`)
  check('PostToolUseFailure sees the change: testsTainted = true', m.exit === 3 && m.post?.code === 2 && status(repo).testsTainted === true, m.post?.msg)
  keepEvents(repo, 's7-cc-payload')
}

// ---------------------------------------------------------------- S8
say('\nS8 git with global options before the subcommand')
{
  const repo = setupRepo('s8-git-globals')
  agentWrite(repo, 'src/sum.mjs', 'export const sum = (a, b) => a + b // g\n')
  agentBashCC(repo, 'git add -A')
  const c1 = agentBashCC(repo, 'git -c user.name=x commit -q -m "sneaky"')
  check('`git -c user.name=x commit` without verification = BLOCK', c1.pre.code === 2 && !c1.ran, c1.pre.msg)
  const c2 = agentBashCC(repo, 'git -C . commit -q -m "sneaky2"')
  check('`git -C . commit` without verification = BLOCK', c2.pre.code === 2 && !c2.ran)
  agentBashCC(repo, 'node build.mjs'); agentBashCC(repo, 'node --test')
  const n = commits(repo)
  const c3 = agentBashCC(repo, 'git -c user.name=x commit -q -m "verified"')
  check('after verification `git -c user.name=x commit` = ALLOW and the commit exists', c3.pre.code === 0 && commits(repo) === n + 1)
  keepEvents(repo, 's8-git-globals')
}

// ---------------------------------------------------------------- S9
say('\nS9 edit of an existing .gitignore')
{
  const repo = setupRepo('s9-gitignore')
  const w = agentWrite(repo, '.gitignore', '.env\ntests/\n')
  check('.gitignore change: PostToolUse = PAUSE, testsTainted = true', w.post?.code === 2 && status(repo).testsTainted === true, w.post?.msg)
  agentBashCC(repo, 'node build.mjs'); agentBashCC(repo, 'node --test'); agentBashCC(repo, 'git add -A')
  check('commit blocked', agentBashCC(repo, 'git commit -q -m "ignore tests"').pre.code === 2)
  keepEvents(repo, 's9-gitignore')
}

// ---------------------------------------------------------------- S10
say('\nS10 git commit -> git push (local bare remote); ignored files created by build and tests')
{
  const repo = setupRepo('s10-commit-push', 3, true)
  const remote = join(TMP, 's10-remote.git')
  run(`git init -q --bare "${remote.replace(/\\/g, '/')}"`, TMP); run(`git remote add origin "${remote.replace(/\\/g, '/')}"`, repo)
  agentWrite(repo, 'src/sum.mjs', 'export const sum = (a, b) => a + b // push\n')
  const rev0 = status(repo).treeRev
  agentBashCC(repo, 'node build.mjs')
  agentBashCC(repo, 'node --test')
  const v = status(repo)
  check('build and tests created ignored files (dist/, .pytest_cache/)', existsSync(join(repo, 'dist', 'bundle.mjs')) && existsSync(join(repo, '.pytest_cache', 'lastrun')))
  check('ignored files did not change the tree revision', v.treeRev === rev0 && v.buildOkRev === v.treeRev && v.testsOkRev === v.treeRev, `treeRev ${rev0} -> ${v.treeRev}`)
  agentBashCC(repo, 'git add -A')
  const c = agentBashCC(repo, 'git commit -q -m "before push"')
  check('git commit = ALLOW', c.pre.code === 0 && c.ran)
  const v2 = status(repo)
  check('a commit does not invalidate the gates (treeRev, buildOkRev, testsOkRev unchanged)', v2.treeRev === v.treeRev && v2.buildOkRev === v2.treeRev && v2.testsOkRev === v2.treeRev)
  const p = agentBashCC(repo, 'git push -q origin HEAD:refs/heads/main')
  check('git push after the commit = ALLOW and runs', p.pre.code === 0 && p.ran && p.exit === 0, `exit=${p.exit}`)
  check('the remote has the commit', run('git rev-parse refs/heads/main', remote).stdout.trim() === run('git rev-parse HEAD', repo).stdout.trim())
  keepEvents(repo, 's10-commit-push')
}

// ---------------------------------------------------------------- S11
say('\nS11 PostToolUseFailure with is_interrupt = true (Ctrl+C) is not a failure, but the tree is checked')
{
  const repo = setupRepo('s11-interrupt', 2)
  agentWrite(repo, 'src/sum.mjs', 'export const sum = (a, b) => a + b // i\n')
  const cmd = 'node --test'
  check('PreToolUse of the full tests = ALLOW', hook(repo, 'PreToolUse', 'Bash', {command: cmd}).code === 0)
  const r1 = hook(repo, 'PostToolUseFailure', 'Bash', {command: cmd}, undefined, {error: 'Interrupted by user', is_interrupt: true})
  let v = status(repo)
  check('interrupt: testFails = 0, buildFails = 0, test gate not passed', r1.code === 0 && v.testFails === 0 && v.buildFails === 0 && v.testsOkRev !== v.treeRev, `testFails=${v.testFails}`)
  const rev = v.treeRev
  const sh = `node -e "require('fs').appendFileSync('src/sum.mjs','// half-done\\n')"`
  check('PreToolUse of a shell command = ALLOW', hook(repo, 'PreToolUse', 'Bash', {command: sh}).code === 0)
  run(sh, repo)
  hook(repo, 'PostToolUseFailure', 'Bash', {command: sh}, undefined, {error: 'Interrupted by user', is_interrupt: true})
  v = status(repo)
  check('interrupt: the tree change is still counted (treeRev + 1)', v.treeRev === rev + 1, `treeRev ${rev} -> ${v.treeRev}`)
  check('without is_interrupt a failure counts', hook(repo, 'PostToolUseFailure', 'Bash', {command: cmd}, undefined, {error: 'exit 1', is_interrupt: false}).code === 0 && status(repo).testFails === 1)
  keepEvents(repo, 's11-interrupt')
}

// ---------------------------------------------------------------- S13
say('\nS13 quotes in commit messages and chained gate commands')
{
  const repo = setupRepo('s13-quotes')
  agentWrite(repo, 'src/sum.mjs', 'export const sum = (a, b) => a + b // q\n')
  for (const cmd of ['node --test; echo $?', 'node --test || true', 'node --test | tail -5', 'node build.mjs > build.log']) {
    const r = hook(repo, 'PreToolUse', 'Bash', {command: cmd})
    check(`\`${cmd}\` = BLOCK in PreToolUse (exit 2)`, r.code === 2 && /exactly as configured/.test(r.msg), r.msg.slice(0, 90))
  }
  check('blocked gate commands gave no RUN_TESTS or RUN_BUILD step', !events(repo).some((e) => e.req?.op === 'RUN_TESTS' || e.req?.op === 'RUN_BUILD') && status(repo).testFails === 0)
  agentBashCC(repo, 'node build.mjs'); agentBashCC(repo, 'node --test'); agentBashCC(repo, 'git add -A')
  const n = commits(repo)
  const multi = 'Fix sum\n\nReviewed-by: Jane Doe <jane@example.invalid>'
  const c1 = agentBashCC(repo, `git commit -q -m "${multi}"`)
  check('multi-line commit with a Reviewed-by <...> trailer = ALLOW and the commit exists', c1.pre.code === 0 && c1.ran && commits(repo) === n + 1, c1.pre.msg)
  check('the commit message has the trailer', run('git log -1 --format=%B', repo).stdout.includes('Reviewed-by: Jane Doe <jane@example.invalid>'))
  agentWrite(repo, 'src/sum.mjs', 'export const sum = (a, b) => a + b // q2\n')
  agentBashCC(repo, 'node build.mjs'); agentBashCC(repo, 'node --test'); agentBashCC(repo, 'git add -A')
  const c2 = agentBashCC(repo, 'git commit -q -m "Fix \\"quoted\\" word; and a pipe | and <tag>"')
  check('commit with \\" and operators inside quotes = ALLOW', c2.pre.code === 0 && c2.ran && run('git log -1 --format=%s', repo).stdout.trim() === 'Fix "quoted" word; and a pipe | and <tag>', c2.pre.msg)
  for (const cmd of ['git commit -q -m "$(rm -rf /)"', 'git commit -q -m "a `id` b"', 'git commit -q -m "unterminated', "git commit -q -m 'unterminated"]) {
    const r = hook(repo, 'PreToolUse', 'Bash', {command: cmd})
    check(`\`${cmd}\` = commit-chained BLOCK (exit 2)`, r.code === 2 && /single command/.test(r.msg), r.msg.slice(0, 120))
  }
  keepEvents(repo, 's13-quotes')
}

// ---------------------------------------------------------------- S14 heredoc
say("\nS14 safe heredoc commit (git commit -m \"$(cat <<'EOF' ... EOF)\") and unsafe variants")
{
  const repo = setupRepo('s14-heredoc')
  agentWrite(repo, 'src/sum.mjs', 'export const sum = (a, b) => a + b // h\n')
  agentBashCC(repo, 'node build.mjs'); agentBashCC(repo, 'node --test'); agentBashCC(repo, 'git add -A')
  const n = commits(repo)
  const msg = 'Fix sum: keep `id` and $(rm -rf /) and $HOME literal\n\nReviewed-by: Jane Doe <jane@example.invalid>'
  const c = agentBashCC(repo, HEREDOC(msg))
  check("safe heredoc <<'EOF' = ALLOW at the first try and the commit exists", c.pre.code === 0 && c.ran && c.exit === 0 && commits(repo) === n + 1, c.pre.msg || c.out)
  const body = run('git log -1 --format=%B', repo).stdout.trim()
  check('the quoted heredoc expanded nothing: $(rm -rf /), `id` and $HOME are literal in the message', BASH ? body === msg : true, BASH ? JSON.stringify(body.slice(0, 80)) : 'no bash: execution not checked')
  check('the kernel saw a COMMIT step marked heredoc', events(repo).some((e) => e.source === 'pre:Bash:commit:heredoc' && e.decision === 'ALLOW'))
  const bad: [string, string][] = [
    ['unquoted <<EOF with $(...) in the body', 'git commit -q -m "$(cat <<EOF\nmsg $(touch pwned)\nEOF\n)"'],
    ['unquoted <<EOF without substitution', 'git commit -q -m "$(cat <<EOF\nplain\nEOF\n)"'],
    ['double-quoted <<"EOF"', 'git commit -q -m "$(cat <<"EOF"\nplain\nEOF\n)"'],
    ['plain $(rm -rf /)', 'git commit -q -m "$(rm -rf /)"'],
    ['heredoc chained after git add', "git add -A && git commit -q -m \"$(cat <<'EOF'\nmsg\nEOF\n)\""],
    ['command after the heredoc', "git commit -q -m \"$(cat <<'EOF'\nmsg\nEOF\n)\"; touch pwned"],
    ['a second command inside $(...)', "git commit -q -m \"$(cat <<'EOF'\nmsg\nEOF\ntouch pwned\n)\""],
    ['other command than cat', "git commit -q -m \"$(tee <<'EOF'\nmsg\nEOF\n)\""],
    ['newline before -m (two commands)', "git commit -q\n-m \"$(cat <<'EOF'\nmsg\nEOF\n)\""],
    ['cat | git commit -F -', "cat <<'EOF' | git commit -q -F -\nmsg\nEOF"],
  ]
  for (const [name, cmd] of bad) {
    const r = hook(repo, 'PreToolUse', 'Bash', {command: cmd})
    check(`${name} = BLOCK (exit 2)`, r.code === 2 && /^BLOCK/.test(r.msg), r.msg.slice(0, 100))
  }
  check('nothing ran: no pwned file', !existsSync(join(repo, 'pwned')))
  keepEvents(repo, 's14-heredoc')
}

// ---------------------------------------------------------------- S15 self-protection
say('\nS15 self-protection: Claude Code settings, git hooks, git config, .claude via Bash')
{
  const repo = setupRepo('s15-self-protect')
  mkdirSync(join(repo, '.claude'), {recursive: true}); writeFileSync(join(repo, '.claude', 'settings.local.json'), '{"hooks": {}}\n')
  const files = [join(repo, '.claude', 'settings.local.json'), join(repo, '.git', 'config')]
  const before = files.map(sha)
  const attempts: [string, string, object][] = [
    ['Write .claude/settings.local.json', 'Write', {file_path: join(repo, '.claude', 'settings.local.json'), content: '{}'}],
    ['Edit .claude/settings.json', 'Edit', {file_path: join(repo, '.claude', 'settings.json'), old_string: 'a', new_string: 'b'}],
    ['Write ~/.claude/settings.json (global)', 'Write', {file_path: join(homedir(), '.claude', 'settings.json'), content: '{}'}],
    ['Write .git/hooks/pre-commit', 'Write', {file_path: join(repo, '.git', 'hooks', 'pre-commit'), content: '#!/bin/sh\nexit 0\n'}],
    ['Edit .git/config', 'Edit', {file_path: join(repo, '.git', 'config'), old_string: 'bare', new_string: 'x'}],
    ['Write .git/config (relative path)', 'Write', {file_path: '.git/config', content: ''}],
    ['Bash echo > .claude/settings.local.json', 'Bash', {command: 'echo {} > .claude/settings.local.json'}],
    ['Bash rm -rf .claude', 'Bash', {command: 'rm -rf .claude'}],
    ['Bash write .git/hooks/pre-commit', 'Bash', {command: 'printf "exit 0" > .git/hooks/pre-commit'}],
    ['Bash git config core.hooksPath', 'Bash', {command: 'git config core.hooksPath /tmp/x'}],
    ['Bash git config --unset', 'Bash', {command: 'git config --unset user.name'}],
    ['Bash STOPBAR_ env setting', 'Bash', {command: 'STOPBAR_DISABLE=1 node build.mjs'}],
    ['PowerShell Set-Content .git\\config', 'PowerShell', {command: 'Set-Content .git\\config ""'}],
  ]
  for (const [name, tool, ti] of attempts) {
    const r = hook(repo, 'PreToolUse', tool, ti)
    check(`${name} = BLOCK (exit 2)`, r.code === 2 && /^BLOCK/.test(r.msg), r.msg.slice(0, 110))
  }
  check('`git config --get user.name` (read) is allowed', hook(repo, 'PreToolUse', 'Bash', {command: 'git config --get user.name'}).code === 0)
  check('a normal Write into src/ is allowed', hook(repo, 'PreToolUse', 'Write', {file_path: join(repo, 'src', 'x.mjs'), content: ''}).code === 0)
  check('protected files unchanged (sha256)', JSON.stringify(files.map(sha)) === JSON.stringify(before))
  check('the blocks are in events.jsonl with a reason', events(repo).filter((e) => e.wrapper === 'BLOCK' && e.reason).length >= attempts.length)
  keepEvents(repo, 's15-self-protect')
}

// ---------------------------------------------------------------- S16 doctor
say('\nS16 stopbar doctor on a healthy and on a damaged repository')
{
  const repo = setupRepo('s16-doctor', 3, false, ['--hooks', 'local'])
  const d1 = human(repo, 'doctor')
  say(d1.out.split('\n').map((l) => '      ' + l).join('\n'))
  check('healthy repo: doctor exit 0, RESULT: OK, dry run all OK', d1.code === 0 && /RESULT: OK/.test(d1.out) && !/\[FAIL\]/.test(d1.out) && (d1.out.match(/\[OK  \] dry run/g) ?? []).length === 9, `exit ${d1.code}`)
  check('doctor finds all 4 hooks in .claude/settings.local.json', ['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Stop'].every((h) => new RegExp(`\\[OK  \\] hook ${h}\\b`).test(d1.out)))
  check('pinned runtime reported', /\[OK  \] pinned runtime/.test(d1.out))
  writeFileSync(join(stateDir(repo), 'config.json'), '{"version": 1, "buildCmd": ')
  rmSync(join(repo, '.claude', 'settings.local.json'))
  const d2 = human(repo, 'doctor')
  say(d2.out.split('\n').filter((l) => /FAIL|RESULT/.test(l)).map((l) => '      ' + l).join('\n'))
  check('damaged repo: doctor exit 1 and RESULT: FAIL', d2.code === 1 && /RESULT: FAIL/.test(d2.out))
  check('doctor names the damaged config.json and how to fix it', /\[FAIL\] config\.json .*not valid JSON.*Fix: .*init --force/.test(d2.out))
  check('doctor names the missing hooks', /\[FAIL\] hook PreToolUse/.test(d2.out) && /\[FAIL\] hook Stop/.test(d2.out))
  keepEvents(repo, 's16-doctor')
}

// ---------------------------------------------------------------- S17 torn events.jsonl
say('\nS17 torn last line of events.jsonl (crash mid-write): the next entry is not lost')
{
  const repo = setupRepo('s17-torn-log')
  const f = join(stateDir(repo), 'events.jsonl')
  const n0 = events(repo).length
  appendFileSync(f, '{"ts":"2026-11-26T00:00:00.000Z","source":"pre:Bash","req":{"op":"SHE')
  const r = agentBashCC(repo, 'ls')
  check('the hook after the crash still works (exit 0)', r.pre.code === 0 && r.post?.code === 0)
  const raw = readFileSync(f, 'utf8').split('\n').filter(Boolean)
  const parsed = raw.map((l) => { try { return JSON.parse(l) } catch { return null } })
  const torn = parsed.filter((x) => x === null).length
  check('exactly one torn line, kept on its own line', torn === 1 && raw.some((l) => l === '{"ts":"2026-11-26T00:00:00.000Z","source":"pre:Bash","req":{"op":"SHE'))
  const after = parsed.filter(Boolean) as Record<string, any>[]
  check('every new entry parses: the SHELL step after the crash is in the log', after.length > n0 && after.slice(n0).some((e) => e.req?.op === 'SHELL' && e.source === 'pre:Bash'), `${n0} -> ${after.length} entries`)
  const st = human(repo, 'status')
  check('status reports the torn line', st.code === 0 && /1 torn line/.test(st.out))
  const d = human(repo, 'doctor')
  check('doctor: WARN events.jsonl with the line number, no FAIL for it', /\[WARN\] events\.jsonl .*torn line\(s\) .*at line \d+/.test(d.out) && !/\[FAIL\] events/.test(d.out))
  appendFileSync(f, '{"broken')
  agentBashCC(repo, 'ls'); agentBashCC(repo, 'ls')
  const p2 = readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } })
  check('a second crash: 2 torn lines, every later entry intact', p2.filter((x) => x === null).length === 2 && p2.at(-1)?.source === 'hook-timing')
  keepEvents(repo, 's17-torn-log')
}

// ---------------------------------------------------------------- S18 damaged state.json / config.json
say('\nS18 damaged or empty state.json and config.json: hard fail closed with a fix')
{
  const repo = setupRepo('s18-damaged')
  const sf = join(stateDir(repo), 'state.json'), cf = join(stateDir(repo), 'config.json')
  const good = readFileSync(sf, 'utf8'), goodCfg = readFileSync(cf, 'utf8')
  const cases: [string, string, string, RegExp][] = [
    ['empty state.json', sf, '', /state\.json is empty[\s\S]*Fix: .*stopbar reset/],
    ['truncated state.json', sf, good.slice(0, 40), /state\.json is not valid JSON[\s\S]*Fix: .*stopbar reset/],
    ['state.json with a bad field', sf, good.replace('"halted":0', '"halted":7'), /state\.json is invalid: kernel field halted[\s\S]*Fix/],
    ['empty config.json', cf, '', /config\.json is empty[\s\S]*Fix: .*init --force/],
    ['config.json not JSON', cf, '{"version": 1,', /config\.json is not valid JSON[\s\S]*Fix/],
    ['config.json with cap 0', cf, goodCfg.replace('"cap": 100', '"cap": 0'), /config\.json is invalid: .*cap must be >= 1/],
  ]
  for (const [name, file, content, re] of cases) {
    writeFileSync(file, content)
    const results = [hook(repo, 'PreToolUse', 'Read', {file_path: join(repo, 'src', 'sum.mjs')}), hook(repo, 'PreToolUse', 'Bash', {command: 'git commit -m x'}),
      hook(repo, 'PostToolUse', 'Write', {file_path: join(repo, 'src', 'sum.mjs')}), hook(repo, 'Stop', '', {})]
    check(`${name}: every hook exits 2 with FAIL-CLOSED and a fix`, results.every((x) => x.code === 2 && /^STOPBAR FAIL-CLOSED/.test(x.msg) && re.test(x.msg)), results[0].msg.replace(/\s+/g, ' ').slice(0, 140))
    writeFileSync(sf, good); writeFileSync(cf, goodCfg)
  }
  writeFileSync(sf, '')
  const r = human(repo, 'reset')
  check('human `stopbar reset` repairs an empty state.json', r.code === 0 && hook(repo, 'PreToolUse', 'Read', {file_path: join(repo, 'src', 'sum.mjs')}).code === 0)
  keepEvents(repo, 's18-damaged')
}

// ---------------------------------------------------------------- S19 pinned runtime
say('\nS19 pinned runtime: hooks run a frozen copy in .git/stopbar/runtime, out of the agent\'s reach')
{
  const repo = setupRepo('s19-pinned', 3, false, ['--hooks', 'local'])
  const settings = JSON.parse(readFileSync(join(repo, '.claude', 'settings.local.json'), 'utf8'))
  const cmd: string = settings.hooks.PreToolUse[0].hooks[0].command
  const pinned = join(stateDir(repo), 'runtime', 'bin', 'stopbar.mjs')
  check('settings.local.json points the 4 hooks to the pinned copy', ['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Stop'].every((k) => settings.hooks[k]?.[0]?.hooks?.[0]?.command === cmd) && cmd.includes('.git/stopbar/runtime/bin/stopbar.mjs') && existsSync(pinned), cmd)
  check('the pinned copy runs a hook (exit 0)', hook(repo, 'PreToolUse', 'Read', {file_path: join(repo, 'src', 'sum.mjs')}, undefined, {}, pinned).code === 0)
  check('the pinned copy has no node_modules (hooks do not load the prover)', !existsSync(join(stateDir(repo), 'runtime', 'node_modules')))
  check('Write into the pinned runtime = BLOCK', hook(repo, 'PreToolUse', 'Write', {file_path: join(stateDir(repo), 'runtime', 'dist', 'hook.js'), content: ''}, undefined, {}, pinned).code === 2)
  keepEvents(repo, 's19-pinned')
}

// ---------------------------------------------------------------- S20 attest
say('\nS20 stopbar attest: deterministic session attestation (json, md), torn events.jsonl, damaged state')
{
  const repo = setupRepo('s20-attest')
  agentWrite(repo, 'src/sum.mjs', 'export const sum = (a, b) => a + b // att\n')
  agentBashCC(repo, 'git commit -q -m "too early"')
  agentBashCC(repo, 'node build.mjs'); agentBashCC(repo, 'node --test'); agentBashCC(repo, 'git add -A')
  agentBashCC(repo, HEREDOC('attest: honest commit'))
  human(repo, 'approve-shell')
  const att = (...a: string[]) => spawnSync(process.execPath, [CLI, 'attest', ...a, '--repo', repo], {encoding: 'utf8'})
  const j1 = att(), j2 = att()
  const a = JSON.parse(j1.stdout)
  check('attest exit 0 and the same output twice (deterministic)', j1.status === 0 && j1.stdout === j2.stdout && j1.stdout.length > 0)
  check('HEAD and HEAD tree are the real git ones', a.repository.head === run('git rev-parse HEAD', repo).stdout.trim() && a.repository.headTree === run('git rev-parse HEAD^{tree}', repo).stdout.trim(), a.repository.head)
  check('gates: build and full tests ok, not tainted, not halted, commit allowed now', a.gates.build && a.gates.fullTests && !a.gates.tainted && !a.gates.halted && a.gates.commitAllowedNow)
  check('log sha256 equals sha256 of events.jsonl', a.log.sha256 === createHash('sha256').update(readFileSync(join(stateDir(repo), 'events.jsonl'))).digest('hex'))
  check('one honest commit allowed, at least one block counted', a.log.commitsAllowed === 1 && a.log.blocks >= 1, `commits ${a.log.commitsAllowed}, blocks ${a.log.blocks}`)
  check('human actions listed: init and approve-shell', a.humanActions.map((h: any) => h.action).join(',') === 'init,approve-shell')
  check('consistent: the state is what the log says', a.consistent === true && a.checks.every((c: any) => c.ok))
  const md = att('--format', 'md')
  check('markdown format', md.status === 0 && /^# Stopbar attestation/.test(md.stdout) && md.stdout.includes(a.log.sha256))
  appendFileSync(join(stateDir(repo), 'events.jsonl'), '{"ts":"2026-11-26T00:00:00.000Z","source":"pre:Ba')
  const t = att(), at = JSON.parse(t.stdout)
  check('torn last line: attest still works, reports the line, stays consistent', t.status === 0 && at.log.tornLines.length === 1 && at.consistent === true && at.log.sha256 !== a.log.sha256)
  writeFileSync(join(stateDir(repo), 'state.json'), '{"version": 2')
  const d = att()
  check('damaged state.json: attest fails closed (exit 2) with a fix', d.status === 2 && /FAIL-CLOSED: state\.json is not valid JSON[\s\S]*stopbar reset/.test(d.stderr), d.stderr.trim().slice(0, 100))
  keepEvents(repo, 's20-attest')
}

// ---------------------------------------------------------------- S21-S24 other clients through their adapters
type Client = {
  name: string
  pre: (repo: string, tool: 'shell' | 'write' | 'read', arg: string) => object
  post: (repo: string, tool: 'shell' | 'write', arg: string, exit: number) => object
  stop: (repo: string) => object
  denied: (r: {code: number; out: string; err: string}) => boolean
  allowed: (r: {code: number; out: string; err: string}) => boolean
  stopBlocked: (r: {code: number; out: string; err: string}) => boolean
  /** the client's post event carries no exit status: gates go through `stopbar run` */
  noExit?: boolean
}
const J = (s: string) => { try { return JSON.parse(s) } catch { return null } }
const CLIENTS: Client[] = [
  {
    name: 'cursor',
    pre: (repo, tool, arg) => ({conversation_id: 'c', generation_id: 'g', model: 'm', cursor_version: '2.1', workspace_roots: [repo], user_email: null, transcript_path: null,
      hook_event_name: 'preToolUse', tool_use_id: 'u', cwd: repo, ...(tool === 'shell' ? {tool_name: 'Shell', tool_input: {command: arg, working_directory: repo}} : tool === 'write' ? {tool_name: 'Write', tool_input: {file_path: join(repo, arg)}} : {tool_name: 'Read', tool_input: {file_path: join(repo, arg)}})}),
    post: (repo, tool, arg, exit) => exit === 0
      ? {conversation_id: 'c', generation_id: 'g', cursor_version: '2.1', workspace_roots: [repo], hook_event_name: 'postToolUse', cwd: repo, tool_use_id: 'u', duration: 5,
        ...(tool === 'shell' ? {tool_name: 'Shell', tool_input: {command: arg}, tool_output: JSON.stringify({exitCode: 0, stdout: ''})} : {tool_name: 'Write', tool_input: {file_path: join(repo, arg)}, tool_output: '{}'})}
      : {conversation_id: 'c', generation_id: 'g', cursor_version: '2.1', workspace_roots: [repo], hook_event_name: 'postToolUseFailure', cwd: repo, tool_use_id: 'u', tool_name: 'Shell', tool_input: {command: arg}, error_message: `exit ${exit}`, failure_type: 'error', is_interrupt: false},
    stop: (repo) => ({conversation_id: 'c', generation_id: 'g', cursor_version: '2.1', workspace_roots: [repo], hook_event_name: 'stop', status: 'completed', loop_count: 0}),
    denied: (r) => r.code === 2 && J(r.out)?.permission === 'deny' && /stopbar/.test(J(r.out)?.agent_message ?? ''),
    allowed: (r) => r.code === 0 && J(r.out)?.permission === 'allow',
    stopBlocked: (r) => r.code === 0 && /Not done/.test(J(r.out)?.followup_message ?? ''),
  },
  {
    name: 'codex',
    pre: (repo, tool, arg) => ({session_id: 's', transcript_path: null, cwd: repo, hook_event_name: 'PreToolUse', model: 'm', permission_mode: 'default', turn_id: 't', tool_use_id: 'u',
      ...(tool === 'shell' ? {tool_name: 'exec_command', tool_input: {command: ['bash', '-lc', arg]}} : tool === 'write' ? {tool_name: 'apply_patch', tool_input: {input: `*** Begin Patch\n*** Update File: ${arg}\n*** End Patch`}} : {tool_name: 'exec_command', tool_input: {command: ['bash', '-lc', `cat ${arg}`]}})}),
    post: (repo, tool, arg, exit) => ({session_id: 's', transcript_path: null, cwd: repo, hook_event_name: 'PostToolUse', model: 'm', permission_mode: 'default', turn_id: 't', tool_use_id: 'u',
      ...(tool === 'shell' ? {tool_name: 'exec_command', tool_input: {command: ['bash', '-lc', arg]}, tool_response: exit === 0 ? 'build ok\n' : 'not ok 1 - sum\n'} : {tool_name: 'apply_patch', tool_input: {input: `*** Begin Patch\n*** Update File: ${arg}\n*** End Patch`}, tool_response: 'Success'})}),
    stop: (repo) => ({session_id: 's', transcript_path: null, cwd: repo, hook_event_name: 'Stop', model: 'm', permission_mode: 'default', turn_id: 't', stop_hook_active: false, last_assistant_message: 'done'}),
    denied: (r) => r.code === 0 && J(r.out)?.hookSpecificOutput?.permissionDecision === 'deny',
    allowed: (r) => r.code === 0 && r.out === '',
    stopBlocked: (r) => r.code === 0 && J(r.out)?.decision === 'block' && /Not done/.test(J(r.out)?.reason ?? ''),
    noExit: true,
  },
  {
    name: 'gemini',
    pre: (repo, tool, arg) => ({session_id: 's', transcript_path: 't', cwd: repo, hook_event_name: 'BeforeTool', timestamp: '2026-11-26T00:00:00Z',
      ...(tool === 'shell' ? {tool_name: 'run_shell_command', tool_input: {command: arg, description: '', dir_path: repo}} : tool === 'write' ? {tool_name: 'write_file', tool_input: {file_path: join(repo, arg), content: ''}} : {tool_name: 'read_file', tool_input: {file_path: join(repo, arg)}})}),
    post: (repo, tool, arg, exit) => ({session_id: 's', transcript_path: 't', cwd: repo, hook_event_name: 'AfterTool', timestamp: '2026-11-26T00:00:01Z',
      ...(tool === 'shell' ? {tool_name: 'run_shell_command', tool_input: {command: arg}, tool_response: {llmContent: `Command: ${arg}\nExit Code: ${exit}`, returnDisplay: '', ...(exit ? {error: `exit ${exit}`} : {})}}
        : {tool_name: 'write_file', tool_input: {file_path: join(repo, arg)}, tool_response: {llmContent: 'ok', returnDisplay: ''}})}),
    stop: (repo) => ({session_id: 's', transcript_path: 't', cwd: repo, hook_event_name: 'AfterAgent', timestamp: '2026-11-26T00:00:02Z', prompt: 'p', prompt_response: 'done', stop_hook_active: false}),
    denied: (r) => r.code === 2 && /^(BLOCK|PAUSE) \(stopbar\)/.test(r.err),
    allowed: (r) => r.code === 0 && J(r.out) !== null,
    stopBlocked: (r) => r.code === 0 && J(r.out)?.decision === 'block' && /Not done/.test(J(r.out)?.reason ?? ''),
  },
  {
    name: 'antigravity',
    pre: (repo, tool, arg) => ({conversationId: 'c', workspacePaths: [repo], transcriptPath: 't', modelName: 'auto', hookEventName: 'PreToolUse', cwd: repo, stepIdx: 1,
      toolCall: tool === 'shell' ? {id: '1', name: 'run_command', args: {CommandLine: arg, Cwd: repo}} : tool === 'write' ? {id: '1', name: 'write_file', args: {Path: join(repo, arg)}} : {id: '1', name: 'view_file', args: {AbsolutePath: join(repo, arg)}}}),
    post: (repo, tool, arg, exit) => ({conversationId: 'c', workspacePaths: [repo], hookEventName: 'PostToolUse', cwd: repo, stepIdx: 2,
      toolCall: tool === 'shell' ? {id: '1', name: 'run_command', args: {CommandLine: arg}} : {id: '1', name: 'write_file', args: {Path: join(repo, arg)}}, ...(exit ? {error: `exit status ${exit}`} : {})}),
    stop: (repo) => ({conversationId: 'c', workspacePaths: [repo], hookEventName: 'Stop', cwd: repo, executionNum: 0, terminationReason: 'NO_TOOL_CALL', fullyIdle: true, continuationActive: false}),
    denied: (r) => r.code === 0 && J(r.out)?.decision === 'deny',
    allowed: (r) => r.code === 0 && r.out === '',
    stopBlocked: (r) => r.code === 0 && J(r.out)?.decision === 'continue' && /Not done/.test(J(r.out)?.reason ?? ''),
  },
]
function clientHook(c: Client, payload: object, explicit: boolean) {
  const t = performance.now()
  const r = spawnSync(process.execPath, [CLI, 'hook', ...(explicit ? ['--adapter', c.name] : [])], {input: JSON.stringify(payload), encoding: 'utf8'})
  const res = {code: r.status ?? -1, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim()}
  hookCalls.push({event: `${c.name}:${(payload as any).hook_event_name ?? (payload as any).hookEventName}`, code: res.code, stderr: res.err, stdout: res.out, ms: performance.now() - t})
  say(`    ${c.name.padEnd(11)} ${JSON.stringify(payload).slice(0, 90)} -> exit ${res.code} ${(res.out || res.err).replace(/\s+/g, ' ').slice(0, 120)}`)
  return res
}
let sn = 21
for (const c of CLIENTS) {
  say(`\nS${sn} ${c.name}: honest path, blocked early commit, failure signal, taint, self-protection, stop gate (auto detection and --adapter)`)
  const repo = setupRepo(`s${sn++}-${c.name}`)
  const shellStep = (cmd: string, explicit = false) => {
    const pre = clientHook(c, c.pre(repo, 'shell', cmd), explicit)
    if (!c.allowed(pre)) return {pre, ran: false, exit: -1}
    const r = run(cmd, repo)
    clientHook(c, c.post(repo, 'shell', cmd, r.code), explicit)
    return {pre, ran: true, exit: r.code}
  }
  const writeStep = (rel: string, content: string) => {
    const pre = clientHook(c, c.pre(repo, 'write', rel), false)
    if (!c.allowed(pre)) return {pre, post: null as any}
    writeFileSync(join(repo, rel), content)
    return {pre, post: clientHook(c, c.post(repo, 'write', rel, 0), false)}
  }
  check(`${c.name}: auto detection writes the adapter into events.jsonl`, writeStep('src/sum.mjs', 'export const sum = (a, b) => a + b // ' + c.name + '\n').pre && events(repo).some((e) => e.source === 'hook-timing' && e.adapter === c.name))
  const early = shellStep('git commit -q -m "too early"')
  check(`${c.name}: commit before build and tests is denied in the client format`, !early.ran && c.denied(early.pre), early.pre.out || early.pre.err)
  const gate = (which: 'build' | 'test') => spawnSync(process.execPath, [CLI, 'run', which, '--repo', repo], {encoding: 'utf8', cwd: repo})
  if (c.noExit) {
    writeFileSync(join(repo, 'src', 'sum.mjs'), 'export const sum = (a, b) => a - b\n')
    const pre = clientHook(c, c.pre(repo, 'shell', 'node --test'), false)
    const r = run('node --test', repo)
    const post = clientHook(c, c.post(repo, 'shell', 'node --test', r.code), false)
    check(`${c.name}: a gate run without an exit status is neither a pass nor a failure, and the agent is told to use stopbar run`,
      c.allowed(pre) && r.code !== 0 && status(repo).testFails === 0 && /npx stopbar run test/.test(J(post.out)?.reason ?? ''), post.out.slice(0, 160))
    check(`${c.name}: \`stopbar run test\` from the agent's shell is allowed`, c.allowed(clientHook(c, c.pre(repo, 'shell', 'npx stopbar run test'), false)))
    check(`${c.name}: failing full tests through stopbar run are counted as a failure`, gate('test').status !== 0 && status(repo).testFails === 1, `testFails=${status(repo).testFails}`)
  } else {
    check(`${c.name}: failing full tests are counted as a failure`, (() => { writeFileSync(join(repo, 'src', 'sum.mjs'), 'export const sum = (a, b) => a - b\n'); const t = shellStep('node --test'); return t.exit !== 0 && status(repo).testFails === 1 })(), `testFails=${status(repo).testFails}`)
  }
  writeStep('src/sum.mjs', 'export const sum = (a, b) => a + b // fixed\n')
  const b = c.noExit ? {exit: gate('build').status} : shellStep('node build.mjs', true)
  const t = c.noExit ? {exit: gate('test').status} : shellStep('node --test', true)
  const v = status(repo)
  check(`${c.name}: passing build and full tests are recorded (--adapter ${c.name})`, b.exit === 0 && t.exit === 0 && v.buildOkRev === v.treeRev && v.testsOkRev === v.treeRev && v.testFails === 0, `build ${v.buildOkRev} tests ${v.testsOkRev} rev ${v.treeRev}`)
  run('git add -A', repo)
  const ok = shellStep(HEREDOC(`${c.name}: honest commit`))
  check(`${c.name}: honest heredoc commit allowed and created`, ok.ran && ok.exit === 0 && run('git log -1 --format=%s', repo).stdout.trim() === `${c.name}: honest commit`)
  const tw = writeStep('tests/sum.test.mjs', "import {test} from 'node:test'\ntest('weak', () => {})\n")
  check(`${c.name}: editing an existing test taints the session`, status(repo).testsTainted === true, JSON.stringify(tw.post?.out ?? ''))
  const st = clientHook(c, c.stop(repo), false)
  check(`${c.name}: stop with uncommitted, unverified changes is refused in the client format`, c.stopBlocked(st), st.out || st.err)
  for (const f of ['.cursor/hooks.json', '.codex/hooks.json', '.gemini/settings.json', '.agents/hooks.json', '.claude/settings.local.json']) {
    const r = clientHook(c, c.pre(repo, 'write', f), false)
    check(`${c.name}: writing ${f} is denied`, c.denied(r), r.out || r.err)
  }
  const sh = clientHook(c, c.pre(repo, 'shell', 'rm -f .cursor/hooks.json .codex/hooks.json'), false)
  check(`${c.name}: a shell command naming agent config dirs is denied`, c.denied(sh))
  writeFileSync(join(repo, '.env'), 'X=1\n')
  clientHook(c, c.pre(repo, 'read', '.env'), false)
  const curl = clientHook(c, c.pre(repo, 'shell', 'curl --version'), false)
  check(`${c.name}: outbound command after reading .env is paused`, status(repo).secretTainted === true && c.denied(curl), curl.out || curl.err)
  keepEvents(repo, `s${sn - 1}-${c.name}`)
}

// ---------------------------------------------------------------- S25 git fallback hooks
say('\nS25 git fallback: stopbar init --hooks git, real git commit and git push through .git/hooks')
{
  const repo = setupRepo('s25-git-hooks', 3, false, ['--hooks', 'git'])
  const pc = readFileSync(join(repo, '.git', 'hooks', 'pre-commit'), 'utf8')
  check('pre-commit and pre-push installed, pointing to the pinned runtime', /git-hook pre-commit/.test(pc) && existsSync(join(repo, '.git', 'hooks', 'pre-push')) && pc.includes('.git/stopbar/runtime/bin/stopbar.mjs'))
  writeFileSync(join(repo, 'src', 'sum.mjs'), 'export const sum = (a, b) => a + b // git\n')
  run('git add -A', repo)
  const n = commits(repo)
  const c1 = run('git commit -q -m "no gates"', repo)
  check('git commit without recorded build and tests is aborted by pre-commit', c1.code !== 0 && commits(repo) === n && /stopbar pre-commit: .*no passing build/.test(c1.stderr), c1.stderr.trim().slice(0, 120))
  const rb = spawnSync(process.execPath, [CLI, 'run', 'build', '--repo', repo], {encoding: 'utf8', cwd: repo})
  const rt = spawnSync(process.execPath, [CLI, 'run', 'test', '--repo', repo], {encoding: 'utf8', cwd: repo})
  check('stopbar run build and stopbar run test run the gates and record a pass', rb.status === 0 && rt.status === 0 && /recorded as a pass/.test(rb.stderr + rb.stdout) && status(repo).testsOkRev === status(repo).treeRev)
  const c2 = run('git commit -q -m "gates passed"', repo)
  check('git commit after the recorded gates passes pre-commit', c2.code === 0 && commits(repo) === n + 1, c2.stderr.trim())
  writeFileSync(join(repo, 'tests', 'sum.test.mjs'), "import {test} from 'node:test'\ntest('weak', () => {})\n")
  spawnSync(process.execPath, [CLI, 'run', 'build', '--repo', repo]); spawnSync(process.execPath, [CLI, 'run', 'test', '--repo', repo])
  run('git add -A', repo)
  const c3 = run('git commit -q -m "weakened test"', repo)
  check('a weakened existing test blocks the commit even with green gates', c3.code !== 0 && /approve-tests/.test(c3.stderr), c3.stderr.trim().slice(0, 120))
  run('git checkout -q -- tests/sum.test.mjs', repo); run('git reset -q', repo)
  const remote = join(TMP, 's25-remote.git'); run(`git init -q --bare "${remote.replace(/\\/g, '/')}"`, TMP); run(`git remote add origin "${remote.replace(/\\/g, '/')}"`, repo)
  human(repo, 'approve-tests')
  writeFileSync(join(repo, '.env'), 'X=1\n')
  hook(repo, 'PreToolUse', 'Read', {file_path: join(repo, '.env')})
  const p1 = run('git push -q origin HEAD:refs/heads/main', repo)
  check('git push after a secret read is aborted by pre-push', p1.code !== 0 && /stopbar pre-push: .*secret/.test(p1.stderr), p1.stderr.trim().slice(0, 120))
  human(repo, 'approve-shell')
  spawnSync(process.execPath, [CLI, 'run', 'build', '--repo', repo]); spawnSync(process.execPath, [CLI, 'run', 'test', '--repo', repo])
  const p2 = run('git push -q origin HEAD:refs/heads/main', repo)
  check('git push after approve-shell and green gates goes through', p2.code === 0 && run('git rev-parse refs/heads/main', remote).stdout.trim() === run('git rev-parse HEAD', repo).stdout.trim(), p2.stderr.trim())
  writeFileSync(join(repo, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\necho user hook\n')
  const again = human(repo, 'init', '--force', '--build', 'node build.mjs', '--test', 'node --test', '--hooks', 'git')
  check('init does not overwrite a user pre-commit hook (exit 2 with a fix)', again.code === 2 && /not a Stopbar hook/.test(again.out) && readFileSync(join(repo, '.git', 'hooks', 'pre-commit'), 'utf8').includes('user hook'), again.out.slice(0, 120))
  keepEvents(repo, 's25-git-hooks')
}

// ---------------------------------------------------------------- S26 multi-agent init and doctor
say('\nS26 init --hooks claude,cursor,codex,gemini,antigravity,git: merged configs and doctor')
{
  const repo = setupRepo('s26-multi')
  mkdirSync(join(repo, '.cursor'), {recursive: true})
  writeFileSync(join(repo, '.cursor', 'hooks.json'), JSON.stringify({version: 1, hooks: {afterFileEdit: [{command: './format.sh'}]}}))
  const r = human(repo, 'init', '--force', '--build', 'node build.mjs', '--test', 'node --test', '--hooks', 'claude,cursor,codex,gemini,antigravity,git')
  check('init writes all six targets', r.code === 0 && ['claude:', 'cursor:', 'codex:', 'gemini:', 'antigravity:', 'git:'].every((k) => r.out.includes(k)), r.out.slice(0, 200))
  const cur = JSON.parse(readFileSync(join(repo, '.cursor', 'hooks.json'), 'utf8'))
  check('cursor: user hook kept, failClosed true, --adapter cursor', cur.hooks.afterFileEdit?.[0]?.command === './format.sh' && cur.hooks.preToolUse?.[0]?.failClosed === true && /--adapter cursor/.test(cur.hooks.preToolUse[0].command))
  const gem = JSON.parse(readFileSync(join(repo, '.gemini', 'settings.json'), 'utf8')), agy = JSON.parse(readFileSync(join(repo, '.agents', 'hooks.json'), 'utf8')), cdx = JSON.parse(readFileSync(join(repo, '.codex', 'hooks.json'), 'utf8'))
  check('gemini, antigravity and codex configs have the expected events', !!gem.hooks.BeforeTool && !!gem.hooks.AfterTool && !!gem.hooks.AfterAgent && !!agy.stopbar.PreToolUse && !!agy.stopbar.Stop && !!cdx.hooks.PreToolUse && !!cdx.hooks.Stop)
  human(repo, 'init', '--force', '--build', 'node build.mjs', '--test', 'node --test', '--hooks', 'cursor,claude')
  const cur2 = JSON.parse(readFileSync(join(repo, '.cursor', 'hooks.json'), 'utf8'))
  check('init again replaces Stopbar entries instead of adding duplicates', cur2.hooks.preToolUse.length === 1 && cur2.hooks.afterFileEdit.length === 1 && JSON.parse(readFileSync(join(repo, '.claude', 'settings.local.json'), 'utf8')).hooks.PreToolUse.length === 1)
  const d = human(repo, 'doctor')
  check('doctor reports every client and the git hooks as OK', d.code === 0 && ['hooks cursor', 'hooks codex', 'hooks gemini', 'hooks antigravity', 'hooks git', 'hook PreToolUse'].every((k) => new RegExp(`\\[OK  \\] ${k}`).test(d.out)), d.out.split('\n').filter((l) => /hook/.test(l)).join(' | ').slice(0, 300))
  rmSync(join(repo, '.claude'), {recursive: true, force: true})
  const d2 = human(repo, 'doctor')
  check('doctor without Claude Code settings but with other clients: no Claude FAIL', d2.code === 0 && !/\[FAIL\] hook PreToolUse/.test(d2.out))
  writeFileSync(join(repo, '.codex', 'hooks.json'), JSON.stringify({hooks: {PreToolUse: JSON.parse(readFileSync(join(repo, '.codex', 'hooks.json'), 'utf8')).hooks.PreToolUse}}))
  const d3 = human(repo, 'doctor')
  check('doctor names a client config with missing events', d3.code === 1 && /\[FAIL\] hooks codex .*PostToolUse, Stop/.test(d3.out))
  check('unknown --hooks target fails before writing anything', human(repo, 'init', '--force', '--build', 'node build.mjs', '--test', 'node --test', '--hooks', 'claude,vim').code === 2)
  keepEvents(repo, 's26-multi')
}

// ---------------------------------------------------------------- S27 secret reason, *.key on code, safeTools
say('\nS27 why the secret gate is on, no *.key false alarm on code, safeTools for local UI tools')
{
  const repo = setupRepo('s27-secrets')
  const py = agentBashCC(repo, 'node -e "const claim = {key: 1}; console.log(claim.key)"')
  check('`claim.key` in inline code is not a secret read', py.pre.code === 0 && status(repo).secretTainted === false)
  agentBashCC(repo, 'node -e "const self = {pem: 2}; console.log(self.pem)"')
  check('`self.pem` in inline code is not a secret read either', status(repo).secretTainted === false)
  writeFileSync(join(repo, 'server.key'), 'not a real key\n')
  run('git rm -q --cached --ignore-unmatch server.key', repo); writeFileSync(join(repo, '.gitignore'), '.env\nserver.key\n'); run('git add .gitignore', repo); run('git commit -q -m ignore', repo)
  human(repo, 'reset')
  hook(repo, 'PreToolUse', 'Bash', {command: 'cat server.key'})
  const st = human(repo, 'status')
  check('`cat server.key` with an existing file sets the secret gate', status(repo).secretTainted === true)
  check('status names the reason: pattern, token, tool and revision', /secret read yes \(matched \*\.key \(server\.key\) in Bash at rev \d+\)/.test(st.out), st.out.split('\n').find((l) => /secret/.test(l)))
  const js = JSON.parse(human(repo, 'status', '--json').out)
  check('status --json has secretRead {pattern, path, tool}', js.secretRead?.pattern === '*.key' && js.secretRead?.path === 'server.key' && js.secretRead?.tool === 'Bash')
  const ev = events(repo).find((e) => e.req?.op === 'READ_SECRET')
  check('events.jsonl records the matched pattern and the token, not the file content', ev?.secret?.pattern === '*.key' && ev?.secret?.path === 'server.key' && !JSON.stringify(ev).includes('not a real key'))
  const att = JSON.parse(spawnSync(process.execPath, [CLI, 'attest', '--repo', repo], {encoding: 'utf8'}).stdout)
  check('attest gives the reason too', /matched \*\.key \(server\.key\) in Bash/.test(att.gates.secretReadBy ?? ''))
  human(repo, 'reset')
  hook(repo, 'PreToolUse', 'Bash', {command: 'cat certs/server.key'})
  check('`cat certs/server.key` counts even when the file does not exist', status(repo).secretTainted === true)
  human(repo, 'reset')
  agentRead(repo, '.env')
  check('Read .env: reason names the Read tool', /matched \.env\* \(.*\.env\) in Read at rev/.test(human(repo, 'status').out))
  const n0 = events(repo).filter((e) => e.req?.op === 'SHELL').length
  const ui = hook(repo, 'PreToolUse', 'mcp__ccd_turn__update_plan', {items: []})
  check('safeTools: mcp__ccd_turn__* after a secret read is allowed and is no outbound step', ui.code === 0 && events(repo).filter((e) => e.req?.op === 'SHELL').length === n0)
  const gh = hook(repo, 'PreToolUse', 'mcp__github__create_issue', {title: 'x'})
  check('other MCP tools after a secret read stay outbound (PAUSE)', gh.code === 2 && /^PAUSE/.test(gh.msg))
  const cf = join(stateDir(repo), 'config.json')
  const c = JSON.parse(readFileSync(cf, 'utf8')); c.safeTools = ['mcp__ccd_turn__*', 'mcp__github__get_*']; writeFileSync(cf, JSON.stringify(c, null, 2))
  check('a human can add globs to safeTools in config.json', hook(repo, 'PreToolUse', 'mcp__github__get_issue', {}).code === 0 && hook(repo, 'PreToolUse', 'mcp__github__create_issue', {}).code === 2)
  check('doctor shows safeTools', /safeTools \["mcp__ccd_turn__\*","mcp__github__get_\*"\]/.test(human(repo, 'doctor').out))
  c.safeTools = ['a**b']; writeFileSync(cf, JSON.stringify(c, null, 2))
  const bad = hook(repo, 'PreToolUse', 'Read', {file_path: join(repo, 'src', 'sum.mjs')})
  check('an invalid safeTools glob fails closed', bad.code === 2 && /safeTools/.test(bad.msg))
  keepEvents(repo, 's27-secrets')
}

// ---------------------------------------------------------------- S12 (last: over all hook calls)
say('\nS12 block protocol: BLOCK/PAUSE = exit 2 with the reason on stderr; never exit 1')
{
  const pres = hookCalls.filter((h) => h.event === 'PreToolUse')
  const blocked = pres.filter((h) => h.code !== 0)
  check(`every blocked PreToolUse (${blocked.length}) has exit 2`, blocked.length > 0 && blocked.every((h) => h.code === 2), JSON.stringify([...new Set(blocked.map((h) => h.code))]))
  check('every block has a reason on stderr (BLOCK/PAUSE/STOPBAR FAIL-CLOSED), stdout empty', blocked.every((h) => /^(BLOCK|PAUSE|STOPBAR FAIL-CLOSED)/.test(h.stderr) && h.stdout === ''))
  check('no hook (Pre/Post/Failure/Stop) returned exit 1', hookCalls.every((h) => h.code === 0 || h.code === 2), `codes: ${JSON.stringify([...new Set(hookCalls.map((h) => h.code))])}`)
  const bad = spawnSync(process.execPath, [CLI, 'hook'], {input: '{not json', encoding: 'utf8'})
  check('bad JSON on stdin = exit 2 (fail closed)', bad.status === 2 && /FAIL-CLOSED: hook input is not JSON/.test(bad.stderr), bad.stderr.trim())
  const noInit = join(TMP, 's12-no-init'); mkdirSync(noInit, {recursive: true}); run('git init -q', noInit)
  const ni = spawnSync(process.execPath, [CLI, 'hook'], {input: JSON.stringify({hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: {command: 'echo hi'}, cwd: noInit}), encoding: 'utf8'})
  check('repo without Stopbar config = exit 2 (fail closed) with the init command', ni.status === 2 && /FAIL-CLOSED: Stopbar is not initialised[\s\S]*stopbar init/.test(ni.stderr), ni.stderr.trim().slice(0, 120))
  const ms = hookCalls.map((h) => h.ms).sort((a, b) => a - b)
  say(`  hook processes: ${ms.length}, wall p50 ${ms[Math.floor(ms.length * 0.5)].toFixed(0)} ms, p95 ${ms[Math.floor(ms.length * 0.95)].toFixed(0)} ms (E2E machine, incl. spawn)`)
}

say(`\nRESULT: ${failures === 0 ? 'ALL PASS' : failures + ' FAIL'} (${passes} passed, ${failures} failed)`)
writeFileSync(join(OUT, `e2e-${stamp}.log`), lines.join('\n') + '\n')
say(`log: ${join(OUT, `e2e-${stamp}.log`)}`)
process.exitCode = failures ? 1 : 0
