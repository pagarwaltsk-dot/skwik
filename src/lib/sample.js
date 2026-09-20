// A MONTH OF TRADE, WRITTEN FOR REAL.
//
// A shopkeeper who has just paid for Skwik has an empty app. He cannot see
// what his reports will look like, or his ledgers, or his stock moving,
// because he has not billed anything yet — and he will not put a real day's
// trade into it until he has seen it work. So Skwik fills the month in for
// him.
//
// What comes out are ORDINARY BILLS. No mark, no flag, nothing that behaves
// differently: his own numbering, his own tax, his own print, editable
// afterwards like any other. If he is unregistered they carry no tax; on
// composition they come out as a bill of supply; registered, they carry CGST
// and SGST at home and IGST out of state, with his own items' HSN on them. A
// bill that looked or behaved like a demonstration would tell him nothing.
//
// Three things make it his month rather than a made-up one:
//
//   THE MONEY HE ACTUALLY TOOK. Receipts already in his books for that period
//   that are not yet against a bill — his UPI and cash entries — are matched
//   to the rupee, and the bill is tied to the receipt, so the customer's
//   ledger settles to nothing, exactly as it would have.
//
//   WHAT IS ON THE SHELF. Items are chosen in proportion to what he actually
//   has, and nothing is ever sold past it. A run that would send an item
//   negative stops instead and says how far the stock went.
//
//   WHO HE SELLS TO. His own customers, in his own proportion of cash to
//   credit, spread over working days.

import { computeBill, n2, num, saleRate, taxModeFor } from './money';

/* ---------------- small, predictable randomness ---------------- */

export function rng(seed = Date.now()) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

const pick = (r, arr) => arr[Math.floor(r() * arr.length) % arr.length];

// A shop is not shut on a Sunday everywhere, but a month of billing with no
// gap at all looks invented, and most shops are quieter on one day.
export function workingDays(from, to, { skipSundays = true } = {}) {
  const out = [];
  const a = new Date(`${from}T00:00:00`);
  const b = new Date(`${to}T00:00:00`);
  if (isNaN(a) || isNaN(b) || b < a) return [from];
  for (const d = new Date(a); d <= b; d.setDate(d.getDate() + 1)) {
    if (skipSundays && d.getDay() === 0) continue;
    out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
  }
  return out.length ? out : [from];
}

// n amounts adding up to total. Real bills cluster round an average with a
// long tail — a few big ones, many small. A flat spread reads as invented at
// a glance.
export function splitTotal(total, n, r) {
  if (n < 1 || total <= 0) return [];
  const avg = total / n;
  let raw = [];
  for (let i = 0; i < n; i++) {
    const spread = r() < 0.12 ? 1.8 + r() * 1.6 : 0.35 + r() * 1.45;
    raw.push(avg * spread);
  }
  const sum = raw.reduce((a, b) => a + b, 0);
  raw = raw.map((x) => (x * total) / sum);
  const out = raw.map((x) => Math.max(1, Math.round(x)));
  const drift = Math.round(total) - out.reduce((a, b) => a + b, 0);
  const big = out.indexOf(Math.max(...out));
  out[big] = Math.max(1, out[big] + drift);
  return out;
}

/* ---------------- what is on the shelf ---------------- */

const WEIGHED = ['KGS', 'GMS', 'LTR', 'MLT', 'MTR', 'QTL', 'TON', 'SQM', 'SQF'];
const isWeighed = (u) => WEIGHED.includes(String(u || '').toUpperCase());

// The pool an entire run draws from. Every quantity taken comes off it, so
// nothing can be sold twice and nothing can go below zero.
export function makePool(items, stock) {
  const have = {};
  (stock || []).forEach((s) => { have[s.item_id] = num(s.qty); });
  const pool = [];
  for (const it of items) {
    // the same floor the bill screen uses: an item with only a cost on it
    // still has a rate, so it is not silently left out of the month
    const rate = saleRate(it, 1) || num(it.price2);
    if (rate <= 0) continue;
    // no stock figures at all — the shop does not keep stock, so there is
    // nothing to run out of
    const qty = stock ? (have[it.id] || 0) : Infinity;
    if (qty <= 0) continue;
    pool.push({ it, rate, left: qty, used: 0, weighed: isWeighed(it.unit) });
  }
  return pool;
}

export const poolValue = (pool) =>
  n2(pool.reduce((a, p) => a + (p.left === Infinity ? 0 : p.left * p.rate), 0));

// Pick an item, favouring what he has most of. A shop sells what is piled up
// by the door far more often than the one box at the back — but it still sells
// the other things, so no single item is allowed to swallow the run. Weight is
// on the QUANTITY on the shelf, not on what that quantity is worth: ten boxes
// of a costly item is a small pile, not a big one.
function take(r, pool) {
  const live = pool.filter((p) => p.left > 0);
  if (!live.length) return null;
  const weights = live.map((p) => {
    if (p.left === Infinity) return 1;
    // square root, so a shelf ten times as deep is about three times as likely
    const w = Math.sqrt(p.left);
    // and each time it has been billed in this run it steps back a little, so
    // the rest of the list gets a turn
    return w / (1 + (p.used || 0) * 0.5);
  });
  const total = weights.reduce((a, b) => a + b, 0);
  if (total <= 0) return pick(r, live);
  let t = r() * total;
  for (let i = 0; i < live.length; i++) {
    t -= weights[i];
    if (t <= 0) return live[i];
  }
  return live[live.length - 1];
}

