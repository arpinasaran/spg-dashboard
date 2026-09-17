const { batchGet, readRange, valuesUpdate, valuesAppend } = require('./sheetsClient');
const { cache } = require('./cache');
const { distanceMeters } = require('./geo');
const { getIdentity } = require('./identity');
const { getPoisForHub } = require('./poi');
const photoStore = require('./photoStore');
const tz = require('./timezone');
const config = require('../config');

/* WHO WRITES WHAT — the contract with the Apps Script dashboard.

   "Attendance Sessions" is written by two applications that cannot see each other's locks,
   so the only thing that keeps them from destroying each other's work is that they write
   disjoint columns. The dashboard states its half in AttendanceBoardBackend.gs:

     "N:R are owned by this dashboard. Vercel owns the attendance/session fields A:M,
      so never rewrite the entire row from a cached copy."

   This file holds up the other half:

     A-M  this app. Identity, times, event ids, activity. Written on clock-in and clock-out.
     N-R  the dashboard. Review Status, Review Reason, Reviewed By, Reviewed At, Last Updated.
          NEVER written here, not even as blanks, not even on row creation.

   Column R doubles as the dashboard's optimistic-concurrency token: it compares the R it
   last read against the R on the sheet and refuses a review if they differ. Writing R from
   here — which this file used to do on every clock-out — would make a CF's review fail with
   "sudah diperbarui oleh pengguna lain" for no reason a human could act on.

   That the dashboard still notices a clock-out does not depend on R: it hashes the whole
   range it reads into meta.attendance.version and polls that every 30 seconds, so a change
   in H-M is visible to it within one poll. See INTEGRATION_CONTRACT.md. */
const SESSIONS_RANGE = "'Attendance Sessions'!A2:R";
const EVENTS_RANGE = "'Attendance Events'!A2:Q";

// Just the session-id column. Read fresh immediately before a write that has to address a row
// by number, because a row number taken from a cached copy is a guess about a sheet two other
// writers are appending to.
const SESSION_IDS_RANGE = "'Attendance Sessions'!A2:A";

/* Status vocabulary, and why these exact strings.

   The dashboard matches on them literally (ATTENDANCE_REVIEW_STATUS in
   AttendanceBoardBackend.gs). This app used to write "Needs Review" and "Pending", which are
   in nobody's vocabulary: the dashboard fell through every branch and re-derived the state
   from flags, so the column was decorative at best and misleading at worst.

   Kept here because the write path no longer sets Review Status at all — the dashboard
   derives "needs a look" from the flags on the event rows. These are the values this app
   READS back and must understand. */
const STATUS = {
  ACCEPTED: 'Accepted',
  CHECK: 'Cek',
  REVIEWED: 'Accepted - Reviewed',
  DATA_ISSUE: 'Accepted - POI Issue',
  REJECTED: 'Rejected',
};

/* Validation flags, and the same reasoning.

   ATTENDANCE_FLAG_DETAILS on the dashboard knows OUT_OF_RADIUS, NO_REFERENCE and
   NO_CLOCK_OUT. It renders anything else as "Kode tidak dikenal", which is what a CF saw
   for every single flag this app produced: NON_RECOMMENDED_LOCATION and
   OUT_OF_RADIUS_UNVERIFIED_POI are not words the dashboard speaks.

   NO_CLOCK_OUT is absent here on purpose — it is not an observation made at write time but a
   conclusion about a day that ended, and the dashboard derives it itself. */
const FLAG = {
  OUT_OF_RADIUS: 'OUT_OF_RADIUS',
  NO_REFERENCE: 'NO_REFERENCE',
};

function localDateStr(d = new Date()) { return tz.dateStr(d); }
function addDaysLocalStr(d, days) { return tz.addDays(d, days); }

function savePhoto(eventId, dataUrl) { return photoStore.save(eventId, dataUrl); }

/* The whole store, read in one batchGet.

   The ranges are open-ended now. They used to stop at row 2000 (sessions) and 4000 (events),
   which is fine for one SPG and a countdown to failure for five hundred: at one session and
   two events per person per day those bounds are reached on the fourth day, after which the
   sheet keeps growing and this app simply stops seeing the new rows — no error, no gap in the
   UI, just attendance that silently does not exist. The dashboard already reads A2:R and
   A2:P unbounded, so the two would also have disagreed about what happened. */
