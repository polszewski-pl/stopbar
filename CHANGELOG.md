# Changelog

## [1.2.3] (2026-11-28)

The kernel and dependencies are unchanged.

- **Security fix: `stopbar doctor` with `GIT_DIR` no longer writes into the repository under check (affected:
  1.0.0–1.2.2).** With `GIT_DIR` or another `GIT_*` variable pointing at that repository (for example inside a git
  hook), the dry run's `git init`, `git add -A` and `git commit` ran on it and its scratch config and state went into
  its Stopbar directory: `core.bare` could be set to `true`, the index replaced, a commit `base` with the scratch files
  added, and `events.jsonl` and `state.json` rewritten. The dry run now runs without the `GIT_*` variables and refuses
  a scratch directory that git resolves to another repository. Details in SECURITY.md (Fixed vulnerabilities).

## [1.2.2] (2026-11-27)

`src/kernel.ts` is unchanged (sha256 `c602fc4bcf8ffb2e...`); every kernel law holds as in 1.2.1. No new dependency.
`PreToolUse` still starts no git process. A `config.json` and a `state.json` from 1.0.0–1.2.1 work without migration;
the new test-config patterns below reach an existing repository with `stopbar init --force`.

- **Husky, Lefthook and a custom `core.hooksPath` are protected.** Edit and Write of `.husky/**`, `lefthook*.yml`,
  `.lefthook*.yml` (also `.yaml`, `-local`), `.lefthook/**` and of every file in the custom `core.hooksPath` are
  blocked; so are shell commands that name them (`sed -i '/git-hook/d' .husky/pre-commit`, `rm -rf .husky`), matched on
  path-segment boundaries (an empty, `.` or `/` value protects nothing). The hook reads `core.hooksPath` from
  `<common-dir>/config` and `config.worktree` itself (`readHooksPath`), without a git process. `.husky` and `.lefthook`
  join the wildcard guard (`rm -rf .hu*`), and `pre-commit`, `pre-push` and `_` the names checked inside a guarded
  directory. The same files are test config in every profile, so a change made outside the agent hooks taints.
- **`stopbar doctor` reports `[FAIL] hooks git` when a Stopbar git hook is gone**: written by the last `init` or a later
  `upgrade` (the events now record `gitHooksWritten`), run since the last `init` or `reset` (`hook-timing` records
  `gitHook`), called by the tracked hook file in `HEAD`, or the other hook is still in place and the log does not say
  that Stopbar left this one out. A hook that was never set up stays `[WARN]`. Doctor only reads `events.jsonl`.
- **Portable hook line.** The `WARN` of `init`, the refusal of `--hooks git` and `doctor` print
  `npx --no-install stopbar git-hook pre-commit|pre-push` (from `--cli`) first and, without a local `node_modules`,
  `node "$(git rev-parse --git-dir)/stopbar/runtime/bin/stopbar.mjs" git-hook <name>`; no absolute path into `.git`.
- **Wildcards after `$(pwd)`.** `$(pwd)`, `"$(pwd)"`, `${PWD}`, `$PWD`, `` `pwd` `` (also quoted, `pwd -L|-P`) read as `.`
  before the command is split, so `rm -rf $(pwd)/.g*` is blocked as `rm -rf $PWD/.g*` was, and `cat $(pwd)/.e*` is a
  secret read.
- **`find` with a pattern.** `find` with `-name`, `-iname`, `-path`, `-ipath`, `-wholename` or `-iwholename` whose
  pattern reaches `.git`, an agent settings directory, `.husky`, `.lefthook`, a Lefthook file or the custom
  `core.hooksPath`, together with `-delete`, `-exec`, `-execdir`, `-ok` or `-okdir`, is blocked; a pattern that reaches a
  secret name (`.e*`, `*.pem`, `*.key`, `*/.env*`) with an `-exec` action is a secret read. `find . -name "*.ts" -exec
  wc -l {} +` and `find . -name "*.test.ts" -delete` stay allowed.
- **`stopbar doctor --strict`**: a `[WARN]` fails too (exit 1, `RESULT: FAIL (strict: N warning(s))`, `--json`
  `ok: false, strict: true`). Without the flag nothing changes.
- **`init` notes.** Without `--require-run`, `init` names `--require-run` and `doctor --strict` for CI; with
  `--hooks codex` it recommends `--require-run`, because Codex CLI passes no exit status to its hooks. The default stays
  `requireRun: false`.
