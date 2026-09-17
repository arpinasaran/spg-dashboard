#!/usr/bin/env node
/* Gives every SPG on the roster an account, in one pass.

   scripts/set-password.js issues one account at a time and is right for that: it reads the
   roster for a name, reads the credentials tab to see whether the person already has one,
   then appends to two tabs. Four round trips is nothing for one person and roughly two
   thousand for five hundred — twenty-odd minutes of sequential API calls, any of which can
   fail and leave the run half done.

   So this reads each source once and writes each tab once. The passwords themselves are
   still lib/credentials.js's to generate and hash; nothing about the format or the storage
   is re-decided here.

     node scripts/provision-accounts.js --dry-run     # show what would happen, write nothing
     node scripts/provision-accounts.js               # create accounts for anyone without one
     node scripts/provision-accounts.js --only-qa     # only the QA dummies, roster untouched
     node scripts/provision-accounts.js --csv out.csv # also write the list to a file

   Existing accounts are left alone. Someone who already has a password keeps it, because
   reissuing it would lock out an SPG who is already using it. Use set-password.js to reset
   one deliberately. */

require('../lib/env').load();
process.env.SHEETS_DRIVER = process.env.SHEETS_DRIVER || 'gws';

const fs = require('fs');
const { valuesUpdate, readRange } = require('../lib/sheetsClient');
const credentials = require('../lib/credentials');
const identity = require('../lib/identity');
const config = require('../config');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run') || args.includes('-n');

/* --only narrows the run to ids matching a pattern; --only-qa is the case worth a flag of its
   own, because provisioning the QA dummies is a thing done repeatedly while the real roster
   should be left completely alone. Both can only ever reduce the set: the default is still
   everyone, so there is no pattern that makes this touch more than it would have. */
const onlyArg = (args.find(a => a.startsWith('--only=')) || '').split('=')[1];
const ONLY = args.includes('--only-qa')
  ? credentials.isQaAccount
  : (onlyArg ? (id => new RegExp(onlyArg, 'i').test(id)) : null);
const csvAt = args.indexOf('--csv');
const CSV_PATH = csvAt >= 0 ? args[csvAt + 1] : null;