async function loadStore() {
  const vr = await batchGet(config.sheets.attendanceDb, [SESSIONS_RANGE, EVENTS_RANGE]);
  return {
    sessions: (vr[0] && vr[0].values) || [],
    events: (vr[1] && vr[1].values) || [],
  };
}

/* persist:false is the point of this one.

   Every clock-in used to hand the entire attendance store to the snapshot store, which on a
   deployment means uploading a JSON file to Drive. Two costs, one of them serious. The cheap
   one: a thousand Drive writes a day of a file that grows all year. The serious one: two
   serverless instances that each read the snapshot, appended their own row to their own copy
   and wrote it back would each erase the other's row from the snapshot — and the snapshot is
   what the next reader is served for up to a minute.

   Sheets is the source of truth and is not slow to read, so attendance simply does not get a
   durable snapshot. Write-through still updates this instance's memory, which is what makes
   the response to a clock-in able to show the result without a read-back. */
function storeCache() {
  return cache({
    key: 'attendance-store',
    ttlMs: config.cache.attendanceTtlMs,
    loader: loadStore,
    persist: false,
  });
}

async function getStore() {
  const { data, fetchedAt, stale } = await storeCache().get();
  return { ...data, fetchedAt, stale };
}

function rowToSession(r) {
  const [sessionId, opsId, spgName, localDate, inEventId, inTime, inStatus,
    outEventId, outTime, outStatus, activityResult, activityNote,
    overallStatus, reviewStatus, reviewReason, reviewedBy, reviewedAt, updatedAt] = r;
  return {
    sessionId, opsId, spgName, localDate,
    inEventId, inTime: inTime || null, inStatus: inStatus || null,
    outEventId, outTime: outTime || null, outStatus: outStatus || null,
    activityResult: activityResult || null, activityNote: activityNote || null,
    overallStatus: overallStatus || null, reviewStatus: reviewStatus || null,
    reviewReason: reviewReason || null, reviewedBy: reviewedBy || null,
    reviewedAt: reviewedAt || null, updatedAt: updatedAt || null,
    flags: [],
  };
}

function withEvents(session, ev) {
  const events = ev || {};
  const flags = [...new Set([
    ...((events.in && events.in.flags) || []),
    ...((events.out && events.out.flags) || []),
  ])];
  return { ...session, events, flags };
}

function rowToEvent(r) {
  const [eventId, sessionId, opsId, eventType, poiId, poiName, lat, lng, accuracy,
    distance, deviceTs, serverTs, photoRef, photoExpiry, note, flags, txnId] = r;
  return {
    eventId, sessionId, opsId, eventType, poiId: poiId || null, poiName: poiName || null,
    lat: lat === '' || lat == null ? null : Number(lat),
    lng: lng === '' || lng == null ? null : Number(lng),
    accuracy: accuracy === '' || accuracy == null ? null : Number(accuracy),
    distance: distance === '' || distance == null ? null : Number(distance),
    deviceTs, serverTs, photoRef: photoRef || null, photoExpiry, note: note || null,
    flags: flags ? flags.split(',').filter(Boolean) : [],
    txnId: txnId || null,
  };
}

function eventsBySession(eventRows, sessionIds) {
  const wanted = new Set(sessionIds);
  const map = {};
  for (const r of eventRows) {
    const ev = rowToEvent(r);
    if (!wanted.has(ev.sessionId)) continue;
    map[ev.sessionId] = map[ev.sessionId] || {};
    map[ev.sessionId][ev.eventType === 'Clock In' ? 'in' : 'out'] = ev;
  }
  return map;
}

/* ---------- the shift, and the day it belongs to ---------- */

const MS_PER_HOUR = 60 * 60 * 1000;

function clockOutOpensAt(clockInTime) {
  return new Date(clockInTime.getTime() + config.rules.minShiftHours * MS_PER_HOUR);
}

/* A day is closed at the midnight that follows the end of the shift, measured in Indonesia.

   Anchored to the end rather than the start because a shift begun at 16:00 does not open for
   clock-out until 01:00 the next day; anchoring to the start would close the window before it
   ever opened. Measured through lib/timezone.js rather than with getFullYear()/getMonth(),
   which read the host's clock — UTC on a serverless instance, so the deadline would land at
   07:00 WIB and cut people off mid-morning. The dashboard computes the same boundary with its
   project timezone pinned to Asia/Jakarta, so the two agree. */
