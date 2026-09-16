# Rute Harian — local app

A real, running version of the SPG Personal Dashboard prototype: a Node.js server that
reads and writes your actual Google Sheets (via `gws`) instead of hardcoded mock data.

## Run it

```bash
npm install
npm start
```

Open **http://localhost:4173** in Chrome for the SPG app, and
**http://localhost:4173/admin** for the supervisor board (desktop). It's a mobile-first layout — press F12 then
Ctrl+Shift+M and pick a phone, or run
`start chrome --app=http://localhost:4173 --window-size=390,844` for a phone-sized window.

Requires `gws` to already be installed and signed in on this machine (`gws auth status`
should show `token_valid: true`). The server shells out to it for every Sheets read/write,
and now for Drive uploads as well — the signed-in account needs the `drive` scope.

First run on a new machine or a new spreadsheet:

```bash
node scripts/setup-workspace.js   # creates the "POI Proposals" tab + the Drive photo folder
```

It is idempotent and never overwrites anything that already exists.

Camera and GPS only work on `localhost` or HTTPS. Opening the app from a phone via the
laptop's LAN IP (`http://192.168.x.x:4173`) will silently disable both.

## Speed: why it's built this way

The underlying reads are genuinely slow and can't be made fast. `Raw_Register` alone is
~185k rows; a full KPI read moves several MB and takes 3–30s depending on the network. The
Sheets API has no server-side filter, so there is no "just fetch less" option.

So the app never makes an SPG wait for one:

- **Pre-warm at boot.** `npm start` loads everything before anyone opens the page.
- **Stale-while-revalidate** (`lib/cache.js`). Once any copy of the data exists, it is served
  immediately — a request past its TTL gets the old copy plus a background refresh. Only a
  completely cold cache can block, and startup absorbs that.
- **Snapshot on disk** (`data/cache/`). A restart doesn't re-pay the cold cost.
- **One request, not five.** `/api/bootstrap` returns identity, POIs, KPI, today, history and
  POI proposals together; previously the page fired five calls that each waited on the same
  identity read.
- **Write-through.** Clock-in/out updates the cached copy from what was just written rather
  than reading it back, and returns the new state in the same response. A submitted POI
  proposal does the same.

Measured: cold bootstrap ~14–35s (at startup, nobody waiting) → **2–13ms** afterwards.

Because of this, what's on screen is a snapshot, not live. The app says so: a bar at the top
shows how old the data is and a **Perbarui** button forces a real read.

## What's real vs. deferred

**Real and live:**
- Identity, hub, city, region — from `SPG List LM` by OpsID.
- Supervisor (BPOM CF / Coordinator email) — from `Data PIC SPG`, tab `PIC SPG`.
- POI directory — from `POI Master`, filtered to the SPG's hub, with real coordinates.
- KPI funnel — registered / account created / onboarded for the current week, computed live
  from `Raw_Register`, `Raw_Creation` and `Raw_Onboarding`, matched by Ops id.
- Clock-in / clock-out — writes real rows to `Attendance Sessions` and `Attendance Events`,
  and reads 14-day history back.
- Attendance photos — uploaded to the Drive folder **SPG Attendance Photos**, which sits in
  the same Drive folder as POI Master and the Attendance Database. See "Where photos live".
- POI proposals — appended to the **POI Proposals** tab of the POI Master spreadsheet, and
  the SPG's own list is read back from it.
- Geofence — device position is compared against the POI's real coordinates; beyond
  250m (`config.rules.poiRadiusMeters`) the session is flagged for CF review.
- Supervisor board (`/admin`) — every SPG against the last 14 days, one cell per day, with an
  evidence panel and a Sah / Tidak Sah decision that writes back to `Attendance Sessions`.

**Deferred on purpose:**
- Real Google Sign-In / multi-user whitelist — the SPG app always represents whoever is
  configured in `config.js` (`spg.opsId`), and the board shows everyone with no scoping.
- FR-REC-04's real recommendation logic. Today's three points are a seeded random draw from
  the hub's POIs — see "Today's recommended points".
- A CF-facing review screen for POI proposals. Rows land in the sheet with `Status = Menunggu`;
  a reviewer changes that column by hand for now.
- Per-SPG weekly target. `config.rules.weeklyTarget` is still an interim 5 (on hold).
- Photo retention. `Photo Expiry Date` is written 14 days out, but nothing purges the Drive
  files or the local cache when that date passes.

## Today's recommended points

The three points on the home screen — and the three offered in the clock-in/clock-out wizard —
are drawn at random from the hub's own POIs by `markRecommended()` in `lib/poi.js`. This
replaces "the first three rows of the sheet", which meant the other POIs in a hub were
effectively invisible and could never be chosen.

The draw is **seeded by hub + local calendar date**, never `Math.random()`. That matters more
than it looks: the list has to survive a page refresh, a cache refresh and a server restart
inside the same day. A genuinely random pick would reshuffle the clock-out options midway
through a shift, and could hide the very POI someone had already clocked in at.

