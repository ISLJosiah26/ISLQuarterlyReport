import React, { useMemo, useState } from "react";
import { fmtInt } from "../utils.js";
import { buildFlow, summarizePaths, topJourneys, stepLabel, EXIT_LABEL } from "../lib/clickPaths.js";
import { CountUp } from "./CountUp.jsx";

// What people did on the site after clicking an ad.
//
// Three views of one set of journeys, in the order the questions get asked:
// how far did they get (the stats), where did the traffic flow and leak (the
// diagram), and what were the actual routes (the table). The table is not a
// fallback for the diagram — it answers a question the diagram can't, since a
// ribbon shows how many moved from one page to the next but never which whole
// route they were on.

// ─── Diagram geometry ─────────────────────────────────────────────
// Drawn in a fixed viewBox and scaled by the browser, like the other
// hand-built charts here. Room on the right is for the last column's labels,
// which have no ribbons to sit above.
const W = 1120;
const PAD_R = 196;
const BAND = 400;       // vertical room the columns are scaled into
const TOP = 34;         // step captions sit above this
const NODE_W = 11;
const NODE_GAP = 11;
const MIN_NODE_H = 3;   // a one-session node still has to be visible
const LABEL_GAP = 32;   // two lines of label, so they never stack on top of each other
const LABEL_MAX = 34;

const truncate = (s) => (s.length > LABEL_MAX ? s.slice(0, LABEL_MAX - 1).trimEnd() + "…" : s);
const nodeText = (node) => (node.isExit || node.isOther ? node.label : stepLabel(node.label));
const columnCaption = (d) => (d === 0 ? "Landed on" : `Then step ${d + 1}`);

// Lays the flow out in pixels: one x per column, one y per node, and the
// ribbon endpoints that follow from them. Kept apart from the drawing so the
// arithmetic reads in one piece.
function layout(flow) {
  const step = (W - PAD_R - NODE_W) / Math.max(flow.depth - 1, 1);
  // One scale for every column, so a column that carries fewer sessions
  // genuinely draws shorter — that shortfall is the drop-off.
  const scale = Math.min(
    ...flow.columns.map(c => (BAND - NODE_GAP * (c.nodes.length - 1)) / c.total)
  );

  const nodes = new Map();
  for (const col of flow.columns) {
    const height = col.total * scale + NODE_GAP * (col.nodes.length - 1);
    let y = TOP + (BAND - height) / 2;
    // A two-line label is taller than a thin node's bar, so labels are walked
    // down the column and held apart. They stay in node order, which keeps
    // each one next to its own bar even where a run of small pages pushes the
    // last of them past its own.
    let labelY = -Infinity;
    for (const node of col.nodes) {
      const h = Math.max(MIN_NODE_H, node.value * scale);
      labelY = Math.max(y + 11, labelY + LABEL_GAP);
      nodes.set(node.key, { ...node, x: col.depth * step, y, h, labelY });
      y += h + NODE_GAP;
    }
  }

  const links = flow.links.map(link => {
    const from = nodes.get(link.from), to = nodes.get(link.to);
    const h = Math.max(1, link.value * scale);
    return {
      ...link,
      h,
      x0: from.x + NODE_W,
      x1: to.x,
      y0: from.y + link.fromOffset * scale,
      y1: to.y + link.toOffset * scale,
    };
  });

  return { nodes: [...nodes.values()], links, columns: flow.columns.map(c => ({ ...c, x: c.depth * step })) };
}

// A ribbon: down one node's edge, across to the next, back again.
function ribbon({ x0, y0, x1, y1, h }) {
  const mid = (x0 + x1) / 2;
  return `M${x0},${y0} C${mid},${y0} ${mid},${y1} ${x1},${y1} L${x1},${y1 + h} `
       + `C${mid},${y1 + h} ${mid},${y0 + h} ${x0},${y0 + h} Z`;
}

