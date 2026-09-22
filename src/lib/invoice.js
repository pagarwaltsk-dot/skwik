// THE PRINTED BILL.
//
// Drawn the way Tally draws it, because that is the bill every accountant,
// every buyer and every officer in the country already knows how to read: a
// ruled grid, black on white, nothing decorative, every box where the eye
// expects it. expo-print turns this HTML into the PDF behind both the PRINT
// button and the WhatsApp button.
//
// The fields are not a matter of taste. Rule 46 of the CGST Rules lists what a
// tax invoice must carry, and each one has its place below:
//   (a) supplier name, address, GSTIN            (b) number, max 16 characters
//   (c) date                                     (d) buyer's GSTIN if registered
//   (e) unregistered buyer over Rs 50,000: name, address, delivery address,
//       State and its code                       (g) HSN   (h) description
//   (i) quantity and unit                        (k) taxable value
//   (l) tax rate, each head separately           (m) tax amount, each head
//   (n) place of supply with State name          (p) whether reverse charge
//   (q) signature — not required on a bill sent electronically
// Rule 49 covers the bill of supply a composition dealer issues instead, with
// no tax on it and the declaration printed at the foot.
//
// THE COLUMN HAS TO ADD UP. Every figure that moves the total appears in the
// amount column, once, and the column adds to the total printed under it. That
// is the first thing a customer checks and the first thing an officer checks.
// Line amounts are therefore printed GROSS — what the goods came to before the
// discount — with the discount shown once, as its own row, the way it was
// given. Printing the net amount and the discount row takes it off twice.

import {
  fmt, fmt0, qty, pct, amountInWords, hsnSummary, n2, num, hsnApplies,
  extraAsLine, lineGross, supplyOf, supplyShort, isTaxableLine,
} from './money';
import { uqcShort } from './uqc';

// ALL FIVE, NOT THREE.
//
// Nothing the shopkeeper types lands inside an HTML attribute today, so a bare
// quotation mark in "The \"Best\" Store" is harmless — it prints as a quotation
// mark, which is right. But it is one rearrangement of this file away from
// being a way out of an attribute and into the page, and escaping all five
// costs nothing and changes nothing on the paper.
const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const dmy = (d) => {
  const M = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const x = new Date(d);
  return `${String(x.getDate()).padStart(2, '0')}-${M[x.getMonth()]}-${x.getFullYear()}`;
};

// Tally's own sheet: one hairline grid, no fills, no rounded corners, no
// colour. 8.5pt body text, which is what fits an A4 without looking sparse.
const CSS = `
  * { box-sizing: border-box; }
  @page { size: A4; margin: 8mm; }
  /* the column headings come again at the top of every sheet, and no row is
     ever cut in half by a page break */
  thead { display: table-header-group; }
  tr, tbody tr { break-inside: avoid; page-break-inside: avoid; }
  body { margin: 0; color: #000; background: #fff;
         font-family: Arial, Helvetica, sans-serif; font-size: 8.6pt; line-height: 1.32; }
  table { width: 100%; border-collapse: collapse; }
  td, th { border: 0.6pt solid #000; padding: 2.5pt 4pt; vertical-align: top; }
  .sheet { border: 0.8pt solid #000; }
  .t { text-align: center; font-size: 10pt; font-weight: bold; padding: 4pt 0 3pt;
       border-bottom: 0.6pt solid #000; letter-spacing: .3pt; }
  .copy { text-align: right; font-size: 7pt; padding: 2pt 5pt 0; letter-spacing: .2pt; }
  .k { font-size: 7.2pt; color: #000; letter-spacing: .2pt; }
  .v { font-weight: bold; }
  .nm { font-size: 12pt; font-weight: bold; }
  .r { text-align: right; }
  .c { text-align: center; }
  .nb { border: 0; }
  .grid td { border-right: 0.6pt solid #000; }
  .items th { font-weight: bold; font-size: 7.6pt; text-align: center;
              border-bottom: 0.6pt solid #000; }
  .items td { border-top: 0; border-bottom: 0; }
  .items .rule td { border-top: 0.6pt solid #000; }
  .items .fill td { height: 34mm; border-bottom: 0.6pt solid #000; }
  .big { font-size: 9.6pt; font-weight: bold; }
  .foot td { height: 22mm; }
  .sig { text-align: right; }
  .cg { text-align: center; font-size: 7.2pt; padding-top: 3pt; }
  .it { font-style: italic; font-size: 7.4pt; }
  .tag { font-size: 6.8pt; letter-spacing: .3pt; }
  /* Rule 5(1)(f) wants these words at the TOP of a bill of supply, not in
     the small print at the bottom where they were. */
  .compband { border: 1pt solid #000; padding: 2pt 4pt; text-align: center;
              font-size: 8.4pt; font-weight: bold; margin-bottom: 3pt; }
  /* Rule 46(p): a reverse-charge supply has to say so on its face, and it has
     to be impossible to miss, because the tax is NOT on this bill. */
  .rcband { border: 1.2pt solid #000; padding: 3pt 4pt; text-align: center;
            font-size: 8.6pt; font-weight: bold; margin-bottom: 3pt; }
  /* the two column headings on the statement of account. These were written
     as class="cap" and the class did not exist, so the headings printed at
     body size with no weight and read as another entry in the column. */
  .cap { font-size: 8pt; font-weight: bold; letter-spacing: .6pt;
         text-transform: uppercase; color: #5C5B55; }
`;

