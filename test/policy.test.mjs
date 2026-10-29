import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { compilePolicy, evaluate, loadPolicy, inside } from '../src/policy.mjs';
import { digest } from '../src/json.mjs';
import { fixture } from './helpers.mjs';

const call = (f, file, tool = 'Write') => ({ host: 'zcode', tool, input: { file_path: file }, cwd: f.workspace });

test('in-scope writes abstain without overriding host permissions', t => {
  const f = fixture(t);
  assert.equal(evaluate(f.policy, call(f, 'src/new.txt')).decision, 'abstain');
});
test('read roots and write roots have independent scope', t => {
  const f = fixture(t), file = path.join(f.locked, 'read.txt');
  fs.writeFileSync(file, 'fixture');
  assert.equal(evaluate(f.policy, call(f, file, 'Read')).decision, 'abstain');
  assert.equal(evaluate(f.policy, call(f, file)).code, 'OUTSIDE_SCOPE');
});
test('prefix lookalike directories are not children', t => {
  const f = fixture(t), sibling = f.src + '-other';
  fs.mkdirSync(sibling);
  assert.equal(evaluate(f.policy, call(f, path.join(sibling, 'a'))).code, 'OUTSIDE_SCOPE');
  assert.equal(inside(f.src, sibling), false);
});
test('traversal components are rejected before filesystem normalization', t => {
  const f = fixture(t);
  assert.equal(evaluate(f.policy, call(f, 'src/../src/a.txt')).decision, 'deny');
});
test('symlink escape with a not-yet-existing leaf is blocked', t => {
  const f = fixture(t);
  fs.symlinkSync(f.outside, path.join(f.src, 'escape'));
  assert.equal(evaluate(f.policy, call(f, 'src/escape/new/deep.txt')).code, 'OUTSIDE_SCOPE');
});
test('dangling symlink fails closed', t => {
  const f = fixture(t);
  fs.symlinkSync(path.join(f.outside, 'missing'), path.join(f.src, 'dangling'));
  assert.equal(evaluate(f.policy, call(f, 'src/dangling')).decision, 'deny');
});
test('an existing in-scope symlink resolves to the actual file', t => {
  const f = fixture(t);
  fs.symlinkSync(path.join(f.src, 'a.txt'), path.join(f.src, 'alias'));
  assert.equal(evaluate(f.policy, call(f, 'src/alias')).decision, 'abstain');
});
test('existing hardlinks cannot be modified through the guard', t => {
  const f = fixture(t);
  fs.linkSync(path.join(f.outside, 'secret.txt'), path.join(f.src, 'linked'));
  assert.equal(evaluate(f.policy, call(f, 'src/linked')).code, 'UNSAFE_WRITE_TARGET');
});
test('directories cannot be mutated by a file tool binding', t => {
  const f = fixture(t);
  assert.equal(evaluate(f.policy, call(f, f.src)).code, 'UNSAFE_WRITE_TARGET');
});
test('VCS metadata remains protected when the whole workspace is writable', t => {
  const f = fixture(t), policy = compilePolicy({ ...f.raw, writeRoots: [f.workspace] });
  assert.equal(evaluate(policy, call(f, '.git/config')).code, 'PROTECTED_PATH');
  assert.equal(evaluate(policy, call(f, 'locked/new')).code, 'PROTECTED_PATH');
});
test('unknown, Shell, delegation and MCP names are denied by default', t => {
  const f = fixture(t);
  for (const tool of ['Bash', 'Task', 'run_code', 'mcp__fs__write', 'constructor']) assert.equal(evaluate(f.policy, call(f, 'src/a', tool)).decision, 'deny');
});
test('missing path, invalid payload and unknown host are refused', t => {
  const f = fixture(t);
  for (const input of [{}, [], null, { file_path: 3 }]) assert.equal(evaluate(f.policy, { host: 'zcode', tool: 'Write', input }).decision, 'deny');
  assert.equal(evaluate(f.policy, { host: 'claude', tool: 'Write', input: {} }).decision, 'deny');
});
test('a relative path without a known cwd is refused', t => {
  const f = fixture(t);
  assert.equal(evaluate(f.policy, { host: 'dsh', tool: 'write_file', input: { path: 'src/a' } }).decision, 'deny');
});
test('absolute DSH paths work without guessing the session cwd', t => {
  const f = fixture(t);
  assert.equal(evaluate(f.policy, { host: 'dsh', tool: 'write_file', input: { path: path.join(f.src, 'a.txt') } }).decision, 'abstain');
});
test('an uncompiled or mutated policy cannot grant access', t => {
  const f = fixture(t);
  assert.equal(evaluate(f.raw, call(f, 'src/a')).code, 'INVALID_POLICY');
  assert.throws(() => { f.policy.writeRoots.push(f.outside); }, TypeError);
});
test('invalid config schema, roots, effects and typo keys fail validation', t => {
  const f = fixture(t);
  for (const raw of [null, { ...f.raw, schemaVersion: 2 }, { ...f.raw, typo: true }, { ...f.raw, writeRoots: [f.outside] },
    { ...f.raw, bindings: { zcode: { Bash: { effect: 'execute', pathKey: 'command' } } } }]) assert.throws(() => compilePolicy(raw));
});
test('stable policy hash is order-independent and changes with scope', t => {
  const f = fixture(t);
  assert.equal(compilePolicy({ ...f.raw }).policyHash, f.policy.policyHash);
  assert.notEqual(compilePolicy({ ...f.raw, writeRoots: [] }).policyHash, f.policy.policyHash);
});
test('policy file must be outside the model-editable workspace', t => {
  const f = fixture(t), p = path.join(f.src, 'policy.json');
  fs.writeFileSync(p, JSON.stringify(f.raw), { mode: 0o600 });
  assert.throws(() => loadPolicy(p), /POLICY_MUST_BE_OUTSIDE_WORKSPACE/);
  assert.equal(loadPolicy(f.policyPath).policyHash, f.policy.policyHash);
});
test('policy symlinks and writable-by-others policies are rejected', t => {
  const f = fixture(t), alias = path.join(f.base, 'alias');
  fs.symlinkSync(f.policyPath, alias);
  assert.throws(() => loadPolicy(alias), /UNSAFE_POLICY_FILE/);
  if (process.platform !== 'win32') {
    fs.chmodSync(f.policyPath, 0o666);
    assert.throws(() => loadPolicy(f.policyPath), /UNSAFE_POLICY_PERMISSIONS/);
  }
});
test('file-as-parent, NUL, foreign separators and cwd escapes fail closed', t => {
  const f = fixture(t);
  for (const file of ['src/a.txt/new', 'src/a\u0000.txt']) assert.equal(evaluate(f.policy, call(f, file)).decision, 'deny');
  if (process.platform === 'win32') {
    // Backslash is a native separator on Windows: resolves to the same in-scope file, not a foreign path.
    assert.equal(evaluate(f.policy, call(f, 'src\\a.txt')).decision, 'abstain');
  } else {
    assert.equal(evaluate(f.policy, call(f, 'src\\a.txt')).decision, 'deny');
  }
  // Native-separator traversal must be rejected before normalization on every platform.
  assert.equal(evaluate(f.policy, call(f, 'src\\..\\..\\secret.txt')).decision, 'deny');
  assert.equal(evaluate(f.policy, { ...call(f, 'new'), cwd: f.outside }).decision, 'deny');
});

