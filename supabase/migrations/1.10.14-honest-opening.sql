-- ===========================================================================
--  THE FIGURE CALLED "OPENING" WAS NOT THE OPENING.
--
--  A year of a busy shop is four thousand movements and 1.7 MB down a mobile
--  line, so money_book hands back the most recent few hundred and folds every
--  earlier one into the opening figure. That keeps the running balance and the
--  closing figure exactly right -- and it means the number printed under
--  OPENING is "the balance at the start of the lines you can see", which for a
--  whole year is his opening balance plus three thousand four hundred entries.
--
--  He read it as his opening balance, because that is what it says. On "This
--  year" it showed 35,20,075 where his opening cash was 2,00,000. Narrow the
--  window to a few days and it came right, which is what made it look like a
--  fault that came and went.
--
--  A ledger page has solved this for four hundred years: it prints the true
--  opening, and then a carried-forward line for what it could not fit. So this
--  returns both, and the screen can stop calling one the other.
--
--    opening   -- the balance on the day the period began. His figure.
--    brought   -- that plus the entries folded away, which is where the first
--                 visible line actually starts from.
--    folded    -- how many were folded, so the screen can say so.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.money_book(p_from date, p_to date, p_account uuid DEFAULT NULL::uuid, p_cash boolean DEFAULT true, p_limit integer DEFAULT 400) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $mbk$
declare
  v_org   uuid := my_org_id();
  v_open  numeric := 0;
  v_rows  jsonb;
  v_skip  numeric := 0;
  v_count integer := 0;
  v_fold  integer := 0;
  v_lim   integer := greatest(coalesce(p_limit, 400), 50);
begin
  if v_org is null then raise exception 'This login is not linked to a firm yet'; end if;

  -- where it started
  if p_cash then
    select coalesce(opening_cash, 0) into v_open from orgs where id = v_org;
  elsif p_account is null then
    select coalesce(sum(coalesce(opening, 0)), 0) into v_open
      from bank_accounts where org_id = v_org;
  else
    select coalesce(opening, 0) into v_open
      from bank_accounts where id = p_account and org_id = v_org;
  end if;
  v_open := coalesce(v_open, 0);

  -- plus everything that moved before this period
  v_open := v_open
    + coalesce((select sum(case when ptype = 'receipt' then amount else -amount end)
                  from payments
                 where org_id = v_org and pdate < p_from
                   and ((p_cash and mode = 'cash')
                     or (not p_cash and mode = 'bank'
                         and (p_account is null or account_id = p_account)))), 0)
    - coalesce((select sum(amount) from expenses
                 where org_id = v_org and edate < p_from
                   and ((p_cash and mode = 'cash')
                     or (not p_cash and mode = 'bank'
                         and (p_account is null or account_id = p_account)))), 0);

  -- AND WHAT HE BANKED BEFORE THE PERIOD BEGAN.
  --
  -- On the cash side a deposit went out of the till; on the bank side the same
  -- deposit came in. Left out of the opening figure, every line of the book
  -- after it carries a running balance that is wrong by the same amount.
  v_open := v_open
    + coalesce((select sum(case when p_cash
                                then case when direction = 'deposit' then -amount else amount end
                                else case when direction = 'deposit' then  amount else -amount end
                           end)
                  from cash_moves
                 where org_id = v_org and mdate < p_from
                   and (p_cash or p_account is null or account_id = p_account)), 0);

  with moved as (
      select p.id, 'payment' as kind, p.pdate as d,
             coalesce(pa.name, nullif(v.printed_name, ''), 'CASH') as who,
             case when p.ptype = 'receipt' then 'Received' else 'Paid' end as what,
             p.note,
             case when p.ptype = 'receipt' then p.amount else 0 end as amt_in,
             case when p.ptype = 'receipt' then 0 else p.amount end as amt_out,
             p.created_at
        from payments p
        left join parties  pa on pa.id = p.party_id
        left join vouchers v  on v.id  = p.ref_voucher_id
       where p.org_id = v_org and p.pdate between p_from and p_to
         and ((p_cash and p.mode = 'cash')
           or (not p_cash and p.mode = 'bank'
               and (p_account is null or p.account_id = p_account)))

      union all

      select e.id, 'expense', e.edate, e.head, 'Spent', e.note,
             0, e.amount, e.created_at
        from expenses e
       where e.org_id = v_org and e.edate between p_from and p_to
         and ((p_cash and e.mode = 'cash')
           or (not p_cash and e.mode = 'bank'
               and (p_account is null or e.account_id = p_account)))

      union all

      -- THE DEPOSIT ITSELF, ON BOTH SIDES OF THE HOUSE.
      select cm.id, 'cash_move', cm.mdate,
             coalesce(b.name, 'Bank') as who,
             case when cm.direction = 'deposit' then 'Paid into bank'
                  else 'Taken from bank' end as what,
             cm.note,
             case when (cm.direction = 'deposit') = p_cash then 0 else cm.amount end as amt_in,
             case when (cm.direction = 'deposit') = p_cash then cm.amount else 0 end as amt_out,
             cm.created_at
        from cash_moves cm
        left join bank_accounts b on b.id = cm.account_id
       where cm.org_id = v_org and cm.mdate between p_from and p_to
         and (p_cash or p_account is null or cm.account_id = p_account)
  ),
  ranked as (
      select moved.*,
             row_number() over (order by d, created_at) as rn,
             count(*)     over ()                        as n
        from moved
  )
  select coalesce(sum(amt_in - amt_out) filter (where rn <= n - v_lim), 0),
         coalesce(count(*) filter (where rn <= n - v_lim), 0),
         coalesce(jsonb_agg(jsonb_build_object(
             'id', id, 'kind', kind, 'd', d, 'who', who, 'what', what,
             'note', note, 'in', amt_in, 'out', amt_out, 'created_at', created_at)
           order by rn) filter (where rn > n - v_lim), '[]'::jsonb),
         coalesce(max(n), 0)
    into v_skip, v_fold, v_rows, v_count
    from ranked;

  return jsonb_build_object(
    -- THE TRUE OPENING OF THE PERIOD. This is his figure, and it is what the
    -- screen should print under the word OPENING.
    'opening', round(v_open, 2),
    -- and where the first line he can see actually starts from
    'brought', round(v_open + coalesce(v_skip, 0), 2),
    'folded',  coalesce(v_fold, 0),
    'rows',    v_rows,
    'total',   v_count,
    'shown',   least(v_count, v_lim),
    'more',    v_count > v_lim);
end $mbk$;

revoke all on function public.money_book(date, date, uuid, boolean, integer) from public;
grant execute on function public.money_book(date, date, uuid, boolean, integer) to authenticated;
