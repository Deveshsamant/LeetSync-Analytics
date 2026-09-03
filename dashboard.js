/* ============================================================
   dashboard.js — LeetSync analytics.

   Static page, no build step and no dependencies. Aggregation happens in SQL
   inside the Worker, so this only draws what it is handed.

   The key lives in localStorage and is sent as a bearer token. It never
   reaches the host serving this page — Vercel only serves static files.

   Everything rendered here was written by other people's browsers, so every
   value goes in through textContent. innerHTML is used only for markup this
   file authors itself, never for a field that came back from the API.
   ============================================================ */

const ENDPOINT = 'https://leetsync-analytics.devsamant1744.workers.dev';
const KEY_STORE = 'leetsync.dashboardKey';
const THEME_STORE = 'leetsync.dashboardTheme';

const $ = (id) => document.getElementById(id);
const fmt = (n) => Number(n || 0).toLocaleString();

let days = 30;
let key = null;
let view = 'overview';
let feedRows = [];
let feedFilter = 'all';

// ── Formatting ───────────────────────────────────────────────

const pct = (part, whole) => (!whole ? 0 : (part / whole) * 100);
const pctText = (part, whole) => (!whole ? '—' : `${(pct(part, whole)).toFixed(1)}%`);

function fmtMs(ms) {
  if (ms === null || ms === undefined) return '—';
  const n = Number(ms);
  if (!Number.isFinite(n)) return '—';
  return n >= 1000 ? `${(n / 1000).toFixed(2)} s` : `${Math.round(n)} ms`;
}

function fmtKb(kb) {
  if (kb === null || kb === undefined) return '—';
  const n = Number(kb);
  if (!Number.isFinite(n)) return '—';
  if (n >= 1048576) return `${(n / 1048576).toFixed(1)} GB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} MB`;
  return `${Math.round(n)} KB`;
}

