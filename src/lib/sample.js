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

// NO BILL GOES ABOVE 35,000. NOT ONE.
//
// This is a rule about EVERY bill Skwik writes in a month, not only the ones
// raised against money already received. A shop of this size does not write
// single bills of a lakh; it writes a lot of ordinary ones. A month that
// comes out as thirty bills averaging 40,000 does not look like his trade,
// and it is the first thing anybody notices.
//
// So the ceiling is the rule and the bill COUNT is the wish. If the figure he
// asked for cannot be reached in the number of bills he asked for without
// going over, Skwik writes more bills and says so on the plan.
export const MAX_BILL = 35000;
// aimed a little under the ceiling, so ordinary unevenness still fits below it
const PART_SIZE = 28000;

// PUSH ANYTHING OVER THE CEILING DOWN ONTO THE SMALLEST PARTS.
// The total never changes — rupees only move between bills.
function underCeiling(out, ceiling) {
  if (!(ceiling > 0)) return out;
  for (let pass = 0; pass < 400; pass++) {
    let hi = 0, lo = 0;
    for (let i = 1; i < out.length; i++) {
      if (out[i] > out[hi]) hi = i;
      if (out[i] < out[lo]) lo = i;
    }
    if (out[hi] <= ceiling || hi === lo) break;
    const move = Math.min(out[hi] - ceiling,
                          Math.max(1, Math.ceil((out[hi] - out[lo]) / 2)));
    out[hi] -= move;
    out[lo] += move;
  }
  return out;
}

// HOW A RECEIPT TOO BIG FOR ONE BILL IS CUT UP.
//
// Uneven, but not wildly so: 20,000 + 30,000 + 25,000 + 35,000 is a month of
// buying. splitTotal is deliberately lumpier than this and is right for the
// made-up bills; a real customer's month is steadier. Nothing comes out above
// the ceiling.
export function evenParts(total, n, r, ceiling = MAX_BILL) {
  if (n < 1 || total <= 0) return [];
  if (n === 1) return [Math.round(total)];
  const avg = total / n;
  let raw = [];
  for (let i = 0; i < n; i++) raw.push(avg * (0.65 + r() * 0.7));
  const sum = raw.reduce((a, b) => a + b, 0);
  const out = raw.map((x) => Math.max(1, Math.round((x * total) / sum)));
  const drift = Math.round(total) - out.reduce((a, b) => a + b, 0);
  const big = out.indexOf(Math.max(...out));
  out[big] = Math.max(1, out[big] + drift);
  return underCeiling(out, ceiling);
}

// How many bills a figure has to become to stay under the ceiling.
export const partsFor = (amount, ceiling = MAX_BILL) =>
  (amount <= ceiling ? 1 : Math.max(2, Math.ceil(amount / PART_SIZE)));

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

