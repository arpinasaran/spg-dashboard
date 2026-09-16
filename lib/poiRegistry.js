const fs = require('fs');
const path = require('path');
const store = require('./store');
const { background } = require('./background');
const { distanceMeters } = require('./geo');

const STORE_KEY = 'poi-registry';
const LEGACY_FILE = path.join(__dirname, '..', 'data', 'poi-registry.json');
const RENAME_TOLERANCE_M = 30;

// POI Master has no stable identifier column, so IDs were previously derived from the POI's
// name — which means renaming a POI silently broke every attendance record pointing at it.
// This assigns each POI a permanent id the first time it is seen and remembers it, so the id
// survives edits to the source sheet.
//
// Deliberately kept beside the app rather than written back as a new column in POI Master:
// that sheet is shared production data owned by someone else, and this app should not be
// mutating it as a side effect of being opened.
//
// It lives in lib/store.js now instead of a file, because a deployed instance has no
// writable disk — and an id registry that cannot persist is an id registry that re-mints
// every id on the next cold start, orphaning the attendance rows that point at the old ones.

let statePromise = null;

function load() {
  if (!statePromise) {
    statePromise = store.readJson(STORE_KEY)
      .then(raw => (raw && raw.entries ? raw : migrateLegacy()))
      .catch(() => ({ seq: 0, entries: {} }));
  }
  return statePromise;
}

// The registry used to be a plain file next to the app. Anyone upgrading has real ids in it
// that real attendance rows already reference, so it is adopted once rather than discarded.
function migrateLegacy() {
  try {
    const raw = JSON.parse(fs.readFileSync(LEGACY_FILE, 'utf8'));
    if (raw && raw.entries) {
      background(store.writeJson(STORE_KEY, raw), 'Migrasi poi-registry');
      return raw;
    }
  } catch {
    // No legacy file — a fresh install, or a deployed instance that never had one.
  }
  return { seq: 0, entries: {} };
}

function save(state) {
  background(store.writeJson(STORE_KEY, state), 'Simpan poi-registry');
}

function keyOf(hub, name) {
  return `${(hub || '').trim().toLowerCase()}||${(name || '').trim().toLowerCase()}`;
}

// Resolves ids for a whole hub at once so a single rename can be matched against the other
// POIs in that hub by coordinate, and the registry is written at most once per call.
async function resolveIds(hub, pois) {
  const state = await load();
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

function resetForTests() { statePromise = null; }

module.exports = { resolveIds, keyOf, STORE_KEY, resetForTests };
