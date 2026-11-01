import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const LOGS = ['ci-check.log', 'ci-test.log', 'ci-verify-offline.log', 'ci-doctor.log', 'ci-inventory.log'];
const METADATA = 'ci-metadata.json';
const PAYLOAD_LIMIT = 6000;
const BLOCK_LIMIT = 20;
const errorCode = error => /^[A-Z][A-Z0-9_]*$/.test(error?.code) ? error.code : 'DIAGNOSTIC_IO_ERROR';
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino && b.isFile() && !b.isSymbolicLink() && b.nlink === 1n;
const fields = stat => Object.fromEntries(['dev', 'ino', 'nlink', 'mode', 'size'].map(key => [key, String(stat[key])]));

function fixedPath(repo, name, allowed) {
  if (typeof repo !== 'string' || !path.isAbsolute(repo) || !allowed.includes(name)) throw new Error('INVALID_DIAGNOSTIC_PATH');
  return path.join(repo, name);
}

function annotation(level, text) {
  const escaped = value => value.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
  const suffix = ' [truncated; see complete CI log artifact]';
  let payload = '', truncated = false;
  for (const char of String(text)) {
    const next = escaped(char);
    if (payload.length + next.length > PAYLOAD_LIMIT - suffix.length) { truncated = true; break; }
    payload += next;
  }
  return `::${level}::${payload}${truncated ? suffix : ''}`;
}

function observe(filename, name) {
  const observation = { name };
  let fd;
  try {
    const stat = fs.lstatSync(filename, { bigint: true });
    observation.lstat = fields(stat);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) throw new Error('UNSAFE_PROBE');
    fd = fs.openSync(filename, 'r');
    observation.fstat = fields(fs.fstatSync(fd, { bigint: true }));
    observation.stat = fields(fs.statSync(filename, { bigint: true }));
    observation.numberInode = String(fs.statSync(filename).ino);
    observation.numberInodeSafe = Number.isSafeInteger(fs.statSync(filename).ino);
  } catch (error) { observation.error = errorCode(error); }
  finally { if (fd !== undefined) fs.closeSync(fd); }
  return observation;
}

/** Observe only the committed helper and an exclusively created local probe. */
export function collectCiMetadata({ repo, output = METADATA }) {
  const destination = fixedPath(repo, output, [METADATA]);
  const metadata = { schemaVersion: 1, node: process.versions.node, versions: { ...process.versions },
    platform: process.platform, arch: process.arch, head: null, observations: [], cleanup: {} };
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull, GIT_TERMINAL_PROMPT: '0' };
  for (const name of Object.keys(env)) if (/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(name)) delete env[name];
  const git = spawnSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { env, encoding: 'utf8', timeout: 10000 });
  if (git.status === 0 && /^[a-f0-9]{40}$/.test(git.stdout.trim())) metadata.head = git.stdout.trim();
  else metadata.gitError = git.error ? errorCode(git.error) : 'GIT_HEAD_UNAVAILABLE';
  metadata.observations.push(observe(path.join(repo, 'src/fs-utils.mjs'), 'source-file'));
  let directory, directoryIdentity, filename, fileIdentity;
  const contents = Buffer.from('ci metadata probe\n');
  try {
    directory = fs.mkdtempSync(path.join(repo, '.gstack861-ci-probe-'));
    directoryIdentity = fs.lstatSync(directory, { bigint: true });
    filename = path.join(directory, 'probe.txt');
    const fd = fs.openSync(filename, 'wx', 0o600);
    try { fs.writeFileSync(fd, contents); } finally { fs.closeSync(fd); }
    fileIdentity = fs.lstatSync(filename, { bigint: true });
    metadata.observations.push(observe(filename, 'created-file'));
    metadata.directory = fields(directoryIdentity);
  } catch (error) { metadata.probeError = errorCode(error); }
  finally {
    if (filename && fileIdentity) {
      try {
        const current = fs.lstatSync(filename, { bigint: true });
        if (sameFile(fileIdentity, current) && fs.readFileSync(filename).equals(contents)) {
          fs.unlinkSync(filename); metadata.cleanup.file = 'removed';
        } else metadata.cleanup.file = 'preserved-unproven';
      } catch (error) { metadata.cleanup.file = errorCode(error); }
    }
    if (directory && directoryIdentity) {
      try {
        const current = fs.lstatSync(directory, { bigint: true });
        if (current.isDirectory() && !current.isSymbolicLink() && current.dev === directoryIdentity.dev && current.ino === directoryIdentity.ino) {
          fs.rmdirSync(directory); metadata.cleanup.directory = 'removed';
        } else metadata.cleanup.directory = 'preserved-unproven';
      } catch (error) { metadata.cleanup.directory = errorCode(error); }
    }
  }
  fs.writeFileSync(destination, JSON.stringify(metadata, null, 2) + '\n', { flag: 'wx' });
  return metadata;
}

