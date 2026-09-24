-- ---------------------------------------------------------------------------
--  1.9.25 — WHICH LIST A WALK-IN PAYS
--
--  Every bill screen carried two buttons above the goods — Wholesale and
--  Retail — and asked him to choose. It is not a question about this bill. It
--  is a question about the customer, and every customer already carries the
--  answer on his own row.
--
--  The one customer who does not is the stranger paying cash, and asking
--  about him on every single counter sale is asking the same question forty
--  times a day and getting the same answer forty times. A counter shop sells
--  a walk-in at one list and that is the end of it — so it is said once, in
--  Settings, and never asked again.
--
--  1 keeps the behaviour of every shop already running, so nothing moves for
--  anybody who does not go and change it.
--
--  Safe to run twice.
-- ---------------------------------------------------------------------------
begin;

alter table public.orgs
  add column if not exists walkin_price_list smallint not null default 1;

alter table public.orgs
  drop constraint if exists orgs_walkin_price_list_ck;
alter table public.orgs
  add constraint orgs_walkin_price_list_ck check (walkin_price_list in (1, 2));

commit;
