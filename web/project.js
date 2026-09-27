// ===========================================================================
//  WHICH PROJECT THIS PAGE TALKS TO.
//
//  Every shop that uses Skwik shares one Supabase project. Their books are
//  kept apart inside it by row security -- a shop can only read the rows that
//  belong to its own firm -- not by giving each shop a project of its own.
//
//  So these two values are the same for every customer, and they are already
//  inside the APK that every customer installs. They are not a password. The
//  anon key only says WHICH project you are talking to; the login and the row
//  rules are what keep one shop out of another shop's books.
//
//  That is why this page no longer asks for them. A shopkeeper opens the link
//  and types the mobile number and password they already use on the phone.
//
//  KEEP THESE TWO LINES THE SAME AS src/lib/supabase.js. If the project ever
//  moves, both files change together -- tools/check.mjs refuses to pass if
//  they drift apart, so you cannot forget one of them.
// ===========================================================================
export const SUPABASE_URL      = 'https://hdwtilbueohlauezcpih.supabase.co';
export const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imhkd3RpbGJ1ZW9obGF1ZXpjcGloIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk3MTM1OTMsImV4cCI6MjEwNTI4OTU5M30.pPePm_oFgByqFgkdaDOxpLLSJ9uF4C_bgkD4tEI_fic';

// ---------------------------------------------------------------------------
//  A DOOR FOR TESTING, AND ONLY FOR TESTING.
//
//  The test harness has to point this page at a pretend server running on the
//  same machine. It does that with ?project=...&key=... on the address.
//
//  That door is open ONLY for an address on this machine. If it were open to
//  any address, somebody could send a shopkeeper a link that looked like this
//  page but sent their password to a server of their own choosing. A link like
//  that is refused here.
// ---------------------------------------------------------------------------
const onThisMachine = (u) => {
  try {
    const h = new URL(u).hostname;
    return h === '127.0.0.1' || h === 'localhost' || h === '[::1]';
  } catch (e) { return false; }
};

export const project = () => {
  const q = new URLSearchParams(location.search);
  const u = (q.get('project') || '').trim().replace(/\/+$/, '');
  const k = (q.get('key') || '').trim();
  if (u && k && onThisMachine(u)) return { url: u, key: k, pretend: true };
  return { url: SUPABASE_URL, key: SUPABASE_ANON_KEY, pretend: false };
};
