-- ===========================================================================
--  SKWIK 1.9.4  —  the Reports screen stops downloading the whole year
--
--  Run this after 1.9.3-security.sql. Safe to run twice. It adds one function
--  and changes no data.
--
--  WHY
--
--  The Reports screen asked the server for every bill and every line in the
--  range and added them up on the phone. For a shop with 12,000 bills that is
--  about 46,000 rows — some 33 MB of JSON over 73 round trips, on a phone, on
--  a mobile pack, EVERY time he opens the screen. Then it parsed all of it and
--  walked it three times on the same thread that draws the screen.
--
--  Every figure on that screen is a SUM or a GROUP BY. Postgres does them in
--  a few milliseconds and sends back about four kilobytes.
-- ===========================================================================

begin;

create or replace function public.report_summary(p_from date, p_to date)
returns jsonb
language plpgsql stable security definer set search_path to 'public' as $$
declare
  v_org uuid := my_org_id();
  v_out jsonb;
begin
  if v_org is null then raise exception 'This login is not linked to a firm yet'; end if;
  if p_from is null then p_from := '2000-04-01'; end if;
  if p_to   is null then p_to   := current_date; end if;

  with v as (
    select id, vtype, vdate, coalesce(taxable,0) taxable, coalesce(cgst,0) cgst,
           coalesce(sgst,0) sgst, coalesce(igst,0) igst, coalesce(total,0) total,
           coalesce(gst_effective, true) gst_effective, party_id
      from vouchers
     where org_id = v_org and cancelled_at is null
       and vdate between p_from and p_to
  ),
  -- one row per kind of document
  heads as (
    select vtype, gst_effective, count(*) n,
           sum(taxable) taxable, sum(cgst) cgst, sum(sgst) sgst,
           sum(igst) igst, sum(total) total
      from v group by vtype, gst_effective
  ),
  sale_ids as (select id, party_id from v where vtype = 'sale'),
  b2b_ids as (
    select s.id from sale_ids s join parties p on p.id = s.party_id
     where coalesce(p.gstin,'') <> ''
  ),
  l as (
    select vl.voucher_id, coalesce(vl.gst_rate,0) gst_rate,
           coalesce(vl.taxable,0) taxable, coalesce(vl.cgst,0) cgst,
           coalesce(vl.sgst,0) sgst, coalesce(vl.igst,0) igst,
           coalesce(vl.qty,0) qty, vl.item_name, vl.unit
      from voucher_lines vl
      join sale_ids s on s.id = vl.voucher_id
     where vl.org_id = v_org
  )
  select jsonb_build_object(
    'from', p_from, 'to', p_to,

    'heads', coalesce((select jsonb_agg(jsonb_build_object(
        'vtype', vtype, 'gst_effective', gst_effective, 'n', n,
        'taxable', taxable, 'cgst', cgst, 'sgst', sgst, 'igst', igst, 'total', total))
      from heads), '[]'::jsonb),

    -- GSTR-1 wants the sale lines split by rate
    'rates', coalesce((select jsonb_agg(x order by x->>'rate') from (
        select jsonb_build_object('rate', gst_rate, 'taxable', sum(taxable),
                 'cgst', sum(cgst), 'sgst', sum(sgst), 'igst', sum(igst)) x
          from l group by gst_rate) q), '[]'::jsonb),

    'b2b_taxable', coalesce((select sum(taxable) from l
        where voucher_id in (select id from b2b_ids)), 0),
    'b2c_taxable', coalesce((select sum(taxable) from l
        where voucher_id not in (select id from b2b_ids)), 0),

    -- the takings line on the chart: the last 31 days that had any
    'days', coalesce((select jsonb_agg(jsonb_build_object('d', d, 'total', t) order by d desc)
        from (select vdate d, sum(total) t from v
               where vtype in ('sale','estimate') group by vdate
               order by vdate desc limit 31) q), '[]'::jsonb),

    -- what actually moved off the shelves
    'items', coalesce((select jsonb_agg(jsonb_build_object(
          'name', item_name, 'qty', qty, 'value', value, 'unit', unit)
          order by value desc)
        from (select item_name, sum(qty) qty, sum(taxable) value, min(unit) unit
                from l group by item_name order by sum(taxable) desc limit 15) q), '[]'::jsonb)
  ) into v_out;

  return v_out;
