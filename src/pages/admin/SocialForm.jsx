import React, { useState, useEffect, useRef, useCallback } from "react";
import { supabase } from "../../lib/supabase.js";
import { IconClose } from "../../components/Icons.jsx";
import { parseLinkedInDemographics, AUDIENCE_DIMENSIONS, AUDIENCE_DIMENSION_LABELS, MAX_SEGMENTS } from "../../lib/linkedinDemographics.js";
import { parseClickPaths, parseRoute, formatRoute, MAX_PATHS } from "../../lib/clickPaths.js";

const num = v => (v === "" || v === null || v === undefined) ? null : (isFinite(Number(v)) ? Number(v) : null);
const str = v => (v == null ? "" : String(v));

const KPI_FIELDS = [
  { key: "posts",              label: "Posts Published",     isDecimal: false },
  { key: "impressions",        label: "Impressions",          isDecimal: false },
  { key: "reactions",          label: "Reactions",            isDecimal: false },
  { key: "shares",             label: "Shares",               isDecimal: false },
  { key: "followers",          label: "Followers",            isDecimal: false },
  { key: "link_clicks",        label: "Link Clicks",          isDecimal: false },
  { key: "comments",           label: "Comments",             isDecimal: false },
  { key: "avg_engagement_rate",label: "Avg Engagement Rate (%)", isDecimal: true },
];

const PLATFORMS_LIST = ["LinkedIn", "Facebook", "Instagram"];
const TOP_PLATFORMS  = ["linkedin", "facebook", "instagram"];

const BLANK_KPI      = Object.fromEntries(KPI_FIELDS.map(f => [f.key, ""]));
const BLANK_PLATFORM = { name: "", followers: "", engagement_rate: "", page_reach: "", page_clicks: "", note: "" };
const BLANK_POST     = { title: "", impressions: "", likes: "", shares: "" };
const BLANK_ALL_POST = { post_name: "", post_date: "", post_time: "", platforms: "", impressions: "", engagements: "", url: "", notes: "" };

// "HH:MM" for right now, in the browser's local time — used to default a
// freshly-added row's time, since you're typically logging a post right
// when it goes out. Still editable for back-filled/imported rows.
function nowTimeStr() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
const BLANK_INSIGHTS = { working: "", not_working: "", actions: "", next_quarter: "" };

const newAd       = () => ({ id: crypto.randomUUID(), name: "", impressions: "", reach: "", clicks: "", cpc: "", conversions: "", engagement_rate: "", status: "active" });
const newCampaign = () => ({ id: crypto.randomUUID(), name: "", objective: "", platform: "", budget: "", start_date: "", end_date: "", ads: [] });
const AD_STATUSES = ["active", "paused", "completed", "draft"];
const PAID_PLATFORM_OPTIONS = ["LinkedIn", "Facebook", "Instagram", "Google", "TikTok", "YouTube"];

// ─── CSV import parser ────────────────────────────────────────────
function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const headers = lines[0].split(",").map(h => h.trim().replace(/^"|"$/g, "").toLowerCase());
  const find = (...candidates) => candidates.reduce((found, c) => found !== -1 ? found : headers.findIndex(h => h.includes(c)), -1);
  const iName  = find("post name", "name", "title", "description");
  const iDate  = find("date");
  const iTime  = find("time");
  const iPlat  = find("platform");
  const iImp   = find("impression");
  const iEng   = find("engagement");
  const iUrl   = find("url", "link", "permalink");
  const iNotes = find("notes", "note");
  return lines.slice(1).map(line => {
    const cols = line.split(",").map(c => c.trim().replace(/^"|"$/g, ""));
    return {
      post_name:   iName  !== -1 ? (cols[iName]  ?? "") : "",
      post_date:   iDate  !== -1 ? (cols[iDate]  ?? "") : "",
      post_time:   iTime  !== -1 ? (cols[iTime]  ?? "") : "",
      platforms:   iPlat  !== -1 ? (cols[iPlat]  ?? "") : "",
      impressions: iImp   !== -1 ? (num(cols[iImp])   ?? 0) : 0,
      engagements: iEng   !== -1 ? (num(cols[iEng])   ?? 0) : 0,
      url:         iUrl   !== -1 ? (cols[iUrl]   ?? "") : "",
      notes:       iNotes !== -1 ? (cols[iNotes] ?? "") : "",
    };
  }).filter(r => r.post_name);
}

// ─── Shared sub-components ───────────────────────────────────────
function Field({ label, children }) {
  return (
    <div className="admin-field">
      <label className="admin-label">{label}</label>
      {children}
    </div>
  );
}

