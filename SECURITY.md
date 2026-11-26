# Security model

Stopbar is a set of Claude Code hooks with a formally proven decision kernel. This file says what is proven, what the
wrapper enforces, and what Stopbar cannot give you without an operating-system sandbox. Read the last part before you
rely on Stopbar against a hostile agent.

## 1. What is proven

The decision rule is `src/kernel.ts`, written in the gdp-wired 0.60.0 DSL. `stopbar prove` runs an inductive proof of
all laws together with the lemmas I1–I5. The proof result is `proven: true, checked: true`: gdp-wired's proof kernel
checked the certificate. The laws hold for every sequence of requests, every budget and every retry limit:

| Law | Statement |
|---|---|
| L1 | A commit executes only after a passing build and a passing full test suite since the last tree change. |
| L2.1 | A commit executes only when every suspicious test or test-config edit is covered by a human approval of that revision or a later one. |
| L2.2 | Taint survives every action except a human test approval. A passing test run does not clear it. |
| L3.1 | "A secret was read" never resets. |
| L3.2 | A risky or outbound shell call after a secret read pauses, unless a one-time human approval is held. |
| L3.3 | The risky call that the approval allows uses it up. |
| L4.1 | In the halted state only RESUME unblocks. There is no ALLOW, no BLOCK and no commit. |
| L4.2 | Reaching the budget cap halts the session at once. |
| L4.3a, L4.3b | `maxRetries` failed test runs without a full pass, or `maxRetries` failed builds, halt the session. |
| L4.4 | In the halted state no action except RESUME changes the key state fields. |

Ten mutants of the rule (M1a–M7) each break one requirement. For each of them the prover must fail, and a concrete
counterexample run must break a law on the mutant and break no law on the original (gdp-wired `replayRefutation`).
This shows that the laws are not vacuous.

How the proof reaches the hooks: the build runs gdp-wired's `compileJs` on the proven machine and writes
`dist/kernel.gen.js`. The hooks run only that file and never load the prover. `stopbar prove`, `stopbar doctor` and the
test suite regenerate it and compare it byte for byte, check the sha256 of `src/kernel.ts`, and replay thousands of
random steps against gdp-wired's interpreter. This link is a check, not a proof: you trust gdp-wired's code generator.

The Lean gate (`npm run verify:lean`) exports the full Lean project with gdp-wired's `leanProject()` and runs
`lake build` with Lean 4.34.0 in a container without network (`docker/lean.Dockerfile`). It passes only with exit 0,
0 errors and 0 `sorry`. It is a release gate for changes of `src/kernel.ts`, not part of `npm test`. It writes the result and the sha256 of the
checked `.lean` file to `results/lean/lean-verify.json`.

## 2. What the wrapper enforces (tested, not proven)

