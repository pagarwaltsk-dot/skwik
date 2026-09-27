-- ===========================================================================
--  1.10.6  MONEY MOVED BETWEEN THE TILL AND THE BANK
--
--  WHAT WAS WRONG
--
--  A shop deposits its cash into the bank. Skwik had no entry for it at all --
--  every money entry was tied to a party, a receipt FROM a customer or a
--  payment TO a supplier -- so:
--
--    · cash in hand only ever went up, because a deposit never took any out
--    · a bank balance never rose from a deposit, because a deposit was not a
--      receipt from anybody
--
--  Both figures drifted a little further apart every day he banked his takings,
--  and they are the two figures a shopkeeper checks most. Tally records this as
--  a Contra voucher; the importer named it and skipped it, so a year of
--  deposits never arrived either.
--
--  WHY A TABLE OF ITS OWN
--
--  The obvious move is a new kind of row in `payments`. It is the wrong move.
--  Thirty-odd sums across this database read that table as "receipt = in,
--  anything else = out", and a deposit is neither: it is out of the till AND
--  into the bank at the same time. Every one of those sums would have to be
--  found and taught, and the one that got missed would put a wrong figure in
--  his books without saying a word.
--
--  So a deposit lives in its own table. Nothing that already works changes
--  behaviour; the figures that must know about it are told, one at a time,
--  below.
--
--  ONE ROW, TWO ENDS. A deposit is a single movement -- ₹400000 out of the
--  till and into Federal Bank -- so it is a single row. Two rows, one per end,
--  would allow half a deposit to exist, and half a deposit is worse than none.
-- ===========================================================================

create table if not exists public.cash_moves (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.orgs(id) on delete cascade,
  -- 'deposit'    cash out of the till, into the account
  -- 'withdrawal' out of the account, into the till
  direction   text not null check (direction in ('deposit','withdrawal')),
  mdate       date not null default today_ist(),
  amount      numeric(14,2) not null check (amount > 0),
  account_id  uuid references public.bank_accounts(id) on delete restrict,
  note        text,
  created_at  timestamptz default now(),
  -- so an imported deposit can be taken back out again with its own import
  import_run  uuid
);

create index if not exists idx_cash_moves_org_date on public.cash_moves (org_id, mdate);
create index if not exists idx_cash_moves_account  on public.cash_moves (org_id, account_id, mdate);
create index if not exists idx_cash_moves_run      on public.cash_moves (import_run);

-- THE SAME DEPOSIT TWICE IS NOT A DEPOSIT TWICE. An import that is pressed
-- again must not bank his takings a second time, and the only honest key for
-- "the same movement" is the day, the amount, the account and the direction.
create unique index if not exists uq_cash_moves_once
  on public.cash_moves (org_id, mdate, direction, amount, coalesce(account_id, '00000000-0000-0000-0000-000000000000'::uuid));

alter table public.cash_moves enable row level security;

drop policy if exists p_cash_moves on public.cash_moves;
create policy p_cash_moves on public.cash_moves
  using (org_id = public.my_org_id())
  with check (org_id = public.my_org_id());

-- AND THE ACCOUNTANT STILL CANNOT WRITE. Restrictive, so it can only take
-- permission away, never give it -- the same shape every other table uses.
drop policy if exists ro_accountant_ins on public.cash_moves;
drop policy if exists ro_accountant_upd on public.cash_moves;
drop policy if exists ro_accountant_del on public.cash_moves;
create policy ro_accountant_ins on public.cash_moves as restrictive for insert
  with check (can_write());
create policy ro_accountant_upd on public.cash_moves as restrictive for update
  using (can_write()) with check (can_write());
create policy ro_accountant_del on public.cash_moves as restrictive for delete
  using (can_write());

grant select, insert, update, delete on public.cash_moves to authenticated;

-- ---------------------------------------------------------------------------
--  CLOSED BOOKS STAY CLOSED.
--
--  Every other entry refuses a date inside a closed month. A deposit dated
--  into one would move a cash figure he has already filed against, so it is
--  refused in the same words, at the table, where a client writing straight
--  through PostgREST cannot go round it.
-- ---------------------------------------------------------------------------
create or replace function public.tg_cash_move_guard()
returns trigger language plpgsql security definer set search_path to 'public' as $cmg$
declare v_lock date;
begin
  select books_locked_upto into v_lock from orgs where id = new.org_id;
  if v_lock is not null and new.mdate <= v_lock then
    raise exception 'Your books are closed up to %. Date this in a month that is still open.',
      to_char(v_lock, 'DD Mon YYYY');
  end if;
  if new.account_id is not null and not exists (
       select 1 from bank_accounts b where b.id = new.account_id and b.org_id = new.org_id) then
    raise exception 'That bank account belongs to another firm';
  end if;
  return new;
