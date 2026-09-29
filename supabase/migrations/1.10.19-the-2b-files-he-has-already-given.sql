-- ===========================================================================
--  SKWIK KEEPS THE 2B FILES. HE ONLY EVER ADDS THE NEW MONTH.
--
--  His own words: "suppose I uploaded portal GSTR2B of July, than why to
--  update that again? Skwik can hold that, and we can add only file for the
--  missing month? like once we update April gstr2b it locks, than next month
--  may locks... and while comparing we just need to choose?"
--
--  Right on every count, and it is the answer to the fault this came out of.
--  A bill is only fairly called "not filed" if the 2B for ITS OWN MONTH has
--  been looked at -- and until now every reconciliation started from nothing,
--  so he would have had to find and re-open twelve files to check twelve
--  months. Nobody does that. He checked one month against three months of
--  bills and Skwik blamed his suppliers for the other two.
--
--  A GSTR-2B IS FINAL, WHICH IS WHY THIS WORKS.
--
--  The portal generates it on the 14th for the month just gone and never
--  changes it afterwards. A supplier who files a July invoice late does not
--  alter July's 2B -- the invoice turns up in the 2B of the month he filed it
--  in. So each month's file, once brought in, is true for ever, and the months
--  stack up into a complete picture instead of replacing one another. That is
--  what makes "it locks" the correct instinct rather than a risky one.
--
--  WHAT IS KEPT. The rows the reader made, not the file. A parsed row is the
--  handful of fields a comparison needs -- supplier, number, date, the four
--  taxes, whether the portal allows the credit -- and it is a fraction of the
--  portal's JSON, which matters when this is a shop's subscription and the
--  rows are being paid for. If the reader is ever improved, that month is
--  brought in again; that is a minute's work once, against carrying every
--  original for every shop for ever.
--
--  ONE ROW PER FIRM PER RETURN PERIOD, and the period is the portal's own
--  (rtnprd, as YYYY-MM here). Bringing the same month in twice is not an
--  accident to punish -- he may have picked the wrong file the first time --
--  so it replaces, and the screen tells him what it is replacing before he
--  says yes.
-- ===========================================================================

create table if not exists public.itc_files (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references public.orgs(id) on delete cascade,
  period     text not null,                  -- 'YYYY-MM', the portal's rtnprd
  rows       jsonb not null default '[]'::jsonb,
  file_name  text,
  doc_count  integer not null default 0,
  tax_total  numeric(14,2) not null default 0,
  taken_at   timestamptz not null default now()
);

-- one file per month per firm: bringing a month in again replaces it
create unique index if not exists itc_files_one_per_period
  on public.itc_files (org_id, period);

alter table public.itc_files enable row level security;

do $c$
begin
  if not exists (select 1 from pg_policies
                  where tablename = 'itc_files' and policyname = 'itc_files_own_org') then
    create policy itc_files_own_org on public.itc_files
      for all using (org_id = my_org_id()) with check (org_id = my_org_id());
  end if;
end
$c$;

grant select, insert, update, delete on public.itc_files to authenticated;


-- ---------------------------------------------------------------------------
--  PUTTING ONE AWAY.
--
--  Through a function rather than a plain insert, so that the count and the
--  tax total are worked out from the rows themselves and cannot disagree with
--  them, and so that replacing a month is one statement and not a delete
--  followed by an insert that might not happen.
-- ---------------------------------------------------------------------------
create or replace function public.keep_2b(p_period text, p_rows jsonb, p_name text default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $k2b$
declare
  v_org  uuid := my_org_id();
  v_was  jsonb;
  v_n    integer;
  v_tax  numeric;
begin
  if v_org is null then raise exception 'This login is not linked to a firm yet'; end if;
  perform assert_can_write();
  if coalesce(p_period, '') !~ '^\d{4}-\d{2}$' then
    raise exception 'Which month does that file belong to?';
  end if;
  if jsonb_typeof(coalesce(p_rows, 'null'::jsonb)) <> 'array' then
    raise exception 'That file held nothing to keep';
  end if;

  -- what was there before, so the screen can say what it replaced
  select jsonb_build_object('doc_count', doc_count, 'taken_at', taken_at,
                            'file_name', file_name)
    into v_was
    from itc_files where org_id = v_org and period = p_period;

  select count(*),
         coalesce(sum((coalesce(r->>'igst','0')::numeric)
                    + (coalesce(r->>'cgst','0')::numeric)
                    + (coalesce(r->>'sgst','0')::numeric)
                    + (coalesce(r->>'cess','0')::numeric)), 0)
    into v_n, v_tax
    from jsonb_array_elements(p_rows) r;

  insert into itc_files (org_id, period, rows, file_name, doc_count, tax_total, taken_at)
  values (v_org, p_period, p_rows, nullif(p_name, ''), v_n, round(v_tax, 2), now())
  on conflict (org_id, period) do update
    set rows = excluded.rows,
        file_name = excluded.file_name,
        doc_count = excluded.doc_count,
        tax_total = excluded.tax_total,
        taken_at  = excluded.taken_at;

  return jsonb_build_object('period', p_period, 'docs', v_n,
                            'tax', round(v_tax, 2), 'replaced', v_was);
end $k2b$;

revoke all on function public.keep_2b(text, jsonb, text) from public;
grant execute on function public.keep_2b(text, jsonb, text) to authenticated;


-- ---------------------------------------------------------------------------
--  AND WHAT HE HAS, WITHOUT SENDING ALL OF IT DOWN THE LINE.
--
--  The months and their sizes, for the list of ticks. The rows themselves are
--  fetched only for the months he has actually ticked, which on one month is a
--  few hundred rows rather than a year of them.
-- ---------------------------------------------------------------------------
create or replace function public.my_2b_months()
returns jsonb
language sql
stable
security definer
set search_path to 'public'
as $m2b$
  select coalesce(jsonb_agg(jsonb_build_object(
           'period', f.period, 'docs', f.doc_count, 'tax', f.tax_total,
           'name', f.file_name, 'taken_at', f.taken_at) order by f.period desc), '[]'::jsonb)
    from itc_files f
   where f.org_id = my_org_id();
$m2b$;

revoke all on function public.my_2b_months() from public;
grant execute on function public.my_2b_months() to authenticated;
