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
  regOn, registrationNow, COMPOSITION, UNREGISTERED,
} from './transfer.js';
import { codeForState } from './states.js';
import { headPointsTo } from './money.js';

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
  // Contra moves money between the till and the bank -- he banks his takings
  // every evening and this is how Tally writes it. It used to be named and
  // skipped, because Skwik had no entry for it: cash in hand only ever went up
  // and a bank balance never rose from a deposit. It has one now.
  'contra':         { kind: 'cashmove' },
  // A JOURNAL IS WHATEVER AN ACCOUNTANT NEEDED IT TO BE -- WHICH IS NOT A
  // REASON TO THROW ALL OF THEM AWAY.
  //
  // Every journal used to be refused, because a general journal can put a
  // figure anywhere and importing one blind would put it somewhere wrong.
  // The cost of that caution showed up on a real book: four suppliers with a
  // balance in Tally and NOTHING AT ALL in Skwik, and 45,874.86 missing from
  // the cash. A CA posts his adjustments as journals, so every shop with an
  // accountant loses whatever he did.
  //
  // So a journal is read and then judged by its own legs. Two of them, one a
  // party and one the till or a bank, IS a receipt or a payment however it
  // was typed, and comes in as one. Anything else is still refused -- but by
  // name, with its date, its amount and both its ledgers, so what is missing
  // can be seen rather than counted.
  'journal':        { kind: 'journal' },
  'delivery note':  { kind: 'skip', why: 'goods sent, not a bill' },
  'receipt note':   { kind: 'skip', why: 'goods received, not a bill' },
  'sales order':    { kind: 'skip', why: 'an order, not a bill' },
  'purchase order': { kind: 'skip', why: 'an order, not a bill' },
  'physical stock': { kind: 'count' },

  // THE REST OF TALLY'S OWN TWENTY-FOUR, NAMED.
  //
  // These used to fall through to "a <whatever> Skwik has no place for",
  // which is true and useless: it does not say whether something was lost.
  // Each one now says what it is and why it is right to leave it, so the
  // passed-over list can be read rather than worried about.
  //
  // Two of them MUST be left. A memorandum and a reversing journal are not
  // in Tally's books either -- Tally itself keeps them out of the trial
  // balance -- so importing one would put a figure in his books that is not
  // in his accountant's.
  'memorandum':       { kind: 'skip', why: 'a memo Tally itself keeps out of the books' },
  'reversing journal':{ kind: 'skip', why: 'a reversing journal, which is not in the books until its date' },
  'rejections in':    { kind: 'skip', why: 'goods a customer sent back, with no bill against them' },
  'rejections out':   { kind: 'skip', why: 'goods returned to a supplier, with no bill against them' },
  'material in':      { kind: 'skip', why: 'job work material received' },
  'material out':     { kind: 'skip', why: 'job work material issued' },
  'job work in order':  { kind: 'skip', why: 'an order for job work, not a bill' },
  'job work out order': { kind: 'skip', why: 'an order for job work, not a bill' },
  'payroll':          { kind: 'skip', why: 'a payroll voucher' },
  'attendance':       { kind: 'skip', why: 'an attendance record, not money' },
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
// THE GROUPS, SO A LEDGER'S GROUP CAN BE FOLLOWED UP TO A KIND TALLY KNOWS.
//
// Nobody files a supplier straight under Sundry Creditors. They make a group
// for a trade or a town and put him in that. On his own book:
//
//     Transport              -> Sundry Creditors
//     Umarpur Plastic Party  -> Sundry Creditors
//     STAFF                  -> Other Liabilities
//
// so Sbgc Express, SHREE SHYAM ROADWAYS, Inland Freight Express, M.S. Polymer
// and the rest ARE suppliers, and this file read their group as "Transport",
// shrugged, and called them 'other'.
//
// WHY THAT COSTS SOMETHING RATHER THAN BEING UNTIDY. Two lines below there is
// a deliberate guard: a ledger the GROUP has placed is never put through the
// tax-name test, because -- as the comment there says -- "a customer called
// GST TRADERS is not a tax ledger". A role of 'other' switches that guard off.
// So a supplier under a custom group whose name happens to carry a tax word
// was read as tax. The guard was written; the shallow lookup disarmed it.
//
// transfer.js has walked this chain properly since it was written. This file
// did not, and nothing pointed at the difference until the reading report put
// eight of his own ledgers under "placed by neither".
export function groupsIn(xml) {
  const out = {};
  for (const b of blocksOf(xml, 'GROUP')) {
    const name = nameAttr(b) || tagTop(b, 'NAME');
    if (!name) continue;
    out[name.toLowerCase()] = tagTop(b, 'PARENT') || '';
  }
  return out;
}

// Up the chain until a group Tally itself defines is reached. The first hop is
// the ledger's own parent, so every file that worked before works the same.
const roleUpTheChain = (groups, parent) => {
  const seen = new Set();
  let at = String(parent || '');
  for (let hop = 0; at && hop < 12; hop++) {
    const k = at.toLowerCase();
    if (seen.has(k)) break;            // a group that is its own ancestor
    seen.add(k);
    const r = roleOfGroup(at);
    if (r && r !== 'other') return r;
    at = groups[k] || '';
  }
  return 'other';
};

