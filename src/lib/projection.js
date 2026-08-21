// ─── Pure projection math ─────────────────────────────────────────
// No side-effecting imports (no Supabase client) so this module can be
// unit-tested and back-tested in isolation. The data-fetching hook in
// useTrendsData.js composes these helpers with persistence.
import { TRENDS_QUARTERS } from "../config.js";
import { toNumber, nfk } from "../utils.js";

// ─── Metric definitions ────────────────────────────────────────────
export const METRICS = [
  { id: "impressions", label: "Impressions",     needles: ["post impressions","impressions"],                                         isPercent: false, isPace: true, postsMultiplier: true },
  { id: "reactions",   label: "Reactions",        needles: ["reactions and likes","reactions & likes","reactions","likes"],            isPercent: false, isPace: true, postsMultiplier: true },
  { id: "linkclicks",  label: "Link Clicks",      needles: ["post link clicks","link clicks","clicks"],                                isPercent: false, isPace: true, postsMultiplier: true },
  { id: "shares",      label: "Shares",           needles: ["post shares","shares"],                                                   isPercent: false, isPace: true, postsMultiplier: true },
  { id: "comments",    label: "Comments",         needles: ["comments and replies","comments & replies","comments","replies"],         isPercent: false, isPace: true, postsMultiplier: true, sporadic: true },
  { id: "posts",       label: "Posts Published",  needles: ["posts"],                                                                  isPercent: false, isPace: true },
  { id: "followers",   label: "Followers",        needles: ["followers total","followers (total)","followers"],                        isPercent: false, isPace: true, baselineFromQ2: true },
];

// ─── Extraction helpers ────────────────────────────────────────────
function extractFromRows(rows, metric) {
  if (!Array.isArray(rows) || !rows.length) return null;
  const map = {};
  for (const r of rows) {
    const raw = r.field ?? r.Field ?? r.name ?? r.Name ?? "";
    const k = nfk(raw);
    if (k) map[k] = r.value ?? r.Value ?? null;
  }
  for (const n of metric.needles) {
    const k = nfk(n);
    if (map[k] !== undefined) return toNumber(map[k]);
  }
  const keys = Object.keys(map);
  for (const n of metric.needles) {
    const nl = nfk(n);
    const hit = keys.find(k => k.includes(nl));
    if (hit !== undefined) return toNumber(map[hit]);
  }
  return null;
}

function extractFromOverall(overall, metric) {
  if (!overall || typeof overall !== "object" || Array.isArray(overall)) return null;
  const direct = { impressions: "impressions", reactions: "reactions", linkclicks: "linkclicks", shares: "shares", comments: "comments", posts: "posts", followers: "followers" };
  const k = direct[metric.id];
  return k && overall[k] !== undefined ? toNumber(overall[k]) : null;
}

export function extractMetric(data, metric) {
  if (!data) return null;
  if (data.quarterTotals) { const v = extractFromRows(data.quarterTotals, metric); if (v !== null) return v; }
  if (data.overall)       { const v = extractFromOverall(data.overall, metric);    if (v !== null) return v; }
  return null;
}

// ─── Blend weighting ──────────────────────────────────────────────
// Continuous (rather than step-threshold) weights so the projection
// evolves smoothly over the quarter instead of jumping as it crosses a
// boundary. Intent is unchanged: trust the data-driven methods more as
// current-quarter evidence accumulates.
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// The full-quarter regression is the least reliable of the three methods, and
// it fails hardest exactly where it used to be trusted most. It fits one
// straight line across the whole quarter, so a burst of activity in any single
// stretch tilts the line and keeps that tilt in the extrapolation long after
// the burst is over — a quarter that ran hot in month two projects a month-two
// finish onto a month-three reality. Back-testing ISL's Q4 snapshots (174
// hold-out projections against known actuals) put the regression's mean
// absolute error above both other methods at *every* stage from 40% to 95%
// elapsed, and it was the only component with a consistent upward bias. So its
// weight now decays as the quarter matures rather than climbing to a majority,
// and the trailing-window rate — which tracks the current regime — takes the
// difference. Early-quarter weights are unchanged: that is where the rolling
// window is thinnest and the regression genuinely earns its keep.
function blendWeights(elapsedFraction, hasReg, hasRolling) {
  const f = clamp(elapsedFraction, 0, 1);
  if (hasReg && hasRolling) {
    const wSimple = clamp(0.30 - 0.20 * f, 0.10, 0.30); // 0.30 → 0.10
    const wReg    = clamp(0.35 - 0.10 * f, 0.25, 0.35); // 0.35 → 0.25
    return { simple: wSimple, rolling: 1 - wSimple - wReg, reg: wReg };
  }
  if (hasReg) {
    const wSimple = clamp(0.45 - 0.25 * f, 0.20, 0.45); // 0.45 → 0.20
    return { simple: wSimple, rolling: 0, reg: 1 - wSimple };
  }
  if (hasRolling) {
    const wSimple = clamp(0.40 - 0.20 * f, 0.20, 0.40); // 0.40 → 0.20
    return { simple: wSimple, rolling: 1 - wSimple, reg: 0 };
  }
  return { simple: 1, rolling: 0, reg: 0 };
}

