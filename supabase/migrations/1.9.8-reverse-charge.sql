-- ===========================================================================
--  SKWIK 1.9.8  —  REVERSE CHARGE, THE WAY A SHOP ACTUALLY MEETS IT
--
--  Run in the Supabase SQL Editor. Safe to run twice. Changes no data.
--
--  WHAT WAS WRONG
--
--  Skwik had reverse charge on SALE bills only — the rare case where the law
--  says the buyer pays the tax instead of the seller. A shop selling utensils
--  will never issue one. Meanwhile the case it meets every week had nowhere
--  to go: FREIGHT. When a goods transport agency carries his goods, the
--  transporter charges no GST and the shop owes it under section 9(3). Skwik
--  could not record that at all, so:
--
--    * the GST the shop owed was understated by every rupee of freight tax
--    * nothing told him what to put in GSTR-3B 3.1(d) or 4(A)(3)
--
--  A SECOND, OLDER FAULT, found while doing this. The balance sheet counted
--  the tax on every purchase as input credit the shop could claim — even for
--  a composition dealer, who may claim none of it. purchase_unit_cost was
--  already folding that tax into the cost of the goods, correctly, so a
--  composition shop was getting the benefit twice and being told it owed
--  less than it did.
--
--  WHAT THIS DOES
--
--   1  Money out can carry reverse-charge tax (freight, and the like).
--   2  The balance sheet puts reverse-charge tax on the side he OWES, and
--      on the side he CLAIMS only if he is entitled to claim it.
--   3  Composition dealers no longer claim input credit they cannot have.
--   4  rcm_summary() gives the GSTR-3B figures for a month, in the boxes
--      the portal asks for.
-- ===========================================================================

begin;

-- ---------------------------------------------------------------------------
--  1. MONEY OUT CAN CARRY TAX THAT IS HIS TO PAY
--
--  `amount` stays what he handed the transporter. The tax is worked out on
--  top of it and is owed to the government, not to the transporter — so it
--  never touches his cash or his bank here. Handing it over is recorded the
--  way it always was, as an expense marked is_gst_payment.
-- ---------------------------------------------------------------------------
alter table expenses add column if not exists reverse_charge boolean not null default false;
alter table expenses add column if not exists gst_rate numeric(5,2) not null default 0;
alter table expenses add column if not exists cgst numeric(14,2) not null default 0;
alter table expenses add column if not exists sgst numeric(14,2) not null default 0;
alter table expenses add column if not exists igst numeric(14,2) not null default 0;

-- WHICH SIDE OF REVERSE CHARGE THIS SHOP EVER SEES.
--
-- On a SALE it is rare enough that most shops should never be shown it at
-- all — and the tick sits right above the Total, where a mis-tap silently
-- strips the GST off a bill he is legally collecting on. Off until asked for.
--
-- On a PURCHASE it is the ordinary case — freight, most weeks — so it is on
-- for any registered shop unless he turns it off.
alter table orgs add column if not exists rcm_sales_enabled    boolean not null default false;
alter table orgs add column if not exists rcm_purchase_enabled boolean not null default true;

commit;


-- ---------------------------------------------------------------------------
--  2 and 3. THE BALANCE SHEET
-- ---------------------------------------------------------------------------
begin;

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
  v_comp   boolean := false;
  v_claim  boolean := false;
  v_erc    numeric := 0;
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

  -- tax collected, tax he owes under reverse charge, tax he may claim,
  -- tax already handed over
  if v_reg then
    select coalesce(is_composition, false) into v_comp from orgs where id = v_org;
    v_claim := not v_comp;

    select
      -- A CREDIT NOTE RAISED TOO LATE DOES NOT REDUCE THE TAX.
      -- Section 34(2) closes the door on 30 November. gstr1.js already
      -- leaves those notes out of the return; the balance sheet did not,
      -- so the screen told the shopkeeper he owed less than his own
      -- GSTR-1 file said he owed, and the screen is what he looks at.
      --
      -- REVERSE CHARGE ON A PURCHASE IS HIS OWN LIABILITY. The transporter
      -- charged him nothing, so there is no tax on the supplier's bill —
      -- the tax is his to work out and hand over under section 9(3). It
      -- belongs on the side he OWES, not only on the side he claims.
      coalesce(sum(case when vtype in ('sale','estimate')
                          and coalesce(counts_as_sale, true) then  (cgst+sgst+igst)
                        when vtype = 'sale_return'
                          and coalesce(gst_effective, true)  then -(cgst+sgst+igst)
                        when vtype = 'purchase'
                          and coalesce(reverse_charge, false) then  (cgst+sgst+igst)
                        when vtype = 'purchase_return'
                          and coalesce(reverse_charge, false) then -(cgst+sgst+igst)
                        else 0 end), 0),
      -- WHAT HE MAY CLAIM BACK. A composition dealer may claim nothing at
      -- all, and purchase_unit_cost already folds that tax into the cost of
      -- the goods — so counting it here as well handed him the benefit
      -- twice and understated what he owed.
      coalesce(sum(case when not v_claim                     then  0
                        when vtype = 'purchase'              then  (cgst+sgst+igst)
                        when vtype = 'purchase_return'       then -(cgst+sgst+igst)
                        else 0 end), 0)
      into v_out, v_in
      from vouchers
     where org_id = v_org and cancelled_at is null and vdate <= p_on;

    -- Freight and the like, entered under Money out rather than as a
    -- purchase bill. Same rule: his to pay, his to claim if he is allowed.
    select coalesce(sum(coalesce(cgst,0) + coalesce(sgst,0) + coalesce(igst,0)), 0)
      into v_erc
      from expenses
     where org_id = v_org and coalesce(reverse_charge, false) and edate <= p_on;

    v_out := v_out + v_erc;
    if v_claim then v_in := v_in + v_erc; end if;

    select coalesce(sum(amount), 0) into v_paid
      from expenses
     where org_id = v_org and is_gst_payment and edate <= p_on;

    v_gst := round(v_out - v_in - v_paid, 2);
  end if;

  v_assets := v_cash + v_bank + v_owed + v_stock + greatest(-v_gst, 0);
  v_liab   := v_owing + greatest(v_gst, 0);

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
    'assets',      round(v_assets, 2),
    'liabilities', round(v_liab, 2),
    'capital',     round(v_assets - v_liab, 2),
    'net_worth',   round(v_assets - v_liab, 2));
