#!/usr/bin/env python3
"""Pull current reports from the Health Product Shortages Canada API, compare
them with the previous snapshot, and write the JSON files the site reads.

Usage:
    HPS_EMAIL=you@example.com HPS_PASSWORD=... python3 scripts/fetch_and_diff.py

Only the standard library is used, so no install step is needed.

Files written (in --data-dir, default ./data):
    shortages.json          current shortages + recently resolved/avoided
    discontinuations.json   to-be-discontinued + recently discontinued/reversed
    meta.json               last check time and counts per status
    changes/YYYY-MM-DD.json what changed that day
    changes/index.json      list of days with changes, newest first

All API calls happen before anything is written, so a failed run leaves the
existing data untouched.
"""

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

API = "https://healthproductshortages.ca/api/v1"
USER_AGENT = "drugshortage-site-updater/1.0"
PAGE_SIZE = 100          # the API requires limit=100 when extracting many reports
REQUEST_DELAY = 0.5      # seconds between calls; the limit is 1000 requests/hour
MAX_RETRIES = 5
TZ = ZoneInfo("America/Toronto")

# Statuses pulled in full every day, per report type.
CURRENT = {
    "shortage": ["active_confirmed", "anticipated_shortage"],
    "discontinuance": ["to_be_discontinued"],  # undocumented, but works
}
# How long a report stays listed after it leaves the current statuses.
RECENT_DAYS = {"shortage": 30, "discontinuance": 30}
OUTPUT_FILE = {"shortage": "shortages.json", "discontinuance": "discontinuations.json"}
DETAIL_PATH = {"shortage": "shortages", "discontinuance": "discontinuances"}

# A status pull that drops below this share of yesterday's count aborts the run
# (protects against a partial or broken API response wiping the site).
MIN_COUNT_RATIO = 0.5

# Fields compared to describe what changed in an updated report.
TRACKED_FIELDS = [
    "status", "estEnd", "actualStart", "anticipatedStart", "actualEnd", "reason",
    "tier3", "discDate", "actualDiscDate", "reversed", "comments", "mitigation",
    "strength", "company",
]

# Top-level API keys we have already seen. Anything else is logged once per run
# so new fields (e.g. the estimated end date name) can be picked up.
KNOWN_KEYS = {
    "id", "drug", "created_date", "type", "din", "company_name", "atc_number",
    "atc_description", "anticipated_start_date", "actual_start_date",
    "decision_reversal", "shortage_reason", "updated_date", "status",
    "en_drug_brand_name", "en_drug_common_name", "en_ingredients", "drug_strength",
    "drug_dosage_form", "drug_route", "drug_package_quantity", "resolved",
    "avoided", "advance", "late_submission", "shortage_duplicated",
    "discontinuance_duplicated", "draft", "discontinuation_duplication",
    "shortage_duplication", "unknown_estimated_end_date", "marker_a1",
    "marker_a2", "marker_a3", "marker_b1", "marker_b2", "marker_b3",
    "late_marker_disabled", "tier_3", "gtins", "anticipated_discontinuation_date",
    "en_discontinuation_comments", "discontinuance_reason",
    "estimated_end_date", "actual_end_date", "discontinuation_date",
    "en_comments", "hc_en_comments", "en_supply_disruption_mitigation",
    "hc_updated_date",
}


class ApiError(Exception):
    pass


# --- HTTP -------------------------------------------------------------------

def error_text(body):
    if isinstance(body, dict) and isinstance(body.get("error"), dict):
        return body["error"].get("en") or str(body["error"])
    return str(body)[:200]


