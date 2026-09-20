// All money maths lives here, so there is one place to check it.

export const n2 = (x) => Math.round((Number(x) || 0) * 100) / 100;

// TODAY, WHERE HE IS STANDING.
//
// toISOString() answers in UTC, which in India is five and a half hours
// behind. A bill written at two in the morning was being dated the previous
// day — the previous month at a month end, and the previous financial year on
// the 1st of April. Every date in Skwik goes through this instead.
export const today = (d = new Date()) => {
  const x = d instanceof Date ? d : new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
};

// Lets him type sums the way he would on paper: 10x5, 12*2, 5+3+2, 144/12.
// "x" is how a shopkeeper writes times, so x, X and the proper sign are all
// read as multiply. Only digits and + - * / ( ) . are ever evaluated,
// nothing else can run.
export function calc(x) {
  const raw = String(x ?? '').trim();
  // "1 1/2" is one and a half. Stripping the space first made it eleven
  // halves, which is a real quantity on a real bill and nobody would notice.
  const mixed = raw.match(/^(\d+)\s+(\d+)\s*\/\s*(\d+)$/);
  if (mixed) {
    const d = Number(mixed[3]);
    return d ? Number(mixed[1]) + Number(mixed[2]) / d : Number(mixed[1]);
  }
  let s = raw.replace(/\s+/g, '').replace(/,/g, '');
  if (!s) return 0;
  s = s.replace(/[xX×*]/g, '*').replace(/[÷]/g, '/');
  if (/^[0-9]*\.?[0-9]*$/.test(s)) return Number(s) || 0;      // a plain number
  if (!/^[0-9+\-*/().]+$/.test(s)) return Number(s.replace(/[^0-9.]/g, '')) || 0;
  try {
    // eslint-disable-next-line no-new-func
    const v = Function('"use strict";return (' + s + ')')();
    return Number.isFinite(v) ? v : 0;
  } catch (e) { return 0; }
}

export const num = calc;

// What the box should show once he moves on: the sum worked out, written
// plainly. "10x5" becomes "50", "12.50" stays "12.50", rubbish stays put so
// he can see it and fix it.
export function settle(x) {
  const raw = String(x ?? '').trim();
  if (!raw) return '';
  if (/^[0-9]*\.?[0-9]*$/.test(raw)) return raw;          // already a plain number
  const v = calc(raw);
  if (!v && !/^[0-9]/.test(raw)) return raw;               // could not read it: leave it
  return String(Math.round(v * 1000) / 1000);
}

