// Model-review verification. Two modes:
//   node scripts/verify-model-review.mjs                                — keyless five-segment readiness (default)
//   node scripts/verify-model-review.mjs --gateway-config <abs>         — REAL single model-review call (unlock-⑨ entry)
//   node scripts/verify-model-review.mjs --gateway-config <abs> --self-test-loopback <port>
//                                                                       — TEST-ONLY offline variant of the real-call mode
//
// Exit codes (readiness mode): 0 = all five sections verified; 1 = failure in any section;
// 2 = BLOCKED — this machine cannot open a node:http loopback listener, so the smoke sections
// cannot run (should not occur: node:http is a builtin and 127.0.0.1 needs no privileges).
//
// PAID-CALL ACCOUNTING (by construction, not by luck): in the readiness mode every network
// byte this script moves goes to a 127.0.0.1 server it started itself; no key, no config and
// no switch are needed; sections 1-3 make ZERO calls at all (asserted by counting fetch
// invocations). The one "real" fetch in section 4 targets the loopback echo server only.
//
// REAL-CALL MODE (--gateway-config <abs>) — the unlock-⑨ entry point: the user places the
// gateway config BY HAND (https baseUrl of a custom gateway; official endpoints are
// blocklisted by loadGateway itself), exports the key under the env var the config NAMES,
// sets GSTACK861_MODEL_CALL=1 and runs this script with the config path. It loads the file
// through the REAL loadGateway() (full schema + file-safety + blocklist enforcement), then
// performs exactly ONE runModelReview call against a fixed minimal review target. HARD RED
// LINES, all pinned by test/verify-model-review-run.test.mjs: no GSTACK861_MODEL_CALL=1 ->
// exit 2 with zero network; key missing from the apiKeyEnv-named env var -> exit 2 with zero
// network; the key value travels ONLY from process.env into the request header (never
// printed, never written); single-call cap (one request per run, asserted in self-test);
// output shows the config path and the baseUrl HOST only — never the key, the model or
// maxTokens. Exit codes (real-call mode): 0 = the one call completed and the verdict parsed;
// 1 = loadGateway refused the config, or the call failed with a structured code; 2 = BLOCKED
// (paid-call switch off, or key missing).
//
// --self-test-loopback <port> (TEST-ONLY, never for production): a companion of
// --gateway-config that still loads the user's real config through loadGateway and still
// demands GSTACK861_MODEL_CALL=1 + the key, but AFTER validation overrides baseUrl to
// http://127.0.0.1:<port>/v1 and points the single call at the script's loopback echo server
// (started on that port, or reused when a listener — the offline test harness — is already
// there; when this script owns the server it asserts the request count itself). This is how
// the real-call mode stays verifiable fully offline; production runs use --gateway-config
// alone against the user's real gateway.
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

function listen(handler, port = 0) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve({ server, port: server.address().port }));
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

// ---- real-call mode (--gateway-config): the unlock-⑨ entry point -------------------------
//
// Precedence: config refusal (exit 1) > red-line block (exit 2) > single-call outcome (0/1).
// Both block paths return BEFORE any listener is opened or fetch armed, so "zero network"
// is by construction, not by timing. loadGateway is pure filesystem — loading the config
// moves no network bytes even though it runs first.

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag !== '--gateway-config' && flag !== '--self-test-loopback') continue; // unknown args stay ignored (pre-existing tolerance)
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`INVALID_ARGUMENTS (${flag} requires a value)`);
    options[flag] = value;
    i++;
  }
  if (options['--self-test-loopback'] !== undefined && options['--gateway-config'] === undefined) {
    throw new Error('INVALID_ARGUMENTS (--self-test-loopback is a TEST-ONLY companion of --gateway-config)');
  }
  return options;
}

