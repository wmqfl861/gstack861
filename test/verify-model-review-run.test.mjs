// Batch 18 lane C (plan 审计划必改落实 item 3): script-level pins for the real-call entry
// point on scripts/verify-model-review.mjs — the --gateway-config mode that gives unlock-⑨
// an actual trigger. Fully offline: the only "gateway" the script ever reaches in these pins
// is a 127.0.0.1 echo server owned by THIS file (started per case, counting requests and
// capturing headers; its port is handed to the script via --self-test-loopback, so the
// script takes the reuse path and this harness asserts the exact request count itself).
// Real config files are built in per-run mkdtemp dirs (never committed) and live outside the
// repo, i.e. outside the script's workspace (process.cwd()). The planted key value must
// never appear in any child output — asserted wherever the key is in play.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(repoRoot, 'scripts', 'verify-model-review.mjs');
const KEY_ENV = 'GSTACK861_TEST_REALCALL_KEY';
const PLANTED_KEY = 'realcall-planted-key-must-never-print-c3d9';
const CONFIG_BASE = {
  schemaVersion: 1,
  baseUrl: 'https://custom-gw.example.test/v1',
  apiKeyEnv: KEY_ENV,
  model: 'pin-model',
  maxTokens: 64,
};

/** Real config files in a per-run tmpdir, outside the repo (the script's workspace = cwd). */
function fixture(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'g861-vmr-realcall-')));
  const write = (config, name = 'gateway.json') => {
    const file = path.join(base, name);
    fs.writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
    return file;
  };
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return write;
}

/** Deterministic child env: inherit the platform env, then strip the two red-line variables. */
function childEnv(overrides = {}) {
  const env = { ...process.env };
  delete env.GSTACK861_MODEL_CALL;
  delete env[KEY_ENV];
  return { ...env, ...overrides };
}

/** The offline "gateway": a loopback echo server that counts requests and captures headers. */
function echoServer(t) {
  return new Promise((resolve, reject) => {
    const COMPLETION = JSON.stringify({
      choices: [{ message: { role: 'assistant', content: JSON.stringify({ verdict: 'approve', findings: ['script-level pin: the single call reached the harness echo server'] }) } }],
      usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
    });
    let requests = 0;
    let captured = null;
    const server = http.createServer((req, res) => {
      requests++;
      const chunks = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => {
        captured = { method: req.method, url: req.url, authorization: req.headers.authorization };
        res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(COMPLETION) });
        res.end(COMPLETION);
      });
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      t.after(() => new Promise(done => { server.closeAllConnections(); server.close(() => done()); }));
      resolve({ port: server.address().port, count: () => requests, captured: () => captured });
    });
  });
}

/**
 * Async spawn (never spawnSync): the loopback echo server lives in THIS process, so the
 * parent event loop must stay alive to serve the child's single request — spawnSync would
 * park it and deadlock the child into GATEWAY_TIMEOUT until the kill timer fired.
 */
function run(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], { cwd: repoRoot, env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const timer = setTimeout(() => child.kill(), 60000);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', (status, signal) => {
      clearTimeout(timer);
      if (signal) reject(new Error(`script killed by ${signal} after 60 s`));
      else resolve({ status, stdout, stderr });
    });
  });
}

/** The real-call self-test invocation against a harness-owned listener. */
const realCall = (config, port, env) => run(['--gateway-config', config, '--self-test-loopback', String(port)], env);

test('bare invocation unchanged: five-segment keyless readiness, exit 0 (regression pin)', async () => {
  const child = await run([], childEnv());
  assert.equal(child.status, 0, `exit ${child.status}\n--- stdout ---\n${child.stdout}\n--- stderr ---\n${child.stderr}`);
  for (const section of ['[1/5]', '[2/5]', '[3/5]', '[4/5]', '[5/5]']) {
    assert.ok(child.stdout.includes(section), `${section} missing from the readiness output`);
  }
  assert.match(child.stdout, /RESULT: 全部五段通过/);
  assert.ok(child.stdout.includes('exit 0'));
}, { timeout: 90000 });

test("--gateway-config without GSTACK861_MODEL_CALL (unset, '0', 'true'): exit 2 BLOCKED, zero requests", async t => {
  const write = fixture(t);
  const config = write(CONFIG_BASE);
  for (const value of [undefined, '0', 'true']) {
    const echo = await echoServer(t);
    const env = childEnv(value === undefined ? { [KEY_ENV]: PLANTED_KEY } : { GSTACK861_MODEL_CALL: value, [KEY_ENV]: PLANTED_KEY });
    const child = await realCall(config, echo.port, env);
    assert.equal(child.status, 2, `GSTACK861_MODEL_CALL=${value ?? 'unset'}: exit ${child.status}\n--- stdout ---\n${child.stdout}\n--- stderr ---\n${child.stderr}`);
    assert.match(child.stdout, /RESULT: BLOCKED/, `GSTACK861_MODEL_CALL=${value ?? 'unset'}: BLOCKED line`);
    assert.match(child.stdout, /GSTACK861_MODEL_CALL/, 'the message must name the missing switch');
    assert.equal(echo.count(), 0, `GSTACK861_MODEL_CALL=${value ?? 'unset'}: the loopback listener must see zero requests`);
    assert.ok(!child.stdout.includes(PLANTED_KEY), 'the planted key must never print');
  }
}, { timeout: 120000 });

