-- ---------------------------------------------------------------------------
--  1.9.20 — THE ITEM REGISTER, ONE GODOWN AT A TIME
--
--  The Stock screen has a strip along the top: Everywhere, then one button
--  per store. Tapping an item opened its register — and the register ignored
--  the strip completely. A shop with a shop-front and a godown across the
--  lane opened "Godown" on the stock screen, tapped an item, and was shown
--  every movement in the firm.
--
--  Two different questions, and only one of them was being answered:
--
--    EVERYWHERE      how many does the firm hold. Moving a carton from one's
--                    own godown to one's own shop changes nothing here, so
--                    those two lines are noise — and worse, they double the
--                    IN and OUT totals with goods that were never bought or
--                    sold. The app drops them.
--
--    ONE STORE       what happened on THIS shelf:
--                      opening
--                      + purchase        + moved in from the other store
--                      − sale            − moved out to the other store
--                    which is exactly the rows carrying that godown, and an
--                    opening figure worked out for that godown alone.
--
--  This adds a fourth argument rather than changing the old function, so a
--  phone that has not been updated yet goes on calling the three-argument
--  one and nothing breaks either way.
--
--  Opening stock — the figure typed against the item when the shop started —
--  sits in the MAIN store, which is how stock_in_hand_detail has always read
--  it. A second godown's register therefore opens at whatever was moved into
--  it, which is the truth: nothing was ever counted onto that shelf by hand.
--
--  Safe to run twice.
-- ---------------------------------------------------------------------------
begin;

create or replace function public.item_moves(
  p_item uuid, p_from date, p_to date, p_godown uuid)
returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare
  v_org  uuid := my_org_id();
  v_main uuid;
  v_open numeric;
  v_rows jsonb;
begin
  if v_org is null then raise exception 'This login is not linked to a firm yet'; end if;
  if not exists (select 1 from items where id = p_item and org_id = v_org) then
    raise exception 'That item is not on your list';
  end if;

  -- A movement with no godown on it belongs to the main store. That is how
  -- every row written before godowns were switched on reads.
  select id into v_main
    from godowns where org_id = v_org
   order by is_main desc, name
   limit 1;

  if p_godown is not null and not exists (
       select 1 from godowns where id = p_godown and org_id = v_org) then
    raise exception 'That store is not yours';
  end if;

  select case when p_godown is null or p_godown = v_main
              then coalesce((select opening_stock from items where id = p_item), 0)
              else 0 end
       + coalesce((select sum(coalesce(qty_in,0) - coalesce(qty_out,0))
                     from stock_moves
                    where org_id = v_org and item_id = p_item and mdate < p_from
                      and (p_godown is null
                           or coalesce(godown_id, v_main) = p_godown)), 0)
    into v_open;

  select coalesce(jsonb_agg(x order by x->>'mdate', x->>'created_at'), '[]'::jsonb)
    into v_rows
    from (
      select jsonb_build_object(
               'id',         m.id,
               'mdate',      m.mdate,
               'reason',     m.reason,
               'qty_in',     coalesce(m.qty_in, 0),
               'qty_out',    coalesce(m.qty_out, 0),
               'voucher_id', m.ref_voucher_id,
               'voucher_no', v.voucher_no,
               'vtype',      v.vtype,
               'party',      coalesce(nullif(v.printed_name, ''), p.name),
               'godown',     coalesce(g.name, mg.name),
               'godown_id',  coalesce(m.godown_id, v_main),
               'batch',      m.batch,
               'expiry',     m.expiry,
               'rate',       l.rate,
               'created_at', coalesce(v.created_at, m.mdate::timestamptz)
             ) as x
        from stock_moves m
        left join vouchers v on v.id = m.ref_voucher_id
        left join parties  p on p.id = v.party_id
        left join godowns  g on g.id = m.godown_id
        left join godowns  mg on mg.id = v_main
        left join lateral (
               select vl.rate
                 from voucher_lines vl
                where vl.voucher_id = m.ref_voucher_id
                  and vl.item_id = m.item_id
                limit 1
             ) l on true
       where m.org_id = v_org
         and m.item_id = p_item
         and m.mdate between p_from and p_to
         and (p_godown is null or coalesce(m.godown_id, v_main) = p_godown)
    ) y;

  return jsonb_build_object('opening', v_open, 'rows', v_rows);
