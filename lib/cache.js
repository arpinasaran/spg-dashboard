const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'data', 'cache');
fs.mkdirSync(DIR, { recursive: true });

// Stale-while-revalidate, because the underlying reads are genuinely slow and there is no
// way to make them fast: the onboarding pipeline is ~95k rows / 3.5MB per tab and the Sheets
// API has no server-side filter, so a KPI read costs 3-13s no matter how it's written.
//
// The rule here is that an SPG never waits for a network read once any copy of the data
// exists. Stale data is served immediately and refreshed in the background; only the very
// first load (cold disk, cold memory) can block, and server.js pre-warms that at boot so it
// happens while nobody is looking.
const registry = new Map();

function createCache({ key, ttlMs, loader }) {
  let entry = null; // { data, fetchedAt }
  let inflight = null;
  const file = path.join(DIR, `${key}.json`);

  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (raw && raw.fetchedAt) entry = raw;
  } catch {
    // No usable snapshot on disk — first run, or the file was removed/corrupted. Either way
    // the next get() simply loads from source.
  }

  function persist() {
    try {
      fs.writeFileSync(file, JSON.stringify(entry));
    } catch {
      // A cache that can't write to disk is still a working in-memory cache; losing the
      // snapshot only costs one slow load after the next restart.
    }
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

  async function get() {
    if (!entry) {
      await load(); // nothing to serve yet — this is the only blocking path
    } else if (isStale()) {
      load().catch(() => {}); // keep serving the old copy; a failed refresh must not surface
    }
    return { data: entry.data, fetchedAt: entry.fetchedAt, stale: isStale() };
  }

  async function refresh() {
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

  return { key, get, refresh, set, peek, isStale };
}

function cache({ key, ttlMs, loader }) {
  if (!registry.has(key)) registry.set(key, createCache({ key, ttlMs, loader }));
  return registry.get(key);
}

function allCaches() { return [...registry.values()]; }

module.exports = { cache, allCaches };
