-- ===========================================================================
--  A RECEIPT THAT CAME WITH A BILL BELONGS TO THAT BILL.
--
--  post_voucher_cash() writes the counter receipt for every cash bill -- "Cash
--  for SGS/2449" -- and it has never carried an import stamp, because it is
--  written by the database rather than by the importer.
--
--  That was harmless until something asked "which rows did he type himself".
--  Two thousand two hundred and fifty-four imported cash bills each produced a
--  receipt with no stamp on it, and the check against his Tally reported
--  45,22,384.10 of his own cash on a shop that had typed in five thousand.
--  It then took that figure off a 45,874.86 difference and called the result
--  45,68,258.96.
--
--  The rule that fixes it is not a stamp on the receipt. It is that a receipt
--  which came WITH a bill is never his own doing independently of the bill --
--  from_voucher says so, and ref_voucher_id says which bill. So it is his only
--  if the bill is his.
--
--  Read-only. It writes nothing, and no existing row is touched.
-- ===========================================================================

create or replace function public.entries_of_mine(p_on date default null)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $eom$
declare
  v_org   uuid := my_org_id();
  v_cash  numeric := 0;
  v_banks jsonb;
  v_parts jsonb;
begin
  if v_org is null then raise exception 'This login is not linked to a firm yet'; end if;

  /* ---- the till ---- */
  select coalesce(sum(case when p.ptype = 'receipt' then p.amount else -p.amount end), 0)
    into v_cash
    from payments p
   where p.org_id = v_org and p.mode = 'cash'
     and p.import_run is null
     and not exists (select 1 from vouchers v
                      where v.id = p.ref_voucher_id and v.import_run is not null)
     and (p_on is null or p.pdate <= p_on);

  -- EVERY EXPENSE IS HIS OWN. The importer has never written one -- Tally's
  -- expense ledgers are the accountant's, and Skwik keeps none of them -- so
  -- there is no import stamp on the table and none is wanted.
  v_cash := v_cash - coalesce((
      select sum(amount) from expenses
       where org_id = v_org and mode = 'cash'
         and (p_on is null or edate <= p_on)), 0);

  -- money he banked himself went OUT of the till and INTO the account
  v_cash := v_cash - coalesce((
      select sum(case when direction = 'deposit' then amount else -amount end)
        from cash_moves
       where org_id = v_org and import_run is null
         and (p_on is null or mdate <= p_on)), 0);

  /* ---- each bank ---- */
  select coalesce(jsonb_agg(jsonb_build_object('name', b.name, 'amount', round(x.amt, 2))), '[]'::jsonb)
    into v_banks
    from bank_accounts b
    join lateral (
      select coalesce((select sum(case when p.ptype = 'receipt' then p.amount else -p.amount end)
                         from payments p
                        where p.org_id = v_org and p.mode = 'bank' and p.account_id = b.id
                          and p.import_run is null
                          and not exists (select 1 from vouchers v
                                           where v.id = p.ref_voucher_id and v.import_run is not null)
                          and (p_on is null or p.pdate <= p_on)), 0)
           - coalesce((select sum(e.amount) from expenses e
                        where e.org_id = v_org and e.mode = 'bank' and e.account_id = b.id
                          and (p_on is null or e.edate <= p_on)), 0)
           + coalesce((select sum(case when m.direction = 'deposit' then m.amount else -m.amount end)
                         from cash_moves m
                        where m.org_id = v_org and m.import_run is null and m.account_id = b.id
                          and (p_on is null or m.mdate <= p_on)), 0) as amt
    ) x on true
   where b.org_id = v_org and x.amt <> 0;

  /* ---- and each person ---- */
  --
  -- The signs are the ones party_balance_rows uses, so that what comes back
  -- here can be taken straight off a balance from there: what he is owed is
  -- positive.
  select coalesce(jsonb_agg(jsonb_build_object('name', p.name, 'amount', round(y.amt, 2))), '[]'::jsonb)
    into v_parts
    from parties p
    join lateral (
      select coalesce((select sum(case when v.vtype in ('sale','estimate')      then  v.total
                                       when v.vtype = 'purchase'                then -v.total
                                       when v.vtype = 'sale_return'             then -v.total
                                       when v.vtype = 'purchase_return'         then  v.total
                                       else 0 end)
                         from vouchers v
                        where v.org_id = v_org and v.import_run is null
                          and v.party_id = p.id and v.cancelled_at is null
                          and coalesce(v.counts_as_sale, true)
                          and (p_on is null or v.vdate <= p_on)), 0)
           - coalesce((select sum(case when m.ptype = 'receipt' then m.amount else -m.amount end)
                         from payments m
                        where m.org_id = v_org and m.party_id = p.id
                          and m.import_run is null
                          and not exists (select 1 from vouchers v2
                                           where v2.id = m.ref_voucher_id and v2.import_run is not null)
                          and (p_on is null or m.pdate <= p_on)), 0) as amt
    ) y on true
   where p.org_id = v_org and y.amt <> 0;

  return jsonb_build_object(
    'on',      p_on,
    'cash',    round(v_cash, 2),
    'banks',   v_banks,
    'parties', v_parts);
end $eom$;

revoke all on function public.entries_of_mine(date) from public;
grant execute on function public.entries_of_mine(date) to authenticated;
