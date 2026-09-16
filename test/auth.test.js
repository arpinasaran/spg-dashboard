const test = require('node:test');
const assert = require('node:assert');
const auth = require('../lib/auth');

function withEnv(env, fn) {
  const before = {};
  for (const k of Object.keys(env)) before[k] = process.env[k];
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const SIGNED_IN = { AUTH_MODE: 'spg', SESSION_SECRET: 'rahasia-uji' };

// Without this, adding login would have made every laptop checkout ask for a password nobody
// had set — and `npm start` is how this app is developed.
test('login is off unless AUTH_MODE says otherwise', () => {
  withEnv({ AUTH_MODE: undefined }, () => assert.equal(auth.enabled(), false));
  withEnv({ AUTH_MODE: 'off' }, () => assert.equal(auth.enabled(), false));
  withEnv({ AUTH_MODE: 'spg' }, () => assert.equal(auth.enabled(), true));
});

test('a cookie carries the OpsID it was issued for', () => {
  withEnv(SIGNED_IN, () => {
    assert.equal(auth.verify(auth.issue('OS212341')), 'OS212341');
    assert.equal(auth.verify(auth.issue('OS999999')), 'OS999999');
  });
});

test('issuing without an OpsID is a programming error, not an anonymous session', () => {
  withEnv(SIGNED_IN, () => {
    assert.throws(() => auth.issue(''), /OpsID/);
    assert.throws(() => auth.issue(null), /OpsID/);
  });
});

test('a cookie stops verifying once it expires', () => {
  withEnv(SIGNED_IN, () => {
    const now = Date.now();
    const token = auth.issue('OS212341', now);
    assert.equal(auth.verify(token, now + auth.MAX_AGE_MS - 1000), 'OS212341');
    assert.equal(auth.verify(token, now + auth.MAX_AGE_MS + 1000), null);
  });
});

/* The whole point of signing. The OpsID sits in the cookie in readable form — it is not a
   secret — so the signature is the only thing stopping someone editing it to a colleague's
   and clocking in as them. */
test('an OpsID swapped by hand is refused', () => {
  withEnv(SIGNED_IN, () => {
    const mine = auth.issue('OS212341');
    const [, expiresAt, mac] = mine.split('.');
    const theirs = Buffer.from('OS999999').toString('base64url');
    assert.equal(auth.verify(`${theirs}.${expiresAt}.${mac}`), null);
  });
});

test('an expiry edited by hand is refused', () => {
  withEnv(SIGNED_IN, () => {
    const [id, , mac] = auth.issue('OS212341').split('.');
    assert.equal(auth.verify(`${id}.${Date.now() + 10 * auth.MAX_AGE_MS}.${mac}`), null);
  });
});

test('garbage cookies are refused without throwing', () => {
  withEnv(SIGNED_IN, () => {
    for (const bad of ['', null, undefined, 'x', '..', 'a.b', 'a.b.c.d', 'a.notanumber.c']) {
      assert.equal(auth.verify(bad), null, `should refuse ${JSON.stringify(bad)}`);
    }
  });
});

test('a cookie signed with a different secret is refused', () => {
  const token = withEnv({ ...SIGNED_IN, SESSION_SECRET: 'satu' }, () => auth.issue('OS212341'));
  withEnv({ ...SIGNED_IN, SESSION_SECRET: 'dua' }, () => assert.equal(auth.verify(token), null));
});

test('cookies are parsed out of a real header', () => {
  const got = auth.parseCookies('a=1; rh_session=T1MyMTIzNDE.123.abc; b=hello%20world');
  assert.equal(got.rh_session, 'T1MyMTIzNDE.123.abc');
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

// A signing key that silently defaults would produce cookies anyone could forge once they
// guessed the default. Better to refuse to start.
test('a deployment without SESSION_SECRET cannot mint sessions', () => {
  withEnv({ AUTH_MODE: 'spg', SESSION_SECRET: undefined }, () => {
    assert.throws(() => auth.issue('OS212341'), /SESSION_SECRET/);
    assert.equal(auth.sessionOpsId({ headers: { cookie: 'rh_session=a.1.b' } }), null);
  });
});
