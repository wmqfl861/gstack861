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

// Audit #17 negative control: a throwaway self-signed fixture (private key discarded)
// shaped EXACTLY like the shipped dev cert except its Basic KeyUsage includes
// Certificate Sign — it proves the parser below actually reads that bit.
const NEGATIVE_CONTROL_KEYCERTSIGN_PEM = [
  "-----BEGIN CERTIFICATE-----",
  "MIIDaDCCAlCgAwIBAgIUM1rknOwk3r8+3LjaSpS1BTqkf4QwDQYJKoZIhvcNAQEL",
  "BQAwJTEjMCEGA1UEAwwaZ3N0YWNrODYxLW5lZ2F0aXZlLWNvbnRyb2wwHhcNMjYx",
  "MDI5MTMwMjUwWhcNMzYxMDI2MTMwMjUwWjAlMSMwIQYDVQQDDBpnc3RhY2s4NjEt",
  "bmVnYXRpdmUtY29udHJvbDCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEB",
  "ANY+uio+TNXjHN9HV7IrJUlL6PgI9AKzXN0w33keorPA6x+HOojW6Ctst+s9Q/c1",
  "UAhMsrZDOb/K3Ryk29iM4J7sYpKu0xj/B9M3kqR4+T7Od6Ch6UtTAjBhnhcnj15o",
  "lOE0CYnzr3QPVQqfMLQ3NeAW21uJu3EmsC7TQKE78fzPhUjcP+eYUmOoBZfuSjUb",
  "yXPyhgaQ0vLpHgwa4KfBfjgCv4oO6YJsS4Uhf2Ahv1Itc86FoqmxiQ/XKA/BsW2g",
  "cQXeZy2JAakCNpSmhQb1WosBU/FeGyKqwppz4ZdBebKmJRqY0UGmKw0gBupY7e/M",
  "LUxbuTXdQOtC1kadH7NApbECAwEAAaOBjzCBjDAdBgNVHQ4EFgQUiCXq8dmYXmqn",
  "KZAnhExXETCHFTwwHwYDVR0jBBgwFoAUiCXq8dmYXmqnKZAnhExXETCHFTwwDAYD",
  "VR0TAQH/BAIwADAOBgNVHQ8BAf8EBAMCAoQwLAYDVR0RBCUwI4cEfwAAAYcQAAAA",
  "AAAAAAAAAAAAAAAAAYIJbG9jYWxob3N0MA0GCSqGSIb3DQEBCwUAA4IBAQBngzRD",
  "F4yK0Ez9pR9Xuu/cnqhBISjcexzgefDRczfyAUwdf0dFG3GnaL3wJMwXNKcDx+kz",
  "owa95of4mL9WlGjiT2BgIgu/7OP6haF/n+mDzvSbvtlL2hCPZ/MFWaDBFbMnLHw6",
  "hiCKfaGN4XmehSaVdm+eYjEAIsejGzcoOAvBi0Yz0uY4/MQKrZBwaa53tOnCJ0jH",
  "o4nsjhC9gHwAfoC3LlXI/TJF6njPr1e7D6fZN3Teq1KwONTGYNWB25E21/pgrHqg",
  "Lt3eJ8npWDw4o7MtFP76qsRxQGn+JQtiOTQagkI8YzR1sA1JRX6WujtW8vYNxrOQ",
  "VsyYVPU8WKSvhgg4",
  "-----END CERTIFICATE-----",
].join('\n');

/** Audit #17: X509Certificate.keyUsage surfaces EKU OIDs (or undefined), NOT the
 *  Basic KeyUsage bits — a cert WITH keyCertSign passed the old text check vacuously.
 *  Read the 2.5.29.15 extension from the DER and return its content byte; bit 5
 *  (mask 0x04) is keyCertSign. */
function basicKeyUsageByte(pem) {
  const der = new X509Certificate(pem).raw;
  const marker = Buffer.from([0x06, 0x03, 0x55, 0x1d, 0x0f]); // OID 2.5.29.15 (KeyUsage)
  const at = der.indexOf(marker);
  assert.notEqual(at, -1, 'the cert must carry a Basic KeyUsage extension');
  let i = at + marker.length;
  if (der[i] === 0x01) i += 3; // optional "critical" BOOLEAN
  assert.equal(der[i], 0x04, 'KeyUsage extnValue is an OCTET STRING');
  assert.ok(der[i + 1] < 0x80, 'short-form length (a KeyUsage value is tiny)');
  const inner = der.subarray(i + 2, i + 2 + der[i + 1]);
  assert.equal(inner[0], 0x03, 'the extension body is a BIT STRING');
  assert.equal(inner[1], inner.length - 2, 'BIT STRING length covers its whole body');
  return inner[3]; // [tag, length, unusedBits, contentByte]
}

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

