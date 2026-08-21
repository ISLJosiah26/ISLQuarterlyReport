import { useState, useEffect } from "react";
import { supabase } from "../lib/supabase.js";
import { AGENCIES, QUARTERS, resolveQuarter } from "../config.js";
import { calcAutoDelta, sumPaidMediaAds, nfk } from "../utils.js";
import { withRetry, friendlyError, getCached, setCached } from "../lib/fetching.js";
import { AUDIENCE_DIMENSIONS, compareSegments } from "../lib/linkedinDemographics.js";

function getQuarterMeta(suffix) {
  return QUARTERS.find(q => q.suffix === suffix) || QUARTERS[0];
}

function getPrevSuffix(suffix) {
  const idx = QUARTERS.findIndex(q => q.suffix === suffix);
  return idx >= 0 && idx < QUARTERS.length - 1 ? QUARTERS[idx + 1].suffix : null;
}

// Paid media lives under a social_reports row (a report is one row per
// agency+quarter), so the paid page fetches the same parent but selects only
// the campaign/ad branch it needs.
async function fetchPaid(agency, quarter) {
  const q = resolveQuarter(quarter);
  const { data, error } = await supabase
    .from("social_reports")
    .select("id, paid_media_campaigns(*, paid_media_ads(*)), paid_media_demographics(*), paid_media_click_paths(*)")
    .eq("agency", agency)
    .eq("quarter", q.suffix)
    .eq("year", q.year)
    .maybeSingle();
  if (error) throw error;
  return data;
}

// Group demographic rows into per-dimension panels, in the canonical dimension
// order. Segments are ranked here rather than trusted to arrive in order —
// the importer writes the same ranking into sort_order, but breakdowns
// uploaded under an older rule would otherwise keep it forever. sort_order
// only breaks ties, so hand-edited rows still land somewhere stable. Each
// segment carries its CTR and share of the dimension's impressions so the
// report can show both who saw the ads and who responded.
function rollUpAudience(rawRows) {
  const byDimension = new Map();
  for (const r of rawRows || []) {
    if (typeof r.impressions !== "number") continue;
    if (!byDimension.has(r.dimension)) byDimension.set(r.dimension, []);
    byDimension.get(r.dimension).push(r);
  }
  return AUDIENCE_DIMENSIONS
    .filter(d => byDimension.has(d.key))
    .map(d => {
      const rank = compareSegments(d.key);
      const rows = [...byDimension.get(d.key)]
        .sort((a, b) => rank(a, b) || a.sort_order - b.sort_order);
      const total = rows.reduce((a, r) => a + r.impressions, 0);
      const segments = rows.map(r => ({
        name: r.segment,
        impressions: r.impressions,
        clicks: typeof r.clicks === "number" ? r.clicks : null,
        ctr: typeof r.clicks === "number" && r.impressions > 0
          ? (r.clicks / r.impressions) * 100
          : null,
        share: total > 0 ? (r.impressions / total) * 100 : null,
        // The combined tail of a truncated import: counted in `total`, but
        // presented apart from the named segments.
        isOther: !!r.is_other,
      }));
      return { dimension: d.key, label: d.label, layout: d.layout, totalImpressions: total, segments };
    });
}

// A stored journey: the ordered pages one group of sessions visited after
// landing from an ad. Rows arrive in import order (strongest first), which is
// the order the report wants, so sort_order is the only tie-break needed.
// `steps` is jsonb — normally parsed already, but a string is tolerated rather
// than throwing a whole report away over one malformed row.
function rollUpClickPaths(rawRows) {
  return [...(rawRows || [])]
    .sort((a, b) => a.sort_order - b.sort_order)
    .map(r => {
      let steps = r.steps;
      if (typeof steps === "string") {
        try { steps = JSON.parse(steps); } catch { steps = []; }
      }
      return {
        steps: Array.isArray(steps) ? steps.filter(s => typeof s === "string" && s) : [],
        sessions: typeof r.sessions === "number" ? r.sessions : 0,
        conversions: typeof r.conversions === "number" ? r.conversions : null,
        isOther: !!r.is_other,
      };
    })
    .filter(p => p.sessions > 0);
}

// Breakdown rows carry the campaign they describe; the ones imported before
// breakdowns were campaign-scoped (and any genuinely account-level export)
// have no campaign_id and roll up as an account-wide breakdown instead.
// Shared by demographics and click paths, which scope the same way.
function splitByCampaign(rawRows) {
  const byCampaign = new Map();
  const accountWide = [];
  for (const r of rawRows || []) {
    if (!r.campaign_id) { accountWide.push(r); continue; }
    if (!byCampaign.has(r.campaign_id)) byCampaign.set(r.campaign_id, []);
    byCampaign.get(r.campaign_id).push(r);
  }
  return { byCampaign, accountWide };
}

