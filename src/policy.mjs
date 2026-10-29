import fs from 'node:fs';
import path from 'node:path';
import { canonical, digest, freeze, object } from './json.mjs';

const HOSTS = ['zcode', 'dsh'];
const ROOT_KEYS = ['readRoots', 'writeRoots', 'protectedRoots'];
const compiled = new WeakSet();
const deny = (code, policyHash) => ({ decision: 'deny', code, ...(policyHash ? { policyHash } : {}) });

export function inside(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}

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

/** Resolve existing ancestors, including symlinks; dangling links fail closed. */
function targetPath(value, cwd) {
  if (typeof value !== 'string' || !value || /[\x00-\x1f]/.test(value)) throw new Error('INVALID_PATH');
  if (value.split(/[\\/]/).includes('..')) throw new Error('PATH_TRAVERSAL');
  if (process.platform !== 'win32' && value.includes('\\')) throw new Error('FOREIGN_PATH');
  if (!path.isAbsolute(value) && !cwd) throw new Error('CWD_REQUIRED');
  let current = path.isAbsolute(value) ? path.normalize(value) : path.resolve(directory(cwd), value);
  const suffix = [];
  for (;;) {
    let stat;
    try { stat = fs.lstatSync(current); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(current);
      if (parent === current) throw new Error('UNRESOLVED_PATH');
      suffix.unshift(path.basename(current));
      current = parent;
      continue;
    }
    // native realpath throws on a dangling symlink and also expands 8.3/case aliases of the existing prefix.
    const real = fs.realpathSync.native(current);
    if (suffix.length && !fs.statSync(real).isDirectory()) throw new Error('NOT_A_DIRECTORY');
    return { path: path.join(real, ...suffix), exists: suffix.length === 0, stat: suffix.length ? null : fs.statSync(real) };
  }
}

/**
 * Filesystem identity (device/inode pair) of an existing path; null when the path is missing.
 * Stable across 8.3 short names, case spellings and symlinks on NTFS, which is what makes
 * alias-proof comparisons with protected roots possible. Other errors propagate (fail closed).
 */
function existingIdentity(p) {
  try {
    const { dev, ino } = fs.statSync(p, { bigint: true });
    return `${dev}/${ino}`;
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
    throw error;
  }
}

const BINDING_KEYS = ['effect', 'pathKey', 'parser', 'effectKey', 'readWhen'];
const PARAM_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const FORBIDDEN_NAMES = ['__proto__', 'constructor', 'prototype'];