end $function$;


commit;


-- ---------------------------------------------------------------------------
--  4. THE GSTR-3B FIGURES FOR A MONTH
--
--  Reverse charge lands in two places on a 3B, and they are not the same
--  number for every shop:
--
--    3.1(d)   inward supplies liable to reverse charge — the taxable value
--             and the tax, which he must PAY in cash. Reverse-charge tax
--             can never be settled out of his credit balance.
--    4(A)(3)  input credit on those same supplies — which he may claim, but
--             only if he is a regular registered dealer. A composition
--             dealer claims nothing and the tax stays a cost.
--
--  Everything here is worked out from bills and Money out entries marked
--  reverse charge. It is not a whole GSTR-3B; it is the reverse-charge part
--  of one, so the figures can be typed in rather than worked out by hand.
-- ---------------------------------------------------------------------------
begin;

create or replace function public.rcm_summary(p_from date, p_to date)
returns jsonb language plpgsql stable security definer set search_path to 'public' as $fn$
declare
  v_org   uuid := my_org_id();
  v_reg   boolean;
  v_comp  boolean;
  v_claim boolean;
  v_val   numeric := 0;    -- taxable value
  v_c     numeric := 0;    -- central
  v_s     numeric := 0;    -- state
  v_i     numeric := 0;    -- integrated
  v_bills int     := 0;
  v_spend int     := 0;
begin
  if v_org is null then raise exception 'This login is not linked to a firm yet'; end if;
  if p_from is null or p_to is null or p_to < p_from then
    raise exception 'Give a month that starts before it ends';
  end if;

  select coalesce(is_gst_registered,false), coalesce(is_composition,false)
    into v_reg, v_comp from orgs where id = v_org;
  v_claim := v_reg and not v_comp;

  -- purchase bills marked reverse charge
  select coalesce(sum(taxable),0), coalesce(sum(cgst),0),
         coalesce(sum(sgst),0),    coalesce(sum(igst),0), count(*)
    into v_val, v_c, v_s, v_i, v_bills
    from vouchers
   where org_id = v_org and vtype = 'purchase'
     and coalesce(reverse_charge,false)
     and cancelled_at is null
     and vdate between p_from and p_to;

  -- and freight and the like under Money out
  select v_val + coalesce(sum(amount),0),
         v_c   + coalesce(sum(cgst),0),
         v_s   + coalesce(sum(sgst),0),
         v_i   + coalesce(sum(igst),0),
         count(*)
    into v_val, v_c, v_s, v_i, v_spend
    from expenses
   where org_id = v_org and coalesce(reverse_charge,false)
     and edate between p_from and p_to;

  return jsonb_build_object(
    'from', p_from, 'to', p_to,
    'entries',        v_bills + v_spend,
    'purchase_bills', v_bills,
    'money_out',      v_spend,
    -- 3.1(d): what he owes, and must pay in cash
    'table_3_1_d', jsonb_build_object(
      'taxable_value', round(v_val, 2),
      'central_tax',   round(v_c, 2),
      'state_tax',     round(v_s, 2),
      'integrated_tax',round(v_i, 2),
      'total_tax',     round(v_c + v_s + v_i, 2)),
    -- 4(A)(3): what he may claim back on the same supplies
    'table_4_a_3', jsonb_build_object(
      'can_claim',     v_claim,
      'central_tax',   case when v_claim then round(v_c, 2) else 0 end,
      'state_tax',     case when v_claim then round(v_s, 2) else 0 end,
      'integrated_tax',case when v_claim then round(v_i, 2) else 0 end,
      'total_tax',     case when v_claim then round(v_c + v_s + v_i, 2) else 0 end),
    'pay_in_cash',     round(v_c + v_s + v_i, 2),
    'net_cost',        case when v_claim then 0 else round(v_c + v_s + v_i, 2) end,
    'note', case when v_claim
                 then 'You owe this and you may claim the same amount back, so it costs you nothing — but it must be paid in cash, not out of your credit balance.'
                 else 'You owe this and cannot claim it back, so it is part of what the goods and the freight cost you.' end);
end $fn$;

revoke all on function public.rcm_summary(date, date) from public;
grant execute on function public.rcm_summary(date, date) to authenticated;

commit;
