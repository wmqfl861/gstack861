// Full-repository review regressions. Only disposable files, fake fetches and loopback sockets.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { runModelReview } from '../src/model-review.mjs';
import { installSkills, uninstallSkills } from '../src/install.mjs';
import { textDigest } from '../src/json.mjs';
import { resolveIdentity } from '../src/slug.mjs';
import { resolveVisibility, sealedPolicyAt } from '../src/sealed-guard.mjs';

const KEY = 'audit-only-credential-not-a-real-key';
const gateway = { schemaVersion: 1, baseUrl: 'https://gateway.example.test/v1', apiKeyEnv: 'AUDIT_KEY', model: 'fixture', maxTokens: 128 };
const request = { gateway, target: { files: [{ path: 'src/a', diff: '+fixture' }] }, env: { GSTACK861_MODEL_CALL: '1', AUDIT_KEY: KEY } };
const completion = (findings = [], usage) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ verdict: 'approve', findings }) } }], usage }));
const temp = t => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'g861-audit-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
function staging(base, label, body = label, files = {}) {
  const root = path.join(base, label), dir = path.join(root, 'alpha');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), body);
  const hashes = {};
  for (const [name, bytes] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), bytes);
    hashes[name] = textDigest(bytes);
  }
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ schemaVersion: 1, name: 'alpha', host: 'zcode', commit: 'b'.repeat(40), generator: 'gstack861', sha256: textDigest(body), ...(Object.keys(hashes).length ? { files: hashes } : {}) }));
  return root;
}

// R1: a syntactically valid response is just as untrusted as an error body.
test('audit: successful findings and nested usage never return the active key', async () => {
  const output = await runModelReview({ ...request, fetchImpl: async () => completion([`echo ${KEY}`], { prompt_tokens: 5, detail: [{ [KEY]: KEY }] }) });
  assert.ok(!JSON.stringify(output).includes(KEY));
  assert.equal(output.usage.prompt_tokens, 5);
  assert.match(output.findings[0], /REDACTED/);
});

test('audit: network and body-read diagnostic codes cannot leak the key', async () => {
  for (const fetchImpl of [
    async () => { throw Object.assign(new Error('hidden'), { cause: { code: KEY } }); },
    async () => ({ ok: true, status: 200, text: async () => { throw Object.assign(new Error('hidden'), { name: KEY }); } }),
  ]) {
    await assert.rejects(runModelReview({ ...request, fetchImpl }), e => {
      assert.match(e.message, /GATEWAY_ERROR/);
      assert.ok(!e.message.includes(KEY));
      return true;
    });
  }
});

for (const [label, patch] of [
  ['official endpoint', { baseUrl: 'https://api.openai.com/v1' }],
  ['official Anthropic endpoint', { baseUrl: 'https://api.anthropic.com/v1' }],
  ['plaintext remote', { baseUrl: 'http://remote.example.test/v1' }],
  ['invalid token cap', { maxTokens: -1 }],
  ['coerced key name', { apiKeyEnv: ['AUDIT_KEY'] }],
]) {
  test(`audit: exported review refuses ${label} before invoking fetch`, async () => {
    let calls = 0;
    await assert.rejects(runModelReview({ ...request, gateway: { ...gateway, ...patch }, fetchImpl: async () => { calls++; return completion(); } }));
    assert.equal(calls, 0);
  });
}

test('audit: bounded response reader cancels an oversized stream', async () => {
  let cancelled = false;
  // Baseline response.text would never terminate; use a finite oversized stream for red/green.
  let chunks = 0;
  const finite = new ReadableStream({ pull(controller) { if (++chunks > 8) controller.close(); else controller.enqueue(new Uint8Array(256 * 1024)); }, cancel() { cancelled = true; } });
  await assert.rejects(runModelReview({ ...request, fetchImpl: async () => new Response(finite) }), /REVIEW_OUTPUT_TOO_LARGE/);
  assert.equal(cancelled, true);
});

