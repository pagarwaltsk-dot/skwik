-- ===========================================================================
--  IN AND OUT WERE OF THE LINES YOU CAN SEE. OPENING AND CLOSING WERE NOT.
--
--  1.10.14 made the OPENING figure on the cash and bank book honest, and left
--  the two cells standing next to it exactly as they were. The card reads:
--
--      OPENING   IN   OUT
--      ----------------------
--      CLOSING
--
--  OPENING is the true opening of the period. CLOSING is the true closing.
--  IN and OUT were summed on the phone over the movements it had been sent --
--  the newest four hundred -- because a year of a busy shop is four thousand
--  of them and 1.7 MB down a mobile line.
--
--  So on "This year" the four figures do not close. His own cash book: opening
--  2,00,000, closing 35,20,075, and between them an IN and an OUT covering
--  perhaps a tenth of the money that actually went through the till, under two
--  headings that say nothing about it. Add them up and the answer is nowhere
--  near the closing figure printed two lines below.
--
--  I fixed the figure he complained about and did not look at the two beside
--  it. That is the same mistake as the opening stock on the item register --
--  the same word, the same card, half-corrected -- and it is why this pass
--  went looking for the class rather than the case.
--
--  The page cannot mend this by itself: what it is handed of the folded-away
--  movements is their NET, and a net cannot be taken apart into an in and an
--  out. So the two figures are worked out here, over every movement of the
--  period, and sent with the rest.
--
--  Nothing else changes. Read-only, safe to run twice.
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
  v_in    numeric := 0;
  v_out   numeric := 0;
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
         coalesce(max(n), 0),
         -- AND THE WHOLE PERIOD'S IN AND OUT, over every movement and not
         -- only the ones being sent. Without these two the page cannot work
         -- them out at all: what it is handed of the earlier movements is
         -- their NET, and a net cannot be taken apart again.
         coalesce(sum(amt_in), 0),
         coalesce(sum(amt_out), 0)
    into v_skip, v_fold, v_rows, v_count, v_in, v_out
    from ranked;

  return jsonb_build_object(
    -- THE TRUE OPENING OF THE PERIOD. This is his figure, and it is what the
    -- screen should print under the word OPENING.
    'opening', round(v_open, 2),
    -- what came in and what went out across the WHOLE period
    'in',      round(v_in, 2),
    'out',     round(v_out, 2),
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
