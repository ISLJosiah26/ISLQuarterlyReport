import React, { useState, useEffect } from "react";
import { supabase } from "../../lib/supabase.js";
import { QUARTERS, resolveQuarter } from "../../config.js";
import { WeekCalendar } from "./WeekCalendar.jsx";
import { useWebReport } from "../../hooks/useWebReport.js";
import { buildPlanSuggestion, buildWeekPlan, buildCadence } from "../../lib/planEngine.js";
import {
  buildPlatformFocusSignal,
  buildJobAdSignal,
  buildWebFunnelSignal,
} from "../../lib/planSignals.js";

// The quarter right after the selected one just started — its post log is
// thin or empty until weeks in. Pull in the prior quarter's posts too so
// there's always enough sample size to find a pattern, not just whatever's
// been logged so far this quarter.
function previousQuarter(quarter) {
  const idx = QUARTERS.findIndex(q => q.suffix === quarter);
  return idx === -1 ? null : QUARTERS[idx + 1] || null;
}

function pct(rate) {
  return Number.isFinite(rate) ? `${(rate * 100).toFixed(1)}%` : "—";
}

// Paid media, as fetched raw alongside social_posts/social_platforms in this
// tab's own query, into the shape planSignals.buildJobAdSignal expects (a
// list of campaign-like objects with a camelCase `ads` array) — the same
// normalization useSocialReport.js's mapPaidMedia does for the Social report.
function normalizePaidMediaForSignal(campaigns) {
  return [{
    ads: (campaigns || []).flatMap(c => (c.paid_media_ads || []).map(a => ({
      impressions: a.impressions, clicks: a.clicks, cpc: a.cpc, engagementRate: a.engagement_rate,
    }))),
  }];
}

// ─── Week guidance ──────────────────────────────────────────────────
// The full intelligence still drives the per-day picks inside the calendar
// below — this is just a one-glance summary above it. Deliberately at most
// two short lines: a "get something out" nudge when posting has gone quiet,
// and the single best-performing content type so the manager knows what the
// calendar is leaning on. No confidence badges, cross-page sentences, or
// per-type staleness spam — anything not worth a line renders nothing.
function WeekGuidance({ plan, cadence }) {
  const goneDark = cadence.status === "ready" && cadence.goneDark;
  const bestType = plan.status === "ready" ? plan.bestType : null;
  if (!goneDark && !bestType) return null;

  return (
    <div className="admin-plan-signals">
      {goneDark && (
        <div className="admin-plan-signal is-down">
          ⚠ No post in {cadence.daysSinceLast} day{cadence.daysSinceLast === 1 ? "" : "s"} — time to get something out.
        </div>
      )}
      {bestType && (
        <div className="admin-plan-signal">
          <strong>{bestType.label}</strong> is your strongest content type this quarter
          ({pct(bestType.avgEngagementRate)} avg. engagement) — the calendar leans on it below.
        </div>
      )}
    </div>
  );
}

// ─── Tab ────────────────────────────────────────────────────────────
export function PlanTab({ agency, quarter }) {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [currentPosts, setCurrentPosts] = useState([]);
  const [prevPosts, setPrevPosts] = useState([]);
  const [currentPlatforms, setCurrentPlatforms] = useState([]);
  const [prevPlatforms, setPrevPlatforms] = useState([]);
  const [currentPaidMedia, setCurrentPaidMedia] = useState([]);
  const [plannedItems, setPlannedItems] = useState([]);

  const prevQ = previousQuarter(quarter);
  const { data: webData, prevData: prevWebData } = useWebReport(agency, quarter);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError("");
    (async () => {
      try {
        // (quarter, year) pairs — a bare suffix repeats every fiscal year.
        const wanted = prevQ ? [resolveQuarter(quarter), prevQ] : [resolveQuarter(quarter)];
        const [reportsRes, plannedRes] = await Promise.all([
          supabase
            .from("social_reports")
            .select("quarter, year, social_posts(*), social_platforms(*), paid_media_campaigns(*, paid_media_ads(*))")
            .eq("agency", agency)
            .or(wanted.map(q => `and(quarter.eq.${q.suffix},year.eq.${q.year})`).join(",")),
          supabase
            .from("plan_items")
            .select("content_type, planned_date, idea, status")
            .eq("agency", agency)
            .eq("quarter", quarter)
            .eq("status", "planned"),
        ]);
        if (reportsRes.error) throw reportsRes.error;
        if (!cancelled) {
          const byQuarter = {};
          for (const r of reportsRes.data || []) byQuarter[`${r.quarter}-${r.year}`] = r;
          const curQ = resolveQuarter(quarter);
          const cur = byQuarter[`${curQ.suffix}-${curQ.year}`] || {};
          const prev = prevQ ? byQuarter[`${prevQ.suffix}-${prevQ.year}`] || {} : {};
          setCurrentPosts(cur.social_posts || []);
          setPrevPosts(prev.social_posts || []);
          setCurrentPlatforms(cur.social_platforms || []);
          setPrevPlatforms(prev.social_platforms || []);
          setCurrentPaidMedia(cur.paid_media_campaigns || []);
          // The planner and cross-page signals are best-effort, secondary
          // signals — don't fail the whole tab if either can't be read.
          setPlannedItems(plannedRes.error ? [] : plannedRes.data || []);
        }
      } catch {
        if (!cancelled) setLoadError("Failed to load the post log for this quarter. Please refresh and try again.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [agency, quarter, prevQ]);

  if (loading)   return <div className="admin-form-status">Analyzing the post log…</div>;
  if (loadError) return <div className="admin-form-status admin-form-status--error">{loadError}</div>;

  const posts = [...currentPosts, ...prevPosts];
  const plan = buildPlanSuggestion(posts);
  const periodLabel = prevQ ? `this quarter and last quarter (${prevQ.label})` : "this quarter";
  const isEmpty = plan.status === "empty";
  const qMeta = QUARTERS.find(q => q.suffix === quarter);

  // Cross-page signals still bias the per-day picks in buildWeekPlan — the
  // intelligence is unchanged, only its on-screen narration was removed.
  const platformFocus = buildPlatformFocusSignal(currentPlatforms, prevPlatforms);
  const jobAdSignal = buildJobAdSignal(posts, normalizePaidMediaForSignal(currentPaidMedia));
  const webFunnel = buildWebFunnelSignal(webData, prevWebData);

  // Suggestions are only ever meaningful when there's a real pattern to
  // suggest from — an empty post log still gets a fully functional calendar
  // for capturing and scheduling ideas, just without a fabricated pick.
  const week = isEmpty ? [] : buildWeekPlan(posts, { plannedItems, platformFocus, jobAdSignal, webFunnel });
  const cadence = buildCadence(currentPosts, { quarterStart: qMeta?.start, quarterEnd: qMeta?.end });

  return (
    <div className="admin-form-section">
      {!isEmpty && <WeekGuidance plan={plan} cadence={cadence} />}

      <WeekCalendar
        agency={agency}
        quarter={quarter}
        posts={currentPosts}
        week={week}
        quarterStart={qMeta?.start}
        quarterEnd={qMeta?.end}
      />

      {isEmpty && (
        <div className="admin-plan-empty">
          No dated, logged posts with impressions yet across {periodLabel}, so there's no posting pattern to
          suggest from. Add rows in the Social → All Posts tab (or import a CSV) to unlock posting suggestions —
          the planner below still works for capturing and scheduling ideas.
        </div>
      )}
    </div>
  );
}
