// app.js — everything the page does in the browser.
//
// How the page works, start to finish:
//   1. index.html loads this file. The code at the very bottom (init) runs first.
//   2. It downloads the JSON files in data/ (made each night by the GitHub Action).
//   3. It reads the address bar (?view=...&tab=...&q=...) to know what to show.
//   4. render() builds the HTML for the current view and puts it on the page.
//   5. When you click or type, the page updates `state`, rewrites the address bar,
//      and calls render() again. The data itself is never downloaded again.
//
// The file is split into sections (Configuration, State, Helpers, Data, ...) marked by
// the long dashed comment lines, roughly in the order things happen.

// Turns on JavaScript's "strict mode", which reports more mistakes as errors.
'use strict';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
// Fixed settings. `const` means the name can't be reassigned later.

const PAGE_SIZE = 100;        // rows per page in the tables
const NEW_DAYS = 7;           // NEW / UPDATED tags
const OVERDUE_GRACE_DAYS = 2; // official definition: date passed by more than two calendar days
const CHANGE_DAYS_SHOWN = 7;  // days of updates shown in "What's new" (including today)
const STALE_HOURS = 36;       // warn when the daily update seems to have stopped

// Links to a report on the official site. `id => `...`` is an "arrow function": it takes an id
// and returns the URL. The backticks make a "template literal", where ${id} is filled in.
const OFFICIAL_URL = {
  shortage: id => `https://healthproductshortages.ca/shortage/${id}`,
  discontinuance: id => `https://healthproductshortages.ca/discontinuance/${id}`,
};

// Each status code from the data -> [text shown to people, short name used for the CSS colour].
// e.g. a report with status 'active_confirmed' shows "Actual shortage" with the class "st-actual".
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

// ATC is the international drug classification. Its first letter is the broad group;
// these names fill the "All drug classes (ATC)" dropdown.
const ATC_GROUPS = {
  A: 'Alimentary tract & metabolism', B: 'Blood & blood forming organs', C: 'Cardiovascular system',
  D: 'Dermatologicals', G: 'Genito-urinary system & sex hormones', H: 'Systemic hormonal preparations',
  J: 'Anti-infectives for systemic use', L: 'Antineoplastic & immunomodulating agents',
  M: 'Musculo-skeletal system', N: 'Nervous system', P: 'Antiparasitic products',
  R: 'Respiratory system', S: 'Sensory organs', V: 'Various',
};

// The three top-level sections (the links under the title) and the tabs inside each.
//   current:  statuses counted as "still going on" (used for the number next to the section name).
//   statuses: which reports belong in a tab.
//   recent:   a tab for everything that is NOT current (resolved, discontinued, ...).
//   tone:     colour of the tab (matched in styles.css).
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
  // "Companies" and "What's new" have no tabs; they are drawn by renderCompanies() and
  // renderChanges() instead of the table code.
  companies: { label: 'Company summary' },
  changes: { label: "What's new" },
};

// Table columns. `key` is used for sorting; `html` (optional) for display.
// Each `r` below is one report (one row). `r.brand || ''` means "the brand, or an empty
// string if there is none", so sorting never has to deal with missing values.
//   label: column heading.  cls: CSS class for the cells (e.g. 'date' for narrow date columns).
const COLUMNS = {
  drug: { label: 'Drug', cls: 'c-drug', key: r => r.brand || '', html: drugCell },
  // No tab shows a DIN column any more (the DIN is under the drug name), but it is kept
  // here so older shared links that sort by DIN still work.
  din: { label: 'DIN', cls: 'nowrap', key: r => r.din || '', html: dinCell },
  strength: { label: 'Strength', cls: 'nowrap', key: r => r.strength || '', html: strengthCell },
  company: { label: 'Company', cls: 'c-company', key: r => r.company || '' },
  // Falls back to the expected start when the company never entered an actual start date.
  // `a ? b : c` means "if a then b, otherwise c"; here it is chained to handle three cases.
  actualStart: {
    label: 'Started', cls: 'date', key: r => r.actualStart || r.anticipatedStart || '',
    html: r => r.actualStart ? esc(r.actualStart)
      : r.anticipatedStart ? `${esc(r.anticipatedStart)}<div class="sub" title="No actual start date reported">expected</div>` : '',
  },
  // Days since the shortage started (actual start, else expected start); sorts numerically.
  // `x ?? ''` is like `x || ''` but only replaces null/undefined, so a count of 0 is kept.
  days: {
    label: 'Days in shortage', cls: 'num', key: r => String(daysSince(r.actualStart || r.anticipatedStart) ?? ''),
    html: r => { const n = daysSince(r.actualStart || r.anticipatedStart); return n === null ? '' : formatNumber(n); },
  },
  anticipatedStart: { label: 'Expected start', cls: 'date', key: r => expectedStart(r) || '' },
  estEnd: { label: 'Est. end', cls: 'date', key: r => r.estEnd || '', html: r => r.estEnd ? esc(r.estEnd) : '<span class="muted">Unknown</span>' },
  discDate: { label: 'Disc. date', cls: 'date', key: r => r.actualDiscDate || r.discDate || '' },
  outcome: { label: 'Outcome', key: r => statusLabel(r.status), html: r => statusBadge(r.status) },
  changedOn: { label: 'Changed', cls: 'date', key: r => r.changedOn || '' },
  activity: { label: 'New / Updated', cls: 'c-activity', key: activityKey, html: activityTag },
  // Dates in the data look like "2026-10-19T14:03:00"; .slice(0, 10) keeps just "2026-10-19".
  updated: { label: 'Updated', cls: 'date', key: r => (r.updated || '').slice(0, 10) },
};

// Which columns each tab shows, left to right (names refer to COLUMNS above).
const TAB_COLUMNS = {
  actual: ['drug', 'company', 'strength', 'actualStart', 'days', 'estEnd', 'activity', 'updated'],
  anticipated: ['drug', 'company', 'strength', 'anticipatedStart', 'estEnd', 'activity', 'updated'],
  resolved: ['drug', 'company', 'strength', 'outcome', 'changedOn', 'updated'],
  upcoming: ['drug', 'company', 'strength', 'discDate', 'activity', 'updated'],
  discontinued: ['drug', 'company', 'strength', 'outcome', 'discDate', 'changedOn'],
};

// How each tab is sorted before anyone clicks a column heading: [column, direction].
// 'desc' = newest/largest first, 'asc' = oldest/smallest first.
const DEFAULT_SORT = {
  actual: ['updated', 'desc'],
  anticipated: ['updated', 'desc'],
  resolved: ['changedOn', 'desc'],
  upcoming: ['updated', 'desc'],
  discontinued: ['changedOn', 'desc'],
};

