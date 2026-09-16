const fs = require('fs');
const path = require('path');
const config = require('../config');

/* Where cached snapshots live.

   lib/cache.js used to write straight to data/cache/. That works on a laptop and nowhere
   else: a serverless filesystem is read-only apart from a /tmp that does not survive the
   request, so a snapshot written there is gone before anyone can benefit from it — and a
   snapshot is the only thing standing between an SPG and a 3-13s read of a 184k-row sheet.

   So persistence moved behind this interface. Locally it is still data/cache/, byte for
   byte. Deployed it is JSON files in the same Drive folder that already holds the attendance
   photos, which means the deployment needs no storage service, no extra account and no extra
   bill — only the folder the service account was already given.

   Reads and writes are async here where they were sync before; see lib/cache.js. */

const DISK_DIR = path.join(__dirname, '..', 'data', 'cache');

function pickStore(env = process.env) {
  const named = (env.STORE_DRIVER || '').trim();
  if (named) {
    if (named !== 'disk' && named !== 'drive') {
      throw new Error(`STORE_DRIVER tidak dikenal: "${named}" (pilihannya: disk, drive)`);
    }
    return named;
  }
  return env.GOOGLE_SERVICE_ACCOUNT_EMAIL ? 'drive' : 'disk';
}

// A key becomes a filename in both drivers, and one of them is a Drive folder shared with
// other things. Anything but the shape cache.js actually generates is refused rather than
// sanitised, so a bad key is a loud error here instead of a quiet wrong file later.
function assertKey(key) {
  if (!/^[A-Za-z0-9._-]{1,120}$/.test(String(key || ''))) {
    throw new Error(`Key snapshot tidak valid: ${JSON.stringify(key)}`);
  }
  return key;
}

/* ---------- disk ---------- */

const disk = {
  async readJson(key) {
    try {
      return JSON.parse(fs.readFileSync(path.join(DISK_DIR, `${assertKey(key)}.json`), 'utf8'));
    } catch {
      // Absent or corrupt is not an error: the caller's next move is to load from source.
      return null;
    }
  },
  async writeJson(key, value) {
    fs.mkdirSync(DISK_DIR, { recursive: true });
    fs.writeFileSync(path.join(DISK_DIR, `${assertKey(key)}.json`), JSON.stringify(value));
  },
  async listKeys() {
    try {
      return fs.readdirSync(DISK_DIR).filter(f => f.endsWith('.json')).map(f => f.slice(0, -5));
    } catch {
      return [];
    }
  },
};

/* ---------- drive ---------- */

function snapshotFolderId() {
  const id = process.env.SNAPSHOT_FOLDER_ID || config.drive.photosFolderId;
  if (!id) throw new Error('SNAPSHOT_FOLDER_ID belum di-set dan config.drive.photosFolderId kosong');
  return id;
}

// One listing per instance builds the name->id map. Drive has no "open by path", so without
// this every read would cost a search query before it could cost a download.
let indexPromise = null;
async function fileIndex({ refresh = false } = {}) {
  if (refresh || !indexPromise) {
    const { drive } = require('./driveFiles');
    indexPromise = drive.listJson(snapshotFolderId()).catch((err) => {
      indexPromise = null;
      throw err;
    });
  }
  return indexPromise;
}

const driveStore = {
  async readJson(key) {
    assertKey(key);
    try {
      const index = await fileIndex();
      const id = index.get(`${key}.json`);
      if (!id) return null;
      const { drive } = require('./driveFiles');
      return await drive.readJson(id);
    } catch {
      return null;
    }
  },
  async writeJson(key, value) {
    assertKey(key);
    const { drive } = require('./driveFiles');
    const index = await fileIndex();
    const name = `${key}.json`;
    const id = index.get(name);
    const written = await drive.writeJson({ id, name, value, parentId: snapshotFolderId() });
    if (!id && written && written.id) index.set(name, written.id);
  },
  async listKeys() {
    const index = await fileIndex({ refresh: true });
    return [...index.keys()].map(n => n.replace(/\.json$/, ''));
  },
};

const IMPLS = { disk, drive: driveStore };

let active = null;
function store() {
  if (!active) active = IMPLS[pickStore()];
  return active;
}

module.exports = {
  pickStore,
  assertKey,
  readJson: key => store().readJson(key),
  writeJson: (key, value) => store().writeJson(key, value),
  listKeys: () => store().listKeys(),
  storeName: () => pickStore(),
  DISK_DIR,
};
