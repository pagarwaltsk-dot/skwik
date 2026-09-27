-- ===========================================================================
--  1.10.3  WHAT A THING COST, AND WHAT AN IMPORT BROUGHT IN.
--
--  Two sets of faults, and the second was found by going looking for it.
--
--  ---------------------------------------------------------------------------
--  A. THE IMPORT COUNTED THE TAX TWICE ON EVERY BILL IT WROTE
--  ---------------------------------------------------------------------------
--  Reported, in his own words:
--
--      10 pc at 500 per pc = 5000 (in bill amount is shown directly 5250)
--      And below bill again
--        5250 + 125 + 125 = 5500
--      But correct amount is 5250 in our tally
--
--  The importer wrote each line's `amount` as the taxable value PLUS the tax.
--  Everywhere else in Skwik a line's amount IS its taxable value -- the screen
--  writes it that way and the printed bill puts it in the amount column and
--  then adds the tax rows underneath. So the paper taxed every line twice.
--
--  Measured on his own day book: 74 of his 90 bills printed wrong. His bill
--  1380 would have gone out at 41,632.79 against Tally's 38,855.00. The bill's
--  own stored total was right all along, which is why the reports looked fine
--  and only the paper he handed the customer was wrong.
--
--  The reading is fixed in the app. This file mends the bills already written,
--  and it can tell them apart with certainty: the screen has always written
--  amount and taxable equal, so a line where they differ is an imported one
--  and nothing else.
--
--  Two more from the same import, mended here:
--    - a bill's taxable value did not include the freight riding on it, so the
--      profit report and GSTR-1 were short by it
--    - sixteen of his purchases are a transporter's bill -- an amount against a
--      stock item with no quantity -- and the charge was stored while the bill's
--      taxable value stayed at nought
--
--  ---------------------------------------------------------------------------
--  B. COST OF GOODS SOLD. "I FEEL SOMETHING CREEPY THERE."
--  ---------------------------------------------------------------------------
--  He was right. Six faults, and the first is the one that matters most to a
--  shop that keeps bundles, bags and loose pieces:
--
--  1. THE ALT-UNIT FACTOR WAS MISSING FROM COST AND FROM STOCK VALUE.
--     Buy 2 Doz for 1,200: the item master learnt 600 a dozen, and 24 pieces
--     went on the shelf. The balance sheet then valued 24 x 600 = 14,400 of
--     goods that cost 1,200. Sell those 24 pieces and the cost came out at
--     14,400 against maybe 2,000 of revenue -- a twelve-thousand-rupee "loss"
--     on a profitable sale. Bill the same goods BY THE DOZEN and the figure was
--     right, by the two errors cancelling. Right or twelve times wrong
--     depending on nothing but which unit the counter reached for.
--
--  2. GOODS WITH NO COST WERE VALUED AT WHAT THEY SELL FOR.
--     Unrealised profit booked straight into assets and capital -- and the
--     profit report has no such fallback, so the same item was worth its retail
--     price on the balance sheet and cost nothing at all in the P&L.
--
--  3. A SET CARRIED NO COST AT ALL.
--     A drum body and a lid sold as one drum: the shelf gives up the parts, and
--     the sale showed the whole of its price as profit. 1.9.48 saw this coming
--     for a MADE item and wrote the warning in its own header. It was missed for
--     a SET, which is what he actually sells.
--
--  4. INWARD FREIGHT VANISHED OUT OF PROFIT.
--     Not in cost, not in expenses, in a field no screen showed. 310 kg of
--     steel at 52,700 plus 3,340 to bring it here cost 56,040, and Skwik
--     thought 52,700.
--
--  5. A CREDIT NOTE WAS COSTED AT TODAY'S RATE.
--     Buy at 100, sell, buy again at 130, customer brings it back: the return
--     credited 130 against the 100 the sale charged. Thirty rupees a unit of
--     profit out of nowhere.
--
--  6. REOPENING AN OLD BILL RESTATED ITS MONTH.
--     Pressing Save on a March bill in September rewrote every line's cost at
--     September's price. Historical margins were not stable.
--
--  SAFE TO RUN TWICE. The mends only ever touch a row that still carries the
--  fault, so a second run finds nothing to do.
-- ===========================================================================