export function ledgersIn(xml, groups) {
  const out = {};
  const grp = groups || groupsIn(xml);
  for (const b of blocksOf(xml, 'LEDGER')) {
    const name = nameAttr(b) || tagTop(b, 'NAME');
    if (!name) continue;
    const parent = tagTop(b, 'PARENT') || '';
    // THE DATED ROWS, NOT THE LEGACY TAGS. Read by the one helper the party
    // masters use as well, so the two readings of the same ledger cannot
    // disagree -- the reasoning is written out beside it in transfer.js.
    const reg = registrationNow(b);
    out[name.toLowerCase()] = {
      name, parent,
      role: roleUpTheChain(grp, parent),
      gstin: reg.gstin,
      state: reg.state,
      reg_type: reg.type,
      composition: reg.composition,
      // kept so a bill can be read against the row in force the day it was
      // written, and so the report can say what changed
      regs: reg.regs, addrs: reg.addrs,
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
  // AN EXPENSE IS NOT GOODS, AND CALLING IT 'other' MADE IT GOODS.
  //
  // A bill with no inventory on it has its purchase ledger read AS the goods,
  // which is right -- there is nothing else it could be. But the fallback for
  // an unrecognised group was "anything not definitely something else is the
  // goods", and Indirect Expenses came back 'other', so an insurance bill with
  // no purchase ledger on it at all had the insurance made into a stock item:
  //
  //     Fire Insurance (Godown)   1 unit   14,846.00   in closing stock
  //     Shop Insurance            1 unit    8,651.00   in closing stock
  //
  // The bill's total was right, its tax was right and GSTR-1 was right, so
  // nothing complained -- and 23,497.00 of insurance sat in his stock as goods.
  // These are Tally's own built-in groups, on every company file there is.
  if (/(indirect|direct)\s*expenses?/i.test(g)) return 'expense';
  if (/(indirect|direct)\s*incomes?/i.test(g)) return 'income';
  return 'other';
};

const isMoney = (role) => role === 'cash' || role === 'bank';

// THE WORDS A LEDGER MIGHT USE FOR REVERSE CHARGE, IN ONE PLACE.
//
// This was written out three times in two different loops, and a fourth place
// that needed it did not have it at all -- which is how an accounts-only book's
// freight leg went unmarked. A shared regex cannot drift apart from itself.
//
// It is only ever a FALLBACK. Tally writes the answer on the entry itself
// (GSTOVRDNISREVCHARGEAPPL), and that is what decides first, because a word in
// a ledger's name is a guess about somebody else's vocabulary.
const RCM_NAME = /\br\.?\s*charge\b|reverse\s*charge|\brcm\b/i;

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
    // THE SUPPLIER'S OWN BILL NUMBER AND ITS DATE.
    //
    // Neither was read, and the purchase was stored with the shop's voucher
    // number as the supplier's bill number and the DAY IT WAS ENTERED as the
    // day the supplier wrote it. Purchases are entered when the goods arrive,
    // so a bill of 30 March entered on 30 April was stored as a bill of
    // 30 April -- and the whole GSTR-2B comparison turns on that date. Soni
    // Brothers' EI/25-26/3118 is a March bill; the portal has it in March;
    // Skwik had it in April and reported the man as not having filed.
    //
    // Tally writes both on a purchase: REFERENCE and REFERENCEDATE. Older
    // exports spell them SUPPLIERINVOICENO and SUPPLIERINVOICEDATE.
    sup_no: tagTop(block, 'REFERENCE') || tagTop(block, 'SUPPLIERINVOICENO'),
    sup_date: tallyDate(tagTop(block, 'REFERENCEDATE'))
           || tallyDate(tagTop(block, 'SUPPLIERINVOICEDATE')),
    // Tally's own id for the voucher. Carried so the same file imported twice
    // cannot write the same bill twice.
    ref: tagTop(block, 'GUID') || tagTop(block, 'REMOTEID') || '',
    cancelled: /^yes$/i.test(tagTop(block, 'ISCANCELLED'))
            || /^yes$/i.test(tagTop(block, 'ISDELETED')),
  };

  if (!map) return { ...v, kind: 'skip', why: `a ${typeName || 'voucher'} Skwik has no place for` };
  if (map.kind === 'skip') return { ...v, kind: 'skip', why: map.why };

  if (map.kind === 'journal')  return readJournal(block, v, leds);
  if (map.kind === 'transfer') return readTransfer(block, v);
  if (map.kind === 'cashmove') return readCashMove(block, v, leds);
  if (map.kind === 'payment')  return readPayment(block, v, map.ptype, leds);
  if (map.kind === 'count')    return readCount(block, v);
  return readBill(block, v, map.vtype, leds);
}

