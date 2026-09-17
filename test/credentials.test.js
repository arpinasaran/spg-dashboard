const test = require('node:test');
const assert = require('node:assert');
const credentials = require('../lib/credentials');

/* Hashing only. The sheet-backed half (authenticate/setPassword/list) talks to the Attendance
   spreadsheet and is exercised by scripts/set-password.js against the real thing; what is
   worth pinning down here is that a stored hash never reveals the password and that a damaged
   one locks the account rather than opening it. */

test('a hash reveals neither the password nor another hash of it', async () => {
  const hash = await credentials.hashPassword('rahasia-spg');
  assert.doesNotMatch(hash, /rahasia-spg/);
  assert.match(hash, /^scrypt\$\d+\$\d+\$\d+\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);

  // Salted, so two SPGs who pick the same password do not get matching cells — which would
  // otherwise tell anyone reading the sheet exactly who to try a guessed password against.
  const again = await credentials.hashPassword('rahasia-spg');
  assert.notEqual(hash, again);
});

test('the right password verifies and near-misses do not', async () => {
  const hash = await credentials.hashPassword('rahasia-spg');
  assert.equal(await credentials.verifyHash('rahasia-spg', hash), true);
  assert.equal(await credentials.verifyHash('rahasia-sp', hash), false);
  assert.equal(await credentials.verifyHash('rahasia-spgg', hash), false);
  assert.equal(await credentials.verifyHash('Rahasia-SPG', hash), false);
  assert.equal(await credentials.verifyHash('', hash), false);
});

/* A spreadsheet is an editable surface and several people can open this one. Anything that
   is not a hash this code produced must fail closed — the dangerous bug would be a blank or
   mangled cell that verifies against everything. */
test('a damaged or hand-edited hash cell locks the account instead of opening it', async () => {
  for (const broken of [
    '', null, undefined, 'rahasia-spg', 'scrypt$', 'scrypt$16384$8$1$onlyfourparts',
    'bcrypt$16384$8$1$c2FsdA==$aGFzaA==',        // algorithm we do not implement
    'scrypt$x$8$1$c2FsdA==$aGFzaA==',            // non-numeric cost
    // An emptied hash cell once made *every* password verify: keylen came from the stored
    // value, so scrypt returned a zero-length key and timingSafeEqual called it a match.
    'scrypt$16384$8$1$c2FsdA==$',
    'scrypt$16384$8$1$$aGFzaA==',                // emptied salt
    'scrypt$16384$8$1$c2FsdA==$YWJj',            // hash too short to be a real key
  ]) {
    assert.equal(
      await credentials.verifyHash('rahasia-spg', broken), false,
      `should refuse ${JSON.stringify(broken)}`,
    );
  }
});

// Raising the cost later must not invalidate passwords set under the old parameters, which is
// why they travel inside the stored value rather than being read from this file.
/* The four-character format: one letter, then three consecutive digits lifted from the SPG's
   own FMS ID. Short enough to read out over the phone, which is the whole point, and weak
   enough that the throttle below is what makes it usable at all. */
test('a password is one letter followed by three digits from the FMS ID', () => {
  for (let i = 0; i < 40; i++) {
    const pw = credentials.generatePassword('OS212341');
    assert.match(pw, /^[a-z]\d{3}$/, `unexpected shape: ${pw}`);
    assert.ok(
      credentials.digitWindows('OS212341').includes(pw.slice(1)),
      `${pw.slice(1)} is not three consecutive digits of OS212341`,
    );
  }
});

test('the digit windows are every three-in-a-row, and only those', () => {
  assert.deepEqual(credentials.digitWindows('OS212341'), ['212', '123', '234', '341']);
  assert.deepEqual(credentials.digitWindows('OS123'), ['123']);
  assert.deepEqual(credentials.digitWindows('OS12'), []);
});

/* The letter and the window are both drawn at random rather than derived. If they were
   derived, the password would be a function of the FMS ID — which is typed into the same form
   — and anyone who learned the rule could sign in as any SPG. */
