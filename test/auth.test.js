const test = require('node:test');
const assert = require('node:assert');
const auth = require('../lib/auth');

function withPassword(pw, secret, fn) {
  const before = { pw: process.env.APP_PASSWORD, secret: process.env.SESSION_SECRET };
  process.env.APP_PASSWORD = pw;
  if (secret === undefined) delete process.env.SESSION_SECRET;
  else process.env.SESSION_SECRET = secret;
  try {
    return fn();
  } finally {
    if (before.pw === undefined) delete process.env.APP_PASSWORD;
    else process.env.APP_PASSWORD = before.pw;
    if (before.secret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = before.secret;
  }
}

// Without this, adding the gate would have made every laptop checkout ask for a password
// nobody had set.
test('the gate is off until a password is configured', () => {
  withPassword('', undefined, () => assert.equal(auth.enabled(), false));
  withPassword('rahasia', undefined, () => assert.equal(auth.enabled(), true));
});

test('a freshly issued cookie verifies', () => {
  withPassword('rahasia', undefined, () => {
    assert.equal(auth.verify(auth.issue()), true);
  });
});

test('a cookie stops verifying once it expires', () => {
  withPassword('rahasia', undefined, () => {
    const now = Date.now();
    const token = auth.issue(now);
    assert.equal(auth.verify(token, now + auth.MAX_AGE_MS - 1000), true);
    assert.equal(auth.verify(token, now + auth.MAX_AGE_MS + 1000), false);
  });
});

/* The expiry sits in the cookie in plain sight, so the signature is the only thing stopping
   a visitor from typing themselves a longer session — or any session at all. */
test('an expiry edited by hand is refused', () => {
  withPassword('rahasia', undefined, () => {
    const token = auth.issue();
    const forged = `${Date.now() + 10 * auth.MAX_AGE_MS}.${token.split('.')[1]}`;
    assert.equal(auth.verify(forged), false);
  });
});

test('garbage and empty cookies are refused without throwing', () => {
  withPassword('rahasia', undefined, () => {
    for (const bad of ['', null, undefined, 'x', '.', 'abc.def', '123', '123.', 'notanumber.sig']) {
      assert.equal(auth.verify(bad), false, `should refuse ${JSON.stringify(bad)}`);
    }
  });
});

test('a cookie signed with a different secret is refused', () => {
  const token = withPassword('rahasia', 'secret-one', () => auth.issue());
  withPassword('rahasia', 'secret-two', () => assert.equal(auth.verify(token), false));
});

// Rotating the password should not invalidate sessions when a separate secret is set — and
// must invalidate them when it is not, because then the password *is* the secret.
test('a separate SESSION_SECRET survives a password change', () => {
  const token = withPassword('lama', 'tetap', () => auth.issue());
  withPassword('baru', 'tetap', () => assert.equal(auth.verify(token), true));

  const tied = withPassword('lama', undefined, () => auth.issue());
  withPassword('baru', undefined, () => assert.equal(auth.verify(tied), false));
});

test('only the exact password is accepted', () => {
  withPassword('rahasia', undefined, () => {
    assert.equal(auth.passwordMatches('rahasia'), true);
    assert.equal(auth.passwordMatches('rahasi'), false);
    assert.equal(auth.passwordMatches('rahasiaa'), false);
    assert.equal(auth.passwordMatches('RAHASIA'), false);
    assert.equal(auth.passwordMatches(''), false);
    assert.equal(auth.passwordMatches(null), false);
  });
});

// An unset password must never turn into "any empty guess gets in".
test('an empty password matches nothing, even an empty guess', () => {
  withPassword('', undefined, () => {
    assert.equal(auth.passwordMatches(''), false);
    assert.equal(auth.passwordMatches(null), false);
  });
});

test('cookies are parsed out of a real header', () => {
  const got = auth.parseCookies('a=1; rh_session=123.abc; b=hello%20world');
  assert.equal(got.rh_session, '123.abc');
  assert.equal(got.b, 'hello world');
  assert.deepEqual(auth.parseCookies(undefined), {});
});

test('the cookie is hardened, and only marked Secure over https', () => {
  const secure = auth.cookieHeader('t', { secure: true });
  assert.match(secure, /HttpOnly/);
  assert.match(secure, /SameSite=Lax/);
  assert.match(secure, /Secure/);
  // Localhost is plain http; a Secure cookie there would simply never be stored.
  assert.doesNotMatch(auth.cookieHeader('t', { secure: false }), /Secure/);
});
