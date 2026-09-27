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

// AND NOT ONE PAGE AT A TIME, WAITING FOR EACH.
//
// This asked for a thousand rows, waited for the answer, then asked for the
// next thousand. On a stock screen that is three questions one after another
// before anything appears, and on a mobile pack a question and its answer is
// most of a second -- which is the "stock takes a few seconds to load" he
// reported. The database was never the problem: the view itself answers in
// twenty milliseconds and folding the rows on the phone takes two.
//
// So pages are asked for in a handful at a time. The first handful usually
// covers the whole list, and where it does not the next handful goes out
// together as well. Nothing else changes: the same rows come back in the same
// order, because each page still asks for its own range.
const AT_ONCE = 4;

export async function allRows(build, { pageSize = PAGE, cap = 100000 } = {}) {
  const out = [];
  let from = 0;
  while (from < cap) {
    const asks = [];
    for (let k = 0; k < AT_ONCE && from + k * pageSize < cap; k++) {
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
    if (short) break;
    from += AT_ONCE * pageSize;
  }
  return out;
}
