const fs = require('fs');
const path = require('path');
const { driveUpload, driveDownload, driveFindFolder, driveCreateFolder } = require('./sheetsClient');
const store = require('./store');
const config = require('../config');

/* Attendance photos used to live only in data/photos/ on the machine running this server.
   That made the evidence weaker than the record of it: a lost disk left rows in
   "Attendance Events" asserting a photo was taken that nobody could ever look at again.
   Drive is now where a photo belongs; a local file is kept as a cache where there is a disk
   to keep it on, so serving one to the board costs no round trip and so a clock-in still
   completes when Drive is unreachable.

   A deployed instance has no such disk — the filesystem is read-only and anything written to
   /tmp is gone before the next request. There, the photo goes from the request body straight
   to Drive and is read back from Drive. That removes the local safety net, so the failure
   case is recorded honestly rather than hidden: if the upload fails the reference says so
   instead of naming a file that exists nowhere.

   A reference is stored in the sheet as one of:
     drive:<fileId>    uploaded — survives this machine
     local:<filename>  upload failed, the photo exists on this machine only (see pendingLocal)
     missing:<eventId> upload failed with nowhere to fall back to; no photo was kept
   Older rows may hold a bare "/data/photos/x.jpg" path; fetch() still understands those. */

const DRIVE_PREFIX = 'drive:';
const LOCAL_PREFIX = 'local:';
const MISSING_PREFIX = 'missing:';

const LOCAL_DIR = path.join(__dirname, '..', 'data', 'photos');

// The local copy is only ever an optimisation. Where the snapshot store is already on Drive
// we are on a read-only filesystem, and attempting the write would throw on every clock-in.
const usesLocalDisk = store.storeName() === 'disk';
if (usesLocalDisk) fs.mkdirSync(LOCAL_DIR, { recursive: true });

let folderPromise = null;
async function ensureFolder() {
  if (config.drive.photosFolderId) return config.drive.photosFolderId;
  if (!folderPromise) {
    folderPromise = (async () => {
      const found = await driveFindFolder(config.drive.photosFolderName, config.drive.parentFolderId);
      if (found) return found.id;
      const made = await driveCreateFolder(config.drive.photosFolderName, config.drive.parentFolderId);
      return made.id;
    })().catch(err => { folderPromise = null; throw err; });
  }
  return folderPromise;
}

function parseDataUrl(dataUrl) {
  const match = /^data:image\/(\w+);base64,(.+)$/.exec(dataUrl || '');
  if (!match) throw new Error('Foto tidak valid (bukan data URL image/*)');
  const ext = match[1] === 'jpeg' ? 'jpg' : match[1];
  return { ext, mime: `image/${match[1] === 'jpg' ? 'jpeg' : match[1]}`, buffer: Buffer.from(match[2], 'base64') };
}

function localPathFor(filename) {
  // Whatever reaches here came off a sheet cell, so it is treated as untrusted input: only a
  // bare filename inside the photo directory is ever read.
  return path.join(LOCAL_DIR, path.basename(String(filename)));
}

function contentTypeFor(name) {
  const ext = path.extname(String(name || '')).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  return 'image/jpeg';
}

// Photos whose Drive upload failed. Kept in memory so the boot sweep and the operator both
// have a straight answer to "what exists only on this laptop right now?".
const pendingLocal = new Set();

async function save(eventId, dataUrl) {
  if (!dataUrl) return '';
  const { ext, mime, buffer } = parseDataUrl(dataUrl);
  const filename = `${eventId}.${ext}`;

  // Local first where there is a disk, always. The write is what makes the photo exist; the
  // upload is what makes it durable. If the second fails, someone in the field still gets to
  // clock in.
  let localPath = null;
  if (usesLocalDisk) {
    localPath = localPathFor(filename);
    fs.writeFileSync(localPath, buffer);
  }

  try {
    const parentId = await ensureFolder();
    const file = await driveUpload({
      ...(localPath ? { localPath } : { buffer }),
      name: filename, mimeType: mime, parentId,
    });
    if (!file || !file.id) throw new Error('Drive tidak mengembalikan file id');
    pendingLocal.delete(filename);
    return DRIVE_PREFIX + file.id;
  } catch (err) {
    if (localPath) {
      console.error(`Foto ${filename} gagal diunggah ke Drive — tersimpan lokal saja: ${err.message}`);
      pendingLocal.add(filename);
      return LOCAL_PREFIX + filename;
    }
    // Nothing kept it. Saying so on the row is the honest outcome: the alternative is a
    // reference that looks like evidence and resolves to nothing.
    console.error(`Foto ${filename} hilang — unggah ke Drive gagal dan tidak ada disk lokal: ${err.message}`);
    return MISSING_PREFIX + eventId;
  }
}

/* Returns the image bytes for a reference, or null. Reading into memory rather than handing
   back a path is what lets this work on an instance with no writable disk; where there is
   one, the downloaded file is still cached so the second view costs nothing. */
async function fetch(ref) {
  const raw = String(ref || '').trim();
  if (!raw || raw.startsWith(MISSING_PREFIX)) return null;

  if (raw.startsWith(DRIVE_PREFIX)) {
    const fileId = raw.slice(DRIVE_PREFIX.length);
    if (!/^[A-Za-z0-9_-]{10,}$/.test(fileId)) return null;

    if (usesLocalDisk) {
      const cached = path.join(LOCAL_DIR, `drive-${fileId}`);
      if (fs.existsSync(cached)) return { buffer: fs.readFileSync(cached), contentType: 'image/jpeg' };
      await driveDownload(fileId, cached);
      return { buffer: fs.readFileSync(cached), contentType: 'image/jpeg' };
    }
    const buffer = await driveDownload(fileId);
    return Buffer.isBuffer(buffer) ? { buffer, contentType: 'image/jpeg' } : null;
  }

  if (!usesLocalDisk) return null; // a local: reference can only ever be read on that machine
  const filename = raw.startsWith(LOCAL_PREFIX) ? raw.slice(LOCAL_PREFIX.length) : raw.replace(/^\/data\/photos\//, '');
  const p = localPathFor(filename);
  return fs.existsSync(p) ? { buffer: fs.readFileSync(p), contentType: contentTypeFor(filename) } : null;
}

// What the browser should put in <img src>. The sheet stores a reference, not a URL; this is
// the one place that turns one into the other.
function publicUrl(ref) {
  const raw = String(ref || '').trim();
  if (!raw || raw.startsWith(MISSING_PREFIX)) return null;
  return `/api/photo/${encodeURIComponent(raw)}`;
}

function pending() { return [...pendingLocal]; }

module.exports = {
  save, fetch, publicUrl, ensureFolder, pending,
  LOCAL_DIR, DRIVE_PREFIX, LOCAL_PREFIX, MISSING_PREFIX, usesLocalDisk,
};
