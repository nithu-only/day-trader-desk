/* Day Trader Desk — frontend application */
'use strict';

/* ------------------------------------------------------------------ helpers */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const esc = (value) =>
  String(value === null || value === undefined ? '' : value).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));

const num = (value, digits = 2) => {
  const n = Number(value);
  if (value === null || value === undefined || value === '' || Number.isNaN(n)) return '—';
  return n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
};

const money = (value) => {
  const n = Number(value);
  if (value === null || value === undefined || value === '' || Number.isNaN(n)) return '—';
  return '$' + num(n, 2);
};

const pct = (value, digits = 1) => {
  const n = Number(value);
  if (value === null || value === undefined || value === '' || Number.isNaN(n)) return '—';
  return num(n, digits) + '%';
};

const bigMoney = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  if (abs >= 1e12) return '$' + num(n / 1e12, 2) + 'T';
  if (abs >= 1e9) return '$' + num(n / 1e9, 2) + 'B';
  if (abs >= 1e6) return '$' + num(n / 1e6, 2) + 'M';
  return money(n);
};

const clock12 = (minutes) => {
  const total = ((Math.round(minutes) % 1440) + 1440) % 1440;
  const h = Math.floor(total / 60);
  const m = total % 60;
  const suffix = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${suffix}`;
};

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const api = async (path, options = {}) => {
  const init = { method: options.method || 'GET', headers: {} };
  if (options.body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(options.body);
  }
  let response;
  try {
    response = await fetch(path, init);
  } catch (err) {
    throw new Error('Cannot reach the desk. Is the server running on 127.0.0.1:8000?');
  }
  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch (err) {
      data = { detail: text };
    }
  }
  if (!response.ok) {
    let detail = data && data.detail;
    if (Array.isArray(detail)) detail = detail.map((d) => d.msg || String(d)).join('; ');
    if (detail && typeof detail === 'object') detail = JSON.stringify(detail);
    const error = new Error(detail || `The request failed (HTTP ${response.status}).`);
    error.status = response.status;
    throw error;
  }
  return data;
};

const busy = (button, on, label) => {
  if (!button) return;
  if (on) {
    button.dataset.label = button.textContent;
    button.textContent = label || 'Working…';
    button.disabled = true;
  } else {
    button.textContent = button.dataset.label || button.textContent;
    button.disabled = false;
    delete button.dataset.label;
  }
};

const toast = (message, kind = 'info') => {
  const container = $('#toast-container');
  if (!container) return;
  const el = document.createElement('div');
  el.className = 'toast ' + (kind === 'error' ? 'error' : kind === 'success' ? 'success' : '');
  el.setAttribute('role', 'status');
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => el.remove(), 6000);
};

const errorText = (err) => (err && err.message ? err.message : 'Something went wrong.');

const showError = (el, message) => {
  if (!el) return;
  el.innerHTML = `<div class="form-error" role="alert">${esc(message)}</div>`;
};

/* ------------------------------------------------------------------ state */
const PAGES = [
  { id: 'scanner', label: 'Scanner', icon: '▦', group: 'Trade' },
  { id: 'news', label: 'News', icon: '☰', group: 'Trade' },
  { id: 'planner', label: 'Trade planner', icon: '◎', group: 'Trade' },
  { id: 'timemachine', label: 'Time Machine', icon: '⟲', group: 'Trade' },
  { id: 'size-risk', label: 'Size & risk', icon: '⚖', group: 'Trade' },
  { id: 'alerts', label: 'Alerts', icon: '◉', group: 'Desk' },
  { id: 'earnings', label: 'Earnings', icon: '▤', group: 'Research' },
  { id: 'congress', label: 'Congress trades', icon: '⌂', group: 'Research' },
  { id: 'settings', label: 'Settings', icon: '⚙', group: 'Desk' },
];

const PAGE_BY_ID = Object.fromEntries(PAGES.map((p) => [p.id, p]));

const state = {
  mode: 'demo',
  modeLocked: false,
  clock: null,
  settings: null,
  watchlist: [],
  scans: [],
  scansLoaded: false,
  news: null,
  newsLoaded: false,
  symbol: null,
  entry: null,
  entryCache: {},
  plan: null,
  simulation: null,
  simsLoaded: false,
  paletteIndex: 0,
  paletteItems: [],
};

/* ------------------------------------------------------------------ API */
const pageLoader = (id) => ({
  scanner: loadScanner,
  news: loadNews,
  planner: loadPlanner,
  timemachine: loadTimeMachine,
  'size-risk': loadSizeRisk,
  alerts: loadAlerts,
  earnings: loadEarnings,
  congress: loadCongress,
  settings: loadSettingsPage,
}[id]);

const guards = Object.create(null);

const guard = (name, fn) => {
  if (guards[name]) return guards[name];
  guards[name] = (async () => {
    try {
      return await fn();
    } finally {
      guards[name] = null;
    }
  })();
  return guards[name];
};

/* ------------------------------------------------------------------ ribbon */
const isUsDst = (year, month, day) => {
  const nthSunday = (y, m, n) => {
    const firstDow = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
    return 1 + ((7 - firstDow) % 7) + (n - 1) * 7;
  };
  const start = Date.UTC(year, 2, nthSunday(year, 3, 2));
  const end = Date.UTC(year, 10, nthSunday(year, 11, 1));
  const now = Date.UTC(year, month - 1, day);
  return now >= start && now < end;
};

const parseClock = (clock) => {
  const value = clock && clock.now_new_york ? String(clock.now_new_york) : '';
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  return { year, month, day, hour, minute, minutes: hour * 60 + minute };
};

const minutesOf = (hhmm) => {
  const m = String(hhmm || '').match(/^(\d{1,2}):(\d{2})$/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

const renderRibbon = () => {
  const statusEl = $('#ribbon-status');
  const istEl = $('#ribbon-time-ist');
  const nyEl = $('#ribbon-time-ny');
  const countdownEl = $('#ribbon-countdown');
  const modeEl = $('#ribbon-mode');
  const timeline = $('#ribbon-timeline');
  const clock = state.clock;

  modeEl.textContent = state.mode === 'live' ? 'Live' : 'Demo';
  modeEl.title = state.mode === 'live'
    ? 'Live mode: Yahoo, SEC and House Clerk data'
    : 'Demo mode: pinned to 2026-10-19 10:15 New York';

  if (!clock) {
    statusEl.textContent = '--';
    istEl.textContent = 'IST: --';
    nyEl.textContent = 'NY: --';
    countdownEl.textContent = 'Session clock unavailable';
    return;
  }

  const parsed = parseClock(clock);
  statusEl.textContent = clock.open ? 'Open' : 'Closed';
  statusEl.title = clock.reason || '';

  if (parsed) {
    nyEl.textContent = `NY: ${clock12(parsed.minutes)}`;
    const dst = isUsDst(parsed.year, parsed.month, parsed.day);
    const offset = dst ? 570 : 630; // IST is 9h30m ahead of EDT, 10h30m ahead of EST
    const totalIst = parsed.minutes + offset;
    const dayShift = Math.floor(totalIst / 1440);
    const weekday = WEEKDAYS[new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day + dayShift)).getUTCDay()];
    istEl.textContent = `IST: ${weekday} ${clock12(totalIst)}`;
  } else {
    nyEl.textContent = 'NY: --';
    istEl.textContent = 'IST: --';
  }

  const openMin = minutesOf(clock.opens || '09:30');
  const closeMin = minutesOf(clock.closes || '16:00');
  let progress = 0;
  if (parsed && openMin !== null && closeMin !== null && closeMin > openMin) {
    progress = Math.max(0, Math.min(100, ((parsed.minutes - openMin) / (closeMin - openMin)) * 100));
  }
  if (!clock.open && parsed && closeMin !== null && parsed.minutes >= closeMin) progress = 100;
  timeline.style.setProperty('--progress', progress.toFixed(1) + '%');
  timeline.setAttribute('aria-label', `US session progress ${Math.round(progress)} percent`);

  if (clock.open && parsed && closeMin !== null) {
    const left = closeMin - parsed.minutes;
    const h = Math.floor(left / 60);
    const m = left % 60;
    countdownEl.textContent = `Closes in ${h}h ${String(m).padStart(2, '0')}m`;
  } else {
    const next = String(clock.next_open || '').match(/(\d{1,2}:\d{2})/);
    countdownEl.textContent = next ? `Next open: ${clock12(minutesOf(next[1]))} ET` : 'Next open: —';
  }
};

const loadStatus = async () => {
  try {
    const status = await api('/api/status');
    state.mode = status.mode || 'demo';
    state.modeLocked = Boolean(status.mode_locked);
    state.clock = status.clock || null;
    renderRibbon();
    const chip = $('#mode-chip-text');
    const dot = $('#mode-dot');
    if (chip) chip.textContent = state.mode === 'live' ? 'Live mode' : 'Demo mode';
    if (dot) dot.classList.toggle('live', state.mode === 'live');
  } catch (err) {
    state.clock = null;
    renderRibbon();
    const countdown = $('#ribbon-countdown');
    if (countdown) countdown.textContent = 'Session clock unavailable';
  }
};

/* ------------------------------------------------------------------ nav */
const parseHash = () => {
  const raw = location.hash.replace(/^#\/?/, '');
  const [page, arg] = raw.split('/');
  if (!PAGE_BY_ID[page]) return { page: 'scanner', arg: '' };
  return { page, arg: arg ? decodeURIComponent(arg) : '' };
};

const navigate = (page, arg) => {
  const hash = '#' + page + (arg ? '/' + encodeURIComponent(arg) : '');
  if (location.hash === hash) {
    showPage(page, arg);
  } else {
    location.hash = hash;
  }
};

const renderNav = () => {
  const nav = $('#sidebar-nav');
  const groups = {};
  for (const page of PAGES) (groups[page.group] = groups[page.group] || []).push(page);
  nav.innerHTML = Object.entries(groups)
    .map(([group, items]) => `
      <div class="sidebar-group">
        <div class="sidebar-group-title">${esc(group)}</div>
        ${items.map((page) => `
          <button type="button" class="sidebar-item" data-nav="${page.id}" aria-current="false">
            <span aria-hidden="true">${page.icon}</span><span>${esc(page.label)}</span>
          </button>`).join('')}
      </div>`)
    .join('');
};

const renderMobileTabs = () => {
  const tabs = [
    [PAGE_BY_ID.scanner, 'Scanner'],
    [PAGE_BY_ID.planner, 'Planner'],
    [PAGE_BY_ID.news, 'News'],
    [PAGE_BY_ID.alerts, 'Alerts'],
  ];
  const nav = $('#mobile-tabs');
  nav.innerHTML = tabs.map(([page, short]) => `
      <button type="button" class="mobile-tab" data-nav="${page.id}" aria-current="false">
        <span class="tab-icon" aria-hidden="true">${page.icon}</span><span>${esc(short)}</span>
      </button>`).join('') + `
      <button type="button" class="mobile-tab" data-action="palette" aria-label="All pages">
        <span class="tab-icon" aria-hidden="true">⋯</span><span>More</span>
      </button>`;
};

const setActive = (pageId) => {
  $$('[data-nav]').forEach((el) => {
    const active = el.dataset.nav === pageId;
    el.classList.toggle('active', active);
    el.setAttribute('aria-current', active ? 'page' : 'false');
  });
  $$('.mobile-tab[data-action="palette"]').forEach((el) => {
    const extra = ['timemachine', 'size-risk', 'earnings', 'congress', 'settings'].includes(pageId);
    el.classList.toggle('active', extra);
  });
};

const showPage = (page, arg) => {
  const meta = PAGE_BY_ID[page] || PAGE_BY_ID.scanner;
  $$('.page').forEach((section) => { section.style.display = 'none'; });
  const section = $('#page-' + meta.id);
  if (section) section.style.display = '';

  $('#page-title').textContent = meta.label;
  $('#breadcrumbs').innerHTML = `
    <span>Desk</span><span class="crumb-div">/</span><span>${esc(meta.group)}</span>
    <span class="crumb-div">/</span><span>${esc(meta.label)}</span>`;
  document.title = `${meta.label} · Day Trader Desk`;
  setActive(meta.id);

  const loader = pageLoader(meta.id);
  if (loader) {
    Promise.resolve()
      .then(() => loader(arg))
      .catch((err) => {
        const target = section && section.firstElementChild;
        if (target) showError(target, errorText(err));
        else toast(errorText(err), 'error');
      });
  }
};

const route = () => {
  const { page, arg } = parseHash();
  showPage(page, arg);
};

/* ------------------------------------------------------------------ theme + palette */
const applyTheme = (theme) => {
  document.documentElement.dataset.theme = theme;
  const button = $('#btn-theme');
  if (button) {
    button.textContent = theme === 'light' ? '☀' : '◐';
    button.title = theme === 'light' ? 'Switch to dark theme' : 'Switch to light theme';
    button.setAttribute('aria-label', button.title);
  }
};

const initTheme = () => {
  let theme = 'dark';
  try {
    theme = localStorage.getItem('desk:theme') || 'dark';
  } catch (err) { /* storage may be unavailable */ }
  if (!['dark', 'light'].includes(theme)) theme = 'dark';
  applyTheme(theme);
};

const toggleTheme = () => {
  const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
  applyTheme(next);
  try { localStorage.setItem('desk:theme', next); } catch (err) { /* ignore */ }
};

const renderPalette = (filter = '') => {
  const term = filter.trim().toLowerCase();
  state.paletteItems = PAGES.filter((page) =>
    !term || page.label.toLowerCase().includes(term) || page.group.toLowerCase().includes(term));
  state.paletteIndex = Math.min(state.paletteIndex, Math.max(0, state.paletteItems.length - 1));
  const results = $('#command-results');
  if (!state.paletteItems.length) {
    results.innerHTML = '<div class="empty-state small"><p>No pages match that search.</p></div>';
    return;
  }
  results.innerHTML = state.paletteItems.map((page, index) => `
      <button type="button" class="command-result${index === state.paletteIndex ? ' active' : ''}"
              data-command="${page.id}" role="option" aria-selected="${index === state.paletteIndex}">
        <span>${esc(page.label)}</span><kbd>${esc(page.group)}</kbd>
      </button>`).join('');
};

const openPalette = () => {
  const palette = $('#command-palette');
  palette.style.display = 'flex';
  const input = $('#command-input');
  input.value = '';
  state.paletteIndex = 0;
  renderPalette('');
  input.focus();
};

const closePalette = () => {
  $('#command-palette').style.display = 'none';
};

const choosePalette = () => {
  const item = state.paletteItems[state.paletteIndex];
  if (!item) return;
  closePalette();
  navigate(item.id);
};

/* ------------------------------------------------------------------ scanner */
const setupChips = (setups) => (setups || [])
  .map((setup) => `<span class="setup-chip ${esc(setup)}">${esc(String(setup).replace(/_/g, ' '))}</span>`)
  .join(' ');

const rangeChart = (low, high, price) => {
  const pad = Math.max((high - low) * 0.25, 0.5);
  const min = Math.min(low, price) - pad;
  const max = Math.max(high, price) + pad;
  const x = (v) => 20 + ((v - min) / (max - min || 1)) * 240;
  const marker = x(price);
  return `
    <svg viewBox="0 0 280 96" role="img" aria-label="Opening range ${num(low)} to ${num(high)}, price ${num(price)}">
      <line x1="${x(low)}" y1="44" x2="${x(high)}" y2="44" stroke="var(--border)" stroke-width="10" stroke-linecap="round"/>
      <line x1="${x(low)}" y1="38" x2="${x(low)}" y2="50" stroke="var(--text-muted)" stroke-width="2"/>
      <line x1="${x(high)}" y1="38" x2="${x(high)}" y2="50" stroke="var(--text-muted)" stroke-width="2"/>
      <line x1="${marker}" y1="26" x2="${marker}" y2="62" stroke="var(--gain)" stroke-width="3"/>
      <circle cx="${marker}" cy="44" r="5" fill="var(--gain)"/>
      <text x="20" y="76" text-anchor="start" font-size="11" fill="var(--text-muted)">low ${num(low)}</text>
      <text x="260" y="76" text-anchor="end" font-size="11" fill="var(--text-muted)">high ${num(high)}</text>
      <text x="${marker}" y="20" text-anchor="middle" font-size="11" fill="var(--gain)">${num(price)}</text>
      <text x="20" y="92" font-size="10" fill="var(--text-muted)">opening range — trigger price in green</text>
    </svg>`;
};

const rsiChart = (rsi) => {
  const x = (v) => 20 + (Math.max(0, Math.min(100, v)) / 100) * 240;
  const color = rsi >= 70 ? 'var(--gain)' : rsi <= 30 ? 'var(--loss)' : 'var(--amber)';
  return `
    <svg viewBox="0 0 280 96" role="img" aria-label="RSI ${num(rsi)}">
      <line x1="20" y1="48" x2="260" y2="48" stroke="var(--border)" stroke-width="8" stroke-linecap="round"/>
      <line x1="${x(30)}" y1="40" x2="${x(30)}" y2="56" stroke="var(--loss)" stroke-width="2"/>
      <line x1="${x(70)}" y1="40" x2="${x(70)}" y2="56" stroke="var(--gain)" stroke-width="2"/>
      <circle cx="${x(rsi)}" cy="48" r="7" fill="${color}"/>
      <text x="20" y="76" font-size="11" fill="var(--text-muted)">0</text>
      <text x="${x(30)}" y="76" text-anchor="middle" font-size="11" fill="var(--loss)">30</text>
      <text x="${x(70)}" y="76" text-anchor="middle" font-size="11" fill="var(--gain)">70</text>
      <text x="260" y="76" text-anchor="end" font-size="11" fill="var(--text-muted)">100</text>
      <text x="20" y="92" font-size="10" fill="var(--text-muted)">RSI ${num(rsi)}</text>
    </svg>`;
};

const renderScannerDetail = (hit, mode) => {
  const wrap = $('#mini-chart');
  if (!wrap) return;
  const facts = [];
  if (mode === 'orb') {
    facts.push(['Symbol', hit.symbol], ['Setup', (hit.setups || []).join(', ') || 'orb']);
    facts.push(['Opening range', `${num(hit.or_low)} – ${num(hit.or_high)}`]);
    facts.push(['Trigger price', money(hit.price)]);
    facts.push(['Triggered at', hit.at || hit.bar_start || '—']);
    facts.push(['Above the high', pct(hit.pct_over, 2)]);
    wrap.innerHTML = `
      ${rangeChart(Number(hit.or_low), Number(hit.or_high), Number(hit.price))}
      <dl>${facts.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>`;
  } else {
    facts.push(['Symbol', hit.symbol], ['Setup', (hit.setups || []).join(', ') || 'daily']);
    facts.push(['Close', money(hit.price)], ['RSI', num(hit.rsi, 1)]);
    facts.push(['Volume', Number(hit.volume || 0).toLocaleString('en-US')]);
    facts.push(['Close date', hit.close_date || '—']);
    wrap.innerHTML = `
      ${rsiChart(Number(hit.rsi || 0))}
      <dl>${facts.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>`;
  }
  $$('#scanner-tbody tr').forEach((tr) => tr.classList.toggle('selected', tr.dataset.symbol === hit.symbol));
};

const renderScanner = () => {
  const scan = state.scans[0];
  const tbody = $('#scanner-tbody');
  const empty = $('#scanner-empty');
  const wrap = $('.scanner-table-wrap');

  if (!scan || !(scan.hits || []).length) {
    tbody.innerHTML = '';
    empty.style.display = '';
    wrap.classList.add('is-empty');
    $('#mini-chart').textContent = 'Select a symbol from the table';
    return;
  }

  empty.style.display = 'none';
  wrap.classList.remove('is-empty');
  const mode = scan.mode;
  const isOrbScan = mode === 'orb';
  const head = $('#scanner-table thead tr');
  if (head) {
    head.innerHTML = isOrbScan
      ? '<th>Symbol</th><th>Setup</th><th>Price</th><th>Over</th><th>At</th><th>Action</th>'
      : '<th>Symbol</th><th>Setup</th><th>Price</th><th>RSI</th><th>Close date</th><th>Action</th>';
  }
  const watching = new Set(state.watchlist.map((row) => row.symbol));
  tbody.innerHTML = (scan.hits || []).map((hit) => {
    const isOrb = mode === 'orb';
    const third = isOrb ? pct(hit.pct_over, 2) : num(hit.rsi, 1);
    const fourth = isOrb ? (hit.at || '—') : (hit.close_date || '—');
    return `
      <tr data-symbol="${esc(hit.symbol)}">
        <td><button type="button" class="symbol-btn" data-detail="${esc(hit.symbol)}">${esc(hit.symbol)}</button></td>
        <td>${setupChips(hit.setups)}</td>
        <td class="num">${money(hit.price)}</td>
        <td class="num">${third}</td>
        <td>${esc(fourth)}</td>
        <td><div class="row-actions">
          <button type="button" class="btn btn-small" data-plan="${esc(hit.symbol)}">Plan</button>
          <button type="button" class="btn btn-small" data-watch="${esc(hit.symbol)}"
                  ${watching.has(hit.symbol) ? 'disabled' : ''}>${watching.has(hit.symbol) ? 'Watching' : 'Watch'}</button>
        </div></td>
      </tr>`;
  }).join('');

  const note = $('#scanner-meta');
  if (note) {
    note.textContent = `${mode === 'orb' ? 'Opening-range' : 'Daily'} scan · ${scan.as_of || 'no timestamp'} · ${scan.hits.length} hit${scan.hits.length === 1 ? '' : 's'}`;
  }

  const first = scan.hits.find((h) => h.symbol === state.symbol) || scan.hits[0];
  if (first) renderScannerDetail(first, mode);
};

const loadScanner = () => guard('scanner', async () => {
  if (!state.scansLoaded) {
    const empty = $('#scanner-empty');
    if (empty) empty.innerHTML = '<p class="loading-state">Loading the last scans…</p>';
    try {
      const scans = await api('/api/scans');
      state.scans = Array.isArray(scans) ? scans : [];
      state.scansLoaded = true;
    } catch (err) {
      if (empty) showError(empty, errorText(err));
      return;
    }
  }
  renderScanner();
});

const runScan = async (kind, button) => {
  busy(button, true, kind === 'orb' ? 'Scanning…' : 'Scanning…');
  try {
    const result = await api(`/api/scan/${kind}`, { method: 'POST', body: {} });
    state.scans.unshift({
      mode: result.mode || kind,
      as_of: result.as_of,
      hits: result.hits || [],
      counts: result.counts || {},
      created_at: result.created_at,
    });
    state.scansLoaded = true;
    state.newsLoaded = false;
    renderScanner();
    const count = (result.hits || []).length;
    toast(`${kind === 'orb' ? 'Opening-range' : 'Daily'} scan finished: ${count} hit${count === 1 ? '' : 's'}.`, 'success');
  } catch (err) {
    toast(errorText(err), 'error');
  } finally {
    busy(button, false);
  }
};

const addWatch = async (symbol, button) => {
  busy(button, true, 'Adding…');
  try {
    await api('/api/watchlist', { method: 'POST', body: { symbol } });
    await loadWatchlist();
    state.newsLoaded = false;
    renderScanner();
    toast(`${symbol} added to the watchlist.`, 'success');
  } catch (err) {
    toast(errorText(err), 'error');
  } finally {
    busy(button, false);
  }
};

const loadWatchlist = async () => {
  try {
    const rows = await api('/api/watchlist');
    state.watchlist = Array.isArray(rows) ? rows : [];
  } catch (err) {
    state.watchlist = [];
  }
};

/* ------------------------------------------------------------------ news */
const formatNewsTime = (value) => {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('en-US', {
    timeZone: 'America/New_York', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  }) + ' ET';
};

const renderNews = () => {
  const feed = $('#news-feed');
  const empty = $('#news-empty');
  const data = state.news;
  const source = $('#news-source');

  if (!data) {
    feed.innerHTML = '';
    empty.style.display = '';
    source.textContent = '';
    return;
  }

  const items = data.items || [];
  const moves = data.moves || [];
  const notes = data.notes || [];
  const tickers = data.tickers || [];
  source.textContent = data.checked
    ? `Checked ${formatNewsTime(data.checked)}${tickers.length ? ' · ' + tickers.join(', ') : ''}`
    : '';

  if (!items.length && !moves.length) {
    feed.innerHTML = '';
    empty.style.display = '';
    empty.innerHTML = `<p>${notes.length ? esc(notes[0]) : 'No headlines in this window. Run a scan or add a ticker to the watchlist, then check again.'}</p>`;
    return;
  }

  empty.style.display = 'none';
  const movesHtml = moves.length ? `
    <div class="news-section card">
      <h4>Movers</h4>
      <div class="table-scroll">
        <table class="data-table small">
          <thead><tr><th>Ticker</th><th>Price</th><th>Change</th><th>As of</th></tr></thead>
          <tbody>${moves.map((move) => `
            <tr>
              <td>${esc(move.ticker)}</td>
              <td class="num">${money(move.price)}</td>
              <td class="num ${Number(move.pct) >= 0 ? 'pos' : 'neg'}">${Number(move.pct) >= 0 ? '+' : ''}${pct(move.pct, 2)}</td>
              <td>${esc(formatNewsTime(move.time))}</td>
            </tr>`).join('')}</tbody>
        </table>
      </div>
    </div>` : '';

  const itemsHtml = items.length ? `
    <div class="news-section card">
      <h4>Headlines</h4>
      ${items.map((item) => `
        <article class="news-item">
          <div class="news-meta">${esc(item.source || 'News')} · ${esc(formatNewsTime(item.time))}${item.ticker ? ' · ' + esc(item.ticker) : ''}</div>
          <div class="news-title">
            ${item.link
              ? `<a href="${esc(item.link)}" target="_blank" rel="noopener noreferrer">${esc(item.title)}</a>`
              : esc(item.title)}
          </div>
          ${item.summary ? `<p class="news-summary">${esc(item.summary)}</p>` : ''}
          ${(item.touches || []).length ? `<div class="news-tags">${item.touches.map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div>` : ''}
        </article>`).join('')}
    </div>` : '';

  feed.innerHTML = movesHtml + itemsHtml + (notes.length
    ? `<div class="notes-list">${notes.map((note) => `<div>${esc(note)}</div>`).join('')}</div>`
    : '');
};

const loadNews = async () => {
  const empty = $('#news-empty');
  if (state.newsLoaded) {
    renderNews();
    return;
  }
  const feed = $('#news-feed');
  feed.innerHTML = '<p class="loading-state">Checking headlines…</p>';
  empty.style.display = 'none';
  try {
    state.news = await api('/api/news', { method: 'POST', body: {} });
    state.newsLoaded = true;
  } catch (err) {
    state.news = null;
    feed.innerHTML = '';
    empty.style.display = '';
    showError(empty, errorText(err));
    return;
  }
  renderNews();
};

/* ------------------------------------------------------------------ charts */
const levelChart = (plan, orHigh, orLow) => {
  if (!plan) return '<div class="empty-state small"><p>No plan yet.</p></div>';
  const values = [Number(plan.entry), Number(plan.stop), Number(plan.target)];
  if (Number.isFinite(Number(orHigh))) values.push(Number(orHigh));
  if (Number.isFinite(Number(orLow))) values.push(Number(orLow));
  const minV = Math.min(...values);
  const maxV = Math.max(...values);
  const pad = Math.max((maxV - minV) * 0.18, 0.4);
  const lo = minV - pad;
  const hi = maxV + pad;
  const y = (v) => 24 + (1 - (v - lo) / (hi - lo || 1)) * 190;
  const entryY = y(Number(plan.entry));
  const stopY = y(Number(plan.stop));
  const targetY = y(Number(plan.target));

  const line = (value, label, color, dash = '') => `
    <line x1="58" y1="${y(value)}" x2="500" y2="${y(value)}" stroke="${color}" stroke-width="2" ${dash}/>
    <text x="504" y="${y(value) + 5}" font-size="15" fill="${color}">${esc(label)}</text>`;

  const orLine = (value, label) => (Number.isFinite(value) ? `
    <line x1="58" y1="${y(value)}" x2="500" y2="${y(value)}" stroke="var(--text-muted)" stroke-width="1" stroke-dasharray="3 5"/>
    <text x="504" y="${y(value) + 5}" font-size="13" fill="var(--text-muted)">${esc(label)}</text>` : '');

  return `
    <svg viewBox="0 0 600 250" role="img" aria-label="Plan levels: entry ${num(plan.entry)}, stop ${num(plan.stop)}, target ${num(plan.target)}">
      <rect x="58" y="${targetY}" width="442" height="${Math.max(0, entryY - targetY)}" fill="var(--gain)" opacity="0.12"/>
      <rect x="58" y="${entryY}" width="442" height="${Math.max(0, stopY - entryY)}" fill="var(--loss)" opacity="0.12"/>
      ${orLine(Number(orHigh), 'OR high')}
      ${orLine(Number(orLow), 'OR low')}
      ${line(Number(plan.entry), 'entry ' + num(plan.entry), 'var(--text)')}
      ${line(Number(plan.stop), 'stop ' + num(plan.stop), 'var(--loss)', 'stroke-dasharray="6 4"')}
      ${line(Number(plan.target), 'target ' + num(plan.target), 'var(--gain)', 'stroke-dasharray="6 4"')}
      <line x1="58" y1="24" x2="58" y2="214" stroke="var(--border)"/>
      <text x="58" y="240" font-size="15" fill="var(--text-muted)">risk ${money(plan.risk_per_share)} / share · reward:risk ${num(plan.reward_risk, 2)}</text>
    </svg>`;
};

const fanChart = (sim) => {
  const mc = (sim && sim.mc) || {};
  const bands = Array.isArray(mc.bands) ? mc.bands : [];
  const plan = (sim && sim.plan) || {};
  if (!bands.length) return '<div class="empty-state small"><p>No fan chart data in this run.</p></div>';
  const all = bands.flat();
  const stop = Number(plan.stop);
  const target = Number(plan.target);
  if (Number.isFinite(stop)) all.push(stop);
  if (Number.isFinite(target)) all.push(target);
  const min = Math.min(...all);
  const max = Math.max(...all);
  const pad = Math.max((max - min) * 0.08, 0.2);
  const lo = min - pad;
  const hi = max + pad;
  const x = (i) => 44 + (i / Math.max(1, bands.length - 1)) * 506;
  const y = (v) => 22 + (1 - (v - lo) / (hi - lo || 1)) * 198;
  const path = (index) => bands.map((band, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(band[index]).toFixed(1)}`).join(' ');
  const area = (lower, upper) => {
    const top = bands.map((band, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(band[upper]).toFixed(1)}`).join(' ');
    const bottom = bands.slice().reverse().map((band, i) => {
      const index = bands.length - 1 - i;
      return `L${x(index).toFixed(1)} ${y(band[lower]).toFixed(1)}`;
    }).join(' ');
    return `${top} ${bottom} Z`;
  };
  const refLine = (value, label, color) => Number.isFinite(value) ? `
    <line x1="44" y1="${y(value)}" x2="550" y2="${y(value)}" stroke="${color}" stroke-width="1.5" stroke-dasharray="5 4"/>
    <text x="554" y="${y(value) + 5}" font-size="14" fill="${color}">${esc(label)}</text>` : '';

  return `
    <svg viewBox="0 0 600 250" role="img" aria-label="Simulated price paths from entry">
      <path d="${area(0, 4)}" fill="var(--gain)" opacity="0.14"/>
      <path d="${area(1, 3)}" fill="var(--gain)" opacity="0.22"/>
      <path d="${path(2)}" fill="none" stroke="var(--gain)" stroke-width="2"/>
      ${refLine(Number(plan.entry), 'entry', 'var(--text-muted)')}
      ${refLine(stop, 'stop', 'var(--loss)')}
      ${refLine(target, 'target', 'var(--gain)')}
      <line x1="44" y1="22" x2="44" y2="220" stroke="var(--border)"/>
      <text x="44" y="244" font-size="13" fill="var(--text-muted)">${esc(Number(mc.replays || 0).toLocaleString('en-US'))} replays · seed ${esc(mc.seed)} · median close ${money(Number(mc.median_close))}</text>
      <text x="550" y="244" text-anchor="end" font-size="12" fill="var(--text-muted)">dark band 25–75% · light band 5–95%</text>
    </svg>`;
};

/* ------------------------------------------------------------------ planner */
const renderStepper = () => {
  const step = !state.symbol ? 1 : state.plan && state.plan.symbol === state.symbol ? (state.simulation ? 4 : 3) : 2;
  const steps = [
    { n: 1, label: 'Scan', page: 'scanner' },
    { n: 2, label: 'Entry', page: 'planner' },
    { n: 3, label: 'Plan', page: 'planner' },
    { n: 4, label: 'Simulate', page: 'timemachine' },
  ];
  $('#planner-stepper').innerHTML = steps.map((item) => {
    const cls = item.n === step ? 'active' : item.n < step ? 'done' : '';
    return `<button type="button" class="stepper-step ${cls}" data-step="${item.page}"
      data-step-arg="${item.page === 'planner' && state.symbol ? esc(state.symbol) : ''}"
      ${item.n > step ? 'disabled' : ''}>${item.n}. ${item.label}</button>`;
  }).join('');
};

const renderEntry = (entry) => {
  const card = $('#entry-status-card');
  if (!entry) {
    card.innerHTML = '<p class="empty-state small">Pick a ticker from the Scanner and run its entry check.</p>';
    return;
  }
  const status = String(entry.status || 'unknown');
  const cls = status === 'triggered' ? 'pass' : status === 'waiting' ? 'warn' : '';
  const or = entry.opening_range || {};
  const trigger = entry.trigger || {};
  const forming = entry.forming || {};
  card.innerHTML = `
    <div class="entry-head">
      <div>
        <div class="entry-symbol">${esc(entry.symbol)} <span class="tag">${esc(entry.setup || 'orb')}</span></div>
        <div class="entry-reason">${esc(entry.reason || '')}</div>
      </div>
      <span class="status-chip ${cls}">${esc(status.replace(/_/g, ' '))}</span>
    </div>
    <dl class="kv">
      <dt>Opening range</dt><dd>${num(or.low)} – ${num(or.high)}${or.complete ? '' : ' (still forming)'}</dd>
      <dt>Trigger</dt><dd>${trigger.price ? money(trigger.price) + ' at ' + esc(trigger.time || '') : '—'}</dd>
      <dt>Last close</dt><dd>${entry.last ? money(entry.last.close) + ' (' + (entry.last.bar_start || '') + ')' : '—'}</dd>
      <dt>Forming bar</dt><dd>${forming.price ? money(forming.price) + ' closes ' + esc(forming.closes || '') : '—'}</dd>
      <dt>Data time</dt><dd>${esc(entry.data_time || entry.now || '—')}</dd>
    </dl>`;
};

const renderPlan = (plan) => {
  const card = $('#plan-summary');
  if (!plan) {
    card.innerHTML = '';
    return;
  }
  card.innerHTML = `
    <div class="plan-summary">
      <div class="plan-head">
        <strong>${esc(plan.symbol)}</strong>
        <span class="tag">${esc(plan.stop_label || plan.stop_rule || '')}</span>
      </div>
      <dl class="kv">
        <dt>Entry</dt><dd>${money(plan.entry)}</dd>
        <dt>Stop</dt><dd class="neg">${money(plan.stop)}</dd>
        <dt>Target</dt><dd class="pos">${money(plan.target)} (${esc(plan.target_label || '')})</dd>
        <dt>Risk / share</dt><dd>${money(plan.risk_per_share)}</dd>
        <dt>Reward : risk</dt><dd>${num(plan.reward_risk, 2)}</dd>
        <dt>Flat by</dt><dd>${esc(plan.flat_by || '—')} ET</dd>
      </dl>
      <div class="plan-actions">
        <button type="button" class="btn btn-small" data-plan-to="timemachine">Simulate this plan</button>
        <button type="button" class="btn btn-small" data-plan-to="size-risk">Size it</button>
        <button type="button" class="btn btn-small" data-plan-to="alerts">Create alerts</button>
      </div>
    </div>`;
  $('#price-chart').innerHTML = levelChart(plan, plan.opening_range && plan.opening_range.high, plan.opening_range && plan.opening_range.low);
};

const loadPlanner = (arg) => guard('planner', async () => {
  const symbol = (arg || state.symbol || '').toUpperCase();
  state.symbol = symbol || null;
  if (arg) state.entry = state.entryCache[symbol] || null;

  if (!symbol) {
    $('#entry-status-card').innerHTML = `
      <p class="empty-state small">Pick a ticker from the <button type="button" class="link-btn" data-go="scanner">Scanner</button> and click <strong>Plan</strong>.</p>`;
    $('#price-chart').innerHTML = '<div class="empty-state small"><p>No levels to draw yet.</p></div>';
    $('#plan-summary').innerHTML = '';
    renderStepper();
    return;
  }

  $('#entry-status-card').innerHTML = '<p class="loading-state">Checking the entry…</p>';
  renderStepper();

  let entry = state.entryCache[symbol];
  if (!entry) {
    try {
      entry = await api('/api/entry/check', { method: 'POST', body: { symbol } });
      state.entryCache[symbol] = entry;
    } catch (err) {
      renderEntry(null);
      $('#entry-status-card').innerHTML = `<div class="form-error" role="alert">${esc(errorText(err))}</div>
        <p class="empty-state small">Return to the <button type="button" class="link-btn" data-go="scanner">Scanner</button> and pick another ticker.</p>`;
      renderStepper();
      return;
    }
  }
  state.entry = entry;
  renderEntry(entry);

  const trigger = (entry && entry.trigger) || {};
  const last = (entry && entry.last) || {};
  const or = (entry && entry.opening_range) || {};
  const entryPrice = trigger.price || last.close || entry.prev_close;
  $('#plan-entry').value = entryPrice != null ? Number(entryPrice).toFixed(2) : '';
  $('#plan-or-high').value = or.high != null ? Number(or.high).toFixed(2) : '';
  $('#plan-or-low').value = or.low != null ? Number(or.low).toFixed(2) : '';

  if (state.plan && state.plan.symbol === symbol) {
    renderPlan(state.plan);
    if (state.plan.entry != null) $('#plan-entry').value = Number(state.plan.entry).toFixed(2);
    const targetSelect = $('#plan-target');
    const targetR = Number(state.plan.target_r);
    if (Number.isFinite(targetR)) {
      const option = `${targetR}R`;
      if (Array.from(targetSelect.options).some((opt) => opt.value === option)) {
        targetSelect.value = option;
      }
    }
    const ruleSelect = $('#plan-stop-rule');
    const ruleMap = { or_mid: 'or-mid', or_low: 'or-low', pct: 'pct' };
    const mapped = ruleMap[state.plan.stop_rule];
    if (mapped) {
      ruleSelect.value = mapped;
      ruleSelect.dispatchEvent(new Event('change'));
      if (mapped === 'pct' && state.plan.stop_pct != null) {
        $('#plan-stop-value').value = state.plan.stop_pct;
      }
    }
  } else {
    $('#plan-summary').innerHTML = '<p class="empty-state small">No saved plan for this ticker yet. Set a stop and target, then save.</p>';
    $('#price-chart').innerHTML = levelChart({
      entry: entryPrice || 0,
      stop: 0,
      target: 0,
      risk_per_share: 0,
      reward_risk: 0,
    }, or.high, or.low);
  }
  renderStepper();
});

const savePlan = async (event) => {
  event.preventDefault();
  if (!state.symbol) {
    toast('Pick a ticker on the Scanner first.', 'error');
    return;
  }
  const button = $('#btn-plan-save');
  const entry = Number($('#plan-entry').value);
  const rule = $('#plan-stop-rule').value;
  const stopValue = Number($('#plan-stop-value').value);
  const target = $('#plan-target').value;
  const orHigh = Number($('#plan-or-high').value);
  const orLow = Number($('#plan-or-low').value);
  const errorEl = $('#exit-form-error');

  if (!(entry > 0)) {
    showError(errorEl, 'Entry price must be above $0.');
    return;
  }
  let stopRule = rule;
  if (rule === 'pct') {
    if (!(stopValue > 0) || stopValue >= 100) {
      showError(errorEl, 'A percent stop needs a value between 0 and 100.');
      return;
    }
    stopRule = `pct:${stopValue}`;
  } else if (!(orHigh > 0) || !(orLow > 0) || orHigh <= orLow) {
    showError(errorEl, 'The opening-range high and low are needed, and the high must be above the low.');
    return;
  }
  errorEl.innerHTML = '';
  busy(button, true, 'Saving…');
  try {
    const plan = await api('/api/exit/plan', {
      method: 'POST',
      body: {
        symbol: state.symbol,
        entry,
        stop_rule: stopRule,
        target,
        or_high: orHigh > 0 ? orHigh : null,
        or_low: orLow > 0 ? orLow : null,
      },
    });
    state.plan = plan;
    state.simulation = null;
    renderPlan(plan);
    renderStepper();
    toast(`Plan saved for ${plan.symbol}: stop ${money(plan.stop)}, target ${money(plan.target)}.`, 'success');
  } catch (err) {
    showError(errorEl, errorText(err));
  } finally {
    busy(button, false);
  }
};

/* ------------------------------------------------------------------ time machine */
const ensurePlan = async () => {
  if (state.plan) return state.plan;
  try {
    const row = await api('/api/plans/latest');
    if (row && row.plan_json) {
      state.plan = typeof row.plan_json === 'string' ? JSON.parse(row.plan_json) : row.plan_json;
    }
  } catch (err) {
    state.plan = null;
  }
  return state.plan;
};

const entryTimeFor = async (plan) => {
  if (plan.entry_time) return plan.entry_time;
  if (plan.entry_bar !== undefined && plan.entry_bar !== null) return null;
  const symbol = plan.symbol;
  if (!symbol) return null;
  let entry = state.entryCache[symbol] || (state.entry && state.entry.symbol === symbol ? state.entry : null);
  if (!entry) {
    try {
      entry = await api('/api/entry/check', { method: 'POST', body: { symbol } });
      state.entryCache[symbol] = entry;
    } catch (err) {
      return null;
    }
  }
  return (entry.trigger && entry.trigger.time) || null;
};

const renderOdds = (sim) => {
  const mc = (sim && sim.mc) || {};
  const t = Math.round(Number(mc.p_target || 0) * 1000) / 10;
  const s = Math.round(Number(mc.p_stop || 0) * 1000) / 10;
  const n = Math.round(Number(mc.p_neither || 0) * 1000) / 10;
  $('#odds-bar').innerHTML = `
    <div class="odds-segment target" style="flex:${Math.max(t, 1)}" title="Target first">${t}%</div>
    <div class="odds-segment stop" style="flex:${Math.max(s, 1)}" title="Stop first">${s}%</div>
    <div class="odds-segment neither" style="flex:${Math.max(n, 1)}" title="Neither first">${n}%</div>`;
  const verdict = sim && sim.verdict ? String(sim.verdict) : '';
  const likely = t >= s && t >= n
    ? `the target is hit first in ${pct(t)} of replays`
    : s >= n
      ? `the stop is hit first in ${pct(s)} of replays`
      : `neither level is hit first in ${pct(n)} of replays`;
  $('#tm-verdict').innerHTML = `
    <p>${esc(verdict || 'Simulation complete.')} Most often ${esc(likely)}.</p>
    <p class="subtle">Average ${num(mc.avg_R, 2)}R · median close ${money(mc.median_close)} · range ${money(mc.p5_close)} to ${money(mc.p95_close)}</p>`;
  $('#fan-chart').innerHTML = fanChart(sim);
};

const renderSimHistory = () => {
  const rows = state.sims || [];
  const tbody = $('#tm-history-tbody');
  const empty = $('#tm-history-empty');
  if (!rows.length) {
    tbody.innerHTML = '';
    empty.style.display = '';
    return;
  }
  empty.style.display = 'none';
  tbody.innerHTML = rows.map((row) => {
    const verdict = row.verdict ? String(row.verdict) : '—';
    const pass = /favou?r/i.test(verdict);
    return `<tr>
      <td>${esc(row.symbol || '—')}</td>
      <td class="num">${pct(row.target_first_pct)}</td>
      <td class="num">${pct(row.stop_first_pct)}</td>
      <td class="num">${pct(row.neither_pct)}</td>
      <td><span class="tag ${pass ? 'pass' : ''}">${esc(verdict)}</span></td>
    </tr>`;
  }).join('');
};

const loadTimeMachine = () => guard('tm', async () => {
  const note = $('#tm-plan-note');
  if (!state.simsLoaded) {
    try {
      const rows = await api('/api/simulations');
      state.sims = Array.isArray(rows) ? rows : [];
      state.simsLoaded = true;
    } catch (err) {
      state.sims = [];
    }
    renderSimHistory();
  }
  const plan = await ensurePlan();
  if (!plan) {
    note.textContent = 'No saved plan yet.';
    $('#tm-plan-note').innerHTML = 'No saved plan yet — build one in the <button type="button" class="link-btn" data-go="planner">Trade planner</button>.';
    return;
  }
  note.textContent = `${plan.symbol} · entry ${money(plan.entry)} · stop ${money(plan.stop)} · target ${money(plan.target)}`;
});

const runSimulation = async () => {
  const button = $('#btn-tm-run');
  const note = $('#tm-plan-note');
  const plan = await ensurePlan();
  if (!plan) {
    note.innerHTML = 'No saved plan yet — build one in the <button type="button" class="link-btn" data-go="planner">Trade planner</button>.';
    return;
  }
  const entryTime = await entryTimeFor(plan);
  busy(button, true, 'Replaying…');
  try {
    const sim = await api('/api/timemachine/run', {
      method: 'POST',
      body: {
        symbol: plan.symbol,
        entry: plan.entry,
        stop: plan.stop,
        target: plan.target,
        entry_time: entryTime || undefined,
      },
    });
    state.simulation = sim;
    renderOdds(sim);
    state.simsLoaded = false;
    try {
      state.sims = await api('/api/simulations');
      state.simsLoaded = true;
    } catch (err) { /* history stays as it was */ }
    renderSimHistory();
    renderStepper();
    toast('Time Machine finished.', 'success');
  } catch (err) {
    note.textContent = '';
    toast(errorText(err), 'error');
    $('#tm-verdict').innerHTML = `<p class="form-error" role="alert">${esc(errorText(err))}</p>`;
  } finally {
    busy(button, false);
  }
};

/* ------------------------------------------------------------------ size & risk */
const loadSizeRisk = async () => {
  const plan = await ensurePlan();
  const note = $('#sr-plan-note');
  if (plan) {
    note.textContent = `${plan.symbol} · entry ${money(plan.entry)} · stop ${money(plan.stop)} · target ${money(plan.target)}`;
    if (!$('#size-entry').value) $('#size-entry').value = Number(plan.entry).toFixed(2);
    if (!$('#size-stop').value) $('#size-stop').value = Number(plan.stop).toFixed(2);
    if (!$('#size-target').value) $('#size-target').value = Number(plan.target).toFixed(2);
  } else {
    note.innerHTML = 'No saved plan yet — size follows the last saved plan. Build one in the <button type="button" class="link-btn" data-go="planner">Trade planner</button>.';
  }
  if (state.settings) {
    if (state.settings.budget != null) $('#size-budget').value = state.settings.budget;
    if (state.settings.max_loss_per_trade_usd != null) $('#size-max-loss').value = state.settings.max_loss_per_trade_usd;
  }
};

const persistRiskInputs = async () => {
  const budget = Number($('#size-budget').value);
  const maxLoss = Number($('#size-max-loss').value);
  if (!(budget > 0)) throw new Error('Budget must be above $0.');
  if (!(maxLoss > 0)) throw new Error('Max loss per trade must be above $0.');
  if (state.settings && state.settings.budget === budget && state.settings.max_loss_per_trade_usd === maxLoss) return;
  await api('/api/settings', { method: 'POST', body: { key: 'budget', value: budget } });
  await api('/api/settings', { method: 'POST', body: { key: 'max_loss_per_trade_usd', value: maxLoss } });
  if (state.settings) {
    state.settings.budget = budget;
    state.settings.max_loss_per_trade_usd = maxLoss;
  }
};

const calculateSize = async () => {
  const button = $('#btn-size-calc');
  const result = $('#size-result');
  busy(button, true, 'Calculating…');
  try {
    await persistRiskInputs();
    const data = await api('/api/size', { method: 'POST', body: {} });
    const sizing = (data && data.sizing) || {};
    if (sizing.refusal) {
      $('#size-shares').textContent = '0 shares';
      $('#size-rule').textContent = sizing.refusal;
      $('#size-verdict').className = 'size-verdict block';
      $('#size-verdict').textContent = 'Cannot size this trade';
      $('#size-limits').innerHTML = '';
      return;
    }
    $('#size-shares').textContent = `${Number(sizing.qty || 0)} shares`;
    $('#size-rule').textContent = `Bound by ${sizing.bound_by || 'the limits'} · max loss ${money(sizing.max_loss)} · cost ${money(sizing.cost)}`;
    $('#size-verdict').className = 'size-verdict pass';
    $('#size-verdict').textContent = `${sizing.symbol || ''} sized at ${money(sizing.entry)} with a ${money(sizing.risk_per_share)} stop distance`;
    $('#size-limits').innerHTML = (sizing.limits || []).map((limit) => `
      <li class="${limit.binds ? 'binds' : ''}">
        <span>${esc(limit.name)}: ${num(limit.shares, 0)} shares${limit.binds ? ' (binding)' : ''}</span>
        <span>${esc(limit.how || '')}</span>
      </li>`).join('');
    toast(`Sized ${Number(sizing.qty || 0)} shares.`, 'success');
  } catch (err) {
    result.innerHTML = `<div class="form-error" role="alert">${esc(errorText(err))}</div>`;
  } finally {
    busy(button, false);
  }
};

const runRiskCheck = async () => {
  const button = $('#btn-risk-run');
  const el = $('#risk-result');
  busy(button, true, 'Checking…');
  try {
    await persistRiskInputs();
    const data = await api('/api/risk/check', { method: 'POST', body: {} });
    const results = data.results || [];
    if (!results.length) {
      el.innerHTML = '<p class="empty-state small">No orders to check yet. Calculate a size first.</p>';
      return;
    }
    el.innerHTML = results.map((row) => {
      const pass = String(row.verdict).toUpperCase() === 'PASS';
      return `
        <div class="risk-item ${pass ? 'pass' : 'block'}">
          <div class="risk-head">${esc(row.symbol)} · ${esc(row.verdict)} · ${esc(row.amount || '')}</div>
          <div class="subtle">max loss ${money(row.max_loss)} · reward:risk ${num(row.reward_risk, 2)}</div>
          ${(row.reasons || []).length ? `<ul>${row.reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>` : ''}
          ${(row.warnings || []).length ? `<ul>${row.warnings.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>` : ''}
        </div>`;
    }).join('') + `<p class="subtle">${Number(data.pass || 0)} passed · ${Number(data.block || 0)} blocked · cash after ${money(data.cash_after)}</p>`;
    toast(`Risk check: ${data.pass} pass, ${data.block} blocked.`, data.block ? 'error' : 'success');
  } catch (err) {
    el.innerHTML = `<div class="form-error" role="alert">${esc(errorText(err))}</div>`;
  } finally {
    busy(button, false);
  }
};

/* ------------------------------------------------------------------ alerts */
const ruleLevel = (alert) => {
  if (alert.rule_type === 'time') return esc(alert.at_time || '—') + ' ET';
  if (alert.rule_type === 'pct_move') return pct(alert.pct, 2);
  return money(alert.price);
};

const loadAlerts = () => guard('alerts', async () => {
  const tbody = $('#alerts-tbody');
  const empty = $('#alerts-empty');
  tbody.innerHTML = '<tr><td colspan="6" class="loading-cell">Loading alert rules…</td></tr>';
  try {
    const [rows, clock] = await Promise.all([
      api('/api/alerts/stored'),
      api('/api/alerts/clock').catch(() => null),
    ]);
    state.alerts = Array.isArray(rows) ? rows : [];
    if (clock) {
      const parsed = parseClock(clock);
      $('#alerts-clock-note').textContent = parsed
        ? `NYSE ${clock.open ? 'open' : 'closed'} · ${clock12(parsed.minutes)} New York · ${clock.reason || ''}`
        : `NYSE ${clock.open ? 'open' : 'closed'} · ${clock.reason || ''}`;
    }
  } catch (err) {
    tbody.innerHTML = '';
    showError(empty, errorText(err));
    empty.style.display = '';
    return;
  }

  if (!state.alerts.length) {
    tbody.innerHTML = '';
    empty.style.display = '';
    return;
  }
  empty.style.display = 'none';
  tbody.innerHTML = state.alerts.map((alert) => `
    <tr>
      <td>${esc(alert.rule_id)}</td>
      <td>${esc(alert.symbol || '—')}</td>
      <td>${esc(String(alert.rule_type || '').replace(/_/g, ' '))}</td>
      <td class="num">${ruleLevel(alert)}</td>
      <td><span class="tag ${alert.armed ? 'pass' : ''}">${alert.armed ? 'armed' : 'rung'}</span></td>
      <td><button type="button" class="btn btn-small btn-danger" data-del="${esc(alert.rule_id)}">Delete</button></td>
    </tr>`).join('');
});

const addAlert = async (event) => {
  event.preventDefault();
  const button = $('#btn-alert-add');
  const type = $('#alert-type').value;
  const symbol = $('#alert-symbol').value.trim().toUpperCase();
  const levelRaw = $('#alert-level').value.trim();
  const idRaw = $('#alert-id').value.trim();
  const form = $('#alert-form');
  const errorEl = $('#alert-form-error');
  if (!levelRaw) {
    showError(errorEl, 'Enter a price level, a percentage, or a time.');
    return;
  }
  const level = Number(levelRaw.replace('%', '').replace('$', ''));
  if (type !== 'time' && !Number.isFinite(level)) {
    showError(errorEl, 'That level is not a number.');
    return;
  }
  if (type !== 'time' && !symbol) {
    showError(errorEl, 'Enter a ticker symbol for a price alert.');
    return;
  }
  const ruleId = idRaw || `${(symbol || 'desk').toLowerCase()}-${type === 'pct' ? 'pct' : type}`;
  const body = { rule_id: ruleId, symbol: symbol || null };
  if (type === 'above') body.above = level;
  else if (type === 'below') body.below = level;
  else if (type === 'pct') body.pct = level;
  else body.at = levelRaw;

  errorEl.innerHTML = '';
  busy(button, true, 'Adding…');
  try {
    await api('/api/alerts/add', { method: 'POST', body });
    form.reset();
    $('#alert-level-label').textContent = 'Level / price';
    await loadAlerts();
    toast(`Alert ${ruleId} added.`, 'success');
  } catch (err) {
    showError(errorEl, errorText(err));
  } finally {
    busy(button, false);
  }
};

const deleteAlert = async (ruleId, button) => {
  busy(button, true, '…');
  try {
    await api('/api/alerts/' + encodeURIComponent(ruleId), { method: 'DELETE' });
    await loadAlerts();
    toast(`Alert ${ruleId} deleted.`, 'success');
  } catch (err) {
    toast(errorText(err), 'error');
  } finally {
    busy(button, false);
  }
};

const checkAlerts = async () => {
  const button = $('#btn-alerts-check');
  const card = $('#alerts-ring-card');
  busy(button, true, 'Checking…');
  try {
    const data = await api('/api/alerts/check', { method: 'POST', body: {} });
    const rings = data.rings || [];
    card.style.display = '';
    $('#alerts-rings').innerHTML = rings.length
      ? rings.map((ring) => `<div class="risk-item pass"><div class="risk-head">${esc(ring.id || '')} · ${esc(ring.symbol || '')}</div><div>${esc(ring.message || '')}</div></div>`).join('')
      : '<p class="subtle">Nothing hit. Rules stay armed.</p>';
    toast(rings.length ? `${rings.length} alert${rings.length === 1 ? '' : 's'} rang.` : 'Nothing hit.', rings.length ? 'success' : 'info');
  } catch (err) {
    card.style.display = '';
    const message = errorText(err);
    if (/no rules/i.test(message)) {
      $('#alerts-rings').innerHTML = '<p class="subtle">No rules to check yet. Add one first.</p>';
    } else {
      showError($('#alerts-rings'), message);
    }
  } finally {
    busy(button, false);
  }
};

const alertsFromPlan = async () => {
  const button = $('#btn-alert-from-plan');
  const plan = await ensurePlan();
  if (!plan) {
    toast('No saved plan yet. Build one in the Trade planner first.', 'error');
    return;
  }
  busy(button, true, 'Creating…');
  const symbol = plan.symbol;
  const existing = new Set((state.alerts || []).map((a) => a.rule_id));
  let created = 0;
  try {
    const wanted = [
      { rule_id: `${symbol.toLowerCase()}-stop`, symbol, stop: plan.stop },
      { rule_id: `${symbol.toLowerCase()}-target`, symbol, target: plan.target },
    ];
    for (const rule of wanted) {
      if (existing.has(rule.rule_id)) continue;
      await api('/api/alerts/add', { method: 'POST', body: rule });
      created += 1;
    }
    await loadAlerts();
    toast(created ? `${created} plan alert${created === 1 ? '' : 's'} created.` : 'Plan alerts already exist.', created ? 'success' : 'info');
  } catch (err) {
    toast(errorText(err), 'error');
  } finally {
    busy(button, false);
  }
};

/* ------------------------------------------------------------------ earnings */
const loadEarnings = async () => {
  const empty = $('#earnings-empty');
  const wrap = $('#earnings-wrap');
  if (!wrap.dataset.loaded) {
    empty.style.display = '';
  }
};

const fetchEarnings = async () => {
  const button = $('#btn-earnings');
  const wrap = $('#earnings-wrap');
  const empty = $('#earnings-empty');
  const raw = $('#earnings-tickers').value;
  const tickers = raw.split(',').map((t) => t.trim().toUpperCase()).filter(Boolean);
  if (!tickers.length) {
    showError(empty, 'Enter at least one ticker, for example AAPL.');
    empty.style.display = '';
    return;
  }
  busy(button, true, 'Fetching…');
  empty.style.display = 'none';
  wrap.innerHTML = '<p class="loading-state">Fetching SEC filings…</p>';
  try {
    const data = await api('/api/earnings', { method: 'POST', body: { tickers } });
    wrap.dataset.loaded = '1';
    if (!Array.isArray(data) || !data.length) {
      wrap.innerHTML = '';
      showError(empty, 'No filing data came back for ' + tickers.join(', ') + '.');
      empty.style.display = '';
      return;
    }
    wrap.innerHTML = data.map((block) => {
      const result = block.result || {};
      const rows = result.rows || [];
      return `
        <div class="card">
          <div class="ticker-head">
            <h3>${esc(block.ticker)} · ${esc(result.entity || '')}</h3>
            <span class="cik">CIK ${esc(result.cik || '—')}</span>
          </div>
          <div class="table-scroll">
            <table class="data-table small">
              <thead><tr>
                <th>Fiscal</th><th>Period end</th><th>Revenue</th><th>Gross margin</th>
                <th>Operating margin</th><th>Net margin</th><th>EPS</th><th>Revenue YoY</th><th>Filed</th>
              </tr></thead>
              <tbody>
                ${rows.map((row) => `
                  <tr>
                    <td>${esc(row.fiscal || '—')}</td>
                    <td>${esc(row.end || '—')}</td>
                    <td class="num">${bigMoney(row.revenue)}</td>
                    <td class="num">${pct(row.gross_margin)}</td>
                    <td class="num">${pct(row.operating_margin)}</td>
                    <td class="num">${pct(row.net_margin)}</td>
                    <td class="num">${money(row.eps_diluted)}</td>
                    <td class="num ${Number(row.revenue_yoy) >= 0 ? 'pos' : 'neg'}">${Number(row.revenue_yoy) >= 0 ? '+' : ''}${pct(row.revenue_yoy)}</td>
                    <td>${esc(row.filed || '—')}</td>
                  </tr>`).join('')}
              </tbody>
            </table>
          </div>
        </div>`;
    }).join('');
  } catch (err) {
    wrap.innerHTML = '';
    showError(empty, errorText(err));
    empty.style.display = '';
  } finally {
    busy(button, false);
  }
};

/* ------------------------------------------------------------------ congress */
const loadCongress = async () => {
  const empty = $('#congress-empty');
  const wrap = $('#congress-wrap');
  if (!wrap.dataset.loaded) empty.style.display = '';
};

const fetchCongress = async () => {
  const button = $('#btn-congress');
  const wrap = $('#congress-wrap');
  const empty = $('#congress-empty');
  const member = $('#congress-member').value.trim();
  if (!member) {
    showError(empty, 'Enter a member name, for example Pelosi.');
    empty.style.display = '';
    return;
  }
  busy(button, true, 'Fetching…');
  empty.style.display = 'none';
  wrap.innerHTML = '<p class="loading-state">Reading House Clerk filings…</p>';
  try {
    const rows = await api('/api/congress/index', { method: 'POST', body: { member } });
    wrap.dataset.loaded = '1';
    if (!Array.isArray(rows) || !rows.length) {
      wrap.innerHTML = '';
      showError(empty, 'No periodic transaction reports came back for ' + member + '.');
      empty.style.display = '';
      return;
    }
    wrap.innerHTML = `
      <div class="card">
        <div class="ticker-head">
          <h3>${esc(rows[0].name || member)}</h3>
          <span class="cik">${rows.length} filing${rows.length === 1 ? '' : 's'}</span>
        </div>
        <div class="table-scroll">
          <table class="data-table small">
            <thead><tr><th>Filed</th><th>Type</th><th>Year</th><th>District</th><th>Document</th></tr></thead>
            <tbody>
              ${rows.map((row) => `
                <tr>
                  <td>${esc(row.filed || '—')}</td>
                  <td>${esc(row.type_name || row.type || '—')}</td>
                  <td class="num">${esc(row.year || '—')}</td>
                  <td>${esc(row.district || '—')}</td>
                  <td>${row.url ? `<a class="link" href="${esc(row.url)}" target="_blank" rel="noopener noreferrer">Open PDF</a>` : '—'}</td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>`;
  } catch (err) {
    wrap.innerHTML = '';
    showError(empty, errorText(err));
    empty.style.display = '';
  } finally {
    busy(button, false);
  }
};

/* ------------------------------------------------------------------ settings */
const SETTING_GROUPS = [
  {
    title: 'Mode and data',
    hint: 'Demo mode reads saved fixtures. Live mode calls Yahoo, SEC and the House Clerk.',
    fields: ['mode', 'sec_user_agent', 'cache_ttl_seconds'],
  },
  {
    title: 'Budget',
    fields: ['budget', 'cash_buffer_pct', 'max_position_pct', 'max_order_usd', 'min_order_usd'],
  },
  {
    title: 'Risk',
    fields: ['max_loss_per_trade_usd', 'max_daily_loss_usd', 'max_trades_per_day', 'max_orders_per_day', 'min_reward_risk'],
  },
  {
    title: 'Rules',
    fields: ['require_stop', 'no_entries_before', 'no_entries_after', 'flat_by', 'fractional', 'allow_options', 'allow_margin', 'allow_short', 'pdt_guard', 'blocked'],
  },
];

const LABELS = {
  mode: 'Mode', sec_user_agent: 'SEC User-Agent', cache_ttl_seconds: 'Cache TTL (seconds)',
  budget: 'Budget ($)', cash_buffer_pct: 'Cash buffer (%)', max_position_pct: 'Max position (%)',
  max_order_usd: 'Max order ($)', min_order_usd: 'Min order ($)',
  max_loss_per_trade_usd: 'Max loss per trade ($)', max_daily_loss_usd: 'Max daily loss ($)',
  max_trades_per_day: 'Max trades per day', max_orders_per_day: 'Max orders per day',
  min_reward_risk: 'Min reward : risk', require_stop: 'Require a stop',
  no_entries_before: 'No entries before (ET)', no_entries_after: 'No entries after (ET)',
  flat_by: 'Flat by (ET)', fractional: 'Allow fractional shares',
  allow_options: 'Allow options', allow_margin: 'Allow margin', allow_short: 'Allow short',
  pdt_guard: 'PDT guard', blocked: 'Blocked tickers',
};

const settingField = (key, value) => {
  const id = 'set-' + key;
  if (key === 'mode') {
    const locked = state.modeLocked;
    return `
      <div class="field">
        <label for="${id}">Mode</label>
        <select id="${id}" data-setting="mode" ${locked ? 'disabled' : ''}>
          <option value="demo"${value === 'demo' ? ' selected' : ''}>Demo (offline fixtures)</option>
          <option value="live"${value === 'live' ? ' selected' : ''}>Live (Yahoo, SEC, House Clerk)</option>
        </select>
        ${locked ? `<span class="settings-hint">Fixed by DESK_MODE in .env. Change it there and restart.</span>` : ''}
      </div>`;
  }
  if (typeof value === 'boolean') {
    return `
      <div class="field checkbox-field">
        <label for="${id}"><input type="checkbox" id="${id}" data-setting="${key}" ${value ? 'checked' : ''}> ${esc(LABELS[key] || key)}</label>
      </div>`;
  }
  if (Array.isArray(value)) {
    return `
      <div class="field">
        <label for="${id}">${esc(LABELS[key] || key)}</label>
        <input type="text" id="${id}" data-setting="${key}" value="${esc(value.join(', '))}" placeholder="comma separated">
      </div>`;
  }
  const type = typeof value === 'number' ? 'number' : 'text';
  const step = key.includes('pct') || key.includes('usd') || key === 'budget' || key === 'min_reward_risk' ? '0.01' : '1';
  return `
    <div class="field">
      <label for="${id}">${esc(LABELS[key] || key)}</label>
      <input type="${type}" ${type === 'number' ? `step="${step}"` : ''} id="${id}" data-setting="${key}" value="${esc(value)}">
    </div>`;
};

const renderSettings = () => {
  const wrap = $('#settings-wrap');
  const settings = state.settings || {};
  wrap.innerHTML = SETTING_GROUPS.map((group) => `
      <div class="settings-group">
        <h3>${esc(group.title)}</h3>
        ${group.hint ? `<p class="settings-hint">${esc(group.hint)}</p>` : ''}
        ${group.fields.filter((key) => key in settings).map((key) => settingField(key, settings[key])).join('')}
      </div>`).join('') + `
      <div class="settings-actions">
        <span class="settings-hint">Changes save as soon as you leave a field.</span>
      </div>`;
};

const loadSettingsPage = async () => {
  if (!state.settings) {
    $('#settings-wrap').innerHTML = '<div class="empty-state"><p class="loading-state">Loading settings…</p></div>';
    try {
      state.settings = await api('/api/settings');
      state.mode = state.settings.mode || state.mode;
    } catch (err) {
      showError($('#settings-wrap'), errorText(err));
      return;
    }
  }
  renderSettings();
};

const saveSetting = async (input) => {
  const key = input.dataset.setting;
  if (!key) return;
  let value;
  if (input.type === 'checkbox') value = input.checked;
  else if (input.type === 'number') value = Number(input.value);
  else value = input.value;
  if (input.type === 'number' && !Number.isFinite(value)) {
    toast('That setting needs a number.', 'error');
    renderSettings();
    return;
  }
  const previous = state.settings ? state.settings[key] : undefined;
  try {
    const result = await api('/api/settings', { method: 'POST', body: { key, value } });
    state.settings[key] = result.value !== undefined ? result.value : value;
    if (key === 'mode') {
      state.mode = state.settings.mode;
      await loadStatus();
    }
    toast(`${LABELS[key] || key} saved.`, 'success');
  } catch (err) {
    toast(errorText(err), 'error');
    if (state.settings && previous !== undefined) state.settings[key] = previous;
    renderSettings();
  }
};

/* ------------------------------------------------------------------ events */
const bindEvents = () => {
  document.addEventListener('click', (event) => {
    const target = event.target.closest('[data-nav], [data-action], [data-step], [data-go], [data-plan-to]');
    if (!target) return;
    if (target.dataset.nav) {
      navigate(target.dataset.nav);
    } else if (target.dataset.action === 'palette') {
      openPalette();
    } else if (target.dataset.step) {
      navigate(target.dataset.step, target.dataset.stepArg || '');
    } else if (target.dataset.go) {
      navigate(target.dataset.go, target.dataset.go === 'planner' ? (state.plan ? state.plan.symbol : '') : '');
    } else if (target.dataset.planTo) {
      navigate(target.dataset.planTo);
    }
  });

  $('#btn-theme').addEventListener('click', toggleTheme);
  $('#btn-command').addEventListener('click', openPalette);
  $('#btn-settings').addEventListener('click', () => navigate('settings'));

  $('#command-palette').addEventListener('click', (event) => {
    if (event.target === $('#command-palette')) closePalette();
  });
  $('#command-input').addEventListener('input', (event) => {
    state.paletteIndex = 0;
    renderPalette(event.target.value);
  });
  $('#command-results').addEventListener('click', (event) => {
    const button = event.target.closest('[data-command]');
    if (!button) return;
    closePalette();
    navigate(button.dataset.command);
  });

  document.addEventListener('keydown', (event) => {
    const palette = $('#command-palette');
    const open = palette.style.display !== 'none';
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      if (open) closePalette(); else openPalette();
      return;
    }
    if (!open) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      closePalette();
      const active = document.activeElement;
      if (active && active.blur) active.blur();
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      state.paletteIndex = Math.min(state.paletteIndex + 1, state.paletteItems.length - 1);
      renderPalette($('#command-input').value);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      state.paletteIndex = Math.max(state.paletteIndex - 1, 0);
      renderPalette($('#command-input').value);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      choosePalette();
    }
  });

  $('#btn-scan-daily').addEventListener('click', (event) => runScan('daily', event.currentTarget));
  $('#btn-scan-orb').addEventListener('click', (event) => runScan('orb', event.currentTarget));
  $('#btn-news-check').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    busy(button, true, 'Checking…');
    state.newsLoaded = false;
    try {
      state.news = await api('/api/news', { method: 'POST', body: {} });
      state.newsLoaded = true;
      renderNews();
    } catch (err) {
      state.news = null;
      renderNews();
      showError($('#news-empty'), errorText(err));
    } finally {
      busy(button, false);
    }
  });

  $('#scanner-tbody').addEventListener('click', (event) => {
    const detail = event.target.closest('[data-detail]');
    const plan = event.target.closest('[data-plan]');
    const watch = event.target.closest('[data-watch]');
    if (detail) {
      const scan = state.scans[0];
      const hit = scan && (scan.hits || []).find((row) => row.symbol === detail.dataset.detail);
      if (hit) renderScannerDetail(hit, scan.mode);
    } else if (plan) {
      state.simulation = null;
      navigate('planner', plan.dataset.plan);
    } else if (watch) {
      addWatch(watch.dataset.watch, watch);
    }
  });

  $('#exit-form').addEventListener('submit', savePlan);
  $('#plan-stop-rule').addEventListener('change', () => {
    const field = $('#plan-stop-value');
    const isPct = $('#plan-stop-rule').value === 'pct';
    field.disabled = !isPct;
    field.placeholder = isPct ? 'e.g. 1 for 1%' : 'opening range supplies the stop';
    if (!isPct) field.value = '';
  });
  $('#plan-stop-rule').dispatchEvent(new Event('change'));

  $('#btn-tm-run').addEventListener('click', runSimulation);
  $('#size-form').addEventListener('submit', (event) => {
    event.preventDefault();
    calculateSize();
  });
  $('#btn-size-run').addEventListener('click', calculateSize);
  $('#btn-risk-run').addEventListener('click', runRiskCheck);
  $('#btn-alerts-check').addEventListener('click', checkAlerts);
  $('#alert-form').addEventListener('submit', addAlert);
  $('#btn-alert-from-plan').addEventListener('click', alertsFromPlan);
  $('#alert-type').addEventListener('change', () => {
    const type = $('#alert-type').value;
    const label = $('#alert-level-label');
    const level = $('#alert-level');
    if (type === 'pct') {
      label.textContent = 'Percent move (%)';
      level.placeholder = '3.5';
    } else if (type === 'time') {
      label.textContent = 'Time (New York, HH:MM)';
      level.placeholder = '15:45';
    } else {
      label.textContent = 'Level / price';
      level.placeholder = '358.32';
    }
  });

  $('#alerts-tbody').addEventListener('click', (event) => {
    const button = event.target.closest('[data-del]');
    if (button) deleteAlert(button.dataset.del, button);
  });

  $('#btn-earnings').addEventListener('click', fetchEarnings);
  $('#earnings-tickers').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') fetchEarnings();
  });
  $('#btn-congress').addEventListener('click', fetchCongress);
  $('#congress-member').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') fetchCongress();
  });

  $('#settings-wrap').addEventListener('change', (event) => {
    const input = event.target.closest('[data-setting]');
    if (input) saveSetting(input);
  });

  window.addEventListener('hashchange', route);

  const skip = $('.skip-link');
  if (skip) {
    skip.addEventListener('click', (event) => {
      event.preventDefault();
      $('#main').focus();
    });
  }
};

/* ------------------------------------------------------------------ boot */
const boot = async () => {
  initTheme();
  renderNav();
  renderMobileTabs();
  bindEvents();
  route();
  loadStatus();
  setInterval(loadStatus, 30000);

  try {
    const [settings] = await Promise.all([
      api('/api/settings'),
      loadWatchlist(),
      ensurePlan(),
    ]);
    state.settings = settings;
    state.mode = settings.mode || state.mode;
    if (parseHash().page === 'settings') renderSettings();
    if (parseHash().page === 'size-risk') {
      if (settings.budget != null) $('#size-budget').value = settings.budget;
      if (settings.max_loss_per_trade_usd != null) $('#size-max-loss').value = settings.max_loss_per_trade_usd;
    }
    renderRibbon();
  } catch (err) {
    toast(errorText(err), 'error');
  }
};

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