def request(method, path, token=None, params=None, form=None):
    """Return (status, headers, json_body). Retries on 429, 5xx and network errors."""
    url = f"{API}/{path}"
    if params:
        url += "?" + urllib.parse.urlencode(params)
    data = urllib.parse.urlencode(form).encode() if form else None
    headers = {"Accept": "application/json", "User-Agent": USER_AGENT}
    if token:
        headers["auth-token"] = token

    for attempt in range(1, MAX_RETRIES + 1):
        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                return resp.status, resp.headers, json.load(resp)
        except urllib.error.HTTPError as e:
            if e.code == 429 or e.code >= 500:
                wait = retry_after(e.headers) or 30 * attempt
                log(f"  HTTP {e.code} on {path}; waiting {wait}s (attempt {attempt}/{MAX_RETRIES})")
                time.sleep(wait)
                continue
            try:
                body = json.load(e)
            except (ValueError, OSError):
                body = None
            return e.code, e.headers, body
        except (urllib.error.URLError, TimeoutError) as e:
            wait = 10 * attempt
            log(f"  Network error on {path} ({e}); waiting {wait}s (attempt {attempt}/{MAX_RETRIES})")
            time.sleep(wait)
    raise ApiError(f"Giving up on {path} after {MAX_RETRIES} attempts")


def retry_after(headers):
    try:
        return max(1, int(headers.get("Retry-After", "")))
    except ValueError:
        return None


# --- API calls --------------------------------------------------------------

def login(email, password):
    status, headers, body = request("POST", "login", form={"email": email, "password": password})
    if status != 200:
        hint = {400: "check email/password", 403: "account email not verified"}.get(status, "")
        raise ApiError(f"Login failed (HTTP {status}{', ' + hint if hint else ''}): {error_text(body)}")
    token = headers.get("auth-token")
    if not token:
        raise ApiError("Login succeeded but no auth-token header was returned")
    return token


def fetch_status(token, status):
    """All reports with the given status, paged by id ascending as the API requires."""
    reports, offset = {}, 0
    while True:
        code, _, body = request("GET", "search", token, params={
            "filter_status": status, "orderby": "id", "order": "asc",
            "limit": PAGE_SIZE, "offset": offset,
        })
        if code != 200:
            raise ApiError(f"Search for {status} failed at offset {offset} (HTTP {code}): {error_text(body)}")
        for rec in body.get("data") or []:
            reports[rec["id"]] = rec
        if not body.get("data") or body.get("remaining", 0) <= 0:
            break
        offset += PAGE_SIZE
        time.sleep(REQUEST_DELAY)
    total = body.get("total")
    if total is not None and len(reports) != total:
        log(f"  Note: {status} reported total {total} but {len(reports)} were received")
    return list(reports.values())


def fetch_detail(token, kind, report_id):
    """Full report, or None if the API says it is unavailable or gone."""
    code, _, body = request("GET", f"{DETAIL_PATH[kind]}/{report_id}", token)
    if code == 200:
        return body
    if code in (400, 404):
        return None
    raise ApiError(f"Detail lookup {DETAIL_PATH[kind]}/{report_id} failed (HTTP {code}): {error_text(body)}")


# --- Shaping ----------------------------------------------------------------

def day(value):
    """'2026-07-01T00:00:00-04:00' -> '2026-07-01'."""
    return value[:10] if value else None


def clean_route(value):
    """'ORAL\\r\\nORAL' -> 'ORAL'; keeps first-seen order."""
    if not value:
        return None
    parts = [p.strip() for p in value.replace("\r", "\n").split("\n")]
    return ", ".join(dict.fromkeys(p for p in parts if p))


def reason(rec, key):
    return (rec.get(key) or {}).get("en_reason")


