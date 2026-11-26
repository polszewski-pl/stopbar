// stopbar CLI. Exit codes: hook 0 = allow, 2 = block or fail closed. Human commands: 0 = ok, 1 = refused, 2 = fail closed.
import {readFileSync} from 'node:fs'
import {VERSION} from './store.ts'

const t0 = performance.now()
const argv = process.argv.slice(2)
const cmd = argv[0] ?? 'help'

const HELP = `stopbar ${VERSION}: proven gates for coding agents (Claude Code hooks)

  stopbar init --build "<cmd>" --test "<cmd>" [--profile default|ts|python|strict] [--base-ref <ref>] [--max-retries 3] [--cap 500]
               [--cost 1] [--hooks claude,claude-project,cursor,codex,gemini,antigravity,git] [--no-pin] [--force] [--force-hooks] [--repo <dir>]
               [--cli "<cmd>"] [--stop-gate block|warn]
                                   --cli: command that starts Stopbar in hints (default: npx --no-install stopbar)
                                   --stop-gate warn: Stop only warns; git commit and git push stay blocked until the gates pass
  stopbar upgrade [--hooks <targets>] [--force-hooks] [--repo <dir>]
                                   a human re-pins the hook runtime from this package (and rewrites hooks with --hooks);
                                   state, gates, taint and budget stay as they are
  stopbar hook [--adapter auto|claude|cursor|codex|gemini|antigravity]
                                   the agent hook (JSON on stdin); auto detects the client from the payload
  stopbar git-hook pre-commit|pre-push   fallback gate run by git (installed by init --hooks git)
  stopbar run build|test           runs the configured gate command and records its exit status
  stopbar status [--json]          gates, taint, budget, why a commit is blocked
  stopbar approve-tests [--rev N]  a human reviewed the changed tests/config up to revision N (default: current)
  stopbar approve-shell            a human allows ONE risky or outbound call after a secret was read
  stopbar resume --extra N         a human lifts a halt and adds N to the budget
  stopbar reset                    a human starts a fresh kernel state (config and event log stay)
  stopbar doctor [--json]          environment, config, state, hooks and a dry run

Four pillars:
  PROVE   stopbar prove [--out f.json] [--lean f.lean]   inductive proof of the kernel and the 10 mutants
          (npm run verify:lean checks the Lean export with lake build in Docker)
  PROBE   stopbar probe [--target wrapper] [--runs 200] [--seed 1] [--jobs N] [--work dir] [--out dir]
          stateful probing of the hooks against the proven kernel on real git repositories
  GATE    init, upgrade, hook, status, approve-tests, approve-shell, resume, reset, doctor (above)
  ATTEST  stopbar attest [--format json|md]   deterministic attestation: HEAD, tree, gates, human actions, log sha256
All commands take --repo <dir> (default: the current directory). 'verify' is an alias of 'prove'.`

function opts(a: string[]) {
  const get = (name: string) => { const i = a.indexOf(`--${name}`); return i >= 0 && i + 1 < a.length ? a[i + 1] : undefined }
  return {
    get, has: (name: string) => a.includes(`--${name}`),
    int: (name: string, def: number) => {
      const raw = get(name); if (raw === undefined) return def
      const n = Number(raw); if (!/^\d+$/.test(raw) || !Number.isSafeInteger(n)) throw new Error(`--${name} must be a non-negative integer`)
      return n
    },
  }
}

async function main(): Promise<{code: number; msg?: string}> {
  if (cmd === 'hook') {
    const {handle} = await import('./adapters/index.ts')
    const i = argv.indexOf('--adapter')
    const which = i >= 0 ? argv[i + 1] ?? '' : 'auto'
    let raw: string
    try { raw = readFileSync(0, 'utf8') } catch (e) { return {code: 2, msg: `STOPBAR FAIL-CLOSED: cannot read stdin (${(e as Error).message})`} }
    const r = handle(raw, which, t0)
    if (r.stdout) process.stdout.write(r.stdout)
    if (r.stderr) process.stderr.write(r.stderr)
    return {code: r.code}
  }
  if (cmd === 'git-hook') return (await import('./githook.ts')).gitHook(argv[1] ?? '', opts(argv.slice(2)))
  if (cmd === 'run') return (await import('./run.ts')).runGate(argv[1] ?? '', opts(argv.slice(2)))
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') return {code: 0, msg: HELP}
  if (cmd === '--version' || cmd === 'version') return {code: 0, msg: VERSION}
  const o = opts(argv.slice(1))
  if (cmd === 'init') return (await import('./commands.ts')).init(o)
  if (cmd === 'upgrade') return (await import('./commands.ts')).upgrade(o)
  if (['status', 'approve-tests', 'approve-shell', 'resume', 'reset'].includes(cmd)) return (await import('./commands.ts')).human(cmd, o)
  if (cmd === 'doctor') return (await import('./doctor.ts')).doctor({repo: o.get('repo'), json: o.has('json')})
  if (cmd === 'prove' || cmd === 'verify') {
    const r = await (await import('./verify.ts')).verify({out: o.get('out'), lean: o.get('lean')})
    return {code: r.ok ? 0 : 1}
  }
  if (cmd === 'probe') {
    const P = await import('./probe/index.ts')
    if (o.has('worker')) { await P.worker(JSON.parse(o.get('worker')!)); return {code: 0} }
    const num = (n: string) => (o.get(n) === undefined ? undefined : o.int(n, 0))
    const r = await P.probe({target: o.get('target'), runs: num('runs'), seed: num('seed'), jobs: num('jobs'), work: o.get('work'), out: o.get('out'),
      regressions: o.get('regressions'), regressionsOnly: o.has('regressions-only')})
    return {code: r.ok ? 0 : 1}
  }
  if (cmd === 'attest') return (await import('./attest.ts')).attest({repo: o.get('repo'), format: o.get('format')})
  return {code: 1, msg: `unknown command ${cmd}\n\n${HELP}`}
}

let res: {code: number; msg?: string}
try { res = await main() } catch (e) {
  const {failMsg} = await import('./hook.ts')
  res = {code: 2, msg: failMsg(e)}
}
if (res.msg) (res.code === 0 ? process.stdout : process.stderr).write(res.msg + '\n')
process.exitCode = res.code
