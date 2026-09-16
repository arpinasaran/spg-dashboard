/* Which Google client the rest of the app talks through.

   Two exist for one reason: identity. `gws` (lib/gwsClient.js) runs as the signed-in human
   and can open every sheet that person can, but it is a CLI on a laptop — there is no such
   binary, and no such login, on a deployed instance. The service account
   (lib/googleClient.js) travels as environment variables and works anywhere, but only sees
   what has been explicitly shared with it.

   Callers do not choose, and must not care: identity.js, poi.js, kpi.js, attendance.js and
   photoStore.js all require this file and get whichever driver fits the environment they
   happen to be running in. */

const SURFACE = [
  'readRange', 'batchGet', 'valuesUpdate', 'valuesAppend', 'batchUpdate', 'listTabs',
  'driveCreateFolder', 'driveFindFolder', 'driveUpload', 'driveDownload',
];

const DRIVERS = { gws: './gwsClient', google: './googleClient' };

// Explicit setting first, then inference. Inference only ever points at the service account
// when its credentials are actually present, so a developer who has never heard of any of
// this still gets the `gws` behaviour that lib/gwsClient.js's comments describe.
function pickDriver(env = process.env) {
  const named = (env.SHEETS_DRIVER || '').trim();
  if (named) {
    if (!DRIVERS[named]) {
      throw new Error(`SHEETS_DRIVER tidak dikenal: "${named}" (pilihannya: ${Object.keys(DRIVERS).join(', ')})`);
    }
    return named;
  }
  return env.GOOGLE_SERVICE_ACCOUNT_EMAIL ? 'google' : 'gws';
}

// Resolved lazily: requiring googleClient eagerly on a laptop would pull in the whole
// googleapis tree for nothing, and requiring gwsClient on Vercel points at a path that
// isn't there.
let driver = null;
function active() {
  if (!driver) driver = require(DRIVERS[pickDriver()]);
  return driver;
}

const exported = { pickDriver, SURFACE, driverName: () => pickDriver() };
for (const fn of SURFACE) {
  exported[fn] = (...args) => active()[fn](...args);
}

module.exports = exported;
