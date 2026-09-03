/* ============================================================
   dashboard.js — LeetSync Analytics, Modernist.

   Ported from the Claude Design project of the same name: the same tilt
   behaviour, the same layered chart and the same motion, rebuilt on plain
   DOM instead of the design runtime. Both of the design's 3D canvas stages
   were dropped at the author's request.

   One deliberate difference: the design shipped a sample-data generator so
   its preview had something to draw. That is not here. Every figure comes
   from the Worker, and an empty database reads as empty.

   Aggregation happens in SQL inside the Worker, so this only draws. Values
   that came back from the API go in through textContent — innerHTML is used
   only for markup this file authors itself.
   ============================================================ */

const ENDPOINT = 'https://leetsync-analytics.devsamant1744.workers.dev';
const KEY_STORE = 'leetsync.dashboardKey';
const THEME_STORE = 'leetsync.dashboardTheme';

/**
 * Paste the dashboard key here to skip the key screen — the page then
 * unlocks itself on load.
 *
 * Understand what that costs. The key is the ONLY thing between this page and
 * the whole dataset, and a key written here ships inside a file any visitor
 * can read with View Source. With it set, anyone who reaches the URL sees
 * every install, every problem and every shared solution.
 *
 * So only set it on a deployment that is itself protected. On Vercel that is
 * Project -> Settings -> Deployment Protection, which puts your own login in
 * front of the whole site; then this is convenience on top of real auth
 * rather than a replacement for it.
 *
 * Leave it '' to keep the key screen.
 */
const AUTO_KEY = '';

const $ = (id) => document.getElementById(id);
const fmt = (n) => Number(n || 0).toLocaleString();
const pct = (p, w) => (!w ? 0 : (p / w) * 100);
const pctText = (p, w) => (!w ? '—' : `${pct(p, w).toFixed(1)}%`);
const dash = (v) => (v === null || v === undefined || v === '' ? '—' : v);

let days = 30;
let key = null;
let view = 'overview';
let feedFilter = 'all';
let summaryData = null;
let feedAll = [];
let countRaf = 0;

const reduced = () =>
  window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// ── Formatting ───────────────────────────────────────────────