// A BILL: goods in one list, money in another.
// tagOf returns the FIRST match only, and Tally writes the reverse-charge flag
// once per ENTRY -- a bill with four legs carries four of them and only one may
// say Applicable. So this sweeps the whole block rather than reading one.
const anyTagSays = (chunk, tag, test) => {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'gi');
  let m;
  while ((m = re.exec(chunk))) { if (test(m[1])) return true; }
  return false;
};

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
  // set by the ledger-leg loop below; read where the reverse charge is decided
  let rcmByName = false;
  // Kept SIGNED, because the sign is the only thing that says which side of
  // the bill these sit on. See the note under roundSign.
  let roundRaw = 0, taxRaw = 0, partyRaw = 0;
  // THE NAMES THE CHARGE CAME OFF. Only ever a hint about inter vs intra
  // state, and only where the supplier's state is unknown -- on his own books
  // these names are wrong on 7 of 87 reverse-charge bills. See headPointsTo.
  const chargeNames = [];
  const others = [];
  for (const b of legsOf(block)) {
    const name = top(b, 'LEDGERNAME');
    const amt = numOf(top(b, 'AMOUNT'));
    if (!name) continue;
    // A CUSTOMER CALLED "GST TRADERS" IS NOT A TAX LEDGER. The group says
    // what a ledger is; the name only says what it is called. The name test
    // is kept for a file with no ledger masters in it.
    const role = (leds && leds[name.toLowerCase()] || {}).role;
    // WHICH ROLES MAY SKIP THE NAME TEST, NAMED RATHER THAN GUESSED AT.
    //
    // The guard is about PARTIES and MONEY: a customer called "GST Traders" is
    // not a tax ledger, and a bank called "Cash Credit" is not the till. It was
    // written as "any role except tax and other", which quietly meant "anything
    // Skwik has a word for" -- so the moment `expense` was added as a role, the
    // Round Off ledger (Indirect Expenses) stopped being recognised as round
    // off and its 0.28 went into the charge instead. The bill still added up,
    // so nothing complained; the taxable was 28 paise light.
    //
    // I did that today, while fixing a fault of exactly this shape one screen
    // above. So the list is now the roles that actually mean "this is a person
    // or a bank account", written out, and a new role cannot disarm it by
    // simply existing.
    const isPartyOrMoney = role === 'customer' || role === 'supplier'
                        || role === 'cash' || role === 'bank';
    const head = isPartyOrMoney ? null : taxHead(name);
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
    if (/freight|transport|cartage|coolie|loading/i.test(name)) {
      // AND THIS LEG CAN BE THE REVERSE-CHARGE ONE TOO.
      //
      // The name test for reverse charge ran over the charges that ride on a
      // STOCK ITEM and over `others`, and a freight leg caught here goes into
      // neither -- it is added to `freight` and the loop moves on. So a shop
      // running Tally in accounts-only mode, which this file explicitly
      // supports a few hundred lines down, had its reverse-charge freight
      // missed by the name test entirely.
      //
      // His own bills all carry an inventory entry, so nothing in his book
      // could ever have shown this. It came out of a made-up file with the
      // freight as a plain ledger leg -- and it is on his live build today,
      // which I checked before calling it mine.
      //
      // Tally's own flag already catches this case. This is the fallback for
      // an older export that does not carry one.
      if (RCM_NAME.test(name)) rcmByName = true;
      chargeNames.push(name);
      freight += Math.abs(amt); continue;
    }
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

  // A CHARGE BOOKED WITH NO STOCK ITEM UNDER IT IS STILL ON THE BILL.
  //
  // His insurance and his packing & forwarding are ledger legs and nothing
  // else -- no inventory entry, so no stock item to ride on:
  //
  //   National Insurance Company Limited    17518.00
  //   Fire Insurance (Godown)             -14846.00
  //   CGST                                 -1336.14
  //   SGST                                 -1336.14
  //   Round Off                                 0.28
  //
  // Only the charges riding on a stock item were being counted, so this bill
  // added up to 2672 against Tally's 17518 -- the whole of it missing but the
  // tax. Three of his bills stopped the import dead for exactly this.
  //
  // The sign is read the same way the round off is, and for the same reason:
  // Tally writes a charge on the same side as the taxes, so whichever way
  // they face is "added to the bill". A discount, written the other way,
  // therefore comes off it instead of being piled on.
  for (const o of others) o.amount = round2(o.amount * roundSign);

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
  // AND TALLY ITSELF SAYS SO, WHICH IS BETTER THAN READING THE NAME.
  //
  // Reading the ledger's NAME for "R.Charge" is a guess about what other shops
  // call their freight ledger, and it is already wrong on his own book. Tally
  // writes the answer on the entry:
  //
  //     <GSTOVRDNISREVCHARGEAPPL>&#4; Applicable</GSTOVRDNISREVCHARGEAPPL>
  //
  // MEASURED ON ONE DAY OF HIS DAY BOOK:
  //     the ledger name says reverse charge on   15 vouchers
  //     Tally's own flag says it on              16
  //     the one the name misses: 102-56419, SHREE SHYAM ROADWAYS, 1,430.00,
  //     three legs all named "FREIGHT INTRA STATE" -- no tax ledger on it, and
  //     nothing in the name for the word test to catch.
  //
  // A shop that names every freight ledger that way would have lost ALL of its
  // reverse charge, silently, and filed 3.1(d) at nil.
  //
  // WHY THIS TAG AND NOT THE OTHER ONE. Tally writes two. On that very voucher
  // <ISREVERSECHARGEAPPLICABLE> says "No" while GSTOVRDNISREVCHARGEAPPL says
  // "Applicable", and across the file the first is set on 3 vouchers against
  // the second's 16. So the Yes/No one is not the flag that means this, and
  // trusting it would have missed thirteen.
  //
  // THE NAME TEST STAYS, as an OR rather than a replacement. The flag can only
  // add; an export that does not carry it still behaves exactly as it did.
  // Tally prefixes the value with a &#4; control character, so it is stripped
  // before comparing -- matching on the raw string finds nothing at all, which
  // is how I first measured this flag as absent from a file that has 27 of it.
  const saysRcm = (t) => String(t || '').replace(/&#\d+;/g, '').trim().toLowerCase() === 'applicable';
  let rcm = anyTagSays(block, 'GSTOVRDNISREVCHARGEAPPL', saysRcm) || rcmByName;
  let chargeRate = 0;
  for (const e of loaded) {
    if (!chargeRate) chargeRate = e.line.gst_rate || 0;
    if (RCM_NAME.test(e.ledger)) rcm = true;
    if (/freight|transport|cartage|coolie|loading/i.test(e.ledger)) {
      chargeNames.push(e.ledger); freight += e.line.amount;
    }
    else others.push({ name: e.ledger || e.line.item_name, amount: e.line.amount, on_item: e.line.item_name });
  }
  for (const o of others) {
    if (RCM_NAME.test(o.name)) rcm = true;
  }

  // A TALLY KEPT WITHOUT INVENTORY STILL HAS BILLS ON IT.
  //
  // Plenty of shops run Tally in accounts-only mode -- the voucher carries the
  // party, the purchase ledger and the taxes, and not one inventory entry.
  // Read here, `lines` came out empty, so the goods were nought and the whole
  // value of the bill fell through to `charge`:
  //
  //     taxable        0
  //     charge  16,322.22        <- the entire bill, filed as "Charges"
  //     total   19,260.22        <- right, and the only thing that was
  //
  // The bill added up, so nothing complained. But it had no body: no line to
  // read, no HSN, nothing for GSTR-1 to summarise, and a taxable value of
  // nought -- which is the figure GSTR-3B and the profit report both take.
  //
  // With no inventory on the voucher, the purchase or sales ledger IS the
  // goods; there is nothing else it could be. So each such leg becomes a line
  // of its own, named after the ledger. Where the masters are in hand the
  // ledger's GROUP says which legs those are; without them, everything left
  // after the party, the taxes, the round off and the freight is goods, for
  // the same reason.
  //
  // Guarded on there being no inventory at all, so a bill with stock on it
  // reads exactly as it did.
  if (!lines.length && others.length) {
    const rate = (name) => {
      const m = String(name).match(/(\d+(?:\.\d+)?)\s*%/);
      return m ? Number(m[1]) : 0;
    };
    // THE MASTERS DECIDE IT WHERE THEY CAN, AND NEVER LEAVE THE BILL EMPTY.
    //
    // A ledger filed under Purchase Accounts or Sales Accounts is goods and
    // there is no argument. Where the file names those, godown rent and the
    // like stay charges, as they should. But a shop may group its purchase
    // ledger somewhere Skwik does not recognise, and refusing every
    // unrecognised leg would put the bill back to having no body at all --
    // which is the fault being fixed. So the strong answer is taken when
    // there is one, and otherwise every leg that is not definitely something
    // else becomes the goods.
    const roleOf = (o) => (leds && leds[String(o.name).toLowerCase()] || {}).role;
    const strong = others.filter((o) => {
      const r = roleOf(o);
      return r === 'purchase' || r === 'sales';
    });
    // AND AN EXPENSE IS NEVER THE GOODS. The fallback below is deliberately
    // permissive -- a shop may group its purchase ledger somewhere Skwik does
    // not know, and refusing every unrecognised leg would leave the bill with
    // no body, which is the fault this whole branch exists to fix. But an
    // expense is not unrecognised: Tally itself says what it is, and making it
    // the goods put 23,497.00 of insurance into his closing stock.
    const body = strong.length ? strong : others.filter((o) => {
      const r = roleOf(o);
      return (!r || r === 'other') && r !== 'expense' && r !== 'income';
    });
    if (body.length) {
      // whatever tax the named rates cannot account for belongs to the rest
      const taxAll = cgst + sgst + igst;
      const known = body.reduce((s, o) => s + (o.amount * rate(o.name)) / 100, 0);
      const bare = body.filter((o) => !rate(o.name));
      const bareSum = bare.reduce((s, o) => s + o.amount, 0);
      let spare = 0;
      if (bareSum > 0.5 && taxAll - known > 0.5) {
        const asked = ((taxAll - known) / bareSum) * 100;
        spare = [0.1, 0.25, 1, 1.5, 3, 5, 6, 12, 18, 28]
          .find((r) => Math.abs(r - asked) < 0.2) || 0;
      }
      for (const o of body) {
        lines.push({ item_name: o.name, qty: 1, unit: '', rate: round2(o.amount),
                     amount: round2(o.amount), gst_rate: rate(o.name) || spare,
                     from_ledger: true });
      }
      const gone = new Set(body);
      for (let i = others.length - 1; i >= 0; i--) if (gone.has(others[i])) others.splice(i, 1);
    }
  }

  const goods = lines.reduce((t, l) => t + (l.amount || l.qty * l.rate), 0);
  // EVERY charge on the bill, whether it rode on a stock item or stood on its
  // own as a ledger. Counting only the first is what lost the insurance.
  const carried = others.reduce((t, x) => t + x.amount, 0);

  // WHAT RATE THE CHARGE WAS TAXED AT, WHEN THE FILE DOES NOT SAY.
  //
  // A ledger charge carries no rate of its own -- Tally puts the tax on the
  // tax ledgers and leaves the charge bare. Left at nought, the charge shows
  // up in the HSN summary as 14,846 with no tax against it while the bill
  // header carries 2,672.28, so the summary stops adding up to the bill and
  // the same hole turns up in his GSTR-1.
  //
  // It is not guessed: it is what is left over. The goods account for their
  // own tax at their own rates, and whatever tax remains belongs to the
  // charge. The answer is only kept if it lands on a real GST rate -- 18% on
  // his insurance, 5% on the aluminium packing -- and left at nought if it
  // does not, because a rate that is nearly right is worse than none.
  if (!chargeRate && carried > 0.5) {
    const taxOnBill = cgst + sgst + igst;
    const taxOfGoods = lines.reduce((t, l) =>
      t + ((l.amount || l.qty * l.rate) * (Number(l.gst_rate) || 0)) / 100, 0);
    const over = taxOnBill - taxOfGoods;
    if (over > 0.5) {
      const asked = (over / carried) * 100;
      const real = [0.1, 0.25, 1, 1.5, 3, 5, 6, 12, 18, 28]
        .find((r) => Math.abs(r - asked) < 0.2);
      if (real) chargeRate = real;
    }
  }
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
    charge_names: chargeNames,
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
// MONEY MOVED BETWEEN HIS OWN TILL AND HIS OWN BANK.
//
// Tally calls it a Contra and writes it as two money legs and nothing else:
//
//   Cash                              400000.00     (credit -- out of the till)
//   Cash Credit Account Fedral Bank  -400000.00     (debit  -- into the bank)
//
// So there is no party to find, only which leg is the till and which is the
// bank, and which way the money went. The sign answers the last part: on the
// cash leg a credit is money leaving the drawer, which is a deposit.
//
// Both legs are money, so the trick readPayment uses -- "the money leg is the
// one filed under Cash-in-hand or a Bank group" -- cannot tell them apart on
// its own. The GROUP does: one is cash, the other is a bank.
function readCashMove(block, v, leds) {
  const legs = legsOf(block).map((b) => ({
    name: top(b, 'LEDGERNAME'),
    raw: numOf(top(b, 'AMOUNT')),
  })).filter((l) => l.name && l.raw);

  const roleOf = (n) => ((leds && leds[String(n).toLowerCase()]) || {}).role || '';
  const looksLikeTill = (n) => /^cash$|cash\s*in\s*hand|petty\s*cash|^till$/i.test(String(n).trim());

  // The masters answer this when they are in the file; the name answers it
  // when they are not, and a file with no ledger masters is common enough.
  let till = legs.find((l) => roleOf(l.name) === 'cash');
  if (!till) till = legs.find((l) => looksLikeTill(l.name));
  const bank = legs.find((l) => l !== till);

  // A CONTRA BETWEEN TWO BANKS IS NOT A DEPOSIT, and guessing would move money
  // out of a till that was never involved. Named, not guessed at.
  if (!till) {
    return { ...v, kind: 'skip',
             why: 'moves money between two bank accounts, and Skwik keeps no entry for that' };
  }

  // MORE THAN TWO LEGS IS STILL BANKING.
  //
  // This used to be refused outright -- "moves money between more than two
  // places at once" -- which threw away a whole year of his banking without a
  // word on any screen. But a contra that takes 5,00,000 out of the till and
  // puts 3,00,000 into one account and 2,00,000 into another is not a puzzle:
  // it is two deposits, and it should be written as two.
  //
  // So every leg that is not the till becomes its own movement, at its own
  // amount. The till's leg says which way the money went; each bank leg says
  // how much went there. One leg and no bank at all is still a movement -- it
  // just has no account named against it, which the sheet already allows for.
  const others = legs.filter((l) => l !== till);
  const way = till.raw > 0 ? 'deposit' : 'withdrawal';
  const moves = others.length
    ? others.map((b) => ({ direction: way, amount: round2(Math.abs(b.raw)), account: b.name }))
    : [{ direction: way, amount: round2(Math.abs(till.raw)), account: '' }];

  return {
    ...v,
    kind: 'cashmove',
    moves,
    // the first one, kept flat as well, because that is the shape everything
    // downstream was written against
    direction: moves[0].direction,
    amount: moves[0].amount,
    account: moves[0].account,
  };
}

function readPayment(block, v, ptype, leds) {
  const legs = legsOf(block).map((b) => ({
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
    // NO MASTERS TO GO ON, SO THE NAME HAS TO DECIDE.
    //
    // The header used to decide, and the header is wrong about as often as it
    // is right: his own "Cash Credit Account Fedral Bank paid 16,500 via Mr
    // Harsa Gowala" is the header naming the BANK as the party. Read that way
    // the bank becomes a customer and the customer becomes the bank, and every
    // figure after it is the wrong way round.
    //
    // When the ledger masters are there, role decides and none of this runs.
    // When they are not, the only thing left is what the ledgers are CALLED --
    // and a bank account in an Indian book nearly always says so: "Bank of
    // Baroda", "HDFC Bank", "Cash Credit Account", "OD Account", "Current
    // A/c". A person almost never does. Checked against real names from his own
    // book: Bank Of Baroda, Cash Credit Account Fedral Bank, OD Account and
    // Current A/c all read as money; Mr Harsa Gowala, Sri Ganesh Store, Soni
    // Brothers and even Ramesh Bankar all read as people, because \bbank\b does
    // not match inside a longer word.
    //
    // This is a guess, and it is written down as a guess. It is a better guess
    // than the header, which was also a guess with no reason behind it. Only
    // ONE leg naming itself as money counts -- two of them, or none, and it
    // falls back to the header exactly as before.
    const saysMoney = (n) => /\bbank\b|\bcash\b|cash\s*credit|\bc\s*\/?\s*c\b|\bo\s*\/?\s*d\b|overdraft|current\s*a\s*\/?\s*c/i
      .test(String(n || ''));
    const byName = legs.filter((l) => saysMoney(l.name));
    if (byName.length === 1) {
      account = byName[0].name;
      party = (legs.find((l) => l !== byName[0]) || {}).name || v.party || '';
    } else {
      party = v.party || (legs[0] && legs[0].name) || '';
      const rest = legs.find((l) => l.name.toLowerCase() !== String(party).toLowerCase());
      account = rest ? rest.name : '';
    }
    mode = /^cash$|^cash\s*in\s*hand$|^petty\s*cash$|^cash\s*a\s*\/?\s*c$/i
      .test(account.trim()) ? 'cash' : 'bank';
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

// A JOURNAL, JUDGED BY ITS OWN LEGS.
//
// Three shapes turn up, and only one of them is a puzzle:
//
//   a party and the till or a bank ... a receipt or a payment, typed as a
//                                      journal. Read as what it is.
//   two parties ...................... one man's balance moved to another.
//                                      Skwik has no entry for that yet, so
//                                      it is named and left.
//   anything else .................... an accountant's adjustment between
//                                      ledgers Skwik does not keep. Named
//                                      and left.
//
// Named means named: the date, the amount, and both ledgers, so he can see
// the four suppliers he is missing instead of a count of things skipped.
function readJournal(block, v, leds) {
  const legs = legsOf(block).map((b) => ({
    name: top(b, 'LEDGERNAME'),
    raw: numOf(top(b, 'AMOUNT')),
    amt: Math.abs(numOf(top(b, 'AMOUNT'))),
  })).filter((l) => l.name && l.amt);

  const roleOf = (n) => ((leds && leds[String(n).toLowerCase()]) || {}).role || '';
  const said = () => legs.map((l) => `${l.name} ${round2(l.amt)}`).join(', ');

  if (legs.length < 2) {
    return { ...v, kind: 'skip',
      why: `a journal with only one side \u2014 ${said()}` };
  }

  // TWO LEGS, ONE OF THEM THE TILL OR A BANK, IS A RECEIPT OR A PAYMENT
  // however it was typed. Anything else -- three legs, five, all of them
  // ledgers -- is a journal, and Skwik has one of those now, so the count of
  // legs stops being a reason to refuse it. The only shape still refused is
  // one that cannot be a voucher at all.
  const money = legs.length === 2 ? legs.find((l) => isMoney(roleOf(l.name))) : null;
  const other = money ? legs.find((l) => l !== money) : null;

  if (money && other) {
    const partyRole = roleOf(other.name);
    // Money INTO the till or the bank is a receipt; out of it, a payment.
    // Tally writes the debited leg negative, and a receipt debits the bank.
    const ptype = money.raw < 0 ? 'receipt' : 'payment';
    return { ...v, kind: 'payment', ptype,
      party: other.name, amount: round2(other.amt),
      account: money.name, mode: roleOf(money.name) === 'cash' ? 'cash' : 'bank',
      party_role: partyRole, from_journal: true };
  }

  // EVERY OTHER JOURNAL IS STILL A JOURNAL, and Skwik has somewhere to put
  // one now. Each leg says where it lands and which way it goes: Tally writes
  // a debit as a NEGATIVE amount, Skwik's journal writes a debit positive, so
  // the sign turns over here and nowhere else.
  return { ...v, kind: 'journal',
    legs: legs.map((l) => ({
      name: l.name,
      role: roleOf(l.name),
      group: ((leds && leds[String(l.name).toLowerCase()]) || {}).parent || '',
      amount: round2(-l.raw),
    })),
    said: said() };
}

// Tally's group, in the words a report can add up. A journal has to put every
// leg somewhere, and "other" is an honest answer where the group is one Skwik
// does not recognise -- better than filing a director's loan under expenses.
export const roleForJournal = (group) => {
  const g = String(group || '');
  if (/duties\s*&?\s*(amp;)?\s*taxes/i.test(g)) return 'tax';
  if (/sales\s*account|direct\s*income|indirect\s*income/i.test(g)) return 'income';
  if (/purchase\s*account|direct\s*exp|indirect\s*exp/i.test(g)) return 'expense';
  if (/capital|reserves|retained/i.test(g)) return 'capital';
  if (/loan|liabilit|provision|payable/i.test(g)) return 'liability';
  if (/asset|deposit|investment|stock-?in-?hand|receivable/i.test(g)) return 'asset';
  return 'other';
};

// GOODS MOVED, AND NOTHING ELSE.
//
// The in-list and the out-list each carry their own store, and the header
// names the destination. Tally writes the in-leg's amounts negative; the
// direction is taken from which list a line came out of, never from the sign.
function readTransfer(block, v) {
  // I GOT THIS WRONG AND IT IS WORTH SAYING SO.
  //
  // A bench fixture of mine spelled the tag INVENTRYENTRIESIN.LIST -- no O --
  // the fixture failed, and I "fixed" the reader to match my own typo and
  // wrote a confident comment saying Tally misspells its own tag. It does
  // not. His real day book was then counted: INVENTORYENTRIESIN with the O,
  // 57 occurrences; without the O, none. Tally's own TDL reference names the
  // collections "Inventory Entries In" and "Inventory Entries Out", and a
  // community import template uses the O spelling too.
  //
  // The correct spelling is asked for first. The other is still accepted,
  // because accepting a spelling that never turns up costs nothing and this
  // is the second tag tonight where Tally has used two names for one thing.
  const both = (a, b) => {
    const x = blocksOf(block, a);
    return (x.length ? x : blocksOf(block, b)).map(lineOf).filter((l) => l.item_name);
  };
  const inn = both('INVENTORYENTRIESIN.LIST', 'INVENTRYENTRIESIN.LIST');
  const out = both('INVENTORYENTRIESOUT.LIST', 'INVENTRYENTRIESOUT.LIST');
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
// TALLY SPELLS THE SAME THING TWO WAYS, AND THE READER ONLY KNEW ONE EACH.
//
// A voucher's ledger legs come out as LEDGERENTRIES.LIST or as
// ALLLEDGERENTRIES.LIST depending on the version and the report they were
// exported from. The bill reader looked for the first, the cash and payment
// readers for the second -- so a file written the other way round gave bills
// with no party and contras that "move money between two bank accounts".
//
// Found by running the reader over twenty made-up shapes rather than over his
// file, which happens to use the spelling each reader expected. Nothing in
// two weeks of his own data could have shown this.
const legsOf = (block) => {
  const a = blocksOf(block, 'ALLLEDGERENTRIES.LIST');
  const b = blocksOf(block, 'LEDGERENTRIES.LIST');
  // LEDGERENTRIES.LIST is a substring of the other, so a file carrying only
  // the long spelling would otherwise be read twice over
  return a.length ? a : b;
};

export function voucherTypesIn(xml) {
  const out = {};
  for (const b of blocksOf(xml, 'VOUCHERTYPE')) {
    const name = nameAttr(b) || tagTop(b, 'NAME');
    const parent = tagTop(b, 'PARENT');
    if (name) out[name.toLowerCase()] = parent || name;
  }
  return out;
}

// ===================== WHAT THE READER MADE OF THE FILE =====================
//
// WHY THIS EXISTS.
//
// Most of the reader decides things from Tally's own structure: a voucher type
// by its PARENT, a ledger by the group it sits under. That part travels to
// anybody's book, because those are Tally's words and not the shopkeeper's.
//
// But a few decisions fall back to reading a NAME, and a name is a guess about
// what somebody else calls things. One of those guesses was already wrong on
// his own book -- a transporter's bill on three legs all called "FREIGHT INTRA
// STATE", missed by a test looking for "R.Charge", so its reverse charge went
// unrecorded and 3.1(d) would have been filed short.
//
// The lesson is not that the guesses are bad. It is that they were INVISIBLE.
// Nothing on any screen said "I decided this one by its name, have a look."
//
// So this reports what was made of the file BEFORE anything is written, and
// marks the decisions that rested on a name rather than on Tally's structure.
// It changes no figure and imports nothing. It is a thing to read.
//
// It deliberately does NOT ask the shopkeeper what he calls his freight ledger.
// He cannot answer that in the abstract -- but shown his own ledger names with
// a guess beside each, he can spot a wrong one in seconds.
const said = (ymd) => {
  const t = String(ymd || '').replace(/\D/g, '');
  if (t.length !== 8) return t;
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
               'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${Number(t.slice(6, 8))} ${MON[Number(t.slice(4, 6)) - 1] || '?'} ${t.slice(0, 4)}`;
};

export function readingReport(xml, typesIn, ledsIn, book) {
  // The caller usually has these already. Taking them rather than reading the
  // file again is not only cheaper -- it means the report describes THE reading
  // that happened, and cannot drift from it.
  const types = typesIn || voucherTypesIn(xml);
  const leds  = ledsIn  || ledgersIn(xml);
  const haveTypeMasters   = Object.keys(types).length > 0;
  const haveLedgerMasters = Object.keys(leds).length > 0;

  // ---- the voucher types actually used, and whether each one maps ----
  const used = new Map();
  for (const b of blocksOf(xml, 'VOUCHER')) {
    const name = tagTop(b, 'VOUCHERTYPENAME') || '(no type named)';
    const k = name.toLowerCase();
    // the SAME expression readVoucher uses, or this would report on a rule
    // nothing follows
    const parent = (types[k] || name).toLowerCase();
    const row = used.get(k) || {
      name, parent,
      becomes: FROM_PARENT[parent] ? (FROM_PARENT[parent].vtype || FROM_PARENT[parent].kind) : null,
      known: !!FROM_PARENT[parent],
      // KNOWN AND THROWN AWAY IS AS INVISIBLE AS UNKNOWN. A delivery note, an
      // order, a memorandum -- Skwik places all of these and then drops them,
      // for good reasons written beside each. But a shop whose stock moves on
      // delivery notes would hand over a year and be told nothing about the
      // half of it that never arrived. So `skipped` is reported too, with
      // Tally's own count and the reason.
      skipped: !!FROM_PARENT[parent] && FROM_PARENT[parent].kind === 'skip',
      why: (FROM_PARENT[parent] || {}).why || null,
      // the parent came from the masters, or we are falling back to the name
      fromMasters: !!types[k],
      count: 0,
    };
    row.count += 1;
    used.set(k, row);
  }
  const voucherTypes = [...used.values()].sort((a, b) => b.count - a.count);
  const unknownTypes = voucherTypes.filter((t) => !t.known);
  const skippedTypes = voucherTypes.filter((t) => t.skipped);

  // ---- which ledgers are used on a voucher, and how their role was decided --
  const seen = new Map();
  for (const b of blocksOf(xml, 'VOUCHER')) {
    for (const m of String(b).matchAll(/<LEDGERNAME>([\s\S]*?)<\/LEDGERNAME>/gi)) {
      const nm = unesc(String(m[1]).trim());
      if (!nm) continue;
      const k = nm.toLowerCase();
      seen.set(k, (seen.get(k) || 0) + 1);
    }
  }

  // the name tests the reader falls back on, kept HERE in one place so the
  // report cannot drift from what the reader actually does
  const NAME_TESTS = [
    { as: 'freight or charges on a bill', re: /freight|transport|cartage|coolie|loading/i },
    { as: 'reverse charge',               re: /\br\.?\s*charge\b|reverse\s*charge|\brcm\b/i },
  ];

  const ledgers = [];
  for (const [k, count] of seen) {
    const led = leds[k];
    const group = led ? (led.parent || '') : '';
    const byGroup = led && led.role && led.role !== 'other' ? led.role : null;
    const byName = NAME_TESTS.filter((t) => t.re.test(k)).map((t) => t.as);
    ledgers.push({
      name: led ? led.name : k,
      group,
      count,
      role: byGroup || (byName.length ? byName[0] : null),
      // 'group'   Tally's own structure said so -- travels to any book
      // 'name'    a word in the ledger's name said so -- a guess
      // 'nothing' neither; the reader works it out from the voucher instead
      decidedBy: byGroup ? 'group' : (byName.length ? 'name' : 'nothing'),
      alsoByName: byName,
    });
  }
  ledgers.sort((a, b) => b.count - a.count);

  // ---- WHAT TALLY CHANGED ITS MIND ABOUT, AND WHEN ----
  //
  // His own masters hold 49 ledgers with more than one dated registration
  // row -- 21 changed number, 16 changed state, 22 went unregistered, 11 are
  // Composition. Reading the row in force is now done (see registrationNow in
  // transfer.js), but three of those cases cannot be settled by a reader and
  // have to be put in front of him.
  const partyish = (r) => r === 'customer' || r === 'supplier';
  let dated = 0;

  // 1. A NUMBER TALLY HAS WITHDRAWN. Skwik never deletes a GST number that is
  //    already in his books -- he may have typed it himself. So when Tally has
  //    retired one, the import stops copying it and says so instead.
  const withdrawn = [];
  // 2. A PARTY WHOSE REGISTRATION REALLY CHANGED -- not one whose details were
  //    simply filled in later.
  //
  //    This first said "moved from X to Y" for every ledger whose state
  //    differed between its first and last row, and on his book that was 16
  //    names. Fourteen of them had not moved anywhere: he had made the ledger
  //    with Tally's default state and no number, then typed the real number
  //    and state in afterwards. Telling him Gaurav Traders "moved from Assam
  //    to Gujarat" would send him looking for a relocation that never
  //    happened -- and his bills before that date were worked out against
  //    Assam by Tally too, so Skwik agrees with Tally on every one of them
  //    and there is nothing to look at.
  //
  //    A number in the earlier row is what separates the two. Two names on his
  //    book qualify: Bansal Udhyog, whose state was corrected under the same
  //    number, and Greatx, whose number was withdrawn.
  const changed = [];
  // 3. A COMPOSITION SUPPLIER, AND ONLY A SUPPLIER.
  //
  //    A composition dealer you BUY from charges no GST, so there is no input
  //    tax to claim and a purchase booked with tax is wrong. Worth saying.
  //
  //    A composition dealer you SELL to changes nothing for you. You bill him
  //    with GST exactly as you would anybody registered, it is a B2B invoice
  //    because he has a number, and whether he can claim it back is his
  //    problem and not yours. There is nothing for the shopkeeper to do, so
  //    there is nothing to say.
  //
  //    The first version of this did not look at the role. It collected all
  //    eleven of his and told him "none of their tax can be claimed back" --
  //    and every one of the eleven was a CUSTOMER, sitting under Sundry
  //    Debtors, which the reader had placed correctly all along. The line was
  //    false about eleven names on the one screen meant to be trustworthy.
  const composition = [];
  for (const led of Object.values(leds)) {
    const rows = led.regs || [];
    if (!partyish(led.role)) continue;
    if (led.composition && led.role === 'supplier') composition.push(led.name);
    if (rows.length < 2) continue;
    dated += 1;
    const first = rows[0] || {}, now = rows[rows.length - 1] || {};
    if (!led.gstin && (first.gstin || '')) {
      withdrawn.push({ name: led.name, was: first.gstin, from: now.from || '' });
    }
    const hadNumber = !!(first.gstin || '');
    if (hadNumber && now.state && first.state && now.state !== first.state) {
      changed.push({ name: led.name, was: first.state, now: now.state, from: now.from || '' });
    }
  }

  // 4. THE BILL SAYS ONE STATE, THE LEDGER SAYS ANOTHER.
  //
  //    A Tally voucher FREEZES the party's details as they stood the day it was
  //    typed. His April freight bill from Greatx still says Delhi, because he
  //    corrected that ledger to Assam on 1 April 2026 -- after the bill was
  //    entered. Tally's own 3B left the bill out altogether; Skwik reads the
  //    frozen Delhi and makes it inter-state.
  //
  //    THERE IS NO WAY TO TELL FROM THE FILE WHICH OF THE TWO IS MEANT. A bill
  //    entered while the ledger was right should keep its own state; a bill
  //    entered before he fixed the ledger should take the ledger's. So the
  //    reader does not pick -- it leaves the bill as Tally wrote it and names
  //    the bills where the two disagree.
  const frozen = [];
  for (const b of blocksOf(xml, 'VOUCHER')) {
    const party = unesc(tagTop(b, 'PARTYLEDGERNAME') || tagTop(b, 'PARTYNAME') || '');
    if (!party) continue;
    const led = leds[party.toLowerCase()];
    if (!led || !(led.regs || []).length) continue;
    const onBill = unesc(tagTop(b, 'STATENAME') || '');
    if (!onBill) continue;
    const row = regOn(led.regs, tagTop(b, 'DATE') || '') || {};
    if (!row.state || row.state === onBill) continue;
    frozen.push({
      name: led.name,
      bill: unesc(tagTop(b, 'VOUCHERNUMBER') || '(no number)'),
      dated: tagTop(b, 'DATE') || '',
      onBill, inLedger: row.state,
    });
  }

  // ---- ONE PARTY, THE FLAG SET BOTH WAYS ----
  //
  // Tally's reverse-charge mark is set BY HAND on each bill, and a hand slips.
  // In his April and May day books, five transporter bills worth 45,450.00 have
  // the mark off while OTHER BILLS FROM THE SAME TRANSPORTER have it on:
  //
  //     Greatx                  919270       23 Apr    6,935.00
  //     Greatx                  919549       27 Apr    3,395.00
  //     Gayatri Goods Carriers  513X1537X27  23 Apr   25,990.00
  //     Gayatri Goods Carriers  513X1572X7   15 May    7,360.00
  //     S.B. Logistics          175-3632     19 May    1,770.00
  //
  // At 5% that is 2,272.50 of tax his return does not carry, and nothing in
  // Tally shows it to him -- the bills sit under the same ledger, the same
  // party, the same rate, and only the one hidden flag differs.
  //
  // NO WORDS ARE GUESSED AT. This does not look for "transport" or "freight"
  // anywhere; it was the first thing tried and it is exactly what he is right
  // to distrust. The rule is only: THIS PARTY'S OTHER BILLS ARE REVERSE CHARGE
  // AND THIS ONE IS NOT. That found all five on its own, and it travels to a
  // book full of names nobody has ever seen.
  //
  // IT ONLY SEES WHAT IS IN THE FILE. April alone catches four of the five --
  // Gayatri has no marked bill in April, so there is nothing for its unmarked
  // one to disagree with. Both months together catch all five. So the wider the
  // range he exports, the more it finds, which is worth saying to him.
  const oddFlag = [];
  let oddValue = 0;
  if (book && Array.isArray(book.vouchers)) {
    const by = new Map();
    for (const v of book.vouchers) {
      if (v.vtype !== 'purchase' || !v.party) continue;
      const k = String(v.party).toLowerCase();
      const o = by.get(k) || { name: v.party, on: 0, off: [] };
      if (v.reverse_charge) { o.on += 1; by.set(k, o); continue; }
      // A BILL THAT CARRIES ITS OWN TAX IS NOT A MISSED MARK.
      //
      // A man who sells him goods AND bills him the lorry would show up here
      // with the goods bill flagged as a slip, which it is not -- the supplier
      // charged the tax on it himself. A reverse-charge bill carries no
      // supplier tax at all, by definition: that is what reverse charge means.
      // All five of his real ones carry nought, while 94 of his 167 purchases
      // carry tax and are spared by this one line.
      if ((Number(v.cgst) || 0) + (Number(v.sgst) || 0) + (Number(v.igst) || 0) > 0) {
        by.set(k, o); continue;
      }
      o.off.push(v);
      by.set(k, o);
    }
    for (const o of by.values()) {
      if (!o.on || !o.off.length) continue;
      const value = o.off.reduce((t, v) => t + (Number(v.taxable) || 0) + (Number(v.charge) || 0), 0);
      oddValue += value;
      oddFlag.push({
        name: o.name, marked: o.on, value: Math.round(value * 100) / 100,
        bills: o.off.map((v) => ({ no: v.no, vdate: v.vdate,
          value: Math.round(((Number(v.taxable) || 0) + (Number(v.charge) || 0)) * 100) / 100 })),
      });
    }
    oddFlag.sort((a, b) => b.value - a.value);
    oddValue = Math.round(oddValue * 100) / 100;
  }

  // ---- THE FREIGHT LEDGER'S NAME AGAINST WHERE THE MAN ACTUALLY IS ----
  //
  // He asked whether Skwik should read the heading -- "FREIGHT INTRA STATE",
  // "Transport Freight Interstate & R.Charge" -- and decide inter or intra from
  // it. Measured on his own April, May and August books, over 87 reverse-charge
  // bills carrying such a name:
  //
  //     the name agrees with the supplier's real state ....  80
  //     the name is WRONG ................................   7
  //
  // All seven are ASSAM suppliers booked under the "Interstate" ledger -- six
  // Greatx bills and one S.B. Logistics. So the name is a fallback only (see
  // tallyload), and where it disagrees with a state we actually know, the bills
  // are named here. Nothing in Tally shows him this.
  // THE SHOP'S OWN STATE, OUT OF THE FILE ITSELF.
  //
  // "Inter state" means nothing without knowing where the shop is, and the
  // reader is not handed the shop's record. Tally writes the company's own
  // registration into the export -- <GSTREGNUMBER>18AHXPA8555E1ZX</> on his --
  // and the first two digits are the state. A voucher's own CMPGSTIN says the
  // same thing and is the fallback.
  //
  // The first version of this compared against `v.own_state`, a field no
  // voucher carries. It was undefined on every bill, so every local supplier
  // under an "intra state" ledger would have been reported as a disagreement --
  // a report that cries wolf on the very screen meant to be trusted.
  const ownGstin = String(tagOf(xml, 'GSTREGNUMBER') || tagOf(xml, 'CMPGSTIN') || '')
    .toUpperCase().replace(/\s/g, '');
  const homeState = /^\d\d/.test(ownGstin) ? ownGstin.slice(0, 2) : '';

  const headClash = [];
  if (homeState && book && Array.isArray(book.vouchers)) {
    for (const v of book.vouchers) {
      if (!v.reverse_charge) continue;
      const hint = (v.charge_names || []).map(headPointsTo).find(Boolean);
      if (!hint) continue;
      // Only where the supplier's state is genuinely known. With nothing to
      // compare against there is no disagreement -- and that is the one case
      // where the name is allowed to decide, in tallyload.
      const st = String(v.party_state || '').trim();
      const fromState = st ? codeForState(st) : '';
      if (!fromState) continue;
      const real = fromState === homeState ? 'cgst_sgst' : 'igst';
      if (hint !== real) {
        headClash.push({ name: v.party, bill: v.no, vdate: v.vdate,
                         state: st, ledger: (v.charge_names || [])[0] || '', hint, real });
      }
    }
  }

  const byName  = ledgers.filter((l) => l.decidedBy === 'name');
  const unknown = ledgers.filter((l) => l.decidedBy === 'nothing');

  return {
    haveTypeMasters, haveLedgerMasters,
    voucherTypes, unknownTypes,
    skippedTypes,
    ledgers, decidedByName: byName, notPlaced: unknown,
    withdrawn, changed, composition, frozen,
    oddFlag, oddValue,
    headClash,
    datedLedgers: dated,
    // the short version, for a screen that has room for one line
    worthALook: (!haveTypeMasters && unknownTypes.length > 0)
      || unknownTypes.length > 0 || byName.length > 0 || skippedTypes.length > 0
      || withdrawn.length > 0 || changed.length > 0 || frozen.length > 0
      || oddFlag.length > 0 || headClash.length > 0,
    say: [
      !haveTypeMasters && unknownTypes.length
        ? `${unknownTypes.length} voucher type(s) could not be placed, and the file carries no voucher-type masters -- export those too and they will be understood`
        : null,
      haveTypeMasters && unknownTypes.length
        ? `${unknownTypes.length} voucher type(s) Skwik has no place for: ${unknownTypes.map((t) => t.name).join(', ')}`
        : null,
      !haveLedgerMasters
        ? 'the file carries no ledger masters, so every ledger had to be judged by its name'
        : null,
      byName.length
        ? `${byName.length} ledger(s) were judged by their name rather than by the group they sit under -- worth a look`
        : null,
      ...skippedTypes.map((t) => `${t.count} ${t.name} voucher(s) were left out: ${t.why}`),
      // A DATE IN THE SENTENCE, because "Tally changed its mind" is no use
      // without saying when it changed it.
      ...withdrawn.map((w) => `${w.name} had GST number ${w.was}, and Tally withdrew it`
        + `${w.from ? ` on ${said(w.from)}` : ''} -- a number already in your books is left alone, so check that name`),
      // THREE NAMES, THEN A COUNT. His book has two of these, but a bigger one
      // could have twenty, and this list is read inside an Alert on a phone --
      // the first version of the line below it printed one line per name and
      // filled the screen with sixteen of them.
      ...changed.slice(0, 3).map((m) => `${m.name} was ${m.was} and is ${m.now}`
        + `${m.from ? ` from ${said(m.from)}` : ''} -- bills before that were worked out against ${m.was}`),
      changed.length > 3
        ? `and ${changed.length - 3} more name(s) whose registration changed the same way`
        : null,
      // ONE LINE, NOT ONE PER NAME. Forty-nine of his ledgers carry more than
      // one dated row; a line each would bury everything else on the screen.
      // What he needs to know is that the dates are being honoured.
      dated > 0
        ? `${dated} name(s) have more than one dated GST record in Tally -- each bill was read against the one in force on its own date`
        : null,
      frozen.length
        ? `${frozen.length} bill(s) carry a state that is not the one the ledger holds for that date`
          + ` (${frozen.slice(0, 3).map((f) => `${f.name} ${f.bill}: ${f.onBill} on the bill, ${f.inLedger} in the ledger`).join('; ')}`
          + `${frozen.length > 3 ? ', and more' : ''}) -- the bill was left as Tally wrote it`
        : null,
      headClash.length
        ? `${headClash.length} reverse-charge bill(s) sit under a freight ledger whose name `
          + `disagrees with where the supplier actually is -- `
          + headClash.slice(0, 3).map((h) => `${h.name} ${h.bill} (${h.state}, booked under "${h.ledger}")`).join('; ')
          + `${headClash.length > 3 ? `, and ${headClash.length - 3} more` : ''}`
          + '. Skwik went by the state, not the name, which is the safer of the two'
        : null,
      oddFlag.length
        ? `${oddFlag.reduce((t, o) => t + o.bills.length, 0)} bill(s) worth ${oddValue.toFixed(2)} are NOT marked reverse charge, `
          + `though other bills from the same name are -- `
          + oddFlag.slice(0, 3).map((o) => `${o.name} (${o.bills.map((b) => b.no).join(', ')})`).join('; ')
          + `${oddFlag.length > 3 ? `, and ${oddFlag.length - 3} more name(s)` : ''}`
          + '. Tally\'s mark is set by hand on each bill, so check these in Tally -- '
          + 'and exporting a wider date range finds more of them'
        : null,
      composition.length
        ? `${composition.length} supplier(s) are Composition in Tally, so they charge no GST and there is no input tax to claim on them: ${composition.slice(0, 6).join(', ')}${composition.length > 6 ? ', and more' : ''}`
        : null,
    ].filter(Boolean),
  };
}

export function vouchersFromTallyXml(xml) {
  const types = voucherTypesIn(xml);
  const leds = ledgersIn(xml);
  const all = blocksOf(xml, 'VOUCHER').map((b) => readVoucher(b, types, leds));

  const book = { vouchers: [], payments: [], transfers: [], counts: [],
                 cashMoves: [], journals: [], skipped: [] };
  for (const v of all) {
    if (v.kind === 'skip')          book.skipped.push(v);
    else if (v.cancelled)           book.skipped.push({ ...v, why: 'cancelled in Tally' });
    else if (!v.vdate)              book.skipped.push({ ...v, why: 'no date Skwik could read' });
    else if (v.kind === 'voucher')  book.vouchers.push(v);
    else if (v.kind === 'payment')  book.payments.push(v);
    else if (v.kind === 'transfer') book.transfers.push(v);
    else if (v.kind === 'cashmove') book.cashMoves.push(v);
    else if (v.kind === 'count')    book.counts.push(v);
    else if (v.kind === 'journal')  book.journals.push(v);
  }
  // WHAT WAS MADE OF THE FILE, carried along with it.
  //
  // Not a list of vouchers, so it is set after the book is built rather than
  // declared with the lists -- the house check that makes sure the browser page
  // carries over every list reads that literal, and a non-list in it would be
  // asked for a .push that cannot exist.
  //
  // Costs +10% on his 9.4 MB day book (860 ms to read it, 83 ms for this).
  book.reading = readingReport(xml, types, leds, book);
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
  const wontAddUp = [];
  for (const v of book.vouchers) {
    if (!v.tally_total) continue;
    const off = Math.abs(v.total - v.tally_total);
    if (off > 2) {
      // WHICH bills, not only that some. One odd bill in a year used to stop
      // the whole import, and "put it right first" is no answer when the bill
      // is a shape Skwik has not met yet. Named here, they can be left out
      // and entered by hand while the other nine hundred go in.
      if (off > 50) wontAddUp.push({ no: v.no, vdate: v.vdate, vtype: v.vtype,
        tally_type: v.tally_type, total: round2(v.total),
        tally_total: round2(v.tally_total), off: round2(off) });
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
  // A NAME THAT APPEARS ONLY ON A JOURNAL IS STILL ONE OF HIS PEOPLE.
  // Four of his suppliers are exactly that, and they had no balance in Skwik
  // at all because nothing ever looked at a journal for a name.
  (book.journals || []).forEach((j) => (j.legs || []).forEach((l) => {
    if (l.role === 'customer' || l.role === 'supplier') lookParty(l.name);
  }));
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
    stop, warn, wontAddUp,
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
