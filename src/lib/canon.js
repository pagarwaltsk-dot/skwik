// ONE SHAPE, WHATEVER THE FILE WAS.
//
// A shop's books can arrive from Tally, from Busy, from Marg, from Vyapar, or
// from a spreadsheet his nephew keeps. Writing a separate importer for each of
// those means writing the DANGEROUS half — the part that moves stock, settles
// ledgers, works out tax and hands out bill numbers — five times over, and
// getting it wrong in five different ways.
//
// So nothing writes into Skwik directly any more. Every reader turns what it
// found into the rows below, and ONE writer takes those rows in. Adding a new
// software then costs a mapping, not an importer, and it cannot damage anybody's
// books because it never touches them.
//
// Nobody ever sees this. There is no sheet to fill in and no columns to line
// up: it is the shape the app thinks in, on the way from his file to his books.
//
// WHAT EARNS A FIELD ITS PLACE. Either Skwik can DO something with it, or it is
// needed to check the import is right. Everything else a file carries is kept
// in `extra` so nothing is silently thrown away, without pretending we
// understood it.

import { STATES } from './states';
import { isUqc } from './uqc';

/* ====================== the rows ======================

   Each table lists its fields and which of them must be there for a row to be
   worth keeping. `ref` fields are the file's own identifiers — a bill number,
   an item name — and are matched up by the loader; nothing here carries a
   Skwik id, because at this stage the row may be for something that does not
   exist in his books yet.                                                   */

export const TABLES = {
  items: {
    need: ['name'],
    fields: ['name', 'alias', 'hsn', 'unit', 'gst_rate', 'cess_rate', 'supply',
             'sale_price', 'price2', 'purchase_price', 'mrp',
             'opening_stock', 'opening_value', 'barcode', 'group', 'priority'],
  },
  parties: {
    need: ['name'],
    fields: ['name', 'kind', 'gstin', 'is_registered', 'address', 'area',
             'state_name', 'state_code', 'pincode', 'phone', 'email',
             'opening_balance', 'opening_type', 'opening_date',
             'credit_days', 'credit_limit', 'price_list', 'group'],
  },
  // the head of a bill: one row per document
  vouchers: {
    need: ['vtype', 'vdate'],
    fields: ['ref', 'vtype', 'vdate', 'voucher_no', 'party_ref', 'party_name',
             'is_cash', 'place_of_supply_code', 'tax_mode', 'reverse_charge',
             'discount', 'freight', 'packing', 'insurance', 'other_charge',
             'round_off', 'taxable', 'cgst', 'sgst', 'igst', 'cess', 'total',
             'supplier_invoice_no', 'supplier_invoice_date',
             'godown', 'narration', 'irn', 'eway_no', 'source_key'],
  },
  // the body of a bill: one row per line
  lines: {
    need: ['voucher_ref'],
    fields: ['voucher_ref', 'line_no', 'item_ref', 'item_name', 'description',
             'hsn', 'unit', 'qty', 'free_qty', 'rate', 'per',
             'disc_pct', 'disc_amount', 'gst_rate', 'cess_rate',
             'taxable', 'cgst', 'sgst', 'igst', 'cess', 'amount',
             'batch', 'expiry', 'mfg_date', 'serial', 'godown'],
  },
  payments: {
    need: ['pdate', 'amount'],
    fields: ['ref', 'ptype', 'pdate', 'party_ref', 'party_name', 'amount',
             'mode', 'bank_ref', 'instrument_no', 'instrument_date',
             'against_ref', 'narration', 'source_key'],
  },
  expenses: {
    need: ['edate', 'amount'],
    fields: ['ref', 'edate', 'head', 'amount', 'gst_rate', 'gst_amount',
             'party_name', 'mode', 'bank_ref', 'is_gst_payment', 'narration',
             'source_key'],
  },
  banks: {
    need: ['name'],
    fields: ['name', 'kind', 'account_no', 'ifsc', 'branch',
             'opening_balance', 'opening_date', 'is_default'],
  },
  godowns: {
    need: ['name'],
    fields: ['name', 'is_main', 'address'],
  },
  // stock that moved for a reason that is not a bill: opening, a transfer
  // between his own stores, damage, goods taken for the house
  moves: {
    need: ['mdate', 'item_ref'],
    fields: ['ref', 'mdate', 'item_ref', 'item_name', 'reason',
             'qty_in', 'qty_out', 'rate', 'godown', 'to_godown',
             'batch', 'expiry', 'narration', 'source_key'],
  },
};

export const TABLE_NAMES = Object.keys(TABLES);

