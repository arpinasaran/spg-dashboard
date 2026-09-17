const ICONS = {
  pin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 21s7-6.1 7-11.5A7 7 0 0 0 5 9.5C5 14.9 12 21 12 21Z"/><circle cx="12" cy="9.5" r="2.3"/></svg>',
  ext: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 4h6v6"/><path d="M20 4 10 14"/><path d="M18 13v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h6"/></svg>',
  photo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="6" width="18" height="14" rx="2"/><circle cx="9" cy="12" r="2.3"/><path d="M21 17l-5-4-4 3-3-2-4 3"/></svg>',
  gpsOk: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M8.5 12.5l2.3 2.3L16 9.5"/></svg>',
  gpsWarn: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3 2 20h20L12 3Z"/><line x1="12" y1="9" x2="12" y2="14"/><circle cx="12" cy="17" r="0.6" fill="currentColor"/></svg>',
  cam: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="7" width="18" height="13" rx="2"/><path d="M8 7 10 4h4l2 3"/><circle cx="12" cy="13.5" r="3.5"/></svg>'
};

let ME = null;
let POIS = [];
let HISTORY = [];
let KPI = null;
let META = null;
let RULES = { poiRadiusMeters: 250, minShiftHours: 9 };
let CATS = ['Semua'];
let poiFilter = 'Semua', poiQuery = '';
// Real rows from the "POI Proposals" tab of the POI Master spreadsheet. null means that tab
// could not be read — which must not look the same on screen as "you haven't proposed any".
let PROPOSALS = null;
let PROPOSAL_CATEGORIES = null;

const state = {
  attendance: 'not_started',
  sessionId: null,
  clockInPOI: null, clockInTime: null, clockInStatus: null,
  clockOutPOI: null, clockOutTime: null, clockOutStatus: null,
  reviewStatus: null,
  camStreams: {}, capturedPhoto: {},
  // One transaction id per submission, kept across retries of that same submission. See txnFor().
  txn: {},
};

/* A stable id for one attempt to record one thing.

   The failure this exists for: the row reaches the sheet, the response does not reach the
   phone — a tunnel, a dropped connection, a function that timed out after its own write
   succeeded. The SPG sees "Gagal menyimpan", presses the button again, and without an id the
   server has no way to tell that second request apart from a genuine second clock-in. It
   answered "sudah absen masuk hari ini", which reads as a refusal to someone who is in fact
   already clocked in and now believes they are not.

   Generated once and reused until the submission succeeds, so every retry carries the same id
   and the server can recognise its own work. crypto.randomUUID needs a secure context, which
   is also what the camera and GPS need, so the fallback here is for nothing more than a
   desktop browser on plain http during development. */
function newTxnId() {
  if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  (window.crypto || {}).getRandomValues ? window.crypto.getRandomValues(bytes)
    : bytes.forEach((_, i) => { bytes[i] = Math.floor(Math.random() * 256); });
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

function txnFor(flow) {
  if (!state.txn[flow]) state.txn[flow] = newTxnId();
  return state.txn[flow];
}

function $(sel, root) { return (root || document).querySelector(sel); }
function $all(sel, root) { return Array.from((root || document).querySelectorAll(sel)); }

function fmtTime(d) { return d.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' }); }
// Date-only strings get an explicit midnight so they're parsed as local, not UTC — otherwise
// "2026-09-14" renders as the 13th for anyone west of Greenwich.
function fmtDateShort(s) {
  const d = /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(`${s}T00:00:00`) : new Date(s);
  return d.toLocaleDateString('id-ID', { day: 'numeric', month: 'short' });
}
function fmtDateLong(dateStr) { return new Date(`${dateStr}T00:00:00`).toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'short' }); }

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000, toRad = x => x * Math.PI / 180;
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._h);
  toast._h = setTimeout(() => t.classList.remove('show'), 3400);
}

async function api(path, opts = {}) {
  const res = await fetch('/api' + path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  let body = null;
  try { body = await res.json(); } catch (_) { /* no body */ }
  if (!res.ok) {
    // Carry the status and whatever the server attached, so a caller can tell a conflict it
    // should stop retrying apart from a partial write it should retry.
    const err = new Error((body && body.error) || res.statusText);
    err.status = res.status;
    if (body) Object.assign(err, { sessionId: body.sessionId, recoverable: body.recoverable, gate: body.gate });
    throw err;
  }
  return body;
}

function showLoadError(msg) {
  $('#loadErrorText').textContent = msg;
  $('#loadError').classList.add('show');
}
function hideLoadError() { $('#loadError').classList.remove('show'); }

/* ---------- data freshness ----------
   The reads behind this app take seconds and are served from a server-side cache, so what's
   on screen is a snapshot, not live. Showing the exact clock time of that snapshot is easier
   to reason about than "18 mnt lalu" — you can compare it to your own watch at a glance. */
function stampTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const clock = d.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
  return sameDay ? clock : `${d.toLocaleDateString('id-ID', { day: 'numeric', month: 'short' })} ${clock}`;
}

function oldestFetch() {
  if (!META) return null;
  const stamps = Object.values(META).filter(Boolean).map(m => m.fetchedAt);
  if (!stamps.length) return null;
  return stamps.sort()[0];
}

function renderFreshness(busy) {
  const bar = $('#freshBar');
  const dot = $('#freshDot');
  const btn = $('#btnRefresh');
  bar.hidden = false;
  if (busy) {
    dot.className = 'freshdot busy';
    $('#freshText').textContent = 'Memperbarui data…';
    btn.disabled = true;
    $('#freshBtnLabel').textContent = 'Memuat';
    return;
  }
  const anyStale = META && Object.values(META).filter(Boolean).some(m => m.stale);
  dot.className = 'freshdot' + (anyStale ? ' stale' : '');
  $('#freshText').textContent = `Data per ${stampTime(oldestFetch())}`;
  btn.disabled = false;
  $('#freshBtnLabel').textContent = 'Perbarui';
}

