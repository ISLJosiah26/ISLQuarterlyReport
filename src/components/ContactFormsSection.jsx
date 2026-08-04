import React, { useMemo, useState } from "react";
import { QUARTERS } from "../config.js";
import { fmtInt, calcAutoDelta, FLAT } from "../utils.js";
import { buildSourceTrend, findSourceSpike } from "../lib/sourceTrends.js";
import { CountUp } from "./CountUp.jsx";
import { Delta } from "./Delta.jsx";

const WORK  = "var(--chart-work)";
const STAFF = "var(--chart-staff)";

const parseDay = s => {
  const [y, m, d] = String(s).split("-").map(Number);
  return new Date(y, m - 1, d);
};
const dayLabel = d => d.toLocaleDateString("en-CA", { month: "short", day: "numeric" });
const longDay  = d => d.toLocaleDateString("en-CA", { month: "long", day: "numeric", year: "numeric" });

function mondayOf(date) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d;
}

const weekKey = d =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

// Continuous Monday-keyed weeks across the quarter (up to today for the
// current quarter), zero-filled where the stats have no bucket, so quiet
// weeks show as quiet instead of vanishing from the x-axis.
function fillWeeks(weekly, q) {
  const byKey = {};
  for (const w of weekly || []) byKey[w.week] = w;
  const out = [];
  const stop = Math.min(Date.now(), q.end.getTime() - 1);
  for (let m = mondayOf(q.start); m.getTime() <= stop; m.setDate(m.getDate() + 7)) {
    const key = weekKey(m);
    const w = byKey[key] || {};
    out.push({ date: new Date(m), key, work: w.work || 0, staff: w.staff || 0, total: w.total || 0 });
  }
  return out;
}

function weeksElapsed(q) {
  const end = Math.min(Date.now(), q.end.getTime());
  return Math.max((end - q.start.getTime()) / (7 * 86400000), 1);
}

// ─── Weekly trend ─────────────────────────────────────────────────
const SERIES = [
  { key: "work",  name: "Job seekers",    color: WORK },
  { key: "staff", name: "Employer leads", color: STAFF },
];

