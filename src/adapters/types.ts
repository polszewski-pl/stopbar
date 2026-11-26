// Adapter layer: every client's hook payload becomes one internal event, which has the shape of a Claude Code hook
// payload (the v1.0 interface): hook_event_name PreToolUse | PostToolUse | PostToolUseFailure | Stop, tool_name in Claude
// Code's vocabulary (Bash, Write, Read, Grep, Glob, WebFetch, WebSearch, mcp__*), tool_input with command or file_path(s).
// The same proven kernel then decides, and the adapter renders the result in the client's own output protocol.
import type {Out} from '../hook.ts'

export type Kind = 'pre-tool' | 'post-tool' | 'post-tool-failure' | 'stop' | 'other'
export type AdapterName = 'claude' | 'codex' | 'cursor' | 'gemini' | 'antigravity'
export const ADAPTERS: AdapterName[] = ['claude', 'codex', 'cursor', 'gemini', 'antigravity']

export type Internal = {
  hook_event_name: 'PreToolUse' | 'PostToolUse' | 'PostToolUseFailure' | 'Stop'
  cwd?: string
  tool_name?: string
  tool_input?: Record<string, unknown>
  tool_response?: unknown
  is_interrupt?: boolean
  stop_hook_active?: boolean
  stopbar: {adapter: AdapterName; rawKeys: string[]; requireExitCode?: boolean; event: string; tool?: string}
}
export type Normalized = {kind: Kind; event: Internal | null}
/** What the CLI writes and returns. */
export type Rendered = {code: number; stdout?: string; stderr?: string}

export interface Adapter {
  name: AdapterName
  /** Deterministic test on the parsed payload. */
  detect(input: Record<string, unknown>): boolean
  normalize(input: Record<string, any>): Normalized
  /** Output for a decision; `kind` is 'pre-tool' when the payload could not be read at all (fail closed). */
  render(kind: Kind, out: Out, input: Record<string, any> | null): Rendered
}

// ---------------------------------------------------------------- shared tool mapping
export type ToolClass = {tool_name: string; tool_input: Record<string, unknown>}

const strs = (...xs: unknown[]) => xs.flatMap((x) => (Array.isArray(x) ? x : [x])).filter((x): x is string => typeof x === 'string' && x.length > 0)

/** A shell command as text; argv arrays such as ["bash", "-lc", "cmd"] become "cmd". */
export function commandText(c: unknown): string {
  if (typeof c === 'string') return c
  if (Array.isArray(c) && c.every((x) => typeof x === 'string')) {
    const a = c as string[]
    if (a.length >= 3 && /(^|[\\/])(bash|sh|zsh|dash|pwsh|powershell|cmd)(\.exe)?$/i.test(a[0]) && /^(-l?c|-Command|\/c)$/i.test(a[1])) return a.slice(2).join(' ')
    return a.map((x) => (/[\s"']/.test(x) ? JSON.stringify(x) : x)).join(' ')
  }
  return ''
}

/** File paths named in an apply_patch style patch (*** Add/Update/Delete File: path, *** Move to: path). */
export function patchPaths(patch: unknown): string[] {
  if (typeof patch !== 'string') return []
  return [...patch.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+?)\s*$/gm)].map((m) => m[1])
}

export const shell = (command: string, background = false): ToolClass => ({tool_name: 'Bash', tool_input: background ? {command, run_in_background: true} : {command}})
export function edit(paths: string[]): ToolClass {
  return {tool_name: 'Write', tool_input: {file_path: paths[0] ?? '', file_paths: paths}}
}
export const read = (paths: string[]): ToolClass => ({tool_name: 'Read', tool_input: {file_path: paths[0] ?? '', file_paths: paths}})
export const outbound = (name: string): ToolClass => ({tool_name: name.startsWith('mcp__') ? name : 'WebFetch', tool_input: {}})
export const other = (name: string): ToolClass => ({tool_name: `other:${name}`, tool_input: {}})

/** Paths from the usual argument keys of file tools (all clients). */
export function pathsOf(args: Record<string, unknown> | undefined): string[] {
  if (!args || typeof args !== 'object') return []
  const a = args as Record<string, unknown>
  return strs(a.file_path, a.filePath, a.path, a.target_file, a.targetFile, a.TargetFile, a.AbsolutePath, a.FilePath, a.File, a.Path,
    a.notebook_path, a.paths, a.file_paths, a.DirectoryPath, a.SearchPath, a.dir_path, a.source, a.destination, a.Source, a.Destination)
}

/** Fallback by name for tools a client adds later: shell, edit, read or outbound by keyword, else other. */
export function byName(name: string, args: Record<string, unknown> | undefined, command?: unknown): ToolClass {
  const n = name.toLowerCase()
  if (/shell|terminal|command|exec|bash|run_/.test(n)) return shell(commandText(command ?? (args as any)?.command ?? (args as any)?.CommandLine ?? ''))
  if (/write|edit|delete|replace|patch|create|move|rename|remove|change|propose|blob/.test(n)) return edit(pathsOf(args))
  if (/read|view|open_file|cat|grep|search_file|find|glob|list/.test(n)) return read(pathsOf(args))
  if (/fetch|web|browser|http|url|mcp/.test(n)) return outbound(n.startsWith('mcp') ? `mcp__${name}` : name)
  return other(name)
}

export function make(adapter: AdapterName, raw: Record<string, any>, event: string, base: Partial<Internal> & {hook_event_name: Internal['hook_event_name']}, extra: Partial<Internal['stopbar']> = {}): Internal {
  return {...base, stopbar: {adapter, rawKeys: Object.keys(raw), event, ...extra}} as Internal
}

/** Exit code inside a tool result: a number field, or text such as "Exit code: 1" / "exited with code 1" / "Exit Code: 1". */
export function exitCodeIn(r: unknown, depth = 0): number | undefined {
  if (r === null || r === undefined || depth > 3) return undefined
  if (typeof r === 'string') {
    const t = r.trim()
    if (t.startsWith('{')) { try { return exitCodeIn(JSON.parse(t), depth + 1) } catch { /* plain text */ } }
    const m = /(?:exit(?:ed with)?[ _]?code|exit status)\s*[:=]?\s*(-?\d+)/i.exec(t)
    return m ? Number(m[1]) : undefined
  }
  if (typeof r !== 'object') return undefined
  const o = r as Record<string, unknown>
  for (const k of ['exitCode', 'exit_code', 'returnCode', 'code', 'status_code']) if (typeof o[k] === 'number') return o[k] as number
  for (const k of ['metadata', 'result', 'output', 'llmContent', 'returnDisplay']) { const c = exitCodeIn(o[k], depth + 1); if (c !== undefined) return c }
  return undefined
}

export const json = (o: unknown) => JSON.stringify(o)
