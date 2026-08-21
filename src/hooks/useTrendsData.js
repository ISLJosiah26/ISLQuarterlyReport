import { useState, useEffect } from "react";
import { supabase } from "../lib/supabase.js";
import { TRENDS_QUARTERS, AGENCIES } from "../config.js";
import { METRICS, buildProjectionAudits } from "../lib/projection.js";
import { withRetry, friendlyError } from "../lib/fetching.js";

// Re-export the pure projection math so existing consumers (TrendsPage,
// tests) keep importing from this module. The maths now lives in
// ../lib/projection.js, free of the Supabase client, so it can be
// unit-tested and back-tested in isolation.
export {
  METRICS,
  extractMetric,
  computeAdvancedPace,
  computeSporadicPace,
  computePace,
  getMetricHistory,
  getWeekAgoProjection,
  getProjectionTimeline,
  annotateTimelineSpikes,
  projectionBand,
  detectTrendsAnomalies,
  buildTrendsNarrative,
  clampCalibrationFactor,
  buildProjectionAudit,
  buildProjectionAudits,
  blendCalibrationHistory,
  quarterCompletion,
  quarterComplete,
} from "../lib/projection.js";

// ─── History: Supabase persistence ───────────────────────────────
// Writing snapshots is the capture-projection-snapshots cron job's business
// now, not the browser's. Page-load capture made snapshot density depend on
// who happened to open the Trends tab, which left weekend gaps, a five-day
// hole in early August, and two agencies silently stale for weeks — and every
// projection is only as good as that series is dense.

async function loadSnapshots(agency, quarter) {
  try {
    const { data, error } = await supabase
      .from("projection_snapshots")
      .select("captured_at, vals")
      .eq("agency", agency)
      .eq("quarter", quarter.suffix)
      .eq("year", quarter.year)
      .order("snapshot_date", { ascending: true });
    if (error || !data) return [];
    return data.map(row => ({ t: new Date(row.captured_at).getTime(), vals: row.vals }));
  } catch (_) {
    return [];
  }
}

// Persist this quarter's audit of *last* quarter's projection accuracy, so
// the calibration factor can compound across many quarters instead of being
// re-derived from scratch (and forgotten) on every page load. No-ops until
// the previous quarter is complete (buildProjectionAudits returns {} before
// then) and is a plain upsert otherwise, so re-running it on every refresh
// is harmless.
async function storeAudits(agency, qdata, snapsByQuarter) {
  const audits = buildProjectionAudits(qdata, snapsByQuarter);
  const previousQuarter = TRENDS_QUARTERS[1];
  const rows = Object.entries(audits)
    .filter(([, audit]) => audit)
    .map(([metricId, audit]) => ({
      agency,
      quarter: previousQuarter.suffix,
      year: previousQuarter.year,
      metric_id: metricId,
      actual: audit.actual,
      avg_projected: audit.avgProjected,
      percent_error: audit.percentError,
      accuracy_ratio: audit.accuracyRatio,
      calibration_confidence: audit.calibrationConfidence,
      calibration_factor: audit.calibrationFactor,
      band_covered: audit.bandCovered,
      band_rel_half: audit.bandRelHalf,
      sample_count: audit.sampleCount,
      first_day: audit.firstDay,
      last_day: audit.lastDay,
      computed_at: new Date().toISOString(),
    }));
  if (!rows.length) return;
  try {
    await supabase.from("projection_audits").upsert(rows, { onConflict: "agency,quarter,year,metric_id" });
  } catch (_) {}
}

// Fire-and-forget audit persistence for every agency, not just the one being
// viewed: the Trends page is the only place this runs, so an agency nobody
// opens would otherwise never accrue audit history. Unlike the snapshot
// capture this stays on the client, because the audit is stage-matched — it
// recalibrates against how the model behaved at the point in the quarter you
// are reading it at, so recomputing on load is the point, not a side effect.
async function auditAllAgencies() {
  await Promise.all(
    Object.keys(AGENCIES).map(async (a) => {
      const qdata = await Promise.all(TRENDS_QUARTERS.map(q => fetchQuarter(a, q)));
      const snaps = await loadSnapshots(a, TRENDS_QUARTERS[1]);
      await storeAudits(a, qdata, { [TRENDS_QUARTERS[1].suffix]: snaps });
    })
  );
}

// Last N persisted audits for one agency/metric, most-recent-first, for
// blendCalibrationHistory to weight by recency.
async function loadCalibrationHistory(agency, metricId, limit = 4) {
  try {
    const { data, error } = await supabase
      .from("projection_audits")
      .select("calibration_factor, calibration_confidence, percent_error, band_covered, band_rel_half, computed_at")
      .eq("agency", agency)
      .eq("metric_id", metricId)
      .order("computed_at", { ascending: false })
      .limit(limit);
    if (error || !data) return [];
    return data;
  } catch (_) {
    return [];
  }
}

// Top post and platform leader/laggard for the viewed agency's current
// quarter, to auto-surface "what's driving this" without anyone having to
// curate it. Scoped to the single viewed agency (unlike auditAllAgencies
// above) since this only feeds a display widget, not an accumulating history.
async function fetchDrivers(agency, quarter) {
  try {
    const { data, error } = await supabase
      .from("social_reports")
      .select("social_posts(post_name, post_date, platforms, impressions, engagements, url), social_platforms(name, engagement_rate)")
      .eq("agency", agency)
      .eq("quarter", quarter.suffix)
      .eq("year", quarter.year)
      .maybeSingle();
    if (error || !data) return { topPost: null, platformLeader: null, platformLaggard: null, posts: [] };

    const posts = (data.social_posts || []).filter(p => Number.isFinite(p.impressions));
    const topPost = posts.length
      ? posts.reduce((best, p) => p.impressions > best.impressions ? p : best)
      : null;

    const platforms = (data.social_platforms || []).filter(p => Number.isFinite(p.engagement_rate));
    const platformLeader = platforms.length
      ? platforms.reduce((best, p) => p.engagement_rate > best.engagement_rate ? p : best)
      : null;
    const platformLaggard = platforms.length > 1
      ? platforms.reduce((worst, p) => p.engagement_rate < worst.engagement_rate ? p : worst)
      : null;

    // Full post list (with dates) so the trajectory chart can tie a projection
    // spike to whatever post landed as the metric accelerated.
    return { topPost, platformLeader, platformLaggard, posts };
  } catch (_) {
    return { topPost: null, platformLeader: null, platformLaggard: null, posts: [] };
  }
}

