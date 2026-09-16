const express = require('express');
const path = require('path');
const { router, markHardReload } = require('./routes/api');
const { router: adminRouter } = require('./routes/admin');
const { router: loginRouter, gate, adminOnly } = require('./routes/login');

/* The Express app, with no opinion about how it is served.

   It used to be inseparable from server.js's app.listen(), which is fine for a laptop and
   impossible on a serverless platform where there is no port to listen on and no process
   that outlives the request. Splitting the two means the same app object is what runs
   locally (server.js) and what is deployed (api/index.js) — one code path, so a bug cannot
   hide in the half that only production uses. */

const app = express();
app.use(express.json({ limit: '15mb' })); // clock-in/out photos travel as base64 JSON

// Before the gate: the login page is the one thing a signed-out visitor may see.
app.use(loginRouter);
app.use(gate);

app.use('/api', router);
app.use('/api/admin', adminOnly, adminRouter);

// Ctrl+Shift+R is the only reload where the browser explicitly asks everyone to ignore their
// caches — it sends no-cache on the document request. Passing that intent through to our own
// data cache means a hard refresh really does bring fresh numbers, which is what anyone
// demoing this expects; a plain reload still gets the instant cached copy.
app.get(['/', '/index.html'], (req, res) => {
  const hint = `${req.headers['cache-control'] || ''} ${req.headers.pragma || ''}`;
  if (/no-cache/i.test(hint)) {
    markHardReload(req.spgOpsId);
    console.log('  Hard refresh — data akan dibaca ulang dari sumber.');
  }
  res.set('Cache-Control', 'no-cache'); // always revalidate, so this handler keeps seeing reloads
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// The admin board is a separate desktop page, not a tab inside the SPG app: one is a
// mobile-first tool for the person in the field, the other is a wide grid for someone at a
// desk watching many people. Sharing a shell would have compromised both.
app.get(['/admin', '/admin.html'], adminOnly, (req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.use(express.static(path.join(__dirname, 'public')));

module.exports = app;
