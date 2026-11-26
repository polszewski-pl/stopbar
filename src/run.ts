// `stopbar run build|test`: runs the configured gate command itself and records its real exit status in the kernel.
// For agents without hooks (with the git fallback) this is how a build or full test run counts. The working tree is
// synced before the run; the result is recorded at that revision and a change made during the run is counted after it,
// so a run never passes a revision it did not see.
import {spawnSync} from 'node:child_process'
import {runEvent} from './hook.ts'
import {findRepo} from './repo.ts'
import {readConfig} from './store.ts'

type Opts = {get: (name: string) => string | undefined}

export function runGate(which: string, o: Opts): {code: number; msg?: string} {
  if (which !== 'build' && which !== 'test') return {code: 1, msg: 'usage: stopbar run build|test'}
  const cwd = o.get('repo') ?? process.cwd()
  const repo = findRepo(cwd)
  const cfg = readConfig(repo)
  const command = which === 'build' ? cfg.buildCmd : cfg.fullTestCmd
  const meta = (event: string) => ({adapter: 'run', rawKeys: [], event})
  const before = runEvent({hook_event_name: 'PostToolUse', cwd: repo.root, tool_name: 'Bash', tool_input: {command: ':'}, tool_response: {exitCode: 0}, stopbar: meta('sync')})
  if (before.code !== 0 && /FAIL-CLOSED|halted/.test(before.msg ?? '')) return {code: 2, msg: before.msg}
  const r = spawnSync(command, {cwd: repo.root, shell: true, stdio: 'inherit'})
  const exit = r.status ?? 1
  const after = runEvent({hook_event_name: exit === 0 ? 'PostToolUse' : 'PostToolUseFailure', cwd: repo.root, tool_name: 'Bash', tool_input: {command},
    tool_response: {exitCode: exit}, stopbar: meta(which)})
  const msg = `stopbar run ${which}: \`${command}\` exited ${exit}; recorded as ${exit === 0 ? 'a pass' : 'a failure'}${after.msg ? `\n${after.msg}` : ''}`
  return {code: exit === 0 && after.code === 0 ? 0 : exit || 2, msg}
}