end $cmg$;

drop trigger if exists tg_cash_move_guard on public.cash_moves;
create trigger tg_cash_move_guard before insert or update on public.cash_moves
  for each row execute function public.tg_cash_move_guard();


-- ===========================================================================
--  THE TWO FIGURES THAT HAVE TO KNOW
--
--  Both functions are reprinted whole below, because that is how this project
--  replaces one. Against the tested 1.10.3 and schema versions, the ONLY
--  changes are the blocks commented "MONEY MOVED TO THE BANK", "and what he
--  paid in over the counter", "a deposit with no account named", "AND WHAT HE
--  BANKED BEFORE THE PERIOD BEGAN" and "THE DEPOSIT ITSELF". Nothing else was
--  touched, by hand or otherwise.
-- ===========================================================================

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

  -- MONEY MOVED TO THE BANK IS STILL OUT OF THE TILL.
  --
  -- Without this, cash in hand only ever went up: he banked his takings every
  -- evening and Skwik went on counting them as sitting in the drawer.
  v_cash := v_cash
    - coalesce((select sum(case when direction = 'deposit' then amount else -amount end)
                  from cash_moves
                 where org_id = v_org and mdate <= p_on), 0);

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
                            and e.account_id = b.id and e.edate <= p_on), 0)
             -- and what he paid in over the counter, or took back out
             + coalesce((select sum(case when cm.direction = 'deposit' then cm.amount
                                         else -cm.amount end)
                           from cash_moves cm
                          where cm.org_id = v_org and cm.account_id = b.id
                            and cm.mdate <= p_on), 0) as bal
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

  -- a deposit with no account named against it -- it still left the till, so
  -- it has to land somewhere or the sheet stops balancing
  v_bank := v_bank
    + coalesce((select sum(case when direction = 'deposit' then amount else -amount end)
                  from cash_moves
                 where org_id = v_org and account_id is null and mdate <= p_on), 0);

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

revoke all on function public.balance_sheet(date) from public;
grant execute on function public.balance_sheet(date) to authenticated;

CREATE OR REPLACE FUNCTION public.money_book(p_from date, p_to date, p_account uuid DEFAULT NULL::uuid, p_cash boolean DEFAULT true, p_limit integer DEFAULT 400) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $mbk$
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

  -- AND WHAT HE BANKED BEFORE THE PERIOD BEGAN.
  --
  -- On the cash side a deposit went out of the till; on the bank side the same
  -- deposit came in. Left out of the opening figure, every line of the book
  -- after it carries a running balance that is wrong by the same amount.
  v_open := v_open
    + coalesce((select sum(case when p_cash
                                then case when direction = 'deposit' then -amount else amount end
                                else case when direction = 'deposit' then  amount else -amount end
                           end)
                  from cash_moves
                 where org_id = v_org and mdate < p_from
                   and (p_cash or p_account is null or account_id = p_account)), 0);

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

      union all

      -- THE DEPOSIT ITSELF, ON BOTH SIDES OF THE HOUSE.
      --
      -- The same movement is money out of the cash book and money into the
      -- bank book, so which column it falls in depends on which book is being
      -- read. Without this the balance jumps and nothing on the page explains
      -- why -- which reads exactly like money gone missing.
      select cm.id, 'cash_move', cm.mdate,
             coalesce(b.name, 'Bank') as who,
             case when cm.direction = 'deposit' then 'Paid into bank'
                  else 'Taken from bank' end as what,
             cm.note,
             case when (cm.direction = 'deposit') = p_cash then 0 else cm.amount end as amt_in,
             case when (cm.direction = 'deposit') = p_cash then cm.amount else 0 end as amt_out,
             cm.created_at
        from cash_moves cm
        left join bank_accounts b on b.id = cm.account_id
       where cm.org_id = v_org and cm.mdate between p_from and p_to
         and (p_cash or p_account is null or cm.account_id = p_account)
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
end $mbk$;

revoke all on function public.money_book(date, date, uuid, boolean, integer) from public;
grant execute on function public.money_book(date, date, uuid, boolean, integer) to authenticated;


-- ===========================================================================
--  A DEPOSIT HAS TO SURVIVE A BACKUP, A RESTORE AND AN UNDO
--
--  A table the backup does not know about is a table that is silently gone the
--  day he restores onto a new phone -- and a restore that does not clear it
--  first would bank his takings twice. tools/check.mjs has a rule for exactly
--  this ("every table a backup writes can be put back"), so the four functions
--  below are reprinted with cash_moves added and nothing else changed.
-- ===========================================================================

