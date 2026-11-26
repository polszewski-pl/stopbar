// A PROBE target for any TS/JS project: a FIFO queue with a fixed capacity, checked step by step against a plain array.
// Run: stopbar probe --target examples/bounded-queue.probe.ts --runs 200 --check-mutants
// Each mutant is a damaged queue; --check-mutants passes only when the prober catches every one of them.
import {defineModel} from 'stopbar/probe'

/** The system under test. In a real project you import your own class instead. */
export class BoundedQueue<T> {
  items: T[] = []
  capacity: number
  opts: {checkCap?: boolean; lifo?: boolean}
  constructor(capacity: number, opts: {checkCap?: boolean; lifo?: boolean} = {}) { this.capacity = capacity; this.opts = opts }
  /** Adds `x` at the end; false (and no change) when the queue is full. */
  push(x: T): boolean {
    if ((this.opts.checkCap ?? true) && this.items.length >= this.capacity) return false
    this.items.push(x)
    return true
  }
  /** Removes and returns the oldest item (undefined when empty). */
  shift(): T | undefined { return this.opts.lifo ? this.items.pop() : this.items.shift() }
  peek(): T | undefined { return this.opts.lifo ? this.items.at(-1) : this.items[0] }
  get size(): number { return this.items.length }
}

const CAP = 4
type State = {q: BoundedQueue<number>; model: number[]}
const fresh = (opts?: {checkCap?: boolean; lifo?: boolean}): State => ({q: new BoundedQueue<number>(CAP, opts), model: []})

export default defineModel<State>({
  name: 'bounded-queue',
  description: `FIFO queue with capacity ${CAP} vs an array model`,
  minSteps: 10,
  maxSteps: 30,
  setup: () => fresh(),
  actions: [
    {
      name: 'push', weight: 3,
      gen: (r) => ({x: r.int(0, 99)}),
      run: (s, {x}, check) => {
        const accepted = s.model.length < CAP
        check.eq('push result', s.q.push(x), accepted)
        if (accepted) s.model.push(x)
      },
    },
    {
      name: 'shift', weight: 2,
      gen: () => null,
      run: (s, _args, check) => check.eq('shift result', s.q.shift(), s.model.shift()),
    },
    {
      name: 'peek',
      gen: () => null,
      run: (s, _args, check) => check.eq('peek result', s.q.peek(), s.model[0]),
    },
  ],
  invariants: [
    {name: 'size', check: (s, check) => check.eq('size', s.q.size, s.model.length)},
    (s, check) => check.ok('size within capacity', s.q.size <= CAP, s.q.size, `<= ${CAP}`),
  ],
  mutants: {
    M1_dropCap: {description: 'push ignores the capacity', setup: () => fresh({checkCap: false})},
    M2_lifoInsteadOfFifo: {description: 'shift and peek take the newest item', setup: () => fresh({lifo: true})},
  },
})
