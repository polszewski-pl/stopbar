// Config rules added in 1.1.2: distinct gate commands, default safeTools, cliCmd and stopGate.
import assert from 'node:assert/strict'
import {test} from 'node:test'
import {commandForSelfProtect, isTestPath, protectedCommand} from '../../dist/classify.js'
import {cliCmdProblem, cliOf, DEFAULT_CLI, DEFAULT_SAFE_TOOLS, makeConfig, validateConfig} from '../../dist/config.js'
import {runHint, whyBlocked} from '../../dist/hook.js'

const cfg = makeConfig({buildCmd: 'npm run build', fullTestCmd: 'npm test'})

test('buildCmd equal to fullTestCmd is refused by makeConfig and validateConfig, also with surrounding whitespace', () => {
  for (const [b, t] of [['npm test', 'npm test'], ['npm test', '  npm test  '], ['\tnpm run check\n', 'npm run check'], ['make ci ', ' make ci']]) {
    assert.throws(() => makeConfig({buildCmd: b, fullTestCmd: t}), /buildCmd and config\.fullTestCmd must be different commands/, JSON.stringify([b, t]))
    assert.throws(() => validateConfig({...cfg, buildCmd: b, fullTestCmd: t}), /must be different commands/, JSON.stringify([b, t]))
  }
  // the message says how to fix it
  assert.throws(() => makeConfig({buildCmd: 'x', fullTestCmd: 'x'}), /lint\/types\/build.*full test suite/)
  // two different commands (the 1.0.0-1.1.1 shape) stay valid, also when one is a prefix of the other
  assert.ok(validateConfig({...cfg, buildCmd: 'npm test', fullTestCmd: 'npm test -- --all'}))
  assert.ok(validateConfig({version: 1, profile: 'default', buildCmd: 'npm run build', fullTestCmd: 'npm test', maxRetries: 3, cap: 500, costPerCall: 1, paths: cfg.paths}))
})

test('DEFAULT_SAFE_TOOLS holds the Claude Desktop turn and session-management tools', () => {
  assert.deepEqual(DEFAULT_SAFE_TOOLS, ['mcp__ccd_turn__*', 'mcp__ccd_session_mgmt__*'])
  assert.deepEqual(cfg.safeTools, DEFAULT_SAFE_TOOLS)
})

test('cliCmd: valid commands pass; empty, chained and .git or agent-directory commands are refused', () => {
  for (const ok of ['stopbar', 'node /opt/stopbar/bin/stopbar.mjs', 'node "C:/Program Files/stopbar/bin/stopbar.mjs"', 'npx --no-install stopbar', 'pnpm exec stopbar', 'node ../tools/stopbar.github/bin/stopbar.mjs']) {
    assert.equal(cliCmdProblem(ok), null, ok)
    assert.equal(makeConfig({buildCmd: 'b', fullTestCmd: 't', cliCmd: ok}).cliCmd, ok)
  }
  assert.equal(makeConfig({buildCmd: 'b', fullTestCmd: 't', cliCmd: '  stopbar  '}).cliCmd, 'stopbar')
  assert.equal(makeConfig({buildCmd: 'b', fullTestCmd: 't'}).cliCmd, undefined)
  const bad: [unknown, RegExp][] = [
    ['', /non-empty/], ['   ', /non-empty/], [42, /must be a string/],
    ['stopbar; rm -rf x', /shell operators/], ['stopbar && echo', /shell operators/], ['stopbar | tee x', /shell operators/],
    ['stopbar || true', /shell operators/], ['stopbar > out.txt', /shell operators/], ['$(which stopbar)', /shell operators/],
    ['node .git/stopbar/runtime/bin/stopbar.mjs', /\.git directory/], ['node C:\\r\\.git\\stopbar\\runtime\\bin\\stopbar.mjs', /\.git directory/],
    ['node /r/.GIT/x.mjs', /\.git directory/], ['node /home/u/.claude/stopbar.mjs', /\.claude directory/],
  ]
  for (const [v, re] of bad) {
    assert.throws(() => validateConfig({...cfg, cliCmd: v}), re, JSON.stringify(v))
    if (typeof v === 'string') assert.throws(() => makeConfig({buildCmd: 'b', fullTestCmd: 't', cliCmd: v}), /config\.cliCmd/, JSON.stringify(v))
  }
})

