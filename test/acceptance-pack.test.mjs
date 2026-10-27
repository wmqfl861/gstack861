import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildAcceptancePack } from '../scripts/acceptance-pack.mjs';
import { loadPolicy } from '../src/policy.mjs';
import { textDigest } from '../src/json.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const script = path.join(root, 'scripts', 'acceptance-pack.mjs');
const fwd = p => p.split(path.sep).join('/');
const BANNER = '<!-- AUTO-GENERATED from review/SKILL.md.tmpl — do not edit directly -->';
// The eight zcode-acceptance.md section 6 row labels, quoted verbatim into STEPS.md.
const ROWS = ['安装生效', '放行 = 弃权，不越过宿主权限', '越界拒', 'VCS 保护', '启动失败 fail-closed',
  '超时行为', 'updatedInput 共存禁令', '回滚'];

function base(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gstack861-pack-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * Mini CI render tree (the renderOutput() recipe from test/stage.test.mjs, trimmed to
 * one skill + the root router): rendered/.zcode/skills/<renderedDir(name)>/SKILL.md plus
 * render-manifest-zcode.json, exactly the shapes scripts/render-upstream.mjs emits.
 */
function miniRender(t, dir) {
  const rendered = path.join(dir, 'rendered');
  const skillsRoot = path.join(rendered, '.zcode', 'skills');
  const body = `${BANNER}\nbody of review\n`;
  const rootBody = `${BANNER}\nroot router\n`;
  for (const [name, text] of [['gstack-review', body], ['gstack', rootBody]]) {
    fs.mkdirSync(path.join(skillsRoot, name), { recursive: true });
    fs.writeFileSync(path.join(skillsRoot, name, 'SKILL.md'), text);
  }
  const manifest = { schemaVersion: 1, host: 'zcode', generatedBy: 'fixture gen:skill-docs', status: 'rendered-experimental',
    skills: { review: textDigest(body) }, root: { path: 'gstack/SKILL.md', sha256: textDigest(rootBody) } };
  const manifestFile = path.join(dir, 'render-manifests', 'render-manifest-zcode.json');
  fs.mkdirSync(path.dirname(manifestFile), { recursive: true });
  fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  return { rendered, manifestFile };
}

test('full pack: git workspace, loadable policy with writeRoots exactly src, snippet, quoted STEPS, kept staging, installed skills', t => {
  const dir = base(t);
  const f = miniRender(t, dir);
  const out = path.join(dir, 'pack');
  const result = buildAcceptancePack({ out, rendered: f.rendered, manifestFile: f.manifestFile, host: 'zcode' });
  assert.equal(result.skillsLoaded, true);
  const workspace = path.join(out, 'workspace');
  const srcDir = path.join(workspace, 'src');

  // Fixture workspace: a real git repo with an editable mixed Chinese/English file.
  assert.ok(fs.statSync(path.join(workspace, '.git')).isDirectory(), 'workspace must be git-initialized');
  const notes = fs.readFileSync(path.join(srcDir, 'notes.md'), 'utf8');
  assert.ok(notes.includes('验收'), 'fixture must contain Chinese text');
  assert.ok(/[A-Za-z]{3,}/.test(notes), 'fixture must contain English text');

  // Policy: real loadPolicy acceptance (outside the workspace, file tools only) — the
  // acceptance probes of STEPS.md depend on this exact policy loading for real.
  const policyPath = path.join(out, 'policy.json');
  const policy = loadPolicy(policyPath);
  assert.equal(policy.writeRoots.length, 1, 'writeRoots must be exactly one entry');
  assert.equal(fs.realpathSync.native(policy.writeRoots[0]), fs.realpathSync.native(srcDir), 'writeRoots must be exactly workspace/src');
  assert.equal(policy.readRoots.length, 1);
  assert.equal(fs.realpathSync.native(policy.readRoots[0]), fs.realpathSync.native(workspace));
  const raw = JSON.parse(fs.readFileSync(policyPath, 'utf8'));
  assert.deepEqual(raw.writeRoots, [fwd(srcDir)]);
  assert.deepEqual(Object.keys(raw.bindings.zcode).sort(), ['Edit', 'Read', 'Write']);
  for (const binding of Object.values(raw.bindings.zcode)) assert.equal(binding.pathKey, 'file_path');
  assert.equal(raw.schemaVersion, 1);
  // Explicit 0o600 write, umask-independent (Windows maps writable files to 0o666, so the
  // bit-level assertion is POSIX-only — same platform split as test/stage.test.mjs).
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(policyPath).mode & 0o777, 0o600);
    assert.notEqual(fs.statSync(policyPath).mode & 0o777, 0o666);
  }

  // Hook snippet: the zcodeHookConfig shape with this node, the repo CLI and this policy.
  const entry = JSON.parse(fs.readFileSync(path.join(out, 'hook-snippet.json'), 'utf8')).hooks.events.PreToolUse[0];
  assert.equal(entry.matcher, 'Read|Write|Edit');
  assert.equal(entry.hooks[0].command, process.execPath);
  assert.deepEqual(entry.hooks[0].args, [fwd(path.join(root, 'bin', 'gstack861.mjs')), 'hook', 'zcode', '--policy', fwd(policyPath)]);
  assert.equal(entry.hooks[0].timeoutMs, 10000);

  // STEPS.md: all eight section 6 rows verbatim, expected codes, §2.4 A/B rows, and
  // absolute-path links to both manuals plus the substituted workspace paths.
  const steps = fs.readFileSync(path.join(out, 'STEPS.md'), 'utf8');
  for (const row of ROWS) assert.ok(steps.includes(row), `STEPS.md must quote section 6 row: ${row}`);
  for (const code of ['gstack861:OUTSIDE_SCOPE', 'gstack861:PROTECTED_PATH', 'gstack861:HOOK_INPUT_OR_POLICY_ERROR']) {
    assert.ok(steps.includes(code), `STEPS.md must quote expected code: ${code}`);
  }
  assert.ok(steps.includes('新会话自动拾取'), '§2.4 row A must be quoted verbatim');
  assert.ok(steps.includes('多余条目容忍度'), '§2.4 row B must be quoted verbatim');
  assert.ok(steps.includes(fwd(path.join(root, 'docs', 'integration', 'zcode-acceptance.md'))), 'absolute manual link');
  assert.ok(steps.includes(fwd(path.join(root, 'docs', 'integration', 'host-loading.md'))), 'absolute manual link');
  assert.ok(steps.includes(fwd(workspace)), 'generated absolute workspace paths substituted');
  assert.ok(steps.includes(fwd(srcDir)), 'generated absolute src paths substituted');
  assert.ok(!steps.includes('技能未装载'), 'a loaded pack must not carry the not-loaded note');
  // Honesty notes: with writeRoots=[src] the scope check denies .git/ paths before the VCS
  // protections, so the manual's PROTECTED_PATH expectation needs an honest substitution note.
  assert.ok(steps.includes('探针 3 注'), 'probe-3 OUTSIDE_SCOPE-vs-PROTECTED_PATH note');
  assert.ok(steps.includes('D 项注'), 'row-D OUTSIDE_SCOPE-vs-PROTECTED_PATH note');

  // Staging leg: staging KEPT (section 2.4 C compares against it), skills installed.
  assert.deepEqual(fs.readdirSync(path.join(out, 'staging-zcode')).sort(), ['gstack', 'review']);
  const skills = path.join(workspace, '.zcode', 'skills');
  assert.ok(fs.existsSync(path.join(skills, 'review', 'SKILL.md')));
  assert.ok(fs.existsSync(path.join(skills, 'gstack', 'SKILL.md')));
  assert.ok(fs.existsSync(path.join(skills, '.gstack861-registry.json')));
});

