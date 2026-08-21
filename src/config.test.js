import { describe, it, expect } from "vitest";
import { quarterForMonthYear, QUARTERS, TRENDS_QUARTERS, CURRENT_QUARTER, resolveQuarter, quarterYear } from "./config.js";

describe("quarterForMonthYear (fiscal year starts September)", () => {
  it("maps months to the right fiscal quarter", () => {
    expect(quarterForMonthYear(8, 2025).suffix).toBe("q1");  // September
    expect(quarterForMonthYear(10, 2025).suffix).toBe("q1"); // November
    expect(quarterForMonthYear(11, 2025).suffix).toBe("q2"); // December
    expect(quarterForMonthYear(1, 2026).suffix).toBe("q2");  // February (wraps year)
    expect(quarterForMonthYear(2, 2026).suffix).toBe("q3");  // March
    expect(quarterForMonthYear(5, 2026).suffix).toBe("q4");  // June
    expect(quarterForMonthYear(7, 2026).suffix).toBe("q4");  // August
  });

  it("labels the quarter with the calendar year of its last day", () => {
    const q2 = quarterForMonthYear(0, 2026); // January → Q2 Dec 2025–Feb 2026
    expect(q2.year).toBe("2026");
    expect(q2.start.getFullYear()).toBe(2025);
  });

  it("produces contiguous start/end boundaries", () => {
    const q1 = quarterForMonthYear(8, 2025);
    const q2 = quarterForMonthYear(11, 2025);
    expect(q1.end.getTime()).toBe(q2.start.getTime());
  });
});

describe("derived quarter lists", () => {
  it("QUARTERS is most-recent-first and contiguous", () => {
    expect(QUARTERS).toHaveLength(4);
    for (let i = 0; i < QUARTERS.length - 1; i++) {
      expect(QUARTERS[i + 1].end.getTime()).toBe(QUARTERS[i].start.getTime());
    }
    expect(QUARTERS[0].suffix).toBe(CURRENT_QUARTER.suffix);
  });

  it("TRENDS_QUARTERS is oldest-first ending at the current quarter", () => {
    expect(TRENDS_QUARTERS).toHaveLength(3);
    expect(TRENDS_QUARTERS[2].suffix).toBe(CURRENT_QUARTER.suffix);
    expect(TRENDS_QUARTERS[0].start.getTime()).toBeLessThan(TRENDS_QUARTERS[2].start.getTime());
  });
});

describe("resolveQuarter", () => {
  it("resolves every navigable suffix to that exact quarter", () => {
    for (const q of QUARTERS) {
      expect(resolveQuarter(q.suffix)).toBe(q);
      expect(quarterYear(q.suffix)).toBe(q.year);
    }
  });

  it("falls back to the current quarter for an unknown suffix", () => {
    expect(resolveQuarter("q9")).toBe(CURRENT_QUARTER);
    expect(resolveQuarter(undefined)).toBe(CURRENT_QUARTER);
  });

  it("gives the same suffix different years across a fiscal-year boundary", () => {
    // The whole reason the year exists: q1 in the nav window and the q1 that
    // comes round next September are different quarters, and the database
    // must be able to hold both.
    const thisQ1 = quarterForMonthYear(9, 2025);  // Oct 2025 -> q1 2025
    const nextQ1 = quarterForMonthYear(9, 2026);  // Oct 2026 -> q1 2026
    expect(thisQ1.suffix).toBe(nextQ1.suffix);
    expect(thisQ1.year).not.toBe(nextQ1.year);
  });

  it("labels a December quarter with the year it ends in", () => {
    // q2 spans Dec-Feb, so a December date belongs to the next year's label —
    // the one case the SQL backfill has to special-case too.
    expect(quarterForMonthYear(11, 2025).year).toBe("2026");
  });
});
