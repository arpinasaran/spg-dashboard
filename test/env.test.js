const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const env = require('../lib/env');

/* The file this parses holds a service-account private key. Getting a byte of it wrong does
   not fail here — it fails later, inside Google's auth library, as an opaque error about an
   invalid grant. So the shapes `vercel env pull` and a human paste actually produce are
   pinned down here instead. */

test('reads the shape `vercel env pull` writes', () => {
  const out = env.parse([
    'GOOGLE_SERVICE_ACCOUNT_EMAIL="spg-dashboard@peaceful-app-507610-u3.iam.gserviceaccount.com"',
    'GOOGLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\\nMIIEv\\n-----END PRIVATE KEY-----\\n"',
    'AUTH_MODE="spg"',
  ].join('\n'));

  assert.equal(out.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    'spg-dashboard@peaceful-app-507610-u3.iam.gserviceaccount.com');
  assert.equal(out.AUTH_MODE, 'spg');
  // The \n stay escaped. lib/googleClient.js unescapes them; doing it twice here would be
  // the kind of quiet corruption that only shows up as a failed login.
  assert.equal(out.GOOGLE_PRIVATE_KEY,
    '-----BEGIN PRIVATE KEY-----\\nMIIEv\\n-----END PRIVATE KEY-----\\n');
});

// Pasting a key by hand keeps its real newlines, and a line-by-line parser would keep only
// the first line — leaving a value that looks present and is unusable.
test('a quoted value may span lines', () => {
  const key = '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADAN\nBgkqhkiG9w0\n-----END PRIVATE KEY-----\n';
  const out = env.parse(`GOOGLE_PRIVATE_KEY="${key}"\nAUTH_MODE=spg\n`);
  assert.equal(out.GOOGLE_PRIVATE_KEY, key);
  assert.equal(out.AUTH_MODE, 'spg'); // parsing resumed after the multi-line value
});

test('comments, blanks and `export` are tolerated', () => {
  const out = env.parse([
    '# kredensial service account',
    '',
    'export AUTH_MODE=spg',
    'ADMIN_OPS_IDS=OS212341,OS998877   # supervisor',
    "SESSION_SECRET='a1b2c3'",
    'EMPTY=',
  ].join('\n'));

  assert.equal(out.AUTH_MODE, 'spg');
  assert.equal(out.ADMIN_OPS_IDS, 'OS212341,OS998877');
  assert.equal(out.SESSION_SECRET, 'a1b2c3');
  assert.equal(out.EMPTY, '');
  // Four assignments in, four out: the comment and the blank line produced no keys.
  assert.deepEqual(Object.keys(out), ['AUTH_MODE', 'ADMIN_OPS_IDS', 'SESSION_SECRET', 'EMPTY']);
});

// A # inside a quoted secret is part of the secret. Trimming it would truncate the value.
test('a hash inside quotes is data, not a comment', () => {
  const out = env.parse('SESSION_SECRET="abc#def"');
  assert.equal(out.SESSION_SECRET, 'abc#def');
});

test('a missing .env is silence, not a crash', () => {
  const result = env.load(path.join(os.tmpdir(), 'definitely-not-here-' + Date.now(), '.env'));
  assert.deepEqual(result.applied, []);
});

/* The rule that matters most: scripts/sync-snapshot.js sets SHEETS_DRIVER itself, and a
   leftover line in .env must not be able to redirect the snapshot read to the wrong client. */
test('a variable already set is never overwritten', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-test-'));
  const file = path.join(dir, '.env');
  fs.writeFileSync(file, 'SHEETS_DRIVER=google\nRUTE_TEST_FRESH=from-file\n');

  process.env.SHEETS_DRIVER = 'gws';
  delete process.env.RUTE_TEST_FRESH;
  try {
    const { applied } = env.load(file);
    assert.equal(process.env.SHEETS_DRIVER, 'gws');
    assert.equal(process.env.RUTE_TEST_FRESH, 'from-file');
    assert.deepEqual(applied, ['RUTE_TEST_FRESH']);
  } finally {
    delete process.env.SHEETS_DRIVER;
    delete process.env.RUTE_TEST_FRESH;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
