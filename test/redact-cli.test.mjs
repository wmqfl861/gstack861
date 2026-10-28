// Contract tests for bin/gstack861-redact.mjs — exit codes, JSON shape,
// flags, auto-redact mode, oversize fail-closed (batch 22, Lane C).
//
// Upstream lineage: gstack test/gstack-redact-cli.test.ts @ upstream.lock.json
// commit 5755601dac5d35ebd7dde181fdefe52a023c73d9. Adaptation is
// syntax/harness-only (bun:test → node:test; Bun.spawnSync(["bun", BIN, …]) →
// spawnSync(process.execPath, [BIN, …])) — every assert value is untouched.
// Two describe blocks at the tail are the RC2 BACKFILL promised by lane A's
// "回填于 lane C" comments (审计划必改落实 item 2): the #3048 --from-file
// sourcePath vector dropped from test/redact-engine.test.mjs and the
// supplementary-expansion auto-redact spawn tail dropped from
// test/redact-unicode-offsets.test.mjs — both spawn the real bin, so they live
// HERE against bin/gstack861-redact.mjs.
//
// Added vectors beyond upstream (plan Lane C): empty --from-file (#2679),
// invalid --max-bytes (#1824), engine-oversize --json shape, the pre-engine
// 16 MiB CLI boundary (exit 3 before the engine runs), and the --auto-redact
// stderr diff lines. The two slow-pipe tests (bd621cc0) are POSIX-only —
// upstream itself excludes this file from the Windows curated subset because
// it spawns a bin shebang script, and the sh sleep-pipe harness has no win32
// equivalent.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../bin/gstack861-redact.mjs', import.meta.url));
const POSIX_ONLY = 'POSIX only: slow-pipe sh harness (upstream excludes this file from the Windows curated subset)';

// A synthetic AWS access key for feeding the scanner. Derived by
// concatenation so the contiguous credential-shaped literal never appears in
// this file's source — the CI quality gate scans every ADDED diff line with
// this same engine, and a raw fixture literal here fails the gate it exists
// to test (#2610 port fallout). The scanner still sees the assembled bytes.
const FAKE_AWS_KEY = ['AKIA', '1234567890ABCDEF'].join('');

function run(args, stdin) {
  const proc = spawnSync(process.execPath, [BIN, ...args], {
    input: stdin,
    encoding: 'utf8',
    timeout: 30000,
  });
  return { code: proc.status, stdout: proc.stdout, stderr: proc.stderr };
}

function tmp(t, tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), tag));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe('gstack861-redact exit codes', () => {
  test('clean → 0', () => {
    assert.equal(run([], 'just some prose').code, 0);
  });
  test('HIGH → 3', () => {
    assert.equal(run([], `key ${FAKE_AWS_KEY}`).code, 3);
  });
  test('MEDIUM only → 2', () => {
    assert.equal(run(['--repo-visibility', 'public'], 'mail bob@corp.io').code, 2);
  });
});

describe('gstack861-redact --json', () => {
  test('emits valid JSON with findings + counts', () => {
    const { stdout, code } = run(['--json'], `key ${FAKE_AWS_KEY}`);
    assert.equal(code, 3);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.findings[0].id, 'aws.access_key');
    assert.equal(parsed.counts.HIGH, 1);
    assert.equal(parsed.repoVisibility, 'unknown');
  });
});

describe('gstack861-redact --auto-redact', () => {
  test('prints redacted body to stdout, exits 0', () => {
    const { stdout, code } = run(['--auto-redact', 'pii.email'], 'ping bob@corp.io please');
    assert.equal(code, 0);
    assert.ok(stdout.includes('<REDACTED-EMAIL>'));
    assert.ok(!stdout.includes('bob@corp.io'));
  });
  // Added vector (plan Lane C "--auto-redact diff"): the diff lands on stderr
  // with upstream's reversed-pair line order (`+ after` then `- before`).
  test('writes the -/+ diff to stderr (added vector)', () => {
    const { stderr } = run(['--auto-redact', 'pii.email'], 'ping bob@corp.io please');
    assert.ok(stderr.includes('+ ping <REDACTED-EMAIL> please\n- ping bob@corp.io please'));
  });
});

describe('gstack861-redact --allowlist', () => {
  test('allowlisted span is suppressed', (t) => {
    const dir = tmp(t, 'redact-allow-');
    const allow = path.join(dir, 'allow.txt');
    fs.writeFileSync(allow, FAKE_AWS_KEY + '\n');
    const { code } = run(['--allowlist', allow], `key ${FAKE_AWS_KEY}`);
    assert.equal(code, 0);
  });
});