function clockOutClosesAt(clockInTime) {
  const opens = clockOutOpensAt(clockInTime);
  return tz.startOfDay(tz.addDays(opens, 1));
}

function sessionIsHanging(inTimeIso, hasClockOut, now = new Date()) {
  if (hasClockOut || !inTimeIso) return false;
  const start = new Date(inTimeIso);
  if (Number.isNaN(start.getTime())) return false;
  return now >= clockOutClosesAt(start);
}

/* The session a clock-out may still be applied to: clocked in, not clocked out, deadline not
   passed. Searched backwards so the most recent open session wins.

   This is what makes a shift that crosses midnight work. Keying the clock-out on today's
   session id — which is what this file did — meant an SPG who started at 16:00 and tried to
   finish at 01:00 was told "belum ada absen masuk hari ini", because by then "hari ini" was a
   different day and their session belonged to yesterday.

   A hanging session is deliberately NOT returned. That is what stops one forgotten clock-out
   from locking someone out of the app permanently: they clock in today as normal, and
   yesterday goes to the dashboard's review queue as a day nobody closed (the dashboard flags
   it NO_CLOCK_OUT on its own). */
function findOpenSessionIdx(sessions, opsId, now = new Date()) {
  for (let i = sessions.length - 1; i >= 0; i--) {
    const r = sessions[i];
    if ((r[1] || '') !== opsId) continue;
    if (!r[4] || r[7]) continue;
    if (sessionIsHanging(r[5], false, now)) continue;
    return i;
  }
  return -1;
}

function shiftGate(clockInIso, now = new Date()) {
  const start = clockInIso ? new Date(clockInIso) : null;
  if (!start || Number.isNaN(start.getTime())) {
    return { unlocked: true, unlocksAt: null, msLeft: 0, minShiftHours: config.rules.minShiftHours };
  }
  const unlocksAt = clockOutOpensAt(start);
  const msLeft = Math.max(0, unlocksAt.getTime() - now.getTime());
  return { unlocked: msLeft === 0, unlocksAt: unlocksAt.toISOString(), msLeft, minShiftHours: config.rules.minShiftHours };
}

function formatLeft(ms) {
  const mins = Math.ceil(ms / 60000);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h && m) return `${h} jam ${m} menit`;
  if (h) return `${h} jam`;
  return `${m} menit`;
}

/* ---------- reads that must not come from a cache ----------

   Anything that decides whether a write is safe reads the sheet directly. A cached copy is a
   statement about the past, and between "the past" and "now" sit two other writers: another
   serverless instance of this app, and the Apps Script dashboard. */

async function freshSessionIds() {
  return (await readRange(config.sheets.attendanceDb, SESSION_IDS_RANGE)).map(r => (r && r[0]) || '');
}

async function freshEvents() {
  return readRange(config.sheets.attendanceDb, EVENTS_RANGE);
}

// The sheet row holding a session, or -1. Lowest wins: if a race ever did produce two rows
// with the same id, every writer afterwards must agree on which one is real.
async function findSessionRowNumber(sessionId) {
  const ids = await freshSessionIds();
  const i = ids.findIndex(v => v === sessionId);
  return i < 0 ? -1 : i + 2; // A2 is the first data row
}

// values.append reports where it landed. Parsing it is what lets a writer know which row is
// its own, without which the duplicate check below could only detect a collision and not
// resolve one.
function appendedRowNumber(appendResult) {
  const range = appendResult && appendResult.updates && appendResult.updates.updatedRange;
  const m = /![A-Z]+(\d+)/.exec(String(range || ''));
  return m ? Number(m[1]) : -1;
}

/* ---------- transaction ids ----------

   "Attendance Events" column Q has been called "Idempotency Key" since the spreadsheet was
   created, and nothing ever wrote to it — every row carried an empty string there. It is
   filled now, and it is what makes a retry safe.

   The browser generates one per submission and reuses it for every retry of that submission.
   A network failure after the row was written therefore resolves as the success it was,
   rather than as "sudah absen masuk hari ini" shown to someone who is in fact clocked in. */
const TXN_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

