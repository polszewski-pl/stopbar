// PROBE targets in any language: `stopbar probe --cmd "<command>"` starts the command once per worker and speaks
// line-delimited JSON (NDJSON) with it on stdin/stdout, one request and one answer per line, in order:
//   {"op":"info"}                                        -> {"name":"...","description":"...","mutants":["M1",...]}
//   {"op":"generate","seed":123}                         -> {"seed":123,"actions":[...]}
//   {"op":"execute","run":{...},"dir":"...","mutant":"M1"} -> an Outcome ({"ok":true,"steps":N,"cov":{...}} or
//                                                           {"ok":false,"mismatch":{"step","action","what","expected","actual"}})
// Any answer may be {"error":"..."} instead. stdout carries only the protocol; the program logs to stderr. A process
// that exits, closes stdout, answers with something that is not JSON or does not answer within the timeout is an
// error (ProbeError with the end of its stderr), never a hung worker.
import {spawn, spawnSync, type ChildProcess} from 'node:child_process'
import {existsSync, statSync} from 'node:fs'
import {resolve} from 'node:path'
import type {Outcome, ProbeRun} from './sdk.ts'

/** A refusal of the user's input (unknown file, bad export, no mutants, a broken --cmd): the CLI exits 1 with it. */
export class ProbeError extends Error {}

export type CmdInfo = {name: string; description: string; mutants?: string[]}
export type CmdOptions = {cwd?: string; /** per answer, default 300000 ms; 0 = no limit */ timeoutMs?: number}

/** Splits a command line into words: whitespace separates, '...' and "..." group (no escapes inside '...'). */
export function splitCommand(cmd: string): string[] {
  const out: string[] = []
  let cur = '', inWord = false, q: '"' | "'" | null = null
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]
    if (q) {
      if (c === q) q = null
      else if (q === '"' && c === '\\' && (cmd[i + 1] === '"' || cmd[i + 1] === '\\')) cur += cmd[++i]
      else cur += c
    } else if (c === '"' || c === "'") { q = c; inWord = true } else if (/\s/.test(c)) { if (inWord) out.push(cur); cur = ''; inWord = false } else { cur += c; inWord = true }
  }
  if (inWord) out.push(cur)
  return out
}

/** The file a command runs: the first word after the interpreter that names an existing file (relative to `cwd`). */
export function commandFile(cmd: string, cwd = process.cwd()): string | null {
  for (const w of splitCommand(cmd).slice(1)) {
    if (w.startsWith('-')) continue
    const f = resolve(cwd, w)
    try { if (existsSync(f) && statSync(f).isFile()) return f } catch { /* not a file */ }
  }
  return null
}

const NAT = (n: unknown) => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0
const isObj = (x: unknown): x is Record<string, any> => !!x && typeof x === 'object' && !Array.isArray(x)

/** One long-lived process of a --cmd target. Requests go one at a time; `close` ends stdin and kills it if needed. */
export class CmdClient {
  readonly cmd: string
  private ch: ChildProcess | null = null
  private buf = ''
  private err = ''
  private exited: string | null = null
  private waiting: {op: string; ok: (v: unknown) => void; bad: (e: Error) => void; timer?: ReturnType<typeof setTimeout>} | null = null
  private chain: Promise<unknown> = Promise.resolve()
  private readonly cwd: string
  private readonly timeoutMs: number

  constructor(cmd: string, o: CmdOptions = {}) {
    if (!cmd.trim()) throw new ProbeError('--cmd needs a command, e.g. --cmd "python my_probe.py"')
    this.cmd = cmd; this.cwd = o.cwd ?? process.cwd(); this.timeoutMs = o.timeoutMs ?? 300_000
  }

  private stderrTail(): string {
    const t = this.err.trim()
    return t ? `; stderr: ${t.length > 600 ? '...' + t.slice(-600) : t}` : '; stderr: (empty)'
  }

  private fail(why: string) {
    const w = this.waiting
    this.waiting = null
    if (w) { if (w.timer) clearTimeout(w.timer); w.bad(new ProbeError(`probe command ${JSON.stringify(this.cmd)} ${why} (waiting for the answer to ${w.op})${this.stderrTail()}`)) }
  }