export function invoiceHtml({ org, voucher, party, lines, copy }) {
  const rcm     = !!voucher.reverse_charge;
  // Under reverse charge the shop collects no tax, so no tax columns print.
  const igst    = voucher.tax_mode === 'igst';
  const comp    = !!org.is_composition;
  const est     = voucher.vtype === 'estimate' || org.mode === 'estimate';
  // An estimate carries no tax, whatever tax mode the bill was saved with —
  // see the note in receipt.js. The declaration at the foot of this page says
  // so in writing, so the columns above it must agree.
  const gst     = voucher.tax_mode !== 'none' && !rcm && !est;
  const showHsn = hsnApplies(org) && !est;
  // the rate column still prints under reverse charge, because the rate is
  // what the recipient has to pay tax at
  const showRate = voucher.tax_mode !== 'none' && !est;

  // A credit note is a credit note whatever style of billing the shop uses.
  // The estimate test came first, so a shop billing on estimates printed its
  // credit notes with the word "Estimate" at the top of them.
  const isNote = voucher.vtype === 'sale_return' || voucher.vtype === 'purchase_return';
  const title = voucher.vtype === 'sale_return'     ? 'Credit Note'
    : voucher.vtype === 'purchase_return' ? 'Debit Note'
    : est ? 'Estimate'
    : comp ? 'Bill of Supply'
    : (org.is_gst_registered ? 'Tax Invoice' : 'Invoice');

  const buyerNm = party?.name || voucher.printed_name || 'Cash';
  // only a real tax invoice carries the copy mark, the reverse-charge answer
  // and the place of supply
  const taxDoc  = org.is_gst_registered && !est && !comp;
  // The summary covers everything that was taxed, freight included, or its
  // own rows would not add up to its total.
  const freight = extraAsLine(voucher, lines);
  const hsn     = hsnSummary(freight ? [...lines, freight] : lines);
  const qtyAll  = lines.reduce((s, l) => s + Number(l.qty || 0), 0);
  const unitAll = [...new Set(lines.map((l) => uqcShort(l.unit)))];
  const taxTot  = n2(Number(voucher.cgst || 0) + Number(voucher.sgst || 0) + Number(voucher.igst || 0));

  // Nil-rated, exempt and non-GST value on this bill, so the foot can say so.
  const untaxed = lines.filter((l) => !isTaxableLine(l));
  const untaxedVal = n2(untaxed.reduce((s, l) => s + num(l.taxable != null ? l.taxable : l.amount), 0));

  // Rule 46(e): an unregistered buyer taking Rs 50,000 or more of goods must be
  // named on the bill, with where it is going and which State that is.
  const bigCash = !party?.gstin && Number(voucher.taxable || 0) >= 50000;

  const th = (t, cls = '') => `<th class="${cls}">${t}</th>`;

  // What goes in the rate column for a line. A nil-rated or exempt line has no
  // rate — printing "0%" makes it look like an ordinary taxable sale at zero,
  // which is exactly the confusion that empties Table 8 of the return.
  const rateCell = (l) => (isTaxableLine(l)
    ? `${pct(l.gst_rate)}%`
    : `<span class="tag">${esc(supplyShort(l.supply))}</span>`);

  const itemRows = lines.map((l, i) => `
    <tr>
      <td class="c">${i + 1}</td>
      <td><b>${esc(l.item_name)}</b>${l.note ? `<div class="it">${esc(l.note)}</div>` : ''}${
        ''}</td>
      ${showHsn ? `<td class="c">${esc(l.hsn || '')}</td>` : ''}
      ${showRate ? `<td class="c">${rateCell(l)}</td>` : ''}
      <td class="r">${qty(l.qty)} ${esc(uqcShort(l.unit))}</td>
      <td class="r">${fmt(l.rate)}</td>
      <td class="c">${esc(uqcShort(l.unit))}</td>
      <td class="r"><b>${fmt(lineGross(l))}</b></td>
    </tr>`).join('');

  // Tally puts freight, the tax heads and the rounding as further lines of the
  // same column, right-aligned against the description, so the eye runs down
  // one edge to the total.
  const addLine = (label, value) => `
    <tr>
      <td class="c"></td>
      <td class="r"><b>${esc(label)}</b></td>
      ${showHsn ? '<td></td>' : ''}
      ${showRate ? '<td></td>' : ''}
      <td></td><td></td><td></td>
      <td class="r">${fmt(value)}</td>
    </tr>`;

  // Whatever was added OR taken off has to show. A figure that only moves the
  // total leaves a bill whose own lines do not add up to it.
  // ONE DISCOUNT, WHERE IT IS GIVEN: at the bottom, once. It is shared out
  // across the lines inside the books so each rate is taxed on what was
  // really taken for it, but the customer is shown the round figure — and the
  // lines above it are printed gross, so taking it off here takes it off once.
  const lessRow = Number(voucher.discount)
    ? addLine('Less (discount)', -Math.abs(Number(voucher.discount))) : '';

  const extraRow = Number(voucher.extra_amount)
    ? addLine(voucher.extra_note
        || (Number(voucher.extra_amount) < 0 ? 'Less' : 'Freight & Other Charges'),
      voucher.extra_amount) : '';

  const taxRows = (!gst ? '' : (igst
    ? addLine('IGST', voucher.igst)
    : addLine('CGST', voucher.cgst) + addLine('SGST', voucher.sgst)))
    + (Number(voucher.round_off) ? addLine('Round Off', voucher.round_off) : '');

  // The HSN block covers taxable supplies. Nil-rated, exempt and non-GST value
  // is shown under it as its own line rather than mixed in at 0%, because that
  // is how the return asks for it.
  const hsnTaxable = hsn.filter((h) => h.supply === 'taxable');
  const hsnOther   = hsn.filter((h) => h.supply !== 'taxable');

  const hsnBlock = !(gst || rcm) ? '' : `
    <table style="border-top:0">
      <tr>
        ${th('HSN/SAC')}${th('Taxable Value')}
        ${igst ? th('Integrated Tax', '') : th('Central Tax') + th('State Tax')}
        ${th('Total Tax Amount')}
      </tr>
      <tr>
        <td class="nb" style="border-top:0;border-left:0"></td>
        <td class="nb" style="border-top:0"></td>
        ${igst ? '<td class="c k">Rate&nbsp;&nbsp;Amount</td>'
               : '<td class="c k">Rate&nbsp;&nbsp;Amount</td><td class="c k">Rate&nbsp;&nbsp;Amount</td>'}
        <td class="nb" style="border-top:0;border-right:0"></td>
      </tr>
      ${hsnTaxable.map((h) => `
      <tr>
        <td>${esc(h.hsn)}</td>
        <td class="r">${fmt(h.taxable)}</td>
        ${igst
          ? `<td class="r">${pct(h.gst_rate)}%&nbsp;&nbsp;${fmt(h.igst)}</td>`
          : `<td class="r">${pct(h.gst_rate / 2)}%&nbsp;&nbsp;${fmt(h.cgst)}</td>
             <td class="r">${pct(h.gst_rate / 2)}%&nbsp;&nbsp;${fmt(h.sgst)}</td>`}
        <td class="r">${fmt(n2(h.cgst + h.sgst + h.igst))}</td>
      </tr>`).join('')}
      ${hsnOther.map((h) => `
      <tr>
        <td>${esc(h.hsn)}</td>
        <td class="r">${fmt(h.taxable)}</td>
        ${igst
          ? `<td class="c tag">${esc(supplyShort(h.supply))}</td>`
          : `<td class="c tag">${esc(supplyShort(h.supply))}</td><td class="c tag">&mdash;</td>`}
        <td class="r">${fmt(0)}</td>
      </tr>`).join('')}
      <tr>
        <td class="r"><b>Total</b></td>
        <td class="r"><b>${fmt(voucher.taxable)}</b></td>
        ${igst ? `<td class="r"><b>${fmt(voucher.igst)}</b></td>`
               : `<td class="r"><b>${fmt(voucher.cgst)}</b></td>
                  <td class="r"><b>${fmt(voucher.sgst)}</b></td>`}
        <td class="r"><b>${fmt(taxTot)}</b></td>
      </tr>
    </table>
    ${untaxedVal ? `
    <table style="border-top:0">
      <tr><td style="border-left:0;border-right:0">
        <span class="k">Of the above,</span>
        <b>${fmt(untaxedVal)}</b>
        <span class="k">is nil-rated, exempt or outside GST, and carries no tax.</span>
        <span class="k">Taxable value:</span> <b>${fmt(n2(Number(voucher.taxable || 0) - untaxedVal))}</b>
      </td></tr>
    </table>` : ''}
    ${rcm ? '' : `
    <table style="border-top:0">
      <tr><td style="border-left:0;border-right:0">
        <span class="k">Tax Amount (in words):</span> <b>${amountInWords(taxTot, true)}</b>
      </td></tr>
    </table>`}`;

  const declaration = rcm
    ? 'Tax on this supply is payable by the recipient on reverse charge under '
      + 'section 9(3)/9(4) of the CGST Act. No tax has been charged or collected on this invoice.'
    : comp
    ? 'Composition taxable person, not eligible to collect tax on supplies.'
    : est
    ? 'This is an estimate and not a tax invoice. No tax is charged on it.'
    : !org.is_gst_registered
    ? 'Not registered under GST. Goods and Services Tax is not charged on this bill.'
    : 'We declare that this invoice shows the actual price of the goods described '
      + 'and that all particulars are true and correct.';

  return `<!doctype html><html><head><meta charset="utf-8"><style>${CSS}</style></head><body>
  <div class="sheet">
    ${taxDoc ? `<div class="copy">${esc(copy || 'ORIGINAL FOR RECIPIENT')}</div>` : ''}
    ${comp && !est ? `<div class="compband">Composition taxable person, not eligible to
       collect tax on supplies</div>` : ''}
    ${rcm ? `<div class="rcband">TAX PAYABLE ON REVERSE CHARGE BY THE RECIPIENT &mdash;
       NO TAX COLLECTED ON THIS INVOICE</div>` : ''}
    <div class="t">${title}</div>

    <table style="border-left:0;border-right:0">
      <tr>
        <td rowspan="2" style="width:56%;border-left:0">
          <div class="nm">${esc(org.name)}</div>
          <div>${esc(org.address || '')}</div>
          ${org.is_gst_registered && org.gstin && !est
            ? `<div>GSTIN/UIN: <b>${esc(org.gstin)}</b></div>` : ''}
          ${org.state_name
            ? `<div>State Name: ${esc(org.state_name)}, Code: ${esc(org.state_code || '')}</div>` : ''}
          ${org.phone ? `<div>Phone: ${esc(org.phone)}</div>` : ''}
        </td>
        <td style="width:22%"><span class="k">${est ? 'Estimate No.' : 'Invoice No.'}</span>
          <div class="v">${esc(voucher.voucher_no || '')}</div></td>
        <td style="width:22%;border-right:0"><span class="k">Dated</span>
          <div class="v">${dmy(voucher.vdate)}</div></td>
      </tr>
      <tr>
        <td><span class="k">Mode/Terms of Payment</span>
          <div>${voucher.is_cash ? 'Cash' : 'Credit'}</div></td>
        <td style="border-right:0">${taxDoc
          ? `<span class="k">Reverse Charge</span>
             <div><b>${rcm ? 'Yes' : 'No'}</b></div>`
          : '&nbsp;'}</td>
      </tr>
      <tr>
        <td rowspan="2" style="border-left:0">
          <span class="k">${est ? 'To' : 'Buyer (Bill to)'}</span>
          <div class="nm" style="font-size:10.5pt">${esc(buyerNm)}</div>
          <div>${esc(party?.address || voucher.printed_address || '')}</div>
          ${party?.gstin ? `<div>GSTIN/UIN: <b>${esc(party.gstin)}</b></div>` : ''}
          ${party?.state_name
            ? `<div>State Name: ${esc(party.state_name)}, Code: ${esc(party.state_code || '')}</div>`
            : (bigCash ? '<div class="it">State and address required on bills of Rs 50,000 or more</div>' : '')}
          ${party?.phone ? `<div>Phone: ${esc(party.phone)}</div>` : ''}
        </td>
        <td colspan="2" style="border-right:0">${isNote
          ? `<span class="k">Against ${voucher.vtype === 'sale_return' ? 'Invoice' : 'Bill'} No.</span>
             <div class="v">${esc(voucher.ref_invoice_no || '')}</div>
             <span class="k">Dated</span>
             <div>${voucher.ref_invoice_date ? dmy(voucher.ref_invoice_date) : ''}&nbsp;</div>`
          : `<span class="k">Despatched through</span>
             <div>${esc(voucher.transport || '')}&nbsp;</div>`}</td>
      </tr>
      <tr>
        <td colspan="2" style="border-right:0">${taxDoc
          ? `<span class="k">Place of Supply</span>
             <div>${esc(voucher.place_of_supply_name || party?.state_name || org.state_name || '')}</div>`
          : '&nbsp;'}</td>
      </tr>
    </table>

    <!-- A FORTY-LINE BILL RUNS ONTO A SECOND SHEET, AND THE SECOND SHEET USED
         TO ARRIVE WITH NO COLUMN HEADINGS ON IT. Four rows of bare numbers and
         nothing to say which column was the rate and which was the amount.
         <thead> with table-header-group is what makes the browser repeat the
         headings on every printed page, and the rows are told not to break
         across a page boundary. -->
    <table class="items" style="border-left:0;border-right:0">
      <thead><tr>
        ${th('Sl<br>No.')}${th('Description of Goods')}
        ${showHsn ? th('HSN/SAC') : ''}
        ${showRate ? th('GST<br>Rate') : ''}
        ${th('Quantity')}${th('Rate')}${th('per')}${th('Amount')}
      </tr></thead>
      <tbody>
      ${itemRows}
      ${lessRow}${extraRow}
      ${taxRows}
      <tr class="fill"><td></td><td></td>${showHsn ? '<td></td>' : ''}${showRate ? '<td></td>' : ''}
        <td></td><td></td><td></td><td></td></tr>
      <tr class="rule">
        <td></td>
        <td class="r big">Total</td>
        ${showHsn ? '<td></td>' : ''}
        ${showRate ? '<td></td>' : ''}
        <td class="r big">${unitAll.length === 1 ? `${qty(qtyAll)} ${esc(unitAll[0])}` : ''}</td>
        <td></td><td></td>
        <td class="r big">&#8377; ${fmt(voucher.total)}</td>
      </tr>
      </tbody>
    </table>

    <table style="border-top:0">
      <tr><td style="border-left:0;border-right:0">
        <span class="k">Amount Chargeable (in words)</span>
        <span style="float:right" class="k">E. &amp; O.E.</span>
        <div class="v">${amountInWords(voucher.total)}</div>
      </td></tr>
    </table>

    ${hsnBlock}

    <table style="border-top:0">
      <tr>
        <td style="width:58%;border-left:0;border-bottom:0">
          <span class="k">Declaration</span>
          <div>${esc(declaration)}</div>
        </td>
        <td class="sig" style="border-right:0;border-bottom:0">
          <div>for <b>${esc(org.name)}</b></div>
          <div style="height:16mm"></div>
          <div class="k">Authorised Signatory</div>
        </td>
      </tr>
    </table>
  </div>
  <div class="cg">This is a computer generated ${est ? 'estimate' : 'invoice'}</div>
  </body></html>`;
}

