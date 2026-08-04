// Shapes the "How did you hear about us?" week × answer counts into rows the
// report can draw, and picks out the one answer that actually spiked.

const addDays = (key, n) => {
  const [y, m, d] = key.split("-").map(Number);
  const dt = new Date(y, m - 1, d + n);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
};

function median(values) {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Zero-fill the week × answer counts across the quarter's weeks.
 *
 * @param sourceWeekly [{ week, source, count }] — sparse, from the stats RPC
 * @param sources      [{ source, count }]       — quarter totals, already ranked
 * @param weekKeys     ["YYYY-MM-DD"]            — every Monday in the quarter, in order
 * @param since        "YYYY-MM-DD" | null       — first day the question was asked
 * @returns { rows, max, coveredFrom } where coveredFrom is the index of the
 *   first week the question existed for — earlier weeks are blank because the
 *   form wasn't asking, not because nobody answered.
 */
export function buildSourceTrend({ sourceWeekly, sources, weekKeys, since }) {
  const empty = { rows: [], max: 0, coveredFrom: 0 };
  if (!sources?.length || !weekKeys?.length) return empty;

  const index = new Map(weekKeys.map((k, i) => [k, i]));
  const counts = new Map(sources.map(s => [s.source, Array(weekKeys.length).fill(0)]));
  for (const r of sourceWeekly || []) {
    const i = index.get(r.week);
    const row = counts.get(r.source);
    if (i !== undefined && row) row[i] += r.count;
  }

  // A week counts as covered once any of its days falls on or after `since`.
  const coveredFrom = since
    ? Math.max(0, weekKeys.findIndex(k => addDays(k, 6) >= since))
    : 0;

  const rows = sources.map(s => {
    const values = counts.get(s.source);
    let peak = 0, peakAt = coveredFrom;
    for (let i = coveredFrom; i < values.length; i++) {
      if (values[i] > peak) { peak = values[i]; peakAt = i; }
    }
    return { source: s.source, total: s.count, values, peak, peakAt };
  });

  return { rows, max: Math.max(1, ...rows.map(r => r.peak)), coveredFrom };
}

/**
 * The answer with the most consequential week — the one that put the most
 * extra submissions on the board relative to its own normal week. Doubling
 * is the gate (so a flat answer never qualifies) but the ranking is by extra
 * submissions, not by ratio: 1 → 9 is a big multiple and a small event, while
 * 13 → 51 is the week someone actually needs to know about.
 *
 * Returns null when nothing is unusual enough to be worth calling out — a
 * quiet quarter should say nothing rather than manufacture a headline.
 */
export function findSourceSpike(rows, coveredFrom = 0) {
  let best = null;
  for (const r of rows) {
    const covered = r.values.slice(coveredFrom);
    if (covered.length < 4 || r.peak < 5) continue;
    // Compare the peak against the answer's other weeks, not against itself.
    const rest = covered.filter((_, i) => i + coveredFrom !== r.peakAt);
    const typical = median(rest);
    if (typical > 0 && r.peak < typical * 2) continue;
    const excess = r.peak - typical;
    if (!best || excess > best.excess) {
      best = { source: r.source, count: r.peak, at: r.peakAt, typical, excess };
    }
  }
  return best;
}