function WeeklyChart({ weeks }) {
  const [hover, setHover] = useState(null);
  const W = 1100, H = 300, pL = 44, pR = 110, pT = 24, pB = 36;
  const series = SERIES;

  const rawMax = Math.max(1, ...weeks.flatMap(w => series.map(s => w[s.key])));
  const max    = rawMax * 1.15;
  const xStep  = (W - pL - pR) / Math.max(weeks.length - 1, 1);
  const x = i => pL + i * xStep;
  const y = v => pT + (H - pT - pB) * (1 - v / max);
  const ticks = [0, 0.5, 1].map(t => ({ v: Math.round(max * t), y: y(max * t) }));
  // Thin the x-axis labels so long quarters don't collide
  const labelEvery = weeks.length > 8 ? Math.ceil(weeks.length / 7) : 1;

  const onMove = e => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    const i = Math.min(weeks.length - 1, Math.max(0, Math.round((px - pL) / xStep)));
    setHover(i);
  };

  return (
    <div className="cf-chart-wrap">
      <div className="cf-chart-area">
        <svg className="cf-chart-svg" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet"
          role="img" aria-label="Contact form submissions week by week — job seekers vs employer leads"
          onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
          {ticks.map((t, i) => (
            <g key={i}>
              <line x1={pL} x2={W - pR} y1={t.y} y2={t.y} stroke="var(--rule-soft)" strokeWidth="1" />
              <text x={pL - 8} y={t.y + 4} textAnchor="end" fontSize="11" fill="var(--ink-4)" fontFamily="var(--sans)">{t.v}</text>
            </g>
          ))}
          <line x1={pL} x2={W - pR} y1={H - pB} y2={H - pB} stroke="var(--ink)" strokeWidth="1" />
          {weeks.map((w, i) => (i % labelEvery === 0 || i === weeks.length - 1) && (
            <text key={i} x={x(i)} y={H - pB + 18} textAnchor="middle" fontSize="11" fill="var(--ink-3)" fontFamily="var(--sans)">
              {dayLabel(w.date)}
            </text>
          ))}
          {hover != null && (
            <line x1={x(hover)} x2={x(hover)} y1={pT} y2={H - pB} stroke="var(--rule)" strokeWidth="1" />
          )}
          {(() => {
            const last = weeks.length - 1;
            // Nudge the end-of-line labels apart when the lines converge
            const labelYs = series.map(s => y(weeks[last][s.key]));
            if (labelYs.length === 2 && Math.abs(labelYs[0] - labelYs[1]) < 16) {
              const shift = (16 - Math.abs(labelYs[0] - labelYs[1])) / 2;
              const topFirst = labelYs[0] <= labelYs[1];
              labelYs[0] += topFirst ? -shift : shift;
              labelYs[1] += topFirst ? shift : -shift;
            }
            return series.map((s, si) => {
            const path = weeks.map((w, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(w[s.key]).toFixed(1)}`).join(" ");
            return (
              <g key={s.key}>
                <path d={path} fill="none" stroke={s.color} strokeWidth="2" strokeLinejoin="round" />
                {/* Direct label at the line's end — identity never rides on color alone */}
                <circle cx={x(last)} cy={y(weeks[last][s.key])} r="3.5" fill="var(--paper)" stroke={s.color} strokeWidth="2" />
                <text x={x(last) + 10} y={labelYs[si] + 4} fontSize="12" fontFamily="var(--sans)" fill="var(--ink-2)">
                  {s.name}
                </text>
                {hover != null && (
                  <circle cx={x(hover)} cy={y(weeks[hover][s.key])} r="4.5" fill="var(--paper)" stroke={s.color} strokeWidth="2" />
                )}
              </g>
            );
            });
          })()}
        </svg>
        {hover != null && (
          <div className="cf-tooltip" style={{ left: `${(x(hover) / W) * 100}%` }}>
            <div className="cf-tooltip-title">Week of {dayLabel(weeks[hover].date)}</div>
            {series.map(s => (
              <div className="cf-tooltip-row" key={s.key}>
                <span className="cf-dot" style={{ background: s.color }} />
                {s.name} <strong>{fmtInt(weeks[hover][s.key])}</strong>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="trend-legend" aria-hidden="true">
        {series.map(s => (
          <span className="legend-item" key={s.key} style={{ cursor: "default" }}>
            <span className="swatch" style={{ background: s.color }} />
            {s.name}
            <span className="v num">{fmtInt(weeks.reduce((a, w) => a + w[s.key], 0))}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

// ─── Horizontal bar lists (locations, sources) ────────────────────
function BarRow({ label, total, max, segments, title }) {
  return (
    <div className="cf-bar-row" title={title}>
      <span className="cf-bar-label">{label}</span>
      <span className="cf-bar-track">
        {segments.map((s, i) => s.value > 0 && (
          <span key={i} className="cf-bar-seg"
            style={{ width: `${(s.value / max) * 100}%`, background: s.color }} />
        ))}
      </span>
      <span className="cf-bar-value num">{fmtInt(total)}</span>
    </div>
  );
}

function Locations({ locations }) {
  if (!locations?.length) return null;
  const max = Math.max(...locations.map(l => l.total));
  return (
    <div className="cf-panel">
      <h3 className="cf-panel-title serif">By branch</h3>
      <div className="cf-bars">
        {locations.map(l => (
          <BarRow key={l.location} label={l.location} total={l.total} max={max}
            title={`${l.location} — ${fmtInt(l.work)} job seeker${l.work === 1 ? "" : "s"}, ${fmtInt(l.staff)} employer lead${l.staff === 1 ? "" : "s"}`}
            segments={[{ value: l.work, color: WORK }, { value: l.staff, color: STAFF }]} />
        ))}
      </div>
    </div>
  );
}

function Sources({ sources, sourceSince, sourceEligible, q }) {
  if (!sources?.length) return null;
  const answered = sources.reduce((a, s) => a + s.count, 0);
  const max = Math.max(...sources.map(s => s.count));
  // The question was added to the form mid-stream — note the coverage window
  // instead of letting early submissions read as non-responses.
  const since = sourceSince ? parseDay(sourceSince) : null;
  const partial = since && since.getTime() > q.start.getTime();
  return (
    <div className="cf-panel">
      <h3 className="cf-panel-title serif">How they heard about us</h3>
      <div className="cf-bars">
        {sources.map(s => (
          <BarRow key={s.source} label={s.source} total={s.count} max={max}
            title={`${s.source} — ${fmtInt(s.count)} of ${fmtInt(answered)} (${Math.round((s.count / answered) * 100)}%)`}
            segments={[{ value: s.count, color: WORK }]} />
        ))}
      </div>
      <p className="cf-note">
        {partial
          ? `The form began asking this on ${longDay(since)} — based on the ${fmtInt(sourceEligible)} submissions since.`
          : `Based on ${fmtInt(answered)} responses.`}
      </p>
    </div>
  );
}

// ─── "How they heard about us" week by week ───────────────────────
// One mini bar chart per answer, stacked on a shared week axis: a week that
// spikes lines up across every row, so it's obvious whether one answer moved
// or the whole quarter did.
const clipLabel = s => (s.length > 30 ? s.slice(0, 29) + "…" : s);
const fmtTypical = n => (n % 1 ? n.toFixed(1) : String(n));

function SourceTrend({ sources, sourceWeekly, sourceSince, weeks }) {
  const [hover, setHover] = useState(null);
  // Per-answer scaling by default: the question this panel answers is "did any
  // one answer jump", and a shared scale hides that under the biggest answer.
  const [ownScale, setOwnScale] = useState(true);

  const { rows, max, coveredFrom } = useMemo(() => buildSourceTrend({
    sourceWeekly,
    sources,
    weekKeys: weeks.map(w => w.key),
    since: sourceSince,
  }), [sourceWeekly, sources, sourceSince, weeks]);

  const spike = useMemo(() => findSourceSpike(rows, coveredFrom), [rows, coveredFrom]);

  // Two answers over three weeks is a table, not a trend. A payload from
  // before the breakdown existed has no sourceWeekly at all — stay off the page.
  if (!sourceWeekly?.length || rows.length < 2 || weeks.length - coveredFrom < 3) return null;

  const W = 1100, pL = 210, pR = 52, pT = 10, pB = 30;
  // Rows need real height: on the shared scale one big answer sets the ceiling,
  // and at 22px everything below it collapses into a dash.
  const rh = 32, pitch = 44;
  const plotBottom = pT + (rows.length - 1) * pitch + rh;
  const H = plotBottom + pB;
  const colStep = (W - pL - pR) / weeks.length;
  const barW = Math.min(12, colStep - 6);
  const cx = i => pL + colStep * (i + 0.5);
  const baseY = r => pT + r * pitch + rh;
  const labelEvery = weeks.length > 10 ? Math.ceil(weeks.length / 7) : 1;

  const onMove = e => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    const i = Math.floor((px - pL) / colStep);
    setHover(i >= 0 && i < weeks.length ? i : null);
  };

  const hovered = hover != null
    ? rows.map(r => ({ source: r.source, count: r.values[hover] }))
        .filter(r => r.count > 0)
        .sort((a, b) => b.count - a.count)
    : [];

  // Sit the tooltip beside the hovered week rather than over it — with this
  // many rows a centred card would cover the column being read. It flips to
  // the near side once past the midpoint so it never leaves the panel.
  const tooltipStyle = i => {
    const left = (cx(i) / W) * 100;
    return {
      left: `${left}%`,
      transform: left > 50 ? "translateX(calc(-100% - 14px))" : "translateX(14px)",
    };
  };

  return (
    <div className="cf-panel cf-panel--wide cf-trend">
      <div className="cf-panel-head">
        <h3 className="cf-panel-title serif">How they heard about us, week by week</h3>
        <div className="view-toggle" role="group" aria-label="Bar scale">
          <button type="button" className={`toggle-btn${ownScale ? " is-active" : ""}`}
            aria-pressed={ownScale} onClick={() => setOwnScale(true)}>Per answer</button>
          <button type="button" className={`toggle-btn${ownScale ? "" : " is-active"}`}
            aria-pressed={!ownScale} onClick={() => setOwnScale(false)}>Shared scale</button>
        </div>
      </div>

      <div className="cf-trend-scroll">
        <div className="cf-chart-area">
          <svg className="cf-chart-svg" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet"
            role="img"
            aria-label={`Weekly count for each "how did you hear about us" answer across the quarter${spike ? `. ${spike.source} peaks at ${spike.count} in the week of ${dayLabel(weeks[spike.at].date)}` : ""}`}
            onMouseMove={onMove} onMouseLeave={() => setHover(null)}>

            {/* Weeks before the question existed — blank by design, not by silence */}
            {coveredFrom > 0 && (
              <g>
                <rect x={pL} y={pT - 4} width={colStep * coveredFrom} height={plotBottom - pT + 8}
                  fill="var(--paper-2)" />
                <text x={pL + (colStep * coveredFrom) / 2} y={plotBottom + 18} textAnchor="middle"
                  fontSize="10" fill="var(--ink-4)" fontFamily="var(--sans)">not asked yet</text>
              </g>
            )}

            {hover != null && (
              <rect x={pL + colStep * hover} y={pT - 4} width={colStep} height={plotBottom - pT + 8}
                fill="var(--rule-soft)" />
            )}

            {rows.map((row, r) => {
              const scale = ownScale ? Math.max(1, row.peak) : max;
              return (
                <g key={row.source}>
                  <text x={pL - 12} y={baseY(r) - 5} textAnchor="end" fontSize="12"
                    fill="var(--ink-2)" fontFamily="var(--sans)">{clipLabel(row.source)}</text>
                  <line x1={pL} x2={W - pR} y1={baseY(r) + 0.5} y2={baseY(r) + 0.5}
                    stroke="var(--rule-soft)" strokeWidth="1" />
                  {row.values.map((v, i) => {
                    if (v <= 0 || i < coveredFrom) return null;
                    const h = Math.max(2, (v / scale) * rh);
                    return (
                      <rect key={i} x={cx(i) - barW / 2} y={baseY(r) - h} width={barW} height={h}
                        rx={Math.min(3, barW / 2)} fill={WORK}
                        opacity={hover == null || hover === i ? 1 : 0.35} />
                    );
                  })}
                  <text x={W - 4} y={baseY(r) - 5} textAnchor="end" fontSize="12"
                    fill="var(--ink-3)" fontFamily="var(--sans)"
                    style={{ fontVariantNumeric: "tabular-nums" }}>{fmtInt(row.total)}</text>
                </g>
              );
            })}

            {weeks.map((w, i) => (i % labelEvery === 0 || i === weeks.length - 1) && (
              <text key={i} x={cx(i)} y={plotBottom + 18} textAnchor="middle" fontSize="11"
                fill="var(--ink-3)" fontFamily="var(--sans)">{dayLabel(w.date)}</text>
            ))}
          </svg>

          {hover != null && (
            <div className="cf-tooltip" style={tooltipStyle(hover)}>
              <div className="cf-tooltip-title">Week of {dayLabel(weeks[hover].date)}</div>
              {hover < coveredFrom
                ? <div className="cf-tooltip-row">Question not on the form yet</div>
                : hovered.length === 0
                  ? <div className="cf-tooltip-row">No answers</div>
                  : hovered.map(h => (
                      // No swatch — every row is the same hue here, so a dot
                      // would imply a colour key that doesn't exist.
                      <div className="cf-tooltip-row" key={h.source}>
                        {clipLabel(h.source)} <strong>{fmtInt(h.count)}</strong>
                      </div>
                    ))}
            </div>
          )}
        </div>
      </div>

      <p className="cf-note">
        {ownScale
          ? "Each answer is scaled to its own best week, so a jump in a small answer is still visible — heights don't compare between rows."
          : "Every answer shares one scale, so bar heights compare directly from row to row. Switch to Per answer to see the shape of the quieter ones."}
        {spike && ` Sharpest move: ${spike.source} at ${fmtInt(spike.count)} in the week of ${dayLabel(weeks[spike.at].date)}${spike.typical > 0 ? `, against a typical ${fmtTypical(spike.typical)} a week` : ", from a standing start"}.`}
      </p>
    </div>
  );
}

// ─── Day × hour heatmap ───────────────────────────────────────────
const DOW_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const hourLabel = h => (h % 12 === 0 ? 12 : h % 12) + (h < 12 ? " AM" : " PM");

function Heatmap({ heatmap }) {
  if (!heatmap?.length) return null;
  const counts = Array.from({ length: 7 }, () => Array(24).fill(0));
  for (const c of heatmap) counts[c.dow - 1][c.hour] = c.count;
  const max = Math.max(...heatmap.map(c => c.count));

  const cw = 40, ch = 24, gap = 3, pL = 44, pT = 8, pB = 26;
  const W = pL + 24 * (cw + gap);
  const H = pT + 7 * (ch + gap) + pB;

  return (
    <div className="cf-panel cf-panel--wide">
      <h3 className="cf-panel-title serif">When submissions arrive</h3>
      <svg className="cf-heatmap-svg" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet"
        role="img" aria-label="Submissions by day of week and hour of day">
        {DOW_LABELS.map((d, r) => (
          <text key={d} x={pL - 10} y={pT + r * (ch + gap) + ch / 2 + 4} textAnchor="end"
            fontSize="11" fill="var(--ink-3)" fontFamily="var(--sans)">{d}</text>
        ))}
        {[0, 6, 12, 18].map(h => (
          <text key={h} x={pL + h * (cw + gap)} y={H - 8} textAnchor="start"
            fontSize="11" fill="var(--ink-4)" fontFamily="var(--sans)">{hourLabel(h)}</text>
        ))}
        {counts.map((row, r) => row.map((n, h) => (
          <rect key={r + "-" + h}
            x={pL + h * (cw + gap)} y={pT + r * (ch + gap)} width={cw} height={ch} rx="3"
            fill={n === 0 ? "var(--paper-2)" : `color-mix(in srgb, var(--chart-work) ${Math.round(15 + 85 * (n / max))}%, var(--paper))`}>
            <title>{`${DOW_LABELS[r]} ${hourLabel(h)}–${hourLabel((h + 1) % 24)} — ${n} submission${n === 1 ? "" : "s"}`}</title>
          </rect>
        )))}
      </svg>
      <p className="cf-note">Halifax time. Darker cells are busier hours — hover any cell for the count.</p>
    </div>
  );
}

// ─── Section ──────────────────────────────────────────────────────
export function ContactFormsSection({ stats, prevStats, quarter }) {
  const q = QUARTERS.find(q => q.suffix === quarter);
  const t = stats?.totals;

  const weeks = useMemo(() => (t?.total > 0 && q ? fillWeeks(stats.weekly, q) : []), [stats, q, t]);

  if (!q || !t || t.total === 0) return null;

  const p = prevStats?.totals;
  const perWeek     = t.total / weeksElapsed(q);
  const prevPerWeek = p?.total ? p.total / 13 : null;

  const kpis = [
    { label: "Total Submissions", value: t.total,  prev: p?.total, fmt: fmtInt, note: "contact forms this quarter" },
    { label: "Job Seekers",       value: t.work,   prev: p?.work,  fmt: fmtInt, note: "people looking for work" },
    { label: "Employer Leads",    value: t.staff,  prev: p?.staff, fmt: fmtInt, note: "businesses looking for staff" },
    { label: "Per Week",          value: perWeek,  prev: prevPerWeek, fmt: n => (typeof n === "number" ? n.toFixed(1) : "—"), note: "average weekly volume" },
  ];

  return (
    <section id="contact-forms" className="section wrap">
      <header className="section-head">
        <h2 className="section-title serif">Contact <em>Forms</em></h2>
      </header>

      <div className="kpi-grid cf-kpi-grid">
        {kpis.map((k, i) => (
          <div className="kpi" key={k.label} style={{ "--i": i }}>
            <div className="kpi-label">{k.label}</div>
            <div className="kpi-value num"><CountUp value={k.value} format={k.fmt} /></div>
            <div className="kpi-foot">
              <Delta d={calcAutoDelta(k.value, k.prev) || FLAT} />
              <span className="delta-note">{k.note}</span>
            </div>
          </div>
        ))}
      </div>

      {weeks.length > 1 && <WeeklyChart weeks={weeks} />}

      <div className="cf-panels">
        <Locations locations={stats.locations} />
        <Sources sources={stats.sources} sourceSince={stats.sourceSince}
          sourceEligible={stats.sourceEligible} q={q} />
      </div>

      <SourceTrend sources={stats.sources} sourceWeekly={stats.sourceWeekly}
        sourceSince={stats.sourceSince} weeks={weeks} />

      <Heatmap heatmap={stats.heatmap} />
    </section>
  );
}