async function realCall(configFile, selfTestPort) {
  const failure = (message) => {
    console.log(`RESULT: FAILURE — ${message}（0=通过 / 1=失败 / 2=受阻）`);
    process.exitCode = 1;
  };
  const blocked = (message) => {
    console.log(`RESULT: BLOCKED — ${message}；未发生任何网络请求。`);
    console.log('exit 2（blocked；0=通过 / 1=失败 / 2=受阻）');
    process.exitCode = 2;
  };

  console.log('verify-model-review real-call mode: single capped call through the user gateway config (red lines in the header).');

  // [1/3] The REAL loader: full schema + file safety + official-host blocklist, on the user's actual file.
  let gateway;
  try {
    gateway = loadGateway(configFile, { workspace: process.cwd() });
  } catch (error) {
    return failure(`loadGateway refused the config — ${error.message}；zero requests.`);
  }
  const configured = new URL(gateway.baseUrl); // loadGateway already proved this parses and is a custom https host
  console.log(`[1/3] gateway config loaded: ${configFile} -> ${configured.protocol}//${configured.host}（打印路径与主机；键值与其余配置值绝不打印）`);

  // [2/3] Red lines, checked before ANY network move. The key value is only TOUCHED here for a
  // presence check; the sole holder of the value is runModelReview's request-header assembly.
  if (process.env.GSTACK861_MODEL_CALL !== '1') {
    return blocked('GSTACK861_MODEL_CALL=1 未设置 — 付费调用开关关闭');
  }
  if (typeof process.env[gateway.apiKeyEnv] !== 'string' || process.env[gateway.apiKeyEnv] === '') {
    return blocked(`apiKeyEnv 所指环境变量（${gateway.apiKeyEnv}）中无键 — 名称来自配置文件，键值永不在此出现`);
  }
  console.log('[2/3] red-line checks passed: GSTACK861_MODEL_CALL=1；apiKeyEnv 所指键存在（值永不打印/落盘）；官方主机黑名单由 loadGateway 强制；单次调用封顶。');

  // TEST-ONLY loopback override: applied AFTER loadGateway validated the real file above, so
  // schema + blocklist still ran against the user's actual config. The frozen loadGateway
  // shape is never mutated — the override is a fresh object for the single call.
  let effective = gateway;
  let owned = null; // { server, requests } when this script started the echo server itself
  try {
    if (selfTestPort !== undefined) {
      const port = Number(selfTestPort);
      if (!Number.isInteger(port) || port < 0 || port > 65535) {
        return failure(`INVALID_ARGUMENTS (--self-test-loopback 需要一个 TCP 端口，得到 '${selfTestPort}')`);
      }
      const COMPLETION = JSON.stringify({
        choices: [{ message: { role: 'assistant', content: JSON.stringify({ verdict: 'approve', findings: ['loopback self-test: the single call reached the echo server and its verdict parsed back'] }) } }],
        usage: { prompt_tokens: 13, completion_tokens: 11, total_tokens: 24 },
      });
      const requests = { count: 0 };
      const handler = (req, res) => {
        requests.count++;
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => {
          res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(COMPLETION) });
          res.end(COMPLETION);
        });
      };
      let bound;
      try {
        bound = await listen(handler, port);
        owned = { server: bound.server, requests };
      } catch (error) {
        if (error?.code !== 'EADDRINUSE') {
          console.log(`RESULT: BLOCKED — node:http 回环监听不可用（${error.message}），self-test 无法运行；未发生模型调用。`);
          console.log('exit 2（blocked；0=通过 / 1=失败 / 2=受阻）');
          process.exitCode = 2;
          return;
        }
        // A listener is already on the port (the offline test harness owns it) — reuse it.
      }
      const loopback = `http://127.0.0.1:${bound ? bound.port : port}/v1`;
      effective = { ...gateway, baseUrl: loopback };
      console.log(`      self-test（TEST-ONLY）: baseUrl 覆写为 ${loopback}（${bound ? '回显服务由本脚本启动' : '复用端口上已存在的监听者（外部测试装置）'}）；上方真实配置已通过完整校验。`);
    }

    // [3/3] The single call. The fixed minimal target keeps the paid call capped and makes this
    // run a pipeline proof (config -> key -> gateway -> verdict), not a repository review.
    const reviewed = await attempt(() => runModelReview({
      gateway: effective,
      target: { files: [{ path: 'scripts/verify-model-review.mjs', diff: '+ real-call entry point: one capped model-review call per run; key supplied via the apiKeyEnv-named env var only' }] },
      env: process.env,
      timeoutMs: selfTestPort !== undefined ? 5000 : 30000,
    }));
    if (!reviewed.ok) {
      const code = reviewed.error.message.split(' ')[0];
      if (code === 'MODEL_CALL_NOT_ENABLED' || code === 'GATEWAY_KEY_MISSING') {
        return blocked(`迟到的红线拒绝 ${code}（纵深防御；[2/3] 预检本应先行拦截）`);
      }
      return failure(`单次调用被拒绝 — ${reviewed.error.message}`);
    }
    if (owned && owned.requests.count !== 1) {
      return failure(`单次调用封顶被违反：回环服务器看到 ${owned.requests.count} 个请求（必须恰为 1）`);
    }
    console.log(`[3/3] single call completed — verdict '${reviewed.value.verdict}'，${reviewed.value.findings.length} 条 finding，usage ${JSON.stringify(reviewed.value.usage)}${owned ? `；回环回显服务器恰见 ${owned.requests.count} 个请求` : '；请求计数由拥有监听者的外部装置断言'}。`);
    for (const [index, finding] of reviewed.value.findings.entries()) console.log(`      finding ${index + 1}: ${finding}`);
    console.log('RESULT: 真调用验证通过 — 恰一次封顶调用完成，红线（开关/键/黑名单/单次）全部保持。');
    console.log('exit 0');
  } finally {
    if (owned) await shut(owned.server); // a reused listener belongs to the external harness, never closed here
  }
}

const invoked = process.argv[1] && fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(fileURLToPath(import.meta.url));
if (invoked) {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.log(`RESULT: FAILURE — ${error.message}（0=通过 / 1=失败 / 2=受阻）`);
    process.exitCode = 1;
  }
  if (options) {
    if (options['--gateway-config'] === undefined) await main(); // no config: five-segment readiness, exactly as before
    else await realCall(options['--gateway-config'], options['--self-test-loopback']);
  }
}
