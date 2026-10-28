import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { canonicalRemote, legacyRemoteSlug, remoteSlug, sanitize } from '../src/remote-identity.mjs';
import { resolveIdentity, defaultStateRoot, physicalPath } from '../src/slug.mjs';

// Port of upstream bin/gstack-slug's identity half (rules 0-4 + v2 cache) and
// its lib/remote-identity.ts twin; the fixtures here are real directories and
// real git repos (remote add only — no network, no fetch).

const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });

/** Realpath'd temp root (win32 8.3/defender case quirks must not leak into key comparisons). */
function temp(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gstack861-slug-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

/** Real git fixture, origin set without any network access. git <2.28 fallback per b20 precedent. */
function repo(t, url, name = 'repo') {
  const base = temp(t);
  const root = path.join(base, name);
  fs.mkdirSync(root);
  try { git(['init', '--initial-branch=main'], root); } catch { git(['init'], root); git(['symbolic-ref', 'HEAD', 'refs/heads/main'], root); }
  git(['remote', 'add', 'origin', url], root);
  return { base, root, stateRoot: path.join(base, 'state') };
}

/** Injectable counting git runner (the zero-spawn spy). */
function countingGit(handler) {
  const calls = [];
  return { calls, run(args, cwd) { calls.push(args); return handler ? handler(args, cwd) : git(args, cwd); } };
}

// Cache-key encoding, mirroring the ledgered win32 rule (':','/','\' all fold on win32; POSIX keeps upstream's tr '/' '_').
const encodeKey = p => (process.platform === 'win32' ? p.replace(/[:/\\]/g, '_') : p.replace(/\//g, '_'));
const cacheFile = (stateRoot, dir) => path.join(stateRoot, 'slug-cache', encodeKey(dir));
const readEntry = f => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null);

const sink = () => { const lines = []; return { lines, write(s) { lines.push(s); } }; };
const mkfile = (p, content) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, content); };