test('embedded cert: self-signed LEAF (CA:FALSE), EXACT loopback SAN set, >=3650-day validity', () => {
  const { cert } = certs();
  const x509 = new X509Certificate(cert);
  assert.equal(x509.subject, x509.issuer, 'self-signed (subject == issuer)');
  assert.equal(x509.subject.split('\n').find(l => l.startsWith('CN=')), 'CN=gstack861-dev-gateway');
  const days = (Date.parse(x509.validTo) - Date.parse(x509.validFrom)) / (24 * 3600 * 1000);
  assert.ok(days >= 3650, `cert validity ${days.toFixed(0)}d < 3650d — plan-review floor; CI would break`);
  // Audit #8: the PUBLIC key must be a leaf — trusting it via NODE_EXTRA_CA_CERTS grants nothing
  // beyond the loopback names below (no CA signing capability, no extra SANs to impersonate).
  assert.equal(x509.ca, false, 'must be a LEAF (BasicConstraints CA:FALSE), never a CA');
  // Audit #17: read the Basic KeyUsage from the DER — X509Certificate.keyUsage does
  // NOT carry it (an EKU-OID/undefined read let a keyCertSign cert pass vacuously).
  assert.equal(basicKeyUsageByte(cert) & 0x04, 0, 'leaf Basic KeyUsage must not include keyCertSign');
  assert.equal(typeof x509.subjectAltName, 'string', 'subjectAltName must be present');
  assert.deepEqual(
    new Set(x509.subjectAltName.split(', ')),
    new Set(['IP Address:127.0.0.1', 'IP Address:0:0:0:0:0:0:0:1', 'DNS:localhost']),
    'SAN set must be EXACTLY the three loopback identities — no extras');
  // SAN proof is behavioral (test below): IP-literal fetch succeeds only with an IP SAN.
});

test('Basic KeyUsage parser is load-bearing: a CA:FALSE cert WITH keyCertSign is detected (audit #17)', () => {
  const nc = new X509Certificate(NEGATIVE_CONTROL_KEYCERTSIGN_PEM);
  assert.equal(nc.ca, false, 'the control is CA:FALSE like the shipped leaf — only KeyUsage differs');
  assert.notEqual(basicKeyUsageByte(NEGATIVE_CONTROL_KEYCERTSIGN_PEM) & 0x04, 0,
    'the parser must actually see the Certificate Sign bit this fixture carries');
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

// --- Audit #7: the cap must hold while a body is still being READ, not just between requests.
// Every scenario asserts the real invariant directly: the counting stub upstream receives
// EXACTLY ONE call per gateway process, no matter how many POSTs are accepted.

// Fresh gateway + counting stub per scenario — the single-slot state must start clean.
async function startCapHarness() {
  const calls = []; // one entry per request the stub upstream actually receives
  const stub = http.createServer((req, res) => {
    calls.push(Date.now()); // counted at arrival: the audit's "upstream calls" metric
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: '{"verdict":"approve"}' } }] }));
    });
  });
  await new Promise(r => stub.listen(0, '127.0.0.1', r));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'g861-a7-'));
  fs.writeFileSync(path.join(tmp, 'ca.pem'), certs().cert);
  const { child, port } = await startGateway({ DEV_GATEWAY_UPSTREAM: `http://127.0.0.1:${stub.address().port}/chat/completions`, DEEPSEEK_API_KEY: 'stub-key' });
  return {
    port, calls, tmp,
    stop() { child.kill(); stub.close(); fs.rmSync(tmp, { recursive: true, force: true }); },
  };
}

