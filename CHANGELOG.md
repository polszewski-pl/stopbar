# Changelog

## 1.2.0 (2026-11-26)

`src/kernel.ts` is unchanged (sha256 `c602fc4bcf8ffb2e...`); every kernel law holds as in 1.1.3. A `config.json` and a
`state.json` from 1.0.0–1.1.3 work without migration. `stopbar probe --target wrapper` (the default) runs as before.
This release joins 1.2.0-rc.1 (PROBE for TS/JS) with PROBE for any language and `stopbar probe init`. No new runtime
dependency: `gdp-wired` 0.60.0 is still the only one.

- **PROBE for any language: `stopbar probe --cmd "<command>"`.** Each worker starts the command once (in a shell) and
  speaks NDJSON with it on stdin/stdout: `{"op":"info"}` (name, description, optional mutants),
  `{"op":"generate","seed":N}` (a run of pure JSON actions) and `{"op":"execute","run":...,"dir":...,"mutant"?}` (an
  `Outcome`). Shrinking, `--regressions` / `--regressions-only`, `--check-mutants` / `--mutant-runs`, `summary.json`,
  `repro-<seed>.json`, `probe:result` and the probe evidence of `attest` work as with `--target <file>`. A reproduction
  names the target by the `name` from `info`; `summary.json`, `repro-<seed>.json`, `probe:result` and `attest` also
  have `targetCmd`. A `--cmd` target replays only the regressions in `--regressions <dir>`.
- `--target` and `--cmd` together exit 1 with the reason. `--target-file <path>` names the file for `targetSha256`;
  without it, the first word after the interpreter that is an existing file is hashed, else `targetSha256` is `null`.
- Errors of the external process do not hang a worker: a process that exits, closes stdout, prints a line that is not
  JSON, answers `{"error": ...}` or an answer of the wrong shape, or gives no answer within `--cmd-timeout` ms (default
  300000) stops the probe with exit 1 and the end of its stderr. At the end Stopbar closes stdin and kills the process
  tree after 2 s.
- **`stopbar probe init [--lang ts|py] [--name sample] [--out probes] [--force] [--repo <dir>]`:** writes
  `<name>.probe.ts` (`defineModel` from `stopbar/probe`) or `<name>_probe.py` (the NDJSON protocol, Python standard
  library only) with 2 actions, 1 invariant, 2 mutants and the rules for zero false positives, and prints the command
  that runs it. An existing file stays without `--force`; an unknown `--lang` and a `--name` with anything other than
  letters, digits, `-` and `_` (for example `../`) exit 1.
- Example: `examples/bounded_queue_probe.py`, the Python counterpart of `examples/bounded-queue.probe.ts` (the same
  queue model, invariants and mutants `M1_dropCap` and `M2_lifoInsteadOfFifo`).
- Tests: unit tests `tests/unit/probe-stdio.test.ts` (the NDJSON client, mutants, chunked shrinking over stdio, a
  process that crashes, closes stdout, prints garbage, hangs or answers with an error, `probe init`); E2E scenario S37
  (`--cmd` with a Node NDJSON target, so it runs without Python: mutants, `probe:result`, `attest` json and md, minimal
  reproduction and replay, `--target` with `--cmd`, a crashing process, `probe init --lang ts|py`; with `python3` or
  `python` on the machine also `examples/bounded_queue_probe.py` and the `--lang py` template).

From 1.2.0-rc.1:

- **PROBE for any TS/JS project.** `stopbar probe --target <file>` loads a `.ts`, `.mts`, `.js` or `.mjs` file and
  runs its `default` export (or the export `target`) as a probe target. A missing file or an export that is not a
  target exits 1 with the reason. The sha256 of the file goes into the log and into `summary.json` (`targetSha256`).
  A file target replays regressions only from `--regressions <dir>`, never Stopbar's own.
- **SDK `stopbar/probe`** (`exports["./probe"]`, types from `src/probe/sdk.ts`): `defineModel` (actions with
  `gen(r)` and `run(state, args, check)`, invariants, `setup` / `teardown`, mutants), `createRng` (xorshift32, the
  same numbers on every platform), `MismatchError` and the types `ModelSpec`, `Rng`, `Check`, `ActionSpec`,
  `ProbeTarget`, `ProbeRun`, `Outcome`, `Mismatch`. A failed check or an exception of the code under test is a
  mismatch with the step and the action. The worker does not crash.
- **`--check-mutants [--mutant-runs 50]`:** the original runs first. If it passes, each mutant runs seeds from
  `--seed` in order until the first failure (`KILLED`, with seed, step, check and action) or `--mutant-runs` seeds
  (`SURVIVED`). Exit 0 only if the original passes and no mutant survives. `summary.json` has
  `mutants: {total, killed, survived, details}`. A target without mutants is refused (exit 1).
