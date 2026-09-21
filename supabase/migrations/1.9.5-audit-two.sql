-- ===========================================================================
--  SKWIK 1.9.5  —  what a second, harder audit found
--
--  Run this AFTER 1.9.3-security.sql and 1.9.4-reports-and-dates.sql.
--  Safe to run twice. Changes no data.
--
--  NOTE ON HOW THIS IS WRITTEN. An earlier draft of this file tried to edit
--  two existing functions by finding a line of their source and inserting
--  next to it. That is a bad way to change a database: the moment a function
--  is worded even slightly differently from the copy it was written against,
--  the migration refuses to run and says something unhelpful. Both rules live
--  in triggers now. A trigger does not care what the function around it looks
--  like, it catches a direct write as well as an RPC, and it keeps working
--  when the functions are next rewritten.
-- ===========================================================================

begin;

-- ---------------------------------------------------------------------------
--  1. RULE 46(b) IS THE DATABASE'S JOB TOO
--
--  A bill number may be at most sixteen characters and may contain only
--  letters, numbers, a hyphen and a slash. The Settings screen checks both —
--  but a screen is not a rule, and the portal does not object until filing
--  time, months after the bills have left the shop and can no longer be
--  renumbered.
--
--  It is measured against the number the series will REACH, not the one it is
--  on today: a thirteen-character prefix is fine at bill 1 and seventeen
--  characters at bill 10,000.
-- ---------------------------------------------------------------------------

create or replace function public.check_invoice_prefix(p_prefix text, p_with_year boolean)
returns void language plpgsql immutable as $$
declare
  v_pre  text := coalesce(p_prefix, '');
  v_room int;
begin
  if v_pre <> '' and v_pre !~ '^[A-Za-z0-9/-]+$' then
    raise exception 'A bill number may only have letters, numbers, a hyphen and a slash. "%" has something else in it.', v_pre;
  end if;
  -- the prefix, plus "26-27/" when the year is in it, plus up to five digits
  v_room := length(v_pre) + (case when p_with_year then 6 else 0 end) + 5;
  if v_room > 16 then
    raise exception 'With this prefix your bill number reaches % characters by bill 99,999, and GST allows 16.', v_room;
  end if;
end $$;

-- Only checked when one of the three fields actually changes, so a shop that
-- is already running with a long prefix is not locked out of its own Settings
-- screen for something it did before this rule existed.
create or replace function public.tg_orgs_prefix_guard()
returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT'
     or new.invoice_prefix    is distinct from old.invoice_prefix
     or new.restart_each_year is distinct from old.restart_each_year
     or new.year_in_prefix    is distinct from old.year_in_prefix then
    perform check_invoice_prefix(
      coalesce(new.invoice_prefix, ''),
      coalesce(new.restart_each_year, false) and coalesce(new.year_in_prefix, true));
  end if;
  return new;
end $$;

do $$
begin
  -- all three columns, because the trigger body names all three and plpgsql
  -- only finds out at the moment somebody saves a shop
  if (select count(*) from information_schema.columns
       where table_schema='public' and table_name='orgs'
         and column_name in ('invoice_prefix','restart_each_year','year_in_prefix')) = 3 then
    drop trigger if exists orgs_prefix_guard on public.orgs;
    create trigger orgs_prefix_guard before insert or update on public.orgs
      for each row execute function public.tg_orgs_prefix_guard();
  else
    raise notice 'orgs is missing one of invoice_prefix / restart_each_year / year_in_prefix - skipping the bill-number rule';
  end if;
end $$;

-- ---------------------------------------------------------------------------
--  2. A CANCELLED BILL IS NOT AN OPEN BILL
--
--  A bill could still be edited after it had been cancelled. In a shop with an
--  owner and a biller that is not a hypothetical: the owner cancels a bill
--  from his phone while the biller still has it open, the biller presses Save,
--  and the cancelled bill's figures are rewritten — 500 units of stock go out
--  that were never sold and 59,000 lands in the cash book that was never
--  taken. The sales reports show none of it, because the bill is cancelled;
--  only the cash and the stock are wrong, which is the hardest kind of wrong
--  to find.
--
--  A cancelled bill can be looked at, and it can be written again as a new
--  bill. It cannot be edited. Cancelling one that is already cancelled is
--  still fine, and so is changing the reason — everything else is frozen.
--
--  Comparing the whole row as JSON means this keeps working when a column is
--  added to the table later.
-- ---------------------------------------------------------------------------

create or replace function public.tg_no_edit_after_cancel()
returns trigger language plpgsql as $$
begin
  if old.cancelled_at is null then return new; end if;   -- not cancelled: nothing to hold
  if new.cancelled_at is null then return new; end if;   -- deliberately putting it back
  if (to_jsonb(new) - 'cancelled_at' - 'cancel_reason')
     is distinct from
     (to_jsonb(old) - 'cancelled_at' - 'cancel_reason') then
    raise exception 'That bill was cancelled. Write a new one instead of changing it.';
  end if;
  return new;
end $$;

drop trigger if exists vouchers_no_edit_after_cancel on public.vouchers;
create trigger vouchers_no_edit_after_cancel before update on public.vouchers
  for each row execute function public.tg_no_edit_after_cancel();

commit;
