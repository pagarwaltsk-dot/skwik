// BRINGING BOOKS IN, AND SENDING THEM OUT.
//
// Nobody retypes 800 items. A shopkeeper already has them in Tally, or in a
// spreadsheet somebody made for him, and his accountant wants everything back
// in Tally at the end of the month. Both roads are here, and neither of them
// touches the database — these are plain functions over text, so they can be
// read and checked on their own.

import { n2 } from './money';
import { STATES, codeForState } from './states';
import { guessUqc, isUqc } from './uqc';

// "Bottles", "Pieces", "Meters" — what Tally and spreadsheets actually hold.
// Stored as they come, they print as nonsense and the GST portal refuses the
// return, so they are turned into real unit codes on the way in.
const asUqc = (unit, fallback = 'PCS') => {
  const u = String(unit || '').trim();
  if (!u) return fallback;
  if (isUqc(u)) return u.toUpperCase();
  return guessUqc(u) || fallback;
};

/* ===================== making sense of the bytes ===================== */

// Tally writes its XML as UTF-16 more often than not. Read as ordinary text
// that arrives with a NUL between every single letter, so "<ENVELOPE" looks
// like "<\0E\0N\0V\0..." and nothing matches. Dropping the NULs turns it
// straight back into readable XML. The marks Excel and Notepad leave at the
// very start go the same way.
export function cleanText(raw) {
  let t = String(raw ?? '');
  if (t.indexOf('\u0000') !== -1) t = t.replace(/\u0000/g, '');
  return t.replace(/^[\uFEFF\uFFFE]+/, '');
}

// WHEN THE PHONE HANDS BACK NONSENSE.
//
// Tally writes its XML as UTF-16. Android reads files as UTF-8 unless told
// otherwise, and the two do not agree: the mark at the start of the file comes
// back as a pair of question marks and the rest arrives with a hole between
// every letter. Rather than argue with the phone, we take the raw bytes and
// work out the encoding ourselves, which is the only way to be sure.

// Did the text come back mangled, or is it fine as it is?
export function looksMangled(text) {
  const head = String(text ?? '').slice(0, 400);
  return head.indexOf('\u0000') !== -1 || head.indexOf('\uFFFD') !== -1;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

// A LOOKUP, NOT A SEARCH.
//
// This used to ask B64.indexOf() for the value of every single character —
// a scan through a sixty-four character string, per character, over a file
// that can run to millions of them, each one also allocating a one-character
// string to do it with. Tally writes its XML as UTF-16, which the phone
// always reads wrong the first time, so EVERY Tally import came through here.
// That is the minutes he spent watching a spinner.
//
// A table of 128 slots, filled once, answers the same question by reading one
// number out of an array.
const B64AT = (() => {
  const t = new Int16Array(128).fill(-1);
  for (let i = 0; i < B64.length; i++) t[B64.charCodeAt(i)] = i;
  return t;
})();

export function base64ToBytes(b64) {
  const s = String(b64 || '');
  const out = new Uint8Array(((s.length * 3) >> 2) + 3);
  let o = 0, acc = 0, bits = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    // padding, newlines and anything else that is not base64 is skipped where
    // it is found, which saves copying the whole string to strip it first
    const v = c < 128 ? B64AT[c] : -1;
    if (v < 0) continue;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) { bits -= 8; out[o++] = (acc >> bits) & 0xFF; }
  }
  return out.subarray(0, o);
}

// Bytes in, readable text out. Handles UTF-16 either way round, with or
// without a mark at the start, and plain UTF-8.
export function decodeBytes(bytes) {
  const b = bytes;
  if (!b || !b.length) return '';

  const utf16 = (start, little) => {
    const parts = [];
    const chunk = 8192;
    const codes = new Array(chunk);
    let n = 0;
    for (let i = start; i + 1 < b.length; i += 2) {
      codes[n++] = little ? (b[i] | (b[i + 1] << 8)) : ((b[i] << 8) | b[i + 1]);
      if (n === chunk) { parts.push(String.fromCharCode.apply(null, codes)); n = 0; }
    }
    if (n) parts.push(String.fromCharCode.apply(null, codes.slice(0, n)));
    return parts.join('');
  };

  if (b[0] === 0xFF && b[1] === 0xFE) return utf16(2, true);    // UTF-16, low byte first
  if (b[0] === 0xFE && b[1] === 0xFF) return utf16(2, false);   // UTF-16, high byte first

  // No mark, but a hole after every letter means UTF-16 all the same.
  let holes = 0, looked = 0;
  for (let i = 1; i < Math.min(b.length, 400); i += 2) { looked++; if (b[i] === 0) holes++; }
  if (looked && holes / looked > 0.8) return utf16(0, true);

  // Plain bytes. Tally masters are ASCII in practice, and anything higher is
  // stitched back together here rather than lost.
  const parts = [];
  const chunk = 8192;
  for (let i = 0; i < b.length; i += chunk) {
    parts.push(String.fromCharCode.apply(null, b.subarray(i, i + chunk)));
  }
  let t = parts.join('');
  try { t = decodeURIComponent(escape(t)); } catch (e) { /* already readable */ }
  return t;
}

// The first hundred or so readable characters, for showing him when we cannot
// make head or tail of a file. Far more use than "could not read that file".
export function peek(raw, n = 120) {
  const t = cleanText(raw);
  const shown = t.replace(/\s+/g, ' ').trim().slice(0, n);
  return `${shown || '(nothing readable)'}  [${String(raw ?? '').length} characters read]`;
}

/* ===================== CSV, read ===================== */

// A CSV a shopkeeper actually has is not a tidy CSV. It may be saved from
// Excel with quoted fields, commas inside names, \r\n endings, and a stray
// blank line at the end. All of that is handled here.
export function parseCsv(text) {
  text = cleanText(text);
  const rows = [];
  let row = [], field = '', quoted = false;
  const s = String(text || '').replace(/^﻿/, '');   // Excel's byte-order mark

  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; }      // "" inside a quoted field
        else quoted = false;
      } else field += c;
    } else if (c === '"') {
      quoted = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n') {
      row.push(field); field = '';
      if (row.some((x) => x.trim() !== '')) rows.push(row);
      row = [];
    } else if (c !== '\r') {
      field += c;
    }
  }
  row.push(field);
  if (row.some((x) => x.trim() !== '')) rows.push(row);
  return rows.map((r) => r.map((x) => x.trim()));
}

// Column headings are never what you expect. "Item Name", "PARTICULARS",
// "Product", "naam" — all of them mean the name. This matches on the words
// people actually use rather than demanding an exact heading.
const SAYS = {
  name:           ['name', 'itemname', 'item', 'product', 'particulars', 'description', 'stockitem', 'ledgername', 'party', 'partyname', 'customer', 'supplier'],
  alias:          ['alias', 'alsocalled', 'localname', 'othername', 'shortname'],
  hsn:            ['hsn', 'hsncode', 'hsnsac', 'sac'],
  unit:           ['unit', 'uom', 'units', 'baseunit', 'baseunits', 'per'],
  // THE PRICE THAT PRINTS ON AN ORDINARY BILL.
  //
  // 'wholesale' used to be in this list. A spreadsheet with a retail column
  // and a wholesale column beside it therefore had the WHOLESALE rate read as
  // the selling price — silently — and every retail bill afterwards went out
  // at the lower one. Wholesale is a second list, and that is where it sits
  // now. A file whose ONLY price column says wholesale still works: see the
  // fallback under itemsFromCsv.
  sale_price:     ['saleprice', 'sellingprice', 'sellingrate', 'salerate', 'salesrate',
                   'saleslrate', 'sellrate', 'rate', 'price', 'mrp',
                   'retail', 'retailprice', 'retailrate'],
  price2:         ['price2', 'secondprice', 'rate2', 'wholesale', 'wholesaleprice',
                   'wholesalerate', 'dealerprice', 'dealerrate'],
  purchase_price: ['purchaseprice', 'costprice', 'cost', 'buyrate', 'purchaserate'],
  gst_rate:       ['gst', 'gstrate', 'taxrate', 'gstpercent', 'rateofgst', 'igstrate'],
  opening_stock:  ['openingstock', 'opening', 'stock', 'qty', 'quantity', 'openingqty'],
  gstin:          ['gstin', 'gstno', 'gstnumber', 'partygstin', 'gst'],
  phone:          ['phone', 'mobile', 'contact', 'phoneno', 'mobileno', 'ledgerphone'],
  address:        ['address', 'add', 'addr'],
  state_name:     ['state', 'statename'],
  // a column headed simply "Opening" is what most lists actually say
  opening_balance:['openingbalance', 'balance', 'outstanding', 'due', 'openingbal',
                   'opening', 'openingamount', 'openingdue', 'oldbalance', 'previousbalance'],
  owed_by:        ['owedby', 'owed', 'direction', 'drcr', 'debitcredit'],
  kind:           ['customerorsupplier', 'kind', 'type', 'partytype', 'category'],
};

