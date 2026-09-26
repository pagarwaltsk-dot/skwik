-- ===========================================================================
--  1.9.45  SOLD BY THE DOZEN, COUNTED BY THE PIECE.
--
--  He sells the same thing two ways. A customer takes two dozen spoons; the
--  next takes fifteen pieces. Until now an item had one unit and one only, so
--  he had to do the arithmetic in his head at the counter and then type the
--  answer — or keep the same spoon twice, once by the dozen and once by the
--  piece, and watch two stock figures drift apart for ever.
--
--  ONE UNIT COUNTS THE SHELF. THE REST ARE WAYS OF SAYING IT.
--
--  This is the rule the whole thing rests on, and it does not bend. An item
--  has exactly one STOCK unit — the one every figure in the books is counted
--  in — and may have one other unit it is also sold and printed in, with how
--  many of the stock unit go into it.
--
--    Steel Tea Spoon    stock unit PCS    also sells by the DOZ, 12 to one
--
--  The bill then says what the customer actually bought, in the unit he
--  bought it in: "2 Doz @ 600". The shelf gives up 24 pieces. The GST return
--  says 2 DOZ, because DOZ is a real UQC and the portal takes it, and because
--  the return must agree with the invoice the customer is holding.
--
--  Stock, the item register, the stock report and the balance sheet stay in
--  the stock unit, always. Two figures in two units that must be reconciled
--  is exactly the mess this is meant to end.
--
--  WHAT CHANGES FOR A SHOP THAT NEVER TOUCHES IT: NOTHING.
--
--  Every line carries a factor, and the factor is 1 unless a shop has said
--  otherwise. Every bill already in his books has no factor at all, which
--  reads as 1. The arithmetic below multiplies by 1 for every voucher this
--  app has ever written, so not one stock figure moves by a hair.
--
--  The two functions below are the ones from 1.9.10, unchanged except for the
--  factor: they were taken out of that file as they stood and edited in two
--  places, rather than retyped, so nothing else can have drifted.
--
--  SAFE TO RUN TWICE.
-- ===========================================================================


-- ---------------------------------------------------------------------------
--  1. WHERE AN ITEM REMEMBERS ITS OTHER UNIT
-- ---------------------------------------------------------------------------

alter table public.items
  add column if not exists alt_unit text,
  add column if not exists alt_per  numeric(14,4),
  add column if not exists alt_rate numeric(14,2);

comment on column public.items.alt_unit is
  'A second unit this item is also sold and printed in. The stock unit stays in items.unit.';
comment on column public.items.alt_per is
  'How many stock units make one alt_unit. A dozen pieces is 12.';
comment on column public.items.alt_rate is
  'What one alt_unit sells for. Kept beside the factor so a dozen is priced as a dozen, not as twelve times a rounded piece rate.';

-- A FACTOR THAT CANNOT BE NOUGHT OR NEGATIVE.
--
-- "0 pieces to the dozen" would move no stock at all and never be noticed;
-- a minus would put goods back on the shelf as they were sold. Neither is a
-- thing a shopkeeper can mean, so neither is a thing he can save.
do $c$
begin
  if not exists (select 1 from pg_constraint where conname = 'items_alt_per_sane') then
    alter table public.items
      add constraint items_alt_per_sane
      check (alt_per is null or alt_per > 0);
  end if;
end
$c$;


-- ---------------------------------------------------------------------------
--  2. WHERE A LINE REMEMBERS WHICH UNIT IT WAS SOLD IN
-- ---------------------------------------------------------------------------
--
--  `unit` on the line already holds what is printed. `per` is how many stock
--  units that unit is worth. Together they are the whole mechanism: the bill
--  prints qty and unit, the shelf moves qty times per.

alter table public.voucher_lines
  add column if not exists per numeric(14,4) not null default 1;

comment on column public.voucher_lines.per is
  'Stock units per billed unit. 1 for every ordinary line, 12 for a line sold by the dozen out of a shelf counted in pieces.';


