const attendance = require('./attendance');
const roster = require('./roster');
const demoSeed = require('./demoSeed');
const config = require('../config');
const crypto = require('crypto');
const { valuesUpdate, valuesAppend } = require('./sheetsClient');

// The admin board: every SPG against the last N days, one cell per day.
//
// Two things make this cheap. First, "Attendance Sessions" is already read in full for the
// single-SPG app — A2:R2000 with no filter — and then 99% of it thrown away; the board just
// stops throwing it away, so it costs no new reads. Second, the only thing the attendance
// sheet cannot tell you is who did NOT show up, because absence leaves no row; that is the
// one extra read (the roster), and it is cached for half an hour.

const DAY_NAMES = ['Min', 'Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab'];
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];

// Read: the machine's verdict, in words a person can act on. A flag is not a conclusion —
// OUT_OF_RADIUS_UNVERIFIED_POI in particular says "we don't trust the pin", not "they lied" —
// so the wording keeps the doubt where it belongs.
const FLAG_LABELS = {
  OUT_OF_RADIUS: {
    label: 'Di luar radius',
    detail: 'Posisi lebih dari ' + config.rules.poiRadiusMeters + ' m dari titik POI, dan koordinat POI-nya tergolong tepercaya.',
    weight: 3,
  },
  OUT_OF_RADIUS_UNVERIFIED_POI: {
    label: 'Di luar radius — pin POI diragukan',
    detail: 'Jauh dari titik, tapi koordinat POI ini cuma hasil geocode alamat sebagian. Bisa jadi pin-nya yang salah, bukan orangnya.',
    weight: 2,
  },
  NON_RECOMMENDED_LOCATION: {
    label: 'Di luar daftar POI',
    detail: 'SPG absen di lokasi yang diisi manual, bukan dari daftar rekomendasi.',
    weight: 1,
  },
  // No longer produced: clock-out is gated on shift length now, so a short shift cannot be
  // recorded at all rather than being recorded and flagged. Kept so sessions written under
  // the old 16:00 rule still explain themselves on the board instead of showing a bare code.
  EARLY_CLOCKOUT: {
    label: 'Pulang lebih awal',
    detail: 'Absen pulang sebelum jam 16:00 (aturan lama, sebelum minimum '
      + config.rules.minShiftHours + ' jam).',
    weight: 1,
  },
};

function describeFlag(code) {
  return FLAG_LABELS[code] || { label: code, detail: 'Kode flag tidak dikenal.', weight: 1 };
}

function pad(n) { return String(n).padStart(2, '0'); }

function dayStr(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }

function buildDays(count, today = new Date()) {
  const out = [];
  const todayStr = dayStr(today);
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);
    const date = dayStr(d);
    out.push({
      date,
      dow: DAY_NAMES[d.getDay()],
      dayNum: d.getDate(),
      month: MONTH_NAMES[d.getMonth()],
      isRest: d.getDay() === 0,
      isToday: date === todayStr,
    });
  }
  return out;
}

function hhmm(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `${pad(d.getHours())}.${pad(d.getMinutes())}`;
}

function indexEvents(eventRows) {
  const map = new Map();
  for (const r of eventRows) {
    const ev = attendance.rowToEvent(r);
    if (!ev.sessionId) continue;
    if (!map.has(ev.sessionId)) map.set(ev.sessionId, {});
    map.get(ev.sessionId)[ev.eventType === 'Clock In' ? 'in' : 'out'] = ev;
  }
  return map;
}

// One cell's verdict. Order matters: a decided session reads as decided even if it was
// flagged, and a flagged session outranks "late" — lateness is visible in the detail panel,
// but what the board is for is surfacing what still needs a human.
function cellState(session, flags, day) {
  if (!session) return day.isRest ? 'rest' : 'none';
  const review = (session.reviewStatus || '').toLowerCase();
  if (review === 'approved') return 'approved';
  if (review === 'rejected') return 'rejected';
  if (flags.length) return 'review';
  if (!session.outTime) return day.isToday ? 'open' : 'unfinished';
  if ((session.inStatus || '') === 'Late') return 'late';
  return 'ok';
}

function loadSeed() {
  if (!config.admin || !config.admin.demoData) return null;
  return demoSeed.load();
}