function normaliseTxnId(raw) {
  const txnId = String(raw || '').trim();
  if (!txnId) {
    throw Object.assign(new Error('Permintaan tidak menyertakan ID transaksi.'), { status: 400 });
  }
  if (!TXN_PATTERN.test(txnId)) {
    throw Object.assign(new Error('ID transaksi tidak valid.'), { status: 400 });
  }
  return txnId;
}

function replayOf(eventRow) {
  const ev = rowToEvent(eventRow);
  return {
    sessionId: ev.sessionId,
    eventId: ev.eventId,
    distance: ev.distance,
    flags: ev.flags,
    replayed: true,
  };
}

function conflict(message, extra = {}) {
  return Object.assign(new Error(message), { status: 409, ...extra });
}

/* ---------- location ----------

   One question: could we confirm the person was within the radius of the point they named?
   Two ways to fail it, and they are reasons rather than separate rules. Nothing here forms an
   opinion about the person; a flag says what we could and could not measure, and the CF on the
   dashboard decides what it means. */
async function locationCheck(opsId, poiId, lat, lng) {
  if (poiId === 'other' || !poiId) {
    return { distance: null, poi: null, flags: [FLAG.NO_REFERENCE], coordConfidence: null };
  }
  let poi = null;
  try {
    const identity = await getIdentity(opsId);
    poi = (await getPoisForHub(identity.hub)).find(p => p.id === poiId) || null;
  } catch {
    return { distance: null, poi: null, flags: [FLAG.NO_REFERENCE], coordConfidence: null };
  }
  if (!poi || poi.lat == null || poi.lng == null) {
    return { distance: null, poi, flags: [FLAG.NO_REFERENCE], coordConfidence: poi ? poi.coordConfidence : null };
  }
  const distance = distanceMeters(lat, lng, poi.lat, poi.lng);
  const flags = [];
  if (distance == null) flags.push(FLAG.NO_REFERENCE);
  else if (distance > config.rules.poiRadiusMeters) flags.push(FLAG.OUT_OF_RADIUS);
  return { distance, poi, flags, coordConfidence: poi.coordConfidence };
}

function eventRow({ eventId, sessionId, opsId, type, poiId, poiName, lat, lng, accuracy, distance, deviceTime, now, photoRef, expiry, note, flags, txnId }) {
  return [
    eventId, sessionId, opsId, type, poiId || '', poiName || '',
    lat ?? '', lng ?? '', accuracy ?? '', distance ?? '',
    deviceTime || '', now.toISOString(), photoRef, expiry,
    note || '', flags.join(','), txnId,
  ];
}

async function appendEvent(row) {
  await valuesAppend(config.sheets.attendanceDb, "'Attendance Events'!A2", [row]);
}

/* ---------- read models ---------- */

async function getToday(opsId) {
  const dateStr = localDateStr();
  const store = await getStore();
  const meta = { fetchedAt: new Date(store.fetchedAt).toISOString(), stale: store.stale };

  // An open session outranks today's date: a shift begun at 16:00 yesterday is what the person
  // is still doing at 01:00 today, and the app has to show them the way to close it.
  const openIdx = findOpenSessionIdx(store.sessions, opsId);
  const row = openIdx >= 0
    ? store.sessions[openIdx]
    : store.sessions.find(r => (r[0] || '') === `${opsId}_${dateStr}`);

  if (!row) return { sessionId: `${opsId}_${dateStr}`, localDate: dateStr, status: 'not_started', ...meta };

  const session = rowToSession(row);
  const events = eventsBySession(store.events, [session.sessionId]);
  const hanging = sessionIsHanging(session.inTime, !!session.outTime);
  return {
    ...withEvents(session, events[session.sessionId]),
    // A hanging session is over as far as the SPG is concerned — they cannot close it, so the
    // app must not keep offering them a button that will be refused.
    status: session.outTime ? 'clocked_out' : (hanging ? 'hanging' : 'clocked_in'),
    gate: shiftGate(session.inTime),
    clockOutClosesAt: session.inTime ? clockOutClosesAt(new Date(session.inTime)).toISOString() : null,
    ...meta,
  };
}

async function getHistory(opsId, days = 14) {
  const store = await getStore();
  const mine = store.sessions.filter(r => (r[1] || '') === opsId).map(rowToSession);
  mine.sort((a, b) => a.localDate.localeCompare(b.localDate));
  const recent = mine.slice(-days).reverse();
  const events = eventsBySession(store.events, recent.map(s => s.sessionId));
  return recent.map(s => withEvents(s, events[s.sessionId]));
}