test('VCS symlink targets remain protected even after policy compilation', t => {
  const f = fixture(t), policy = compilePolicy({ ...f.raw, writeRoots: [f.workspace] });
  const actual = path.join(f.workspace, 'vcs-data'); fs.mkdirSync(actual);
  fs.rmdirSync(path.join(f.workspace, '.git'));
  fs.symlinkSync(actual, path.join(f.workspace, '.git'));
  assert.equal(evaluate(policy, call(f, '.git/config')).code, 'PROTECTED_PATH');
  assert.equal(evaluate(policy, call(f, 'vcs-data/config')).code, 'PROTECTED_PATH');
});

test('nested repositories keep their VCS metadata protected', t => {
  const f = fixture(t), policy = compilePolicy({ ...f.raw, writeRoots: [f.workspace] });
  fs.mkdirSync(path.join(f.workspace, 'vendor', 'lib', '.git', 'hooks'), { recursive: true });
  assert.equal(evaluate(policy, call(f, 'vendor/lib/.git/hooks/pre-commit')).code, 'PROTECTED_PATH');
  assert.equal(evaluate(policy, call(f, 'vendor/lib/.git')).code, 'PROTECTED_PATH');
});

test('writes through 8.3 short-name aliases of protected roots are blocked (win32)', t => {
  if (process.platform !== 'win32') return t.skip('win32 only');
  const f = fixture(t), longName = 'protected-long-directory-name';
  fs.mkdirSync(path.join(f.workspace, longName));
  const policy = compilePolicy({ ...f.raw, writeRoots: [f.workspace], protectedRoots: [path.join(f.workspace, longName)] });
  // `dir /x` prints the 8.3 short name in the column before the long name (blank when none exists).
  const listing = execFileSync('cmd', ['/c', 'dir', '/a', '/x', f.workspace], { encoding: 'utf8' });
  const cols = listing.split(/\r?\n/).find(line => line.trimEnd().endsWith(` ${longName}`))?.trim().split(/\s+/) ?? [];
  const short = cols.length >= 2 && cols.at(-2) !== '<DIR>' ? cols.at(-2) : null;
  if (!short) return t.skip(`no 8.3 short name for ${longName} on this volume`);
  assert.equal(evaluate(policy, call(f, path.join(f.workspace, short, 'secret.txt'))).code, 'PROTECTED_PATH');
  assert.equal(evaluate(policy, call(f, 'src/new.txt')).decision, 'abstain');
});

