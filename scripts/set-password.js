#!/usr/bin/env node
/* Gives an SPG a password, or resets one.

   There is no self-service sign-up on purpose. An account here is a claim that a particular
   person's attendance rows are theirs, so somebody has to vouch for it — and the roster that
   says who exists at all belongs to another team, which means this cannot be automated from
   inside the app anyway.

     node scripts/set-password.js OS212341              # generate and print one
     node scripts/set-password.js OS212341 "sandi-nya"  # set a specific one
     node scripts/set-password.js --list                # who has an account

   Run it from a laptop with `gws` signed in. The name is filled in from the roster so the
   spreadsheet is readable by a human later; if the roster cannot be reached the account is
   still created, just without a name. */

const credentials = require('../lib/credentials');
const roster = require('../lib/roster');
const config = require('../config');

// The format lives in lib/credentials.js, next to the comment explaining what four characters
// do and do not buy.

async function lookupName(opsId) {
  try {
    const all = await roster.getRoster();
    const hit = all.find(r => String(r.opsId).toUpperCase() === opsId.toUpperCase());
    return hit ? hit.name : '';
  } catch (err) {
    console.error(`  (nama tidak bisa dibaca dari roster: ${err.message})`);
    return '';
  }
}

async function list() {
  const accounts = await credentials.list();
  if (!accounts.length) {
    console.log(`Belum ada akun di tab "${credentials.TAB}".`);
    return;
  }
  console.log(`${accounts.length} akun di tab "${credentials.TAB}":\n`);
  for (const a of accounts) {
    const last = a.lastLogin ? a.lastLogin.slice(0, 16).replace('T', ' ') : 'belum pernah';
    console.log(`  ${a.opsId.padEnd(12)} ${(a.name || '-').padEnd(28)} login terakhir: ${last}`);
  }
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--list') || args.includes('-l')) return list();

  const opsId = (args[0] || '').trim();
  if (!opsId) {
    console.error('Pakai: node scripts/set-password.js <OpsID> [kata-sandi]');
    console.error('       node scripts/set-password.js --list');
    process.exit(1);
  }

  const supplied = args[1];
  const password = supplied || credentials.generatePassword(opsId);
  const name = await lookupName(opsId);

  const { created } = await credentials.setPassword(opsId, name, password);

  console.log(`\n${created ? 'Akun dibuat' : 'Kata sandi diganti'} untuk ${opsId}${name ? ` (${name})` : ''}.`);
  console.log(`\n  Kata sandi: ${password}\n`);
  if (!supplied) {
    console.log(`Formatnya 1 huruf + 3 angka berurutan dari OS ID ${opsId}`
      + ` (pilihan angka: ${credentials.digitWindows(opsId).join(', ')}).`);
  }
  console.log(`\nTersimpan di dua tab pada spreadsheet Attendance (${config.sheets.attendanceDb}):`);
  console.log(`  "${credentials.TAB}"  — hash-nya, yang dipakai untuk login`);
  console.log(`  "${credentials.PASSWORD_TAB}" — kata sandinya apa adanya, buat dibacakan ke SPG`);
  console.log('\nSiapa pun yang bisa membuka spreadsheet itu bisa masuk sebagai SPG mana pun');
  console.log('yang tercatat di sana — batasi aksesnya kalau ini sudah dipakai sungguhan.');
  console.log('Supaya login-nya aktif, deployment harus punya AUTH_MODE=spg dan SESSION_SECRET.');
}

main().catch((err) => {
  console.error(`\nGagal: ${err.message}`);
  process.exit(1);
});
