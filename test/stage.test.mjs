import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { stageRender } from '../src/stage.mjs';
import { textDigest } from '../src/json.mjs';
import { blobHash } from '../src/generate.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const cli = path.join(root, 'bin', 'gstack861.mjs');
const WHEN = '2026-10-27T00:00:00.000Z';
const NOW = () => WHEN;
// The one authoritative version: staged manifests must echo package.json.
const VERSION = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const LOCK_COMMIT = JSON.parse(fs.readFileSync(path.join(root, 'upstream.lock.json'), 'utf8')).gstack.commit;
const BANNER = '<!-- AUTO-GENERATED from review/SKILL.md.tmpl — do not edit directly -->';
const ROOT_BODY = `${BANNER}\nroot router\n`;
// Mirrors the upstream renderer's dir naming exactly (gen-skill-docs.ts via
// scripts/render-upstream.mjs): already-prefixed names pass through.
const renderedDir = name => (name.startsWith('gstack-') ? name : `gstack-${name}`);

function base(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gstack861-stage-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * Hand-built CI render output: rendered/.<host>/skills/<renderedDir(name)>/{SKILL.md,...}
 * plus render-manifest-<host>.json, exactly the shapes scripts/render-upstream.mjs
 * emits. skills: { inventoryName: { body?, files?: { relPath: text } } };
 * root: same shape, or null to omit the root router dir (digest stays valid so
 * the refusal under test is the tree, not the manifest shape).
 */
function renderOutput(t, { host = 'zcode', skills = {}, root: rootSpec = {} } = {}) {
  const dir = base(t);
  const rendered = path.join(dir, 'rendered');
  const skillsRoot = path.join(rendered, `.${host}`, 'skills');
  const manifestSkills = {};
  for (const [name, spec = {}] of Object.entries(skills)) {
    const skillDir = path.join(skillsRoot, renderedDir(name));
    fs.mkdirSync(skillDir, { recursive: true });
    const body = spec.body ?? `${BANNER}\nbody of ${name}\n`;
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), body);
    for (const [rel, text] of Object.entries(spec.files ?? {})) {
      fs.mkdirSync(path.dirname(path.join(skillDir, rel)), { recursive: true });
      fs.writeFileSync(path.join(skillDir, rel), text);
    }
    manifestSkills[name] = textDigest(body);
  }
  const rootBody = rootSpec?.body ?? ROOT_BODY;
  if (rootSpec !== null) {
    const rootDir = path.join(skillsRoot, 'gstack');
    fs.mkdirSync(rootDir, { recursive: true });
    fs.writeFileSync(path.join(rootDir, 'SKILL.md'), rootBody);
    for (const [rel, text] of Object.entries(rootSpec.files ?? {})) {
      fs.mkdirSync(path.dirname(path.join(rootDir, rel)), { recursive: true });
      fs.writeFileSync(path.join(rootDir, rel), text);
    }
  }
  const manifest = { schemaVersion: 1, host, generatedBy: 'fixture gen:skill-docs', status: 'rendered-experimental',
    skills: manifestSkills, root: { path: 'gstack/SKILL.md', sha256: textDigest(rootBody) } };
  const manifestFile = path.join(dir, 'render-manifests', `render-manifest-${host}.json`);
  fs.mkdirSync(path.dirname(manifestFile), { recursive: true });
  fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  return { dir, rendered, skillsRoot, manifest, manifestFile, staging: path.join(dir, 'staging') };
}

