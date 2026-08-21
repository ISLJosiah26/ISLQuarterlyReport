import { describe, it, expect } from "vitest";
import {
  computeAdvancedPace,
  computeSporadicPace,
  computePace,
  METRICS,
  buildProjectionAudit,
  blendCalibrationHistory,
  annotateTimelineSpikes,
  projectionBand,
  detectTrendsAnomalies,
  buildTrendsNarrative,
} from "./projection.js";

const DAY = 86400000;
const qStart = new Date(2026, 2, 1); // Mar 1
const qEnd = new Date(2026, 5, 1);   // Jun 1 (exclusive), 92-day quarter

// Decelerating cumulative series: increments shrink from 40/day toward ~4/day.
// Early daily-rate extrapolation over-projects; late projections are accurate.
function decelSnapshots() {
  const snaps = [];
  let acc = 0;
  for (let i = 0; i < 92; i++) {
    acc += Math.max(0, 40 - 0.4 * i);
    snaps.push({ t: qStart.getTime() + i * DAY, vals: { m: acc } });
  }
  return snaps;
}
const metric = { id: "m", label: "m", isPace: true };

describe("computeAdvancedPace — continuous blending", () => {
  // Build a fixed decelerating history up to day 50, then evaluate the
  // projection just below and just above the old 0.55 weight threshold.
  const snaps = decelSnapshots().slice(0, 51).map(s => ({ t: s.t, val: s.vals.m }));
  const current = snaps[snaps.length - 1].val;

  it("has no discontinuity crossing the old 0.55 blend threshold", () => {
    const below = computeAdvancedPace(current, qStart, qEnd, null, snaps, 0, new Date(qStart.getTime() + 50.5 * DAY));
    const above = computeAdvancedPace(current, qStart, qEnd, null, snaps, 0, new Date(qStart.getTime() + 50.7 * DAY));
    expect(below).not.toBeNull();
    expect(above).not.toBeNull();
    // A 0.2-day nudge should move the projection by well under 0.5%.
    const jump = Math.abs(above.projected - below.projected) / below.projected;
    expect(jump).toBeLessThan(0.005);
  });

  it("recovers the exact rate on a perfectly linear series", () => {
    const linear = [];
    for (let i = 0; i <= 40; i++) linear.push({ t: qStart.getTime() + i * DAY, val: 10 * i });
    const pace = computeAdvancedPace(400, qStart, qEnd, null, linear, 0, new Date(qStart.getTime() + 40 * DAY));
    expect(pace.dailyRate).toBeCloseTo(10, 6);
    expect(pace.projected).toBeCloseTo(920, 0); // 10/day × 92 days
  });
});

describe("computeAdvancedPace — regression weight decays as the quarter matures", () => {
  // On a decelerating series the full-quarter regression keeps extrapolating
  // the early slope while the trailing window has already seen the plateau, so
  // reg sits well above rolling. Where the blend lands between those two is a
  // direct read on the regression's weight, without exporting blendWeights.
  const all = decelSnapshots().map(s => ({ t: s.t, val: s.vals.m }));
  const leanTowardReg = (day) => {
    const history = all.slice(0, day + 1);
    const pace = computeAdvancedPace(
      history[history.length - 1].val, qStart, qEnd, null, history, 0,
      new Date(qStart.getTime() + day * DAY),
    );
    // 0 = sits exactly on the rolling projection, 1 = sits on the regression.
    return (pace.projected - pace.components.reg === 0)
      ? 1
      : (pace.projected - pace.components.rolling) / (pace.components.reg - pace.components.rolling);
  };

  it("leans further toward the trailing window the later the quarter gets", () => {
    const early = leanTowardReg(25);
    const mid   = leanTowardReg(55);
    const late  = leanTowardReg(82);
    expect(mid).toBeLessThan(early);
    expect(late).toBeLessThan(mid);
  });

  it("keeps the blend on the trailing-window side of the regression from mid-quarter on", () => {
    // Once past the halfway mark the regression's weight is decaying toward
    // 0.25, so the blend settles nearer the rolling projection than the
    // regression one. (Earlier than this the simple rate can sit outside the
    // rolling..reg interval and drag the blend past either end, so the
    // position reads as more than the regression's own weight.)
    for (const day of [55, 70, 82, 88]) {
      expect(leanTowardReg(day)).toBeLessThan(0.5);
    }
  });
});

