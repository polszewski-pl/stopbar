// config.json: gate commands, limits and path patterns. Lives in <git-dir>/stopbar/, out of the agent's reach.
import {hasChain} from './classify.ts'
import {globToRegExp} from './glob.ts'

export type Paths = {tests: string[]; testConfig: string[]; secrets: string[]}
export type Config = {
  version: 1
  profile: string
  buildCmd: string
  fullTestCmd: string
  maxRetries: number
  cap: number
  costPerCall: number
  paths: Paths
  /** Tools that are local and never outbound (globs on the tool name); missing = DEFAULT_SAFE_TOOLS. */
  safeTools?: string[]
  /** Git ref against which a changed test file is judged "existing" (default: HEAD). */
  baseRef?: string
  /** Command that starts this Stopbar CLI, used in hints such as `<cliCmd> run test` (missing = DEFAULT_CLI). */
  cliCmd?: string
  /** Stop hook: 'block' (missing = block) refuses "done" with unverified changes; 'warn' only logs and warns. Commit and push stay gated. */
  stopGate?: StopGate
  /** true: the build and full test gates count only through `stopbar run build|test`; the same command run from the
   *  agent's own shell is not recorded (missing = false). */
  requireRun?: boolean
}
export type StopGate = 'block' | 'warn'
export const STOP_GATES: readonly StopGate[] = ['block', 'warn']
/** Hint command when config.cliCmd is not set: uses an installed stopbar only, never downloads it from the registry. */
export const DEFAULT_CLI = 'npx --no-install stopbar'

const TEST_COMMON = ['**/tests/**', '**/test/**', '**/__tests__/**', 'scripts/*test*']
const TEST_JS = ['**/*.test.*', '**/*.spec.*', '**/e2e/**']
const TEST_PY = ['**/test_*.py', '**/*_test.py']
const TEST_OTHER = ['**/*_test.go', '**/*_test.rs', '**/*Test.java', '**/*Tests.cs']

// the git hook managers (Husky, Lefthook): a change made outside the agent hooks still taints (defense in depth)
const CFG_COMMON = ['.gitignore', '.gitattributes', '.github/workflows/**', '.gitlab-ci.yml', '.pre-commit-config.yaml', 'Makefile',
  '.husky/**', 'lefthook*.yml', '.lefthook*.yml', 'lefthook*.yaml', '.lefthook*.yaml', '.lefthook/**']
const CFG_JS = ['package.json', 'tsconfig*.json', '.eslint*', 'eslint.config.*', 'vitest.config.*', 'vitest.workspace.*',
  'jest.config.*', 'playwright.config.*', '.mocharc*', 'ava.config.*', 'biome.json', '.c8rc*', '.nycrc*']
const CFG_PY = ['pyproject.toml', 'pytest.ini', 'conftest.py', 'tox.ini', 'setup.cfg', 'noxfile.py', '.coveragerc',
  'mypy.ini', '.mypy.ini', 'ruff.toml', '.ruff.toml']
const CFG_OTHER = ['Cargo.toml', 'go.mod']

const SECRETS = ['.env*', '*.pem', '*.key', '*.p12', '*.pfx', 'id_rsa*', 'id_ed25519*', 'id_ecdsa*', '**/secrets/**',
  '**/.ssh/**', '*.kdbx', 'age-identity*', 'auth.json', 'credentials*.json', 'clerk-tokens.json', '.npmrc', '.pypirc', '.netrc']

