const test = require('node:test');
const assert = require('node:assert');
const { withRetry, RETRYABLE, isTransient } = require('../lib/googleClient');

/* Sheets allows 60 write requests per minute per user, and the service account is one user.
   Two writes per clock-in means the ceiling is 30 clock-ins a minute; a morning that puts 500
   SPGs through a fifteen-minute window asks for 67 writes a minute and gets 429s back.

   A 429 is not a failure, it is an instruction to wait. What decides whether an SPG sees
   "Gagal menyimpan" is entirely whether this function is between them and it. */

function failing(times, status) {
  let calls = 0;
  return {
    calls: () => calls,
    run: async () => {
      calls++;
      if (calls <= times) throw Object.assign(new Error(`boom ${status}`), { status });
      return 'ok';
    },
  };
}

test('a rate-limited write is retried rather than surfaced', async () => {
  const f = failing(2, 429);
  assert.equal(await withRetry('test', f.run), 'ok');
  assert.equal(f.calls(), 3, 'two refusals, then the write went through');
});

test('the retryable statuses are the ones where waiting can help', () => {
  assert.deepEqual([...RETRYABLE].sort((a, b) => a - b), [429, 500, 502, 503, 504]);
});

test('a bad request is not retried, because repeating it only spends quota', async () => {
  for (const status of [400, 401, 403, 404]) {
    const f = failing(1, status);
    await assert.rejects(() => withRetry('test', f.run), err => err.status === status);
    assert.equal(f.calls(), 1, `${status} was attempted once and not again`);
  }
});

test('retrying gives up rather than outliving the function it runs inside', async () => {
  const f = failing(99, 503);
  await assert.rejects(() => withRetry('test', f.run), err => err.status === 503);
  assert.ok(f.calls() <= 4, `attempts are bounded (made ${f.calls()})`);
});

test('backoff grows and stays under the function timeout', async () => {
  // The schedule is min(2^n * 250 + jitter, 8000) over at most 3 waits: worst case well inside
  // the 60s maxDuration in vercel.json, so a retry can never become a silent timeout.
  const f = failing(99, 429);
  const started = Date.now();
  await assert.rejects(() => withRetry('test', f.run), () => true);
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 10000, `total backoff was ${elapsed}ms, comfortably inside maxDuration 60s`);
  assert.ok(elapsed >= 250, 'it did actually wait between attempts');
});

/* Transport failures. A snapshot run's uploads come back as bare ECONNRESET with no HTTP
   status at all, and the original classifier only looked at statuses — so the retry that
   exists for exactly this case never fired, and snapshots were left at yesterday's numbers
   while every step still reported success. */

test('a connection reset is treated as worth retrying', () => {
  assert.equal(isTransient(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })), true);
  assert.equal(isTransient(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })), true);
  for (const code of ['ETIMEDOUT', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE']) {
    assert.equal(isTransient(Object.assign(new Error('x'), { code })), true, code);
  }
});

test('a cause nested one level down is still found', () => {
  // node-fetch reports the real reason under .cause rather than on the error itself.
  const err = new Error('request to https://… failed');
  err.cause = { code: 'ECONNRESET' };
  assert.equal(isTransient(err), true);
});

test('the message alone is enough when there is no code at all', () => {
  assert.equal(isTransient(new Error('request failed, reason: read ECONNRESET')), true);
});

test('a request that was actually answered and refused is not retried', () => {
  assert.equal(isTransient(Object.assign(new Error('forbidden'), { code: 403 })), false);
  assert.equal(isTransient(Object.assign(new Error('bad request'), { code: 400 })), false);
  assert.equal(isTransient(new Error('Service Accounts do not have storage quota')), false);
});
