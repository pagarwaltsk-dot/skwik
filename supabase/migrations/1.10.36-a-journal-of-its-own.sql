-- ===========================================================================
--  1.10.36  A JOURNAL OF ITS OWN, AND A LEDGER TO HANG IT ON
--
--  Every journal was refused, on the reasoning that a general journal can put
--  a figure anywhere. 1.10.35 rescued the ones that are really a receipt or a
--  payment. What was still lost is the rest, and on his own books the rest is
--  not small: four suppliers with a balance in Tally and NOTHING AT ALL in
--  Skwik, a transporter out by 19,500, and 45,874.86 missing from the cash.
--  A CA posts his adjustments as journals. Every shop with an accountant
--  loses whatever he did.
--
--  WHY THIS NEEDS A NEW TABLE AND NOT A CLEVER TRICK.
--
--  Skwik knows four kinds of account: a party, a bank, the till, and the tax
--  heads inside a bill. Tally knows a few hundred, because an accountant needs
--  somewhere to put depreciation, a director's loan, rent payable, a round-off
--  reserve. A journal is exactly the voucher that moves money between the
--  accounts Skwik does not have, so there is no trick that avoids giving it
--  somewhere to land.
--
--  So: a light chart of accounts, and a voucher made of legs rather than of
--  goods.
--
--    ledgers        every account that is not a party, a bank or the till.
--                   Created as they arrive, named after the file they came
--                   from, with the group Tally filed them under.
--    journals       a date, a number, a narration.
--    journal_legs   one row per leg. A leg points at a party, a bank, the
--                   till, or a ledger -- exactly one of the four.
--
--  THE SIGN. Positive is a DEBIT, negative is a CREDIT, and the legs of a
--  journal must add to nought. That is the same convention the rest of Skwik
--  already reads a party by: a debit to a customer increases what he owes.
--  Nothing is stored that does not balance, so a journal cannot quietly put a
--  book out.
-- ===========================================================================

create table if not exists public.ledgers (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references public.orgs(id) on delete cascade,
  name       text not null,
  grp        text,                                  -- Tally's group, as written
  -- what it behaves like, so a report can add it up without knowing the name
  role       text not null default 'other'
             check (role in ('expense','income','asset','liability','tax','capital','other')),
  opening    numeric(14,2) not null default 0,      -- debit positive
  opening_on date,
  import_run uuid,
  created_at timestamptz not null default now()
);
create unique index if not exists uq_ledgers_name
  on public.ledgers (org_id, lower(name));
create index if not exists ix_ledgers_org on public.ledgers (org_id);

create table if not exists public.journals (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.orgs(id) on delete cascade,
  jdate       date not null,
  voucher_no  text,
  narration   text,
  import_run  uuid,
  cancelled_at timestamptz,
  created_at  timestamptz not null default now()
);
create index if not exists ix_journals_org_date on public.journals (org_id, jdate);

create table if not exists public.journal_legs (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references public.orgs(id) on delete cascade,
  journal_id uuid not null references public.journals(id) on delete cascade,
  line_no    integer not null default 1,
  -- EXACTLY ONE OF THESE FOUR says where the leg lands
  party_id   uuid references public.parties(id) on delete restrict,
  account_id uuid references public.bank_accounts(id) on delete restrict,
  ledger_id  uuid references public.ledgers(id) on delete restrict,
  is_cash    boolean not null default false,
  amount     numeric(14,2) not null,                -- + debit, - credit
  note       text,
  constraint journal_leg_lands_somewhere check (
    (case when party_id   is not null then 1 else 0 end)
  + (case when account_id is not null then 1 else 0 end)
  + (case when ledger_id  is not null then 1 else 0 end)
  + (case when is_cash              then 1 else 0 end) = 1)
);
create index if not exists ix_journal_legs_journal on public.journal_legs (journal_id);
create index if not exists ix_journal_legs_party   on public.journal_legs (party_id);
create index if not exists ix_journal_legs_ledger  on public.journal_legs (ledger_id);

alter table public.ledgers      enable row level security;
alter table public.journals     enable row level security;
alter table public.journal_legs enable row level security;

