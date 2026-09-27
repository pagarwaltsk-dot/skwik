// THE DAY BOOK, NOT JUST THE MASTERS.
//
// Skwik could already read a Tally file and take the ITEMS and the NAMES out
// of it. What it could never do is read what actually HAPPENED — the bills,
// the money in and out, the goods carried between stores. So a shopkeeper
// moving across arrived with an empty book: every customer in the list,
// every item priced, and not one rupee of history behind any of it. No
// ledger, no outstanding, no idea what he sold last month.
//
// This reads the rest.
//
// IT USES THE SAME TAG READER AS THE MASTERS DO. There is one importer in
// Skwik, not two; the primitives live in transfer.js and are imported here
// rather than written again, so a fix to either side fixes both.
//
// ---------------------------------------------------------------------------
//  WHAT A REAL TALLY FILE LOOKS LIKE, AS OPPOSED TO A TIDY ONE
// ---------------------------------------------------------------------------
//
// Every assumption below was checked against a real shop's export — 190
// vouchers, 185 stock items, 72 ledgers, 5 stores, nine years of dates — and
// several of the obvious assumptions turned out to be wrong.
//
// THE VOUCHER TYPE IS NOT ITS NAME. His purchases are on a voucher type
// called "New Purchase" and his transfers on one called "Transfer". Both are
// custom types. Matching on the name works on his file and fails on the next
// shop's. What never changes is the PARENT — the built-in type it was made
// from — so the parent is what decides, and the name is only ever shown.
//
// THE MONEY LIVES IN ONE LIST AND THE GOODS IN ANOTHER, and which list
// depends on the kind. A sale carries ALLINVENTORYENTRIES (the goods) and
// LEDGERENTRIES (the party, the tax, the round off). A receipt carries
// ALLLEDGERENTRIES and no goods at all. A stock journal carries
// INVENTORYENTRIESIN and INVENTORYENTRIESOUT and no money.
//
// THE RATE AND THE HSN ARE ON THE LINE. Nothing has to be inferred from the
// tax amounts: each inventory entry carries its own GSTRATEDUTYHEAD blocks
// (CGST 9, SGST 9, IGST 18) and its own GSTHSNNAME. The item masters, oddly,
// often carry neither.
//
// A SIGN IN TALLY IS NOT A SIGN IN SKWIK. Tally writes a sale's party leg
// negative and its tax legs positive; a stock journal writes its in-leg
// negative. Every figure is taken as an absolute and the DIRECTION is decided
// by which list it came out of, because that is the thing that cannot be
// written the wrong way round.
//
// ONE BILL CAN DRAW FROM TWO STORES. His invoice 1380 takes goods from
// Chamber Road and from Na-Paukhry on the same document, so the store belongs
// to the LINE and not to the bill.

import {
  blocksOf, nameAttr, numOf, qtyOf, tagOf, tagTop, unesc,
} from './transfer';

/* ===================== what each Tally kind becomes ===================== */

// Keyed by the PARENT of the voucher type, which is the built-in kind. The
// value is what Skwik calls it. Anything not here is carried through as a
// skip with its own reason, never silently dropped.
export const FROM_PARENT = {
  'sales':          { kind: 'voucher', vtype: 'sale' },
  'purchase':       { kind: 'voucher', vtype: 'purchase' },
  'credit note':    { kind: 'voucher', vtype: 'sale_return' },
  'debit note':     { kind: 'voucher', vtype: 'purchase_return' },
  'receipt':        { kind: 'payment', ptype: 'receipt' },
  'payment':        { kind: 'payment', ptype: 'payment' },
  'stock journal':  { kind: 'transfer' },
  // Contra moves money between the till and the bank. Skwik has no such entry
  // — the cash book and the bank book are both built from receipts and
  // payments — so it is named rather than guessed at.
  'contra':         { kind: 'skip', why: 'moves money between cash and bank' },
  // A journal is whatever an accountant needed it to be. Importing one blind
  // would put a figure somewhere it does not belong.
  'journal':        { kind: 'skip', why: 'a general journal entry' },
  'delivery note':  { kind: 'skip', why: 'goods sent, not a bill' },
  'receipt note':   { kind: 'skip', why: 'goods received, not a bill' },
  'sales order':    { kind: 'skip', why: 'an order, not a bill' },
  'purchase order': { kind: 'skip', why: 'an order, not a bill' },
  'physical stock': { kind: 'count' },
};

