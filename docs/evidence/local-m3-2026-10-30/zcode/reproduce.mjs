import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Fixture-only audit runner. Usage: node reproduce.mjs REPO SCRATCH EVIDENCE
// All processes use an explicit credential-free environment, Git ignores user/system
// configuration, and all lifecycle targets live inside a new run directory.
const [repoArg, scratchArg, evidenceArg] = process.argv.slice(2);
if (![repoArg, scratchArg, evidenceArg].every(p => typeof p === 'string' && path.isAbsolute(p))) throw new Error('ABSOLUTE_ARGUMENTS_REQUIRED');
const repo = fs.realpathSync(repoArg);
const scratch = path.resolve(scratchArg);
const evidence = path.resolve(evidenceArg);
fs.mkdirSync(scratch, { recursive: true });
fs.mkdirSync(evidence, { recursive: true });
const runRoot = path.join(scratch, 'r-' + randomUUID().slice(0, 8));
fs.mkdirSync(runRoot);
const childTemp = path.join(runRoot, 'child-temp');
fs.mkdirSync(childTemp);
const emptyGitConfig = path.join(runRoot, 'empty-git-config');
fs.writeFileSync(emptyGitConfig, '');
const childEnv = {};
for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT']) {
  if (process.env[key] !== undefined) childEnv[key] = process.env[key];
}
Object.assign(childEnv, {
  GSTACK861_MODEL_CALL: '0', TEMP: childTemp, TMP: childTemp,
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: emptyGitConfig, GIT_CONFIG_GLOBAL: emptyGitConfig,
  GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', NO_COLOR: '1',
});
const cliPath = path.join(repo, 'bin', 'gstack861.mjs');
const { planZcodeConfig: installPlan, applyZcodeConfigPlan: apply, planZcodeUninstall: uninstallPlan } = await import(pathToFileURL(path.join(repo, 'src', 'zcode-profile.mjs')).href);
const { canonical } = await import(pathToFileURL(path.join(repo, 'src', 'json.mjs')).href);
const sha256 = value => createHash('sha256').update(value).digest('hex');
const targetFiles = ['src/zcode-profile.mjs', 'bin/gstack861.mjs', 'test/zcode-profile.test.mjs', 'test/host-setup-cli.test.mjs'];
const originalHashes = Object.fromEntries(targetFiles.map(p => [p, sha256(fs.readFileSync(path.join(repo, p)))]));
const commands = [], results = [];
function sanitize(value) {
  let text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  for (const [real, placeholder] of [[runRoot, '<RUN>'], [repo, '<REPO>'], [scratch, '<SCRATCH>'], [evidence, '<EVIDENCE>'], [process.execPath, '<NODE>']]) {
    for (const base of [real, real.replaceAll('\\', '/')]) {
      let variant = base;
      for (let level = 0; level < 5; level++) {
        text = text.split(variant).join(placeholder);
        variant = JSON.stringify(variant).slice(1, -1);
      }
    }
  }
  return text;
}
function snapshot(root) {
  const result = [];
  function walk(file, relative) {
    const st = fs.lstatSync(file, { throwIfNoEntry: false });
    if (!st) return;
    const item = { path: relative.replaceAll('\\', '/'), kind: st.isSymbolicLink() ? 'link' : st.isDirectory() ? 'directory' : st.isFile() ? 'file' : 'other', mode: st.mode, mtimeMs: st.mtimeMs, nlink: st.nlink };
    if (st.isSymbolicLink()) item.target = fs.readlinkSync(file);
    else if (st.isFile()) item.sha256 = sha256(fs.readFileSync(file));
    result.push(item);
    if (st.isDirectory() && !st.isSymbolicLink()) for (const name of fs.readdirSync(file).sort()) walk(path.join(file, name), path.join(relative, name));
  }
  walk(root, '.');
  return result;
}
function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
function delta(a, b) {
  const left = new Map(a.map(v => [v.path, v])), right = new Map(b.map(v => [v.path, v]));
  return [...new Set([...left.keys(), ...right.keys()])].filter(k => !same(left.get(k), right.get(k))).map(k => ({ path: k, before: left.get(k) ?? null, after: right.get(k) ?? null }));
}
function outcome(fn) {
  try { return { ok: true, value: fn() }; }
  catch (error) { return { ok: false, error: error.message, code: error.code ?? null }; }
}
function command(name, executable, args, cwd = repo) {
  const started = Date.now();
  const r = spawnSync(executable, args, { cwd, env: childEnv, encoding: 'utf8', timeout: 30000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
  const entry = { name, executable, args, cwd, durationMs: Date.now() - started, status: r.status, signal: r.signal, error: r.error?.code ?? null, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  commands.push(entry);
  return entry;
}
function runCli(f, verb, doApply = false, policyPath = f.policyPath) {
  return command(f.name + '-' + verb + (doApply ? '-apply' : '-preview'), process.execPath, [cliPath, 'zcode-config-' + verb, '--workspace', f.workspace, '--policy', policyPath, ...(doApply ? ['--apply'] : [])]);
}
function fixture(name, { config, zdir = true } = {}) {
  const base = path.join(runRoot, name);
  fs.mkdirSync(base);
  const workspace = path.join(base, 'workspace');
  fs.mkdirSync(workspace);
  const init = command(name + '-git-init', 'git', ['-C', workspace, 'init', '--quiet']);
  if (init.status !== 0) throw new Error('GIT_FIXTURE_INIT_FAILED');
  fs.writeFileSync(path.join(workspace, 'user-file.txt'), 'synthetic fixture only\r\n');
  if (zdir) fs.mkdirSync(path.join(workspace, '.zcode'));
  const policyPath = path.join(base, 'policy.json');
  fs.writeFileSync(policyPath, JSON.stringify({ schemaVersion: 1, workspace, readRoots: [workspace], writeRoots: [], protectedRoots: [], bindings: { zcode: {}, dsh: {} } }), { mode: 0o600 });
  const f = { name, base, workspace, root: workspace, nodePath: process.execPath, cliPath, policyPath, file: path.join(workspace, '.zcode', 'config.json') };
  if (config !== undefined) fs.writeFileSync(f.file, typeof config === 'string' ? config : JSON.stringify(config));
  return f;
}
function readConfig(f) { return JSON.parse(fs.readFileSync(f.file, 'utf8')); }
function owned(f) { return { matcher: '.*', hooks: [{ type: 'process', command: f.nodePath, args: [f.cliPath, 'hook', 'zcode', '--policy', f.policyPath], timeoutMs: 10000 }] }; }
function leftovers(f) { return fs.existsSync(path.dirname(f.file)) ? fs.readdirSync(path.dirname(f.file)).filter(n => n.includes('.tmp') || n.includes('.lock')) : []; }
function patch(method, wrapper, fn) {
  const original = fs[method];
  fs[method] = (...args) => wrapper(original, args);
  try { return fn(); } finally { fs[method] = original; }
}
function ioTrace(fn) {
  const calls = [], saved = {};
  for (const name of ['mkdirSync', 'rmdirSync', 'writeFileSync', 'renameSync', 'unlinkSync']) {
    saved[name] = fs[name];
    fs[name] = (...args) => { calls.push({ method: name, path: String(args[0]), ...(name === 'renameSync' ? { destination: String(args[1]) } : {}) }); return saved[name](...args); };
  }
  try { return { outcome: outcome(fn), calls }; }
  finally { for (const [name, fn] of Object.entries(saved)) fs[name] = fn; }
}
function record(id, expected, fn) {
  try {
    const result = fn();
    results.push({ id, expected, ...result });
    process.stdout.write(id + ' ' + result.verdict + '\n');
  } catch (error) {
    results.push({ id, expected, verdict: 'harness-error', error: error.message, code: error.code ?? null, stack: error.stack });
    process.stdout.write(id + ' harness-error ' + error.message + '\n');
  }
}
function linkOrBlocked(target, destination, type = 'junction') {
  const r = outcome(() => fs.symlinkSync(target, destination, type));
  return r.ok ? null : { verdict: 'environment-blocked', linkType: type, error: r.error, code: r.code };
}

const head = command('audit-head', 'git', ['-C', repo, 'rev-parse', 'HEAD']).stdout.trim();
const focused = command('focused-original-tests', process.execPath, ['--test', '--test-concurrency=1', '--test-name-pattern=zcode|workspace hook|apply is|optimistic|refuses', path.join(repo, 'test/zcode-profile.test.mjs'), path.join(repo, 'test/host-setup-cli.test.mjs')]);
results.push({ id: 'original-focused-tests', expected: 'Tests exercise lifecycle rather than fail at fixture argument validation.', verdict: focused.status === 0 ? 'pass' : 'fixture-and-runtime-failure', status: focused.status, stdout: focused.stdout, stderr: focused.stderr });

record('fresh-cli', 'Preview changes zero tree entries; first explicit apply creates the workspace config.', () => {
  const f = fixture('fresh-cli', { zdir: false });
  const before = snapshot(f.workspace), preview = runCli(f, 'install'), afterPreview = snapshot(f.workspace);
  const applied = runCli(f, 'install', true), afterApply = snapshot(f.workspace);
  return { verdict: preview.status === 0 && same(before, afterPreview) && applied.status === 0 ? 'pass' : 'defect', preview, previewTreeIdentical: same(before, afterPreview), applied, applyDelta: delta(afterPreview, afterApply) };
});
record('existing-lifecycle', 'Preserve foreign settings/hooks semantically, preview byte-for-byte, repeated apply byte-for-byte; uninstall restores original semantics.', () => {
  const foreign = { matcher: 'Write', hooks: [{ type: 'command', command: 'foreign-hook-fixture' }] };
  const original = { theme: 'dark', nested: { retain: ['x', 2] }, hooks: { enabled: true, events: { PreToolUse: [foreign], Stop: [{ matcher: '.*', hooks: [{ type: 'command', command: 'foreign-stop-fixture' }] }] } } };
  const f = fixture('existing-lifecycle', { config: '\r\n' + JSON.stringify(original, null, '\t') + '\r\n' });
  const initialBytes = fs.readFileSync(f.file), before = snapshot(f.workspace), preview = runCli(f, 'install'), afterPreview = snapshot(f.workspace);
  const applied = runCli(f, 'install', true), installed = readConfig(f), installedBytes = fs.readFileSync(f.file), installedMtime = fs.statSync(f.file).mtimeMs;
  const repeated = runCli(f, 'install', true), repeatedBytesEqual = installedBytes.equals(fs.readFileSync(f.file)), repeatedMtimeEqual = installedMtime === fs.statSync(f.file).mtimeMs;
  const preUninstall = snapshot(f.workspace), removePreview = runCli(f, 'uninstall'), uninstallPreviewTreeIdentical = same(preUninstall, snapshot(f.workspace));
  const removed = runCli(f, 'uninstall', true), final = readConfig(f);
  return { verdict: [preview, applied, repeated, removePreview, removed].every(r => r.status === 0) && canonical(final) === canonical(original) && repeatedBytesEqual && same(before, afterPreview) ? 'pass-with-format-change' : 'defect', previewTreeIdentical: same(before, afterPreview), uninstallPreviewTreeIdentical, foreignHooksRetained: canonical(installed.hooks.events.PreToolUse[0]) === canonical(foreign), installedHookCount: installed.hooks.events.PreToolUse.length, repeatedBytesEqual, repeatedMtimeEqual, initialAndFinalSemanticsEqual: canonical(final) === canonical(original), initialAndFinalBytesEqual: initialBytes.equals(fs.readFileSync(f.file)), commands: [preview, applied, repeated, removePreview, removed] };
});
for (const [name, original] of [['no-hooks', { theme: 'dark' }], ['empty-hooks', { hooks: {} }], ['enabled-true', { hooks: { enabled: true } }], ['foreign-hook-no-enabled', { hooks: { events: { Stop: [{ matcher: '.*', hooks: [{ type: 'command', command: 'foreign-stop-fixture' }] }] } } }]]) {
  record('enabled-ownership-' + name, 'Uninstall restores the prior hooks.enabled presence/value and preexisting containers.', () => {
    const f = fixture('enabled-ownership-' + name, { config: original });
    const installed = outcome(() => apply(installPlan(f))), removed = outcome(() => apply(uninstallPlan(f))), final = readConfig(f);
    return { verdict: installed.ok && removed.ok && canonical(final) === canonical(original) ? 'pass' : 'defect', original, installed, removed, final };
  });
}
record('fresh-precreated-zdir-lifecycle', 'Empty fixture installs once, repeats without config rewrite, and uninstalls to the original empty configuration.', () => {
  const f = fixture('fresh-precreated-zdir-lifecycle');
  const first = outcome(() => apply(installPlan(f))), installedBytes = fs.readFileSync(f.file);
  const second = outcome(() => apply(installPlan(f))), idempotentBytes = installedBytes.equals(fs.readFileSync(f.file));
  const remove = outcome(() => apply(uninstallPlan(f))), final = readConfig(f);
  return { verdict: first.ok && second.ok && idempotentBytes && canonical(final) === '{}' ? 'pass' : 'defect', first, second, idempotentBytes, remove, final };
});
record('exact-entry-identity', 'An entry with additional user metadata is not the exact owned entry and must survive uninstall.', () => {
  const f = fixture('exact-entry-identity');
  const near = { ...owned(f), userAnnotation: 'foreign-entry-retain' };
  const original = { hooks: { enabled: true, events: { PreToolUse: [near, owned(f), { ...owned(f), hooks: [{ ...owned(f).hooks[0], timeoutMs: 9999 }] }] } } };
  fs.writeFileSync(f.file, JSON.stringify(original));
  const plan = uninstallPlan(f), applied = outcome(() => apply(plan)), final = readConfig(f);
  const entries = final.hooks?.events?.PreToolUse ?? [];
  return { verdict: entries.some(v => v.userAnnotation === 'foreign-entry-retain') && entries.length === 2 ? 'pass' : 'defect', original, applied, final, foreignAnnotationEntryRetained: entries.some(v => v.userAnnotation === 'foreign-entry-retain') };
});
record('preexisting-identical-hook', 'An install that adds nothing must not claim ownership of a hook that already existed.', () => {
  const f = fixture('preexisting-identical-hook');
  const original = { hooks: { enabled: true, events: { PreToolUse: [owned(f)] } } };
  fs.writeFileSync(f.file, JSON.stringify(original));
  const plan = installPlan(f), install = outcome(() => apply(plan)), remove = outcome(() => apply(uninstallPlan(f))), final = readConfig(f);
  return { verdict: canonical(final) === canonical(original) ? 'pass' : 'defect', installPlanChanged: plan.changed, install, remove, original, final, interpretation: 'Exact hook identity currently serves as inferred ownership; no provenance distinguishes a user-preexisting identical entry.' };
});
record('stale-semantic-edit', 'A concurrent semantic config edit is refused and its exact bytes survive.', () => {
  const f = fixture('stale-semantic-edit', { config: {} }), plan = installPlan(f);
  fs.writeFileSync(f.file, '{\r\n\t"userSetting": true\r\n}\r\n');
  const bytes = fs.readFileSync(f.file), result = outcome(() => apply(plan));
  return { verdict: !result.ok && result.error === 'ZCODE_CONFIG_CHANGED' && bytes.equals(fs.readFileSync(f.file)) && leftovers(f).length === 0 ? 'pass' : 'defect', result, concurrentBytesPreserved: bytes.equals(fs.readFileSync(f.file)), leftovers: leftovers(f) };
});
for (const mutation of ['format-only', 'delete-empty', 'create-empty', 'replace-identical']) {
  record('stale-' + mutation, 'A stale plan refuses any config byte/existence/identity change between plan and apply.', () => {
    const f = fixture('stale-' + mutation, { ...(mutation === 'create-empty' ? {} : { config: {} }) });
    const plan = installPlan(f), initialIdentity = fs.existsSync(f.file) ? String(fs.statSync(f.file, { bigint: true }).ino) : null;
    if (mutation === 'format-only') fs.writeFileSync(f.file, ' { }\r\n');
    if (mutation === 'delete-empty') fs.unlinkSync(f.file);
    if (mutation === 'create-empty') fs.writeFileSync(f.file, '{}');
    if (mutation === 'replace-identical') { fs.renameSync(f.file, f.file + '.old'); fs.writeFileSync(f.file, '{}'); }
    const before = snapshot(f.workspace), identityAtApply = fs.existsSync(f.file) ? String(fs.statSync(f.file, { bigint: true }).ino) : null, result = outcome(() => apply(plan));
    return { verdict: !result.ok && same(before, snapshot(f.workspace)) ? 'pass' : 'defect', planExisted: plan.existed, initialIdentity, identityAtApply, result, delta: delta(before, snapshot(f.workspace)) };
  });
}
for (const [name, content, installShouldReject, uninstallShouldReject] of [
  ['malformed-json', '{', true, true], ['array-config', '[]', true, true], ['hooks-array', { hooks: [] }, true, true],
  ['disabled', { hooks: { enabled: false } }, true, false], ['enabled-string', { hooks: { enabled: 'false' } }, true, true],
  ['enabled-null', { hooks: { enabled: null } }, true, true], ['hooks-null', { hooks: null }, true, true],
  ['events-null', { hooks: { events: null } }, true, true], ['events-array', { hooks: { events: [] } }, true, true],
  ['pretooluse-object', { hooks: { events: { PreToolUse: {} } } }, true, true],
  ['foreign-event-nonarray', { hooks: { events: { Stop: 'malformed' } } }, true, true],
  ['invalid-entry-types', { hooks: { events: { PreToolUse: [{ matcher: 7, hooks: 'malformed' }] } } }, true, true],
]) {
  record('bad-config-' + name, 'Invalid structures fail closed; a disabled install refuses without changing the configuration.', () => {
    const f = fixture('bad-config-' + name, { config: content }), before = snapshot(f.workspace);
    const install = outcome(() => installPlan(f)), remove = outcome(() => uninstallPlan(f));
    const refusedExpected = (!installShouldReject || !install.ok) && (!uninstallShouldReject || !remove.ok);
    return { verdict: refusedExpected && same(before, snapshot(f.workspace)) ? 'pass' : 'defect', installShouldReject, uninstallShouldReject, install, remove, previewTreeIdentical: same(before, snapshot(f.workspace)) };
  });
}
record('config-hardlink', 'Install and uninstall refuse a multiply linked config before mutation.', () => {
  const f = fixture('config-hardlink', { config: {} }); fs.linkSync(f.file, path.join(f.base, 'hardlink.json'));
  const before = snapshot(f.base), install = outcome(() => installPlan(f)), remove = outcome(() => uninstallPlan(f));
  return { verdict: !install.ok && !remove.ok && same(before, snapshot(f.base)) ? 'pass' : 'defect', install, remove, treeIdentical: same(before, snapshot(f.base)), nlink: fs.statSync(f.file).nlink };
});
record('config-symlink', 'Install and uninstall refuse a config file symlink before mutation.', () => {
  const f = fixture('config-symlink'); const target = path.join(f.base, 'external.json'); fs.writeFileSync(target, '{}');
  const blocked = linkOrBlocked(target, f.file, 'file'); if (blocked) return blocked;
  const before = snapshot(f.base), install = outcome(() => installPlan(f)), remove = outcome(() => uninstallPlan(f));
  return { verdict: !install.ok && !remove.ok && same(before, snapshot(f.base)) ? 'pass' : 'defect', install, remove, treeIdentical: same(before, snapshot(f.base)) };
});
record('config-hardlink-after-plan', 'A config hardlink introduced after planning is refused at apply.', () => {
  const f = fixture('config-hardlink-after-plan', { config: {} }), plan = installPlan(f); fs.linkSync(f.file, path.join(f.base, 'hardlink.json'));
  const before = snapshot(f.workspace), result = outcome(() => apply(plan));
  return { verdict: !result.ok && result.error === 'ZCODE_CONFIG_UNSAFE' && fs.readFileSync(f.file, 'utf8') === '{}' && leftovers(f).length === 0 ? 'pass' : 'defect', result, originalBytesPreserved: fs.readFileSync(f.file, 'utf8') === '{}', delta: delta(before, snapshot(f.workspace)), leftovers: leftovers(f) };
});
record('missing-workspace-uninstall', 'Uninstall validates the workspace even when no config exists.', () => {
  const f = fixture('missing-workspace-uninstall', { zdir: false });
  const missing = { ...f, workspace: path.join(f.base, 'missing-workspace') }, result = outcome(() => uninstallPlan(missing));
  const cliPreview = runCli(missing, 'uninstall');
  return { verdict: !result.ok && cliPreview.status !== 0 ? 'pass' : 'defect', result, cliPreview };
});
record('workspace-junction-uninstall', 'Both lifecycle planners refuse a junction workspace root; uninstall never changes the real target.', () => {
  const f = fixture('workspace-junction-uninstall'); apply(installPlan(f));
  const alias = path.join(f.base, 'workspace-alias'), blocked = linkOrBlocked(f.workspace, alias); if (blocked) return blocked;
  const linked = { ...f, workspace: alias }, before = fs.readFileSync(f.file), install = outcome(() => installPlan(linked)), remove = outcome(() => uninstallPlan(linked));
  const applied = remove.ok ? outcome(() => apply(remove.value)) : null;
  return { verdict: !install.ok && !remove.ok && before.equals(fs.readFileSync(f.file)) ? 'pass' : 'defect', install, remove, applied, realTargetBytesPreserved: before.equals(fs.readFileSync(f.file)), realTargetFinal: readConfig(f) };
});
record('zcode-junction-uninstall', 'A linked .zcode directory is refused before read/lock creation in both lifecycle planners.', () => {
  const f = fixture('zcode-junction-uninstall'); apply(installPlan(f));
  const external = path.join(f.base, 'external-zcode'); fs.renameSync(path.dirname(f.file), external);
  const blocked = linkOrBlocked(external, path.dirname(f.file)); if (blocked) return blocked;
  const before = snapshot(external), install = outcome(() => installPlan(f)), remove = outcome(() => uninstallPlan(f));
  const applied = remove.ok ? ioTrace(() => apply(remove.value)) : null;
  return { verdict: !install.ok && !remove.ok && (!applied || applied.calls.length === 0) ? 'pass' : 'defect', install, remove, applied, externalDelta: delta(before, snapshot(external)) };
});
record('ancestor-junction-install', 'A junction in any workspace ancestor is rejected before install writes.', () => {
  const f = fixture('ancestor-junction-install', { config: {} });
  const realParent = path.join(f.base, 'real-parent'); fs.mkdirSync(realParent); fs.renameSync(f.workspace, path.join(realParent, 'workspace'));
  const aliasParent = path.join(f.base, 'linked-parent'), blocked = linkOrBlocked(realParent, aliasParent); if (blocked) return blocked;
  const linked = { ...f, workspace: path.join(aliasParent, 'workspace'), file: path.join(aliasParent, 'workspace', '.zcode', 'config.json') };
  const before = snapshot(realParent), plan = outcome(() => installPlan(linked)), applied = plan.ok ? outcome(() => apply(plan.value)) : null;
  return { verdict: !plan.ok && same(before, snapshot(realParent)) ? 'pass' : 'defect', plan, applied, realTargetDelta: delta(before, snapshot(realParent)) };
});
record('workspace-swapped-after-plan', 'A workspace replaced with a junction after planning is rejected by apply.', () => {
  const f = fixture('workspace-swapped-after-plan', { config: {} }), plan = installPlan(f), old = path.join(f.base, 'parked-original'), replacement = path.join(f.base, 'external-replacement');
  fs.renameSync(f.workspace, old); fs.mkdirSync(replacement); fs.mkdirSync(path.join(replacement, '.zcode')); fs.writeFileSync(path.join(replacement, '.zcode', 'config.json'), '{}');
  const blocked = linkOrBlocked(replacement, f.workspace); if (blocked) return blocked;
  const before = snapshot(replacement), result = outcome(() => apply(plan));
  return { verdict: !result.ok && same(before, snapshot(replacement)) ? 'pass' : 'defect', result, externalDelta: delta(before, snapshot(replacement)) };
});
record('workspace-plain-replaced-after-plan', 'A new plain workspace at the same path does not inherit approval from the planned workspace.', () => {
  const f = fixture('workspace-plain-replaced-after-plan', { config: {} }), plannedIno = String(fs.statSync(f.workspace, { bigint: true }).ino), plan = installPlan(f);
  fs.renameSync(f.workspace, path.join(f.base, 'parked-original')); fs.mkdirSync(f.workspace); fs.mkdirSync(path.dirname(f.file)); fs.writeFileSync(f.file, '{}');
  const replacementIno = String(fs.statSync(f.workspace, { bigint: true }).ino), result = outcome(() => apply(plan));
  return { verdict: !result.ok && fs.readFileSync(f.file, 'utf8') === '{}' ? 'pass' : 'defect', plannedIno, replacementIno, result, final: readConfig(f) };
});
record('zcode-swapped-after-plan', 'A .zcode junction introduced after planning is refused before creating a lock in its target.', () => {
  const f = fixture('zcode-swapped-after-plan', { config: {} }), plan = installPlan(f), external = path.join(f.base, 'external-zcode');
  fs.renameSync(path.dirname(f.file), path.join(f.base, 'parked-zcode')); fs.mkdirSync(external); fs.writeFileSync(path.join(external, 'config.json'), '{}');
  const blocked = linkOrBlocked(external, path.dirname(f.file)); if (blocked) return blocked;
  const result = ioTrace(() => apply(plan));
  return { verdict: !result.outcome.ok && result.calls.length === 0 ? 'pass' : 'defect', ...result, externalConfigUnchanged: fs.readFileSync(path.join(external, 'config.json'), 'utf8') === '{}' };
});
record('zcode-swapped-at-temp-write', 'Apply revalidates the directory before committing so a late junction swap cannot redirect writes.', () => {
  const f = fixture('zcode-swapped-at-temp-write', { config: {} }), plan = installPlan(f), zdir = path.dirname(f.file), external = path.join(f.base, 'external-zcode'), parked = path.join(f.base, 'parked-zcode');
  fs.mkdirSync(external); fs.writeFileSync(path.join(external, 'config.json'), '{}');
  let injected = false;
  const result = patch('writeFileSync', (original, args) => {
    if (!injected && String(args[0]).startsWith(path.join(zdir, 'config.json.')) && String(args[0]).endsWith('.tmp')) {
      injected = true; fs.renameSync(zdir, parked); fs.symlinkSync(external, zdir, 'junction');
    }
    return original(...args);
  }, () => outcome(() => apply(plan)));
  return { verdict: !injected ? 'harness-error' : fs.readFileSync(path.join(external, 'config.json'), 'utf8') === '{}' ? 'pass' : 'defect', injected, result, externalFinal: JSON.parse(fs.readFileSync(path.join(external, 'config.json'), 'utf8')), externalEntries: fs.readdirSync(external), parkedEntries: fs.readdirSync(parked), injection: 'Deterministic fs seam swap immediately before the production temp write, after existing directory/config checks.' };
});
record('mutable-plan-content', 'The applied content remains bound to the immutable preview and plan.after.', () => {
  const f = fixture('mutable-plan-content', { config: {} }), plan = installPlan(f), declaredAfter = plan.after;
  const mutation = outcome(() => { plan.config.userInjectedAfterPreview = true; plan.config.hooks.enabled = false; });
  const result = outcome(() => apply(plan)), final = readConfig(f);
  return { verdict: !mutation.ok || !result.ok || canonical(final) === declaredAfter ? 'pass' : 'defect', planFrozen: Object.isFrozen(plan), configFrozen: Object.isFrozen(plan.config), mutation, result, final, finalMatchesDeclaredAfter: canonical(final) === declaredAfter };
});
record('plan-path-outside-workspace', 'Apply refuses a plan whose configPath is outside its workspace.', () => {
  const f = fixture('plan-path-outside-workspace', { config: {} }), plan = installPlan(f), other = path.join(f.base, 'external-config-dir'); fs.mkdirSync(other); const file = path.join(other, 'config.json'); fs.writeFileSync(file, '{}');
  const forged = { ...plan, configPath: file }, result = outcome(() => apply(forged));
  return { verdict: !result.ok && fs.readFileSync(file, 'utf8') === '{}' ? 'pass' : 'defect', result, externalConfig: JSON.parse(fs.readFileSync(file)), caveat: 'Exported API accepts a caller-supplied plan object; current CLI does not deserialize or expose arbitrary plan objects.' };
});
for (const fault of ['read-eacces', 'write-enospc-partial', 'rename-eacces']) {
  record('io-' + fault, 'Read/write/rename failures retain original config bytes and clean only this invocation\'s temporary file and lock.', () => {
    const f = fixture('io-' + fault, { config: { theme: 'retain' } }), plan = installPlan(f), before = fs.readFileSync(f.file);
    let injected = false;
    const method = fault.startsWith('read') ? 'readFileSync' : fault.startsWith('write') ? 'writeFileSync' : 'renameSync';
    const result = patch(method, (original, args) => {
      const match = method === 'readFileSync' ? args[0] === f.file : method === 'writeFileSync' ? String(args[0]).startsWith(f.file + '.') : args[1] === f.file;
      if (match && !injected) {
        injected = true;
        if (fault === 'write-enospc-partial') original(args[0], '{', args[2]);
        const error = new Error(fault === 'write-enospc-partial' ? 'ENOSPC_FIXTURE' : 'EACCES_FIXTURE'); error.code = fault === 'write-enospc-partial' ? 'ENOSPC' : 'EACCES'; throw error;
      }
      return original(...args);
    }, () => outcome(() => apply(plan)));
    return { verdict: injected && !result.ok && before.equals(fs.readFileSync(f.file)) && leftovers(f).length === 0 ? 'pass' : 'defect', injected, result, originalBytesPreserved: before.equals(fs.readFileSync(f.file)), leftovers: leftovers(f), injectedAt: method };
  });
}
record('active-lock', 'An active preexisting lock refuses without deleting the lock or touching config.', () => {
  const f = fixture('active-lock', { config: {} }), plan = installPlan(f); fs.mkdirSync(path.join(path.dirname(f.file), '.gstack861-zcode-config.lock'));
  const before = snapshot(f.workspace), result = outcome(() => apply(plan));
  return { verdict: !result.ok && result.error === 'ZCODE_CONFIG_BUSY' && same(before, snapshot(f.workspace)) ? 'pass' : 'defect', result, treeIdentical: same(before, snapshot(f.workspace)) };
});
record('cli-mismatched-policy-workspace', 'Install requires the policy workspace to match the selected target; a policy inside the selected workspace is refused.', () => {
  const f = fixture('cli-mismatched-policy-workspace', { config: {} });
  const other = path.join(f.base, 'other-workspace'); fs.mkdirSync(other);
  const internalPolicy = path.join(f.workspace, 'foreign-workspace-policy.json');
  fs.writeFileSync(internalPolicy, JSON.stringify({ schemaVersion: 1, workspace: other, readRoots: [other], writeRoots: [], protectedRoots: [], bindings: { zcode: {}, dsh: {} } }));
  const before = fs.readFileSync(f.file), preview = runCli(f, 'install', false, internalPolicy), applied = runCli(f, 'install', true, internalPolicy);
  return { verdict: preview.status !== 0 && applied.status !== 0 && before.equals(fs.readFileSync(f.file)) ? 'pass' : 'defect', preview, applied, configBytesPreserved: before.equals(fs.readFileSync(f.file)), final: readConfig(f) };
});
record('cli-invalid-config-and-internal-policy-controls', 'Real CLI install refuses invalid JSON and a policy inside its own matching workspace without config writes.', () => {
  const f = fixture('cli-invalid-config-controls', { config: '{' }), before = fs.readFileSync(f.file), invalid = runCli(f, 'install', true);
  const internalPolicy = path.join(f.workspace, 'policy.json'); fs.copyFileSync(f.policyPath, internalPolicy);
  fs.writeFileSync(f.file, '{}'); const internal = runCli(f, 'install', true, internalPolicy);
  return { verdict: invalid.status !== 0 && internal.status !== 0 && fs.readFileSync(f.file, 'utf8') === '{}' ? 'pass' : 'defect', invalid, invalidOriginalWasRetained: invalid.status !== 0 && before.toString() === '{', internal, final: readConfig(f) };
});

record('missing-uninstall-noop', 'Uninstall in a valid workspace without .zcode is a zero-write no-op in preview and apply.', () => {
  const f = fixture('missing-uninstall-noop', { zdir: false }), before = snapshot(f.workspace), preview = runCli(f, 'uninstall'), applied = runCli(f, 'uninstall', true);
  return { verdict: preview.status === 0 && applied.status === 0 && same(before, snapshot(f.workspace)) ? 'pass' : 'defect', preview, applied, treeIdentical: same(before, snapshot(f.workspace)) };
});
record('preexisting-empty-event-containers', 'Uninstall preserves a preexisting empty PreToolUse event array and events container.', () => {
  const original = { theme: 'dark', hooks: { enabled: true, events: { PreToolUse: [] } } }, f = fixture('preexisting-empty-events', { config: original });
  apply(installPlan(f)); const removed = outcome(() => apply(uninstallPlan(f))), final = readConfig(f);
  return { verdict: canonical(final) === canonical(original) ? 'pass' : 'defect', original, removed, final };
});
record('concurrent-user-edit-before-uninstall', 'Uninstall preserves new foreign settings/hooks and a user-disabled flag instead of blindly restoring the full original snapshot.', () => {
  const f = fixture('concurrent-uninstall-user-edit', { config: { theme: 'dark' } }); apply(installPlan(f));
  const current = readConfig(f); current.theme = 'light'; current.userAdded = true; current.hooks.enabled = false;
  current.hooks.events.Stop = [{ matcher: 'Write', hooks: [{ type: 'command', command: 'concurrent-foreign-hook' }] }];
  fs.writeFileSync(f.file, JSON.stringify(current)); const removed = outcome(() => apply(uninstallPlan(f))), final = readConfig(f);
  const expected = { theme: 'light', userAdded: true, hooks: { enabled: false, events: { Stop: current.hooks.events.Stop } } };
  return { verdict: removed.ok && canonical(final) === canonical(expected) ? 'pass' : 'defect', removed, final, expected };
});
record('stale-uninstall-plan', 'A semantic edit after uninstall planning is refused and new user bytes survive.', () => {
  const f = fixture('stale-uninstall-plan', { config: {} }); apply(installPlan(f)); const plan = uninstallPlan(f), changed = readConfig(f); changed.concurrentSetting = true; fs.writeFileSync(f.file, JSON.stringify(changed));
  const before = fs.readFileSync(f.file), result = outcome(() => apply(plan));
  return { verdict: !result.ok && result.error === 'ZCODE_CONFIG_CHANGED' && before.equals(fs.readFileSync(f.file)) && leftovers(f).length === 0 ? 'pass' : 'defect', result, bytesPreserved: before.equals(fs.readFileSync(f.file)), leftovers: leftovers(f) };
});
record('config-symlink-after-plan', 'A config symlink introduced after planning is refused at apply without writing its target.', () => {
  const f = fixture('config-symlink-after-plan', { config: {} }), plan = installPlan(f), external = path.join(f.base, 'external.json'); fs.renameSync(f.file, external);
  const blocked = linkOrBlocked(external, f.file, 'file'); if (blocked) return blocked;
  const result = outcome(() => apply(plan));
  return { verdict: !result.ok && result.error === 'ZCODE_CONFIG_UNSAFE' && fs.readFileSync(external, 'utf8') === '{}' && leftovers(f).length === 0 ? 'pass' : 'defect', result, targetBytesPreserved: fs.readFileSync(external, 'utf8') === '{}', leftovers: leftovers(f) };
});
record('io-mkdir-eacces', 'A directory I/O failure fails closed and is not misreported as contention.', () => {
  const f = fixture('io-mkdir-eacces', { config: {} }), plan = installPlan(f); let injected = false;
  const result = patch('mkdirSync', (original, args) => { if (String(args[0]).endsWith('.gstack861-zcode-config.lock')) { injected = true; const error = new Error('EACCES_FIXTURE'); error.code = 'EACCES'; throw error; } return original(...args); }, () => outcome(() => apply(plan)));
  return { verdict: injected && !result.ok && result.error !== 'ZCODE_CONFIG_BUSY' && fs.readFileSync(f.file, 'utf8') === '{}' ? 'pass' : 'diagnostic-defect', injected, result, configBytesPreserved: fs.readFileSync(f.file, 'utf8') === '{}' };
});
record('config-replaced-at-rename', 'A concurrent semantic edit immediately before commit is detected rather than overwritten.', () => {
  const f = fixture('config-replaced-at-rename', { config: {} }), plan = installPlan(f); let injected = false;
  const result = patch('renameSync', (original, args) => { if (args[1] === f.file && !injected) { injected = true; fs.writeFileSync(f.file, '{"concurrentUserEdit":true}'); } return original(...args); }, () => outcome(() => apply(plan)));
  const final = readConfig(f);
  return { verdict: injected && !result.ok && final.concurrentUserEdit === true ? 'pass' : 'race-exposure', injected, result, final, injection: 'Edit at the rename syscall seam after the last production config read; documents the residual optimistic-concurrency window.' };
});

const finalHashes = Object.fromEntries(targetFiles.map(p => [p, sha256(fs.readFileSync(path.join(repo, p)))]));
const report = {
  generatedAt: new Date().toISOString(), head, platform: process.platform, architecture: process.arch, osRelease: os.release(), nodeVersion: process.version,
  scope: 'Independent fixture-only ZCode lifecycle audit; no implementation/test edits; no host runtime discovery.',
  reproduction: { command: 'node reproduce.mjs <ABS_REPO> <ABS_SCRATCH> <ABS_EVIDENCE>', fixtureRoot: runRoot, fixturesRetained: true, gitConfigIsolation: true, childEnvironmentAllowlisted: true, modelRequests: 0, networkRequests: 0, userConfigReadsOrWrites: 0 },
  sourceHashesBefore: originalHashes, sourceHashesAfter: finalHashes, scopedSourceAndTestsUnchanged: same(originalHashes, finalHashes),
  totals: Object.fromEntries([...new Set(results.map(r => r.verdict))].map(k => [k, results.filter(r => r.verdict === k).length])), results,
};
fs.writeFileSync(path.join(runRoot, 'results.raw.json'), JSON.stringify(report, null, 2) + '\n');
fs.writeFileSync(path.join(runRoot, 'commands.raw.json'), JSON.stringify(commands, null, 2) + '\n');
fs.writeFileSync(path.join(evidence, 'audit-results.json'), sanitize(report) + '\n');
fs.writeFileSync(path.join(evidence, 'commands.json'), sanitize(commands) + '\n');
fs.writeFileSync(path.join(evidence, 'focused-original-tests.log'), sanitize(focused.stdout + '\nSTDERR\n' + focused.stderr));
fs.writeFileSync(path.join(evidence, 'case-index.log'), results.map(r => r.id + '\t' + r.verdict).join('\n') + '\n');
const thisScript = fileURLToPath(import.meta.url), durableScript = path.join(evidence, 'reproduce.mjs');
if (path.resolve(thisScript) !== path.resolve(durableScript)) fs.copyFileSync(thisScript, durableScript);
const manifest = fs.readdirSync(evidence).filter(n => n !== 'sha256-manifest.json').sort().map(file => ({ file, sha256: sha256(fs.readFileSync(path.join(evidence, file))) }));
fs.writeFileSync(path.join(evidence, 'sha256-manifest.json'), JSON.stringify({ head, files: manifest }, null, 2) + '\n');
process.stdout.write(JSON.stringify({ head, runRoot, evidence, totals: report.totals, scopedSourceAndTestsUnchanged: report.scopedSourceAndTestsUnchanged }, null, 2) + '\n');
if (results.some(r => r.verdict === 'harness-error')) process.exitCode = 2;
