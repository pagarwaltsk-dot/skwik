-- ===========================================================================
--  SKWIK 1.9.3  —  security release
--
--  Run this in the Supabase SQL editor AFTER 1.9-fixes.sql. Safe to run twice.
--
--  WHY THIS EXISTS
--
--  The anon key is inside the APK. That is how Supabase works and it is fine —
--  but it means anyone can extract it and talk to the database directly, with
--  no app in the way. Row-level security and these functions are the only
--  wall. Four ways through that wall were found and each one was reproduced
--  against a real database before this was written:
--
--   1. A brand-new account could join ANY shop with a single write to its own
--      profile row — no join code, no open door. Then read and write
--      everything: bills, parties, cost prices, bank balances.
--   2. Anyone with any login could push a payment into somebody else's shop,
--      and the read-only accountant could forge payments in his own.
--   3. A biller could rewrite or delete a bill in a FILED month, bypassing
--      both the books lock and the owner-only rule, by writing to the table
--      instead of calling the function.
--   4. A biller could write a real sale flagged so that no report ever shows
--      it — pocket the cash, and the owner's books never mention it.
--
--  The mistake behind all four is the same: the rules lived in the functions,
--  and the tables would still take a direct write. They now live in the
--  tables as well.
-- ===========================================================================

begin;

-- ---------------------------------------------------------------------------
--  1. AM I BEING CALLED BY THE APP, OR BY ONE OF OUR OWN FUNCTIONS?
--
--  Every rule below needs to tell those two apart, and the test has to be one
--  the phone cannot fake.
--
--  Our RPCs are SECURITY DEFINER, so while one of them is running the current
--  user is the role that OWNS it — postgres. A request straight from a phone
--  runs as `authenticated` (or `anon`), and no key in the world lets that role
--  become postgres. So "am I running as the owner of save_voucher" is the
--  whole test, and it cannot be lied about.
--
--  (Do not be tempted by current_user = session_user. PostgREST connects as
--  `authenticator` and then switches to `authenticated`, so those two differ
--  on an ordinary request as well — the test would never fire.)
-- ---------------------------------------------------------------------------

create or replace function public.is_direct_client()
returns boolean language sql stable as $$
  select current_user::text::regrole::oid
      <> (select proowner from pg_proc
           where oid = 'public.save_voucher(jsonb)'::regprocedure)
$$;

-- All of this rests on our writing functions sharing one owner. If a later
-- migration is ever run by a different role, say so here and now rather than
-- letting the app quietly stop working.
do $$
declare want oid; bad text;
begin
  select proowner into want from pg_proc
   where oid = 'public.save_voucher(jsonb)'::regprocedure;
  select string_agg(p.oid::regprocedure::text, ', ') into bad
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.prosecdef and p.proowner <> want
     and p.proname in ('update_voucher','delete_voucher','post_voucher_cash',
                       'join_org','remove_staff','set_staff_role','write_off',
                       'transfer_stock','wipe_org');
  if bad is not null then
    raise exception 'These functions have a different owner from save_voucher: %. Run every Skwik migration from the same Supabase SQL editor login.', bad;
  end if;
  if exists (select 1 from pg_class
              where oid in ('public.vouchers'::regclass,'public.voucher_lines'::regclass,
                            'public.stock_moves'::regclass,'public.profiles'::regclass,
                            'public.orgs'::regclass,'public.payments'::regclass)
                and relforcerowsecurity) then
    raise exception 'FORCE ROW LEVEL SECURITY is on for one of the books tables; the RPCs cannot write through it.';
  end if;
end $$;

-- ---------------------------------------------------------------------------
--  2. THE BOOKS ARE WRITTEN BY THE FUNCTIONS, AND BY NOTHING ELSE
--
--  save_voucher, update_voucher and delete_voucher carry every rule that
--  matters: the invoice numbering, the books lock, owner-only cancellation,
--  the stock movements, the cash posting. A direct write to these tables
--  skips all of it, so a direct write is now refused outright.
--
--  The app has never written to these three tables directly — every screen
--  goes through the RPCs — so nothing legitimate changes. The functions run
--  as their owner and are unaffected.
-- ---------------------------------------------------------------------------

create or replace function public.tg_books_rpc_only()
returns trigger language plpgsql as $$
begin
  if is_direct_client() then
    raise exception 'Bills are written by the app''s own save/edit/cancel steps, not by hand (% on %)',
      tg_op, tg_table_name
      using hint = 'This request went straight to the table and skipped the invoice numbering, the books lock and the stock entries.';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;

