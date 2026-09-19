// BRINGING BOOKS IN, AND SENDING THEM OUT.
//
// Nobody retypes 800 items. A shopkeeper already has them in Tally, or in a
// spreadsheet somebody made for him, and his accountant wants everything back
// in Tally at the end of the month. Both roads are here, and neither of them
// touches the database — these are plain functions over text, so they can be
// read and checked on their own.

import { n2 } from './money';
import { STATES } from './states';

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

// The first hundred or so readable characters, for showing him when we cannot
// make head or tail of a file. Far more use than "could not read that file".
export function peek(raw, n = 120) {
  return cleanText(raw).replace(/\s+/g, ' ').trim().slice(0, n);
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
      unit: (cell(rows[i], cols.unit) || 'PCS').toUpperCase(),
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
  const cols = mapColumns(rows[0], ['name', 'gstin', 'phone', 'address', 'state_name', 'opening_balance']);
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
      opening_balance: Math.abs(money(cell(rows[i], cols.opening_balance))),
      opening_type: money(cell(rows[i], cols.opening_balance)) < 0 ? 'you_owe' : 'owes_you',
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
const tagOf = (chunk, tag) => {
  const m = chunk.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i'));
  return m ? unesc(m[1].trim()) : '';
};

const unesc = (s) => String(s)
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#\d+;/g, ' ')            // Tally's own markers, e.g. &#4;
  .replace(/\s+/g, ' ').trim();

const blocksOf = (xml, tag) => {
  const out = [];
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>[\\s\\S]*?</${tag}>`, 'gi');
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

export function itemsFromTallyXml(xml) {
  xml = cleanText(xml);
  const groups = groupsFromTallyXml(xml);
  const out = [];

  for (const b of blocksOf(xml, 'STOCKITEM')) {
    const name = nameAttr(b) || tagOf(b, 'NAME');
    if (!name) continue;

    const parent = tagOf(b, 'PARENT');
    const hsn = hsnOf(b) || inherited(groups, parent, 'hsn');
    const gst = gstRateOf(b) || inherited(groups, parent, 'gst_rate');

    // The rate he sells at: the newest price level, if he keeps price lists.
    let sale = 0;
    let newest = '';
    for (const pl of blocksOf(b, 'FULLPRICELIST.LIST')) {
      const date = tagOf(pl, 'DATE') || '';
      const rate = numOf(tagOf(pl, 'RATE'));
      if (rate && date >= newest) { sale = rate; newest = date; }
    }

    const cost = numOf(tagOf(b, 'OPENINGRATE'));

    out.push({
      name,
      alias: '',
      hsn,
      unit: (tagOf(b, 'BASEUNITS') || 'PCS').toUpperCase(),
      sale_price: sale || cost,
      price2: 0,
      purchase_price: cost,
      gst_rate: gst,
      opening_stock: numOf(tagOf(b, 'OPENINGBALANCE')),
      group: parent,
    });
  }

  if (out.length) return { rows: out, problem: null };
  return { rows: [], problem: blocksOf(xml, 'LEDGER').length
    ? 'That file holds customers and suppliers, not items. Use it under '
      + '"Customers and suppliers" instead.'
    : `No stock items in that file. It begins: ${peek(xml, 90)}` };
}

export function partiesFromTallyXml(xml) {
  xml = cleanText(xml);
  const out = [];

  for (const b of blocksOf(xml, 'LEDGER')) {
    const name = nameAttr(b) || tagOf(b, 'NAME');
    if (!name) continue;

    const parent = tagOf(b, 'PARENT').toLowerCase();
    // only people who owe money or are owed it — not Sales, Duties, Bank
    if (!/debtor|creditor/.test(parent)) continue;

    const gstin = (tagOf(b, 'PARTYGSTIN') || tagOf(b, 'GSTIN')).toUpperCase().replace(/\s/g, '');
    const code  = gstin.slice(0, 2);
    const bal   = numOf(tagOf(b, 'OPENINGBALANCE'));

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

  if (out.length) return { rows: out, problem: null };
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

/* ===================== the blank forms ===================== */

export const ITEMS_TEMPLATE =
  'Name,Also called,HSN,Unit,Sale price,Second price,Purchase price,GST rate\n'
  + 'Steel Thali 10 inch,thali plate,7323,PCS,120,135,95,18\n'
  + 'Plastic Bucket 15L,balti bucket,3924,PCS,180,205,140,18\n';

export const PARTIES_TEMPLATE =
  'Name,Customer or supplier,GSTIN,Phone,State code,Address,Opening balance\n'
  + 'Sri Ganesh Store,customer,18AABCS1234F1Z5,9864012345,18,M G Road Jorhat,0\n'
  + 'Bharat Traders,supplier,,9864098765,18,Fancy Bazar Guwahati,2500\n';