- **`init --force` keeps `safeTools`**, and `--safe-tools "<glob>,<glob>"` sets them. A damaged previous `config.json`
  never blocks `--force` (then the default list).
- **`--help` / `-h` in every subcommand** prints the help and runs nothing (`stopbar reset --help` no longer resets). A
  `--help` that is the value of a flag (`--cmd --help`) is not taken as a request for help.
- **`stopbar run` on Windows** starts the gate command without the `PWD` inherited from Git Bash, so a bash inside
  the gate sets its own (`PATH="$PWD/node_modules/.bin:$PATH"` broke at the colon of `C:`, exit 127). `stopbar doctor`
  warns when a gate starts with a bare `bash` and the first bash on `PATH` is WSL's.
- **`import 'stopbar/probe'` without `stopbar` in the project's `node_modules`.** `stopbar probe --target <file>`
  resolves that specifier to its own SDK with a module resolve hook (`registerHooks`, `node:module`), in the runner and
  in each worker.
- **Docs.** The PROBE guide moved from `README.md` to [`docs/probe.md`](docs/probe.md) (in the npm package). The README
  starts with one statement of what is proven, what is tested and what needs an OS sandbox, without the repeated
  paragraph. `SECURITY.md`: Known limits of 1.2.2.
- No `any` in `integrations.ts` and `store.ts` (typed JSON and event entries). Version 1.2.2.

## 1.2.1 (2026-11-27)

`src/kernel.ts` is unchanged (sha256 `c602fc4bcf8ffb2e...`); every kernel law holds as in 1.2.0. No new dependency.
A `config.json` and a `state.json` from 1.0.0–1.2.0 work without migration.

- **Custom `core.hooksPath` is not written.** When `core.hooksPath` points outside `.git/hooks` (Husky, Lefthook, a
  shared or tracked hooks directory), `init --hooks <client>` writes no git hook there and prints a `WARN` with the
  manual `node "<runtime>/bin/stopbar.mjs" git-hook pre-commit|pre-push` lines; explicit `--hooks git` without
  `--force-hooks` fails closed (exit 2) before any hook file is written; `--force-hooks` writes the hooks and keeps a foreign
  one as `<name>.stopbar-backup`. `stopbar doctor` reports `[WARN] hooks git`: it says that git commit and git push are
  not gated, and prints the exact line for each missing hook. A `stopbar git-hook <name>` line chained by hand counts.
- **`stopbar status` after `baseRef` advanced.** With `testsTainted` and a non-`HEAD` `baseRef`, `status` prints
  `note: no existing test or test-config file currently differs from <baseRef>; ...` when that is so, and
  `status --json` has `taintedDiffersFromBaseRef` (`true`, `false`, or `null` when untainted or without `baseRef`).
  The taint stays (L2.2): `status` never writes `state.json`.
- **`stopbar probe --cmd`: no silent exit.** A target that printed a banner or a non-JSON answer to `info` ended the
  CLI with exit 0 (and `await probe()` with exit 13) on Linux: `close()` waited for an `exit` event of a killed,
  unref'd child against an unref'd timer. `close()` now returns at once for a killed or exited process, and its timers
  hold the event loop and are cleared. Regression test: banner, non-JSON and crash on `info` give exit 1 from the CLI
  and a `ProbeError` from `probe()` and `loadCmd()`; exit 0 comes only with `PROBE PASS`.
- **Four bypasses closed in `src/classify.ts`.** `printenv`, a bare `env`, `Get-ChildItem Env:` and
  `/proc/self/environ` are a secret read (`env VAR=1 cmd` and `set` are not). Tokens with `..` are normalised
  (`cat src/../.env`), and a live wildcard that reaches a secret name is a read (`cat .en*`, `cat .en?`). `rm`, `mv`,
  `del`, `Remove-Item` and the like with a wildcard on `.git` or an agent settings directory are blocked (`rm -rf .g*`,
  `rm -rf .cl*`), and so is a wildcard followed by a path inside (`cp x .g*/hooks/pre-commit`). A git subcommand from
  an expansion is blocked (`git $f -m x`, `p=push; git $p --no-verify`, `git "${cmd}"`). Unit tests also record the
  known limits (`cat $(echo .e)nv`, `f=.e; cat ${f}nv`, `node /tmp/x.js`).
- **`stopbar doctor` names the gate mode** on the `config.json` line: `gates: hook command text (use --require-run for
  exit-code-only gates)` or `gates: stopbar run only (--require-run)`. `--require-run` stays optional.