describe("computeAdvancedPace — least-squares rolling rate", () => {
  it("is robust to a single noisy final snapshot", () => {
    // Seven days of clean slope-10 growth, then a spurious high final point.
    const base = [];
    for (let i = 44; i <= 51; i++) base.push({ t: qStart.getTime() + i * DAY, val: 10 * i });
    const noisy = base.map((s, idx) => idx === base.length - 1 ? { ...s, val: s.val + 60 } : s);
    const current = noisy[noisy.length - 1].val;

    const first = noisy[0], last = noisy[noisy.length - 1];
    const endpointSlope = (last.val - first.val) / ((last.t - first.t) / DAY);

    const pace = computeAdvancedPace(current, qStart, qEnd, null, noisy, 0, new Date(last.t));
    expect(pace.dailyRate).toBeGreaterThan(0);
    // Least-squares should not chase the inflated endpoint the way a
    // first-vs-last difference would.
    expect(pace.dailyRate).toBeLessThan(endpointSlope);
  });
});

// Mostly-flat background (2/day) with one huge spike day (200), so a robust
// model should read the background as ~2/day, not be dragged toward the
// spike the way a mean or regression slope would be.
function spikeSnapshots() {
  const snaps = [];
  let acc = 0;
  for (let i = 0; i <= 30; i++) {
    if (i > 0) acc += (i === 15 ? 200 : 2);
    snaps.push({ t: qStart.getTime() + i * DAY, val: acc });
  }
  return snaps;
}

describe("computeSporadicPace", () => {
  it("returns null before the quarter is a week in", () => {
    expect(computeSporadicPace(50, qStart, qEnd, [], new Date(qStart.getTime() + 3 * DAY))).toBeNull();
  });

  it("falls back to the plain average rate with no delta history", () => {
    const asOf = new Date(qStart.getTime() + 10 * DAY);
    const pace = computeSporadicPace(100, qStart, qEnd, [], asOf);
    expect(pace.dailyRate).toBeCloseTo(10, 5); // 100 / 10 days
    expect(pace.projected).toBeCloseTo(10 * 92, 5);
    expect(pace.components).toEqual({ simple: pace.projected, rolling: null, reg: null });
    expect(pace.spikeFrequency).toBe(0);
  });

  it("reads the background rate from the median, unmoved by a single spike day", () => {
    const history = spikeSnapshots();
    const current = history[history.length - 1].val; // 29*2 + 200 = 258
    const asOf = new Date(qStart.getTime() + 30 * DAY);
    const pace = computeSporadicPace(current, qStart, qEnd, history, asOf);
    expect(pace.dailyRate).toBeCloseTo(2, 5);
    expect(pace.background).toBeCloseTo(2, 5);
  });

  it("adds a damped spike bonus instead of ignoring spikes or extrapolating one", () => {
    const history = spikeSnapshots();
    const current = history[history.length - 1].val; // 258
    const asOf = new Date(qStart.getTime() + 30 * DAY);
    const pace = computeSporadicPace(current, qStart, qEnd, history, asOf);
    const dRemaining = 92 - 30;
    const backgroundOnly = current + 2 * dRemaining; // no-spike floor
    const naiveSpikeExtrapolation = current + 200 * dRemaining; // treats 200/day as the new rate
    expect(pace.spikeFrequency).toBeCloseTo(1 / 30, 5);
    expect(pace.projected).toBeGreaterThan(backgroundOnly);
    expect(pace.projected).toBeLessThan(naiveSpikeExtrapolation / 10); // nowhere close to naive
  });

  it("exposes the no-spike vs with-spike scenarios as components, for the band's disagreement term", () => {
    const history = spikeSnapshots();
    const current = history[history.length - 1].val;
    const asOf = new Date(qStart.getTime() + 30 * DAY);
    const pace = computeSporadicPace(current, qStart, qEnd, history, asOf);
    expect(pace.components.rolling).toBeNull();
    expect(pace.components.reg).toBeGreaterThan(pace.components.simple);
  });
});

