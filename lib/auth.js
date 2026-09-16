const crypto = require('crypto');

/* A shared password in front of the whole app.

   Real login — Google Sign-In against a whitelist — is what the PRD asks for and is still
   deferred (see config.js). This is not that, and is not pretending to be: there is one
   password, everyone who has it is the same SPG, and it proves nothing about who is holding
   the phone.

   What it is for is narrower and worth being exact about. Locally the app was reachable only
   from localhost. Deployed it has a public URL, and behind that URL sit a real person's name,
   their hub, their supervisor's email and a recruitment pipeline — read through credentials
   that belong to the organisation, not to whoever found the link. A password is the smallest
   thing that stops that being open to the internet. It is a lock on a door, not an identity
   system, and the moment real login lands this file should go.

   Unset APP_PASSWORD and the gate is off, which is what keeps `npm start` on a laptop
   exactly as frictionless as it was before. */

const COOKIE = 'rh_session';
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // typing a password daily is friction an SPG in the field does not need

function password() { return process.env.APP_PASSWORD || ''; }
function enabled() { return !!password(); }

// Falls back to the password itself so a deployment that sets only APP_PASSWORD still gets
// unforgeable cookies. Setting SESSION_SECRET separately means changing the password does
// not have to sign everyone out, and vice versa.
function secret() { return process.env.SESSION_SECRET || password(); }

function sign(value) {
  return crypto.createHmac('sha256', secret()).update(value).digest('base64url');
}

function issue(now = Date.now()) {
  const expiresAt = String(now + MAX_AGE_MS);
  return `${expiresAt}.${sign(expiresAt)}`;
}

// Returns false rather than throwing for every rejection, so a malformed cookie from an old
// deployment is just a logged-out visitor.
function verify(token, now = Date.now()) {
  const raw = String(token || '');
  const dot = raw.indexOf('.');
  if (dot < 1) return false;

  const expiresAt = raw.slice(0, dot);
  const mac = raw.slice(dot + 1);
  if (!/^\d+$/.test(expiresAt)) return false;

  const expected = Buffer.from(sign(expiresAt));
  const got = Buffer.from(mac);
  if (expected.length !== got.length || !crypto.timingSafeEqual(expected, got)) return false;

  return Number(expiresAt) > now;
}

// Compared byte-for-byte in constant time. A plain === leaks how much of the password was
// right through how long the comparison took.
function passwordMatches(candidate) {
  const a = Buffer.from(String(candidate || ''));
  const b = Buffer.from(password());
  return a.length === b.length && b.length > 0 && crypto.timingSafeEqual(a, b);
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

function isSignedIn(req) {
  return verify(parseCookies(req.headers.cookie)[COOKIE]);
}

module.exports = {
  COOKIE, MAX_AGE_MS,
  enabled, issue, verify, passwordMatches, parseCookies, cookieHeader, isSignedIn,
};