- **Tests:** HALT with `safeTools: ["*"]` still pauses Bash, Edit, Write and Read; the heredoc exceptions hold only
  for `<<'EOF'` (not `<<EOF`, `<<"EOF"`, `bash -s <<'EOF'` or `sh <<'EOF'`).
- **Types:** no `any` left in `src/hook.ts`, `src/verify.ts`, `src/doctor.ts`, `src/probe/` and `src/adapters/`.
  In the probe SDK, `ActionSpec.run` takes `args: unknown` (was `any`); destructured arguments such as
  `run: (s, {x}, check)` still compile. `npm run typecheck` builds first, so it works on a fresh clone.
- **Release:** `.github/workflows/release.yml` publishes to npm with provenance (Trusted Publishing, OIDC) when a `v*`
  tag that matches `package.json` is pushed.
- **Docs:** README and SECURITY open with what is proven, what is tested and what needs an OS sandbox, add
  "Hardening: OS sandbox + client deny rules", list the default `safeTools` with a warning about broad globs, and say
  what probe evidence in `attest` is. SECURITY has one "Known limits of 1.2.1" section.

## 1.2.0 (2026-11-26)

`src/kernel.ts` is unchanged (sha256 `c602fc4bcf8ffb2e...`); every kernel law holds as in 1.1.3. A `config.json` and a
`state.json` from 1.0.0–1.1.3 work without migration. `stopbar probe --target wrapper` (the default) runs as before.
This release joins 1.2.0-rc.1 (PROBE for TS/JS) with PROBE for any language and `stopbar probe init`. No new runtime
dependency: `gdp-wired` 0.60.0 is still the only one.

Selftest fixes (8 findings of the 1.2.0 audit, each with a regression test):

- **F1 (P1) `git config` with the word `list` or `get` in a value is a write.** Only the words right after `config`
  decide a read: the subcommands `list` and `get <name>`, or `--get`, `--get-all`, `--get-regexp`, `--get-urlmatch`,
  `--list`, `-l` before the arguments, with scope and format flags around them. `git config core.hooksPath list` and
  `git config alias.ci "commit -m list -q"` were taken for reads and are now blocked.
- **F2 (P1) git global options with a value.** `--attr-source <tree>` (also `=`), `--super-prefix`, `--list-cmds` and
  any other `--opt=value` before the subcommand no longer hide `commit`, `push`, `config` or `-c alias.*`.
- **F3 (P2) `stopbar probe init` is not blocked.** The human-only check now looks for `init`, `resume`, `reset`,
  `upgrade` and `doctor --fix` right after the `stopbar` program word (`stopbar`, `stopbar.mjs`, `stopbar@<version>`,
  quoted or not). `stopbar init` and `npx stopbar init` stay blocked.
- **F4 (P2) `stopbar attest` with a long `events.jsonl`.** The last kernel step is found with a loop, not with
  `Math.max(...events)`, which overflowed the stack at about 130 000 lines.
- **F5, F6 (P2) mixed and word-final quotes.** New `unquoteShellWords`: the text checks also read each word with its
  quote pairs removed, so `'.cl'"aude"`, `.g"i"'t'`, `.e"n"'v'` and `gi"t"` are `.claude`, `.git`, `.env` and `git`
  for self-protection, the secret check and the commit and push classification.
- **F7 (P2) `stopbar probe` with large `--runs` or `--mutant-runs`.** A worker gets its share in a file
  (`--worker-file <path>` in the work directory, removed when the worker ends) instead of one JSON argument, which
  failed with `spawn ENAMETOOLONG`. `--worker <json>` still works.
- **F8 (P2) `stopbar status` on an uncounted working tree.** `status` compares the working tree with the counted
  snapshot. After a change that no hook has counted, it says so on the `revision` line and shows `commit blocked:
  uncommitted working-tree changes not yet counted` instead of `allowed`. `status --json` has the new fields
  `workingTreeSnapshot` and `workingTreeCounted`.
- `skills/stopbar/SKILL.md`: who runs which prober (agrees with SECURITY.md section 4), `--cmd-timeout` under CPU
  load, what to do after the first finding, and when `--no-record` is allowed.
- Tests: unit tests for F1–F7 (`classify`, `attestation` on 140 000 log lines, `probe()` with 40 000 mutant seeds) and
  E2E scenario S41 (F8).

Launch hardening:

