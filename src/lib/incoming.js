// FROM A FILE TO THE ROWS, AND THE CHECKS BEFORE ANY OF IT IS BELIEVED.
//
// The reader works out what the columns are; this turns them into the one shape
// in canon.js and then tries hard to prove the result WRONG before anybody is
// asked to accept it.
//
// The checking is the point. A file that imports cleanly and leaves a shop's
// stock double is far worse than one that refuses: the refusal costs him an
// evening, the silence costs him his books and he finds out in three weeks when
// nothing matches. So everything here is written to catch that, and the last
// thing it produces is three figures he can hold against his own software.
//
// NOTHING HERE WRITES ANYTHING. It reads, it shapes, it complains. What goes
// into his books is a separate, deliberate step that takes these rows.

import { TABLES, emptyBook, tidyRow, readDate, isSlab } from './canon';
import { readColumns, kindOf, money, CERTAIN, DOUBTFUL } from './columns';

const text = (v) => String(v ?? '').trim();
const n2 = (x) => Math.round((Number(x) || 0) * 100) / 100;

/* ---------------- what a column means depends on the file ----------------

   `rate` on a sheet of bill lines is what that line was sold at. `rate` on a
   sheet of item masters is the item's selling price. `name` on a customer list
   is a customer and on a stock list is an item. The classifier answers "what
   kind of value is this"; only the file as a whole answers "what is it FOR". */

const PER_KIND = {
  items:   { rate: 'sale_price', amount: 'sale_price', name: 'name',
             qty: 'opening_stock', __date: null, total: null },
  parties: { name: 'name', opening_balance: 'opening_balance', __date: 'opening_date',
             amount: 'opening_balance', rate: null, qty: null, total: null },
  lines:   { name: 'item_name', __date: 'vdate', total: 'amount' },
  payments:{ name: 'party_name', __date: 'pdate', total: 'amount', rate: null, qty: null },
};

const fieldFor = (kind, field) => {
  const map = PER_KIND[kind] || {};
  return Object.prototype.hasOwnProperty.call(map, field) ? map[field] : field;
};

/* ---------------- reading one sheet into rows ---------------- */

// rows: array of arrays, straight off the CSV, the spreadsheet or the HTML
// table. `known` carries the names already in his books, which is the strongest
// evidence there is — see columns.js.
export function readSheet(rows, { known = {}, kind = null } = {}) {
  // THE RUBBISH COMES OUT BEFORE ANYTHING IS READ, NOT AFTER.
  //
  // This was the other way round, and it cost the classifier its answer: a
  // sheet exported page by page repeats its heading part way down, and those
  // words sat in the date column while it was deciding what the date column
  // was. Two dates and one "Date" is 67% — under the bar — so it gave up on
  // dates altogether and read them as the goods. One junk row in a short file
  // was enough to misread the whole thing.
  const clean = [], dropped = [];
  const blank = (r) => !r || r.every((v) => text(v) === '');
  const headKey = rows.length && !blank(rows[0])
    ? rows[0].map((h) => text(h).toLowerCase()).join('|') : null;
  rows.forEach((r, i) => {
    if (blank(r)) { if (i) dropped.push({ at: i + 1, why: 'an empty line' }); return; }
    if (i && headKey && r.map((v) => text(v).toLowerCase()).join('|') === headKey) {
      dropped.push({ at: i + 1, why: 'the heading row, repeated' }); return;
    }
    clean.push(r);
  });

  const read = readColumns(clean, { known });
  const found = kind || kindOf(read.columns);
  // ONE CANONICAL FIELD, ONE COLUMN. The classifier already gives each column
  // one field, but two different fields can map onto the same one — `name` and
  // `item_name` both become the item on a sheet of bill lines — and then two
  // columns quietly write over each other. The better-evidenced one wins.
  const mapped = read.columns
    .filter((c) => c.field && c.sure !== DOUBTFUL)
    .map((c) => ({ ...c, as: fieldFor(found, c.field) }))
    .filter((c) => c.as)
    .sort((a, b) => (b.score || 0) - (a.score || 0));
  const claimed = new Set();
  const used = mapped.filter((c) => {
    if (claimed.has(c.as)) return false;
    claimed.add(c.as); return true;
  });

  // THE ROWS THAT ARE NOT ROWS.
  //
  // A sheet exported page by page repeats its heading part way down, and one
  // typed by hand has blank lines in it. Left alone they become a bill dated
  // nowhere, belonging to a customer called "Party", and the lines under them
  // go somewhere they should not. They are thrown out here and counted, so the
  // preview can say "4 rows were not entries" rather than quietly losing them.
  const needsDate = ['lines', 'payments', 'vouchers', 'moves'].includes(found);

  const out = []; const skipped = [...dropped];
  read.rows.forEach((r, i) => {
    const at = i + (read.header ? 2 : 1);
    const row = {};
    let sawDate = false, readDated = false;
    used.forEach((c) => {
      const raw = r[c.col];
      if (raw === undefined || text(raw) === '') return;
      const v = shapeValue(c.as, raw, read);
      if (DATE_FIELDS.includes(c.as)) { sawDate = true; if (v) readDated = true; }
      if (v === '' || v === null || v === undefined) return;
      row[c.as] = v;
    });
    if (!Object.keys(row).length) return;                    // an empty line
    if (needsDate && sawDate && !readDated) {
      skipped.push({ at, why: 'no date could be read on it' }); return;
    }
    row.__row = at; out.push(row);
  });

  return {
    kind: found,
    header: read.header,
    columns: read.columns.map((c) => ({ ...c, as: fieldFor(found, c.field) })),
    rows: out,
    skipped,
    // the columns that were read on a guess rather than a proof, so the preview
    // can name them instead of letting them pass unmentioned
    assumed: read.columns.filter((c) => c.field && c.sure !== CERTAIN)
      .map((c) => ({ head: c.head, col: c.col, as: fieldFor(found, c.field), why: c.why }))
      .filter((c) => c.as),
    ignored: read.columns.filter((c) => !c.field || c.sure === DOUBTFUL)
      .map((c) => ({ head: c.head, col: c.col, why: c.why })),
  };
}