async function refreshData(scope) {
  renderFreshness(true);
  try {
    const data = await api('/refresh', { method: 'POST', body: JSON.stringify({ scope: scope || 'all' }) });
    applyBootstrap(data);
    toast('Data diperbarui.');
  } catch (err) {
    toast('Gagal memperbarui: ' + err.message);
    renderFreshness(false);
  }
}

/* ---------- tabs ---------- */
function gotoTab(tab) {
  $all('.panel').forEach(p => p.classList.remove('active'));
  $('#panel-' + tab).classList.add('active');
  $all('.navbtn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  window.scrollTo({ top: 0, behavior: 'auto' });
}

/* ---------- identity ---------- */
// The sheets store city as "KAB. LOMBOK TIMUR" / "KOTA MATARAM". An SPG knows where she is;
// what she needs on screen is her own city name in normal case, not the internal hub code.
function cityCase(raw) {
  return (raw || '').trim().toLowerCase()
    .replace(/\b([a-z])/g, (_, c) => c.toUpperCase())
    .replace(/^Kab\.?\s+/, 'Kab. ')
    .replace(/^Kota\s+/, 'Kota ');
}
function myCity() { return cityCase(ME.city) || cityCase(ME.hub); }
function poiCity(p) { return cityCase(p.city) || cityCase(p.hub); }

function applyIdentity() {
  $('#brandGreeting').textContent = 'Halo, ' + ME.name;
  $('#brandSub').textContent = 'Rute Harian · ' + ME.opsId;
  $('#cityLabel').textContent = myCity();
  $('#poiHeading').textContent = 'Titik POI · ' + myCity();
  const initials = ME.name.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('');
  $('#kpiAvatar').textContent = initials || '?';
  $('#kpiIdentityName').textContent = ME.name;
  $('#kpiIdentitySub').textContent = `OS ID ${ME.opsId} · ${myCity()}`;
}

function applyTodayState(today) {
  state.sessionId = today.sessionId;
  // The server's own answer to "may this session clock out yet", not a second calculation of
  // it — see shiftGate in lib/attendance.js.
  state.gate = today.gate || null;
  if (today.status === 'not_started') {
    state.attendance = 'not_started';
    return;
  }
  state.attendance = today.status;
  state.clockInTime = today.inTime ? new Date(today.inTime) : null;
  state.clockInStatus = today.inStatus;
  state.clockInPOI = (today.events && today.events.in && today.events.in.poiId) || null;
  state.clockOutTime = today.outTime ? new Date(today.outTime) : null;
  state.clockOutStatus = today.outStatus;
  state.clockOutPOI = (today.events && today.events.out && today.events.out.poiId) || null;
  state.reviewStatus = today.reviewStatus;
}

/* ---------- checkpoints (home) ---------- */
function renderCheckpoints() {
  const rec = POIS.filter(p => p.recommended);
  // Says "dipilih acak" out loud: the rotation is a stand-in for FR-REC-04, and an SPG who
  // sees a different three tomorrow should know that's the app rotating, not a CF deciding.
  $('#checkpointHint').textContent = `${rec.length} dipilih acak hari ini`;
  $('#checkpointList').innerHTML = rec.map(p => {
    const isIn = state.clockInPOI === p.id, isOut = state.clockOutPOI === p.id;
    const tag = isIn ? '<span class="chip" style="background:var(--verified-bg);color:var(--verified);">Dipakai masuk</span>'
      : isOut ? '<span class="chip" style="background:var(--verified-bg);color:var(--verified);">Dipakai pulang</span>' : '';
    return `<div class="row">
      <div class="row-icon">${ICONS.pin}</div>
      <div class="row-main">
        <div class="row-title">${p.name}</div>
        <div class="row-sub"><span class="chip">${p.category}</span>${tag}</div>
      </div>
      <div class="row-action"><a class="iconbtn" href="${p.maps}" target="_blank" rel="noopener" title="Buka di Google Maps">${ICONS.ext}</a></div>
    </div>`;
  }).join('') || `<p style="color:var(--ink-soft);font-size:13.5px;padding:14px 2px;">Belum ada POI untuk hub ini di POI Master.</p>`;
}

/* ---------- attendance ticket ---------- */
function poiName(id) { const p = POIS.find(x => x.id === id); return p ? p.name : 'lokasi lain'; }

/* The gate, recomputed against the clock on each render rather than trusted as the snapshot
   the server sent. The page can sit open for hours — an SPG leaves it on the home screen all
   shift — so a msLeft captured at load would count down to nothing and stay there. */
function gateNow() {
  const g = state.gate;
  if (!g || !g.unlocksAt) return { locked: false, msLeft: 0, unlocksAt: null };
  const unlocksAt = new Date(g.unlocksAt);
  const msLeft = Math.max(0, unlocksAt.getTime() - Date.now());
  return { locked: msLeft > 0, msLeft, unlocksAt };
}

function fmtLeft(ms) {
  const mins = Math.ceil(ms / 60000);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h && m) return `${h} jam ${m} mnt`;
  if (h) return `${h} jam`;
  return `${m} mnt`;
}

