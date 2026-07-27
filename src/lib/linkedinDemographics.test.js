import { describe, it, expect } from "vitest";
import { parseLinkedInDemographics, MAX_SEGMENTS } from "./linkedinDemographics.js";

describe("parseLinkedInDemographics", () => {
  it("parses a job function export with a metadata preamble and Total row", () => {
    const csv = [
      '"Report: Demographics Report"',
      '"Date Range: Apr 1, 2026 - Jun 30, 2026"',
      "",
      '"Job Function","Impressions","Clicks","Click Through Rate","Average CPM"',
      '"Human Resources","12,480","214","1.71%","$8.12"',
      '"Operations","8,902","96","1.08%","$7.44"',
      '"Total","21,382","310","1.45%","$7.84"',
    ].join("\n");
    expect(parseLinkedInDemographics(csv)).toEqual({
      dimension: "job_function",
      truncated: 0,
      rows: [
        { segment: "Human Resources", impressions: 12480, clicks: 214, isOther: false },
        { segment: "Operations", impressions: 8902, clicks: 96, isOther: false },
      ],
    });
  });

  it("keeps commas inside quoted segment names (locations)", () => {
    const csv =
      'Location,Impressions,Clicks\n' +
      '"Halifax, Nova Scotia Area","5,200",44\n' +
      '"Moncton, New Brunswick Area",1200,9';
    const out = parseLinkedInDemographics(csv);
    expect(out.dimension).toBe("location");
    expect(out.rows[0]).toEqual({ segment: "Halifax, Nova Scotia Area", impressions: 5200, clicks: 44, isOther: false });
  });

  it("detects company size before generic company", () => {
    const csv = "Company Size,Impressions,Clicks\n51-200 employees,900,12";
    expect(parseLinkedInDemographics(csv).dimension).toBe("company_size");
  });

  it("does not read Click Through Rate as the clicks column", () => {
    const csv =
      'Job Seniority,Impressions,Click Through Rate\n' +
      'Senior,"3,000",0.95%';
    expect(parseLinkedInDemographics(csv)).toEqual({
      dimension: "seniority",
      truncated: 0,
      rows: [{ segment: "Senior", impressions: 3000, clicks: null, isOther: false }],
    });
  });

  it("skips rows without a numeric impressions value", () => {
    const csv = "Industry,Impressions,Clicks\nConstruction,-,3\nStaffing,400,7";
    expect(parseLinkedInDemographics(csv).rows).toEqual([
      { segment: "Staffing", impressions: 400, clicks: 7, isOther: false },
    ]);
  });

  it("sorts segments by impressions, strongest first", () => {
    const csv = "Industry,Impressions,Clicks\nSmall,10,1\nBig,900,4\nMid,120,2";
    expect(parseLinkedInDemographics(csv).rows.map(r => r.segment))
      .toEqual(["Big", "Mid", "Small"]);
  });

  // ── Page analytics "Companies" export ──
  const COMPANIES_HEADER =
    "Company name,Company page URL,Engagement level,Organic impressions," +
    "Organic engagements,Paid impressions,Paid clicks,Paid engagements";

  it("reads the paid columns of a Companies export, not the organic ones", () => {
    const csv = [
      "﻿" + COMPANIES_HEADER,
      '"Canada Post",https://www.linkedin.com/company/canadapost,Very High,"1,900",120,437,3,3',
      '"Oulton College",https://www.linkedin.com/company/oulton,High,12,4,260,,',
    ].join("\n");
    expect(parseLinkedInDemographics(csv)).toEqual({
      dimension: "company",
      truncated: 0,
      rows: [
        { segment: "Canada Post", impressions: 437, clicks: 3, isOther: false },
        { segment: "Oulton College", impressions: 260, clicks: null, isOther: false },
      ],
    });
  });

  it("drops companies the ads never reached", () => {
    const csv = [
      COMPANIES_HEADER,
      '"Reached",https://x,High,8,8,14,1,1',
      '"Organic only",https://y,High,33,35,,,',
      '"Zero paid",https://z,High,4,4,0,0,0',
    ].join("\n");
    expect(parseLinkedInDemographics(csv).rows).toEqual([
      { segment: "Reached", impressions: 14, clicks: 1, isOther: false },
    ]);
  });

  it("caps the long tail, folding the remainder into one combined row", () => {
    const rows = Array.from({ length: MAX_SEGMENTS + 25 }, (_, i) => `Company ${i},${1000 - i},1`);
    const out = parseLinkedInDemographics(["Company name,Paid impressions,Paid clicks", ...rows].join("\n"));
    expect(out.truncated).toBe(25);
    expect(out.rows).toHaveLength(MAX_SEGMENTS + 1);
    expect(out.rows[0].segment).toBe("Company 0");

    // The tail is summed rather than dropped, so shares still divide by the
    // real total.
    const other = out.rows[out.rows.length - 1];
    expect(other.segment).toBe("Other (25 more)");
    expect(other.isOther).toBe(true);
    expect(other.clicks).toBe(25);
    const all = out.rows.reduce((a, r) => a + r.impressions, 0);
    const expected = Array.from({ length: MAX_SEGMENTS + 25 }, (_, i) => 1000 - i).reduce((a, b) => a + b, 0);
    expect(all).toBe(expected);
  });

  it("returns null for a file with no demographics header", () => {
    expect(parseLinkedInDemographics("Date,Spend\n2026-04-01,120")).toBeNull();
    expect(parseLinkedInDemographics("")).toBeNull();
  });

  it("returns null for an export with only organic metrics", () => {
    const csv = "Company name,Organic impressions,Organic engagements\nAcme,40,4";
    expect(parseLinkedInDemographics(csv)).toBeNull();
  });
});