-- ---------------------------------------------------------------------------
--  1. THE BILLS THE IMPORT ALREADY WROTE
-- ---------------------------------------------------------------------------
--  Every line where the amount and the taxable value differ. Nothing the screen
--  has ever written can be in here: computeBill sets both from the same figure.

do $mend$
declare n int;
begin
  update voucher_lines set amount = taxable
   where round(coalesce(amount, 0), 2) <> round(coalesce(taxable, 0), 2);
  get diagnostics n = row_count;
  raise notice 'bills: % line(s) had the tax inside the amount and were put right', n;
end
$mend$;

--  And the bills whose taxable value left out the charge riding on them. The
--  signature is exact: the bill's taxable value equals what its lines come to,
--  and there is a charge on it that is therefore missing from it.
do $mend2$
declare n int;
begin
  with mine as (
    select v.id, v.taxable, v.extra_amount,
           coalesce((select sum(l.taxable) from voucher_lines l
                      where l.voucher_id = v.id), 0) as lines_come_to
      from vouchers v
     where coalesce(v.extra_amount, 0) > 0
  )
  update vouchers v
     set taxable = round(m.lines_come_to + m.extra_amount, 2)
    from mine m
   where v.id = m.id
     and round(m.taxable, 2) = round(m.lines_come_to, 2)
     and round(m.taxable, 2) <> round(m.lines_come_to + m.extra_amount, 2);
  get diagnostics n = row_count;
  raise notice 'bills: % bill(s) did not count the freight in their taxable value', n;
end
$mend2$;


-- ---------------------------------------------------------------------------
--  2. WHAT A PURCHASE TEACHES THE ITEM MASTER
-- ---------------------------------------------------------------------------


CREATE OR REPLACE FUNCTION public.purchase_unit_cost(p_org uuid, ln jsonb)
 RETURNS numeric
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $puc$
declare
  v_qty   numeric := coalesce((ln->>'qty')::numeric, 0);
  v_base  numeric := coalesce((ln->>'taxable')::numeric, 0);
  v_tax   numeric := coalesce((ln->>'cgst')::numeric, 0)
                   + coalesce((ln->>'sgst')::numeric, 0)
                   + coalesce((ln->>'igst')::numeric, 0);
  v_claim boolean;
begin
  -- can this shop claim the tax back?
  select coalesce(is_gst_registered, false) and not coalesce(is_composition, false)
    into v_claim from orgs where id = p_org;

  if not coalesce(v_claim, false) then
    v_base := v_base + v_tax;
  end if;

  -- PER STOCK UNIT, NOT PER BILLED UNIT.
  --
  -- This divided by the BILLED quantity, and the answer is written into the
  -- item master, which the balance sheet then multiplies against the quantity
  -- on the SHELF. Buy 2 Doz for 1,200 and the master learnt 600 a dozen while
  -- 24 pieces went on the shelf: 24 x 600 = 14,400 of goods that cost 1,200,
  -- and stock, assets, capital and net worth all twelve times over. A shop that
  -- keeps bundles, bags and loose pieces lives in this exact case.
  --
  -- `per` is how many stock units one billed unit is. One for everything that
  -- has ever been billed in a single unit, so this changes nothing for a shop
  -- that keeps one unit an item.
  v_qty := v_qty * greatest(coalesce((ln->>'per')::numeric, 1), 0.000001);
  if v_qty = 0 then return coalesce((ln->>'rate')::numeric, 0); end if;
  return round(v_base / v_qty, 2);
end $puc$;