function fmtMs(ms) {
  const n = Number(ms);
  if (ms === null || ms === undefined || !Number.isFinite(n)) return '—';
  return n >= 1000 ? `${(n / 1000).toFixed(2)} s` : `${Math.round(n)} ms`;
}
function fmtKb(kb) {
  const n = Number(kb);
  if (kb === null || kb === undefined || !Number.isFinite(n)) return '—';
  if (n >= 1048576) return `${(n / 1048576).toFixed(1)} GB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} MB`;
  return `${Math.round(n)} KB`;
}
function fmtBytes(b) {
  const n = Number(b);
  if (b === null || b === undefined || !Number.isFinite(n)) return '—';
  return n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${Math.round(n)} B`;
}
const fmtWhen = (ts) => (ts ? new Date(ts).toLocaleString() : '—');
const fmtDay = (ts) => (ts ? new Date(ts).toLocaleDateString() : '—');
const shortId = (id) => (id ? String(id).slice(0, 8) : '—');

/** A UTC day string (YYYY-MM-DD) shown the way a reader expects to see it. */
function dayLabel(day) {
  const [y, m, d] = String(day).split('-').map(Number);
  if (!y || !m || !d) return String(day);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(undefined, {
    timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric',
  });
}

const VERDICT_TONE = {
  'Accepted': 'ok',
  'Wrong Answer': 'bad',
  'Runtime Error': 'bad',
  'Compile Error': 'bad',
  'Time Limit Exceeded': 'warn',
  'Memory Limit Exceeded': 'warn',
  'Output Limit Exceeded': 'warn',
};
const LEVEL_TONE = { Easy: 'ok', Medium: 'warn', Hard: 'bad' };
const DIFF_ORDER = { Easy: 0, Medium: 1, Hard: 2, Unknown: 3 };
const barColor = (tone) =>
  ({ ok: 'var(--ls-ac)', warn: 'var(--ls-ink3)', bad: 'var(--ls-ink)' }[tone] || 'var(--ls-ink)');

// ── DOM helpers ──────────────────────────────────────────────

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}
function td(text, className, label) {
  const cell = el('td', className, dash(text));
  if (label) cell.dataset.label = label;
  return cell;
}
function chip(text, tone) {
  return el('span', `chip chip-${tone || 'flat'}`, text);
}
function chipCell(text, tone, label) {
  const cell = el('td');
  if (label) cell.dataset.label = label;
  cell.appendChild(chip(dash(text), tone));
  return cell;
}
function rateCell(part, whole, label) {
  const cell = el('td');
  if (label) cell.dataset.label = label;
  if (!whole) { cell.textContent = '—'; return cell; }
  const wrap = el('span', 'rate');
  const track = el('span', 'rate-track');
  const fill = el('span', 'rate-fill');
  fill.style.width = `${Math.min(100, pct(part, whole))}%`;
  if (!reduced()) fill.style.animation = 'lsGrow .7s cubic-bezier(.2,.9,.2,1) both';
  track.appendChild(fill);
  wrap.append(track, el('span', 'rate-num', pctText(part, whole)));
  cell.appendChild(wrap);
  return cell;
}
function emptyRow(body, span, text) {
  const tr = el('tr');
  const cell = el('td', 'empty', text);
  cell.colSpan = span;
  tr.appendChild(cell);
  body.appendChild(tr);
}

/** Pointer-tracked tilt on the overview tiles. */
function bindTilt() {
  if (reduced()) return;
  document.querySelectorAll('[data-tilt]:not([data-tilt-bound])').forEach((n) => {
    n.dataset.tiltBound = '1';
    n.addEventListener('pointermove', (e) => {
      const r = n.getBoundingClientRect();
      const px = (e.clientX - r.left) / r.width - 0.5;
      const py = (e.clientY - r.top) / r.height - 0.5;
      n.style.transform = `perspective(700px) rotateY(${px * 11}deg) rotateX(${-py * 11}deg) translateZ(14px)`;
      n.style.transition = 'box-shadow .18s ease';
      n.style.boxShadow = 'calc(12px*var(--ls-d)) calc(12px*var(--ls-d)) 0 var(--ls-ac)';
      n.style.zIndex = '2';
    });
    n.addEventListener('pointerleave', () => {
      n.style.transition = 'transform .4s cubic-bezier(.2,.9,.2,1), box-shadow .3s ease';
      n.style.transform = 'none';
      n.style.boxShadow = '';
      n.style.zIndex = '';
    });
  });
}

// ── Theme ────────────────────────────────────────────────────

function applyTheme(name) {
  document.documentElement.dataset.lsTheme = name;
  try { localStorage.setItem(THEME_STORE, name); } catch { /* private mode */ }
}
try { applyTheme(localStorage.getItem(THEME_STORE) || 'light'); } catch { applyTheme('light'); }

$('themeBtn').addEventListener('click', () => {
  applyTheme(document.documentElement.dataset.lsTheme === 'light' ? 'dark' : 'light');
  // The chart bakes resolved colours into its SVG, so it has to be redrawn.
  if (summaryData) activityChart(summaryData.daily);
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

function unlock(data) {
  $('gate').hidden = true;
  $('app').hidden = false;
  renderSummary(data);
}

$('lockBtn').addEventListener('click', () => {
  try { localStorage.removeItem(KEY_STORE); } catch { /* ignore */ }
  if (AUTO_KEY) {
    // Reloading would unlock straight back off AUTO_KEY, so the button would
    // look broken. Say what actually has to change instead.
    $('footNote').textContent =
      'Auto-unlock is on — clear AUTO_KEY in dashboard.js to require the key.';
    return;
  }
  location.reload();
});

// ── Navigation ───────────────────────────────────────────────

const VIEWS = [['overview', 'Overview'], ['days', 'Days'], ['users', 'Users'], ['activity', 'Activity']];
const RANGES = [7, 30, 90, 365];

function buildNav() {
  const top = $('views');
  const bar = $('tabbar');
  top.innerHTML = '';
  bar.innerHTML = '';
  for (const [id, label] of VIEWS) {
    const on = id === view;

    const btn = el('button', on ? 'on' : '', label);
    btn.type = 'button';
    btn.setAttribute('role', 'tab');
    btn.setAttribute('aria-selected', on ? 'true' : 'false');
    btn.addEventListener('click', () => selectView(id));
    top.appendChild(btn);

    const tab = el('button', on ? 'on' : '');
    tab.type = 'button';
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', on ? 'true' : 'false');
    tab.append(el('span', 'dot'), document.createTextNode(label));
    tab.addEventListener('click', () => selectView(id));
    bar.appendChild(tab);
  }

  const seg = $('ranges');
  seg.innerHTML = '';
  for (const d of RANGES) {
    const btn = el('button', d === days ? 'on' : '', d === 365 ? '1y' : `${d}d`);
    btn.type = 'button';
    btn.addEventListener('click', () => { days = d; buildNav(); loadView(); });
    seg.appendChild(btn);
  }
}

function selectView(id) {
  view = id;
  buildNav();
  for (const [vid] of VIEWS) $(`view-${vid}`).hidden = vid !== id;
  // Re-running the entry animation makes the switch feel like a move.
  const active = $(`view-${id}`);
  active.style.animation = 'none';
  void active.offsetWidth;
  active.style.animation = '';
  loadView();
}

$('refreshBtn').addEventListener('click', loadView);

async function loadView() {
  $('refreshLabel').textContent = 'Loading…';
  try {
    if (view === 'overview') renderSummary(await api(`/api/summary?days=${days}`));
    else if (view === 'days') renderDays(await api(`/api/summary?days=${days}`));
    else if (view === 'users') renderUsers(await api(`/api/users?days=${days}`));
    else renderActivity(await api(`/api/activity?days=${days}&limit=500`));
  } catch (error) {
    $('footNote').textContent = `Refresh failed: ${error.message}`;
  } finally {
    $('refreshLabel').textContent = 'Refresh';
  }
}

// ── Isometric bars ───────────────────────────────────────────

function bars(host, rows, { label, value, tone } = {}) {
  const node = typeof host === 'string' ? $(host) : host;
  node.innerHTML = '';
  const list = (rows || []).slice(0, 8);
  if (!list.length) {
    node.appendChild(el('div', 'empty', 'Nothing recorded yet.'));
    return;
  }
  const max = Math.max(1, ...list.map((r) => Number(value(r)) || 0));
  for (const row of list) {
    const line = el('div', 'bar-row');

    const name = el('span', 'bar-name', dash(label(row)));
    name.title = String(dash(label(row)));

    const track = el('span', 'bar-track');
    const fill = el('span', 'bar-fill');
    fill.style.width = `${((Number(value(row)) || 0) / max) * 100}%`;
    fill.style.color = barColor(tone ? tone(row) : 'bad');
    if (!reduced()) fill.style.animation = 'lsGrow .8s cubic-bezier(.2,.9,.2,1) both';
    fill.append(el('span', 'face'), el('span', 'top'), el('span', 'side'));
    track.appendChild(fill);

    line.append(name, track, el('span', 'bar-value', fmt(value(row))));
    node.appendChild(line);
  }
}

// ── Layered activity chart ───────────────────────────────────
// Two surfaces offset by (DX, DY): events in front, accepted behind, with a
// ribbon between them and a capped right edge, so the series reads as a solid.

const SVG_NS = 'http://www.w3.org/2000/svg';
const svgEl = (tag, attrs) => {
  const node = document.createElementNS(SVG_NS, tag);
  for (const k in attrs) node.setAttribute(k, attrs[k]);
  return node;
};

function activityChart(daily) {
  const host = $('activityChart');
  host.innerHTML = '';
  if (!daily || !daily.length) {
    host.appendChild(el('div', 'empty', 'No activity in this range.'));
    return;
  }

  const W = 1080, H = 300, padL = 46, padR = 18, padT = 22, padB = 34;
  const DX = 26, DY = 20;
  const iw = W - padL - padR - DX, ih = H - padT - padB - DY;
  const max = Math.max(1, ...daily.map((d) => d.events));
  const step = daily.length > 1 ? iw / (daily.length - 1) : 0;
  const fx = (i) => padL + (daily.length > 1 ? i * step : iw / 2);
  const fy = (v) => padT + DY + ih - (v / max) * ih;
  const base = padT + DY + ih;

  const front = daily.map((d, i) => [fx(i), fy(d.events)]);
  const back = daily.map((d, i) => [fx(i) + DX, fy(d.accepted || 0) - DY]);
  const line = (pts) => pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');

  const svg = svgEl('svg', {
    viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Events per day',
    style: 'display:block;width:100%;height:auto',
  });

  for (let g = 0; g <= 3; g++) {
    const v = Math.round((max / 3) * g), gy = fy(v);
    svg.appendChild(svgEl('line', {
      x1: padL, y1: gy, x2: padL + iw, y2: gy,
      stroke: 'var(--ls-hair)', 'stroke-width': 1, 'stroke-dasharray': g ? '3 4' : '0',
    }));
    svg.appendChild(svgEl('line', {
      x1: padL + iw, y1: gy, x2: padL + iw + DX, y2: gy - DY,
      stroke: 'var(--ls-hair)', 'stroke-width': 1, 'stroke-dasharray': '3 4',
    }));
    const label = svgEl('text', {
      x: padL - 10, y: gy + 4, 'text-anchor': 'end',
      'font-size': 10, fill: 'var(--ls-ink3)', 'font-family': 'var(--ls-mono)',
    });
    label.textContent = String(v);
    svg.appendChild(label);
  }

  const anim = reduced() ? '' : 'animation:lsFade .7s ease both';
  const drawAnim = reduced() ? ''
    : 'stroke-dasharray:2600;animation:lsDraw 1.5s cubic-bezier(.3,.9,.2,1) both, lsFade .3s ease both';

  const lastF = front[front.length - 1], lastB = back[back.length - 1];

  svg.appendChild(svgEl('path', {
    d: `${line(back)} L${lastB[0].toFixed(1)},${(base - DY).toFixed(1)} L${back[0][0].toFixed(1)},${(base - DY).toFixed(1)} Z`,
    fill: 'var(--ls-track)', stroke: 'var(--ls-ink)', 'stroke-width': 1.5, style: anim,
  }));
  svg.appendChild(svgEl('path', {
    d: `${line(front)} ${line([...back].reverse()).replace('M', 'L')} Z`,
    fill: 'var(--ls-ac-3)', stroke: 'none', opacity: 0.85, style: anim,
  }));
  svg.appendChild(svgEl('path', {
    d: `${line(front)} L${lastF[0].toFixed(1)},${base.toFixed(1)} L${front[0][0].toFixed(1)},${base.toFixed(1)} Z`,
    fill: 'var(--ls-ac-2)', stroke: 'none', style: anim,
  }));
  svg.appendChild(svgEl('path', {
    d: `M${lastF[0].toFixed(1)},${lastF[1].toFixed(1)} L${lastB[0].toFixed(1)},${lastB[1].toFixed(1)} L${lastB[0].toFixed(1)},${(base - DY).toFixed(1)} L${lastF[0].toFixed(1)},${base.toFixed(1)} Z`,
    fill: 'var(--ls-ac-3)', stroke: 'var(--ls-ink)', 'stroke-width': 1.5, style: anim,
  }));
  svg.appendChild(svgEl('line', {
    x1: padL, y1: base, x2: padL + iw, y2: base, stroke: 'var(--ls-ink)', 'stroke-width': 2,
  }));
  svg.appendChild(svgEl('path', {
    d: line(front), fill: 'none', stroke: 'var(--ls-ac)', 'stroke-width': 2.6,
    'stroke-linejoin': 'round', 'stroke-linecap': 'round', style: drawAnim,
  }));
  svg.appendChild(svgEl('path', {
    d: line(back), fill: 'none', stroke: 'var(--ls-ink)', 'stroke-width': 1.8,
    'stroke-linejoin': 'round', 'stroke-linecap': 'round', style: drawAnim,
  }));

  daily.forEach((d, i) => {
    const dot = svgEl('circle', {
      cx: fx(i), cy: fy(d.events), r: 3.4, fill: 'var(--ls-g)',
      stroke: 'var(--ls-ink)', 'stroke-width': 1.6, style: `${anim};cursor:pointer`,
    });
    const title = svgEl('title');
    title.textContent = `${d.day}: ${fmt(d.events)} events · ${fmt(d.submissions || 0)} submissions · ${fmt(d.accepted || 0)} accepted`;
    dot.appendChild(title);
    // A point and a Days row are the same thing, so they open the same detail.
    dot.addEventListener('click', () => openDay(d.day));
    svg.appendChild(dot);
  });

  const marks = daily.length > 6
    ? [...new Set([0, Math.floor(daily.length / 3), Math.floor((daily.length * 2) / 3), daily.length - 1])]
    : daily.map((_, i) => i);
  for (const i of marks) {
    const label = svgEl('text', {
      x: fx(i), y: H - 10, 'font-size': 10, fill: 'var(--ls-ink3)', 'font-family': 'var(--ls-mono)',
      'text-anchor': i === 0 ? 'start' : i === daily.length - 1 ? 'end' : 'middle',
    });
    label.textContent = daily[i].day.slice(5);
    svg.appendChild(label);
  }

  host.appendChild(svg);
}

// ── Overview ─────────────────────────────────────────────────

function tileTargets(su) {
  if (!su) return {};
  const count = (name) => ((su.events || []).find((e) => e.event === name) || {}).n || 0;
  const subs = (su.statuses || []).reduce((a, s) => a + s.n, 0);
  const acc = ((su.statuses || []).find((s) => s.status === 'Accepted') || {}).n || 0;
  return {
    installs: su.totals.installs, subs, accept: pct(acc, subs),
    pushes: count('push_ok'), problems: (su.problems || []).length, failures: count('push_fail'),
  };
}

const TILE_DEFS = [
  ['installs', 'Active installs'], ['subs', 'Submissions'], ['accept', 'Acceptance rate'],
  ['pushes', 'Solutions pushed'], ['problems', 'Distinct problems'], ['failures', 'Failed pushes'],
];

function paintTiles(targets, counts) {
  const host = $('tiles');
  const maxTile = Math.max(1, ...TILE_DEFS.map(([k]) => targets[k] || 0));
  if (host.children.length !== TILE_DEFS.length) {
    host.innerHTML = '';
    for (const [, label] of TILE_DEFS) {
      const tile = el('div', 'tile');
      tile.dataset.tilt = '1';
      const spark = el('div', 'tile-spark');
      spark.appendChild(el('span'));
      tile.append(el('div', 'tile-corner'), el('div', 'tile-value'), spark, el('div', 'tile-label', label));
      host.appendChild(tile);
    }
    bindTilt();
  }
  TILE_DEFS.forEach(([k], i) => {
    const tile = host.children[i];
    const live = counts[k] === undefined ? targets[k] || 0 : counts[k];
    tile.querySelector('.tile-value').textContent = k === 'accept'
      ? (targets.subs ? `${live.toFixed(1)}%` : '—')
      : fmt(Math.round(live));
    tile.querySelector('.tile-spark span').style.width =
      `${k === 'accept' ? Math.min(100, targets.accept || 0) : ((targets[k] || 0) / maxTile) * 100}%`;
  });
}

/** Tiles count up from zero on load, easing out. */
function countUp(su) {
  const targets = tileTargets(su);
  if (reduced()) { paintTiles(targets, targets); return; }
  if (countRaf) cancelAnimationFrame(countRaf);
  const t0 = performance.now(), dur = 950;
  const step = (now) => {
    const p = Math.min(1, (now - t0) / dur);
    const e = 1 - Math.pow(1 - p, 3);
    const counts = {};
    for (const k in targets) counts[k] = targets[k] * e;
    paintTiles(targets, counts);
    if (p < 1) countRaf = requestAnimationFrame(step);
  };
  countRaf = requestAnimationFrame(step);
}

const PANELS = [
  ['Submission verdicts', '', 'statuses', (r) => r.status, (r) => r.n, (r) => VERDICT_TONE[r.status] || 'warn'],
  ['Theme in use', 'installs', 'themes', (r) => (r.theme === 'light' ? 'Modernist' : 'Signal'), (r) => r.installs, (r) => (r.theme === 'light' ? 'ok' : 'bad')],
  ['Feature usage', '', 'events', (r) => r.event, (r) => r.n, null],
  ['Languages', '', 'languages', (r) => r.language, (r) => r.n, null],
  ['Pushes by difficulty', '', 'difficulty', (r) => r.difficulty, (r) => r.n, (r) => LEVEL_TONE[r.difficulty]],
  ['Version adoption', 'installs', 'versions', (r) => r.version, (r) => r.installs, null],
  ['Push failures', '', 'failures', (r) => r.reason, (r) => r.n, () => 'bad'],
  ['Sheets opened', 'installs', 'sheets', (r) => r.sheet, (r) => r.installs, null],
];

function renderSummary(data) {
  summaryData = data;
  countUp(data);

  $('rangeNote').textContent = days === 365 ? 'Last 12 months' : `Last ${days} days`;
  const n = data.daily.length;
  $('activityNote').textContent = `${n} day${n === 1 ? '' : 's'} with activity`;
  activityChart(data.daily);

  const host = $('barPanels');
  host.innerHTML = '';
  for (const [title, note, field, label, value, tone] of PANELS) {
    const section = document.createElement('section');
    const head = el('div', 'section-head');
    head.style.marginBottom = '18px';
    head.append(el('h2', 'h-label', title), el('span', 'note', note));
    const holder = el('div', 'bars');
    section.append(head, holder);
    host.appendChild(section);
    bars(holder, data[field], { label, value, tone });
  }

  perfTable(data.perf);
  problemsTable(data.problems);

  $('footNote').textContent = `Updated ${fmtWhen(data.generatedAt)} · last ${data.days} days`;
}

function perfTable(rows) {
  const body = $('perfBody');
  body.innerHTML = '';
  if (!rows || !rows.length) return emptyRow(body, 5, 'No accepted solutions yet.');
  for (const row of [...rows].sort((a, b) =>
    (DIFF_ORDER[a.difficulty] ?? 9) - (DIFF_ORDER[b.difficulty] ?? 9))) {
    const tr = el('tr');
    const lvl = row.difficulty || 'Unknown';
    const level = el('td');
    level.dataset.span = '1';
    level.appendChild(chip(lvl, LEVEL_TONE[lvl]));
    tr.append(
      level,
      td(fmt(row.n), 'num', 'Accepted'),
      td(fmtMs(row.avg_runtime), 'num', 'Avg runtime'),
      td(fmtKb(row.avg_memory), 'num', 'Avg memory'),
      td(fmtBytes(row.avg_code_len), 'num', 'Avg code size'),
    );
    body.appendChild(tr);
  }
}

function problemsTable(rows) {
  const body = $('problemsBody');
  body.innerHTML = '';
  if (!rows || !rows.length) return emptyRow(body, 8, 'No submissions recorded yet.');
  rows.slice(0, 50).forEach((row, i) => {
    const tr = el('tr');

    const title = el('td');
    title.dataset.span = '1';
    const link = el('a', null, row.title || row.slug);
    link.href = `https://leetcode.com/problems/${encodeURIComponent(row.slug)}/`;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    title.appendChild(link);

    tr.append(
      td(i + 1, 'rank'),
      title,
      chipCell(row.difficulty || 'Unknown', LEVEL_TONE[row.difficulty], 'Level'),
      td(fmt(row.attempts), 'num', 'Attempts'),
      td(fmt(row.accepted), 'num', 'Accepted'),
      rateCell(row.accepted, row.attempts, 'Rate'),
      td(fmt(row.pushes), 'num', 'Pushes'),
      td(fmt(row.installs), 'num', 'Users'),
    );
    body.appendChild(tr);
  });
}