end $$;

do $$ begin
  if exists (select 1 from pg_roles where rolname='authenticated') then
    execute 'grant execute on function public.report_summary(date,date) to authenticated';
  end if;
end $$;

commit;

-- ===========================================================================
--  EVERY ROW MUST POINT AT SOMETHING IN ITS OWN SHOP
--
--  A bill carries a customer id; a line carries an item id; a stock move
--  carries an item and a godown; a payment carries a customer and a bank
--  account. Nothing checked that any of those belonged to the same shop as the
--  row holding them, so a forged request could file a bill in shop A against
--  a customer id belonging to shop B.
--
--  It leaks nothing — row-level security still stops either shop reading the
--  other's rows — but it leaves a bill whose customer cannot be found, a stock
--  move against an item that is not in the shop, and a ledger that will not
--  add up. This is the foreign key that was never written.
--
--  Legitimate rows always match, so nothing the app does changes.
-- ===========================================================================

begin;

create or replace function public.tg_same_org_refs()
returns trigger language plpgsql as $$
declare bad text;
begin
  if tg_table_name = 'vouchers' then
    if new.party_id is not null and not exists (
         select 1 from parties where id = new.party_id and org_id = new.org_id)
    then bad := 'customer'; end if;
    if bad is null and new.godown_id is not null and not exists (
         select 1 from godowns where id = new.godown_id and org_id = new.org_id)
    then bad := 'godown'; end if;

  elsif tg_table_name = 'voucher_lines' then
    if new.item_id is not null and not exists (
         select 1 from items where id = new.item_id and org_id = new.org_id)
    then bad := 'item'; end if;

  elsif tg_table_name = 'stock_moves' then
    if new.item_id is not null and not exists (
         select 1 from items where id = new.item_id and org_id = new.org_id)
    then bad := 'item'; end if;
    if bad is null and new.godown_id is not null and not exists (
         select 1 from godowns where id = new.godown_id and org_id = new.org_id)
    then bad := 'godown'; end if;

  elsif tg_table_name = 'payments' then
    if new.party_id is not null and not exists (
         select 1 from parties where id = new.party_id and org_id = new.org_id)
    then bad := 'customer'; end if;
    if bad is null and new.account_id is not null and not exists (
         select 1 from bank_accounts where id = new.account_id and org_id = new.org_id)
    then bad := 'bank account'; end if;

  elsif tg_table_name = 'expenses' then
    if new.account_id is not null and not exists (
         select 1 from bank_accounts where id = new.account_id and org_id = new.org_id)
    then bad := 'bank account'; end if;
  end if;

  if bad is not null then
    raise exception 'That % is not in this shop', bad;
  end if;
  return new;
end $$;

