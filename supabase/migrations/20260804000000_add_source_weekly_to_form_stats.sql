-- Add a week × source breakdown to the contact-form stats, so the report can
-- show how "How did you hear about us?" answers move over the quarter rather
-- than only their end-of-quarter totals. Still non-PII: counts only.
create or replace function public.form_submission_stats(
  p_agency text,
  p_start  date,
  p_end    date
) returns jsonb
language sql
stable
security definer
set search_path = public
as $$
with rows as (
  select * from form_submissions
  where agency = p_agency
    and submitted_at >= p_start
    and submitted_at < p_end
),
-- "How did you hear about us?" was added to the form later; blanks from
-- before the first answer mean "question didn't exist", not non-response.
source_era as (
  select min(submitted_at) as since
  from form_submissions
  where agency = p_agency and source <> ''
)
select jsonb_build_object(
  'totals', (select jsonb_build_object(
      'total',        count(*),
      'work',         count(*) filter (where intent = 'work'),
      'staff',        count(*) filter (where intent = 'staff'),
      'optIn',        count(*) filter (where accepts_marketing),
      'withDocument', count(*) filter (where document_url <> '')
    ) from rows),
  'weekly', (select coalesce(jsonb_agg(to_jsonb(w) order by w.week), '[]'::jsonb) from (
      select date_trunc('week', submitted_at)::date as week,
             count(*)                                    as total,
             count(*) filter (where intent = 'work')     as work,
             count(*) filter (where intent = 'staff')    as staff,
             count(*) filter (where accepts_marketing)   as "optIn"
      from rows group by 1
    ) w),
  'locations', (select coalesce(jsonb_agg(to_jsonb(l) order by l.total desc), '[]'::jsonb) from (
      select trim(split_part(location, ',', 1))          as location,
             count(*)                                    as total,
             count(*) filter (where intent = 'work')     as work,
             count(*) filter (where intent = 'staff')    as staff
      from rows where location <> '' group by 1
    ) l),
  'sources', (select coalesce(jsonb_agg(to_jsonb(s) order by s.count desc), '[]'::jsonb) from (
      select source, count(*) as count
      from rows where source <> '' group by 1
    ) s),
  -- One row per (week, answer). Weeks with no answers are simply absent —
  -- the report zero-fills against the quarter's calendar.
  'sourceWeekly', (select coalesce(jsonb_agg(to_jsonb(sw) order by sw.week, sw.count desc), '[]'::jsonb) from (
      select date_trunc('week', submitted_at)::date as week,
             source,
             count(*)                                as count
      from rows where source <> '' group by 1, 2
    ) sw),
  'sourceSince', (select to_char(since, 'YYYY-MM-DD') from source_era),
  'sourceEligible', (select count(*) from rows, source_era
      where since is not null and submitted_at >= since),
  'heatmap', (select coalesce(jsonb_agg(to_jsonb(h)), '[]'::jsonb) from (
      select extract(isodow from submitted_at)::int as dow,
             extract(hour from submitted_at)::int   as hour,
             count(*)                                as count
      from rows group by 1, 2
    ) h)
);
$$;

revoke all on function public.form_submission_stats(text, date, date) from public;
grant execute on function public.form_submission_stats(text, date, date) to anon, authenticated;
