-- ===========================================================================
--  1.10.2  A BOOK TOO BIG FOR ONE BREATH.
--
--  1.10.0 gave a shop its whole book in one file, and one call: book_backup()
--  builds the lot and hands it over. Measured on a shop with two years in it
--  -- 24,090 bills, 96,360 lines, 96,360 stock movements -- that one call is
--  105 MB, six seconds on the server, and about 340 MB of phone memory to
--  turn into a file. A cheap Android gives one app rather less than that, and
--  when it runs out it does not slow down, it dies:
--
--      java.lang.OutOfMemoryError: Failed to allocate
--
--  Which is exactly how his Tally import died, for the same reason.
--
--  So: the same book, asked for and put back a page at a time. Nothing is
--  ever held but the page in hand. Measured on the same two-year shop:
--
--      all at once ........... 337 MB
--      a page at a time ....... 0.6 MB    same 105 MB file, same rows
--      and putting it back .... 1.5 MB
--
--  Those are swept figures -- what is still HELD, not what has been allocated
--  and not yet collected. The unswept numbers are 28 MB and 33 MB, which are
--  also fine, and the difference is garbage rather than anything we keep.
--
--  WHAT IS IN HERE
--    book_head()           what shop this is, and how much there is of it
--    book_slice()          one table, one page, oldest first
--    book_restore_clear()  a restore that stopped half way, taken back out
--    book_restore_begin()  an empty firm, ready to receive
--    book_restore_slice()  one page of rows back in
--    book_restore_end()    the last knots tied: the settings, the references
--
--  book_backup() and book_restore() from 1.10.0 are left exactly as they are.
--  A file taken out last week still goes back in, and a small shop that
--  finishes in one breath has no reason to take ten.
--
--  WHY A RESTORE CANNOT KEEP ITS MAP IN MEMORY.
--  Putting a book back means giving every row a new id -- an id is unique
--  across the whole of Skwik, so the old ones are already taken -- and then
--  rewriting every reference through a map of old to new. In one call that
--  map is a temporary table and it dies with the call. Spread across two
--  hundred calls it has to outlive them, so it is a real table here, one row
--  per row restored, thrown away when the restore finishes.
--
--  SAFE TO RUN TWICE.
-- ===========================================================================


-- ---------------------------------------------------------------------------
--  1. WHAT SHOP IS THIS, AND HOW MUCH OF IT IS THERE
-- ---------------------------------------------------------------------------
--  Asked first, so the phone can write the top of the file, show a bar that
--  means something, and tell him what he is about to wait for.
--
--  The firm's own row comes from here rather than from a plain select for one
--  reason: the join code goes out of it. That code lets a phone walk into
--  this shop's books. A backup file is mailed to accountants and left in
--  WhatsApp, and it has no business carrying the key to the shop.

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
      'stock_moves',    (select count(*) from stock_moves    where org_id = v_org)),
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


-- ---------------------------------------------------------------------------
--  2. ONE TABLE AT A TIME, A PAGE AT A TIME
-- ---------------------------------------------------------------------------
--  `p_year` narrows the dated tables to one financial year (2026 means April
--  2026 to March 2027) for the shops where even the pages add up to more than
--  a phone wants to carry about. The lists a book needs to make sense of
--  itself -- its items, its names, its stores -- always come whole, or a bill
--  in the file would point at a customer who is not in it.

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
                     'vouchers','voucher_lines','payments','expenses','stock_moves') then
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


-- ---------------------------------------------------------------------------
--  3. THE MAP A RESTORE KEEPS WHILE IT RUNS
-- ---------------------------------------------------------------------------
--  old id -> new id, one row per row put back. Nobody reads this but the
--  three functions below: row security is on and there is no policy, and no
--  grant, so a phone cannot see it or write to it at all.

