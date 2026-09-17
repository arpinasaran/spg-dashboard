const { readRange } = require('./sheetsClient');
const { cache } = require('./cache');
const { resolveIds } = require('./poiRegistry');
const config = require('../config');

function buildHeaderMap(headerRow) {
  const map = {};
  headerRow.forEach((h, i) => { if (h) map[h.trim()] = i; });
  return map;
}

function firstPresent(col, names) {
  for (const n of names) if (n in col) return col[n];
  return null;
}

function toNumber(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// "Geocode Status" tells us how the coordinate was obtained. A partial geocode can sit a few
// hundred metres from the real place, which matters a lot once a 250m geofence decides
// whether someone's attendance is valid — so the quality travels with the POI and the UI can
// soften the verdict instead of wrongly flagging an SPG who is actually standing there.
function coordConfidence(status) {
  const s = (status || '').toLowerCase();
  if (s.includes('maps url') || s.includes('best match')) return 'high';
  if (s.includes('partial')) return 'low';
  // "Validated: ..." appeared in POI Master after the enrichment pass. Before it was listed
  // here it fell through to 'unknown', which the geofence treats exactly like 'high' — so a
  // pin nobody had checked carried the same authority as one resolved from a Maps URL.
  // Unrecognised values still land on 'unknown'; the point is that a known one is named.
  if (s.includes('validated')) return 'high';
  // An approved POI proposal. The dashboard writes "Provided by SPG device" here and
  // "POI Proposal device coordinates" into Coordinate Source, carrying across the lat/lng the
  // SPG's phone reported while they were standing at the place. That is the best provenance a
  // POI in this sheet can have -- better than a geocoded address -- so it is named rather than
  // left to fall through. It already behaved as 'high' by accident, because the geofence treats
  // 'unknown' the same way; that accident would end the moment anyone decided an unrecognised
  // status deserved softening, and every proposed POI would quietly start apologising for a
  // coordinate that is in fact the most trustworthy one on the row.
  if (s.includes('device')) return 'high';
  return 'unknown';
}

/* ---------- daily recommendation rotation ----------
   FR-REC-04's real rotation logic (coverage, visit history, flyering targets) isn't wired up
   yet. Until it is, the recommendation is a random draw from the hub's own POIs — which is
   still better than the first three rows of the sheet, because those three were the only
   ones an SPG could ever pick and the rest of the hub was effectively invisible.

   The draw is seeded by hub + calendar date, not by Math.random(), and that matters: the
   list has to survive a page refresh, a cache refresh and a server restart within the same
   day. A genuinely random pick would reshuffle the clock-out options midway through a shift
   and could hide the very POI someone already clocked in at. */

function seedFrom(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed) {
  let a = seed;
  return function next() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Same day boundary as attendance, so the recommendation turns over when the working day
// does rather than when the host machine's midnight happens to fall. See lib/timezone.js.
function localDateStr(d = new Date()) {
  return require('./timezone').dateStr(d);
}

// Marks `count` POIs as recommended for the given day. Applied on read rather than inside the
// cache loader, so the cached POI data stays a plain copy of the sheet and the rotation turns
// over at local midnight instead of whenever the cache happens to expire.
function markRecommended(pois, { hub, date = localDateStr(), count = 3 } = {}) {
  const rand = mulberry32(seedFrom(`${hub || ''}|${date}`));
  const order = pois.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) { // Fisher-Yates with the seeded stream
    const j = Math.floor(rand() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  const chosen = new Set(order.slice(0, Math.min(count, pois.length)));
  return pois.map((p, i) => ({ ...p, recommended: chosen.has(i) }));
}

// Header row and column set here aren't assumed fixed either (see identity.js) — POI Master
// gained Latitude/Longitude/Geocode Status columns partway through this build and was picked
// up without a code change precisely because of this approach.
async function loadPoisForHub(hub) {
  const probe = await readRange(config.sheets.poiMaster, "'POI Master'!A1:Z5");
  const headerIdx = probe.findIndex(r => r.includes('Station Name') && r.includes('POI Location'));
  if (headerIdx < 0) throw new Error('Header row (Station Name/POI Location) not found in "POI Master"');
  const col = buildHeaderMap(probe[headerIdx]);

  const dataStartRow = headerIdx + 2;
  // Open-ended: approving a POI proposal appends a row here, so any guessed bound starts
  // silently hiding the newest POIs — the same failure already paid for on Raw_Register.
  const rows = await readRange(config.sheets.poiMaster, `'POI Master'!A${dataStartRow}:Z`);
  const filtered = rows.filter(r => (r[col['Station Name']] || '').trim() === hub);

  const latCol = firstPresent(col, ['Latitude', 'Lat']);
  const lngCol = firstPresent(col, ['Longitude', 'Lng', 'Long']);
  const statusCol = firstPresent(col, ['Geocode Status', 'Coordinate Source']);

  const base = filtered.map(r => ({
    region: r[col.Region] || '',
    province: r[col.Province] || '',
    city: r[col.City] || '',
    hub: (r[col['Station Name']] || '').trim(),
    name: (r[col['POI Location']] || '').trim(),
    category: (r[col['POI Category']] || '').trim(),
    maps: (r[col['Google Maps']] || '').trim(),
    lat: latCol != null ? toNumber(r[latCol]) : null,
    lng: lngCol != null ? toNumber(r[lngCol]) : null,
    coordConfidence: statusCol != null ? coordConfidence(r[statusCol]) : 'unknown',
    coordNote: statusCol != null ? (r[statusCol] || '').trim() : '',
  }));

  const ids = await resolveIds(hub, base);
  // No `recommended` here on purpose: it changes daily, the cache does not. See markRecommended.
  return base.map((p, i) => ({ id: ids[i], ...p }));
}

function poiCache(hub) {
  return cache({
    key: `poi-${hub.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`,
    ttlMs: config.cache.poiTtlMs,
    loader: () => loadPoisForHub(hub),
  });
}

async function getPoisForHub(hub, { date } = {}) {
  const { data } = await poiCache(hub).get();
  return markRecommended(data, { hub, date, count: config.rules.recommendedPoiCount });
}

module.exports = {
  getPoisForHub, poiCache, coordConfidence,
  markRecommended, localDateStr, seedFrom, mulberry32,
};
