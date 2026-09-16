const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const store = require('../lib/store');

test('an explicit STORE_DRIVER wins over inference', () => {
  assert.equal(store.pickStore({ STORE_DRIVER: 'disk', GOOGLE_SERVICE_ACCOUNT_EMAIL: 'a@b.com' }), 'disk');
  assert.equal(store.pickStore({ STORE_DRIVER: 'drive' }), 'drive');
});

test('service account credentials select the drive store', () => {
  assert.equal(store.pickStore({ GOOGLE_SERVICE_ACCOUNT_EMAIL: 'a@b.com' }), 'drive');
});

test('a plain local environment keeps writing to data/cache', () => {
  assert.equal(store.pickStore({}), 'disk');
});

test('an unknown STORE_DRIVER is rejected rather than guessed at', () => {
  assert.throws(() => store.pickStore({ STORE_DRIVER: 'blob' }), /STORE_DRIVER/);
});

/* Keys reach both drivers as filenames, and the drive one writes into a folder that also
   holds attendance photos. These are the shapes cache.js actually produces — hub names are
   already slugged by poi.js, and opsId/fmsId come off a sheet. */
test('the keys cache.js generates are accepted', () => {
  for (const key of ['identity-OS212341', 'poi-batam-hub', 'kpi-Ops1622838', 'attendance-store', 'poi-registry']) {
    assert.equal(store.assertKey(key), key);
  }
});

test('a key that could escape the folder or collide is refused, not sanitised', () => {
  for (const bad of ['../secrets', 'a/b', '', null, 'x'.repeat(121), 'name with spaces']) {
    assert.throws(() => store.assertKey(bad), /Key snapshot tidak valid/, `should refuse ${JSON.stringify(bad)}`);
  }
});

test('the disk store round-trips a snapshot and lists it', async () => {
  const key = `test-store-${process.pid}`;
  const file = path.join(store.DISK_DIR, `${key}.json`);
  try {
    assert.equal(await store.readJson(key), null, 'a key never written reads as null');
    await store.writeJson(key, { data: [1, 2, 3], fetchedAt: 1700000000000 });
    assert.deepEqual(await store.readJson(key), { data: [1, 2, 3], fetchedAt: 1700000000000 });
    assert.ok((await store.listKeys()).includes(key));
  } finally {
    fs.rmSync(file, { force: true });
  }
});

// cache.js swallows snapshot failures on purpose, so a corrupt file must read as "nothing
// cached" rather than throw — otherwise one bad write breaks every later boot.
test('a corrupt snapshot reads as absent instead of throwing', async () => {
  const key = `test-corrupt-${process.pid}`;
  const file = path.join(store.DISK_DIR, `${key}.json`);
  fs.mkdirSync(store.DISK_DIR, { recursive: true });
  fs.writeFileSync(file, '{not json');
  try {
    assert.equal(await store.readJson(key), null);
  } finally {
    fs.rmSync(file, { force: true });
  }
});
