const test = require('node:test');
const assert = require('node:assert');

/* What this file locks down: the shape of every write attendance makes to the shared
   spreadsheet, and what happens when one of them does not go to plan.

   These are the failures an audit found in the write path — a clock-out addressing a row by
   its position in a stale cache, a retry reported as a refusal, a review erased by the shift
   it belonged to. None of them show up in a test that only checks return values, because all
   of them are about WHICH CELLS were written. So the fake below is a spreadsheet: it applies
   ranges the way Sheets does, and the assertions are about the cells afterwards. */

const COL = {
  SESSION_ID: 0, OPS_ID: 1, NAME: 2, DATE: 3,
  IN_EVENT: 4, IN_TIME: 5, IN_STATUS: 6,
  OUT_EVENT: 7, OUT_TIME: 8, OUT_STATUS: 9,
  ACT_RESULT: 10, ACT_NOTE: 11, OVERALL: 12,
  REVIEW_STATUS: 13, REVIEW_REASON: 14, REVIEWED_BY: 15, REVIEWED_AT: 16, UPDATED_AT: 17,
};
const EVENT_TXN = 16;

function colIndex(letters) {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

// "'Attendance Sessions'!H5:M5" -> { tab, startCol, endCol, startRow }
function parseRange(range) {
  const m = /^'([^']+)'!([A-Z]+)(\d*)(?::([A-Z]+)(\d*))?$/.exec(range);
  if (!m) throw new Error(`fake sheet cannot parse range: ${range}`);
  return {
    tab: m[1],
    startCol: colIndex(m[2]),
    startRow: m[3] ? Number(m[3]) : null,
    endCol: m[4] ? colIndex(m[4]) : null,
  };
}

/* A spreadsheet with two tabs, addressed the way the real one is: row 2 is the first data
   row, appends land after the last populated row, and an update touches exactly the columns
   named in its range and no others. That last property is the whole point — it is what makes
   "the review survived the clock-out" a thing a test can actually observe. */
function fakeSheet() {
  const tabs = { 'Attendance Sessions': [], 'Attendance Events': [], 'Review Audit Log': [] };
  const writes = [];

  function slice(tab, range) {
    const rows = tabs[range.tab] || [];
    return rows.map(r => {
      const end = range.endCol == null ? r.length : range.endCol + 1;
      return r.slice(range.startCol, end);
    });
  }

  const api = {
    tabs,
    writes,
    async batchGet(_id, ranges) {
      return ranges.map(raw => ({ range: raw, values: slice(null, parseRange(raw)) }));
    },
    async readRange(_id, raw) {
      return slice(null, parseRange(raw));
    },
    async valuesAppend(_id, raw, values) {
      const range = parseRange(raw);
      const rows = tabs[range.tab];
      const startRow = rows.length + 2;
      for (const v of values) rows.push(v.slice());
      writes.push({ kind: 'append', tab: range.tab, values });
      return { updates: { updatedRange: `'${range.tab}'!A${startRow}:R${startRow + values.length - 1}` } };
    },
    async valuesUpdate(_id, raw, values) {
      const range = parseRange(raw);
      const rows = tabs[range.tab];
      const rowIdx = range.startRow - 2;
      while (rows.length <= rowIdx) rows.push([]);
      const target = rows[rowIdx];
      values[0].forEach((v, i) => { target[range.startCol + i] = v; });
      writes.push({ kind: 'update', tab: range.tab, range: raw, startCol: range.startCol, endCol: range.endCol, values });
      return {};
    },
    // Unused by these paths, present so a stray call fails loudly rather than silently.
    async batchUpdate() { throw new Error('batchUpdate not expected here'); },
    async listTabs() { return Object.keys(tabs).map(title => ({ title })); },
    async driveUpload({ name }) { return { id: `fileid-${name}`, name }; },
    async driveDownload() { return Buffer.from('x'); },
    async driveFindFolder() { return { id: 'folder' }; },
    async driveCreateFolder() { return { id: 'folder' }; },
  };
  return api;
}

