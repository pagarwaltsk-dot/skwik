-- ===========================================================================
--  SKWIK 1.9  —  correction release
--
--  Run this whole file once in the Supabase SQL editor. It is safe to run
--  twice; everything in it is written to be repeatable.
--
--  WHAT IT PUTS RIGHT
--   1  A real receipt is no longer deleted when a bill it was tied to is
--      edited or cancelled.  (update_voucher, delete_voucher)
--   2  write_off can only be done by the owner.  (write_off)
--   3  A credit note raised after the 30 November deadline no longer reduces
--      the GST the balance sheet says is owed.  (balance_sheet)
--   4  Bills can carry nil-rated, exempt and outside-GST lines, so GSTR-1
--      Table 8 can be filled.  (voucher_lines.supply, vouchers totals)
--   5  A read-only accountant seat, so the shop's CA can look at everything
--      and change nothing.  (role 'accountant')
--   6  Items can carry a barcode.  (items.barcode)
-- ===========================================================================

begin;

-- ---------------------------------------------------------------------------
--  1. NEW COLUMNS
-- ---------------------------------------------------------------------------

-- WHO MADE THIS PAYMENT ROW.
--
-- post_voucher_cash() creates the payment that came in WITH the bill. A
-- payment can also be tied to a bill afterwards — the sample run does this to
-- a real receipt the shopkeeper had already entered. Only the first kind may
-- be deleted along with the bill.
alter table payments
  add column if not exists from_voucher boolean not null default false;

-- Everything already tied to a bill and worded the way post_voucher_cash
-- words it was made by the bill. Anything else was tied afterwards and is
-- somebody's real money.
update payments
   set from_voucher = true
 where ref_voucher_id is not null
   and from_voucher = false
   and (note like 'Cash for %' or note like 'Refund on %'
     or note like 'Paid for %' or note like 'Received on %');

-- WHAT KIND OF SUPPLY A LINE IS.
--
-- GSTR-1 Table 8 asks for nil-rated, exempted and non-GST supplies as three
-- separate figures. A shop billing nil-rated milk as an ordinary 0% taxable
-- line files an empty Table 8 and an overstated taxable turnover.
alter table voucher_lines
  add column if not exists supply text not null default 'taxable';

alter table items
  add column if not exists supply text not null default 'taxable';

-- A barcode, so the counter can scan instead of search. Any scanner that
-- types the code works — the cheap USB and Bluetooth ones all do.
alter table items
  add column if not exists barcode text;

create index if not exists items_barcode_idx
  on items (org_id, barcode) where barcode is not null;

-- The three Table 8 figures, kept on the bill so reports do not have to add
-- up lines to find them.
alter table vouchers add column if not exists nil_rated  numeric(14,2) not null default 0;
alter table vouchers add column if not exists exempt_amt numeric(14,2) not null default 0;
alter table vouchers add column if not exists non_gst    numeric(14,2) not null default 0;

-- ---------------------------------------------------------------------------
--  2. HELPERS
-- ---------------------------------------------------------------------------

-- Anything that is not one of the four kinds is an ordinary taxable line.
create or replace function public.supply_kind(p text)
returns text language sql immutable as $$
  select case lower(coalesce(nullif(trim(p), ''), 'taxable'))
           when 'nil'     then 'nil'
           when 'exempt'  then 'exempt'
           when 'non_gst' then 'non_gst'
           else 'taxable'
         end
$$;

-- THE ACCOUNTANT SEAT.
--
-- Both Vyapar and myBillBook give the shop's CA a free login, and the CA is a
-- gatekeeper: he will veto software he cannot see into. An accountant here
-- reads everything and writes nothing — he is not a second owner and not a
-- biller, so no RPC and no table will take a change from him.
create or replace function public.can_write()
returns boolean language sql stable security definer set search_path to 'public' as $$
  select coalesce(my_role(), 'staff') <> 'accountant'
$$;

