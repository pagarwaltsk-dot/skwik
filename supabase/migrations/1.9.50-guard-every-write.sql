-- ===========================================================================
--  1.9.50  EVERY WAY OF CHANGING THE BOOKS IS GUARDED THE SAME WAY.
--
--  Two rules are supposed to stand in front of every write in Skwik:
--
--    1. A CLOSED MONTH IS CLOSED. Once he has filed a return and closed the
--       books up to a date, nothing may change a figure behind that date --
--       otherwise the books stop agreeing with the return he has already
--       sent, and he finds out from the department.
--
--    2. A LOOK-ONLY LOGIN, AND A LAPSED YEAR, CANNOT WRITE. assert_can_write()
--       is the one place that decides both.
--
--  They stood in front of bills from the beginning. Everything written since
--  had to remember on its own, and a check of all of them found five holes:
--  the stock count, the godown transfer and the manufacturing entry all wrote
--  happily after the subscription had ended, and WRITING OFF A DEBT obeyed
--  neither rule -- so a debt sitting inside a filed month could be cleared
--  months later, moving a figure behind a return already filed.
--
--  The three stock functions are guarded in their own files. write_off is
--  older than all of them, so it is re-written here, unchanged except for the
--  two guards.
--
--  SAFE TO RUN TWICE. Nothing about anybody's data changes.
-- ===========================================================================


-- ---------------------------------------------------------------------------
--  1. WRITING OFF A DEBT IS A WRITE LIKE ANY OTHER
-- ---------------------------------------------------------------------------
--  Taken as it stood and given the two guards. The role check that was
--  already here -- only the owner may write off -- stays exactly as it was.

