// `stopbar git-hook pre-commit|pre-push`: the fallback gate for tools without their own hook system. Git runs it from
// .git/hooks; it goes through the same path as an agent's `git commit` / `git push` (the generated kernel step): the
// working tree is synced, then COMMIT must be allowed (passing build and full suite at this revision, no unapproved
// test changes); a push is also a risky outbound call, paused after a secret read without a human approval.
// Exit 0 lets git go on, exit 1 aborts the commit or push (git's convention).
import {runEvent} from './hook.ts'

type Opts = {get: (name: string) => string | undefined}

export function gitHook(which: string, o: Opts): {code: number; msg?: string} {
  if (which !== 'pre-commit' && which !== 'pre-push') return {code: 1, msg: 'usage: stopbar git-hook pre-commit|pre-push'}
  const out = runEvent({hook_event_name: 'PreToolUse', cwd: o.get('repo') ?? process.cwd(), tool_name: 'Bash',
    tool_input: {command: which === 'pre-commit' ? 'git commit' : 'git push'}, stopbar: {adapter: 'git', rawKeys: [], event: which}})
  if (out.code === 0) return {code: 0}
  return {code: 1, msg: `stopbar ${which}: ${out.msg ?? 'blocked'}`}
}
