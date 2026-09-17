#!/usr/bin/env node
/* One-time: turns a Google OAuth client into a refresh token this app can use.

   Why this exists at all. A service account has had no Drive storage quota since 2022, so it
   cannot create a file anywhere — not a photo, not a snapshot — unless the parent folder is
   on a Shared Drive. This Workspace has shared drive creation switched off (canCreateDrives
   is false), and the folder in use belongs to a person's My Drive. That leaves one way to
   put a new file in Drive from a serverless function: carry a human's own credentials.

   The refresh token this produces is exactly that. It does not expire, because the consent
   screen for this project is Internal, and it is worth being plain about what it is: it
   grants this app the same Drive and Sheets reach as the person who signs in below. Treat it
   like a password. It belongs in .env locally and in a Secret environment variable on
   Vercel, and never in the repository.

   The sign-in happens in your browser, as you. Nothing here ever sees your password, and the
   token is written straight to .env rather than printed, so it does not end up in a terminal
   scrollback or a log.

     node scripts/oauth-setup.js

   Prerequisite: an OAuth client of type "Desktop app" in the same Google Cloud project as
   the service account, with its id and secret already in .env as GOOGLE_OAUTH_CLIENT_ID and
   GOOGLE_OAUTH_CLIENT_SECRET. A desktop client accepts any loopback port, which is what lets
   this script listen on a free one instead of asking you to register a redirect URI. */

const fs = require('fs');
const path = require('path');
const http = require('http');
const { URL } = require('url');
const { spawn } = require('child_process');

require('../lib/env').load();

const { google } = require('googleapis');

/* Full drive and spreadsheets, deliberately.

   drive.file — access limited to files this app itself created — would be the tighter
   choice, and for photos alone it would do. It was not chosen because it cannot write into
   the existing photos folder, and because spreadsheets access is what removes the need to
   ask four other teams to share their sheets with the service account. That trade was made
   knowingly: reach in exchange for not waiting on anyone. */
const SCOPES = [
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/spreadsheets',
];

const ENV_FILE = path.join(__dirname, '..', '.env');

function mask(value) {
  const s = String(value || '');
  if (s.length <= 12) return '***';
  return `${s.slice(0, 6)}…${s.slice(-4)} (${s.length} char)`;
}

/* Rewrites one assignment in place, or appends it. Reading and rewriting the whole file
   keeps the other values — the service account key above all — exactly as they were;
   appending blindly would leave two GOOGLE_OAUTH_REFRESH_TOKEN lines and lib/env.js would
   quietly take the last one. */
function upsertEnv(key, value) {
  let text = '';
  try {
    text = fs.readFileSync(ENV_FILE, 'utf8');
  } catch {
    text = '';
  }

  const line = `${key}="${value}"`;
  const pattern = new RegExp(`^[ \\t]*(?:export[ \\t]+)?${key}[ \\t]*=.*$`, 'm');

  if (pattern.test(text)) {
    text = text.replace(pattern, line);
  } else {
    if (text && !text.endsWith('\n')) text += '\n';
    text += `${line}\n`;
  }

  // ascii, because a BOM on the first line stops lib/env.js matching that assignment at all.
  fs.writeFileSync(ENV_FILE, text, 'ascii');
}

function openBrowser(url) {
  try {
    // Windows: the first quoted argument of `start` is the window title, hence the empty one.
    if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
    else if (process.platform === 'darwin') spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    else spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
  } catch {
    // Printing the URL is the real interface; opening it is a convenience.
  }
}

function listenOnFreePort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function waitForCode(server, expectedState) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Tidak ada balasan dari browser dalam 5 menit.')), 5 * 60 * 1000);

    server.on('request', (req, res) => {
      const url = new URL(req.url, `http://127.0.0.1:${server.address().port}`);
      if (url.pathname !== '/callback') {
        res.writeHead(404).end();
        return;
      }

      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');
      const state = url.searchParams.get('state');

      const say = (message) => {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><meta charset="utf-8"><body style="font:16px system-ui;padding:3rem">
          <p>${message}</p><p style="color:#666">Tab ini boleh ditutup.</p></body>`);
      };

      clearTimeout(timer);

      // The state check is what stops another page on this machine from feeding us a code.
      if (state !== expectedState) {
        say('State tidak cocok — dibatalkan.');
        reject(new Error('State tidak cocok. Ulangi dari awal.'));
      } else if (error) {
        say(`Ditolak: ${error}`);
        reject(new Error(`Google menolak: ${error}`));
      } else if (!code) {
        say('Tidak ada code pada balasan.');
        reject(new Error('Balasan tanpa code.'));
      } else {
        say('Berhasil. Token sudah ditulis ke .env.');
        resolve(code);
      }
    });
  });
}

async function main() {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    console.error('Butuh GOOGLE_OAUTH_CLIENT_ID dan GOOGLE_OAUTH_CLIENT_SECRET di .env.');
    console.error('');
    console.error('Cara mendapatkannya:');
    console.error('  1. console.cloud.google.com → project peaceful-app-507610-u3');
    console.error('  2. APIs & Services → Credentials → Create credentials → OAuth client ID');
    console.error('  3. Application type: Desktop app. Beri nama bebas, misal "Rute Harian server".');
    console.error('  4. Salin Client ID dan Client secret ke .env:');
    console.error('       GOOGLE_OAUTH_CLIENT_ID=...apps.googleusercontent.com');
    console.error('       GOOGLE_OAUTH_CLIENT_SECRET=...');
    process.exit(1);
  }

  const server = await listenOnFreePort();
  const port = server.address().port;
  const redirectUri = `http://127.0.0.1:${port}/callback`;
  const state = require('crypto').randomBytes(16).toString('hex');

  const client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
  const authUrl = client.generateAuthUrl({
    access_type: 'offline',   // without this there is no refresh token at all
    prompt: 'consent',        // and without this Google reuses an old grant and omits it again
    scope: SCOPES,
    state,
  });

  console.log('Login di browser sebagai akun yang memiliki folder foto Drive.\n');
  console.log(authUrl);
  console.log('\nMenunggu balasan di ' + redirectUri + ' …');
  openBrowser(authUrl);

  let code;
  try {
    code = await waitForCode(server, state);
  } finally {
    server.close();
  }

  const { tokens } = await client.getToken(code);
  if (!tokens.refresh_token) {
    console.error('\nGoogle tidak mengirim refresh token.');
    console.error('Biasanya karena app ini sudah pernah diberi izin. Cabut dulu di');
    console.error('myaccount.google.com/permissions, lalu jalankan ulang skrip ini.');
    process.exit(1);
  }

  upsertEnv('GOOGLE_OAUTH_REFRESH_TOKEN', tokens.refresh_token);

  client.setCredentials({ refresh_token: tokens.refresh_token });
  const who = await google.oauth2({ version: 'v2', auth: client }).userinfo.get();

  console.log('\nSelesai.');
  console.log('  akun          :', who.data.email);
  console.log('  refresh token :', mask(tokens.refresh_token), '→ ditulis ke .env');
  console.log('  scope         :', (tokens.scope || SCOPES.join(' ')).replace(/https:\/\/www\.googleapis\.com\/auth\//g, ''));
  console.log('\nLangkah berikutnya: salin ketiga nilai OAuth itu ke environment Production di Vercel.');
}

main().catch((err) => {
  console.error('\n' + err.message);
  process.exit(1);
});
