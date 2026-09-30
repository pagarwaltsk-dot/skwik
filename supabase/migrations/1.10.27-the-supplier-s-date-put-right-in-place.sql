-- ===========================================================================
--  1.10.27  THE SUPPLIER'S BILL DATE, PUT RIGHT WITHOUT UNDOING ANYTHING
--
--  His own catch: "when importing, who gives bill date same as date of entry
--  of bill? ... that's why Soni Brothers bill of March was shown on 30 April,
--  on date of entry."
--
--  He was right. The reader never looked at Tally's REFERENCE or
--  REFERENCEDATE, so every imported purchase was stored with the shop's own
--  voucher number as the supplier's bill number and THE DAY IT WAS ENTERED as
--  the day the supplier wrote it. 1.10.26 taught the reader both tags. But
--  the bills already in his books still carry the wrong date, and save_voucher
--  writes a voucher once and never again -- it recognises Tally's GUID and
--  returns 'already', which is exactly the guard that stops a file imported
--  twice from writing everything twice.
--
--  THE FIRST ANSWER WAS TO UNDO THE IMPORT AND RUN IT AGAIN, and it was a bad
--  one. An undo takes out every bill, receipt, payment and transfer of that
--  run -- hundreds of rows, and anything he has done since that touches them
--  -- to correct two columns that no figure in his books depends on. The
--  supplier's bill number and its date are the bill's own identity, not its
--  value: nothing in the trial balance, the stock, the profit or GSTR-3B
--  moves by a paisa when they change.
--
--  So they are patched where they stand. He imports the same DayBook again;
--  every voucher is recognised and skipped as before, and on the way past,
--  the two fields are corrected. Nothing is deleted, nothing is written
--  twice, and a file that carries no reference at all changes nothing.
-- ===========================================================================

create or replace function public.patch_supplier_ref(p jsonb)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $psr$
declare
  v_org uuid := my_org_id();
  v_n   integer := 0;
begin
  if v_org is null then raise exception 'This login is not linked to a firm yet'; end if;
  perform assert_can_write();
  if jsonb_typeof(coalesce(p, 'null'::jsonb)) <> 'array' then
    raise exception 'Nothing to put right';
  end if;

  with want as (
    select (r->>'id')::uuid                     as id,
           nullif(r->>'no', '')                 as no,
           nullif(r->>'date', '')::date         as dt
      from jsonb_array_elements(p) r
     where (r->>'id') is not null
  )
  update vouchers v
     set supplier_invoice_no   = coalesce(w.no, v.supplier_invoice_no),
         supplier_invoice_date = coalesce(w.dt, v.supplier_invoice_date)
    from want w
   where v.id = w.id
     and v.org_id = v_org
     -- A PURCHASE ONLY. A sale has no supplier's bill and never had these
     -- fields filled, and a cancelled voucher is not edited by anything.
     and v.vtype in ('purchase', 'purchase_return')
     and v.cancelled_at is null
     -- and only where it would actually change something, so a second run
     -- over the same file touches no rows at all
     and (coalesce(w.no, v.supplier_invoice_no) is distinct from v.supplier_invoice_no
       or coalesce(w.dt, v.supplier_invoice_date) is distinct from v.supplier_invoice_date);

  get diagnostics v_n = row_count;
  return v_n;
end $psr$;

revoke all on function public.patch_supplier_ref(jsonb) from public;
grant execute on function public.patch_supplier_ref(jsonb) to authenticated;
