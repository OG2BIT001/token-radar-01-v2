#!/usr/bin/env python3
"""Compose the entry's three screenshots with PIL from a real run's data.

This machine has no working browser, so the screenshots are compositions, stated as such
in SESSION.md: they draw the dashboard's own layout, palette and typography (the values in
dashboard/app.css) and fill them with the board's real figures from the run's data.js —
the board's true top rows, rank 1's real detail view, and a real category filter.

Usage: python3 tools/make-screenshots.py <path-to-output-dir> [screenshots-dir]
The output dir must hold data.js from a run of main.ts.
"""
import json
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

OUT = Path(sys.argv[1])
SHOTS = Path(sys.argv[2]) if len(sys.argv) > 2 else Path(__file__).resolve().parent.parent / "screenshots"

R = json.loads((OUT / "data.js").read_text()[len("window.RADAR="):].rstrip().rstrip(";"))
ROWS = R["rows"]
DIAG = R["diagnostics"]

W, H = 1440, 1024
BG = (10, 14, 19)
PANEL = (16, 21, 28)
PANEL2 = (21, 28, 37)
LINE = (34, 48, 65)
LINE_SOFT = (24, 34, 48)
INK = (232, 238, 244)
MUT = (147, 163, 177)
DIM = (95, 113, 133)
ACC = (45, 212, 191)
GREEN = (74, 222, 128)
AMBER = (245, 184, 76)
RED = (242, 109, 109)

SANS = "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf"
SANSB = "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf"
MONO = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"
MONOB = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf"


def F(size, bold=False, mono=False):
    return ImageFont.truetype(MONOB if (bold and mono) else MONO if mono else SANSB if bold else SANS, size)


def usd(n):
    if n >= 1e9:
        return f"${n / 1e9:.2f}B"
    if n >= 1e6:
        return f"${n / 1e6:.1f}M"
    if n >= 1e3:
        return f"${n / 1e3:.0f}K"
    return f"${n}"


def usd_full(n):
    return f"${n:,}"


def pct(v):
    if v is None:
        return "—"
    return f"{'+' if v > 0 else ''}{round(v * 10) / 10}%"


def age_fmt(d):
    if d is None:
        return "unrecorded"
    return f"{d / 365:.1f}y" if d >= 365 else f"{d}d"


def wrap(draw, text, font, width):
    words, lines, cur = text.split(), [], ""
    for w in words:
        trial = f"{cur} {w}".strip()
        if draw.textlength(trial, font=font) <= width:
            cur = trial
        else:
            lines.append(cur)
            cur = w
    if cur:
        lines.append(cur)
    return lines


def header(draw, active="Board"):
    draw.rectangle([0, 0, W, 62], fill=BG)
    draw.text((22, 18), "Launch ", font=F(21, bold=True), fill=INK)
    x = 22 + draw.textlength("Launch ", font=F(21, bold=True))
    draw.text((x, 18), "Radar", font=F(21, bold=True), fill=ACC)
    sub = (f"Pre-token protocols ranked by implied launch value · model {R['model_version']} · "
           f"data as of {R['as_of']} (DefiLlama, sealed snapshot)")
    draw.text((250, 24), sub, font=F(12), fill=MUT)
    nav = ["Board", "The model", "Trading peers", "Not launches"]
    nx = W - 22
    for label in reversed(nav):
        w = draw.textlength(label, font=F(12)) + 22
        nx -= w + 4
        on = label == active
        draw.rounded_rectangle([nx, 16, nx + w, 44], 6, fill=ACC if on else PANEL, outline=ACC if on else LINE)
        draw.text((nx + 11, 23), label, font=F(12, bold=on), fill=(4, 33, 29) if on else MUT)
    draw.line([0, 62, W, 62], fill=LINE)


