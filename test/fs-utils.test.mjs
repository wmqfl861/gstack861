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
  let swapped = false, dataFd, dataCloses = 0;
  fs.openSync = function (name, ...args) {
    if (name === f.file && !swapped) {
      swapped = true;
      fs.renameSync(f.file, path.join(f.dir, 'old.txt'));
      fs.writeFileSync(f.file, 'replacement');
      dataFd = open.call(this, name, ...args);
      return dataFd;
    }
    return open.call(this, name, ...args);
  };
  fs.closeSync = function (fd, ...args) {
    if (fd === dataFd) dataCloses++;
    return close.call(this, fd, ...args);
  };
  try { assert.throws(() => helpers.readPlainFile(snapshot), /PATH_CHANGED/); }
  finally { fs.openSync = open; fs.closeSync = close; }
  assert.equal(swapped, true);
  assert.equal(dataCloses, 1, 'mismatched opened data file is closed');
});

if (process.platform === 'win32') {
  test('native Windows extended namespace resolves to the same plain physical path', t => {
    const f = fixture(t);
    const ordinary = helpers.inspectPlainPath(f.dir, directory);
    const namespaced = helpers.inspectPlainPath(path.toNamespacedPath(f.dir), directory);
    assert.equal(namespaced.realPath, ordinary.realPath);
  });
}

// Real files and handles are used throughout. Only metadata is injected to
// reproduce the Windows runner's path-dev=0/fstat-dev!=0 API discrepancy.
function metadataView(overrides, run) {
  const original = Object.fromEntries(['lstatSync', 'fstatSync', 'openSync', 'closeSync', 'readFileSync'].map(key => [key, fs[key]]));
  const handles = new Map(), opened = [];
  const amend = (stat, changes) => stat && changes ? Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, changes) : stat;
  fs.lstatSync = function (name, ...args) {
    const stat = original.lstatSync.call(this, name, ...args);
    return amend(stat, stat && overrides.path?.(String(name), stat));
  };
  fs.openSync = function (name, flags, ...args) {
    overrides.open?.(String(name), flags);
    const fd = original.openSync.call(this, name, flags, ...args);
    const handle = { fd, name: String(name), flags, stats: 0, closed: false };
    handles.set(fd, handle);
    opened.push(handle);
    return fd;
  };
  fs.fstatSync = function (fd, ...args) {
    const stat = original.fstatSync.call(this, fd, ...args), handle = handles.get(fd);
    if (handle) handle.stats++;
    return amend(stat, overrides.fd?.(handle, stat, fd));
  };
  fs.closeSync = function (fd, ...args) {
    const result = original.closeSync.call(this, fd, ...args), handle = handles.get(fd);
    if (handle) { handle.closed = true; handles.delete(fd); }
    overrides.close?.(fd, handle);
    return result;
  };
  fs.readFileSync = function (...args) {
    const bytes = original.readFileSync.apply(this, args);
    overrides.read?.(args[0]);
    return bytes;
  };
  try { return run({ opened, original }); }
  finally {
    Object.assign(fs, original);
    for (const { fd } of handles.values()) original.closeSync(fd);
  }
}

const zeroPathDevice = (_name, stat) => ({ dev: typeof stat.dev === 'bigint' ? 0n : 0 });
const copied = snapshot => ({ ...snapshot, entries: snapshot.entries.map(entry => ({ ...entry, ...(entry.descriptor ? { descriptor: { ...entry.descriptor } } : {}) })), missing: [...snapshot.missing] });

