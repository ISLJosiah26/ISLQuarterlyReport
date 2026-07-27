import React, { useState, useEffect, useRef, useCallback } from "react";
import { usePaidReport } from "../hooks/usePaidReport.js";
import { Delta } from "../components/Delta.jsx";
import { PageLoader } from "../components/PageLoader.jsx";
import { ErrorBoundary } from "../components/ErrorBoundary.jsx";
import { EmptyData } from "../components/EmptyState.jsx";
import { fmt, fmtExact, adSpend } from "../utils.js";
import { CountUp } from "../components/CountUp.jsx";
import { SectionRail } from "../components/SectionRail.jsx";

// ─── Formatters ───────────────────────────────────────────────────
const money0 = v => (v != null ? "$" + fmt(v) : "—");
const money2 = v => (v != null ? "$" + v.toFixed(2) : "—");
const pct    = v => (v != null ? v.toFixed(2) + "%" : "—");
const freq   = v => (v != null ? v.toFixed(2) + "×" : "—");

// Parse a Postgres `date` ("YYYY-MM-DD") as a local calendar day — building it
// from parts avoids the UTC-midnight shift that would drag the date backwards
// for viewers west of UTC. Mirrors parsePostDate on the Social page.
function parseDate(value) {
  if (!value) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value));
  const d = m ? new Date(+m[1], +m[2] - 1, +m[3]) : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function formatFlight(start, end) {
  const s = parseDate(start), e = parseDate(end);
  const opts = { month: "short", day: "numeric" };
  if (s && e) return `${s.toLocaleDateString(undefined, opts)} – ${e.toLocaleDateString(undefined, opts)}`;
  if (s) return `From ${s.toLocaleDateString(undefined, opts)}`;
  if (e) return `Until ${e.toLocaleDateString(undefined, opts)}`;
  return "";
}

// Ad "health" reads on click-through rate rather than engagement rate — CTR is
// the metric paid social is optimized against, and typical paid-social
// benchmarks (LinkedIn/Facebook) run far below organic engagement rates, so the
// thresholds here are tuned lower than the Social page's healthForPost.
function healthForAd(ad) {
  const impressions = ad.impressions;
  const clicks = ad.clicks;
  if (!impressions || impressions <= 0 || clicks == null) {
    return { label: "No data", color: "var(--ink-4)", ctr: null, hasData: false };
  }
  const ctr = (clicks / impressions) * 100;
  const label = ctr >= 2 ? "Very Strong" : ctr >= 1 ? "Strong" : ctr >= 0.5 ? "Moderate" : "Low";
  const color = ctr >= 2 ? "var(--accent)" : ctr >= 1 ? "var(--up)" : ctr >= 0.5 ? "#b87000" : "var(--down)";
  return { label, color, ctr, hasData: true };
}

const AD_STATUS_META = {
  active:    { label: "Active",    className: "is-active" },
  paused:    { label: "Paused",    className: "is-paused" },
  completed: { label: "Completed", className: "is-completed" },
  draft:     { label: "Draft",     className: "is-draft" },
};

function AdStatusTag({ status }) {
  const meta = AD_STATUS_META[status];
  if (!meta) return null;
  return <span className={"paid-media-status " + meta.className}>{meta.label}</span>;
}

// ─── Hero ─────────────────────────────────────────────────────────
function Hero({ data }) {
  const campaigns = data.campaigns.length;
  const parts = [];
  if (campaigns) parts.push(`${campaigns} campaign${campaigns === 1 ? "" : "s"}`);
  if (data.totals.spend != null) parts.push(`${money0(data.totals.spend)} invested`);
  if (data.totals.impressions != null) parts.push(`${fmt(data.totals.impressions)} impressions`);
  if (data.platforms.length) parts.push(data.platforms.join(" · "));
  const note = parts.join(" · ");

  return (
    <section className="hero wrap">
      <div className="hero-b-top">
        <div className="hero-b-left">
          <div className="hero-b-q serif">{data.meta.quarter}</div>
          <div className="hero-b-divider" />
          <div className="hero-b-meta">
            <div className="hero-b-meta-name">{data.meta.agencyName}</div>
            <div className="hero-b-meta-range">{data.meta.rangeLabel}</div>
          </div>
        </div>
        <div className="hero-b-type">Paid Media</div>
      </div>
      {note && <p className="hero-b-note">{note}</p>}
    </section>
  );
}