function renderTicket() {
  const stamp = $('#ticketStamp'), headline = $('#ticketHeadline'),
    note = $('#ticketNote'), meta = $('#ticketMeta'), btn = $('#btnPrimaryAction');
  meta.textContent = new Date().toLocaleDateString('id-ID', { weekday: 'short', day: 'numeric', month: 'short' });
  btn.disabled = false;
  if (state.attendance === 'not_started') {
    stamp.className = 'daystatus st-neutral'; stamp.textContent = 'Belum Absen';
    headline.textContent = 'Siap mulai bertugas?';
    // No start deadline any more: the shift is measured from whenever it begins.
    note.innerHTML = `Absen pulang terbuka <b>${RULES.minShiftHours} jam</b> setelah absen masuk`;
    btn.textContent = 'Absen Masuk'; btn.dataset.target = 'sheetClockIn';
  } else if (state.attendance === 'clocked_in') {
    stamp.className = 'daystatus st-verified';
    stamp.textContent = 'Sedang Bertugas';
    headline.textContent = (!state.clockInPOI || state.clockInPOI === 'other') ? 'Bertugas dari lokasi lain' : 'Bertugas di ' + poiName(state.clockInPOI);

    /* The button is never locked any more.

       It used to be disabled until nine hours had passed, which read as the app being broken
       to anyone whose shift genuinely ended early — and it did not stop the day ending, it
       only stopped it being recorded. Now the shift length is shown, an early clock-out is
       allowed, and the person is told before they start that it will be flagged and that they
       will be asked why. Being told the rule and allowed to proceed is a different thing from
       being refused. */
    const gate = gateNow();
    btn.textContent = 'Absen Pulang';
    btn.disabled = false;
    btn.dataset.target = 'sheetClockOut';
    note.innerHTML = gate.locked
      ? `Masuk <b>${fmtTime(state.clockInTime)}</b> · Jam penuh <b>${fmtTime(gate.unlocksAt)}</b> · pulang lebih awal perlu alasan`
      : `Masuk <b>${fmtTime(state.clockInTime)}</b> · Sudah lewat ${RULES.minShiftHours} jam`;
  } else if (state.attendance === 'clocked_out') {
    const needsReview = state.reviewStatus === 'Needs Review';
    stamp.className = 'daystatus ' + (needsReview ? 'st-caution' : 'st-verified');
    stamp.textContent = needsReview ? 'Perlu Ditinjau' : 'Selesai';
    headline.textContent = 'Tugas hari ini selesai';
    note.innerHTML = `Masuk <b>${fmtTime(state.clockInTime)}</b> · Pulang <b>${fmtTime(state.clockOutTime)}</b>`;
    btn.textContent = 'Absen Sudah Lengkap'; btn.disabled = true;
  }
}

/* ---------- KPI ---------- */
// A metric is null when its source tab has no rows at all for this week — meaning we don't
// know, which is different from zero. Never render an unknown as a number: "0 onboarded"
// reads as a judgement on the SPG's week, and it would be the app's mistake, not theirs.
function metricCell(value, label, opts = {}) {
  const { suffix = '', big = '26px' } = opts;
  const known = value != null;
  const body = known
    ? `<div class="v num" style="font-size:${big};">${value}${suffix ? `<span style="font-size:12px;">${suffix}</span>` : ''}</div>`
    : `<div class="v" style="font-size:13px;color:var(--ink-soft);">Belum tersedia</div>`;
  return `<div class="kpi-cell">${body}<div class="l">${label}</div></div>`;
}

function renderKPI() {
  const mini = (value, label, suffix) => `<div class="kpi-mini">${
    value != null
      ? `<div class="v num">${value}${suffix ? `<span style="font-size:12px;">${suffix}</span>` : ''}</div>`
      : `<div class="v" style="font-size:12px;color:var(--ink-soft);">Belum ada</div>`
  }<div class="l">${label}</div></div>`;

  $('#kpiStrip').innerHTML = [
    mini(KPI.onboarded, 'Onboarded'),
    mini(KPI.gap, 'Sisa target'),
    mini(KPI.dailyTarget, 'Target harian', '/hari'),
    mini(KPI.registered, 'Registered'),
  ].join('');

  $('#kpiGrid').innerHTML = [
    metricCell(KPI.onboarded, 'Onboarded'),
    metricCell(KPI.registered, 'Registered courier'),
    metricCell(KPI.accountCreated, 'Account created'),
    metricCell(KPI.conversionRate, 'Tingkat konversi', { suffix: '%' }),
    metricCell(KPI.gap, `Sisa target (dari ${KPI.target})`),
    metricCell(KPI.dailyTarget, 'Target harian', { suffix: '/hari' }),
  ].join('');

  const yr = new Date(KPI.weekEnd + 'T00:00:00').getFullYear();
  $('#kpiBatchLabel').textContent =
    `Minggu ini · ${fmtDateShort(KPI.weekStart)}–${fmtDateShort(KPI.weekEnd)} ${yr} · sisa ${KPI.remainingDays} hari`;
}

/* ---------- POI directory ---------- */
function computeCats() { CATS = ['Semua', ...Array.from(new Set(POIS.map(p => p.category)))]; }
function renderPoiChips() {
  $('#poiFilterChips').innerHTML = CATS.map(c => `<button class="filterchip ${c === poiFilter ? 'on' : ''}" data-action="filter-poi" data-cat="${c}">${c}</button>`).join('');
}
function renderPoiList() {
  const q = poiQuery.trim().toLowerCase();
  const items = POIS.filter(p => (poiFilter === 'Semua' || p.category === poiFilter) && p.name.toLowerCase().includes(q));
  $('#poiList').innerHTML = items.map(p => `
    <div class="row">
      <div class="row-icon">${ICONS.pin}</div>
      <div class="row-main">
        <div class="row-title">${p.name}</div>
        <div class="row-sub"><span class="chip">${p.category}</span><span>${poiCity(p)}</span></div>
      </div>
      <div class="row-action"><a class="iconbtn" href="${p.maps}" target="_blank" rel="noopener" title="Buka di Google Maps">${ICONS.ext}</a></div>
    </div>`).join('') || `<p style="color:var(--ink-soft);font-size:13.5px;padding:14px 2px;">Tidak ada POI yang cocok dengan pencarian.</p>`;
}
function renderProposals() {
  const sec = $('#proposalsSection');
  if (PROPOSALS === null) {
    // The tab was unreachable. Saying nothing here would imply the SPG has never proposed
    // anything, so the section stays visible and says what actually happened.
    sec.style.display = 'block';
    $('#proposalsList').innerHTML = `<p style="color:var(--ink-soft);font-size:13px;padding:12px 2px;">Daftar usulan belum bisa dibaca dari spreadsheet. Usulan yang sudah terkirim tetap tersimpan.</p>`;
    return;
  }
  sec.style.display = PROPOSALS.length ? 'block' : 'none';
  $('#proposalsList').innerHTML = PROPOSALS.map(p => {
    const cls = p.status === 'Disetujui' ? 'verified' : p.status === 'Ditolak' ? 'alert' : 'caution';
    const when = p.submittedAt ? fmtDateShort(p.submittedAt.slice(0, 10)) : '';
    return `<div class="row">
      <div class="row-icon">${ICONS.pin}</div>
      <div class="row-main">
        <div class="row-title">${p.name}</div>
        <div class="row-sub"><span class="chip">${p.category || '—'}</span><span>${when}</span></div>
        ${p.reviewNote ? `<div class="note-box"><b>Catatan CF:</b> ${p.reviewNote}</div>` : ''}
      </div>
      <div class="row-action"><span class="statuschip ${cls}">${p.status}</span></div>
    </div>`;
  }).join('');
}