test('identity equality ignores path spelling and directory link counts but retains exact device and descriptor proof', () => {
  assert.equal(typeof helpers.samePlainIdentity, 'function');
  const descriptor = { dev: '9007199254740993', ino: '9007199254740997', kind: 'directory', nlink: '2' };
  const entry = { path: '/old', dev: '0', ino: '9007199254740997', kind: 'directory', nlink: '2', descriptor };
  const moved = { ...entry, path: '/NEW', nlink: '7', descriptor: { ...descriptor, nlink: '7' } };
  assert.equal(helpers.samePlainIdentity(entry, moved), true);
  assert.equal(helpers.samePlainIdentity(entry, { ...moved, dev: '4294967296' }), false);
  assert.equal(helpers.samePlainIdentity(entry, { ...moved, ino: '9007199254740996' }), false);
  assert.equal(helpers.samePlainIdentity(entry, { ...moved, descriptor: { ...descriptor, dev: '9007199254740992' } }), false);
  assert.equal(helpers.samePlainIdentity(entry, { ...moved, descriptor: null }), false);
  const regular = { ...entry, kind: 'file', nlink: '1', descriptor: { ...descriptor, kind: 'file', nlink: '1' } };
  assert.equal(helpers.samePlainIdentity(regular, { ...regular, path: '/moved' }), true);
  assert.equal(helpers.samePlainIdentity(regular, { ...regular, nlink: '2' }), false);
  assert.equal(helpers.samePlainIdentity(regular, { ...regular, descriptor: { ...regular.descriptor, nlink: '2' } }), false);
  assert.equal(helpers.samePlainIdentity(null, regular), false);
  assert.equal(helpers.samePlainIdentity({}, {}), false);
});

test('shared descriptor verifier binds an exclusively created file and never closes its caller descriptor', t => {
  const f = fixture(t), created = path.join(f.dir, 'exclusive.txt');
  assert.equal(typeof helpers.assertPlainFileDescriptor, 'function');
  const fd = fs.openSync(created, 'wx');
  try {
    fs.writeFileSync(fd, 'created');
    const snapshot = helpers.inspectPlainPath(created, file);
    assert.equal(helpers.assertPlainFileDescriptor(snapshot, fd), undefined);
    assert.equal(fs.fstatSync(fd).isFile(), true);
    const other = fs.openSync(f.file, 'r');
    try {
      assert.throws(() => helpers.assertPlainFileDescriptor(snapshot, other), /PATH_CHANGED/);
      assert.equal(fs.fstatSync(other).isFile(), true, 'failed verifier leaves caller ownership intact');
    } finally { fs.closeSync(other); }
  } finally { fs.closeSync(fd); }
  assert.equal(fs.readFileSync(created, 'utf8'), 'created');
});

test('shared descriptor verifier refuses device, inode, kind and hardlink mismatches without closing caller handles', t => {
  const f = fixture(t), snapshot = helpers.inspectPlainPath(f.file, file);
  assert.equal(typeof helpers.assertPlainFileDescriptor, 'function');
  const fd = fs.openSync(f.file, 'r');
  try {
    for (const change of [stat => ({ dev: stat.dev + 1n }), stat => ({ ino: stat.ino + 1n }),
      () => ({ isFile: () => false, isDirectory: () => true }), () => ({ nlink: 2n })]) {
      metadataView({ fd: (_handle, stat, actual) => actual === fd ? change(stat) : null }, () => {
        assert.throws(() => helpers.assertPlainFileDescriptor(snapshot, fd), /PATH_CHANGED/);
      });
      assert.equal(fs.fstatSync(fd).isFile(), true);
    }
  } finally { fs.closeSync(fd); }
});

test('only Windows path-to-descriptor binding permits a nonzero 64-to-32-bit device mapping', t => {
  const f = fixture(t);
  let device = 9007199254740993n;
  metadataView({
    path: (name, stat) => name === f.file ? { dev: device, ino: 9007199254740997n } : null,
    fd: handle => handle?.name === f.file ? { dev: 1n, ino: 9007199254740997n } : null,
  }, () => {
    const snapshot = helpers.inspectPlainPath(f.file, file), entry = snapshot.entries.at(-1);
    assert.equal(entry.dev, '9007199254740993');
    assert.equal(entry.ino, '9007199254740997');
    const fd = fs.openSync(f.file, 'r');
    try {
      if (process.platform === 'win32') {
        assert.doesNotThrow(() => helpers.assertPlainFileDescriptor(snapshot, fd));
        assert.equal(helpers.readPlainFile(snapshot).toString(), 'original');
      } else {
        assert.throws(() => helpers.assertPlainFileDescriptor(snapshot, fd), /PATH_CHANGED/);
        assert.throws(() => helpers.readPlainFile(snapshot), /PATH_CHANGED/);
      }
      device += 4294967296n;
      assert.throws(() => helpers.assertPlainPathUnchanged(snapshot), /PATH_CHANGED/, 'path CAS keeps the original full device bits');
      assert.throws(() => helpers.assertPlainFileDescriptor(snapshot, fd), /PATH_CHANGED/);
    } finally { fs.closeSync(fd); }
  });
});