for (const modification of ['new-file', 'edited-skill', 'edited-auxiliary', 'extra-empty-directory']) {
  test(`audit: purge preserves backup with ${modification}, in preview and execution`, t => {
    const base = temp(t), target = path.join(base, 'target');
    installSkills({ staging: staging(base, 'v1', 'v1', { 'sections/a.md': 'aux' }), target });
    installSkills({ staging: staging(base, 'v2', 'v2', { 'sections/a.md': 'aux2' }), target });
    const backups = path.join(target, '.gstack861-backups'), backup = path.join(backups, fs.readdirSync(backups)[0]);
    if (modification === 'new-file') fs.writeFileSync(path.join(backup, 'my-notes.md'), 'keep');
    if (modification === 'edited-skill') fs.writeFileSync(path.join(backup, 'SKILL.md'), 'user edit');
    if (modification === 'edited-auxiliary') fs.writeFileSync(path.join(backup, 'sections/a.md'), 'user edit');
    if (modification === 'extra-empty-directory') fs.mkdirSync(path.join(backup, 'my-directory'));
    assert.deepEqual(uninstallSkills({ target, purge: true, dryRun: true }).wouldPurge, []);
    assert.equal(uninstallSkills({ target, purge: true }).backupsRemoved, 0);
    assert.ok(fs.existsSync(backup));
  });
}

test('audit: installer rejects directory symlinks in listed staging paths before creating target', t => {
  const base = temp(t), stage = staging(base, 'stage', 'body', { 'sections/a.md': 'aux' }), target = path.join(base, 'target');
  const outside = path.join(base, 'outside'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'a.md'), 'aux');
  fs.rmSync(path.join(stage, 'alpha/sections'), { recursive: true });
  fs.symlinkSync(outside, path.join(stage, 'alpha/sections'), process.platform === 'win32' ? 'junction' : 'dir');
  for (const dryRun of [true, false]) assert.throws(() => installSkills({ staging: stage, target, dryRun }), /STAGING/);
  assert.ok(!fs.existsSync(target));
});

test('audit: staging manifest must be a plain file, not a hardlink', t => {
  const base = temp(t), stage = staging(base, 'stage'), target = path.join(base, 'target');
  fs.linkSync(path.join(stage, 'alpha/manifest.json'), path.join(base, 'other-manifest.json'));
  assert.throws(() => installSkills({ staging: stage, target }), /STAGING/);
  assert.ok(!fs.existsSync(target));
});

for (const slug of ['.', '..']) {
  test(`audit: v2 slug cache cannot nominate ${slug} as a project directory`, t => {
    const base = temp(t), cwd = path.join(base, 'project'), stateRoot = path.join(base, 'state');
    fs.mkdirSync(cwd); fs.writeFileSync(path.join(cwd, 'package.json'), '{}');
    const cacheDir = path.join(stateRoot, 'slug-cache'); fs.mkdirSync(cacheDir, { recursive: true });
    const encoded = process.platform === 'win32' ? cwd.replace(/[:/\\]/g, '_') : cwd.replace(/\//g, '_');
    fs.writeFileSync(path.join(cacheDir, encoded), `v2:${slug}`);
    assert.equal(resolveIdentity({ cwd, stateRoot, env: {} }).slug, 'project');
  });
}

for (const timestamp of [2000, '900', null, -1]) {
  test(`audit: visibility ignores invalid/future timestamp ${JSON.stringify(timestamp)}`, t => {
    const stateRoot = temp(t);
    fs.writeFileSync(path.join(stateRoot, 'sealed-visibility.json'), JSON.stringify({ entries: { 'owner/repo': { visibility: 'private', checked_at: timestamp } } }));
    let calls = 0;
    const found = resolveVisibility('https://github.com/owner/repo.git', { stateRoot, now: 1000, gh() { calls++; return { ok: true, out: '{"visibility":"PUBLIC"}' }; } });
    assert.equal(found.visibility, 'public'); assert.equal(calls, 1);
  });
}

// R7: the proxy's one-call budget must also cover automatic HTTP redirects.
test('audit: development proxy refuses a 307 rather than issuing a second upstream POST', async t => {
  let requests = 0;
  const stub = http.createServer((req, res) => { requests++; req.resume(); req.on('end', () => {
    if (req.url === '/first') { res.writeHead(307, { location: '/second' }); res.end(); }
    else { res.writeHead(200); res.end('{}'); }
  }); });
  stub.listen(0, '127.0.0.1'); await once(stub, 'listening');
  t.after(() => { stub.closeAllConnections(); stub.close(); });
  const child = spawn(process.execPath, ['scripts/dev-gateway.mjs'], { cwd: new URL('../', import.meta.url), env: { ...process.env, DEEPSEEK_API_KEY: KEY, DEV_GATEWAY_UPSTREAM: `http://127.0.0.1:${stub.address().port}/first` }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill());
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('gateway startup timeout')), 10000);
    let text = '';
    child.stdout.on('data', b => { text += b; const match = /PORT (\d+)/.exec(text); if (match) { clearTimeout(timer); resolve(Number(match[1])); } });
    child.once('error', e => { clearTimeout(timer); reject(e); });
    child.once('exit', () => { clearTimeout(timer); reject(new Error('gateway exited before port')); });
  });
  const { cert } = JSON.parse(fs.readFileSync(new URL('../scripts/dev-gateway-certs.json', import.meta.url), 'utf8'));
  const status = await new Promise((resolve, reject) => {
    const req = https.request({ host: '127.0.0.1', port, path: '/chat/completions', method: 'POST', ca: cert, timeout: 10000 }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject); req.on('timeout', () => req.destroy(new Error('request timeout'))); req.end('{}');
  });
  assert.equal(status, 502); assert.equal(requests, 1);
});