describe("computePace", () => {
  it("marks the Comments metric as sporadic", () => {
    expect(METRICS.find(m => m.id === "comments").sporadic).toBe(true);
  });

  it("dispatches to the sporadic model when metric.sporadic is set", () => {
    const history = spikeSnapshots();
    const current = history[history.length - 1].val;
    const asOf = new Date(qStart.getTime() + 30 * DAY);
    const viaDispatch = computePace({ id: "comments", sporadic: true }, current, qStart, qEnd, null, history, 0, asOf);
    const viaDirect = computeSporadicPace(current, qStart, qEnd, history, asOf);
    expect(viaDispatch.projected).toBeCloseTo(viaDirect.projected, 6);
  });

  it("falls through to the general blend for ordinary metrics", () => {
    const history = spikeSnapshots();
    const current = history[history.length - 1].val;
    const asOf = new Date(qStart.getTime() + 30 * DAY);
    const viaDispatch = computePace({ id: "impressions" }, current, qStart, qEnd, null, history, 0, asOf);
    const viaDirect = computeAdvancedPace(current, qStart, qEnd, null, history, 0, asOf);
    expect(viaDispatch.projected).toBeCloseTo(viaDirect.projected, 6);
  });
});

describe("buildProjectionAudit — stage-weighted calibration", () => {
  const snapshotHistory = decelSnapshots();
  const actual = snapshotHistory[snapshotHistory.length - 1].vals.m;
  const common = {
    metric,
    actualValue: actual,
    completedQuarter: { start: qStart, end: qEnd },
    previousQuarter: { start: new Date(2025, 11, 1), end: qStart },
    previousQuarterValue: 1800,
    twoBackValue: null,
    snapshotHistory,
  };

  it("does not throw when the prior quarter has snapshots in its first week", () => {
    // Regression guard: a <7-day sample makes computeAdvancedPace return
    // null; the audit must skip it instead of dereferencing null.
    expect(() => buildProjectionAudit({ ...common, targetElapsedFraction: 0.8 })).not.toThrow();
  });

  it("tracks late-stage accuracy better than the equal-weight mean", () => {
    const equal = buildProjectionAudit({ ...common, targetElapsedFraction: null });
    const lateStage = buildProjectionAudit({ ...common, targetElapsedFraction: 0.85 });
    expect(equal).not.toBeNull();
    expect(lateStage).not.toBeNull();
    // Compare the raw (pre-dampening) ratio so this isolates stage-weighting.
    // Equal weighting is dragged down by early over-projection; stage-matching
    // to a near-complete quarter recovers a ratio materially closer to 1.
    expect(lateStage.accuracyRatio).toBeGreaterThan(equal.accuracyRatio + 0.05);
    expect(lateStage.accuracyRatio).toBeGreaterThan(0.8);
  });

  it("keeps the calibration factor within sane bounds", () => {
    const audit = buildProjectionAudit({ ...common, targetElapsedFraction: 0.5 });
    expect(audit.calibrationFactor).toBeGreaterThanOrEqual(0.5);
    expect(audit.calibrationFactor).toBeLessThanOrEqual(1.5);
  });

  it("returns a sane band (low <= high, positive width) alongside the point estimate", () => {
    const audit = buildProjectionAudit({ ...common, targetElapsedFraction: 0.5 });
    expect(audit.bandRelHalf).toBeGreaterThan(0);
    expect(audit.bandLow).toBeLessThanOrEqual(audit.bandHigh);
  });
});

describe("buildProjectionAudit — band coverage", () => {
  // A near-perfectly linear series: every stage's projection should land
  // very close to the true final, so the band is a clean test of coverage
  // logic rather than being entangled with how well the model itself fit
  // (that's what the decelerating-series tests above are for).
  function linearSnapshots(rate = 10) {
    const snaps = [];
    for (let i = 0; i <= 92; i++) snaps.push({ t: qStart.getTime() + i * DAY, vals: { m: rate * i } });
    return snaps;
  }
  const snapshotHistory = linearSnapshots();
  const actual = snapshotHistory[snapshotHistory.length - 1].vals.m;
  const common = {
    metric,
    actualValue: actual,
    completedQuarter: { start: qStart, end: qEnd },
    previousQuarter: { start: new Date(2025, 11, 1), end: qStart },
    previousQuarterValue: 800,
    twoBackValue: null,
    snapshotHistory,
  };

  it("flags coverage true when the actual final lands inside the band", () => {
    const audit = buildProjectionAudit({ ...common, targetElapsedFraction: 0.5 });
    expect(audit.bandCovered).toBe(true);
    expect(audit.actual).toBeGreaterThanOrEqual(audit.bandLow);
    expect(audit.actual).toBeLessThanOrEqual(audit.bandHigh);
  });

  it("flags coverage false when the actual final lands far outside the band", () => {
    // Same projection trajectory, but a wildly different actual — the band
    // itself (built only from the trajectory) can't have moved to cover it.
    const audit = buildProjectionAudit({ ...common, actualValue: common.actualValue * 5, targetElapsedFraction: 0.5 });
    expect(audit.bandCovered).toBe(false);
    expect(audit.bandHigh).toBeLessThan(audit.actual);
  });
});

