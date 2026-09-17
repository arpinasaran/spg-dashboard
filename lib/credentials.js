const crypto = require('crypto');
const { readRange, valuesAppend, valuesUpdate, listTabs, batchUpdate } = require('./sheetsClient');
const config = require('../config');

/* Per-SPG passwords, kept in the Attendance spreadsheet.

   Why here and not in a proper user store: the Attendance spreadsheet is the one thing this
   app both owns and can write to from a deployment. Everything else belongs to another team.
   A tab in it is not a great place for credentials, and this file does not pretend otherwise
   — it is the smallest thing that makes attendance mean something.

   And it has to mean something. Attendance is evidence: a row says a named person stood at a
   named place at a named time, with a photo and a distance to prove it. A shared password in
   front of a single hardcoded identity would have made every one of those rows a claim about
   somebody who may not have been there. Identity per SPG is what makes the geofence and the
   photo worth collecting at all.

   What is stored is a scrypt hash, never the password. Anyone who can open the spreadsheet —
   and several people can — sees hashes. That matters beyond this app: people reuse
   passwords, and a leaked plaintext column would follow them to their email. */

const TAB = config.sheets.credentialsTab;
const RANGE = `'${TAB}'!A2:E`;
const HEADER = ['FMS ID', 'Nama', 'Password Hash', 'Diperbarui', 'Login Terakhir'];

const PASSWORD_TAB = config.sheets.passwordsTab;
const PASSWORD_RANGE = `'${PASSWORD_TAB}'!A2:D`;
const PASSWORD_HEADER = ['FMS ID', 'Nama', 'Kata Sandi', 'Dibuat'];

const QA_PASSWORD_TAB = config.sheets.qaPasswordsTab;

/* Which readable list an account's password belongs in. The QA dummies were given reserved
   prefixes in the roster precisely so this question has a mechanical answer: a real SPG can
   never match, whatever their FMSID happens to be, because "Ops99" is not issued to people.

   Same pattern as scripts/demo-reset.js. Both places are guarding the same thing from
   opposite sides -- one decides who may be wiped, the other decides whose password may be
   handed to a tester -- and neither should be deciding it by eye. */
const QA_ACCOUNT = /^(Ops99\d{5}|OSQA\d{4})$/i;
function isQaAccount(opsId) { return QA_ACCOUNT.test(String(opsId || '').trim()); }
function passwordTabFor(opsId) { return isQaAccount(opsId) ? QA_PASSWORD_TAB : PASSWORD_TAB; }

/* Passwords an SPG can actually type on a phone: one letter and three digits, the digits
   being three consecutive digits taken from their own FMS ID.

   This is four characters, and it is worth being plain about what that costs. The search
   space is 24 letters times the handful of three-digit windows an FMS ID contains — 120
   guesses for "Ops1624800", whose seven digits yield five windows. That is small. Two things
   keep it from being worthless:

     - Both the letter and the window are chosen at random, not derived. Had the rule been
       "first three digits" with a predictable letter, the password would be a function of the
       username, which is printed on the login form — no secret at all, and anyone who learned
       the rule could sign in as anyone.
     - Repeated failures lock the FMS ID for a while (see throttle below), so those 96 guesses
       cannot simply be typed in.

   It remains a weak password protecting real attendance records. It is a deliberate trade for
   something an SPG can be told over the phone and type with one hand in the field. */
const LETTERS = 'abcdefghijkmnpqrstuvwxyz'; // no l or o — they read as 1 and 0 on paper

function digitWindows(opsId, size = 3) {
  const digits = String(opsId || '').replace(/\D/g, '');
  const out = [];
  for (let i = 0; i + size <= digits.length; i++) out.push(digits.slice(i, i + size));
  return out;
}

function generatePassword(opsId) {
  const windows = digitWindows(opsId);
  if (!windows.length) {
    throw Object.assign(
      new Error(`FMS ID "${opsId}" tidak punya 3 angka berurutan untuk dijadikan kata sandi.`),
      { status: 400 },
    );
  }
  const letter = LETTERS[crypto.randomInt(LETTERS.length)];
  return letter + windows[crypto.randomInt(windows.length)];
}

// scrypt's cost parameters, stored alongside each hash so they can be raised later without
// invalidating passwords set under the old ones.
const N = 16384;
const R = 8;
const P = 1;
const KEYLEN = 32;

function scrypt(password, salt, { n = N, r = R, p = P, keylen = KEYLEN } = {}) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(String(password), salt, keylen, { N: n, r, p }, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt);
  return ['scrypt', N, R, P, salt.toString('base64'), key.toString('base64')].join('$');
}

