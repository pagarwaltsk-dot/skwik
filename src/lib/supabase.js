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
