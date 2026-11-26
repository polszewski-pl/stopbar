#!/usr/bin/env node
// Entry point. Loads only the compiled dist/ (no TypeScript, no prover in hooks).
import('../dist/cli.js').catch((e) => {
  process.stderr.write(`STOPBAR FAIL-CLOSED: cannot load dist/cli.js (${e && e.message}). Run: npm run build\n`)
  process.exitCode = 2
})
