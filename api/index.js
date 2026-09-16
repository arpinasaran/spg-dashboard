// What Vercel invokes. vercel.json routes every path here, so the Express app in app.js
// handles them exactly as it does locally — there is no second routing table to keep in step.
//
// Nothing pre-warms here on purpose: a serverless instance is created to answer one request
// and doing slow work at module scope would put that cost on whoever happened to arrive
// first. The snapshot that makes the app fast is written from outside, by
// scripts/sync-snapshot.js; see lib/cache.js.
module.exports = require('../app');