describe("buildProjectionAudit — self-dampening on poor fit", () => {
  const lastVal = snaps => snaps[snaps.length - 1].vals.m;
  const base = {
    metric,
    completedQuarter: { start: qStart, end: qEnd },
    previousQuarter: { start: new Date(2025, 11, 1), end: qStart },
    previousQuarterValue: 1800,
    twoBackValue: null,
    targetElapsedFraction: 0.85,
  };

  it("keeps near-full confidence on a clean, dense prior quarter", () => {
    const snapshotHistory = decelSnapshots();
    const audit = buildProjectionAudit({ ...base, actualValue: lastVal(snapshotHistory), snapshotHistory });
    expect(audit.calibrationConfidence).toBeGreaterThan(0.8);
    // A real correction survives — it is not shrunk away to ≈1.
    expect(audit.calibrationFactor).toBeGreaterThan(0.8);
    expect(audit.calibrationFactor).toBeLessThan(0.95);
  });

  it("shrinks the factor toward 1 when the fit was scattered", () => {
    // Same decelerating trend, but a day-to-day zig-zag so the fit is noisy.
    const snapshotHistory = decelSnapshots().map((s, i) => ({
      t: s.t, vals: { m: s.vals.m * (1 + (i % 2 ? -0.06 : 0.06)) },
    }));
    const clean = buildProjectionAudit({ ...base, actualValue: lastVal(decelSnapshots()), snapshotHistory: decelSnapshots() });
    const noisy = buildProjectionAudit({ ...base, actualValue: lastVal(snapshotHistory), snapshotHistory });
    expect(noisy.calibrationConfidence).toBeLessThan(clean.calibrationConfidence);
    // The damped factor is at least as close to 1 as the raw clamped ratio.
    const rawClamped = Math.min(1.5, Math.max(0.5, noisy.accuracyRatio));
    expect(Math.abs(noisy.calibrationFactor - 1)).toBeLessThanOrEqual(Math.abs(rawClamped - 1) + 1e-9);
  });

  it("shrinks the factor toward 1 when near-stage support is thin", () => {
    // Only three snapshots in the whole quarter → little effective support.
    const all = decelSnapshots();
    const snapshotHistory = [all[12], all[50], all[85]];
    const audit = buildProjectionAudit({ ...base, actualValue: lastVal(all), snapshotHistory });
    expect(audit).not.toBeNull();
    expect(audit.calibrationConfidence).toBeLessThan(0.7);
  });
});

describe("blendCalibrationHistory", () => {
  it("returns null (not 1) on empty history, so callers can fall back", () => {
    expect(blendCalibrationHistory([])).toBeNull();
    expect(blendCalibrationHistory(null)).toBeNull();
  });

  it("weights the most recent quarter more than older ones", () => {
    // Most-recent-first: last quarter said "scale up 1.3x", everything
    // before that said "scale down 0.8x". The blend should land closer to
    // the recent value than a plain average would.
    const history = [
      { calibration_factor: 1.3, calibration_confidence: 1 },
      { calibration_factor: 0.8, calibration_confidence: 1 },
      { calibration_factor: 0.8, calibration_confidence: 1 },
      { calibration_factor: 0.8, calibration_confidence: 1 },
    ];
    const blended = blendCalibrationHistory(history);
    const plainAverage = (1.3 + 0.8 + 0.8 + 0.8) / 4;
    expect(blended).toBeGreaterThan(plainAverage);
  });

  it("gives near-zero weight to a quarter whose own confidence was low", () => {
    const confident = blendCalibrationHistory([
      { calibration_factor: 1.4, calibration_confidence: 1 },
    ]);
    const unsure = blendCalibrationHistory([
      { calibration_factor: 1.4, calibration_confidence: 0.05 },
    ]);
    // Both are single-entry, so confidence has no other factor to average
    // against — but the clamp still applies; check the unsure one shrinks
    // toward 1 relative to the confident one once mixed with a neutral prior.
    const mixed = blendCalibrationHistory([
      { calibration_factor: 1.4, calibration_confidence: 0.05 },
      { calibration_factor: 1.0, calibration_confidence: 1 },
    ]);
    expect(confident).toBeCloseTo(1.4, 5);
    expect(mixed).toBeLessThan(confident);
    expect(unsure).toBeCloseTo(1.4, 5); // no competing sample to be pulled toward
  });

  it("stays within the same sane bounds as a single-quarter calibration factor", () => {
    const blended = blendCalibrationHistory([
      { calibration_factor: 5, calibration_confidence: 1 },
    ]);
    expect(blended).toBeLessThanOrEqual(1.5);
  });

  it("skips malformed entries instead of throwing", () => {
    const blended = blendCalibrationHistory([
      { calibration_factor: NaN, calibration_confidence: 1 },
      { calibration_factor: 1.2, calibration_confidence: 1 },
    ]);
    expect(blended).toBeCloseTo(1.2, 5);
  });
});

