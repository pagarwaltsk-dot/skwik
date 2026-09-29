-- ===========================================================================
--  THE OPENING STOCK IS NOT A PURCHASE.
--
--  His own screen, Steel Utensils (A), "This year":
--
--      OPENING  0 kg        IN  76,906 kg      OUT  52,602.69 kg
--      CLOSING  24,303.31 kg
--
--      01/04/26  opening stock · R(3rd)            +113.10
--      01/04/26  opening stock · Chamber Road    +3,652.06
--      01/04/26  opening stock · TRANSPORT       +7,393.29
--      01/04/26  opening stock · Na-Paukhry      +6,890.70
--
--  Eighteen thousand kilos of opening stock, sitting in the register as four
--  inward movements, and OPENING reading nought above them.
--
--  WHY. 1.10.7 moved opening stock out of items.opening_stock and into dated
--  movements, so it could say WHICH STORE the goods are in. Those movements
--  are dated the first day of the year. This function works its opening figure
--  out as "everything dated BEFORE the period began" — and the first of April
--  is not before the first of April. So on "This year" the opening fell inside
--  the period, was counted as goods coming in, and the opening figure had
--  nothing left to show. Narrow the window to this month and it came right,
--  because then the first of April really is earlier.
--
--  This is the same fault as the one in the cash and bank book that 1.10.14
--  put right, in the other book and by another route: a figure headed OPENING
--  that was not the opening. I fixed the money side and did not think to look
--  at the goods side. He found it in a screenshot.
--
--  THE RULE. An opening stock figure is a BALANCE, not a transaction. Tally
--  prints it as Opening Balance and never as an inward. So:
--
--    opening = everything dated before the period
--            + every opening-stock figure dated INSIDE the period
--
--  and those opening-stock rows then come out of the list, because a running
--  balance beside each line would otherwise count them twice. The two terms
--  can never overlap: one is dated before p_from and the other on or after it.
--
--  CLOSING DOES NOT MOVE. It is opening + in - out however the three are
--  divided up, so his 24,303.31 is 24,303.31 before and after. What changes is
--  that 18,049.15 of it stops calling itself a purchase.
--
--  It also hands back WHERE the opening sits, store by store, so the register
--  can still show him the four lines he had — as the breakdown of one figure
--  rather than as four arrivals.
--
--  Safe to run twice. It writes nothing.
-- ===========================================================================

create or replace function public.item_moves(
  p_item uuid, p_from date, p_to date, p_godown uuid)
returns jsonb
language plpgsql security definer set search_path to 'public' as $im$
declare
  v_org  uuid := my_org_id();
  v_main uuid;
  v_open numeric;
  v_at   jsonb;
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

  select
      -- the flat figure, for a shop whose opening has not been placed by
      -- store yet. 1.10.7 puts this back to nought as it moves each one, so
      -- for his books it is already zero and adds nothing.
      case when p_godown is null or p_godown = v_main
           then coalesce((select opening_stock from items where id = p_item), 0)
           else 0 end
      -- everything that happened before the period began
    + coalesce((select sum(coalesce(qty_in,0) - coalesce(qty_out,0))
                  from stock_moves
                 where org_id = v_org and item_id = p_item and mdate < p_from
                   and (p_godown is null
                        or coalesce(godown_id, v_main) = p_godown)), 0)
      -- AND THE OPENING FIGURES DATED INSIDE IT, which are the shelf as it
      -- stood when the period opened and not goods arriving during it
    + coalesce((select sum(coalesce(qty_in,0) - coalesce(qty_out,0))
                  from stock_moves
                 where org_id = v_org and item_id = p_item
                   and reason = 'opening stock'
                   and mdate between p_from and p_to
                   and (p_godown is null
                        or coalesce(godown_id, v_main) = p_godown)), 0)
    into v_open;

  -- WHERE THAT OPENING SITS, so the register can still show him the stores it
  -- came from rather than simply swallowing four lines he could see before.
  select coalesce(jsonb_agg(jsonb_build_object('godown', t.name, 'qty', t.qty)
                            order by t.qty desc, t.name), '[]'::jsonb)
    into v_at
    from (
      select coalesce(g.name, mg.name, 'your main store') as name,
             round(sum(coalesce(m.qty_in,0) - coalesce(m.qty_out,0)), 3) as qty
        from stock_moves m
        left join godowns g  on g.id = m.godown_id
        left join godowns mg on mg.id = v_main
       where m.org_id = v_org and m.item_id = p_item
         and m.reason = 'opening stock'
         and m.mdate <= p_to
         and (p_godown is null or coalesce(m.godown_id, v_main) = p_godown)
       group by coalesce(g.name, mg.name, 'your main store')
    ) t
   where t.qty <> 0;

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
         -- counted in the opening above, so not a line as well
         and coalesce(m.reason, '') <> 'opening stock'
         and (p_godown is null or coalesce(m.godown_id, v_main) = p_godown)
    ) y;

  return jsonb_build_object('opening', v_open, 'opening_at', v_at, 'rows', v_rows);
end $im$;

revoke all on function public.item_moves(uuid, date, date, uuid) from public;
grant execute on function public.item_moves(uuid, date, date, uuid) to authenticated;