// The tax ledgers, known by what they are rather than by what they are named,
// because a shop may call its ledger "Output CGST" or "CGST 9%" or just
// "CGST". Matched on the whole name so "Round Off" never reads as an IGST.
const TAXES = [
  { head: 'cgst', re: /\bc\.?gst\b|\bcentral\s*tax\b/i },
  { head: 'sgst', re: /\bs\.?gst\b|\butgst\b|\bstate\s*tax\b/i },
  { head: 'igst', re: /\bi\.?gst\b|\bintegrated\s*tax\b/i },
  { head: 'cess', re: /\bcess\b/i },
  { head: 'round', re: /round\s*off|rounding/i },
];

const taxHead = (name) => {
  const n = String(name || '');
  // ROUND OFF FIRST, because a ledger called "Round Off (GST)" would
  // otherwise be read as a tax and thrown into the CGST column.
  for (const t of [TAXES[4], ...TAXES.slice(0, 4)]) if (t.re.test(n)) return t.head;
  return null;
};

/* ===================== who each ledger is ===================== */

// A NAME IS A GUESS; A GROUP IS A FACT.
//
// His bank is called "Cash Credit Account Fedral Bank". Any rule that decides
// cash-or-bank by looking for the word "cash" puts every one of his 74
// receipts in the till, and his cash book and bank book are then both wrong
// for ever. A cash credit account is an overdraft facility AT a bank, and the
// only thing in the file that says so is the group it sits under.
//
// Tally files every ledger under a group, and the groups are the built-in
// ones: Sundry Debtors, Sundry Creditors, Cash-in-hand, Bank Accounts,
// Duties & Taxes. Those answer, without guessing, which leg of a receipt is
// the money, whether a party is a customer or a supplier, and which ledgers
// are tax rather than a customer who happens to have GST in his name.
export function ledgersIn(xml) {
  const out = {};
  for (const b of blocksOf(xml, 'LEDGER')) {
    const name = nameAttr(b) || tagTop(b, 'NAME');
    if (!name) continue;
    const parent = tagTop(b, 'PARENT') || '';
    out[name.toLowerCase()] = {
      name, parent,
      role: roleOfGroup(parent),
      gstin: tagOf(b, 'PARTYGSTIN') || tagOf(b, 'GSTIN') || '',
      state: tagTop(b, 'LEDSTATENAME') || '',
    };
  }
  return out;
}

const roleOfGroup = (group) => {
  const g = String(group || '');
  if (/^cash-?in-?hand$/i.test(g.replace(/\s+/g, ''))
      || /\bcash\s*in\s*hand\b/i.test(g)) return 'cash';
  if (/\bbank\b/i.test(g)) return 'bank';              // Bank Accounts, Bank OD A/c, Bank OCC A/c
  if (/duties\s*&?\s*(amp;)?\s*taxes/i.test(g)) return 'tax';
  if (/sundry\s*debtors/i.test(g)) return 'customer';
  if (/sundry\s*creditors/i.test(g)) return 'supplier';
  if (/sales\s*account/i.test(g)) return 'sales';
  if (/purchase\s*account/i.test(g)) return 'purchase';
  return 'other';
};

const isMoney = (role) => role === 'cash' || role === 'bank';

/* ===================== dates ===================== */

// Tally writes YYYYMMDD and nothing else, but a file that has been through a
// spreadsheet on the way here may not. ISO and the bare eight digits are the
// two that actually turn up.
export const tallyDate = (v) => {
  const t = String(v || '').trim();
  let m = t.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = t.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) {
    const mm = Number(m[2]), dd = Number(m[3]);
    if (mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31) return `${m[1]}-${m[2]}-${m[3]}`;
  }
  return '';
};

/* ===================== the pieces of a voucher ===================== */

// READING THE TOP LEVEL OF SOMETHING THAT IS ITSELF A LIST.
//
// tagTop takes a block, throws away every <SOMETHING.LIST> inside it, and
// then looks for the tag — which is what keeps a customer's ledger balance
// from being read out of one of his outstanding bills. But an inventory entry
// IS a <ALLINVENTORYENTRIES.LIST>, so handing it to tagTop threw the entire
// entry away and every bill came back with no goods on it. Measured: all 57
// of his sales read as empty.
//
// So the outer wrapper comes off first, and what is left — the entry's own
// tags, with its nested batch and tax lists still to be stripped — is what
// tagTop is given.
const innerOf = (block) => String(block)
  .replace(/^\s*<[A-Za-z0-9_.]+(?:\s[^>]*)?>/, '')
  .replace(/<\/[A-Za-z0-9_.]+>\s*$/, '');

const top = (block, tag) => tagTop(innerOf(block), tag);

