const { test } = require('node:test');
const assert = require('node:assert');
const { cellState, describeFlag, buildDays } = require('../lib/admin');
const sheet = require('../lib/spgSheet');
const attendance = require('../lib/attendance');

const workday = { date: '2026-09-14', isRest: false, isToday: false };
const today = { date: '2026-09-16', isRest: false, isToday: true };
const sunday = { date: '2026-09-13', isRest: true, isToday: false };

const session = over => ({
  inTime: '2026-09-14T08:10:00.000Z',
  outTime: '2026-09-14T16:40:00.000Z',
  inStatus: 'On Time',
  reviewStatus: 'Pending',
  ...over,
});

test('a day with no session reads as absent, and as a rest day on Sunday', () => {
  assert.strictEqual(cellState(null, [], workday), 'none');
  assert.strictEqual(cellState(null, [], sunday), 'rest');
});

test('a flagged session outranks lateness — the board exists to surface what needs a human', () => {
  const late = session({ inStatus: 'Late' });
  assert.strictEqual(cellState(late, [], workday), 'late');
  assert.strictEqual(cellState(late, ['OUT_OF_RADIUS'], workday), 'review');
});

test('a decided session stays decided even though its flags are still attached', () => {
  const flags = ['OUT_OF_RADIUS'];
  assert.strictEqual(cellState(session({ reviewStatus: 'Approved' }), flags, workday), 'approved');
  assert.strictEqual(cellState(session({ reviewStatus: 'Rejected' }), flags, workday), 'rejected');
});

test('a missing clock-out is "still out there" today but a hanging session on a past day', () => {
  const open = session({ outTime: null });
  assert.strictEqual(cellState(open, [], today), 'open');
  assert.strictEqual(cellState(open, [], workday), 'unfinished');
});

test('buildDays ends on today and counts back the requested number of days', () => {
  const days = buildDays(14, new Date(2026, 8, 16));
  assert.strictEqual(days.length, 14);
  assert.strictEqual(days[13].date, '2026-09-16');
  assert.strictEqual(days[13].isToday, true);
  assert.strictEqual(days[0].date, '2026-09-03');
  assert.ok(days.filter(d => d.isRest).every(d => new Date(d.date + 'T00:00:00').getDay() === 0));
});

test('an unknown flag code is still shown to the reviewer rather than swallowed', () => {
  const d = describeFlag('SOMETHING_NEW');
  assert.strictEqual(d.label, 'SOMETHING_NEW');
  assert.ok(d.detail.length > 0);
});

test('the unverified-POI flag is worded as doubt about the pin, not about the person', () => {
  const strict = describeFlag('OUT_OF_RADIUS');
  const soft = describeFlag('OUT_OF_RADIUS_UNVERIFIED_POI');
  assert.notStrictEqual(strict.label, soft.label);
  assert.ok(soft.weight < strict.weight, 'the softer flag must sort below the strict one');
});

// "SPG List LM" was restructured mid-project: Location/City/Region became Primary Hub /
// Primary City / Primary Region. Reading it froze silently, because the cache kept serving
// the last good snapshot. These lock in that both spellings still resolve.
test('roster columns resolve under both the old and the new sheet headings', () => {
  const oldHeader = ['Name', 'OSID', 'FMSID', 'Location', 'City', 'Region', 'Resign Date'];
  const newHeader = ['Name', 'OSID', 'FMSID', 'Entity', 'Join Date', 'Resign Date', 'Title',
    'Primary Hub', 'Primary City', 'Primary Province', 'Primary Region', 'Division',
    'Staff BPOM CF', 'TL BPOM CF', 'BPOM Lead', 'Email'];

  const oldCols = sheet.columns(oldHeader);
  const newCols = sheet.columns(newHeader);
  const oldRow = ['Ani', 'OS1', 'Ops1', 'Sambalia Hub', 'Lombok Timur', 'Bali-Nusra', ''];
  const newRow = ['Ani', 'OS1', 'Ops1', 'IPI', '1/1/2024', '', 'SPG',
    'Sambalia Hub', 'KAB. LOMBOK TIMUR', 'NTB', 'Bali-Nusra', 'LM',
    'cf@x.com', 'tl@x.com', 'lead@x.com', 'ani@x.com'];

  assert.strictEqual(oldCols.get(oldRow, 'hub'), 'Sambalia Hub');
  assert.strictEqual(newCols.get(newRow, 'hub'), 'Sambalia Hub');
  assert.strictEqual(oldCols.get(oldRow, 'region'), 'Bali-Nusra');
  assert.strictEqual(newCols.get(newRow, 'region'), 'Bali-Nusra');
});

test('only the new layout carries the CF mapping, and columns.has() says so', () => {
  const oldCols = sheet.columns(['Name', 'OSID', 'FMSID', 'Location']);
  const newCols = sheet.columns(['Name', 'OSID', 'FMSID', 'Primary Hub', 'Staff BPOM CF']);
  assert.strictEqual(oldCols.has('cfEmail'), false);
  assert.strictEqual(newCols.has('cfEmail'), true);
});

test('missing() names the field and every spelling it looked for', () => {
  const cols = sheet.columns(['Name', 'OSID']);
  const missing = cols.missing(['hub']);
  assert.strictEqual(missing.length, 1);
  assert.match(missing[0], /hub/);
  assert.match(missing[0], /Primary Hub/);
  assert.match(missing[0], /Location/);
});

// Column O of "Attendance Sessions" is named "Review Reason". Clock-in used to write the
// validation flags into it, so recording a reason destroyed the triage data behind it.
test('session flags come from the event rows, leaving Review Reason to the reviewer', () => {
  const row = ['OS1_2026-09-14', 'OS1', 'Ani', '2026-09-14',
    'OS1_2026-09-14_in', '2026-09-14T08:10:00.000Z', 'On Time',
    'OS1_2026-09-14_out', '2026-09-14T16:40:00.000Z', 'Normal',
    'Berhasil', '', 'Needs Review', 'Needs Review',
    'Sudah dicek lewat foto.', 'cf@x.com', '2026-09-16T09:00:00.000Z',
    '2026-09-14T16:40:00.000Z'];

  const session = attendance.rowToSession(row);
  assert.strictEqual(session.reviewReason, 'Sudah dicek lewat foto.');
  assert.strictEqual(session.reviewedBy, 'cf@x.com');
  assert.deepStrictEqual(session.flags, []);

  const withFlags = attendance.withEvents(session, {
    in: { flags: ['OUT_OF_RADIUS'] },
    out: { flags: ['EARLY_CLOCKOUT', 'OUT_OF_RADIUS'] },
  });
  assert.deepStrictEqual(withFlags.flags, ['OUT_OF_RADIUS', 'EARLY_CLOCKOUT']);
  assert.strictEqual(withFlags.reviewReason, 'Sudah dicek lewat foto.');
});