function mapCampaigns(rawCampaigns, demographicsByCampaign = new Map(), clickPathsByCampaign = new Map()) {
  return [...(rawCampaigns || [])]
    .sort((a, b) => a.sort_order - b.sort_order)
    .map(c => {
      const ads = [...(c.paid_media_ads || [])]
        .sort((a, b) => a.sort_order - b.sort_order)
        .map(a => ({
          id: a.id,
          name: a.name,
          impressions: a.impressions,
          reach: a.reach,
          clicks: a.clicks,
          conversions: a.conversions,
          cpc: a.cpc,
          engagementRate: a.engagement_rate,
          status: a.status || "active",
        }));
      return {
        id: c.id,
        name: c.name,
        objective: c.objective || "",
        platform: c.platform || "",
        budget: typeof c.budget === "number" ? c.budget : null,
        startDate: c.start_date || null,
        endDate: c.end_date || null,
        ads,
        totals: sumPaidMediaAds(ads),
        audience: rollUpAudience(demographicsByCampaign.get(c.id)),
        clickPaths: rollUpClickPaths(clickPathsByCampaign.get(c.id)),
      };
    });
}

// Quarter-over-quarter movement for a single campaign, matched to last
// quarter's campaign of the same name. Campaigns are recreated each quarter
// rather than carried forward, so the name is the only stable handle — and a
// renamed or brand-new campaign simply shows no deltas.
function campaignDeltas(campaigns, prevCampaigns) {
  const prevByName = new Map(prevCampaigns.map(c => [nfk(c.name), c.totals]));
  for (const c of campaigns) {
    const prev = prevByName.get(nfk(c.name));
    c.deltas = {};
    if (!prev) continue;
    for (const key of Object.keys(c.totals)) {
      const d = calcAutoDelta(c.totals[key], prev[key]);
      if (d) c.deltas[key] = d;
    }
  }
}

function normalize(report, agency, quarter, prev) {
  const qMeta = getQuarterMeta(quarter);
  const demographics = splitByCampaign(report?.paid_media_demographics);
  const paths = splitByCampaign(report?.paid_media_click_paths);
  const campaigns = mapCampaigns(report?.paid_media_campaigns, demographics.byCampaign, paths.byCampaign);
  const audience = rollUpAudience(demographics.accountWide);
  const clickPaths = rollUpClickPaths(paths.accountWide);
  const totals = sumPaidMediaAds(campaigns.flatMap(c => c.ads));

  campaignDeltas(campaigns, mapCampaigns(prev?.paid_media_campaigns));

  const platforms = [...new Set(campaigns.map(c => c.platform.trim()).filter(Boolean))];

  return {
    meta: {
      quarter:    qMeta.label,
      rangeLabel: qMeta.rangeLabel,
      year:       qMeta.year,
      agencyName: AGENCIES[agency]?.name || "Integrated Staffing",
    },
    campaigns,
    totals,
    platforms,
    audience,
    clickPaths,
    hasData: campaigns.length > 0 || audience.length > 0 || clickPaths.length > 0,
  };
}

export function usePaidReport(agency, quarter, retryKey = 0) {
  const [state, setState] = useState({ data: null, status: "loading", error: null });

  useEffect(() => {
    let cancelled = false;
    const cacheKey = `paid:${agency}:${quarter}`;
    const cached = getCached(cacheKey);

    // Serve the last good copy instantly, revalidate in the background
    setState(cached !== undefined
      ? { data: cached, status: "ready", error: null }
      : { data: null, status: "loading", error: null });

    (async () => {
      try {
        const prevSuffix = getPrevSuffix(quarter);
        const [report, prev] = await Promise.all([
          withRetry(() => fetchPaid(agency, quarter)),
          prevSuffix ? withRetry(() => fetchPaid(agency, prevSuffix)) : Promise.resolve(null),
        ]);
        const data = report ? normalize(report, agency, quarter, prev) : null;
        setCached(cacheKey, data);
        if (!cancelled) setState({ data, status: "ready", error: null });
      } catch (err) {
        // Keep showing stale data on a failed background refresh
        if (!cancelled && cached === undefined) {
          setState({ data: null, status: "error", error: friendlyError(err) });
        }
      }
    })();

    return () => { cancelled = true; };
  }, [agency, quarter, retryKey]);

  return state;
}
