/* Keeping background work alive past the response.

   lib/cache.js serves a stale snapshot immediately and refreshes it behind the request. On a
   long-lived server that just works — the process outlives the response and the refresh
   finishes on its own. A serverless instance is allowed to be frozen the moment the response
   is sent, so the same fire-and-forget refresh would be killed mid-flight and the snapshot
   would never actually get newer: every request would serve stale data and start a refresh
   that never lands.

   waitUntil is the platform's answer — it tells the runtime to keep the instance alive until
   the promise settles. Off Vercel it does not exist, and is not needed. */

let waitUntil = null;
try {
  ({ waitUntil } = require('@vercel/functions'));
} catch {
  // Not deployed on Vercel. The process sticks around by itself.
}

// Always swallows: a background refresh failing is not the caller's problem, and an
// unhandled rejection here would take down the process for something the user never asked
// for. Callers that need to know a refresh worked use cache.refresh() and await it.
const outstanding = new Set();

function background(promise, label = 'background') {
  const p = Promise.resolve(promise)
    .catch((err) => { console.error(`${label} gagal: ${err.message}`); })
    .finally(() => { outstanding.delete(p); });
  outstanding.add(p);
  if (waitUntil) {
    try {
      waitUntil(p);
    } catch {
      // Outside a request context waitUntil throws; the promise still runs.
    }
  }
  return p;
}

// A short-lived process — scripts/sync-snapshot.js above all — exits the moment its work is
// done, which for fire-and-forget snapshot writes is too early. This is how such a script
// waits for them, without making every request path await its own cache write.
async function flush() {
  while (outstanding.size) await Promise.all([...outstanding]);
}

module.exports = { background, flush, hasWaitUntil: () => !!waitUntil };
