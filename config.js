// Real login (Google Sign-In + whitelist) is deferred per the PRD's MVP scope discussion —
// this local build runs as a single configured SPG. Swap opsId to point the whole app at
// a different person; every route resolves identity from this OpsID via lib/identity.js.
module.exports = {
  spg: {
    // An FMSID ("Ops" + 7 digits), not an OSID -- see lib/spgSheet.js. The roster carries
    // both and they agree on nothing, so the OSID that used to sit here (OS212341) no longer
    // resolves; this is the same person's FMSID. It only affects a local run: a deployment
    // takes the identity from the session cookie instead.
    opsId: 'Ops1622838',
  },
  sheets: {
    // "[Field Recruiter] SPG Active Email", tab "SPG List LM"
    identity: '1pgZfhGXWyUHf3vGSddJkWXCFizO7Dfq0lCiumS9CanY',
    // "Data PIC SPG", tab "PIC SPG" — supervisor (CF / Coordinator) email per SPG
    cfMapping: '1iJX5kjd8cAQgZyTdCELjyTvKzgH9vrzjqBfQIgmgwcU',
    // "BPOM – Consolidated POI Master", tab "POI Master"
    poiMaster: '12ooPQ1Z1X9szjbNKCSLUiZ0DZJorVj8_O3I5Gwqpr7g',
    // "[Field Recruiter] BPOM x AI Study", tabs Raw_Register / Raw_Creation / Raw_Onboarding
    onboarding: '1MEYkSPqYzJB5O3QBpngMT-wbBD5RZVTqaJYQ0cJI8YU',
    // "SPG Personal Dashboard - Attendance Database" (created for this app)
    attendanceDb: '1RE4mf9mCwLS8EYEFFO2l6CLjj0td1iKO1tQFX9ns9uA',
    // SPG-submitted POI proposals. A tab inside the POI Master spreadsheet rather than a file
    // of its own: an approved proposal becomes a POI Master row, and keeping both in one
    // spreadsheet makes that a copy across instead of a move between documents.
    poiProposalsTab: 'POI Proposals',
    // Per-SPG password hashes, in the Attendance spreadsheet because that is the only file
    // this app both owns and can write to from a deployment. See lib/credentials.js.
    credentialsTab: 'SPG Credentials',
    // The human-readable record a supervisor reads a password out from. Separate from the
    // hashes above so it can be restricted or emptied later without breaking anyone's login.
    passwordsTab: 'SPG Passwords',
    /* The same readable record for the QA dummies, kept in a tab of its own.

       The split is not tidiness. The real list is five hundred people's live logins, and the
       QA list has to be handed to testers — putting both in one tab means sharing the first
       in order to share the second. Two tabs can be shared, restricted and emptied
       separately; the hashes stay together in one tab because that is what login reads. */
    qaPasswordsTab: 'QA Passwords',
  },

  // Where attendance photos live. Previously data/photos/ and nowhere else, which meant the
  // evidence was less durable than the record pointing at it. The local directory is still
  // written first (a clock-in must not fail because Drive is slow) and now acts as a cache.
  drive: {
    photosFolderId: '1hyJ9z9DIEg4rtNu3OlwOdF3BoPYqZ1O9', // made by scripts/setup-workspace.js
    photosFolderName: 'SPG Attendance Photos',
    parentFolderId: '0AAs_RcEHUn3sUk9PVA',    // the folder already holding POI Master + Attendance DB
  },

  /* Time. Indonesia has three zones and this app may run in none of them — a serverless
     instance runs UTC, where 06:30 WIB is still yesterday. See lib/timezone.js.

     dayBoundaryZone decides when "today" becomes "tomorrow" for the whole app, deliberately
     one zone for everybody: midnight WIB is 01:00 WITA and 02:00 WIT, so the rollover falls
     in the middle of the night everywhere in the country and can never land inside a shift.

     Durations — the minShiftHours gate — do not consult any of this; nine hours is nine hours
     in every zone. */
  timezone: {
    dayBoundaryZone: 'WIB',
    defaultZone: 'WIB', // when a roster row has no province to place someone by
  },

  // Business rules. These decide whether a real person's attendance counts as valid, so they
  // are stated here as explicit policy rather than buried as magic numbers in the logic.
  rules: {
    poiRadiusMeters: 250,       // confirmed by the product owner
    weeklyTarget: 5,            // interim figure pending a real per-SPG target source

    /* A shift is measured by its length, not by the clock. There used to be a 10:00 "late"
       line and a 16:00 "early" line, which assumed everyone works the same hours — an SPG
       who legitimately started at 11:00 was marked late for it. What actually matters is
       that a full day was worked, so clock-out is simply locked until this many hours have
       passed since clock-in. It is a gate, not a grade: there is nothing to mark late,
       because there is no wrong time to start. */
    minShiftHours: 9,
    photoRetentionDays: 14,
    recommendedPoiCount: 3,     // how many of the hub's POIs are drawn as today's recommendation
  },

  // Admin/CF monitoring board. demoData layers synthetic attendance (data/demo/admin-seed.json,
  // made by scripts/seed-admin-demo.js) under the real rows so the board can be designed against
  // a populated screen — the attendance sheet currently holds zero rows. Seeded rows are labelled
  // in the UI and are never written back to Sheets. Set false, or run the seed script with
  // --clear, to see only real data.
  admin: {
    // Off now that the board is deployed and a supervisor may actually read it. A synthetic
    // row is labelled, but a board that is mostly synthetic invites being skimmed rather than
    // read, and the one thing this page must never do is be wrong about a real person.
    demoData: false,
    boardDays: 14,
  },

  // How long each dataset may go without a background refresh. Nothing here makes a user
  // wait — see lib/cache.js; these only decide how quickly a background refresh is triggered.
  cache: {
    identityTtlMs: 30 * 60 * 1000,
    poiTtlMs: 60 * 60 * 1000,
    kpiTtlMs: 10 * 60 * 1000,
    attendanceTtlMs: 60 * 1000,
    proposalsTtlMs: 5 * 60 * 1000,
  },

  port: process.env.PORT || 4173,
};