describe("annotateTimelineSpikes", () => {
  // A mostly-flat projection that drifts ~1/day, then jumps +60 on day 5.
  // Day 5's window is the only one that contains a post. Snapshots are
  // captured mid-day (like real captured_at times), so a calendar-dated post
  // at midnight falls cleanly inside a window rather than on its boundary.
  const HALF_DAY = DAY / 2;
  function flatThenSpike() {
    const t0 = qStart.getTime() + HALF_DAY;
    const proj = [100, 101, 100.5, 101.5, 102, 162, 163, 162.5];
    return proj.map((projected, i) => ({ t: t0 + i * DAY, projected }));
  }
  const dayStr = i => new Date(qStart.getTime() + i * DAY).toISOString().slice(0, 10);

  it("returns the timeline unchanged when there are no posts", () => {
    const tl = flatThenSpike();
    const out = annotateTimelineSpikes(tl, []);
    expect(out).toHaveLength(tl.length);
    expect(out.some(p => p.spike)).toBe(false);
  });

  it("attributes a sharp jump to a post published in that window", () => {
    const tl = flatThenSpike();
    // Post is dated day 5 (midnight), landing in the day-5 snapshot's window
    // → drives the +60 jump.
    const out = annotateTimelineSpikes(tl, [
      { post_name: "Big winner", post_date: dayStr(5), impressions: 5000 },
    ]);
    const spikes = out.filter(p => p.spike);
    expect(spikes).toHaveLength(1);
    expect(spikes[0].spike.post.post_name).toBe("Big winner");
    expect(spikes[0].spike.direction).toBe("up");
    expect(spikes[0].spike.deltaPct).toBeGreaterThan(0);
  });

  it("picks the most-viewed post when several land in the same window", () => {
    const tl = flatThenSpike();
    const out = annotateTimelineSpikes(tl, [
      { post_name: "Small", post_date: dayStr(5), impressions: 200 },
      { post_name: "Huge",  post_date: dayStr(5), impressions: 9000 },
    ]);
    const spike = out.find(p => p.spike);
    expect(spike.spike.post.post_name).toBe("Huge");
  });

  it("does not flag a spike whose window has no post", () => {
    const tl = flatThenSpike();
    // Post lands far from the jump (day 1), so the day-5 spike is unexplained.
    const out = annotateTimelineSpikes(tl, [
      { post_name: "Unrelated", post_date: dayStr(1), impressions: 5000 },
    ]);
    // Day-1 movement is tiny, so even with a post there it isn't a spike.
    expect(out.some(p => p.spike)).toBe(false);
  });

  it("does not over-flag a steadily drifting projection", () => {
    const t0 = qStart.getTime();
    const tl = Array.from({ length: 10 }, (_, i) => ({ t: t0 + i * DAY, projected: 100 + i * 5 }));
    const posts = tl.map((p, i) => ({ post_name: `p${i}`, post_date: new Date(p.t).toISOString().slice(0, 10), impressions: 100 }));
    const out = annotateTimelineSpikes(tl, posts);
    // Uniform +5/day movement: nothing stands out against the median.
    expect(out.some(p => p.spike)).toBe(false);
  });

  it("handles short or missing input without throwing", () => {
    expect(annotateTimelineSpikes([], [])).toEqual([]);
    expect(annotateTimelineSpikes(null, [])).toEqual([]);
    expect(annotateTimelineSpikes([{ t: 1, projected: 5 }], [])).toHaveLength(1);
  });
});

