const { test } = require('node:test');
const assert = require('node:assert');
const { markRecommended, coordConfidence } = require('../lib/poi');

// The eight real Sambalia Hub POIs, reduced to what the rotation cares about.
const pois = ['Belanting', 'Bengkel Toni', 'Kantor Camat', 'Pangkalan Ojek', 'Pasar Sambalia',
  'Perkumpulan pemuda', 'SMPN 2 Sambalia', 'Warok Ink Tobi'].map((name, i) => ({ id: `POI-${i}`, name }));

const picked = list => list.filter(p => p.recommended).map(p => p.id);

test('the daily draw is stable — same hub and date always yield the same three', () => {
  const a = picked(markRecommended(pois, { hub: 'Sambalia Hub', date: '2026-09-16' }));
  const b = picked(markRecommended(pois, { hub: 'Sambalia Hub', date: '2026-09-16' }));
  assert.deepStrictEqual(a, b);
  assert.strictEqual(a.length, 3);
});

// This is the property that matters most in the field: a refresh, a cache expiry or a server
// restart mid-shift must not reshuffle the list someone is halfway through using.
test('a different day rotates the selection, a different hub gives a different draw', () => {
  const today = picked(markRecommended(pois, { hub: 'Sambalia Hub', date: '2026-09-16' }));
  const tomorrow = picked(markRecommended(pois, { hub: 'Sambalia Hub', date: '2026-09-17' }));
  const otherHub = picked(markRecommended(pois, { hub: 'Gili Air Hub', date: '2026-09-16' }));
  assert.notDeepStrictEqual(today, tomorrow);
  assert.notDeepStrictEqual(today, otherHub);
});

test('every POI in the hub eventually gets its turn — the old "first three" never rotated', () => {
  const seen = new Set();
  for (let d = 1; d <= 28; d++) {
    const date = `2026-09-${String(d).padStart(2, '0')}`;
    picked(markRecommended(pois, { hub: 'Sambalia Hub', date })).forEach(id => seen.add(id));
  }
  assert.strictEqual(seen.size, pois.length, `only ${seen.size}/${pois.length} POIs were ever recommended`);
});

test('a hub with fewer POIs than the draw size recommends all of them, without duplicates', () => {
  const two = pois.slice(0, 2);
  const out = picked(markRecommended(two, { hub: 'Tiny Hub', date: '2026-09-16', count: 3 }));
  assert.strictEqual(out.length, 2);
  assert.strictEqual(new Set(out).size, 2);
  assert.deepStrictEqual(picked(markRecommended([], { hub: 'Empty Hub', date: '2026-09-16' })), []);
});

test('markRecommended does not mutate the cached POI objects it is given', () => {
  const cached = [{ id: 'POI-0', name: 'Belanting' }];
  markRecommended(cached, { hub: 'Sambalia Hub', date: '2026-09-16' });
  assert.strictEqual('recommended' in cached[0], false);
});

// "Validated: region match" entered POI Master after the coordinate enrichment pass. While it
// was unrecognised it fell to 'unknown', which locationCheck treats exactly like 'high' — an
// unchecked pin carried the same authority as one resolved from a Maps URL.
test('coordConfidence recognises every Geocode Status value POI Master currently uses', () => {
  assert.strictEqual(coordConfidence('Resolved from Maps URL'), 'high');
  assert.strictEqual(coordConfidence('Geocoded from address (best match)'), 'high');
  assert.strictEqual(coordConfidence('Validated: region match'), 'high');
  assert.strictEqual(coordConfidence('Geocoded from address (partial match)'), 'low');
});

test('coordConfidence still reports an unfamiliar or missing status as unknown', () => {
  assert.strictEqual(coordConfidence('Something nobody has written yet'), 'unknown');
  assert.strictEqual(coordConfidence(''), 'unknown');
  assert.strictEqual(coordConfidence(undefined), 'unknown');
});
