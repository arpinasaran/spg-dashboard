const express = require('express');
const router = express.Router();

const identity = require('../lib/identity');
const poi = require('../lib/poi');
const kpi = require('../lib/kpi');
const attendance = require('../lib/attendance');
const proposals = require('../lib/poiProposals');
const photoStore = require('../lib/photoStore');
const config = require('../config');

function wrap(handler, defaultStatus = 503) {
  return (req, res) => {
    handler(req, res).catch(err => {
      console.error(err);
      res.status(err.status || defaultStatus).json({ error: err.message });
    });
  };
}

function meta(c) {
  const e = c.peek();
  return e ? { fetchedAt: new Date(e.fetchedAt).toISOString(), stale: c.isStale() } : null;
}

// One call instead of five. Each of the old endpoints resolved identity first, so a cold
// page load fanned out into five parallel requests that each waited on the same lookup;
// now the page asks once and gets everything it needs to render.
async function bootstrap() {
  const me = await identity.getIdentity();
  const [pois, weekly, today, history, myProposals] = await Promise.all([
    poi.getPoisForHub(me.hub),
    kpi.getWeeklyKpi(me.fmsId),
    attendance.getToday(me.opsId),
    attendance.getHistory(me.opsId, 14),
    // Supplementary: a proposals tab that is unreachable must not stop the dashboard loading.
    proposals.getForSpg(me.opsId).catch(err => {
      console.error('Usulan POI tidak bisa dibaca:', err.message);
      return null;
    }),
  ]);
  return {
    me,
    poi: pois,
    kpi: weekly,
    today,
    history,
    proposals: myProposals,
    proposalCategories: await proposalCategories(me.hub),
    rules: {
      poiRadiusMeters: config.rules.poiRadiusMeters,
      lateAfterHour: config.rules.lateAfterHour,
      earlyBeforeHour: config.rules.earlyBeforeHour,
    },
    meta: {
      identity: meta(identity.identityCache(me.opsId)),
      poi: meta(poi.poiCache(me.hub)),
      kpi: meta(kpi.kpiCache(me.fmsId)),
      attendance: meta(attendance.storeCache()),
    },
  };
}

// What an SPG can pick from when proposing a POI. The hub's own POI Master categories come
// first — a proposal that reuses the master sheet's vocabulary needs no translation when it
// is approved — with a baseline list unioned in so a hub holding only two POIs doesn't leave
// someone unable to describe what they found.
const BASELINE_CATEGORIES = [
  'Pasar', 'Transportasi', 'Pusat Perbelanjaan', 'Kampus', 'Perkantoran',
  'Kantor Desa/Camat', 'Sekolah', 'Bengkel', 'Pangkalan Ojek',
  'Perkumpulan Warga', 'Warung Kopi / Warung Makan', 'Door to Door',
];

async function proposalCategories(hub) {
  let used = [];
  try {
    used = [...new Set((await poi.getPoisForHub(hub)).map(p => p.category).filter(Boolean))].sort();
  } catch {
    // POI list unavailable — the baseline alone still lets someone file a proposal.
  }
  return [...new Set([...used, ...BASELINE_CATEGORIES])].concat(['Lainnya']);
}

// Forces the named datasets past their TTL and waits for the real read — used wherever the
// person at the keyboard explicitly asked for current numbers and is prepared to wait.
async function refreshCaches(scope = 'all') {
  const me = await identity.getIdentity();
  const jobs = [];
  if (scope === 'all' || scope === 'kpi') jobs.push(kpi.kpiCache(me.fmsId).refresh());
  if (scope === 'all' || scope === 'poi') jobs.push(poi.poiCache(me.hub).refresh());
  if (scope === 'all' || scope === 'attendance') jobs.push(attendance.storeCache().refresh());
  // Non-fatal: proposals are supplementary, and Perbarui must still refresh the numbers an
  // SPG actually opened the app for even if that tab is unreachable.
  if (scope === 'all' || scope === 'proposals') {
    jobs.push(proposals.proposalsCache().refresh().catch(err => console.error('Refresh usulan POI gagal:', err.message)));
  }
  if (scope === 'all') jobs.push(identity.identityCache(me.opsId).refresh());
  await Promise.all(jobs);
}

