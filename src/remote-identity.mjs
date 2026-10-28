// remote-identity — the one owner of git-remote project identity (batch 21 lane A).
//
// Verbatim zero-dependency Node port of upstream/gstack lib/remote-identity.ts
// (109 lines) at pinned submodule commit 5755601; cross-checked against its bash
// twin bin/gstack-remote-identity.sh (the bash twin additionally exposes
// _gri_last2, which the TS twin inlines and so does this port). The golden
// vectors in upstream test/fixtures/remote-identity-vectors.json are replayed
// in test/slug-identity.test.mjs.
//
// canonicalRemote: one spelling per repository whichever way it was cloned
// (#3003). Hosted remotes become "<host>/<seg>/…" with the host lowercased
// (ASCII only, locale-independent), userinfo, credentials and port dropped,
// one trailing ".git" and stray slashes removed, and host-specific
// normalization applied before segments are counted (Azure DevOps "v3/" and
// "_git", *.visualstudio.com → dev.azure.com/<org>/…, Bitbucket Server "scm/").
// Local remotes keep their path as identity (trailing slash of a lone "/" root
// survives).
//
// remoteSlug: hosted remotes with 3+ segments file under
// "<last-two>-<16 hex of sha256(canonical)>"; everything else keeps the legacy
// last-two parse byte-for-byte, so no 2-segment (GitHub) bucket moves.
//
// Divergence ledger (every deviation from the upstream TS twin):
//   1. SLUG_ALPHABET and sanitize are exported (upstream keeps the alphabet
//      module-private); src/slug.mjs needs the tr -cd 'a-zA-Z0-9._-'
//      equivalent for its own sanitize sites (slug, branch, env pin, cache).
//   2. export interface CanonicalRemote is expressed as a plain object (same
//      three keys: canonical, hosted, segments).

import { createHash } from 'node:crypto';

/** Characters a slug/branch may carry anywhere (shell-injection defense when eval'd). */
export const SLUG_ALPHABET = /[^a-zA-Z0-9._-]/g;
export const sanitize = value => String(value).replace(SLUG_ALPHABET, '');

// ASCII lowercase, locale-independent (never toLowerCase(): Turkish-I etc).
const asciiLower = s => s.replace(/[A-Z]/g, c => String.fromCharCode(c.charCodeAt(0) + 32));

function stripTrailingSlashes(s, keepRoot) {
  let out = s;
  while ((keepRoot ? out.length > 1 : out.length > 0) && out.endsWith('/')) out = out.slice(0, -1);
  return out;
}

export function canonicalRemote(rawUrl) {
  const url = rawUrl.replace(/[\r\n]/g, '');
  if (!url) return { canonical: '', hosted: false, segments: [] };
  let host = '';
  let path = '';
  let hosted = false;
  const schemeMatch = url.match(/^([A-Za-z][A-Za-z0-9+.-]*):\/\/(.*)$/);
  const scpMatch = url.match(/^([^/:]+):(.*)$/);
  if (schemeMatch) {
    const rest = schemeMatch[2];
    if (asciiLower(schemeMatch[1]) !== 'file') {
      const slash = rest.indexOf('/');
      let auth = slash === -1 ? rest : rest.slice(0, slash);
      path = slash === -1 ? '' : rest.slice(slash + 1);
      auth = auth.slice(auth.lastIndexOf('@') + 1);
      const v6 = auth.match(/^(\[[^\]]*\])/);
      host = v6 ? v6[1] : auth.split(':')[0];
      hosted = true;
    } else {
      path = rest;
    }
  } else if (scpMatch && !/^[A-Za-z]:([/\\]|$)/.test(url)) {
    host = scpMatch[1].slice(scpMatch[1].lastIndexOf('@') + 1);
    path = scpMatch[2];
    hosted = true;
  } else {
    path = url;
  }

  if (!hosted) {
    let p = stripTrailingSlashes(path, true);
    if (p.endsWith('.git')) p = p.slice(0, -4);
    p = stripTrailingSlashes(p, true);
    return { canonical: p, hosted: false, segments: [] };
  }

  host = asciiLower(host);
  path = stripTrailingSlashes(path, false);
  if (path.endsWith('.git')) path = path.slice(0, -4);
  let segments = path.split('/').filter(s => s !== '');

  if (host === 'ssh.dev.azure.com' || host === 'vs-ssh.visualstudio.com') {
    if (segments[0] === 'v3') segments = segments.slice(1);
    host = 'dev.azure.com';
  } else if (host !== 'dev.azure.com' && host.endsWith('.visualstudio.com')) {
    if (segments[0] === 'DefaultCollection') segments = segments.slice(1);
    segments = [host.split('.')[0], ...segments];
    host = 'dev.azure.com';
  } else if (host !== 'dev.azure.com' && segments.length >= 3 && segments[0] === 'scm') {
    segments = segments.slice(1);
  }
  if (host === 'dev.azure.com') segments = segments.filter(s => s !== '_git');

  return { canonical: [host, ...segments].join('/'), hosted: true, segments };
}

/** The pre-#3003 parse, byte-identical to bin/gstack-remote-identity.sh's gstack_legacy_remote_slug. */
export function legacyRemoteSlug(url) {
  const stripped = url.endsWith('.git') ? url.slice(0, -4) : url;
  const m = stripped.match(/[:/]([^/]+)\/([^/]+)$/);
  const slug = (m ? `${m[1]}-${m[2]}` : stripped).replace(SLUG_ALPHABET, '');
  return slug === '.' || slug === '..' ? '' : slug;
}

/** Project slug for a remote URL ('' when degenerate). */
export function remoteSlug(url) {
  const id = canonicalRemote(url);
  const n = id.segments.length;
  if (!id.hosted || n < 3) return legacyRemoteSlug(url);
  const digest = createHash('sha256').update(id.canonical).digest('hex').slice(0, 16);
  return `${id.segments[n - 2]}-${id.segments[n - 1]}-${digest}`.replace(SLUG_ALPHABET, '');
}