// THE UNIT IS INSIDE THE QUANTITY STRING. Tally writes " 18.00 Doz" and
// "120 Pc", so the unit comes off the same tag the number does. It is kept
// as Tally spelled it and matched to a UQC later, by the caller, which knows
// what the item is already using.
const unitOf = (s) => {
  const t = String(s || '').trim();
  const m = t.match(/[\d.,]\s*([A-Za-z][A-Za-z.%/ ]*)$/);
  return m ? m[1].trim() : '';
};

// The rate is written "126.24/Doz". The number is the rate PER THAT UNIT, and
// the quantity is in the same unit, so the two multiply straight out.
const lineOf = (block) => {
  const qtyText = top(block, 'ACTUALQTY') || top(block, 'BILLEDQTY');
  const rateText = top(block, 'RATE');
  const qty = Math.abs(qtyOf(qtyText));
  const amount = Math.abs(numOf(top(block, 'AMOUNT')));
  const shown = Math.abs(numOf(rateText));
  // THE AMOUNT IS THE FACT; THE RATE IS A DISPLAY OF IT.
  //
  // Tally writes the rate to two decimals. On his bill ALI26-I-00396, 1,440
  // pieces at a true 6.045 print as "6.05/Pc" — and 1,440 x 6.05 is 8,712
  // against an amount of 8,704.80. Storing the printed rate puts every such
  // bill seven rupees above what the supplier actually charged, and the bill
  // then never ties again. Where the two disagree by more than a rounding,
  // the rate is worked back out of the amount, which is the figure the bill
  // was added up from.
  const rate = (qty && Math.abs(qty * shown - amount) > 0.5) ? amount / qty : shown;
  return {
    item_name: top(block, 'STOCKITEMNAME'),
    qty,
    unit:  unitOf(qtyText),
    rate,
    amount,
    godown: tagOf(block, 'GODOWNNAME'),
    batch:  (() => {
      const b = tagOf(block, 'BATCHNAME');
      // Tally gives everything a batch whether the shop keeps them or not.
      // "Primary Batch" is its word for "no batch at all".
      return /^primary batch$/i.test(b) ? '' : b;
    })(),
    hsn: tagOf(block, 'GSTHSNNAME') || tagOf(block, 'HSNCODE') || '',
    gst_rate: rateOnLine(block),
  };
};

// THE RATE ON THE LINE, PREFERRING THE WHOLE ONE.
//
// Each line carries a duty head per tax: CGST 9, SGST 9, IGST 18. The whole
// rate is the IGST figure, or CGST and SGST added together — never CGST
// alone, which is half of it and the commonest way to import every bill at
// half the tax it was raised at.
const rateOnLine = (block) => {
  let igst = null, cgst = 0, sgst = 0;
  const re = /<GSTRATEDUTYHEAD>([\s\S]*?)<\/GSTRATEDUTYHEAD>([\s\S]*?)(?=<GSTRATEDUTYHEAD>|$)/gi;
  let m;
  while ((m = re.exec(block))) {
    const head = unesc(m[1]).toUpperCase();
    const hit = m[2].match(/<GSTRATE>([\s\S]*?)<\/GSTRATE>/i);
    if (!hit) continue;
    const v = numOf(hit[1]);
    if (head.startsWith('IGST')) igst = v;
    else if (head.startsWith('CGST')) cgst = v;
    else if (head.startsWith('SGST') || head.startsWith('UTGST')) sgst = v;
  }
  if (igst !== null && igst > 0) return igst;
  return cgst + sgst;
};

/* ===================== one voucher ===================== */

