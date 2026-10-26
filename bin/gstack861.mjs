#!/usr/bin/env node
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadPolicy } from '../src/policy.mjs';
import { handleZcode, denyZcode, zcodeHookConfig } from '../src/adapters/zcode.mjs';
import { inventory } from '../src/inventory.mjs';

const args = process.argv.slice(2);
const print = value => process.stdout.write(JSON.stringify(value, null, 2) + '\n');
function flags(tokens, allowed) {
  const result = {};
  for (let i = 0; i < tokens.length; i += 2) {
    const key = tokens[i];
    if (!allowed.includes(key) || Object.hasOwn(result, key) || !tokens[i + 1] || tokens[i + 1].startsWith('--')) throw new Error('INVALID_ARGUMENTS');
    result[key] = tokens[i + 1];
  }
  return result;
}
const lock = () => JSON.parse(fs.readFileSync(new URL('../upstream.lock.json', import.meta.url), 'utf8'));

if (args[0] === 'hook') {
  let result;
  try {
    if (args[1] !== 'zcode') throw new Error('UNKNOWN_HOST');
    const options = flags(args.slice(2), ['--policy']);
    const policy = loadPolicy(options['--policy']);
    let input = '', bytes = 0;
    for await (const chunk of process.stdin) {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 1048576) throw new Error('INPUT_TOO_LARGE');
      input += chunk;
    }
    result = handleZcode(JSON.parse(input), policy);
  } catch { result = denyZcode('HOOK_INPUT_OR_POLICY_ERROR'); }
  print(result.output);
  process.exitCode = result.exitCode;
} else {
  try {
    if (args[0] === 'doctor' && args.length === 1) {
      print({ version: '0.1.0', node: process.version, platform: process.platform, baseline: lock(),
        hosts: { zcode: 'not-host-verified', dsh: 'not-host-verified' },
        networkCalls: 0, modelCalls: 0,
        safety: 'guard-protocol foundation; not an OS sandbox; no full-parity certification' });
    } else if (args[0] === 'inventory') {
      const options = flags(args.slice(1), ['--upstream']);
      if (!options['--upstream']) throw new Error('UPSTREAM_PATH_REQUIRED');
      print(inventory(options['--upstream'], lock().gstack.commit));
    } else if (args[0] === 'zcode-config') {
      const options = flags(args.slice(1), ['--policy']);
      loadPolicy(options['--policy']);
      print(zcodeHookConfig({ nodePath: process.execPath, cliPath: fileURLToPath(import.meta.url), policyPath: options['--policy'] }));
    } else {
      process.stderr.write('Usage: gstack861 doctor | inventory --upstream PATH | zcode-config --policy ABS_PATH\n');
      process.exitCode = 1;
    }
  } catch (error) {
    process.stderr.write(`gstack861: ${error.code ?? error.message}\n`);
    process.exitCode = 1;
  }
}