test('1. remote-identity golden vectors: upstream fixture replayed byte-for-byte', () => {
  // test/fixtures/remote-identity-vectors.json at pinned commit 5755601: [url, canonical, slug, legacy_slug].
  const vectors = [
    ["https://github.com/garrytan/gstack.git", "github.com/garrytan/gstack", "garrytan-gstack", "garrytan-gstack"],
    ["https://github.com/garrytan/gstack", "github.com/garrytan/gstack", "garrytan-gstack", "garrytan-gstack"],
    ["git@github.com:garrytan/gstack.git", "github.com/garrytan/gstack", "garrytan-gstack", "garrytan-gstack"],
    ["ssh://git@github.com/garrytan/gstack.git", "github.com/garrytan/gstack", "garrytan-gstack", "garrytan-gstack"],
    ["https://GitHub.COM/garrytan/gstack/", "github.com/garrytan/gstack", "httpsGitHub.COMgarrytangstack", "httpsGitHub.COMgarrytangstack"],
    ["https://gitlab.com/customer-a/product/repo.git", "gitlab.com/customer-a/product/repo", "product-repo-5eca1fe041984543", "product-repo"],
    ["git@gitlab.com:customer-a/product/repo.git", "gitlab.com/customer-a/product/repo", "product-repo-5eca1fe041984543", "product-repo"],
    ["ssh://git@gitlab.com:2222/customer-a/product/repo.git", "gitlab.com/customer-a/product/repo", "product-repo-5eca1fe041984543", "product-repo"],
    ["https://oauth2:PASSWORD@GitLab.com:8443/customer-a/product/repo.git", "gitlab.com/customer-a/product/repo", "product-repo-5eca1fe041984543", "product-repo"],
    ["https://gitlab.com/customer-b/product/repo.git", "gitlab.com/customer-b/product/repo", "product-repo-3c13cab341f442f8", "product-repo"],
    ["git@gitlab.example.com:group/sub/team/repo.git", "gitlab.example.com/group/sub/team/repo", "team-repo-da3955fc2f81a1a1", "team-repo"],
    ["https://gitlab.example.com/group/sub/team/repo", "gitlab.example.com/group/sub/team/repo", "team-repo-da3955fc2f81a1a1", "team-repo"],
    ["https://dev.azure.com/org/project/_git/repo", "dev.azure.com/org/project/repo", "project-repo-a4383ea5249af29a", "_git-repo"],
    ["https://org@dev.azure.com/org/project/_git/repo", "dev.azure.com/org/project/repo", "project-repo-a4383ea5249af29a", "_git-repo"],
    ["git@ssh.dev.azure.com:v3/org/project/repo", "dev.azure.com/org/project/repo", "project-repo-a4383ea5249af29a", "project-repo"],
    ["https://org.visualstudio.com/project/_git/repo", "dev.azure.com/org/project/repo", "project-repo-a4383ea5249af29a", "_git-repo"],
    ["https://org.visualstudio.com/DefaultCollection/project/_git/repo", "dev.azure.com/org/project/repo", "project-repo-a4383ea5249af29a", "_git-repo"],
    ["org@vs-ssh.visualstudio.com:v3/org/project/repo", "dev.azure.com/org/project/repo", "project-repo-a4383ea5249af29a", "project-repo"],
    ["https://bitbucket.example.com/scm/proj/repo.git", "bitbucket.example.com/proj/repo", "proj-repo", "proj-repo"],
    ["ssh://git@bitbucket.example.com:7999/proj/repo.git", "bitbucket.example.com/proj/repo", "proj-repo", "proj-repo"],
    ["/srv/git/team/product/repo.git", "/srv/git/team/product/repo", "product-repo", "product-repo"],
    ["file:///srv/git/repo.git", "/srv/git/repo", "git-repo", "git-repo"],
    ["../sibling-repo", "../sibling-repo", "..sibling-repo", "..sibling-repo"],
    ["..", "..", "", ""],
    ["https://host/onlyrepo.git", "host/onlyrepo", "host-onlyrepo", "host-onlyrepo"],
    ["C:/repos/a/b/c.git", "C:/repos/a/b/c", "b-c", "b-c"],
    ["https://[2001:db8::1]:8443/grp/sub/repo.git", "[2001:db8::1]/grp/sub/repo", "sub-repo-4278116e81ebff80", "sub-repo"],
  ];
  for (const [url, canonical, slug, legacy] of vectors) {
    assert.equal(canonicalRemote(url).canonical, canonical, `canonical of ${url}`);
    assert.equal(remoteSlug(url), slug, `slug of ${url}`);
    assert.equal(legacyRemoteSlug(url), legacy, `legacy slug of ${url}`);
  }
});

test('2. remote-identity RC2 branches: empty URL, Windows-drive scp exclusion, sanitizer', () => {
  assert.deepEqual(canonicalRemote(''), { canonical: '', hosted: false, segments: [] });
  // A drive path is NOT an scp remote (RC2 win32 payload): backslash and slash spellings stay local.
  assert.equal(canonicalRemote('C:\\work\\repo.git').canonical, 'C:\\work\\repo');
  assert.equal(canonicalRemote('C:/work/repo.git').hosted, false);
  // "C:" at end-of-string is excluded too; a drive-relative "c:x" is not (upstream regex quirk, kept).
  assert.equal(canonicalRemote('C:').hosted, false);
  assert.equal(canonicalRemote('c:relative').hosted, true);
  // Local keepRoot: a lone "/" root survives; hosted stripping empties stray slashes.
  assert.equal(canonicalRemote('/').canonical, '/');
  assert.equal(canonicalRemote('https://h//a//b//').canonical, 'h/a/b');
  // IPv6 host keeps its brackets, drops port and userinfo, beats the port split.
  assert.equal(canonicalRemote('ssh://u@[2001:DB8::7]:2222/g/a/b.git').canonical, '[2001:db8::7]/g/a/b');
  // Sanitizer: everything outside [a-zA-Z0-9._-] goes; ".." rejection lives in the callers.
  assert.equal(sanitize('a/b:c d!'), 'abcd');
  assert.equal(legacyRemoteSlug('..'), '');
  assert.equal(remoteSlug('..'), '');
});

