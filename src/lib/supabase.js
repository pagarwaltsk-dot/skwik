// ---------------------------------------------------------------
//  PUT YOUR TWO SUPABASE KEYS HERE. Nothing else in the app needs editing.
// ---------------------------------------------------------------
export const SUPABASE_URL      = 'https://PASTE-YOUR-PROJECT-REF.supabase.co';
export const SUPABASE_ANON_KEY = 'PASTE-YOUR-ANON-PUBLIC-KEY';
// ---------------------------------------------------------------

import 'react-native-url-polyfill/auto';
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

// Login is by mobile number. Supabase wants an e-mail, so we make a private
// one from the number. The shopkeeper never sees it and never types it.
export const phoneToEmail = (phone) =>
  `${String(phone).replace(/\D/g, '')}@gstbill.app`;
