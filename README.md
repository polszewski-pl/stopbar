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
| Codex CLI | `codex`: `.codex/hooks.json` | PreToolUse, PostToolUse, Stop | `hookSpecificOutput.permissionDecision: "deny"`; stop: `decision: "block"` | live-verified (Codex CLI 0.172.0): denied commit and config write, tree changes, Stop. Run the gates as `npx stopbar run build` / `npx stopbar run test`, because Codex reports no exit status to hooks. Codex loads project hooks only in a trusted folder |
| Gemini CLI | `gemini`: `.gemini/settings.json` | BeforeTool, AfterTool, AfterAgent | exit 2, reason on stderr; AfterAgent: `decision: "block"` | spec-tested (Gemini CLI hooks reference) |
| Antigravity CLI | `antigravity` (alias `agy`): `.agents/hooks.json` | PreToolUse, PostToolUse, Stop | `{"decision": "deny"}`; stop: `decision: "continue"` | live-verified (Antigravity CLI 1.5.18): denied early commit and config write, build and full tests recorded, honest commit allowed, Stop |
| Any tool, via git | `git`: `.git/hooks/pre-commit`, `.git/hooks/pre-push` | commit, push | exit 1 aborts git | tested with real git (E2E) |

`live-verified` means a live agent session passed through the hooks; `spec-tested` means the adapter follows the
client's published hook schema and the E2E suite runs it with payloads in that schema. Combine targets in one call:
`--hooks claude,cursor,codex,gemini,antigravity,git`.

`stopbar hook --adapter auto` (the default) detects the client from the payload, so the v1.0 Claude Code settings keep
working. An unknown or damaged payload fails closed (exit 2). The configs written by `init` pass `--adapter` explicitly.

**Git fallback.** For a tool without hooks, run the gates through Stopbar so their real exit status counts:
`npx stopbar run build` and `npx stopbar run test`. The git hooks then allow a commit only after both passed at the
current tree, block it after an unapproved test change, and block a push after a secret read without approval.

## Four pillars

| Pillar | Command | What it gives you |
|---|---|---|
| PROVE | `stopbar prove`, `npm run verify:lean` | The inductive proof of the kernel, 10 mutants that must fall with a counterexample, and (release gate) `lake build` of the Lean export in a pinned Lean 4.34.0 container without network. |
| PROBE | `stopbar probe` | Stateful probing: at least 200 random multi-step sequences of hook events, human commands and damaged files on real git repositories, compared step by step with the proven kernel. v1.0 has one target, `wrapper` (Stopbar itself). |
| GATE | `stopbar init`, `hook`, `git-hook`, `run`, `status`, `approve-tests`, `approve-shell`, `resume`, `reset`, `doctor` | The agent hooks, the git fallback and the human commands. |
| ATTEST | `stopbar attest` | A deterministic attestation of the session: HEAD, tree, gates, human actions and the sha256 of the event log. |

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

