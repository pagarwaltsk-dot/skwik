-- ===========================================================================
--  1.10.39   THE WORDS THE BOOK DOES NOT KNOW
--
--  A thousand random shops were built and pushed through the app's own bill
--  arithmetic and the database's own save_voucher, and then held against the
--  six things that must be true of any book of accounts. The stock added up
--  every time. The backups took every row every time. What did not add up was
--  the names -- and chasing that found something worse than a sum being wrong.
--
--  THE BOOK DECIDES WHAT A ROW MEANS BY READING A WORD IN IT, and almost
--  nothing checked that the word was one it knows.
--
--      select sum(case when y.ptype = 'receipt' then y.amount
--                                               else -y.amount end)
--
--  'receipt' is money in. ANY OTHER WORD is money out. So a receipt of 1,000
--  filed under the word 'receive' rather than 'receipt' does not go missing and
--  does not raise an error -- it comes out the other way round, and the
--  customer who just paid 1,000 is shown as owing 1,000 MORE than before. A
--  2,000 rupee hole, in a screen that looks completely normal. Tried on a real
--  book, and that is exactly what happened.
--
--  The same reading-a-word-and-guessing sat in five other places:
--
--    parties.opening_type   anything that is not 'you_owe' is read as money
--                           owed TO the shop. A supplier's 5,000 opening filed
--                           as 'creditor' became 5,000 of debtors. TRIED: it
--                           did.
--    payments.mode          anything that is not 'bank' is the till. A 700
--                           receipt filed as 'gpay' went into no cash book and
--                           no bank book at all -- it exists, and nothing
--                           counts it, so the trial balance cannot foot. TRIED:
--                           700 vanished from both.
--    cash_moves.direction   anything that is not 'deposit' is money out of the
--                           till -- but this one was already written down in
--                           1.10.6 and needed nothing.
--    items.supply           anything that is not nil, exempt or non_gst is
--                           taxed. A typo puts exempt goods in the taxable
--                           box of the return.
--    vouchers.tax_mode      decides whether the tax splits in two or is one
--                           IGST figure.
--    profiles.role          can_write() was written as "anybody who is not the
--                           accountant" -- so a login whose role is a word the
--                           app has never heard of could write bills. TRIED
--                           with the role 'manager': it wrote a bill.
--
--  None of this is reachable by tapping the app, which only ever writes the
--  right words. It is reachable by an import, by a backup made on an older
--  build put back on a newer one, by anything ever written straight into the
--  database, and by the next bug. A wrong figure that looks right is the worst
--  thing this app can produce, so the words are now written down.
--
--  ---------------------------------------------------------------------
--  HOW THIS IS SAFE TO RUN ON A BOOK THAT IS ALREADY FULL
--
--  A constraint added the ordinary way REFUSES TO BE ADDED if any row already
--  breaks it, and the whole script would stop on a message about a constraint.
--  So, for each column:
--
--    1. the words that plainly mean the right thing are put right first
--       ('receive' is a receipt, 'cr' is money the shop owes, and so on);
--    2. the rule is added NOT VALID, which never fails and which every row
--       written or changed from now on must satisfy;
--    3. the rule is then checked against what is already there -- and if
--       something does not fit, the rule stays in force for new rows and the
--       row that does not fit is REPORTED rather than the script stopping.
--
--  The last thing this script does is print that report, because the Supabase
--  editor shows only the last answer. An empty report is the good outcome.
-- ===========================================================================


-- ---------------------------------------------------------------------------
--  1. ONLY THE OWNER AND THE COUNTER MAY WRITE
--
--  Was: anybody who is not the accountant. Now: the owner or the counter, and
--  nobody else. There are three roles in the app and there have only ever been
--  three -- owner, staff, accountant -- so naming them costs nothing and shuts
--  the door on every word that is not one of them.
-- ---------------------------------------------------------------------------
create or replace function public.can_write()
returns boolean language sql stable security definer set search_path to 'public' as $cw$
  select coalesce(my_role(), '') in ('owner', 'staff')
$cw$;


-- ---------------------------------------------------------------------------
--  2. SOMEWHERE TO WRITE DOWN WHAT COULD NOT BE TIGHTENED
-- ---------------------------------------------------------------------------
create table if not exists public.schema_notes (
  at        timestamptz not null default now(),
  what      text not null,
  detail    text
);
alter table public.schema_notes enable row level security;
revoke all on table public.schema_notes from anon, authenticated;
delete from public.schema_notes where what like 'word check%';


