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
  const headerIdx = sheet.findHeader(probe, 'OSID', 'FMSID');
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
    // Carried but never used as an identifier, so a row can still be traced back to the
    // sheet other teams index on. See lib/spgSheet.js for why opsId is not this.
    osId: col.get(row, 'osId'),
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

  /* The supervisor comes from the roster row and nowhere else. It used to fall back to a
     separate "Data PIC SPG" spreadsheet for an older layout that did not carry the CF
     columns; the roster carries them now for every one of the 503 real SPGs, so the fallback
     was a second spreadsheet, a second set of permissions and a second thing to keep in sync
     in exchange for nothing. */
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
  getIdentity, identityCache,
  loadIdentity, loadIdentityBatch, loadRosterRows, buildIdentity,
};