export function compilePolicy(raw) {
  if (!object(raw) || raw.schemaVersion !== 1) throw new Error('INVALID_POLICY_VERSION');
  const keys = ['schemaVersion', 'workspace', ...ROOT_KEYS, 'bindings'];
  if (Object.keys(raw).some(k => !keys.includes(k))) throw new Error('UNKNOWN_POLICY_FIELD');
  const workspace = directory(raw.workspace);
  if (workspace === path.parse(workspace).root) throw new Error('FILESYSTEM_ROOT_FORBIDDEN');
  const normalized = { schemaVersion: 1, workspace };
  for (const key of ROOT_KEYS) {
    if (!Array.isArray(raw[key])) throw new Error('ROOT_ARRAY_REQUIRED');
    normalized[key] = [...new Set(raw[key].map(directory))].sort();
    if (normalized[key].some(root => !inside(workspace, root))) throw new Error('ROOT_OUTSIDE_WORKSPACE');
  }
  // VCS internals cannot be edited even when the entire workspace is writable.
  normalized.protectedRoots.push(path.join(workspace, '.git'));
  normalized.bindings = {};
  if (!object(raw.bindings) || Object.keys(raw.bindings).some(h => !HOSTS.includes(h))) throw new Error('INVALID_HOST_BINDINGS');
  for (const host of HOSTS) {
    const bindings = raw.bindings[host] ?? {};
    if (!object(bindings)) throw new Error('INVALID_TOOL_BINDINGS');
    normalized.bindings[host] = Object.create(null);
    for (const [name, binding] of Object.entries(bindings)) {
      if (!/^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/.test(name) || !object(binding)) throw new Error('INVALID_TOOL_BINDING');
      // Optional binding extensions, all fail-closed at compile time: `parser` is only the
      // pinned 'apply-patch' V4A format and only on write bindings; `effectKey`+`readWhen`
      // (always as a pair) replace `effect` and key the read/write split off a call parameter.
      // `parser` and `effectKey` never combine. Absent fields must stay OUT of the normalized
      // binding so legacy policies keep compiling to byte-identical canonical form.
      const hasEffect = Object.hasOwn(binding, 'effect');
      const hasParser = Object.hasOwn(binding, 'parser');
      const hasEffectKey = Object.hasOwn(binding, 'effectKey');
      const hasReadWhen = Object.hasOwn(binding, 'readWhen');
      if (Object.keys(binding).some(k => !BINDING_KEYS.includes(k))
        || !PARAM_NAME.test(binding.pathKey) || FORBIDDEN_NAMES.includes(binding.pathKey)
        || (hasEffect && !['read', 'write'].includes(binding.effect))
        || (hasEffect && hasEffectKey) // mutually exclusive effect sources
        || (!hasEffect && !hasEffectKey) // exactly one of effect / effectKey+readWhen
        || (hasParser && (!hasEffect || binding.effect !== 'write')) // patch parsing only writes
        || (hasParser && binding.parser !== 'apply-patch') // single pinned upstream format
        || (hasParser && hasEffectKey) // a parsed patch is always a whole-call write
        || hasEffectKey !== hasReadWhen // the pair appears together or not at all
        || (hasEffectKey && (!PARAM_NAME.test(binding.effectKey) || FORBIDDEN_NAMES.includes(binding.effectKey)))
        || (hasReadWhen && (!Array.isArray(binding.readWhen) || binding.readWhen.length === 0
          || binding.readWhen.some(v => typeof v !== 'string' || !v)))) throw new Error('INVALID_TOOL_BINDING');
      normalized.bindings[host][name] = hasEffectKey
        ? { effectKey: binding.effectKey, readWhen: [...binding.readWhen], pathKey: binding.pathKey }
        : { effect: binding.effect, pathKey: binding.pathKey };
      if (hasParser) normalized.bindings[host][name].parser = binding.parser;
    }
  }
  normalized.policyHash = digest(normalized);
  freeze(normalized);
  compiled.add(normalized);
  return normalized;
}

export function loadPolicy(filename) {
  absolute(filename);
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 65536) throw new Error('UNSAFE_POLICY_FILE');
  if (process.platform !== 'win32' && ((stat.mode & 0o022) || (process.getuid && stat.uid !== process.getuid()))) throw new Error('UNSAFE_POLICY_PERMISSIONS');
  const policy = compilePolicy(JSON.parse(fs.readFileSync(filename, 'utf8')));
  // Same native normalization as directory(), so workspace and policy file compare in one canonical form.
  if (inside(policy.workspace, fs.realpathSync.native(filename))) throw new Error('POLICY_MUST_BE_OUTSIDE_WORKSPACE');
  return policy;
}

/**
 * Name-based VCS check for every path component, so nested repositories and submodules are
 * covered too. Case-insensitive, and on Windows also the alias spellings the filesystem maps
 * back to `.git` (8.3 `git~1`, trailing dots/spaces, `::$INDEX_ALLOCATION` streams).
 */
function vcsComponent(component) {
  let name = component.toLowerCase();
  if (process.platform === 'win32') name = name.split(':')[0].replace(/[. ]+$/, '');
  return name === '.git' || /^git~\d+$/.test(name);
}

/**
 * Paths touched by a ZCode-host ApplyPatch payload (V4A envelope at the pinned upstream
 * commit). Every `*** Add File:` / `*** Update File:` / `*** Move to:` / `*** Delete File:`
 * header path is extracted; `*** End of File` is a section marker, never a path. GNU diff
 * `+++ b/x` / `--- a/x` lines are tolerated as supplement (`/dev/null` skipped, the `a/`/`b/`
 * artifact prefix stripped, a trailing tab-separated timestamp cut). A payload without the
 * `*** Begin Patch` ... `*** End Patch` envelope, or with zero extracted paths, is not a
 * patch and fails closed. Extraction is deliberately broad: a false-positive line can only
 * add paths to be checked, which denies more, never less.
 */