// ── Days ─────────────────────────────────────────────────────

function renderDays(data) {
  summaryData = data;
  const rows = [...data.daily].reverse();
  const body = $('daysBody');
  body.innerHTML = '';
  $('daysNote').textContent = rows.length
    ? `${rows.length} day${rows.length === 1 ? '' : 's'} · UTC · click a row`
    : 'UTC days';
  if (!rows.length) return emptyRow(body, 10, 'No activity in this range.');

  const peak = Math.max(1, ...rows.map((r) => r.events));
  for (const row of rows) {
    const tr = el('tr', 'row-link');
    tr.tabIndex = 0;

    const label = el('td');
    label.dataset.span = '1';
    label.appendChild(el('span', null, dayLabel(row.day)));
    label.title = row.day;

    const spark = el('td');
    const track = el('span', 'bar-track');
    track.style.minWidth = '90px';
    const fill = el('span', 'bar-fill');
    fill.style.width = `${(row.events / peak) * 100}%`;
    fill.style.color = 'var(--ls-ac)';
    fill.append(el('span', 'face'), el('span', 'top'), el('span', 'side'));
    track.appendChild(fill);
    spark.appendChild(track);

    tr.append(
      label, spark,
      td(fmt(row.installs), 'num', 'Installs'),
      td(fmt(row.events), 'num', 'Events'),
      td(fmt(row.submissions), 'num', 'Subs'),
      td(fmt(row.accepted), 'num', 'Accepted'),
      rateCell(row.accepted, row.submissions, 'Rate'),
      td(fmt(row.pushes), 'num', 'Pushes'),
      td(fmt(row.failures), 'num', 'Failed'),
      td(fmt(row.problems), 'num', 'Problems'),
    );

    const open = () => openDay(row.day);
    tr.addEventListener('click', open);
    tr.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
    });
    body.appendChild(tr);
  }

  $('footNote').textContent = `Updated ${fmtWhen(data.generatedAt)} · last ${data.days} days`;
}