create or replace function public.book_head()
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $hd$
declare v_org uuid := my_org_id(); j jsonb;
begin
  if v_org is null then raise exception 'This login is not linked to a firm yet'; end if;
  if my_role() <> 'owner' then
    raise exception 'Only the owner can take a copy of the whole book';
  end if;

  select jsonb_build_object(
    'skwik_backup', 2,
    'taken_at', now(),
    'org', (select to_jsonb(o) - 'join_code' - 'join_open' - 'join_open_until'
              from orgs o where o.id = v_org),
    'how_many', jsonb_build_object(
      'godowns',        (select count(*) from godowns        where org_id = v_org),
      'bank_accounts',  (select count(*) from bank_accounts  where org_id = v_org),
      'parties',        (select count(*) from parties        where org_id = v_org),
      'items',          (select count(*) from items          where org_id = v_org),
      'item_parts',     (select count(*) from item_parts     where org_id = v_org),
      'standing_items', (select count(*) from standing_items where org_id = v_org),
      'expense_heads',  (select count(*) from expense_heads  where org_id = v_org),
      'invoice_series', (select count(*) from invoice_series where org_id = v_org),
      'vouchers',       (select count(*) from vouchers       where org_id = v_org),
      'voucher_lines',  (select count(*) from voucher_lines  where org_id = v_org),
      'payments',       (select count(*) from payments       where org_id = v_org),
      'expenses',       (select count(*) from expenses       where org_id = v_org),
      'stock_moves',    (select count(*) from stock_moves    where org_id = v_org),
      -- money moved between the till and the bank
      'cash_moves',     (select count(*) from cash_moves     where org_id = v_org)),
    'years', (select coalesce(jsonb_agg(y order by y), '[]'::jsonb) from (
                select distinct
                  case when extract(month from vdate) >= 4
                       then extract(year from vdate)::int
                       else extract(year from vdate)::int - 1 end y
                  from vouchers where org_id = v_org) z)
  ) into j;
  return j;
end
$hd$;

revoke all on function public.book_head() from public;
grant execute on function public.book_head() to authenticated;

create or replace function public.book_slice(p_table text, p_from int,
                                             p_size int default 2000,
                                             p_year int default null)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $sl$
declare
  v_org uuid := my_org_id();
  v_a   date;
  v_b   date;
  v_key text;
  v_when text;
  j     jsonb;
begin
  if v_org is null then raise exception 'This login is not linked to a firm yet'; end if;
  if my_role() <> 'owner' then
    raise exception 'Only the owner can take a copy of the whole book';
  end if;
  if p_table not in ('godowns','bank_accounts','parties','items','item_parts',
                     'standing_items','expense_heads','invoice_series',
                     'vouchers','voucher_lines','payments','expenses','stock_moves',
                     'cash_moves') then
    raise exception 'There is no % in a Skwik book', p_table;
  end if;
  if coalesce(p_size, 0) < 1 or p_size > 5000 then p_size := 2000; end if;
  if coalesce(p_from, 0) < 0 then p_from := 0; end if;

  if p_year is not null then
    v_a := make_date(p_year, 4, 1);
    v_b := make_date(p_year + 1, 3, 31);
  end if;

  -- SOMETHING TO COUNT FROM.
  -- Paging needs an order that cannot change between one page and the next,
  -- or a row slips through the join between two pages and is simply absent
  -- from the copy. Most tables have an id; the two that do not are keyed on
  -- their own columns, so those are used.
  v_key := case p_table
             when 'expense_heads'  then 't.head'
             when 'invoice_series' then 't.kind, t.fy'
             else 't.id'
           end;

  v_when := case p_table
              when 'vouchers'      then 't.vdate between $2 and $3'
              when 'payments'      then 't.pdate between $2 and $3'
              when 'expenses'      then 't.edate between $2 and $3'
              when 'stock_moves'   then 't.mdate between $2 and $3'
              when 'cash_moves'    then 't.mdate between $2 and $3'
              when 'voucher_lines' then 'exists (select 1 from vouchers v'
                                      || ' where v.id = t.voucher_id'
                                      || ' and v.vdate between $2 and $3)'
              else 'true'
            end;

  execute format($q$
    select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb)
      from (select t.* from %1$I t
             where t.org_id = $1
               and ($2::date is null or %2$s)
             order by %3$s
             limit $4 offset $5) x $q$,
    p_table, v_when, v_key)
  using v_org, v_a, v_b, p_size, p_from
  into j;

  return jsonb_build_object('table', p_table, 'from', p_from,
                            'rows', j, 'count', jsonb_array_length(j));
end
$sl$;

revoke all on function public.book_slice(text, int, int, int) from public;
grant execute on function public.book_slice(text, int, int, int) to authenticated;

