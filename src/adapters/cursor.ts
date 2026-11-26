// Cursor (.cursor/hooks.json, version 1). Every payload carries conversation_id, generation_id and cursor_version.
// Events: preToolUse / postToolUse / postToolUseFailure / stop, and the older beforeShellExecution, beforeMCPExecution,
// beforeReadFile, afterFileEdit, afterShellExecution. Permission events: exit 2 denies, and the JSON on stdout carries
// permission "deny" with user_message and agent_message. Other non-zero exits are fail-open unless the entry sets
// failClosed: true, so `stopbar init --hooks cursor` writes failClosed: true.
import {type Adapter, byName, commandText, edit, exitCodeIn, json, make, outbound, pathsOf, read, shell, type ToolClass} from './types.ts'

function tool(name: string, ti: Record<string, any>): ToolClass {
  if (name === 'Shell') return shell(commandText(ti.command))
  if (name === 'Read') return read(pathsOf(ti))
  if (['Write', 'Edit', 'Delete', 'StrReplace', 'MultiEdit', 'ApplyPatch'].includes(name)) return edit(pathsOf(ti))
  if (name === 'Grep' || name === 'Glob') return {tool_name: name, tool_input: {pattern: ti.pattern, path: ti.path}}
  if (name.startsWith('MCP:')) return outbound(`mcp__${name.slice(4)}`)
  if (name === 'WebFetch' || name === 'WebSearch') return {tool_name: name, tool_input: ti}
  return byName(name, ti, ti.command)
}
const toolInput = (x: unknown) => {
  if (typeof x === 'string') { try { const o = JSON.parse(x); return o && typeof o === 'object' ? o : {} } catch { return {} } }
  return x && typeof x === 'object' ? (x as Record<string, any>) : {}
}
const PERMISSION = new Set(['preToolUse', 'beforeShellExecution', 'beforeMCPExecution', 'beforeReadFile'])

export const cursor: Adapter = {
  name: 'cursor',
  detect: (i) => typeof i.cursor_version === 'string' || (typeof i.conversation_id === 'string' && typeof i.generation_id === 'string'),
  normalize(i) {
    const ev = String(i.hook_event_name ?? '')
    const cwd = typeof i.cwd === 'string' && i.cwd ? i.cwd : Array.isArray(i.workspace_roots) ? i.workspace_roots[0] : undefined
    const base = (t: ToolClass) => ({cwd, ...t})
    switch (ev) {
      case 'preToolUse': return {kind: 'pre-tool', event: make('cursor', i, ev, {hook_event_name: 'PreToolUse', ...base(tool(String(i.tool_name ?? ''), toolInput(i.tool_input)))}, {tool: i.tool_name})}
      case 'beforeShellExecution': return {kind: 'pre-tool', event: make('cursor', i, ev, {hook_event_name: 'PreToolUse', ...base(shell(commandText(i.command)))})}
      case 'beforeMCPExecution': return {kind: 'pre-tool', event: make('cursor', i, ev, {hook_event_name: 'PreToolUse', ...base(outbound(`mcp__${i.mcp_server_name ?? 'server'}__${i.tool_name ?? 'tool'}`))})}
      case 'beforeReadFile': return {kind: 'pre-tool', event: make('cursor', i, ev, {hook_event_name: 'PreToolUse', ...base(read(pathsOf(i)))})}
      case 'postToolUse': {
        const out = toolInput(i.tool_output)
        const code = exitCodeIn(out)
        const failed = code !== undefined && code !== 0
        return {kind: failed ? 'post-tool-failure' : 'post-tool', event: make('cursor', i, ev, {hook_event_name: failed ? 'PostToolUseFailure' : 'PostToolUse',
          ...base(tool(String(i.tool_name ?? ''), toolInput(i.tool_input))), tool_response: code === undefined ? out : {exitCode: code}}, {tool: i.tool_name})}
      }
      case 'postToolUseFailure': return {kind: 'post-tool-failure', event: make('cursor', i, ev, {hook_event_name: 'PostToolUseFailure',
        ...base(tool(String(i.tool_name ?? ''), toolInput(i.tool_input))), is_interrupt: i.is_interrupt === true || i.failure_type === 'permission_denied'}, {tool: i.tool_name})}
      case 'afterFileEdit': return {kind: 'post-tool', event: make('cursor', i, ev, {hook_event_name: 'PostToolUse', ...base(edit(pathsOf(i)))})}
      // no exit code in afterShellExecution: a gate command seen only here never passes (use postToolUse)
      case 'afterShellExecution': return {kind: 'post-tool', event: make('cursor', i, ev, {hook_event_name: 'PostToolUse', ...base(shell(commandText(i.command)))}, {requireExitCode: true})}
      case 'stop': return {kind: 'stop', event: make('cursor', i, ev, {hook_event_name: 'Stop', cwd, stop_hook_active: Number(i.loop_count) > 0})}
      default: return {kind: 'other', event: null}
    }
  },
  render(kind, out, input) {
    const ev = String(input?.hook_event_name ?? 'preToolUse')
    if (kind === 'pre-tool' || PERMISSION.has(ev)) {
      if (out.code === 0) return {code: 0, stdout: json({permission: 'allow'}) + '\n'}
      const m = out.msg ?? 'blocked by stopbar'
      return {code: 2, stdout: json({permission: 'deny', user_message: m, agent_message: m}) + '\n', stderr: m + '\n'}
    }
    if (kind === 'stop') return out.code !== 0 && out.msg ? {code: 0, stdout: json({followup_message: out.msg}) + '\n'} : {code: 0, stdout: '{}\n'}
    if (kind === 'post-tool' || kind === 'post-tool-failure') return out.msg ? {code: 0, stdout: json({additional_context: out.msg}) + '\n'} : {code: 0, stdout: '{}\n'}
    return {code: 0, stdout: '{}\n'}
  },
}
