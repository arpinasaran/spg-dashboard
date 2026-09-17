const test = require('node:test');
const assert = require('node:assert');
const sheet = require('../lib/spgSheet');
const tz = require('../lib/timezone');

/* "SPG List LM" belongs to another team and has been restructured three times during this
   build. Each time the damage was silent — lib/cache.js keeps serving the last good snapshot
   and swallows a failed refresh, so a column that stops matching looks like nothing at all
   until the snapshot is lost. These fixtures are the layout as it actually stands. */

const HEADER_ROW = [
  '', 'OSID', 'FMSID', 'Entity', 'Join Date', 'Resign Date', 'Title', 'Primary Hub',
  'Kecamatan (L3)', 'City (L2)', 'Province (L1)', 'Region', 'Division',
  'Staff BPOM CF', 'TL BPOM CF', 'BPOM Lead',
];
// Invented rather than copied from the sheet: this repository is public, and a fixture only
// has to carry the shape of a row. The province is a real one because the zone assertion
// below depends on it being placeable.
const DATA_ROW = [
  'Contoh Nama', 'OS000001', 'Ops0000001', 'IPI', '4/25/2024', '', 'SPG', 'Contoh Hub',
  'CONTOH KECAMATAN', 'CONTOH KOTA', 'NUSA TENGGARA BARAT (NTB)', 'Bali-Nusra', 'LM',
  'cf@example.com', 'tl@example.com', 'lead@example.com',
];
// The real sheet carries an instruction row above the header, which is why the header is
// located rather than assumed to be first.
const PROBE = [['', '', ''], HEADER_ROW, DATA_ROW];

test('the header row is found without relying on the name column', () => {
  assert.equal(sheet.findHeader(PROBE, 'OSID', 'FMSID'), 1);
});

/* The third restructuring emptied the cell above the names instead of renaming it, so the
   accepted-names list could not absorb it. Losing the name is not a loud failure: attendance
   still records correctly against the OpsID, and what breaks is every screen that shows a
   person to a human. */
test('an unlabelled first column is still read as the name', () => {
  const col = sheet.columns(HEADER_ROW);
  assert.equal(col.get(DATA_ROW, 'name'), 'Contoh Nama');
  assert.deepEqual(col.missing(['name', 'opsId', 'fmsId', 'hub']), []);
});

// The narrowness is the point: position stops being evidence the moment the cell says
// anything, or the guess would outrank a real header on a sheet that gets reordered.
test('a labelled first column is never overridden by position', () => {
  const relabelled = ['Kecamatan (L3)', 'OSID', 'FMSID'];
  const col = sheet.columns(relabelled);
  assert.equal(col.has('name'), false);
  assert.match(col.missing(['name'])[0], /^name /);
});

/* Province is the one that cost something real. lib/timezone.js places an SPG in WIB, WITA
   or WIT by it, and an unmatched column reads as blank rather than as an error — so the zone
   fell back to WIB and Lombok was quietly reported an hour off. */
test('the administrative-level suffixes still resolve to a place', () => {
  const col = sheet.columns(HEADER_ROW);
  assert.equal(col.get(DATA_ROW, 'province'), 'NUSA TENGGARA BARAT (NTB)');
  assert.equal(col.get(DATA_ROW, 'city'), 'CONTOH KOTA');
  assert.equal(col.get(DATA_ROW, 'region'), 'Bali-Nusra');
});

test('and that province lands this SPG in the zone she actually keeps', () => {
  const col = sheet.columns(HEADER_ROW);
  assert.equal(tz.zoneNameFor(col.get(DATA_ROW, 'province')), 'WITA');
});

// Older names must keep working: the snapshot in Drive may predate any of this.
test('the previous names for the same columns still match', () => {
  const old = ['Name', 'OSID', 'FMSID', 'Location', 'City', 'Province', 'Region'];
  const col = sheet.columns(old);
  const row = ['Siti', 'OS1', 'Ops1', 'Hub A', 'Denpasar', 'BALI', 'Bali-Nusra'];
  assert.equal(col.get(row, 'name'), 'Siti');
  assert.equal(col.get(row, 'hub'), 'Hub A');
  assert.equal(col.get(row, 'province'), 'BALI');
});

test('a genuinely unrecognisable sheet still fails loudly', () => {
  assert.throws(
    () => sheet.findHeader([['a', 'b'], ['c', 'd']], 'OSID', 'FMSID'),
    /Header row \(OSID\/FMSID\) not found/,
  );
});

/* ---------- which of the two ids a session is written under ----------
   "SPG List LM" carries both OSID and FMSID, and a read-only check of all 503 live rows found
   them different on every single one. The supervisor board joins its roster on FMSID and
   compares it straight against "Attendance Sessions" column B, so writing OSID there produces
   sessions that match nobody: every row reads as off-roster and the board looks empty to every
   CF while the writes are in fact landing. Admins never see it, because seesAll skips the
   check. That failure is silent in both directions, so the choice is pinned here. */

test('a person is identified by FMSID, not OSID', () => {
  const header = ['Name', 'OSID', 'FMSID', 'Primary Hub'];
  const col = sheet.columns(header);
  const row = ['Tester', 'OS212341', 'OPS4417', 'QA Hub'];

  assert.equal(col.get(row, 'opsId'), 'OPS4417');
  // The onboarding pipeline joins on this name; it must stay the same column.
  assert.equal(col.get(row, 'fmsId'), 'OPS4417');
  // OSID is not thrown away -- other teams index the sheet on it.
  assert.equal(col.get(row, 'osId'), 'OS212341');
});

// The guard that made the old behaviour survivable: neither column may quietly vanish.
test('a sheet missing either id column is refused, not guessed at', () => {
  assert.throws(() => sheet.findHeader([['Name', 'FMSID', 'Primary Hub']], 'OSID', 'FMSID'), /Header row/);
  assert.throws(() => sheet.findHeader([['Name', 'OSID', 'Primary Hub']], 'OSID', 'FMSID'), /Header row/);
});
