// READING A FILE BY WHAT IS IN IT, NOT BY WHAT IT SAYS AT THE TOP.
//
// Matching headings against a list of names gets a long way and then stops
// dead. It stops on a sheet whose headings are "Column1, Column2, Column3", on
// one exported with no heading row at all, on one written in Assamese, and on
// one where "Rate" means the tax rate in this software and the selling price in
// that one. A shop's file is whatever his nephew typed, and it is not our
// business to tell him he named a column wrongly.
//
// So the heading is ONE piece of evidence among several, and the weakest. The
// strong evidence is in the values:
//
//   SHAPE    an HSN is 4, 6 or 8 digits beginning with a real tariff chapter.
//            A GST number is fifteen characters whose last one is the checksum
//            of the other fourteen. A barcode carries its own check digit.
//            A pincode, a phone number, an email, a unit, a state name.
//
//   THE LAW  a tax rate is one of the rates that were legal ON THE DATE OF
//            THAT BILL. 12% is ordinary in 2023 and worth a second look in
//            2026, and judging both by one list either throws away his real
//            history or lets rubbish through.
//
//   HIS OWN  if nine hundred of a thousand values in a column are the names of
//   BOOKS    items he already has, that column is the item column, whatever it
//            is called and whatever it looks like.
//
//   ARITHMETIC — and this is the one that settles it. A column that LOOKS like
//            a rate is a guess. Three columns where quantity times rate equals
//            amount, on two hundred rows, is not a guess. Taxable times the
//            tax rate equalling the tax, CGST equalling SGST, the lines adding
//            up to the bill: these turn "probably" into "certain", and they
//            work on a file with no headings at all.
//
// NOTHING IS SILENT. Every column comes back with how sure we are. Certain
// ones are used. Probable ones are used AND named on the preview — "column D
// read as HSN" — so he can see what was assumed. Doubtful ones are left out
// and listed, because a figure quietly put in the wrong place is the one kind
// of mistake he cannot find afterwards.

import {
  looksHsn, looksGstin, gstinChecks, looksBarcode, barcodeChecks, looksPhone,
  looksPincode, looksEmail, looksUnit, looksState, isSlab, readDate, dateShape,
  climbs,
} from './canon';

/* ---------------- small helpers over a column of values ---------------- */

const text = (v) => String(v ?? '').trim();
const filled = (vals) => vals.filter((v) => text(v) !== '');