// Least-squares slope of y over x; null if undefined (need ≥2 distinct x).
function lsSlope(pts) {
  const n = pts.length;
  if (n < 2) return null;
  const sx = pts.reduce((a, p) => a + p.x, 0);
  const sy = pts.reduce((a, p) => a + p.y, 0);
  const sxy = pts.reduce((a, p) => a + p.x * p.y, 0);
  const sx2 = pts.reduce((a, p) => a + p.x * p.x, 0);
  const den = n * sx2 - sx * sx;
  if (den === 0) return null;
  return (n * sxy - sx * sy) / den;
}

// ─── Pace projection ──────────────────────────────────────────────
export function computeAdvancedPace(current, qStart, qEnd, q2Rate, metricHistory, histBaseline = 0, asOfDate = new Date(), calibrationFactor = 1) {
  if (current === null || !Number.isFinite(current)) return null;
  const now = asOfDate instanceof Date ? asOfDate : new Date(asOfDate);
  const dElapsed = (now - qStart) / 86400000;
  if (dElapsed < 7) return null;
  const dTotal = (qEnd - qStart) / 86400000;
  const dRemaining = dTotal - dElapsed;
  const elapsedFraction = dElapsed / dTotal;
  const simpleRate = current / dElapsed;
  const simpleProj = simpleRate * dTotal;

  let rollingProj = null, rollingRate = null;
  if (metricHistory.length >= 2) {
    const cutoff = now.getTime() - 7 * 86400000;
    // Window = snapshots from the last 7 days (always include the earliest
    // available point if nothing falls inside the window).
    const window = metricHistory.filter(s => s.t >= cutoff);
    const pts = (window.length >= 2 ? window : metricHistory.slice(-2))
      .map(s => ({ x: s.t / 86400000, y: s.val - histBaseline }))
      .filter(p => Number.isFinite(p.y));
    // Need at least a full day spanned (snapshots carry a time-of-day, so two
    // points can sit <24h apart). Least-squares slope over the window is more
    // robust to a single noisy endpoint than a first-vs-last difference.
    const span = pts.length >= 2 ? Math.max(...pts.map(p => p.x)) - Math.min(...pts.map(p => p.x)) : 0;
    const slope = span >= 1 ? lsSlope(pts) : null;
    if (slope !== null && Number.isFinite(slope) && slope >= 0) {
      rollingRate = slope;
      rollingProj = Math.max(current, current + rollingRate * dRemaining);
    }
  }

  let regProj = null;
  if (metricHistory.length >= 3) {
    const pts = metricHistory
      .map(s => ({ x: (s.t - qStart.getTime()) / 86400000, y: s.val - histBaseline }))
      .filter(p => p.x >= 0 && Number.isFinite(p.y) && p.y >= 0);
    if (pts.length >= 3) {
      const slope = lsSlope(pts);
      if (slope !== null) {
        const sx = pts.reduce((a, p) => a + p.x, 0), sy = pts.reduce((a, p) => a + p.y, 0);
        const intercept = (sy - slope * sx) / pts.length;
        const r = intercept + slope * dTotal;
        if (r > 0) regProj = r;
      }
    }
  }

  // Dynamic blending: shift weight toward data-driven methods as quarter matures.
  const w = blendWeights(elapsedFraction, regProj !== null, rollingProj !== null);
  const blended =
    w.simple * simpleProj +
    w.rolling * (rollingProj ?? 0) +
    w.reg * (regProj ?? 0);

  // Ramp off Q2-rate anchor as current-quarter evidence accumulates.
  const anchorWeight = Math.max(0, (0.25 - elapsedFraction) / 0.25);
  const rawProjected = q2Rate !== null && Number.isFinite(q2Rate) && q2Rate > 0 && anchorWeight > 0
    ? anchorWeight * (q2Rate * dTotal) + (1 - anchorWeight) * blended
    : blended;

  const safeCalibration = Number.isFinite(calibrationFactor) && calibrationFactor > 0 ? calibrationFactor : 1;
  const projected = Math.max(rawProjected * safeCalibration, current);

  // Component sub-projections (each scaled by the same calibration the blend
  // got) are exposed so projectionBand can read how far the three methods
  // disagree right now — a direct, data-driven measure of model uncertainty.
  const components = {
    simple:  simpleProj  * safeCalibration,
    rolling: rollingProj !== null ? rollingProj * safeCalibration : null,
    reg:     regProj     !== null ? regProj     * safeCalibration : null,
  };

  return { projected, rawProjected, dailyRate: rollingRate ?? simpleRate, dElapsed, dTotal, calibrationFactor: safeCalibration, elapsedFraction, components };
}

