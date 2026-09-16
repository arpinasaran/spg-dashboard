const { readRange } = require('./gwsClient');
const { cache } = require('./cache');
const sheet = require('./spgSheet');
const config = require('../config');

// The SPG-facing app only ever needs one row out of "SPG List LM", so lib/identity.js reads
// the sheet and throws the other ~4000 rows away. The admin board needs the opposite: every
// SPG, because "who has not clocked in today" is a question the attendance sheet cannot
// answer — an absent person leaves no row. Same read, same cost, different slice; the two are
// kept apart so a change to the single-person path can't quietly alter what the board treats
// as the full roster. Column naming for both lives in lib/spgSheet.js.

async function loadRoster() {
  const probe = await readRange(config.sheets.identity, sheet.PROBE_RANGE);
  const headerIdx = sheet.findHeader(probe, 'Name', 'OSID');
  const col = sheet.columns(probe[headerIdx]);

  const missing = col.missing(['name', 'opsId', 'fmsId', 'hub']);
  if (missing.length) throw new Error(`"SPG List LM" kehilangan kolom: ${missing.join(', ')}`);

  const rows = await readRange(config.sheets.identity, sheet.dataRange(headerIdx));
  const seen = new Set();
  const people = [];
  for (const r of rows) {
    const opsId = col.get(r, 'opsId');
    if (!opsId || seen.has(opsId)) continue;
    seen.add(opsId);
    // A resigned SPG still owns their past attendance rows, so they are kept and marked
    // rather than dropped — days from before they left remain reviewable.
    people.push({
      name: col.get(r, 'name'),
      opsId,
      fmsId: col.get(r, 'fmsId'),
      hub: col.get(r, 'hub'),
      city: col.get(r, 'city'),
      province: col.get(r, 'province'),
      region: col.get(r, 'region'),
      active: col.has('resignDate') ? !col.get(r, 'resignDate') : true,
      cfEmail: col.get(r, 'cfEmail') || null,
      coordinatorEmail: col.get(r, 'coordinatorEmail') || null,
      supervisorSource: col.has('cfEmail') ? 'SPG List LM' : null,
    });
  }
  return people;
}

// Supervisor mapping for the whole roster. This is the seam the migration will cut along:
// today it answers "who supervises this SPG" from the sheets; later the same shape comes from
// the existing CF dashboard and nothing above this line has to change.
//
// When the roster sheet already carries the CF columns this costs nothing — the roster read
// has them. Only an older layout falls back to the separate "Data PIC SPG" spreadsheet.
async function loadSupervisorMap() {
  const people = await getRoster();
  if (people.some(p => p.supervisorSource === 'SPG List LM')) {
    const map = {};
    for (const p of people) {
      map[p.opsId] = {
        cfEmail: p.cfEmail,
        coordinatorEmail: p.coordinatorEmail,
        leadArea: null,
        source: 'SPG List LM',
      };
    }
    return map;
  }

  const probe = await readRange(config.sheets.cfMapping, "'PIC SPG'!A1:R6");
  const headerIdx = sheet.findHeader(probe, 'Name', 'OSID');
  const col = sheet.columns(probe[headerIdx]);
  if (!col.has('cfEmail') && !col.has('coordinatorEmail')) return {};

  const rows = await readRange(config.sheets.cfMapping, `'PIC SPG'!A${headerIdx + 2}:R4018`);
  const map = {};
  for (const r of rows) {
    const opsId = col.get(r, 'opsId');
    if (!opsId) continue;
    map[opsId] = {
      cfEmail: col.get(r, 'cfEmail') || null,
      coordinatorEmail: col.get(r, 'coordinatorEmail') || null,
      leadArea: col.get(r, 'leadArea') || null,
      source: 'Data PIC SPG',
    };
  }
  return map;
}

function rosterCache() {
  return cache({ key: 'roster', ttlMs: config.cache.identityTtlMs, loader: loadRoster });
}

function supervisorCache() {
  return cache({ key: 'supervisor-map', ttlMs: config.cache.identityTtlMs, loader: loadSupervisorMap });
}

async function getRoster() {
  const { data } = await rosterCache().get();
  return data;
}

async function getSupervisorMap() {
  const { data } = await supervisorCache().get();
  return data;
}

module.exports = { getRoster, getSupervisorMap, rosterCache, supervisorCache };
