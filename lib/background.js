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

/* An optional ceiling on how much of this runs at once.

   No ceiling is the default, and it is the right one for a request path: a clock-in starts a
   single snapshot write, and making it queue behind anything would add latency to buy
   nothing.

   scripts/sync-snapshot.js is the opposite shape. It calls set() once per SPG, so one run
   releases something like a thousand Drive uploads within the same tick, and Google answers
   a burst that size by closing connections rather than by refusing them — the error that
   comes back is a bare ECONNRESET with no HTTP status. Retrying rescues the individual
   upload, but retrying a thousand simultaneous uploads largely recreates the burst that
   caused it. A ceiling is the part that actually fixes it. */
let ceiling = 0;
let active = 0;
const waiting = [];

function setMaxConcurrent(n) {
  ceiling = Number(n) > 0 ? Number(n) : 0;
  drain();
}

function drain() {
  while (waiting.length && (!ceiling || active < ceiling)) waiting.shift()();
}

/* Takes a function, not a promise. A promise has already started, so there would be nothing
   left to hold back — passing one still works, for callers that have no work to defer, but
   only a function can actually be queued. */
function background(work, label = 'background') {
  const run = typeof work === 'function' ? work : () => work;

  let settle;
  const done = new Promise((resolve) => { settle = resolve; });
  // Added before the work starts, so flush() waits for what is queued as well as what runs.
  outstanding.add(done);

  const start = () => {
    active++;
    Promise.resolve()
      .then(run)
      .catch((err) => { console.error(`${label} gagal: ${err.message}`); })
      .finally(() => {
        active--;
        outstanding.delete(done);
        settle();
        drain();
      });
  };

  if (!ceiling || active < ceiling) start();
  else waiting.push(start);

  if (waitUntil) {
    try {
      waitUntil(done);
    } catch {
      // Outside a request context waitUntil throws; the promise still runs.
    }
  }
  return done;
}

// A short-lived process — scripts/sync-snapshot.js above all — exits the moment its work is
// done, which for fire-and-forget snapshot writes is too early. This is how such a script
// waits for them, without making every request path await its own cache write.
async function flush() {
  while (outstanding.size) await Promise.all([...outstanding]);
}

module.exports = { background, flush, setMaxConcurrent, hasWaitUntil: () => !!waitUntil };