// ─── Campaign metrics ─────────────────────────────────────────────
// Every figure a campaign can show. Cost metrics invert their delta colour —
// a falling CPC is a win. The conversion family sits at the end and is off by
// default: the platforms don't always report conversions back, so those tiles
// read as an em dash until a campaign has the numbers to fill them.
const CAMPAIGN_METRICS = [
  { key: "spend",          label: "Spend",        fmt: money0,   note: "invested" },
  { key: "impressions",    label: "Impressions",  fmt: fmt,      note: "ad views served" },
  { key: "reach",          label: "Reach",        fmt: fmt,      note: "unique people reached" },
  { key: "clicks",         label: "Clicks",       fmt: fmtExact, note: "link + action clicks" },
  { key: "ctr",            label: "CTR",          fmt: pct,      note: "clicks per impression" },
  { key: "cpc",            label: "CPC",          fmt: money2,   note: "cost per click",             invert: true },
  { key: "cpm",            label: "CPM",          fmt: money2,   note: "cost per 1,000 impressions", invert: true },
  { key: "frequency",      label: "Frequency",    fmt: freq,     note: "views per person" },
  { key: "engagementRate", label: "Eng. Rate",    fmt: pct,      note: "engagements per impression" },
  { key: "conversions",    label: "Conversions",  fmt: fmtExact, note: "leads + actions taken" },
  { key: "conversionRate", label: "Conv. Rate",   fmt: pct,      note: "conversions per click" },
  { key: "cpa",            label: "Cost / Conv.", fmt: money2,   note: "cost per conversion",        invert: true },
];

const METRIC_BY_KEY = Object.fromEntries(CAMPAIGN_METRICS.map(m => [m.key, m]));
const DEFAULT_METRICS = ["spend", "impressions", "clicks", "ctr", "cpc", "cpm"];
const METRICS_STORAGE_PREFIX = "paidMetrics:v1:";

// Which metrics a campaign shows is a per-reader preference, so it lives in
// localStorage keyed by campaign rather than in the report itself. Storage can
// throw (Safari private browsing, disabled cookies) — a failure there just
// means the defaults come back next visit.
function readStoredMetrics(campaignId) {
  try {
    const raw = window.localStorage.getItem(METRICS_STORAGE_PREFIX + campaignId);
    if (!raw) return null;
    const keys = JSON.parse(raw).filter(k => METRIC_BY_KEY[k]);
    return keys.length ? keys : null;
  } catch {
    return null;
  }
}

function useCampaignMetrics(campaignId) {
  const [keys, setKeys] = useState(() => readStoredMetrics(campaignId) || DEFAULT_METRICS);

  const toggle = useCallback((key) => {
    setKeys(prev => {
      // Order follows CAMPAIGN_METRICS, not click order, so the grid keeps a
      // stable reading order however the reader picks them.
      const next = prev.includes(key)
        ? prev.filter(k => k !== key)
        : CAMPAIGN_METRICS.filter(m => m.key === key || prev.includes(m.key)).map(m => m.key);
      // Never leave the grid empty — the last remaining metric can't be unticked.
      if (!next.length) return prev;
      try {
        window.localStorage.setItem(METRICS_STORAGE_PREFIX + campaignId, JSON.stringify(next));
      } catch { /* preference simply won't persist */ }
      return next;
    });
  }, [campaignId]);

  const reset = useCallback(() => {
    setKeys(DEFAULT_METRICS);
    try {
      window.localStorage.removeItem(METRICS_STORAGE_PREFIX + campaignId);
    } catch { /* nothing stored to clear */ }
  }, [campaignId]);

  return { keys, toggle, reset };
}

// The full list is taller than the gap under a campaign header sitting low on
// screen, so on open the menu measures the room above and below its trigger,
// picks the roomier side, and caps its scroll area to what's actually there.
const MENU_MAX = 408;
const MENU_MIN = 180;
const MENU_GAP = 16;

function placeMenu(el) {
  if (!el || typeof window === "undefined") return { up: false, max: MENU_MAX };
  const rect = el.getBoundingClientRect();
  const below = window.innerHeight - rect.bottom - MENU_GAP;
  const above = rect.top - MENU_GAP;
  const up = below < Math.min(MENU_MAX, above);
  return { up, max: Math.max(MENU_MIN, Math.min(MENU_MAX, up ? above : below)) };
}

