// PUTTING THE DAY BOOK INTO THE BOOKS.
//
// tallybook.js reads a Tally day book and checks it. This is the other half:
// it takes what was read and writes it — ninety bills, ninety-two receipts,
// six transfers — into a shop that may already hold some of it.
//
// Three rules govern everything here.
//
// NOTHING IS WRITTEN TWICE, EVER.
//
// A shopkeeper will import the same file twice. He will press the button
// again because the signal dropped halfway, or because he is not sure it
// worked, or because he exported a longer range and it overlaps the first.
// If that doubles his sales the books are ruined and there is no way back by
// hand. So every row carries an id worked out from Tally's own id for that
// voucher — the same voucher always produces the same id — and the database
// refuses a second write of an id it already has. Pressing the button twice
// costs him nothing but the wait.
//
// THE MASTERS COME FIRST, AND ONLY WHAT IS MISSING.
//
// A bill cannot be written until the customer and the items on it exist. Any
// name already in the shop is used as it stands and never touched; only what
// is genuinely absent is created.
//
// IT STOPS ON THE FIRST REAL REFUSAL.
//
// Carrying on after a failure leaves a half-imported month, which is worse
// than none: the totals are wrong and he has no way of knowing which half
// went in. It stops, says what failed and how far it got, and everything
// already written stays valid because each piece was written whole.

import { guessUqc } from './uqc.js';
import { STATES, codeForState } from './states.js';
import { roleForJournal } from './tallybook.js';
import { reverseChargeTax, headPointsTo,
} from './money.js';

/* ============== WHERE A NAME IS, AND WHETHER HE IS REGISTERED ==============
 *
 * Every party an import created used to be given the shop's own state and no
 * GST number. His fourteen Delhi suppliers all came in as Assam, and because
 * a supplier with no GST number cannot have charged any, the next purchase he
 * passed to one of them took no tax at all. Two lines of code, and his input
 * credit was gone.
 *
 * THE GST NUMBER IS THE BETTER ANSWER WHEN THERE IS ONE. Its first two digits
 * ARE the state, by law, so 07BFKPB0689A1ZS is Delhi whatever the file says
 * elsewhere. Failing that, the state Tally wrote. Failing both, the shop's own
 * state, which is what a walk-in customer is.
 */

// The two digits at the front of a GST number, when they are a real state.
const codeInGstin = (g) => {
  const two = String(g || '').trim().slice(0, 2);
  return /^\d\d$/.test(two) && STATES[two] ? two : '';
};

// A state's code from the name Tally wrote, e.g. "Delhi" -> "07".
const codeFor = (name) => {
  const c = codeForState(name);
  return c && STATES[c] ? String(c) : '';
};

// Where a party is, in the order the answers are worth trusting.
const stateOf = (gstin, stateName, org) =>
  codeInGstin(gstin) || codeFor(stateName) || String(org?.state_code || '');

// A GST NUMBER, AND NEVER THE SHOP'S OWN.
//
// Tally writes the shop's own registration on every voucher, more than once and
// under more than one name, and a number that is the shop's is not the party's
// -- it is only proof that the file is this shop's file. Writing it onto a
// customer would make him look registered, make his state the shop's, and put
// the shop's own number on his bill.
const cleanGstin = (g, ownGstin, org) => {
  const t = String(g || '').trim().toUpperCase();
  if (!/^[0-9]{2}[A-Z0-9]{13}$/.test(t)) return '';
  const mine = [String(ownGstin || '').trim().toUpperCase(),
                String(org?.gstin || '').trim().toUpperCase()].filter(Boolean);
  return mine.includes(t) ? '' : t;
};

/* ===================== the same id, every time ===================== */

// A TALLY GUID IS ALMOST A UUID ALREADY.
//
// Tally writes "8cba5cbd-ced9-4cce-9ed4-2aebb7e2b7f5-0000ed39": a company
// uuid, then a dash, then the voucher's own number in hex. The company part
// is the same on every voucher in the file, so it alone identifies nothing —
// the tail is what makes it unique.
//
// Folding the tail into the last field gives a real uuid that is unique per
// voucher and identical every time the same file is read. That is the whole
// mechanism behind "import it twice, nothing happens".
//
// `salt` keeps the kinds apart, so a voucher and a payment that somehow came
// from the same Tally id can never collide.
const HEX = /^[0-9a-f]+$/i;

// A TALLY GUID IS THE SAME GUID IN EVERY FIRM, and the row's id was made
// from it alone. So the second firm to be given the same Tally file tried to
// write a row whose id another firm already held -- a PRIMARY KEY clash, not
// a numbering one. save_voucher catches any unique violation and reports the
// only one it expects, so the message read:
//
//     could not write Sales 1380 of 2026-09-01:
//     Bill number 1380 is already used in your books.
//
// -- on a firm with nothing whatever in it. An hour went on the bill number.
// Reproduced since as a test: an empty second firm, the same voucher, the
// same words.
//
// The firm is part of the identity now. The same file in one firm is still
// the same rows, brought in twice and written once; the same file in another
// firm is that firm's own copy.
export function idFor(ref, salt = '') {
  const t = String(ref || '').trim().toLowerCase();
  const m = t.match(/^([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})(?:-([0-9a-f]+))?$/);
  if (m) {
    const tail = (m[6] || '').padStart(8, '0').slice(-8);
    const node = (m[5].slice(0, 4) + tail).slice(0, 12);
    const bumped = salt ? bump(m[1], salt) : m[1];
    return `${bumped}-${m[2]}-${m[3]}-${m[4]}-${node}`;
  }
  // No usable id in the file — a hand-made export, or a Tally that wrote
  // none. Hashing whatever identity the voucher does have is still stable
  // for the same file, which is what matters.
  return fromHash(t + '|' + salt);
}

// shift the first field by a few bits so two kinds cannot land on one id
const bump = (hex8, salt) => {
  let s = 0;
  for (let i = 0; i < salt.length; i++) s = (s * 33 + salt.charCodeAt(i)) >>> 0;
  const n = (parseInt(hex8, 16) ^ (s & 0xffff)) >>> 0;
  return n.toString(16).padStart(8, '0');
};

