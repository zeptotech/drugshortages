'use strict';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const PAGE_SIZE = 100;
const NEW_DAYS = 7;           // NEW / UPDATED tags
const CHANGE_DAYS_SHOWN = 14; // days loaded in "What's new"
const STALE_HOURS = 36;       // warn when the daily update seems to have stopped

const OFFICIAL_URL = {
  shortage: id => `https://healthproductshortages.ca/shortage/${id}`,
  discontinuance: id => `https://healthproductshortages.ca/discontinuance/${id}`,
};

const STATUS = {
  active_confirmed: ['Actual shortage', 'actual'],
  anticipated_shortage: ['Anticipated shortage', 'antic'],
  resolved: ['Resolved', 'resolved'],
  avoided_shortage: ['Avoided', 'resolved'],
  to_be_discontinued: ['To be discontinued', 'tobe'],
  discontinued: ['Discontinued', 'disc'],
  reversed: ['Reversed', 'resolved'],
  removed: ['Removed from source', 'disc'],
};

const ATC_GROUPS = {
  A: 'Alimentary tract & metabolism', B: 'Blood & blood forming organs', C: 'Cardiovascular system',
  D: 'Dermatologicals', G: 'Genito-urinary system & sex hormones', H: 'Systemic hormonal preparations',
  J: 'Anti-infectives for systemic use', L: 'Antineoplastic & immunomodulating agents',
  M: 'Musculo-skeletal system', N: 'Nervous system', P: 'Antiparasitic products',
  R: 'Respiratory system', S: 'Sensory organs', V: 'Various',
};

const VIEWS = {
  shortages: {
    label: 'Shortages',
    current: ['active_confirmed', 'anticipated_shortage'],
    tabs: [
      { id: 'actual', label: 'Actual shortage', tone: 'actual', statuses: ['active_confirmed'] },
      { id: 'anticipated', label: 'Anticipated shortage', tone: 'antic', statuses: ['anticipated_shortage'] },
      { id: 'resolved', label: 'Resolved / avoided', tone: 'resolved', recent: true },
    ],
  },
  discontinuations: {
    label: 'Discontinuations',
    current: ['to_be_discontinued'],
    tabs: [
      { id: 'upcoming', label: 'To be discontinued', tone: 'tobe', statuses: ['to_be_discontinued'] },
      { id: 'discontinued', label: 'Discontinued', tone: 'disc', recent: true },
    ],
  },
  changes: { label: "What's new" },
};

// Table columns. `key` is used for sorting; `html` (optional) for display.
const COLUMNS = {
  drug: { label: 'Drug', cls: 'c-drug', key: r => r.brand || '', html: drugCell },
  din: { label: 'DIN', cls: 'nowrap', key: r => r.din || '', html: dinCell },
  strength: { label: 'Strength', cls: 'nowrap', key: r => r.strength || '' },
  company: { label: 'Company', key: r => r.company || '' },
  // Falls back to the expected start when the company never entered an actual start date.
  actualStart: {
    label: 'Started', cls: 'date', key: r => r.actualStart || r.anticipatedStart || '',
    html: r => r.actualStart ? esc(r.actualStart)
      : r.anticipatedStart ? `${esc(r.anticipatedStart)}<div class="sub" title="No actual start date reported">expected</div>` : '',
  },
  anticipatedStart: { label: 'Expected start', cls: 'date', key: r => r.anticipatedStart || '' },
  estEnd: { label: 'Est. end', cls: 'date', key: r => r.estEnd || '', html: r => r.estEnd ? esc(r.estEnd) : '<span class="muted">Unknown</span>' },
  discDate: { label: 'Disc. date', cls: 'date', key: r => r.actualDiscDate || r.discDate || '' },
  outcome: { label: 'Outcome', key: r => statusLabel(r.status), html: r => statusBadge(r.status) },
  changedOn: { label: 'Changed', cls: 'date', key: r => r.changedOn || '' },
  activity: { label: 'New / Updated', cls: 'c-activity', key: activityKey, html: activityTag },
  updated: { label: 'Updated', cls: 'date', key: r => (r.updated || '').slice(0, 10) },
};

const TAB_COLUMNS = {
  actual: ['drug', 'din', 'strength', 'actualStart', 'estEnd', 'activity', 'updated'],
  anticipated: ['drug', 'din', 'strength', 'anticipatedStart', 'estEnd', 'activity', 'updated'],
  resolved: ['drug', 'din', 'strength', 'outcome', 'changedOn', 'updated'],
  upcoming: ['drug', 'din', 'strength', 'discDate', 'activity', 'updated'],
  discontinued: ['drug', 'din', 'strength', 'outcome', 'discDate', 'changedOn'],
};