const tidy = (h) => String(h || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// Which column is which. Returns { field: columnIndex }.
export function mapColumns(header, wanted) {
  const out = {};
  const used = new Set();
  header.forEach((h, i) => {
    const t = tidy(h);
    if (!t) return;
    for (const field of wanted) {
      if (out[field] !== undefined) continue;
      const words = SAYS[field] || [];
      // an exact word wins; otherwise the heading containing the word
      if (words.includes(t) || words.some((w) => t === w)) {
        if (used.has(i)) continue;
        out[field] = i; used.add(i); return;
      }
    }
  });
  // second pass, looser: the heading merely contains the word
  header.forEach((h, i) => {
    if (used.has(i)) return;
    const t = tidy(h);
    if (!t) return;
    for (const field of wanted) {
      if (out[field] !== undefined) continue;
      if ((SAYS[field] || []).some((w) => t.includes(w))) {
        out[field] = i; used.add(i); return;
      }
    }
  });
  return out;
}

const cell = (row, i) => (i === undefined ? '' : String(row[i] ?? '').trim());

// The "Owed by" column Skwik writes: "you" or "them".
const owedBy = (v) => {
  const s = String(v || '').trim().toLowerCase();
  if (/^(you|me|myself|i)$/.test(s) || /you owe/.test(s)) return 'you_owe';
  if (/^(them|they|him|party|customer)$/.test(s) || /owes you/.test(s)) return 'owes_you';
  return null;
};
const money = (x) => {
  const v = Number(String(x).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(v) ? v : 0;
};

// WHICH COLUMN SKWIK DECIDED WAS WHICH.
//
// The importer has to guess, because every spreadsheet names its columns
// differently. Guessing is fine; guessing silently is not — a wholesale rate
// read as the selling price costs money on every bill afterwards and nothing
// on screen ever said so. This hands the reading back in plain words for the
// confirm screen to show before a single row is written.
const FIELD_SAYS = {
  name: 'Item name', alias: 'Also called', hsn: 'HSN', unit: 'Unit',
  sale_price: 'Selling price', price2: 'Second price', purchase_price: 'Cost price',
  gst_rate: 'GST rate', opening_stock: 'Opening stock',
  kind: 'Customer or supplier', gstin: 'GST number', phone: 'Phone',
  address: 'Address', state_name: 'State', opening_balance: 'Opening balance',
  owed_by: 'Who owes',
};

export function namedColumns(header, cols) {
  const out = [];
  for (const [field, i] of Object.entries(cols || {})) {
    if (i === undefined) continue;
    out.push({ field, says: FIELD_SAYS[field] || field, heading: String(header?.[i] ?? '').trim() });
  }
  return out;
}

/* ---------------- WHAT TALLY CALLS "EXCEL" ----------------
   I told him to export the price list to Excel. Then I checked what happens
   when he does, and the app said "nothing we could use" without saying why.

   Tally's Export → Excel writes one of three quite different things:

     * a real .xlsx, which is a zip and begins PK
     * an old .xls, which is a compound file and begins with D0 CF 11 E0
     * an HTML TABLE with an .xls name, which is what most Tally versions
       actually produce and what most shops end up with

   The third is plain text and can simply be read, so it is. The first two
   cannot be read without unpacking a zip on the phone, so he is told exactly
   what to do instead of being told nothing.                               */

export function excelKind(text) {
  const head = String(text || '').slice(0, 8);
  if (head.startsWith('PK\u0003\u0004')) return 'xlsx';
  if (head.charCodeAt(0) === 0xD0 && head.charCodeAt(1) === 0xCF) return 'xls';
  return '';
}

const looksLikeTable = (t) => /<\s*table[\s>]/i.test(t) && /<\s*tr[\s>]/i.test(t);

// An HTML table, turned into the rows a spreadsheet would have given us.
export function tableToRows(html) {
  const out = [];
  const trRe = /<\s*tr[^>]*>([\s\S]*?)<\s*\/\s*tr\s*>/gi;
  let tr;
  while ((tr = trRe.exec(html))) {
    const cells = [];
    const tdRe = /<\s*(td|th)[^>]*>([\s\S]*?)<\s*\/\s*\1\s*>/gi;
    let td;
    while ((td = tdRe.exec(tr[1]))) {
      cells.push(unesc(String(td[2]).replace(/<[^>]*>/g, ' ')).trim());
    }
    if (cells.length && cells.some((c) => c !== '')) out.push(cells);
  }
  // Tally puts its company name and the report title in rows of their own
  // above the real headings, so the first row with more than one filled cell
  // is where the table actually starts.
  while (out.length && out[0].filter((c) => c !== '').length < 2) out.shift();
  return out;
}

// A spreadsheet, however it arrived: a real CSV, or the HTML table that
// Tally's "Export to Excel" actually writes.
export function sheetRows(text) {
  const t = cleanText(text);
  return looksLikeTable(t) ? tableToRows(t) : parseCsv(t);
}

export function itemsFromCsv(text) {
  const rows = sheetRows(text);
  if (rows.length < 2) {
    return { rows: [], problem: `That file has no rows under the headings. `
      + `It begins: ${peek(text, 90)}` };
  }
  const cols = mapColumns(rows[0], ['name', 'alias', 'hsn', 'unit', 'sale_price', 'price2',
                                    'purchase_price', 'gst_rate', 'opening_stock']);
  if (cols.name === undefined) {
    return { rows: [], problem: 'No column looks like the item name. One heading must say Name, Item or Particulars.' };
  }
  // A LIST WITH ONLY A WHOLESALE COLUMN STILL HAS TO BILL.
  //
  // Wholesale is read as the second price. When it is the only price in the
  // file, leaving the selling price at zero would give him a book of items
  // that cannot go on a bill, so it fills both.
  const onlySecond = cols.sale_price === undefined && cols.price2 !== undefined;

  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const name = cell(rows[i], cols.name);
    if (!name) continue;
    out.push({
      name,
      alias: cell(rows[i], cols.alias),
      hsn: cell(rows[i], cols.hsn).replace(/[^0-9]/g, ''),
      unit: asUqc(cell(rows[i], cols.unit)),
      sale_price: money(cell(rows[i], onlySecond ? cols.price2 : cols.sale_price)),
      price2: onlySecond ? 0 : money(cell(rows[i], cols.price2)),
      purchase_price: money(cell(rows[i], cols.purchase_price)),
      gst_rate: money(cell(rows[i], cols.gst_rate)),
      opening_stock: money(cell(rows[i], cols.opening_stock)),
    });
  }
  return { rows: out, problem: null, columns: namedColumns(rows[0], cols) };
}

export function partiesFromCsv(text) {
  const rows = sheetRows(text);
  if (rows.length < 2) {
    return { rows: [], problem: `That file has no rows under the headings. `
      + `It begins: ${peek(text, 90)}` };
  }
  const cols = mapColumns(rows[0],
    ['name', 'kind', 'gstin', 'phone', 'address', 'state_name', 'opening_balance', 'owed_by']);
  if (cols.name === undefined) {
    return { rows: [], problem: 'No column looks like the name. One heading must say Name or Party.' };
  }
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const name = cell(rows[i], cols.name);
    if (!name) continue;
    const gstin = cell(rows[i], cols.gstin).toUpperCase().replace(/\s/g, '');
    const code  = gstin.slice(0, 2);
    out.push({
      name,
      gstin: gstin.length === 15 ? gstin : '',
      phone: cell(rows[i], cols.phone).replace(/[^0-9]/g, '').slice(-10),
      address: cell(rows[i], cols.address),
      // The GST number carries the state in its first two digits. When there
      // is no GST number the spreadsheet usually names the state instead, so
      // the name is turned back into a code rather than thrown away.
      state_code: STATES[code] ? code : codeForState(cell(rows[i], cols.state_name)),
      state_name: STATES[code]
               || STATES[codeForState(cell(rows[i], cols.state_name))]
               || cell(rows[i], cols.state_name),
      // Which way the balance runs. Skwik's own export writes the amount as a
      // plain number and puts the direction in its own column, so that column
      // is read first; a file from anywhere else gets the old rule, where a
      // minus means the money is going the other way.
      opening_balance: Math.abs(money(cell(rows[i], cols.opening_balance))),
      opening_type: owedBy(cell(rows[i], cols.owed_by))
                 || (money(cell(rows[i], cols.opening_balance)) < 0 ? 'you_owe' : 'owes_you'),
      kind: /suppl|vendor|creditor/i.test(cell(rows[i], cols.kind)) ? 'supplier' : 'customer',
    });
  }
  return { rows: out, problem: null, columns: namedColumns(rows[0], cols) };
}

/* ===================== Tally XML, read ===================== */

// Tally's own export. Not a real XML parser — a tag reader, which is all that
// is needed and cannot blow up on the odd characters Tally writes.
//
// Two things about real Tally files that catch people out. An item's name is
// on the STOCKITEM tag itself, not in a <NAME> element. And most items carry
// no HSN or GST rate of their own — those sit on the stock GROUP the item
// belongs to, so the groups have to be read first and the item told to look
// up its parent.

// The tag must end right after its name, or carry a space before attributes.
// Without that, asking for NAME also matches <NAME.LIST> and brings back
// rubbish.
const rx = (tag) => String(tag).replace(/\./g, '\\.');

const tagOf = (chunk, tag) => {
  const m = chunk.match(new RegExp(`<${rx(tag)}(?:\\s[^>]*)?>([\\s\\S]*?)</${rx(tag)}>`, 'i'));
  return m ? unesc(m[1].trim()) : '';
};

