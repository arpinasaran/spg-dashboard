const test = require('node:test');
const assert = require('node:assert');
const oauth = require('../lib/oauthClient');

/* This identity exists for exactly one reason — a service account cannot create a Drive file
   because it has no storage quota — and it is switched on purely by the presence of three
   environment variables. That makes the detection worth pinning: a half-configured
   deployment must count as not configured, because the alternative is an instance that
   believes it can create files, tries, and fails on somebody's clock-in instead of at boot. */

const FULL = {
  GOOGLE_OAUTH_CLIENT_ID: '123.apps.googleusercontent.com',
  GOOGLE_OAUTH_CLIENT_SECRET: 'secret',
  GOOGLE_OAUTH_REFRESH_TOKEN: '1//refresh',
};

test('all three variables together mean configured', () => {
  assert.equal(oauth.configured(FULL), true);
});

test('any one missing means not configured', () => {
  for (const key of Object.keys(FULL)) {
    const partial = { ...FULL };
    delete partial[key];
    assert.equal(oauth.configured(partial), false, `should be false without ${key}`);
  }
});

test('an empty value counts as missing, not as present', () => {
  // `vercel env pull` writes empty strings for variables it cannot hand back, and an empty
  // client id is not credentials.
  for (const key of Object.keys(FULL)) {
    assert.equal(oauth.configured({ ...FULL, [key]: '' }), false, `should be false when ${key} is empty`);
  }
});

test('a plain environment is not configured', () => {
  assert.equal(oauth.configured({}), false);
});

test('asking for a client without credentials names the fix', () => {
  const saved = { ...process.env };
  for (const key of Object.keys(FULL)) delete process.env[key];
  oauth.resetForTests();

  try {
    assert.throws(() => oauth.drive(), /oauth-setup/);
  } finally {
    Object.assign(process.env, saved);
    oauth.resetForTests();
  }
});