// An empty set of the rows, so every caller starts from the same thing.
export const emptyBook = () => {
  const b = {};
  TABLE_NAMES.forEach((t) => { b[t] = []; });
  return b;
};

/* ====================== what a rate may legally be ======================

   HE MADE THIS POINT AND IT IS A GOOD ONE. The rates that exist are not a
   fixed list — they are a list ON A DATE. 12% is perfectly ordinary on a bill
   from 2023 and worth a second look on one from 2026, and a reader that judges
   both against the same list either rejects his real history or lets rubbish
   through.

   KEPT AS DATA, ON PURPOSE. The exact day a slab changed is the sort of thing
   a person should be able to correct in one line without reading any logic. If
   a date here is a little out, the only consequence is that a rate is called
   "unusual" when it is ordinary, or the reverse — it is used to weigh evidence
   and to warn, and NEVER to throw away a figure that is on his own bill.       */

export const SLAB_ERAS = [
  {
    from: '2017-07-01', to: '2025-09-21',
    // the five ordinary slabs, plus the special ones: merchant exports at
    // 0.1, rough diamonds at 0.25, gold at 3, cut diamonds at 1.5, and the
    // works-contract rates
    rates: [0, 0.1, 0.25, 1, 1.5, 3, 5, 6, 7.5, 12, 18, 28],
  },
  {
    // GST 2.0: the middle slabs were folded away and a high rate added for
    // demerit goods. Correct this date here if it is wrong; nothing else
    // needs touching.
    from: '2025-09-22', to: null,
    rates: [0, 0.1, 0.25, 1, 1.5, 3, 5, 18, 40],
  },
];

// Every rate that has ever been legal, for when a row carries no date.
export const ANY_SLAB = [...new Set(SLAB_ERAS.flatMap((e) => e.rates))].sort((a, b) => a - b);

