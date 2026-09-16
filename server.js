const express = require('express');
const path = require('path');
const config = require('./config');
const { router, bootstrap, markHardReload } = require('./routes/api');
const { router: adminRouter } = require('./routes/admin');

const app = express();
app.use(express.json({ limit: '15mb' })); // clock-in/out photos travel as base64 JSON

app.use('/api', router);
app.use('/api/admin', adminRouter);
app.use('/data/photos', express.static(path.join(__dirname, 'data', 'photos')));

// Ctrl+Shift+R is the only reload where the browser explicitly asks everyone to ignore their
// caches — it sends no-cache on the document request. Passing that intent through to our own
// data cache means a hard refresh really does bring fresh numbers, which is what anyone
// demoing this expects; a plain reload still gets the instant cached copy.
app.get(['/', '/index.html'], (req, res) => {
  const hint = `${req.headers['cache-control'] || ''} ${req.headers.pragma || ''}`;
  if (/no-cache/i.test(hint)) {
    markHardReload();
    console.log('  Hard refresh — data akan dibaca ulang dari sumber.');
  }
  res.set('Cache-Control', 'no-cache'); // always revalidate, so this handler keeps seeing reloads
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// The admin board is a separate desktop page, not a tab inside the SPG app: one is a
// mobile-first tool for the person in the field, the other is a wide grid for someone at a
// desk watching many people. Sharing a shell would have compromised both.
app.get(['/admin', '/admin.html'], (req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.use(express.static(path.join(__dirname, 'public')));

const HEARTBEAT_MS = 5 * 60 * 1000;

// Pre-warm. The underlying Sheets reads cost seconds and cannot be made fast, so the only
// question is who waits for them. Doing it here means the process waits at startup, while
// nobody is looking, instead of an SPG waiting in the field.
async function prewarm(label) {
  const t = Date.now();
  try {
    const data = await bootstrap();
    console.log(`  ${label}: siap dalam ${((Date.now() - t) / 1000).toFixed(1)}s `
      + `(${data.poi.length} POI, ${data.kpi.onboarded}/${data.kpi.target} onboarded, ${data.history.length} riwayat)`);
  } catch (err) {
    console.error(`  ${label}: gagal — ${err.message}`);
    console.error('  App tetap jalan; data akan dicoba lagi saat ada permintaan.');
  }
}

app.listen(config.port, async () => {
  console.log(`Rute Harian jalan di http://localhost:${config.port}`);
  console.log(`  (mewakili SPG OpsID ${config.spg.opsId} — ganti di config.js)`);
  console.log(`  Papan admin: http://localhost:${config.port}/admin`);
  await prewarm('Pra-muat');

  // Keeps the cached copy from drifting far behind while the app sits open all day. Each
  // tick only triggers reads for datasets already past their TTL, and never blocks a request.
  setInterval(() => { bootstrap().catch(() => {}); }, HEARTBEAT_MS).unref();
});
