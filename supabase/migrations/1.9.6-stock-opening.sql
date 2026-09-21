-- ===========================================================================
--  SKWIK 1.9.6 — the opening stock was missing from the detailed stock view
--
--  Run this whole file once in the Supabase SQL editor. It is safe to run
--  twice: it only replaces a view.
--
--  WHAT IT PUTS RIGHT
--
--  There are two stock views. `stock_in_hand` is the plain one, and it is
--  right: it takes the item's own opening figure and adds every movement
--  since. `stock_in_hand_detail` is the one a shop uses once it has more
--  than one godown, or keeps batches and expiry dates — and that one was
--  built from stock_moves ALONE.
--
--  An opening figure is not a movement. So for every shop that switched on
--  godowns, batches or expiry:
--
--    * an item that was imported with 400 pieces of opening stock and has
--      not been bought or sold since did not appear on the Stock screen at
--      all, and reads as "we do not stock that";
--    * every other item was short by exactly its opening figure, silently,
--      so the screen disagreed with the same shop's own Stock screen before
--      it turned batches on;
--    * the godown transfer screen refused to move goods that are on the
--      shelf, because as far as it could see they were not there.
--
--  The opening figure is now carried into the detailed view as well, as a
--  row of its own sitting in the shop's default godown with no batch on it —
--  which is what an opening figure is: goods that were already there before
--  anybody wrote down where they were.
--
--  Nothing is added twice: the union below reads items, the other half reads
--  stock_moves, and opening_stock is not a stock_move.
-- ===========================================================================

begin;

create or replace view public.stock_in_hand_detail
  with (security_invoker = 'on') as
  select
      x.org_id,
      x.item_id,
      x.item_name,
      x.unit,
      x.godown_id,
      g.name as godown_name,
      x.batch,
      x.expiry,
      sum(x.qty) as qty
  from (
      -- what has moved
      select
          m.org_id,
          m.item_id,
          i.name as item_name,
          i.unit,
          m.godown_id,
          m.batch,
          m.expiry,
          coalesce(m.qty_in, 0) - coalesce(m.qty_out, 0) as qty
      from public.stock_moves m
      join public.items i on i.id = m.item_id

      union all

      -- what was already on the shelf before anything moved
      select
          i.org_id,
          i.id as item_id,
          i.name as item_name,
          i.unit,
          o.default_godown_id as godown_id,
          null::text as batch,
          null::date as expiry,
          coalesce(i.opening_stock, 0) as qty
      from public.items i
      -- LEFT, not an inner join: the firm row is only read to find which
      -- godown is the main one, and an item must never disappear off the
      -- stock list because that lookup came back empty. With no default
      -- godown named the opening figure simply sits in none, which is the
      -- truthful answer — nobody has said where it is.
      left join public.orgs o on o.id = i.org_id
      where i.is_active
        and coalesce(i.opening_stock, 0) <> 0
  ) x
  left join public.godowns g on g.id = x.godown_id
  group by x.org_id, x.item_id, x.item_name, x.unit, x.godown_id, g.name,
           x.batch, x.expiry;

commit;
