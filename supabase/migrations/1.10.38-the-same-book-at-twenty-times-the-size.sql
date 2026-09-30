-- ===========================================================================
--  1.10.38   THE SAME BOOK AT TWENTY TIMES THE SIZE
--
--  Nothing in here changes a single figure. Every line of it is the same
--  answer, arrived at with less work, and each one was timed on a book built
--  to twenty times the size of his own before and after:
--
--      two firms, 100,811 bills, 324,222 bill lines, 178,220 stock
--      movements, 33,672 money entries, 2,709 items, 2,405 names
--
--  Three things were measured and three things are changed. A fourth and a
--  fifth were measured, found to save nothing worth the cost, and are written
--  down here as rejected so nobody spends the afternoon on them again.
--
--  ---------------------------------------------------------------------
--   1. THE STOCK LIST ASKED WHICH STORE IS THE MAIN ONE 59,420 TIMES
--  ---------------------------------------------------------------------
--  stock_in_hand_detail folds every stock movement into one line an item, a
--  store, a batch. A movement written before godowns were switched on carries
--  no store, and those goods belong in the main store -- so the view has
--  always had a one-row lookup, `main`, for whichever store the firm calls its
--  main one, and coalesced each movement onto it.
--
--  That lookup sat INSIDE the grouping. Postgres saw a table of one row,
--  decided a nested loop was cheapest, and then read that one row once per
--  movement:
--
--      CTE Scan on main   (rows=1 loops=59420)   Buffers: shared hit=118871
--
--  118,871 page reads to answer a question whose answer is one row. Measured
--  on the big book, one firm, 59,420 movements: 421 ms, of which 35 ms was
--  the actual folding.
--
--  The fold is now done in two passes. The first groups the movements alone,
--  which is the heavy pass and now touches nothing else. The second takes
--  those few thousand grouped lines, coalesces the ones with no store onto
--  the main store, and groups again -- so a firm that has movements both with
--  and without a store still ends up with ONE line for the main store, exactly
--  as before. Then, and only then, the item and store names are joined on.
--
--      before   421 ms      after   98 ms      3.4 times
--
--  Proved identical, not assumed: the old definition was kept side by side
--  under another name and both were read whole, all three firms at once.
--  60,691 rows each, nothing in the old that is not in the new, nothing in
--  the new that is not in the old -- including the no-store rows and the
--  opening-stock rows.
--
--  TWO RULES IN HERE MUST NOT BE BROKEN, and stocksum.sql exists to catch it:
--    * a movement with no godown on it sits in the MAIN store, which the
--      godown screen promises in writing;
--    * opening stock is not a movement, so it arrives by UNION ALL and sits
--      in the main store too.
--
--  And security_invoker is set again, out loud, below. CREATE OR REPLACE VIEW
--  does not promise to keep a view's settings, and this view without it runs
--  as the owner of the database -- which is every firm's stock, to everyone.
-- ===========================================================================

create or replace view public.stock_in_hand_detail as
with main as (
  select distinct on (org_id) org_id, id, name
    from godowns
   order by org_id, is_main desc, name
),
-- the heavy pass: the movements and nothing else
moved as (
  select m.org_id, m.item_id, m.godown_id, m.batch, m.expiry,
         sum(coalesce(m.qty_in, 0) - coalesce(m.qty_out, 0)) as qty
    from stock_moves m
   group by m.org_id, m.item_id, m.godown_id, m.batch, m.expiry
),
-- the light pass: goods with no store named go to the main store, and a firm
-- with movements both ways still gets one line for it
folded as (
  select d.org_id, d.item_id,
         coalesce(d.godown_id, mn.id) as godown_id,
         d.batch, d.expiry, sum(d.qty) as qty
    from moved d
    left join main mn on mn.org_id = d.org_id
   group by d.org_id, d.item_id, coalesce(d.godown_id, mn.id), d.batch, d.expiry
)
select f.org_id,
       f.item_id,
       i.name as item_name,
       i.unit,
       f.godown_id,
       g.name as godown_name,
       f.batch,
       f.expiry,
       f.qty
  from folded f
  join items i on i.id = f.item_id
  left join godowns g on g.id = f.godown_id

union all

-- and what was there to begin with, which sits in the main store
select i.org_id,
       i.id,
       i.name,
       i.unit,
       mn.id,
       mn.name,
       null::text,
       null::date,
       i.opening_stock
  from items i
  left join main mn on mn.org_id = i.org_id
 where i.is_active
   and coalesce(i.opening_stock, 0) <> 0;

-- SAID OUT LOUD, EVERY TIME THIS VIEW IS TOUCHED.
alter view public.stock_in_hand_detail set (security_invoker = on);


-- ===========================================================================
--   2. TWO INDEXES THAT WERE THE SAME INDEX TWICE
--
--  Both pairs are the same columns, the same order, the same WHERE, the same
--  uniqueness -- byte for byte the same index kept twice. They cost nothing to
--  read and they cost every single write twice over: every bill line written
--  updated one of them twice, every stock movement the other.
--
--      idx_items_barcode        == items_barcode_idx
--      idx_moves_org_item_date  == idx_stock_moves_item_date
--
--  The one with the name the rest of the schema uses is kept. Dropped IF
--  EXISTS because a book restored from an older backup may only have one.
-- ===========================================================================

drop index if exists public.items_barcode_idx;
drop index if exists public.idx_stock_moves_item_date;