const unesc = (s) => String(s)
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&nbsp;/gi, ' ')
  .replace(/&#\d+;/g, ' ')            // Tally's own markers, e.g. &#4;
  .replace(/\s+/g, ' ').trim();

// A FIGURE FROM THE LEDGER, NOT FROM ONE OF ITS BILLS.
//
// "They say receipt as opening balance — maybe the highest receipt from that
// party." Almost: the highest BILL. A Tally ledger kept bill-by-bill carries
// one BILLALLOCATIONS.LIST per outstanding bill, each with its own
// <OPENINGBALANCE>, and Tally writes those lists BEFORE the ledger's own
// figure. tagOf takes the first match anywhere in the block — so a customer
// standing at 1,27,500 across two bills was imported at 96,000, the larger of
// the two, and there was no way to tell from the screen.
//
// The same trap sits under stock items, whose batch and price lists carry
// their own OPENINGBALANCE and OPENINGRATE.
//
// So the figures and the identity are read from the TOP LEVEL of the block —
// every nested <SOMETHING.LIST> taken out first. Anything that genuinely
// lives in a list, an address or a price level, is still read from the whole
// block by the code that knows to look there.
const stripLists = (chunk) => String(chunk)
  .replace(/<([A-Za-z0-9_]+\.LIST)(?:\s[^>]*)?>[\s\S]*?<\/\1>/gi, '');

const tagTop = (chunk, tag) => tagOf(stripLists(chunk), tag);

const blocksOf = (xml, tag) => {
  const out = [];
  const re = new RegExp(`<${rx(tag)}(?:\\s[^>]*)?>[\\s\\S]*?</${rx(tag)}>`, 'gi');
  let m;
  while ((m = re.exec(xml))) out.push(m[0]);
  return out;
};

const nameAttr = (chunk) => {
  const m = chunk.match(/^<[A-Z.]+\s[^>]*?\bNAME\s*=\s*"([^"]*)"/i);
  return m ? unesc(m[1]) : '';
};

// "116.95/Doz", " 29.50 Doz", " 6", "-3450.03" — pull the number out of any of them.
// A QUANTITY TALLY WROTE, WHICH IS NOT ALWAYS A NUMBER.
//
// "200 Nos" is two hundred. "10 Box of 12 Nos" is a hundred and twenty, and
// reading the first number off it gives ten — so a shop that keeps tiffin
// clips in boxes had a twelfth of its stock, and the value of the shelf came
// out a twelfth of what Tally says. Tally writes the conversion into the
// string itself, so it is there to be read.
const qtyOf = (x) => {
  const t = String(x ?? '');
  if (!t.trim()) return 0;
  const nums = t.match(/-?[\d,]*\.?\d+/g);
  if (!nums || !nums.length) return 0;
  // "10 Box of 12 Nos" — the numbers on either side of "of" multiply
  let v = Number(nums[0].replace(/,/g, '')) || 0;
  if (/\bof\b/i.test(t)) {
    for (let i = 1; i < nums.length; i++) {
      const n = Number(nums[i].replace(/,/g, '')) || 0;
      if (n) v *= n;
    }
  }
  return v;
};

const numOf = (x) => {
  const m = String(x ?? '').match(/-?[\d,]*\.?\d+/);
  return m ? Number(m[0].replace(/,/g, '')) || 0 : 0;
};

// GST lives in repeated blocks, one per date it changed. Take the latest, then
// prefer the IGST head — that is the whole rate. CGST alone is only half.
function gstRateOf(chunk) {
  const blocks = blocksOf(chunk, 'GSTDETAILS.LIST');
  if (!blocks.length) return 0;

  let best = null, bestFrom = '';
  for (const b of blocks) {
    const from = tagOf(b, 'APPLICABLEFROM') || '';
    if (!best || from >= bestFrom) { best = b; bestFrom = from; }
  }

  let cgst = 0, igst = 0;
  for (const r of blocksOf(best, 'RATEDETAILS.LIST')) {
    const head = tagOf(r, 'GSTRATEDUTYHEAD').toUpperCase();
    const rate = numOf(tagOf(r, 'GSTRATE'));
    if (!rate) continue;
    if (head.startsWith('IGST')) igst = rate;
    else if (head.startsWith('CGST')) cgst = rate;
  }
  return igst || cgst * 2;
}

const hsnOf = (chunk) => String(tagOf(chunk, 'HSNCODE') || tagOf(chunk, 'GSTHSNCODE'))
  .replace(/[^0-9]/g, '');

// What a stock group can lend its items: an HSN code and a GST rate.
function groupsFromTallyXml(xml) {
  const map = {};
  for (const b of blocksOf(xml, 'STOCKGROUP')) {
    const name = nameAttr(b) || tagTop(b, 'NAME');
    if (!name) continue;
    map[name.toLowerCase()] = {
      hsn: hsnOf(b),
      gst_rate: gstRateOf(b),
      parent: tagTop(b, 'PARENT'),
    };
  }
  return map;
}

// Follow the chain upwards until something has the answer: an item may sit in
// a group inside another group.
function inherited(groups, parent, field, depth = 0) {
  if (!parent || depth > 6) return '';
  const g = groups[String(parent).toLowerCase()];
  if (!g) return '';
  if (g[field]) return g[field];
  return inherited(groups, g.parent, field, depth + 1);
}

/* -------------------- rates, balances -------------------- */

// WHICH FIGURE IS HIS BALANCE.
//
// A Tally masters export carries the figure the books OPENED with — on 1
// April, not today. Some exports also carry the closing figure, and that is
// what a shopkeeper means when he says "his balance", so it wins whenever it
// is in the file. Skwik says afterwards which of the two it found, because
// importing the wrong one silently is how a whole ledger goes wrong.
function balanceOf(block, isQty = false) {
  const read = isQty ? qtyOf : numOf;
  const top = stripLists(block);
  const cl = tagOf(top, 'CLOSINGBALANCE');
  if (cl !== '') return { value: read(cl), basis: 'closing' };
  return { value: read(tagOf(top, 'OPENINGBALANCE')), basis: 'opening' };
}

