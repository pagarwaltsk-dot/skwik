-- ===========================================================================
--  AM I THE OWNER? — a read-only check. It changes nothing.
--
--  Some screens are the owner's alone: removing a bill, closing the books,
--  and the new Owned and owed list. Skwik decides that by one field on your
--  firm row — owner_id — and NOT by the word "owner" on your staff record,
--  deliberately: otherwise anyone who could edit staff could make himself
--  the owner.
--
--  A firm created in the very first versions of Skwik may have that field
--  empty. If it is empty, the owner-only screens will refuse you even though
--  you are plainly the owner — Owned and owed would open, show nothing, and
--  fail with a permissions message when you pressed Save.
--
--  HOW TO USE IT. Put your login email in the line marked below, run it in
--  the Supabase SQL editor, and read the last column.
-- ===========================================================================

select o.name                                   as firm,
       u.email                                  as this_login,
       p.role                                   as staff_record_says,
       case
         when o.owner_id is null then
           'EMPTY - owner-only screens will refuse you. Fix below.'
         when o.owner_id = u.id then
           'Set, and it is you. Nothing to do.'
         else
           'Set to a different login. Use that login, or fix below.'
       end                                      as owner_recorded
  from orgs o
  join profiles p  on p.org_id = o.id
  join auth.users u on u.id = p.id
 where u.email = 'PUT YOUR LOGIN EMAIL HERE';       -- <<< change this


-- ---------------------------------------------------------------------------
--  THE FIX, if and only if the last column said EMPTY.
--
--  Remove the two dashes from the three lines below and run them. It writes
--  your own login id onto your firm as the owner and touches nothing else.
--  It is deliberately written so it can only fill an empty field, never take
--  a firm away from somebody who already owns it.
-- ---------------------------------------------------------------------------

-- update orgs set owner_id = (select id from auth.users where email = 'PUT YOUR LOGIN EMAIL HERE')
--  where owner_id is null
--    and id = (select org_id from profiles
--               where id = (select id from auth.users where email = 'PUT YOUR LOGIN EMAIL HERE'));