const V4A_HEADER = /^\*\*\* (?:Add File|Update File|Move to|Delete File): (.*)$/;
const GNU_HEADER = /^(?:\+{3}|-{3}) (.*)$/;
function applyPatchPaths(text) {
  if (typeof text !== 'string' || !text.includes('*** Begin Patch') || !text.includes('*** End Patch')) throw new Error('INVALID_PATCH');
  const paths = new Set();
  for (const line of text.split(/\r?\n/)) {
    const header = V4A_HEADER.exec(line);
    if (header) {
      const extracted = header[1].trim();
      if (extracted) paths.add(extracted);
      continue;
    }
    const gnu = GNU_HEADER.exec(line);
    if (gnu) {
      const extracted = gnu[1].split('\t')[0].trim();
      if (extracted && extracted !== '/dev/null') paths.add(extracted.replace(/^(?:a|b)\//, ''));
    }
  }
  if (paths.size === 0) throw new Error('INVALID_PATCH');
  return [...paths];
}

/** Write-branch protections, shared by single-path bindings and every extracted patch path. Returns the denial code or null. */
function writeDenial(policy, target) {
  if (path.relative(policy.workspace, target.path).split(path.sep).some(vcsComponent)) return 'PROTECTED_PATH';
  const gitRoot = targetPath(path.join(policy.workspace, '.git')).path;
  // Identity comparison as defense in depth: spellings the string checks below cannot see
  // (8.3 short names, case aliases) must not make a protected directory writable. The union
  // with workspace/.git is deliberately redundant with compilePolicy's protectedRoots push.
  const protectedIdentities = new Set(
    [...policy.protectedRoots, gitRoot].map(existingIdentity).filter(id => id !== null),
  );
  const protectedPaths = [...policy.protectedRoots, gitRoot];
  // A `.git` FILE (worktree / separate-git-dir pointer) redirects git to a gitdir whose
  // hooks would run at the next git operation. Such pointers sit BESIDE the write path
  // (`wt/.git` pointing at sibling `real-git-data/`), never on it, so every existing
  // ancestor directory is scanned — its own entries and one directory level down — for
  // VCS-named pointer files and symlinks. Directory-form `.git` needs no parsing: the name
  // and identity checks already cover it. No caching: this runs per write evaluation.
  // Discovery boundary: pointers three or more directory levels below every ancestor of
  // the target (`ancestor/x/y/.git` and deeper, FILE or SYMLINK form) are NOT discovered,
  // and neither are reparse entries that are neither file, symlink, nor directory — a
  // gitdir redirected only from such a pointer stays writable. The model cannot widen
  // this gap: creating or modifying a pointer (file or symlink) at ANY depth is already
  // denied by the component name check above, so the boundary only exposes pointers that
  // predate the guarded session.
  const protectRedirect = (pointer) => {
    if (fs.statSync(pointer).size > 65536) return; // same cap as loadPolicy; oversized entries are not parsed
    // Git writes the gitdir path verbatim and legal paths may contain spaces (codex
    // audit #1) — capture the rest of the line and trim, like git's own gitfile parse.
    const match = fs.readFileSync(pointer, 'utf8').match(/^gitdir:\s*(.+)$/m);
    if (!match) return; // content without a gitdir: line is not a pointer — ignore
    const dir = path.resolve(path.dirname(pointer), match[1].trim());
    protectedPaths.push(dir); // unresolved form, so future children of a missing gitdir stay denied
    try {
      const identity = existingIdentity(fs.realpathSync.native(dir));
      if (identity !== null) protectedIdentities.add(identity); // catches alias spellings of the gitdir
    } catch (error) {
      if (error.code !== 'ENOENT') throw error; // missing gitdir: skip; anything else fails closed
    }
  };
  // A `.git` SYMLINK redirects to its target directly (no gitdir: indirection): protect
  // the resolved target the same two ways. Dangling links skip silently.
  const protectLink = (link) => {
    let target;
    try { target = fs.realpathSync.native(link); }
    catch (error) {
      if (error.code === 'ENOENT') return; // dangling pointer link: skip silently
      throw error; // anything else fails closed
    }
    protectedPaths.push(target);
    const identity = existingIdentity(target);
    if (identity !== null) protectedIdentities.add(identity);
  };
  const scanPointers = (dir, depth) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return; // vanished or non-directory level
      throw error;
    }
    for (const entry of entries) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isFile()) { if (vcsComponent(entry.name)) protectRedirect(entryPath); }
      else if (entry.isSymbolicLink()) { if (vcsComponent(entry.name)) protectLink(entryPath); }
      else if (depth > 0 && entry.isDirectory()) scanPointers(entryPath, depth - 1);
    }
  };
  for (let current = target.path; ; current = path.dirname(current)) {
    scanPointers(current, 1);
    if (current === policy.workspace || current === path.dirname(current)) break;
  }
  if (protectedPaths.some(root => inside(root, target.path))) return 'PROTECTED_PATH';
  for (let current = target.path; ; current = path.dirname(current)) {
    const identity = existingIdentity(current);
    if (identity !== null && protectedIdentities.has(identity)) return 'PROTECTED_PATH';
    if (current === policy.workspace || current === path.dirname(current)) break;
  }
  if (target.exists && (!target.stat.isFile() || target.stat.nlink !== 1)) return 'UNSAFE_WRITE_TARGET';
  return null;
}

