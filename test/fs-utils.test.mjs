import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as helpers from '../src/fs-utils.mjs';

function fixture(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'g861-plain-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'dir');
  fs.mkdirSync(dir);
  const file = path.join(dir, 'notes.txt');
  fs.writeFileSync(file, 'original');
  return { root, dir, file };
}

const directory = { kind: 'directory' };
const file = { kind: 'file' };

test('plain path inspection is read-only and reads an identity-verified regular file', t => {
  const f = fixture(t);
  const snapshot = helpers.inspectPlainPath(f.file, file);
  assert.equal(snapshot.exists, true);
  assert.equal(snapshot.realPath, fs.realpathSync.native(f.file));
  assert.ok(Object.isFrozen(snapshot) && Object.isFrozen(snapshot.entries));
  assert.equal(typeof snapshot.entries.at(-1).ino, 'string');
  assert.equal(snapshot.entries.at(-1).nlink, '1');
  assert.equal(helpers.readPlainFile(snapshot).toString(), 'original');
  assert.doesNotThrow(() => helpers.assertPlainPathUnchanged(snapshot));
  const missing = path.join(f.dir, 'new', 'child');
  const absent = helpers.inspectPlainPath(missing, { ...directory, allowMissing: true });
  assert.equal(absent.exists, false);
  assert.equal(absent.realPath, path.join(fs.realpathSync.native(f.dir), 'new', 'child'));
  assert.deepEqual(absent.missing, [path.join(f.dir, 'new'), missing]);
  assert.equal(fs.existsSync(path.join(f.dir, 'new')), false);
});

test('plain paths refuse links in a leaf or any ancestor, plus hardlinked file leaves', t => {
  const f = fixture(t);
  const view = path.join(f.root, 'view');
  fs.symlinkSync(f.dir, view, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => helpers.inspectPlainPath(view, directory), /PATH_UNSAFE/);
  assert.throws(() => helpers.inspectPlainPath(path.join(view, 'notes.txt'), file), /PATH_UNSAFE/);
  assert.throws(() => helpers.inspectPlainPath(path.join(view, 'missing', 'leaf'), { ...file, allowMissing: true }), /PATH_UNSAFE/);
  const hard = path.join(f.root, 'hard.txt');
  fs.linkSync(f.file, hard);
  assert.throws(() => helpers.inspectPlainPath(f.file, file), /PATH_UNSAFE/);
  assert.throws(() => helpers.inspectPlainPath(hard, file), /PATH_UNSAFE/);
});

test('plain paths reject traversal, controls, wrong ancestor types and absent required paths', t => {
  const f = fixture(t);
  for (const bad of ['relative', '', path.join(f.root, 'bad\0path')]) {
    assert.throws(() => helpers.inspectPlainPath(bad, file), /ABSOLUTE_PATH_REQUIRED/);
  }
  assert.throws(() => helpers.inspectPlainPath(f.dir + path.sep + '..' + path.sep + 'dir', directory), /PATH_UNSAFE/);
  assert.throws(() => helpers.inspectPlainPath(path.join(f.file, 'child'), { ...file, allowMissing: true }), /PATH_UNSAFE/);
  assert.throws(() => helpers.inspectPlainPath(f.dir, file), /PATH_UNSAFE/);
  assert.throws(() => helpers.inspectPlainPath(path.join(f.dir, 'absent'), file), /PATH_UNSAFE/);
});

test('snapshots reject plain ancestor replacement even with identical file bytes', t => {
  const f = fixture(t);
  const snapshot = helpers.inspectPlainPath(f.file, file);
  fs.renameSync(f.dir, path.join(f.root, 'old'));
  fs.mkdirSync(f.dir);
  fs.writeFileSync(f.file, 'original');
  assert.throws(() => helpers.assertPlainPathUnchanged(snapshot), /PATH_CHANGED/);
  assert.throws(() => helpers.readPlainFile(snapshot), /PATH_CHANGED/);
});

test('snapshot expected absence is not rebased over unexpected creation', t => {
  const f = fixture(t), created = path.join(f.dir, 'new');
  const snapshot = helpers.inspectPlainPath(created, { ...directory, allowMissing: true });
  fs.mkdirSync(created);
  assert.throws(() => helpers.assertPlainPathUnchanged(snapshot), /PATH_CHANGED/);
  // Expected creations may refresh only the missing suffix after checking the old
  // existing identities; directory nlink changes on POSIX must not look like swaps.
  assert.doesNotThrow(() => helpers.assertPlainPathUnchanged({ ...snapshot, missing: [] }));
  assert.doesNotThrow(() => helpers.assertPlainPathUnchanged(helpers.inspectPlainPath(created, directory)));
});

test('verified file reads detect a file replacement at open and always close the descriptor', t => {
  const f = fixture(t), snapshot = helpers.inspectPlainPath(f.file, file);
  const open = fs.openSync, close = fs.closeSync;
  let swapped = false, closes = 0;
  fs.openSync = function (name, ...args) {
    if (name === f.file && !swapped) {
      swapped = true;
      fs.renameSync(f.file, path.join(f.dir, 'old.txt'));
      fs.writeFileSync(f.file, 'replacement');
    }
    return open.call(this, name, ...args);
  };
  fs.closeSync = function (...args) { closes++; return close.apply(this, args); };
  try { assert.throws(() => helpers.readPlainFile(snapshot), /PATH_CHANGED/); }
  finally { fs.openSync = open; fs.closeSync = close; }
  assert.equal(swapped, true);
  assert.equal(closes, 1, 'mismatched opened file is closed');
});

if (process.platform === 'win32') {
  test('native Windows extended namespace resolves to the same plain physical path', t => {
    const f = fixture(t);
    const ordinary = helpers.inspectPlainPath(f.dir, directory);
    const namespaced = helpers.inspectPlainPath(path.toNamespacedPath(f.dir), directory);
    assert.equal(namespaced.realPath, ordinary.realPath);
  });
}