describe('gstack861-redact --self-email', () => {
  test('own email is not flagged', () => {
    const { code } = run(
      ['--repo-visibility', 'public', '--self-email', 'me@garry.dev'],
      'from me@garry.dev',
    );
    assert.equal(code, 0);
  });
});

describe('gstack861-redact --from-file', () => {
  test('reads input from a file', (t) => {
    const dir = tmp(t, 'redact-file-');
    const f = path.join(dir, 'spec.md');
    fs.writeFileSync(f, 'leaked ghp_' + 'a'.repeat(36));
    const { stdout } = run(['--from-file', f, '--json'], '');
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.findings[0].id, 'github.pat');
  });
});

describe('gstack861-redact oversize fails closed', () => {
  test('input over --max-bytes blocks (exit 3)', () => {
    const { code, stdout } = run(['--max-bytes', '100'], 'a'.repeat(500));
    assert.equal(code, 3);
    assert.ok(stdout.includes('too large'));
  });
  // Added vector (plan Lane C "oversize JSON"): the fail-closed synthetic
  // finding is machine-consumable too — {oversize:true, id engine.input_too_large}.
  test('--json emits the oversize shape (added vector)', () => {
    const { code, stdout } = run(['--max-bytes', '100', '--json'], 'a'.repeat(500));
    assert.equal(code, 3);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.oversize, true);
    assert.equal(parsed.findings[0].id, 'engine.input_too_large');
    assert.equal(parsed.counts.HIGH, 1);
  });
  // Added vector (RC4 "pre-engine boundary oversize also 3"): a file past the
  // CLI's own 16 MiB ceiling is rejected by statSync BEFORE the engine or any
  // output — no read, no scan, exit 3.
  test('a file over the 16 MiB CLI ceiling is rejected before the engine (added vector)', (t) => {
    const dir = tmp(t, 'redact-huge-');
    const f = path.join(dir, 'huge.bin');
    fs.writeFileSync(f, Buffer.alloc(16 * 1024 * 1024 + 1, 0x61));
    const { code, stdout, stderr } = run(['--from-file', f], '');
    assert.equal(code, 3);
    assert.equal(stdout, '');
    assert.ok(stderr.includes('input file too large'));
  });
});

describe('gstack861-redact argv dispatch', () => {
  // The bug: main() recognised exactly two subcommands and let everything else
  // fall through to the stdin scan, which reports "no findings" and exits 0.
  // So `install-prepush-hooks` (plural typo) installed no hook and still looked
  // like success — the credential guard silently absent while the operator
  // believes it is armed. A guard that no-ops must never exit 0. This port has
  // no subcommands at all (prepush deferred), so every bare word lands here.
  test('a typo\'d install subcommand fails loudly instead of exiting 0', () => {
    const { code, stderr } = run(['install-prepush-hooks'], '');
    assert.notEqual(code, 0);
    assert.ok(stderr.includes('unknown subcommand'));
  });

  test('an unknown positional never reports a clean scan', () => {
    const { code, stdout } = run(['totally-bogus'], '');
    assert.notEqual(code, 0);
    assert.ok(!stdout.includes('HIGH=0'));
  });

  // Usage errors must not collide with the findings codes (2 = MEDIUM,
  // 3 = HIGH); a caller gating on those would read a typo as "findings".
  test('usage errors exit 1, not a findings code', () => {
    assert.equal(run(['totally-bogus'], '').code, 1);
  });

  test('--help prints usage and exits 0 without scanning', () => {
    const { code, stdout } = run(['--help'], `key ${FAKE_AWS_KEY}`);
    assert.equal(code, 0);
    assert.ok(stdout.includes('STDIN'));
    assert.ok(!stdout.includes('HIGH=1'));
  });

  // "scan" is what the human output header ("gstack861-redact scan — repo …")
  // invites people to type, so it stays an accepted alias for the default
  // filter mode. Rejecting it would break that muscle memory for no gain.
  test('the \'scan\' alias still scans normally', () => {
    assert.equal(run(['scan'], `key ${FAKE_AWS_KEY}`).code, 3);
    assert.equal(run(['scan'], 'just prose').code, 0);
  });

  test('flags are still parsed, not mistaken for subcommands', () => {
    assert.equal(run(['--json'], 'just prose').code, 0);
  });
});