/** Admission only. This does not execute tools or provide an OS sandbox. */
export function evaluate(policy, call) {
  try {
    if (!compiled.has(policy)) return deny('INVALID_POLICY');
    const hash = policy.policyHash;
    if (!object(call) || !HOSTS.includes(call.host) || typeof call.tool !== 'string' || !object(call.input)) return deny('INVALID_CALL', hash);
    canonical(call.input);
    const binding = policy.bindings[call.host][call.tool];
    if (!binding) return deny('UNMAPPED_TOOL', hash);
    if (!Object.hasOwn(call.input, binding.pathKey)) return deny('MISSING_PATH', hash);
    // Param-keyed effect: a string parameter value listed in readWhen reads; missing,
    // unknown or non-string values are always writes (the stricter branch).
    const effect = binding.effectKey
      ? (typeof call.input[binding.effectKey] === 'string' && binding.readWhen.includes(call.input[binding.effectKey]) ? 'read' : 'write')
      : binding.effect;
    if (binding.parser === 'apply-patch') {
      // The pathKey field is the whole patch text; its envelope is pinned V4A. Every
      // extracted path resolves against the session cwd and walks the full write
      // admission path — write roots plus all protections — before the call may abstain.
      const paths = applyPatchPaths(call.input[binding.pathKey]);
      if (!call.cwd) return deny('CWD_REQUIRED', hash); // patch paths are session-relative
      for (const extracted of paths) {
        const target = targetPath(extracted, call.cwd);
        if (!policy.writeRoots.some(root => inside(root, target.path))) return deny('OUTSIDE_SCOPE', hash);
        const denial = writeDenial(policy, target);
        if (denial) return deny(denial, hash);
      }
      return { decision: 'abstain', code: 'IN_SCOPE', policyHash: hash };
    }
    const target = targetPath(call.input[binding.pathKey], call.cwd);
    const roots = policy[effect === 'read' ? 'readRoots' : 'writeRoots'];
    if (!roots.some(root => inside(root, target.path))) return deny('OUTSIDE_SCOPE', hash);
    if (effect === 'write') {
      const denial = writeDenial(policy, target);
      if (denial) return deny(denial, hash);
    }
    return { decision: 'abstain', code: 'IN_SCOPE', policyHash: hash };
  } catch { return deny('INVALID_PATH_OR_CALL', policy?.policyHash); }
}