function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// ─── Sporadic-metric pace (median background + spike bonus) ──────────
// Some metrics (comments) don't accrue at a steady rate — they sit near zero
// on ordinary days and jump when a popular post lands. Feeding that into the
// same simple/rolling/regression blend as a steady metric like impressions
// over- or under-shoots badly: a quiet quarter linearly extrapolates toward
// ~0, and the day right after a spike extrapolates *that* day's rate as the
// new normal. Instead: separate the steady background (the *median* day-rate,
// which one huge day can't drag around the way a mean or regression slope
// can) from spike days (day-rates well above that background), then add back
// an *expected* spike contribution for the remaining days based on how often
// spikes have actually shown up this quarter — rather than assuming zero
// more spikes, or assuming today's spike rate continues.
//
// A day-rate counts as a spike once it clears both a MAD-based floor (robust
// to how noisy the background itself is) and a floor relative to the
// background itself (so a near-zero background with tiny MAD doesn't flag
// every ordinary uptick as a "spike").
const SPIKE_MAD_MULTIPLE = 4;
const SPIKE_BACKGROUND_MULTIPLE = 2;
export function computeSporadicPace(current, qStart, qEnd, metricHistory, asOfDate = new Date(), calibrationFactor = 1) {
  if (current === null || !Number.isFinite(current)) return null;
  const now = asOfDate instanceof Date ? asOfDate : new Date(asOfDate);
  const dElapsed = (now - qStart) / 86400000;
  if (dElapsed < 7) return null;
  const dTotal = (qEnd - qStart) / 86400000;
  const dRemaining = Math.max(0, dTotal - dElapsed);
  const elapsedFraction = dElapsed / dTotal;
  const safeCalibration = Number.isFinite(calibrationFactor) && calibrationFactor > 0 ? calibrationFactor : 1;
  const simpleRate = current / dElapsed;

  // Day-rates between consecutive snapshots, normalized by the actual gap so
  // unevenly-spaced snapshots don't distort a single day's rate.
  const sorted = [...(metricHistory || [])].sort((a, b) => a.t - b.t);
  const rates = [];
  for (let i = 1; i < sorted.length; i++) {
    const dt = (sorted[i].t - sorted[i - 1].t) / 86400000;
    const dv = sorted[i].val - sorted[i - 1].val;
    if (dt > 0 && Number.isFinite(dv)) rates.push(Math.max(0, dv) / dt);
  }

  if (!rates.length) {
    // Not enough deltas yet to separate background from spikes — fall back
    // to the plain average rate, same floor as the general model.
    const simpleProj = simpleRate * dTotal;
    const projected = Math.max(simpleProj * safeCalibration, current);
    return {
      projected, rawProjected: simpleProj, dailyRate: simpleRate, dElapsed, dTotal,
      calibrationFactor: safeCalibration, elapsedFraction,
      components: { simple: simpleProj * safeCalibration, rolling: null, reg: null },
      background: simpleRate, spikeFrequency: 0, avgSpikeSize: 0,
    };
  }

  const backgroundRate = median(rates);
  const mad = median(rates.map(r => Math.abs(r - backgroundRate))) || 0;
  const spikeThreshold = backgroundRate + Math.max(mad * SPIKE_MAD_MULTIPLE, backgroundRate * SPIKE_BACKGROUND_MULTIPLE, 1);
  const spikeRates = rates.filter(r => r > spikeThreshold);
  const spikeFrequency = spikeRates.length / rates.length;
  const avgSpikeSize = spikeRates.length
    ? spikeRates.reduce((a, r) => a + (r - backgroundRate), 0) / spikeRates.length
    : 0;

  const backgroundProj = current + backgroundRate * dRemaining;
  const withSpikesProj = backgroundProj + spikeFrequency * avgSpikeSize * dRemaining;

  const rawProjected = withSpikesProj;
  const projected = Math.max(rawProjected * safeCalibration, current);

  return {
    projected, rawProjected, dailyRate: backgroundRate, dElapsed, dTotal,
    calibrationFactor: safeCalibration, elapsedFraction,
    // No-more-spikes floor vs. typical-spike-behavior-continues ceiling — the
    // gap between the two IS the real uncertainty for a sporadic metric, so
    // projectionBand's method-disagreement term picks it up for free.
    components: {
      simple:  Math.max(backgroundProj, 0) * safeCalibration,
      rolling: null,
      reg:     Math.max(withSpikesProj, 0) * safeCalibration,
    },
    background: backgroundRate, spikeFrequency, avgSpikeSize,
  };
}

