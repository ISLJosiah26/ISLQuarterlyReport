import { describe, it, expect } from "vitest";
import {
  normalizeStep,
  parseClickPaths,
  buildFlow,
  summarizePaths,
  topJourneys,
  MAX_PATHS,
  OTHER_PAGES,
  EXIT_LABEL,
} from "./clickPaths.js";

// The worked example most assertions below lean on:
//   200 sessions land on /lp; 150 go on to /jobs; 100 of those reach /apply.
const SAMPLE = [
  { steps: ["/lp", "/jobs", "/apply"], sessions: 100, conversions: 9 },
  { steps: ["/lp", "/jobs"], sessions: 50, conversions: 0 },
  { steps: ["/lp"], sessions: 50, conversions: 0 },
];

describe("normalizeStep", () => {
  it("reduces an absolute URL to its path", () => {
    expect(normalizeStep("https://integratedstaffing.ca/jobs")).toBe("/jobs");
  });

  it("drops query strings and hashes, which only split one page into many", () => {
    expect(normalizeStep("/jobs?location=halifax")).toBe("/jobs");
    expect(normalizeStep("/jobs#apply")).toBe("/jobs");
  });

  it("collapses a trailing slash but keeps the home page", () => {
    expect(normalizeStep("/jobs/")).toBe("/jobs");
    expect(normalizeStep("/")).toBe("/");
    expect(normalizeStep("https://integratedstaffing.ca/")).toBe("/");
  });

  it("treats end-of-session markers as not-a-step", () => {
    for (const marker of ["(not set)", "end", "(exit)", "Session end", ""]) {
      expect(normalizeStep(marker)).toBe("");
    }
  });
});

describe("parseClickPaths", () => {
  it("reads a GA4 path exploration export (one column per step)", () => {
    const csv = [
      "# Path exploration",
      "",
      "STEP +0,STEP +1,STEP +2,Sessions",
      "/lp,/jobs,/apply,100",
      "/lp,/jobs,,50",
      "/lp,,,50",
    ].join("\n");
    const out = parseClickPaths(csv);
    expect(out.rows).toEqual([
      { steps: ["/lp", "/jobs", "/apply"], sessions: 100, conversions: null },
      { steps: ["/lp", "/jobs"], sessions: 50, conversions: null },
      { steps: ["/lp"], sessions: 50, conversions: null },
    ]);
  });

  it("reads a single path column, however the route is delimited", () => {
    const csv = [
      "Page path,Sessions,Key events",
      '"/lp > /jobs > /apply",100,9',
      "/lp -> /jobs,50,0",
      "/lp → /contact,25,4",
    ].join("\n");
    const out = parseClickPaths(csv);
    expect(out.rows.map(r => r.steps)).toEqual([
      ["/lp", "/jobs", "/apply"],
      ["/lp", "/jobs"],
      ["/lp", "/contact"],
    ]);
    expect(out.rows[0].conversions).toBe(9);
    expect(out.rows[2].conversions).toBe(4);
  });

  it("reads header-less rows pasted from a spreadsheet", () => {
    const tsv = "/lp > /jobs\t120\t8\n/lp\t60\t0";
    expect(parseClickPaths(tsv).rows).toEqual([
      { steps: ["/lp", "/jobs"], sessions: 120, conversions: 8 },
      { steps: ["/lp"], sessions: 60, conversions: 0 },
    ]);
  });

  it("merges routes that arrive twice rather than double-listing them", () => {
    const out = parseClickPaths("Path,Sessions\n/lp > /jobs,40\n/LP > /jobs/,10");
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0].sessions).toBe(50);
  });

  it("ends a journey at a terminal marker instead of walking into it", () => {
    const out = parseClickPaths("Step 1,Step 2,Step 3,Sessions\n/lp,/jobs,(not set),30");
    expect(out.rows[0].steps).toEqual(["/lp", "/jobs"]);
  });

  it("collapses a page that repeats back to back", () => {
    const out = parseClickPaths("Step 1,Step 2,Step 3,Sessions\n/jobs,/jobs,/apply,30");
    expect(out.rows[0].steps).toEqual(["/jobs", "/apply"]);
  });

  it("sums the long tail into one 'other' row so shares keep a real denominator", () => {
    const lines = ["Path,Sessions"];
    for (let i = 0; i < MAX_PATHS + 20; i++) lines.push(`/p${i} > /jobs,${1000 - i}`);
    const out = parseClickPaths(lines.join("\n"));
    expect(out.truncated).toBe(20);
    expect(out.rows).toHaveLength(MAX_PATHS + 1);
    const tail = out.rows[out.rows.length - 1];
    expect(tail.isOther).toBe(true);
    expect(tail.sessions).toBe(out.droppedSessions);
    expect(summarizePaths(out.rows).sessions).toBe(
      lines.slice(1).reduce((a, l) => a + Number(l.split(",")[1]), 0)
    );
  });

  it("returns null for a file that isn't a path report", () => {
    expect(parseClickPaths("Job Function,Impressions\nEngineering,4000")).toBeNull();
    expect(parseClickPaths("")).toBeNull();
  });
});

