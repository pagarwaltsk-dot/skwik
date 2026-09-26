-- ===========================================================================
--  1.9.48  MADE OF OTHER THINGS.
--
--  He manufactures the parts and sells the whole: a drum body and a lid go
--  out as one drum with a lid; a bucket body, a handle and a lid go out as
--  one bucket. Until now Skwik had no idea those three things were one
--  thing, so either he billed the parts separately — which is not what the
--  customer bought — or he billed the bucket and his parts never came off
--  the shelf at all.
--
--  There are two quite different jobs hiding under that, and only one of
--  them is what most shops mean.
--
--  A SET is put together at the moment of sale. Billing one bucket takes one
--  body, one handle and one lid off the shelf. The bucket itself never holds
--  stock — there is no pile of buckets anywhere, only the parts and the act
--  of selling. Nothing new has to be entered, ever: he bills the way he
--  always did and the parts follow.
--
--  A MADE ITEM is produced before it is sold. It has its own pile, its own
--  count, and its own cost rolled up from what went into it. That needs a
--  manufacturing entry — an act on a day, consuming parts and producing
--  finished goods — and it is the right answer for a shop that makes a batch
--  on Monday and sells it through the week.
--
--  Both are built here. Both are off until a shop says otherwise, and a shop
--  that never touches either sees nothing change: the branch that explodes a
--  set is only reached by an item explicitly marked as one.
--
--  The two save functions below are the ones from 1.9.45, taken out of that
--  file as they stood and edited by script in three places, so nothing else
--  in three hundred lines of SQL can have drifted.
--
--  SAFE TO RUN TWICE.
-- ===========================================================================


-- ---------------------------------------------------------------------------
--  0. THE SWITCH THAT LETS ANY OF THIS BE SEEN
-- ---------------------------------------------------------------------------
--
--  A hardware shop should never learn that bill of materials exists, so both
--  halves wait behind one switch in Settings, off on every firm that has not
--  asked for it. The column has to exist before the switch can be flipped, so
--  it is added here rather than left to whoever reads this file next.
--
--  Off by default: a shop updating to this version sees exactly what it saw
--  yesterday until it says otherwise.

alter table public.orgs
  add column if not exists making_enabled boolean not null default false;

comment on column public.orgs.making_enabled is
  'Show sets and manufacturing: item build types, the parts editor under Items, and the Make tab under Stock. Off unless the shop asks.';


-- ---------------------------------------------------------------------------
--  1. WHAT AN ITEM IS MADE OF
-- ---------------------------------------------------------------------------

alter table public.items
  add column if not exists build text;

do $c$
begin
  if not exists (select 1 from pg_constraint where conname = 'items_build_known') then
    alter table public.items
      add constraint items_build_known
      check (build is null or build in ('kit', 'made'));
  end if;
end
$c$;

comment on column public.items.build is
  'null = an ordinary item. kit = put together as it is sold, holds no stock of its own. made = produced by a manufacturing entry and holds its own stock.';

create table if not exists public.item_parts (
  id        uuid primary key default gen_random_uuid(),
  org_id    uuid not null references public.orgs(id) on delete cascade,
  parent_id uuid not null references public.items(id) on delete cascade,
  child_id  uuid not null references public.items(id) on delete restrict,
  qty       numeric(14,4) not null,
  created_at timestamptz not null default now()
);

-- HOW MANY OF THE PART GO INTO ONE OF THE WHOLE. Nought would take nothing
-- off the shelf and never be noticed; a minus would put parts back as the
-- set was sold. Neither is a thing a shopkeeper can mean.
do $c$
begin
  if not exists (select 1 from pg_constraint where conname = 'item_parts_qty_sane') then
    alter table public.item_parts add constraint item_parts_qty_sane check (qty > 0);
  end if;
end
$c$;

