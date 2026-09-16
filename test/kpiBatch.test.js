const test = require('node:test');
const assert = require('node:assert');
const { computeKpi } = require('../lib/kpi');

/* Fixtures for the batch path. The point of splitting fetch from compute was that one read of
   the 184k-row pipeline can answer for every SPG at once; these check that computing per
   SPG off shared columns gives each of them their own numbers and not a blend. */

const MONDAY = new Date(2026, 8, 14); // 14 Sep 2026 is a Monday
const IN_WEEK = '2026-09-15 0:00:00';
const LAST_WEEK = '2026-09-07 0:00:00';

const COLS = {
  regDate: [IN_WEEK, IN_WEEK, IN_WEEK, LAST_WEEK],
  regSpg: ['FMS-A', 'FMS-A', 'FMS-B', 'FMS-A'],
  creDate: [IN_WEEK, IN_WEEK],
  creSpg: ['FMS-A', 'FMS-B'],
  onbDate: [IN_WEEK, IN_WEEK, IN_WEEK],
  onbStatus: ['Lulus', 'Lulus', 'Tidak Lulus'],
  onbSpg: ['FMS-A', 'FMS-B', 'FMS-A'],
};

test('each SPG is counted separately from the same columns', () => {
  const a = computeKpi(COLS, 'FMS-A', MONDAY);
  const b = computeKpi(COLS, 'FMS-B', MONDAY);

  assert.equal(a.registered, 2, "A's third registration was last week");
  assert.equal(a.accountCreated, 1);
  assert.equal(a.onboarded, 1, "A's second onboarding was not 'Lulus'");

  assert.equal(b.registered, 1);
  assert.equal(b.accountCreated, 1);
  assert.equal(b.onboarded, 1);
});

test('an SPG with no rows at all reads as zero, not as missing data', () => {
  const none = computeKpi(COLS, 'FMS-NOBODY', MONDAY);
  assert.equal(none.registered, 0);
  assert.equal(none.onboarded, 0);
  // The tabs themselves are live this week, so zero here really is this SPG's zero.
  assert.equal(none.sources.registered.live, true);
});

/* The safety net from loadKpi's own comment, preserved through the refactor: a tab with no
   rows this week for *anyone* means the pipeline stalled, and reporting 0 would blame the
   SPG for it. */
test('a stalled source reports null rather than a confident zero', () => {
  const stalled = computeKpi({ ...COLS, regDate: [LAST_WEEK], regSpg: ['FMS-A'] }, 'FMS-A', MONDAY);
  assert.equal(stalled.registered, null);
  assert.equal(stalled.sources.registered.live, false);
  assert.equal(stalled.sources.registered.latest, '2026-09-07');
});

test('computing twice gives the same answer — no state leaks between SPGs', () => {
  const first = computeKpi(COLS, 'FMS-A', MONDAY);
  computeKpi(COLS, 'FMS-B', MONDAY);
  assert.deepEqual(computeKpi(COLS, 'FMS-A', MONDAY), first);
});