// Single entry point the call sites use: dispatches to the sporadic model
// for metrics flagged `sporadic` (comments), else the general blend —
// everything downstream (projectionBand, buildProjectionAudit, the
// trajectory chart) consumes the same shape either way.
export function computePace(metric, current, qStart, qEnd, q2Rate, metricHistory, histBaseline = 0, asOfDate = new Date(), calibrationFactor = 1) {
  if (metric?.sporadic) return computeSporadicPace(current, qStart, qEnd, metricHistory, asOfDate, calibrationFactor);
  return computeAdvancedPace(current, qStart, qEnd, q2Rate, metricHistory, histBaseline, asOfDate, calibrationFactor);
}

// ─── History: pure helpers (operate on pre-fetched snapshot arrays) ──
// snapshots: [{ t: number, vals: { metricId: number } }]

export function getMetricHistory(snapshots, metricId) {
  return (snapshots || [])
    .filter(s => s.vals && s.vals[metricId] !== undefined)
    .map(s => ({ t: s.t, val: s.vals[metricId] }))
    .sort((a, b) => a.t - b.t);
}

export function getWeekAgoProjection(snapshots, metric, tq3, q2Rate, histBaseline = 0) {
  const allHistory = getMetricHistory(snapshots, metric.id);
  const weekAgoT = Date.now() - 7 * 86400000;
  const pastHistory = allHistory.filter(s => s.t <= weekAgoT);
  if (!pastHistory.length) return null;
  const snap = pastHistory[pastHistory.length - 1];
  const snapInput = snap.val - histBaseline;
  const pace = computePace(metric, snapInput, tq3.start, tq3.end, q2Rate, pastHistory, histBaseline, new Date(snap.t));
  if (!pace?.projected) return null;
  return pace.projected + (metric.baselineFromQ2 ? histBaseline : 0);
}

export function getProjectionTimeline(snapshots, metric, tq3, q2Rate, histBaseline = 0, calibrationFactor = 1, empiricalErrorPct = null) {
  const allHistory = getMetricHistory(snapshots, metric.id);
  if (allHistory.length < 2) return [];
  const result = [];
  for (let i = 1; i < allHistory.length; i++) {
    const pastHistory = allHistory.slice(0, i + 1);
    const snap = allHistory[i];
    const snapInput = snap.val - histBaseline;
    const pace = computePace(metric, snapInput, tq3.start, tq3.end, q2Rate, pastHistory, histBaseline, new Date(snap.t), calibrationFactor);
    if (pace?.projected != null) {
      const add = metric.baselineFromQ2 ? histBaseline : 0;
      const band = projectionBand(pace, { empiricalErrorPct, current: snapInput });
      result.push({
        t: snap.t,
        projected: pace.projected + add,
        low:  band ? band.low + add : null,
        high: band ? band.high + add : null,
      });
    }
  }
  return result;
}

// ─── Projection uncertainty band ──────────────────────────────────
// A low/expected/high range around a projected final, built only from
// observable signals so it stays honest:
//   • method disagreement — the simple/rolling/regression sub-projections are
//     three semi-independent estimates of the same final; how far apart they
//     sit right now is a direct read on present model uncertainty.
//   • time remaining — even when the methods agree today, the unmeasured rest
//     of the quarter leaves room to drift, so the band widens with the fraction
//     of quarter still to come.
//   • track record — the metric's own average past miss (avg |percent_error|
//     from persisted audits, if any) sets an empirical floor that fades out as
//     the quarter completes and there is less left to be wrong about.
// The band collapses toward the point estimate as elapsedFraction → 1, and its
// low end is floored at `current` (a cumulative metric can't end below what is
// already banked). Returns null when there's no projection to bound.
const BAND_BASE_VOL = 0.12; // per-remaining-quarter drift assumption, ~12%
// The linear drift term above shrinks in proportion to the time left, which
// turns out to be too fast: back-testing ISL's Q4 snapshots put band coverage
// at 70% near the end of the quarter (and 66% at four-fifths through) for a
// range the UI presents as "likely". Accumulated uncertainty behaves more like
// diffusion than like a straight line — a metric with two weeks left can still
// surprise by much more than two weeks of average drift, because one post can
// land. This square-root term adds that residual: it is small in absolute
// terms, but because √r ≫ r for small r it dominates late, widening the
// end-of-quarter band by roughly a sixth while leaving the early-quarter band
// almost as it was. It still vanishes at r = 0, so a closed quarter reports no
// range at all.
const BAND_DRIFT_VOL = 0.035;
export function projectionBand(pace, { elapsedFraction, empiricalErrorPct = null, current = null } = {}) {
  if (!pace || !Number.isFinite(pace.projected) || pace.projected <= 0) return null;
  const proj = pace.projected;
  const ef = Number.isFinite(elapsedFraction) ? elapsedFraction
           : Number.isFinite(pace.elapsedFraction) ? pace.elapsedFraction : 0;
  const remaining = clamp(1 - ef, 0, 1);

  const comps = [pace.components?.simple, pace.components?.rolling, pace.components?.reg]
    .filter(v => Number.isFinite(v) && v > 0);
  const spread = comps.length >= 2 ? (Math.max(...comps) - Math.min(...comps)) / proj : 0;

  const empirical = Number.isFinite(empiricalErrorPct) ? Math.abs(empiricalErrorPct) / 100 : 0;

  const relHalf = clamp(
    spread * 0.6 + remaining * BAND_BASE_VOL + Math.sqrt(remaining) * BAND_DRIFT_VOL + empirical * remaining,
    0.01, 0.6
  );

  const half = proj * relHalf;
  let low = proj - half;
  if (Number.isFinite(current)) low = Math.max(low, current);
  low = Math.max(0, low);
  return { low, expected: proj, high: proj + half, relHalf };
}

