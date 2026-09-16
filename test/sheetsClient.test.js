const test = require('node:test');
const assert = require('node:assert');
const { pickDriver, SURFACE } = require('../lib/sheetsClient');
const gws = require('../lib/gwsClient');
const googleClient = require('../lib/googleClient');

test('an explicit SHEETS_DRIVER wins over everything else', () => {
  assert.equal(pickDriver({ SHEETS_DRIVER: 'gws', GOOGLE_SERVICE_ACCOUNT_EMAIL: 'a@b.com' }), 'gws');
  assert.equal(pickDriver({ SHEETS_DRIVER: 'google' }), 'google');
});

test('service account credentials select the google driver', () => {
  assert.equal(pickDriver({ GOOGLE_SERVICE_ACCOUNT_EMAIL: 'a@b.com' }), 'google');
});

// A laptop with no service account configured must keep behaving exactly as it did before
// this file existed, or `npm start` stops working for whoever is developing.
test('a plain local environment stays on gws', () => {
  assert.equal(pickDriver({}), 'gws');
});

test('an unknown SHEETS_DRIVER is rejected rather than guessed at', () => {
  assert.throws(() => pickDriver({ SHEETS_DRIVER: 'sheets' }), /SHEETS_DRIVER/);
});

// The whole point of the seam is that callers cannot tell the two apart. If one driver grows
// a function the other lacks, a caller written against the richer one breaks only in
// production — this is the check that fails first instead.
test('both drivers implement the same surface', () => {
  for (const fn of SURFACE) {
    assert.equal(typeof gws[fn], 'function', `gwsClient is missing ${fn}`);
    assert.equal(typeof googleClient[fn], 'function', `googleClient is missing ${fn}`);
  }
});