test('happy path: valid config + switch + key + self-test loopback -> exit 0, exactly one request, key never in output', async t => {
  const write = fixture(t);
  const config = write({ ...CONFIG_BASE, note: 'script-level pin' });
  const echo = await echoServer(t);
  const child = await realCall(config, echo.port, childEnv({ GSTACK861_MODEL_CALL: '1', [KEY_ENV]: PLANTED_KEY }));
  assert.equal(child.status, 0, `exit ${child.status}\n--- stdout ---\n${child.stdout}\n--- stderr ---\n${child.stderr}`);
  // The single-call cap, asserted by the harness that owns the listener (not by trusting the script).
  assert.equal(echo.count(), 1, `exactly one request must hit the loopback server (got ${echo.count()})`);
  assert.equal(echo.captured()?.method, 'POST');
  assert.equal(echo.captured()?.url, '/v1/chat/completions');
  assert.equal(echo.captured()?.authorization, `Bearer ${PLANTED_KEY}`, 'the key must travel env -> child request header, end to end');
  // Output discipline: verdict + baseUrl host echoed; never the key, the model, maxTokens or the full baseUrl.
  assert.match(child.stdout, /verdict 'approve'/);
  assert.match(child.stdout, /custom-gw\.example\.test/, 'the baseUrl HOST must be echoed');
  assert.ok(!child.stdout.includes(PLANTED_KEY), 'the key value must never appear in stdout');
  assert.ok(!child.stdout.includes('https://custom-gw.example.test/v1'), 'the full baseUrl must not be printed (host only)');
  assert.ok(!child.stdout.includes('pin-model'), 'the model must not be echoed');
  assert.ok(!child.stdout.includes('maxTokens'), 'maxTokens must not be echoed');
  assert.ok(child.stdout.includes('exit 0'));
}, { timeout: 60000 });

test('config violations: the loadGateway code surfaces with exit 1 and zero requests', async t => {
  const write = fixture(t);
  const echo = await echoServer(t);
  const missing = { ...CONFIG_BASE };
  delete missing.apiKeyEnv;
  const cases = [
    ['official host', { ...CONFIG_BASE, baseUrl: 'https://api.openai.com/v1' }, /OFFICIAL_ENDPOINT_FORBIDDEN/],
    ['plain http off-loopback', { ...CONFIG_BASE, baseUrl: 'http://gw.example.test/v1' }, /UNSAFE_BASEURL/],
    ['missing apiKeyEnv', missing, /INVALID_GATEWAY/],
    ['relative path', 'gateway.json', /ABSOLUTE_PATH_REQUIRED/],
  ];
  for (const [label, config, code] of cases) {
    const file = typeof config === 'string' ? config : write(config, `${label.replace(/\W+/g, '-')}.json`);
    // Switch AND key are both set: the refusal below is provably the config's, not a red-line block.
    const child = await realCall(file, echo.port, childEnv({ GSTACK861_MODEL_CALL: '1', [KEY_ENV]: PLANTED_KEY }));
    assert.equal(child.status, 1, `${label}: exit ${child.status}\n--- stdout ---\n${child.stdout}`);
    assert.match(child.stdout, code, `${label}: the loadGateway code must surface in the output`);
    assert.equal(echo.count(), 0, `${label}: zero requests`);
  }
}, { timeout: 120000 });

test('a symlinked config is refused, not followed (POSIX)', async t => {
  if (process.platform === 'win32') return t.skip('POSIX only (gateway.test.mjs precedent: symlink creation is not portable)');
  const write = fixture(t);
  const real = write(CONFIG_BASE, 'real.json');
  const alias = path.join(path.dirname(real), 'alias.json');
  fs.symlinkSync(real, alias);
  const echo = await echoServer(t);
  const child = await realCall(alias, echo.port, childEnv({ GSTACK861_MODEL_CALL: '1', [KEY_ENV]: PLANTED_KEY }));
  assert.equal(child.status, 1, `exit ${child.status}\n--- stdout ---\n${child.stdout}`);
  assert.match(child.stdout, /UNSAFE_GATEWAY_FILE/);
  assert.equal(echo.count(), 0);
}, { timeout: 60000 });

test('apiKeyEnv set but the env var missing: exit 2 BLOCKED, zero requests', async t => {
  const write = fixture(t);
  const config = write(CONFIG_BASE);
  const echo = await echoServer(t);
  const child = await realCall(config, echo.port, childEnv({ GSTACK861_MODEL_CALL: '1' })); // the key env is deliberately unset
  assert.equal(child.status, 2, `exit ${child.status}\n--- stdout ---\n${child.stdout}`);
  assert.match(child.stdout, /RESULT: BLOCKED/);
  assert.match(child.stdout, new RegExp(KEY_ENV), 'the message must name the apiKeyEnv variable to set (the NAME, never the value)');
  assert.equal(echo.count(), 0, 'zero requests');
}, { timeout: 60000 });

test('usage errors: --self-test-loopback alone, and a flag without a value, refuse with INVALID_ARGUMENTS', async t => {
  const echo = await echoServer(t);
  for (const args of [['--self-test-loopback', String(echo.port)], ['--gateway-config']]) {
    const child = await run(args, childEnv());
    assert.equal(child.status, 1, `${args.join(' ')}: exit ${child.status}\n--- stdout ---\n${child.stdout}`);
    assert.match(child.stdout, /INVALID_ARGUMENTS/);
  }
  assert.equal(echo.count(), 0);
}, { timeout: 60000 });