test('the same FMS ID does not always produce the same password', () => {
  const seen = new Set();
  for (let i = 0; i < 60; i++) seen.add(credentials.generatePassword('OS212341'));
  assert.ok(seen.size > 5, `only ${seen.size} distinct passwords in 60 draws`);
});

test('an FMS ID without three consecutive digits is refused, not silently padded', () => {
  assert.throws(() => credentials.generatePassword('OS12'), /3 angka berurutan/);
  assert.throws(() => credentials.generatePassword('ABCDEF'), /3 angka berurutan/);
});

// Without this, ~130 possibilities is a few seconds of scripted guessing.
test('repeated failures lock an FMS ID out for a while', () => {
  const id = 'OS999001';
  credentials.clearFailures(id);
  assert.equal(credentials.lockState(id).locked, false);

  for (let i = 0; i < credentials.MAX_ATTEMPTS; i++) {
    assert.equal(credentials.lockState(id).locked, false, `locked too early at attempt ${i}`);
    credentials.noteFailure(id);
  }
  const locked = credentials.lockState(id);
  assert.equal(locked.locked, true);
  assert.ok(locked.msLeft > 0);

  credentials.clearFailures(id);
  assert.equal(credentials.lockState(id).locked, false);
});

test('the lockout expires on its own', () => {
  const id = 'OS999002';
  credentials.clearFailures(id);
  const t0 = Date.now();
  for (let i = 0; i < credentials.MAX_ATTEMPTS; i++) credentials.noteFailure(id, t0);
  assert.equal(credentials.lockState(id, t0 + 1000).locked, true);
  assert.equal(credentials.lockState(id, t0 + 60 * 60 * 1000).locked, false);
});

// One SPG guessing wrong must not lock out their colleague.
test('a lockout is per FMS ID', () => {
  credentials.clearFailures('OS999003');
  credentials.clearFailures('OS999004');
  for (let i = 0; i < credentials.MAX_ATTEMPTS; i++) credentials.noteFailure('OS999003');
  assert.equal(credentials.lockState('OS999003').locked, true);
  assert.equal(credentials.lockState('OS999004').locked, false);
});

test('a hash carries its own cost parameters', async () => {
  const hash = await credentials.hashPassword('rahasia-spg');
  const [, n, r, p] = hash.split('$');
  const cheaper = ['scrypt', 1024, Number(r), Number(p), ...hash.split('$').slice(4)].join('$');

  assert.ok(Number(n) >= 16384, 'the default cost should not be trivial');
  // Same salt and hash bytes, different stated cost: it must recompute under the stated one
  // and therefore fail, rather than comparing the stored bytes blindly.
  assert.equal(await credentials.verifyHash('rahasia-spg', cheaper), false);
});

/* The QA list is handed to testers; the real list is five hundred live logins. Routing is by
   the reserved roster prefixes rather than by eye, so this pins that a real FMSID can never
   be routed into the tester-facing tab. */
test('a dummy password goes to the QA tab and a real one does not', () => {
  assert.equal(credentials.isQaAccount('Ops9900003'), true);
  assert.equal(credentials.isQaAccount('OSQA0003'), true);
  assert.equal(credentials.isQaAccount('Ops1624800'), false, 'a real FMSID is not a QA account');
  assert.equal(credentials.isQaAccount('OS191121'), false, 'a real OSID is not a QA account');
  assert.equal(credentials.isQaAccount(''), false);

  assert.equal(credentials.passwordTabFor('Ops9900003'), credentials.QA_PASSWORD_TAB);
  assert.equal(credentials.passwordTabFor('Ops1624800'), credentials.PASSWORD_TAB);
});

// Ops9900001 has seven digits, so it yields windows the generator can actually use -- the
// dummies must not be a shape that trips the "no three consecutive digits" refusal.
test('a QA dummy FMSID can produce a password', () => {
  const pw = credentials.generatePassword('Ops9900001');
  assert.match(pw, /^[a-z]\d{3}$/);
});