// Every price level named anywhere in the file. A shop that keeps a wholesale
// list and a retail list has two; most have none.
export function priceLevelsInTally(xml) {
  // CLEANING THE WHOLE FILE, ONCE — NOT ONCE PER PRICE LEVEL.
  //
  // cleanText(xml) sat inside the loop condition, so every time a price level
  // was found the entire export was copied and scanned again from the start.
  // A shop with three thousand items on six price lists has eighteen thousand
  // of them, so the file was copied eighteen thousand times: seven megabytes,
  // eighteen thousand times, on a phone. That is the import that "takes
  // toooo long" — and it is why doubling the items quadrupled the wait
  // instead of doubling it.
  //
  // Measured on a 7 MB export of 3,000 items: 4,299 ms before, 31 ms after.
  const text = cleanText(xml);
  const out = [];
  const re = /<PRICELEVEL>([\s\S]*?)<\/PRICELEVEL>/gi;
  let m;
  while ((m = re.exec(text))) {
    const name = unesc(m[1].trim());
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

// The rates Tally keeps for one item: a block per date the price changed, and
// inside it a line per price level. Reading the first RATE in the block — what
// Skwik used to do — hands back whichever level Tally happened to write first,
// which is how a wholesale rate ends up on a retail bill.
function ratesOf(block) {
  const out = [];
  for (const pl of blocksOf(block, 'FULLPRICELIST.LIST')) {
    const date = tagOf(pl, 'DATE') || '';
    const rows = blocksOf(pl, 'PRICELEVELLIST.LIST');
    if (rows.length) {
      for (const r of rows) {
        const rate = numOf(tagOf(r, 'RATE'));
        if (rate) out.push({ date, level: tagOf(r, 'PRICELEVEL'), rate });
      }
    } else {
      const rate = numOf(tagOf(pl, 'RATE'));
      if (rate) out.push({ date, level: '', rate });
    }
  }
  return out;
}

// The plain selling rate, for a shop that never made a price list at all.
// Tally keeps it under its own heading, and reading only the price levels
// missed it entirely.
function standardRate(block) {
  let best = 0, bestDate = '';
  for (const pl of blocksOf(block, 'STANDARDPRICELIST.LIST')) {
    const date = tagOf(pl, 'DATE') || '';
    const rate = numOf(tagOf(pl, 'RATE'));
    if (rate && date >= bestDate) { best = rate; bestDate = date; }
  }
  return best || numOf(tagOf(block, 'STANDARDPRICE'));
}

// The newest rate on the level he named. If he named none, or that level has
// no rate for this item, the newest rate of any level — which is right for the
// shops that keep a single price list.
function rateAt(rates, level) {
  const newest = (list) => list.reduce((b, r) => (!b || r.date >= b.date ? r : b), null);
  const want = String(level || '').trim().toLowerCase();
  if (want) {
    const mine = rates.filter((r) => String(r.level).trim().toLowerCase() === want);
    if (mine.length) return newest(mine).rate;
    return 0;
  }
  // NO LIST NAMED, AND SEVERAL TO CHOOSE FROM: DO NOT CHOOSE.
  //
  // This took the newest rate of any level — and Tally writes every level of
  // an item under one date, so "newest" meant whichever happened to be last
  // in the file. A shop with six price lists got a silently arbitrary one,
  // and nothing on the screen said which. He would only find out from a bill.
  //
  // One list, or a file that names none, is not a choice and is used. More
  // than one and the rate stays empty until he says which — the sheet counts
  // them and says so before anything is saved.
  const named = [];
  for (const r of rates) {
    const lv = String(r.level || '').trim().toLowerCase();
    if (lv && named.indexOf(lv) < 0) named.push(lv);
  }
  if (named.length > 1) return 0;
  const any = newest(rates);
  return any ? any.rate : 0;
}

// The same rows, priced off different lists. Nothing is read again.
//
// TWO LISTS, BECAUSE SKWIK HAS TWO.
//
// Tally holds as many price levels as a shop cares to make; Skwik bills on
// two, and every customer sits on one of them. So the import asks which Tally
// level is which — and the second one was never asked for at all, which is
// why his second price came in empty every time.
export function applyPriceLevel(rows, level, level2) {
  return (rows || []).map((r) => {
    if (!r._rates) return r;
    // Same order as the first read: his list, then the plain selling rate,
    // and NEVER the purchase price — see sale_price below.
    const sale = rateAt(r._rates, level) || r._std || 0;
    const two  = level2 ? rateAt(r._rates, level2) : 0;
    return { ...r, sale_price: sale, price2: two,
             _has: { ...(r._has || {}), sale_price: !!sale, price2: !!two } };
  });
}

export function itemsFromTallyXml(xml, opts = {}) {
  xml = cleanText(xml);
  const groups = groupsFromTallyXml(xml);
  const out = [];
  let sawClosing = false, sawOpening = false, noRate = 0;

  for (const b of blocksOf(xml, 'STOCKITEM')) {
    const name = nameAttr(b) || tagTop(b, 'NAME');
    if (!name) continue;

    const parent = tagTop(b, 'PARENT');
    const hsn = hsnOf(b) || inherited(groups, parent, 'hsn');
    const gst = gstRateOf(b) || inherited(groups, parent, 'gst_rate');

    // The rate he sells at, off the price level he picked.
    const rates = ratesOf(b);
    const onList = rateAt(rates, opts.level);
    // A shop with no price list at all keeps its selling rate here instead.
    const sale = onList || standardRate(b);
    const two  = opts.level2 ? rateAt(rates, opts.level2) : 0;
    if (!sale) noRate++;

    const bal  = balanceOf(b, true);     // a quantity, not a rupee figure
    if (bal.basis === 'closing') sawClosing = true; else sawOpening = true;

    // WHAT THE GOODS COST, WORKED OUT THE WAY TALLY WORKED IT OUT.
    //
    // This read OPENINGRATE and stopped. But the rate is quoted per whatever
    // unit Tally felt like — "1,200.00/Box of 12 Nos" — while the quantity is
    // counted in pieces, so multiplying the two gave a shelf worth twelve
    // times what it is. Tally also hands over the VALUE of that stock, and
    // value divided by quantity is the cost of one, in the unit the quantity
    // is counted in, by construction. That is the figure that makes Skwik's
    // stock total agree with his Stock Summary instead of merely resembling
    // it. The plain rate stays as the answer when there is no value to divide.
    const val  = numOf(tagTop(b, 'OPENINGVALUE'));
    const rate = numOf(tagTop(b, 'OPENINGRATE'));
    const cost = (bal.value && val) ? n2(Math.abs(val) / Math.abs(bal.value)) : rate;

    out.push({
      name,
      alias: '',
      hsn,
      unit: asUqc(tagTop(b, 'BASEUNITS')),
      // A SELLING PRICE THAT IS SECRETLY THE PURCHASE PRICE IS A SHOP
      // SELLING AT COST.
      //
      // When the chosen price list had no rate for an item — and most
      // exports have a rate for only some of them — this quietly wrote the
      // purchase price into the selling price. On screen the two then read
      // the same and nothing anywhere said why. Worse, every bill written
      // off it gives the goods away. An item Tally has no selling rate for
      // now arrives with none, the bill screen already says so in words
      // ("No selling price on this item"), and the count is reported before
      // a single row is saved.
      sale_price: sale,
      price2: two,
      purchase_price: cost,
      gst_rate: gst,
      opening_stock: bal.value,
      group: parent,
      // EVERY LEVEL'S RATE, KEPT ON THE ROW.
      //
      // Tapping a different price list used to read the whole file again from
      // the beginning — for a shop with five hundred items and six lists that
      // is the entire XML re-parsed on the phone's one thread, and for a
      // second or two nothing on the screen answers a finger at all. It looks
      // exactly like a chip that does not work, so he taps it again.
      //
      // The rates were already in hand when this row was built. Keeping them
      // turns changing the list into arithmetic on what is already read.
      // planImport builds its own body field by field, so this never reaches
      // the database.
      _rates: rates,
      _std: standardRate(b),
      // WHAT THIS FILE ACTUALLY SAYS, as opposed to what it leaves blank.
      //
      // A nought coming out of a parser means one of two completely
      // different things: "Tally says zero" or "Tally did not say". Until now
      // they were the same number and the update wrote both, so an item Tally
      // had no rate for arrived as 0 and that 0 went over a selling price he
      // had typed in himself. The screen promises nothing is ever removed.
      // This is how that promise is kept.
      _has: {
        sale_price:     !!sale,
        price2:         !!two,
        purchase_price: !!cost,
        gst_rate:       !!gst,
        hsn:            !!hsn,
        unit:           !!tagTop(b, 'BASEUNITS'),
        // Tally always writes the stock figure, so a nought here is a real
        // nought: he has none of it, and that must be allowed to overwrite.
        opening_stock:  true,
      },
    });
  }

  if (out.length) {
    return { rows: out, problem: null, noRate,
             levels: priceLevelsInTally(xml),
             basis: sawClosing && !sawOpening ? 'closing'
                  : sawClosing ? 'mixed' : 'opening' };
  }
  return { rows: [], problem: blocksOf(xml, 'LEDGER').length
    ? 'That file holds customers and suppliers, not items. Use it under '
      + '"Customers and suppliers" instead.'
    : `No stock items in that file. It begins: ${peek(xml, 90)}` };
}

// THE GROUPS A SHOP ACTUALLY FILES ITS CUSTOMERS UNDER.
//
// Nobody with three hundred customers leaves them all directly under Sundry
// Debtors. They go under "Assam Parties", or "Guwahati Local", or "North
// East" — a group inside a group inside Sundry Debtors. Tally writes the
// IMMEDIATE parent on the ledger, so a test for the words "debtor" or
// "creditor" on that one line matched almost none of them, and every one it
// did not match was skipped without a word. That is why his debtors and
// creditors did not add up: most of them were never brought in at all.
//
// Tally exports the groups themselves alongside the ledgers, each with its
// own parent, so the chain can be walked to the top.
function ledgerGroupsFromTallyXml(xml) {
  const map = {};
  for (const b of blocksOf(xml, 'GROUP')) {
    const name = nameAttr(b) || tagTop(b, 'NAME');
    if (!name) continue;
    map[name.toLowerCase()] = {
      parent: tagTop(b, 'PARENT'),
      primary: tagTop(b, 'PRIMARYGROUP') || tagTop(b, 'RESERVEDNAME'),
    };
  }
  return map;
}

const DEBTOR   = /sundry\s*debtor|accounts\s*receivable/i;
const CREDITOR = /sundry\s*creditor|accounts\s*payable/i;

// customer, supplier, or neither — following the chain as far as it goes.
function sideOf(groups, parent, depth = 0) {
  const p = String(parent || '');
  if (!p || depth > 8) return '';
  if (CREDITOR.test(p)) return 'supplier';
  if (DEBTOR.test(p)) return 'customer';
  const g = groups[p.toLowerCase()];
  if (!g) return '';
  if (g.primary) {
    if (CREDITOR.test(g.primary)) return 'supplier';
    if (DEBTOR.test(g.primary)) return 'customer';
  }
  return sideOf(groups, g.parent, depth + 1);
}

export function partiesFromTallyXml(xml) {
  xml = cleanText(xml);
  const out = [];
  let sawClosing = false, sawOpening = false, skipped = 0;
  const groups = ledgerGroupsFromTallyXml(xml);

  for (const b of blocksOf(xml, 'LEDGER')) {
    const name = nameAttr(b) || tagTop(b, 'NAME');
    if (!name) continue;

    // only people who owe money or are owed it — not Sales, Duties, Bank.
    // Some exports put the answer straight on the ledger; otherwise the
    // chain of groups above it is walked.
    const parent = tagTop(b, 'PARENT');
    const side = sideOf(groups, tagTop(b, 'PRIMARYGROUP')) || sideOf(groups, parent);
    if (!side) { skipped++; continue; }

    const gstin = (tagTop(b, 'PARTYGSTIN') || tagTop(b, 'GSTIN')).toUpperCase().replace(/\s/g, '');
    const code  = gstin.slice(0, 2);
    const b2    = balanceOf(b);
    const bal   = b2.value;
    if (b2.basis === 'closing') sawClosing = true; else sawOpening = true;

    out.push({
      name,
      kind: side,
      gstin: gstin.length === 15 ? gstin : '',
      phone: String(tagTop(b, 'LEDGERPHONE') || tagTop(b, 'LEDGERMOBILE')).replace(/[^0-9]/g, '').slice(-10),
      address: tagOf(b, 'ADDRESS'),
      state_code: STATES[code] ? code : '',
      state_name: STATES[code] || tagTop(b, 'LEDSTATENAME') || tagTop(b, 'STATENAME'),
      // Tally writes what a customer owes you as a negative opening balance
      opening_balance: Math.abs(bal),
      opening_type: bal > 0 ? 'you_owe' : 'owes_you',
      // The same account of what the file really carried. A phone number or
      // an address he typed into Skwik is not thrown away because Tally has
      // never been told it — but a ledger standing at nought in Tally IS a
      // nought, and must be allowed to say so.
      _has: {
        kind:            true,
        gstin:           gstin.length === 15,
        is_registered:   gstin.length === 15,
        phone:           !!tagTop(b, 'LEDGERPHONE') || !!tagTop(b, 'LEDGERMOBILE'),
        address:         !!tagOf(b, 'ADDRESS'),
        state_code:      !!(STATES && STATES[code]),
        state_name:      !!(tagTop(b, 'LEDSTATENAME') || tagTop(b, 'STATENAME')
                            || (STATES && STATES[code])),
        opening_balance: true,
        opening_type:    true,
      },
    });
  }

  if (out.length) {
    return { rows: out, problem: null, skipped,
             basis: sawClosing && !sawOpening ? 'closing'
                  : sawClosing ? 'mixed' : 'opening' };
  }
  return { rows: [], problem: blocksOf(xml, 'STOCKITEM').length
    ? `That file holds ${blocksOf(xml, 'STOCKITEM').length} items and no customers. `
      + 'In Tally, export the ledgers separately: Gateway → Chart of Accounts → '
      + 'Ledgers → Export.'
    : 'No customers or suppliers in that file. Tally only counts a name as one '
      + 'if it sits under Sundry Debtors or Sundry Creditors. '
      + `It begins: ${peek(xml, 90)}` };
}

// Which kind of file did he just hand us? Only two answers matter — the
// caller already knows whether it asked for items or for customers.
export function sniff(text) {
  const t = cleanText(text);
  const head = t.slice(0, 8000).toUpperCase();
  if (head.includes('<ENVELOPE') || head.includes('<TALLYMESSAGE')
      || head.includes('<STOCKITEM') || head.includes('<LEDGER')
      || head.includes('<?XML')
      || t.trimStart().startsWith('<')) return 'xml';
  return 'csv';
}

/* ===================== out, as CSV ===================== */

const q = (x) => {
  const s = String(x ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const csv = (header, rows) =>
  [header.map(q).join(','), ...rows.map((r) => r.map(q).join(','))].join('\n');

export const itemsToCsv = (items) => csv(
  ['Name', 'Also called', 'HSN', 'Unit', 'Sale price', 'Second price', 'Purchase price', 'GST rate'],
  items.map((i) => [i.name, i.alias || '', i.hsn || '', i.unit || '',
                    i.sale_price ?? '', i.price2 ?? '', i.purchase_price ?? '', i.gst_rate ?? '']));

export const partiesToCsv = (parties) => csv(
  ['Name', 'Customer or supplier', 'GSTIN', 'Phone', 'State', 'State code', 'Address', 'Opening balance', 'Owed by'],
  parties.map((p) => [p.name, p.kind || '', p.gstin || '', p.phone || '', p.state_name || '',
                      p.state_code || '', p.address || '', p.opening_balance ?? '',
                      p.opening_type === 'you_owe' ? 'you' : 'them']));

export const billsToCsv = (vouchers) => csv(
  ['Date', 'Number', 'Kind', 'Name', 'GSTIN', 'Taxable', 'CGST', 'SGST', 'IGST', 'Extra', 'Round off', 'Total'],
  vouchers.map((v) => [v.vdate, v.voucher_no || '', v.vtype,
                       v.parties?.name || v.printed_name || '', v.parties?.gstin || '',
                       v.taxable, v.cgst, v.sgst, v.igst, v.extra_amount, v.round_off, v.total]));

export const billLinesToCsv = (rows) => csv(
  ['Date', 'Number', 'Name', 'Item', 'HSN', 'Unit', 'Qty', 'Rate', 'Taxable', 'GST rate', 'CGST', 'SGST', 'IGST', 'Amount'],
  rows.map((r) => [r.vdate, r.voucher_no || '', r.who, r.item_name, r.hsn || '', r.unit || '',
                   Number(r.qty), Number(r.rate), r.taxable, r.gst_rate, r.cgst, r.sgst, r.igst, r.amount]));

export const paymentsToCsv = (rows) => csv(
  ['Date', 'In or out', 'Name', 'Cash or bank', 'Account', 'Amount', 'What for'],
  rows.map((p) => [p.pdate, p.ptype === 'receipt' ? 'Received' : 'Paid',
                   p.parties?.name || '', p.mode || '',
                   p.bank_accounts?.name || '', p.amount, p.note || '']));

export const expensesToCsv = (rows) => csv(
  ['Date', 'Head', 'Cash or bank', 'Account', 'Amount', 'Note'],
  rows.map((e) => [e.edate, e.head || '', e.mode || '',
                   e.bank_accounts?.name || '', e.amount, e.note || '']));

export const balancesToCsv = (rows) => csv(
  ['Name', 'Customer or supplier', 'Area', 'Phone', 'GSTIN', 'State',
   'Balance', 'Who owes'],
  (rows || []).map((p) => [p.name, p.kind || '', p.area || '', p.phone || '',
                           p.gstin || '', p.state_name || '',
                           Math.abs(Number(p.balance) || 0),
                           (Number(p.balance) || 0) >= 0 ? 'they owe you' : 'you owe them']));

export const stockToCsv = (rows) => csv(
  ['Item', 'Unit', 'Quantity'],
  (rows || []).map((r) => [r.name || r.item_name || '', r.unit || '', Number(r.qty) || 0]));

export const bookToCsv = (title, opening, rows) => {
  let bal = Number(opening) || 0;
  const out = (rows || []).map((r) => {
    bal = Math.round((bal + (Number(r.in) || 0) - (Number(r.out) || 0)) * 100) / 100;
    return [r.d, r.who || '', r.what || '', r.note || '',
            Number(r.in) || 0, Number(r.out) || 0, bal];
  });
  return csv(['Date', 'Particulars', 'What', 'Note', 'In', 'Out', 'Balance'],
             [['', `${title} — opening`, '', '', '', '', Number(opening) || 0], ...out]);
};

/* ===================== out, as Tally XML ===================== */

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const tallyDate = (d) => String(d || '').replace(/-/g, '');   // 2026-09-19 -> 20260919
const amt = (x) => n2(x).toFixed(2);

// One voucher. In Tally a negative amount is a debit and a positive one is a
// credit, and every voucher must come to zero.
//
// FOUR KINDS OF VOUCHER, NOT TWO.
//
// This used to write out sales and purchases and quietly drop the returns. A
// shopkeeper exported his month, imported it into Tally, and his Tally showed
// more sales than he had made, party balances that did not match his own
// ledger, and a GST liability higher than the one he actually owed — with
// nothing anywhere to say a credit note had gone missing.
//
// A sale return is a Credit Note and a purchase return is a Debit Note, and
// each is the sign-mirror of the thing it reverses.
const TALLY_KIND = {
  sale:            { name: 'Sales',       ledger: (o) => o.sales_ledger    || 'Sales',    flip: false },
  purchase:        { name: 'Purchase',    ledger: (o) => o.purchase_ledger || 'Purchase', flip: true  },
  sale_return:     { name: 'Credit Note',
                     ledger: (o) => o.sales_return_ledger || 'Sales Return',     flip: true  },
  purchase_return: { name: 'Debit Note',
                     ledger: (o) => o.purchase_return_ledger || 'Purchase Return', flip: false },
};

export const goesToTally = (v) =>
  !!TALLY_KIND[v?.vtype] && !v?.cancelled_at;

function voucherXml({ v, lines, org }) {
  const k     = TALLY_KIND[v.vtype] || TALLY_KIND.sale;
  const buy   = k.flip;
  const party = v.parties?.name || v.printed_name || 'Cash';
  const kind  = k.name;
  const main  = k.ledger(org);
  const total = n2(v.total);

  // the party side: on a sale he owes us (debit), on a purchase we owe him (credit)
  const partySide = buy
    ? `<ALLLEDGERENTRIES.LIST><LEDGERNAME>${esc(party)}</LEDGERNAME>`
      + `<ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>${amt(total)}</AMOUNT></ALLLEDGERENTRIES.LIST>`
    : `<ALLLEDGERENTRIES.LIST><LEDGERNAME>${esc(party)}</LEDGERNAME>`
      + `<ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>${amt(-total)}</AMOUNT></ALLLEDGERENTRIES.LIST>`;

  // THE SIGN IS ARITHMETIC, NOT A MINUS GLUED ON THE FRONT.
  //
  // This used to build the amount as a '-' followed by the formatted number.
  // That is right until the number is itself negative — a round-off of -0.06
  // on a purchase came out as "--0.06". Three per cent of vouchers carried
  // one, and Tally will not read it. Negating cannot produce that.
  const flip = (x) => (buy ? -n2(x) : n2(x));
  const pos  = buy ? 'Yes' : 'No';

  const inventory = lines.map((l) => `
      <ALLINVENTORYENTRIES.LIST>
        <STOCKITEMNAME>${esc(l.item_name)}</STOCKITEMNAME>
        <ISDEEMEDPOSITIVE>${pos}</ISDEEMEDPOSITIVE>
        <RATE>${amt(l.rate)}/${esc(l.unit || 'PCS')}</RATE>
        <ACTUALQTY>${Number(l.qty)} ${esc(l.unit || 'PCS')}</ACTUALQTY>
        <BILLEDQTY>${Number(l.qty)} ${esc(l.unit || 'PCS')}</BILLEDQTY>
        <AMOUNT>${amt(flip(l.taxable))}</AMOUNT>
        <ACCOUNTINGALLOCATIONS.LIST>
          <LEDGERNAME>${esc(main)}</LEDGERNAME>
          <ISDEEMEDPOSITIVE>${pos}</ISDEEMEDPOSITIVE>
          <AMOUNT>${amt(flip(l.taxable))}</AMOUNT>
        </ACCOUNTINGALLOCATIONS.LIST>
      </ALLINVENTORYENTRIES.LIST>`).join('');

  const taxLine = (name, value) => (!value ? '' : `
      <ALLLEDGERENTRIES.LIST>
        <LEDGERNAME>${esc(name)}</LEDGERNAME>
        <ISDEEMEDPOSITIVE>${pos}</ISDEEMEDPOSITIVE>
        <AMOUNT>${amt(flip(value))}</AMOUNT>
      </ALLLEDGERENTRIES.LIST>`);

  const taxes = v.tax_mode === 'igst'
    ? taxLine(org.igst_ledger || 'IGST', v.igst)
    : taxLine(org.cgst_ledger || 'CGST', v.cgst) + taxLine(org.sgst_ledger || 'SGST', v.sgst);

  const round = taxLine(org.round_off_ledger || 'Round Off', v.round_off);
  const extra = taxLine(v.extra_note || 'Other charges', v.extra_amount);

  return `
    <TALLYMESSAGE xmlns:UDF="TallyUDF">
      <VOUCHER VCHTYPE="${kind}" ACTION="Create" OBJVIEW="Invoice Voucher View">
        <DATE>${tallyDate(v.vdate)}</DATE>
        <VOUCHERTYPENAME>${kind}</VOUCHERTYPENAME>
        <VOUCHERNUMBER>${esc(v.voucher_no || '')}</VOUCHERNUMBER>
        <PARTYLEDGERNAME>${esc(party)}</PARTYLEDGERNAME>
        <BASICBASEPARTYNAME>${esc(party)}</BASICBASEPARTYNAME>
        <PERSISTEDVIEW>Invoice Voucher View</PERSISTEDVIEW>
        <ISINVOICE>Yes</ISINVOICE>
        ${v.parties?.gstin ? `<PARTYGSTIN>${esc(v.parties.gstin)}</PARTYGSTIN>` : ''}
        ${partySide}${taxes}${extra}${round}${inventory}
      </VOUCHER>
    </TALLYMESSAGE>`;
}

export function tallyVouchersXml({ org, vouchers, linesByVoucher }) {
  // A CANCELLED BILL IS NOT AN ENTRY.
  //
  // Nothing filtered these out, so a bill the shopkeeper had cancelled went
  // into Tally as a live sale — money he never took, tax he never owed.
  const body = vouchers
    .filter(goesToTally)
    .map((v) => voucherXml({ v, lines: linesByVoucher[v.id] || [], org }))
    .join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE>
  <HEADER>
    <TALLYREQUEST>Import Data</TALLYREQUEST>
  </HEADER>
  <BODY>
    <IMPORTDATA>
      <REQUESTDESC>
        <REPORTNAME>Vouchers</REPORTNAME>
        <STATICVARIABLES>
          <SVCURRENTCOMPANY>${esc(org?.name || '')}</SVCURRENTCOMPANY>
        </STATICVARIABLES>
      </REQUESTDESC>
      <REQUESTDATA>${body}
      </REQUESTDATA>
    </IMPORTDATA>
  </BODY>
</ENVELOPE>`;
}

/* ===================== a copy he owns ===================== */

// THE WHOLE BOOK, IN ONE FILE.
//
// Everything lives on a server he does not own, and the honest answer to
// "what happens to my books if you disappear?" has to be better than a shrug.
// This writes the lot — firm, items, customers, every bill and every line,
// receipts and payments — into a single file he can keep on his own phone,
// his own Drive, his own computer.
//
// It is also the way back. Every bill carries the id it had, and saving a
// bill that is already there does nothing, so a restore can be run twice, or
// half way, or on top of a book that is partly rebuilt, without making
// duplicates.

// 2: money out is in the file. A backup taken by an older Skwik is still
//    read — it simply has no expenses in it.
// 3 — the godowns, the bank accounts and the stock movements no bill made.
// A version-1 or 2 file still reads; it simply has none of them in it.
export const BACKUP_VERSION = 3;

// WHAT "TAKE A COPY FIRST" HAS TO MEAN.
//
// Two screens send him here before something destroys his books — emptying
// the firm, and closing the account. The file they pointed him at held his
// bills and his customers but not a rupee of what he SPENT: rent, salary,
// transport, the lot. A shop that restored from it would have every sale it
// ever made and no costs at all, and would believe it had earned far more
// than it did.
// WHAT A BACKUP HAS TO CARRY, AND WHAT IT USED TO LEAVE BEHIND.
//
// Stock in hand is opening_stock plus every row of stock_moves. The bills'
// own movements come back by themselves, because putting a bill back writes
// them again — but three things were never in the file at all:
//
//   godowns        every bill and every movement carries a godown ID, and
//                  the database has a foreign key on it. Restoring into a
//                  fresh shop meant those IDs pointed at nothing, so the
//                  very first bill with a godown on it was REFUSED and the
//                  restore stopped there.
//   bank_accounts  every receipt and payment carries an account ID. Without
//                  them, which bank the money came through was lost — and
//                  with it the bank book and the cash book.
//   stock_moves    the ones no bill made: a transfer between godowns, and
//                  opening stock. A transfer nets to nothing, so the TOTAL
//                  stock still looked right while the godown-wise figures
//                  were quietly wrong — the worst shape a wrong number can
//                  take.
//
// Movements that a bill made are deliberately NOT written here: the bill
// writes them on the way back in, and carrying them as well would count
// everything twice.
export function buildBackup({ org, items, parties, vouchers, lines, payments, expenses,
                              godowns, banks, moves }) {
  const ownMoves = (moves || []).filter((m) => !m.ref_voucher_id);
  return JSON.stringify({
    skwik_backup: BACKUP_VERSION,
    taken_at: new Date().toISOString(),
    firm: org?.name || '',
    counts: {
      items: (items || []).length,
      parties: (parties || []).length,
      vouchers: (vouchers || []).length,
      lines: (lines || []).length,
      payments: (payments || []).length,
      expenses: (expenses || []).length,
      godowns: (godowns || []).length,
      banks: (banks || []).length,
      moves: ownMoves.length,
    },
    org: org || null,
    items: items || [],
    parties: parties || [],
    vouchers: vouchers || [],
    lines: lines || [],
    payments: payments || [],
    expenses: expenses || [],
    godowns: godowns || [],
    banks: banks || [],
    moves: ownMoves,
  }, null, 1);
}

// Read a backup file back in, and say plainly what is in it before a single
// row is written.
export function readBackup(text) {
  let d;
  try { d = JSON.parse(cleanText(text)); }
  catch (e) { return { problem: `That is not a Skwik backup. It begins: ${peek(text, 80)}` }; }

  if (!d || !d.skwik_backup) {
    return { problem: 'That file is not a Skwik backup.' };
  }
  if (d.skwik_backup > BACKUP_VERSION) {
    return { problem: 'That backup was made by a newer version of Skwik than this one.' };
  }
  return {
    problem: null,
    taken_at: d.taken_at || '',
    firm: d.firm || '',
    org: d.org || null,
    items: d.items || [],
    parties: d.parties || [],
    vouchers: d.vouchers || [],
    lines: d.lines || [],
    payments: d.payments || [],
    // absent from a version-1 file, which is still perfectly good
    expenses: d.expenses || [],
    // absent from anything before version 3
    godowns: d.godowns || [],
    banks: d.banks || [],
    moves: d.moves || [],
  };
}

// Turn a backed-up bill back into something save_voucher understands. Its own
// id and number go with it, so the bill comes back as it was and cannot be
// written twice.
//
// EVERYTHING THE BILL CARRIED HAS TO COME BACK.
//
// This list used to stop short: the discount, the freight's tax rate, the
// reverse-charge flag, whether the bill counted as a sale, whether it was
// still good for GST, which godown it came out of, and — on every line — the
// discount share, the batch, the expiry and the cost were all dropped. A
// restored shop was therefore NOT the shop that was backed up, and the
// difference was invisible until a return was filed. If a field is on the
// bill, it is on this list.
export function backupVoucherPayload(v, linesFor) {
  return {
    id: v.id,
    vtype: v.vtype,
    vdate: v.vdate,
    voucher_no: v.voucher_no,
    party_id: v.party_id || null,
    printed_name: v.printed_name,
    is_cash: !!v.is_cash,
    supplier_invoice_no: v.supplier_invoice_no,
    supplier_invoice_date: v.supplier_invoice_date,
    place_of_supply_code: v.place_of_supply_code,
    tax_mode: v.tax_mode,
    taxable: v.taxable, cgst: v.cgst, sgst: v.sgst, igst: v.igst,
    extra_amount: v.extra_amount, extra_note: v.extra_note,
    extra_gst_rate: v.extra_gst_rate ?? 0,
    round_off: v.round_off, total: v.total, notes: v.notes,
    discount: v.discount ?? 0,
    reverse_charge: !!v.reverse_charge,
    counts_as_sale: v.counts_as_sale !== false,
    gst_effective: v.gst_effective !== false,
    godown_id: v.godown_id || null,
    nil_rated: v.nil_rated ?? 0,
    exempt: v.exempt_amt ?? 0,
    non_gst: v.non_gst ?? 0,
    // carried so the restore can put a cancelled bill back as cancelled
    cancelled_at: v.cancelled_at || null,
    cancel_reason: v.cancel_reason || null,
    // a credit note with no link back to its bill is an orphan: the return
    // screen can no longer see what has already come back
    ref_voucher_id: v.ref_voucher_id || null,
    ref_invoice_no: v.ref_invoice_no || null,
    ref_invoice_date: v.ref_invoice_date || null,
    lines: (linesFor || []).map((l) => ({
      item_id: l.item_id, item_name: l.item_name, hsn: l.hsn, unit: l.unit,
      note: l.note || null,
      qty: l.qty, rate: l.rate, gst_rate: l.gst_rate,
      taxable: l.taxable, cgst: l.cgst, sgst: l.sgst, igst: l.igst,
      amount: l.amount, flag: l.flag, checked: l.checked,
      disc: l.disc ?? 0,
      batch: l.batch || null,
      expiry: l.expiry || null,
      cost: l.cost ?? 0,
      supply: l.supply || 'taxable',
      godown_id: l.godown_id || null,
    })),
  };
}


/* ===================== deciding what an import changes ===================== */

// WHAT A FILE ADDS, WHAT IT CHANGES, AND WHAT IT REPEATS.
//
// This used to sit inside the import screen, where it could not be tested on
// its own — and it had a hole in it: the list of names was built from the book
// and never added to while the file was read, so a file naming one item twice
// put TWO items of that name into the shop, with different prices, and the
// biller picked whichever the list happened to show him.
//
// It is a plain function over two lists now, so it can be checked without a
// database, and the screen does nothing but carry out what it decides.

// The fields an UPDATE may touch: the ones the file genuinely carried.
//
// `_has` is the parser's own account of that. Without it — a spreadsheet, or
// a row from an older build — the rule is the only other one available: a
// value that is present is a value the file has, and a blank or a nought is
// the file saying nothing. `name` always goes, because it is what matched.
const ALWAYS = { org_id: 1, name: 1 };
function onlyWhatItKnows(body, row) {
  const has = row && row._has;
  const out = {};
  for (const k of Object.keys(body)) {
    if (ALWAYS[k]) { out[k] = body[k]; continue; }
    const v = body[k];
    const known = has ? !!has[k]
      : !(v === null || v === undefined || v === '' || v === 0);
    if (known) out[k] = v;
  }
  return out;
}

export function planImport({ rows, have, what, orgId }) {
  // THE MATCH THAT NEVER MATCHED.
  //
  // "Names already in the book are updated, new ones are added" — that is
  // what this screen has always promised, and it compared the two names
  // letter for letter, spaces and brackets and all. Tally writes STEEL THALI
  // 10" and the book says Steel Thali 10 inch. Not equal. So the import did
  // not update a single existing item: it added five hundred NEW ones beside
  // them, every one of them carrying the right rate, while the items he
  // actually bills on sat there with their old rates untouched.
  //
  // From the outside that is exactly "no rate list updated" and exactly
  // "ledger figures still wrong" — the opening balances went onto brand new
  // customers, not onto the ones with his bills against them. One cause,
  // both complaints.
  //
  // So a name is now compared the way the rest of this app already compares
  // names: stripped to its letters and digits. Steel Thali 10" and steel
  // thali 10 are the same shelf. An exact match still wins outright, and
  // when two rows in the book strip down to the SAME thing there is no
  // honest way to choose between them, so neither is touched.
  const byName = {}, byTidy = {}, tidyDupe = {};
  for (const r of (have || [])) {
    const raw = String(r.name || '').trim();
    byName[raw.toLowerCase()] = r.id;
    const t = tidy(raw);
    if (!t) continue;
    if (byTidy[t] && byTidy[t] !== r.id) tidyDupe[t] = true;
    else byTidy[t] = r.id;
  }

  const toAdd = [], toUpdate = [], addedAt = {}, updateAt = {};
  let repeated = 0, noState = 0, loose = 0;

  for (const r of (rows || [])) {
    const name = String(r.name || '').trim();
    if (!name) continue;

    const fullBody = what === 'items'
      ? { org_id: orgId, name, alias: r.alias || null, hsn: r.hsn || null,
          unit: r.unit || 'PCS', sale_price: r.sale_price, price2: r.price2,
          purchase_price: r.purchase_price, gst_rate: r.gst_rate,
          opening_stock: r.opening_stock }
      : { org_id: orgId, name, kind: r.kind || 'customer',
          gstin: r.gstin || null, is_registered: !!r.gstin, phone: r.phone || null,
          address: r.address || null,
          // A CUSTOMER WHOSE STATE WE DO NOT KNOW IS NOT FROM HERE.
          //
          // This used to hand every unknown state the shop's own code, so an
          // imported out-of-state customer became a local one and every bill
          // to him was charged CGST and SGST instead of IGST, and went into
          // the wrong table of GSTR-1. Left blank, the bill screen asks for
          // the state before it will save.
          state_code: r.state_code || null,
          state_name: r.state_name || null,
          opening_balance: r.opening_balance || 0,
          opening_type: r.opening_type || 'owes_you' };

    if (what !== 'items' && !fullBody.state_code) noState++;

    const key = name.toLowerCase();
    const t = tidy(name);
    let id = byName[key];
    if (!id && t && byTidy[t] && !tidyDupe[t]) { id = byTidy[t]; loose++; }

    // UPDATING IS NOT THE SAME AS REPLACING.
    //
    // A new row can take every field, blanks and all — there was nothing
    // there to lose. An existing row must only be told what the file
    // actually knows. Anything the file is silent about is left exactly as
    // he set it: his own selling price, his second price, an HSN he looked
    // up by hand. `_has` is the parser saying which of these the file really
    // carried; a parser that says nothing (an older one, or a plain
    // spreadsheet) falls back to "a value that is there is a value it has",
    // which is the same rule written the only other way it can be.
    const body = id ? onlyWhatItKnows(fullBody, r) : fullBody;
    if (id) {
      // A SCAN PER ROW IS A SCAN TOO MANY.
      //
      // This walked the whole list of updates looking for the id every time,
      // so three thousand items meant four and a half million comparisons —
      // the same shape of mistake as the one above, on a smaller scale. Where
      // each one sits is remembered instead.
      const at = updateAt[id];
      if (at !== undefined) { toUpdate[at] = { id, body }; repeated++; }  // named twice in the file
      else { updateAt[id] = toUpdate.length; toUpdate.push({ id, body }); }
    } else if (key in addedAt) {
      toAdd[addedAt[key]] = body;                                 // the later row wins
      repeated++;
    } else {
      addedAt[key] = toAdd.length;
      toAdd.push(body);
    }
  }

  return { toAdd, toUpdate, added: toAdd.length, updated: toUpdate.length,
           repeated, noState, loose };
}



/* ================= EVERYTHING FROM TALLY, IN ONE GO =================
   His own diagnosis, and it was the right one: "All Masters" gives the NAMES
   of the price lists and, very often, not one rate against them — because in
   Tally the price levels are masters of their own and the rates live in the
   Price List report, which is a different export. Six list names arrive,
   every rate is nought, and there is nothing in the file to say why.

   Arguing with Tally about which single export carries everything is a losing
   game: it differs by version, by company settings and by which boxes were
   ticked on the way out. So stop asking for one file. He exports what he
   likes — ledgers, stock items, the price list, as XML or as a spreadsheet —
   picks them all at once, and this works out what each one is and puts them
   together by name.

   Nothing here decides anything. It reads, it merges, and it hands the same
   shape of answer the single-file import already produces, so the sheet he
   confirms from and the code that saves are unchanged.                    */

// What is this file? A file can hold more than one thing, so this counts
// rather than choosing.
export function whatsInIt(text) {
  const t = cleanText(text);
  const excel = excelKind(t);
  if (excel) return { kind: excel, items: 0, parties: 0, rates: 0, levels: [] };
  const table = looksLikeTable(t);
  const xml = !table && sniff(t) === 'xml';
  if (!xml) {
    const rows = table ? tableToRows(t) : parseCsv(t);
    const head = rows[0] || [];
    const cols = mapColumns(head, ['name', 'alias', 'hsn', 'unit', 'sale_price', 'price2',
                                   'purchase_price', 'gst_rate', 'opening_stock',
                                   'gstin', 'phone', 'address', 'state_name',
                                   'opening_balance', 'owed_by']);
    const looksLikeProducts = cols.name !== undefined && (cols.purchase_price !== undefined
      || cols.opening_stock !== undefined || cols.hsn !== undefined
      || cols.unit !== undefined || cols.gst_rate !== undefined);
    // ...and a sheet of customers is not a price list either. Its "Phone"
    // and "Address" columns were being offered to him as price lists to
    // choose between.
    const looksLikeParties = cols.name !== undefined && (cols.gstin !== undefined
      || cols.opening_balance !== undefined || cols.phone !== undefined);
    // and a sheet with no name column at all is nothing we can use, so it
    // must not offer its headings as price lists either
    const rateCols = (looksLikeProducts || looksLikeParties || cols.name === undefined)
      ? [] : rateColumnsOf(head);
    return {
      kind: 'csv',
      // A SHEET OF RATES IS NOT A LIST OF PRODUCTS.
      //
      // "Particulars, Wholesale, Retail" has a name column and something that
      // looks like a price, so it was read as an item list too and created a
      // second copy of everything. A file only counts as products when it
      // carries something only a product master has: a unit, an HSN, a tax
      // rate, a stock figure or what he paid. A price on its own is a price.
      items:   looksLikeProducts ? rows.length - 1 : 0,
      parties: looksLikeParties ? rows.length - 1 : 0,
      rates:   cols.name !== undefined && rateCols.length ? rows.length - 1 : 0,
      levels:  rateCols.map((c) => c.level),
    };
  }
  const items = blocksOf(t, 'STOCKITEM');
  const withRates = items.filter((b) => blocksOf(b, 'FULLPRICELIST.LIST').length
                                     || blocksOf(b, 'STANDARDPRICELIST.LIST').length).length;
  return {
    kind: 'xml',
    items: items.length,
    parties: blocksOf(t, 'LEDGER').length,
    rates: withRates,
    levels: priceLevelsInTally(t),
  };
}

// A SPREADSHEET OF RATES. Tally's Price List report exports to Excel far more
// dependably than it does to XML, so a sheet of "item, wholesale, retail" is
// the shape most shops will actually manage to produce. Every column that is
// not the name and not something we already understand is treated as a price
// list named after its own heading.
const NOT_A_RATE = /^(name|item|particulars?|product|description|alias|also ?called|hsn|sac|unit|uom|per|gst|tax|stock|qty|quantity|opening|closing|value|cost|purchase|sl|s\.?no|serial|group|category)/i;

// WHICH FILE IT IS DECIDES WHAT ITS COLUMNS MEAN — not the headings.
//
// "Wholesale" and "Retail" are price lists on a price list, and the app's own
// first and second price on an item sheet. Judging by the heading alone gets
// one of the two wrong every time: the first try gave an everyday item
// spreadsheet two invented price lists called "Sale price" and "Second
// price", and the selling rate came out as the SECOND price, because with two
// unnamed lists and no dates the last one read wins. The second try fixed
// that and threw away Wholesale and Retail off a real price list.
//
// So the question is asked once, about the FILE. A sheet that carries a unit,
// an HSN, a tax rate, a stock figure or what he paid is a list of products,
// and its price columns are its own. A sheet with none of those is a price
// list, and every column that is not the name is one of his lists.
function rateColumnsOf(head) {
  const out = [];
  (head || []).forEach((h, i) => {
    const t = String(h || '').trim();
    if (!t || NOT_A_RATE.test(t)) return;
    out.push({ at: i, level: t });
  });
  return out;
}

const KNOWN_COLS = ['name', 'alias', 'hsn', 'unit', 'sale_price', 'price2',
  'purchase_price', 'gst_rate', 'opening_stock', 'kind', 'gstin', 'phone',
  'address', 'state_name', 'opening_balance', 'owed_by'];

// name → { level: rate }
export function ratesFromCsv(text) {
  const rows = sheetRows(text);
  if (rows.length < 2) return { rates: {}, levels: [] };
  const cols = mapColumns(rows[0], KNOWN_COLS);
  if (cols.name === undefined) return { rates: {}, levels: [] };
  // a product sheet's own price columns are not price lists — see above
  if (cols.purchase_price !== undefined || cols.opening_stock !== undefined
      || cols.hsn !== undefined || cols.unit !== undefined
      || cols.gst_rate !== undefined || cols.gstin !== undefined
      || cols.opening_balance !== undefined || cols.phone !== undefined) {
    return { rates: {}, levels: [] };
  }
  const rateCols = rateColumnsOf(rows[0]);
  const rates = {};
  for (let i = 1; i < rows.length; i++) {
    const name = cell(rows[i], cols.name);
    if (!name) continue;
    const one = {};
    let any = false;
    for (const c of rateCols) {
      const v = numOf(cell(rows[i], c.at));
      if (v) { one[c.level] = v; any = true; }
    }
    if (any) rates[tidy(name)] = { ...(rates[tidy(name)] || {}), ...one };
  }
  return { rates, levels: rateCols.map((c) => c.level) };
}

// The same, out of any Tally XML that carries price lists on its stock items.
export function ratesFromTallyXml(xml) {
  const t = cleanText(xml);
  const rates = {};
  for (const b of blocksOf(t, 'STOCKITEM')) {
    const name = nameAttr(b) || tagTop(b, 'NAME');
    if (!name) continue;
    const list = ratesOf(b);
    const std = standardRate(b);
    if (!list.length && !std) continue;
    const one = {};
    for (const r of list) {
      const lv = String(r.level || '').trim() || '(standard)';
      // newest date wins, which is what rateAt does for a single level
      if (!one[lv] || (r.date || '') >= (one[lv].date || '')) one[lv] = { rate: r.rate, date: r.date };
    }
    const flat = {};
    for (const k of Object.keys(one)) flat[k] = one[k].rate;
    if (std) flat['(standard)'] = std;
    if (Object.keys(flat).length) rates[tidy(name)] = { ...(rates[tidy(name)] || {}), ...flat };
  }
  return { rates, levels: priceLevelsInTally(t) };
}

// { Wholesale: 120 } → the shape rateAt() reads
const ratesAsList = (obj) => Object.keys(obj || {})
  .filter((k) => k !== '(standard)')
  .map((k) => ({ date: '', level: k, rate: obj[k] }));

// Several files, read and put together.
//
// `files` is [{ name, text }]. Returns everything the sheet needs, in the same
// shape the single-file path produces, plus a line per file saying what was
// found in it — because an import that silently ignored a file he picked is
// how we got here.
export function mergeFiles(files, opts = {}) {
  const notes = [];
  let items = [], parties = [], allRates = {}, levels = [];
  let basisItems = null, basisParties = null, noRateSrc = 0, skipped = 0;

  for (const f of (files || [])) {
    const text = f.text || '';
    const what = whatsInIt(text);

    // A REAL EXCEL FILE, WHICH IS A ZIP, NOT A PAGE OF TEXT.
    // Saying "nothing we could use" about a file he was told to produce is
    // how a morning gets wasted. It says what to do instead.
    if (what.kind === 'xlsx' || what.kind === 'xls') {
      notes.push({ file: f.name || 'a file',
        found: 'an Excel file Skwik cannot open — save it as CSV' });
      continue;
    }

    const isXml = what.kind === 'xml';
    const got = [];

    if (what.items) {
      const r = isXml ? itemsFromTallyXml(text, {}) : itemsFromCsv(text);
      if (r.rows && r.rows.length) {
        items = items.concat(r.rows);
        basisItems = basisItems || r.basis || null;
        got.push(`${r.rows.length} items`);
      }
    }
    if (what.parties) {
      const r = isXml ? partiesFromTallyXml(text) : partiesFromCsv(text);
      if (r.rows && r.rows.length) {
        parties = parties.concat(r.rows);
        basisParties = basisParties || r.basis || null;
        skipped += r.skipped || 0;
        got.push(`${r.rows.length} names`);
      }
    }
    if (what.rates) {
      const r = isXml ? ratesFromTallyXml(text) : ratesFromCsv(text);
      const n = Object.keys(r.rates).length;
      if (n) {
        for (const k of Object.keys(r.rates)) allRates[k] = { ...(allRates[k] || {}), ...r.rates[k] };
        for (const lv of r.levels) if (lv && levels.indexOf(lv) < 0) levels.push(lv);
        got.push(`rates for ${n} products`);
      }
    }
    for (const lv of (what.levels || [])) if (lv && levels.indexOf(lv) < 0) levels.push(lv);

    notes.push({ file: f.name || 'a file', found: got.length ? got.join(', ') : 'nothing we could use' });
  }

  // THE JOIN. Rates from one file, onto items from another, by name — the
  // same forgiving comparison the rest of the import now uses.
  const seen = {};
  const merged = [];
  for (const it of items) {
    const k = tidy(it.name);
    if (seen[k] !== undefined) { merged[seen[k]] = { ...merged[seen[k]], ...it }; continue; }
    seen[k] = merged.length;
    const r = allRates[k];
    merged.push(r ? { ...it, _rates: ratesAsList(r), _std: r['(standard)'] || 0 } : it);
  }
  for (const k of Object.keys(allRates)) {
    if (seen[k] === undefined) noRateSrc++;          // a rate for something we have no item for
  }

  // The same for the names. Items were folded together and names were not, so
  // picking one file twice — or an All Masters export alongside a ledger
  // export, which is a thing anybody might do — counted every customer twice
  // on the sheet. The save would have collapsed them anyway, but a count he
  // cannot trust is a count that frightens him off tapping the button.
  const sawName = {};
  const names = [];
  for (const p2 of parties) {
    const k = tidy(p2.name);
    if (sawName[k] !== undefined) { names[sawName[k]] = { ...names[sawName[k]], ...p2 }; continue; }
    sawName[k] = names.length;
    names.push(p2);
  }
  parties = names;

  const priced = applyPriceLevel(merged, opts.level || '', opts.level2 || '');
  return {
    items: priced, parties, levels, notes,
    basis: basisItems || basisParties || null,
    skipped,
    orphanRates: noRateSrc,
    noRate: priced.filter((x) => !x.sale_price).length,
  };
}

/* ===================== the blank forms ===================== */

export const ITEMS_TEMPLATE =
  'Name,Also called,HSN,Unit,Sale price,Second price,Purchase price,GST rate\n'
  + 'Steel Thali 10 inch,thali plate,7323,PCS,120,135,95,18\n'
  + 'Plastic Bucket 15L,balti bucket,3924,PCS,180,205,140,18\n';

export const PARTIES_TEMPLATE =
  'Name,Customer or supplier,GSTIN,Phone,State code,Address,Opening balance\n'
  + 'Sri Ganesh Store,customer,18AABCS1234F1Z5,9864012345,18,M G Road Jorhat,0\n'
  + 'Bharat Traders,supplier,,9864098765,18,Fancy Bazar Guwahati,2500\n';
