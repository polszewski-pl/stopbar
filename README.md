# Stopbar

Stopbar is a formally proven execution gate for AI coding agents. It runs as the hooks of Claude Code, Cursor, Codex
CLI, Gemini CLI and Antigravity CLI, and as git hooks for any other tool. It stops an agent from:

- committing without a passing build and a passing **full** test suite at the current revision of the working tree;
- weakening existing tests or test configuration without a human approval;
- running risky or outbound commands after it read a secret, unless a human allows one call;
- looping on failing builds or tests, or going past a budget of tool calls;
- switching itself off by editing the agent's hook configuration, git hooks or its own state.

The decisions come from one rule, `src/kernel.ts`. gdp-wired 0.60.0 proves its laws by induction, and 10 mutants of
the rule each fall with a counterexample. Every client goes through the same rule: an adapter translates the client's
hook payload into one internal event and renders the decision in the client's own output format. See
[SECURITY.md](SECURITY.md) for what is proven, what the wrapper enforces and what needs an OS sandbox.

## Supported agents

| Agent | Config written by `init --hooks` | Events | Block protocol | Status |
|---|---|---|---|---|
| Claude Code | `claude`: `.claude/settings.local.json` (`claude-project`: `.claude/settings.json`) | PreToolUse, PostToolUse, PostToolUseFailure, Stop | exit 2, reason on stderr | live-verified (Claude Code 2.1.326) |
| Cursor | `cursor`: `.cursor/hooks.json` (`failClosed: true`) | preToolUse, postToolUse, postToolUseFailure, stop (also beforeShellExecution, beforeMCPExecution, beforeReadFile, afterFileEdit, afterShellExecution) | exit 2 and `{"permission": "deny"}`; stop: `followup_message` | spec-tested (Cursor hooks reference) |
| Codex CLI | `codex`: `.codex/hooks.json` | PreToolUse, PostToolUse, Stop | `hookSpecificOutput.permissionDecision: "deny"`; stop: `decision: "block"` | live-verified (Codex CLI 0.172.0): denied commit and config write, tree changes, Stop. Run the gates as `stopbar run build` / `stopbar run test` (the hint uses `--cli`, default `npx --no-install stopbar`), because Codex reports no exit status to hooks. Codex loads project hooks only in a trusted folder |
| Gemini CLI | `gemini`: `.gemini/settings.json` | BeforeTool, AfterTool, AfterAgent | exit 2, reason on stderr; AfterAgent: `decision: "block"` | spec-tested (Gemini CLI hooks reference) |
| Antigravity CLI | `antigravity` (alias `agy`): `.agents/hooks.json` | PreToolUse, PostToolUse, Stop | `{"decision": "deny"}`; stop: `decision: "continue"` | live-verified (Antigravity CLI 1.5.18): denied early commit and config write, build and full tests recorded, honest commit allowed, Stop |
| Any tool, via git | `git`: `.git/hooks/pre-commit`, `.git/hooks/pre-push` | commit, push | exit 1 aborts git | tested with real git (E2E) |

`live-verified` means a live agent session passed through the hooks; `spec-tested` means the adapter follows the
client's published hook schema and the E2E suite runs it with payloads in that schema. Combine targets in one call:
`--hooks claude,cursor,codex,gemini,antigravity,git`.

`stopbar hook --adapter auto` (the default) detects the client from the payload, so the v1.0 Claude Code settings keep
working. An unknown or damaged payload fails closed (exit 2). The configs written by `init` pass `--adapter` explicitly.

**Git fallback.** For a tool without hooks, run the gates through Stopbar so their real exit status counts:
`stopbar run build` and `stopbar run test`. The git hooks then allow a commit only after both passed at the
current tree, block it after an unapproved test change, and block a push after a secret read without approval.

## Four pillars

| Pillar | Command | What it gives you |
|---|---|---|
| PROVE | `stopbar prove`, `npm run verify:lean` | The inductive proof of the kernel, 10 mutants that must fall with a counterexample, and (release gate) `lake build` of the Lean export in a pinned Lean 4.34.0 container without network. |
| PROBE | `stopbar probe` | Stateful probing: at least 200 random multi-step sequences of hook events, human commands and damaged files on real git repositories, compared step by step with the proven kernel (target `wrapper`, Stopbar itself). Since 1.2.0 also any TS/JS project: a model written with `defineModel` from `stopbar/probe`, with mutants that must be caught. |
| GATE | `stopbar init`, `upgrade`, `hook`, `git-hook`, `run`, `status`, `approve-tests`, `approve-shell`, `resume`, `reset`, `doctor` | The agent hooks, the git fallback and the human commands. |
| ATTEST | `stopbar attest` | A deterministic attestation of the session: HEAD, tree, gates, human actions, probe evidence and the sha256 of the event log. |

