-- ===========================================================================
--  SKWIK 1.9.9  —  URGENT: one firm could see another firm's stock
--
--  Run this in the Supabase SQL Editor NOW. It changes no data and takes an
--  instant. Safe to run twice.
--
--  WHAT WENT WRONG, AND IT WAS MY DOING
--
--  A view in Postgres reads the tables underneath it as its OWNER unless it
--  is marked security_invoker. Skwik's views are all marked, so that row
--  security applies to the person actually looking.
--
--  1.9.6 rewrote stock_in_hand_detail to fix opening stock going missing when
--  a shop switched godowns on. CREATE OR REPLACE VIEW without a WITH clause
--  RESETS the view's options — so the mark came off, and from that moment the
--  detailed stock summary read stock_moves as the owner, with row security
--  bypassed, and returned EVERY firm's stock to everybody.
--
--  What it looked like: another firm's items appearing in the stock summary,
--  while the same items were correctly absent from the item search and showed
--  nothing when tapped — because every other screen reads the items table,
--  where row security was working properly all along.
--
--  Nothing was written or changed by this. It was a read that showed too much.
-- ===========================================================================

begin;

alter view public.stock_in_hand_detail set (security_invoker = on);

commit;


-- ---------------------------------------------------------------------------
--  AND A GUARD, SO THIS CANNOT HAPPEN AGAIN QUIETLY
--
--  Every view in this schema is checked. Any that reads as its owner instead
--  of as the person looking is marked, here and now. The notice says which.
-- ---------------------------------------------------------------------------
do $$
declare v record; n int := 0;
begin
  for v in
    select c.relname
      from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
     where ns.nspname = 'public' and c.relkind = 'v'
       and coalesce((select option_value from pg_options_to_table(c.reloptions)
                      where option_name = 'security_invoker'), 'off') <> 'on'
  loop
    execute format('alter view public.%I set (security_invoker = on)', v.relname);
    raise notice 'view % was reading as its owner — row security is now on for it', v.relname;
    n := n + 1;
  end loop;
  if n = 0 then
    raise notice 'every view already reads as the person looking. Nothing to put right.';
  end if;
end $$;