// The two-sided account, as a page you can send on WhatsApp.
export function ledgerHtml({ org, party, rows, opening, openingType, balance }) {
  const left  = rows.filter((r) => r.side === 'left');
  const right = rows.filter((r) => r.side === 'right');
  if (Number(opening) > 0) {
    (openingType === 'you_owe' ? right : left).unshift(
      { d: party.opening_date || '', label: 'Opening', amt: opening });
  }
  const sum  = (a) => a.reduce((s, r) => s + Number(r.amt || 0), 0);
  const col  = (a) => a.map((r) => `
    <div style="margin-bottom:10px">
      <div style="font-size:11px;color:#5C5B55">${esc(r.d)} &middot; ${esc(r.label)}</div>
      <div style="font-size:15px;font-weight:bold">${fmt0(r.amt)}</div>
    </div>`).join('') || '<div style="color:#A8A499">&mdash;</div>';

  const owes = balance >= 0;
  return `<!doctype html><html><head><meta charset="utf-8"><style>${CSS}
    @page { size: A5; margin: 10mm; }</style></head><body>
    <div style="font-size:18px;font-weight:bold">${esc(org.name)}</div>
    <div style="font-size:12px;color:#5C5B55;margin-bottom:10px">Account statement</div>
    <div style="font-size:20px;font-weight:bold">${esc(party.name)}</div>
    <div style="margin:10px 0;padding:10px 14px;background:${owes ? '#FBEDEA' : '#E4F2EA'};
                color:${owes ? '#8E3527' : '#0B5C34'};font-weight:bold">
      ${owes ? `${esc(party.name)} owes you` : `You owe ${esc(party.name)}`}
      &nbsp; &#8377; ${fmt0(Math.abs(balance))}
    </div>
    <div style="display:flex;border-top:2px solid #141413;padding-top:8px">
      <div style="flex:1;padding-right:12px;border-right:1px solid #D9D6CC">
        <div class="cap" style="margin-bottom:8px">SALES &amp; GOODS GIVEN</div>${col(left)}
        <div style="border-top:1px solid #141413;padding-top:6px"><b>Total ${fmt0(sum(left))}</b></div>
      </div>
      <div style="flex:1;padding-left:12px;text-align:right">
        <div class="cap" style="margin-bottom:8px">RECEIVED &amp; RETURNS</div>${col(right)}
        <div style="border-top:1px solid #141413;padding-top:6px"><b>Total ${fmt0(sum(right))}</b></div>
      </div>
    </div></body></html>`;
}
