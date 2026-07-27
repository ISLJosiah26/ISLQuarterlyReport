-- Scope audience demographics to a campaign.
--
-- The Paid Media report now reads as a list of campaigns rather than a set of
-- account-level sections, so a demographics breakdown belongs to the campaign
-- it describes. campaign_id is nullable: rows imported before this change (and
-- any breakdown that genuinely covers the whole account, since Campaign
-- Manager can report demographics account-wide) keep a null campaign_id and
-- render as an account-wide breakdown.
--
-- The cascade matches paid_media_ads — deleting a campaign takes its
-- demographics with it, which is what the admin form's delete-and-reinsert
-- save relies on.
alter table public.paid_media_demographics
  add column if not exists campaign_id uuid
    references public.paid_media_campaigns(id) on delete cascade;

create index if not exists paid_media_demographics_campaign_idx
  on public.paid_media_demographics (campaign_id, dimension, sort_order);

-- Flags the combined tail row the importer appends when an export is too long
-- to store in full (the Companies export runs to thousands of rows). It counts
-- toward the dimension's impression total, so shares stay honest, but the
-- report draws it apart from the named segments rather than letting one lump
-- flatten every bar beside it.
alter table public.paid_media_demographics
  add column if not exists is_other boolean not null default false;
