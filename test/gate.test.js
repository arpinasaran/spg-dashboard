process.env.APP_PASSWORD = 'kata-sandi-uji';
process.env.SESSION_SECRET = 'rahasia-uji';
process.env.STORE_DRIVER = 'disk';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const app = require('../app');
const auth = require('../lib/auth');

/* Exercises the real app object, because the thing most likely to go wrong here is the order
   the middleware is mounted in rather than the logic inside any one of them. Mount the gate
   before the login route and nobody can ever sign in; mount express.static before the gate
   and the whole front end is readable to anyone with the URL.

   Only paths that cannot reach Google are requested: an unauthenticated call stops at the
   gate, and a static file is served off disk. */

let server;
let base;

test.before(async () => {
  server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => new Promise(resolve => server.close(resolve)));

function get(path, { cookie, method = 'GET', body, type } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${base}${path}`, {
      method,
      headers: {
        ...(cookie ? { Cookie: cookie } : {}),
        ...(type ? { 'Content-Type': type, 'Content-Length': Buffer.byteLength(body) } : {}),
      },
    }, (res) => {
      let text = '';
      res.on('data', c => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

test('a signed-out visitor is sent to the login page', async () => {
  const res = await get('/');
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/login');
});

test('the login page itself is reachable while signed out', async () => {
  const res = await get('/login');
  assert.equal(res.status, 200);
  assert.match(res.text, /Kata sandi/);
});

// The front end is not public just because it is "only" static files: it is the SPG's app.
test('static assets are behind the gate too', async () => {
  const res = await get('/styles.css');
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/login');
});

// A fetch() in the page cannot follow a redirect to an HTML login form and do anything
// sensible with it, so the API says 401 instead.
test('an API call gets a 401 rather than a redirect', async () => {
  const res = await get('/api/bootstrap');
  assert.equal(res.status, 401);
  assert.deepEqual(JSON.parse(res.text), { error: 'Belum masuk' });
});

test('the wrong password is refused and no cookie is handed out', async () => {
  const res = await get('/login', {
    method: 'POST',
    body: 'password=salah',
    type: 'application/x-www-form-urlencoded',
  });
  assert.equal(res.status, 401);
  assert.equal(res.headers['set-cookie'], undefined);
  assert.match(res.text, /Kata sandi salah/);
});

test('the right password sets a hardened cookie that then opens the app', async () => {
  const login = await get('/login', {
    method: 'POST',
    body: `password=${encodeURIComponent('kata-sandi-uji')}`,
    type: 'application/x-www-form-urlencoded',
  });
  assert.equal(login.status, 302);
  assert.equal(login.headers.location, '/');

  const setCookie = String(login.headers['set-cookie']);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Lax/);

  const cookie = setCookie.split(';')[0];
  const asset = await get('/styles.css', { cookie });
  assert.equal(asset.status, 200);
});

test('a cookie with a forged signature does not open the app', async () => {
  const forged = `${auth.COOKIE}=${Date.now() + 100000}.bukan-tanda-tangan-asli`;
  const res = await get('/styles.css', { cookie: forged });
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/login');
});
