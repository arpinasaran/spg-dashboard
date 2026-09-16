const { readRange } = require('./sheetsClient');
const { cache } = require('./cache');
const sheet = require('./spgSheet');
const config = require('../config');

// Identity for the one SPG this instance represents. Column names on "SPG List LM" are not
// stable — see lib/spgSheet.js, which owns the accepted-names list for both this and the
// roster read.
async function loadIdentity(opsId) {
  const probe = await readRange(config.sheets.identity, sheet.PROBE_RANGE);
  const headerIdx = sheet.findHeader(probe, 'Name', 'OSID');
  const col = sheet.columns(probe[headerIdx]);

  const missing = col.missing(['name', 'opsId', 'fmsId', 'hub']);
  if (missing.length) throw new Error(`"SPG List LM" kehilangan kolom: ${missing.join(', ')}`);

  const rows = await readRange(config.sheets.identity, sheet.dataRange(headerIdx));
  const row = rows.find(r => col.get(r, 'opsId') === opsId);
  if (!row) throw new Error(`OpsID ${opsId} not found in "SPG List LM" — check config.js`);

  const identity = {
    name: col.get(row, 'name'),
    opsId: col.get(row, 'opsId'),
    fmsId: col.get(row, 'fmsId'),
    hub: col.get(row, 'hub'),
    city: col.get(row, 'city'),
    province: col.get(row, 'province'),
    region: col.get(row, 'region'),
    active: col.has('resignDate') ? !col.get(row, 'resignDate') : true,
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
  } else {
    // Older layout: the mapping lives in "Data PIC SPG". It is supplementary — if that sheet
    // is unreachable or restructured, the SPG's own dashboard must still load; only the CF
    // review path depends on it.
    try {
      identity.supervisor = await loadSupervisor(opsId);
    } catch {
      identity.supervisor = null;
    }
  }
  return identity;
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

module.exports = { getIdentity, identityCache, loadSupervisor };
