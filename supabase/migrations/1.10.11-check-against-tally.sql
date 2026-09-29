-- ===========================================================================
--  CHECKING SKWIK AGAINST THE BOOK HE ALREADY TRUSTS.
--
--  party_balance_rows(p_on) has taken a date since it was written, but nothing
--  exposed it. party_balances() calls it with null, which means "as things
--  stand now" -- and a trial balance is a position on a DAY. Comparing his 27
--  September figures against Skwik as it stands on the 28th counts a day of
--  billing as a difference and sends him looking for a fault that is not one.
--
--  So: the same rows, as at the day he asks for.
-- ===========================================================================

create or replace function public.party_balances_on(p_on date default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $pbo$
declare
  v_org uuid := my_org_id();
  v     jsonb;
begin
  if v_org is null then raise exception 'This login is not linked to a firm yet'; end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', r.id, 'name', r.name, 'kind', r.kind,
           'balance', r.amt) order by r.name), '[]'::jsonb)
    into v
    from party_balance_rows(p_on) r;

  return v;
end $pbo$;

revoke all on function public.party_balances_on(date) from public;
grant execute on function public.party_balances_on(date) to authenticated;


-- ---------------------------------------------------------------------------
--  AND THE OPENING FIGURES, FILLED IN FROM THE TRIAL BALANCE.
--
--  The ledger masters carry an opening balance per ledger and it is the wrong
--  one: it is the balance at the start of the COMPANY's books, not the start of
--  the year exported, so every ledger that has ever moved carries a stale
--  figure. On his own two files, 28 September 2026:
--
--      Cash                              masters 3,30,041.45   trial balance 2,00,000.00
--      Cash Credit Account Fedral Bank   masters 21,08,459.58   trial balance 23,50,069.58
--      Bank Of Baroda                    masters 10,51,278.38   trial balance 10,51,278.38
--
--  Baroda agrees only because it has never moved. The trial balance states the
--  opening outright, so that is where an opening comes from from now on.
--
--  ONLY EVER FILLED IN, NEVER WRITTEN OVER. A figure he typed himself is his,
--  and an opening that already carries a date has been set on purpose. This is
--  the same rule the opening cash has always followed.
-- ---------------------------------------------------------------------------

create or replace function public.set_openings(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $so$
declare
  v_org   uuid := my_org_id();
  v_on    date := nullif(p->>'on', '')::date;
  r       jsonb;
  v_name  text;
  v_amt   numeric;
  v_cash  int := 0;
  v_bank  int := 0;
  v_party int := 0;
  v_left  jsonb := '[]'::jsonb;
begin
  perform assert_can_write();
  if v_org is null then raise exception 'This login is not linked to a firm yet'; end if;
  if my_role() <> 'owner' then
    raise exception 'Only the owner can set the opening figures';
  end if;
  if v_on is null then raise exception 'Which day do these openings belong to?'; end if;

  -- the till
  if p ? 'cash' then
    update orgs
       set opening_cash = (p->>'cash')::numeric,
           opening_cash_on = v_on
     where id = v_org
       and coalesce(opening_cash, 0) = 0
       and opening_cash_on is null;
    get diagnostics v_cash = row_count;
  end if;

  -- each bank he already has an account for. An account that is not there is
  -- NOT made here: a bank account is a thing he sets up once, with a name he
  -- chose, and inventing one from a ledger name would put a second Baroda
  -- beside his own.
  for r in select * from jsonb_array_elements(coalesce(p->'banks', '[]'::jsonb))
  loop
    v_name := r->>'name';
    v_amt  := (r->>'opening')::numeric;
    update bank_accounts
       set opening = v_amt, opening_on = v_on
     where org_id = v_org
       and lower(btrim(name)) = lower(btrim(v_name))
       and coalesce(opening, 0) = 0
       and opening_on is null;
    if found then
      v_bank := v_bank + 1;
    else
      v_left := v_left || jsonb_build_object('name', v_name, 'opening', v_amt);
    end if;
  end loop;

  -- and the people. Tally writes what he is owed positive here, because the
  -- reader has already turned Tally's own sign over.
  for r in select * from jsonb_array_elements(coalesce(p->'parties', '[]'::jsonb))
  loop
    v_name := r->>'name';
    v_amt  := (r->>'opening')::numeric;
    update parties
       set opening_balance = abs(v_amt),
           opening_type = case when v_amt < 0 then 'you_owe' else 'owes_you' end,
           opening_date = v_on
     where org_id = v_org
       and lower(btrim(name)) = lower(btrim(v_name))
       and coalesce(opening_balance, 0) = 0
       and opening_date is null;
    if found then
      v_party := v_party + 1;
    else
      v_left := v_left || jsonb_build_object('name', v_name, 'opening', v_amt);
    end if;
  end loop;

  return jsonb_build_object(
    'cash',    v_cash,
    'banks',   v_bank,
    'parties', v_party,
    'on',      v_on,
    -- WHAT IT COULD NOT FILL IN, NAMED. A figure that was already set, or a
    -- name Skwik does not have. Silence here would look like success.
    'left',    v_left);
end $so$;

revoke all on function public.set_openings(jsonb) from public;
grant execute on function public.set_openings(jsonb) to authenticated;
