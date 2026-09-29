// GSTR-2B, AGAINST THE BOOKS.
//
// Every month the portal publishes a GSTR-2B: the purchase invoices your
// suppliers have actually declared. The tax on those is the input credit you
// may claim. The tax on a bill your supplier has NOT declared is money you
// have paid and cannot claim — until he files, and sometimes never.
//
// The matching below follows the rules of the ITC Desk tool, so both give the
// same answer on the same data. Six passes, tightest first, and a pair is
// never given away to a weaker rule once a stronger one has claimed it:
//
//   P1   same supplier, same document type, same number
//   P1b  an amendment, carrying the original number
//   P2   same supplier, same type, same tax, same date — number differs
//   P3   same PAN, a different registration of the same firm
//   P4   the number is nearly the same and the tax agrees within tolerance
//   P5   only one document left on each side for that supplier and tax
//   P6   number and tax agree but the supplier does not — a wrong GSTIN
//
// Two things that trip everyone up and are handled here. A purchase return is
// a DEBIT note in your books and the supplier files it as a CREDIT note, so
// the types are flipped before matching. And a credit note counts backwards,
// so it is signed -1 everywhere it is added up.

import { n2, num, today } from './money.js';

/* ---------------- the small tools ---------------- */

const s = (x) => String(x ?? '').trim();
const up = (x) => s(x).toUpperCase().replace(/\s+/g, '');

