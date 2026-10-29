import { freeze, object } from './json.mjs';
import { compileGateway, resolveKey } from './gateway.mjs';

// Boundary (9) executor half: ONE capped, explicitly-authorized model call per review.
// Revalidate even inline gateway objects at this public execution boundary; loadGateway()
// additionally verifies a user-owned configuration file outside the workspace; the API key is resolved here for
// one-time use and must never appear in any thrown error. Paid calls stay off unless the
// environment switch GSTACK861_MODEL_CALL === '1': every precondition is checked BEFORE the
// single fetch so refusals are provably zero-call.

const SWITCH = 'GSTACK861_MODEL_CALL';
const MAX_INPUT_BYTES = 64 * 1024; // assembled system+user prompt cap
const MAX_OUTPUT_BYTES = 1024 * 1024; // a malicious gateway need not obey max_tokens
const VERDICTS = new Set(['approve', 'request_changes']);
const SYSTEM_TEMPLATE = [
  'You are the independent model reviewer for a repository change.',
  'Review the file diffs provided and reply with ONLY a JSON object of the exact shape',
  '{"verdict":"approve"|"request_changes","findings":[...]}, where findings is an array of',
  'concise non-empty strings (empty for a clean approve). No prose, no markdown fences.',
].join(' ');

function fail(code, detail = '') {
  return new Error(detail ? `${code} ${detail}` : code);
}

// Audit #6: the gateway sits on the network path and can echo our own Authorization
// value back inside an HTTP 200 body; any raw response bytes attached to an error pass
// through here — the literal key first, then the common secret shapes — BEFORE the
// 1 KiB truncation, so a diagnostic tail can never carry a live secret.
const SECRET_SHAPES = [
  [/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [REDACTED]'],
  [/\bsk-[A-Za-z0-9_-]{8,}\b/g, 'sk-[REDACTED]'],
  [/(authorization|api[-_]?key|x-api-key)(\s*["':=]\s*)[^\s"',;]{4,}/gi, '$1$2[REDACTED]'],
];

function redact(text, key) {
  // Round 3 (audit #6): resolveKey accepts ANY non-empty key, so the literal redaction
  // must too — a 7-character key leaks exactly like a 41-character one.
  let out = text;
  if (typeof key === 'string' && key.length >= 1) out = out.split(key).join('[REDACTED]');
  for (const [shape, replacement] of SECRET_SHAPES) out = out.replace(shape, replacement);
  return out;
}

/** Sanitize every gateway-controlled returned string, including JSON object keys.
 * Bound recursion separately from the byte cap so deeply nested usage cannot overflow. */
function redactValue(value, key, depth = 0) {
  if (depth > 64) throw fail('REVIEW_OUTPUT_TOO_DEEP');
  if (typeof value === 'string') return redact(value, key);
  if (Array.isArray(value)) return value.map(v => redactValue(v, key, depth + 1));
  if (object(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [redact(k, key), redactValue(v, key, depth + 1)]));
  return value;
}

/** Stop reading as soon as the decoded response exceeds the memory budget.
 * The text-only fallback preserves the existing injectable fetch test contract. */
async function boundedText(response) {
  if (!response.body?.getReader) {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > MAX_OUTPUT_BYTES) throw fail('REVIEW_OUTPUT_TOO_LARGE');
    return text;
  }
  const reader = response.body.getReader(), chunks = [];
  let size = 0, complete = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) { complete = true; break; }
      size += value.byteLength;
      if (size > MAX_OUTPUT_BYTES) throw fail('REVIEW_OUTPUT_TOO_LARGE');
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, size).toString('utf8');
  } finally {
    if (!complete) { try { await reader.cancel(); } catch { /* preserve the original refusal */ } }
    reader.releaseLock();
  }
}

/** Deterministic endpoint join (audit #10): rebuild through a URL object so a stray
 *  trailing slash can never double-slash the path and query/fragment never survive. */
function joinUrl(baseUrl, pathname) {
  const url = new URL(baseUrl);
  url.pathname = url.pathname.replace(/\/+$/, '') + `/${pathname}`;
  url.search = '';
  url.hash = '';
  return url.href;
}

/** Validate the review target/prompt shape before anything is assembled. */
function checkedTarget(target, prompt) {
  if (prompt !== undefined && typeof prompt !== 'string') throw fail('REVIEW_INPUT_INVALID', '(prompt must be a string)');
  if (!target || typeof target !== 'object' || !Array.isArray(target.files) || target.files.length === 0) {
    throw fail('REVIEW_INPUT_INVALID', '(target.files must be a non-empty array)');
  }
  for (const file of target.files) {
    if (!file || typeof file !== 'object' || typeof file.path !== 'string' || !file.path
      || typeof file.diff !== 'string') {
      throw fail('REVIEW_INPUT_INVALID', '(each file needs string path and diff)');
    }
  }
  return target.files;
}

