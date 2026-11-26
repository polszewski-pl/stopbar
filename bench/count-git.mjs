// Preload for the benchmark (node --import ./bench/count-git.mjs ...): counts and times git child processes made with
// execFileSync, also for a baseline implementation that cannot be changed. Writes one JSON line per process.
import cp from 'node:child_process'
import {appendFileSync} from 'node:fs'
import {syncBuiltinESMExports} from 'node:module'

const orig = cp.execFileSync
let n = 0, ms = 0
cp.execFileSync = function (file, ...rest) {
  const t = performance.now()
  try { return orig.call(this, file, ...rest) } finally { if (/git/i.test(String(file))) { n++; ms += performance.now() - t } }
}
syncBuiltinESMExports()
const t0 = performance.now()
process.on('exit', () => {
  if (process.env.BENCH_GIT_OUT) appendFileSync(process.env.BENCH_GIT_OUT, JSON.stringify({gitCalls: n, gitMs: Math.round(ms), uptimeMs: Math.round(process.uptime() * 1000), afterPreloadMs: Math.round(performance.now() - t0)}) + '\n')
})