export const fmt  = (x) => (Number(x) || 0).toLocaleString('en-IN',
  { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const fmt0 = (x) => Math.round(Number(x) || 0).toLocaleString('en-IN');

// A QUANTITY OR A RATE, WRITTEN AS HE ENTERED IT.
//
// Never round either of these on a printed bill. Two and a half kilos is not
// three kilos, and a rate of 12.50 printed as 13 makes the customer's own
// multiplication disagree with the amount beside it. Whole numbers still print
// whole: 48, not 48.00.
export const qty = (x) => {
  const v = Number(x) || 0;
  const d = Math.abs(v % 1) < 0.0005 ? 0 : (Math.abs((v * 100) % 1) < 0.05 ? 2 : 3);
  return v.toLocaleString('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d });
};

// A tax rate: 18%, 2.5%, 0.25%. Halving 5 gives 2.5, and printing that as 3
// puts a rate on the bill that does not produce the amount beside it.
export const pct = (x) => {
  const v = Number(x) || 0;
  return (Math.abs(v % 1) < 0.0005 ? v.toFixed(0) : String(Math.round(v * 1000) / 1000));
};

// WHAT KIND OF SUPPLY A LINE IS.
//
// Not everything a shop sells carries tax, and the difference is not cosmetic:
// GSTR-1 Table 8 asks for nil-rated, exempted and non-GST supplies as three
// separate figures, and a kirana shop's counter is full of them. After GST 2.0
// (22 September 2025) UHT milk, paneer and Indian breads are nil-rated, and a
// shop that bills them as "0% taxable" files a return with an empty Table 8
// and an overstated taxable turnover.
//
//   taxable  — ordinary goods, tax at the line's rate
//   nil      — nil-rated: inside GST, rate is zero (milk, bread, fresh produce)
//   exempt   — exempted by notification, or wholly exempt supplies
//   non_gst  — outside GST altogether (petrol, diesel, alcohol for human
//              consumption, electricity)
//
// Only 'taxable' ever produces tax. The other three are carried at their value
// and reported separately.
export const SUPPLY_KINDS = [
  { key: 'taxable', label: 'Taxable',      short: '' },
  { key: 'nil',     label: 'Nil-rated',    short: 'NIL' },
  { key: 'exempt',  label: 'Exempt',       short: 'EXM' },
  { key: 'non_gst', label: 'Outside GST',  short: 'NON-GST' },
];

export const supplyOf = (l) => {
  const s = String(l?.supply || '').trim().toLowerCase();
  return (s === 'nil' || s === 'exempt' || s === 'non_gst') ? s : 'taxable';
};

export const isTaxableLine = (l) => supplyOf(l) === 'taxable';

export const supplyLabel = (k) =>
  (SUPPLY_KINDS.find((s) => s.key === supplyOf({ supply: k })) || SUPPLY_KINDS[0]).label;

export const supplyShort = (k) =>
  (SUPPLY_KINDS.find((s) => s.key === supplyOf({ supply: k })) || SUPPLY_KINDS[0]).short;

// Which tax applies. The shopkeeper never chooses this.
//   firm not registered            -> no GST at all
//   firm on composition scheme     -> no GST at all (he pays it himself)
//   buyer's state = firm's state   -> CGST + SGST
//   buyer's state different        -> IGST
// Does this firm put HSN codes on its bills?
//   not registered              -> no
//   composition, switched off   -> no (his choice; he charges no tax anyway)
//   everyone else               -> yes, and it is compulsory
export function hsnApplies(org) {
  if (!org?.is_gst_registered) return false;
  if (org?.is_composition && org?.hsn_enabled === false) return false;
  return true;
}

// NOTHING LEAVES THE SHOP AT NOTHING.
//
// An item can reach a sale bill with no selling price on it — bought in a
// hurry, imported from a list that only carried cost, or created mid-purchase
// before anyone thought about what it would fetch. A line at zero is not a
// discount, it is a giveaway: it walks out of the door for free, it drags the
// day's takings down, and it shows the customer a rate of 0.00 in print.
//
// So a sale rate is never nothing. If the item carries its own price that is
// what is used. If it does not, the rate falls back to what the shop paid for
// it plus a tenth — a figure that is at worst wrong, which the shopkeeper can
// see and correct, rather than a figure that is certainly wrong and silent.
//
// The markup is deliberately modest. It is a floor to stop a giveaway, not a
// guess at what the shop actually charges.
export const MARKUP = 0.10;

export function saleRate(item, list = 1) {
  const own = Number(list) === 2
    ? (num(item?.price2) || num(item?.sale_price))
    : num(item?.sale_price);
  if (own > 0) return own;
  const cost = num(item?.purchase_price);
  if (cost > 0) return n2(cost * (1 + MARKUP));
  return 0;                                   // nothing known at all
}

// Was that rate the shop's own, or the one worked out from cost? The bill
// screen says so on the line, so a made-up figure is never mistaken for a
// price somebody set.
export const rateIsGuessed = (item, list = 1) => {
  const own = Number(list) === 2
    ? (num(item?.price2) || num(item?.sale_price))
    : num(item?.sale_price);
  return own <= 0 && num(item?.purchase_price) > 0;
};

// WHERE THE SUPPLY TAKES PLACE.
//
// Section 10(1)(a) puts it where the goods end up when they are sent. Section
// 10(1)(c) puts it where they are handed over when there is no sending — a
// counter sale. Skwik used to take the buyer's state either way, so a walk-in
// from another state paying cash across the counter was billed IGST and
// reported in the wrong table of GSTR-1.
//
// A cash sale to somebody without a GST number is a counter sale. Anyone
// registered is being supplied at the place he is registered.
export function placeOfSupply(org, party, overTheCounter = false) {
  const here  = String(org?.state_code || '').trim();
  const there = String(party?.state_code || '').trim();
  if (overTheCounter && !party?.gstin) return here || there;
  return there || here;
}

// WHAT A PURCHASE BILL CARRIES.
//
// A shop's own SALES follow taxModeFor: unregistered and composition shops
// charge nothing. A PURCHASE is the supplier's bill, and a REGISTERED supplier
// charges tax whatever kind of shop this is. It has to be recorded, because:
//
//   * a registered shop claims it back, so the goods cost the price before tax
//   * a composition dealer and an unregistered shop claim nothing, so the tax
//     is part of what the goods cost — 10 pieces at 100 with 5% on them cost
//     105 each, not 100
//
// AN UNREGISTERED SUPPLIER CHARGES NO TAX AT ALL, and this is the part Skwik
// used to get wrong: it taxed every purchase, whoever it came from, so a shop
// buying from the man down the road was recording input credit that does not
// exist. Claiming it is a section 16 problem on assessment. A supplier with no
// GSTIN on file carries no tax — the same test the rest of the app uses to
// decide whether a buyer is registered.
//
// purchase_unit_cost() in the database decides which of the first two applies.
export function purchaseTaxMode(org, party) {
  // no GST number on the supplier: he cannot have charged GST
  if (!String(party?.gstin || '').trim()) return 'none';
  const here  = String(org?.state_code || '').trim();
  const there = String(party?.state_code || '').trim() || here;
  if (!here) return 'cgst_sgst';
  return there === here ? 'cgst_sgst' : 'igst';
}

// Does the tax on a purchase go into the cost of the goods?
export const taxIsCost = (org) =>
  !org?.is_gst_registered || !!org?.is_composition;

export function taxModeFor(org, party, overTheCounter = false) {
  if (!org?.is_gst_registered) return 'none';
  // A composition dealer is registered but may NOT collect GST from anyone.
  if (org?.is_composition) return 'none';
  const here = String(org.state_code || '').trim();
  if (!here) return 'cgst_sgst';
  return placeOfSupply(org, party, overTheCounter) === here ? 'cgst_sgst' : 'igst';
}

// Rates are entered WITHOUT GST. Tax is added on top, the way Tally does it.
//
// A DISCOUNT comes off the line before the tax is worked out. Rule 46(k) asks
// for the taxable value AFTER discount, and charging tax on a price nobody
// paid overcharges the customer and overstates the return.
//
// FREIGHT, packing, labour — whatever the last box on the screen is called —
// is part of the value of the supply under section 15(2)(c) and carries tax
// like everything else on the bill. Left untaxed it under-collects, and the
// invoice value stops matching the sum of its own lines, which is one of the
// things the portal checks. `extra_gst_rate` is the rate it carries; the
// screen offers the highest rate on the bill, which is the usual treatment
// for a composite supply, and the shopkeeper can change it.
// ONE DISCOUNT, ON THE WHOLE BILL.
//
// A discount per line meant answering the same question five times on one
// bill, and the result read as five arguments with the customer instead of
// one round figure at the bottom — which is how it is actually done at a
// counter. So `extra.discount` is the figure he types once.
//
// Behind the scenes it is still SHARED OUT across the lines, in proportion to
// what each line is worth, because GST asks for the taxable value of each
// rate AFTER discount. A bill of 1,000 at 5% and 3,000 at 18% with 400 off
// takes 100 off the first and 300 off the second, and each rate is taxed on
// what was really charged for it. The rounding remainder goes on the largest
// line, so the shares always add back to the figure he typed.
function shareOut(discount, grosses) {
  const total = n2(grosses.reduce((a, g) => a + g, 0));
  const want  = Math.min(Math.abs(n2(discount)), total);
  if (!(want > 0) || !(total > 0)) return grosses.map(() => 0);

  const parts = grosses.map((g) => n2((want * g) / total));
  // put whatever the rounding left over onto the biggest line
  let big = 0;
  for (let i = 1; i < grosses.length; i++) if (grosses[i] > grosses[big]) big = i;
  const drift = n2(want - parts.reduce((a, x) => a + x, 0));
  parts[big] = n2(parts[big] + drift);
  // and never let a share be more than the line it comes off
  for (let i = 0; i < parts.length; i++) parts[i] = Math.min(Math.max(parts[i], 0), grosses[i]);
  return parts;
}

// REVERSE CHARGE: THE SHOP DOES NOT COLLECT THE TAX.
//
// When a supply is under reverse charge the RECIPIENT pays the tax to the
// government himself. Section 9(3)/9(4) puts the liability on him, and the
// supplier's job under Rule 46(p) is only to say so on the face of the
// invoice. A supplier who collects it anyway has collected tax he was never
// entitled to: section 76 takes 100% of it as penalty, recoverable in cash,
// with no set-off against input credit.
//
// Skwik used to tick the box, print "Reverse charge: Yes", and still add CGST
// and SGST to the total. It no longer does. Under reverse charge the bill
// carries the taxable value and nothing else, and the declaration prints.
export function computeBill(lines, mode, extra = {}) {
  let taxable = 0, cgst = 0, sgst = 0, igst = 0;
  let nilRated = 0, exempt = 0, nonGst = 0;

  const rcm = !!extra.reverseCharge;

  const split = (t, rate) => {
    if (rcm) return { c: 0, s: 0, i: 0 };
    const tax = n2((n2(t) * num(rate)) / 100);
    if (mode === 'cgst_sgst') { const c = n2(tax / 2); return { c, s: c, i: 0 }; }
    if (mode === 'igst') return { c: 0, s: 0, i: tax };
    return { c: 0, s: 0, i: 0 };
  };

  const grosses = lines.map((l) => n2(num(l.qty) * num(l.rate)));
  // The bill's own discount when there is one; otherwise whatever the lines
  // are already carrying, so a bill written before this change still adds up.
  //
  // `extra.discount` of 0 is a real answer, not an absent one: it is how a
  // discount is TAKEN OFF a bill that already had one. So the bill's figure
  // wins whenever the caller supplied one at all, and the per-line fallback
  // is only for bills written before this screen existed.
  const hasBillDisc = extra.discount !== undefined && extra.discount !== null && extra.discount !== '';
  const billDisc = n2(num(extra.discount));
  const shares = hasBillDisc
    ? shareOut(billDisc, grosses)
    : lines.map((l, i) => Math.min(Math.abs(n2(num(l.disc))), grosses[i]));

  const out = lines.map((l, i) => {
    const gross = grosses[i];
    const disc  = shares[i];
    const t     = n2(gross - disc);
    const kind  = supplyOf(l);
    // Only an ordinary taxable line is TAXED. Nil-rated, exempt and non-GST
    // lines are carried at value and reported in their own buckets.
    //
    // `taxAt` is what the tax is worked out on; `l.gst_rate` is what the line
    // was entered at, and it STAYS on the line. Overwriting it with 0 threw
    // the shopkeeper's own figure away: mark a 5% line nil-rated, save, and
    // the 5% was gone for good — switching it back later gave a bill with no
    // tax on it and nothing on screen to say so.
    const taxAt = (mode === 'none' || kind !== 'taxable') ? 0 : num(l.gst_rate);
    const { c, s, i: ig } = split(t, taxAt);

    if (kind === 'nil')          nilRated = n2(nilRated + t);
    else if (kind === 'exempt')  exempt   = n2(exempt + t);
    else if (kind === 'non_gst') nonGst   = n2(nonGst + t);

    taxable = n2(taxable + t);
    cgst = n2(cgst + c); sgst = n2(sgst + s); igst = n2(igst + ig);
    return {
      ...l, supply: kind, disc,
      gross, taxable: t, gst_rate: num(l.gst_rate),
      cgst: c, sgst: s, igst: ig, amount: t,
    };
  });

  // freight and the like, taxed at the rate the bill carries
  const extraAmt  = n2(num(extra.amount));
  const extraRate = mode === 'none' ? 0 : num(extra.gst_rate);
  if (extraAmt) {
    const { c, s, i } = split(extraAmt, extraRate);
    taxable = n2(taxable + extraAmt);
    cgst = n2(cgst + c); sgst = n2(sgst + s); igst = n2(igst + i);
  }

  const exact = n2(taxable + cgst + sgst + igst);
  const total = Math.round(exact);
  return {
    lines: out, taxable, cgst, sgst, igst,
    discount: n2(out.reduce((a, l) => a + num(l.disc), 0)),
    gross: n2(grosses.reduce((a, g) => a + g, 0)),
    extra_amount: extraAmt, extra_gst_rate: extraRate,
    reverse_charge: rcm,
    // GSTR-1 Table 8 wants these three apart from one another
    nil_rated: nilRated, exempt, non_gst: nonGst,
    round_off: n2(total - exact), total,
  };
}

// What freight should be taxed at, offered before he is asked: the highest
// rate on the bill. A composite supply carries the rate of its principal
// supply, and on a shop's bill that is the dearest-taxed thing on it. A
// nil-rated or exempt line has no rate to offer, so it is passed over.
export const topRate = (lines) =>
  (lines || []).reduce((m, l) => (isTaxableLine(l) ? Math.max(m, num(l.gst_rate)) : m), 0);

// FREIGHT, AS IF IT WERE A LINE.
//
// Freight is taxed with the goods, so it has to appear in the HSN summary as
// well — otherwise the summary's own rows do not add up to its total, and the
// same hole turns up in the return. It is given the HSN of the first line
// carrying its rate, which is what the composite-supply rule points at.
export function extraAsLine(voucher, lines = []) {
  const amt  = n2(num(voucher?.extra_amount));
  if (!amt) return null;
  const rate = num(voucher?.extra_gst_rate);
  const mode = voucher?.tax_mode;
  const rcm  = !!voucher?.reverse_charge;
  const tax  = (mode === 'none' || rcm) ? 0 : n2((amt * rate) / 100);
  const half = n2(tax / 2);
  const like = lines.find((l) => num(l.gst_rate) === rate);
  return {
    item_name: voucher?.extra_note || 'Freight & other charges',
    hsn: like?.hsn || '', unit: '', qty: 0, rate: amt, disc: 0,
    supply: 'taxable',
    gst_rate: rate, taxable: amt, gross: amt, amount: amt,
    cgst: mode === 'cgst_sgst' ? half : 0,
    sgst: mode === 'cgst_sgst' ? half : 0,
    igst: mode === 'igst' ? tax : 0,
  };
}

// Group the lines by HSN for the summary table on a tax invoice.
// Nil-rated, exempt and non-GST lines are kept apart from taxable ones even
// when they share an HSN, because they are reported apart.
export function hsnSummary(lines) {
  const map = {};
  lines.forEach((l) => {
    const kind = supplyOf(l);
    const k = `${l.hsn || '-'}|${num(l.gst_rate)}|${kind}`;
    if (!map[k]) {
      map[k] = {
        hsn: l.hsn || '-', taxable: 0, cgst: 0, sgst: 0, igst: 0,
        gst_rate: num(l.gst_rate), supply: kind,
      };
    }
    map[k].taxable = n2(map[k].taxable + n2(l.taxable));
    map[k].cgst    = n2(map[k].cgst + n2(l.cgst));
    map[k].sgst    = n2(map[k].sgst + n2(l.sgst));
    map[k].igst    = n2(map[k].igst + n2(l.igst));
  });
  return Object.values(map);
}

// What each line was worth BEFORE its share of the bill discount came off.
//
// The printed bill shows the gross amount on the line and the discount once,
// as a single round figure at the foot. Showing the net amount AND the
// discount row takes the discount off twice on the paper, and the column
// stops adding up to the total printed under it — which is the first thing a
// customer or an officer checks. Stored lines carry the net amount, so the
// gross is the net plus that line's share.
export const lineGross = (l) =>
  (l?.gross != null ? n2(num(l.gross)) : n2(num(l?.amount) + Math.abs(num(l?.disc))));

// What the item lines add up to before the discount — the "Items" figure on a
// counter slip. It has to come from the lines themselves: voucher.taxable
// already has freight inside it, so adding the discount back to that figure
// over-states the goods by the freight.
export const itemsGross = (lines = []) =>
  n2((lines || []).reduce((s, l) => s + lineGross(l), 0));

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten',
  'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

const under100 = (n) => (n < 20 ? ONES[n] : `${TENS[Math.floor(n / 10)]}${n % 10 ? ' ' + ONES[n % 10] : ''}`);
const under1000 = (n) => {
  const h = Math.floor(n / 100), r = n % 100;
  return `${h ? ONES[h] + ' Hundred' : ''}${h && r ? ' ' : ''}${r ? under100(r) : ''}`;
};

// Indian system: crore, lakh, thousand.
// The grand total of a bill is always a whole rupee, so it needs no paise.
// The tax total does: 122.50 written as "One Hundred Twenty Three Only" is a figure
// in words that contradicts the figure beside it. Pass withPaise for those.
export function amountInWords(amount, withPaise = false) {
  const v = Math.abs(Number(amount) || 0);
  let n = withPaise ? Math.floor(n2(v)) : Math.round(v);
  const paise = withPaise ? Math.round((n2(v) - n) * 100) : 0;
  if (!n && !paise) return 'Indian Rupees Zero Only';
  const parts = [];
  const crore = Math.floor(n / 10000000); n %= 10000000;
  const lakh  = Math.floor(n / 100000);   n %= 100000;
  const thou  = Math.floor(n / 1000);     n %= 1000;
  if (crore) parts.push(`${under1000(crore)} Crore`);
  if (lakh)  parts.push(`${under1000(lakh)} Lakh`);
  if (thou)  parts.push(`${under1000(thou)} Thousand`);
  if (n)     parts.push(under1000(n));
  const sign = (Number(amount) || 0) < 0 ? 'Minus ' : '';
  const rup  = parts.length ? parts.join(' ') : 'Zero';
  return paise
    ? `${sign}Indian Rupees ${rup} and ${under100(paise)} Paise Only`
    : `${sign}Indian Rupees ${rup} Only`;
}
