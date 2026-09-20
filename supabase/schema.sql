-- =====================================================================
--  SKWIK — the whole database, in one file
--
--  Builds a working Skwik database from nothing. Taken straight from a
--  database with every fix and change applied and tested, so this file
--  and the live project cannot drift apart.
--
--  A NEW SUPABASE PROJECT
--    SQL Editor, paste the whole file, Run. Once.
--
--  DO NOT RUN THIS ON THE PROJECT THAT HAS YOUR BILLS IN IT. For that,
--  run the files under supabase/migrations/ in order:
--      1.7-audit-fixes.sql
--      1.8-twelve-changes.sql
--
--  Skwik 1.8.0, 20 September 2026.
-- =====================================================================

set check_function_bodies = false;

--
-- PostgreSQL database dump
--

\restrict OHSwM48rZOySpYYOnQMIgPD4ixNz5JFOvGh4cZTZfY9VtAexK6ZfBHczU1PxH1G

-- Dumped from database version 16.13 (Ubuntu 16.13-0ubuntu0.24.04.1)
-- Dumped by pg_dump version 16.13 (Ubuntu 16.13-0ubuntu0.24.04.1)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--



--
-- Name: balance_sheet(date); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.balance_sheet(p_on date DEFAULT CURRENT_DATE) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
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
      coalesce(sum(case when vtype in ('sale','estimate')
                          and coalesce(counts_as_sale, true) then  (cgst+sgst+igst)
                        when vtype = 'sale_return'           then -(cgst+sgst+igst)
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
end $$;


--
-- Name: claim_invoice_no(uuid, date, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.claim_invoice_no(p_org uuid, p_date date, p_kind text, p_no text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare v_fy text; v_key text; v_n int; v_restart boolean;
begin
  select restart_each_year into v_restart from orgs where id = p_org;
  v_n := trailing_no(p_no);
  if v_n is null then return; end if;
  v_fy  := fy_label(p_date);
  v_key := case when coalesce(v_restart, false) then v_fy else 'ALL' end;

  insert into invoice_series (org_id, kind, fy, next_no)
  values (p_org, p_kind, v_key, v_n + 1)
  on conflict (org_id, kind, fy) do update
    set next_no = greatest(invoice_series.next_no, excluded.next_no);
end $$;


--
-- Name: close_join(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.close_join() RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare v_org uuid := my_org_id();
begin
  if v_org is null then raise exception 'This login is not linked to a firm yet'; end if;
  if my_role() <> 'owner' then raise exception 'Only the owner can do that'; end if;
  update orgs set join_open = false, join_open_until = null where id = v_org;
end $$;


--
-- Name: delete_voucher(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.delete_voucher(p_id uuid, p_reason text DEFAULT NULL::text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_org  uuid := my_org_id();
  v_date date;
  v_type text;
  v_lock date;
begin
  if v_org is null then
    raise exception 'This login is not linked to a firm yet';
  end if;
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

  delete from payments    where ref_voucher_id = p_id and org_id = v_org;
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
end $$;


--
-- Name: fy_label(date); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.fy_label(d date) RETURNS text
    LANGUAGE sql IMMUTABLE
    AS $$
  select case when extract(month from d) >= 4
              then to_char(d, 'YY') || '-' || to_char(d + interval '1 year', 'YY')
              else to_char(d - interval '1 year', 'YY') || '-' || to_char(d, 'YY')
         end
$$;


--
-- Name: fy_sales_total(date); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.fy_sales_total(p_on date DEFAULT CURRENT_DATE) RETURNS numeric
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select coalesce(sum(total), 0)
    from vouchers
   where org_id = my_org_id()
     and cancelled_at is null
     and coalesce(counts_as_sale, true)
     and vtype in ('sale', 'estimate')
     and vdate >= make_date(
           case when extract(month from p_on) >= 4
                then extract(year from p_on)::int
                else extract(year from p_on)::int - 1 end, 4, 1)
     and vdate <= p_on
$$;


--
-- Name: item_moves(uuid, date, date); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.item_moves(p_item uuid, p_from date, p_to date) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_org  uuid := my_org_id();
  v_open numeric;
  v_rows jsonb;
begin
  if v_org is null then raise exception 'This login is not linked to a firm yet'; end if;
  if not exists (select 1 from items where id = p_item and org_id = v_org) then
    raise exception 'That item is not on your list';
  end if;

  select coalesce((select opening_stock from items where id = p_item), 0)
       + coalesce((select sum(coalesce(qty_in,0) - coalesce(qty_out,0))
                     from stock_moves
                    where org_id = v_org and item_id = p_item and mdate < p_from), 0)
    into v_open;

  select coalesce(jsonb_agg(x order by x->>'mdate', x->>'created_at'), '[]'::jsonb)
    into v_rows
    from (
      select jsonb_build_object(
               'id',         m.id,
               'mdate',      m.mdate,
               'reason',     m.reason,
               'qty_in',     coalesce(m.qty_in, 0),
               'qty_out',    coalesce(m.qty_out, 0),
               'voucher_id', m.ref_voucher_id,
               'voucher_no', v.voucher_no,
               'vtype',      v.vtype,
               'party',      coalesce(nullif(v.printed_name, ''), p.name),
               'godown',     g.name,
               'batch',      m.batch,
               'expiry',     m.expiry,
               'rate',       l.rate,
               'created_at', coalesce(v.created_at, m.mdate::timestamptz)
             ) as x
        from stock_moves m
        left join vouchers v on v.id = m.ref_voucher_id
        left join parties  p on p.id = v.party_id
        left join godowns  g on g.id = m.godown_id
        left join lateral (
               select vl.rate
                 from voucher_lines vl
                where vl.voucher_id = m.ref_voucher_id
                  and vl.item_id = m.item_id
                limit 1
             ) l on true
       where m.org_id = v_org
         and m.item_id = p_item
         and m.mdate between p_from and p_to
    ) y;

  return jsonb_build_object('opening', v_open, 'rows', v_rows);
end $$;


--
-- Name: join_org(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.join_org(p_code text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_org  uuid;
  v_name text;
  v_open boolean;
  v_till timestamptz;
begin
  if auth.uid() is null then raise exception 'Not logged in'; end if;

  select id, name, join_open, join_open_until
    into v_org, v_name, v_open, v_till
    from orgs where upper(join_code) = upper(trim(p_code));

  if v_org is null then
    raise exception 'No shop has that code. Check it with the owner.';
  end if;
  if not coalesce(v_open, false) or (v_till is not null and v_till < now()) then
    raise exception 'That code is closed. Ask the owner to open it from Staff, then try again.';
  end if;
  if exists (select 1 from profiles where id = auth.uid() and org_id is not null
                                      and org_id <> v_org) then
    raise exception 'This login already belongs to another shop.';
  end if;

  insert into profiles (id, org_id, role) values (auth.uid(), v_org, 'staff')
    on conflict (id) do update set org_id = v_org;

  -- one phone per opening: the door shuts behind him
  update orgs set join_open = false, join_open_until = null where id = v_org;

  return jsonb_build_object('org_id', v_org, 'name', v_name, 'role', 'staff');
end $$;


--
-- Name: make_join_code(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.make_join_code() RETURNS text
    LANGUAGE sql
    AS $$
  -- gen_random_uuid() is a version-4 uuid, which Postgres draws from the
  -- system's strong random source. Six characters out of it beats random().
  select string_agg(
           substr('ABCDEFGHJKLMNPQRSTUVWXYZ23456789',
                  (('x' || substr(md5(gen_random_uuid()::text || g::text), 1, 8))
                    ::bit(32)::bigint % 32)::int + 1, 1), '')
    from generate_series(1, 6) g
$$;


--
-- Name: money_book(date, date, uuid, boolean, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.money_book(p_from date, p_to date, p_account uuid DEFAULT NULL::uuid, p_cash boolean DEFAULT true, p_limit integer DEFAULT 400) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_org   uuid := my_org_id();
  v_open  numeric := 0;
  v_rows  jsonb;
  v_skip  numeric := 0;
  v_count integer := 0;
  v_lim   integer := greatest(coalesce(p_limit, 400), 50);
begin
  if v_org is null then raise exception 'This login is not linked to a firm yet'; end if;

  -- where it started
  if p_cash then
    select coalesce(opening_cash, 0) into v_open from orgs where id = v_org;
  elsif p_account is null then
    select coalesce(sum(coalesce(opening, 0)), 0) into v_open
      from bank_accounts where org_id = v_org;
  else
    select coalesce(opening, 0) into v_open
      from bank_accounts where id = p_account and org_id = v_org;
  end if;
  v_open := coalesce(v_open, 0);

  -- plus everything that moved before this period
  v_open := v_open
    + coalesce((select sum(case when ptype = 'receipt' then amount else -amount end)
                  from payments
                 where org_id = v_org and pdate < p_from
                   and ((p_cash and mode = 'cash')
                     or (not p_cash and mode = 'bank'
                         and (p_account is null or account_id = p_account)))), 0)
    - coalesce((select sum(amount) from expenses
                 where org_id = v_org and edate < p_from
                   and ((p_cash and mode = 'cash')
                     or (not p_cash and mode = 'bank'
                         and (p_account is null or account_id = p_account)))), 0);

  with moved as (
      select p.id, 'payment' as kind, p.pdate as d,
             coalesce(pa.name, nullif(v.printed_name, ''), 'CASH') as who,
             case when p.ptype = 'receipt' then 'Received' else 'Paid' end as what,
             p.note,
             case when p.ptype = 'receipt' then p.amount else 0 end as amt_in,
             case when p.ptype = 'receipt' then 0 else p.amount end as amt_out,
             p.created_at
        from payments p
        left join parties  pa on pa.id = p.party_id
        left join vouchers v  on v.id  = p.ref_voucher_id
       where p.org_id = v_org and p.pdate between p_from and p_to
         and ((p_cash and p.mode = 'cash')
           or (not p_cash and p.mode = 'bank'
               and (p_account is null or p.account_id = p_account)))

      union all

      select e.id, 'expense', e.edate, e.head, 'Spent', e.note,
             0, e.amount, e.created_at
        from expenses e
       where e.org_id = v_org and e.edate between p_from and p_to
         and ((p_cash and e.mode = 'cash')
           or (not p_cash and e.mode = 'bank'
               and (p_account is null or e.account_id = p_account)))
  ),
  ranked as (
      select moved.*,
             row_number() over (order by d, created_at) as rn,
             count(*)     over ()                        as n
        from moved
  )
  select coalesce(sum(amt_in - amt_out) filter (where rn <= n - v_lim), 0),
         coalesce(jsonb_agg(jsonb_build_object(
             'id', id, 'kind', kind, 'd', d, 'who', who, 'what', what,
             'note', note, 'in', amt_in, 'out', amt_out, 'created_at', created_at)
           order by rn) filter (where rn > n - v_lim), '[]'::jsonb),
         coalesce(max(n), 0)
    into v_skip, v_rows, v_count
    from ranked;

  return jsonb_build_object(
    'opening', round(v_open + coalesce(v_skip, 0), 2),
    'rows',    v_rows,
    'total',   v_count,
    'shown',   least(v_count, v_lim),
    'more',    v_count > v_lim);
end $$;


--
-- Name: my_org_id(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.my_org_id() RETURNS uuid
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select org_id from profiles where id = auth.uid()
$$;


--
-- Name: my_role(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.my_role() RETURNS text
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select case
    when exists (select 1 from orgs o
                  where o.owner_id = auth.uid()
                    and o.id = (select org_id from profiles where id = auth.uid()))
      then 'owner'
    else coalesce((select nullif(role, 'owner') from profiles where id = auth.uid()), 'staff')
  end
$$;


--
-- Name: next_invoice_no(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.next_invoice_no(p_org uuid) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare n int;
begin
  if p_org is null or p_org is distinct from my_org_id() then
    raise exception 'Not your firm';
  end if;
  update orgs set next_invoice_no = next_invoice_no + 1
   where id = p_org
   returning next_invoice_no - 1 into n;
  return n;
end $$;


--
-- Name: next_invoice_no_for(uuid, date); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.next_invoice_no_for(p_org uuid, p_date date) RETURNS text
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select next_invoice_no_for(p_org, p_date, 'sale')
$$;


--
-- Name: next_invoice_no_for(uuid, date, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.next_invoice_no_for(p_org uuid, p_date date, p_kind text DEFAULT 'sale'::text) RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  o      orgs%rowtype;
  v_fy   text;
  v_key  text;
  v_cur  text;
  n      int;
  prefix text;
begin
  if p_org is null or p_org is distinct from my_org_id() then
    raise exception 'Not your firm';
  end if;

  select * into o from orgs where id = p_org for update;

  v_fy  := fy_label(p_date);
  v_key := case when o.restart_each_year then v_fy else 'ALL' end;

  insert into invoice_series (org_id, kind, fy, next_no)
  values (p_org, p_kind, v_key, 1)
  on conflict (org_id, kind, fy) do nothing;

  update invoice_series set next_no = next_no + 1
   where org_id = p_org and kind = p_kind and fy = v_key
   returning next_no - 1 into n;

  -- keep the figure the Settings screen shows in step with the year the
  -- shop is actually in
  v_cur := case when o.restart_each_year then fy_label(current_date) else 'ALL' end;
  if v_key = v_cur then
    if p_kind = 'sale' then
      update orgs set next_invoice_no = n + 1, series_year = v_key where id = p_org;
    else
      update orgs set next_estimate_no = n + 1 where id = p_org;
    end if;
  end if;

  prefix := coalesce(case when p_kind = 'sale' then o.invoice_prefix
                          else o.estimate_prefix end, '');
  if o.restart_each_year and o.year_in_prefix then
    prefix := prefix || v_fy || '/';
  end if;

  return prefix || n::text;
end $$;


--
-- Name: outstanding(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.outstanding() RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare v_org uuid := my_org_id(); v jsonb;
begin
  if v_org is null then raise exception 'This login is not linked to a firm yet'; end if;
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', r.id, 'name', r.name, 'phone', r.phone, 'kind', r.kind,
           'balance', r.amt, 'last_bill', r.last_bill, 'last_paid', r.last_paid)
         order by r.amt desc), '[]'::jsonb)
    into v from party_balance_rows(null) r where r.amt <> 0;
  return v;
end $$;


--
-- Name: party_balance_rows(date); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.party_balance_rows(p_on date DEFAULT NULL::date) RETURNS TABLE(id uuid, name text, kind text, area text, phone text, gstin text, state_name text, amt numeric, last_bill date, last_paid date)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select p.id, p.name, p.kind, p.area, p.phone, p.gstin, p.state_name,
         round(
           case when p.opening_type = 'you_owe' then -coalesce(p.opening_balance, 0)
                else coalesce(p.opening_balance, 0) end
           + coalesce(v.amt, 0)
           - coalesce(m.amt, 0), 2) as amt,
         v.last_bill, m.last_paid
    from parties p
    left join lateral (
      select sum(case when x.vtype in ('sale','estimate')  then  x.total
                      when x.vtype = 'purchase'            then -x.total
                      when x.vtype = 'sale_return'         then -x.total
                      when x.vtype = 'purchase_return'     then  x.total
                      else 0 end) as amt,
             max(x.vdate) filter (where x.vtype in ('sale','estimate')) as last_bill
        from vouchers x
       where x.party_id = p.id
         and x.org_id   = p.org_id
         and x.cancelled_at is null
         and coalesce(x.counts_as_sale, true)
         and (p_on is null or x.vdate <= p_on)
    ) v on true
    left join lateral (
      select sum(case when y.ptype = 'receipt' then y.amount else -y.amount end) as amt,
             max(y.pdate) filter (where y.ptype = 'receipt') as last_paid
        from payments y
       where y.party_id = p.id
         and y.org_id   = p.org_id
         and (p_on is null or y.pdate <= p_on)
    ) m on true
   where p.org_id = my_org_id()
$$;


--
-- Name: party_balances(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.party_balances() RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare v_org uuid := my_org_id(); v jsonb;
begin
  if v_org is null then raise exception 'This login is not linked to a firm yet'; end if;
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', r.id, 'name', r.name, 'kind', r.kind, 'area', r.area,
           'phone', r.phone, 'gstin', r.gstin, 'state_name', r.state_name,
           'balance', r.amt) order by r.name), '[]'::jsonb)
    into v from party_balance_rows(null) r;
  return v;
end $$;


--
-- Name: party_due(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.party_due(p_party uuid) RETURNS numeric
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select coalesce((select amt from party_balance_rows(null) r where r.id = p_party), 0)
$$;


--
-- Name: party_ledger(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.party_ledger(p_party uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_org  uuid := my_org_id();
  v_rows jsonb;
  v_open numeric;
  v_type text;
begin
  select opening_balance, opening_type into v_open, v_type
    from parties where id = p_party and org_id = v_org;
  if not found then raise exception 'Party not found'; end if;

  select coalesce(jsonb_agg(r order by r->>'d', r->>'at'), '[]'::jsonb) into v_rows from (
    select jsonb_build_object(
             'side',  case when vtype in ('sale','estimate','purchase_return') then 'left' else 'right' end,
             'd',     vdate::text,
             'at',    created_at::text,
             'kind',  'voucher',
             'id',    id::text,
             'vtype', vtype,
             'label', case vtype
                        when 'estimate'        then 'Estimate ' || coalesce(voucher_no,'')
                        when 'sale'            then 'Bill No. ' || coalesce(voucher_no,'')
                        when 'purchase'        then 'Purchase ' || coalesce(supplier_invoice_no, voucher_no, '')
                        when 'sale_return'     then 'Credit note ' || coalesce(voucher_no,'')
                        else 'Debit note ' || coalesce(voucher_no,'') end
                      || case when is_cash then ' (Cash)' else '' end,
             'amt',   total) as r
      from vouchers where org_id = v_org and party_id = p_party
         and cancelled_at is null
         and coalesce(counts_as_sale, true)
    union all
    select jsonb_build_object(
             'side',  case when ptype = 'receipt' then 'right' else 'left' end,
             'd',     pdate::text,
             'at',    created_at::text,
             'kind',  'payment',
             'id',    id::text,
             'ptype', ptype,
             'label', case when mode = 'writeoff' then 'Written off'
                           when mode = 'cash'     then 'Cash '
                                || case when ptype = 'receipt' then 'received' else 'paid' end
                           else 'Bank '
                                || case when ptype = 'receipt' then 'received' else 'paid' end
                      end
                      || coalesce(' · ' || nullif(note,''), ''),
             'amt',   amount) as r
      from payments where org_id = v_org and party_id = p_party
  ) x;

  return jsonb_build_object(
    'opening',      v_open,
    'opening_type', v_type,
    'rows',         v_rows);
end $$;


--
-- Name: post_voucher_cash(uuid, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.post_voucher_cash(p_id uuid, p jsonb) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
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
                          ref_voucher_id, account_id)
    values (v.org_id, 'receipt', v.party_id, v.vdate,
            coalesce(nullif(p->>'pay_mode',''), 'cash'), v_paid,
            'Cash for ' || coalesce(v.voucher_no, ''), v.id,
            nullif(p->>'account_id','')::uuid);

  elsif v.vtype = 'sale_return' then
    insert into payments (org_id, ptype, party_id, pdate, mode, amount, note,
                          ref_voucher_id, account_id)
    values (v.org_id, 'payment', v.party_id, v.vdate,
            coalesce(nullif(p->>'pay_mode',''), 'cash'), v_paid,
            'Refund on ' || coalesce(v.voucher_no, ''), v.id,
            nullif(p->>'account_id','')::uuid);

  elsif v.vtype = 'purchase' then
    insert into payments (org_id, ptype, party_id, pdate, mode, amount, note,
                          ref_voucher_id, account_id)
    values (v.org_id, 'payment', v.party_id, v.vdate,
            coalesce(nullif(p->>'pay_mode',''), 'cash'), v_paid,
            'Paid on ' || coalesce(v.voucher_no, ''), v.id,
            nullif(p->>'account_id','')::uuid);

  elsif v.vtype = 'purchase_return' then
    insert into payments (org_id, ptype, party_id, pdate, mode, amount, note,
                          ref_voucher_id, account_id)
    values (v.org_id, 'receipt', v.party_id, v.vdate,
            coalesce(nullif(p->>'pay_mode',''), 'cash'), v_paid,
            'Refund on ' || coalesce(v.voucher_no, ''), v.id,
            nullif(p->>'account_id','')::uuid);
  end if;
end $$;


--
-- Name: profit_and_loss(date, date); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.profit_and_loss(p_from date, p_to date) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_org  uuid := my_org_id();
  v_est  boolean;
  v_sale numeric; v_ret numeric; v_buy numeric; v_buyret numeric;
  v_cost numeric; v_costret numeric; v_exp numeric; v_off numeric;
  v      jsonb;
begin
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
end $$;


--
-- Name: purchase_unit_cost(uuid, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.purchase_unit_cost(p_org uuid, ln jsonb) RETURNS numeric
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
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

  if v_qty = 0 then return coalesce((ln->>'rate')::numeric, 0); end if;
  return round(v_base / v_qty, 2);
end $$;


--
-- Name: remove_staff(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.remove_staff(p_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  if my_role() <> 'owner' then raise exception 'Only the owner can do that'; end if;
  if p_id = auth.uid() then raise exception 'You cannot remove yourself'; end if;
  update profiles set org_id = null, role = 'owner'
   where id = p_id and org_id = my_org_id() and role <> 'owner';
end $$;


--
-- Name: reset_join_code(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.reset_join_code() RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare v_org uuid := my_org_id(); v_code text;
begin
  if v_org is null then raise exception 'This login is not linked to a firm yet'; end if;
  if my_role() <> 'owner' then raise exception 'Only the owner can change the shop code'; end if;
  loop
    v_code := make_join_code();
    exit when not exists (select 1 from orgs where join_code = v_code);
  end loop;
  update orgs set join_code = v_code,
                  join_open = true,
                  join_open_until = now() + interval '1 hour'
   where id = v_org;
  return jsonb_build_object('join_code', v_code,
                            'open_until', (now() + interval '1 hour'));
end $$;


--
-- Name: save_voucher(jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.save_voucher(p jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
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
        ref_voucher_id, ref_invoice_no, ref_invoice_date, extra_gst_rate, godown_id)
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
        coalesce((p->>'extra_gst_rate')::numeric,0), v_godown);
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
      batch, expiry, cost)
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
      coalesce(v_cost, 0));

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
end $$;


--
-- Name: set_invoice_start(integer, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_invoice_start(p_next integer, p_prefix text DEFAULT NULL::text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_org    uuid := my_org_id();
  v_prefix text := coalesce(p_prefix, (select invoice_prefix from orgs where id = v_org), '');
  v_max    int;
  v_key    text;
begin
  if v_org is null then raise exception 'This login is not linked to a firm yet'; end if;
  if my_role() <> 'owner' then raise exception 'Only the owner can change the numbering'; end if;
  if p_next is null or p_next < 1 then raise exception 'The next bill number must be 1 or more'; end if;

  select max(coalesce(trailing_no(voucher_no), 0))
    into v_max
    from vouchers
   where org_id = v_org and vtype = 'sale'
     and cancelled_at is null
     and voucher_no is not null
     and (v_prefix = '' or voucher_no like v_prefix || '%');

  if v_max is not null and p_next <= v_max then
    raise exception 'You have already issued bill number %. The next number must be more than that.', v_max;
  end if;

  update orgs
     set next_invoice_no = p_next,
         invoice_prefix  = coalesce(p_prefix, invoice_prefix),
         series_year     = fy_label(current_date)
   where id = v_org;

  select case when restart_each_year then fy_label(current_date) else 'ALL' end
    into v_key from orgs where id = v_org;

  insert into invoice_series (org_id, kind, fy, next_no)
  values (v_org, 'sale', v_key, p_next)
  on conflict (org_id, kind, fy) do update set next_no = excluded.next_no;

  return jsonb_build_object('next_invoice_no', p_next, 'invoice_prefix', v_prefix);
end $$;


--
-- Name: staff_list(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.staff_list() RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare v jsonb;
begin
  if my_org_id() is null then return '[]'::jsonb; end if;
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', id, 'phone', phone, 'role', role, 'me', id = auth.uid())
           order by role, phone), '[]'::jsonb)
    into v from profiles where org_id = my_org_id();
  return v;
end $$;


--
-- Name: stock_now(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.stock_now() RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare v_org uuid := my_org_id(); v jsonb;
begin
  if v_org is null then raise exception 'This login is not linked to a firm yet'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('item_id', item_id, 'qty', qty)), '[]'::jsonb)
    into v
    from (select i.id as item_id,
                 coalesce(i.opening_stock, 0) + coalesce(s.moved, 0) as qty
            from items i
            left join (select m.item_id,
                              sum(coalesce(m.qty_in,0) - coalesce(m.qty_out,0)) as moved
                         from stock_moves m
                        where m.org_id = v_org
                        group by m.item_id) s on s.item_id = i.id
           where i.org_id = v_org
             and i.is_active) x
   where qty <> 0;
  return v;
end $$;


--
-- Name: suggest_hsn(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.suggest_hsn(p_name text) RETURNS text
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select h.hsn
    from hsn_hints h
   where h.org_id = my_org_id()
     and h.word in (select distinct lower(t)
                      from regexp_split_to_table(coalesce(p_name, ''), '\s+') t
                     where length(t) >= 3)
   order by h.uses desc, h.updated_at desc
   limit 1
$$;


--
-- Name: tg_bank_one_default(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.tg_bank_one_default() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if new.is_default then
    update bank_accounts set is_default = false
     where org_id = new.org_id and id <> new.id and is_default;
  end if;
  return new;
end $$;


--
-- Name: tg_items_history(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.tg_items_history() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $_$
declare
  f text;
  ov text; nv text;
begin
  foreach f in array array['name','hsn','unit','sale_price','purchase_price','gst_rate','search_words'] loop
    execute format('select ($1).%I::text, ($2).%I::text', f, f) into ov, nv using old, new;
    if ov is distinct from nv then
      insert into item_history (org_id, item_id, changed_by, field, old_value, new_value)
      values (new.org_id, new.id, auth.uid(), f, ov, nv);
    end if;
  end loop;
  return new;
end $_$;


--
-- Name: tg_items_hsn_hint(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.tg_items_hsn_hint() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare w text;
begin
  if coalesce(new.hsn, '') = '' then return new; end if;
  for w in
    select distinct lower(t) from regexp_split_to_table(new.name, '\s+') t
     where length(t) >= 3
  loop
    insert into hsn_hints (org_id, word, hsn, uses, updated_at)
    values (new.org_id, w, new.hsn, 1, now())
    on conflict (org_id, word) do update
      set hsn = excluded.hsn, uses = hsn_hints.uses + 1, updated_at = now();
  end loop;
  return new;
end $$;


--
-- Name: tg_orgs_join_code(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.tg_orgs_join_code() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if new.join_code is null then
    loop
      new.join_code := make_join_code();
      exit when not exists (select 1 from orgs where join_code = new.join_code);
    end loop;
  end if;
  return new;
end $$;


--
-- Name: tg_orgs_owner_guard(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.tg_orgs_owner_guard() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  if new.owner_id is distinct from old.owner_id then
    if old.owner_id is null then
      -- an older shop that never had an owner written on it: the first
      -- person in the firm to touch it becomes the owner, once.
      return new;
    end if;
    if old.owner_id <> auth.uid() then
      raise exception 'Only the owner of this firm can hand it over';
    end if;
  end if;
  return new;
end $$;


--
-- Name: tg_orgs_series_shape(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.tg_orgs_series_shape() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if coalesce(new.restart_each_year, false) then
    new.year_in_prefix := true;
  end if;
  return new;
end $$;


--
-- Name: tg_profiles_org_guard(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.tg_profiles_org_guard() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare v_owner uuid;
begin
  if tg_op = 'UPDATE' then
    select owner_id into v_owner from orgs where id = coalesce(old.org_id, new.org_id);

    -- moving between shops: only ever from nothing to something
    if new.org_id is distinct from old.org_id and old.org_id is not null then
      raise exception 'This login already belongs to a shop';
    end if;

    -- the role is the owner's to give, nobody else's
    if new.role is distinct from old.role and coalesce(v_owner, auth.uid()) <> auth.uid() then
      new.role := old.role;
    end if;
  end if;

  if new.role is null then new.role := 'staff'; end if;
  return new;
end $$;


--
-- Name: trailing_no(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.trailing_no(p text) RETURNS integer
    LANGUAGE sql IMMUTABLE
    AS $_$
  select nullif(left((regexp_match(coalesce(p, ''), '([0-9]+)[^0-9]*$'))[1], 9), '')::integer
$_$;


--
-- Name: transfer_stock(jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.transfer_stock(p jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_org  uuid := my_org_id();
  v_from uuid := nullif(p->>'from_godown','')::uuid;
  v_to   uuid := nullif(p->>'to_godown','')::uuid;
  v_date date := coalesce(nullif(p->>'mdate','')::date, current_date);
  ln     jsonb;
  n      int := 0;
begin
  if v_org is null then raise exception 'This login is not linked to a firm yet'; end if;
  if v_from is null or v_to is null then raise exception 'Say which godown to which'; end if;
  if v_from = v_to then raise exception 'Those are the same godown'; end if;

  for ln in select * from jsonb_array_elements(coalesce(p->'lines','[]'::jsonb)) loop
    if coalesce((ln->>'qty')::numeric, 0) <= 0 then continue; end if;

    insert into stock_moves (org_id, item_id, mdate, qty_in, qty_out, reason, godown_id, batch, expiry)
    values (v_org, (ln->>'item_id')::uuid, v_date, 0, (ln->>'qty')::numeric,
            'transfer_out', v_from, nullif(ln->>'batch',''), nullif(ln->>'expiry','')::date);

    insert into stock_moves (org_id, item_id, mdate, qty_in, qty_out, reason, godown_id, batch, expiry)
    values (v_org, (ln->>'item_id')::uuid, v_date, (ln->>'qty')::numeric, 0,
            'transfer_in', v_to, nullif(ln->>'batch',''), nullif(ln->>'expiry','')::date);

    n := n + 1;
  end loop;

  return jsonb_build_object('moved', n);
end $$;


--
-- Name: unbilled_receipts(date, date); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.unbilled_receipts(p_from date, p_to date) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_org uuid := my_org_id();
  v     jsonb;
begin
  if v_org is null then raise exception 'This login is not linked to a firm yet'; end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', m.id, 'pdate', m.pdate, 'amount', m.amount, 'mode', m.mode,
           'note', m.note, 'party_id', m.party_id, 'party', p.name,
           'gstin', p.gstin, 'state_code', p.state_code, 'price_list', p.price_list)
         order by m.pdate, m.created_at), '[]'::jsonb)
    into v
    from payments m
    left join parties p on p.id = m.party_id
   where m.org_id = v_org
     and m.ptype  = 'receipt'
     and m.ref_voucher_id is null
     and m.pdate between p_from and p_to;

  return v;
end $$;


--
-- Name: undo_sample_run(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.undo_sample_run(p_run uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_org  uuid := my_org_id();
  v_ids  uuid[];
  v_pty  uuid[];
  v_pay  uuid[];
  v_n    int := 0;
begin
  if v_org is null then raise exception 'This login is not linked to a firm yet'; end if;
  if my_role() <> 'owner' then raise exception 'Only the owner can do that'; end if;

  select voucher_ids, party_ids, payment_ids into v_ids, v_pty, v_pay
    from sample_runs where id = p_run and org_id = v_org;
  if not found then raise exception 'That run is not in your books'; end if;

  -- the receipts go back to standing on their own
  update payments set ref_voucher_id = null
   where org_id = v_org and id = any(v_pay);

  delete from payments      where org_id = v_org and ref_voucher_id = any(v_ids);
  delete from stock_moves   where org_id = v_org and ref_voucher_id = any(v_ids);
  delete from voucher_lines where org_id = v_org and voucher_id     = any(v_ids);
  delete from vouchers      where org_id = v_org and id             = any(v_ids);
  get diagnostics v_n = row_count;

  -- customers invented for the run, only if nothing else uses them
  delete from parties p
   where p.org_id = v_org and p.id = any(v_pty)
     and not exists (select 1 from vouchers v where v.party_id = p.id)
     and not exists (select 1 from payments  m where m.party_id = p.id);

  delete from sample_runs where id = p_run and org_id = v_org;
  return jsonb_build_object('removed', v_n);
end $$;


--
-- Name: update_voucher(jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_voucher(p jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
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
    total                 = coalesce((p->>'total')::numeric,0),
    notes                 = nullif(p->>'notes','')
  where id = v_id and org_id = v_org;

  delete from voucher_lines where voucher_id = v_id and org_id = v_org;
  delete from stock_moves   where ref_voucher_id = v_id and org_id = v_org;
  delete from payments      where ref_voucher_id = v_id and org_id = v_org;

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
      batch, expiry, cost)
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
      coalesce(v_cost, 0));

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
end $$;


--
-- Name: wipe_org(boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.wipe_org(p_keep_masters boolean DEFAULT true) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_org uuid := my_org_id();
  v_out jsonb;
  n_v int; n_p int; n_e int; n_i int; n_pa int;
begin
  if v_org is null then raise exception 'This login is not linked to a firm yet'; end if;
  if my_role() <> 'owner' then
    raise exception 'Only the owner of this firm can empty it';
  end if;

  select count(*) into n_v  from vouchers where org_id = v_org;
  select count(*) into n_p  from payments where org_id = v_org;
  select count(*) into n_e  from expenses where org_id = v_org;

  delete from sample_runs   where org_id = v_org;
  delete from stock_moves   where org_id = v_org;
  delete from voucher_lines where org_id = v_org;
  delete from payments      where org_id = v_org;
  delete from expenses      where org_id = v_org;
  delete from vouchers      where org_id = v_org;

  if p_keep_masters then
    n_i := 0; n_pa := 0;
    update items set opening_stock = 0 where org_id = v_org;
    update parties set opening_balance = 0, opening_date = null where org_id = v_org;
  else
    select count(*) into n_i  from items   where org_id = v_org;
    select count(*) into n_pa from parties where org_id = v_org;
    delete from hsn_hints where org_id = v_org;
    delete from items   where org_id = v_org;
    delete from parties where org_id = v_org;
  end if;

  -- numbering starts from one again, in every year
  delete from invoice_series where org_id = v_org;
  update orgs
     set next_invoice_no = 1,
         next_estimate_no = 1,
         next_credit_no = 1,
         next_debit_no = 1,
         series_year = null,
         opening_cash = 0,
         opening_cash_on = null,
         books_locked_upto = null
   where id = v_org;

  update bank_accounts set opening = 0, opening_on = null where org_id = v_org;

  v_out := jsonb_build_object(
    'vouchers', n_v, 'payments', n_p, 'expenses', n_e,
    'items', n_i, 'parties', n_pa, 'kept_masters', p_keep_masters);
  return v_out;
end $$;


--
-- Name: write_off(uuid, numeric, date, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.write_off(p_party uuid, p_amount numeric, p_date date DEFAULT CURRENT_DATE, p_note text DEFAULT NULL::text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_org uuid := my_org_id();
  v_amt numeric := round(coalesce(p_amount, 0), 2);
  v_id  uuid;
begin
  if v_org is null then raise exception 'This login is not linked to a firm yet'; end if;
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
end $$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: bank_accounts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.bank_accounts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    name text NOT NULL,
    opening numeric(14,2) DEFAULT 0 NOT NULL,
    opening_on date,
    is_default boolean DEFAULT false NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: expense_heads; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.expense_heads (
    org_id uuid NOT NULL,
    head text NOT NULL,
    used integer DEFAULT 1 NOT NULL
);


--
-- Name: expenses; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.expenses (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    edate date DEFAULT CURRENT_DATE NOT NULL,
    head text NOT NULL,
    amount numeric(14,2) DEFAULT 0 NOT NULL,
    mode text DEFAULT 'cash'::text NOT NULL,
    note text,
    party_id uuid,
    created_at timestamp with time zone DEFAULT now(),
    account_id uuid,
    is_gst_payment boolean DEFAULT false NOT NULL
);


--
-- Name: godowns; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.godowns (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    name text NOT NULL,
    is_main boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: hsn_hints; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.hsn_hints (
    word text NOT NULL,
    hsn text NOT NULL,
    uses integer DEFAULT 1 NOT NULL,
    updated_at timestamp with time zone DEFAULT now(),
    org_id uuid NOT NULL
);


--
-- Name: invoice_series; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.invoice_series (
    org_id uuid NOT NULL,
    kind text NOT NULL,
    fy text NOT NULL,
    next_no integer DEFAULT 1 NOT NULL
);


--
-- Name: item_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.item_history (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    item_id uuid NOT NULL,
    changed_at timestamp with time zone DEFAULT now() NOT NULL,
    changed_by uuid,
    field text NOT NULL,
    old_value text,
    new_value text
);


--
-- Name: items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.items (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    name text NOT NULL,
    search_words text,
    alias text,
    tags text,
    hsn text,
    unit text DEFAULT 'PCS'::text,
    sale_price numeric(14,2) DEFAULT 0,
    price2 numeric(14,2) DEFAULT 0,
    purchase_price numeric(14,2) DEFAULT 0,
    gst_rate numeric(5,2) DEFAULT 0,
    opening_stock numeric(14,3) DEFAULT 0,
    is_active boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now(),
    barcode text,
    variant_of uuid,
    variant text
);


--
-- Name: orgs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.orgs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    gstin text,
    is_gst_registered boolean DEFAULT false NOT NULL,
    address text,
    state_name text,
    state_code text,
    phone text,
    email text,
    invoice_prefix text DEFAULT ''::text,
    next_invoice_no integer DEFAULT 1 NOT NULL,
    mode text DEFAULT 'estimate'::text NOT NULL,
    estimate_prefix text DEFAULT ''::text,
    next_estimate_no integer DEFAULT 1 NOT NULL,
    trial_ends_at timestamp with time zone,
    plan text DEFAULT 'trial'::text,
    price1_name text DEFAULT 'Wholesale'::text,
    price2_name text DEFAULT 'Retail'::text,
    bank_name text,
    bank_ledger text DEFAULT 'Bank Account'::text,
    cash_ledger text DEFAULT 'Cash'::text,
    sales_ledger text DEFAULT 'Sales'::text,
    purchase_ledger text DEFAULT 'Purchase'::text,
    cgst_ledger text DEFAULT 'CGST'::text,
    sgst_ledger text DEFAULT 'SGST'::text,
    igst_ledger text DEFAULT 'IGST'::text,
    round_off_ledger text DEFAULT 'Round Off'::text,
    is_composition boolean DEFAULT false NOT NULL,
    hsn_enabled boolean DEFAULT true NOT NULL,
    turnover_above_5cr boolean DEFAULT false NOT NULL,
    stock_enabled boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    print_width text DEFAULT 'a4'::text NOT NULL,
    show_purchase boolean DEFAULT true NOT NULL,
    show_reports boolean DEFAULT false NOT NULL,
    show_transfer boolean DEFAULT false NOT NULL,
    show_returns boolean DEFAULT false NOT NULL,
    tally_price_level text,
    next_credit_no integer DEFAULT 1 NOT NULL,
    credit_prefix text DEFAULT 'CN-'::text,
    next_debit_no integer DEFAULT 1 NOT NULL,
    debit_prefix text DEFAULT 'DN-'::text,
    owner_id uuid DEFAULT auth.uid(),
    restart_each_year boolean DEFAULT false NOT NULL,
    series_year text,
    year_in_prefix boolean DEFAULT true NOT NULL,
    books_locked_upto date,
    join_code text,
    show_expenses boolean DEFAULT false NOT NULL,
    show_recon boolean DEFAULT false NOT NULL,
    godowns_enabled boolean DEFAULT false NOT NULL,
    default_godown_id uuid,
    batch_enabled boolean DEFAULT false NOT NULL,
    expiry_enabled boolean DEFAULT false NOT NULL,
    variants_enabled boolean DEFAULT false NOT NULL,
    opening_cash numeric(14,2) DEFAULT 0 NOT NULL,
    opening_cash_on date,
    debug_keyboard boolean DEFAULT false NOT NULL,
    join_open boolean DEFAULT false NOT NULL,
    join_open_until timestamp with time zone
);


--
-- Name: parties; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.parties (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    name text NOT NULL,
    kind text DEFAULT 'customer'::text,
    gstin text,
    is_registered boolean DEFAULT false,
    address text,
    state_name text,
    state_code text,
    phone text,
    opening_balance numeric(14,2) DEFAULT 0,
    opening_type text DEFAULT 'owes_you'::text,
    opening_date date,
    price_list smallint DEFAULT 1,
    created_at timestamp with time zone DEFAULT now(),
    area text
);


--
-- Name: payments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    ptype text NOT NULL,
    party_id uuid,
    pdate date DEFAULT CURRENT_DATE NOT NULL,
    mode text DEFAULT 'cash'::text NOT NULL,
    amount numeric(14,2) NOT NULL,
    note text,
    created_at timestamp with time zone DEFAULT now(),
    ref_voucher_id uuid,
    account_id uuid
);


--
-- Name: profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.profiles (
    id uuid NOT NULL,
    org_id uuid,
    phone text,
    role text DEFAULT 'staff'::text,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: sample_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sample_runs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    note text,
    voucher_ids uuid[] DEFAULT '{}'::uuid[] NOT NULL,
    party_ids uuid[] DEFAULT '{}'::uuid[] NOT NULL,
    payment_ids uuid[] DEFAULT '{}'::uuid[] NOT NULL
);


--
-- Name: stock_moves; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.stock_moves (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    item_id uuid,
    mdate date DEFAULT CURRENT_DATE NOT NULL,
    qty_in numeric(14,3) DEFAULT 0,
    qty_out numeric(14,3) DEFAULT 0,
    reason text NOT NULL,
    ref_voucher_id uuid,
    godown_id uuid,
    batch text,
    expiry date
);


--
-- Name: stock_in_hand; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.stock_in_hand WITH (security_invoker='on') AS
 SELECT id AS item_id,
    org_id,
    name,
    unit,
    (opening_stock + COALESCE(( SELECT sum((sm.qty_in - sm.qty_out)) AS sum
           FROM public.stock_moves sm
          WHERE (sm.item_id = i.id)), (0)::numeric)) AS qty
   FROM public.items i
  WHERE is_active;


--
-- Name: stock_in_hand_detail; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.stock_in_hand_detail WITH (security_invoker='on') AS
 SELECT m.org_id,
    m.item_id,
    i.name AS item_name,
    i.unit,
    m.godown_id,
    g.name AS godown_name,
    m.batch,
    m.expiry,
    sum((COALESCE(m.qty_in, (0)::numeric) - COALESCE(m.qty_out, (0)::numeric))) AS qty
   FROM ((public.stock_moves m
     JOIN public.items i ON ((i.id = m.item_id)))
     LEFT JOIN public.godowns g ON ((g.id = m.godown_id)))
  GROUP BY m.org_id, m.item_id, i.name, i.unit, m.godown_id, g.name, m.batch, m.expiry;


--
-- Name: voucher_lines; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.voucher_lines (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    voucher_id uuid NOT NULL,
    org_id uuid NOT NULL,
    item_id uuid,
    item_name text NOT NULL,
    hsn text,
    unit text,
    qty numeric(14,3) DEFAULT 0 NOT NULL,
    rate numeric(14,2) DEFAULT 0 NOT NULL,
    gst_rate numeric(5,2) DEFAULT 0,
    taxable numeric(14,2) DEFAULT 0,
    cgst numeric(14,2) DEFAULT 0,
    sgst numeric(14,2) DEFAULT 0,
    igst numeric(14,2) DEFAULT 0,
    amount numeric(14,2) DEFAULT 0,
    line_no integer DEFAULT 1,
    flag boolean DEFAULT false,
    checked boolean DEFAULT false,
    note text,
    disc numeric(14,2) DEFAULT 0 NOT NULL,
    batch text,
    expiry date,
    cost numeric(14,2) DEFAULT 0 NOT NULL
);


--
-- Name: vouchers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.vouchers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    vtype text NOT NULL,
    voucher_no text,
    vdate date DEFAULT CURRENT_DATE NOT NULL,
    party_id uuid,
    printed_name text,
    is_cash boolean DEFAULT false,
    supplier_invoice_no text,
    supplier_invoice_date date,
    place_of_supply_code text,
    tax_mode text DEFAULT 'none'::text,
    taxable numeric(14,2) DEFAULT 0,
    cgst numeric(14,2) DEFAULT 0,
    sgst numeric(14,2) DEFAULT 0,
    igst numeric(14,2) DEFAULT 0,
    extra_amount numeric(14,2) DEFAULT 0,
    extra_note text,
    round_off numeric(14,2) DEFAULT 0,
    total numeric(14,2) DEFAULT 0,
    notes text,
    created_at timestamp with time zone DEFAULT now(),
    ref_voucher_id uuid,
    ref_invoice_no text,
    ref_invoice_date date,
    extra_gst_rate numeric(5,2) DEFAULT 0 NOT NULL,
    godown_id uuid,
    counts_as_sale boolean,
    cancelled_at timestamp with time zone,
    cancel_reason text,
    gst_effective boolean DEFAULT true NOT NULL,
    reverse_charge boolean DEFAULT false NOT NULL,
    discount numeric(14,2) DEFAULT 0 NOT NULL
);


--
-- Name: bank_accounts bank_accounts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bank_accounts
    ADD CONSTRAINT bank_accounts_pkey PRIMARY KEY (id);


--
-- Name: expense_heads expense_heads_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expense_heads
    ADD CONSTRAINT expense_heads_pkey PRIMARY KEY (org_id, head);


--
-- Name: expenses expenses_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expenses
    ADD CONSTRAINT expenses_pkey PRIMARY KEY (id);


--
-- Name: godowns godowns_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.godowns
    ADD CONSTRAINT godowns_pkey PRIMARY KEY (id);


--
-- Name: hsn_hints hsn_hints_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hsn_hints
    ADD CONSTRAINT hsn_hints_pkey PRIMARY KEY (org_id, word);


--
-- Name: invoice_series invoice_series_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoice_series
    ADD CONSTRAINT invoice_series_pkey PRIMARY KEY (org_id, kind, fy);


--
-- Name: item_history item_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_history
    ADD CONSTRAINT item_history_pkey PRIMARY KEY (id);


--
-- Name: items items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.items
    ADD CONSTRAINT items_pkey PRIMARY KEY (id);


--
-- Name: orgs orgs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.orgs
    ADD CONSTRAINT orgs_pkey PRIMARY KEY (id);


--
-- Name: parties parties_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.parties
    ADD CONSTRAINT parties_pkey PRIMARY KEY (id);


--
-- Name: payments payments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payments
    ADD CONSTRAINT payments_pkey PRIMARY KEY (id);


--
-- Name: profiles profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_pkey PRIMARY KEY (id);


--
-- Name: sample_runs sample_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_runs
    ADD CONSTRAINT sample_runs_pkey PRIMARY KEY (id);


--
-- Name: stock_moves stock_moves_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_moves
    ADD CONSTRAINT stock_moves_pkey PRIMARY KEY (id);


--
-- Name: voucher_lines voucher_lines_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.voucher_lines
    ADD CONSTRAINT voucher_lines_pkey PRIMARY KEY (id);


--
-- Name: vouchers vouchers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vouchers
    ADD CONSTRAINT vouchers_pkey PRIMARY KEY (id);


--
-- Name: idx_bank_accounts_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bank_accounts_org ON public.bank_accounts USING btree (org_id, is_active);


--
-- Name: idx_expenses_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_expenses_org ON public.expenses USING btree (org_id, edate);


--
-- Name: idx_expenses_org_mode_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_expenses_org_mode_date ON public.expenses USING btree (org_id, mode, edate);


--
-- Name: idx_godowns_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_godowns_org ON public.godowns USING btree (org_id);


--
-- Name: idx_item_history; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_item_history ON public.item_history USING btree (item_id, changed_at DESC);


--
-- Name: idx_items_barcode; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_items_barcode ON public.items USING btree (org_id, barcode) WHERE (barcode IS NOT NULL);


--
-- Name: idx_items_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_items_org ON public.items USING btree (org_id);


--
-- Name: idx_items_variant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_items_variant ON public.items USING btree (org_id, variant_of) WHERE (variant_of IS NOT NULL);


--
-- Name: idx_lines_org_item; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_lines_org_item ON public.voucher_lines USING btree (org_id, item_id);


--
-- Name: idx_lines_voucher; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_lines_voucher ON public.voucher_lines USING btree (voucher_id);


--
-- Name: idx_moves_item; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_moves_item ON public.stock_moves USING btree (item_id);


--
-- Name: idx_moves_org_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_moves_org_date ON public.stock_moves USING btree (org_id, mdate);


--
-- Name: idx_moves_org_item_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_moves_org_item_date ON public.stock_moves USING btree (org_id, item_id, mdate);


--
-- Name: idx_parties_area; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_parties_area ON public.parties USING btree (org_id, area) WHERE (area IS NOT NULL);


--
-- Name: idx_parties_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_parties_org ON public.parties USING btree (org_id);


--
-- Name: idx_payments_account; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_payments_account ON public.payments USING btree (org_id, account_id, pdate);


--
-- Name: idx_payments_org_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_payments_org_date ON public.payments USING btree (org_id, pdate);


--
-- Name: idx_payments_org_mode_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_payments_org_mode_date ON public.payments USING btree (org_id, mode, pdate);


--
-- Name: idx_payments_party; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_payments_party ON public.payments USING btree (party_id);


--
-- Name: idx_payments_ref; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_payments_ref ON public.payments USING btree (ref_voucher_id);


--
-- Name: idx_sample_runs_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sample_runs_org ON public.sample_runs USING btree (org_id, created_at DESC);


--
-- Name: idx_stock_moves_batch; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_stock_moves_batch ON public.stock_moves USING btree (org_id, item_id, batch) WHERE (batch IS NOT NULL);


--
-- Name: idx_stock_moves_godown; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_stock_moves_godown ON public.stock_moves USING btree (org_id, godown_id, item_id);


--
-- Name: idx_stock_moves_item_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_stock_moves_item_date ON public.stock_moves USING btree (org_id, item_id, mdate);


--
-- Name: idx_vouchers_counts; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vouchers_counts ON public.vouchers USING btree (org_id, counts_as_sale, vdate) WHERE counts_as_sale;


--
-- Name: idx_vouchers_live; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vouchers_live ON public.vouchers USING btree (org_id, vtype, vdate) WHERE (cancelled_at IS NULL);


--
-- Name: idx_vouchers_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vouchers_org ON public.vouchers USING btree (org_id, vdate DESC);


--
-- Name: idx_vouchers_org_vdate; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vouchers_org_vdate ON public.vouchers USING btree (org_id, vdate) WHERE (cancelled_at IS NULL);


--
-- Name: idx_vouchers_party; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vouchers_party ON public.vouchers USING btree (party_id);


--
-- Name: idx_vouchers_ref; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vouchers_ref ON public.vouchers USING btree (ref_voucher_id);


--
-- Name: uq_orgs_join_code; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_orgs_join_code ON public.orgs USING btree (join_code) WHERE (join_code IS NOT NULL);


--
-- Name: uq_vouchers_no; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_vouchers_no ON public.vouchers USING btree (org_id, voucher_no) WHERE ((voucher_no IS NOT NULL) AND (vtype = ANY (ARRAY['sale'::text, 'estimate'::text])));


--
-- Name: bank_accounts bank_one_default; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER bank_one_default AFTER INSERT OR UPDATE OF is_default ON public.bank_accounts FOR EACH ROW WHEN (new.is_default) EXECUTE FUNCTION public.tg_bank_one_default();


--
-- Name: items items_history; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER items_history AFTER UPDATE ON public.items FOR EACH ROW EXECUTE FUNCTION public.tg_items_history();


--
-- Name: items items_hsn_hint; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER items_hsn_hint AFTER INSERT OR UPDATE OF hsn, name ON public.items FOR EACH ROW EXECUTE FUNCTION public.tg_items_hsn_hint();


--
-- Name: orgs orgs_join_code; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER orgs_join_code BEFORE INSERT ON public.orgs FOR EACH ROW EXECUTE FUNCTION public.tg_orgs_join_code();


--
-- Name: orgs orgs_owner_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER orgs_owner_guard BEFORE UPDATE ON public.orgs FOR EACH ROW EXECUTE FUNCTION public.tg_orgs_owner_guard();


--
-- Name: orgs orgs_series_shape; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER orgs_series_shape BEFORE INSERT OR UPDATE ON public.orgs FOR EACH ROW EXECUTE FUNCTION public.tg_orgs_series_shape();


--
-- Name: profiles profiles_org_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER profiles_org_guard BEFORE INSERT OR UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.tg_profiles_org_guard();


--
-- Name: bank_accounts bank_accounts_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bank_accounts
    ADD CONSTRAINT bank_accounts_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE;


--
-- Name: expense_heads expense_heads_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expense_heads
    ADD CONSTRAINT expense_heads_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE;


--
-- Name: expenses expenses_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expenses
    ADD CONSTRAINT expenses_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.bank_accounts(id) ON DELETE SET NULL;


--
-- Name: expenses expenses_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expenses
    ADD CONSTRAINT expenses_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE;


--
-- Name: expenses expenses_party_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expenses
    ADD CONSTRAINT expenses_party_id_fkey FOREIGN KEY (party_id) REFERENCES public.parties(id);


--
-- Name: godowns godowns_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.godowns
    ADD CONSTRAINT godowns_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE;


--
-- Name: hsn_hints hsn_hints_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hsn_hints
    ADD CONSTRAINT hsn_hints_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE;


--
-- Name: invoice_series invoice_series_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoice_series
    ADD CONSTRAINT invoice_series_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE;


--
-- Name: item_history item_history_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_history
    ADD CONSTRAINT item_history_item_id_fkey FOREIGN KEY (item_id) REFERENCES public.items(id) ON DELETE CASCADE;


--
-- Name: item_history item_history_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_history
    ADD CONSTRAINT item_history_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE;


--
-- Name: items items_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.items
    ADD CONSTRAINT items_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE;


--
-- Name: items items_variant_of_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.items
    ADD CONSTRAINT items_variant_of_fkey FOREIGN KEY (variant_of) REFERENCES public.items(id) ON DELETE SET NULL;


--
-- Name: orgs orgs_default_godown_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.orgs
    ADD CONSTRAINT orgs_default_godown_id_fkey FOREIGN KEY (default_godown_id) REFERENCES public.godowns(id) ON DELETE SET NULL;


--
-- Name: orgs orgs_owner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.orgs
    ADD CONSTRAINT orgs_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES auth.users(id);


--
-- Name: parties parties_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.parties
    ADD CONSTRAINT parties_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE;


--
-- Name: payments payments_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payments
    ADD CONSTRAINT payments_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.bank_accounts(id) ON DELETE SET NULL;


--
-- Name: payments payments_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payments
    ADD CONSTRAINT payments_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE;


--
-- Name: payments payments_party_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payments
    ADD CONSTRAINT payments_party_id_fkey FOREIGN KEY (party_id) REFERENCES public.parties(id) ON DELETE CASCADE;


--
-- Name: payments payments_ref_voucher_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payments
    ADD CONSTRAINT payments_ref_voucher_id_fkey FOREIGN KEY (ref_voucher_id) REFERENCES public.vouchers(id) ON DELETE CASCADE;


--
-- Name: profiles profiles_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_id_fkey FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: profiles profiles_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE;


--
-- Name: sample_runs sample_runs_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sample_runs
    ADD CONSTRAINT sample_runs_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE;


--
-- Name: stock_moves stock_moves_godown_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_moves
    ADD CONSTRAINT stock_moves_godown_id_fkey FOREIGN KEY (godown_id) REFERENCES public.godowns(id) ON DELETE SET NULL;


--
-- Name: stock_moves stock_moves_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_moves
    ADD CONSTRAINT stock_moves_item_id_fkey FOREIGN KEY (item_id) REFERENCES public.items(id) ON DELETE CASCADE;


--
-- Name: stock_moves stock_moves_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_moves
    ADD CONSTRAINT stock_moves_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE;


--
-- Name: stock_moves stock_moves_ref_voucher_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stock_moves
    ADD CONSTRAINT stock_moves_ref_voucher_id_fkey FOREIGN KEY (ref_voucher_id) REFERENCES public.vouchers(id) ON DELETE CASCADE;


--
-- Name: voucher_lines voucher_lines_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.voucher_lines
    ADD CONSTRAINT voucher_lines_item_id_fkey FOREIGN KEY (item_id) REFERENCES public.items(id);


--
-- Name: voucher_lines voucher_lines_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.voucher_lines
    ADD CONSTRAINT voucher_lines_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE;


--
-- Name: voucher_lines voucher_lines_voucher_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.voucher_lines
    ADD CONSTRAINT voucher_lines_voucher_id_fkey FOREIGN KEY (voucher_id) REFERENCES public.vouchers(id) ON DELETE CASCADE;


--
-- Name: vouchers vouchers_godown_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vouchers
    ADD CONSTRAINT vouchers_godown_id_fkey FOREIGN KEY (godown_id) REFERENCES public.godowns(id) ON DELETE SET NULL;


--
-- Name: vouchers vouchers_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vouchers
    ADD CONSTRAINT vouchers_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE;


--
-- Name: vouchers vouchers_party_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vouchers
    ADD CONSTRAINT vouchers_party_id_fkey FOREIGN KEY (party_id) REFERENCES public.parties(id);


--
-- Name: vouchers vouchers_ref_voucher_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vouchers
    ADD CONSTRAINT vouchers_ref_voucher_id_fkey FOREIGN KEY (ref_voucher_id) REFERENCES public.vouchers(id);


--
-- Name: bank_accounts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.bank_accounts ENABLE ROW LEVEL SECURITY;

--
-- Name: expense_heads; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.expense_heads ENABLE ROW LEVEL SECURITY;

--
-- Name: expenses; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.expenses ENABLE ROW LEVEL SECURITY;

--
-- Name: godowns; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.godowns ENABLE ROW LEVEL SECURITY;

--
-- Name: hsn_hints; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.hsn_hints ENABLE ROW LEVEL SECURITY;

--
-- Name: hsn_hints hsn_hints_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY hsn_hints_own ON public.hsn_hints USING ((org_id = public.my_org_id())) WITH CHECK ((org_id = public.my_org_id()));


--
-- Name: invoice_series; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.invoice_series ENABLE ROW LEVEL SECURITY;

--
-- Name: item_history; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.item_history ENABLE ROW LEVEL SECURITY;

--
-- Name: items; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.items ENABLE ROW LEVEL SECURITY;

--
-- Name: orgs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.orgs ENABLE ROW LEVEL SECURITY;

--
-- Name: orgs orgs_new; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY orgs_new ON public.orgs FOR INSERT WITH CHECK ((owner_id = auth.uid()));


--
-- Name: orgs orgs_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY orgs_read ON public.orgs FOR SELECT USING (((owner_id = auth.uid()) OR (id = public.my_org_id())));


--
-- Name: orgs orgs_write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY orgs_write ON public.orgs FOR UPDATE USING (((owner_id = auth.uid()) OR ((owner_id IS NULL) AND (id = public.my_org_id())))) WITH CHECK (true);


--
-- Name: bank_accounts p_bank_accounts; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY p_bank_accounts ON public.bank_accounts USING ((org_id = public.my_org_id())) WITH CHECK ((org_id = public.my_org_id()));


--
-- Name: expense_heads p_expense_heads; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY p_expense_heads ON public.expense_heads USING ((org_id = public.my_org_id())) WITH CHECK ((org_id = public.my_org_id()));


--
-- Name: expenses p_expenses; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY p_expenses ON public.expenses USING ((org_id = public.my_org_id())) WITH CHECK ((org_id = public.my_org_id()));


--
-- Name: godowns p_godowns; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY p_godowns ON public.godowns USING ((org_id = public.my_org_id())) WITH CHECK ((org_id = public.my_org_id()));


--
-- Name: invoice_series p_invoice_series; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY p_invoice_series ON public.invoice_series USING ((org_id = public.my_org_id())) WITH CHECK ((org_id = public.my_org_id()));


--
-- Name: item_history p_item_history; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY p_item_history ON public.item_history FOR SELECT USING ((org_id = public.my_org_id()));


--
-- Name: items p_items; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY p_items ON public.items USING ((org_id = public.my_org_id())) WITH CHECK ((org_id = public.my_org_id()));


--
-- Name: parties p_parties; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY p_parties ON public.parties USING ((org_id = public.my_org_id())) WITH CHECK ((org_id = public.my_org_id()));


--
-- Name: payments p_payments; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY p_payments ON public.payments USING ((org_id = public.my_org_id())) WITH CHECK ((org_id = public.my_org_id()));


--
-- Name: sample_runs p_sample_runs; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY p_sample_runs ON public.sample_runs USING ((org_id = public.my_org_id())) WITH CHECK ((org_id = public.my_org_id()));


--
-- Name: stock_moves p_stock_moves; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY p_stock_moves ON public.stock_moves USING ((org_id = public.my_org_id())) WITH CHECK ((org_id = public.my_org_id()));


--
-- Name: voucher_lines p_voucher_lines; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY p_voucher_lines ON public.voucher_lines USING ((org_id = public.my_org_id())) WITH CHECK ((org_id = public.my_org_id()));


--
-- Name: vouchers p_vouchers; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY p_vouchers ON public.vouchers USING ((org_id = public.my_org_id())) WITH CHECK ((org_id = public.my_org_id()));


--
-- Name: parties; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.parties ENABLE ROW LEVEL SECURITY;

--
-- Name: payments; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.payments ENABLE ROW LEVEL SECURITY;

--
-- Name: profiles; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

--
-- Name: profiles profiles_new; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY profiles_new ON public.profiles FOR INSERT WITH CHECK ((id = auth.uid()));


--
-- Name: profiles profiles_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY profiles_read ON public.profiles FOR SELECT USING (((id = auth.uid()) OR (org_id = public.my_org_id())));


--
-- Name: profiles profiles_write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY profiles_write ON public.profiles FOR UPDATE USING (((id = auth.uid()) OR ((public.my_role() = 'owner'::text) AND (org_id = public.my_org_id())))) WITH CHECK (((id = auth.uid()) OR ((public.my_role() = 'owner'::text) AND (org_id = public.my_org_id()))));


--
-- Name: sample_runs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.sample_runs ENABLE ROW LEVEL SECURITY;

--
-- Name: stock_moves; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.stock_moves ENABLE ROW LEVEL SECURITY;

--
-- Name: voucher_lines; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.voucher_lines ENABLE ROW LEVEL SECURITY;

--
-- Name: vouchers; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.vouchers ENABLE ROW LEVEL SECURITY;

--
-- PostgreSQL database dump complete
--

\unrestrict OHSwM48rZOySpYYOnQMIgPD4ixNz5JFOvGh4cZTZfY9VtAexK6ZfBHczU1PxH1G



-- =====================================================================
--  Supabase's roles need to reach what lives in public. Row-level
--  security above decides who actually sees what; without these grants
--  the app cannot reach the tables at all.
-- =====================================================================

grant usage on schema public to anon, authenticated, service_role;
grant all on all tables    in schema public to anon, authenticated, service_role;
grant all on all sequences in schema public to anon, authenticated, service_role;
grant all on all functions in schema public to anon, authenticated, service_role;

alter default privileges in schema public grant all on tables    to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
