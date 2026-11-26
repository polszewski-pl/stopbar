// stopbar probe init: writes a starter PROBE target, in TypeScript (defineModel from 'stopbar/probe') or in Python
// (the NDJSON protocol of --cmd, standard library only). Both hold the same model with 2 actions, 1 invariant and
// 2 mutants, so `--check-mutants` passes on the template as written.
import {existsSync, mkdirSync, writeFileSync} from 'node:fs'
import {isAbsolute, join, relative, resolve} from 'node:path'
import {ProbeError} from './stdio.ts'

export type InitOptions = {lang?: string; name?: string; out?: string; force?: boolean; repo?: string; cwd?: string}
export type InitResult = {file: string; lang: 'ts' | 'py'; command: string; message: string}

const NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/

const ZERO_FP = String.raw`Zero false positives: a failure must always be a real bug.
  1. gen draws its arguments only from the seeded random numbers and returns plain JSON data:
     the same seed gives the same run on every machine.
  2. The model is the oracle: compare the system with the model, never with itself.
  3. No clock, network or shared global state; files only under the scratch directory of the run.
  4. A mutant is a small, real bug; --check-mutants passes only when the prober catches every one.`

const TS = String.raw`// PROBE target __NAME__, written by 'stopbar probe init'. Run it:
//   __RUN__
// Replace UniqueList with an import of your own code, keep the model (a plain array) and add actions.
__ZERO_FP__
import {defineModel} from 'stopbar/probe'

type Bug = '' | 'dupes' | 'noRemove'

/** The system under test: a list of numbers without duplicates. */
class UniqueList {
  items: number[] = []
  bug: Bug
  constructor(bug: Bug = '') { this.bug = bug }
  /** Adds x unless it is already there; true if it was added. */
  add(x: number): boolean {
    if (this.bug !== 'dupes' && this.items.includes(x)) return false
    this.items.push(x)
    return true
  }
  /** Removes x; true if it was there. */
  remove(x: number): boolean {
    const i = this.items.indexOf(x)
    if (i < 0) return false
    if (this.bug !== 'noRemove') this.items.splice(i, 1)
    return true
  }
}

type State = {list: UniqueList; model: number[]}
const fresh = (bug: Bug = ''): State => ({list: new UniqueList(bug), model: []})

export default defineModel<State>({
  name: '__NAME__',
  description: 'a list without duplicates vs an array model',
  minSteps: 10,
  maxSteps: 30,
  setup: () => fresh(),
  actions: [
    {
      name: 'add', weight: 2,
      gen: (r) => r.int(0, 9),
      run: (s, x: number, check) => {
        const expected = !s.model.includes(x)
        check.eq('add result', s.list.add(x), expected)
        if (expected) s.model.push(x)
      },
    },
    {
      name: 'remove',
      gen: (r) => r.int(0, 9),
      run: (s, x: number, check) => {
        const i = s.model.indexOf(x)
        check.eq('remove result', s.list.remove(x), i >= 0)
        if (i >= 0) s.model.splice(i, 1)
      },
    },
  ],
  invariants: [{name: 'contents', check: (s, check) => check.eq('contents', s.list.items, s.model)}],
  mutants: {
    M1_allowDuplicates: {description: 'add accepts a value that is already there', setup: () => fresh('dupes')},
    M2_removeKeeps: {description: 'remove reports success but keeps the value', setup: () => fresh('noRemove')},
  },
})
`