const rewriteManifest = (f, manifest) => fs.writeFileSync(f.manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
const refuses = (f, pattern, staging = f.staging) => {
  assert.throws(() => stageRender({ rendered: f.rendered, manifestFile: f.manifestFile, host: 'zcode', staging, now: NOW }), pattern);
  assert.equal(fs.existsSync(staging), false, 'any refusal must leave zero staging output');
};

test('stageRender stages single-file skills plus the root router with exact manifests', t => {
  const f = renderOutput(t, { skills: { review: {} } });
  const result = stageRender({ rendered: f.rendered, manifestFile: f.manifestFile, host: 'zcode', staging: f.staging, now: NOW });
  assert.deepEqual(Object.keys(result).sort(), ['files', 'host', 'root', 'schemaVersion', 'staged', 'staging']);
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.host, 'zcode');
  assert.equal(result.staging, f.staging);
  assert.equal(result.staged, 1, 'staged counts manifest skills; the root router is reported separately');
  assert.equal(result.files, 0);
  assert.deepEqual(result.root, { name: 'gstack', sha256: f.manifest.root.sha256, files: 0 });
  const body = `${BANNER}\nbody of review\n`;
  assert.deepEqual(fs.readFileSync(path.join(f.staging, 'review', 'SKILL.md')), Buffer.from(body));
  assert.deepEqual(fs.readFileSync(path.join(f.staging, 'gstack', 'SKILL.md')), Buffer.from(ROOT_BODY));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.staging, 'review', 'manifest.json'), 'utf8')), {
    schemaVersion: 1, name: 'review', host: 'zcode', source: 'render:.zcode', blob: blobHash(Buffer.from(body)),
    commit: LOCK_COMMIT, sha256: textDigest(body), files: {}, placeholders: [], indicators: [], needsReview: false,
    status: 'rendered-experimental', generator: 'gstack861', generatorVersion: VERSION, generatedAt: WHEN,
  });
  const rootManifest = JSON.parse(fs.readFileSync(path.join(f.staging, 'gstack', 'manifest.json'), 'utf8'));
  assert.equal(rootManifest.name, 'gstack');
  assert.equal(rootManifest.source, 'render:.zcode');
  assert.equal(rootManifest.sha256, f.manifest.root.sha256);
  assert.equal(rootManifest.status, 'rendered-experimental');
  assert.deepEqual(fs.readdirSync(f.staging).sort(), ['gstack', 'review']);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(path.join(f.staging, 'review', 'SKILL.md')).mode & 0o777, 0o644);
    assert.equal(fs.statSync(path.join(f.staging, 'review', 'manifest.json')).mode & 0o777, 0o644);
  }
});

