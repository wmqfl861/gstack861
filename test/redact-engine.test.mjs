// Unit tests for src/redact-engine.mjs + src/redact-patterns.mjs (batch 22, Lane A).
//
// Upstream lineage: gstack test/redact-engine.test.ts @ upstream.lock.json
// commit 5755601dac5d35ebd7dde181fdefe52a023c73d9. Syntax-only adaptation
// bun:test → node:test (assert values untouched); import path ../lib/redact-engine
// → ../src/redact-engine.mjs.
//
// Deliberately DROPPED vs upstream (plan 审计划必改落实 item 2): the tail
// describe "#3048: gstack-redact --from-file passes the file's path as scan
// context" spawns the real `bun bin/gstack-redact` binary — the CLI is Lane C.
// 回填于 lane C. The in-process half of #3048 (sourcePath semantics) is covered
// below in "env.kv skips TS/JSX source syntax by file context".
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  scan,
  exitCodeFor,
  maskPreview,
  normalizeWithMap,
  redactFindingSpans,
} from '../src/redact-engine.mjs';
import {
  PATTERNS,
  luhnValid,
  shannonEntropy,
  isPublicIPv4,
  isPlaceholderSpan,
  URL_PASSWORD_PLACEHOLDER_WORDS,
} from '../src/redact-patterns.mjs';

function ids(text, vis = 'private') {
  return scan(text, { repoVisibility: vis }).findings.map((f) => f.id);
}

