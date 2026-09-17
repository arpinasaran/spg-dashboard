const fs = require('fs');
const { Readable } = require('stream');
const { google } = require('googleapis');
const oauth = require('./oauthClient');

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

/* ---------- retry ----------

   Sheets allows 60 write requests per minute per user, and a service account is one user.
   A morning where five hundred SPGs clock in inside a narrow window will cross that line, and
   what crosses it is not an outage: Google answers 429 and expects the caller to wait. With no
   retry at all — which is what this file had — that 429 travelled straight to somebody
   standing in the field being told their attendance failed, while nothing was wrong except
   that they arrived in the same minute as everyone else.

   Truncated exponential backoff with jitter, as the API's own guidance specifies:
   min(2^n + random_ms, max). Only for statuses where retrying is meaningful — 429 and the
   5xx family. A 400 or a 403 means the request itself is wrong, and repeating it just spends
   the quota that the retryable calls need.

   Bounded on purpose. A serverless function has a 60s ceiling (vercel.json), so a retry
   schedule that could outlast it would turn a recoverable blip into a timeout with no error
   message at all. */
const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 4;
const MAX_BACKOFF_MS = 8000;

/* Not every failure gets as far as having an HTTP status. A snapshot sync uploads a file per
   SPG, and when enough of those go out at once Google closes connections rather than
   answering them: the error that arrives is a bare ECONNRESET with no status at all, which a
   status-only test reads as "not retryable" and gives up on. That is how a run can report
   success on every step while quietly leaving dozens of snapshots at yesterday's numbers.

   These are all failures where the request never got a verdict, so repeating it is safe in
   the sense that matters — the server either never saw it or never told us it did. */
const RETRYABLE_CODES = new Set([
  'ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE',
  'ERR_STREAM_PREMATURE_CLOSE',
]);

function statusOf(err) {
  return err && (err.status || err.code || (err.response && err.response.status)) || 0;
}

function isTransient(err) {
  if (RETRYABLE.has(Number(statusOf(err)))) return true;
  // node-fetch and undici bury the real cause one level down.
  const code = err && (err.code || (err.cause && err.cause.code));
  if (code && RETRYABLE_CODES.has(String(code))) return true;
  return /socket hang up|ECONNRESET|network socket disconnected/i.test(String((err && err.message) || ''));
}

function backoffMs(attempt) {
  return Math.min(2 ** attempt * 250 + Math.floor(Math.random() * 250), MAX_BACKOFF_MS);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function withRetry(label, run) {
  let lastErr;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      return await run();
    } catch (err) {
      lastErr = err;
      if (!isTransient(err) || attempt === MAX_ATTEMPTS - 1) throw err;
      const reason = statusOf(err) || err.code || 'jaringan';
      const wait = backoffMs(attempt);
      console.warn(`${label}: ${reason}, coba lagi dalam ${wait}ms (percobaan ${attempt + 2}/${MAX_ATTEMPTS})`);
      await sleep(wait);
    }
  }
  throw lastErr;
}

/* ---------- Sheets ---------- */

async function readRange(spreadsheetId, range) {
  const res = await withRetry('sheets.values.get', () => apis().sheets.spreadsheets.values.get({ spreadsheetId, range }));
  return res.data.values || [];
}

async function batchGet(spreadsheetId, ranges) {
  const res = await withRetry('sheets.values.batchGet', () => apis().sheets.spreadsheets.values.batchGet({ spreadsheetId, ranges }));
  return res.data.valueRanges || [];
}

async function valuesUpdate(spreadsheetId, range, values) {
  const res = await withRetry('sheets.values.update', () => apis().sheets.spreadsheets.values.update({
    spreadsheetId, range, valueInputOption: 'RAW', requestBody: { values },
  }));
  return res.data;
}

async function valuesAppend(spreadsheetId, range, values) {
  const res = await withRetry('sheets.values.append', () => apis().sheets.spreadsheets.values.append({
    spreadsheetId, range, valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS',
    requestBody: { values },
  }));
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
    spreadsheetId, fields: 'sheets.properties(title,sheetId,gridProperties.columnCount)',
  });
  return (res.data.sheets || []).map(s => s.properties);
}

/* ---------- Drive ---------- */

/* Which identity creates a file.

   Only creation is special. A service account owns whatever it creates and has no storage
   quota to own it with, so files.create is refused unless the parent sits on a Shared Drive,
   which this Workspace does not allow. Reads, updates and every Sheets call are unaffected
   and stay on the service account, which is the narrow identity this app is built around.

   So where a human's OAuth credentials are configured, and only there, the two create calls
   below travel as that person instead — see lib/oauthClient.js. Where they are not, this
   returns the service account exactly as before and the create fails exactly as before,
   which is what a laptop wants: scripts/sync-snapshot.js has its own creator via `gws`. */
function creatorDrive() {
  return oauth.configured() ? oauth.drive() : apis().drive;
}

async function driveCreateFolder(name, parentId) {
  const res = await creatorDrive().files.create({
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
  // Not retried: the body is a stream, and a stream that has already been consumed cannot be
  // replayed. Re-reading it would need the buffer kept alive across attempts, which for a photo
  // means holding it in a 1024MB function for the length of the backoff. photoStore.save()
  // already records an upload failure honestly rather than claiming evidence that is not there.
  const res = await creatorDrive().files.create({
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
  withRetry, RETRYABLE, isTransient,
  readRange, batchGet, valuesUpdate, valuesAppend, batchUpdate, listTabs,
  driveCreateFolder, driveFindFolder, driveUpload, driveDownload,
  // For lib/driveFiles.js, which needs list/update calls that the gws surface has no
  // counterpart for. Deliberately outside SURFACE: only the snapshot store uses it, and only
  // ever when this driver is the active one.
  driveApi: () => apis().drive,
  // The identity that may create a file, which is not always the same one. See creatorDrive().
  creatorDriveApi: () => creatorDrive(),
};
