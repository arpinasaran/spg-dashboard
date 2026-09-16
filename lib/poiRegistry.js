const fs = require('fs');
const path = require('path');
const { distanceMeters } = require('./geo');

const FILE = path.join(__dirname, '..', 'data', 'poi-registry.json');
const RENAME_TOLERANCE_M = 30;

// POI Master has no stable identifier column, so IDs were previously derived from the POI's
// name — which means renaming a POI silently broke every attendance record pointing at it.
// This assigns each POI a permanent id the first time it is seen and remembers it locally,
// so the id survives edits to the source sheet.
//
// Deliberately a local file rather than a new column written into POI Master: that sheet is
// shared production data owned by someone else, and this app should not be mutating it as a
// side effect of being opened.
function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (raw && raw.entries) return raw;
  } catch {
    // First run, or an unreadable file — start clean rather than fail the POI list.
  }
  return { seq: 0, entries: {} };
}

function save(state) {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(state, null, 2));
  } catch {
    // Non-fatal: ids stay stable for the life of the process even if they can't be persisted.
  }
}

function keyOf(hub, name) {
  return `${(hub || '').trim().toLowerCase()}||${(name || '').trim().toLowerCase()}`;
}

// Resolves ids for a whole hub at once so a single rename can be matched against the other
// POIs in that hub by coordinate, and the file is written at most once per call.
function resolveIds(hub, pois) {
  const state = load();
  let dirty = false;

  const claimed = new Set();
  const resolved = pois.map((poi) => {
    const key = keyOf(hub, poi.name);
    const hit = state.entries[key];
    if (hit) {
      claimed.add(hit.id);
      if (hit.lat !== poi.lat || hit.lng !== poi.lng) {
        state.entries[key] = { ...hit, lat: poi.lat, lng: poi.lng };
        dirty = true;
      }
      return hit.id;
    }
    return null;
  });

  pois.forEach((poi, i) => {
    if (resolved[i]) return;

    // Unknown name. Before minting a new id, check whether this is an existing POI that was
    // simply renamed: same hub, essentially the same coordinates, id not already taken.
    const renamedFrom = Object.entries(state.entries).find(([k, v]) => {
      if (!k.startsWith(`${(hub || '').trim().toLowerCase()}||`)) return false;
      if (claimed.has(v.id)) return false;
      const d = distanceMeters(v.lat, v.lng, poi.lat, poi.lng);
      return d != null && d <= RENAME_TOLERANCE_M;
    });

    let id;
    if (renamedFrom) {
      id = renamedFrom[1].id;
      delete state.entries[renamedFrom[0]];
    } else {
      state.seq += 1;
      id = `POI-${String(state.seq).padStart(5, '0')}`;
    }
    state.entries[keyOf(hub, poi.name)] = { id, lat: poi.lat, lng: poi.lng };
    claimed.add(id);
    resolved[i] = id;
    dirty = true;
  });

  if (dirty) save(state);
  return resolved;
}

module.exports = { resolveIds, keyOf };
