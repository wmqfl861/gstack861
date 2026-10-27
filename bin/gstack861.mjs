#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPolicy } from '../src/policy.mjs';
import { handleZcode, denyZcode, zcodeHookConfig } from '../src/adapters/zcode.mjs';
import { inventory } from '../src/inventory.mjs';
import { generateSkills } from '../src/generate.mjs';
import { installSkills, uninstallSkills } from '../src/install.mjs';
import { ApprovalStore } from '../src/approvals.mjs';

const args = process.argv.slice(2);
const print = value => process.stdout.write(JSON.stringify(value, null, 2) + '\n');
function flags(tokens, allowed, booleans = []) {
  const result = {};
  for (let i = 0; i < tokens.length; i++) {
    const key = tokens[i];
    if (booleans.includes(key)) {
      if (Object.hasOwn(result, key)) throw new Error('INVALID_ARGUMENTS');
      result[key] = true;
      continue;
    }
    if (!allowed.includes(key) || Object.hasOwn(result, key) || !tokens[i + 1] || tokens[i + 1].startsWith('--')) throw new Error('INVALID_ARGUMENTS');
    result[key] = tokens[i + 1];
    i++;
  }
  return result;
}
const absolute = value => {
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error('ABSOLUTE_PATH_REQUIRED');
  return value;
};
const lock = () => JSON.parse(fs.readFileSync(new URL('../upstream.lock.json', import.meta.url), 'utf8'));

if (args[0] === 'hook') {
  let result;
  try {
    if (args[1] !== 'zcode') throw new Error('UNKNOWN_HOST');
    const options = flags(args.slice(2), ['--policy']);
    const policy = loadPolicy(options['--policy']);
    const chunks = []; let bytes = 0;
    for await (const chunk of process.stdin) {
      bytes += chunk.length;
      if (bytes > 1048576) throw new Error('INPUT_TOO_LARGE');
      chunks.push(chunk);
    }
    // Decode once: per-chunk decoding splits multi-byte UTF-8 characters at chunk boundaries.
    result = handleZcode(JSON.parse(Buffer.concat(chunks).toString('utf8')), policy);
  } catch (error) { result = denyZcode(/^[A-Z][A-Z0-9_]*$/.test(error?.message) ? error.message : 'HOOK_INPUT_OR_POLICY_ERROR'); }
  print(result.output);
  process.exitCode = result.exitCode;
} else {
  try {
    if (args[0] === 'doctor' && args.length === 1) {
      print({ version: '0.2.1', node: process.version, platform: process.platform, baseline: lock(),
        hosts: { zcode: 'not-host-verified', dsh: 'not-host-verified' },
        networkCalls: 0, modelCalls: 0,
        safety: 'guard-protocol foundation; not an OS sandbox; no full-parity certification' });
    } else if (args[0] === 'inventory') {
      const options = flags(args.slice(1), ['--upstream']);
      if (!options['--upstream']) throw new Error('UPSTREAM_PATH_REQUIRED');
      print(inventory(path.resolve(options['--upstream']), lock().gstack.commit));
    } else if (args[0] === 'zcode-config') {
      const options = flags(args.slice(1), ['--policy', '--matcher']);
      loadPolicy(absolute(options['--policy']));
      print(zcodeHookConfig({ nodePath: process.execPath, cliPath: fileURLToPath(import.meta.url),
        policyPath: absolute(options['--policy']), matcher: options['--matcher'] }));
    } else if (args[0] === 'generate') {
      const options = flags(args.slice(1), ['--upstream', '--staging', '--host', '--commit']);
      // --commit overrides the lock pin for fixtures only; production flows read the lock file.
      const commit = options['--commit'] ?? lock().gstack.commit;
      if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('FULL_COMMIT_REQUIRED');
      print(generateSkills({ upstream: absolute(options['--upstream']), commit,
        staging: absolute(options['--staging']), host: options['--host'] }));
    } else if (args[0] === 'install') {
      const options = flags(args.slice(1), ['--staging', '--target']);
      print(installSkills({ staging: absolute(options['--staging']), target: absolute(options['--target']) }));
    } else if (args[0] === 'uninstall') {
      const options = flags(args.slice(1), ['--target'], ['--purge']);
      print(uninstallSkills({ target: absolute(options['--target']), purge: options['--purge'] === true }));
    } else if (args[0] === 'approvals') {
      const options = flags(args.slice(2), ['--state', '--id', '--host', '--session', '--run', '--policy-hash', '--action-file']);
      // Validate before constructing the store: a rejected subcommand must not leave a state directory behind.
      if (!['list', 'show', 'approve', 'reject'].includes(args[1])) throw new Error('UNKNOWN_SUBCOMMAND');
      const store = new ApprovalStore(absolute(options['--state']));
      if (args[1] === 'list') print(store.list().map(({ id, state, issuedAt, expiresAt }) => ({ id, state, issuedAt, expiresAt })));
      else if (args[1] === 'show') print(store.get(options['--id']));
      else {
        let action;
        try { action = JSON.parse(fs.readFileSync(absolute(options['--action-file']), 'utf8')); }
        catch (error) { if (error instanceof SyntaxError) throw new Error('INVALID_ACTION_FILE'); throw error; }
        const subject = { host: options['--host'], sessionId: options['--session'], runId: options['--run'],
          policyHash: options['--policy-hash'], action };
        print(args[1] === 'approve' ? store.approve(options['--id'], subject) : store.reject(options['--id'], subject));
      }
    } else {
      process.stderr.write('Usage: gstack861 doctor | inventory --upstream PATH | zcode-config --policy ABS_PATH\n'
        + '  generate --upstream PATH --staging DIR --host zcode|dsh [--commit 40-HEX]\n'
        + '    (--commit is TEST-ONLY: overrides the upstream lock pin; default = upstream.lock.json)\n'
        + '  install --staging DIR --target DIR | uninstall --target DIR [--purge]\n'
        + '  approvals list --state DIR | show --state DIR --id ID\n'
        + '  approvals approve|reject --state DIR --id ID --host H --session S --run R --policy-hash HASH --action-file F\n');
      process.exitCode = 1;
    }
  } catch (error) {
    process.stderr.write(`gstack861: ${error.code ?? error.message}\n`);
    process.exitCode = 1;
  }
}
