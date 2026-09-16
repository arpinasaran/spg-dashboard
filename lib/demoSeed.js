const fs = require('fs');
const path = require('path');
const config = require('../config');

// Synthetic attendance so the admin board can be designed against a populated screen.
//
// "Attendance Sessions" currently holds zero rows — one SPG has ever used this app, and
// demo-reset cleared even that. A monitoring board built straight onto it renders empty,
// which is the one state you cannot learn anything from. So the seed produces rows in the
// exact shape the sheet uses (18 columns for sessions, 17 for events) and lib/admin.js
// consumes both without branching: the seed masquerades as sheet data rather than being a
// second code path that can drift from the real one.
//
// Nothing here is ever written to Google Sheets. The file lives on disk, the board labels
// every seeded row, and deleting data/demo/admin-seed.json removes it completely.

const SEED_FILE = path.join(__dirname, '..', 'data', 'demo', 'admin-seed.json');

// Deterministic PRNG — regenerating the seed must not reshuffle the board underneath
// someone who is in the middle of reviewing a layout.
function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

function rng(seedStr) {
  let a = hashStr(seedStr);
  return function next() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pad(n) { return String(n).padStart(2, '0'); }
function dateStr(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function atTime(day, hour, minute) {
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour, minute, 0);
}

const FALLBACK_NAMES = [
  'Ayu Pramesti Dewi', 'Ni Kadek Ayu Lestari', 'Rizal Maulana', 'Siti Nurhaliza Putri',
  'I Gede Bagus Arya', 'Dewi Anggraini', 'Muhammad Fauzan', 'Ni Luh Putu Sari',
  'Ahmad Ridwan Hakim', 'Baiq Rohmah Yuliani', 'Lalu Satria Wijaya', 'Ni Made Ratna',
  'Hendra Gunawan', 'Fitriani Rahmawati', 'I Wayan Suardana', 'Nurul Hidayah',
  'Bagus Prasetyo', 'Ni Komang Trisna', 'Zulkifli Anwar', 'Ratna Sari Dewi',
];

const FALLBACK_HUBS = [
  { hub: 'Sambalia Hub', city: 'Lombok Timur', region: 'Nusa Tenggara Barat' },
  { hub: 'Praya Hub', city: 'Lombok Tengah', region: 'Nusa Tenggara Barat' },
  { hub: 'Mataram Hub', city: 'Mataram', region: 'Nusa Tenggara Barat' },
];

const FALLBACK_POIS = [
  'Pasar Tanjung', 'Alfamart Labuhan Lombok', 'Warung Bu Tuti', 'Puskesmas Sambalia',
  'Indomaret Sugian', 'Kantor Desa Belanting', 'Toko Sembako Berkah', 'SPBU Pringgabaya',
];

const CF_EMAILS = ['cf.lombok.a@example.com', 'cf.lombok.b@example.com', 'cf.ntb.c@example.com'];

// Every visual state the board has to render, named so the generator can guarantee coverage
// rather than hoping the dice produce one of each.
const SCENARIOS = {
  ON_TIME: 'on_time',
  LATE: 'late',
  OPEN: 'open',              // clocked in, never clocked out
  // EARLY_OUT was removed rather than renamed: clock-out is gated on shift length now, so a
  // short shift is not a state the board can ever be shown by the real app.
  OUT_OF_RADIUS: 'out_of_radius',
  UNVERIFIED_POI: 'unverified_poi',
  OFF_POI: 'off_poi',        // clocked in somewhere not on the recommended list
  ABSENT: 'absent',
};

function pickScenario(r) {
  const x = r();
  if (x < 0.07) return SCENARIOS.ABSENT;
  if (x < 0.19) return SCENARIOS.LATE;
  if (x < 0.25) return SCENARIOS.OPEN;
  if (x < 0.33) return SCENARIOS.ON_TIME;
  if (x < 0.40) return SCENARIOS.OUT_OF_RADIUS;
  if (x < 0.46) return SCENARIOS.UNVERIFIED_POI;
  if (x < 0.50) return SCENARIOS.OFF_POI;
  return SCENARIOS.ON_TIME;
}

function jitterCoord(base, r, metres) {
  return base + ((r() - 0.5) * 2 * metres) / 111320;
}

// Whole teams, not a scatter of strangers.
//
// The obvious grouping — hub — turns out to be meaningless here: the live roster holds 504
// SPG spread across 499 hubs, so a hub is one person, not a team. The unit that actually has
// members is the CF: 108 of them, a median of 3 SPG each and 11 at the largest. So the seed
// fills up by taking the largest CF teams whole, which is both a truer demo and the shape the
// eventual per-CF view will have.
function buildRoster(realRoster, realSupervisors, count) {
  if (realRoster && realRoster.length) {
    const active = realRoster.filter(p => p.active && p.name);
    const cfOf = p => (realSupervisors && realSupervisors[p.opsId] && realSupervisors[p.opsId].cfEmail) || p.cfEmail || null;

    const teams = new Map();
    for (const p of active) {
      const cf = cfOf(p);
      if (!cf) continue;
      if (!teams.has(cf)) teams.set(cf, []);
      teams.get(cf).push({ ...p, cfEmail: cf });
    }

    const out = [];
    for (const [, members] of [...teams.entries()].sort((a, b) => b[1].length - a[1].length)) {
      if (out.length >= count) break;
      out.push(...members);
    }
    if (out.length) return out.slice(0, Math.max(count, 0) || out.length);
  }
  return FALLBACK_NAMES.slice(0, count).map((name, i) => {
    const h = FALLBACK_HUBS[i % FALLBACK_HUBS.length];
    return {
      name,
      opsId: `OS9${100000 + i * 137}`.slice(0, 8),
      fmsId: `FMS${900 + i}`,
      hub: h.hub, city: h.city, region: h.region, active: true,
      // Teams of roughly the real size (median 3, max 11) rather than one CF per person.
      cfEmail: CF_EMAILS[Math.floor(i / 4) % CF_EMAILS.length],
    };
  });
}

function generate({ roster, supervisors, poisByHub, days = 14, people = 18, today = new Date() } = {}) {
  const staff = buildRoster(roster, supervisors, people);
  const sessions = [];
  const events = [];

  const dayList = [];
  for (let i = days - 1; i >= 0; i--) {
    dayList.push(new Date(today.getFullYear(), today.getMonth(), today.getDate() - i));
  }

  // Coverage guarantee: the first eight people get one hand-assigned scenario each on the
  // most recent working day, so the board always shows every state it can render even if
  // the random draw happens to miss one.
  const guaranteed = [
    SCENARIOS.ON_TIME, SCENARIOS.LATE, SCENARIOS.OUT_OF_RADIUS, SCENARIOS.UNVERIFIED_POI,
    SCENARIOS.OFF_POI, SCENARIOS.OPEN, SCENARIOS.ABSENT,
  ];
  const lastWorkday = [...dayList].reverse().find(d => d.getDay() !== 0) || dayList[dayList.length - 1];
  const lastWorkdayStr = dateStr(lastWorkday);

  staff.forEach((person, pIdx) => {
    const hubPois = poisByHub && poisByHub[person.hub];
    const pois = (hubPois && hubPois.length) ? hubPois : FALLBACK_POIS.map((name, i) => ({
      id: `poi-demo-${i}`, name,
      lat: -8.45 + i * 0.012, lng: 116.65 + i * 0.012,
      coordConfidence: i % 3 === 0 ? 'low' : 'high',
    }));

    for (const day of dayList) {
      const ds = dateStr(day);
      if (day.getDay() === 0) continue; // Sunday — the board renders it as a rest day, not a gap
      const r = rng(`${person.opsId}|${ds}`);
      let scenario = pickScenario(r);
      if (ds === lastWorkdayStr && pIdx < guaranteed.length) scenario = guaranteed[pIdx];
      if (scenario === SCENARIOS.ABSENT) continue;

      const sessionId = `${person.opsId}_${ds}`;
      const inEventId = `${sessionId}_in`;
      const outEventId = `${sessionId}_out`;

      /* A later start is still worth seeding — SPGs genuinely begin at different hours — but
         it is no longer a verdict. Attendance is judged on shift length now
         (config.rules.minShiftHours), so there is no "late" for this to be. */
      const late = scenario === SCENARIOS.LATE;
      const inTime = late
        ? atTime(day, 10, 5 + Math.floor(r() * 70))
        : atTime(day, 8, 5 + Math.floor(r() * 95));
      const inStatus = 'Clocked In';

      const poiIdx = Math.floor(r() * pois.length);
      const poiIn = pois[poiIdx];
      const offPoi = scenario === SCENARIOS.OFF_POI;
      const far = scenario === SCENARIOS.OUT_OF_RADIUS || scenario === SCENARIOS.UNVERIFIED_POI;
      const spread = far ? 300 + r() * 900 : r() * 180;
      const lat = jitterCoord(poiIn.lat, r, spread);
      const lng = jitterCoord(poiIn.lng, r, spread);
      const distance = far ? Math.round(280 + r() * 820) : Math.round(r() * 200);

      const inFlags = [];
      if (offPoi) inFlags.push('NON_RECOMMENDED_LOCATION');
      else if (scenario === SCENARIOS.UNVERIFIED_POI) inFlags.push('OUT_OF_RADIUS_UNVERIFIED_POI');
      else if (scenario === SCENARIOS.OUT_OF_RADIUS) inFlags.push('OUT_OF_RADIUS');

      events.push([
        inEventId, sessionId, person.opsId, 'Clock In',
        offPoi ? 'other' : poiIn.id,
        offPoi ? 'Lokasi lain (diisi manual)' : poiIn.name,
        lat.toFixed(6), lng.toFixed(6), Math.round(5 + r() * 35),
        offPoi ? '' : distance,
        inTime.toISOString(), inTime.toISOString(), '', '',
        offPoi ? 'Titik biasa tutup, pindah ke pasar sebelah.' : '',
        inFlags.join(','), '',
      ]);

      const open = scenario === SCENARIOS.OPEN;
      let outTime = null;
      let outStatus = '';
      const outFlags = [];
      if (!open) {
        /* Derived from the clock-in rather than pinned to an hour of the day, because a
           clock-out closer together than minShiftHours can no longer be written at all —
           lib/attendance.js refuses it. Seeding one would put a shape on the supervisor's
           board that the app cannot actually produce. */
        outTime = new Date(inTime.getTime()
          + config.rules.minShiftHours * 3600000
          + Math.floor(r() * 75) * 60000);
        outStatus = 'Normal';

        const poiOut = pois[(poiIdx + 1 + Math.floor(r() * Math.max(1, pois.length - 1))) % pois.length];
        const outLat = jitterCoord(poiOut.lat, r, r() * 160);
        const outLng = jitterCoord(poiOut.lng, r, r() * 160);
        events.push([
          outEventId, sessionId, person.opsId, 'Clock Out',
          poiOut.id, poiOut.name, outLat.toFixed(6), outLng.toFixed(6),
          Math.round(5 + r() * 35), Math.round(r() * 190),
          outTime.toISOString(), outTime.toISOString(), '', '',
          '', outFlags.join(','), '',
        ]);
      }

      const allFlags = [...new Set([...inFlags, ...outFlags])];
      const needsReview = allFlags.length > 0;

      // Some of the older flagged sessions are already decided, so the board shows a queue
      // being worked through rather than one nobody has ever touched.
      let reviewStatus = needsReview ? 'Needs Review' : 'Pending';
      let reviewReason = '';
      let reviewedBy = '';
      let reviewedAt = '';
      const ageDays = Math.round((lastWorkday - day) / 86400000);
      if (needsReview && ageDays >= 3 && r() < 0.65) {
        const approved = r() < 0.6;
        reviewStatus = approved ? 'Approved' : 'Rejected';
        reviewReason = approved
          ? 'Sudah dicek — pin POI-nya memang meleset, SPG ada di lokasi.'
          : 'Foto dan jarak tidak cocok dengan rute hari itu.';
        reviewedBy = person.cfEmail || CF_EMAILS[0];
        reviewedAt = atTime(new Date(day.getFullYear(), day.getMonth(), day.getDate() + 2), 9, 30).toISOString();
      }

      const overall = needsReview
        ? 'Needs Review'
        : (open ? 'Clocked In' : 'Clocked Out');
      const activityResult = open ? '' : (r() < 0.75 ? 'Berhasil' : 'Tidak ada pendaftar');

      sessions.push([
        sessionId, person.opsId, person.name, ds,
        inEventId, inTime.toISOString(), inStatus,
        open ? '' : outEventId, open ? '' : outTime.toISOString(), outStatus,
        activityResult, '',
        overall, reviewStatus, reviewReason, reviewedBy, reviewedAt,
        (outTime || inTime).toISOString(),
      ]);
    }
  });

  return {
    generatedAt: new Date().toISOString(),
    rosterSource: roster && roster.length ? 'SPG List LM' : 'fallback (nama sintetis)',
    days,
    roster: staff,
    sessions,
    events,
  };
}

function load() {
  try {
    return JSON.parse(fs.readFileSync(SEED_FILE, 'utf8'));
  } catch {
    return null; // no seed generated yet — the board falls back to real data only
  }
}

function save(seed) {
  fs.mkdirSync(path.dirname(SEED_FILE), { recursive: true });
  fs.writeFileSync(SEED_FILE, JSON.stringify(seed, null, 2));
  return SEED_FILE;
}

module.exports = { generate, load, save, SEED_FILE, SCENARIOS };