describe("summarizePaths", () => {
  it("measures how far people got", () => {
    const s = summarizePaths(SAMPLE);
    expect(s.sessions).toBe(200);
    expect(s.journeys).toBe(3);
    expect(s.landingPages).toBe(1);
    expect(s.continued).toBe(150);
    expect(s.continuedPct).toBe(75);
    expect(s.avgSteps).toBeCloseTo((3 * 100 + 2 * 50 + 1 * 50) / 200);
    expect(s.deepest).toBe(3);
    expect(s.conversions).toBe(9);
    expect(s.conversionRate).toBeCloseTo(4.5);
    expect(s.coverage).toBe(100);
  });

  it("counts an 'other' lump toward sessions but not toward the drawn flow", () => {
    const s = summarizePaths([...SAMPLE, { steps: [], sessions: 50, isOther: true }]);
    expect(s.sessions).toBe(250);
    expect(s.drawn).toBe(200);
    expect(s.coverage).toBe(80);
    // The continued share still divides by the traffic with a known route.
    expect(s.continuedPct).toBe(75);
  });

  it("leaves conversions null when no source reported any", () => {
    const s = summarizePaths([{ steps: ["/lp"], sessions: 10 }]);
    expect(s.conversions).toBeNull();
    expect(s.conversionRate).toBeNull();
  });

  it("returns null when there is nothing to summarize", () => {
    expect(summarizePaths([])).toBeNull();
    expect(summarizePaths([{ steps: ["/lp"], sessions: 0 }])).toBeNull();
  });
});

describe("topJourneys", () => {
  it("ranks by sessions and shares out of the routed traffic", () => {
    const rows = topJourneys([...SAMPLE, { steps: [], sessions: 999, isOther: true }]);
    expect(rows.map(r => r.sessions)).toEqual([100, 50, 50]);
    expect(rows[0].share).toBe(50);
  });
});

describe("buildFlow", () => {
  const flow = buildFlow(SAMPLE);
  const col = d => flow.columns[d];
  const node = (d, label) => col(d).nodes.find(n => n.label === label);

  it("draws one column per step of the longest journey", () => {
    expect(flow.depth).toBe(3);
    expect(flow.total).toBe(200);
    expect(flow.truncatedDepth).toBe(false);
  });

  it("accounts for everyone in the following column", () => {
    expect(col(0).total).toBe(200);
    // Step 2: 150 moved on, 50 left — the whole 200 from step 1.
    expect(col(1).total).toBe(200);
    expect(node(1, "/jobs").value).toBe(150);
    expect(node(1, EXIT_LABEL).value).toBe(50);
    // Step 3 only carries the 150 still browsing; the earlier leavers are gone.
    expect(col(2).total).toBe(150);
    expect(node(2, "/apply").value).toBe(100);
    expect(node(2, EXIT_LABEL).value).toBe(50);
  });

  it("puts leavers last in a column so drop-off sits at one edge", () => {
    expect(col(1).nodes.map(n => n.label)).toEqual(["/jobs", EXIT_LABEL]);
  });

  it("stacks ribbons in node order, measured in sessions", () => {
    const out = flow.links.filter(l => l.from === col(1).nodes[0].key);
    expect(out.map(l => [l.value, l.fromOffset, l.toOffset])).toEqual([
      [100, 0, 0],   // /jobs → /apply
      [50, 100, 0],  // /jobs → left the site
    ]);
    for (const link of flow.links) expect(link.value).toBeGreaterThan(0);
  });

  it("folds the small pages of a column into one node", () => {
    const many = [];
    for (let i = 0; i < 10; i++) many.push({ steps: ["/lp", `/p${i}`], sessions: 100 - i * 5 });
    const f = buildFlow(many, { maxNodes: 3 });
    const folded = f.columns[1].nodes.find(n => n.label === OTHER_PAGES);
    expect(f.columns[1].nodes).toHaveLength(4);
    expect(folded.pages).toBe(7);
    expect(f.columns[1].total).toBe(f.total);
  });

  it("stops at the depth cap and says the routes ran past it", () => {
    const f = buildFlow([{ steps: ["/a", "/b", "/c", "/d", "/e"], sessions: 10 }], { maxDepth: 3 });
    expect(f.depth).toBe(3);
    expect(f.truncatedDepth).toBe(true);
    // Nothing "left the site" — those sessions were still going when the
    // diagram ran out of columns.
    expect(f.columns.every(c => c.nodes.every(n => !n.isExit))).toBe(true);
  });

  it("ignores the 'other' lump, which has no route to draw", () => {
    const f = buildFlow([...SAMPLE, { steps: [], sessions: 500, isOther: true }]);
    expect(f.total).toBe(200);
  });

  it("returns null when there is nothing to draw", () => {
    expect(buildFlow([])).toBeNull();
    expect(buildFlow([{ steps: [], sessions: 20, isOther: true }])).toBeNull();
  });
});
