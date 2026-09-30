-- ===========================================================================
--  1.10.37  CLOSE THE DOORS BEFORE SELLING IT
--
--  An audit of every table, policy and function turned up four ways in, two of
--  them proved with working exploits against a built copy of the database.
--  Cross-firm reading was solid -- every one of the seventy-six functions that
--  takes an id refused another firm's id -- so none of this is one shop seeing
--  another's books. It is worse in a different way: it is the guards Skwik
--  sells being ignorable from the phone.
--
--    1. A SHOP CAN GIVE ITSELF THE PAID PLAN. orgs_write is `with check
--       (true)`, so one PATCH on the orgs row sets paid_until to 2099 and the
--       subscription is free for ever. The same PATCH clears
--       books_locked_upto and reopens every filed GST month.
--
--    2. A LOOK-ONLY ACCOUNTANT CAN REWRITE THE BOOKS. The restrictive
--       can_write() policies are applied from a list of table names written in
--       1.9, and six tables have been added since -- including the journals,
--       the ledgers and the legs I added an hour ago. A login that can_write()
--       says is false wrote a single unbalanced leg, dated inside a locked
--       month, and moved a customer's dues by five lakh in the owner's own
--       balance sheet.
--
--    3. EVERY ROLE HOLDS TRUNCATE ON EVERY TABLE. `grant all` includes it, and
--       TRUNCATE is a table privilege that row security never gets to see, so
--       it empties every firm's rows at once. PostgREST never sends TRUNCATE,
--       so it is not reachable today -- it becomes reachable the moment
--       anything speaks SQL as those roles.
--
--    4. A STAFF LOGIN CAN READ THE CAPITAL ACCOUNT. The balance sheet, the
--       profit and loss and the standing balances are all owner-only. The new
--       ledger listing was not, and once a Tally book is imported that is
--       where the capital, the drawings and the loans live.
--
--  AND THE ROOT CAUSE OF THE SECOND ONE IS FIXED, not just the symptom: the
--  guard is applied by walking the catalogue for every table that has an
--  org_id, so a table added next year is guarded the day it is created.
-- ===========================================================================


-- ---------------------------------------------------------------------------
--  1. NO MORE HAND-WRITTEN LISTS.
--
--  Every table with an org_id on it is a table holding somebody's books, and
--  every one of them gets the read-only guard. Run again after adding a table
--  and it picks the new one up.
-- ---------------------------------------------------------------------------
create or replace function public.guard_every_org_table()
returns integer
language plpgsql
security definer
set search_path to 'public'
as $g$
declare
  t text;
  n integer := 0;