// ── Users ────────────────────────────────────────────────────

function renderUsers(data) {
  const body = $('usersBody');
  body.innerHTML = '';
  $('usersNote').textContent =
    `${data.users.length} install${data.users.length === 1 ? '' : 's'} · click a row for detail`;
  if (!data.users.length) return emptyRow(body, 11, 'No installs have reported yet.');

  for (const u of data.users) {
    const tr = el('tr', 'row-link');
    tr.tabIndex = 0;

    const idCell = el('td', 'mono');
    idCell.dataset.span = '1';
    idCell.title = u.install_id;
    idCell.appendChild(el('span', 'id-link', shortId(u.install_id)));

    const themeName = u.theme === 'light' ? 'Modernist' : u.theme === 'dark' ? 'Signal' : '—';

    tr.append(
      idCell,
      chipCell(themeName, u.theme === 'light' ? 'ok' : 'flat', 'Theme'),
      td(dash(u.version), 'mono', 'Version'),
      td(fmt(u.submissions), 'num', 'Subs'),
      td(fmt(u.accepted), 'num', 'Accepted'),
      rateCell(u.accepted, u.submissions, 'Rate'),
      td(fmt(u.pushes), 'num', 'Pushes'),
      td(fmt(u.problems), 'num', 'Problems'),
      chipCell(u.code_shared ? fmt(u.code_shared) : 'off', u.code_shared ? 'ok' : 'flat', 'Code'),
      td(fmtDay(u.first_seen), 'soft', 'First seen'),
      td(fmtWhen(u.last_seen), 'soft', 'Last seen'),
    );

    const open = () => openUser(u.install_id);
    tr.addEventListener('click', open);
    tr.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
    });
    body.appendChild(tr);
  }

  $('footNote').textContent = `Updated ${fmtWhen(data.generatedAt)} · last ${data.days} days`;
}

