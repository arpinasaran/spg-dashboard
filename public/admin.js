'use strict';

// Papan Pengawas. One fetch fills the whole page; every filter below runs against that copy
// in memory, so narrowing by hub or flipping "hanya yang perlu ditinjau" is instant and never
// touches the network — the slow part of this system is Sheets, and it is already paid for.

const el = id => document.getElementById(id);

const state = {
  board: null,
  filters: { q: '', region: '', cf: '', onlyReview: false },
  openSession: null,
};

// Short enough to sit on one line in a 66px cell — a tag that wraps costs the cell its
// scannability, which is the only reason the grid exists.
const STATE_TAGS = {
  ok: '', late: 'telat', open: 'aktif', unfinished: 'gantung',
  review: 'cek', approved: 'sah', rejected: 'tolak', none: '', rest: '',
};

const STATE_WORDS = {
  ok: 'Hadir', late: 'Telat masuk', open: 'Masih di lapangan',
  unfinished: 'Tidak ada absen pulang', review: 'Perlu ditinjau',
  approved: 'Sudah disahkan', rejected: 'Ditolak',
  none: 'Tidak absen', rest: 'Hari Minggu',
};

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function ago(iso) {
  if (!iso) return 'tidak diketahui';
  const secs = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (secs < 60) return `${secs} detik lalu`;
  if (secs < 3600) return `${Math.round(secs / 60)} menit lalu`;
  if (secs < 86400) return `${Math.round(secs / 3600)} jam lalu`;
  return `${Math.round(secs / 86400)} hari lalu`;
}

function tanggal(dateStr) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  const months = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli',
    'Agustus', 'September', 'Oktober', 'November', 'Desember'];
  const days = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];
  const dt = new Date(y, m - 1, d);
  return `${days[dt.getDay()]}, ${d} ${months[m - 1]} ${y}`;
}

