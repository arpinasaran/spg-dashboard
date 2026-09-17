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
  // The person's identifier, as written to "Attendance Sessions" column B and read back by
  // the supervisor board. This sheet carries two of them and they agree on nothing: a
  // read-only check of all 503 live rows found OSID != FMSID on every single one. The board
  // joins its roster on FMSID, so an app writing OSID produces sessions that match nobody --
  // every row reads as off-roster and the board looks empty to every CF while the writes are
  // in fact landing. FMSID (OPSxxxx) is the agreed side of that, so it is what opsId means
  // here. OSID is kept below because other teams still index this sheet on it.
  opsId: ['FMSID'],
  osId: ['OSID'],
  // The same column under the name the onboarding pipeline joins on -- lib/kpi.js matches
  // Raw_Register / Raw_Creation / Raw_Onboarding by FMSID.
  fmsId: ['FMSID'],
  hub: ['Primary Hub', 'Location', 'Hub'],
  // The (L1)/(L2)/(L3) suffixes are the sheet's administrative-level notation, added in the
  // same pass that emptied the name header. Province matters most: lib/timezone.js places an
  // SPG in WIB/WITA/WIT by it, and an unmatched column is not an error — it reads as blank
  // and the zone quietly falls back to WIB. That put Lombok an hour off with nothing to see.
  city: ['Primary City', 'City (L2)', 'City'],
  province: ['Primary Province', 'Province (L1)', 'Province'],
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
    /* The third restructuring was not a rename, so ACCEPTED could not absorb it: the header
       cell above the names was simply emptied. The names are still in the first column, and
       always have been — every layout this sheet has had put them there.

       The fallback is deliberately narrow. It applies to one field, and only while the first
       column carries no label at all; the moment someone writes anything in that cell, this
       stops and the accepted-names path is back in charge. Reading a labelled column as a
       name because of where it sits is exactly the guessing this file exists to avoid.

       Worth undoing: ask for the header to be restored, and this costs nothing. */
    if (field === 'name' && !String(headerRow[0] || '').trim()) return 0;
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