function csvCell(v) {
  const s = String(v == null ? '' : v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/* Written in chunks because of how the gws driver works: it shells out, passing the payload
   as a command-line argument, and Windows caps that at around 32k characters. Five hundred
   scrypt hashes is far past it, and the failure is ENAMETOOLONG — which says nothing about
   rows or sheets, so it is worth naming here.

   The chunk is sized by the serialised length rather than by a row count, since a row of
   hashes is several times the size of a row of four-character passwords. Each chunk targets
   an explicit range, so a run that dies halfway can be resumed by simply running it again:
   the rows that landed are read back as existing accounts and skipped. */
const MAX_PAYLOAD = 8000;

async function writeInChunks(label, tab, columns, firstRow, rows, write) {
  let sent = 0;
  while (sent < rows.length) {
    let take = 0;
    let size = 0;
    while (sent + take < rows.length) {
      const next = JSON.stringify(rows[sent + take]).length + 2;
      if (take > 0 && size + next > MAX_PAYLOAD) break;
      size += next;
      take++;
    }
    const from = firstRow + sent;
    const to = from + take - 1;
    await write(`'${tab}'!${columns[0]}${from}:${columns[1]}${to}`, rows.slice(sent, sent + take));
    sent += take;
    process.stdout.write(`\r  ${label}: ${sent}/${rows.length}`);
  }
  console.log('');
}

async function main() {
  console.log(DRY_RUN ? 'Mode uji — tidak ada yang ditulis.\n' : '');

  // 1. The roster, read once. Resigned SPGs are skipped: an account is a way in, and someone
  //    who has left should not have one issued to them now.
  const { col, rows } = await identity.loadRosterRows();
  const roster = rows
    .map(r => ({
      opsId: col.get(r, 'opsId'),
      name: col.get(r, 'name'),
      resigned: col.has('resignDate') ? !!col.get(r, 'resignDate') : false,
    }))
    .filter(p => p.opsId && !p.resigned)
    .filter(p => !ONLY || ONLY(p.opsId));
  console.log(`Roster           : ${roster.length} SPG aktif${ONLY ? ' (setelah --only)' : ''}`);

  // 2. Who already has one. Read once, not once per person.
  const existing = await credentials.list();
  const have = new Set(existing.map(a => a.opsId.toUpperCase()));
  console.log(`Sudah punya akun : ${existing.length}`);

  const todo = roster.filter(p => !have.has(p.opsId.toUpperCase()));
  console.log(`Akan dibuat      : ${todo.length}\n`);
  if (!todo.length) return { created: [], existing };

  /* 3. Generate and hash. scrypt is deliberately expensive — that is its job — so five
        hundred of them is real CPU time rather than a rounding error. Done in batches so the
        event loop is not blocked solid for a minute. */
  const created = [];
  const now = new Date().toISOString();
  const BATCH = 25;
  for (let i = 0; i < todo.length; i += BATCH) {
    const slice = todo.slice(i, i + BATCH);
    const hashed = await Promise.all(slice.map(async (p) => {
      const password = credentials.generatePassword(p.opsId);
      return { ...p, password, hash: await credentials.hashPassword(password) };
    }));
    created.push(...hashed);
    process.stdout.write(`\r  hashing ${created.length}/${todo.length}`);
  }
  console.log('');

  if (DRY_RUN) {
    console.log('\nContoh 5 baris pertama:');
    for (const p of created.slice(0, 5)) console.log(`  ${p.opsId.padEnd(12)} ${p.password}`);
    return { created, existing };
  }

  /* 4. Write each tab once. Appending row by row is what makes the per-person path slow, and
        an append cannot say where it landed — writing an explicit block below the last row
        we read can, which is what makes this safe to re-run. */
  await credentials.ensureTab();
  await credentials.ensurePasswordTab(credentials.PASSWORD_TAB);
  if (created.some(p => credentials.isQaAccount(p.opsId))) {
    await credentials.ensurePasswordTab(credentials.QA_PASSWORD_TAB);
  }

  const write = (range, values) => valuesUpdate(config.sheets.attendanceDb, range, values);

  /* Hashes first, passwords second. Neither order is safe on its own — there is no
     transaction across two tabs — so what makes this recoverable is the check at the end
     rather than the ordering. A run that dies in between leaves accounts whose password was
     never written down, and the check names them so they can be reset instead of quietly
     becoming five hundred logins nobody knows the password to. */
  const firstCredRow = existing.length + 2; // +1 for the header, +1 to land after the last row
  await writeInChunks(
    `hash → "${credentials.TAB}"`, credentials.TAB, ['A', 'E'], firstCredRow,
    created.map(p => [p.opsId, p.name, p.hash, now, '']), write,
  );

  /* The readable passwords go to one of two tabs. A tester is handed the QA list, and handing
     it over must not mean handing over five hundred live logins at the same time — so the
     split happens here, at the only place that writes them, rather than being a rule someone
     has to remember when sharing the file. */
  for (const tab of [credentials.PASSWORD_TAB, credentials.QA_PASSWORD_TAB]) {
    const mine = created.filter(p => credentials.passwordTabFor(p.opsId) === tab);
    if (!mine.length) continue;
    const current = await readRange(config.sheets.attendanceDb, `'${tab}'!A2:D`);
    await writeInChunks(
      `sandi → "${tab}"`, tab, ['A', 'D'], current.length + 2,
      mine.map(p => [p.opsId, p.name, p.password, now]), write,
    );
  }

  credentials.invalidate();

  // Read both tabs back and confirm they agree. An account whose password was never recorded
  // is a login nobody can perform, and it is invisible unless something looks for it.
  const finalCreds = await readRange(config.sheets.attendanceDb, `'${credentials.TAB}'!A2:E`);

  /* Both readable tabs, not just the real one. The hashes live in a single tab while the
     passwords are split across two, so checking one of them reports every QA account as a
     login nobody can perform -- a false alarm on a check whose entire value is that it is
     believed when it fires. */
  const finalPws = [];
  for (const tab of [credentials.PASSWORD_TAB, credentials.QA_PASSWORD_TAB]) {
    try {
      finalPws.push(...await readRange(config.sheets.attendanceDb, `'${tab}'!A2:D`));
    } catch {
      // A tab that was never created has nothing in it; that is not an error to report here.
    }
  }
  const recorded = new Set(finalPws.map(r => String(r[0] || '').trim().toUpperCase()).filter(Boolean));
  const orphans = finalCreds
    .map(r => String(r[0] || '').trim())
    .filter(id => id && !recorded.has(id.toUpperCase()));

  console.log(`\nCocok            : ${finalCreds.length} akun, ${finalPws.length} kata sandi tercatat`);
  if (orphans.length) {
    console.error(`\n${orphans.length} akun punya hash tanpa kata sandi tercatat — tidak ada yang bisa masuk sebagai mereka.`);
    console.error(`Perbaiki dengan: node scripts/set-password.js <FMS ID>`);
    console.error(orphans.join(', '));
  }
  return { created, existing, orphans };
}

main()
  .then(({ created, existing }) => {
    if (CSV_PATH) {
      const all = [
        ...existing.map(a => ({ opsId: a.opsId, name: a.name, password: '(sudah ada — lihat tab SPG Passwords)' })),
        ...created.map(p => ({ opsId: p.opsId, name: p.name, password: p.password })),
      ];
      const csv = ['OS ID,Nama,Kata Sandi']
        .concat(all.map(a => [a.opsId, a.name, a.password].map(csvCell).join(',')))
        .join('\n');
      fs.writeFileSync(CSV_PATH, `${csv}\n`, 'utf8');
      console.log(`\nDaftar lengkap (${all.length} akun) ditulis ke ${CSV_PATH}`);
    }
    console.log(`\nSelesai. Kata sandi tersimpan apa adanya di "${credentials.PASSWORD_TAB}" (SPG nyata)`);
    console.log(`dan "${credentials.QA_PASSWORD_TAB}" (akun dummy) — siapa pun yang bisa membuka`);
    console.log('tab itu bisa masuk sebagai siapa pun yang terdaftar di dalamnya.');
  })
  .catch((err) => {
    console.error(`\nGagal: ${err.message}`);
    process.exit(1);
  });
