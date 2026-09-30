// READING A TALLY TRIAL BALANCE, AND HOLDING IT BESIDE SKWIK'S OWN FIGURES.
//
// Every fault of the last month was found the same way: he looked at a figure,
// knew it was wrong, and told me. His customer will not do that. A shopkeeper
// who cannot check the arithmetic needs the app to check it for him, against
// the one book he already trusts — his Tally.
//
// So this reads the Trial Balance he exports and puts it next to what Skwik
// holds. One line at the bottom says whether they agree.
//
// WHY THE TRIAL BALANCE AND NOT THE LEDGER MASTERS.
//
// The masters carry an OPENINGBALANCE per ledger, and it is tempting to read
// the opening position from there. It is wrong. That figure is the balance at
// the start of the COMPANY's books, not the start of the year exported — so
// every ledger that has ever moved carries a stale number. Measured on his own
// two files on 28 September 2026:
//
//     Cash                              masters 3,30,041.45   trial balance 2,00,000.00
//     Cash Credit Account Fedral Bank   masters 21,08,459.58   trial balance 23,50,069.58
//     Bank Of Baroda                    masters 10,51,278.38   trial balance 10,51,278.38
//
// Baroda agrees only because it has never had a transaction. The other two are
// out by 1,30,041 and 2,41,610 — plausible-looking, and wrong, on the two
// accounts that matter most. The trial balance states the opening outright.
//
// WHAT THE FILE LOOKS LIKE. Tally writes the Trial Balance as a flat run of
// name/figures pairs, and it is UTF-16 unless he chose otherwise:
//
//     <DSPACCNAME><DSPDISPNAME>Bank Of Baroda</DSPDISPNAME></DSPACCNAME>
//     <DSPACCINFO>
//       <DSPOPAMT><DSPOPAMTA>-1051278.38</DSPOPAMTA></DSPOPAMT>
//       <DSPDRAMT><DSPDRAMTA></DSPDRAMTA></DSPDRAMT>
//       <DSPCRAMT><DSPCRAMTA></DSPCRAMTA></DSPCRAMT>
//       <DSPCLAMT><DSPCLAMTA>-1051278.38</DSPCLAMTA></DSPCLAMT>
//     </DSPACCINFO>
//
// There is no group in it — nothing says Baroda is a bank and Akash Sahu is a
// customer. That comes from the masters. So the trial balance answers "how
// much" and the masters answer "what is it", and a full reconciliation wants
// both. Without the masters this still works for the money accounts, which are
// matched by the names Skwik already holds.

import { cleanText } from './transfer.js';

/* ===================== reading the file ===================== */

// Tally writes a debit negative and a credit positive. A shopkeeper reads
// "what I have" as positive and "what I owe" as negative, which is the other
// way round, so every figure is turned over as it is read. Nothing downstream
// has to remember this.
const flip = (v) => (v === null ? null : Math.round(-v * 100) / 100);

