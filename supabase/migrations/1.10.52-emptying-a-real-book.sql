-- ===========================================================================
--  EMPTYING A BOOK THAT HAS A YEAR IN IT
--
--  WHAT WAS WRONG, AND IT IS TWO THINGS.
--
--  1. IT NEVER FINISHED. wipe_org deleted every row of a firm in ONE call.
--     On his own book that is 4,655 bills, 26,196 bill lines and 34,066 stock
--     movements. Supabase cuts a statement off after a few seconds, so the
--     request died every time -- and the phone, which matches on the word
--     "timeout", told him to check his wifi. He checked his wifi. It was
--     fine. EVERY shop with a real year of books hits this; it only works on
--     a book small enough not to need it.
--
--  2. IT LEFT HALF THE BOOK BEHIND. The list of tables was written by hand
--     and never grew. It deleted ten tables and walked past eleven:
--
--         cash_moves      his contras -- the cash he banks every evening
--         journals        his accountant's adjustments
--         journal_legs
--         item_history    item_parts      itc_files
--         restore_maps    import_runs     ledgers
--         expense_heads   standing_items
--
--     So "the books are empty" left the cash book and the journals sitting
--     there with no bills to belong to. A hand-written list of tables rots
--     the moment somebody adds a table, and five migrations have added one.
--
--  THE FIX FOR BOTH.
--
--  It asks the DATABASE which tables belong to a firm -- every table with an
--  org_id -- instead of being told. A table added next year is emptied
--  without anyone remembering to come back here.
--
--  And it deletes a BATCH at a time and says how much is left, so the app
--  calls it over and over with a progress bar. Four thousand rows a call
--  finishes well inside any timeout, and a book of any size finishes.
--
--  THE ORDER IS WORKED OUT BY TRYING. A bill line cannot go before its bill.
--  Rather than keeping a hand-made order -- which rots exactly like the list
--  did -- it tries every table, skips the ones the database refuses on a
--  foreign key, and goes round again. Each pass frees the next. It stops when
--  a whole pass deletes nothing.
--
--  WHAT IT WILL NEVER TOUCH, whatever the database says:
--      orgs                  the firm itself, so you can import into it again
--      profiles              THE LOGINS. Nobody is locked out by emptying a book.
--      subscription_payments what he has paid is not part of his books
-- ===========================================================================

create or replace function public.wipe_org_step(
  p_keep_masters boolean default true,
  p_limit        int     default 4000)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $wipe$
declare
  v_org    uuid := my_org_id();
  v_left   int  := greatest(coalesce(p_limit, 4000), 1);
  v_gone   int  := 0;
  v_n      int;
  v_moved  boolean;
  t        text;
  v_skip   text[];
  v_tables text[];
  v_rest   bigint := 0;