// A plain, stable, non-cryptographic hash, laid out as a uuid. It is not
// trying to be unguessable — only to be the same every time and different
// for different input.
function fromHash(text) {
  const t = String(text);
  const h = [0x811c9dc5, 0x01000193, 0x9e3779b9, 0x85ebca6b];
  for (let i = 0; i < t.length; i++) {
    for (let k = 0; k < 4; k++) {
      h[k] ^= t.charCodeAt(i) + k;
      h[k] = Math.imul(h[k], 16777619) >>> 0;
    }
  }
  const x = h.map((n) => n.toString(16).padStart(8, '0')).join('');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

export { fromHash as _hashId };

/* ===================== matching names to what is here ===================== */

export const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

const indexBy = (rows, key = 'name') => {
  const m = new Map();
  (rows || []).forEach((r) => { const k = norm(r[key]); if (k && !m.has(k)) m.set(k, r); });
  return m;
};

/* ===================== what the import will do ===================== */

// Worked out before anything is written, so the screen can say exactly what
// is about to happen and he can stop.
export function planLoad(book, have = {}) {
  const items = indexBy(have.items);
  const parties = indexBy(have.parties);
  const godowns = indexBy(have.godowns);
  const accounts = indexBy(have.accounts);

  // ONE ITEM MAY APPEAR ON TWENTY BILLS. The first line that mentions it is
  // the one that decides its unit, its HSN and its GST rate, because they are
  // the same on every line of a real file — and if they are not, the first is
  // as good an answer as any and he can correct the item afterwards.
  const newItems = new Map();
  const newParties = new Map();
  const newGodowns = new Map();

  const wantGodown = (name) => {
    const k = norm(name);
    if (!k || godowns.has(k) || newGodowns.has(k)) return;
    newGodowns.set(k, { name });
  };
  // WHAT THE FILE KNOWS ABOUT A NAME, whether or not the name is new.
  //
  // A name already in the shop is never overwritten -- but it can be FILLED
  // IN, and it has to be: he has already imported once with the old code, so
  // the names are all sitting there with no GST number and the shop's own
  // state. So the details are collected for every name the file mentions, and
  // the writer decides what to do with them.
  const knownParties = new Map();
  const noteParty = (name, v) => {
    const k = norm(name);
    if (!k) return;
    const on = knownParties.get(k) || { name };
    // The first GST number and the first state win; a later voucher for the
    // same man says the same thing.
    if (!on.gstin && v?.party_gstin) on.gstin = v.party_gstin;
    if (!on.state_name && v?.party_state) on.state_name = v.party_state;
    if (!on.own_gstin && v?.own_gstin) on.own_gstin = v.own_gstin;
    knownParties.set(k, on);
  };
  const wantParty = (name, kind, v) => {
    const k = norm(name);
    noteParty(name, v);
    if (!k || parties.has(k)) return;
    if (newParties.has(k)) return;
    newParties.set(k, { name, kind: kind || 'customer' });
  };
  const wantItem = (l) => {
    const k = norm(l.item_name);
    if (!k || items.has(k) || newItems.has(k)) return;
    newItems.set(k, {
      name: l.item_name,
      unit: guessUqc(l.unit) || 'PCS',
      hsn: l.hsn || '',
      gst_rate: Number(l.gst_rate) || 0,
      // The rate on the bill is what it sold for, which is the best first
      // guess at a selling price for a shop that has none yet.
      sale_price: Number(l.rate) || 0,
    });
  };

  for (const v of book.vouchers) {
    wantParty(v.party, v.vtype === 'purchase' || v.vtype === 'purchase_return'
      ? 'supplier' : 'customer', v);
    v.lines.forEach((l) => { wantItem(l); wantGodown(l.godown); });
  }
  for (const p of book.payments) {
    wantParty(p.party, p.party_role === 'supplier' ? 'supplier'
      : p.ptype === 'payment' ? 'supplier' : 'customer');
  }
  for (const t of book.transfers) {
    wantGodown(t.from); wantGodown(t.to);
    t.lines.forEach((l) => { wantItem(l); wantGodown(l.from); wantGodown(l.to); });
  }

  // THE ACCOUNT HE BANKED IT INTO, which may not be in Skwik yet. A deposit
  // with nowhere to land would sit on the sheet as money that left the till
  // and arrived nowhere, so the account is made if the file names one Skwik
  // has never heard of.
  // THE STORES THE OPENING STOCK NAMES.
  //
  // wantGodown only ever saw the stores on bill lines and transfers, so a
  // store that holds opening stock and nothing else -- his TRANSPORT and
  // R(3rd) -- was never made, and the stock that opened there had nowhere to
  // go.
  for (const r of (book.openingAt || [])) wantGodown(r.godown);

  const newAccounts = new Map();

  // THE BANK ACCOUNTS AS LEDGERS, WITH WHAT THEY OPENED AT.
  //
  // His stores and his customers arrived on their own; his bank account did
  // not, and he was asked to type it in by hand after importing his whole
  // book. The ledgers were in the file all along -- only the customers and
  // suppliers were being read out of them.
  // THE ACCOUNT, YES. THE FIGURE IT OPENED AT, NO.
  //
  // The masters carry an OPENINGBALANCE and a CLOSINGBALANCE per ledger, and
  // this took one of them as the account's opening. It is the wrong figure, and
  // trialbal.js has said so in writing since the day it was written:
  //
  //     Cash                             masters 3,30,041.45   trial balance 2,00,000.00
  //     Cash Credit Account Fedral Bank  masters 21,08,459.58  trial balance 23,50,069.58
  //     Bank Of Baroda                   masters 10,51,278.38  trial balance 10,51,278.38
  //
  // The masters figure is the balance at the start of the COMPANY's books, not
  // the start of the year being imported. Baroda agrees only because it has
  // never had a transaction.
  //
  // MEASURED ON HIS OWN BOOK, from the trial balance he sent on 30 September:
  //     Cash    Tally 37,32,211.26   Skwik 38,62,252.71   out by 1,30,041.45
  //     Fedral  Tally -17,65,621.42  Skwik -15,24,011.42  out by 2,41,610.00
  // and 1,30,041.45 is exactly 3,30,041.45 less 2,00,000, and 2,41,610.00 is
  // exactly 23,50,069.58 less 21,08,459.58. Both differences ARE this line.
  //
  // So the account is still made -- he should not have to type six bank names
  // in by hand -- and it is made opening at NOUGHT. A nought is visible and the
  // reconciliation page offers to fill it from the trial balance, which is the
  // only file that states the year's opening. A wrong figure is invisible and
  // sits in the cash book for ever, which is what happened.
  //
  // This is a deliberate trade: a shop that imports masters and never brings a
  // trial balance now sees its banks open at nothing. That is worse to look at
  // and better to have, because it is the truth about what Skwik knows.
  for (const b of (book.money?.banks || [])) {
    const k = norm(b.name);
    if (!k || accounts.has(k) || newAccounts.has(k)) continue;
    newAccounts.set(k, { name: b.name, opening: 0 });
  }

  // AND THE SAME FOR AN ACCOUNT ALREADY THERE: THE FIGURE IS NOT TAKEN EITHER.
  //
  // This filled in the opening of an account that was sitting at nought, from
  // the same masters figure -- so "empty my books" followed by an import put the
  // wrong opening back on every account, which is how his cash came to be out
  // by 1,30,041.45 twice over. See the note above: the masters cannot state the
  // opening of the year being imported, only the trial balance can.
  //
  // Left here as an empty list rather than deleted, because the shape is read
  // further down and by the screen that reports what an import did. Nothing is
  // put in it.
  const openAccounts = [];

  // and any account a deposit went into that the ledgers did not name
  for (const v of (book.cashMoves || [])) {
    for (const m of (v.moves || [v])) {
      const k = norm(m.account);
      if (!k || accounts.has(k) || newAccounts.has(k)) continue;
      newAccounts.set(k, { name: m.account, opening: 0 });
    }
  }



  // Whatever the file said about each name, carried onto the ones being made
  // so they are born with it rather than mended a moment later.
  for (const [k, np] of newParties) {
    const known = knownParties.get(k);
    if (known) {
      np.gstin = known.gstin || '';
      np.state_name = known.state_name || '';
      np.own_gstin = known.own_gstin || '';
    }
  }

  // ---------------------------------------------------------------------
  //  A FILE WITH NO BILLS IN IT, WHICH IS STILL A FILE WORTH BRINGING IN.
  //
  //  Tally exports masters and vouchers by separate commands, so a shopkeeper
  //  told to "export the day book and the masters" ends up with a file that
  //  holds five hundred stock items and not one voucher. Everything above
  //  counts what the BILLS mention, so such a file came out as nought of
  //  everything -- and a screen of noughts tells him he did something wrong
  //  when he did not.
  //
  //  So when the reader found nothing at all, the masters the file DOES hold
  //  are folded in here, in the shape the writer below already knows. Only
  //  then: a day book that also carries masters keeps working exactly as it
  //  was tested, because the bills are the better authority on an item that
  //  was actually billed.
  // ---------------------------------------------------------------------
  //  The caller decides what counts as masters -- and only ever hands over
  //  masters out of a file that held no bills, so a day book's own stock item
  //  blocks never get a say over the bills beside them. Everything the bills
  //  mentioned is already in the two maps above, and neither loop below
  //  overwrites a name that is in them: THE BILLS WIN, always.
  // -------------------------------------------------------------------
  //  WHAT WAS ON THE SHELF BEFORE THE FIRST BILL.
  //
  //  A Tally day book carries its own stock item blocks, and they hold the
  //  quantity and the rate the year OPENED with -- 18,049.15 Kg of Steel
  //  Utensils (A) at 189.26. Those blocks were deliberately passed over,
  //  because on an item that was actually billed the bills are the better
  //  authority on its name, its unit and its rate.
  //
  //  That was right about all of those and wrong about the one thing the bills
  //  can never know: the bills cannot tell you what was in the godown before
  //  the first of them. So every one of his 480 items opened at nought, his
  //  stock showed only what had moved since April, and 285 items had no cost
  //  at all -- which makes them worth nothing on the balance sheet and free in
  //  the profit report.
  //
  //  The opening figures are therefore read from EVERY file, separately from
  //  the question of which items get created.
  // -------------------------------------------------------------------
  const openAt = new Map();
  for (const r of (book.openings || [])) {
    const k = norm(r.name);
    if (!k) continue;
    const qty  = Number(r.opening_stock) || 0;
    const cost = Number(r.purchase_price) || 0;
    if (!qty && !cost) continue;
    const on = openAt.get(k) || { name: r.name, qty: 0, cost: 0 };
    // the first figure wins; a second file saying the same thing says the same
    if (!on.qty)  on.qty = qty;
    if (!on.cost) on.cost = cost;
    openAt.set(k, on);
  }

  const nothingBilled = !book.vouchers.length && !book.payments.length
    && !(book.transfers || []).length;
  if (book.masters) {
    for (const r of (book.masters.items || [])) {
      const k = norm(r.name);
      if (!k || items.has(k) || newItems.has(k)) continue;
      newItems.set(k, {
        name: r.name,
        unit: guessUqc(r.unit) || 'PCS',
        hsn: r.hsn || '',
        gst_rate: Number(r.gst_rate) || 0,
        // what he sells at if the file says so, otherwise what he bought at,
        // which is a better first guess than nothing
        sale_price: Number(r.sale_price) || Number(r.purchase_price) || 0,
      });
    }
    for (const r of (book.masters.parties || [])) {
      const k = norm(r.name);
      if (!k) continue;
      noteParty(r.name, { party_gstin: r.gstin, party_state: r.state_name });
      if (parties.has(k) || newParties.has(k)) continue;
      newParties.set(k, {
        name: r.name,
        kind: r.kind === 'supplier' ? 'supplier' : 'customer',
        gstin: r.gstin || '',
        state_name: r.state_name || '',
      });
    }
  }

  // THIS HAS TO COME AFTER THE NAMES ARE FINAL. The masters' own customers
  // and suppliers are added to newParties further up this function, so asking
  // "is this name a person?" any earlier than here would not yet know about
  // them -- and the whole point of the check is not to turn a person into a
  // bank account.
  // AND THE BANK EVERY RECEIPT AND PAYMENT ACTUALLY WENT THROUGH.
  //
  // This was the hole. Bank accounts were made from two places -- the bank
  // LEDGERS in a masters file, and the accounts a contra deposit touched --
  // and never from the receipts and payments themselves. So a day book
  // imported without its masters named "Bank Of Baroda" on every bank receipt,
  // no account of that name existed, and every one of them was written as
  // mode 'bank' with no bank behind it: money that is in the payments table
  // and in NO bank book, so the trial balance cannot foot and no bank
  // statement will ever reconcile.
  //
  // Found on his own live book by 1.10.39's last check: 25 entries worth
  // 8,20,400 sitting in no bank. Reproduced here from a 25-receipt day book
  // with no masters: 19 entries, 2,97,000.
  //
  // AND NOT NAMED AFTER A PERSON. When the file carries no ledger masters the
  // reader has to guess which leg is the money, and it can guess wrong -- the
  // comment in readPayment is about exactly that, "Cash Credit Account Fedral
  // Bank paid 16,500 via Mr Harsa Gowala", the two legs the wrong way round.
  // So a name that is also a customer or a supplier in this same book is never
  // turned into a bank account. Better to leave that one unplaced and say so
  // than to put a man in the list of bank accounts.
  const isAName = (k) => parties.has(k) || newParties.has(k);
  for (const p of (book.payments || [])) {
    if (p.mode !== 'bank') continue;
    const k = norm(p.account);
    if (!k || accounts.has(k) || newAccounts.has(k) || isAName(k)) continue;
    newAccounts.set(k, { name: p.account, opening: 0 });
  }
  // the same for an expense paid out of a bank
  for (const e of (book.expenses || [])) {
    if (e.mode !== 'bank') continue;
    const k = norm(e.account);
    if (!k || accounts.has(k) || newAccounts.has(k) || isAName(k)) continue;
    newAccounts.set(k, { name: e.account, opening: 0 });
  }

  // ---- and NOW the opening figures, once the list of items is final ----
  //
  // This ran before the masters were folded in, so 495 items created out of a
  // masters file were born opening at nought and had to be mended on the next
  // pass -- which is the very fault this whole change is about, reintroduced
  // one step further along. Order matters: nothing knows an item's opening
  // stock until it is known which items there are.
  // ONE OPENING, NOT TWO.
  //
  // There are two ways the opening can arrive: a flat figure on the item, and
  // a movement per store. The second is the true one -- it says WHERE the
  // stock is -- and it puts the flat figure back to nought when it writes, or
  // every view would count the stock twice.
  //
  // So when the file carries the per-store split, the flat figure is not set
  // at all. Left in, the two fought each other: every import reported six
  // hundred items still "to be filled in", filled them in, and the per-store
  // pass then had to undo it.
  const perStore = (book.openingAt || []).length > 0;

  // onto the items being created
  for (const [k, it] of newItems) {
    const o = openAt.get(k);
    if (!o) continue;
    if (!perStore && !it.opening_stock) it.opening_stock = o.qty;
    if (!it.purchase_price) it.purchase_price = o.cost;
  }

  // AND ONTO THE ONES ALREADY THERE, where the figure is missing.
  //
  // He has already imported -- five runs of it -- so 480 items sit in his
  // books opening at nought. Asking him to type them in is not an answer.
  // Only ever a blank being filled: a quantity or a cost he has entered
  // himself is left exactly as it is.
  const mendItems = [];
  for (const r of (have.items || [])) {
    const o = openAt.get(norm(r.name));
    if (!o) continue;
    const patch = {};
    // the quantity only when nothing is going to place it by store
    if (!perStore && o.qty && !Number(r.opening_stock)) patch.opening_stock = o.qty;
    if (o.cost && !Number(r.purchase_price)) patch.purchase_price = o.cost;
    if (Object.keys(patch).length) mendItems.push({ id: r.id, name: r.name, ...patch });
  }

  return {
    newItems: [...newItems.values()],
    newParties: [...newParties.values()],
    newGodowns: [...newGodowns.values()],
    // every name the file mentions, new or not, with what the file knows
    knownParties: [...knownParties.values()],
    newAccounts: [...newAccounts.values()],
    // accounts already in the books whose opening figure is still nought
    openAccounts,
    // what the file knows about the shelf before the first bill
    openings: [...openAt.values()],
    // and WHERE it was, which the flat figure above cannot say
    openingAt: book.openingAt || [],
    mendItems,
    // and what was in the till on the day the year opened
    // THE TILL'S OPENING IS NOT IN THE MASTERS EITHER. This was
    // book.money.cash.opening -- the same company-start figure as the banks, and
    // the one that made his cash book read 3,30,041.45 where Tally says
    // 2,00,000. Left as null so the till opens at nought and the trial balance
    // fills it, which is the only file that knows the year's opening.
    openingCash: null,
    bills: book.vouchers.length,
    payments: book.payments.length,
    transfers: book.transfers.length,
    // one contra can be two deposits, so this counts the MOVEMENTS and not
    // the vouchers they came out of
    cashMoves: (book.cashMoves || []).reduce((t, v) => t + ((v.moves || [v]).length), 0),
    // true when there were no bills at all and everything above came out of
    // the masters instead
    fromMasters: nothingBilled && !!book.masters
      && !!(newItems.size || newParties.size),
  };
}

/* ===================== the writing ===================== */

// Every name, every item, every store the shop has. Paged, because a shop
// past a thousand items is handed only the first thousand without a word,
// and an item it could not see would be created all over again.
export async function readMasters(supabase) {
  const page = async (table, sel, extra) => {
    const out = [];
    for (let from = 0; ; from += 1000) {
      let q = supabase.from(table).select(sel).range(from, from + 999);
      if (extra) q = extra(q);
      const { data, error } = await q;
      if (error) throw error;
      const rows = data || [];
      out.push(...rows);
      if (rows.length < 1000) break;
    }
    return out;
  };
  const [items, parties, godowns, accounts] = await Promise.all([
    // the opening stock and the cost come back too: filling in a BLANK is
    // right, writing over a figure he typed himself is not, and the only way
    // to tell them apart is to look
    page('items', 'id, name, opening_stock, purchase_price', (q) => q.eq('is_active', true)),
    page('parties', 'id, name'),
    page('godowns', 'id, name'),
    // the bank accounts too, so a deposit can find the one it went into --
    // AND WHAT EACH ONE OPENS AT, so an account that is sitting at nought can
    // be given the figure from the file instead of only ever being set at birth
    page('bank_accounts', 'id, name, opening, opening_on'),
  ]);
  return { items, parties, godowns, accounts };
}

// THE DAY THE YEAR OPENED, which is what Tally's opening figures are as at.
//
// Taken from the earliest entry in the file rather than from today: a book
// imported in September is still a book that opened in April, and dating the
// opening figure today would put it after the bills it comes before.
// WHERE STOCK GOES WHEN THE FILE DOES NOT SAY.
//
// A file with no godowns in it still has opening stock, and it has to land
// somewhere or it is not stock at all. The main store is the honest answer --
// it is the one he keeps everything in -- and it is what he expected anyway.
export function mainGodown(godowns) {
  const all = [...godowns.values()];
  const main = all.find((g) => g && g.is_main);
  return (main || all[0] || {}).id || null;
}

export function fyStart(book) {
  const days = [
    ...(book?.vouchers || []).map((v) => v.vdate),
    ...(book?.payments || []).map((p) => p.vdate),
  ].filter(Boolean).sort();
  const first = days[0];
  if (!first) return '';
  const y = Number(String(first).slice(0, 4));
  const m = Number(String(first).slice(5, 7));
  // April to March: a bill in January belongs to the year that began last April
  return `${m >= 4 ? y : y - 1}-04-01`;
}

// `onStep({ done, total, what })` is called as it goes, so a shopkeeper on a
// slow pack sees it moving rather than wondering whether the phone has hung.
export async function loadBook({ supabase, org, book, have = {}, onStep = () => {},
                                 note = 'Tally day book' }) {
  // WHAT THE SHOP HOLDS RIGHT NOW, ASKED FOR HERE AND NOT TAKEN ON TRUST.
  //
  // The screen already knows what the shop had when it drew the preview, and
  // it hands it over — but that was a minute ago, and the one case that
  // matters is a run that FAILED halfway and is being tried again. On that
  // second run the shop already holds the names and items the first run
  // created, and a list gathered before the first run does not know it. The
  // masters were then written a second time: measured on his own file, 185
  // items became 370 and 60 customers became 120.
  //
  // So the lists are read again, now, immediately before anything is created.
  // The bills, the money and the transfers were always safe — each carries an
  // id the database refuses twice — and this is the last piece that was not.
  const fresh = await readMasters(supabase).catch(() => null);
  if (fresh) have = fresh;

  const plan = planLoad(book, have);
  const total = plan.newGodowns.length + plan.newParties.length + plan.newItems.length
              + plan.newAccounts.length + (plan.openAccounts || []).length
              + plan.bills + plan.payments + plan.transfers + plan.cashMoves
              + (plan.mendItems || []).length;
  let done = 0;
  const step = (what) => { done += 1; onStep({ done, total, what }); };

  // ONE RUN, AND EVERY ROW MARKED WITH IT.
  //
  // Without this an import can be pressed but never taken back out, and the
  // only way to undo a file that went in wrong is by hand, a bill at a time.
  // The mark costs nothing and makes one button possible.
  let run = null;
  {
    const { data, error } = await supabase.rpc('import_begin',
      { p_kind: 'daybook', p_note: note });
    // AN APP THAT HAS GOT AHEAD OF ITS DATABASE SAYS SO IN WORDS HE CAN ACT ON.
    //
    // If the SQL files have not been run yet, this is the first thing that
    // fails, and "function public.import_begin does not exist" tells a
    // shopkeeper nothing. It stops rather than going ahead, on purpose: an
    // import that cannot be marked is an import that cannot be taken back
    // out, and that is exactly the press you want to be able to undo.
    if (error) {
      const missing = /does not exist|schema cache|42883|PGRST202/i.test(
        `${error.message || ''} ${error.code || ''}`);
      throw new Error(missing
        ? 'This copy of Skwik is newer than your database. Run the SQL files under '
          + 'supabase/migrations first \u2014 in the order in RUN-THESE-IN-ORDER.txt \u2014 '
          + 'then try the import again. Nothing has been written.'
        : `Could not start the import: ${error.message}`);
    }
    run = data || null;
  }

  const made = { godowns: 0, parties: 0, items: 0, bills: 0, already: 0, payments: 0,
                 transfers: 0, accounts: 0, banked: 0, opened: 0, openedAccounts: 0,
                 dates: 0, journals: 0, journalsSkipped: 0, noBank: 0, run };
  // purchases already in his books whose supplier bill number and date this
  // file can put right -- see the note where they are collected
  const putRight = [];
  const fail = (what, e) => {
    const err = new Error(`${what}: ${e?.message || e}`);
    err.made = made; err.done = done; err.total = total;
    throw err;
  };

  // ONE DROPPED REQUEST MUST NOT COST AN IMPORT OF 2,254 BILLS.
  //
  // An import is hundreds of requests over several minutes on a shop's line,
  // and on that line a request occasionally just does not arrive -- the browser
  // says "Failed to fetch", the phone says "Network request failed", and
  // neither means anything is wrong with the file or the book. Every one of
  // those was fatal: the run stopped, and whatever had not been written yet
  // had to be started again.
  //
  // So a call that fails for a reason that might not happen twice is tried
  // again, three times, waiting a little longer each time. What is NOT retried
  // is an answer from the server -- a bill number already used, a date in a
  // closed month, a login that cannot write. Those are the same answer however
  // many times you ask, and asking again just wastes the shopkeeper's evening.
  const mightPassNextTime = (e) => {
    if (!e) return false;
    // the server answered, so it will answer the same way again
    if (e.status && e.status !== 502 && e.status !== 503 && e.status !== 504) return false;
    if (e.code && /^[0-9A-Z]{5}$/.test(String(e.code)) && e.code !== 'PGRST000') return false;
    // ONE LINE, AND NO /x FLAG. A regex literal cannot span lines in
    // JavaScript and there is no such flag as x. I wrote it across two lines
    // and the file stopped parsing altogether -- and I did not notice, because
    // I ran the parse check before that edit and not after it. The check would
    // have caught it in a second. Run the ladder after the LAST change, not
    // after the last change you happen to remember.
    const BLIP = /failed to fetch|network request failed|load failed|networkerror|timeout|timed out|econnreset|socket hang up|fetch failed|50[234]|gateway/i;
    return BLIP.test(String(e.message || ''));
  };

  const nap = (ms) => new Promise((r) => setTimeout(r, ms));

  // `ask` wraps one call and hands back the same { data, error } it always did,
  // so nothing that uses it has to change shape.
  const ask = async (label, go) => {
    let last = null;
    for (let tryNo = 1; tryNo <= 3; tryNo++) {
      const r = await go();
      if (!r?.error) return r;
      last = r.error;
      if (!mightPassNextTime(r.error)) return r;
      if (tryNo < 3) { step(`${label} — the line dropped, trying again`); await nap(tryNo * 1200); }
    }
    return { data: null, error: last };
  };

  // IS THIS FUNCTION SIMPLY NOT THERE? ASKED BY STATUS, NOT BY WORDING.
  //
  // This used to read the error's TEXT -- /does not exist|PGRST202|404/ -- and
  // the app has two different clients that word things differently. The phone
  // uses supabase-js; the browser page uses web/rest.js, whose fetch says
  // "Failed to fetch" when a request never reaches the server at all. So a
  // dropped request on the web page did not look like "no such function" and
  // did not look like anything else either.
  //
  // PostgREST answers 404 with PGRST202 for a function it cannot find, and
  // rest.js already puts that on err.status and err.code. So the status is
  // asked first and the wording is only the last resort.
  const noSuchFunction = (e) => !!e && (
    e.status === 404 || e.code === 'PGRST202' || e.code === '42883'
    || /does not exist|PGRST202|could not find the function/i.test(e.message || ''));

  const godowns = indexBy(have.godowns);
  const parties = indexBy(have.parties);
  const items   = indexBy(have.items);
  const accounts = indexBy(have.accounts);

  /* ---- the stores ---- */
  for (const g of plan.newGodowns) {
    const { data, error } = await supabase.from('godowns')
      .insert({ org_id: org.id, name: g.name, is_main: godowns.size === 0, import_run: run })
      .select().single();
    if (error) fail(`could not add the store ${g.name}`, error);
    godowns.set(norm(g.name), data);
    made.godowns += 1; step(`store ${g.name}`);
  }

  /* ---- the names ---- */
  // In blocks, because ninety round trips on a mobile pack is a minute of
  // staring at a spinner and one dropped request away from stopping.
  for (let i = 0; i < plan.newParties.length; i += 50) {
    const block = plan.newParties.slice(i, i + 50).map((p) => {
      const gstin = cleanGstin(p.gstin, p.own_gstin, org);
      const code = stateOf(gstin, p.state_name, org);
      return {
        org_id: org.id, name: p.name, kind: p.kind,
        gstin: gstin || null,
        state_code: code,
        state_name: STATES[code] || org.state_name,
      };
    });
    const { data, error } = await supabase.from('parties').insert(block.map((x) => ({ ...x, import_run: run }))).select();
    if (error) fail('could not add the customers and suppliers', error);
    (data || []).forEach((r) => parties.set(norm(r.name), r));
    made.parties += block.length;
    block.forEach((p) => step(`name ${p.name}`));
  }

  /* ---- and the names that were already here, but bare ---- */
  //
  // A NAME ALREADY IN THE SHOP IS NEVER OVERWRITTEN -- except that a blank is
  // not a fact. He has already imported once with the old code, so fifty-nine
  // names sit in his books with no GST number and the wrong state. Asking him
  // to find and retype them is not an answer; importing the same file again
  // fills them in, and the bills themselves are skipped as already written.
  //
  // Only ever a blank being filled. A number he has typed himself, or a state
  // he has corrected by hand, is left exactly as it is.
  {
    const mend = [];
    for (const p of plan.knownParties || []) {
      const on = parties.get(norm(p.name));
      if (!on) continue;
      const gstin = cleanGstin(p.gstin, p.own_gstin, org);
      const code = stateOf(gstin, p.state_name, org);
      const patch = {};
      if (gstin && !String(on.gstin || '').trim()) patch.gstin = gstin;
      // The state only moves when it is still sitting on the shop's own and we
      // now know better -- never off a state he set himself.
      if (code && code !== String(on.state_code || '')
          && String(on.state_code || '') === String(org.state_code || '')
          && code !== String(org.state_code || '')) {
        patch.state_code = code; patch.state_name = STATES[code] || on.state_name;
      }
      if (Object.keys(patch).length) mend.push({ id: on.id, ...patch });
    }
    for (const m of mend) {
      const { id, ...patch } = m;
      const { error } = await supabase.from('parties').update(patch).eq('id', id);
      if (error) fail('could not fill in a customer or supplier', error);
      made.mended = (made.mended || 0) + 1;
    }
    if (mend.length) step(`${mend.length} name${mend.length === 1 ? '' : 's'} filled in`);
  }

  /* ---- the items ---- */
  for (let i = 0; i < plan.newItems.length; i += 50) {
    const block = plan.newItems.slice(i, i + 50).map((it) => ({
      org_id: org.id, name: it.name, unit: it.unit,
      hsn: it.hsn || null, gst_rate: it.gst_rate || 0,
      sale_price: it.sale_price || 0, is_active: true,
      // WHAT WAS ON THE SHELF IN APRIL, AND WHAT IT COST.
      // Dropped before, so every item opened at nought and 285 of his had no
      // cost -- worth nothing on the sheet, free in the profit report.
      opening_stock: it.opening_stock || 0,
      purchase_price: it.purchase_price || 0,
    }));
    const { data, error } = await supabase.from('items').insert(block.map((x) => ({ ...x, import_run: run }))).select();
    if (error) fail('could not add the items', error);
    (data || []).forEach((r) => items.set(norm(r.name), r));
    made.items += block.length;
    block.forEach((it) => step(`item ${it.name}`));
  }

  /* ---- and the items that were already here, opening at nought ---- */
  //
  // Same rule as the names: a blank is not a fact. He has imported five times
  // already, so his items are all sitting at nought; importing again fills
  // them in. A quantity or a cost he typed himself is never written over.
  for (const m of (plan.mendItems || [])) {
    const { id, name, ...patch } = m;
    const { error } = await supabase.from('items').update(patch).eq('id', id);
    if (error) fail(`could not fill in the opening stock of ${name}`, error);
    made.opened = (made.opened || 0) + 1;
  }
  if ((plan.mendItems || []).length) {
    step(`${plan.mendItems.length} item(s) given their opening stock`);
  }

  const idOf = (map, name) => (map.get(norm(name)) || {}).id || null;

  /* ---- the accounts, before anything that has to name one ---- */
  //
  // These used to be made at the very end, after the receipts and payments had
  // already been written -- so a receipt that came in through the bank had no
  // account to point at even in principle. Nothing can be filed against an
  // account that does not exist yet.
  for (const a of plan.newAccounts) {
    const { data, error } = await supabase.from('bank_accounts')
      // WHAT IT OPENED AT, not nought. A cash credit account opens OWING the
      // bank, so its figure is negative, and a bank book that starts at nil is
      // wrong by the whole overdraft on every line after it.
      .insert({ org_id: org.id, name: a.name, opening: Number(a.opening) || 0,
                opening_on: fyStart(book) || null,
                is_active: true, is_default: accounts.size === 0 })
      .select().single();
    if (error) fail(`could not add the bank account ${a.name}`, error);
    accounts.set(norm(a.name), data);
    made.accounts += 1; step(`account ${a.name}`);
  }

  // AND THE ACCOUNTS ALREADY THERE, STILL OPENING AT NOUGHT.
  //
  // `.eq('opening', 0)` is not belt and braces: the plan was worked out before
  // a single row was written, and if he typed a figure in between then his is
  // the one that counts.
  for (const a of (plan.openAccounts || [])) {
    const { error } = await supabase.from('bank_accounts')
      .update({ opening: a.opening, opening_on: fyStart(book) || null })
      .eq('id', a.id).eq('opening', 0);
    if (error) fail(`could not set what ${a.name} opened at`, error);
    made.openedAccounts = (made.openedAccounts || 0) + 1;
    step(`opening balance of ${a.name}`);
  }


  /* ---- the bills ---- */
  //
  // FIFTY AT A TIME, NOT ONE.
  //
  // This asked the server to write one bill, waited, then asked for the next.
  // On his own file that is 2,254 questions, and a question and its answer on
  // a shop's line is about a fifth of a second before the server has done
  // anything -- so seven or eight minutes of the import was the ASKING, not
  // the work. A wholesaler with fifty thousand bills would have waited over
  // three hours and put the phone down long before the end.
  //
  // save_vouchers takes a block of them and calls the very same save_voucher
  // on each one inside, so every rule still applies to every bill on its own:
  // the bill-number check, the stock, the bill's own receipt for a cash sale,
  // and the Tally id that stops a second import doubling his books. A bill the
  // server refuses comes back as its own refusal with its own message, and the
  // other forty-nine still go in.
  //
  // A DATABASE THAT HAS NOT HAD 1.10.40 YET has no save_vouchers, and the
  // import must still work on it -- so the first block that comes back with
  // "does not exist" drops back to one bill at a time for the whole run.
  const BLOCK = 50;
  let blockWise = true;
  let pending = [];

  // what to do with one answer, whichever way it was asked for
  const took = (v, data) => {
    if (data && data.already) {
      made.already += 1;
      // THE ONE THING WORTH CHANGING ON A BILL ALREADY WRITTEN.
      //
      // save_voucher recognises Tally's GUID and writes a voucher once, which
      // is what stops a file imported twice from doubling his books. But
      // every purchase imported before 1.10.26 carries the day it was ENTERED
      // as the supplier's bill date, because the reader never looked at
      // REFERENCEDATE -- and the whole GSTR-2B comparison turns on that date.
      //
      // The alternative was to undo the import and run it again: hundreds of
      // bills, receipts and payments taken out and put back, to correct two
      // columns that no figure in his books depends on. So they are corrected
      // where they stand instead, on the way past. Collected here and sent in
      // one go below, because one round trip per bill is a long wait on a
      // shop's phone.
      if (v.vtype === 'purchase' && data.id && (v.sup_no || v.sup_date)) {
        putRight.push({ id: data.id, no: v.sup_no || null, date: v.sup_date || null });
      }
    } else made.bills += 1;
    step(`bill ${v.no}`);
  };

  // one bill on its own, which is what an older database gets
  const sendOne = async ({ v, payload }) => {
    const { data, error } = await ask(`bill ${v.no}`,
      () => supabase.rpc('save_voucher', { p: payload }));
    if (error) fail(`could not write ${v.tally_type} ${v.no} of ${v.vdate}`, error);
    took(v, data);
  };

  const flush = async () => {
    if (!pending.length) return;
    const block = pending;
    pending = [];
    if (blockWise) {
      const { data, error } = await ask(`${block.length} bills`,
        () => supabase.rpc('save_vouchers', { p: block.map((b) => b.payload) }));
      if (error && noSuchFunction(error)) {
        // an older database: from here on, one at a time
        blockWise = false;
      } else if (error) {
        fail('could not write the bills', error);
      } else {
        const answers = Array.isArray(data) ? data : [];
        for (let k = 0; k < block.length; k++) {
          const a = answers[k];
          const { v } = block[k];
          if (!a || a.ok === false) {
            fail(`could not write ${v.tally_type} ${v.no} of ${v.vdate}`,
                 { message: a?.why || 'the server said nothing about this bill' });
          }
          took(v, a);
        }
        return;
      }
    }
    for (const b of block) await sendOne(b);
  };

  for (const v of book.vouchers) {
    const lines = v.lines.map((l) => {
      const rate = Number(l.rate) || 0;
      const qty = Number(l.qty) || 0;
      const taxable = Number(l.amount) || round2(qty * rate);
      const gst = Number(l.gst_rate) || 0;
      // Which way the tax splits is decided by the bill, not by the line:
      // a bill that carried IGST carried it on every line.
      const inter = v.igst > 0;
      const tax = round2(taxable * gst / 100);
      return {
        item_id: idOf(items, l.item_name),
        item_name: l.item_name,
        hsn: l.hsn || null,
        unit: guessUqc(l.unit) || null,
        qty, rate, gst_rate: gst,
        taxable,
        cgst: inter ? 0 : round2(tax / 2),
        sgst: inter ? 0 : round2(tax / 2),
        igst: inter ? tax : 0,
        // THE TAX COUNTED TWICE, ON EVERY IMPORTED BILL.
        //
        // This was `taxable + tax`. Everywhere else in Skwik a line's `amount`
        // IS its taxable value -- computeBill writes `amount: t` where t is the
        // line net of discount, and the printed bill puts that in the amount
        // column and then adds the tax rows underneath it. So a line with the
        // tax already inside it was taxed a second time by the paper:
        //
        //     10 pc at 500      goods 5,000
        //     stored as          amount 5,250     <- tax already in
        //     printed as         5,250 + 125 + 125 = 5,500
        //     Tally says                            5,250
        //
        // Measured on his own day book: 74 of his 90 bills printed wrong, his
        // bill 1380 at 41,632.79 against Tally's 38,855.00. The bill's own
        // stored total was right all along, which is why his reports looked
        // fine and only the paper was wrong.
        amount: taxable,
        batch: l.batch || null,
        godown_id: idOf(godowns, l.godown),
      };
    });

    // THE TAX ON A REVERSE-CHARGE BILL IS NOT WRITTEN ON THE BILL.
    //
    // A transporter's bill under reverse charge carries no tax ledger, because
    // the tax is HIS to pay rather than the transporter's to collect. This read
    // the tax straight off the voucher -- `cgst: v.cgst` and so on -- so it read
    // nothing, and rcm_summary, which reads what was stored, reported nothing:
    //
    //     GSTR-3B 3.1(d) on reverse charge   2,76,194.00  +  0.00
    //     To pay in cash                                     0.00
    //
    // against Tally's own 3B for the same month, which said 12,344.62. Over
    // April to August his Tally carries 49,848.83 of this tax and Skwik carried
    // nought. It is not a rounding: section 49(4) says reverse-charge tax must
    // be paid in CASH and cannot come out of the credit balance, so a nil here
    // is a return filed short on the one figure that has to be paid over.
    //
    // MEASURED, NOT ASSUMED. His own day book, run through this very function:
    //
    //     59-3405   3,340.00   rate 5%   tax stored 0.00   should be 167.00
    //     59-3399   2,426.00   rate 5%   tax stored 0.00   should be 121.30
    //     15 of 15 bills: value exact, rate present, tax nought
    //
    // The rate is already here. Tally writes it on the freight ledger's own
    // leg -- <GSTRATE>5</GSTRATE> with <GSTRATEDUTYHEAD>IGST</GSTRATEDUTYHEAD>
    // -- and the reader already carries it through as `charge_rate`. So this
    // does the multiplication the import was not doing.
    //
    // IT ONLY EVER FILLS IN A MISSING TAX. The first version of the diagnostic
    // I wrote for this multiplied every reverse-charge bill by its rate, and on
    // a test book that turned a bill legitimately carrying 120.00 of tax into
    // 0.00, because that bill had a tax and no rate. A bill that states its own
    // tax is left exactly as it is.
    //
    // `total` is NOT touched. What he handed the transporter does not change --
    // the tax is owed to the government, not to the transporter, and 1.9.8 says
    // so where the column was added.
    const inState = stateOf(cleanGstin(v.party_gstin, v.own_gstin, org), v.party_state, org)
                    === String(org.state_code || '');
    // THE LEDGER'S NAME, ONLY WHEN THERE IS NOTHING BETTER.
    //
    // Where a reverse-charge bill names neither a GST number nor a state,
    // `stateOf` falls back to the shop's own and the bill becomes local by
    // default. The freight ledger's own name is a better guess than that --
    // "FREIGHT INTRA STATE", "Transport Freight Interstate & R.Charge".
    //
    // A GUESS, AND NEVER MORE. Measured over his April, May and August books,
    // 87 reverse-charge bills carried such a name: it agreed with the
    // supplier's real state on 80 and was WRONG on 7, every one of them an
    // Assam supplier booked under the "Interstate" ledger. So it is used only
    // where the state is genuinely unknown -- 0 of his 66 bills -- and where
    // the two disagree the reading report names the bills instead.
    const headHint = (v.reverse_charge && !cleanGstin(v.party_gstin, v.own_gstin, org)
                      && !codeFor(v.party_state))
      ? (v.charge_names || []).map(headPointsTo).find(Boolean) || null
      : null;
    const taxMode = v.igst > 0 ? 'igst'
                  : (v.cgst || v.sgst) ? 'cgst_sgst'
                  : v.reverse_charge ? (headHint || (inState ? 'cgst_sgst' : 'igst'))
                  : 'none';
    let vCgst = Number(v.cgst) || 0;
    let vSgst = Number(v.sgst) || 0;
    let vIgst = Number(v.igst) || 0;
    const rcmBase = round2(Number(v.taxable || 0) + Number(v.charge || 0));
    const rcmRate = Number(v.charge_rate) || 0;
    if (v.reverse_charge && !(vCgst || vSgst || vIgst) && rcmRate > 0 && rcmBase > 0) {
      // `charge_rate` is the WHOLE rate on the supply, not the half Tally prints
      // against each duty head -- the reader takes it off the line's gst_rate,
      // and his freight comes through as 5, not 2.5.
      //
      // The arithmetic itself is in money.js, next to computeBill, so it rounds
      // the same way the rest of the book does and so it can be tested with
      // real figures -- this file cannot be loaded outside the app, and a rule
      // that reads the source for a pattern passes the moment somebody renames
      // a variable.
      const t = reverseChargeTax(rcmBase, rcmRate, taxMode);
      vCgst = t.cgst; vSgst = t.sgst; vIgst = t.igst;
    }

    const payload = {
      id: idFor(v.ref || `${v.vtype}|${v.no}|${v.vdate}|${v.party}`, `voucher|${org.id}`),
      vtype: v.vtype,
      vdate: v.vdate,
      voucher_no: v.no || null,
      party_id: v.is_cash ? null : idOf(parties, v.party),
      printed_name: v.party || 'CASH',
      is_cash: !!v.is_cash,
      // THE BILL'S TAXABLE VALUE INCLUDES WHAT RIDES ON IT.
      //
      // computeBill folds freight into the bill's taxable value, because under
      // section 15(2) it is part of the value of the supply. The import did not,
      // so a bill with freight on it stored a taxable value short by the
      // freight -- which is the figure the profit report and GSTR-1 both read.
      // And any other charge loaded onto a stock item was counted in `total`
      // and stored nowhere at all, so the bill did not add up to itself.
      taxable: round2(Number(v.taxable || 0) + Number(v.charge || 0)),
      cgst: vCgst, sgst: vSgst, igst: vIgst,
      round_off: v.round_off, total: v.total,
      extra_amount: v.charge || 0,
      extra_gst_rate: v.charge_rate || 0,
      extra_note: v.charge ? (v.freight ? 'Freight' : 'Charges') : null,
      // A TRANSPORTER'S BILL IS NOT A BILL WITH NO TAX ON IT.
      // Sixteen of his purchases are freight under reverse charge: the party's
      // leg equals the bill and there is no tax ledger, because the tax is his
      // own to pay. Read as an ordinary bill it looked untaxed; marked here, it
      // reaches GSTR-3B where it belongs.
      reverse_charge: !!v.reverse_charge,
      tax_mode: taxMode,
      // Place of supply, which no imported bill had.
      place_of_supply_code: codeFor(v.place_of_supply)
        || (v.vtype === 'purchase' ? String(org.state_code || '')
            : stateOf(cleanGstin(v.party_gstin, v.own_gstin, org), v.party_state, org)) || null,
      notes: v.narration || null,
      // A purchase keeps the supplier's own bill number and HIS date, not the
      // day it was entered. See the note in tallybook.js: falling back to the
      // entry date moved every late-entered bill into the wrong month and the
      // 2B comparison then blamed suppliers who had filed on time. The
      // fallback stays for a file that carries neither, because a bill with no
      // date at all matches nothing.
      supplier_invoice_no: v.vtype === 'purchase' ? (v.sup_no || v.no || null) : null,
      supplier_invoice_date: v.vtype === 'purchase' ? (v.sup_date || v.vdate) : null,
      lines,
    };

    pending.push({ v, payload: { ...payload, import_run: run } });
    if (pending.length >= BLOCK) await flush();
  }
  await flush();

  // and in blocks, so a year of purchases is a handful of calls
  for (let i = 0; i < putRight.length; i += 200) {
    const { data: n, error } = await ask('the supplier bill dates',
      () => supabase.rpc('patch_supplier_ref', { p: putRight.slice(i, i + 200) }));
    // AN OLDER DATABASE SIMPLY HAS NOTHING TO PUT RIGHT, and the import it
    // has just finished is sound either way -- this corrects bills written
    // before, it does not write any.
    // AND THIS IS TIDYING TOO. It corrects two columns on purchases already in
    // the book; it writes nothing new. An older database has no such function,
    // and a dropped request is not a reason to throw away an import that has
    // already landed.
    if (error && !noSuchFunction(error)) {
      made.datesFailed = (made.datesFailed || 0) + putRight.slice(i, i + 200).length;
    }
    made.dates += Number(n || 0);
  }

  /* ---- the money ---- */
  for (let i = 0; i < book.payments.length; i += 50) {
    const block = book.payments.slice(i, i + 50).map((p) => ({
      id: idFor(p.ref || `${p.ptype}|${p.no}|${p.vdate}|${p.party}|${p.amount}`, `payment|${org.id}`),
      org_id: org.id,
      ptype: p.ptype,
      party_id: idOf(parties, p.party),
      pdate: p.vdate,
      mode: p.mode === 'cash' ? 'cash' : 'bank',
      // WHICH BANK, NOT JUST "A BANK".
      //
      // The account's name was written into the note and nowhere else, so
      // every imported bank receipt and payment had no account against it. The
      // firm's total was right and every individual account showed its opening
      // balance with nothing underneath -- which is what a bank book is FOR.
      account_id: p.mode === 'cash' ? null : idOf(accounts, p.account),
      amount: p.amount,
      note: p.narration || (p.account ? `From Tally · ${p.account}` : 'From Tally'),
      import_run: run,
    }));
    // ignoreDuplicates is what makes a second import a no-op rather than a
    // second set of receipts.
    const { error } = await ask(`${block.length} receipts and payments`,
      () => supabase.from('payments')
        .upsert(block, { onConflict: 'id', ignoreDuplicates: true }));
    if (error) fail('could not write the receipts and payments', error);

    // AND THE ONES ALREADY IN THE BOOKS, WITH NO ACCOUNT AGAINST THEM.
    //
    // The upsert above leaves a row it has seen before exactly as it is, which
    // is what makes a second import a no-op -- but it also means the three and
    // a half thousand receipts already imported would keep their blank account
    // for ever. Only a BLANK is filled; an account he has set himself stands.
    //
    // AND IN ONE CALL, NOT ONE PER RECEIPT. On his own file this was about
    // fourteen hundred round trips to fill in a column, which on a shop's line
    // is nearly five minutes of nothing but asking. fill_payment_account does
    // the same thing -- and makes the same promise, that only a BLANK is
    // filled -- for a whole block at once.
    const mend = block.filter((x) => x.account_id && x.mode === 'bank')
      .map((x) => ({ id: x.id, account_id: x.account_id }));
    if (mend.length) {
      const { error: e2 } = await ask('which bank they went through',
        () => supabase.rpc('fill_payment_account', { p: mend }));
      if (e2 && noSuchFunction(e2)) {
        // a database without 1.10.40: one at a time, the way it used to be
        for (const x of mend) {
          const { error: e3 } = await supabase.from('payments')
            .update({ account_id: x.account_id }).eq('id', x.id).is('account_id', null);
          if (e3) { made.noBank += 1; break; }
        }
      } else if (e2) {
        // FILLING IN WHICH BANK IS TIDYING, NOT THE IMPORT.
        //
        // This called fail(), which throws and stops the whole run. His import
        // died on "could not say which bank a receipt went through: Failed to
        // fetch" -- one dropped request, after the bills, the items, the names
        // and the receipts themselves were all safely in. A column that says
        // which bank a receipt went through is worth having; it is not worth
        // throwing away an import of 2,254 bills for.
        //
        // The receipts are written BEFORE this runs, so they are already in the
        // book. It is counted and reported instead, and a second run of the
        // same file fills them in -- fill_payment_account only ever fills a
        // blank, so running it again is safe and finishes the job.
        made.noBank += mend.length;
      }
    }
    made.payments += block.length;
    block.forEach((p) => step(`${p.ptype} of ${p.pdate}`));
  }

  /* ---- the goods moved between stores ---- */
  for (const t of book.transfers) {
    const from = idOf(godowns, t.from);
    const to = idOf(godowns, t.to);
    if (!from || !to) { step('transfer'); continue; }
    const lines = t.lines
      .map((l) => ({ item_id: idOf(items, l.item_name), qty: Number(l.qty) || 0,
                     batch: l.batch || null }))
      .filter((l) => l.item_id && l.qty > 0);
    if (!lines.length) { step('transfer'); continue; }
    const { error } = await ask(`the goods moved on ${t.vdate}`,
      () => supabase.rpc('transfer_stock', {
        p: { from_godown: from, to_godown: to, mdate: t.vdate, lines,
             ref: idFor(t.ref || `${t.vdate}|${t.from}|${t.to}`, `transfer|${org.id}`),
             import_run: run },
      }));
    if (error) fail(`could not move the goods of ${t.vdate}`, error);
    made.transfers += 1;
    step(`transfer of ${t.vdate}`);
  }

  /* ---- and the journals, which used to be thrown away ---- */
  //
  // Every one of them was refused, on the reasoning that a general journal
  // can put a figure anywhere. On his own book that cost four suppliers'
  // whole balances, a transporter out by 19,500 and 45,874.86 of cash. Skwik
  // has a journal of its own now, so each leg lands where it belongs: a
  // party against his ledger, the till, a bank, or a ledger made on the spot
  // and named after the file it came out of.
  for (const j of book.journals || []) {
    const legs = (j.legs || []).map((l) => {
      const base = { amount: l.amount, note: l.name };
      if (l.role === 'cash') return { ...base, cash: true };
      if (l.role === 'bank') return { ...base, account: l.name };
      if (l.role === 'customer' || l.role === 'supplier') {
        // only if he really is one of his people by now; otherwise the leg
        // still lands, as a ledger of his own name, rather than being lost
        return idOf(parties, l.name)
          ? { ...base, party: l.name }
          : { ...base, ledger: l.name, group: l.group, role: roleForJournal(l.group) };
      }
      return { ...base, ledger: l.name, group: l.group, role: roleForJournal(l.group) };
    });
    const { data, error } = await ask(`the journal of ${j.vdate}`,
      () => supabase.rpc('save_journal', {
        p: { id: idFor(j.ref || `journal|${j.no}|${j.vdate}|${j.said || ''}`, `journal|${org.id}`),
             date: j.vdate, no: j.no || null, narration: j.narration || null,
             legs, import_run: run },
      }));
    // AN OLDER DATABASE HAS NO JOURNAL TO WRITE TO, and the rest of the
    // import is sound without it -- so it is counted as passed over rather
    // than stopping a year of bills.
    if (error) {
      if (/does not exist/i.test(error.message || '')) { made.journalsSkipped += 1; continue; }
      fail(`could not write the journal of ${j.vdate}`, error);
    }
    if (data && data.already) made.already += 1; else made.journals += 1;
    step(`journal of ${j.vdate}`);
  }

  /* ---- the opening stock, into the store it is actually in ---- */
  //
  // This goes through a function rather than a plain insert because stock
  // movements are written by the server or not at all -- a movement made by
  // hand skips everything that makes a movement true. The function also puts
  // items.opening_stock back to nought for each item it writes, or the stock
  // would be counted twice: every view reads the flat figure PLUS the
  // movements.
  if ((plan.openingAt || []).length) {
    const on = fyStart(book) || null;
    const rows = [];
    for (const r of plan.openingAt) {
      const item = idOf(items, r.name);
      if (!item) continue;
      const god = r.godown ? idOf(godowns, r.godown)
                           : (mainGodown(godowns) || null);
      rows.push({ item, godown: god, qty: Number(r.qty) || 0, cost: Number(r.cost) || 0 });
    }
    for (let i = 0; i < rows.length; i += 200) {
      const { error } = await supabase.rpc('set_opening_stock',
        { p: { mdate: on, rows: rows.slice(i, i + 200) } });
      // AN APP AHEAD OF ITS DATABASE SAYS SO IN WORDS HE CAN ACT ON.
      if (error) {
        const missing = /does not exist|schema cache|42883|PGRST202/i.test(
          `${error.message || ''} ${error.code || ''}`);
        fail(missing
          ? 'the opening stock needs the newest SQL: run 1.10.7-opening-by-godown.sql'
          : 'could not set the opening stock', error);
      }
    }
    made.openedAt = rows.length;
    step(`${rows.length} opening quantit(y/ies) placed in their stores`);
  }

  /* ---- what was in the till when the year opened ---- */
  //
  // Only ever filled in, never written over: a figure he has typed himself is
  // his. Without it the cash book begins at nil and every figure after it is
  // short by the same amount -- which is exactly what the Accounts screen
  // already warns about, and exactly what an import should not leave him to do
  // by hand after bringing in two thousand bills.
  if (plan.openingCash && !Number(org.opening_cash || 0)) {
    const { error } = await supabase.from('orgs')
      .update({ opening_cash: plan.openingCash, opening_cash_on: fyStart(book) || null })
      .eq('id', org.id);
    if (error) fail('could not set the opening cash', error);
    made.openingCash = plan.openingCash;
    step(`opening cash ${plan.openingCash}`);
  }

  /* ---- the money he banked, and took back out ---- */
  //
  // A deposit is one movement with two ends -- out of the till, into the
  // account -- so it is one row, and the database refuses the same day, amount,
  // account and direction twice. That is what makes pressing the import again
  // safe: the bills are already skipped by their own ids, and a deposit is
  // skipped by being the same deposit.
  // THE SAME DEPOSIT TWICE IS NOT AN ERROR -- AND SHOULD NOT LOOK LIKE ONE.
  //
  // This inserted one at a time and let the database refuse a repeat by its own
  // unique index, then ignored the refusal. Right in the books, wrong on the
  // screen: every ignored repeat went out as a real request that came back 400,
  // so a second import of the same file filled the browser's console with
  // "Failed to load resource: 400 (Bad Request)" and the page looked like it
  // was failing while it was working perfectly.
  //
  // Now each deposit gets an id worked out from the deposit itself -- the same
  // trick bills and receipts already use -- so the SAME deposit is the same row
  // and the server is asked to ignore a repeat rather than refuse it. No 400,
  // and one call a block instead of one a deposit.
  //
  // The tolerance stays for a book imported before this change, whose deposits
  // were written with random ids and will still trip the unique index.
  const banked = [];
  for (const v of (book.cashMoves || [])) {
    for (const m of (v.moves || [v])) {
      banked.push({
        id: idFor(m.ref || `${v.vdate}|${m.direction}|${m.amount}|${m.account || ''}`,
                  `cashmove|${org.id}`),
        org_id: org.id,
        direction: m.direction,
        mdate: v.vdate,
        amount: m.amount,
        account_id: idOf(accounts, m.account),
        note: v.narration || (m.direction === 'deposit' ? 'paid into bank' : 'taken from bank'),
        import_run: run,
      });
    }
  }
  for (let i = 0; i < banked.length; i += 50) {
    const block = banked.slice(i, i + 50);
    const { error } = await ask(`${block.length} deposits and withdrawals`,
      () => supabase.from('cash_moves')
        .upsert(block, { onConflict: 'id', ignoreDuplicates: true }));
    if (error && !/duplicate key|unique constraint|23505/i.test(
        `${error.message || ''} ${error.code || ''}`)) {
      fail('could not record the money banked', error);
    }
    if (!error) made.banked += block.length;
    block.forEach((m) => step(`banked ${m.amount}`));
  }

  // THE RUN IS CLOSED, with what it actually brought in written on it. That
  // is what the History tab reads back, and what the undo button counts.
  if (run) {
    await supabase.rpc('import_end', { p_run: run, p_counts: {
      bills: made.bills, already: made.already, money: made.payments,
      moves: made.transfers, items: made.items, names: made.parties,
      godowns: made.godowns, banked: made.banked,
      accounts: made.accounts, opened: made.opened } }).catch(() => {});
  }

  // WHAT THE READER MADE OF THE FILE, carried out to whoever called.
  //
  // Not a count of anything written -- a note on how the file was understood,
  // so the screen can say "two ledgers were judged by their name, have a look"
  // instead of leaving it to be discovered months later in a return. Absent on
  // a book built some other way, so the screen must cope with it missing.
  return { ...made, total, done, reading: book.reading || null };
}

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
