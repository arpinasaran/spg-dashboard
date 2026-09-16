const { test } = require('node:test');
const assert = require('node:assert');
const { localDateStr, addDaysLocalStr } = require('../lib/attendance');

test('localDateStr formats using local date parts, not UTC', () => {
  const d = new Date(2026, 8, 5); // 5 Sep 2026
  assert.strictEqual(localDateStr(d), '2026-09-05');
});

test('addDaysLocalStr adds calendar days and formats the same way', () => {
  const d = new Date(2026, 8, 14);
  assert.strictEqual(addDaysLocalStr(d, 14), '2026-09-28');
});

test('addDaysLocalStr rolls over a month boundary correctly', () => {
  const d = new Date(2026, 8, 20);
  assert.strictEqual(addDaysLocalStr(d, 14), '2026-10-04');
});
