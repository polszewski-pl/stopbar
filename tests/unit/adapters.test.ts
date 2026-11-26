import assert from 'node:assert/strict'
import {test} from 'node:test'
import {adapterByName, detect, handle} from '../../dist/adapters/index.js'
import {commandText, exitCodeIn, patchPaths} from '../../dist/adapters/types.js'
import {protectedCommand, protectedPath} from '../../dist/classify.js'
import {parseTargets} from '../../dist/integrations.js'

const CLAUDE = {session_id: 's', transcript_path: 't', cwd: '/r', prompt_id: 'p', permission_mode: 'default', effort: 'high', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: {command: 'ls'}, tool_use_id: 'u'}
const CODEX = {session_id: 's', transcript_path: null, cwd: '/r', hook_event_name: 'PreToolUse', model: 'm', permission_mode: 'default', turn_id: 't1', tool_name: 'exec_command', tool_input: {command: ['bash', '-lc', 'git status']}, tool_use_id: 'u'}
const CURSOR = {conversation_id: 'c', generation_id: 'g', model: 'm', hook_event_name: 'preToolUse', cursor_version: '2.1', workspace_roots: ['/r'], user_email: null, transcript_path: null, tool_name: 'Shell', tool_input: {command: 'ls', working_directory: '/r'}, tool_use_id: 'u', cwd: '/r'}
const GEMINI = {session_id: 's', transcript_path: 't', cwd: '/r', hook_event_name: 'BeforeTool', timestamp: '2026-11-26T00:00:00Z', tool_name: 'run_shell_command', tool_input: {command: 'ls', dir_path: '/r'}}
const AGY = {conversationId: 'c', workspacePaths: ['/r'], transcriptPath: 't', modelName: 'auto', hookEventName: 'PreToolUse', cwd: '/r', toolCall: {id: '1', name: 'run_command', args: {CommandLine: 'ls', Cwd: '/r'}}, stepIdx: 1}

test('auto detection is deterministic per client, and Claude Code v1.0 payloads stay claude', () => {
  assert.equal(detect(CLAUDE)?.name, 'claude')
  assert.equal(detect({...CLAUDE, hook_event_name: 'PostToolUseFailure', error: 'x', is_interrupt: false})?.name, 'claude')
  assert.equal(detect(CODEX)?.name, 'codex')
  assert.equal(detect(CURSOR)?.name, 'cursor')
  assert.equal(detect(GEMINI)?.name, 'gemini')
  assert.equal(detect({...GEMINI, hook_event_name: 'AfterAgent'})?.name, 'gemini')
  assert.equal(detect(AGY)?.name, 'antigravity')
  assert.equal(detect({foo: 1}), null)
  assert.equal(adapterByName('agy')?.name, 'antigravity')
  assert.equal(adapterByName('nope'), null)
})

