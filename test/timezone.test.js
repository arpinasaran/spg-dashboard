const test = require('node:test');
const assert = require('node:assert');
const tz = require('../lib/timezone');
const attendance = require('../lib/attendance');

/* Indonesia spans WIB/WITA/WIT and this code may run in none of them. The bug these guard
   against is quiet: a session filed under the wrong calendar day still looks like a perfectly
   ordinary row. */

// 2026-09-15 23:30 UTC is already 06:30 on the 16th in Jakarta. A host reading its own clock
// would file that morning's clock-in under the 15th.
const EARLY_MORNING_WIB = new Date('2026-09-15T23:30:00.000Z');

test('the calendar day is measured in Indonesia, not on the host', () => {
  assert.equal(tz.dateStr(EARLY_MORNING_WIB), '2026-09-16');
  // Same instant, read as UTC, is the previous day — which is exactly the mistake.
  assert.equal(tz.dateStr(EARLY_MORNING_WIB, 'UTC'), '2026-09-15');
});

test('attendance uses that same boundary for its session dates', () => {
  assert.equal(attendance.localDateStr(EARLY_MORNING_WIB), '2026-09-16');
});

// Midnight WIB is 01:00 WITA and 02:00 WIT, so one shared boundary never lands inside a shift
// anywhere in the country — the reason it is one zone for everybody rather than per SPG.
test('the boundary falls in the middle of the night in every Indonesian zone', () => {
  const midnightWib = new Date('2026-09-15T17:00:00.000Z');
  const hourIn = (iana) => Number(new Intl.DateTimeFormat('en-GB', {
    timeZone: iana, hour: '2-digit', hour12: false,
  }).format(midnightWib));

  assert.equal(hourIn('Asia/Jakarta'), 0);
  assert.equal(hourIn('Asia/Makassar'), 1);
  assert.equal(hourIn('Asia/Jayapura'), 2);
});

test('adding days walks the calendar, not 24-hour blocks', () => {
  assert.equal(tz.addDays(EARLY_MORNING_WIB, 14), '2026-09-30');
  assert.equal(tz.addDays(EARLY_MORNING_WIB, 0), '2026-09-16');
  assert.equal(tz.addDays(EARLY_MORNING_WIB, -1), '2026-09-15');
  // Across a month end.
  assert.equal(tz.addDays(new Date('2026-09-30T10:00:00.000Z'), 1), '2026-10-01');
});

test('a province is placed in the zone it actually keeps', () => {
  assert.equal(tz.zoneNameFor('Nusa Tenggara Barat'), 'WITA'); // Lombok — where this SPG is
  assert.equal(tz.zoneNameFor('BALI'), 'WITA');
  assert.equal(tz.zoneNameFor('Sulawesi Selatan'), 'WITA');
  assert.equal(tz.zoneNameFor('Papua'), 'WIT');
  assert.equal(tz.zoneNameFor('MALUKU UTARA'), 'WIT');
  assert.equal(tz.zoneNameFor('Jawa Barat'), 'WIB');
  assert.equal(tz.zoneNameFor('Sumatera Utara'), 'WIB');
});

// The roster spells provinces inconsistently, and a blank cell must not throw.
test('an unknown or missing province falls back rather than failing', () => {
  assert.equal(tz.zoneNameFor(''), 'WIB');
  assert.equal(tz.zoneNameFor(null), 'WIB');
  assert.equal(tz.zoneNameFor('Entah Di Mana'), 'WIB');
});

test('a time can be quoted in the zone the SPG actually reads', () => {
  const noonWib = new Date('2026-09-16T05:00:00.000Z');
  assert.equal(tz.clockStr(noonWib, 'Jawa Barat'), '12.00');
  assert.equal(tz.clockStr(noonWib, 'Nusa Tenggara Barat'), '13.00');
  assert.equal(tz.clockStr(noonWib, 'Papua'), '14.00');
});

/* The point worth keeping: the shift gate is a duration, so none of the above touches it.
   Nine hours is nine hours regardless of which zone either end is read in. */
test('the shift gate is unaffected by time zones', () => {
  const start = '2026-09-15T23:30:00.000Z';
  const nineHoursLater = new Date('2026-09-16T08:30:00.000Z');
  const aMinuteShort = new Date('2026-09-16T08:29:00.000Z');

  assert.equal(attendance.shiftGate(start, nineHoursLater).unlocked, true);
  assert.equal(attendance.shiftGate(start, aMinuteShort).unlocked, false);
});
