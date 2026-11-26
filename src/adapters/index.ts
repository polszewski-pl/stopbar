// `stopbar hook --adapter auto|claude|cursor|codex|gemini|antigravity`. Auto detection is deterministic and ordered by
// the most specific marker; a payload no adapter recognises fails closed (exit 2). Claude Code payloads (v1.0) are
// detected as claude, so existing settings keep working without --adapter.
import {type Out, runEvent} from '../hook.ts'
import {antigravity} from './antigravity.ts'
import {claude} from './claude.ts'
import {codex} from './codex.ts'
import {cursor} from './cursor.ts'
import {gemini} from './gemini.ts'
import {ADAPTERS, type Adapter, type AdapterName, type Rendered} from './types.ts'

export const BY_NAME: Record<AdapterName, Adapter> = {claude, codex, cursor, gemini, antigravity}
// order matters: camelCase Antigravity, Cursor ids, Gemini-only event names, Codex turn_id, then Claude Code
const ORDER: Adapter[] = [antigravity, cursor, gemini, codex, claude]

export function detect(input: Record<string, unknown>): Adapter | null {
  for (const a of ORDER) if (a.detect(input)) return a
  return null
}

const ALIASES: Record<string, AdapterName> = {agy: 'antigravity', 'claude-code': 'claude'}
export function adapterByName(n: string): Adapter | null {
  const k = (ALIASES[n] ?? n) as AdapterName
  return ADAPTERS.includes(k) ? BY_NAME[k] : null
}

const failClosed = (why: string): Out => ({code: 2, msg: `STOPBAR FAIL-CLOSED: ${why}`})

/** One hook call: raw stdin JSON in, the client's exit code and output out. Never throws. */
export function handle(raw: string, which = 'auto', t0 = performance.now()): Rendered {
  const explicit = which === 'auto' ? null : adapterByName(which)
  if (which !== 'auto' && !explicit) return claude.render('pre-tool', failClosed(`unknown adapter ${JSON.stringify(which)}; known: auto, ${ADAPTERS.join(', ')}`), null)
  let input: any
  try { input = JSON.parse(raw) } catch (e) { return (explicit ?? claude).render('pre-tool', failClosed(`hook input is not JSON (${(e as Error).message})`), null) }
  if (!input || typeof input !== 'object' || Array.isArray(input)) return (explicit ?? claude).render('pre-tool', failClosed('hook input must be a JSON object'), null)
  const a = explicit ?? detect(input)
  if (!a) return claude.render('pre-tool', failClosed('unknown hook payload: no adapter recognises it (use --adapter)'), null)
  let n
  try { n = a.normalize(input) } catch (e) { return a.render('pre-tool', failClosed(`cannot read the ${a.name} payload (${(e as Error).message})`), input) }
  if (!n.event) return a.render('other', {code: 0}, input)
  return a.render(n.kind, runEvent(n.event, t0), input)
}

export {ADAPTERS}
