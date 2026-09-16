#!/usr/bin/env node
/* Pushes the snapshots a deployed instance reads from.

   This is the piece that makes the deployment possible at all. Four of the five spreadsheets
   belong to other teams: "SPG List LM", "Data PIC SPG", "POI Master" and the BPOM pipeline.
   A service account is a separate identity and cannot be given access to them without those
   teams agreeing, so a deployed instance never reads them. It reads a snapshot instead.

   This script is the thing that produces that snapshot. It runs where the access already
   exists — a laptop with `gws` signed in as a person who can open all five — reads through
   exactly the same loaders the app uses, and writes the result to the Drive folder the
   service account *can* see. Nothing here is a parallel implementation of the app's logic;
   forcing cache.refresh() means the snapshot is by construction the same shape the app would
   have produced itself.

   What stays live on the deployment, needing no snapshot: attendance. The Attendance
   spreadsheet and the photos folder are yours to share, so clock-in and clock-out write
   straight to the real sheet. The slow, read-only data is what goes stale, and the app
   already tells the user how old it is.

     npm run sync

   Run it before a demo, or on a schedule (Task Scheduler / cron) to keep the numbers moving. */

// Read as the signed-in human, write to the folder the service account can reach. Both must
// be set before anything below requires lib/store.js or lib/sheetsClient.js, since each
// resolves its driver once.
process.env.SHEETS_DRIVER = 'gws';
process.env.STORE_DRIVER = 'drive';

const config = require('../config');
const { flush } = require('../lib/background');
const store = require('../lib/store');
const identity = require('../lib/identity');
const poi = require('../lib/poi');
const kpi = require('../lib/kpi');
const roster = require('../lib/roster');
const proposals = require('../lib/poiProposals');

function requireEnv() {
  const missing = ['GOOGLE_SERVICE_ACCOUNT_EMAIL', 'GOOGLE_PRIVATE_KEY'].filter(k => !process.env[k]);
  if (missing.length) {
    console.error(`Butuh ${missing.join(' dan ')} supaya snapshot bisa ditulis ke Drive.`);
    console.error('Isi .env lokal dengan kredensial service account yang sama seperti di Vercel.');
    process.exit(1);
  }
}

async function step(label, run) {
  const t = Date.now();
  try {
    const detail = await run();
    console.log(`  ✓ ${label} — ${((Date.now() - t) / 1000).toFixed(1)}s${detail ? ` (${detail})` : ''}`);
    return true;
  } catch (err) {
    console.error(`  ✗ ${label} — ${err.message}`);
    return false;
  }
}

async function main() {
  requireEnv();

  const opsId = config.spg.opsId;
  console.log(`Menyiapkan snapshot untuk OpsID ${opsId}`);
  console.log(`  Tujuan: folder Drive ${process.env.SNAPSHOT_FOLDER_ID || config.drive.photosFolderId}\n`);

  const results = [];

  // Identity first and awaited alone: the POI and KPI reads need the hub and FMSID it
  // resolves, so there is nothing to parallelise until it lands.
  let me = null;
  results.push(await step('Identitas SPG', async () => {
    const { data } = await identity.identityCache(opsId).refresh();
    me = data;
    return `${data.name} · ${data.hub}`;
  }));

  if (!me) {
    console.error('\nIdentitas gagal dibaca, jadi POI dan KPI tidak bisa diambil. Berhenti.');
    await flush();
    process.exit(1);
  }

  results.push(...await Promise.all([
    step('Daftar POI', async () => {
      const { data } = await poi.poiCache(me.hub).refresh();
      return `${data.length} POI`;
    }),
    step('KPI mingguan', async () => {
      const { data } = await kpi.kpiCache(me.fmsId).refresh();
      return `${data.onboarded}/${data.target} onboarded`;
    }),
    step('Roster (papan admin)', async () => {
      const { data } = await roster.rosterCache().refresh();
      return `${data.length} SPG`;
    }),
    step('Peta supervisor', async () => {
      const { data } = await roster.supervisorCache().refresh();
      return `${Object.keys(data).length} entri`;
    }),
    // Reading these needs "POI Master" too, so they are snapshotted for the same reason as
    // the rest. Submitting a new one still cannot work online — see assertCanWriteProposals
    // in lib/poiProposals.js.
    step('Usulan POI', async () => {
      const { data } = await proposals.proposalsCache().refresh();
      return `${data.length} usulan`;
    }),
  ]));

  // The writes above are fire-and-forget by design (lib/cache.js). Exiting without waiting
  // would leave the snapshot half-written, which is worse than not running at all.
  await flush();

  const keys = await store.listKeys().catch(() => []);
  const failed = results.filter(ok => !ok).length;

  console.log(`\n${keys.length} snapshot ada di Drive: ${keys.join(', ')}`);
  if (failed) {
    console.error(`${failed} bagian gagal — yang lain tetap tersimpan. Perbaiki lalu jalankan ulang.`);
    process.exit(1);
  }
  console.log('Selesai. Deployment akan membaca angka ini tanpa menunggu Sheets.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