- **Faster shrinking:** after the cut at the failing step, blocks of half, a quarter, ... of the run (at least 2
  steps) go first, then single steps to a fixed point. On a 200-step run with two relevant steps: 25 executions
  instead of 147 (measured by the unit test). The order is fixed, so the minimal run is the same on every platform.
- **`probe:result` in `events.jsonl`:** in a repository with a valid Stopbar `config.json` and `state.json`, every
  probe run appends one entry under the lock (target, target path and sha256, tree snapshot, runs, regressions,
  passed, failed, steps, ok, mutants, sha256 of `summary.json`). It has no `req`: it is not a kernel step,
  `state.json` is not touched and `attest` stays consistent. `--no-record` skips it. Without Stopbar nothing is
  recorded and the prober works on its own. The test suite's own probe run passes `record: false`.
- **`stopbar attest`: probe evidence.** JSON `probes: [...]` (the latest `probe:result` per target since the last
  `init` / `reset`, with `atCurrentSnapshot`); Markdown `## Probe evidence` (or `- none`).
- Smaller fixes in the runner: `summary.json` and other files without a run in a regression directory are skipped;
  when `--regressions` and `--out` are the same directory, the reproductions in it are kept for the replay; a failing
  regression writes its own run as the reproduction; results are sorted by seed; every execution starts in an empty
  directory; the default work directory follows `--repo` (in a repository without Stopbar it is a temporary
  directory, so the prober creates no `.git/stopbar`); the last line of the output names `summary.json`.
- Example: `examples/bounded-queue.probe.ts` (a FIFO queue with a fixed capacity, mutants `M1_dropCap` and
  `M2_lifoInsteadOfFifo`).
- Tests: unit tests `tests/unit/probe-sdk.test.ts` (`createRng`, `defineModel`, checks, teardown, mutants, chunked
  `shrink`, `loadTarget`); E2E scenario S36 (file target with mutants, `probe:result`, `attest` before and after an
  edit, minimal reproduction and replay, a surviving mutant, a target without mutants, `--no-record`, a repository
  without Stopbar).

## 1.1.3 (2026-11-26)

`src/kernel.ts` is unchanged (sha256 `c602fc4bcf8ffb2e...`); every kernel law holds as in 1.1.2. A `config.json` and a
`state.json` from 1.0.0–1.1.2 work without migration.

- **Security fix (`init --force` and `reset` on a dirty tree):** both start a fresh kernel on the current working tree.
  Before 1.1.3, uncommitted changes of existing tests or of test config vanished with the old state, so a commit after
  green gates needed no `approve-tests`. Now both commands compare the working tree with `baseRef` (else `HEAD`) by the
  same rule as the hooks. When a change is suspicious, they take one kernel step `EDIT_TEST` (`suspicious: true`,
  `cost: 0`), save it in `state.json` and log it in `events.jsonl` (`init:dirty-tests` / `reset:dirty-tests`, with
  `req` and every kernel field, so `stopbar attest` stays consistent). The output starts a `WARN:` line with the files.
  The session then starts with `testsTainted = true` at the next revision (the kernel's first revision is 1, so 2)
  until a human runs `stopbar approve-tests`. On a clean tree nothing changes.
- **`stopbar upgrade [--hooks <targets>] [--force-hooks]`:** re-pins the hook runtime (`.git/stopbar/runtime`) from the
  installed package and, with `--hooks`, rewrites the hook configuration. It does not touch `state.json`,
  `config.json` or the snapshot indexes: revision, gates, taint and budget stay. It needs a valid `config.json` and
  `state.json` (else it fails closed with the fix), validates `--hooks` before it writes, and logs `human:upgrade`
  (version, runtime, kernel; no `req`, so `attest` stays consistent and lists `upgrade` in `humanActions`). The agent
  cannot run it (self-protection). `stopbar doctor` now names `stopbar upgrade` in `[WARN] pinned runtime`.
- **No false taint after `checkout` / `rebase` / `cherry-pick` from `baseRef`:** with `--base-ref`, the hooks compare
  the blob id of each changed test and test-config file with `baseRef` (`refEntries`, one `git ls-tree` call, only when
  such a file changed). A file with the same content as in `baseRef` is not suspicious, so tests and `package.json`
  taken over from a newer `main` no longer taint. A test of `baseRef` with other content, or deleted, and a test-config
  file that differs from `baseRef` (also a new one) are suspicious. The file mode is ignored (Windows). The tree
  revision still grows with every change (the gates must run again), and a taint is never cleared by putting a file
  back (law L2.2).
- **Without `--base-ref` the rule of 1.1.2 stays:** every change of an existing test (in `HEAD`) and of test config is
  suspicious, also when the file equals `HEAD`. The agent's own git commands move `HEAD` (for example
  `git stash && git checkout stash@{0}` in one call), so a content match with `HEAD` is no evidence.
