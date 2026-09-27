-- ===========================================================================
--  1.9.43  THE SHELF SAYS 38 AND THE BOOK SAYS 42.
--
--  Every movement in Skwik until now came from a bill: a purchase put goods
--  on the shelf, a sale took them off, a transfer carried them between two
--  stores. All of those are true records of something that happened.
--
--  But stock also goes wrong in ways no bill explains. Breakage. Pilferage.
--  A sample given away. An opening figure typed as 500 when it was 50. A
--  purchase entered twice in the first week and never noticed. When a man
--  counts his shelf at the end of the month and the book disagrees, he has
--  nowhere to put the difference — and so the stock figure stays wrong for
--  ever, and every report built on it stays wrong with it.
--
--  This is that entry. He counts, he types what he counted, and Skwik writes
--  the difference. Nothing else in the books moves: no money, no tax, no
--  customer's account. The item register already knows how to show it — it
--  has had the word "Adjustment" in it since 1.9.10, waiting for something
--  to write one.
--
--  HE TYPES WHAT HE COUNTED, NOT THE DIFFERENCE.
--
--  A shopkeeper counting a shelf knows one number: how many are on it. Asking
--  him for "the difference" asks him to do arithmetic against a figure he
--  does not trust, which is the whole reason he is counting. So the function
--  takes the count and works the difference out itself — and it works it out
--  at the moment of saving, not from whatever the screen was showing a minute
--  ago, so a sale rung up on another phone while he was counting cannot leave
--  the books wrong. After this runs, the stock IS what he counted. That is
--  true by construction rather than by hope.
--
--  AND A HOLE IN transfer_stock, CLOSED WHILE WE ARE HERE.
--
--  Every other writing function refuses to touch a month the shopkeeper has
--  closed — save_voucher, update_voucher, delete_voucher all check
--  books_locked_upto. transfer_stock never did, so goods could be moved in
--  and out of a filed month and the stock figures behind a filed return would
--  quietly change. Same check, same words.
--
--  SAFE TO RUN TWICE. Both functions are create-or-replace; nothing is
--  dropped and no data is touched.
--
--  Written without a begin/commit wrapper and with named dollar quotes,
--  because the Supabase SQL editor splits statements by counting begin and
--  end, and a plpgsql body has its own.
-- ===========================================================================


-- ---------------------------------------------------------------------------
--  1. THE COUNT
-- ---------------------------------------------------------------------------
--
--  p = { mdate, godown_id, note, lines: [ { item_id, counted, batch, expiry } ] }
--
--  Returns { adjusted, unchanged, lines: [ { item_id, was, now, diff } ] } so
--  the screen can tell him exactly what it changed rather than saying "done".

