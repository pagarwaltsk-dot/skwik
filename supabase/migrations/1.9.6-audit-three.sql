-- ===========================================================================
--  SKWIK 1.9.6  —  the third audit
--
--  Run after 1.9.3, 1.9.4 and 1.9.5. Safe to run twice. Changes no data.
-- ===========================================================================

begin;

-- ---------------------------------------------------------------------------
--  THE WRONG ADVICE WHEN THE BOOKS ARE CLOSED
--
--  Entering a bill dated inside a filed month was refused with "Raise a credit
--  note instead of changing a bill in a filed month". That is right when he is
--  CHANGING a bill. It is nonsense when he is ENTERING one — and entering one
--  late is the ordinary case: a supplier's August bill reaches the shop in
--  September and is typed in then. A credit note is no use to him at all, and
--  the sentence sends him looking for one.
--
--  For a purchase the honest answer is that the input credit can still be
--  claimed in an open month. For a sale it is that the note goes against the
--  original bill. One sentence covers both.
--
--  This is a wording change and nothing else, so if the sentence is not found
--  the migration says so and carries on rather than failing over it.
-- ---------------------------------------------------------------------------

do $$
declare
  f record;
  def text;
  old_msg constant text :=
    'Your books are closed up to %. Raise a credit note instead of changing a bill in a filed month.';
  new_msg constant text :=
    'Your books are closed up to %. Date this in a month that is still open — for a purchase the input credit can still be claimed there, and for a sale raise a credit note against the original bill.';
  n int := 0;
begin
  for f in
    select p.oid, p.oid::regprocedure::text sig
      from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
     where ns.nspname = 'public' and p.proname = 'save_voucher'
  loop
    def := pg_get_functiondef(f.oid);
    if position(old_msg in def) = 0 then continue; end if;
    execute replace(def, old_msg, new_msg);
    n := n + 1;
  end loop;
  if n = 0 then
    raise notice 'the books-closed sentence was not found in save_voucher; leaving it as it is';
  else
    raise notice 'the books-closed sentence now fits entering a bill as well as changing one';
  end if;
end $$;

commit;

-- ===========================================================================
--  THE DETAILED STOCK VIEW NEVER KNEW ABOUT OPENING STOCK
--
--  Skwik keeps two views of what is on the shelf. The plain one adds the
--  opening figure to the movements. The detailed one — the one every screen
--  switches to the moment batches, expiry or godowns are turned on — is a
--  GROUP BY over stock_moves alone, and an opening quantity is not a movement.
--
--  So a shop that turns godowns on sees every item's stock fall by exactly the
--  amount it actually has. Measured on a test shop: 48 bundles showed as -2,
--  99 drums as -1, 50 bags as -30. The stock screen then drops anything that
--  comes to zero out of the list altogether, and the godown screen refuses to
--  move goods it says are not there.
--
--  The same view also lost the stock that existed BEFORE godowns were switched
--  on, because those movements carry no godown. Both belong in the main store,
--  which is what the godown screen already promises in writing.
-- ===========================================================================

begin;

-- WITH THE FLAG IT WAS DECLARED WITH.
--
-- Leaving this clause off is what 1.9.9 had to go and put right: CREATE OR
-- REPLACE VIEW REPLACES a view's options rather than carrying them over, so
-- a replace with no WITH clause silently strips security_invoker and the view
-- starts reading its tables as its owner, with row security bypassed.
--
-- 1.9.9 repairs a database where that has already happened. This restates it
-- here as well, so that re-running THIS file on its own — to put the view
-- back after some later change — cannot quietly open the same hole a second
-- time, with no 1.9.9 following it.
create or replace view public.stock_in_hand_detail
  with (security_invoker = 'on') as
with main as (
  select distinct on (org_id) org_id, id, name
    from godowns
   order by org_id, is_main desc, name
)
-- what has actually moved
select m.org_id,
       m.item_id,
       i.name  as item_name,
       i.unit,
       coalesce(m.godown_id, mn.id)   as godown_id,
       coalesce(g.name, mn.name)      as godown_name,
       m.batch,
       m.expiry,
       sum(coalesce(m.qty_in, 0) - coalesce(m.qty_out, 0)) as qty
  from stock_moves m
  join items i on i.id = m.item_id
  left join godowns g on g.id = m.godown_id
  left join main mn   on mn.org_id = m.org_id
 group by m.org_id, m.item_id, i.name, i.unit,
          coalesce(m.godown_id, mn.id), coalesce(g.name, mn.name), m.batch, m.expiry

union all

-- and what was there to begin with, which sits in the main store
select i.org_id,
       i.id,
       i.name,
       i.unit,
       mn.id,
       mn.name,
       null::text,
       null::date,
       i.opening_stock
  from items i
  left join main mn on mn.org_id = i.org_id
 where i.is_active
   and coalesce(i.opening_stock, 0) <> 0;

commit;
