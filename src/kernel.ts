// Stopbar kernel: the decision rule of the hooks, deterministic, in the gdp-wired 0.60.0 DSL.
//
// An action is one request with an `op` field. The wrapper supplies the classes deterministically:
//   suspicious  - EDIT_TEST / SHELL that changes the tree: a change of an existing test or of test config
//   risky       - SHELL: risky or outbound (true) or safe and local (false)
//   treeChanged - SHELL: the wrapper sees a different git tree hash after the call (e.g. `sed -i`)
//   approveRev  - APPROVE_TESTS: the tree revision whose accumulated test changes a human reviewed
//
// The g* fields are ghost variables: the SPECIFICATION keeps them, not the implementation. Mutants change only the
// implementation, so the laws over g* do not repeat the COMMIT condition (no tautology).
import {bool, max, nat, no, oneOf, rule, when, yes} from 'gdp-wired'

// APPROVE_TESTS and APPROVE_SHELL are a full no-op in the halted state (step law L4.4, mutant M7).
export const MUTANTS = ['none', 'M1a', 'M1b', 'M2', 'M3', 'M3b', 'M4', 'M4b', 'M5', 'M6', 'M7'] as const
export type Mutant = (typeof MUTANTS)[number]

const OPS = ['EDIT_CODE', 'EDIT_TEST', 'RUN_BUILD', 'RUN_TESTS', 'READ_SECRET', 'SHELL',
  'APPROVE_TESTS', 'APPROVE_SHELL', 'RESUME', 'COMMIT'] as const

