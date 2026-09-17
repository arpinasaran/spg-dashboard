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

/* ---------- the reviewer's correction overlay (columns R-U) ----------
   The PRD lets a CF fix a proposal's name, category, hub or Maps link while approving it.
   Doing that by editing A-M would destroy what the SPG actually submitted, so the correction
   is written beside it and applied on read. These pin the three things that overlay has to
   get right: it wins when present, it disappears when blank, and it is only announced to the
   SPG when something genuinely changed. */

const base = [
  'PRP_OS212341_20260917T0900', '2026-09-17T09:00:00.000Z', 'OS212341', 'Tester',
  'Hub Lama', 'Bandung', 'Jawa Barat 1',
  'warung pojok', 'Kuliner', 'https://maps.app.goo.gl/asli',
  -6.9, 107.6, 'dekat gerbang', 'Menunggu', 'cf@spxexpress.com', '2026-09-17T11:00:00.000Z', 'Disahkan',
];

test('an untouched proposal reads back exactly as the SPG submitted it', () => {
  const p = proposals.rowToProposal(base);
  assert.equal(p.name, 'warung pojok');
  assert.equal(p.category, 'Kuliner');
  assert.equal(p.hub, 'Hub Lama');
  assert.deepEqual(p.corrections, []);
});

// A row written before columns R-U existed is 17 long, not 21. Destructuring gives undefined
// for the rest, and undefined must read as "no correction" rather than as a blank override.
test('a row from before the correction columns still parses', () => {
  const p = proposals.rowToProposal(base.slice());
  assert.equal(p.name, 'warung pojok');
  assert.deepEqual(p.corrections, []);
});

test('a correction wins over the original and says what it replaced', () => {
  const p = proposals.rowToProposal(base.concat(['', 'Warung Pojok Jl. Merdeka', 'Food & Beverage', '']));
  assert.equal(p.name, 'Warung Pojok Jl. Merdeka');
  assert.equal(p.category, 'Food & Beverage');
  // Untouched fields are not swept along.
  assert.equal(p.hub, 'Hub Lama');
  assert.equal(p.maps, 'https://maps.app.goo.gl/asli');
  assert.deepEqual(p.corrections, [
    { field: 'Nama', from: 'warung pojok', to: 'Warung Pojok Jl. Merdeka' },
    { field: 'Kategori', from: 'Kuliner', to: 'Food & Beverage' },
  ]);
  // What the SPG typed survives the overlay, which is the whole point of not editing A-M.
  assert.equal(p.proposedName, 'warung pojok');
});

test('a blank correction column leaves the original alone', () => {
  const p = proposals.rowToProposal(base.concat(['', '', '   ', '']));
  assert.equal(p.category, 'Kuliner');
  assert.deepEqual(p.corrections, []);
});

// A CF who retypes a value unchanged should not produce a "Diubah CF" line the SPG then has
// to compare character by character to discover that nothing happened.
test('retyping the same value is not a correction', () => {
  const p = proposals.rowToProposal(base.concat(['Hub Lama', ' warung pojok ', 'Kuliner', '']));
  assert.equal(p.name, 'warung pojok');
  assert.deepEqual(p.corrections, []);
});
