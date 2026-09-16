// Generates the synthetic attendance the admin board is designed against.
//
//   node scripts/seed-admin-demo.js                 # 18 SPG, 14 days, real names if gws works
//   node scripts/seed-admin-demo.js --people=30 --days=21
//   node scripts/seed-admin-demo.js --offline       # skip Sheets entirely, synthetic names
//   node scripts/seed-admin-demo.js --clear         # delete the seed; board shows real data only
//
// This never writes to Google Sheets. It only reads the roster (and POI names) so the demo
// shows real people at real places; everything about their attendance is invented. The output
// is one gitignored file, and --clear removes it.

const fs = require('fs');
const demoSeed = require('../lib/demoSeed');

const args = process.argv.slice(2);
const flag = name => args.includes(`--${name}`);
const value = (name, fallback) => {
  const hit = args.find(a => a.startsWith(`--${name}=`));
  return hit ? Number(hit.split('=')[1]) : fallback;
};

async function collectRealContext() {
  const roster = require('../lib/roster');
  const poi = require('../lib/poi');
  const out = { roster: null, supervisors: null, poisByHub: {} };

  try {
    out.roster = await roster.getRoster();
    console.log(`  Roster: ${out.roster.length} SPG dari "SPG List LM".`);
  } catch (err) {
    console.log(`  Roster: tidak terbaca (${err.message.split('\n')[0]}) — pakai nama sintetis.`);
    return out;
  }

  try {
    out.supervisors = await roster.getSupervisorMap();
    const first = Object.values(out.supervisors)[0];
    const src = (first && first.source) || 'sumber tidak diketahui';
    console.log(`  CF mapping: ${Object.keys(out.supervisors).length} baris dari "${src}".`);
  } catch (err) {
    console.log(`  CF mapping: tidak terbaca (${err.message.split('\n')[0]}) — kolom CF dikosongkan.`);
  }

  // POI names only make the demo more convincing; a failure here is not worth stopping for.
  const hubs = [...new Set(out.roster.filter(p => p.active && p.hub).map(p => p.hub))].slice(0, 4);
  for (const hub of hubs) {
    try {
      const pois = await poi.getPoisForHub(hub);
      if (pois && pois.length) {
        out.poisByHub[hub] = pois.filter(p => p.lat != null && p.lng != null);
        console.log(`  POI ${hub}: ${out.poisByHub[hub].length} titik berkoordinat.`);
      }
    } catch {
      // hub keeps the generic fallback POIs
    }
  }
  return out;
}

async function main() {
  if (flag('clear')) {
    if (fs.existsSync(demoSeed.SEED_FILE)) {
      fs.unlinkSync(demoSeed.SEED_FILE);
      console.log(`Data semai dihapus: ${demoSeed.SEED_FILE}`);
      console.log('Papan admin sekarang hanya menampilkan data asli (saat ini: kosong).');
    } else {
      console.log('Tidak ada data semai untuk dihapus.');
    }
    return;
  }

  const people = value('people', 18);
  const days = value('days', 14);
  console.log(`Membuat data semai · ${people} SPG · ${days} hari`);

  let context = { roster: null, supervisors: null, poisByHub: {} };
  if (flag('offline')) {
    console.log('  Mode offline — tidak menyentuh Sheets sama sekali.');
  } else {
    context = await collectRealContext();
  }

  const seed = demoSeed.generate({ ...context, people, days });
  const file = demoSeed.save(seed);

  const flagged = seed.sessions.filter(r => (r[13] || '') === 'Needs Review').length;
  const decided = seed.sessions.filter(r => ['Approved', 'Rejected'].includes(r[13] || '')).length;
  console.log('');
  console.log(`  ${seed.roster.length} SPG · ${seed.sessions.length} sesi · ${seed.events.length} event`);
  console.log(`  ${flagged} perlu ditinjau · ${decided} sudah diputus`);
  console.log(`  Sumber nama: ${seed.rosterSource}`);
  console.log(`  Tersimpan di ${file}`);
  console.log('');
  console.log('Tidak ada satu baris pun yang ditulis ke Google Sheets.');
  console.log('Buka http://localhost:4173/admin — setiap baris semai diberi tanda di papan.');
}

main().catch(err => {
  console.error(`Gagal: ${err.message}`);
  process.exit(1);
});
