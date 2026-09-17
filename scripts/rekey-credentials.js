#!/usr/bin/env node
/* Re-keys existing accounts from OSID to FMSID.
 *
 * Every password in "SPG Credentials" was written when opsId meant OSID. It now means FMSID,
 * so those rows match nobody: five hundred people have a password that is checked against an
 * id the login form no longer accepts. Nothing errors -- find() simply returns null and the
 * form says "FMS ID atau kata sandi salah", which is the one message that cannot tell anyone
 * what is actually wrong.
 *
 * The fix is to rewrite column A, not to reissue. The scrypt hash does not depend on the id
 * it is filed under, so re-keying leaves every password working exactly as it did -- which
 * matters if any of them have already been handed out. Re-provisioning instead would silently
 * invalidate all of them.
 *
 * Only column A is touched. Hashes, names, timestamps and the plaintext column are read to
 * decide, never written.
 *
 *   node scripts/rekey-credentials.js          # dry run -- shows the mapping, writes nothing
 *   node scripts/rekey-credentials.js --yes    # rewrite column A on both tabs
 */

require('../lib/env').load();
process.env.SHEETS_DRIVER = process.env.SHEETS_DRIVER || 'gws';

const { readRange, valuesUpdate } = require('../lib/sheetsClient');
const credentials = require('../lib/credentials');
const identity = require('../lib/identity');
const config = require('../config');

const apply = process.argv.slice(2).includes('--yes');

async function rosterMap() {
  const { col, rows } = await identity.loadRosterRows();
  const byOsId = new Map();
  for (const r of rows) {
    const osId = String(col.get(r, 'osId') || '').trim();
    const fmsId = String(col.get(r, 'opsId') || '').trim();
    if (osId && fmsId) byOsId.set(osId.toUpperCase(), fmsId);
  }
  return byOsId;
}

/* One tab's worth of decisions. Deliberately returns the plan rather than acting on it, so the
   dry run and the real run cannot drift apart -- they are the same computation, and --yes only
   decides whether the last line executes. */
function plan(rows, byOsId) {
  const out = { rewrite: [], already: 0, unknown: [] };
  rows.forEach((r, i) => {
    const current = String(r[0] || '').trim();
    if (!current) return;
    const mapped = byOsId.get(current.toUpperCase());
    if (mapped && mapped !== current) out.rewrite.push({ row: i + 2, from: current, to: mapped, name: String(r[1] || '').trim() });
    else if (mapped) out.already += 1;
    else if (/^Ops/i.test(current)) out.already += 1; // already an FMSID
    else out.unknown.push({ row: i + 2, id: current, name: String(r[1] || '').trim() });
  });
  return out;
}

async function doTab(tab, lastCol, byOsId) {
  const rows = await readRange(config.sheets.attendanceDb, `'${tab}'!A2:${lastCol}`);
  const p = plan(rows, byOsId);

  console.log(`\n=== ${tab} ===`);
  console.log(`  baris terbaca   : ${rows.length}`);
  console.log(`  perlu di-rekey  : ${p.rewrite.length}`);
  console.log(`  sudah FMSID     : ${p.already}`);
  console.log(`  tidak dikenali  : ${p.unknown.length}`);

  for (const u of p.unknown) console.log(`      baris ${u.row}: "${u.id}" ${u.name ? `(${u.name})` : ''} — dibiarkan`);
  for (const w of p.rewrite.slice(0, 5)) console.log(`      baris ${w.row}: ${w.from} → ${w.to}  ${w.name}`);
  if (p.rewrite.length > 5) console.log(`      … dan ${p.rewrite.length - 5} baris lagi`);

  /* Two OSIDs landing on one FMSID would merge two people's accounts into one row that the
     survivor can log into and the other cannot. Refuse the whole tab rather than write a
     partial rename that would have to be untangled by hand afterwards. */
  const seen = new Map();
  for (const w of p.rewrite) {
    if (seen.has(w.to)) {
      console.error(`\n  BERHENTI: ${w.from} dan ${seen.get(w.to)} sama-sama memetakan ke ${w.to}.`);
      process.exit(1);
    }
    seen.set(w.to, w.from);
  }

  if (!apply || !p.rewrite.length) return p;

  // Column A in one write. Every value is computed from what was just read, so a row that
  // needed no change is rewritten with the value it already had.
  const byRow = new Map(p.rewrite.map(w => [w.row, w.to]));
  const column = rows.map((r, i) => [byRow.get(i + 2) || String(r[0] || '')]);
  await valuesUpdate(config.sheets.attendanceDb, `'${tab}'!A2:A${rows.length + 1}`, column);
  console.log(`  ✓ kolom A ditulis ulang (${p.rewrite.length} baris berubah)`);
  return p;
}

async function main() {
  console.log(apply ? 'Menulis perubahan.' : 'Mode uji — tidak ada yang ditulis.');

  const byOsId = await rosterMap();
  console.log(`Peta roster OSID → FMSID: ${byOsId.size} baris`);

  await doTab(credentials.TAB, 'E', byOsId);
  await doTab(credentials.PASSWORD_TAB, 'D', byOsId);

  credentials.invalidate();
  if (!apply) console.log('\nJalankan lagi dengan --yes untuk benar-benar menulis.');
  else console.log('\nSelesai. Password lama tetap berlaku — hanya kolom ID yang berubah.');
}

main().catch((err) => {
  console.error('Gagal:', err.message);
  process.exit(1);
});