- `repo.ts`: `changesSinceRef(r, ref, now)` (a non-`HEAD` ref that does not resolve fails closed), `refEntries`,
  `oidOf`; `changesSinceHead`, `inRef` and `inHead` stay as before.
- Tests: unit tests for the blob-id rule, for `refEntries` / `changesSinceRef` and for blocking `stopbar upgrade`;
  E2E scenarios S33 (`init --force` / `reset` on a dirty tree), S34 (`stopbar upgrade`) and S35 (`checkout`,
  `cherry-pick` and `rebase` with `--base-ref main`, and the `HEAD` rule). The probe model follows both changes; half
  of the seeds now run with a base ref, and a new action puts a file back to its base content.

## 1.1.2 (2026-11-26)

`src/kernel.ts` is unchanged (sha256 `c602fc4bcf8ffb2e...`); every kernel law holds as in 1.1.1. A `config.json` from
1.0.0–1.1.1 with two different gate commands works without migration.

- **`buildCmd` and `fullTestCmd` must differ.** The classifier matches `buildCmd` first, so with two equal commands
  (after trimming) every run was recorded as a build and the full test gate could never pass. `validateConfig` now
  refuses such a config with a `ConfigError` that says how to fix it; `stopbar init` exits 1 before it writes a file;
  for an existing `config.json` with equal commands the hooks fail closed and `stopbar doctor` reports
  `[FAIL] config.json` with the fix.
- **Claude Desktop session tools are local.** `DEFAULT_SAFE_TOOLS` is now `["mcp__ccd_turn__*",
  "mcp__ccd_session_mgmt__*"]`, so a message to another local session after a secret read no longer causes a false
  `PAUSE`. Other MCP tools stay outbound. An existing `config.json` keeps its own `safeTools`: add
  `"mcp__ccd_session_mgmt__*"` or run `stopbar init --force ...`; `stopbar doctor` shows a `[WARN] safeTools` while a
  default entry is missing.
- **`stopbar init --cli "<cmd>"` (`config.cliCmd`).** The hints in the commit refusal, in the block of a background gate
  command (`PreToolUse` and `PostToolUse`) and in the note for a gate run without an exit status (Codex CLI) name
  `<cliCmd> run build|test`. Without `--cli` they name `npx --no-install stopbar run build|test`, which never downloads
  the package from the npm registry (1.1.1 said `npx stopbar`). `cliCmd` must be one command without shell operators
  and must not name `.git` or an agent-settings directory; with `--no-pin`, `init` also refuses a `cliCmd` that points
  at the hook runtime. `<cliCmd> run test` passes the hooks; `<cliCmd> approve-tests`, `approve-shell`, `resume`,
  `reset` and `init` stay blocked.
- **`stopbar init --stop-gate block|warn` (`config.stopGate`, default `block`).** `warn` changes only the `Stop` hook:
  with uncommitted changes that are not verified (no green build or full tests at the current revision, tainted tests,
  or a halted session) it answers exit 0 with `WARN (stopbar): ...` and logs a `stop:warn` entry (reason, revisions,
  taint, halt) in `events.jsonl`, without a kernel step. `git commit` and `git push` in the agent hooks and in the git
  hooks stay gated by the kernel. All five adapters render this answer without blocking the turn. `status` (text and
  `--json`), `doctor` and `attest` (`config.stopGate` in JSON, a `Stop gate` row in Markdown when `warn`) show the mode.
- Tests: unit tests for the new config rules and for the non-blocking Stop answer in every adapter; E2E scenarios S31
  (equal gate commands, session tools, `--cli` with a pinned runtime) and S32 (`--stop-gate warn` with the agent hooks,
  the git hooks and every adapter).

## 1.1.1 (2026-11-26)

- **Security fix (background gate commands):** Claude Code fires `PostToolUse` immediately with `backgroundTaskId` when
  a command runs with `run_in_background: true`, before the process finishes. Previously Stopbar treated that immediate
  event as a passing gate. Now `PreToolUse` blocks `buildCmd` and `fullTestCmd` invoked with `run_in_background: true`
  (guiding long-running gates to `npx stopbar run build|test`), and `PostToolUse` refuses to record any gate result that
  carries `backgroundTaskId` or `run_in_background: true` (defense in depth, fail closed).
- **`stopbar run build|test` stale-tree check:** `stopbar run` captures the tree snapshot before starting the command
  and discards the result if the working tree changes while it runs (for example during a background `stopbar run`), so
  a gate started on an older revision never passes a newer one.