The wrapper turns tool calls into kernel requests. These rules are plain code. The E2E suite, the unit tests and the
stateful prober (`stopbar probe`, real git repositories, compared with gdp-wired's interpreter) test them.
There is no proof for them.

- **Gates by exact command, never in the background.** Only the exact configured `buildCmd` and `fullTestCmd`, alone and
  in the foreground, count as gate runs. With `;`, `&&`, `||`, `|`, a redirection or `$(...)`, the command is blocked
  before it runs, because operators hide its exit status. With `run_in_background: true`, the command is blocked before
  it runs, and any `PostToolUse` carrying `backgroundTaskId` is ignored (never recorded as a pass), because clients fire
  `PostToolUse` immediately before the background process exits. For long-running gates, use `stopbar run build|test`,
  which records the real exit status only when the process completes and discards the result if the working tree changed
  while it was running. Other test runners count as partial runs: they can fail a session, but they never pass the gate.
- **Results from the event type.** Claude Code sends `PostToolUseFailure` for a failed command and `PostToolUse`
  without an exit code for a successful one. A user interrupt (`is_interrupt`) does not count as a failure.
- **Tree changes from content.** A private git index in `.git/stopbar/` gives a content snapshot after every edit and
  every shell call: edits, deletions and new files that are not ignored. Without `config.baseRef`, a change to a test
  file that exists in `HEAD`, or to any test-config file, is suspicious. With `config.baseRef`, the wrapper compares the
  blob id of each changed test and test-config file with `baseRef` (one `git ls-tree`, only when such a file changed):
  a test of `baseRef` with other content or deleted, and a test-config file whose content differs from `baseRef` (also
  a new one), are suspicious; a file equal to `baseRef` is not. The file mode is ignored. A configured non-`HEAD`
  `baseRef` that cannot be resolved fails closed. Every change still raises the tree revision, so the gates must run
  again. The path patterns are in `config.json`.
- **Fresh state on a dirty tree.** `stopbar init --force` and `stopbar reset` classify the uncommitted changes against
  `baseRef` (else `HEAD`) by the same rule. A suspicious change is one kernel step `EDIT_TEST` (`suspicious: true`,
  `cost: 0`), logged with every kernel field: the session starts tainted until `approve-tests`.
- **`git cherry-pick` and `git rebase`.** They are ordinary shell commands: Stopbar does not block them before the gates
  and does not treat them as a commit, although they write commits. They change the working tree, so the next hook
  counts a new revision and the build and full test gates must pass again. With `--base-ref`, the blob-id comparison
  finds every change of an existing test of `baseRef` and of test config against `baseRef`, whichever command made it;
  tests taken over unchanged from `baseRef` do not taint. Without `--base-ref`, every change of an existing test taints.
  `git commit`, `git push` (agent hooks and git hooks) and a green `stopbar attest` still need green gates and no
  unapproved taint. A commit that `cherry-pick` or `rebase` writes itself does not pass through the commit gate (see
  "Other commit paths" below); a later `git push` does.
- **Commits.** `git commit` and `git push` must be one command without operators, also with git global options before
  the subcommand. The one allowed form of command substitution is the quoted heredoc that Claude Code writes:
  `git commit ... -m "$(cat <<'EOF'` … `EOF` `)"`. The delimiter is in single quotes, so bash expands nothing in the
  message. Nothing else may be in the command. Unquoted `<<EOF`, any other `$(...)`, backticks and chains are blocked.
  For a chain-free `git commit` in Bash, quoted `-m` / `--message` text and the quoted heredoc body are treated as
  commit-message data by self-protection.
- **Self-protection, before the kernel, also when halted.** Edit and Write may not touch any `.git/` directory (Stopbar
  state, git hooks, `.git/config`), the hook configuration of a supported agent (`.claude/*settings*.json`,
  `.cursor/hooks.json`, `.codex/hooks.json`, `.codex/config.toml`, `.gemini/*settings*.json`, `.gemini/**/hooks.json`,
  `.agents/hooks.json`, at project and user level), or the Stopbar code that runs the hooks. A shell command may not
  name a `.git`, `.claude`, `.cursor`, `.codex`, `.gemini` or `.agents` directory, write git config (`git config`
  without `--get` or `--list`), name the Stopbar code, use a `STOPBAR_*` variable, or run a human command
  (`approve-tests`, `approve-shell`, `stopbar init/resume/reset`).
- **One kernel for every agent.** An adapter per client (Claude Code, Cursor, Codex CLI, Gemini CLI, Antigravity CLI)
  translates the hook payload into one internal event and the decision into the client's output protocol. The
  adapters are wrapper code: the E2E suite runs each with payloads in the client's published schema.
- **Pinned runtime.** `stopbar init` copies the runtime to `.git/stopbar/runtime/` and points the hooks there. An agent
  that edits or rebuilds a Stopbar checkout cannot change the code that judges it.
- **Fail closed.** Bad hook input, a missing or damaged `config.json` or `state.json`, a busy lock, or any internal
  error gives exit 2 with a fix on stderr. Every tool call is then blocked until a human repairs the state.
- **Event log.** `events.jsonl` gets one JSON line per kernel step. If a crash left the last line torn, the next entry
  starts on a new line, so it is never glued to the fragment.

## 3. What Stopbar does not give you without an OS sandbox

An agent with a shell runs with your user's rights. The hooks see the text of a command, not what it does. Under these
conditions Stopbar is a strong guard against shortcuts and mistakes. It is **not** a security boundary against an agent
that tries to defeat it:

1. **Indirect execution.** A script written to a normal file and then run (`node x.js`, `bash x.sh`) can do anything:
   delete `.git/stopbar`, edit `.claude/settings.local.json`, run `stopbar approve-tests`. The text checks do not see
   inside the script. Obfuscation (`c=cu; ${c}rl`), aliases and shell functions also pass the text checks.
2. **Gate commands run arbitrary code.** `buildCmd` and `fullTestCmd` run the repository's code. A new test file is
   trusted. It can read secrets, use the network or weaken other checks at run time.
3. **Secrets by file name only.** Secrets in environment variables, in files with ordinary names, or found with Grep in
   ordinary files are not seen. The exfiltration gate works on command text only. In a shell command, a bare token
   that matches only an extension pattern such as `*.key` counts only if that file exists (a field access like
   `claim.key` is not a file); a command that names a `.key` file which does not exist yet is therefore not a read.
   Tools listed in `config.safeTools` (default: Claude Desktop's `mcp__ccd_turn__*` UI tools and its
   `mcp__ccd_session_mgmt__*` tools for messages between local sessions) are not treated as outbound; a human who adds
   a glob there vouches that those tools send nothing out. A message to another local session can carry text the agent
   has read; that session runs under its own hooks. A `config.json` from 1.0.0–1.1.1 keeps its old list until a human
   adds `mcp__ccd_session_mgmt__*` or runs `stopbar init --force ...`.
4. **Weak new tests and mutable `baseRef`.** A new test file is not suspicious. A mock of the system under test or an
   empty assertion in a new file passes. Hard-coded answers in production code are an ordinary code edit. When
   `config.baseRef` is a mutable local branch name (such as `main`) rather than a commit SHA, an agent with shell access
   can move that branch ref; pass a commit hash (`--base-ref <sha>`) if you want an immutable baseline. Since 1.1.3 this
   matters more: a test that equals `baseRef` does not taint, so an agent that moves the `baseRef` branch to a commit
   with weakened tests (for example `git branch -f main <commit>` or `git update-ref`) and then checks it out is not
   flagged. Stopbar does not watch the ref itself.
5. **Ignored files.** Files ignored by `.gitignore` are invisible to the snapshot (for example patches in
   `node_modules`). A change to `.gitignore` itself is suspicious.
6. **Other commit paths.** Git aliases, `git commit-tree`, `git stash`, `git cherry-pick`, `git rebase`, `gh pr create`
   and similar are not detected as commits. The Stop hook
   catches uncommitted work only. With `config.stopGate: "warn"` it does not even block that: the turn ends with a
   `WARN (stopbar)` answer and a `stop:warn` entry in `events.jsonl`. This mode takes no kernel step at Stop and does not
   weaken the commit gate: `git commit` and `git push` in the agent hooks and in the git hooks are judged by the kernel
   exactly as in `block` mode (laws L1, L2.1 and L3.x). What `warn` gives up is the reminder at the end of a turn, so
   unverified work can stay uncommitted in the working tree.
7. **Concurrency and humans.** A change made between two hook calls (a background job, a human edit) is counted as the
   agent's change at the next hook. With parallel tool calls a change can be attributed to the wrong call.
8. **Agent configuration.** Settings outside the repository (user settings, managed settings, `--settings`,
   `disableAllHooks`) can remove the hooks. The hooks cover what Claude Code sends to them.
9. **Human approvals.** `approve-tests` and `approve-shell` are only as good as the human review behind them.
10. **Client-specific limits of the adapters.**
    - Cursor: a hook exit other than 0 and 2 is fail-open unless the entry sets `failClosed: true`; `init --hooks
      cursor` sets it. `afterShellExecution` carries no exit code, so a gate command seen only there never passes; the
      config written by `init` uses `preToolUse` and `postToolUse`.
    - Codex CLI: there is no failure event, and the tool result of a shell call is the plain output without the exit
      status (seen live in 0.172.0). A gate command seen there is recorded neither as a pass nor as a failure; the agent
      is told to run `stopbar run build|test`, which runs the command and records its real exit status. Codex loads
      `.codex/` (config and hooks) only in a trusted project and asks the user to review and trust project hooks; until
      then they do not run (a live run in an untrusted folder loaded none).
    - Gemini CLI: an exit other than 0 and 2 is only a warning, and invalid JSON output counts as "allow". Stopbar exits
      2 for every block and internal error, but a crash before Stopbar's own handler (for example a missing Node.js)
      fails open. Gemini CLI warns when a project hook changes and treats it as untrusted.
    - Antigravity CLI: hooks of a workspace load only after the folder is trusted. A message after a tool call
      (PostToolUse) cannot reach the agent; it sees the reason at its next blocked call. An allowed call returns an
      empty answer, so Antigravity's own permission rules still apply on top of Stopbar (checked live).
    - Git fallback: git hooks see only commits and pushes, not reads or shell commands, so the secret gate needs an agent
      hook to record the read. `git commit --no-verify` and `git push --no-verify` skip git hooks.

For a hostile-agent threat model, run the agent in a container or VM: no network by default, the repository mounted
read-write, `.git/stopbar` and `.claude` mounted read-only or owned by another user, and the human commands run outside
the sandbox. Stopbar's kernel then gives the proven decisions and the sandbox gives the boundary.

## Known limits of 1.1.3

- The blob-id comparison trusts `baseRef`: see point 4 of section 3 (a mutable branch name can be moved by the agent).
  Use a commit SHA as `--base-ref` when the agent must not be able to move the baseline.
- `init --force` and `reset` count all suspicious uncommitted changes as one kernel step. A test file that changed in
  a branch commit against `baseRef` counts too, even if a human approved it in an earlier session: after `reset` such
  a branch starts tainted until `approve-tests`.
- `stopbar upgrade` re-pins the runtime from the package that runs the command. It does not check that the package is
  newer, and it does not change `config.json`; new defaults (for example `safeTools`) are only named as a hint.

## Known limits of 1.1.2

- `stopGate: "warn"`: in Cursor, Codex CLI, Gemini CLI and Antigravity CLI the WARN text is not shown to the agent,
  because their Stop protocols have no non-blocking message (a `followup_message`, `decision: "block"` or
  `decision: "continue"` would start another turn). The entry in `events.jsonl` and `stopbar status` show it.
  Claude Code gets the text on stdout with exit 0.
- `cliCmd` is checked as text: one command, no shell operators, no `.git` or agent-settings directory. Stopbar does not
  check that the command really starts Stopbar; a wrong `cliCmd` gives the agent a hint that does not work, and the
  gates still count only real runs. Self-protection still blocks the human-only commands through `cliCmd`.
- `buildCmd` and `fullTestCmd` that differ only in whitespace at the ends count as equal and are refused. Two different
  commands that run the same script (for example `npm test` and `npm run test`) are not detected.

- Lean: the check needs Docker and a one-time image build with network access. The base image is pinned by digest and
  the Lean archive by sha256, both recorded at the first build (trust on first use). The Lean export is not
  deterministic: each export is a different proof tree, and the gate checks the one it exports.
- Platforms: the unit tests, E2E, `stopbar probe` and `stopbar prove` pass on Windows 11 with Git for Windows and on
  Linux (Debian 13, Node 24, git 2.47). A live Claude Code session ran on Windows. macOS is not tested.
- Adapters: Cursor, Codex CLI, Gemini CLI and Antigravity CLI are spec-tested (see the README table); a client can
  change its hook schema in a later version.
- Hook latency: Windows starts a process in 50–70 ms, so a hook with one git process takes about 120–200 ms in all.

## Reporting a vulnerability

Send a private report to the maintainers before you publish it. Include the Stopbar version, `stopbar doctor --json`
and `stopbar attest` output and a minimal reproduction (the probe's JSON format in `tests/regressions/` is welcome).