function fmtBytes(b) {
  if (b === null || b === undefined) return '—';
  const n = Number(b);
  if (!Number.isFinite(n)) return '—';
  return n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${Math.round(n)} B`;
}

const fmtWhen = (ts) => (ts ? new Date(ts).toLocaleString() : '—');
const fmtDay = (ts) => (ts ? new Date(ts).toLocaleDateString() : '—');
const shortId = (id) => (id ? String(id).slice(0, 8) : '—');

// ── Tiny DOM helpers ─────────────────────────────────────────

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

/** A cell whose content is data from the API — always via textContent. */
function td(text, className) {
  return el('td', className, text === null || text === undefined || text === '' ? '—' : text);
}

/** Small proportion meter used for acceptance rates. */
function rateCell(part, whole) {
  const cell = el('td');
  if (!whole) { cell.textContent = '—'; return cell; }
  const wrap = el('div', 'rate');
  const track = el('span', 'rate-track');
  const fill = el('span', 'rate-fill');
  fill.style.width = `${Math.min(pct(part, whole), 100)}%`;
  track.appendChild(fill);
  wrap.append(track, el('span', 'rate-num', pctText(part, whole)));
  cell.appendChild(wrap);
  return cell;
}

function levelCell(difficulty) {
  const cell = el('td');
  const lvl = difficulty || 'Unknown';
  cell.appendChild(el('span', `level ${String(lvl).toLowerCase()}`, lvl));
  return cell;
}

function emptyRow(body, span, text) {
  const tr = el('tr');
  const cell = el('td', 'empty', text);
  cell.colSpan = span;
  tr.appendChild(cell);
  body.appendChild(tr);
}

// ── Theme ────────────────────────────────────────────────────

function applyTheme(name) {
  document.body.classList.toggle('light', name === 'light');
  try { localStorage.setItem(THEME_STORE, name); } catch { /* private mode */ }
}
try { applyTheme(localStorage.getItem(THEME_STORE) || 'dark'); } catch { /* ignore */ }

$('themeBtn').addEventListener('click', () => {
  applyTheme(document.body.classList.contains('light') ? 'dark' : 'light');
  // The SVG chart bakes in resolved colours, so it has to be redrawn.
  if (lastSummary) activityChart(lastSummary.daily);
});

// ── Fetching ─────────────────────────────────────────────────

async function api(path, withKey = key) {
  const res = await fetch(`${ENDPOINT}${path}`, {
    headers: { authorization: `Bearer ${withKey}` },
  });
  if (res.status === 401) throw new Error('unauthorised');
  if (!res.ok) throw new Error(`worker returned ${res.status}`);
  return res.json();
}

// ── Gate ─────────────────────────────────────────────────────

$('gateForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const candidate = $('keyInput').value.trim();
  if (!candidate) return;

  $('gateBtn').disabled = true;
  $('gateBtn').textContent = 'Checking…';
  $('gateError').textContent = '';

  try {
    const data = await api(`/api/summary?days=${days}`, candidate);
    key = candidate;
    try { localStorage.setItem(KEY_STORE, key); } catch { /* private mode */ }
    unlock(data);
  } catch (error) {
    $('gateError').textContent = error.message === 'unauthorised'
      ? 'That key was rejected.'
      : `Could not reach the Worker (${error.message}).`;
  } finally {
    $('gateBtn').disabled = false;
    $('gateBtn').textContent = 'Unlock';
  }
});

function unlock(summaryData) {
  $('gate').hidden = true;
  $('app').hidden = false;
  renderSummary(summaryData);
}

$('lockBtn').addEventListener('click', () => {
  try { localStorage.removeItem(KEY_STORE); } catch { /* ignore */ }
  location.reload();
});

// ── Views ────────────────────────────────────────────────────

$('views').addEventListener('click', (event) => {
  const chip = event.target.closest('.chip');
  if (!chip) return;
  view = chip.dataset.view;
  for (const c of $('views').querySelectorAll('.chip')) {
    const on = c === chip;
    c.classList.toggle('active', on);
    c.setAttribute('aria-selected', on ? 'true' : 'false');
  }
  for (const id of ['overview', 'users', 'activity']) {
    $(`view-${id}`).hidden = id !== view;
  }
  loadView();
});

$('ranges').addEventListener('click', (event) => {
  const chip = event.target.closest('.chip');
  if (!chip) return;
  for (const c of $('ranges').querySelectorAll('.chip')) c.classList.toggle('active', c === chip);
  days = Number(chip.dataset.days);
  loadView();
});

$('refreshBtn').addEventListener('click', loadView);

/** Fetch only what the visible view needs. */
async function loadView() {
  $('refreshBtn').textContent = 'Loading…';
  try {
    if (view === 'overview') renderSummary(await api(`/api/summary?days=${days}`));
    else if (view === 'users') renderUsers(await api(`/api/users?days=${days}`));
    else renderActivity(await api(`/api/activity?days=${days}&limit=500`));
  } catch (error) {
    $('footNote').textContent = `Refresh failed: ${error.message}`;
  } finally {
    $('refreshBtn').textContent = 'Refresh';
  }
}

// ── Charts ───────────────────────────────────────────────────

/** Horizontal bars, used by most panels. */
function bars(host, rows, { label, value, colour } = {}) {
  const node = $(host);
  node.innerHTML = '';
  if (!rows || !rows.length) {
    node.appendChild(el('div', 'empty', 'Nothing recorded yet.'));
    return;
  }
  const max = Math.max(...rows.map(r => Number(value(r)) || 0), 1);
  for (const row of rows) {
    const n = Number(value(row)) || 0;
    const line = el('div', 'bar-row');

    const name = el('span', 'bar-name', label(row) ?? '—');
    name.title = String(label(row) ?? '');

    const track = el('span', 'bar-track');
    const fill = el('span', 'bar-fill');
    fill.style.width = `${(n / max) * 100}%`;
    if (colour) {
      const c = colour(row);
      if (c) fill.style.background = c;
    }
    track.appendChild(fill);

    line.append(name, track, el('span', 'bar-value', fmt(n)));
    node.appendChild(line);
  }
}

let lastSummary = null;

/** Activity over time: total events plus the accepted subset. */
function activityChart(daily) {
  const host = $('activityChart');
  host.innerHTML = '';
  if (!daily || !daily.length) {
    host.appendChild(el('div', 'empty', 'No activity in this range.'));
    return;
  }

  const W = 1000, H = 230, padL = 44, padR = 12, padT = 12, padB = 26;
  const max = Math.max(...daily.map(d => d.events), 1);
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;
  const step = daily.length > 1 ? innerW / (daily.length - 1) : 0;
  const x = (i) => padL + (daily.length > 1 ? i * step : innerW / 2);
  const y = (v) => padT + innerH - (v / max) * innerH;

  const css = getComputedStyle(document.body);
  const accent = css.getPropertyValue('--ac').trim() || '#3FE08B';
  const violet = css.getPropertyValue('--violet').trim() || '#6c5ce7';
  const grid = css.getPropertyValue('--hair').trim() || '#161B1F';
  const text = css.getPropertyValue('--tx5').trim() || '#525C63';

  const path = (pick) => daily
    .map((d, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(pick(d)).toFixed(1)}`).join(' ');

  const line = path(d => d.events);
  const area = `${line} L${x(daily.length - 1).toFixed(1)},${padT + innerH} L${x(0).toFixed(1)},${padT + innerH} Z`;
  const acceptedLine = path(d => d.accepted || 0);

  let gridlines = '';
  for (let g = 0; g <= 3; g++) {
    const v = Math.round((max / 3) * g);
    const gy = y(v);
    gridlines += `<line x1="${padL}" y1="${gy}" x2="${W - padR}" y2="${gy}" stroke="${grid}" stroke-width="1"/>`
      + `<text x="${padL - 8}" y="${gy + 3.5}" text-anchor="end" font-family="ui-monospace,monospace" font-size="9" fill="${text}">${v}</text>`;
  }

  const marks = daily.length > 6 ? [0, Math.floor(daily.length / 2), daily.length - 1] : daily.map((_, i) => i);
  const labels = [...new Set(marks)].map(i =>
    `<text x="${x(i).toFixed(1)}" y="${H - 8}" text-anchor="${i === 0 ? 'start' : i === daily.length - 1 ? 'end' : 'middle'}" font-family="ui-monospace,monospace" font-size="9" fill="${text}">${daily[i].day.slice(5)}</text>`).join('');

  // Values come from SQL aggregates (numbers and an ISO date), so they are
  // safe to interpolate; nothing user-authored reaches this string.
  const dots = daily.map((d, i) =>
    `<circle cx="${x(i).toFixed(1)}" cy="${y(d.events).toFixed(1)}" r="2.5" fill="${accent}"><title>${d.day}: ${d.events} events, ${d.installs} installs, ${d.submissions || 0} submissions, ${d.accepted || 0} accepted</title></circle>`).join('');

  host.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Events per day">
    <defs><linearGradient id="fade" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${accent}" stop-opacity="0.28"/>
      <stop offset="100%" stop-color="${accent}" stop-opacity="0"/>
    </linearGradient></defs>
    ${gridlines}
    <path d="${area}" fill="url(#fade)"/>
    <path d="${line}" fill="none" stroke="${accent}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
    <path d="${acceptedLine}" fill="none" stroke="${violet}" stroke-width="1.8" stroke-dasharray="4 3" stroke-linejoin="round" stroke-linecap="round"/>
    ${dots}${labels}
  </svg>`;
}

// ── Overview ─────────────────────────────────────────────────

const VERDICT_COLOUR = {
  Accepted: 'var(--easy)',
  'Wrong Answer': 'var(--hard)',
  'Time Limit Exceeded': 'var(--med)',
  'Memory Limit Exceeded': 'var(--med)',
  'Output Limit Exceeded': 'var(--med)',
  'Runtime Error': 'var(--hard)',
  'Compile Error': 'var(--hard)',
};

function renderSummary(data) {
  lastSummary = data;

  const count = (name) => (data.events.find(e => e.event === name) || {}).n || 0;
  const submissions = data.statuses.reduce((sum, s) => sum + s.n, 0);
  const accepted = (data.statuses.find(s => s.status === 'Accepted') || {}).n || 0;

  $('tInstalls').textContent = fmt(data.totals.installs);
  $('tSubs').textContent = fmt(submissions);
  $('tAccept').textContent = pctText(accepted, submissions);
  $('tPushes').textContent = fmt(count('push_ok'));
  $('tProblems').textContent = fmt(data.problems.length);
  $('tFailures').textContent = fmt(count('push_fail'));

  $('activityNote').textContent =
    `${data.daily.length} day${data.daily.length === 1 ? '' : 's'} with activity`;
  activityChart(data.daily);

  const level = (d) => ({ Easy: 'var(--easy)', Medium: 'var(--med)', Hard: 'var(--hard)' }[d.difficulty]);
  bars('statusChart', data.statuses, {
    label: r => r.status, value: r => r.n, colour: r => VERDICT_COLOUR[r.status],
  });
  bars('themeChart', data.themes, {
    label: r => (r.theme === 'light' ? 'Modernist (light)' : 'Signal (dark)'),
    value: r => r.installs,
  });
  bars('eventsChart', data.events, { label: r => r.event, value: r => r.n });
  bars('languagesChart', data.languages, { label: r => r.language, value: r => r.n });
  bars('difficultyChart', data.difficulty, { label: r => r.difficulty, value: r => r.n, colour: level });
  bars('versionsChart', data.versions, { label: r => r.version, value: r => r.installs });
  bars('failuresChart', data.failures, { label: r => r.reason, value: r => r.n });
  bars('sheetsChart', data.sheets, { label: r => r.sheet, value: r => r.installs });

  perfTable(data.perf);
  problemsTable(data.problems);

  $('footNote').textContent =
    `Updated ${new Date(data.generatedAt).toLocaleString()} · last ${data.days} days`;
}

const DIFF_ORDER = { Easy: 0, Medium: 1, Hard: 2, Unknown: 3 };

function perfTable(rows) {
  const body = $('perfBody');
  body.innerHTML = '';
  if (!rows || !rows.length) return emptyRow(body, 5, 'No accepted solutions yet.');

  for (const row of [...rows].sort((a, b) =>
    (DIFF_ORDER[a.difficulty] ?? 9) - (DIFF_ORDER[b.difficulty] ?? 9))) {
    const tr = el('tr');
    tr.append(
      levelCell(row.difficulty),
      td(fmt(row.n), 'num'),
      td(fmtMs(row.avg_runtime), 'num'),
      td(fmtKb(row.avg_memory), 'num'),
      td(fmtBytes(row.avg_code_len), 'num'),
    );
    body.appendChild(tr);
  }
}

function problemsTable(rows) {
  const body = $('problemsBody');
  body.innerHTML = '';
  if (!rows || !rows.length) return emptyRow(body, 9, 'No submissions recorded yet.');

  rows.forEach((row, i) => {
    const tr = el('tr');

    const title = el('td');
    const link = el('a', null, row.title || row.slug);
    link.href = `https://leetcode.com/problems/${encodeURIComponent(row.slug)}/`;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    title.appendChild(link);

    tr.append(
      td(i + 1, 'rank'),
      title,
      levelCell(row.difficulty),
      td(fmt(row.attempts), 'num'),
      td(fmt(row.accepted), 'num'),
      rateCell(row.accepted, row.attempts),
      td(fmt(row.pushes), 'num'),
      td(fmt(row.installs), 'num'),
      el('td', 'open', '↗'),
    );
    body.appendChild(tr);
  });
}

