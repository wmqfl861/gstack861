// sealed-guard — the sealed-output guard (field wave CD4), shared by the
// managed pre-push hook (Lane B's bin/gstack861-redact-prepush.mjs) and,
// upstream, the standalone preflight `gstack-pregate sealed` (a batch-23
// non-goal here).
//
// Port of upstream/gstack lib/sealed-guard.ts (276 lines) at pinned
// submodule commit 5755601dac5d35ebd7dde181fdefe52a023c73d9, verbatim
// apart from the ledger below.
//
// A repo opts in with a `sealed` key in `.gstack/pregate.json`:
//   paths           globs that may never be published (held-out sets, cells)
//   transcripts     globs of per-cell transcripts
//   answer_markers  regexes for a quoted sealed answer in added text
//   seed_patterns   regexes for a sampling seed in added text
//   local_paths     true: a local home path (/home/<u>/, /Users/<u>/) in added text
//   visibility      "public" | "private": the destination override (reviewed on the base branch)
//
// The publication boundary is every commit the push publishes: the local sha
// minus everything the destination remote already has (`git rev-list <local>
// --not --remotes=<remote> ^<remote sha>`); a destination with no refs means
// everything reachable. Path rules see every path a commit adds, renames or
// copies, independent of content (binary, empty, add-then-delete); text rules
// see each commit's added lines. The effective policy is the union of the
// destination base branch's `sealed` and the pushed one (a push can tighten,
// never relax); waivers come only from the base branch's
// `.gstack/sealed-allow.tsv`. A malformed or unreadable policy refuses (fail
// closed). Visibility: the base override, else a cache under the state root
// (a `public` answer for 24 h, a `private` one for 1 h before it may
// downgrade a refusal), else `gh repo view` (5 s); unknown counts as public.
// Findings name file, line, rule and commit, never the matched text.
//
// Divergence ledger (every deviation from the upstream source):
//   1. State root (plan 审计划必改落实 item 4): upstream
//      lib/state-root.ts resolveStateRoot chains GSTACK_STATE_ROOT →
//      GSTACK_HOME → GSTACK_STATE_DIR → CLAUDE_PLUGIN_DATA (gstack plugin
//      only) → $HOME/.gstack → .gstack. This port NEVER touches ~/.gstack
//      (the user may run the real gstack): the visibility-cache root is
//      <stateRoot option> → $GSTACK861_STATE_ROOT →
//      path.join(os.homedir(), '.gstack861'), via the shared
//      src/slug.mjs defaultStateRoot (batch 21 precedent; homedir via
//      os.homedir(), not $HOME — Windows service sessions). Injectable
//      through VisibilityOptions.stateRoot / EvaluateOptions.stateRoot so
//      tests isolate the cache.
//   2. The shared path/glob helpers (containedRelative / globToRegExp /
//      matchesAny) come from src/ship-policy.mjs, which carries the
//      inherited b20 divergence-4 platform-stable absoluteness: a glob
//      with a leading '\' (or a drive letter) is refused on POSIX too
//      (upstream path.isAbsolute('\foo') is false on POSIX). sealedErrors
//      therefore rejects such globs identically on every platform; win32
//      behavior is upstream's exactly.
//   3. The visibility-cache WRITE path is verbatim best-effort
//      `fs.mkdirSync(dirname, { recursive: true })` + `fs.writeFileSync`
//      inside a try/catch — deliberately NOT src/fs-utils.mjs mkdirpSync:
//      upstream has no bun-#2635 EEXIST tolerance here and an unwritable
//      cache only costs a lookup (plan 审计划 item 4: cache write fidelity).
//   4. Structural: TypeScript types erased to JSDoc typedefs (no runtime
//      change); non-null assertions dropped; `catch {}` kept. git stays
//      spawnSync (120 s timeout, 256 MiB maxBuffer), the gh probe stays
//      spawnSync 'gh' with a 5 s timeout, both verbatim.

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { containedRelative, globToRegExp, matchesAny } from './ship-policy.mjs';
import { defaultStateRoot } from './slug.mjs';

export const SEALED_CONFIG_PATH = '.gstack/pregate.json';
export const SEALED_ALLOW_PATH = '.gstack/sealed-allow.tsv';
export const VISIBILITY_OVERRIDE_KEY = 'sealed.visibility';

