#!/usr/bin/env python
"""Generate the Google Sheets formula layout for the daily report.

No Apps Script, no file import. The published CSV is a public URL, so
IMPORTDATA pulls it straight into the sheet and QUERY slices it into the report
sections. Sheets re-fetches IMPORTDATA on its own (roughly hourly, and on open),
so the sheet keeps itself current with no trigger involved.

Two tabs:
  Data    a single IMPORTDATA in A1 - the whole CSV lands underneath it
  Sheet1  QUERY formulas against Data, laid out as the report

Writing the fetch once, on its own tab, rather than nesting IMPORTDATA inside
every QUERY, means one network call instead of a dozen and one place to change
the URL later.

    python scripts/make_formulas.py            # prints the paste-in block
    python scripts/make_formulas.py --csv out  # writes a CSV to import
"""

import argparse
import io
import sys

URL = "https://pw-orders-live.vercel.app/data/daily_report.csv"
SRC = "Data!A:Q"
SRC_STANDALONE = 'IMPORTDATA("%s")' % URL

# Column positions in the published CSV.
ENTITY, ORDERS, D_ORD, REV, D_REV, AOV, CONTRIB = 5, 6, 7, 8, 9, 10, 11
QTY, QTY_PREV, QTY_DIFF = 12, 13, 14
TARGET, ACHIEVED, PACE = 15, 16, 17


def q(select, where, order="Col4"):
    """A QUERY over the imported CSV. Header row is skipped with the 0 argument;
    the CSV's own header sits in row 1 of Data and would otherwise appear as a
    data row in every section."""
    return ('=IFERROR(QUERY(%s,"select %s where %s order by %s",0),"— no data —")'
            % (SRC, select, where, order))


def sec(name, scope):
    w = "Col2='%s'" % name
    if scope:
        w += " and Col3='%s'" % scope
    return w


def cols(*idx):
    return ",".join("Col%d" % i for i in idx)