-- ONE ROW PER PART. Two rows for the same lid is a double count nobody would
-- spot, so the quantity is edited instead of a second row being added.
create unique index if not exists item_parts_once
  on public.item_parts (org_id, parent_id, child_id);
create index if not exists item_parts_by_child
  on public.item_parts (org_id, child_id);

-- A THING CANNOT BE MADE OF ITSELF.
do $c$
begin
  if not exists (select 1 from pg_constraint where conname = 'item_parts_not_itself') then
    alter table public.item_parts
      add constraint item_parts_not_itself check (parent_id <> child_id);
  end if;
end
$c$;

alter table public.item_parts enable row level security;

do $c$
begin
  if not exists (select 1 from pg_policies
                  where tablename = 'item_parts' and policyname = 'item_parts_own_org') then
    create policy item_parts_own_org on public.item_parts
      for all using (org_id = my_org_id()) with check (org_id = my_org_id());
  end if;
end
$c$;

grant select, insert, update, delete on public.item_parts to authenticated;


-- ---------------------------------------------------------------------------
--  2. SELLING A SET
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
  v_move   numeric;   -- the billed quantity in STOCK units
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
  v_cancelled timestamptz;
  v_date  date;
  v_party uuid := nullif(p->>'party_id','')::uuid;
  ln      jsonb;
  i       int := 0;
  v_lock  date;
  v_godown uuid;
  v_cost  numeric;
  v_move   numeric;   -- the billed quantity in STOCK units
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
end $function$;


-- ---------------------------------------------------------------------------
--  3. MAKING SOMETHING
-- ---------------------------------------------------------------------------
--
--  p = { mdate, godown_id, note, qty, item_id, parts: [ { item_id, qty } ] }
--
--  Parts left out are taken from what the item is made of, times the quantity
--  being made — which is the ordinary case and means he types one number. A
--  run that used more than the recipe says, or something extra, sends its own
--  list and that is what is written.
--
--  WHAT IT COSTS IS DECIDED HERE AND NOT GUESSED AT LATER.
--
--  The finished item's cost is what went into it: each part's own purchase
--  price times how many were used, divided by how many came out. That is the
--  figure every profit line in the app leans on, and a made item with no cost
--  shows the whole of its selling price as profit — which is the kind of
--  wrong number a man makes decisions on.
--
--  Valuation is at the part's purchase price, which is what Skwik already
--  uses everywhere else and what his Tally is set to.

