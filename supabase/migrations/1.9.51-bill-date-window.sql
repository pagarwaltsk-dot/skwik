-- ===========================================================================
--  1.9.51  WRITING TODAY'S BILL FOR THE TWENTIETH.
--
--  Today is the 26th. The last bill he wrote is dated the 20th and nothing
--  has been billed in between. He wants to date this one the 20th, and he is
--  right to want it: the goods went out on the 20th.
--
--  The reason Skwik would not let him is the numbering. A bill number is
--  always the next one in the series, so back-dating freely produces No. 41
--  dated the 26th and No. 42 dated the 20th -- numbers running BACKWARDS
--  against dates. That is the first thing an officer looks for in a bill
--  book, and there is no good answer to it.
--
--  His own rule removes the possibility instead of warning about it: any day
--  from the date of the last bill up to today. Numbers and dates then move in
--  the same direction, always, and he never sees a date he cannot use.
--
--  Two things are built here:
--
--    bill_date_window()  tells the screen which days to offer, and why, so
--                        the calendar simply has no wrong day on it.
--
--    the guard inside     refuses a date outside that window even if it
--    save_voucher and     arrives from somewhere else -- an old copy of the
--    update_voucher       app, a script, anything. The screen is not the rule.
--
--  WHAT IS DELIBERATELY NOT GUARDED: a voucher that arrives carrying its own
--  number. That is what an import does -- the numbers and the dates both come
--  out of Tally and already agree with each other -- and a rule written for
--  bills Skwik numbers itself has no business refusing them.
--
--  SAFE TO RUN TWICE.
-- ===========================================================================


-- ---------------------------------------------------------------------------
--  1. WHICH SERIES A VOUCHER BELONGS TO
-- ---------------------------------------------------------------------------
--  Sales have one, estimates have their own, credit notes and debit notes
--  each have a counter of their own. A purchase carries the supplier's number
--  and none of ours, so it has no series and no window -- and it must not
--  have one: a purchase belongs to the day it went into the books, which is
--  why an August bill entered in September lands in September on purpose.

create or replace function public.series_of(p_vtype text)
returns text language sql immutable as $fn$
  select case p_vtype
           when 'sale' then 'sale'
           when 'estimate' then 'estimate'
           when 'sale_return' then 'sale_return'
           when 'purchase_return' then 'purchase_return'
           else null
         end
$fn$;


-- ---------------------------------------------------------------------------
--  2. THE DAYS THE SCREEN MAY OFFER
-- ---------------------------------------------------------------------------
--  Returns { from, to, why, last_no, last_date, bounded }.
--
--  p_id is the bill being EDITED, if any. An edit keeps its number, so it is
--  fenced on both sides: not before the voucher numbered below it, and not
--  after the one numbered above it.