const num = (s) => {
  const t = String(s == null ? '' : s).trim();
  if (t === '') return null;
  const n = Number(t.replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
};

const inner = (block, tag) => {
  const m = block.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i'));
  return m ? m[1] : '';
};

// AN EMPTY FILE IS NOT A SHOP WITH NOTHING IN IT.
//
// A wrong export, a report that was on screen instead of the trial balance, a
// file that never finished downloading — all of them arrive as a file with no
// rows in it, and a reconciliation that says "everything agrees" would be the
// worst possible answer.
export function trialBalanceFromXml(xml) {
  const text = cleanText(xml || '');

  // EACH LEDGER'S FIGURES ARE THE ONES THAT FOLLOW ITS OWN NAME.
  //
  // This gathered every name into one list and every set of figures into
  // another, then paired them by POSITION -- names[3] with infos[3] -- and
  // guarded it by checking only that the two lists were the same LENGTH.
  //
  // Equal lengths do not mean the two lists line up. One row that carries its
  // figures somewhere the other rows do not, one group heading with figures of
  // its own, one ledger whose figures are missing and another with two sets:
  // the counts still match and every row from that point on is reading somebody
  // else's balance. And it fails SILENTLY, as a wrong figure rather than an
  // error -- which is the worst way for a reconciliation to be wrong, because
  // the whole purpose of it is to be believed.
  //
  // So a name is now paired with the figures that come AFTER it in the file and
  // BEFORE the next name. That is what the file itself says they belong to, and
  // it cannot drift. A name with no figures before the next name is reported as
  // unreadable rather than quietly given the next ledger's numbers.
  const nameAt = [...text.matchAll(/<DSPDISPNAME>([\s\S]*?)<\/DSPDISPNAME>/gi)]
    .map((m) => ({ name: m[1].trim(), at: m.index }));
  const infoAt = [...text.matchAll(/<DSPACCINFO>([\s\S]*?)<\/DSPACCINFO>/gi)]
    .map((m) => ({ body: m[1], at: m.index }));

  const names = nameAt.map((n) => n.name);
  const infos = nameAt.map((n, i) => {
    const stop = i + 1 < nameAt.length ? nameAt[i + 1].at : Infinity;
    const mine = infoAt.find((f) => f.at > n.at && f.at < stop);
    return mine ? mine.body : null;
  });
  const unreadable = names.filter((_, i) => infos[i] === null);

  if (!names.length) {
    return {
      rows: [],
      why: /<ENVELOPE/i.test(text)
        ? 'That is a Tally file, but not a Trial Balance — it has no ledger lines in it. '
          + 'In Tally: Display → Trial Balance, then Export, and pick XML.'
        : 'That does not look like a Tally export at all. In Tally: Display → Trial '
          + 'Balance, then Export, and pick XML.',
    };
  }
  // SAID OUT LOUD WHEN A LEDGER HAS NO FIGURES OF ITS OWN, rather than handing
  // it the next one's. A few of these is normal -- a group heading with nothing
  // under it -- but if most of the file reads this way it is not a Trial
  // Balance and the shop should be told so.
  if (unreadable.length && unreadable.length > names.length / 2) {
    return { rows: [], why: `${unreadable.length} of the ${names.length} ledger name(s) in `
      + 'that file have no figures against them, so it cannot be read safely. In Tally: '
      + 'Display \u2192 Trial Balance, then Export, and pick XML.' };
  }

  const rows = names.map((name, i) => {
    const b = infos[i] || '';
    return {
      name,
      // WAS THERE AN OPENING COLUMN AT ALL? A missing tag reads as nought, and
      // nought is a real opening figure -- so without this, a trial balance
      // exported with the opening column turned off would look like every
      // account opening at nothing, and offering to "put right" a figure to
      // nought would wipe the one that was correct.
      hasOpening: /<DSPOPAMT>/i.test(b),
      opening: flip(num(inner(inner(b, 'DSPOPAMT'), 'DSPOPAMTA'))),
      debit:   flip(num(inner(inner(b, 'DSPDRAMT'), 'DSPDRAMTA'))),
      credit:  flip(num(inner(inner(b, 'DSPCRAMT'), 'DSPCRAMTA'))),
      closing: flip(num(inner(inner(b, 'DSPCLAMT'), 'DSPCLAMTA'))),
    };
  });

  // A TRIAL BALANCE THAT DOES NOT BALANCE IS NOT ONE.
  //
  // Every debit has a credit, so the closing figures add to nought. If they do
  // not, the export was partial — a group was collapsed, a filter was on — and
  // comparing against it would produce differences that are the file's fault.
  const sum = rows.reduce((t, r) => t + (r.closing || 0), 0);
  const off = Math.round(sum * 100) / 100;

  return {
    rows,
    total: off,
    balances: Math.abs(off) < 1,
    why: Math.abs(off) < 1 ? '' :
      `The figures in this file add up to ${off.toFixed(2)} instead of nought, so it is `
      + 'not a whole trial balance — something was filtered or collapsed when it was '
      + 'exported. Export it again with every group open.',
  };
}

/* ===================== what Skwik keeps, and what it does not ===================== */

// SKWIK IS A BILLING BOOK, NOT A SET OF FINAL ACCOUNTS.
//
// His Tally holds Capital, Drawings, CGST, IGST, freight, insurance, bank
// charges, interest — his accountant's ledgers. Skwik keeps none of them and
// should not pretend to. Listing them as differences would bury the four lines
// that matter under eighteen that are correct by design.
const NOT_OURS = [
  /^capital/i, /^drawings/i, /^(c|s|i)gst\b/i, /^sgst/i, /^opening stock$/i,
  /^closing stock$/i, /^advance tax/i, /^gst cash ledger/i, /^round off/i,
  /^profit/i, /^duties/i, /charges$/i, /^interest on/i, /insurance/i,
  /^internet/i, /freight/i, /^discount/i, /^salary/i, /^rent$/i,
  /^packing/i, /^bills to (come|make)/i, /input$/i, /output$/i,
  // what he sold and what he bought are totals Skwik works out from the bills
  // themselves; they are not accounts it keeps
  /^sales?$/i, /^purchases?$/i, /^sales? accounts?$/i, /^purchase accounts?$/i,
  /^sales? return/i, /^purchase return/i, /^cess$/i, /^tcs\b/i, /^tds\b/i,
];
export const skwikKeeps = (name) => !NOT_OURS.some((re) => re.test(String(name || '').trim()));

// The comparison is done on a name with its spacing and case settled, because
// "Bank Of Baroda" and "BANK OF BARODA " are one account in his head.
export const key = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

/* ===================== holding the two side by side ===================== */

// `sheet` is what balance_sheet(on) handed back. `tb` is trialBalanceFromXml.
// `mine` is the total of whatever was entered in Skwik itself rather than
// imported — it is not a difference, it is the explanation for one.
export function compareMoney(tb, sheet, mine = {}) {
  const byName = new Map();
  (tb.rows || []).forEach((r) => byName.set(key(r.name), r));

  const lines = [];
  const add = (label, skwik, tallyName) => {
    const t = byName.get(key(tallyName || label));
    const tally = t ? (t.closing || 0) : null;
    // WHAT HE TYPED HERE HIMSELF, when it can be counted honestly. It reached
    // his screen counting rows the importer HAD written and turned a plain
    // 45,874.86 short into 45,68,258.96, which is worse than saying nothing.
    // Nothing is taken off a figure until that count can be trusted.
    const own = Number(mine[key(label)] || 0);
    lines.push({
      label,
      tally,
      skwik: Number(skwik || 0),
      own,
      // Tally + what he typed only into Skwik should equal Skwik
      gap: tally === null ? null
        : Math.round((Number(skwik || 0) - own - tally) * 100) / 100,
      missing: !t,
    });
  };

  add('Cash in hand', sheet?.cash, 'Cash');
  (sheet?.banks || []).forEach((b) => add(b.name, b.amount));

  // STOCK IS NOT IN A TRIAL BALANCE, AND THE LINE THAT LOOKS LIKE IT IS NOT IT.
  //
  // Tally's "Opening Stock" ledger holds the value of the shelf on the day the
  // year opened -- 1,37,85,016.84 on his. Skwik's stock figure is the value of
  // the shelf TODAY. Holding one against the other reported him 10,77,873.52
  // adrift when nothing was wrong: the year's buying and selling is the whole
  // of the difference.
  //
  // Closing stock is not a ledger at all, so no trial balance can answer this.
  // It takes a Stock Summary export, which is its own piece of work.

  const worst = lines.filter((l) => l.gap !== null && Math.abs(l.gap) >= 1)
    .sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap));

  return {
    lines,
    agree: worst.length === 0,
    worst,
    // the names Skwik has no account for, which are usually a bank he never
    // made rather than a fault
    unmatched: lines.filter((l) => l.missing).map((l) => l.label),
  };
}