/* ---------------- hitting a figure the customer actually paid ---------------- */

// What the lines come to once the tax is on them, as the bill will print it.
const billTotal = (lines, mode) => computeBill(lines.map((l) => ({
  qty: l.qty, rate: l.rate, gst_rate: Number(l.item.gst_rate) || 0, disc: l.disc || 0,
})), mode).total;

// A receipt of 5,700 is what the customer PAID — tax and all. So the bill has
// to come to 5,700 on its face, not 5,700 before tax. The last line's
// discount is nudged until the printed total is that figure exactly, which is
// what a shopkeeper does when he rounds a bill off at the counter.
export function fitToTotal(lines, target, mode) {
  const last = lines[lines.length - 1];
  const rate = mode === 'none' ? 0 : (Number(last.item.gst_rate) || 0);
  const gross = n2(last.qty * last.rate);

  for (let i = 0; i < 8; i++) {
    const total = billTotal(lines, mode);
    const off = total - target;
    if (off === 0) return true;
    // taking x off the taxable value takes x * (1 + rate/100) off the total
    const want = n2(num(last.disc) + off / (1 + rate / 100));
    if (want < 0 || want >= gross) return false;        // cannot get there on this line
    last.disc = want;
    last.amount = n2(gross - want);
  }
  return billTotal(lines, mode) === target;
}

/* ---------------- one bill ---------------- */

// Fill a bill towards a figure out of what is actually on the shelf.
// `exact` is for a bill raised against money already received: it has to come
// to that amount to the rupee, so the last line takes one more piece than it
// needs and the difference comes off as a discount — which is what happens at
// a counter anyway, and it shows on the bill.
export function buildLines(target, pool, r, { exact = false, maxLines = 6, mode = 'none', avgRate = 12 } = {}) {
  // Aim below the figure when tax is going on top of it, or every bill comes
  // out over by the rate. The shop's own usual rate is a far better guess than
  // a fixed one: a 5% grocer and an 18% hardware shop are not the same.
  const guessRate = mode === 'none' ? 0 : avgRate;
  target = target / (1 + guessRate / 100);
  const lines = [];
  // most bills are two or three lines, a few are long — never one flat spread
  const spread = r();
  const want = Math.max(1, Math.min(maxLines,
    spread < 0.14 ? 1 : spread < 0.48 ? 2 : spread < 0.74 ? 3 : spread < 0.90 ? 4 : 5 + Math.round(r()))); 
  let left = target;

  for (let i = 0; i < want && left > 0.5; i++) {
    const p = take(r, pool);
    if (!p) break;

    const share = i === want - 1 ? left : left * (0.35 + r() * 0.45);
    let q = share / p.rate;
    q = p.weighed ? Math.round(q * 4) / 4 : Math.round(q);
    if (q <= 0) q = p.weighed ? 0.25 : 1;
    if (p.left !== Infinity) q = Math.min(q, p.weighed ? p.left : Math.floor(p.left));
    if (q <= 0) { p.left = 0; i--; continue; }        // nothing left of this one

    const amount = n2(q * p.rate);
    const at = lines.find((l) => l.item.id === p.it.id);
    if (at) { at.qty = n2(at.qty + q); at.amount = n2(at.amount + amount); }
    else lines.push({ item: p.it, qty: q, rate: p.rate, amount, disc: 0, _p: p });
    if (p.left !== Infinity) p.left = n2(p.left - q);
    p.used = (p.used || 0) + 1;
    left = n2(left - amount);
  }

  if (!lines.length) return null;

  lines.forEach((l) => { delete l._p; });
  return lines;
}

/* ---------------- the whole plan ---------------- */

