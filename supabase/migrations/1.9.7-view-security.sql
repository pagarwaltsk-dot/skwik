-- ===========================================================================
--  SKWIK 1.9.7  —  put security_invoker back on the stock views
--
--  Run after 1.9.6. Safe to run twice. Changes no data.
--
--  WHAT THIS IS FOR
--
--  Both stock views are declared in schema.sql with
--
--      WITH (security_invoker = 'on')
--
--  and that flag is the whole of their security. It makes the view read
--  items, stock_moves and godowns AS THE SHOPKEEPER, so the row-level
--  security policy on those tables applies and he sees his own shop's stock
--  and nobody else's. Without it a view reads its tables as its OWNER, and
--  the owner of a view created in the Supabase SQL editor is a role that RLS
--  does not constrain. Every shop would then be able to read every other
--  shop's stock — item names, batches and quantities — by opening its own
--  Stock screen.
--
--  CREATE OR REPLACE VIEW does not carry the old options over. It REPLACES
--  them, so a replace that leaves the WITH clause off strips the flag
--  silently: no error, no warning, and the view goes on answering questions.
--  Verified on PostgreSQL 16 — after such a replace, pg_class.reloptions for
--  the view is null and a second shop's rows come back in the result.
--
--  1.9.6 rewrote stock_in_hand_detail. The copy of 1.9.6 in this repository
--  restates the flag, but a database where the earlier copy was already run
--  is sitting without it right now. This puts it back, and checks its
--  neighbour at the same time, because the cost of being wrong here is every
--  shop's stock.
-- ===========================================================================

begin;

do $$
declare
  v        text;
  fixed    int := 0;
  already  int := 0;
begin
  foreach v in array array['stock_in_hand', 'stock_in_hand_detail'] loop
    if not exists (select 1 from pg_class c
                    join pg_namespace n on n.oid = c.relnamespace
                   where n.nspname = 'public' and c.relname = v and c.relkind = 'v') then
      raise notice 'view public.% is not there — nothing to do', v;
      continue;
    end if;

    if exists (select 1 from pg_class c
                join pg_namespace n on n.oid = c.relnamespace
               where n.nspname = 'public' and c.relname = v
                 and c.reloptions @> array['security_invoker=on']) then
      already := already + 1;
      continue;
    end if;

    execute format('alter view public.%I set (security_invoker = on)', v);
    fixed := fixed + 1;
    raise notice 'put security_invoker back on public.%', v;
  end loop;

  raise notice 'stock views: % already correct, % put right', already, fixed;
end $$;

-- If either of them is still without it, stop rather than commit a database
-- where one shop can read another's stock.
do $$
declare
  bad text;
begin
  select string_agg(c.relname, ', ')
    into bad
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relname in ('stock_in_hand', 'stock_in_hand_detail')
     and c.relkind = 'v'
     and not (coalesce(c.reloptions, '{}') @> array['security_invoker=on']);

  if bad is not null then
    raise exception 'security_invoker is still missing on: % — not committing', bad;
  end if;
end $$;

commit;
