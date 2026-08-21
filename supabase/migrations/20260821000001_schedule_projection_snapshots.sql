-- Capture projection snapshots on a schedule instead of on page loads.
--
-- Until now the only thing writing projection_snapshots was the browser:
-- useTrendsData's snapshotAllAgencies() fired whenever someone opened the
-- Trends tab. That made snapshot density a function of who happened to visit,
-- which is why the recorded history has weekend gaps and a five-day hole in
-- early August, and why AS and ADS went stale for weeks without anything
-- noticing. Every projection and every calibration factor is derived from this
-- series, so its density is the ceiling on how good the forecasts can get.
--
-- Doing it in the database keeps the whole job in one place: no edge function,
-- no service-role key in a scheduler, no network hop. The snapshot is a pure
-- copy of the current quarter's KPI row, which is already plain SQL.

create extension if not exists pg_cron with schema cron;

-- Which fiscal quarter (suffix + year label) a given date falls in. Mirrors
-- Q_DEFS/buildQuarter in src/config.js: the fiscal year starts in September,
-- and a quarter is labelled with the calendar year of its last day.
create or replace function public.fiscal_quarter(d date)
returns table (suffix text, year text)
language sql
immutable
as $$
  select
    case
      when extract(month from d) between 9 and 11 then 'q1'
      when extract(month from d) = 12
        or extract(month from d) between 1 and 2   then 'q2'
      when extract(month from d) between 3 and 5   then 'q3'
      else                                              'q4'
    end,
    case
      when extract(month from d) = 12
        then (extract(year from d) + 1)::text
      else extract(year from d)::text
    end;
$$;

-- Copy today's KPI totals into projection_snapshots for every agency that has
-- a row for the current quarter. Idempotent: re-running on the same day
-- overwrites that day's snapshot rather than adding another.
create or replace function public.capture_projection_snapshots()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  today date := (now() at time zone 'America/Halifax')::date;
  q     record;
  n     integer := 0;
begin
  select * into q from public.fiscal_quarter(today);

  insert into public.projection_snapshots (agency, quarter, year, snapshot_date, captured_at, vals)
  select
    r.agency,
    q.suffix,
    q.year,
    today,
    now(),
    jsonb_strip_nulls(jsonb_build_object(
      'posts',       k.posts,
      'impressions', k.impressions,
      'shares',      k.shares,
      'reactions',   k.reactions,
      'followers',   k.followers,
      'linkclicks',  k.link_clicks,
      'comments',    k.comments
    ))
  from public.social_reports r
  join public.social_kpis    k on k.report_id = r.id
  where r.quarter = q.suffix
    and r.year    = q.year
  on conflict (agency, quarter, year, snapshot_date)
  do update set captured_at = excluded.captured_at,
                vals        = excluded.vals;

  get diagnostics n = row_count;
  return n;
end;
$$;

revoke all on function public.capture_projection_snapshots() from public, anon, authenticated;

-- 11:00 UTC daily — early morning in America/Halifax, after the previous day
-- has fully closed out and before anyone is likely to be reading the report.
select cron.schedule(
  'capture-projection-snapshots',
  '0 11 * * *',
  $$select public.capture_projection_snapshots();$$
);

-- With the capture owned by the scheduler, browsers no longer need to write
-- here. Drop the anon write policies: reads stay open, writes are the cron
-- job's alone.
drop policy if exists "anon insert" on public.projection_snapshots;
drop policy if exists "anon update" on public.projection_snapshots;