function readVoucher(block, types, leds) {
  const typeName = tagTop(block, 'VOUCHERTYPENAME') || nameAttr(block);
  const parent = (types[typeName.toLowerCase()] || typeName).toLowerCase();
  const map = FROM_PARENT[parent];
  // A bill going OUT -- a sale or a credit note. On those, and only those, the
  // consignee is the customer rather than the shop.
  const outward = !!map && (map.vtype === 'sale' || map.vtype === 'sale_return');

  const v = {
    tally_type: typeName,
    parent,
    vdate: tallyDate(tagTop(block, 'DATE')),
    no: tagTop(block, 'VOUCHERNUMBER'),
    party: tagTop(block, 'PARTYLEDGERNAME') || tagTop(block, 'PARTYNAME'),
    narration: tagTop(block, 'NARRATION'),

    // WHO THE OTHER MAN IS, AND WHERE HE IS.
    //
    // This was not read at all, and the consequence was not small. Every name
    // an import created was given the SHOP's own state and no GST number, so
    // his fourteen Delhi suppliers were filed as Assam -- and a supplier with
    // no GST number cannot have charged any, which is why the next purchase he
    // passed to one of them took no tax. One missing tag, and his input credit
    // stopped working.
    //
    // ON A PURCHASE, THE CONSIGNEE IS THE SHOP.
    //
    // The first try here read PARTYGSTIN or, failing that, CONSIGNEEGSTIN. On
    // his purchase 47126-004553 there is no PARTYGSTIN and the CONSIGNEEGSTIN
    // is 18AHXPA8555E1ZX -- his OWN registration, because on a bill he has
    // received the goods were consigned to him. That read would have written
    // his own GST number onto his transporter and filed a Maharashtra supplier
    // in Assam, which is the very fault being fixed, arriving by another door.
    //
    // So the consignee is only the other man on a bill going OUT. On one
    // coming in, the party's own tag is the only one that can be trusted, and
    // the state is read from STATENAME -- which Tally does write for the
    // supplier, and which is the only thing on five of his Maharashtra
    // purchases that says where they are from.
    //
    // CMPGSTIN is carried too, so the writer can refuse any number that turns
    // out to be the shop's own however it arrived.
    party_gstin: tagTop(block, 'PARTYGSTIN')
      || (outward ? tagTop(block, 'CONSIGNEEGSTIN') : ''),
    party_state: tagTop(block, 'STATENAME')
      || (outward ? tagTop(block, 'CONSIGNEESTATENAME') : ''),
    own_gstin: tagTop(block, 'CMPGSTIN'),
    // Place of supply decides which tax a bill carries, and GSTR-1 asks for it
    // by name. Not one imported bill had it.
    place_of_supply: tagTop(block, 'PLACEOFSUPPLY'),
    // Tally's own id for the voucher. Carried so the same file imported twice
    // cannot write the same bill twice.
    ref: tagTop(block, 'GUID') || tagTop(block, 'REMOTEID') || '',
    cancelled: /^yes$/i.test(tagTop(block, 'ISCANCELLED'))
            || /^yes$/i.test(tagTop(block, 'ISDELETED')),
  };

  if (!map) return { ...v, kind: 'skip', why: `a ${typeName || 'voucher'} Skwik has no place for` };
  if (map.kind === 'skip') return { ...v, kind: 'skip', why: map.why };

  if (map.kind === 'transfer') return readTransfer(block, v);
  if (map.kind === 'payment')  return readPayment(block, v, map.ptype, leds);
  if (map.kind === 'count')    return readCount(block, v);
  return readBill(block, v, map.vtype, leds);
}