def strip(draw, y=63):
    counts = R["counts"]
    total = sum(r["implied_value_usd"] for r in ROWS)
    odds = sorted(r["odds_pct"] for r in ROWS)
    med_odds = odds[len(odds) // 2]
    grades = {g: sum(1 for r in ROWS if r["integrity_grade"] == g) for g in "ABCD"}
    farms = sum(1 for r in ROWS if r["verdict"] != "SKIP")
    cells = [
        ("Candidates ranked", f"{len(ROWS)}", f"{counts['watchlist']} on the watchlist"),
        ("Implied value, all rows", usd(total), ""),
        ("Median launch odds", f"{med_odds}%", ""),
        ("Model held-out error", f"x{DIAG['pooled_median_factor']}", "median, two folds"),
        ("Integrity grades", None, f"A {grades['A']} · B {grades['B']} · C {grades['C']} · D {grades['D']}"),
        ("Plans worth farming", f"{farms}", f"of {len(ROWS)}"),
    ]
    draw.rectangle([0, y, W, y + 58], fill=PANEL)
    x = 0
    widths = [250, 215, 165, 235, 300, 160]
    for (k, v, small), cw in zip(cells, widths):
        draw.text((x + 18, y + 8), k.upper(), font=F(10), fill=DIM)
        if v is not None:
            draw.text((x + 18, y + 24), v, font=F(17, bold=True), fill=INK)
            if small:
                tw = draw.textlength(v, font=F(17, bold=True))
                draw.text((x + 24 + tw, y + 29), small, font=F(11), fill=MUT)
        else:
            # grade bars
            mx = max(grades.values())
            bx = x + 18
            for g, col in (("A", GREEN), ("B", ACC), ("C", AMBER), ("D", RED)):
                bh = max(3, round(grades[g] / mx * 16))
                draw.rectangle([bx, y + 40 - bh, bx + 13, y + 40], fill=col)
                bx += 19
            draw.text((bx + 2, y + 28), small, font=F(11), fill=MUT)
        x += cw
        draw.line([x, y, x, y + 58], fill=LINE_SOFT)
    draw.line([0, y + 58, W, y + 58], fill=LINE)
    return y + 58


def toolbar(draw, y, count_text, category="All", search=""):
    draw.rectangle([0, y, W, y + 46], fill=BG)
    draw.rounded_rectangle([22, y + 9, 232, y + 37], 6, fill=PANEL2, outline=LINE)
    draw.text((31, y + 16), search or "Search name or slug", font=F(12), fill=MUT if not search else INK)
    x = 244
    for label, value, w in (("Category", category, 150), ("Chain", "All", 120), ("Grade", "Any", 90), ("Verdict", "Any", 110)):
        draw.text((x, y + 16), label, font=F(12), fill=MUT)
        x += draw.textlength(label, font=F(12)) + 6
        draw.rounded_rectangle([x, y + 9, x + w, y + 37], 6, fill=PANEL2, outline=LINE)
        draw.text((x + 9, y + 16), value, font=F(12), fill=INK)
        x += w + 14
    draw.text((880, y + 16), "☐ Watchlist only", font=F(12), fill=MUT)
    tw = draw.textlength(count_text, font=F(12))
    draw.text((W - 22 - tw, y + 16), count_text, font=F(12), fill=MUT)
    draw.line([0, y + 46, W, y + 46], fill=LINE_SOFT)
    return y + 46


COLS = [("#", 30, "r"), ("Protocol", 300, "l"), ("Category", 175, "l"), ("TVL", 100, "r"), ("7d", 70, "r"),
        ("Age", 80, "r"), ("Implied value", 190, "r"), ("Odds", 60, "r"), ("Integrity", 110, "r"),
        ("EV / wallet", 130, "r"), ("Verdict", 110, "l")]


def grade_colour(g):
    return {"A": GREEN, "B": ACC, "C": AMBER, "D": RED}[g]


def board_table(draw, y, rows, limit):
    x0 = 22
    xs = [x0]
    for _, w, _ in COLS:
        xs.append(xs[-1] + w)
    for (label, _, align), x, w in zip(COLS, xs, [c[1] for c in COLS]):
        tx = x + w - 8 if align == "r" else x + 4
        draw.text((tx if align == "r" else x + 4, y + 4), label.upper(), font=F(10, bold=True), fill=DIM,
                  anchor="ra" if align == "r" else "la")
    draw.line([x0, y + 22, W - 22, y + 22], fill=LINE)
    y += 26
    for r in rows[:limit]:
        cy = y + 3
        vals = [
            (str(r["rank"]), INK, False),
            (r["name"], INK, True),
            (r["category"] or "Uncategorised", MUT, False),
            (usd(r["tvl_usd"]), INK, False),
            (pct(r["change_7d"]), GREEN if (r["change_7d"] or 0) >= 0 else RED, False),
            (age_fmt(r["age_days"]), INK, False),
            (usd(r["implied_value_usd"]), INK, True),
            (f"{r['odds_pct']}%", INK, False),
            (f"{r['integrity_grade']} · {r['integrity_score']}", grade_colour(r["integrity_grade"]), True),
            (usd(r["expected_reward_usd"]), INK, False),
            (r["verdict"], GREEN if r["verdict"] == "FARM" else AMBER if r["verdict"] == "FARM SMALL" else MUT, True),
        ]
        for (val, col, bold), (_, w, align), x in zip(vals, COLS, xs):
            if align == "r":
                draw.text((x + w - 8, cy), val, font=F(12, bold=bold, mono=True), fill=col, anchor="ra")
            else:
                draw.text((x + 4, cy), val, font=F(12, bold=bold), fill=col)
        band = f"{usd(r['band_low_usd'])} – {usd(r['band_high_usd'])}"
        draw.text((xs[6] + COLS[6][1] - 8, cy + 15), band, font=F(10, mono=True), fill=DIM, anchor="ra")
        cost = f"cost {usd(r['plan_cost_usd'])}"
        draw.text((xs[9] + COLS[9][1] - 8, cy + 15), cost, font=F(10, mono=True), fill=DIM, anchor="ra")
        if r["watchlist"]:
            draw.text((xs[1] + 4 + draw.textlength(r["name"], font=F(12, bold=True)) + 8, cy + 1), "watchlist", font=F(10), fill=AMBER)
        draw.line([x0, y + 33, W - 22, y + 33], fill=LINE_SOFT)
        y += 34
    return y


def footer(draw):
    draw.line([0, H - 34, W, H - 34], fill=LINE_SOFT)
    draw.text((22, H - 24), "Implied values are this model's own claim, fitted on the snapshot and stated with its held-out error; "
                            "a protocol here records no token on DefiLlama, which is a record, not proof that none exists.", font=F(11), fill=DIM)


def shot_board():
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)
    header(d)
    y = strip(d)
    y = toolbar(d, y, f"{len(ROWS)} of {len(ROWS)} protocols · click a row for its detail, a heading to sort")
    board_table(d, y + 6, ROWS, 21)
    footer(d)
    img.save(SHOTS / "1-board.png", optimize=True)


