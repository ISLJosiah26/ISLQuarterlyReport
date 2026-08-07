# Prompt: build a click-path CSV

Paste this into a Claude conversation with your analytics data attached. The CSV
it returns uploads straight into **Admin → Social → Paid Media → Import journeys**.

---

I need a CSV of website journeys for a quarterly paid-media report. The data is below.

Return one CSV file. Header, exactly:

    Page path,Sessions,Conversions

One row per distinct journey:

    "/warehouse-jobs > /jobs > /jobs/apply > /contact",96,14
    "/warehouse-jobs > /jobs",118,0
    "/warehouse-jobs",240,0

- **Column 1** — the pages one group of sessions visited, in order, quoted, separated by ` > `.
  Paths only: no domain, query string or hash (`https://site.ca/jobs?loc=halifax` → `/jobs`).
  Home is `/`. Never the same page twice in a row. Long routes are fine — keep them whole.
- **Column 2** — how many sessions took exactly that route, start to finish. Whole numbers.
- **Column 3** — how many of those sessions produced a key event (form submission, lead).
  `0` for none. If the source has no conversion data at all, drop the column and its header
  rather than guessing.
- Every session appears on exactly one row, and rows are complete routes, not prefixes:
  a session that went `/a → /b → /c` belongs on `"/a > /b > /c"` only, never also on `"/a > /b"`.
- Sort by Sessions, largest first. No totals row, no "other" row, no notes inside the file.

Each row ends where the session ended — that is what the report draws as drop-off. If the
source only tells you how many people moved from one page to the next, rather than what whole
sessions did, say so and stop. Routes reconstructed from step totals are journeys nobody took.

Then, outside the file, tell me three things: which scope it covers (one campaign, or all paid
traffic — one scope per file), whether the Sessions column sums to the source's total paid
sessions, and anything you dropped, merged or assumed.

Data:

    [paste your GA4 export, spreadsheet, or BigQuery results here — or attach the file]

---

## Notes

- **Already have a GA4 path exploration CSV?** Upload it as-is. The importer reads that
  export's `STEP +0` / `STEP +1` columns natively — the prompt is for messier inputs.
- **Path exploration is a tree, not a list of sessions.** That is the trap the prompt guards
  against. For genuine whole-session journeys the clean source is the GA4 BigQuery export:
  `page_view` events grouped by `ga_session_id`, ordered by `event_timestamp`.
- **Long tail:** hand over every journey you have. Past 150 rows the importer keeps the
  strongest and sums the rest into one "other" row, which still counts toward the session
  totals but isn't drawn.
- **Re-importing replaces** that scope's journeys, so a corrected file can be uploaded over
  the old one safely.
