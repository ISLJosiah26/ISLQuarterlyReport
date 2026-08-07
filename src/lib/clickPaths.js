// Post-click journeys: what people who clicked a paid ad did on the site.
//
// A journey is an ordered list of page paths plus the number of sessions that
// followed exactly that route, and it ends where the session ended. Everything
// the report shows is derived from that one shape:
//
//   • the landing pages the ads bought          (step 1 of every journey)
//   • the flow from step to step, and where it leaks   (buildFlow)
//   • how far people got, and how many converted        (summarizePaths)
//
// Storing journeys rather than aggregate per-step counts is what makes the
// flow drawable at all: "40 sessions saw /jobs" can't tell you where they came
// from or went next, and a Sankey needs exactly that.
import { parseCsvRecords } from "./formSubmissions.js";

// How many journeys are kept from an import. The tail of a path report is
// mostly one-session routes; past this they're summed into a single "other"
// row that counts toward the totals but isn't drawn.
export const MAX_PATHS = 150;

// Columns drawn in the flow. Four is the practical ceiling for a page-width
// diagram — beyond it the ribbons are thinner than their own labels, and the
// journeys table below carries the full route anyway.
export const MAX_DEPTH = 4;

// Pages shown per column before the rest are folded into one "Other pages"
// node. Six keeps every band thick enough to see at a glance.
export const MAX_NODES_PER_COLUMN = 6;

export const OTHER_PAGES = "Other pages";
export const EXIT_LABEL = "Left the site";

// Terminal markers various exports use for "the session ended here". They're
// not pages, so they end the journey rather than becoming a step of their own.
const TERMINAL = /^\(?(not set|none|no data|end|exit|exited|complete[d]?|session end|drop-?off)\)?$/i;

