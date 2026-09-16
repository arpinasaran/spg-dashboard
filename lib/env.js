const fs = require('fs');
const path = require('path');

/* Reads a local .env into process.env.

   There is no dotenv dependency, and this is why it isn't one: the deployment does not need
   this file at all. Vercel injects real environment variables, and .env is gitignored so it
   never ships. The only place it matters is a laptop running scripts/sync-snapshot.js, which
   needs the same service-account credentials as production in order to write the snapshot to
   Drive. Pulling in a package to serve one local script was not worth it.

   `vercel env pull` writes exactly this format, so the intended local setup is to run that
   once and then never think about credentials again.

   Existing variables always win. A value already in the environment was put there
   deliberately — an explicit assignment, or the platform itself — and a stale line in a file
   silently overriding it is the failure mode this rule exists to prevent. */

const QUOTED = /^(['"])([\s\S]*)\1$/;

// Values may span lines when quoted, which is how a private key is usually pasted by hand.
// Matching a whole assignment at a time handles that; a line-by-line loop cannot.
const ASSIGNMENT =
  /^[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=[ \t]*("(?:[^"\\]|\\[\s\S])*"|'[^']*'|[^\n]*)/gm;

function parse(text) {
  const out = {};
  ASSIGNMENT.lastIndex = 0;
  let m;
  while ((m = ASSIGNMENT.exec(text)) !== null) {
    const raw = m[2].trim();
    const quoted = QUOTED.exec(raw);
    // Only an unquoted value can carry a trailing comment; inside quotes a # is data.
    out[m[1]] = quoted ? quoted[2] : raw.replace(/\s+#.*$/, '').trim();
  }
  return out;
}

function load(file = path.join(__dirname, '..', '.env')) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return { file, applied: [] }; // No .env is the normal case on a deployment, not an error.
  }

  const applied = [];
  for (const [key, value] of Object.entries(parse(text))) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
      applied.push(key);
    }
  }
  return { file, applied };
}

module.exports = { load, parse };
