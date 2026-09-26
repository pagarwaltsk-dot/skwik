-- ===========================================================================
--  1.9.49  THE REST OF WHAT HE OWNS, AND THE REST OF WHAT HE OWES.
--
--  The balance sheet has been ending with an apology:
--
--      "A loan you have taken, a shop or a vehicle you own, and money drawn
--       for the house are not in these books, so they are not in this figure.
--       Show it to your accountant as a starting point."
--
--  That is honest, and it is also a sheet that stops one line short of being
--  useful. A loan does not pass through a bill or a receipt, so nothing in
--  the books will ever find it; the same is true of the shop itself, the
--  vehicle, the machinery. Until they are in, the figure at the bottom is a
--  fragment of his net worth and he has to finish the sum on paper.
--
--  They go in by hand, once, and are corrected when they change. A short list
--  of named balances — which is exactly how he already holds them in his head.
--
--  WHAT THIS DELIBERATELY IS NOT.
--
--  It is not double-entry accounting and does not pretend to be: no journal
--  vouchers, no trial balance, no ledger for the loan. Building those would
--  turn a billing book into Tally, and Tally is hard to use precisely because
--  it has them. A man who wants a loan ACCOUNT, with every instalment posted
--  against it, has outgrown this and should say so.
--
--  MONEY DRAWN FOR THE HOUSE IS NOT HERE, ON PURPOSE.
--
--  It looks like it belongs and it does not. When he takes 50,000 out of the
--  till for the house, the cash figure has already fallen and the capital
--  figure has already fallen with it — the books recorded it as it happened.
--  Entering "drawings 50,000" as well would take it off twice. If he took it
--  out WITHOUT writing it down, then the cash figure is what is wrong, and
--  the fix is a cash entry, not a line on this list.
--
--  The function below is the one from 1.9-fixes, taken out of that file as it
--  stood and edited by script in three places.
--
--  SAFE TO RUN TWICE.
-- ===========================================================================


-- ---------------------------------------------------------------------------
--  1. THE LIST
-- ---------------------------------------------------------------------------

