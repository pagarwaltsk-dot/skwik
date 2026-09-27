-- ===========================================================================
--  SKWIK 1.9.14  —  paying for it
--
--  Run after 1.9.13. Safe to run twice. Changes no data.
--
--  WHAT WAS THERE BEFORE
--
--  A firm carried plan = 'trial' and a date seven days out, the home screen
--  drew a banner counting down, and when it reached zero the banner said so
--  and the app carried on working for ever. Nothing was gated on it. There
--  was no paid state at all, so a shop that HAD paid could not be told apart
--  from one that never would.
--
--  WHAT THIS DOES, AND WHAT IT DELIBERATELY DOES NOT
--
--  When the year runs out the shop can still open the app, read every bill,
--  look at every report and TAKE A COPY OF EVERYTHING. What it cannot do is
--  write a new bill or change an old one.
--
--  That is the whole of the lock, and it is deliberate. His books are his,
--  not ours. Holding a man's own trade records hostage over a renewal is not
--  a thing to build, and a shop that cannot get its data out will rightly
--  never trust the next app either. Not being able to bill is leverage
--  enough — nobody runs a shop without writing bills.
-- ===========================================================================

begin;

-- When the shop has paid up to. Null means it never has.
alter table orgs add column if not exists paid_until date;

-- What he paid and when, so there is a record to point at if he asks.
create table if not exists subscription_payments (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references orgs(id) on delete cascade,
  paid_on    date not null default today_ist(),
  amount     numeric(12,2),
  covers_to  date not null,
  note       text,
  created_at timestamptz not null default now()
);
alter table subscription_payments enable row level security;

-- He may see what he has paid. Only the operator writes these, from the
-- dashboard, so there is no insert policy at all.
drop policy if exists sub_pay_read on subscription_payments;
create policy sub_pay_read on subscription_payments
  for select using (org_id = my_org_id());

commit;


-- ---------------------------------------------------------------------------
--  WHERE THE SHOP STANDS
-- ---------------------------------------------------------------------------
begin;

create or replace function public.subscription_state()
returns jsonb language plpgsql stable security definer set search_path to 'public' as $fn$
declare
  o orgs%rowtype; v_today date := today_ist(); v_state text; v_until date; v_days int;
begin
  select * into o from orgs where id = my_org_id();
  if not found then return jsonb_build_object('state','none'); end if;

  if o.paid_until is not null and o.paid_until >= v_today then
    v_state := 'paid'; v_until := o.paid_until;
  elsif coalesce(o.plan,'trial') = 'trial'
        and o.trial_ends_at is not null and o.trial_ends_at::date >= v_today then
    v_state := 'trial'; v_until := o.trial_ends_at::date;
  else
    v_state := 'over';
    v_until := coalesce(o.paid_until, o.trial_ends_at::date);
  end if;
  v_days := case when v_until is null then null else v_until - v_today end;

  return jsonb_build_object(
    'state', v_state,            -- trial | paid | over
    'until', v_until,
    'days_left', greatest(coalesce(v_days, 0), 0),
    'ever_paid', o.paid_until is not null);
end $fn$;

revoke all on function public.subscription_state() from public;
grant execute on function public.subscription_state() to authenticated;

commit;


-- ---------------------------------------------------------------------------
--  THE GATE
--
--  assert_can_write() already stands in front of every function that writes
--  or changes a bill — save_voucher, update_voucher, delete_voucher,
--  transfer_stock, wipe_org and the rest. Adding the check here covers all
--  of them at once and leaves reading, backing up, adding an item, adding a
--  customer and recording a payment exactly as they were.
-- ---------------------------------------------------------------------------
begin;

create or replace function public.assert_can_write()
returns void language plpgsql stable security definer set search_path to 'public' as $fn$
declare s jsonb;
begin
  if not can_write() then
    raise exception 'This login can look at the books but not change them';
  end if;
  s := subscription_state();
  if s->>'state' = 'over' then
    raise exception 'Your Skwik year ended on %. Everything you have written is still here and you can take a copy of it under Import and export. To write bills again, renew it.',
      to_char(coalesce((s->>'until')::date, today_ist()), 'DD Mon YYYY');
  end if;
end $fn$;

commit;


-- ===========================================================================
--  MARKING A SHOP AS PAID
--
--  Run this in the SQL Editor when the money reaches you. Nothing in the app
--  can do it, which is the point — a shop cannot mark itself paid.
--
--    update orgs set paid_until = '2027-09-22', plan = 'paid'
--     where name = 'the shop's name';
--
--    insert into subscription_payments (org_id, amount, covers_to, note)
--    select id, 2100, '2027-09-22', 'UPI' from orgs where name = 'the shop's name';
--
--  To give somebody a few more days while they sort the money out, move
--  paid_until and nothing else.
-- ===========================================================================