// Added vectors (plan Lane C + 审计划必改落实 item 4: the exit-1 usage class).
describe('gstack861-redact usage errors (exit 1)', () => {
  // #2679: a skill block passes "$FILE" from a $(mktemp) that may have
  // failed. An explicitly-passed EMPTY path must error — never fall back to
  // stdin, which scans nothing while looking green. The stdin below carries a
  // HIGH finding: had the CLI fallen back, it would exit 3, not 1.
  test('an explicitly empty --from-file errors without scanning stdin (#2679)', () => {
    const { code, stdout, stderr } = run(['--from-file', ''], `key ${FAKE_AWS_KEY}`);
    assert.equal(code, 1);
    assert.equal(stdout, '');
    assert.ok(stderr.includes('--from-file requires a non-empty path'));
  });

  // #1824: the RAW string must be validated. "123abc" parseInts to 123 and
  // "foo" to NaN — both would silently corrupt the fail-closed cap.
  test('a non-positive-integer --max-bytes is rejected before scanning (#1824)', () => {
    for (const bad of ['abc', '123abc', '0', '-5']) {
      const { code, stdout, stderr } = run(['--max-bytes', bad], `key ${FAKE_AWS_KEY}`);
      assert.equal(code, 1, bad);
      assert.equal(stdout, '', bad);
      assert.ok(stderr.includes('--max-bytes must be a positive integer'), bad);
    }
  });
});

// RC2 BACKFILL #1 — lane A's test/redact-engine.test.mjs dropped upstream's
// tail describe because it spawns the real bin (its "回填于 lane C" note).
// The CLI's --from-file is what wires ScanOptions.sourcePath (#3048):
// patterns exempt TS/JSX source syntax by FILE CONTEXT, never by value shape.
describe("#3048: gstack861-redact --from-file passes the file's path as scan context", () => {
  test('the same line is source syntax in a .ts file and a literal in YAML', (t) => {
    const dir = tmp(t, 'redact-from-file-');
    const kv = (name) => {
      fs.writeFileSync(path.join(dir, name), '  session: SessionState,\n');
      const r = run(['--from-file', path.join(dir, name), '--json'], '');
      return JSON.parse(r.stdout).findings.some((f) => f.id === 'env.kv');
    };
    assert.equal(kv('coach.ts'), false);
    assert.equal(kv('values.yaml'), true);
  });
});

// RC2 BACKFILL #2 — lane A's test/redact-unicode-offsets.test.mjs dropped its
// spawn tail the same way ("回填于 lane C"). The CLI must mask a detected
// email at EOF with EXACT byte offsets after NFKC supplementary expansion.
describe('the auto-redact CLI masks a detected email at EOF after supplementary expansion', () => {
  test('exact redacted stdout, exit 0, nothing skipped', () => {
    const prefix = '\uFA6C contact: ';
    const { code, stdout, stderr } = run(
      ['--auto-redact', 'pii.email'],
      prefix + 'reviewer@audit.invalid',
    );
    assert.equal(code, 0);
    assert.equal(stdout, prefix + '<REDACTED-EMAIL>');
    assert.ok(!stderr.includes('could not be auto-redacted'));
  });
});

