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
export function sayPlainly(e) {
  if (looksOffline(e)) {
    return 'Skwik could not reach the internet. Check your wifi or mobile data '
         + 'and try once more. Nothing you typed has been lost.';
  }
  return String(e?.message || e || 'Something went wrong. Try once more.');
}

/* ---------------- the copy on the phone ---------------- */

export const cacheItems   = (rows) => write(K.items, rows || []);
export const cacheParties = (rows) => write(K.parties, rows || []);
export const cacheOrg     = (row)  => write(K.org, row || null);

export const cachedItems   = () => read(K.items, []);
export const cachedParties = () => read(K.parties, []);
export const cachedOrg     = () => read(K.org, null);

/* ---------------- bill numbers, while offline ---------------- */

// The phone keeps its own copy of the next number. Every time the server
// tells us where it has got to, the copy moves forward to match.
export async function noteServerCounters(org) {
  if (!org) return;
  const c = await read(K.counters, {});
  const next = {
    invoice:  Math.max(Number(c.invoice  || 0), Number(org.next_invoice_no  || 1)),
    estimate: Math.max(Number(c.estimate || 0), Number(org.next_estimate_no || 1)),
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
  const c = await read(K.counters, {});
  const key = vtype === 'estimate' ? 'estimate' : 'invoice';
  const n = Math.max(
    Number(c[key] || 0),
    Number((vtype === 'estimate' ? org?.next_estimate_no : org?.next_invoice_no) || 1));
  await write(K.counters, { ...c, [key]: n + 1 });

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

// Each entry is everything needed to finish the job later, on its own:
//   { id, at, kind: 'bill', payload, newParty, newItems }
export const queueList  = () => read(K.queue, []);
export const queueCount = async () => (await queueList()).length;

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

export async function flushQueue(supabase) {
  // Two flushes at once send the same bill twice. The second is harmless —
  // save_voucher knows the bill's own id and refuses to write it again — but
  // there is no reason to make the phone do the work.
  if (flushing) return { sent: 0, failed: 0, stillOffline: false, busy: true };
  flushing = true;
  try {
    return await flushOnce(supabase);
  } finally { flushing = false; }
}

async function flushOnce(supabase) {
  const q = await queueList();
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

      const { data, error } = await withTimeout(
        supabase.rpc('save_voucher', { p: entry.payload }));
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
        return { sent, failed, stillOffline: true };   // line is down again; try later
      }
      await queueMark(entry.id, String(e.message || e));
      failed++;
    }
  }

  return { sent, failed, stillOffline: false, renumbered };
}
