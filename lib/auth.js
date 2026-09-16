const crypto = require('crypto');

/* Sessions: who is holding the phone.

   This started as one shared password in front of one hardcoded SPG, which was wrong in a
   way worth naming. The app resolves identity from config.spg.opsId, so every visitor saw
   the same person's dashboard — and, far worse, clocked in *as* that person. Attendance rows
   carry a name, a place, a time, a photo and a distance; letting anyone write them under
   someone else's name makes the whole record worthless.

   So the cookie carries an OpsID, and every route resolves identity from it instead of from
   config. The password that proves the OpsID lives in lib/credentials.js.

   The cookie is signed, not encrypted: an SPG can read their own OpsID out of it, which is
   no secret, but cannot change it to someone else's without the signature failing.

   AUTH_MODE is unset on a laptop, where the app keeps behaving as the single configured SPG
   and nobody is asked to log in. A deployment sets AUTH_MODE=spg. */

const COOKIE = 'rh_session';
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // typing a password daily is friction an SPG in the field does not need

function mode() { return (process.env.AUTH_MODE || 'off').trim().toLowerCase(); }
function enabled() { return mode() === 'spg'; }

function secret() {
  const s = process.env.SESSION_SECRET;
  if (!s) throw new Error('SESSION_SECRET belum di-set — wajib saat AUTH_MODE=spg');
  return s;
}

function sign(value) {
  return crypto.createHmac('sha256', secret()).update(value).digest('base64url');
}

function issue(opsId, now = Date.now()) {
  const id = String(opsId || '').trim();
  if (!id) throw new Error('issue() butuh OpsID');
  const payload = `${Buffer.from(id).toString('base64url')}.${now + MAX_AGE_MS}`;
  return `${payload}.${sign(payload)}`;
}

/* Returns the OpsID, or null for every kind of rejection — expired, forged, malformed. The
   caller cannot tell them apart and does not need to: all of them mean "log in again". */
function verify(token, now = Date.now()) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;

  const [idB64, expiresAt, mac] = parts;
  if (!idB64 || !/^\d+$/.test(expiresAt)) return null;

  const expected = Buffer.from(sign(`${idB64}.${expiresAt}`));
  const got = Buffer.from(mac);
  if (expected.length !== got.length || !crypto.timingSafeEqual(expected, got)) return null;
  if (Number(expiresAt) <= now) return null;

  const opsId = Buffer.from(idB64, 'base64url').toString('utf8').trim();
  return opsId || null;
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    if (k) out[k] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

function cookieHeader(token, { secure }) {
  const parts = [
    `${COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(MAX_AGE_MS / 1000)}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

function clearedCookie() {
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

// The OpsID this request is authorised to act as, or null.
function sessionOpsId(req) {
  try {
    return verify(parseCookies(req.headers.cookie)[COOKIE]);
  } catch {
    // A missing SESSION_SECRET throws in secret(); treat it as "not signed in" rather than
    // failing the request, since the gate will send them to a login they cannot complete
    // anyway and the log will say why.
    return null;
  }
}

module.exports = {
  COOKIE, MAX_AGE_MS,
  mode, enabled, issue, verify, parseCookies, cookieHeader, clearedCookie, sessionOpsId,
};
