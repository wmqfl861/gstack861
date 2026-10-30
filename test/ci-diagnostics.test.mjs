import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectCiMetadata, reportCiDiagnostics } from '../scripts/ci-diagnostics.mjs';

function fixture(t) {
  const repo = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'g861-ci-diag-')));
  fs.mkdirSync(path.join(repo, 'src'));
  fs.writeFileSync(path.join(repo, 'src/fs-utils.mjs'), 'export const fixture = true;\n');
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  return repo;
}
function report(repo, text, name = 'ci-test.log') {
  fs.writeFileSync(path.join(repo, name), text);
  const annotations = [];
  const result = reportCiDiagnostics({ repo, logFiles: [name], emit: value => annotations.push(value) });
  return { result, annotations, errors: annotations.filter(value => value.startsWith('::error::')) };
}

test('CI diagnostics expose TAP failure assertions and leave the complete source log unchanged', t => {
  const repo = fixture(t);
  const log = "TAP version 13\n# Subtest: refuses unsafe paths\nnot ok 1 - refuses unsafe paths\n  ---\n  error: 'Missing expected exception.'\n  code: ERR_ASSERTION\n  stack: |-\n    TestContext.<anonymous> (test/example.test.mjs:12:3)\n  ...\n# tests 1\n# fail 1\n";
  const { result, errors } = report(repo, log);
  assert.equal(result.failureCount, 1);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /refuses unsafe paths/);
  assert.match(errors[0], /Missing expected exception/);
  assert.match(errors[0], /ERR_ASSERTION/);
  assert.equal(fs.readFileSync(path.join(repo, 'ci-test.log'), 'utf8'), log);
});

test('CI diagnostics prefer the detailed spec failure over its earlier one-line duplicate', t => {
  const repo = fixture(t);
  const log = "✖ independent files (1.2ms)\n✔ another test (0.2ms)\nℹ tests 2\nℹ fail 1\n\n✖ failing tests:\n\ntest at test/example.test.mjs:8:1\n✖ independent files (1.2ms)\n  AssertionError [ERR_ASSERTION]: expected distinct inodes\n  actual: 9007199254740992\n  expected: 9007199254740992\n";
  const { result, errors } = report(repo, log);
  assert.equal(result.failureCount, 1);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /expected distinct inodes/);
  assert.match(errors[0], /9007199254740992/);
});

test('CI annotations escape workflow commands and bound the final escaped payload', t => {
  const repo = fixture(t);
  const text = 'not ok 1 - injection %\r\n  error: "::warning::fake"\n' + '  %\r\n'.repeat(5000);
  const { errors } = report(repo, text);
  assert.equal(errors.length, 1);
  const payload = errors[0].slice('::error::'.length);
  assert.ok(payload.length <= 6000, 'escaped payload stays within its public annotation bound');
  assert.ok(!/[\r\n]/.test(errors[0]), 'a log cannot create a second workflow command');
  assert.match(payload, /%25/);
  assert.match(payload, /%0A/);
  assert.match(payload, /truncated/);
  assert.equal(fs.readFileSync(path.join(repo, 'ci-test.log'), 'utf8'), text);
});

test('CI diagnostic truncation reports omitted failure blocks instead of dropping them silently', t => {
  const repo = fixture(t);
  const text = Array.from({ length: 25 }, (_, i) => `not ok ${i + 1} - failure ${i}\n  error: example ${i}\n`).join('');
  const { result, annotations, errors } = report(repo, text);
  assert.equal(result.failureCount, 25);
  assert.equal(errors.length, 20);
  assert.ok(annotations.some(value => /5 additional failure blocks/.test(value)));
});

test('missing or unrecognized CI logs explicitly report unavailable diagnostics', t => {
  const repo = fixture(t), annotations = [];
  const missing = reportCiDiagnostics({ repo, logFiles: ['ci-test.log'], emit: value => annotations.push(value) });
  assert.equal(missing.failureCount, 0);
  assert.ok(annotations.some(value => /diagnostic unavailable/i.test(value)));
  const { errors } = report(repo, 'npm failed before the test runner: fixture error\n');
  assert.equal(errors.length, 1);
  assert.match(errors[0], /diagnostic unavailable/i);
  assert.match(errors[0], /npm failed before the test runner/);
});

test('CI diagnostics read only the fixed repository log names', t => {
  const repo = fixture(t);
  for (const name of ['../outside.log', '.env', path.join(repo, 'ci-test.log')]) {
    assert.throws(() => reportCiDiagnostics({ repo, logFiles: [name], emit() {} }), /INVALID_DIAGNOSTIC_PATH/);
  }
});

test('CI metadata records genuine path and descriptor fields, closes descriptors and removes owned probes', t => {
  const repo = fixture(t), before = fs.readdirSync(repo).sort(), open = fs.openSync, close = fs.closeSync;
  const active = new Set();
  t.mock.method(fs, 'openSync', (...args) => { const fd = open(...args); active.add(fd); return fd; });
  t.mock.method(fs, 'closeSync', fd => { active.delete(fd); return close(fd); });
  const metadata = collectCiMetadata({ repo });
  t.mock.restoreAll();
  assert.equal(active.size, 0);
  assert.equal(metadata.schemaVersion, 1);
  assert.equal(metadata.node, process.versions.node);
  assert.equal(metadata.platform, process.platform);
  const source = metadata.observations.find(value => value.name === 'source-file');
  assert.equal(typeof source.lstat.dev, 'string');
  assert.equal(typeof source.fstat.ino, 'string');
  assert.equal(source.fstat.nlink, '1');
  assert.equal(metadata.cleanup.file, 'removed');
  assert.equal(metadata.cleanup.directory, 'removed');
  assert.deepEqual(fs.readdirSync(repo).filter(name => name !== 'ci-metadata.json').sort(), before);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(repo, 'ci-metadata.json'), 'utf8')), metadata);
});

test('CI metadata retains decimal identity precision above the Number safe integer boundary', t => {
  const repo = fixture(t), fstat = fs.fstatSync;
  t.mock.method(fs, 'fstatSync', (...args) => {
    const stat = fstat(...args);
    if (args[1]?.bigint) { stat.dev = 18446744073709551615n; stat.ino = 9007199254740993n; }
    return stat;
  });
  const metadata = collectCiMetadata({ repo });
  t.mock.restoreAll();
  const source = metadata.observations.find(value => value.name === 'source-file');
  assert.equal(source.fstat.dev, '18446744073709551615');
  assert.equal(source.fstat.ino, '9007199254740993');
});
