#!/usr/bin/env node
/* One-time (idempotent) provisioning of the two things this app needs to exist outside its
   own code: the "POI Proposals" tab in the POI Master spreadsheet, and the Drive folder that
   holds attendance photos.

   Run it again whenever you point config.js at a different spreadsheet or Drive folder —
   nothing here overwrites anything that already exists. */

const config = require('../config');
const proposals = require('../lib/poiProposals');
const { listTabs, driveFindFolder, driveCreateFolder } = require('../lib/sheetsClient');

async function setupProposalsTab() {
  const before = await listTabs(config.sheets.poiMaster);
  const existed = before.some(t => t.title === config.sheets.poiProposalsTab);
  await proposals.ensureTab();
  console.log(existed
    ? `  Tab "${config.sheets.poiProposalsTab}" sudah ada — tidak diubah.`
    : `  Tab "${config.sheets.poiProposalsTab}" dibuat dengan ${proposals.HEADER.length} kolom.`);
  console.log(`  Kolom: ${proposals.HEADER.join(' | ')}`);
}

async function setupPhotoFolder() {
  if (config.drive.photosFolderId) {
    console.log(`  config.drive.photosFolderId sudah diisi: ${config.drive.photosFolderId}`);
    return config.drive.photosFolderId;
  }
  const found = await driveFindFolder(config.drive.photosFolderName, config.drive.parentFolderId);
  if (found) {
    console.log(`  Folder "${config.drive.photosFolderName}" sudah ada: ${found.id}`);
    return found.id;
  }
  const made = await driveCreateFolder(config.drive.photosFolderName, config.drive.parentFolderId);
  console.log(`  Folder "${config.drive.photosFolderName}" dibuat: ${made.id}`);
  return made.id;
}

(async () => {
  console.log('Usulan POI — tab di "BPOM – Consolidated POI Master":');
  await setupProposalsTab();

  console.log('\nFoto absen — folder Drive:');
  const folderId = await setupPhotoFolder();

  if (!config.drive.photosFolderId) {
    console.log(`\nSalin ini ke config.js supaya folder tidak perlu dicari lagi tiap boot:`);
    console.log(`    drive: { photosFolderId: '${folderId}', ... }`);
  }
  console.log('\nSelesai.');
})().catch(err => {
  console.error('Gagal:', err.message);
  process.exit(1);
});
