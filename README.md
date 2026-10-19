# Health Product Shortages Canada Viewer

A simpler way to browse Canadian drug shortage and discontinuation reports from
[Health Product Shortages Canada](https://healthproductshortages.ca). The data is
refreshed daily.

**Live site:** https://zeptotech.github.io/drugshortages/

This is an independent tool for healthcare professionals. It is not affiliated with Health
Canada. Always confirm details with the official report, which is linked from
each entry. Use at your own discretion.

## Features

- **Shortages**: tabs for *Actual shortage*, *Anticipated shortage* and
  *Resolved / avoided* (last 30 days), each with a count. The *Actual shortage*
  tab shows how many days each shortage has lasted. When a company never entered
  an actual start date, the expected start is used and marked "expected".
- **Discontinuations**: tabs for *To be discontinued* and *Discontinued*
  (last 30 days).
- **What's new**: reports updated in the past 7 days, grouped by day into new,
  updated, and resolved/discontinued (like the official homepage). Bars at the
  top filter by day and by kind of change. Where the
  daily change log knows exactly what changed (e.g. a new estimated end date),
  that is shown too.
- **Search** by brand, ingredient, DIN, company or ATC code. Tab counts update
  as you type, so you can see where the matches are.
- **Filters**: Tier 3 only, drug class (ATC group).
- **Tier 3** tag on the shortages with the highest potential impact.
- **Late** tag on reports filed more than 5 days after the anticipated or actual
  start date (the API's `late_submission` flag).
- **New / Updated** column for reports created or updated in the last 7 days.
- **Detail view**: click a row (or Tab to it and press Enter) to see every
  field, including mitigation, company comments and Health Canada comments, plus
  a link to the official report.
- **Shareable links**: the view, tab, search and filters are kept in the URL.
- Sortable columns, copy-to-clipboard DINs, `/` to jump to search, and a phone
  layout.
- **Theme** button: Auto (follows your device), Light or Dark. The choice is
  remembered.
- **Last updated** time under the title, in your own time zone. It warns if the
  daily update hasn't run in over 36 hours.

## How it works

There is no server. A scheduled GitHub Actions job is the backend, and the site
is static files served by GitHub Pages.

```
Daily, ~midnight Eastern (GitHub Actions)         Anytime (browser)
┌───────────────────────────────────────┐   ┌───────────────────────────┐
│ scripts/fetch_and_diff.py             │   │ index.html + app.js       │
│  1. log in to the API (repo secrets)  │   │  loads data/*.json        │
│  2. pull current + recent reports     │   │  search, filters, sorting │
│  3. compare with the previous data    │   │  all run in the browser   │
│  4. write data/*.json                 │   │  (no API calls)           │
│ commit data/ → deploy GitHub Pages ───┼──►│                           │
└───────────────────────────────────────┘   └───────────────────────────┘
```

The API password lives only in GitHub Actions secrets. The browser never talks
to the API.

### What the daily job fetches

| Statuses | How | Requests |
|---|---|---|
| `active_confirmed`, `anticipated_shortage`, `to_be_discontinued` | Full pull, sorted by id ascending, 100 per page (as the API requires for multi-report extraction) | ~25 |
| `resolved`, `avoided_shortage`, `discontinued`, `reversed` | Updated in the last 30 days only, newest first | ~5 |
| Reports that left the current lists since the last run | One detail lookup each, to see what they became | a few |

The API allows 1,000 requests per hour, and a run uses about 30–45.

The job keeps only the English fields the site needs, compares them with the
previous snapshot, and records what changed. It aborts without touching the data
if the login fails, the API errors, or a status count suddenly drops below half
of the previous run's (use `--force` to override a real drop).

### Data files

| File | Contents |
|---|---|
| `data/shortages.json` | Current shortages plus those resolved or avoided in the last 30 days |
| `data/discontinuations.json` | Upcoming discontinuations plus those discontinued or reversed in the last 30 days |
| `data/meta.json` | Last check time and counts per status |
| `data/changes/YYYY-MM-DD.json` | New, updated and status-changed reports for that day |
| `data/changes/index.json` | Days with changes, newest first |

Each report is written on its own line, so the daily data commits show exactly
which reports changed.

## Setup

1. **API account:** create and verify an account on
   [healthproductshortages.ca](https://healthproductshortages.ca).
2. **Secrets:** in the repo, go to **Settings → Secrets and variables → Actions**
   and add `HPS_EMAIL` and `HPS_PASSWORD`.
3. **Pages:** go to **Settings → Pages → Source** and choose **GitHub Actions**.
4. **Run it:** go to **Actions → Update data and deploy → Run workflow**, or
   wait for the daily schedule.

The workflow (`.github/workflows/update-data.yml`):

- **On schedule or "Run workflow":** fetches data, commits `data/` if it
  changed, and deploys.
- **On a push to `main`:** only redeploys the site.

The schedule is `0 5 * * *`: 05:00 UTC, which is midnight EST in winter and
1 AM EDT in summer (GitHub cron always uses UTC). GitHub can start scheduled
runs late when it is busy, sometimes by hours, so the actual time varies.

## Local development

Fetch data, using only the Python 3.9+ standard library (nothing to install):

```bash
read "HPS_EMAIL?Email: "; read -s "HPS_PASSWORD?Password: "; echo
HPS_EMAIL=$HPS_EMAIL HPS_PASSWORD=$HPS_PASSWORD python3 scripts/fetch_and_diff.py
```

Preview the site:

```bash
python3 -m http.server 8000
# open http://localhost:8000
```

The bot commits data daily, so run `git pull` before starting work.

The code is commented for readers new to it. `app.js` starts with an overview of
how the page works.

## Project layout

```
index.html, app.js, styles.css      the website (no build step)
scripts/fetch_and_diff.py           daily fetch, compare and write
.github/workflows/update-data.yml   schedule, commit and deploy
data/                               generated, committed by the bot
```

## Data source

Data comes from the [Health Product Shortages Canada](https://healthproductshortages.ca)
public API. Only English fields are used.