test('3. GSTACK_PROJECT_SLUG pins the slug, is sanitized, ignores "."/"..", and is never cached', t => {
  const r = repo(t, 'https://github.com/garrytan/gstack.git');
  const pinned = resolveIdentity({ cwd: r.root, env: { GSTACK_PROJECT_SLUG: 'my slug!' }, stateRoot: r.stateRoot });
  assert.equal(pinned.slug, 'myslug');
  assert.ok(!fs.existsSync(path.join(r.stateRoot, 'slug-cache')), 'an env pin must never write the cache');
  // "." is ignored for the slug, but a SET override still never caches (upstream SLUG_FROM_ENV=1).
  const dotted = resolveIdentity({ cwd: r.root, env: { GSTACK_PROJECT_SLUG: '.' }, stateRoot: r.stateRoot });
  assert.equal(dotted.slug, 'garrytan-gstack');
  assert.ok(!fs.existsSync(path.join(r.stateRoot, 'slug-cache')), 'a set-but-ignored pin still never caches');
  // An env value that sanitizes to nothing behaves the same: resolved identity, no cache write.
  const slashed = resolveIdentity({ cwd: r.root, env: { GSTACK_PROJECT_SLUG: '///' }, stateRoot: r.stateRoot });
  assert.equal(slashed.slug, 'garrytan-gstack');
  assert.ok(!fs.existsSync(path.join(r.stateRoot, 'slug-cache')));
  // Unset env: resolution caches normally (the control).
  const plain = resolveIdentity({ cwd: r.root, env: {}, stateRoot: r.stateRoot });
  assert.equal(plain.slug, 'garrytan-gstack');
  assert.equal(readEntry(cacheFile(r.stateRoot, r.root)), 'v2:garrytan-gstack');
});

test('4. markers: outermost STRONG beats WEAK; WEAK alone anchors; vendored sub-repo keeps its remote slug', t => {
  const base = temp(t);
  // Weak above strong: package.json (strong) wins over the higher README.md.
  fs.mkdirSync(path.join(base, 'w', 's', 'x'), { recursive: true });
  fs.writeFileSync(path.join(base, 'w', 'README.md'), 'x');
  fs.writeFileSync(path.join(base, 'w', 's', 'package.json'), '{}');
  const strong = resolveIdentity({ cwd: path.join(base, 'w', 's', 'x'), env: {}, stateRoot: path.join(base, 'st1') });
  assert.equal(strong.projectRoot, physicalPath(path.join(base, 'w', 's')));
  assert.equal(strong.slug, 's');
  // Weak only: README.md anchors the content folder.
  fs.mkdirSync(path.join(base, 'v', 'inner'), { recursive: true });
  fs.writeFileSync(path.join(base, 'v', 'README'), 'x');
  const weak = resolveIdentity({ cwd: path.join(base, 'v', 'inner'), env: {}, stateRoot: path.join(base, 'st2') });
  assert.equal(weak.slug, 'v');
  assert.equal(weak.projectRoot, physicalPath(path.join(base, 'v')));
});

test('5. allow-list: build artifacts (dist/.vercel/.next/node_modules) are not markers', t => {
  const base = temp(t);
  fs.mkdirSync(path.join(base, 'art', 'dist', '.vercel'), { recursive: true });
  fs.mkdirSync(path.join(base, 'art', 'node_modules', 'left-pad'), { recursive: true });
  fs.mkdirSync(path.join(base, 'art', 'site'), { recursive: true });
  fs.writeFileSync(path.join(base, 'art', 'dist', '.vercel', 'project.json'), '{}');
  // cwd BELOW dist: if dist/.vercel were a marker, rule 3 would give slug 'dist'; the allow-list gives rule 4.
  const id = resolveIdentity({ cwd: path.join(base, 'art', 'dist'), env: {}, stateRoot: path.join(base, 'st') });
  assert.equal(id.slug, 'dist'); // rule 4: pwd basename, no project root found
  assert.equal(id.projectRoot, physicalPath(path.join(base, 'art', 'dist'))); // no root → identity root = cwd
  // An artifact dir NEXT TO the cwd must not anchor it either (node_modules is not a marker).
  const id2 = resolveIdentity({ cwd: path.join(base, 'art', 'site'), env: {}, stateRoot: path.join(base, 'st2') });
  assert.equal(id2.slug, 'site'); // if node_modules were a marker, rule 3 would give 'art'
});