function FlowDiagram({ flow, label }) {
  const [hover, setHover] = useState(null);
  const { nodes, links, columns } = useMemo(() => layout(flow), [flow]);
  const height = TOP + BAND + 26;

  // Hovering a page holds the ribbons in and out of it, and dims the rest —
  // the only way to read one page's share of a busy middle column.
  const lit = key => !hover || key === hover;
  const litLink = l => !hover || l.from === hover || l.to === hover;

  return (
    <div className="cpath-flow">
      <svg
        className="cpath-svg"
        viewBox={`0 0 ${W} ${height}`}
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label={label}
      >
        {columns.map(col => (
          <text key={col.depth} className="cpath-col-caption" x={col.x} y={16}>
            {columnCaption(col.depth)}
          </text>
        ))}

        <g className="cpath-links">
          {links.map(l => (
            <path
              key={l.key}
              d={ribbon(l)}
              className={"cpath-link" + (l.isExit ? " is-exit" : "") + (litLink(l) ? "" : " is-dim")}
            />
          ))}
        </g>

        {nodes.map(n => (
          <g
            key={n.key}
            className={"cpath-node" + (lit(n.key) ? "" : " is-dim")}
            onMouseEnter={() => setHover(n.key)}
            onMouseLeave={() => setHover(null)}
          >
            <title>
              {`${nodeText(n)} — ${fmtInt(n.value)} session${n.value === 1 ? "" : "s"}`
                + ` (${n.share.toFixed(1)}% of arrivals)`
                + (n.isOther ? ` across ${n.pages} pages` : "")}
            </title>
            {/* A wide invisible hit area: the bars are 11px, too thin to hover. */}
            <rect x={n.x - 4} y={n.y - 3} width={NODE_W + 8} height={n.h + 6} fill="transparent" />
            <rect
              x={n.x} y={n.y} width={NODE_W} height={n.h} rx="2"
              className={"cpath-bar" + (n.isExit ? " is-exit" : n.isOther ? " is-other" : "")}
            />
            <text className="cpath-node-name" x={n.x + NODE_W + 9} y={n.labelY}>
              {truncate(nodeText(n))}
            </text>
            <text className="cpath-node-value" x={n.x + NODE_W + 9} y={n.labelY + 15}>
              {fmtInt(n.value)} · {Math.round(n.share)}%
            </text>
          </g>
        ))}
      </svg>
    </div>
  );
}

// ─── Journeys ─────────────────────────────────────────────────────
const JOURNEYS_VISIBLE = 8;

function JourneyRoute({ steps }) {
  return (
    <span className="cpath-route">
      {steps.map((s, i) => (
        <React.Fragment key={i}>
          {i > 0 && <span className="cpath-route-sep" aria-hidden="true">›</span>}
          <span className="cpath-step" title={s}>{stepLabel(s)}</span>
        </React.Fragment>
      ))}
      {/* Stored journeys are whole sessions, so the route genuinely ends here
          — without the marker "/jobs › /apply" reads as a route that might
          have carried on past the edge of the table. */}
      <span className="cpath-route-sep" aria-hidden="true">›</span>
      <span className="cpath-step--end" title={EXIT_LABEL}>left</span>
    </span>
  );
}

