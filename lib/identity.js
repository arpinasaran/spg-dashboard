const { readRange } = require('./sheetsClient');
const { cache } = require('./cache');
const sheet = require('./spgSheet');
const config = require('../config');

// Identity for the one SPG this instance represents. Column names on "SPG List LM" are not
// stable — see lib/spgSheet.js, which owns the accepted-names list for both this and the
// roster read.
/* The roster sheet, read once. Kept separate from building one person's identity out of it
   because the read is the expensive half and it is the same read for everyone: giving each
   SPG their own view means snapshotting each of them, and scripts/sync-snapshot.js would
   otherwise pay two reads of a 4000-row sheet per account. */
async function loadRosterRows() {
  const probe = await readRange(config.sheets.identity, sheet.PROBE_RANGE);
  const headerIdx = sheet.findHeader(probe, 'Name', 'OSID');
  const col = sheet.columns(probe[headerIdx]);

  const missing = col.missing(['name', 'opsId', 'fmsId', 'hub']);
  if (missing.length) throw new Error(`"SPG List LM" kehilangan kolom: ${missing.join(', ')}`);

  const rows = await readRange(config.sheets.identity, sheet.dataRange(headerIdx));
  return { col, rows };
}

function buildIdentity(col, row) {
  const identity = {
    name: col.get(row, 'name'),
    opsId: col.get(row, 'opsId'),
    fmsId: col.get(row, 'fmsId'),
    hub: col.get(row, 'hub'),
    city: col.get(row, 'city'),
    province: col.get(row, 'province'),
    region: col.get(row, 'region'),
    active: col.has('resignDate') ? !col.get(row, 'resignDate') : true,
    // WIB / WITA / WIT, from the province. Carried on the identity so anything showing this
    // SPG's times to someone in another zone — the supervisor board above all — can say which
    // clock they are quoting instead of silently using the reader's own.
    timezone: require('./timezone').labelFor(col.get(row, 'province')),
    supervisor: null,
  };

  // The supervisor emails now sit on the roster sheet itself. When they do, the row we
  // already have answers the question and the second spreadsheet is never opened.
  if (col.has('cfEmail') || col.has('coordinatorEmail')) {
    identity.supervisor = {
      cfEmail: col.get(row, 'cfEmail') || null,
      coordinatorEmail: col.get(row, 'coordinatorEmail') || null,
      leadArea: col.get(row, 'leadArea') || null,
      source: 'SPG List LM',
    };
  }
  return identity;
}

function findRow(col, rows, opsId) {
  const row = rows.find(r => col.get(r, 'opsId') === opsId);
  if (!row) throw new Error(`OpsID ${opsId} not found in "SPG List LM" — check config.js`);
  return row;
}

async function loadIdentity(opsId) {
  const { col, rows } = await loadRosterRows();
  const identity = buildIdentity(col, findRow(col, rows, opsId));

  // Older layout: the supervisor mapping lives in "Data PIC SPG" rather than on the roster
  // row. It is supplementary — if that sheet is unreachable or restructured, the SPG's own
  // dashboard must still load; only the CF review path depends on it.
  if (!identity.supervisor) {
    try {
      identity.supervisor = await loadSupervisor(opsId);
    } catch {
      identity.supervisor = null;
    }
  }
  return identity;
}

// One read of the roster, many identities. Returns opsId -> identity, skipping any OpsID the
// sheet does not know rather than failing the whole batch for one bad account.
async function loadIdentityBatch(opsIds) {
  const { col, rows } = await loadRosterRows();
  const out = {};
  for (const opsId of opsIds) {
    try {
      out[opsId] = buildIdentity(col, findRow(col, rows, opsId));
    } catch (err) {
      out[opsId] = { error: err.message };
    }
  }
  return out;
}

async function loadSupervisor(opsId) {
  const probe = await readRange(config.sheets.cfMapping, "'PIC SPG'!A1:R6");
  const headerIdx = sheet.findHeader(probe, 'Name', 'OSID');
  const col = sheet.columns(probe[headerIdx]);
  if (!col.has('cfEmail') && !col.has('coordinatorEmail')) return null;

  const rows = await readRange(config.sheets.cfMapping, `'PIC SPG'!A${headerIdx + 2}:R4018`);
  const row = rows.find(r => col.get(r, 'opsId') === opsId);
  if (!row) return null;
  return {
    cfEmail: col.get(row, 'cfEmail') || null,
    coordinatorEmail: col.get(row, 'coordinatorEmail') || null,
    leadArea: col.get(row, 'leadArea') || null,
    source: 'Data PIC SPG',
  };
}

function identityCache(opsId) {
  return cache({
    key: `identity-${opsId}`,
    ttlMs: config.cache.identityTtlMs,
    loader: () => loadIdentity(opsId),
  });
}

async function getIdentity(opsId = config.spg.opsId) {
  const { data } = await identityCache(opsId).get();
  return data;
}

module.exports = {
  getIdentity, identityCache, loadSupervisor,
  loadIdentity, loadIdentityBatch, loadRosterRows, buildIdentity,
};
