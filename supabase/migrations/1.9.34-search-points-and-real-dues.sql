-- ---------------------------------------------------------------------------
--  1.9.34 — TWO THINGS HE ASKED FOR
--
--  1. POINTS ON AN ITEM, 1 TO 10.
--
--     Two items match "tel" — the mustard oil he sells forty times a day and
--     the brake oil he has sold twice this year. Skwik had no way of telling
--     which, so it put the shorter name first and he scrolled. He does know,
--     so now he can say: 10 shows first, 1 shows last, nothing set behaves
--     exactly as before.
--
--     It is deliberately out of the way — under "More details" on the item —
--     because a shop should never have to fill it in to sell anything.
--
--  2. FILL A MONTH STOPS INVENTING TRADE THAT NEVER HAPPENED.
--
--     A customer carrying 1,25,000 from before Skwik paid 70,000 during the
--     month. That receipt had no bill against it, so Fill a month wrote 70,000
--     of goods to explain it — and left the customer owing money he had
--     already paid down.
--
--     The receipt was never unexplained. THE OPENING DUE EXPLAINED IT. The
--     only money that actually needs a bill is the part that pushes an account
--     into CREDIT: rupees in hand that nothing he owes can account for.
--
--     So unbilled_receipts now hands back, on every row, how much credit that
--     customer's own ledger shows at the end of the period. The app bills no
--     more than that, and a customer who was still in debt on the last day of
--     the period is left alone.
--
--     Nothing else reads this function, and it is still read-only.
--
--  Safe to run twice. Nothing is deleted and no figure in his books moves.
--
--  NO begin/commit AND A NAMED DOLLAR QUOTE, ON PURPOSE.
--
--  The Supabase SQL editor splits what it is given into statements before it
--  sends them, and it counts `begin` and `end` while it does. A plpgsql body
--  has its own begin and end inside it, so wrapping the file in begin/commit
--  made it lose track and hand Postgres half a function: "unterminated
--  dollar-quoted string". The tag $ubr$ instead of a bare $$ keeps the body
--  whole for the same reason. Every statement here is safe on its own, so no
--  transaction is needed to hold them together.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------- 1. points

alter table public.items
  add column if not exists priority smallint not null default 0;

alter table public.items
  drop constraint if exists items_priority_ck;
alter table public.items
  add constraint items_priority_ck check (priority between 0 and 10);

comment on column public.items.priority is
  'How near the top of the search this item should sit: 1 to 10, 10 first. 0 means he has not said.';


-- --------------------------------------------- 2. what a receipt still owes

create or replace function public.unbilled_receipts(p_from date, p_to date)
returns jsonb
language plpgsql security definer
set search_path to 'public'
as $ubr$
declare
  v_org uuid := my_org_id();
  v     jsonb;
begin
  if v_org is null then raise exception 'This login is not linked to a firm yet'; end if;

  -- Each customer's position on the last day of the period. Positive means he
  -- still owes; negative means he has paid more than he was ever billed, and
  -- THAT is the only part any bill has to explain.
  with room as (
    select r.id as party_id, greatest(-r.amt, 0) as credit
      from party_balance_rows(p_to) r
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', m.id, 'pdate', m.pdate, 'amount', m.amount, 'mode', m.mode,
           'note', m.note, 'party_id', m.party_id, 'party', p.name,
           'gstin', p.gstin, 'state_code', p.state_code, 'price_list', p.price_list,
           -- null for a receipt with no customer on it: there is no ledger to
           -- check it against, so nothing is being claimed about it
           'room', case when m.party_id is null then null
                        else coalesce(k.credit, 0) end)
         order by m.pdate, m.created_at), '[]'::jsonb)
    into v
    from payments m
    left join parties p on p.id = m.party_id
    left join room    k on k.party_id = m.party_id
   where m.org_id = v_org
     and m.ptype  = 'receipt'
     and m.ref_voucher_id is null
     and m.pdate between p_from and p_to;

  return v;
end
$ubr$;
