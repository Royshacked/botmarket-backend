"""
SEC 13F data sets → per filer, per quarter, for the screener lab's test J (docs/design/screener-lab.md §26, Roy 2026-10-26:
"test the managers — do not make short cuts"). Independent of aether_engine's job, which keeps per-company totals only.

Per data-set file (one zip per three-month filing window), the quarter most of its filings report:
  - COUNTED filings: 13F-HR / 13F-HR/A for that period; notices out; per filer in filing order an original or a
    RESTATEMENT starts the set over, a NEW HOLDINGS amendment joins it (as the job and SEC's own amendment types say).
  - Every holding read: shares only (SH), no options (PUTCALL). VALUE is dollars for filings from 2023-01-03, thousands
    before (×1000).
  - UNITS per filing: each position's value ÷ shares against the median of every filer for that CUSIP; a filing whose
    median is ~1/1000 of it filed in thousands (×1000), ~1000× filed dollars where thousands were due (÷1000); anything
    else far off is marked bad (unit 0) — its book is not trusted.
  - Per filer: its book value V and number of positions N (every CUSIP), its first filing date.
  - Rows kept: every holding whose CUSIP's issuer code (first 6 characters) is one of ours — all its classes, so the
    CUSIP each company traded under can be decided afterwards from who held what.

Out, per quarter, in --out:  <period>.rows.tsv.gz   cik, cusip, shares, value (dollars, unit-corrected), filed
                             <period>.meta.json     the file, counts, filers {cik: [name, V, N, unit, filed, n, med]},
                                                    cusips {cusip: [holders, shares, top issuer name, top class]}

    python -I scripts/lab-13f-extract.py --list <hrefs.txt> --zips <dir> --out data/lab/13f --prefixes <file>
           [--from 2018-12-31] [--keep]
A quarter whose meta.json exists is skipped (resumable). Downloads need SEC_USER_AGENT in the environment.
"""
from __future__ import annotations

import argparse
import csv
import gzip
import io
import json
import math
import os
import re
import statistics
import sys
import time
import urllib.request
import zipfile
from array import array
from collections import Counter, defaultdict

csv.field_size_limit(10_000_000)

DOLLARS_FROM = "2023-01-03"
MON = {m: i for i, m in enumerate(("JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"), 1)}
QEND = {1: "03-31", 2: "06-30", 3: "09-30", 4: "12-31"}


def iso(d: str | None) -> str:
    d = (d or "").strip()
    m = re.fullmatch(r"(\d{2})-([A-Za-z]{3})-(\d{4})", d)
    return f"{m.group(3)}-{MON[m.group(2).upper()]:02d}-{m.group(1)}" if m else d[:10]


def period_of(name: str) -> str | None:
    """The quarter a file's filings report, from its name: 'YYYYqN' is filed in that quarter → the quarter before;
    '01jun2026-31aug2026' is filed Jun–Aug → the quarter ending in the window's first month, or the one before it."""
    n = name.rsplit("/", 1)[-1].lower()
    m = re.match(r"(\d{4})q([1-4])_", n)
    if m:
        y, q = int(m.group(1)), int(m.group(2))
        return f"{y - 1}-12-31" if q == 1 else f"{y}-{QEND[q - 1]}"
    m = re.match(r"\d{2}([a-z]{3})(\d{4})-", n)
    if m:
        mon, y = MON[m.group(1).upper()], int(m.group(2))
        q = (mon - 1) // 3 + (1 if mon % 3 == 0 else 0)          # a window starting in a quarter's last month: that quarter
        return f"{y}-{QEND[q]}" if q else f"{y - 1}-12-31"
    return None


def download(url: str, dest: str, ua: str) -> None:
    req = urllib.request.Request(url, headers={"User-Agent": ua})
    with urllib.request.urlopen(req, timeout=600) as r, open(dest + ".part", "wb") as f:
        while chunk := r.read(1 << 20):
            f.write(chunk)
    os.replace(dest + ".part", dest)


def member(z: zipfile.ZipFile, name: str) -> str:
    return next(n for n in z.namelist() if n.upper().endswith(name))


def rows(z: zipfile.ZipFile, name: str):
    with z.open(member(z, name)) as f:
        yield from csv.DictReader(io.TextIOWrapper(f, encoding="utf-8", errors="replace"), delimiter="\t")


