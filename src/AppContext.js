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
  const [role, setRole] = useState('owner');        // owner | staff
  // True while we are fetching the firm after a login. Without it there is a
  // moment where there is a session but no firm yet, and the app takes that to
  // mean "this login has no shop" and flashes the set-up screen.
  const [checking, setChecking] = useState(false);

  // WHO THIS PHONE BELONGS TO.
  //
  // This has to be right even with no signal, because getting it wrong is the
  // worst thing the app can do: the shopkeeper is shown the "set up your shop"
  // screen, does as he is told, and a second empty firm is created with every
  // bill, customer and balance he has stranded behind it, unreachable.
  //
  // So a firm once seen is remembered on the phone, and a failure to reach the
  // server falls back to it. Only a clear answer FROM the server — a login
  // that genuinely has no firm — is allowed to send anyone to the set-up
  // screen. Note that supabase resolves with an error rather than throwing, so
  // every step is checked, not wrapped in a try and hoped for.
  const loadOrg = useCallback(async () => {
    const fallback = async (why) => {
      const o = await cachedOrg();
      if (o) { setOrg(o); return o; }
      if (why === 'no-user') { setOrg(null); return null; }
      setOrg(null);
      return null;
    };

    let user = null;
    try {
      const r = await supabase.auth.getUser();
      user = r?.data?.user || null;
      if (r?.error && !user) return fallback('unreachable');     // no signal
    } catch (e) { return fallback('unreachable'); }
    if (!user) return fallback('no-user');

    let prof, profErr;
    try {
      const r = await supabase.from('profiles').select('org_id, role').eq('id', user.id).maybeSingle();
      prof = r?.data; profErr = r?.error;
    } catch (e) { profErr = e; }
    if (prof?.role) setRole(prof.role);
    if (profErr) return fallback('unreachable');
    if (!prof?.org_id) {
      // the server answered, and this login really has no firm behind it
      const cached = await cachedOrg();
      if (cached) { setOrg(cached); return cached; }
      setOrg(null);
      return null;
    }

    let o, orgErr;
    try {
      const r = await supabase.from('orgs').select('*').eq('id', prof.org_id).maybeSingle();
      o = r?.data; orgErr = r?.error;
    } catch (e) { orgErr = e; }
    if (orgErr || !o) return fallback('unreachable');

    cacheOrg(o); noteServerCounters(o);
    setOrg(o);
    return o;
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
      if (data.session) await loadOrg();
      setLoading(false);
      // bills waiting on this phone go out in the background — nobody should
      // look at a blank screen while a dead connection times out
      if (data.session) sendPending();
    });

    const { data: sub } = supabase.auth.onAuthStateChange(async (_e, s) => {
      setSession(s);
      if (s) {
        setChecking(true);
        try { await loadOrg(); } finally { setChecking(false); }
      } else {
        setOrg(null);
        setRole('owner');
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

      const { error: pe1 } = await supabase.from('profiles')
        .upsert({ id: user.id, phone });
      if (pe1) throw pe1;

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

      // THE LINE THAT TIES THE LOGIN TO THE SHOP.
      //
      // This was written and never checked. If it failed — a dropped signal,
      // a policy refusal — the firm row existed and nothing pointed at it, so
      // my_org_id() came back empty and every screen in the app said "This
      // login is not linked to a firm yet", for ever, with no way out from
      // inside Skwik. If it fails now, the firm is taken back out again and
      // he is told to try once more, which he can.
      const { error: pe2 } = await supabase.from('profiles')
        .upsert({ id: user.id, org_id: newOrg.id, phone });
      if (pe2) {
        try { await supabase.from('orgs').delete().eq('id', newOrg.id); } catch (_) {}
        throw new Error(
          'The shop was made but could not be linked to your login, so it has '
          + 'been removed again rather than left half-finished. Check your '
          + 'signal and register once more — nothing has been kept.'
        );
      }
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

  // A second person in the same shop. He makes his own login in the ordinary
  // way and types the code the owner reads out to him; from then on the shop
  // is his to bill in, and nothing else.
  const joinShop = async (code) => {
    const { data, error } = await supabase.rpc('join_org', { p_code: String(code || '').trim() });
    if (error) throw error;
    setRole('staff');
    await loadOrg();
    return data;
  };

  return (
    <Ctx.Provider value={{ session, org, loading, registering, checking, register, role,
                           // WHO THE OWNER IS, DECIDED THE SAME WAY THE DATABASE
                           // DECIDES IT.
                           //
                           // The database no longer takes anybody's word for a
                           // role: the owner is whoever the shop row says owns
                           // it. The screens must agree, or a man would be
                           // shown buttons that are refused when he taps them.
                           isOwner: (org?.owner_id && session?.user?.id
                                     && org.owner_id === session.user.id)
                                    || (role !== 'staff' && !org?.owner_id),
                           joinShop,
                           reloadOrg: loadOrg, pending, countPending, sendPending,
                           signOut: () => supabase.auth.signOut() }}>
      {children}
    </Ctx.Provider>
  );
}