// The portal writes 01-09-2026; everything here works in 2026-09-01.
export const isoDate = (d) => {
  const t = s(d);
  let m = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return m[0];
  m = t.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/);
  if (m) {
    const y = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${y}-${String(m[2]).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`;
  }
  return '';
};

// A document number as the eye reads it. Leading zeros are dropped wherever
// they sit, so SGS/26-27/007 and sgs-26-27-7 are one number — suppliers and
// their software disagree about punctuation and padding constantly.
export function normNo(x) {
  let t = up(x);
  if (!t) return '';
  let prev;
  do { prev = t; t = t.replace(/([^0-9]|^)0+([0-9])/g, '$1$2'); } while (t !== prev);
  return t.replace(/[^A-Z0-9]/g, '');
}

// How far apart two numbers are, letter by letter.
function lev(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = new Array(n + 1), cur = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    const t = prev; prev = cur; cur = t;
  }
  return prev[n];
}
const sim = (a, b) => {
  if (!a || !b) return 0;
  const m = Math.max(a.length, b.length);
  return m ? 1 - lev(a, b) / m : 0;
};

const days = (a, b) => (!a || !b ? 9999 : Math.round((new Date(b) - new Date(a)) / 86400000));
const monthIx = (p) => (!p || p.length < 7 ? null : (+p.slice(0, 4)) * 12 + (+p.slice(5, 7)));

// How close is close enough. Two rupees of tax and five of value: suppliers
// round differently and nobody should ring anybody over that.
export const TOL = { tax: 2, value: 5, fuzzy: 0.82 };

// WHICH READER MADE A STORED MONTH. Bumped whenever the reading of a file
// changes, so a month put away by an older reader is read again from the file
// itself instead of being served back stale. 1 was the reader that knew only
// the 2A names; 2 knows both, and stamps the return period onto every row.
export const READER = 2;

// HOW LONG HE HAS LEFT TO CLAIM IT.
//
// Input credit on a bill dies on the 30th of November after the financial
// year it belongs to. A shopkeeper does not carry that date in his head, and
// "not filed" reads very differently at 400 days than at 20. April to March,
// so a bill dated 25 August 2026 is FY 2026-27 and must be claimed by
// 30 November 2027.
export function claimBy(docDate) {
  const d = isoDate(docDate);
  if (!d) return '';
  const y = +d.slice(0, 4), m = +d.slice(5, 7);
  return `${(m >= 4 ? y : y - 1) + 1}-11-30`;
}
export function daysLeft(docDate, from) {
  const by = claimBy(docDate);
  if (!by) return null;
  const now = isoDate(from) || today();
  return Math.round((new Date(by) - new Date(now)) / 86400000);
}

/* ---------------- one document, from either side ---------------- */

function mkDoc(o) {
  const d = {
    src: o.src,                                   // books | 2b
    gstin: up(o.gstin),
    party: s(o.party),
    docType: o.docType || 'INV',                  // INV | CN | DN
    docNo: s(o.docNo),
    docDate: isoDate(o.docDate),
    bookDate: isoDate(o.bookDate),
    taxable: n2(o.taxable), igst: n2(o.igst), cgst: n2(o.cgst),
    sgst: n2(o.sgst), cess: n2(o.cess), value: n2(o.value),
    itc: o.itc == null ? 'Y' : o.itc,             // the portal's own verdict
    rsn: s(o.rsn), rcm: o.rcm ? 1 : 0,
    section: o.section || 'B2B',                  // B2B | ISD | IMPORT
    amend: o.amend ? 1 : 0, origNo: s(o.origNo),
    filed: s(o.filed),
    ret: s(o.ret).slice(0, 7),                    // the return month it came in
    id: o.id || null,
  };
  d.tax = n2(d.igst + d.cgst + d.sgst + d.cess);
  if (!d.value) d.value = n2(d.taxable + d.tax);
  d.pan = d.gstin.length >= 12 ? d.gstin.slice(2, 12) : '';
  d.period = (d.bookDate || d.docDate || '').slice(0, 7);

  // A purchase return is a debit note in your books; the supplier files it as
  // a credit note. Flip it, or the two sides never meet.
  d.mtype = d.docType;
  if (d.src === 'books' && d.docType === 'DN') d.mtype = 'CN';
  else if (d.src === 'books' && d.docType === 'CN') d.mtype = 'DN';

  d.sign = d.mtype === 'CN' ? -1 : 1;
  d.nn  = normNo(d.docNo);
  d.onn = normNo(d.origNo);
  return d;
}

/* ---------------- reading the portal's file ---------------- */

// A GSTR-2B AND A GSTR-2A DO NOT NAME THE SAME FIGURE THE SAME WAY.
//
// This read the 2A's names and only those, so every tax on a real GSTR-2B came
// out as nought. Nothing obvious broke: the bills still PAIRED, by number, and
// then every single pair was reported as disagreeing because his book said
// 12,600 and the portal said nothing. On his own five months that was
//
//     SAFE TO CLAIM      0        NOT IN YOUR BOOKS      0
//     AT RISK       14,618        NEEDS A LOOK   14,32,580 across 240 bills
//
// -- a screen full of discrepancies with no discrepancy in it. Both of the
// noughts are sums of the PORTAL side, which is what gave it away.
//
//   what           2B says      2A says
//   the taxes      igst         iamt
//                  cgst         camt
//                  sgst         samt
//                  cess         csamt
//   the date       dt           idt
//   a note number  ntnum        nt_num
//
// Both are read now, either way round, so a file from either report works.
// A field that is not there adds nothing, so reading both cannot double it.
const IG = (y) => num(y.igst) + num(y.iamt);
const CG = (y) => num(y.cgst) + num(y.camt);
const SG = (y) => num(y.sgst) + num(y.samt);
const CS = (y) => num(y.cess) + num(y.csamt);

const invOf = (ctin, trdnm, inv, docType, section, extra = {}) => {
  const itms = inv.items || inv.itms || [];
  let taxable = 0, cgst = 0, sgst = 0, igst = 0, cess = 0;
  for (const it of itms) {
    const x = it.itm_det || it;
    taxable = n2(taxable + num(x.txval));
    cgst = n2(cgst + CG(x)); sgst = n2(sgst + SG(x));
    igst = n2(igst + IG(x)); cess = n2(cess + CS(x));
  }
  if (!itms.length) {
    taxable = num(inv.txval); cgst = CG(inv);
    sgst = SG(inv); igst = IG(inv); cess = CS(inv);
  }
  return mkDoc({
    src: '2b', gstin: ctin, party: trdnm || inv.trdnm,
    docType, section,
    docNo: inv.inum || inv.ntnum || inv.nt_num || inv.docnum || inv.doc_num || inv.benum,
    docDate: inv.dt || inv.idt || inv.ntdt || inv.nt_dt || inv.docdt || inv.doc_dt || inv.bedt,
    bookDate: inv.dt || inv.idt || inv.ntdt || inv.nt_dt,
    taxable, cgst, sgst, igst, cess, value: num(inv.val),
    itc: s(inv.itcavl || 'Y').toUpperCase(),
    rsn: inv.rsn,
    rcm: s(inv.rev || inv.rchrg).toUpperCase() === 'Y',
    filed: extra.filedOn || inv.fldtr1 || inv.fldt,
    ret: extra.ret || '',
    ...extra,
  });
};

export function parse2b(text) {
  let j;
  try { j = typeof text === 'string' ? JSON.parse(text) : text; }
  catch (e) {
    return { rows: [], problem: 'That file is not the GSTR-2B JSON. On the portal: '
      + 'Returns, GSTR-2B, Download, Generate JSON file to download.' };
  }

  const d = j.data || j;
  const dd = d.docdata || d;
  const out = [];
  // WHICH RETURN THIS ROW CAME OUT OF, on the row itself. The file says it
  // once, at the top, and it was thrown away -- so nothing downstream could
  // tell "he has not filed that month at all" from "he filed, and left this
  // bill out", which are a reminder and a complaint and not the same call.
  const ret = (() => {
    const p = s(d.rtnprd || j.rtnprd);
    return /^\d{6}$/.test(p) ? `${p.slice(2)}-${p.slice(0, 2)}` : p.slice(0, 7);
  })();

  const eatInv = (list, section, amend) => {
    for (const sup of list || []) {
      for (const inv of sup.inv || []) {
        // WHEN THE SUPPLIER FILED IT. A 2B puts this once against the supplier
        // (supfildt), not on every invoice, so reading only the invoice left it
        // blank on every row of a real file.
        out.push(invOf(sup.ctin, sup.trdnm, inv, 'INV', section,
          { amend, origNo: inv.oinum || inv.oinvnum, filedOn: sup.supfildt, ret }));
      }
    }
  };
  const eatNotes = (list, amend) => {
    for (const sup of list || []) {
      for (const nt of sup.nt || []) {
        const t = s(nt.ntty).toUpperCase() === 'D' ? 'DN' : 'CN';
        out.push(invOf(sup.ctin, sup.trdnm, nt, t, 'B2B',
          // the amended note's original number, either spelling
          { amend, origNo: nt.ontnum || nt.ont_num, filedOn: sup.supfildt, ret }));
      }
    }
  };

  eatInv(dd.b2b, 'B2B', 0);
  eatInv(dd.b2ba, 'B2B', 1);
  eatNotes(dd.cdnr, 0);
  eatNotes(dd.cdnra, 1);
  eatInv(dd.isd, 'ISD', 0);
  eatInv(dd.isda, 'ISD', 1);
  eatInv(dd.impg, 'IMPORT', 0);
  eatInv(dd.impgsez, 'IMPORT', 0);

  if (!out.length) {
    return { rows: [], problem: 'No purchase invoices in that file. It may be a 2A, or a '
      + 'month in which nobody filed against your GST number.' };
  }
  return { rows: out, problem: null, period: s(d.rtnprd || j.rtnprd) };
}

/* ---------------- the books ---------------- */

const TYPE_OF = { purchase: 'INV', purchase_return: 'DN' };

export const fromBooks = (v) => mkDoc({
  src: 'books',
  id: v.id,
  gstin: v.parties?.gstin || v.party_gstin,
  party: v.parties?.name || v.printed_name,
  docType: TYPE_OF[v.vtype] || 'INV',
  docNo: v.supplier_invoice_no || v.voucher_no,
  docDate: v.supplier_invoice_date || v.vdate,
  bookDate: v.vdate,
  taxable: v.taxable, cgst: v.cgst, sgst: v.sgst, igst: v.igst,
  value: v.total,
  // REVERSE CHARGE, FROM HIS SIDE TOO.
  //
  // The portal's copy says rev="Y" and is set aside, because a reverse-charge
  // supply is not matched against a purchase bill. His own copy was never
  // asked, so the bill sat there with nothing to pair with and came out under
  // "credit at risk" — telling him to chase a supplier who had done nothing
  // wrong, and over-stating the credit he stands to lose.
  rcm: !!v.reverse_charge,
});

/* ---------------- the matching ---------------- */

export function reconcile({ purchases = [], portal = [], periods = [],
                            booksFrom = '', asOf = '' }) {
  // the months the uploaded files cover, as YYYY-MM. parse2b hands back the
  // portal's own MMYYYY, which is turned round here.
  const months = new Set((periods || []).map((p) => {
    const t = String(p || '').trim();
    if (/^\d{6}$/.test(t)) return `${t.slice(2)}-${t.slice(0, 2)}`;   // MMYYYY
    return t.slice(0, 7);                                            // YYYY-MM
  }).filter(Boolean));
  const books = purchases
    .filter((v) => v.vtype === 'purchase' || v.vtype === 'purchase_return')
    .map(fromBooks);
  const two = portal.map((p) => (p.src ? p : mkDoc({ ...p, src: '2b' })));

  // Set aside what is not a straight supplier invoice: credit distributed by
  // an input service distributor, imports, and anything on reverse charge —
  // none of those match against a purchase bill.
  const aside = new Set();
  const noGstin = books.filter((b) => !b.gstin);
  const other   = two.filter((t) => t.section === 'ISD' || t.section === 'IMPORT');
  const rcm     = [...books, ...two].filter((d) => d.rcm && d.section === 'B2B');
  [...noGstin, ...other, ...rcm].forEach((d) => aside.add(d));

  const L = books.filter((b) => !aside.has(b));
  const R = two.filter((t) => !aside.has(t));

  const pairs = [];
  const pairBy = (keyOf, pass) => {
    const map = new Map();
    R.forEach((t) => {
      if (t._m) return;
      const k = keyOf(t);
      if (!k) return;
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(t);
    });
    L.forEach((b) => {
      if (b._m) return;
      const k = keyOf(b);
      if (!k) return;
      const live = (map.get(k) || []).filter((x) => !x._m);
      if (!live.length) return;
      // if several could match, take the one nearest in date
      live.sort((x, y) => Math.abs(days(b.docDate, x.docDate)) - Math.abs(days(b.docDate, y.docDate)));
      const t = live[0];
      b._m = t; t._m = b;
      pairs.push({ b, t, pass, ambig: live.length > 1 });
    });
  };

  pairBy((d) => (d.gstin && d.nn ? [d.gstin, d.mtype, d.nn].join('|') : ''), 'P1');
  pairBy((d) => (d.gstin && (d.onn || d.nn)
    ? [d.gstin, d.mtype, d.onn || d.nn].join('|') : ''), 'P1b');
  pairBy((d) => (d.gstin && d.docDate && d.tax
    ? [d.gstin, d.mtype, Math.round(d.tax), d.docDate].join('|') : ''), 'P2');
  pairBy((d) => (d.pan && d.nn ? [d.pan, d.mtype, d.nn].join('|') : ''), 'P3');

  // P4 — the number is nearly right. A slip of one character in the ledger.
  {
    const grp = new Map();
    R.forEach((t) => {
      if (t._m || !t.gstin) return;
      const k = `${t.gstin}|${t.mtype}`;
      if (!grp.has(k)) grp.set(k, []);
      grp.get(k).push(t);
    });
    L.forEach((b) => {
      if (b._m || !b.gstin) return;
      const arr = (grp.get(`${b.gstin}|${b.mtype}`) || []).filter((x) => !x._m);
      let best = null, bs = 0;
      arr.forEach((t) => {
        const score = sim(b.nn, t.nn);
        const slack = Math.max(TOL.tax, Math.abs(b.tax) * 0.01);
        if (score >= TOL.fuzzy && Math.abs(b.tax - t.tax) <= slack && score > bs) {
          bs = score; best = t;
        }
      });
      if (best) { b._m = best; best._m = b; pairs.push({ b, t: best, pass: 'P4', score: bs }); }
    });
  }

  // P5 — nothing else left on either side for that supplier and that tax.
  {
    const key = (d) => (d.gstin && d.tax ? [d.gstin, d.mtype, Math.round(d.tax)].join('|') : '');
    const count = (arr, k) => arr.filter((x) => !x._m && key(x) === k).length;
    L.forEach((b) => {
      if (b._m) return;
      const k = key(b);
      if (!k || count(L, k) !== 1 || count(R, k) !== 1) return;
      const t = R.find((x) => !x._m && key(x) === k);
      if (t) { b._m = t; t._m = b; pairs.push({ b, t, pass: 'P5' }); }
    });
  }

  // P6 — the bill agrees but the supplier does not. Nearly always a wrong GST
  // number on the ledger. Paired only when there is one candidate each side.
  {
    const key = (d) => (d.nn && d.tax ? [d.mtype, d.nn, Math.round(d.tax)].join('|') : '');
    const map = new Map(), mine = new Map();
    R.forEach((t) => {
      if (t._m) return;
      const k = key(t);
      if (!k) return;
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(t);
    });
    L.forEach((b) => { if (!b._m) { const k = key(b); if (k) mine.set(k, (mine.get(k) || 0) + 1); } });
    L.forEach((b) => {
      if (b._m) return;
      const k = key(b);
      if (!k) return;
      const live = (map.get(k) || []).filter((x) => !x._m);
      if (live.length !== 1 || mine.get(k) !== 1) return;
      const t = live[0];
      if (t.gstin && b.gstin && t.gstin === b.gstin) return;
      b._m = t; t._m = b; pairs.push({ b, t, pass: 'P6' });
    });
  }

  // what each pair actually says
  pairs.forEach((p) => {
    p.taxDiff     = n2(p.b.tax - p.t.tax);
    p.taxableDiff = n2(p.b.taxable - p.t.taxable);
    p.valDiff     = n2(p.b.value - p.t.value);
    p.dayDiff     = days(p.t.docDate, p.b.docDate);
    const mb = monthIx(p.b.period), mt = monthIx(p.t.period);
    p.periodDiff  = (mb === null || mt === null) ? null : mt - mb;
    p.amtOk       = Math.abs(p.taxDiff) <= TOL.tax && Math.abs(p.valDiff) <= TOL.value;
    p.cls = (p.pass === 'P1' || p.pass === 'P1b') ? (p.amtOk ? 'EXACT' : 'DIFF_AMT')
          : p.pass === 'P2' ? 'DIFF_NO'
          : p.pass === 'P3' ? 'DIFF_GSTIN'
          : p.pass === 'P4' ? 'FUZZY'
          : p.pass === 'P6' ? 'DIFF_PARTY'
          : 'WEAK';
    // filed in one month and entered in another: the credit belongs to the later
    p.timing = p.periodDiff !== null && p.periodDiff !== 0;
    // THE PORTAL SAYS THIS CREDIT IS NOT AVAILABLE.
    //
    // A blocked invoice he had NOT entered was reported. One he HAD entered
    // matched cleanly, was called exact, was left out of the safe total for
    // being blocked — and was then mentioned nowhere at all. So the figure he
    // would have claimed included it and nothing on the screen said so. It is
    // named now, with the portal's own reason.
    p.blocked = p.t.itc === 'N';
    p.blockedReason = p.blocked ? (p.t.rsn || '') : '';
  });

  // A BILL IS ONLY JUDGED AGAINST A MONTH THAT WAS ACTUALLY UPLOADED.
  //
  // The books are read wider than one 2B on purpose: a supplier who files late
  // turns up in a later month's file, and that catching works. But what is
  // left over afterwards was ALL being called "your supplier has not filed
  // it" -- including July and August bills, filed perfectly on time, in July's
  // and August's own 2B, which this run never had in front of it.
  //
  // Measured on three months of a small shop: five bills reported unfiled and
  // 39,600 at risk, where the truth was one bill and 7,200. The figure was
  // five and a half times over, and the reminder button offered to send four
  // suppliers a list of bills they had filed on time.
  //
  // So: `periods` is the months whose 2B files are actually in hand. An
  // unmatched bill dated in one of them was genuinely not filed. An unmatched
  // bill from any other month is not evidence of anything -- it is a month
  // that was not looked at -- and it comes back separately so the screen can
  // ask for that file instead of blaming the supplier.
  //
  // Given no periods at all, every bill is judged, which is how this behaved
  // before and is right when the caller has said nothing.
  const inScope = (d) => !months.size || months.has(String(d.period || '').slice(0, 7))
                      || months.has(String(d.docDate || '').slice(0, 7));
  const unmatched    = L.filter((b) => !b._m);
  const booksOnly    = unmatched.filter(inScope);
  const booksUnseen  = unmatched.filter((b) => !inScope(b));

  // WHY IT IS NOT IN THE GOVERNMENT'S RECORD, WHICH DECIDES WHO HE RINGS.
  //
  // "Not filed" was one word for three different situations, and two of them
  // are not the supplier's fault at all:
  //
  //   the GSTIN is nowhere in any file he has .... it is HIS ledger that is
  //                                                wrong, not the supplier
  //   the supplier filed other months, not this .. a reminder
  //   he filed that month and left this bill out . a complaint
  //
  // On his own five months the biggest single sum at risk, 5,528 against
  // Dhariwal Metal, was the first kind: a firm that appears in no return at
  // all, which is what a mistyped GST number looks like. Calling that "your
  // supplier has not filed" sends him to argue with a man who filed on time.
  const filedAt = new Map();
  R.forEach((x) => {
    if (!x.gstin) return;
    if (!filedAt.has(x.gstin)) filedAt.set(x.gstin, new Set());
    const seen = filedAt.get(x.gstin);
    if (x.ret) seen.add(x.ret);
    const m = String(x.docDate || '').slice(0, 7);
    if (m) seen.add(m);
  });
  booksOnly.forEach((b) => {
    const seen = b.gstin ? filedAt.get(b.gstin) : null;
    const m = String(b.docDate || '').slice(0, 7);
    b.why = !seen ? 'GSTIN' : (m && !seen.has(m) ? 'MONTH' : 'OMITTED');
    b.daysLeft = daysLeft(b.docDate, asOf);
  });

  const twoLeft      = R.filter((x) => !x._m);
  const twoBlocked   = twoLeft.filter((x) => x.itc === 'N');
  const twoOpen      = twoLeft.filter((x) => x.itc !== 'N');

  // AND THE SAME COURTESY FOR THE PORTAL'S SIDE.
  //
  // His own books start somewhere. Every portal row older than that has
  // nothing on this side of the ledger to meet, and was being listed as a
  // bill he had forgotten to enter -- 84 of them, 6,35,721 of tax, an entire
  // year he had simply not loaded. A list that long is not a worklist, it is
  // a reason to stop using the screen.
  const early = (x) => !!booksFrom && !!x.docDate && x.docDate < booksFrom;
  const twoUnseen    = twoOpen.filter(early);
  const twoOnly      = twoOpen.filter((x) => !early(x));

  // the same bill entered twice, on either side
  const dupes = [];
  [['books', L], ['2b', R]].forEach(([src, arr]) => {
    const m = new Map();
    arr.forEach((d) => {
      if (!d.gstin || !d.nn) return;
      const k = [d.gstin, d.mtype, d.nn].join('|');
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(d);
    });
    m.forEach((v) => { if (v.length > 1) dupes.push({ src, docs: v }); });
  });

  const sum = (arr) => n2(arr.reduce((a, d) => a + d.sign * num(d.tax), 0));
  const matched = pairs.filter((p) => p.cls === 'EXACT');
  const queried = pairs.filter((p) => p.cls !== 'EXACT');

  const suppliersOf = (arr) => new Set(arr.map((d) => d.gstin || d.party || '?')).size;

  return {
    pairs, matched, queried, booksOnly, booksUnseen, twoOnly, twoBlocked, twoUnseen,
    months: [...months].sort(),
    blockedPairs: pairs.filter((x) => x.blocked),
    noGstin, other, rcm, dupes,
    summary: {
      bills: L.length,
      portalBills: R.length,
      matched: matched.length,
      different: queried.length,
      onlyBooks: booksOnly.length,
      // bills from a month whose 2B is not in hand: not at risk, not checked
      unseen: booksUnseen.length,
      unseenTax: n2(booksUnseen.reduce((a, d) => a + d.sign * num(d.tax), 0)),
      onlyPortal: twoOnly.length,
      timing: pairs.filter((p) => p.timing).length,

      // THE TWO SENTENCES AT THE TOP OF THE SCREEN.
      //
      // One thing he stands to lose and one thing he stands to gain, in
      // rupees, before any table. Four equal tiles made him work out which of
      // the four mattered, and the largest number on the page was the one that
      // mattered least.
      stuck:          sum(booksOnly),
      stuckBills:     booksOnly.length,
      stuckSuppliers: suppliersOf(booksOnly),
      waiting:        sum(twoOnly),
      waitingBills:   twoOnly.length,
      // and the quiet line underneath: what was read and wants nothing
      needNothing: matched.length + rcm.length + other.length,
      // portal rows older than his books go back -- named, not blamed on him
      earlyPortal:    twoUnseen.length,
      earlyPortalTax: sum(twoUnseen),
      booksFrom,

      safe:    sum(pairs.filter((p) => p.cls === 'EXACT' && p.t.itc !== 'N').map((p) => p.t)),
      atRisk:  sum(booksOnly),
      missing: sum(twoOnly),
      queriedTax: n2(queried.reduce((a, p) => a + Math.abs(p.taxDiff), 0)),
      // blocked credit he has NOT entered, and the more dangerous kind: blocked
      // credit that is sitting in his books ready to be claimed
      blocked: sum(twoBlocked),
      blockedInBooks: sum(pairs.filter((x) => x.blocked).map((x) => x.t)),
      blockedInBooksCount: pairs.filter((x) => x.blocked).length,
      noGstinTax: sum(noGstin),
      rcmTax: sum(rcm.filter((d) => d.src === 'books')),
    },
  };
}

// Who to chase, worst first — a shopkeeper acts supplier by supplier.
export function bySupplier(result) {
  const map = {};
  const put = (ctin, name, field, row) => {
    const k = ctin || name || '—';
    map[k] = map[k] || { ctin, name, matched: 0, different: 0, onlyBooks: 0,
                         onlyPortal: 0, atRisk: 0, rows: [] };
    map[k][field] += 1;
    map[k].rows.push({ field, row });
  };
  result.matched.forEach((x) => put(x.b.gstin, x.b.party, 'matched', x));
  result.queried.forEach((x) => put(x.b.gstin, x.b.party, 'different', x));
  result.booksOnly.forEach((b) => {
    put(b.gstin, b.party, 'onlyBooks', b);
    const k = b.gstin || b.party || '—';
    map[k].atRisk = n2(map[k].atRisk + b.sign * num(b.tax));
  });
  result.twoOnly.forEach((t) => put(t.gstin, t.party, 'onlyPortal', t));
  return Object.values(map).sort((a, b) => b.atRisk - a.atRisk
    || (b.onlyBooks + b.different) - (a.onlyBooks + a.different));
}

/* ---------------- the four jobs, in the order he does them ---------------- */

// WHY THIS IS NOT FOUR TILES ANY MORE.
//
// His own tool, written before Skwik and on the same five months, says:
//
//     Ring these suppliers ....... 4 bills
//     Look in an earlier return .. 2 bills
//     Enter these in Tally ....... 37 bills
//     Small corrections .......... 10 bills
//     550 more bills were checked and need nothing from you.
//
// Every heading is a job. Skwik said "At risk", "Not in your books", "Needs a
// look" -- which are STATES, and a shopkeeper has to translate each one into
// an action before he can move. These four do the translating for him.

export const WHY_STUCK = {
  GSTIN:   'Never seen in any return — check the GSTIN in your ledger',
  MONTH:   'He has not filed that month at all — a reminder, not a complaint',
  OMITTED: 'He filed that month and left this bill out',
};

// Who to ring, worst first, with the reason on each bill.
export function chaseList(result) {
  const map = new Map();
  (result.booksOnly || []).forEach((b) => {
    const k = b.gstin || b.party || '—';
    if (!map.has(k)) {
      map.set(k, { key: k, gstin: b.gstin, name: b.party || b.gstin || '—',
                   tax: 0, bills: [], why: b.why });
    }
    const g = map.get(k);
    g.tax = n2(g.tax + b.sign * num(b.tax));
    g.bills.push(b);
    // one firm, one headline reason: a wrong GST number outranks a late month
    if (b.why === 'GSTIN' || (b.why === 'MONTH' && g.why === 'OMITTED')) g.why = b.why;
  });
  return [...map.values()].sort((a, b) => b.tax - a.tax);
}

// The same three lists as rows, for the file he takes away and works down.
export function worklist(result) {
  const r = [];
  const money = (x) => n2(num(x));
  r.push(['RING THESE SUPPLIERS']);
  r.push(['supplier', 'gstin', 'bill no', 'bill date', 'tax stuck', 'why', 'claim by', 'days left']);
  chaseList(result).forEach((g) => g.bills.forEach((b) => {
    r.push([g.name, b.gstin, b.docNo, b.docDate, money(b.tax),
            WHY_STUCK[b.why] || '', claimBy(b.docDate), b.daysLeft == null ? '' : b.daysLeft]);
  }));

  r.push([]);
  r.push(['ENTER THESE IN YOUR BOOKS']);
  r.push(['supplier', 'gstin', 'bill no', 'bill date', 'goods value', 'tax']);
  [...(result.twoOnly || [])].sort((a, b) => b.tax - a.tax).forEach((x) => {
    r.push([x.party, x.gstin, x.docNo, x.docDate, money(x.taxable), money(x.tax)]);
  });

  r.push([]);
  r.push(['LOOK IN AN EARLIER RETURN']);
  r.push(['supplier', 'bill no', 'bill date', 'tax', 'probably in']);
  (result.booksUnseen || []).forEach((b) => {
    r.push([b.party, b.docNo, b.docDate, money(b.tax), String(b.docDate || '').slice(0, 7)]);
  });

  r.push([]);
  r.push(['SMALL CORRECTIONS']);
  r.push(['supplier', 'in your books', 'with the government', 'your tax', 'their tax', 'what to fix']);
  (result.queried || []).forEach((p) => {
    r.push([p.b.party, p.b.docNo, p.t.docNo, money(p.b.tax), money(p.t.tax), p.cls]);
  });
  return r;
}