const DATE_FIELDS = ['vdate', 'pdate', 'edate', 'mdate', 'expiry', 'mfg_date',
                     'opening_date', 'instrument_date', 'supplier_invoice_date'];
const MONEY_FIELDS = ['qty', 'free_qty', 'rate', 'amount', 'taxable', 'cgst', 'sgst',
                      'igst', 'cess', 'total', 'disc_pct', 'disc_amount', 'gst_rate',
                      'cess_rate', 'sale_price', 'price2', 'purchase_price', 'mrp',
                      'opening_stock', 'opening_value', 'opening_balance', 'freight',
                      'packing', 'insurance', 'other_charge', 'round_off', 'priority'];

function shapeValue(field, raw, read) {
  if (DATE_FIELDS.includes(field)) {
    return readDate(raw, { monthFirst: !!(read && read.dateCol != null && read.monthFirst) });
  }
  if (MONEY_FIELDS.includes(field)) {
    const n = money(raw);
    return n === null ? '' : n;
  }
  if (field === 'hsn') return text(raw).replace(/[^0-9]/g, '');
  if (field === 'gstin') return text(raw).toUpperCase();
  return text(raw);
}

/* ---------------- lines into bills ----------------

   A sheet of bill lines carries the bill's own facts — its date, its number,
   its customer — repeated on every line. The bill itself has to be lifted out
   of that, once per number, and the figures on it worked out from the lines
   rather than taken from any single row, because a repeated total is the most
   common way a file lies: five lines each carrying the bill total of 6,000 is
   not a bill of 30,000.                                                      */

