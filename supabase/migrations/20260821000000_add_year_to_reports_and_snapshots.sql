-- Give every report and snapshot a fiscal year.
--
-- social_reports was keyed (agency, quarter) with no year, so the table could
-- only ever hold one fiscal year: when the calendar rolled around to the same
-- quarter suffix again, the admin form's upsert would overwrite last year's
-- row and social_kpis would be deleted and reinserted under the same
-- report_id. That is destructive on its own, and it also breaks the current
-- quarter the moment the fiscal year turns over — the Trends page reads
-- quarter='q1' and gets *last* year's Sep-Nov totals as this quarter's
-- progress, then writes them into projection_snapshots as if they were today's
-- numbers.
--
-- Adding the year makes a quarter uniquely identifiable, keeps prior years
-- intact, and is the prerequisite for any same-quarter-last-year comparison --
-- which for a seasonal staffing business is a far better prior than the
-- previous quarter.
--
-- Year convention matches src/config.js buildQuarter(): the calendar year of
-- the quarter's last day. The fiscal year starts in September, so the only
-- quarter whose label differs from the calendar year of its own months is q2
-- (Dec-Feb), where a December date belongs to the following year's label.

-- ─── social_reports ───────────────────────────────────────────────
alter table public.social_reports
  add column if not exists year text;

-- Existing rows are the Sep 2025 - Aug 2026 fiscal year: q1 ran Sep-Nov 2025,
-- the rest closed in 2026.
update public.social_reports
   set year = case when quarter = 'q1' then '2025' else '2026' end
 where year is null;

alter table public.social_reports
  alter column year set not null;

alter table public.social_reports
  drop constraint if exists social_reports_agency_quarter_key;

alter table public.social_reports
  add constraint social_reports_agency_quarter_year_key
  unique (agency, quarter, year);

-- ─── projection_snapshots ─────────────────────────────────────────
-- Same problem one layer down: loadSnapshots() filters on (agency, quarter)
-- with no date bound, so from the second year onward a quarter's history would
-- silently include the previous year's snapshots for the same suffix.
alter table public.projection_snapshots
  add column if not exists year text;

-- Derived from the snapshot date rather than hardcoded, so the backfill is
-- correct for any row: a December snapshot belongs to q2, whose label is the
-- next calendar year; every other month labels with its own year.
update public.projection_snapshots
   set year = case
                when extract(month from snapshot_date) = 12
                  then (extract(year from snapshot_date) + 1)::text
                else extract(year from snapshot_date)::text
              end
 where year is null;

alter table public.projection_snapshots
  alter column year set not null;

alter table public.projection_snapshots
  drop constraint if exists projection_snapshots_agency_quarter_snapshot_date_key;

alter table public.projection_snapshots
  add constraint projection_snapshots_agency_quarter_year_snapshot_date_key
  unique (agency, quarter, year, snapshot_date);