The agent must run the gate commands exactly as configured and alone, for example `npm test` and not
`npm test | tail`. Commits must be one command. The quoted heredoc form that agents use is allowed:

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
| `stopbar init --build "<cmd>" --test "<cmd>" [--profile p] [--max-retries 3] [--cap 500] [--cost 1] [--hooks <targets>] [--no-pin] [--force] [--force-hooks]` | human | Writes `config.json` and a fresh state, pins the runtime, writes or prints the hooks. Targets: `claude` (`local`), `claude-project` (`project`), `cursor`, `codex`, `gemini`, `antigravity` (`agy`), `git`, comma separated. |
| `stopbar hook [--adapter auto\|claude\|cursor\|codex\|gemini\|antigravity]` | agent | The hook. JSON on stdin; the decision in the client's format (see Supported agents). |
| `stopbar git-hook pre-commit\|pre-push` | git | The git fallback gate. Exit 1 aborts the commit or push. |
| `stopbar run build\|test` | human, agent, CI | Runs the configured gate command and records its real exit status. |
| `stopbar status [--json]` | human | Revision, gates, taint, budget, why a commit is blocked, and which file or token turned the secret gate on. |
| `stopbar approve-tests [--rev N]` | human | You reviewed the changed tests or test config up to revision N (default: the current one). |
| `stopbar approve-shell` | human | Allows **one** risky or outbound call after a secret read. |
| `stopbar resume --extra N` | human | Lifts a halt (retry limit or budget) and adds N to the budget. |
| `stopbar reset` | human | Fresh kernel state. Config and event log stay. Also repairs a damaged `state.json`. |
| `stopbar doctor [--json]` | human | Environment, config, state, hooks and a dry run. Exit 1 on a problem. |
| `stopbar prove [--out f.json] [--lean f.lean]` | human, CI | PROVE: the inductive proof of the kernel and the 10 mutants. Exit 0 only if everything holds. `verify` is an alias. |
| `stopbar probe [--target wrapper] [--runs 200] [--seed 1] [--jobs N] [--work dir] [--out dir]` | human, CI | PROBE: stateful probing against the proven kernel. A failure is shrunk to a minimal JSON reproduction. Needs the full package (gdp-wired). |
| `stopbar attest [--format json\|md]` | human, CI | ATTEST: the session attestation. The same state and log give the same output. Exit 1 if the state and the log disagree, exit 2 if a file is damaged. |

All commands take `--repo <dir>`. The agent cannot run the human commands: the hooks block them.

State, configuration and the event log are in `<repo>/.git/stopbar/`: `config.json`, `state.json`, `events.jsonl`, the
private snapshot index and the pinned runtime. They are outside the working tree, so they never change the tree hash.

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
  "safeTools": ["mcp__ccd_turn__*"]
}
```

A pattern without `/` matches the file name anywhere. `**` is a whole path segment. Matching ignores case. Change a
profile by editing the lists: no code change is necessary.

- **Secrets in shell commands.** A token in a command counts as a secret read when it matches a secret pattern. For an
  extension-only pattern such as `*.key` or `*.pem`, a bare token (`claim.key`, `self.pem`) counts only when that file
  exists, because it is usually a field access in code; a token with a path separator (`certs/server.key`) and every
  other pattern (`.env*`, `id_rsa*`) count always. `stopbar status` says why the secret gate is on, for example
  `secret read yes (matched *.key (server.key) in Bash at rev 3)`; `events.jsonl` keeps the pattern and the token,
  never the file content.
- **`safeTools`** (optional) lists glob patterns of tool names that are local and never outbound. The default is
  `["mcp__ccd_turn__*"]`, the task-list and turn-summary tools of Claude Desktop. It only exempts tools from the
  outbound gate (WebFetch, WebSearch, MCP tools); shell commands, edits and reads are gated as before, and a halted
  session still blocks every tool. A damaged or empty `config.json` or `state.json` blocks every
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
| Windows 11, Git for Windows | 24.19.0 | 2.56.0 | 28/28 | 237/237 | 201/201 sequences | proven, 10/10 mutants | OK |
| Linux, Debian 13 (container, no network) | 24.21.0 | 2.47.3 | 28/28 | 237/237 | 201/201 sequences | proven, 10/10 mutants | OK |

The E2E suite runs every adapter (Cursor, Codex CLI, Gemini CLI, Antigravity CLI) and the git fallback with real
git commits and pushes. The probe runs the same 200 seeds plus 1 regression on both platforms, with the same 5007 steps
and 7085 hook calls. `stopbar doctor` passes on a fresh repository with all six `--hooks` targets.
`npm run verify:lean` passes in the Lean 4.34.0 container: `lake build` exit 0, 0 errors, 0 `sorry`.

## License

MIT. Stopbar depends on [gdp-wired](https://github.com/monotykamary/gdp-wired) (MIT), pinned to 0.60.0.