function MetricPicker({ selected, onToggle, onReset }) {
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState({ up: false, max: MENU_MAX });
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const reposition = () => setPlacement(placeMenu(ref.current));
    reposition();
    const onPointerDown = e => { if (!ref.current?.contains(e.target)) setOpen(false); };
    const onKeyDown = e => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", reposition);
    // Capture phase: the scroll that matters may be on an ancestor, not window.
    window.addEventListener("scroll", reposition, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
  }, [open]);

  const isLast = selected.length === 1;

  return (
    <div className="metric-picker" ref={ref}>
      <button
        type="button"
        className={"metric-picker-btn" + (open ? " is-open" : "")}
        aria-expanded={open}
        aria-haspopup="true"
        onClick={() => setOpen(o => !o)}
      >
        Metrics <span className="metric-picker-count num">{selected.length}</span>
      </button>
      {open && (
        <div
          className={"metric-picker-menu" + (placement.up ? " is-up" : "")}
          role="group"
          aria-label="Choose which metrics to show"
        >
          <div className="metric-picker-menu-head">
            <span>Show</span>
            <button type="button" className="metric-picker-reset" onClick={onReset}>Reset</button>
          </div>
          <div className="metric-picker-list" style={{ "--menu-max": `${placement.max}px` }}>
            {CAMPAIGN_METRICS.map(m => {
              const checked = selected.includes(m.key);
              return (
                <label
                  key={m.key}
                  className={"metric-picker-item" + (checked && isLast ? " is-locked" : "")}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={checked && isLast}
                    onChange={() => onToggle(m.key)}
                  />
                  <span className="metric-picker-item-label">{m.label}</span>
                  <span className="metric-picker-item-note">{m.note}</span>
                </label>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function MetricGrid({ metricKeys, totals, deltas }) {
  return (
    <div className="campaign-kpi-grid">
      {metricKeys.map((key, i) => {
        const m = METRIC_BY_KEY[key];
        if (!m) return null;
        return (
          <div className="campaign-kpi" key={key} style={{ "--i": i }}>
            <div className="campaign-kpi-label">{m.label}</div>
            <div className="campaign-kpi-value num"><CountUp value={totals[key]} format={m.fmt} /></div>
            <div className="campaign-kpi-foot">
              <Delta d={deltas?.[key]} invertGood={!!m.invert} />
              <span className="delta-note">{m.note}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── Audience (LinkedIn demographics) ─────────────────────────────
// How many segments to show before the rest fold behind "show more".
const AUDIENCE_VISIBLE = 8;

// Splits a panel into the named segments and the combined tail. The tail is a
// remainder, not a rival: it's kept out of the ranked rows, the "show more"
// count and the bar scale, and drawn apart at the foot of the panel.
function splitSegments(panel, expanded) {
  const named = panel.segments.filter(s => !s.isOther);
  return {
    other: panel.segments.find(s => s.isOther),
    shown: expanded ? named : named.slice(0, AUDIENCE_VISIBLE),
    total: named.length,
  };
}

function ShowMore({ hidden, expanded, total, onExpand, onCollapse }) {
  if (hidden > 0) return <button className="aud-more" onClick={onExpand}>Show {hidden} more</button>;
  if (expanded && total > AUDIENCE_VISIBLE) return <button className="aud-more" onClick={onCollapse}>Show less</button>;
  return null;
}

// ── Distribution: a handful of segments that partition the audience ──
// One bar per row, drawn against the full track so its length matches the
// percentage printed beside it. CTR rides along as a plain figure — as a
// second meter it competed with the share bar for attention and neither won.
function AudienceBars({ panel, expanded, setExpanded }) {
  const { shown, other, total } = splitSegments(panel, expanded);
  return (
    <div className="aud-panel">
      <div className="aud-panel-head">
        <h4 className="aud-panel-title serif">{panel.label}</h4>
        <div className="aud-panel-cols">
          <span>Share of impressions</span>
          <span>CTR</span>
        </div>
      </div>
      <div className="aud-rows">
        {[...shown, ...(other ? [other] : [])].map(seg => (
          <div className={"aud-row" + (seg.isOther ? " aud-row--other" : "")} key={seg.name}>
            <span className="aud-label" title={seg.name}>{seg.name}</span>
            <span className="aud-share-track">
              <span className="aud-share-fill" style={{ width: `${Math.max(1.5, seg.share ?? 0)}%` }} />
            </span>
            <span className="aud-share-val num">{seg.share != null ? seg.share.toFixed(1) + "%" : "—"}</span>
            <span className="aud-ctr-val num">{seg.ctr != null ? seg.ctr.toFixed(2) + "%" : "—"}</span>
          </div>
        ))}
      </div>
      <ShowMore hidden={total - shown.length} expanded={expanded} total={total}
        onExpand={() => setExpanded(true)} onCollapse={() => setExpanded(false)} />
    </div>
  );
}

// ── Roster: named accounts, ranked by the clicks they gave us ──
// A table rather than bars. Ranking by clicks while showing only share and CTR
// left the order looking arbitrary, so clicks get a column of their own and
// the ranking reads straight down it.
//
// CTR is a plain figure here for a reason: at these volumes it's mostly noise
// (10 clicks on 13 impressions is 77%), and as a scaled meter it made the
// smallest accounts look like the strongest.
function AudienceRoster({ panel, expanded, setExpanded }) {
  const { shown, other, total } = splitSegments(panel, expanded);
  return (
    <div className="aud-panel aud-panel--wide">
      <div className="aud-panel-head">
        <h4 className="aud-panel-title serif">{panel.label}</h4>
        <span className="aud-panel-note">Ranked by clicks</span>
      </div>
      <div className="table-wrap">
        <table className="table aud-table">
          <thead>
            <tr>
              {/* The panel heading already names the dimension — repeating it
                  as a column header just reads as a stutter. */}
              <th scope="col"><span className="sr-only">{panel.label}</span></th>
              <th scope="col" className="r">Impressions</th>
              <th scope="col" className="r">Clicks</th>
              <th scope="col" className="r">CTR</th>
            </tr>
          </thead>
          <tbody>
            {shown.map(seg => (
              <tr key={seg.name}>
                <th scope="row"><span className="aud-table-name" title={seg.name}>{seg.name}</span></th>
                <td className="r num">{fmtExact(seg.impressions)}</td>
                <td className="r num">{seg.clicks ? fmtExact(seg.clicks) : "—"}</td>
                <td className="r num">{seg.ctr != null ? seg.ctr.toFixed(2) + "%" : "—"}</td>
              </tr>
            ))}
          </tbody>
          {other && (
            <tfoot>
              <tr className="aud-table-other">
                <th scope="row">{other.name}</th>
                <td className="r num">{fmtExact(other.impressions)}</td>
                <td className="r num">{other.clicks ? fmtExact(other.clicks) : "—"}</td>
                <td className="r num">{other.ctr != null ? other.ctr.toFixed(2) + "%" : "—"}</td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>
      <ShowMore hidden={total - shown.length} expanded={expanded} total={total}
        onExpand={() => setExpanded(true)} onCollapse={() => setExpanded(false)} />
    </div>
  );
}

function AudiencePanel({ panel }) {
  const [expanded, setExpanded] = useState(false);
  const Layout = panel.layout === "list" ? AudienceRoster : AudienceBars;
  return <Layout panel={panel} expanded={expanded} setExpanded={setExpanded} />;
}

function AudienceBlock({ panels, title }) {
  return (
    <div className="campaign-audience">
      <div className="campaign-block-head">
        <h3 className="campaign-block-title serif">{title}</h3>
      </div>
      <div className="aud-panels">
        {panels.map(panel => <AudiencePanel key={panel.dimension} panel={panel} />)}
      </div>
    </div>
  );
}

// ─── Campaign ─────────────────────────────────────────────────────
function Budget({ budget, spent }) {
  if (budget == null || budget <= 0) return null;
  const used = spent != null ? (spent / budget) * 100 : null;
  const over = used != null && used > 100;
  return (
    <div className="paid-budget">
      <div className="paid-budget-track">
        <div
          className={"paid-budget-fill" + (over ? " is-over" : "")}
          style={{ width: `${Math.min(100, Math.max(0, used ?? 0))}%` }}
        />
      </div>
      <div className="paid-budget-foot">
        <span><strong className="num">{money0(spent)}</strong> spent of <span className="num">{money0(budget)}</span></span>
        <span className="num">{used != null ? Math.round(used) + "% of budget" : "—"}</span>
      </div>
    </div>
  );
}

function AdsTable({ ads, totals }) {
  return (
    <div className="table-wrap">
      <table className="table table--wide">
        <thead>
          <tr>
            <th scope="col">Ad</th>
            <th scope="col" className="r">Impressions</th>
            <th scope="col" className="r">Reach</th>
            <th scope="col" className="r">Clicks</th>
            <th scope="col" className="r">CTR</th>
            <th scope="col" className="r">Spend</th>
            <th scope="col" className="r">CPC</th>
            <th scope="col" className="r">Eng. Rate</th>
            <th scope="col" className="health-col">Health</th>
          </tr>
        </thead>
        <tbody>
          {ads.map(ad => {
            const { label, color, ctr, hasData } = healthForAd(ad);
            return (
              <tr key={ad.id}>
                <td>
                  <span className="campaign-name serif">{ad.name || "Untitled ad"}</span>
                  <AdStatusTag status={ad.status} />
                </td>
                <td className="r num">{fmtExact(ad.impressions)}</td>
                <td className="r num">{fmtExact(ad.reach)}</td>
                <td className="r num">{fmtExact(ad.clicks)}</td>
                <td className="r num">{hasData ? ctr.toFixed(2) + "%" : "—"}</td>
                <td className="r num">{money2(adSpend(ad))}</td>
                <td className="r num">{ad.cpc != null ? "$" + ad.cpc.toFixed(2) : "—"}</td>
                <td className="r num">{ad.engagementRate != null ? ad.engagementRate.toFixed(2) + "%" : "—"}</td>
                <td className="health-col"><span className="health-label" style={{ color }}>{label}</span></td>
              </tr>
            );
          })}
        </tbody>
        <tfoot>
          <tr className="paid-media-totals-row">
            <td>Campaign total</td>
            <td className="r num">{fmtExact(totals.impressions)}</td>
            <td className="r num">{fmtExact(totals.reach)}</td>
            <td className="r num">{fmtExact(totals.clicks)}</td>
            <td className="r num">{pct(totals.ctr)}</td>
            <td className="r num">{money2(totals.spend)}</td>
            <td className="r num">{money2(totals.cpc)}</td>
            <td className="r num">{pct(totals.engagementRate)}</td>
            <td className="health-col" />
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

// A collapsed campaign still has to be worth scanning, so the header carries
// the three figures that answer "how did this one do?" without opening it.
function CampaignSummary({ totals }) {
  const chips = [
    { label: "Spend", value: money0(totals.spend) },
    { label: "Impressions", value: fmt(totals.impressions) },
    { label: "CTR", value: pct(totals.ctr) },
  ];
  return (
    <div className="campaign-summary">
      {chips.map(c => (
        <span className="campaign-summary-chip" key={c.label}>
          <span className="campaign-summary-label">{c.label}</span>
          <span className="campaign-summary-value num">{c.value}</span>
        </span>
      ))}
    </div>
  );
}

function Campaign({ c, index, open, onToggle }) {
  const t = c.totals;
  const flight = formatFlight(c.startDate, c.endDate);
  const { keys, toggle, reset } = useCampaignMetrics(c.id);
  const bodyId = `campaign-body-${index}`;

  return (
    <section id={`campaign-${index}`} className={"paid-campaign" + (open ? " is-open" : "")}>
      <div className="paid-campaign-head">
        <button
          type="button"
          className="campaign-toggle"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={onToggle}
        >
          <span className="campaign-toggle-chevron" aria-hidden="true" />
          <span className="campaign-toggle-text">
            <h2 className="paid-campaign-name serif">{c.name || "Untitled campaign"}</h2>
            <span className="paid-campaign-tags">
              {c.platform && <span className="paid-tag paid-tag--platform">{c.platform}</span>}
              {c.objective && <span className="paid-tag">{c.objective}</span>}
              {flight && <span className="paid-tag paid-tag--muted">{flight}</span>}
            </span>
          </span>
        </button>
        <CampaignSummary totals={t} />
      </div>

      <div className="paid-campaign-body" id={bodyId} hidden={!open}>
        {open && (
          <>
            <div className="campaign-metrics-bar">
              <h3 className="campaign-block-title serif">Performance</h3>
              <MetricPicker selected={keys} onToggle={toggle} onReset={reset} />
            </div>
            <MetricGrid metricKeys={keys} totals={t} deltas={c.deltas} />

            <Budget budget={c.budget} spent={t.spend} />

            {c.ads.length === 0 ? (
              <EmptyData label="No ads added to this campaign yet." />
            ) : (
              <div className="campaign-ads">
                <h3 className="campaign-block-title serif">Ads</h3>
                <AdsTable ads={c.ads} totals={t} />
              </div>
            )}

            {c.audience.length > 0 && (
              <AudienceBlock panels={c.audience} title="Who this campaign reached" />
            )}
          </>
        )}
      </div>
    </section>
  );
}

// ─── Page ─────────────────────────────────────────────────────────
// Truncate long campaign names for the section rail, which is a narrow column.
const railLabel = (name, i) => {
  const label = name?.trim() || `Campaign ${i + 1}`;
  return label.length > 24 ? label.slice(0, 23).trimEnd() + "…" : label;
};

export function PaidPage({ agency, quarter, onReady }) {
  const [retryKey, setRetryKey] = useState(0);
  const { data, status, error } = usePaidReport(agency, quarter, retryKey);
  // The first campaign opens by default so the page never lands as a wall of
  // closed rows; the rest are opened on demand.
  const [openIds, setOpenIds] = useState(null);

  useEffect(() => {
    if (status === "ready" || status === "error") onReady?.();
  }, [status, onReady]);

  // Reset the open/closed state when the reader switches quarter or agency —
  // the campaign ids underneath have changed entirely.
  useEffect(() => { setOpenIds(null); }, [agency, quarter]);

  if (status === "error") {
    return (
      <main className="report-wrap">
        <section className="section wrap">
          <header className="section-head"><h2 className="section-title serif">Unable to load <em>report</em></h2></header>
          <div className="error-section" role="alert">
            <p>{error}</p>
            <button className="error-retry-btn" onClick={() => setRetryKey(k => k + 1)}>Try again</button>
          </div>
        </section>
      </main>
    );
  }

  if (status === "ready" && !data) {
    return (
      <main className="report-wrap">
        <section className="section wrap">
          <header className="section-head"><h2 className="section-title serif">Nothing here <em>yet</em></h2></header>
          <div className="error-section">
            <p>This report hasn’t been published for the selected quarter. Choose another quarter from the menu above, or check back soon.</p>
          </div>
        </section>
      </main>
    );
  }

  if (!data) return <PageLoader view="paid" />;

  const campaigns = data.campaigns;
  const hasCampaigns = campaigns.length > 0;
  // Demographics imported before breakdowns were campaign-scoped have no
  // campaign to sit under, so they keep their own section at the foot.
  const showAccountAudience = data.audience.length > 0;

  const defaultOpen = hasCampaigns ? [campaigns[0].id] : [];
  const open = openIds ?? defaultOpen;
  const isOpen = id => open.includes(id);
  const toggle = id => setOpenIds(ids => {
    const cur = ids ?? defaultOpen;
    return cur.includes(id) ? cur.filter(x => x !== id) : [...cur, id];
  });
  const allOpen = hasCampaigns && open.length === campaigns.length;

  const sections = [
    ...campaigns.map((c, i) => ({ id: `campaign-${i}`, label: railLabel(c.name, i) })),
    ...(showAccountAudience ? [{ id: "audience", label: "Who We Reached" }] : []),
  ];

  return (
    <main className="report-wrap">
      <SectionRail sections={sections} />
      <ErrorBoundary><Hero data={data} /></ErrorBoundary>
      {data.hasData ? (
        <>
          {hasCampaigns && (
            <ErrorBoundary>
              <section className="section wrap">
                <header className="section-head section-head--split">
                  <h2 className="section-title serif"><em>Campaigns</em></h2>
                  {campaigns.length > 1 && (
                    <button
                      type="button"
                      className="campaign-expand-all"
                      onClick={() => setOpenIds(allOpen ? [] : campaigns.map(c => c.id))}
                    >
                      {allOpen ? "Collapse all" : "Expand all"}
                    </button>
                  )}
                </header>
                <div className="paid-media-campaigns">
                  {campaigns.map((c, i) => (
                    <Campaign
                      key={c.id}
                      c={c}
                      index={i}
                      open={isOpen(c.id)}
                      onToggle={() => toggle(c.id)}
                    />
                  ))}
                </div>
              </section>
            </ErrorBoundary>
          )}
          {showAccountAudience && (
            <ErrorBoundary>
              <section id="audience" className="section wrap">
                <header className="section-head">
                  <h2 className="section-title serif">Who We <em>Reached</em></h2>
                </header>
                <AudienceBlock panels={data.audience} title="Across all campaigns" />
              </section>
            </ErrorBoundary>
          )}
        </>
      ) : (
        <section className="section wrap">
          <header className="section-head">
            <h2 className="section-title serif">Paid <em>Media</em></h2>
          </header>
          <EmptyData label="No paid media campaigns recorded this quarter." />
        </section>
      )}
    </main>
  );
}
