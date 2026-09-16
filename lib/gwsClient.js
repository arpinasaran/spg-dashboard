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

module.exports = { readRange, batchGet, valuesUpdate, valuesAppend };