// Flag the points where the projected final jumped sharply and tie each jump
// to the most-viewed post published in that point's window, so the trajectory
// chart can answer "what moved this?" on hover. A spike must be both large in
// absolute percent terms *and* large relative to the quarter's typical daily
// movement (median |delta|) — the two conditions together suppress both the
// wild early-quarter swings, where everything looks big, and the steady drift
// of a quiet metric, where nothing should. Only points with an attributable
// post are marked; an unexplained jump gets no tooltip. This is temporal
// association, not proven causation: the post is simply the biggest one
// published as the metric accelerated, and the caller's copy should say so.
export function annotateTimelineSpikes(timeline, posts, options = {}) {
  if (!Array.isArray(timeline) || timeline.length < 2) return timeline || [];
  const { thresholdPct = 0.04, minMultiple = 1.8 } = options;

  const absDeltas = [];
  for (let i = 1; i < timeline.length; i++) {
    absDeltas.push(Math.abs(timeline[i].projected - timeline[i - 1].projected));
  }
  const sorted = [...absDeltas].sort((a, b) => a - b);
  const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;

  const datedPosts = (posts || [])
    .map(p => ({ ...p, _t: p && p.post_date ? new Date(p.post_date).getTime() : NaN }))
    .filter(p => Number.isFinite(p._t));

  return timeline.map((pt, i) => {
    if (i === 0) return pt;
    const prev = timeline[i - 1];
    const delta = pt.projected - prev.projected;
    const absDelta = Math.abs(delta);
    const base = Math.abs(prev.projected) || 1;
    const bigEnough = absDelta >= base * thresholdPct;
    const standsOut = median <= 0 || absDelta >= median * minMultiple;
    if (!bigEnough || !standsOut) return pt;

    const inWindow = datedPosts.filter(p => p._t > prev.t && p._t <= pt.t);
    if (!inWindow.length) return pt;
    const post = inWindow.reduce((best, p) =>
      (p.impressions ?? 0) > (best.impressions ?? 0) ? p : best);

    return {
      ...pt,
      spike: {
        direction: delta >= 0 ? "up" : "down",
        deltaPct: (delta / base) * 100,
        post,
      },
    };
  });
}

// ─── Data-quality / anomaly flags ─────────────────────────────────
// Surface the conditions that quietly make a projection untrustworthy, so a
// broken metric announces itself instead of drawing a confident line over bad
// data. Pure: takes the current quarter's snapshot array, the three-quarter
// extracted data, the current-quarter meta, and an injectable `now`. Returns
// [{ metricId, type, severity, message }] (metricId null = page-level).
export function detectTrendsAnomalies({ snaps, qdata, currentQuarter, now = new Date() } = {}) {
  const flags = [];
  if (!currentQuarter) return flags;
  const complete = now >= currentQuarter.end;
  const elapsedDays = Math.max(0, (now - currentQuarter.start) / 86400000);
  const currentData  = Array.isArray(qdata) && qdata.length ? qdata[qdata.length - 1] : null;
  const previousData = Array.isArray(qdata) && qdata.length >= 2 ? qdata[qdata.length - 2] : null;

  // Staleness: the newest snapshot across all metrics has gone quiet.
  const allT = (snaps || []).map(s => s.t).filter(Number.isFinite);
  if (!complete && elapsedDays >= 7 && allT.length) {
    const ageDays = (now - Math.max(...allT)) / 86400000;
    if (ageDays >= 2) {
      flags.push({ metricId: null, type: "stale", severity: "warn",
        message: `Daily snapshots have paused. The latest is ${Math.floor(ageDays)} days old, so projections may be drifting from reality.` });
    }
  }

  for (const metric of METRICS) {
    if (!metric.isPace) continue;
    const hist = getMetricHistory(snaps, metric.id);

    // A cumulative total shouldn't fall mid-quarter. Followers can legitimately
    // dip (unfollows), so skip the baseline-relative metric. Tolerate a tiny
    // wiggle to avoid flagging rounding noise.
    if (!metric.baselineFromQ2) {
      for (let i = 1; i < hist.length; i++) {
        if (hist[i - 1].val - hist[i].val > Math.max(1, hist[i - 1].val * 0.02)) {
          flags.push({ metricId: metric.id, type: "backward", severity: "warn",
            message: `${metric.label} dropped mid-quarter. A cumulative total shouldn't fall, so this is likely a data-entry correction.` });
          break;
        }
      }
    }

    const cur  = extractMetric(currentData, metric);
    const prev = extractMetric(previousData, metric);

    // Present last quarter, absent now → can't be projected.
    if (cur === null && prev !== null) {
      flags.push({ metricId: metric.id, type: "missing", severity: "warn",
        message: `${metric.label} has no ${currentQuarter.label} value yet, so it can't be projected this quarter.` });
      continue;
    }

    // Well into the quarter but too few snapshots to lean on.
    if (!complete && elapsedDays >= 14 && cur !== null && hist.length < 4) {
      flags.push({ metricId: metric.id, type: "thin", severity: "info",
        message: `${metric.label} has only ${hist.length} snapshot${hist.length === 1 ? "" : "s"} this quarter, so its projection rests on thin data.` });
    }
  }

  return flags;
}