/** Presets for `stopbar init --profile`. config.json keeps the expanded lists, so a team tunes them without code changes. */
export const PROFILES: Record<string, Paths> = {
  default: {tests: [...TEST_COMMON, ...TEST_JS, ...TEST_PY, ...TEST_OTHER], testConfig: [...CFG_COMMON, ...CFG_JS, ...CFG_PY, ...CFG_OTHER], secrets: SECRETS},
  ts: {tests: [...TEST_COMMON, ...TEST_JS], testConfig: [...CFG_COMMON, ...CFG_JS], secrets: SECRETS},
  python: {tests: [...TEST_COMMON, ...TEST_PY], testConfig: [...CFG_COMMON, ...CFG_PY], secrets: SECRETS},
  // strict: Python service with a quality script, a uv lock file and container-based checks; more config is suspicious
  strict: {
    tests: [...TEST_COMMON, ...TEST_PY],
    testConfig: [...CFG_COMMON, ...CFG_PY, 'quality.sh', '**/quality*.sh', 'scripts/quality*', 'uv.lock', 'Dockerfile*', 'docker-compose*.yml', 'hypothesis*.ini'],
    secrets: [...SECRETS, '*.age', 'secrets.{json,yaml,yml,toml,env,ini,txt,cfg,conf,xml,properties,age,enc,key,pem,local,prod,dev,staging}'],
  },
}

export const DEFAULTS = {maxRetries: 3, cap: 500, costPerCall: 1}
// local tools of Claude Desktop: task list and turn summary, and messages between local sessions (no network, no files)
export const DEFAULT_SAFE_TOOLS = ['mcp__ccd_turn__*', 'mcp__ccd_session_mgmt__*']

export class ConfigError extends Error {}

function isNat(x: unknown): x is number { return typeof x === 'number' && Number.isSafeInteger(x) && x >= 0 }

/** Validates a parsed config.json. Throws ConfigError with a precise reason. */
export function validateConfig(c: unknown): Config {
  if (!c || typeof c !== 'object' || Array.isArray(c)) throw new ConfigError('config.json must hold a JSON object')
  const o = c as Record<string, unknown>
  if (o.version !== 1) throw new ConfigError(`config.version must be 1, got ${JSON.stringify(o.version)}`)
  for (const k of ['buildCmd', 'fullTestCmd'] as const) {
    if (typeof o[k] !== 'string' || !(o[k] as string).trim()) throw new ConfigError(`config.${k} must be a non-empty string`)
  }
  if ((o.buildCmd as string).trim() === (o.fullTestCmd as string).trim()) {
    throw new ConfigError(`config.buildCmd and config.fullTestCmd must be different commands (both are ${JSON.stringify((o.buildCmd as string).trim())}): ` +
      'a command equal to buildCmd is always recorded as a build, so the full test gate can never pass. Use one command for lint/types/build ' +
      'and another one for the full test suite (e.g. --build "npm run build" --test "npm test")')
  }
  for (const k of ['maxRetries', 'cap', 'costPerCall'] as const) {
    if (!isNat(o[k])) throw new ConfigError(`config.${k} must be a safe non-negative integer`)
  }
  if ((o.maxRetries as number) < 1 || (o.cap as number) < 1) throw new ConfigError('config.maxRetries and config.cap must be >= 1')
  const p = o.paths as Record<string, unknown> | undefined
  if (!p || typeof p !== 'object') throw new ConfigError('config.paths must be an object with tests, testConfig and secrets')
  for (const k of ['tests', 'testConfig', 'secrets'] as const) {
    const list = p[k]
    if (!Array.isArray(list) || !list.every((x) => typeof x === 'string' && x.length > 0)) throw new ConfigError(`config.paths.${k} must be a list of glob strings`)
    for (const g of list as string[]) {
      try { globToRegExp(g) } catch (e) { throw new ConfigError(`config.paths.${k}: ${(e as Error).message}`) }
    }
  }
  if (typeof o.profile !== 'string') throw new ConfigError('config.profile must be a string')
  if (o.safeTools !== undefined) {
    if (!Array.isArray(o.safeTools) || !o.safeTools.every((x) => typeof x === 'string' && x.length > 0)) throw new ConfigError('config.safeTools must be a list of glob strings')
    for (const g of o.safeTools as string[]) {
      try { globToRegExp(g) } catch (e) { throw new ConfigError(`config.safeTools: ${(e as Error).message}`) }
    }
  }
  if (o.baseRef !== undefined) {
    if (typeof o.baseRef !== 'string' || !isSafeRef(o.baseRef)) throw new ConfigError(`config.baseRef must be a valid git ref (no whitespace, ranges or leading '-'), got ${JSON.stringify(o.baseRef)}`)
  }
  if (o.cliCmd !== undefined) {
    const why = typeof o.cliCmd === 'string' ? cliCmdProblem(o.cliCmd) : 'must be a string'
    if (why) throw new ConfigError(`config.cliCmd ${why}, got ${JSON.stringify(o.cliCmd)}`)
  }
  if (o.stopGate !== undefined && !STOP_GATES.includes(o.stopGate as StopGate)) {
    throw new ConfigError(`config.stopGate must be ${STOP_GATES.map((g) => JSON.stringify(g)).join(' or ')}, got ${JSON.stringify(o.stopGate)}`)
  }
  if (o.requireRun !== undefined && typeof o.requireRun !== 'boolean') throw new ConfigError(`config.requireRun must be true or false, got ${JSON.stringify(o.requireRun)}`)
  return o as unknown as Config
}