create table if not exists public.restore_maps (
  run    uuid not null references public.import_runs(id) on delete cascade,
  org_id uuid not null references public.orgs(id) on delete cascade,
  kind   text not null,                 -- godown | bank | party | item | voucher | vref
  old    uuid not null,
  new    uuid not null,
  primary key (run, kind, old)
);

alter table public.restore_maps enable row level security;

create index if not exists restore_maps_by_run on public.restore_maps (run);


-- ---------------------------------------------------------------------------
--  4. TAKING A HALF-FINISHED RESTORE BACK OUT
-- ---------------------------------------------------------------------------
--  A restore spread over two hundred calls can stop in the middle: the phone
--  slept, the signal went, the app was killed. What went in is real, and it
--  would make the firm "not empty" and lock him out of ever trying again. So
--  it has to come out, exactly, and nothing else with it.
--
--  WHY NOT import_undo, which already exists. Because it was written for a
--  Tally import and takes out what a Tally import writes -- bills, money,
--  stock, items, names. A restore also writes bank accounts, expenses,
--  opening balances, stores and what items are made of, and undo leaves every
--  one of them behind to be written a second time on the next try. Measured on
--  a shop that had them: undo left the bank accounts and the expenses, and the
--  retry doubled them.
--
--  HOW IT KNOWS WHAT IS THE RESTORE'S AND WHAT IS HIS. Two ways, and between
--  them they cover every table:
--
--    the map        every store, bank, name, item and bill it put in is in
--                   restore_maps by its new id. That is exact.
--    the firm was
--    empty          book_restore_begin refuses unless the firm has nothing in
--                   it. So if a run exists, the firm WAS empty when it
--                   started, and anything in the few tables the map does not
--                   cover -- expenses, opening balances -- got there from this
--                   restore and from nothing else.
--
--  Expense heads and bill-number series are left alone: they go in with "on
--  conflict do nothing" and "do update", so a second try writes over them
--  rather than beside them, and there is nothing to clean.

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


-- ---------------------------------------------------------------------------
--  5. AN EMPTY FIRM, READY TO RECEIVE
-- ---------------------------------------------------------------------------
--  A restore goes into a firm with nothing in it, and says so rather than
--  trying to be clever. On top of a book that already has bills in it, a
--  restore would have to decide what wins for every row, and there is no
--  answer to that which is safe.
--
--  "Nothing in it" is checked properly here rather than taken on trust, and
--  not only because it is the honest thing: the clear above leans on it. If a
--  firm could have his own expenses in it when a restore started, the clear
--  could not know whose they were.
--
--  Stores, expense heads and bill-number series are allowed to be there
--  already. A new firm makes itself a store, and the other two are written
--  over rather than beside.