-- ===========================================================================
--   3. THE BACKUP COUNTED FROM THE BEGINNING OF THE TABLE EVERY TIME
--
--  book_slice hands the backup one page of a table. It asked for a page with
--  LIMIT and OFFSET -- so page 87 made the database walk past the 172,000 rows
--  it had already sent in order to reach the ones it had not. The last page of
--  a table costs as much as the first eighty-six.
--
--  Timed on the big book, one firm's bill lines, 173,022 rows at 2,000 a page:
--
--      offset   87 calls, 15,214 ms
--      keyset   87 calls,  4,529 ms      3.4 times, same 87 round trips
--
--  and that is server time alone, with no network in it at all. On his line
--  those 87 round trips are another twenty-odd seconds on top, for one of
--  fourteen tables.
--
--  So a page now says where it ended, and the next page starts after it. The
--  order was already `t.id` and has not changed, which is what makes this
--  safe: `where t.id > <last one sent> order by t.id limit n` reads the same
--  rows in the same order, and reaches them through the key instead of by
--  counting.
--
--  Proved, not assumed: both ways were run over the same table and the ids
--  compared. 173,022 rows each, all distinct, nothing in one that is not in
--  the other, and the table itself has 173,022 rows -- so neither way dropped
--  a single line.
--
--  expense_heads and invoice_series are keyed on their own columns rather than
--  an id, and both are small enough to arrive in one page. They keep counting
--  from the beginning, and say so by handing back no ending -- which is how
--  the caller knows to go on asking the old way.
--
--  The old four-argument shape is dropped first. Leaving it would make
--  book_slice(p_table, p_from, p_size, p_year) ambiguous between two
--  functions, and the backup would stop working on the day it is needed.
-- ===========================================================================

drop function if exists public.book_slice(text, int, int, int);

create or replace function public.book_slice(p_table text, p_from int default 0,
                                             p_size int default 2000,
                                             p_year int default null,
                                             p_after text default null)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $sl$
declare
  v_org uuid := my_org_id();
  v_a   date;
  v_b   date;
  v_key text;
  v_when text;
  v_id  boolean;
  j     jsonb;
begin
  if v_org is null then raise exception 'This login is not linked to a firm yet'; end if;
  if my_role() <> 'owner' then
    raise exception 'Only the owner can take a copy of the whole book';
  end if;
  if p_table not in ('godowns','bank_accounts','parties','items','item_parts',
                     'standing_items','expense_heads','invoice_series',
                     'vouchers','voucher_lines','payments','expenses','stock_moves',
                     'cash_moves') then
    raise exception 'There is no % in a Skwik book', p_table;
  end if;
  if coalesce(p_size, 0) < 1 or p_size > 5000 then p_size := 2000; end if;
  if coalesce(p_from, 0) < 0 then p_from := 0; end if;

  if p_year is not null then
    v_a := make_date(p_year, 4, 1);
    v_b := make_date(p_year + 1, 3, 31);
  end if;

  -- SOMETHING TO COUNT FROM.
  -- Paging needs an order that cannot change between one page and the next,
  -- or a row slips through the join between two pages and is simply absent
  -- from the copy. Most tables have an id; the two that do not are keyed on
  -- their own columns, so those are used -- and those two cannot be started
  -- from the last id sent, because they have none.
  v_id  := p_table not in ('expense_heads', 'invoice_series');
  v_key := case p_table
             when 'expense_heads'  then 't.head'
             when 'invoice_series' then 't.kind, t.fy'
             else 't.id'
           end;

  v_when := case p_table
              when 'vouchers'      then 't.vdate between $2 and $3'
              when 'payments'      then 't.pdate between $2 and $3'
              when 'expenses'      then 't.edate between $2 and $3'
              when 'stock_moves'   then 't.mdate between $2 and $3'
              when 'cash_moves'    then 't.mdate between $2 and $3'
              when 'voucher_lines' then 'exists (select 1 from vouchers v'
                                      || ' where v.id = t.voucher_id'
                                      || ' and v.vdate between $2 and $3)'
              else 'true'
            end;

  -- START AFTER THE LAST ONE SENT, not by counting past it. When no ending
  -- was handed back -- the first page, or one of the two tables with no id --
  -- it falls back to counting, which is what it always did.
  execute format($q$
    select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb)
      from (select t.* from %1$I t
             where t.org_id = $1
               and ($2::date is null or %2$s)
               and ($6::uuid is null or %4$s)
             order by %3$s
             limit $4 offset (case when $6::uuid is null then $5 else 0 end)) x $q$,
    p_table, v_when, v_key,
    case when v_id then 't.id > $6::uuid' else 'true' end)
  using v_org, v_a, v_b, p_size, p_from,
        case when v_id then nullif(p_after, '') else null end
  into j;

  return jsonb_build_object('table', p_table, 'from', p_from,
                            'rows', j, 'count', jsonb_array_length(j),
                            -- where this page ended, for the next one to
                            -- start after. Null for the two tables with no
                            -- id, and null for an empty page.
                            'last', case when v_id
                                    then j -> (jsonb_array_length(j) - 1) ->> 'id'
                                    end);
end
$sl$;

revoke all on function public.book_slice(text, int, int, int, text) from public;
grant execute on function public.book_slice(text, int, int, int, text) to authenticated;


-- ===========================================================================
--   MEASURED AND REJECTED, so nobody spends the afternoon on it twice
--
--   *  An index on voucher_lines (org_id, id) to help the backup read pages
--      through the key instead of the primary key. Timed: 4,529 ms to
--      4,129 ms -- nine per cent, in return for a third index to update on
--      every single bill line written. Not worth it.
--
--   *  Indexes on vouchers (org_id, party_id, vdate), payments (org_id,
--      party_id, pdate) and voucher_lines (voucher_id, item_id) include
--      (rate). Every one of the four questions they were meant to help --
--      a party's bills newest first, a party's money, a report asking for
--      two hundred bills' lines, the last rate an item was bought at --
--      already answers in under nine milliseconds on the big book through
--      the indexes that are there. Nothing to win.
-- ===========================================================================
