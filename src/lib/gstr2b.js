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

import { n2, num } from './money';

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

const invOf = (ctin, trdnm, inv, docType, section, extra = {}) => {
  const itms = inv.items || inv.itms || [];
  let taxable = 0, cgst = 0, sgst = 0, igst = 0, cess = 0;
  for (const it of itms) {
    const x = it.itm_det || it;
    taxable = n2(taxable + num(x.txval));
    cgst = n2(cgst + num(x.camt)); sgst = n2(sgst + num(x.samt));
    igst = n2(igst + num(x.iamt)); cess = n2(cess + num(x.csamt));
  }
  if (!itms.length) {
    taxable = num(inv.txval); cgst = num(inv.camt);
    sgst = num(inv.samt); igst = num(inv.iamt); cess = num(inv.csamt);
  }
  return mkDoc({
    src: '2b', gstin: ctin, party: trdnm || inv.trdnm,
    docType, section,
    docNo: inv.inum || inv.nt_num || inv.doc_num,
    docDate: inv.idt || inv.nt_dt || inv.doc_dt,
    bookDate: inv.idt || inv.nt_dt,
    taxable, cgst, sgst, igst, cess, value: num(inv.val),
    itc: s(inv.itcavl || 'Y').toUpperCase(),
    rsn: inv.rsn,
    rcm: s(inv.rev).toUpperCase() === 'Y',
    filed: inv.fldtr1 || inv.fldt,
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

  const eatInv = (list, section, amend) => {
    for (const sup of list || []) {
      for (const inv of sup.inv || []) {
        out.push(invOf(sup.ctin, sup.trdnm, inv, 'INV', section,
          { amend, origNo: inv.oinum }));
      }
    }
  };
  const eatNotes = (list, amend) => {
    for (const sup of list || []) {
      for (const nt of sup.nt || []) {
        const t = s(nt.ntty).toUpperCase() === 'D' ? 'DN' : 'CN';
        out.push(invOf(sup.ctin, sup.trdnm, nt, t, 'B2B',
          { amend, origNo: nt.ont_num }));
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
});

/* ---------------- the matching ---------------- */

export function reconcile({ purchases = [], portal = [] }) {
  const books = purchases
    .filter((v) => v.vtype === 'purchase' || v.vtype === 'purchase_return')
    .map(fromBooks);
  const two = portal.map((p) => (p.src ? p : mkDoc({ ...p, src: '2b' })));

  // NOTHING IS PAIRED UNTIL THIS RUN PAIRS IT.
  //
  // `_m` is written onto the documents themselves, and a caller that hands
  // the same parsed rows back for a second run — a different month, a wider
  // window — would find every one of them already carrying a partner from
  // last time. The passes below would then skip them and the whole file
  // would read as matched. Each run starts from nothing.
  [...books, ...two].forEach((d) => { delete d._m; });

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
  });

  const booksOnly    = L.filter((b) => !b._m);
  const twoLeft      = R.filter((t) => !t._m);
  const twoBlocked   = twoLeft.filter((t) => t.itc === 'N');
  const twoOnly      = twoLeft.filter((t) => t.itc !== 'N');

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

  return {
    pairs, matched, queried, booksOnly, twoOnly, twoBlocked,
    noGstin, other, rcm, dupes,
    summary: {
      bills: L.length,
      portalBills: R.length,
      matched: matched.length,
      different: queried.length,
      onlyBooks: booksOnly.length,
      onlyPortal: twoOnly.length,
      timing: pairs.filter((p) => p.timing).length,

      safe:    sum(pairs.filter((p) => p.cls === 'EXACT' && p.t.itc !== 'N').map((p) => p.t)),
      atRisk:  sum(booksOnly),
      missing: sum(twoOnly),
      queriedTax: n2(queried.reduce((a, p) => a + Math.abs(p.taxDiff), 0)),
      blocked: sum(twoBlocked),
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
