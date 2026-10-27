import { freeze } from './json.mjs';
import { resolveKey } from './gateway.mjs';

// Boundary (9) executor half: ONE capped, explicitly-authorized model call per review.
// The gateway object comes from loadGateway() (src/gateway.mjs), which already enforced the
// https/loopback rule and the official-endpoint blocklist; the API key is resolved here for
// one-time use and must never appear in any thrown error. Paid calls stay off unless the
// environment switch GSTACK861_MODEL_CALL === '1': every precondition is checked BEFORE the
// single fetch so refusals are provably zero-call.

const SWITCH = 'GSTACK861_MODEL_CALL';
const MAX_INPUT_BYTES = 64 * 1024; // assembled system+user prompt cap
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
function extractVerdict(content) {
  const unparseable = () => fail('REVIEW_OUTPUT_UNPARSEABLE', `(first 1KiB of raw content) ${content.slice(0, 1024)}`);
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
    response = await fetchImpl(`${gateway.baseUrl}/chat/completions`, {
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
    throw fail('GATEWAY_ERROR', `(network: ${why})`);
  }
  if (response.status >= 300 && response.status < 400) throw fail('GATEWAY_ERROR', `(redirect refused; status ${response.status})`);
  if (!response.ok) throw fail('GATEWAY_ERROR', `(status ${response.status})`); // never echo the body
  // 5. Parse: choices[0].message.content -> { verdict, findings }.
  let text;
  try { text = await response.text(); }
  catch (error) {
    // Mid-body abort/reset gets the same structured codes as the fetch phase.
    if (error?.name === 'AbortError' || error?.name === 'TimeoutError' || error?.cause?.name === 'TimeoutError') throw fail('GATEWAY_TIMEOUT');
    throw fail('GATEWAY_ERROR', `(body read: ${error?.cause?.code ?? error?.name ?? 'failed'})`);
  }
  let payload;
  try { payload = JSON.parse(text); }
  catch { throw fail('REVIEW_OUTPUT_UNPARSEABLE', `(first 1KiB of raw body) ${text.slice(0, 1024)}`); }
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') {
    throw fail('REVIEW_OUTPUT_UNPARSEABLE', `(first 1KiB of raw body) ${text.slice(0, 1024)}`);
  }
  const { verdict, findings } = extractVerdict(content);
  // 6. Frozen structured verdict.
  return freeze({ verdict, findings, usage: payload.usage ?? null });
}