It is applied on read, not inside the cache loader, so the cached POI data stays a plain copy
of the sheet and the rotation turns over at local midnight rather than whenever the cache
happens to expire. `test/poi.test.js` locks in stability, rotation, and that every POI in a
hub eventually gets a turn.

## Where photos live

Attendance photos used to exist only in `data/photos/` on the machine running the server,
which made the evidence weaker than the record pointing at it: a lost disk left rows in
`Attendance Events` asserting a photo was taken that nobody could ever look at again.

Now (`lib/photoStore.js`):

1. The photo is written to `data/photos/` first. That write is what makes it exist, and it is
   why a clock-in still completes when Drive is slow or unreachable.
2. It is uploaded to the Drive folder **SPG Attendance Photos**
   (`config.drive.photosFolderId`).
3. `Photo Reference` (column M of `Attendance Events`) stores the reference:
   - `drive:<fileId>` — uploaded, survives this machine.
   - `local:<filename>` — the upload failed; the photo is on this laptop and nowhere else.
     The server logs this at the time and `photoStore.pending()` lists them.
4. `GET /api/photo/:ref` turns a reference into an image, downloading from Drive on first
   miss and caching it locally. That is what lets the supervisor board show evidence from a
   desk that never took the photo.

`data/photos/` is therefore a cache now, not the only copy. What is **not** done: nothing
retries a `local:` reference later, and nothing deletes a photo when its expiry date passes.

## POI proposals

A tab in the POI Master spreadsheet rather than a file of its own, because an approved
proposal becomes a POI Master row — keeping both in one spreadsheet makes that a copy across
instead of a move between documents. The columns deliberately echo POI Master's own
vocabulary (`Station Name`, `POI Location`, `POI Category`, `Google Maps`) for the same
reason.

```
Proposal ID | Submitted At | SPG OpsID | SPG Name | Station Name | City | Region |
POI Location | POI Category | Google Maps | Device Latitude | Device Longitude |
SPG Note | Status | Reviewed By | Reviewed At | Review Note
```

`Status` starts at `Menunggu`. Device coordinates are attached only when the SPG ticks the
box asking for it — a POI proposal has no business carrying someone's location otherwise.

The category dropdown is built from the categories POI Master actually uses for that hub,
unioned with a baseline list so a hub holding two POIs doesn't leave someone unable to
describe what they found.

## The supervisor board (`/admin`)

A desktop page, deliberately not a tab inside the SPG app: one is a mobile tool for the person
in the field, the other is a wide grid for someone at a desk watching many people.

Every SPG against the last 14 days, one cell per day, coloured by what the day needs:
hadir / telat / masih di lapangan / tak ada absen pulang / perlu ditinjau / disahkan / ditolak /
tidak absen. Clicking a cell opens the evidence — both legs of the session with time, POI,
distance against the 250m fence, GPS accuracy, note and photo — and a **Sah / Tidak Sah**
decision that writes to `Attendance Sessions` columns N–R.

**It costs no new reads.** `Attendance Sessions` was already read in full for the single-SPG
app (`A2:R2000`, no filter) and then 99% of it discarded. The board stops discarding it. The
one thing attendance data cannot tell you is who did *not* show up — absence leaves no row —
so the roster is the single extra read, cached for half an hour.

### Hub is not a team

Worth knowing before designing anything else on top of this: the live roster holds **504 SPG
across 499 hubs**. A hub is one person, so filtering by hub is useless. The unit that actually
has members is the **CF** — 108 of them, a median of 3 SPG each and 11 at the largest. So the
coarse filter is Region (6 of them, 29–84 SPG each) and the team filter is CF; hub stays on the
row as detail. It also means a real CF's board is 3–11 rows, not hundreds.

### Demo data

`Attendance Sessions` holds zero rows — one SPG has ever used this app, and `demo-reset`
cleared even that. A monitoring board built straight onto it renders empty, which is the one
state you cannot learn anything from. So:

```bash
node scripts/seed-admin-demo.js              # 22 SPG, 14 days, real names + real CF teams
node scripts/seed-admin-demo.js --offline    # no Sheets access needed; synthetic names
node scripts/seed-admin-demo.js --clear      # remove it; board shows only real data
```

The seed writes one gitignored file and **never touches Google Sheets**. Its rows are in the
exact shape the sheet uses, so `lib/admin.js` consumes real and seeded rows without branching;
a real row always wins over a seeded one with the same Session ID. Seeded rows are marked on
the board, and a decision on one is saved to the seed file rather than the spreadsheet.
Turn the whole thing off with `admin.demoData: false` in `config.js`.

The seed is **admin-only**. The SPG app never reads it, so nothing on that side of the app is
ever synthetic — its history is empty until someone really clocks in.

### The seam for migrating to the existing CF dashboard

The board deliberately has no login and no scoping: it shows everyone. The only question that
a real CF view answers differently is *"which SPG does this viewer own?"*, and that question is
answered in exactly one place — `lib/roster.js`'s `getSupervisorMap()`, which returns
`{ opsId: { cfEmail, coordinatorEmail, leadArea, source } }`. Point that at the existing CF
dashboard's mapping and filter `getBoard()`'s rows by it; nothing in `public/admin.*` has to
change, because the CF filter already renders exactly that subset.