## Set up in 3 steps

Requirements: Node.js 22.18 or later, git, a git repository.

1. **Install** Stopbar in the repository (or globally):

   ```sh
   npm install --save-dev stopbar
   ```

2. **Initialise** with your exact build and full-test commands, and write the hooks of your agents:

   ```sh
   npx stopbar init --build "npm run build" --test "npm test" --hooks claude,cursor,git
   ```

   Profiles for the path patterns: `--profile default|ts|python|strict`. `init` copies the runtime to
   `.git/stopbar/runtime/` and points every hook to it. Existing settings and hooks in those files stay; earlier
   Stopbar entries are replaced. `init` does not overwrite a git hook it did not write, unless you pass
   `--force-hooks` (the old hook is kept as `<name>.stopbar-backup`). Without `--hooks`, it prints the Claude Code JSON
   to paste. A template is in [claude-hooks.example.json](claude-hooks.example.json).

3. **Check** the setup, then restart the agent in the repository:

   ```sh
   npx stopbar doctor
   ```

   `doctor` checks Node, git, the kernel link, `config.json`, `state.json`, the event log and the hooks of every client
   it finds, and makes a dry run of the real hook pipeline on a scratch repository.

The agent must run the gate commands exactly as configured, alone and in the foreground, for example `npm test` and not
`npm test | tail` or with `run_in_background`. For long-running gates (>10 min), run `stopbar run build` /
`stopbar run test` (safe to run in the background: Stopbar records the real exit status only when the process
finishes, and discards the result if the working tree changed in the meantime). The hints that Stopbar shows the agent
name this command as `npx --no-install stopbar run build|test`: `--no-install` uses an installed Stopbar and never
downloads the package from the npm registry. If Stopbar is installed elsewhere (a global install or a checkout outside
the project), set the command with `stopbar init --cli "<cmd>"`, for example
`--cli "node /opt/stopbar/bin/stopbar.mjs"`; the hints then say `node /opt/stopbar/bin/stopbar.mjs run test`. Commits must be one command. The quoted
heredoc form that agents use is allowed:

```sh
git commit -m "$(cat <<'EOF'
Fix the parser

Reviewed-by: Jane Doe <jane@example.invalid>
EOF
)"
```

## Commands

