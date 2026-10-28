#!/usr/bin/env node
// gstack861-issue-guard — fetch tracker text and emit it inside the untrusted
// trust envelope (src/tracker-guard.mjs). The ONLY sanctioned path for reading
// PR/issue body text into an agent's context.
//
// Port of upstream/gstack bin/gstack-issue-guard (98 lines) at pinned
// submodule commit 5755601dac5d35ebd7dde181fdefe52a023c73d9 (batch 24 lane B).
//
// CLI (upstream shape):
//   gstack861-issue-guard.mjs issue <n>       # gh issue: title + body + comments
//   gstack861-issue-guard.mjs pr-body         # gh: current PR body
//   gstack861-issue-guard.mjs pr-comments     # gh: current PR issue-comments
//   gstack861-issue-guard.mjs --stdin [--source <label>]   # envelope stdin (works for glab too)
//
// Failure polarity (upstream-exact): a gh/glab fetch failure exits NON-ZERO
// with NO envelope on stdout — never emit a fake-trusted empty envelope.
// Callers own their error contract. Empty content IS enveloped (with a note):
// "empty" is data, "failed" is not. gh is spawned via an argv array — never
// string concatenation — and the issue number is validated before use.
//
// Divergence ledger (every deviation from the upstream source):
//   1. Bun.stdin.text() → fs.readFileSync(0, 'utf8') (Node sync stdin read of
//      fd 0; callers and tests always pipe, as with the redact port).
//   2. flagValue inlined (4 lines) from upstream lib/bin-context.ts lines
//      394-397 — the only consumer here; bin-context's remaining ~390 lines
//      have no consumers in this repo and are not ported (plan 非目标).
//   3. wrapUntrustedTrackerContent imported from src/tracker-guard.mjs (the
//      batch-24 lane A verbatim port of lib/tracker-guard.ts, which inlines
//      INJECTION_PATTERNS from lib/jsonl-store.ts per plan item 2).
//   4. Structural: `#!/usr/bin/env -S bun --no-env-file --config=/dev/null` →
//      `#!/usr/bin/env node`; TypeScript types erased. Everything else —
//      spawnSync gh argv array + 30s/16MiB caps, issue-number validation,
//      per-mode assembly, console output text, process.exit codes — is
//      upstream-verbatim.

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { wrapUntrustedTrackerContent } from '../src/tracker-guard.mjs';

/** The value following `--flag` in argv, or undefined if absent. (bin-context.ts lines 394-397, verbatim.) */
function flagValue(args, name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function gh(args) {
  try {
    const r = spawnSync('gh', args, { encoding: 'utf-8', timeout: 30000, maxBuffer: 16 * 1024 * 1024 });
    return { ok: r.status === 0, out: r.stdout ?? '', err: r.stderr ?? '' };
  } catch (e) {
    return { ok: false, out: '', err: String(e?.message ?? e) };
  }
}

function fail(msg) {
  console.error(`gstack861-issue-guard: ${msg}`);
  process.exit(1);
}

const [, , mode, ...rest] = process.argv;

if (mode === '--stdin') {
  const source = flagValue(rest, '--source');
  const text = fs.readFileSync(0, 'utf8');
  console.log(wrapUntrustedTrackerContent(text, source ?? 'stdin'));
  process.exit(0);
}

if (mode === 'issue') {
  const n = rest[0] ?? '';
  if (!/^[0-9]+$/.test(n)) fail(`issue number must be numeric, got: ${JSON.stringify(n)}`);
  const r = gh(['issue', 'view', n, '--json', 'title,body,comments']);
  if (!r.ok) fail(`gh issue view failed: ${r.err.trim() || 'unknown error'}`);
  let title = '';
  let body = '';
  let comments = [];
  try {
    const j = JSON.parse(r.out);
    title = typeof j.title === 'string' ? j.title : '';
    body = typeof j.body === 'string' ? j.body : '';
    comments = Array.isArray(j.comments) ? j.comments : [];
  } catch {
    fail('gh returned unparseable JSON');
  }
  const parts = [`TITLE: ${title}`, '', body];
  for (const c of comments) {
    parts.push('', `--- comment by ${c?.author?.login ?? 'unknown'} ---`, c?.body ?? '');
  }
  console.log(wrapUntrustedTrackerContent(parts.join('\n'), `issue #${n}`));
  process.exit(0);
}

if (mode === 'pr-body') {
  const r = gh(['pr', 'view', '--json', 'body', '--jq', '.body']);
  if (!r.ok) fail(`gh pr view failed: ${r.err.trim() || 'unknown error'}`);
  console.log(wrapUntrustedTrackerContent(r.out, 'pr body'));
  process.exit(0);
}

if (mode === 'pr-comments') {
  const r = gh(['pr', 'view', '--json', 'comments']);
  if (!r.ok) fail(`gh pr view failed: ${r.err.trim() || 'unknown error'}`);
  let comments = [];
  try {
    const j = JSON.parse(r.out);
    comments = Array.isArray(j.comments) ? j.comments : [];
  } catch {
    fail('gh returned unparseable JSON');
  }
  const parts = [];
  for (const c of comments) {
    parts.push(`--- comment by ${c?.author?.login ?? 'unknown'} ---`, c?.body ?? '', '');
  }
  console.log(wrapUntrustedTrackerContent(parts.join('\n'), 'pr comments'));
  process.exit(0);
}

fail('usage: gstack861-issue-guard issue <n> | pr-body | pr-comments | --stdin [--source <label>]');
