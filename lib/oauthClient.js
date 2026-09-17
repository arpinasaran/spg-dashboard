const { google } = require('googleapis');

/* A human's credentials, for the one job a service account cannot do.

   Google service accounts have had no Drive storage quota of their own since 2022. They can
   read, they can update a file somebody else owns — the bytes are charged to that owner —
   but files.create is refused outright, every time, with "Service Accounts do not have
   storage quota". The documented ways out are a Shared Drive, where files belong to the
   drive rather than to their creator, or credentials belonging to a real person.

   A Shared Drive is not available here: this Workspace reports canCreateDrives false and the
   account is a member of none, so the photos folder lives in an ordinary My Drive. That
   leaves the second way, and this file is it — a refresh token obtained once by
   scripts/oauth-setup.js and carried in environment variables thereafter.

   What uses it is deliberately narrow. Only creating a file goes out as the human; every
   read, every update and every Sheets call still travels as the service account, which keeps
   the ordinary path on the narrow identity it was designed around. See creatorDrive() in
   lib/googleClient.js for where the split is actually made.

   When the three variables are absent this module reports itself unconfigured and nothing
   changes anywhere: the service account attempts the create and fails as loudly as before.
   That is the right behaviour for a laptop, where scripts/sync-snapshot.js supplies its own
   creator through the `gws` CLI instead. */

const SCOPES = [
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/spreadsheets',
];

function settings(env = process.env) {
  return {
    clientId: env.GOOGLE_OAUTH_CLIENT_ID,
    clientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET,
    refreshToken: env.GOOGLE_OAUTH_REFRESH_TOKEN,
  };
}

function configured(env = process.env) {
  const { clientId, clientSecret, refreshToken } = settings(env);
  return Boolean(clientId && clientSecret && refreshToken);
}

/* Built once and kept. The library refreshes the access token on its own when it expires and
   caches it on the client, so a long-lived instance pays for that exchange rarely; a new
   client per call would pay for it every time. */
let clients = null;
function apis() {
  if (!clients) {
    const { clientId, clientSecret, refreshToken } = settings();
    if (!configured()) {
      throw new Error(
        'GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET / GOOGLE_OAUTH_REFRESH_TOKEN belum di-set '
        + '— jalankan `npm run oauth-setup`',
      );
    }
    const auth = new google.auth.OAuth2(clientId, clientSecret);
    auth.setCredentials({ refresh_token: refreshToken });
    clients = {
      auth,
      drive: google.drive({ version: 'v3', auth }),
      sheets: google.sheets({ version: 'v4', auth }),
    };
  }
  return clients;
}

// Tests and scripts that mutate the environment need the memoised client thrown away.
function resetForTests() { clients = null; }

module.exports = {
  SCOPES,
  configured,
  resetForTests,
  drive: () => apis().drive,
  sheets: () => apis().sheets,
};