// ─── Narrative summary ────────────────────────────────────────────
// A deterministic, plain-English read of the quarter, stitched from the same
// signals shown elsewhere on the page (pacing, top post, accuracy, flags). No
// LLM, no randomness — same inputs always yield the same sentence, so it's safe
// to put in front of a client. Returns "" when there's nothing worth saying.
function narrativeCount(n) { return Number.isFinite(n) ? Math.round(n).toLocaleString() : null; }
export function buildTrendsNarrative({ drivers, pacing, anomalies = [], overallAccuracyPct = null, currentQuarter, elapsedPct = 0, complete = false } = {}) {
  const parts = [];
  const ql = currentQuarter?.label ?? "This quarter";

  parts.push(complete ? `${ql} is complete.` : `${ql} is ${Math.round(elapsedPct)}% elapsed.`);

  const [lead, lag] = Array.isArray(pacing) ? pacing : [];
  if (lead && Number.isFinite(lead.rateVsQ2)) {
    if (lead.rateVsQ2 >= 0) {
      const tail = lag && lag.metric.id !== lead.metric.id && Number.isFinite(lag.rateVsQ2) && lag.rateVsQ2 < 0
        ? `, while ${lag.metric.label} runs ${Math.abs(lag.rateVsQ2).toFixed(0)}% behind`
        : "";
      parts.push(`${lead.metric.label} is pacing ${Math.abs(lead.rateVsQ2).toFixed(0)}% ahead of last quarter's rate${tail}.`);
    } else {
      parts.push(`Every tracked metric is running below last quarter's rate. ${lead.metric.label} is closest, ${Math.abs(lead.rateVsQ2).toFixed(0)}% behind.`);
    }
  }

  const topName = drivers?.topPost?.post_name;
  if (topName) {
    const imp = narrativeCount(drivers.topPost.impressions);
    parts.push(`The most-viewed post so far is “${topName}”${imp ? ` at ${imp} impressions` : ""}.`);
  }

  if (Number.isFinite(overallAccuracyPct)) {
    parts.push(`Past projections have landed within ±${overallAccuracyPct.toFixed(1)}% of the final.`);
  }

  const warns = (anomalies || []).filter(a => a.severity === "warn").length;
  if (warns) parts.push(`${warns} data-quality ${warns === 1 ? "issue needs" : "issues need"} a look before leaning on the projections.`);

  // A bare elapsed sentence alone isn't worth surfacing.
  return parts.length > 1 ? parts.join(" ") : "";
}

// ─── Calibration audit ────────────────────────────────────────────
export function clampCalibrationFactor(factor) {
  if (!Number.isFinite(factor) || factor <= 0) return 1;
  return Math.min(1.5, Math.max(0.5, factor));
}

// Weight a historical sample by how close its elapsed-fraction is to the
// stage we are currently projecting at. A projection made on day 12 of last
// quarter says little about the accuracy of a projection made on day 80 of
// this one; matching the stage removes that mismatch. Triangular kernel with
// a half-width of `bandwidth` (in elapsed-fraction units); floored so distant
// samples still count a little and the weights never collapse to zero.
function stageWeight(sampleFraction, targetFraction, bandwidth = 0.35) {
  if (!Number.isFinite(targetFraction)) return 1; // no stage info → equal weight
  const d = Math.abs(sampleFraction - targetFraction);
  return Math.max(0.05, 1 - d / bandwidth);
}

