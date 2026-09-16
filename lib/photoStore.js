const fs = require('fs');
const path = require('path');
const { driveUpload, driveDownload, driveFindFolder, driveCreateFolder } = require('./gwsClient');
const config = require('../config');

const LOCAL_DIR = path.join(__dirname, '..', 'data', 'photos');
fs.mkdirSync(LOCAL_DIR, { recursive: true });

/* Attendance photos used to live only in data/photos/ on the machine running this server.
   That made the evidence weaker than the record of it: a lost disk left rows in
   "Attendance Events" asserting a photo was taken that nobody could ever look at again.
   Drive is now where a photo belongs; the local file stays as a cache so serving one to the
   board costs no round trip, and so a clock-in still completes when Drive is unreachable.

   A reference is stored in the sheet as one of:
     drive:<fileId>   uploaded — survives this machine
     local:<filename> upload failed — the photo exists here and nowhere else (see pendingLocal)
   Older rows may hold a bare "/data/photos/x.jpg" path; resolve() still understands those. */

const DRIVE_PREFIX = 'drive:';
const LOCAL_PREFIX = 'local:';

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
  // bare filename inside the photo directory is ever served.
  const safe = path.basename(String(filename));
  return path.join(LOCAL_DIR, safe);
}

// Photos whose Drive upload failed. Kept in memory so the boot sweep and the operator both
// have a straight answer to "what exists only on this laptop right now?".
const pendingLocal = new Set();

async function save(eventId, dataUrl) {
  if (!dataUrl) return '';
  const { ext, mime, buffer } = parseDataUrl(dataUrl);
  const filename = `${eventId}.${ext}`;
  const localPath = localPathFor(filename);

  // Local first, always. The disk write is what makes the photo exist; the upload is what
  // makes it durable. If the second fails, someone in the field still gets to clock in.
  fs.writeFileSync(localPath, buffer);

  try {
    const parentId = await ensureFolder();
    const file = await driveUpload({ localPath, name: filename, mimeType: mime, parentId });
    if (!file || !file.id) throw new Error('Drive tidak mengembalikan file id');
    pendingLocal.delete(filename);
    return DRIVE_PREFIX + file.id;
  } catch (err) {
    console.error(`Foto ${filename} gagal diunggah ke Drive — tersimpan lokal saja: ${err.message}`);
    pendingLocal.add(filename);
    return LOCAL_PREFIX + filename;
  }
}

// Returns a path on disk to serve, fetching from Drive on first miss. A board opened on a
// fresh machine therefore still shows the evidence: the sheet knows the file id, and the
// local directory fills itself in on demand.
async function resolve(ref) {
  const raw = String(ref || '').trim();
  if (!raw) return null;

  if (raw.startsWith(DRIVE_PREFIX)) {
    const fileId = raw.slice(DRIVE_PREFIX.length);
    if (!/^[A-Za-z0-9_-]{10,}$/.test(fileId)) return null;
    const cached = path.join(LOCAL_DIR, `drive-${fileId}`);
    if (fs.existsSync(cached)) return cached;
    await driveDownload(fileId, cached);
    return cached;
  }

  const filename = raw.startsWith(LOCAL_PREFIX) ? raw.slice(LOCAL_PREFIX.length) : raw.replace(/^\/data\/photos\//, '');
  const p = localPathFor(filename);
  return fs.existsSync(p) ? p : null;
}

// What the browser should put in <img src>. The sheet stores a reference, not a URL; this is
// the one place that turns one into the other.
function publicUrl(ref) {
  const raw = String(ref || '').trim();
  if (!raw) return null;
  return `/api/photo/${encodeURIComponent(raw)}`;
}

function pending() { return [...pendingLocal]; }

module.exports = { save, resolve, publicUrl, ensureFolder, pending, LOCAL_DIR, DRIVE_PREFIX, LOCAL_PREFIX };