- **No secret false alarm on source code (`secrets.ts`):** `PROFILES.strict` replaces bare `secrets.*` with explicit
  secret data/config extensions, and the matcher skips source-code extensions (`.ts`, `.js`, `.py`, `.go`, `.rs`, ...)
  for legacy `secrets.*` patterns in existing `config.json` files. Explicit entries and data files (`secrets.json`,
  `secrets.yaml`, `secrets.env`) still trigger the secret gate.
- **`--base-ref <ref>` on `stopbar init` (default `HEAD`):** marks which git ref defines an "existing" test file.
  Agents on a multi-commit feature branch (e.g. `--base-ref main`) can iterate on new tests added on that branch across
  commits without triggering `testsTainted`, while existing tests in `baseRef` and all test-config files remain
  protected. `inRef` fails closed if a configured non-`HEAD` ref cannot be resolved; `status`, `doctor` and `attest`
  report `baseRef`.
- **Plain `git commit -m` messages:** for a verified chain-free `git commit` command in Bash, self-protection strips
  quoted `-m` / `--message` strings (matching the safe heredoc commit behaviour), so commit messages mentioning
  `.git/stopbar`, `.claude` or `approve-tests` are not falsely blocked.

## 1.1.0 (2026-11-26)

- Adapters for Cursor, Codex CLI, Gemini CLI and Antigravity CLI next to Claude Code. One internal event, one kernel;
  each adapter renders the decision in the client's own protocol.
- `stopbar hook --adapter auto|claude|cursor|codex|gemini|antigravity`. `auto` (the default) detects the client from
  the payload; v1.0 Claude Code settings keep working; an unknown or damaged payload fails closed.
- `stopbar init --hooks` takes `claude` (`local`), `claude-project` (`project`), `cursor`, `codex`, `gemini`,
  `antigravity` (`agy`) and `git`, comma separated, and merges into existing config files.
- Git fallback: `stopbar git-hook pre-commit|pre-push`, installed by `init --hooks git` (an existing user hook is kept
  unless `--force-hooks`), and `stopbar run build|test` to record gate runs for tools without hooks.
- Self-protection also covers `.cursor/hooks.json`, `.codex/hooks.json`, `.codex/config.toml`, `.gemini/*settings*.json`,
  `.gemini/**/hooks.json` and `.agents/hooks.json`.
- `stopbar doctor` checks the hooks of every client it finds and the git hooks.
- `stopbar status`, `status --json` and `stopbar attest` say why the secret gate is on (pattern, file or token, tool,
  revision); `events.jsonl` records the pattern and the token of every secret read, never the content.
- No secret false alarm on code: a bare token that matches only an extension pattern (`*.key`, `*.pem`) counts only if
  the file exists (`claim.key` in inline code is not a read; `cat server.key` and `cat certs/server.key` are).
- `safeTools` in `config.json` (default `["mcp__ccd_turn__*"]`): local tools that are not treated as outbound.
- Antigravity CLI tool names from a live session (`write_file`, `sed_file`, `call_mcp_tool`, `list_dir`, ...).
- A gate command whose post event carries no exit status (Codex CLI) is recorded neither as a pass nor as a failure,
  and the agent is told to use `stopbar run build|test`; blocked commits name `stopbar run` as the other way.
- Package metadata: repository, homepage and bugs links.

## 1.0.0 (2026-11-26)

First public release.

- Four pillars in one CLI:
  - PROVE: `stopbar prove` (alias `verify`) runs the inductive proof of the kernel and refutes 10 mutants with
    concrete counterexample runs. `npm run verify:lean` checks the Lean export with `lake build` in a pinned
    Lean 4.34.0 container without network.
  - PROBE: `stopbar probe --target wrapper` runs stateful sequences of hook events, human commands and damaged files on
    real git repositories and compares every step with the proven kernel.
  - GATE: `init`, `hook`, `status`, `approve-tests`, `approve-shell`, `resume`, `reset`, `doctor`.
  - ATTEST: `stopbar attest --format json|md` gives a deterministic attestation of the session with the sha256 of the
    event log.
- The hooks run a step function generated from the proven kernel with gdp-wired `compileJs`; they never load the prover.
- Self-protection: no edits of `.git/**`, `.claude/*settings*.json` or the Stopbar code; the runtime is pinned in
  `.git/stopbar/runtime`.
- The quoted heredoc commit `git commit -m "$(cat <<'EOF' ... EOF)"` is allowed; every other command substitution and
  chain in a commit is blocked.
- Fail closed on a damaged `config.json` or `state.json`. A torn last line of `events.jsonl` never swallows the next
  entry.
- Path patterns for tests, test config and secrets in `config.json`; profiles `default`, `ts`, `python`, `strict`.
- Hook latency: no git process in `PreToolUse`, one in `PostToolUse`.
