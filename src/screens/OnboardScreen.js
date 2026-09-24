import React, { useRef, useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, ScrollView, Alert } from 'react-native';
import { supabase } from '../lib/supabase';
import { useApp } from '../AppContext';
import { Box, KeyForm } from '../components/Chrome';
import { StateField } from '../components/Pickers';
import { STATES } from '../lib/states';
import { C, S } from '../theme';
import { sayPlainly } from '../lib/offline';


// A SAFETY NET, not the usual way in. Registering happens on RegisterScreen.
// This shows only if someone has a login but no shop against it - an account
// made before this version, or a sign-up that stopped half way.
export default function OnboardScreen() {
  const { reloadOrg, signOut, joinShop } = useApp();
  const [name, setName] = useState('');
  // THE STATE DECIDES THE TAX, AND IT WAS TYPED IN FOR HIM.
  //
  // This screen put state_code '18' — Assam — on every shop it made, with no
  // field to say otherwise. For a shop anywhere else, every out-of-state bill
  // afterwards would be charged CGST and SGST instead of IGST and go into the
  // wrong table of GSTR-1. Assam stays the default, because that is where most
  // of these shops are; it is now a default and not a decision.
  const [stateCode, setStateCode] = useState('18');

  // WHICH OF THE TWO PEOPLE ARE YOU?
  //
  // This screen asked one of them and buried the other. It opened headed
  // "Your shop" with a Start billing button, and the box for the shop code —
  // the only thing the man who is going to stand at the counter came here
  // for — was the last card on a page he had to scroll to find. So of course
  // he tapped Start billing. And that was that: his login then owned an empty
  // shop of its own, the code was refused from then on, and there was no
  // screen left anywhere in Skwik that would take it.
  //
  // Now the question is asked first, in two words, before anything can be
  // tapped by mistake.
  const [who, setWho] = useState('');
  const fName = useRef(null), fPhone = useRef(null), fCode = useRef(null);
  const [code, setCode] = useState('');

  const join = async () => {
    if (code.trim().length < 4) {
      return Alert.alert('The code', 'Ask the owner for the six-character shop code.');
    }
    setBusy(true);
    try {
      const r = await joinShop(code);
      Alert.alert('You are in', `You can now write bills for ${r?.name || 'the shop'}.`);
    } catch (e) {
      Alert.alert('Could not join', sayPlainly(e));
    } finally { setBusy(false); }
  };
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);

  const start = async () => {
    if (!name.trim()) return Alert.alert('Shop name', 'Type the name that should print on your bills.');
    setBusy(true);
    // THE BUTTON MUST ALWAYS COME BACK.
    //
    // This read `user.id` straight off getUser(). With no signal, or a login
    // that had gone stale, there is no user — so the line threw, the throw
    // went nowhere, setBusy(false) was never reached, and the button sat on
    // "One moment…" for as long as he was willing to look at it, with no
    // message and no way forward. Every road out of here now ends in finally.
    try {
      const { data: who, error: whoErr } = await supabase.auth.getUser();
      const user = who?.user;
      if (whoErr || !user) {
        return Alert.alert('Could not check your login',
          'Skwik could not confirm who is signed in. Check your internet and '
          + 'try again, or log out and log in once more.');
      }

      const trialEnds = new Date();
      trialEnds.setDate(trialEnds.getDate() + 7);

      const { data: org, error } = await supabase.from('orgs').insert({
        name: name.trim(),
        phone: phone.trim(),
        mode: 'estimate',
        is_gst_registered: false,
        state_code: stateCode || '18',
        state_name: STATES[stateCode || '18'] || '',
        plan: 'trial',
        trial_ends_at: trialEnds.toISOString(),
      }).select().single();

      if (error || !org) return Alert.alert('Could not save', sayPlainly(error));

      const { error: e2 } = await supabase.from('profiles')
        .upsert({ id: user.id, org_id: org.id, phone: phone.trim() });
      if (e2) {
        // A firm nothing points at is unreachable for ever, so it is taken
        // back out rather than left behind.
        try { await supabase.from('orgs').delete().eq('id', org.id); } catch (_) {}
        return Alert.alert('Could not save', sayPlainly(e2));
      }
      await reloadOrg();
    } catch (e) {
      Alert.alert('Could not save', sayPlainly(e));
    } finally { setBusy(false); }
  };

  if (!who) {
    return (
      <KeyForm style={S.screen} contentContainerStyle={{ padding: 24, paddingTop: 80 }}>
        <Text style={{ fontSize: 28, fontWeight: '700', color: C.ink }}>Welcome</Text>
        <Text style={{ fontSize: 15, color: C.muted, marginTop: 8, marginBottom: 28 }}>
          One question, and then you are billing.
        </Text>

        <TouchableOpacity onPress={() => setWho('owner')}
          style={{ backgroundColor: C.accentSoft, borderWidth: 1, borderColor: '#C9E4DF',
                   borderRadius: 12, padding: 18, marginBottom: 12 }}>
          <Text style={{ fontSize: 18, fontWeight: '700', color: C.accent }}>
            This is my shop
          </Text>
          <Text style={{ fontSize: 13, color: C.muted, marginTop: 5, lineHeight: 18 }}>
            Give it a name and start writing bills.
          </Text>
        </TouchableOpacity>

        <TouchableOpacity onPress={() => setWho('staff')}
          style={{ backgroundColor: C.surface, borderWidth: 1, borderColor: C.line,
                   borderRadius: 12, padding: 18 }}>
          <Text style={{ fontSize: 18, fontWeight: '700', color: C.ink }}>
            I work at a shop
          </Text>
          <Text style={{ fontSize: 13, color: C.muted, marginTop: 5, lineHeight: 18 }}>
            The owner already uses Skwik. He will read you a six-character code.
          </Text>
        </TouchableOpacity>

        <TouchableOpacity onPress={signOut} style={{ marginTop: 26, alignItems: 'center' }}>
          <Text style={{ fontSize: 14, fontWeight: '700', color: C.muted }}>Log out</Text>
        </TouchableOpacity>
      </KeyForm>
    );
  }

  if (who === 'staff') {
    return (
      <KeyForm style={S.screen} contentContainerStyle={{ padding: 24, paddingTop: 80 }}>
        <Text style={{ fontSize: 28, fontWeight: '700', color: C.ink }}>The shop code</Text>
        <Text style={{ fontSize: 15, color: C.muted, marginTop: 8, marginBottom: 24, lineHeight: 21 }}>
          Ask the owner to open Skwik, go to Settings → Who can bill, and tap
          Open. He will read you six letters and numbers. They only work for
          one hour, and for one phone.
        </Text>

        <Box ref={fCode} onSubmit={join} autoFocus
          style={[{ letterSpacing: 6, fontSize: 26, textAlign: 'center' }, S.num]}
          autoCapitalize="characters" maxLength={6} placeholder="ABC123"
          value={code} onChangeText={(t) => setCode(t.toUpperCase().replace(/[^A-Z0-9]/g, ''))} />

        <TouchableOpacity style={[S.btn, { marginTop: 18 }, busy && { opacity: 0.6 }]}
          onPress={join} disabled={busy}>
          <Text style={S.btnText}>{busy ? 'One moment…' : 'Join the shop'}</Text>
        </TouchableOpacity>

        <TouchableOpacity onPress={() => setWho('')}
          style={{ marginTop: 18, alignItems: 'center', paddingVertical: 10 }}>
          <Text style={{ fontSize: 15, fontWeight: '700', color: C.muted }}>Back</Text>
        </TouchableOpacity>
      </KeyForm>
    );
  }

  return (
    <KeyForm style={S.screen} contentContainerStyle={{ padding: 24, paddingTop: 80 }}>
      <Text style={{ fontSize: 28, fontWeight: '700', color: C.ink }}>Your shop</Text>
      <Text style={{ fontSize: 15, color: C.muted, marginTop: 8, marginBottom: 28 }}>
        Just the name for now. You can start billing straight away.
      </Text>

      <Text style={S.label}>Shop name</Text>
      <Box ref={fName} next={fPhone} style={{ marginTop: 6, marginBottom: 18, fontSize: 20 }}
        autoFocus placeholder="Your shop name"
        value={name} onChangeText={setName} />

      <Text style={S.label}>Which state?</Text>
      <View style={{ marginTop: 6, marginBottom: 18 }}>
        <StateField value={stateCode} homeCode={stateCode} onChange={setStateCode} />
      </View>

      <Text style={S.label}>Phone (optional)</Text>
      <Box ref={fPhone} onSubmit={start} style={{ marginTop: 6, marginBottom: 26 }}
        keyboardType="phone-pad" value={phone} onChangeText={setPhone} />

      <TouchableOpacity style={[S.btn, busy && { opacity: 0.6 }]} onPress={start} disabled={busy}>
        <Text style={S.btnText}>{busy ? 'One moment…' : 'Start billing'}</Text>
      </TouchableOpacity>

      <View style={{ marginTop: 22, padding: 14, backgroundColor: C.surface, borderWidth: 1,
                     borderColor: C.line, borderRadius: 12 }}>
        <Text style={{ fontSize: 13.5, fontWeight: '700', color: C.ink }}>
          Have a GST number?
        </Text>
        <Text style={{ fontSize: 12.5, fontWeight: '600', color: C.muted, marginTop: 5 }}>
          Add it later in Settings and your bills become proper tax invoices.
          Nothing you enter now is lost.
        </Text>
      </View>

      <TouchableOpacity onPress={() => setWho('staff')}
        style={{ marginTop: 18, alignItems: 'center', paddingVertical: 10 }}>
        <Text style={{ fontSize: 14, fontWeight: '700', color: C.accent }}>
          I work at a shop — I have a code
        </Text>
      </TouchableOpacity>

      <TouchableOpacity onPress={signOut} style={{ marginTop: 20, alignItems: 'center' }}>
        <Text style={{ fontSize: 14, fontWeight: '700', color: C.muted }}>Log out</Text>
      </TouchableOpacity>
    </KeyForm>
  );
}