// Confidence ∈ (0,1] that the learned calibration ratio is trustworthy. We
// shrink the correction toward 1 (i.e. toward "no calibration") in proportion
// to (1 − confidence), so a prior quarter that doesn't resemble this one can't
// drag the projection around. Two independent signals, multiplied:
//   • support     — effective number of samples near the current stage. Thin
//                   or absent coverage (common while snapshot history is young)
//                   means the factor rests on little, or distant, data.
//   • consistency — dispersion of the projection error after removing its
//                   smooth drift across the quarter, so steady convergence is
//                   not mistaken for a poor fit; only genuine scatter counts.
const SUPPORT_FULL = 5;     // effective near-stage samples for full support
const DISPERSION_K = 0.30;  // de-trended rel-error std at which consistency ≈ 0.5
function calibrationConfidence(samples, totalWeight, actualInput) {
  if (!(actualInput > 0) || !(totalWeight > 0)) return 1;

  // Effective sample size (Kish): (Σw)² / Σw².
  const sumW2 = samples.reduce((a, s) => a + s.weight * s.weight, 0);
  const nEff = sumW2 > 0 ? (totalWeight * totalWeight) / sumW2 : 0;
  const support = Math.min(1, nEff / SUPPORT_FULL);

  // De-trend relative error against elapsed fraction (weighted least squares),
  // then take the weighted residual std — genuine scatter, not smooth drift.
  const pts = samples.map(s => ({ x: s.fraction, y: (s.projected - actualInput) / actualInput, w: s.weight }));
  const mx = pts.reduce((a, p) => a + p.w * p.x, 0) / totalWeight;
  const my = pts.reduce((a, p) => a + p.w * p.y, 0) / totalWeight;
  const sxx = pts.reduce((a, p) => a + p.w * (p.x - mx) * (p.x - mx), 0);
  const sxy = pts.reduce((a, p) => a + p.w * (p.x - mx) * (p.y - my), 0);
  const slope = sxx > 0 ? sxy / sxx : 0;
  const intercept = my - slope * mx;
  const resVar = pts.reduce((a, p) => a + p.w * Math.pow(p.y - (intercept + slope * p.x), 2), 0) / totalWeight;
  const dispersion = Math.sqrt(Math.max(0, resVar));
  const consistency = 1 / (1 + Math.pow(dispersion / DISPERSION_K, 2));

  return support * consistency;
}

export function buildProjectionAudit({ metric, actualValue, completedQuarter, previousQuarter, previousQuarterValue, twoBackValue, snapshotHistory, targetElapsedFraction = null }) {
  if (!metric?.isPace || actualValue === null || previousQuarterValue === null) return null;

  const previousDays = (previousQuarter.end - previousQuarter.start) / 86400000;
  const previousInput = metric.baselineFromQ2
    ? (twoBackValue != null ? previousQuarterValue - twoBackValue : null)
    : previousQuarterValue;
  const previousRate = previousInput !== null && Number.isFinite(previousInput)
    ? previousInput / previousDays : null;
  const actualInput = metric.baselineFromQ2 ? actualValue - previousQuarterValue : actualValue;
  if (!Number.isFinite(actualInput) || actualInput < 0) return null;

  const histBaseline = metric.baselineFromQ2 ? previousQuarterValue : 0;
  const quarterStart = completedQuarter.start.getTime();
  const quarterEnd   = completedQuarter.end.getTime();
  const completedDays = (quarterEnd - quarterStart) / 86400000;
  const metricHistory = getMetricHistory(snapshotHistory, metric.id)
    .filter(s => s.t >= quarterStart && s.t < quarterEnd && Number.isFinite(s.val));

  const samples = [];
  for (const sample of metricHistory) {
    const sampleInput = metric.baselineFromQ2 ? sample.val - previousQuarterValue : sample.val;
    if (!Number.isFinite(sampleInput) || sampleInput < 0) continue;
    const sampleHistory = metricHistory.filter(s => s.t <= sample.t);
    const pace = computePace(metric, sampleInput, completedQuarter.start, completedQuarter.end, previousRate, sampleHistory, histBaseline, new Date(sample.t));
    // `pace` is null for samples inside the first 7 days; guard before deref.
    if (pace && Number.isFinite(pace.projected) && pace.projected > 0) {
      const fraction = pace.dElapsed / (pace.dTotal || completedDays);
      // Also capture the band width (relHalf) this sample would have shown,
      // so coverage can be checked against a stage-weighted average band
      // the same way accuracy is checked against a stage-weighted average
      // projection — no empirical term here since that would require the
      // audit history that existed *at the time*, which isn't threaded
      // through this retrospective pass; the band this checks is the more
      // conservative "method disagreement + time remaining" one.
      const band = projectionBand(pace, { elapsedFraction: fraction });
      samples.push({
        t: sample.t, projected: pace.projected, day: Math.round(pace.dElapsed), fraction,
        weight: stageWeight(fraction, targetElapsedFraction),
        relHalf: band ? band.relHalf : 0,
      });
    }
  }

  if (!samples.length) return null;
  const totalWeight = samples.reduce((sum, s) => sum + s.weight, 0) || samples.length;
  const avgProjected = samples.reduce((sum, s) => sum + s.projected * s.weight, 0) / totalWeight;
  const error = avgProjected - actualInput;
  const percentError = actualInput !== 0 ? error / actualInput * 100 : null;
  const accuracyRatio = avgProjected > 0 ? actualInput / avgProjected : 1;

  // Band coverage: did the actual final land inside the range this stage's
  // average band would have shown? Built the same way avgProjected is —
  // a stage-weighted average of each sample's relative half-width, applied
  // symmetrically around avgProjected (the "can't end below what's already
  // banked" floor that live bands apply doesn't make sense retrospectively
  // here, since `current` was a moving target across samples).
  const bandRelHalf = samples.reduce((sum, s) => sum + s.relHalf * s.weight, 0) / totalWeight;
  const bandLow = Math.max(0, avgProjected * (1 - bandRelHalf));
  const bandHigh = avgProjected * (1 + bandRelHalf);
  const bandCovered = actualInput >= bandLow && actualInput <= bandHigh;

  // Self-dampening: trust the correction only as far as the prior quarter's
  // fit was reliable. A poor fit (scattered, or built from thin near-stage
  // data) pulls the factor back toward 1.0 — leave the uncorrected blend be.
  const confidence = calibrationConfidence(samples, totalWeight, actualInput);
  const dampedRatio = 1 + confidence * (accuracyRatio - 1);
  const calibrationFactor = clampCalibrationFactor(dampedRatio);

  return {
    actual: actualInput, avgProjected, error, percentError,
    accuracyRatio, calibrationConfidence: confidence, calibrationFactor,
    bandLow, bandHigh, bandRelHalf, bandCovered,
    sampleCount: samples.length,
    firstDay: samples[0]?.day ?? null,
    lastDay:  samples[samples.length - 1]?.day ?? null,
  };
}

