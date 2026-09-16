// Demo helper: clears one day's attendance for the configured SPG so the clock-in flow can
// be shown again from the beginning.
//
// Deliberately narrow. It only ever touches rows whose Session ID is exactly
// "<OpsID>_<date>", it defaults to today, and it refuses to write anything until it is run
// with --yes — so the default invocation is a dry run that shows what *would* be cleared.
// Attendance rows are real records of someone's working day; a demo convenience must not be
// able to quietly wipe more than the one day it was pointed at.
//
//   node scripts/demo-reset.js              # dry run — lists what it found
//   node scripts/demo-reset.js --yes        # clears today
//   node scripts/demo-reset.js --date=2026-09-14 --yes

const fs = require('fs');
const path = require('path');
const { valuesUpdate } = require('../lib/sheetsClient');
const attendance = require('../lib/attendance');
const config = require('../config');

const SESSION_COLS = 18; // A:R
const EVENT_COLS = 17;   // A:Q
const PHOTO_DIR = path.join(__dirname, '..', 'data', 'photos');

const args = process.argv.slice(2);
const apply = args.includes('--yes');
const dateArg = (args.find(a => a.startsWith('--date=')) || '').split('=')[1];
const date = dateArg || attendance.localDateStr();

if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
  console.error(`Tanggal tidak valid: ${date} (format: YYYY-MM-DD)`);
  process.exit(1);
}

const opsId = config.spg.opsId;
const sessionId = `${opsId}_${date}`;

function blank(n) { return new Array(n).fill(''); }

async function main() {
  console.log(`Reset demo · OpsID ${opsId} · tanggal ${date}`);
  console.log(`Sesi yang dicari: ${sessionId}\n`);

  // Read past the cache: the point is to act on what the spreadsheet actually holds now.
  const { data } = await attendance.storeCache().refresh();
  const sessions = data.sessions.slice();
  const events = data.events.slice();

  const sessionRows = [];
  sessions.forEach((r, i) => { if ((r[0] || '') === sessionId) sessionRows.push(i); });
  const eventRows = [];
  events.forEach((r, i) => { if ((r[1] || '') === sessionId) eventRows.push(i); });

  const photos = fs.existsSync(PHOTO_DIR)
    ? fs.readdirSync(PHOTO_DIR).filter(f => f.startsWith(`${sessionId}_`))
    : [];

  if (!sessionRows.length && !eventRows.length && !photos.length) {
    console.log('Tidak ada yang perlu dibersihkan — hari ini sudah kosong.');
    console.log('Aplikasi akan menampilkan status "Belum Absen".');
    return;
  }

  for (const i of sessionRows) {
    const s = sessions[i];
    console.log(`  Sesi   baris ${i + 2}: masuk ${s[5] || '—'} · pulang ${s[8] || '—'} · status ${s[12] || '—'}`);
  }
  for (const i of eventRows) {
    console.log(`  Event  baris ${i + 2}: ${events[i][3]} di ${events[i][5] || 'lokasi lain'}`);
  }
  for (const f of photos) console.log(`  Foto   ${f}`);

  if (!apply) {
    console.log('\nDry run — belum ada yang dihapus.');
    console.log('Jalankan lagi dengan --yes untuk benar-benar membersihkan.');
    return;
  }

  console.log('');
  // The Sheets API here has no delete-row call, so rows are blanked in place. A blank row is
  // invisible to every reader in this app (they all match on Session ID / OpsID) and keeps
  // the row numbering of everything below it intact.
  for (const i of sessionRows) {
    await valuesUpdate(config.sheets.attendanceDb, `'Attendance Sessions'!A${i + 2}:R${i + 2}`, [blank(SESSION_COLS)]);
    sessions[i] = blank(SESSION_COLS);
    console.log(`  Dibersihkan: Attendance Sessions baris ${i + 2}`);
  }
  for (const i of eventRows) {
    await valuesUpdate(config.sheets.attendanceDb, `'Attendance Events'!A${i + 2}:Q${i + 2}`, [blank(EVENT_COLS)]);
    events[i] = blank(EVENT_COLS);
    console.log(`  Dibersihkan: Attendance Events baris ${i + 2}`);
  }
  for (const f of photos) {
    fs.unlinkSync(path.join(PHOTO_DIR, f));
    console.log(`  Dihapus: foto ${f}`);
  }

  // Write the result straight into the shared cache file so a server that is already running
  // picks it up on its next read instead of serving the pre-reset snapshot.
  attendance.storeCache().set({ sessions, events });

  console.log('\nSelesai. Tekan "Perbarui" di aplikasi (atau Ctrl+Shift+R) — status kembali "Belum Absen".');
}

main().catch(err => {
  console.error('Gagal reset:', err.message);
  process.exit(1);
});