async function getSessionDetail(opsId, sessionId) {
  const store = await getStore();
  const row = store.sessions.find(r => (r[0] || '') === sessionId && (r[1] || '') === opsId);
  if (!row) throw Object.assign(new Error('Sesi tidak ditemukan'), { status: 404 });
  const events = eventsBySession(store.events, [sessionId]);
  return withEvents(rowToSession(row), events[sessionId]);
}

// Which OpsID a photo belongs to. routes/api.js asks before serving one, because a signed-in
// SPG holding somebody else's photo reference is not entitled to the photo.
async function ownerOfPhotoRef(ref) {
  const wanted = String(ref || '').trim();
  if (!wanted) return null;
  const store = await getStore();
  const row = store.events.find(r => (r[12] || '') === wanted);
  return row ? (row[2] || null) : null;
}

/* ---------- clock in ----------

   Order matters. The session row is written first because it is what claims the day; the
   event row follows. If the second write fails the session exists without its evidence, which
   is a state a retry can repair — whereas an event row whose session was never created is
   orphaned evidence nobody will ever find. */
async function clockIn({ opsId, spgName, poiId, poiName, note, lat, lng, accuracy, deviceTime, photoDataUrl, txnId: rawTxn, now: injectedNow }) {
  const txnId = normaliseTxnId(rawTxn);
  // injectedNow exists for tests only. routes/api.js forwards named fields and never the whole
  // body, so a browser cannot reach it and cannot backdate its own attendance.
  const now = injectedNow || new Date();
  const dateStr = localDateStr(now);
  const sessionId = `${opsId}_${dateStr}`;
  const eventId = `${sessionId}_in`;

  const store = await getStore();

  // Cheap replay: this instance already wrote it and remembers doing so.
  const cachedReplay = store.events.find(r => (r[16] || '') === txnId);
  if (cachedReplay) return replayOf(cachedReplay);

  const openIdx = findOpenSessionIdx(store.sessions, opsId, now);
  const todayIdx = store.sessions.findIndex(r => (r[0] || '') === sessionId);
  const looksTaken = openIdx >= 0 || (todayIdx >= 0 && store.sessions[todayIdx][4]);

  if (looksTaken) return resolveClockInConflict({ txnId, sessionId, eventId, openIdx, store, now });

  if (photoDataUrl && !String(photoDataUrl).startsWith('data:image/')) {
    // Cheap shape check before the day is claimed. The full parse lives in photoStore; this
    // only exists so an obviously broken payload fails before anything is written.
    throw Object.assign(new Error('Foto tidak valid (bukan data URL image/*)'), { status: 400 });
  }

  /* The photo upload starts before the writes that do not depend on it.

     Measured against the real spreadsheet, a Sheets round trip costs ~0.55s and the Drive
     upload of a 1280px JPEG costs more. Running them in sequence made the clock-in wait for
     the sum; the session row needs no photo reference, and the duplicate check needs no photo
     either, so both now happen while the upload is in flight. Only the event row needs it. */
  const photoPromise = savePhoto(eventId, photoDataUrl);
  photoPromise.catch(() => {}); // the await below is what actually handles a rejection

  const { distance, flags } = await locationCheck(opsId, poiId, lat, lng);
  const expiry = addDaysLocalStr(now, config.rules.photoRetentionDays);

  // A-M only. N-R belong to the dashboard and are left untouched even on a brand new row —
  // see the contract note at the top of this file. The dashboard derives "needs a look" from
  // the flags on the event row, so leaving Review Status empty loses nothing.
  const sessionRow = [
    sessionId, opsId, spgName || '', dateStr,
    eventId, now.toISOString(), 'Clocked In',
    '', '', '', '', '',
    'Clocked In',
  ];
  const appended = await valuesAppend(config.sheets.attendanceDb, "'Attendance Sessions'!A2", [sessionRow]);
  const ourRow = appendedRowNumber(appended);

  /* Did somebody else claim the same day between our check and our write?

     Sheets has no conditional append, and no lock this app holds is shared with the dashboard,
     so the check has to happen after the fact. We re-read the id column: if a row lower than
     ours holds this session id, we lost the race and clear the row we just wrote — the only
     row we are ever entitled to clear, because we created it a moment ago. */
  const winnerRow = await findSessionRowNumber(sessionId);
  if (ourRow > 0 && winnerRow > 0 && winnerRow < ourRow) {
    await valuesUpdate(config.sheets.attendanceDb, `'Attendance Sessions'!A${ourRow}:M${ourRow}`, [Array(13).fill('')]);
    storeCache().set({ sessions: store.sessions, events: store.events });
    return resolveClockInConflict({ txnId, sessionId, eventId, openIdx: -1, store, now });
  }

  const photoRef = await photoPromise;
  const evRow = eventRow({
    eventId, sessionId, opsId, type: 'Clock In', poiId, poiName,
    lat, lng, accuracy, distance, deviceTime, now, photoRef, expiry, note, flags, txnId,
  });
  await appendEvent(evRow);

  // Write-through, in memory only (see storeCache). We know what the sheet now holds, so the
  // response can carry the new state without reading it back.
  storeCache().set({
    sessions: store.sessions.concat([sessionRow]),
    events: store.events.concat([evRow]),
  });

  return { sessionId, eventId, distance, flags, replayed: false, gate: shiftGate(now.toISOString(), now) };
}

