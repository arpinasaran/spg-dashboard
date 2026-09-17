#!/usr/bin/env node
/* Puts the QA Hub's POIs into "POI Master" so the dummies have somewhere to clock in.
 *
 * These are rows in another team's spreadsheet, so two things are deliberate. They are all
 * filed under Station Name "QA Hub", which no real SPG is assigned to, and which is therefore
 * the single string that both finds them again and keeps them out of everyone else's list.
 * And the run is idempotent: it reads what is already there and appends only what is missing,
 * so running it twice does not give the testers each POI twice.
 *
 * The coordinates are real, looked up from OpenStreetMap rather than invented -- a made-up
 * pin would make the 250m geofence untestable in the one way that matters, which is being
 * wrong about where someone is standing.
 *
 * Both cities share one hub, so every tester sees all of them and picks the nearest. That was
 * the agreed shape; the far ones double as the out-of-radius case without anyone having to
 * travel to produce it.
 *
 *   node scripts/seed-qa-pois.js          # dry run -- shows what is missing
 *   node scripts/seed-qa-pois.js --yes    # append the missing rows
 */

require('../lib/env').load();
process.env.SHEETS_DRIVER = process.env.SHEETS_DRIVER || 'google';

const { readRange, valuesAppend } = require('../lib/sheetsClient');
const config = require('../config');

const apply = process.argv.slice(2).includes('--yes');

const HUB = 'QA Hub';

// Region / Province / City follow the roster's own vocabulary, not the POI sheet's -- see
// QA_TESTERS.md section 2, where the two dictionaries are shown not to match.
const JOGJA = { region: 'Jawa Tengah', province: 'DI YOGYAKARTA', city: 'KAB. SLEMAN' };
const JAKARTA = { region: 'East Jabo', province: 'DKI JAKARTA', city: 'KOTA JAKARTA SELATAN' };

const POIS = [
  { ...JOGJA, name: 'Sahid J-Walk Babarsari', category: 'Tempat Wisata', lat: -7.7793746, lng: 110.4135955 },
  { ...JOGJA, name: 'Plaza Ambarrukmo', category: 'Tempat Wisata', lat: -7.7821651, lng: 110.4013445 },
  { ...JOGJA, name: 'Condongcatur', category: 'Perkumpulan Warga', lat: -7.7608044, lng: 110.4034239 },
  { ...JOGJA, name: 'Stasiun Maguwo', category: 'Pangkalan Ojek', lat: -7.7849555, lng: 110.4369000 },
  { ...JAKARTA, name: 'Gama Tower Kuningan', category: 'Tempat Wisata', lat: -6.2239821, lng: 106.8338302 },
  { ...JAKARTA, name: 'Kuningan City', category: 'Tempat Wisata', lat: -6.2245878, lng: 106.8297643 },
  { ...JAKARTA, name: 'Setiabudi One', category: 'Tempat Wisata', lat: -6.2152224, lng: 106.8300413 },
];

/* Column order is POI Master's own A:V, taken from the live header rather than assumed. The
   sheet is not ours, so a positional write has to be checked against the real thing every
   time -- see the header assertion in main(). */
const HEADER = [
  'Region', 'Province', 'City', 'Station Name', 'POI Location', 'POI Category', 'Google Maps',
  'BPOM PIC', 'SPG Assigned', 'SPG at Hub', 'Proposed Additional SPG', 'Flyering / Month',
  'Distance from Hub (km)', 'Travel Time (min)', 'Flyers / Month', 'Contacts / Month',
  'Data Source', 'Latitude', 'Longitude', 'Coordinate Source', 'Geocode Status', 'Geocoded At',
];

function rowFor(p, when) {
  return [
    p.region, p.province, p.city, HUB, p.name, p.category,
    `https://www.google.com/maps/search/?api=1&query=${p.lat},${p.lng}`,
    '', 'Vacant', '0', '0', '0', '', '', '0', '0',
    'QA seed',
    String(p.lat), String(p.lng),
    'OpenStreetMap lookup',
    // "validated" is what lib/poi.js reads as high confidence. These coordinates are checked,
    // so saying so is accurate rather than flattering.
    'Validated: QA seed',
    when,
  ];
}

async function main() {
  console.log(apply ? 'Menulis baris baru.' : 'Mode uji — tidak ada yang ditulis.');

  const probe = await readRange(config.sheets.poiMaster, "'POI Master'!A1:V1");
  const live = (probe[0] || []).map(v => String(v == null ? '' : v).trim());
  const mismatch = HEADER.findIndex((h, i) => live[i] !== h);
  if (mismatch >= 0) {
    console.error(`\nHeader "POI Master" tidak seperti yang diharapkan di kolom ${mismatch + 1}.`);
    console.error(`  diharapkan: ${HEADER[mismatch]}`);
    console.error(`  terbaca   : ${live[mismatch] || '(kosong)'}`);
    console.error('Penulisan posisional dibatalkan — sheet ini milik tim lain dan layoutnya berubah.');
    process.exit(1);
  }

  const existing = await readRange(config.sheets.poiMaster, "'POI Master'!D2:E");
  const have = new Set(existing
    .filter(r => String(r[0] || '').trim() === HUB)
    .map(r => String(r[1] || '').trim().toLowerCase()));

  console.log(`POI "${HUB}" yang sudah ada : ${have.size}`);

  const todo = POIS.filter(p => !have.has(p.name.toLowerCase()));
  console.log(`Akan ditambahkan          : ${todo.length}\n`);

  for (const p of todo) console.log(`  ${p.city.padEnd(22)} ${p.name.padEnd(24)} ${p.lat}, ${p.lng}`);
  if (!todo.length) { console.log('Sudah lengkap.'); return; }

  if (!apply) {
    console.log('\nJalankan lagi dengan --yes untuk benar-benar menulis.');
    return;
  }

  const when = new Date().toISOString().slice(0, 16).replace('T', ' ');
  await valuesAppend(config.sheets.poiMaster, "'POI Master'!A2", todo.map(p => rowFor(p, when)));
  console.log(`\n✓ ${todo.length} baris ditambahkan ke "POI Master".`);
  console.log('Tekan "Perbarui" di aplikasi, atau tunggu cache POI (1 jam) kedaluwarsa.');
}

main().catch((err) => {
  console.error('Gagal:', err.message);
  process.exit(1);
});
