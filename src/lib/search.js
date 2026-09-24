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

const matches = (items, toks) => {
  if (!toks.length) return [];
  return items.filter((p) => { const h = hay(p); return toks.every((t) => h.indexOf(t) > -1); });
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

function score(hit) {
  const p = hit.p;
  const q = (hit.toks || []).join(' ');
  const names = [String(p.name || ''), String(p.alias || '')]
    .map((n) => n.toLowerCase()).filter(Boolean);
  let s = 0;
  if (q && names.indexOf(q) > -1) s += 1000;                          // exact name
  if (q && names.some((n) => n.indexOf(q) === 0)) s += 5;             // starts with
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
  const run = (toks, qty) => {
    matches(items, toks).forEach((pr) => {
      if (seen[pr.id]) return;
      seen[pr.id] = 1;
      hits.push({ p: pr, qty, toks });
    });
  };

  // One reading first: the trailing number is the quantity. Only if that finds
  // nothing does the whole line get tried literally, so a product whose name
  // really does end in a number can still be reached.
  if (p.qty == null) run(tok(p.full), null);
  else run(tok(p.base), p.qty);
  if (!hits.length && p.bare) run(tok(p.full), null);

  hits.sort((a, b) => score(b) - score(a));
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
