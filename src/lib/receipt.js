// THE LITTLE PRINTER ON THE COUNTER.
//
// A tax invoice on A4 is for the file and the accountant. What the customer
// takes home from a counter is a slip off a 58mm or 80mm roll, and shrinking
// an A4 page down to that width gives you something nobody can read.
//
// So this is a receipt drawn for the roll it is going onto: one column, big
// enough to read, no lines it does not need, and no fixed page height —
// thermal paper is a roll, so the page is as long as the bill.
//
// THE SLIP HAS TO ADD UP, TOP TO BOTTOM, exactly as the customer reads it:
//
//   Items      the lines above, added up, BEFORE any discount
//   Less       the discount, once
//   Freight    if there is any
//   Taxable    what tax is worked out on  = Items - Less + Freight
//   CGST/SGST  the tax
//   Round off
//   TOTAL
//
// Two things used to break that. The Items figure was built from the stored
// taxable value, which already has the freight inside it, so it over-stated
// the goods by the freight. And the freight then printed again below the tax,
// so it was added twice. Both figures now come from the lines themselves.

import {
  amountInWords, fmt, fmt0, hsnApplies, num, pct, qty,
  lineGross, itemsGross, isTaxableLine, supplyShort,
} from './money';
import { uqcShort } from './uqc';

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const dmy = (d) => `${String(d).slice(8, 10)}/${String(d).slice(5, 7)}/${String(d).slice(0, 4)}`;

// 58mm rolls print about 48mm wide; 80mm rolls about 72mm. The rest is the
// margin the printer cannot reach.
const PAPER = {
  '58': { page: '58mm', body: '48mm', base: 11, big: 15, name: 13 },
  '80': { page: '80mm', body: '72mm', base: 12, big: 18, name: 15 },
};

