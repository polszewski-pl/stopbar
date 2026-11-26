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
