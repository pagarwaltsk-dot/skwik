-- ============================================================
--  SKWIK - UPDATE AN EXISTING DATABASE
--  Safe to run on a database made from ANY earlier version, and
--  safe to run more than once. It adds what is missing and never
--  touches data you already have.
--  Paste the whole file into Supabase > SQL Editor > Run.
-- ============================================================

-- ---------- COLUMNS ADDED SINCE THE FIRST VERSION ----------

alter table orgs add column if not exists mode               text not null default 'estimate';
alter table orgs add column if not exists estimate_prefix    text default '';
alter table orgs add column if not exists next_estimate_no   int not null default 1;
alter table orgs add column if not exists trial_ends_at      timestamptz;
alter table orgs add column if not exists plan               text default 'trial';
alter table orgs add column if not exists is_composition     boolean not null default false;
alter table orgs add column if not exists hsn_enabled        boolean not null default true;
alter table orgs add column if not exists turnover_above_5cr boolean not null default false;
alter table orgs add column if not exists stock_enabled      boolean not null default true;
alter table orgs add column if not exists price1_name        text default 'Wholesale';
alter table orgs add column if not exists price2_name        text default 'Retail';
alter table orgs add column if not exists bank_name          text;
alter table orgs add column if not exists bank_ledger        text default 'Bank Account';
alter table orgs add column if not exists cash_ledger        text default 'Cash';
alter table orgs add column if not exists sales_ledger       text default 'Sales';
alter table orgs add column if not exists purchase_ledger    text default 'Purchase';
alter table orgs add column if not exists cgst_ledger        text default 'CGST';
alter table orgs add column if not exists sgst_ledger        text default 'SGST';
alter table orgs add column if not exists igst_ledger        text default 'IGST';
alter table orgs add column if not exists round_off_ledger   text default 'Round Off';

alter table items add column if not exists alias          text;
alter table items add column if not exists tags           text;
alter table items add column if not exists price2         numeric(14,2) default 0;
alter table items add column if not exists purchase_price numeric(14,2) default 0;

alter table parties add column if not exists price_list smallint default 1;

alter table vouchers add column if not exists extra_amount numeric(14,2) default 0;
alter table vouchers add column if not exists extra_note   text;

alter table voucher_lines add column if not exists flag    boolean default false;
alter table voucher_lines add column if not exists checked boolean default false;

-- ---------- WHO AM I ----------

create or replace function my_org_id() returns uuid
language sql stable security definer set search_path = public as $$
  select org_id from profiles where id = auth.uid()
$$;

-- ---------- ROW LEVEL SECURITY ----------

alter table orgs          enable row level security;
alter table profiles      enable row level security;
alter table items         enable row level security;
alter table parties       enable row level security;
alter table vouchers      enable row level security;
alter table voucher_lines enable row level security;
alter table payments      enable row level security;
alter table stock_moves   enable row level security;

drop policy if exists p_profiles on profiles;
create policy p_profiles on profiles for all
  using (id = auth.uid()) with check (id = auth.uid());

drop policy if exists p_orgs on orgs;
create policy p_orgs on orgs for all
  using (id = my_org_id()) with check (id = my_org_id());

drop policy if exists p_orgs_insert on orgs;
create policy p_orgs_insert on orgs for insert
  with check (auth.uid() is not null);

do $$
declare t text;
begin
  foreach t in array array['items','parties','vouchers','voucher_lines','payments','stock_moves'] loop
    execute format('drop policy if exists p_%1$s on %1$s', t);
    execute format(
      'create policy p_%1$s on %1$s for all using (org_id = my_org_id()) with check (org_id = my_org_id())', t);
  end loop;
end $$;

-- ---------- STOCK IN HAND ----------

create or replace view stock_in_hand
with (security_invoker = on) as
select
  i.id      as item_id,
  i.org_id,
  i.name,
  i.unit,
  i.opening_stock
    + coalesce((select sum(sm.qty_in - sm.qty_out) from stock_moves sm where sm.item_id = i.id), 0)
            as qty
