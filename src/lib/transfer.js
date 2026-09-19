// BRINGING BOOKS IN, AND SENDING THEM OUT.
//
// Nobody retypes 800 items. A shopkeeper already has them in Tally, or in a
// spreadsheet somebody made for him, and his accountant wants everything back
// in Tally at the end of the month. Both roads are here, and neither of them
// touches the database — these are plain functions over text, so they can be
// read and checked on their own.

import { n2 } from './money';
import { STATES } from './states';
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

export function base64ToBytes(b64) {
  const s = String(b64 || '').replace(/[^A-Za-z0-9+/]/g, '');
  const out = new Uint8Array((s.length * 3) >> 2);
  let o = 0, acc = 0, bits = 0;
  for (let i = 0; i < s.length; i++) {
    acc = (acc << 6) | B64.indexOf(s[i]);
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
  sale_price:     ['saleprice', 'sellingprice', 'rate', 'price', 'mrp', 'sellrate', 'wholesale', 'saleslrate', 'salesrate'],
  price2:         ['price2', 'retail', 'retailprice', 'secondprice', 'rate2'],
  purchase_price: ['purchaseprice', 'costprice', 'cost', 'buyrate', 'purchaserate'],
  gst_rate:       ['gst', 'gstrate', 'taxrate', 'gstpercent', 'rateofgst', 'igstrate'],
  opening_stock:  ['openingstock', 'opening', 'stock', 'qty', 'quantity', 'openingqty'],
  gstin:          ['gstin', 'gstno', 'gstnumber', 'partygstin', 'gst'],
  phone:          ['phone', 'mobile', 'contact', 'phoneno', 'mobileno', 'ledgerphone'],
  address:        ['address', 'add', 'addr'],
  state_name:     ['state', 'statename'],
  opening_balance:['openingbalance', 'balance', 'outstanding', 'due', 'openingbal'],
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

export function itemsFromCsv(text) {
  const rows = parseCsv(text);
  if (rows.length < 2) {
    return { rows: [], problem: `That file has no rows under the headings. `
      + `It begins: ${peek(text, 90)}` };
  }
  const cols = mapColumns(rows[0], ['name', 'alias', 'hsn', 'unit', 'sale_price', 'price2',
                                    'purchase_price', 'gst_rate', 'opening_stock']);
  if (cols.name === undefined) {
    return { rows: [], problem: 'No column looks like the item name. One heading must say Name, Item or Particulars.' };
  }
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const name = cell(rows[i], cols.name);
    if (!name) continue;
    out.push({
      name,
      alias: cell(rows[i], cols.alias),
      hsn: cell(rows[i], cols.hsn).replace(/[^0-9]/g, ''),
      unit: asUqc(cell(rows[i], cols.unit)),
      sale_price: money(cell(rows[i], cols.sale_price)),
      price2: money(cell(rows[i], cols.price2)),
      purchase_price: money(cell(rows[i], cols.purchase_price)),
      gst_rate: money(cell(rows[i], cols.gst_rate)),
      opening_stock: money(cell(rows[i], cols.opening_stock)),
    });
  }
  return { rows: out, problem: null };
}

export function partiesFromCsv(text) {
  const rows = parseCsv(text);
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
      state_code: STATES[code] ? code : '',
      state_name: STATES[code] || cell(rows[i], cols.state_name),
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
  return { rows: out, problem: null };
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
  .replace(/&#\d+;/g, ' ')            // Tally's own markers, e.g. &#4;
  .replace(/\s+/g, ' ').trim();

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
    const name = nameAttr(b) || tagOf(b, 'NAME');
    if (!name) continue;
    map[name.toLowerCase()] = {
      hsn: hsnOf(b),
      gst_rate: gstRateOf(b),
      parent: tagOf(b, 'PARENT'),
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
function balanceOf(block) {
  const cl = tagOf(block, 'CLOSINGBALANCE');
  if (cl !== '') return { value: numOf(cl), basis: 'closing' };
  return { value: numOf(tagOf(block, 'OPENINGBALANCE')), basis: 'opening' };
}

// Every price level named anywhere in the file. A shop that keeps a wholesale
// list and a retail list has two; most have none.
export function priceLevelsInTally(xml) {
  const out = [];
  const re = /<PRICELEVEL>([\s\S]*?)<\/PRICELEVEL>/gi;
  let m;
  while ((m = re.exec(cleanText(xml)))) {
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
  const any = newest(rates);
  return any ? any.rate : 0;
}

export function itemsFromTallyXml(xml, opts = {}) {
  xml = cleanText(xml);
  const groups = groupsFromTallyXml(xml);
  const out = [];
  let sawClosing = false, sawOpening = false;

  for (const b of blocksOf(xml, 'STOCKITEM')) {
    const name = nameAttr(b) || tagOf(b, 'NAME');
    if (!name) continue;

    const parent = tagOf(b, 'PARENT');
    const hsn = hsnOf(b) || inherited(groups, parent, 'hsn');
    const gst = gstRateOf(b) || inherited(groups, parent, 'gst_rate');

    // The rate he sells at, off the price level he picked.
    const rates = ratesOf(b);
    const sale  = rateAt(rates, opts.level);
    const two   = opts.level2 ? rateAt(rates, opts.level2) : 0;

    const cost = numOf(tagOf(b, 'OPENINGRATE'));
    const bal  = balanceOf(b);
    if (bal.basis === 'closing') sawClosing = true; else sawOpening = true;

    out.push({
      name,
      alias: '',
      hsn,
      unit: asUqc(tagOf(b, 'BASEUNITS')),
      sale_price: sale || cost,
      price2: two,
      purchase_price: cost,
      gst_rate: gst,
      opening_stock: bal.value,
      group: parent,
    });
  }

  if (out.length) {
    return { rows: out, problem: null,
             levels: priceLevelsInTally(xml),
             basis: sawClosing && !sawOpening ? 'closing'
                  : sawClosing ? 'mixed' : 'opening' };
  }
  return { rows: [], problem: blocksOf(xml, 'LEDGER').length
    ? 'That file holds customers and suppliers, not items. Use it under '
      + '"Customers and suppliers" instead.'
    : `No stock items in that file. It begins: ${peek(xml, 90)}` };
}

export function partiesFromTallyXml(xml) {
  xml = cleanText(xml);
  const out = [];
  let sawClosing = false, sawOpening = false;

  for (const b of blocksOf(xml, 'LEDGER')) {
    const name = nameAttr(b) || tagOf(b, 'NAME');
    if (!name) continue;

    const parent = tagOf(b, 'PARENT').toLowerCase();
    // only people who owe money or are owed it — not Sales, Duties, Bank
    if (!/debtor|creditor/.test(parent)) continue;

    const gstin = (tagOf(b, 'PARTYGSTIN') || tagOf(b, 'GSTIN')).toUpperCase().replace(/\s/g, '');
    const code  = gstin.slice(0, 2);
    const b2    = balanceOf(b);
    const bal   = b2.value;
    if (b2.basis === 'closing') sawClosing = true; else sawOpening = true;

    out.push({
      name,
      kind: /creditor/.test(parent) ? 'supplier' : 'customer',
      gstin: gstin.length === 15 ? gstin : '',
      phone: String(tagOf(b, 'LEDGERPHONE') || tagOf(b, 'LEDGERMOBILE')).replace(/[^0-9]/g, '').slice(-10),
      address: tagOf(b, 'ADDRESS'),
      state_code: STATES[code] ? code : '',
      state_name: STATES[code] || tagOf(b, 'LEDSTATENAME') || tagOf(b, 'STATENAME'),
      // Tally writes what a customer owes you as a negative opening balance
      opening_balance: Math.abs(bal),
      opening_type: bal > 0 ? 'you_owe' : 'owes_you',
    });
  }

  if (out.length) {
    return { rows: out, problem: null,
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

/* ===================== out, as Tally XML ===================== */

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

const tallyDate = (d) => String(d || '').replace(/-/g, '');   // 2026-09-19 -> 20260919
const amt = (x) => n2(x).toFixed(2);

// One voucher. In Tally a negative amount is a debit and a positive one is a
// credit, and every voucher must come to zero.
function voucherXml({ v, lines, org }) {
  const buy   = v.vtype === 'purchase';
  const party = v.parties?.name || v.printed_name || 'Cash';
  const kind  = buy ? 'Purchase' : 'Sales';
  const main  = buy ? (org.purchase_ledger || 'Purchase') : (org.sales_ledger || 'Sales');
  const total = n2(v.total);

  // the party side: on a sale he owes us (debit), on a purchase we owe him (credit)
  const partySide = buy
    ? `<ALLLEDGERENTRIES.LIST><LEDGERNAME>${esc(party)}</LEDGERNAME>`
      + `<ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>${amt(total)}</AMOUNT></ALLLEDGERENTRIES.LIST>`
    : `<ALLLEDGERENTRIES.LIST><LEDGERNAME>${esc(party)}</LEDGERNAME>`
      + `<ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>-${amt(total)}</AMOUNT></ALLLEDGERENTRIES.LIST>`;

  const sign = buy ? '-' : '';          // purchase: the expense side is a debit
  const pos  = buy ? 'Yes' : 'No';

  const inventory = lines.map((l) => `
      <ALLINVENTORYENTRIES.LIST>
        <STOCKITEMNAME>${esc(l.item_name)}</STOCKITEMNAME>
        <ISDEEMEDPOSITIVE>${pos}</ISDEEMEDPOSITIVE>
        <RATE>${amt(l.rate)}/${esc(l.unit || 'PCS')}</RATE>
        <ACTUALQTY>${Number(l.qty)} ${esc(l.unit || 'PCS')}</ACTUALQTY>
        <BILLEDQTY>${Number(l.qty)} ${esc(l.unit || 'PCS')}</BILLEDQTY>
        <AMOUNT>${sign}${amt(l.taxable)}</AMOUNT>
        <ACCOUNTINGALLOCATIONS.LIST>
          <LEDGERNAME>${esc(main)}</LEDGERNAME>
          <ISDEEMEDPOSITIVE>${pos}</ISDEEMEDPOSITIVE>
          <AMOUNT>${sign}${amt(l.taxable)}</AMOUNT>
        </ACCOUNTINGALLOCATIONS.LIST>
      </ALLINVENTORYENTRIES.LIST>`).join('');

  const taxLine = (name, value) => (!value ? '' : `
      <ALLLEDGERENTRIES.LIST>
        <LEDGERNAME>${esc(name)}</LEDGERNAME>
        <ISDEEMEDPOSITIVE>${pos}</ISDEEMEDPOSITIVE>
        <AMOUNT>${sign}${amt(value)}</AMOUNT>
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
  const body = vouchers
    .filter((v) => v.vtype === 'sale' || v.vtype === 'purchase')
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

export const BACKUP_VERSION = 1;

export function buildBackup({ org, items, parties, vouchers, lines, payments }) {
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
    },
    org: org || null,
    items: items || [],
    parties: parties || [],
    vouchers: vouchers || [],
    lines: lines || [],
    payments: payments || [],
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
  };
}

// Turn a backed-up bill back into something save_voucher understands. Its own
// id and number go with it, so the bill comes back as it was and cannot be
// written twice.
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
    round_off: v.round_off, total: v.total, notes: v.notes,
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
    })),
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
