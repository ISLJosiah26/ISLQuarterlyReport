import React from "react";

function Block({ w = "100%", h = 14, style }) {
  return (
    <div
      className="skel-block"
      style={{ width: w, height: h, borderRadius: 2, ...style }}
      aria-hidden="true"
    />
  );
}

function KpiCard() {
  return (
    <div style={{ paddingTop: 16, borderTop: "1px solid var(--ink)", display: "flex", flexDirection: "column", gap: 14 }}>
      <Block w="55%" h={11} />
      <Block w="72%" h={50} />
      <Block w="38%" h={13} />
    </div>
  );
}

function RowSkel() {
  return (
    <div style={{ padding: "26px 0", borderTop: "1px solid var(--rule-soft)" }}>
      <Block h={20} />
    </div>
  );
}

// The Paid page is a list of campaigns rather than a KPI grid — its metrics
// live inside each campaign, so its skeleton is rows all the way down.
function CampaignSkeleton() {
  return (
    <div style={{ paddingTop: 26, borderTop: "1px solid var(--rule)", display: "flex", justifyContent: "space-between", gap: 24, flexWrap: "wrap" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 10, flex: "1 1 280px" }}>
        <Block w="52%" h={24} />
        <Block w="34%" h={16} />
      </div>
      <div style={{ display: "flex", gap: 28 }}>
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <Block w={54} h={9} />
            <Block w={70} h={19} />
          </div>
        ))}
      </div>
    </div>
  );
}

export function PageSkeleton({ view = "social" }) {
  const kpiCount = view === "web" ? 6 : 8;

  if (view === "paid") {
    return (
      <main className="report-wrap" aria-hidden="true" aria-busy="true">
        <section className="hero wrap">
          <div className="hero-b-top">
            <div className="hero-b-left">
              <Block w={110} h={44} />
              <div className="hero-b-divider" />
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <Block w={150} h={14} />
                <Block w={90}  h={12} />
              </div>
            </div>
          </div>
          <Block w="min(60ch, 100%)" h={22} style={{ marginTop: 24 }} />
        </section>
        <section className="section wrap">
          <header className="section-head"><Block w={180} h={36} /></header>
          <div style={{ display: "flex", flexDirection: "column", gap: 26 }}>
            {Array.from({ length: 4 }).map((_, i) => <CampaignSkeleton key={i} />)}
          </div>
        </section>
      </main>
    );
  }

  return (
    <main className="report-wrap" aria-hidden="true" aria-busy="true">
      {/* Hero */}
      <section className="hero wrap">
        <div className="hero-b-top">
          <div className="hero-b-left">
            <Block w={110} h={44} />
            <div className="hero-b-divider" />
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <Block w={150} h={14} />
              <Block w={90}  h={12} />
            </div>
          </div>
        </div>
        <Block w="min(60ch, 100%)" h={22} style={{ marginTop: 24 }} />
      </section>

      {/* KPI section */}
      <section className="section wrap">
        <header className="section-head">
          <Block w={180} h={36} />
        </header>
        <div className="kpi-grid">
          {Array.from({ length: kpiCount }).map((_, i) => <KpiCard key={i} />)}
        </div>
      </section>

      {/* Second section rows */}
      <section className="section wrap">
        <header className="section-head">
          <Block w={220} h={36} />
        </header>
        {Array.from({ length: 5 }).map((_, i) => <RowSkel key={i} />)}
      </section>
    </main>
  );
}