// Pick an item, favouring what there is most of — measured in MONEY, not in
// pieces.
//
// Counting pieces made nonsense of a mixed shop. Ten thousand washers at ₹2
// is ₹20,000 of stock; ten machines at ₹5,000 is ₹50,000. By the piece the
// washers looked a thousand times the bigger pile, so the run emptied the
// washer bin and barely touched the machines — and bills came out reading
// "8,000 washers" instead of anything a shop would actually write.
//
// By value the machines are rightly the bigger half of the shelf, and both
// get sold the way a real month sells them.
function take(r, pool) {
  const live = pool.filter((p) => p.left > 0);
  if (!live.length) return null;
  const weights = live.map((p) => {
    if (p.left === Infinity) return 1;
    // square root, so a shelf ten times as valuable is about three times as
    // likely — a leaning, not a landslide
    const w = Math.sqrt(p.left * p.rate);
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
const billTotal = (lines, mode, discount = null) => computeBill(lines.map((l) => ({
  qty: l.qty, rate: l.rate, gst_rate: Number(l.item.gst_rate) || 0, disc: l.disc || 0,
})), mode, { discount: discount == null ? lines.discount || 0 : discount }).total;

// A receipt of 5,700 is what the customer PAID — tax and all. So the bill has
// to come to 5,700 on its face, not 5,700 before tax.
//
// The bill's OWN discount is nudged until the printed total is that figure
// exactly, which is what a shopkeeper does when he rounds a bill off at the
// counter. It used to be pushed onto the last line, which put the whole
// rounding on one tax rate; shared across the bill it lands where it belongs.
export function fitToTotal(lines, target, mode) {
  const gross = n2(lines.reduce((a, l) => a + n2(l.qty * l.rate), 0));
  // the average rate the bill carries, so the first guess is close
  const avg = mode === 'none' ? 0
    : (gross > 0
        ? lines.reduce((a, l) => a + n2(l.qty * l.rate) * (Number(l.item.gst_rate) || 0), 0) / gross
        : 0);

  let want = 0;
  for (let i = 0; i < 10; i++) {
    const total = billTotal(lines, mode, want);
    const off = total - target;
    if (off === 0) { lines.discount = n2(want); return true; }
    want = n2(want + off / (1 + avg / 100));
    if (want < 0 || want >= gross) return false;        // cannot get there at all
  }
  if (billTotal(lines, mode, want) === target) { lines.discount = n2(want); return true; }
  return false;
}

/* ---------------- one bill ---------------- */

// Fill a bill towards a figure out of what is actually on the shelf.
// `exact` is for a bill raised against money already received: it has to come
// to that amount to the rupee, so the last line takes one more piece than it
// needs and the difference comes off as a discount — which is what happens at
// a counter anyway, and it shows on the bill.
// HOW MANY THINGS A BILL OF THIS SIZE CARRIES.
//
// A big bill is big because a lot went into the bag, not because one thing
// was dear. A thirty-thousand-rupee bill with three lines on it looks like a
// machine wrote it. These are the bands a shopkeeper recognises.
export function linesWanted(target, r) {
  const n = (lo, hi) => lo + Math.floor(r() * (hi - lo + 1));
  if (target >= 30000) return n(15, 20);
  if (target >= 15000) return n(10, 12);
  return n(7, 8);
}

export function buildLines(target, pool, r, { exact = false, maxLines = 0, mode = 'none', avgRate = 12 } = {}) {
  // Aim below the figure when tax is going on top of it, or every bill comes
  // out over by the rate. The shop's own usual rate is a far better guess than
  // a fixed one: a 5% grocer and an 18% hardware shop are not the same.
  const guessRate = mode === 'none' ? 0 : avgRate;
  const face = target;
  target = target / (1 + guessRate / 100);
  const lines = [];

  let want = linesWanted(face, r);
  if (maxLines > 0) want = Math.min(want, maxLines);
  // a shop with six things on its list cannot write a bill of twenty
  want = Math.max(1, Math.min(want, pool.filter((p) => p.left > 0).length));

  let left = target;

  // A BILL RAISED AGAINST MONEY ALREADY TAKEN MUST REACH THAT FIGURE.
  //
  // The band above says how many lines a bill of this size usually carries,
  // and the loop used to stop dead at that many — even with most of the
  // figure still unspent. The bill then landed SHORT, and the only thing that
  // moves a printed total afterwards is the bill's own discount, which can
  // only come down. So a short bill could never be made to fit and the
  // receipt was quietly passed over.
  //
  // That fell hardest on the biggest receipts, which are usually the bank
  // ones: a receipt of 95,000 needs far more on it than the band allows, so
  // it failed nearly every time while the small cash receipts sailed through.
  // Bank money was being left unexplained by the very step meant to explain
  // it first.
  //
  // An exact bill may now keep reaching until the figure is actually covered.
  // It still cannot sell what is not on the shelf.
  const stopAt = exact ? want * 3 : want;
  for (let i = 0; i < stopAt && left > 0.5; i++) {
    // Reaching for something already on this bill wastes a line: the two
    // merge and the bill comes out shorter than it should. Try again for
    // something else before giving in and adding to what is there.
    let p = take(r, pool);
    for (let tries = 0; p && tries < 6
         && lines.some((l) => l.item.id === p.it.id); tries++) {
      const other = take(r, pool);
      if (!other || other.it.id === p.it.id) break;
      p = other;
    }
    if (!p) break;

    // SPREAD THE BILL, DO NOT FRONT-LOAD IT.
    //
    // The old share took a third to four-fifths of everything remaining on
    // the first line, which is fine for a bill of three and absurd for a bill
    // of eighteen: the first two lines ate it and the rest came out at one
    // piece each. Each line now takes roughly its fair portion of what is
    // left, give or take a half, and the last one takes the remainder.
    const rest  = Math.max(1, want - i);
    const share = rest <= 1 ? left : left * (1 / rest) * (0.55 + r() * 0.9);

    let q = share / p.rate;
    q = p.weighed ? Math.round(q * 4) / 4 : Math.round(q);
    if (q <= 0) q = p.weighed ? 0.25 : 1;

    // NOBODY SELLS THE WHOLE BIN IN ONE BILL.
    // At most a quarter of what is on the shelf goes out on any one bill, so
    // ten thousand washers do not leave as a single line of ten thousand.
    if (p.left !== Infinity) {
      const cap = p.weighed ? p.left / 4 : Math.max(1, Math.floor(p.left / 4));
      q = Math.min(q, cap, p.weighed ? p.left : Math.floor(p.left));
    }
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
  let shortDays = false;              // a receipt needed more days than the period has
  const roof = poolValue(pool);       // what the shelf is worth

  // MONEY THAT PAID OFF AN OLD DUE IS NOT MONEY WAITING FOR A BILL.
  //
  // He had a customer carrying 1,25,000 from before Skwik who paid 70,000 in
  // the month. That receipt has no bill against it, so Skwik wrote 70,000 of
  // goods to explain it — and the customer was left owing money he had already
  // paid down, on the strength of a month of trade that never happened.
  //
  // The receipt was not unexplained at all. THE OPENING DUE EXPLAINS IT. What
  // actually needs a bill is only the part that pushes an account into CREDIT:
  // money in hand that nothing he owes can account for. So each customer is
  // allowed no more than his own credit as at the end of the period, and a
  // customer who still owed money on that date is left alone entirely.
  //
  // `room` comes off his own ledger, worked out by the database. A receipt with
  // no customer on it has no ledger to check against, so it is not limited.
  const roomLeft = {};
  const roomFor = (rec) => {
    if (!rec.party_id) return Infinity;
    if (!(rec.party_id in roomLeft)) {
      roomLeft[rec.party_id] = rec.room == null ? Infinity : Math.max(0, num(rec.room));
    }
    return roomLeft[rec.party_id];
  };
  const shortfall = [];     // receipts the days could not carry the whole of
  const owedFirst = [];     // receipts left alone: that customer still owed money
  let trimmed = 0;          // rupees of receipt covered by an old due, not billed
  const billedAgainst = {}; // receipt id -> rupees of bills actually raised for it

  // 1. Bills against money he has already taken. These come first: they are
  //    the real ones, and they have to match to the rupee.
  //
  //    MONEY THAT CAME THROUGH THE BANK IS SETTLED BEFORE ANY CASH IS TOUCHED.
  //
  //    Receipts arrived in date order, cash and bank mixed together, and were
  //    taken in that order. So a run that ran out of bills, or out of goods on
  //    the shelf, could leave bank receipts unmatched while it had happily
  //    spent the room on cash ones.
  //
  //    That is the wrong way round. Money in the bank is money somebody can
  //    see: it has to be explained by a bill. Cash is the part that bends. So
  //    every bank receipt is taken first, oldest first, and only then the cash
  //    ones — and whatever target is left over after that becomes cash sales.
  const inBank = (m) => String(m || '').toLowerCase() !== 'cash';
  const ordered = [...receipts].sort((a, b) => {
    const ab = inBank(a.mode) ? 0 : 1, bb = inBank(b.mode) ? 0 : 1;
    if (ab !== bb) return ab - bb;
    return String(a.pdate || '').localeCompare(String(b.pdate || ''));
  });

  // PUT BACK WHAT AN ATTEMPT TOOK OFF THE SHELF.
  const putBack = (ls) => (ls || []).forEach((l) => {
    const q = pool.find((x) => x.it.id === l.item.id);
    if (q && q.left !== Infinity) q.left = n2(q.left + l.qty);
    if (q) q.used = Math.max(0, (q.used || 0) - 1);
  });

  // The number of bills he asked for is a wish; the 35,000 ceiling is a rule,
  // and money already received has to be covered whatever the count says. The
  // only hard stop is the same 500 the screen allows.
  const HARD_STOP = 500;
  for (const rec of ordered) {
    if (bills.length >= HARD_STOP) break;
    const paid = num(rec.amount);
    if (paid <= 0) continue;

    // How much of this receipt his account cannot already account for.
    const room = roomFor(rec);
    if (room <= 0) { owedFirst.push(rec); continue; }
    const amt = room === Infinity ? paid : Math.min(paid, room);
    if (amt < 1) { owedFirst.push(rec); continue; }

    const party = rec.party_id
      ? { id: rec.party_id, name: rec.party, gstin: rec.gstin,
          state_code: rec.state_code, price_list: rec.price_list }
      : (customers.length ? pick(r, customers) : { name: 'CASH' });
    const mode = taxOf(party);

    // ONE BILL FOR THE FIGURE, TO THE RUPEE.
    // The bill has to PRINT it, tax included, or the ledger will not settle.
    // Worth several goes: a different mix of goods often lands where the first
    // could not, usually because the shelf ran short of what it reached for.
    const oneBill = (figure) => {
      for (let go = 0; go < 6; go++) {
        const t = buildLines(figure, pool, r, { exact: true, mode, avgRate: usualRate });
        if (!t) return null;
        if (fitToTotal(t, Math.round(figure), mode)) return t;
        putBack(t);
      }
      return null;
    };

    // WHICH DAYS THE PARTS FALL ON.
    // A receipt is money that arrived on one day for goods that went out over
    // several, so the parts are dated on or before the day it came in, one to
    // a day — never two bills to the same customer on the same date, which is
    // the thing that makes a made-up month look made up.
    const onDate = (rec.pdate && rec.pdate >= from && rec.pdate <= to) ? rec.pdate : null;
    // EITHER SIDE OF THE DAY THE MONEY CAME, WITHIN A MONTH OF IT.
    // Bills used to be forced on or before the payment date. That is wrong:
    // a customer pays in advance as often as he pays after, and both are
    // ordinary. So any working day within thirty days either way will do,
    // as long as it is inside the period asked for.
    const near = onDate
      ? days.filter((d) => Math.abs(Date.parse(d) - Date.parse(onDate))
                           <= 30 * 24 * 3600 * 1000)
      : days;
    const chooseDays = (n) => {
      const from2 = (near.length >= n ? near : days).slice();
      const out = [];
      while (out.length < n && from2.length) {
        out.push(from2.splice(Math.floor(r() * from2.length), 1)[0]);
      }
      return out.sort();
    };

    // A BIG RECEIPT IS NOT ONE BIG BILL.
    //
    // Nobody hands over a lakh for a single sale. The money is a month of
    // buying, so it is written the way it happened: three, four or five bills
    // of uneven size on different days, all to the same customer, and the
    // receipt settles the lot. Small receipts stay one bill, because that is
    // what they were.
    // NEVER FEWER THAN THIS, WHATEVER GOES WRONG.
    // Falling back to fewer, fatter bills would put one over the ceiling,
    // which is the thing he asked me to stop. If it cannot be done in this
    // many, the receipt is left alone and the plan says why.
    const minParts = partsFor(amt);

    // Try the natural number of parts first. If one of them cannot be built
    // out of what is on the shelf, try MORE parts — smaller bills are easier
    // to land — never fewer, which would push one over the ceiling.
    let made = null;
    for (let n = minParts; n <= minParts + 3 && !made; n++) {
      const cut = n === 1 ? [Math.round(amt)] : evenParts(Math.round(amt), n, r);
      const dates = n === 1 ? [onDate || pick(r, days)] : chooseDays(n);
      if (dates.length < n) { shortDays = true; continue; }   // too few separate days
      const out = [];
      let broke = false;
      for (let k = 0; k < n; k++) {
        const ls = oneBill(cut[k]);
        if (!ls) { broke = true; break; }
        out.push({ vdate: dates[k], lines: ls, target: cut[k] });
      }
      if (broke) { out.forEach((o) => putBack(o.lines)); continue; }
      made = out;
    }

    // AS MUCH AS THE DAYS ALLOW, RATHER THAN NOTHING AT ALL.
    //
    // He put in a receipt of five lakh against a customer who owed him one
    // thirty, so three seventy needed explaining — and Skwik wrote NOT ONE
    // BILL. Three seventy needs fourteen separate days at the ceiling, his
    // period held five, and the whole thing was abandoned rather than settled
    // in part. From where he sat it simply did nothing and said nothing.
    //
    // That is the wrong answer. Five days can still carry a lakh and a half,
    // and a lakh and a half of his money explained is better than none of it.
    // So when the full amount will not fit in the days available, it writes
    // what WILL fit, and the plan says how much is left and why — which is a
    // thing he can act on by widening the dates.
    let short = 0;
    if (!made) {
      const room = (near.length ? near : days);
      const canDo = Math.min(room.length, Math.max(0, HARD_STOP - bills.length));
      // aimed at the comfortable size rather than the ceiling, so the bills
      // that do get written still look like a shop's ordinary bills
      const reach = Math.min(amt, canDo * PART_SIZE);
      if (canDo >= 1 && reach >= 1) {
        const n = Math.max(1, Math.min(canDo, partsFor(reach)));
        const dates = n === 1 ? [onDate || pick(r, room)] : chooseDays(n);
        if (dates.length === n) {
          const cut = n === 1 ? [Math.round(reach)] : evenParts(Math.round(reach), n, r);
          const out = [];
          for (let k = 0; k < n; k++) {
            const ls = oneBill(cut[k]);
            if (!ls) break;
            out.push({ vdate: dates[k], lines: ls, target: cut[k] });
          }
          if (out.length) {
            made = out;
            shortDays = true;
          } else {
            out.forEach((o) => putBack(o.lines));
          }
        }
      }
    }
    if (!made) continue;                                // leave that receipt alone

    // what this receipt actually got covered for, which is not always what it
    // was worth — see above
    const placed = n2(made.reduce((a, m) => a + num(m.target), 0));
    short = n2(Math.max(0, amt - placed));
    if (short > 0) shortfall.push({ id: rec.id, party: rec.party, short, placed });

    made.forEach((m, k) => bills.push({
      vdate: m.vdate, party, lines: m.lines,
      // The money is already in his books as a receipt. Marking this a cash
      // sale would have Skwik write a SECOND receipt for the same rupees, so
      // it goes in as an ordinary bill and the receipt he already has is tied
      // to it — which is what settles the customer's ledger to nothing.
      //
      // Where a receipt became several bills, only the last one carries it.
      // The earlier parts sit on the customer's account until that day, which
      // is exactly what happened: he bought through the month and paid once.
      // The account still comes to nothing, because the bills add up to the
      // receipt to the rupee.
      is_cash: false,
      receipt: k === made.length - 1 ? rec : null,
      partOf: made.length > 1 ? rec.id : null,
      target: m.target,
    }));
    used.push(rec);
    billedAgainst[rec.id] = n2((billedAgainst[rec.id] || 0) + placed);
    // COUNTED HERE, NOT WHERE IT WAS WORKED OUT. A receipt can still fall over
    // further down — the shelf will not carry it, or the period has too few
    // days — and it then goes to `missed`, not to the old-dues figure. Adding
    // it up above meant the plan told him money had gone against an old due
    // when in fact no bill had been raised for any of it.
    if (amt < paid) trimmed = n2(trimmed + (paid - amt));
    // and that much of his credit is now spoken for, so a second receipt from
    // the same customer cannot be billed against the same room twice
    if (rec.party_id && roomLeft[rec.party_id] !== Infinity) {
      roomLeft[rec.party_id] = Math.max(0, n2(roomLeft[rec.party_id] - placed));
    }
  }

  // 2. The rest, up to the count and the total he asked for.
  const totalOf = (b) => billTotal(b.lines, taxOf(b.party));
  const paidFor = n2(bills.reduce((a, b) => a + totalOf(b), 0));
  let restTotal = Math.max(0, n2(total - paidFor));
  // THE CEILING BEATS THE COUNT.
  // He asks for a number of bills; if his figure cannot be reached in that
  // many without one going over 35,000, more are written and the plan says so.
  const askedRest = Math.max(0, count - bills.length);
  const needRest  = restTotal > 0 ? Math.ceil(restTotal / PART_SIZE) : 0;
  const restCount = Math.max(askedRest, needRest);

  // never promise more than the shelf can carry
  const roofLeft = poolValue(pool);
  let capped = false;
  if (stock && restTotal > roofLeft) { restTotal = roofLeft; capped = true; }

  if (restCount > 0 && restTotal > 0) {
    const amounts = underCeiling(splitTotal(restTotal, restCount, r), MAX_BILL);
    for (const amt of amounts) {
      const party = customers.length ? pick(r, customers) : { name: 'CASH' };
      const mode = taxOf(party);
      // An ordinary bill is not fitted to a figure, so it can land a little
      // over what it aimed at. Anything that lands over the ceiling is put
      // back and aimed lower, rather than written.
      let lines = null;
      for (let go = 0; go < 4 && !lines; go++) {
        const t = buildLines(amt * (1 - go * 0.06), pool, r,
                             { exact: false, mode, avgRate: usualRate });
        if (!t) break;
        if (billTotal(t, mode) <= MAX_BILL) { lines = t; break; }
        putBack(t);
      }
      if (!lines) break;
      bills.push({
        vdate: pick(r, days),
        party, lines,
        // WHAT IS LEFT OVER IS CASH HE TOOK OVER THE COUNTER.
        //
        // Every rupee that came through the bank has already been spoken for
        // above. Anything still needed to reach his figure is money that came
        // in across the counter and was never written down — so it is a cash
        // sale, not an amount somebody still owes him. Marking part of it
        // udhar would put debt on customers who never took any.
        //
        // cashShare still lets him leave some of it on the books if that is
        // how his month really went; at 1 the whole remainder is cash.
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
      // so the plan can say "you asked for 50, the ceiling needs 62"
      askedBills: count,
      fromReceipts: used.length,
      // THE PART BILLED FOR, NOT THE WHOLE RECEIPT. Where some of a payment
      // went against an old due, only the rest of it has bills behind it, and
      // saying otherwise would make the plan's own arithmetic disagree.
      receiptValue: n2(used.reduce((a, x) => a + (billedAgainst[x.id] || 0), 0)),
      // told apart, because he needs to see the bank side is fully covered
      bankReceipts: used.filter((x) => inBank(x.mode)).length,
      bankValue: n2(used.filter((x) => inBank(x.mode))
                        .reduce((a, x) => a + (billedAgainst[x.id] || 0), 0)),
      cashReceipts: used.filter((x) => !inBank(x.mode)).length,
      cashValue: n2(used.filter((x) => !inBank(x.mode))
                        .reduce((a, x) => a + (billedAgainst[x.id] || 0), 0)),
      // and what is left over once every receipt has been settled
      overAndAbove: n2(Math.max(0, value
                        - used.reduce((a, x) => a + (billedAgainst[x.id] || 0), 0))),
      // MONEY THAT NEEDED NO BILL. These customers were still in debt on the
      // last day of the period, so their payments are explained by what they
      // already owed and nothing was invented to cover them.
      owedFirst: owedFirst.length,
      owedFirstValue: n2(owedFirst.reduce((a, x) => a + num(x.amount), 0)),
      trimmed: n2(trimmed),
      // MONEY THE DATES COULD NOT CARRY. A customer may have only one bill a
      // day, so a big receipt needs many days; where the period does not hold
      // enough, as much as fits is written and this is what is left.
      shortDays: shortfall.length > 0 || shortDays,
      shortReceipts: shortfall.length,
      shortValue: n2(shortfall.reduce((a, x) => a + num(x.short), 0)),
      shortWho: shortfall.slice(0, 3).map((x) => x.party).filter(Boolean),
      // receipts this run could not raise a bill for, whatever the mode:
      // almost always because the shelf cannot carry that much. The ones left
      // alone on purpose above are not failures and are not counted here.
      missed: receipts.filter((x) => num(x.amount) > 0
                          && !used.some((u) => u.id === x.id)
                          && !owedFirst.some((o) => o.id === x.id)).length,
      bankLeftOver: n2(receipts.filter((x) => inBank(x.mode)
                          && !used.some((u) => u.id === x.id)
                          && !owedFirst.some((o) => o.id === x.id))
                        .reduce((a, x) => a + num(x.amount), 0)),
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