export function kernel(m: Mutant = 'none') {
  return rule(`stopbar_kernel_${m}`)
    .params({maxRetries: nat, cap: nat})
    .pre(({maxRetries, cap}) => maxRetries.atLeast(1).and(cap.atLeast(1)))
    .inputs({op: oneOf(...OPS), cost: nat, passed: bool, fullSuite: bool, suspicious: bool, risky: bool,
      treeChanged: bool, approveRev: nat, extra: nat})
    // human actions cost nothing (only agent actions count against the budget)
    .assume(({op, cost}) => op.is('APPROVE_TESTS').or(op.is('APPROVE_SHELL'), op.is('RESUME')).implies(cost.eq(0)))
    .state({
      // implementation
      treeRev: 1, buildOkRev: 0, testsOkRev: 0,
      testsTainted: bool.from(false), secretTainted: bool.from(false), shellToken: bool.from(false),
      buildFails: 0, testFails: 0, spent: 0, capNow: ({cap}) => cap,
      halted: bool.from(false), decision: oneOf('ALLOW', 'BLOCK', 'PAUSE').from('ALLOW'), commitExecuted: bool.from(false),
      // ghost (specification)
      gRev: 1, gBuildOk: bool.from(false), gTestsOk: bool.from(false), gMaxSusp: 0, gMaxAppr: 0,
      gBuildFails: 0, gTestFails: 0,
    })
    .step((e) => {
      const {op, cost, passed, fullSuite, suspicious, risky, treeChanged, approveRev, extra, maxRetries} = e
      const human = op.is('APPROVE_TESTS').or(op.is('APPROVE_SHELL'), op.is('RESUME'))
      const agent = human.not()
      const overBudget = agent.and(e.capNow.atMost(e.spent.plus(cost)))
      const exec = agent.and(e.halted.not(), overBudget.not())

      // --- specification: what changes the tree and what is a gate run (never mutated)
      const specTreeEdit = exec.and(op.is('EDIT_CODE').or(op.is('EDIT_TEST'), op.is('SHELL').and(treeChanged)))
      const specSuspEdit = exec.and(op.is('EDIT_TEST').or(op.is('SHELL').and(treeChanged)), suspicious)
      const build = exec.and(op.is('RUN_BUILD'))
      const tests = exec.and(op.is('RUN_TESTS'))
      const specFullPass = tests.and(passed, fullSuite)

      // --- implementation (the mutants act here)
      const treeEdit = m === 'M1a' ? exec.and(op.is('EDIT_CODE').or(op.is('EDIT_TEST'))) : specTreeEdit
      const fullPass = m === 'M1b' ? tests.and(passed) : specFullPass
      const testFail = tests.and(passed.not())
      const buildPass = build.and(passed)
      const buildFail = build.and(passed.not())
      const awake = e.halted.not() // human approvals act only outside the halted state
      const approveT = m === 'M6' ? op.is('APPROVE_TESTS').and(awake) : op.is('APPROVE_TESTS').and(approveRev.eq(e.treeRev), awake)
      const grantShell = m === 'M7' ? op.is('APPROVE_SHELL') : op.is('APPROVE_SHELL').and(awake) // M7: token also when halted
      const riskyShell = exec.and(op.is('SHELL'), risky)
      const needPause = m === 'M3b' ? no : riskyShell.and(e.secretTainted, e.shellToken.not())
      const commitOk = exec.and(op.is('COMMIT'), e.buildOkRev.eq(e.treeRev), e.testsOkRev.eq(e.treeRev), e.testsTainted.not())

      const testReset = m === 'M4' ? fullPass.or(buildPass) : m === 'M4b' ? fullPass.or(tests.and(passed)) : fullPass
      const testFailsNext = when(op.is('RESUME'), 0, when(testReset, 0, when(testFail, e.testFails.plus(1), e.testFails)))
      const buildFailsNext = when(op.is('RESUME'), 0, when(buildPass, 0, when(buildFail, e.buildFails.plus(1), e.buildFails)))
      const loopHalt = testFail.and(maxRetries.atMost(testFailsNext)).or(buildFail.and(maxRetries.atMost(buildFailsNext)))
      const haltedNext = when(op.is('RESUME'), no, e.halted.or(overBudget, loopHalt))

      const taintClear = m === 'M2' ? approveT.or(fullPass) : approveT
      const secretNext = m === 'M3' ? when(exec.and(op.is('EDIT_CODE')), no, e.secretTainted.or(exec.and(op.is('READ_SECRET'))))
        : e.secretTainted.or(exec.and(op.is('READ_SECRET')))
      const approveVisible = m === 'M5' ? no : e.halted // M5: a test approval lifts PAUSE in the halted state

      const ALLOW = e.decision.of('ALLOW'), BLOCK = e.decision.of('BLOCK'), PAUSE = e.decision.of('PAUSE')
      const decision = when(op.is('RESUME'), ALLOW,
        when(approveVisible, PAUSE,
          when(op.is('APPROVE_TESTS'), when(approveT, ALLOW, BLOCK),
            when(op.is('APPROVE_SHELL'), ALLOW,
              when(overBudget.or(loopHalt, specSuspEdit, needPause), PAUSE,
                when(op.is('COMMIT'), when(commitOk, ALLOW, BLOCK), ALLOW))))))

      return {
        treeRev: when(treeEdit, e.treeRev.plus(1), e.treeRev),
        buildOkRev: when(buildPass, e.treeRev, when(buildFail, 0, e.buildOkRev)),
        testsOkRev: when(fullPass, e.treeRev, when(testFail, 0, e.testsOkRev)),
        testsTainted: when(specSuspEdit, yes, when(taintClear, no, e.testsTainted)),
        secretTainted: secretNext,
        shellToken: when(grantShell, yes, when(riskyShell.and(e.secretTainted), no, e.shellToken)),
        buildFails: buildFailsNext,
        testFails: testFailsNext,
        spent: when(agent.and(e.halted.not()), e.spent.plus(cost), e.spent),
        capNow: when(op.is('RESUME'), e.capNow.plus(extra), e.capNow),
        halted: haltedNext,
        decision,
        commitExecuted: commitOk,
        // ghost
        gRev: when(specTreeEdit, e.gRev.plus(1), e.gRev),
        gBuildOk: when(specTreeEdit, no, when(build, passed, e.gBuildOk)),
        gTestsOk: when(specTreeEdit, no, when(specFullPass, yes, when(tests.and(passed.not()), no, e.gTestsOk))),
        gMaxSusp: when(specSuspEdit, max(e.gMaxSusp, e.gRev.plus(1)), e.gMaxSusp),
        gMaxAppr: when(op.is('APPROVE_TESTS').and(approveRev.atMost(e.gRev), e.halted.not()), max(e.gMaxAppr, approveRev), e.gMaxAppr),
        gBuildFails: when(op.is('RESUME'), 0, when(build.and(passed), 0, when(build.and(passed.not()), e.gBuildFails.plus(1), e.gBuildFails))),
        gTestFails: when(op.is('RESUME'), 0, when(specFullPass, 0, when(tests.and(passed.not()), e.gTestFails.plus(1), e.gTestFails))),
      }
    })
}

type K = ReturnType<typeof kernel>