test('cliCmd in hints: configured command, else npx --no-install (never a registry download)', () => {
  assert.equal(DEFAULT_CLI, 'npx --no-install stopbar')
  assert.equal(cliOf(cfg), 'npx --no-install stopbar')
  assert.equal(runHint(cfg, 'test'), 'npx --no-install stopbar run test')
  const c2 = makeConfig({buildCmd: 'npm run build', fullTestCmd: 'npm test', cliCmd: 'node /opt/stopbar/bin/stopbar.mjs'})
  assert.equal(runHint(c2, 'build'), 'node /opt/stopbar/bin/stopbar.mjs run build')
  const v = {treeRev: 3, buildOkRev: 1, testsOkRev: 1, testsTainted: false} as any
  assert.match(whyBlocked(v, c2), /`node \/opt\/stopbar\/bin\/stopbar\.mjs run build`.*`node \/opt\/stopbar\/bin\/stopbar\.mjs run test`/)
  assert.doesNotMatch(whyBlocked(v, cfg), /npx stopbar/)
  assert.match(whyBlocked(v, cfg), /npx --no-install stopbar run test/)
})

test('cliCmd outside .git: `<cli> run test` passes self-protection with a pinned runtime; human commands stay blocked', () => {
  const pr = {gitDir: '/r/.git', stateDir: '/r/.git/stopbar', codeDirs: ['/r/.git/stopbar/runtime/bin', '/r/.git/stopbar/runtime/dist', '/r/.git/stopbar/runtime/package.json']}
  const cli = 'node /opt/stopbar/bin/stopbar.mjs'
  for (const ok of [`${cli} run test`, `${cli} run build`, `${cli} status`]) assert.equal(protectedCommand(commandForSelfProtect(ok), pr), null, ok)
  for (const no of [`${cli} approve-tests`, `${cli} approve-shell`, `${cli} resume --extra 5`, `${cli} reset`, `${cli} init --force --build b --test t`]) {
    assert.ok(protectedCommand(commandForSelfProtect(no), pr), no)
  }
})

test('stopGate: block and warn are valid, missing means block, anything else is refused', () => {
  assert.equal(cfg.stopGate, undefined)
  assert.equal(makeConfig({buildCmd: 'b', fullTestCmd: 't', stopGate: 'block'}).stopGate, 'block')
  assert.equal(makeConfig({buildCmd: 'b', fullTestCmd: 't', stopGate: 'warn'}).stopGate, 'warn')
  assert.ok(validateConfig({...cfg, stopGate: 'warn'}))
  for (const bad of ['', 'Warn', 'off', 'allow', true, 0, null]) {
    assert.throws(() => validateConfig({...cfg, stopGate: bad}), /stopGate must be "block" or "warn"/, JSON.stringify(bad))
  }
  assert.throws(() => makeConfig({buildCmd: 'b', fullTestCmd: 't', stopGate: 'off'}), /stopGate/)
})

test('requireRun: optional boolean, written only when on; scripts/*test* is a test path in every profile', () => {
  assert.equal(cfg.requireRun, undefined)
  assert.equal(makeConfig({buildCmd: 'b', fullTestCmd: 't', requireRun: true}).requireRun, true)
  assert.equal('requireRun' in makeConfig({buildCmd: 'b', fullTestCmd: 't', requireRun: false}), false)
  for (const ok of [true, false]) assert.equal(validateConfig({...cfg, requireRun: ok}).requireRun, ok)
  for (const bad of ['true', 1, null, 'yes']) assert.throws(() => validateConfig({...cfg, requireRun: bad}), /requireRun must be true or false/, JSON.stringify(bad))
  for (const profile of ['default', 'ts', 'python', 'strict']) {
    const p = makeConfig({buildCmd: 'b', fullTestCmd: 't', profile}).paths
    for (const f of ['scripts/test.sh', 'scripts/run-tests.mjs', 'scripts/e2e-test.py']) assert.ok(isTestPath(f, p), `${profile}: ${f}`)
    assert.ok(!isTestPath('scripts/build.ts', p), `${profile}: scripts/build.ts`)
  }
})
