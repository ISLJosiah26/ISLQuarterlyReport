import { useState, useEffect } from "react";
import { supabase } from "../lib/supabase.js";
import { QUARTERS } from "../config.js";

function mapKpis(row) {
  if (!row) return null;
  return {
    posts:             row.posts,
    impressions:       row.impressions,
    shares:            row.shares,
    reactions:         row.reactions,
    followers:         row.followers,
    linkclicks:        row.link_clicks,
    comments:          row.comments,
    avgengagementrate: row.avg_engagement_rate,
  };
}

export function useSocialKpiHistory(agency) {
  const [history, setHistory] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { data, error } = await supabase
          .from("social_reports")
          .select("quarter, year, social_kpis(*)")
          .eq("agency", agency)
          .or(QUARTERS.map(q => `and(quarter.eq.${q.suffix},year.eq.${q.year})`).join(","));
        if (error) throw error;
        if (!cancelled) {
          const byQuarter = {};
          (data || []).forEach(r => {
            byQuarter[`${r.quarter}-${r.year}`] = mapKpis(r.social_kpis?.[0] || null);
          });
          // Oldest-first for the chart (QUARTERS is most-recent-first)
          const result = [...QUARTERS].reverse().map(q => ({
            suffix: q.suffix,
            label: q.label,
            rangeLabel: q.rangeLabel,
            kpis: byQuarter[`${q.suffix}-${q.year}`] || null,
          }));
          setHistory(result);
        }
      } catch {
        if (!cancelled) setHistory([]);
      }
    })();
    return () => { cancelled = true; };
  }, [agency]);

  return history;
}
