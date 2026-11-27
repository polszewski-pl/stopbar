# PROBE for your project

PROBE is the test tool of the Stopbar package: stateful probing of your own code against a model, with mutants that
must be caught. Back to the [README](../README.md).

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

A complete example with two mutants: [`examples/bounded-queue.probe.ts`](../examples/bounded-queue.probe.ts)
(`stopbar probe --target examples/bounded-queue.probe.ts --check-mutants`). TypeScript files need Node's type
stripping (Node 22.18 or later): only erasable syntax, no `enum` and no constructor parameter properties.

`import {defineModel} from 'stopbar/probe'` resolves to the SDK of the Stopbar that runs `stopbar probe`, also when
the project has no `stopbar` in its `node_modules` (a global install, `npx`, a copy elsewhere): since 1.2.2 the probe
runner registers a module resolve hook (`registerHooks` from `node:module`) for that one specifier, in the runner and in
every worker. An editor or `tsc` still needs `stopbar` in the project for the types (`npm install --save-dev stopbar`).

## Any language: `--cmd`

`stopbar probe --cmd "<command>"` probes a program in any language (Python, Go, Rust, ...). Each worker (`--jobs`)
starts the command once, in a shell, in the current directory, and keeps it for all its runs, so the start-up cost
is paid once per worker and not once per seed. Stopbar sends one JSON object per line on stdin and reads one answer
per line on stdout (NDJSON):

| Request | Answer |
|---|---|
| `{"op":"info"}` | `{"name":"<string>","description":"<string>","mutants":["M1",...]}` (`mutants` is optional) |
| `{"op":"generate","seed":123}` | `{"seed":123,"actions":[...]}`: pure JSON data, the same for the same seed |
| `{"op":"execute","run":{"seed":123,"actions":[...]},"dir":"<scratch dir>","mutant":"M1"}` | `{"ok":true,"steps":N,"cov":{"push":3}}` or `{"ok":false,"mismatch":{"step":2,"action":{...},"what":"...","expected":...,"actual":...}}` |

- `mutant` is sent only with `--check-mutants`. `dir` is an empty scratch directory for each execution.
- Any answer can be `{"error":"<text>"}`. stdout is for the protocol only: print logs to stderr.
- An exception of the code under test is a finding: catch it in `execute` and answer with a mismatch (the
  templates do this). A process that exits, closes stdout, prints a line that is not JSON or gives no answer within
  `--cmd-timeout` ms (default 300000) stops the probe with exit 1 and the end of its stderr. When the probe ends,
  Stopbar closes stdin; a process that does not exit within 2 s is killed.
- Shrinking, `--regressions` / `--regressions-only`, `--check-mutants`, `summary.json`, `repro-<seed>.json`,
  `probe:result` and `attest` work as for `--target <file>`. `target` in a reproduction is the `name` from `info`;
  `targetCmd` is the command. A `--cmd` target replays only the regressions in `--regressions <dir>`.
- `targetSha256` is the sha256 of `--target-file <path>`, else of the first word after the interpreter that is an
  existing file (`python examples/bounded_queue_probe.py` hashes that file), else `null`.

[`examples/bounded_queue_probe.py`](../examples/bounded_queue_probe.py) is the same queue model in Python, with the
standard library only:

```sh
stopbar probe --cmd "python examples/bounded_queue_probe.py" --runs 200 --check-mutants
```

## A starter target: `stopbar probe init`

`stopbar probe init --lang ts` writes `probes/sample.probe.ts` (`defineModel`), and `--lang py` writes
`probes/sample_probe.py` (the NDJSON protocol, standard library only: `json`, `random`, `sys`). Both hold the same
model with 2 actions, 1 invariant, 2 mutants and the rules for zero false positives, and `--check-mutants` passes on
them as written. The command prints the line that runs the file. `--name` takes letters, digits, `-` and `_` only;
`--out` (default `probes`) is relative to `--repo`, else to the current directory; an existing file stays unless you
pass `--force`.
