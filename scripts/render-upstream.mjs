// CI-scoped orchestrator for reusing the pinned upstream gen:skill-docs render
// pipeline (plan batch 3, red-line relaxation R1): render zcode/dsh skill docs
// on a scratch `git archive` copy with a host overlay. The upstream worktree
// is asserted pristine before and after everything; execution is gated to
// CI=true AND GSTACK861_RENDER=ci with bun pinned to exactly 1.4.2; the render
// path itself is offline (zero npm imports, zero network, no build step).
// Node builtins only; every failure path prints an UPPER_SNAKE code.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { inventory } from '../src/inventory.mjs';
import { textDigest } from '../src/json.mjs';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

export const OVERLAY_HOSTS = ['zcode', 'dsh'];
export const EXPECTED_BUN_VERSION = '1.4.2';
export const GENERATED_BY = 'upstream gen:skill-docs @ 5755601 via CI overlay';

const IMPORT_ANCHOR = "import agy from './agy';";
// The registry is ONE literal line; derived values (HOST_CONFIG_MAP,
// ALL_HOST_NAMES, Host, HOST_PATHS) evaluate from it at module load. A .push()
// after the fact registers nothing — new hosts must be spliced into the
// literal. The full line is the anchor so upstream drift fails closed.
const REGISTRY_LINE = 'export const ALL_HOST_CONFIGS: HostConfig[] = [claude, codex, factory, kiro, opencode, slate, cursor, openclaw, hermes, gbrain, copilot, agy];';

/** AND gate: both CI=true and GSTACK861_RENDER=ci, or no execution at all. */
export function assertRenderAllowed(env = process.env) {
  if (!(env.CI === 'true' && env.GSTACK861_RENDER === 'ci')) {
    throw new Error('RENDER_NOT_ALLOWED upstream render requires CI=true AND GSTACK861_RENDER=ci');
  }
}

/** `git status --porcelain --untracked-files=normal` must be empty (same check as src/inventory.mjs). */
export function assertPristine(upstreamDir) {
  const status = spawnSync('git', ['-C', upstreamDir, 'status', '--porcelain', '--untracked-files=normal'], { encoding: 'utf8' });
  if (status.status !== 0) throw new Error(`UPSTREAM_GIT_STATUS_FAILED ${status.stderr}`);
  if (status.stdout.trim()) throw new Error(`UPSTREAM_DIRTY_RENDER ${upstreamDir} is not pristine:\n${status.stdout.trim()}`);
}

/** `bun --version` must print exactly the pinned version on every allowed path. */
export function verifyBunPin(bunPath = 'bun', { runVersion } = {}) {
  const run = runVersion ?? (p => spawnSync(p, ['--version'], { encoding: 'utf8' }));
  const result = run(bunPath);
  const version = (result.stdout ?? '').trim();
  if (result.status !== 0 || version !== EXPECTED_BUN_VERSION) {
    const got = result.status === 0 ? JSON.stringify(version) : `exit ${result.status}${result.error ? ` (${result.error.code})` : ''}`;
    throw new Error(`BUN_VERSION_PIN_VIOLATION expected exactly ${EXPECTED_BUN_VERSION}, got ${got}`);
  }
  return version;
}

/** Splice overlay hosts into <copyDir>/hosts/index.ts: import, registry literal, re-export. Fails closed on anchor drift. */
export function patchIndex(copyDir, hosts = OVERLAY_HOSTS) {
  const indexPath = path.join(copyDir, 'hosts', 'index.ts');
  let content = fs.readFileSync(indexPath, 'utf8');
  // All anchors asserted before any write: a miss means upstream drifted and
  // must surface as OVERLAY_ANCHOR_MISSING, never a silently mis-patched file.
  if (!content.includes(IMPORT_ANCHOR)) throw new Error(`OVERLAY_ANCHOR_MISSING import anchor not found: ${IMPORT_ANCHOR}`);
  if (!content.includes(REGISTRY_LINE)) throw new Error(`OVERLAY_ANCHOR_MISSING registry literal line not found: ${REGISTRY_LINE}`);
  content = content.replace(IMPORT_ANCHOR, `${IMPORT_ANCHOR}\n${hosts.map(h => `import ${h} from './${h}';`).join('\n')}`);
  content = content.replace(REGISTRY_LINE, REGISTRY_LINE.replace('= [', `= [${hosts.join(', ')}, `));
  if (!content.endsWith('\n')) content += '\n';
  content += `export { ${hosts.join(', ')} };\n`;
  fs.writeFileSync(indexPath, content);
  return indexPath;
}