// Inductive lemmas: the simulation relation between the implementation and the ghosts. They add no requirement;
// they strengthen the induction (the prover does not find them on its own).
export function lemmas(r: K) {
  return [
    r.law('I1 tree revision starts at 1 and the ghost follows it', ({treeRev, gRev}) => treeRev.atLeast(1).and(gRev.eq(treeRev))),
    r.law('I2 a build verified at the current revision means the spec saw a passing build since the last tree change',
      ({buildOkRev, treeRev, gBuildOk}) => buildOkRev.atMost(treeRev).and(buildOkRev.eq(treeRev).implies(gBuildOk))),
    r.law('I3 a suite verified at the current revision means the spec saw a full passing suite since the last tree change',
      ({testsOkRev, treeRev, gTestsOk}) => testsOkRev.atMost(treeRev).and(testsOkRev.eq(treeRev).implies(gTestsOk))),
    r.law('I4 suspicious edits never exceed the current revision; clean tests mean they are all approved',
      ({gMaxSusp, gMaxAppr, gRev, testsTainted}) => gMaxSusp.atMost(gRev).and(gMaxAppr.atMost(gRev), testsTainted.not().implies(gMaxSusp.atMost(gMaxAppr)))),
    r.law('I5 failure counters equal their ghosts', ({testFails, gTestFails, buildFails, gBuildFails}) =>
      testFails.eq(gTestFails).and(buildFails.eq(gBuildFails))),
  ]
}

export function laws(r: K) {
  return {
    laws: [
      r.law('L1 commit only after build ok and full suite ok since last tree change',
        ({commitExecuted, gBuildOk, gTestsOk}) => commitExecuted.implies(gBuildOk.and(gTestsOk))),
      r.law('L2.1 commit only when every suspicious test edit is covered by a human approval',
        ({commitExecuted, gMaxSusp, gMaxAppr}) => commitExecuted.implies(gMaxSusp.atMost(gMaxAppr))),
      r.law('L4.3a maxRetries consecutive failed test runs without a full pass halt the session',
        ({gTestFails, maxRetries, halted}) => maxRetries.atMost(gTestFails).implies(halted)),
      r.law('L4.3b maxRetries consecutive failed builds halt the session',
        ({gBuildFails, maxRetries, halted}) => maxRetries.atMost(gBuildFails).implies(halted)),
    ],
    stepLaws: [
      r.stepLaw('L2.2 taint survives every action except a human test approval (RUN_TESTS full pass included)',
        (b, a) => b.testsTainted.and(b.op.is('APPROVE_TESTS').not()).implies(a.testsTainted)),
      r.stepLaw('L3.1 secretTainted is monotone',
        (b, a) => b.secretTainted.implies(a.secretTainted)),
      r.stepLaw('L3.2 exfiltration gate: risky shell after a secret read pauses unless a one-time human approval is held',
        (b, a) => b.secretTainted.and(b.op.is('SHELL'), b.risky, b.shellToken.not()).implies(a.decision.is('PAUSE'))),
      r.stepLaw('L3.3 the one-time shell approval is used up by the risky call it allows',
        (b, a) => b.secretTainted.and(b.op.is('SHELL'), b.risky, b.halted.not(), b.spent.plus(b.cost).lt(b.capNow)).implies(a.shellToken.not())),
      r.stepLaw('L4.1 halted: only RESUME unblocks; no ALLOW/BLOCK, no commit',
        (b, a) => b.halted.and(b.op.is('RESUME').not()).implies(a.halted.and(a.decision.is('PAUSE'), a.commitExecuted.not()))),
      r.stepLaw('L4.4 halted: no action but RESUME changes the key state fields',
        (b, a) => b.halted.and(b.op.is('RESUME').not()).implies(
          a.testsTainted.iff(b.testsTainted).and(a.shellToken.iff(b.shellToken), a.treeRev.eq(b.treeRev),
            a.buildOkRev.eq(b.buildOkRev), a.testsOkRev.eq(b.testsOkRev), a.buildFails.eq(b.buildFails),
            a.testFails.eq(b.testFails), a.spent.eq(b.spent), a.capNow.eq(b.capNow)))),
      r.stepLaw('L4.2 reaching the budget cap halts at once',
        (b, a) => b.op.is('APPROVE_TESTS').or(b.op.is('APPROVE_SHELL'), b.op.is('RESUME')).not()
          .and(b.capNow.atMost(b.spent.plus(b.cost))).implies(a.halted)),
    ],
  }
}