do $c$
declare t text;
begin
  foreach t in array array['ledgers','journals','journal_legs'] loop
    if not exists (select 1 from pg_policies
                    where tablename = t and policyname = t || '_own_org') then
      execute format('create policy %I on public.%I for all using (org_id = my_org_id())'
                  || ' with check (org_id = my_org_id())', t || '_own_org', t);
    end if;
  end loop;
end
$c$;

grant select, insert, update, delete
  on public.ledgers, public.journals, public.journal_legs to authenticated;


-- ---------------------------------------------------------------------------
--  WRITING ONE.
--
--  p = { id, date, no, narration, import_run,
--        legs: [ { party | account | ledger | cash, group, amount, note } ] }
--
--  A leg names its account in words, because the thing writing this is an
--  importer reading somebody else's file and it has names, not ids. A party
--  or a bank must already exist -- those are Skwik's own masters and inventing
--  one silently would put a stranger in his customer list. A LEDGER may be
--  created, because a ledger is nothing but a name to hang a figure on and
--  refusing to make one is how a journal gets lost.
-- ---------------------------------------------------------------------------
create or replace function public.save_journal(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $sj$
declare
  v_org   uuid := my_org_id();
  v_id    uuid := coalesce(nullif(p->>'id','')::uuid, gen_random_uuid());
  v_date  date := nullif(p->>'date','')::date;
  v_run   uuid := nullif(p->>'import_run','')::uuid;
  v_lock  date;
  r       jsonb;
  v_sum   numeric := 0;
  v_n     integer := 0;
  v_name  text;
  v_pid   uuid; v_aid uuid; v_lid uuid;
  v_cash  boolean;
  v_amt   numeric;
  v_made  integer := 0;
begin
  if v_org is null then raise exception 'This login is not linked to a firm yet'; end if;
  perform assert_can_write();
  if v_date is null then raise exception 'A journal needs a date'; end if;
  if jsonb_typeof(coalesce(p->'legs','null'::jsonb)) <> 'array' then
    raise exception 'A journal needs its legs';
  end if;

  select books_locked_upto into v_lock from orgs where id = v_org;
  if v_lock is not null and v_date <= v_lock then
    raise exception 'Your books are closed up to %. Date this in a month that is still open.',
      to_char(v_lock, 'DD Mon YYYY');
  end if;

  -- ALREADY HERE? The importer hands the same id for the same voucher, so a
  -- file brought in twice writes it once.
  if exists (select 1 from journals where id = v_id and org_id = v_org) then
    return jsonb_build_object('id', v_id, 'already', true);
  end if;

  -- IT MUST BALANCE BEFORE ANYTHING IS WRITTEN, not after.
  for r in select * from jsonb_array_elements(p->'legs') loop
    v_amt := round(coalesce((r->>'amount')::numeric, 0), 2);
    if v_amt <> 0 then v_sum := v_sum + v_amt; v_n := v_n + 1; end if;
  end loop;
  if v_n < 2 then raise exception 'A journal needs at least two sides'; end if;
  if abs(v_sum) > 0.05 then
    raise exception 'That journal does not balance: the debits and the credits differ by %',
      to_char(abs(v_sum), 'FM999999990.00');
  end if;

  insert into journals (id, org_id, jdate, voucher_no, narration, import_run)
  values (v_id, v_org, v_date, nullif(p->>'no',''), nullif(p->>'narration',''), v_run);

  for r in select * from jsonb_array_elements(p->'legs') loop
    v_amt := round(coalesce((r->>'amount')::numeric, 0), 2);
    if v_amt = 0 then continue; end if;
    v_pid := null; v_aid := null; v_lid := null; v_cash := false;
    v_made := v_made + 1;

    if coalesce((r->>'cash')::boolean, false) then
      v_cash := true;
    elsif nullif(r->>'party','') is not null then
      v_name := r->>'party';
      select id into v_pid from parties
       where org_id = v_org and lower(name) = lower(v_name) limit 1;
      if v_pid is null then
        raise exception 'There is no customer or supplier called "%" to post that journal to', v_name;
      end if;
    elsif nullif(r->>'account','') is not null then
      v_name := r->>'account';
      select id into v_aid from bank_accounts
       where org_id = v_org and lower(name) = lower(v_name) limit 1;
      if v_aid is null then
        raise exception 'There is no bank account called "%" to post that journal to', v_name;
      end if;
    else
      v_name := nullif(r->>'ledger','');
      if v_name is null then raise exception 'A journal leg must say where it lands'; end if;
      select id into v_lid from ledgers
       where org_id = v_org and lower(name) = lower(v_name) limit 1;
      if v_lid is null then
        insert into ledgers (org_id, name, grp, role, import_run)
        values (v_org, v_name, nullif(r->>'group',''),
                coalesce(nullif(r->>'role',''), 'other'), v_run)
        returning id into v_lid;
      end if;
    end if;

    insert into journal_legs (org_id, journal_id, line_no, party_id, account_id,
                              ledger_id, is_cash, amount, note)
    values (v_org, v_id, v_made, v_pid, v_aid, v_lid, v_cash, v_amt, nullif(r->>'note',''));
  end loop;

  return jsonb_build_object('id', v_id, 'already', false, 'legs', v_made);
end $sj$;

revoke all on function public.save_journal(jsonb) from public;
grant execute on function public.save_journal(jsonb) to authenticated;


-- ---------------------------------------------------------------------------
--  AND NOW THE BALANCES HAVE TO KNOW ABOUT IT.
--
--  A journal that is written and not counted is worse than one refused: the
--  screen says the books are complete and they are not. So a party's balance
--  reads its journal legs alongside its bills and its receipts.
--
--  The rest of party_balance_rows is exactly as it was.
-- ---------------------------------------------------------------------------
create or replace function public.party_balance_rows(p_on date default null)
returns table (id uuid, name text, kind text, area text, phone text, gstin text,
               state_name text, amt numeric, last_bill date, last_paid date)
language sql
stable
security definer
set search_path to 'public'
as $pbr$
  select p.id, p.name, p.kind, p.area, p.phone, p.gstin, p.state_name,
         round(
           case when p.opening_type = 'you_owe' then -coalesce(p.opening_balance, 0)
                else coalesce(p.opening_balance, 0) end
           + coalesce(v.amt, 0)
           - coalesce(m.amt, 0)
           + coalesce(j.amt, 0), 2) as amt,
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
    -- A DEBIT TO A PARTY INCREASES WHAT HE OWES, which is the same direction
    -- a sale moves him, so the leg is added exactly as it is written.
    left join lateral (
      select sum(l.amount) as amt
        from journal_legs l
        join journals jj on jj.id = l.journal_id
       where l.party_id = p.id
         and l.org_id   = p.org_id
         and jj.cancelled_at is null
         and (p_on is null or jj.jdate <= p_on)
    ) j on true
   where p.org_id = my_org_id()
$pbr$;

revoke all on function public.party_balance_rows(date) from public;
grant execute on function public.party_balance_rows(date) to authenticated;


-- ---------------------------------------------------------------------------
--  WHAT EVERY OTHER LEDGER COMES TO.
--
--  The accounts that are not parties, banks or the till: what a trial balance
--  would call the rest of the book. Opening plus every leg, debit positive.
-- ---------------------------------------------------------------------------
create or replace function public.ledger_balances_on(p_on date default null)
returns jsonb
language sql
stable
security definer
set search_path to 'public'
as $lb$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', x.id, 'name', x.name, 'group', x.grp, 'role', x.role,
           'opening', x.opening, 'balance', x.bal) order by x.name), '[]'::jsonb)
    from (
      select g.id, g.name, g.grp, g.role, g.opening,
             round(coalesce(g.opening, 0) + coalesce((
               select sum(l.amount) from journal_legs l
                 join journals jj on jj.id = l.journal_id
                where l.ledger_id = g.id and jj.cancelled_at is null
                  and (p_on is null or jj.jdate <= p_on)), 0), 2) as bal
        from ledgers g
       where g.org_id = my_org_id()
    ) x;
$lb$;

revoke all on function public.ledger_balances_on(date) from public;
grant execute on function public.ledger_balances_on(date) to authenticated;