// ── Users ────────────────────────────────────────────────────

function renderUsers(data) {
  const body = $('usersBody');
  body.innerHTML = '';
  $('usersNote').textContent =
    `${data.users.length} install${data.users.length === 1 ? '' : 's'} · click a row for detail`;

  if (!data.users.length) return emptyRow(body, 11, 'No installs have reported yet.');

  for (const user of data.users) {
    const tr = el('tr', 'row-link');
    tr.tabIndex = 0;

    const idCell = el('td');
    idCell.appendChild(el('span', 'mono', shortId(user.install_id)));
    idCell.title = user.install_id;

    const themeCell = el('td');
    themeCell.appendChild(el('span', 'chip-mini',
      user.theme === 'light' ? 'Modernist' : user.theme === 'dark' ? 'Signal' : '—'));

    const codeCell = el('td', 'num');
    codeCell.appendChild(el('span', `chip-mini ${user.code_shared ? 'chip-ok' : ''}`,
      user.code_shared ? fmt(user.code_shared) : 'off'));

    tr.append(
      idCell,
      themeCell,
      td(user.version, 'mono'),
      td(fmt(user.submissions), 'num'),
      td(fmt(user.accepted), 'num'),
      rateCell(user.accepted, user.submissions),
      td(fmt(user.pushes), 'num'),
      td(fmt(user.problems), 'num'),
      codeCell,
      td(fmtDay(user.first_seen)),
      td(fmtWhen(user.last_seen)),
    );

    const open = () => openUser(user.install_id);
    tr.addEventListener('click', open);
    tr.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
    });
    body.appendChild(tr);
  }

  $('footNote').textContent =
    `Updated ${new Date(data.generatedAt).toLocaleString()} · last ${data.days} days`;
}

