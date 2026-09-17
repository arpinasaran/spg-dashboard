#!/usr/bin/env node
/* Pushes the snapshots a deployed instance reads from.

   This is the piece that makes the deployment possible at all. Three of the four spreadsheets
   belong to other teams: "SPG List LM", "POI Master" and the BPOM pipeline. A service account
   is a separate identity and has to be granted access to each of them separately, so until
   that is done a deployed instance cannot read them. It reads a snapshot instead.

   This script produces that snapshot. It runs where the access already exists — a laptop
   with `gws` signed in as someone who can open all of them — and writes the result to the
   Drive folder the service account *can* see.

   Sharing those three with the service account is what retires this script for reads. It
   cannot retire it for writes: POI proposals are written to "POI Master", and no snapshot
   substitutes for a write.

   What stays live on the deployment, needing no snapshot: attendance. The Attendance
   spreadsheet and the photos folder are yours to share, so clock-in and clock-out write
   straight to the real sheet. Only the slow, read-only data goes stale, and the app already
   tells the user how old it is.

   Scope is every SPG with an account (lib/credentials.js), not every SPG in the roster —
   snapshotting 4000 people to serve 20 would be absurd. Give someone an account with
   scripts/set-password.js and the next sync starts covering them.

     npm run sync

   Run it before a demo, or on a schedule (Task Scheduler / cron) to keep the numbers moving. */

// Credentials come from a local .env — see lib/env.js. Loaded before the two assignments
// below so that they still win: whatever a .env happens to say about drivers, this script
// reads as the human and writes as the service account, and nothing else makes sense.
require('../lib/env').load();

// Read as the signed-in human, write to the folder the service account can reach. Both must
// be set before anything below requires lib/store.js or lib/sheetsClient.js, since each
// resolves its driver once.
process.env.SHEETS_DRIVER = 'gws';
process.env.STORE_DRIVER = 'drive';

const fs = require('fs');
const path = require('path');

const config = require('../config');
const { flush, setMaxConcurrent } = require('../lib/background');
const store = require('../lib/store');
const driveFiles = require('../lib/driveFiles');
const gws = require('../lib/gwsClient');
const oauth = require('../lib/oauthClient');
const credentials = require('../lib/credentials');
const identity = require('../lib/identity');
const poi = require('../lib/poi');
const kpi = require('../lib/kpi');
const roster = require('../lib/roster');
const proposals = require('../lib/poiProposals');

function requireEnv() {
  const missing = ['GOOGLE_SERVICE_ACCOUNT_EMAIL', 'GOOGLE_PRIVATE_KEY'].filter(k => !process.env[k]);
  if (missing.length) {
    console.error(`Butuh ${missing.join(' dan ')} supaya snapshot bisa ditulis ke Drive.`);
    console.error('Cara tercepat: `vercel env pull .env` — isinya jadi sama persis dengan produksi.');
    process.exit(1);
  }
}

/* A snapshot file has to be born under a human's quota — see the note on setCreator in
   lib/driveFiles.js. This is the one place in the codebase where both identities are present
   at once, so this is where that birth happens.

   gws uploads from a path rather than a buffer and refuses any path outside the working
   directory, so the JSON goes through a temporary file under data/ (gitignored) that is
   removed again whether the upload succeeds or not. The counter keeps the three steps that
   run under Promise.all from colliding on one name. */
const created = [];
let tmpSeq = 0;

function registerHumanCreator() {
  /* OAuth credentials, where they exist, are the same human with none of the overhead: a
     plain API call instead of a `gws` process spawned per file. lib/driveFiles.js already
     reaches for them on its own when no creator is registered, so the right move here is to
     register nothing and stay out of the way. The CLI path below is for a laptop that has
     never run `npm run oauth-setup`. */
  if (oauth.configured()) {
    console.log('  File baru dibuat lewat kredensial OAuth.\n');
    return;
  }

  driveFiles.setCreator(async ({ name, value, parentId }) => {
    const dir = path.join(process.cwd(), 'data');
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, `.snapshot-upload-${process.pid}-${tmpSeq++}.json`);
    fs.writeFileSync(tmp, JSON.stringify(value));
    try {
      const made = await gws.driveUpload({
        localPath: tmp, name, mimeType: 'application/json', parentId,
      });
      created.push(name);
      return made;
    } finally {
      try { fs.unlinkSync(tmp); } catch { /* already gone is fine */ }
    }
  });
}

let failures = 0;