test('pack without --rendered: valid policy, no staging, and STEPS notes skills are NOT loaded', t => {
  const dir = base(t);
  const out = path.join(dir, 'pack');
  fs.mkdirSync(out); // a pre-existing EMPTY out directory is accepted
  const result = buildAcceptancePack({ out });
  assert.equal(result.skillsLoaded, false);
  const steps = fs.readFileSync(path.join(out, 'STEPS.md'), 'utf8');
  assert.ok(steps.includes('技能未装载'), 'STEPS must state that skills are not loaded');
  // The §2.4 rows themselves are not quoted when nothing was loaded: row B's label and
  // row A's verbatim 操作 cell appear only inside the quoted table.
  assert.ok(!steps.includes('多余条目容忍度'), '§2.4 row B is not quoted when nothing was loaded');
  assert.ok(!steps.includes('装载完成后在该工作区新开 ZCode 会话，查看技能列表/系统提示'), '§2.4 row A is not quoted when nothing was loaded');
  assert.equal(fs.existsSync(path.join(out, 'staging-zcode')), false);
  assert.equal(fs.existsSync(path.join(out, 'workspace', '.zcode')), false);
  loadPolicy(path.join(out, 'policy.json')); // still a fully usable guard-only pack
});

test('pack refuses an existing non-empty --out and leaves it untouched', t => {
  const dir = base(t);
  const out = path.join(dir, 'pack');
  fs.mkdirSync(out);
  fs.writeFileSync(path.join(out, 'keep.txt'), 'mine');
  assert.throws(() => buildAcceptancePack({ out }), /OUT_EXISTS/);
  assert.deepEqual(fs.readdirSync(out), ['keep.txt']);
});