// Install the fake before anything requires the real client, then hand back a freshly
// registered attendance module with an empty cache registry.
function load(sheet) {
  for (const key of Object.keys(require.cache)) {
    if (key.includes(`${require('path').sep}lib${require('path').sep}`)) delete require.cache[key];
  }
  const resolved = require.resolve('../lib/sheetsClient');
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: sheet };
  return require('../lib/attendance');
}

const OPS = 'OS212341';
const WIB = '+07:00';

function sessionRow({ sessionId, opsId = OPS, date, inEventId, inTime, review = [] }) {
  const row = [
    sessionId, opsId, 'Tester', date,
    inEventId, inTime, 'Clocked In',
    '', '', '', '', '', 'Clocked In',
  ];
  review.forEach((v, i) => { row[COL.REVIEW_STATUS + i] = v; });
  return row;
}

const PHOTO = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';

function submission(extra = {}) {
  return {
    opsId: OPS, spgName: 'Tester',
    poiId: 'other', poiName: null, note: 'di luar daftar',
    lat: -8.5, lng: 116.5, accuracy: 12,
    deviceTime: '2026-09-17T01:00:00.000Z',
    photoDataUrl: PHOTO,
    ...extra,
  };
}

/* ---------- the column contract ---------- */

test('clock-in writes A-M and leaves the dashboard columns untouched', async () => {
  const sheet = fakeSheet();
  const attendance = load(sheet);

  await attendance.clockIn(submission({ txnId: 'txn-clockin-0001' }));

  const row = sheet.tabs['Attendance Sessions'][0];
  assert.equal(row.length, 13, 'a session row is created with A-M and nothing beyond it');
  assert.equal(row[COL.REVIEW_STATUS], undefined, 'Review Status is the dashboard to write, not ours');
  assert.equal(row[COL.UPDATED_AT], undefined, 'column R is the dashboard optimistic-lock token');
});

test('clock-out writes only H-M, so a review recorded mid-shift survives it', async () => {
  const sheet = fakeSheet();
  const attendance = load(sheet);
  const now = new Date('2026-09-17T10:00:00.000Z');
  const inTime = new Date('2026-09-17T00:00:00.000Z').toISOString(); // 10 hours earlier

  sheet.tabs['Attendance Sessions'].push(sessionRow({
    sessionId: `${OPS}_2026-09-17`, date: '2026-09-17',
    inEventId: `${OPS}_2026-09-17_in`, inTime,
    // A CF reviewed this day while the shift was still running.
    review: ['Accepted - Reviewed', 'sudah dicek langsung', 'cf@spxexpress.com', '2026-09-17T09:00:00.000Z', '2026-09-17T09:00:00.000Z'],
  }));
  sheet.tabs['Attendance Events'].push([
    `${OPS}_2026-09-17_in`, `${OPS}_2026-09-17`, OPS, 'Clock In', 'other', '',
    -8.5, 116.5, 10, '', '', inTime, 'drive:x', '', '', 'NO_REFERENCE', 'txn-in',
  ]);

  await attendance.clockOut(submission({ txnId: 'txn-clockout-0001', now, activityResult: 'Aktivitas selesai' }));

  const row = sheet.tabs['Attendance Sessions'][0];
  assert.equal(row[COL.OUT_EVENT], `${OPS}_2026-09-17_out`, 'the clock-out was recorded');
  assert.equal(row[COL.OVERALL], 'Clocked Out');

  assert.equal(row[COL.REVIEW_STATUS], 'Accepted - Reviewed', 'the review is still there');
  assert.equal(row[COL.REVIEW_REASON], 'sudah dicek langsung');
  assert.equal(row[COL.REVIEWED_BY], 'cf@spxexpress.com');
  assert.equal(row[COL.UPDATED_AT], '2026-09-17T09:00:00.000Z',
    'column R is untouched, so the dashboard concurrency check still passes');

  const update = sheet.writes.find(w => w.kind === 'update' && w.tab === 'Attendance Sessions');
  assert.equal(update.startCol, COL.OUT_EVENT, 'range starts at H');
  assert.equal(update.endCol, COL.OVERALL, 'range ends at M — N onwards is not ours');
});

