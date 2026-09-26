// BILLING WITH NO SIGNAL.
//
// A shop in a basement, a godown behind a tin wall, a village line that comes
// and goes — the bill still has to be written and handed over. So nothing in
// this app waits for the internet to write a bill.
//
// How it works, in one paragraph. Items and customers are copied onto the
// phone every time they load, so the billing screen can always open. A bill
// that cannot reach the server is written into a queue on the phone with its
// own number and its own id, and printed straight away. The queue empties
// itself the next time anything succeeds. Because every queued bill carries
// the id it will have on the server, sending the same one twice cannot make
// two bills.
//
// The one thing to know: bill numbers are handed out by this phone while it
// is offline. One shop billing from one phone is safe. Two phones billing
// offline at the same time would both reach for the same number.

import AsyncStorage from '@react-native-async-storage/async-storage';
import { supportLine } from './contact';

const SUPPORT = supportLine();

const K = {
  items:    'skwik.cache.items',
  parties:  'skwik.cache.parties',
  org:      'skwik.cache.org',
  queue:    'skwik.queue',
  counters: 'skwik.counters',
};

/* ---------------- the plumbing ---------------- */

const read = async (key, fallback) => {
  try {
    const raw = await AsyncStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (e) { return fallback; }
};

const write = async (key, value) => {
  try { await AsyncStorage.setItem(key, JSON.stringify(value)); return true; }
  catch (e) { return false; }
};

// An id the phone makes itself, so a bill written offline already knows what
// it will be called on the server. This is what stops a bill being sent twice.
export function uuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : ((r & 0x3) | 0x8)).toString(16);
  });
}

// Nothing is allowed to hang the billing screen. If the server has not
// answered in a few seconds, we treat it as no signal and move on.
export function withTimeout(promise, ms = 7000) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('offline')), ms)),
  ]);
}

// Was this a no-signal failure, or a real complaint from the server? A real
// complaint must be shown to the shopkeeper; no signal must not be.
export function looksOffline(e) {
  const m = String(e?.message || e || '').toLowerCase();
  return m.includes('offline')
      || m.includes('network')
      || m.includes('fetch')
      || m.includes('timeout')
      || m.includes('failed to connect')
      || m.includes('connection')
      // what Android itself says when the phone has wifi but no way out:
      // NoRouteToHostException, UnknownHostException, ConnectException.
      || m.includes('route to host')
      || m.includes('unreachable')
      || m.includes('unable to resolve host')
      || m.includes('econnrefused')
      || m.includes('econnreset');
}

// NOBODY SHOULD EVER READ A JAVA ERROR.
//
// When the phone cannot get out, Android hands up things like
// "java.net.NoRouteToHostException: Host unreachable". A shopkeeper looking at
// that has no idea his wifi is the problem, and assumes Skwik is broken.
// WHAT A SHOPKEEPER IS TOLD WHEN SOMETHING GOES WRONG.
//
// A message like "new row violates row-level security policy for table
// vouchers" is not English, it is not his fault, and it does not tell him what
// to do next. He is standing at a counter with a customer waiting. Every one
// of those the database can produce is turned into a sentence that says what
// happened and what to do about it; anything we wrote ourselves is already
// plain and goes through untouched.
const PLAIN = [
  [/row[- ]level security|rls|jwt|not authenticated|invalid claim|permission denied/i,
   'Skwik could not save that, because your login was not accepted. '
   + 'Close Skwik completely, open it again, and try once more. '
   + 'Nothing you typed has been lost.'],
  [/duplicate key|already exists|unique constraint/i,
   'That has been saved once already, so Skwik has not saved it twice. '
   + 'Look in the list below — it should be there.'],
  [/violates foreign key|is not present in table/i,
   'Something this was attached to is no longer there — a customer or an item '
   + 'may have been removed on another phone. Pull down to refresh and try again.'],
  [/violates check constraint|not-null constraint|invalid input syntax|out of range|numeric field overflow/i,
   'Something on this does not look right to Skwik. Check the amounts and the '
   + 'quantities — one of them is empty, or far too large — and try again.'],
  [/statement timeout|canceling statement|deadlock/i,
   'The server took too long to answer. Try once more in a moment; nothing you '
   + 'typed has been lost.'],
  [/rate limit|too many requests|429/i,
   'Skwik is being asked for too much at once. Wait a few seconds and try again.'],
];