// A BILL: goods in one list, money in another.
function readBill(block, v, vtype, leds) {
  // A CASH SALE HAS NO DEBTOR.
  //
  // Tally names the cash ledger as the party on a counter sale, so "Cash"
  // came through as a customer — and with his file that customer owed
  // 2,23,844.96, which would have sat at the top of his Udhar list as the man
  // who owes him most. Nobody owes it; it was paid across the counter.
  //
  // The ledger's group says so: a party filed under Cash-in-hand or a Bank
  // group is not a person at all, it is where the money went. The bill is
  // marked paid, and no name is attached to it.
  const partyRole = ((leds && leds[String(v.party).toLowerCase()]) || {}).role;
  const paidOver = isMoney(partyRole);
  // A LINE WITH NO QUANTITY IS NOT A LINE OF GOODS.
  //
  // Tally lets a charge be loaded onto a stock item so it lands in that
  // item's cost — freight, most often. It comes through as an inventory entry
  // with an amount, a store, and NO quantity at all, and its accounting
  // allocation names the charge rather than Purchases. Twenty-seven of his
  // purchase lines are exactly this, all of them freight on Steel Utensils.
  //
  // Read as goods it would put a 3,340-rupee line for nothing on the bill and
  // move no stock. So it is taken out of the goods and added to the charges,
  // where it already belonged — the bill still comes to the same figure.
  const entries = blocksOf(block, 'ALLINVENTORYENTRIES.LIST').map((b) => ({
    line: lineOf(b), ledger: tagOf(b, 'LEDGERNAME'),
  })).filter((e) => e.line.item_name);
  const lines = entries.filter((e) => e.line.qty > 0).map((e) => e.line);
  const loaded = entries.filter((e) => e.line.qty <= 0);

  let cgst = 0, sgst = 0, igst = 0, cess = 0, freight = 0, party = 0;
  // Kept SIGNED, because the sign is the only thing that says which side of
  // the bill these sit on. See the note under roundSign.
  let roundRaw = 0, taxRaw = 0, partyRaw = 0;
  const others = [];
  for (const b of blocksOf(block, 'LEDGERENTRIES.LIST')) {
    const name = top(b, 'LEDGERNAME');
    const amt = numOf(top(b, 'AMOUNT'));
    if (!name) continue;
    // A CUSTOMER CALLED "GST TRADERS" IS NOT A TAX LEDGER. The group says
    // what a ledger is; the name only says what it is called. The name test
    // is kept for a file with no ledger masters in it.
    const role = (leds && leds[name.toLowerCase()] || {}).role;
    const head = (role && role !== 'tax' && role !== 'other') ? null : taxHead(name);
    if (head === 'cgst') { cgst += Math.abs(amt); if (!taxRaw) taxRaw = amt; continue; }
    if (head === 'sgst') { sgst += Math.abs(amt); if (!taxRaw) taxRaw = amt; continue; }
    if (head === 'igst') { igst += Math.abs(amt); if (!taxRaw) taxRaw = amt; continue; }
    if (head === 'cess') { cess += Math.abs(amt); if (!taxRaw) taxRaw = amt; continue; }
    if (head === 'round') { roundRaw += amt; continue; }
    // THE PARTY'S OWN LEG is the bill total, not a charge on it, so it comes
    // out here and the total is rebuilt from the pieces instead of trusted.
    if (v.party && name.toLowerCase() === v.party.toLowerCase()) {
      party += Math.abs(amt); if (!partyRaw) partyRaw = amt; continue;
    }
    if (/freight|transport|cartage|coolie|loading/i.test(name)) { freight += Math.abs(amt); continue; }
    others.push({ name, amount: amt });
  }

  // TWENTY PAISE, THE WRONG WAY ROUND, ON EVERY PURCHASE.
  //
  // Round off is the one figure on a bill that is meaningfully plus or minus,
  // so unlike the taxes it cannot simply be taken as an absolute. But its
  // sign in the file is written relative to the SIDE of the voucher, and a
  // purchase is the mirror of a sale: on his bill 083 Tally writes the
  // supplier at +43438.00, the IGST at -2068.50 and the round off at +0.50 —
  // and the bill really comes to 41370 + 2068.50 - 0.50. Read as written, the
  // round off was added when it should have been taken off, and six of his
  // ninety bills came out a rupee adrift.
  //
  // The tax legs are the reference: whichever way they are written is the
  // "charges" side, and the round off is a charge. With no tax on the bill at
  // all the party's own leg answers it instead, since it always faces the
  // other way. With neither, it is left exactly as Tally wrote it.
  const roundSign = taxRaw ? Math.sign(taxRaw)
                  : partyRaw ? -Math.sign(partyRaw)
                  : 1;
  const round = roundRaw * roundSign;

  // the charges that were riding on a stock item
  //
  // AND WHAT RATE THEY CARRY, which was thrown away. Sixteen of his purchases
  // ARE one of these and nothing else -- a transporter's bill booked against
  // Steel Utensils, an amount and no quantity -- and they came in with the
  // charge but with no tax rate on it, so the credit on his freight was worth
  // nothing on a return.
  //
  // Several of them are also reverse charge, and the file says so in the
  // ledger's own name: "Transport Freight Interstate & R.Charge", with the
  // party's leg equal to the bill and no tax ledger anywhere on it. That is
  // the tax he owes himself, so the bill is marked for it rather than read as
  // a bill with no tax.
  let chargeRate = 0, rcm = false;
  for (const e of loaded) {
    if (!chargeRate) chargeRate = e.line.gst_rate || 0;
    if (/\br\.?\s*charge\b|reverse\s*charge|\brcm\b/i.test(e.ledger)) rcm = true;
    if (/freight|transport|cartage|coolie|loading/i.test(e.ledger)) freight += e.line.amount;
    else others.push({ name: e.ledger || e.line.item_name, amount: e.line.amount, on_item: e.line.item_name });
  }
  for (const o of others) {
    if (/\br\.?\s*charge\b|reverse\s*charge|\brcm\b/i.test(o.name)) rcm = true;
  }

  const goods = lines.reduce((t, l) => t + (l.amount || l.qty * l.rate), 0);
  const carried = others.filter((x) => x.on_item).reduce((t, x) => t + x.amount, 0);
  return {
    ...v, kind: 'voucher', vtype, lines,
    party: paidOver ? '' : v.party,
    is_cash: paidOver,
    paid_into: paidOver ? v.party : '',
    taxable: round2(goods),
    cgst: round2(cgst), sgst: round2(sgst), igst: round2(igst), cess: round2(cess),
    freight: round2(freight), round_off: round2(round),
    // ONE FIGURE FOR EVERYTHING RIDING ON THE BILL that is not goods, because
    // that is what Skwik has a place for: freight, and any other charge loaded
    // onto a stock item. `total` has always counted both; nothing stored the
    // second one, so a bill carrying one did not add up to itself.
    charge: round2(freight + carried),
    charge_rate: chargeRate,
    reverse_charge: rcm,
    // What Tally says the bill came to, kept beside what the pieces add up
    // to, so the check can tell him when they disagree instead of quietly
    // preferring one.
    tally_total: round2(party),
    total: round2(goods + carried + cgst + sgst + igst + cess + freight + round),
    others,
  };
}