const PY = String.raw`#!/usr/bin/env python3
# PROBE target __NAME__, written by 'stopbar probe init'. Run it:
#   __RUN__
# It speaks NDJSON on stdin/stdout, one JSON object per line: info, generate, execute (stdout is for the protocol
# only; print logs to stderr). Standard library only. Replace UniqueList with an import of your own code, keep the
# model (a plain list) and add actions.
__ZERO_FP__
import json
import random
import sys

NAME = "__NAME__"
BUGS = {None: "", "M1_allowDuplicates": "dupes", "M2_removeKeeps": "noRemove"}


class UniqueList:
    """The system under test: a list of numbers without duplicates."""

    def __init__(self, bug=""):
        self.items, self.bug = [], bug

    def add(self, x):
        if self.bug != "dupes" and x in self.items:
            return False
        self.items.append(x)
        return True

    def remove(self, x):
        if x not in self.items:
            return False
        if self.bug != "noRemove":
            self.items.remove(x)
        return True


class Mismatch(Exception):
    def __init__(self, what, expected, actual):
        super().__init__(what)
        self.what, self.expected, self.actual = what, expected, actual


def eq(what, actual, expected):
    if actual != expected:
        raise Mismatch(what, expected, actual)


def generate(seed):
    r = random.Random(seed)
    names = r.choices(["add", "remove"], weights=[2, 1], k=r.randint(10, 30))
    return {"seed": seed, "actions": [{"t": t, "args": r.randint(0, 9)} for t in names]}


def execute(run, mutant=None):
    step, action, cov = -1, None, {}
    try:
        if mutant not in BUGS:
            raise Mismatch("unknown mutant", [m for m in BUGS if m], mutant)
        lst, model = UniqueList(BUGS[mutant]), []
        eq("invariant contents: contents", lst.items, model)
        for step, action in enumerate(run["actions"]):
            t, x = action.get("t"), action.get("args")
            if t == "add":
                expected = x not in model
                eq("add result", lst.add(x), expected)
                if expected:
                    model.append(x)
            elif t == "remove":
                there = x in model
                eq("remove result", lst.remove(x), there)
                if there:
                    model.remove(x)
            else:
                raise Mismatch("unknown action", ["add", "remove"], action)
            cov[t] = cov.get(t, 0) + 1
            eq("invariant contents: contents", lst.items, model)
    except Mismatch as m:
        return {"ok": False, "mismatch": {"step": step, "action": action, "what": m.what, "expected": m.expected, "actual": m.actual}}
    except Exception as e:  # a crash of the code under test is a finding, not a protocol error
        return {"ok": False, "mismatch": {"step": step, "action": action, "what": "exception", "expected": "no error", "actual": "%s: %s" % (type(e).__name__, e)}}
    return {"ok": True, "steps": len(run["actions"]), "cov": cov}


def main():
    for line in iter(sys.stdin.readline, ""):
        if not line.strip():
            continue
        req = json.loads(line)
        op = req.get("op")
        if op == "info":
            res = {"name": NAME, "description": "a list without duplicates vs a list model", "mutants": [m for m in BUGS if m]}
        elif op == "generate":
            res = generate(req["seed"])
        elif op == "execute":
            res = execute(req["run"], req.get("mutant"))
        else:
            res = {"error": "unknown op %r" % op}
        sys.stdout.write(json.dumps(res) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
`

/** A path for the printed command: relative to `cwd` when inside it, with forward slashes. */
function shown(file: string, cwd: string): string {
  const r = relative(cwd, file)
  return (r && !r.startsWith('..') && !isAbsolute(r) ? r : file).replace(/\\/g, '/')
}

export function initProbe(o: InitOptions = {}): InitResult {
  const lang = o.lang ?? 'ts'
  if (lang !== 'ts' && lang !== 'py') throw new ProbeError(`probe init: --lang must be ts or py, got ${JSON.stringify(lang)}`)
  const name = o.name ?? 'sample'
  if (!NAME.test(name)) throw new ProbeError(`probe init: --name ${JSON.stringify(name)} must start with a letter and hold only letters, digits, - and _ (at most 64), no path`)
  const cwd = o.cwd ?? process.cwd()
  const base = o.repo ? resolve(cwd, o.repo) : cwd
  const dir = resolve(base, o.out ?? 'probes')
  const file = join(dir, lang === 'ts' ? `${name}.probe.ts` : `${name}_probe.py`)
  if (existsSync(file) && !o.force) throw new ProbeError(`probe init: ${file} exists; pass --force to overwrite it`)
  const py = process.platform === 'win32' ? 'python' : 'python3'
  const command = lang === 'ts'
    ? `stopbar probe --target ${shown(file, cwd)} --check-mutants`
    : `stopbar probe --cmd "${py} ${shown(file, cwd)}" --check-mutants`
  const text = (lang === 'ts' ? TS : PY)
    .replace('__ZERO_FP__', ZERO_FP.split('\n').map((l) => (lang === 'ts' ? '// ' : '# ') + l).join('\n'))
    .replaceAll('__NAME__', name).replace('__RUN__', command)
  mkdirSync(dir, {recursive: true})
  writeFileSync(file, text)
  const needs = lang === 'ts' ? `\n  (needs stopbar in the project, so that 'stopbar/probe' resolves: npm install --save-dev stopbar)` : ''
  return {file, lang, command, message: `wrote ${file}\nrun it:\n  ${command}${needs}`}
}
