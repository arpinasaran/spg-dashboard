const test = require('node:test');
const assert = require('node:assert');
const proposals = require('../lib/poiProposals');

/* Whether this app may append to "POI Master" is a question only Google can answer, so
   lib/poiProposals.js asks by trying. That puts the whole behaviour on one predicate: read a
   refusal correctly and the SPG is told plainly that the feature is unavailable; read it
   wrongly and either a real outage is dressed up as a permissions problem, or a genuine
   refusal reaches the field as whatever wording Google chose. */

test('a refusal is recognised however the driver reports it', () => {
  // googleapis puts it on .code, and on .response.status when the raw response is attached.
  assert.equal(proposals.isPermissionDenied({ code: 403 }), true);
  assert.equal(proposals.isPermissionDenied({ response: { status: 403 } }), true);
  assert.equal(proposals.isPermissionDenied({ status: 401 }), true);
  // The gws driver shells out, so the API's error arrives as text with no status at all.
  assert.equal(proposals.isPermissionDenied({
    message: 'The caller does not have permission (PERMISSION_DENIED)',
  }), true);
});

// The opposite mistake matters just as much: calling a timeout or a bad range a permissions
// problem would tell an SPG to give up on a feature that is actually working.
test('an ordinary failure is not mistaken for a refusal', () => {
  assert.equal(proposals.isPermissionDenied({ code: 500 }), false);
  assert.equal(proposals.isPermissionDenied({ message: 'socket hang up' }), false);
  assert.equal(proposals.isPermissionDenied({ message: 'Unable to parse range' }), false);
  assert.equal(proposals.isPermissionDenied({}), false);
});

// Nothing in the deployment's own configuration should decide this any more. The previous
// version refused whenever the service-account driver was in use, which meant sharing the
// spreadsheet changed nothing — the refusal was about the driver, not about the sheet.
test('the verdict does not come from which driver is configured', () => {
  assert.equal(proposals.isPermissionDenied({ driver: 'google' }), false);
});

test('the message an SPG sees names what to do instead', () => {
  assert.match(proposals.DENIED, /belum bisa dikirim dari versi online/);
  assert.match(proposals.DENIED, /lokal/);
});
