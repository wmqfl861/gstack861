import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadGateway, resolveKey } from '../src/gateway.mjs';

// A fake key planted in configs and environments. Nothing loadGateway/resolveKey throws or
// returns (besides resolveKey's deliberate one-time handoff) may ever contain this value.
const PLANTED_KEY = 'planted-gateway-key-do-not-leak-7f3a91';
const KEY_ENV = 'GSTACK861_TEST_PLANTED_GATEWAY_KEY';

const VALID = {
  schemaVersion: 1,
  baseUrl: 'https://custom-gw.example.test/v1',
  apiKeyEnv: KEY_ENV,
  model: 'test-model',
  maxTokens: 1024,
};

function fixture(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gstack861-gateway-')));
  const workspace = path.join(base, 'workspace');
  fs.mkdirSync(workspace);
  const write = (config, dir = base, name = 'gateway.json') => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, typeof config === 'string' ? config : JSON.stringify(config), { mode: 0o600 });
    return file;
  };
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return { base, workspace, write };
}

function capture(fn) {
  try { fn(); return null; } catch (thrown) { return thrown; }
}

/** The error exists and is inert: message, stack and any JSON form never echo the planted key. */
function inert(thrown, label) {
  assert.ok(thrown instanceof Error, `must throw: ${label}`);
  const texts = [thrown.message, thrown.stack, JSON.stringify({ ...thrown, cause: thrown.cause })];
  assert.ok(texts.every(text => !text || !text.includes(PLANTED_KEY)), `errors must never echo the key value: ${label}`);
  return thrown;
}

function refuses(fn, pattern, label = 'gateway') {
  const thrown = inert(capture(fn), label);
  assert.match(thrown.message, pattern, label);
  return thrown;
}

test('a valid https gateway loads to the exact frozen normalized shape', t => {
  const f = fixture(t);
  const gateway = loadGateway(f.write(VALID), { workspace: f.workspace });
  assert.deepEqual(gateway, { schemaVersion: 1, ...VALID });
  assert.equal('note' in gateway, false, 'an absent optional note must stay out of the normalized shape');
  assert.throws(() => { gateway.model = 'mutated'; }, TypeError);
  const noted = loadGateway(f.write({ ...VALID, note: 'local echo smoke' }, f.base, 'noted.json'), { workspace: f.workspace });
  assert.deepEqual(noted, { schemaVersion: 1, ...VALID, note: 'local echo smoke' });
  // Inclusive schema boundaries: 128-char model, 8192 tokens, 256-char note.
  const bounds = loadGateway(
    f.write({ ...VALID, model: 'm'.repeat(128), maxTokens: 8192, note: 'n'.repeat(256) }, f.base, 'bounds.json'),
    { workspace: f.workspace },
  );
  assert.equal(bounds.maxTokens, 8192);
});

test('plain http is allowed only for the three loopback hosts the local echo smoke needs', t => {
  const f = fixture(t);
  for (const baseUrl of ['http://127.0.0.1:8787/v1', 'http://localhost:8787/v1', 'http://[::1]:8787/v1']) {
    assert.equal(loadGateway(f.write({ ...VALID, baseUrl }), { workspace: f.workspace }).baseUrl, baseUrl);
  }
});

test('http to any other host, other protocols, empty and unparseable URLs are refused', t => {
  const f = fixture(t);
  for (const baseUrl of [
    'http://gw.example.test/v1', // plaintext off-host would leak the bearer key
    'http://127.0.0.2/v1', // a lookalike address is still not a loopback exception
    'http://localhost.evil.test/v1',
    'ftp://127.0.0.1/v1', // loopback does not whitelist other protocols
    'https://', // special schemes refuse an empty host
    'not-a-url',
  ]) refuses(() => loadGateway(f.write({ ...VALID, baseUrl }), { workspace: f.workspace }), /UNSAFE_BASEURL/, baseUrl);
});

test('official endpoints are forbidden exactly and as subdomains, behind ports and dots', t => {
  const f = fixture(t);
  for (const baseUrl of [
    'https://api.openai.com/v1',
    'https://api.openai.com:8443/v1',
    'https://api.deepseek.com',
    'https://generativelanguage.googleapis.com/v1beta',
    'https://oai.api.openai.com/v1', // subdomain of a blocked host
    'https://API.DEEPSEEK.COM/v1', // case-folded before matching
    'https://api.openai.com./v1', // a trailing dot is the same DNS host
  ]) refuses(() => loadGateway(f.write({ ...VALID, baseUrl }), { workspace: f.workspace }), /OFFICIAL_ENDPOINT_FORBIDDEN/, baseUrl);
});