-- ---------------------------------------------------------------------------
--  3. WRITING A BILL: THE COST OF A SET, A RETURN AND A BILL WITH FREIGHT
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.save_voucher(p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $sv$
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
  v_move   numeric;   -- the billed quantity in STOCK units
  v_kit    numeric;   -- what the parts of a set come to
  v_ref    uuid    := nullif(p->>'ref_voucher_id','')::uuid;
  v_extra  numeric := coalesce((p->>'extra_amount')::numeric, 0);
  v_goods  numeric := 0;
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

  -- NUMBERS AND DATES MUST MOVE THE SAME WAY.
  --
  -- The number Skwik is about to hand out is the next in the series, so a
  -- date earlier than the bill below it would leave the book with numbers
  -- running backwards against dates -- the first thing anybody checking a
  -- bill book looks for. bill_date_window() is what the screen offers him;
  -- this is the same rule, where an old copy of the app cannot get past it.
  --
  -- Only when SKWIK is choosing the number. A voucher that arrives carrying
  -- its own -- which is what an import is -- brought its date with it, and
  -- the two already agree.
  if v_given is null then
    perform assert_date_in_window(v_type, v_date, null);
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
        id, org_id, import_run, vtype, voucher_no, vdate, party_id, printed_name, is_cash,
        supplier_invoice_no, supplier_invoice_date, place_of_supply_code, tax_mode,
        taxable, cgst, sgst, igst, extra_amount, extra_note, round_off, total, notes, discount,
        ref_voucher_id, ref_invoice_no, ref_invoice_date, extra_gst_rate, godown_id,
        nil_rated, exempt_amt, non_gst)
      values (
        v_counts, v_eff, coalesce((p->>'reverse_charge')::boolean, false),
        v_id, v_org, nullif(p->>'import_run','')::uuid, v_type, v_no, v_date,
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

  -- what the goods on this bill come to, so a charge riding on it can be
  -- shared across them in proportion
  select coalesce(sum(coalesce((e->>'taxable')::numeric, 0)), 0) into v_goods
    from jsonb_array_elements(coalesce(p->'lines','[]'::jsonb)) e;

  for ln in select * from jsonb_array_elements(coalesce(p->'lines','[]'::jsonb)) loop
    i := i + 1;

    -- what this line cost the shop, decided now and never again
    -- WHAT THIS LINE COST THE SHOP, decided now and never again.
    v_cost := 0;
    if nullif(ln->>'item_id','') is not null then
      if v_type = 'purchase' then
        -- A shop that cannot claim the tax back has paid it, so it is part
        -- of what the goods cost. purchase_unit_cost() knows which kind of
        -- shop this is.
        --
        -- AND FREIGHT IN IS PART OF WHAT THE GOODS COST TOO.
        -- Section 15(2)(c) says so, and so does common sense: 310 kg of steel
        -- that cost 52,700 plus 3,340 to bring here cost 56,040. Inward freight
        -- went into the bill's own total and reached the item's cost nowhere at
        -- all, so it vanished out of profit entirely -- not in cost, not in
        -- expenses. It is shared across the lines in proportion to what each is
        -- worth, which is the same way the bill's discount is shared.
        v_cost := purchase_unit_cost(v_org,
          case when v_extra > 0 and v_goods > 0
            then ln || jsonb_build_object('taxable',
                   coalesce((ln->>'taxable')::numeric, 0)
                   + round(v_extra * coalesce((ln->>'taxable')::numeric, 0) / v_goods, 2))
            else ln end);
      elsif v_type = 'sale_return' and v_ref is not null then
        -- A RETURN COSTS WHAT THE BILL COST, not what the goods cost today.
        --
        -- This read the item master, which is the LAST purchase price. Buy at
        -- 100, sell, buy again at 130, then the customer brings it back: the
        -- return credited 130 against the 100 the sale had charged, and thirty
        -- rupees of profit a unit appeared out of nowhere with no entry behind
        -- it. The bill it is a note against knows what it cost.
        select vl.cost into v_cost
          from voucher_lines vl
         where vl.voucher_id = v_ref and vl.org_id = v_org
           and vl.item_id = (ln->>'item_id')::uuid
           and coalesce(vl.cost, 0) > 0
         order by vl.line_no limit 1;
        if coalesce(v_cost, 0) = 0 then
          select coalesce(nullif(purchase_price, 0), 0) into v_cost
            from items where id = (ln->>'item_id')::uuid;
        end if;
      else
        select coalesce(nullif(purchase_price, 0), 0) into v_cost
          from items where id = (ln->>'item_id')::uuid;
      end if;

      -- A SET HAS NO COST OF ITS OWN. ITS PARTS DO.
      --
      -- He makes a drum body and a lid and sells one drum with a lid. A set is
      -- never bought, so its own purchase price is nought -- and the shelf gives
      -- up the PARTS when one is sold. So the parts' value came off the balance
      -- sheet while the sale showed the whole of its price as profit. 1.9.48 saw
      -- this coming for a MADE item and said so in its own header; it was missed
      -- for a set.
      if coalesce(v_cost, 0) = 0 and v_type <> 'purchase' then
        select sum(ip.qty * coalesce(nullif(ch.purchase_price, 0), 0)) into v_kit
          from item_parts ip join items ch on ch.id = ip.child_id and ch.org_id = v_org
         where ip.parent_id = (ln->>'item_id')::uuid and ip.org_id = v_org;
        if coalesce(v_kit, 0) > 0 then v_cost := round(v_kit, 2); end if;
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

      -- the billed quantity, in the unit the shelf is counted in
      v_move := coalesce((ln->>'qty')::numeric, 0)
              * greatest(coalesce((ln->>'per')::numeric, 1), 0.000001);

      -- a purchase teaches the item master what it costs now
      if v_type = 'purchase' and coalesce(v_cost, 0) > 0 then
        update items set purchase_price = v_cost
         where id = (ln->>'item_id')::uuid and org_id = v_org;
      end if;

      -- A SET IS SOLD AS ONE THING AND COMES OFF THE SHELF AS SEVERAL.
      --
      -- He makes a drum body and a lid and sells one drum with a lid; a
      -- bucket body, a handle and a lid go out as one bucket. The customer
      -- buys one thing, the bill says one thing, and the shelf gives up the
      -- parts — because the parts are what he counts and what he has to make
      -- more of.
      --
      -- So a line whose item is a SET moves its parts instead of itself, and
      -- the set never holds stock of its own. Everything else — an ordinary
      -- item, and a MADE item, which does hold its own stock — falls through
      -- to the movement below exactly as before.
      if exists (select 1 from items
                  where id = (ln->>'item_id')::uuid and org_id = v_org
                    and build = 'kit')
         and exists (select 1 from item_parts
                      where parent_id = (ln->>'item_id')::uuid and org_id = v_org) then

        insert into stock_moves (org_id, item_id, mdate, qty_in, qty_out, reason,
                                 ref_voucher_id, godown_id, batch, expiry)
        select
          v_org, ip.child_id, v_date,
          case when v_type in ('purchase','sale_return')
            then v_move * ip.qty else 0 end,
          case when v_type = 'purchase_return'
                 or (v_type in ('sale','estimate') and v_counts)
            then v_move * ip.qty else 0 end,
          v_type, v_id,
          coalesce(nullif(ln->>'godown_id','')::uuid, v_godown),
          nullif(ln->>'batch',''), nullif(ln->>'expiry','')::date
        from item_parts ip
        where ip.parent_id = (ln->>'item_id')::uuid and ip.org_id = v_org;

      else

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
    end if;
  end loop;

  perform post_voucher_cash(v_id, p);

  return jsonb_build_object('id', v_id, 'voucher_no', v_no, 'already', false);
end $sv$;



-- ---------------------------------------------------------------------------
--  4. CHANGING A BILL KEEPS THE COST THE BILL ALREADY HAD
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.update_voucher(p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $uv$
declare
  v_counts boolean;
  v_org   uuid := my_org_id();
  v_id    uuid := nullif(p->>'id','')::uuid;
  v_type  text;
  v_no    text;
  v_was   date;
  v_cancelled timestamptz;
  v_date  date;
  v_party uuid := nullif(p->>'party_id','')::uuid;
  ln      jsonb;
  i       int := 0;
  v_lock  date;
  v_godown uuid;
  v_cost  numeric;
  v_move   numeric;   -- the billed quantity in STOCK units
  v_kit    numeric;   -- what the parts of a set come to
  v_extra  numeric := coalesce((p->>'extra_amount')::numeric, 0);
  v_goods  numeric := 0;
  v_oldcost jsonb  := '{}'::jsonb;   -- what this bill already said it cost
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

  select vtype, voucher_no, vdate, cancelled_at into v_type, v_no, v_was, v_cancelled
    from vouchers where id = v_id and org_id = v_org;
  if not found then
    raise exception 'That bill is not in your books any more';
  end if;

  -- A CANCELLED BILL CANNOT BE WRITTEN AGAIN.
  --
  -- A trigger on the vouchers row already refuses an edit after a cancel, and
  -- it is not enough: it compares the row against itself, so a save that
  -- leaves the TOP of the bill exactly as it was slips past it -- pressing
  -- Save with nothing changed, or changing only a batch, a note or a store on
  -- a line. Everything past that point in this function then runs anyway: the
  -- lines are rewritten and THE STOCK GOES OUT AGAIN, on a bill that no
  -- report will ever show. Goods quietly leave the shelf and nothing anywhere
  -- says why.
  --
  -- So it is refused here, at the top, on the fact of the cancellation rather
  -- than on whether anything happens to differ.
  if v_cancelled is not null then
    raise exception 'Bill % was cancelled on %. Write a new one instead of changing it.',
      coalesce(v_no, ''), to_char(v_cancelled, 'DD Mon YYYY');
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

  -- AND A BILL KEEPS ITS NUMBER WHEN IT IS CHANGED, so moving its date has to
  -- leave it between the bill numbered below it and the one numbered above.
  -- Same rule as a new bill, fenced on both sides instead of one.
  if v_date is distinct from v_was then
    perform assert_date_in_window(v_type, v_date, v_id);
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

  -- Remembered BEFORE the lines go, because that is where it is written.
  select coalesce(jsonb_object_agg(z.item_id::text, z.cost), '{}'::jsonb) into v_oldcost
    from (select item_id, max(cost) cost from voucher_lines
           where voucher_id = v_id and org_id = v_org
             and item_id is not null and coalesce(cost, 0) > 0
           group by item_id) z;

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

  select coalesce(sum(coalesce((e->>'taxable')::numeric, 0)), 0) into v_goods
    from jsonb_array_elements(coalesce(p->'lines','[]'::jsonb)) e;

  for ln in select * from jsonb_array_elements(coalesce(p->'lines','[]'::jsonb)) loop
    i := i + 1;

    -- WHAT THIS LINE COST THE SHOP.
    --
    -- A BILL FROM MARCH REOPENED IN SEPTEMBER KEEPS MARCH'S COST. This read the
    -- item master every time, so pressing Save on an old bill with nothing
    -- changed rewrote every line's cost at today's purchase price and silently
    -- restated that month's profit. What the bill already said it cost is the
    -- answer; the master is only for a line that was not on it before.
    v_cost := coalesce((v_oldcost->>(ln->>'item_id'))::numeric, 0);
    if coalesce(v_cost, 0) = 0 and nullif(ln->>'item_id','') is not null then
      if v_type = 'purchase' then
        -- A shop that cannot claim the tax back has paid it, so it is part
        -- of what the goods cost. purchase_unit_cost() knows which kind of
        -- shop this is.
        --
        -- AND FREIGHT IN IS PART OF WHAT THE GOODS COST TOO.
        -- Section 15(2)(c) says so, and so does common sense: 310 kg of steel
        -- that cost 52,700 plus 3,340 to bring here cost 56,040. Inward freight
        -- went into the bill's own total and reached the item's cost nowhere at
        -- all, so it vanished out of profit entirely -- not in cost, not in
        -- expenses. It is shared across the lines in proportion to what each is
        -- worth, which is the same way the bill's discount is shared.
        v_cost := purchase_unit_cost(v_org,
          case when v_extra > 0 and v_goods > 0
            then ln || jsonb_build_object('taxable',
                   coalesce((ln->>'taxable')::numeric, 0)
                   + round(v_extra * coalesce((ln->>'taxable')::numeric, 0) / v_goods, 2))
            else ln end);
      else
        select coalesce(nullif(purchase_price, 0), 0) into v_cost
          from items where id = (ln->>'item_id')::uuid;
      end if;

      -- A SET HAS NO COST OF ITS OWN. ITS PARTS DO.
      --
      -- He makes a drum body and a lid and sells one drum with a lid. A set is
      -- never bought, so its own purchase price is nought -- and the shelf gives
      -- up the PARTS when one is sold. So the parts' value came off the balance
      -- sheet while the sale showed the whole of its price as profit. 1.9.48 saw
      -- this coming for a MADE item and said so in its own header; it was missed
      -- for a set.
      if coalesce(v_cost, 0) = 0 and v_type <> 'purchase' then
        select sum(ip.qty * coalesce(nullif(ch.purchase_price, 0), 0)) into v_kit
          from item_parts ip join items ch on ch.id = ip.child_id and ch.org_id = v_org
         where ip.parent_id = (ln->>'item_id')::uuid and ip.org_id = v_org;
        if coalesce(v_kit, 0) > 0 then v_cost := round(v_kit, 2); end if;
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

      -- the billed quantity, in the unit the shelf is counted in
      v_move := coalesce((ln->>'qty')::numeric, 0)
              * greatest(coalesce((ln->>'per')::numeric, 1), 0.000001);

      if v_type = 'purchase' and coalesce(v_cost, 0) > 0 then
        update items set purchase_price = v_cost
         where id = (ln->>'item_id')::uuid and org_id = v_org;
      end if;

      -- A SET IS SOLD AS ONE THING AND COMES OFF THE SHELF AS SEVERAL.
      --
      -- He makes a drum body and a lid and sells one drum with a lid; a
      -- bucket body, a handle and a lid go out as one bucket. The customer
      -- buys one thing, the bill says one thing, and the shelf gives up the
      -- parts — because the parts are what he counts and what he has to make
      -- more of.
      --
      -- So a line whose item is a SET moves its parts instead of itself, and
      -- the set never holds stock of its own. Everything else — an ordinary
      -- item, and a MADE item, which does hold its own stock — falls through
      -- to the movement below exactly as before.
      if exists (select 1 from items
                  where id = (ln->>'item_id')::uuid and org_id = v_org
                    and build = 'kit')
         and exists (select 1 from item_parts
                      where parent_id = (ln->>'item_id')::uuid and org_id = v_org) then

        insert into stock_moves (org_id, item_id, mdate, qty_in, qty_out, reason,
                                 ref_voucher_id, godown_id, batch, expiry)
        select
          v_org, ip.child_id, v_date,
          case when v_type in ('purchase','sale_return')
            then v_move * ip.qty else 0 end,
          case when v_type = 'purchase_return'
                 or (v_type in ('sale','estimate') and v_counts)
            then v_move * ip.qty else 0 end,
          v_type, v_id,
          coalesce(nullif(ln->>'godown_id','')::uuid, v_godown),
          nullif(ln->>'batch',''), nullif(ln->>'expiry','')::date
        from item_parts ip
        where ip.parent_id = (ln->>'item_id')::uuid and ip.org_id = v_org;

      else

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
    end if;
  end loop;

  perform post_voucher_cash(v_id, p);

  return jsonb_build_object('id', v_id, 'voucher_no', v_no);
end $uv$;



-- ---------------------------------------------------------------------------
--  5. THE PROFIT REPORT
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.profit_and_loss(p_from date, p_to date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $pnl2$
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

  -- TWO DOZEN OFF THE SHELF IS TWENTY-FOUR PIECES, AND COSTS TWENTY-FOUR.
  -- `cost` is per STOCK unit, because that is what a purchase teaches the item
  -- master. `qty` is what was BILLED. Multiplying one by the other with nothing
  -- between them made a dozen cost the same as a single piece -- so the profit
  -- on a bill came out right or twelve times wrong depending only on which unit
  -- the counter happened to bill in.
  select coalesce(sum(vl.qty * greatest(coalesce(vl.per, 1), 0.000001) * vl.cost), 0) into v_cost
    from voucher_lines vl join vouchers v on v.id = vl.voucher_id
   where v.org_id = v_org and v.cancelled_at is null
     and v.vtype in ('sale','estimate') and coalesce(v.counts_as_sale, true)
     and v.vdate between p_from and p_to;

  select coalesce(sum(vl.qty * greatest(coalesce(vl.per, 1), 0.000001) * vl.cost), 0) into v_costret
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
end $pnl2$;



-- ---------------------------------------------------------------------------
--  6. THE BALANCE SHEET
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.balance_sheet(p_on date DEFAULT today_ist())
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $bs2$
declare
  v_noprice    int := 0;
  v_nopriceqty numeric := 0;
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
  -- WHAT IT COST, NOT WHAT IT WILL FETCH.
  --
  -- This fell back to the SELLING price for an item with no cost on file, so
  -- unrealised profit was booked straight into assets and capital -- and the
  -- profit report has no such fallback, so the same item was worth its retail
  -- price on the balance sheet and cost nothing at all in the P&L. The two
  -- statements could not be made to agree, and the shop looked richer than it is.
  --
  -- An item with no cost is worth nothing here now, which is the honest answer,
  -- and how much of it there is comes back alongside so the screen can say what
  -- the figure is leaving out instead of it quietly being short.
  select coalesce(sum(
           greatest(coalesce(i.opening_stock, 0) + coalesce(m.moved, 0), 0)
           * coalesce(nullif(i.purchase_price, 0), 0)), 0)
    into v_stock
    from items i
    left join (
      select sm.item_id, sum(coalesce(sm.qty_in, 0) - coalesce(sm.qty_out, 0)) as moved
        from stock_moves sm
       where sm.org_id = v_org and sm.mdate <= p_on
       group by sm.item_id
    ) m on m.item_id = i.id
   where i.org_id = v_org and i.is_active;

  -- and how much is on the shelf with no cost against it
  select count(*), coalesce(sum(z.qty), 0) into v_noprice, v_nopriceqty from (
    select greatest(coalesce(i.opening_stock, 0) + coalesce(m.moved, 0), 0) qty
      from items i
      left join (
        select sm.item_id, sum(coalesce(sm.qty_in, 0) - coalesce(sm.qty_out, 0)) as moved
          from stock_moves sm
         where sm.org_id = v_org and sm.mdate <= p_on
         group by sm.item_id
      ) m on m.item_id = i.id
     where i.org_id = v_org and i.is_active
       and coalesce(i.purchase_price, 0) = 0) z
   where z.qty > 0;

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
    -- what the figure above is leaving out, so the screen can say so
    'stock_unpriced',     v_noprice,
    'stock_unpriced_qty', round(v_nopriceqty, 3),
    'gst_payable', round(greatest(v_gst, 0), 2),
    'gst_credit',  round(greatest(-v_gst, 0), 2),
    'owns',        round(v_owns, 2),
    'loans',       round(v_loans, 2),
    'standing',    v_more,
    'assets',      round(v_assets, 2),
    'liabilities', round(v_liab, 2),
    'capital',     round(v_assets - v_liab, 2),
    'net_worth',   round(v_assets - v_liab, 2));
end $bs2$;


-- ---------------------------------------------------------------------------
--  7. THE NUMBER ON THE SCREEN IS THE NUMBER THAT GETS PRINTED
-- ---------------------------------------------------------------------------
--  Reported: "In top Bar we see new Bill No 26-27/1, but we actually print
--  other number."
--
--  The bar was guessing. It read `orgs.next_invoice_no` out of the copy of the
--  firm the app loaded when it started, and nothing reloads that after a bill
--  is saved -- so it said 26-27/1 for every bill written all session while the
--  server handed out 1, 2, 3, 4. And even freshly loaded it would still have
--  been wrong sometimes, for three more reasons:
--
--    · it used the phone's idea of today, while the server keys the series off
--      the BILL's date -- so a bill backdated to 31 March got 25-26/n from the
--      server and 26-27/n on the screen
--    · sales and estimates share one uniqueness index while counting on
--      separate counters, and both prefixes are empty by default, so an
--      estimate numbered 5 makes the next sale skip past 5 in silence
--    · an offline bill and an imported bill both advance the real series
--      without touching `next_invoice_no` at all
--
--  So the screen stops guessing and asks. This is next_invoice_no_for's twin
--  with every write taken out: the same financial year, the same prefix, the
--  same "never below what has already been used" rule, and it CONSUMES NOTHING.
--  Ask it as often as you like.

create or replace function public.peek_invoice_no(p_date date default null,
                                                  p_kind text default 'sale')
returns text
language plpgsql
stable
security definer
set search_path to 'public'
as $peek$
declare
  o      orgs%rowtype;
  v_org  uuid := my_org_id();
  v_fy   text;
  v_key  text;
  v_used int;
  v_next int;
  prefix text;
  d      date := coalesce(p_date, today_ist());
begin
  if v_org is null then return null; end if;
  if p_kind not in ('sale', 'estimate') then return null; end if;
  select * into o from orgs where id = v_org;
  if not found then return null; end if;

  v_fy  := fy_label(d);
  v_key := case when o.restart_each_year then v_fy else 'ALL' end;

  prefix := coalesce(case when p_kind = 'sale' then o.invoice_prefix
                          else o.estimate_prefix end, '');
  if o.restart_each_year and o.year_in_prefix then
    prefix := prefix || v_fy || '/';
  end if;

  select coalesce(next_no, 1) into v_next
    from invoice_series
   where org_id = v_org and kind = p_kind and fy = v_key;
  v_next := coalesce(v_next, 1);

  select max(coalesce(trailing_no(voucher_no), 0))
    into v_used
    from vouchers
   where org_id = v_org and vtype = p_kind and voucher_no is not null
     and (prefix = '' or voucher_no like prefix || '%');

  -- AND THE NUMBER THE OTHER SERIES HAS TAKEN.
  --
  -- One unique index covers sales and estimates together while each keeps its
  -- own counter, and both prefixes are empty unless the shop sets one. So an
  -- estimate numbered 5 occupies the string a sale wants, the insert is
  -- refused, and save_voucher walks quietly up the series until it finds a
  -- free one. The screen has to walk the same way or it goes on promising a
  -- number that is already spoken for.
  select greatest(coalesce(v_used, 0),
                  coalesce((select max(coalesce(trailing_no(voucher_no), 0))
                              from vouchers
                             where org_id = v_org and voucher_no is not null
                               and vtype in ('sale', 'estimate')
                               and (prefix = '' or voucher_no like prefix || '%')), 0))
    into v_used;

  return prefix || greatest(v_next, coalesce(v_used, 0) + 1)::text;
end
$peek$;

revoke all on function public.peek_invoice_no(date, text) from public;
grant execute on function public.peek_invoice_no(date, text) to authenticated;
