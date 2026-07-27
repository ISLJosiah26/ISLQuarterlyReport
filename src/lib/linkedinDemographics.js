// Parser for LinkedIn audience exports.
//
// Two shapes arrive here, and both are handled by the same scan:
//
//   1. Campaign Manager "Demographics" exports (Analyze → Demographics →
//      Export) — one CSV per dimension, with a few report-metadata lines above
//      the real header row and columns like "Job Function, Impressions,
//      Clicks".
//   2. The Page analytics "Companies" export — one row per company, with
//      organic and paid metrics side by side ("Organic impressions", "Paid
//      impressions", "Paid clicks", …). Only the paid columns are of interest
//      here, since this feeds the Paid Media report.
//
// Both arrive with quoted fields containing commas ("Halifax, Nova Scotia
// Area"), thousands separators in counts, a UTF-8 BOM, and sometimes a
// trailing "Total" row — all absorbed here so the admin form can accept the
// file exactly as LinkedIn produced it.
import { parseCsvRecords } from "./formSubmissions.js";

// Canonical dimensions, in the order the report presents them.
export const AUDIENCE_DIMENSIONS = [
  { key: "job_function", label: "Job Function" },
  { key: "seniority",    label: "Seniority" },
  { key: "industry",     label: "Industry" },
  { key: "company_size", label: "Company Size" },
  { key: "location",     label: "Location" },
  { key: "company",      label: "Company" },
  { key: "job_title",    label: "Job Title" },
];

export const AUDIENCE_DIMENSION_LABELS = Object.fromEntries(
  AUDIENCE_DIMENSIONS.map(d => [d.key, d.label])
);

// The Companies export runs to thousands of rows, nearly all of them a single
// impression deep. Only the strongest MAX_SEGMENTS are stored; the rest are
// summed into one trailing row so the report's share-of-impressions still
// divides by the real total rather than by whatever survived the cut.
export const MAX_SEGMENTS = 100;

const otherLabel = (n) => `Other (${n.toLocaleString()} more)`;

// Companies rank by clicks rather than impressions. On the other dimensions
// the question is who the ads reached, and impressions answer it; on a list of
// thousands of named accounts the useful question is which ones responded, and
// a company that clicked twice is worth more attention than one served 400
// impressions that never did. Impressions break the tie, so the zero-click
// tail still leads with the companies that saw the ads most.
//
// This orders the stored rows, so it also decides which segments survive the
// MAX_SEGMENTS cut — the clickers are kept, not just the most-served.
const RANK_BY_CLICKS = new Set(["company"]);

function compareSegments(dimension) {
  if (!RANK_BY_CLICKS.has(dimension)) return (a, b) => b.impressions - a.impressions;
  return (a, b) => (b.clicks || 0) - (a.clicks || 0) || b.impressions - a.impressions;
}

// Header-name → dimension key. Ordered so the more specific names win
// ("company size" before "company").
const DIMENSION_MATCHERS = [
  { key: "job_function", re: /job function|member function/ },
  { key: "seniority",    re: /seniority/ },
  { key: "industry",     re: /industry/ },
  { key: "company_size", re: /company size/ },
  { key: "job_title",    re: /job title/ },
  { key: "location",     re: /location|region|geo/ },
  { key: "company",      re: /company/ },
];

// Columns that name the segment but aren't the segment itself — the Companies
// export leads with "Company name" then "Company page URL", and a URL column
// would otherwise be a perfectly good dimension match.
const NOT_A_SEGMENT = /\burl\b|link|website/i;

// "1,234" → 1234. Returns null for blanks and anything non-numeric (a stray
// "-" placeholder, or a rate column routed here by a malformed row).
function parseCount(value) {
  const s = String(value ?? "").replace(/,/g, "").trim();
  if (!s || !/^\d+(\.\d+)?$/.test(s)) return null;
  return Math.round(Number(s));
}

function detectDimension(header) {
  const h = header.toLowerCase();
  for (const m of DIMENSION_MATCHERS) {
    if (m.re.test(h)) return m.key;
  }
  return null;
}

// Picks the metric column to read. Paid wins over organic: a Companies export
// carries both, and only the paid side belongs in a paid media report. An
// organic-only column is never used — that file has nothing to say about ads.
function findMetricColumn(headers, re) {
  const matches = headers
    .map((h, i) => ({ h: h.toLowerCase(), i }))
    .filter(({ h }) => re.test(h));
  const paid = matches.find(({ h }) => /paid/.test(h));
  if (paid) return paid.i;
  const neutral = matches.find(({ h }) => !/organic/.test(h));
  return neutral ? neutral.i : -1;
}

// Parses a LinkedIn audience export. Returns
//   { dimension, rows: [{ segment, impressions, clicks }], truncated }
// where `truncated` counts segments dropped past MAX_SEGMENTS, or null when no
// usable header row can be found (wrong file).
export function parseLinkedInDemographics(text) {
  const records = parseCsvRecords(String(text ?? "").replace(/^\uFEFF/, ""));

  // Hunt for the real header row: metadata preamble lines precede it, so scan
  // until a record pairs a known dimension column with an impressions column.
  for (let i = 0; i < records.length; i++) {
    const headers = records[i].map(h => h.trim());
    const iImpressions = findMetricColumn(headers, /impression/);
    if (iImpressions === -1) continue;

    let iSegment = -1, dimension = null;
    for (let c = 0; c < headers.length; c++) {
      if (c === iImpressions || NOT_A_SEGMENT.test(headers[c])) continue;
      const d = detectDimension(headers[c]);
      if (d) { iSegment = c; dimension = d; break; }
    }
    if (!dimension) continue;

    // "Clicks" / "Paid clicks" only — not "Click Through Rate" / "Cost Per Click".
    const iClicks = findMetricColumn(headers, /^(paid |organic )?clicks?$/);

    const rows = [];
    for (let r = i + 1; r < records.length; r++) {
      const cols = records[r];
      const segment = (cols[iSegment] ?? "").trim();
      if (!segment || /^total$/i.test(segment)) continue;
      const impressions = parseCount(cols[iImpressions]);
      // A segment with no impressions was never actually reached — the
      // Companies export lists every company the page has ever touched, most
      // of which the ads never served to.
      if (!impressions) continue;
      rows.push({
        segment,
        impressions,
        clicks: iClicks !== -1 ? parseCount(cols[iClicks]) : null,
        isOther: false,
      });
    }
    if (!rows.length) return null;

    rows.sort(compareSegments(dimension));
    const kept = rows.slice(0, MAX_SEGMENTS);
    const tail = rows.slice(MAX_SEGMENTS);
    if (tail.length) {
      kept.push({
        segment: otherLabel(tail.length),
        impressions: tail.reduce((a, r) => a + r.impressions, 0),
        clicks: tail.some(r => r.clicks != null)
          ? tail.reduce((a, r) => a + (r.clicks || 0), 0)
          : null,
        isOther: true,
      });
    }
    return { dimension, rows: kept, truncated: tail.length };
  }
  return null;
}