test('non-blocklisted custom gateways pass; matching is domain-anchored, not substring', t => {
  const f = fixture(t);
  for (const baseUrl of ['https://custom-gw.example.test/v1', 'https://api.openai.com.evil.test/v1', 'https://api.deepseek.com.example.org/v1']) {
    assert.equal(loadGateway(f.write({ ...VALID, baseUrl }), { workspace: f.workspace }).baseUrl, baseUrl);
  }
});

test('baseUrl query, fragment and userinfo are refused at load; trailing slashes normalize away (audit #10)', t => {
  const f = fixture(t);
  // These components would misroute the executor's joined request path, so load refuses.
  for (const baseUrl of [
    'https://custom-gw.example.test/v1?api-version=x',
    'https://custom-gw.example.test/v1#fragment',
    'https://user@example.test/v1',
    // Round 3 (audit #18): userinfo comes in a password-only form too.
    'https://:password@example.test/v1',
    'https://user@example.test/v1',
    'https://user:pass@example.test/v1',
  ]) refuses(() => loadGateway(f.write({ ...VALID, baseUrl }), { workspace: f.workspace }), /UNSAFE_BASEURL/, baseUrl);
  // A trailing slash is harmless and normalizes away, keeping the join exact.
  for (const [configured, normalized] of [
    ['https://custom-gw.example.test/v1/', 'https://custom-gw.example.test/v1'],
    ['https://custom-gw.example.test/v1///', 'https://custom-gw.example.test/v1'],
    ['https://custom-gw.example.test/', 'https://custom-gw.example.test'],
    ['https://custom-gw.example.test', 'https://custom-gw.example.test'],
  ]) assert.equal(loadGateway(f.write({ ...VALID, baseUrl: configured }), { workspace: f.workspace }).baseUrl, normalized, configured);
});

test('every malformed schema field, unknown key and broken JSON is INVALID_GATEWAY', t => {
  const f = fixture(t);
  const cases = [
    ['schemaVersion', 2], ['schemaVersion', '1'],
    ['baseUrl', 42], ['baseUrl', ''],
    ['apiKeyEnv', ''], ['apiKeyEnv', 'lowercase_name'], ['apiKeyEnv', 'GATEWAY-KEY'], ['apiKeyEnv', '1LEAD'],
    ['model', ''], ['model', 7], ['model', 'm'.repeat(129)],
    ['maxTokens', 0], ['maxTokens', 8193], ['maxTokens', 1.5], ['maxTokens', '1024'],
    ['note', 7], ['note', 'n'.repeat(257)],
  ];
  for (const [key, value] of cases) {
    refuses(() => loadGateway(f.write({ ...VALID, [key]: value }), { workspace: f.workspace }), /INVALID_GATEWAY/, `${key}=${JSON.stringify(value)}`);
  }
  for (const key of ['schemaVersion', 'baseUrl', 'apiKeyEnv', 'model', 'maxTokens']) {
    const config = { ...VALID };
    delete config[key];
    refuses(() => loadGateway(f.write(config), { workspace: f.workspace }), /INVALID_GATEWAY/, `missing ${key}`);
  }
  // Unknown keys are refused — including an inlined key VALUE, which must never be echoed back.
  refuses(() => loadGateway(f.write({ ...VALID, apiKey: PLANTED_KEY }), { workspace: f.workspace }), /INVALID_GATEWAY/, 'inlined apiKey');
  refuses(() => loadGateway(f.write({ ...VALID, extra: true }), { workspace: f.workspace }), /INVALID_GATEWAY/, 'unknown key');
  // Non-object JSON and unparsable text fail closed with the same code.
  for (const text of ['null', '[]', '"a string"', '{ not json']) {
    refuses(() => loadGateway(f.write(text), { workspace: f.workspace }), /INVALID_GATEWAY/, text);
  }
});

test('a relative or control-character filename is refused before touching the filesystem', t => {
  const f = fixture(t);
  refuses(() => loadGateway('gateway.json', { workspace: f.workspace }), /ABSOLUTE_PATH_REQUIRED/, 'relative');
  refuses(() => loadGateway(path.join(f.base, 'g\u0000.json'), { workspace: f.workspace }), /ABSOLUTE_PATH_REQUIRED/, 'NUL');
});

