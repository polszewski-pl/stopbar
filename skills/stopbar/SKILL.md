---
name: stopbar
description: Load this skill when you work in a repository that Stopbar GATE protects (a `.git/stopbar/` directory, Stopbar hooks, or a Stopbar block message), or when you write a multi-step `stopbar probe` target to the Zero-FP standard.
---

# Stopbar

Stopbar is an execution gate for AI coding agents. Its hooks block a commit until the build and the full test suite
pass at the current tree, block unapproved test changes and block risky or outbound commands after a secret read.
The hooks check the command text. This skill tells you how to work with them and how to write probes that find only
real bugs.

`<cli>` below is the Stopbar command that the block hints show. The default is `npx --no-install stopbar`; a human can
set another one with `stopbar init --cli "<cmd>"`.

## 1. Working under Stopbar GATE

### Gate commands

- Run `buildCmd` and `fullTestCmd` exactly as configured: the same text, alone, in the foreground. Do not add `;`,
  `&&`, `||`, `|`, `>`, `2>&1` or `tail`, and do not run them in the background. A changed or chained command is not
  recorded as a gate.
- A gate that runs longer than 10 minutes: run `<cli> run build` or `<cli> run test`. This form can run in the
  background. Stopbar records the real exit status when the process ends and discards it if the tree changed.
- Always use `<cli> run build|test` when the config has `requireRun: true` (`--require-run`) and when you are Codex
  CLI (Codex reports no exit status to hooks).
- Run the build and the full tests again after each change to the tree. A gate counts only at the revision where it
  passed.
- `<cli> status` is read-only. Use it to see why a commit is blocked.

### Commits

- One commit is one command: `git commit -m "..."`, or a quoted heredoc:

  ```sh
  git commit -m "$(cat <<'EOF'
  Fix the parser

  Body text.
  EOF
  )"
  ```

- Do not chain `git add` and `git commit`. Run them as two commands.

### Respect a block

- A block is a decision, not an error to work around. Read the reason and fix the cause.
- Do not bypass a block with a script, a wrapper, a generated file, an alias, `git -c alias.*`, `--no-verify` or
  another git client.
- Do not edit `.git/` (hooks, `.git/stopbar/`), the hook config of any agent (`.claude/`, `.cursor/`, `.codex/`,
  `.gemini/`, `.agents/`) or the Stopbar package.

### Human-only commands

`init`, `upgrade`, `approve-tests`, `approve-shell`, `resume` and `reset` belong to the human. Do not run them, do not
ask a tool or another agent to run them, and do not put them in a script. The hooks block them.

Stop and ask the human when one of these is true:

| State | Cause | What to report | Human command |
|---|---|---|---|
| `testsTainted` | you changed an existing test or test config | the changed test files and why | `stopbar approve-tests` |
| `secretTainted` | you read a secret file or token | the one risky or outbound call you need and why | `stopbar approve-shell` |
| `HALT` | retry limit or tool-call budget reached | the last failing gate and its error, in short | `stopbar resume --extra N` |

Write the report in a few lines, then wait. In `HALT`, only the tools in `config.safeTools` pass (default
`mcp__ccd_turn__*` and `mcp__ccd_session_mgmt__*`); use them to tell the human about the block.

## 2. Writing Zero-FP stateful probes (`stopbar probe`)

A probe runs random multi-step sequences against the system under test (SUT) and compares each step with a model.
Zero-FP means that every failure is a real bug.

### Start

```sh
stopbar probe init --lang ts --name <module>    # writes probes/<module>.probe.ts
stopbar probe init --lang py --name <module>    # writes probes/<module>_probe.py
```

- TS/JS: `defineModel` from `stopbar/probe` (`setup`, `actions` with `gen` and `run`, `invariants`, `mutants`). Run
  with `stopbar probe --target probes/<module>.probe.ts`.
- Python, Go, Rust and other languages: a program that speaks NDJSON on stdin/stdout (`info`, `generate`,
  `execute`). Run with `stopbar probe --cmd "<command>"`. stdout is for the protocol only; print logs to stderr.
  Catch an exception of the SUT in `execute` and answer with a mismatch.

### The 5 Zero-FP rules

1. **Deterministic `gen`.** Draw arguments only from the seeded generator (`r` in TS, the seed in `generate`) and
   return plain JSON data. The same seed gives the same run on every machine.
2. **Independent oracle.** The model is a separate, simple reference (an array, a map, a reference formula) plus
   invariants. Never compare the SUT with itself or with a copy of its own code.
3. **No clock, network or global state.** Write files only in the scratch directory of the run (`dir` in
   `execute`). Reset all state in `setup`.
4. **At least 2 realistic mutants.** Each mutant is a small, real bug (a dropped bound check, an off-by-one). Run
   `stopbar probe ... --check-mutants` and make it pass (exit 0, no survivor) before you increase `--runs`. A
   surviving mutant shows a weak model or weak actions; fix the probe, not the mutant.
5. **Shrink, then reproduce.** On a failure, use the shrunk sequence in `repro-<seed>.json` (in `--out`). Write a
   minimal test that reproduces the bug (less than 25 lines) and look for a known issue or test before you report it.
   Replay the file with `--regressions <dir>` after the fix.

### Before you report a finding

- Make sure that the model, not the SUT, is correct for the failing step. A model error is a false positive: fix the
  model.
- Run the reproduction twice with the same seed. A result that changes is a rule 1 or rule 3 error.

### Evidence

- Run `stopbar probe` in a repository with Stopbar. Each run appends a `probe:result` entry to the event log (target,
  sha256 of the target file, tree snapshot, runs, mutants). Do not pass `--no-record`.
- The human or CI collects the evidence with `stopbar attest --format md` or `--format json`. The `Probe evidence`
  section shows the latest result per target and whether the tree is still the one that was probed.
