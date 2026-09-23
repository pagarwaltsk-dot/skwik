-- ===========================================================================
--  SKWIK 1.9.12  —  the GSTR-3B figures
--
--  Run after 1.9.10. Safe to run twice. Changes no data.
--
--  WHAT THIS IS, AND WHAT IT IS NOT
--
--  It is every box of a GSTR-3B that can honestly be worked out from a shop's
--  own books, so his accountant types four or five numbers instead of adding
--  up a month by hand.
--
--  It is NOT a filled return, and two boxes in particular CANNOT come from
--  here, so they are returned as null and named:
--
--    4(B)  input credit reversed — rule 42 and 43 turn on the proportion of
--          exempt supplies, on capital goods schedules, and on suppliers not
--          paid within 180 days. None of that lives in a billing book.
--    6.1   tax paid — how much settled in cash and how much out of the credit
--          balance, plus interest and late fee. That balance is on the
--          portal, and Skwik cannot see the portal.
--
--  A zero in those boxes would be a lie that reads like a fact, so they come
--  back empty with the reason attached.
-- ===========================================================================

begin;

create or replace function public.gstr3b_summary(p_from date, p_to date)
returns jsonb language plpgsql stable security definer set search_path to 'public' as $fn$
declare
  v_org   uuid := my_org_id();
  v_reg   boolean; v_comp boolean; v_claim boolean; v_home text;
  -- 3.1(a) outward taxable
  a_val numeric := 0; a_i numeric := 0; a_c numeric := 0; a_s numeric := 0;
  -- 3.1(c) nil and exempt, 3.1(e) outside GST
  c_val numeric := 0; e_val numeric := 0;
  -- 3.1(d) inward on reverse charge
  d jsonb;
  -- 3.2 inter-state to people with no GST number
  t32 jsonb;
  -- 4(A)(5) all other input credit
  a5_i numeric := 0; a5_c numeric := 0; a5_s numeric := 0;
  -- 5 inward that carried no tax
  five_val numeric := 0;
  notes jsonb := '[]'::jsonb;