// ── Per-install drawer ───────────────────────────────────────

async function openUser(installId) {
  $('drawer').hidden = false;
  $('drawerId').textContent = installId;
  const body = $('drawerBody');
  body.innerHTML = '';
  body.appendChild(el('div', 'empty', 'Loading…'));

  let data;
  try {
    data = await api(`/api/user?id=${encodeURIComponent(installId)}&limit=400`);
  } catch (error) {
    body.innerHTML = '';
    body.appendChild(el('div', 'empty', `Could not load this install (${error.message}).`));
    return;
  }

  body.innerHTML = '';
  const p = data.profile;

  const tiles = el('div', 'tiles');
  const tile = (value, label) => {
    const node = el('div', 'tile');
    node.append(el('div', 'tile-value', value), el('div', 'tile-label', label));
    return node;
  };
  tiles.append(
    tile(fmt(p.submissions), 'Submissions'),
    tile(pctText(p.accepted, p.submissions), 'Acceptance'),
    tile(fmt(p.pushes), 'Pushed'),
    tile(fmt(p.problems), 'Problems'),
  );
  body.appendChild(tiles);

  const meta = el('section', 'panel');
  const metaHead = el('div', 'panel-head');
  metaHead.appendChild(el('h2', null, 'Profile'));
  meta.appendChild(metaHead);
  const dl = el('div', 'bars');
  const line = (k, v) => {
    const row = el('div', 'bar-row');
    row.style.gridTemplateColumns = '108px 1fr';
    row.append(el('span', 'bar-name', k), el('span', 'mono', v));
    return row;
  };
  dl.append(
    line('Version', p.version || '—'),
    line('First seen', fmtWhen(p.first_seen)),
    line('Last seen', fmtWhen(p.last_seen)),
    line('Events', fmt(p.events)),
  );
  meta.appendChild(dl);
  body.appendChild(meta);

  if (data.languages.length) {
    const langs = el('section', 'panel');
    const head = el('div', 'panel-head');
    head.appendChild(el('h2', null, 'Languages'));
    langs.append(head, el('div', 'bars'));
    body.appendChild(langs);
    const holder = langs.querySelector('.bars');
    holder.id = 'drawerLangs';
    bars('drawerLangs', data.languages, { label: r => r.language, value: r => r.n });
  }

  const timeline = el('section', 'panel');
  const tlHead = el('div', 'panel-head');
  tlHead.appendChild(el('h2', null, 'Timeline'));
  tlHead.appendChild(el('span', 'panel-note', `${data.timeline.length} events`));
  timeline.appendChild(tlHead);

  const wrap = el('div', 'table-wrap');
  const table = el('table', 'table');
  const thead = el('thead');
  const hr = el('tr');
  for (const h of ['When', 'Event', 'Problem', 'Verdict', 'Runtime', 'Memory', 'Code']) {
    hr.appendChild(el('th', null, h));
  }
  thead.appendChild(hr);
  const tbody = el('tbody');

  if (!data.timeline.length) emptyRow(tbody, 7, 'Nothing recorded.');
  for (const row of data.timeline) {
    const tr = el('tr');
    tr.append(
      td(fmtWhen(row.ts)),
      td(row.event),
      td(row.title || row.slug),
      verdictCell(row.status),
      td(fmtMs(row.runtime_ms), 'num'),
      td(fmtKb(row.memory_kb), 'num'),
      codeCell(row),
    );
    tbody.appendChild(tr);
  }

  table.append(thead, tbody);
  wrap.appendChild(table);
  timeline.appendChild(wrap);
  body.appendChild(timeline);
}