const DEFAULT_SORT = {
  actual: ['updated', 'desc'],
  anticipated: ['updated', 'desc'],
  resolved: ['changedOn', 'desc'],
  upcoming: ['updated', 'desc'],
  discontinued: ['changedOn', 'desc'],
};

const FIELD_LABELS = {
  status: 'Status', estEnd: 'Est. end', actualStart: 'Actual start', anticipatedStart: 'Expected start',
  actualEnd: 'Actual end', reason: 'Reason', tier3: 'Tier 3', discDate: 'Disc. date',
  actualDiscDate: 'Actual disc. date', reversed: 'Reversed', comments: 'Comments',
  mitigation: 'Mitigation', strength: 'Strength', company: 'Company',
};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const data = { shortages: [], discontinuations: [], byId: new Map(), meta: {}, changeIndex: null, changeDays: new Map() };
const state = { view: 'shortages', tab: '', q: '', tier3: false, atc: '', sort: '', dir: '', page: 1 };
const $ = id => document.getElementById(id);
const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return isoDate(d);
}

function statusLabel(s) {
  return STATUS[s]?.[0] || (s ? s.replace(/_/g, ' ').replace(/^./, c => c.toUpperCase()) : '—');
}

function statusBadge(s) {
  return `<span class="status st-${STATUS[s]?.[1] || 'disc'}">${esc(statusLabel(s))}</span>`;
}

function formatNumber(n) {
  return n.toLocaleString('en-CA');
}

function tags(r) {
  return [
    r.tier3 && '<span class="tag tier3" title="Tier 3: highest potential impact">Tier 3</span>',
    r.late && '<span class="tag late" title="Reported more than 5 days after the start date">Late</span>',
  ].filter(Boolean).join('');
}

function activityKey(r) {
  return r._new ? 'New' : r._updatedRecently ? 'Updated' : '';
}

function activityTag(r) {
  const key = activityKey(r);
  return key ? `<span class="tag ${key === 'New' ? 'new' : 'upd'}">${key}</span>` : '';
}

function drugCell(r) {
  const sub = [r.ingredients, r.form, r.route].filter(Boolean).join(' · ');
  return `<div class="brand">${esc(r.brand)}${tags(r)}</div>${sub ? `<div class="sub">${esc(sub)}</div>` : ''}`;
}

function dinCell(r) {
  if (!r.din) return '';
  return `<span class="din">${esc(r.din)}</span><button class="copy" type="button" data-copy="${esc(r.din)}" title="Copy DIN" aria-label="Copy DIN ${esc(r.din)}">⧉</button>`;
}

function searchTokens() {
  return state.q.toLowerCase().split(/\s+/).filter(Boolean);
}