def slim(rec):
    """Keep the English fields the site needs."""
    drug = rec.get("drug") or {}
    kind = (rec.get("type") or {}).get("label")
    out = {
        "id": rec["id"],
        "type": kind,
        "status": rec.get("status"),
        "din": rec.get("din") or drug.get("din"),
        "brand": rec.get("en_drug_brand_name") or drug.get("brand_name"),
        "commonName": rec.get("en_drug_common_name"),
        "ingredients": rec.get("en_ingredients"),
        "strength": rec.get("drug_strength"),
        "form": rec.get("drug_dosage_form"),
        "route": clean_route(rec.get("drug_route")),
        "package": rec.get("drug_package_quantity"),
        "company": rec.get("company_name"),
        "atc": rec.get("atc_number"),
        "atcDesc": rec.get("atc_description"),
        "tier3": bool(rec.get("tier_3")),
        "late": bool(rec.get("late_submission")),
        "marketStatus": drug.get("current_status"),
        "mitigation": rec.get("en_supply_disruption_mitigation") or None,
        "hcComments": rec.get("hc_en_comments") or None,
        "created": rec.get("created_date"),
        "updated": rec.get("updated_date"),
    }
    if kind == "shortage":
        out.update({
            "reason": reason(rec, "shortage_reason"),
            "anticipatedStart": day(rec.get("anticipated_start_date")),
            "actualStart": day(rec.get("actual_start_date")),
            "estEnd": None if rec.get("unknown_estimated_end_date") else day(rec.get("estimated_end_date")),
            "actualEnd": day(rec.get("actual_end_date")),
            "comments": rec.get("en_comments") or None,
        })
    else:
        out.update({
            "reason": reason(rec, "discontinuance_reason"),
            "discDate": day(rec.get("anticipated_discontinuation_date")),
            "actualDiscDate": day(rec.get("discontinuation_date")),
            "comments": rec.get("en_discontinuation_comments") or rec.get("en_comments") or None,
            "reversed": bool(rec.get("decision_reversal")),
        })
    return out


def note_unknown_keys(rec, seen):
    for key, value in rec.items():
        if key in KNOWN_KEYS or key in seen or key.startswith("fr_") or key.endswith("_fr"):
            continue
        seen.add(key)
        log(f"  New API field (not used yet): {key} = {json.dumps(value)[:80]}")


def summary(r):
    return {k: r.get(k) for k in ("id", "type", "status", "brand", "din", "strength", "company", "tier3")}


def field_changes(old, new):
    return [
        {"field": f, "from": old.get(f), "to": new.get(f)}
        for f in TRACKED_FIELDS
        if old.get(f) != new.get(f)
    ]


# --- Main diff --------------------------------------------------------------

def load_reports(path):
    if not path.exists():
        return {}
    return {r["id"]: r for r in json.loads(path.read_text())["reports"]}


def check_count(status, new_count, old_reports, force):
    old_count = sum(1 for r in old_reports.values() if r["status"] == status)
    if not force and old_count >= 50 and new_count < old_count * MIN_COUNT_RATIO:
        raise ApiError(
            f"{status}: only {new_count} reports vs {old_count} yesterday. "
            "Aborting to avoid publishing a partial list (rerun with --force if this is real)."
        )


def build(token, prev, today, force):
    """Fetch everything and return (reports_by_kind, changes, counts). Writes nothing."""
    changes = {"date": today.isoformat(), "new": [], "updated": [], "statusChanged": []}
    output, counts, seen_keys = {}, {}, set()

    for kind, statuses in CURRENT.items():
        old = prev[kind]
        current = {}
        for status in statuses:
            log(f"Fetching {status}...")
            raw = fetch_status(token, status)
            check_count(status, len(raw), old, force)
            for rec in raw:
                note_unknown_keys(rec, seen_keys)
                current[rec["id"]] = slim(rec)
            log(f"  {len(raw)} reports")
            time.sleep(REQUEST_DELAY)

        for rid, r in current.items():
            o = old.get(rid)
            if o is None:
                changes["new"].append(summary(r))
            elif o["updated"] != r["updated"] or o["status"] != r["status"]:
                diffs = field_changes(o, r)
                if diffs:
                    changes["updated"].append({**summary(r), "changes": diffs})

        # Reports that left the current statuses: look up what they became.
        recent = {}
        gone = [rid for rid, o in old.items() if o["status"] in statuses and rid not in current]
        if gone:
            log(f"Looking up {len(gone)} {kind} report(s) that changed status...")
        for rid in gone:
            rec = fetch_detail(token, kind, rid)
            time.sleep(REQUEST_DELAY)
            r = slim(rec) if rec else {**old[rid], "status": "removed"}
            if r["status"] in statuses:      # still current; it shifted between pages
                current[rid] = r
                continue
            r["changedOn"] = today.isoformat()
            recent[rid] = r
            changes["statusChanged"].append({**summary(r), "from": old[rid]["status"], "to": r["status"]})

        # Keep earlier status changes for the recent window.
        cutoff = (today - timedelta(days=RECENT_DAYS[kind])).isoformat()
        for rid, o in old.items():
            if (o["status"] not in statuses and rid not in current and rid not in recent
                    and o.get("changedOn", "") >= cutoff):
                recent[rid] = o

        reports = sorted([*current.values(), *recent.values()],
                         key=lambda r: r.get("updated") or "", reverse=True)
        output[kind] = reports
        for r in reports:
            counts[r["status"]] = counts.get(r["status"], 0) + 1

    return output, changes, counts