test('the clock-out row is located by a fresh read, not by its index in the cache', async () => {
  const sheet = fakeSheet();
  const attendance = load(sheet);
  const now = new Date('2026-09-17T10:00:00.000Z');
  const inTime = new Date('2026-09-17T00:00:00.000Z').toISOString();

  // Another instance appended two rows for other people before ours.
  sheet.tabs['Attendance Sessions'].push(
    sessionRow({ sessionId: 'OS000001_2026-09-17', opsId: 'OS000001', date: '2026-09-17', inEventId: 'a', inTime }),
    sessionRow({ sessionId: `${OPS}_2026-09-17`, date: '2026-09-17', inEventId: `${OPS}_2026-09-17_in`, inTime }),
    sessionRow({ sessionId: 'OS000002_2026-09-17', opsId: 'OS000002', date: '2026-09-17', inEventId: 'c', inTime }),
  );

  await attendance.clockOut(submission({ txnId: 'txn-rowlookup-01', now }));

  assert.equal(sheet.tabs['Attendance Sessions'][1][COL.OUT_EVENT], `${OPS}_2026-09-17_out`);
  assert.equal(sheet.tabs['Attendance Sessions'][0][COL.OUT_EVENT], '', 'the row above was not touched');
  assert.equal(sheet.tabs['Attendance Sessions'][2][COL.OUT_EVENT], '', 'nor the row below');

  const update = sheet.writes.find(w => w.kind === 'update');
  assert.match(update.range, /!H3:M3$/, 'row 3 on the sheet — found by session id, not by array position');
});

/* ---------- idempotency ---------- */

test('a retry carrying the same transaction id is a success, not a refusal', async () => {
  const sheet = fakeSheet();
  const attendance = load(sheet);
  const now = new Date('2026-09-17T02:00:00.000Z');

  const first = await attendance.clockIn(submission({ txnId: 'txn-same-0001', now }));
  assert.equal(first.replayed, false);
  const rowsAfterFirst = sheet.tabs['Attendance Sessions'].length;

  const second = await attendance.clockIn(submission({ txnId: 'txn-same-0001', now }));

  assert.equal(second.replayed, true, 'the server recognised its own earlier write');
  assert.equal(second.sessionId, first.sessionId);
  assert.equal(second.eventId, first.eventId);
  assert.equal(sheet.tabs['Attendance Sessions'].length, rowsAfterFirst, 'no second session row');
  assert.equal(sheet.tabs['Attendance Events'].length, 1, 'no second event row');
});

test('the transaction id is written to the column the schema reserved for it', async () => {
  const sheet = fakeSheet();
  const attendance = load(sheet);

  await attendance.clockIn(submission({ txnId: 'txn-column-001', now: new Date('2026-09-17T02:00:00.000Z') }));

  assert.equal(sheet.tabs['Attendance Events'][0][EVENT_TXN], 'txn-column-001',
    'Attendance Events column Q is named "Idempotency Key" and now holds one');
});

test('a genuinely different submission for a day already taken is a conflict', async () => {
  const sheet = fakeSheet();
  const attendance = load(sheet);
  const now = new Date('2026-09-17T02:00:00.000Z');

  await attendance.clockIn(submission({ txnId: 'txn-first-0001', now }));
  await assert.rejects(
    () => attendance.clockIn(submission({ txnId: 'txn-second-002', now })),
    (err) => {
      assert.equal(err.status, 409, 'a conflict, not a generic 400');
      assert.equal(err.sessionId, `${OPS}_2026-09-17`, 'and it says which session already holds the day');
      return true;
    },
  );
  assert.equal(sheet.tabs['Attendance Sessions'].length, 1);
});

test('a submission with no usable transaction id is refused before anything is written', async () => {
  const sheet = fakeSheet();
  const attendance = load(sheet);

  for (const bad of [undefined, '', 'short', 'has spaces in it', 'x'.repeat(65)]) {
    await assert.rejects(
      () => attendance.clockIn(submission({ txnId: bad })),
      (err) => err.status === 400,
      `"${bad}" should be refused`,
    );
  }
  assert.equal(sheet.writes.length, 0, 'nothing reached the sheet');
});