describe("projectionBand", () => {
  const pace = (projected, components, elapsedFraction) => ({ projected, components, elapsedFraction });

  it("returns null when there is no usable projection", () => {
    expect(projectionBand(null, {})).toBeNull();
    expect(projectionBand({ projected: 0 }, {})).toBeNull();
    expect(projectionBand({ projected: NaN }, {})).toBeNull();
  });

  it("brackets the point estimate: low ≤ expected ≤ high", () => {
    const band = projectionBand(pace(1000, { simple: 1100, rolling: 980, reg: 1020 }, 0.5), { elapsedFraction: 0.5 });
    expect(band.low).toBeLessThanOrEqual(band.expected);
    expect(band.high).toBeGreaterThanOrEqual(band.expected);
    expect(band.expected).toBe(1000);
  });

  it("widens when the three methods disagree", () => {
    const tight = projectionBand(pace(1000, { simple: 1000, rolling: 1005, reg: 995 }, 0.5), { elapsedFraction: 0.5 });
    const wide  = projectionBand(pace(1000, { simple: 1300, rolling: 800,  reg: 1000 }, 0.5), { elapsedFraction: 0.5 });
    expect(wide.relHalf).toBeGreaterThan(tight.relHalf);
  });

  it("narrows as the quarter completes", () => {
    const comps = { simple: 1100, rolling: 950, reg: 1010 };
    const early = projectionBand(pace(1000, comps, 0.2), { elapsedFraction: 0.2 });
    const late  = projectionBand(pace(1000, comps, 0.9), { elapsedFraction: 0.9 });
    expect(late.relHalf).toBeLessThan(early.relHalf);
  });

  it("widens with a worse empirical track record, and the effect fades late", () => {
    const comps = { simple: 1000, rolling: 1000, reg: 1000 }; // no method spread
    const clean = projectionBand(pace(1000, comps, 0.4), { elapsedFraction: 0.4, empiricalErrorPct: 2 });
    const messy = projectionBand(pace(1000, comps, 0.4), { elapsedFraction: 0.4, empiricalErrorPct: 25 });
    expect(messy.relHalf).toBeGreaterThan(clean.relHalf);
    // By quarter's end the empirical contribution is gone (remaining → 0).
    const messyLate = projectionBand(pace(1000, comps, 1), { elapsedFraction: 1, empiricalErrorPct: 25 });
    expect(messyLate.relHalf).toBeCloseTo(0.01, 5); // clamped floor only
  });

  it("shrinks sub-linearly, so a nearly-finished quarter keeps an honest range", () => {
    // No method spread, so the band is purely the time-remaining terms. Halving
    // the time left must *not* halve the band: the square-root drift term
    // dominates late, which is what lifts end-of-quarter coverage to ~80%.
    const comps = { simple: 1000, rolling: 1000, reg: 1000 };
    const at = (f) => projectionBand(pace(1000, comps, f), { elapsedFraction: f }).relHalf;
    const tenLeft  = at(0.90);
    const fiveLeft = at(0.95);
    expect(fiveLeft).toBeGreaterThan(tenLeft * 0.5);
    // And it is meaningfully wider than the linear drift term alone would give.
    expect(tenLeft).toBeGreaterThan(0.10 * 0.12 * 1.5);
  });

  it("still collapses to the floor once the quarter is over", () => {
    const comps = { simple: 1000, rolling: 1000, reg: 1000 };
    expect(projectionBand(pace(1000, comps, 1), { elapsedFraction: 1 }).relHalf).toBeCloseTo(0.01, 5);
  });

  it("floors the low end at the value already banked", () => {
    // Big band, but we've already accrued 990 — the final can't come in below it.
    const band = projectionBand(pace(1000, { simple: 1400, rolling: 700, reg: 1000 }, 0.3), { elapsedFraction: 0.3, current: 990 });
    expect(band.low).toBe(990);
  });
});

