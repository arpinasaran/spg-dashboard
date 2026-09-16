const express = require('express');
const auth = require('../lib/auth');
const credentials = require('../lib/credentials');
const config = require('../config');

const router = express.Router();

/* The login screen and the middleware that sends everyone else to it.

   Written to cost an SPG as little as possible: two fields, a big button, and a cookie that
   lasts a month, so in practice this is seen once on the phone and then not again until the
   month is out. The OpsID is remembered in the field's value on a failed attempt, so a
   mistyped password does not mean typing both again. */

// Behind a proxy the connection to us is plain http even when the browser's is https, so the
// protocol has to come from the header the platform sets. Getting this wrong either drops
// the cookie (Secure over http) or sends it in the clear.
function isHttps(req) {
  return (req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}

function escape(s) {
  return String(s || '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function page({ error = '', opsId = '' } = {}) {
  return `<!doctype html>
<html lang="id">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Rute Harian</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100dvh; display: grid; place-items: center; padding: 24px;
    background: #fbf7ec; color: #3a3426;
    font: 16px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  }
  form { width: 100%; max-width: 360px; }
  h1 { margin: 0 0 4px; font-size: 1.5rem; letter-spacing: -0.01em; }
  p.sub { margin: 0 0 24px; color: #7a7059; font-size: 0.94rem; }
  label { display: block; margin: 16px 0 8px; font-weight: 600; font-size: 0.9rem; }
  label:first-of-type { margin-top: 0; }
  input {
    width: 100%; padding: 14px 16px; font-size: 1rem; color: inherit;
    background: #fff; border: 1.5px solid #ddd3bb; border-radius: 12px;
  }
  input:focus { outline: 2px solid #8a7c55; outline-offset: 1px; border-color: #8a7c55; }
  #opsId { text-transform: uppercase; }
  button {
    width: 100%; margin-top: 20px; padding: 14px 16px; font-size: 1rem; font-weight: 600;
    color: #fbf7ec; background: #6f6444; border: 0; border-radius: 12px; cursor: pointer;
  }
  button:active { background: #5b5237; }
  .error {
    margin: 16px 0 0; padding: 12px 14px; border-radius: 10px;
    background: #fbe9e7; color: #8c2f22; font-size: 0.9rem;
  }
  .hint { margin: 20px 0 0; color: #9a907a; font-size: 0.82rem; text-align: center; }
</style>
</head>
<body>
  <form method="post" action="/login">
    <h1>Rute Harian</h1>
    <p class="sub">Masuk dengan OS ID dan kata sandi kamu.</p>

    <label for="opsId">OS ID</label>
    <input id="opsId" name="opsId" type="text" value="${escape(opsId)}"
           autocomplete="username" autocapitalize="characters" autocorrect="off"
           spellcheck="false" required ${opsId ? '' : 'autofocus'}>

    <label for="password">Kata sandi</label>
    <input id="password" name="password" type="password"
           autocomplete="current-password" required ${opsId ? 'autofocus' : ''}>

    <button type="submit">Masuk</button>
    ${error ? `<p class="error">${escape(error)}</p>` : ''}
    <p class="hint">Belum punya kata sandi? Hubungi supervisor kamu.</p>
  </form>
</body>
</html>`;
}

router.get('/login', (req, res) => {
  if (!auth.enabled() || auth.sessionOpsId(req)) return res.redirect('/');
  res.type('html').send(page());
});

router.post('/login', express.urlencoded({ extended: false }), async (req, res) => {
  if (!auth.enabled()) return res.redirect('/');

  const opsId = String((req.body && req.body.opsId) || '').trim();
  const password = (req.body && req.body.password) || '';

  let authenticated = null;
  try {
    authenticated = await credentials.authenticate(opsId, password);
  } catch (err) {
    // The throttle is what lets the password be four characters at all, so say plainly that
    // it has tripped rather than hiding it behind the generic failure message.
    if (err.status === 429) {
      return res.status(429).type('html').send(page({ opsId, error: err.message }));
    }
    console.error(`Login gagal dibaca dari sheet: ${err.message}`);
    return res.status(503).type('html').send(page({
      opsId,
      error: 'Tidak bisa memeriksa kata sandi sekarang. Coba lagi sebentar lagi.',
    }));
  }

  if (!authenticated) {
    // One message for both a wrong password and an unknown OpsID: telling them apart would
    // turn this form into a way to discover which SPGs have accounts.
    return res.status(401).type('html').send(page({
      opsId,
      error: 'OS ID atau kata sandi salah.',
    }));
  }

  res.set('Set-Cookie', auth.cookieHeader(auth.issue(authenticated), { secure: isHttps(req) }));
  credentials.recordLogin(authenticated); // best-effort, deliberately not awaited
  res.redirect('/');
});

router.post('/logout', (req, res) => {
  res.set('Set-Cookie', auth.clearedCookie());
  res.redirect('/login');
});

/* Everything mounted after this needs a valid cookie, and gets req.spgOpsId — the single
   place identity enters a request. With the gate off (a laptop) that is the configured SPG,
   which is what keeps `npm start` behaving exactly as it did before any of this existed.

   An API call gets a 401 it can act on rather than a redirect to an HTML login page that a
   fetch() would try to parse as JSON. */
// Whether this caller is a fetch() that needs a status code rather than a browser that needs
// a page. Uses originalUrl because a middleware mounted on a path sees req.path with that
// mount point already stripped.
function wantsJson(req) {
  return String(req.originalUrl || req.url || '').startsWith('/api/');
}

function gate(req, res, next) {
  if (!auth.enabled()) {
    req.spgOpsId = config.spg.opsId;
    return next();
  }
  const opsId = auth.sessionOpsId(req);
  if (opsId) {
    req.spgOpsId = opsId;
    return next();
  }
  if (wantsJson(req)) return res.status(401).json({ error: 'Belum masuk' });
  res.redirect('/login');
}

/* The supervisor board is not the SPG app. It shows every SPG's attendance and it can approve
   or reject a session someone else's pay may depend on, so "is signed in" is not the right
   bar for it — until per-SPG login existed the only bar was being on the laptop running the
   server, and that bar quietly disappeared the moment the app got a public URL.

   ADMIN_OPS_IDS is a comma-separated allowlist. Empty on a laptop, where AUTH_MODE is off and
   the board stays open exactly as it was; empty on a deployment means nobody can reach it,
   which is the safer way round for an empty setting to fail. */
function adminOpsIds() {
  return String(process.env.ADMIN_OPS_IDS || '')
    .split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
}

function isAdmin(req) {
  if (!auth.enabled()) return true;
  const allowed = adminOpsIds();
  return allowed.includes(String(req.spgOpsId || '').trim().toUpperCase());
}

function adminOnly(req, res, next) {
  if (isAdmin(req)) return next();
  // originalUrl, not path: mounted under /api/admin, req.path has already had the mount point
  // stripped, so it reads as "/board" and an API caller would be handed an HTML page.
  if (wantsJson(req)) {
    return res.status(403).json({ error: 'Papan admin hanya untuk supervisor' });
  }
  res.status(403).type('html').send(
    '<!doctype html><meta charset="utf-8"><title>Rute Harian</title>'
    + '<p style="font:16px system-ui;padding:24px">Papan ini hanya untuk supervisor.</p>',
  );
}

module.exports = { router, gate, page, adminOnly, isAdmin, adminOpsIds };