async function step(label, run) {
  const t = Date.now();
  try {
    const detail = await run();
    console.log(`  ✓ ${label} — ${((Date.now() - t) / 1000).toFixed(1)}s${detail ? ` (${detail})` : ''}`);
    return true;
  } catch (err) {
    console.error(`  ✗ ${label} — ${err.message}`);
    failures++;
    return false;
  }
}

/* Whose data to push. Anyone with an account, plus the configured SPG so a deployment that
   has not issued a single password yet still has something to show. */
async function targetOpsIds() {
  const accounts = await credentials.list().catch((err) => {
    console.error(`  (daftar akun tidak terbaca: ${err.message} — memakai config.spg saja)`);
    return [];
  });
  const ids = new Set(accounts.map(a => a.opsId));
  ids.add(config.spg.opsId);
  return [...ids];
}

async function main() {
  requireEnv();
  registerHumanCreator();

  /* One snapshot write per SPG, released as fast as the loops below can call set(). Left
     unbounded that is roughly a thousand Drive uploads in flight at once, which Google
     answers by resetting connections — see the note on the ceiling in lib/background.js.
     Eight keeps the pipe busy without provoking that. */
  setMaxConcurrent(8);

  const opsIds = await targetOpsIds();
  console.log(`Menyiapkan snapshot untuk ${opsIds.length} SPG: ${opsIds.join(', ')}`);
  console.log(`  Tujuan: folder Drive ${process.env.SNAPSHOT_FOLDER_ID || config.drive.photosFolderId}\n`);

  // Identities first, in one read, because the hub and FMSID they resolve are what the POI
  // and KPI work below is keyed by.
  let people = [];
  await step('Identitas', async () => {
    const batch = await identity.loadIdentityBatch(opsIds);
    for (const [opsId, me] of Object.entries(batch)) {
      if (me.error) {
        console.error(`    · ${opsId} dilewati — ${me.error}`);
        continue;
      }
      identity.identityCache(opsId).set(me);
      people.push(me);
    }
    return `${people.length}/${opsIds.length} terbaca`;
  });

  if (!people.length) {
    console.error('\nTidak ada identitas yang terbaca, jadi POI dan KPI tidak bisa diambil. Berhenti.');
    await flush();
    process.exit(1);
  }

  const hubs = [...new Set(people.map(p => p.hub).filter(Boolean))];
  const fmsIds = [...new Set(people.map(p => p.fmsId).filter(Boolean))];

  // One pass over the 184k-row pipeline answers for everybody; set() writes each SPG's
  // snapshot from it without a second read.
  await step(`KPI mingguan (${fmsIds.length} SPG)`, async () => {
    const batch = await kpi.loadKpiBatch(fmsIds);
    for (const [fmsId, data] of Object.entries(batch)) kpi.kpiCache(fmsId).set(data);
    return `${Object.keys(batch).length} snapshot dari 1 pembacaan`;
  });

  // POI is per hub, not per person, so hubs are deduplicated: a hub with eight SPGs on it is
  // still read once.
  for (const hub of hubs) {
    await step(`POI ${hub}`, async () => {
      const { data } = await poi.poiCache(hub).refresh();
      return `${data.length} POI`;
    });
  }

  await Promise.all([
    step('Roster (papan admin)', async () => {
      const { data } = await roster.rosterCache().refresh();
      return `${data.length} SPG`;
    }),
    step('Peta supervisor', async () => {
      const { data } = await roster.supervisorCache().refresh();
      return `${Object.keys(data).length} entri`;
    }),
    // Reading these needs "POI Master" too, so they are snapshotted for the same reason as
    // the rest. Submitting one is a separate question of write access, which lib/poiProposals.js
    // settles by trying rather than by assuming.
    step('Usulan POI', async () => {
      const { data } = await proposals.proposalsCache().refresh();
      return `${data.length} usulan`;
    }),
  ]);

  // The writes above are fire-and-forget by design (lib/cache.js). Exiting without waiting
  // would leave the snapshot half-written, which is worse than not running at all.
  await flush();

  const keys = await store.listKeys().catch(() => []);
  console.log(`\n${keys.length} snapshot ada di Drive.`);
  if (created.length) {
    console.log(`${created.length} di antaranya baru dibuat atas nama akun yang login — `
      + 'sesudah ini service account cukup menimpanya.');
  }
  if (failures) {
    console.error(`${failures} bagian gagal — yang lain tetap tersimpan. Perbaiki lalu jalankan ulang.`);
    process.exit(1);
  }
  console.log('Selesai. Deployment akan membaca angka ini tanpa menunggu Sheets.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