function failureBlocks(text) {
  const lines = text.split('\n');
  const details = lines.findIndex(line => /^\s*✖ failing tests:/.test(line));
  const selected = details === -1 ? lines : lines.slice(details + 1);
  const starts = [];
  for (let index = 0; index < selected.length; index++) {
    if (/^\s*not ok \d+\b/.test(selected[index]) || /^\s*✖ (?!failing tests:)/.test(selected[index])) starts.push(index);
  }
  return starts.map((start, index) => {
    let end = starts[index + 1] ?? selected.length;
    for (let next = start + 1; next < end; next++) {
      if (/^\s*(?:ok \d+\b|# Subtest:|✔ |ℹ |test at )/.test(selected[next])) { end = next; break; }
    }
    return selected.slice(start, end).join('\n').trimEnd();
  });
}

/** Report failure evidence only; the original CI command retains its own status. */
export function reportCiDiagnostics({ repo, logFiles = LOGS, emit = console.log }) {
  const blocks = [], unavailable = [];
  for (const name of logFiles) {
    const filename = fixedPath(repo, name, LOGS);
    try {
      const stat = fs.lstatSync(filename);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 64 * 1024 * 1024) throw new Error('UNSAFE_LOG');
      const text = fs.readFileSync(filename, 'utf8');
      const failures = failureBlocks(text);
      if (failures.length) blocks.push(...failures.map(text => ({ name, text })));
      else if (text.trim()) unavailable.push({ name, text: text.slice(-4000) });
      else unavailable.push({ name, text: 'empty log' });
    } catch (error) { unavailable.push({ name, text: errorCode(error) }); }
  }
  for (const block of blocks.slice(0, BLOCK_LIMIT)) emit(annotation('error', `${block.name}: ${block.text}`));
  if (blocks.length > BLOCK_LIMIT) emit(annotation('notice', `${blocks.length - BLOCK_LIMIT} additional failure blocks omitted; see complete CI logs.`));
  if (!blocks.length) emit(annotation('error', 'CI diagnostic unavailable: no recognized failing test block. ' + unavailable.map(item => `${item.name}: ${item.text}`).join('\n')));
  else for (const item of unavailable) emit(annotation('notice', `CI diagnostic unavailable for ${item.name}: no recognized failing test block; see complete logs.`));
  try {
    const filename = fixedPath(repo, METADATA, [METADATA]), stat = fs.lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 1024 * 1024) throw new Error('UNSAFE_METADATA');
    const metadata = JSON.parse(fs.readFileSync(filename, 'utf8'));
    emit(annotation('notice', 'CI native metadata: ' + JSON.stringify({ node: metadata.node, platform: metadata.platform,
      observations: metadata.observations, directory: metadata.directory, cleanup: metadata.cleanup })));
  } catch { emit(annotation('notice', 'CI native metadata unavailable; see diagnostic artifact.')); }
  return { failureCount: blocks.length, emittedFailures: Math.min(blocks.length, BLOCK_LIMIT) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const repo = fileURLToPath(new URL('../', import.meta.url));
  try {
    if (process.argv.length !== 3 || !['metadata', 'report'].includes(process.argv[2])) throw new Error('INVALID_ARGUMENTS');
    if (process.argv[2] === 'metadata') collectCiMetadata({ repo });
    else reportCiDiagnostics({ repo });
  } catch (error) { console.error(errorCode(error)); process.exitCode = 1; }
}