test('6. walk-up: a subdir resolves through the outer repo (slug from remote, root = repo root)', t => {
  const r = repo(t, 'https://github.com/garrytan/gstack.git');
  fs.writeFileSync(path.join(r.root, 'package.json'), '{}');
  const deep = path.join(r.root, 'sub', 'deeper');
  fs.mkdirSync(deep, { recursive: true });
  const id = resolveIdentity({ cwd: deep, env: {}, stateRoot: r.stateRoot });
  assert.equal(id.slug, 'garrytan-gstack');
  assert.equal(id.remote, 'github.com/garrytan/gstack');
  assert.equal(id.projectRoot, physicalPath(r.root));
  assert.equal(id.branch, 'unknown'); // unborn HEAD: rev-parse fails silently, upstream semantics
});

test('7. empty-shell ancestor fix: a stray .git without origin anchors nothing; the real repo below wins', t => {
  const base = temp(t);
  fs.mkdirSync(path.join(base, 'stray', '.git'), { recursive: true }); // stray empty ~/.git shape — no origin can resolve
  const r = path.join(base, 'stray', 'real');
  fs.mkdirSync(path.join(r, 'w', 'deep'), { recursive: true });
  try { git(['init', '--initial-branch=main'], r); } catch { git(['init'], r); }
  git(['remote', 'add', 'origin', 'https://github.com/garrytan/gstack.git'], r);
  const id = resolveIdentity({ cwd: path.join(r, 'w', 'deep'), env: {}, stateRoot: path.join(base, 'st') });
  // Pre-2026-08-17 behavior would degrade every repo below the stray to SLUG=<stray-basename>.
  assert.equal(id.slug, 'garrytan-gstack');
  assert.equal(id.projectRoot, physicalPath(r));
});

test('8. nested-group buckets: gitlab 3+ segments hash, GitHub 2 segments stay legacy', t => {
  const gl = repo(t, 'https://gitlab.com/customer-a/product/repo.git', 'glrepo');
  const a = resolveIdentity({ cwd: gl.root, env: {}, stateRoot: gl.stateRoot });
  assert.equal(a.slug, 'product-repo-5eca1fe041984543');
  assert.equal(a.legacySlug, 'product-repo'); // pre-#3003 bucket, different
  assert.equal(a.remote, 'gitlab.com/customer-a/product/repo');
  const gh = repo(t, 'https://github.com/garrytan/gstack.git', 'ghrepo');
  const b = resolveIdentity({ cwd: gh.root, env: {}, stateRoot: gh.stateRoot });
  assert.equal(b.slug, 'garrytan-gstack'); // no bucket moves for GitHub
  assert.equal(b.legacySlug, ''); // legacy == slug → empty
  assert.equal(b.remote, 'github.com/garrytan/gstack');
});

test('9. ssh host alias is a different canonical host than the https spelling', t => {
  const alias = repo(t, 'git@work-gitlab:customer-a/product/repo.git', 'aliasrepo');
  const https = repo(t, 'https://gitlab.com/customer-a/product/repo.git', 'httpsrepo');
  const a = resolveIdentity({ cwd: alias.root, env: {}, stateRoot: alias.stateRoot });
  const b = resolveIdentity({ cwd: https.root, env: {}, stateRoot: https.stateRoot });
  assert.equal(a.remote, 'work-gitlab/customer-a/product/repo');
  assert.notEqual(a.remote, b.remote);
  assert.notEqual(a.slug, b.slug); // pin aliases with GSTACK_PROJECT_SLUG, never silently merged
});

test('10. clean v2 hit outside git: ZERO git spawns (counting runner)', t => {
  const base = temp(t);
  const plain = path.join(base, 'plain');
  fs.mkdirSync(plain);
  mkfile(cacheFile(path.join(base, 'st'), plain), 'v2:frozen-slug');
  const counter = countingGit(() => { throw new Error('UNEXPECTED_GIT_SPAWN'); });
  const id = resolveIdentity({ cwd: plain, env: {}, stateRoot: path.join(base, 'st'), runGit: counter.run });
  assert.equal(counter.calls.length, 0, 'a clean v2 hit must resolve without spawning git');
  assert.equal(id.slug, 'frozen-slug');
  assert.equal(id.branch, 'unknown'); // no .git above → lookup skipped, not failed
});