// ── Activity feed ────────────────────────────────────────────

function renderActivity(data) {
  feedAll = data.rows;
  const kinds = [...new Set(feedAll.map((r) => r.event))].sort();
  if (!kinds.includes(feedFilter)) feedFilter = 'all';

  const filters = $('feedFilters');
  filters.innerHTML = '';
  for (const kind of ['all', ...kinds]) {
    const btn = el('button', `btn3d${kind === feedFilter ? ' on' : ''}`, kind);
    btn.type = 'button';
    btn.addEventListener('click', () => { feedFilter = kind; renderActivity(data); });
    filters.appendChild(btn);
  }

  const rows = feedFilter === 'all' ? feedAll : feedAll.filter((r) => r.event === feedFilter);
  $('feedNote').textContent = `${rows.length} event${rows.length === 1 ? '' : 's'}, newest first`;

  const body = $('feedBody');
  body.innerHTML = '';
  if (!rows.length) return emptyRow(body, 9, 'Nothing matches this filter.');

  for (const row of rows) {
    const tr = el('tr');

    const when = el('td', 'mono soft', fmtWhen(row.ts));
    when.dataset.span = '1';

    const idCell = el('td', 'mono row-link');
    idCell.dataset.label = 'Install';
    idCell.title = row.install_id;
    idCell.appendChild(el('span', 'id-link', shortId(row.install_id)));
    idCell.addEventListener('click', () => openUser(row.install_id));

    tr.append(
      when,
      idCell,
      chipCell(row.event, row.event === 'push_fail' ? 'bad' : row.event === 'push_ok' ? 'ok' : 'flat', 'Event'),
      td(dash(row.title || row.slug), null, 'Problem'),
      chipCell(dash(row.status), row.status ? VERDICT_TONE[row.status] || 'warn' : 'flat', 'Verdict'),
      td(dash(row.language), 'soft', 'Language'),
      td(fmtMs(row.runtime_ms), 'num', 'Runtime'),
      td(fmtKb(row.memory_kb), 'num', 'Memory'),
      td(dash(row.detail), 'soft', 'Detail'),
    );
    body.appendChild(tr);
  }

  $('footNote').textContent = `Updated ${fmtWhen(data.generatedAt)} · last ${data.days} days`;
}

