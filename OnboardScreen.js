import React, { useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, ScrollView, Alert } from 'react-native';
import { supabase } from '../lib/supabase';
import { useApp } from '../AppContext';
import { STATES } from '../lib/states';
import { C, S } from '../theme';


// A SAFETY NET, not the usual way in. Registering happens on RegisterScreen.
// This shows only if someone has a login but no shop against it - an account
// made before this version, or a sign-up that stopped half way.
export default function OnboardScreen() {
  const { reloadOrg, signOut } = useApp();
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);

  const start = async () => {
    if (!name.trim()) return Alert.alert('Shop name', 'Type the name that should print on your bills.');
    setBusy(true);
    const { data: { user } } = await supabase.auth.getUser();

    const trialEnds = new Date();
    trialEnds.setDate(trialEnds.getDate() + 7);

    const { data: org, error } = await supabase.from('orgs').insert({
      name: name.trim(),
      phone: phone.trim(),
      mode: 'estimate',
      is_gst_registered: false,
      state_code: '18',
      state_name: STATES['18'],
      plan: 'trial',
      trial_ends_at: trialEnds.toISOString(),
    }).select().single();

    if (error) { setBusy(false); return Alert.alert('Could not save', error.message); }

    const { error: e2 } = await supabase.from('profiles')
      .upsert({ id: user.id, org_id: org.id, phone: phone.trim() });
    setBusy(false);
    if (e2) return Alert.alert('Could not save', e2.message);
    await reloadOrg();
  };

  return (
    <ScrollView style={S.screen} contentContainerStyle={{ padding: 24, paddingTop: 80 }}>
      <Text style={{ fontSize: 28, fontWeight: '700', color: C.ink }}>Your shop</Text>
      <Text style={{ fontSize: 15, color: C.muted, marginTop: 8, marginBottom: 28 }}>
        Just the name for now. You can start billing straight away.
      </Text>

      <Text style={S.label}>Shop name</Text>
      <TextInput style={[S.input, { marginTop: 6, marginBottom: 18, fontSize: 20 }]}
        autoFocus placeholder="Your shop name" placeholderTextColor={C.faint}
        value={name} onChangeText={setName} />

      <Text style={S.label}>Phone (optional)</Text>
      <TextInput style={[S.input, { marginTop: 6, marginBottom: 26 }]}
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

      <TouchableOpacity onPress={signOut} style={{ marginTop: 20, alignItems: 'center' }}>
        <Text style={{ fontSize: 14, fontWeight: '700', color: C.muted }}>Log out</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

export { STATES };
