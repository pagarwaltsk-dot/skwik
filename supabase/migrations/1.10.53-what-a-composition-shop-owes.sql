-- =========================================================================
--  CMP-08: WHAT A COMPOSITION SHOP OWES FOR THE QUARTER
--
--  A composition dealer does not file GSTR-1 or 3B. He files a CMP-08 every
--  quarter -- a single self-assessed figure -- and a GSTR-4 once a year. Skwik
--  told him correctly that 1 and 3B were not his, and then gave him nothing
--  in their place, which is the whole of what he actually has to file.
--
--  HOW THE FIGURE IS WORKED OUT. Tax is a flat percentage of turnover, and
--  the percentage depends on the trade:
--
--      1%   traders and manufacturers      (0.5 central + 0.5 state)
--      5%   restaurants and food service   (2.5 + 2.5)
--      6%   service providers, s.10(2A)    (3 + 3)
--
--  So the rate is a fact about the shop, not about any bill, and it is kept on
--  the firm row. One per cent is the default because it covers every shop that
--  sells goods, which is who Skwik is for.
--
--  TURNOVER COUNTS ESTIMATES. A shop that charges no GST bills in Skwik's
--  estimate mode, so its sales are saved with vtype 'estimate', not 'sale'.
--  Counting only 'sale' would report nought of turnover for the very shops
--  this function exists for. fy_sales_total already counts both, and this
--  follows it -- cancelled bills out, counts_as_sale respected, sale returns
--  taken off.
--
--  REVERSE CHARGE IS SEPARATE AND IS NOT AT THE COMPOSITION RATE. Section
--  9(3) tax on inward supplies -- a transporter's bill, most weeks -- is paid
--  in CASH at the normal rate, and a composition dealer may not set his 1%
--  against it. So it is reported beside the turnover tax and added at the end,
--  never folded in. rcm_summary already has those figures.
-- =========================================================================

alter table orgs add column if not exists composition_rate numeric;

comment on column orgs.composition_rate is
  'Per cent of turnover a composition dealer pays: 1 for a trader or maker, 5 for a restaurant, 6 for a service under s.10(2A). Null reads as 1.';

create or replace function public.cmp08(p_from date, p_to date)
returns jsonb language plpgsql stable security definer set search_path to 'public' as $fn$
declare
  v_org    uuid := my_org_id();
  v_reg    boolean;
  v_comp   boolean;
  v_rate   numeric;
  v_out    numeric := 0;   -- what he billed
  v_back   numeric := 0;   -- what came back
  v_turn   numeric := 0;   -- turnover, the two netted
  v_bills  int     := 0;
  v_rets   int     := 0;
  v_tax    numeric := 0;
  v_half   numeric := 0;
  v_other  numeric := 0;
  v_rcm    jsonb;
  v_rcmtax numeric := 0;
begin
  if v_org is null then raise exception 'This login is not linked to a firm yet'; end if;
  if p_from is null or p_to is null or p_to < p_from then
    raise exception 'Give a quarter that starts before it ends';
  end if;

  select coalesce(is_gst_registered,false), coalesce(is_composition,false),
         coalesce(composition_rate, 1)
    into v_reg, v_comp, v_rate
    from orgs where id = v_org;

  -- SAID PLAINLY, AND WITH WHAT IS HIS INSTEAD.
  --
  -- A shop with no registration files nothing at all, and a regular dealer
  -- files 1 and 3B. Answering either of them with a tax figure would be worse
  -- than answering with nothing.
  if not v_reg then
    return jsonb_build_object('ok', false,
      'why', 'A shop with no GST registration files no return at all. There is no CMP-08 to make.');
  end if;
  if not v_comp then
    return jsonb_build_object('ok', false,
      'why', 'CMP-08 is the composition scheme''s return. A regular dealer files GSTR-1 and GSTR-3B instead.');
  end if;

  -- WHAT HE BILLED. Estimates counted, because that is how a shop that
  -- charges no GST bills in Skwik (see the note at the top of this file).
  select coalesce(sum(total),0), count(*)
    into v_out, v_bills
    from vouchers
   where org_id = v_org
     and vtype in ('sale', 'estimate')
     and cancelled_at is null
     and coalesce(counts_as_sale, true)
     and vdate between p_from and p_to;

  -- AND WHAT CAME BACK OFF IT. Turnover is net of returns; taxing goods a
  -- customer brought back would have him pay on a sale that did not happen.
  select coalesce(sum(total),0), count(*)
    into v_back, v_rets
    from vouchers
   where org_id = v_org
     and vtype = 'sale_return'
     and cancelled_at is null
     and vdate between p_from and p_to;

  v_turn := round(greatest(v_out - v_back, 0), 2);

  -- THE REMAINDER ON THE SECOND HALF, so the two halves add back to the whole
  -- and his cash ledgers agree with the figure he was shown.
  v_tax  := round(v_turn * v_rate / 100, 2);
  v_half := round(v_tax / 2, 2);
  v_other := round(v_tax - v_half, 2);

  -- REVERSE CHARGE, AT THE NORMAL RATE AND IN CASH. Not at 1%, and not set
  -- off against anything.
  v_rcm := rcm_summary(p_from, p_to);
  v_rcmtax := round(coalesce((v_rcm->>'cgst')::numeric,0)
                  + coalesce((v_rcm->>'sgst')::numeric,0)
                  + coalesce((v_rcm->>'igst')::numeric,0), 2);

  return jsonb_build_object(
    'ok',        true,
    'from',      p_from,
    'to',        p_to,
    'billed',    round(v_out, 2),
    'returned',  round(v_back, 2),
    'turnover',  v_turn,
    'bills',     v_bills,
    'returns',   v_rets,
    'rate',      v_rate,
    'cgst',      v_half,
    'sgst',      v_other,
    'tax',       round(v_half + v_other, 2),
    'rcm',       v_rcm,
    'rcm_tax',   v_rcmtax,
    'pay',       round(v_half + v_other + v_rcmtax, 2)
  );
end
$fn$;

revoke all on function public.cmp08(date, date) from public;
grant execute on function public.cmp08(date, date) to authenticated;
