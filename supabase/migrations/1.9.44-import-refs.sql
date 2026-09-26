-- ===========================================================================
--  1.9.44  PRESSING IMPORT TWICE MUST COST NOTHING.
--
--  A shopkeeper will import the same file twice. He will press it again
--  because the signal dropped halfway and he does not know whether it
--  finished; because he is not sure it worked; because he exported a longer
--  range the second time and it overlaps the first. This is not carelessness,
--  it is what people do, and an importer that doubles his sales when he does
--  it has ruined books that cannot be put right by hand.
--
--  Bills and receipts are already safe. save_voucher takes the id it is given
--  and, finding that id already written, returns "already" without touching
--  anything; payments are written with the same id through an upsert that
--  ignores one it has seen. Both ids are worked out from Tally's own id for
--  the voucher, so the same voucher always produces the same one.
--
--  The goods moved between stores were the hole. transfer_stock writes two
--  rows into stock_moves and has nothing to compare them against, so a second
--  import moved everything a second time — and because a transfer nets to
--  nothing across the firm, the TOTAL stock still looked right while both
--  godowns were quietly wrong. That is the worst shape a wrong figure can
--  take, and it is the same failure this app has already been bitten by once.
--
--  So a movement can now carry the id of whatever brought it in, no two
--  movements in one shop may carry the same one, and transfer_stock says so
--  plainly and writes nothing when the id is already there.
--
--  SAFE TO RUN TWICE, and safe on a shop with movements already in it: the
--  column starts empty, the index only covers rows that have one, and nothing
--  existing is changed.
-- ===========================================================================


-- ---------------------------------------------------------------------------
--  0. THE RUN ITSELF
-- ---------------------------------------------------------------------------
--  1.10.0 finishes this thought -- every row an import writes carries the
--  mark, and one press takes the whole run back out -- but the table and the
--  columns have to exist HERE, because the functions further down this file
--  write to them. It is all repeated in 1.10.0 as well, where the rest of it
--  lives, and running either twice does nothing.

create table if not exists public.import_runs (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references public.orgs(id) on delete cascade,
  kind       text not null,
  note       text,
  counts     jsonb not null default '{}'::jsonb,
  started_at timestamptz not null default now(),
  done_at    timestamptz,
  undone_at  timestamptz,
  undo_note  text
);

alter table public.parties     add column if not exists import_run uuid references public.import_runs(id) on delete set null;
alter table public.items       add column if not exists import_run uuid references public.import_runs(id) on delete set null;
alter table public.vouchers    add column if not exists import_run uuid references public.import_runs(id) on delete set null;
alter table public.payments    add column if not exists import_run uuid references public.import_runs(id) on delete set null;
alter table public.stock_moves add column if not exists import_run uuid references public.import_runs(id) on delete set null;
alter table public.godowns     add column if not exists import_run uuid references public.import_runs(id) on delete set null;


-- ---------------------------------------------------------------------------
--  1. WHERE A MOVEMENT REMEMBERS WHAT BROUGHT IT IN
-- ---------------------------------------------------------------------------

alter table public.stock_moves
  add column if not exists import_ref text;

-- Partial, so the millions of ordinary movements a shop makes — which carry
-- no import_ref and never will — cost nothing to keep indexed.
create unique index if not exists stock_moves_import_ref_once
  on public.stock_moves (org_id, import_ref)
  where import_ref is not null;

comment on column public.stock_moves.import_ref is
  'Set only by an import. One per shop: the same file read twice writes the movement once.';


-- ---------------------------------------------------------------------------
--  2. A TRANSFER THAT KNOWS WHETHER IT HAS ALREADY HAPPENED
-- ---------------------------------------------------------------------------
--
--  Unchanged from 1.9.43 except for the ref: same arguments, same books lock,
--  same two rows per line. A transfer sent without a ref behaves exactly as
--  it always has, which is what the Move & correct screen does — a man moving
--  goods by hand means it every time he presses the button.