do $$
declare t text;
begin
  foreach t in array array['vouchers','voucher_lines','stock_moves','payments','expenses'] loop
    execute format('drop trigger if exists same_org_refs on public.%I', t);
    execute format('create trigger same_org_refs before insert or update on public.%I
                      for each row execute function public.tg_same_org_refs()', t);
  end loop;
end $$;

commit;

-- ===========================================================================
--  THE SHOP IS IN INDIA. THE SERVER THINKS IT IS IN GREENWICH.
--
--  Supabase runs in UTC. India is five and a half hours ahead, so from
--  midnight until half past five every morning the server still believes it is
--  yesterday. Anywhere the database filled in a date by itself, a bill written
--  at one in the morning was dated the day before.
--
--  On an ordinary night that is a bill in the wrong day's takings. On the
--  night of 31 March it is a bill in the wrong FINANCIAL YEAR, under the
--  previous year's invoice series, in a quarter that may already be filed.
--
--  today_ist() is the shop's own date, and it is used everywhere the database
--  has to guess. Where the phone sends a date — which is nearly always — that
--  date still wins, exactly as before.
-- ===========================================================================

begin;

create or replace function public.today_ist()
returns date language sql stable as $$
  select (now() at time zone 'Asia/Kolkata')::date
$$;

do $$
declare f record; def text; newdef text; n int := 0;
begin
  for f in
    select p.oid
      from pg_proc p join pg_namespace nsp on nsp.oid = p.pronamespace
     where nsp.nspname = 'public'
       and p.proname in ('save_voucher','next_invoice_no','next_invoice_no_for',
                         'claim_invoice_no','write_off','transfer_stock',
                         'set_invoice_start','report_summary','profit_and_loss',
                         'balance_sheet','fy_sales_total','delete_voucher',
                         'update_voucher','post_voucher_cash')
       and p.prosrc ~* '\mcurrent_date\M'
  loop
    def := pg_get_functiondef(f.oid);
    -- only the bare word, never part of a longer name, and never today_ist's own
    newdef := regexp_replace(def, '\mcurrent_date\M', 'today_ist()', 'gi');
    if newdef <> def then
      execute newdef;
      n := n + 1;
    end if;
  end loop;
  raise notice 'dates: % function(s) moved off the server clock onto India''s', n;
end $$;

commit;

-- ===========================================================================
--  CLOSING AN ACCOUNT FOR GOOD
--
--  Google Play will not list an app that lets a person make an account and
--  gives him no way to delete it. Skwik had "wipe the books", which is a
--  different thing: it emptied the ledgers and left the login, the phone
--  number, the shop name, the address and the GSTIN exactly where they were.
--
--  This deletes the person. If he is the owner of a shop, the shop and
--  everything in it goes with him — but only once he is the only one left in
--  it, because taking a shop out from under four billers is not a thing one
--  tap should do.
--
--  HE MUST BE TOLD, BEFORE HE TAPS, that section 36 of the CGST Act makes him
--  keep his records for seventy-two months from the due date of the annual
--  return. The app says so and makes him export first. This function only
--  carries out what he then asks for.
-- ===========================================================================

begin;

create or replace function public.delete_my_account(p_confirm text)
returns jsonb
language plpgsql security definer set search_path to 'public', 'auth' as $$
declare
  v_me    uuid := auth.uid();
  v_org   uuid;
  v_owner boolean;
  v_others int;
  v_name  text;
begin
  if v_me is null then raise exception 'Not logged in'; end if;
  if upper(coalesce(p_confirm,'')) <> 'DELETE' then
    raise exception 'Type DELETE to confirm';
  end if;

  select org_id into v_org from profiles where id = v_me;
  v_owner := v_org is not null
         and exists (select 1 from orgs where id = v_org and owner_id = v_me);

  if v_owner then
    select count(*) into v_others from profiles where org_id = v_org and id <> v_me;
    if v_others > 0 then
      raise exception 'There are still % other people in this shop. Remove them under "Who can bill" first.', v_others;
    end if;
    select name into v_name from orgs where id = v_org;

    delete from stock_moves    where org_id = v_org;
    delete from voucher_lines  where org_id = v_org;
    delete from vouchers       where org_id = v_org;
    delete from payments       where org_id = v_org;
    delete from expenses       where org_id = v_org;
    delete from items          where org_id = v_org;
    delete from parties        where org_id = v_org;
    delete from bank_accounts  where org_id = v_org;
    begin delete from godowns       where org_id = v_org; exception when undefined_table then null; end;
    begin delete from invoice_series where org_id = v_org; exception when undefined_table then null; end;
    begin delete from sample_runs   where org_id = v_org; exception when undefined_table then null; end;
    update profiles set org_id = null where id = v_me;
    delete from orgs where id = v_org;
  end if;

  delete from profiles where id = v_me;
  delete from auth.users where id = v_me;

  return jsonb_build_object('deleted', true, 'shop', v_name);
end $$;

do $$ begin
  if exists (select 1 from pg_roles where rolname='authenticated') then
    execute 'grant execute on function public.delete_my_account(text) to authenticated';
  end if;
end $$;

commit;