test('stageRender stages multi-file skills with nested aux files and passthrough names', t => {
  const f = renderOutput(t, {
    skills: {
      'office-hours': { files: {
        'sections/overview.md': `${BANNER}\noverview\n`,
        'sections/deep/detail.md': `${BANNER}\ndetail\n`,
        'templates/tmpl.md': `${BANNER}\ntmpl\n`,
      } },
      'gstack-upgrade': {}, // already-prefixed: renders as dir gstack-upgrade, staged as gstack-upgrade
    },
  });
  const result = stageRender({ rendered: f.rendered, manifestFile: f.manifestFile, host: 'zcode', staging: f.staging, now: NOW });
  assert.equal(result.staged, 2);
  assert.equal(result.files, 3);
  const manifest = JSON.parse(fs.readFileSync(path.join(f.staging, 'office-hours', 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest.files, {
    'sections/deep/detail.md': textDigest(`${BANNER}\ndetail\n`),
    'sections/overview.md': textDigest(`${BANNER}\noverview\n`),
    'templates/tmpl.md': textDigest(`${BANNER}\ntmpl\n`),
  });
  // staged aux bytes verbatim at nested paths
  assert.deepEqual(fs.readFileSync(path.join(f.staging, 'office-hours', 'sections', 'deep', 'detail.md')), Buffer.from(`${BANNER}\ndetail\n`));
  assert.deepEqual(fs.readdirSync(f.staging).sort(), ['gstack', 'gstack-upgrade', 'office-hours']);
  assert.ok(fs.statSync(path.join(f.staging, 'office-hours', 'sections')).isDirectory());
});

test('stageRender refuses a tampered SKILL.md before writing anything', t => {
  const f = renderOutput(t, { skills: { review: {} } });
  fs.writeFileSync(path.join(f.skillsRoot, 'gstack-review', 'SKILL.md'), `${BANNER}\ntampered\n`);
  refuses(f, /RENDER_TREE_INVALID/);
});

test('stageRender refuses orphan rendered dirs and stray files at the skills root', t => {
  const f = renderOutput(t, { skills: { review: {} } });
  fs.mkdirSync(path.join(f.skillsRoot, 'gstack-extra'));
  fs.writeFileSync(path.join(f.skillsRoot, 'gstack-extra', 'SKILL.md'), `${BANNER}\nextra\n`);
  refuses(f, /RENDER_TREE_INVALID/);
  const stray = renderOutput(t, { skills: { review: {} } });
  fs.writeFileSync(path.join(stray.skillsRoot, 'loose-file.md'), `${BANNER}\nloose\n`);
  refuses(stray, /RENDER_TREE_INVALID/);
});

test('stageRender refuses a manifest skill whose rendered dir is missing', t => {
  const f = renderOutput(t, { skills: { review: {}, plan: {} } });
  fs.rmSync(path.join(f.skillsRoot, renderedDir('plan')), { recursive: true });
  refuses(f, /RENDER_TREE_INVALID/);
});

test('stageRender refuses a missing root router dir', t => {
  const f = renderOutput(t, { skills: { review: {} }, root: null });
  refuses(f, /RENDER_TREE_INVALID/);
});

test('stageRender refuses placeholder residue and missing banners', t => {
  const placeholder = renderOutput(t, { skills: { review: { body: `${BANNER}\n{{TOOLS}} residue\n` } } });
  refuses(placeholder, /RENDER_TREE_INVALID/);
  const bannerless = renderOutput(t, { skills: { review: { body: 'no banner at all\n' } } });
  refuses(bannerless, /RENDER_TREE_INVALID/);
});

test('stageRender refuses a render manifest whose host does not match --host', t => {
  const f = renderOutput(t, { host: 'zcode', skills: { review: {} } });
  assert.throws(() => stageRender({ rendered: f.rendered, manifestFile: f.manifestFile, host: 'dsh', staging: f.staging, now: NOW }), /RENDER_MANIFEST_INVALID/);
  assert.equal(fs.existsSync(f.staging), false);
  assert.throws(() => stageRender({ rendered: f.rendered, manifestFile: f.manifestFile, host: 'claude', staging: f.staging, now: NOW }), /INVALID_HOST/);
});

test('stageRender refuses malformed render manifests with zero writes', t => {
  const mutations = [
    m => ({ ...m, schemaVersion: 2 }),
    m => ({ ...m, skills: {} }),
    m => ({ ...m, skills: [] }),
    m => ({ ...m, skills: { review: 'not-hex' } }),
    m => ({ ...m, skills: { review: textDigest('x').slice(0, 63) } }),
    m => ({ ...m, root: { path: 'other/SKILL.md', sha256: m.root.sha256 } }),
    m => ({ ...m, root: { path: 'gstack/SKILL.md' } }),
    m => ({ ...m, root: { path: 'gstack/SKILL.md', sha256: m.root.sha256, extra: 1 } }),
    m => ({ ...m, skills: { ...m.skills, gstack: m.root.sha256 } }), // reserved root name
    m => ({ ...m, skills: { 'Bad_Name': m.skills.review } }), // unstageable inventory name
    m => ({ ...m, skills: { review: m.skills.review, 'gstack-review': m.skills.review } }), // two names, one rendered dir
  ];
  mutations.forEach((mutate, i) => {
    const f = renderOutput(t, { skills: { review: {} } });
    rewriteManifest(f, mutate(f.manifest));
    refuses(f, /RENDER_MANIFEST_INVALID/, path.join(f.dir, `staging-${i}`));
  });
  const broken = renderOutput(t, { skills: { review: {} } });
  fs.writeFileSync(broken.manifestFile, '{not json');
  refuses(broken, /RENDER_MANIFEST_INVALID/, path.join(broken.dir, 'staging-json'));
  const absent = renderOutput(t, { skills: { review: {} } });
  fs.rmSync(absent.manifestFile);
  refuses(absent, /RENDER_MANIFEST_INVALID/, path.join(absent.dir, 'staging-missing'));
});

test('stageRender refuses rendered files outside the staging files-key grammar', t => {
  const cases = [
    { 'sections/SKILL.md': `${BANNER}\nx\n` },      // reserved name in a subpath
    { 'sections/manifest.json': `${BANNER}\nx\n` }, // reserved name, other spelling
    { 'sections/Skill.MD': `${BANNER}\nx\n` },      // reserved name, case variant
    { 'a/b/c/d/e.md': `${BANNER}\nx\n` },           // depth 5
    { 'sections/_bad.md': `${BANNER}\nx\n` },       // segment starts with underscore
    { 'sections/sp ace.md': `${BANNER}\nx\n` },     // separator character in segment
  ];
  cases.forEach((files, i) => {
    const f = renderOutput(t, { skills: { review: { files } } });
    refuses(f, /RENDER_TREE_INVALID/, path.join(f.dir, `staging-${i}`));
  });
  const empty = renderOutput(t, { skills: { review: {} } });
  fs.mkdirSync(path.join(empty.skillsRoot, 'gstack-review', 'sections', 'empty'), { recursive: true });
  refuses(empty, /RENDER_TREE_INVALID/, path.join(empty.dir, 'staging-empty'));
});

test('stageRender refuses non-empty or overlapping staging and invalid paths', t => {
  const busy = renderOutput(t, { skills: { review: {} } });
  fs.mkdirSync(busy.staging); fs.writeFileSync(path.join(busy.staging, 'leftover.txt'), 'occupied');
  assert.throws(() => stageRender({ rendered: busy.rendered, manifestFile: busy.manifestFile, host: 'zcode', staging: busy.staging, now: NOW }), /STAGING_NOT_EMPTY/);
  assert.deepEqual(fs.readdirSync(busy.staging), ['leftover.txt'], 'refusal must not touch existing staging content');
  const asFile = renderOutput(t, { skills: { review: {} } });
  fs.writeFileSync(asFile.staging, 'not a directory');
  assert.throws(() => stageRender({ rendered: asFile.rendered, manifestFile: asFile.manifestFile, host: 'zcode', staging: asFile.staging, now: NOW }), /STAGING_NOT_EMPTY/);
  const inside = renderOutput(t, { skills: { review: {} } });
  const inner = path.join(inside.rendered, 'nested-staging');
  assert.throws(() => stageRender({ rendered: inside.rendered, manifestFile: inside.manifestFile, host: 'zcode', staging: inner, now: NOW }), /OVERLAPPING_PATHS/);
  assert.equal(fs.existsSync(inner), false, 'overlap must be refused before creating anything inside the render tree');
  const outside = renderOutput(t, { skills: { review: {} } });
  assert.throws(() => stageRender({ rendered: outside.rendered, manifestFile: outside.manifestFile, host: 'zcode', staging: outside.dir, now: NOW }), /OVERLAPPING_PATHS/);
  const relative = renderOutput(t, { skills: { review: {} } });
  assert.throws(() => stageRender({ rendered: 'rendered', manifestFile: relative.manifestFile, host: 'zcode', staging: path.join(relative.dir, 's1'), now: NOW }), /INVALID_RENDERED/);
  assert.throws(() => stageRender({ rendered: path.join(relative.dir, 'missing'), manifestFile: relative.manifestFile, host: 'zcode', staging: path.join(relative.dir, 's2'), now: NOW }), /INVALID_RENDERED/);
  assert.throws(() => stageRender({ rendered: relative.rendered, manifestFile: relative.manifestFile, host: 'zcode', staging: 'relative-staging', now: NOW }), /INVALID_STAGING/);
});

test('stageRender takes the commit from GSTACK861_TEST_COMMIT or the upstream lock pin', t => {
  const f = renderOutput(t, { skills: { review: {} } });
  const override = 'b'.repeat(40);
  process.env.GSTACK861_TEST_COMMIT = override;
  try {
    const staging = path.join(f.dir, 'staging-override');
    stageRender({ rendered: f.rendered, manifestFile: f.manifestFile, host: 'zcode', staging, now: NOW });
    assert.equal(JSON.parse(fs.readFileSync(path.join(staging, 'review', 'manifest.json'), 'utf8')).commit, override);
  } finally {
    delete process.env.GSTACK861_TEST_COMMIT;
  }
  const short = renderOutput(t, { skills: { review: {} } });
  process.env.GSTACK861_TEST_COMMIT = 'short';
  try {
    refuses(short, /FULL_COMMIT_REQUIRED/, path.join(short.dir, 'staging-short'));
  } finally {
    delete process.env.GSTACK861_TEST_COMMIT;
  }
});

test('CLI stage-render converts a render tree end to end via subprocess', t => {
  const f = renderOutput(t, {
    skills: { review: { files: { 'sections/overview.md': `${BANNER}\noverview\n` } }, 'gstack-upgrade': {} },
  });
  const commit = 'c'.repeat(40);
  const r = spawnSync(process.execPath,
    [cli, 'stage-render', '--rendered', f.rendered, '--manifest', f.manifestFile, '--host', 'zcode', '--staging', f.staging],
    { encoding: 'utf8', env: { ...process.env, GSTACK861_TEST_COMMIT: commit } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, new RegExp(`gstack861: TEST_COMMIT_OVERRIDE active \\(${commit.slice(0, 12)}\\)`));
  const out = JSON.parse(r.stdout);
  assert.equal(out.schemaVersion, 1);
  assert.equal(out.host, 'zcode');
  assert.equal(out.staged, 2);
  assert.equal(out.files, 1);
  assert.equal(out.root.sha256, f.manifest.root.sha256);
  assert.deepEqual(fs.readdirSync(f.staging).sort(), ['gstack', 'gstack-upgrade', 'review']);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.staging, 'review', 'manifest.json'), 'utf8')).commit, commit);
  // The flag allowlist stays closed: unknown tokens refuse before any work.
  const bad = spawnSync(process.execPath, [cli, 'stage-render', '--rendered', f.rendered, '--out', 'x'], { encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /INVALID_ARGUMENTS/);
  assert.match(spawnSync(process.execPath, [cli], { encoding: 'utf8' }).stderr, /stage-render --rendered DIR --manifest FILE --host zcode\|dsh --staging DIR/);
});

