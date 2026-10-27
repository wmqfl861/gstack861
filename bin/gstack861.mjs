#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPolicy } from '../src/policy.mjs';
import { handleZcode, denyZcode, zcodeHookConfig } from '../src/adapters/zcode.mjs';
import { inventory } from '../src/inventory.mjs';
import { generateSkills } from '../src/generate.mjs';
import { stageRender } from '../src/stage.mjs';
import { installSkills, uninstallSkills } from '../src/install.mjs';
import { ApprovalStore, subjectDigest } from '../src/approvals.mjs';
import { TaskStore } from '../src/tasks.mjs';

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
/** Rebuild a subject from operator flags plus the action file; only its digest is ever persisted. */
const subjectFrom = options => {
  // Path semantics stay outside the scoped catch: a relative --action-file must keep
  // its own ABSOLUTE_PATH_REQUIRED code, not be masked as INVALID_ACTION_FILE.
  const file = absolute(options['--action-file']);
  let action;
  try { action = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) {
    // Scoped by error type: read errors carry a filesystem code (ENOENT, EACCES, EISDIR...);
    // JSON failures surface as SyntaxError, or RangeError when nesting overflows the stack.
    // Anything else is unexpected and rethrown unchanged.
    if (error instanceof SyntaxError || error instanceof RangeError || typeof error.code === 'string') throw new Error('INVALID_ACTION_FILE');
    throw error;
  }
  return { host: options['--host'], sessionId: options['--session'], runId: options['--run'],
    policyHash: options['--policy-hash'], action };
};
const version = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
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
      // 4 MiB cap: hosts may embed whole file contents in tool_input, which the old
      // 1 MiB limit refused; the cap still bounds memory before JSON.parse runs.
      if (bytes > 4 * 1024 * 1024) throw new Error('INPUT_TOO_LARGE');
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
      print({ version, node: process.version, platform: process.platform, baseline: lock(),
        hosts: { zcode: 'not-host-verified', dsh: 'not-host-verified' },
        networkCalls: 0, modelCalls: 0,
        safety: 'guard-protocol foundation; not an OS sandbox; no full-parity certification',
        // count and evidence update together per batch
        consumption: { renderedSkillsConsumed: 8,
          evidence: ['docs/verification-2026-10-27-render-consumption.md',
            'docs/verification-2026-10-27-safety-suite.md',
            'docs/verification-2026-10-27-workflow-suite.md'],
          note: 'context-injection; auto-pickup unverified' },
        unlocks: { dsh: 'set DEEPSEEK_API_KEY then run node scripts/verify-dsh-guard.mjs',
          zcode: 'follow docs/integration/zcode-acceptance.md + host-loading.md section 2.4 in a controlled new session' } });
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
      const options = flags(args.slice(1), ['--upstream', '--staging', '--host']);
      // GSTACK861_TEST_COMMIT overrides the lock pin for fixtures only; production
      // flows read the lock file. When the override is active it is announced on stderr.
      const override = process.env.GSTACK861_TEST_COMMIT;
      const commit = override ?? lock().gstack.commit;
      if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('FULL_COMMIT_REQUIRED');
      if (override !== undefined) process.stderr.write(`gstack861: TEST_COMMIT_OVERRIDE active (${commit.slice(0, 12)})\n`);
      print(generateSkills({ upstream: absolute(options['--upstream']), commit,
        staging: absolute(options['--staging']), host: options['--host'] }));
    } else if (args[0] === 'stage-render') {
      const options = flags(args.slice(1), ['--rendered', '--manifest', '--host', '--staging']);
      // All four flags are binding: a missing one must refuse before any render
      // tree byte is read, same as the approvals ask guard.
      for (const key of ['--rendered', '--manifest', '--host', '--staging'])
        if (options[key] === undefined) throw new Error('INVALID_ARGUMENTS');
      // --manifest may be relative to cwd (like inventory --upstream); the two
      // directory flags stay strictly absolute, as stageRender itself enforces.
      print(stageRender({ rendered: absolute(options['--rendered']), manifestFile: path.resolve(options['--manifest']),
        host: options['--host'], staging: absolute(options['--staging']) }));
    } else if (args[0] === 'install') {
      const options = flags(args.slice(1), ['--staging', '--target'], ['--dry-run']);
      print(installSkills({ staging: absolute(options['--staging']), target: absolute(options['--target']), dryRun: options['--dry-run'] === true }));
    } else if (args[0] === 'uninstall') {
      const options = flags(args.slice(1), ['--target'], ['--purge', '--dry-run']);
      print(uninstallSkills({ target: absolute(options['--target']), purge: options['--purge'] === true, dryRun: options['--dry-run'] === true }));
    } else if (args[0] === 'approvals') {
      const options = flags(args.slice(2), ['--state', '--id', '--host', '--session', '--run', '--policy-hash', '--action-file', '--ttl-ms', '--prompt-file']);
      // Validate before constructing the store: a rejected subcommand or argument
      // must not leave a state directory behind.
      if (!['list', 'show', 'issue', 'approve', 'reject', 'consume', 'verify', 'ask'].includes(args[1])) throw new Error('UNKNOWN_SUBCOMMAND');
      // --prompt-file only carries meaning for ask; other subcommands keep refusing it.
      if (options['--prompt-file'] !== undefined && args[1] !== 'ask') throw new Error('INVALID_ARGUMENTS');
      // ask blocks on an operator answer, so every binding flag is required up front —
      // a malformed invocation must fail before the store creates a state directory.
      if (args[1] === 'ask') {
        for (const key of ['--id', '--host', '--session', '--run', '--policy-hash', '--action-file'])
          if (options[key] === undefined) throw new Error('INVALID_ARGUMENTS');
      }
      const ttlRaw = options['--ttl-ms'];
      const ttlMs = ttlRaw === undefined ? undefined : Number(ttlRaw);
      // Same bounds as ApprovalStore.issue, checked here so a refused value cannot
      // leave a freshly created state directory behind.
      if (ttlMs !== undefined && (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 86400000)) throw new Error('INVALID_TTL');
      const store = new ApprovalStore(absolute(options['--state']));
      if (args[1] === 'list') print(store.list().map(({ id, state, issuedAt, expiresAt }) => ({ id, state, issuedAt, expiresAt })));
      else if (args[1] === 'show') print(store.get(options['--id']));
      else if (args[1] === 'issue') {
        print(store.issue(subjectFrom(options), ttlMs === undefined ? {} : { ttlMs }));
      } else if (args[1] === 'ask') {
        const subject = subjectFrom(options);
        const record = store.get(options['--id']);
        const promptFile = options['--prompt-file'];
        // Read the prompt file before the stdin await below: a bad prompt file must
        // exit with EMPTY stdout — no question printed — and never block on an answer.
        // Path semantics stay outside the scoped catch, same as subjectFrom: a
        // relative --prompt-file keeps its own ABSOLUTE_PATH_REQUIRED code.
        let prompt = '';
        if (promptFile !== undefined) {
          const file = absolute(promptFile);
          try { prompt = fs.readFileSync(file, 'utf8'); }
          catch (error) {
            // Scoped by error type: read errors carry a filesystem code (ENOENT, EACCES...).
            // The prompt is plain UTF-8 text with no parse step, so the SyntaxError/
            // RangeError classes below are the shared pattern, not a parse-error case here.
            if (error instanceof SyntaxError || error instanceof RangeError || typeof error.code === 'string') throw new Error('INVALID_PROMPT_FILE');
            throw error;
          }
        }
        // Step 1: the structured question — everything the operator needs to decide,
        // never the action payload itself, only its digest prefix.
        print({ id: record.id, state: record.state,
          subject: { host: subject.host, sessionId: subject.sessionId, runId: subject.runId,
            policyHashPrefix16: subject.policyHash.slice(0, 16) },
          actionDigest: subjectDigest(subject).slice(0, 16),
          expiresInMillisRemaining: record.expiresAt - Date.now(),
          prompt });
        // Step 2: block on the operator's stdin answer. No piped answer means no
        // approval — the bridge never auto-agrees.
        const chunks = []; let bytes = 0;
        for await (const chunk of process.stdin) {
          bytes += chunk.length;
          if (bytes > 4 * 1024 * 1024) throw new Error('INPUT_TOO_LARGE');
          chunks.push(chunk);
        }
        // Tolerate CRLF consoles; only the first line decides, one optional reason line echoes.
        const lines = Buffer.concat(chunks).toString('utf8').split('\n').map(l => l.endsWith('\r') ? l.slice(0, -1) : l);
        const answer = lines[0].trim();
        const reasonLine = lines.length > 1 ? lines[1] : '';
        if (answer !== 'approve' && answer !== 'reject') {
          process.stderr.write('gstack861: ASK_UNANSWERED\n');
          process.exitCode = 3; // pending stays pending; the host executor must re-ask
        } else {
          const decided = answer === 'approve' ? store.approve(options['--id'], subject) : store.reject(options['--id'], subject);
          // The reason echoes to stdout only; records stay digest-only, so it never persists.
          print(reasonLine.trim() === '' ? decided : { ...decided, reason: reasonLine });
        }
      } else if (args[1] === 'verify') print(store.verify(options['--id'], subjectFrom(options)));
      else {
        const subject = subjectFrom(options);
        print(args[1] === 'approve' ? store.approve(options['--id'], subject)
          : args[1] === 'consume' ? store.consume(options['--id'], subject)
          : store.reject(options['--id'], subject));
      }
    } else if (args[0] === 'tasks') {
      const options = flags(args.slice(2), ['--state', '--id', '--host', '--session', '--run', '--policy-hash', '--action-file', '--owner']);
      // Validate before constructing the store: a rejected subcommand or argument
      // must not leave a state directory behind.
      if (!['create', 'start', 'resume', 'complete', 'fail', 'cancel', 'interrupt', 'show', 'list'].includes(args[1])) throw new Error('UNKNOWN_SUBCOMMAND');
      const owner = options['--owner'];
      if (owner !== undefined && !['create', 'start'].includes(args[1])) throw new Error('INVALID_ARGUMENTS');
      if (options['--id'] !== undefined && args[1] === 'create') throw new Error('INVALID_ARGUMENTS');
      // Same shape as TaskStore.create/start, checked before any directory is created.
      if (owner !== undefined && (owner.length < 1 || owner.length > 256)) throw new Error('INVALID_OWNER');
      const store = new TaskStore(absolute(options['--state']));
      if (args[1] === 'list') print(store.list());
      else if (args[1] === 'show') print(store.get(options['--id']));
      else if (args[1] === 'create') print(store.create(subjectFrom(options), owner === undefined ? {} : { owner }));
      else if (args[1] === 'start') print(store.start(options['--id'], subjectFrom(options), owner === undefined ? {} : { owner }));
      else print(store[args[1]](options['--id'], subjectFrom(options)));
    } else {
      process.stderr.write('Usage: gstack861 doctor | inventory --upstream PATH | zcode-config --policy ABS_PATH\n'
        + '  generate --upstream PATH --staging DIR --host zcode|dsh\n'
        + '    (env GSTACK861_TEST_COMMIT overrides the upstream lock pin for TESTS only; default = upstream.lock.json)\n'
        + '  stage-render --rendered DIR --manifest FILE --host zcode|dsh --staging DIR\n'
        + '    (converts CI render output + render-manifest into installable staging; GSTACK861_TEST_COMMIT as for generate)\n'
        + '  install --staging DIR --target DIR [--dry-run] | uninstall --target DIR [--purge] [--dry-run]\n'
        + '  approvals list --state DIR | show --state DIR --id ID\n'
        + '  approvals issue --state DIR --host H --session S --run R --policy-hash HASH --action-file F [--ttl-ms N]\n'
        + '  approvals approve|reject|consume --state DIR --id ID --host H --session S --run R --policy-hash HASH --action-file F\n'
        + '  approvals verify --state DIR --id ID --host H --session S --run R --policy-hash HASH --action-file F\n'
        + '  approvals ask --state DIR --id ID --host H --session S --run R --policy-hash HASH --action-file F [--prompt-file ABS]\n'
        + '  tasks create --state DIR --host H --session S --run R --policy-hash HASH --action-file F [--owner O]\n'
        + '  tasks start --state DIR --id ID --host H --session S --run R --policy-hash HASH --action-file F [--owner O]\n'
        + '  tasks resume|complete|fail|cancel|interrupt --state DIR --id ID --host H --session S --run R --policy-hash HASH --action-file F\n'
        + '  tasks show --state DIR --id ID | tasks list --state DIR\n');
      process.exitCode = 1;
    }
  } catch (error) {
    process.stderr.write(`gstack861: ${error.code ?? error.message}\n`);
    process.exitCode = 1;
  }
}