def extract(zpath: str, prefixes: set[str]) -> tuple[dict, list]:
    z = zipfile.ZipFile(zpath)
    sub = list(rows(z, "SUBMISSION.TSV"))
    period = Counter(iso(s["PERIODOFREPORT"]) for s in sub if s["SUBMISSIONTYPE"] == "13F-HR").most_common(1)[0][0]
    cov = {c["ACCESSION_NUMBER"]: c for c in rows(z, "COVERPAGE.TSV")}
    by_cik = defaultdict(list)
    for s in sub:
        if s["SUBMISSIONTYPE"] not in ("13F-HR", "13F-HR/A") or iso(s["PERIODOFREPORT"]) != period:
            continue
        c = cov.get(s["ACCESSION_NUMBER"], {})
        if "NOTICE" in (c.get("REPORTTYPE") or "").upper():
            continue
        by_cik[s["CIK"]].append((iso(s["FILING_DATE"]), s["ACCESSION_NUMBER"], c))
    acc = {}                     # accession → (cik, filed, ×1000 for thousands-era filings)
    names = {}
    for cik, fs in by_cik.items():
        keep = []
        for filed, a, c in sorted(fs):
            amended = (c.get("ISAMENDMENT") or "").upper() in ("Y", "TRUE", "1")
            if amended and "NEW HOLDINGS" in (c.get("AMENDMENTTYPE") or "").upper():
                keep.append((filed, a))
            else:
                keep = [(filed, a)]
            names[cik] = (c.get("FILINGMANAGER_NAME") or "").strip()
        for filed, a in keep:
            acc[a] = (cik, filed, 1.0 if filed >= DOLLARS_FROM else 1000.0)

    def holdings():
        for r in rows(z, "INFOTABLE.TSV"):
            a = acc.get(r["ACCESSION_NUMBER"])
            if not a or (r["PUTCALL"] or "").strip() or (r["SSHPRNAMTTYPE"] or "").strip().upper() != "SH":
                continue
            try:
                sh, val = float(r["SSHPRNAMT"] or 0), float(r["VALUE"] or 0)
            except ValueError:
                continue
            yield r, a, (r["CUSIP"] or "").strip().upper(), sh, val * a[2]

    # pass 1: the reference price per CUSIP — the median of every filer's value ÷ shares
    px = defaultdict(lambda: array("d"))
    for _r, _a, cu, sh, val in holdings():
        if sh > 0 and val > 0:
            px[cu].append(val / sh)
    ref = {cu: statistics.median(v) for cu, v in px.items() if len(v) >= 5}
    del px

    # pass 2: per filer — book, positions, unit ratios; our issuers' rows; our CUSIPs' holders
    book = defaultdict(float)
    pos = defaultdict(set)
    ratios = defaultdict(lambda: array("d"))
    first = {}
    ours = defaultdict(lambda: [0.0, 0.0, "9999"])        # (cik, cusip) → shares, value, earliest filed
    cus = defaultdict(lambda: [set(), 0.0, Counter(), Counter()])
    for r, (cik, filed, _m), cu, sh, val in holdings():
        book[cik] += val
        pos[cik].add(cu)
        first[cik] = min(first.get(cik, filed), filed)
        if sh > 0 and val > 0 and cu in ref and ref[cu] > 0:
            ratios[cik].append(math.log10(val / sh / ref[cu]))
        if cu[:6] in prefixes:
            o = ours[(cik, cu)]
            o[0] += sh; o[1] += val; o[2] = min(o[2], filed)
            c = cus[cu]; c[0].add(cik); c[1] += sh
            c[2][(r["NAMEOFISSUER"] or "").strip().upper()[:40]] += 1; c[3][(r["TITLEOFCLASS"] or "").strip().upper()[:24]] += 1

    filers = {}
    for cik in book:
        rs = ratios.get(cik)
        med = statistics.median(rs) if rs and len(rs) >= 3 else None
        unit = 1.0 if med is None or abs(med) < 0.5 else 1000.0 if abs(med + 3) < 0.5 else 0.001 if abs(med - 3) < 0.5 else 0.0
        filers[cik] = [names.get(cik, ""), book[cik] * (unit or 1.0), len(pos[cik]), unit, first[cik], len(rs or ()),
                       None if med is None else round(med, 3)]
    out_rows = []
    for (cik, cu), (sh, val, filed) in ours.items():
        u = filers[cik][3] or 1.0
        out_rows.append((cik, cu, sh, val * u, filed))
    meta = dict(period=period, filings=len(sub), counted=len(acc), filers=filers,
                cusips={cu: [len(c[0]), c[1], c[2].most_common(1)[0][0], c[3].most_common(1)[0][0]] for cu, c in cus.items()})
    return meta, out_rows


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--list", required=True)
    ap.add_argument("--zips", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--prefixes", required=True)
    ap.add_argument("--from", dest="since", default="2018-12-31")
    ap.add_argument("--keep", action="store_true")
    a = ap.parse_args()
    ua = os.environ.get("SEC_USER_AGENT", "").strip()
    prefixes = {l.strip().upper() for l in open(a.prefixes) if l.strip()}
    os.makedirs(a.out, exist_ok=True)
    os.makedirs(a.zips, exist_ok=True)
    hrefs = [l.strip() for l in open(a.list) if l.strip()]
    todo = sorted(((period_of(h), h) for h in hrefs if (period_of(h) or "") >= a.since), reverse=True)
    for period, href in todo:
        meta_path = os.path.join(a.out, f"{period}.meta.json")
        if os.path.exists(meta_path):
            continue
        name = href.rsplit("/", 1)[-1]
        zpath = os.path.join(a.zips, name)
        t0 = time.monotonic()
        if not os.path.exists(zpath):
            if not ua:
                print("SEC_USER_AGENT is not set", file=sys.stderr)
                return 1
            download(href if href.startswith("http") else "https://www.sec.gov" + href, zpath, ua)
        meta, out_rows = extract(zpath, prefixes)
        meta["file"] = name
        if meta["period"] != period:
            print(f"{name}: named for {period}, its filings report {meta['period']} — stored under {meta['period']}")
            meta_path = os.path.join(a.out, f"{meta['period']}.meta.json")
        with gzip.open(meta_path.replace(".meta.json", ".rows.tsv.gz"), "wt", encoding="utf-8") as f:
            for r in out_rows:
                f.write("\t".join(str(x) for x in r) + "\n")
        with open(meta_path + ".part", "w") as f:
            json.dump(meta, f)
        os.replace(meta_path + ".part", meta_path)
        units = Counter(v[3] for v in meta["filers"].values())
        print(f"{meta['period']} <- {name}: {meta['filings']} filings, {meta['counted']} counted, {len(meta['filers'])} filers "
              f"(units {dict(units)}), {len(out_rows)} rows, {len(meta['cusips'])} of our CUSIPs, {time.monotonic() - t0:.0f} s", flush=True)
        if not a.keep:
            os.remove(zpath)
    return 0


if __name__ == "__main__":
    sys.exit(main())
