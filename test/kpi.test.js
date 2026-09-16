const { test } = require('node:test');
const assert = require('node:assert');
const { currentWeekRange, parseSheetDate } = require('../lib/kpi');

test('currentWeekRange spans Monday to Sunday and contains "now"', () => {
  const now = new Date(2026, 8, 14); // Mon 14 Sep 2026 (month is 0-indexed)
  const { start, end } = currentWeekRange(now);
  assert.strictEqual(start.getDay(), 1); // Monday
  assert.strictEqual(end.getDay(), 0); // Sunday
  assert.ok(start <= now && now <= end);
});

test('currentWeekRange handles a Sunday correctly (belongs to the week that just ended)', () => {
  const sunday = new Date(2026, 8, 13);
  const { start, end } = currentWeekRange(sunday);
  assert.strictEqual(start.getDate(), 7);
  assert.strictEqual(end.getDate(), 13);
});

test('parseSheetDate reads the sheet\'s "YYYY-MM-DD H:MM:SS" format', () => {
  const d = parseSheetDate('2026-09-14 0:00:00');
  assert.strictEqual(d.getFullYear(), 2026);
  assert.strictEqual(d.getMonth(), 8);
  assert.strictEqual(d.getDate(), 14);
});

test('parseSheetDate returns null for blank/invalid values', () => {
  assert.strictEqual(parseSheetDate(''), null);
  assert.strictEqual(parseSheetDate(undefined), null);
});

test('parseSheetDate reads the M/D/YYYY format used by Raw_Register and Raw_Creation', () => {
  const d = parseSheetDate('9/14/2026 11:43:57');
  assert.strictEqual(d.getFullYear(), 2026);
  assert.strictEqual(d.getMonth(), 8); // September — month-first, not 9 September
  assert.strictEqual(d.getDate(), 14);
});

test('parseSheetDate keeps single-digit month/day unambiguous', () => {
  const d = parseSheetDate('4/1/2026 10:01:20');
  assert.strictEqual(d.getMonth(), 3); // April
  assert.strictEqual(d.getDate(), 1);
});

test('remainingDaysInWeek counts today, so the last day of the batch is never 0', () => {
  const { remainingDaysInWeek } = require('../lib/kpi');
  const { end } = currentWeekRange(new Date(2026, 8, 15));
  assert.strictEqual(remainingDaysInWeek(new Date(2026, 8, 15), end), 6); // Tue -> Sun
  assert.strictEqual(remainingDaysInWeek(new Date(2026, 8, 20), end), 1); // Sunday itself
});

test('sourceState reports a tab with no rows this week as not live', () => {
  const { sourceState } = require('../lib/kpi');
  const { start, end } = currentWeekRange(new Date(2026, 8, 15));
  const stale = sourceState(['2026-07-20 0:00:00', '2026-07-19 0:00:00'], start, end);
  assert.strictEqual(stale.live, false);
  assert.strictEqual(stale.latest, '2026-07-20');
});

test('sourceState reports the latest date using local parts, not UTC', () => {
  const { sourceState } = require('../lib/kpi');
  const { start, end } = currentWeekRange(new Date(2026, 8, 15));
  const live = sourceState(['2026-09-14 0:00:00'], start, end);
  assert.strictEqual(live.live, true);
  assert.strictEqual(live.latest, '2026-09-14'); // not 2026-09-13
});
