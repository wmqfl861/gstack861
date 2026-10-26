import path from 'node:path';
import { canonical, object } from '../json.mjs';
import { evaluate } from '../policy.mjs';

const blocked = code => ({
  output: { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `gstack861:${code}` } },
  exitCode: 2,
});

function alias(event, snake, camel) {
  if (Object.hasOwn(event, snake) && Object.hasOwn(event, camel) && canonical(event[snake]) !== canonical(event[camel])) throw new Error('CONFLICTING_FIELDS');
  return Object.hasOwn(event, snake) ? event[snake] : event[camel];
}

export function handleZcode(event, policy) {
  try {
    if (!object(event) || alias(event, 'hook_event_name', 'hookEventName') !== 'PreToolUse') return blocked('INVALID_EVENT');
    const decision = evaluate(policy, {
      host: 'zcode', tool: alias(event, 'tool_name', 'toolName'),
      input: alias(event, 'tool_input', 'toolInput'), cwd: event.cwd,
    });
    // Abstain, not allow: never pre-approve over the host's own permission gate.
    return decision.decision === 'deny' ? blocked(decision.code) : { output: {}, exitCode: 0 };
  } catch { return blocked('INVALID_EVENT'); }
}

export function zcodeHookConfig({ nodePath, cliPath, policyPath }) {
  if (![nodePath, cliPath, policyPath].every(p => typeof p === 'string' && path.isAbsolute(p))) throw new Error('ABSOLUTE_PATH_REQUIRED');
  return { hooks: { enabled: true, events: { PreToolUse: [{ matcher: '.*', hooks: [{
    type: 'process', command: nodePath,
    args: [cliPath, 'hook', 'zcode', '--policy', policyPath], timeoutMs: 10000,
  }] }] } } };
}

export const denyZcode = blocked;
