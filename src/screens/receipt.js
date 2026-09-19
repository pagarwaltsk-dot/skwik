// THE LITTLE PRINTER ON THE COUNTER.
//
// A tax invoice on A4 is for the file and the accountant. What the customer
// takes home from a counter is a slip off a 58mm or 80mm roll, and shrinking
// an A4 page down to that width gives you something nobody can read.
//
// So this is a receipt drawn for the roll it is going onto: one column, big
// enough to read, no lines it does not need, and no fixed page height —
// thermal paper is a roll, so the page is as long as the bill.

import { fmt, fmt0, n2, num, amountInWords } from './money';
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
  const gst = voucher.tax_mode && voucher.tax_mode !== 'none';
  const igst = voucher.tax_mode === 'igst';
  const est = voucher.vtype === 'estimate' || org?.mode === 'estimate';

  const title = est ? 'ESTIMATE'
    : org?.is_composition ? 'BILL OF SUPPLY'
    : org?.is_gst_registered ? 'TAX INVOICE' : 'BILL';

  const rows = (lines || []).map((l) => {
    const qty  = num(l.qty);
    const rate = num(l.rate);
    const amt  = n2(l.amount != null ? l.amount : qty * rate);
    return `
      <div class="it">
        <div class="nm">${esc(l.item_name)}${l.flag ? ' <b>★</b>' : ''}</div>
        ${l.note ? `<div class="nt">${esc(l.note)}</div>` : ''}
        <div class="qr">
          <span>${qty} ${esc(uqcShort(l.unit || ''))} &times; ${fmt0(rate)}</span>
          <span class="amt">${fmt(amt)}</span>
        </div>
      </div>`;
  }).join('');

  const taxRows = !gst ? '' : (igst
    ? `<div class="tr"><span>IGST</span><span>${fmt(voucher.igst)}</span></div>`
    : `<div class="tr"><span>CGST</span><span>${fmt(voucher.cgst)}</span></div>
       <div class="tr"><span>SGST</span><span>${fmt(voucher.sgst)}</span></div>`);

  const extra = Number(voucher.extra_amount) > 0
    ? `<div class="tr"><span>${esc(voucher.extra_note || 'Other')}</span><span>${fmt(voucher.extra_amount)}</span></div>` : '';

  const round = Number(voucher.round_off)
    ? `<div class="tr"><span>Round off</span><span>${fmt(voucher.round_off)}</span></div>` : '';

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
  </div>

  <div class="kv sm"><span>No.</span><b>${esc(voucher.voucher_no || '')}</b></div>
  <div class="kv sm"><span>Date</span><span>${dmy(voucher.vdate)}</span></div>
  <div class="kv sm"><span>${voucher.is_cash ? 'Cash' : 'Credit'}</span>
       <span>${esc(party?.name || voucher.printed_name || 'CASH')}</span></div>
  ${party?.gstin ? `<div class="kv sm"><span>GSTIN</span><span>${esc(party.gstin)}</span></div>` : ''}

  <div class="rule"></div>
  ${rows}
  <div class="rule"></div>

  <div class="tr"><span>Items</span><span>${fmt(voucher.taxable)}</span></div>
  ${taxRows}${extra}${round}
  <div class="tot"><span>TOTAL</span><span>&#8377; ${fmt0(voucher.total)}</span></div>
  <div class="words muted">${esc(amountInWords(voucher.total))}</div>

  <div class="mid foot">
    ${est ? 'An estimate, not a tax invoice.' : 'Thank you'}
    <div class="sm muted" style="margin-top:2mm">Skwik</div>
  </div>
</body></html>`;
}
