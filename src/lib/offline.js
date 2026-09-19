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

// Take the next number and keep it. Used only when the server cannot be
// reached — online, the server hands out the number as it always did.
export async function takeLocalNumber(org, vtype) {
  const c = await read(K.counters, {});
  const key = vtype === 'estimate' ? 'estimate' : 'invoice';
  const n = Math.max(
    Number(c[key] || 0),
    Number((vtype === 'estimate' ? org?.next_estimate_no : org?.next_invoice_no) || 1));
  await write(K.counters, { ...c, [key]: n + 1 });
  const prefix = (vtype === 'estimate' ? org?.estimate_prefix : org?.invoice_prefix) || '';
  return `${prefix}${n}`;
}

/* ---------------- the queue ---------------- */

// Each entry is everything needed to finish the job later, on its own:
//   { id, at, kind: 'bill', payload, newParty, newItems }
export const queueList  = () => read(K.queue, []);
export const queueCount = async () => (await queueList()).length;

export async function queueAdd(entry) {
  const q = await queueList();
  q.push({ ...entry, at: new Date().toISOString() });
  return write(K.queue, q);
}

export async function queueRemove(id) {
  const q = await queueList();
  return write(K.queue, q.filter((e) => e.id !== id));
}

export async function queueMark(id, problem) {
  const q = await queueList();
  return write(K.queue, q.map((e) => (e.id === id ? { ...e, problem } : e)));
}

/* ---------------- emptying the queue ---------------- */

// Sends everything waiting, oldest first, and stops at the first sign that
// the line is down again. Anything the server actively refuses is kept and
// marked, never silently thrown away.
//
// Returns { sent, failed, stillOffline }.
export async function flushQueue(supabase) {
  const q = await queueList();
  if (!q.length) return { sent: 0, failed: 0, stillOffline: false };

  let sent = 0, failed = 0;

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

      const { error } = await withTimeout(
        supabase.rpc('save_voucher', { p: entry.payload }));
      if (error) throw error;

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

  return { sent, failed, stillOffline: false };
}
