import { createHash } from 'node:crypto';

export function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

/** Stable, finite JSON only; prevents ambiguous approval/config fingerprints. */
export function canonical(value, seen = new Set(), depth = 0) {
  if (depth > 64) throw new Error('JSON_TOO_DEEP');
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (!Array.isArray(value) && !object(value)) throw new Error('NOT_JSON');
  if (seen.has(value)) throw new Error('CYCLIC_JSON');
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      // A hole plus an unrelated property can have the same key count as length.
      // Require the exact dense index set; otherwise [<hole>] could hash like [].
      const keys = Object.keys(value);
      if (keys.length !== value.length || keys.some((key, index) => key !== String(index))) throw new Error('SPARSE_ARRAY');
      return `[${value.map(v => canonical(v, seen, depth + 1)).join(',')}]`;
    }
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k], seen, depth + 1)}`).join(',')}}`;
  } finally { seen.delete(value); }
}

export const digest = value => createHash('sha256').update(canonical(value)).digest('hex');
export const textDigest = value => createHash('sha256').update(value).digest('hex');

export function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