// ── Drawer ───────────────────────────────────────────────────

function openDrawer(title, subtitle) {
  $('drawer').hidden = false;
  $('drawerTitle').textContent = title;
  $('drawerId').textContent = subtitle;
  const body = $('drawerBody');
  body.innerHTML = '';
  body.appendChild(el('div', 'empty', 'Loading…'));
  return body;
}

function drawerTiles(defs) {
  const wrap = el('div', 'drawer-tiles');
  for (const [value, label] of defs) {
    const tile = el('div', 'drawer-tile');
    tile.append(el('div', 'v', value), el('div', 'l', label));
    wrap.appendChild(tile);
  }
  return wrap;
}

function drawerSection(title, note) {
  const head = el('div', 'section-head');
  head.style.marginBottom = '12px';
  head.append(el('h3', null, title));
  if (note !== undefined && note !== null) head.appendChild(el('span', 'note', note));
  return head;
}

function drawerTable(headers, rows, buildRow, emptyText) {
  const wrap = el('div', 'tbl-wrap');
  const table = el('table', 'tbl cardtable');
  const thead = el('thead');
  const hr = el('tr');
  for (const h of headers) hr.appendChild(el('th', null, h));
  thead.appendChild(hr);
  const tbody = el('tbody');
  if (!rows.length) emptyRow(tbody, headers.length, emptyText);
  for (const row of rows) tbody.appendChild(buildRow(row));
  table.append(thead, tbody);
  wrap.appendChild(table);
  return wrap;
}

