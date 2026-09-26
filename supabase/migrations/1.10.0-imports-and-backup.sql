-- ===========================================================================
--  1.10.0  AN IMPORT YOU CAN TAKE BACK OUT, AND A BOOK YOU CAN TAKE WITH YOU.
--
--  Two things a shop needs before it will trust an app with its books.
--
--  UNDO. An import writes hundreds of rows in one press. If it goes in wrong
--  -- the wrong file, the wrong period, a duplicate of last week's -- there
--  has been no way to get it out again except by hand, one bill at a time,
--  which is not a way at all. Since 1.9.44 every movement an import writes
--  has carried a mark saying what brought it in; this finishes the thought:
--  every row an import writes now carries the same mark, and one press takes
--  the whole run back out.
--
--  TAKING THE BOOK OUT. A shop pays for Skwik by the year. It has to be able
--  to leave with everything it has written, in a form that can be put back --
--  not a report, the data. That is right on its own, and it is the first
--  thing a careful buyer asks.
--
--  WHAT UNDO WILL NOT DO, and says so rather than doing it quietly:
--    - touch a month he has closed
--    - remove a bill that a credit note has since been raised against
--    - remove an item or a name that something he wrote himself now uses
--
--  SAFE TO RUN TWICE.
-- ===========================================================================


-- ---------------------------------------------------------------------------
--  1. A RUN, AND THE MARK EVERY ROW CARRIES
-- ---------------------------------------------------------------------------

create table if not exists public.import_runs (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references public.orgs(id) on delete cascade,
  kind       text not null,                 -- 'daybook' | 'masters' | 'sheet' | 'backup'
  note       text,                          -- 'Tally day book · 1 Apr to 31 Aug'
  counts     jsonb not null default '{}'::jsonb,
  started_at timestamptz not null default now(),
  done_at    timestamptz,
  undone_at  timestamptz,
  undo_note  text
);

create index if not exists import_runs_by_org
  on public.import_runs (org_id, started_at desc);

alter table public.import_runs enable row level security;

do $c$
begin
  if not exists (select 1 from pg_policies
                  where tablename = 'import_runs' and policyname = 'import_runs_own_org') then
    create policy import_runs_own_org on public.import_runs
      for all using (org_id = my_org_id()) with check (org_id = my_org_id());
  end if;
end
$c$;

grant select, insert, update on public.import_runs to authenticated;

-- The mark itself, on everything an import can write.
alter table public.parties     add column if not exists import_run uuid references public.import_runs(id) on delete set null;
alter table public.items       add column if not exists import_run uuid references public.import_runs(id) on delete set null;
alter table public.vouchers    add column if not exists import_run uuid references public.import_runs(id) on delete set null;
alter table public.payments    add column if not exists import_run uuid references public.import_runs(id) on delete set null;
alter table public.stock_moves add column if not exists import_run uuid references public.import_runs(id) on delete set null;
alter table public.godowns     add column if not exists import_run uuid references public.import_runs(id) on delete set null;

create index if not exists vouchers_by_import  on public.vouchers    (import_run) where import_run is not null;
create index if not exists payments_by_import  on public.payments    (import_run) where import_run is not null;
create index if not exists moves_by_import     on public.stock_moves (import_run) where import_run is not null;
create index if not exists items_by_import     on public.items       (import_run) where import_run is not null;
create index if not exists parties_by_import   on public.parties     (import_run) where import_run is not null;


-- ---------------------------------------------------------------------------
--  2. STARTING A RUN, AND FINISHING IT
-- ---------------------------------------------------------------------------

create or replace function public.import_begin(p_kind text, p_note text default null)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $beg$
declare v_org uuid := my_org_id(); v_id uuid;
begin
  perform assert_can_write();
  if v_org is null then raise exception 'This login is not linked to a firm yet'; end if;
  if coalesce(p_kind,'') not in ('daybook','masters','sheet','backup') then
    raise exception 'Unknown kind of import: %', p_kind;
  end if;
  insert into import_runs (org_id, kind, note) values (v_org, p_kind, nullif(btrim(p_note),''))
  returning id into v_id;
  return v_id;
end
$beg$;

create or replace function public.import_end(p_run uuid, p_counts jsonb default '{}'::jsonb)
returns void
language plpgsql
security definer
set search_path to 'public'
as $end$
declare v_org uuid := my_org_id();
begin
  perform assert_can_write();
  update import_runs set done_at = now(), counts = coalesce(p_counts, '{}'::jsonb)
   where id = p_run and org_id = v_org;