test('gitfile-redirected gitdirs stay protected when the whole workspace is writable', t => {
  const f = fixture(t), policy = compilePolicy({ ...f.raw, writeRoots: [f.workspace] });
  fs.mkdirSync(path.join(f.workspace, 'wt'));
  fs.writeFileSync(path.join(f.workspace, 'wt', '.git'), 'gitdir: ../real-git-data\n');
  fs.mkdirSync(path.join(f.workspace, 'real-git-data', 'hooks'), { recursive: true });
  // The pointer sits beside the gitdir (`wt/.git` -> `../real-git-data`), never on the write path.
  assert.equal(evaluate(policy, call(f, 'real-git-data/hooks/pre-commit')).code, 'PROTECTED_PATH');
  assert.equal(evaluate(policy, call(f, 'real-git-data/config')).code, 'PROTECTED_PATH');
  assert.equal(evaluate(policy, call(f, 'src/new.txt')).decision, 'abstain');
});

test('gitfile pointers with garbage content are ignored without crashing', t => {
  const f = fixture(t), policy = compilePolicy({ ...f.raw, writeRoots: [f.workspace] });
  fs.mkdirSync(path.join(f.workspace, 'wt'));
  fs.writeFileSync(path.join(f.workspace, 'wt', '.git'), 'definitely not a gitfile pointer\n');
  assert.equal(evaluate(policy, call(f, 'wt/notes.txt')).decision, 'abstain');
  assert.equal(evaluate(policy, call(f, 'src/new.txt')).decision, 'abstain');
});