| Command | Who | What it does |
|---|---|---|
| `stopbar init --build "<cmd>" --test "<cmd>" [--profile p] [--base-ref <ref>] [--cli "<cmd>"] [--stop-gate block\|warn] [--max-retries 3] [--cap 500] [--cost 1] [--hooks <targets>] [--no-pin] [--force] [--force-hooks]` | human | Writes `config.json` and a fresh state, pins the runtime, writes or prints the hooks. Targets: `claude` (`local`), `claude-project` (`project`), `cursor`, `codex`, `gemini`, `antigravity` (`agy`), `git`, comma separated. `--build` and `--test` must be different commands. `--base-ref` sets the git ref used to judge whether a test file already existed (default `HEAD`). `--cli` sets the Stopbar command in hints (default `npx --no-install stopbar`). `--stop-gate warn` lets a turn end with unverified changes (default `block`); commit and push stay gated. |
| `stopbar upgrade [--hooks <targets>] [--force-hooks]` | human | After you update the Stopbar package: re-pins the hook runtime in `.git/stopbar/runtime` and, with `--hooks`, rewrites the hooks. `state.json`, `config.json` and the snapshots stay as they are (revision, gates, taint, budget), so an active session keeps its green gates. Use it instead of `init --force`. |
| `stopbar hook [--adapter auto\|claude\|cursor\|codex\|gemini\|antigravity]` | agent | The hook. JSON on stdin; the decision in the client's format (see Supported agents). |
| `stopbar git-hook pre-commit\|pre-push` | git | The git fallback gate. Exit 1 aborts the commit or push. |
| `stopbar run build\|test` | human, agent, CI | Runs the configured gate command and records its real exit status. |
| `stopbar status [--json]` | human | Revision, gates, taint, budget, why a commit is blocked, and which file or token turned the secret gate on. |
| `stopbar approve-tests [--rev N]` | human | You reviewed the changed tests or test config up to revision N (default: the current one). |
| `stopbar approve-shell` | human | Allows **one** risky or outbound call after a secret read. |
| `stopbar resume --extra N` | human | Lifts a halt (retry limit or budget) and adds N to the budget. |
| `stopbar reset` | human | Fresh kernel state. Config and event log stay. Also repairs a damaged `state.json`. Uncommitted changes of existing tests or test config (against `baseRef`, else `HEAD`) are not forgotten: the session starts tainted, with a `WARN`, until `approve-tests`. `init --force` does the same. |
| `stopbar doctor [--json]` | human | Environment, config, state, hooks and a dry run. Exit 1 on a problem. |
| `stopbar prove [--out f.json] [--lean f.lean]` | human, CI | PROVE: the inductive proof of the kernel and the 10 mutants. Exit 0 only if everything holds. `verify` is an alias. |
| `stopbar probe [--target wrapper\|<file>] [--runs 200] [--seed 1] [--jobs N] [--work dir] [--out dir] [--regressions dir] [--regressions-only] [--check-mutants] [--mutant-runs 50] [--no-record]` | human, CI | PROBE: stateful probing of the hooks against the proven kernel (`wrapper`, needs the full package with gdp-wired), or of your own model in a `.ts`, `.mts`, `.js` or `.mjs` file (see [PROBE for your project](#probe-for-your-project)). A failure is shrunk to a minimal JSON reproduction. |
| `stopbar attest [--format json\|md]` | human, CI | ATTEST: the session attestation. The same state and log give the same output. Exit 1 if the state and the log disagree, exit 2 if a file is damaged. `probes` (Markdown: `## Probe evidence`) lists the latest `probe:result` per target since the last `init` or `reset`, with `atCurrentSnapshot`. |

All commands take `--repo <dir>`. The agent cannot run the human commands: the hooks block them.

State, configuration and the event log are in `<repo>/.git/stopbar/`: `config.json`, `state.json`, `events.jsonl`, the
private snapshot index and the pinned runtime. They are outside the working tree, so they never change the tree hash.

## PROBE for your project

`stopbar probe --target <file>` runs a model of any TS/JS code. The file exports (as `default` or as `target`) a
target; `defineModel` from `stopbar/probe` builds one from a list of actions:

```ts
import {defineModel} from 'stopbar/probe'

export default defineModel<{q: BoundedQueue<number>; model: number[]}>({
  name: 'bounded-queue', description: 'FIFO queue with capacity 4 vs an array model',
  setup: () => ({q: new BoundedQueue<number>(4), model: []}),
  actions: [
    {name: 'push', weight: 3, gen: (r) => ({x: r.int(0, 99)}), run: (s, {x}, check) => {
      const accepted = s.model.length < 4
      check.eq('push result', s.q.push(x), accepted)
      if (accepted) s.model.push(x)
    }},
    {name: 'shift', gen: () => null, run: (s, _a, check) => check.eq('shift result', s.q.shift(), s.model.shift())},
  ],
  invariants: [{name: 'size', check: (s, check) => check.eq('size', s.q.size, s.model.length)}],
  mutants: {M1_dropCap: () => ({q: new BoundedQueue<number>(4, {checkCap: false}), model: []})},
})
```

- `gen(r)` returns pure JSON data for one step. `r` is a deterministic generator (`createRng`: xorshift32, the same
  numbers on Windows and Linux). A run is `{seed, actions: [{t: name, args}]}` with `minSteps`..`maxSteps` steps
  (default 15..40).
- `run(state, args, check)` drives the real code and compares it with the model: `check.eq` (deep strict equality),
  `check.ok`, `check.fail`. A failed check, and any exception from the code under test, is a mismatch with the step and
  the action, not a crash. Invariants run after `setup` (step -1) and after every step. `teardown` runs after every run
  whose `setup` returned, also after a failure.
- A failure is shrunk (cut after the failing step, then removal of blocks of half, a quarter, ... of the run, then of
  single steps) and written to `repro-<seed>.json` in `--out`. `--regressions <dir>` replays such files on every run.
  A file target replays only the regressions you name.
- `--check-mutants`: each mutant replaces `setup` with a damaged system under test. The original must pass, and every
  mutant must fail within `--mutant-runs` seeds (default 50). Exit 0 only then. A survivor is named in the output and
  in `summary.json` (`mutants.survived`). A target without mutants is refused.
- In a repository with Stopbar, every run appends a `probe:result` entry to `events.jsonl` (target, sha256 of the
  target file, tree snapshot, runs, steps, mutants, sha256 of `summary.json`). It is not a kernel step and does not
  change `state.json`. `stopbar attest` shows the latest entry per target and whether the tree is still the one that
  was probed. `--no-record` skips the entry. Outside a Stopbar repository nothing is recorded.

A complete example with two mutants: [`examples/bounded-queue.probe.ts`](examples/bounded-queue.probe.ts)
(`stopbar probe --target examples/bounded-queue.probe.ts --check-mutants`). TypeScript files need Node's type
stripping (Node 22.18 or later): only erasable syntax, no `enum` and no constructor parameter properties.

## Configuration

`config.json` keeps the gate commands, the limits and three lists of glob patterns:

```json
{
  "version": 1, "profile": "default",
  "buildCmd": "npm run build", "fullTestCmd": "npm test",
  "maxRetries": 3, "cap": 500, "costPerCall": 1,
  "paths": {
    "tests": ["**/tests/**", "**/*.test.*", "**/test_*.py"],
    "testConfig": ["package.json", "pyproject.toml", ".github/workflows/**"],
    "secrets": [".env*", "*.pem", "**/secrets/**"]
  },
  "safeTools": ["mcp__ccd_turn__*", "mcp__ccd_session_mgmt__*"]
}
```

`buildCmd` and `fullTestCmd` must be different commands. A command equal to `buildCmd` is always recorded as a build,
so with two equal commands the full test gate could never pass. `init` refuses such a pair, and a `config.json` that has
one makes every hook fail closed and `stopbar doctor` report `[FAIL] config.json` with the fix. Use one command for
lint, types and build and one for the full test suite, for example `--build "npm run build" --test "npm test"`.

A pattern without `/` matches the file name anywhere. `**` is a whole path segment. Matching ignores case. Change a
profile by editing the lists: no code change is necessary.

- **Secrets in shell commands.** A token in a command counts as a secret read when it matches a secret pattern. For an
  extension-only pattern such as `*.key` or `*.pem`, a bare token (`claim.key`, `self.pem`) counts only when that file
  exists, because it is usually a field access in code; a token with a path separator (`certs/server.key`) and every
  other pattern (`.env*`, `id_rsa*`) count always. `stopbar status` says why the secret gate is on, for example
  `secret read yes (matched *.key (server.key) in Bash at rev 3)`; `events.jsonl` keeps the pattern and the token,
  never the file content.
- **`baseRef`** (optional, set via `stopbar init --base-ref <ref>`) controls which git ref defines an "existing" test
  file (default: `HEAD`). On a multi-commit feature branch, `--base-ref main` (or a base commit SHA) lets the agent
  refine new test files it added on that branch across commits without triggering `testsTainted`, while existing tests
  from `baseRef` and all test-config files remain protected. A configured non-`HEAD` ref that cannot be resolved fails
  closed. With `baseRef`, Stopbar compares the content (blob id) of a changed test or test-config file with `baseRef`:
  after `git checkout -b x main`, `git rebase main` or `git cherry-pick`, files that equal `main` do not taint, but the
  tree revision grows and the gates must run again. Any other change of a test from `baseRef` or of test config taints,
  and putting the file back later does not clear the taint. Without `baseRef`, every change of an existing test or of
  test config taints, also when the file equals `HEAD`, because the agent's own git commands can move `HEAD`.
- **`safeTools`** (optional) lists glob patterns of tool names that are local and never outbound. The default
  (`DEFAULT_SAFE_TOOLS`) is `["mcp__ccd_turn__*", "mcp__ccd_session_mgmt__*"]`: the task-list and turn-summary tools of
  Claude Desktop and its tools for messages between local sessions. It only exempts tools from the outbound gate
  (WebFetch, WebSearch, MCP tools); shell commands, edits and reads are gated as before, and a halted session still
  blocks every tool. A `config.json` written by 1.0.0–1.1.1 keeps its own list and keeps working; to stop false
  `PAUSE`s on the session tools after a secret read, add `"mcp__ccd_session_mgmt__*"` to `safeTools` or write the file
  again with `stopbar init --force ...`. `stopbar doctor` shows a `[WARN] safeTools` while a default entry is missing.
- **`cliCmd`** (optional, set via `stopbar init --cli "<cmd>"`) is the command that starts Stopbar in the hints shown to
  the agent (`<cliCmd> run build|test`). Without it the hints say `npx --no-install stopbar`. It must be one command
  without shell operators and must not name a `.git` or agent-settings directory, because the agent's shell may not run
  such a command. With `--no-pin`, `init` also refuses a `--cli` that points at the hook runtime itself. `approve-tests`,
  `approve-shell`, `resume`, `reset` and `init` stay blocked for the agent whatever `cliCmd` is.
- **`stopGate`** (optional, set via `stopbar init --stop-gate block|warn`, default `block`) controls only the `Stop` hook.
  `block`: the agent cannot declare "done" while the tree differs from `HEAD` and the gates have not passed (exit 2).
  `warn`: for long tasks with one commit at the end, the turn may end with unverified changes (for example to ask the
  human a question); Stopbar logs a `stop:warn` entry in `events.jsonl` and answers `WARN (stopbar): ...` without
  blocking. `git commit` and `git push` in the agent hooks and in the git hooks stay fully gated by the kernel.
  `status`, `doctor` and `attest` show the mode. A damaged or empty `config.json` or `state.json` blocks every
tool call (exit 2) with a message that says how to repair it.

## Local use

- `npm run build` builds `dist/` from `src/` with Node's own type stripping and generates `dist/kernel.gen.js` from
  the kernel with gdp-wired's `compileJs`. There is no TypeScript compiler and no bundler.
- `npm test` runs the unit tests, the E2E suite (real git repositories, a separate hook process for each call) and the
  stateful fuzzer (200 random sequences of 20–30 steps, compared with the proven kernel). It takes about 3 minutes.
  In Claude Code, give the Bash tool enough time, for example `"env": {"BASH_DEFAULT_TIMEOUT_MS": "600000"}` in the
  settings.
- `npm run prove` builds and runs `stopbar prove` (about 3 minutes). `npm run verify` is the same.
- `npm run verify:lean` exports the Lean project (`leanProject()` of gdp-wired) and runs `lake build` in the
  container from `docker/lean.Dockerfile` with `--network none`. It is the release gate for changes of `src/kernel.ts`,
  not part of `npm test`. Build the image once (this needs the network):
  `docker build -f docker/lean.Dockerfile -t stopbar-lean:4.34.0 docker`.
- `npm run bench` measures the hook latency.
- `npm run test:e2e` or `npm run test:fuzz` runs only the E2E suite or only the stateful prober.

## Use in CI

Prove the kernel and run the tests on every change of Stopbar itself:

```yaml
- run: npm ci
- run: npm test
- run: npx stopbar prove --out stopbar-prove.json
```

For headless agent runs in CI, initialise Stopbar in the job and keep the evidence:

```yaml
- run: npx stopbar init --build "npm run build" --test "npm test" --hooks project
- run: claude -p "<task>" --setting-sources project,local --max-turns 20
- run: npx stopbar status --json > stopbar-status.json
- run: npx stopbar attest --format md > stopbar-attest.md
- run: cp .git/stopbar/events.jsonl stopbar-events.jsonl
```

`stopbar attest` tells whether a commit is allowed at the end and lists every human action. Its sha256 of
`events.jsonl` ties the report to the log, which has one line for each kernel step and each block, with the reason.

## Hook latency

Each hook is a separate Node process. The hooks never load the prover. `PreToolUse` makes no git call. `PostToolUse` and
a commit check make one: `git add -A` on a private index, which the hook then reads itself. `Stop` makes two. On
Windows 11 with a 330-file repository, in one run with 1.0.0 as the baseline: 1.1.0 p50 94 ms and p95 234 ms over all
hook processes, including Cursor and Antigravity payloads; 1.0.0 p95 247 ms. The adapter layer adds no measurable
latency. An earlier prototype that loaded the prover in every hook measured p50 981 ms and p95 1613 ms.
`npm run bench` repeats the measurement (`--baseline <cli>` compares with another build).

## Tested platforms

| Platform | Node | git | Unit | E2E | `stopbar probe` | `stopbar prove` | `stopbar doctor` |
|---|---|---|---|---|---|---|---|
| Windows 11, Git for Windows | 24.19.0 | 2.56.0 | 40/40 | 365/365 | 202/202 sequences | proven, 10/10 mutants | OK |
| Linux, Debian 13 (container, no network) | 24.21.0 | 2.47.3 | 40/40 | 365/365 | 202/202 sequences | proven, 10/10 mutants | OK |

The E2E suite runs every adapter (Cursor, Codex CLI, Gemini CLI, Antigravity CLI) and the git fallback with real
git commits and pushes. The probe runs the same 200 seeds plus 2 regressions on both platforms, with the same 5020 steps
and 7152 hook calls (half of the seeds with a base ref). `stopbar doctor` passes on a fresh repository with all six `--hooks` targets.
`npm run verify:lean` passes in the Lean 4.34.0 container: `lake build` exit 0, 0 errors, 0 `sorry`.

## License

MIT. Stopbar depends on [gdp-wired](https://github.com/monotykamary/gdp-wired) (MIT), pinned to 0.60.0.