function verdictCell(status) {
  const cell = el('td');
  if (!status) { cell.textContent = '—'; return cell; }
  const cls = status === 'Accepted' ? 'chip-ok' : 'chip-bad';
  cell.appendChild(el('span', `chip-mini ${cls}`, status));
  return cell;
}

/** "View" when source was shared, the size when it was not. */
function codeCell(row) {
  const cell = el('td');
  if (row.has_code) {
    const btn = el('button', 'chip', 'View');
    btn.addEventListener('click', (e) => { e.stopPropagation(); openCode(row.id); });
    cell.appendChild(btn);
  } else {
    cell.appendChild(el('span', 'mono', row.code_len ? fmtBytes(row.code_len) : '—'));
  }
  return cell;
}

$('drawerClose').addEventListener('click', () => { $('drawer').hidden = true; });
$('drawerScrim').addEventListener('click', () => { $('drawer').hidden = true; });

// ── Code viewer ──────────────────────────────────────────────

async function openCode(id) {
  $('codeModal').hidden = false;
  $('codeBody').textContent = 'Loading…';
  $('codeMeta').textContent = '';
  try {
    const row = await api(`/api/code?id=${encodeURIComponent(id)}`);
    $('codeTitle').textContent = row.title || row.slug || 'Solution';
    $('codeMeta').textContent =
      [row.language, row.status, fmtWhen(row.ts)].filter(Boolean).join(' · ');
    // textContent, so a solution containing markup renders as the text it is.
    $('codeBody').textContent = row.code || '';
  } catch (error) {
    $('codeBody').textContent = `Could not load this solution (${error.message}).`;
  }
}