/* Someone already holds this day. Three possibilities, and only one of them is an error.

     1. It was us, and the response never arrived  -> the event carries our txn id. Success.
     2. It was us, and the event write failed      -> the session names our event id and no
                                                      such event exists. Say so, recoverably.
     3. It was genuinely something else            -> 409, carrying the session id so the
                                                      browser can show what is recorded. */
async function resolveClockInConflict({ txnId, sessionId, eventId, openIdx, store, now }) {
  const events = await freshEvents();

  const mine = events.find(r => (r[16] || '') === txnId);
  if (mine) return replayOf(mine);

  const ids = await freshSessionIds();
  const sessionExists = ids.includes(sessionId);
  const eventExists = events.some(r => (r[0] || '') === eventId);

  if (sessionExists && !eventExists) {
    // Partial write. The claim is on the sheet; the evidence never landed. Recoverable is the
    // signal the browser needs to offer "kirim lagi" instead of a dead end.
    throw Object.assign(
      new Error('Absen masuk tercatat sebagian — foto dan lokasinya belum tersimpan. Coba kirim lagi.'),
      { status: 409, sessionId, recoverable: true },
    );
  }

  if (openIdx >= 0 && (store.sessions[openIdx][0] || '') !== sessionId) {
    throw conflict('Masih ada sesi yang belum diabsen pulang — selesaikan dulu.', {
      sessionId: store.sessions[openIdx][0] || null,
    });
  }
  throw conflict('Sudah absen masuk hari ini — satu sesi per hari.', { sessionId });
}

