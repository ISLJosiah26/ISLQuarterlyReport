/**
 * One-time migration: Google Sheets (via GAS) → Supabase
 *
 * Run from your local machine (Node 18+):
 *   node migrate-from-sheets.js
 *
 * It will report what it finds and inserts, skipping quarters with no data.
 */

import { createClient } from "@supabase/supabase-js";

// ─── Config ──────────────────────────────────────────────────────────
const SUPABASE_URL = "https://tmqotmpacguusianlpcg.supabase.co";

// Use your SERVICE ROLE key here (not the anon/publishable key) so RLS
// doesn't block the inserts. Find it in Supabase dashboard →
// Project Settings → API → service_role key.
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || "PASTE_SERVICE_ROLE_KEY_HERE";

const SOCIAL_ENDPOINT = "https://script.google.com/macros/s/AKfycbwB-RGI1lVHrUE03PkkSEYbLuiTLxE4phMBBOm81diNJtSPyUWGoB_bOlkgFIoVF4yzLQ/exec";
const WEB_ENDPOINT    = "https://script.google.com/macros/s/AKfycbwWpZWB_eP48AX_B4TkGgKjEJPGoB7y9ynpv74SWA3MiEtV-Kmd-0eV-ecfTIysbWY3CQ/exec";

const AGENCIES = { isl: "isl", as: "as", ads: "ads" };
const QUARTERS = ["q1", "q2", "q3", "q4"];

// social_reports is keyed (agency, quarter, year). This script imports the
// one fiscal year that lived in the Sheets export — Sep 2025 through Aug 2026
// — so the year label is fixed per quarter rather than derived: the fiscal
// year opens with q1 in Sep-Nov 2025 and the rest close in 2026. Re-pointing
// this at a later export means updating this map.
const QUARTER_YEARS = { q1: "2025", q2: "2026", q3: "2026", q4: "2026" };

// ─── Helpers ─────────────────────────────────────────────────────────
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

async function fetchJson(url) {
  const res = await fetch(url, { headers: { "Cache-Control": "no-store" } });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.json();
}

function num(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/[,%]/g, "").trim());
  return isFinite(n) ? n : null;
}

function _parseDelta(d) {
  if (!d || typeof d !== "string") return null;
  const dir = /[▲↑]|up/i.test(d) ? "up" : /[▼↓]|down/i.test(d) ? "down" : "flat";
  const m = d.match(/[\d.]+/);
  return { dir, pct: m ? parseFloat(m[0]) : 0 };
}