// The category list comes from POI Master's own vocabulary for this hub, so an approved
// proposal drops into the master sheet without anyone renaming its category first.
function renderProposalCategories() {
  if (!PROPOSAL_CATEGORIES || !PROPOSAL_CATEGORIES.length) return;
  const sel = $('#propCategory');
  const keep = sel.value;
  sel.innerHTML = PROPOSAL_CATEGORIES.map(c => `<option>${c}</option>`).join('');
  if (PROPOSAL_CATEGORIES.includes(keep)) sel.value = keep;
}

/* ---------- history ---------- */
// "Photo Reference" on a sheet row is a Drive file id ("drive:<id>"), not a URL. The server
// turns one into an image — fetching it from Drive if this machine has never seen it — so
// evidence taken on one device is viewable from another.
function photoSrc(ref) {
  if (!ref) return null;
  return `/api/photo/${encodeURIComponent(ref)}`;
}

function classifySession(s) {
  if (s.reviewStatus === 'Rejected') return { cls: 'alert', label: 'Ditolak' };
  if (s.reviewStatus === 'Needs Review') return { cls: 'caution', label: 'Perlu Ditinjau' };
  if (!s.outTime) return { cls: 'caution', label: 'Belum Absen Pulang' };
  // Only sessions written before the shift-length rule can still carry this.
  if (s.overallStatus === 'Late') return { cls: 'caution', label: 'Terlambat' };
  return { cls: 'verified', label: 'Valid' };
}
function eventLocLabel(ev) {
  if (!ev) return '';
  if (ev.poiName) return ev.poiName;
  if (ev.poiId === 'other') return 'Lokasi lain';
  return '';
}
function renderHistory() {
  $('#historyEmpty').style.display = HISTORY.length ? 'none' : 'block';
  $('#historyList').style.display = HISTORY.length ? '' : 'none';
  $('#historyList').innerHTML = HISTORY.map(h => {
    const { cls, label } = classifySession(h);
    const inTimeStr = h.inTime ? fmtTime(new Date(h.inTime)) : '—';
    const outTimeStr = h.outTime ? fmtTime(new Date(h.outTime)) : '—';
    return `<div class="row" data-action="open-history" data-session="${h.sessionId}" style="cursor:pointer;">
      <div class="row-icon">${ICONS.pin}</div>
      <div class="row-main">
        <div class="row-title">${fmtDateLong(h.localDate)}</div>
        <div class="row-sub"><span class="num">${inTimeStr}</span>–<span class="num">${outTimeStr}</span> <span>${eventLocLabel(h.events && h.events.in)}</span></div>
      </div>
      <div class="row-action"><span class="statuschip ${cls}">${label}</span></div>
    </div>`;
  }).join('');
}
function openHistoryDetail(sessionId) {
  const h = HISTORY.find(x => x.sessionId === sessionId);
  if (!h) return;
  const { cls, label } = classifySession(h);
  const inEv = h.events && h.events.in, outEv = h.events && h.events.out;
  const photoUrl = photoSrc((outEv && outEv.photoRef) || (inEv && inEv.photoRef));
  $('#histDetailTitle').textContent = fmtDateLong(h.localDate);
  $('#histDetailBody').innerHTML = `
    <span class="statuschip ${cls}">${label}</span>
    <div class="detail-kv">
      <div><div class="l">Absen masuk</div><div class="v num">${h.inTime ? fmtTime(new Date(h.inTime)) : '—'}</div></div>
      <div><div class="l">Lokasi masuk</div><div class="v">${eventLocLabel(inEv) || '—'}</div></div>
      <div><div class="l">Absen pulang</div><div class="v num">${h.outTime ? fmtTime(new Date(h.outTime)) : 'Belum tercatat'}</div></div>
      <div><div class="l">Lokasi pulang</div><div class="v">${eventLocLabel(outEv) || '—'}</div></div>
      <div><div class="l">Akurasi GPS (masuk)</div><div class="v num">${inEv && inEv.accuracy != null ? '±' + inEv.accuracy + ' m' : '—'}</div></div>
      <div><div class="l">Akurasi GPS (pulang)</div><div class="v num">${outEv && outEv.accuracy != null ? '±' + outEv.accuracy + ' m' : '—'}</div></div>
    </div>
    ${h.activityResult ? `<div class="note-box"><b>Hasil aktivitas:</b> ${h.activityResult}${h.activityNote ? ' — ' + h.activityNote : ''}</div>` : ''}
    ${inEv && inEv.note ? `<div class="note-box"><b>Catatan (masuk):</b> ${inEv.note}</div>` : ''}
    ${outEv && outEv.note ? `<div class="note-box"><b>Catatan (pulang):</b> ${outEv.note}</div>` : ''}
    ${h.reviewReason ? `<div class="note-box" style="border-color:var(--alert);color:var(--alert);"><b>Alasan CF:</b> ${h.reviewReason}</div>` : ''}
    <div class="detail-photo">${photoUrl ? `<img src="${photoUrl}" alt="Foto absen">` : ICONS.photo}</div>
  `;
  openSheet('sheetHistoryDetail');
}

/* ---------- sheets: open/close ---------- */
function openSheet(id) {
  $('#backdrop').classList.add('show');
  $('#' + id).classList.add('show');
}
function closeSheet(id) {
  $('#' + id).classList.remove('show');
  if (!$all('.sheet.show').length) $('#backdrop').classList.remove('show');
  stopCam(id.includes('ClockIn') ? 'in' : 'out');
}
function closeAllSheets() { $all('.sheet.show').forEach(s => closeSheet(s.id)); }

