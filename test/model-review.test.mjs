import test from 'node:test';
import assert from 'node:assert/strict';
import { runModelReview } from '../src/model-review.mjs';

// Offline unit battery: every network interaction goes through an injected fake fetchImpl
// that counts calls, so "zero calls" assertions are exact. The gateway is an inline stub in
// the exported loadGateway shape; the real key resolution runs through resolveKey (imported
// by the module under test), exercising the shipped key-missing code path.

const KEY = 'model-review-test-key-never-leak-3d1f0c';
const KEY_ENV = 'GSTACK861_TEST_MODEL_REVIEW_KEY';
const GATEWAY = { baseUrl: 'https://custom-gw.example.test/v1', apiKeyEnv: KEY_ENV, model: 'stub-model', maxTokens: 512 };
const ENV_ON = { GSTACK861_MODEL_CALL: '1', [KEY_ENV]: KEY };
const TARGET = { files: [{ path: 'src/example.mjs', diff: '-old\n+new line of code' }] };

function completion(content, usage) {
  return JSON.stringify({ choices: [{ message: { role: 'assistant', content } }], ...(usage ? { usage } : {}) });
}

const APPROVE = JSON.stringify({ verdict: 'approve', findings: ['looks fine'] });

/** A counting fetch fake: records every (url, init) and answers through `respond`. */
function recorder(respond) {
  const calls = [];
  const fetchImpl = (url, init) => {
    calls.push({ url, init });
    return respond(url, init, calls.length);
  };
  return { calls, fetchImpl };
}

function json(body) { return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }); }

/** A call whose every documented precondition holds; returns a promise to inspect. */
function review(overrides = {}) {
  const { respond = () => json(completion(APPROVE)), env = ENV_ON, ...rest } = overrides;
  const { calls, fetchImpl } = recorder(respond);
  const outcome = runModelReview({ gateway: GATEWAY, target: TARGET, fetchImpl, env, ...rest });
  return { outcome, calls };
}

async function refuses(overrides, pattern, label) {
  const { outcome, calls } = review(overrides);
  await assert.rejects(outcome, error => {
    assert.match(error.message, pattern, label);
    return true;
  }, label);
  assert.equal(calls.length, 0, `zero fetch calls: ${label}`);
  return calls;
}

test('model-call switch off refuses before any fetch with MODEL_CALL_NOT_ENABLED', async () => {
  await refuses({ env: {} }, /MODEL_CALL_NOT_ENABLED/, 'unset switch');
  await refuses({ env: { GSTACK861_MODEL_CALL: '0', [KEY_ENV]: KEY } }, /MODEL_CALL_NOT_ENABLED/, 'switch explicitly off');
  await refuses({ env: { GSTACK861_MODEL_CALL: 'true', [KEY_ENV]: KEY } }, /MODEL_CALL_NOT_ENABLED/, "only the exact string '1' unlocks");
});

test('missing or empty key refuses with GATEWAY_KEY_MISSING before any fetch', async () => {
  await refuses({ env: { GSTACK861_MODEL_CALL: '1' } }, /GATEWAY_KEY_MISSING/, 'key env unset');
  await refuses({ env: { GSTACK861_MODEL_CALL: '1', [KEY_ENV]: '' } }, /GATEWAY_KEY_MISSING/, 'key empty');
  await refuses({ env: { GSTACK861_MODEL_CALL: '1', SOME_OTHER_ENV: KEY } }, /GATEWAY_KEY_MISSING/, 'must read the env var the gateway names');
});

test('a malformed review target or prompt refuses with REVIEW_INPUT_INVALID, zero calls', async () => {
  for (const target of [undefined, {}, { files: [] }, { files: 'nope' }, { files: [{ path: 'a' }] }, { files: [{ diff: 'd' }] },
    { files: [{ path: 7, diff: 'd' }] }, { files: [{ path: 'a', diff: 7 }] }]) {
    await refuses({ target }, /REVIEW_INPUT_INVALID/, `target ${JSON.stringify(target)}`);
  }
  await refuses({ target: TARGET, prompt: 42 }, /REVIEW_INPUT_INVALID/, 'non-string prompt');
});

