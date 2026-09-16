process.env.STORE_DRIVER = 'disk'; // before lib/store.js resolves its driver

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { cache, resetForTests } = require('../lib/cache');
const store = require('../lib/store');

let n = 0;
const keys = [];
function freshKey() {
  const key = `test-cache-${process.pid}-${n++}`;
  keys.push(key);
  return key;
}

// persist() is fire-and-forget by design, so a test that wants to see the snapshot on disk
// has to let the write land first.
const settle = () => new Promise(r => setImmediate(r));

test.after(() => {
  for (const key of keys) fs.rmSync(path.join(store.DISK_DIR, `${key}.json`), { force: true });
});

test('a cold cache loads from source and writes a snapshot', async () => {
  resetForTests();
  const key = freshKey();
  let calls = 0;
  const c = cache({ key, ttlMs: 60000, loader: async () => { calls++; return 'v1'; } });

  const got = await c.get();
  assert.equal(got.data, 'v1');
  assert.equal(calls, 1);

  await settle();
  assert.deepEqual((await store.readJson(key)).data, 'v1');
});

test('a fresh entry is served without touching the source again', async () => {
  resetForTests();
  const key = freshKey();
  let calls = 0;
  const c = cache({ key, ttlMs: 60000, loader: async () => { calls++; return calls; } });

  await c.get();
  await c.get();
  await c.get();
  assert.equal(calls, 1);
});

/* The heart of it: once any copy exists, nobody waits. The stale value comes back from this
   call and the new one only appears later — if this ever starts returning 'v2', an SPG in
   the field is waiting on a 13-second sheet read. */
test('a stale entry is served immediately while the refresh happens behind it', async () => {
  resetForTests();
  const key = freshKey();
  let value = 'v1';
  let calls = 0;
  const c = cache({ key, ttlMs: 0, loader: async () => { calls++; return value; } });

  assert.equal((await c.get()).data, 'v1');
  value = 'v2';

  const second = await c.get();
  assert.equal(second.data, 'v1', 'served the old copy rather than waiting');
  assert.equal(second.stale, true);

  await settle();
  assert.equal(calls, 2, 'and started a refresh anyway');
  assert.equal((await c.get()).data, 'v2');
});

test('concurrent misses collapse into a single upstream read', async () => {
  resetForTests();
  const key = freshKey();
  let calls = 0;
  const c = cache({
    key,
    ttlMs: 60000,
    loader: async () => { calls++; await new Promise(r => setTimeout(r, 20)); return 'v1'; },
  });

  const all = await Promise.all([c.get(), c.get(), c.get()]);
  assert.deepEqual(all.map(r => r.data), ['v1', 'v1', 'v1']);
  assert.equal(calls, 1);
});

test('a failed background refresh keeps serving the last good copy', async () => {
  resetForTests();
  const key = freshKey();
  let fail = false;
  const c = cache({
    key,
    ttlMs: 0,
    loader: async () => { if (fail) throw new Error('sheet unreachable'); return 'good'; },
  });

  await c.get();
  fail = true;
  const after = await c.get();
  assert.equal(after.data, 'good');
  await settle();
  assert.equal((await c.get()).data, 'good');
});

test('set() writes through without a read-back', async () => {
  resetForTests();
  const key = freshKey();
  let calls = 0;
  const c = cache({ key, ttlMs: 60000, loader: async () => { calls++; return 'from-sheet'; } });

  await c.get();
  c.set('from-write');
  assert.equal((await c.get()).data, 'from-write');
  assert.equal(calls, 1, 'the write-through value was not re-read from source');
});

/* What makes a deployed instance fast: the snapshot was written by something else entirely
   (scripts/sync-snapshot.js, or an earlier instance) and this process picks it up without
   ever calling the loader. */
test('an existing snapshot is adopted without loading from source', async () => {
  resetForTests();
  const key = freshKey();
  await store.writeJson(key, { data: 'from-snapshot', fetchedAt: Date.now() });

  let calls = 0;
  const c = cache({ key, ttlMs: 60000, loader: async () => { calls++; return 'from-sheet'; } });

  assert.equal((await c.get()).data, 'from-snapshot');
  assert.equal(calls, 0);
});

test('a snapshot past its TTL is still adopted, then refreshed behind the request', async () => {
  resetForTests();
  const key = freshKey();
  await store.writeJson(key, { data: 'old', fetchedAt: Date.now() - 999999 });

  let calls = 0;
  const c = cache({ key, ttlMs: 1000, loader: async () => { calls++; return 'new'; } });

  assert.equal((await c.get()).data, 'old', 'nobody waits, even for a snapshot this old');
  await settle();
  assert.equal(calls, 1);
});
