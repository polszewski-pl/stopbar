// Claude Code: the payload already is the internal event (v1.0 behaviour, unchanged).
// Output: exit 0 allows, exit 2 blocks; the reason goes to stderr (stdout for exit 0 messages).
import type {Adapter, Internal, Kind} from './types.ts'

const KIND: Record<string, Kind> = {PreToolUse: 'pre-tool', PostToolUse: 'post-tool', PostToolUseFailure: 'post-tool-failure', Stop: 'stop'}

export const claude: Adapter = {
  name: 'claude',
  detect: (i) => typeof i.hook_event_name === 'string',
  normalize(i) {
    const kind = KIND[i.hook_event_name] ?? 'other'
    return {kind, event: kind === 'other' ? null : (i as Internal)}
  },
  render(_kind, out) {
    if (!out.msg) return {code: out.code}
    return out.code === 0 ? {code: 0, stdout: out.msg + '\n'} : {code: out.code, stderr: out.msg + '\n'}
  },
}