test('a clock-in whose event row never landed is reported as recoverable', async () => {
  const sheet = fakeSheet();
  const attendance = load(sheet);
  const now = new Date('2026-09-17T02:00:00.000Z');

  // The state a crash between the two writes leaves behind: the day is claimed, the evidence
  // is not there, and no event carries the transaction id.
  sheet.tabs['Attendance Sessions'].push(sessionRow({
    sessionId: `${OPS}_2026-09-17`, date: '2026-09-17',
    inEventId: `${OPS}_2026-09-17_in`, inTime: now.toISOString(),
  }));

  await assert.rejects(
    () => attendance.clockIn(submission({ txnId: 'txn-partial-001', now })),
    (err) => {
      assert.equal(err.status, 409);
      assert.equal(err.recoverable, true, 'the browser is told to offer another attempt');
      return true;
    },
  );
});

/* ---------- shifts that cross midnight ---------- */

test('a session started in the afternoon is still open after midnight', () => {
  const sheet = fakeSheet();
  const attendance = load(sheet);

  // 16:00 WIB on 16 Sep; the clock-out gate opens at 01:00 WIB on the 17th.
  const inTime = new Date(`2026-09-16T16:00:00${WIB}`).toISOString();
  const sessions = [sessionRow({
    sessionId: `${OPS}_2026-09-16`, date: '2026-09-16', inEventId: 'in', inTime,
  })];

  const atOneAm = new Date(`2026-09-17T01:30:00${WIB}`);
  assert.equal(attendance.findOpenSessionIdx(sessions, OPS, atOneAm), 0,
    "yesterday's session is what the SPG is still doing");
  assert.equal(attendance.sessionIsHanging(inTime, false, atOneAm), false);
});

test('the clock-out deadline is midnight in Indonesia, not midnight on the host', () => {
  const sheet = fakeSheet();
  const attendance = load(sheet);

  const inTime = new Date(`2026-09-16T16:00:00${WIB}`);
  const closes = attendance.clockOutClosesAt(inTime);

  // Gate opens 01:00 WIB on the 17th, so the day closes at 00:00 WIB on the 18th.
  assert.equal(closes.toISOString(), new Date(`2026-09-18T00:00:00${WIB}`).toISOString());

  assert.equal(attendance.sessionIsHanging(inTime.toISOString(), false, new Date(`2026-09-17T23:00:00${WIB}`)), false);
  assert.equal(attendance.sessionIsHanging(inTime.toISOString(), false, new Date(`2026-09-18T00:30:00${WIB}`)), true);
});

test('a hanging session is not offered for clock-out, and does not block tomorrow', () => {
  const sheet = fakeSheet();
  const attendance = load(sheet);

  const inTime = new Date(`2026-09-14T08:00:00${WIB}`).toISOString();
  const sessions = [sessionRow({ sessionId: `${OPS}_2026-09-14`, date: '2026-09-14', inEventId: 'in', inTime })];

  const today = new Date(`2026-09-17T08:00:00${WIB}`);
  assert.equal(attendance.findOpenSessionIdx(sessions, OPS, today), -1,
    'a day nobody closed goes to review, it does not lock the app');
});

/* ---------- vocabulary shared with the dashboard ---------- */

test('the flags written are ones the dashboard can name', async () => {
  const sheet = fakeSheet();
  const attendance = load(sheet);

  await attendance.clockIn(submission({ txnId: 'txn-flags-0001', now: new Date('2026-09-17T02:00:00.000Z') }));

  const flags = String(sheet.tabs['Attendance Events'][0][15]).split(',').filter(Boolean);
  // ATTENDANCE_FLAG_DETAILS in AttendanceBoardBackend.gs knows exactly these three.
  const dashboardKnows = ['OUT_OF_RADIUS', 'NO_REFERENCE', 'NO_CLOCK_OUT'];
  for (const f of flags) {
    assert.ok(dashboardKnows.includes(f), `${f} would render as "Kode tidak dikenal" on the board`);
  }
  assert.deepEqual(flags, ['NO_REFERENCE'], 'a location typed by hand has nothing to measure against');
});

