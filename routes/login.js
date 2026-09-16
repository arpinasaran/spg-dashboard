const express = require('express');
const auth = require('../lib/auth');

const router = express.Router();

/* The password gate's two halves: the page that takes the password, and the middleware that
   sends everyone else to it. See lib/auth.js for what this is and is not for.

   Written to cost an SPG as little as possible: one field, a big button, and a cookie that
   lasts a month, so in practice this is seen once on the phone and then never again. */

// Behind a proxy the connection to us is plain http even when the browser's is https, so the
// protocol has to come from the header Vercel sets. Getting this wrong either drops the
// cookie (Secure over http) or sends it in the clear.
function isHttps(req) {
  return (req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}

function page({ error = '' } = {}) {
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
  label { display: block; margin-bottom: 8px; font-weight: 600; font-size: 0.9rem; }
  input {
    width: 100%; padding: 14px 16px; font-size: 1rem; color: inherit;
    background: #fff; border: 1.5px solid #ddd3bb; border-radius: 12px;
  }
  input:focus { outline: 2px solid #8a7c55; outline-offset: 1px; border-color: #8a7c55; }
  button {
    width: 100%; margin-top: 16px; padding: 14px 16px; font-size: 1rem; font-weight: 600;
    color: #fbf7ec; background: #6f6444; border: 0; border-radius: 12px; cursor: pointer;
  }
  button:active { background: #5b5237; }
  .error {
    margin: 16px 0 0; padding: 12px 14px; border-radius: 10px;
    background: #fbe9e7; color: #8c2f22; font-size: 0.9rem;
  }
</style>
</head>
<body>
  <form method="post" action="/login">
    <h1>Rute Harian</h1>
    <p class="sub">Masukkan kata sandi untuk membuka aplikasi.</p>
    <label for="password">Kata sandi</label>
    <input id="password" name="password" type="password" autocomplete="current-password"
           autofocus required inputmode="text">
    <button type="submit">Masuk</button>
    ${error ? `<p class="error">${error}</p>` : ''}
  </form>
</body>
</html>`;
}

router.get('/login', (req, res) => {
  if (!auth.enabled() || auth.isSignedIn(req)) return res.redirect('/');
  res.type('html').send(page());
});

router.post('/login', express.urlencoded({ extended: false }), (req, res) => {
  if (!auth.enabled()) return res.redirect('/');
  if (!auth.passwordMatches(req.body && req.body.password)) {
    // Deliberately vague and deliberately slow to enumerate: no hint about what was wrong.
    return res.status(401).type('html').send(page({ error: 'Kata sandi salah. Coba lagi.' }));
  }
  res.set('Set-Cookie', auth.cookieHeader(auth.issue(), { secure: isHttps(req) }));
  res.redirect('/');
});

router.post('/logout', (req, res) => {
  res.set('Set-Cookie', `${auth.COOKIE}=; Path=/; HttpOnly; Max-Age=0`);
  res.redirect('/login');
});

// Everything mounted after this needs a valid cookie. An API call gets a 401 it can act on
// rather than a redirect to a login page it would try to parse as JSON.
function gate(req, res, next) {
  if (!auth.enabled() || auth.isSignedIn(req)) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Belum masuk' });
  res.redirect('/login');
}

module.exports = { router, gate, page };