end $$;

revoke all on function public.item_moves(uuid, date, date, uuid) from public;
grant execute on function public.item_moves(uuid, date, date, uuid) to authenticated;

-- ---------------------------------------------------------------------------
--  AND: A COUNTER BOY WHO TAPPED THE WRONG BUTTON WAS STUCK FOR EVER
--
--  The man who is going to work at the counter installs Skwik, makes his own
--  login, and is shown a screen headed "Your shop" with a Start billing
--  button on it. Of course he taps it. From that moment his login owns an
--  empty shop of its own, join_org refuses him — "This login already belongs
--  to another shop" — and there is no way back: the shop code has nowhere
--  left to be typed, on any screen, ever.
--
--  So: a login may walk out of a shop that is EMPTY — nothing billed, nobody
--  else in it, and it is his own. That is a shop that was made by accident
--  and holds nothing anybody could lose. A shop with so much as one bill in
--  it is untouched, and the old refusal stands.
-- ---------------------------------------------------------------------------

create or replace function public.join_org(p_code text) returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare
  v_org  uuid;
  v_name text;
  v_open boolean;
  v_till timestamptz;
  v_mine uuid;
  v_empty boolean;
begin
  if auth.uid() is null then raise exception 'Not logged in'; end if;

  select id, name, join_open, join_open_until
    into v_org, v_name, v_open, v_till
    from orgs where upper(join_code) = upper(trim(p_code));

  if v_org is null then
    raise exception 'No shop has that code. Check it with the owner.';
  end if;
  if not coalesce(v_open, false) or (v_till is not null and v_till < now()) then
    raise exception 'That code is closed. Ask the owner to open it from Staff, then try again.';
  end if;

  select org_id into v_mine from profiles where id = auth.uid();

  if v_mine is not null and v_mine <> v_org then
    -- Is the shop he is standing in one he made by accident and never used?
    select not exists (select 1 from vouchers      where org_id = v_mine)
       and not exists (select 1 from items         where org_id = v_mine)
       and not exists (select 1 from parties       where org_id = v_mine)
       and not exists (select 1 from payments      where org_id = v_mine)
       and not exists (select 1 from profiles      where org_id = v_mine
                                                     and id <> auth.uid())
       and exists     (select 1 from orgs          where id = v_mine
                                                     and (owner_id = auth.uid()
                                                          or owner_id is null))
      into v_empty;

    if not coalesce(v_empty, false) then
      raise exception 'This login already belongs to another shop.';
    end if;

    -- Let go of it first, then take it away, so nothing is left pointing at
    -- a row that is about to go.
    update profiles set org_id = null where id = auth.uid();
    delete from orgs where id = v_mine;
  end if;

  insert into profiles (id, org_id, role) values (auth.uid(), v_org, 'staff')
    on conflict (id) do update set org_id = v_org, role = 'staff';

  -- one phone per opening: the door shuts behind him
  update orgs set join_open = false, join_open_until = null where id = v_org;

  return jsonb_build_object('org_id', v_org, 'name', v_name, 'role', 'staff');
end $$;

revoke all on function public.join_org(text) from public;
grant execute on function public.join_org(text) to authenticated;

-- ---------------------------------------------------------------------------
--  AND: THE THUMB RAIL
--
--  Type "steel" and four things match. Picking the third one means either
--  typing more of the name or reaching a thumb up into the middle of the
--  screen, and a man billing one-handed across a counter does neither
--  comfortably. So: a bar down the right of the list — one big down arrow
--  that walks the highlight one line at a time, and a small OK that puts the
--  highlighted item on the bill. The thumb never leaves the bottom corner.
--
--  Off unless a shop asks for it, because a shop with three items never needs
--  it and a control nobody wants is a control in the way.
-- ---------------------------------------------------------------------------

alter table public.orgs
  add column if not exists thumb_rail boolean not null default false;

commit;