export function thermalHtml({ org, voucher, party, lines, width = '80' }) {
  const p = PAPER[String(width)] || PAPER['80'];
  const rcm = !!voucher.reverse_charge;
  // Under reverse charge the shop collects nothing, so no tax lines print.
  const gst = voucher.tax_mode && voucher.tax_mode !== 'none' && !rcm;
  // A roll is the only document some shops ever issue, so what is on it has to
  // stand on its own: HSN and the rate per line, not just a total.
  const showHsn = hsnApplies(org) && voucher.vtype !== 'estimate';
  const igst = voucher.tax_mode === 'igst';
  const est = voucher.vtype === 'estimate' || org?.mode === 'estimate';

  const title = voucher.vtype === 'sale_return' ? 'CREDIT NOTE'
    : voucher.vtype === 'purchase_return' ? 'DEBIT NOTE'
    : est ? 'ESTIMATE'
    : org?.is_composition ? 'BILL OF SUPPLY'
    : org?.is_gst_registered ? 'TAX INVOICE' : 'BILL';

  const rows = (lines || []).map((l) => {
    const q    = num(l.qty);
    const rate = num(l.rate);
    // GROSS on the line: the discount comes off once, further down, as its
    // own row. Printing the net here and the discount below takes it twice.
    const amt  = lineGross(l);
    const mark = isTaxableLine(l)
      ? (voucher.tax_mode && voucher.tax_mode !== 'none' && num(l.gst_rate)
          ? ` &middot; ${pct(l.gst_rate)}%` : '')
      : ` &middot; ${esc(supplyShort(l.supply))}`;
    return `
      <div class="it">
        <div class="nm">${esc(l.item_name)}${l.flag ? ' <b>★</b>' : ''}</div>
        ${l.note ? `<div class="nt">${esc(l.note)}</div>` : ''}

        <div class="qr">
          <span>${qty(q)} ${esc(uqcShort(l.unit || ''))} &times; ${fmt(rate)}${mark}${
            showHsn && l.hsn ? ` &middot; ${esc(l.hsn)}` : ''}</span>
          <span class="amt">${fmt(amt)}</span>
        </div>
      </div>`;
  }).join('');

  const taxRows = !gst ? '' : (igst
    ? `<div class="tr"><span>IGST</span><span>${fmt(voucher.igst)}</span></div>`
    : `<div class="tr"><span>CGST</span><span>${fmt(voucher.cgst)}</span></div>
       <div class="tr"><span>SGST</span><span>${fmt(voucher.sgst)}</span></div>`);

  const less = Number(voucher.discount)
    ? `<div class="tr"><span>Less</span><span>- ${fmt(Math.abs(Number(voucher.discount)))}</span></div>` : '';

  // Freight belongs ABOVE the taxable line, because it is inside it.
  const extra = Number(voucher.extra_amount)
    ? `<div class="tr"><span>${esc(voucher.extra_note || 'Other')}</span><span>${fmt(voucher.extra_amount)}</span></div>` : '';

  const round = Number(voucher.round_off)
    ? `<div class="tr"><span>Round off</span><span>${fmt(voucher.round_off)}</span></div>` : '';

  const items = itemsGross(lines);

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  /* a roll has no page height — let it run as long as the bill is */
  @page { size: ${p.page} auto; margin: 0; }
  * { box-sizing: border-box; -webkit-print-color-adjust: exact; }
  body { width: ${p.body}; margin: 0 auto; padding: 4mm 0 8mm;
         font-family: -apple-system, "Helvetica Neue", Arial, sans-serif;
         font-size: ${p.base}px; line-height: 1.35; color: #000; }
  .mid { text-align: center; }
  .shop { font-size: ${p.name}px; font-weight: 700; letter-spacing: .2px; }
  .sm { font-size: ${p.base - 1}px; }
  .muted { color: #444; }
  .rule { border-top: 1px dashed #000; margin: 2.5mm 0; }
  .kv { display: flex; justify-content: space-between; gap: 4px; }
  .it { margin-bottom: 2mm; }
  .nm { font-weight: 600; }
  .nt { font-size: ${p.base - 1}px; color: #333; font-style: italic; }
  .qr { display: flex; justify-content: space-between; gap: 4px; }
  .amt { font-variant-numeric: tabular-nums; }
  .tr { display: flex; justify-content: space-between; font-size: ${p.base}px; }
  .tot { display: flex; justify-content: space-between; align-items: baseline;
         font-size: ${p.big}px; font-weight: 700; margin-top: 1.5mm; }
  .words { font-size: ${p.base - 1}px; margin-top: 1.5mm; }
  .foot { margin-top: 4mm; font-size: ${p.base - 1}px; }
  .band { border: 1px solid #000; padding: 1.5mm; text-align: center;
          font-weight: 700; font-size: ${p.base - 1}px; margin: 2mm 0; }
</style></head>
<body>
  <div class="mid">
    <div class="shop">${esc(org?.name || '')}</div>
    ${org?.address ? `<div class="sm muted">${esc(org.address)}</div>` : ''}
    ${org?.phone ? `<div class="sm muted">${esc(org.phone)}</div>` : ''}
    ${org?.is_gst_registered && org?.gstin && !est
      ? `<div class="sm muted">GSTIN ${esc(org.gstin)}</div>` : ''}
    <div class="rule"></div>
    <div><b>${title}</b></div>
    ${org?.is_composition && !est
      ? `<div class="sm"><b>Composition taxable person, not eligible to
         collect tax on supplies</b></div>` : ''}
  </div>

  ${rcm ? `<div class="band">TAX PAYABLE ON REVERSE CHARGE BY RECIPIENT.
     NO TAX COLLECTED ON THIS BILL.</div>` : ''}

  <div class="kv sm"><span>No.</span><b>${esc(voucher.voucher_no || '')}</b></div>
  <div class="kv sm"><span>Date</span><span>${dmy(voucher.vdate)}</span></div>
  ${voucher.ref_invoice_no
    ? `<div class="kv sm"><span>Against bill</span><span>${esc(voucher.ref_invoice_no)}`
      + `${voucher.ref_invoice_date ? ` of ${dmy(voucher.ref_invoice_date)}` : ''}</span></div>` : ''}
  <div class="kv sm"><span>${voucher.is_cash ? 'Cash' : 'Credit'}</span>
       <span>${esc(party?.name || voucher.printed_name || 'CASH')}</span></div>
  ${party?.gstin ? `<div class="kv sm"><span>GSTIN</span><span>${esc(party.gstin)}</span></div>` : ''}

  <div class="rule"></div>
  ${rows}
  <div class="rule"></div>

  <div class="tr"><span>Items</span><span>${fmt(items)}</span></div>
  ${less}
  ${extra}
  <div class="tr"><span>Taxable</span><span>${fmt(voucher.taxable)}</span></div>
  ${taxRows}${round}
  <div class="tot"><span>TOTAL</span><span>&#8377; ${fmt0(voucher.total)}</span></div>
  <div class="words muted">${esc(amountInWords(voucher.total))}</div>

  <div class="mid foot">
    ${est ? 'An estimate, not a tax invoice.' : 'Thank you'}
    <div class="sm muted" style="margin-top:2mm">Skwik</div>
  </div>
</body></html>`;
}
