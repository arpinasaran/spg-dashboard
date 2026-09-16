const app = require('./app');
const config = require('./config');
const auth = require('./lib/auth');
const { bootstrap } = require('./routes/api');
const { driverName } = require('./lib/sheetsClient');
const store = require('./lib/store');

/* Running the app on this machine. The app itself is app.js; everything here is the part a
   serverless deployment does not have — a port, a process that stays up, and a moment before
   anyone is looking in which to do the slow work. */

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
  console.log(`  Sumber data: ${driverName()} · snapshot: ${store.storeName()}`
    + `${auth.enabled() ? ' · kata sandi aktif' : ''}`);
  await prewarm('Pra-muat');

  // Keeps the cached copy from drifting far behind while the app sits open all day. Each
  // tick only triggers reads for datasets already past their TTL, and never blocks a request.
  setInterval(() => { bootstrap().catch(() => {}); }, HEARTBEAT_MS).unref();
});