/**
 * @typedef {'sealed.path' | 'sealed.transcript' | 'sealed.answer' | 'sealed.seed' | 'sealed.local_path'} SealedRule
 * @typedef {{ paths: string[], transcripts: string[], answer_markers: string[], seed_patterns: string[], local_paths: boolean, visibility?: 'public' | 'private' }} SealedPolicy
 * @typedef {{ rule: SealedRule, file: string, line?: number, commit: string }} SealedFinding
 * @typedef {{ rule: string, path: string, sha: string, reason: string }} AllowEntry
 * @typedef {'public' | 'private' | 'unknown'} Visibility
 */

const KEYS = ['paths', 'transcripts', 'answer_markers', 'seed_patterns', 'local_paths', 'visibility'];
const MAX_ENTRIES = 64;
const MAX_REGEX = 256;
const LOCAL_PATH_RE = /(?:^|[^A-Za-z0-9_.~-])(?:\/home\/[^/\s'"`]+\/|\/Users\/[^/\s'"`]+\/|[A-Za-z]:\\+Users\\+[^\\\s'"`]+\\)/;
const PUBLIC_TTL_MS = 24 * 3600_000;
const PRIVATE_TTL_MS = 3600_000;

/** `<key>: <message>` errors for a `sealed` value; empty when valid. Shared with lib/pregate/config.ts. */
export function sealedErrors(raw) {
  const errors = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [{ path: 'sealed', message: 'must be an object { paths, transcripts, answer_markers, seed_patterns, local_paths, visibility }' }];
  const o = raw;
  for (const k of Object.keys(o)) if (!KEYS.includes(k)) errors.push({ path: `sealed.${k}`, message: `unknown key; valid keys: ${KEYS.join(', ')}` });
  const list = (key, check) => {
    if (!(key in o)) return;
    const v = o[key];
    if (!Array.isArray(v) || v.some(s => typeof s !== 'string')) { errors.push({ path: `sealed.${key}`, message: 'must be an array of strings' }); return; }
    if (v.length > MAX_ENTRIES) errors.push({ path: `sealed.${key}`, message: `more than ${MAX_ENTRIES} entries` });
    v.forEach((s, i) => { const why = check(s); if (why) errors.push({ path: `sealed.${key}[${i}]`, message: `${JSON.stringify(s)} ${why}` }); });
  };
  const glob = (g) => { const why = containedRelative(g); if (why) return why; try { globToRegExp(g); return null; } catch (e) { return e.message; } };
  const regex = (r) => { if (!r || r.length > MAX_REGEX) return `must be 1-${MAX_REGEX} characters`; try { new RegExp(r); return null; } catch (e) { return `is not a valid regex (${e.message})`; } };
  list('paths', glob); list('transcripts', glob); list('answer_markers', regex); list('seed_patterns', regex);
  if ('local_paths' in o && typeof o.local_paths !== 'boolean') errors.push({ path: 'sealed.local_paths', message: 'must be true or false' });
  if ('visibility' in o && o.visibility !== 'public' && o.visibility !== 'private') errors.push({ path: 'sealed.visibility', message: 'must be "public" or "private"' });
  return errors;
}

function git(repoRoot, args, input) {
  const r = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8', input, timeout: 120_000, maxBuffer: 256 * 1024 * 1024 });
  return { ok: r.status === 0, out: r.stdout ?? '', err: (r.stderr ?? '').trim() };
}

/** @typedef {{ policy: SealedPolicy | null, label: string } | { error: string, label: string }} PolicyRead */

/** The `sealed` key of `.gstack/pregate.json` at a commit; null when absent; an error when present but unreadable. */
export function sealedPolicyAt(repoRoot, treeish, label) {
  const spec = `${treeish}:${SEALED_CONFIG_PATH}`;
  if (!git(repoRoot, ['cat-file', '-e', spec]).ok) return { policy: null, label };
  const show = git(repoRoot, ['cat-file', 'blob', spec]);
  if (!show.ok) return { error: `cannot read ${SEALED_CONFIG_PATH} (${show.err})`, label };
  let raw;
  try { raw = JSON.parse(show.out); }
  catch (e) { return /"sealed"/.test(show.out) ? { error: `${SEALED_CONFIG_PATH} is not valid JSON (${e.message})`, label } : { policy: null, label }; }
  if (!raw || typeof raw !== 'object' || !('sealed' in raw)) return { policy: null, label };
  const errors = sealedErrors(raw.sealed);
  if (errors.length) return { error: errors.map(e => `${e.path}: ${e.message}`).join('; '), label };
  const s = raw.sealed;
  return { policy: { paths: s.paths ?? [], transcripts: s.transcripts ?? [], answer_markers: s.answer_markers ?? [], seed_patterns: s.seed_patterns ?? [], local_paths: s.local_paths === true, visibility: s.visibility }, label };
}

/** Base ∪ pushed: lists concatenate, `local_paths` ORs; visibility stays private only when the base says so and the push does not say public. */
export function unionPolicies(base, pushed) {
  if (!base && !pushed) return null;
  const u = (k) => [...new Set([...(base?.[k] ?? []), ...(pushed?.[k] ?? [])])];
  const visibility = pushed?.visibility === 'public' || base?.visibility === 'public' ? 'public' : base?.visibility === 'private' ? 'private' : undefined;
  return { paths: u('paths'), transcripts: u('transcripts'), answer_markers: u('answer_markers'), seed_patterns: u('seed_patterns'), local_paths: !!(base?.local_paths || pushed?.local_paths), visibility };
}

/** Reviewed waivers: `rule<TAB>path<TAB>sha<TAB>reason` lines in the base branch's allow file. */
export function allowEntriesAt(repoRoot, treeish) {
  if (!treeish) return [];
  const show = git(repoRoot, ['cat-file', 'blob', `${treeish}:${SEALED_ALLOW_PATH}`]);
  if (!show.ok) return [];
  return show.out.split('\n').filter(l => l.trim() && !l.startsWith('#')).map(l => l.split('\t')).filter(f => f.length >= 4 && /^[0-9a-f]{7,64}$/.test(f[2]) && f[3].trim())
    .map(f => ({ rule: f[0].trim(), path: f[1].trim(), sha: f[2], reason: f.slice(3).join('\t').trim() }));
}

/** Commits a push publishes: local minus the remote's refs (and its tip for this ref); null remote and no tip → everything reachable. */
export function publishedCommits(repoRoot, o) {
  const not = [];
  if (o.remoteName) not.push(`--remotes=${o.remoteName}/*`);
  if (o.remoteSha && !/^0+$/.test(o.remoteSha) && git(repoRoot, ['cat-file', '-e', `${o.remoteSha}^{commit}`]).ok) not.push(o.remoteSha);
  const r = git(repoRoot, ['rev-list', o.localSha, ...(not.length ? ['--not', ...not] : [])]);
  if (!r.ok) return { error: `git rev-list failed: ${r.err.slice(0, 200)}` };
  return { commits: r.out.split('\n').filter(Boolean) };
}

export function rangeCommits(repoRoot, range) {
  const r = git(repoRoot, ['rev-list', range]);
  if (!r.ok) return { error: `git rev-list ${range} failed: ${r.err.slice(0, 200)}` };
  return { commits: r.out.split('\n').filter(Boolean) };
}

const HEX = /^[0-9a-f]{40,64}$/;

/** Path rules over every added, renamed or copied path, per commit (merges: paths new against every parent). */
function pathFindings(repoRoot, commits, p) {
  if (!p.paths.length && !p.transcripts.length) return [];
  const r = git(repoRoot, ['-c', 'core.quotePath=false', 'diff-tree', '--stdin', '-r', '--root', '-M', '-C', '--cc', '--name-status', '-z'], commits.join('\n') + '\n');
  if (!r.ok) throw new Error(`git diff-tree failed: ${r.err.slice(0, 200)}`);
  const out = [];
  const tokens = r.out.split('\0');
  let commit = '';
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (!t) continue;
    if (HEX.test(t)) { commit = t; continue; }
    const renamed = /^[RC]\d*$/.test(t);
    const file = renamed ? tokens[i += 2] : tokens[++i];
    if (!renamed && !t.includes('A')) continue;
    if (matchesAny(p.transcripts, file)) out.push({ rule: 'sealed.transcript', file, commit });
    else if (matchesAny(p.paths, file)) out.push({ rule: 'sealed.path', file, commit });
  }
  return out;
}

/** Text rules over each commit's added lines (`--cc` for merges: only the resolution's own lines). */
function textFindings(repoRoot, commits, p) {
  const rules = [
    ...p.answer_markers.map(r => ['sealed.answer', new RegExp(r)]),
    ...p.seed_patterns.map(r => ['sealed.seed', new RegExp(r)]),
    ...(p.local_paths ? [['sealed.local_path', LOCAL_PATH_RE]] : []),
  ];
  if (!rules.length) return [];
  const r = git(repoRoot, ['-c', 'core.quotePath=false', 'diff-tree', '--stdin', '-r', '--root', '-M', '-C', '--cc', '-p', '--unified=0', '--no-color', '--no-ext-diff', '--no-textconv'], commits.join('\n') + '\n');
  if (!r.ok) throw new Error(`git diff-tree -p failed: ${r.err.slice(0, 200)}`);
  const out = [];
  let commit = ''; let file = ''; let inHunk = false; let parents = 1; let next = 0;
  for (const line of r.out.split('\n')) {
    if (HEX.test(line)) { commit = line; inHunk = false; continue; }
    if (line.startsWith('diff --')) { inHunk = false; file = ''; continue; }
    if (line.startsWith('@@')) { inHunk = true; parents = (/^@+/.exec(line)?.[0].length ?? 2) - 1; next = Number(/ \+(\d+)(?:,\d+)? @+/.exec(line)?.[1] ?? 0); continue; }
    if (!inHunk) { if (line.startsWith('+++ ')) file = line.startsWith('+++ b/') ? line.slice(6) : ''; continue; }
    const prefix = line.slice(0, parents);
    if (line.startsWith('\\') || prefix.includes('-')) continue;
    const n = next++;
    if (!prefix.includes('+')) continue;
    const text = line.slice(parents);
    for (const [rule, re] of rules) if (re.test(text)) out.push({ rule, file, line: n, commit });
  }
  return out;
}

export function scanCommits(repoRoot, commits, policy) {
  if (!commits.length) return [];
  const seen = new Set();
  return [...pathFindings(repoRoot, commits, policy), ...textFindings(repoRoot, commits, policy)].filter(f => {
    const key = `${f.rule}\0${f.file}\0${f.line ?? ''}\0${f.commit}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** `owner/repo` for a GitHub remote URL; null for anything else (a local path, another host). */
export function githubSlug(url) {
  const m = /^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec((url ?? '').trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

/**
 * @typedef {{ env?: Record<string, string | undefined>, gh?: (args: string[]) => { ok: boolean, out: string }, now?: number, stateRoot?: string }} VisibilityOptions
 * (stateRoot is this port's injection point for the ledger-1 state-root mapping.)
 */

/** Destination visibility: cache (public 24 h, private 1 h), else `gh repo view` (5 s); unknown on any failure or a non-GitHub remote. */
export function resolveVisibility(url, o = {}) {
  const slug = githubSlug(url);
  if (!slug) return { visibility: 'unknown', source: 'not a GitHub remote' };
  const now = o.now ?? Date.now();
  const file = path.join(o.stateRoot ?? defaultStateRoot(o.env ?? process.env), 'sealed-visibility.json');
  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(file, 'utf8')).entries ?? {}; } catch { cache = {}; }
  const hit = cache[slug];
  if (hit && ((hit.visibility === 'public' && now - hit.checked_at < PUBLIC_TTL_MS) || (hit.visibility === 'private' && now - hit.checked_at < PRIVATE_TTL_MS))) return { visibility: hit.visibility, source: `cache ${new Date(hit.checked_at).toISOString()}` };
  const gh = o.gh ?? ((args) => { const r = spawnSync('gh', args, { encoding: 'utf8', timeout: 5_000, env: o.env ?? process.env }); return { ok: r.status === 0, out: r.stdout ?? '' }; });
  const r = gh(['repo', 'view', slug, '--json', 'visibility']);
  let v;
  try { v = r.ok ? String(JSON.parse(r.out).visibility ?? '').toLowerCase() : undefined; } catch { v = undefined; }
  if (v !== 'public' && v !== 'private' && v !== 'internal') return { visibility: 'unknown', source: `gh repo view ${slug} failed (a new or unreadable repository counts as public)` };
  const visibility = v === 'public' ? 'public' : 'private';
  cache[slug] = { visibility, checked_at: now };
  // Ledger 3: verbatim best-effort write — plain mkdirSync, NOT mkdirpSync.
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify({ entries: cache }, null, 2) + '\n'); } catch { /* an unwritable cache only costs a lookup */ }
  return { visibility, source: `gh repo view ${slug}` };
}

/**
 * @typedef {{ status: 'no-policy' | 'clear' | 'refused' | 'warned' | 'error',
 *             policyLabels: string[], commits: number, findings: SealedFinding[],
 *             waived: Array<SealedFinding & { reason: string }>,
 *             visibility: Visibility, visibilitySource: string, target: string, error?: string }} SealedReport
 * @typedef {{ repoRoot: string, targets: Array<{ commits: string[], pushedSha: string }>, baseRef: string | null, baseLabel?: string,
 *             remoteUrl: string | null, target: string,
 *             env?: Record<string, string | undefined>, gh?: VisibilityOptions['gh'], stateRoot?: string }} EvaluateOptions
 */

/** The whole guard for one push (or range): policies, commits, findings, waivers, visibility, verdict. */
export function evaluateSealed(o) {
  const blank = { policyLabels: [], commits: 0, findings: [], waived: [], visibility: 'unknown', visibilitySource: '', target: o.target };
  const base = o.baseRef ? sealedPolicyAt(o.repoRoot, o.baseRef, o.baseLabel ?? o.baseRef) : { policy: null, label: '(no destination base branch)' };
  if ('error' in base) return { ...blank, status: 'error', error: `the sealed policy on ${base.label} is unreadable: ${base.error}` };
  let policy = base.policy;
  const labels = base.policy ? [base.label] : [];
  for (const t of o.targets) {
    const pushed = sealedPolicyAt(o.repoRoot, t.pushedSha, `pushed ${t.pushedSha.slice(0, 12)}`);
    if ('error' in pushed) return { ...blank, status: 'error', error: `the sealed policy in ${pushed.label} is unreadable: ${pushed.error}` };
    if (pushed.policy) labels.push(pushed.label);
    policy = unionPolicies(policy, pushed.policy);
  }
  if (!policy) return { ...blank, status: 'no-policy' };
  const commits = [...new Set(o.targets.flatMap(t => t.commits))];
  let found;
  try { found = scanCommits(o.repoRoot, commits, policy); }
  catch (e) { return { ...blank, policyLabels: labels, commits: commits.length, status: 'error', error: `could not read the published commits: ${e.message}` }; }
  const allow = allowEntriesAt(o.repoRoot, o.baseRef);
  const waived = [];
  const findings = found.filter(f => {
    const entry = allow.find(a => a.rule === f.rule && a.path === f.file && f.commit.startsWith(a.sha));
    if (entry) waived.push({ ...f, reason: entry.reason });
    return !entry;
  });
  const vis = policy.visibility ? { visibility: policy.visibility, source: `${VISIBILITY_OVERRIDE_KEY} override` } : resolveVisibility(o.remoteUrl, { env: o.env, gh: o.gh, stateRoot: o.stateRoot });
  const status = findings.length === 0 ? 'clear' : vis.visibility === 'private' ? 'warned' : 'refused';
  return { status, policyLabels: labels, commits: commits.length, findings, waived, visibility: vis.visibility, visibilitySource: vis.source, target: o.target };
}

const where = (f) => `${f.file || '(unknown file)'}${f.line ? `:${f.line}` : ''}`;

/** stderr text for a report: findings one per line (`<rule>  <file[:line]>  commit <sha12>`), never the matched text. */
export function renderSealed(r, context) {
  const lines = [];
  for (const w of r.waived) lines.push(`${context}: waived ${w.rule}  ${where(w)}  commit ${w.commit.slice(0, 12)} (${SEALED_ALLOW_PATH}: ${w.reason})`);
  const vis = `visibility: ${r.visibility}${r.visibility === 'unknown' ? ', counted public' : ''}; ${r.visibilitySource}`;
  const body = r.findings.map(f => `  ${f.rule}  ${where(f)}  commit ${f.commit.slice(0, 12)}`);
  if (r.status === 'error') {
    lines.push(`\n⛔ ${context} BLOCKED the publication of ${r.target} — ${r.error}.`);
    lines.push(`Fix the sealed policy (gstack-pregate validate), then retry; an unreadable policy never passes (SEALED_OUTPUT_REFUSED)`);
  } else if (r.status === 'refused') {
    lines.push(`\n⛔ ${context} BLOCKED the publication of ${r.target} (${vis}) — sealed or eval output in ${r.commits} published commit(s):`, ...body);
    lines.push(`Remove it from every published commit before this branch reaches a public repository, or waive one reviewed finding with a \`rule<TAB>path<TAB>sha<TAB>reason\` line in the base branch's ${SEALED_ALLOW_PATH}. A private destination: set ${VISIBILITY_OVERRIDE_KEY} "private" in the base branch's ${SEALED_CONFIG_PATH} (SEALED_OUTPUT_REFUSED)`);
  } else if (r.status === 'warned') {
    lines.push(`${context}: warning — sealed or eval output in a push to a private destination (${vis}); it would be refused for a public one:`, ...body);
  }
  return lines.length ? lines.join('\n') + '\n' : '';
}