-- ---------------------------------------------------------------------------
--  3. THE WORDS, PUT RIGHT AND THEN WRITTEN DOWN
--
--  One helper, called once a column. It normalises, adds the rule without ever
--  failing, then tries to make it cover what is already there and notes it if
--  it cannot.
-- ---------------------------------------------------------------------------
create or replace function public.tighten_words(p_table text, p_col text,
                                                p_name text, p_ok text[])
returns void language plpgsql set search_path to 'public' as $tw$
declare
  n bigint;
begin
  -- already there and already covering everything? nothing to do.
  if exists (select 1 from pg_constraint
              where conname = p_name and convalidated
                and conrelid = format('public.%I', p_table)::regclass) then
    return;
  end if;

  if not exists (select 1 from pg_constraint
                  where conname = p_name
                    and conrelid = format('public.%I', p_table)::regclass) then
    execute format(
      'alter table public.%I add constraint %I check (%I = any (%L)) not valid',
      p_table, p_name, p_col, p_ok);
  end if;

  begin
    execute format('alter table public.%I validate constraint %I', p_table, p_name);
  exception when others then
    execute format('select count(*) from public.%I where %I is null or not (%I = any (%L))',
                   p_table, p_col, p_col, p_ok) into n;
    insert into schema_notes (what, detail)
    values (format('word check: %s.%s', p_table, p_col),
            format('%s row(s) hold a word this book does not know. The rule is in '
                || 'force for anything written from now on, and those rows are '
                || 'still exactly as they were. Allowed: %s.',
                n, array_to_string(p_ok, ', ')));
  end;
end $tw$;
revoke all on function public.tighten_words(text, text, text, text[]) from public;


-- MONEY IN OR MONEY OUT. The one that came out backwards.
update payments set ptype = 'receipt'
 where ptype in ('receive', 'received', 'recd', 'in', 'receipts', 'RECEIPT');
update payments set ptype = 'payment'
 where ptype in ('pay', 'paid', 'out', 'payments', 'PAYMENT');
select public.tighten_words('payments', 'ptype', 'payments_ptype_known',
                            array['receipt', 'payment']);

-- THE TILL OR THE BANK. Anything else is counted in neither.
update payments set mode = 'cash'  where lower(mode) in ('cash', 'c', 'till');
update payments set mode = 'bank'  where lower(mode) in ('bank', 'b', 'cheque', 'neft',
                                                        'upi', 'rtgs', 'imps', 'gpay');
-- 'writeoff' IS ONE OF THEM. write_off() files the amount it forgives as a
-- receipt or a payment with mode 'writeoff', so that it moves the name's
-- balance without ever touching the till or a bank. A list of just cash and
-- bank would have refused every write-off from the day this ran.
select public.tighten_words('payments', 'mode', 'payments_mode_known',
                            array['cash', 'bank', 'writeoff']);

update expenses set mode = 'cash' where lower(mode) in ('cash', 'c', 'till');
update expenses set mode = 'bank' where lower(mode) in ('bank', 'b', 'cheque', 'neft',
                                                       'upi', 'rtgs', 'imps', 'gpay');
select public.tighten_words('expenses', 'mode', 'expenses_mode_known',
                            array['cash', 'bank']);

-- WHICH WAY THE TILL MOVED -- already written down, and NOT in the words I
-- first reached for. cash_moves.direction has carried
--     check (direction in ('deposit','withdrawal'))
-- since 1.10.6. I wrote a rule here for 'in' and 'out' from memory, and it
-- would have refused every single deposit and withdrawal the app makes from
-- the moment it was run. Left exactly as it is, and written down so the next
-- person checks the schema before the memory.

-- WHICH WAY AN OPENING BALANCE POINTS. The supplier who became a debtor.
update parties set opening_type = 'you_owe'
 where lower(opening_type) in ('you_owe', 'creditor', 'cr', 'payable', 'we_owe', 'credit');
update parties set opening_type = 'owes_you'
 where lower(opening_type) in ('owes_you', 'debtor', 'dr', 'receivable', 'debit')
    or opening_type is null or opening_type = '';
