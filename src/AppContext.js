import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { supabase, phoneToEmail } from './lib/supabase';
import { STATES } from './lib/states';
import { cacheOrg, cachedOrg, noteServerCounters, queueCount, flushQueue } from './lib/offline';

const Ctx = createContext(null);
export const useApp = () => useContext(Ctx);

export function AppProvider({ children }) {
  const [session, setSession] = useState(null);
  const [org, setOrg]         = useState(null);
  const [loading, setLoading] = useState(true);
  const [registering, setRegistering] = useState(false);
  const [pending, setPending] = useState(0);        // bills waiting on this phone
  // True while we are fetching the firm after a login. Without it there is a
  // moment where there is a session but no firm yet, and the app takes that to
  // mean "this login has no shop" and flashes the set-up screen.
  const [checking, setChecking] = useState(false);

  const loadOrg = useCallback(async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { setOrg(null); return null; }

    try {
      const { data: prof } = await supabase
        .from('profiles').select('org_id').eq('id', user.id).maybeSingle();

      if (!prof?.org_id) { setOrg(null); return null; }

      const { data: o } = await supabase
        .from('orgs').select('*').eq('id', prof.org_id).maybeSingle();

      if (o) { cacheOrg(o); noteServerCounters(o); }
      setOrg(o || null);
      return o || null;
    } catch (e) {
      // no signal: the firm as it was last seen is enough to keep billing
      const o = await cachedOrg();
      setOrg(o);
      return o;
    }
  }, []);

  // How many bills are sitting on this phone, and a way to push them.
  const countPending = useCallback(async () => {
    const n = await queueCount();
    setPending(n);
    return n;
  }, []);

  const sendPending = useCallback(async () => {
    const r = await flushQueue(supabase);
    await countPending();
    return r;
  }, [countPending]);

  useEffect(() => {
    let alive = true;
    supabase.auth.getSession().then(async ({ data }) => {
      if (!alive) return;
      setSession(data.session);
      if (data.session) { await loadOrg(); await sendPending(); }
      setLoading(false);
    });

    const { data: sub } = supabase.auth.onAuthStateChange(async (_e, s) => {
      setSession(s);
      if (s) {
        setChecking(true);
        try { await loadOrg(); } finally { setChecking(false); }
      } else {
        setOrg(null);
      }
    });
    return () => { alive = false; sub.subscription.unsubscribe(); };
  }, [loadOrg]);

  // Everything the register screens collected, turned into a login and a firm.
  //
  // The order matters. Making the account is not the same as being logged in,
  // and until we are logged in the database refuses to let us create the firm.
  // So: make the account, log in properly, check we really have a login, and
  // only then write the firm. If anything goes wrong after the account is made
  // we log back out, so nobody is left holding a login with no shop behind it.
  const register = async (d) => {
    setRegistering(true);
    let accountMade = false;
    try {
      const phone    = String(d.phone || '').replace(/\D/g, '');
      const email    = phoneToEmail(phone);
      const password = d.password;

      // 1. Make the account. If the number is already taken Supabase does not
      //    always say so, so we find out at the login step instead.
      const { error: upErr } = await supabase.auth.signUp({ email, password });
      if (upErr && !/already registered|already exists/i.test(upErr.message)) throw upErr;

      // 2. Log in for real. Signing up does not always leave a login behind,
      //    and without one every write below is refused.
      const { data: signIn, error: inErr } =
        await supabase.auth.signInWithPassword({ email, password });

      if (inErr || !signIn?.session) {
        if (inErr && /confirm/i.test(inErr.message)) {
          throw new Error(
            'Your account was made but cannot be used yet, because e-mail ' +
            'confirmation is switched on in Supabase. Turn it off under ' +
            'Authentication, Providers, Email - then register again.'
          );
        }
        if (inErr && /invalid/i.test(inErr.message)) {
          throw new Error(
            'This mobile number is already registered with a different ' +
            'password. Go back and log in with it instead.'
          );
        }
        throw inErr || new Error('Could not log in after making the account.');
      }
      accountMade = true;

      const user = signIn.user;
      if (!user) throw new Error('Logged in, but no user came back. Try again.');

      await supabase.from('profiles').upsert({ id: user.id, phone });

      const hasGst = !!d.gstin;
      const code   = hasGst ? String(d.gstin).slice(0, 2) : '18';
      const trial  = new Date();
      trial.setDate(trial.getDate() + 7);

      const { data: newOrg, error: e2 } = await supabase.from('orgs').insert({
        name: String(d.shopName || '').trim(),
        phone,
        address: String(d.address || '').trim(),
        gstin: hasGst ? String(d.gstin).trim().toUpperCase() : null,
        is_gst_registered: hasGst,
        is_composition: d.scheme === 'composition',
        turnover_above_5cr: d.scheme === 'regular' ? !!d.aboveFiveCr : false,
        mode: hasGst ? 'gst' : 'estimate',
        state_code: code,
        state_name: STATES[code] || '',
        plan: 'trial',
        trial_ends_at: trial.toISOString(),
      }).select().single();

      if (e2) {
        if (/row-level security/i.test(e2.message)) {
          throw new Error(
            'The shop could not be saved because the login was not accepted ' +
            'by the database. Close Skwik, open it again, and register once more.'
          );
        }
        throw e2;
      }

      await supabase.from('profiles').upsert({ id: user.id, org_id: newOrg.id, phone });
      await loadOrg();
    } catch (err) {
      // Half a registration is worse than none: it drops the shopkeeper on the
      // bare "Your shop" screen with everything they typed thrown away. Undo it.
      if (accountMade) {
        try { await supabase.auth.signOut(); } catch (_) {}
      }
      throw err;
    } finally {
      setRegistering(false);
    }
  };

  return (
    <Ctx.Provider value={{ session, org, loading, registering, checking, register,
                           reloadOrg: loadOrg, pending, countPending, sendPending,
                           signOut: () => supabase.auth.signOut() }}>
      {children}
    </Ctx.Provider>
  );
}
