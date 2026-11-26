// Test helpers shared by the E2E test, the fuzzer and the benchmark.
import {execFileSync} from 'node:child_process'
import {existsSync} from 'node:fs'
import {join, resolve} from 'node:path'

/** bash to run agent commands with, as Claude Code's Bash tool does. On Windows: Git Bash next to git (never WSL). */
export function findBash(): string | null {
  if (process.platform !== 'win32') return existsSync('/bin/bash') ? '/bin/bash' : null
  try {
    const exec = execFileSync('git', ['--exec-path'], {encoding: 'utf8'}).trim() // <Git>/<mingw64|ucrt64>/libexec/git-core
    const gitRoot = resolve(exec, '..', '..', '..')
    for (const c of [join(gitRoot, 'bin', 'bash.exe'), join(gitRoot, 'usr', 'bin', 'bash.exe')]) if (existsSync(c)) return c
  } catch { /* no git */ }
  return null
}

export function percentile(xs: number[], p: number): number {
  const s = [...xs].sort((a, b) => a - b)
  if (!s.length) return NaN
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))]
}