$('codeCopy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('codeBody').textContent);
    $('codeCopy').textContent = 'Copied';
    setTimeout(() => { $('codeCopy').textContent = 'Copy'; }, 1200);
  } catch {
    $('codeCopy').textContent = 'Blocked';
    setTimeout(() => { $('codeCopy').textContent = 'Copy'; }, 1200);
  }
});

$('codeClose').addEventListener('click', () => { $('codeModal').hidden = true; });
$('codeScrim').addEventListener('click', () => { $('codeModal').hidden = true; });

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  // Topmost first, so one press does not close both layers.
  if (!$('codeModal').hidden) $('codeModal').hidden = true;
  else if (!$('drawer').hidden) $('drawer').hidden = true;
});

// ── Activity feed ────────────────────────────────────────────

function renderActivity(data) {
  feedRows = data.rows;
  $('feedNote').textContent =
    `${data.rows.length} event${data.rows.length === 1 ? '' : 's'}, newest first`;

  const kinds = [...new Set(feedRows.map(r => r.event))].sort();
  if (!kinds.includes(feedFilter)) feedFilter = 'all';

  const filters = $('feedFilters');
  filters.innerHTML = '';
  for (const kind of ['all', ...kinds]) {
    const chip = el('button', `chip${kind === feedFilter ? ' active' : ''}`, kind);
    chip.addEventListener('click', () => { feedFilter = kind; renderActivity(data); });
    filters.appendChild(chip);
  }

  const body = $('feedBody');
  body.innerHTML = '';
  const rows = feedFilter === 'all' ? feedRows : feedRows.filter(r => r.event === feedFilter);
  if (!rows.length) return emptyRow(body, 9, 'Nothing matches this filter.');

  for (const row of rows) {
    const tr = el('tr');

    const idCell = el('td', 'row-link');
    idCell.appendChild(el('span', 'mono', shortId(row.install_id)));
    idCell.title = row.install_id;
    idCell.addEventListener('click', () => openUser(row.install_id));

    tr.append(
      td(fmtWhen(row.ts)),
      idCell,
      td(row.event),
      td(row.title || row.slug),
      verdictCell(row.status),
      td(row.language),
      td(fmtMs(row.runtime_ms), 'num'),
      td(fmtKb(row.memory_kb), 'num'),
      td(row.detail),
    );
    body.appendChild(tr);
  }

  $('footNote').textContent =
    `Updated ${new Date(data.generatedAt).toLocaleString()} · last ${data.days} days`;
}

// ── Boot ─────────────────────────────────────────────────────

(async function init() {
  let stored = null;
  try { stored = localStorage.getItem(KEY_STORE); } catch { /* private mode */ }
  if (!stored) return;                       // show the gate

  try {
    const data = await api(`/api/summary?days=${days}`, stored);
    key = stored;
    unlock(data);
  } catch {
    // Stale or rejected key: fall back to the gate rather than a blank page.
    try { localStorage.removeItem(KEY_STORE); } catch { /* ignore */ }
  }
}());