begin
  for t in
    select c.relname
      from pg_class c
      join pg_namespace ns on ns.oid = c.relnamespace
      join pg_attribute a  on a.attrelid = c.oid and a.attname = 'org_id'
     where ns.nspname = 'public' and c.relkind = 'r'
       -- his own profile row is not a book, and the payments Skwik takes are
       -- written by the server, never by a shop
       and c.relname not in ('profiles', 'subscription_payments')
     order by c.relname
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists ro_accountant_ins on public.%I', t);
    execute format('drop policy if exists ro_accountant_upd on public.%I', t);
    execute format('drop policy if exists ro_accountant_del on public.%I', t);
    execute format(
      'create policy ro_accountant_ins on public.%I as restrictive for insert
         with check (can_write())', t);
    execute format(
      'create policy ro_accountant_upd on public.%I as restrictive for update
         using (can_write()) with check (can_write())', t);
    execute format(
      'create policy ro_accountant_del on public.%I as restrictive for delete
         using (can_write())', t);
    n := n + 1;
  end loop;
  return n;
end $g$;

revoke all on function public.guard_every_org_table() from public, anon, authenticated;

select public.guard_every_org_table();


-- ---------------------------------------------------------------------------
--  2. THE DOUBLE ENTRY GOES THROUGH THE FUNCTION OR NOT AT ALL.
--
--  save_journal refuses a journal that does not balance, and refuses one dated
--  in a month he has closed. Neither refusal is worth anything if the same
--  rows can be written straight to the table, which is how a single unbalanced
--  leg landed in a locked month. Same rule the bills already follow.
-- ---------------------------------------------------------------------------
do $r$
declare t text;
begin
  foreach t in array array['journals', 'journal_legs', 'ledgers'] loop
    execute format('drop policy if exists rpc_only_ins on public.%I', t);
    execute format('drop policy if exists rpc_only_upd on public.%I', t);
    execute format(
      'create policy rpc_only_ins on public.%I as restrictive for insert
         with check (not is_direct_client())', t);
    execute format(
      'create policy rpc_only_upd on public.%I as restrictive for update
         using (not is_direct_client())', t);
  end loop;
end $r$;

-- and a leg cannot point at another firm's party, bank or ledger
create or replace function public.tg_journal_legs_same_org()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $tj$
begin
  if new.party_id is not null and not exists (
       select 1 from parties where id = new.party_id and org_id = new.org_id) then
    raise exception 'That name is not in this shop';
  end if;
  if new.account_id is not null and not exists (
       select 1 from bank_accounts where id = new.account_id and org_id = new.org_id) then
    raise exception 'That bank account is not in this shop';
  end if;
  if new.ledger_id is not null and not exists (
       select 1 from ledgers where id = new.ledger_id and org_id = new.org_id) then
    raise exception 'That ledger is not in this shop';
  end if;
  return new;
end $tj$;

drop trigger if exists journal_legs_same_org on public.journal_legs;
create trigger journal_legs_same_org
  before insert or update on public.journal_legs
  for each row execute function public.tg_journal_legs_same_org();


-- ---------------------------------------------------------------------------
--  3. A SHOP CANNOT WRITE ITS OWN SUBSCRIPTION.
--
--  `with check (true)` on the firm's own row let an owner set plan, paid_until
--  and trial_ends_at to anything he liked -- and clear books_locked_upto,
--  which is the lock that stops a filed GST month being edited. He may still
--  change his shop's name, its address, its GST number and every setting; the
--  four fields that are Skwik's side of the bargain are pinned to what the
--  server last wrote.
-- ---------------------------------------------------------------------------
drop policy if exists orgs_write on public.orgs;
create policy orgs_write on public.orgs for update
  using  (owner_id = auth.uid() or (owner_id is null and id = my_org_id()))
  with check (owner_id = auth.uid() or (owner_id is null and id = my_org_id()));

-- NOT security definer, and that is the whole of why it works.
--
-- The first try was, and it did nothing at all: inside a definer function the
-- current user becomes the function's owner, so is_direct_client() -- which
-- asks whether the caller is somebody other than that owner -- answered no,
-- every time, and the guard let every write through. It has to run as whoever
-- called it to be able to tell who called it.
create or replace function public.tg_orgs_plan_guard()
returns trigger
language plpgsql
set search_path to 'public'
as $tp$
begin
  -- the server and the migrations may write these; a phone may not
  if is_direct_client() then
    new.plan          := old.plan;
    new.paid_until    := old.paid_until;
    new.trial_ends_at := old.trial_ends_at;
    -- A LOCK ONLY EVER MOVES FORWARD. Closing August is a decision; quietly
    -- reopening it from the phone is how a filed return gets edited.
    if new.books_locked_upto is distinct from old.books_locked_upto
       and old.books_locked_upto is not null
       and (new.books_locked_upto is null or new.books_locked_upto < old.books_locked_upto) then
      raise exception 'Your books are closed up to %. They cannot be reopened from here.',
        to_char(old.books_locked_upto, 'DD Mon YYYY');
    end if;
  end if;
  return new;
end $tp$;

drop trigger if exists orgs_plan_guard on public.orgs;
create trigger orgs_plan_guard
  before update on public.orgs
  for each row execute function public.tg_orgs_plan_guard();


-- ---------------------------------------------------------------------------
--  4. NOBODY NEEDS TO EMPTY A TABLE.
--
--  `grant all` hands out TRUNCATE, and TRUNCATE is a table privilege that row
--  security never sees -- one statement empties every firm on the platform.
--  Four verbs are all anything needs; the newer tables were already granted
--  exactly those.
-- ---------------------------------------------------------------------------
do $t$
declare t text;
begin
  for t in
    select c.relname from pg_class c
      join pg_namespace ns on ns.oid = c.relnamespace
     where ns.nspname = 'public' and c.relkind in ('r', 'v')
  loop
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select, insert, update, delete on public.%I to anon, authenticated', t);
  end loop;
end $t$;

alter default privileges in schema public
  revoke all on tables from anon, authenticated;
alter default privileges in schema public
  grant select, insert, update, delete on tables to anon, authenticated;


-- ---------------------------------------------------------------------------
--  5. THE LEDGER LISTING IS THE OWNER'S, LIKE EVERY OTHER SHEET.
--
--  The balance sheet, the profit and loss and the standing balances are all
--  owner-only. This is the same figures under another name -- capital,
--  drawings, loans -- so it keeps the same company.
-- ---------------------------------------------------------------------------
create or replace function public.ledger_balances_on(p_on date default null)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $lb$
declare v jsonb;
begin
  if my_role() <> 'owner' then
    raise exception 'Only the owner can see the ledgers';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', x.id, 'name', x.name, 'group', x.grp, 'role', x.role,
           'opening', x.opening, 'balance', x.bal) order by x.name), '[]'::jsonb)
    into v
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
  return v;
end $lb$;

revoke all on function public.ledger_balances_on(date) from public, anon;
grant execute on function public.ledger_balances_on(date) to authenticated;

-- and the ledgers themselves are the owner's to read
do $o$
begin
  drop policy if exists ledgers_own_org on public.ledgers;
  create policy ledgers_own_org on public.ledgers
    for all using (org_id = my_org_id() and my_role() = 'owner')
    with check (org_id = my_org_id() and my_role() = 'owner');
end $o$;


-- ---------------------------------------------------------------------------
--  6. A PHONE NUMBER MUST NOT HAND BACK AN EMAIL ADDRESS ALL NIGHT.
--
--  login_email_for_phone is granted to anon by design -- it is how a login
--  written under the old email shape still works. Unthrottled it is also a way
--  to walk the whole ten-digit mobile range and collect an email address for
--  every Skwik customer.
--
--  It is not removed, because removing it locks those customers out. It is
--  counted: five looks at one number in an hour, and sixty in an hour across
--  the whole platform. The ordinary login never reaches this function at all
--  -- the app works the address out from the number itself and only falls back
--  here when that fails -- so a real shop will never see the limit.
-- ---------------------------------------------------------------------------
create table if not exists public.phone_lookups (
  at    timestamptz not null default now(),
  phone text not null
);
create index if not exists ix_phone_lookups_at on public.phone_lookups (at);
alter table public.phone_lookups enable row level security;
revoke all on public.phone_lookups from anon, authenticated;

create or replace function public.login_email_for_phone(p_phone text)
returns text
language plpgsql
security definer
set search_path to 'public', 'auth'
as $le$
declare
  v_num  text := regexp_replace(coalesce(p_phone, ''), '\D', '', 'g');
  v_one  integer;
  v_all  integer;
  v_mail text;
begin
  if length(v_num) < 6 then return null; end if;

  delete from phone_lookups where at < now() - interval '2 hours';

  select count(*) into v_one from phone_lookups
   where phone = v_num and at > now() - interval '1 hour';
  select count(*) into v_all from phone_lookups
   where at > now() - interval '1 hour';
  if v_one >= 5 or v_all >= 60 then
    raise exception 'Too many sign-in attempts just now. Try again in a little while.';
  end if;
  insert into phone_lookups (phone) values (v_num);

  select u.email into v_mail
    from profiles p
    join auth.users u on u.id = p.id
   where regexp_replace(coalesce(p.phone, ''), '\D', '', 'g') = v_num
   limit 1;
  return v_mail;
end $le$;

revoke all on function public.login_email_for_phone(text) from public;
grant execute on function public.login_email_for_phone(text) to anon, authenticated;


-- ---------------------------------------------------------------------------
--  7. TWO HELPERS THAT TOOK A FIRM ON TRUST.
--
--  Neither is reachable from a phone today -- one is revoked, the other is
--  only ever called with the caller's own firm. Both are one line from being a
--  way into somebody else's books if a grant is ever widened by accident, and
--  a guard that is never needed costs nothing.
-- ---------------------------------------------------------------------------
revoke all on function public.purchase_unit_cost(uuid, jsonb) from public, anon, authenticated;