// Readable names for fields when "What's new" shows what changed (e.g. "Est. end: A → B").
const FIELD_LABELS = {
  status: 'Status', estEnd: 'Est. end', actualStart: 'Actual start', anticipatedStart: 'Expected start',
  actualEnd: 'Actual end', reason: 'Reason', tier3: 'Tier 3', discDate: 'Disc. date',
  actualDiscDate: 'Actual disc. date', reversed: 'Reversed', comments: 'Comments',
  mitigation: 'Mitigation', strength: 'Strength', company: 'Company',
};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
// `data` holds what was downloaded; `state` holds what the visitor is currently looking at.
// These objects are `const`, but their contents can still change (const only stops the name
// from pointing at a different object).

// data.byId: a Map (lookup table) from report id -> report, used to open the detail popup quickly.
// data.changeIndex / changeDays: the daily change logs used by "What's new".
const data = { shortages: [], discontinuations: [], byId: new Map(), meta: {}, changeIndex: null, changeDays: new Map() };
// Everything here is mirrored in the address bar, so a link reopens exactly the same view.
//   view/tab: which section and tab.  q: search text.  tier3/overdue/atc: the filters.
//   sort/dir: a column the visitor clicked to sort ('' = use DEFAULT_SORT).  page: table page.
//   day/kind: the filter chips on "What's new".
//   from: 'companies' after clicking a company, to show the "Back to Companies" link.
const state = { view: 'shortages', tab: '', q: '', tier3: false, overdue: false, atc: '', sort: '', dir: '', page: 1, day: '', kind: '', from: '' };
// Shortcut: $('count') finds the element in index.html with id="count".
const $ = id => document.getElementById(id);
// Compares text the way people expect: ignores upper/lower case and puts "Item 2" before "Item 10".
const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
// Small functions used by the rest of the file.

// "Escapes" text before it goes into HTML. Without this, a drug name containing < or &
// could break the page (or inject code). Every value from the data passes through esc().
function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Number of whole days from a date like "2026-10-01" until today (never negative).
// Returns null when there is no date. 864e5 is 86,400,000: the milliseconds in a day.
function daysSince(isoDay) {
  if (!isoDay) return null;
  // Split "2026-10-01" into [2026, 10, 1]. JavaScript months count from 0, hence `m - 1`.
  const [y, m, d] = isoDay.split('-').map(Number);
  const today = new Date();
  const start = new Date(y, m - 1, d);
  const todayMidnight = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  return Math.max(0, Math.round((todayMidnight - start) / 864e5));
}

// Anticipated shortages often carry their start date in actual_start_date only; the official
// site shows it as the expected start, so we do the same.
function expectedStart(r) {
  return r.anticipatedStart || (r.status === 'anticipated_shortage' ? r.actualStart : null) || null;
}

// Turns a Date into "YYYY-MM-DD" in the visitor's time zone. Dates in that form can be compared
// as plain text: "2026-10-19" > "2026-10-12" works because the biggest unit comes first.
function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// The date n days ago, as "YYYY-MM-DD".
function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return isoDate(d);
}

// Status code -> readable text, e.g. 'active_confirmed' -> 'Actual shortage'.
// `STATUS[s]?.[0]`: the `?.` stops safely (giving undefined) if the code isn't in STATUS;
// then we fall back to tidying up the raw code ('some_code' -> 'Some code').
function statusLabel(s) {
  return STATUS[s]?.[0] || (s ? s.replace(/_/g, ' ').replace(/^./, c => c.toUpperCase()) : '—');
}

// The coloured status pill, as HTML.
function statusBadge(s) {
  return `<span class="status st-${STATUS[s]?.[1] || 'disc'}">${esc(statusLabel(s))}</span>`;
}

// 1234 -> "1,234".
function formatNumber(n) {
  return n.toLocaleString('en-CA');
}

// The small "Tier 3" / "Late" labels after a drug name. Each line gives either the HTML or
// `false`; .filter(Boolean) drops the falses, and .join('') glues the rest together.
function tags(r) {
  return [
    r.tier3 && '<span class="tag tier3" title="Tier 3: highest potential impact">Tier 3</span>',
    r._overdue && '<span class="tag overdue" title="Expected date passed more than 2 days ago with no actual date">Overdue</span>',
    r.late && '<span class="tag late" title="Reported more than 5 days after the start date">Late</span>',
  ].filter(Boolean).join('');
}

// 'New', 'Updated' or '' for the "New / Updated" column (flags are set in prepare() below).
function activityKey(r) {
  return r._new ? 'New' : r._updatedRecently ? 'Updated' : '';
}

// The same as activityKey, but as a coloured label.
function activityTag(r) {
  const key = activityKey(r);
  return key ? `<span class="tag ${key === 'New' ? 'new' : 'upd'}">${key}</span>` : '';
}

// The "Drug" cell: brand name and tags, then ingredients · form · route, then the DIN.
// (The company has its own column, so it isn't repeated here.)
function drugCell(r) {
  const sub = [r.ingredients, r.form, r.route].filter(Boolean).join(' · ');
  return `<div class="brand">${esc(r.brand)}${tags(r)}</div>`
    + (sub ? `<div class="sub">${esc(sub)}</div>` : '')
    + (r.din ? `<div class="sub">DIN ${dinCell(r)}</div>` : '');
}

// The "Strength" cell. Combination products list one strength per ingredient, separated by
// line breaks (e.g. a multivitamin with 17 values); <br> keeps each on its own line so the
// column stays narrow. split(/\r?\n/) breaks the text at each line break.
function strengthCell(r) {
  return (r.strength || '').split(/\r?\n/).map(esc).join('<br>');
}

// The DIN: the number plus a copy button. The button stores the DIN in `data-copy`,
// which the click handler in bindEvents() reads.
function dinCell(r) {
  if (!r.din) return '';
  return `<span class="din">${esc(r.din)}</span><button class="copy" type="button" data-copy="${esc(r.din)}" title="Copy DIN" aria-label="Copy DIN ${esc(r.din)}">⧉</button>`;
}

// The search box text split into lowercase words: "Tylenol  500" -> ['tylenol', '500'].
function searchTokens() {
  return state.q.toLowerCase().split(/\s+/).filter(Boolean);
}

