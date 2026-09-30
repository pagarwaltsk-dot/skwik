-- ===========================================================================
--  1.10.40   A YEAR OF BILLS IN ONE BREATH
--
--  The import is the first thing every new shop does, and it is the slowest
--  thing Skwik has -- not because of the work, but because of the ASKING. It
--  asked the server to write one bill, waited for the answer, then asked for
--  the next. A round trip to Supabase from a shop's phone is about a fifth of a
--  second before the server has done anything at all.
--
--  COUNTED, not guessed. A day book of 2,254 bills and 3,573 receipts and
--  payments -- the size of his own -- imported twice, with every question the
--  app asks the server counted both times:
--
--      the old way     2,347 round trips     about 469 seconds of waiting
--      the new way       138 round trips     about  28 seconds of waiting
--
--  Seventeen times fewer, and seven and a half minutes of a shopkeeper's life
--  back. A wholesaler with fifty thousand bills would have waited over three
--  hours on the old count and puts the phone down long before the end.
--
--  Where they went:
--
--      save_voucher, once a bill          2,254  ->  46 blocks of fifty
--      one UPDATE per bank receipt, to
--        say which bank it went through   one a
--                                       receipt  ->  one a block
--      the rest (masters, money, the
--        transfers, the journals)     unchanged
--
--  Nothing about what gets written changes: save_vouchers calls the very same
--  save_voucher that one bill at a time called, so every rule in it -- the
--  bill-number check, the stock, the bill's own receipt for a cash sale, the
--  Tally GUID that stops a second import doubling the books -- still applies to
--  every bill, one by one, inside.
--
--  ONE BAD BILL MUST NOT COST THE OTHER FORTY-NINE. Each bill is written
--  inside its own little block, so a bill the database refuses comes back as a
--  refusal with its own message -- exactly the message the shopkeeper would
--  have seen before -- while the rest of the block goes in. The importer then
--  reports it the same way it always did.
--
--  AND AN OLDER DATABASE STILL WORKS. A book that has not had this migration
--  has no save_vouchers; the first block comes back saying so, and the import
--  drops to one bill at a time for the rest of the run. Proved: the same day
--  book was imported both ways and the two books compared -- the same 2,265
--  bills, the same 2,268 bill lines, the same 3,580 money entries, the same
--  33,52,634.30, and the same goods on the shelf.
--
--  WHAT IT COSTS THE SERVER, MEASURED AND NOT HIDDEN. 600 bills with lines on
--  them, each side on its own freshly built database:
--
--      one at a time     600 round trips     968 ms of server time
--      fifty at a time    12 round trips   1,609 ms of server time
--
--  So the server does about one millisecond a bill MORE work, because the block
--  has to be packed into one message and taken apart again at the other end.
--  One millisecond against the two hundred a round trip costs. For his 2,254
--  bills that is two more seconds of database time to save seven minutes of a
--  man standing there holding a phone.
--
--  ONE BAD BILL MUST NOT COST THE OTHER FORTY-NINE. Each bill is written
--  inside its own little block, so a bill the database refuses comes back as a
--  refusal with its own message -- exactly the message the shopkeeper would
--  have seen before -- while the rest of the block goes in. The importer then
--  reports it the same way it always did.
-- ===========================================================================


-- ---------------------------------------------------------------------------
--  A BLOCK OF BILLS
--
--  In: an array of the same payloads save_voucher takes.
--  Out: an array the same length and in the same order, each element either
--       what save_voucher returned, or { ok: false, why: '...' }.
-- ---------------------------------------------------------------------------
create or replace function public.save_vouchers(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $svs$
declare
  v_org uuid := my_org_id();
  r     jsonb;
  out   jsonb := '[]'::jsonb;
  one   jsonb;
  got   jsonb[] := '{}';
begin
  if v_org is null then raise exception 'This login is not linked to a firm yet'; end if;
  perform assert_can_write();
  if jsonb_typeof(p) <> 'array' then
    raise exception 'save_vouchers wants a list of bills';
  end if;
  -- A LIMIT, so one call cannot be made to hold the whole book and time out
  -- halfway through with no way of telling what landed.
  if jsonb_array_length(p) > 200 then
    raise exception 'That is % bills in one go. Send them fifty or a hundred at a time.',
      jsonb_array_length(p);
  end if;

  -- GATHERED IN A LIST AND TURNED INTO AN ANSWER ONCE. Appending to a jsonb
  -- array inside the loop rebuilds the whole array every time round, which is
  -- fifty copies of a growing thing for a block of fifty.
  for r in select value from jsonb_array_elements(p) loop
    begin
      one := save_voucher(r);
      got := got || (coalesce(one, '{}'::jsonb) || jsonb_build_object('ok', true));
    exception when others then
      -- ITS OWN REFUSAL, IN ITS OWN WORDS, and the block carries on. The
      -- importer says the same thing it said when bills went one at a time.
      got := got || jsonb_build_object(
        'ok', false, 'why', SQLERRM,
        'voucher_no', r->>'voucher_no', 'vdate', r->>'vdate', 'vtype', r->>'vtype');
    end;
  end loop;

  select coalesce(jsonb_agg(x order by i), '[]'::jsonb) into out
    from unnest(got) with ordinality as u(x, i);
  return out;
end $svs$;

revoke all on function public.save_vouchers(jsonb) from public;
grant execute on function public.save_vouchers(jsonb) to authenticated;


-- ---------------------------------------------------------------------------
--  WHICH BANK A RECEIPT WENT THROUGH, FOR A WHOLE BLOCK AT ONCE
--
--  The importer writes its block of receipts with ignoreDuplicates, which is
--  what makes a second import a no-op. But that also means a receipt already
--  in the books keeps whatever account it had -- and the three and a half
--  thousand imported before accounts were read have none. So each one was
--  mended with an UPDATE of its own: right, and one round trip a receipt.
--
--  In: [{ id, account_id }, ...]
--  Out: how many were actually filled in.
--
--  ONLY A BLANK IS FILLED. An account the shopkeeper set himself stands, which
--  is the same promise the one-at-a-time version made with `.is(null)`.
-- ---------------------------------------------------------------------------
create or replace function public.fill_payment_account(p jsonb)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $fpa$
declare
  v_org uuid := my_org_id();
  n     integer := 0;
begin
  if v_org is null then raise exception 'This login is not linked to a firm yet'; end if;
  perform assert_can_write();
  if jsonb_typeof(p) <> 'array' then
    raise exception 'fill_payment_account wants a list';
  end if;

  with want as (
    select (e->>'id')::uuid         as id,
           (e->>'account_id')::uuid as account_id
      from jsonb_array_elements(p) e
     where nullif(e->>'id','') is not null
       and nullif(e->>'account_id','') is not null
  ),
  -- the account has to be one of THIS firm's, or a crafted list could point a
  -- receipt at a stranger's bank
  good as (
    select w.id, w.account_id from want w
      join bank_accounts b on b.id = w.account_id and b.org_id = v_org
  ),
  done as (
    update payments y set account_id = g.account_id
      from good g
     where y.id = g.id
       and y.org_id = v_org
       and y.account_id is null
       and y.mode = 'bank'
    returning 1
  )
  select count(*) into n from done;

  return n;
end $fpa$;

revoke all on function public.fill_payment_account(jsonb) from public;
grant execute on function public.fill_payment_account(jsonb) to authenticated;