test('11. clean v2 hit inside a repo: zero slug-path spawns (the only call is the branch lookup)', t => {
  const r = repo(t, 'https://github.com/garrytan/gstack.git');
  mkfile(cacheFile(r.stateRoot, physicalPath(path.join(r.root, '.git'))), 'v2:zz-other-repo');
  const counter = countingGit();
  const id = resolveIdentity({ cwd: r.root, env: {}, stateRoot: r.stateRoot, runGit: counter.run });
  // Neither heal shape fires (cached matches no basename), so the remote walk never runs.
  assert.deepEqual(counter.calls, [['rev-parse', '--abbrev-ref', 'HEAD']]);
  assert.equal(id.slug, 'zz-other-repo');
  assert.equal(id.branch, 'unknown'); // unborn HEAD; only slug+branch read → identity getters never fire
});

test('12. unversioned entry: sticky value kept and rewritten as v2; MAIN key beats the pwd key', t => {
  const r = repo(t, 'https://github.com/garrytan/gstack.git');
  const sub = path.join(r.root, 'sub');
  fs.mkdirSync(sub);
  // MAIN key (PHYSICAL repo root — pre-#2767 spelling) and the subdir's own pwd key both hold old entries.
  mkfile(cacheFile(r.stateRoot, physicalPath(r.root)), 'oldmain');
  mkfile(cacheFile(r.stateRoot, sub), 'oldpwd');
  const id = resolveIdentity({ cwd: sub, env: {}, stateRoot: r.stateRoot });
  // Read order commondir → MAIN → pwd picks 'oldmain'; #2212 stickiness keeps it (2-segment remote).
  assert.equal(id.slug, 'oldmain');
  assert.equal(readEntry(cacheFile(r.stateRoot, sub)), 'v2:oldmain');
  assert.equal(readEntry(cacheFile(r.stateRoot, physicalPath(path.join(r.root, '.git')))), 'v2:oldmain');
});

test('13. unversioned entry that IS the legacy slug of a 3+-segment remote upgrades to the hashed slug', t => {
  const r = repo(t, 'https://gitlab.com/customer-a/product/repo.git');
  const commonKey = cacheFile(r.stateRoot, physicalPath(path.join(r.root, '.git')));
  // Old bucket still holds data → the one-time LEGACY_NOTICE fires (stderr only).
  mkfile(path.join(r.stateRoot, 'projects', 'product-repo', 'checkpoints', 'x.md'), '# old\n');
  mkfile(commonKey, 'product-repo');
  const err = sink();
  const id = resolveIdentity({ cwd: r.root, env: {}, stateRoot: r.stateRoot, stderr: err });
  assert.equal(id.slug, 'product-repo-5eca1fe041984543'); // #3003 migration point
  assert.equal(readEntry(commonKey), 'v2:product-repo-5eca1fe041984543');
  assert.equal(err.lines.length, 1);
  assert.ok(err.lines[0].includes('projects/product-repo-5eca1fe041984543'));
  assert.ok(err.lines[0].includes('projects/product-repo'));
  assert.ok(err.lines[0].includes('--adopt-legacy'));
  // One-time: the next run is a v2 hit and stays quiet.
  const err2 = sink();
  resolveIdentity({ cwd: r.root, env: {}, stateRoot: r.stateRoot, stderr: err2 });
  assert.equal(err2.lines.length, 0);
  // Same upgrade but the old bucket is gone → no notice at all.
  const r2 = repo(t, 'https://gitlab.com/customer-a/product/repo.git', 'gl2');
  const key2 = cacheFile(r2.stateRoot, physicalPath(path.join(r2.root, '.git')));
  mkfile(key2, 'product-repo');
  const err3 = sink();
  const id2 = resolveIdentity({ cwd: r2.root, env: {}, stateRoot: r2.stateRoot, stderr: err3 });
  assert.equal(id2.slug, 'product-repo-5eca1fe041984543');
  assert.equal(err3.lines.length, 0);
});

