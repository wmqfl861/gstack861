// Batch 28: local explicit HTTPS gateway for the ⑨ model-review real call.
//
// Serves https://127.0.0.1:<random port> with an embedded 10-year self-signed
// cert (IP SANs 127.0.0.1/::1 + DNS localhost — IP-literal hosts only match IP
// SANs). One route pair:
//   GET  /healthz            — liveness probe, NOT counted against the cap.
//   POST /chat/completions   — forwarded verbatim to DeepSeek's OpenAI-compatible
//                              endpoint. The upstream request carries ONLY the
//                              gateway's own env credentials; incoming headers are
//                              never spread (the placeholder Bearer would 401).
// Single-call cap: a second POST gets 429 — the repo-wide red line, belt #2 on
// top of runModelReview's single-fetch guarantee. Prints a machine-readable
// `PORT <n>` line, then per-request status/duration lines (never bodies/keys).
//
// LEDGER: scripts/dev-gateway-certs.json commits an intentionally-PUBLIC dev-only key pair — a
// self-signed LEAF (BasicConstraints CA:FALSE, keyUsage without keyCertSign, SANs exactly
// 127.0.0.1/::1/localhost, trusted solely via explicit NODE_EXTRA_CA_CERTS). Being a leaf, the
// public key cannot sign certificates for any other identity: trusting it pins ONLY these
// loopback names. Still set NODE_EXTRA_CA_CERTS just for the dedicated child process / test run,
// never globally or long-term. This pattern must never extend to any key with value — the
// redaction engine rightly flags the PRIVATE KEY marker; this file is the sole, documented
// exception.
// The DEEPSEEK_API_KEY comes exclusively from this process's environment (the
// coordinator passes it at spawn); it is never printed, never written.
import https from 'node:https';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const { key, cert } = JSON.parse(readFileSync(new URL('./dev-gateway-certs.json', import.meta.url), 'utf8'));
const UPSTREAM = process.env.DEV_GATEWAY_UPSTREAM ?? 'https://api.deepseek.com/chat/completions'; // tests override to a local stub
let posts = 0;

const server = https.createServer({ key, cert }, (req, res) => {
  if (req.method === 'GET' && req.url.replace(/\/+$/, '') === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, posts }));
    return;
  }
  if (req.method !== 'POST' || !req.url.replace(/\/+$/, '').endsWith('/chat/completions')) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
    return;
  }
  // Cap invariant (audit #7): at most ONE upstream POST per gateway process. The sole slot is
  // claimed SYNCHRONOUSLY at gate passage — before the body is read — so two half-written bodies
  // can never both pass the gate. A claimed request that disconnects BEFORE the upstream POST is
  // issued releases the slot (the cap counts upstream calls, not connection attempts); once the
  // upstream POST is sent, the slot is spent forever.
  if (posts >= 1) { // single-call red line, belt #2
    req.resume(); // drain the refused body so a still-writing client can finish and read the 429
    res.writeHead(429, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'single-call cap exceeded' }));
    console.log('CAP: second POST refused 429');
    return;
  }
  posts += 1; // claim the sole slot SYNCHRONOUSLY at gate passage, BEFORE reading the body —
              // the await-free gate must not leave a TOCTOU window during body reads (audit #7)
  let upstreamIssued = false; // once the upstream POST is sent, the slot is spent permanently
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('error', () => {}); // aborted reads surface here; the 'close' handler below releases
  req.on('close', () => {
    if (upstreamIssued || req.complete) return; // slot spent, or normal close after body 'end'
    posts = 0; // client disconnected mid-body before the upstream call — release the claimed slot
    console.log('ABORT: client disconnected mid-body, slot released');
  });
  req.on('end', async () => {
    upstreamIssued = true; // the upstream POST is being sent NOW — the slot is spent forever
    const started = Date.now();
    try {
      const upstream = await fetch(UPSTREAM, {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`, 'content-type': 'application/json' },
        body: Buffer.concat(chunks), signal: AbortSignal.timeout(30000),
      });
      const body = await upstream.text();
      res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json' });
      res.end(body);
      console.log(`POST -> upstream ${upstream.status} in ${Date.now() - started}ms (posts=${posts})`);
    } catch (error) {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'upstream fetch failed' }));
      console.log(`POST -> upstream FAILED in ${Date.now() - started}ms: ${error?.cause?.code ?? error?.name}`);
    }
  });
});

server.listen(0, '127.0.0.1', () => {
  console.log(`PORT ${server.address().port}`); // machine-readable: coordinator reads this
});
