// Full test suite: unit tests, then the E2E test and the stateful fuzzer (200 sequences) in parallel.
// Usage: node tests/run-all.ts   (run `node scripts/build.ts` first; `npm test` does both). Exit 0 only if all pass.
import {spawn} from 'node:child_process'
import {mkdirSync, readdirSync, writeFileSync} from 'node:fs'
import {dirname, join, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const t0 = Date.now()

function run(name: string, args: string[]): Promise<{name: string; code: number; ms: number; tail: string}> {
  return new Promise((ok) => {
    const t = Date.now()
    const ch = spawn(process.execPath, args, {cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe']})
    let out = ''
    ch.stdout.on('data', (d) => { out += d }); ch.stderr.on('data', (d) => { out += d })
    ch.on('exit', (code) => ok({name, code: code ?? 1, ms: Date.now() - t, tail: tailOf(out, code ?? 1)}))
  })
}

// A failed check names itself at the start of its line: `  [FAIL] <check>` (E2E; doctor output quoted in the log is
// indented deeper and a `[PASS] ... :: [FAIL] ...` detail does not start so), `✖ <test>` / `not ok` (node:test),
// `FAIL seed`, `PROBE FAIL`, `MUTANTS FAIL` (probe), and an assertion message.
const FAIL_LINE = /^ {0,2}\[FAIL\] |^\s*✖ |^\s*not ok\b|^FAIL seed |^(?:PROBE|MUTANTS) FAIL|AssertionError/
/** The last 3 lines; for a failed suite also up to 20 lines that name a failure, so a CI log shows which checks failed. */
function tailOf(out: string, code: number): string {
  const ls = out.trim().split('\n')
  const last = ls.slice(-3)
  if (code === 0) return last.join('\n')
  const fails = ls.slice(0, -3).filter((l) => FAIL_LINE.test(l)).slice(0, 20).map((l) => l.trimEnd().slice(0, 300))
  return [...(fails.length ? ['failures:', ...fails, '...'] : []), ...last].join('\n')
}

const units = readdirSync(join(ROOT, 'tests', 'unit')).filter((f) => f.endsWith('.test.ts')).map((f) => join('tests', 'unit', f))
const unit = await run('unit', ['--test', '--test-reporter=dot', ...units])
const [e2e, fuzz] = await Promise.all([run('e2e', ['tests/e2e.ts']), run('fuzz', ['tests/stateful-wrapper.ts', '--runs', '200'])])
const all = [unit, e2e, fuzz]
for (const r of all) console.log(`${r.code === 0 ? 'PASS' : 'FAIL'} ${r.name.padEnd(5)} ${(r.ms / 1000).toFixed(1)} s\n  ${r.tail.replace(/\n/g, '\n  ')}`)
const ok = all.every((r) => r.code === 0)
mkdirSync(join(ROOT, '.test-out'), {recursive: true})
writeFileSync(join(ROOT, '.test-out', 'test-summary.json'), JSON.stringify({date: new Date().toISOString(), ok, seconds: Math.round((Date.now() - t0) / 1000),
  suites: all.map((r) => ({name: r.name, ok: r.code === 0, seconds: Math.round(r.ms / 1000), tail: r.tail}))}, null, 1) + '\n')
console.log(`TESTS ${ok ? 'PASS' : 'FAIL'} in ${((Date.now() - t0) / 1000).toFixed(0)} s`)
process.exitCode = ok ? 0 : 1
