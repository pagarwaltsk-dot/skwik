// All money maths lives here, so there is one place to check it.

export const n2 = (x) => Math.round((Number(x) || 0) * 100) / 100;

// Lets him type sums the way he would on paper: 10x5, 12*2, 5+3+2, 144/12.
// "x" is how a shopkeeper writes times, so x, X and the proper sign are all
// read as multiply. Only digits and + - * / ( ) . are ever evaluated,
// nothing else can run.
export function calc(x) {
  let s = String(x ?? '').replace(/\s+/g, '').replace(/,/g, '');
  if (!s) return 0;
  s = s.replace(/[xX\u00D7*]/g, '*').replace(/[\u00F7]/g, '/');
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

export function taxModeFor(org, party) {
  if (!org?.is_gst_registered) return 'none';
  // A composition dealer is registered but may NOT collect GST from anyone.
  if (org?.is_composition) return 'none';
  const here  = String(org.state_code || '').trim();
  const there = String(party?.state_code || '').trim() || here;
  if (!here) return 'cgst_sgst';
  return there === here ? 'cgst_sgst' : 'igst';
}

// Rates are entered WITHOUT GST. Tax is added on top, the way Tally does it.
export function computeBill(lines, mode) {
  let taxable = 0, cgst = 0, sgst = 0, igst = 0;

  const out = lines.map((l) => {
    const t    = n2(num(l.qty) * num(l.rate));
    const rate = mode === 'none' ? 0 : num(l.gst_rate);
    const tax  = n2((t * rate) / 100);
    let c = 0, s = 0, i = 0;
    if (mode === 'cgst_sgst') { c = n2(tax / 2); s = n2(tax - c); }
    else if (mode === 'igst') { i = tax; }

    taxable = n2(taxable + t);
    cgst = n2(cgst + c); sgst = n2(sgst + s); igst = n2(igst + i);
    return { ...l, taxable: t, cgst: c, sgst: s, igst: i, amount: t };
  });

  const exact = n2(taxable + cgst + sgst + igst);
  const total = Math.round(exact);
  return { lines: out, taxable, cgst, sgst, igst, round_off: n2(total - exact), total };
}

// Group the lines by HSN for the summary table on a tax invoice.
export function hsnSummary(lines) {
  const map = {};
  lines.forEach((l) => {
    const k = l.hsn || '-';
    if (!map[k]) map[k] = { hsn: k, taxable: 0, cgst: 0, sgst: 0, igst: 0, gst_rate: num(l.gst_rate) };
    map[k].taxable = n2(map[k].taxable + n2(l.taxable));
    map[k].cgst    = n2(map[k].cgst + n2(l.cgst));
    map[k].sgst    = n2(map[k].sgst + n2(l.sgst));
    map[k].igst    = n2(map[k].igst + n2(l.igst));
  });
  return Object.values(map);
}

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten',
  'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

const under100 = (n) => (n < 20 ? ONES[n] : `${TENS[Math.floor(n / 10)]}${n % 10 ? ' ' + ONES[n % 10] : ''}`);
const under1000 = (n) => {
  const h = Math.floor(n / 100), r = n % 100;
  return `${h ? ONES[h] + ' Hundred' : ''}${h && r ? ' ' : ''}${r ? under100(r) : ''}`;
};

// Indian system: crore, lakh, thousand.
export function amountInWords(amount) {
  let n = Math.round(Number(amount) || 0);
  if (n === 0) return 'Indian Rupees Zero Only';
  const parts = [];
  const crore = Math.floor(n / 10000000); n %= 10000000;
  const lakh  = Math.floor(n / 100000);   n %= 100000;
  const thou  = Math.floor(n / 1000);     n %= 1000;
  if (crore) parts.push(`${under1000(crore)} Crore`);
  if (lakh)  parts.push(`${under1000(lakh)} Lakh`);
  if (thou)  parts.push(`${under1000(thou)} Thousand`);
  if (n)     parts.push(under1000(n));
  return `Indian Rupees ${parts.join(' ')} Only`;
}