function matchesTokens(haystack, tokens) {
  return tokens.every(t => haystack.includes(t));
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

async function getJSON(path, optional = false) {
  const res = await fetch(path, { cache: 'no-cache' });
  if (!res.ok) {
    if (optional) return null;
    throw new Error(`${path}: HTTP ${res.status}`);
  }
  return res.json();
}

function prepare(r) {
  const newCutoff = daysAgo(NEW_DAYS);
  const created = (r.created || '').slice(0, 10);
  const updated = (r.updated || '').slice(0, 10);

  r._new = created >= newCutoff;
  r._updatedRecently = !r._new && updated >= newCutoff;
  r._hay = [r.brand, r.commonName, r.ingredients, r.din, r.company, r.atc, r.atcDesc, r.strength, r.form]
    .filter(Boolean).join(' ').toLowerCase();
  return r;
}

async function load() {
  const [meta, shortages, discontinuations, changeIndex] = await Promise.all([
    getJSON('data/meta.json'),
    getJSON('data/shortages.json'),
    getJSON('data/discontinuations.json'),
    getJSON('data/changes/index.json', true),
  ]);
  data.meta = meta;
  data.shortages = shortages.reports.map(prepare);
  data.discontinuations = discontinuations.reports.map(prepare);
  data.changeIndex = changeIndex || [];
  for (const r of [...data.shortages, ...data.discontinuations]) data.byId.set(r.id, r);
}

async function loadChangeDays() {
  const days = data.changeIndex.slice(0, CHANGE_DAYS_SHOWN).filter(d => !data.changeDays.has(d.date));
  await Promise.all(days.map(async d => {
    data.changeDays.set(d.date, await getJSON(`data/changes/${d.date}.json`, true));
  }));
}

// ---------------------------------------------------------------------------
// URL state
// ---------------------------------------------------------------------------

function readURL() {
  const p = new URLSearchParams(location.search);
  state.view = VIEWS[p.get('view')] ? p.get('view') : 'shortages';
  state.tab = p.get('tab') || '';
  state.q = p.get('q') || '';
  state.tier3 = p.get('tier3') === '1';
  state.atc = p.get('atc') || '';
  state.sort = p.get('sort') || '';
  state.dir = p.get('dir') === 'asc' ? 'asc' : p.get('dir') === 'desc' ? 'desc' : '';
  state.page = Math.max(1, parseInt(p.get('page'), 10) || 1);
  const tabs = VIEWS[state.view].tabs;
  if (tabs && !tabs.some(t => t.id === state.tab)) state.tab = tabs[0].id;
  if (state.sort && !COLUMNS[state.sort]) state.sort = '';
}

function writeURL(push = false) {
  const p = new URLSearchParams();
  if (state.view !== 'shortages') p.set('view', state.view);
  const tabs = VIEWS[state.view].tabs;
  if (tabs && state.tab !== tabs[0].id) p.set('tab', state.tab);
  if (state.q) p.set('q', state.q);
  if (state.tier3) p.set('tier3', '1');
  if (state.atc) p.set('atc', state.atc);
  if (state.sort) { p.set('sort', state.sort); p.set('dir', state.dir); }
  if (state.page > 1) p.set('page', state.page);
  const qs = p.toString();
  history[push ? 'pushState' : 'replaceState'](null, '', qs ? `?${qs}` : location.pathname);
}

// ---------------------------------------------------------------------------
// Filtering & sorting
// ---------------------------------------------------------------------------

function filtered(records) {
  const tokens = searchTokens();
  return records.filter(r =>
    (!tokens.length || matchesTokens(r._hay, tokens)) &&
    (!state.tier3 || r.tier3) &&
    (!state.atc || (r.atc || '').startsWith(state.atc)));
}

function inTab(view, tab, r) {
  return tab.recent ? !view.current.includes(r.status) : tab.statuses.includes(r.status);
}

function currentSort() {
  if (state.sort) return [state.sort, state.dir || 'asc'];
  return DEFAULT_SORT[state.tab];
}

function sortRows(rows, [colId, dir]) {
  const key = COLUMNS[colId].key;
  const m = dir === 'asc' ? 1 : -1;
  return rows.slice().sort((a, b) => {
    const x = key(a), y = key(b);
    if (!x && !y) return 0;
    if (!x) return 1;          // blanks last regardless of direction
    if (!y) return -1;
    return m * collator.compare(String(x), String(y));
  });
}

function visibleRows() {
  const view = VIEWS[state.view];
  const tab = view.tabs.find(t => t.id === state.tab);
  return sortRows(filtered(data[state.view]).filter(r => inTab(view, tab, r)), currentSort());
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function render() {
  renderUpdated();
  renderViews();
  const isChanges = state.view === 'changes';
  $('tabs').hidden = isChanges;
  $('toolbar').hidden = isChanges;
  $('pager').hidden = isChanges;
  if (isChanges) return renderChanges();
  renderTabs();
  renderTable();
}

function renderUpdated() {
  const ts = data.meta.lastChecked;
  if (!ts) return;
  const d = new Date(ts);
  const el = $('updated');
  el.textContent = `Updated ${d.toLocaleString('en-CA', { dateStyle: 'medium', timeStyle: 'short' })}`;
  const stale = (Date.now() - d.getTime()) / 36e5 > STALE_HOURS;
  el.classList.toggle('stale', stale);
  el.title = stale ? 'The daily update has not run recently; data may be out of date.' : '';
  if (stale) el.textContent += ' — may be out of date';
}

function renderViews() {
  const searching = !!state.q;
  $('views').innerHTML = Object.entries(VIEWS).map(([id, v]) => {
    let n = '';
    if (id !== 'changes') {
      const rows = searching ? filtered(data[id]) : data[id].filter(r => v.current.includes(r.status));
      n = `<span class="n">${formatNumber(rows.length)}${searching ? ' match' + (rows.length === 1 ? '' : 'es') : ''}</span>`;
    }
    return `<a href="?view=${id}" data-view="${id}"${id === state.view ? ' aria-current="page"' : ''}>${esc(v.label)}${n}</a>`;
  }).join('');
}

function renderTabs() {
  const view = VIEWS[state.view];
  const rows = filtered(data[state.view]);
  const days = data.meta.recentDays?.[state.view === 'shortages' ? 'shortage' : 'discontinuance'] || 30;
  $('tabs').innerHTML = view.tabs.map(t => {
    const n = rows.filter(r => inTab(view, t, r)).length;
    const label = t.recent ? `${t.label} (last ${days} days)` : t.label;
    return `<button type="button" role="tab" data-tab="${t.id}" data-tone="${t.tone}" aria-selected="${t.id === state.tab}">
      <span class="n">${formatNumber(n)}</span><span class="l">${esc(label)}</span></button>`;
  }).join('');
}

function renderTable() {
  const rows = visibleRows();
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  state.page = Math.min(state.page, pages);
  const start = (state.page - 1) * PAGE_SIZE;
  const pageRows = rows.slice(start, start + PAGE_SIZE);
  const cols = TAB_COLUMNS[state.tab];
  const [sortCol, sortDir] = currentSort();

  $('count').textContent = rows.length
    ? `${formatNumber(start + 1)}–${formatNumber(start + pageRows.length)} of ${formatNumber(rows.length)}`
    : '';

  if (!rows.length) {
    const recentTab = VIEWS[state.view].tabs.find(t => t.id === state.tab).recent;
    $('content').innerHTML = `<div class="empty">${
      state.q || state.tier3 || state.atc
        ? 'No reports match these filters.'
        : recentTab ? 'No status changes recorded yet. They appear here as the daily update detects them.' : 'No reports.'
    }</div>`;
    $('pager').innerHTML = '';
    return;
  }

  const head = cols.map(c => {
    const aria = c === sortCol ? ` aria-sort="${sortDir === 'asc' ? 'ascending' : 'descending'}"` : '';
    return `<th scope="col"${aria}><button type="button" data-sort="${c}">${esc(COLUMNS[c].label)}</button></th>`;
  }).join('');

  const body = pageRows.map(r => `<tr data-id="${r.id}">${cols.map(c => {
    const col = COLUMNS[c];
    const content = col.html ? col.html(r) : esc(col.key(r));
    return `<td class="${col.cls || ''}" data-label="${esc(col.label)}">${content}</td>`;
  }).join('')}</tr>`).join('');

  $('content').innerHTML = `<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;

  $('pager').innerHTML = pages > 1
    ? `<button type="button" data-page="${state.page - 1}"${state.page === 1 ? ' disabled' : ''}>‹ Prev</button>
       <span class="muted">Page ${state.page} of ${pages}</span>
       <button type="button" data-page="${state.page + 1}"${state.page === pages ? ' disabled' : ''}>Next ›</button>`
    : '';
}

function formatValue(field, value) {
  if (value === null || value === undefined || value === '') return field === 'estEnd' ? 'Unknown' : 'none';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (field === 'status') return statusLabel(value);
  return String(value);
}

function changeLine(e, kind) {
  const typeLabel = e.type === 'shortage' ? 'Shortage' : 'Discontinuation';
  const head = `<span class="kind">${typeLabel}</span><span class="brand">${esc(e.brand)}</span>
    ${e.tier3 ? '<span class="tag tier3">Tier 3</span>' : ''}
    <span class="sub"> ${esc([e.strength, e.din && `DIN ${e.din}`, e.company].filter(Boolean).join(' · '))}</span>`;
  let detail = '';
  if (kind === 'new') detail = statusBadge(e.status);
  if (kind === 'statusChanged') detail = e.from ? `${statusBadge(e.from)} → ${statusBadge(e.to)}` : `Now ${statusBadge(e.to)}`;
  if (kind === 'updated') {
    detail = (e.changes || []).map(c =>
      `<b>${esc(FIELD_LABELS[c.field] || c.field)}:</b> ${esc(formatValue(c.field, c.from))} → ${esc(formatValue(c.field, c.to))}`
    ).join('<br>');
  }
  return `<li data-id="${e.id}">${head}<div class="chg">${detail}</div></li>`;
}

async function renderChanges() {
  if (!data.changeIndex.length) {
    const since = data.meta.seeded ? ` (tracking started ${esc(data.meta.seeded)})` : '';
    $('content').innerHTML = `<div class="empty">No changes recorded yet${since}. The first entries appear after the next daily update.</div>`;
    return;
  }
  $('content').innerHTML = '<p class="muted">Loading…</p>';
  await loadChangeDays();
  if (state.view !== 'changes') return;

  const tokens = searchTokens();
  const keep = e => !tokens.length ||
    matchesTokens([e.brand, e.din, e.company, e.strength].filter(Boolean).join(' ').toLowerCase(), tokens);
  const sections = [['new', 'New reports'], ['updated', 'Updated'], ['statusChanged', 'Status changes']];

  const html = data.changeIndex.slice(0, CHANGE_DAYS_SHOWN).map(d => {
    const day = data.changeDays.get(d.date);
    if (!day) return '';
    const parts = sections.map(([key, title]) => {
      const entries = (day[key] || []).filter(keep);
      return entries.length ? `<h3>${title} (${entries.length})</h3><ul>${entries.map(e => changeLine(e, key)).join('')}</ul>` : '';
    }).join('');
    if (!parts) return '';
    const when = new Date(`${d.date}T12:00:00`).toLocaleDateString('en-CA', { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' });
    return `<section class="day"><h2>${esc(when)}
      <span class="muted">${d.new} new · ${d.updated} updated · ${d.statusChanged} status changes</span></h2>${parts}</section>`;
  }).join('');

  $('content').innerHTML = html || `<div class="empty">No changes match “${esc(state.q)}” in the last ${CHANGE_DAYS_SHOWN} update days.</div>`;
}

// ---------------------------------------------------------------------------
// Detail dialog
// ---------------------------------------------------------------------------

function openDetail(id) {
  const r = data.byId.get(id);
  if (!r) return;
  const isShortage = r.type === 'shortage';
  const rows = [
    ['Status', statusBadge(r.status), true],
    ['DIN', r.din],
    ['Common name', r.commonName],
    ['Ingredients', r.ingredients],
    ['Strength', r.strength],
    ['Dosage form', r.form],
    ['Route', r.route],
    ['Package', r.package],
    ['Company', r.company],
    ['ATC', r.atc && `${r.atc}${r.atcDesc ? ' — ' + r.atcDesc : ''}`],
    ['Reason', r.reason],
    ...(isShortage ? [
      ['Expected start', r.anticipatedStart],
      ['Actual start', r.actualStart],
      ['Estimated end', r.estEnd || 'Unknown'],
      ['Actual end', r.actualEnd],
    ] : [
      ['Expected discontinuation', r.discDate],
      ['Actual discontinuation', r.actualDiscDate],
      ['Reversed', r.reversed ? 'Yes' : ''],
    ]),
    ['Mitigation', r.mitigation],
    ['Company comments', r.comments],
    ['Health Canada comments', r.hcComments],
    ['Market status (DIN)', r.marketStatus],
    ['Report created', (r.created || '').slice(0, 10)],
    ['Report updated', (r.updated || '').slice(0, 10)],
    ['Status change detected', r.changedOn],
  ].filter(([, v]) => v);

  const dialog = $('detail');
  dialog.innerHTML = `
    <div class="d-head">
      <h2 id="detail-title">${esc(r.brand)}${tags(r)}${activityTag(r)}</h2>
      <div class="sub">${esc([r.strength, r.form, r.company].filter(Boolean).join(' · '))}</div>
      <button class="close" type="button" data-close aria-label="Close">✕</button>
    </div>
    <div class="d-body">
      <dl>${rows.map(([k, v, isHtml]) => `<dt>${esc(k)}</dt><dd>${isHtml ? v : esc(v)}</dd>`).join('')}</dl>
      <a class="official" href="${OFFICIAL_URL[r.type]?.(r.id) || 'https://healthproductshortages.ca'}" target="_blank" rel="noopener">
        View official report #${r.id} ↗</a>
    </div>`;
  dialog.showModal();
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

function syncControls() {
  $('q').value = state.q;
  $('q-clear').hidden = !state.q;
  $('f-tier3').checked = state.tier3;
  $('f-atc').value = state.atc;
}

function update(changes, { push = false, resetPage = true } = {}) {
  Object.assign(state, changes);
  if (resetPage) state.page = 1;
  writeURL(push);
  render();
}

function populateAtc() {
  const present = new Set([...data.shortages, ...data.discontinuations].map(r => (r.atc || '')[0]).filter(Boolean));
  $('f-atc').insertAdjacentHTML('beforeend', Object.entries(ATC_GROUPS)
    .filter(([code]) => present.has(code))
    .map(([code, name]) => `<option value="${code}">${code} — ${esc(name)}</option>`).join(''));
}

const THEMES = {
  auto: { icon: '◐', label: 'Auto (follows device)' },
  light: { icon: '☀', label: 'Light' },
  dark: { icon: '☾', label: 'Dark' },
};

function currentTheme() {
  return document.documentElement.dataset.theme || 'auto';
}

function renderThemeButton() {
  const theme = THEMES[currentTheme()];
  const btn = $('theme');
  btn.textContent = theme.icon;
  btn.title = `Theme: ${theme.label}. Click to change.`;
  btn.setAttribute('aria-label', btn.title);
}

function cycleTheme() {
  const order = Object.keys(THEMES);
  const next = order[(order.indexOf(currentTheme()) + 1) % order.length];
  if (next === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = next;
  try {
    if (next === 'auto') localStorage.removeItem('theme');
    else localStorage.setItem('theme', next);
  } catch (e) { /* storage unavailable: theme lasts for this visit only */ }
  renderThemeButton();
}

function bindEvents() {
  let timer;
  renderThemeButton();
  $('theme').addEventListener('click', cycleTheme);
  $('home').addEventListener('click', e => {
    e.preventDefault();
    update({ view: 'shortages', tab: VIEWS.shortages.tabs[0].id, q: '', tier3: false, atc: '', sort: '', dir: '' }, { push: true });
    syncControls();
    window.scrollTo({ top: 0 });
  });
  const clearSearch = () => {
    clearTimeout(timer);
    $('q').value = '';
    $('q-clear').hidden = true;
    if (state.q) update({ q: '' });
  };
  $('q').addEventListener('input', e => {
    $('q-clear').hidden = !e.target.value;
    clearTimeout(timer);
    timer = setTimeout(() => update({ q: e.target.value.trim() }), 150);
  });
  $('q').addEventListener('keydown', e => {
    if (e.key === 'Escape' && e.target.value) { e.preventDefault(); clearSearch(); }
  });
  $('q-clear').addEventListener('click', () => { clearSearch(); $('q').focus(); });
  $('f-tier3').addEventListener('change', e => update({ tier3: e.target.checked }));
  $('f-atc').addEventListener('change', e => update({ atc: e.target.value }));

  $('views').addEventListener('click', e => {
    const a = e.target.closest('a[data-view]');
    if (!a) return;
    e.preventDefault();
    const view = a.dataset.view;
    update({ view, tab: VIEWS[view].tabs?.[0].id || '', sort: '', dir: '' }, { push: true });
  });

  $('tabs').addEventListener('click', e => {
    const b = e.target.closest('button[data-tab]');
    if (b) update({ tab: b.dataset.tab, sort: '', dir: '' }, { push: true });
  });

  $('pager').addEventListener('click', e => {
    const b = e.target.closest('button[data-page]');
    if (!b || b.disabled) return;
    update({ page: +b.dataset.page }, { resetPage: false });
    window.scrollTo({ top: 0 });
  });

  $('content').addEventListener('click', e => {
    const copy = e.target.closest('button[data-copy]');
    if (copy) {
      navigator.clipboard?.writeText(copy.dataset.copy).then(() => {
        copy.textContent = '✓';
        setTimeout(() => { copy.textContent = '⧉'; }, 1200);
      });
      return;
    }
    const sort = e.target.closest('button[data-sort]');
    if (sort) {
      const [col, dir] = currentSort();
      const next = sort.dataset.sort === col ? (dir === 'asc' ? 'desc' : 'asc') : 'asc';
      update({ sort: sort.dataset.sort, dir: next });
      return;
    }
    const row = e.target.closest('[data-id]');
    if (row) openDetail(+row.dataset.id);
  });

  const dialog = $('detail');
  dialog.addEventListener('click', e => {
    if (e.target === dialog || e.target.closest('[data-close]')) dialog.close();
  });

  document.addEventListener('keydown', e => {
    if (e.key === '/' && document.activeElement !== $('q') && !dialog.open) {
      e.preventDefault();
      $('q').focus();
    }
  });

  window.addEventListener('popstate', () => { readURL(); syncControls(); render(); });
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

(async function init() {
  readURL();
  bindEvents();
  try {
    await load();
  } catch (err) {
    $('content').innerHTML = `<div class="empty">Could not load data (${esc(err.message)}). Try refreshing the page.</div>`;
    return;
  }
  populateAtc();
  syncControls();
  render();
})();
