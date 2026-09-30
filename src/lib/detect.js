// ===========================================================================
//  THE EXTRACTING MACHINE.
//
//  His design, and it is the right one: an importer should not be written
//  against Tally, or against Busy, or against anybody's spreadsheet. It
//  should read a file it has never seen, work out for itself what each column
//  is, and hand the answer to whatever wants it.
//
//  HOW IT DECIDES, AND WHY IT IS NOT GUESSWORK.
//
//  A column's name is the cheapest signal in the file and it is usually
//  right, so it is asked first. But headers lie: "Amount", "Value", "Total"
//  and "Rate" each mean three different things depending on who exported the
//  file, and a shop may write them in Hindi, or abbreviate them, or stack two
//  header rows, or put the company name and a date range above them.
//
//  So the header earns CANDIDATES, not answers. What settles it is the
//  arithmetic, because an accounting file is full of sums that have to hold:
//
//      qty x rate            = amount
//      taxable + tax         = total
//      (cgst + sgst) / taxable  lands on a real GST rate
//      cgst                  = sgst
//
//  A row where all of those close has not SUGGESTED which column is which.
//  It has proved it. And in a file of a thousand rows there are hundreds of
//  such rows, so the mapping is not taken from one of them -- it is taken
//  from the one that hundreds of them agree on.
//
//  Two things that bite anyone who tries this:
//
//    A SINGLE ROW PROVES NOTHING. A quantity of 1 makes qty x rate = amount
//    true for almost any pair of columns in the file. Agreement across many
//    rows is the whole of the evidence.
//
//    SUBTOTAL ROWS LOOK PERFECT AND ARE NOT. They are complete, they are
//    numeric, and they break every relation in a way that reads as a mapping
//    error. They are thrown out before anything is counted.
//
//  Nothing here writes anything anywhere. It reads a file and says what it
//  thinks, with a figure for how sure it is and the reason it is sure.
// ===========================================================================

/* ---------------- the small tools ---------------- */

const s = (x) => String(x == null ? '' : x).trim();
const low = (x) => s(x).toLowerCase();
const clean = (x) => low(x).replace(/[^a-z0-9%]+/g, ' ').trim();

// a figure, however the file writes it: 1,234.56  (1234.56)  1234.56 Dr  -1234
export function toNum(x) {
  let t = s(x);
  if (!t) return null;
  let sign = 1;
  if (/^\(.*\)$/.test(t)) { sign = -1; t = t.slice(1, -1); }
  if (/\bcr\b/i.test(t)) sign = -sign;
  t = t.replace(/\b(dr|cr)\b/ig, '').replace(/[₹$,\s]/g, '');
  if (!/^-?\d*\.?\d+$/.test(t)) return null;
  const n = Number(t) * sign;
  return Number.isFinite(n) ? n : null;
}

// a date, in the four shapes that actually turn up
export function toDate(x) {
  const t = s(x);
  if (!t) return null;
  let m = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = t.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m && +m[2] >= 1 && +m[2] <= 12 && +m[3] >= 1 && +m[3] <= 31) {
    return `${m[1]}-${m[2]}-${m[3]}`;
  }
  m = t.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/);
  if (m) {
    const y = m[3].length === 2 ? `20${m[3]}` : m[3];
    const d = +m[1], mo = +m[2];
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
      return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }
  }
  // 1-Apr-2026
  m = t.match(/^(\d{1,2})[-\s]([A-Za-z]{3,})[-\s](\d{2,4})$/);
  if (m) {
    const MON = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
    const mo = MON.indexOf(m[2].slice(0, 3).toLowerCase()) + 1;
    if (mo) {
      const y = m[3].length === 2 ? `20${m[3]}` : m[3];
      return `${y}-${String(mo).padStart(2, '0')}-${String(+m[1]).padStart(2, '0')}`;
    }
  }
  return null;
}

export const GST_RATES = [0, 0.1, 0.25, 1, 1.5, 3, 5, 6, 12, 18, 28];
export const isGstRate = (r) => GST_RATES.some((x) => Math.abs(x - r) < 0.02);
const GSTIN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z][Z][0-9A-Z]$/;

/* ---------------- 1. THE READER: any file, to rows and columns ---------- */