// A page path, tidied for grouping. Hosts, query strings and hashes are
// dropped: they multiply one page into dozens of near-identical nodes
// ("/jobs", "/jobs?loc=halifax", "/jobs#apply") and the distinction never
// survives into the report anyway. Returns "" for anything that isn't a step.
export function normalizeStep(raw) {
  let s = String(raw ?? "").trim().replace(/^"|"$/g, "").trim();
  if (!s || TERMINAL.test(s)) return "";
  // Absolute URL → path. Anything else (a bare path, or a page title) is left
  // alone, since an export that names pages by title is still readable.
  s = s.replace(/^[a-z]+:\/\/[^/]+/i, "");
  s = s.split(/[?#]/)[0].trim();
  if (!s) return "/";
  // Collapse a trailing slash, but never turn the home page into "".
  if (s.length > 1) s = s.replace(/\/+$/, "") || "/";
  return s;
}

// How a step reads in the report. The root path is a slash on screen and
// nothing else — "Home" is the name people actually use for it.
export function stepLabel(step) {
  return step === "/" ? "Home" : step;
}

// Journeys are identified by their route, so re-importing a file merges rather
// than duplicating, and two spellings of the same route collapse into one.
export const pathKey = (steps) => steps.join("\n").toLowerCase();

// ─── Import ───────────────────────────────────────────────────────
// Three shapes arrive here, and one scan handles all of them:
//
//   1. GA4 Path exploration export — one column per step ("Step +0",
//      "Step +1", …) plus a count column.
//   2. A path column ("Page path / Journey / Route") holding a delimited
//      route, plus a count column.
//   3. Rows pasted straight out of a spreadsheet with no header at all:
//      "/jobs > /apply<TAB>120<TAB>8".
//
// Returns { rows, truncated, droppedSessions } or null when nothing usable is
// found, so the admin can say "that isn't a path export" rather than silently
// importing zero rows.

const STEP_HEADER = /^(step|page|node|screen)\s*[+#]?\s*\d+$|^step\b/i;
const PATH_HEADER = /path|journey|route|sequence|pages?$/i;
const COUNT_HEADERS = [
  /^sessions?$/i,
  /session/i,
  /^(total |active )?users?$/i,
  /event count|views?|count|total/i,
];
const CONVERSION_HEADER = /conversion|key event|goal|form submission|submission/i;
// Delimiters a route can be written with, longest first so "->" doesn't get
// eaten by "-".
const STEP_SPLIT = /\s*(?:->|=>|→|›|»|>|\|)\s*/;

const cleanCount = (v) => {
  const s = String(v ?? "").replace(/[,\s]/g, "");
  if (!s || !/^\d+(\.\d+)?$/.test(s)) return null;
  return Math.round(Number(s));
};

// Comma-separated files go through the RFC 4180 parser (page paths can carry
// commas inside quotes); tab-separated text — what you get pasting from a
// spreadsheet — is split on tabs instead.
function toRecords(text) {
  const src = String(text ?? "").replace(/^\uFEFF/, "");
  const lines = src.split(/\r?\n/).filter(l => l.trim() !== "");
  const tabs = lines.filter(l => l.includes("\t")).length;
  if (tabs > lines.length / 2) return lines.map(l => l.split("\t"));
  return parseCsvRecords(src);
}

function findHeader(headers, re) {
  return headers.findIndex(h => re.test(h));
}

function findCount(headers, skip = new Set()) {
  for (const re of COUNT_HEADERS) {
    const i = headers.findIndex((h, idx) => !skip.has(idx) && re.test(h));
    if (i !== -1) return i;
  }
  return -1;
}

// Trailing numeric columns of a header-less row: [sessions] or
// [sessions, conversions]. Anything else and the row isn't usable.
function splitTrailingCounts(cols) {
  const counts = [];
  let i = cols.length - 1;
  while (i > 0 && counts.length < 2) {
    const n = cleanCount(cols[i]);
    if (n === null) break;
    counts.unshift(n);
    i--;
  }
  return { head: cols.slice(0, i + 1), counts };
}

// The route a row describes, from whatever cells or fragments it arrived in.
function stepsFrom(rawSteps) {
  const steps = [];
  for (const raw of rawSteps) {
    const step = normalizeStep(raw);
    // A terminal marker ends the journey; a blank cell is just an unused step
    // column on a shorter route, so keep scanning.
    if (!step) {
      if (String(raw ?? "").trim()) break;
      continue;
    }
    // Consecutive repeats are one page re-rendering (a filter change, a
    // pagination click), not a step of the journey.
    if (steps[steps.length - 1] !== step) steps.push(step);
  }
  return steps;
}

// One route written as text — "/jobs > /apply" — as the admin form stores and
// edits it. Same rules as an imported row, so a hand-typed journey and an
// imported one can't disagree about what they mean.
export function parseRoute(text) {
  return stepsFrom(String(text ?? "").split(STEP_SPLIT));
}

export const formatRoute = (steps) => (steps || []).join(" > ");

function buildRow(rawSteps, sessions, conversions) {
  const steps = stepsFrom(rawSteps);
  if (!steps.length || !sessions) return null;
  return { steps, sessions, conversions };
}

export function parseClickPaths(text) {
  const records = toRecords(text);
  if (!records.length) return null;

  const merged = new Map();
  const add = (row) => {
    if (!row) return;
    const key = pathKey(row.steps);
    const prev = merged.get(key);
    if (!prev) {
      merged.set(key, { ...row });
      return;
    }
    prev.sessions += row.sessions;
    if (row.conversions != null) prev.conversions = (prev.conversions ?? 0) + row.conversions;
  };

  // Hunt for a header row: exports put a metadata preamble above it, so scan
  // until a record pairs a route (step columns or a path column) with a count.
  let headerRow = -1;
  for (let i = 0; i < records.length && headerRow === -1; i++) {
    const headers = records[i].map(h => String(h ?? "").trim());
    const stepCols = headers.map((h, idx) => (STEP_HEADER.test(h) ? idx : -1)).filter(idx => idx !== -1);
    const iPath = stepCols.length ? -1 : findHeader(headers, PATH_HEADER);
    if (!stepCols.length && iPath === -1) continue;

    const used = new Set(stepCols.concat(iPath === -1 ? [] : [iPath]));
    const iCount = findCount(headers, used);
    if (iCount === -1) continue;
    const iConv = headers.findIndex((h, idx) => idx !== iCount && !used.has(idx) && CONVERSION_HEADER.test(h));

    headerRow = i;
    for (const cols of records.slice(i + 1)) {
      const sessions = cleanCount(cols[iCount]);
      const rawSteps = stepCols.length
        ? stepCols.map(c => cols[c])
        : String(cols[iPath] ?? "").split(STEP_SPLIT);
      add(buildRow(rawSteps, sessions, iConv === -1 ? null : cleanCount(cols[iConv])));
    }
  }

  // No header anywhere — read every row as "route, sessions[, conversions]".
  // Nothing labelled the columns here, so a row has to look like a route on
  // its own merits, or any two-column export ("Engineering,4000") would import
  // as a set of one-step journeys.
  if (headerRow === -1) {
    for (const cols of records) {
      const { head, counts } = splitTrailingCounts(cols);
      if (!counts.length || !head.length) continue;
      const rawSteps = head.length > 1 ? head : String(head[0] ?? "").split(STEP_SPLIT);
      const row = buildRow(rawSteps, counts[0], counts.length > 1 ? counts[1] : null);
      if (row && (row.steps.length > 1 || row.steps[0].startsWith("/"))) add(row);
    }
  }

  // Ranked by sessions, then by how far the route got — of two journeys the
  // same size, the longer one says more about what people did.
  const rows = [...merged.values()].sort(
    (a, b) => b.sessions - a.sessions || b.steps.length - a.steps.length
  );
  if (!rows.length) return null;

  const kept = rows.slice(0, MAX_PATHS);
  const tail = rows.slice(MAX_PATHS);
  const droppedSessions = tail.reduce((a, r) => a + r.sessions, 0);
  if (tail.length) {
    kept.push({
      steps: [],
      sessions: droppedSessions,
      conversions: tail.some(r => r.conversions != null)
        ? tail.reduce((a, r) => a + (r.conversions || 0), 0)
        : null,
      isOther: true,
    });
  }
  return { rows: kept, truncated: tail.length, droppedSessions };
}

// ─── Summary ──────────────────────────────────────────────────────
// Split once, here, so every consumer agrees on what counts: a journey is a
// real route with sessions behind it; the "other" row is a session total with
// no route, present only so shares divide by the real denominator.
function splitJourneys(paths) {
  const journeys = [], other = [];
  for (const p of paths || []) {
    const sessions = typeof p.sessions === "number" ? p.sessions : 0;
    if (sessions <= 0) continue;
    (p.isOther || !p.steps?.length ? other : journeys).push({ ...p, sessions });
  }
  return { journeys, other };
}

export function summarizePaths(paths) {
  const { journeys, other } = splitJourneys(paths);
  const drawn = journeys.reduce((a, p) => a + p.sessions, 0);
  const otherSessions = other.reduce((a, p) => a + p.sessions, 0);
  const sessions = drawn + otherSessions;
  if (!sessions) return null;

  const continued = journeys.reduce((a, p) => a + (p.steps.length > 1 ? p.sessions : 0), 0);
  const stepSum = journeys.reduce((a, p) => a + p.steps.length * p.sessions, 0);
  const hasConversions = [...journeys, ...other].some(p => typeof p.conversions === "number");
  const conversions = hasConversions
    ? [...journeys, ...other].reduce((a, p) => a + (p.conversions || 0), 0)
    : null;

  return {
    sessions,
    drawn,
    otherSessions,
    journeys: journeys.length,
    landingPages: new Set(journeys.map(p => p.steps[0])).size,
    continued,
    continuedPct: drawn ? (continued / drawn) * 100 : null,
    avgSteps: drawn ? stepSum / drawn : null,
    deepest: journeys.reduce((a, p) => Math.max(a, p.steps.length), 0),
    conversions,
    conversionRate: conversions != null && sessions ? (conversions / sessions) * 100 : null,
    // What share of sessions the flow diagram actually draws — under 100% once
    // an import was long enough to be truncated.
    coverage: sessions ? (drawn / sessions) * 100 : null,
  };
}

// Journeys ranked by sessions, with each one's share of the routed traffic.
export function topJourneys(paths) {
  const { journeys } = splitJourneys(paths);
  const drawn = journeys.reduce((a, p) => a + p.sessions, 0);
  return journeys
    .sort((a, b) => b.sessions - a.sessions || b.steps.length - a.steps.length)
    .map(p => ({
      steps: p.steps,
      key: pathKey(p.steps),
      sessions: p.sessions,
      conversions: typeof p.conversions === "number" ? p.conversions : null,
      share: drawn ? (p.sessions / drawn) * 100 : null,
    }));
}

// ─── Flow ─────────────────────────────────────────────────────────
// Turns journeys into the node/link graph the diagram draws. Everyone standing
// in a column is accounted for in the next one: they either moved to another
// page or landed in that column's "Left the site" node. Leavers are terminal,
// so each column is shorter than the one before it by exactly the traffic that
// left — the narrowing is the drop-off, drawn to scale.
//
// Columns stop at the longest journey rather than one past it. A trailing
// all-exits column would only restate that sessions eventually end, which is
// true of every session and worth none of the width.
//
// Geometry stays out of this on purpose — offsets are in sessions, not pixels,
// so the layout is testable without a DOM and the component owns the scale.
export function buildFlow(paths, { maxDepth = MAX_DEPTH, maxNodes = MAX_NODES_PER_COLUMN } = {}) {
  const { journeys } = splitJourneys(paths);
  const total = journeys.reduce((a, p) => a + p.sessions, 0);
  if (!total) return null;

  const longest = journeys.reduce((a, p) => Math.max(a, p.steps.length), 0);
  const depth = Math.min(maxDepth, longest);

  // Which pages are big enough to stand alone at each step; the rest fold into
  // one "Other pages" node so a column never turns into a hairline comb.
  const keep = [];
  for (let d = 0; d < depth; d++) {
    const totals = new Map();
    for (const p of journeys) {
      if (p.steps.length <= d) continue;
      totals.set(p.steps[d], (totals.get(p.steps[d]) || 0) + p.sessions);
    }
    keep.push(new Set(
      [...totals.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, maxNodes)
        .map(([label]) => label)
    ));
  }

  const nodeAt = (d, step) => {
    if (step === null) return { key: "exit@" + d, label: EXIT_LABEL, isExit: true };
    const folded = keep[d].has(step) ? step : OTHER_PAGES;
    return { key: `${d}:${folded}`, label: folded, isOther: folded === OTHER_PAGES && folded !== step };
  };

  const nodes = new Map();
  const bump = (d, step, sessions) => {
    const { key, label, isExit, isOther } = nodeAt(d, step);
    const node = nodes.get(key) ||
      { key, depth: d, label, value: 0, isExit: !!isExit, isOther: false, pages: new Set() };
    node.value += sessions;
    node.isOther = node.isOther || !!isOther;
    if (!isExit) node.pages.add(step);
    nodes.set(key, node);
    return node;
  };

  const links = new Map();
  for (const p of journeys) {
    for (let d = 0; d < depth; d++) {
      if (p.steps.length <= d) break;
      bump(d, p.steps[d], p.sessions);
      if (d + 1 >= depth) break;
      // Ran out of route: the session left from here, and lands in the next
      // column's exit node. A session still browsing is counted by the next
      // turn of this loop instead — bumping it here too would double it.
      const next = p.steps.length > d + 1 ? p.steps[d + 1] : null;
      if (next === null) bump(d + 1, null, p.sessions);
      const from = nodeAt(d, p.steps[d]).key;
      const to = nodeAt(d + 1, next).key;
      const key = from + " => " + to;
      const link = links.get(key) || { key, from, to, value: 0, isExit: next === null };
      link.value += p.sessions;
      links.set(key, link);
    }
  }

  // Column order: biggest page first, the folded "Other pages" beneath the
  // named ones, and the exits last so drop-off always sits at the same edge.
  const rank = (n) => (n.isExit ? 2 : n.isOther ? 1 : 0);
  const columns = [];
  for (let d = 0; d < depth; d++) {
    const colNodes = [...nodes.values()]
      .filter(n => n.depth === d)
      .sort((a, b) => rank(a) - rank(b) || b.value - a.value || a.label.localeCompare(b.label))
      .map((n, order) => ({ ...n, order, pages: n.pages.size, share: (n.value / total) * 100 }));
    if (colNodes.length) {
      columns.push({ depth: d, nodes: colNodes, total: colNodes.reduce((a, n) => a + n.value, 0) });
    }
  }

  const order = new Map(columns.flatMap(c => c.nodes.map(n => [n.key, n.order])));
  const linkList = [...links.values()].sort(
    (a, b) => (order.get(a.from) - order.get(b.from)) || (order.get(a.to) - order.get(b.to))
  );

  // Where each ribbon attaches, measured in sessions down from the top of the
  // node it leaves and the node it enters. Following node order on both ends
  // keeps the ribbons from braiding through each other.
  const fromUsed = new Map(), toUsed = new Map();
  for (const link of linkList) {
    link.fromOffset = fromUsed.get(link.from) || 0;
    link.toOffset = toUsed.get(link.to) || 0;
    fromUsed.set(link.from, link.fromOffset + link.value);
    toUsed.set(link.to, link.toOffset + link.value);
  }

  return {
    columns,
    links: linkList,
    total,
    depth: columns.length,
    // Tallest column in sessions — every column bar the last totals the whole
    // audience, so this is the scale the diagram is drawn against.
    maxColumn: Math.max(...columns.map(c => c.total)),
    // True when journeys were still running at the last column drawn.
    truncatedDepth: longest > depth,
  };
}
