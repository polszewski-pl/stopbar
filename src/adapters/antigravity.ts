// Antigravity CLI (agy; hooks.json in the customization root, e.g. <workspace>/.agents/hooks.json). camelCase payloads:
// hookEventName, toolCall {id, name, args}, cwd, workspacePaths; PostToolUse carries `error` when the tool failed;
// Stop carries continuationActive. Output is JSON on stdout: PreToolUse {"decision": "deny", "reason"}; Stop
// {"decision": "continue", "reason"} keeps the agent working. Tool names are the lower-cased step types.
import {type Adapter, byName, commandText, edit, json, make, outbound, pathsOf, read, shell, type ToolClass} from './types.ts'

// names seen in a live Antigravity CLI 1.5.18 session (write_file with Path) plus the step types of its hooks spec
const EDIT = new Set(['write_file', 'write_to_file', 'replace_file_content', 'multi_replace_file_content', 'sed_file', 'notebook_edit', 'code_action',
  'file_change', 'propose_code', 'write_blob', 'edit_notebook', 'delete_directory', 'move'])
const READ = new Set(['view_file', 'view_file_outline', 'view_code_item', 'view_content_chunk', 'read_notebook', 'list_directory', 'list_dir', 'find', 'find_by_name', 'code_search', 'read_resource'])
const OUT = new Set(['read_url_content', 'search_web', 'open_browser_url', 'read_browser_page', 'execute_browser_javascript', 'click_browser_pixel', 'mcp_tool', 'call_mcp_tool'])

function tool(name: string, args: Record<string, any>): ToolClass {
  if (name === 'run_command' || name === 'shell_exec' || name === 'send_command_input' || name === 'notebook_execution') return shell(commandText(args.CommandLine ?? args.Command ?? args.command ?? args.Input ?? ''))
  if (EDIT.has(name)) return edit(pathsOf(args))
  if (READ.has(name)) return read(pathsOf(args))
  if (name === 'grep_search') return {tool_name: 'Grep', tool_input: {pattern: args.Query ?? args.query, path: args.SearchPath ?? args.SearchDirectory}}
  if (OUT.has(name) || name.startsWith('browser_') || name.startsWith('capture_browser_')) return outbound(name === 'mcp_tool' || name === 'call_mcp_tool' ? `mcp__${args.ServerName ?? args.serverName ?? 'server'}__${args.ToolName ?? args.toolName ?? 'tool'}` : name)
  return byName(name, args, args.CommandLine)
}

export const antigravity: Adapter = {
  name: 'antigravity',
  detect: (i) => typeof i.hookEventName === 'string' || (typeof i.toolCall === 'object' && i.toolCall !== null) || typeof i.conversationId === 'string',
  normalize(i) {
    const ev = String(i.hookEventName ?? '')
    const cwd = typeof i.cwd === 'string' && i.cwd ? i.cwd : Array.isArray(i.workspacePaths) ? i.workspacePaths[0] : undefined
    const call = (i.toolCall ?? {}) as Record<string, any>
    const args = (call.args && typeof call.args === 'object' ? call.args : {}) as Record<string, any>
    if (ev === 'PreToolUse') return {kind: 'pre-tool', event: make('antigravity', i, ev, {hook_event_name: 'PreToolUse', cwd, ...tool(String(call.name ?? ''), args)}, {tool: call.name})}
    if (ev === 'PostToolUse') {
      const failed = typeof i.error === 'string' ? i.error.length > 0 : !!i.error
      return {kind: failed ? 'post-tool-failure' : 'post-tool', event: make('antigravity', i, ev, {hook_event_name: failed ? 'PostToolUseFailure' : 'PostToolUse', cwd,
        ...tool(String(call.name ?? ''), args), tool_response: failed ? {error: i.error} : {}}, {tool: call.name})}
    }
    if (ev === 'Stop') return {kind: 'stop', event: make('antigravity', i, ev, {hook_event_name: 'Stop', cwd, stop_hook_active: i.continuationActive === true})}
    return {kind: 'other', event: null}
  },
  render(kind, out) {
    if (kind === 'pre-tool') return out.code === 0 ? {code: 0} : {code: 0, stdout: json({decision: 'deny', reason: out.msg ?? 'blocked by stopbar'}) + '\n', stderr: (out.msg ?? '') + '\n'}
    if (kind === 'stop') return out.code !== 0 && out.msg ? {code: 0, stdout: json({decision: 'continue', reason: out.msg}) + '\n'} : {code: 0, stdout: '{}\n'}
    return {code: 0, stdout: '{}\n'}
  },
}
