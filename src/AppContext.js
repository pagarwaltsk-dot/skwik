import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { supabase, phoneToEmail } from './lib/supabase';
import { STATES } from './lib/states';

const Ctx = createContext(null);
export const useApp = () => useContext(Ctx);

export function AppProvider({ children }) {
  const [session, setSession] = useState(null);
  const [org, setOrg]         = useState(null);
  const [loading, setLoading] = useState(true);
  const [registering, setRegistering] = useState(false);

  const loadOrg = useCallback(async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { setOrg(null); return null; }

    const { data: prof } = await supabase
      .from('profiles').select('org_id').eq('id', user.id).maybeSingle();

    if (!prof?.org_id) { setOrg(null); return null; }

    const { data: o } = await supabase
      .from('orgs').select('*').eq('id', prof.org_id).maybeSingle();

    setOrg(o || null);
    return o || null;
  }, []);

  useEffect(() => {
    let alive = true;
    supabase.auth.getSession().then(async ({ data }) => {
      if (!alive) return;
      setSession(data.session);
      if (data.session) await loadOrg();
      setLoading(false);
    });

    const { data: sub } = supabase.auth.onAuthStateChange(async (_e, s) => {
      setSession(s);
      if (s) await loadOrg(); else setOrg(null);
    });
    return () => { alive = false; sub.subscription.unsubscribe(); };
  }, [loadOrg]);

  // Everything the register screens collected, turned into a login and a firm.
  const register = async (d) => {
    setRegistering(true);
    try {
      const phone = String(d.phone || '').replace(/\D/g, '');
      const { error } = await supabase.auth.signUp({
        email: phoneToEmail(phone), password: d.password,
      });
      if (error) throw error;

      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Account made, but could not log in. Try logging in.');

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
      if (e2) throw e2;

      await supabase.from('profiles').upsert({ id: user.id, org_id: newOrg.id, phone });
      await loadOrg();
    } finally {
      setRegistering(false);
    }
  };

  return (
    <Ctx.Provider value={{ session, org, loading, registering, register, reloadOrg: loadOrg,
                           signOut: () => supabase.auth.signOut() }}>
      {children}
    </Ctx.Provider>
  );
}
