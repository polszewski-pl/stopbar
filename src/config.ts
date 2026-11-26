// config.json: gate commands, limits and path patterns. Lives in <git-dir>/stopbar/, out of the agent's reach.
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
}

const TEST_COMMON = ['**/tests/**', '**/test/**', '**/__tests__/**']
const TEST_JS = ['**/*.test.*', '**/*.spec.*', '**/e2e/**']
const TEST_PY = ['**/test_*.py', '**/*_test.py']
const TEST_OTHER = ['**/*_test.go', '**/*_test.rs', '**/*Test.java', '**/*Tests.cs']

const CFG_COMMON = ['.gitignore', '.gitattributes', '.github/workflows/**', '.gitlab-ci.yml', '.pre-commit-config.yaml', 'Makefile']
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
    secrets: [...SECRETS, '*.age', 'secrets.*'],
  },
}

export const DEFAULTS = {maxRetries: 3, cap: 500, costPerCall: 1}

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
  return o as unknown as Config
}

export function makeConfig(a: {buildCmd: string; fullTestCmd: string; profile?: string; maxRetries?: number; cap?: number; costPerCall?: number}): Config {
  const profile = a.profile ?? 'default'
  const paths = PROFILES[profile]
  if (!paths) throw new ConfigError(`unknown profile ${JSON.stringify(profile)}; known: ${Object.keys(PROFILES).join(', ')}`)
  return validateConfig({
    version: 1, profile, buildCmd: a.buildCmd.trim(), fullTestCmd: a.fullTestCmd.trim(),
    maxRetries: a.maxRetries ?? DEFAULTS.maxRetries, cap: a.cap ?? DEFAULTS.cap, costPerCall: a.costPerCall ?? DEFAULTS.costPerCall,
    paths: {tests: [...paths.tests], testConfig: [...paths.testConfig], secrets: [...paths.secrets]},
  })
}