export function slabsOn(date) {
  const d = String(date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return ANY_SLAB;
  const era = SLAB_ERAS.find((e) => d >= e.from && (!e.to || d <= e.to));
  return era ? era.rates : ANY_SLAB;
}

// Is this a rate a bill of that date could carry? Half a rate is a real thing
// — 2.5 and 9 are the CGST halves of 5 and 18 — so those count too, because a
// column of CGST percentages is a column of rates.
export const isSlab = (rate, date) => {
  const r = Number(rate);
  if (!Number.isFinite(r) || r < 0 || r > 100) return false;
  const ok = slabsOn(date);
  return ok.some((s) => Math.abs(s - r) < 0.001)
      || ok.some((s) => Math.abs(s / 2 - r) < 0.001);
};

/* ====================== shapes worth knowing ====================== */

const DIGITS = (v) => String(v ?? '').replace(/[^0-9]/g, '');

// 4, 6 or 8 digits, and the first two are a real chapter of the tariff.
//
// THE DIGITS HAVE TO BE ALL THERE IS. Throwing away everything that is not a
// digit and looking at what is left turns 01/04/2026 into 01042026 — eight
// digits beginning with chapter 01, a perfectly good HSN — and a whole column
// of dates then out-argues the real HSN column for the name. So punctuation is
// not stripped: a tariff code is digits, spaces and nothing else. The leading
// apostrophe Excel puts in front of a number it is keeping as text is allowed,
// because that is Excel talking and not the shop.
export const looksHsn = (v) => {
  const s = String(v ?? '').trim().replace(/^'/, '').replace(/\s+/g, '');
  if (!/^\d+$/.test(s)) return false;
  if (![4, 6, 8].includes(s.length)) return false;
  const chapter = Number(s.slice(0, 2));
  return chapter >= 1 && chapter <= 99;
};

const GST_CODES = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

// THE CHECK DIGIT AT THE END OF A GST NUMBER.
//
// Fifteen characters in the right pattern is a fair guess; fifteen characters
// whose last one is the checksum of the other fourteen is a certainty, because
// nothing else in a spreadsheet does that by accident.
//
// Used ONLY to say yes. A number that fails is not thrown away and not called
// wrong — plenty of real GST numbers are typed into a customer's own sheet with
// a letter missing, and it is not this code's business to argue with him about
// it. Failing simply means this column has not proved itself here.
export function gstinChecks(v) {
  const s = String(v || '').trim().toUpperCase();
  if (!/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z][Z][0-9A-Z]$/.test(s)) return false;
  if (!STATES[s.slice(0, 2)]) return false;
  let factor = 2, sum = 0;
  for (let i = 13; i >= 0; i--) {
    const point = GST_CODES.indexOf(s[i]);
    if (point < 0) return false;
    let digit = factor * point;
    factor = factor === 2 ? 1 : 2;
    digit = Math.floor(digit / 36) + (digit % 36);
    sum += digit;
  }
  return GST_CODES[(36 - (sum % 36)) % 36] === s[14];
}

// The looser test: the right pattern and a real state, checksum or not.
export const looksGstin = (v) =>
  /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$/.test(String(v || '').trim().toUpperCase())
  && !!STATES[String(v).trim().slice(0, 2)];

// EAN-8, UPC-A, EAN-13 and ITF-14 all carry a check digit worked out the same
// way. Same rule as the GST number: proof when it passes, silence when it does
// not — a shop's own part numbers are barcodes too and owe nobody a checksum.
export function barcodeChecks(v) {
  const d = DIGITS(v);
  if (![8, 12, 13, 14].includes(d.length)) return false;
  let sum = 0;
  for (let i = 0; i < d.length - 1; i++) {
    // the weights run 3,1,3,1… backwards from the digit before the check digit
    const weight = ((d.length - 2 - i) % 2 === 0) ? 3 : 1;
    sum += Number(d[i]) * weight;
  }
  return ((10 - (sum % 10)) % 10) === Number(d[d.length - 1]);
}

const plainDigits = (v) => {
  const s = String(v ?? '').trim().replace(/^'/, '').replace(/[\s-]/g, '');
  return /^\d+$/.test(s) ? s : '';
};
export const looksBarcode = (v) => [8, 12, 13, 14].includes(plainDigits(v).length);
export const looksPhone   = (v) => /^[6-9][0-9]{9}$/.test(DIGITS(v).slice(-10))
                                   && DIGITS(v).length >= 10 && DIGITS(v).length <= 13;
export const looksPincode = (v) => /^[1-9][0-9]{5}$/.test(plainDigits(v));
export const looksEmail   = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(v || '').trim());
export const looksUnit    = (v) => isUqc(v) || UNIT_WORDS.has(String(v || '').trim().toLowerCase());

const UNIT_WORDS = new Set(['pc', 'pcs', 'piece', 'pieces', 'no', 'nos', 'nos.', 'each', 'ea',
  'box', 'boxes', 'ctn', 'carton', 'case', 'bag', 'bags', 'bdl', 'bundle', 'bundles',
  'pkt', 'packet', 'pack', 'dz', 'doz', 'dozen', 'kg', 'kgs', 'gm', 'gms', 'gram', 'grams',
  'ltr', 'lt', 'litre', 'liter', 'ml', 'mtr', 'meter', 'metre', 'ft', 'feet', 'inch',
  'set', 'sets', 'pair', 'pairs', 'jodi', 'gattha', 'peti', 'qtl', 'quintal', 'ton', 'tonne',
  'sqft', 'sqm', 'roll', 'rolls', 'unit', 'units', 'bottle', 'tin', 'drum', 'coil']);

export const looksState = (v) => {
  const s = String(v || '').trim().toLowerCase();
  if (!s) return false;
  return Object.values(STATES).some((n) => n.toLowerCase() === s);
};

/* ====================== dates, written any way at all ======================

   Between Tally, an Excel export and a man typing into a sheet, a date arrives
   as 01-04-2026, 2026-04-01, 01/04/26, 20260401, 1 Apr 2026, or as the number
   46114 because Excel keeps dates as days since 1900. All of them are read; the
   answer is always yyyy-mm-dd or nothing.

   DAY FIRST, NOT MONTH FIRST. 03/04/2026 is the third of April in every shop in
   India and the fourth of March in a library in California. Where a column
   proves otherwise — some value in it has a first part above twelve — the whole
   column is read the other way round, which is decided in the classifier where
   the whole column can be seen at once.                                      */

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8,
                 sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };

const pad = (n) => String(n).padStart(2, '0');
const made = (y, m, d) => {
  if (!(y >= 1990 && y <= 2100) || !(m >= 1 && m <= 12) || !(d >= 1 && d <= 31)) return '';
  const t = new Date(Date.UTC(y, m - 1, d));
  if (t.getUTCMonth() + 1 !== m || t.getUTCDate() !== d) return '';   // 31 February
  return `${y}-${pad(m)}-${pad(d)}`;
};