-- ---------------------------------------------------------------------------
--  3. SAVING AND EDITING A BILL, WITH THE FACTOR APPLIED
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
  v_date   date := coalesce(nullif(p->>'vdate','')::date, today_ist());
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
    raise exception 'Your books are closed up to %. Date this in a month that is still open — for a purchase the input credit can still be claimed there, and for a sale raise a credit note against the original bill.', to_char(v_lock, 'DD Mon YYYY');
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
      batch, expiry, cost, supply, godown_id, per)
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
      coalesce(v_cost, 0), supply_kind(ln->>'supply'),
      -- WHERE THIS LINE'S GOODS CAME FROM.
      -- The stock movement below has always honoured a per-line godown. The
      -- LINE itself did not remember it, so reopening the bill, reprinting it
      -- or restoring it from a backup quietly put every line back in the
      -- bill's own godown, and the stock went with it.
      coalesce(nullif(ln->>'godown_id','')::uuid, v_godown),
      -- HOW MANY STOCK UNITS ONE BILLED UNIT IS. One for everything that has
      -- ever been billed and for every shop that keeps a single unit, so this
      -- changes nothing at all until a shop says an item also sells by the
      -- dozen. See the note at the head of this file.
      greatest(coalesce((ln->>'per')::numeric, 1), 0.000001));

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
        -- TWO DOZEN OFF THE SHELF IS TWENTY-FOUR PIECES.
        --
        -- The bill says what the customer bought, in the unit he bought it
        -- in. The shelf is counted in one unit and one only. Those are not
        -- always the same unit, so the movement is the billed quantity times
        -- the factor on the line — and that factor is 1 for every bill this
        -- app has ever written, which is why nothing already in the books
        -- moves by a hair.
        case when v_type in ('purchase','sale_return')
          then coalesce((ln->>'qty')::numeric,0) * greatest(coalesce((ln->>'per')::numeric,1), 0.000001) else 0 end,
        case when v_type = 'purchase_return'
               or (v_type in ('sale','estimate') and v_counts)
          then coalesce((ln->>'qty')::numeric,0) * greatest(coalesce((ln->>'per')::numeric,1), 0.000001) else 0 end,
        v_type, v_id,
        coalesce(nullif(ln->>'godown_id','')::uuid, v_godown),
        nullif(ln->>'batch',''), nullif(ln->>'expiry','')::date);
    end if;
  end loop;

  perform post_voucher_cash(v_id, p);

  return jsonb_build_object('id', v_id, 'voucher_no', v_no, 'already', false);
end $function$;

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
      batch, expiry, cost, supply, godown_id, per)
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
      coalesce(v_cost, 0), supply_kind(ln->>'supply'),
      coalesce(nullif(ln->>'godown_id','')::uuid, v_godown),
      -- HOW MANY STOCK UNITS ONE BILLED UNIT IS. One for everything that has
      -- ever been billed and for every shop that keeps a single unit, so this
      -- changes nothing at all until a shop says an item also sells by the
      -- dozen. See the note at the head of this file.
      greatest(coalesce((ln->>'per')::numeric, 1), 0.000001));

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
        -- TWO DOZEN OFF THE SHELF IS TWENTY-FOUR PIECES.
        --
        -- The bill says what the customer bought, in the unit he bought it
        -- in. The shelf is counted in one unit and one only. Those are not
        -- always the same unit, so the movement is the billed quantity times
        -- the factor on the line — and that factor is 1 for every bill this
        -- app has ever written, which is why nothing already in the books
        -- moves by a hair.
        case when v_type in ('purchase','sale_return')
          then coalesce((ln->>'qty')::numeric,0) * greatest(coalesce((ln->>'per')::numeric,1), 0.000001) else 0 end,
        case when v_type = 'purchase_return'
               or (v_type in ('sale','estimate') and v_counts)
          then coalesce((ln->>'qty')::numeric,0) * greatest(coalesce((ln->>'per')::numeric,1), 0.000001) else 0 end,
        v_type, v_id,
        coalesce(nullif(ln->>'godown_id','')::uuid, v_godown),
        nullif(ln->>'batch',''), nullif(ln->>'expiry','')::date);
    end if;
  end loop;

  perform post_voucher_cash(v_id, p);

  return jsonb_build_object('id', v_id, 'voucher_no', v_no);
end $function$;


-- ---------------------------------------------------------------------------
--  4. AND THE OWNER CHECK, ONCE MORE
-- ---------------------------------------------------------------------------

do $chk$
declare want oid; got oid;
begin
  select proowner into want from pg_proc where oid = 'public.post_voucher_cash(uuid, jsonb)'::regprocedure;
  select proowner into got  from pg_proc where oid = 'public.save_voucher(jsonb)'::regprocedure;
  if want is not null and got is not null and want <> got then
    raise exception
      'save_voucher was replaced by a different login from the one that owns the other book functions. Run every Skwik migration from the same Supabase SQL editor login.';
  end if;
end
$chk$;