export function sayPlainly(e) {
  if (looksOffline(e)) {
    return 'Skwik could not reach the internet. Check your wifi or mobile data '
         + 'and try once more. Nothing you typed has been lost.';
  }
  const raw = String(e?.message || e?.error_description || e || '');
  for (const [re, say] of PLAIN) if (re.test(raw)) return say;
  if (!raw.trim()) return 'Something went wrong. Try once more.';

  // WHAT IS LEFT IS EITHER A SENTENCE OR IT IS NOT.
  //
  // Skwik's own rules — the ones the database raises — are written for the
  // shopkeeper and read like it: "Bill number 26-27/41 is already used in your
  // books." Those should reach him word for word. Everything else that got
  // this far is the machinery talking: "Cannot read property 'gstin' of null",
  // "value too long for type character varying(15)", "JSON Parse error:
  // Unexpected character: <". He was being shown those, under a heading that
  // said his work had not been saved, and there is nothing he can do with one.
  //
  // The test is whether it looks like a sentence somebody wrote for a person.
  const machine = /cannot read|undefined|is not a function|typeerror|referenceerror|syntaxerror|\bnull\b|\bNaN\b|json |non-2xx|character varying|\bpg_|postgres|relation |column |constraint|violates|\)\s*$|::|_id\b/i;
  const sentence = /^[A-Z₹0-9].{15,}[.!]$/s;
  if (sentence.test(raw.trim()) && !machine.test(raw)) return raw.trim();

  return 'Skwik hit a problem it did not expect. Nothing you typed has been '
       + 'lost — check under Past bills before writing it again.'
       + (SUPPORT ? `\n\nIf it keeps happening, send a screenshot to ${SUPPORT}.` : '')
       + '\n\n(' + raw.slice(0, 120) + ')';
}

/* ---------------- the copy on the phone ---------------- */

// WHOSE COPY IS THIS?
//
// A handset gets passed round. The owner logs out at eight and the man on
// the counter logs into a different shop at nine; on a phone with no signal
// the app falls back to whatever it copied last, and what it had copied was
// the OTHER shop — its items, its customers, its name on the printed bill.
//
// So every copy is stamped with who it belongs to, and a copy that belongs
// to somebody else is not a copy at all. A stamp that does not match is the
// same as nothing cached: the screen waits the extra second for the server
// rather than showing one shop's book to another.
//
// (`for` is the owner: the login id for the firm, the firm id for its items
// and customers. A blob written by a version before this carries no stamp and
// is ignored once, after which it is written again with one.)
const keep = (key, owner, value) =>
  write(key, { for: String(owner || ''), value });

const kept = async (key, owner, fallback) => {
  const box = await read(key, null);
  if (!box || typeof box !== 'object' || !('for' in box)) return fallback;
  if (box.for !== String(owner || '')) return fallback;
  return box.value === undefined || box.value === null ? fallback : box.value;
};

export const cacheItems   = (orgId, rows) => keep(K.items, orgId, rows || []);
export const cacheParties = (orgId, rows) => keep(K.parties, orgId, rows || []);
export const cacheOrg     = (userId, row) => keep(K.org, userId, row || null);

export const cachedItems   = (orgId)  => kept(K.items, orgId, []);
export const cachedParties = (orgId)  => kept(K.parties, orgId, []);
export const cachedOrg     = (userId) => kept(K.org, userId, null);

// EVERYTHING THIS PHONE IS HOLDING, LET GO OF.
//
// The books can be emptied from inside the app, and the copy on the phone
// knew nothing about it: items and customers that no longer exist went on
// being offered on the billing screen, and the bill counter went on counting
// from where the old books had reached, so the first bill of the new book
// came out numbered 418. Emptying the books empties the phone with them.
export async function forgetLocal() {
  try {
    await AsyncStorage.multiRemove([K.items, K.parties, K.counters, K.queue]);
    return true;
  } catch (e) { return false; }
}

