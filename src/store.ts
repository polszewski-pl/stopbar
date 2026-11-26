// State, config and event log in <git-dir>/stopbar/. Lock for concurrent hooks. Damaged files fail closed.
import {closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync, writeSync} from 'node:fs'
import {join} from 'node:path'
import {type Config, ConfigError, validateConfig} from './config.ts'
import {CODEC} from './kernel.gen.js'
import {FailClosed, type Repo} from './repo.ts'

export const VERSION = '1.2.0'
export type KState = {scalars: Record<string, number>; maps: Record<string, unknown>}
export type Saved = {version: 2; kernel: KState; snapshot: string; params: {maxRetries: number; cap: number}}

const files = (r: Repo) => ({
  config: join(r.stateDir, 'config.json'), state: join(r.stateDir, 'state.json'),
  events: join(r.stateDir, 'events.jsonl'), lock: join(r.stateDir, 'lock'),
})
export const paths = files

// ---------------------------------------------------------------- lock
const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' }
}
/** Exclusive lock file with the owner's pid. A lock whose owner died, or older than 60 s, is stale and taken over. */
export function withLock<T>(r: Repo, f: () => T, waitMs = 20000): T {
  const lock = files(r).lock
  mkdirSync(r.stateDir, {recursive: true})
  const until = Date.now() + waitMs
  for (;;) {
    try {
      const fd = openSync(lock, 'wx')
      writeSync(fd, String(process.pid)); closeSync(fd)
      break
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
      let stale = false
      try {
        const pid = Number(readFileSync(lock, 'utf8'))
        const age = Date.now() - statSync(lock).mtimeMs
        stale = (Number.isSafeInteger(pid) && pid > 0 && !alive(pid)) || age > 60000
      } catch { /* lock vanished between calls */ }
      if (stale) { rmSync(lock, {force: true}); continue }
      if (Date.now() > until) throw new FailClosed(`lock ${lock} busy for ${waitMs / 1000} s`, 'another Stopbar hook is running; if none is, delete the lock file')
      sleep(5)
    }
  }
  try { return f() } finally { rmSync(lock, {force: true}) }
}

// ---------------------------------------------------------------- config
export function readConfig(r: Repo): Config {
  const f = files(r).config
  if (!existsSync(f)) throw new FailClosed(`Stopbar is not initialised in ${r.root} (no ${f})`, 'a human runs: stopbar init --build "<cmd>" --test "<cmd>"')
  const raw = readFileSync(f, 'utf8')
  if (!raw.trim()) throw new FailClosed(`config.json is empty: ${f}`, 'a human runs `stopbar init --force --build "<cmd>" --test "<cmd>"` to write it again')
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch (e) {
    throw new FailClosed(`config.json is not valid JSON (${(e as Error).message}): ${f}`, 'a human fixes the file or runs `stopbar init --force --build "<cmd>" --test "<cmd>"`')
  }
  try { return validateConfig(parsed) } catch (e) {
    if (e instanceof ConfigError) throw new FailClosed(`config.json is invalid: ${e.message}: ${f}`, 'a human fixes the field or runs `stopbar init --force ...`')
    throw e
  }
}
export function writeConfig(r: Repo, c: Config) {
  mkdirSync(r.stateDir, {recursive: true})
  atomicWrite(files(r).config, JSON.stringify(c, null, 2) + '\n')
}

// ---------------------------------------------------------------- state
function atomicWrite(f: string, data: string) {
  const tmp = `${f}.${process.pid}.tmp`
  writeFileSync(tmp, data)
  for (let i = 0; ; i++) {
    try { renameSync(tmp, f); return } catch (e) {
      // Windows: a reader (antivirus, indexer) may hold the target for a moment
      if (i >= 20 || !['EPERM', 'EACCES', 'EBUSY'].includes((e as NodeJS.ErrnoException).code ?? '')) { rmSync(tmp, {force: true}); throw e }
      sleep(10)
    }
  }
}

const isNat = (x: unknown) => typeof x === 'number' && Number.isSafeInteger(x) && x >= 0
export function validateState(s: unknown): Saved {
  const bad = (why: string): never => { throw new Error(why) }
  if (!s || typeof s !== 'object') bad('not an object')
  const o = s as Saved
  if (o.version !== 2) bad(`version must be 2, got ${JSON.stringify(o.version)}`)
  if (typeof o.snapshot !== 'string' || !/^[0-9a-f]{40,64}$/.test(o.snapshot)) bad('snapshot must be a git tree id')
  if (!o.params || !isNat(o.params.maxRetries) || !isNat(o.params.cap) || o.params.maxRetries < 1 || o.params.cap < 1) bad('params.maxRetries and params.cap must be integers >= 1')
  const k = o.kernel
  if (!k || typeof k !== 'object' || !k.scalars || typeof k.scalars !== 'object' || !k.maps || typeof k.maps !== 'object') bad('kernel must hold scalars and maps')
  const names = CODEC.state.map((f) => f.name)
  for (const name of Object.keys(k.scalars)) if (!names.includes(name)) bad(`unknown kernel field ${name}`)
  for (const f of CODEC.state) {
    const v = k.scalars[f.name]
    if (!isNat(v)) bad(`kernel field ${f.name} must be a natural number`)
    if (f.kind === 'bool' && v > 1) bad(`kernel field ${f.name} must be 0 or 1`)
    if (f.kind === 'oneOf' && v >= f.values!.length) bad(`kernel field ${f.name} out of range`)
  }
  return o
}
export function readState(r: Repo): Saved {
  const f = files(r).state
  const fix = 'a human runs `stopbar reset` (fresh kernel state; the event log is kept) and re-runs the build and the full test suite'
  if (!existsSync(f)) throw new FailClosed(`state.json is missing: ${f}`, fix)
  const raw = readFileSync(f, 'utf8')
  if (!raw.trim()) throw new FailClosed(`state.json is empty: ${f}`, fix)
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch (e) { throw new FailClosed(`state.json is not valid JSON (${(e as Error).message}): ${f}`, fix) }
  try { return validateState(parsed) } catch (e) { throw new FailClosed(`state.json is invalid: ${(e as Error).message}: ${f}`, fix) }
}
export function writeState(r: Repo, s: Saved) { atomicWrite(files(r).state, JSON.stringify(s)) }

// ---------------------------------------------------------------- event log
/** Appends one JSON line. If the last line was torn (a crash mid-write left no final newline), a newline goes first,
 *  so the torn fragment stays a line of its own and the new entry is never glued onto it. Call under the lock. */
export function appendEvent(r: Repo, entry: Record<string, unknown>) {
  const f = files(r).events
  const line = JSON.stringify({ts: new Date().toISOString(), ...entry}) + '\n'
  const fd = openSync(f, 'a+')
  try {
    const size = fstatSync(fd).size
    let lead = ''
    if (size > 0) {
      const b = Buffer.alloc(1)
      readSync(fd, b, 0, 1, size - 1)
      if (b[0] !== 0x0a) lead = '\n'
    }
    writeSync(fd, lead + line)
  } finally { closeSync(fd) }
}

export type EventLog = {events: Record<string, any>[]; torn: {line: number; text: string}[]}
export function readEvents(r: Repo): EventLog {
  const f = files(r).events
  if (!existsSync(f)) return {events: [], torn: []}
  const out: EventLog = {events: [], torn: []}
  readFileSync(f, 'utf8').split('\n').forEach((l, i) => {
    if (!l) return
    try { out.events.push(JSON.parse(l)) } catch { out.torn.push({line: i + 1, text: l.slice(0, 120)}) }
  })
  return out
}