// Every Tally ledger with a figure that Skwik ought to hold and does not know
// about at all. These are not differences yet — they are things to look at.
export function unseenInSkwik(tb, known = []) {
  const have = new Set(known.map(key));
  return (tb.rows || [])
    .filter((r) => (r.closing || 0) !== 0 && skwikKeeps(r.name) && !have.has(key(r.name)))
    .sort((a, b) => Math.abs(b.closing) - Math.abs(a.closing));
}

/* ===================== the people, name by name ===================== */

// WHY THIS IS NOT THE SAME JOB AS THE MONEY.
//
// Cash and banks are a handful of accounts with names Skwik chose. Parties are
// six hundred names typed by two different people into two different programs,
// and they will not all match. "M/s Krishna Enterprise" against "Krishna
// Enterprises", a full stop, a double space. So a name that does not match is
// never silently dropped -- it is listed, because an unmatched name is exactly
// where a missing balance hides.
export function compareParties(tb, rows, mine = {}, alreadyDone = [], roles = {}) {
  // CASH AND THE BANKS ARE NOT NAMES HE HAS NEVER HEARD OF.
  //
  // They are compared in the money table above, correctly, and then turned up
  // AGAIN underneath as "in your Tally, no such name in Skwik" -- because no
  // party is called Cash. Two lines saying a bank is missing, on a page whose
  // whole job is to be believed.
  const done = new Set((alreadyDone || []).map(key));
  const byKey = new Map();
  (rows || []).forEach((r) => byKey.set(key(r.name), r));

  const lines = [];
  const seen = new Set();

  (tb.rows || []).forEach((t) => {
    if (!skwikKeeps(t.name) || done.has(key(t.name))) return;
    const k = key(t.name);
    const r = byKey.get(k);
    if (!r) return;                       // handled by unmatched, below
    seen.add(k);
    const tally = t.closing || 0;
    const skwik = Number(r.balance || 0);
    const own = Number(mine[k] || 0);
    if (tally === 0 && skwik === 0) return;   // nothing to say about a settled account
    lines.push({ name: r.name, id: r.id, kind: r.kind, tally, skwik, own,
                 gap: Math.round((skwik - own - tally) * 100) / 100 });
  });

  const out = lines.filter((l) => Math.abs(l.gap) >= 1)
    .sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap));

  // IN HIS TALLY WITH A BALANCE, AND SKWIK HAS NO SUCH NAME -- split in two,
  // once the masters are here to say what each one IS.
  //
  // His own three: Priti Goyal 13,50,000, Piyush Agarwal -6,61,458, Pramod
  // Kumar Agarwal (HUF) -4,08,746. Listed as missing customers, worth 24 lakh
  // between them, and not one of them is a customer -- they are his capital and
  // his family's loans, which Skwik does not keep and never will.
  //
  // A trial balance cannot tell them apart from a real missing customer,
  // because it carries no groups. The MASTERS do. So when both files are read
  // together the two are separated: the ones worth chasing, and the ones that
  // are correct by design.
  const roleFor = (n) => {
    const r = (roles || {})[key(n)] || (roles || {})[String(n || '').toLowerCase()];
    return r || null;
  };
  const missing = (tb.rows || [])
    .filter((t) => (t.closing || 0) !== 0 && skwikKeeps(t.name)
      && !byKey.has(key(t.name)) && !done.has(key(t.name)))
    .sort((a, b) => Math.abs(b.closing) - Math.abs(a.closing));

  const onlyTally = missing.filter((t) => {
    const r = roleFor(t.name);
    return !r || r.role === 'party';          // a real name Skwik has not got
  });
  const notOurs = missing.filter((t) => {
    const r = roleFor(t.name);
    return r && r.role !== 'party';           // not a customer at all
  }).map((t) => ({ ...t, under: (roleFor(t.name) || {}).parent || '' }));

  // in Skwik with a balance, and his Tally has no such name
  const tbKeys = new Set((tb.rows || []).map((t) => key(t.name)));
  const onlySkwik = (rows || [])
    .filter((r) => Math.abs(Number(r.balance || 0)) >= 1 && !tbKeys.has(key(r.name)))
    .sort((a, b) => Math.abs(b.balance) - Math.abs(a.balance));

  return {
    checked: lines.length,
    agree: out.length === 0,
    out,
    onlyTally,
    notOurs,
    onlySkwik,
    worst: out[0] || null,
    total: Math.round(out.reduce((t, l) => t + l.gap, 0) * 100) / 100,
  };
}

