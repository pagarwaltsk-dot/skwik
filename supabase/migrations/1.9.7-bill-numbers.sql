-- ===========================================================================
--  SKWIK 1.9.7  —  bill numbering
--
--  Run this in the Supabase SQL Editor. Safe to run twice. Changes no data.
--
--  THE PROBLEM
--
--  A cancelled bill keeps its number. It has to: GST wants an unbroken
--  series with the cancellations visible in it, not numbers that quietly
--  disappear. The database enforces that — one number, one bill, cancelled
--  or not.
--
--  But the Settings screen was checking only the bills that are NOT
--  cancelled. So a shop that wrote 120 bills while testing and cancelled
--  88 upward was told 88 was free, accepted it, and then could not save a
--  bill at all: every number from 88 on was still owned by a cancelled
--  bill. save_voucher tried 25 of them, gave up, and said
--
--     "Could not find a free bill number. Check your numbering in Settings."
--
--  which sent him back to the screen that had just told him the wrong
--  thing. Two fixes, and they are both about telling him the truth.
-- ===========================================================================

begin;

-- ---------------------------------------------------------------------------
--  1. SETTINGS COUNTS CANCELLED BILLS TOO
--
--  The same rule the database uses, so the screen cannot promise a number
--  the database will refuse.
-- ---------------------------------------------------------------------------
create or replace function public.set_invoice_start(p_next integer, p_prefix text default null)
returns jsonb language plpgsql security definer set search_path to 'public' as $fn$
declare
  v_org    uuid := my_org_id();
  v_prefix text := coalesce(p_prefix, (select invoice_prefix from orgs where id = v_org), '');
  v_max    int;
  v_live   int;
  v_key    text;
begin
  perform assert_can_write();
  if v_org is null then raise exception 'This login is not linked to a firm yet'; end if;
  if my_role() <> 'owner' then raise exception 'Only the owner can change the numbering'; end if;
  if p_next is null or p_next < 1 then raise exception 'The next bill number must be 1 or more'; end if;

  -- EVERY number already in the books, cancelled bills included.
  select max(coalesce(trailing_no(voucher_no), 0)),
         max(case when cancelled_at is null
                  then coalesce(trailing_no(voucher_no), 0) else 0 end)
    into v_max, v_live
    from vouchers
   where org_id = v_org and vtype = 'sale'
     and voucher_no is not null
     and (v_prefix = '' or voucher_no like v_prefix || '%');

  if v_max is not null and p_next <= v_max then
    if coalesce(v_live, 0) < v_max then
      -- the blocking numbers belong to bills he cancelled, so say so
      raise exception
        'Bill number % is the highest in your books. Numbers above % belong to bills you cancelled, and a cancelled bill keeps its number. The next number must be % or more.',
        v_max, coalesce(v_live, 0), v_max + 1;
    else
      raise exception 'You have already issued bill number %. The next number must be more than that.', v_max;
    end if;
  end if;

  update orgs
     set next_invoice_no = p_next,
         invoice_prefix  = coalesce(p_prefix, invoice_prefix),
         series_year     = fy_label(today_ist())
   where id = v_org;

  select case when restart_each_year then fy_label(today_ist()) else 'ALL' end
    into v_key from orgs where id = v_org;

  insert into invoice_series (org_id, kind, fy, next_no)
  values (v_org, 'sale', v_key, p_next)
  on conflict (org_id, kind, fy) do update set next_no = excluded.next_no;

  return jsonb_build_object('next_invoice_no', p_next, 'invoice_prefix', v_prefix);
end $fn$;

commit;


-- ---------------------------------------------------------------------------
--  2. THE COUNTER STEPS OVER NUMBERS THAT ARE ALREADY IN USE
--
--  save_voucher asks for a number, is refused, and asks again — up to
--  twenty-five times. A shop that cancelled thirty-three test bills used up
--  all twenty-five tries and got "Could not find a free bill number", which
--  is true and useless.
--
--  Walking one number at a time was the wrong shape. The counter now looks
--  at what is actually in the books — cancelled bills included — and starts
--  from above it, so the first number it hands out is free.
-- ---------------------------------------------------------------------------
begin;

create or replace function public.next_invoice_no_for(p_org uuid, p_date date, p_kind text default 'sale')
returns text language plpgsql security definer set search_path to 'public' as $fn$
declare
  o      orgs%rowtype;
  v_fy   text;
  v_key  text;
  v_cur  text;
  n      int;
  v_used int;
  prefix text;
begin
  if p_org is null or p_org is distinct from my_org_id() then
    raise exception 'Not your firm';
  end if;

  select * into o from orgs where id = p_org for update;

  v_fy  := fy_label(p_date);
  v_key := case when o.restart_each_year then v_fy else 'ALL' end;

  insert into invoice_series (org_id, kind, fy, next_no)
  values (p_org, p_kind, v_key, 1)
  on conflict (org_id, kind, fy) do nothing;

  prefix := coalesce(case when p_kind = 'sale' then o.invoice_prefix
                          else o.estimate_prefix end, '');
  if o.restart_each_year and o.year_in_prefix then
    prefix := prefix || v_fy || '/';
  end if;

  -- THE HIGHEST NUMBER THIS SERIES HAS ALREADY USED, cancelled bills and all.
  -- A cancelled bill keeps its number, so it still blocks that number.
  select max(coalesce(trailing_no(voucher_no), 0))
    into v_used
    from vouchers
   where org_id = p_org and vtype = p_kind and voucher_no is not null
     and (prefix = '' or voucher_no like prefix || '%');

  -- Never hand back a number at or below it.
  update invoice_series
     set next_no = greatest(next_no, coalesce(v_used, 0) + 1) + 1
   where org_id = p_org and kind = p_kind and fy = v_key
   returning next_no - 1 into n;

  -- keep the figure the Settings screen shows in step with the year the
  -- shop is actually in
  v_cur := case when o.restart_each_year then fy_label(today_ist()) else 'ALL' end;
  if v_key = v_cur then
    if p_kind = 'sale' then
      update orgs set next_invoice_no = n + 1, series_year = v_key where id = p_org;
    else
      update orgs set next_estimate_no = n + 1 where id = p_org;
    end if;
  end if;

  return prefix || n::text;
end $fn$;

commit;
