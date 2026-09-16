const { batchGet, valuesUpdate, valuesAppend } = require('./sheetsClient');
const { cache } = require('./cache');
const { distanceMeters } = require('./geo');
const { getIdentity } = require('./identity');
const { getPoisForHub } = require('./poi');
const photoStore = require('./photoStore');
const config = require('../config');

const SESSIONS_RANGE = "'Attendance Sessions'!A2:R2000";
const EVENTS_RANGE = "'Attendance Events'!A2:Q4000";

function pad(n) { return String(n).padStart(2, '0'); }

// Local calendar date, not UTC — attendance rules (10:00 cutoff, 16:00 cutoff) are stated
// in the SPG's local time (NFR-04), and toISOString() would silently shift the date near
// midnight for any timezone ahead of UTC.
function localDateStr(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function addDaysLocalStr(d, days) {
  const copy = new Date(d.getFullYear(), d.getMonth(), d.getDate() + days);
  return localDateStr(copy);
}

// Photo Reference (Attendance Events column M) now holds a Drive file id rather than a path
// on this machine — see lib/photoStore.js for the reference format and why.
function savePhoto(eventId, dataUrl) {
  return photoStore.save(eventId, dataUrl);
}

// Sessions and events are read together in one batchGet and held as a single cached store.
// Previously each request made two or three separate gws calls, each paying ~1.2s of process
// spawn before any data moved; the whole store now costs one call, and writes update it in
// place so the common path never reads back what we just wrote.
async function loadStore() {
  const vr = await batchGet(config.sheets.attendanceDb, [SESSIONS_RANGE, EVENTS_RANGE]);
  return {
    sessions: (vr[0] && vr[0].values) || [],
    events: (vr[1] && vr[1].values) || [],
  };
}

function storeCache() {
  return cache({ key: 'attendance-store', ttlMs: config.cache.attendanceTtlMs, loader: loadStore });
}

async function getStore() {
  const { data, fetchedAt, stale } = await storeCache().get();
  return { ...data, fetchedAt, stale };
}

function rowToSession(r) {
  const [sessionId, opsId, spgName, localDate, inEventId, inTime, inStatus,
    outEventId, outTime, outStatus, activityResult, activityNote,
    overallStatus, reviewStatus, reviewReason, reviewedBy, reviewedAt] = r;
  return {
    sessionId, opsId, spgName, localDate,
    inEventId, inTime: inTime || null, inStatus: inStatus || null,
    outEventId, outTime: outTime || null, outStatus: outStatus || null,
    activityResult: activityResult || null, activityNote: activityNote || null,
    overallStatus: overallStatus || null, reviewStatus: reviewStatus || null,
    reviewReason: reviewReason || null, reviewedBy: reviewedBy || null, reviewedAt: reviewedAt || null,
    // Validation flags are recorded per event ("Attendance Events" column P), not per session.
    // withEvents() unions them back up; see the note there for why they are not stored here.
    flags: [],
  };
}

// Column O of "Attendance Sessions" is named "Review Reason" and belongs to whoever reviews
// the session. Clock-in/out used to write the validation flags into it, which meant the
// moment a reviewer recorded a reason the triage data it overwrote was gone — and until then
// the column held machine codes where a human sentence was expected. Flags now stay where the
// schema already puts them (the event rows) and are unioned back onto the session on read.
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
    distance, deviceTs, serverTs, photoRef, photoExpiry, note, flags] = r;
  return {
    eventId, sessionId, opsId, eventType, poiId: poiId || null, poiName: poiName || null,
    lat: lat === '' || lat == null ? null : Number(lat),
    lng: lng === '' || lng == null ? null : Number(lng),
    accuracy: accuracy === '' || accuracy == null ? null : Number(accuracy),
    distance: distance === '' || distance == null ? null : Number(distance),
    deviceTs, serverTs, photoRef: photoRef || null, photoExpiry, note: note || null,
    flags: flags ? flags.split(',').filter(Boolean) : [],
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

async function getToday(opsId) {
  const dateStr = localDateStr();
  const sessionId = `${opsId}_${dateStr}`;
  const store = await getStore();
  const row = store.sessions.find(r => (r[0] || '') === sessionId);
  const meta = { fetchedAt: new Date(store.fetchedAt).toISOString(), stale: store.stale };
  if (!row) return { sessionId, localDate: dateStr, status: 'not_started', ...meta };
  const session = rowToSession(row);
  const events = eventsBySession(store.events, [sessionId]);
  return {
    ...withEvents(session, events[sessionId]),
    status: session.outTime ? 'clocked_out' : 'clocked_in',
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
  if (!row) throw new Error('Sesi tidak ditemukan');
  const events = eventsBySession(store.events, [sessionId]);
  return withEvents(rowToSession(row), events[sessionId]);
}

// Geofence check. A POI whose coordinate was only a partial geocode can sit a few hundred
// metres off, so an SPG standing in the right place would be flagged for a mistake in the
// source data. Those get a distinct, softer flag so a CF reviewing the queue can tell
// "probably wasn't there" apart from "we don't trust the pin".
async function locationCheck(opsId, poiId, lat, lng) {
  if (poiId === 'other' || !poiId) {
    return { distance: null, poi: null, flags: ['NON_RECOMMENDED_LOCATION'] };
  }
  let poi = null;
  try {
    const identity = await getIdentity(opsId);
    poi = (await getPoisForHub(identity.hub)).find(p => p.id === poiId) || null;
  } catch {
    return { distance: null, poi: null, flags: [] }; // POI list unavailable — don't invent a verdict
  }
  if (!poi || poi.lat == null || poi.lng == null) return { distance: null, poi, flags: [] };

  const distance = distanceMeters(lat, lng, poi.lat, poi.lng);
  const flags = [];
  if (distance != null && distance > config.rules.poiRadiusMeters) {
    flags.push(poi.coordConfidence === 'low' ? 'OUT_OF_RADIUS_UNVERIFIED_POI' : 'OUT_OF_RADIUS');
  }
  return { distance, poi, flags };
}

function eventRow({ eventId, sessionId, opsId, type, poiId, poiName, lat, lng, accuracy, distance, deviceTime, now, photoRef, expiry, note, flags }) {
  return [
    eventId, sessionId, opsId, type, poiId || '', poiName || '',
    lat ?? '', lng ?? '', accuracy ?? '', distance ?? '',
    deviceTime || '', now.toISOString(), photoRef, expiry,
    note || '', flags.join(','), '',
  ];
}

async function clockIn({ opsId, spgName, poiId, poiName, note, lat, lng, accuracy, deviceTime, photoDataUrl }) {
  const now = new Date();
  const dateStr = localDateStr(now);
  const sessionId = `${opsId}_${dateStr}`;
  const eventId = `${sessionId}_in`;

  const store = await getStore();
  const existingIdx = store.sessions.findIndex(r => (r[0] || '') === sessionId);
  if (existingIdx >= 0 && store.sessions[existingIdx][4]) {
    throw new Error('Sudah absen masuk hari ini — satu sesi per hari.');
  }

  const status = now.getHours() < config.rules.lateAfterHour ? 'On Time' : 'Late';
  const { distance, flags } = await locationCheck(opsId, poiId, lat, lng);
  const photoRef = await savePhoto(eventId, photoDataUrl);
  const expiry = addDaysLocalStr(now, config.rules.photoRetentionDays);

  const evRow = eventRow({
    eventId, sessionId, opsId, type: 'Clock In', poiId, poiName,
    lat, lng, accuracy, distance, deviceTime, now, photoRef, expiry, note, flags,
  });
  await valuesAppend(config.sheets.attendanceDb, "'Attendance Events'!A2", [evRow]);

  const needsReview = flags.length > 0;
  const sessionRow = [
    sessionId, opsId, spgName || '', dateStr,
    eventId, now.toISOString(), status,
    '', '', '', '', '',
    needsReview ? 'Needs Review' : (status === 'Late' ? 'Late' : 'Clocked In'),
    needsReview ? 'Needs Review' : 'Pending',
    '', '', '', // Review Reason / Reviewed By / Reviewed At — a reviewer's to fill, not ours
    now.toISOString(),
  ];
  if (existingIdx >= 0) {
    await valuesUpdate(config.sheets.attendanceDb, `'Attendance Sessions'!A${existingIdx + 2}:R${existingIdx + 2}`, [sessionRow]);
  } else {
    await valuesAppend(config.sheets.attendanceDb, "'Attendance Sessions'!A2", [sessionRow]);
  }

  // Write-through: we know exactly what the sheet now contains, so reflect it locally
  // instead of paying for a read-back on the next request.
  const sessions = store.sessions.slice();
  if (existingIdx >= 0) sessions[existingIdx] = sessionRow; else sessions.push(sessionRow);
  storeCache().set({ sessions, events: store.events.concat([evRow]) });

  return { sessionId, eventId, status, distance, flags };
}

async function clockOut({ opsId, poiId, poiName, note, lat, lng, accuracy, deviceTime, photoDataUrl, activityResult, activityNote }) {
  const now = new Date();
  const dateStr = localDateStr(now);
  const sessionId = `${opsId}_${dateStr}`;
  const eventId = `${sessionId}_out`;

  const store = await getStore();
  const idx = store.sessions.findIndex(r => (r[0] || '') === sessionId);
  if (idx < 0 || !store.sessions[idx][4]) throw new Error('Belum ada absen masuk hari ini — absen masuk dulu.');
  const existing = store.sessions[idx];
  if (existing[7]) throw new Error('Sudah absen pulang hari ini.');
  if (poiId && poiId !== 'other' && poiId === existing[4]) {
    throw new Error('Lokasi absen pulang harus berbeda dari lokasi absen masuk.');
  }

  const status = now.getHours() < config.rules.earlyBeforeHour ? 'Early' : 'Normal';
  const { distance, flags } = await locationCheck(opsId, poiId, lat, lng);
  if (status === 'Early') flags.push('EARLY_CLOCKOUT');
  const photoRef = await savePhoto(eventId, photoDataUrl);
  const expiry = addDaysLocalStr(now, config.rules.photoRetentionDays);

  const evRow = eventRow({
    eventId, sessionId, opsId, type: 'Clock Out', poiId, poiName,
    lat, lng, accuracy, distance, deviceTime, now, photoRef, expiry, note, flags,
  });
  await valuesAppend(config.sheets.attendanceDb, "'Attendance Events'!A2", [evRow]);

  // The clock-in's own flags, read from the event row that owns them.
  const inEvent = store.events.find(r => (r[1] || '') === sessionId && (r[3] || '') === 'Clock In');
  const priorFlags = inEvent ? (inEvent[15] || '').split(',').filter(Boolean) : [];
  const allFlags = [...new Set([...priorFlags, ...flags])];
  const needsReview = allFlags.length > 0;
  const updated = existing.slice();
  updated[7] = eventId;
  updated[8] = now.toISOString();
  updated[9] = status;
  updated[10] = activityResult || '';
  updated[11] = activityNote || '';
  updated[12] = needsReview ? 'Needs Review' : 'Clocked Out';
  updated[13] = needsReview ? 'Needs Review' : 'Pending';
  updated[17] = now.toISOString();
  await valuesUpdate(config.sheets.attendanceDb, `'Attendance Sessions'!A${idx + 2}:R${idx + 2}`, [updated]);

  const sessions = store.sessions.slice();
  sessions[idx] = updated;
  storeCache().set({ sessions, events: store.events.concat([evRow]) });

  return { sessionId, eventId, status, distance, flags: allFlags, overallStatus: updated[12] };
}

module.exports = {
  getToday, getHistory, getSessionDetail, clockIn, clockOut,
  localDateStr, addDaysLocalStr, storeCache, locationCheck,
  rowToSession, rowToEvent, eventsBySession, withEvents, getStore,
};