begin
  if v_org is null then raise exception 'This login is not linked to a firm yet'; end if;
  if p_from is null or p_to is null or p_to < p_from then
    raise exception 'Give a month that starts before it ends';
  end if;

  select coalesce(is_gst_registered,false), coalesce(is_composition,false),
         coalesce(state_code,'')
    into v_reg, v_comp, v_home from orgs where id = v_org;
  v_claim := v_reg and not v_comp;

  if not v_reg then
    return jsonb_build_object('applies', false,
      'why', 'This shop is not registered under GST, so there is no GSTR-3B to file.');
  end if;
  if v_comp then
    return jsonb_build_object('applies', false,
      'why', 'A composition dealer files CMP-08 every quarter and GSTR-4 once a year, not GSTR-3B.');
  end if;

  -- ---------------- 3.1(a), (c), (e): what went out ----------------
  --
  -- READ FROM THE LINES, NOT FROM THE TOP OF THE BILL.
  --
  -- A bill carries its own nil, exempt and outside-GST figures, and when the
  -- bill screen wrote it they are right. But a bill that came in any other
  -- way — imported from Tally, put back from a backup, or written before
  -- Skwik knew about kinds of supply — has those three sitting at zero while
  -- its LINES say plainly what each one is. Trusting the top of the bill then
  -- counts nil-rated milk as taxable turnover and overstates 3.1(a).
  --
  -- On a test month here that was 62,973 rupees in the wrong box. The lines
  -- always carry the kind, so the lines are what is counted.
  --
  -- Freight has no line of its own and is taxed with the goods, so it is
  -- added back into the taxable figure.
  -- A credit note reduces the month it is raised in, unless section 34(2)
  -- has closed the door on it — the same gst_effective rule GSTR-1 uses.
  with doc as (
    select v.id, v.vtype, v.igst, v.cgst, v.sgst, coalesce(v.extra_amount,0) as freight,
           case when v.vtype = 'sale_return' then -1 else 1 end as sign
      from vouchers v
     where v.org_id = v_org and v.cancelled_at is null
       and v.vdate between p_from and p_to
       and ((v.vtype in ('sale','estimate') and coalesce(v.counts_as_sale,true))
         or (v.vtype = 'sale_return' and coalesce(v.gst_effective,true)))
  ),
  kind as (
    select d.id, d.sign,
           coalesce(sum(vl.taxable) filter (where vl.supply = 'taxable'), 0) as taxable,
           coalesce(sum(vl.taxable) filter (where vl.supply in ('nil','exempt')), 0) as nilex,
           coalesce(sum(vl.taxable) filter (where vl.supply = 'non_gst'), 0) as outside
      from doc d left join voucher_lines vl on vl.voucher_id = d.id
     group by d.id, d.sign
  )
  select coalesce(sum(k.sign * (k.taxable + d.freight)), 0),
         coalesce(sum(d.sign * d.igst), 0),
         coalesce(sum(d.sign * d.cgst), 0),
         coalesce(sum(d.sign * d.sgst), 0),
         coalesce(sum(k.sign * k.nilex), 0),
         coalesce(sum(k.sign * k.outside), 0)
    into a_val, a_i, a_c, a_s, c_val, e_val
    from kind k join doc d on d.id = k.id;

  -- ---------------- 3.2: out of state, to someone unregistered ----------
  select coalesce(jsonb_agg(jsonb_build_object(
           'state', st, 'taxable_value', round(val,2), 'integrated_tax', round(tax,2))
           order by st), '[]'::jsonb)
    into t32
    from (
      select coalesce(nullif(v.place_of_supply_code,''),'') as code,
             coalesce(nullif(p.state_name,''), 'State code ' || v.place_of_supply_code) as st,
             sum(v.taxable - coalesce(v.nil_rated,0) - coalesce(v.exempt_amt,0)
                 - coalesce(v.non_gst,0)) as val,
             sum(v.igst) as tax
        from vouchers v
        left join parties p on p.id = v.party_id
       where v.org_id = v_org and v.cancelled_at is null
         and v.vtype in ('sale','estimate') and coalesce(v.counts_as_sale,true)
         and v.vdate between p_from and p_to
         and coalesce(nullif(v.place_of_supply_code,''), v_home) <> v_home
         and coalesce(nullif(p.gstin,''),'') = ''
       group by 1,2 having sum(v.taxable) <> 0) x;

  -- ---------------- 4(A)(5): input credit on ordinary purchases ---------
  select coalesce(sum(case when vtype='purchase' then igst when vtype='purchase_return' then -igst else 0 end),0),
         coalesce(sum(case when vtype='purchase' then cgst when vtype='purchase_return' then -cgst else 0 end),0),
         coalesce(sum(case when vtype='purchase' then sgst when vtype='purchase_return' then -sgst else 0 end),0)
    into a5_i, a5_c, a5_s
    from vouchers
   where org_id = v_org and cancelled_at is null
     and vtype in ('purchase','purchase_return')
     and not coalesce(reverse_charge,false)
     and vdate between p_from and p_to;

  -- ---------------- 5: inward that carried no tax at all ----------------
  select coalesce(sum(vl.taxable),0) into five_val
    from voucher_lines vl join vouchers v on v.id = vl.voucher_id
   where v.org_id = v_org and v.cancelled_at is null and v.vtype = 'purchase'
     and v.vdate between p_from and p_to
     and vl.supply in ('nil','exempt','non_gst');

  -- ---------------- 3.1(d) and 4(A)(3) come from the reverse-charge sums -
  d := rcm_summary(p_from, p_to);

  notes := notes
    || to_jsonb('3.1(b) zero-rated supplies is shown as nil because Skwik does not mark exports or SEZ supplies. If you made any, your accountant must add them.'::text)
    || to_jsonb('4(B) reversed credit cannot be worked out from a billing book — rule 42 and 43, capital goods, and suppliers unpaid past 180 days. Your accountant fills it.'::text)
    || to_jsonb('6.1 tax paid cannot be worked out here — how much goes from cash and how much from the credit balance depends on the portal.'::text);

  return jsonb_build_object(
    'applies', true, 'from', p_from, 'to', p_to,
    'table_3_1', jsonb_build_object(
      'a_outward_taxable', jsonb_build_object(
        'taxable_value', round(a_val,2), 'integrated_tax', round(a_i,2),
        'central_tax', round(a_c,2), 'state_tax', round(a_s,2)),
      'b_zero_rated', null,
      'c_nil_and_exempt', jsonb_build_object('taxable_value', round(c_val,2)),
      'd_inward_reverse_charge', d->'table_3_1_d',
      'e_non_gst', jsonb_build_object('taxable_value', round(e_val,2))),
    'table_3_2_interstate_unregistered', t32,
    'table_4', jsonb_build_object(
      'a3_reverse_charge', d->'table_4_a_3',
      'a5_all_other_itc', jsonb_build_object(
        'integrated_tax', round(a5_i,2), 'central_tax', round(a5_c,2),
        'state_tax', round(a5_s,2),
        'total', round(a5_i + a5_c + a5_s, 2)),
      'b_reversed', null,
      'c_net_itc', null),
    'table_5_inward_nil_exempt', jsonb_build_object('value', round(five_val,2)),
    'table_6_1_tax_paid', null,
    'your_accountant_fills', notes);
end $fn$;

revoke all on function public.gstr3b_summary(date, date) from public;
grant execute on function public.gstr3b_summary(date, date) to authenticated;

commit;
