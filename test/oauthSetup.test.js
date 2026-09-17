const test = require('node:test');
const assert = require('node:assert');
const { listenOnFreePort, waitForCode } = require('../scripts/oauth-setup');

/* The loopback leg of the consent flow.

   A browser does not send one request. It sends the callback, and around it a favicon, a
   retry on a kept-alive connection, sometimes a reload of the callback tab by a person who
   thinks nothing happened. The first version read the port off the server inside the
   handler, which returns null once the server closes, so one of those extra requests threw
   and killed the process — after the code had arrived and before it could be exchanged for a
   token, which is the worst possible moment. */

const portOf = server => server.address().port;
const hit = (server, path) => fetch(`http://127.0.0.1:${portOf(server)}${path}`);

async function withServer(run) {
  const server = await listenOnFreePort();
  try {
    return await run(server);
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
}

test('the callback hands back the code', async () => {
  await withServer(async (server) => {
    const waiting = waitForCode(server, 'st4te');
    const res = await hit(server, '/callback?state=st4te&code=4/abc');
    assert.equal(res.status, 200);
    assert.equal(await waiting, '4/abc');
  });
});

test('a favicon before the callback does not disturb it', async () => {
  await withServer(async (server) => {
    const waiting = waitForCode(server, 'st4te');
    const icon = await hit(server, '/favicon.ico');
    assert.equal(icon.status, 404);
    await hit(server, '/callback?state=st4te&code=4/abc');
    assert.equal(await waiting, '4/abc');
  });
});

test('a second callback after the first is answered, not acted on', async () => {
  // This is the crash: a reload, or a retried request, arriving once the flow has moved on.
  await withServer(async (server) => {
    const waiting = waitForCode(server, 'st4te');
    await hit(server, '/callback?state=st4te&code=4/first');
    assert.equal(await waiting, '4/first');

    const again = await hit(server, '/callback?state=st4te&code=4/second');
    assert.equal(again.status, 200, 'the duplicate is answered rather than throwing');
    assert.match(await again.text(), /Sudah diproses/);
  });
});

test('a code carrying the wrong state is refused', async () => {
  await withServer(async (server) => {
    const waiting = waitForCode(server, 'st4te').catch(err => err);
    await hit(server, '/callback?state=somebody-elses&code=4/abc');
    assert.match((await waiting).message, /State tidak cocok/);
  });
});

test("Google's own refusal is reported as itself", async () => {
  await withServer(async (server) => {
    const waiting = waitForCode(server, 'st4te').catch(err => err);
    await hit(server, '/callback?state=st4te&error=access_denied');
    assert.match((await waiting).message, /access_denied/);
  });
});

test('a callback with no code at all is an error, not a hang', async () => {
  await withServer(async (server) => {
    const waiting = waitForCode(server, 'st4te').catch(err => err);
    await hit(server, '/callback?state=st4te');
    assert.match((await waiting).message, /Balasan tanpa code/);
  });
});