/* ---------------- bill numbers, while offline ---------------- */

// The phone keeps its own copy of the next number. Every time the server
// tells us where it has got to, the copy moves forward to match.
// THE COUNT BELONGS TO A FINANCIAL YEAR, NOT TO THE PHONE.
//
// A shop that restarts its numbering each April was carrying March's count into
// the new year: the server went back to 1 and the phone, which only ever
// moved its number forward, printed 252 on the first offline bill of the new
// year. Numbers 1 to 251 then never existed, and a GST series with a
// two-hundred-number hole in it takes some explaining. Keeping the count
// under the year it belongs to makes the new year start at 1 by itself.
export async function noteServerCounters(org) {
  if (!org) return;
  const c = await read(K.counters, {});
  const fy = fyLabel();
  const mine = c.fy === fy ? c : { fy };
  const next = {
    fy,
    invoice:  Math.max(Number(mine.invoice  || 0), Number(org.next_invoice_no  || 1)),
    estimate: Math.max(Number(mine.estimate || 0), Number(org.next_estimate_no || 1)),
  };
  await write(K.counters, next);
}

// April to March, the way a bill is labelled: 26-27.
const fyLabel = (d = new Date()) => {
  const y = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1;
  return `${String(y).slice(2)}-${String(y + 1).slice(2)}`;
};

// Take the next number and keep it. Used only when the server cannot be
// reached — online, the server hands out the number as it always did.
//
// It has to come out the same SHAPE the server would have produced, year and
// all. A phone that writes a bare "41" while the books are on "26-27/41" has
// started a second series nobody asked for, and the shopkeeper finds out at
// filing time.
export async function takeLocalNumber(org, vtype) {
  const raw = await read(K.counters, {});
  const fy  = fyLabel();
  const c   = raw.fy === fy ? raw : { fy };      // a new year counts from itself
  const key = vtype === 'estimate' ? 'estimate' : 'invoice';
  const n = Math.max(
    Number(c[key] || 0),
    Number((vtype === 'estimate' ? org?.next_estimate_no : org?.next_invoice_no) || 1));
  await write(K.counters, { ...c, fy, [key]: n + 1 });

  let prefix = (vtype === 'estimate' ? org?.estimate_prefix : org?.invoice_prefix) || '';
  if (org?.restart_each_year && org?.year_in_prefix !== false) prefix += `${fyLabel()}/`;
  return `${prefix}${n}`;
}

/* ---------------- the queue ---------------- */

// ONE HAND ON THE QUEUE AT A TIME.
//
// Reading the list, changing it and writing it back is three steps with an
// await in each. Two of them running at once — a bill being saved while the
// outbox is being emptied — and one overwrites the other's work: a bill that
// was printed and handed over never reaches the books, and the waiting count
// shows nothing, so nobody goes looking for it. Every change to the queue
// goes through here, and they take their turn.
let chain = Promise.resolve();
const inTurn = (job) => {
  const run = chain.then(job, job);
  chain = run.then(() => {}, () => {});
  return run;
};

// Which shop a waiting bill belongs to. A phone is handed round — the owner
// logs out, the man at the counter logs into his own shop — and save_voucher
// files a bill against WHOEVER IS SIGNED IN, not against whoever wrote it. A
// bill written offline for one shop and sent from another's login lands in
// the wrong books, with the wrong number, and nobody is told. An entry with
// no shop on it was written before this and can only belong to this one.
const belongsHere = (e, orgId) => !e.org_id || !orgId || e.org_id === orgId;

// Each entry is everything needed to finish the job later, on its own:
//   { id, at, org_id, kind: 'bill', payload, newParty, newItems }
export const queueList  = () => read(K.queue, []);
export const queueCount = async (orgId = null) =>
  (await queueList()).filter((e) => belongsHere(e, orgId)).length;

export const queueAdd = (entry) => inTurn(async () => {
  const q = await queueList();
  q.push({ ...entry, at: new Date().toISOString() });
  return write(K.queue, q);
});