describe('large report survives a piped consumer (bd621cc0 regression)', () => {
  // The bin used to call `process.exit(code)` right after writing the report.
  // For output bigger than the 64 KiB kernel pipe buffer with a consumer that
  // hadn't started reading yet, exit discarded everything still queued in
  // userland: the consumer received EXACTLY 65,536 bytes, JSON.parse blew up,
  // and the CI quality gate failed CLOSED on a clean scan. Fixed by setting
  // process.exitCode and letting the runtime drain stdout.
  //
  // Reproducing the pressure needs a consumer that provably is NOT reading at
  // the moment the child writes and exits. A plain spawn/spawnSync parent
  // cannot arrange that: both runtimes eagerly drain child pipes into parent
  // memory, which relieves the pipe and masks the bug. A shell pipeline whose
  // consumer sleeps before its first read (`| { sleep 1.5; cat …; }`) guarantees
  // the child faces a full pipe at its exit point — the sleep comfortably
  // outlasts the ~0.5 s scan. Verified upstream to catch the regression: with
  // process.exit restored, both tests below receive a 65,536-byte truncated
  // stream. (If a loaded machine ever stretches the scan past the sleep, the
  // fixed bin still passes — only regression detection would weaken, never
  // green runs.)
  //
  // The pipeline's own exit status belongs to `cat`, so the subshell writes
  // the bin's real exit code to a file. POSIX-only (see file header).
  function runSlowPipe(t, dir, inFile, flags) {
    const outFile = path.join(dir, 'pipe-out.bin');
    const codeFile = path.join(dir, 'pipe-code.txt');
    const script =
      `( node "$REDACT_BIN" --from-file "$IN_FILE" ${flags} --repo-visibility private; ` +
      `echo $? > "$CODE_FILE" ) | { sleep 1.5; cat > "$OUT_FILE"; }`;
    const proc = spawnSync('sh', ['-c', script], {
      env: {
        ...process.env,
        REDACT_BIN: BIN,
        IN_FILE: inFile,
        CODE_FILE: codeFile,
        OUT_FILE: outFile,
      },
      encoding: 'utf8',
      timeout: 30000,
    });
    assert.equal(proc.status, 0); // the plumbing itself (sh, cat) must succeed
    return {
      code: fs.readFileSync(codeFile, 'utf8').trim(),
      out: fs.readFileSync(outFile, 'utf8'),
    };
  }

  test(
    '--json: a 900-finding report (>200 KB) arrives complete with exit 2',
    { timeout: 20000, skip: process.platform === 'win32' ? POSIX_ONLY : undefined },
    (t) => {
      const dir = tmp(t, 'redact-pipe-json-');
      // 900 DISTINCT emails → 900 MEDIUM pii.email findings (~259 KB of
      // pretty-printed JSON from ~31 KB of input). @example.* and noreply@
      // are engine-allowlisted; corp<i>.io is not. Visibility never mutates
      // the tier, so MEDIUM → exit 2 holds under --repo-visibility private.
      const N = 900;
      const lines = [];
      for (let i = 0; i < N; i++) lines.push(`contact user${i}@corp${i}.io for details`);
      const inFile = path.join(dir, 'input.txt');
      fs.writeFileSync(inFile, lines.join('\n') + '\n');

      const { code, out } = runSlowPipe(t, dir, inFile, '--json');
      assert.equal(code, '2'); // MEDIUM present, no HIGH
      assert.ok(Buffer.byteLength(out) > 200_000); // real pipe pressure
      const parsed = JSON.parse(out); // truncation → SyntaxError right here
      assert.equal(parsed.findings.length, N);
      assert.equal(parsed.counts.MEDIUM, N);
      assert.equal(parsed.repoVisibility, 'private');
    },
  );

  test(
    '--auto-redact: a >200 KB redacted body arrives complete with exit 0',
    { timeout: 20000, skip: process.platform === 'win32' ? POSIX_ONLY : undefined },
    (t) => {
      const dir = tmp(t, 'redact-pipe-ar-');
      // Same truncation class, other output path: --auto-redact streams the
      // redacted BODY to stdout (and a ~400 KB diff to stderr, which the
      // spawnSync parent drains eagerly — only stdout has the slow consumer).
      // Pad each line with plain prose (nothing pattern-shaped) so the body
      // itself exceeds 200 KB. Pre-fix, the consumer got a 65,536-byte
      // prefix: 216 of 700 redactions and no sentinel.
      const N = 700;
      const pad =
        'the quarterly report covers infrastructure spend growth and the migration ' +
        'plan across three regions with notes on rollout sequencing and support ' +
        'rotation for the on call schedule during the transition window plus follow ' +
        'up items from the retrospective circulated last week';
      const lines = [];
      for (let i = 0; i < N; i++) lines.push(`row ${i} reach user${i}@corp${i}.io ${pad}`);
      lines.push('END-OF-REPORT-SENTINEL');
      const body = lines.join('\n') + '\n';
      assert.ok(Buffer.byteLength(body) > 200_000);
      const inFile = path.join(dir, 'input.txt');
      fs.writeFileSync(inFile, body);

      const { code, out } = runSlowPipe(t, dir, inFile, '--auto-redact pii.email');
      assert.equal(code, '0'); // auto-redact mode always exits 0
      // Every planted marker accounted for, and the final byte arrived.
      assert.equal(out.split('<REDACTED-EMAIL>').length - 1, N);
      assert.ok(!/user\d+@corp\d+\.io/.test(out));
      assert.ok(out.endsWith('END-OF-REPORT-SENTINEL\n'));
    },
  );
});
