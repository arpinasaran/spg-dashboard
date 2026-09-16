// The column vocabulary of "SPG List LM", in one place.
//
// This sheet has now been restructured twice while the app was being built. First an
// instruction row was inserted above the header, so the header row is found by name rather
// than assumed to be row 1. Then the columns themselves were renamed and extended:
//
//   Location  -> Primary Hub          City   -> Primary City
//   Region    -> Primary Region       (new)  -> Primary Province, Entity, Title, Division
//   (new)     -> Staff BPOM CF, TL BPOM CF, BPOM Lead
//
// That last group matters: the supervisor emails, which used to live only in the separate
// "Data PIC SPG" spreadsheet, are now on the roster sheet itself — so the CF-to-SPG mapping
// costs no extra read when it is there.
//
// The failure mode this guards against is quiet, not loud. lib/cache.js keeps serving the
// last good snapshot and swallows a failed background refresh, by design — an SPG in the
// field must not see the app break because a column was renamed in Jakarta. The cost is that
// a rename looks like nothing at all until the snapshot is lost. Listing the accepted names
// per field means a rename adds a name here instead of freezing the data.

const ACCEPTED = {
  name: ['Name'],
  opsId: ['OSID'],
  fmsId: ['FMSID'],
  hub: ['Primary Hub', 'Location', 'Hub'],
  city: ['Primary City', 'City'],
  province: ['Primary Province', 'Province'],
  region: ['Primary Region', 'Region'],
  resignDate: ['Resign Date'],
  email: ['Email'],
  cfEmail: ['Staff BPOM CF', 'EMAIL BPOM CF'],
  coordinatorEmail: ['TL BPOM CF', 'EMAIL BPOM Coordinator / Team Lead'],
  leadArea: ['BPOM Lead', 'BPOM Lead Area'],
};

// Wide enough for the current layout (A..Q) with room for the next column someone adds.
const PROBE_RANGE = "'SPG List LM'!A1:T10";
const dataRange = headerIdx => `'SPG List LM'!A${headerIdx + 2}:T4018`;

function buildHeaderMap(headerRow) {
  const map = {};
  headerRow.forEach((h, i) => { if (h) map[String(h).trim()] = i; });
  return map;
}

function findHeader(rows, ...required) {
  const idx = rows.findIndex(r => required.every(k => r.includes(k)));
  if (idx < 0) throw new Error(`Header row (${required.join('/')}) not found — sheet layout may have changed`);
  return idx;
}

// Returns a reader bound to one header map: cols.get(row, 'hub') survives any rename that is
// listed in ACCEPTED, and cols.has('cfEmail') says whether this sheet carries the mapping.
function columns(headerRow) {
  const map = buildHeaderMap(headerRow);
  const index = field => {
    for (const name of ACCEPTED[field] || []) {
      if (map[name] != null) return map[name];
    }
    return null;
  };
  return {
    map,
    index,
    has: field => index(field) != null,
    get(row, field) {
      const i = index(field);
      return i == null ? '' : String(row[i] == null ? '' : row[i]).trim();
    },
    // Names the fields this sheet no longer provides, so the caller can throw an error that
    // says what is missing instead of silently returning blanks.
    missing(fields) {
      return fields.filter(f => index(f) == null)
        .map(f => `${f} (dicari sebagai: ${ACCEPTED[f].join(' / ')})`);
    },
  };
}

module.exports = { ACCEPTED, PROBE_RANGE, dataRange, columns, buildHeaderMap, findHeader };