// MONEY, WITH NO GOODS ANYWHERE NEAR IT.
//
// A receipt has two legs: the party, and where the money landed. Which is
// which cannot be read off the sign, because Tally's sign depends on the
// voucher kind — so the party is the one named on the voucher header and the
// other leg is the till or the bank.
function readPayment(block, v, ptype, leds) {
  const legs = blocksOf(block, 'ALLLEDGERENTRIES.LIST').map((b) => ({
    name: top(b, 'LEDGERNAME'),
    amt: Math.abs(numOf(top(b, 'AMOUNT'))),
  })).filter((l) => l.name);

  const roleOf = (n) => ((leds && leds[String(n).toLowerCase()]) || {}).role || '';

  // WHICH LEG IS THE MONEY IS NOT WHICH LEG TALLY NAMED FIRST.
  //
  // On a receipt Tally usually names the customer on the header; on a payment
  // it may name the bank instead. One of his payments came out as "Cash
  // Credit Account Fedral Bank paid 16,500 via Mr Harsa Gowala" — the two
  // legs the wrong way round, because the header was trusted.
  //
  // The money leg is the one filed under Cash-in-hand or a Bank group. That
  // is true whichever way the voucher was typed, so it is what decides, and
  // the header is only the fallback for a file with no ledger masters.
  const money = legs.find((l) => isMoney(roleOf(l.name)));
  const other = legs.find((l) => l !== money);

  let account = money ? money.name : '';
  let party = other ? other.name : '';
  let mode = money ? (roleOf(money.name) === 'cash' ? 'cash' : 'bank') : '';

  if (!money) {
    // no masters to go on: fall back to the header, and to the old habit of
    // reading the name — said plainly rather than pretended to be certain
    party = v.party || (legs[0] && legs[0].name) || '';
    const rest = legs.find((l) => l.name.toLowerCase() !== party.toLowerCase());
    account = rest ? rest.name : '';
    mode = /^cash$|^cash\s*in\s*hand$|^petty\s*cash$/i.test(account.trim()) ? 'cash' : 'bank';
  }

  const partyLeg = legs.find((l) => l.name.toLowerCase() === String(party).toLowerCase());
  const amount = partyLeg ? partyLeg.amt
               : money ? money.amt
               : legs.reduce((t, l) => Math.max(t, l.amt), 0);

  return {
    ...v, kind: 'payment', ptype, party,
    amount: round2(amount), account, mode,
    party_role: roleOf(party),
  };
}

// GOODS MOVED, AND NOTHING ELSE.
//
// The in-list and the out-list each carry their own store, and the header
// names the destination. Tally writes the in-leg's amounts negative; the
// direction is taken from which list a line came out of, never from the sign.
function readTransfer(block, v) {
  const inn = blocksOf(block, 'INVENTORYENTRIESIN.LIST').map(lineOf).filter((l) => l.item_name);
  const out = blocksOf(block, 'INVENTORYENTRIESOUT.LIST').map(lineOf).filter((l) => l.item_name);
  const dest = tagTop(block, 'DESTINATIONGODOWN');
  return {
    ...v, kind: 'transfer',
    to: dest || (inn[0] && inn[0].godown) || '',
    from: (out[0] && out[0].godown) || '',
    lines: inn.map((l) => ({
      item_name: l.item_name, qty: l.qty, unit: l.unit, batch: l.batch,
      // the store it left, matched by item so a transfer that draws one item
      // from one store and another from a second still lands right
      from: (out.find((o) => o.item_name === l.item_name) || {}).godown || '',
      to: l.godown || dest,
    })),
  };
}

