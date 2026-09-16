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
const HEADER = ['OpsID', 'Nama', 'Password Hash', 'Diperbarui', 'Login Terakhir'];

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

async function authenticate(opsId, password) {
  if (!password) return null;
  const row = await find(opsId);
  const ok = await verifyHash(password, row ? row.hash : DUMMY_HASH);
  return ok && row ? row.opsId : null;
}

async function setPassword(opsId, name, password) {
  if (String(password || '').length < 6) {
    throw Object.assign(new Error('Kata sandi minimal 6 karakter.'), { status: 400 });
  }
  await ensureTab();

  const id = String(opsId || '').trim();
  if (!id) throw Object.assign(new Error('OpsID wajib diisi.'), { status: 400 });

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
  return { opsId: id, created: !existing };
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
  TAB, HEADER, RANGE,
  hashPassword, verifyHash, authenticate, setPassword, recordLogin, list, find,
  ensureTab, invalidate,
};