create table if not exists public.standing_items (
  id      uuid primary key default gen_random_uuid(),
  org_id  uuid not null references public.orgs(id) on delete cascade,
  name    text not null,
  kind    text not null,
  amount  numeric(14,2) not null default 0,
  note    text,
  -- From when it counts. A loan taken in August does not belong on a sheet
  -- drawn up in July, and a sheet is often asked for as at a past date.
  as_on   date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

do $c$
begin
  if not exists (select 1 from pg_constraint where conname = 'standing_items_kind_known') then
    alter table public.standing_items
      add constraint standing_items_kind_known check (kind in ('owns', 'owes'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'standing_items_amount_sane') then
    -- A minus here would mean "owns a negative shop", which is a way of
    -- writing a loan that nobody would find again. The kind says which side
    -- it is on; the amount is always what it is worth.
    alter table public.standing_items
      add constraint standing_items_amount_sane check (amount >= 0);
  end if;
end
$c$;

comment on table public.standing_items is
  'Things the shop owns or owes that no bill or receipt will ever mention: a loan, the shop, a vehicle. Entered by hand and kept current.';

create index if not exists standing_items_by_org
  on public.standing_items (org_id, kind, name);

alter table public.standing_items enable row level security;

do $c$
begin
  if not exists (select 1 from pg_policies
                  where tablename = 'standing_items' and policyname = 'standing_items_own_org') then
    -- THE OWNER'S BUSINESS, NOT THE COUNTER'S. What he owes the bank is not
    -- something the boy writing bills has any reason to see.
    create policy standing_items_own_org on public.standing_items
      for all using (org_id = my_org_id() and my_role() = 'owner')
      with check (org_id = my_org_id() and my_role() = 'owner');
  end if;
end
$c$;

grant select, insert, update, delete on public.standing_items to authenticated;


-- ---------------------------------------------------------------------------
--  2. THE SHEET, WITH THEM IN IT
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.balance_sheet(p_on date DEFAULT today_ist())
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_org    uuid := my_org_id();
  v_cash   numeric := 0;
  v_banks  jsonb;
  v_bank   numeric := 0;
  v_owed   numeric := 0;
  v_owing  numeric := 0;
  v_stock  numeric := 0;
  v_out    numeric := 0;
  v_in     numeric := 0;
  v_paid   numeric := 0;
  v_gst    numeric := 0;
  v_reg    boolean := false;
  v_assets numeric;
  v_liab   numeric;
  v_owns   numeric := 0;   -- what he owns that Skwik never sees
  v_loans  numeric := 0;   -- and what he owes for the same reason
  v_more   jsonb;
begin
  if v_org is null then raise exception 'This login is not linked to a firm yet'; end if;

  select coalesce(opening_cash, 0), coalesce(is_gst_registered, false)
    into v_cash, v_reg
    from orgs where id = v_org;

  v_cash := v_cash
    + coalesce((select sum(case when ptype = 'receipt' then amount else -amount end)
                  from payments where org_id = v_org and mode = 'cash' and pdate <= p_on), 0)
    - coalesce((select sum(amount) from expenses
                 where org_id = v_org and mode = 'cash' and edate <= p_on), 0);

  -- every account, switched on or not: money does not stop existing
  -- because a row was ticked off.
  select coalesce(jsonb_agg(jsonb_build_object(
                    'id', b.id, 'name', b.name, 'amount', b.bal, 'active', b.is_active)
                  order by b.name), '[]'::jsonb),
         coalesce(sum(b.bal), 0)
    into v_banks, v_bank
    from (
      select b.id, b.name, b.is_active,
             coalesce(b.opening, 0)
             + coalesce((select sum(case when p.ptype = 'receipt' then p.amount else -p.amount end)
                           from payments p
                          where p.org_id = v_org and p.mode = 'bank'
                            and p.account_id = b.id and p.pdate <= p_on), 0)
             - coalesce((select sum(e.amount) from expenses e
                          where e.org_id = v_org and e.mode = 'bank'
                            and e.account_id = b.id and e.edate <= p_on), 0) as bal
        from bank_accounts b
       where b.org_id = v_org
    ) b;

  v_bank := v_bank
    + coalesce((select sum(case when ptype = 'receipt' then amount else -amount end)
                  from payments where org_id = v_org and mode = 'bank'
                    and account_id is null and pdate <= p_on), 0)
    - coalesce((select sum(amount) from expenses
                 where org_id = v_org and mode = 'bank'
                   and account_id is null and edate <= p_on), 0);

  select coalesce(sum(amt) filter (where amt > 0), 0),
         coalesce(-sum(amt) filter (where amt < 0), 0)
    into v_owed, v_owing
    from party_balance_rows(p_on);

  -- Goods on the shelf, at what they cost. A nought is not a price.
  -- One pass over the movements, not one index lookup per item: on a shop
  -- with 400 items and 120,000 movements the old shape was 307ms of the
  -- balance sheet all by itself.
  select coalesce(sum(
           greatest(coalesce(i.opening_stock, 0) + coalesce(m.moved, 0), 0)
           * coalesce(nullif(i.purchase_price, 0), nullif(i.sale_price, 0), 0)), 0)
    into v_stock
    from items i
    left join (
      select sm.item_id, sum(coalesce(sm.qty_in, 0) - coalesce(sm.qty_out, 0)) as moved
        from stock_moves sm
       where sm.org_id = v_org and sm.mdate <= p_on
       group by sm.item_id
    ) m on m.item_id = i.id
   where i.org_id = v_org and i.is_active;

  -- tax collected, tax paid on purchases, tax already handed over
  if v_reg then
    select
      -- A CREDIT NOTE RAISED TOO LATE DOES NOT REDUCE THE TAX.
      -- Section 34(2) closes the door on 30 November. gstr1.js already
      -- leaves those notes out of the return; the balance sheet did not,
      -- so the screen told the shopkeeper he owed less than his own
      -- GSTR-1 file said he owed, and the screen is what he looks at.
      coalesce(sum(case when vtype in ('sale','estimate')
                          and coalesce(counts_as_sale, true) then  (cgst+sgst+igst)
                        when vtype = 'sale_return'
                          and coalesce(gst_effective, true)  then -(cgst+sgst+igst)
                        else 0 end), 0),
      coalesce(sum(case when vtype = 'purchase'              then  (cgst+sgst+igst)
                        when vtype = 'purchase_return'       then -(cgst+sgst+igst)
                        else 0 end), 0)
      into v_out, v_in
      from vouchers
     where org_id = v_org and cancelled_at is null and vdate <= p_on;

    select coalesce(sum(amount), 0) into v_paid
      from expenses
     where org_id = v_org and is_gst_payment and edate <= p_on;

    v_gst := round(v_out - v_in - v_paid, 2);
  end if;

  -- WHAT SKWIK CANNOT KNOW ABOUT ON ITS OWN.
  --
  -- The sheet used to end with a paragraph admitting what it was missing: a
  -- loan he has taken, the shop or the vehicle he owns. Those do not pass
  -- through a bill or a receipt, so nothing in the books will ever find them
  -- — and without them the figure at the bottom is not his net worth, it is
  -- a fragment of it, and he was told as much and left to do the rest on
  -- paper.
  --
  -- They are entered by hand, once, and kept up to date when they change.
  -- That is not double-entry accounting and is not pretending to be: it is a
  -- short list of named balances, which is exactly how a shopkeeper already
  -- holds them in his head.
  select
    coalesce(sum(amount) filter (where kind = 'owns'), 0),
    coalesce(sum(amount) filter (where kind = 'owes'), 0),
    coalesce(jsonb_agg(jsonb_build_object(
      'id', id, 'name', name, 'kind', kind, 'amount', round(amount, 2), 'note', note)
      order by kind, name), '[]'::jsonb)
    into v_owns, v_loans, v_more
    from standing_items
   where org_id = v_org and coalesce(as_on, p_on) <= p_on;

  v_assets := v_cash + v_bank + v_owed + v_stock + greatest(-v_gst, 0) + v_owns;
  v_liab   := v_owing + greatest(v_gst, 0) + v_loans;

  return jsonb_build_object(
    'on',          p_on,
    'cash',        round(v_cash, 2),
    'banks',       v_banks,
    'bank',        round(v_bank, 2),
    'debtors',     round(v_owed, 2),
    'creditors',   round(v_owing, 2),
    'stock',       round(v_stock, 2),
    'gst_payable', round(greatest(v_gst, 0), 2),
    'gst_credit',  round(greatest(-v_gst, 0), 2),
    'owns',        round(v_owns, 2),
    'loans',       round(v_loans, 2),
    'standing',    v_more,
    'assets',      round(v_assets, 2),
    'liabilities', round(v_liab, 2),
    'capital',     round(v_assets - v_liab, 2),
    'net_worth',   round(v_assets - v_liab, 2));
end $function$;


-- ---------------------------------------------------------------------------
--  AND ONE SWEEP, SO THE SERVER'S CLOCK CAN NEVER DECIDE AN INDIAN DATE AGAIN
-- ---------------------------------------------------------------------------
--
--  Supabase runs in UTC. Until half past five in the morning, UTC is still
--  yesterday in Guwahati — so any function that reaches for current_date can
--  date a bill, a stock movement or a manufacturing entry one day early, and
--  on the first of April one FINANCIAL YEAR early. Nothing about this app is
--  ever about a date anywhere but India.
--
--  1.9.4 fixed the functions that existed then, by name. Everything written
--  since had to remember, and three of them did not. So instead of another
--  list that goes stale, every function in this schema is swept: if it uses
--  the bare word current_date it is rewritten to today_ist(), which reads the
--  clock in Asia/Kolkata.
--
--  It rewrites nothing else about a function, it skips today_ist itself, and
--  running it a second time finds nothing to do.

do $sweep$
declare f record; def text; newdef text; n int := 0; names text := '';
begin
  for f in
    select p.oid, p.proname
      from pg_proc p
      join pg_namespace nsp on nsp.oid = p.pronamespace
     where nsp.nspname = 'public'
       and p.prokind = 'f'
       and p.proname <> 'today_ist'
       -- THE WHOLE DEFINITION, NOT JUST THE BODY. balance_sheet(p_on date
       -- default current_date) hides it in the ARGUMENT, where a check on the
       -- body alone never looks -- and that one decides which financial year
       -- the figure on his home screen belongs to.
       and pg_get_functiondef(p.oid) ~* '\mcurrent_date\M'
  loop
    def := pg_get_functiondef(f.oid);
    newdef := regexp_replace(def, '\mcurrent_date\M', 'today_ist()', 'gi');
    if newdef <> def then
      execute newdef;
      n := n + 1;
      names := names || ' ' || f.proname;
    end if;
  end loop;
  if n > 0 then
    raise notice 'dates: % function(s) moved off the server clock onto India''s:%', n, names;
  else
    raise notice 'dates: every function already reads India''s date';
  end if;
end
$sweep$;

-- And the same for the COLUMN defaults. A bill, a movement, a receipt and an
-- expense each fall back to the server's date when none is given. The app
-- always gives one, so this changes nothing today — it is there so that the
-- next line of code written in a hurry cannot date a bill in Greenwich.

do $cols$
declare r record; n int := 0;
begin
  for r in
    select c.table_name, c.column_name
      from information_schema.columns c
     where c.table_schema = 'public'
       and c.column_default ilike '%current_date%'
  loop
    execute format('alter table public.%I alter column %I set default today_ist()',
                   r.table_name, r.column_name);
    n := n + 1;
  end loop;
  raise notice 'dates: % column default(s) moved onto India''s date', n;
end
$cols$;