/** Scratch copy of the pinned commit plus overlay hosts plus patched registry. Never writes upstreamDir. */
export function prepareCopy({ upstreamDir, commit, scratch, overlayDir = path.join(repoRoot, 'hosts-overlay'), hosts = OVERLAY_HOSTS }) {
  const tarFile = path.join(scratch, 'upstream.tar');
  const copyDir = path.join(scratch, 'copy');
  // No shell pipe: git writes the tar to a file, tar extracts it — both binaries exist in Git Bash and on CI runners.
  const archive = spawnSync('git', ['-C', upstreamDir, 'archive', '--format=tar', '-o', tarFile, commit], { encoding: 'utf8' });
  if (archive.status !== 0) throw new Error(`PREPARE_COPY_FAILED git archive ${commit}: ${archive.stderr}`);
  fs.mkdirSync(copyDir, { recursive: true });
  // Relative paths + cwd: GNU tar would read an absolute `C:\...` argument as a
  // remote-host spec; relative names work identically on GNU tar, bsdtar and CI.
  // MSYS=winsymlinks:nativestrict lets Git Bash tar materialize the upstream tree's
  // symlinks on the Windows maintainer channel (CI's GNU tar needs no help and
  // ignores the variable).
  const extract = spawnSync('tar', ['-xf', 'upstream.tar', '-C', 'copy'],
    { cwd: scratch, encoding: 'utf8', env: { ...process.env, MSYS: 'winsymlinks:nativestrict' } });
  if (extract.status !== 0) throw new Error(`PREPARE_COPY_FAILED tar extract: ${extract.stderr}`);
  for (const host of hosts) {
    const source = path.join(overlayDir, `${host}.ts`);
    if (!fs.existsSync(source)) throw new Error(`PREPARE_COPY_FAILED overlay host missing: ${source}`);
    fs.copyFileSync(source, path.join(copyDir, 'hosts', `${host}.ts`)); // `./define-host` import resolves in place
  }
  patchIndex(copyDir, hosts);
  return copyDir;
}

/** Run the upstream renderer for one host on the copy. Non-zero exit carries the real output.
 * Executes the script directly (its own shebang form): `bun run <file>` silently no-ops
 * with exit 0 when spawned from Node on Windows — observed in the batch-3 CI first run. */
export function runRender({ copyDir, outDir, host, bunPath = 'bun', spawnImpl = spawnSync }) {
  const render = spawnImpl(bunPath, ['scripts/gen-skill-docs.ts', '--host', host, '--out-dir', outDir],
    { cwd: copyDir, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (render.status !== 0) {
    throw new Error(`RENDER_FAILED bun --host ${host} exited ${render.status}\n${(render.stdout ?? '')}${(render.stderr ?? '')}`);
  }
  return { stdout: render.stdout, stderr: render.stderr };
}

function walkFiles(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(full));
    else if (entry.isFile()) files.push(full);
  }
  return files;
}

// Inventory name -> rendered dir, exactly as the upstream renderer names it
// (gen-skill-docs.ts): already-prefixed names pass through (`gstack-upgrade`
// renders as dir `gstack-upgrade`), everything else gets `gstack-` prepended.
function renderedDir(name) {
  return name.startsWith('gstack-') ? name : `gstack-${name}`;
}

