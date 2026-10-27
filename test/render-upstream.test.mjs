import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  assertRenderAllowed, assertPristine, verifyBunPin, patchIndex, prepareCopy, verifyOutput,
  GENERATED_BY, OVERLAY_HOSTS, EXPECTED_BUN_VERSION,
} from '../scripts/render-upstream.mjs';
import { textDigest } from '../src/json.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const script = path.join(root, 'scripts', 'render-upstream.mjs');
const overlayDir = path.join(root, 'hosts-overlay');
const realIndex = () => fs.readFileSync(path.join(root, 'upstream', 'gstack', 'hosts', 'index.ts'), 'utf8'); // read-only; never written
const BANNER = '<!-- AUTO-GENERATED from review/SKILL.md.tmpl — do not edit directly -->';
const NAMES = Array.from({ length: 57 }, (_, i) => `skill-${String(i).padStart(2, '0')}`); // 57 = pinned inventory count
const inventoryJson = { skills: NAMES.map(name => ({ name })) };

function scratch(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack861-render-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function gitRepo(t, files) {
  const dir = path.join(scratch(t), 'upstream'); fs.mkdirSync(dir);
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  git('init', '--initial-branch=main');
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true }); fs.writeFileSync(path.join(dir, name), text);
  }
  git('add', '.');
  git('-c', 'user.name=gstack861 test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'fixture');
  return { dir, commit: git('rev-parse', 'HEAD'), git };
}

// Synthetic index carrying the exact upstream anchors (import line, full registry literal). Tests that must not depend on the real submodule use this.
const ANCHORED_INDEX = [
  "import type { HostConfig } from '../scripts/host-config';",
  "import claude from './claude';",
  "import agy from './agy';",
  '',
  'export const ALL_HOST_CONFIGS: HostConfig[] = [claude, codex, factory, kiro, opencode, slate, cursor, openclaw, hermes, gbrain, copilot, agy];',
  '',
  "export { claude, codex, factory, kiro, opencode, slate, cursor, openclaw, hermes, gbrain, copilot, agy };",
  '',
].join('\n');

function childEnv(overrides) {
  const env = { ...process.env }; delete env.CI; delete env.GSTACK861_RENDER;
  return { ...env, ...overrides };
}

function writeSkill(skillsRoot, name, body = `${BANNER}\nbody of ${name}\n`) {
  fs.mkdirSync(path.join(skillsRoot, `gstack-${name}`), { recursive: true });
  fs.writeFileSync(path.join(skillsRoot, `gstack-${name}`, 'SKILL.md'), body);
  return body;
}

test('render gate is AND: both CI=true and GSTACK861_RENDER=ci required', () => {
  for (const env of [{}, { CI: 'true' }, { GSTACK861_RENDER: 'ci' }, { CI: 'false', GSTACK861_RENDER: 'ci' }, { CI: 'true', GSTACK861_RENDER: 'local' }]) {
    assert.throws(() => assertRenderAllowed(env), /RENDER_NOT_ALLOWED/);
  }
  assert.doesNotThrow(() => assertRenderAllowed({ CI: 'true', GSTACK861_RENDER: 'ci' }));
  assert.deepEqual(OVERLAY_HOSTS, ['zcode', 'dsh']);
  assert.equal(EXPECTED_BUN_VERSION, '1.4.2');
});

test('CLI refuses outside CI with zero residue (child env combos)', (t) => {
  const cwd = scratch(t);
  const dirty = gitRepo(t, { 'README.md': 'fixture' });
  fs.writeFileSync(path.join(dirty.dir, 'untracked.txt'), 'dirt');
  let n = 0;
  for (const combo of [{}, { CI: 'true' }, { GSTACK861_RENDER: 'ci' }]) {
    const out = path.join(cwd, `out-${n++}`);
    const r = spawnSync(process.execPath, [script, '--upstream', dirty.dir, '--out', out], { env: childEnv(combo), encoding: 'utf8' });
    assert.equal(r.status, 1, `combo ${JSON.stringify(combo)} must exit 1`);
    assert.match(r.stdout + r.stderr, /RENDER_NOT_ALLOWED/);
    assert.equal(fs.existsSync(out), false, 'refusal must create nothing');
  }
});

