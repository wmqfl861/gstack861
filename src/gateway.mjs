import fs from 'node:fs';
import path from 'node:path';
import { inside } from './policy.mjs';
import { freeze, object } from './json.mjs';

// Boundary (9) mechanism half: the explicit model-gateway config. The user places this file
// BY HAND outside the model-editable workspace; it names (never contains) the environment
// variable holding the API key, and its baseUrl can only be a custom https gateway — the
// official model endpoints are blocklisted, so no paid fallback path exists by construction.
const GATEWAY_KEYS = ['schemaVersion', 'baseUrl', 'apiKeyEnv', 'model', 'maxTokens', 'note'];
const API_KEY_ENV = /^[A-Z_][A-Z0-9_]*$/;
// Plain http may only reach the loopback hosts the local echo smoke test needs.
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);
const BLOCKED_HOSTS = ['api.openai.com', 'api.deepseek.com', 'generativelanguage.googleapis.com'];

function absolute(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || /[\x00-\x1f]/.test(value)) throw new Error('ABSOLUTE_PATH_REQUIRED');
  return value;
}

function directory(value) {
  // native realpath: on Windows it expands 8.3 short names and canonicalizes case; on POSIX it is equivalent.
  const resolved = fs.realpathSync.native(absolute(value));
  if (!fs.statSync(resolved).isDirectory()) throw new Error('DIRECTORY_REQUIRED');
  return resolved;
}

/** Hostname in comparison form: WHATWG-lowercased, IPv6 brackets and the DNS-semantic trailing dot removed. */
function hostnameOf(url) {
  return url.hostname.toLowerCase().replace(/^\[(.+)\]$/, '$1').replace(/\.$/, '');
}

function compileGateway(raw) {
  if (!object(raw) || raw.schemaVersion !== 1) throw new Error('INVALID_GATEWAY');
  if (Object.keys(raw).some(k => !GATEWAY_KEYS.includes(k))) throw new Error('INVALID_GATEWAY');
  if (typeof raw.baseUrl !== 'string' || !raw.baseUrl) throw new Error('INVALID_GATEWAY');
  if (!API_KEY_ENV.test(raw.apiKeyEnv)) throw new Error('INVALID_GATEWAY');
  if (typeof raw.model !== 'string' || !raw.model || raw.model.length > 128) throw new Error('INVALID_GATEWAY');
  if (!Number.isInteger(raw.maxTokens) || raw.maxTokens < 1 || raw.maxTokens > 8192) throw new Error('INVALID_GATEWAY');
  if (Object.hasOwn(raw, 'note') && (typeof raw.note !== 'string' || raw.note.length > 256)) throw new Error('INVALID_GATEWAY');
  let url;
  try { url = new URL(raw.baseUrl); }
  catch { throw new Error('UNSAFE_BASEURL'); }
  // Audit #10: query, fragment and userinfo (username AND a password-only form) are
  // legal URL components but they misroute or silently mutate the executor's joined
  // request path — refuse them at load, and normalize trailing slashes away so joining
  // `${baseUrl}/chat/completions` is exact.
  if (url.search || url.hash || url.username || url.password) throw new Error('UNSAFE_BASEURL');
  const hostname = hostnameOf(url);
  if (!hostname || (url.protocol !== 'https:' && (url.protocol !== 'http:' || !LOOPBACK_HOSTS.has(hostname)))) throw new Error('UNSAFE_BASEURL');
  if (BLOCKED_HOSTS.some(blocked => hostname === blocked || hostname.endsWith('.' + blocked))) throw new Error('OFFICIAL_ENDPOINT_FORBIDDEN');
  const gateway = { schemaVersion: 1, baseUrl: `${url.origin}${url.pathname.replace(/\/+$/, '')}`, apiKeyEnv: raw.apiKeyEnv, model: raw.model, maxTokens: raw.maxTokens };
  if (Object.hasOwn(raw, 'note')) gateway.note = raw.note; // absent optionals stay out of the normalized shape
  return freeze(gateway);
}

/**
 * Load the user-placed gateway config. File checks mirror loadPolicy: absolute path, a
 * regular non-symlinked unlinked file under 16 KiB, and on POSIX an owner-only mode. The
 * file must live OUTSIDE the workspace it guards, or the model could point the guard at
 * itself. Fail-closed everywhere: no config, no model review.
 */
export function loadGateway(filename, { workspace }) {
  absolute(filename);
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 16384) throw new Error('UNSAFE_GATEWAY_FILE');
  if (process.platform !== 'win32' && ((stat.mode & 0o022) || (process.getuid && stat.uid !== process.getuid()))) throw new Error('UNSAFE_GATEWAY_PERMISSIONS');
  let raw;
  try { raw = JSON.parse(fs.readFileSync(filename, 'utf8')); }
  catch { throw new Error('INVALID_GATEWAY'); }
  const gateway = compileGateway(raw);
  // Same native normalization as directory(), so workspace and gateway file compare in one canonical form.
  if (inside(directory(workspace), fs.realpathSync.native(filename))) throw new Error('GATEWAY_MUST_BE_OUTSIDE_WORKSPACE');
  return gateway;
}

/**
 * Hand the API key to the caller for one-time use. The gateway stores only the env-var
 * NAME; the value exists in memory exactly here and must never appear in an error or log.
 */
export function resolveKey(gateway, env = process.env) {
  const value = env[gateway.apiKeyEnv];
  if (typeof value !== 'string' || value === '') throw new Error('GATEWAY_KEY_MISSING');
  return value;
}
