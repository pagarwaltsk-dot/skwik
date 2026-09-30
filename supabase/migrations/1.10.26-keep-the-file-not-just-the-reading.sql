-- ===========================================================================
--  1.10.26  KEEP THE FILE, NOT JUST WHAT THE READER MADE OF IT
--
--  1.10.19 put his GSTR-2B months away so he would never open the same file
--  twice. What it put away was the reader's OUTPUT -- parsed rows -- and the
--  comment in that migration said, in as many words, "if the reader is ever
--  improved, that month is stale". Six versions later the reader WAS improved
--  (1.10.25 taught it that a 2B spells the taxes igst/cgst/sgst and a 2A
--  spells them iamt/camt/samt) and nothing acted on that warning.
--
--  So he uploaded five months under the old reader, every tax stored as zero,
--  and the fixed build read those same zeros back out of this table:
--
--      SAFE TO CLAIM      0        NOT IN YOUR BOOKS      0
--      AT RISK       14,618        NEEDS A LOOK   14,32,580 across 242 bills
--
--  -- the identical screen the fix was supposed to cure. He had to be told to
--  go and open all five files again by hand, which is the exact chore this
--  table exists to spare him.
--
--  Two columns fix it for good:
--
--      raw     the file as it came off the portal. A GSTR-2B is final once
--              generated, so the file is true for ever and a better reader
--              can be run over it again without asking him for anything.
--      reader  which reader made those rows. The app knows its own number;
--              anything older re-reads itself from `raw` on the next compare.
--
--  A month kept before today has no raw to re-read, so it is marked reader 0
--  and the screen asks for that one file -- once, and never again.
-- ===========================================================================

alter table public.itc_files add column if not exists raw    text;
alter table public.itc_files add column if not exists reader integer not null default 0;


-- ---------------------------------------------------------------------------
--  PUTTING ONE AWAY, WITH THE FILE BESIDE IT.
--
--  The three-argument form is dropped rather than left alongside: two
--  functions of the same name, one of which can take three arguments by
--  default, is not an overload Postgres will choose between -- it raises
--  "function keep_2b is not unique" and the month is not kept at all.
-- ---------------------------------------------------------------------------
drop function if exists public.keep_2b(text, jsonb, text);

create or replace function public.keep_2b(p_period text, p_rows jsonb,
                                          p_name text default null,
                                          p_raw text default null,
                                          p_reader integer default 0)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $k2b$
declare
  v_org  uuid := my_org_id();
  v_was  jsonb;
  v_n    integer;
  v_tax  numeric;
begin
  if v_org is null then raise exception 'This login is not linked to a firm yet'; end if;
  perform assert_can_write();
  if coalesce(p_period, '') !~ '^\d{4}-\d{2}$' then
    raise exception 'Which month does that file belong to?';
  end if;
  if jsonb_typeof(coalesce(p_rows, 'null'::jsonb)) <> 'array' then
    raise exception 'That file held nothing to keep';
  end if;

  -- what was there before, so the screen can say what it replaced
  select jsonb_build_object('doc_count', doc_count, 'taken_at', taken_at,
                            'file_name', file_name)
    into v_was
    from itc_files where org_id = v_org and period = p_period;

  select count(*),
         coalesce(sum((coalesce(r->>'igst','0')::numeric)
                    + (coalesce(r->>'cgst','0')::numeric)
                    + (coalesce(r->>'sgst','0')::numeric)
                    + (coalesce(r->>'cess','0')::numeric)), 0)
    into v_n, v_tax
    from jsonb_array_elements(p_rows) r;

  insert into itc_files (org_id, period, rows, file_name, doc_count, tax_total,
                         taken_at, raw, reader)
  values (v_org, p_period, p_rows, nullif(p_name, ''), v_n, round(v_tax, 2), now(),
          nullif(p_raw, ''), coalesce(p_reader, 0))
  on conflict (org_id, period) do update
    set rows = excluded.rows,
        file_name = excluded.file_name,
        doc_count = excluded.doc_count,
        tax_total = excluded.tax_total,
        taken_at  = excluded.taken_at,
        -- a re-read that arrives without the file must not throw away the
        -- copy already held
        raw       = coalesce(excluded.raw, itc_files.raw),
        reader    = excluded.reader;

  return jsonb_build_object('period', p_period, 'docs', v_n,
                            'tax', round(v_tax, 2), 'replaced', v_was);
end $k2b$;

revoke all on function public.keep_2b(text, jsonb, text, text, integer) from public;
grant execute on function public.keep_2b(text, jsonb, text, text, integer) to authenticated;


-- ---------------------------------------------------------------------------
--  WHAT HE HAS, AND WHETHER IT WANTS READING AGAIN.
--
--  `reader` rides along and `has_raw` says whether Skwik can do that re-read
--  by itself or has to ask him for the file. The rows themselves still stay
--  on the server until a month is actually compared.
-- ---------------------------------------------------------------------------
create or replace function public.my_2b_months()
returns jsonb
language sql
stable
security definer
set search_path to 'public'
as $m2b$
  select coalesce(jsonb_agg(jsonb_build_object(
           'period', f.period, 'docs', f.doc_count, 'tax', f.tax_total,
           'name', f.file_name, 'taken_at', f.taken_at,
           'reader', f.reader, 'has_raw', (f.raw is not null)) order by f.period desc),
         '[]'::jsonb)
    from itc_files f
   where f.org_id = my_org_id();
$m2b$;

revoke all on function public.my_2b_months() from public;
grant execute on function public.my_2b_months() to authenticated;


-- ---------------------------------------------------------------------------
--  THE FILE BACK, FOR A MONTH THAT WANTS RE-READING.
--
--  Fetched one month at a time and only when the reader has moved on, because
--  a year of 2B files is several megabytes and none of it is wanted on an
--  ordinary compare.
-- ---------------------------------------------------------------------------
create or replace function public.raw_2b(p_period text)
returns text
language sql
stable
security definer
set search_path to 'public'
as $r2b$
  select f.raw from itc_files f
   where f.org_id = my_org_id() and f.period = p_period;
$r2b$;

revoke all on function public.raw_2b(text) from public;
grant execute on function public.raw_2b(text) to authenticated;
