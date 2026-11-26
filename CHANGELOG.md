# Changelog

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
