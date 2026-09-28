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
  const names = [...text.matchAll(/<DSPDISPNAME>([\s\S]*?)<\/DSPDISPNAME>/gi)]
    .map((m) => m[1].trim());
  const infos = [...text.matchAll(/<DSPACCINFO>([\s\S]*?)<\/DSPACCINFO>/gi)]
    .map((m) => m[1]);

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
  if (names.length !== infos.length) {
    return { rows: [], why: `The file has ${names.length} ledger name(s) but ${infos.length} `
      + 'set(s) of figures, so it cannot be read safely. Export the Trial Balance again.' };
  }

  const rows = names.map((name, i) => {
    const b = infos[i] || '';
    return {
      name,
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
export function compareParties(tb, rows, mine = {}, alreadyDone = []) {
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

  // in his Tally with a balance, and Skwik has no such name
  const onlyTally = (tb.rows || [])
    .filter((t) => (t.closing || 0) !== 0 && skwikKeeps(t.name)
      && !byKey.has(key(t.name)) && !done.has(key(t.name)))
    .sort((a, b) => Math.abs(b.closing) - Math.abs(a.closing));

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
