// Offline tests for the batch-28 dev gateway. The TLS mechanism is proven the
// only valid way: a FRESH child node process with NODE_EXTRA_CA_CERTS in its
// env performs a real fetch to https://127.0.0.1:<port>/healthz — in-process
// env assignment is a no-op for an already-started Node, and a custom ca fetch
// option would not prove the mechanism the real call relies on. The single-call
// cap runs against a LOCAL stub upstream (DEV_GATEWAY_UPSTREAM) — the suite
// stays offline: no third-party endpoint is ever contacted from tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { X509Certificate } from 'node:crypto';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GATEWAY = path.join(repoRoot, 'scripts/dev-gateway.mjs');
const certs = () => JSON.parse(fs.readFileSync(path.join(repoRoot, 'scripts/dev-gateway-certs.json'), 'utf8'));

function startGateway(env = {}) {
  const child = spawn(process.execPath, [GATEWAY], { env: { ...process.env, DEEPSEEK_API_KEY: '', ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  return new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error(`gateway did not announce PORT: ${buf}`)), 15000);
    child.stdout.on('data', d => {
      buf += d.toString();
      const m = buf.match(/PORT (\d+)/);
      if (m) { clearTimeout(timer); resolve({ child, port: Number(m[1]) }); }
    });
    child.on('exit', code => reject(new Error(`gateway exited ${code}: ${buf}`)));
  });
}

test('embedded cert: self-signed, loopback-only SANs, >=3650-day validity', () => {
  const { cert } = certs();
  const x509 = new X509Certificate(cert);
  assert.equal(x509.subject, x509.issuer, 'self-signed (subject == issuer)');
  assert.equal(x509.subject.split('\n').find(l => l.startsWith('CN=')), 'CN=gstack861-dev-gateway');
  const days = (Date.parse(x509.validTo) - Date.parse(x509.validFrom)) / (24 * 3600 * 1000);
  assert.ok(days >= 3650, `cert validity ${days.toFixed(0)}d < 3650d — plan-review floor; CI would break`);
  // SAN proof is behavioral (test below): IP-literal fetch succeeds only with an IP SAN.
});

test('TLS mechanism: fresh child with NODE_EXTRA_CA_CERTS fetches https://127.0.0.1/healthz (200, posts=0)', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'g861-ca-'));
  fs.writeFileSync(path.join(tmp, 'ca.pem'), certs().cert);
  const { child, port } = await startGateway();
  try {
    const probe = spawnSync(process.execPath, ['-e', `
      fetch('https://127.0.0.1:${port}/healthz')
        .then(r => r.json())
        .then(j => { if (!j.ok) throw new Error('not ok'); console.log('HEALTHZ_OK posts=' + j.posts); })
        .catch(e => { console.error('FAIL', e?.cause?.code ?? e.message); process.exit(1); });
    `], { env: { ...process.env, NODE_EXTRA_CA_CERTS: path.join(tmp, 'ca.pem') }, encoding: 'utf8', timeout: 20000 });
    assert.equal(probe.status, 0, `child fetch failed: ${probe.stderr}${probe.stdout}`);
    assert.match(probe.stdout, /HEALTHZ_OK posts=0/);
  } finally { child.kill(); fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('TLS without the CA in a fresh child must FAIL (proves trust comes from NODE_EXTRA_CA_CERTS)', async () => {
  const { child, port } = await startGateway();
  try {
    const probe = spawnSync(process.execPath, ['-e', `
      fetch('https://127.0.0.1:${port}/healthz').then(() => { console.log('UNEXPECTED_OK'); }, e => { console.log('REJECTED', e?.cause?.code ?? e?.name); });
    `], { encoding: 'utf8', timeout: 20000 }); // no NODE_EXTRA_CA_CERTS
    assert.match(probe.stdout, /REJECTED/);
    assert.doesNotMatch(probe.stdout, /UNEXPECTED_OK/);
  } finally { child.kill(); }
});

test('single-call cap: first POST forwards (non-429 status), second gets exactly 429 — local stub upstream, zero network', async () => {
  // Local stub upstream: deterministic 200 JSON; DEV_GATEWAY_UPSTREAM overrides the
  // hardcoded DeepSeek URL so no third-party endpoint is ever contacted.
  const stub = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      if (!req.headers.authorization || req.headers.authorization === 'Bearer local' || req.headers.authorization === 'Bearer undefined') {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'stub: bad key' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: '{"verdict":"approve","findings":[]}' } }] }));
    });
  });
  await new Promise(r => stub.listen(0, '127.0.0.1', r));
  const stubPort = stub.address().port;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'g861-cap-'));
  fs.writeFileSync(path.join(tmp, 'ca.pem'), certs().cert);
  const { child, port } = await startGateway({ DEV_GATEWAY_UPSTREAM: `http://127.0.0.1:${stubPort}/chat/completions`, DEEPSEEK_API_KEY: 'stub-key' });
  try {
    // Async spawn (NOT spawnSync): the stub lives in THIS process — a sync wait
    // would freeze the event loop, the stub could never answer the gateway's
    // upstream fetch, and the first POST would dead-lock into the 30s abort.
    const post = () => new Promise((resolve, reject) => {
      const probe = spawn(process.execPath, ['-e', `
        fetch('https://127.0.0.1:${port}/chat/completions', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({model:'x'}) })
          .then(async r => { console.log('STATUS', r.status); process.exit(0); }, e => { console.log('ERR', e?.cause?.code ?? e?.name); process.exit(2); });
      `], { env: { ...process.env, NODE_EXTRA_CA_CERTS: path.join(tmp, 'ca.pem') }, stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '';
      probe.stdout.on('data', d => { out += d.toString(); });
      probe.on('exit', code => resolve({ code, out }));
      probe.on('error', reject);
      setTimeout(() => { probe.kill(); reject(new Error('probe timed out')); }, 40000);
    });
    const first = await post();
    assert.equal(first.code, 0, `first POST child crashed: ${first.out}`);
    assert.match(first.out, /STATUS 200/, `first POST must forward to the stub (200): ${first.out}`);
    assert.doesNotMatch(first.out, /STATUS 429/, 'first POST must NOT hit the cap');
    const second = await post();
    assert.equal(second.code, 0, `second POST child crashed: ${second.out}`);
    assert.match(second.out, /STATUS 429/, `second POST must be capped with exactly 429: ${second.out}`);
  } finally { child.kill(); stub.close(); fs.rmSync(tmp, { recursive: true, force: true }); }
}, { timeout: 120000 });