function hookRepo(t) {
  const base = temp(t), repo = path.join(base, 'repo'); fs.mkdirSync(repo);
  // Git for Windows does not accept Node's \\.\\nul device path as a config file.
  // A private empty file isolates user/system config identically on every platform.
  const gitConfig = path.join(base, 'empty-git-config'); fs.writeFileSync(gitConfig, '');
  const env = { ...process.env, GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_SYSTEM: gitConfig, GIT_CONFIG_NOSYSTEM: '1' };
  for (const key of Object.keys(env)) if (/^GIT_CONFIG_(?:COUNT|KEY_\d+|VALUE_\d+|PARAMETERS)$/.test(key)) delete env[key];
  execFileSync('git', ['init', '-q'], { cwd: repo, env });
  return { base, repo, hooks: path.join(repo, '.git/hooks'), env };
}

test('audit: hook installation never overwrites an existing pre-push.local', t => {
  const f = hookRepo(t), hook = path.join(f.hooks, 'pre-push'), local = path.join(f.hooks, 'pre-push.local');
  fs.writeFileSync(hook, '#!/bin/sh\necho current\n', { mode: 0o755 });
  fs.writeFileSync(local, '#!/bin/sh\necho previous\n', { mode: 0o755 });
  const bin = new URL('../bin/gstack861-redact.mjs', import.meta.url);
  assert.throws(() => execFileSync(process.execPath, [fileURLToPath(bin), 'install-prepush-hook'], { cwd: f.repo, env: f.env, stdio: 'pipe' }));
  assert.equal(fs.readFileSync(hook, 'utf8'), '#!/bin/sh\necho current\n');
  assert.equal(fs.readFileSync(local, 'utf8'), '#!/bin/sh\necho previous\n');
});

test('audit: generated pre-push wrapper treats shell metacharacters in install path literally', t => {
  const f = hookRepo(t), install = path.join(f.base, "tools $(touch INJECTED) 'quote");
  fs.mkdirSync(path.join(install, 'bin'), { recursive: true });
  fs.cpSync(new URL('../src/', import.meta.url), path.join(install, 'src'), { recursive: true });
  fs.copyFileSync(new URL('../bin/gstack861-redact.mjs', import.meta.url), path.join(install, 'bin/gstack861-redact.mjs'));
  fs.writeFileSync(path.join(install, 'bin/gstack861-redact-prepush.mjs'), "process.stdout.write('AUDIT_REAL_BINARY\\n');\n");
  execFileSync(process.execPath, [path.join(install, 'bin/gstack861-redact.mjs'), 'install-prepush-hook'], { cwd: f.repo, env: f.env, stdio: 'pipe' });
  let output = '';
  try { output = execFileSync('bash', [path.join(f.hooks, 'pre-push')], { cwd: f.repo, env: f.env, encoding: 'utf8', input: '', stdio: 'pipe' }); } catch { /* assertions below distinguish interpolation from execution */ }
  assert.equal(fs.existsSync(path.join(f.repo, 'INJECTED')), false, 'install path must not execute command substitution');
  assert.match(output, /AUDIT_REAL_BINARY/);
});

// A malformed configuration is not evidence that a repository opted out of the publication guard.
test('audit: malformed sealed policy with an escaped key fails closed', t => {
  const f = hookRepo(t);
  fs.mkdirSync(path.join(f.repo, '.gstack'));
  fs.writeFileSync(path.join(f.repo, '.gstack/pregate.json'), '{"se\\u0061led":{"paths":["private/**"]},');
  execFileSync('git', ['add', '.'], { cwd: f.repo, env: f.env });
  execFileSync('git', ['-c', 'user.name=audit', '-c', 'user.email=audit@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture'], { cwd: f.repo, env: f.env });
  assert.match(sealedPolicyAt(f.repo, 'HEAD', 'fixture').error ?? '', /not valid JSON/);
  assert.ok(sealedPolicyAt(f.repo, 'nonexistent-ref', 'fixture').error, 'unreadable ref must not imply no policy');
});