create or replace function public.make_goods(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $mk$
declare
  v_org    uuid := my_org_id();
  v_date   date := coalesce(nullif(p->>'mdate','')::date, today_ist());
  v_item   uuid := nullif(p->>'item_id','')::uuid;
  v_qty    numeric := coalesce((p->>'qty')::numeric, 0);
  v_godown uuid;
  v_lock   date;
  v_ref    text := nullif(btrim(coalesce(p->>'ref','')), '');
  v_parts  jsonb;
  v_cost   numeric := 0;
  v_used   int := 0;
  ln       jsonb;
begin
  -- A LOOK-ONLY LOGIN, AND A YEAR THAT HAS RUN OUT, BOTH STOP HERE.
  --
  -- Every function that writes a bill has stood behind this since 1.9; these
  -- three were written later and did not. So a shop whose subscription had
  -- ended could not raise a bill but could still correct its stock, move goods
  -- between godowns and manufacture -- and a staff login marked look-only
  -- could do the same. Both are writes to the books like any other.
  perform assert_can_write();
  if v_org is null then raise exception 'This login is not linked to a firm yet'; end if;
  if v_item is null then raise exception 'Say what is being made'; end if;
  if v_qty <= 0 then raise exception 'Say how many are being made'; end if;

  if not exists (select 1 from items where id = v_item and org_id = v_org) then
    raise exception 'That item is not in this shop';
  end if;

  select books_locked_upto into v_lock from orgs where id = v_org;
  if v_lock is not null and v_date <= v_lock then
    raise exception 'Your books are closed up to %. Make it in a month that is still open.',
      to_char(v_lock, 'DD Mon YYYY');
  end if;

  -- The same fallback the stock count uses, so both read and write the same
  -- pile. See the note in 1.9.43.
  v_godown := coalesce(
    nullif(p->>'godown_id','')::uuid,
    (select id from godowns where org_id = v_org order by is_main desc, name limit 1));

  -- ALREADY MADE IS NOT AN ERROR, for the same reason an import that stopped
  -- halfway may be started again.
  if v_ref is not null and exists (
       select 1 from stock_moves where org_id = v_org and import_ref like v_ref || '%') then
    return jsonb_build_object('made', 0, 'already', true);
  end if;

  -- WHAT WENT IN: his own list, or the recipe times the quantity.
  v_parts := p->'parts';
  if v_parts is null or jsonb_array_length(v_parts) = 0 then
    select coalesce(jsonb_agg(jsonb_build_object(
             'item_id', ip.child_id, 'qty', ip.qty * v_qty)), '[]'::jsonb)
      into v_parts
      from item_parts ip
     where ip.parent_id = v_item and ip.org_id = v_org;
  end if;

  if v_parts is null or jsonb_array_length(v_parts) = 0 then
    raise exception 'Say what this is made of first, on the item';
  end if;

  for ln in select * from jsonb_array_elements(v_parts) loop
    if coalesce((ln->>'qty')::numeric, 0) <= 0 then continue; end if;
    if nullif(ln->>'item_id','') is null then continue; end if;

    insert into stock_moves (org_id, item_id, mdate, qty_in, qty_out, reason,
                             godown_id, import_ref)
    values (v_org, (ln->>'item_id')::uuid, v_date, 0, (ln->>'qty')::numeric,
            'made_from', v_godown,
            case when v_ref is null then null else v_ref || ':in:' || v_used end);

    -- what those parts were worth
    v_cost := v_cost + (ln->>'qty')::numeric
              * coalesce((select purchase_price from items
                           where id = (ln->>'item_id')::uuid and org_id = v_org), 0);
    v_used := v_used + 1;
  end loop;

  if v_used = 0 then raise exception 'Nothing went into it'; end if;

  insert into stock_moves (org_id, item_id, mdate, qty_in, qty_out, reason,
                           godown_id, batch, expiry, import_ref)
  values (v_org, v_item, v_date, v_qty, 0, 'made', v_godown,
          nullif(p->>'batch',''), nullif(p->>'expiry','')::date,
          case when v_ref is null then null else v_ref || ':out' end);

  -- WHAT ONE OF THEM COST TO MAKE.
  update items set purchase_price = round(v_cost / v_qty, 2)
   where id = v_item and org_id = v_org;

  return jsonb_build_object('made', v_qty, 'from', v_used,
                            'cost_each', round(v_cost / v_qty, 2),
                            'cost_total', round(v_cost, 2), 'already', false);
end
$mk$;

revoke all on function public.make_goods(jsonb) from public;
grant execute on function public.make_goods(jsonb) to authenticated;


-- ---------------------------------------------------------------------------
--  4. THE REGISTER ALREADY KNOWS THESE WORDS
-- ---------------------------------------------------------------------------
--  made / made_from join sale, purchase, transfer_in and adjust as reasons a
--  movement can carry. The item register shows whatever it is given, so both
--  appear without anything else having to be told about them.

do $chk$
declare want oid; got oid;
begin
  select proowner into want from pg_proc where oid = 'public.save_voucher(jsonb)'::regprocedure;
  select proowner into got  from pg_proc where oid = 'public.make_goods(jsonb)'::regprocedure;
  if want is not null and got is not null and want <> got then
    raise exception
      'make_goods was created by a different login from save_voucher, so stock_moves will refuse its writes. Run every Skwik migration from the same Supabase SQL editor login.';
  end if;
end
$chk$;