begin
  if v_org is null then raise exception 'This login is not linked to a firm yet'; end if;
  if my_role() <> 'owner' then
    raise exception 'Only the owner of this firm can empty it';
  end if;

  -- NEVER, whatever else changes.
  v_skip := array['orgs', 'profiles', 'subscription_payments'];

  -- Keeping the masters means keeping the things he typed in himself -- his
  -- items, his customers, his godowns and his bank accounts -- and only
  -- throwing away what was billed against them.
  if p_keep_masters then
    v_skip := v_skip || array['items', 'parties', 'hsn_hints', 'godowns',
                              'bank_accounts', 'ledgers', 'expense_heads',
                              'item_parts', 'standing_items'];
  end if;

  -- ASK THE DATABASE, DO NOT BE TOLD. Every table that belongs to a firm.
  select coalesce(array_agg(c.table_name order by c.table_name), '{}')
    into v_tables
    from information_schema.columns c
    join information_schema.tables t
      on t.table_schema = c.table_schema and t.table_name = c.table_name
   where c.table_schema = 'public'
     and c.column_name  = 'org_id'
     and t.table_type   = 'BASE TABLE'
     and not (c.table_name = any (v_skip));

  -- ROUND AND ROUND UNTIL A WHOLE PASS MOVES NOTHING.
  --
  -- A bill line cannot go before its bill, so the first pass deletes the
  -- lines and is refused on the bills; the next pass takes the bills. Trying
  -- and skipping is what keeps this right when somebody adds a table with a
  -- new foreign key -- there is no order here to get out of date.
  loop
    v_moved := false;
    foreach t in array v_tables loop
      exit when v_left <= 0;
      begin
        execute format(
          'with doomed as (select ctid from %I where org_id = $1 limit $2)'
          || ' delete from %I x using doomed d where x.ctid = d.ctid', t, t)
          using v_org, v_left;
        get diagnostics v_n = row_count;
        if v_n > 0 then
          v_left := v_left - v_n;
          v_gone := v_gone + v_n;
          v_moved := true;
        end if;
      exception
        -- something still points at these rows; a later pass will free them
        when foreign_key_violation then null;
      end;
    end loop;
    exit when not v_moved or v_left <= 0;
  end loop;

  -- how much is still there, so the app knows whether to call again
  foreach t in array v_tables loop
    execute format('select count(*) from %I where org_id = $1', t) into v_n using v_org;
    v_rest := v_rest + v_n;
  end loop;

  -- ONLY ONCE IT IS ACTUALLY EMPTY. Putting the numbering back on every call
  -- would reset it over and over while the deleting is still going on.
  if v_rest = 0 then
    if p_keep_masters then
      update items   set opening_stock = 0 where org_id = v_org;
      update parties set opening_balance = 0, opening_date = null where org_id = v_org;
      update bank_accounts set opening = 0, opening_on = null where org_id = v_org;
    end if;
    update orgs
       set next_invoice_no = 1, next_estimate_no = 1,
           next_credit_no = 1, next_debit_no = 1,
           series_year = null, opening_cash = 0, opening_cash_on = null,
           books_locked_upto = null
     where id = v_org;
  end if;

  return jsonb_build_object(
    'deleted', v_gone,
    'left',    v_rest,
    'done',    (v_rest = 0),
    'tables',  coalesce(array_length(v_tables, 1), 0));
end
$wipe$;

revoke all on function public.wipe_org_step(boolean, int) from public, anon;
grant execute on function public.wipe_org_step(boolean, int) to authenticated;


-- ---------------------------------------------------------------------------
--  AND THE OLD ONE STILL ANSWERS, so a phone that has not been updated yet
--  does not simply break. It now does the same job in batches underneath.
-- ---------------------------------------------------------------------------
create or replace function public.wipe_org(p_keep_masters boolean default true)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $old$
declare
  v_org uuid := my_org_id();
  n_v int; n_p int; n_e int; n_i int; n_pa int;
  v_r jsonb; v_guard int := 0;
begin
  if v_org is null then raise exception 'This login is not linked to a firm yet'; end if;

  select count(*) into n_v  from vouchers where org_id = v_org;
  select count(*) into n_p  from payments where org_id = v_org;
  select count(*) into n_e  from expenses where org_id = v_org;
  select count(*) into n_i  from items    where org_id = v_org;
  select count(*) into n_pa from parties  where org_id = v_org;

  -- A big book will still run out of time here, and that is why the app calls
  -- wipe_org_step directly now. This is the door for an older phone.
  loop
    v_r := wipe_org_step(p_keep_masters, 4000);
    v_guard := v_guard + 1;
    exit when (v_r->>'done')::boolean or v_guard > 500;
  end loop;

  return jsonb_build_object(
    'vouchers', n_v, 'payments', n_p, 'expenses', n_e,
    'items', case when p_keep_masters then 0 else n_i end,
    'parties', case when p_keep_masters then 0 else n_pa end,
    'kept_masters', p_keep_masters);
end
$old$;

revoke all on function public.wipe_org(boolean) from public, anon;
grant execute on function public.wipe_org(boolean) to authenticated;