// A PHYSICAL STOCK VOUCHER IS A COUNT, which is exactly the entry Skwik
// gained in 1.9.43, so it comes across as one.
function readCount(block, v) {
  // A LINE WITH NO QUANTITY IS NOT A LINE OF GOODS.
  //
  // Tally lets a charge be loaded onto a stock item so it lands in that
  // item's cost — freight, most often. It comes through as an inventory entry
  // with an amount, a store, and NO quantity at all, and its accounting
  // allocation names the charge rather than Purchases. Twenty-seven of his
  // purchase lines are exactly this, all of them freight on Steel Utensils.
  //
  // Read as goods it would put a 3,340-rupee line for nothing on the bill and
  // move no stock. So it is taken out of the goods and added to the charges,
  // where it already belonged — the bill still comes to the same figure.
  const entries = blocksOf(block, 'ALLINVENTORYENTRIES.LIST').map((b) => ({
    line: lineOf(b), ledger: tagOf(b, 'LEDGERNAME'),
  })).filter((e) => e.line.item_name);
  const lines = entries.filter((e) => e.line.qty > 0).map((e) => e.line);
  const loaded = entries.filter((e) => e.line.qty <= 0);
  return { ...v, kind: 'count', lines: lines.map((l) => ({
    item_name: l.item_name, counted: l.qty, unit: l.unit,
    godown: l.godown, batch: l.batch })) };
}

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/* ===================== the whole file ===================== */

// THE VOUCHER TYPES HAVE TO BE READ FIRST.
//
// "New Purchase" means nothing until the masters in the same file say its
// parent is Purchase. A file with vouchers and no voucher-type masters falls
// back to the name, which is right for a shop that never renamed anything.
export function voucherTypesIn(xml) {
  const out = {};
  for (const b of blocksOf(xml, 'VOUCHERTYPE')) {
    const name = nameAttr(b) || tagTop(b, 'NAME');
    const parent = tagTop(b, 'PARENT');
    if (name) out[name.toLowerCase()] = parent || name;
  }
  return out;
}

export function vouchersFromTallyXml(xml) {
  const types = voucherTypesIn(xml);
  const leds = ledgersIn(xml);
  const all = blocksOf(xml, 'VOUCHER').map((b) => readVoucher(b, types, leds));

  const book = { vouchers: [], payments: [], transfers: [], counts: [], skipped: [] };
  for (const v of all) {
    if (v.kind === 'skip')          book.skipped.push(v);
    else if (v.cancelled)           book.skipped.push({ ...v, why: 'cancelled in Tally' });
    else if (!v.vdate)              book.skipped.push({ ...v, why: 'no date Skwik could read' });
    else if (v.kind === 'voucher')  book.vouchers.push(v);
    else if (v.kind === 'payment')  book.payments.push(v);
    else if (v.kind === 'transfer') book.transfers.push(v);
    else if (v.kind === 'count')    book.counts.push(v);
  }
  return book;
}

/* ===================== checking it before it is written ===================== */