function JourneyTable({ journeys, showConversions }) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? journeys : journeys.slice(0, JOURNEYS_VISIBLE);
  const hidden = journeys.length - shown.length;

  return (
    <>
      <div className="table-wrap">
        {/* table--stack reflows the rows into labelled cards on a phone, where
            four columns beside a wrapped route have nowhere to go. */}
        <table className="table table--stack cpath-table">
          <thead>
            <tr>
              <th scope="col">Journey</th>
              <th scope="col" className="r">Sessions</th>
              <th scope="col" className="r">Share</th>
              {showConversions && <th scope="col" className="r">Conversions</th>}
            </tr>
          </thead>
          <tbody>
            {shown.map(j => (
              <tr key={j.key}>
                <th scope="row"><JourneyRoute steps={j.steps} /></th>
                <td className="r num" data-label="Sessions">{fmtInt(j.sessions)}</td>
                <td className="r num" data-label="Share">{j.share != null ? j.share.toFixed(1) + "%" : "—"}</td>
                {showConversions && (
                  <td className="r num" data-label="Conversions">{j.conversions ? fmtInt(j.conversions) : "—"}</td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {hidden > 0 && <button className="aud-more" onClick={() => setExpanded(true)}>Show {hidden} more</button>}
      {expanded && journeys.length > JOURNEYS_VISIBLE && (
        <button className="aud-more" onClick={() => setExpanded(false)}>Show less</button>
      )}
    </>
  );
}

// ─── Stats ────────────────────────────────────────────────────────
// The four figures that answer "did the click go anywhere?". Conversions only
// appear once something reported them, the same rule the campaign metrics use.
function statsFor(s) {
  const tiles = [
    { key: "sessions", label: "Sessions", value: s.sessions, fmt: fmtInt, note: "arrived from the ads" },
    {
      key: "continued",
      label: "Went further",
      value: s.continuedPct,
      fmt: v => (v != null ? Math.round(v) + "%" : "—"),
      note: `${fmtInt(s.continued)} moved past the landing page`,
    },
    {
      key: "depth",
      label: "Pages / session",
      value: s.avgSteps,
      fmt: v => (v != null ? v.toFixed(1) : "—"),
      note: `deepest journey ran ${s.deepest} page${s.deepest === 1 ? "" : "s"}`,
    },
  ];
  if (s.conversions != null) {
    tiles.push({
      key: "conversions",
      label: "Converted",
      value: s.conversions,
      fmt: fmtInt,
      note: s.conversionRate != null ? `${s.conversionRate.toFixed(1)}% of these sessions` : "leads + actions taken",
    });
  } else {
    tiles.push({
      key: "landing",
      label: "Landing pages",
      value: s.landingPages,
      fmt: fmtInt,
      note: "entry points the ads bought",
    });
  }
  return tiles;
}

// ─── Block ────────────────────────────────────────────────────────
export function ClickPathBlock({ paths, title, note }) {
  const model = useMemo(() => {
    const summary = summarizePaths(paths);
    if (!summary) return null;
    return { summary, flow: buildFlow(paths), journeys: topJourneys(paths) };
  }, [paths]);

  if (!model) return null;
  const { summary, flow, journeys } = model;

  const showConversions = journeys.some(j => j.conversions != null);
  const flowLabel = flow
    ? `Flow of ${fmtInt(summary.drawn)} sessions from the pages they landed on through `
      + `${flow.depth} steps, with the traffic that left the site at each step`
    : "";

  return (
    <div className="campaign-clickpath">
      <div className="campaign-block-head cpath-head">
        <h3 className="campaign-block-title serif">{title}</h3>
        {note && <span className="aud-panel-note">{note}</span>}
      </div>

      <div className="cpath-stats">
        {statsFor(summary).map((t, i) => (
          <div className="cpath-stat" key={t.key} style={{ "--i": i }}>
            <div className="cpath-stat-label">{t.label}</div>
            <div className="cpath-stat-value num"><CountUp value={t.value} format={t.fmt} /></div>
            <div className="cpath-stat-note">{t.note}</div>
          </div>
        ))}
      </div>

      {flow && flow.depth > 1 && (
        <>
          <FlowDiagram flow={flow} label={flowLabel} />
          <p className="cpath-legend">
            <span className="cpath-key" aria-hidden="true" /> moved to another page
            <span className="cpath-key is-exit" aria-hidden="true" /> left the site
            {flow.truncatedDepth && <span className="cpath-legend-note">Journeys continued past the last step shown.</span>}
          </p>
        </>
      )}

      <JourneyTable journeys={journeys} showConversions={showConversions} />

      {summary.coverage != null && summary.coverage < 99.5 && (
        <p className="cf-note">
          Covers the {fmtInt(summary.drawn)} sessions on the {fmtInt(summary.journeys)} most common
          journeys — {Math.round(summary.coverage)}% of the {fmtInt(summary.sessions)} that arrived. The rest
          took a one-off route each.
        </p>
      )}
    </div>
  );
}
