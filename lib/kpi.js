const { batchGet } = require('./sheetsClient');
const { cache } = require('./cache');
const config = require('../config');

// Local calendar date. toISOString() would report a local midnight as the *previous* day for
// any timezone ahead of UTC (Jakarta is +7), which turns "last updated 14 Sep" into "13 Sep".
function localDateStr(d) {
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function currentWeekRange(now = new Date()) {
  const d = new Date(now);
  const day = d.getDay(); // 0=Sun..6=Sat
  const diffToMonday = day === 0 ? -6 : 1 - day;
  const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() + diffToMonday);
  const sunday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6, 23, 59, 59);
  return { start: monday, end: sunday };
}

// The three pipeline tabs don't agree on date format: Raw_Onboarding writes
// "2026-09-14 0:00:00" while Raw_Register/Raw_Creation write "9/14/2026 11:43:57".
// The slash format is unambiguously month-first (values like "9/14/2026" rule out
// day-first), so it is parsed as M/D/YYYY rather than the Indonesian D/M/YYYY.
function parseSheetDate(s) {
  if (!s) return null;
  const str = String(s).trim();

  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(str);
  if (iso) return new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));

  const slash = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(str);
  if (slash) return new Date(Number(slash[3]), Number(slash[1]) - 1, Number(slash[2]));

  const d = new Date(str);
  return isNaN(d) ? null : d;
}

function inWeek(dateStr, start, end) {
  const d = parseSheetDate(dateStr);
  return !!d && d >= start && d <= end;
}

// Days left in the batch, counting today. An SPG opening the app on Sunday still has today
// to work, so remainingDays must never read 0 while the week is still running.
function remainingDaysInWeek(now, end) {
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const endDay = new Date(end.getFullYear(), end.getMonth(), end.getDate());
  return Math.max(0, Math.round((endDay - startOfToday) / 86400000) + 1);
}

// Full funnel, computed live from the actual recruitment pipeline and matched by the SPG's
// Ops id (FMSID) rather than name — the SPG-attribution columns mix plain names and Ops
// codes, and name-only matching silently returns zero for rows that really exist.
//
// All three tabs are fetched in one batchGet: each gws invocation costs ~1.2s of process
// spawn + auth before any data moves, so three separate reads would triple the fixed cost
// for no benefit.
async function loadKpi(fmsId, now = new Date()) {
  // Open-ended ranges ("A4:A", no end row) on purpose. A bounded range silently truncates:
  // Raw_Register is 184k rows and an earlier A4:A99999 cut off 46% of it, which made this
  // SPG's weekly registrations read as 0 — a wrong number that looked like a real one.
  // Never bound these by a guessed row count; the tabs grow.
  const vr = await batchGet(config.sheets.onboarding, [
    'Raw_Register!A4:A',    // Timestamp
    'Raw_Register!G4:G',    // ID SPG
    'Raw_Creation!F4:F',    // Creation Timestamp
    'Raw_Creation!N4:N',    // ID SPG
    'Raw_Onboarding!H4:H',  // Onboard Date
    'Raw_Onboarding!I4:I',  // Lulus status
    'Raw_Onboarding!N4:N',  // SPG ID
  ]);
  const colOf = i => (vr[i] && vr[i].values ? vr[i].values.map(r => (r[0] || '').trim()) : []);
  const [regDate, regSpg, creDate, creSpg, onbDate, onbStatus, onbSpg] = [0, 1, 2, 3, 4, 5, 6].map(colOf);

  const { start, end } = currentWeekRange(now);

  let registered = 0;
  for (let i = 0; i < regSpg.length; i++) {
    if (regSpg[i] === fmsId && inWeek(regDate[i], start, end)) registered++;
  }

  let accountCreated = 0;
  for (let i = 0; i < creSpg.length; i++) {
    if (creSpg[i] === fmsId && inWeek(creDate[i], start, end)) accountCreated++;
  }

  let onboarded = 0;
  for (let i = 0; i < onbSpg.length; i++) {
    if (onbSpg[i] !== fmsId) continue;
    if (onbStatus[i] !== 'Lulus') continue;
    if (!inWeek(onbDate[i], start, end)) continue;
    onboarded++;
  }

  // Safety net for the failure mode above: if a source tab has no rows at all this week —
  // for anyone, not just this SPG — then a count of 0 says nothing about the SPG's work and
  // everything about the pipeline. Report it as unknown instead of as zero.
  const sources = {
    registered: sourceState(regDate, start, end),
    accountCreated: sourceState(creDate, start, end),
    onboarded: sourceState(onbDate, start, end),
  };
  if (!sources.registered.live) registered = null;
  if (!sources.accountCreated.live) accountCreated = null;
  if (!sources.onboarded.live) onboarded = null;

  const target = config.rules.weeklyTarget;
  const gap = onboarded == null ? null : Math.max(0, target - onboarded);
  const remainingDays = remainingDaysInWeek(now, end);
  const dailyTarget = gap == null ? null
    : (gap > 0 && remainingDays > 0 ? Math.ceil(gap / remainingDays) : 0);

  return {
    registered,
    accountCreated,
    onboarded,
    target,
    gap,
    remainingDays,
    dailyTarget,
    // Registered -> onboarded within the same week. Null rather than 0 when nobody
    // registered, so the UI shows "belum ada data" instead of an authoritative-looking 0%.
    conversionRate: registered && onboarded != null
      ? Math.round((onboarded / registered) * 1000) / 10
      : null,
    targetSource: 'interim', // not from an authoritative sheet yet — surfaced in the UI
    sources,
    weekStart: localDateStr(start),
    weekEnd: localDateStr(end),
  };
}

// A source counts as live if it has any row dated inside the current week. Also reports the
// latest date seen, so the UI can say *when* a stalled source last moved rather than just
// that something is wrong.
function sourceState(dates, start, end) {
  let latest = null;
  let live = false;
  for (const raw of dates) {
    const d = parseSheetDate(raw);
    if (!d) continue;
    if (!latest || d > latest) latest = d;
    if (d >= start && d <= end) live = true;
  }
  return { live, latest: latest ? localDateStr(latest) : null };
}

function kpiCache(fmsId) {
  return cache({
    key: `kpi-${fmsId}`,
    ttlMs: config.cache.kpiTtlMs,
    loader: () => loadKpi(fmsId),
  });
}

async function getWeeklyKpi(fmsId) {
  const { data, fetchedAt, stale } = await kpiCache(fmsId).get();
  return { ...data, fetchedAt: new Date(fetchedAt).toISOString(), stale };
}

module.exports = {
  getWeeklyKpi, kpiCache, currentWeekRange, parseSheetDate, remainingDaysInWeek,
  sourceState, localDateStr,
};
