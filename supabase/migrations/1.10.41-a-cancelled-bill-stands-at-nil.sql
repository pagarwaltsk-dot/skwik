-- ===========================================================================
--  1.10.41   A CANCELLED BILL STANDS AT NIL
--
--  Cancelling a bill was already here and mostly right: the sheet asks twice,
--  the number is kept, the row shows struck through with a "This bill was
--  cancelled" panel, the reports leave it out, GSTR-1 counts it as cancelled,
--  and nothing on it can be changed afterwards. Three things were wrong, and
--  all three were found by reading the code against what it says it does.
--
--  ---------------------------------------------------------------------
--   1. IT KEPT THE MONEY ON THE HEADER
--
--  delete_voucher's own comment has said since 1.9 that "the number stays in
--  the book, and the bill stands at nil". It deleted the bill's lines and left
--  its taxable value, its tax and its total sitting on the header. Tried on a
--  real book:
--
--      before   sale 1   taxable 8,130.00   total 9,536.00   lines 2
--      after    sale 1   taxable 8,130.00   total 9,536.00   lines 0
--
--  Every report in the database asks whether a bill was cancelled before
--  counting it, so no figure on any screen was wrong. But the accountant's CSV
--  export did not, and had no column to say so either -- so a cancelled bill
--  went to his CA carrying its full taxable value and total, looking exactly
--  like a live one. A wrong figure that looks right.
--
--  A cancelled bill now stands at nil, which is what it always said it did,
--  and what Tally shows for a cancelled voucher. Nothing is lost that was not
--  already gone: the lines were deleted in 1.9 and the value could not be
--  reconstructed from the header either way. What survives is what matters --
--  the number, the date, the name, and now the reason.
--
--  ---------------------------------------------------------------------
--   2. A CREDIT NOTE WAS DELETED OUTRIGHT, NUMBER AND ALL
--
--  Only a sale and an estimate were cancelled. A credit note and a debit note
--  were DELETED -- the whole row gone.
--
--  But Skwik issues those numbers itself, off its own counter:
--
--      sale_return      CN-1, CN-2, ...   from orgs.next_credit_no
--      purchase_return  DN-1, DN-2, ...   from orgs.next_debit_no
--
--  and the counter never goes backwards. So deleting CN-7 left a permanent
--  hole in a series the shop issues and, for credit notes, REPORTS -- they go
--  into GSTR-1 under CDNR and CDNUR by their number. The very argument written
--  into the app's own confirmation box, that "GST wants an unbroken run of
--  numbers, and a bill that simply disappears leaves a hole in it", applied to
--  credit notes just as much and was not being followed for them.
--
--  So anything Skwik numbered itself is now cancelled and keeps its number:
--  sale, estimate, credit note, debit note. Only a PURCHASE is still deleted
--  outright, and that is right -- a purchase carries the supplier's number, not
--  one of the shop's, so there is no series of his to keep unbroken.
--
--  ---------------------------------------------------------------------
--   3. AND THE REASON IS ASKED FOR NOW
--
--  The column was there, the sheet printed it, and the app passed null every
--  single time. The reason is stored trimmed, and 'Cancelled' when nothing was
--  said, so a bill always says something about why rather than nothing.
--
--  ---------------------------------------------------------------------
--  Checked first, not assumed: every function and view in the database whose
--  body reads sale_return or purchase_return was listed and read. All eleven
--  that report anything already ask whether the bill was cancelled -- the
--  balance sheet, the profit, GSTR-3B, both party balances, the party ledger,
--  the returns screen's own reader. The three that do not are save_voucher,
--  post_voucher_cash and series_of, none of which report. So leaving a
--  cancelled credit note in the table where a deleted one used to be cannot
--  make any figure move.
-- ===========================================================================


