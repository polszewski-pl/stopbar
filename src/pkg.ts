// Where the running Stopbar lives. Its code is protected from agent edits (see classify.ts protectedPath).
import {existsSync} from 'node:fs'
import {dirname, join, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'

/** Package root: the directory with bin/, dist/ and package.json (dist/pkg.js -> ..). */
export const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Parts of a Stopbar install that self-protection guards (relative to its root). */
export const CODE_PARTS = ['bin', 'dist', 'src', 'scripts', 'node_modules', 'package.json', 'package-lock.json']

export function codeDirs(): string[] {
  return CODE_PARTS.map((n) => join(PKG_ROOT, n)).filter((p) => existsSync(p))
}
