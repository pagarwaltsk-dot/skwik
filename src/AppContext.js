import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { supabase } from './lib/supabase';

const Ctx = createContext(null);
export const useApp = () => useContext(Ctx);

export function AppProvider({ children }) {
  const [session, setSession] = useState(null);
  const [org, setOrg]         = useState(null);
  const [loading, setLoading] = useState(true);

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

  return (
    <Ctx.Provider value={{ session, org, loading, reloadOrg: loadOrg,
                           signOut: () => supabase.auth.signOut() }}>
      {children}
    </Ctx.Provider>
  );
}