export const queueRemove = (id) => inTurn(async () => {
  const q = await queueList();
  return write(K.queue, q.filter((e) => e.id !== id));
});

export const queueMark = (id, problem) => inTurn(async () => {
  const q = await queueList();
  return write(K.queue, q.map((e) => (e.id === id ? { ...e, problem } : e)));
});

// Drop an entry the shopkeeper has decided to give up on, once he has been
// shown what it was.
export const queueDrop = (id) => queueRemove(id);

/* ---------------- emptying the queue ---------------- */

// Sends everything waiting, oldest first, and stops at the first sign that
// the line is down again. Anything the server actively refuses is kept and
// marked, never silently thrown away.
//
// Returns { sent, failed, stillOffline }.
let flushing = false;

export async function flushQueue(supabase, orgId = null) {
  // Two flushes at once send the same bill twice. The second is harmless —
  // save_voucher knows the bill's own id and refuses to write it again — but
  // there is no reason to make the phone do the work.
  if (flushing) return { sent: 0, failed: 0, stillOffline: false, busy: true };
  flushing = true;
  try {
    return await flushOnce(supabase, orgId);
  } finally { flushing = false; }
}

async function flushOnce(supabase, orgId) {
  const all = await queueList();
  const q = all.filter((e) => belongsHere(e, orgId));
  if (!q.length) return { sent: 0, failed: 0, stillOffline: false };

  let sent = 0, failed = 0;
  const renumbered = [];

  for (const entry of q) {
    try {
      // a customer who was invented while offline has to exist first
      if (entry.newParty) {
        const { error } = await withTimeout(
          supabase.from('parties').upsert(entry.newParty, { onConflict: 'id', ignoreDuplicates: true }));
        if (error && !/duplicate|already exists/i.test(error.message)) throw error;
      }

      // and any item added in the middle of that bill
      for (const it of entry.newItems || []) {
        const { error } = await withTimeout(
          supabase.from('items').upsert(it, { onConflict: 'id', ignoreDuplicates: true }));
        if (error && !/duplicate|already exists/i.test(error.message)) throw error;
      }

      let { data, error } = await withTimeout(
        supabase.rpc('save_voucher', { p: entry.payload }));

      // THE NUMBER ON THE PAPER IS ALREADY TAKEN.
      //
      // He billed with no signal, so the phone printed 26-27/41 from its own
      // count. Signal came back, he billed again, and the server — which never
      // heard about the first one — handed out 26-27/41 as well. When the
      // queue finally goes up, the server refuses the older bill because the
      // number is in use, and it used to sit in the queue for ever, unseen and
      // unsendable, while the goods had already left the shop.
      //
      // A bill in the books under a different number is recoverable. A bill
      // that is not in the books at all is not. So send it again with the
      // number stripped off, let the server give it a fresh one, and tell him
      // the number changed.
      if (error && /already used in your books/i.test(String(error.message || ''))) {
        const second = { ...entry.payload };
        delete second.voucher_no;
        const r2 = await withTimeout(supabase.rpc('save_voucher', { p: second }));
        if (!r2.error) { data = r2.data; error = null; }
      }
      if (error) throw error;

      // The bill may already be in the books: the phone gave up waiting on a
      // slow line after the server had in fact written it. The number the
      // BOOKS hold is the real one, and if it is not the number printed on the
      // paper in the customer's hand, somebody has to be told.
      const given = String(entry.payload?.voucher_no || '');
      const kept  = String(data?.voucher_no || given);
      if (given && kept && given !== kept) {
        renumbered.push({ printed: given, saved: kept, date: entry.payload?.vdate });
      }

      await queueRemove(entry.id);
      sent++;
    } catch (e) {
      if (looksOffline(e)) {
        // The line is down again — but bills that DID go through on this pass
        // may have come back under a different number, and the customer is
        // holding paper with the old one. Dropping that on the floor because
        // the next bill failed is how a renumbered bill is never noticed.
        return { sent, failed, stillOffline: true, renumbered };
      }
      await queueMark(entry.id, String(e.message || e));
      failed++;
    }
  }

  return { sent, failed, stillOffline: false, renumbered };
}
