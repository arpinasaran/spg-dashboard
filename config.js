// Real login (Google Sign-In + whitelist) is deferred per the PRD's MVP scope discussion —
// this local build runs as a single configured SPG. Swap opsId to point the whole app at
// a different person; every route resolves identity from this OpsID via lib/identity.js.
module.exports = {
  spg: {
    opsId: 'OS212341', // Bq. Elin Widyawati
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
  },

  // Business rules. These decide whether a real person's attendance counts as valid, so they
  // are stated here as explicit policy rather than buried as magic numbers in the logic.
  rules: {
    poiRadiusMeters: 250,       // confirmed by the product owner
    weeklyTarget: 5,            // interim figure pending a real per-SPG target source
    lateAfterHour: 10,          // clock-in at/after 10:00 local = "Late"  (assumption — unconfirmed)
    earlyBeforeHour: 16,        // clock-out before 16:00 local = "Early" (assumption — unconfirmed)
    photoRetentionDays: 14,
  },

  // Admin/CF monitoring board. demoData layers synthetic attendance (data/demo/admin-seed.json,
  // made by scripts/seed-admin-demo.js) under the real rows so the board can be designed against
  // a populated screen — the attendance sheet currently holds zero rows. Seeded rows are labelled
  // in the UI and are never written back to Sheets. Set false, or run the seed script with
  // --clear, to see only real data.
  admin: {
    demoData: true,
    boardDays: 14,
  },

  // How long each dataset may go without a background refresh. Nothing here makes a user
  // wait — see lib/cache.js; these only decide how quickly a background refresh is triggered.
  cache: {
    identityTtlMs: 30 * 60 * 1000,
    poiTtlMs: 60 * 60 * 1000,
    kpiTtlMs: 10 * 60 * 1000,
    attendanceTtlMs: 60 * 1000,
  },

  port: process.env.PORT || 4173,
};