async function openUser(installId) {
  const body = openDrawer('Install', installId);
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

  body.appendChild(drawerTiles([
    [fmt(p.submissions), 'Submissions'],
    [pctText(p.accepted, p.submissions), 'Acceptance'],
    [fmt(p.pushes), 'Pushed'],
    [fmt(p.problems), 'Problems'],
  ]));

  body.appendChild(el('h3', null, 'Profile'));
  const kv = el('div', 'kv');
  for (const [k, v] of [
    ['Version', dash(p.version)], ['First seen', fmtWhen(p.first_seen)],
    ['Last seen', fmtWhen(p.last_seen)], ['Events', fmt(p.events)],
  ]) {
    const row = el('div', 'kv-row');
    row.append(el('span', 'k', k), el('span', 'v', v));
    kv.appendChild(row);
  }
  body.appendChild(kv);

  if (data.languages.length) {
    body.appendChild(el('h3', null, 'Languages'));
    const holder = el('div', 'bars');
    body.appendChild(holder);
    bars(holder, data.languages, { label: (r) => r.language, value: (r) => r.n });
  }

  body.appendChild(drawerSection('Timeline', `${data.timeline.length} events`));
  body.appendChild(drawerTable(
    ['When', 'Event', 'Problem', 'Verdict', 'Runtime', 'Memory', 'Code'],
    data.timeline,
    (row) => {
      const tr = el('tr');
      const when = el('td', 'mono soft', fmtWhen(row.ts));
      when.dataset.span = '1';

      const code = el('td');
      code.dataset.label = 'Code';
      if (row.has_code) {
        const btn = el('button', 'btn-view', 'View');
        btn.type = 'button';
        btn.addEventListener('click', (e) => { e.stopPropagation(); openCode(row.id); });
        code.appendChild(btn);
      } else {
        code.appendChild(el('span', 'mono', row.code_len ? fmtBytes(row.code_len) : '—'));
      }

      tr.append(
        when,
        chipCell(row.event, row.event === 'push_ok' ? 'ok' : 'flat', 'Event'),
        td(dash(row.title || row.slug), null, 'Problem'),
        chipCell(dash(row.status), row.status ? VERDICT_TONE[row.status] || 'warn' : 'flat', 'Verdict'),
        td(fmtMs(row.runtime_ms), 'num', 'Runtime'),
        td(fmtKb(row.memory_kb), 'num', 'Memory'),
        code,
      );
      return tr;
    },
    'Nothing recorded.'));
}