// ─── Social migration ─────────────────────────────────────────────────
async function migrateSocial(agency, quarter) {
  const reportKey = agency + quarter;
  let raw;
  try {
    raw = await fetchJson(`${SOCIAL_ENDPOINT}?report=${reportKey}&t=${Date.now()}`);
  } catch (e) {
    console.log(`  ${reportKey}: fetch failed — ${e.message}`);
    return;
  }
  if (raw?.error || (!raw?.overall && !raw?.quarterTotals && !raw?.platforms && !raw?.platformBreakdown)) {
    console.log(`  ${reportKey}: no data`);
    return;
  }
  console.log(`  ${reportKey}: found data, migrating…`);

  // Normalise overall KPIs (handles both pre-normalised and raw GAS shapes)
  let overall = {}, allPosts = Array.isArray(raw.allPosts) ? raw.allPosts : [];
  const keyMap = { posts:"posts", impressions:"impressions", shares:"shares",
    reactions:"reactions", followers:"followers", linkClicks:"linkclicks",
    comments:"comments", avgEngagementRate:"avgengagementrate" };

  if (raw.overall) {
    // Pre-normalised
    overall = raw.overall;
  } else if (raw.quarterTotals) {
    raw.quarterTotals.forEach(row => {
      const k = keyMap[row.field] || row.field?.toLowerCase();
      if (k) overall[k] = row.value;
    });
  }

  // Platforms
  let platforms = [];
  const src = raw.platforms || raw.platformBreakdown || [];
  platforms = src.map((p, i) => ({
    sort_order: i,
    name: p.name || p.Platform,
    followers: num(p.followers ?? p.Followers),
    engagement_rate: num(p.engagementRate ?? p["Engagement Rate"]),
    page_reach: num(p.pageReach ?? p.Reach),
    page_clicks: num(p.pageClicks ?? p.Clicks),
    note: p.note || "",
  }));

  // Top posts
  let topPosts = [];
  if (raw.topPostsByPlatform) {
    Object.entries(raw.topPostsByPlatform).forEach(([platform, posts]) => {
      (posts || []).forEach(p => topPosts.push({ platform, title: p.title, impressions: num(p.impressions) ?? 0, likes: num(p.likes) ?? 0, shares: num(p.shares) ?? 0 }));
    });
  } else if (raw.topPosts) {
    raw.topPosts.forEach(p => {
      const platform = (p.Platform || "").toLowerCase();
      if (["linkedin","facebook","instagram"].includes(platform) && p.Title) {
        topPosts.push({ platform, title: p.Title, impressions: num(p.Impressions) ?? 0, likes: num(p.Likes) ?? 0, shares: num(p.Shares) ?? 0 });
      }
    });
  }

  // All posts
  const posts = allPosts.map(p => ({
    post_name:   p["Post Name"] || p.post_name || null,
    post_date:   p.Date || p.post_date || null,
    platforms:   p.Platforms || p.platforms || null,
    impressions: num(p.Impressions ?? p.impressions) ?? 0,
    engagements: num(p.Engagements ?? p.engagements) ?? 0,
    url:         p.URL || p.url || null,
    notes:       p.Notes || p.notes || null,
  })).filter(p => p.post_name);

  // Insights — raw GAS returns an array [{Section, Text}]; pre-normalised shape
  // returns a {working, notWorking, actions, next} object or raw.notes arrays.
  const insMap = {};
  if (Array.isArray(raw.insights)) {
    raw.insights.forEach(i => {
      const k = String(i.Section || i.section || "").trim().toLowerCase()
        .replace(/[^a-z]/g, "");
      if (k) insMap[k] = String(i.Text || i.text || "");
    });
  } else if (raw.insights && typeof raw.insights === "object") {
    Object.assign(insMap, raw.insights);
  }
  const n = raw.notes || {};
  const working    = insMap.working     || insMap.whatsworking    || (n.working    || []).join("\n\n") || "";
  const notWorking = insMap.notworking  || insMap.whatsnotworking || (n.notWorking || []).join("\n\n") || "";
  const actions    = insMap.actions     || (n.actions    || []).join("\n\n") || "";
  const next       = insMap.next        || insMap.nextquarter     || (n.next       || []).join("\n\n") || "";

  const editorsNote = typeof raw.editorsNote === "string" ? raw.editorsNote
    : typeof raw.summary?.bullet === "string" ? raw.summary.bullet : "";

  // ── Insert into Supabase ──
  const { data: rep, error: e1 } = await supabase
    .from("social_reports")
    .upsert(
      { agency, quarter, year: QUARTER_YEARS[quarter], editors_note: editorsNote },
      { onConflict: "agency,quarter,year" },
    )
    .select("id").single();
  if (e1) { console.error(`    report upsert failed:`, e1.message); return; }
  const rid = rep.id;

  await supabase.from("social_kpis").delete().eq("report_id", rid);
  await supabase.from("social_kpis").insert({
    report_id: rid,
    posts:               num(overall.posts),
    impressions:         num(overall.impressions),
    shares:              num(overall.shares),
    reactions:           num(overall.reactions),
    followers:           num(overall.followers),
    link_clicks:         num(overall.linkclicks ?? overall.linkClicks),
    comments:            num(overall.comments),
    avg_engagement_rate: num(overall.avgengagementrate ?? overall.avgEngagementRate),
  });

  if (platforms.length) {
    await supabase.from("social_platforms").delete().eq("report_id", rid);
    await supabase.from("social_platforms").insert(platforms.map(p => ({ report_id: rid, ...p })));
  }

  if (topPosts.length) {
    await supabase.from("social_top_posts").delete().eq("report_id", rid);
    await supabase.from("social_top_posts").insert(topPosts.map(p => ({ report_id: rid, ...p })));
  }

  if (posts.length) {
    await supabase.from("social_posts").delete().eq("report_id", rid);
    await supabase.from("social_posts").insert(posts.map(p => ({ report_id: rid, ...p })));
  }

  await supabase.from("social_insights").delete().eq("report_id", rid);
  await supabase.from("social_insights").insert({ report_id: rid, working, not_working: notWorking, actions, next_quarter: next });

  console.log(`    ✓ KPIs | ${platforms.length} platforms | ${topPosts.length} top posts | ${posts.length} all-posts | insights`);
}

