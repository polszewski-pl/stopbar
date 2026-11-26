#!/usr/bin/env python3
# A PROBE target in Python: the same FIFO queue as bounded-queue.probe.ts (capacity 4, a list as the model, the same
# invariants and mutants), driven over the NDJSON protocol of --cmd. Standard library only.
# Run: stopbar probe --cmd "python examples/bounded_queue_probe.py" --runs 200 --check-mutants
import json
import random
import sys

CAP = 4
MUTANTS = {"M1_dropCap": {"check_cap": False}, "M2_lifoInsteadOfFifo": {"lifo": True}}


class BoundedQueue:
    """The system under test. In a real project you import your own class instead."""

    def __init__(self, capacity, check_cap=True, lifo=False):
        self.items, self.capacity, self.check_cap, self.lifo = [], capacity, check_cap, lifo

    def push(self, x):  # adds x at the end; False (and no change) when the queue is full
        if self.check_cap and len(self.items) >= self.capacity:
            return False
        self.items.append(x)
        return True

    def shift(self):  # removes and returns the oldest item (None when empty)
        return (self.items.pop() if self.lifo else self.items.pop(0)) if self.items else None

    def peek(self):
        return (self.items[-1] if self.lifo else self.items[0]) if self.items else None


class Mismatch(Exception):  # args: what, expected, actual
    pass


def eq(what, actual, expected):
    if actual != expected:
        raise Mismatch(what, expected, actual)


def generate(seed):
    r = random.Random(seed)
    names = r.choices(["push", "shift", "peek"], weights=[3, 2, 1], k=r.randint(10, 30))
    return {"seed": seed, "actions": [{"t": "push", "args": {"x": r.randint(0, 99)}} if t == "push" else {"t": t, "args": None} for t in names]}


def invariants(q, model):
    eq("invariant size: size", len(q.items), len(model))
    if len(q.items) > CAP:
        raise Mismatch("size within capacity", "<= %d" % CAP, len(q.items))


def execute(run, mutant=None):
    step, action, cov = -1, None, {}
    try:
        if mutant is not None and mutant not in MUTANTS:
            raise Mismatch("unknown mutant", list(MUTANTS), mutant)
        q, model = BoundedQueue(CAP, **MUTANTS.get(mutant, {})), []
        invariants(q, model)
        for step, action in enumerate(run["actions"]):
            t = action.get("t")
            cov[t] = cov.get(t, 0) + 1
            if t == "push":
                accepted = len(model) < CAP
                eq("push result", q.push(action["args"]["x"]), accepted)
                if accepted:
                    model.append(action["args"]["x"])
            elif t == "shift":
                eq("shift result", q.shift(), model.pop(0) if model else None)
            elif t == "peek":
                eq("peek result", q.peek(), model[0] if model else None)
            else:
                raise Mismatch("unknown action", ["push", "shift", "peek"], action)
            invariants(q, model)
    except Mismatch as m:
        return {"ok": False, "mismatch": {"step": step, "action": action, "what": m.args[0], "expected": m.args[1], "actual": m.args[2]}}
    except Exception as e:  # a crash of the code under test is a finding, not a protocol error
        return {"ok": False, "mismatch": {"step": step, "action": action, "what": "exception", "expected": "no error", "actual": "%s: %s" % (type(e).__name__, e)}}
    return {"ok": True, "steps": len(run["actions"]), "cov": cov}


INFO = {"name": "bounded-queue-py", "description": "FIFO queue with capacity %d vs a list model (Python)" % CAP, "mutants": list(MUTANTS)}
OPS = {"info": lambda req: INFO, "generate": lambda req: generate(req["seed"]), "execute": lambda req: execute(req["run"], req.get("mutant"))}
for line in iter(sys.stdin.readline, ""):  # one request per line, one answer per line, until stdin closes
    if line.strip():
        req = json.loads(line)
        res = OPS[req["op"]](req) if req.get("op") in OPS else {"error": "unknown op %r" % req.get("op")}
        sys.stdout.write(json.dumps(res) + "\n")
        sys.stdout.flush()