do $$
declare t text;
begin
  foreach t in array array['vouchers','voucher_lines','stock_moves'] loop
    -- a clear refusal, for anything that reaches the row
    execute format('drop trigger if exists books_rpc_only on public.%I', t);
    execute format('create trigger books_rpc_only before insert or update or delete
                      on public.%I for each row execute function public.tg_books_rpc_only()', t);
    -- and a second wall underneath it, in case a trigger is ever disabled
    execute format('drop policy if exists rpc_only_ins on public.%I', t);
    execute format('create policy rpc_only_ins on public.%I as restrictive
                      for insert with check (not is_direct_client())', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
--  3. A PAYMENT THE SHOPKEEPER TYPES IS FINE. ONE THAT PRETENDS A BILL MADE
--     IT IS NOT.
--
--  The money screen writes payments directly and must keep working. But two
--  of that table's columns decide what happens when a bill is later edited or
--  cancelled, and a client has no business setting either: `from_voucher`
--  says the bill created this row, and `ref_voucher_id` ties it to a bill.
--  A row that lies about those can delete a real receipt, or survive as a
--  duplicate. Only post_voucher_cash sets them, and it is ours.
-- ---------------------------------------------------------------------------

create or replace function public.tg_payment_from_client()
returns trigger language plpgsql as $$
begin
  if is_direct_client() then
    -- `from_voucher` is post_voucher_cash's mark and nobody else's. A row
    -- that wears it falsely is thrown away the next time that bill is edited.
    if tg_op = 'INSERT' then
      new.from_voucher := false;
    else
      new.from_voucher := old.from_voucher;
    end if;
    -- tying a receipt to a bill is allowed (the sample-data screen does it),
    -- but only to a bill in these books
    if new.ref_voucher_id is not null
       and not exists (select 1 from vouchers
                        where id = new.ref_voucher_id and org_id = my_org_id()) then
      raise exception 'That receipt cannot be tied to a bill from another shop';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists payments_client_fields on public.payments;
drop trigger if exists tg_payment_from_client on public.payments;
create trigger payments_client_fields
  before insert or update on public.payments
  for each row execute function public.tg_payment_from_client();

-- ---------------------------------------------------------------------------
--  4. NOBODY WALKS INTO A SHOP WITHOUT A CODE
--
--  A shop is joined by join_org, which needs a code the owner opened, which
--  lasts an hour and shuts after one phone. All of that was bypassable: a new
--  account could simply write the shop's id onto its own profile row. The old
--  guard only objected when the profile ALREADY had a shop, and a new one
--  does not.
--
--  Now the client may never set or change org_id at all. join_org and
--  remove_staff run as their owner and still can — which also repairs
--  remove_staff, whose attempt to clear org_id was being refused by the old
--  guard, leaving no way to take somebody's access away.
-- ---------------------------------------------------------------------------

-- The one link a phone is allowed to make: onto a shop it has just created
-- and owns. Registration does exactly that — it inserts the firm (owner_id
-- defaults to the logged-in user) and then writes that firm's id onto its own
-- profile. Joining somebody ELSE's shop is join_org's job and needs the code.
create or replace function public.client_may_link(p_org uuid)
returns boolean language sql stable security definer set search_path to 'public' as $$
  select p_org is null
      or exists (select 1 from orgs where id = p_org and owner_id = auth.uid())
$$;

create or replace function public.tg_profiles_org_guard()
returns trigger language plpgsql as $$
begin
  if is_direct_client() then
    if new.org_id is distinct from old.org_id then
      if old.org_id is not null then
        raise exception 'You are already in a shop. To move, the owner has to remove you first.';
      end if;
      if not client_may_link(new.org_id) then
        raise exception 'A shop is joined with a code from its owner, not by hand';
      end if;
    end if;
    -- a role is the owner's to give, and only through set_staff_role
    if new.role is distinct from old.role then
      raise exception 'Only the owner can change what someone is allowed to do';
    end if;
    if new.id is distinct from old.id then
      raise exception 'A login cannot be renumbered';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists tg_profiles_org_guard on public.profiles;
drop trigger if exists profiles_org_guard on public.profiles;
create trigger profiles_org_guard
  before update on public.profiles
  for each row execute function public.tg_profiles_org_guard();

-- a new profile may be created only for yourself, only as an ordinary seat,
-- and only pointing at a shop you own
create or replace function public.tg_profiles_new_guard()
returns trigger language plpgsql as $$
begin
  if is_direct_client() then
    if new.id <> auth.uid() then
      raise exception 'You can only make your own login';
    end if;
    if not client_may_link(new.org_id) then
      raise exception 'A shop is joined with a code from its owner, not by hand';
    end if;
    new.role := 'staff';
  end if;
  return new;
end $$;

drop trigger if exists tg_profiles_new_guard on public.profiles;
drop trigger if exists profiles_new_guard on public.profiles;
create trigger profiles_new_guard
  before insert on public.profiles
  for each row execute function public.tg_profiles_new_guard();

-- ---------------------------------------------------------------------------
--  5. A SHOP WITH NO OWNER CANNOT BE CLAIMED BY WHOEVER ASKS FIRST
-- ---------------------------------------------------------------------------

create or replace function public.tg_orgs_owner_guard()
returns trigger language plpgsql as $$
begin
  if is_direct_client() and new.owner_id is distinct from old.owner_id then
    raise exception 'The owner of a shop cannot be changed from here';
  end if;
  return new;
end $$;

drop trigger if exists tg_orgs_owner_guard on public.orgs;
drop trigger if exists orgs_owner_guard on public.orgs;
create trigger orgs_owner_guard
  before update on public.orgs
  for each row execute function public.tg_orgs_owner_guard();

-- ---------------------------------------------------------------------------
--  6. THE CASH-POSTING HELPER IS OURS, NOT THE WORLD'S
--
--  post_voucher_cash took a voucher id and wrote a payment into WHATEVER shop
--  that voucher belonged to, with no check that the caller belonged there. A
--  stranger who learned one bill's id could put money into somebody else's
--  cash book; the read-only accountant could forge receipts in his own.
--
--  It is an internal step of save_voucher. It now refuses anyone outside the
--  shop, refuses a read-only seat, and is not callable from the app at all.
-- ---------------------------------------------------------------------------

create or replace function public.post_voucher_cash(p_id uuid, p jsonb)
returns void
language plpgsql security definer set search_path to 'public' as $$
declare
  v       vouchers%rowtype;
  v_paid  numeric;
  v_cash  boolean;
begin
  select * into v from vouchers where id = p_id;
  if not found then return; end if;

  -- THE TWO LINES THAT WERE MISSING.
  if v.org_id is distinct from my_org_id() then
    raise exception 'That bill is not in your books';
  end if;
  perform assert_can_write();

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
                          ref_voucher_id, account_id, from_voucher)
    values (v.org_id, 'receipt', v.party_id, v.vdate,
            coalesce(nullif(p->>'pay_mode',''), 'cash'), v_paid,
            'Cash for ' || coalesce(v.voucher_no, ''), v.id,
            nullif(p->>'account_id','')::uuid, true);

  elsif v.vtype = 'sale_return' then
    insert into payments (org_id, ptype, party_id, pdate, mode, amount, note,
                          ref_voucher_id, account_id, from_voucher)
    values (v.org_id, 'payment', v.party_id, v.vdate,
            coalesce(nullif(p->>'pay_mode',''), 'cash'), v_paid,
            'Refund on ' || coalesce(v.voucher_no, ''), v.id,
            nullif(p->>'account_id','')::uuid, true);

  elsif v.vtype = 'purchase' then
    insert into payments (org_id, ptype, party_id, pdate, mode, amount, note,
                          ref_voucher_id, account_id, from_voucher)
    values (v.org_id, 'payment', v.party_id, v.vdate,
            coalesce(nullif(p->>'pay_mode',''), 'cash'), v_paid,
            'Paid on ' || coalesce(v.voucher_no, ''), v.id,
            nullif(p->>'account_id','')::uuid, true);

  elsif v.vtype = 'purchase_return' then
    insert into payments (org_id, ptype, party_id, pdate, mode, amount, note,
                          ref_voucher_id, account_id, from_voucher)
    values (v.org_id, 'receipt', v.party_id, v.vdate,
            coalesce(nullif(p->>'pay_mode',''), 'cash'), v_paid,
            'Refund on ' || coalesce(v.voucher_no, ''), v.id,
            nullif(p->>'account_id','')::uuid, true);
  end if;
end $$;

revoke execute on function public.post_voucher_cash(uuid, jsonb) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname='anon') then
    execute 'revoke execute on function public.post_voucher_cash(uuid, jsonb) from anon';
  end if;
  if exists (select 1 from pg_roles where rolname='authenticated') then
    execute 'revoke execute on function public.post_voucher_cash(uuid, jsonb) from authenticated';
  end if;