test('14. both keys written: commondir key and pwd key agree after a fresh resolve', t => {
  const r = repo(t, 'https://github.com/garrytan/gstack.git');
  const id = resolveIdentity({ cwd: r.root, env: {}, stateRoot: r.stateRoot });
  assert.equal(id.slug, 'garrytan-gstack');
  assert.equal(readEntry(cacheFile(r.stateRoot, physicalPath(path.join(r.root, '.git')))), 'v2:garrytan-gstack');
  assert.equal(readEntry(cacheFile(r.stateRoot, r.root)), 'v2:garrytan-gstack'); // MAIN == pwd here
  const sub = path.join(r.root, 'a', 'b');
  fs.mkdirSync(sub, { recursive: true });
  resolveIdentity({ cwd: sub, env: {}, stateRoot: r.stateRoot });
  assert.equal(readEntry(cacheFile(r.stateRoot, sub)), 'v2:garrytan-gstack'); // pwd-keyed readers agree
});

test('15. self-heal #1125 shape: cached == basename(pwd) for a subdirectory is recomputed and rewritten', t => {
  const r = repo(t, 'https://github.com/garrytan/gstack.git');
  fs.writeFileSync(path.join(r.root, 'package.json'), '{}');
  const sub = path.join(r.root, 'nested');
  fs.mkdirSync(sub);
  mkfile(cacheFile(r.stateRoot, sub), 'nested'); // the pre-walk-up resolver's poisoned entry
  const id = resolveIdentity({ cwd: sub, env: {}, stateRoot: r.stateRoot });
  assert.equal(id.slug, 'garrytan-gstack');
  assert.equal(readEntry(cacheFile(r.stateRoot, sub)), 'v2:garrytan-gstack'); // single-shot, key-local heal
  assert.equal(readEntry(cacheFile(r.stateRoot, physicalPath(path.join(r.root, '.git')))), 'v2:garrytan-gstack');
});

test('16. self-heal degraded-ancestor shape: cached == basename(marker root) with a dead .git above a real repo', t => {
  const base = temp(t);
  fs.mkdirSync(path.join(base, 'stray', '.git'), { recursive: true }); // marker root whose origin does NOT resolve
  const r = path.join(base, 'stray', 'real');
  fs.mkdirSync(path.join(r, 'w'), { recursive: true });
  try { git(['init', '--initial-branch=main'], r); } catch { git(['init'], r); }
  git(['remote', 'add', 'origin', 'https://github.com/garrytan/gstack.git'], r);
  const commonKey = cacheFile(path.join(base, 'st'), physicalPath(path.join(r, '.git')));
  mkfile(commonKey, 'stray'); // the pre-remote-first resolver's degraded slug
  const id = resolveIdentity({ cwd: path.join(r, 'w'), env: {}, stateRoot: path.join(base, 'st') });
  assert.equal(id.slug, 'garrytan-gstack');
  assert.equal(readEntry(commonKey), 'v2:garrytan-gstack');
});

test('17. former-slugs: a worktree-cwd entry naming a live foreign bucket is recorded, deduped, read-filtered', t => {
  const r = repo(t, 'https://github.com/garrytan/gstack.git');
  const sub = path.join(r.root, 'sub');
  fs.mkdirSync(sub);
  const commonKey = cacheFile(r.stateRoot, physicalPath(path.join(r.root, '.git')));
  const formerFile = path.join(r.stateRoot, 'projects', 'garrytan-gstack', '.former-slugs');
  mkfile(commonKey, 'v2:garrytan-gstack'); // entry from the commondir key, not the pwd key
  mkfile(cacheFile(r.stateRoot, sub), 'v2:old-bucket');
  mkfile(path.join(r.stateRoot, 'projects', 'old-bucket', 'checkpoints', 'a.md'), '# a\n');
  const id = resolveIdentity({ cwd: sub, env: {}, stateRoot: r.stateRoot });
  assert.equal(id.slug, 'garrytan-gstack');
  assert.equal(fs.readFileSync(formerFile, 'utf8'), 'old-bucket\n'); // trigger: non-pwd entry + live foreign bucket
  assert.deepEqual(id.formerSlugs, ['old-bucket']);
  assert.equal(readEntry(cacheFile(r.stateRoot, sub)), 'v2:garrytan-gstack'); // old value read BEFORE the rewrite
  // No duplicate append on the next run; a listed-but-empty bucket drops out of the report.
  fs.appendFileSync(formerFile, 'gone-bucket\n');
  fs.mkdirSync(path.join(r.stateRoot, 'projects', 'gone-bucket'));
  const again = resolveIdentity({ cwd: sub, env: {}, stateRoot: r.stateRoot });
  assert.equal(fs.readFileSync(formerFile, 'utf8'), 'old-bucket\ngone-bucket\n');
  assert.deepEqual(again.formerSlugs, ['old-bucket']); // gone-bucket holds no data
});

