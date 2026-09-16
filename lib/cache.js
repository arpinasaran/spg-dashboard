const store = require('./store');
const { background } = require('./background');

// Stale-while-revalidate, because the underlying reads are genuinely slow and there is no
// way to make them fast: the onboarding pipeline is ~95k rows / 3.5MB per tab and the Sheets
// API has no server-side filter, so a KPI read costs 3-13s no matter how it's written.
//
// The rule here is that an SPG never waits for a network read once any copy of the data
// exists. Stale data is served immediately and refreshed in the background; only the very
// first load (cold snapshot, cold memory) can block.
//
// Where that snapshot lives is lib/store.js's problem — data/cache/ on a laptop, Drive on a
// deployed instance. The only thing that changes here is that loading it is async, so an
// entry hydrates on first use rather than in the constructor. Deployed, the snapshot is
// written by scripts/sync-snapshot.js before anyone opens the app, so the blocking path is
// never reached in the field.
const registry = new Map();

function createCache({ key, ttlMs, loader }) {
  let entry = null; // { data, fetchedAt }
  let inflight = null;
  let hydrated = null;

  // Reading the snapshot is itself I/O now, so it happens once, lazily, and every caller
  // waits on the same promise. A missing or unreadable snapshot is not an error — it just
  // means the next get() loads from source.
  function hydrate() {
    if (!hydrated) {
      hydrated = store.readJson(key)
        .then((raw) => { if (raw && raw.fetchedAt && !entry) entry = raw; })
        .catch(() => {});
    }
    return hydrated;
  }

  function persist() {
    const snapshot = entry;
    background(store.writeJson(key, snapshot), `Simpan snapshot ${key}`);
  }

  function load() {
    if (inflight) return inflight; // collapse concurrent misses into one upstream read
    inflight = Promise.resolve()
      .then(loader)
      .then((data) => {
        entry = { data, fetchedAt: Date.now() };
        persist();
        return entry;
      })
      .finally(() => { inflight = null; });
    return inflight;
  }

  function isStale() {
    return !entry || Date.now() - entry.fetchedAt > ttlMs;
  }

  /* A cold cache on a deployed instance is a different animal from a cold cache on a laptop.
     Locally it means a slow first load — measured at ~180s with everything cold, which the
     laptop simply absorbs at startup. Deployed it means the snapshot this instance depends on
     was never pushed, and the fallback (reading the sheet itself) cannot work either: the
     service account was never given access to the four spreadsheets other teams own. Left
     alone that surfaces as a raw Google permissions error, or as a function timeout, neither
     of which tells anyone what to actually do. */
  async function loadCold() {
    try {
      await load();
    } catch (err) {
      if (store.storeName() === 'drive') {
        throw Object.assign(
          new Error(`Snapshot "${key}" belum ada. Jalankan "npm run sync" dari laptop yang sudah login gws.`),
          { status: 503, cause: err },
        );
      }
      throw err;
    }
  }

  async function get() {
    await hydrate();
    if (!entry) {
      await loadCold(); // nothing to serve yet — this is the only blocking path
    } else if (isStale()) {
      // Keep serving the old copy. background() is what makes this survive the response
      // being sent on a serverless instance; a failed refresh must never surface.
      background(load(), `Refresh ${key}`);
    }
    return { data: entry.data, fetchedAt: entry.fetchedAt, stale: isStale() };
  }

  async function refresh() {
    await hydrate();
    await load();
    return { data: entry.data, fetchedAt: entry.fetchedAt, stale: false };
  }

  // Write-through: after we ourselves change the underlying sheet we already know the new
  // state, so there is no reason to pay for a read-back to discover it.
  function set(data) {
    entry = { data, fetchedAt: Date.now() };
    persist();
  }

  function peek() { return entry; }

  return { key, get, refresh, set, peek, isStale, hydrate };
}

function cache({ key, ttlMs, loader }) {
  if (!registry.has(key)) registry.set(key, createCache({ key, ttlMs, loader }));
  return registry.get(key);
}

function allCaches() { return [...registry.values()]; }

// Only for tests: the registry is process-wide by design, which makes one test's cache
// visible to the next.
function resetForTests() { registry.clear(); }

module.exports = { cache, allCaches, resetForTests };
