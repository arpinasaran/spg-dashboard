const config = require('../config');

/* Indonesia spans three time zones — WIB (+7), WITA (+8), WIT (+9) — and this app runs on a
   machine that may be in none of them. That matters in two different ways, and conflating
   them is how you get an attendance record filed under the wrong day.

   THE CLOCK. Every rule that compares two moments — the minShiftHours gate above all — uses
   absolute instants, so it is immune to all of this: nine hours is nine hours in any zone.
   The instants themselves come from the server's own clock (serverTs on every event row),
   which is NTP-synced on any host worth deploying to. The phone's clock is recorded beside it
   as deviceTs but never decides anything, because a phone's clock is whatever its owner set
   it to.

   THE CALENDAR DAY. This one is not immune, because "today" is a question about a wall
   clock somewhere. A session's id is `<OpsID>_<YYYY-MM-DD>`, and that date used to come from
   the host's own zone: fine on a laptop in Jakarta, wrong on a serverless instance running
   UTC, where an SPG clocking in at 06:30 WIB is still on the previous UTC day and files their
   morning under yesterday.

   So the day boundary is pinned to one zone for everybody rather than varying per SPG. That
   sounds like the less correct choice and is the more correct one: what must never happen is
   a rollover landing inside someone's shift, and midnight WIB is 01:00 WITA and 02:00 WIT —
   the middle of the night everywhere in the country. Per-SPG boundaries would move that line
   around for no gain and make two SPGs' "today" disagree. */

const ZONES = {
  WIB: { iana: 'Asia/Jakarta', offset: 7 },
  WITA: { iana: 'Asia/Makassar', offset: 8 },
  WIT: { iana: 'Asia/Jayapura', offset: 9 },
};

// Which zone a province sits in, for labelling times on screen. Matched loosely because the
// roster spells these inconsistently ("NUSA TENGGARA BARAT", "Nusa Tenggara Barat", "NTB").
const WITA_PROVINCES = [
  'bali', 'nusa tenggara', 'ntb', 'ntt', 'kalimantan selatan', 'kalimantan timur',
  'kalimantan utara', 'sulawesi', 'gorontalo',
];
const WIT_PROVINCES = ['maluku', 'papua'];

function zoneNameFor(province) {
  const p = String(province || '').trim().toLowerCase();
  if (!p) return config.timezone.defaultZone;
  if (WIT_PROVINCES.some(k => p.includes(k))) return 'WIT';
  if (WITA_PROVINCES.some(k => p.includes(k))) return 'WITA';
  return 'WIB';
}

function zoneFor(province) {
  return ZONES[zoneNameFor(province)] || ZONES.WIB;
}

// The zone the calendar day is measured in — one for the whole app. See the note above.
function dayZone() {
  return (ZONES[config.timezone.dayBoundaryZone] || ZONES.WIB).iana;
}

/* Formatting through Intl rather than by adding an offset by hand: an offset in code is a
   guess that stops being true the moment anything changes, while the platform's own zone
   database is maintained. Indonesia has no daylight saving, so this is stable either way —
   but the habit is what keeps it correct if this is ever pointed somewhere that does. */
function partsIn(iana, date) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: iana,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const out = {};
  for (const { type, value } of fmt.formatToParts(date)) out[type] = value;
  return out;
}

// "YYYY-MM-DD" for the given instant, in the app's day-boundary zone.
function dateStr(date = new Date(), iana = dayZone()) {
  const p = partsIn(iana, date);
  return `${p.year}-${p.month}-${p.day}`;
}

// The same date shifted by whole days, still measured in that zone.
function addDays(date, days, iana = dayZone()) {
  const base = new Date(`${dateStr(date, iana)}T00:00:00Z`);
  base.setUTCDate(base.getUTCDate() + days);
  return dateStr(base, 'UTC');
}

// "HH.MM" as the given province reads it, for anything shown to a person elsewhere.
function clockStr(date, province) {
  const p = partsIn(zoneFor(province).iana, date);
  return `${p.hour}.${p.minute}`;
}

function labelFor(province) {
  return zoneNameFor(province);
}

module.exports = { ZONES, zoneFor, zoneNameFor, dayZone, dateStr, addDays, clockStr, labelFor };