/* ---------- clock-in / out wizard ---------- */
function buildLocationOptions(flow) {
  const wrap = $(flow === 'in' ? '#inLocationOptions' : '#outLocationOptions');
  const exclude = flow === 'out' ? state.clockInPOI : null;
  const rec = POIS.filter(p => p.recommended && p.id !== exclude);
  wrap.innerHTML = rec.map(p => `
    <label class="optrow" data-poi="${p.id}">
      <input type="radio" name="${flow}Location" value="${p.id}">
      <span><span class="ot-title">${p.name}</span><span class="ot-sub">${p.category} · ${poiCity(p)}</span></span>
    </label>`).join('');
}

function wireLocationStep(flow) {
  const stepEl = $(`#sheet${flow === 'in' ? 'ClockIn' : 'ClockOut'} [data-step-index="1"]`);
  stepEl.addEventListener('click', (e) => {
    const row = e.target.closest('.optrow');
    if (!row) return;
    $all('.optrow', stepEl).forEach(r => r.classList.remove('picked'));
    row.classList.add('picked');
    const radio = row.querySelector('input'); if (radio) radio.checked = true;
    const isOther = row.querySelector('input').value === 'other';
    const noteField = $(flow === 'in' ? '#inOtherNoteField' : '#outOtherNoteField');
    noteField.style.display = isOther ? 'block' : 'none';
    validateStep(flow);
  });
  const noteEl = $(flow === 'in' ? '#inOtherNote' : '#outOtherNote');
  noteEl.addEventListener('input', () => validateStep(flow));
}

function currentPickedLocation(flow) {
  const checked = document.querySelector(`input[name="${flow}Location"]:checked`);
  return checked ? checked.value : null;
}

function validateStep(flow) {
  const sheetId = flow === 'in' ? 'sheetClockIn' : 'sheetClockOut';
  const sheet = $('#' + sheetId);
  const step = Number(sheet.dataset.step);
  const nextBtn = $(flow === 'in' ? '#inNext' : '#outNext');
  if (step === 1) {
    const loc = currentPickedLocation(flow);
    if (!loc) { nextBtn.disabled = true; return; }
    if (loc === 'other') {
      const note = $(flow === 'in' ? '#inOtherNote' : '#outOtherNote').value.trim();
      nextBtn.disabled = note.length < 4;
    } else nextBtn.disabled = false;
  } else if (step === 2) {
    nextBtn.disabled = !state.gpsReady;
  } else if (step === 3) {
    nextBtn.disabled = !state.camStreams[flow + '_captured'];
  } else if (step === 4) {
    const short = syncShortShift();
    const res = document.querySelector('input[name="actResult"]:checked');
    if (!res) { nextBtn.disabled = true; return; }
    let blocked = false;
    if (res.value === 'issue') blocked = $('#issueNote').value.trim().length < 3;
    // Matches MIN_REASON_LENGTH on the server, which is where the rule actually holds.
    if (short && $('#shortShiftReason').value.trim().length < 6) blocked = true;
    nextBtn.disabled = blocked;
    nextBtn.textContent = short ? 'Catat Pulang Lebih Awal' : 'Catat Absen Pulang';
  }
}

/* Called whenever the clock-out sheet opens, and again at step 4, because a shift can cross
   the nine-hour line while the sheet is open — somebody can sit on step 2 for ten minutes. */
function syncShortShift() {
  const field = $('#shortShiftField');
  if (!field) return false;
  const gate = gateNow();
  field.style.display = gate.locked ? 'block' : 'none';
  if (gate.locked) {
    $('#shortShiftWarn').innerHTML =
      `Kamu absen pulang <b>${fmtLeft(gate.msLeft)} lebih awal</b> dari ${RULES.minShiftHours} jam. `
      + 'Ini boleh, tapi hari ini akan ditandai untuk ditinjau pengawas, dan alasannya wajib diisi.';
  }
  return gate.locked;
}

function goStep(flow, n) {
  const sheetId = flow === 'in' ? 'sheetClockIn' : 'sheetClockOut';
  const sheet = $('#' + sheetId);
  const totalSteps = flow === 'in' ? 3 : 4;
  sheet.dataset.step = n;
  $all('.step', sheet).forEach(s => s.classList.toggle('active', Number(s.dataset.stepIndex) === n));
  $all('.dot', sheet).forEach((d, i) => d.classList.toggle('done', i < n));
  const labels = flow === 'in'
    ? ['Pilih lokasi', 'Verifikasi GPS', 'Foto & konfirmasi']
    : ['Pilih lokasi', 'Verifikasi GPS', 'Foto', 'Hasil aktivitas'];
  sheet.querySelector('[data-step-label]').textContent = `Langkah ${n} dari ${totalSteps} · ${labels[n - 1]}`;
  sheet.querySelector(flow === 'in' ? '#inBack' : '#outBack').style.display = n > 1 ? 'block' : 'none';
  const nextBtn = sheet.querySelector(flow === 'in' ? '#inNext' : '#outNext');
  nextBtn.textContent = n === totalSteps ? (flow === 'in' ? 'Catat Absen Masuk' : 'Catat Absen Pulang') : 'Lanjut';
  if (n === 2) runGPS(flow);
  validateStep(flow);
}

function sheetNext(sheetId) {
  const flow = sheetId === 'sheetClockIn' ? 'in' : 'out';
  const sheet = $('#' + sheetId);
  const step = Number(sheet.dataset.step);
  const total = flow === 'in' ? 3 : 4;
  if (step < total) { goStep(flow, step + 1); return; }
  finishFlow(flow);
}
function sheetBack(sheetId) {
  const flow = sheetId === 'sheetClockIn' ? 'in' : 'out';
  const sheet = $('#' + sheetId);
  const step = Number(sheet.dataset.step);
  if (step > 1) goStep(flow, step - 1);
}