describe('HIGH credential patterns', () => {
  const cases = [
    ['aws.access_key', 'key = AKIA1234567890ABCDEF'],
    ['aws.secret_key', 'aws_secret_access_key = AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AbCd'],
    ['github.pat', 'token ghp_' + '1234567890abcdefghijklmnopqrstuvwxyz'],
    ['github.oauth', 'gho_' + '1234567890abcdefghijklmnopqrstuvwxyz'],
    ['github.server', 'ghs_1234567890abcdefghijklmnopqrstuvwxyz'],
    ['github.fine_grained', 'github_pat_' + 'A'.repeat(82)],
    ['anthropic.key', 'sk-ant-' + 'api03-abcdefghij1234567890XYZ'],
    ['openai.key', 'sk-proj-' + 'a'.repeat(40)],
    ['sendgrid.key', 'SG.' + 'a'.repeat(22) + '.' + 'b'.repeat(43)],
    ['stripe.secret', 'sk_live_' + 'a'.repeat(30)],
    ['slack.token', 'xox' + 'b-1234567890-abcdefghijklmnop'],
    ['slack.webhook', 'https://hooks.slack.com/services/T00000000/B11111111/' + 'a'.repeat(24)],
    ['discord.webhook', 'https://discord.com/api/webhooks/123456789012345678/' + 'a'.repeat(60)],
    ['pem.private_key', '-----BEGIN RSA PRIVATE KEY-----'],
    // #1946 coverage-gap additions
    ['gitlab.token', 'remote: glpat-' + 'Ab12Cd34Ef56Gh78Ij90'],
    ['gitlab.token', 'trigger glptt-' + 'a1b2c3d4e5f6a7b8c9d0e1f2'],
    ['gitlab.token', 'deploy gldt-' + 'Zy98Xw76Vu54Ts32Rq10'],
    ['groq.key', 'gsk_' + 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AbCdEfGhIjKlMn'],
    ['tavily.key', 'tvly-' + 'AbCdEfGhIjKlMnOpQrStUvWx'],
    ['tavily.key', 'tvly-dev-' + 'AbCdEfGhIjKlMnOpQrStUvWx'],
    ['notion.token', 'ntn_' + 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AbCdEfGh'],
    ['notion.token', 'secret_' + 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AbCdEfGh'],
    ['huggingface.token', 'hf_' + 'AbCdEfGhIjKlMnOpQrStUvWxYz012345'],
    ['npm.token', 'npm_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'],
    ['digitalocean.token', 'dop_v1_' + '0123456789abcdef'.repeat(4)],
    [
      'gcp.service_account',
      '{"private_key_id": "abc123", "private_key": "-----BEGIN PRIVATE KEY-----\\nMIIE..."}',
    ],
    ['google.oauth_client_secret', 'client_secret: "GOCSPX-' + 'Ab3xQ9zLmNp2RtVw7YkD1sHf' + '"'],
    ['telegram.bot_token', 'TELEGRAM_TOKEN=8326208591:AA' + 'HdqRy9Lm2ZpXvKb4NcQw8TuEr6YoP1sVg'],
  ];
  for (const [id, text] of cases) {
    test(`flags ${id}`, () => {
      assert.ok(ids(text).includes(id), `${text} → ${id}`);
    });
  }

  // #1868 — modern OpenAI keys use base64url bodies (with - and _). The old
  // [A-Za-z0-9]{32,} regex stopped at the first separator and missed them all,
  // failing a HIGH credential OPEN through the redaction gate.
  test('openai.key flags modern sk-proj-/sk-svcacct-/sk-admin- shapes (#1868)', () => {
    const missed = [
      'sk-proj-Ab12_Cd34-Ef56Gh78Ij90Kl12Mn34Op56Qr78St90Uv',
      'sk-svcacct-abc_def-ghijklmnopqrstuvwxyz0123456789ABCDEF',
      'sk-admin-AAAA_BBBB-CCCC_DDDD-EEEE_FFFF-GGGG_HHHH1234',
    ];
    for (const key of missed) {
      assert.ok(ids(`OPENAI_API_KEY=${key}`).includes('openai.key'), key);
    }
    // legacy contiguous shape still flags
    assert.ok(ids('sk-proj-' + 'a'.repeat(40)).includes('openai.key'));
  });

  test('openai.key does not over-match prose / malformed sk- strings (#1868 calibration)', () => {
    // HIGH tier BLOCKS, so false positives on prose are costly. None of these
    // should flag as openai.key.
    const benign = [
      'the sk-learning-rate-schedule-was-tuned-carefully', // hyphenated prose
      'sk--double-dash-typo-not-a-real-key',
      'use sk-proj for the project prefix in docs', // no body
      'sk-short', // too short, no prefix
    ];
    for (const text of benign) {
      assert.ok(!ids(text).includes('openai.key'), text);
    }
  });

  test('twilio.auth_token needs an SID nearby', () => {
    const sid = 'AC' + 'a'.repeat(32);
    const tok = 'b'.repeat(32);
    assert.ok(ids(`account ${sid} token ${tok}`).includes('twilio.auth_token'));
    // bare 32-hex with no SID nearby should NOT flag as twilio
    assert.ok(!ids(`random ${tok} here`).includes('twilio.auth_token'));
  });

  test('db.url_with_password flags real password, skips placeholder/env-var', () => {
    assert.ok(ids('postgres://user:s3cretP@ss@db.example.com/app').includes('db.url_with_password'));
    assert.ok(!ids('postgres://user:${DB_PASSWORD}@host/app').includes('db.url_with_password'));
    // Literal PASSWORD placeholder (URL-format doc comments).
    assert.ok(!ids('postgresql://USER:PASSWORD@host/db').includes('db.url_with_password'));
    // JS template interpolations are code, not credentials — the
    // uppercase-only placeholder form blocked a push over
    // `postgresql://${dbUser}:${dbPass}@...` in a bash->TS port.
    assert.ok(!ids('postgresql://${dbUser}:${dbPass}@${dbHost}:5432/db').includes('db.url_with_password'));
    // Assembled at runtime so this file's own diff never contains a
    // credential-shaped literal (the prepush guard scans exact pushed bytes).
    assert.ok(ids('postgres://admin:' + 'hun' + 'ter2@db.internal/app').includes('db.url_with_password'));
    // Bare $UPPER_SNAKE is shell convention → suppressed; bare $lowercase is
    // NOT an interpolation form — a real password starting with `$` must
    // still block (both-braces-optional would have let it through).
    assert.ok(!ids('postgres://user:$DB_PASSWORD@host/app').includes('db.url_with_password'));
    assert.ok(ids('postgres://admin:$' + 'hun' + 'ter2@db.internal/app').includes('db.url_with_password'));
    // Mismatched brace is not an interpolation either (assembled at runtime
    // so this file's own pushed bytes carry no blockable URL shape).
    assert.ok(ids('postgres://admin:${' + 'dbPass@db.internal/app').includes('db.url_with_password'));
    // A fully-braced interpolation is code whatever it contains — the DSN
    // builder's `${encodeURIComponent(dbPass)}` call site must not scan as a
    // pushed secret.
    assert.ok(!ids('postgresql://user:${encodeURIComponent(dbPass)}@host:5432/db').includes('db.url_with_password'));
    // A LOWERCASE literal 'password'/'pass' at the URL-password position is a
    // real (terrible) credential, not a doc placeholder — only the ALL-CAPS
    // doc convention (USER:PASSWORD) is suppressed. Assembled at runtime so
    // this file's own bytes never carry a live credential shape.
    assert.ok(ids('postgres://admin:' + 'pass' + 'word@10.0.0.5/app').includes('db.url_with_password'));
    assert.ok(ids('https://root:' + 'pa' + 'ss@127.0.0.1/').includes('creds.basic_auth_url'));
    // Structural placeholders still suppress at the URL position.
    assert.ok(!ids('postgres://user:<your-password>@host/db').includes('db.url_with_password'));
    // An ALL-CAPS password that is NOT an exact placeholder token is a real
    // secret and must block — the pre-fix shape rule (/^[A-Z][A-Z0-9_]*$/) waved
    // every all-caps password through. Substring of a placeholder word (SECRET)
    // must not rescue it. Assembled at runtime so this file's own pushed bytes
    // carry no live DSN shape.
    assert.ok(ids('postgres://admin:' + 'PROD2026' + 'SECRET@db-prod.internal/app').includes('db.url_with_password'));
    assert.ok(ids('postgres://admin:' + 'ADMIN' + '123@host/db').includes('db.url_with_password'));
  });

  // Every curated placeholder word must suppress at the URL-password position.
  // The fix replaced a shape rule with a hand-curated EXACT set, so a typo or a
  // dropped entry (CHANGEME -> CHANGME) would silently start blocking a legit
  // doc placeholder with zero failure elsewhere. Loop the real exported set so
  // the test can't drift from the source list.
  test('db.url_with_password suppresses every curated placeholder word', () => {
    for (const word of URL_PASSWORD_PLACEHOLDER_WORDS) {
      assert.ok(!ids(`postgres://user:${word}@host/db`).includes('db.url_with_password'), word);
    }
    // Guard the set stays a non-trivial curated list (catches an accidental clear).
    assert.ok(URL_PASSWORD_PLACEHOLDER_WORDS.size >= 8);
    // And a real secret that merely CONTAINS a placeholder word still blocks.
    assert.ok(ids('postgres://user:' + 'MY' + 'SECRETPASS@host/db').includes('db.url_with_password'));
  });

  test('all HIGH patterns block (exit 3)', () => {
    const r = scan('AKIA1234567890ABCDEF', { repoVisibility: 'private' });
    assert.equal(exitCodeFor(r), 3);
  });
});

describe('MEDIUM demoted credential-shaped patterns (TENSION-1)', () => {
  test('stripe.publishable is MEDIUM not HIGH', () => {
    const f = scan('pk_live_' + 'a'.repeat(30), { repoVisibility: 'private' }).findings.find(
      (x) => x.id === 'stripe.publishable',
    );
    assert.equal(f?.tier, 'MEDIUM');
  });
  test('google.api_key is MEDIUM', () => {
    const f = scan('AIza' + 'a'.repeat(35), { repoVisibility: 'private' }).findings.find(
      (x) => x.id === 'google.api_key',
    );
    assert.equal(f?.tier, 'MEDIUM');
  });
  test('jwt is MEDIUM', () => {
    const jwt = 'eyJhbGciOiJ.eyJzdWIiOiI.' + 'x'.repeat(20);
    const f = scan(jwt, { repoVisibility: 'private' }).findings.find((x) => x.id === 'jwt');
    assert.equal(f?.tier, 'MEDIUM');
  });
  test('env.kv fires on high-entropy, skips placeholder', () => {
    assert.ok(ids('API_TOKEN=8Fk2pQ9vXz4wL7mN3rT6yB1cD5eG0hJ').includes('env.kv'));
    assert.ok(!ids('API_KEY=changeme').includes('env.kv'));
    assert.ok(!ids('API_KEY=${MY_VAR}').includes('env.kv'));
  });

  // #1946 gap 3: the uppercase-`=`-only shape made lowercase and YAML/JSON
  // colon assignments invisible — the exact config shapes people actually
  // push. Each closed detection fail-open gets a pinned case.
  test('env.kv fires on lowercase = assignment (#1946)', () => {
    assert.ok(ids('api_key=8Fk2pQ9vXz4wL7mN3rT6yB1cD5eG0hJ').includes('env.kv'));
  });
  test('env.kv fires on YAML colon assignment (#1946)', () => {
    assert.ok(ids('password: 8Fk2pQ9vXz4wL7mN3rT6yB1cD5eG0hJ').includes('env.kv'));
  });
  test('env.kv fires on quoted JSON key colon assignment (#1946)', () => {
    assert.ok(ids('"apiKey": "8Fk2pQ9vXz4wL7mN3rT6yB1cD5eG0hJ"').includes('env.kv'));
  });
  test('env.kv colon/lowercase forms stay entropy-gated and placeholder-safe', () => {
    assert.ok(!ids('password: changeme').includes('env.kv'));
    assert.ok(!ids('apiKey: YOUR_API_KEY_HERE').includes('env.kv'));
    assert.ok(!ids('api_key=${MY_VAR}').includes('env.kv'));
  });
  // T1 calibration: the zero-or-more-prefix net matched ANY identifier ending
  // in a suffix, so ordinary code (`cacheKey: <entropic id>`) hit a MEDIUM
  // confirm prompt. Name shape must be credential-semantic to count.
  test('env.kv ignores non-credential names ending in a suffix (entropic values)', () => {
    const v = '8Fk2pQ9vXz4wL7mN3rT6yB1cD5eG0hJ';
    assert.ok(!ids(`cacheKey: ${v}`).includes('env.kv'));
    assert.ok(!ids(`sortKey: ${v}`).includes('env.kv'));
    assert.ok(!ids(`partitionKey: ${v}`).includes('env.kv'));
    assert.ok(!ids(`hotkey: ${v}`).includes('env.kv'));
    assert.ok(!ids(`monkey: ${v}`).includes('env.kv'));
    assert.ok(!ids(`idempotencyKey: ${v}`).includes('env.kv'));
  });
  test('env.kv still fires on every credential-shaped name form', () => {
    const v = '8Fk2pQ9vXz4wL7mN3rT6yB1cD5eG0hJ';
    assert.ok(ids(`api_key=${v}`).includes('env.kv')); // (i) separator
    assert.ok(ids(`API_KEY=${v}`).includes('env.kv')); // (i) + ALL-CAPS
    assert.ok(ids(`x-access-key: ${v}`).includes('env.kv')); // (i) dash separator
    assert.ok(ids(`key: ${v}`).includes('env.kv')); // (ii) bare suffix
    assert.ok(ids(`APIKEY=${v}`).includes('env.kv')); // (iii) ALL-CAPS compound
    assert.ok(ids(`apiKey: ${v}`).includes('env.kv')); // (iv) credential camel
    assert.ok(ids(`authToken: ${v}`).includes('env.kv')); // (iv) credential camel
    assert.ok(ids(`clientSecret: ${v}`).includes('env.kv')); // (iv) credential camel
  });
  // #3208: a catalog entry whose whole name is a data-model word plus `_key`
  // and whose value is a lowercase identifier names a field, not a credential.
  // Either side alone is not enough: an entropic value, a longer name or a
  // credential name still fires, in every config format.
  test('env.kv skips schema field identifiers only when name and value both say so (#3208)', () => {
    const v = '8Fk2pQ9vXz4wL7mN3rT6yB1cD5eG0hJ';
    assert.ok(!ids('{\n  "input_key": "expected_media_rate_bits_per_second_ingress",\n  "unit": "bps"\n}').includes('env.kv'));
    for (const line of ['input_key: expected_media_rate_bits_per_second_ingress', '"output_key": "bits.per.second.egress"', 'cache-key: user-profile-v2', 'sort_key = created_at_desc'])
      assert.ok(!ids(line).includes('env.kv'), line);
    for (const line of [
      `input_key: ${v}`, `INPUT_KEY=${v}`, 'input_key: expectedMediaRateBitsPerSecond', 'input_key: abcdefghijkmnop',
      `cosmosdb_primary_key=${v}`, `cosmosdb_primary_key: ${v}`, `{\n  "cosmosdb_primary_key": "${v}"\n}`, `cosmosdb_primary_key = "${v}"`,
      `primary_key: ${v}`, `api_cache_key: ${v}`, 'api_key: expected_media_rate_bits_per_second_ingress', 'cosmosdb_primary_key: expected_media_rate_bits_per_second',
    ])
      assert.ok(ids(line).includes('env.kv'), line);
  });
  // #3048 — in a TS/JSX file an unquoted value after `:` is a type or an
  // expression, and a JSX brace of names is an expression. Decided by file
  // context: the same shapes in .env/YAML (or with no path) are literals.
  test('env.kv skips TS/JSX source syntax by file context, never by value shape (#3048)', () => {
    const kv = (text, sourcePath) =>
      scan(text, { repoVisibility: 'private', ...(sourcePath ? { sourcePath } : {}) }).findings.some((f) => f.id === 'env.kv');
    const v = '8Fk2pQ9vXz4wL7mN3rT6yB1cD5eG0hJ';
    const signature = 'export async function issueServerCoachItem(\n  db: Pool,\n  session: SessionState,\n  item: IssuedCoachItem,\n): Promise<void> {}';
    for (const [code, file] of [
      [signature, 'src/coach.ts'],
      ['interface Props {\n  session: SessionState;\n}', 'src/props.ts'],
      ['key={turn.requestId + turn.role + index}', 'src/Turn.tsx'],
      ['apiKey={settings.apiKey}', 'src/Settings.jsx'],
    ]) assert.deepEqual({ code, kv: kv(code, file) }, { code, kv: false });
    for (const [literal, file] of [
      ['API_KEY=VelvetRiverOrbitSunset;', '.env'],
      ['password: {RiverStoneAmberCedar}', 'config/app.yml'],
      [signature, undefined],
      ['  session: SessionState,', 'deploy/values.yaml'],
      [`session: "${v}",`, 'src/a.ts'], [`key={${v}}`, 'src/A.tsx'], [`API_KEY={${v}}`, 'src/A.tsx'],
      [`key={settings.apiKey + "${v}"}`, 'src/A.tsx'], [`key="${v}"`, 'src/A.tsx'], [`api_key: ${v}`, '.env'],
    ]) assert.deepEqual({ literal, file, kv: kv(literal, file) }, { literal, file, kv: true });
    const jwt = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', 'dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'].join('.');
    assert.ok(scan(`token: ${jwt},`, { repoVisibility: 'private', sourcePath: 'src/auth.ts' }).findings.map((f) => f.id).includes('jwt'));
  });
  // #2912 — a line that READS a secret from the environment holds no secret;
  // it must not fire (and so must not be masked or withhold a /cso source file).
  test('env.kv skips exact environment reads (#2912)', () => {
    for (const line of [
      'api_key=os.environ["AGENTOPS_API_KEY"]',
      '        api_key=os.environ["AGENTOPS_API_KEY"]',
      "LIVEKIT_API_KEY = os.getenv('LIVEKIT_API_KEY')",
      'token = os.environ.get("GH_TOKEN")',
      'API_KEY=process.env.OPENAI_API_KEY',
      'SECRET_KEY=getenv("APP_SECRET_KEY")',
    ]) {
      assert.ok(!ids(line).includes('env.kv'), line);
      assert.equal(redactFindingSpans(`x=1\n${line}\n`, {}), `x=1\n${line}\n`);
    }
  });
  test('env.kv still fires on real high-entropy keys beside or instead of an env read (#2912 negative controls)', () => {
    const v = 'Zq8vR2mN5tYb7Lc3Wd9K';
    assert.ok(ids(`SECRET_KEY = os.getenv('DJANGO_SECRET', '${v}')`).includes('env.kv'));
    assert.ok(ids(`API_KEY=process.env.OPENAI_API_KEY||"${v}"`).includes('env.kv'));
    assert.ok(ids(`API_KEY=os.environ["X"]+"${v}"`).includes('env.kv'));
    assert.ok(ids(`API_KEY=os.environ_${v}`).includes('env.kv'));
    assert.ok(ids(`API_KEY=getenv${v}`).includes('env.kv'));
    assert.ok(ids(`API_KEY="${v}"`).includes('env.kv'));
  });
  test('env.kv stays MEDIUM (calibration: generic net, not a blocker)', () => {
    const f = scan('api_key=8Fk2pQ9vXz4wL7mN3rT6yB1cD5eG0hJ', { repoVisibility: 'private' })
      .findings.find((x) => x.id === 'env.kv');
    assert.equal(f?.tier, 'MEDIUM');
  });

  // #1946 — Bearer is the most FP-prone shape in the wave: docs and examples
  // are full of "Authorization: Bearer <token>". MEDIUM + header proximity +
  // the env.kv entropy recipe keep it calibrated.
  test('auth.bearer fires on a high-entropy token in header context', () => {
    const text = "curl -H 'Authorization: Bearer 8Fk2pQ9vXz4wL7mN3rT6yB1cD5eG0hJq'";
    const f = scan(text, { repoVisibility: 'private' }).findings.find(
      (x) => x.id === 'auth.bearer',
    );
    assert.ok(f !== undefined);
    assert.equal(f?.tier, 'MEDIUM');
  });
  test('auth.bearer skips placeholders and env interpolations', () => {
    assert.ok(!ids('Authorization: Bearer YOUR_TOKEN_HERE_PLACEHOLDER').includes('auth.bearer'));
    assert.ok(!ids('Authorization: Bearer ${ACCESS_TOKEN_FROM_ENV}').includes('auth.bearer'));
  });
  test("auth.bearer requires header context (bare 'Bearer x' prose doesn't fire)", () => {
    assert.ok(!ids('the Bearer 8Fk2pQ9vXz4wL7mN3rT6yB1cD5eG0hJq walked in').includes(
      'auth.bearer',
    ));
  });
});

describe('#1946 pattern negatives (placeholders never fire)', () => {
  test('short or placeholder shapes do not trip the new HIGH patterns', () => {
    assert.ok(!ids('glpat-xxxx').includes('gitlab.token'));
    assert.ok(!ids('hf_token').includes('huggingface.token'));
    assert.ok(!ids('gsk_key').includes('groq.key'));
    assert.ok(!ids('tvly-key').includes('tavily.key'));
    assert.ok(!ids('ntn_token').includes('notion.token'));
    // `secret_` is an ordinary word; only the length makes it a credential.
    assert.ok(!ids('secret_value').includes('notion.token'));
    assert.ok(!ids('npm_install').includes('npm.token'));
    assert.ok(!ids('dop_v1_short').includes('digitalocean.token'));
    // pem header WITHOUT the GCP JSON shape stays pem.private_key only.
    assert.ok(!ids('-----BEGIN PRIVATE KEY-----').includes('gcp.service_account'));
  });
});

describe('google.oauth_client_secret / telegram.bot_token negatives', () => {
  test('undersized and placeholder shapes never fire', () => {
    // Length floor keeps short repo fixtures quiet (e.g. the 19-char body in
    // openclaw's extensions/google/oauth.test.ts).
    assert.ok(!ids('GOCSPX-FakeSecretValue123').includes('google.oauth_client_secret'));
    assert.ok(!ids('GOCSPX-short').includes('google.oauth_client_secret'));
    // Placeholder suppression on an otherwise correctly-sized body.
    assert.ok(!ids('GOCSPX-example' + 'a'.repeat(17)).includes('google.oauth_client_secret'));
    assert.ok(!ids('1234567890:AAexample' + 'a'.repeat(26)).includes('telegram.bot_token'));
    // A plain number pair must not read as a bot token.
    assert.ok(!ids('1234567890:1234567890').includes('telegram.bot_token'));
    // The AIza key stays MEDIUM (google.api_key); it is not promoted here.
    assert.ok(!ids('AIza' + 'a'.repeat(35)).includes('google.oauth_client_secret'));
  });
});

describe('PII patterns', () => {
  test('email flags + is autoRedactable', () => {
    const f = scan('ping alice@corp.io please', { repoVisibility: 'private' }).findings.find(
      (x) => x.id === 'pii.email',
    );
    assert.ok(f);
    assert.equal(f?.autoRedactable, true);
  });
  test('email allowlist: example.com, noreply, self, repo-public', () => {
    assert.ok(!ids('see user@example.com').includes('pii.email'));
    assert.ok(!ids('from noreply@github.com').includes('pii.email'));
    assert.equal(
      scan('me@garry.dev', { repoVisibility: 'private', selfEmail: 'me@garry.dev' }).findings.length,
      0,
    );
    assert.equal(
      scan('bob@acme.co', { repoVisibility: 'private', repoPublicEmails: ['bob@acme.co'] }).findings.length,
      0,
    );
  });
  // A git SSH remote's `git@host` is a transport user@host, not a person's
  // address. Suppressed by URL SHAPE rather than by allowlisting the `git`
  // local part: a bare `git@` entry would also silently hide a real address
  // at a domain that merely starts with "git".
  test('ssh git remotes are not flagged as emails', () => {
    assert.ok(!ids("set :repo_url, 'git@github.com:acme/widgets.git'").includes(
      'pii.email',
    ));
    assert.ok(!ids('git clone git@gitlab.com:acme/widgets.git').includes('pii.email'));
    assert.ok(!ids('git@bitbucket.org:acme/widgets.git').includes('pii.email'));
    assert.ok(!ids('git@ssh.dev.azure.com:v3/acme/widgets/widgets').includes('pii.email'));
    assert.ok(!ids('ssh -T git@github.com').includes('pii.email'));
    // General case: any host in <user>@<host>:<path>.git position.
    assert.ok(!ids('git@git.acme-internal.net:infra/tools.git').includes('pii.email'));
    assert.ok(!ids('ssh://git@scm.acme-internal.net/infra/tools.git').includes('pii.email'));
  });
  test('a real address is still flagged, including at a git host', () => {
    assert.ok(ids('ping alex@github.com about the issue').includes('pii.email'));
    // A domain that merely STARTS WITH "git" is not a git host — this is the
    // case a bare `git@` local-part allowlist would have wrongly suppressed.
    assert.ok(ids('contact git@gitmail.com for access').includes('pii.email'));
  });
  test('phone E.164 flags, skips compact timestamps', () => {
    assert.ok(ids('call +14155550123 now').includes('pii.phone.e164'));
    assert.ok(!ids('backup stamp 20260727202423 ran late').includes('pii.phone.e164'));
  });
  test('ssn flags valid, skips 000 octet', () => {
    assert.ok(ids('ssn 123-45-6789').includes('pii.ssn'));
    assert.ok(!ids('000-12-3456').includes('pii.ssn'));
  });
  test('credit card needs Luhn', () => {
    assert.ok(ids('card 4111111111111111').includes('pii.cc'));
    assert.ok(!ids('num 4111111111111112').includes('pii.cc'));
  });
  test('public IP flagged, RFC1918 skipped', () => {
    assert.ok(ids('connect 8.8.8.8').includes('pii.ip_public'));
    assert.ok(!ids('local 192.168.1.5').includes('pii.ip_public'));
    assert.ok(!ids('local 10.0.0.1').includes('pii.ip_public'));
  });

  // Digit-only UUIDs are the standard test-fixture shape, and their digit runs
  // collide with both the card pattern (a 13-19 digit slice passes Luhn often
  // enough to matter) and the phone pattern (hyphen groups read as national
  // formatting). Observed live: 14 of 21 MEDIUM findings on one ordinary branch
  // were exactly this, all from test files — the volume that makes people stop
  // reading MEDIUM output at all.
  test('digit-only UUID fixtures are not cards or phones', () => {
    assert.ok(!ids("owner_user_id: '00000000-0000-0000-0000-000000000000'").includes('pii.cc'));
    assert.ok(!ids("const OWNER = '11111111-1111-1111-1111-111111111111'").includes(
      'pii.phone.e164',
    ));
    assert.ok(!ids("const TEAM = '22222222-2222-2222-2222-222222222222'").includes(
      'pii.phone.e164',
    ));
    // Hex UUIDs never matched these digit patterns; pinned so the suppression
    // is not silently widened to something that swallows real numbers.
    assert.ok(!ids("id 'a1b2c3d4-1111-2222-3333-444455556666'").includes('pii.cc'));
  });

  test('UUID suppression requires TOTAL containment', () => {
    // Real card sitting next to a UUID still reports — suppression is the
    // exception and may only fire when the whole match is UUID interior.
    assert.ok(ids('00000000-0000-0000-0000-000000000000 4111111111111111').includes('pii.cc'));
    // And the plain cases are untouched.
    assert.ok(ids('card 4111-1111-1111-1111').includes('pii.cc'));
    assert.ok(ids('reach me on +1 415 555 2671').includes('pii.phone.e164'));
  });
});

describe('internal + legal patterns', () => {
  test('internal hostname', () => {
    assert.ok(ids('db1.corp internal host').includes('internal.hostname'));
  });
  test('localhost url with path', () => {
    assert.ok(ids('hit http://localhost:8080/admin/secrets').includes('internal.url_private'));
  });
  test('NDA marker', () => {
    assert.ok(ids('This is CONFIDENTIAL material').includes('legal.nda_marker'));
  });
  test('named criticism needs a capitalized full name nearby', () => {
    assert.ok(ids('John Smith is incompetent at this').includes('legal.named_criticism'));
    assert.ok(!ids('the build is incompet019ently configured'.replace('019', '')).includes(
      'legal.named_criticism',
    ));
  });
});

describe('LOW patterns surface only', () => {
  test('user path is LOW', () => {
    const f = scan('/Users/bob/secret/config', { repoVisibility: 'private' }).findings.find(
      (x) => x.id === 'internal.user_path',
    );
    assert.equal(f?.tier, 'LOW');
  });
  test('TODO marker is LOW', () => {
    const f = scan('TODO(alice) fix later', { repoVisibility: 'private' }).findings.find(
      (x) => x.id === 'hygiene.todo',
    );
    assert.equal(f?.tier, 'LOW');
  });
  test('gstack-shortcut(dec-*) debt marker survives redaction untouched', () => {
    // The shortcut ledger convention (AskUserQuestion Format / /retro Step 11.5)
    // ships in commits and PR bodies BY DESIGN — the ledger is the point. It
    // must not be caught by hygiene.todo's TODO(owner) shape or anything else.
    const marker =
      '// gstack-shortcut(dec-a1b2c3): global lock, upgrade when throughput matters';
    const result = scan(marker, { repoVisibility: 'public' });
    assert.equal(result.findings.length, 0);
  });
});

describe('placeholder suppression (per-span)', () => {
  test('AWS docs EXAMPLE key not flagged', () => {
    assert.ok(!ids('AKIAIOSFODNN7EXAMPLE').includes('aws.access_key'));
  });
  test('your_ prefix not flagged', () => {
    assert.equal(isPlaceholderSpan('your_api_key'), true);
  });
  test('a real secret on a line that ALSO contains EXAMPLE still flags', () => {
    // line-based suppression would wrongly skip this; per-span must catch it.
    assert.ok(ids('# EXAMPLE usage\nkey AKIA1234567890ABCDEF').includes('aws.access_key'));
  });
});

describe('no visibility-based tier promotion (TENSION-2-followup)', () => {
  test('email stays MEDIUM on both private and public', () => {
    const priv = scan('x@corp.io', { repoVisibility: 'private' }).findings[0];
    const pub = scan('x@corp.io', { repoVisibility: 'public' }).findings[0];
    assert.equal(priv.tier, 'MEDIUM');
    assert.equal(pub.tier, 'MEDIUM');
    assert.equal(pub.severity, 'MEDIUM'); // NOT promoted to HIGH
    assert.equal(pub.repoVisibility, 'public'); // recorded for sterner wording
  });
  test('demoted credential patterns stay MEDIUM on public', () => {
    const pub = scan('pk_live_' + 'a'.repeat(30), { repoVisibility: 'public' }).findings[0];
    assert.equal(pub.severity, 'MEDIUM');
  });
  test('unknown visibility treated as public for wording, still no promotion', () => {
    const r = scan('x@corp.io', { repoVisibility: 'unknown' });
    assert.equal(r.findings[0].severity, 'MEDIUM');
  });
});

describe('tool-attributed fence WARN-degrade (TENSION-3)', () => {
  test('placeholder-shaped credential in tool fence → WARN', () => {
    const text = '```codex-review\nfound your_aws_key AKIAIOSFODNN7EXAMPLE in code\n```';
    const r = scan(text, { repoVisibility: 'private' });
    // the EXAMPLE key is suppressed as placeholder; verify a non-credential note doesn't block
    assert.equal(r.counts.HIGH, 0);
  });
  test('live-format credential in tool fence STILL blocks', () => {
    const text = '```codex-review\nleaked AKIA1234567890ABCDEF here\n```';
    const r = scan(text, { repoVisibility: 'private' });
    assert.equal(r.counts.HIGH, 1); // not degraded — live format
  });
  test('AKIA outside any fence blocks', () => {
    assert.equal(exitCodeFor(scan('AKIA1234567890ABCDEF', {})), 3);
  });
});

describe('normalization', () => {
  test('zero-width chars inside a key are stripped before matching', () => {
    const zwsp = '​';
    const broken = 'AKIA1234567890' + zwsp + 'ABCDEF';
    assert.ok(ids(broken).includes('aws.access_key'));
  });
  test('HTML entity decode', () => {
    const { normalized } = normalizeWithMap('a &amp; b');
    assert.equal(normalized, 'a & b');
  });
  test('offset map points back into original', () => {
    const input = 'xy​z';
    const { normalized, map } = normalizeWithMap(input);
    assert.equal(normalized, 'xyz');
    // 'z' is at normalized index 2, original index 3
    assert.equal(map[2], 3);
  });
});

describe('oversize fails CLOSED', () => {
  test('input over the byte cap returns a single blocking HIGH finding', () => {
    const big = 'a'.repeat(2000);
    const r = scan(big, { maxBytes: 1000 });
    assert.equal(r.oversize, true);
    assert.equal(r.counts.HIGH, 1);
    assert.equal(r.findings[0].id, 'engine.input_too_large');
    assert.equal(exitCodeFor(r), 3);
  });

  // #1824: a malformed --max-bytes used to reach the engine as NaN. `byteLen >
  // NaN` is always false, silently disabling the fail-closed guard. The engine
  // guardrail must fall back to the default cap for any non-finite / <= 0 value.
  test('NaN maxBytes falls back to the default cap (does NOT disable the guard)', () => {
    const big = 'a'.repeat(2 * 1024 * 1024); // > 1 MiB default cap
    const r = scan(big, { maxBytes: NaN });
    assert.equal(r.oversize, true);
    assert.equal(r.findings[0].id, 'engine.input_too_large');
    assert.equal(exitCodeFor(r), 3);
  });

  test('negative / zero maxBytes falls back to the default cap', () => {
    // negative would make `byteLen > -5` always true (block everything);
    // the guardrail normalizes it to the default instead.
    const small = 'ok';
    assert.ok(!scan(small, { maxBytes: -5 }).oversize);
    assert.ok(!scan(small, { maxBytes: 0 }).oversize);
    const big = 'a'.repeat(2 * 1024 * 1024);
    assert.equal(scan(big, { maxBytes: -5 }).oversize, true);
  });
});

describe('validators', () => {
  test('luhn', () => {
    assert.equal(luhnValid('4111111111111111'), true);
    assert.equal(luhnValid('4111111111111112'), false);
  });
  test('entropy', () => {
    assert.ok(shannonEntropy('aaaaaaaa') < 1);
    assert.ok(shannonEntropy('8Fk2pQ9vXz4wL7mN') > 3);
  });
  test('isPublicIPv4', () => {
    assert.equal(isPublicIPv4('8.8.8.8'), true);
    assert.equal(isPublicIPv4('10.1.2.3'), false);
    assert.equal(isPublicIPv4('172.16.5.5'), false);
    assert.equal(isPublicIPv4('999.1.1.1'), false);
  });
});

describe('masking + purity', () => {
  test('preview never leaks more than 4 leading chars', () => {
    assert.equal(maskPreview('AKIA1234567890ABCDEF'), 'AKIA********…');
    assert.equal(maskPreview('abc'), 'abc');
  });
  test('scan is pure — same input twice yields identical findings', () => {
    const a = scan('AKIA1234567890ABCDEF x@corp.io', { repoVisibility: 'public' });
    const b = scan('AKIA1234567890ABCDEF x@corp.io', { repoVisibility: 'public' });
    assert.deepEqual(a, b);
  });
});

describe('redactFindingSpans — machine-egress masking (#1947)', () => {
  test('clean input passes through unchanged', () => {
    const text = 'push failed: remote rejected the branch';
    assert.equal(redactFindingSpans(text, { repoVisibility: 'private' }), text);
  });

  test("a single finding's span becomes <REDACTED-{id}>, context survives", () => {
    const token = 'ghp_' + '1234567890abcdefghijklmnopqrstuvwxyz';
    const out = redactFindingSpans(`auth ${token} rejected`, { repoVisibility: 'private' });
    assert.equal(out, 'auth <REDACTED-github.pat> rejected');
  });

  test('multiple findings are all replaced (right-to-left splice keeps offsets valid)', () => {
    const pat = 'ghp_' + '1234567890abcdefghijklmnopqrstuvwxyz';
    const aws = 'AKIA1234567890ABCDEF';
    const out = redactFindingSpans(`first ${aws} then ${pat} end`, {
      repoVisibility: 'private',
    });
    assert.equal(out, 'first <REDACTED-aws.access_key> then <REDACTED-github.pat> end');
  });

  test('masks an anchored env.kv value rather than withholding the whole payload', () => {
    const secret = '8Fk2pQ9vXz4wL7mN3rT6yB1cD5eG0hJq';
    const out = redactFindingSpans(`API_KEY=${secret}`, { repoVisibility: 'private' });
    assert.equal(out, 'API_KEY=<REDACTED-env.kv>');
  });

  test('line/col at boundaries: line start, after blank lines, first char, last unterminated line', () => {
    const token = 'ghp_' + '1234567890abcdefghijklmnopqrstuvwxyz';
    const at = (text) => {
      const f = scan(text, { repoVisibility: 'private' }).findings.find((x) => x.id === 'github.pat');
      assert.ok(f !== undefined);
      return [f.line, f.col];
    };
    assert.deepEqual(at(`a\nb\n${token} x`), [3, 1]);
    assert.deepEqual(at(`a\n\n\n  ${token}`), [4, 3]);
    assert.deepEqual(at(token), [1, 1]);
    assert.deepEqual(at(`one\r\ntwo ${token}`), [2, 5]);
    assert.equal(redactFindingSpans(`a\nb\n${token} x`, { repoVisibility: 'private' }), 'a\nb\n<REDACTED-github.pat> x');
  });

  test('multiline input redacts a finding past the first line (original span map)', () => {
    const token = 'ghp_' + '1234567890abcdefghijklmnopqrstuvwxyz';
    const out = redactFindingSpans(`line one\nline two has ${token}\nline three`, {
      repoVisibility: 'private',
    });
    assert.equal(out, 'line one\nline two has <REDACTED-github.pat>\nline three');
  });

  // Pre-landing review CRITICAL: pem.private_key and gcp.service_account
  // capture only the HEADER, not the key material — a span splice would
  // redact the marker and forward the key body. Marker-only patterns must
  // drop the whole payload.
  test('PEM private key → null (header-only span must not forward the key body)', () => {
    const msg =
      'deploy failed: -----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----';
    assert.equal(redactFindingSpans(msg, { repoVisibility: 'private' }), null);
  });

  test('GCP service-account JSON → null (key body follows the captured marker)', () => {
    const msg =
      'config dump: {"private_key_id": "abc123", "private_key": "-----BEGIN PRIVATE KEY-----\\nMIIEvQIBADANBg..."}';
    assert.equal(redactFindingSpans(msg, { repoVisibility: 'private' }), null);
  });

  // Pre-landing review: overlapping spans (a Bearer token that is also a
  // JWT) must coalesce — independent splices apply stale offsets and can
  // leave trailing secret bytes or mangled markers.
  test('overlapping spans (Bearer JWT fires auth.bearer + jwt) never leak and produce clean markers', () => {
    const jwt = 'eyJ' + 'a'.repeat(20) + '.eyJ' + 'b'.repeat(20) + '.' + 'c'.repeat(20);
    const out = redactFindingSpans(`Authorization: Bearer ${jwt}`, { repoVisibility: 'private' });
    assert.notEqual(out, null);
    assert.ok(!out.includes('eyJ'));
    assert.ok(!out.includes('aaaa'));
    assert.ok(!out.includes('cccc'));
    // One coalesced, well-formed marker — no truncated fragments.
    assert.match(out, /^Authorization: Bearer <REDACTED-[a-z._+]+>$/);
  });
});

describe('taxonomy integrity', () => {
  test('every pattern has a unique id', () => {
    const set = new Set(PATTERNS.map((p) => p.id));
    assert.equal(set.size, PATTERNS.length);
  });
  test('autoRedactable patterns have a redactToken', () => {
    for (const p of PATTERNS) {
      if (p.autoRedactable) assert.ok(p.redactToken, p.id);
    }
  });
});

// 回填于 lane C：上游文件尾部的 describe("#3048: gstack-redact --from-file
// passes the file's path as scan context") 用 spawnSync 真实运行
// `bun bin/gstack-redact --from-file ... --json`（spawn 真 bin），CLI 属 Lane C
// (bin/gstack861-redact.mjs + test/redact-cli.test.mjs) —— 在那里回填。