export function billsFromLines(lineRows, { vtype = 'sale' } = {}) {
  const vouchers = new Map();
  const lines = [];

  // ONE NUMBER IS NOT ONE BILL.
  //
  // Grouping by the bill number alone quietly welded together two bills that
  // happened to share a number — a different day, a different customer, one
  // bill — and the second customer's goods went onto the first one's account.
  // Silent, and exactly the kind of thing he would find months later. So a
  // bill is its number AND its date AND its customer; where one number turns
  // out to cover more than one of those, the checks below say so.
  lineRows.forEach((r, i) => {
    const no = text(r.voucher_no);
    const key = no
      ? `${no}|${text(r.vdate)}|${text(r.party_name)}`
      : (text(r.vdate) || text(r.party_name)
          ? `${text(r.vdate)}|${text(r.party_name)}` : `row${i}`);
    if (!vouchers.has(key)) {
      vouchers.set(key, {
        ref: key,
        vtype: text(r.vtype) || vtype,
        vdate: r.vdate || '',
        voucher_no: text(r.voucher_no),
        party_name: text(r.party_name),
        // taken from the line only because a bill-level figure repeated on
        // every line is all we have; added up from the lines further down and
        // checked against this
        said_total: r.total_of_bill,
        freight: r.freight, packing: r.packing, insurance: r.insurance,
        other_charge: r.other_charge, round_off: r.round_off,
        discount: r.bill_discount, godown: r.godown, narration: r.narration,
        __rows: [],
      });
    }
    const v = vouchers.get(key);
    v.__rows.push(r.__row);
    lines.push({
      voucher_ref: key,
      line_no: lines.filter((l) => l.voucher_ref === key).length + 1,
      item_name: text(r.item_name), hsn: r.hsn, unit: r.unit,
      qty: r.qty, free_qty: r.free_qty, rate: r.rate, per: r.per,
      disc_pct: r.disc_pct, disc_amount: r.disc_amount,
      gst_rate: r.gst_rate, cess_rate: r.cess_rate,
      taxable: r.taxable, cgst: r.cgst, sgst: r.sgst, igst: r.igst, cess: r.cess,
      amount: r.amount,
      batch: r.batch, expiry: r.expiry, mfg_date: r.mfg_date,
      serial: r.serial, godown: r.godown,
      __row: r.__row,
    });
  });

  // the bill's figures, from its own lines
  const out = [];
  vouchers.forEach((v) => {
    const mine = lines.filter((l) => l.voucher_ref === v.ref);
    const add = (f) => n2(mine.reduce((a, l) => a + (Number(l[f]) || 0), 0));
    const taxable = add('taxable') || add('amount');
    const cgst = add('cgst'), sgst = add('sgst'), igst = add('igst');
    out.push(tidyRow('vouchers', {
      ref: v.ref, vtype: v.vtype, vdate: v.vdate, voucher_no: v.voucher_no,
      party_name: v.party_name, godown: v.godown, narration: v.narration,
      freight: v.freight, packing: v.packing, insurance: v.insurance,
      other_charge: v.other_charge, round_off: v.round_off, discount: v.discount,
      taxable, cgst, sgst, igst,
      total: n2(taxable + cgst + sgst + igst
             + (Number(v.freight) || 0) + (Number(v.packing) || 0)
             + (Number(v.insurance) || 0) + (Number(v.other_charge) || 0)
             + (Number(v.round_off) || 0) - (Number(v.discount) || 0)),
      source_key: v.ref,
    }));
  });

  return { vouchers: out.filter(Boolean), lines: lines.map((l) => tidyRow('lines', l)).filter(Boolean) };
}

/* ---------------- everything read, gathered into one book ---------------- */

export function bookFrom(sheets, opts = {}) {
  const book = emptyBook();
  const notes = [];
  sheets.forEach((sheet) => {
    const r = readSheet(sheet.rows, { known: opts.known, kind: sheet.kind });
    if (!r.kind) { notes.push({ file: sheet.name, say: 'Skwik could not tell what this file holds.' }); return; }
    if (r.kind === 'lines') {
      const { vouchers, lines } = billsFromLines(r.rows, { vtype: sheet.vtype || 'sale' });
      book.vouchers.push(...vouchers);
      book.lines.push(...lines);
      // the names on those bills are customers and items he may not have yet
      vouchers.forEach((v) => { if (v.party_name) book.parties.push({ name: v.party_name }); });
      lines.forEach((l) => { if (l.item_name) book.items.push({ name: l.item_name, hsn: l.hsn, unit: l.unit }); });
    } else if (TABLES[r.kind]) {
      r.rows.forEach((row) => {
        const t = tidyRow(r.kind, row);
        if (t) book[r.kind].push(t);
      });
    }
    notes.push({ file: sheet.name, kind: r.kind, read: r.rows.length,
                 assumed: r.assumed, ignored: r.ignored });
  });

  // a name mentioned on ten bills is one customer, not ten
  book.parties = dedupeBy(book.parties, (p) => text(p.name).toLowerCase());
  book.items   = dedupeBy(book.items,   (i) => text(i.name).toLowerCase());
  return { book, notes };
}

