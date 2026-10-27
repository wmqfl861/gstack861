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
  const resolved = fs.realpathSync(absolute(value));
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
    const real = fs.realpathSync(current); // throws on a dangling symlink
    if (suffix.length && !fs.statSync(real).isDirectory()) throw new Error('NOT_A_DIRECTORY');
    return { path: path.join(real, ...suffix), exists: suffix.length === 0, stat: suffix.length ? null : fs.statSync(real) };
  }
}

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
      if (!/^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/.test(name) || !object(binding)
        || Object.keys(binding).some(k => !['effect', 'pathKey'].includes(k))
        || !['read', 'write'].includes(binding.effect)
        || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(binding.pathKey)
        || ['__proto__', 'constructor', 'prototype'].includes(binding.pathKey)) throw new Error('INVALID_TOOL_BINDING');
      normalized.bindings[host][name] = { effect: binding.effect, pathKey: binding.pathKey };
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
  if (inside(policy.workspace, fs.realpathSync(filename))) throw new Error('POLICY_MUST_BE_OUTSIDE_WORKSPACE');
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
    const target = targetPath(call.input[binding.pathKey], call.cwd);
    const roots = policy[binding.effect === 'read' ? 'readRoots' : 'writeRoots'];
    if (!roots.some(root => inside(root, target.path))) return deny('OUTSIDE_SCOPE', hash);
    if (binding.effect === 'write') {
      if (path.relative(policy.workspace, target.path).split(path.sep).some(vcsComponent)) return deny('PROTECTED_PATH', hash);
      const gitRoot = targetPath(path.join(policy.workspace, '.git')).path;
      if ([...policy.protectedRoots, gitRoot].some(root => inside(root, target.path))) return deny('PROTECTED_PATH', hash);
      if (target.exists && (!target.stat.isFile() || target.stat.nlink !== 1)) return deny('UNSAFE_WRITE_TARGET', hash);
    }
    return { decision: 'abstain', code: 'IN_SCOPE', policyHash: hash };
  } catch { return deny('INVALID_PATH_OR_CALL', policy?.policyHash); }
}
