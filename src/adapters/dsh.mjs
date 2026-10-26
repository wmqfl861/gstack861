import { loadPolicy, evaluate } from '../policy.mjs';

export const name = 'gstack861-guard';
export const inject = ['tools'];

/** Native Cordis plugin; guard contract pinned in upstream.lock.json. */
export function apply(ctx, config) {
  if (typeof ctx?.tools?.guard !== 'function') throw new Error('DSH_MONOTONIC_GUARD_REQUIRED');
  if (typeof config?.policyPath !== 'string') throw new Error('POLICY_PATH_REQUIRED');
  const policyPath = config.policyPath;
  loadPolicy(policyPath); // invalid policy fails activation, not a silent no-op
  return ctx.tools.guard(exec => {
    try {
      if (exec?.signal?.aborted) return 'gstack861:CANCELLED';
      // Absolute tool paths only until live Session cwd semantics are certified.
      const result = evaluate(loadPolicy(policyPath), { host: 'dsh', tool: exec?.name, input: exec?.arguments });
      return result.decision === 'deny' ? `gstack861:${result.code}` : undefined;
    } catch { return 'gstack861:POLICY_UNAVAILABLE'; }
  });
}