// receipts: money already in his books for the period, not yet against a bill
//           [{ id, pdate, amount, mode, party_id, party, gstin, state_code }]
// stock:    [{ item_id, qty }] — leave it out and nothing runs out
export function planSample({
  org = null, items = [], parties = [], receipts = [], stock = null,
  from, to, count = 50, total = 0, cashShare = 0.55, seed,
}) {
  const r = rng(seed);
  // Unregistered or on composition: no tax at all. Registered: CGST and SGST
  // at home, IGST out of state. Exactly the rule a real bill follows.
  const taxOf = (party) =>
    (!org || org.mode === 'estimate') ? 'none' : taxModeFor(org, party);
  const days = workingDays(from, to);
  const pool = makePool(items, stock);

  // the rate most of the shelf carries, weighted by what is on it
  const usualRate = (() => {
    if (!pool.length) return 12;
    const by = {};
    pool.forEach((p) => {
      const g = Number(p.it.gst_rate) || 0;
      by[g] = (by[g] || 0) + (p.left === Infinity ? 1 : p.left * p.rate);
    });
    const best = Object.entries(by).sort((a, b) => b[1] - a[1])[0];
    return Number(best[0]) || 0;
  })();

  if (!items.length) {
    return { bills: [], problem: 'Add a few items first. Bills are made from your own '
      + 'list, at your own rates.' };
  }
  if (!pool.length) {
    return { bills: [], problem: stock
      ? 'Nothing is in stock. Enter a purchase bill or two first, and then come back — '
        + 'a bill cannot sell what the shop does not have.'
      : 'None of your items has a rate on it yet.' };
  }

  const customers = parties.filter((p) => {
    const k = String(p.kind || '').toLowerCase();
    return !k || k === 'customer' || k === 'both';
  });

  const bills = [];
  const used = [];                    // receipts actually taken
  const roof = poolValue(pool);       // what the shelf is worth

  // 1. Bills against money he has already taken. These come first: they are
  //    the real ones, and they have to match to the rupee.
  for (const rec of receipts) {
    if (bills.length >= count) break;
    const amt = num(rec.amount);
    if (amt <= 0) continue;
    const party = rec.party_id
      ? { id: rec.party_id, name: rec.party, gstin: rec.gstin,
          state_code: rec.state_code, price_list: rec.price_list }
      : (customers.length ? pick(r, customers) : { name: 'CASH' });
    const mode = taxOf(party);

    // The bill has to PRINT his figure, tax included, or the ledger will not
    // settle. Worth three goes: a different mix of goods often lands where the
    // first could not, usually because the shelf ran short of what it reached
    // for first.
    let lines = null;
    for (let go = 0; go < 3 && !lines; go++) {
      const tryLines = buildLines(amt, pool, r, { exact: true, mode, avgRate: usualRate });
      if (!tryLines) break;
      if (fitToTotal(tryLines, Math.round(amt), mode)) { lines = tryLines; break; }
      // put back what that attempt took off the shelf
      tryLines.forEach((l) => {
        const q = pool.find((x) => x.it.id === l.item.id);
        if (q && q.left !== Infinity) q.left = n2(q.left + l.qty);
        if (q) q.used = Math.max(0, (q.used || 0) - 1);
      });
    }
    if (!lines) continue;                               // leave that receipt alone
    bills.push({
      vdate: rec.pdate && rec.pdate >= from && rec.pdate <= to ? rec.pdate : pick(r, days),
      party, lines,
      // The money is already in his books as a receipt. Marking this a cash
      // sale would have Skwik write a SECOND receipt for the same rupees, so
      // it goes in as an ordinary bill and the receipt he already has is tied
      // to it — which is what settles the customer's ledger to nothing.
      is_cash: false,
      receipt: rec,
      target: amt,
    });
    used.push(rec);
  }

  // 2. The rest, up to the count and the total he asked for.
  const totalOf = (b) => billTotal(b.lines, taxOf(b.party));
  const paidFor = n2(bills.reduce((a, b) => a + totalOf(b), 0));
  const restCount = Math.max(0, count - bills.length);
  let restTotal = Math.max(0, n2(total - paidFor));

  // never promise more than the shelf can carry
  const roofLeft = poolValue(pool);
  let capped = false;
  if (stock && restTotal > roofLeft) { restTotal = roofLeft; capped = true; }

  if (restCount > 0 && restTotal > 0) {
    const amounts = splitTotal(restTotal, restCount, r);
    for (const amt of amounts) {
      const party = customers.length ? pick(r, customers) : { name: 'CASH' };
      const mode = taxOf(party);
      const lines = buildLines(amt, pool, r, { exact: false, mode, avgRate: usualRate });
      if (!lines) break;
      bills.push({
        vdate: pick(r, days),
        party, lines,
        is_cash: r() < cashShare,
        receipt: null,
        target: amt,
      });
    }
  }

  bills.sort((a, b) => a.vdate.localeCompare(b.vdate));

  bills.forEach((b) => { b.total = totalOf(b); });
  const value = n2(bills.reduce((a, b) => a + b.total, 0));
  return {
    bills,
    usedReceipts: used,
    problem: null,
    summary: {
      n: bills.length,
      value,
      askedFor: n2(total),
      fromReceipts: used.length,
      receiptValue: n2(used.reduce((a, x) => a + num(x.amount), 0)),
      cash: bills.filter((b) => b.is_cash).length,
      days: [...new Set(bills.map((b) => b.vdate))].length,
      items: [...new Set(bills.flatMap((b) => b.lines.map((l) => l.item.id)))].length,
      // how much of his list could be billed at all. A bill cannot sell what
      // the shop has none of, so if only a few items have stock, only those
      // few can appear — which is the usual reason a run looks repetitive.
      catalog: items.length,
      pooled: pool.length,
      stockRoof: stock ? roof : null,
      capped,
      shortBy: n2(Math.max(0, n2(total) - value)),
    },
  };
}
