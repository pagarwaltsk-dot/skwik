// Builds the printed bill as HTML. expo-print turns this into a PDF,
// which is what both the PRINT button and the WhatsApp button use.

import { fmt, fmt0, amountInWords, hsnSummary, n2, hsnApplies } from './money';
import { uqcShort } from './uqc';

const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

const dmy = (d) => {
  const M = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const x = new Date(d);
  return `${String(x.getDate()).padStart(2,'0')}-${M[x.getMonth()]}-${x.getFullYear()}`;
};

const CSS = `
  * { box-sizing: border-box; }
  body { margin: 0; font-family: Helvetica, Arial, sans-serif; color: #141413; font-size: 11px; }
  .sheet { border: 1.2px solid #141413; }
  .head { text-align: center; font-size: 11px; font-weight: bold; letter-spacing: 2px;
          padding: 5px 0; border-bottom: 1.2px solid #141413; }
  .firm { padding: 9px 12px; border-bottom: 1.2px solid #141413; }
  .firm .nm { font-size: 19px; font-weight: bold; }
  .firm .ad { margin-top: 3px; font-size: 11px; line-height: 1.45; }
  .two { display: flex; border-bottom: 1.2px solid #141413; }
  .two .l { flex: 1; padding: 8px 12px; border-right: 1.2px solid #141413; }
  .two .r { width: 200px; padding: 8px 12px; }
  .cap { font-size: 9.5px; font-weight: bold; letter-spacing: 1px; color: #5C5B55; }
  .party { font-size: 14px; font-weight: bold; margin-top: 3px; }
  .kv { margin-bottom: 4px; }
  .kv b { display: inline-block; width: 95px; font-weight: normal; color: #5C5B55; }
  table { width: 100%; border-collapse: collapse; }
  th { background: #F1EFE8; font-size: 9.5px; letter-spacing: .6px; text-align: right;
       padding: 6px 12px; border-bottom: 1.2px solid #141413; }
  th.l, td.l { text-align: left; }
  td { padding: 7px 12px; font-size: 11.5px; }
  .tot { display: flex; padding: 8px 12px; background: #F1EFE8;
         border-top: 1.2px solid #141413; border-bottom: 1.2px solid #141413; }
  .tot .t1 { flex: 1; text-align: right; padding-right: 14px; font-size: 13px; font-weight: bold; }
  .tot .t2 { width: 110px; text-align: right; font-size: 15px; font-weight: bold; }
  .words { padding: 7px 12px; border-bottom: 1.2px solid #141413; }
  .note { padding: 8px 12px; border-bottom: 1.2px solid #141413; background: #FBF7EC;
          font-size: 10.5px; font-weight: bold; color: #6B4A12; }
  .foot { display: flex; }
  .foot .l { flex: 1; padding: 8px 12px; border-right: 1.2px solid #141413; font-size: 10px; line-height: 1.4; }
  .foot .r { width: 200px; padding: 8px 12px; text-align: right; font-size: 10.5px; }
  .sign { margin-top: 38px; font-size: 10px; color: #5C5B55; }
  .rt { text-align: right; }
`;

