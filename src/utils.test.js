import { describe, it, expect } from "vitest";
import { fmt, fmtExact, fmtPct, fmtTime, toNumber, calcAutoDelta, parseDelta, adSpend, sumPaidMediaAds } from "./utils.js";

describe("fmt", () => {
  it("abbreviates large numbers", () => {
    expect(fmt(2_450_000)).toBe("2.45M");
    expect(fmt(12_300)).toBe("12K");
    expect(fmt(1_500)).toBe("1.5K");
  });
  it("renders small integers with locale grouping", () => {
    expect(fmt(999)).toBe("999");
  });
  it("renders null/undefined as em dash", () => {
    expect(fmt(null)).toBe("—");
    expect(fmt(undefined)).toBe("—");
  });
});

describe("fmtExact / fmtPct / fmtTime", () => {
  it("formats exact integers", () => {
    expect(fmtExact(1234567)).toBe((1234567).toLocaleString());
    expect(fmtExact(null)).toBe("—");
  });
  it("formats percentages to one decimal", () => {
    expect(fmtPct(4.267)).toBe("4.3%");
    expect(fmtPct(NaN)).toBe("—");
  });
  it("formats seconds as m:ss", () => {
    expect(fmtTime(125)).toBe("2:05");
    expect(fmtTime(null)).toBe("—");
  });
});

describe("toNumber", () => {
  it("parses formatted strings", () => {
    expect(toNumber("1,234")).toBe(1234);
    expect(toNumber("12.5%")).toBe(12.5);
    expect(toNumber("▲ 42")).toBe(42);
    expect(toNumber("+7")).toBe(7);
  });
  it("rejects non-numeric input", () => {
    expect(toNumber("—")).toBeNull();
    expect(toNumber("abc")).toBeNull();
    expect(toNumber(null)).toBeNull();
    expect(toNumber(Infinity)).toBeNull();
  });
});

describe("calcAutoDelta", () => {
  it("computes percentage change with direction", () => {
    expect(calcAutoDelta(110, 100)).toEqual({ dir: "up", pct: 10 });
    expect(calcAutoDelta(90, 100)).toEqual({ dir: "down", pct: 10 });
    expect(calcAutoDelta(100, 100)).toEqual({ dir: "flat", pct: 0 });
  });
  it("returns null for invalid input or zero baseline", () => {
    expect(calcAutoDelta(100, 0)).toBeNull();
    expect(calcAutoDelta(null, 100)).toBeNull();
    expect(calcAutoDelta("100", 50)).toBeNull();
  });
});

describe("adSpend", () => {
  it("derives spend from cpc × clicks", () => {
    expect(adSpend({ cpc: 2, clicks: 50 })).toBe(100);
  });
  it("is null unless both cpc and clicks are present", () => {
    expect(adSpend({ cpc: 2 })).toBeNull();
    expect(adSpend({ clicks: 50 })).toBeNull();
    expect(adSpend(null)).toBeNull();
  });
});

describe("sumPaidMediaAds", () => {
  it("blends raw counts and derives every rate from the summed totals", () => {
    const t = sumPaidMediaAds([
      { impressions: 1000, reach: 500, clicks: 20, cpc: 2, engagementRate: 3 },
      { impressions: 3000, reach: 1500, clicks: 30, cpc: 1, engagementRate: 5 },
    ]);
    expect(t.impressions).toBe(4000);
    expect(t.reach).toBe(2000);
    expect(t.clicks).toBe(50);
    expect(t.spend).toBe(70);                 // 20×2 + 30×1
    expect(t.ctr).toBeCloseTo(1.25);          // 50 / 4000
    expect(t.cpc).toBeCloseTo(1.4);           // 70 / 50
    expect(t.cpm).toBeCloseTo(17.5);          // 70 / 4000 × 1000
    expect(t.frequency).toBeCloseTo(2);       // 4000 / 2000
    expect(t.engagementRate).toBeCloseTo(4.5); // impression-weighted: (3×1000 + 5×3000)/4000
  });

  it("leaves a metric null when its inputs are absent", () => {
    const t = sumPaidMediaAds([{ impressions: 1000 }]);
    expect(t.impressions).toBe(1000);
    expect(t.reach).toBeNull();
    expect(t.clicks).toBeNull();
    expect(t.spend).toBeNull();
    expect(t.cpm).toBeNull();
    expect(t.frequency).toBeNull();
  });

  it("reports no conversion metrics — the platforms don't supply them", () => {
    const t = sumPaidMediaAds([{ impressions: 1000, clicks: 20, cpc: 2, conversions: 4 }]);
    expect(t.conversions).toBeUndefined();
    expect(t.conversionRate).toBeUndefined();
    expect(t.cpa).toBeUndefined();
  });
});

describe("parseDelta", () => {
  it("passes through structured deltas", () => {
    expect(parseDelta({ dir: "up", pct: 5 })).toEqual({ dir: "up", pct: 5 });
  });
  it("parses arrow strings", () => {
    expect(parseDelta("▲ 12.5%")).toEqual({ dir: "up", pct: 12.5 });
    expect(parseDelta("▼ 3%")).toEqual({ dir: "down", pct: 3 });
  });
  it("defaults to flat", () => {
    expect(parseDelta(null)).toEqual({ dir: "flat", pct: 0 });
  });
});