/** Post-render gate: banner/placeholder/undefined checks, inventory set equality, root router, then manifest. */
export function verifyOutput({ outDir, host, inventoryJson, manifestDir }) {
  const skillsRoot = path.join(outDir, `.${host}`, 'skills'); // hostSubdir default `.{name}` from defineHost()
  const rel = file => path.relative(outDir, file).split(path.sep).join('/');
  if (!fs.existsSync(skillsRoot)) throw new Error(`RENDER_INCOMPLETE ${rel(skillsRoot)} does not exist`);

  // Root router renders as dir `gstack` (no hyphen), invisible to gstack-* globs — asserted explicitly.
  const rootSkill = path.join(skillsRoot, 'gstack', 'SKILL.md');
  if (!fs.existsSync(rootSkill)) throw new Error(`RENDER_ROOT_MISSING ${rel(rootSkill)}`);

  const expected = inventoryJson.skills.map(s => s.name);
  // Compare in rendered-dir space: the renderer keeps already-prefixed
  // inventory names as-is, so de-prefixing dir names here would corrupt the
  // comparison (`gstack-upgrade` -> phantom missing/extra pair).
  const expectedDirs = expected.map(renderedDir);
  const renderedDirs = fs.readdirSync(skillsRoot, { withFileTypes: true })
    .filter(e => e.isDirectory() && e.name.startsWith('gstack-'))
    .map(e => e.name);
  const missing = expectedDirs.filter(dir => !renderedDirs.includes(dir));
  const extra = renderedDirs.filter(dir => !expectedDirs.includes(dir));
  if (missing.length || extra.length) {
    throw new Error(`RENDER_INCOMPLETE expected ${expectedDirs.length} skills, rendered ${renderedDirs.length} (missing=[${missing.join(',')}] extra=[${extra.join(',')}])`);
  }

  for (const file of walkFiles(skillsRoot)) {
    const text = fs.readFileSync(file, 'utf8');
    if (!text.includes('AUTO-GENERATED')) throw new Error(`RENDER_VERIFY_FAILED ${rel(file)}: missing AUTO-GENERATED banner`);
    // No whole-word "undefined" guard: upstream's own claude renders legitimately contain
    // prose uses (e.g. gstack-autoplan's example "returns undefined when the session cookie
    // expires"); template-value gaps surface as fatal leftover placeholders upstream-side.
    if (/\{\{[^}]*\}\}/.test(text)) throw new Error(`RENDER_VERIFY_FAILED ${rel(file)}: unresolved {{...}} placeholder`);
  }

  const skills = {};
  for (const name of [...expected].sort()) {
    const file = path.join(skillsRoot, renderedDir(name), 'SKILL.md');
    if (!fs.existsSync(file)) throw new Error(`RENDER_VERIFY_FAILED ${rel(file)}: missing`);
    skills[name] = textDigest(fs.readFileSync(file, 'utf8'));
  }
  const manifest = {
    schemaVersion: 1, host, generatedBy: GENERATED_BY, status: 'rendered-experimental',
    skills,
    root: { path: 'gstack/SKILL.md', sha256: textDigest(fs.readFileSync(rootSkill, 'utf8')) },
  };
  fs.mkdirSync(manifestDir, { recursive: true });
  fs.writeFileSync(path.join(manifestDir, `render-manifest-${host}.json`), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

function parseArgs(argv) {
  const args = { bun: 'bun', upstream: null, out: null, manifestDir: null };
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i], value = argv[i + 1];
    if ((key === '--upstream' || key === '--out' || key === '--manifest-dir' || key === '--bun') && value) args[key.slice(2)] = value;
    else throw new Error(`USAGE render-upstream.mjs --upstream <dir> --out <dir> [--manifest-dir <dir>] [--bun <path>] (bad token: ${key})`);
  }
  if (!args.upstream || !args.out) throw new Error('USAGE render-upstream.mjs requires --upstream <dir> and --out <dir>');
  return args;
}

function main() {
  let failure = null;
  try {
    assertRenderAllowed(); // first: zero side effects on refusal
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  let upstreamDir, outDir, manifestDir, scratchDir = null;
  try {
    const args = parseArgs(process.argv.slice(2));
    upstreamDir = path.resolve(args.upstream);
    outDir = path.resolve(args.out);
    manifestDir = path.resolve(args.manifestDir ?? path.join(path.dirname(outDir), 'render-manifests'));
    assertPristine(upstreamDir); // before everything
    const commit = JSON.parse(fs.readFileSync(path.join(repoRoot, 'upstream.lock.json'), 'utf8')).gstack.commit;
    verifyBunPin(args.bun);
    scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack861-render-'));
    const copyDir = prepareCopy({ upstreamDir, commit, scratch: scratchDir, hosts: OVERLAY_HOSTS });
    const inventoryJson = inventory(upstreamDir, commit); // runs against the pristine pinned submodule
    fs.mkdirSync(outDir, { recursive: true });
    for (const host of OVERLAY_HOSTS) {
      runRender({ copyDir, outDir, host, bunPath: args.bun });
      const manifest = verifyOutput({ outDir, host, inventoryJson, manifestDir });
      console.log(`rendered ${host}: ${Object.keys(manifest.skills).length} skills + root router (${manifest.status}) -> ${path.join(manifestDir, `render-manifest-${host}.json`)}`);
    }
    console.log(`render complete: ${OVERLAY_HOSTS.join(', ')} -> ${outDir}`);
  } catch (e) {
    failure = e;
    console.error(e.message);
  } finally {
    if (scratchDir) fs.rmSync(scratchDir, { recursive: true, force: true });
    if (upstreamDir) {
      try {
        assertPristine(upstreamDir); // after everything, even on failure
      } catch (e) {
        failure = failure ?? e;
        console.error(e.message);
      }
    }
  }
  if (failure) process.exit(1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