// Probe runner: fresh child with NODE_EXTRA_CA_CERTS (same trust mechanism as the real call).
const runProbe = (tmp, script, timeoutMs = 30000) => new Promise((resolve, reject) => {
  const probe = spawn(process.execPath, ['-e', script], { env: { ...process.env, NODE_EXTRA_CA_CERTS: path.join(tmp, 'ca.pem') }, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  probe.stdout.on('data', d => { out += d.toString(); });
  probe.stderr.on('data', d => { out += d.toString(); });
  const timer = setTimeout(() => { probe.kill(); reject(new Error(`probe timed out: ${out}`)); }, timeoutMs);
  probe.on('exit', code => { clearTimeout(timer); resolve({ code, out }); });
  probe.on('error', reject);
});

// Raw https.request probe that leaves the body HALF-WRITTEN for gapMs, then finishes it.
const chunkedPost = (port, gapMs) => `
  const https = require('https');
  let answered = false;
  const req = https.request({ host: '127.0.0.1', port: ${port}, path: '/chat/completions', method: 'POST', headers: { 'content-type': 'application/json' } }, res => {
    answered = true;
    console.log('STATUS', res.statusCode);
    res.resume();
    res.on('end', () => process.exit(0));
  });
  req.on('error', e => { if (!answered) { console.log('ERR', e.code ?? e.message); process.exit(2); } else process.exit(0); });
  req.write('{"model":"x","part":1,');
  setTimeout(() => { try { req.end('"part":2}'); } catch {} }, ${gapMs});
`;

// Probe that claims the slot, writes half a body, then destroys the connection.
const abortPost = port => `
  const https = require('https');
  const req = https.request({ host: '127.0.0.1', port: ${port}, path: '/chat/completions', method: 'POST', headers: { 'content-type': 'application/json' } }, res => {
    console.log('UNEXPECTED_STATUS', res.statusCode); process.exit(3);
  });
  req.on('error', () => {}); // destroying our own half-sent request surfaces ECONNRESET locally
  req.write('{"model":"x","half');
  setTimeout(() => { req.destroy(); console.log('ABORTED'); process.exit(0); }, 300);
`;

// Plain fetch POST — a complete, well-formed request body in one shot.
const fullPost = port => `
  fetch('https://127.0.0.1:${port}/chat/completions', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({model:'x'}) })
    .then(r => { console.log('STATUS', r.status); process.exit(0); }, e => { console.log('ERR', e?.cause?.code ?? e?.name); process.exit(2); });
`;

// Poll /healthz (GET, never counted against the cap) until the gateway reports posts=0 again.
async function waitForSlotRelease(tmp, port) {
  for (let i = 0; i < 40; i++) {
    const probe = spawnSync(process.execPath, ['-e', `
      fetch('https://127.0.0.1:${port}/healthz').then(r => r.json()).then(j => console.log('POSTS', j.posts), () => console.log('POSTS ?'));
    `], { env: { ...process.env, NODE_EXTRA_CA_CERTS: path.join(tmp, 'ca.pem') }, encoding: 'utf8', timeout: 15000 });
    const m = probe.stdout.match(/POSTS (\d+)/);
    if (m && Number(m[1]) === 0) return;
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error('slot was never released after the client abort');
}

test('cap TOCTOU: two concurrent half-written bodies -> exactly ONE upstream call, loser 429 (audit #7)', async () => {
  const h = await startCapHarness();
  try {
    const gap = 600; // both bodies sit half-written well past accept time
    const [a, b] = await Promise.all([runProbe(h.tmp, chunkedPost(h.port, gap)), runProbe(h.tmp, chunkedPost(h.port, gap))]);
    const statuses = [a.out.match(/STATUS (\d+)/)?.[1], b.out.match(/STATUS (\d+)/)?.[1]].sort();
    assert.deepEqual(statuses, ['200', '429'], `exactly one winner (200) and one capped loser (429): ${a.out} | ${b.out}`);
    assert.equal(h.calls.length, 1, `upstream stub must receive EXACTLY 1 call, got ${h.calls.length}`);
  } finally { h.stop(); }
}, { timeout: 60000 });

test('cap TOCTOU: slow body HOLDS the slot — a full POST mid-body gets 429, slow POST still 200, ONE upstream call (audit #7)', async () => {
  const h = await startCapHarness();
  try {
    const slow = runProbe(h.tmp, chunkedPost(h.port, 1500)); // body sits half-written for 1.5s
    await new Promise(r => setTimeout(r, 500)); // land inside the half-written window
    const fast = await runProbe(h.tmp, fullPost(h.port));
    assert.match(fast.out, /STATUS 429/, `POST arriving while a body is still unread must be capped: ${fast.out}`);
    const first = await slow;
    assert.match(first.out, /STATUS 200/, `slow-body first POST must still forward (200): ${first.out}`);
    assert.equal(h.calls.length, 1, `upstream stub must receive EXACTLY 1 call, got ${h.calls.length}`);
  } finally { h.stop(); }
}, { timeout: 60000 });

test('cap release: client abort mid-body frees the slot; a later valid POST forwards — ONE upstream call (audit #7)', async () => {
  const h = await startCapHarness();
  try {
    const aborted = await runProbe(h.tmp, abortPost(h.port));
    assert.match(aborted.out, /ABORTED/, `abort probe must destroy its half-written request: ${aborted.out}`);
    await waitForSlotRelease(h.tmp, h.port); // the gateway must hand the slot back (posts=0)
    const after = await runProbe(h.tmp, fullPost(h.port));
    assert.match(after.out, /STATUS 200/, `valid POST after an aborted claim must still forward (200): ${after.out}`);
    assert.equal(h.calls.length, 1, `aborted request must never reach upstream — stub got ${h.calls.length} calls`);
  } finally { h.stop(); }
}, { timeout: 90000 });