async function openDay(date) {
  const body = openDrawer(dayLabel(date), `${date} · UTC`);
  let data;
  try {
    data = await api(`/api/day?date=${encodeURIComponent(date)}`);
  } catch (error) {
    body.innerHTML = '';
    body.appendChild(el('div', 'empty', `Could not load this day (${error.message}).`));
    return;
  }

  body.innerHTML = '';
  const t = data.totals;

  body.appendChild(drawerTiles([
    [fmt(t.installs), 'Active installs'],
    [fmt(t.submissions), 'Submissions'],
    [pctText(t.accepted, t.submissions), 'Acceptance'],
    [fmt(t.pushes), 'Pushed'],
  ]));

  // Every hour is present, including the quiet ones, or gaps would read as
  // missing data rather than as nothing happening.
  const hours = [];
  for (let h = 0; h < 24; h++) {
    const k = String(h).padStart(2, '0');
    const found = data.hourly.find((r) => r.hour === k);
    hours.push({ hour: `${k}:00`, n: found ? found.n : 0 });
  }
  body.appendChild(drawerSection('By hour', 'UTC'));
  const hourHost = el('div', 'bars');
  body.appendChild(hourHost);
  bars(hourHost, hours.some((r) => r.n) ? hours : [], { label: (r) => r.hour, value: (r) => r.n });

  if (data.statuses.length) {
    body.appendChild(el('h3', null, 'Verdicts'));
    const host = el('div', 'bars');
    body.appendChild(host);
    bars(host, data.statuses, {
      label: (r) => r.status, value: (r) => r.n, tone: (r) => VERDICT_TONE[r.status] || 'warn',
    });
  }

  if (data.languages.length) {
    body.appendChild(el('h3', null, 'Languages'));
    const host = el('div', 'bars');
    body.appendChild(host);
    bars(host, data.languages, { label: (r) => r.language, value: (r) => r.n });
  }

  body.appendChild(drawerSection('Problems', String(data.problems.length)));
  body.appendChild(drawerTable(
    ['Problem', 'Level', 'Attempts', 'Accepted', 'Pushes'],
    data.problems,
    (row) => {
      const tr = el('tr');
      const name = el('td', null, row.title || row.slug);
      name.dataset.span = '1';
      tr.append(
        name,
        chipCell(row.difficulty || 'Unknown', LEVEL_TONE[row.difficulty], 'Level'),
        td(fmt(row.attempts), 'num', 'Attempts'),
        td(fmt(row.accepted), 'num', 'Accepted'),
        td(fmt(row.pushes), 'num', 'Pushes'),
      );
      return tr;
    },
    'No problems attempted.'));

  body.appendChild(drawerSection('Installs active', String(data.installs.length)));
  body.appendChild(drawerTable(
    ['Install', 'Events', 'Subs', 'Accepted', 'Pushes', 'First', 'Last'],
    data.installs,
    (row) => {
      const tr = el('tr', 'row-link');
      const idCell = el('td', 'mono');
      idCell.dataset.span = '1';
      idCell.title = row.install_id;
      idCell.appendChild(el('span', 'id-link', shortId(row.install_id)));
      tr.append(
        idCell,
        td(fmt(row.events), 'num', 'Events'),
        td(fmt(row.submissions), 'num', 'Subs'),
        td(fmt(row.accepted), 'num', 'Accepted'),
        td(fmt(row.pushes), 'num', 'Pushes'),
        td(new Date(row.first_ts).toLocaleTimeString(), 'soft', 'First'),
        td(new Date(row.last_ts).toLocaleTimeString(), 'soft', 'Last'),
      );
      tr.addEventListener('click', () => openUser(row.install_id));
      return tr;
    },
    'Nobody was active.'));
}

$('drawerClose').addEventListener('click', () => { $('drawer').hidden = true; });
$('drawerScrim').addEventListener('click', () => { $('drawer').hidden = true; });

// ── Code viewer ──────────────────────────────────────────────

async function openCode(id) {
  $('codeModal').hidden = false;
  $('codeBody').textContent = 'Loading…';
  $('codeMeta').textContent = '';
  $('codeCopy').textContent = 'Copy';
  try {
    const row = await api(`/api/code?id=${encodeURIComponent(id)}`);
    $('codeTitle').textContent = row.title || row.slug || 'Solution';
    $('codeMeta').textContent = [row.language, row.status, fmtWhen(row.ts)].filter(Boolean).join(' · ');
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
  } catch {
    $('codeCopy').textContent = 'Blocked';
  }
  setTimeout(() => { $('codeCopy').textContent = 'Copy'; }, 1200);
});

$('codeClose').addEventListener('click', () => { $('codeModal').hidden = true; });
$('codeScrim').addEventListener('click', () => { $('codeModal').hidden = true; });

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  // Topmost first, so one press does not close both layers.
  if (!$('codeModal').hidden) $('codeModal').hidden = true;
  else if (!$('drawer').hidden) $('drawer').hidden = true;
});

// ── Boot ─────────────────────────────────────────────────────

buildNav();

(async function init() {
  let stored = null;
  try { stored = localStorage.getItem(KEY_STORE); } catch { /* private mode */ }

  const candidate = AUTO_KEY || stored;
  if (!candidate) return;                    // show the gate

  try {
    const data = await api(`/api/summary?days=${days}`, candidate);
    key = candidate;
    unlock(data);
  } catch {
    // Stale or rejected key: fall back to the gate rather than a blank page.
    // Only a browser-stored key is cleared; AUTO_KEY lives in the source.
    try { localStorage.removeItem(KEY_STORE); } catch { /* ignore */ }
  }
}());