// NOTHING IS WRITTEN UNTIL THESE PASS.
//
// A STOP is something that would put a wrong figure in his books and cannot
// be undone by hand afterwards. A WARN is something he should look at and may
// well be right about.
export function checkBook(book, { items = [], parties = [], godowns = [] } = {}) {
  const stop = [], warn = [];
  const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const haveItem = new Set(items.map(norm));
  const haveParty = new Set(parties.map(norm));
  const haveGodown = new Set(godowns.map(norm));

  // 1. THE SAME BILL TWICE. Two bills on one number is either a renumbering
  //    in Tally or the same file picked twice, and merging them silently is
  //    the worst thing an importer can do.
  const seen = new Map();
  for (const v of book.vouchers) {
    const k = `${v.vtype}|${v.no}|${v.vdate}`;
    if (!v.no) continue;
    if (seen.has(k)) stop.push(`Bill ${v.no} of ${v.vdate} is in the file twice`);
    else seen.set(k, v);
  }

  // 2. A BILL WITH NOTHING ON IT.
  for (const v of book.vouchers) {
    if (v.lines.length) continue;
    // Sixteen of his purchases are a transporter's bill booked against a
    // stock item — an amount, a store, and no quantity anywhere. Calling that
    // "no goods on it" reads like something went wrong; it is simply what the
    // bill is, and saying so is the difference between a warning he acts on
    // and one he learns to scroll past.
    const charge = v.freight + v.others.reduce((t, x) => t + Math.abs(x.amount), 0);
    warn.push(charge > 0
      ? `${v.tally_type} ${v.no} is a charge of ${charge.toFixed(2)} with no goods on it`
        + `${v.freight ? ' (freight)' : ''}`
      : `${v.tally_type} ${v.no} has nothing on it at all`);
  }

  // 3. THE PIECES MUST ADD UP TO WHAT TALLY SAYS THE BILL CAME TO.
  //    Two rupees is a rounding difference; two hundred is a column read
  //    wrong, and that is worth stopping for.
  for (const v of book.vouchers) {
    if (!v.tally_total) continue;
    const off = Math.abs(v.total - v.tally_total);
    if (off > 2) {
      (off > 50 ? stop : warn).push(
        `${v.tally_type} ${v.no}: the lines and tax come to ${v.total.toFixed(2)}, `
        + `Tally says ${v.tally_total.toFixed(2)}`);
    }
  }

  // 4. NAMES THAT ARE NOT IN THE SHOP YET. Not a stop — they can be created
  //    on the way in — but he should know how many before he agrees.
  const newItems = new Set(), newParties = new Set(), newGodowns = new Set();
  const lookItem = (n) => { if (n && !haveItem.has(norm(n))) newItems.add(n); };
  const lookParty = (n) => { if (n && !haveParty.has(norm(n))) newParties.add(n); };
  const lookGodown = (n) => { if (n && !haveGodown.has(norm(n))) newGodowns.add(n); };
  for (const v of book.vouchers) {
    lookParty(v.party);
    v.lines.forEach((l) => { lookItem(l.item_name); lookGodown(l.godown); });
  }
  book.payments.forEach((p) => lookParty(p.party));
  book.transfers.forEach((t) => {
    lookGodown(t.from); lookGodown(t.to);
    t.lines.forEach((l) => { lookItem(l.item_name); lookGodown(l.from); lookGodown(l.to); });
  });

  // 5. A TAX RATE THAT DID NOT EXIST ON THAT DAY. Reading a purchase price as
  //    a tax rate is the classic way an importer ruins a return.
  for (const v of book.vouchers) {
    for (const l of v.lines) {
      if (!l.gst_rate) continue;
      if (!isSlab(l.gst_rate, v.vdate)) {
        warn.push(`${v.tally_type} ${v.no}: ${l.item_name} at ${l.gst_rate}%, `
                + `which was not a GST rate on ${v.vdate}`);
      }
    }
  }

  // 6. A TRANSFER THAT GOES NOWHERE.
  for (const t of book.transfers) {
    if (!t.from || !t.to) stop.push(`A transfer on ${t.vdate} does not say which store to which`);
    else if (norm(t.from) === norm(t.to)) {
      stop.push(`A transfer on ${t.vdate} goes from ${t.from} to itself`);
    }
  }

  // 7. MONEY WITH NO AMOUNT.
  for (const p of book.payments) {
    if (!p.amount) warn.push(`A ${p.ptype} on ${p.vdate} has no amount`);
  }

  return {
    stop, warn,
    newItems: [...newItems], newParties: [...newParties], newGodowns: [...newGodowns],
    counts: {
      bills: book.vouchers.length,
      payments: book.payments.length,
      transfers: book.transfers.length,
      stockCounts: book.counts.length,
      skipped: book.skipped.length,
    },
  };
}

// WHICH RATES WERE LEGAL ON A GIVEN DAY.
//
// The slabs changed on 22 September 2025 — 12 and 28 went, 40 arrived. A
// purchase price of 95 read as a tax rate fails this on any date; an honest
// 12% on a bill from 2023 passes, and the same 12% on one from this year does
// not, which is the point.
const SLAB_ERAS = [
  { from: '2017-07-01', to: '2025-09-21', slabs: [0, 0.1, 0.25, 1, 1.5, 3, 5, 6, 7.5, 12, 18, 28] },
  { from: '2025-09-22', to: null,         slabs: [0, 0.1, 0.25, 1, 1.5, 3, 5, 18, 40] },
];

export function slabsOn(date) {
  const d = String(date || '');
  for (const era of SLAB_ERAS) {
    if (d >= era.from && (!era.to || d <= era.to)) return era.slabs;
  }
  // A date before GST existed at all: take the earliest set rather than
  // calling every rate on the bill wrong.
  return SLAB_ERAS[0].slabs;
}

export function isSlab(rate, date) {
  const r = Number(rate);
  if (!Number.isFinite(r)) return false;
  const slabs = slabsOn(date);
  // Half rates are real: 2.5 and 9 are what CGST and SGST each come to.
  return slabs.some((s) => Math.abs(s - r) < 0.001 || Math.abs(s / 2 - r) < 0.001);
}