test('plain inspection retains native lstat errors for caller sanitization', t => {
  const f = fixture(t);
  for (const code of ['EACCES', 'EIO']) {
    const denied = Object.assign(new Error('native lstat fault'), { code, syscall: 'lstat', path: f.file });
    metadataView({ path: name => { if (name === f.file) throw denied; } }, () => {
      assert.throws(() => helpers.inspectPlainPath(f.file, file), error => error === denied && error.code === code);
    });
  }
});

test('plain reads retain native read errors and close the data descriptor', t => {
  const f = fixture(t), snapshot = helpers.inspectPlainPath(f.file, file);
  for (const code of ['EACCES', 'EIO']) {
    const denied = Object.assign(new Error('native read fault'), { code, syscall: 'read' });
    metadataView({ read: fd => { if (typeof fd === 'number') throw denied; } }, ({ opened }) => {
      assert.throws(() => helpers.readPlainFile(snapshot), error => error === denied && error.code === code);
      assert.ok(opened.length > 0 && opened.every(handle => handle.closed));
    });
  }
});

test('plain read cleanup never replaces the primary native read error', t => {
  const f = fixture(t), snapshot = helpers.inspectPlainPath(f.file, file);
  const denied = Object.assign(new Error('native read fault'), { code: 'EACCES', syscall: 'read' });
  const closeError = Object.assign(new Error('native close fault'), { code: 'EIO', syscall: 'close' });
  // Witness closes happen before the data read under dev=0 paths; this case is
  // about the cleanup close that follows the primary read fault.
  let readFailed = false;
  metadataView({
    read: fd => { if (typeof fd === 'number') { readFailed = true; throw denied; } },
    close: () => { if (readFailed) throw closeError; },
  }, ({ opened }) => {
    assert.throws(() => helpers.readPlainFile(snapshot), error => error === denied && error.code === 'EACCES');
    assert.ok(opened.length > 0 && opened.every(handle => handle.closed));
  });
});

if (process.platform === 'win32') {
  test('Windows zero-device inspection and reads retain native lstat errors outside witness opens', t => {
    const f = fixture(t);
    let denied;
    metadataView({ path: (name, stat) => {
      if (denied && name === f.file) throw denied;
      return zeroPathDevice(name, stat);
    } }, () => {
      const snapshot = helpers.inspectPlainPath(f.file, file);
      denied = Object.assign(new Error('native lstat fault'), { code: 'EACCES', syscall: 'lstat', path: f.file });
      assert.throws(() => helpers.inspectPlainPath(f.file, file), error => error === denied && error.code === 'EACCES');
      assert.throws(() => helpers.readPlainFile(snapshot), error => error === denied && error.code === 'EACCES');
    });
  });

  test('Windows zero-device witness verification has linear path-query cost and keeps root-to-leaf chain brackets', t => {
    const f = fixture(t), nested = path.join(f.dir, 'deep', 'deeper');
    fs.mkdirSync(nested, { recursive: true });
    const deeperFile = path.join(nested, 'notes.txt');
    fs.writeFileSync(deeperFile, 'original');
    const queries = [];
    metadataView({ path: (name, stat) => { queries.push(name); return zeroPathDevice(name, stat); } }, ({ opened }) => {
      for (const filename of [f.file, deeperFile]) {
        queries.length = 0;
        const snapshot = helpers.inspectPlainPath(filename, file), n = snapshot.entries.length;
        const captureQueries = queries.length;
        queries.length = 0;
        const firstOpen = opened.length;
        helpers.assertPlainPathUnchanged(snapshot);
        const assertionQueries = queries.length;
        assert.ok(assertionQueries <= 6 * n, `assertion path queries ${assertionQueries} exceed linear bound ${6 * n}`);
        assert.deepEqual(queries.slice(0, n), snapshot.entries.map(entry => entry.path));
        assert.deepEqual(queries.slice(-n), snapshot.entries.map(entry => entry.path));
        assert.deepEqual(opened.slice(firstOpen).map(handle => handle.name), snapshot.entries.map(entry => entry.path));
        assert.ok(captureQueries <= 12 * n, `capture path queries ${captureQueries} exceed linear bound ${12 * n}`);
        queries.length = 0;
        assert.equal(helpers.readPlainFile(snapshot).toString(), 'original');
        assert.ok(queries.length <= 36 * n, `read path queries ${queries.length} exceed linear bound ${36 * n}`);
        assert.ok(opened.every(handle => handle.closed));
      }
    });
  });
}