/* ---------- GPS ---------- */
function getPositionRaced(timeoutMs) {
  return new Promise(resolve => {
    let settled = false;
    const finishOnce = (val) => { if (settled) return; settled = true; resolve(val); };
    const timer = setTimeout(() => finishOnce({ denied: true }), timeoutMs);
    if (!navigator.geolocation) { clearTimeout(timer); finishOnce({ denied: true }); return; }
    navigator.geolocation.getCurrentPosition(
      pos => { clearTimeout(timer); finishOnce({ lat: pos.coords.latitude, lng: pos.coords.longitude, acc: Math.round(pos.coords.accuracy || 15) }); },
      () => { clearTimeout(timer); finishOnce({ denied: true }); },
      { enableHighAccuracy: true, timeout: timeoutMs }
    );
  });
}
async function runGPS(flow) {
  const card = $(flow === 'in' ? '#inGpsCard' : '#outGpsCard');
  const loc = currentPickedLocation(flow);
  const poi = POIS.find(p => p.id === loc);
  const requestToken = (state.gpsToken = (state.gpsToken || 0) + 1);
  card.innerHTML = `<div class="gps-block"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="9"/></svg><p>Mengambil lokasi perangkat…</p></div>`;
  state.gpsReady = false;
  const result = await getPositionRaced(6000);
  if (requestToken !== state.gpsToken) return;
  const denied = !!result.denied;
  // Preview location, used only when the device refuses or cannot provide one (a desktop
  // browser with location blocked, for instance). It stands ~60 m from the chosen POI so the
  // flow can be walked through end to end; the card says plainly that this is a stand-in, so
  // nobody mistakes it for a real fix. Falls back to the hub area when the POI has no pin.
  const HUB_LAT = -8.42, HUB_LNG = 116.68; // approx. Sambalia, Lombok Timur
  const poiHasPin = poi && typeof poi.lat === 'number' && typeof poi.lng === 'number';
  const previewLat = (poiHasPin ? poi.lat : HUB_LAT) + 0.0005;
  const previewLng = (poiHasPin ? poi.lng : HUB_LNG) + 0.0003;
  const lat = denied ? previewLat : result.lat;
  const lng = denied ? previewLng : result.lng;
  const acc = denied ? 18 : result.acc;
  const hasPoiCoords = poiHasPin;
  let distText = '—', within = true, statusColor = 'var(--verified)', statusIcon = ICONS.gpsOk, statusLabel = 'Lokasi terverifikasi';
  if (hasPoiCoords) {
    const d = Math.round(haversine(lat, lng, poi.lat, poi.lng));
    distText = d + ' m';
    within = d <= RULES.poiRadiusMeters;
    if (!within) { statusColor = 'var(--caution)'; statusIcon = ICONS.gpsWarn; statusLabel = 'Di luar radius titik'; }
  } else {
    distText = 'Belum tersedia';
    statusColor = 'var(--ink-soft)'; statusIcon = ICONS.gpsOk; statusLabel = 'Koordinat lokasi perangkat tercatat';
  }
  state.gpsReady = true;
  state.lastGps = { lat, lng, acc };
  card.innerHTML = `
    <div class="gps-status" style="color:${statusColor}">${statusIcon} ${statusLabel}</div>
    <div class="gps-grid">
      <div><div class="v num">${lat.toFixed(5)}, ${lng.toFixed(5)}</div><div class="l">Koordinat</div></div>
      <div><div class="v num">±${acc} m</div><div class="l">Akurasi GPS</div></div>
      <div><div class="v num">${distText}</div><div class="l">Jarak ke titik</div></div>
      <div><div class="v num">${fmtTime(new Date())}</div><div class="l">Waktu ambil</div></div>
    </div>
    ${hasPoiCoords && !within ? `<div class="gps-warn">Kamu tercatat lebih dari ${RULES.poiRadiusMeters} m dari titik yang dipilih. Absen tetap bisa dikirim dan akan berstatus "Perlu Ditinjau".${poi.coordConfidence === 'low' ? ' Catatan: koordinat titik ini hasil pencocokan alamat sebagian, jadi bisa saja titiknya yang kurang tepat — CF akan melihat catatan ini saat meninjau.' : ''}</div>` : ''}
    ${!hasPoiCoords ? `<div class="gps-warn">Titik ini belum punya koordinat resmi di POI Master, jadi jarak belum bisa dihitung — absen tetap tercatat dengan lokasi perangkatmu dan foto sebagai bukti.</div>` : ''}
    ${denied ? `<div class="gps-warn">Izin lokasi ditolak/tidak tersedia — memakai lokasi contoh (mode pratinjau).</div>` : ''}
  `;
  validateStep(flow);
}

/* ---------- camera ---------- */
function camFallback(flow) {
  const wrap = $(flow === 'in' ? '#inCamWrap' : '#outCamWrap');
  const startBtn = $(flow === 'in' ? '#inCamStart' : '#outCamStart');
  wrap.innerHTML = `<div class="camplaceholder">${ICONS.cam}<div>Kamera tidak tersedia / izin ditolak.</div></div>`;
  if (startBtn) {
    startBtn.textContent = 'Gunakan foto contoh (mode pratinjau)';
    startBtn.dataset.action = 'use-placeholder-photo';
    startBtn.dataset.target = flow;
  }
}
async function startCam(flow) {
  const wrap = $(flow === 'in' ? '#inCamWrap' : '#outCamWrap');
  const startBtn = $(flow === 'in' ? '#inCamStart' : '#outCamStart');
  const requestToken = (state.camToken = (state.camToken || 0) + 1);
  let settled = false;
  const timer = setTimeout(() => {
    if (settled || requestToken !== state.camToken) return;
    settled = true;
    camFallback(flow);
  }, 5000);
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: false });
    if (settled || requestToken !== state.camToken) { stream.getTracks().forEach(t => t.stop()); return; }
    settled = true; clearTimeout(timer);
    state.camStreams[flow] = stream;
    wrap.innerHTML = '<video autoplay playsinline muted></video>';
    wrap.querySelector('video').srcObject = stream;
    startBtn.style.display = 'none';
    renderCamCapture(flow);
  } catch (err) {
    if (settled || requestToken !== state.camToken) return;
    settled = true; clearTimeout(timer);
    camFallback(flow);
  }
}
function renderCamCapture(flow) {
  const actions = $(flow === 'in' ? '#inCamStart' : '#outCamStart').parentElement;
  if ($('#camCapture_' + flow)) return;
  const btn = document.createElement('button');
  btn.className = 'btn btn-primary'; btn.id = 'camCapture_' + flow; btn.textContent = 'Ambil foto';
  btn.onclick = () => capturePhoto(flow);
  actions.appendChild(btn);
}
/* Attendance photos are evidence that someone was standing somewhere, not photographs. A
   phone camera hands us 12 megapixels of it, which becomes a multi-megabyte upload — over
   field 4G that is the slowest part of clocking in, and base64 in a JSON body inflates it by
   another third, far enough to run into the request size limit a serverless deployment
   enforces. 1280px on the long side is still plainly legible on the supervisor's board. */
