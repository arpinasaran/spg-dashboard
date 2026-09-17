const { readRange, valuesAppend, listTabs, batchUpdate, valuesUpdate } = require('./sheetsClient');
const { cache } = require('./cache');
const config = require('../config');

const TAB = config.sheets.poiProposalsTab;
const RANGE = `'${TAB}'!A2:U`;

// The column vocabulary deliberately echoes "POI Master" itself — Station Name, POI Location,
// POI Category, Google Maps. An approved proposal is then a copy across, not a translation,
// which is the whole reason this tab lives in the POI Master spreadsheet rather than in a
// separate file of its own.
const HEADER = [
  'Proposal ID', 'Submitted At', 'SPG OpsID', 'SPG Name', 'Station Name', 'City', 'Region',
  'POI Location', 'POI Category', 'Google Maps', 'Device Latitude', 'Device Longitude',
  'SPG Note', 'Status', 'Reviewed By', 'Reviewed At', 'Review Note',
  // R-U. The PRD lets a CF fix a proposal's name, category, hub or Maps link while approving
  // it, and those corrections have to survive as data rather than as prose in Review Note:
  // the row they get copied into is built from them, a failed copy is retried from them, and
  // the SPG is shown what changed. A-M stays exactly as the SPG submitted it (FR-ATT-04's
  // reasoning applied to proposals), so a correction is an overlay, never an edit.
  // Blank means "no correction" -- the original column is used.
  'Approved Station Name', 'Approved POI Location', 'Approved POI Category', 'Approved Google Maps',
];

// Columns A-M belong to this app, N-U to whoever reviews. See INTEGRATION_CONTRACT.md 10.
const MIN_COLUMNS = HEADER.length;

const STATUS_PENDING = 'Menunggu';

// Creating the tab is idempotent and runs off the write path, so a first-ever proposal on a
// fresh spreadsheet works without anyone having run a setup step by hand.
//
// It also migrates a tab created before the reviewer's correction columns existed. A sheet is
// a fixed grid, not an open plane: writing to U on a 17-column tab fails on a grid limit, and
// it would fail inside a CF's approval rather than here. Widening is done once, on the read
// path, where the cost is a round trip nobody is waiting on.
let ensured = null;
async function ensureTab() {
  if (!ensured) {
    ensured = (async () => {
      const tabs = await listTabs(config.sheets.poiMaster);
      const tab = tabs.find(t => t.title === TAB);
      if (!tab) {
        await batchUpdate(config.sheets.poiMaster, [{
          addSheet: { properties: { title: TAB, gridProperties: { rowCount: 1000, columnCount: MIN_COLUMNS } } },
        }]);
        await valuesUpdate(config.sheets.poiMaster, `'${TAB}'!A1:U1`, [HEADER]);
        return;
      }

      const columns = (tab.gridProperties && tab.gridProperties.columnCount) || 0;
      if (columns && columns < MIN_COLUMNS) {
        await batchUpdate(config.sheets.poiMaster, [{
          appendDimension: { sheetId: tab.sheetId, dimension: 'COLUMNS', length: MIN_COLUMNS - columns },
        }]);
      }

      // Only row 1, and only when it actually disagrees: the reviewer needs to read these
      // names to know which column is which, but nothing below row 1 is ours to restate.
      const head = await readRange(config.sheets.poiMaster, `'${TAB}'!A1:U1`);
      const current = (head[0] || []).map(v => String(v == null ? '' : v).trim());
      if (HEADER.some((name, i) => current[i] !== name)) {
        await valuesUpdate(config.sheets.poiMaster, `'${TAB}'!A1:U1`, [HEADER]);
      }
    })().catch(err => { ensured = null; throw err; });
  }
  return ensured;
}

function rowToProposal(r) {
  const [proposalId, submittedAt, opsId, spgName, hub, city, region,
    name, category, maps, lat, lng, note, status, reviewedBy, reviewedAt, reviewNote,
    okHub, okName, okCategory, okMaps] = r;

  // A correction counts only when the reviewer actually put something different there, so a
  // CF who retypes the same name does not produce a "diubah" the SPG has to puzzle over.
  const corrections = [];
  const applied = (label, original, approved) => {
    const value = (approved == null ? '' : String(approved)).trim();
    const from = (original == null ? '' : String(original)).trim();
    if (!value || value === from) return from;
    corrections.push({ field: label, from, to: value });
    return value;
  };

  return {
    proposalId, submittedAt, opsId, spgName, city, region,
    hub: applied('Hub', hub, okHub),
    name: applied('Nama', name, okName),
    category: applied('Kategori', category, okCategory),
    maps: applied('Maps', maps, okMaps),
    proposedName: (name || '').trim(),
    lat: lat === '' || lat == null ? null : Number(lat),
    lng: lng === '' || lng == null ? null : Number(lng),
    note: note || null,
    status: status || STATUS_PENDING,
    reviewedBy: reviewedBy || null,
    reviewedAt: reviewedAt || null,
    reviewNote: reviewNote || null,
    corrections,
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

   Whether that access exists is a question only Google can answer, so it is asked by trying.
   This used to refuse up front whenever the service-account driver was in use, with a comment
   claiming the feature would return the day the sheet was shared — it would not have, because
   the driver's name says nothing about what the sheet allows. Sharing "POI Master" with the
   service account now genuinely is the whole fix.

   What the attempt buys is that the refusal stays honest in both directions: an SPG is told
   the feature is unavailable only when it actually is, and a real permissions error is
   translated into something they can act on instead of Google's wording. */
const DENIED = 'Usulan POI baru belum bisa dikirim dari versi online — sementara lewat aplikasi lokal dulu.';

function isPermissionDenied(err) {
  const status = err.status || err.code || (err.response && err.response.status);
  if (status === 403 || status === 401) return true;
  // The gws driver surfaces the API's error as text rather than a status.
  return /PERMISSION_DENIED|insufficient|403|does not have permission/i.test(err.message || '');
}

async function appendProposal(row) {
  try {
    await ensureTab();
    await valuesAppend(config.sheets.poiMaster, `'${TAB}'!A2`, [row]);
  } catch (err) {
    if (isPermissionDenied(err)) throw Object.assign(new Error(DENIED), { status: 503 });
    throw err;
  }
}

async function create({ opsId, spgName, hub, city, region, name, category, maps, lat, lng, note }) {
  const clean = v => (v == null ? '' : String(v).trim());
  if (clean(name).length < 3) throw Object.assign(new Error('Nama tempat minimal 3 karakter.'), { status: 400 });
  if (!/^https?:\/\//i.test(clean(maps))) throw Object.assign(new Error('Tautan Google Maps tidak valid.'), { status: 400 });

  const now = new Date();
  const row = [
    proposalId(opsId, now), now.toISOString(), opsId, clean(spgName), clean(hub), clean(city), clean(region),
    clean(name), clean(category), clean(maps),
    lat == null ? '' : lat, lng == null ? '' : lng,
    clean(note), STATUS_PENDING,
    '', '', '', // Reviewed By / Reviewed At / Review Note — the reviewer's to fill, not ours
  ];
  await appendProposal(row);

  // Write-through, same contract as attendance: we know what the sheet now holds, so the
  // next read doesn't have to pay a round trip to discover it.
  const c = proposalsCache();
  const current = c.peek();
  if (current) c.set(current.data.concat([rowToProposal(row)]));

  return rowToProposal(row);
}

module.exports = {
  getAll, getForSpg, create, proposalsCache, ensureTab,
  HEADER, TAB, STATUS_PENDING, rowToProposal, isPermissionDenied, DENIED,
};