end $$;

-- ---------------------------------------------------------------------------
--  7. THE INVOICE-NUMBER HELPERS ARE INTERNAL TOO
--
--  A read-only accountant could burn invoice numbers by calling these, which
--  puts a gap in a series the tax office expects to be unbroken.
-- ---------------------------------------------------------------------------

do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure::text as sig
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('next_invoice_no','next_invoice_no_for','claim_invoice_no',
                         'post_voucher_cash','trailing_no')
  loop
    execute format('revoke execute on function %s from public', f.sig);
    if exists (select 1 from pg_roles where rolname='anon') then
      execute format('revoke execute on function %s from anon', f.sig);
    end if;
    if exists (select 1 from pg_roles where rolname='authenticated') then
      execute format('revoke execute on function %s from authenticated', f.sig);
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
--  8. TAKING SOMEBODY'S ACCESS AWAY HAS TO WORK
--
--  remove_staff cleared org_id, which the old guard refused — so there was no
--  way to remove anyone. It runs as its owner, so the new guard lets it
--  through; this only adds the checks it should always have had.
-- ---------------------------------------------------------------------------

create or replace function public.remove_staff(p_id uuid)
returns void
language plpgsql security definer set search_path to 'public' as $$
declare v_org uuid := my_org_id();
begin
  if v_org is null then raise exception 'This login is not linked to a firm yet'; end if;
  if my_role() <> 'owner' then
    raise exception 'Only the owner can remove someone from the shop';
  end if;
  if p_id = auth.uid() then
    raise exception 'You cannot remove yourself';
  end if;
  if exists (select 1 from orgs where id = v_org and owner_id = p_id) then
    raise exception 'The owner cannot be removed from his own shop';
  end if;

  update profiles set org_id = null, role = 'staff'
   where id = p_id and org_id = v_org;
  if not found then raise exception 'That person is not in your shop'; end if;
end $$;

commit;