// A path segment such as .git, .claude or .husky. Self-protection (classify.ts protectedCommand) blocks every shell
// command that names one, so a hint `<cliCmd> run test` with such a segment could never run.
const PROTECTED_SEGMENT = /(^|[^a-z0-9_.\-])\.(git|claude|cursor|codex|gemini|agents|husky|lefthook)([^a-z0-9_\-]|$)/i

/** Why a cliCmd value cannot be used, or null. */
export function cliCmdProblem(cmd: string): string | null {
  const c = cmd.trim()
  if (!c) return 'must be a non-empty command'
  if (hasChain(c)) return 'must be one command without shell operators (;, &&, ||, |, redirections or $(...))'
  const seg = PROTECTED_SEGMENT.exec(c.replace(/\\/g, '/'))
  if (seg) return `must not name a .${seg[2].toLowerCase()} directory (the agent's shell may not run commands that name it; point it at a Stopbar install outside .git and the agent settings directories)`
  return null
}

/** The command that starts the Stopbar CLI in hints shown to the agent. */
export const cliOf = (cfg: Pick<Config, 'cliCmd'>) => cfg.cliCmd?.trim() || DEFAULT_CLI

export function isSafeRef(ref: string): boolean {
  return ref.length > 0 && !ref.startsWith('-') && !ref.includes('..') && !ref.endsWith('.') && !ref.endsWith('/') && /^[A-Za-z0-9._/@^~-]+$/.test(ref)
}

export function makeConfig(a: {buildCmd: string; fullTestCmd: string; profile?: string; maxRetries?: number; cap?: number; costPerCall?: number; baseRef?: string
  cliCmd?: string; stopGate?: string; requireRun?: boolean; safeTools?: string[]}): Config {
  const profile = a.profile ?? 'default'
  const paths = PROFILES[profile]
  if (!paths) throw new ConfigError(`unknown profile ${JSON.stringify(profile)}; known: ${Object.keys(PROFILES).join(', ')}`)
  const baseRef = a.baseRef?.trim()
  const cliCmd = a.cliCmd?.trim()
  return validateConfig({
    version: 1, profile, buildCmd: a.buildCmd.trim(), fullTestCmd: a.fullTestCmd.trim(),
    maxRetries: a.maxRetries ?? DEFAULTS.maxRetries, cap: a.cap ?? DEFAULTS.cap, costPerCall: a.costPerCall ?? DEFAULTS.costPerCall,
    paths: {tests: [...paths.tests], testConfig: [...paths.testConfig], secrets: [...paths.secrets]},
    safeTools: [...(a.safeTools ?? DEFAULT_SAFE_TOOLS)],
    ...(baseRef && baseRef !== 'HEAD' ? {baseRef} : {}),
    ...(cliCmd !== undefined ? {cliCmd} : {}),
    ...(a.stopGate !== undefined ? {stopGate: a.stopGate} : {}),
    ...(a.requireRun === true ? {requireRun: true} : {}),
  })
}
