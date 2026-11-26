// Types of dist/kernel.gen.js, which scripts/build.ts generates from src/kernel.ts with gdp-wired's compileJs.
// For `npm run typecheck` only: the build skips .d.ts files and the generated step function stays as compileJs wrote it.
export type CodecField = {name: string; kind: 'oneOf' | 'bool' | 'nat'; values?: string[]}
export type MachineState = {scalars: Record<string, number>; maps: Record<string, unknown>; defaults?: Record<string, unknown>}

export const MACHINE_NAME: string
export const KERNEL_SOURCE_SHA256: string
export const MACHINE_SHA256: string
export const CODEC: {inputs: CodecField[]; state: CodecField[]}
export function init(params: Record<string, number>): MachineState
export function fork(state: MachineState): MachineState
export function step(params: Record<string, number>, state: MachineState, input: Record<string, number>): MachineState