test('normalisation: every client becomes the internal event with Claude Code tool names', () => {
  const n = (a: string, i: object) => adapterByName(a)!.normalize(i as any)
  assert.deepEqual(n('codex', CODEX).event?.tool_input, {command: 'git status'})
  assert.deepEqual(n('codex', {...CODEX, tool_name: 'apply_patch', tool_input: {input: '*** Begin Patch\n*** Update File: src/a.ts\n@@\n-x\n+y\n*** Add File: tests/b.test.ts\n+z\n*** End Patch'}}).event?.tool_input,
    {file_path: 'src/a.ts', file_paths: ['src/a.ts', 'tests/b.test.ts']})
  const cp = n('codex', {...CODEX, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: {command: 'npm test'}, tool_response: 'Exit code: 1\nWall time: 2s\nOutput:\nfail'})
  assert.equal(cp.kind, 'post-tool-failure')
  assert.equal(cp.event?.hook_event_name, 'PostToolUseFailure')
  const cs = n('codex', {...CODEX, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: {command: 'npm test'}, tool_response: {output: 'ok'}})
  assert.equal(cs.kind, 'post-tool')
  assert.equal(cs.event?.stopbar.requireExitCode, true) // no exit code found: the gate will not count as passed
  assert.equal(n('cursor', {...CURSOR, tool_name: 'Write', tool_input: {file_path: '/r/a.ts'}}).event?.tool_name, 'Write')
  assert.equal(n('cursor', {...CURSOR, tool_name: 'MCP:query'}).event?.tool_name, 'mcp__query')
  assert.equal(n('cursor', {...CURSOR, hook_event_name: 'postToolUse', tool_output: '{"exitCode":1,"stdout":""}'}).kind, 'post-tool-failure')
  assert.equal(n('cursor', {...CURSOR, hook_event_name: 'postToolUseFailure', failure_type: 'permission_denied', is_interrupt: false}).event?.is_interrupt, true)
  assert.equal(n('cursor', {...CURSOR, hook_event_name: 'stop', status: 'completed', loop_count: 1}).event?.stop_hook_active, true)
  assert.equal(n('cursor', {...CURSOR, hook_event_name: 'afterShellExecution', command: 'npm test', output: ''}).event?.stopbar.requireExitCode, true)
  assert.deepEqual(n('gemini', {...GEMINI, tool_name: 'replace', tool_input: {file_path: '/r/a.ts'}}).event?.tool_input, {file_path: '/r/a.ts', file_paths: ['/r/a.ts']})
  assert.equal(n('gemini', {...GEMINI, hook_event_name: 'AfterTool', tool_response: {llmContent: 'Exit Code: 1', returnDisplay: ''}}).kind, 'post-tool-failure')
  assert.equal(n('gemini', {...GEMINI, hook_event_name: 'AfterTool', tool_response: {llmContent: 'x', error: 'boom'}}).kind, 'post-tool-failure')
  assert.equal(n('gemini', {...GEMINI, tool_name: 'mcp_db_query'}).event?.tool_name, 'mcp__db_query')
  assert.equal(n('antigravity', AGY).event?.tool_input?.command, 'ls')
  assert.deepEqual(n('antigravity', {...AGY, toolCall: {name: 'write_to_file', args: {TargetFile: '/r/x.ts', CodeContent: ''}}}).event?.tool_input, {file_path: '/r/x.ts', file_paths: ['/r/x.ts']})
  assert.equal(n('antigravity', {...AGY, hookEventName: 'PostToolUse', error: 'exit status 1'}).kind, 'post-tool-failure')
  assert.equal(n('antigravity', {...AGY, hookEventName: 'Stop', continuationActive: true}).event?.stop_hook_active, true)
  assert.equal(n('antigravity', {...AGY, hookEventName: 'PreInvocation'}).event, null)
})

test('rendering: each client gets its own deny, allow and stop format', () => {
  const blocked = {code: 2, msg: 'BLOCK (stopbar): x'}, ok = {code: 0}
  const r = (a: string, k: string, o: object, i: object | null = null) => adapterByName(a)!.render(k as any, o as any, i as any)
  assert.deepEqual(r('claude', 'pre-tool', blocked), {code: 2, stderr: 'BLOCK (stopbar): x\n'})
  assert.equal(JSON.parse(r('cursor', 'pre-tool', blocked, CURSOR).stdout!).permission, 'deny')
  assert.equal(r('cursor', 'pre-tool', blocked, CURSOR).code, 2)
  assert.deepEqual(JSON.parse(r('cursor', 'pre-tool', ok, CURSOR).stdout!), {permission: 'allow'})
  assert.deepEqual(JSON.parse(r('cursor', 'stop', {code: 2, msg: 'Not done'}, {...CURSOR, hook_event_name: 'stop'}).stdout!), {followup_message: 'Not done'})
  assert.equal(JSON.parse(r('codex', 'pre-tool', blocked).stdout!).hookSpecificOutput.permissionDecision, 'deny')
  assert.deepEqual(r('codex', 'pre-tool', ok), {code: 0})
  assert.deepEqual(JSON.parse(r('codex', 'stop', {code: 2, msg: 'Not done'}).stdout!), {decision: 'block', reason: 'Not done'})
  assert.deepEqual(r('gemini', 'pre-tool', blocked), {code: 2, stderr: 'BLOCK (stopbar): x\n'})
  assert.deepEqual(JSON.parse(r('gemini', 'stop', {code: 2, msg: 'Not done'}).stdout!), {decision: 'block', reason: 'Not done'})
  assert.deepEqual(JSON.parse(r('antigravity', 'pre-tool', blocked).stdout!), {decision: 'deny', reason: 'BLOCK (stopbar): x'})
  assert.deepEqual(r('antigravity', 'pre-tool', ok), {code: 0})
  assert.deepEqual(JSON.parse(r('antigravity', 'stop', {code: 2, msg: 'Not done'}).stdout!), {decision: 'continue', reason: 'Not done'})
})

