// THE RETURN, AS THE PORTAL WANTS IT.
//
// Every month a registered shop has to tell the GST portal what it sold. The
// portal takes a JSON file in a shape it is very particular about, and the
// whole of it can be worked out from bills that are already in the books —
// nobody should be retyping a month of sales into a website.
//
// What goes where, in the portal's own words:
//   b2b    sold to someone with a GST number
//   b2cl   sold to someone without one, ANOTHER state, over 1 lakh
//   b2cs   everything else to people without a GST number, added up
//   cdnr   credit and debit notes against a registered buyer
//   cdnur  credit notes against an unregistered buyer, B2CL and exports ONLY
//   nil    nil-rated, exempted and non-GST supplies — the portal's Table 8
//   hsn    what was sold, grouped by HSN code
//   doc_issue  the bill numbers used, so the portal can see none are missing
//
// This builds the file. It does not file the return — that is still done on
// the portal, by whoever files it, who should read it first.

import { extraAsLine, n2, num, supplyOf, isTaxableLine } from './money';
import { guessUqc, isUqc } from './uqc';

// One lakh, not the two and a half it used to be: Notification 12/2024 cut it
// with effect from 1 August 2024, so bills between 1 and 2.5 lakh that used to
// sit in the b2cs summary now have to be listed one by one.
const B2CL_LIMIT = 100000;

// A unit the portal will accept. Anything it does not know becomes OTH, which
// it does, rather than three letters of a word it has never heard of.
const uqcOf = (unit) => {
  const u = String(unit || '').trim();
  if (!u) return 'OTH';
  if (isUqc(u)) return u.toUpperCase();
  return guessUqc(u) || 'OTH';
};

// The portal wants 01-09-2026, not 2026-09-01.
const gstDate = (d) => {
  const s = String(d || '');
  return `${s.slice(8, 10)}-${s.slice(5, 7)}-${s.slice(0, 4)}`;
};

// 092026 for September 2026.
export const gstPeriod = (year, month) =>
  `${String(month).padStart(2, '0')}${year}`;

const rate = (l) => n2(num(l.gst_rate));

// One line of a bill, as the portal writes it.
const itemRow = (n, l, mode) => ({
  num: n,
  itm_det: {
    txval: n2(l.taxable),
    rt: rate(l),
    ...(mode === 'igst'
      ? { iamt: n2(l.igst) }
      : { camt: n2(l.cgst), samt: n2(l.sgst) }),
    csamt: 0,
  },
});

// Group the lines of one bill by tax rate — the portal wants one entry per
// rate, not one per item.
function byRate(lines, mode) {
  const map = {};
  for (const l of lines) {
    const r = rate(l);
    map[r] = map[r] || { taxable: 0, cgst: 0, sgst: 0, igst: 0, gst_rate: r };
    map[r].taxable = n2(map[r].taxable + num(l.taxable));
    map[r].cgst    = n2(map[r].cgst + num(l.cgst));
    map[r].sgst    = n2(map[r].sgst + num(l.sgst));
    map[r].igst    = n2(map[r].igst + num(l.igst));
  }
  return Object.values(map).map((g, i) => itemRow(i + 1, g, mode));
}