/* ---------- clock out ---------- */
async function clockOut({ opsId, poiId, poiName, note, lat, lng, accuracy, deviceTime, photoDataUrl, activityResult, activityNote, txnId: rawTxn, now: injectedNow }) {
  const txnId = normaliseTxnId(rawTxn);
  const now = injectedNow || new Date(); // see clockIn

  const store = await getStore();
  const cachedReplay = store.events.find(r => (r[16] || '') === txnId);
  if (cachedReplay) return replayOf(cachedReplay);

  // The open session, not today's. See findOpenSessionIdx.
  const idx = findOpenSessionIdx(store.sessions, opsId, now);
  if (idx < 0) return resolveClockOutConflict({ txnId, opsId, store, now });

  const existing = store.sessions[idx];
  const sessionId = existing[0];
  const eventId = `${sessionId}_out`;

  const gate = shiftGate(existing[5], now);
  if (!gate.unlocked) {
    // How much longer, not at what o'clock: the server does not know which of Indonesia's
    // three zones this SPG reads their phone in, and a wall-clock time in the wrong one is
    // worse than none. The browser, which does know, shows the hour.
    throw Object.assign(
      new Error(`Belum bisa absen pulang — minimal ${config.rules.minShiftHours} jam setelah absen masuk. `
        + `Kurang ${formatLeft(gate.msLeft)} lagi.`),
      { status: 400, gate },
    );
  }

  // Same reasoning as clock-in: the fresh row lookup is a full Sheets round trip (~0.55s
  // measured) and has nothing to do with the photo, so it runs underneath the upload instead
  // of after it. Correctness costs a read; it does not have to cost the SPG a second.
  const photoPromise = savePhoto(eventId, photoDataUrl);
  photoPromise.catch(() => {});
  const rowNumberPromise = findSessionRowNumber(sessionId);
  rowNumberPromise.catch(() => {});

  const { distance, flags } = await locationCheck(opsId, poiId, lat, lng);
  const expiry = addDaysLocalStr(now, config.rules.photoRetentionDays);

  /* The row number is looked up fresh, never taken from idx.

     idx is a position in a cached array. Rows are appended to this sheet by other instances of
     this app, so an index that was right when the snapshot was taken can point at another
     SPG's session by the time we write — and this write used to cover A:R, which would have
     replaced that person's entire day, review included. */
  const rowNumber = await rowNumberPromise;
  if (rowNumber < 0) {
    throw Object.assign(
      new Error('Sesi absen masuk tidak ditemukan lagi di lembar. Muat ulang lalu coba lagi.'),
      { status: 409 },
    );
  }

  // H-M: the clock-out half of this app's columns. N-R are not in the range, so a review
  // recorded on the dashboard while this shift was running survives untouched.
  await valuesUpdate(
    config.sheets.attendanceDb,
    `'Attendance Sessions'!H${rowNumber}:M${rowNumber}`,
    [[eventId, now.toISOString(), 'Normal', activityResult || '', activityNote || '', 'Clocked Out']],
  );

  const photoRef = await photoPromise;
  const evRow = eventRow({
    eventId, sessionId, opsId, type: 'Clock Out', poiId, poiName,
    lat, lng, accuracy, distance, deviceTime, now, photoRef, expiry, note, flags, txnId,
  });
  await appendEvent(evRow);

  const inEvent = store.events.find(r => (r[1] || '') === sessionId && (r[3] || '') === 'Clock In');
  const priorFlags = inEvent ? (inEvent[15] || '').split(',').filter(Boolean) : [];
  const allFlags = [...new Set([...priorFlags, ...flags])];

  const updated = existing.slice();
  updated[7] = eventId;
  updated[8] = now.toISOString();
  updated[9] = 'Normal';
  updated[10] = activityResult || '';
  updated[11] = activityNote || '';
  updated[12] = 'Clocked Out';
  const sessions = store.sessions.slice();
  sessions[idx] = updated;
  storeCache().set({ sessions, events: store.events.concat([evRow]) });

  return { sessionId, eventId, distance, flags: allFlags, replayed: false };
}

async function resolveClockOutConflict({ txnId, opsId, store, now }) {
  const events = await freshEvents();
  const mine = events.find(r => (r[16] || '') === txnId);
  if (mine) return replayOf(mine);

  // A session closed but missing its event row — the second write of a clock-out failed.
  const closedWithoutEvent = store.sessions.find(r => (r[1] || '') === opsId && r[7]
    && !events.some(e => (e[0] || '') === r[7]));
  if (closedWithoutEvent) {
    throw Object.assign(
      new Error('Absen pulang tercatat sebagian — foto dan lokasinya belum tersimpan. Coba kirim lagi.'),
      { status: 409, sessionId: closedWithoutEvent[0], recoverable: true },
    );
  }

  const hanging = store.sessions.some(r => (r[1] || '') === opsId && r[4] && !r[7]
    && sessionIsHanging(r[5], false, now));
  throw Object.assign(new Error(hanging
    ? 'Sesi sebelumnya sudah lewat batas dan tidak bisa ditutup lagi — pengawas akan meninjaunya.'
    : 'Belum ada absen masuk yang terbuka — absen masuk dulu.'), { status: 400 });
}

module.exports = {
  getToday, getHistory, getSessionDetail, clockIn, clockOut,
  localDateStr, addDaysLocalStr, storeCache, locationCheck, ownerOfPhotoRef,
  rowToSession, rowToEvent, eventsBySession, withEvents, getStore,
  shiftGate, formatLeft, normaliseTxnId,
  clockOutOpensAt, clockOutClosesAt, sessionIsHanging, findOpenSessionIdx,
  appendedRowNumber, findSessionRowNumber,
  STATUS, FLAG, SESSIONS_RANGE, EVENTS_RANGE,
};
