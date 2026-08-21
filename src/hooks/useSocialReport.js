import { useState, useEffect } from "react";
import { supabase } from "../lib/supabase.js";
import { AGENCIES, QUARTERS, resolveQuarter } from "../config.js";
import { calcAutoDelta, FLAT } from "../utils.js";
import { withRetry, friendlyError, getCached, setCached } from "../lib/fetching.js";

function getQuarterMeta(suffix) {
  return QUARTERS.find(q => q.suffix === suffix) || QUARTERS[0];
}

function getPrevSuffix(suffix) {
  const idx = QUARTERS.findIndex(q => q.suffix === suffix);
  return idx >= 0 && idx < QUARTERS.length - 1 ? QUARTERS[idx + 1].suffix : null;
}

async function fetchReport(agency, quarter) {
  const q = resolveQuarter(quarter);
  const { data, error } = await supabase
    .from("social_reports")
    .select(`
      id, editors_note,
      social_kpis(*),
      social_platforms(*),
      social_top_posts(*),
      social_posts(*),
      social_insights(*)
    `)
    .eq("agency", agency)
    .eq("quarter", q.suffix)
    .eq("year", q.year)
    .maybeSingle();
  if (error) throw error;
  return data;
}

function normalize(report, agency, quarter, prev) {
  if (!report) return null;

  const qMeta   = getQuarterMeta(quarter);
  const kpis    = report.social_kpis?.[0]    || {};
  const prevKpi = prev?.social_kpis?.[0]     || null;

  const overall = {
    posts:             kpis.posts,
    impressions:       kpis.impressions,
    shares:            kpis.shares,
    reactions:         kpis.reactions,
    followers:         kpis.followers,
    linkclicks:        kpis.link_clicks,
    comments:          kpis.comments,
    avgengagementrate: kpis.avg_engagement_rate,
  };

  const deltas = {};
  if (prevKpi) {
    const prevOverall = {
      posts:             prevKpi.posts,
      impressions:       prevKpi.impressions,
      shares:            prevKpi.shares,
      reactions:         prevKpi.reactions,
      followers:         prevKpi.followers,
      linkclicks:        prevKpi.link_clicks,
      comments:          prevKpi.comments,
      avgengagementrate: prevKpi.avg_engagement_rate,
    };
    for (const key of Object.keys(overall)) {
      const d = calcAutoDelta(overall[key], prevOverall[key]);
      if (d) deltas[key] = d;
    }
  }

  const prevPlatformMap = {};
  for (const p of (prev?.social_platforms || [])) {
    prevPlatformMap[p.name.toLowerCase()] = p;
  }

  const platforms = [...(report.social_platforms || [])]
    .sort((a, b) => a.sort_order - b.sort_order)
    .map(p => {
      const pp = prevPlatformMap[p.name.toLowerCase()];
      return {
        key:                 p.name.toLowerCase(),
        name:                p.name,
        followers:           p.followers,
        followersDelta:      calcAutoDelta(p.followers,       pp?.followers)       || FLAT,
        engagementRate:      p.engagement_rate,
        engagementRateDelta: calcAutoDelta(p.engagement_rate, pp?.engagement_rate) || FLAT,
        pageReach:           p.page_reach,
        pageReachDelta:      calcAutoDelta(p.page_reach,      pp?.page_reach)      || FLAT,
        pageClicks:          p.page_clicks,
        pageClicksDelta:     calcAutoDelta(p.page_clicks,     pp?.page_clicks)     || FLAT,
        note:                p.note || "",
      };
    });

  const topPostsByPlatform = { linkedin: [], facebook: [], instagram: [] };
  for (const p of (report.social_top_posts || [])) {
    topPostsByPlatform[p.platform]?.push({
      title: p.title, impressions: p.impressions, likes: p.likes, shares: p.shares,
    });
  }

  const ins = report.social_insights?.[0] || {};
  const notes = {
    working:    ins.working      ? [ins.working]      : [],
    notWorking: ins.not_working  ? [ins.not_working]  : [],
    actions:    ins.actions      ? [ins.actions]      : [],
    next:       ins.next_quarter ? [ins.next_quarter] : [],
  };

  const allPosts = (report.social_posts || []).map(p => ({
    "Post Name":  p.post_name,
    Date:         p.post_date,
    Platforms:    p.platforms,
    Impressions:  p.impressions,
    Engagements:  p.engagements,
    URL:          p.url,
    Notes:        p.notes,
  }));

  return {
    meta: {
      quarter:    qMeta.label,
      rangeLabel: qMeta.rangeLabel,
      year:       qMeta.year,
      agencyName: AGENCIES[agency]?.name || "Integrated Staffing",
    },
    editorsNote: report.editors_note || "",
    overall,
    deltas,
    platforms,
    topPostsByPlatform,
    notes,
    allPosts,
    weekly: Array.from({ length: 13 }, (_, i) => ({ wk: i + 1, imp: 0, leads: 0, spend: 0 })),
  };
}

export function useSocialReport(agency, quarter, retryKey = 0) {
  const [state, setState] = useState({ data: null, status: "loading", error: null });

  useEffect(() => {
    let cancelled = false;
    const cacheKey = `social:${agency}:${quarter}`;
    const cached = getCached(cacheKey);

    // Serve the last good copy instantly, revalidate in the background
    setState(cached !== undefined
      ? { data: cached, status: "ready", error: null }
      : { data: null, status: "loading", error: null });

    (async () => {
      try {
        const prevSuffix = getPrevSuffix(quarter);
        const [report, prev] = await Promise.all([
          withRetry(() => fetchReport(agency, quarter)),
          prevSuffix ? withRetry(() => fetchReport(agency, prevSuffix)) : Promise.resolve(null),
        ]);
        const data = normalize(report, agency, quarter, prev);
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