describe("detectTrendsAnomalies", () => {
  const currentQuarter = { start: new Date(2026, 2, 1), end: new Date(2026, 5, 1), label: "Q3" };
  const now = new Date(2026, 3, 1); // ~31 days into the quarter
  // A healthy current quarter: dense, monotonically rising impressions, fresh.
  function healthySnaps() {
    const snaps = [];
    // Up to ~half a day before `now`, so the fixture isn't itself stale.
    for (let i = 0; i <= 30; i++) {
      snaps.push({ t: currentQuarter.start.getTime() + i * DAY + DAY / 2, vals: { impressions: 100 + i * 10 } });
    }
    return snaps;
  }
  const qdata = [
    { overall: { impressions: 500 } },  // two-back
    { overall: { impressions: 800 } },  // previous (has a value)
    { overall: { impressions: 380 } },  // current
  ];

  it("reports no flags for a fresh, dense, rising quarter", () => {
    const flags = detectTrendsAnomalies({ snaps: healthySnaps(), qdata, currentQuarter, now });
    expect(flags).toEqual([]);
  });

  it("flags stale snapshots when the latest is several days old", () => {
    const stale = healthySnaps().map(s => ({ ...s, t: s.t - 6 * DAY }));
    const flags = detectTrendsAnomalies({ snaps: stale, qdata, currentQuarter, now });
    expect(flags.some(f => f.type === "stale")).toBe(true);
  });

  it("flags a cumulative metric that moved backward", () => {
    const snaps = healthySnaps();
    snaps[20].vals.impressions = 50; // sudden drop below its neighbours
    const flags = detectTrendsAnomalies({ snaps, qdata, currentQuarter, now });
    expect(flags.some(f => f.type === "backward" && f.metricId === "impressions")).toBe(true);
  });

  it("flags a metric present last quarter but missing this quarter", () => {
    const missing = [qdata[0], qdata[1], { overall: {} }];
    const flags = detectTrendsAnomalies({ snaps: healthySnaps(), qdata: missing, currentQuarter, now });
    expect(flags.some(f => f.type === "missing" && f.metricId === "impressions")).toBe(true);
  });

  it("flags thin history deep into the quarter", () => {
    const thin = [
      { t: currentQuarter.start.getTime() + 5 * DAY, vals: { impressions: 120 } },
      { t: currentQuarter.start.getTime() + 20 * DAY, vals: { impressions: 300 } },
    ];
    const flags = detectTrendsAnomalies({ snaps: thin, qdata, currentQuarter, now });
    expect(flags.some(f => f.type === "thin" && f.metricId === "impressions")).toBe(true);
  });

  it("returns nothing without a current quarter", () => {
    expect(detectTrendsAnomalies({})).toEqual([]);
  });
});

describe("buildTrendsNarrative", () => {
  const currentQuarter = { label: "Q3" };
  const pacing = [
    { metric: { id: "impressions", label: "Impressions" }, rateVsQ2: 22 },
    { metric: { id: "shares", label: "Shares" }, rateVsQ2: -8 },
  ];
  const drivers = { topPost: { post_name: "Big winner", impressions: 9000 } };

  it("returns empty when there's nothing beyond the elapsed line", () => {
    expect(buildTrendsNarrative({ currentQuarter, elapsedPct: 30 })).toBe("");
  });

  it("leads with the elapsed quarter and the pacing leader / laggard", () => {
    const s = buildTrendsNarrative({ currentQuarter, elapsedPct: 30, pacing });
    expect(s).toContain("Q3 is 30% elapsed");
    expect(s).toContain("Impressions is pacing 22% ahead");
    expect(s).toContain("Shares runs 8% behind");
  });

  it("names the top post and weaves in accuracy and warnings", () => {
    const s = buildTrendsNarrative({
      currentQuarter, elapsedPct: 50, pacing, drivers,
      overallAccuracyPct: 4.2,
      anomalies: [{ severity: "warn" }, { severity: "info" }],
    });
    expect(s).toContain("“Big winner”");
    expect(s).toContain("9,000 impressions");
    expect(s).toContain("±4.2%");
    expect(s).toContain("1 data-quality issue needs");
  });

  it("handles an all-behind quarter without claiming anyone is ahead", () => {
    const behind = [
      { metric: { id: "shares", label: "Shares" }, rateVsQ2: -8 },
      { metric: { id: "posts", label: "Posts Published" }, rateVsQ2: -40 },
    ];
    const s = buildTrendsNarrative({ currentQuarter, elapsedPct: 60, pacing: behind });
    expect(s).toContain("running below last quarter's rate");
    expect(s).toContain("Shares is closest");
    expect(s).not.toContain("ahead");
  });

  it("says the quarter is complete when it is", () => {
    const s = buildTrendsNarrative({ currentQuarter, complete: true, pacing });
    expect(s).toContain("Q3 is complete");
  });
});