create or replace function public.assert_can_write()
returns void language plpgsql stable security definer set search_path to 'public' as $$
begin
  if not can_write() then
    raise exception 'This login can look at the books but not change them';
  end if;
end $$;

-- ---------------------------------------------------------------------------
--  3. THE ACCOUNTANT CANNOT WRITE — AT THE TABLE LEVEL TOO
--
--  The RPCs are guarded above, but a client can also write straight to a
--  table through PostgREST, so the tables have to say no as well. These are
--  RESTRICTIVE policies: they are ANDed with the ordinary org policy rather
--  than ORed, so they can only take permission away, never give it. Reading
--  is untouched.
-- ---------------------------------------------------------------------------

do $$
declare t text;
begin
  foreach t in array array[
    'items','parties','vouchers','voucher_lines','payments','expenses',
    'expense_heads','bank_accounts','godowns','stock_moves','invoice_series',
    'sample_runs','hsn_hints'
  ] loop
    execute format('drop policy if exists ro_accountant_ins on public.%I', t);
    execute format('drop policy if exists ro_accountant_upd on public.%I', t);
    execute format('drop policy if exists ro_accountant_del on public.%I', t);
    execute format(
      'create policy ro_accountant_ins on public.%I as restrictive for insert
         with check (can_write())', t);
    execute format(
      'create policy ro_accountant_upd on public.%I as restrictive for update
         using (can_write()) with check (can_write())', t);
    execute format(
      'create policy ro_accountant_del on public.%I as restrictive for delete
         using (can_write())', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
--  post_voucher_cash
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.post_voucher_cash(p_id uuid, p jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v       vouchers%rowtype;
  v_paid  numeric;
  v_cash  boolean;
begin
  select * into v from vouchers where id = p_id;
  if not found then return; end if;

  v_cash := coalesce((p->>'is_cash')::boolean, v.is_cash, false);
  v_paid := nullif(p->>'paid_amount','')::numeric;

  if v_paid is null then
    v_paid := case when v_cash then coalesce(v.total, 0) else 0 end;
  end if;
  v_paid := round(coalesce(v_paid, 0), 2);
  if v_paid <= 0 then return; end if;
  if v_paid > coalesce(v.total, 0) then v_paid := v.total; end if;

  if v.vtype in ('sale','estimate') and coalesce(v.counts_as_sale, true) then
    insert into payments (org_id, ptype, party_id, pdate, mode, amount, note,
                          ref_voucher_id, account_id, from_voucher)
    values (v.org_id, 'receipt', v.party_id, v.vdate,
            coalesce(nullif(p->>'pay_mode',''), 'cash'), v_paid,
            'Cash for ' || coalesce(v.voucher_no, ''), v.id,
            nullif(p->>'account_id','')::uuid, true);

  elsif v.vtype = 'sale_return' then
    insert into payments (org_id, ptype, party_id, pdate, mode, amount, note,
                          ref_voucher_id, account_id, from_voucher)
    values (v.org_id, 'payment', v.party_id, v.vdate,
            coalesce(nullif(p->>'pay_mode',''), 'cash'), v_paid,
            'Refund on ' || coalesce(v.voucher_no, ''), v.id,
            nullif(p->>'account_id','')::uuid, true);

  elsif v.vtype = 'purchase' then
    insert into payments (org_id, ptype, party_id, pdate, mode, amount, note,
                          ref_voucher_id, account_id, from_voucher)
    values (v.org_id, 'payment', v.party_id, v.vdate,
            coalesce(nullif(p->>'pay_mode',''), 'cash'), v_paid,
            'Paid on ' || coalesce(v.voucher_no, ''), v.id,
            nullif(p->>'account_id','')::uuid, true);

  elsif v.vtype = 'purchase_return' then
    insert into payments (org_id, ptype, party_id, pdate, mode, amount, note,
                          ref_voucher_id, account_id, from_voucher)
    values (v.org_id, 'receipt', v.party_id, v.vdate,
            coalesce(nullif(p->>'pay_mode',''), 'cash'), v_paid,
            'Refund on ' || coalesce(v.voucher_no, ''), v.id,
            nullif(p->>'account_id','')::uuid, true);
  end if;
end $function$

;

-- ---------------------------------------------------------------------------
--  save_voucher
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.save_voucher(p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_counts boolean;
  v_org    uuid := my_org_id();
  v_id     uuid := coalesce(nullif(p->>'id','')::uuid, gen_random_uuid());
  v_type   text := p->>'vtype';
  v_no     text;
  v_given  text := nullif(p->>'voucher_no','');
  v_date   date := coalesce(nullif(p->>'vdate','')::date, current_date);
  v_party  uuid := nullif(p->>'party_id','')::uuid;
  v_paid   numeric;
  v_eff    boolean := true;
  v_refdt  date;
  ln       jsonb;
  i        int := 0;
  v_lock   date;
  v_try    int;
  v_godown uuid;
  v_cost   numeric;
begin
  perform assert_can_write();
  if v_org is null then
    raise exception 'This login is not linked to a firm yet';
  end if;

  select case when coalesce(p->>'vtype','sale') <> 'estimate' then true
              else (o.mode = 'estimate') end
    into v_counts
    from orgs o where o.id = v_org;
  v_counts := coalesce(v_counts, true);

  select books_locked_upto into v_lock from orgs where id = v_org;
  if v_lock is not null and v_date <= v_lock then
    raise exception 'Your books are closed up to %. Raise a credit note instead of changing a bill in a filed month.', to_char(v_lock, 'DD Mon YYYY');
  end if;

  v_godown := coalesce(nullif(p->>'godown_id','')::uuid,
                       (select default_godown_id from orgs where id = v_org));

  select voucher_no into v_no from vouchers where id = v_id and org_id = v_org;
  if found then
    return jsonb_build_object('id', v_id, 'voucher_no', v_no, 'already', true);
  end if;

  -- Section 34(2): a credit note against a bill from an earlier year is
  -- only good for a return up to 30 November of the year after it. Past
  -- that the note is still raised, and still moves the customer's
  -- balance, but it is kept out of GSTR-1.
  if v_type = 'sale_return' then
    v_refdt := coalesce(nullif(p->>'ref_invoice_date','')::date,
                        (select vdate from vouchers
                          where id = nullif(p->>'ref_voucher_id','')::uuid));
    if v_refdt is not null then
      v_eff := v_date <= make_date(
                 case when extract(month from v_refdt) >= 4
                      then extract(year from v_refdt)::int + 1
                      else extract(year from v_refdt)::int end, 11, 30);
    end if;
  end if;

  if v_type in ('sale','estimate') and v_given is not null then
    v_no := v_given;
    perform claim_invoice_no(v_org, v_date, v_type, v_no);
  elsif v_type = 'sale' then
    v_no := next_invoice_no_for(v_org, v_date, 'sale');
  elsif v_type = 'estimate' then
    v_no := next_invoice_no_for(v_org, v_date, 'estimate');
  elsif v_type = 'sale_return' then
    if v_given is not null then
      v_no := v_given;
    else
      update orgs set next_credit_no = next_credit_no + 1
        where id = v_org
        returning coalesce(credit_prefix,'CN-') || (next_credit_no - 1)::text into v_no;
    end if;
  elsif v_type = 'purchase_return' then
    if v_given is not null then
      v_no := v_given;
    else
      update orgs set next_debit_no = next_debit_no + 1
        where id = v_org
        returning coalesce(debit_prefix,'DN-') || (next_debit_no - 1)::text into v_no;
    end if;
  else
    v_no := v_given;
  end if;

  for v_try in 1..25 loop
    begin
      insert into vouchers (
        counts_as_sale, gst_effective, reverse_charge,
        id, org_id, vtype, voucher_no, vdate, party_id, printed_name, is_cash,
        supplier_invoice_no, supplier_invoice_date, place_of_supply_code, tax_mode,
        taxable, cgst, sgst, igst, extra_amount, extra_note, round_off, total, notes, discount,
        ref_voucher_id, ref_invoice_no, ref_invoice_date, extra_gst_rate, godown_id,
        nil_rated, exempt_amt, non_gst)
      values (
        v_counts, v_eff, coalesce((p->>'reverse_charge')::boolean, false),
        v_id, v_org, v_type, v_no, v_date,
        v_party, p->>'printed_name', coalesce((p->>'is_cash')::boolean, false),
        nullif(p->>'supplier_invoice_no',''), nullif(p->>'supplier_invoice_date','')::date,
        nullif(p->>'place_of_supply_code',''), coalesce(nullif(p->>'tax_mode',''),'none'),
        coalesce((p->>'taxable')::numeric,0), coalesce((p->>'cgst')::numeric,0),
        coalesce((p->>'sgst')::numeric,0),    coalesce((p->>'igst')::numeric,0),
        coalesce((p->>'extra_amount')::numeric,0), nullif(p->>'extra_note',''),
        coalesce((p->>'round_off')::numeric,0), coalesce((p->>'total')::numeric,0),
        nullif(p->>'notes',''), coalesce((p->>'discount')::numeric,0),
        nullif(p->>'ref_voucher_id','')::uuid, nullif(p->>'ref_invoice_no',''),
        nullif(p->>'ref_invoice_date','')::date,
        coalesce((p->>'extra_gst_rate')::numeric,0), v_godown,
        coalesce((p->>'nil_rated')::numeric,0), coalesce((p->>'exempt')::numeric,0),
        coalesce((p->>'non_gst')::numeric,0));
      exit;
    exception when unique_violation then
      if v_type in ('sale','estimate') and v_given is null then
        v_no := next_invoice_no_for(v_org, v_date, v_type);
      else
        raise exception 'Bill number % is already used in your books. Change the number and save again.', v_no;
      end if;
      if v_try = 25 then
        raise exception 'Could not find a free bill number. Check your numbering in Settings.';
      end if;
    end;
  end loop;

  for ln in select * from jsonb_array_elements(coalesce(p->'lines','[]'::jsonb)) loop
    i := i + 1;

    -- what this line cost the shop, decided now and never again
    v_cost := 0;
    if nullif(ln->>'item_id','') is not null then
      if v_type = 'purchase' then
        -- A shop that cannot claim the tax back has paid it, so it is part
        -- of what the goods cost. purchase_unit_cost() knows which kind of
        -- shop this is.
        v_cost := purchase_unit_cost(v_org, ln);
      else
        select coalesce(nullif(purchase_price, 0), 0) into v_cost
          from items where id = (ln->>'item_id')::uuid;
      end if;
    end if;

    insert into voucher_lines (
      voucher_id, org_id, item_id, item_name, hsn, unit, qty, rate, gst_rate,
      taxable, cgst, sgst, igst, amount, line_no, flag, checked, note, disc,
      batch, expiry, cost, supply)
    values (
      v_id, v_org, nullif(ln->>'item_id','')::uuid, ln->>'item_name',
      nullif(ln->>'hsn',''), nullif(ln->>'unit',''),
      coalesce((ln->>'qty')::numeric,0), coalesce((ln->>'rate')::numeric,0),
      coalesce((ln->>'gst_rate')::numeric,0), coalesce((ln->>'taxable')::numeric,0),
      coalesce((ln->>'cgst')::numeric,0), coalesce((ln->>'sgst')::numeric,0),
      coalesce((ln->>'igst')::numeric,0), coalesce((ln->>'amount')::numeric,0), i,
      coalesce((ln->>'flag')::boolean,false), coalesce((ln->>'checked')::boolean,false),
      nullif(ln->>'note',''), coalesce((ln->>'disc')::numeric,0),
      nullif(ln->>'batch',''), nullif(ln->>'expiry','')::date,
      coalesce(v_cost, 0), supply_kind(ln->>'supply'));

    if nullif(ln->>'item_id','') is not null
       and exists (select 1 from items where id = (ln->>'item_id')::uuid) then

      -- a purchase teaches the item master what it costs now
      if v_type = 'purchase' and coalesce(v_cost, 0) > 0 then
        update items set purchase_price = v_cost
         where id = (ln->>'item_id')::uuid and org_id = v_org;
      end if;

      insert into stock_moves (org_id, item_id, mdate, qty_in, qty_out, reason, ref_voucher_id,
                               godown_id, batch, expiry)
      values (
        v_org, (ln->>'item_id')::uuid, v_date,
        case when v_type in ('purchase','sale_return')            then coalesce((ln->>'qty')::numeric,0) else 0 end,
        case when v_type = 'purchase_return'
               or (v_type in ('sale','estimate') and v_counts)
          then coalesce((ln->>'qty')::numeric,0) else 0 end,
        v_type, v_id,
        coalesce(nullif(ln->>'godown_id','')::uuid, v_godown),
        nullif(ln->>'batch',''), nullif(ln->>'expiry','')::date);
    end if;
  end loop;

  perform post_voucher_cash(v_id, p);

  return jsonb_build_object('id', v_id, 'voucher_no', v_no, 'already', false);
end $function$

;

-- ---------------------------------------------------------------------------
--  update_voucher
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.update_voucher(p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_counts boolean;
  v_org   uuid := my_org_id();
  v_id    uuid := nullif(p->>'id','')::uuid;
  v_type  text;
  v_no    text;
  v_was   date;
  v_date  date;
  v_party uuid := nullif(p->>'party_id','')::uuid;
  ln      jsonb;
  i       int := 0;
  v_lock  date;
  v_godown uuid;
  v_cost  numeric;
begin
  perform assert_can_write();
  if v_org is null then
    raise exception 'This login is not linked to a firm yet';
  end if;
  if v_id is null then
    raise exception 'Which bill? No id was sent';
  end if;

  select case when coalesce(p->>'vtype','sale') <> 'estimate' then true
              else (o.mode = 'estimate') end
    into v_counts
    from orgs o where o.id = v_org;
  v_counts := coalesce(v_counts, true);

  select vtype, voucher_no, vdate into v_type, v_no, v_was
    from vouchers where id = v_id and org_id = v_org;
  if not found then
    raise exception 'That bill is not in your books any more';
  end if;

  -- the date the screen is asking for, or the one it already had
  v_date := coalesce(nullif(p->>'vdate','')::date, v_was);

  select books_locked_upto into v_lock from orgs where id = v_org;
  if v_lock is not null and v_was <= v_lock then
    raise exception 'Your books are closed up to %. Raise a credit note instead of changing a bill in a filed month.', to_char(v_lock, 'DD Mon YYYY');
  end if;
  if v_lock is not null and v_date <= v_lock then
    raise exception 'That date falls in a month you have closed';
  end if;

  v_godown := coalesce(nullif(p->>'godown_id','')::uuid,
                       (select default_godown_id from orgs where id = v_org));

  update vouchers set
    counts_as_sale        = v_counts,
    reverse_charge        = coalesce((p->>'reverse_charge')::boolean, false),
    vdate                 = v_date,
    party_id              = v_party,
    printed_name          = p->>'printed_name',
    is_cash               = coalesce((p->>'is_cash')::boolean, false),
    supplier_invoice_no   = nullif(p->>'supplier_invoice_no',''),
    supplier_invoice_date = nullif(p->>'supplier_invoice_date','')::date,
    place_of_supply_code  = nullif(p->>'place_of_supply_code',''),
    tax_mode              = coalesce(nullif(p->>'tax_mode',''),'none'),
    taxable               = coalesce((p->>'taxable')::numeric,0),
    cgst                  = coalesce((p->>'cgst')::numeric,0),
    sgst                  = coalesce((p->>'sgst')::numeric,0),
    igst                  = coalesce((p->>'igst')::numeric,0),
    extra_amount          = coalesce((p->>'extra_amount')::numeric,0),
    extra_note            = nullif(p->>'extra_note',''),
    round_off             = coalesce((p->>'round_off')::numeric,0),
    extra_gst_rate        = coalesce((p->>'extra_gst_rate')::numeric,0),
    godown_id             = v_godown,
    discount              = coalesce((p->>'discount')::numeric,0),
    nil_rated             = coalesce((p->>'nil_rated')::numeric,0),
    exempt_amt            = coalesce((p->>'exempt')::numeric,0),
    non_gst               = coalesce((p->>'non_gst')::numeric,0),
    total                 = coalesce((p->>'total')::numeric,0),
    notes                 = nullif(p->>'notes','')
  where id = v_id and org_id = v_org;

  delete from voucher_lines where voucher_id = v_id and org_id = v_org;
  delete from stock_moves   where ref_voucher_id = v_id and org_id = v_org;
  -- A PAYMENT THE BILL MADE ITSELF GOES; A REAL RECEIPT DOES NOT.
  --
  -- post_voucher_cash() creates the counter payment that came in WITH the
  -- bill, and that one has to go when the bill is re-written or cancelled.
  -- But a payment can also be TIED to a bill afterwards — the sample run does
  -- exactly this to a real receipt the shopkeeper had already entered — and
  -- deleting those took the customer's money out of the cash book with no
  -- message. `from_voucher` says which is which: the bill's own payment is
  -- removed, anything else is simply un-tied and left alone.
  update payments set ref_voucher_id = null
   where ref_voucher_id = v_id and org_id = v_org and not coalesce(from_voucher, false);
  delete from payments
   where ref_voucher_id = v_id and org_id = v_org and coalesce(from_voucher, false);

  for ln in select * from jsonb_array_elements(coalesce(p->'lines','[]'::jsonb)) loop
    i := i + 1;

    v_cost := 0;
    if nullif(ln->>'item_id','') is not null then
      if v_type = 'purchase' then
        -- A shop that cannot claim the tax back has paid it, so it is part
        -- of what the goods cost. purchase_unit_cost() knows which kind of
        -- shop this is.
        v_cost := purchase_unit_cost(v_org, ln);
      else
        select coalesce(nullif(purchase_price, 0), 0) into v_cost
          from items where id = (ln->>'item_id')::uuid;
      end if;
    end if;

    insert into voucher_lines (
      voucher_id, org_id, item_id, item_name, hsn, unit, qty, rate, gst_rate,
      taxable, cgst, sgst, igst, amount, line_no, flag, checked, note, disc,
      batch, expiry, cost, supply)
    values (
      v_id, v_org, nullif(ln->>'item_id','')::uuid, ln->>'item_name',
      nullif(ln->>'hsn',''), nullif(ln->>'unit',''),
      coalesce((ln->>'qty')::numeric,0), coalesce((ln->>'rate')::numeric,0),
      coalesce((ln->>'gst_rate')::numeric,0), coalesce((ln->>'taxable')::numeric,0),
      coalesce((ln->>'cgst')::numeric,0), coalesce((ln->>'sgst')::numeric,0),
      coalesce((ln->>'igst')::numeric,0), coalesce((ln->>'amount')::numeric,0), i,
      coalesce((ln->>'flag')::boolean,false), coalesce((ln->>'checked')::boolean,false),
      nullif(ln->>'note',''), coalesce((ln->>'disc')::numeric,0),
      nullif(ln->>'batch',''), nullif(ln->>'expiry','')::date,
      coalesce(v_cost, 0), supply_kind(ln->>'supply'));

    if nullif(ln->>'item_id','') is not null
       and exists (select 1 from items where id = (ln->>'item_id')::uuid) then

      if v_type = 'purchase' and coalesce(v_cost, 0) > 0 then
        update items set purchase_price = v_cost
         where id = (ln->>'item_id')::uuid and org_id = v_org;
      end if;

      insert into stock_moves (org_id, item_id, mdate, qty_in, qty_out, reason, ref_voucher_id,
                               godown_id, batch, expiry)
      values (
        v_org, (ln->>'item_id')::uuid, v_date,
        case when v_type in ('purchase','sale_return')            then coalesce((ln->>'qty')::numeric,0) else 0 end,
        case when v_type = 'purchase_return'
               or (v_type in ('sale','estimate') and v_counts)
          then coalesce((ln->>'qty')::numeric,0) else 0 end,
        v_type, v_id,
        coalesce(nullif(ln->>'godown_id','')::uuid, v_godown),
        nullif(ln->>'batch',''), nullif(ln->>'expiry','')::date);
    end if;
  end loop;

  perform post_voucher_cash(v_id, p);

  return jsonb_build_object('id', v_id, 'voucher_no', v_no);
end $function$

;

-- ---------------------------------------------------------------------------
--  delete_voucher
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.delete_voucher(p_id uuid, p_reason text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_org  uuid := my_org_id();
  v_date date;
  v_type text;
  v_lock date;
begin
  if v_org is null then
    raise exception 'This login is not linked to a firm yet';
  end if;
  perform assert_can_write();
  if my_role() <> 'owner' then
    raise exception 'Only the owner can remove a bill';
  end if;

  select vdate, vtype into v_date, v_type
    from vouchers where id = p_id and org_id = v_org;
  if not found then return; end if;

  select books_locked_upto into v_lock from orgs where id = v_org;
  if v_lock is not null and v_date <= v_lock then
    raise exception 'Your books are closed up to %. Raise a credit note instead of removing a bill from a filed month.', to_char(v_lock, 'DD Mon YYYY');
  end if;

  -- A PAYMENT THE BILL MADE ITSELF GOES; A REAL RECEIPT DOES NOT.
  --
  -- post_voucher_cash() creates the counter payment that came in WITH the
  -- bill, and that one has to go when the bill is re-written or cancelled.
  -- But a payment can also be TIED to a bill afterwards — the sample run does
  -- exactly this to a real receipt the shopkeeper had already entered — and
  -- deleting those took the customer's money out of the cash book with no
  -- message. `from_voucher` says which is which: the bill's own payment is
  -- removed, anything else is simply un-tied and left alone.
  update payments set ref_voucher_id = null
   where ref_voucher_id = p_id and org_id = v_org and not coalesce(from_voucher, false);
  delete from payments
   where ref_voucher_id = p_id and org_id = v_org and coalesce(from_voucher, false);
  delete from stock_moves where ref_voucher_id = p_id and org_id = v_org;

  if v_type in ('sale','estimate') then
    -- the number stays in the book, and the bill stands at nil
    update vouchers
       set cancelled_at = now(),
           cancel_reason = nullif(p_reason, ''),
           gst_effective = false
     where id = p_id and org_id = v_org;
    delete from voucher_lines where voucher_id = p_id and org_id = v_org;
  else
    delete from voucher_lines where voucher_id = p_id and org_id = v_org;
    delete from vouchers      where id = p_id and org_id = v_org;
  end if;
end $function$

;

-- ---------------------------------------------------------------------------
--  write_off
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.write_off(p_party uuid, p_amount numeric, p_date date DEFAULT CURRENT_DATE, p_note text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_org uuid := my_org_id();
  v_amt numeric := round(coalesce(p_amount, 0), 2);
  v_id  uuid;
begin
  if v_org is null then raise exception 'This login is not linked to a firm yet'; end if;
  -- WRITING OFF IS THE ONE THING A BILLER MUST NOT DO.
  -- It clears a customer's balance without any cash arriving, so a man on
  -- the counter could pocket what the customer paid and write off the same
  -- amount, and the books would still balance. Every other money function
  -- here already checks the role; this one did not.
  if my_role() <> 'owner' then
    raise exception 'Only the owner can write off an amount';
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
          p_party, coalesce(p_date, current_date), 'writeoff', abs(v_amt),
          coalesce(nullif(p_note, ''), 'Written off'))
  returning id into v_id;

  return jsonb_build_object('id', v_id, 'amount', abs(v_amt));
end $function$

;

-- ---------------------------------------------------------------------------
--  balance_sheet
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.balance_sheet(p_on date DEFAULT CURRENT_DATE)
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
end $function$

;

-- ---------------------------------------------------------------------------
--  LOGGING IN AFTER A RECOVERY EMAIL IS SAVED
--
--  Skwik signs a shopkeeper in on his mobile number, which stands in for an
--  email address behind the scenes. Saving a real email for password resets
--  REPLACES that address on the account — so from that moment the mobile
--  number no longer matched anything and he was locked out of his own shop by
--  the very feature meant to get him back in.
--
--  This lets the login screen ask what address that number belongs to now, so
--  the mobile number keeps working exactly as before.
--
--  It answers only for a number that is already registered, which is the same
--  thing any "send me an OTP" screen in the country gives away.
-- ---------------------------------------------------------------------------

create or replace function public.login_email_for_phone(p_phone text)
returns text
language sql stable security definer set search_path to 'public', 'auth' as $$
  select u.email
    from profiles p
    join auth.users u on u.id = p.id
   where regexp_replace(coalesce(p_phone, ''), '\D', '', 'g') <> ''
     and regexp_replace(coalesce(p.phone, ''), '\D', '', 'g')
       = regexp_replace(coalesce(p_phone, ''), '\D', '', 'g')
   limit 1
$$;

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'grant execute on function public.login_email_for_phone(text) to anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function public.login_email_for_phone(text) to authenticated';
  end if;
end $$;

-- ---------------------------------------------------------------------------
--  THE REST OF THE MUTATING RPCs REFUSE A READ-ONLY SEAT TOO
-- ---------------------------------------------------------------------------

do $$
declare f record; body text;
begin
  for f in
    select p.oid, p.proname, pg_get_functiondef(p.oid) as def
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('transfer_stock','set_invoice_start','remove_staff',
                         'reset_join_code','close_join','wipe_org',
                         'undo_sample_run','join_org','claim_invoice_no')
       and pg_get_functiondef(p.oid) not like '%assert_can_write%'
  loop
    body := f.def;
    -- slip the guard in right after the first begin of the function body
    body := regexp_replace(body, '(AS \$function\$.*?\nbegin\n)',
                           E'\\1  perform assert_can_write();\n');
    if body <> f.def then
      execute body;
      raise notice 'guarded %', f.proname;
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
--  MAKING SOMEBODY THE SHOP'S ACCOUNTANT
--
--  The owner decides. A counter hand bills and takes money; an accountant
--  reads everything and changes nothing. Nobody can make themselves either,
--  and the owner's own row cannot be changed — a shop with no owner is a shop
--  nobody can get back into.
-- ---------------------------------------------------------------------------

create or replace function public.set_staff_role(p_id uuid, p_role text)
returns void
language plpgsql security definer set search_path to 'public' as $$
declare
  v_org uuid := my_org_id();
  v_new text := lower(trim(coalesce(p_role, '')));
begin
  if v_org is null then raise exception 'This login is not linked to a firm yet'; end if;
  if my_role() <> 'owner' then
    raise exception 'Only the owner can change what someone is allowed to do';
  end if;
  if v_new not in ('staff', 'accountant') then
    raise exception 'A person here is either the counter or the accountant';
  end if;
  if p_id = auth.uid() then
    raise exception 'You cannot change your own role';
  end if;
  if exists (select 1 from orgs where id = v_org and owner_id = p_id) then
    raise exception 'The owner of the shop cannot be changed to anything else';
  end if;

  update profiles set role = v_new where id = p_id and org_id = v_org;
  if not found then raise exception 'That person is not in your shop'; end if;
end $$;

commit;
