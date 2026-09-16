const { readRange } = require('./gwsClient');
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
  return s ? 'unknown' : 'unknown';
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
  const rows = await readRange(config.sheets.poiMaster, `'POI Master'!A${dataStartRow}:Z5012`);
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

  const ids = resolveIds(hub, base);
  return base.map((p, i) => ({
    id: ids[i],
    ...p,
    recommended: i < 3, // MVP rotation logic (FR-REC-04) isn't wired up yet — first three stand in for it
  }));
}

function poiCache(hub) {
  return cache({
    key: `poi-${hub.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`,
    ttlMs: config.cache.poiTtlMs,
    loader: () => loadPoisForHub(hub),
  });
}

async function getPoisForHub(hub) {
  const { data } = await poiCache(hub).get();
  return data;
}

module.exports = { getPoisForHub, poiCache, coordConfidence };