def dumps_line_per_item(data):
    """Compact JSON with one list item per line, so git diffs show only changed reports."""
    def compact(value):
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))

    def block(items):
        return "[\n" + ",\n".join(compact(i) for i in items) + "\n]" if items else "[]"

    if isinstance(data, list):
        return block(data) + "\n"
    parts = [f"{compact(k)}:{block(v) if isinstance(v, list) else compact(v)}" for k, v in data.items()]
    return "{" + ",\n".join(parts) + "}\n"


def write_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(dumps_line_per_item(data))
    os.replace(tmp, path)


def merge_same_day(existing, changes):
    """A second run on the same day adds to that day's file; the latest entry per id wins."""
    for key in ("new", "updated", "statusChanged"):
        by_id = {e["id"]: e for e in existing.get(key, [])}
        by_id.update({e["id"]: e for e in changes[key]})
        changes[key] = list(by_id.values())
    return changes


def save(data_dir, output, changes, counts, first_run, now):
    today = changes["date"]
    has_changes = any(changes[k] for k in ("new", "updated", "statusChanged"))
    meta_path = data_dir / "meta.json"
    meta = json.loads(meta_path.read_text()) if meta_path.exists() else {}

    for kind, reports in output.items():
        write_json(data_dir / OUTPUT_FILE[kind], {"generated": now, "reports": reports})

    if has_changes and not first_run:
        day_path = data_dir / "changes" / f"{today}.json"
        if day_path.exists():
            changes = merge_same_day(json.loads(day_path.read_text()), changes)
        write_json(day_path, changes)

        index_path = data_dir / "changes" / "index.json"
        index = json.loads(index_path.read_text()) if index_path.exists() else []
        index = [e for e in index if e["date"] != today]
        index.insert(0, {"date": today, **{k: len(changes[k]) for k in ("new", "updated", "statusChanged")}})
        write_json(index_path, index)
        meta["lastChanged"] = today

    meta.update({
        "lastChecked": now,
        "counts": counts,
        "recentDays": RECENT_DAYS,
        "source": "Health Product Shortages Canada (healthproductshortages.ca)",
    })
    if first_run:
        meta["seeded"] = today
    write_json(meta_path, meta)
    return changes, has_changes


def log(msg):
    print(msg, flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--data-dir", default="data", type=Path)
    parser.add_argument("--force", action="store_true",
                        help="skip the sanity check on sudden drops in report counts")
    args = parser.parse_args()

    email, password = os.environ.get("HPS_EMAIL"), os.environ.get("HPS_PASSWORD")
    if not email or not password:
        sys.exit("Set HPS_EMAIL and HPS_PASSWORD environment variables.")

    now_dt = datetime.now(TZ)
    today: date = now_dt.date()
    prev = {kind: load_reports(args.data_dir / name) for kind, name in OUTPUT_FILE.items()}
    first_run = not any(prev.values())

    try:
        log("Logging in...")
        token = login(email, password)
        output, changes, counts = build(token, prev, today, args.force)
    except ApiError as e:
        sys.exit(f"ERROR: {e}\nExisting data was not changed.")

    changes, has_changes = save(args.data_dir, output, changes, counts, first_run, now_dt.isoformat(timespec="seconds"))

    log("")
    log("Counts: " + ", ".join(f"{k}={v}" for k, v in sorted(counts.items())))
    if first_run:
        log("First run: data seeded, no change log written.")
    elif has_changes:
        log(f"Changes today: {len(changes['new'])} new, {len(changes['updated'])} updated, "
            f"{len(changes['statusChanged'])} status changes.")
    else:
        log("No changes since last run.")


if __name__ == "__main__":
    main()