select public.tighten_words('parties', 'opening_type', 'parties_opening_type_known',
                            array['owes_you', 'you_owe']);

update parties set kind = 'supplier' where lower(kind) in ('supplier', 'creditor', 'vendor', 'purchase');
update parties set kind = 'customer' where kind is null or kind = ''
    or lower(kind) in ('customer', 'debtor', 'buyer', 'sale', 'sales');
select public.tighten_words('parties', 'kind', 'parties_kind_known',
                            array['customer', 'supplier', 'both']);

-- WHICH BOX OF THE RETURN GOODS GO IN.
update items set supply = 'taxable' where supply is null or supply = ''
    or lower(supply) in ('taxable', 'tax', 'normal');
update items set supply = 'nil'     where lower(supply) in ('nil', 'nil_rated', 'nilrated', 'zero');
update items set supply = 'exempt'  where lower(supply) in ('exempt', 'exempted');
update items set supply = 'non_gst' where lower(supply) in ('non_gst', 'nongst', 'non-gst', 'outside');
select public.tighten_words('items', 'supply', 'items_supply_known',
                            array['taxable', 'nil', 'exempt', 'non_gst']);

-- WHETHER THE TAX SPLITS IN TWO OR STANDS AS ONE FIGURE.
update vouchers set tax_mode = 'none' where tax_mode is null or tax_mode = ''
    or lower(tax_mode) in ('none', 'no', 'nogst', 'estimate');
update vouchers set tax_mode = 'cgst_sgst'
 where lower(tax_mode) in ('cgst_sgst', 'cgstsgst', 'local', 'intra', 'intrastate', 'within');
update vouchers set tax_mode = 'igst'
 where lower(tax_mode) in ('igst', 'inter', 'interstate', 'outside');
select public.tighten_words('vouchers', 'tax_mode', 'vouchers_tax_mode_known',
                            array['cgst_sgst', 'igst', 'none']);

-- WHO MAY WRITE. The one that let a made-up role write a bill.
update profiles set role = 'staff' where role is null or role = ''
    or lower(role) in ('staff', 'counter', 'boy', 'salesman');
update profiles set role = 'accountant' where lower(role) in ('accountant', 'ca', 'auditor');
update profiles set role = 'owner' where lower(role) in ('owner', 'proprietor', 'admin');
select public.tighten_words('profiles', 'role', 'profiles_role_known',
                            array['owner', 'staff', 'accountant']);

-- WHAT THE FIRM IS AND WHAT IT HAS PAID FOR.
update orgs set mode = 'gst' where lower(mode) in ('gst', 'tax', 'registered');
update orgs set mode = 'estimate' where mode is null or mode = ''
    or lower(mode) in ('estimate', 'kacha', 'unregistered');
select public.tighten_words('orgs', 'mode', 'orgs_mode_known',
                            array['gst', 'estimate']);

update orgs set plan = 'trial' where plan is null or plan = '' or lower(plan) = 'trial';
update orgs set plan = 'paid'  where lower(plan) in ('paid', 'paid_up', 'subscribed');
select public.tighten_words('orgs', 'plan', 'orgs_plan_known',
                            array['trial', 'paid']);


-- ---------------------------------------------------------------------------
--  4. AND THE ONE THING THAT CANNOT BE A CONSTRAINT
--
--  A receipt in the bank with no bank account named against it is money that
--  is in the payments table and in no bank book. It is not a wrong WORD, so no
--  rule above catches it, and it cannot be forbidden outright because a shop
--  with one bank account may legitimately have written it before accounts
--  existed. So it is counted and reported, with what it comes to.
-- ---------------------------------------------------------------------------
insert into schema_notes (what, detail)
select 'word check: money in a bank nobody named',
       format('%s entries totalling %s are marked bank but name no bank account, '
           || 'so they are in no bank book. Open Money, tap each one and choose '
           || 'the account.',
           count(*), to_char(sum(amount), 'FM99,99,99,990.00'))
  from payments where mode = 'bank' and account_id is null
 having count(*) > 0;


-- ---------------------------------------------------------------------------
--  5. WHAT TO LOOK AT. An empty answer is the good one.
-- ---------------------------------------------------------------------------
select what, detail from public.schema_notes where what like 'word check%' order by what;