test('pack refuses a relative --out and incomplete --rendered flag sets', t => {
  assert.throws(() => buildAcceptancePack({ out: 'pack-rel' }), /ABSOLUTE_PATH_REQUIRED/);
  assert.equal(fs.existsSync(path.join(process.cwd(), 'pack-rel')), false);
  const dir = base(t);
  // The --rendered trio is binding: any one without the others refuses before any byte.
  assert.throws(() => buildAcceptancePack({ out: path.join(dir, 'a'), rendered: dir }), /INVALID_ARGUMENTS/);
  assert.throws(() => buildAcceptancePack({ out: path.join(dir, 'b'), rendered: dir, manifestFile: dir, host: 'dsh' }), /INVALID_HOST/);
  assert.equal(fs.existsSync(path.join(dir, 'a')), false);
  assert.equal(fs.existsSync(path.join(dir, 'b')), false);
});

test('pack passes stage-render refusals through verbatim and leaves no partial pack', t => {
  const dir = base(t);
  const f = miniRender(t, dir);
  fs.writeFileSync(path.join(f.rendered, '.zcode', 'skills', 'gstack-review', 'SKILL.md'), `${BANNER}\ntampered\n`);
  const out = path.join(dir, 'pack');
  assert.throws(() => buildAcceptancePack({ out, rendered: f.rendered, manifestFile: f.manifestFile, host: 'zcode' }), /RENDER_TREE_INVALID/);
  assert.equal(fs.existsSync(out), false, 'a refused pack must leave nothing behind');
});

test('CLI: usage without arguments, ABSOLUTE_PATH_REQUIRED for relative --out, success run offline', t => {
  const usage = spawnSync(process.execPath, [script], { encoding: 'utf8' });
  assert.equal(usage.status, 1);
  assert.match(usage.stderr, /--out ABS_DIR/);
  const bad = spawnSync(process.execPath, [script, '--out', 'rel'], { encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /gstack861: ABSOLUTE_PATH_REQUIRED/); // same stderr form as bin/gstack861.mjs
  const dir = base(t);
  const out = path.join(dir, 'cli-pack');
  const ok = spawnSync(process.execPath, [script, '--out', out], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  const summary = JSON.parse(ok.stdout);
  assert.equal(summary.skillsLoaded, false);
  assert.ok(fs.existsSync(path.join(out, 'STEPS.md')));
});