test('oversized, hardlinked and non-regular gateway files are refused', t => {
  const f = fixture(t);
  refuses(() => loadGateway(f.write(`{"pad":"${'x'.repeat(17 * 1024)}"}`), { workspace: f.workspace }), /UNSAFE_GATEWAY_FILE/, '17 KiB');
  const real = f.write(VALID, f.base, 'real.json');
  fs.linkSync(real, path.join(f.base, 'hardlinked.json'));
  refuses(() => loadGateway(path.join(f.base, 'hardlinked.json'), { workspace: f.workspace }), /UNSAFE_GATEWAY_FILE/, 'hardlink');
  refuses(() => loadGateway(f.base, { workspace: f.workspace }), /UNSAFE_GATEWAY_FILE/, 'directory');
});

test('a symlinked gateway is refused, not followed (POSIX)', t => {
  if (process.platform === 'win32') return t.skip('POSIX only');
  const f = fixture(t);
  const real = f.write(VALID, f.base, 'real.json');
  const alias = path.join(f.base, 'alias.json');
  fs.symlinkSync(real, alias);
  refuses(() => loadGateway(alias, { workspace: f.workspace }), /UNSAFE_GATEWAY_FILE/, 'symlink');
});

test('group- or world-writable gateway files are refused (POSIX)', t => {
  if (process.platform === 'win32') return t.skip('POSIX only');
  const f = fixture(t);
  const file = f.write(VALID);
  fs.chmodSync(file, 0o666);
  refuses(() => loadGateway(file, { workspace: f.workspace }), /UNSAFE_GATEWAY_PERMISSIONS/, 'mode 0o666');
});

test('a gateway inside the model-editable workspace is refused', t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.workspace, 'nested'));
  for (const file of [f.write(VALID, f.workspace), f.write(VALID, path.join(f.workspace, 'nested'))]) {
    refuses(() => loadGateway(file, { workspace: f.workspace }), /GATEWAY_MUST_BE_OUTSIDE_WORKSPACE/, file);
  }
});

test('resolveKey hands off the named env var and refuses missing or empty keys', t => {
  const f = fixture(t);
  const gateway = loadGateway(f.write(VALID), { workspace: f.workspace });
  assert.equal(resolveKey(gateway, { [KEY_ENV]: PLANTED_KEY }), PLANTED_KEY); // the one-time handoff IS its purpose
  refuses(() => resolveKey(gateway, {}), /GATEWAY_KEY_MISSING/, 'missing');
  refuses(() => resolveKey(gateway, { [KEY_ENV]: '' }), /GATEWAY_KEY_MISSING/, 'empty');
  refuses(() => resolveKey(gateway, { OTHER_ENV: PLANTED_KEY }), /GATEWAY_KEY_MISSING/, 'must not dump the env');
  refuses(() => resolveKey(gateway), /GATEWAY_KEY_MISSING/, 'default env; this test-only name is never set');
});

test('no thrown error or loaded config ever contains the planted key value', t => {
  const f = fixture(t);
  // The key is present in the environment throughout; every refusal below must stay inert.
  const env = { [KEY_ENV]: PLANTED_KEY, DECOY_ENV: PLANTED_KEY };
  const attempts = [
    () => loadGateway(f.write({ ...VALID, baseUrl: 'https://api.openai.com/v1' }), { workspace: f.workspace }),
    () => loadGateway(f.write({ ...VALID, baseUrl: 'http://gw.example.test/v1' }), { workspace: f.workspace }),
    () => loadGateway(f.write({ ...VALID, apiKey: PLANTED_KEY }), { workspace: f.workspace }),
    () => loadGateway(f.write(VALID, f.workspace), { workspace: f.workspace }),
    () => loadGateway(f.write('{ not json'), { workspace: f.workspace }),
    () => resolveKey(loadGateway(f.write(VALID), { workspace: f.workspace }), { [KEY_ENV]: '' }),
  ];
  for (const attempt of attempts) inert(capture(attempt), 'inert battery');
  // The loaded config carries the env-var NAME only; the value surfaces solely via resolveKey.
  const gateway = loadGateway(f.write(VALID, f.base, 'ok.json'), { workspace: f.workspace });
  assert.ok(!JSON.stringify(gateway).includes(PLANTED_KEY));
  assert.equal(resolveKey(gateway, env), PLANTED_KEY);
});
