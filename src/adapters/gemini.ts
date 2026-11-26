// Gemini CLI (.gemini/settings.json "hooks"). Events BeforeTool, AfterTool and AfterAgent (the end of a turn). Exit 2 is
// a system block with the reason on stderr; any other non-zero exit is only a warning and the call proceeds, and
// invalid JSON on stdout counts as "allow". Stopbar exits 2 for every block and fail-closed error.
import {type Adapter, byName, commandText, edit, exitCodeIn, json, make, outbound, pathsOf, read, shell, type ToolClass} from './types.ts'

const UNIQUE = new Set(['BeforeTool', 'AfterTool', 'BeforeAgent', 'AfterAgent', 'BeforeModel', 'AfterModel', 'BeforeToolSelection', 'PreCompress', 'Notification'])

function tool(name: string, ti: Record<string, any>): ToolClass {
  switch (name) {
    case 'run_shell_command': return shell(commandText(ti.command))
    case 'write_file': case 'replace': return edit(pathsOf(ti))
    case 'read_file': case 'read_many_files': return read([...pathsOf(ti), ...(Array.isArray(ti.include) ? ti.include : [])])
    case 'glob': return {tool_name: 'Glob', tool_input: {pattern: ti.pattern, path: ti.dir_path}}
    case 'grep_search': case 'search_file_content': return {tool_name: 'Grep', tool_input: {pattern: ti.pattern, path: ti.dir_path}}
    case 'web_fetch': return {tool_name: 'WebFetch', tool_input: {}}
    case 'google_web_search': return {tool_name: 'WebSearch', tool_input: {}}
  }
  if (name.startsWith('mcp_')) return outbound(`mcp__${name.slice(4)}`)
  return byName(name, ti, ti.command)
}

export const gemini: Adapter = {
  name: 'gemini',
  detect: (i) => typeof i.hook_event_name === 'string' && (UNIQUE.has(i.hook_event_name) || (typeof i.timestamp === 'string' && /^Session(Start|End)$/.test(i.hook_event_name))),
  normalize(i) {
    const ev = String(i.hook_event_name), ti = (i.tool_input && typeof i.tool_input === 'object' ? i.tool_input : {}) as Record<string, any>
    if (ev === 'BeforeTool') return {kind: 'pre-tool', event: make('gemini', i, ev, {hook_event_name: 'PreToolUse', cwd: i.cwd, ...tool(String(i.tool_name ?? ''), ti)}, {tool: i.tool_name})}
    if (ev === 'AfterTool') {
      const r = (i.tool_response ?? {}) as Record<string, unknown>
      const code = exitCodeIn(r)
      const failed = !!r.error || (code !== undefined && code !== 0)
      return {kind: failed ? 'post-tool-failure' : 'post-tool', event: make('gemini', i, ev, {hook_event_name: failed ? 'PostToolUseFailure' : 'PostToolUse', cwd: i.cwd,
        ...tool(String(i.tool_name ?? ''), ti), tool_response: code === undefined ? r : {exitCode: code}}, {tool: i.tool_name})}
    }
    if (ev === 'AfterAgent') return {kind: 'stop', event: make('gemini', i, ev, {hook_event_name: 'Stop', cwd: i.cwd, stop_hook_active: i.stop_hook_active === true})}
    return {kind: 'other', event: null}
  },
  render(kind, out) {
    if (kind === 'pre-tool') return out.code === 0 ? {code: 0, stdout: '{}\n'} : {code: 2, stderr: (out.msg ?? 'blocked by stopbar') + '\n'}
    if (kind === 'stop') return out.code !== 0 && out.msg ? {code: 0, stdout: json({decision: 'block', reason: out.msg}) + '\n'} : {code: 0, stdout: '{}\n'}
    if (kind === 'post-tool' || kind === 'post-tool-failure') {
      return out.msg ? {code: 0, stdout: json({hookSpecificOutput: {hookEventName: 'AfterTool', additionalContext: out.msg}}) + '\n'} : {code: 0, stdout: '{}\n'}
    }
    return {code: 0, stdout: '{}\n'}
  },
}