create or replace function public.book_restore_clear(p_run uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $rc$
declare
  v_org uuid := my_org_id();
  r     import_runs%rowtype;
  n     jsonb := '{}'::jsonb;
  c     int;
begin
  perform assert_can_write();
  if v_org is null then raise exception 'This login is not linked to a firm yet'; end if;
  if my_role() <> 'owner' then
    raise exception 'Only the owner can take a restore back out';
  end if;

  select * into r from import_runs where id = p_run and org_id = v_org and kind = 'backup';
  if not found then raise exception 'That restore is not one of yours'; end if;

  -- IN THE ORDER THE REFERENCES ALLOW, and every statement scoped to this
  -- firm. This function is SECURITY DEFINER, so row security does not apply
  -- inside it: a missing org_id here would reach across every shop in the
  -- database, so there is one on every line.
  delete from payments    where org_id = v_org and import_run = p_run;
  get diagnostics c = row_count; n := n || jsonb_build_object('payments', c);

  delete from stock_moves where org_id = v_org and import_run = p_run;
  get diagnostics c = row_count; n := n || jsonb_build_object('stock_moves', c);

  delete from voucher_lines where org_id = v_org and voucher_id in (
    select m.new from restore_maps m where m.run = p_run and m.kind = 'voucher');
  get diagnostics c = row_count; n := n || jsonb_build_object('voucher_lines', c);

  -- a credit note pointing at a bill that is also going
  update vouchers set ref_voucher_id = null
   where org_id = v_org and ref_voucher_id in (
     select m.new from restore_maps m where m.run = p_run and m.kind = 'voucher');

  delete from vouchers where org_id = v_org and id in (
    select m.new from restore_maps m where m.run = p_run and m.kind = 'voucher');
  get diagnostics c = row_count; n := n || jsonb_build_object('vouchers', c);

  delete from item_parts where org_id = v_org and (
    parent_id in (select m.new from restore_maps m where m.run = p_run and m.kind = 'item')
    or child_id in (select m.new from restore_maps m where m.run = p_run and m.kind = 'item'));
  get diagnostics c = row_count; n := n || jsonb_build_object('item_parts', c);

  -- THE TABLES THE MAP DOES NOT COVER. The firm was empty when this run
  -- started -- begin will not start one otherwise -- so what is here came from
  -- this restore.
  delete from expenses where org_id = v_org;
  get diagnostics c = row_count; n := n || jsonb_build_object('expenses', c);

  delete from standing_items where org_id = v_org;
  get diagnostics c = row_count; n := n || jsonb_build_object('standing_items', c);

  delete from items where org_id = v_org and import_run = p_run;
  get diagnostics c = row_count; n := n || jsonb_build_object('items', c);

  delete from parties where org_id = v_org and import_run = p_run;
  get diagnostics c = row_count; n := n || jsonb_build_object('parties', c);

  -- the default store has to stop pointing at a store that is going
  update orgs set default_godown_id = null
   where id = v_org and default_godown_id in (
     select m.new from restore_maps m where m.run = p_run and m.kind = 'godown');

  delete from godowns where org_id = v_org and id in (
    select m.new from restore_maps m where m.run = p_run and m.kind = 'godown');
  get diagnostics c = row_count; n := n || jsonb_build_object('godowns', c);

  delete from bank_accounts where org_id = v_org and id in (
    select m.new from restore_maps m where m.run = p_run and m.kind = 'bank');
  get diagnostics c = row_count; n := n || jsonb_build_object('bank_accounts', c);

  -- AND THE MONEY MOVED BETWEEN THE TILL AND THE BANK.
  -- Left behind, a restore would put the deposits back on top of the ones
  -- already there and bank his takings twice.
  delete from cash_moves where org_id = v_org;

  delete from restore_maps where run = p_run and org_id = v_org;

  update import_runs
     set undone_at = now(),
         undo_note = 'A restore that did not finish, taken back out'
   where id = p_run and org_id = v_org;

  return jsonb_build_object('run', p_run, 'removed', n);
end
$rc$;

revoke all on function public.book_restore_clear(uuid) from public;
grant execute on function public.book_restore_clear(uuid) to authenticated;

create or replace function public.book_restore_slice(p_run uuid, p_table text, p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $rp$
declare
  v_org uuid := my_org_id();
  r     import_runs%rowtype;
  c     int := 0;
begin
  perform assert_can_write();
  if v_org is null then raise exception 'This login is not linked to a firm yet'; end if;
  if my_role() <> 'owner' then
    raise exception 'Only the owner can put a book back';
  end if;

  select * into r from import_runs where id = p_run and org_id = v_org and kind = 'backup';
  if not found then raise exception 'That restore is not one of yours'; end if;
  if r.done_at is not null then raise exception 'That restore has already finished'; end if;
  if r.undone_at is not null then raise exception 'That restore was taken back out'; end if;

  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'A page of a book has to be a list of rows';
  end if;
  if jsonb_array_length(p_rows) = 0 then
    return jsonb_build_object('table', p_table, 'put_back', 0);
  end if;

  -- THE ROWS THAT OTHER ROWS POINT AT get their new ids first, so that
  -- anything on this same page pointing at them already resolves.
  if p_table in ('godowns','bank_accounts','parties','items','vouchers') then
    insert into restore_maps (run, org_id, kind, old, new)
    select p_run, v_org,
           case p_table when 'godowns' then 'godown' when 'bank_accounts' then 'bank'
                        when 'parties' then 'party'  when 'items' then 'item'
                        else 'voucher' end,
           (e->>'id')::uuid, gen_random_uuid()
      from jsonb_array_elements(p_rows) e
     where nullif(e->>'id','') is not null
    on conflict (run, kind, old) do nothing;
  end if;

  if p_table = 'godowns' then
    insert into godowns (id, org_id, name, is_main, import_run)
    select m.new, v_org, e->>'name', coalesce((e->>'is_main')::boolean, false), p_run
      from jsonb_array_elements(p_rows) e
      join restore_maps m on m.run = p_run and m.kind = 'godown' and m.old = (e->>'id')::uuid;

  elsif p_table = 'bank_accounts' then
    insert into bank_accounts (id, org_id, name, opening, opening_on, is_default, is_active)
    select m.new, v_org, e->>'name', coalesce((e->>'opening')::numeric, 0),
           nullif(e->>'opening_on','')::date,
           coalesce((e->>'is_default')::boolean, false),
           coalesce((e->>'is_active')::boolean, true)
      from jsonb_array_elements(p_rows) e
      join restore_maps m on m.run = p_run and m.kind = 'bank' and m.old = (e->>'id')::uuid;

  elsif p_table = 'parties' then
    insert into parties
    select (jsonb_populate_record(null::parties,
              e || jsonb_build_object('id', m.new, 'org_id', v_org, 'import_run', p_run))).*
      from jsonb_array_elements(p_rows) e
      join restore_maps m on m.run = p_run and m.kind = 'party' and m.old = (e->>'id')::uuid;

  elsif p_table = 'items' then
    insert into items
    select (jsonb_populate_record(null::items,
              e || jsonb_build_object('id', m.new, 'org_id', v_org, 'import_run', p_run))).*
      from jsonb_array_elements(p_rows) e
      join restore_maps m on m.run = p_run and m.kind = 'item' and m.old = (e->>'id')::uuid;

  elsif p_table = 'item_parts' then
    insert into item_parts (org_id, parent_id, child_id, qty)
    select v_org, mp.new, mc.new, coalesce((e->>'qty')::numeric, 0)
      from jsonb_array_elements(p_rows) e
      join restore_maps mp on mp.run = p_run and mp.kind = 'item'
                          and mp.old = (e->>'parent_id')::uuid
      join restore_maps mc on mc.run = p_run and mc.kind = 'item'
                          and mc.old = (e->>'child_id')::uuid
    on conflict do nothing;

  elsif p_table = 'standing_items' then
    insert into standing_items (org_id, name, kind, amount, note, as_on)
    select v_org, e->>'name', e->>'kind', coalesce((e->>'amount')::numeric, 0),
           nullif(e->>'note',''), nullif(e->>'as_on','')::date
      from jsonb_array_elements(p_rows) e;

  elsif p_table = 'expense_heads' then
    insert into expense_heads (org_id, head, used)
    select v_org, e->>'head', coalesce((e->>'used')::int, 1)
      from jsonb_array_elements(p_rows) e
    on conflict do nothing;

  elsif p_table = 'invoice_series' then
    insert into invoice_series (org_id, kind, fy, next_no)
    select v_org, e->>'kind', e->>'fy', coalesce((e->>'next_no')::int, 1)
      from jsonb_array_elements(p_rows) e
    on conflict (org_id, kind, fy) do update set next_no = excluded.next_no;

  elsif p_table = 'vouchers' then
    -- A CREDIT NOTE POINTS AT THE BILL IT CANCELS, and that bill may not have
    -- arrived yet -- it could be on the next page. So what it points at is
    -- remembered here and tied on at the end, once every bill is in.
    insert into restore_maps (run, org_id, kind, old, new)
    select p_run, v_org, 'vref', (e->>'id')::uuid, (e->>'ref_voucher_id')::uuid
      from jsonb_array_elements(p_rows) e
     where nullif(e->>'ref_voucher_id','') is not null
    on conflict (run, kind, old) do nothing;

    insert into vouchers
    select (jsonb_populate_record(null::vouchers,
              e || jsonb_build_object(
                'id', m.new, 'org_id', v_org, 'import_run', p_run,
                'ref_voucher_id', null,
                'party_id', (select mm.new from restore_maps mm
                              where mm.run = p_run and mm.kind = 'party'
                                and mm.old = nullif(e->>'party_id','')::uuid),
                'godown_id', (select mm.new from restore_maps mm
                              where mm.run = p_run and mm.kind = 'godown'
                                and mm.old = nullif(e->>'godown_id','')::uuid)))).*
      from jsonb_array_elements(p_rows) e
      join restore_maps m on m.run = p_run and m.kind = 'voucher' and m.old = (e->>'id')::uuid;

  elsif p_table = 'voucher_lines' then
    insert into voucher_lines
    select (jsonb_populate_record(null::voucher_lines,
              e || jsonb_build_object(
                'id', gen_random_uuid(), 'org_id', v_org,
                'voucher_id', mv.new,
                'item_id', (select mm.new from restore_maps mm
                             where mm.run = p_run and mm.kind = 'item'
                               and mm.old = nullif(e->>'item_id','')::uuid),
                'godown_id', (select mm.new from restore_maps mm
                             where mm.run = p_run and mm.kind = 'godown'
                               and mm.old = nullif(e->>'godown_id','')::uuid)))).*
      from jsonb_array_elements(p_rows) e
      join restore_maps mv on mv.run = p_run and mv.kind = 'voucher'
                          and mv.old = (e->>'voucher_id')::uuid;

  elsif p_table = 'payments' then
    insert into payments
    select (jsonb_populate_record(null::payments,
              e || jsonb_build_object(
                'id', gen_random_uuid(), 'org_id', v_org, 'import_run', p_run,
                'party_id', (select mm.new from restore_maps mm
                              where mm.run = p_run and mm.kind = 'party'
                                and mm.old = nullif(e->>'party_id','')::uuid),
                'account_id', (select mm.new from restore_maps mm
                              where mm.run = p_run and mm.kind = 'bank'
                                and mm.old = nullif(e->>'account_id','')::uuid),
                'ref_voucher_id', (select mm.new from restore_maps mm
                              where mm.run = p_run and mm.kind = 'voucher'
                                and mm.old = nullif(e->>'ref_voucher_id','')::uuid)))).*
      from jsonb_array_elements(p_rows) e;

  elsif p_table = 'expenses' then
    insert into expenses
    select (jsonb_populate_record(null::expenses,
              e || jsonb_build_object(
                'id', gen_random_uuid(), 'org_id', v_org,
                'party_id', (select mm.new from restore_maps mm
                              where mm.run = p_run and mm.kind = 'party'
                                and mm.old = nullif(e->>'party_id','')::uuid),
                'account_id', (select mm.new from restore_maps mm
                              where mm.run = p_run and mm.kind = 'bank'
                                and mm.old = nullif(e->>'account_id','')::uuid)))).*
      from jsonb_array_elements(p_rows) e;

  elsif p_table = 'stock_moves' then
    insert into stock_moves
    select (jsonb_populate_record(null::stock_moves,
              e || jsonb_build_object(
                'id', gen_random_uuid(), 'org_id', v_org, 'import_run', p_run,
                'item_id', (select mm.new from restore_maps mm
                             where mm.run = p_run and mm.kind = 'item'
                               and mm.old = nullif(e->>'item_id','')::uuid),
                'godown_id', (select mm.new from restore_maps mm
                             where mm.run = p_run and mm.kind = 'godown'
                               and mm.old = nullif(e->>'godown_id','')::uuid),
                'ref_voucher_id', (select mm.new from restore_maps mm
                             where mm.run = p_run and mm.kind = 'voucher'
                               and mm.old = nullif(e->>'ref_voucher_id','')::uuid)))).*
      from jsonb_array_elements(p_rows) e;

  elsif p_table = 'cash_moves' then
    -- The account it went into has a NEW id in the firm being restored into,
    -- so it is looked up in the map like every other reference. Without that
    -- the deposit lands against an account that belongs to nobody.
    insert into cash_moves
    select (jsonb_populate_record(null::cash_moves,
              e || jsonb_build_object(
                'id', gen_random_uuid(), 'org_id', v_org, 'import_run', p_run,
                'account_id', (select mm.new from restore_maps mm
                              where mm.run = p_run and mm.kind = 'bank'
                                and mm.old = nullif(e->>'account_id','')::uuid)))).*
      from jsonb_array_elements(p_rows) e;

  else
    raise exception 'There is no % in a Skwik book', p_table;
  end if;

  get diagnostics c = row_count;

  update import_runs
     set counts = coalesce(counts, '{}'::jsonb)
                  || jsonb_build_object(p_table,
                       coalesce((counts->>p_table)::int, 0) + c)
   where id = p_run and org_id = v_org;

  return jsonb_build_object('table', p_table, 'put_back', c);
end
$rp$;

revoke all on function public.book_restore_slice(uuid, text, jsonb) from public;
grant execute on function public.book_restore_slice(uuid, text, jsonb) to authenticated;


-- ---------------------------------------------------------------------------
--  UNDOING AN IMPORT HAS TO TAKE THE DEPOSITS WITH IT
--
--  Reprinted whole with cash_moves added; nothing else changed.
-- ---------------------------------------------------------------------------

create or replace function public.import_undo(p_run uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $undo$
declare
  v_org  uuid := my_org_id();
  r      import_runs%rowtype;
  v_lock date;
  plan   jsonb;
  n_v int := 0; n_p int := 0; n_m int := 0; n_i int := 0; n_n int := 0;
  n_c int := 0;   -- money banked, or taken back out of the bank
  none  uuid := '00000000-0000-0000-0000-000000000000'::uuid;
begin
  perform assert_can_write();
  if v_org is null then raise exception 'This login is not linked to a firm yet'; end if;
  if my_role() <> 'owner' then
    raise exception 'Only the owner can take an import back out';
  end if;

  select * into r from import_runs where id = p_run and org_id = v_org;
  if not found then raise exception 'That import is not in your books'; end if;
  if r.undone_at is not null then
    return jsonb_build_object('already', true, 'undone_at', r.undone_at);
  end if;

  plan := import_undo_plan(p_run);
  select books_locked_upto into v_lock from orgs where id = v_org;

  -- BILLS. Their lines and their stock go with them, and so does the receipt
  -- the bill raised itself. A receipt he had entered by hand and tied to the
  -- bill afterwards is untied and left alone -- it is his money, not ours.
  create temporary table _going on commit drop as
    select id from vouchers
     where import_run = p_run and org_id = v_org
       and (v_lock is null or vdate > v_lock)
       and not exists (select 1 from vouchers c where c.org_id = v_org
                        and c.ref_voucher_id = vouchers.id
                        and coalesce(c.import_run, none) <> p_run);

  update payments set ref_voucher_id = null
   where org_id = v_org and ref_voucher_id in (select id from _going)
     and not coalesce(from_voucher, false);
  delete from payments
   where org_id = v_org and ref_voucher_id in (select id from _going)
     and coalesce(from_voucher, false);
  delete from stock_moves   where org_id = v_org and ref_voucher_id in (select id from _going);
  delete from voucher_lines where org_id = v_org and voucher_id    in (select id from _going);
  delete from vouchers      where org_id = v_org and id            in (select id from _going);
  get diagnostics n_v = row_count;

  -- MONEY the import brought in on its own
  delete from payments
   where import_run = p_run and org_id = v_org
     and (v_lock is null or pdate > v_lock);
  get diagnostics n_p = row_count;

  -- AND THE MONEY HE BANKED, which belongs to no bill either.
  -- Left behind, undoing an import would take away the bills that explained
  -- the deposits and leave the cash and bank figures adrift by the whole
  -- amount, with nothing on any screen to say why.
  delete from cash_moves
   where import_run = p_run and org_id = v_org
     and (v_lock is null or mdate > v_lock);
  get diagnostics n_c = row_count;

  -- GOODS MOVED BETWEEN STORES, which belong to no bill
  delete from stock_moves
   where import_run = p_run and org_id = v_org and ref_voucher_id is null
     and (v_lock is null or mdate > v_lock);
  get diagnostics n_m = row_count;

  -- ITEMS AND NAMES, only where nothing he wrote himself uses them
  delete from items i
   where i.import_run = p_run and i.org_id = v_org
     and not exists (select 1 from voucher_lines l where l.item_id = i.id)
     and not exists (select 1 from stock_moves m where m.item_id = i.id)
     and not exists (select 1 from item_parts ip where ip.child_id = i.id or ip.parent_id = i.id);
  get diagnostics n_i = row_count;

  delete from parties p
   where p.import_run = p_run and p.org_id = v_org
     and not exists (select 1 from vouchers v where v.party_id = p.id)
     and not exists (select 1 from payments y where y.party_id = p.id);
  get diagnostics n_n = row_count;

  update import_runs
     set undone_at = now(),
         undo_note = format('%s bills, %s money entries, %s banked, %s movements, %s items, %s names',
                            n_v, n_p, n_c, n_m, n_i, n_n)
   where id = p_run and org_id = v_org;

  return jsonb_build_object('already', false,
    'removed', jsonb_build_object('bills', n_v, 'money', n_p, 'banked', n_c,
                                  'moves', n_m, 'items', n_i, 'names', n_n),
    'stays', plan->'stays');
end
$undo$;

revoke all on function public.import_undo(uuid) from public;
grant execute on function public.import_undo(uuid) to authenticated;


-- ---------------------------------------------------------------------------
--  A RESTORE THAT KEEPS THE WHOLE FIRM, NOT MOST OF IT
--
--  Found while testing the deposits, and nothing to do with them: the list of
--  settings a restore copies was written by hand and had fallen thirty-five
--  columns behind the table. Reprinted whole, with that list replaced by one
--  read from the table itself.
-- ---------------------------------------------------------------------------

create or replace function public.book_restore_end(p_run uuid, p_head jsonb default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $re$
declare
  v_org uuid := my_org_id();
  r     import_runs%rowtype;
  o     jsonb;
  n_ref int := 0;
  v_sets text;
begin
  perform assert_can_write();
  if v_org is null then raise exception 'This login is not linked to a firm yet'; end if;
  if my_role() <> 'owner' then
    raise exception 'Only the owner can put a book back';
  end if;

  select * into r from import_runs where id = p_run and org_id = v_org and kind = 'backup';
  if not found then raise exception 'That restore is not one of yours'; end if;
  if r.done_at is not null then
    return jsonb_build_object('already', true, 'put_back', r.counts);
  end if;

  -- a credit note, tied to the bill it cancels
  update vouchers v
     set ref_voucher_id = mt.new
    from restore_maps vr
    join restore_maps ms on ms.run = p_run and ms.kind = 'voucher' and ms.old = vr.old
    join restore_maps mt on mt.run = p_run and mt.kind = 'voucher' and mt.old = vr.new
   where vr.run = p_run and vr.kind = 'vref'
     and v.id = ms.new and v.org_id = v_org;
  get diagnostics n_ref = row_count;

  -- the firm's own settings, without touching who owns it or its code
  o := coalesce(p_head->'org', '{}'::jsonb);
  if o <> '{}'::jsonb then
    -- EVERY SETTING, NOT THE TWENTY SOMEBODY REMEMBERED.
    --
    -- This was a hand-written list of columns, and it had fallen thirty-five
    -- behind the table. A restore onto a new phone silently dropped the
    -- opening cash (so the cash book began at nil and every figure after it
    -- was short by the same amount), the date the books were closed up to (so
    -- closed months reopened), the shop's address and phone (printed on every
    -- bill), the credit note, debit note and estimate numbering, and every one
    -- of the Tally ledger names.
    --
    -- So the columns are read from the table itself now and all of them are
    -- copied but the few that must NOT be -- which means a column added next
    -- year is carried without anyone having to remember this function exists.
    select string_agg(format('%1$I = case when $1 ? %2$L then ($1->>%2$L)::%3$s else t.%1$I end',
                             c.column_name, c.column_name,
                             format_type(a.atttypid, a.atttypmod)), ', ')
      into v_sets
      from information_schema.columns c
      join pg_attribute a on a.attrelid = 'public.orgs'::regclass
                         and a.attname = c.column_name
     where c.table_schema = 'public' and c.table_name = 'orgs'
       and c.column_name not in (
         -- WHOSE FIRM THIS IS never comes out of a file
         'id', 'owner_id', 'created_at',
         -- nor who may join it
         'join_code', 'join_open', 'join_open_until',
         -- and a paid subscription is not something a backup file can grant
         'plan', 'paid_until', 'trial_ends_at',
         -- this one needs the map, and is done by hand below
         'default_godown_id');

    execute format('update orgs t set %s where t.id = $2', v_sets) using o, v_org;

    -- and the store, which has a new id in this firm
    update orgs t
       set default_godown_id = coalesce(
             (select mm.new from restore_maps mm
               where mm.run = p_run and mm.kind = 'godown'
                 and mm.old = nullif(o->>'default_godown_id','')::uuid),
             t.default_godown_id)
     where t.id = v_org;
  end if;

  update import_runs
     set done_at = now(),
         counts = coalesce(counts, '{}'::jsonb) || jsonb_build_object('notes_tied', n_ref)
   where id = p_run and org_id = v_org
  returning * into r;

  -- the scaffolding comes down
  delete from restore_maps where run = p_run and org_id = v_org;

  return jsonb_build_object('run', p_run, 'put_back', r.counts);
end
$re$;

revoke all on function public.book_restore_end(uuid, jsonb) from public;
grant execute on function public.book_restore_end(uuid, jsonb) to authenticated;
