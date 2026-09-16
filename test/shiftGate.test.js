const test = require('node:test');
const assert = require('node:assert');
const { shiftGate, formatLeft } = require('../lib/attendance');
const config = require('../config');

/* Clock-out is locked until a full shift has been worked. The old rules were times of day —
   late after 10:00, early before 16:00 — which quietly punished anyone whose day legitimately
   started at 11. What is measured now is how long, not when. */

const H = 3600000;
const IN = new Date('2026-09-16T02:00:00.000Z');

test('the gate opens exactly minShiftHours after clock-in', () => {
  const unlock = new Date(IN.getTime() + config.rules.minShiftHours * H);

  assert.equal(shiftGate(IN.toISOString(), new Date(unlock.getTime() - 1000)).unlocked, false);
  assert.equal(shiftGate(IN.toISOString(), unlock).unlocked, true);
  assert.equal(shiftGate(IN.toISOString(), new Date(unlock.getTime() + 1000)).unlocked, true);
});

test('it reports the moment it opens, so the UI can count down to it', () => {
  const g = shiftGate(IN.toISOString(), IN);
  assert.equal(new Date(g.unlocksAt).getTime(), IN.getTime() + config.rules.minShiftHours * H);
  assert.equal(g.msLeft, config.rules.minShiftHours * H);
  assert.equal(g.minShiftHours, config.rules.minShiftHours);
});

test('time remaining never goes negative once the gate is open', () => {
  const late = new Date(IN.getTime() + 50 * H);
  assert.equal(shiftGate(IN.toISOString(), late).msLeft, 0);
});

/* A session with no usable clock-in time must not be locked forever. Nothing should produce
   one, but a hand-edited row could, and the failure that matters is an SPG unable to close
   their day — not a missing check on data that is already broken. */
test('an unreadable clock-in time leaves the gate open rather than stuck shut', () => {
  for (const bad of [null, undefined, '', 'bukan tanggal']) {
    const g = shiftGate(bad, IN);
    assert.equal(g.unlocked, true, `should not lock on ${JSON.stringify(bad)}`);
    assert.equal(g.unlocksAt, null);
  }
});

test('the countdown reads the way someone would say it', () => {
  assert.equal(formatLeft(3 * H + 20 * 60000), '3 jam 20 menit');
  assert.equal(formatLeft(2 * H), '2 jam');
  assert.equal(formatLeft(45 * 60000), '45 menit');
  // Rounded up: saying "0 menit" while the button is still locked reads as a broken app.
  assert.equal(formatLeft(30000), '1 menit');
});

test('nine hours is the configured minimum', () => {
  assert.equal(config.rules.minShiftHours, 9);
  // The rules this replaced should be gone, not merely unused — a stale key invites code that
  // reads it and silently gets undefined.
  assert.equal(config.rules.lateAfterHour, undefined);
  assert.equal(config.rules.earlyBeforeHour, undefined);
});
