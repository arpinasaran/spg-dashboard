const { test } = require('node:test');
const assert = require('node:assert');
const { distanceMeters } = require('../lib/geo');

test('distanceMeters returns 0 for the same point', () => {
  assert.strictEqual(distanceMeters(-8.383643, 116.691504, -8.383643, 116.691504), 0);
});

test('distanceMeters matches a known short distance between two Sambalia POIs', () => {
  // Pasar Sambalia -> Kantor Camat Sambalia, ~700m apart in the real POI Master data.
  const d = distanceMeters(-8.383643, 116.691504, -8.379025, 116.687918);
  assert.ok(d > 600 && d < 800, `expected ~700m, got ${d}m`);
});

test('distanceMeters separates the 250m geofence boundary correctly', () => {
  // ~0.0018 degrees of latitude is ~200m; ~0.0036 is ~400m.
  const inside = distanceMeters(-8.3836, 116.6915, -8.3836 + 0.0018, 116.6915);
  const outside = distanceMeters(-8.3836, 116.6915, -8.3836 + 0.0036, 116.6915);
  assert.ok(inside <= 250, `expected inside the fence, got ${inside}m`);
  assert.ok(outside > 250, `expected outside the fence, got ${outside}m`);
});

test('distanceMeters returns null when any coordinate is missing', () => {
  assert.strictEqual(distanceMeters(null, 116.69, -8.38, 116.69), null);
  assert.strictEqual(distanceMeters(-8.38, 116.69, undefined, 116.69), null);
});
