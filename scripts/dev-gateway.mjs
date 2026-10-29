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
// The DEEPSEEK_API_KEY comes exclusively from this process's environment (the
// coordinator passes it at spawn); it is never printed, never written.
import https from 'node:https';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const { key, cert } = JSON.parse(readFileSync(new URL('./dev-gateway-certs.json', import.meta.url), 'utf8'));
const UPSTREAM = 'https://api.deepseek.com/chat/completions';
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
  if (posts >= 1) { // single-call red line, belt #2
    res.writeHead(429, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'single-call cap exceeded' }));
    console.log('CAP: second POST refused 429');
    return;
  }
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', async () => {
    const started = Date.now();
    try {
      const upstream = await fetch(UPSTREAM, {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`, 'content-type': 'application/json' },
        body: Buffer.concat(chunks),
      });
      posts += 1;
      const body = await upstream.text();
      res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json' });
      res.end(body);
      console.log(`POST -> upstream ${upstream.status} in ${Date.now() - started}ms (posts=${posts})`);
    } catch (error) {
      posts += 1;
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'upstream fetch failed' }));
      console.log(`POST -> upstream FAILED in ${Date.now() - started}ms: ${error?.cause?.code ?? error?.name}`);
    }
  });
});

server.listen(0, '127.0.0.1', () => {
  console.log(`PORT ${server.address().port}`); // machine-readable: coordinator reads this
});