create or replace function public.transfer_stock(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $xfer$
declare
  v_org  uuid := my_org_id();
  v_from uuid := nullif(p->>'from_godown','')::uuid;
  v_to   uuid := nullif(p->>'to_godown','')::uuid;
  v_date date := coalesce(nullif(p->>'mdate','')::date, today_ist());
  v_ref  text := nullif(btrim(coalesce(p->>'ref','')), '');
  v_run  uuid := nullif(p->>'import_run','')::uuid;
  v_lock date;
  ln     jsonb;
  n      int := 0;
  i      int := 0;
begin
  -- A LOOK-ONLY LOGIN, AND A YEAR THAT HAS RUN OUT, BOTH STOP HERE.
  --
  -- Every function that writes a bill has stood behind this since 1.9; these
  -- three were written later and did not. So a shop whose subscription had
  -- ended could not raise a bill but could still correct its stock, move goods
  -- between godowns and manufacture -- and a staff login marked look-only
  -- could do the same. Both are writes to the books like any other.
  perform assert_can_write();
  if v_org is null then raise exception 'This login is not linked to a firm yet'; end if;
  if v_from is null or v_to is null then raise exception 'Say which godown to which'; end if;
  if v_from = v_to then raise exception 'Those are the same godown'; end if;

  select books_locked_upto into v_lock from orgs where id = v_org;
  if v_lock is not null and v_date <= v_lock then
    raise exception 'Your books are closed up to %. Date the move in a month that is still open.',
      to_char(v_lock, 'DD Mon YYYY');
  end if;

  -- ALREADY DONE IS NOT AN ERROR. An import that stopped halfway and was
  -- started again should walk quietly past everything it finished the first
  -- time, and say how many it walked past.
  if v_ref is not null and exists (
       select 1 from stock_moves
        where org_id = v_org and import_ref like v_ref || '%') then
    return jsonb_build_object('moved', 0, 'already', true);
  end if;

  for ln in select * from jsonb_array_elements(coalesce(p->'lines','[]'::jsonb)) loop
    if coalesce((ln->>'qty')::numeric, 0) <= 0 then continue; end if;
    i := i + 1;

    insert into stock_moves (org_id, item_id, mdate, qty_in, qty_out, reason, godown_id,
                             batch, expiry, import_ref, import_run)
    values (v_org, (ln->>'item_id')::uuid, v_date, 0, (ln->>'qty')::numeric,
            'transfer_out', v_from, nullif(ln->>'batch',''), nullif(ln->>'expiry','')::date,
            case when v_ref is null then null else v_ref || ':' || i || ':out' end, v_run);

    insert into stock_moves (org_id, item_id, mdate, qty_in, qty_out, reason, godown_id,
                             batch, expiry, import_ref, import_run)
    values (v_org, (ln->>'item_id')::uuid, v_date, (ln->>'qty')::numeric, 0,
            'transfer_in', v_to, nullif(ln->>'batch',''), nullif(ln->>'expiry','')::date,
            case when v_ref is null then null else v_ref || ':' || i || ':in' end, v_run);

    n := n + 1;
  end loop;

  return jsonb_build_object('moved', n, 'already', false);
end
$xfer$;

revoke all on function public.transfer_stock(jsonb) from public;
grant execute on function public.transfer_stock(jsonb) to authenticated;


-- ---------------------------------------------------------------------------
--  3. THE OWNER CHECK, AGAIN
-- ---------------------------------------------------------------------------
--  stock_moves accepts a write only from a function owned by the same role as
--  save_voucher. Said here, in the editor, rather than on the shop floor.

do $chk$
declare want oid; got oid;
begin
  select proowner into want from pg_proc
   where oid = 'public.save_voucher(jsonb)'::regprocedure;
  select proowner into got  from pg_proc
   where oid = 'public.transfer_stock(jsonb)'::regprocedure;
  if want is not null and got is not null and want <> got then
    raise exception
      'transfer_stock was created by a different login from save_voucher, so stock_moves will refuse its writes. Run every Skwik migration from the same Supabase SQL editor login.';
  end if;
end
$chk$;
