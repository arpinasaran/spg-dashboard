const { execFile } = require('child_process');

// gws's own `.cmd` shim only works through a Windows shell, and Node's shell:true mode
// concatenates argv without escaping it (confirmed while wiring this up — a JSON --json
// payload got mangled by cmd.exe). The shim itself is just `node <this file> %*`, so we
// call that file directly with execFile's normal argv array: no shell, no quoting problem.
const GWS_RUN_JS = process.env.GWS_RUN_JS
  || 'C:\\Users\\SPXID24770\\AppData\\Roaming\\npm\\node_modules\\@googleworkspace\\cli\\run.js';

function execOnce(args) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [GWS_RUN_JS, ...args], { maxBuffer: 1024 * 1024 * 80 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`gws ${args[0]} failed: ${stderr || err.message}`));
        return;
      }
      resolve(stdout);
    });
  });
}

// gws shells out to the real Sheets API over the network, so a single transient failure
// (timeout, brief connectivity blip) shouldn't surface as a hard error to the UI.
async function runGws(args) {
  try {
    return await execOnce(args);
  } catch (err) {
    await new Promise(r => setTimeout(r, 1000));
    return execOnce(args);
  }
}

async function runGwsJson(args) {
  const out = await runGws(args);
  return JSON.parse(out);
}

async function readRange(spreadsheetId, range) {
  const data = await runGwsJson(['sheets', '+read', '--spreadsheet', spreadsheetId, '--range', range]);
  return data.values || [];
}

async function batchGet(spreadsheetId, ranges) {
  const params = JSON.stringify({ spreadsheetId, ranges });
  const data = await runGwsJson(['sheets', 'spreadsheets', 'values', 'batchGet', '--params', params]);
  return data.valueRanges || [];
}

async function valuesUpdate(spreadsheetId, range, values) {
  const params = JSON.stringify({ spreadsheetId, range, valueInputOption: 'RAW' });
  const body = JSON.stringify({ values });
  return runGwsJson(['sheets', 'spreadsheets', 'values', 'update', '--params', params, '--json', body]);
}

async function valuesAppend(spreadsheetId, range, values) {
  const params = JSON.stringify({ spreadsheetId, range, valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS' });
  const body = JSON.stringify({ values });
  return runGwsJson(['sheets', 'spreadsheets', 'values', 'append', '--params', params, '--json', body]);
}

// Structural changes (adding a tab, resizing a grid) rather than cell values.
async function batchUpdate(spreadsheetId, requests) {
  const params = JSON.stringify({ spreadsheetId });
  const body = JSON.stringify({ requests });
  return runGwsJson(['sheets', 'spreadsheets', 'batchUpdate', '--params', params, '--json', body]);
}

async function listTabs(spreadsheetId) {
  const params = JSON.stringify({ spreadsheetId, fields: 'sheets.properties(title,sheetId,gridProperties.columnCount)' });
  const data = await runGwsJson(['sheets', 'spreadsheets', 'get', '--params', params]);
  return (data.sheets || []).map(s => s.properties);
}

/* ---------- Drive ----------
   Attendance photos are the one piece of evidence that used to exist in exactly one place:
   this laptop's data/photos/. A lost disk left the sheet rows pointing at nothing, which is
   the worst shape for evidence to be in — the record says a photo was taken and nobody can
   ever see it. These put the file in Drive, next to the spreadsheets, so the row and its
   proof survive the machine that produced them. */

async function driveCreateFolder(name, parentId) {
  const body = JSON.stringify({
    name,
    mimeType: 'application/vnd.google-apps.folder',
    ...(parentId ? { parents: [parentId] } : {}),
  });
  const params = JSON.stringify({ supportsAllDrives: true, fields: 'id,name' });
  return runGwsJson(['drive', 'files', 'create', '--params', params, '--json', body]);
}

async function driveFindFolder(name, parentId) {
  const q = [
    `name = '${name.replace(/'/g, "\\'")}'`,
    "mimeType = 'application/vnd.google-apps.folder'",
    'trashed = false',
    ...(parentId ? [`'${parentId}' in parents`] : []),
  ].join(' and ');
  const params = JSON.stringify({
    q, supportsAllDrives: true, includeItemsFromAllDrives: true,
    fields: 'files(id,name)', pageSize: 10,
  });
  const data = await runGwsJson(['drive', 'files', 'list', '--params', params]);
  return (data.files || [])[0] || null;
}

// gws uploads from a path on disk, not a buffer — which suits us, because the caller writes
// the local copy first anyway and that copy is what keeps a clock-in working when Drive is
// unreachable.
async function driveUpload({ localPath, name, mimeType, parentId }) {
  const body = JSON.stringify({ name, ...(parentId ? { parents: [parentId] } : {}) });
  const params = JSON.stringify({ uploadType: 'multipart', supportsAllDrives: true, fields: 'id,name,webViewLink' });
  const args = ['drive', 'files', 'create', '--params', params, '--json', body, '--upload', localPath];
  if (mimeType) args.push('--upload-content-type', mimeType);
  return runGwsJson(args);
}

async function driveDownload(fileId, destPath) {
  const params = JSON.stringify({ fileId, alt: 'media', supportsAllDrives: true });
  await runGws(['drive', 'files', 'get', '--params', params, '--output', destPath]);
  return destPath;
}

module.exports = {
  readRange, batchGet, valuesUpdate, valuesAppend, batchUpdate, listTabs,
  driveCreateFolder, driveFindFolder, driveUpload, driveDownload,
};