if (process.platform === 'win32') {
  test('Windows verified reads refuse descriptor device changes even when both values separately bind to the full path device', t => {
    const f = fixture(t);
    let changed = false;
    metadataView({
      path: name => name === f.file ? { dev: 9007199254740993n } : null,
      fd: handle => handle?.name === f.file ? { dev: changed ? 1n : 9007199254740993n } : null,
      read: fd => { if (typeof fd === 'number') changed = true; },
    }, ({ opened }) => {
      const snapshot = helpers.inspectPlainPath(f.file, file);
      assert.throws(() => helpers.readPlainFile(snapshot), /PATH_CHANGED/);
      assert.equal(changed, true);
      assert.ok(opened.every(handle => handle.closed));
    });
  });

  test('Windows zero-device file capture saves an enumerable frozen path-free witness across spreads and renames', t => {
    const f = fixture(t), moved = path.join(f.dir, 'moved.txt');
    metadataView({ path: zeroPathDevice }, ({ opened }) => {
      const snapshot = helpers.inspectPlainPath(f.file, file);
      for (const entry of snapshot.entries) {
        assert.equal(entry.dev, '0');
        assert.ok(Object.hasOwn(entry, 'descriptor') && Object.keys(entry).includes('descriptor'));
        assert.ok(Object.isFrozen(entry) && Object.isFrozen(entry.descriptor));
        assert.deepEqual(Object.keys(entry.descriptor).sort(), ['dev', 'ino', 'kind', 'nlink']);
        assert.equal(entry.descriptor.ino, entry.ino);
        assert.equal(entry.descriptor.kind, entry.kind);
        assert.equal(typeof entry.descriptor.dev, 'string');
        assert.notEqual(entry.descriptor.dev, '0');
      }
      assert.equal(snapshot.entries.at(-1).descriptor.nlink, '1');
      assert.equal(helpers.readPlainFile(copied(snapshot)).toString(), 'original');
      assert.equal(helpers.readPlainFile(JSON.parse(JSON.stringify(snapshot))).toString(), 'original');
      fs.renameSync(f.file, moved);
      const rebased = { ...copied(snapshot), path: moved, realPath: moved,
        entries: [...snapshot.entries.slice(0, -1), { ...snapshot.entries.at(-1), path: moved }] };
      assert.equal(helpers.readPlainFile(rebased).toString(), 'original');
      assert.deepEqual(rebased.entries.slice(0, -1), snapshot.entries.slice(0, -1));
      assert.ok(opened.length > 0 && opened.every(handle => handle.closed), 'all independent witnesses and data descriptors close');
      for (const { flags } of opened) {
        assert.equal(typeof flags, 'number');
        assert.equal(flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC), 0);
        for (const optional of ['O_NOFOLLOW', 'O_NONBLOCK']) {
          if (fs.constants[optional]) assert.equal(flags & fs.constants[optional], fs.constants[optional]);
        }
      }
    });
  });

  test('Windows zero-device witnesses preserve exact decimal identities above 2^53', t => {
    const f = fixture(t);
    metadataView({
      path: (name, stat) => name === f.file ? { dev: 0n, ino: 9007199254740997n } : null,
      fd: handle => handle?.name === f.file ? { dev: 9007199254740993n, ino: 9007199254740997n } : null,
    }, () => {
      const snapshot = helpers.inspectPlainPath(f.file, file), leaf = snapshot.entries.at(-1);
      assert.deepEqual(leaf.descriptor, { dev: '9007199254740993', ino: '9007199254740997', kind: 'file', nlink: '1' });
      assert.equal(helpers.readPlainFile(copied(snapshot)).toString(), 'original');
    });
  });

  test('Windows zero-device exclusive file binding compares the caller fd with an independent saved witness', t => {
    const f = fixture(t), created = path.join(f.dir, 'exclusive.txt');
    assert.equal(typeof helpers.assertPlainFileDescriptor, 'function');
    const fd = fs.openSync(created, 'wx');
    try {
      fs.writeFileSync(fd, 'created');
      let mismatch = false;
      metadataView({
        path: zeroPathDevice,
        fd: (_handle, stat, actual) => actual === fd && mismatch ? { dev: stat.dev + 1n } : null,
      }, ({ opened }) => {
        const snapshot = helpers.inspectPlainPath(created, file);
        assert.equal(helpers.assertPlainFileDescriptor(copied(snapshot), fd), undefined);
        mismatch = true;
        assert.throws(() => helpers.assertPlainFileDescriptor(snapshot, fd), /PATH_CHANGED/);
        assert.ok(opened.every(handle => handle.closed), 'temporary witnesses close on success and refusal');
      });
      assert.equal(fs.fstatSync(fd).isFile(), true);
    } finally { fs.closeSync(fd); }
    assert.equal(fs.readFileSync(created, 'utf8'), 'created');
  });

  test('Windows saved zero-device witness refuses two later descriptors that both switch device with the same inode', t => {
    const f = fixture(t);
    let switched = false;
    metadataView({
      path: zeroPathDevice,
      fd: (handle, stat) => switched && handle?.name === f.file ? { dev: stat.dev + 1n } : null,
    }, ({ opened }) => {
      const snapshot = helpers.inspectPlainPath(f.file, file);
      switched = true;
      const first = fs.openSync(f.file, 'r'), second = fs.openSync(f.file, 'r');
      try {
        const a = fs.fstatSync(first, { bigint: true }), b = fs.fstatSync(second, { bigint: true });
        assert.equal(a.dev, b.dev);
        assert.equal(a.ino, b.ino);
        assert.throws(() => helpers.assertPlainPathUnchanged(copied(snapshot)), /PATH_CHANGED/);
        assert.throws(() => helpers.assertPlainFileDescriptor(snapshot, first), /PATH_CHANGED/);
        assert.throws(() => helpers.readPlainFile(snapshot), /PATH_CHANGED/);
        assert.equal(fs.fstatSync(first, { bigint: true }).isFile(), true, 'the caller fd remains open after refusal');
      } finally { fs.closeSync(first); fs.closeSync(second); }
      assert.ok(opened.every(handle => handle.closed));
    });
  });

  test('Windows zero-device verifier refuses an independently reopened pathname that disagrees with the original fd', t => {
    const f = fixture(t), fd = fs.openSync(f.file, 'r');
    let switched = false;
    try {
      metadataView({
        path: zeroPathDevice,
        fd: (handle, stat, actual) => switched && actual !== fd && handle?.name === f.file ? { dev: stat.dev + 1n } : null,
      }, ({ opened }) => {
        const snapshot = helpers.inspectPlainPath(f.file, file);
        switched = true;
        assert.throws(() => helpers.assertPlainFileDescriptor(snapshot, fd), /PATH_CHANGED/);
        assert.ok(opened.every(handle => handle.closed));
      });
      assert.equal(fs.fstatSync(fd).isFile(), true);
    } finally { fs.closeSync(fd); }
  });

  test('Windows zero-device ancestor and directory-lock rechecks compare saved witnesses while ignoring directory link and time changes', t => {
    const f = fixture(t);
    let changedLinks = false, switched = false;
    metadataView({
      path: (name, stat) => ({ ...zeroPathDevice(name, stat), ...(changedLinks && stat.isDirectory() ? { nlink: stat.nlink + 4n, mtimeNs: stat.mtimeNs + 1000000n } : {}) }),
      fd: (handle, stat) => ({ ...(changedLinks && stat.isDirectory() ? { nlink: stat.nlink + 4n, mtimeNs: stat.mtimeNs + 1000000n } : {}),
        ...(switched && handle?.name === f.dir ? { dev: stat.dev + 1n } : {}) }),
    }, ({ opened }) => {
      const snapshot = helpers.inspectPlainPath(f.file, file), lock = helpers.inspectPlainPath(f.dir, directory);
      changedLinks = true;
      fs.mkdirSync(path.join(f.dir, 'new-child'));
      assert.doesNotThrow(() => helpers.assertPlainPathUnchanged(copied(snapshot)));
      assert.doesNotThrow(() => helpers.assertPlainPathUnchanged(copied(lock)));
      assert.equal(helpers.readPlainFile(snapshot).toString(), 'original');
      switched = true;
      assert.throws(() => helpers.assertPlainPathUnchanged(copied(snapshot)), /PATH_CHANGED/);
      assert.throws(() => helpers.assertPlainPathUnchanged(copied(lock)), /PATH_CHANGED/);
      assert.throws(() => helpers.readPlainFile(snapshot), /PATH_CHANGED/);
      assert.ok(opened.every(handle => handle.closed));
    });
  });

  test('Windows required zero-device directory handles fail closed during capture and later assertions', t => {
    const f = fixture(t);
    let unavailable = false;
    metadataView({
      path: zeroPathDevice,
      open: name => { if (unavailable && name === f.dir) throw Object.assign(new Error('directory handle unavailable'), { code: 'EACCES' }); },
    }, ({ opened }) => {
      const snapshot = helpers.inspectPlainPath(f.file, file);
      unavailable = true;
      assert.throws(() => helpers.inspectPlainPath(f.file, file), /PATH_UNSAFE/);
      assert.throws(() => helpers.assertPlainPathUnchanged(snapshot), /PATH_CHANGED/);
      assert.throws(() => helpers.readPlainFile(snapshot), /PATH_CHANGED/);
      assert.ok(opened.every(handle => handle.closed));
    });
  });

  test('Windows zero-device capture refuses unstable descriptor devices and closes its witness', t => {
    const f = fixture(t);
    metadataView({
      path: zeroPathDevice,
      fd: (handle, stat) => handle?.name === f.file && handle.stats > 1 ? { dev: stat.dev + 1n } : null,
    }, ({ opened }) => {
      assert.throws(() => helpers.inspectPlainPath(f.file, file), /PATH_UNSAFE/);
      assert.ok(opened.length > 0 && opened.every(handle => handle.closed));
    });
  });

  test('Windows zero-device capture refuses ancestor changes during the independent open', t => {
    const f = fixture(t);
    let changed = false;
    metadataView({
      path: (name, stat) => ({ ...zeroPathDevice(name, stat), ...(changed && name === f.dir ? { ino: stat.ino + 1n } : {}) }),
      open: name => { if (name === f.file) changed = true; },
    }, ({ opened }) => {
      assert.throws(() => helpers.inspectPlainPath(f.file, file), /PATH_UNSAFE/);
      assert.ok(opened.length > 0 && opened.every(handle => handle.closed));
    });
  });

  test('Windows zero-device snapshots refuse missing proof and same-byte directory replacement', t => {
    const f = fixture(t);
    metadataView({ path: zeroPathDevice }, () => {
      const snapshot = helpers.inspectPlainPath(f.file, file), noProof = copied(snapshot);
      delete noProof.entries.at(-1).descriptor;
      assert.throws(() => helpers.assertPlainPathUnchanged(noProof), /PATH_CHANGED/);
      assert.throws(() => helpers.readPlainFile(noProof), /PATH_CHANGED/);
      fs.renameSync(f.dir, path.join(f.root, 'old'));
      fs.mkdirSync(f.dir);
      fs.writeFileSync(f.file, 'original');
      assert.throws(() => helpers.assertPlainPathUnchanged(snapshot), /PATH_CHANGED/);
      assert.throws(() => helpers.readPlainFile(snapshot), /PATH_CHANGED/);
    });
  });

  test('Windows zero-device verified reads check the data descriptor again after reading and close it on refusal', t => {
    const f = fixture(t);
    let changedFd;
    metadataView({
      path: zeroPathDevice,
      fd: (_handle, stat, fd) => fd === changedFd ? { dev: stat.dev + 1n } : null,
      read: fd => { if (typeof fd === 'number') changedFd = fd; },
    }, ({ opened }) => {
      const snapshot = helpers.inspectPlainPath(f.file, file);
      assert.throws(() => helpers.readPlainFile(snapshot), /PATH_CHANGED/);
      assert.equal(typeof changedFd, 'number', 'the verified read reached the data read before mutation');
      assert.ok(opened.every(handle => handle.closed));
    });
  });
}
