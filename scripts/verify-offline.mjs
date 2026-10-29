// Unified OFFLINE regression runner for the verify-* script family (batch 17). Usage:
// npm run verify-offline  (or: node scripts/verify-offline.mjs)
//
// Exit codes: 0 = every step green; 1 = any step failed (the failing step's exit code
// and expected/actual verdict are printed in its ✗ line).
//
// CI-safe BY CONSTRUCTION — zero network beyond loopback, zero model calls:
//   [1/3] BLOCKED smoke for the seven keyed scripts (verify-dsh-guard, verify-dsh-vertical,
//         verify-dsh-robustness, dsh-mini-vertical, dsh-ship-vertical, dsh-recovery-vertical):
//         each child is spawned with an EXPLICIT DEEPSEEK_API_KEY='' (suggestion adopted —
//         never inherit an operator-exported key) and must exit 2 printing a BLOCKED line.
//         They refuse at the env check before touching DSH at all, so a runner needs no DSH
//         install and no paid call can happen (measured: ~0.2s each).
//   [2/3] zcode-workflow-vertical FULL RUN — the batch-16 offline six-stage journal harness
//         (real CLI subprocesses, controller-authored stand-ins, zero model calls) must exit
//         0 with a RESULT: PASS line (measured: ~5s).
//   [3/3] verify-model-review — keyless five-section readiness check, measured CI-safe:
//         node builtins + repository src only, tmpdir fixtures, network only to a 127.0.0.1
//         loopback server it starts itself (measured: ~0.5s).
//
// Deliberately NOT run here (see docs/VERIFICATION-SCRIPTS.md "CI 安全边界"): verify-dsh-skills
// (needs a local DSH install) and verify-8dot3 (volume-dependent Windows probe) — both manual/
// local-only. The full family reference table is docs/VERIFICATION-SCRIPTS.md.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KEYED = [
  'verify-dsh-guard.mjs',
  'verify-dsh-vertical.mjs',
  'verify-dsh-robustness.mjs',
  'dsh-mini-vertical.mjs',
  'dsh-ship-vertical.mjs',
  'dsh-recovery-vertical.mjs',
  'dsh-keyed-consumption.mjs',
];
// Every child of this runner sees an explicitly EMPTY key: the BLOCKED smoke depends on it,
// and the two full-run scripts are keyless by design anyway — an operator-exported
// DEEPSEEK_API_KEY must never leak into what is supposed to be a keyless regression.
const CHILD_ENV = { ...process.env, DEEPSEEK_API_KEY: '' };

function run(script, timeoutMs) {
  return spawnSync(process.execPath, [path.join(repoRoot, 'scripts', script)], {
    encoding: 'utf8', timeout: timeoutMs, env: CHILD_ENV, cwd: repoRoot, maxBuffer: 32 * 1024 * 1024,
  });
}

function main() {
  const startedAt = Date.now();
  let failed = 0;
  let total = 0;
  const mark = (ok, label) => {
    console.log(`      ${ok ? '✓' : '✗'} ${label}`);
    total++;
    if (!ok) failed++;
  };
  const tail = child => child.signal ? ` signal=${child.signal}` : '';

  console.log('verify-offline: unified offline regression — 6 keyed BLOCKED smokes + zcode-workflow-vertical full run + verify-model-review;');
  console.log('                 zero network beyond loopback, zero model calls (keyed children see an explicitly empty DEEPSEEK_API_KEY).');

  console.log('[1/3] keyed scripts BLOCKED smoke (expect exit 2 + BLOCKED line for each)...');
  for (const [index, script] of KEYED.entries()) {
    const child = run(script, 60000);
    const blocked = /BLOCKED/.test(child.stdout ?? '');
    const ok = child.status === 2 && blocked;
    mark(ok, `[1.${index + 1}/6] scripts/${script} exit=${child.status}${tail(child)}${blocked ? ' BLOCKED' : ' NO-BLOCKED-LINE'}`);
    if (!ok) console.log(child.stdout || child.stderr || '(no output)'); // same diagnosis dump as steps 2/3
  }

  console.log('[2/3] zcode-workflow-vertical full offline harness (expect exit 0 + RESULT: PASS)...');
  const zcodeStarted = Date.now();
  const zcode = run('zcode-workflow-vertical.mjs', 120000);
  const zcodePass = /RESULT: PASS/.test(zcode.stdout ?? '');
  if (!zcodePass) console.log(zcode.stdout || zcode.stderr || '(no output)');
  mark(zcode.status === 0 && zcodePass,
    `scripts/zcode-workflow-vertical.mjs exit=${zcode.status}${tail(zcode)}${zcodePass ? ' RESULT: PASS' : ' NO-RESULT-PASS-LINE'} (${((Date.now() - zcodeStarted) / 1000).toFixed(1)}s)`);

  console.log('[3/3] verify-model-review five-section readiness (expect exit 0)...');
  const reviewStarted = Date.now();
  const review = run('verify-model-review.mjs', 60000);
  if (review.status !== 0) console.log(review.stdout || review.stderr || '(no output)');
  mark(review.status === 0,
    `scripts/verify-model-review.mjs exit=${review.status}${tail(review)} (${((Date.now() - reviewStarted) / 1000).toFixed(1)}s)`);

  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  if (failed) {
    console.log(`RESULT: FAILURE — ${failed}/${total} steps failed in ${seconds}s（exit 1）`);
    process.exitCode = 1;
  } else {
    console.log(`RESULT: PASS — ${total}/${total} steps green in ${seconds}s（零付费调用；exit 0）`);
  }
}

main();
