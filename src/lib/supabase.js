// ---------------------------------------------------------------
//  PUT YOUR TWO SUPABASE KEYS HERE. Nothing else in the app needs editing.
// ---------------------------------------------------------------
export const SUPABASE_URL      = 'https://hdwtilbueohlauezcpih.supabase.co';
export const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imhkd3RpbGJ1ZW9obGF1ZXpjcGloIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk3MTM1OTMsImV4cCI6MjEwNTI4OTU5M30.pPePm_oFgByqFgkdaDOxpLLSJ9uF4C_bgkD4tEI_fic';
// ---------------------------------------------------------------

import 'react-native-url-polyfill/auto';
import { AppState } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient } from '@supabase/supabase-js';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    storage: AsyncStorage,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
  },
});

// A login lasts one hour and then has to be renewed quietly in the background.
// On a phone that renewal only runs while the app is actually open, and it has
// to be started by hand - switched off when the shopkeeper puts the phone down,
// switched back on when they pick it up. Without these six lines the login goes
// stale in the background and the next save is refused by the database with
// "row violates row-level security policy", which looks like a bug in the app
// but is only an expired login.
AppState.addEventListener('change', (state) => {
  if (state === 'active') supabase.auth.startAutoRefresh();
  else supabase.auth.stopAutoRefresh();
});
if (AppState.currentState === 'active') supabase.auth.startAutoRefresh();

// Login is by mobile number. Supabase wants an e-mail, so we make a private
// one from the number. The shopkeeper never sees it and never types it.
export const phoneToEmail = (phone) =>
  `${String(phone).replace(/\D/g, '')}@gstbill.app`;

// EVERY ROW, NOT THE FIRST THOUSAND.
//
// PostgREST answers with at most 1,000 rows unless it is asked to page, and it
// says nothing about the ones it left out. A shop with 1,200 items did not see
// a bug — it simply could not find items 1,001 onward on the billing screen,
// which reads as "I must have forgotten to add it" and is far worse than an
// error. Reports and the backup already paged; the counter screens did not.
//
// Pass a function that BUILDS the query fresh each time, because a PostgREST
// builder cannot be re-used once it has been sent:
//
//   const items = await allRows(() => supabase.from('items').select('*').order('name'));
//
// Always order by something unique as the last key — id will do. Two rows that
// sort the same have no order of their own, and a page boundary falling
// between them drops one and repeats another.
const PAGE = 1000;

// AND NOT ONE PAGE AT A TIME, WAITING FOR EACH -- BUT NOR FOUR WHEN ONE WILL DO.
//
// This asked for a thousand rows, waited for the answer, then asked for the
// next thousand. On a stock screen that is three questions one after another
// before anything appears, and on a mobile pack a question and its answer is
// most of a second -- which is the "stock takes a few seconds to load" he
// reported. So pages began going out four at a time.
//
// Four at a time, though, was four ALWAYS. The handful is built and sent
// before a single answer is looked at, so a list of 874 items -- one page,
// which is nearly every list on nearly every screen -- asked four questions
// and threw three answers away. On a phone that is three round trips of pure
// waiting per screen, and against the folded stock list each of those three
// made the database group every movement in the book all over again for
// nothing.
//
// So the handful starts at one and only grows once there is proof there is
// more to come: one, then the other three, then four at a time. Counted over
// every size a list can be, this never asks more questions than four-always
// did and never fewer than it must:
//
//      rows       needed   four-always   now
//         874          1             4     1
//       1,000          2             4     4
//       3,000          4             4     4
//      50,000         51            52    52
//
// Nothing else changes: the same rows come back in the same order, because
// each page still asks for its own range.
const AT_ONCE = 4;

export async function allRows(build, { pageSize = PAGE, cap = 100000 } = {}) {
  const out = [];
  let from = 0;
  // ONE FIRST. Only a page that came back FULL is proof there is more.
  let hand = 1;
  while (from < cap) {
    const asks = [];
    for (let k = 0; k < hand && from + k * pageSize < cap; k++) {
      const a = from + k * pageSize;
      asks.push(build().range(a, a + pageSize - 1));
    }
    const answers = await Promise.all(asks);
    let short = false;
    for (const { data, error } of answers) {
      if (error) throw error;
      const got = data || [];
      out.push(...got);
      // A PAGE THAT CAME BACK SHORT IS THE LAST PAGE. The ones asked for after
      // it in the same handful are empty, which is harmless -- but nothing
      // beyond this handful is worth asking for.
      if (got.length < pageSize) { short = true; break; }
    }
    if (short) return out;
    from += hand * pageSize;
    hand = hand === 1 ? AT_ONCE - 1 : AT_ONCE;
  }

  // AND IF IT RAN OUT OF ROOM, IT SAYS SO.
  //
  // This used to stop at the cap and hand back what it had, silently. A shop
  // with more rows than the cap would then have got a GST return, a stock
  // figure or a backup built on part of its book, with nothing anywhere
  // saying so -- and a wrong figure that looks right is the worst thing this
  // app can produce. Better a plain refusal he can bring to me.
  throw new Error(
    `This is more than ${cap.toLocaleString('en-IN')} rows, which is more than `
    + 'a screen can hold at once. Ask for one financial year at a time, or tell '
    + 'me and I will make this one page through.');
}