// Real rows win over seeded ones for the same session id, so the moment a real SPG clocks in
// their actual day replaces the invented one instead of appearing twice.
function mergeRows(realRows, seedRows, idIndex) {
  const byId = new Map();
  for (const r of seedRows || []) byId.set(r[idIndex], { row: r, demo: true });
  for (const r of realRows || []) byId.set(r[idIndex], { row: r, demo: false });
  return [...byId.values()];
}

async function collect() {
  const store = await attendance.getStore();
  const seed = loadSeed();

  const sessionEntries = mergeRows(store.sessions.filter(r => r && r[0]), seed && seed.sessions, 0);
  const eventEntries = mergeRows(store.events.filter(r => r && r[0]), seed && seed.events, 0);

  const eventsBySession = indexEvents(eventEntries.map(e => e.row));

  // Roster: the seed carries its own snapshot so the board works even when gws is down or
  // unauthenticated. When there is no seed we pay for the real read.
  let people = [];
  let rosterError = null;
  if (seed && seed.roster && seed.roster.length) {
    people = seed.roster.map(p => ({ ...p, demo: true }));
  } else {
    try {
      people = (await roster.getRoster()).filter(p => p.active).map(p => ({ ...p, demo: false }));
      const sup = await roster.getSupervisorMap().catch(() => ({}));
      people = people.map(p => ({ ...p, cfEmail: (sup[p.opsId] && sup[p.opsId].cfEmail) || p.cfEmail || null }));
    } catch (err) {
      rosterError = err.message;
    }
  }

  // Anyone with attendance rows but no roster entry still belongs on the board — a resigned
  // SPG's past days do not stop being reviewable.
  const known = new Set(people.map(p => p.opsId));
  for (const entry of sessionEntries) {
    const opsId = entry.row[1];
    if (!opsId || known.has(opsId)) continue;
    known.add(opsId);
    people.push({ opsId, name: entry.row[2] || opsId, hub: '—', city: '', region: '', cfEmail: null, demo: entry.demo, offRoster: true });
  }

  return { store, seed, sessionEntries, eventsBySession, people, rosterError };
}

async function getBoard({ days = (config.admin && config.admin.boardDays) || 14 } = {}) {
  const ctx = await collect();
  const dayList = buildDays(days);
  const todayStr = attendance.localDateStr();

  const sessionByKey = new Map();
  for (const entry of ctx.sessionEntries) {
    sessionByKey.set(`${entry.row[1]}|${entry.row[3]}`, entry);
  }

  const summary = {
    spgTotal: ctx.people.length,
    todayIn: 0, todayOut: 0, todayOpen: 0, todayNone: 0,
    needsReview: 0, unfinished: 0, decided: 0,
  };

  const rows = ctx.people.map(person => {
    const cells = dayList.map(day => {
      const entry = sessionByKey.get(`${person.opsId}|${day.date}`);
      if (!entry) {
        return { date: day.date, state: day.isRest ? 'rest' : 'none', sessionId: null };
      }
      const session = attendance.rowToSession(entry.row);
      const ev = ctx.eventsBySession.get(session.sessionId) || {};
      const flags = [...new Set([...((ev.in && ev.in.flags) || []), ...((ev.out && ev.out.flags) || [])])];
      const state = cellState(session, flags, day);
      return {
        date: day.date,
        state,
        sessionId: session.sessionId,
        inTime: hhmm(session.inTime),
        outTime: hhmm(session.outTime),
        inStatus: session.inStatus,
        outStatus: session.outStatus,
        reviewStatus: session.reviewStatus,
        flags,
        poi: (ev.in && ev.in.poiName) || null,
        demo: entry.demo,
      };
    });

    const stats = { hadir: 0, telat: 0, perluDicek: 0, bolong: 0, selesai: 0 };
    for (const c of cells) {
      if (c.state === 'rest') continue;
      if (c.state === 'none') stats.bolong++;
      else if (c.state === 'review') stats.perluDicek++;
      else if (c.state === 'late') { stats.telat++; stats.hadir++; }
      else if (c.state === 'approved' || c.state === 'rejected') { stats.selesai++; stats.hadir++; }
      else stats.hadir++;
    }

    const today = cells.find(c => c.date === todayStr);
    if (today) {
      if (today.state === 'none') summary.todayNone++;
      else if (today.state === 'rest') { /* rest day counts as nobody's absence */ }
      else {
        summary.todayIn++;
        if (today.outTime) summary.todayOut++; else summary.todayOpen++;
      }
    }
    summary.needsReview += cells.filter(c => c.state === 'review').length;
    summary.unfinished += cells.filter(c => c.state === 'unfinished').length;
    summary.decided += cells.filter(c => c.state === 'approved' || c.state === 'rejected').length;

    return {
      opsId: person.opsId,
      name: person.name,
      hub: person.hub || '—',
      city: person.city || '',
      region: person.region || '',
      cfEmail: person.cfEmail || null,
      demo: !!person.demo,
      offRoster: !!person.offRoster,
      stats,
      cells,
    };
  });

  // Whoever needs attention floats up; below that, alphabetical so the list is scannable.
  rows.sort((a, b) => (b.stats.perluDicek - a.stats.perluDicek)
    || (b.stats.bolong - a.stats.bolong)
    || a.name.localeCompare(b.name, 'id'));

  // Region, not hub, is the coarse filter: the roster puts roughly one SPG in each hub, so a
  // hub list is 499 entries of one person. Hub stays on the row as detail, where it belongs.
  const regions = [...new Set(rows.map(r => r.region).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'id'));
  const cfs = [...new Set(rows.map(r => r.cfEmail).filter(Boolean))].sort();

  return {
    days: dayList,
    today: todayStr,
    rows,
    regions,
    cfs,
    summary,
    rules: {
      poiRadiusMeters: config.rules.poiRadiusMeters,
      minShiftHours: config.rules.minShiftHours,
    },
    demo: ctx.seed ? {
      active: true,
      generatedAt: ctx.seed.generatedAt,
      rosterSource: ctx.seed.rosterSource,
      sessionCount: (ctx.seed.sessions || []).length,
      spgCount: (ctx.seed.roster || []).length,
    } : { active: false },
    rosterError: ctx.rosterError,
    meta: {
      attendance: { fetchedAt: new Date(ctx.store.fetchedAt).toISOString(), stale: ctx.store.stale },
    },
  };
}