create or replace function public.book_restore_begin(p_head jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $rb$
declare
  v_org uuid := my_org_id();
  v_run uuid;
  r     record;
  n_gone int := 0;
  cleared jsonb := '{}'::jsonb;
  busy   text;
begin
  perform assert_can_write();
  if v_org is null then raise exception 'This login is not linked to a firm yet'; end if;
  if my_role() <> 'owner' then
    raise exception 'Only the owner can put a book back';
  end if;
  if coalesce((p_head->>'skwik_backup')::int, 0) not in (1, 2) then
    raise exception 'That is not a Skwik backup file';
  end if;

  -- A restore that never finished, taken back out so this one can start clean.
  for r in select id from import_runs
            where org_id = v_org and kind = 'backup'
              and done_at is null and undone_at is null
            order by started_at
  loop
    cleared := book_restore_clear(r.id);
    n_gone := n_gone + 1;
  end loop;

  busy := nullif(concat_ws(', ',
    case when exists (select 1 from vouchers       where org_id = v_org) then 'bills' end,
    case when exists (select 1 from payments       where org_id = v_org) then 'money entries' end,
    case when exists (select 1 from parties        where org_id = v_org) then 'customers' end,
    case when exists (select 1 from items          where org_id = v_org) then 'items' end,
    case when exists (select 1 from expenses       where org_id = v_org) then 'expenses' end,
    case when exists (select 1 from standing_items where org_id = v_org) then 'opening balances' end,
    case when exists (select 1 from bank_accounts  where org_id = v_org) then 'bank accounts' end
  ), '');
  if busy is not null then
    raise exception 'This firm already has % in it. A backup goes into a firm with nothing in it, so that nothing you have written can be written over. Make a new firm and put it there.', busy;
  end if;

  insert into import_runs (org_id, kind, note)
  values (v_org, 'backup', 'A whole book put back, a page at a time')
  returning id into v_run;

  return jsonb_build_object('run', v_run,
                            'cleared_unfinished', n_gone,
                            'cleared', cleared);
end
$rb$;

revoke all on function public.book_restore_begin(jsonb) from public;
grant execute on function public.book_restore_begin(jsonb) to authenticated;


-- ---------------------------------------------------------------------------
--  6. ONE PAGE OF ROWS, BACK IN
-- ---------------------------------------------------------------------------
--  The pages arrive in the order the references need them: stores, banks,
--  names and goods first, then what goods are made of, then the bills, then
--  their lines, then the money and the stock. Each page is given fresh ids,
--  the map remembers them, and every reference on the page is rewritten
--  through the map -- including references to rows that came in pages ago,
--  which is the whole reason the map is a table and not a variable.
--
--  NOTE WHAT IS NOT HERE: any statement of the shape "where org_id is not
--  mine". This function is SECURITY DEFINER, so row security does not apply
--  inside it, and a tidy-up like that would have reached across every other
--  shop in the database. Each row is stamped with this firm as it goes in.

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
--  7. THE LAST KNOTS
-- ---------------------------------------------------------------------------
--  What could not be done until everything was in: a credit note tied to the
--  bill it cancels, the firm's own settings, and which store is the default
--  one. Then the map is thrown away -- it was scaffolding, and a book with
--  two years in it leaves 130,000 rows of it behind if nobody sweeps.

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
    update orgs t set
        name = coalesce(o->>'name', t.name),
        gstin = o->>'gstin',
        is_gst_registered = coalesce((o->>'is_gst_registered')::boolean, t.is_gst_registered),
        is_composition = coalesce((o->>'is_composition')::boolean, t.is_composition),
        state_code = coalesce(o->>'state_code', t.state_code),
        state_name = coalesce(o->>'state_name', t.state_name),
        mode = coalesce(o->>'mode', t.mode),
        invoice_prefix = coalesce(o->>'invoice_prefix', t.invoice_prefix),
        stock_enabled = coalesce((o->>'stock_enabled')::boolean, t.stock_enabled),
        godowns_enabled = coalesce((o->>'godowns_enabled')::boolean, t.godowns_enabled),
        batch_enabled = coalesce((o->>'batch_enabled')::boolean, t.batch_enabled),
        expiry_enabled = coalesce((o->>'expiry_enabled')::boolean, t.expiry_enabled),
        variants_enabled = coalesce((o->>'variants_enabled')::boolean, t.variants_enabled),
        making_enabled = coalesce((o->>'making_enabled')::boolean, t.making_enabled),
        show_purchase = coalesce((o->>'show_purchase')::boolean, t.show_purchase),
        show_returns = coalesce((o->>'show_returns')::boolean, t.show_returns),
        show_reports = coalesce((o->>'show_reports')::boolean, t.show_reports),
        show_transfer = coalesce((o->>'show_transfer')::boolean, t.show_transfer),
        show_expenses = coalesce((o->>'show_expenses')::boolean, t.show_expenses),
        show_recon = coalesce((o->>'show_recon')::boolean, t.show_recon),
        price1_name = coalesce(o->>'price1_name', t.price1_name),
        price2_name = coalesce(o->>'price2_name', t.price2_name),
        default_godown_id = coalesce(
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
