// PRODUCT SEARCH — carried over from the estimate app, with its rules intact.
//
//   "thali 12"        12 thali. A number at the END is always the quantity.
//   "thali x12"       the same, said plainly.
//   "thali 45x2"      90 thali. A sum at the end is worked out as you type.
//   "thali 12 pc"     the same again, with the unit spoken.
//   "5 ltr cooker"    a product whose own name has a number: put it first.
//   ".75 kg"          a fraction. Weighed goods float to the top, because
//                     nobody buys three quarters of a bucket.
//
// Every word you type must appear somewhere in the product — its name, its
// search words, its local names. Order never matters.

import { calc } from './money';

export const tok = (s) =>
  String(s || '').trim().toLowerCase().split(/\s+/).filter(Boolean);

const UNIT_WORDS = 'pc|pcs|piece|pieces|no|nos|qty|ea|unit|units|box|boxes|ctn|carton|cartons|'
                 + 'case|cases|bag|bags|bdl|bundle|bundles|pkt|pkts|dz|doz|dozen|kg|kgs|gm|gms|'
                 + 'ltr|litre|liter|mtr|meter|metre|set|sets|pair|pairs|jodi|gattha|peti';

// Split what he typed into a product part and a quantity.
export function parseQuery(raw) {
  const q = String(raw || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const out = { full: q, base: q, qty: null, bare: false };
  if (!q) return out;
  let m;

  // thali 45x2  /  cooker 12+8  —  a sum at the end, worked out as he types,
  // so the count he does on paper can be typed exactly as he does it.
  const N = '(?:\\d+(?:\\.\\d+)?|\\.\\d+)';
  m = q.match(new RegExp(`^(.*?)\\s+(${N}(?:\\s*[x*+\\-/]\\s*${N})+)$`));
  if (m && m[1]) {
    const v = calc(m[2]);
    if (v > 0) { out.base = m[1].trim(); out.qty = v; return out; }
  }

  // thali x12  /  thali * 12
  m = q.match(/^(.*?)\s*[x*]\s*(\d+(?:\.\d+)?|\.\d+)$/);
  if (m && m[1]) { out.base = m[1].trim(); out.qty = Number(m[2]); return out; }

  // thali 12 pc
  m = q.match(new RegExp('^(.*?)\\s+(\\d+(?:\\.\\d+)?|\\.\\d+)\\s*(' + UNIT_WORDS + ')$'));
  if (m && m[1]) { out.base = m[1].trim(); out.qty = Number(m[2]); return out; }

  // thali 12
  m = q.match(/^(.*?)\s+(\d+(?:\.\d+)?|\.\d+)$/);
  if (m && m[1]) { out.base = m[1].trim(); out.qty = Number(m[2]); out.bare = true; }
  return out;
}

const hay = (p) => `${p.name || ''} ${p.search_words || ''} ${p.alias || ''} ${p.hsn || ''} ${p.unit || ''}`
  .toLowerCase();

// THE WAY A SIZE IS WRITTEN IS NOT PART OF THE NAME.
//
// One item, written six ways by six different people, all of them right:
//
//   TIFFIN CLIP 9X2      TIFFIN CLIP 9 X 2     TIFFIN CLIP 9*2
//   SS PIPE 1/2"         SS PIPE 1/2           SS PIPE 12
//   ANGLE 25-25-3        ANGLE 25X25X3         ANGLE 25 25 3
//
// (A word for the same thing — "half inch" for 1/2 — is a DIFFERENT word, and
// no amount of flattening will join those two up. That is what ALSO CALLED on
// the item is for, and it always was.)
//
// He types one of them and Skwik holds another, so nothing comes up and he
// deletes it and tries again. That is not a search problem, it is a
// PUNCTUATION problem, and punctuation carries no meaning here at all.
//
// So every item is also held in a flattened form: no spaces, no quotes, no
// hyphens, no slashes, no stars, and no "x" sitting between two numbers. What
// he types is flattened the same way and looked for in that. It is a SECOND
// chance, never a replacement — every match the old rules found is still found,
// this only adds the ones they missed.
//
// Note what is NOT thrown away: an x that is part of a word. "extra" must stay
// "extra" or it would match "etra", and "box" must not become "bo".
const flat = (s) => String(s || '')
  .toLowerCase()
  .replace(/[“”"'’‘]/g, '')                 // 1/2" and 1/2 are one size
  .replace(/(\d)\s*[x*×]\s*(\d)/g, '$1$2')   // 9x2, 9 x 2, 9*2  ->  92
  .replace(/[^a-z0-9]+/g, '');              // spaces, hyphens, slashes, dots, brackets

// BOTH FORMS ARE WORKED OUT ONCE PER ITEM, NOT ONCE PER KEYSTROKE.
//
// The plain haystack was rebuilt from five fields for every item on every
// letter he typed, and the search now looks three ways instead of one, which
// would have been three times the work on a list of six thousand. Held against
// the row instead: the shop pays for it on the first letter of the first search
// and never again. A WeakMap, so nothing is kept alive by being remembered.
const HAY = new WeakMap();
const both = (p) => {
  let v = HAY.get(p);
  if (v === undefined) { const h = hay(p); v = { h, f: flat(h) }; HAY.set(p, v); }
  return v;
};

const matches = (items, toks) => {
  if (!toks.length) return [];
  const flats = toks.map(flat).filter(Boolean);
  return items.filter((p) => {
    const { h, f } = both(p);
    if (toks.every((t) => h.indexOf(t) > -1)) return true;
    if (!flats.length) return false;
    return flats.every((t) => f.indexOf(t) > -1);
  });
};

// A FRACTION MEANS IT IS WEIGHED. Whole numbers say nothing either way.
const KG_UNITS  = ['KGS', 'GMS', 'QTL', 'TON', 'MTS'];
const MEASURED  = ['LTR', 'MLT', 'KLR', 'MTR', 'CMS', 'KME', 'SQF', 'SQM', 'SQY', 'CBM', 'CCM', 'ROL', 'YDS'];

function unitBoost(p, qty) {
  if (qty == null || qty === Math.round(qty)) return 0;
  const u = String(p.unit || '').toUpperCase();
  if (KG_UNITS.indexOf(u) > -1) return 40;   // weighed — straight to the top
  if (MEASURED.indexOf(u) > -1) return 12;   // measured out, a fraction is fair
  return 0;
}

// WHAT HE SELLS ALL DAY, AT THE TOP.
//
// Two items match "tel" — the mustard oil he sells forty times a day and the
// brake oil he has sold twice this year — and Skwik had no way of knowing which,
// so it put the shorter name first. He does know, so he can say: a number from 1
// to 10 on the item, 10 meaning show it first.
//
// It is worth 25 points a step, which is deliberate. It outweighs everything
// Skwik guesses at — name length, the fraction-means-weighed nudge — so his
// answer beats Skwik's. It does NOT outweigh an exact name match, worth 1000,
// because when he has typed the name exactly he has already said which item he
// means and no ranking should argue with that.
//
// Nothing set is 0, and 0 behaves exactly as before: this changes nothing for a
// shop that never touches it.
const points = (p) => {
  const v = Math.round(Number(p.priority) || 0);
  return v > 0 ? Math.min(v, 10) * 25 : 0;
};

function score(hit) {
  const p = hit.p;
  const q = (hit.toks || []).join(' ');
  const names = [String(p.name || ''), String(p.alias || '')]
    .map((n) => n.toLowerCase()).filter(Boolean);
  let s = 0;
  if (q && names.indexOf(q) > -1) s += 1000;                          // exact name
  if (q && names.some((n) => n.indexOf(q) === 0)) s += 5;             // starts with
  s += points(p);                                                     // his own 1-10
  s += unitBoost(p, hit.qty);
  s -= Math.min(String(p.name || '').length, 90) / 100;               // shorter wins ties
  return s;
}


// ---------------------------------------------------------------- barcodes

// THE SAME PACKET, READ TWO DIFFERENT WAYS.
//
// "No product with that barcode" on a packet he had scanned in himself a week
// earlier, because the two numbers were not the same string even though they
// are the same code:
//
//   * a code TYPED into the item screen picks up a space at either end, or a
//     hyphen off the label, or is copied in with a non-breaking space in it
//   * UPC-A on an Indian import is thirteen digits on one reader and twelve
//     on another — the same number with a zero in front of it. EAN-8 does the
//     same thing against a shorter code.
//   * a QR code carrying letters differs in case between two readings
//
// So a code is compared by what it IS — its digits and letters, nothing else
// — and a leading zero is not allowed to decide the question.
export const codeKey = (v) => String(v || '').replace(/[^0-9A-Za-z]/g, '').toUpperCase();

export const sameCode = (a, b) => {
  const x = codeKey(a), y = codeKey(b);
  if (!x || !y) return false;
  if (x === y) return true;
  // 0123456789012 read against 123456789012
  return x.replace(/^0+/, '') === y.replace(/^0+/, '') && x.replace(/^0+/, '') !== '';
};

// Every item carrying that code. More than one is possible — he has put the
// same code on two sizes — and the caller decides what to do about it.
export const itemsWithCode = (items, code) =>
  (items || []).filter((it) => sameCode(it.barcode, code));

// Returns [{ p, qty, toks }], best first.
export function searchItems(items, raw, limit = 20) {
  const p = parseQuery(raw);
  if (!p.full) return [];

  // A barcode typed or read into the box is an exact thing, not a search:
  // the packet in his hand is that item and nothing else.
  const code = String(raw || '').trim();
  if (/^[0-9]{6,}$/.test(code)) {
    const exact = itemsWithCode(items, code);
    if (exact.length) return exact.map((pr) => ({ p: pr, qty: null, toks: [] }));
  }

  const seen = {};
  const hits = [];
  // Which reading found it. Readings are shown in order — the one Skwik is
  // surest about first — and only sorted by score inside their own group, so a
  // later reading can never elbow its way above an earlier one.
  const run = (toks, qty, pass) => {
    matches(items, toks).forEach((pr) => {
      if (seen[pr.id]) return;
      seen[pr.id] = 1;
      hits.push({ p: pr, qty, toks, pass });
    });
  };

  // A SIZE ON THE PACKET IS NOT A SUM.
  //
  // "clip 9x2" reads as eighteen clips, and for most of what he sells that is
  // exactly right. But a shop that keeps TIFFIN CLIP 9X2 means the packet, and
  // it was unreachable: the 9x2 was eaten as the quantity before the name was
  // ever looked for. Same for SS PIPE 1/2, ANGLE 25X25X3, WIRE 7/20.
  //
  // Skwik does not guess which it is — it ASKS HIS OWN LIST. Only if the whole
  // line, punctuation and all flattened away, sits inside one of his item names
  // as a single piece is it a name rather than a sum. Nothing is invented: a
  // shop with no such item still gets its eighteen clips.
  //
  // The line read literally is wanted twice below, so the list is walked for it
  // ONCE. On six thousand items that is the difference between a search that
  // keeps up with his typing and one that does not.
  const litToks = tok(p.full);
  const lit = p.qty == null ? null : matches(items, litToks);

  if (lit) {
    const whole = flat(p.full);
    if (whole.length >= 3) {
      lit.forEach((pr) => {
        const nm = flat(`${pr.name || ''} ${pr.alias || ''} ${pr.search_words || ''}`);
        if (nm.indexOf(whole) > -1 && !seen[pr.id]) {
          seen[pr.id] = 1;
          hits.push({ p: pr, qty: null, toks: litToks, pass: 0 });
        }
      });
    }
  }

  // Then the ordinary reading: the trailing number is the quantity.
  if (p.qty == null) run(litToks, null, 1);
  else run(tok(p.base), p.qty, 1);

  // And last, the whole line taken literally, for a product whose name really
  // does end in a number. This used to be tried only when nothing at all had
  // been found AND the number was a plain one; now it always gets its turn, at
  // the bottom, so it can add to the list without ever reordering it.
  if (lit) {
    lit.forEach((pr) => {
      if (seen[pr.id]) return;
      seen[pr.id] = 1;
      hits.push({ p: pr, qty: null, toks: litToks, pass: 2 });
    });
  }

  // Scored once each, not once per comparison. A shop where six thousand items
  // all carry the same search word has six thousand hits to order, and calling
  // score inside the comparator meant working the same item out a dozen times
  // over — which is most of what a search costs on a list that size.
  hits.forEach((h) => { h.rank = score(h); });
  hits.sort((a, b) => (a.pass - b.pass) || (b.rank - a.rank));
  return hits.slice(0, limit);
}

// Splits a name into pieces so the matched letters can be shown marked.
// Returns [{ text, hit }].
export function highlightParts(name, toks) {
  const s = String(name || '');
  if (!toks || !toks.length) return [{ text: s, hit: false }];
  const marks = new Array(s.length).fill(false);
  const low = s.toLowerCase();
  toks.forEach((t) => {
    if (!t) return;
    let i = low.indexOf(t);
    while (i > -1) {
      for (let k = i; k < i + t.length; k++) marks[k] = true;
      i = low.indexOf(t, i + 1);
    }
  });
  const out = [];
  let cur = '', on = marks[0];
  for (let i = 0; i < s.length; i++) {
    if (marks[i] !== on) { out.push({ text: cur, hit: on }); cur = ''; on = marks[i]; }
    cur += s[i];
  }
  if (cur) out.push({ text: cur, hit: on });
  return out;
}
