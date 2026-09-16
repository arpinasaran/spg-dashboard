const { readRange, valuesAppend, listTabs, batchUpdate, valuesUpdate } = require('./sheetsClient');
const { cache } = require('./cache');
const config = require('../config');

const TAB = config.sheets.poiProposalsTab;
const RANGE = `'${TAB}'!A2:Q`;

// The column vocabulary deliberately echoes "POI Master" itself — Station Name, POI Location,
// POI Category, Google Maps. An approved proposal is then a copy across, not a translation,
// which is the whole reason this tab lives in the POI Master spreadsheet rather than in a
// separate file of its own.
const HEADER = [
  'Proposal ID', 'Submitted At', 'SPG OpsID', 'SPG Name', 'Station Name', 'City', 'Region',
  'POI Location', 'POI Category', 'Google Maps', 'Device Latitude', 'Device Longitude',
  'SPG Note', 'Status', 'Reviewed By', 'Reviewed At', 'Review Note',
];

const STATUS_PENDING = 'Menunggu';

// Creating the tab is idempotent and runs off the write path, so a first-ever proposal on a
// fresh spreadsheet works without anyone having run a setup step by hand.
let ensured = null;
async function ensureTab() {
  if (!ensured) {
    ensured = (async () => {
      const tabs = await listTabs(config.sheets.poiMaster);
      if (tabs.some(t => t.title === TAB)) return;
      await batchUpdate(config.sheets.poiMaster, [{
        addSheet: { properties: { title: TAB, gridProperties: { rowCount: 1000, columnCount: HEADER.length } } },
      }]);
      await valuesUpdate(config.sheets.poiMaster, `'${TAB}'!A1:Q1`, [HEADER]);
    })().catch(err => { ensured = null; throw err; });
  }
  return ensured;
}

function rowToProposal(r) {
  const [proposalId, submittedAt, opsId, spgName, hub, city, region,
    name, category, maps, lat, lng, note, status, reviewedBy, reviewedAt, reviewNote] = r;
  return {
    proposalId, submittedAt, opsId, spgName, hub, city, region,
    name, category, maps,
    lat: lat === '' || lat == null ? null : Number(lat),
    lng: lng === '' || lng == null ? null : Number(lng),
    note: note || null,
    status: status || STATUS_PENDING,
    reviewedBy: reviewedBy || null,
    reviewedAt: reviewedAt || null,
    reviewNote: reviewNote || null,
  };
}

async function loadAll() {
  await ensureTab();
  // Open-ended range: the tab grows one row per proposal and a guessed bound would start
  // silently dropping the newest ones, which is exactly the failure this codebase already
  // paid for once on Raw_Register.
  const rows = await readRange(config.sheets.poiMaster, RANGE);
  return rows.filter(r => (r[0] || '').trim()).map(rowToProposal);
}

function proposalsCache() {
  return cache({ key: 'poi-proposals', ttlMs: config.cache.proposalsTtlMs, loader: loadAll });
}

async function getAll() {
  const { data } = await proposalsCache().get();
  return data;
}

async function getForSpg(opsId) {
  const all = await getAll();
  return all.filter(p => p.opsId === opsId)
    .sort((a, b) => String(b.submittedAt).localeCompare(String(a.submittedAt)));
}

function proposalId(opsId, now) {
  const stamp = now.toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  return `PRP_${opsId}_${stamp}`;
}

/* Proposals are appended to a tab inside "POI Master", which is deliberate — an approved
   proposal becomes a copy across rather than a translation (see the HEADER comment above).
   The cost of that choice is that this feature needs write access to a spreadsheet owned by
   another team, which a deployed instance does not have: it runs as a service account, and
   only the Attendance spreadsheet and the photos folder were shared with it.

   Rather than let the append fail deep inside the Sheets API with a permissions error the
   SPG cannot act on, say plainly that this is a local-only feature for now. It stops being
   one the day "POI Master" is shared with the service account — no code change needed. */
function assertCanWriteProposals() {
  const { driverName } = require('./sheetsClient');
  if (driverName() === 'google') {
    throw Object.assign(
      new Error('Usulan POI baru belum bisa dikirim dari versi online — sementara lewat aplikasi lokal dulu.'),
      { status: 503 },
    );
  }
}

async function create({ opsId, spgName, hub, city, region, name, category, maps, lat, lng, note }) {
  assertCanWriteProposals();
  const clean = v => (v == null ? '' : String(v).trim());
  if (clean(name).length < 3) throw Object.assign(new Error('Nama tempat minimal 3 karakter.'), { status: 400 });
  if (!/^https?:\/\//i.test(clean(maps))) throw Object.assign(new Error('Tautan Google Maps tidak valid.'), { status: 400 });

  await ensureTab();
  const now = new Date();
  const row = [
    proposalId(opsId, now), now.toISOString(), opsId, clean(spgName), clean(hub), clean(city), clean(region),
    clean(name), clean(category), clean(maps),
    lat == null ? '' : lat, lng == null ? '' : lng,
    clean(note), STATUS_PENDING,
    '', '', '', // Reviewed By / Reviewed At / Review Note — the reviewer's to fill, not ours
  ];
  await valuesAppend(config.sheets.poiMaster, `'${TAB}'!A2`, [row]);

  // Write-through, same contract as attendance: we know what the sheet now holds, so the
  // next read doesn't have to pay a round trip to discover it.
  const c = proposalsCache();
  const current = c.peek();
  if (current) c.set(current.data.concat([rowToProposal(row)]));

  return rowToProposal(row);
}

module.exports = { getAll, getForSpg, create, proposalsCache, ensureTab, HEADER, TAB, STATUS_PENDING, rowToProposal };