test('gitfile pointers accept gitdir paths containing spaces (codex audit #1)', t => {
  const f = fixture(t), policy = compilePolicy({ ...f.raw, writeRoots: [f.workspace] });
  // The audit's exact repro: real git writes the pointer itself via --separate-git-dir,
  // and legal gitdir paths may contain spaces — the parse must capture the whole line.
  const wt = path.join(f.workspace, 'spaced worktree'), gitData = path.join(f.workspace, 'spaced git data');
  fs.mkdirSync(wt);
  execFileSync('git', ['init', '--separate-git-dir', gitData, wt], { encoding: 'utf8' });
  assert.match(fs.readFileSync(path.join(wt, '.git'), 'utf8'), /^gitdir: .*spaced git data/m,
    'the fixture premise: git itself wrote a spaced path into the pointer');
  assert.equal(evaluate(policy, call(f, 'spaced git data/hooks/pre-commit')).code, 'PROTECTED_PATH');
  assert.equal(evaluate(policy, call(f, 'spaced git data/config')).code, 'PROTECTED_PATH');
  assert.equal(evaluate(policy, call(f, 'src/new.txt')).decision, 'abstain');
  // Hand-written pointers, relative and absolute, with spaces in the gitdir path.
  fs.mkdirSync(path.join(f.workspace, 'wt 2'));
  fs.writeFileSync(path.join(f.workspace, 'wt 2', '.git'), 'gitdir: ../real git data 2\n');
  fs.mkdirSync(path.join(f.workspace, 'real git data 2', 'hooks'), { recursive: true });
  assert.equal(evaluate(policy, call(f, 'real git data 2/config')).code, 'PROTECTED_PATH');
  const gitData3 = path.join(f.workspace, 'abs git data 3');
  fs.mkdirSync(path.join(f.workspace, 'wt 3'));
  fs.mkdirSync(path.join(gitData3, 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(f.workspace, 'wt 3', '.git'), `gitdir: ${gitData3}\n`);
  assert.equal(evaluate(policy, call(f, 'abs git data 3/hooks/pre-commit')).code, 'PROTECTED_PATH');
});

test('missing gitdir targets neither crash nor unprotect their future children', t => {
  const f = fixture(t), policy = compilePolicy({ ...f.raw, writeRoots: [f.workspace] });
  fs.mkdirSync(path.join(f.workspace, 'wt'));
  fs.writeFileSync(path.join(f.workspace, 'wt', '.git'), 'gitdir: ../missing-git-data\n');
  assert.equal(evaluate(policy, call(f, 'src/new.txt')).decision, 'abstain');
  assert.equal(evaluate(policy, call(f, 'missing-git-data/hooks/pre-commit')).code, 'PROTECTED_PATH');
});

test('pointer-free ancestor chains keep ordinary writes abstaining', t => {
  const f = fixture(t), policy = compilePolicy({ ...f.raw, writeRoots: [f.workspace] });
  fs.mkdirSync(path.join(f.workspace, 'wt'));
  assert.equal(evaluate(policy, call(f, 'wt/notes.txt')).decision, 'abstain');
  assert.equal(evaluate(policy, call(f, 'src/new.txt')).decision, 'abstain');
});

test('symlinked VCS pointers protect their redirect targets', t => {
  const f = fixture(t), policy = compilePolicy({ ...f.raw, writeRoots: [f.workspace] });
  fs.mkdirSync(path.join(f.workspace, 'wt'));
  fs.mkdirSync(path.join(f.workspace, 'vcs-data', 'hooks'), { recursive: true });
  fs.symlinkSync('../vcs-data', path.join(f.workspace, 'wt', '.git'), 'dir');
  assert.equal(evaluate(policy, call(f, 'vcs-data/hooks/pre-commit')).code, 'PROTECTED_PATH');
  assert.equal(evaluate(policy, call(f, 'src/new.txt')).decision, 'abstain');
});

test('dangling symlinked VCS pointers neither crash nor block ordinary writes', t => {
  const f = fixture(t), policy = compilePolicy({ ...f.raw, writeRoots: [f.workspace] });
  fs.mkdirSync(path.join(f.workspace, 'wt'));
  fs.symlinkSync('../missing-vcs-data', path.join(f.workspace, 'wt', '.git'), 'dir');
  assert.equal(evaluate(policy, call(f, 'src/new.txt')).decision, 'abstain');
});

test('scoped deny decisions carry the policy hash for audit attribution', t => {
  const f = fixture(t), policy = compilePolicy({ ...f.raw, writeRoots: [f.workspace] });
  fs.linkSync(path.join(f.outside, 'secret.txt'), path.join(f.src, 'linked')); // nlink > 1 -> UNSAFE_WRITE_TARGET
  assert.equal(evaluate(f.policy, call(f, 'src/linked')).policyHash, f.policy.policyHash);
  assert.equal(evaluate(policy, call(f, '.git/config')).policyHash, policy.policyHash); // PROTECTED_PATH
  assert.equal(evaluate(f.policy, call(f, path.join(f.outside, 'x'))).policyHash, f.policy.policyHash); // OUTSIDE_SCOPE
});

// --- apply-patch (V4A envelope) parser bindings ---

const patchPolicy = (f, binding = {}) => compilePolicy({
  ...f.raw,
  bindings: {
    zcode: { ...f.raw.bindings.zcode, ApplyPatch: { effect: 'write', parser: 'apply-patch', pathKey: 'patch_text', ...binding } },
    dsh: f.raw.bindings.dsh,
  },
});
const patchCall = (f, patch, cwd = f.workspace) => ({ host: 'zcode', tool: 'ApplyPatch', input: { patch_text: patch }, cwd });
const THREE_FILE_PATCH = [
  '*** Begin Patch',
  '*** Update File: src/a.txt',
  '@@',
  ' original',
  '-old',
  '+new',
  '*** Add File: src/added.txt',
  '+fresh content',
  '*** Update File: src/moved-from.txt',
  '*** Move to: src/moved-to.txt',
  '*** End Patch',
].join('\n');

test('V4A patches abstain only when every extracted path is a writable in-scope target', t => {
  const f = fixture(t), policy = patchPolicy(f);
  fs.writeFileSync(path.join(f.src, 'moved-from.txt'), 'renamed by the patch');
  assert.equal(evaluate(policy, patchCall(f, THREE_FILE_PATCH)).decision, 'abstain');
});
test('one out-of-scope path in a V4A patch rejects the whole call', t => {
  const f = fixture(t), policy = patchPolicy(f);
  const escape = THREE_FILE_PATCH.replace('*** Add File: src/added.txt', '*** Add File: locked/added.txt');
  assert.equal(evaluate(policy, patchCall(f, escape)).code, 'OUTSIDE_SCOPE');
});
test('a Delete File path inside a protected root rejects the whole patch', t => {
  const f = fixture(t);
  const deletion = ['*** Begin Patch', '*** Delete File: locked/victim.txt', '*** End Patch'].join('\n');
  // With writeRoots narrowed to src the deletion is already out of scope...
  assert.equal(evaluate(patchPolicy(f), patchCall(f, deletion)).code, 'OUTSIDE_SCOPE');
  // ...and with the whole workspace writable it still hits the protected root.
  const wide = compilePolicy({
    ...f.raw, writeRoots: [f.workspace],
    bindings: { zcode: { ...f.raw.bindings.zcode, ApplyPatch: { effect: 'write', parser: 'apply-patch', pathKey: 'patch_text' } }, dsh: f.raw.bindings.dsh },
  });
  assert.equal(evaluate(wide, patchCall(f, deletion)).code, 'PROTECTED_PATH');
});
test('missing V4A envelope or zero extracted paths denies as INVALID_PATH_OR_CALL', t => {
  const f = fixture(t), policy = patchPolicy(f);
  // No envelope markers at all.
  assert.equal(evaluate(policy, patchCall(f, '*** Update File: src/a.txt\n+changed')).code, 'INVALID_PATH_OR_CALL');
  // Envelope present, but *** End of File is a section marker, not a path -> zero paths.
  assert.equal(evaluate(policy, patchCall(f, '*** Begin Patch\n*** End of File\n*** End Patch')).code, 'INVALID_PATH_OR_CALL');
  // Non-string patch text is not a patch.
  assert.equal(evaluate(policy, { host: 'zcode', tool: 'ApplyPatch', input: { patch_text: 3 }, cwd: f.workspace }).code, 'INVALID_PATH_OR_CALL');
});
test('V4A patches without a session cwd are denied CWD_REQUIRED', t => {
  const f = fixture(t), policy = patchPolicy(f);
  assert.equal(evaluate(policy, { ...patchCall(f, THREE_FILE_PATCH), cwd: undefined }).code, 'CWD_REQUIRED');
});
test('GNU diff header lines are tolerated as supplement and /dev/null is skipped', t => {
  const f = fixture(t), policy = patchPolicy(f);
  const gnu = ['*** Begin Patch', '--- /dev/null', '+++ b/src/from-gnu.txt', '@@', '+content', '*** End Patch'].join('\n');
  assert.equal(evaluate(policy, patchCall(f, gnu)).decision, 'abstain');
  const escape = ['*** Begin Patch', '+++ b/locked/from-gnu.txt', '*** End Patch'].join('\n');
  assert.equal(evaluate(policy, patchCall(f, escape)).code, 'OUTSIDE_SCOPE');
  // A timestamp after a tab is part of the GNU header line, not of the path.
  const stamped = ['*** Begin Patch', `+++ b/src/stamped.txt\t2026-10-27 12:00:00 +0000`, '*** End Patch'].join('\n');
  assert.equal(evaluate(policy, patchCall(f, stamped)).decision, 'abstain');
});

// --- param-keyed effects (effectKey + readWhen) ---

test('param-keyed effects read only on explicit values and default to write', t => {
  const f = fixture(t), policy = compilePolicy({
    ...f.raw,
    bindings: {
      zcode: f.raw.bindings.zcode,
      dsh: { ...f.raw.bindings.dsh, str_replace_editor: { effectKey: 'command', readWhen: ['view'], pathKey: 'path' } },
    },
  });
  const file = path.join(f.locked, 'read.txt'); // readable root only: locked is outside writeRoots
  const editor = input => ({ host: 'dsh', tool: 'str_replace_editor', input: { path: file, ...input }, cwd: f.workspace });
  assert.equal(evaluate(policy, editor({ command: 'view' })).decision, 'abstain'); // listed value -> read
  assert.equal(evaluate(policy, editor({ command: 'create' })).code, 'OUTSIDE_SCOPE'); // unlisted -> write
  assert.equal(evaluate(policy, editor({ command: 'unknown' })).code, 'OUTSIDE_SCOPE'); // unknown -> write
  assert.equal(evaluate(policy, editor({})).code, 'OUTSIDE_SCOPE'); // missing -> write
  assert.equal(evaluate(policy, editor({ command: 3 })).code, 'OUTSIDE_SCOPE'); // non-string -> write
});

// --- compile-time validation and hash compatibility ---

test('new binding fields are validated at compile time', t => {
  const f = fixture(t);
  const cases = [
    { effect: 'read', parser: 'apply-patch', pathKey: 'patch_text' }, // parser requires effect write
    { effect: 'write', parser: 'gnu-diff', pathKey: 'patch_text' }, // only legal parser value is apply-patch
    { effect: 'write', parser: 'apply-patch', pathKey: 'patch_text', effectKey: 'command', readWhen: ['view'] }, // parser + effectKey
    { effect: 'write', effectKey: 'command', readWhen: ['view'], pathKey: 'path' }, // effect + effectKey are mutually exclusive
    { effectKey: 'command', pathKey: 'path' }, // effectKey without readWhen
    { readWhen: ['view'], pathKey: 'path' }, // readWhen without effectKey (and without effect)
    { effectKey: 'command', readWhen: [], pathKey: 'path' }, // readWhen must be non-empty
    { effectKey: 'command', readWhen: 'view', pathKey: 'path' }, // readWhen must be an array
    { effectKey: 'command', readWhen: ['view', 3], pathKey: 'path' }, // readWhen entries must be strings
    { effectKey: 'constructor', readWhen: ['view'], pathKey: 'path' }, // effectKey is a plain parameter name
  ];
  for (const binding of cases) {
    assert.throws(() => compilePolicy({ ...f.raw, bindings: { zcode: { ApplyPatch: binding }, dsh: {} } }), /INVALID_TOOL_BINDING/,
      JSON.stringify(binding));
  }
});
test('policies without the new fields compile byte-identically (policyHash unchanged)', t => {
  const f = fixture(t), real = p => fs.realpathSync.native(p);
  // Independently constructed pre-feature normalization: same canonical bytes must hash identically.
  const expected = {
    schemaVersion: 1,
    workspace: real(f.workspace),
    readRoots: [real(f.workspace)],
    writeRoots: [real(f.src)],
    // Raw roots sort first, then the pushed VCS root lands at the end (compilePolicy order).
    protectedRoots: [real(f.locked), real(path.join(f.workspace, '.git'))],
    bindings: {
      dsh: { read_file: { effect: 'read', pathKey: 'path' }, write_file: { effect: 'write', pathKey: 'path' } },
      zcode: {
        Edit: { effect: 'write', pathKey: 'file_path' },
        Read: { effect: 'read', pathKey: 'file_path' },
        Write: { effect: 'write', pathKey: 'file_path' },
      },
    },
  };
  assert.equal(digest(expected), f.policy.policyHash);
  // Old-style bindings normalize to exactly the two legacy fields - no leaked keys.
  assert.deepEqual(f.policy.bindings.zcode.Write, { effect: 'write', pathKey: 'file_path' });
  // When a new field IS present it enters the normalized policy and changes the hash.
  const withParser = compilePolicy({
    ...f.raw,
    bindings: { ...f.raw.bindings, zcode: { ...f.raw.bindings.zcode, ApplyPatch: { effect: 'write', parser: 'apply-patch', pathKey: 'patch_text' } } },
  });
  assert.notEqual(withParser.policyHash, f.policy.policyHash);
});