-- ---------------------------------------------------------------------------
--  THE BILLS ALREADY CANCELLED, PUT AT NIL
--
--  A book cancelled a bill under an older build and it is still carrying its
--  money. Only a bill whose lines are already gone is touched, so this cannot
--  reach a live bill even if one were somehow marked.
-- ---------------------------------------------------------------------------
update vouchers v
   set taxable = 0, cgst = 0, sgst = 0, igst = 0,
       extra_amount = 0, discount = 0, round_off = 0, total = 0,
       nil_rated = 0, exempt_amt = 0, non_gst = 0,
       gst_effective = false,
       cancel_reason = coalesce(nullif(btrim(cancel_reason), ''), 'Cancelled')
 where v.cancelled_at is not null
   and not exists (select 1 from voucher_lines l where l.voucher_id = v.id)
   and (v.total <> 0 or v.taxable <> 0 or v.cancel_reason is null);


-- ---------------------------------------------------------------------------
--  AND THE WAY A BILL IS CANCELLED FROM NOW ON
--
--  Everything above the branch is exactly as it was: only the owner, never in
--  a month that is closed, the bill's own receipt removed while a real receipt
--  is merely untied, and the goods put back on the shelf.
-- ---------------------------------------------------------------------------
create or replace function public.delete_voucher(p_id uuid, p_reason text default null)
returns void
language plpgsql
security definer
set search_path to 'public'
as $dv$
declare
  v_org  uuid := my_org_id();
  v_date date;
  v_type text;
  v_lock date;
  v_why  text := coalesce(nullif(btrim(p_reason), ''), 'Cancelled');
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
    raise exception 'Your books are closed up to %. Raise a credit note instead of removing a bill from a filed month.',
      to_char(v_lock, 'DD Mon YYYY');
  end if;

  -- A PAYMENT THE BILL MADE ITSELF GOES; A REAL RECEIPT DOES NOT.
  --
  -- post_voucher_cash() creates the counter payment that came in WITH the
  -- bill, and that one has to go when the bill is re-written or cancelled.
  -- But a payment can also be TIED to a bill afterwards -- the sample run does
  -- exactly this to a real receipt the shopkeeper had already entered -- and
  -- deleting those took the customer's money out of the cash book with no
  -- message. `from_voucher` says which is which: the bill's own payment is
  -- removed, anything else is simply un-tied and left alone.
  update payments set ref_voucher_id = null
   where ref_voucher_id = p_id and org_id = v_org and not coalesce(from_voucher, false);
  delete from payments
   where ref_voucher_id = p_id and org_id = v_org and coalesce(from_voucher, false);
  delete from stock_moves where ref_voucher_id = p_id and org_id = v_org;

  -- ANYTHING SKWIK NUMBERED ITSELF KEEPS ITS NUMBER AND STANDS AT NIL.
  --
  -- A sale and an estimate take their number from invoice_series; a credit
  -- note and a debit note from orgs.next_credit_no and next_debit_no. All four
  -- counters only ever go forward, so a deleted one leaves a hole in a series
  -- the shop issues -- and a credit note's number is reported in GSTR-1.
  if v_type in ('sale', 'estimate', 'sale_return', 'purchase_return') then
    update vouchers
       set cancelled_at   = now(),
           cancel_reason  = v_why,
           gst_effective  = false,
           -- at nil, which is what this has said it does since 1.9
           taxable = 0, cgst = 0, sgst = 0, igst = 0,
           extra_amount = 0, discount = 0, round_off = 0, total = 0,
           nil_rated = 0, exempt_amt = 0, non_gst = 0
     where id = p_id and org_id = v_org;
    delete from voucher_lines where voucher_id = p_id and org_id = v_org;
  else
    -- A PURCHASE CARRIES THE SUPPLIER'S NUMBER, NOT ONE OF HIS.
    -- There is no series of the shop's to keep unbroken, so it simply goes.
    delete from voucher_lines where voucher_id = p_id and org_id = v_org;
    delete from vouchers      where id = p_id and org_id = v_org;
  end if;
end $dv$;

revoke all on function public.delete_voucher(uuid, text) from public;
grant execute on function public.delete_voucher(uuid, text) to authenticated;
