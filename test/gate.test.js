process.env.AUTH_MODE = 'spg';
process.env.SESSION_SECRET = 'rahasia-uji';
process.env.STORE_DRIVER = 'disk';
process.env.ADMIN_OPS_IDS = 'OS000001';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const credentials = require('../lib/credentials');
const auth = require('../lib/auth');

/* Exercises the real app object, because what is most likely to go wrong here is the order
   the middleware is mounted in rather than the logic inside any one piece. Mount the gate
   before the login route and nobody can ever sign in; mount express.static before the gate
   and the whole front end is readable to anyone with the URL; forget adminOnly and every SPG
   can approve their own attendance.

   The credentials sheet is stubbed: these are questions about routing and sessions, and
   lib/credentials.js's own hashing is covered in credentials.test.js. */
const ACCOUNTS = { OS212341: 'benar-sekali', OS000001: 'sandi-supervisor' };
credentials.authenticate = async (opsId, password) => {
  const id = String(opsId || '').trim().toUpperCase();
  return ACCOUNTS[id] && ACCOUNTS[id] === password ? id : null;
};
credentials.recordLogin = async () => {};

const app = require('../app');

let server;
let base;

test.before(async () => {
  server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => new Promise(resolve => server.close(resolve)));

function request(path, { cookie, method = 'GET', form } = {}) {
  const body = form ? new URLSearchParams(form).toString() : null;
  return new Promise((resolve, reject) => {
    const req = http.request(`${base}${path}`, {
      method,
      headers: {
        ...(cookie ? { Cookie: cookie } : {}),
        ...(body ? {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
        } : {}),
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

async function signIn(opsId) {
  const res = await request('/login', { method: 'POST', form: { opsId, password: ACCOUNTS[opsId] } });
  assert.equal(res.status, 302, `sign-in for ${opsId} should succeed`);
  return String(res.headers['set-cookie']).split(';')[0];
}

test('a signed-out visitor is sent to the login page', async () => {
  const res = await request('/');
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/login');
});

test('the login page itself is reachable while signed out', async () => {
  const res = await request('/login');
  assert.equal(res.status, 200);
  assert.match(res.text, /OS ID/);
});

// The front end is not public just because it is "only" static files: it is the SPG's app.
test('static assets are behind the gate too', async () => {
  const res = await request('/styles.css');
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/login');
});

// A fetch() in the page cannot follow a redirect to an HTML form and do anything sensible
// with it, so the API says 401 instead.
test('an API call gets a 401 rather than a redirect', async () => {
  const res = await request('/api/bootstrap');
  assert.equal(res.status, 401);
  assert.deepEqual(JSON.parse(res.text), { error: 'Belum masuk' });
});

test('the wrong password is refused and no cookie is handed out', async () => {
  const res = await request('/login', { method: 'POST', form: { opsId: 'OS212341', password: 'salah' } });
  assert.equal(res.status, 401);
  assert.equal(res.headers['set-cookie'], undefined);
  assert.match(res.text, /OS ID atau kata sandi salah/);
});

/* Same message either way. Distinguishing them would turn the form into a way to find out
   which SPGs have accounts, which is a list worth not publishing. */
test('an unknown OpsID is refused with the same message as a wrong password', async () => {
  const unknown = await request('/login', { method: 'POST', form: { opsId: 'OS777777', password: 'apa saja' } });
  const wrong = await request('/login', { method: 'POST', form: { opsId: 'OS212341', password: 'salah' } });
  assert.equal(unknown.status, wrong.status);
  assert.match(unknown.text, /OS ID atau kata sandi salah/);
});

// Retyping a long OpsID on a phone after one typo is exactly the friction this app is
// supposed to be saving an SPG in the field.
test('a failed attempt keeps the OpsID in the form', async () => {
  const res = await request('/login', { method: 'POST', form: { opsId: 'OS212341', password: 'salah' } });
  assert.match(res.text, /value="OS212341"/);
});

test('signing in sets a hardened cookie that then opens the app', async () => {
  const cookie = await signIn('OS212341');
  const raw = String(cookie);
  assert.ok(raw.startsWith(`${auth.COOKIE}=`));

  const asset = await request('/styles.css', { cookie });
  assert.equal(asset.status, 200);
});

test('a cookie with a forged signature does not open the app', async () => {
  const forged = `${auth.COOKIE}=${Buffer.from('OS212341').toString('base64url')}.${Date.now() + 100000}.palsu`;
  const res = await request('/styles.css', { cookie: forged });
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/login');
});

/* The supervisor board can approve or reject a session someone's pay may depend on. Being a
   signed-in SPG is not the same as being allowed to do that. */
test('an ordinary SPG cannot reach the supervisor board', async () => {
  const cookie = await signIn('OS212341');

  const page = await request('/admin', { cookie });
  assert.equal(page.status, 403);

  const api = await request('/api/admin/board', { cookie });
  assert.equal(api.status, 403);
  assert.deepEqual(JSON.parse(api.text), { error: 'Papan admin hanya untuk supervisor' });
});

test('an OpsID on the allowlist can', async () => {
  const cookie = await signIn('OS000001');
  const page = await request('/admin', { cookie });
  assert.equal(page.status, 200);
  assert.match(page.text, /<html/i);
});

test('signing out clears the cookie', async () => {
  const cookie = await signIn('OS212341');
  const res = await request('/logout', { method: 'POST', cookie });
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/login');
  assert.match(String(res.headers['set-cookie']), /Max-Age=0/);
});