test('an assembled prompt over 64 KiB refuses with REVIEW_INPUT_TOO_LARGE, zero calls', async () => {
  await refuses({ target: { files: [{ path: 'big.diff', diff: 'x'.repeat(65 * 1024) }] } }, /REVIEW_INPUT_TOO_LARGE/, 'single huge diff');
  const many = { files: Array.from({ length: 200 }, (_, i) => ({ path: `f${i}`, diff: 'y'.repeat(400) })) };
  await refuses({ target: many }, /REVIEW_INPUT_TOO_LARGE/, 'many files past the cap');
  // Just under the cap is accepted and makes exactly one call.
  const { outcome, calls } = review({ target: { files: [{ path: 'ok.diff', diff: 'z'.repeat(60 * 1024) }] } });
  await outcome;
  assert.equal(calls.length, 1);
});

test('happy path: exactly one POST with the specified body shape, headers and redirect refusal', async () => {
  const usage = { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 };
  const { outcome, calls } = review({ respond: () => json(completion(JSON.stringify({ verdict: 'request_changes', findings: ['a', 'b'] }), usage)),
    target: TARGET, prompt: 'Focus on security.' });
  const result = await outcome;
  assert.equal(calls.length, 1, 'exactly one fetch call');
  const { url, init } = calls[0];
  assert.equal(url, `${GATEWAY.baseUrl}/chat/completions`);
  assert.equal(init.method, 'POST');
  assert.equal(init.redirect, 'error', 'redirects must be refused, not followed');
  assert.equal(init.headers.Authorization, `Bearer ${KEY}`);
  assert.equal(init.headers['content-type'], 'application/json');
  assert.ok(init.signal instanceof AbortSignal, 'an abort signal must arm the timeout');
  const body = JSON.parse(init.body);
  assert.deepEqual(Object.keys(body).sort(), ['max_tokens', 'messages', 'model']);
  assert.equal(body.model, GATEWAY.model);
  assert.equal(body.max_tokens, GATEWAY.maxTokens);
  assert.deepEqual(body.messages.map(m => m.role), ['system', 'user']);
  assert.ok(body.messages[0].content.length > 0, 'the system message carries the fixed review template');
  const user = body.messages[1].content;
  assert.ok(user.includes('Focus on security.'), 'an optional prompt augments the user message');
  assert.ok(user.includes('src/example.mjs') && user.includes('+new line of code'), 'each file path and diff are inlined');
  assert.deepEqual(result, { verdict: 'request_changes', findings: ['a', 'b'], usage });
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.findings), 'the result is frozen');
});

test('usage defaults to null when the gateway response omits it', async () => {
  const { outcome } = review({ respond: () => json(completion(APPROVE)) });
  assert.deepEqual(await outcome, { verdict: 'approve', findings: ['looks fine'], usage: null });
});

test('JSON fenced in markdown or wrapped in prose is still extracted', async () => {
  const fenced = '```json\n' + APPROVE + '\n```';
  const fencedRun = review({ respond: () => json(completion(fenced)) });
  assert.equal((await fencedRun.outcome).verdict, 'approve');
  const chattyRun = review({ respond: () => json(completion(`Sure! Here is my review:\n${APPROVE}\nHope that helps.`)) });
  assert.equal((await chattyRun.outcome).verdict, 'approve');
});

test('a 3xx response is GATEWAY_ERROR: redirects are refused, never followed', async () => {
  await assert.rejects(
    review({ respond: () => new Response('moved', { status: 302, headers: { location: 'https://evil.example.test/v1/chat/completions' } }) }).outcome,
    /GATEWAY_ERROR/,
  );
});

test('a non-2xx response is GATEWAY_ERROR with the status and without the response body', async () => {
  const { outcome } = review({ respond: () => new Response('{"error":{"message":"secret-diagnostic-body"}}', { status: 503, headers: { 'content-type': 'application/json' } }) });
  await assert.rejects(outcome, error => {
    assert.match(error.message, /GATEWAY_ERROR/);
    assert.ok(error.message.includes('503'), 'the status is included');
    assert.ok(!error.message.includes('secret-diagnostic-body'), 'the response body must not be echoed');
    return true;
  });
});

