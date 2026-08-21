export const AGENCIES = {
  isl: { label: "ISL", name: "Integrated Staffing",    prefix: "isl", url: "https://integratedstaffing.ca" },
  as:  { label: "AS",  name: "Accountant Staffing",     prefix: "as",  url: "https://accountantstaffing.ca" },
  ads: { label: "ADS", name: "Administrative Staffing", prefix: "ads", url: "https://administrativestaffing.ca" },
};

export const VIEWS = ["social", "web", "paid", "trends"];

export const REPORT_AUTHOR = "Josiah Yule";

// All "what quarter is it right now" decisions use the agencies' home
// timezone, so every viewer sees the same default quarter regardless of
// where (or with what system clock) they open the report.
export const REPORT_TZ = "America/Halifax";

function nowInReportTZ() {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: REPORT_TZ, year: "numeric", month: "numeric",
    }).formatToParts(new Date());
    const get = (type) => Number(parts.find(p => p.type === type)?.value);
    const y = get("year"), m = get("month");
    if (Number.isFinite(y) && Number.isFinite(m)) return { y, m: m - 1 };
  } catch {
    // Intl timezone data unavailable — fall through to local time
  }
  const d = new Date();
  return { y: d.getFullYear(), m: d.getMonth() };
}

// ─── Quarter calendar (fiscal year starts September) ──────────────
// startM / endM are 0-indexed months; endM is the exclusive boundary
// (first month of the following quarter, same convention as Date math).
const Q_DEFS = [
  { suffix: "q1", label: "Q1", startM: 8,  endM: 11, range: "Sep–Nov" },
  { suffix: "q2", label: "Q2", startM: 11, endM: 2,  range: "Dec–Feb" },
  { suffix: "q3", label: "Q3", startM: 2,  endM: 5,  range: "Mar–May" },
  { suffix: "q4", label: "Q4", startM: 5,  endM: 8,  range: "Jun–Aug" },
];

function buildQuarter(def, startYear) {
  const endYear = def.endM <= def.startM ? startYear + 1 : startYear;
  const start   = new Date(startYear, def.startM, 1);
  const end     = new Date(endYear,   def.endM,   1);
  // year label = calendar year of the last day of the quarter
  const year    = String(new Date(end.getTime() - 86400000).getFullYear());
  return { suffix: def.suffix, label: def.label, rangeLabel: `${def.range} ${year}`, year, start, end };
}

export function quarterForMonthYear(m, y) {
  for (const def of Q_DEFS) {
    if (def.startM < def.endM) {
      if (m >= def.startM && m < def.endM) return buildQuarter(def, y);
    } else {
      // Quarter wraps the calendar year boundary (Q2: Dec–Feb)
      if (m >= def.startM) return buildQuarter(def, y);
      if (m < def.endM)    return buildQuarter(def, y - 1);
    }
  }
}

function quarterForDate(date) {
  return quarterForMonthYear(date.getMonth(), date.getFullYear());
}

function recentQuarters(n) {
  const list = [];
  const { y, m } = nowInReportTZ();
  let q = quarterForMonthYear(m, y);
  for (let i = 0; i < n; i++) {
    list.push(q);
    q = quarterForDate(new Date(q.start.getTime() - 86400000));
  }
  return list;
}

// Auto-detected from today's date (in REPORT_TZ) — no manual update on rollover
export const CURRENT_QUARTER = recentQuarters(1)[0];

// Navigation list — most-recent-first, for the quarter chooser dropdown
export const QUARTERS = recentQuarters(4);

// Trends analysis — oldest-first ([0]=two-ago, [1]=previous, [2]=current)
export const TRENDS_QUARTERS = recentQuarters(3).reverse();

// A quarter suffix on its own ("q1") does not identify a quarter — it repeats
// every year, and the database now keys on (quarter, year). Suffixes stay
// unambiguous *within* the navigable window, so the URL can keep carrying just
// the suffix; every query resolves it to a full quarter here first. Falls back
// to the current quarter for an unrecognised suffix, matching how useUrlState
// and main.jsx already treat one.
export function resolveQuarter(suffix) {
  return QUARTERS.find(q => q.suffix === suffix) || CURRENT_QUARTER;
}

// Year label for a quarter suffix, for queries that need nothing else.
export function quarterYear(suffix) {
  return resolveQuarter(suffix).year;
}