test('the review statuses this app reads back are the ones the dashboard writes', () => {
  const sheet = fakeSheet();
  const attendance = load(sheet);

  // ATTENDANCE_REVIEW_STATUS in AttendanceBoardBackend.gs, verbatim.
  assert.equal(attendance.STATUS.CHECK, 'Cek');
  assert.equal(attendance.STATUS.REVIEWED, 'Accepted - Reviewed');
  assert.equal(attendance.STATUS.DATA_ISSUE, 'Accepted - POI Issue');
  assert.equal(attendance.STATUS.REJECTED, 'Rejected');
});

test('a decision made on the dashboard is readable back through this app', async () => {
  const sheet = fakeSheet();
  const attendance = load(sheet);
  const inTime = new Date('2026-09-17T00:00:00.000Z').toISOString();

  sheet.tabs['Attendance Sessions'].push(sessionRow({
    sessionId: `${OPS}_2026-09-17`, date: '2026-09-17', inEventId: 'in', inTime,
    review: ['Rejected', 'foto tidak jelas', 'cf@spxexpress.com', '2026-09-17T09:00:00.000Z', '2026-09-17T09:00:00.000Z'],
  }));

  const session = await attendance.getSessionDetail(OPS, `${OPS}_2026-09-17`);
  assert.equal(session.reviewStatus, 'Rejected');
  assert.equal(session.reviewReason, 'foto tidak jelas');
  assert.equal(session.reviewedBy, 'cf@spxexpress.com');
});

/* ---------- reading the whole sheet ---------- */

test('the read ranges are open-ended, so the sheet can outgrow four days', () => {
  const sheet = fakeSheet();
  const attendance = load(sheet);

  assert.equal(attendance.SESSIONS_RANGE, "'Attendance Sessions'!A2:R");
  assert.equal(attendance.EVENTS_RANGE, "'Attendance Events'!A2:Q");
  for (const range of [attendance.SESSIONS_RANGE, attendance.EVENTS_RANGE]) {
    assert.ok(!/\d+$/.test(range), `${range} still has a row bound, which 500 SPGs reach in four days`);
  }
});

test('a session beyond the old 2000-row bound is still found', async () => {
  const sheet = fakeSheet();
  const attendance = load(sheet);
  const inTime = new Date('2026-09-17T00:00:00.000Z').toISOString();

  for (let i = 0; i < 2500; i++) {
    sheet.tabs['Attendance Sessions'].push(sessionRow({
      sessionId: `OS9${String(i).padStart(5, '0')}_2026-09-17`, opsId: `OS9${String(i).padStart(5, '0')}`,
      date: '2026-09-17', inEventId: 'in', inTime,
    }));
  }
  sheet.tabs['Attendance Sessions'].push(sessionRow({
    sessionId: `${OPS}_2026-09-17`, date: '2026-09-17', inEventId: 'in', inTime,
  }));

  const today = await attendance.getToday(OPS);
  assert.equal(today.sessionId, `${OPS}_2026-09-17`);
  assert.equal(today.status, 'clocked_in', 'row 2503 is as visible as row 2');
});

/* ---------- photo ownership ---------- */

test('a photo reference resolves to the OpsID that owns it', async () => {
  const sheet = fakeSheet();
  const attendance = load(sheet);

  sheet.tabs['Attendance Events'].push(
    ['e1', 's1', OPS, 'Clock In', '', '', '', '', '', '', '', '', 'drive:mine', '', '', '', 't1'],
    ['e2', 's2', 'OS999999', 'Clock In', '', '', '', '', '', '', '', '', 'drive:theirs', '', '', '', 't2'],
  );

  assert.equal(await attendance.ownerOfPhotoRef('drive:mine'), OPS);
  assert.equal(await attendance.ownerOfPhotoRef('drive:theirs'), 'OS999999');
  assert.equal(await attendance.ownerOfPhotoRef('drive:invented'), null,
    'a reference nobody owns is not served to anybody');
});