test('a non-timeout fetch rejection (ECONNREFUSED, DNS) maps to structured GATEWAY_ERROR', async () => {
  const network = error => review({ respond: () => { throw error; } }).outcome;
  const refused = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
  await assert.rejects(network(refused), /GATEWAY_ERROR/);
  const dns = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });
  await assert.rejects(network(dns), /GATEWAY_ERROR/);
  await assert.rejects(network(new TypeError('fetch failed')), /GATEWAY_ERROR/);
});

test('an abort rejection maps to GATEWAY_TIMEOUT, other abort shapes never mask the code', async () => {
  const { outcome } = review({ respond: () => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); } });
  await assert.rejects(outcome, /GATEWAY_TIMEOUT/);
  const { outcome: aborted } = review({ respond: () => { throw new DOMException('This operation was aborted', 'AbortError'); } });
  await assert.rejects(aborted, /GATEWAY_TIMEOUT/);
});

test('unparseable model output refuses with REVIEW_OUTPUT_UNPARSEABLE attaching the first 1 KiB', async () => {
  await assert.rejects(review({ respond: () => json(completion('i am not json at all')) }).outcome, error => {
    assert.match(error.message, /REVIEW_OUTPUT_UNPARSEABLE/);
    assert.ok(error.message.includes('i am not json at all'), 'the raw content snippet is attached');
    return true;
  });
  const long = 'g'.repeat(2048);
  await assert.rejects(review({ respond: () => json(completion(long)) }).outcome, error => {
    assert.match(error.message, /REVIEW_OUTPUT_UNPARSEABLE/);
    assert.ok(error.message.includes('g'.repeat(1024)), 'up to 1 KiB is attached');
    assert.ok(!error.message.includes('g'.repeat(1025)), 'never more than 1 KiB');
    return true;
  });
  // Structured-but-wrong bodies: JSON, yet not { verdict, findings: string[] }.
  for (const content of [
    JSON.stringify({ verdict: 'maybe', findings: [] }),
    JSON.stringify({ verdict: 'approve' }),
    JSON.stringify({ verdict: 'approve', findings: 'fine' }),
    JSON.stringify({ verdict: 'approve', findings: [1, 2] }),
    '"just a string"',
    'null',
  ]) {
    await assert.rejects(review({ respond: () => json(completion(content)) }).outcome, /REVIEW_OUTPUT_UNPARSEABLE/, content);
  }
  // A body with no choices[0].message.content at all is equally unparseable.
  await assert.rejects(review({ respond: () => json('{"object":"list","choices":[]}') }).outcome, /REVIEW_OUTPUT_UNPARSEABLE/);
  await assert.rejects(review({ respond: () => new Response('<html>gateway login page</html>', { status: 200, headers: { 'content-type': 'text/html' } }) }).outcome, /REVIEW_OUTPUT_UNPARSEABLE/);
});

test('no error thrown on any path ever contains the key value', async () => {
  const { outcome } = review({ respond: () => new Response('nope', { status: 500 }) });
  await assert.rejects(outcome, error => {
    assert.ok(!(error.message + error.stack).includes(KEY), 'errors must stay inert');
    return true;
  });
});

test('mid-body abort during response.text() maps to GATEWAY_TIMEOUT', async () => {
  // Headers arrive, the body stalls mid-stream; the abort signal errors the stream,
  // and response.text() must surface as a structured GATEWAY_TIMEOUT (not a raw DOMException).
  const fetchImpl = (url, init) => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"choices":'));
      init.signal.addEventListener('abort', () =>
        controller.error(new DOMException('The operation was aborted due to timeout', 'TimeoutError')));
    },
  }), { status: 200 });
  await assert.rejects(
    runModelReview({ gateway: GATEWAY, target: { files: [{ path: 'a', diff: '+a' }] }, fetchImpl, timeoutMs: 80, env: { GSTACK861_MODEL_CALL: '1', [KEY_ENV]: 'k' } }),
    /GATEWAY_TIMEOUT/,
  );
});
