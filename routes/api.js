const express = require('express');
const router = express.Router();

const identity = require('../lib/identity');
const poi = require('../lib/poi');
const kpi = require('../lib/kpi');
const attendance = require('../lib/attendance');
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
  const [pois, weekly, today, history] = await Promise.all([
    poi.getPoisForHub(me.hub),
    kpi.getWeeklyKpi(me.fmsId),
    attendance.getToday(me.opsId),
    attendance.getHistory(me.opsId, 14),
  ]);
  return {
    me,
    poi: pois,
    kpi: weekly,
    today,
    history,
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

// Forces the named datasets past their TTL and waits for the real read — used wherever the
// person at the keyboard explicitly asked for current numbers and is prepared to wait.
async function refreshCaches(scope = 'all') {
  const me = await identity.getIdentity();
  const jobs = [];
  if (scope === 'all' || scope === 'kpi') jobs.push(kpi.kpiCache(me.fmsId).refresh());
  if (scope === 'all' || scope === 'poi') jobs.push(poi.poiCache(me.hub).refresh());
  if (scope === 'all' || scope === 'attendance') jobs.push(attendance.storeCache().refresh());
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