export function readDate(v, { monthFirst = false } = {}) {
  if (v == null || v === '') return '';
  const s = String(v).trim();

  // Excel keeps a date as the number of days since the 1st of January 1900,
  // with a famous off-by-one for a leap year that never happened.
  if (/^\d{5}(\.\d+)?$/.test(s)) {
    const n = Math.floor(Number(s));
    if (n > 25000 && n < 80000) {
      const t = new Date(Date.UTC(1899, 11, 30) + n * 86400000);
      return made(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
    }
  }
  let m;
  if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/)))
    return made(+m[1], +m[2], +m[3]);
  if ((m = s.match(/^(\d{4})(\d{2})(\d{2})$/))) {          // Tally writes 20260401
    const got = made(+m[1], +m[2], +m[3]);
    if (got) return got;
  }
  // A DATE TYPED WITH NOTHING BETWEEN ITS PARTS.
  //
  // He writes 1092026 and 01092026 for the first and the ninth of September,
  // and a sheet full of those is a sheet of dates however much it looks like a
  // column of eight-digit tariff codes. Tried AFTER the year-first shape above,
  // so 20260901 is still read as Tally means it: the year-first reading only
  // succeeds when the first four digits are a real year, and 0109 is not.
  if ((m = s.match(/^(\d{1,2})(\d{2})(\d{4})$/))) {
    const got = made(+m[3], +m[2], +m[1]);
    if (got) return got;
  }
  if ((m = s.match(/^(\d{1,2})[-/. ](\d{1,2})[-/. ](\d{2}|\d{4})$/))) {
    const y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
    const a = +m[1], b = +m[2];
    if (monthFirst) return made(y, a, b) || made(y, b, a);
    return made(y, b, a) || made(y, a, b);
  }
  if ((m = s.match(/^(\d{1,2})[-/. ]?([A-Za-z]{3,9})[-/. ]?(\d{2}|\d{4})$/))) {
    const mon = MONTHS[m[2].slice(0, 4).toLowerCase()] || MONTHS[m[2].slice(0, 3).toLowerCase()];
    const y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
    return mon ? made(y, mon, +m[1]) : '';
  }
  if ((m = s.match(/^([A-Za-z]{3,9})[-/. ]?(\d{1,2})[,]?[-/. ]?(\d{2}|\d{4})$/))) {
    const mon = MONTHS[m[1].slice(0, 4).toLowerCase()] || MONTHS[m[1].slice(0, 3).toLowerCase()];
    const y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
    return mon ? made(y, mon, +m[2]) : '';
  }
  return '';
}

// A DAY BOOK RUNS FORWARD.
//
// His point, and a good one: a column of dates goes 1 September, 2 September,
// 3 September — it is a register, written in the order things happened. A
// column of tariff codes has no order at all; it wanders wherever the goods
// wander. So a set of numbers that only ever climbs is a date and not a code,
// and this is what says so.
//
// Not required — a sheet sorted by customer is still a sheet of dates — so it
// adds to the case rather than deciding it.
export function climbs(values) {
  const list = values.map((v) => readDate(v)).filter(Boolean);
  if (list.length < 4) return 0;
  let up = 0;
  for (let i = 1; i < list.length; i++) if (list[i] >= list[i - 1]) up++;
  return up / (list.length - 1);
}

// Could this column be dates at all, and if so, is it written the other way
// round? Answered over the WHOLE column, because one value of 13/04 settles it
// for every other.
export function dateShape(values) {
  const list = values.filter((v) => v != null && String(v).trim() !== '');
  if (!list.length) return { is: false, monthFirst: false, read: 0 };
  let firstOver12 = 0, secondOver12 = 0;
  list.forEach((v) => {
    const m = String(v).trim().match(/^(\d{1,2})[-/. ](\d{1,2})[-/. ](\d{2}|\d{4})$/);
    if (!m) return;
    if (+m[1] > 12) firstOver12++;
    if (+m[2] > 12) secondOver12++;
  });
  // A first part above twelve can only be a day; a second part above twelve can
  // only be a day the other way round. If both happen the column is a mess and
  // the Indian reading wins, because that is the country the shop is in.
  const monthFirst = secondOver12 > 0 && firstOver12 === 0;
  const read = list.filter((v) => readDate(v, { monthFirst })).length;
  return { is: read / list.length >= 0.8, monthFirst, read: read / list.length };
}

/* ====================== tidying a finished row ====================== */

// Keep only the fields the table knows, drop the empties, and put everything
// else in `extra` so a column nobody understood is still there to look at.
export function tidyRow(table, row) {
  const spec = TABLES[table];
  if (!spec) return null;
  const out = {}; const extra = {};
  Object.keys(row || {}).forEach((k) => {
    const v = row[k];
    if (v === undefined || v === null || v === '') return;
    // anything beginning __ is the importer talking to itself — which row of
    // which sheet this came from — and is not something the file carried
    if (k.startsWith('__')) return;
    if (spec.fields.includes(k)) out[k] = v; else extra[k] = v;
  });
  if (Object.keys(extra).length) out.extra = extra;
  const missing = spec.need.filter((k) => out[k] === undefined);
  return missing.length ? null : out;
}
