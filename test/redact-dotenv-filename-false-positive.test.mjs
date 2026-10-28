// internal.hostname vs dotenv FILENAMES.
//
// `.env.local` ends in `.local`, so the internal-hostname pattern matches on
// `env.local` and reports a filename as a leaked internal host. This is not an
// exotic collision: `--env-file=.env.local` in an npm script, `.env.staging` in
// a README, `.env.prod` in a .gitignore. It fires on branches that leak
// nothing, and a scanner that cries wolf on package.json is a scanner people
// learn to skim past — which costs far more than the finding was ever worth.
//
// The guard has to stay narrow, so this file pins BOTH directions. The
// negative controls are the point: an exemption written as "any span ending
// .local" would pass the dotenv half while quietly gutting the pattern for
// every real host.
//
// Upstream lineage: gstack test/redact-dotenv-filename-false-positive.test.ts @
// upstream.lock.json commit 5755601dac5d35ebd7dde181fdefe52a023c73d9.
// Syntax-only adaptation bun:test → node:test; assertion values untouched.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { scan } from '../src/redact-engine.mjs';
import { isDotenvFilename } from '../src/redact-patterns.mjs';

const flagsHost = (s) =>
  scan(s, { repoVisibility: 'private' }).findings.some((f) => f.id === 'internal.hostname');

describe('internal.hostname — real internal hosts stay flagged', () => {
  const REAL_HOSTS = [
    ['.internal', 'curl http://build-7.internal/health'],
    ['.corp', 'ssh jump.corp'],
    ['.local', 'ping printer.local'],
    ['.lan', 'nas.lan is down'],
    ['.prod', 'deploy to shipping.prod now'],
    ['.staging', 'hit api.staging first'],
    ['multi-label, dotted prefix', 'host: api.corp.local'],
    ['not a dotenv file', 'myenv.local resolves'],
    ['env as a real subdomain', 'https://env.prod//status'],
  ];
  for (const [label, input] of REAL_HOSTS) {
    test(label, () => {
      assert.equal(flagsHost(input), true);
    });
  }
});

describe('internal.hostname — dotenv filenames are not hosts', () => {
  const DOTENV = [
    ['npm script', '"dev": "tsx --env-file=.env.local scripts/x.ts"'],
    ['bare filename', 'copy .env.example to .env.local'],
    ['staging', 'secrets live in .env.staging'],
    ['prod', 'never commit .env.prod'],
    ['gitignore line', '.env.local'],
    ['path prefix', 'apps/web/.env.local'],
  ];
  for (const [label, input] of DOTENV) {
    test(label, () => {
      assert.equal(flagsHost(input), false);
    });
  }
});

describe('isDotenvFilename — unit', () => {
  const matchFor = (input) => {
    const re = /\b([a-z0-9][a-z0-9\-]*\.(?:internal|corp|local|lan|prod|staging))\b/i;
    const m = re.exec(input);
    if (!m) throw new Error(`pattern did not match: ${input}`);
    return m;
  };

  test('exempts a dot-prefixed env filename', () => {
    assert.equal(isDotenvFilename(matchFor('--env-file=.env.local')), true);
  });

  test('does not exempt env.local without the leading dot', () => {
    assert.equal(isDotenvFilename(matchFor('host env.local here')), false);
  });

  test('does not exempt a dot-prefixed host that is not env', () => {
    assert.equal(isDotenvFilename(matchFor('api.corp.local')), false);
  });
});