def build():
    """Returns [(cell, formula_or_text, note), ...] in layout order."""
    out = []
    add = lambda cell, val, note="": out.append((cell, val, note))

    add("A1", '="PW Store — Daily Report"', "title")
    add("A2", '=IFERROR("Data for "&TEXT(INDEX(QUERY(%s,"select Col1 where Col2=\'Headline\' limit 1",0),1,1),'
               '"dddd, d mmmm yyyy"),"")' % SRC, "report date")
    add("A3", '=IFERROR("PROVISIONAL — this day is about "&'
               'TEXT(INDEX(QUERY(%s,"select Col11 where Col2=\'Data Completeness\'",0),1,1),"0")&'
               '"%% complete ("&TEXT(INDEX(QUERY(%s,"select Col6 where Col2=\'Data Completeness\'",0),1,1),"#,##0")&'
               '" orders against a typical settled day of "&'
               'TEXT(INDEX(QUERY(%s,"select Col10 where Col2=\'Data Completeness\'",0),1,1),"#,##0")&'
               '"). Orders keep arriving for about a week — marketplaces report late — so treat every '
               'figure below as a floor.","")' % (SRC, SRC, SRC), "completeness banner")

    add("A5", '="Headline"', "")
    add("A6", '={"Metric","Value","Change vs day before";'
              '"Yesterday\'s Orders",IFERROR(INDEX(QUERY(%s,"select Col6 where Col2=\'Headline\' and Col3=\'Yesterday\'",0),1,1),0),'
              'IFERROR(INDEX(QUERY(%s,"select Col7 where Col2=\'Headline\' and Col3=\'Yesterday\'",0),1,1),"")/100;'
              '"Yesterday\'s Revenue (Lakhs)",IFERROR(INDEX(QUERY(%s,"select Col8 where Col2=\'Headline\' and Col3=\'Yesterday\'",0),1,1),0),'
              'IFERROR(INDEX(QUERY(%s,"select Col9 where Col2=\'Headline\' and Col3=\'Yesterday\'",0),1,1),"")/100;'
              '"MTD Orders",IFERROR(INDEX(QUERY(%s,"select Col6 where Col2=\'Headline\' and Col3=\'MTD\'",0),1,1),0),"";'
              '"MTD Revenue (Lakhs)",IFERROR(INDEX(QUERY(%s,"select Col8 where Col2=\'Headline\' and Col3=\'MTD\'",0),1,1),0),""}'
              % (SRC, SRC, SRC, SRC, SRC, SRC), "KPI block")

    add("A12", '="Target vs Achievement — Month to Date"', "")
    add("A13", '={"Category","MTD Revenue (Lakhs)","Month Target (Lakhs)","Achieved %","Pace % (vs days elapsed)"}', "")
    add("A14", q(cols(ENTITY, REV, TARGET, ACHIEVED, PACE), sec("Target vs Achievement", "MTD")), "")

    row = 24
    for name, label in (("Channel Summary", "Channel Summary"),
                        ("Product Type Summary", "Product Type Summary"),
                        ("Category Summary - Publication Books", "Category Summary — Publication Books"),
                        ("Top 10 Publication Books", "Top 10 Publication Books"),
                        ("Top 10 Stationery & Merchandise", "Top 10 Stationery & Merchandise")):
        for scope in ("Yesterday", "MTD"):
            add("A%d" % row, '="%s — %s"' % (label, scope), "")
            if scope == "Yesterday":
                add("A%d" % (row + 1),
                    '={"Name","Orders","Orders Change","Revenue (Lakhs)","Revenue Change","AOV","Revenue Contribution %"}', "")
                add("A%d" % (row + 2), q(cols(ENTITY, ORDERS, D_ORD, REV, D_REV, AOV, CONTRIB), sec(name, scope)), "")
            else:
                add("A%d" % (row + 1),
                    '={"Name","Orders","Revenue (Lakhs)","AOV","Revenue Contribution %"}', "")
                add("A%d" % (row + 2), q(cols(ENTITY, ORDERS, REV, AOV, CONTRIB), sec(name, scope)), "")
            # Leave generous room: sub-category runs to ~60 rows.
            row += 66 if "Category Summary" in name else 16

    for name, label in (("Inclined Products", "Inclined Products (vs day before)"),
                        ("Declined Products", "Declined Products (vs day before)")):
        add("A%d" % row, '="%s"' % label, "")
        add("A%d" % (row + 1), '={"Product","Yesterday Qty","Day Before Qty","Qty Diff"}', "")
        add("A%d" % (row + 2), q(cols(ENTITY, QTY, QTY_PREV, QTY_DIFF), sec(name, "Yesterday")), "")
        row += 16

    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--csv", help="write a CSV that can be imported as the Sheet1 tab")
    ap.add_argument("--standalone", action="store_true",
                    help="inline IMPORTDATA so one tab works with no Data tab")
    a = ap.parse_args()

    if a.standalone:
        global SRC
        SRC = SRC_STANDALONE

    cells = build()

    if a.csv:
        # Lay the formulas out at their real cell positions so a CSV import
        # reproduces the sheet exactly.
        max_row = max(int(c[0][1:]) for c in cells)
        grid = [[""] for _ in range(max_row)]
        for cell, val, _ in cells:
            grid[int(cell[1:]) - 1] = [val]
        with io.open(a.csv, "w", encoding="utf-8", newline="") as f:
            import csv as _csv
            _csv.writer(f, lineterminator="\n").writerows(grid)
        print("wrote %s (%d rows)" % (a.csv, max_row))
        return 0

    print("=" * 78)
    print("STEP 1 — make a tab called  Data  and put this in cell A1:")
    print("=" * 78)
    print('=IMPORTDATA("%s")' % URL)
    print()
    print("=" * 78)
    print("STEP 2 — on  Sheet1 , paste each formula into the cell shown:")
    print("=" * 78)
    for cell, val, note in cells:
        print()
        print("%-5s %s" % (cell, ("  <- " + note) if note else ""))
        print(val)
    return 0


if __name__ == "__main__":
    sys.exit(main())