// True when every search word appears somewhere in the report's text (in any order).
function matchesTokens(haystack, tokens) {
  return tokens.every(t => haystack.includes(t));
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------
// Downloading the JSON files. `async` functions can `await` slow things (like downloads)
// without freezing the page; the code simply continues once the result arrives.

// Downloads one JSON file and turns it into JavaScript objects.
// optional = true: return null if the file is missing instead of failing.
async function getJSON(path, optional = false) {
  // cache: 'no-cache' makes the browser check for a newer copy instead of reusing yesterday's.
  const res = await fetch(path, { cache: 'no-cache' });
  if (!res.ok) {
    if (optional) return null;
    throw new Error(`${path}: HTTP ${res.status}`);
  }
  return res.json();
}

// Runs once per report after download to add a few helper fields. Fields starting with `_`
// are ours (not from the official data).
function prepare(r) {
  const newCutoff = daysAgo(NEW_DAYS);
  const overdueCutoff = daysAgo(OVERDUE_GRACE_DAYS);
  const created = (r.created || '').slice(0, 10);
  const updated = (r.updated || '').slice(0, 10);

  // Overdue, as defined by the official site: "an anticipated or estimated date within the
  // report has elapsed by more than two calendar days and no corresponding actual date has
  // been entered". Each expected date is checked against its own actual date:
  //   Anticipated shortage: the expected (or actual) start date has passed, so it should
  //     have become an actual shortage by now.
  //   Actual shortage: the expected start date has passed with no actual start date, OR
  //     the estimated end date has passed with no actual end date.
  //   To be discontinued: the discontinuation date has passed and there is no actual one.
  // Dates are "YYYY-MM-DD" text, so `<` compares them correctly (earlier = smaller).
  // `passed(d)` is a small helper: true when date d exists and is before the cutoff.
  const passed = d => !!d && d < overdueCutoff;
  let overdue = false;
  if (r.status === 'anticipated_shortage') overdue = passed(r.anticipatedStart) || passed(r.actualStart);
  else if (r.status === 'active_confirmed') overdue = (passed(r.anticipatedStart) && !r.actualStart) || (passed(r.estEnd) && !r.actualEnd);
  else if (r.status === 'to_be_discontinued') overdue = passed(r.discDate) && !r.actualDiscDate;
  r._overdue = overdue;

  r._new = created >= newCutoff;
  r._updatedRecently = !r._new && updated >= newCutoff;
  // _hay ("haystack"): all searchable text in one lowercase string, built once so that
  // searching while typing is fast.
  r._hay = [r.brand, r.commonName, r.ingredients, r.din, r.company, r.atc, r.atcDesc, r.strength, r.form]
    .filter(Boolean).join(' ').toLowerCase();
  return r;
}

// Downloads all main data files. Promise.all starts the four downloads at the same time and
// waits for all of them; `const [a, b, ...] =` unpacks the four results into named variables.
async function load() {
  const [meta, shortages, discontinuations, changeIndex] = await Promise.all([
    getJSON('data/meta.json'),
    getJSON('data/shortages.json'),
    getJSON('data/discontinuations.json'),
    getJSON('data/changes/index.json', true),
  ]);
  data.meta = meta;
  // .map(prepare) runs prepare() on every report and gives back the list.
  data.shortages = shortages.reports.map(prepare);
  data.discontinuations = discontinuations.reports.map(prepare);
  data.changeIndex = changeIndex || [];
  // `[...a, ...b]` joins two lists into one.
  for (const r of [...data.shortages, ...data.discontinuations]) data.byId.set(r.id, r);
}

// Downloads the daily change logs for "What's new" (data/changes/YYYY-MM-DD.json). Only done
// when that view is opened, and only for days not downloaded already.
async function loadChangeDays() {
  const days = data.changeIndex.slice(0, CHANGE_DAYS_SHOWN).filter(d => !data.changeDays.has(d.date));
  await Promise.all(days.map(async d => {
    data.changeDays.set(d.date, await getJSON(`data/changes/${d.date}.json`, true));
  }));
}

// ---------------------------------------------------------------------------
// URL state
// ---------------------------------------------------------------------------
// The address bar holds the current view, e.g. ?view=discontinuations&q=insulin. That way
// links can be shared or bookmarked, and the browser's Back button works.

// Address bar -> `state`. Anything missing or invalid falls back to a safe default.
function readURL() {
  const p = new URLSearchParams(location.search);
  state.view = VIEWS[p.get('view')] ? p.get('view') : 'shortages';
  state.tab = p.get('tab') || '';
  state.q = p.get('q') || '';
  state.tier3 = p.get('tier3') === '1';
  state.overdue = p.get('overdue') === '1';
  state.atc = p.get('atc') || '';
  state.sort = p.get('sort') || '';
  state.dir = p.get('dir') === 'asc' ? 'asc' : p.get('dir') === 'desc' ? 'desc' : '';
  state.page = Math.max(1, parseInt(p.get('page'), 10) || 1);
  // /^\d{4}-\d{2}-\d{2}$/ is a "regular expression" (text pattern) meaning "exactly YYYY-MM-DD".
  state.day = /^\d{4}-\d{2}-\d{2}$/.test(p.get('day') || '') ? p.get('day') : '';
  state.kind = CHANGE_KINDS.some(k => k.id === p.get('kind')) ? p.get('kind') : '';
  state.from = p.get('from') === 'companies' ? 'companies' : '';
  // If the tab doesn't exist in this section, use the section's first tab.
  const tabs = VIEWS[state.view].tabs;
  if (tabs && !tabs.some(t => t.id === state.tab)) state.tab = tabs[0].id;
  if (state.sort && !COLUMNS[state.sort] && !COMPANY_COLUMNS[state.sort]) state.sort = '';
}

// `state` -> address bar. Default values are left out to keep links short.
// push = true adds a new Back-button step (e.g. switching tabs); false replaces the current one
// (e.g. typing in search, so Back doesn't go through every letter).
function writeURL(push = false) {
  const p = new URLSearchParams();
  if (state.view !== 'shortages') p.set('view', state.view);
  const tabs = VIEWS[state.view].tabs;
  if (tabs && state.tab !== tabs[0].id) p.set('tab', state.tab);
  if (state.q) p.set('q', state.q);
  if (state.tier3) p.set('tier3', '1');
  if (state.overdue) p.set('overdue', '1');
  if (state.atc) p.set('atc', state.atc);
  if (state.sort) { p.set('sort', state.sort); p.set('dir', state.dir); }
  if (state.page > 1) p.set('page', state.page);
  if (state.view === 'changes' && state.day) p.set('day', state.day);
  if (state.view === 'changes' && state.kind) p.set('kind', state.kind);
  if (state.from && VIEWS[state.view].current) p.set('from', state.from);
  const qs = p.toString();
  // history.pushState / replaceState change the address bar without reloading the page.
  history[push ? 'pushState' : 'replaceState'](null, '', qs ? `?${qs}` : location.pathname);
}

// ---------------------------------------------------------------------------
// Filtering & sorting
// ---------------------------------------------------------------------------

// Keeps only the reports that pass the search box, the "Tier 3 only" box and the ATC dropdown.
// Each line reads "this filter is off, OR the report passes it".
function filtered(records) {
  const tokens = searchTokens();
  return records.filter(r =>
    (!tokens.length || matchesTokens(r._hay, tokens)) &&
    (!state.tier3 || r.tier3) &&
    (!state.overdue || r._overdue) &&
    (!state.atc || (r.atc || '').startsWith(state.atc)));
}

// Does report r belong in this tab? "Recent" tabs take everything that isn't current;
// other tabs take the statuses they list.
function inTab(view, tab, r) {
  return tab.recent ? !view.current.includes(r.status) : tab.statuses.includes(r.status);
}

// The sort in use: the column the visitor clicked, or else the tab's default.
function currentSort() {
  if (state.sort) return [state.sort, state.dir || 'asc'];
  if (state.view === 'companies') return ['actual', 'desc'];   // most actual shortages first
  return DEFAULT_SORT[state.tab];
}

// Returns a sorted copy of the rows (.slice() copies, so the original list isn't reordered).
// The compare function returns a negative number if a goes first, positive if b goes first.
function sortRows(rows, [colId, dir]) {
  const key = COLUMNS[colId].key;
  const m = dir === 'asc' ? 1 : -1;   // multiplying by -1 reverses the order
  return rows.slice().sort((a, b) => {
    const x = key(a), y = key(b);
    if (!x && !y) return 0;
    if (!x) return 1;          // blanks last regardless of direction
    if (!y) return -1;
    return m * collator.compare(String(x), String(y));
  });
}

// All rows for the current tab: filtered, limited to the tab, and sorted.
// `data[state.view]` picks data.shortages or data.discontinuations by name.
function visibleRows() {
  const view = VIEWS[state.view];
  const tab = view.tabs.find(t => t.id === state.tab);
  return sortRows(filtered(data[state.view]).filter(r => inTab(view, tab, r)), currentSort());
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
// These functions build HTML as text and put it into the page with `.innerHTML = ...`.
// render() redraws everything from `state` and `data`, so after any change the page only
// needs one call to render() to be up to date.

function render() {
  renderUpdated();
  renderViews();
  // The "Back to Companies" link, only on Shortages / Discontinuations after clicking a company.
  $('back').hidden = !(state.from === 'companies' && VIEWS[state.view].current);
  // "Companies" and "What's new" have no tabs, filters or pages, so those are hidden there.
  const noTabs = state.view === 'companies' || state.view === 'changes';
  $('tabs').hidden = noTabs;
  $('toolbar').hidden = noTabs;
  $('pager').hidden = noTabs;
  if (state.view === 'companies') return renderCompanies();
  if (state.view === 'changes') return renderChanges();
  renderTabs();
  renderTable();
}

// The "Updated ..." text under the title. It is shown in the visitor's own time zone.
// If the last update is more than STALE_HOURS old, it warns that the data may be out of date.
function renderUpdated() {
  const ts = data.meta.lastChecked;
  if (!ts) return;
  const d = new Date(ts);
  const el = $('updated');
  el.textContent = `Updated ${d.toLocaleString('en-CA', { dateStyle: 'medium', timeStyle: 'short' })}`;
  // Date.now() - d.getTime() is the age in milliseconds; 36e5 (3,600,000) ms is one hour.
  const stale = (Date.now() - d.getTime()) / 36e5 > STALE_HOURS;
  el.classList.toggle('stale', stale);
  el.title = stale ? 'The daily update has not run recently; data may be out of date.' : '';
  if (stale) el.textContent += ' — may be out of date';
}

// The section links (Shortages / Discontinuations / What's new) with their counts.
// Normally the count is how many are current; while searching it's how many match.
function renderViews() {
  const searching = !!state.q;   // `!!` turns any value into true/false
  // Object.entries gives [name, value] pairs, e.g. ['shortages', { label: ..., tabs: ... }].
  $('views').innerHTML = Object.entries(VIEWS).map(([id, v]) => {
    let n = '';
    if (v.current) {   // only Shortages and Discontinuations have counts
      const rows = searching ? filtered(data[id]) : data[id].filter(r => v.current.includes(r.status));
      n = `<span class="n">${formatNumber(rows.length)}${searching ? ' match' + (rows.length === 1 ? '' : 'es') : ''}</span>`;
    }
    // aria-current tells screen readers (and the CSS) which section is selected.
    return `<a href="?view=${id}" data-view="${id}"${id === state.view ? ' aria-current="page"' : ''}>${esc(v.label)}${n}</a>`;
  }).join('');
}

// The big tab buttons with counts (e.g. "512 Actual shortage").
function renderTabs() {
  const view = VIEWS[state.view];
  const rows = filtered(data[state.view]);
  // How many days the "recent" tabs cover, as set by the nightly script (30 if unknown).
  const days = data.meta.recentDays?.[state.view === 'shortages' ? 'shortage' : 'discontinuance'] || 30;
  $('tabs').innerHTML = view.tabs.map(t => {
    const n = rows.filter(r => inTab(view, t, r)).length;
    const label = t.recent ? `${t.label} (last ${days} days)` : t.label;
    return `<button type="button" role="tab" data-tab="${t.id}" data-tone="${t.tone}" aria-selected="${t.id === state.tab}">
      <span class="n">${formatNumber(n)}</span><span class="l">${esc(label)}</span></button>`;
  }).join('');
}

// The table of reports for the current tab, plus the "1–100 of 512" count and Prev/Next buttons.
function renderTable() {
  const rows = visibleRows();
  // Work out which slice of rows is on this page.
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  state.page = Math.min(state.page, pages);
  const start = (state.page - 1) * PAGE_SIZE;
  const pageRows = rows.slice(start, start + PAGE_SIZE);
  const cols = TAB_COLUMNS[state.tab];
  const [sortCol, sortDir] = currentSort();

  $('count').textContent = rows.length
    ? `${formatNumber(start + 1)}–${formatNumber(start + pageRows.length)} of ${formatNumber(rows.length)}`
    : '';

  // Nothing to show: explain why instead of drawing an empty table.
  if (!rows.length) {
    const recentTab = VIEWS[state.view].tabs.find(t => t.id === state.tab).recent;
    $('content').innerHTML = `<div class="empty">${
      state.q || state.tier3 || state.overdue || state.atc
        ? 'No reports match these filters.'
        : recentTab ? 'No status changes recorded yet. They appear here as the daily update detects them.' : 'No reports.'
    }</div>`;
    $('pager').innerHTML = '';
    return;
  }

  // Header row: each heading is a button (data-sort) so clicking it sorts by that column.
  // aria-sort marks the sorted column for screen readers and for the arrow drawn by the CSS.
  const head = cols.map(c => {
    const aria = c === sortCol ? ` aria-sort="${sortDir === 'asc' ? 'ascending' : 'descending'}"` : '';
    return `<th scope="col"${aria}><button type="button" data-sort="${c}">${esc(COLUMNS[c].label)}</button></th>`;
  }).join('');

  // One <tr> per report. data-id lets a click find which report to open; tabindex="0" lets
  // keyboard users Tab to the row. Each cell uses the column's `html` function if it has
  // one, otherwise its `key` text. data-label is shown as a caption on narrow (phone) screens.
  const body = pageRows.map(r => `<tr data-id="${r.id}" tabindex="0" aria-haspopup="dialog">${cols.map(c => {
    const col = COLUMNS[c];
    const content = col.html ? col.html(r) : esc(col.key(r));
    return `<td class="${col.cls || ''}" data-label="${esc(col.label)}">${content}</td>`;
  }).join('')}</tr>`).join('');

  $('content').innerHTML = `<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;

  // Prev / Next buttons, only when there is more than one page. data-page holds the page
  // number each button goes to.
  $('pager').innerHTML = pages > 1
    ? `<button type="button" data-page="${state.page - 1}"${state.page === 1 ? ' disabled' : ''}>‹ Prev</button>
       <span class="muted">Page ${state.page} of ${pages}</span>
       <button type="button" data-page="${state.page + 1}"${state.page === pages ? ' disabled' : ''}>Next ›</button>`
    : '';
}

// A field's value as text for "What's new" (empty -> 'none', true/false -> 'Yes'/'No', ...).
function formatValue(field, value) {
  if (value === null || value === undefined || value === '') return field === 'estEnd' ? 'Unknown' : 'none';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (field === 'status') return statusLabel(value);
  return String(value);
}

// The groups on "What's new", in display order (also the "Show:" chips).
//   label: the chip text.  tag: the shorter word in the table's "Change" column.  cls: its colour.
const CHANGE_KINDS = [
  { id: 'new', label: 'New', tag: 'New', cls: 'new' },
  { id: 'updated', label: 'Updated', tag: 'Updated', cls: 'upd' },
  { id: 'closed', label: 'Resolved / discontinued', tag: 'Closed', cls: 'closed' },
];

// Is this report still active (a current shortage or an upcoming discontinuation)?
function isCurrent(r) {
  return VIEWS.shortages.current.includes(r.status) || VIEWS.discontinuations.current.includes(r.status);
}

// Field-level details from the daily change log, by report id: [{ date, html }].
// Only available for changes made since tracking started; entries without them just say "Updated".
function changeDetails() {
  const byId = new Map();
  // Small helper defined inside this function: adds one line to a report's list.
  const add = (id, date, html) => {
    if (!byId.has(id)) byId.set(id, []);
    byId.get(id).push({ date, html });
  };
  // One change as HTML, e.g. "Est. end: 2026-11-01 → 2026-12-15".
  const fieldHtml = c => c.field === 'status'
    ? `${statusBadge(c.from)} → ${statusBadge(c.to)}`
    : `<b>${esc(FIELD_LABELS[c.field] || c.field)}:</b> ${esc(formatValue(c.field, c.from))} → ${esc(formatValue(c.field, c.to))}`;
  // Go through each day's log and collect its changes by report.
  for (const [date, day] of data.changeDays) {
    if (!day) continue;
    for (const e of day.updated || []) for (const c of e.changes || []) add(e.id, date, fieldHtml(c));
    for (const e of day.statusChanged || []) if (e.from) add(e.id, date, `${statusBadge(e.from)} → ${statusBadge(e.to)}`);
  }
  return byId;
}

// The column headings of each day's table on "What's new", left to right.
const CHANGE_HEADINGS = ['Change', 'Type', 'Drug', 'Company', 'Strength', 'Status', 'What changed'];

// One report's row in a "What's new" table. `kind` is one of CHANGE_KINDS; `details` are the
// field changes from the change log (may be empty). The cells use the same helpers as the
// Shortages tables (drugCell), so a row looks the same in both places.
// data-label on each cell is the caption shown on phones, where rows become cards.
function whatsNewRow(r, kind, details) {
  const cells = [
    ['nowrap', `<span class="tag ${kind.cls}">${kind.tag}</span>`],
    ['nowrap', r.type === 'shortage' ? 'Shortage' : 'Discontinuation'],
    ['c-drug', drugCell(r)],
    ['c-company', esc(r.company || '')],
    ['nowrap', strengthCell(r)],
    ['nowrap', statusBadge(r.status)],
    ['chg', details.map(d => `<div>${d.html}</div>`).join('')],
  ];
  return `<tr data-id="${r.id}" tabindex="0" aria-haspopup="dialog">${cells.map(([cls, html], i) =>
    `<td class="${cls}" data-label="${CHANGE_HEADINGS[i]}">${html}</td>`).join('')}</tr>`;
}

// What's new lists reports by their own updated date (like the official homepage), so it works
// without any tracking history. Field-level details from the change log are added when known.
// A day bar and a kind bar at the top filter the list.
// changeKind: which group a report goes in. Created that day = 'new'; otherwise 'updated'
// if still active, or 'closed' if resolved/discontinued.
function changeKind(r, day) {
  if ((r.created || '').slice(0, 10) === day) return 'new';
  return isCurrent(r) ? 'updated' : 'closed';
}

// "2026-10-19" -> "Mon, Oct 19". The T12:00:00 (noon) keeps the date from slipping to the
// day before in time zones west of UTC.
function shortDay(day) {
  return new Date(`${day}T12:00:00`).toLocaleDateString('en-CA', { weekday: 'short', month: 'short', day: 'numeric' });
}

// The heading above each day's table: "2026-10-19" -> "Monday, October 19, 2026".
function longDay(day) {
  return new Date(`${day}T12:00:00`).toLocaleDateString('en-CA',
    { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
}

// One filter chip button. `attr` is 'data-day' or 'data-kind'; the click handler reads it.
// aria-pressed shows whether it's selected.
function chip(attr, value, label, count, selected) {
  return `<button type="button" class="chip" ${attr}="${value}" aria-pressed="${selected}">${esc(label)}<span class="n">${formatNumber(count)}</span></button>`;
}

// The "What's new" view: reports updated in the past week, grouped by day and then by kind.
async function renderChanges() {
  $('content').innerHTML = '<p class="muted">Loading…</p>';
  await loadChangeDays();
  // While the change logs were downloading, the visitor may have clicked away; if so, stop.
  if (state.view !== 'changes') return;

  const details = changeDetails();
  const tokens = searchTokens();
  const since = daysAgo(CHANGE_DAYS_SHOWN - 1);
  // Collect every report updated in the past week (and matching the search, if any).
  const entries = [];
  for (const r of [...data.shortages, ...data.discontinuations]) {
    const day = (r.updated || '').slice(0, 10);
    if (!day || day < since || (tokens.length && !matchesTokens(r._hay, tokens))) continue;
    entries.push({ r, day, kind: changeKind(r, day) });
  }

  // Each bar's counts respect the other bar's selection.
  // `new Set(...)` removes duplicate days; sort().reverse() puts the newest day first.
  const days = [...new Set(entries.map(e => e.day))].sort().reverse();
  const inKind = e => !state.kind || e.kind === state.kind;
  const inDay = e => !state.day || e.day === state.day;
  const dayBar = [chip('data-day', '', 'All week', entries.filter(inKind).length, !state.day)]
    .concat(days.map(d => chip('data-day', d, shortDay(d), entries.filter(e => e.day === d && inKind(e)).length, state.day === d)));
  const kindBar = [chip('data-kind', '', 'All', entries.filter(inDay).length, !state.kind)]
    .concat(CHANGE_KINDS.map(k => chip('data-kind', k.id, k.label, entries.filter(e => e.kind === k.id && inDay(e)).length, state.kind === k.id)));
  const bars = `<div class="chips" role="group" aria-label="Day">${dayBar.join('')}</div>
    <div class="chips" role="group" aria-label="Kind of change"><span class="muted">Show:</span>${kindBar.join('')}</div>`;

  // Build one <section> per day: a heading with the full date, then a table of that day's
  // reports. Rows are grouped New, then Updated, then Closed, and sorted by brand within each.
  const shown = entries.filter(e => inDay(e) && inKind(e));
  const head = `<thead><tr>${CHANGE_HEADINGS.map(h => `<th scope="col">${h}</th>`).join('')}</tr></thead>`;
  const html = days.filter(d => !state.day || d === state.day).map(day => {
    const dayEntries = shown.filter(e => e.day === day);
    if (!dayEntries.length) return '';
    const rows = CHANGE_KINDS.flatMap(k => dayEntries.filter(e => e.kind === k.id).map(e => e.r)
      .sort((a, b) => collator.compare(a.brand || '', b.brand || ''))
      // Only show change details logged on or after this day, so older edits aren't repeated.
      .map(r => whatsNewRow(r, k, (details.get(r.id) || []).filter(d => d.date >= day))));
    // The small counts next to the date, e.g. "3 new · 12 updated · 2 closed".
    const counts = CHANGE_KINDS.map(k => [k, dayEntries.filter(e => e.kind === k.id).length])
      .filter(([, n]) => n).map(([k, n]) => `${formatNumber(n)} ${k.tag.toLowerCase()}`).join(' · ');
    return `<section class="day"><h2>${esc(longDay(day))}<span class="muted">${counts}</span></h2>
      <div class="table-wrap"><table>${head}<tbody>${rows.join('')}</tbody></table></div></section>`;
  }).join('');

  // Message for when nothing matches.
  const empty = `<div class="empty">No reports ${tokens.length ? `matching “${esc(state.q)}” ` : ''}${
    state.day || state.kind ? 'for this selection' : `updated in the past ${CHANGE_DAYS_SHOWN} days`}.</div>`;
  $('content').innerHTML = bars + (html || empty);
}

// ---------------------------------------------------------------------------
// Companies
// ---------------------------------------------------------------------------
// One row per company, counting its OPEN reports only (actual, anticipated and to be
// discontinued), like the matching columns of the official site's company summary.
// Closed reports aren't counted, since the site only keeps them for 30 days.

// The table's columns. `key` gives the value used for sorting (numbers for the counts).
//   label: column heading.  num: true for number columns (right-aligned, sorted biggest first).
const COMPANY_COLUMNS = {
  company: { label: 'Company', key: c => c.name },
  actual: { label: 'Actual shortage', num: true, key: c => c.actual },
  anticipated: { label: 'Anticipated shortage', num: true, key: c => c.anticipated },
  tier3: { label: 'Tier 3', num: true, key: c => c.tier3 },
  upcoming: { label: 'To be discontinued', num: true, key: c => c.upcoming },
  overdue: { label: 'Overdue', num: true, key: c => c.overdue },
  pctOverdue: { label: '% overdue', num: true, key: c => c.pctOverdue },
  late: { label: 'Late', num: true, key: c => c.late },
};

// Adds up every open report by company: [{ name, actual, anticipated, tier3, upcoming, ... }].
function companyRows() {
  const byName = new Map();
  for (const r of [...data.shortages, ...data.discontinuations]) {
    if (!isCurrent(r)) continue;
    const name = r.company || '(No company listed)';
    if (!byName.has(name)) byName.set(name, { name, actual: 0, anticipated: 0, tier3: 0, upcoming: 0, overdue: 0, late: 0 });
    const c = byName.get(name);
    if (r.status === 'active_confirmed') c.actual++;
    else if (r.status === 'anticipated_shortage') c.anticipated++;
    else c.upcoming++;   // the only other open status is to_be_discontinued
    if (r.tier3) c.tier3++;   // Tier 3 = highest-impact shortage (only shortages have it)
    if (r._overdue) c.overdue++;
    if (r.late) c.late++;
  }
  // % overdue = overdue reports out of all the company's open reports (as on the official site).
  return [...byName.values()].map(c => ({ ...c, pctOverdue: Math.round(100 * c.overdue / (c.actual + c.anticipated + c.upcoming)) }));
}

// The "Companies" view: the company table, filtered by the search box and sortable by column.
function renderCompanies() {
  const tokens = searchTokens();
  const all = companyRows();
  const rows = all.filter(c => !tokens.length || matchesTokens(c.name.toLowerCase(), tokens));
  const [sortCol, sortDir] = COMPANY_COLUMNS[currentSort()[0]] ? currentSort() : ['actual', 'desc'];
  const key = COMPANY_COLUMNS[sortCol].key;
  const m = sortDir === 'asc' ? 1 : -1;
  // Sort by the chosen column; ties are broken by company name so the order never jumps around.
  rows.sort((a, b) => {
    const x = key(a), y = key(b);
    const diff = typeof x === 'number' ? x - y : collator.compare(x, y);
    return m * diff || collator.compare(a.name, b.name);
  });

  // Header row: each heading is a sort button, as in the other tables.
  const head = Object.entries(COMPANY_COLUMNS).map(([id, col]) => {
    const aria = id === sortCol ? ` aria-sort="${sortDir === 'asc' ? 'ascending' : 'descending'}"` : '';
    return `<th scope="col"${aria}><button type="button" data-sort="${id}">${esc(col.label)}</button></th>`;
  }).join('');
  // A count cell: zero is greyed out so the non-zero numbers stand out.
  const num = (n, suffix = '') => n ? `${formatNumber(n)}${suffix}` : `<span class="muted">0${suffix}</span>`;
  // data-company lets a click find which company was chosen (see bindEvents()).
  const body = rows.map(c => `<tr data-company="${esc(c.name)}" tabindex="0">
    <td class="brand" data-label="Company">${esc(c.name)}</td>
    ${['actual', 'anticipated', 'tier3', 'upcoming', 'overdue'].map(id =>
      `<td class="num" data-label="${COMPANY_COLUMNS[id].label}">${num(c[id])}</td>`).join('')}
    <td class="num" data-label="% overdue">${num(c.pctOverdue, '%')}</td>
    <td class="num" data-label="Late">${num(c.late)}</td></tr>`).join('');

  // The disclaimer box, then a line with the company count.
  const intro = `<div class="notice">Not the official company summary.
    These numbers are worked out by this site from open reports only, so they differ from the
    summary on <a href="https://healthproductshortages.ca" target="_blank" rel="noopener">Health Product Shortages Canada</a>:
    reports closed more than 30 days ago aren't included, Late counts open reports only
    (the official count covers every report ever filed), Overdue may be off by a few,
    and some companies are named or grouped differently. Use the official site for exact figures.</div>
    <p class="muted intro">${formatNumber(rows.length)} ${tokens.length ? `of ${formatNumber(all.length)} ` : ''}companies with open reports.
    <span class="tag tier3">Tier 3</span>, <span class="tag overdue">Overdue</span> and <span class="tag late">Late</span> are explained at the bottom of the page.
    Click a company to see its reports.</p>`;
  $('content').innerHTML = intro + (rows.length
    ? `<div class="table-wrap"><table>${'<thead><tr>' + head + '</tr></thead>'}<tbody>${body}</tbody></table></div>`
    : `<div class="empty">No companies match “${esc(state.q)}”.</div>`);
}

// Clicking a company opens its reports: the Shortages section if it has any open shortages
// (on the Actual tab if it has actual ones), otherwise its upcoming discontinuations.
// The company name goes in the search box, which narrows the list to that company.
function openCompany(name) {
  const c = companyRows().find(c => c.name === name);
  if (!c) return;
  const view = c.actual || c.anticipated ? 'shortages' : 'discontinuations';
  const tab = view === 'discontinuations' ? 'upcoming' : c.actual ? 'actual' : 'anticipated';
  companyReturn = { q: state.q, sort: state.sort, dir: state.dir };
  update({ view, tab, q: name, sort: '', dir: '', from: 'companies' }, { push: true });
  syncControls();
  window.scrollTo({ top: 0 });
}

// The Companies table's search and sort from just before a company was clicked, so the
// "Back to Companies" link can put them back. (Empty if the page was reloaded since.)
let companyReturn = {};

// The "Back to Companies" link: return to the table as it was.
function backToCompanies() {
  update({ view: 'companies', tab: '', q: companyReturn.q || '', sort: companyReturn.sort || '',
    dir: companyReturn.dir || '', from: '' }, { push: true });
  syncControls();
  window.scrollTo({ top: 0 });
}

// ---------------------------------------------------------------------------
// Detail dialog
// ---------------------------------------------------------------------------
// The popup with every field of a report, opened by clicking a row.

function openDetail(id) {
  const r = data.byId.get(id);
  if (!r) return;
  const isShortage = r.type === 'shortage';
  // Each row is [label, value]; the third item `true` means the value is already HTML.
  // `...(isShortage ? [...] : [...])` inserts the shortage fields or the discontinuation fields.
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
      ['Expected start', expectedStart(r)],
      // Already shown as the expected start (see expectedStart), so don't repeat it here.
      ['Actual start', r.status === 'anticipated_shortage' && !r.anticipatedStart ? null : r.actualStart],
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
  // Drop rows with no value. `([, v])` skips the label and takes just the value.
  ].filter(([, v]) => v);

  // <dl>, <dt> and <dd> are HTML's list of label/value pairs.
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
  // showModal() opens the <dialog> on top of the page; Esc closes it automatically.
  dialog.showModal();
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------
// Reacting to clicks and typing. addEventListener('click', fn) means "run fn on each click".

// Makes the search box, checkbox and dropdown show what's in `state`
// (e.g. after the Back button changes the state).
function syncControls() {
  $('q').value = state.q;
  $('q-clear').hidden = !state.q;
  $('f-tier3').checked = state.tier3;
  $('f-overdue').checked = state.overdue;
  $('f-atc').value = state.atc;
}

// The one way the page changes: merge `changes` into `state`, update the address bar, redraw.
// e.g. update({ tab: 'resolved' }). Most changes go back to page 1, unless resetPage is false.
// `{ push = false, resetPage = true } = {}` gives default values when options aren't passed.
function update(changes, { push = false, resetPage = true } = {}) {
  Object.assign(state, changes);
  if (resetPage) state.page = 1;
  writeURL(push);
  render();
}

// Fills the ATC dropdown, listing only groups that some report actually uses.
function populateAtc() {
  const present = new Set([...data.shortages, ...data.discontinuations].map(r => (r.atc || '')[0]).filter(Boolean));
  $('f-atc').insertAdjacentHTML('beforeend', Object.entries(ATC_GROUPS)
    .filter(([code]) => present.has(code))
    .map(([code, name]) => `<option value="${code}">${code} — ${esc(name)}</option>`).join(''));
}

// Light/dark theme button. The choice is stored as data-theme="light"/"dark" on the <html>
// element (the CSS reads it) and saved in localStorage so it's remembered next visit.
// 'auto' means no data-theme, so the page follows the device's setting.
const THEMES = {
  auto: { icon: '◐', name: 'Auto', label: 'Auto (follows device)' },
  light: { icon: '☀', name: 'Light', label: 'Light' },
  dark: { icon: '☾', name: 'Dark', label: 'Dark' },
};

function currentTheme() {
  return document.documentElement.dataset.theme || 'auto';
}

// Shows the current theme's icon and name on the button.
function renderThemeButton() {
  const theme = THEMES[currentTheme()];
  const btn = $('theme');
  btn.innerHTML = `<span class="theme-icon" aria-hidden="true">${theme.icon}</span><span class="theme-name">${theme.name}</span>`;
  btn.title = `Theme: ${theme.label}. Click to change.`;
  btn.setAttribute('aria-label', btn.title);
}

// Each click moves to the next theme: auto -> light -> dark -> auto.
// `% order.length` wraps around from the last one back to the first.
function cycleTheme() {
  const order = Object.keys(THEMES);
  const next = order[(order.indexOf(currentTheme()) + 1) % order.length];
  if (next === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = next;
  // try/catch: if saving fails (e.g. private browsing), carry on instead of breaking the page.
  try {
    if (next === 'auto') localStorage.removeItem('theme');
    else localStorage.setItem('theme', next);
  } catch (e) { /* storage unavailable: theme lasts for this visit only */ }
  renderThemeButton();
}

// Connects all the click/typing handlers. Runs once when the page loads.
//
// Since the tables and buttons are redrawn all the time, most handlers are attached to a
// container that stays put (like #content) rather than to each button. When something
// inside is clicked, e.target is what was clicked, and e.target.closest('button[data-sort]')
// finds the nearest such button around it (or null). This is called "event delegation".
function bindEvents() {
  let timer;
  renderThemeButton();
  $('theme').addEventListener('click', cycleTheme);
  // Clicking the site title resets everything and goes back to the first tab.
  $('home').addEventListener('click', e => {
    e.preventDefault();   // stop the link from reloading the page; we redraw instead
    update({ view: 'shortages', tab: VIEWS.shortages.tabs[0].id, q: '', tier3: false, overdue: false, atc: '', sort: '', dir: '', day: '', kind: '', from: '' }, { push: true });
    syncControls();
    window.scrollTo({ top: 0 });
  });
  const clearSearch = () => {
    clearTimeout(timer);
    $('q').value = '';
    $('q-clear').hidden = true;
    if (state.q) update({ q: '' });
  };
  // Search while typing. setTimeout waits 150 ms after the last key before searching, and
  // clearTimeout cancels the wait if another key comes first, so fast typing doesn't redraw
  // the page on every letter.
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
  $('f-overdue').addEventListener('change', e => update({ overdue: e.target.checked }));
  $('f-atc').addEventListener('change', e => update({ atc: e.target.value }));

  // Section links: switch section, start on its first tab and default sort.
  $('views').addEventListener('click', e => {
    const a = e.target.closest('a[data-view]');
    if (!a) return;
    e.preventDefault();
    const view = a.dataset.view;   // dataset.view reads the data-view="..." attribute
    // Keep the "Back to Companies" link when moving between Shortages and Discontinuations.
    const from = VIEWS[view].current ? state.from : '';
    update({ view, tab: VIEWS[view].tabs?.[0].id || '', sort: '', dir: '', day: '', kind: '', from }, { push: true });
  });

  $('back').addEventListener('click', e => {
    e.preventDefault();
    backToCompanies();
  });

  $('tabs').addEventListener('click', e => {
    const b = e.target.closest('button[data-tab]');
    if (b) update({ tab: b.dataset.tab, sort: '', dir: '' }, { push: true });
  });

  // Prev / Next. `+b.dataset.page` turns the text "2" into the number 2.
  $('pager').addEventListener('click', e => {
    const b = e.target.closest('button[data-page]');
    if (!b || b.disabled) return;
    update({ page: +b.dataset.page }, { resetPage: false });
    window.scrollTo({ top: 0 });
  });

  // Every click inside the main area. Checks what was clicked, most specific first, and
  // `return`s once handled so that e.g. clicking the copy button doesn't also open the row.
  $('content').addEventListener('click', e => {
    // DIN copy button: copy, show a ✓ for 1.2 seconds, then put the icon back.
    const copy = e.target.closest('button[data-copy]');
    if (copy) {
      navigator.clipboard?.writeText(copy.dataset.copy).then(() => {
        copy.textContent = '✓';
        setTimeout(() => { copy.textContent = '⧉'; }, 1200);
      });
      return;
    }
    // A "What's new" day or kind chip.
    const chip = e.target.closest('button[data-day], button[data-kind]');
    if (chip) {
      if ('day' in chip.dataset) update({ day: chip.dataset.day }, { push: true });
      else update({ kind: chip.dataset.kind }, { push: true });
      return;
    }
    // A column heading: clicking the sorted column again flips the direction;
    // a different column starts ascending.
    const sort = e.target.closest('button[data-sort]');
    if (sort) {
      const [col, dir] = currentSort();
      // A new column starts A→Z, except number columns on Companies, which start biggest first.
      const first = COMPANY_COLUMNS[sort.dataset.sort]?.num && state.view === 'companies' ? 'desc' : 'asc';
      const next = sort.dataset.sort === col ? (dir === 'asc' ? 'desc' : 'asc') : first;
      update({ sort: sort.dataset.sort, dir: next });
      return;
    }
    // A row on the Companies table opens that company's reports.
    const company = e.target.closest('[data-company]');
    if (company) return openCompany(company.dataset.company);
    // Anything else inside a row opens that report's details.
    const row = e.target.closest('[data-id]');
    if (row) openDetail(+row.dataset.id);
  });

  // Keyboard: Tab moves between rows, Enter or Space opens the focused row.
  $('content').addEventListener('keydown', e => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('[data-company]')) {
      e.preventDefault();
      openCompany(e.target.dataset.company);
    }
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('[data-id]')) {
      e.preventDefault();
      openDetail(+e.target.dataset.id);
    }
  });

  // Close the popup on the ✕ button, or on a click on the dark area around it
  // (that click lands on the <dialog> element itself).
  const dialog = $('detail');
  let opener = null;
  dialog.addEventListener('click', e => {
    if (e.target === dialog || e.target.closest('[data-close]')) dialog.close();
  });
  // Return focus to the row that opened the dialog, so keyboard users keep their place.
  $('content').addEventListener('focusin', e => { if (e.target.matches('[data-id]')) opener = e.target; });
  dialog.addEventListener('close', () => { if (opener?.isConnected) opener.focus({ preventScroll: true }); });

  // Pressing "/" anywhere jumps to the search box.
  document.addEventListener('keydown', e => {
    if (e.key === '/' && document.activeElement !== $('q') && !dialog.open) {
      e.preventDefault();
      $('q').focus();
    }
  });

  // The browser's Back/Forward buttons: re-read the address bar and redraw.
  window.addEventListener('popstate', () => { readURL(); syncControls(); render(); });
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
// The starting point. `(async function init() { ... })();` defines a function and runs it
// straight away. The steps are in order: read the address bar, hook up the buttons,
// download the data, fill the dropdown, then draw the page.

(async function init() {
  readURL();
  bindEvents();
  try {
    await load();
  } catch (err) {
    // A download failed: show a message instead of a blank page.
    $('content').innerHTML = `<div class="empty">Could not load data (${esc(err.message)}). Try refreshing the page.</div>`;
    return;
  }
  populateAtc();
  syncControls();
  render();
})();
