// Model-review readiness verification (keyless). Usage: node scripts/verify-model-review.mjs
//
// Exit codes: 0 = all five sections verified; 1 = failure in any section; 2 = BLOCKED —
// this machine cannot open a node:http loopback listener, so the smoke sections cannot run
// (should not occur: node:http is a builtin and 127.0.0.1 needs no privileges).
//
// PAID-CALL ACCOUNTING (by construction, not by luck): every network byte this script moves
// goes to a 127.0.0.1 server it started itself; no key, no config and no switch are needed;
// sections 1-3 make ZERO calls at all (asserted by counting fetch invocations). The one
// "real" fetch in section 4 targets the loopback echo server only. A real paid gateway call
// at RUNTIME stays gated on unlock-⑨: the user places the gateway config file BY HAND
// (https baseUrl of a custom gateway, never an official endpoint), sets GSTACK861_MODEL_CALL=1
// and exports the key under the env var named by apiKeyEnv — none of which this script does.
//
// Sections:
//   [1/5] gateway config validation: positive (temp https config outside a temp workspace)
//         plus every malformed shape refused with its specific code.
//   [2/5] official-endpoint blocklist: exact hosts and subdomains refused.
//   [3/5] dry refusal: switch off -> MODEL_CALL_NOT_ENABLED; switch on, key missing ->
//         GATEWAY_KEY_MISSING; both with ZERO fetch invocations.
//   [4/5] LOCAL ECHO SMOKE: node:http server on 127.0.0.1 captures the one request and
//         asserts method/url, the Authorization: Bearer header equal to the fake key planted
//         under the apiKeyEnv-named variable (via a loopback-http gateway config), and the
//         body shape (model / messages[system,user] / max_tokens); it replies with a fixed
//         valid completion and the runModelReview verdict must come back 'approve'.
//   [5/5] timeout path: a hanging loopback server plus an injected 150 ms timeoutMs must
//         refuse with GATEWAY_TIMEOUT quickly (no default-30s stall).
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadGateway } from '../src/gateway.mjs';
import { runModelReview } from '../src/model-review.mjs';

const FAKE_KEY = 'verify-echo-fake-key-not-a-real-credential-5e9b';
const ECHO_KEY_ENV = 'GSTACK861_VERIFY_ECHO_KEY';
const VALID = { schemaVersion: 1, baseUrl: 'https://custom-gw.example.test/v1', apiKeyEnv: 'GSTACK861_VERIFY_KEY', model: 'verify-model', maxTokens: 256 };
const TIMEOUT_MS = 150;

async function attempt(fn) {
  try { return { ok: true, value: await fn() }; }
  catch (error) { return { ok: false, error }; }
}

function listen(handler) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function shut(server) {
  return new Promise(resolve => {
    server.closeAllConnections(); // release keep-alive sockets so close() settles now
    server.close(() => resolve());
  });
}