test('rendered skills load end to end: stage-render CLI -> install -> multi-file verify -> uninstall', async t => {
  const f = renderOutput(t, {
    skills: {
      ship: { files: { 'sections/scope.md': `${BANNER}\nscope\n`, 'sections/qa-patterns.md': `${BANNER}\nqa\n` } },
      'gstack-upgrade': {},
    },
  });
  const commit = 'd'.repeat(40);
  process.env.GSTACK861_TEST_COMMIT = commit;
  const staging = path.join(f.dir, 'staging-e2e'), target = path.join(f.dir, 'target');
  try {
    const stage = spawnSync(process.execPath, [cli, 'stage-render', '--rendered', f.rendered, '--manifest', f.manifestFile,
      '--host', 'zcode', '--staging', staging], { encoding: 'utf8', timeout: 10000 });
    assert.equal(stage.status, 0, stage.stderr);
    const staged = JSON.parse(stage.stdout);
    assert.equal(staged.staged, 2); // 2 skills; the root router is reported separately
    assert.equal(staged.root.name, 'gstack');
    const { installSkills, uninstallSkills } = await import('../src/install.mjs');
    const installed = installSkills({ staging, target });
    assert.deepEqual(installed.installed.sort(), ['gstack', 'gstack-upgrade', 'ship']);
    const shipDir = path.join(target, 'ship');
    assert.ok(fs.existsSync(path.join(shipDir, 'SKILL.md')));
    assert.ok(fs.existsSync(path.join(shipDir, 'sections', 'scope.md')));
    assert.ok(fs.existsSync(path.join(shipDir, 'sections', 'qa-patterns.md')));
    // Tampering with a listed section file must make uninstall refuse (registry-anchored digests).
    fs.writeFileSync(path.join(shipDir, 'sections', 'scope.md'), 'tampered\n');
    assert.throws(() => uninstallSkills({ target }), /USER_FILE_REFUSED/);
    fs.writeFileSync(path.join(shipDir, 'sections', 'scope.md'), `${BANNER}\nscope\n`);
    const removed = uninstallSkills({ target });
    assert.deepEqual(removed.uninstalled.sort(), ['gstack', 'gstack-upgrade', 'ship']);
    assert.equal(fs.existsSync(shipDir), false);
  } finally {
    delete process.env.GSTACK861_TEST_COMMIT;
  }
});
