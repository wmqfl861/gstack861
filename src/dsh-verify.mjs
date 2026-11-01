import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inspectPlainPath, readPlainFile } from './fs-utils.mjs';
import { loadPolicy } from './policy.mjs';
import { loadRegistry } from './install.mjs';
import { textDigest } from './json.mjs';

const fail = code => { throw new Error(code); };
const PLUGIN_IDS = ['gstack861-guard', 'gstack861-skills'];

/**
 * Read-only readiness aggregation for a generated DSH profile.
 *
 * This is the product-side readiness gate promised by the acceptance handoff:
 * it checks the actual dependency surface a managed launch needs (structure,
 * shim binding, compilable policy, untampered skills) without launching the
 * host, installing packages, dispatching tools, or executing any code from the
 * profile directory. A host process exiting 0 is never readiness evidence;
 * conversely this command alone does not prove host activation.
 */
export function verifyDshProfile({ output, policyPath, adapterPath, skillsDir }) {
  const checks = [];
  const check = (id, run) => {
    try { const detail = run(); checks.push({ id, status: 'ok', detail: detail ?? '' }); }
    catch (error) { checks.push({ id, status: 'not-ok', detail: String(error?.message ?? error) }); }
  };
  const shimFile = id => path.join(output, 'plugins', id, 'index.mjs');

  check('structure', () => {
    const pkg = JSON.parse(readPlainFile(inspectPlainPath(path.join(output, 'package.json'), { kind: 'file' })).toString('utf8'));
    for (const id of PLUGIN_IDS) {
      const spec = pkg?.dependencies?.[id];
      if (typeof spec !== 'string' || !spec.startsWith('file:./plugins/' + id)) fail('DSH_VERIFY_PLUGIN_DECLARATION');
      inspectPlainPath(shimFile(id), { kind: 'file' });
    }
    return 'package.json declares both plugins; both shims exist through verified paths';
  });

  check('shims', () => {
    if (checks[0]?.status !== 'ok') fail('DSH_VERIFY_STRUCTURE_REQUIRED');
    const expected = { 'gstack861-guard': inspectPlainPath(adapterPath, { kind: 'file' }).path, 'gstack861-skills': fileURLToPath(new URL('./adapters/dsh-skills.mjs', import.meta.url)) };
    for (const id of PLUGIN_IDS) {
      // Byte-level binding only: never import code from the profile directory.
      const bytes = readPlainFile(inspectPlainPath(shimFile(id), { kind: 'file' }));
      const source = `export { name, inject, apply } from ${JSON.stringify(pathToFileURL(expected[id]).href)};\n`;
      if (!bytes.equals(Buffer.from(source, 'utf8'))) fail('DSH_VERIFY_SHIM_BINDING');
    }
    return 'both shims re-export the expected adapter sources byte-for-byte';
  });

  check('policy', () => {
    loadPolicy(policyPath);
    return 'policy compiles with the real guard loader';
  });

  check('skills', () => {
    const entries = loadRegistry(skillsDir);
    if (entries.length === 0) fail('DSH_VERIFY_SKILLS_EMPTY');
    for (const entry of entries) {
      const bytes = readPlainFile(inspectPlainPath(path.join(skillsDir, entry.name, 'SKILL.md'), { kind: 'file' }));
      if (textDigest(bytes) !== entry.sha256) fail('DSH_VERIFY_SKILL_TAMPERED');
    }
    return `${entries.length} registered skill(s) match their registry digests`;
  });

  return { schemaVersion: 1, status: checks.every(c => c.status === 'ok') ? 'ready' : 'not-ready', checks };
}