async function getSessionDetail(sessionId) {
  const ctx = await collect();
  const entry = ctx.sessionEntries.find(e => e.row[0] === sessionId);
  if (!entry) {
    const err = new Error(`Sesi ${sessionId} tidak ditemukan`);
    err.status = 404;
    throw err;
  }
  const session = attendance.rowToSession(entry.row);
  const ev = ctx.eventsBySession.get(sessionId) || {};
  const flags = [...new Set([...((ev.in && ev.in.flags) || []), ...((ev.out && ev.out.flags) || [])])];
  const person = ctx.people.find(p => p.opsId === session.opsId) || null;

  const decorate = e => e && ({
    ...e,
    timeLabel: hhmm(e.serverTs || e.deviceTs),
    flagDetails: (e.flags || []).map(describeFlag),
    // A seeded row has no photo on disk, and neither does a real row whose file was lost.
    // The panel says which of the two it is rather than showing a broken image.
    photoAvailable: !!e.photoRef,
  });

  return {
    ...session,
    demo: entry.demo,
    person,
    flags,
    flagDetails: flags.map(describeFlag),
    events: { in: decorate(ev.in), out: decorate(ev.out) },
    rules: {
      poiRadiusMeters: config.rules.poiRadiusMeters,
      minShiftHours: config.rules.minShiftHours,
    },
  };
}

/* The four decisions, spelled exactly as the Apps Script dashboard spells them.

   These used to read "Approved" and "Needs Review", which no other application recognises.
   ATTENDANCE_REVIEW_STATUS on the dashboard matches on the literal strings below, so a session
   approved here showed up over there as unreviewed — two boards disagreeing about a decision a
   human had already made. poi_issue exists on the dashboard and did not exist here at all. */
const DECISIONS = {
  approve: { status: 'Accepted - Reviewed', verb: 'disahkan' },
  poi_issue: { status: 'Accepted - POI Issue', verb: 'ditandai masalah POI' },
  reject: { status: 'Rejected', verb: 'ditolak' },
  reopen: { status: 'Cek', verb: 'dibuka lagi' },
};

/* Every decision also becomes a row in "Review Audit Log".

   The spreadsheet's own README states the rule: "Review Audit Log rows are appended only —
   corrections are new rows, never edits to old ones (FR-CF-05)". The tab has existed since the
   workbook was created and nothing had ever written to it, so the only record of who decided
   what was the single mutable Reviewed By cell, which the next decision overwrites. Append-only
   history is the whole point of an audit log, and a reviewer's reversal is exactly the event
   it exists to preserve. */