const PHOTO_MAX_EDGE = 1280;

function capturePhoto(flow) {
  const wrap = $(flow === 'in' ? '#inCamWrap' : '#outCamWrap');
  const video = wrap.querySelector('video');
  const srcW = video.videoWidth || 480;
  const srcH = video.videoHeight || 640;
  const scale = Math.min(1, PHOTO_MAX_EDGE / Math.max(srcW, srcH));

  const canvas = document.createElement('canvas');
  canvas.width = Math.round(srcW * scale); canvas.height = Math.round(srcH * scale);
  canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
  const url = canvas.toDataURL('image/jpeg', 0.7);
  stopCam(flow);
  wrap.innerHTML = `<img src="${url}" alt="Foto absen">`;
  finalizeCapture(flow, false, url);
}
function usePlaceholderPhoto(flow) {
  const wrap = $(flow === 'in' ? '#inCamWrap' : '#outCamWrap');
  const canvas = document.createElement('canvas');
  canvas.width = 200; canvas.height = 260;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#c9bfa3'; ctx.fillRect(0, 0, 200, 260);
  ctx.fillStyle = '#fbf7ec';
  ctx.beginPath(); ctx.arc(100, 95, 42, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.moveTo(30, 250); ctx.quadraticCurveTo(30, 160, 100, 160); ctx.quadraticCurveTo(170, 160, 170, 250); ctx.fill();
  const dataUrl = canvas.toDataURL('image/png');
  wrap.innerHTML = `<img src="${dataUrl}" alt="Foto contoh">`;
  finalizeCapture(flow, true, dataUrl);
}
function finalizeCapture(flow, isSample, dataUrl) {
  state.camStreams[flow + '_captured'] = true;
  state.capturedPhoto[flow] = dataUrl;
  const wrap = $(flow === 'in' ? '#inCamWrap' : '#outCamWrap');
  const actions = wrap.parentElement.querySelector('.camactions');
  actions.innerHTML = `<button class="btn btn-ghost" data-action="retake" data-target="${flow}">Ambil ulang</button>`;
  const note = wrap.parentElement.querySelector(flow === 'in' ? '#inCamNote' : '.camnote');
  if (note) note.textContent = (isSample ? 'Foto contoh dipakai untuk pratinjau. ' : '') + 'Foto akan dikompresi otomatis sebelum dikirim.';
  validateStep(flow);
}
function retake(flow) {
  state.camStreams[flow + '_captured'] = false;
  delete state.capturedPhoto[flow];
  const shortReason = $('#shortShiftReason');
  if (shortReason) shortReason.value = '';
  const wrap = $(flow === 'in' ? '#inCamWrap' : '#outCamWrap');
  wrap.innerHTML = `<div class="camplaceholder">${ICONS.cam}Kamera belum aktif</div>`;
  const actions = wrap.parentElement.querySelector('.camactions');
  actions.innerHTML = `<button class="btn btn-ghost" id="${flow}CamStart" data-action="start-cam" data-target="${flow}">Aktifkan kamera</button>`;
  validateStep(flow);
}
function stopCam(flow) {
  const s = state.camStreams[flow];
  if (s) { s.getTracks().forEach(t => t.stop()); state.camStreams[flow] = null; }
}

/* ---------- finish flow: real POST to the backend ---------- */
async function finishFlow(flow) {
  const sheetId = flow === 'in' ? 'sheetClockIn' : 'sheetClockOut';
  const nextBtn = $(flow === 'in' ? '#inNext' : '#outNext');
  const loc = currentPickedLocation(flow);
  const poi = POIS.find(p => p.id === loc);
  const noteEl = $(flow === 'in' ? '#inOtherNote' : '#outOtherNote');
  const gps = state.lastGps || {};

  const payload = {
    txnId: txnFor(flow),
    poiId: loc,
    poiName: poi ? poi.name : null,
    note: loc === 'other' ? noteEl.value.trim() : '',
    lat: gps.lat, lng: gps.lng, accuracy: gps.acc,
    deviceTime: new Date().toISOString(),
    photoDataUrl: state.capturedPhoto[flow] || null,
  };
  if (flow === 'out') {
    const res = document.querySelector('input[name="actResult"]:checked');
    payload.activityResult = res ? (res.value === 'done' ? 'Aktivitas selesai' : 'Ada kendala') : '';
    payload.activityNote = res && res.value === 'issue' ? $('#issueNote').value.trim() : '';
    payload.shortShiftReason = gateNow().locked ? $('#shortShiftReason').value.trim() : '';
  }

  nextBtn.disabled = true;
  const prevLabel = nextBtn.textContent;
  nextBtn.textContent = 'Menyimpan…';
  try {
    const result = await api(`/attendance/clock-${flow}`, { method: 'POST', body: JSON.stringify(payload) });
    // Committed. The id must not be reused for the next, genuinely different, submission.
    delete state.txn[flow];
    closeSheet(sheetId);
    toast(flow === 'in'
      // No "on time" / "late" verdict to report any more — starting is just starting.
      ? `Absen masuk tercatat ${fmtTime(new Date())} · pulang bisa setelah ${RULES.minShiftHours} jam`
      : (result.shortShift
        ? `Absen pulang tercatat ${fmtTime(new Date())} · ditandai pulang lebih awal, pengawas akan meninjau`
        : `Absen pulang tercatat ${fmtTime(new Date())}`));
    // The write response already carries the updated session and history, so there's no
    // read-back round trip here.
    applyTodayState(result.today);
    HISTORY = result.history;
    renderTicket();
    renderCheckpoints();
    renderHistory();
    resetFlowForm(flow);
  } catch (err) {
    /* The id is deliberately NOT cleared here. Whatever went wrong, pressing the button again
       has to carry the same id: that is the only thing that lets the server recognise a retry
       of a write that may already have landed. It is cleared on success, and on a conflict the
       server has told us about, where reusing it would be meaningless. */
    if (err.status === 409 && !err.recoverable) delete state.txn[flow];
    toast('Gagal menyimpan: ' + err.message);
    nextBtn.disabled = false;
    nextBtn.textContent = prevLabel;
  }
}

function resetFlowForm(flow) {
  $all(`input[name="${flow}Location"]`).forEach(i => i.checked = false);
  $all('.optrow').forEach(r => r.classList.remove('picked'));
  const noteField = $(flow === 'in' ? '#inOtherNoteField' : '#outOtherNoteField');
  const noteEl = $(flow === 'in' ? '#inOtherNote' : '#outOtherNote');
  noteField.style.display = 'none';
  noteEl.value = '';
  state.camStreams[flow + '_captured'] = false;
  delete state.capturedPhoto[flow];
  buildLocationOptions(flow);
  goStep(flow, 1);
}

/* ---------- event delegation ---------- */
document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-action]');
  if (!t) return;
  const action = t.dataset.action;
  if (action === 'goto-tab') gotoTab(t.dataset.tab);
  else if (action === 'open-sheet') {
    const target = t.dataset.target;
    if (target === 'sheetClockOut') { buildLocationOptions('out'); syncShortShift(); }
    openSheet(target);
  }
  else if (action === 'close-sheet') closeSheet(t.dataset.target);
  else if (action === 'close-sheets') closeAllSheets();
  else if (action === 'sheet-next') sheetNext(t.dataset.target);
  else if (action === 'sheet-back') sheetBack(t.dataset.target);
  else if (action === 'start-cam') startCam(t.dataset.target);
  else if (action === 'use-placeholder-photo') usePlaceholderPhoto(t.dataset.target);
  else if (action === 'retake') retake(t.dataset.target);
  else if (action === 'filter-poi') { poiFilter = t.dataset.cat; renderPoiChips(); renderPoiList(); }
  else if (action === 'open-history') openHistoryDetail(t.dataset.session);
  else if (action === 'refresh-data') refreshData('all');
  else if (action === 'submit-proposal') submitProposal();
});