// A number as a shopkeeper's file writes one: 1,234.50 / (500) for a negative
// / ₹ 1200 / 1200.00 Dr. Returns null when it is not a number at all.
export function money(v) {
  let s = text(v);
  if (!s) return null;
  let sign = 1;
  if (/^\(.*\)$/.test(s)) { sign = -1; s = s.slice(1, -1); }
  if (/\b(cr|credit)\b/i.test(s)) sign = -1;
  s = s.replace(/[₹$€£]/g, '').replace(/\b(dr|cr|debit|credit)\b/gi, '')
       .replace(/,/g, '').trim();
  if (!/^-?\d*\.?\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? sign * n : null;
}

const share = (vals, test) => {
  const f = filled(vals);
  if (!f.length) return 0;
  return f.filter(test).length / f.length;
};

const distinct = (vals) => {
  const f = filled(vals);
  if (!f.length) return 0;
  return new Set(f.map((v) => text(v).toLowerCase())).size / f.length;
};

const numeric = (vals) => share(vals, (v) => money(v) !== null);

/* ---------------- what a heading might be called ----------------

   Straight from the software's own words, in the languages and abbreviations
   they actually use. Worth something, never worth much: it is checked last and
   it cannot outvote the values underneath it.                              */

export const NAMES = {
  // ONE NAME COLUMN OR TWO. A masters file has a single name column and it
  // means whatever the file is about. A bill file has TWO — the customer and
  // the goods — and calling them both "name" loses the one that matters, so
  // they are separate fields and `name` is only the fallback for a file that
  // plainly holds one kind of thing.
  item_name:       ['item name', 'itemname', 'product', 'product name', 'stock item',
                    'stockitem', 'goods', 'description of goods', 'item', 'material',
                    'particulars of goods'],
  party_name:      ['party name', 'partyname', 'party', 'customer', 'customer name',
                    'supplier', 'supplier name', 'ledger name', 'ledgername', 'account',
                    'account name', 'vendor', 'buyer', 'client', 'dealer name'],
  name:            ['name', 'particulars', 'particular'],
  alias:           ['alias', 'also called', 'other name', 'short name', 'local name'],
  hsn:             ['hsn', 'hsn code', 'hsncode', 'hsn/sac', 'hsnsac', 'sac', 'sac code',
                    'hsn no', 'tariff'],
  unit:            ['unit', 'uom', 'u o m', 'uqc', 'per', 'units', 'base unit', 'baseunits'],
  gst_rate:        ['gst', 'gst rate', 'gst %', 'gst%', 'tax rate', 'tax %', 'rate of tax',
                    'gstrate', 'taxrate', 'igst rate', 'gst percentage'],
  cess_rate:       ['cess', 'cess rate', 'cess %'],
  qty:             ['qty', 'quantity', 'qnty', 'billed qty', 'actual qty', 'nos', 'pcs'],
  free_qty:        ['free', 'free qty', 'scheme qty', 'free quantity'],
  rate:            ['rate', 'price', 'unit price', 'unitprice', 'sale rate', 'selling price',
                    'sale price', 'saleprice', 'mrp rate', 'list price', 'basic rate'],
  amount:          ['amount', 'value', 'line total', 'net amount', 'total amount', 'amt',
                    'gross amount', 'item total'],
  taxable:         ['taxable', 'taxable value', 'taxable amount', 'assessable value',
                    'basic', 'basic amount', 'net value', 'value before tax'],
  cgst:            ['cgst', 'cgst amount', 'central tax', 'cgst amt'],
  sgst:            ['sgst', 'sgst amount', 'state tax', 'sgst amt', 'utgst'],
  igst:            ['igst', 'igst amount', 'integrated tax', 'igst amt'],
  total:           ['total', 'invoice value', 'bill amount', 'grand total', 'net payable',
                    'invoice total', 'bill total', 'final amount'],
  disc_pct:        ['disc %', 'discount %', 'disc%', 'discount percent', 'disc pct'],
  disc_amount:     ['discount', 'disc', 'discount amount', 'less discount', 'disc amt'],
  freight:         ['freight', 'freight outward', 'transport', 'transportation',
                    'carriage', 'carriage outward', 'delivery charge'],
  packing:         ['packing', 'packing charge', 'packing charges', 'packaging'],
  insurance:       ['insurance', 'insurance charge'],
  other_charge:    ['other charge', 'other charges', 'misc charge', 'additional charge',
                    'loading', 'unloading', 'labour'],
  round_off:       ['round off', 'roundoff', 'rounding', 'round'],
  vdate:           ['date', 'bill date', 'invoice date', 'voucher date', 'dt', 'entry date',
                    'transaction date', 'billdate'],
  voucher_no:      ['bill no', 'invoice no', 'voucher no', 'bill number', 'invoice number',
                    'vch no', 'voucher number', 'doc no', 'bill', 'invoice', 'no', 'reference'],
  vtype:           ['type', 'voucher type', 'vch type', 'vouchertypename', 'entry type'],
  gstin:           ['gstin', 'gst no', 'gst number', 'gstin/uin', 'gstno', 'party gstin',
                    'tax no', 'gstin no'],
  phone:           ['phone', 'mobile', 'contact', 'phone no', 'mobile no', 'contact no',
                    'whatsapp'],
  email:           ['email', 'e-mail', 'mail', 'email id'],
  address:         ['address', 'addr', 'billing address', 'address 1'],
  area:            ['area', 'locality', 'route', 'beat', 'zone', 'town', 'city',
                    'village', 'place', 'market'],
  state_name:      ['state', 'state name', 'place of supply'],
  pincode:         ['pin', 'pincode', 'pin code', 'zip', 'postal code'],
  opening_balance: ['opening balance', 'opening', 'op balance', 'outstanding', 'due',
                    'balance', 'closing balance', 'openingbalance'],
  opening_stock:   ['opening stock', 'stock', 'closing stock', 'qty in hand', 'in hand',
                    'stock qty', 'balance qty', 'openingstock', 'opening qty', 'op qty',
                    'opening quantity', 'stock in hand', 'qty on hand'],
  purchase_price:  ['purchase price', 'purchase rate', 'cost', 'cost price', 'buy price',
                    'purchaseprice', 'last purchase rate'],
  price2:          ['retail', 'retail price', 'second price', 'price 2', 'wholesale',
                    'dealer', 'counter'],
  mrp:             ['mrp', 'max retail price', 'm.r.p.'],
  barcode:         ['barcode', 'bar code', 'ean', 'upc', 'scan code', 'item code'],
  batch:           ['batch', 'batch no', 'lot', 'lot no', 'batch number'],
  expiry:          ['expiry', 'exp', 'expiry date', 'exp date', 'best before'],
  mfg_date:        ['mfg', 'mfg date', 'manufacture date', 'mfd'],
  godown:          ['godown', 'warehouse', 'store', 'location', 'branch'],
  narration:       ['narration', 'remarks', 'note', 'notes', 'comment', 'description'],
  mode:            ['mode', 'payment mode', 'through', 'paid by', 'bank', 'cash/bank'],
  group:           ['group', 'category', 'parent', 'under', 'stock group', 'ledger group'],
};

const NAME_OF = (() => {
  const m = new Map();
  Object.entries(NAMES).forEach(([field, list]) => {
    list.forEach((n) => { if (!m.has(n)) m.set(n, field); });
  });
  return m;
})();

// what to call a field when telling him why
const PLAIN = {
  gstin: 'GST numbers', hsn: 'tariff codes', barcode: 'barcodes with a valid check digit',
  phone: 'mobile numbers', pincode: 'pin codes', email: 'email addresses',
  unit: 'units of measure', state_name: 'state names',
  round_off: 'a rounding — a few paise either way, never rupees',
};

const tidyHead = (h) => text(h).toLowerCase()
  .replace(/[._]/g, ' ').replace(/\s+/g, ' ').trim();

/* ---------------- what the values themselves say ----------------

   Each returns 0 to 1: how much of the column behaves like that field. Only
   the ones a shape or a list can actually recognise are here; the money
   columns are told apart by arithmetic further down, because no amount of
   looking at a column of numbers will ever tell you which one is the rate. */

export function shapeScores(vals, { dates = null } = {}) {
  const f = filled(vals);
  if (!f.length) return {};
  const s = {};
  const put = (k, v) => { if (v > 0.55) s[k] = v; };

  // A COLUMN OF DATES IS A COLUMN OF DATES. Belt and braces over the shape
  // tests below: once the whole column has been read as dates, it is not also
  // offered as a tariff code or a barcode, whatever the digits in it spell.
  if (dates && dates.is && dates.read >= 0.9) {
    s.__date = 0.8 + dates.read * 0.15;
    return s;
  }
  // AND WHEN A COLUMN COULD HONESTLY BE EITHER.
  //
  // 12052026 is the twelfth of May and it is also a tariff code in chapter 12.
  // One value cannot settle it; the column can. Dates climb and almost never
  // repeat; the codes a shop uses repeat constantly and climb not at all. So
  // where both readings survive, that is what decides between them.
  if (dates && dates.is && share(vals, looksHsn) > 0.55) {
    const d = distinct(vals);
    if (climbs(vals) >= 0.9 && d >= 0.7) { s.__date = 0.93; return s; }
  }

  // ONE FIRM SELLS ONE KIND OF THING.
  //
  // Also his, and it is what finally separates a tariff code from a date even
  // when both are eight digits. A steel shop's items are nearly all 7323; a
  // hardware shop's wander over a handful of chapters. Either way the SAME
  // codes come round again and again, because the shop sells what it sells.
  // A column of dates does the opposite — every row is a different day.
  //
  // So an HSN-shaped column that repeats itself is almost certainly an HSN,
  // and one where every single value is different has some explaining to do.
  const hsnShape = share(vals, looksHsn);
  if (hsnShape > 0.55) {
    const d = distinct(vals);
    const repeats = d <= 0.5 ? 1 : d >= 0.95 ? 0.72 : 0.86;
    put('hsn', hsnShape * repeats);
  }
  // A number that passes the check digit is a certainty; one that merely has
  // the right length is a maybe, so it scores lower.
  const gstStrict = share(vals, gstinChecks);
  const gstLoose  = share(vals, looksGstin);
  put('gstin', gstStrict > 0.4 ? Math.max(gstStrict, gstLoose) : gstLoose * 0.8);
  const barStrict = share(vals, barcodeChecks);
  put('barcode', barStrict > 0.4 ? Math.max(barStrict, share(vals, looksBarcode))
                                 : share(vals, looksBarcode) * 0.6);
  put('phone', share(vals, looksPhone));
  put('pincode', share(vals, looksPincode));
  put('email', share(vals, looksEmail));
  put('unit', share(vals, looksUnit));
  put('state_name', share(vals, looksState));

  if (dates && dates.is) put('__date', dates.read);

  // ROUND OFF IS THE ONE COLUMN OF MONEY THAT GIVES ITSELF AWAY.
  //
  // His again: it is twenty paise. Never a hundred rupees, never a thousand —
  // it is whatever was needed to make the bill a whole number, so it lives
  // between minus one and one and it goes both ways. No other money column in
  // a bill behaves remotely like that.
  const nums = filled(vals).map(money).filter((n) => n !== null);
  if (nums.length >= 3 && nums.length === filled(vals).length) {
    const tiny = nums.every((n) => Math.abs(n) <= 1.0);
    const someReal = nums.some((n) => n !== 0);
    if (tiny && someReal) s.round_off = 0.9;
  }
  return s;
}

// A tax rate has to be a rate that existed. Judged against the dates on the
// same rows where there are any, so an old bill is not called wrong.
export function rateScore(vals, dateVals) {
  const f = filled(vals);
  if (!f.length) return 0;
  let good = 0, seen = 0;
  f.forEach((v, i) => {
    const n = money(v);
    if (n === null) return;
    seen++;
    const d = dateVals ? readDate(dateVals[i]) : '';
    if (isSlab(n, d)) good++;
  });
  if (!seen) return 0;
  // a column of nothing but zeroes is every slab and no information
  const allZero = f.every((v) => money(v) === 0);
  return allZero ? 0.3 : good / seen;
}

/* ---------------- the arithmetic ----------------

   THE PART THAT TURNS A GUESS INTO A FACT.

   A file of bill lines has several columns of money and nothing on the face of
   them says which is which. But only one of them is the quantity times another,
   and only one pair stands in the ratio of a legal tax rate. So the columns are
   multiplied against each other and the ones that agree, row after row, are the
   ones we name. It needs no headings at all.                                */

const close = (a, b) => {
  if (a === null || b === null) return false;
  const big = Math.max(Math.abs(a), Math.abs(b));
  if (big < 0.005) return Math.abs(a - b) < 0.005;
  return Math.abs(a - b) <= Math.max(0.02, big * 0.011);   // a paisa, or 1.1%
};

// How often does col[i] * col[j] equal col[k] down the file?
function agrees(rows, i, j, k) {
  let seen = 0, hit = 0;
  for (const r of rows) {
    const a = money(r[i]), b = money(r[j]), c = money(r[k]);
    if (a === null || b === null || c === null) continue;
    if (a === 0 || b === 0) continue;
    seen++;
    if (close(a * b, c)) hit++;
  }
  return seen >= 3 ? hit / seen : 0;
}

// How often is col[k] a legal percentage of col[t]?
function pctOf(rows, t, k, dateCol) {
  let seen = 0, hit = 0;
  for (const r of rows) {
    const base = money(r[t]), tax = money(r[k]);
    if (base === null || tax === null || base === 0) continue;
    seen++;
    const pct = (tax / base) * 100;
    const d = dateCol == null ? '' : readDate(r[dateCol]);
    if (isSlab(Math.round(pct * 1000) / 1000, d)) hit++;
  }
  return seen >= 3 ? hit / seen : 0;
}

// Two columns that carry the same figure row after row — CGST and SGST always
// do, and nothing else in a bill does.
function twins(rows, i, j) {
  let seen = 0, hit = 0;
  for (const r of rows) {
    const a = money(r[i]), b = money(r[j]);
    if (a === null || b === null) continue;
    if (a === 0 && b === 0) continue;
    seen++;
    if (close(a, b)) hit++;
  }
  return seen >= 3 ? hit / seen : 0;
}

// Everything the numbers agree about, found once and handed to the naming.
export function arithmetic(rows, cols, dateCol) {
  const nums = cols.filter((c) => numeric(rows.map((r) => r[c])) > 0.8);
  const found = { products: [], taxes: [], twins: [], sums: [] };

  for (const k of nums) {
    for (const i of nums) {
      if (i === k) continue;
      for (const j of nums) {
        if (j === k || j === i || j < i) continue;
        const score = agrees(rows, i, j, k);
        if (score >= 0.9) found.products.push({ a: i, b: j, c: k, score });
      }
    }
  }
  for (const t of nums) {
    for (const k of nums) {
      if (t === k) continue;
      const score = pctOf(rows, t, k, dateCol);
      if (score >= 0.9) found.taxes.push({ base: t, tax: k, score });
    }
  }
  for (let x = 0; x < nums.length; x++) {
    for (let y = x + 1; y < nums.length; y++) {
      const score = twins(rows, nums[x], nums[y]);
      if (score >= 0.95) found.twins.push({ a: nums[x], b: nums[y], score });
    }
  }
  return found;
}

/* ---------------- the words: which name is which ----------------

   Numbers give themselves away by multiplying. Words do not, and a sheet of
   bill lines has at least three columns of them — the bill number, the
   customer, the goods — that no shape test can tell apart. "Ganesh Store" and
   "Steel Thali" are both just text.

   What tells them apart is HOW THEY REPEAT. Every line of one bill carries the
   same bill number and the same customer; the item changes on every line. So
   the bill number is found first — it repeats in runs and ends in a number —
   and then each remaining column of words is asked one question: does it stay
   the same all the way down a bill, or does it change?

   Stays the same: it belongs to the bill. Changes: it belongs to the line. It
   is the file's own structure answering, which beats any list of headings.   */

const looksLikeRef = (v) => /^[A-Za-z0-9][A-Za-z0-9/\-_. ]{0,24}\d\s*$/.test(text(v));

// A column whose values come in runs: the same value on several rows together.
function runniness(vals) {
  const f = vals.map(text);
  let changes = 0, seen = 0;
  for (let i = 1; i < f.length; i++) {
    if (!f[i] || !f[i - 1]) continue;
    seen++;
    if (f[i] !== f[i - 1]) changes++;
  }
  return seen ? 1 - changes / seen : 0;
}

// WHAT A FIRM IS CALLED, AND WHAT GOODS ARE CALLED.
//
// When a file has one line per bill there is no structure left to read — every
// value in every column is different, and "Ganesh Store" and "Steel Thali" are
// both just two words. But they are not the same TWO WORDS, and in this trade
// the difference is plain enough to write down.
//
// A firm is a Store, a Traders, a Bhandar, an Agency, Brothers, & Sons. Goods
// carry a SIZE — 9x2, 10in, 12L, 500 gm — because that is how a shopkeeper
// tells one from another on his own shelf.
//
// Neither is a law. Plenty of customers are called plain "Ganesh" and plenty of
// items have no size in them, so these only lean; anything they decide comes
// back as probable and is named on the preview, never slipped through quietly.

const FIRM_WORDS = new RegExp('\\b(' + [
  'store', 'stores', 'trader', 'traders', 'trading', 'enterprise', 'enterprises',
  'agency', 'agencies', 'bhandar', 'bhander', 'brothers', 'bros', 'sons', 'company',
  'co', 'corp', 'corporation', 'industries', 'industry', 'hardware', 'emporium',
  'mart', 'market', 'distributors', 'distributor', 'suppliers', 'supplier', 'sales',
  'pvt', 'ltd', 'llp', 'udyog', 'vanijya', 'bhavan', 'agencies',
].join('|') + ')\\b', 'i');

// a size: 9x2, 10 in, 12 ltr, 500gm, 1/2", 25x25x3
const SIZE_IN_IT = /(\d\s*[x*×]\s*\d)|(\d\s*(mm|cm|ft|in|inch|"|ltr|lt|l|ml|kg|gm|g|gsm|no|pc)\b)|(\d+\/\d+)/i;

function firmish(vals) {
  const f = filled(vals);
  if (!f.length) return 0;
  return f.filter((v) => FIRM_WORDS.test(text(v))).length / f.length;
}
function goodsish(vals) {
  const f = filled(vals);
  if (!f.length) return 0;
  return f.filter((v) => SIZE_IN_IT.test(text(v))).length / f.length;
}

export function textRoles(rows, cols, colVals, taken) {
  const out = {};
  const wordy = cols.filter((c) => {
    if (taken.has(c)) return false;
    const f = filled(colVals[c]);
    if (f.length < 3) return false;
    return numeric(colVals[c]) < 0.5;          // not a column of figures
  });
  if (!wordy.length) return out;

  // 1. the bill number: repeats in runs, ends in a digit, not too repetitive
  let billCol = null, billScore = 0.5;
  wordy.forEach((c) => {
    // ONE LINE PER BILL IS STILL A BILL NUMBER.
    //
    // This refused any column where every value was different, to stop it
    // seizing on a column of item names — but a day book with one line per
    // bill has a different number on every row, which is the most ordinary
    // file there is. The shape test below carries the weight instead: a bill
    // number ends in a digit, and "Steel Thali" does not.
    const d = distinct(colVals[c]);
    if (d < 0.02) return;
    const ref = share(colVals[c], looksLikeRef);
    const run = runniness(colVals[c]);
    const score = ref * 0.6 + run * 0.4;
    if (ref > 0.7 && score > billScore) { billScore = score; billCol = c; }
  });
  if (billCol != null) {
    out[billCol] = { field: 'voucher_no', score: 0.72 + billScore * 0.2,
                     why: 'the values repeat down a bill and end in a number' };
  }

  // 2. with the bill known, every other column of words is either part of the
  //    bill or part of the line
  const rest = wordy.filter((c) => c !== billCol);
  if (billCol != null && rest.length) {
    const groups = new Map();
    rows.forEach((r) => {
      const k = text(r[billCol]);
      if (!k) return;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(r);
    });
    const steady = (c) => {
      let same = 0, seen = 0;
      groups.forEach((g) => {
        if (g.length < 2) return;
        seen++;
        if (new Set(g.map((r) => text(r[c]))).size === 1) same++;
      });
      return seen ? same / seen : null;
    };
    const perBill = [], perLine = [];
    rest.forEach((c) => {
      const s = steady(c);
      if (s === null) return;
      (s >= 0.9 ? perBill : perLine).push({ c, steady: s, distinct: distinct(colVals[c]) });
    });
    // the customer is the steadiest column of words that belongs to the bill
    const party = perBill.sort((a, b) => a.distinct - b.distinct)[0];
    if (party) {
      out[party.c] = { field: 'party_name', score: 0.86,
                       why: 'it stays the same all the way down each bill, the way a customer does' };
    }
    // the goods are the column that changes from line to line
    const item = perLine.sort((a, b) => b.distinct - a.distinct)[0];
    if (item) {
      out[item.c] = { field: 'item_name', score: 0.86,
                      why: 'it changes from line to line within one bill, the way the goods do' };
    }
    // ONLY IF IT ACTUALLY ANSWERED. Every bill having one line means no group
    // has two rows to compare, so this test says nothing at all — and it used
    // to stop here anyway, leaving both columns unread when the words below
    // could have settled them.
    if (party || item) return out;
  }

  // 3. WITH A BILL NUMBER BUT NO STRUCTURE TO READ.
  //
  // One line per bill: every column of words has every value different, so the
  // steady-within-a-bill test above had nothing to chew on and both columns
  // were left unread. What is left to go on is the words themselves — a firm
  // is a Store or a Traders, goods carry a size — and where those two point in
  // opposite directions, that is enough to name both.
  //
  // Where they do NOT disagree, nothing is claimed. Two columns of plain words
  // with nothing to separate them stay unread and go on the preview as such,
  // because a customer's goods put on another customer's account is not a
  // mistake he could ever find.
  if (billCol != null && rest.length >= 2) {
    const scored = rest.map((c) => ({
      c, firm: firmish(colVals[c]), goods: goodsish(colVals[c]),
      near: Math.abs(c - billCol),
    }));
    const party = [...scored].sort((a, b) => (b.firm - b.goods) - (a.firm - a.goods))[0];
    const item  = [...scored].sort((a, b) => (b.goods - b.firm) - (a.goods - a.firm))[0];
    const partyLean = party.firm - party.goods;
    const itemLean  = item.goods - item.firm;
    if (party.c !== item.c && (partyLean >= 0.5 || itemLean >= 0.5)) {
      if (partyLean >= 0.5) {
        out[party.c] = { field: 'party_name', score: 0.8,
          why: `${Math.round(party.firm * 100)}% of them read as a firm's name — Store, Traders, Bhandar` };
      }
      if (itemLean >= 0.5) {
        out[item.c] = { field: 'item_name', score: 0.8,
          why: `${Math.round(item.goods * 100)}% of them carry a size in the name, the way goods do` };
      }
      // one side named is enough to name the other, since there are only two
      if (partyLean >= 0.5 && !out[item.c]) {
        out[item.c] = { field: 'item_name', score: 0.74,
          why: 'the other column of words is the customer, so this is the goods' };
      }
      if (itemLean >= 0.5 && !out[party.c]) {
        out[party.c] = { field: 'party_name', score: 0.74,
          why: 'the other column of words is the goods, so this is the customer' };
      }
      return out;
    }
  }

  // 4. A LIST OF ONE KIND OF THING — AND ONLY THEN.
  //
  // On a masters file there is one column of words and it is the name, so the
  // most varied one is a safe answer. On a file of BILLS there are two, and
  // picking the more varied of them is a coin toss that lands a customer's name
  // in the goods. It did exactly that on a file where nothing else could tell
  // them apart. So this only runs where there is no bill number at all; on a
  // bill file that nothing has settled, both columns stay unread and are named
  // on the preview, which is the honest answer and the one he can act on.
  if (billCol != null) return out;

  const best = rest
    .map((c) => ({ c, d: distinct(colVals[c]), len: filled(colVals[c])
      .reduce((a, v) => a + text(v).length, 0) / Math.max(1, filled(colVals[c]).length) }))
    .filter((x) => x.d >= 0.5 && x.len >= 3 && x.len <= 60)
    .sort((a, b) => b.d - a.d)[0];
  if (best) {
    out[best.c] = { field: 'name', score: 0.74,
                    why: 'it is the column of words with the most different values in it' };
  }
  return out;
}

/* ---------------- is the first row a heading? ---------------- */

export function hasHeader(rows) {
  if (rows.length < 2) return false;
  const head = rows[0], body = rows.slice(1, 40);
  const cells = head.filter((h) => text(h) !== '');
  if (!cells.length) return false;
  // A heading is words, not figures or dates, and no two of them are the same.
  const headNumeric = cells.filter((h) => money(h) !== null).length / cells.length;
  const headDated   = cells.filter((h) => readDate(h)).length / cells.length;
  if (headNumeric > 0.4 || headDated > 0.4) return false;
  const uniq = new Set(cells.map(tidyHead)).size / cells.length;
  if (uniq < 0.8) return false;
  // and it does not look like the rows underneath it
  const bodyNumeric = body.length
    ? body.reduce((a, r) => a + r.filter((v) => money(v) !== null).length, 0)
      / Math.max(1, body.length * head.length)
    : 0;
  const known = cells.filter((h) => NAME_OF.has(tidyHead(h))).length / cells.length;
  return known >= 0.25 || bodyNumeric > 0.25;
}

/* ---------------- putting it together ----------------

   Returns, for every column: the field it was read as, how sure we are, and in
   plain words WHY — so the preview can say "column D read as HSN because the
   values are four and eight digit tariff codes" rather than asking him to take
   it on trust.                                                              */

export const CERTAIN = 'certain', PROBABLE = 'probable', DOUBTFUL = 'doubtful';

export function readColumns(rows, { known = {}, headerRow = null } = {}) {
  if (!rows || !rows.length) return { header: false, columns: [], rows: [] };

  const header = headerRow === null ? hasHeader(rows) : headerRow;
  const heads = header ? rows[0] : [];
  const body = header ? rows.slice(1) : rows;
  const width = rows.reduce((w, r) => Math.max(w, r.length), 0);
  const cols = Array.from({ length: width }, (_, i) => i);
  const sample = body.slice(0, 400);
  const colVals = cols.map((c) => sample.map((r) => r[c]));

  // which column holds the dates, worked out first because the tax rates are
  // judged against it
  const dateShapes = colVals.map((v) => dateShape(v));
  let dateCol = null, best = 0.8;
  dateShapes.forEach((d, i) => { if (d.is && d.read > best) { best = d.read; dateCol = i; } });

  const link = arithmetic(sample, cols, dateCol);

  // ---- gather the evidence for every column ----
  const evidence = cols.map((c) => {
    const vals = colVals[c];
    const out = { col: c, head: header ? text(heads[c]) : '', why: {}, scores: {} };
    const add = (field, score, why) => {
      if (!(score > 0)) return;
      if ((out.scores[field] || 0) < score) { out.scores[field] = score; out.why[field] = why; }
    };

    // 1. shape
    const sh = shapeScores(vals, { dates: dateShapes[c] });
    Object.entries(sh).forEach(([f, v]) => {
      if (f === '__date') return;
      add(f, 0.75 + v * 0.2, `the values look like ${PLAIN[f] || f.replace(/_/g, ' ')}`);
    });
    if (dateShapes[c].is) {
      const order = climbs(vals);
      add('__date', 0.8 + dateShapes[c].read * 0.12 + order * 0.06,
          order >= 0.9 ? 'the values read as dates, and they run forward the way a day book does'
                       : 'the values read as dates');
    }

    // 2. the law — a column of legal tax rates
    const rs = rateScore(vals, dateCol == null ? null : sample.map((r) => r[dateCol]));
    if (rs >= 0.9 && numeric(vals) > 0.8) {
      const f = filled(vals).map(money).filter((n) => n !== null);
      const small = f.length && f.every((n) => n >= 0 && n <= 100);
      if (small) add('gst_rate', 0.7 + rs * 0.2, 'every value is a tax rate that was legal on that date');
    }

    // 3. his own books — the strongest thing we have
    Object.entries(known).forEach(([field, list]) => {
      if (!list || !list.size) return;
      const hit = share(vals, (v) => list.has(text(v).toLowerCase()));
      if (hit >= 0.5) add(field, 0.8 + hit * 0.19, `${Math.round(hit * 100)}% of them are ${field === 'item_name' ? 'items' : 'names'} already in your books`);
    });

    // 4. the heading, last and lightest
    // 4. the heading, last and lightest — but not worthless. On a sheet of
    //    masters there is no arithmetic to be had, and a column headed
    //    "Purchase Rate" is a purchase rate. It still loses to anything the
    //    values themselves prove.
    if (header) {
      const f = NAME_OF.get(tidyHead(heads[c]));
      if (f) add(f, 0.72, `the heading says "${text(heads[c])}"`);
    }
    return out;
  });

  // ---- what the arithmetic settled ----
  const say = (col, field, score, why) => {
    const e = evidence[col];
    if (!e) return;
    if ((e.scores[field] || 0) < score) { e.scores[field] = score; e.why[field] = why; }
  };

  link.products.forEach(({ a, b, c }) => {
    // one of the two is the quantity: the one whose values are smaller and
    // rounder, and which is not itself a legal-looking tax rate column
    const avg = (i) => {
      const f = filled(colVals[i]).map(money).filter((n) => n !== null);
      return f.length ? f.reduce((x, y) => x + Math.abs(y), 0) / f.length : 0;
    };
    const qtyCol = avg(a) <= avg(b) ? a : b;
    const rateCol = qtyCol === a ? b : a;
    say(qtyCol, 'qty', 0.97, 'this column times another gives the amount, and it holds the smaller figures');
    say(rateCol, 'rate', 0.97, 'quantity times this column gives the amount');
    say(c, 'amount', 0.97, 'it is the quantity times the rate, row after row');
  });
  link.twins.forEach(({ a, b }) => {
    say(a, 'cgst', 0.95, 'this column and the next carry the same figure on every row, the way CGST and SGST do');
    say(b, 'sgst', 0.95, 'this column and the one before carry the same figure on every row, the way CGST and SGST do');
  });
  // ONLY WHERE THERE IS TAX TO FIND.
  //
  // "One column is a legal percentage of another" is a weak thing to say on its
  // own, because in a list of items the purchase price is some percentage of
  // the selling price and 18% is a perfectly ordinary margin. It read a shop's
  // cost price as IGST. So the tax arithmetic is only listened to once the file
  // has shown tax some other way — a CGST/SGST pair that match row for row, or
  // a heading that names one. A sheet of masters has neither, and is left alone.
  const taxIsHere = link.twins.length > 0 || evidence.some((e) =>
    ['cgst', 'sgst', 'igst', 'taxable', 'total'].some((f) => e.scores[f] >= 0.6));
  if (taxIsHere) {
    link.taxes.forEach(({ base, tax }) => {
      say(base, 'taxable', 0.9, 'a legal rate of tax applied to this column gives another one');
      if (!(evidence[tax].scores.cgst || evidence[tax].scores.sgst)) {
        say(tax, 'igst', 0.72, 'it is a legal percentage of the taxable value');
      }
    });
  }
  if (dateCol != null) say(dateCol, '__date', 0.95, 'the values read as dates');

  // ---- and what the words said ----
  // Columns the figures have already claimed are left alone; the rest are read
  // by how they repeat down the file.
  const spoken = new Set();
  evidence.forEach((e) => {
    const top = Object.entries(e.scores).sort((a, b) => b[1] - a[1])[0];
    if (top && top[1] >= 0.9) spoken.add(e.col);
  });
  const words = textRoles(sample, cols, colVals, spoken);
  Object.entries(words).forEach(([c, w]) => say(Number(c), w.field, w.score, w.why));

  // ---- one field to one column, best evidence first ----
  const picks = [];
  evidence.forEach((e) => Object.entries(e.scores).forEach(([field, score]) =>
    picks.push({ col: e.col, field, score })));
  picks.sort((a, b) => b.score - a.score);

  const byCol = new Map(), byField = new Map();
  picks.forEach((p) => {
    if (byCol.has(p.col) || byField.has(p.field)) return;
    byCol.set(p.col, p); byField.set(p.field, p);
  });

  const columns = cols.map((c) => {
    const p = byCol.get(c);
    const e = evidence[c];
    if (!p) {
      return { col: c, head: e.head, field: null, sure: DOUBTFUL,
               why: filled(colVals[c]).length ? 'nothing in it was recognised' : 'it is empty' };
    }
    return {
      col: c, head: e.head, field: p.field, score: p.score,
      sure: p.score >= 0.9 ? CERTAIN : p.score >= 0.7 ? PROBABLE : DOUBTFUL,
      why: e.why[p.field] || '',
    };
  });

  return { header, columns, rows: body, dateCol, links: link };
}

// What the columns add up to: which of Skwik's tables this file is.
export function kindOf(columns) {
  const has = (f) => columns.some((c) => c.field === f && c.sure !== DOUBTFUL);
  const any = (...f) => f.some(has);
  if (any('qty', 'rate', 'amount') && any('__date', 'voucher_no'))       return 'lines';
  if (any('opening_stock', 'purchase_price', 'mrp') || (has('hsn') && has('unit'))) return 'items';
  if (any('gstin', 'opening_balance') || (has('phone') && has('name')))  return 'parties';
  if (has('__date') && has('amount') && !has('qty'))                     return 'payments';
  if (any('hsn', 'unit'))                                               return 'items';
  return null;
}