end
$end$;

revoke all on function public.import_begin(text, text) from public;
revoke all on function public.import_end(uuid, jsonb) from public;
grant execute on function public.import_begin(text, text) to authenticated;
grant execute on function public.import_end(uuid, jsonb) to authenticated;


-- ---------------------------------------------------------------------------
--  3. WHAT WOULD HAPPEN IF HE PRESSED UNDO
-- ---------------------------------------------------------------------------
--  Asked BEFORE anything is removed, so the question on screen can say what
--  will go and what will stay, in figures rather than in hope.

create or replace function public.import_undo_plan(p_run uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $plan$
declare
  v_org  uuid := my_org_id();
  r      import_runs%rowtype;
  v_lock date;
  n_v int; n_p int; n_m int; n_i int; n_n int;
  k_locked int; k_noted int; k_used_i int; k_used_n int;
begin
  if v_org is null then raise exception 'This login is not linked to a firm yet'; end if;
  select * into r from import_runs where id = p_run and org_id = v_org;
  if not found then raise exception 'That import is not in your books'; end if;

  select books_locked_upto into v_lock from orgs where id = v_org;

  -- bills in a month he has closed, and bills a credit note now points at
  select count(*) into k_locked from vouchers
   where import_run = p_run and org_id = v_org
     and v_lock is not null and vdate <= v_lock;

  select count(*) into k_noted from vouchers v
   where v.import_run = p_run and v.org_id = v_org
     and exists (select 1 from vouchers c
                  where c.org_id = v_org and c.ref_voucher_id = v.id
                    and coalesce(c.import_run, '00000000-0000-0000-0000-000000000000'::uuid) <> p_run);

  select count(*) into n_v from vouchers
   where import_run = p_run and org_id = v_org
     and (v_lock is null or vdate > v_lock)
     and not exists (select 1 from vouchers c where c.org_id = v_org
                      and c.ref_voucher_id = vouchers.id
                      and coalesce(c.import_run, '00000000-0000-0000-0000-000000000000'::uuid) <> p_run);

  -- the money the import brought in, PLUS the cash receipt each cash bill
  -- raised for itself, which goes when its bill goes
  select count(*) into n_p from payments y
   where y.org_id = v_org
     and (v_lock is null or y.pdate > v_lock)
     and (y.import_run = p_run
       or exists (select 1 from vouchers v4 where v4.id = y.ref_voucher_id
                    and v4.import_run = p_run and coalesce(y.from_voucher, false)));

  select count(*) into n_m from stock_moves
   where import_run = p_run and org_id = v_org
     and ref_voucher_id is null
     and (v_lock is null or mdate > v_lock);

  -- AN ITEM IS ONLY REMOVED WHEN NOTHING OUTSIDE THIS RUN USES IT -- and the
  -- count has to be worked out in the order the removal happens, or it lies.
  --
  -- A bill's own stock movements carry no run of their own: they belong to
  -- the bill, and they go when the bill goes. Counting them as "something
  -- else uses this item" held 175 of his 185 items back on paper while the
  -- undo itself removed all 185. A plan that does not match the act is worse
  -- than no plan, so the movements belonging to bills that are going are
  -- passed over here exactly as they are there.
  select count(*) into n_i from items i
   where i.import_run = p_run and i.org_id = v_org
     and not exists (select 1 from voucher_lines l join vouchers v on v.id = l.voucher_id
                      where l.item_id = i.id
                        and coalesce(v.import_run, '00000000-0000-0000-0000-000000000000'::uuid) <> p_run)
     and not exists (select 1 from stock_moves m where m.item_id = i.id
                      and coalesce(m.import_run, '00000000-0000-0000-0000-000000000000'::uuid) <> p_run
                      -- a movement a bill of this run made is not "somebody else"
                      and not exists (select 1 from vouchers v2
                                       where v2.id = m.ref_voucher_id and v2.import_run = p_run))
     and not exists (select 1 from item_parts ip where ip.child_id = i.id or ip.parent_id = i.id);

  select count(*) into k_used_i from items i
   where i.import_run = p_run and i.org_id = v_org;
  k_used_i := k_used_i - n_i;

  select count(*) into n_n from parties p
   where p.import_run = p_run and p.org_id = v_org
     and not exists (select 1 from vouchers v where v.party_id = p.id
                      and coalesce(v.import_run, '00000000-0000-0000-0000-000000000000'::uuid) <> p_run)
     and not exists (select 1 from payments y where y.party_id = p.id
                      and coalesce(y.import_run, '00000000-0000-0000-0000-000000000000'::uuid) <> p_run
                      -- and neither is the cash receipt a bill of this run raised itself
                      and not exists (select 1 from vouchers v3
                                       where v3.id = y.ref_voucher_id and v3.import_run = p_run));

  select count(*) into k_used_n from parties p
   where p.import_run = p_run and p.org_id = v_org;
  k_used_n := k_used_n - n_n;

  return jsonb_build_object(
    'run', p_run, 'kind', r.kind, 'note', r.note,
    'undone', r.undone_at is not null,
    'goes', jsonb_build_object('bills', n_v, 'money', n_p, 'moves', n_m,
                               'items', n_i, 'names', n_n),
    'stays', jsonb_build_object('locked_bills', k_locked, 'noted_bills', k_noted,
                                'used_items', k_used_i, 'used_names', k_used_n));
end
$plan$;

revoke all on function public.import_undo_plan(uuid) from public;
grant execute on function public.import_undo_plan(uuid) to authenticated;


-- ---------------------------------------------------------------------------
--  4. AND TAKING IT BACK OUT
-- ---------------------------------------------------------------------------
--  The same rules as the plan, applied. It returns what it actually removed,
--  which is what the screen then repeats back to him.

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
         undo_note = format('%s bills, %s money entries, %s movements, %s items, %s names',
                            n_v, n_p, n_m, n_i, n_n)
   where id = p_run and org_id = v_org;

  return jsonb_build_object('already', false,
    'removed', jsonb_build_object('bills', n_v, 'money', n_p, 'moves', n_m,
                                  'items', n_i, 'names', n_n),
    'stays', plan->'stays');
end
$undo$;

revoke all on function public.import_undo(uuid) from public;
grant execute on function public.import_undo(uuid) to authenticated;


-- ---------------------------------------------------------------------------
--  5. THE WHOLE BOOK, IN ONE FILE
-- ---------------------------------------------------------------------------
--
--  Everything the shop has written, in a shape Skwik can read back. Not a
--  report -- the rows themselves, with their own ids, so what goes back in is
--  what came out and every bill still points at the same customer.
--
--  It is the owner's, and only the owner's: it carries his customers' phone
--  numbers, his bank balances and what he owes.

create or replace function public.book_backup()
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $bk$
declare v_org uuid := my_org_id(); j jsonb;
begin
  if v_org is null then raise exception 'This login is not linked to a firm yet'; end if;
  if my_role() <> 'owner' then
    raise exception 'Only the owner can take a copy of the whole book';
  end if;

  select jsonb_build_object(
    'skwik_backup', 1,
    'taken_at', now(),
    'org', (select to_jsonb(o) - 'join_code' - 'join_open' - 'join_open_until'
              from orgs o where o.id = v_org),
    'godowns',       (select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) from godowns x where x.org_id = v_org),
    'bank_accounts', (select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) from bank_accounts x where x.org_id = v_org),
    'parties',       (select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) from parties x where x.org_id = v_org),
    'items',         (select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) from items x where x.org_id = v_org),
    'item_parts',    (select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) from item_parts x where x.org_id = v_org),
    'standing_items',(select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) from standing_items x where x.org_id = v_org),
    'expense_heads', (select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) from expense_heads x where x.org_id = v_org),
    'invoice_series',(select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) from invoice_series x where x.org_id = v_org),
    'vouchers',      (select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) from vouchers x where x.org_id = v_org),
    'voucher_lines', (select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) from voucher_lines x where x.org_id = v_org),
    'payments',      (select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) from payments x where x.org_id = v_org),
    'expenses',      (select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) from expenses x where x.org_id = v_org),
    'stock_moves',   (select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) from stock_moves x where x.org_id = v_org)
  ) into j;
  return j;