/* ===================== the openings, from the file ===================== */

// WHAT THE TRIAL BALANCE CAN FILL IN, AND WHAT IT CANNOT.
//
// Only a figure that is still sitting at nought. An account he has set himself
// is his. And a bank Skwik has no account for is left alone rather than
// invented -- a second "Bank Of Baroda" beside his own would be worse than the
// missing figure.
export function openingsToFill(tb, have = {}) {
  const byKey = new Map();
  (tb.rows || []).forEach((r) => byKey.set(key(r.name), r));
  const pick = (name) => {
    const r = byKey.get(key(name));
    return r && r.opening ? r.opening : 0;
  };

  const banks = (have.banks || [])
    .filter((b) => !Number(b.opening || 0) && !b.opening_on && pick(b.name))
    .map((b) => ({ name: b.name, opening: pick(b.name) }));

  const parties = (have.parties || [])
    .filter((p) => !Number(p.opening_balance || 0) && !p.opening_date && pick(p.name))
    .map((p) => ({ name: p.name, opening: pick(p.name) }));

  const cashRow = byKey.get('cash');
  const cash = (!Number(have.opening_cash || 0) && !have.opening_cash_on
                && cashRow && cashRow.opening) ? cashRow.opening : null;

  return { cash, banks, parties,
           count: (cash ? 1 : 0) + banks.length + parties.length };
}

