// Hook latency benchmark: wall-clock time of whole hook processes, as Claude Code sees them (spawn + Node start +
// module load + git + handler). Also a breakdown: bare Node start, importing gdp-wired, one git process, and the number
// and time of git processes per hook (a preload counts them, so a baseline is measured unmodified).
// Usage: node bench/hook-latency.ts [--rounds 30] [--baseline <path of another hook CLI with the same init and hook commands>]
import {spawnSync} from 'node:child_process'
import {existsSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
import {dirname, join, resolve} from 'node:path'
import {fileURLToPath, pathToFileURL} from 'node:url'
import {percentile} from '../tests/lib.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TMP = join(ROOT, '.bench-tmp')
const OUT = join(ROOT, '.test-out', 'bench')
const argv = process.argv.slice(2)
const arg = (n: string, d?: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d }
const ROUNDS = Number(arg('rounds', '30'))
const BASE_CLI = arg('baseline')
const PRELOAD = pathToFileURL(join(ROOT, 'bench', 'count-git.mjs')).href
const ENV = {...process.env, GIT_AUTHOR_NAME: 'b', GIT_AUTHOR_EMAIL: 'b@x.invalid', GIT_COMMITTER_NAME: 'b', GIT_COMMITTER_EMAIL: 'b@x.invalid'}

const wall = (f: () => void) => { const t = performance.now(); f(); return performance.now() - t }
const stats = (xs: number[]) => ({n: xs.length, p50: Math.round(percentile(xs, 50)), p95: Math.round(percentile(xs, 95)), max: Math.round(Math.max(...xs))})
function g(cwd: string, ...a: string[]) { const r = spawnSync('git', a, {cwd, env: ENV, encoding: 'utf8'}); if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`) }

function makeRepo(name: string) {
  const d = join(TMP, name)
  rmSync(d, {recursive: true, force: true, maxRetries: 5}); mkdirSync(join(d, 'src'), {recursive: true}); mkdirSync(join(d, 'tests'), {recursive: true})
  for (let i = 0; i < 300; i++) writeFileSync(join(d, 'src', `m${i}.mjs`), `export const v${i} = ${i}\n`)
  for (let i = 0; i < 30; i++) writeFileSync(join(d, 'tests', `m${i}.test.mjs`), `// test ${i}\n`)
  writeFileSync(join(d, '.gitignore'), '.env\n')
  g(d, 'init', '-q'); g(d, 'config', 'core.autocrlf', 'false'); g(d, 'add', '-A'); g(d, 'commit', '-qm', 'base')
  return d
}

type Impl = {name: string; cli: string[]; init: (repo: string) => void}
function bench(impl: Impl) {
  const repo = makeRepo(impl.name)
  impl.init(repo)
  const gitLog = join(TMP, `${impl.name}-git.jsonl`); rmSync(gitLog, {force: true})
  const hook = (payload: object) => {
    const ms = wall(() => {
      const r = spawnSync(process.execPath, ['--import', PRELOAD, ...impl.cli, 'hook'], {input: JSON.stringify({session_id: 'bench', cwd: repo, ...payload}), encoding: 'utf8', env: {...ENV, BENCH_GIT_OUT: gitLog}})
      if (r.status !== 0 && r.status !== 2) throw new Error(`${impl.name} hook exit ${r.status}: ${r.stderr}`)
    })
    return ms
  }
  const kinds: Record<string, number[]> = {}
  const order: string[] = []
  const rec = (k: string, ms: number) => { (kinds[k] ??= []).push(ms); order.push(k) }
  for (let i = 0; i < ROUNDS; i++) {
    const f = join(repo, 'src', `m${i % 300}.mjs`)
    rec('Pre Read', hook({hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: {file_path: f}}))
    rec('Pre Write', hook({hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: {file_path: f, content: 'x'}}))
    writeFileSync(f, `export const v = ${i}\n// edit ${Date.now()}\n`)
    rec('Post Write (tree changed)', hook({hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: {file_path: f}, tool_response: {filePath: f, success: true}}))
    rec('Pre Bash', hook({hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: {command: 'ls -la'}}))
    rec('Post Bash (no change)', hook({hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: {command: 'ls -la'}, tool_response: {stdout: '', stderr: '', interrupted: false, isImage: false}}))
    rec('Pre Bash commit', hook({hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: {command: 'git commit -m x'}}))
    if (i % 3 === 0) rec('Stop', hook({hook_event_name: 'Stop'}))
    if (impl.name === 'stopbar') {
      // adapter path: the same decisions with Cursor and Antigravity payloads (auto detection)
      rec('Pre Shell (cursor)', hook({conversation_id: 'c', generation_id: 'g', cursor_version: '2.1', workspace_roots: [repo], hook_event_name: 'preToolUse', tool_name: 'Shell', tool_input: {command: 'ls -la'}}))
      rec('Post Shell (cursor)', hook({conversation_id: 'c', generation_id: 'g', cursor_version: '2.1', workspace_roots: [repo], hook_event_name: 'postToolUse', tool_name: 'Shell', tool_input: {command: 'ls -la'}, tool_output: '{"exitCode":0}'}))
      rec('Pre run_command (antigravity)', hook({conversationId: 'c', workspacePaths: [repo], hookEventName: 'PreToolUse', toolCall: {id: '1', name: 'run_command', args: {CommandLine: 'ls -la'}}}))
    }
  }
  const git = readFileSync(gitLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  const perKind: Record<string, any> = {}
  for (const [k, xs] of Object.entries(kinds)) {
    const idx = order.map((o, i) => (o === k ? i : -1)).filter((i) => i >= 0)
    const gc = idx.map((i) => git[i]).filter(Boolean)
    perKind[k] = {...stats(xs), gitCalls: Math.round(gc.reduce((s, x) => s + x.gitCalls, 0) / gc.length * 10) / 10,
      gitMsP50: Math.round(percentile(gc.map((x) => x.gitMs), 50)), inProcessP50: Math.round(percentile(gc.map((x) => x.uptimeMs), 50))}
  }
  const all = Object.values(kinds).flat()
  return {impl: impl.name, rounds: ROUNDS, all: stats(all), perKind}
}

function breakdown() {
  const N = 15
  const node0 = Array.from({length: N}, () => wall(() => spawnSync(process.execPath, ['-e', '0'])))
  const gw = Array.from({length: N}, () => wall(() => spawnSync(process.execPath, ['--input-type=module', '-e', "await import('gdp-wired')"], {cwd: ROOT})))
  const sb = Array.from({length: N}, () => wall(() => spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify('file:///' + join(ROOT, 'dist', 'hook.js').replace(/\\/g, '/'))})`])))
  const repo = join(TMP, 'stopbar')
  const gv = Array.from({length: N}, () => wall(() => spawnSync('git', ['--version'])))
  const ga = Array.from({length: N}, () => wall(() => spawnSync('git', ['add', '-A'], {cwd: repo, env: {...process.env, GIT_INDEX_FILE: join(repo, '.git', 'stopbar', 'snapshot.index')}})))
  return {nodeStart: stats(node0), nodePlusGdpWiredImport: stats(gw), nodePlusStopbarHookModules: stats(sb), gitVersion: stats(gv), gitAddAllPrivateIndex: stats(ga)}
}

rmSync(TMP, {recursive: true, force: true, maxRetries: 5}); mkdirSync(TMP, {recursive: true}); mkdirSync(OUT, {recursive: true})
const res: Record<string, unknown> = {date: new Date().toISOString(), node: process.version, platform: `${process.platform} ${process.arch}`, rounds: ROUNDS}
const impls: Impl[] = [{
  name: 'stopbar', cli: [join(ROOT, 'bin', 'stopbar.mjs')],
  init: (repo) => { const r = spawnSync(process.execPath, [join(ROOT, 'bin', 'stopbar.mjs'), 'init', '--build', 'node build.mjs', '--test', 'node --test', '--no-pin', '--repo', repo], {encoding: 'utf8'}); if (r.status !== 0) throw new Error(r.stderr) },
}]
if (BASE_CLI) {
  if (!existsSync(BASE_CLI)) throw new Error(`no baseline CLI at ${BASE_CLI}`)
  impls.unshift({
    name: 'baseline', cli: [BASE_CLI],
    init: (repo) => { const r = spawnSync(process.execPath, [BASE_CLI, 'init', '--build', 'node build.mjs', '--test', 'node --test', '--repo', repo], {encoding: 'utf8'}); if (r.status !== 0) throw new Error(r.stderr) },
  })
}
for (const impl of impls) { res[impl.name] = bench(impl); console.log(JSON.stringify(res[impl.name], null, 1)) }
res.breakdown = breakdown()
console.log(JSON.stringify(res.breakdown, null, 1))
writeFileSync(join(OUT, 'hook-latency.json'), JSON.stringify(res, null, 1) + '\n')
rmSync(TMP, {recursive: true, force: true, maxRetries: 5})
