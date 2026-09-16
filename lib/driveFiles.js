const { Readable } = require('stream');
const { driveApi } = require('./googleClient');

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

// Updates in place when the file already exists. Creating a second file with the same name
// is legal in Drive and would leave two snapshots racing to be the one that gets read.
async function writeJson({ id, name, value, parentId }) {
  const media = { mimeType: MIME, body: Readable.from(JSON.stringify(value)) };
  if (id) {
    const res = await driveApi().files.update({ fileId: id, supportsAllDrives: true, fields: 'id,name', media });
    return res.data;
  }
  const res = await driveApi().files.create({
    supportsAllDrives: true,
    fields: 'id,name',
    requestBody: { name, parents: [parentId], mimeType: MIME },
    media,
  });
  return res.data;
}

module.exports = { drive: { listJson, readJson, writeJson }, MIME };