async function api(path, options) {
  const res = await fetch(path, options);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Gagal memuat (${res.status})`);
  return body;
}

/* ---------------- header ---------------- */

function renderFreshness() {
  const m = state.board.meta.attendance;
  const node = el('freshness');
  node.textContent = `Data absensi ${ago(m.fetchedAt)}`;
  node.classList.toggle('stale', !!m.stale);
}

function renderDemoBadge() {
  const badge = el('demoBadge');
  const d = state.board.demo;
  if (!d || !d.active) { badge.hidden = true; return; }
  badge.hidden = false;
  badge.innerHTML = `<b>Data semai</b><span>${d.spgCount} SPG · ${d.sessionCount} sesi · nama dari ${esc(d.rosterSource)}</span>`;
  badge.title = 'Absensi di papan ini dibuat oleh scripts/seed-admin-demo.js dan tidak pernah ditulis '
    + 'ke Google Sheets. Baris asli selalu menimpa baris semai dengan Session ID yang sama.';
}

/* ---------------- tiles ---------------- */

function renderTiles() {
  const s = state.board.summary;
  const hadir = s.todayIn;
  const tiles = [
    {
      label: 'Sudah absen hari ini',
      value: `${hadir}<small> / ${s.spgTotal}</small>`,
      note: s.todayNone === 0 ? 'Semua sudah masuk' : `${s.todayNone} belum absen`,
      cls: s.todayNone > 0 ? 'is-caution' : '',
    },
    {
      label: 'Masih di lapangan',
      value: String(s.todayOpen),
      note: s.todayOpen === 0 ? 'Semua sudah absen pulang' : 'Belum absen pulang hari ini',
    },
    {
      label: 'Perlu ditinjau',
      value: String(s.needsReview),
      note: s.needsReview === 0 ? 'Antrian kosong' : `dalam ${state.board.days.length} hari terakhir`,
      cls: s.needsReview > 0 ? 'is-alert' : '',
      action: 'review',
    },
    {
      label: 'Sesi menggantung',
      value: String(s.unfinished),
      note: 'Absen masuk tanpa absen pulang',
      cls: s.unfinished > 0 ? 'is-caution' : '',
    },
    {
      label: 'Sudah diputus',
      value: String(s.decided),
      note: 'Disahkan atau ditolak',
    },
  ];

  el('tiles').innerHTML = tiles.map(t => `
    <div class="tile ${t.cls || ''} ${t.action ? 'is-clickable' : ''}" ${t.action ? `data-action="${t.action}"` : ''}>
      <span class="tile-label">${esc(t.label)}</span>
      <span class="tile-value num">${t.value}</span>
      <span class="tile-note">${esc(t.note)}</span>
    </div>`).join('');

  const jump = el('tiles').querySelector('[data-action="review"]');
  if (jump) {
    jump.addEventListener('click', () => {
      el('onlyReview').checked = true;
      state.filters.onlyReview = true;
      renderBoard();
    });
  }
}

/* ---------------- filters ---------------- */

function fillSelect(node, values, allLabel) {
  node.innerHTML = `<option value="">${allLabel}</option>`
    + values.map(v => `<option value="${esc(v)}">${esc(v)}</option>`).join('');
}

function visibleRows() {
  const { q, region, cf, onlyReview } = state.filters;
  const needle = q.trim().toLowerCase();
  return state.board.rows.filter(r => {
    if (region && r.region !== region) return false;
    if (cf && r.cfEmail !== cf) return false;
    if (onlyReview && r.stats.perluDicek === 0) return false;
    if (needle && !(`${r.name} ${r.opsId}`.toLowerCase().includes(needle))) return false;
    return true;
  });
}

/* ---------------- board ---------------- */

function chipHtml(cell) {
  const word = STATE_WORDS[cell.state] || cell.state;
  if (cell.state === 'rest') return `<span class="chip s-rest" title="Hari Minggu" aria-label="Minggu"></span>`;
  if (cell.state === 'none') {
    return `<span class="chip s-none" title="${esc(word)}" aria-label="${esc(word)}">–</span>`;
  }
  const tag = STATE_TAGS[cell.state];
  const title = [word, cell.poi ? `di ${cell.poi}` : null,
    cell.inTime ? `masuk ${cell.inTime}` : null,
    cell.outTime ? `pulang ${cell.outTime}` : null].filter(Boolean).join(' · ');
  return `<button type="button" class="chip s-${cell.state}" data-session="${esc(cell.sessionId)}"
    title="${esc(title)}" aria-label="${esc(title)}">
      <span class="chip-time">${esc(cell.inTime || '—')}</span>
      ${tag ? `<span class="chip-tag">${esc(tag)}</span>` : ''}
    </button>`;
}

function renderBoard() {
  const b = state.board;
  const rows = visibleRows();

  el('boardHead').innerHTML = `<tr>
    <th class="col-spg">SPG</th>
    ${b.days.map(d => `<th class="cell ${d.isToday ? 'is-today' : ''} ${d.isRest ? 'is-rest' : ''}">
      <span class="day-dow">${esc(d.dow)}</span>
      <span class="day-num num">${d.dayNum}</span>
      <span class="day-mon">${esc(d.month)}</span>
    </th>`).join('')}
    <th class="col-stats">14 hari</th>
  </tr>`;

  el('boardBody').innerHTML = rows.map(r => `
    <tr class="${state.filters.onlyReview ? 'dimmed' : ''}">
      <td class="col-spg">
        <div class="spg-name">
          ${r.demo ? '<i class="seed-dot" title="Baris data semai"></i>' : ''}
          <span>${esc(r.name)}</span>
          ${r.stats.perluDicek ? `<span class="pill-count num">${r.stats.perluDicek}</span>` : ''}
        </div>
        <div class="spg-meta">${esc(r.opsId)} · ${esc(r.hub)}</div>
      </td>
      ${r.cells.map(c => `<td class="cell">${chipHtml(c)}</td>`).join('')}
      <td class="col-stats">
        <div class="ministat">
          <span title="Hari hadir"><b class="num">${r.stats.hadir}</b> hadir</span>
          <span title="Tidak absen"><b class="num">${r.stats.bolong}</b> bolong</span>
        </div>
        <div class="ministat">
          <span title="Telat masuk"><b class="num">${r.stats.telat}</b> telat</span>
          ${r.stats.perluDicek ? `<span class="warn num" title="Perlu ditinjau">${r.stats.perluDicek} cek</span>` : ''}
        </div>
      </td>
    </tr>`).join('');

  const total = b.rows.length;
  el('rowCount').textContent = rows.length === total
    ? `${total} SPG`
    : `${rows.length} dari ${total} SPG`;

  const empty = el('boardEmpty');
  if (!rows.length) {
    empty.hidden = false;
    empty.textContent = state.filters.onlyReview
      ? 'Tidak ada sesi yang perlu ditinjau dengan penyaring ini. Antrian bersih.'
      : 'Tidak ada SPG yang cocok dengan penyaring ini.';
    el('boardScroll').hidden = true;
  } else {
    empty.hidden = true;
    el('boardScroll').hidden = false;
  }
}

/* ---------------- drawer ---------------- */

function fenceHtml(distance, radius) {
  if (distance == null) return '';
  const scale = Math.max(radius * 2, distance * 1.15);
  const inPct = (radius / scale) * 100;
  const dotPct = Math.min(100, (distance / scale) * 100);
  const bad = distance > radius;
  return `<div class="fence">
    <div class="fence-track">
      <div class="fence-in" style="width:${inPct.toFixed(1)}%"></div>
      <div class="fence-dot ${bad ? 'bad' : 'good'}" style="left:${dotPct.toFixed(1)}%"></div>
    </div>
    <div class="fence-legend"><span>0 m</span><span>pagar ${radius} m</span><span>${Math.round(scale)} m</span></div>
  </div>`;
}

function legHtml(title, ev, kind, detail) {
  if (!ev) {
    return `<div class="leg is-missing">
      <div class="leg-head"><h3>${esc(title)}</h3></div>
      <p class="leg-missing-msg">${kind === 'out'
        ? 'Belum ada absen pulang untuk sesi ini.'
        : 'Tidak ada data absen masuk.'}</p>
    </div>`;
  }
  const radius = detail.rules.poiRadiusMeters;
  const far = ev.distance != null && ev.distance > radius;
  const statusWord = kind === 'in'
    ? (detail.inStatus || '—')
    : (detail.outStatus || '—');

  // "Photo Reference" holds a Drive file id, not a URL — /api/photo resolves it and pulls the
  // file down from Drive when this machine has never held it, which is what makes the board
  // usable from a desk that isn't the one the photo was taken on.
  const photo = ev.photoAvailable
    ? `<div class="photo"><img src="/api/photo/${encodeURIComponent(ev.photoRef)}" alt="Foto ${esc(title.toLowerCase())}" loading="lazy"></div>`
    : `<div class="photo"><div class="photo-missing">${detail.demo
        ? 'Baris semai — tidak ada foto.'
        : 'Baris ini tidak menyimpan referensi foto.'}</div></div>`;

  const maps = (ev.lat != null && ev.lng != null)
    ? `<a class="maplink" href="https://www.google.com/maps?q=${ev.lat},${ev.lng}" target="_blank" rel="noopener">Lihat titik di peta →</a>`
    : '';

  return `<div class="leg">
    <div class="leg-head">
      <h3>${esc(title)}</h3>
      <span class="leg-time num">${esc(ev.timeLabel || '—')}</span>
    </div>
    <dl>
      <div class="kv"><dt>Status</dt><dd>${esc(statusWord)}</dd></div>
      <div class="kv"><dt>Lokasi</dt><dd>${esc(ev.poiName || 'Tidak dicatat')}</dd></div>
      <div class="kv"><dt>Jarak ke POI</dt><dd class="${ev.distance == null ? '' : (far ? 'bad' : 'good')}">${
        ev.distance == null ? 'Tidak dihitung' : `${ev.distance} m`}</dd></div>
      <div class="kv"><dt>Akurasi GPS</dt><dd>${ev.accuracy == null ? '—' : `±${ev.accuracy} m`}</dd></div>
    </dl>
    ${fenceHtml(ev.distance, radius)}
    ${ev.note ? `<p class="note">“${esc(ev.note)}”</p>` : ''}
    ${photo}
    ${maps}
  </div>`;
}

function decidedHtml(d) {
  const status = (d.reviewStatus || '').toLowerCase();
  if (status !== 'approved' && status !== 'rejected') return '';
  const ok = status === 'approved';
  return `<div class="decided ${ok ? 'ok' : 'no'}">
    <div class="decided-head">${ok ? 'Sudah disahkan' : 'Ditolak'}</div>
    ${d.reviewReason ? `<div>${esc(d.reviewReason)}</div>` : '<div>Tanpa catatan alasan.</div>'}
    <div class="decided-meta">oleh ${esc(d.reviewedBy || 'tidak tercatat')}${
      d.reviewedAt ? ` · ${ago(d.reviewedAt)}` : ''}</div>
  </div>`;
}

function verdictHtml(d) {
  if (!d.flagDetails.length) {
    return `<div class="verdict is-clean">
      <div class="verdict-title">Tidak ada yang ditandai</div>
      <div style="font-size:12.5px;color:var(--ink-soft)">Absen masuk dan pulang keduanya di dalam radius, jam wajar.</div>
    </div>`;
  }
  return `<div class="verdict is-flagged">
    <div class="verdict-title">${d.flagDetails.length} hal yang ditandai sistem</div>
    <div style="font-size:12px;color:var(--alert);opacity:0.85">Ini temuan mesin, bukan kesimpulan.</div>
    ${d.flagDetails.map(f => `<div class="flagitem"><b>${esc(f.label)}</b><span>${esc(f.detail)}</span></div>`).join('')}
  </div>`;
}

function reviewBoxHtml(d) {
  const decided = ['approved', 'rejected'].includes((d.reviewStatus || '').toLowerCase());
  return `<div class="review-box">
    <h3>${decided ? 'Ubah keputusan' : 'Keputusan'}</h3>
    <p class="review-hint">${decided
      ? 'Sesi ini sudah diputus. Buka lagi kalau ada bukti baru.'
      : 'Alasan wajib diisi kalau sesi ditolak — yang membacanya nanti adalah SPG-nya.'}</p>
    <label for="rvReason">Alasan / catatan</label>
    <textarea id="rvReason" placeholder="Contoh: sudah dicek lewat foto, SPG memang di lokasi — pin POI-nya yang meleset.">${esc(d.reviewReason || '')}</textarea>
    <label for="rvBy">Ditinjau oleh</label>
    <input type="text" id="rvBy" placeholder="email CF / nama" value="${esc(d.reviewedBy || '')}">
    <div class="review-actions">
      <button class="btn btn-primary" data-decision="approve" type="button">Sahkan</button>
      <button class="btn btn-danger" data-decision="reject" type="button">Tolak</button>
      ${decided ? '<button class="btn btn-quiet" data-decision="reopen" type="button">Buka lagi</button>' : ''}
    </div>
    <div class="review-msg" id="rvMsg"></div>
    ${d.demo ? `<p class="demo-note">Baris semai — keputusan disimpan ke data/demo/admin-seed.json
      di mesin ini, bukan ke Google Sheets.</p>` : ''}
  </div>`;
}

function renderDrawer(d) {
  state.openSession = d.sessionId;
  const person = d.person || {};
  el('drawerInner').innerHTML = `
    <div class="dhead">
      <div>
        <h2>${esc(d.spgName || person.name || d.opsId)}</h2>
        <div class="dhead-meta">${esc(d.opsId)} · ${esc(person.hub || '—')}${
          person.cfEmail ? ` · CF ${esc(person.cfEmail)}` : ''}</div>
        <div class="dhead-meta">${esc(tanggal(d.localDate))}</div>
      </div>
      <button class="xbtn" id="closeDrawer" type="button" aria-label="Tutup">×</button>
    </div>
    ${verdictHtml(d)}
    ${decidedHtml(d)}
    <div class="legs">
      ${legHtml('Absen masuk', d.events.in, 'in', d)}
      ${legHtml('Absen pulang', d.events.out, 'out', d)}
    </div>
    ${d.activityResult ? `<div class="leg"><div class="leg-head"><h3>Hasil aktivitas</h3></div>
      <div style="font-size:13px">${esc(d.activityResult)}</div>
      ${d.activityNote ? `<p class="note">“${esc(d.activityNote)}”</p>` : ''}</div>` : ''}
    ${reviewBoxHtml(d)}
  `;

  el('closeDrawer').addEventListener('click', closeDrawer);
  el('drawerInner').querySelectorAll('[data-decision]').forEach(btn => {
    btn.addEventListener('click', () => submitReview(btn.dataset.decision, d.sessionId));
  });
}

async function openSession(sessionId) {
  el('drawer').hidden = false;
  el('scrim').hidden = false;
  el('drawerInner').innerHTML = '<p class="board-empty">Memuat rincian…</p>';
  try {
    renderDrawer(await api(`/api/admin/session/${encodeURIComponent(sessionId)}`));
  } catch (err) {
    el('drawerInner').innerHTML = `<div class="dhead"><h2>Gagal memuat</h2>
      <button class="xbtn" id="closeDrawer" type="button" aria-label="Tutup">×</button></div>
      <p class="board-empty">${esc(err.message)}</p>`;
    el('closeDrawer').addEventListener('click', closeDrawer);
  }
}

function closeDrawer() {
  el('drawer').hidden = true;
  el('scrim').hidden = true;
  state.openSession = null;
}

async function submitReview(decision, sessionId) {
  const msg = el('rvMsg');
  const reason = el('rvReason').value;
  const reviewer = el('rvBy').value;
  msg.className = 'review-msg';
  msg.textContent = 'Menyimpan…';
  el('drawerInner').querySelectorAll('button[data-decision]').forEach(b => { b.disabled = true; });
  try {
    const out = await api('/api/admin/review', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, decision, reason, reviewer }),
    });
    // The board's counts and this row's colour both change, so reload the board rather than
    // patching one cell and letting the header numbers drift away from the grid.
    await loadBoard({ keepFilters: true });
    renderDrawer(out.session);
    const m = el('rvMsg');
    m.className = 'review-msg ok';
    m.textContent = decision === 'reopen' ? 'Dibuka lagi.' : 'Tersimpan.';
  } catch (err) {
    msg.className = 'review-msg err';
    msg.textContent = err.message;
    el('drawerInner').querySelectorAll('button[data-decision]').forEach(b => { b.disabled = false; });
  }
}

/* ---------------- boot ---------------- */

async function loadBoard({ keepFilters = false, force = false } = {}) {
  const btn = el('refreshBtn');
  btn.disabled = true;
  if (force) btn.textContent = 'Membaca…';
  try {
    state.board = await api('/api/admin/board');
    renderFreshness();
    renderDemoBadge();
    renderTiles();
    if (!keepFilters) {
      fillSelect(el('regionFilter'), state.board.regions || [], 'Semua region');
      fillSelect(el('cfFilter'), state.board.cfs, 'Semua CF');
      el('regionFilter').closest('.ctl').hidden = (state.board.regions || []).length < 2;
      el('cfFilter').closest('.ctl').hidden = state.board.cfs.length < 2;
    }
    renderBoard();
  } catch (err) {
    el('boardEmpty').hidden = false;
    el('boardEmpty').textContent = `Gagal memuat papan: ${err.message}`;
    el('boardScroll').hidden = true;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Perbarui';
  }
}

function wire() {
  el('search').addEventListener('input', e => { state.filters.q = e.target.value; renderBoard(); });
  el('regionFilter').addEventListener('change', e => { state.filters.region = e.target.value; renderBoard(); });
  el('cfFilter').addEventListener('change', e => { state.filters.cf = e.target.value; renderBoard(); });
  el('onlyReview').addEventListener('change', e => { state.filters.onlyReview = e.target.checked; renderBoard(); });

  el('refreshBtn').addEventListener('click', async () => {
    await api('/api/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'attendance' }),
    }).catch(() => {}); // a failed forced read still leaves the cached board usable
    loadBoard({ keepFilters: true, force: true });
  });

  // Event delegation: the grid is re-rendered on every filter change, so binding per chip
  // would mean re-binding hundreds of listeners for each keystroke in the search box.
  el('boardBody').addEventListener('click', e => {
    const chip = e.target.closest('.chip[data-session]');
    if (chip) openSession(chip.dataset.session);
  });

  el('scrim').addEventListener('click', closeDrawer);
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && state.openSession) closeDrawer();
  });

  setInterval(() => { if (state.board) renderFreshness(); }, 30000);
}

wire();
loadBoard();
