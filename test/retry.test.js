const test = require('node:test');
const assert = require('node:assert');
const { withRetry, RETRYABLE } = require('../lib/googleClient');

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