// ─── Audience demographics editor ────────────────────────────────
// Used once per campaign, and once more for any rows that aren't scoped to a
// campaign (imports made before breakdowns moved inside campaigns, or a
// genuinely account-wide export). `campaignId` is null for that second case.
function DemographicsBlock({ campaignId, rows, onImport, setDemographics, dirty, title, hint, children }) {
  const fileRef = useRef();
  const scopeLabel = campaignId ? "this campaign" : "the account-wide breakdown";

  const readFile = (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => onImport(ev.target.result, campaignId);
    reader.readAsText(file);
  };

  const dimensions = AUDIENCE_DIMENSIONS.filter(dim => rows.some(d => d.dimension === dim.key));

  return (
    <div className="admin-demo-block">
      <div className="admin-allposts-toolbar">
        <div>
          <h3 className="admin-demo-title">{title}</h3>
          <div className="admin-list-hint" style={{ marginBottom: 0 }}>{hint}</div>
        </div>
        <div className="admin-demo-actions">
          <input ref={fileRef} type="file" accept=".csv,text/csv" style={{ display: "none" }} onChange={readFile} />
          <button className="admin-btn-secondary" onClick={() => fileRef.current?.click()}>
            Import audience CSV
          </button>
          {rows.length > 0 && (
            <button className="admin-btn-secondary" onClick={() => {
              if (window.confirm(`Clear all demographics for ${scopeLabel}? This cannot be undone unless you save first.`)) {
                setDemographics(ds => ds.filter(d => (d.campaign_id || null) !== campaignId));
                dirty();
              }
            }}>Clear</button>
          )}
          {children}
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="admin-list-hint">No audience data imported yet.</div>
      ) : dimensions.map(dim => {
        const dimRows = rows.filter(d => d.dimension === dim.key);
        return (
          <div key={dim.key} className="admin-demo-dim">
            <div className="admin-demo-dim-head">
              <span className="admin-demo-dim-name">{dim.label}</span>
              <span className="admin-demo-dim-count">{dimRows.length} segment{dimRows.length === 1 ? "" : "s"}</span>
              <button className="admin-btn-remove"
                onClick={() => {
                  setDemographics(ds => ds.filter(d => !((d.campaign_id || null) === campaignId && d.dimension === dim.key)));
                  dirty();
                }}
                aria-label={`Remove ${dim.label}`}><IconClose /></button>
            </div>
            <div className="admin-posts-table-wrap">
              <table className="admin-posts-table admin-demo-table">
                <thead>
                  <tr><th>Segment</th><th className="r">Impressions</th><th className="r">Clicks</th><th /></tr>
                </thead>
                <tbody>
                  {dimRows.map(row => (
                    <tr key={row.id}>
                      <td><input className="admin-input admin-input--cell" value={row.segment}
                        onChange={e => { setDemographics(ds => ds.map(d => d.id === row.id ? { ...d, segment: e.target.value } : d)); dirty(); }} /></td>
                      <td><input type="number" className="admin-input admin-input--cell r" value={row.impressions}
                        onChange={e => { setDemographics(ds => ds.map(d => d.id === row.id ? { ...d, impressions: e.target.value } : d)); dirty(); }} /></td>
                      <td><input type="number" className="admin-input admin-input--cell r" value={row.clicks}
                        onChange={e => { setDemographics(ds => ds.map(d => d.id === row.id ? { ...d, clicks: e.target.value } : d)); dirty(); }} /></td>
                      <td><button className="admin-btn-remove"
                        onClick={() => { setDemographics(ds => ds.filter(d => d.id !== row.id)); dirty(); }}
                        aria-label="Remove segment"><IconClose /></button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── Click paths editor (on-site journeys after an ad click) ─────
// One block per campaign, plus one for journeys that cover paid traffic as a
// whole. A path export describes the whole of its scope, so importing replaces
// that scope's rows rather than stacking on top of them — the alternative
// double-counts every session the moment a file is imported twice.
const newPathRow = (campaignId) => ({
  id: crypto.randomUUID(), campaign_id: campaignId, path: "", sessions: "", conversions: "", is_other: false,
});

function ClickPathsBlock({ campaignId, rows, onImport, setClickPaths, dirty, title, hint, children }) {
  const fileRef = useRef();
  const [paste, setPaste] = useState("");
  const scopeLabel = campaignId ? "this campaign" : "the site-wide breakdown";

  const readFile = (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => onImport(ev.target.result, campaignId);
    reader.readAsText(file);
  };

  const update = (id, patch) => {
    setClickPaths(ps => ps.map(p => (p.id === id ? { ...p, ...patch } : p)));
    dirty();
  };

  const sessions = rows.reduce((a, r) => a + (num(r.sessions) || 0), 0);

  return (
    <div className="admin-demo-block">
      <div className="admin-allposts-toolbar">
        <div>
          <h3 className="admin-demo-title">{title}</h3>
          <div className="admin-list-hint" style={{ marginBottom: 0 }}>{hint}</div>
        </div>
        <div className="admin-demo-actions">
          <input ref={fileRef} type="file" accept=".csv,.tsv,text/csv,text/plain" style={{ display: "none" }} onChange={readFile} />
          <button className="admin-btn-secondary" onClick={() => fileRef.current?.click()}>Import journeys</button>
          {rows.length > 0 && (
            <button className="admin-btn-secondary" onClick={() => {
              if (window.confirm(`Clear all journeys for ${scopeLabel}? This cannot be undone unless you save first.`)) {
                setClickPaths(ps => ps.filter(p => (p.campaign_id || null) !== campaignId));
                dirty();
              }
            }}>Clear</button>
          )}
          {children}
        </div>
      </div>

      <div className="admin-paste-row">
        <textarea
          className="admin-textarea admin-textarea--paste"
          rows={2}
          value={paste}
          onChange={e => setPaste(e.target.value)}
          placeholder={"Paste rows: /warehouse-jobs > /jobs > /apply    120    8"}
          aria-label="Paste journey rows"
        />
        <button className="admin-btn-secondary" disabled={!paste.trim()}
          onClick={() => { if (onImport(paste, campaignId)) setPaste(""); }}>
          Add pasted rows
        </button>
      </div>

      {rows.length === 0 ? (
        <div className="admin-list-hint">No journeys imported yet.</div>
      ) : (
        <>
          <div className="admin-posts-table-wrap">
            <table className="admin-posts-table admin-demo-table">
              <thead>
                <tr><th>Journey (pages in order, separated by &gt;)</th><th className="r">Sessions</th><th className="r">Conversions</th><th /></tr>
              </thead>
              <tbody>
                {rows.map(row => (
                  <tr key={row.id}>
                    <td>
                      <input className="admin-input admin-input--cell" value={row.path}
                        placeholder={row.is_other ? "Combined tail — no route" : "/landing > /next-page"}
                        disabled={row.is_other}
                        onChange={e => update(row.id, { path: e.target.value })} />
                    </td>
                    <td><input type="number" className="admin-input admin-input--cell r" value={row.sessions}
                      onChange={e => update(row.id, { sessions: e.target.value })} /></td>
                    <td><input type="number" className="admin-input admin-input--cell r" value={row.conversions}
                      onChange={e => update(row.id, { conversions: e.target.value })} /></td>
                    <td><button className="admin-btn-remove"
                      onClick={() => { setClickPaths(ps => ps.filter(p => p.id !== row.id)); dirty(); }}
                      aria-label="Remove journey"><IconClose /></button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="admin-list-hint" style={{ marginTop: 8 }}>
            {rows.length} journey{rows.length === 1 ? "" : "s"} · {sessions.toLocaleString()} sessions
          </p>
        </>
      )}
      <button className="admin-btn-add"
        onClick={() => { setClickPaths(ps => [...ps, newPathRow(campaignId)]); dirty(); }}>
        + Add journey
      </button>
    </div>
  );
}

function SaveBar({ saving, message, onSave }) {
  return (
    <div className="admin-save-bar">
      {message && <span className={"admin-save-msg" + (message.startsWith("Error") ? " is-error" : "")}>{message}</span>}
      <button className="admin-btn-primary" onClick={onSave} disabled={saving}>
        {saving ? "Saving…" : "Save"}
      </button>
    </div>
  );
}

// ─── Tabs ────────────────────────────────────────────────────────
const TABS = [
  { id: "overview",  label: "Overview"  },
  { id: "platforms", label: "Platforms" },
  { id: "topposts",  label: "Top Posts" },
  { id: "allposts",  label: "All Posts" },
  { id: "paidmedia", label: "Paid Media" },
  { id: "insights",  label: "Insights"  },
];

// Throws on Supabase error so callers don't have to destructure every response
const dbOp = async (promise) => {
  const { error } = await promise;
  if (error) throw error;
};

// ─── Main form ───────────────────────────────────────────────────
export function SocialForm({ agency, quarter, onDirtyChange }) {
  const [tab,       setTab]      = useState("overview");
  const [saving,    setSaving]   = useState(false);
  const [saveMsg,   setSaveMsg]  = useState("");
  const [loading,   setLoading]  = useState(true);
  const [loadError, setLoadError] = useState("");

  const [editorsNote, setEditorsNote] = useState("");
  const [kpis,        setKpis]        = useState(BLANK_KPI);
  const [platforms,   setPlatforms]   = useState([]);
  const [topPosts,    setTopPosts]    = useState({ linkedin: [], facebook: [], instagram: [] });
  const [allPosts,    setAllPosts]    = useState([]);
  const [campaigns,   setCampaigns]   = useState([]);
  const [demographics, setDemographics] = useState([]);
  const [clickPaths, setClickPaths] = useState([]);
  const [insights,    setInsights]    = useState(BLANK_INSIGHTS);
  const [topTab,      setTopTab]      = useState("linkedin");
  const [postsAsc,    setPostsAsc]    = useState(false);

  // Reorder the All Posts rows by date. Manual, not live, so rows don't jump
  // while a date is being typed; toggles newest-first / oldest-first on each
  // click. ISO "YYYY-MM-DD" strings sort chronologically as plain strings, and
  // undated rows sink to the bottom either way.
  const sortPostsByDate = () => {
    setAllPosts(ps => [...ps].sort((a, b) => {
      const da = a.post_date || "", db = b.post_date || "";
      if (!da && !db) return 0;
      if (!da) return 1;
      if (!db) return -1;
      return postsAsc ? da.localeCompare(db) : db.localeCompare(da);
    }));
    setPostsAsc(a => !a);
    dirty();
  };
  const csvRef   = useRef();
  // Gate that prevents the initial data load from marking the form dirty
  const canDirty = useRef(false);

  const dirty = useCallback(() => {
    if (canDirty.current) onDirtyChange?.(true);
  }, [onDirtyChange]);

  // Load existing data
  useEffect(() => {
    canDirty.current = false;
    setLoading(true);
    setLoadError("");
    (async () => {
      try {
        const { data, error } = await supabase
          .from("social_reports")
          .select("id, editors_note, social_kpis(*), social_platforms(*), social_top_posts(*), social_posts(*), social_insights(*), paid_media_campaigns(*, paid_media_ads(*)), paid_media_demographics(*), paid_media_click_paths(*)")
          .eq("agency", agency)
          .eq("quarter", quarter)
          .maybeSingle();
        if (error) throw error;
        if (data) {
          setEditorsNote(data.editors_note || "");
          const k = data.social_kpis?.[0] || {};
          setKpis(Object.fromEntries(KPI_FIELDS.map(f => [f.key, k[f.key] ?? ""])));
          setPlatforms([...(data.social_platforms || [])].sort((a, b) => a.sort_order - b.sort_order).map(p => ({
            name: p.name, followers: str(p.followers), engagement_rate: str(p.engagement_rate),
            page_reach: str(p.page_reach), page_clicks: str(p.page_clicks), note: p.note || "",
          })));
          const tp = { linkedin: [], facebook: [], instagram: [] };
          for (const p of (data.social_top_posts || [])) {
            tp[p.platform]?.push({ title: p.title, impressions: str(p.impressions), likes: str(p.likes), shares: str(p.shares) });
          }
          setTopPosts(tp);
          setAllPosts((data.social_posts || []).map(p => ({
            post_name: p.post_name || "", post_date: p.post_date || "", post_time: p.post_time || "", platforms: p.platforms || "",
            impressions: str(p.impressions), engagements: str(p.engagements), url: p.url || "", notes: p.notes || "",
          })));
          setDemographics([...(data.paid_media_demographics || [])]
            .sort((a, b) => a.dimension.localeCompare(b.dimension) || a.sort_order - b.sort_order)
            .map(d => ({
              id: d.id, dimension: d.dimension, segment: d.segment || "",
              campaign_id: d.campaign_id || null, is_other: !!d.is_other,
              impressions: str(d.impressions), clicks: str(d.clicks),
            })));
          setClickPaths([...(data.paid_media_click_paths || [])]
            .sort((a, b) => a.sort_order - b.sort_order)
            .map(p => ({
              id: p.id, campaign_id: p.campaign_id || null, is_other: !!p.is_other,
              path: formatRoute(Array.isArray(p.steps) ? p.steps : []),
              sessions: str(p.sessions), conversions: str(p.conversions),
            })));
          const ins = data.social_insights?.[0] || {};
          setInsights({ working: ins.working || "", not_working: ins.not_working || "", actions: ins.actions || "", next_quarter: ins.next_quarter || "" });
          setCampaigns([...(data.paid_media_campaigns || [])].sort((a, b) => a.sort_order - b.sort_order).map(c => ({
            id: c.id, name: c.name || "", objective: c.objective || "", platform: c.platform || "",
            budget: str(c.budget), start_date: c.start_date || "", end_date: c.end_date || "",
            ads: [...(c.paid_media_ads || [])].sort((a, b) => a.sort_order - b.sort_order).map(a => ({
              id: a.id, name: a.name || "", impressions: str(a.impressions), reach: str(a.reach), clicks: str(a.clicks),
              cpc: str(a.cpc), conversions: str(a.conversions), engagement_rate: str(a.engagement_rate), status: a.status || "active",
            })),
          })));
        }
      } catch (err) {
        setLoadError("Failed to load report data. Please refresh and try again.");
      } finally {
        setLoading(false);
        canDirty.current = true;
      }
    })();
  }, [agency, quarter]);

  const flash = msg => { setSaveMsg(msg); setTimeout(() => setSaveMsg(""), 4000); };

  // Import a LinkedIn audience export into one campaign (or account-wide when
  // campaignId is null). The dimension is auto-detected from the file's
  // header, and re-importing a dimension replaces that campaign's rows for it
  // rather than duplicating them.
  const importDemographics = (text, campaignId = null) => {
    const parsed = parseLinkedInDemographics(text);
    if (!parsed) {
      flash("Error: Couldn’t read that file as a LinkedIn audience export.");
      return;
    }
    setDemographics(prev => [
      ...prev.filter(d => !((d.campaign_id || null) === campaignId && d.dimension === parsed.dimension)),
      ...parsed.rows.map(r => ({
        id: crypto.randomUUID(), dimension: parsed.dimension, campaign_id: campaignId,
        segment: r.segment, is_other: r.isOther,
        impressions: str(r.impressions), clicks: str(r.clicks),
      })),
    ]);
    dirty();
    const label = AUDIENCE_DIMENSION_LABELS[parsed.dimension];
    const n = parsed.rows.length;
    flash(parsed.truncated
      // The Companies export runs to thousands of rows; the tail is summed into
      // a single "Other" segment rather than dropped, so say so.
      ? `Imported the top ${MAX_SEGMENTS} ${label} segments ✓ — the remaining ${parsed.truncated.toLocaleString()} are combined into one “Other” row`
      : `Imported ${n} ${label} segment${n === 1 ? "" : "s"} ✓`);
  };

  // Import a path export into one campaign (or site-wide when campaignId is
  // null). Returns whether anything was read, so the paste box knows to clear
  // itself. The scope's existing journeys are replaced: an export describes
  // all of its scope's traffic, so merging one in twice would double every
  // session it counts.
  const importClickPaths = (text, campaignId = null) => {
    const parsed = parseClickPaths(text);
    if (!parsed) {
      flash("Error: Couldn’t read that as a list of journeys.");
      return false;
    }
    setClickPaths(prev => [
      ...prev.filter(p => (p.campaign_id || null) !== campaignId),
      ...parsed.rows.map(r => ({
        id: crypto.randomUUID(), campaign_id: campaignId, is_other: !!r.isOther,
        path: formatRoute(r.steps), sessions: str(r.sessions), conversions: str(r.conversions),
      })),
    ]);
    dirty();
    const n = parsed.rows.length - (parsed.truncated ? 1 : 0);
    flash(parsed.truncated
      ? `Imported the top ${MAX_PATHS} journeys ✓ — the remaining ${parsed.truncated.toLocaleString()} `
        + `(${parsed.droppedSessions.toLocaleString()} sessions) are combined into one “other” row`
      : `Imported ${n} journey${n === 1 ? "" : "s"} ✓`);
    return true;
  };

  // Demographics and journeys belong to a campaign, so removing a campaign
  // takes its breakdowns with it — matching the database's cascade, and keeping
  // the save from inserting rows that point at a campaign that no longer
  // exists.
  const removeCampaign = (index) => {
    const removed = campaigns[index];
    setCampaigns(cs => cs.filter((_, j) => j !== index));
    setDemographics(ds => ds.filter(d => d.campaign_id !== removed.id));
    setClickPaths(ps => ps.filter(p => p.campaign_id !== removed.id));
    dirty();
  };

  const save = async () => {
    setSaving(true);
    setSaveMsg("");
    try {
      // Upsert report row
      const { data: rep, error: e1 } = await supabase
        .from("social_reports")
        .upsert({ agency, quarter, editors_note: editorsNote }, { onConflict: "agency,quarter" })
        .select("id").single();
      if (e1) throw e1;
      const rid = rep.id;

      // KPIs
      await dbOp(supabase.from("social_kpis").delete().eq("report_id", rid));
      await dbOp(supabase.from("social_kpis").insert({
        report_id: rid,
        ...Object.fromEntries(KPI_FIELDS.map(f => [f.key, num(kpis[f.key])])),
      }));

      // Platforms
      await dbOp(supabase.from("social_platforms").delete().eq("report_id", rid));
      if (platforms.length) {
        await dbOp(supabase.from("social_platforms").insert(platforms.map((p, i) => ({
          report_id: rid, sort_order: i, name: p.name,
          followers: num(p.followers), engagement_rate: num(p.engagement_rate),
          page_reach: num(p.page_reach), page_clicks: num(p.page_clicks), note: p.note,
        }))));
      }

      // Top posts
      await dbOp(supabase.from("social_top_posts").delete().eq("report_id", rid));
      const allTop = Object.entries(topPosts).flatMap(([plat, posts]) =>
        posts.map(p => ({ report_id: rid, platform: plat, title: p.title, impressions: num(p.impressions), likes: num(p.likes), shares: num(p.shares) }))
      );
      if (allTop.length) await dbOp(supabase.from("social_top_posts").insert(allTop));

      // All posts
      await dbOp(supabase.from("social_posts").delete().eq("report_id", rid));
      if (allPosts.length) {
        await dbOp(supabase.from("social_posts").insert(allPosts.map(p => ({
          report_id: rid, post_name: p.post_name, post_date: p.post_date || null, post_time: p.post_time || null,
          platforms: p.platforms, impressions: num(p.impressions), engagements: num(p.engagements),
          url: p.url, notes: p.notes,
        }))));
      }

      // Paid media (campaign ids are generated client-side so ads can
      // reference their campaign without a round trip to read back inserted ids)
      await dbOp(supabase.from("paid_media_campaigns").delete().eq("report_id", rid));
      if (campaigns.length) {
        await dbOp(supabase.from("paid_media_campaigns").insert(campaigns.map((c, i) => ({
          id: c.id, report_id: rid, sort_order: i, name: c.name,
          objective: c.objective, platform: c.platform, budget: num(c.budget),
          start_date: c.start_date || null, end_date: c.end_date || null,
        }))));
        const ads = campaigns.flatMap(c => c.ads.map((a, j) => ({
          id: a.id, campaign_id: c.id, sort_order: j, name: a.name,
          impressions: num(a.impressions), reach: num(a.reach), clicks: num(a.clicks),
          cpc: num(a.cpc), conversions: num(a.conversions),
          engagement_rate: num(a.engagement_rate), status: a.status || "active",
        })));
        if (ads.length) await dbOp(supabase.from("paid_media_ads").insert(ads));
      }

      // Paid media demographics (LinkedIn audience). Written after the
      // campaigns they reference, since deleting a campaign above cascades to
      // its rows. sort_order runs within each campaign+dimension so the report
      // renders segments in import order — strongest first, with the combined
      // "Other" row last.
      await dbOp(supabase.from("paid_media_demographics").delete().eq("report_id", rid));
      if (demographics.length) {
        const liveCampaigns = new Set(campaigns.map(c => c.id));
        const perGroup = {};
        const demoRows = demographics
          // A row pointing at a campaign that's been removed has nowhere to go.
          .filter(d => d.dimension && d.segment && (!d.campaign_id || liveCampaigns.has(d.campaign_id)))
          .map(d => {
            const group = `${d.campaign_id || ""}:${d.dimension}`;
            const order = perGroup[group] = (perGroup[group] ?? -1) + 1;
            return {
              report_id: rid, campaign_id: d.campaign_id || null,
              dimension: d.dimension, segment: d.segment, is_other: !!d.is_other,
              sort_order: order, impressions: num(d.impressions), clicks: num(d.clicks),
            };
          });
        if (demoRows.length) await dbOp(supabase.from("paid_media_demographics").insert(demoRows));
      }

      // Click paths (on-site journeys). Written after the campaigns they
      // reference, for the same reason as demographics. Rows keep their edited
      // order, which import leaves strongest-first, so the report's "top
      // journeys" and this table read the same way down the page.
      await dbOp(supabase.from("paid_media_click_paths").delete().eq("report_id", rid));
      if (clickPaths.length) {
        const liveCampaigns = new Set(campaigns.map(c => c.id));
        const perScope = {};
        const pathRows = clickPaths
          .filter(p => !p.campaign_id || liveCampaigns.has(p.campaign_id))
          .map(p => ({ ...p, steps: p.is_other ? [] : parseRoute(p.path), sessions: num(p.sessions) }))
          // A journey with no route and no "other" flag is an empty row the
          // editor left behind; one with no sessions has nothing to draw.
          .filter(p => (p.steps.length || p.is_other) && p.sessions > 0)
          .map(p => {
            const scope = p.campaign_id || "";
            const order = perScope[scope] = (perScope[scope] ?? -1) + 1;
            return {
              report_id: rid, campaign_id: p.campaign_id || null, sort_order: order,
              steps: p.steps, sessions: p.sessions, conversions: num(p.conversions),
              is_other: !!p.is_other,
            };
          });
        if (pathRows.length) await dbOp(supabase.from("paid_media_click_paths").insert(pathRows));
      }

      // Insights
      await dbOp(supabase.from("social_insights").delete().eq("report_id", rid));
      await dbOp(supabase.from("social_insights").insert({ report_id: rid, ...insights }));

      onDirtyChange?.(false);
      flash("Saved ✓");
    } catch (err) {
      flash("Error: " + err.message);
    } finally {
      setSaving(false);
    }
  };

  if (loading)   return <div className="admin-form-status">Loading report data…</div>;
  if (loadError) return <div className="admin-form-status admin-form-status--error">{loadError}</div>;

  const accountWideDemographics = demographics.filter(d => !d.campaign_id);
  const siteWideClickPaths = clickPaths.filter(p => !p.campaign_id);

  // ── Render ──
  return (
    <div className="admin-form">
      <div className="admin-section-tabs" role="tablist">
        {TABS.map(t => (
          <button key={t.id} role="tab" aria-selected={tab === t.id}
            className={"admin-section-tab" + (tab === t.id ? " is-active" : "")}
            onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>

      {/* Overview */}
      {tab === "overview" && (
        <div className="admin-form-section">
          <Field label="Editor's Note / Summary">
            <textarea className="admin-textarea" rows={3} value={editorsNote}
              onChange={e => { setEditorsNote(e.target.value); dirty(); }}
              placeholder="Brief summary shown at the top of the report…" />
          </Field>
          <div className="admin-kpi-grid">
            {KPI_FIELDS.map(f => (
              <Field key={f.key} label={f.label}>
                <input type="number" className="admin-input" value={kpis[f.key]}
                  step={f.isDecimal ? "0.001" : "1"}
                  onChange={e => { setKpis(k => ({ ...k, [f.key]: e.target.value })); dirty(); }} />
              </Field>
            ))}
          </div>
        </div>
      )}

      {/* Platforms */}
      {tab === "platforms" && (
        <div className="admin-form-section">
          <div className="admin-list-hint">Add each social platform — LinkedIn, Facebook, Instagram, etc.</div>
          {platforms.map((p, i) => (
            <div key={i} className="admin-list-row">
              <div className="admin-list-row-grid admin-platform-grid">
                <Field label="Platform name">
                  <select className="admin-input" value={p.name}
                    onChange={e => { setPlatforms(ps => ps.map((x, j) => j === i ? { ...x, name: e.target.value } : x)); dirty(); }}>
                    <option value="">Select…</option>
                    {PLATFORMS_LIST.map(n => <option key={n} value={n}>{n}</option>)}
                  </select>
                </Field>
                <Field label="Followers">
                  <input type="number" className="admin-input" value={p.followers}
                    onChange={e => { setPlatforms(ps => ps.map((x, j) => j === i ? { ...x, followers: e.target.value } : x)); dirty(); }} />
                </Field>
                <Field label="Engagement Rate (%)">
                  <input type="number" step="0.001" className="admin-input" value={p.engagement_rate}
                    onChange={e => { setPlatforms(ps => ps.map((x, j) => j === i ? { ...x, engagement_rate: e.target.value } : x)); dirty(); }} />
                </Field>
                <Field label="Page Reach">
                  <input type="number" className="admin-input" value={p.page_reach}
                    onChange={e => { setPlatforms(ps => ps.map((x, j) => j === i ? { ...x, page_reach: e.target.value } : x)); dirty(); }} />
                </Field>
                <Field label="Page Clicks">
                  <input type="number" className="admin-input" value={p.page_clicks}
                    onChange={e => { setPlatforms(ps => ps.map((x, j) => j === i ? { ...x, page_clicks: e.target.value } : x)); dirty(); }} />
                </Field>
                <Field label="Note">
                  <input type="text" className="admin-input" value={p.note}
                    onChange={e => { setPlatforms(ps => ps.map((x, j) => j === i ? { ...x, note: e.target.value } : x)); dirty(); }} />
                </Field>
              </div>
              <button className="admin-btn-remove"
                onClick={() => { setPlatforms(ps => ps.filter((_, j) => j !== i)); dirty(); }}
                aria-label="Remove platform"><IconClose /></button>
            </div>
          ))}
          <button className="admin-btn-add"
            onClick={() => { setPlatforms(ps => [...ps, { ...BLANK_PLATFORM }]); dirty(); }}>
            + Add platform
          </button>
        </div>
      )}

      {/* Top Posts */}
      {tab === "topposts" && (
        <div className="admin-form-section">
          <div className="admin-section-tabs admin-section-tabs--sub" role="tablist">
            {TOP_PLATFORMS.map(p => (
              <button key={p} role="tab" aria-selected={topTab === p}
                className={"admin-section-tab" + (topTab === p ? " is-active" : "")}
                onClick={() => setTopTab(p)}>
                {p.charAt(0).toUpperCase() + p.slice(1)}
              </button>
            ))}
          </div>
          <div className="admin-list-hint">Top-performing posts for {topTab.charAt(0).toUpperCase() + topTab.slice(1)} this quarter.</div>
          {topPosts[topTab].map((p, i) => (
            <div key={i} className="admin-list-row">
              <div className="admin-list-row-grid admin-toppost-grid">
                <Field label="Post title / headline">
                  <input type="text" className="admin-input" value={p.title}
                    onChange={e => { setTopPosts(tp => ({ ...tp, [topTab]: tp[topTab].map((x, j) => j === i ? { ...x, title: e.target.value } : x) })); dirty(); }} />
                </Field>
                <Field label="Impressions">
                  <input type="number" className="admin-input" value={p.impressions}
                    onChange={e => { setTopPosts(tp => ({ ...tp, [topTab]: tp[topTab].map((x, j) => j === i ? { ...x, impressions: e.target.value } : x) })); dirty(); }} />
                </Field>
                <Field label="Likes / Reactions">
                  <input type="number" className="admin-input" value={p.likes}
                    onChange={e => { setTopPosts(tp => ({ ...tp, [topTab]: tp[topTab].map((x, j) => j === i ? { ...x, likes: e.target.value } : x) })); dirty(); }} />
                </Field>
                <Field label="Shares">
                  <input type="number" className="admin-input" value={p.shares}
                    onChange={e => { setTopPosts(tp => ({ ...tp, [topTab]: tp[topTab].map((x, j) => j === i ? { ...x, shares: e.target.value } : x) })); dirty(); }} />
                </Field>
              </div>
              <button className="admin-btn-remove"
                onClick={() => { setTopPosts(tp => ({ ...tp, [topTab]: tp[topTab].filter((_, j) => j !== i) })); dirty(); }}
                aria-label="Remove post"><IconClose /></button>
            </div>
          ))}
          <button className="admin-btn-add"
            onClick={() => { setTopPosts(tp => ({ ...tp, [topTab]: [...tp[topTab], { ...BLANK_POST }] })); dirty(); }}>
            + Add post
          </button>
        </div>
      )}

      {/* All Posts */}
      {tab === "allposts" && (
        <div className="admin-form-section">
          <div className="admin-allposts-toolbar">
            <div className="admin-list-hint" style={{ marginBottom: 0 }}>
              Full post log for the quarter. Import via CSV or add rows manually.
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <input ref={csvRef} type="file" accept=".csv,text/csv" style={{ display: "none" }}
                onChange={e => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  const reader = new FileReader();
                  reader.onload = ev => {
                    const rows = parseCsv(ev.target.result);
                    setAllPosts(p => [...p, ...rows]);
                    dirty();
                  };
                  reader.onerror = () => flash("Error: Could not read the CSV file.");
                  reader.readAsText(file);
                  e.target.value = "";
                }} />
              <button className="admin-btn-secondary" onClick={sortPostsByDate} disabled={allPosts.length < 2}>
                Sort by date {postsAsc ? "↑" : "↓"}
              </button>
              <button className="admin-btn-secondary" onClick={() => csvRef.current?.click()}>Import CSV</button>
              <button className="admin-btn-secondary" onClick={() => {
                if (!allPosts.length) return;
                if (window.confirm("Clear all posts? This cannot be undone unless you save first.")) {
                  setAllPosts([]);
                  dirty();
                }
              }}>Clear all</button>
            </div>
          </div>
          <p className="admin-csv-hint">CSV columns: <code>Post Name, Date, Time, Platforms, Impressions, Engagements, URL, Notes</code> (Time is optional)</p>
          <div className="admin-posts-table-wrap">
            <table className="admin-posts-table">
              <thead>
                <tr>
                  <th>Post name</th><th>Date</th><th>Time</th><th>Platforms</th>
                  <th className="r">Impressions</th><th className="r">Engagements</th>
                  <th>URL</th><th>Notes</th><th />
                </tr>
              </thead>
              <tbody>
                {allPosts.map((p, i) => (
                  <tr key={i}>
                    <td><input className="admin-input admin-input--cell" value={p.post_name} onChange={e => { setAllPosts(ps => ps.map((x, j) => j === i ? { ...x, post_name: e.target.value } : x)); dirty(); }} /></td>
                    <td><input type="date" className="admin-input admin-input--cell" value={p.post_date} onChange={e => { setAllPosts(ps => ps.map((x, j) => j === i ? { ...x, post_date: e.target.value } : x)); dirty(); }} /></td>
                    <td><input type="time" className="admin-input admin-input--cell" value={p.post_time || ""} onChange={e => { setAllPosts(ps => ps.map((x, j) => j === i ? { ...x, post_time: e.target.value } : x)); dirty(); }} /></td>
                    <td><input className="admin-input admin-input--cell" value={p.platforms} placeholder="LinkedIn, Facebook…" onChange={e => { setAllPosts(ps => ps.map((x, j) => j === i ? { ...x, platforms: e.target.value } : x)); dirty(); }} /></td>
                    <td><input type="number" className="admin-input admin-input--cell r" value={p.impressions} onChange={e => { setAllPosts(ps => ps.map((x, j) => j === i ? { ...x, impressions: e.target.value } : x)); dirty(); }} /></td>
                    <td><input type="number" className="admin-input admin-input--cell r" value={p.engagements} onChange={e => { setAllPosts(ps => ps.map((x, j) => j === i ? { ...x, engagements: e.target.value } : x)); dirty(); }} /></td>
                    <td><input className="admin-input admin-input--cell" value={p.url} placeholder="https://…" onChange={e => { setAllPosts(ps => ps.map((x, j) => j === i ? { ...x, url: e.target.value } : x)); dirty(); }} /></td>
                    <td><input className="admin-input admin-input--cell" value={p.notes} onChange={e => { setAllPosts(ps => ps.map((x, j) => j === i ? { ...x, notes: e.target.value } : x)); dirty(); }} /></td>
                    <td><button className="admin-btn-remove" onClick={() => { setAllPosts(ps => ps.filter((_, j) => j !== i)); dirty(); }} aria-label="Remove"><IconClose /></button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <button className="admin-btn-add" onClick={() => { setAllPosts(ps => [...ps, { ...BLANK_ALL_POST, post_time: nowTimeStr() }]); dirty(); }}>+ Add row</button>
          <p className="admin-list-hint" style={{ marginTop: 8 }}>{allPosts.length} post{allPosts.length !== 1 ? "s" : ""}</p>
        </div>
      )}

      {/* Paid Media */}
      {tab === "paidmedia" && (
        <div className="admin-form-section">
          <div className="admin-list-hint">Group ads under a campaign, then add each ad with its metrics.</div>
          <datalist id="paid-platform-options">
            {PAID_PLATFORM_OPTIONS.map(p => <option key={p} value={p} />)}
          </datalist>
          {campaigns.map((c, ci) => (
            <div key={c.id} className="admin-campaign-card">
              <div className="admin-campaign-card-head">
                <Field label="Campaign name">
                  <input type="text" className="admin-input" value={c.name}
                    onChange={e => { setCampaigns(cs => cs.map((x, j) => j === ci ? { ...x, name: e.target.value } : x)); dirty(); }} />
                </Field>
                <button className="admin-btn-remove"
                  onClick={() => removeCampaign(ci)}
                  aria-label="Remove campaign"><IconClose /></button>
              </div>

              <div className="admin-campaign-meta">
                <Field label="Objective">
                  <input type="text" className="admin-input" value={c.objective} placeholder="Leads, Traffic, Awareness…"
                    onChange={e => { setCampaigns(cs => cs.map((x, j) => j === ci ? { ...x, objective: e.target.value } : x)); dirty(); }} />
                </Field>
                <Field label="Platform">
                  <input type="text" className="admin-input" list="paid-platform-options" value={c.platform} placeholder="LinkedIn, Facebook…"
                    onChange={e => { setCampaigns(cs => cs.map((x, j) => j === ci ? { ...x, platform: e.target.value } : x)); dirty(); }} />
                </Field>
                <Field label="Budget ($)">
                  <input type="number" step="0.01" className="admin-input" value={c.budget}
                    onChange={e => { setCampaigns(cs => cs.map((x, j) => j === ci ? { ...x, budget: e.target.value } : x)); dirty(); }} />
                </Field>
                <Field label="Start date">
                  <input type="date" className="admin-input" value={c.start_date}
                    onChange={e => { setCampaigns(cs => cs.map((x, j) => j === ci ? { ...x, start_date: e.target.value } : x)); dirty(); }} />
                </Field>
                <Field label="End date">
                  <input type="date" className="admin-input" value={c.end_date}
                    onChange={e => { setCampaigns(cs => cs.map((x, j) => j === ci ? { ...x, end_date: e.target.value } : x)); dirty(); }} />
                </Field>
              </div>

              {c.ads.map((a, ai) => (
                <div key={a.id} className="admin-list-row">
                  <div className="admin-list-row-grid admin-ad-grid">
                    <Field label="Ad name">
                      <input type="text" className="admin-input" value={a.name}
                        onChange={e => { setCampaigns(cs => cs.map((x, j) => j === ci ? { ...x, ads: x.ads.map((y, k) => k === ai ? { ...y, name: e.target.value } : y) } : x)); dirty(); }} />
                    </Field>
                    <Field label="Impressions">
                      <input type="number" className="admin-input" value={a.impressions}
                        onChange={e => { setCampaigns(cs => cs.map((x, j) => j === ci ? { ...x, ads: x.ads.map((y, k) => k === ai ? { ...y, impressions: e.target.value } : y) } : x)); dirty(); }} />
                    </Field>
                    <Field label="Reach">
                      <input type="number" className="admin-input" value={a.reach}
                        onChange={e => { setCampaigns(cs => cs.map((x, j) => j === ci ? { ...x, ads: x.ads.map((y, k) => k === ai ? { ...y, reach: e.target.value } : y) } : x)); dirty(); }} />
                    </Field>
                    <Field label="Clicks">
                      <input type="number" className="admin-input" value={a.clicks}
                        onChange={e => { setCampaigns(cs => cs.map((x, j) => j === ci ? { ...x, ads: x.ads.map((y, k) => k === ai ? { ...y, clicks: e.target.value } : y) } : x)); dirty(); }} />
                    </Field>
                    <Field label="CPC ($)">
                      <input type="number" step="0.01" className="admin-input" value={a.cpc}
                        onChange={e => { setCampaigns(cs => cs.map((x, j) => j === ci ? { ...x, ads: x.ads.map((y, k) => k === ai ? { ...y, cpc: e.target.value } : y) } : x)); dirty(); }} />
                    </Field>
                    <Field label="Conversions">
                      <input type="number" className="admin-input" value={a.conversions}
                        onChange={e => { setCampaigns(cs => cs.map((x, j) => j === ci ? { ...x, ads: x.ads.map((y, k) => k === ai ? { ...y, conversions: e.target.value } : y) } : x)); dirty(); }} />
                    </Field>
                    <Field label="Engagement Rate (%)">
                      <input type="number" step="0.01" className="admin-input" value={a.engagement_rate}
                        onChange={e => { setCampaigns(cs => cs.map((x, j) => j === ci ? { ...x, ads: x.ads.map((y, k) => k === ai ? { ...y, engagement_rate: e.target.value } : y) } : x)); dirty(); }} />
                    </Field>
                    <Field label="Status">
                      <select className="admin-input" value={a.status}
                        onChange={e => { setCampaigns(cs => cs.map((x, j) => j === ci ? { ...x, ads: x.ads.map((y, k) => k === ai ? { ...y, status: e.target.value } : y) } : x)); dirty(); }}>
                        {AD_STATUSES.map(s => <option key={s} value={s}>{s.charAt(0).toUpperCase() + s.slice(1)}</option>)}
                      </select>
                    </Field>
                  </div>
                  <button className="admin-btn-remove"
                    onClick={() => { setCampaigns(cs => cs.map((x, j) => j === ci ? { ...x, ads: x.ads.filter((_, k) => k !== ai) } : x)); dirty(); }}
                    aria-label="Remove ad"><IconClose /></button>
                </div>
              ))}
              <button className="admin-btn-add"
                onClick={() => { setCampaigns(cs => cs.map((x, j) => j === ci ? { ...x, ads: [...x.ads, newAd()] } : x)); dirty(); }}>
                + Add ad
              </button>

              <DemographicsBlock
                campaignId={c.id}
                rows={demographics.filter(d => d.campaign_id === c.id)}
                onImport={importDemographics}
                setDemographics={setDemographics}
                dirty={dirty}
                title="Audience"
                hint="Who this campaign reached. Import a LinkedIn export — the breakdown (job function, seniority, industry, company…) is detected from the file."
              />

              <ClickPathsBlock
                campaignId={c.id}
                rows={clickPaths.filter(p => p.campaign_id === c.id)}
                onImport={importClickPaths}
                setClickPaths={setClickPaths}
                dirty={dirty}
                title="After the click"
                hint="Where this campaign's visitors went on the site. A GA4 path exploration export, or one row per journey."
              />
            </div>
          ))}
          <button className="admin-btn-add"
            onClick={() => { setCampaigns(cs => [...cs, newCampaign()]); dirty(); }}>
            + Add campaign
          </button>

          {/* Journeys that cover paid traffic as a whole rather than one
              campaign — the usual shape of a GA4 export, since a path
              exploration is filtered by traffic source rather than by ad.
              Always offered, since there's no other way to enter them. */}
          <ClickPathsBlock
            campaignId={null}
            rows={siteWideClickPaths}
            onImport={importClickPaths}
            setClickPaths={setClickPaths}
            dirty={dirty}
            title="After the click — site-wide"
            hint="Journeys for paid traffic generally, not one campaign. Shown in their own section at the foot of the report."
          >
            {campaigns.length > 0 && (
              <select
                className="admin-input admin-demo-move"
                value=""
                aria-label="Move site-wide journeys to a campaign"
                onChange={e => {
                  const id = e.target.value;
                  if (!id) return;
                  setClickPaths(ps => ps.map(p => (p.campaign_id ? p : { ...p, campaign_id: id })));
                  dirty();
                }}>
                <option value="">Move to campaign…</option>
                {campaigns.map((c, i) => (
                  <option key={c.id} value={c.id}>{c.name || `Campaign ${i + 1}`}</option>
                ))}
              </select>
            )}
          </ClickPathsBlock>

          <p className="admin-csv-hint">
            Journeys come from <code>GA4 → Explore → Path exploration</code> (start from the landing page,
            filtered to the paid traffic), exported as CSV — or any list of{" "}
            <code>route, sessions, conversions</code> rows, where a route is its pages in order:{" "}
            <code>/warehouse-jobs &gt; /jobs &gt; /apply</code>. A journey ends where the session ended.
          </p>

          <p className="admin-csv-hint">
            Audience files come from either <code>Campaign Manager → Analyze → Demographics → Export</code>
            (one file per breakdown) or the page’s <code>Analytics → Companies → Export</code>, which is read
            for its paid columns. Import each file into the campaign it belongs to — they stack into separate
            breakdowns.
          </p>

          {/* Audience rows not tied to a campaign — anything imported before
              breakdowns moved inside campaigns, plus genuinely account-wide
              exports. These render in their own section at the foot of the
              report; the picker moves them onto a campaign instead. */}
          {accountWideDemographics.length > 0 && (
            <DemographicsBlock
              campaignId={null}
              rows={accountWideDemographics}
              onImport={importDemographics}
              setDemographics={setDemographics}
              dirty={dirty}
              title="Account-wide audience"
              hint="Not tied to a campaign — shown in its own section at the foot of the report."
            >
              {campaigns.length > 0 && (
                <select
                  className="admin-input admin-demo-move"
                  value=""
                  aria-label="Move account-wide audience to a campaign"
                  onChange={e => {
                    const id = e.target.value;
                    if (!id) return;
                    setDemographics(ds => ds.map(d => d.campaign_id ? d : { ...d, campaign_id: id }));
                    dirty();
                  }}>
                  <option value="">Move to campaign…</option>
                  {campaigns.map((c, i) => (
                    <option key={c.id} value={c.id}>{c.name || `Campaign ${i + 1}`}</option>
                  ))}
                </select>
              )}
            </DemographicsBlock>
          )}
        </div>
      )}

      {/* Insights */}
      {tab === "insights" && (
        <div className="admin-form-section admin-insights-grid">
          {[
            { key: "working",      label: "What's working" },
            { key: "not_working",  label: "What's not working" },
            { key: "actions",      label: "Actions from this data" },
            { key: "next_quarter", label: "Next quarter focus" },
          ].map(s => (
            <Field key={s.key} label={s.label}>
              <textarea className="admin-textarea" rows={6} value={insights[s.key]}
                onChange={e => { setInsights(ins => ({ ...ins, [s.key]: e.target.value })); dirty(); }} />
            </Field>
          ))}
        </div>
      )}

      <SaveBar saving={saving} message={saveMsg} onSave={save} />
    </div>
  );
}
