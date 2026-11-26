// Stateful fuzzer of the wrapper: a thin front end of `stopbar probe --target wrapper` (src/probe/) with the test
// suite's directories. Usage: node tests/stateful-wrapper.ts [--runs 200] [--seed 1] [--jobs N] [--regressions-only]
// A failure is shrunk and written to .test-out/fuzz/repro-<seed>.json; copied into tests/regressions/ it is replayed
// on every run.
import {existsSync} from 'node:fs'
import {dirname, join, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
if (!existsSync(join(ROOT, 'dist', 'probe', 'index.js'))) throw new Error('run npm run build first')
const {probe} = await import('../dist/probe/index.js')
const argv = process.argv.slice(2)
const arg = (n: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? Number(argv[i + 1]) : undefined }
const r = await probe({target: 'wrapper', runs: arg('runs'), seed: arg('seed'), jobs: arg('jobs'), regressionsOnly: argv.includes('--regressions-only'),
  work: join(ROOT, '.fuzz-tmp'), out: join(ROOT, '.test-out', 'fuzz'), regressions: join(ROOT, 'tests', 'regressions')})
process.exitCode = r.ok ? 0 : 1