export function buildGstr1({ org, vouchers, linesByVoucher, year, month }) {
  const problems = [];
  if (!org?.gstin) problems.push('Your firm has no GST number in Settings.');
  if (org?.is_composition) {
    problems.push('A composition dealer files GSTR-4, not GSTR-1. This file does not apply to you.');
  }

  const inMonth = (vouchers || []).filter((v) => {
    const d = String(v.vdate || '');
    return Number(d.slice(0, 4)) === Number(year) && Number(d.slice(5, 7)) === Number(month);
  });

  // A CANCELLED BILL IS NOT A SALE, BUT ITS NUMBER STILL EXISTS.
  // It is kept out of every value table and counted in the documents-issued
  // table, which is the one place the portal wants to see it.
  const cancelled = inMonth.filter((v) => v.vtype === 'sale' && v.cancelled_at);
  const sales     = inMonth.filter((v) => v.vtype === 'sale' && !v.cancelled_at);

  // A credit note raised after the 30 November deadline in section 34(2) is a
  // real refund but cannot reduce the tax, so it is left out of the return.
  const allReturns = inMonth.filter((v) => v.vtype === 'sale_return' && !v.cancelled_at);
  const returns    = allReturns.filter((v) => v.gst_effective !== false);
  const lateNotes  = allReturns.filter((v) => v.gst_effective === false);
  if (lateNotes.length) {
    problems.push(`${lateNotes.length} credit note${lateNotes.length === 1 ? ' is' : 's are'} `
      + 'past the 30 November deadline in section 34(2), so '
      + `${lateNotes.length === 1 ? 'it is' : 'they are'} left out of this return: `
      + lateNotes.slice(0, 5).map((v) => v.voucher_no).join(', ')
      + (lateNotes.length > 5 ? '…' : ''));
  }

  const lines = (v) => linesByVoucher[v.id] || [];

  // FREIGHT, PACKING, LABOUR — whatever the last box on the bill is called —
  // is part of the value of the supply under section 15(2)(c), and the tax on
  // it was charged to the customer. It was reaching the HSN table and nothing
  // else, so b2b, b2cl, b2cs and the credit notes all declared less than the
  // invoice actually carried. A bill with 100 of freight at 18% under-declared
  // 18 of tax, on every bill with a charge line on it.
  const allLines = (v) => {
    const ls = lines(v);
    const f = extraAsLine(v, ls);
    return f ? [...ls, f] : ls;
  };
  // NIL-RATED, EXEMPT AND NON-GST VALUE IS REPORTED IN TABLE 8, NOT IN THE
  // VALUE TABLES. Billing a nil-rated packet of milk as an ordinary 0%
  // taxable line puts it in b2cs, leaves Table 8 empty, and overstates the
  // shop's taxable turnover. So the lines of every bill are split here, once,
  // and the two halves go to different places.
  const taxableLines = (v) => allLines(v).filter(isTaxableLine);
  const untaxedLines = (v) => allLines(v).filter((l) => !isTaxableLine(l));

  const homeState = String(org?.state_code || '').padStart(2, '0');
  const pos = (v) => String(v.place_of_supply_code || v.parties?.state_code || homeState)
    .padStart(2, '0');

  /* ---------- b2b: sold to a registered buyer ---------- */
  const b2bMap = {};
  for (const v of sales) {
    const gstin = v.parties?.gstin;
    if (!gstin) continue;
    const itms = byRate(taxableLines(v), v.tax_mode);
    if (!itms.length) continue;          // a wholly exempt bill belongs in Table 8
    b2bMap[gstin] = b2bMap[gstin] || { ctin: gstin, inv: [] };
    b2bMap[gstin].inv.push({
      inum: String(v.voucher_no || ''),
      idt: gstDate(v.vdate),
      val: n2(v.total),
      pos: pos(v),
      rchrg: v.reverse_charge ? 'Y' : 'N',
      inv_typ: 'R',
      itms,
    });
  }

  /* ---------- b2cl: unregistered, other state, over 1 lakh ---------- */
  const b2clMap = {};
  /* ---------- b2cs: everything else, added up by rate and state ---------- */
  const b2csMap = {};

  // b2cs is a running summary, so a credit note against an ordinary counter
  // sale is NETTED OFF here rather than declared anywhere else. `sign` is +1
  // for a sale and -1 for such a credit note.
  const intoB2cs = (v, sign) => {
    const p = pos(v);
    const interState = p !== homeState;
    for (const l of taxableLines(v)) {
      const r = rate(l);
      const key = `${p}|${r}|${interState ? 'INTER' : 'INTRA'}`;
      b2csMap[key] = b2csMap[key] || {
        sply_ty: interState ? 'INTER' : 'INTRA',
        pos: p, typ: 'OE', rt: r,
        txval: 0, iamt: 0, camt: 0, samt: 0, csamt: 0,
      };
      const e = b2csMap[key];
      e.txval = n2(e.txval + sign * num(l.taxable));
      if (interState) e.iamt = n2(e.iamt + sign * num(l.igst));
      else {
        e.camt = n2(e.camt + sign * num(l.cgst));
        e.samt = n2(e.samt + sign * num(l.sgst));
      }
    }
  };

  for (const v of sales) {
    if (v.parties?.gstin) continue;
    const p = pos(v);
    const interState = p !== homeState;

    if (interState && n2(v.total) > B2CL_LIMIT) {
      const itms = byRate(taxableLines(v), v.tax_mode);
      if (!itms.length) continue;
      b2clMap[p] = b2clMap[p] || { pos: p, inv: [] };
      b2clMap[p].inv.push({
        inum: String(v.voucher_no || ''),
        idt: gstDate(v.vdate),
        val: n2(v.total),
        itms,
      });
      continue;
    }

    intoB2cs(v, +1);
  }

  /* ---------- credit notes ---------- */
  //
  // CDNUR IS NOT A BIN FOR EVERY UNREGISTERED CREDIT NOTE.
  //
  // Its `typ` accepts only B2CL, EXPWP and EXPWOP. Skwik used to write
  // 'B2CS' into it for any in-state note, which is not a value the schema
  // allows, and the portal refuses the whole file for it. Worse, the note
  // did not belong there at all: a credit note against an ordinary counter
  // sale is netted off inside the b2cs summary, which is what now happens.
  const cdnrMap = {};
  const cdnur = [];
  for (const v of returns) {
    const gstin = v.parties?.gstin;
    const itms = byRate(taxableLines(v), v.tax_mode);
    const note = {
      ntty: 'C',
      nt_num: String(v.voucher_no || ''),
      nt_dt: gstDate(v.vdate),
      val: n2(v.total),
      itms,
    };
    if (gstin) {
      if (!itms.length) continue;
      cdnrMap[gstin] = cdnrMap[gstin] || { ctin: gstin, nt: [] };
      cdnrMap[gstin].nt.push({ ...note, pos: pos(v),
                               rchrg: v.reverse_charge ? 'Y' : 'N', inv_typ: 'R' });
      continue;
    }

    const p = pos(v);
    const interState = p !== homeState;
    // Only an inter-state note above the B2CL limit is declared one by one.
    if (interState && n2(v.total) > B2CL_LIMIT) {
      if (!itms.length) continue;
      cdnur.push({ ...note, typ: 'B2CL', pos: p });
    } else {
      intoB2cs(v, -1);
    }
  }

  // the portal does not want the zero columns that do not apply
  const b2cs = Object.values(b2csMap)
    // netting can empty a bucket completely; an all-zero row is noise
    .filter((e) => e.txval !== 0 || e.iamt !== 0 || e.camt !== 0 || e.samt !== 0)
    .map((e) => {
      const out = { sply_ty: e.sply_ty, pos: e.pos, typ: e.typ, rt: e.rt,
                    txval: e.txval, csamt: 0 };
      if (e.sply_ty === 'INTER') out.iamt = e.iamt;
      else { out.camt = e.camt; out.samt = e.samt; }
      return out;
    });

  const b2csNegative = b2cs.filter((e) => e.txval < 0);
  if (b2csNegative.length) {
    problems.push(`${b2csNegative.length} counter-sale summary row${b2csNegative.length === 1 ? '' : 's'} `
      + 'came out negative, because the credit notes this month are worth more than the '
      + 'counter sales at that rate. The portal will not take a negative row. Carry the '
      + 'excess to next month, or adjust it on the portal by hand.');
  }

  /* ---------- Table 8: nil-rated, exempted and non-GST ---------- */
  //
  // Four buckets, as the portal asks for them: registered or not, crossed by
  // in-state or out-of-state. A credit note reduces the bucket it came from.
  const nilBag = {
    INTRB2B: { expt_amt: 0, nil_amt: 0, ngsup_amt: 0 },
    INTRB2C: { expt_amt: 0, nil_amt: 0, ngsup_amt: 0 },
    INTERB2B: { expt_amt: 0, nil_amt: 0, ngsup_amt: 0 },
    INTERB2C: { expt_amt: 0, nil_amt: 0, ngsup_amt: 0 },
  };
  for (const v of [...sales, ...returns]) {
    const sign = v.vtype === 'sale_return' ? -1 : 1;
    const inter = pos(v) !== homeState;
    const reg = !!v.parties?.gstin;
    const key = `${inter ? 'INTER' : 'INTR'}${reg ? 'B2B' : 'B2C'}`;
    for (const l of untaxedLines(v)) {
      const val = n2(sign * num(l.taxable));
      const kind = supplyOf(l);
      if (kind === 'nil')          nilBag[key].nil_amt   = n2(nilBag[key].nil_amt + val);
      else if (kind === 'exempt')  nilBag[key].expt_amt  = n2(nilBag[key].expt_amt + val);
      else if (kind === 'non_gst') nilBag[key].ngsup_amt = n2(nilBag[key].ngsup_amt + val);
    }
  }
  const nilRows = Object.entries(nilBag)
    .filter(([, e]) => e.expt_amt || e.nil_amt || e.ngsup_amt)
    .map(([sply_ty, e]) => ({ sply_ty, ...e }));

  /* ---------- hsn: what was sold, by code ---------- */
  //
  // Everything outward carries an HSN row, nil-rated and exempt included, so
  // Table 12 ties back to the value tables plus Table 8.
  //
  // A ROW MUST NOT GO NEGATIVE. When a month's credit notes for one code are
  // worth more than its sales, netting leaves a negative row and the portal
  // refuses the file. Those rows are held back, and named, so the file uploads
  // and the filer knows exactly what has to be carried or adjusted by hand —
  // which is what genuinely has to happen in that situation anyway.
  const hsnKey = (l) => `${String(l.hsn || '').trim()}|${rate(l)}|${l.unit || ''}|${supplyOf(l)}`;
  const hsnSeed = (l) => ({
    // The portal takes only its own list of unit codes. "Bottles" cut to
    // "BOT" is not on it, and the file is refused for it.
    hsn_sc: String(l.hsn || '').trim(), desc: l.item_name, uqc: uqcOf(l.unit),
    qty: 0, rt: rate(l), txval: 0, iamt: 0, camt: 0, samt: 0, csamt: 0,
  });
  const addTo = (bag, l, sign) => {
    const key = hsnKey(l);
    bag[key] = bag[key] || hsnSeed(l);
    const e = bag[key];
    e.qty   = n2(e.qty + sign * num(l.qty));
    e.txval = n2(e.txval + sign * num(l.taxable));
    e.iamt  = n2(e.iamt + sign * num(l.igst));
    e.camt  = n2(e.camt + sign * num(l.cgst));
    e.samt  = n2(e.samt + sign * num(l.sgst));
  };

  const hsnMap = {};
  for (const v of [...sales, ...returns]) {
    const sign = v.vtype === 'sale_return' ? -1 : 1;
    for (const l of allLines(v)) addTo(hsnMap, l, sign);
  }

  const hsnAll = Object.values(hsnMap);
  const hsnBad = hsnAll.filter((e) => e.txval < 0 || e.qty < 0);
  const hsn = hsnAll.filter((e) => e.txval >= 0 && e.qty >= 0)
    .map((e, i) => ({ num: i + 1, ...e }));
  if (hsnBad.length) {
    problems.push(`${hsnBad.length} HSN row${hsnBad.length === 1 ? '' : 's'} came out negative, `
      + 'because this month\'s credit notes are worth more than the sales of the same code. '
      + 'The portal will not accept a negative row, so '
      + `${hsnBad.length === 1 ? 'it has' : 'they have'} been left out of the file: `
      + hsnBad.slice(0, 5).map((e) => `${e.desc} (${e.hsn_sc || 'no HSN'}, ${e.txval})`).join(', ')
      + (hsnBad.length > 5 ? '…' : '')
      + '. Carry the excess to next month or adjust Table 12 on the portal by hand.');
  }

  // TABLE 12 IS TWO TABLES NOW.
  //
  // From the May 2025 return the portal asks for the HSN summary split into
  // B2B and B2C. The JSON the portal accepts still carries one hsn block, so
  // the file below is unchanged and correct — but whoever files it has two
  // boxes to fill on the screen, and these are the numbers that go in them.
  const hsnSplit = { b2b: {}, b2c: {} };
  for (const v of [...sales, ...returns]) {
    const side = v.parties?.gstin ? 'b2b' : 'b2c';
    const sign = v.vtype === 'sale_return' ? -1 : 1;
    for (const l of allLines(v)) addTo(hsnSplit[side], l, sign);
  }
  const hsnB2b = Object.values(hsnSplit.b2b).map((e, i) => ({ num: i + 1, ...e }));
  const hsnB2c = Object.values(hsnSplit.b2c).map((e, i) => ({ num: i + 1, ...e }));

  // the portal wants 4 digits from a firm under 5 crore and 6 from one above,
  // and it rejects the return outright if a code is shorter than that
  const need = org?.turnover_above_5cr ? 6 : 4;
  const short = [...new Set(hsnAll
    .filter((e) => e.hsn_sc && String(e.hsn_sc).replace(/\D/g, '').length < need)
    .map((e) => `${e.desc} (${e.hsn_sc})`))];
  if (short.length) {
    problems.push(`${short.length} item${short.length === 1 ? ' has an HSN' : 's have HSN codes'} `
      + `shorter than the ${need} digits your turnover needs: `
      + short.slice(0, 5).join(', ') + (short.length > 5 ? '…' : ''));
  }

  // an HSN code is compulsory for a registered firm — say which items lack one
  const noHsn = [...new Set(hsnAll.filter((e) => !e.hsn_sc).map((e) => e.desc))];
  if (noHsn.length) {
    problems.push(`${noHsn.length} item${noHsn.length === 1 ? ' has' : 's have'} no HSN code: `
      + noHsn.slice(0, 5).join(', ') + (noHsn.length > 5 ? '…' : '')
      + '. Since the May 2025 return the portal makes you pick HSN from its own list, '
      + 'so a missing code cannot be typed in at filing time any more.');
  }

  /* ---------- the numbers used, so the portal sees no gaps ---------- */
  // "10" sorts before "2" as text, so a book of bills 1 to 12 would declare a
  // range of 1 to 9 against a count of 12 — exactly the gap this table exists
  // to show. Compare the digits as numbers, and the rest as text.
  const natural = (a, b) => {
    const ax = String(a).match(/(\d+|\D+)/g) || [];
    const bx = String(b).match(/(\d+|\D+)/g) || [];
    for (let i = 0; i < Math.max(ax.length, bx.length); i++) {
      const x = ax[i], y = bx[i];
      if (x === undefined) return -1;
      if (y === undefined) return 1;
      const nx = /^\d+$/.test(x), ny = /^\d+$/.test(y);
      if (nx && ny) { if (+x !== +y) return +x - +y; }
      else if (x !== y) return x < y ? -1 : 1;
    }
    return 0;
  };

  const docRange = (list, dead = []) => {
    const nums = [...list, ...dead]
      .map((v) => String(v.voucher_no || '')).filter(Boolean).sort(natural);
    if (!nums.length) return null;
    return { num: 1, from: nums[0], to: nums[nums.length - 1],
             totnum: nums.length, cancel: dead.length,
             net_issue: nums.length - dead.length };
  };
  const doc_det = [];
  // The numbers the portal gives these: 1 is an outward invoice, 4 is a debit
  // note and 5 is a credit note. Skwik was sending credit notes as 4.
  const invRange = docRange(sales, cancelled);
  if (invRange) doc_det.push({ doc_num: 1, doc_typ: 'Invoices for outward supply', docs: [invRange] });
  const cnRange = docRange(allReturns);
  if (cnRange) doc_det.push({ doc_num: 5, doc_typ: 'Credit Note', docs: [cnRange] });

  const out = {
    gstin: org?.gstin || '',
    fp: gstPeriod(year, month),
    version: 'GST3.2',
    hash: 'hash',
  };
  const b2b = Object.values(b2bMap);
  const b2cl = Object.values(b2clMap);
  const cdnr = Object.values(cdnrMap);
  if (b2b.length)   out.b2b = b2b;
  if (b2cl.length)  out.b2cl = b2cl;
  if (b2cs.length)  out.b2cs = b2cs;
  if (cdnr.length)  out.cdnr = cdnr;
  if (cdnur.length) out.cdnur = cdnur;
  if (nilRows.length) out.nil = { inv: nilRows };
  if (hsn.length)   out.hsn = { data: hsn };
  if (doc_det.length) out.doc_issue = { doc_det };

  const nilTotal = n2(nilRows.reduce((t, e) => t + e.expt_amt + e.nil_amt + e.ngsup_amt, 0));

  return {
    json: out,
    problems,
    // Table 12, in the two halves the portal asks for on screen.
    hsnB2b,
    hsnB2c,
    summary: {
      bills: sales.length,
      notes: returns.length,
      b2b: b2b.reduce((n, c) => n + c.inv.length, 0),
      b2cl: b2cl.reduce((n, c) => n + c.inv.length, 0),
      b2cs: b2cs.length,
      cdnur: cdnur.length,
      // taxable turnover, with nil-rated and exempt value taken out of it
      taxable: n2(sales.reduce((t, v) => t + num(v.taxable), 0)
                - returns.reduce((t, v) => t + num(v.taxable), 0)
                - nilTotal),
      nil_rated: n2(nilRows.reduce((t, e) => t + e.nil_amt, 0)),
      exempt: n2(nilRows.reduce((t, e) => t + e.expt_amt, 0)),
      non_gst: n2(nilRows.reduce((t, e) => t + e.ngsup_amt, 0)),
      tax: n2(sales.reduce((t, v) => t + num(v.cgst) + num(v.sgst) + num(v.igst), 0)
            - returns.reduce((t, v) => t + num(v.cgst) + num(v.sgst) + num(v.igst), 0)),
      cancelled: cancelled.length,
      hsn_b2b_taxable: n2(hsnB2b.reduce((t, e) => t + num(e.txval), 0)),
      hsn_b2c_taxable: n2(hsnB2c.reduce((t, e) => t + num(e.txval), 0)),
      hsn_held_back: hsnBad.length,
    },
  };
}