end
$bk$;

revoke all on function public.book_backup() from public;
grant execute on function public.book_backup() to authenticated;


-- ---------------------------------------------------------------------------
--  6. AND PUTTING IT BACK
-- ---------------------------------------------------------------------------
--
--  Into an EMPTY firm, and it says so rather than trying to be clever. A
--  restore on top of a book that already has bills in it would have to decide
--  what wins for every row, and there is no answer to that which is safe --
--  so a new firm is made, the file goes into it, and nothing anywhere is
--  overwritten. The ids come back as they were, so every bill still points at
--  the same customer and the same goods.
--
--  The rows go in in the order the references need: names and goods first,
--  then the bills, then their lines, then the money.

create or replace function public.book_restore(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $rs$
declare
  v_org  uuid := my_org_id();
  v_run  uuid;
  n      jsonb := '{}'::jsonb;
  c      int;
begin
  perform assert_can_write();
  if v_org is null then raise exception 'This login is not linked to a firm yet'; end if;
  if my_role() <> 'owner' then
    raise exception 'Only the owner can put a book back';
  end if;
  if coalesce((p->>'skwik_backup')::int, 0) <> 1 then
    raise exception 'That is not a Skwik backup file';
  end if;
  if exists (select 1 from vouchers where org_id = v_org)
     or exists (select 1 from payments where org_id = v_org) then
    raise exception 'This firm already has entries in it. A backup goes into a firm with nothing in it, so that nothing you have written can be written over. Make a new firm and put it there.';
  end if;

  insert into import_runs (org_id, kind, note)
  values (v_org, 'backup', 'A whole book put back')
  returning id into v_run;

  -- EVERY ROW COMES BACK WITH A NEW ID, AND THE REFERENCES ARE REBUILT.
  --
  -- The first try put the rows back under the ids they left with, which reads
  -- well and cannot work: an id is unique across the whole of Skwik, so if
  -- the firm the file came from still exists, every id in the file is already
  -- taken. The rows went in as no-ops and the bills then pointed at a
  -- customer belonging to somebody else's firm -- which a trigger caught, and
  -- which should never have been possible to write in the first place.
  --
  -- So every row is given a fresh id on the way in, a map of old to new is
  -- kept, and every reference is rewritten through it. The book comes back
  -- whole whether or not the firm it came from is still there.
  --
  -- And note what is NOT here: any statement of the shape "where org_id is
  -- not mine". This function is SECURITY DEFINER, so row security does not
  -- apply inside it, and a tidy-up like that would have reached across every
  -- other shop in the database. Each row is stamped with this firm as it goes
  -- in, one row at a time, and nothing in here can touch anybody else's.

  create temporary table _map (kind text, old uuid, new uuid) on commit drop;
  create index on _map (kind, old);

  insert into _map (kind, old, new)
  select 'godown', (e->>'id')::uuid, gen_random_uuid()
    from jsonb_array_elements(coalesce(p->'godowns', '[]'::jsonb)) e
  union all
  select 'bank', (e->>'id')::uuid, gen_random_uuid()
    from jsonb_array_elements(coalesce(p->'bank_accounts', '[]'::jsonb)) e
  union all
  select 'party', (e->>'id')::uuid, gen_random_uuid()
    from jsonb_array_elements(coalesce(p->'parties', '[]'::jsonb)) e
  union all
  select 'item', (e->>'id')::uuid, gen_random_uuid()
    from jsonb_array_elements(coalesce(p->'items', '[]'::jsonb)) e
  union all
  select 'voucher', (e->>'id')::uuid, gen_random_uuid()
    from jsonb_array_elements(coalesce(p->'vouchers', '[]'::jsonb)) e;

  insert into godowns (id, org_id, name, is_main, import_run)
  select m.new, v_org, e->>'name', coalesce((e->>'is_main')::boolean, false), v_run
    from jsonb_array_elements(coalesce(p->'godowns', '[]'::jsonb)) e
    join _map m on m.kind = 'godown' and m.old = (e->>'id')::uuid;

  insert into bank_accounts (id, org_id, name, opening, opening_on, is_default, is_active)
  select m.new, v_org, e->>'name', coalesce((e->>'opening')::numeric, 0),
         nullif(e->>'opening_on','')::date,
         coalesce((e->>'is_default')::boolean, false),
         coalesce((e->>'is_active')::boolean, true)
    from jsonb_array_elements(coalesce(p->'bank_accounts', '[]'::jsonb)) e
    join _map m on m.kind = 'bank' and m.old = (e->>'id')::uuid;

  insert into parties
  select (jsonb_populate_record(null::parties,
            e || jsonb_build_object('id', m.new, 'org_id', v_org, 'import_run', v_run))).*
    from jsonb_array_elements(coalesce(p->'parties', '[]'::jsonb)) e
    join _map m on m.kind = 'party' and m.old = (e->>'id')::uuid;
  get diagnostics c = row_count; n := n || jsonb_build_object('names', c);

  insert into items
  select (jsonb_populate_record(null::items,
            e || jsonb_build_object('id', m.new, 'org_id', v_org, 'import_run', v_run))).*
    from jsonb_array_elements(coalesce(p->'items', '[]'::jsonb)) e
    join _map m on m.kind = 'item' and m.old = (e->>'id')::uuid;
  get diagnostics c = row_count; n := n || jsonb_build_object('items', c);

  insert into item_parts (org_id, parent_id, child_id, qty)
  select v_org, mp.new, mc.new, coalesce((e->>'qty')::numeric, 0)
    from jsonb_array_elements(coalesce(p->'item_parts', '[]'::jsonb)) e
    join _map mp on mp.kind = 'item' and mp.old = (e->>'parent_id')::uuid
    join _map mc on mc.kind = 'item' and mc.old = (e->>'child_id')::uuid;

  insert into standing_items (org_id, name, kind, amount, note, as_on)
  select v_org, e->>'name', e->>'kind', coalesce((e->>'amount')::numeric, 0),
         nullif(e->>'note',''), nullif(e->>'as_on','')::date
    from jsonb_array_elements(coalesce(p->'standing_items', '[]'::jsonb)) e;

  insert into expense_heads (org_id, head, used)
  select v_org, e->>'head', coalesce((e->>'used')::int, 1)
    from jsonb_array_elements(coalesce(p->'expense_heads', '[]'::jsonb)) e
  on conflict do nothing;

  -- BILLS. ref_voucher_id points at another bill in the same file, so it is
  -- left empty here and filled in once they are all back.
  insert into vouchers
  select (jsonb_populate_record(null::vouchers,
            e || jsonb_build_object(
              'id', m.new, 'org_id', v_org, 'import_run', v_run,
              'ref_voucher_id', null,
              'party_id', (select mm.new from _map mm
                            where mm.kind = 'party' and mm.old = nullif(e->>'party_id','')::uuid),
              'godown_id', (select mm.new from _map mm
                            where mm.kind = 'godown' and mm.old = nullif(e->>'godown_id','')::uuid)))).*
    from jsonb_array_elements(coalesce(p->'vouchers', '[]'::jsonb)) e
    join _map m on m.kind = 'voucher' and m.old = (e->>'id')::uuid;
  get diagnostics c = row_count; n := n || jsonb_build_object('bills', c);

  update vouchers v set ref_voucher_id = mr.new
    from jsonb_array_elements(coalesce(p->'vouchers', '[]'::jsonb)) e
    join _map m  on m.kind  = 'voucher' and m.old = (e->>'id')::uuid
    join _map mr on mr.kind = 'voucher' and mr.old = nullif(e->>'ref_voucher_id','')::uuid
   where v.id = m.new and v.org_id = v_org;

  insert into voucher_lines
  select (jsonb_populate_record(null::voucher_lines,
            e || jsonb_build_object(
              'id', gen_random_uuid(), 'org_id', v_org,
              'voucher_id', mv.new,
              'item_id', (select mm.new from _map mm
                           where mm.kind = 'item' and mm.old = nullif(e->>'item_id','')::uuid),
              'godown_id', (select mm.new from _map mm
                           where mm.kind = 'godown' and mm.old = nullif(e->>'godown_id','')::uuid)))).*
    from jsonb_array_elements(coalesce(p->'voucher_lines', '[]'::jsonb)) e
    join _map mv on mv.kind = 'voucher' and mv.old = (e->>'voucher_id')::uuid;

  insert into payments
  select (jsonb_populate_record(null::payments,
            e || jsonb_build_object(
              'id', gen_random_uuid(), 'org_id', v_org, 'import_run', v_run,
              'party_id', (select mm.new from _map mm
                            where mm.kind = 'party' and mm.old = nullif(e->>'party_id','')::uuid),
              'account_id', (select mm.new from _map mm
                            where mm.kind = 'bank' and mm.old = nullif(e->>'account_id','')::uuid),
              'ref_voucher_id', (select mm.new from _map mm
                            where mm.kind = 'voucher' and mm.old = nullif(e->>'ref_voucher_id','')::uuid)))).*
    from jsonb_array_elements(coalesce(p->'payments', '[]'::jsonb)) e;
  get diagnostics c = row_count; n := n || jsonb_build_object('money', c);

  insert into expenses
  select (jsonb_populate_record(null::expenses,
            e || jsonb_build_object(
              'id', gen_random_uuid(), 'org_id', v_org,
              'party_id', (select mm.new from _map mm
                            where mm.kind = 'party' and mm.old = nullif(e->>'party_id','')::uuid),
              'account_id', (select mm.new from _map mm
                            where mm.kind = 'bank' and mm.old = nullif(e->>'account_id','')::uuid)))).*
    from jsonb_array_elements(coalesce(p->'expenses', '[]'::jsonb)) e;

  insert into stock_moves
  select (jsonb_populate_record(null::stock_moves,
            e || jsonb_build_object(
              'id', gen_random_uuid(), 'org_id', v_org, 'import_run', v_run,
              'item_id', (select mm.new from _map mm
                           where mm.kind = 'item' and mm.old = nullif(e->>'item_id','')::uuid),
              'godown_id', (select mm.new from _map mm
                           where mm.kind = 'godown' and mm.old = nullif(e->>'godown_id','')::uuid),
              'ref_voucher_id', (select mm.new from _map mm
                           where mm.kind = 'voucher' and mm.old = nullif(e->>'ref_voucher_id','')::uuid)))).*
    from jsonb_array_elements(coalesce(p->'stock_moves', '[]'::jsonb)) e;
  get diagnostics c = row_count; n := n || jsonb_build_object('moves', c);

  insert into invoice_series (org_id, kind, fy, next_no)
  select v_org, e->>'kind', e->>'fy', coalesce((e->>'next_no')::int, 1)
    from jsonb_array_elements(coalesce(p->'invoice_series', '[]'::jsonb)) e
  on conflict (org_id, kind, fy) do update set next_no = excluded.next_no;

  -- and the firm's own settings, without touching who owns it or its code
  update orgs o set
      name = coalesce(p->'org'->>'name', o.name),
      gstin = p->'org'->>'gstin',
      is_gst_registered = coalesce((p->'org'->>'is_gst_registered')::boolean, o.is_gst_registered),
      is_composition = coalesce((p->'org'->>'is_composition')::boolean, o.is_composition),
      state_code = coalesce(p->'org'->>'state_code', o.state_code),
      state_name = coalesce(p->'org'->>'state_name', o.state_name),
      mode = coalesce(p->'org'->>'mode', o.mode),
      invoice_prefix = coalesce(p->'org'->>'invoice_prefix', o.invoice_prefix),
      stock_enabled = coalesce((p->'org'->>'stock_enabled')::boolean, o.stock_enabled),
      godowns_enabled = coalesce((p->'org'->>'godowns_enabled')::boolean, o.godowns_enabled),
      batch_enabled = coalesce((p->'org'->>'batch_enabled')::boolean, o.batch_enabled),
      expiry_enabled = coalesce((p->'org'->>'expiry_enabled')::boolean, o.expiry_enabled),
      variants_enabled = coalesce((p->'org'->>'variants_enabled')::boolean, o.variants_enabled),
      making_enabled = coalesce((p->'org'->>'making_enabled')::boolean, o.making_enabled),
      show_purchase = coalesce((p->'org'->>'show_purchase')::boolean, o.show_purchase),
      show_returns = coalesce((p->'org'->>'show_returns')::boolean, o.show_returns),
      show_reports = coalesce((p->'org'->>'show_reports')::boolean, o.show_reports),
      show_transfer = coalesce((p->'org'->>'show_transfer')::boolean, o.show_transfer),
      show_expenses = coalesce((p->'org'->>'show_expenses')::boolean, o.show_expenses),
      show_recon = coalesce((p->'org'->>'show_recon')::boolean, o.show_recon),
      price1_name = coalesce(p->'org'->>'price1_name', o.price1_name),
      price2_name = coalesce(p->'org'->>'price2_name', o.price2_name),
      default_godown_id = (select mm.new from _map mm where mm.kind = 'godown'
                            and mm.old = nullif(p->'org'->>'default_godown_id','')::uuid)
    where o.id = v_org;

  update import_runs set done_at = now(), counts = n where id = v_run;
  return jsonb_build_object('run', v_run, 'put_back', n);
end
$rs$;

revoke all on function public.book_restore(jsonb) from public;
grant execute on function public.book_restore(jsonb) to authenticated;