// A hard reload (Ctrl+Shift+R) is the one reload where the browser explicitly says "ignore
// what you have cached". server.js spots that on the document request and flags it here, so
// the bootstrap that immediately follows re-reads the sheets instead of serving the snapshot.
// A normal reload still gets the fast cached path.
let hardReloadPending = false;
function markHardReload() { hardReloadPending = true; }

router.get('/bootstrap', wrap(async (req, res) => {
  if (hardReloadPending) {
    hardReloadPending = false;
    // A failed forced read must not block the page — fall through to the cached copy.
    try { await refreshCaches('all'); } catch (err) { console.error('Refresh paksa gagal:', err.message); }
  }
  res.json(await bootstrap());
}));

router.post('/refresh', wrap(async (req, res) => {
  await refreshCaches((req.body && req.body.scope) || 'all');
  res.json(await bootstrap());
}));

router.get('/me', wrap(async (req, res) => {
  res.json(await identity.getIdentity());
}));

router.get('/poi', wrap(async (req, res) => {
  const me = await identity.getIdentity();
  res.json(await poi.getPoisForHub(me.hub));
}));

router.get('/kpi', wrap(async (req, res) => {
  const me = await identity.getIdentity();
  res.json(await kpi.getWeeklyKpi(me.fmsId));
}));

router.get('/attendance/today', wrap(async (req, res) => {
  const me = await identity.getIdentity();
  res.json(await attendance.getToday(me.opsId));
}));

router.get('/attendance/history', wrap(async (req, res) => {
  const me = await identity.getIdentity();
  res.json(await attendance.getHistory(me.opsId, 14));
}));

/* ---------- POI proposals ----------
   These used to live in a JavaScript array in the browser: the UI said "Usulan POI terkirim"
   and the usulan went nowhere, disappearing on the next refresh. They now append a row to the
   "POI Proposals" tab of the POI Master spreadsheet, where a CF can actually see them. */

router.get('/poi-proposals', wrap(async (req, res) => {
  const me = await identity.getIdentity();
  res.json({
    proposals: await proposals.getForSpg(me.opsId),
    categories: await proposalCategories(me.hub),
  });
}));

router.post('/poi-proposals', wrap(async (req, res) => {
  const me = await identity.getIdentity();
  const b = req.body || {};
  const created = await proposals.create({
    opsId: me.opsId, spgName: me.name, hub: me.hub, city: me.city, region: me.region,
    name: b.name, category: b.category, maps: b.maps, note: b.note,
    lat: b.lat, lng: b.lng,
  });
  res.json({ proposal: created, proposals: await proposals.getForSpg(me.opsId) });
}, 400));

/* ---------- attendance photo ----------
   A photo reference on a sheet row is a Drive file id, not a URL. This turns one into an
   image the browser can load, pulling it down from Drive on first miss — which is what lets
   the board show evidence on a machine that never took the photo. */
router.get('/photo/:ref', wrap(async (req, res) => {
  const file = await photoStore.resolve(req.params.ref);
  if (!file) return res.status(404).json({ error: 'Foto tidak ditemukan' });
  res.set('Cache-Control', 'private, max-age=86400'); // evidence is immutable once written
  res.sendFile(file);
}, 404));

router.get('/attendance/session/:sessionId', wrap(async (req, res) => {
  const me = await identity.getIdentity();
  res.json(await attendance.getSessionDetail(me.opsId, req.params.sessionId));
}));

router.post('/attendance/clock-in', wrap(async (req, res) => {
  const me = await identity.getIdentity();
  const result = await attendance.clockIn({ opsId: me.opsId, spgName: me.name, ...req.body });
  res.json({ ...result, today: await attendance.getToday(me.opsId), history: await attendance.getHistory(me.opsId, 14) });
}, 400));

router.post('/attendance/clock-out', wrap(async (req, res) => {
  const me = await identity.getIdentity();
  const result = await attendance.clockOut({ opsId: me.opsId, ...req.body });
  res.json({ ...result, today: await attendance.getToday(me.opsId), history: await attendance.getHistory(me.opsId, 14) });
}, 400));

module.exports = { router, bootstrap, markHardReload };