export function sniff(text) {
  const head = s(text).slice(0, 400);
  if (/^\s*[[{]/.test(head)) return 'json';
  if (/^\s*<\?xml|^\s*<[A-Za-z]/.test(head)) return 'xml';
  const line = String(text).split(/\r?\n/).find((l) => l.trim());
  if (!line) return 'csv';
  const tabs = (line.match(/\t/g) || []).length;
  const commas = (line.match(/,/g) || []).length;
  const pipes = (line.match(/\|/g) || []).length;
  if (tabs >= commas && tabs >= pipes && tabs > 0) return 'tsv';
  if (pipes > commas && pipes > 0) return 'psv';
  return 'csv';
}

// a delimited file, quotes and all
export function splitRows(text, sep) {
  const rows = [];
  let row = [], cell = '', q = false;
  const t = String(text);
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) {
      if (c === '"' && t[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === sep) { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((x) => s(x)));
}

// A TREE HAS A HEADER TOO, AND A BETTER ONE.
//
// Tally writes XML, so there is no header row anywhere -- but the tag names
// are a header, and a stricter one than a spreadsheet's, because nobody
// abbreviates them by hand. The record is whichever tag repeats most often
// carrying leaves of its own; each occurrence is a row and its leaf tags are
// the columns.
export function xmlTable(text) {
  const t = String(text);
  const open = /<([A-Za-z_][\w.:-]*)\b[^>]*?(\/?)>/g;
  const counts = new Map();
  let m;
  while ((m = open.exec(t))) {
    if (m[2] === '/') continue;
    counts.set(m[1], (counts.get(m[1]) || 0) + 1);
  }
  // the record tag: repeats a lot, and is not the outermost wrapper
  let best = null, bestN = 0;
  for (const [tag, n] of counts) {
    if (n < 2) continue;
    const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
    const one = re.exec(t);
    if (!one) continue;
    const leaves = (one[1].match(/<([A-Za-z_][\w.:-]*)\b[^>]*>[^<]*<\/\1>/g) || []).length;
    if (leaves < 2) continue;
    const score = n * Math.min(leaves, 20);
    if (score > bestN) { bestN = score; best = tag; }
  }
  if (!best) return { header: [], body: [], record: '' };

  const blocks = [];
  const re = new RegExp(`<${best}\\b[^>]*>([\\s\\S]*?)<\\/${best}>`, 'gi');
  while ((m = re.exec(t))) blocks.push(m[1]);

  const cols = [];
  const seen = new Set();
  const rows = blocks.map((b) => {
    const got = {};
    const leaf = /<([A-Za-z_][\w.:-]*)\b[^>]*>([^<]*)<\/\1>/g;
    let l;
    while ((l = leaf.exec(b))) {
      const k = l[1];
      if (got[k] == null) got[k] = l[2];
      if (!seen.has(k)) { seen.add(k); cols.push(k); }
    }
    return got;
  });
  return { header: cols, body: rows.map((r) => cols.map((c) => s(r[c]))), record: best };
}

export function jsonTable(text) {
  let j;
  try { j = JSON.parse(text); } catch (e) { return { header: [], body: [] }; }
  const arr = Array.isArray(j) ? j
    : (Object.values(j).find((v) => Array.isArray(v) && v.length && typeof v[0] === 'object') || []);
  if (!arr.length) return { header: [], body: [] };
  const cols = [];
  const seen = new Set();
  for (const r of arr.slice(0, 200)) {
    for (const k of Object.keys(r || {})) if (!seen.has(k)) { seen.add(k); cols.push(k); }
  }
  return { header: cols, body: arr.map((r) => cols.map((c) => s(r && r[c]))) };
}

/* ---------------- 2. WHICH ROW IS THE HEADER ---------------- */

// A real export starts with junk: the company's name, the date range, a blank
// line or two. The header is the first row that is mostly short words, whose
// cells are all different, and under which the columns start typing
// consistently. Looked for in the first 25 rows and no further.
export function findHeader(rows) {
  const typed = (r) => r.filter((c) => s(c)).map((c) =>
    (toNum(c) != null ? 'n' : toDate(c) ? 'd' : 't')).join('');
  let best = -1, bestScore = -1;
  for (let i = 0; i < Math.min(rows.length, 25); i++) {
    const r = rows[i];
    const filled = r.filter((c) => s(c));
    if (filled.length < 2) continue;
    const words = filled.filter((c) => toNum(c) == null && !toDate(c) && s(c).length <= 40);
    const uniq = new Set(filled.map(low)).size;
    const below = rows.slice(i + 1, i + 8).map(typed);
    const steady = below.length > 1
      && below.filter((x) => x === below[0]).length / below.length;
    const score = (words.length / filled.length) * 2
                + (uniq / filled.length)
                + (steady || 0)
                + (filled.length / Math.max(1, r.length))
                - i * 0.02;
    if (score > bestScore) { bestScore = score; best = i; }
  }
  return best < 0 ? 0 : best;
}

/* ---------------- 3. WHAT THE HEADER SUGGESTS ---------------- */

// Every spelling that turns up in the wild, in one place. A hit here is a
// candidate and nothing more; the arithmetic below is what decides.
const WORDS = {
  bill_no:  ['invoice no', 'invoice number', 'inv no', 'bill no', 'bill number',
             'voucher no', 'vch no', 'voucher number', 'doc no', 'document no',
             'reference no', 'ref no', 'srl no', 'sr no', 'serial', 'number', 'bill',
             'invoice', 'voucher', 'vouchernumber', 'billno', 'invno'],
  date:     ['date', 'dt', 'dated', 'invoice date', 'bill date', 'voucher date',
             'transaction date', 'vch date', 'billdate', 'invoicedate'],
  due_date: ['due date', 'due', 'payment due', 'credit period', 'days', 'terms'],
  party:    ['party', 'party name', 'customer', 'customer name', 'supplier',
             'supplier name', 'vendor', 'buyer', 'ledger', 'ledger name', 'account',
             'account name', 'name', 'consignee', 'partyledgername', 'billed to'],
  gstin:    ['gstin', 'gst no', 'gst number', 'gstin uin', 'party gstin', 'tax id'],
  item:     ['item', 'item name', 'product', 'product name', 'particulars',
             'description', 'goods', 'stock item', 'material', 'stockitemname'],
  hsn:      ['hsn', 'sac', 'hsn sac', 'hsn code'],
  uom:      ['uom', 'unit', 'units', 'uqc', 'unit of measure', 'per'],
  qty:      ['qty', 'quantity', 'nos', 'pcs', 'billed qty', 'actual qty', 'billedqty'],
  rate:     ['rate', 'price', 'unit price', 'unit rate', 'mrp'],
  amount:   ['amount', 'value', 'gross', 'gross amount', 'line total', 'net amount'],
  discount: ['discount', 'disc', 'less', 'rebate'],
  taxable:  ['taxable', 'taxable value', 'taxable amount', 'assessable value', 'basic'],
  gst_rate: ['gst rate', 'tax rate', 'gst %', 'tax %', 'rate of tax', 'gst percent',
             'gstrate', 'igst rate', 'cgst rate'],
  cgst:     ['cgst', 'cgst amount', 'central tax', 'cgst amt'],
  sgst:     ['sgst', 'utgst', 'sgst amount', 'state tax', 'sgst amt'],
  igst:     ['igst', 'igst amount', 'integrated tax', 'igst amt'],
  cess:     ['cess', 'cess amount'],
  total:    ['total', 'invoice value', 'bill amount', 'grand total', 'net payable',
             'invoice total', 'bill total', 'total amount'],
  opening:  ['opening', 'opening balance', 'op bal', 'b f', 'brought forward',
             'opening stock', 'openingbalance'],
  closing:  ['closing', 'closing balance', 'cl bal', 'c f', 'carried forward',
             'closing stock', 'balance'],
  godown:   ['godown', 'warehouse', 'store', 'location', 'branch', 'godownname'],
  narration:['narration', 'remarks', 'note', 'notes', 'description of goods'],
  debit:    ['debit', 'dr', 'debit amount', 'dr amount'],
  credit:   ['credit', 'cr', 'credit amount', 'cr amount'],
};

// THE BEST MATCH, NOT THE FIRST. This stopped at the first word that fitted
// at all, so VOUCHERNUMBER matched "number" loosely and never reached
// "vouchernumber", which it is exactly -- and the answer came back as a guess
// when the file had spelled it out in full.
export function fromHeader(name) {
  const c = clean(name);
  if (!c) return [];
  const out = [];
  for (const [role, words] of Object.entries(WORDS)) {
    let best = 0;
    for (const w of words) {
      if (c === w) { best = 1; break; }
      if (c.includes(w) || w.includes(c)) best = Math.max(best, 0.6);
    }
    if (best) out.push([role, best]);
  }
  return out.sort((a, b) => b[1] - a[1]);
}

/* ---------------- 4. WHAT THE COLUMN ITSELF LOOKS LIKE ------------------ */

export function shapeOf(values) {
  const filled = values.filter((v) => s(v));
  const n = filled.length || 1;
  const nums = filled.map(toNum).filter((x) => x != null);
  const dates = filled.filter((v) => toDate(v));
  const uniq = new Set(filled.map(low)).size;
  return {
    filled: filled.length,
    numeric: nums.length / n,
    dated: dates.length / n,
    unique: uniq / n,
    gstin: filled.filter((v) => GSTIN.test(s(v).toUpperCase().replace(/\s/g, ''))).length / n,
    hsnish: filled.filter((v) => /^\d{4}(\d{2}(\d{2})?)?$/.test(s(v))).length / n,
    rateish: nums.length ? nums.filter((x) => isGstRate(x)).length / nums.length : 0,
    intish: nums.length ? nums.filter((x) => Number.isInteger(x)).length / nums.length : 0,
    negatives: nums.filter((x) => x < 0).length,
    avgLen: filled.reduce((t, v) => t + s(v).length, 0) / n,
    values: filled,
    nums,
  };
}

/* ---------------- 5. THE ROWS THAT CANNOT BE WRONG ---------------------- */

// A subtotal row is complete, numeric and a liar. It is recognised by having
// no text where the text belongs -- no bill number, no name, no item.
const looksLikeTotalRow = (row, textCols) =>
  textCols.length > 0 && textCols.every((i) => !s(row[i]));

const near = (a, b, tol) => Math.abs(a - b) <= Math.max(tol, Math.abs(b) * 0.005);

// Every pair (or triple) of columns that holds a relation across many rows.
// The COUNT is the evidence: one row proves nothing, a hundred prove it.
export function proofs(header, body, shapes) {
  // A DATE IS NOT A FIGURE. Tally writes 20260901, which parses as twenty
  // million and something, and it went into the arithmetic as happily as a
  // rupee amount -- so a date column came out as the taxable value, because
  // the tax on twenty million lands on a real GST rate often enough.
  const numCols = header.map((_, i) => i).filter((i) => shapes[i].numeric > 0.8
                                                     && shapes[i].dated < 0.5
                                                     && shapes[i].nums.length > 2);
  const textCols = header.map((_, i) => i).filter((i) => shapes[i].numeric < 0.2
                                                      && shapes[i].dated < 0.2
                                                      && shapes[i].filled > 0);
  const rows = body.filter((r) => !looksLikeTotalRow(r, textCols));
  const got = { product: [], sum: [], rate: [], halves: [] };

  const val = (r, i) => toNum(r[i]);

  // a x b = c
  for (const a of numCols) for (const b of numCols) {
    if (a === b) continue;
    for (const c of numCols) {
      if (c === a || c === b) continue;
      let hit = 0, seen = 0, trivial = 0;
      for (const r of rows) {
        const x = val(r, a), y = val(r, b), z = val(r, c);
        if (x == null || y == null || z == null) continue;
        if (!x || !y || !z) continue;
        seen++;
        if (Math.abs(x - 1) < 1e-9 || Math.abs(y - 1) < 1e-9) trivial++;
        if (near(x * y, z, 0.05)) hit++;
      }
      // A QUANTITY OF ONE MAKES ANY TWO COLUMNS MULTIPLY TO THE THIRD, so a
      // relation carried entirely by rows like that is thrown away.
      if (seen >= 5 && hit / seen > 0.9 && (seen - trivial) >= 3) {
        got.product.push({ a, b, c, hit, seen, strength: hit / seen });
      }
    }
  }

  // a + b (+ c ...) = z, for the small combinations that matter
  for (const z of numCols) {
    for (const a of numCols) {
      if (a === z) continue;
      for (const b of numCols) {
        if (b === z || b <= a) continue;
        let hit = 0, seen = 0;
        for (const r of rows) {
          const x = val(r, a), y = val(r, b), t = val(r, z);
          if (x == null || y == null || t == null || !t) continue;
          seen++;
          if (near(x + y, t, 0.05)) hit++;
        }
        if (seen >= 5 && hit / seen > 0.9) {
          got.sum.push({ parts: [a, b], z, hit, seen, strength: hit / seen });
        }
        // and the three-part one: base + two taxes
        for (const c of numCols) {
          if (c === z || c <= b) continue;
          let h3 = 0, s3 = 0;
          for (const r of rows) {
            const x = val(r, a), y = val(r, b), w = val(r, c), t = val(r, z);
            if (x == null || y == null || w == null || t == null || !t) continue;
            s3++;
            if (near(x + y + w, t, 0.05)) h3++;
          }
          if (s3 >= 5 && h3 / s3 > 0.9) {
            got.sum.push({ parts: [a, b, c], z, hit: h3, seen: s3, strength: h3 / s3 });
          }
        }
      }
    }
  }

  // (tax / base) x 100 lands on a real GST rate, every time
  for (const base of numCols) for (const tax of numCols) {
    if (base === tax) continue;
    let hit = 0, seen = 0;
    for (const r of rows) {
      const b = val(r, base), t = val(r, tax);
      if (b == null || t == null || !b || !t) continue;
      seen++;
      if (isGstRate((t / b) * 100)) hit++;
    }
    if (seen >= 5 && hit / seen > 0.9) {
      got.rate.push({ base, tax, hit, seen, strength: hit / seen });
    }
  }

  // cgst and sgst are always the same figure, and nothing else in a bill is
  for (const a of numCols) for (const b of numCols) {
    if (b <= a) continue;
    let hit = 0, seen = 0;
    for (const r of rows) {
      const x = val(r, a), y = val(r, b);
      if (x == null || y == null || !x || !y) continue;
      seen++;
      if (near(x, y, 0.02)) hit++;
    }
    if (seen >= 5 && hit / seen > 0.98) got.halves.push({ a, b, hit, seen });
  }

  return { ...got, textCols, numCols, clean: rows.length, dropped: body.length - rows.length };
}

/* ---------------- 6. PUTTING IT TOGETHER ---------------- */

// The header proposes. The arithmetic disposes. Where the two agree the
// answer is certain; where only the header speaks it is a guess and says so.
export function detect(text, opts = {}) {
  const kind = opts.kind || sniff(text);
  let header = [], body = [], record = '';

  if (kind === 'xml') ({ header, body, record } = xmlTable(text));
  else if (kind === 'json') ({ header, body } = jsonTable(text));
  else {
    const sep = kind === 'tsv' ? '\t' : kind === 'psv' ? '|' : ',';
    const all = splitRows(text, sep);
    if (!all.length) return { kind, problem: 'There is nothing in that file.' };
    const h = findHeader(all);
    header = all[h].map((x) => s(x));
    body = all.slice(h + 1);
    record = `row ${h + 1}`;
  }

  if (!header.length) {
    return { kind, problem: kind === 'xml'
      ? 'No repeating record in that file. It may be a report rather than an export of the books.'
      : 'No header row Skwik could find.' };
  }
  // ragged rows are normal; pad rather than lose them
  body = body.map((r) => (r.length >= header.length ? r
    : r.concat(new Array(header.length - r.length).fill(''))));

  const shapes = header.map((_, i) => shapeOf(body.map((r) => r[i])));
  const ev = proofs(header, body, shapes);

  // ---- every column starts with what its name suggests ----
  const score = header.map(() => ({}));
  const why = header.map(() => []);
  const add = (i, role, pts, reason) => {
    if (!role) return;
    score[i][role] = (score[i][role] || 0) + pts;
    if (reason) why[i].push(reason);
  };

  header.forEach((h, i) => {
    for (const [role, w] of fromHeader(h)) {
      // THE NAME IN FULL IS STRONG EVIDENCE; a name that merely contains the
      // word is not. "Opening Balance" was losing to four-digits-looks-like-
      // an-HSN because the two were worth the same.
      add(i, role, w === 1 ? 3 : 1.2, w === 1 ? `named "${s(h)}"` : `name looks like ${role}`);
    }
  });

  // ---- what the column is made of ----
  shapes.forEach((sh, i) => {
    if (sh.dated > 0.9) add(i, 'date', 3, 'every value is a date');
    if (sh.gstin > 0.8) add(i, 'gstin', 5, 'the values are GST numbers');
    if (sh.numeric > 0.9 && sh.rateish > 0.95 && sh.nums.length > 4) {
      add(i, 'gst_rate', 3, 'every figure is a real GST rate');
    }
    // Four digits describes an HSN, and it equally describes an opening
    // balance of 1,040 rupees. Weak on its own; decisive with the name.
    if (sh.hsnish > 0.9 && sh.numeric > 0.9) add(i, 'hsn', 1, 'four, six or eight digits');
    if (sh.numeric < 0.2 && sh.unique > 0.9 && sh.avgLen < 25) {
      add(i, 'bill_no', 1, 'a different value on nearly every row');
    }
    if (sh.numeric > 0.9 && sh.unique > 0.9 && sh.intish > 0.95 && sh.avgLen < 12) {
      add(i, 'bill_no', 1, 'a whole number, different on nearly every row');
    }
    if (sh.numeric < 0.2 && sh.dated < 0.2 && sh.unique < 0.5 && sh.avgLen >= 3) {
      add(i, 'party', 0.5, 'a name that repeats');
      add(i, 'item', 0.5, 'a name that repeats');
    }
    if (sh.numeric < 0.3 && sh.avgLen <= 5 && sh.unique < 0.3 && sh.filled > 3) {
      add(i, 'uom', 1.5, 'a short word from a small set');
    }
  });

  // ---- and then the arithmetic, which is worth far more ----
  for (const p of ev.product) {
    const w = 3 + Math.min(p.hit / 20, 3);
    add(p.a, 'qty', w, `${p.hit} rows where this x ${lbl(header, p.b)} = ${lbl(header, p.c)}`);
    add(p.b, 'rate', w, `${p.hit} rows where ${lbl(header, p.a)} x this = ${lbl(header, p.c)}`);
    add(p.c, 'amount', w, `${p.hit} rows where ${lbl(header, p.a)} x ${lbl(header, p.b)} = this`);
  }
  // A COLUMN THAT MULTIPLIES IS NOT THE THING BEING TAXED.
  //
  // Tax over base landing on a real GST rate is strong evidence -- until the
  // base is the unit RATE and the quantity happens to be the same on every
  // row, when 90 over 500 is 18% by accident and the rate column is declared
  // the taxable value. The multiplication is the older and better proof, so
  // whatever it has already named as a quantity or a rate is not offered as
  // a base here.
  const multiplies = new Set();
  for (const p of ev.product) { multiplies.add(p.a); multiplies.add(p.b); }

  for (const r of ev.rate) {
    if (multiplies.has(r.base)) continue;
    const w = 3 + Math.min(r.hit / 20, 3);
    add(r.tax, 'cgst', w * 0.4, `${r.hit} rows where this over ${lbl(header, r.base)} is a GST rate`);
    add(r.tax, 'sgst', w * 0.4, null);
    add(r.tax, 'igst', w * 0.4, null);
    add(r.base, 'taxable', w, `${r.hit} rows where the tax on this lands on a real GST rate`);
  }
  for (const h of ev.halves) {
    add(h.a, 'cgst', 4, `always the same figure as ${lbl(header, h.b)} — that is CGST and SGST`);
    add(h.b, 'sgst', 4, `always the same figure as ${lbl(header, h.a)}`);
  }
  for (const su of ev.sum) {
    const w = 2 + Math.min(su.hit / 25, 2);
    add(su.z, 'total', w, `${su.hit} rows where ${su.parts.map((i) => lbl(header, i)).join(' + ')} = this`);
    if (su.parts.length >= 3) {
      for (const p of su.parts) add(p, 'taxable', 0.4, null);
    }
  }

  // ---- a date column that is always after another one is the due date ----
  const dateCols = header.map((_, i) => i).filter((i) => shapes[i].dated > 0.9);
  if (dateCols.length > 1) {
    for (const a of dateCols) for (const b of dateCols) {
      if (a === b) continue;
      let after = 0, seen = 0;
      for (const r of body) {
        const x = toDate(r[a]), y = toDate(r[b]);
        if (!x || !y) continue;
        seen++;
        if (y > x) after++;
      }
      if (seen >= 5 && after / seen > 0.9) {
        add(b, 'due_date', 3, `always later than ${lbl(header, a)}`);
        add(a, 'date', 1.5, 'the earlier of the two dates');
      }
    }
  }

  // ---- ONE ROLE TO ONE COLUMN. The best claim wins it. ----
  const picks = header.map((h, i) => {
    const best = Object.entries(score[i]).sort((a, b) => b[1] - a[1]);
    return { i, name: h, role: best[0] ? best[0][0] : null,
             points: best[0] ? best[0][1] : 0,
             runnerUp: best[1] ? best[1][0] : null,
             runnerPoints: best[1] ? best[1][1] : 0,
             why: why[i], shape: shapes[i] };
  });
  const taken = new Map();
  for (const p of [...picks].sort((a, b) => b.points - a.points)) {
    if (!p.role) continue;
    if (!taken.has(p.role)) { taken.set(p.role, p.i); continue; }
    // this role is spoken for: fall to the next claim this column has
    const rest = Object.entries(score[p.i])
      .filter(([r]) => !taken.has(r)).sort((a, b) => b[1] - a[1]);
    p.role = rest[0] ? rest[0][0] : null;
    p.points = rest[0] ? rest[0][1] : 0;
    if (p.role) taken.set(p.role, p.i);
  }

  // ---- how sure, in words a person can argue with ----
  for (const p of picks) {
    const gap = p.points - p.runnerPoints;
    p.sure = !p.role ? 'none'
      : p.points >= 6 && gap >= 2 ? 'certain'
      : p.points >= 3 ? 'likely'
      : 'a guess';
  }

  return {
    kind, record, header, body, rows: body.length,
    cleanRows: ev.clean, droppedRows: ev.dropped,
    columns: picks,
    evidence: ev,
    problem: null,
  };
}

const lbl = (header, i) => s(header[i]) || `column ${i + 1}`;

// What it found, as plain lines. The page and the tests both read this, so
// there is one account of the answer and not two.
export function report(d) {
  if (d.problem) return [d.problem];
  const out = [];
  out.push(`${d.kind.toUpperCase()} · ${d.rows} rows · ${d.header.length} columns`
    + (d.record ? ` · record: ${d.record}` : ''));
  if (d.droppedRows) out.push(`${d.droppedRows} row(s) set aside as totals or blanks.`);
  for (const c of d.columns) {
    out.push(`${(s(c.name) || '(no name)').padEnd(28)} ${(c.role || '—').padEnd(10)} `
      + `${c.sure}${c.why.length ? '  — ' + c.why.slice(0, 2).join('; ') : ''}`);
  }
  return out;
}

/* ---------------- 7. AND NOW TAKE THE DATA OUT ---------------- */

// KNOWING WHICH COLUMN IS WHICH IS NOT THE JOB. HANDING OVER THE BILLS IS.
//
// Everything above works out what the file means. This turns that into
// records in one shape, whatever shape the file arrived in -- which is the
// whole point of the machine. What comes out here is not Skwik's shape and
// not Tally's; it is the plain shape any of them can be fed from:
//
//   { bills: [ { no, date, dueDate, party, gstin, godown, narration,
//                lines: [ { item, uom, qty, rate, amount, gstRate, hsn } ],
//                taxable, cgst, sgst, igst, cess, total } ],
//     ledgers: [ { party, opening, debit, credit, closing } ] }
//
// AND IT CHECKS ITSELF. Every bill's pieces are added up against what the
// file says the bill came to, and the share that agree is handed back. That
// figure is the honest answer to "did this work" -- not the column names, not
// the confidence, the arithmetic afterwards.

const pick = (cols, role) => {
  const c = cols.find((x) => x.role === role);
  return c ? c.i : -1;
};

export function extract(d) {
  if (d.problem) return { problem: d.problem, bills: [], ledgers: [] };
  const cols = d.columns;
  const at = {};
  for (const r of ['bill_no', 'date', 'due_date', 'party', 'gstin', 'item', 'uom', 'qty',
                   'rate', 'amount', 'discount', 'taxable', 'gst_rate', 'cgst', 'sgst',
                   'igst', 'cess', 'total', 'hsn', 'godown', 'narration',
                   'opening', 'closing', 'debit', 'credit']) at[r] = pick(cols, r);

  const body = d.body || [];
  const cell = (row, i) => (i < 0 ? '' : s(row[i]));
  const n = (row, i) => (i < 0 ? null : toNum(row[i]));

  // ---- a ledger file has openings and closings and no bill on it ----
  if (at.bill_no < 0 && (at.opening >= 0 || at.closing >= 0) && at.party >= 0) {
    const ledgers = body.map((r) => ({
      party: cell(r, at.party),
      opening: n(r, at.opening), debit: n(r, at.debit),
      credit: n(r, at.credit), closing: n(r, at.closing),
    })).filter((x) => x.party);
    // opening + debit - credit = closing, where the file gives all four
    let hit = 0, seen = 0;
    for (const l of ledgers) {
      if (l.opening == null || l.closing == null) continue;
      seen++;
      const made = l.opening + (l.debit || 0) - (l.credit || 0);
      if (Math.abs(made - l.closing) <= Math.max(0.05, Math.abs(l.closing) * 0.005)) hit++;
    }
    return { kind: 'ledgers', bills: [], ledgers,
             closes: seen ? hit / seen : null, checked: seen, agreed: hit, problem: null };
  }

  // ---- otherwise it is bills, one row per line or one row per bill ----
  const groups = new Map();
  const order = [];
  body.forEach((r, ix) => {
    const no = cell(r, at.bill_no);
    const key = no ? `${no}|${cell(r, at.date)}` : `row-${ix}`;
    if (!groups.has(key)) { groups.set(key, []); order.push(key); }
    groups.get(key).push(r);
  });

  const bills = order.map((k) => {
    const rs = groups.get(k);
    const h = rs[0];
    const lines = rs.map((r) => ({
      item: cell(r, at.item), uom: cell(r, at.uom),
      qty: n(r, at.qty), rate: n(r, at.rate),
      amount: n(r, at.amount) != null ? n(r, at.amount)
        : (n(r, at.qty) != null && n(r, at.rate) != null ? n(r, at.qty) * n(r, at.rate) : null),
      gstRate: n(r, at.gst_rate), hsn: cell(r, at.hsn),
      discount: n(r, at.discount),
    })).filter((l) => l.item || l.qty != null || l.amount != null);

    const sum = (i) => (i < 0 ? null
      : rs.reduce((t, r) => (n(r, i) == null ? t : t + n(r, i)), 0));
    const lineSum = lines.reduce((t, l) => t + (l.amount || 0), 0);

    return {
      no: cell(h, at.bill_no), date: toDate(cell(h, at.date)) || cell(h, at.date),
      dueDate: toDate(cell(h, at.due_date)) || '',
      party: cell(h, at.party), gstin: s(cell(h, at.gstin)).toUpperCase(),
      godown: cell(h, at.godown), narration: cell(h, at.narration),
      lines,
      taxable: at.taxable >= 0 ? sum(at.taxable) : round2(lineSum),
      cgst: sum(at.cgst), sgst: sum(at.sgst), igst: sum(at.igst), cess: sum(at.cess),
      // the file's own figure where it has one, and only then the pieces
      total: at.total >= 0 ? n(h, at.total) : null,
      rows: rs.length,
    };
  });

  // ---- THE CHECK. Does each bill add up to what the file says it came to? --
  let hit = 0, seen = 0;
  for (const b of bills) {
    if (b.total == null) continue;
    seen++;
    const made = (b.taxable || 0) + (b.cgst || 0) + (b.sgst || 0)
               + (b.igst || 0) + (b.cess || 0);
    if (Math.abs(made - b.total) <= Math.max(0.05, Math.abs(b.total) * 0.005)) hit++;
    else b.doesNotAddUp = round2(made - b.total);
  }

  return { kind: 'bills', bills, ledgers: [],
           closes: seen ? hit / seen : null, checked: seen, agreed: hit, problem: null };
}

const round2 = (x) => Math.round((Number(x) || 0) * 100) / 100;