// Returns false for anything it cannot parse, so a hand-edited or truncated cell locks that
// SPG out rather than letting them in.
async function verifyHash(password, encoded) {
  const parts = String(encoded || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const [, n, r, p, saltB64, hashB64] = parts;
  if (![n, r, p].every(v => /^\d+$/.test(v))) return false;

  try {
    const expected = Buffer.from(hashB64, 'base64');
    const salt = Buffer.from(saltB64, 'base64');

    /* Length floors, and they are not paranoia. keylen comes from the stored hash, so an
       emptied cell asks scrypt for a zero-length key, gets a zero-length buffer back, and
       timingSafeEqual happily reports two empty buffers as equal — every password would then
       open that account. Clearing one cell in a spreadsheet several people can open is an
       easy accident; it must lock the account, not unlock it. */
    if (expected.length < 16 || salt.length < 8) return false;

    const got = await scrypt(password, salt, {
      n: Number(n), r: Number(r), p: Number(p), keylen: expected.length,
    });
    return expected.length === got.length && crypto.timingSafeEqual(expected, got);
  } catch {
    return false;
  }
}

// Creating the tab is idempotent, so a first password can be set on a spreadsheet nobody has
// prepared by hand.
let ensured = null;
async function ensureTab() {
  if (!ensured) {
    ensured = (async () => {
      const tabs = await listTabs(config.sheets.attendanceDb);
      if (tabs.some(t => t.title === TAB)) return;
      await batchUpdate(config.sheets.attendanceDb, [{
        addSheet: {
          properties: { title: TAB, gridProperties: { rowCount: 1000, columnCount: HEADER.length } },
        },
      }]);
      await valuesUpdate(config.sheets.attendanceDb, `'${TAB}'!A1:E1`, [HEADER]);
    })().catch((err) => { ensured = null; throw err; });
  }
  return ensured;
}

/* Deliberately NOT stored through lib/store.js like everything else. That store writes its
   snapshots to a Drive folder, and password hashes are the one dataset that should not be
   copied anywhere it does not have to go. This is an in-process cache only: it dies with the
   instance, and on a serverless one that is usually within the minute. */
const TTL_MS = 60 * 1000;
let cached = null;

async function rows({ fresh = false } = {}) {
  if (!fresh && cached && Date.now() - cached.at < TTL_MS) return cached.rows;
  const raw = await readRange(config.sheets.attendanceDb, RANGE);
  const parsed = raw
    .filter(r => (r[0] || '').trim())
    .map((r, i) => ({
      rowNumber: i + 2, // header occupies row 1; readRange started at A2
      opsId: String(r[0] || '').trim(),
      name: String(r[1] || '').trim(),
      hash: String(r[2] || '').trim(),
      updatedAt: String(r[3] || '').trim(),
      lastLogin: String(r[4] || '').trim(),
    }));
  cached = { at: Date.now(), rows: parsed };
  return parsed;
}

function invalidate() { cached = null; }

async function find(opsId) {
  const wanted = String(opsId || '').trim().toUpperCase();
  if (!wanted) return null;
  return (await rows()).find(r => r.opsId.toUpperCase() === wanted) || null;
}

/* Returns the SPG's OpsID on success and null on every failure, with no distinction between
   "no such OpsID" and "wrong password" — telling them apart would turn the login form into a
   way to enumerate which SPGs have accounts.

   An unknown OpsID still pays for a hash comparison, so the answer does not come back
   noticeably faster for one case than the other. */
const DUMMY_HASH = ['scrypt', N, R, P,
  Buffer.alloc(16).toString('base64'), Buffer.alloc(KEYLEN).toString('base64')].join('$');

/* Failed-attempt throttle. Under a hundred possibilities is seconds of scripted guessing;
   this is what makes that impossible in practice, and it is why the password may be four
   characters at all.

   In memory, per FMS ID. On a serverless instance that means the counter resets whenever a new
   instance answers, which weakens it — an attacker spread across cold starts gets more tries
   than the number below suggests. Moving it into the spreadsheet would make it durable at the
   cost of a write per failed login. Worth doing if this ever protects more than a pilot. */
const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 10 * 60 * 1000;
const attempts = new Map(); // opsId -> { count, until }

function lockState(opsId, now = Date.now()) {
  const key = String(opsId || '').trim().toUpperCase();
  const rec = attempts.get(key);
  if (!rec) return { locked: false, msLeft: 0 };
  if (rec.until && rec.until > now) return { locked: true, msLeft: rec.until - now };
  if (rec.until && rec.until <= now) attempts.delete(key); // lockout served
  return { locked: false, msLeft: 0 };
}

function noteFailure(opsId, now = Date.now()) {
  const key = String(opsId || '').trim().toUpperCase();
  const rec = attempts.get(key) || { count: 0, until: 0 };
  rec.count += 1;
  if (rec.count >= MAX_ATTEMPTS) {
    rec.until = now + LOCKOUT_MS;
    rec.count = 0;
  }
  attempts.set(key, rec);
}

function clearFailures(opsId) {
  attempts.delete(String(opsId || '').trim().toUpperCase());
}

async function authenticate(opsId, password) {
  if (!password) return null;
  if (lockState(opsId).locked) {
    throw Object.assign(
      new Error('Terlalu banyak percobaan. Coba lagi dalam beberapa menit.'),
      { status: 429, locked: true },
    );
  }
  const row = await find(opsId);
  const ok = await verifyHash(password, row ? row.hash : DUMMY_HASH);
  if (!ok || !row) {
    noteFailure(opsId);
    return null;
  }
  clearFailures(opsId);
  return row.opsId;
}

async function setPassword(opsId, name, password) {
  // Four, because that is the format these are now issued in: a letter and three digits.
  if (String(password || '').length < 4) {
    throw Object.assign(new Error('Kata sandi minimal 4 karakter.'), { status: 400 });
  }
  await ensureTab();

  const id = String(opsId || '').trim();
  if (!id) throw Object.assign(new Error('FMS ID wajib diisi.'), { status: 400 });

  const hash = await hashPassword(password);
  const now = new Date().toISOString();
  const existing = await find(id);

  if (existing) {
    await valuesUpdate(
      config.sheets.attendanceDb,
      `'${TAB}'!A${existing.rowNumber}:D${existing.rowNumber}`,
      [[existing.opsId, name || existing.name, hash, now]],
    );
  } else {
    await valuesAppend(config.sheets.attendanceDb, RANGE, [[id, name || '', hash, now, '']]);
  }
  invalidate();
  clearFailures(id); // a reset should not leave the SPG locked out by the old password's failures
  await recordPassword(id, name || (existing && existing.name) || '', password, now);
  return { opsId: id, created: !existing };
}

/* The readable record, in its own tab.

   The hash above is what logs someone in; this is what a supervisor reads out over the phone
   when an SPG forgets. It holds the password in the clear, which is the point and also the
   risk: anyone who can open this spreadsheet can sign in as any SPG listed here. It is
   separate from the hashes precisely so it can be restricted, or simply emptied, without
   breaking a single login — the app never reads it. */
// Memoised per tab rather than once: there are two readable lists now, and a single flag
// would report the QA tab as ready because the real one had been created.
const ensuredPasswords = new Map();
async function ensurePasswordTab(tab = PASSWORD_TAB) {
  if (!ensuredPasswords.has(tab)) {
    ensuredPasswords.set(tab, (async () => {
      const tabs = await listTabs(config.sheets.attendanceDb);
      if (tabs.some(t => t.title === tab)) return;
      await batchUpdate(config.sheets.attendanceDb, [{
        addSheet: {
          properties: {
            title: tab,
            gridProperties: { rowCount: 1000, columnCount: PASSWORD_HEADER.length },
          },
        },
      }]);
      await valuesUpdate(config.sheets.attendanceDb, `'${tab}'!A1:D1`, [PASSWORD_HEADER]);
    })().catch((err) => { ensuredPasswords.delete(tab); throw err; }));
  }
  return ensuredPasswords.get(tab);
}

async function recordPassword(opsId, name, password, when = new Date().toISOString()) {
  const tab = passwordTabFor(opsId);
  await ensurePasswordTab(tab);
  const range = `'${tab}'!A2:D`;
  const raw = await readRange(config.sheets.attendanceDb, range);
  const idx = raw.findIndex(r => String(r[0] || '').trim().toUpperCase() === opsId.toUpperCase());
  const row = [opsId, name || '', password, when];
  if (idx >= 0) {
    await valuesUpdate(config.sheets.attendanceDb, `'${tab}'!A${idx + 2}:D${idx + 2}`, [row]);
  } else {
    await valuesAppend(config.sheets.attendanceDb, range, [row]);
  }
}

// Best-effort: a failure to record the login must never stop someone signing in.
async function recordLogin(opsId) {
  try {
    const row = await find(opsId);
    if (!row) return;
    await valuesUpdate(
      config.sheets.attendanceDb,
      `'${TAB}'!E${row.rowNumber}`,
      [[new Date().toISOString()]],
    );
    invalidate();
  } catch (err) {
    console.error(`Gagal mencatat login ${opsId}: ${err.message}`);
  }
}

async function list() {
  return (await rows({ fresh: true })).map(r => ({
    opsId: r.opsId, name: r.name, updatedAt: r.updatedAt, lastLogin: r.lastLogin,
  }));
}

module.exports = {
  TAB, HEADER, RANGE, PASSWORD_TAB, PASSWORD_HEADER, QA_PASSWORD_TAB,
  isQaAccount, passwordTabFor,
  generatePassword, digitWindows, lockState, noteFailure, clearFailures, MAX_ATTEMPTS,
  hashPassword, verifyHash, authenticate, setPassword, recordLogin, list, find,
  ensureTab, ensurePasswordTab, invalidate,
};