create or replace function public.adjust_stock(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $adj$
declare
  v_org    uuid := my_org_id();
  v_date   date := coalesce(nullif(p->>'mdate','')::date, today_ist());
  v_lock   date;
  v_godown uuid;
  v_note   text := nullif(btrim(coalesce(p->>'note','')), '');
  ln       jsonb;
  v_item   uuid;
  v_batch  text;
  v_expiry date;
  v_count  numeric;
  v_have   numeric;
  v_diff   numeric;
  n_done   int := 0;
  n_same   int := 0;
  out_lines jsonb := '[]'::jsonb;
begin
  -- A LOOK-ONLY LOGIN, AND A YEAR THAT HAS RUN OUT, BOTH STOP HERE.
  -- A stock correction is a write to the books like a bill is.
  perform assert_can_write();

  if v_org is null then
    raise exception 'This login is not linked to a firm yet';
  end if;

  -- A CLOSED MONTH IS CLOSED TO THIS TOO. A stock correction dated inside a
  -- filed period changes the stock figure behind a return already sent.
  select books_locked_upto into v_lock from orgs where id = v_org;
  if v_lock is not null and v_date <= v_lock then
    raise exception 'Your books are closed up to %. Count it into a month that is still open.',
      to_char(v_lock, 'DD Mon YYYY');
  end if;

  -- WHICH STORE THIS COUNT IS OF.
  --
  -- It has to be resolved the same way stock_in_hand_detail folds movements,
  -- or the "what the book says" figure this compares against would be read
  -- from a different pile than the one being written to. That view puts any
  -- movement with no godown on it, and all opening stock, into the MAIN
  -- store — so main is the fallback here too, not the default store.
  v_godown := coalesce(
    nullif(p->>'godown_id','')::uuid,
    (select id from godowns where org_id = v_org order by is_main desc, name limit 1));

  for ln in select * from jsonb_array_elements(coalesce(p->'lines','[]'::jsonb)) loop
    v_item := nullif(ln->>'item_id','')::uuid;
    if v_item is null then continue; end if;

    v_count := coalesce((ln->>'counted')::numeric, -1);
    -- A shelf cannot hold less than nothing. A blank or a minus is a slip of
    -- the thumb, and writing it would put the books further out than they
    -- were before he counted.
    if v_count < 0 then
      raise exception 'A counted quantity cannot be less than nothing';
    end if;

    v_batch  := nullif(ln->>'batch','');
    v_expiry := nullif(ln->>'expiry','')::date;

    -- WHAT THE BOOK SAYS, READ NOW.
    select coalesce(sum(qty), 0) into v_have
      from stock_in_hand_detail
     where org_id = v_org
       and item_id = v_item
       and godown_id is not distinct from v_godown
       and batch is not distinct from v_batch;

    v_diff := v_count - v_have;

    if v_diff = 0 then
      n_same := n_same + 1;
    else
      insert into stock_moves (org_id, item_id, mdate, qty_in, qty_out,
                               reason, godown_id, batch, expiry)
      values (v_org, v_item, v_date,
              case when v_diff > 0 then  v_diff else 0 end,
              case when v_diff < 0 then -v_diff else 0 end,
              'adjust', v_godown, v_batch, v_expiry);
      n_done := n_done + 1;
    end if;

    out_lines := out_lines || jsonb_build_object(
      'item_id', v_item, 'was', v_have, 'now', v_count, 'diff', v_diff);
  end loop;

  return jsonb_build_object('adjusted', n_done, 'unchanged', n_same,
                            'mdate', v_date, 'godown_id', v_godown,
                            'note', v_note, 'lines', out_lines);
end
$adj$;

revoke all on function public.adjust_stock(jsonb) from public;
grant execute on function public.adjust_stock(jsonb) to authenticated;


-- ---------------------------------------------------------------------------
--  2. THE SAME BOOKS LOCK ON A TRANSFER
-- ---------------------------------------------------------------------------
--
--  Unchanged in every other respect from the function already running; the
--  four new lines are the lock check.

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
  v_lock date;
  ln     jsonb;
  n      int := 0;
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
end
$xfer$;

revoke all on function public.transfer_stock(jsonb) from public;
grant execute on function public.transfer_stock(jsonb) to authenticated;


-- ---------------------------------------------------------------------------
--  3. THE OWNER CHECK THAT EVERY WRITING FUNCTION HAS TO PASS
-- ---------------------------------------------------------------------------
--
--  stock_moves refuses a direct write from the app and accepts one only from
--  a function owned by the same role as save_voucher. If this file were run
--  from a different Supabase login, adjust_stock would be created under that
--  login and every count would be refused at the moment of saving, with a
--  message about bills being written by the app's own steps. Better to say so
--  here, while he is still in the SQL editor, than on the shop floor.

do $chk$
declare want oid; got oid;
begin
  select proowner into want from pg_proc
   where oid = 'public.save_voucher(jsonb)'::regprocedure;
  select proowner into got  from pg_proc
   where oid = 'public.adjust_stock(jsonb)'::regprocedure;
  if want is not null and got is not null and want <> got then
    raise exception
      'adjust_stock was created by a different login from save_voucher, so stock_moves will refuse its writes. Run every Skwik migration from the same Supabase SQL editor login.';
  end if;
end
$chk$;