create or replace function public.bill_date_window(p_vtype text default 'sale',
                                                   p_id uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $win$
declare
  v_org    uuid := my_org_id();
  v_series text := series_of(p_vtype);
  v_lock   date;
  v_restart boolean;
  v_from   date;
  v_to     date := today_ist();
  v_why    text;
  v_no     text;
  v_prev   record;
  v_next   record;
  v_mine   int;
begin
  if v_org is null then raise exception 'This login is not linked to a firm yet'; end if;

  select books_locked_upto, coalesce(restart_each_year, false)
    into v_lock, v_restart from orgs where id = v_org;

  -- A PURCHASE HAS NO WINDOW. Its date is the day it went into the books and
  -- the supplier's own date lives on its own column.
  if v_series is null then
    v_from := coalesce(v_lock + 1, date '2000-04-01');
    return jsonb_build_object('from', v_from, 'to', v_to, 'bounded', false,
      'why', 'A purchase belongs to the day you entered it. The supplier''s own bill date is kept separately.');
  end if;

  if p_id is not null then
    select coalesce(trailing_no(voucher_no), 0) into v_mine
      from vouchers where id = p_id and org_id = v_org;
  end if;

  -- the voucher numbered just BELOW this one (or the newest, for a new bill)
  select voucher_no, vdate, coalesce(trailing_no(voucher_no), 0) as n
    into v_prev
    from vouchers
   where org_id = v_org and vtype = p_vtype and voucher_no is not null
     and (p_id is null or coalesce(trailing_no(voucher_no), 0) < v_mine)
   order by coalesce(trailing_no(voucher_no), 0) desc
   limit 1;

  -- and the one numbered just above, which only matters when editing
  if p_id is not null then
    select voucher_no, vdate, coalesce(trailing_no(voucher_no), 0) as n
      into v_next
      from vouchers
     where org_id = v_org and vtype = p_vtype and voucher_no is not null
       and coalesce(trailing_no(voucher_no), 0) > v_mine
     order by coalesce(trailing_no(voucher_no), 0)
     limit 1;
    if v_next.vdate is not null and v_next.vdate < v_to then
      v_to  := v_next.vdate;
    end if;
  end if;

  if v_prev.vdate is not null then
    v_from := v_prev.vdate;
    v_no   := v_prev.voucher_no;
    v_why  := format('Your last one, No. %s, is dated %s. This one is numbered after it, so it cannot be dated before it.',
                     v_prev.voucher_no, to_char(v_prev.vdate, 'DD-MM-YYYY'));
  else
    -- NOTHING WRITTEN YET. The year he is in, so a first bill cannot land in
    -- a year that is already filed and closed.
    v_from := make_date(
      case when extract(month from v_to) >= 4 then extract(year from v_to)::int
           else extract(year from v_to)::int - 1 end, 4, 1);
    v_why  := 'This is your first one, so any day this financial year will do.';
  end if;

  -- A CLOSED MONTH IS CLOSED TO THIS TOO.
  if v_lock is not null and v_from <= v_lock then
    v_from := v_lock + 1;
    v_why  := format('Your books are closed up to %s, so the %s is the earliest day open to you.',
                     to_char(v_lock, 'DD Mon YYYY'), to_char(v_lock + 1, 'DD Mon'));
  end if;

  -- AND NUMBERING THAT STARTS AGAIN EACH APRIL cannot reach back past April.
  if v_restart then
    v_from := greatest(v_from, make_date(
      case when extract(month from v_to) >= 4 then extract(year from v_to)::int
           else extract(year from v_to)::int - 1 end, 4, 1));
  end if;

  if v_from > v_to then v_from := v_to; end if;

  return jsonb_build_object('from', v_from, 'to', v_to, 'bounded', true,
                            'last_no', v_no, 'last_date', v_prev.vdate, 'why', v_why);
end
$win$;

revoke all on function public.bill_date_window(text, uuid) from public;
grant execute on function public.bill_date_window(text, uuid) to authenticated;


-- ---------------------------------------------------------------------------
--  3. AND THE RULE ITSELF, WHERE IT CANNOT BE WALKED AROUND
-- ---------------------------------------------------------------------------

create or replace function public.assert_date_in_window(p_vtype text, p_date date,
                                                        p_id uuid default null)
returns void
language plpgsql
stable
security definer
set search_path to 'public'
as $chk$
declare w jsonb;
begin
  if series_of(p_vtype) is null then return; end if;   -- a purchase has no window
  w := bill_date_window(p_vtype, p_id);
  if not (w->>'bounded')::boolean then return; end if;

  if p_date < (w->>'from')::date then
    raise exception 'That date is before %. %',
      to_char((w->>'from')::date, 'DD Mon YYYY'), w->>'why';
  end if;
  if p_date > (w->>'to')::date then
    raise exception 'That date is after %. A bill cannot be dated later than the day it is written.',
      to_char((w->>'to')::date, 'DD Mon YYYY');
  end if;
end
$chk$;

revoke all on function public.assert_date_in_window(text, date, uuid) from public;
grant execute on function public.assert_date_in_window(text, date, uuid) to authenticated;
