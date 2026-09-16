const fs = require('fs');
const { Readable } = require('stream');
const { google } = require('googleapis');

/* The same surface as lib/gwsClient.js, but talking to the Google APIs directly as a
   service account instead of shelling out to the `gws` CLI.

   Why both exist: `gws` carries a human's OAuth token, so on a laptop it reaches every sheet
   that person can open — including the four owned by other teams. A service account is a
   separate identity and only ever sees what has been explicitly shared with it, which here
   is the Attendance spreadsheet and the photos folder. That is enough, because the
   restricted sheets are never read from a deployed instance: lib/store.js serves them from a
   snapshot that scripts/sync-snapshot.js pushes from a machine where `gws` works.

   Everything a deployed instance does — writing attendance rows, uploading a photo, reading
   the day's events back — goes through this file. lib/sheetsClient.js picks between the two. */

const SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/drive',
];

// The private key arrives as a single-line env var because that is the shape that survives a
// dashboard text field; the real key has newlines in it.
function credentials() {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const key = process.env.GOOGLE_PRIVATE_KEY;
  if (!email || !key) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_EMAIL / GOOGLE_PRIVATE_KEY belum di-set');
  }
  return { client_email: email, private_key: key.replace(/\\n/g, '\n') };
}

let clients = null;
function apis() {
  if (!clients) {
    const auth = new google.auth.GoogleAuth({ credentials: credentials(), scopes: SCOPES });
    clients = {
      sheets: google.sheets({ version: 'v4', auth }),
      drive: google.drive({ version: 'v3', auth }),
    };
  }
  return clients;
}

/* ---------- Sheets ---------- */

async function readRange(spreadsheetId, range) {
  const res = await apis().sheets.spreadsheets.values.get({ spreadsheetId, range });
  return res.data.values || [];
}

async function batchGet(spreadsheetId, ranges) {
  const res = await apis().sheets.spreadsheets.values.batchGet({ spreadsheetId, ranges });
  return res.data.valueRanges || [];
}

async function valuesUpdate(spreadsheetId, range, values) {
  const res = await apis().sheets.spreadsheets.values.update({
    spreadsheetId, range, valueInputOption: 'RAW', requestBody: { values },
  });
  return res.data;
}

async function valuesAppend(spreadsheetId, range, values) {
  const res = await apis().sheets.spreadsheets.values.append({
    spreadsheetId, range, valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS',
    requestBody: { values },
  });
  return res.data;
}

async function batchUpdate(spreadsheetId, requests) {
  const res = await apis().sheets.spreadsheets.batchUpdate({
    spreadsheetId, requestBody: { requests },
  });
  return res.data;
}

async function listTabs(spreadsheetId) {
  const res = await apis().sheets.spreadsheets.get({
    spreadsheetId, fields: 'sheets.properties(title,sheetId)',
  });
  return (res.data.sheets || []).map(s => s.properties);
}

/* ---------- Drive ---------- */

async function driveCreateFolder(name, parentId) {
  const res = await apis().drive.files.create({
    supportsAllDrives: true,
    fields: 'id,name',
    requestBody: {
      name,
      mimeType: 'application/vnd.google-apps.folder',
      ...(parentId ? { parents: [parentId] } : {}),
    },
  });
  return res.data;
}

async function driveFindFolder(name, parentId) {
  const q = [
    `name = '${name.replace(/'/g, "\\'")}'`,
    "mimeType = 'application/vnd.google-apps.folder'",
    'trashed = false',
    ...(parentId ? [`'${parentId}' in parents`] : []),
  ].join(' and ');
  const res = await apis().drive.files.list({
    q, supportsAllDrives: true, includeItemsFromAllDrives: true,
    fields: 'files(id,name)', pageSize: 10,
  });
  return (res.data.files || [])[0] || null;
}

// Accepts a buffer as well as a path. A serverless instance has no writable disk to stage the
// file on, so the photo goes straight from the request body to Drive.
async function driveUpload({ localPath, buffer, name, mimeType, parentId }) {
  const body = buffer != null ? Readable.from(buffer) : fs.createReadStream(localPath);
  const res = await apis().drive.files.create({
    supportsAllDrives: true,
    fields: 'id,name,webViewLink',
    requestBody: { name, ...(parentId ? { parents: [parentId] } : {}) },
    media: { mimeType: mimeType || 'application/octet-stream', body },
  });
  return res.data;
}

// Returns the bytes when no destination is given, so a read-only filesystem can still serve a
// photo straight out of memory.
async function driveDownload(fileId, destPath) {
  const res = await apis().drive.files.get(
    { fileId, alt: 'media', supportsAllDrives: true },
    { responseType: 'arraybuffer' },
  );
  const buffer = Buffer.from(res.data);
  if (!destPath) return buffer;
  fs.writeFileSync(destPath, buffer);
  return destPath;
}

module.exports = {
  readRange, batchGet, valuesUpdate, valuesAppend, batchUpdate, listTabs,
  driveCreateFolder, driveFindFolder, driveUpload, driveDownload,
  // For lib/driveFiles.js, which needs list/update calls that the gws surface has no
  // counterpart for. Deliberately outside SURFACE: only the snapshot store uses it, and only
  // ever when this driver is the active one.
  driveApi: () => apis().drive,
};