CREATE OR REPLACE FUNCTION public.write_off(p_party uuid, p_amount numeric,
                                            p_date date DEFAULT today_ist(),
                                            p_note text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_org uuid := my_org_id();
  v_amt numeric := round(coalesce(p_amount, 0), 2);
  v_id  uuid;
  v_on  date := coalesce(p_date, today_ist());
  v_lock date;
begin
  perform assert_can_write();

  if v_org is null then raise exception 'This login is not linked to a firm yet'; end if;
  -- WRITING OFF IS THE ONE THING A BILLER MUST NOT DO.
  -- It clears a customer's balance without any cash arriving, so a man on
  -- the counter could pocket what the customer paid and write off the same
  -- amount, and the books would still balance. Every other money function
  -- here already checks the role; this one did not.
  if my_role() <> 'owner' then
    raise exception 'Only the owner can write off an amount';
  end if;

  -- AND A CLOSED MONTH IS CLOSED TO THIS TOO. A write-off dated inside a
  -- filed period moves a balance behind a return already sent.
  select books_locked_upto into v_lock from orgs where id = v_org;
  if v_lock is not null and v_on <= v_lock then
    raise exception 'Your books are closed up to %. Date the write off in a month that is still open.',
      to_char(v_lock, 'DD Mon YYYY');
  end if;

  if not exists (select 1 from parties where id = p_party and org_id = v_org) then
    raise exception 'That name is not in your book';
  end if;
  if v_amt = 0 then raise exception 'Nothing to write off'; end if;

  -- A customer who owes money is written DOWN; a supplier the shop owes
  -- is written the other way. The sign of the amount says which.
  insert into payments (org_id, ptype, party_id, pdate, mode, amount, note)
  values (v_org,
          case when v_amt > 0 then 'receipt' else 'payment' end,
          p_party, v_on, 'writeoff', abs(v_amt),
          coalesce(nullif(p_note, ''), 'Written off'))
  returning id into v_id;

  return jsonb_build_object('id', v_id, 'amount', abs(v_amt));
end $function$;

revoke all on function public.write_off(uuid, numeric, date, text) from public;
grant execute on function public.write_off(uuid, numeric, date, text) to authenticated;


-- ---------------------------------------------------------------------------
--  2. TWO REPORTS THAT ARE THE OWNER'S AND WERE OPEN TO EVERYONE
-- ---------------------------------------------------------------------------
--
--  A test as the counter boy's own login read back the shop's capital, its
--  bank loan, its cash and bank balances, its purchases, its expenses and its
--  net profit. All of it. The tables behind those figures are properly
--  locked; these two functions are SECURITY DEFINER and read them for anyone.
--
--  Both are taken here exactly as they stand in the database and given one
--  check at the top. Nothing else about them changes -- the figures the owner
--  sees are the same figures to the paisa.
--
--  Everything ELSE a staff login can read is left alone on purpose: the udhar
--  list, the day's sales, the cash book and the GST figures are what a man on
--  the counter is there to work with.

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
  -- THE OWNER'S SHEET, AND NOBODY ELSE'S.
  --
  -- What he owns, what he owes the bank, and his capital are on this sheet.
  -- The standing_items table is already owner-only, and it made no difference
  -- at all: this function is SECURITY DEFINER, so it read those rows on behalf
  -- of whoever asked and handed the counter boy the shop's capital and its
  -- bank loan. The app only shows Books to the owner, which is not a guard --
  -- anything with a login can call this straight.
  if my_role() <> 'owner' then
    raise exception 'Only the owner can see the balance sheet';
  end if;
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

revoke all on function public.balance_sheet(date) from public;
grant execute on function public.balance_sheet(date) to authenticated;


CREATE OR REPLACE FUNCTION public.profit_and_loss(p_from date, p_to date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_org  uuid := my_org_id();
  v_est  boolean;
  v_sale numeric; v_ret numeric; v_buy numeric; v_buyret numeric;
  v_cost numeric; v_costret numeric; v_exp numeric; v_off numeric;
  v      jsonb;
begin
  -- WHAT THE SHOP MAKES IS THE OWNER'S BUSINESS.
  --
  -- Cost, purchases, expenses and the net figure are not things a man on the
  -- counter is given. Same reason as the balance sheet: the screen is
  -- owner-only and the function was not.
  if my_role() <> 'owner' then
    raise exception 'Only the owner can see the profit and loss';
  end if;
  if v_org is null then raise exception 'This login is not linked to a firm yet'; end if;
  select mode = 'estimate' into v_est from orgs where id = v_org;
  v_est := coalesce(v_est, false);

  select coalesce(sum(taxable), 0) into v_sale from vouchers
   where org_id = v_org and cancelled_at is null
     and vtype in ('sale','estimate') and coalesce(counts_as_sale, true)
     and vdate between p_from and p_to;

  select coalesce(sum(taxable), 0) into v_ret from vouchers
   where org_id = v_org and cancelled_at is null
     and vtype = 'sale_return' and vdate between p_from and p_to;

  select coalesce(sum(taxable), 0) into v_buy from vouchers
   where org_id = v_org and cancelled_at is null
     and vtype = 'purchase' and vdate between p_from and p_to;

  select coalesce(sum(taxable), 0) into v_buyret from vouchers
   where org_id = v_org and cancelled_at is null
     and vtype = 'purchase_return' and vdate between p_from and p_to;

  select coalesce(sum(vl.qty * vl.cost), 0) into v_cost
    from voucher_lines vl join vouchers v on v.id = vl.voucher_id
   where v.org_id = v_org and v.cancelled_at is null
     and v.vtype in ('sale','estimate') and coalesce(v.counts_as_sale, true)
     and v.vdate between p_from and p_to;

  select coalesce(sum(vl.qty * vl.cost), 0) into v_costret
    from voucher_lines vl join vouchers v on v.id = vl.voucher_id
   where v.org_id = v_org and v.cancelled_at is null
     and v.vtype = 'sale_return'
     and v.vdate between p_from and p_to;

  select coalesce(sum(amount), 0) into v_exp from expenses
   where org_id = v_org and edate between p_from and p_to
     and not is_gst_payment;

  -- money given up when a customer pays a little short
  select coalesce(sum(case when ptype = 'receipt' then amount else -amount end), 0)
    into v_off
    from payments
   where org_id = v_org and mode = 'writeoff'
     and pdate between p_from and p_to;

  select jsonb_build_object(
    'sale',     v_sale - v_ret,
    'purchase', v_buy - v_buyret,
    'cost',     v_cost - v_costret,
    'gross',    round((v_sale - v_ret) - (v_cost - v_costret), 2),
    'expenses',  v_exp,
    'written_off', v_off,
    'net',      round((v_sale - v_ret) - (v_cost - v_costret) - v_exp - v_off, 2),
    'heads', coalesce((select jsonb_agg(x order by x->>'head')
              from (select jsonb_build_object('head', head, 'amount', sum(amount)) as x
                      from expenses
                     where org_id = v_org and edate between p_from and p_to
                       and not is_gst_payment
                     group by head) y), '[]'::jsonb),
    'counts_estimates', v_est
  ) into v;

  return v;
end $function$;

revoke all on function public.profit_and_loss(date,date) from public;
grant execute on function public.profit_and_loss(date,date) to authenticated;


-- ---------------------------------------------------------------------------
--  4. AND A STANDING COUNT, SO THIS CANNOT DRIFT AGAIN QUIETLY
-- ---------------------------------------------------------------------------
--
--  The reason five holes opened is that the guard was applied by a list of
--  function names, and the list went stale the moment anything new was
--  written. A list cannot be trusted; a count can.
--
--  So every function in this schema that writes to a table is looked at, and
--  the ones with no guard are NAMED in the output. A few belong on that list
--  for good reasons and are excused by name below -- closing an account, for
--  instance, must keep working for a shop whose year has ended, because Google
--  Play requires it and because a man is entitled to leave.
--
--  Anything else appearing here is a hole. It does not stop the migration --
--  refusing to install over a judgement call would be worse -- but it says so
--  plainly instead of waiting to be found by a wrong figure.

do $audit$
declare r record; n int := 0; names text := '';
begin
  for r in
    select p.proname
      from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
     where ns.nspname = 'public'
       and p.prokind = 'f'
       -- A TRIGGER IS NOT A DOOR. It fires inside whatever statement is
       -- already running, so the guard in front of that statement is the one
       -- that counts; putting another inside the trigger would only refuse a
       -- write that had already been allowed.
       and p.prorettype <> 'trigger'::regtype
       and p.prosrc ~* '\m(insert into|update |delete from)\M'
       and pg_get_functiondef(p.oid) not like '%assert_can_write%'
       and p.proname not in (
         -- may run for a shop that has NOT paid, on purpose:
         'assert_can_write', 'can_write', 'subscription_state',
         'delete_my_account',      -- a man may always leave, and Play requires it
         'login_email_for_phone',  -- signing in is not writing the books
         'join_org',               -- accepting an invitation
         -- housekeeping inside other guarded functions, or plain triggers:
         'post_voucher_cash', 'claim_invoice_no', 'next_invoice_no',
         'next_invoice_no_for', 'suggest_hsn', 'today_ist', 'fy_label')
     order by 1
  loop
    n := n + 1; names := names || ' ' || r.proname;
  end loop;
  if n = 0 then
    raise notice 'guards: every function that writes stands behind assert_can_write';
  else
    raise notice 'guards: % function(s) write without a guard -- look at these:%', n, names;
  end if;
end
$audit$;