async function main() {
  let failed = 0;
  const check = (ok, label) => {
    console.log(`      ${ok ? 'ok' : 'FAILED'} — ${label}`);
    if (!ok) failed++;
  };

  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'g861-model-review-'));
  const workspace = path.join(base, 'workspace');
  fs.mkdirSync(workspace);
  const write = (config, dir = base, name = 'gateway.json') => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, typeof config === 'string' ? config : JSON.stringify(config), { mode: 0o600 });
    return file;
  };
  let echo, hanging;
  try {
    console.log('verify-model-review: keyless readiness check — five sections, 0 paid calls by construction (see header).');

    console.log('[1/5] gateway config validation (positive + every bad shape)…');
    const loaded = await attempt(() => loadGateway(write(VALID), { workspace }));
    check(loaded.ok && JSON.stringify(loaded.value) === JSON.stringify({ schemaVersion: 1, ...VALID })
      && Object.isFrozen(loaded.value), 'valid temp https config loads to the frozen normalized shape');
    const negatives = [
      ['schemaVersion 2', { ...VALID, schemaVersion: 2 }, /INVALID_GATEWAY/],
      ['empty baseUrl', { ...VALID, baseUrl: '' }, /INVALID_GATEWAY/],
      ['lowercase apiKeyEnv', { ...VALID, apiKeyEnv: 'lowercase_name' }, /INVALID_GATEWAY/],
      ['maxTokens 0', { ...VALID, maxTokens: 0 }, /INVALID_GATEWAY/],
      ['maxTokens 8193', { ...VALID, maxTokens: 8193 }, /INVALID_GATEWAY/],
      ['unknown extra key', { ...VALID, extra: true }, /INVALID_GATEWAY/],
      ['broken JSON', '{ not json', /INVALID_GATEWAY/],
      ['http to a non-loopback host', { ...VALID, baseUrl: 'http://gw.example.test/v1' }, /UNSAFE_BASEURL/],
      ['not a URL', { ...VALID, baseUrl: 'not-a-url' }, /UNSAFE_BASEURL/],
      ['relative filename', undefined, /ABSOLUTE_PATH_REQUIRED/],
      ['config inside the workspace', 'in-workspace', /GATEWAY_MUST_BE_OUTSIDE_WORKSPACE/],
      ['oversized file', 'oversize', /UNSAFE_GATEWAY_FILE/],
    ];
    for (const [label, config, code] of negatives) {
      const file = config === undefined ? 'gateway.json'
        : config === 'in-workspace' ? write(VALID, workspace, 'in-workspace.json')
        : config === 'oversize' ? write(`{"pad":"${'x'.repeat(17 * 1024)}"}`, base, 'oversize.json')
        : write(config, base, `neg-${label.replace(/\W+/g, '-')}.json`);
      const result = await attempt(() => loadGateway(file === 'gateway.json' ? 'gateway.json' : file, { workspace }));
      check(!result.ok && code.test(result.error.message), `${label} refused (${result.ok ? 'loaded!' : result.error.message.split(' ')[0]})`);
    }

    console.log('[2/5] official-endpoint blocklist (exact + subdomain)…');
    for (const baseUrl of ['https://api.openai.com/v1', 'https://oai.api.openai.com/v1', 'https://api.deepseek.com',
      'https://generativelanguage.googleapis.com/v1beta', 'https://API.OPENAI.COM/v1', 'https://api.openai.com./v1']) {
      const result = await attempt(() => loadGateway(write({ ...VALID, baseUrl }, base, 'blocklist.json'), { workspace }));
      check(!result.ok && /OFFICIAL_ENDPOINT_FORBIDDEN/.test(result.error.message), `${baseUrl} refused`);
    }

    console.log('[3/5] dry refusal: switch off / key missing, zero network…');
    let calls = 0;
    const countingFetch = () => { calls++; throw new Error('fetch must not be called'); };
    const dryGateway = { baseUrl: 'https://custom-gw.example.test/v1', apiKeyEnv: ECHO_KEY_ENV, model: 'verify-model', maxTokens: 256 };
    const dryTarget = { files: [{ path: 'src/example.mjs', diff: '+one line' }] };
    const dry = await attempt(() => runModelReview({ gateway: dryGateway, target: dryTarget, fetchImpl: countingFetch, env: {} }));
    check(!dry.ok && /MODEL_CALL_NOT_ENABLED/.test(dry.error.message), `switch off -> MODEL_CALL_NOT_ENABLED (got ${dry.ok ? 'success!' : dry.error.message})`);
    const keyless = await attempt(() => runModelReview({ gateway: dryGateway, target: dryTarget, fetchImpl: countingFetch, env: { GSTACK861_MODEL_CALL: '1' } }));
    check(!keyless.ok && /GATEWAY_KEY_MISSING/.test(keyless.error.message), `switch on, key missing -> GATEWAY_KEY_MISSING (got ${keyless.ok ? 'success!' : keyless.error.message})`);
    check(calls === 0, `exactly zero fetch invocations across both refusals (counted ${calls})`);

    console.log('[4/5] LOCAL ECHO SMOKE: one loopback POST, request shape asserted…');
    let captured;
    let requests = 0;
    const COMPLETION = JSON.stringify({
      choices: [{ message: { role: 'assistant', content: JSON.stringify({ verdict: 'approve', findings: ['echo smoke: request shape is correct'] }) } }],
      usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
    });
    try {
      echo = await listen((req, res) => {
        requests++;
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => {
          captured = { method: req.method, url: req.url, authorization: req.headers.authorization, body: Buffer.concat(chunks).toString('utf8') };
          res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(COMPLETION) });
          res.end(COMPLETION);
        });
      });
    } catch (error) {
      console.log(`RESULT: BLOCKED — node:http 回环监听不可用（${error.message}），第 4/5 段无法运行；本机不应出现此情况。`);
      console.log('exit 2（blocked；0=通过 / 1=失败 / 2=受阻）');
      process.exitCode = 2;
      return;
    }
    const echoGateway = loadGateway(
      write({ ...VALID, baseUrl: `http://127.0.0.1:${echo.port}/v1`, apiKeyEnv: ECHO_KEY_ENV }, base, 'echo-gateway.json'),
      { workspace },
    );
    const reviewed = await attempt(() => runModelReview({
      gateway: echoGateway,
      target: { files: [{ path: 'src/example.mjs', diff: '+hello from the echo smoke' }] },
      env: { GSTACK861_MODEL_CALL: '1', [ECHO_KEY_ENV]: FAKE_KEY },
      timeoutMs: 5000,
    }));
    check(reviewed.ok, `runModelReview resolves against the loopback echo gateway (${reviewed.ok ? '' : reviewed.error.message})`);
    check(requests === 1, `exactly one HTTP request hit the server (got ${requests})`);
    const body = captured ? JSON.parse(captured.body) : {};
    check(captured?.method === 'POST' && captured?.url === '/v1/chat/completions', `POST ${echoGateway.baseUrl}/chat/completions (got ${captured?.method} ${captured?.url})`);
    check(captured?.authorization === `Bearer ${FAKE_KEY}`, `Authorization equals the apiKeyEnv-planted fake key`);
    check(body.model === echoGateway.model, `body.model === config model (${body.model})`);
    check(body.max_tokens === echoGateway.maxTokens, `body.max_tokens === config maxTokens (${body.max_tokens})`);
    check(Array.isArray(body.messages) && body.messages.length === 2
      && body.messages[0].role === 'system' && body.messages[1].role === 'user'
      && body.messages[1].content.includes('src/example.mjs')
      && body.messages[1].content.includes('+hello from the echo smoke'),
    'body.messages = [system, user(path+diff)]');
    check(reviewed.ok && reviewed.value.verdict === 'approve'
      && reviewed.value.findings.length === 1
      && reviewed.value.usage?.total_tokens === 18
      && Object.isFrozen(reviewed.value),
    `verdict parsed back: approve, usage echoed (${JSON.stringify(reviewed.value?.usage)})`);

    console.log('[5/5] timeout path: hanging loopback server + injected 150 ms timeout…');
    hanging = await listen(() => { /* accept, never respond */ });
    const t0 = Date.now();
    const timed = await attempt(() => runModelReview({
      gateway: { baseUrl: `http://127.0.0.1:${hanging.port}/v1`, apiKeyEnv: ECHO_KEY_ENV, model: 'verify-model', maxTokens: 256 },
      target: { files: [{ path: 'src/example.mjs', diff: '+never answered' }] },
      env: { GSTACK861_MODEL_CALL: '1', [ECHO_KEY_ENV]: FAKE_KEY },
      timeoutMs: TIMEOUT_MS,
    }));
    const elapsed = Date.now() - t0;
    check(!timed.ok && /GATEWAY_TIMEOUT/.test(timed.error.message), `hanging server -> GATEWAY_TIMEOUT (got ${timed.ok ? 'success!' : timed.error.message})`);
    check(elapsed < 5000, `refused fast: ${elapsed} ms elapsed (timeoutMs ${TIMEOUT_MS} ms, default 30000 never hit)`);

    if (failed) {
      console.log(`RESULT: FAILURE — ${failed} check(s) failed（0=通过 / 1=失败 / 2=受阻）`);
      process.exitCode = 1;
    } else {
      console.log('RESULT: 全部五段通过 — 0 次付费调用（仅 127.0.0.1 回环；真网关运行时待解锁-⑨：用户手放配置 + GSTACK861_MODEL_CALL=1 + apiKeyEnv 所指键）。');
      console.log('exit 0');
    }
  } finally {
    if (echo) await shut(echo.server);
    if (hanging) await shut(hanging.server);
    fs.rmSync(base, { recursive: true, force: true });
    console.log(`cleanup: removed ${base}; loopback servers closed.`);
  }
}

const invoked = process.argv[1] && fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(fileURLToPath(import.meta.url));
if (invoked) await main();