// Per-platform standings for the viewed agency, current quarter vs previous,
// so the breakdown can show where each platform is and which way it's moving.
// This is a quarter-over-quarter read, not a daily-paced projection — there
// are no per-platform daily snapshots to project from, only one row per
// quarter — so the UI frames it as standings, not a forecast.
function relDelta(cur, prev) {
  return Number.isFinite(cur) && Number.isFinite(prev) && prev > 0 ? (cur - prev) / prev * 100 : null;
}
async function fetchPlatformBreakdown(agency, current, prev) {
  try {
    // (quarter, year) pairs, so a suffix that repeats across years cannot
    // pull the wrong row in.
    const { data, error } = await supabase
      .from("social_reports")
      .select("quarter, year, social_platforms(name, sort_order, followers, engagement_rate, page_reach, page_clicks)")
      .eq("agency", agency)
      .or(`and(quarter.eq.${current.suffix},year.eq.${current.year}),and(quarter.eq.${prev.suffix},year.eq.${prev.year})`);
    if (error || !data) return [];
    const key = (q) => `${q.suffix}-${q.year}`;
    const byQuarter = {};
    for (const r of data) byQuarter[`${r.quarter}-${r.year}`] = r.social_platforms || [];
    const cur = byQuarter[key(current)] || [];
    const prevByName = {};
    for (const p of (byQuarter[key(prev)] || [])) prevByName[(p.name || "").toLowerCase()] = p;

    return [...cur]
      .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
      .map(p => {
        const pp = prevByName[(p.name || "").toLowerCase()];
        return {
          name: p.name,
          followers: p.followers,
          engagementRate: p.engagement_rate,
          pageReach: p.page_reach,
          pageClicks: p.page_clicks,
          followersDelta: relDelta(p.followers, pp?.followers),
          engagementDelta: relDelta(p.engagement_rate, pp?.engagement_rate),
        };
      });
  } catch (_) {
    return [];
  }
}

// ─── Hook ─────────────────────────────────────────────────────────
async function fetchQuarter(agency, quarter) {
  try {
    const { data, error } = await withRetry(() => supabase
      .from("social_reports")
      .select("social_kpis(*)")
      .eq("agency", agency)
      .eq("quarter", quarter.suffix)
      .eq("year", quarter.year)
      .maybeSingle());
    if (error) throw error;
    if (!data) return null;
    const k = data.social_kpis?.[0] || {};
    return {
      overall: {
        posts:       k.posts,
        impressions: k.impressions,
        shares:      k.shares,
        reactions:   k.reactions,
        followers:   k.followers,
        linkclicks:  k.link_clicks,
        comments:    k.comments,
      },
    };
  } catch (_) {
    return null;
  }
}

export function useTrendsData(agency) {
  const [state, setState] = useState({ qdata: null, snapsByQuarter: {}, calibrationHistory: {}, drivers: null, platforms: [], status: "loading", error: null });

  useEffect(() => {
    let cancelled = false;

    const run = async () => {
      try {
        const [qdata, drivers, platforms, ...rest] = await Promise.all([
          Promise.all(TRENDS_QUARTERS.map(q => fetchQuarter(agency, q))),
          fetchDrivers(agency, TRENDS_QUARTERS[2]),
          fetchPlatformBreakdown(agency, TRENDS_QUARTERS[2], TRENDS_QUARTERS[1]),
          ...TRENDS_QUARTERS.map(q => loadSnapshots(agency, q)),
          ...METRICS.map(m => loadCalibrationHistory(agency, m.id)),
        ]);
        const snapsArrays = rest.slice(0, TRENDS_QUARTERS.length);
        const historyArrays = rest.slice(TRENDS_QUARTERS.length);

        if (!cancelled) {
          const snapsByQuarter = Object.fromEntries(
            TRENDS_QUARTERS.map((q, i) => [q.suffix, snapsArrays[i]])
          );
          const calibrationHistory = Object.fromEntries(
            METRICS.map((m, i) => [m.id, historyArrays[i]])
          );
          // Fire-and-forget: persist an audit of last quarter's projection
          // accuracy for every agency, not just the one being viewed, so each
          // one accrues history regardless of whose Trends tab gets opened.
          // (Snapshot capture is the cron job's job now, not this page's.)
          auditAllAgencies();
          setState({ qdata, snapsByQuarter, calibrationHistory, drivers, platforms, status: "ready", error: null });
        }
      } catch (err) {
        if (!cancelled) {
          setState(s => s.status === "loading"
            ? { qdata: null, snapsByQuarter: {}, calibrationHistory: {}, drivers: null, platforms: [], status: "error", error: friendlyError(err) }
            : s);
        }
      }
    };

    setState({ qdata: null, snapsByQuarter: {}, calibrationHistory: {}, drivers: null, platforms: [], status: "loading", error: null });
    run();
    // Refresh every 5 minutes, but only while the tab is visible
    const id = setInterval(() => { if (!document.hidden) run(); }, 300_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [agency]);

  return state;
}