test('CLI passes the gate only with both vars and stops at a dirty upstream before any work', (t) => {
  const cwd = scratch(t);
  const dirty = gitRepo(t, { 'README.md': 'fixture' });
  fs.writeFileSync(path.join(dirty.dir, 'untracked.txt'), 'dirt');
  const out = path.join(cwd, 'out');
  const r = spawnSync(process.execPath, [script, '--upstream', dirty.dir, '--out', out], { env: childEnv({ CI: 'true', GSTACK861_RENDER: 'ci' }), encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.doesNotMatch(r.stdout + r.stderr, /RENDER_NOT_ALLOWED/);
  assert.match(r.stdout + r.stderr, /UPSTREAM_DIRTY_RENDER/);
  assert.equal(fs.existsSync(out), false, 'pre-pristine failure must create nothing');
});

test('bun pin accepts exactly 1.4.2 and rejects every other outcome', () => {
  const stub = (status, stdout) => ({ runVersion: () => ({ status, stdout }) });
  assert.equal(verifyBunPin('bun', stub(0, '1.4.2\n')), '1.4.2');
  for (const [status, stdout] of [[0, '1.4.3\n'], [0, '1.4.2-extra\n'], [0, ''], [1, '1.4.2\n'], [null, '']]) {
    assert.throws(() => verifyBunPin('bun', stub(status, stdout)), /BUN_VERSION_PIN_VIOLATION/);
  }
  assert.throws(() => verifyBunPin(process.execPath), /BUN_VERSION_PIN_VIOLATION/); // real spawn: node never reports 1.4.2
});

test('patchIndex splices overlay hosts into a verbatim copy of the real upstream index', (t) => {
  const copy = path.join(scratch(t), 'copy'); fs.mkdirSync(path.join(copy, 'hosts'), { recursive: true });
  fs.writeFileSync(path.join(copy, 'hosts', 'index.ts'), realIndex());
  patchIndex(copy, ['zcode', 'dsh']);
  const patched = fs.readFileSync(path.join(copy, 'hosts', 'index.ts'), 'utf8');
  assert.match(patched, /import agy from '\.\/agy';\nimport zcode from '\.\/zcode';\nimport dsh from '\.\/dsh';/);
  // Registry must be the spliced literal (derived map/type/names evaluate from it), not a runtime push.
  assert.ok(patched.includes('export const ALL_HOST_CONFIGS: HostConfig[] = [zcode, dsh, claude, codex, factory, kiro, opencode, slate, cursor, openclaw, hermes, gbrain, copilot, agy];'));
  assert.ok(patched.endsWith('export { zcode, dsh };\n'));
});

test('patchIndex fails closed on anchor drift without touching the file', (t) => {
  const drifts = [
    realIndex().replace("import agy from './agy';", "import agy from './antigravity';"),
    realIndex().replace('copilot, agy];', 'copilot];'),
    realIndex().replace('export const ALL_HOST_CONFIGS', 'export const HOST_REGISTRATION'),
  ];
  drifts.forEach((text, i) => {
    const copy = path.join(scratch(t), `copy-${i}`); fs.mkdirSync(path.join(copy, 'hosts'), { recursive: true });
    const file = path.join(copy, 'hosts', 'index.ts');
    fs.writeFileSync(file, text);
    assert.throws(() => patchIndex(copy, ['zcode', 'dsh']), /OVERLAY_ANCHOR_MISSING/);
    assert.equal(fs.readFileSync(file, 'utf8'), text, 'a failed patch must not write anything');
  });
});

test('prepareCopy archives the pinned commit, applies the overlay and never writes upstream', (t) => {
  const s = scratch(t);
  const repo = gitRepo(t, {
    'README.md': 'upstream fixture',
    'hosts/index.ts': ANCHORED_INDEX,
    'scripts/gen-skill-docs.ts': '// stub renderer',
  });
  fs.writeFileSync(path.join(repo.dir, 'uncommitted.txt'), 'must not leak into the archive');
  const before = repo.git('status', '--porcelain', '--untracked-files=normal');
  const copyDir = prepareCopy({ upstreamDir: repo.dir, commit: repo.commit, scratch: s, overlayDir, hosts: ['zcode', 'dsh'] });
  const index = fs.readFileSync(path.join(copyDir, 'hosts', 'index.ts'), 'utf8');
  assert.ok(index.includes('= [zcode, dsh, claude,'), 'registry literal must be spliced');
  assert.equal(fs.readFileSync(path.join(copyDir, 'hosts', 'zcode.ts'), 'utf8'), fs.readFileSync(path.join(overlayDir, 'zcode.ts'), 'utf8'));
  assert.equal(fs.readFileSync(path.join(copyDir, 'hosts', 'dsh.ts'), 'utf8'), fs.readFileSync(path.join(overlayDir, 'dsh.ts'), 'utf8'));
  assert.ok(fs.existsSync(path.join(copyDir, 'scripts', 'gen-skill-docs.ts')), 'committed files must be extracted');
  assert.equal(fs.existsSync(path.join(copyDir, 'uncommitted.txt')), false, 'archive must be pinned to the commit, not the worktree');
  assert.equal(repo.git('status', '--porcelain', '--untracked-files=normal'), before, 'upstream worktree must stay untouched');
});

test('verifyOutput accepts 57 skills plus the root router and writes the manifest', (t) => {
  const s = scratch(t);
  const outDir = path.join(s, 'out'), manifestDir = path.join(s, 'manifests');
  const skills = path.join(outDir, '.zcode', 'skills');
  const bodies = new Map(NAMES.map(n => [n, writeSkill(skills, n)]));
  fs.mkdirSync(path.join(skills, 'gstack', 'skill-00', 'sections'), { recursive: true }); // section files carry banners too
  fs.writeFileSync(path.join(skills, 'gstack', 'skill-00', 'sections', 'deep.md'), `${BANNER}\nsection body\n`);
  fs.mkdirSync(path.join(skills, 'gstack'), { recursive: true });
  const rootBody = `${BANNER}\nroot router\n`;
  fs.writeFileSync(path.join(skills, 'gstack', 'SKILL.md'), rootBody);
  const manifest = verifyOutput({ outDir, host: 'zcode', inventoryJson, manifestDir });
  assert.equal(manifest.status, 'rendered-experimental');
  assert.equal(manifest.generatedBy, GENERATED_BY);
  assert.equal(Object.keys(manifest.skills).length, 57);
  assert.equal(manifest.skills['skill-00'], textDigest(bodies.get('skill-00')));
  assert.equal(manifest.root.sha256, textDigest(rootBody));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(manifestDir, 'render-manifest-zcode.json'), 'utf8')), manifest);
});