document.addEventListener('change', e => {
  if (e.target.name === 'actResult') {
    $('#issueNoteField').style.display = e.target.value === 'issue' ? 'block' : 'none';
    validateStep('out');
  }
});

async function submitProposal() {
  const btn = $('[data-action="submit-proposal"]');
  const name = $('#propName').value.trim();
  const maps = $('#propMaps').value.trim();
  if (name.length < 3 || !/^https?:\/\//i.test(maps)) {
    toast('Isi nama tempat dan tautan Google Maps yang lengkap (diawali http).');
    return;
  }

  // Only asked for when the checkbox says so — a POI proposal has no business carrying
  // someone's location unless they chose to attach it.
  let gps = {};
  if ($('#propGps').checked) {
    const pos = await getPositionRaced(6000);
    if (pos.denied) toast('Lokasi perangkat tidak tersedia — usulan tetap dikirim tanpa koordinat.');
    else gps = { lat: pos.lat, lng: pos.lng };
  }

  btn.disabled = true;
  const prev = btn.textContent;
  btn.textContent = 'Mengirim…';
  try {
    const res = await api('/poi-proposals', {
      method: 'POST',
      body: JSON.stringify({ name, category: $('#propCategory').value, maps, note: $('#propNote').value.trim(), ...gps }),
    });
    PROPOSALS = res.proposals;
    renderProposals();
    $('#propName').value = ''; $('#propMaps').value = ''; $('#propNote').value = ''; $('#propGps').checked = false;
    closeSheet('sheetPropose');
    toast('Usulan POI tersimpan di POI Master — menunggu ditinjau CF.');
  } catch (err) {
    toast('Gagal mengirim usulan: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = prev;
  }
}

function updateOfflineBanner() {
  $('#offlineBanner').classList.toggle('show', navigator.onLine === false);
}
window.addEventListener('online', updateOfflineBanner);
window.addEventListener('offline', updateOfflineBanner);

/* ---------- init ---------- */
function applyBootstrap(data) {
  ME = data.me;
  POIS = data.poi;
  KPI = data.kpi;
  HISTORY = data.history;
  META = data.meta;
  PROPOSALS = data.proposals === undefined ? PROPOSALS : data.proposals;
  if (data.proposalCategories) PROPOSAL_CATEGORIES = data.proposalCategories;
  if (data.rules) RULES = data.rules;

  hideLoadError();
  applyIdentity();
  applyTodayState(data.today);
  computeCats();

  renderTicket();
  renderCheckpoints();
  renderKPI();
  renderPoiChips();
  renderPoiList();
  renderHistory();
  renderProposals();
  renderProposalCategories();
  renderFreshness(false);
}

// One request instead of five. Every old endpoint resolved identity first, so a cold load
// fanned out into five calls all waiting on the same lookup.
async function loadAll() {
  try {
    applyBootstrap(await api('/bootstrap'));

    buildLocationOptions('in');
    wireLocationStep('in');
    wireLocationStep('out');
    goStep('in', 1);
    goStep('out', 1);
    $('#issueNote').addEventListener('input', () => validateStep('out'));
    $('#shortShiftReason').addEventListener('input', () => validateStep('out'));
    $('#poiSearch').addEventListener('input', e => { poiQuery = e.target.value; renderPoiList(); });

    setInterval(renderTicket, 30000);
    setInterval(() => { if (META) renderFreshness(false); }, 60000);
  } catch (err) {
    $('#freshBar').hidden = true;
    showLoadError('Tidak bisa memuat data dari server: ' + err.message + ' — pastikan `npm start` berjalan dan `gws auth status` sudah login.');
  }
}

updateOfflineBanner();
renderFreshness(true);
loadAll();