from items i
where i.is_active;

-- ---------- NEXT INVOICE NUMBER ----------

create or replace function next_invoice_no(p_org uuid) returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  update orgs set next_invoice_no = next_invoice_no + 1
   where id = p_org
   returning next_invoice_no - 1 into n;
  return n;
end $$;

-- ---------- SAVE A WHOLE VOUCHER IN ONE GO ----------
-- Writes the voucher, its lines, its stock movements and (for a cash sale)
-- the matching cash receipt - all inside one transaction.

create or replace function save_voucher(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_org   uuid := my_org_id();
  v_id    uuid := gen_random_uuid();
  v_type  text := p->>'vtype';
  v_no    text;
  v_party uuid := nullif(p->>'party_id','')::uuid;
  ln      jsonb;
  i       int := 0;
begin
  if v_org is null then
    raise exception 'This login is not linked to a firm yet';
  end if;

  if v_type = 'sale' then
    select coalesce(invoice_prefix,'') || next_invoice_no(v_org)::text into v_no from orgs where id = v_org;
  elsif v_type = 'estimate' then
    -- estimates keep their own series, so switching GST on later starts
    -- tax invoices at 1 without ever clashing with an estimate already given
    update orgs set next_estimate_no = next_estimate_no + 1
      where id = v_org
      returning coalesce(estimate_prefix,'') || (next_estimate_no - 1)::text into v_no;
  else
    v_no := nullif(p->>'voucher_no','');
  end if;

  insert into vouchers (
    id, org_id, vtype, voucher_no, vdate, party_id, printed_name, is_cash,
    supplier_invoice_no, supplier_invoice_date, place_of_supply_code, tax_mode,
    taxable, cgst, sgst, igst, extra_amount, extra_note, round_off, total, notes)
  values (
    v_id, v_org, v_type, v_no,
    coalesce(nullif(p->>'vdate','')::date, current_date),
    v_party, p->>'printed_name', coalesce((p->>'is_cash')::boolean, false),
    nullif(p->>'supplier_invoice_no',''), nullif(p->>'supplier_invoice_date','')::date,
    nullif(p->>'place_of_supply_code',''), coalesce(nullif(p->>'tax_mode',''),'none'),
    coalesce((p->>'taxable')::numeric,0), coalesce((p->>'cgst')::numeric,0),
    coalesce((p->>'sgst')::numeric,0),    coalesce((p->>'igst')::numeric,0),
    coalesce((p->>'extra_amount')::numeric,0), nullif(p->>'extra_note',''),
    coalesce((p->>'round_off')::numeric,0), coalesce((p->>'total')::numeric,0),
    nullif(p->>'notes',''));

  for ln in select * from jsonb_array_elements(coalesce(p->'lines','[]'::jsonb)) loop
    i := i + 1;

    insert into voucher_lines (
      voucher_id, org_id, item_id, item_name, hsn, unit, qty, rate, gst_rate,
      taxable, cgst, sgst, igst, amount, line_no, flag, checked)
    values (
      v_id, v_org, nullif(ln->>'item_id','')::uuid, ln->>'item_name',
      nullif(ln->>'hsn',''), nullif(ln->>'unit',''),
      coalesce((ln->>'qty')::numeric,0), coalesce((ln->>'rate')::numeric,0),
      coalesce((ln->>'gst_rate')::numeric,0), coalesce((ln->>'taxable')::numeric,0),
      coalesce((ln->>'cgst')::numeric,0), coalesce((ln->>'sgst')::numeric,0),
      coalesce((ln->>'igst')::numeric,0), coalesce((ln->>'amount')::numeric,0), i,
      coalesce((ln->>'flag')::boolean,false), coalesce((ln->>'checked')::boolean,false));

    if nullif(ln->>'item_id','') is not null then
      insert into stock_moves (org_id, item_id, mdate, qty_in, qty_out, reason, ref_voucher_id)
      values (
        v_org, (ln->>'item_id')::uuid,
        coalesce(nullif(p->>'vdate','')::date, current_date),
        case when v_type in ('purchase','sale_return')          then coalesce((ln->>'qty')::numeric,0) else 0 end,
        case when v_type in ('sale','estimate','purchase_return') then coalesce((ln->>'qty')::numeric,0) else 0 end,
        v_type, v_id);
    end if;
  end loop;

  -- A cash sale to a named party: the sale stands on one side of his account
  -- and the cash received stands on the other, so his balance is untouched.
  if v_type in ('sale','estimate')
     and coalesce((p->>'is_cash')::boolean, false)
     and v_party is not null then
    insert into payments (org_id, ptype, party_id, pdate, mode, amount, note)
    values (v_org, 'receipt', v_party,
            coalesce(nullif(p->>'vdate','')::date, current_date),
            'cash', coalesce((p->>'total')::numeric,0),
            'Cash for ' || coalesce(v_no,''));
  end if;

  return jsonb_build_object('id', v_id, 'voucher_no', v_no);
end $$;

-- ---------- ITEM HISTORY ----------
-- An old bill is ALREADY safe: voucher_lines keep their own copy of the name,
-- rate, HSN and tax, so changing an item tomorrow cannot reach backwards and
-- alter a bill printed today. This table is the proof of that - who changed
-- what, and when. Rows are written by the trigger and can never be edited.

create table if not exists item_history (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references orgs(id) on delete cascade,
  item_id    uuid not null references items(id) on delete cascade,
  changed_at timestamptz not null default now(),
  changed_by uuid,
  field      text not null,
  old_value  text,
  new_value  text
);

create index if not exists idx_item_history on item_history(item_id, changed_at desc);

alter table item_history enable row level security;

-- A shop may READ its own history. Nobody may write, edit or delete it:
-- only the trigger writes, so the trail cannot be tidied up afterwards.
drop policy if exists p_item_history on item_history;
create policy p_item_history on item_history for select
  using (org_id = my_org_id());

create or replace function tg_items_history() returns trigger
language plpgsql security definer set search_path = public as $$
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
end $$;

drop trigger if exists items_history on items;
create trigger items_history after update on items
  for each row execute function tg_items_history();

-- ---------- BILL NUMBERING ----------
-- Lets the shopkeeper carry on from the number his paper book reached, and
-- change the prefix at the start of a financial year. It refuses any number
-- that would repeat a bill he has already issued under the same prefix.

create or replace function set_invoice_start(p_next int, p_prefix text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_org    uuid := my_org_id();
  v_prefix text := coalesce(p_prefix, (select invoice_prefix from orgs where id = v_org), '');
  v_max    int;
begin
  if v_org is null then raise exception 'This login is not linked to a firm yet'; end if;
  if p_next is null or p_next < 1 then raise exception 'The next bill number must be 1 or more'; end if;

  -- highest number already used under this prefix
  select max(nullif(regexp_replace(voucher_no, '^' || regexp_replace(v_prefix,'([^a-zA-Z0-9])','\\\1','g'), ''), '')::int)
    into v_max
    from vouchers
   where org_id = v_org and vtype = 'sale'
     and voucher_no ~ ('^' || regexp_replace(v_prefix,'([^a-zA-Z0-9])','\\\1','g') || '[0-9]+$');

  if v_max is not null and p_next <= v_max then
    raise exception 'You have already issued bill number %. The next number must be more than that.', v_max;
  end if;

  update orgs
     set next_invoice_no = p_next,
         invoice_prefix  = coalesce(p_prefix, invoice_prefix)
   where id = v_org;

  return jsonb_build_object('next_invoice_no', p_next, 'invoice_prefix', v_prefix);
end $$;

-- ---------- LEARNED HSN HINTS ----------
-- Every time a shop saves an item with an HSN code, the words of that item
-- name are counted against that code. Nothing identifies the shop: only
-- word -> code -> how many times. After a few hundred shops this becomes a
-- synonym list that nobody had to write - "bucket" finds 3924 because two
-- hundred traders said so.
--
-- Nothing in the app reads this yet. It starts collecting from your first
-- customer so that the data exists by the time you want to use it.

create table if not exists hsn_hints (
  word       text not null,
  hsn        text not null,
  uses       int  not null default 1,
  updated_at timestamptz default now(),
  primary key (word, hsn)
);

alter table hsn_hints enable row level security;

-- Anyone logged in may READ the pooled hints. Nobody may write directly;
-- only the trigger below writes, and it carries no shop identity.
drop policy if exists p_hsn_hints_read on hsn_hints;
create policy p_hsn_hints_read on hsn_hints for select
  using (auth.uid() is not null);

create or replace function tg_items_hsn_hint() returns trigger
language plpgsql security definer set search_path = public as $$
declare w text;
begin
  if new.hsn is null or length(trim(new.hsn)) < 4 then return new; end if;

  foreach w in array regexp_split_to_array(
      lower(regexp_replace(coalesce(new.name,'') || ' ' || coalesce(new.search_words,''),
                           '[^a-zA-Z ]', ' ', 'g')), '\s+') loop
    if length(w) >= 3 then
      insert into hsn_hints (word, hsn, uses)
      values (w, left(trim(new.hsn), 4), 1)
      on conflict (word, hsn)
        do update set uses = hsn_hints.uses + 1, updated_at = now();
    end if;
  end loop;
  return new;
end $$;

drop trigger if exists items_hsn_hint on items;
create trigger items_hsn_hint
  after insert or update of hsn, name on items
  for each row execute function tg_items_hsn_hint();

-- For later: what do other shops call this? Returns the most-used codes.
create or replace function suggest_hsn(p_name text)
returns table (hsn text, score bigint)
language sql stable security definer set search_path = public as $$
  select h.hsn, sum(h.uses)::bigint as score
    from hsn_hints h
   where h.word = any (
     select x from unnest(regexp_split_to_array(
       lower(regexp_replace(coalesce(p_name,''), '[^a-zA-Z ]', ' ', 'g')), '\s+')) x
      where length(x) >= 3)
   group by h.hsn
   order by score desc
   limit 5;
$$;

-- ---------- PARTY LEDGER (two sided) ----------

create or replace function party_ledger(p_party uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_org  uuid := my_org_id();
  v_rows jsonb;
  v_open numeric;
  v_type text;
begin
  select opening_balance, opening_type into v_open, v_type
    from parties where id = p_party and org_id = v_org;
  if not found then raise exception 'Party not found'; end if;

  select coalesce(jsonb_agg(r order by r->>'d', r->>'label'), '[]'::jsonb) into v_rows from (
    select jsonb_build_object(
             'side',  case when vtype in ('sale','estimate','purchase_return') then 'left' else 'right' end,
             'd',     vdate::text,
             'label', case vtype
                        when 'estimate'        then 'Estimate ' || coalesce(voucher_no,'')
                        when 'sale'            then 'Bill No. ' || coalesce(voucher_no,'')
                        when 'purchase'        then 'Purchase ' || coalesce(supplier_invoice_no, voucher_no, '')
                        when 'sale_return'     then 'Sales return'
                        else 'Purchase return' end
                      || case when is_cash then ' (Cash)' else '' end,
             'amt',   total) as r
      from vouchers where org_id = v_org and party_id = p_party
    union all
    select jsonb_build_object(
             'side',  case when ptype = 'receipt' then 'right' else 'left' end,
             'd',     pdate::text,
             'label', case when mode = 'cash' then 'Cash ' else 'Bank ' end
                      || case when ptype = 'receipt' then 'received' else 'paid' end,
             'amt',   amount) as r
      from payments where org_id = v_org and party_id = p_party
  ) x;

  return jsonb_build_object(
    'opening',      v_open,
    'opening_type', v_type,
    'rows',         v_rows);
end $$;
