-- ===========================================================================
--  THE STOCK LIST, WITHOUT THE WAIT.
--
--  "stock loading lagged for few seconds, why?" -- and it was not the database.
--  Measured here on a shop his size, 503 items over 5 stores with 11,833
--  movements, as the shopkeeper and with row security on:
--
--      stock_in_hand_detail        2,515 rows     788 kB      76 ms
--      stock_summary                 503 rows      99 kB      21 ms
--
--  Because the screen asks for stock_in_hand_detail, which is one row per item
--  PER STORE PER BATCH with the item's full name repeated in every one of them,
--  and folds them into a summary on the phone. His item names run to fifty
--  characters and they are sent two and a half thousand times.
--
--  Five times the rows and eight times the bytes, for a screen that draws one
--  line per item -- over a mobile pack, parsed on a cheap phone. A shop with
--  three thousand items would download four and a half megabytes, decide Skwik
--  is slow, and never be able to say why.
--
--  So: ask for the level being shown, and let the database do the adding up.
--
--  THIS READS stock_in_hand_detail. IT DOES NOT COPY IT.
--
--  That view has two rules in it that took two releases to get right -- stock
--  that moved before godowns were switched on belongs to the MAIN store, and
--  an item's opening figure lives in items.opening_stock until the day it is
--  set store by store. A second copy of those rules here would drift from the
--  first one the next time either changes, and the figures on this screen
--  would quietly stop matching every other screen. So it selects from the view
--  and only folds what comes back.
--
--  The view is security_invoker, and this function is security definer, so the
--  view's own row security does not apply inside here -- org_id = my_org_id()
--  below is what keeps one shop out of another's stock, and it is not optional.
--
--  Read-only. It writes nothing.
-- ===========================================================================

create or replace function public.stock_summary(p_godown uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $ss$
declare
  v_org uuid := my_org_id();
  v     jsonb;
begin
  if v_org is null then raise exception 'This login is not linked to a firm yet'; end if;

  -- ONE ROW PER ITEM, and the name sent once.
  --   id  the item          q  how much is left
  --   n   its name          s  the stores it is spread across, when more than
  --   u   its unit             one -- so the screen can still print
  --                            "Chamber Road + Na-Paukhry" without being sent
  --                            a row for each of them
  --
  -- p_godown null means everywhere; give it a store and the answer is what is
  -- in THAT store.
  --
  -- NOTHING IS DROPPED FOR BEING NOUGHT. An item he has none of is still one
  -- of his items, and it is the screen -- his "hide what I have none of" tick
  -- -- that decides whether to show it. A function that quietly left them out
  -- would take that choice away from him.
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', t.item_id,
           'n',  t.item_name,
           'u',  t.unit,
           'q',  t.qty,
           's',  t.stores) order by t.item_name, t.item_id), '[]'::jsonb)
    into v
    from (
      select d.item_id,
             d.item_name,
             d.unit,
             round(sum(coalesce(d.qty, 0)), 3) as qty,
             case when count(distinct d.godown_name) > 1
                  then to_jsonb(array_agg(distinct d.godown_name)
                                  filter (where d.godown_name is not null))
                  else null end as stores
        from stock_in_hand_detail d
       where d.org_id = v_org
         and (p_godown is null or d.godown_id = p_godown)
       group by d.item_id, d.item_name, d.unit
    ) t;

  return v;
end $ss$;

revoke all on function public.stock_summary(uuid) from public;
grant execute on function public.stock_summary(uuid) to authenticated;
