import { execFileSync } from 'node:child_process';
import { textDigest } from './json.mjs';

function git(root, ...args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 15000 });
}

/** Inspect committed source only. Never execute upstream setup or skill code. */
export function inventory(root, expectedCommit) {
  if (!/^[a-f0-9]{40}$/.test(expectedCommit)) throw new Error('FULL_COMMIT_REQUIRED');
  const actual = git(root, 'rev-parse', 'HEAD').trim();
  if (actual !== expectedCommit) throw new Error('UPSTREAM_COMMIT_MISMATCH');
  if (git(root, 'status', '--porcelain', '--untracked-files=normal').trim()) throw new Error('UPSTREAM_DIRTY');
  const selected = new Map();
  for (const entry of git(root, 'ls-tree', '-r', '-z', '--full-tree', 'HEAD').split('\0').filter(Boolean)) {
    const match = /^(100644|100755) blob ([a-f0-9]{40})\t([a-z0-9][a-z0-9-]*)\/(SKILL\.md(?:\.tmpl)?)$/.exec(entry);
    if (!match) continue; // excludes host renders, symlinks and external submodules
    const [, , blob, name, basename] = match;
    if (!selected.has(name) || basename.endsWith('.tmpl')) selected.set(name, { name, blob, source: `${name}/${basename}` });
  }
  const skills = [...selected.values()].sort((a, b) => a.name.localeCompare(b.name)).map(skill => {
    const text = git(root, 'show', `HEAD:${skill.source}`);
    const indicators = [];
    if (/\bclaude\b/.test(text)) indicators.push('claude-reference');
    if (/\bcodex\b/.test(text)) indicators.push('codex-reference');
    if (/~\/\.(?:claude|codex)|CLAUDE_/.test(text)) indicators.push('host-path-or-env');
    if (/AskUserQuestion|EnterPlanMode|ExitPlanMode/.test(text)) indicators.push('host-interaction');
    if (/\{\{/.test(text)) indicators.push('template-resolvers');
    return { ...skill, sha256: textDigest(text), indicators, zcode: 'planned', dsh: 'planned' };
  });
  if (!skills.length) throw new Error('NO_SOURCE_SKILLS');
  return { schemaVersion: 1, commit: actual, scope: 'top-level-source-skills', fullParity: false,
    note: 'Static inventory only; subcommands, binaries and lifecycle hooks need separate coverage. Indicators require review, not blind replacements.', skills };
}
