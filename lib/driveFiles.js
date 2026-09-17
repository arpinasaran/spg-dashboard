const { Readable } = require('stream');
const { driveApi, creatorDriveApi, withRetry } = require('./googleClient');

/* Drive used as a plain JSON key-value store, for lib/store.js.

   Only the snapshot store needs these, and only when the service account driver is active,
   so they sit here rather than in the shared surface that lib/sheetsClient.js guarantees
   across both clients — gws has no counterpart for the update-in-place call and inventing
   one would be dead code on every laptop. */

const MIME = 'application/json';

// Returns name -> id for the JSON files in one folder. Drive has no lookup by path, so this
// one listing is what makes subsequent reads a single request each.
async function listJson(folderId) {
  const q = `'${folderId}' in parents and trashed = false and mimeType = '${MIME}'`;
  const index = new Map();
  let pageToken;
  do {
    const res = await driveApi().files.list({
      q,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      fields: 'nextPageToken, files(id,name)',
      pageSize: 200,
      pageToken,
    });
    for (const f of res.data.files || []) index.set(f.name, f.id);
    pageToken = res.data.nextPageToken;
  } while (pageToken);
  return index;
}

async function readJson(fileId) {
  const res = await driveApi().files.get(
    { fileId, alt: 'media', supportsAllDrives: true },
    { responseType: 'text' },
  );
  return typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
}

/* Who gets to create a file that does not exist yet.

   A service account has had no Drive storage quota of its own since 2022, so every
   files.create it attempts is refused outright — "Service Accounts do not have storage
   quota" — unless the parent folder lives in a Shared Drive. Updating a file somebody else
   owns is a different matter and works fine, because the bytes are charged to the owner.

   That asymmetry is what this hook exists for. scripts/sync-snapshot.js already runs beside
   a signed-in human who does have quota, so it registers a creator that makes the file under
   that human's name and hands the id back; from then on the service account only ever
   updates, which it is allowed to do. Creation happens once per snapshot, ever.

   Nothing registers a creator on a deployed instance — there is no human there — so the
   call below stays exactly the files.create it always was, and fails exactly as loudly. */
let creator = null;
function setCreator(fn) { creator = fn; }

// Updates in place when the file already exists. Creating a second file with the same name
// is legal in Drive and would leave two snapshots racing to be the one that gets read.
async function writeJson({ id, name, value, parentId }) {
  const json = JSON.stringify(value);

  /* A fresh stream per attempt, which is the whole reason this is a function rather than a
     value. A stream that has already been consumed replays as an empty body, so a retry
     built on a shared one would not fail — it would succeed, and write an empty snapshot
     over a good one. Unlike a photo, the bytes here are a string we already hold, so keeping
     them across attempts costs nothing and the upload can safely be retried. */
  const media = () => ({ mimeType: MIME, body: Readable.from(json) });

  if (id) {
    const res = await withRetry(`drive.files.update ${name}`, () => driveApi().files.update({
      fileId: id, supportsAllDrives: true, fields: 'id,name', media: media(),
    }));
    return res.data;
  }
  if (creator) return creator({ name, value, parentId });
  const res = await withRetry(`drive.files.create ${name}`, () => creatorDriveApi().files.create({
    supportsAllDrives: true,
    fields: 'id,name',
    requestBody: { name, parents: [parentId], mimeType: MIME },
    media: media(),
  }));
  return res.data;
}

module.exports = { drive: { listJson, readJson, writeJson }, setCreator, MIME };