## Business rules that are assumptions, not policy

In `config.rules`. Two came from the product owner; two did not:

| Rule | Value | Source |
|---|---|---|
| `poiRadiusMeters` | 250 | confirmed |
| `weeklyTarget` | 5 | interim — no per-SPG target source exists yet (on hold) |
| `lateAfterHour` | 10:00 | **assumption, unconfirmed** |
| `earlyBeforeHour` | 16:00 | **assumption, unconfirmed** |

These decide whether a real person's attendance reads as valid or "Needs Review", so the
last two should be confirmed before anyone relies on the output.

## Project layout

```
config.js             which SPG this instance represents, spreadsheet ids, Drive folder, rules, demo toggle
lib/gwsClient.js      shells out to gws's own run.js directly (avoids Windows shell-quoting issues)
lib/cache.js          stale-while-revalidate cache with a disk snapshot
lib/spgSheet.js       the column vocabulary of "SPG List LM" — accepted names per field
lib/identity.js       identity + supervisor for the one configured SPG
lib/roster.js         every SPG, and the CF-to-SPG map — what the board needs that identity.js discards
lib/admin.js          the board: SPG x day matrix, evidence detail, review write-back
lib/demoSeed.js       synthetic attendance so the board can be designed against a populated screen
lib/poi.js            POI directory for the SPG's hub, coordinate confidence, daily recommendation draw
lib/poiRegistry.js    assigns stable POI ids locally (POI Master has none)
lib/poiProposals.js   the "POI Proposals" tab: ensure, read, append
lib/photoStore.js     attendance photos — local write, Drive upload, reference resolution
lib/kpi.js            weekly funnel: registered / created / onboarded
lib/geo.js            haversine distance for the geofence
lib/attendance.js     clock-in/out writes, session+event reads
routes/api.js         Express routes, incl. /bootstrap, /refresh, /poi-proposals, /photo
routes/admin.js       /api/admin/board, /session/:id, /review
public/index.html     the SPG app (mobile-first)
public/admin.html     the supervisor board (desktop) — separate page, shared colour tokens
scripts/setup-workspace.js  creates the POI Proposals tab + the Drive photo folder (idempotent)
scripts/seed-admin-demo.js  makes/clears the demo seed; never writes to Sheets
data/cache/           cache snapshots (gitignored)
data/demo/            the demo seed (gitignored)
data/photos/          local cache of attendance photos (gitignored; Drive is the store of record)
data/poi-registry.json  POI id assignments — deleting this renumbers POIs
test/                 unit tests for the pure date/geo/POI/source logic (`npm test`)
```

## Notes on the source sheets

**Header positions move, and so do column names.** `SPG List LM` and `POI Master` were both
restructured while this was being built. First a header row shifted; the reading code finds
the header by name, so that was picked up without a code change. Then `SPG List LM` renamed
its columns outright — `Location` → `Primary Hub`, `City` → `Primary City`, `Region` →
`Primary Region` — and gained `Staff BPOM CF` / `TL BPOM CF`.

That second kind of change failed *silently*, which is worse than failing loudly:
`lib/cache.js` keeps serving the last good snapshot and swallows a failed background refresh
by design, so identity simply froze at its last value and the app looked fine. The fix is
`lib/spgSheet.js`, which holds a list of accepted names per field — a rename adds a name
there instead of freezing the data. `test/admin.test.js` locks in both spellings.

One upside of the new layout: the supervisor emails are now on the roster sheet itself, so
the CF-to-SPG mapping costs no extra read. `Data PIC SPG` is only consulted when those
columns are absent.

**Never bound a read by a guessed row count.** An earlier `Raw_Register!A4:A99999` silently
truncated a 184k-row tab, which made this SPG's weekly registrations read as `0` — a wrong
number that looked like a real one. All pipeline reads now use open-ended ranges (`A4:A`).
Two reads still carry a bound and should be revisited before any wide rollout:
`Attendance Sessions!A2:R2000` and `'POI Master'!A…:Z5012`.

**Zero and unknown are different.** If a source tab has no rows at all for the current week,
the corresponding metric is reported as `null` and rendered "Belum tersedia", never as `0`.
A zero here would read as a judgement on the SPG's week when it's actually a pipeline
problem.

**A value the code doesn't recognise is not the same as a value it trusts.** `POI Master`'s
`Geocode Status` gained `Validated: ...` during the coordinate enrichment pass. Until that
string was listed in `coordConfidence()` it fell through to `'unknown'` — and `locationCheck`
treats `'unknown'` exactly like `'high'`, so a pin nobody had checked carried the same
authority as one resolved from a Maps URL, and an SPG standing in the right place could be
flagged `OUT_OF_RADIUS` with no mitigating note. `test/poi.test.js` now pins every status
value the sheet currently uses. A genuinely unfamiliar value still lands on `'unknown'`;
the point is that a known one is named.