// ---------------------------------------------------------------------------
//  AND THE OPENINGS THAT ARE ALREADY SET AND ARE WRONG.
//
//  "Nothing already set is touched" is the right rule and it left a hole with
//  no way out of it. His own book: cash out by 1,30,041.45 and the Fedral Bank
//  account out by 2,41,610.00, and the fill said "cash left as it was, 0
//  bank(s)" -- because both already had a figure against them, so both were
//  passed over. An opening set WRONGLY could never be put right from here, and
//  the cash book and the bank book were out by that amount for ever.
//
//  A wrong opening is also the likeliest single cause of a cash or bank gap,
//  because the movements are checked separately and, on his book, Bank Of
//  Baroda agrees to the paisa -- which says the receipts and payments are being
//  read correctly and only the figure they start from is not.
//
//  So the ones that disagree are listed too, SEPARATELY, with both figures
//  shown. Nothing is written until he presses. An opening is his own figure
//  until he says otherwise, and the difference between offering and doing it
//  quietly is the whole point.
//
//  Only where the file actually carries an opening. A trial balance with no
//  opening column says nothing about what an account opened at, and a nought
//  read out of an absent column would wipe a figure that was right.
// ---------------------------------------------------------------------------
export function openingsToPutRight(tb, have = {}) {
  const byKey = new Map();
  (tb.rows || []).forEach((r) => byKey.set(key(r.name), r));
  const said = (name) => {
    const r = byKey.get(key(name));
    if (!r || !r.hasOpening) return null;      // no column, so the file says nothing
    return Number.isFinite(Number(r.opening)) ? Number(r.opening) : null;
  };
  const differs = (mine, theirs) =>
    theirs !== null && Math.abs(Number(mine || 0) - theirs) >= 1;

  const banks = (have.banks || [])
    .filter((b) => (Number(b.opening || 0) || b.opening_on) && differs(b.opening, said(b.name)))
    .map((b) => ({ id: b.id, name: b.name, was: Number(b.opening || 0),
                   opening: said(b.name) }));

  const parties = (have.parties || [])
    .filter((p) => (Number(p.opening_balance || 0) || p.opening_date)
                && differs((p.opening_type === 'you_owe' ? -1 : 1) * Number(p.opening_balance || 0),
                           said(p.name)))
    .map((p) => ({ id: p.id, name: p.name,
                   was: (p.opening_type === 'you_owe' ? -1 : 1) * Number(p.opening_balance || 0),
                   opening: said(p.name) }));

  const cashSaid = said('cash');
  const cash = ((Number(have.opening_cash || 0) || have.opening_cash_on)
                && differs(have.opening_cash, cashSaid))
    ? { was: Number(have.opening_cash || 0), opening: cashSaid } : null;

  return { cash, banks, parties,
           count: (cash ? 1 : 0) + banks.length + parties.length };
}

/* ===================== which of the three files is this? ===================== */

// ONE DROP, ANY NUMBER OF FILES, IN ANY ORDER.
//
// A shop was asked to export three things out of Tally and bring each one to a
// different box on the page, in the right order, pressing a different button
// for each: the masters and the day book to one, the trial balance to another,
// then "Fill these in", then drop the trial balance AGAIN to see the result.
// Four presses and an understanding of why, before any of it is right.
//
// He put it plainly: why will my customer do that?
//
// He will not. So Skwik reads the file and works out for itself which of the
// three it is, and there is one box and one button. The three are told apart by
// what only each of them has:
//
//    a TRIAL BALANCE  is a flat run of DSPDISPNAME / DSPACCINFO pairs
//    a DAY BOOK       has VOUCHER blocks in it
//    the MASTERS      have LEDGER or STOCKITEM blocks and no vouchers
//
// A file can be more than one of these at once -- Tally will happily export
// masters and vouchers together -- so this returns everything it found rather
// than picking one, and the caller uses each part for what it is good for.
export function whichTallyFile(text) {
  const t = String(text || '');
  const has = (re) => re.test(t);
  const trial   = has(/<DSPDISPNAME>/i) && has(/<DSPACCINFO>/i);
  const daybook = has(/<VOUCHER[\s>]/i);
  const ledgers = has(/<LEDGER[\s>]/i);
  const items   = has(/<STOCKITEM[\s>]/i);
  const masters = (ledgers || items) && !daybook;

  const kinds = [];
  if (trial) kinds.push('trial balance');
  if (daybook) kinds.push('day book');
  if (masters || ((ledgers || items) && daybook)) kinds.push('masters');

  return {
    trial,
    daybook,
    masters: masters || ((ledgers || items) && daybook),
    // for a tally file that is none of the three, and for one that is not Tally
    tally: has(/<ENVELOPE/i) || has(/<TALLYMESSAGE/i) || trial || daybook || ledgers || items,
    kinds,
    // what to call it on screen
    say: kinds.length ? kinds.join(' and ')
       : has(/<ENVELOPE/i) ? 'a Tally file, but not one Skwik can use'
       : 'not a Tally export',
  };
}
