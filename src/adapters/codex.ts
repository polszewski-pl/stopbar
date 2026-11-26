// Codex CLI (hooks.json, Claude Code compatible events). Schemas from the CLI's own command-hook JSON schemas
// (pre-tool-use / post-tool-use / stop .command.input and .command.output): every input carries turn_id and model.
// There is no failure event: PostToolUse also follows a failed command, so a gate passes only with an exit code 0
// found in tool_response. Output: JSON on stdout with exit 0 (permissionDecision deny / decision block).
import {type Adapter, type Kind, byName, commandText, edit, exitCodeIn, json, make, patchPaths, shell, type ToolClass} from './types.ts'

const SHELL = new Set(['Bash', 'shell', 'exec_command', 'local_shell', 'unified_exec', 'shell_command', 'container.exec'])

function tool(name: string, ti: Record<string, any>): ToolClass {
  if (SHELL.has(name)) return shell(commandText(ti.command ?? ti.cmd ?? ti.argv))
  if (name === 'apply_patch') return edit(patchPaths(ti.input ?? ti.patch ?? ti.command))
  if (name.startsWith('mcp__')) return {tool_name: name, tool_input: ti}
  if (['Edit', 'Write', 'MultiEdit', 'Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch'].includes(name)) return {tool_name: name, tool_input: ti}
  return byName(name, ti, ti.command)
}

export const codex: Adapter = {
  name: 'codex',
  detect: (i) => typeof i.hook_event_name === 'string' && typeof i.turn_id === 'string',
  normalize(i) {
    const ev = i.hook_event_name, ti = (i.tool_input && typeof i.tool_input === 'object' ? i.tool_input : {}) as Record<string, any>
    if (ev === 'PreToolUse') {
      const t = tool(String(i.tool_name ?? ''), ti)
      return {kind: 'pre-tool', event: make('codex', i, ev, {hook_event_name: 'PreToolUse', cwd: i.cwd, ...t}, {tool: i.tool_name})}
    }
    if (ev === 'PostToolUse') {
      const t = tool(String(i.tool_name ?? ''), ti)
      const code = exitCodeIn(i.tool_response)
      const failed = code !== undefined && code !== 0
      return {kind: failed ? 'post-tool-failure' : 'post-tool',
        event: make('codex', i, ev, {hook_event_name: failed ? 'PostToolUseFailure' : 'PostToolUse', cwd: i.cwd, ...t,
          tool_response: code === undefined ? i.tool_response : {exitCode: code}}, {requireExitCode: true, tool: i.tool_name})}
    }
    if (ev === 'Stop') return {kind: 'stop', event: make('codex', i, ev, {hook_event_name: 'Stop', cwd: i.cwd, stop_hook_active: i.stop_hook_active === true})}
    return {kind: 'other', event: null}
  },
  render(kind: Kind, out) {
    if (kind === 'pre-tool') {
      if (out.code === 0) return {code: 0}
      return {code: 0, stdout: json({hookSpecificOutput: {hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: out.msg ?? 'blocked by stopbar'}}) + '\n', stderr: (out.msg ?? '') + '\n'}
    }
    if (kind === 'post-tool' || kind === 'post-tool-failure' || kind === 'stop') {
      return out.msg && out.code !== 0 ? {code: 0, stdout: json({decision: 'block', reason: out.msg}) + '\n'} : {code: 0}
    }
    return {code: 0}
  },
}