async function appendAudit({ sessionId, actor, role, action, fromStatus, toStatus, reason, at }) {
  const row = [
    `AUD_${at.replace(/[-:.TZ]/g, '').slice(0, 14)}_${crypto.randomBytes(3).toString('hex')}`,
    sessionId, actor, role, action, fromStatus || '', toStatus || '', reason || '', at,
  ];
  await valuesAppend(config.sheets.attendanceDb, "'Review Audit Log'!A2", [row]);
  return row[0];
}

// Writes the decision to columns N–R. Column O is "Review Reason" and now genuinely holds a
// reason: the validation flags that used to be parked there live on the event rows, where
// the schema already had a column for them.
async function review({ sessionId, decision, reason, reviewer }) {
  const choice = DECISIONS[decision];
  if (!choice) {
    const err = new Error(`Keputusan tidak dikenal: ${decision}`);
    err.status = 400;
    throw err;
  }
  if (decision === 'reject' && !(reason || '').trim()) {
    const err = new Error('Alasan wajib diisi kalau sesi ditolak.');
    err.status = 400;
    throw err;
  }

  const now = new Date().toISOString();
  const who = (reviewer || '').trim() || 'admin (belum login)';
  const seed = loadSeed();
  const seedIdx = seed ? (seed.sessions || []).findIndex(r => r[0] === sessionId) : -1;

  if (seedIdx >= 0) {
    // Seeded row — the decision stays on disk. Writing invented attendance back into the
    // real spreadsheet is the one thing this whole demo path must never do.
    const row = seed.sessions[seedIdx].slice();
    row[13] = choice.status;
    row[14] = (reason || '').trim();
    row[15] = who;
    row[16] = decision === 'reopen' ? '' : now;
    row[12] = row[8] ? 'Clocked Out' : 'Clocked In';
    row[17] = now;
    seed.sessions[seedIdx] = row;
    demoSeed.save(seed);
    return { sessionId, status: choice.status, demo: true, reviewedAt: row[16] || null, reviewedBy: who };
  }

  const store = await attendance.getStore();
  const idx = store.sessions.findIndex(r => (r[0] || '') === sessionId);
  if (idx < 0) {
    const err = new Error(`Sesi ${sessionId} tidak ditemukan`);
    err.status = 404;
    throw err;
  }
  const previousStatus = store.sessions[idx][13] || '';

  /* N-R only, and the row found fresh.

     This used to write A:R from a cached copy of the row, which did two kinds of damage. It
     rewrote A:M — the clock-in and clock-out fields this board does not own — from whatever
     the cache happened to hold, so a clock-out that landed after the cache was filled was
     erased by the act of reviewing the day. And it addressed the row by its index in that
     cached array, which is a guess about a sheet other writers are appending to.

     The dashboard writes the same five columns the same way, for the same reasons. */
  const rowNumber = await attendance.findSessionRowNumber(sessionId);
  if (rowNumber < 0) {
    const err = new Error(`Sesi ${sessionId} tidak ada lagi di lembar`);
    err.status = 409;
    throw err;
  }
  const reviewedAt = decision === 'reopen' ? '' : now;
  await valuesUpdate(
    config.sheets.attendanceDb,
    `'Attendance Sessions'!N${rowNumber}:R${rowNumber}`,
    [[choice.status, (reason || '').trim(), who, reviewedAt, now]],
  );

  // After the decision is on the sheet, never before: an audit row for a write that failed
  // would be a record of something that did not happen.
  await appendAudit({
    sessionId, actor: who, role: 'CF/Admin', action: decision,
    fromStatus: previousStatus, toStatus: choice.status, reason: (reason || '').trim(), at: now,
  }).catch(err => console.error(`Audit log gagal ditulis untuk ${sessionId}: ${err.message}`));

  const row = store.sessions[idx].slice();
  row[13] = choice.status;
  row[14] = (reason || '').trim();
  row[15] = who;
  row[16] = reviewedAt;
  row[17] = now;
  const sessions = store.sessions.slice();
  sessions[idx] = row;
  attendance.storeCache().set({ sessions, events: store.events });

  return { sessionId, status: choice.status, demo: false, reviewedAt: reviewedAt || null, reviewedBy: who };
}

module.exports = { getBoard, getSessionDetail, review, describeFlag, FLAG_LABELS, buildDays, cellState };