// ─── Web migration ────────────────────────────────────────────────────
async function migrateWeb(quarter) {
  const reportKey = "web" + quarter;
  let raw;
  try {
    raw = await fetchJson(`${WEB_ENDPOINT}?report=${reportKey}&t=${Date.now()}`);
  } catch (e) {
    console.log(`  ${reportKey}: fetch failed — ${e.message}`);
    return;
  }
  if (raw?.error || !raw?.overall) {
    console.log(`  ${reportKey}: no data`);
    return;
  }
  console.log(`  ${reportKey}: found data, migrating…`);

  const o    = raw.overall   || {};
  const ins  = raw.insights  || {};
  const summ = typeof raw.execSummary === "string" ? raw.execSummary
    : Array.isArray(raw.execSummary) ? raw.execSummary[0] || ""
    : raw.summary?.bullet || "";

  const { data: rep, error: e1 } = await supabase
    .from("web_reports")
    .upsert({ quarter, summary_bullet: summ }, { onConflict: "quarter" })
    .select("id").single();
  if (e1) { console.error(`    report upsert failed:`, e1.message); return; }
  const rid = rep.id;

  await supabase.from("web_kpis").delete().eq("report_id", rid);
  await supabase.from("web_kpis").insert({
    report_id: rid,
    sessions:               num(o.sessions),
    users:                  num(o.users),
    engagement_rate:        num(o.engagementRate),
    avg_engagement_time_sec:num(o.avgEngagementTimeSec),
    actions:                num(o.actions),
    form_submissions:       num(o.formSubmissions),
  });

  const channels = (raw.channels || []).map((c, i) => ({
    report_id: rid, sort_order: i, name: c.name,
    sessions: num(c.sessions), share_of_traffic: num(c.shareOfTraffic), engagement_rate: num(c.engagementRate),
  }));
  if (channels.length) {
    await supabase.from("web_channels").delete().eq("report_id", rid);
    await supabase.from("web_channels").insert(channels);
  }

  const pages = (raw.topPages || []).map((p, i) => ({
    report_id: rid, sort_order: i, key: p.key || p.name,
    page_views: num(p.pageViews), bounce_rate: num(p.bounceRate), avg_time_on_page_sec: num(p.avgTimeOnPageSec),
  }));
  if (pages.length) {
    await supabase.from("web_pages").delete().eq("report_id", rid);
    await supabase.from("web_pages").insert(pages);
  }

  await supabase.from("web_insights").delete().eq("report_id", rid);
  await supabase.from("web_insights").insert({
    report_id: rid,
    working:      ins.working     || "",
    not_working:  ins.notWorking  || "",
    actions:      ins.actions     || "",
    next_quarter: ins.next        || "",
  });

  console.log(`    ✓ KPIs | ${channels.length} channels | ${pages.length} pages | insights`);
}

// ─── Run ─────────────────────────────────────────────────────────────
async function main() {
  if (SUPABASE_SERVICE_KEY === "PASTE_SERVICE_ROLE_KEY_HERE") {
    console.error("❌  Set SUPABASE_SERVICE_KEY before running:");
    console.error("    SUPABASE_SERVICE_KEY=your_key node migrate-from-sheets.js");
    process.exit(1);
  }

  console.log("\n── Social reports ───────────────────────────────────");
  for (const agency of Object.keys(AGENCIES)) {
    for (const quarter of QUARTERS) {
      await migrateSocial(agency, quarter);
    }
  }

  console.log("\n── Web reports ──────────────────────────────────────");
  for (const quarter of QUARTERS) {
    await migrateWeb(quarter);
  }

  console.log("\n✓ Migration complete.\n");
}

main().catch(err => { console.error("Fatal:", err); process.exit(1); });