- **`stopbar probe --cmd` never hangs after a failed kill.** `taskkill` reports a failure (no rights, a sandbox, not on
  `PATH`) by its exit status, not by an exception; Stopbar now checks it and then kills the direct child. The pipes of
  the process are always destroyed and the child is unref'd, also after the grace period of `close()`, so a process that
  survives can no longer keep Stopbar's event loop open.
- **Git hooks by default.** `init --hooks <clients>` also writes `pre-commit` and `pre-push` (they close git aliases,
  and before a push `merge`, `cherry-pick`, `am` and `commit-tree`). `--no-git-hooks` skips them. A foreign git hook is
  kept with a `WARN` that names `--hooks git --force-hooks`; with `git` named in `--hooks` it is still an error.
  `init` without `--hooks` writes nothing outside `.git/stopbar/`. `stopbar doctor` reports `[WARN] hooks git` while
  one of the two Stopbar git hooks is missing, with the fix `stopbar upgrade --hooks git`.
- **`git -c alias.<name>=...` is blocked** (also `-calias.`, quoted, `--config-env alias.*` and
  `GIT_CONFIG_KEY_<n>=alias.*`): a one-off alias hid the real git subcommand from the commit and push gates.
- **Quote splicing.** The secret and self-protection checks also read the command as bash joins the quoted parts of a
  word: `cat .e""nv` is a read of `.env`, `rm -rf .g""it` and `cat .cl''aude/...` are blocked.
- **`--require-run`** (`config.requireRun`, default `false`): the build and full test gates count only through
  `stopbar run build|test`; the same command from the agent's shell is not recorded and the hook names `stopbar run`
  (`post:require-run` in the log). `status`, `doctor` and `attest` show it.
- `scripts/*test*` is a test pattern in every profile (new `config.json` files).
- **`safeTools` while halted** (telemetry): the tools in `config.safeTools` (default `mcp__ccd_turn__*`,
  `mcp__ccd_session_mgmt__*`) pass in `HALT`, so the agent can ask a human for `stopbar resume`. They take no kernel
  step. Read, Edit, Write, Bash, WebFetch and every other MCP tool stay paused.
- **A single-quoted heredoc as stdin is data** (telemetry): `agy -p - <<'EOF'` … `EOF` whose prompt mentions
  `approve-tests` is no longer blocked as a human-only command. A shell or interpreter on the command line, a pipe, a
  `>`/`>>` redirection, a variable or a command that stores or runs stdin (`xargs`, `at`, `tee`, `stopbar`) keeps the
  full check; `.git`, agent settings and Stopbar code stay protected in the body.
- **No false `[WARN] kernel link`** (telemetry): `stopbar doctor` finds `gdp-wired` with `import.meta.resolve`, so a
  hoisted install (`npm install stopbar`) is checked. The WARN stays for a copy where it cannot be resolved.
- `stopbar doctor` reports missing Claude Code hooks also when only the git hooks are present, if the last `init` or
  `upgrade` wrote Claude Code hooks (`human:init` now logs the hook targets).
- **Typecheck.** `npm run typecheck` (`tsc --noEmit`, strict, over `src/`, `scripts/`, `tests/`, `bench/`) with
  `typescript` 5.9.3 and `@types/node` 24 as devDependencies only. `src/hook.ts` has no `any` left. The build writes
  `dist/*.d.ts` files that point at `src/*.ts` for the typecheck; they are not in the npm package and not in the pinned
  runtime.
- **CI.** `.github/workflows/ci.yml`: build, typecheck, tests and a PROBE of `examples/bounded-queue.probe.ts` with
  mutants on Ubuntu, Windows and macOS; `npm run prove`; `lake build` with Lean 4.34.0 from elan through the new
  `node scripts/verify-lean.ts --local` (no Docker). The Docker mode is unchanged.
- README and SECURITY.md say in their first lines what is proven (the kernel) and what is tested (the wrapper), and
  that without an OS sandbox Stopbar is no security boundary against a hostile agent.
- **Agent skill.** `skills/stopbar/SKILL.md` (Agent Skills format) tells an agent how to work under the gate and how to
  write Zero-FP probes. It is in the npm package (`files`) and linked from the README.
- Tests: unit tests for the kill fallback (a stuck target with no `taskkill` on `PATH`), `git -c alias.*`, quote
  splicing, the stdin heredoc and the documented limits; E2E scenarios S38 (`safeTools` in `HALT`), S39
  (`--require-run`, `.e""nv`, `.g""it`, `git -c alias.*`, a heredoc prompt) and S40 (git hooks by default, foreign hooks,
  `--no-git-hooks`, `[WARN] hooks git`, kernel link).

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