/** Extract { verdict, findings } from the completion content; tolerate fences and prose. */
function extractVerdict(content, sanitize = value => value) {
  const unparseable = () => fail('REVIEW_OUTPUT_UNPARSEABLE', `(first 1KiB of raw content) ${sanitize(content).slice(0, 1024)}`);
  let parsed;
  try { parsed = JSON.parse(content); }
  catch {
    const start = content.indexOf('{');
    const end = content.lastIndexOf('}');
    if (start === -1 || end <= start) throw unparseable();
    try { parsed = JSON.parse(content.slice(start, end + 1)); }
    catch { throw unparseable(); }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw unparseable();
  const { verdict, findings } = parsed;
  if (!VERDICTS.has(verdict)) throw unparseable();
  if (!Array.isArray(findings) || findings.some(finding => typeof finding !== 'string')) throw unparseable();
  return { verdict, findings };
}

/**
 * Run one independent model review through the user-configured OpenAI-compatible gateway.
 * Exactly one POST ${baseUrl}/chat/completions per call; redirects are refused
 * (redirect: 'error'), the request is armed with AbortSignal.timeout(timeoutMs), and every
 * refusal path (switch off, key missing, input too large, network/HTTP failure, unparseable
 * output) throws a structured code instead of degrading. Resolves to a frozen
 * { verdict, findings, usage } (usage is the gateway-reported token usage or null).
 */
export async function runModelReview({ gateway, target, prompt, fetchImpl = fetch, timeoutMs = 30000, env = process.env }) {
  // 1. Paid-call switch: anything but the exact string '1' refuses before any network move.
  if (env[SWITCH] !== '1') throw fail('MODEL_CALL_NOT_ENABLED');
  // Inline callers historically omitted schemaVersion; retain that shorthand, not unchecked fields.
  if (!object(gateway)) throw fail('INVALID_GATEWAY');
  gateway = compileGateway({ schemaVersion: 1, ...gateway });
  // 2. Key: resolved from the env var the gateway NAMES (never stored); missing -> refuse.
  const key = resolveKey(gateway, env);
  // 3. Prompt assembly + size cap: the fixed review template plus each file's path and diff.
  const files = checkedTarget(target, prompt);
  const user = [
    ...(prompt ? [prompt, ''] : []),
    ...files.map(file => `--- ${file.path} ---\n${file.diff}`),
  ].join('\n');
  if (Buffer.byteLength(SYSTEM_TEMPLATE + user, 'utf8') > MAX_INPUT_BYTES) throw fail('REVIEW_INPUT_TOO_LARGE');
  // 4. The single capped call.
  let response;
  try {
    response = await fetchImpl(joinUrl(gateway.baseUrl, 'chat/completions'), {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: gateway.model,
        messages: [
          { role: 'system', content: SYSTEM_TEMPLATE },
          { role: 'user', content: user },
        ],
        max_tokens: gateway.maxTokens,
      }),
      redirect: 'error', // a redirect could bypass the blocklist and double the call
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (error?.name === 'AbortError' || error?.name === 'TimeoutError' || error?.cause?.name === 'TimeoutError') {
      throw fail('GATEWAY_TIMEOUT');
    }
    // ECONNREFUSED, DNS and refused redirects all land here as a structured refusal.
    const why = error?.cause?.code ?? error?.code ?? error?.name ?? 'network error';
    throw fail('GATEWAY_ERROR', `(network: ${redact(String(why), key).slice(0, 128)})`);
  }
  if (response.status >= 300 && response.status < 400) throw fail('GATEWAY_ERROR', `(redirect refused; status ${response.status})`);
  if (!response.ok) throw fail('GATEWAY_ERROR', `(status ${response.status})`); // never echo the body
  // 5. Parse: choices[0].message.content -> { verdict, findings }.
  let text;
  try { text = await boundedText(response); }
  catch (error) {
    if (error?.message === 'REVIEW_OUTPUT_TOO_LARGE') throw fail('REVIEW_OUTPUT_TOO_LARGE');
    // Mid-body abort/reset gets the same structured codes as the fetch phase.
    if (error?.name === 'AbortError' || error?.name === 'TimeoutError' || error?.cause?.name === 'TimeoutError') throw fail('GATEWAY_TIMEOUT');
    throw fail('GATEWAY_ERROR', `(body read: ${redact(String(error?.cause?.code ?? error?.name ?? 'failed'), key).slice(0, 128)})`);
  }
  let payload;
  try { payload = JSON.parse(text); }
  catch { throw fail('REVIEW_OUTPUT_UNPARSEABLE', `(first 1KiB of raw body) ${redact(text, key).slice(0, 1024)}`); }
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') {
    throw fail('REVIEW_OUTPUT_UNPARSEABLE', `(first 1KiB of raw body) ${redact(text, key).slice(0, 1024)}`);
  }
  const { verdict, findings } = extractVerdict(content, value => redact(value, key));
  // 6. Frozen structured verdict.
  return freeze({ verdict, findings: findings.map(value => redact(value, key)), usage: redactValue(payload.usage ?? null, key) });
}