test('18. state root: GSTACK861_STATE_ROOT or ~/.gstack861, never ~/.gstack, never the real home in tests', t => {
  assert.equal(defaultStateRoot({}), path.join(os.homedir(), '.gstack861'));
  assert.equal(defaultStateRoot({ GSTACK861_STATE_ROOT: 'X' }), 'X');
  assert.ok(!defaultStateRoot({}).endsWith(path.join(os.homedir(), '.gstack')));
  // A run with an injected root and NO env override must not touch the real default location.
  const base = temp(t);
  const plain = path.join(base, 'plain');
  fs.mkdirSync(plain);
  const homeState = path.join(os.homedir(), '.gstack861');
  const existed = fs.existsSync(homeState);
  resolveIdentity({ cwd: plain, env: {}, stateRoot: path.join(base, 'st') });
  if (!existed) assert.ok(!fs.existsSync(homeState), 'the default state root must stay untouched');
  // The env override routes the cache (and nothing else) into the temp root.
  resolveIdentity({ cwd: plain, env: { GSTACK861_STATE_ROOT: path.join(base, 'envroot') } });
  assert.equal(readEntry(cacheFile(path.join(base, 'envroot'), plain)), 'v2:plain');
});

test('19. worktree shares the main checkout\'s commondir key; branch slashes sanitize', t => {
  const base = temp(t);
  const root = path.join(base, 'main');
  fs.mkdirSync(root);
  try { git(['init', '--initial-branch=main'], root); } catch { git(['init'], root); git(['symbolic-ref', 'HEAD', 'refs/heads/main'], root); }
  git(['remote', 'add', 'origin', 'https://github.com/garrytan/gstack.git'], root);
  fs.writeFileSync(path.join(root, 'README.md'), 'x\n');
  git(['add', '.'], root);
  git(['-c', 'user.name=gstack861 test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'fixture'], root);
  git(['checkout', '-b', 'feature/x'], root);
  const stateRoot = path.join(base, 'st');
  git(['worktree', 'add', '-b', 'wtbranch', path.join(base, 'wt')], root); // wt .git is a gitfile → gitdir → commondir
  const wt = resolveIdentity({ cwd: path.join(base, 'wt'), env: {}, stateRoot });
  assert.equal(wt.slug, 'garrytan-gstack');
  assert.equal(wt.branch, 'wtbranch');
  // Shared-key proof: the main checkout reads the SAME commondir entry the worktree wrote.
  const commonKey = cacheFile(stateRoot, physicalPath(path.join(root, '.git')));
  assert.equal(readEntry(commonKey), 'v2:garrytan-gstack');
  fs.writeFileSync(commonKey, 'v2:shared-proof');
  const main = resolveIdentity({ cwd: root, env: {}, stateRoot });
  assert.equal(main.slug, 'shared-proof'); // worktree can no longer diverge from the main checkout
  assert.equal(main.branch, 'feature-x'); // tr '/' '-' + alphabet sanitize
  // Three keys exist (commondir + each pwd), all v2, all agreeing again after the heal write.
  resolveIdentity({ cwd: path.join(base, 'wt'), env: {}, stateRoot });
  for (const key of [commonKey, cacheFile(stateRoot, root), cacheFile(stateRoot, path.join(base, 'wt'))]) {
    assert.equal(readEntry(key), 'v2:shared-proof');
  }
});
