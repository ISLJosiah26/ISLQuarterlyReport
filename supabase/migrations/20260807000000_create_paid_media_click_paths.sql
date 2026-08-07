-- On-site journeys taken by people who clicked a paid ad.
--
-- One row per distinct journey: the ordered list of pages a session visited
-- after landing from the ad, plus how many sessions followed exactly that
-- route. Everything the report draws — landing pages, step-by-step flow,
-- drop-off, top journeys — is derived from these rows, so the shape stays
-- small enough to hand-edit and honest about what it means: a journey ends
-- where the session ended.
--
-- campaign_id is nullable, matching paid_media_demographics: a breakdown
-- normally belongs to the campaign it describes, but a site-wide export
-- (GA4 filtered to "paid" traffic generally, rather than one campaign) keeps
-- a null campaign_id and renders in its own section at the foot of the report.
--
-- Public-read / authenticated-write, matching the other paid_media_* tables.
create table if not exists public.paid_media_click_paths (
  id          uuid primary key default gen_random_uuid(),
  report_id   uuid not null references public.social_reports(id) on delete cascade,
  campaign_id uuid references public.paid_media_campaigns(id) on delete cascade,
  sort_order  integer not null default 0,
  -- Ordered page paths, e.g. '["/", "/jobs", "/contact"]'. A JSON array rather
  -- than a delimited string so a page path containing the delimiter can't
  -- silently split one step into two.
  steps       jsonb not null default '[]'::jsonb,
  sessions    integer,
  conversions integer,
  -- The combined tail of a long-tailed import, same idea as
  -- paid_media_demographics.is_other: it carries no steps, counts toward the
  -- session total so shares stay honest, and is kept out of the flow diagram.
  is_other    boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

alter table public.paid_media_click_paths enable row level security;

create policy "public read" on public.paid_media_click_paths
  for select to public using (true);
create policy "auth write" on public.paid_media_click_paths
  for all to public using (auth.role() = 'authenticated');

create index if not exists paid_media_click_paths_report_idx
  on public.paid_media_click_paths (report_id, sort_order);
create index if not exists paid_media_click_paths_campaign_idx
  on public.paid_media_click_paths (campaign_id, sort_order);