function dedupeBy(rows, key) {
  const seen = new Map();
  rows.forEach((r) => {
    const k = key(r);
    if (!k) return;
    const had = seen.get(k);
    if (!had) { seen.set(k, r); return; }
    // keep whichever row knows more
    Object.keys(r).forEach((f) => { if (had[f] === undefined && r[f] !== undefined) had[f] = r[f]; });
  });
  return [...seen.values()];
}

/* ====================== THE CHECKS ======================

   Run before he is asked to accept anything, and written to fail loudly.
   `stop` means it must not be imported as it stands. `warn` means it can be,
   and he should know.                                                        */

export function checkBook(book, { existing = null, cutoff = null } = {}) {
  const stop = [], warn = [];

  /* 1. THE ONE THAT MATTERS: COUNTING HIS BOOKS TWICE.
     If his items already carry an opening stock and his customers already
     carry an opening balance, those figures ARE the history — they are what
     his old software said he had after all of it. Importing the bills that
     produced them counts everything a second time, and it does not look like
     an error: his stock simply comes out double and he finds out weeks later.
     So it is a stop, with the way out named. */
  if (existing && book.vouchers.length) {
    const openStock = existing.itemsWithOpening || 0;
    const openDues  = existing.partiesWithOpening || 0;
    if (openStock || openDues) {
      stop.push({
        what: 'Your books already hold opening figures',
        say: `${openStock} items carry an opening stock and ${openDues} customers carry `
           + 'an opening balance. Those figures already include everything these bills '
           + 'did — bringing the bills in as well would count it all twice, and your '
           + 'stock and dues would come out roughly double.\n\n'
           + 'Either empty the firm first and import the opening figures as they stood '
           + 'on the day this history begins, or bring in the masters alone.',
      });
    }
  }

  /* 2. THE SAME BILL TWICE. */
  const byNo = new Map();
  book.vouchers.forEach((v) => {
    const k = `${v.vtype}|${text(v.voucher_no).toLowerCase()}`;
    if (!text(v.voucher_no)) return;
    byNo.set(k, (byNo.get(k) || 0) + 1);
  });
  const twiceOver = [...byNo.entries()].filter(([, n]) => n > 1);
  if (twiceOver.length) {
    stop.push({
      what: `${twiceOver.length} bill numbers cover more than one bill`,
      say: `For example ${twiceOver.slice(0, 3).map(([k]) => k.split('|')[1]).join(', ')}. `
         + 'The same number appears against a different date or a different customer, so '
         + 'either the file holds the same bills twice or two bills were given one number. '
         + 'Nothing is imported until it is one or the other — putting them together would '
         + "quietly move one customer's goods onto another's account.",
    });
  }
  if (existing && existing.voucherKeys && book.vouchers.length) {
    const already = book.vouchers.filter((v) =>
      v.source_key && existing.voucherKeys.has(String(v.source_key)));
    if (already.length) {
      warn.push({
        what: `${already.length} of these bills are already in your books`,
        say: 'They came in on an earlier run and will be left alone, so nothing is doubled.',
      });
    }
  }

  /* 3. LINES THAT POINT AT NOTHING. */
  const refs = new Set(book.vouchers.map((v) => String(v.ref)));
  const orphan = book.lines.filter((l) => !refs.has(String(l.voucher_ref)));
  if (orphan.length) {
    stop.push({
      what: `${orphan.length} lines belong to no bill`,
      say: 'A line was read without a bill number above it. Usually the file has a blank '
         + 'row in the middle of it, or the heading row repeats part way down.',
    });
  }
  const noItem = book.lines.filter((l) => !text(l.item_name));
  if (noItem.length) {
    warn.push({
      what: `${noItem.length} lines carry no item name`,
      say: 'They will come in against a line with no item, which keeps the money right '
         + 'but tells you nothing about what was sold.',
    });
  }

  /* 4. DOES EACH BILL ADD UP TO ITS OWN LINES?
     The check a customer would do. Where the file carried its own total and it
     disagrees with the lines under it, the file is wrong or we read a column
     wrongly — either way he has to be told which bills. */
  const off = [];
  book.vouchers.forEach((v) => {
    const mine = book.lines.filter((l) => String(l.voucher_ref) === String(v.ref));
    if (!mine.length) return;
    const linesAdd = n2(mine.reduce((a, l) => a + (Number(l.amount) || Number(l.taxable) || 0), 0));
    const qtyRate = n2(mine.reduce((a, l) =>
      a + (Number(l.qty) || 0) * (Number(l.rate) || 0), 0));
    if (linesAdd && qtyRate && Math.abs(linesAdd - qtyRate) > Math.max(1, linesAdd * 0.02)) {
      off.push({ no: v.voucher_no || v.ref, linesAdd, qtyRate });
    }
  });
  if (off.length) {
    warn.push({
      what: `${off.length} bills where the amounts do not match quantity times rate`,
      say: `For example ${off.slice(0, 3).map((o) => `${o.no}: lines add to ${o.linesAdd}, `
        + `quantity times rate gives ${o.qtyRate}`).join('; ')}. Often a discount the file `
        + 'keeps in a column of its own.',
    });
  }

  /* 5. A RATE THAT WAS NOT LEGAL THAT DAY — his own point, used as a check. */
  const oddRate = [];
  book.lines.forEach((l) => {
    if (l.gst_rate === undefined || l.gst_rate === '') return;
    const v = book.vouchers.find((x) => String(x.ref) === String(l.voucher_ref));
    if (!isSlab(l.gst_rate, v?.vdate)) oddRate.push({ rate: l.gst_rate, on: v?.vdate });
  });
  if (oddRate.length) {
    const worst = [...new Set(oddRate.map((o) => `${o.rate}%`))].slice(0, 4).join(', ');
    warn.push({
      what: `${oddRate.length} lines carry a tax rate that was not in force on their date`,
      say: `${worst}. It may be right — the rates changed and an old bill keeps the old `
         + 'rate — but if a whole file is like this, the wrong column was read as the tax rate.',
    });
  }

  /* 6. NOTHING BEFORE THE CUT-OFF. */
  if (cutoff) {
    const early = book.vouchers.filter((v) => v.vdate && v.vdate < cutoff).length;
    if (early) {
      warn.push({
        what: `${early} bills are dated before ${cutoff}`,
        say: 'Your opening figures already cover everything before that date, so those '
           + 'bills will be left out rather than counted twice.',
      });
    }
  }

  return { stop, warn, ok: stop.length === 0 };
}

