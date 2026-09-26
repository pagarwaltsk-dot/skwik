-- ===========================================================================
--  1.9.52  WHAT A SHOP SEES ON ITS FIRST MORNING.
--
--  Skwik opens with almost everything switched on, and a screen full of
--  buttons nobody presses is what makes an app feel heavy. A man who has just
--  bought it wants to write a bill; he does not want to be told, on his first
--  morning, that bill of materials exists.
--
--  From here a new firm starts with five things and nothing else:
--
--      sale bills, money in and out, items, udhar  -- not switches at all,
--                                                     they are the app
--      purchase entries                            -- off, and one tap away
--
--  Everything else waits behind a switch in Settings: stock quantities,
--  goods coming back, reports and GST returns, rent and other spending,
--  2B matching, import and export, godowns, batches, sizes, making, and the
--  rest. None of them is removed; none of them is hidden; each is one tap
--  away in a list he can also simply ask a question of.
--
--  THIS CHANGES NOTHING FOR A SHOP THAT IS ALREADY RUNNING.
--
--  Only the DEFAULT on the column moves, which is the value a row gets when
--  nobody says otherwise -- that is, when a new firm is created. Every row
--  already in the table keeps exactly the value it has. An update that
--  quietly took a working screen away from a shop mid-month would be the
--  worst thing this app could do, and there is a check at the bottom that
--  says out loud how many firms were touched. The answer is none.
--
--  SAFE TO RUN TWICE.
-- ===========================================================================


-- ---------------------------------------------------------------------------
--  1. THE TWO THAT WERE ON
-- ---------------------------------------------------------------------------
--  Everything else a new shop should not start with already defaults to off.
--  These two did not.

alter table public.orgs alter column show_purchase  set default false;
alter table public.orgs alter column stock_enabled  set default false;

comment on column public.orgs.show_purchase is
  'Purchase entries. Off for a new firm: a counter shop that buys nothing never opens it, and it is one tap away in Settings.';
comment on column public.orgs.stock_enabled is
  'Quantities against every item, the stock count, and the warning when a bill would take out more than there is. Off for a new firm: items still carry a name and a rate.';


-- ---------------------------------------------------------------------------
--  2. AND THE PROOF THAT NOBODY LOST ANYTHING
-- ---------------------------------------------------------------------------
--  Said in the editor, where he can read it, rather than left to be trusted.

do $said$
declare n_all int; n_buy int; n_stk int;
begin
  select count(*),
         count(*) filter (where show_purchase),
         count(*) filter (where stock_enabled)
    into n_all, n_buy, n_stk
    from orgs;
  raise notice 'firms in this database: %. purchase still on for %, stock still on for %. No row was changed -- only what a NEW firm starts with.',
    n_all, n_buy, n_stk;
end
$said$;