test('fail closed: unknown payload, bad JSON, unknown adapter', () => {
  assert.equal(handle('{"foo":1}').code, 2)
  assert.match(handle('{"foo":1}').stderr!, /unknown hook payload/)
  assert.equal(handle('not json').code, 2)
  const c = handle('not json', 'cursor')
  assert.equal(c.code, 2)
  assert.equal(JSON.parse(c.stdout!).permission, 'deny')
  assert.equal(JSON.parse(handle('[]', 'antigravity').stdout!).decision, 'deny')
  assert.match(handle('{}', 'nope').stderr!, /unknown adapter/)
})

test('helpers: command text, patch paths, exit codes', () => {
  assert.equal(commandText(['bash', '-lc', 'npm test']), 'npm test')
  assert.equal(commandText(['npm', 'run', 'my build']), 'npm run "my build"')
  assert.deepEqual(patchPaths('*** Begin Patch\n*** Delete File: a.txt\n*** Update File: b.txt\n*** Move to: c.txt\n*** End Patch'), ['a.txt', 'b.txt', 'c.txt'])
  assert.equal(exitCodeIn({exit_code: 3}), 3)
  assert.equal(exitCodeIn('{"exitCode":0}'), 0)
  assert.equal(exitCodeIn({llmContent: 'Command: x\nExit Code: 7'}), 7)
  assert.equal(exitCodeIn({metadata: {exit_code: 1}}), 1)
  assert.equal(exitCodeIn('all good'), undefined)
})

test('init --hooks targets: aliases, lists, unknown names', () => {
  assert.deepEqual(parseTargets('local'), ['claude'])
  assert.deepEqual(parseTargets('project'), ['claude-project'])
  assert.deepEqual(parseTargets('claude,cursor, git,agy,cursor'), ['claude', 'cursor', 'git', 'antigravity'])
  assert.throws(() => parseTargets('vim'), /unknown --hooks target/)
  assert.throws(() => parseTargets(''), /at least one/)
})

test('self-protection covers the hook files of every client', () => {
  const pr = {gitDir: 'C:/r/.git', stateDir: 'C:/r/.git/stopbar', codeDirs: []}
  for (const p of ['C:/r/.cursor/hooks.json', 'C:/r/.codex/hooks.json', 'C:/r/.codex/config.toml', 'C:/r/.gemini/settings.json', 'C:/r/.gemini/settings.local.json',
    'C:/Users/u/.gemini/antigravity-cli/hooks.json', 'C:/r/.agents/hooks.json', 'C:/Users/u/.cursor/hooks.json']) assert.ok(protectedPath(p, 'C:/r', pr), p)
  for (const p of ['C:/r/.cursor/rules/a.mdc', 'C:/r/.agents/skills/x.md', 'C:/r/.gemini/GEMINI.md']) assert.equal(protectedPath(p, 'C:/r', pr), null, p)
  for (const c of ['rm .cursor/hooks.json', 'cat > .codex/hooks.json', 'echo {} > .gemini/settings.json', 'rm -rf .agents', 'mv .cursor x']) assert.ok(protectedCommand(c, pr), c)
})