test('verifyOutput rejects placeholder residue, missing banners and undefined tokens', (t) => {
  const cases = [
    [`${BANNER}\n{{TOOLS}} residue\n`, /RENDER_VERIFY_FAILED/],
    ['no banner at all\n', /RENDER_VERIFY_FAILED/],
    [`${BANNER}\nvalue: undefined here\n`, /RENDER_VERIFY_FAILED/],
  ];
  cases.forEach(([body, pattern], i) => {
    const s = scratch(t);
    const outDir = path.join(s, 'out'), manifestDir = path.join(s, 'manifests');
    const skills = path.join(outDir, '.zcode', 'skills');
    for (const name of NAMES) writeSkill(skills, name, name === 'skill-03' ? body : `${BANNER}\nbody of ${name}\n`);
    fs.mkdirSync(path.join(skills, 'gstack'), { recursive: true });
    fs.writeFileSync(path.join(skills, 'gstack', 'SKILL.md'), `${BANNER}\nroot router\n`);
    assert.throws(() => verifyOutput({ outDir, host: 'zcode', inventoryJson, manifestDir }), pattern, `case ${i}`);
    assert.equal(fs.existsSync(path.join(manifestDir, 'render-manifest-zcode.json')), false, 'no manifest for a rejected render');
  });
});

test('verifyOutput demands set equality with the inventory and the root router', (t) => {
  const build = (mutate) => {
    const s = scratch(t);
    const outDir = path.join(s, 'out');
    const skills = path.join(outDir, '.zcode', 'skills');
    const names = [...NAMES];
    mutate(skills, names);
    return { outDir, manifestDir: path.join(s, 'manifests') };
  };
  const missing = build((skills, names) => {
    for (const name of names.slice(1)) writeSkill(skills, name);
    fs.mkdirSync(path.join(skills, 'gstack'), { recursive: true });
    fs.writeFileSync(path.join(skills, 'gstack', 'SKILL.md'), `${BANNER}\nroot\n`);
  });
  assert.throws(() => verifyOutput({ ...missing, host: 'zcode', inventoryJson }), /RENDER_INCOMPLETE/);
  const extra = build((skills, names) => {
    for (const name of names) writeSkill(skills, name);
    writeSkill(skills, 'extra'); // rendered but not in the inventory
    fs.mkdirSync(path.join(skills, 'gstack'), { recursive: true });
    fs.writeFileSync(path.join(skills, 'gstack', 'SKILL.md'), `${BANNER}\nroot\n`);
  });
  assert.throws(() => verifyOutput({ ...extra, host: 'zcode', inventoryJson }), /RENDER_INCOMPLETE/);
  const noRoot = build((skills, names) => { for (const name of names) writeSkill(skills, name); });
  assert.throws(() => verifyOutput({ ...noRoot, host: 'zcode', inventoryJson }), /RENDER_ROOT_MISSING/);
});

test('assertPristine passes only for a clean upstream worktree', (t) => {
  const repo = gitRepo(t, { 'README.md': 'fixture' });
  assert.doesNotThrow(() => assertPristine(repo.dir));
  fs.writeFileSync(path.join(repo.dir, 'untracked.txt'), 'dirt');
  assert.throws(() => assertPristine(repo.dir), /UPSTREAM_DIRTY_RENDER/);
});
