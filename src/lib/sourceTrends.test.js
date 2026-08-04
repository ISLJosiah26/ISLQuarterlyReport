import { describe, it, expect } from "vitest";
import { buildSourceTrend, findSourceSpike } from "./sourceTrends.js";

const WEEKS = ["2026-06-01", "2026-06-08", "2026-06-15", "2026-06-22", "2026-06-29"];

describe("buildSourceTrend", () => {
  it("zero-fills weeks with no answers and keeps the ranked order", () => {
    const { rows, max, coveredFrom } = buildSourceTrend({
      sourceWeekly: [
        { week: "2026-06-01", source: "Google Search", count: 4 },
        { week: "2026-06-15", source: "Google Search", count: 9 },
        { week: "2026-06-15", source: "LinkedIn", count: 2 },
      ],
      sources: [{ source: "Google Search", count: 13 }, { source: "LinkedIn", count: 2 }],
      weekKeys: WEEKS,
      since: null,
    });
    expect(rows.map(r => r.source)).toEqual(["Google Search", "LinkedIn"]);
    expect(rows[0].values).toEqual([4, 0, 9, 0, 0]);
    expect(rows[1].values).toEqual([0, 0, 2, 0, 0]);
    expect(rows[0].peak).toBe(9);
    expect(rows[0].peakAt).toBe(2);
    expect(max).toBe(9);
    expect(coveredFrom).toBe(0);
  });

  it("ignores weeks outside the quarter and answers not in the ranking", () => {
    const { rows } = buildSourceTrend({
      sourceWeekly: [
        { week: "2026-05-25", source: "Google Search", count: 7 },
        { week: "2026-06-08", source: "Retired Answer", count: 3 },
        { week: "2026-06-08", source: "Google Search", count: 1 },
      ],
      sources: [{ source: "Google Search", count: 1 }],
      weekKeys: WEEKS,
      since: null,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].values).toEqual([0, 1, 0, 0, 0]);
  });

  it("marks the first covered week from the day the question appeared", () => {
    // Asked from Jun 17 — that falls inside the week beginning Jun 15.
    const { coveredFrom } = buildSourceTrend({
      sourceWeekly: [],
      sources: [{ source: "Google Search", count: 1 }],
      weekKeys: WEEKS,
      since: "2026-06-17",
    });
    expect(coveredFrom).toBe(2);
  });

  it("treats a question older than the quarter as covering all of it", () => {
    const { coveredFrom } = buildSourceTrend({
      sourceWeekly: [],
      sources: [{ source: "Google Search", count: 1 }],
      weekKeys: WEEKS,
      since: "2026-01-04",
    });
    expect(coveredFrom).toBe(0);
  });

  it("returns nothing to draw when there are no answers", () => {
    expect(buildSourceTrend({ sourceWeekly: [], sources: [], weekKeys: WEEKS, since: null }))
      .toEqual({ rows: [], max: 0, coveredFrom: 0 });
  });
});

describe("findSourceSpike", () => {
  const row = (source, values) => {
    let peak = 0, peakAt = 0;
    values.forEach((v, i) => { if (v > peak) { peak = v; peakAt = i; } });
    return { source, total: values.reduce((a, b) => a + b, 0), values, peak, peakAt };
  };

  it("finds the answer whose best week most outruns its own normal week", () => {
    const spike = findSourceSpike([
      row("Google Search", [10, 12, 11, 51, 13]),
      row("Referral",      [5, 4, 6, 6, 5]),
    ]);
    expect(spike).toMatchObject({ source: "Google Search", count: 51, at: 3, typical: 11.5 });
  });

  it("ranks by extra submissions, not by multiple", () => {
    const spike = findSourceSpike([
      row("Google Search", [10, 12, 11, 30, 13]),  // 2.6x, but +19 submissions
      row("LinkedIn",      [1, 0, 1, 9, 1]),       // 9x, and only +8 submissions
    ]);
    expect(spike.source).toBe("Google Search");
  });

  it("still needs a doubling — a big answer drifting up is not a spike", () => {
    // +18 in its best week, but only 1.6x its normal week.
    expect(findSourceSpike([row("Google Search", [30, 28, 31, 48, 29])])).toBeNull();
  });

  it("stays quiet when nothing stands out", () => {
    expect(findSourceSpike([row("Google Search", [10, 12, 11, 14, 13])])).toBeNull();
  });

  it("ignores small numbers and short histories", () => {
    expect(findSourceSpike([row("Instagram", [0, 0, 0, 4, 0])])).toBeNull();
    expect(findSourceSpike([row("Instagram", [0, 9, 0])])).toBeNull();
  });

  it("only weighs weeks the question was actually asked in", () => {
    // The three leading zeroes are "not asked yet", so the last two weeks are
    // the whole history — too short to call anything a spike.
    expect(findSourceSpike([row("Google Search", [0, 0, 0, 20, 2])], 3)).toBeNull();
  });
});