def shot_filtered():
    rows = [r for r in ROWS if (r["category"] or "") == "Lending"]
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)
    header(d)
    y = strip(d)
    y = toolbar(d, y, f"{len(rows)} of {len(ROWS)} protocols · click a row for its detail, a heading to sort", category="Lending")
    board_table(d, y + 6, rows, 21)
    footer(d)
    img.save(SHOTS / "3-filtered.png", optimize=True)


def shot_detail():
    r = ROWS[0]
    m = r["model"]
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)
    header(d)
    d.text((22, 78), "← Back to the board", font=F(13), fill=ACC)
    d.text((22, 104), r["name"], font=F(20, bold=True), fill=INK)
    tx = 22 + d.textlength(r["name"], font=F(20, bold=True)) + 12
    for label, col in ((f"grade {r['integrity_grade']}", grade_colour(r["integrity_grade"])), (r["verdict"], GREEN if r["verdict"] != "SKIP" else MUT), ("watchlist" if r["watchlist"] else "", AMBER)):
        if not label:
            continue
        w = d.textlength(label, font=F(11, bold=True)) + 14
        d.rounded_rectangle([tx, 106, tx + w, 128], 10, outline=col)
        d.text((tx + 7, 111), label, font=F(11, bold=True), fill=col)
        tx += w + 8
    lede = (f"Rank {r['rank']} of {len(ROWS)} · {r['category'] or 'Uncategorised'} · {', '.join(r['chains'])} · "
            f"records no token on DefiLlama as of {R['as_of']}.")
    d.text((22, 138), lede, font=F(13), fill=MUT)
    cards = [
        ("TVL", usd_full(r["tvl_usd"]), ""),
        ("Implied launch value", usd_full(r["implied_value_usd"]), f"band {usd(r['band_low_usd'])} – {usd(r['band_high_usd'])}"),
        ("Launch odds (peers' record)", f"{r['odds_pct']}%", f"{r['cohort_trading']} of {r['cohort_size']} peers already trade"),
        ("Integrity", f"{r['integrity_score']} / 100", f"grade {r['integrity_grade']}"),
        ("Expected reward / wallet", usd_full(r["expected_reward_usd"]), f"against {usd_full(r['plan_cost_usd'])} cash cost"),
        ("Age with no token", f"{r['age_days']} days" if r["age_days"] is not None else "Unrecorded", f"listed {r['listed_at'] or '—'}"),
    ]
    cw, ch = 452, 74
    for i, (k, v, small) in enumerate(cards):
        cx = 22 + (i % 3) * (cw + 12)
        cy = 168 + (i // 3) * (ch + 10)
        d.rounded_rectangle([cx, cy, cx + cw, cy + ch], 8, fill=PANEL, outline=LINE_SOFT)
        d.text((cx + 13, cy + 9), k.upper(), font=F(10), fill=DIM)
        d.text((cx + 13, cy + 28), v, font=F(17, bold=True), fill=INK)
        if small:
            tw = d.textlength(v, font=F(17, bold=True))
            d.text((cx + 19 + tw, cy + 34), small, font=F(11), fill=MUT)
    y = 356
    d.text((22, y), f"HOW THE MODEL PRICES {r['name'].upper()}", font=F(12, bold=True), fill=DIM)
    y += 26
    table = [
        ("TVL (the snapshot's own figure)", usd_full(r["tvl_usd"])),
        (f"Category effect: the fitted median value ratio of trading {r['category'] or 'Uncategorised'} protocols, shrunk by peer count", f"x{m['category_effect']}"),
        ("Regression ratio: the fitted size, growth and age terms on this protocol", f"x{m['regression_ratio']}"),
        ("Local peer ratio: the median ratio of trading protocols within a x4 TVL band", f"x{m['local_ratio']}"),
        ("Blended ratio (half regression, half local peers)", f"x{m['blended_ratio']}"),
        (f"Implied value = TVL x blended ratio, rounded; the band is the model's pooled held-out median error, x{DIAG['pooled_median_factor']}", usd_full(r["implied_value_usd"])),
    ]
    for label, val in table:
        for j, line in enumerate(wrap(d, label, F(12), 950)):
            d.text((31, y + j * 17), line, font=F(12), fill=MUT if j else INK)
        d.text((W - 31, y), val, font=F(12, bold=True, mono=True), fill=INK, anchor="ra")
        y += max(17, 17 * len(wrap(d, label, F(12), 950))) + 7
        d.line([22, y - 3, W - 22, y - 3], fill=LINE_SOFT)
    y += 8
    d.text((22, y), "THE PEERS' RECORD", font=F(12, bold=True), fill=DIM)
    y += 24
    note = (f"Of the {r['cohort_size']} protocols in the cohort ({r['cohort_rule']}), {r['cohort_trading']} already record a token. "
            f"Laplace-smoothed, that is the {r['odds_pct']}% launch odds above: not a prediction that {r['name']} will issue, "
            f"but what protocols like it have done.")
    for line in wrap(d, note, F(12), 1180):
        d.text((22, y), line, font=F(12), fill=MUT)
        y += 17
    y += 12
    d.text((22, y), "INTEGRITY FLAGS", font=F(12, bold=True), fill=DIM)
    y += 24
    for flag in r["integrity_flags"]:
        d.text((40, y), f"•  {flag}", font=F(12), fill=MUT)
        y += 18
    y += 10
    d.text((22, y), "THE FARM PLAN, PRICED", font=F(12, bold=True), fill=DIM)
    y += 24
    for i, step in enumerate(r["farm_steps"], 1):
        lines = wrap(d, f"{i}.  {step}", F(12), 1230)
        for line in lines:
            d.text((40, y), line, font=F(12), fill=INK if i == len(r["farm_steps"]) else MUT)
            y += 17
        y += 3
        if y > H - 60:
            break
    footer(d)
    img.save(SHOTS / "2-detail.png", optimize=True)


if __name__ == "__main__":
    SHOTS.mkdir(parents=True, exist_ok=True)
    shot_board()
    shot_detail()
    shot_filtered()
    for name in ("1-board.png", "2-detail.png", "3-filtered.png"):
        p = SHOTS / name
        print(name, p.stat().st_size, "bytes")