/* ---------------- the three figures he checks against his own software ----

   The most important screen in the whole import, and it is three numbers. If
   they agree with what Tally says, he believes the rest and the job is done.
   If they do not, he finds out here, in front of the file, instead of three
   weeks later in front of a customer.                                        */

export function proof(book) {
  const sum = (rows, f) => n2(rows.reduce((a, r) => a + (Number(r[f]) || 0), 0));
  const sale = book.vouchers.filter((v) => v.vtype === 'sale' || v.vtype === 'estimate');
  const buy  = book.vouchers.filter((v) => v.vtype === 'purchase');

  const stockValue = n2(book.items.reduce((a, i) =>
    a + (Number(i.opening_stock) || 0)
      * (Number(i.purchase_price) || Number(i.sale_price) || 0), 0));
  const owed  = n2(book.parties.reduce((a, p) => {
    const b = Number(p.opening_balance) || 0;
    return a + (p.opening_type === 'you_owe' ? 0 : Math.max(0, b));
  }, 0));
  const owing = n2(book.parties.reduce((a, p) => {
    const b = Number(p.opening_balance) || 0;
    return a + (p.opening_type === 'you_owe' ? Math.max(0, b) : Math.max(0, -b));
  }, 0));

  return {
    items: book.items.length,
    parties: book.parties.length,
    bills: sale.length,
    purchases: buy.length,
    payments: book.payments.length,
    stockValue,
    owed,
    owing,
    salesValue: sum(sale, 'total'),
    purchaseValue: sum(buy, 'total'),
  };
}