export function buildProjectionAudits(qdata, snapsByQuarter, quarters = TRENDS_QUARTERS) {
  if (!Array.isArray(qdata) || qdata.length < 3 || !Array.isArray(quarters) || quarters.length < 3) return {};
  const [twoBackData, previousData] = qdata;
  const [twoBackQuarter, previousQuarter, currentQuarter] = quarters;
  if (!quarterComplete(previousQuarter)) return {};

  // Calibrate at the same stage of the prior quarter that the current
  // quarter has reached, so the correction reflects accuracy at this point.
  const targetElapsedFraction = currentQuarter ? quarterCompletion(currentQuarter) : null;

  const prevSnaps = snapsByQuarter?.[previousQuarter.suffix] || [];
  return Object.fromEntries(METRICS.map(metric => {
    const audit = buildProjectionAudit({
      metric,
      actualValue:          extractMetric(previousData, metric),
      completedQuarter:     previousQuarter,
      previousQuarter:      twoBackQuarter,
      previousQuarterValue: extractMetric(twoBackData, metric),
      twoBackValue:         null,
      snapshotHistory:      prevSnaps,
      targetElapsedFraction,
    });
    return [metric.id, audit];
  }));
}

// ─── Multi-quarter calibration blend ──────────────────────────────
// Combines several quarters of *persisted* audit results into one
// calibration factor, so a metric's correction compounds across quarters
// instead of resetting to a single one-quarter-back comparison each time.
// `history` must be ordered most-recent-first (e.g. by computed_at desc);
// each entry needs calibration_factor and calibration_confidence. Weight
// decays geometrically with age so a stale quarter can't out-vote a recent
// one, and is scaled by that quarter's own confidence so a poorly-fit
// quarter still contributes little. Returns null (not 1) on empty history
// so callers can distinguish "no history yet" from "history says no
// correction needed."
export function blendCalibrationHistory(history, decay = 0.6) {
  if (!Array.isArray(history) || !history.length) return null;
  let totalWeight = 0, weighted = 0;
  history.forEach((h, i) => {
    const factor = h?.calibration_factor;
    if (!Number.isFinite(factor)) return;
    const confidence = Number.isFinite(h?.calibration_confidence) ? h.calibration_confidence : 1;
    const w = confidence * Math.pow(decay, i);
    totalWeight += w;
    weighted += w * factor;
  });
  if (totalWeight <= 0) return 1;
  return clampCalibrationFactor(weighted / totalWeight);
}

// ─── Quarter completion ───────────────────────────────────────────
export function quarterCompletion(q) {
  const now = new Date();
  if (now >= q.end)  return 1;
  if (now < q.start) return 0;
  return (now - q.start) / (q.end - q.start);
}

export function quarterComplete(q) { return new Date() >= q.end; }
