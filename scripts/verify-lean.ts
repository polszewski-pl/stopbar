// PROVE, Lean gate (release and kernel.ts changes only, not part of `npm test`): exports the full Lean project of the
// proven kernel with gdp-wired's toLean + leanProject and runs `lake build` in the pinned Lean 4.34.0 container with no
// network. Pass: exit 0, 0 errors, 0 `sorry`.
// Usage: node scripts/verify-lean.ts   (after `npm run build` and the one-time image build in docker/lean.Dockerfile)
//        node scripts/verify-lean.ts --local   (no Docker: lean and lake of the pinned toolchain on PATH, as in CI)
import {execFileSync, spawnSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
import {dirname, join, resolve} from 'node:path'
import {fileURLToPath, pathToFileURL} from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const IMAGE = 'stopbar-lean:4.34.0'
const PROJECT = join(ROOT, '.test-out', 'lean-project')
const OUT = join(ROOT, 'results', 'lean')
const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex')

const {kernel, laws, lemmas} = await import(pathToFileURL(join(ROOT, 'dist', 'kernel.js')).href)
const {toLean, leanProject} = await import('gdp-wired/lean')
const r = kernel('none'), {laws: L, stepLaws: S} = laws(r)
const lean: string = toLean([{id: 'stopbar_kernel', machine: r.machine, laws: [...L, ...lemmas(r)], stepLaws: S}], {title: 'Stopbar kernel (gdp-wired 0.60.0)'})
const files: Record<string, string> = leanProject(lean, {name: 'StopbarKernel'})
rmSync(PROJECT, {recursive: true, force: true, maxRetries: 5})
for (const [f, text] of Object.entries(files)) { mkdirSync(dirname(join(PROJECT, f)), {recursive: true}); writeFileSync(join(PROJECT, f), text) }
const leanFiles = Object.keys(files).filter((f) => f.endsWith('.lean') && f !== 'lakefile.lean')
const count = (re: RegExp) => leanFiles.reduce((n, f) => n + (files[f].match(re) ?? []).length, 0)
const project = {
  dir: PROJECT, toolchain: files['lean-toolchain'].trim(), files: Object.keys(files).length, leanFiles: leanFiles.length,
  main: {file: 'StopbarKernel.lean', sha256: sha(files['StopbarKernel.lean']), lines: files['StopbarKernel.lean'].split('\n').length,
    theorems: (files['StopbarKernel.lean'].match(/^\s*theorem\s/gm) ?? []).length},
  theoremsAll: count(/^\s*theorem\s/gm), sorryInSource: count(/\bsorry\b/g),
}
console.log(`Lean project: ${project.files} files (${project.leanFiles} .lean), ${project.toolchain}, StopbarKernel.lean sha256 ${project.main.sha256}, ` +
  `${project.main.theorems} theorems in it, ${project.theoremsAll} in all, sorry in source: ${project.sorryInSource}`)

// --local (CI, no Docker): `lake build` with the lean and lake on PATH (e.g. installed by elan), which must be the
// toolchain the project pins (lean-toolchain); without --local: the pinned container with no network, as before.
const LOCAL = process.argv.includes('--local')
const PINNED = /v?(\d+\.\d+\.\d+)/.exec(project.toolchain)?.[1] ?? project.toolchain
let imageId: string | null = null, archive: string | null = null, leanVersion: string
if (LOCAL) {
  const v = spawnSync('lean', ['--version'], {encoding: 'utf8'})
  if (v.status !== 0) {
    console.error(`--local: no lean on PATH (${v.error?.message ?? (v.stderr || '').trim()}). Install Lean ${PINNED} with elan, or run without --local (Docker)`)
    process.exit(2)
  }
  leanVersion = v.stdout.trim()
  if (!leanVersion.includes(PINNED)) {
    console.error(`--local: ${leanVersion} on PATH, but the project pins ${project.toolchain}`)
    process.exit(2)
  }
} else {
  const img = spawnSync('docker', ['image', 'inspect', '--format', '{{.Id}}', IMAGE], {encoding: 'utf8'})
  if (img.status !== 0) {
    console.error(`no image ${IMAGE}. Build it once (needs the network):\n  docker build -f docker/lean.Dockerfile -t ${IMAGE} docker\nor install Lean ${PINNED} with elan and run: node scripts/verify-lean.ts --local`)
    process.exit(2)
  }
  imageId = img.stdout.trim()
  const inImage = (cmd: string) => execFileSync('docker', ['run', '--rm', '--network', 'none', IMAGE, 'sh', '-c', cmd], {encoding: 'utf8'}).trim()
  leanVersion = inImage('lean --version'); archive = inImage('cat /lean-archive.sha256')
}

const t0 = Date.now()
const run = LOCAL
  ? spawnSync('lake', ['build'], {cwd: PROJECT, encoding: 'utf8', maxBuffer: 256 << 20})
  : spawnSync('docker', ['run', '--rm', '--network', 'none', '-v', `${PROJECT}:/src:ro`, IMAGE], {encoding: 'utf8', maxBuffer: 256 << 20})
const ms = Date.now() - t0
const log = `${run.stdout ?? ''}${run.stderr ?? ''}`
const errors = (log.match(/^.*\berror\b.*$/gim) ?? []).filter((l) => !/0 errors?/i.test(l))
const sorryWarnings = (log.match(/declaration uses 'sorry'/g) ?? []).length
// the generated file prints the axioms of every theorem: only Lean's standard axioms are acceptable, never sorryAx
const axiomLines = log.split('\n').filter((l) => /depends on axioms/.test(l))
const sorryAx = axiomLines.filter((l) => /sorryAx/.test(l)).length
const axioms = [...new Set(axiomLines.flatMap((l) => (/\[(.*)\]/.exec(l)?.[1] ?? '').split(',').map((x) => x.trim()).filter(Boolean)))].sort()
const warnings = (log.match(/warning:/g) ?? []).length
const warningsInMain = log.split('\n').filter((l) => /warning:.*StopbarKernel\.lean/.test(l)).length
const built = /Build completed successfully \((\d+) jobs\)/.exec(log)?.[1]
const res = {mode: LOCAL ? 'local' : 'docker', image: LOCAL ? null : IMAGE, imageId, leanVersion, leanArchive: archive, network: LOCAL ? 'host' : 'none', command: 'lake build', exit: run.status, ms,
  errors: errors.length, sorryWarnings, sorryAx, axiomReports: axiomLines.length, axioms, warnings, warningsInMain, jobs: built ? Number(built) : null, project,
  ok: run.status === 0 && errors.length === 0 && sorryWarnings === 0 && sorryAx === 0 && project.sorryInSource === 0 && !!built}
mkdirSync(OUT, {recursive: true})
writeFileSync(join(OUT, 'lake-build.log'), log)
writeFileSync(join(OUT, 'lean-verify.json'), JSON.stringify(res, null, 1) + '\n')
writeFileSync(join(OUT, 'StopbarKernel.lean'), files['StopbarKernel.lean'])
console.log(`lake build: exit ${run.status}, ${(ms / 1000).toFixed(1)} s, errors ${errors.length}, sorry warnings ${sorryWarnings}, sorryAx ${sorryAx} in ${axiomLines.length} axiom reports (axioms: ${axioms.join(', ')}), ${built} jobs, ${warnings} warnings (${warningsInMain} in StopbarKernel.lean) (${leanVersion}, ${imageId ? `image ${imageId.slice(0, 19)}` : 'local lake'})`)
console.log(`LEAN ${res.ok ? 'PASS' : 'FAIL'}`)
if (!res.ok) console.log(errors.slice(0, 20).join('\n'))
process.exitCode = res.ok ? 0 : 1
