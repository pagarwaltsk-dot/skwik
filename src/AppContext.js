import React, { createContext, useContext, useEffect, useRef, useState, useCallback } from 'react';
import { Alert, Linking } from 'react-native';
import { supabase, phoneToEmail } from './lib/supabase';
import { STATES } from './lib/states';
import { cacheOrg, cachedOrg, noteServerCounters, queueCount, flushQueue,
         withTimeout } from './lib/offline';

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
  // True while the login on this phone came in through a "forgotten password"
  // link and is good for one thing only: setting a new password.
  const [recovering, setRecovering] = useState(false);

  // WHICH FIRM THE PHONE IS WORKING FOR, readable from inside a callback
  // that was made before the firm was known. Used by the outbox: a bill
  // written offline for one shop must never be sent under another login.
  const orgIdRef = useRef(null);
  orgIdRef.current = org?.id || null;

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
  //
  // `known` is the session the caller already has in its hand. The copy of
  // the firm kept on this handset is stamped with the login it belongs to, so
  // that one shop's book can never be handed to another login — and reading
  // that stamp needs the login id even when the server cannot be reached.
  // Both callers have it, so it is passed in rather than asked for again:
  // asking Supabase would be a round trip on a dead line, and a dead line is
  // exactly the moment this has to work.
  const loadOrg = useCallback(async (known) => {
    let localId = known?.user?.id || null;
    if (!localId) {
      // Called from a screen rather than from the auth listener — reloadOrg,
      // after joining a shop or saving Settings. There is signal in that case
      // by definition, so asking is safe.
      try {
        const r = await withTimeout(supabase.auth.getSession());
        localId = r?.data?.session?.user?.id || null;
      } catch (e) { /* the stamped copy simply will not be used */ }
    }

    const fallback = async (why) => {
      const o = await cachedOrg(localId);
      if (o) { setOrg(o); return o; }
      if (why === 'no-user') { setOrg(null); return null; }
      setOrg(null);
      return null;
    };

    let user = null;
    try {
      // A CLOCK ON THE FRONT DOOR.
      //
      // These three calls decide whether the app opens at all, and none of
      // them had a time limit. On a line that accepts the connection and then
      // says nothing — a crowded tower, a captive wifi — the spinner turned
      // for as long as he was willing to watch it, with a perfectly good copy
      // of his shop sitting on the phone the whole time. Seven seconds, then
      // it falls back to that copy.
      const r = await withTimeout(supabase.auth.getUser());
      user = r?.data?.user || null;
      if (r?.error && !user) return fallback('unreachable');     // no signal
    } catch (e) { return fallback('unreachable'); }
    if (!user) return fallback('no-user');

    let prof, profErr;
    try {
      const r = await withTimeout(
        supabase.from('profiles').select('org_id, role').eq('id', user.id).maybeSingle());
      prof = r?.data; profErr = r?.error;
    } catch (e) { profErr = e; }
    if (prof?.role) setRole(prof.role);
    if (profErr) return fallback('unreachable');
    if (!prof?.org_id) {
      // the server answered, and this login really has no firm behind it
      const cached = await cachedOrg(user.id);
      if (cached) { setOrg(cached); return cached; }
      setOrg(null);
      return null;
    }

    let o, orgErr;
    try {
      const r = await withTimeout(
        supabase.from('orgs').select('*').eq('id', prof.org_id).maybeSingle());
      o = r?.data; orgErr = r?.error;
    } catch (e) { orgErr = e; }
    if (orgErr || !o) return fallback('unreachable');

    cacheOrg(user.id, o); noteServerCounters(o);
    // Written here as well as on every render: the outbox is emptied the
    // moment the firm is known, which is before React has drawn a frame
    // carrying it, and a flush that does not know the firm would send one
    // shop's waiting bills under whatever login happens to be open.
    orgIdRef.current = o.id;
    setOrg(o);
    return o;
  }, []);

  // How many bills are sitting on this phone, and a way to push them.
  //
  // Both are asked about THIS shop. A bill written offline carries the shop
  // it was written for, and one written for another login must not be sent
  // under this one: the database files a bill against whoever is signed in,
  // so it would land in the wrong books under the wrong number.
  const countPending = useCallback(async () => {
    const n = await queueCount(orgIdRef.current);
    setPending(n);
    return n;
  }, []);

  const sendPending = useCallback(async () => {
    const r = await flushQueue(supabase, orgIdRef.current);
    await countPending();
    return r;
  }, [countPending]);

  useEffect(() => {
    let alive = true;
    supabase.auth.getSession().then(async ({ data }) => {
      if (!alive) return;
      setSession(data.session);
      if (data.session) await loadOrg(data.session);
      setLoading(false);
      // bills waiting on this phone go out in the background — nobody should
      // look at a blank screen while a dead connection times out
      if (data.session) sendPending();
    });

    const { data: sub } = supabase.auth.onAuthStateChange(async (event, s) => {
      setSession(s);
      if (s) {
        setChecking(true);
        try { await loadOrg(s); } finally { setChecking(false); }
      } else {
        setOrg(null);
        setRole('owner');
        // Only a real sign-out, not the empty INITIAL_SESSION the client
        // announces at start-up — that one can arrive after a reset link has
        // already been taken, and would drop him back at the login screen
        // holding a link he has now used.
        if (event === 'SIGNED_OUT') setRecovering(false);
      }
    });
    return () => { alive = false; sub.subscription.unsubscribe(); };
  }, [loadOrg]);

  // THE LINK IN THE "FORGOTTEN PASSWORD" E-MAIL.
  //
  // Supabase sends him back to skwik://reset-password with the login on the
  // end of it. Nothing in the app was listening, so the link did nothing and
  // a shopkeeper who had forgotten his password stayed out of his own books
  // for good. This takes the login off the address, signs him in with it, and
  // marks the session as a recovery — the app then shows him one screen and
  // one screen only until the password is actually changed.
  //
  // `detectSessionInUrl` is off (this is a phone, not a browser), so the
  // address is read here. Both shapes Supabase can send are handled: the
  // tokens on the fragment, and the newer single code.
  const takeRecoveryLink = useCallback(async (url) => {
    if (!url || !/reset-password|type=recovery/.test(String(url))) return false;
    try {
      const raw = String(url);
      const after = raw.includes('#') ? raw.slice(raw.indexOf('#') + 1) : '';
      const query = raw.includes('?')
        ? raw.slice(raw.indexOf('?') + 1).split('#')[0] : '';
      const bag = new URLSearchParams(`${query}${query && after ? '&' : ''}${after}`);

      const access = bag.get('access_token');
      const refresh = bag.get('refresh_token');
      const code = bag.get('code');

      if (!access && !refresh && !code) {
        // A link that arrived with nothing on it — usually one already used.
        return false;
      }

      // Marked BEFORE the login is taken, not after: signing in fires the
      // auth listener, and for the moment between the two the app would
      // otherwise show him his books — which is the one thing a recovery
      // login must not do.
      setRecovering(true);
      try {
        if (access && refresh) {
          const { error } = await supabase.auth.setSession({
            access_token: access, refresh_token: refresh });
          if (error) throw error;
        } else {
          const { error } = await supabase.auth.exchangeCodeForSession(code);
          if (error) throw error;
        }
      } catch (e) {
        setRecovering(false);
        Alert.alert('That link did not work',
          'It may have been used already, or it may have run out. Ask for a '
          + 'new one from "Forgotten your password?" on the login screen.');
        return false;
      }
      return true;
    } catch (e) {
      return false;
    }
  }, []);

  useEffect(() => {
    let alive = true;
    // the app was already open when he tapped the link
    const sub = Linking.addEventListener('url', ({ url }) => {
      if (alive) takeRecoveryLink(url);
    });
    // the app was closed, and the link is what opened it
    Linking.getInitialURL().then((url) => { if (alive && url) takeRecoveryLink(url); })
      .catch(() => {});
    return () => { alive = false; sub.remove(); };
  }, [takeRecoveryLink]);

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
          // The shopkeeper cannot act on any of this — it is a setting in an
          // account he has never seen. He is told what he CAN do, and the
          // administrator's instruction is left in the code where it belongs.
          //
          // (For whoever runs the Skwik project: turn e-mail confirmation off
          // under Authentication -> Providers -> Email.)
          throw new Error(
            'Your shop was made, but it cannot be opened yet. This is '
            + 'something at our end, not yours. Please send us a message and '
            + 'we will switch it on for you — nothing you typed has been lost.'
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
      // Assam is the default for a shop that gives no GST number, because
      // that is where most of these shops are — the same answer OnboardScreen
      // gives, so the two ways into Skwik agree. It is still a default rather
      // than a decision: this screen does not yet OFFER the State the way the
      // set-up screen now does, so a shop elsewhere has to correct it under
      // Settings, where the picker asks for it by name.
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
                           recovering, finishRecovery: () => setRecovering(false),
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
                           reloadOrg: () => loadOrg(), pending, countPending, sendPending,
                           signOut: () => supabase.auth.signOut() }}>
      {children}
    </Ctx.Provider>
  );
}