export function invoiceHtml({ org, voucher, party, lines }) {
  // Tax columns show only when tax was actually charged.
  // HSN shows for any registered firm, including a composition dealer.
  const gst      = voucher.tax_mode !== 'none';
  const igst     = voucher.tax_mode === 'igst';
  const comp     = !!org.is_composition;
  const est      = voucher.vtype === 'estimate' || org.mode === 'estimate';
  const showHsn  = hsnApplies(org) && !est;
  const title    = est ? 'ESTIMATE'
                 : comp ? 'BILL OF SUPPLY'
                 : (org.is_gst_registered ? 'TAX INVOICE' : 'INVOICE');
  const buyerNm  = party?.name || voucher.printed_name || 'CASH';
  const hsn      = hsnSummary(lines);

  const itemRows = lines.map((l, i) => `
    <tr${l.flag ? ' style="background:#FFF6D9"' : ''}>
      <td>${i + 1}</td>
      <td class="l"><b>${esc(l.item_name)}</b></td>
      ${showHsn ? `<td class="rt">${esc(l.hsn || '')}</td>` : ''}
      <td class="rt">${fmt0(l.qty)} ${esc(uqcShort(l.unit))}</td>
      <td class="rt">${fmt(l.rate)}</td>
      <td class="rt">${esc(uqcShort(l.unit))}</td>
      <td class="rt"><b>${fmt(l.amount)}</b></td>
    </tr>`).join('');

  const extraRow = Number(voucher.extra_amount) > 0
    ? `<tr><td colspan="${showHsn ? 6 : 5}" class="rt">${esc(voucher.extra_note || 'Extra')}</td>
         <td class="rt">${fmt(voucher.extra_amount)}</td></tr>` : '';

  const taxRows = !gst ? '' : (igst
    ? `<tr><td colspan="${showHsn ? 6 : 5}" class="rt">IGST</td><td class="rt">${fmt(voucher.igst)}</td></tr>`
    : `<tr><td colspan="6" class="rt">CGST</td><td class="rt">${fmt(voucher.cgst)}</td></tr>
       <tr><td colspan="6" class="rt">SGST</td><td class="rt">${fmt(voucher.sgst)}</td></tr>`)
    + `<tr><td colspan="${showHsn ? 6 : 5}" class="rt">Round Off</td><td class="rt">${fmt(voucher.round_off)}</td></tr>`;

  const hsnBlock = !gst ? '' : `
    <table>
      <tr>
        <th class="l">HSN/SAC</th>
        <th>TAXABLE VALUE</th>
        ${igst ? '<th>IGST</th>' : '<th>CGST</th><th>SGST</th>'}
        <th>TOTAL TAX</th>
      </tr>
      ${hsn.map((h) => `
      <tr>
        <td class="l">${esc(h.hsn)}</td>
        <td class="rt">${fmt(h.taxable)}</td>
        ${igst ? `<td class="rt">${fmt(h.igst)}</td>`
               : `<td class="rt">${fmt(h.cgst)}</td><td class="rt">${fmt(h.sgst)}</td>`}
        <td class="rt">${fmt(n2(h.cgst + h.sgst + h.igst))}</td>
      </tr>`).join('')}
      <tr style="border-top:1px solid #C9C5BA">
        <td class="l"><b>Total</b></td>
        <td class="rt"><b>${fmt(voucher.taxable)}</b></td>
        ${igst ? `<td class="rt"><b>${fmt(voucher.igst)}</b></td>`
               : `<td class="rt"><b>${fmt(voucher.cgst)}</b></td><td class="rt"><b>${fmt(voucher.sgst)}</b></td>`}
        <td class="rt"><b>${fmt(n2(voucher.cgst + voucher.sgst + voucher.igst))}</b></td>
      </tr>
    </table>`;

  return `<!doctype html><html><head><meta charset="utf-8">
    <style>${CSS} @page { size: A5; margin: 8mm; }</style></head><body>
    <div class="sheet">
      <div class="head">${title}</div>

      <div class="firm">
        <div class="nm">${esc(org.name)}</div>
        <div class="ad">
          ${esc(org.address || '')}<br>
          ${org.is_gst_registered && !est && org.gstin ? `GSTIN/UIN: ${esc(org.gstin)} &nbsp;&middot;&nbsp; State: ${esc(org.state_name || '')}, Code: ${esc(org.state_code || '')}<br>` : ''}
          ${org.phone ? `Phone: ${esc(org.phone)}` : ''}
        </div>
      </div>

      <div class="two">
        <div class="l">
          <div class="cap">${org.is_gst_registered ? 'BUYER (BILL TO)' : 'BILL TO'}</div>
          <div class="party">${esc(buyerNm)}</div>
          <div class="ad">
            ${esc(party?.address || '')}<br>
            ${party?.gstin ? `GSTIN/UIN: ${esc(party.gstin)}<br>` : ''}
            ${party?.state_name ? `State: ${esc(party.state_name)}, Code: ${esc(party.state_code || '')}` : ''}
          </div>
        </div>
        <div class="r">
          <div class="kv"><b>${est ? 'Estimate No.' : org.is_gst_registered ? 'Invoice No.' : 'Bill No.'}</b><strong>${esc(voucher.voucher_no || '')}</strong></div>
          <div class="kv"><b>Dated</b><strong>${dmy(voucher.vdate)}</strong></div>
          ${voucher.transport ? `<div class="kv"><b>Transport</b>${esc(voucher.transport)}</div>` : ''}
          ${org.is_gst_registered && !est ? `<div class="kv"><b>Place of Supply</b>${esc(voucher.place_of_supply_name || org.state_name || '')}</div>` : ''}
          <div class="kv"><b>Payment</b>${voucher.is_cash ? 'Cash' : 'Credit'}</div>
        </div>
      </div>

      <table>
        <tr>
          <th class="l">SL</th>
          <th class="l">DESCRIPTION OF GOODS</th>
          ${showHsn ? '<th>HSN</th>' : ''}
          <th>QTY</th><th>RATE</th><th>PER</th><th>AMOUNT</th>
        </tr>
        ${itemRows}
        ${extraRow}
        ${taxRows}
      </table>

      <div class="tot"><div class="t1">TOTAL</div><div class="t2">&#8377; ${fmt(voucher.total)}</div></div>

      <div class="words"><span style="color:#5C5B55">Amount Chargeable (in words):</span>
        <b>${amountInWords(voucher.total)}</b></div>

      ${hsnBlock}

      ${est
        ? '<div class="note">This is an estimate, not a tax invoice. GST is not charged on it. E. &amp; O.E.</div>'
        : comp
        ? '<div class="note">Composition taxable person, not eligible to collect tax on supplies.</div>'
        : (org.is_gst_registered ? ''
          : '<div class="note">Not registered under GST. Goods and Services Tax is not charged on this bill.</div>')}

      <div class="foot">
        <div class="l"><span class="cap">DECLARATION</span><br>
          We declare that this bill shows the actual price of the goods described
          and that all particulars are true and correct.</div>
        <div class="r">for <b>${esc(org.name)}</b><div class="sign">Authorised Signatory</div></div>
      </div>
    </div></body></html>`;
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
