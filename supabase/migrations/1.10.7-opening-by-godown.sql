-- ===========================================================================
--  1.10.7  THE OPENING STOCK, IN THE STORE IT IS ACTUALLY IN
--
--  WHAT WAS WRONG
--
--  Tally does not hold one opening figure per item. It holds one per item PER
--  GODOWN, and his are spread across five stores:
--
--    Steel Utensils (A)   18,049.15 Kg in all
--       Chamber Road  3,652.06     TRANSPORT  7,393.29
--       Na-Paukhry    6,890.70     R(3rd)       113.10
--
--  The import read only the item's total and wrote it to items.opening_stock,
--  which belongs to no store at all. So the TOTAL stock was right and the
--  godown-wise view was empty -- and for a shop that moves goods between two
--  stores every day, the godown-wise view is the one that matters.
--
--  WHY A FUNCTION AND NOT AN INSERT
--
--  stock_moves is RPC-only: a client that writes to it straight is refused by
--  its own trigger, because a movement written by hand skips the numbering,
--  the books lock and everything else that makes a movement true. So the
--  opening goes in through a function, like every other movement does.
--
--  WHY A MOVEMENT AND NOT A FIELD
--
--  A movement has a store against it and a field does not. Once the opening is
--  a movement, items.opening_stock has to go back to nought for that item or
--  every figure counts it twice -- the stock views are opening_stock PLUS the
--  movements. Both happen here, together, so neither can be left half done.
--
--  PRESSING IT TWICE IS SAFE. Each opening movement carries an id worked out
--  from the firm, the item and the store, so a second import writes over the
--  same row rather than adding another. If Tally's opening figure changes, the
--  row changes with it.
-- ===========================================================================

create or replace function public.set_opening_stock(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $sos$
declare
  v_org   uuid := my_org_id();
  v_date  date := coalesce(nullif(p->>'mdate','')::date, date_trunc('year', today_ist())::date);
  v_lock  date;
  ln      jsonb;
  v_item  uuid;
  v_god   uuid;
  v_qty   numeric;
  v_cost  numeric;
  v_id    uuid;
  n_rows  int := 0;
  n_items int := 0;
  touched uuid[] := '{}';
begin
  perform assert_can_write();
  if v_org is null then raise exception 'This login is not linked to a firm yet'; end if;
  if my_role() <> 'owner' then
    raise exception 'Only the owner can set the opening stock';
  end if;

  -- A CLOSED MONTH IS CLOSED TO THIS TOO.
  select books_locked_upto into v_lock from orgs where id = v_org;
  if v_lock is not null and v_date <= v_lock then
    raise exception 'Your books are closed up to %. The opening stock is dated %, which is inside that.',
      to_char(v_lock, 'DD Mon YYYY'), to_char(v_date, 'DD Mon YYYY');
  end if;

  for ln in select * from jsonb_array_elements(coalesce(p->'rows', '[]'::jsonb))
  loop
    v_item := nullif(ln->>'item', '')::uuid;
    v_god  := nullif(ln->>'godown', '')::uuid;
    v_qty  := coalesce((ln->>'qty')::numeric, 0);
    v_cost := coalesce((ln->>'cost')::numeric, 0);

    -- ANOTHER FIRM'S ITEM IS NOT AN ITEM. Both references are checked rather
    -- than trusted, because this function runs as its definer and a bad id
    -- would otherwise write into somebody else's books.
    if v_item is null then continue; end if;
    if not exists (select 1 from items i where i.id = v_item and i.org_id = v_org) then
      raise exception 'That item is not in your books';
    end if;
    if v_god is not null
       and not exists (select 1 from godowns g where g.id = v_god and g.org_id = v_org) then
      raise exception 'That store is not in your books';
    end if;
    if v_qty = 0 then continue; end if;

    -- the same opening is the same row, whichever import writes it
    v_id := md5('opening|' || v_org::text || '|' || v_item::text
                || '|' || coalesce(v_god::text, 'nowhere'))::uuid;

    insert into stock_moves (id, org_id, item_id, mdate, qty_in, qty_out,
                             reason, godown_id)
    values (v_id, v_org, v_item, v_date, greatest(v_qty, 0), greatest(-v_qty, 0),
            'opening stock', v_god)
    on conflict (id) do update
      set qty_in  = excluded.qty_in,
          qty_out = excluded.qty_out,
          mdate   = excluded.mdate,
          godown_id = excluded.godown_id;
    n_rows := n_rows + 1;

    -- AND THE FLAT FIGURE GOES, or the stock is counted twice: every view
    -- reads opening_stock PLUS the movements.
    if not (v_item = any(touched)) then
      update items
         set opening_stock = 0,
             purchase_price = case when coalesce(purchase_price, 0) = 0 and v_cost > 0
                                   then v_cost else purchase_price end
       where id = v_item and org_id = v_org;
      touched := touched || v_item;
      n_items := n_items + 1;
    elsif v_cost > 0 then
      update items set purchase_price = v_cost
       where id = v_item and org_id = v_org and coalesce(purchase_price, 0) = 0;
    end if;
  end loop;

  return jsonb_build_object('rows', n_rows, 'items', n_items, 'on', v_date);
end
$sos$;

revoke all on function public.set_opening_stock(jsonb) from public;
grant execute on function public.set_opening_stock(jsonb) to authenticated;