  private start(): ChildProcess {
    if (this.ch && this.exited === null) return this.ch
    this.buf = ''; this.err = ''; this.exited = null
    // a shell, so the command line works as typed (python, py -3, npx tsx, a script with a #!)
    const ch = spawn(this.cmd, {cwd: this.cwd, shell: true, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32'})
    this.ch = ch
    ch.stdout!.setEncoding('utf8'); ch.stderr!.setEncoding('utf8')
    const live = () => this.ch === ch // handlers of an earlier process of this client do nothing
    ch.stderr!.on('data', (d: string) => { if (live()) this.err = (this.err + d).slice(-4000) })
    ch.stdout!.on('data', (d: string) => {
      if (!live()) return
      this.buf += d
      for (let i = this.buf.indexOf('\n'); i >= 0; i = this.buf.indexOf('\n')) {
        const line = this.buf.slice(0, i).trim()
        this.buf = this.buf.slice(i + 1)
        if (!line) continue
        const w = this.waiting
        if (!w) { this.err += `\n[stopbar] unexpected line on stdout: ${line.slice(0, 200)}`; continue }
        let v: unknown
        try { v = JSON.parse(line) } catch {
          this.fail(`printed a line that is not JSON: ${JSON.stringify(line.slice(0, 200))} (stdout is for the protocol only; log to stderr)`)
          this.kill(); return
        }
        this.waiting = null
        if (w.timer) clearTimeout(w.timer)
        w.ok(v)
      }
    })
    const gone = () => { if (live() && this.waiting) this.fail(this.exited ? `${this.exited} before answering` : 'closed stdout') }
    // stdout may end before 'exit' arrives: wait a moment so the error names the exit code
    ch.stdout!.on('end', () => setTimeout(gone, 100))
    ch.stdin!.on('error', () => { /* EPIPE after an exit: reported below */ })
    ch.on('error', (e) => { if (!live()) return; this.exited = `failed to start: ${e.message}`; this.fail(this.exited) })
    ch.on('exit', (code, sig) => { if (live()) this.exited = `exited with ${sig ? `signal ${sig}` : `code ${code}`}` })
    ch.on('close', gone)
    return ch
  }

  /** Sends one request and waits for its answer line (requests are queued, one at a time). */
  request(msg: Record<string, unknown>): Promise<unknown> {
    const go = () => new Promise<unknown>((ok, bad) => {
      const ch = this.start()
      const op = String(msg.op)
      this.waiting = {op, ok, bad}
      if (this.timeoutMs > 0) this.waiting.timer = setTimeout(() => { this.fail(`did not answer within ${this.timeoutMs} ms`); this.kill() }, this.timeoutMs)
      try { ch.stdin!.write(JSON.stringify(msg) + '\n') } catch (e) { this.fail(`does not read stdin: ${(e as Error).message}`) }
    })
    const p = this.chain.then(go, go)
    this.chain = p.catch(() => undefined)
    return p
  }

  private async ask(msg: Record<string, unknown>): Promise<Record<string, any>> {
    const v = await this.request(msg)
    if (isObj(v) && typeof v.error === 'string') throw new ProbeError(`probe command ${JSON.stringify(this.cmd)} answered ${msg.op} with an error: ${v.error}${this.stderrTail()}`)
    if (!isObj(v)) throw new ProbeError(`probe command ${JSON.stringify(this.cmd)}: the answer to ${msg.op} is not a JSON object: ${JSON.stringify(v)?.slice(0, 200)}`)
    return v
  }

  private bad(op: string, why: string, v: unknown): never {
    throw new ProbeError(`probe command ${JSON.stringify(this.cmd)}: bad answer to ${op}: ${why}; got ${JSON.stringify(v)?.slice(0, 300)}`)
  }

  async info(): Promise<CmdInfo> {
    const v = await this.ask({op: 'info'})
    if (typeof v.name !== 'string' || !v.name) this.bad('info', 'name must be a non-empty string', v)
    if (typeof v.description !== 'string') this.bad('info', 'description must be a string', v)
    if (v.mutants !== undefined && v.mutants !== null && !(Array.isArray(v.mutants) && v.mutants.every((m: unknown) => typeof m === 'string' && m))) this.bad('info', 'mutants must be a list of names', v)
    return {name: v.name, description: v.description, ...(Array.isArray(v.mutants) ? {mutants: v.mutants} : {})}
  }

  async generate(seed: number): Promise<ProbeRun> {
    const v = await this.ask({op: 'generate', seed})
    if (v.seed !== seed) this.bad('generate', `seed must be ${seed}`, v)
    if (!Array.isArray(v.actions)) this.bad('generate', 'actions must be a list', v)
    return {...v, seed, actions: v.actions}
  }

  async execute(run: ProbeRun, dir: string, mutant?: string): Promise<Outcome> {
    const v = await this.ask({op: 'execute', run, dir, ...(mutant === undefined ? {} : {mutant})})
    if (v.ok === true) {
      if (!NAT(v.steps)) this.bad('execute', 'steps must be an integer >= 0', v)
      const cov = v.cov ?? {}
      if (!isObj(cov) || !Object.values(cov).every(NAT)) this.bad('execute', 'cov must map names to integers >= 0', v)
      return {ok: true, steps: v.steps, cov}
    }
    if (v.ok === false) {
      const m = v.mismatch
      if (!isObj(m) || !Number.isSafeInteger(m.step) || m.step < -1 || typeof m.what !== 'string' || !m.what) this.bad('execute', 'mismatch needs step (integer >= -1) and what (non-empty string)', v)
      return {ok: false, mismatch: {step: m.step, action: m.action ?? null, what: m.what, expected: m.expected ?? null, actual: m.actual ?? null}}
    }
    return this.bad('execute', 'ok must be true or false', v)
  }

  private kill() {
    const ch = this.ch
    if (!ch || ch.pid === undefined || this.exited !== null) return
    try {
      if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(ch.pid), '/T', '/F'], {stdio: 'ignore', windowsHide: true})
      else process.kill(-ch.pid, 'SIGKILL')
    } catch { try { ch.kill('SIGKILL') } catch { /* gone */ } }
  }

  /** Ends stdin (a well-behaved target exits on EOF); kills the process tree after `graceMs`. */
  async close(graceMs = 2000): Promise<void> {
    const ch = this.ch
    if (!ch || this.exited !== null) return
    await this.chain
    if (this.exited !== null) return
    const gone = new Promise<void>((ok) => ch.once('exit', () => ok()))
    try { ch.stdin!.end() } catch { /* already closed */ }
    const timer = new Promise<'late'>((ok) => { const t = setTimeout(() => ok('late'), graceMs); t.unref?.() })
    if (await Promise.race([gone.then(() => 'gone' as const), timer]) === 'late') { this.kill(); await Promise.race([gone, new Promise((ok) => setTimeout(ok, 1000))]) }
  }
}
