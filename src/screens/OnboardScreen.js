import React, { useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, ScrollView, Alert } from 'react-native';
import { supabase } from '../lib/supabase';
import { useApp } from '../AppContext';
import { C, S } from '../theme';

// State code -> name. The first two digits of a GSTIN are the state code.
export const STATES = {
  '01':'Jammu and Kashmir','02':'Himachal Pradesh','03':'Punjab','04':'Chandigarh','05':'Uttarakhand',
  '06':'Haryana','07':'Delhi','08':'Rajasthan','09':'Uttar Pradesh','10':'Bihar','11':'Sikkim',
  '12':'Arunachal Pradesh','13':'Nagaland','14':'Manipur','15':'Mizoram','16':'Tripura','17':'Meghalaya',
  '18':'Assam','19':'West Bengal','20':'Jharkhand','21':'Odisha','22':'Chhattisgarh','23':'Madhya Pradesh',
  '24':'Gujarat','27':'Maharashtra','29':'Karnataka','30':'Goa','32':'Kerala','33':'Tamil Nadu',
  '34':'Puducherry','36':'Telangana','37':'Andhra Pradesh','38':'Ladakh',
};

// THE WHOLE OF SIGNING UP. A name, and that is all.
// No GST number, no HSN, no state code, no scheme questions. He is billing
// twenty seconds after he installs it. GST is switched on later, in Settings,
// and everything he has entered by then carries straight over.
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
      <Text style={{ fontSize: 30, fontWeight: '800', color: C.ink }}>Your shop</Text>
      <Text style={{ fontSize: 15, fontWeight: '600', color: C.muted, marginTop: 8, marginBottom: 28 }}>
        Just the name for now. You can start billing straight away.
      </Text>

      <Text style={S.label}>SHOP NAME</Text>
      <TextInput style={[S.input, { marginTop: 6, marginBottom: 18, fontSize: 20 }]}
        autoFocus placeholder="Sharma Steel Store" value={name} onChangeText={setName} />

      <Text style={S.label}>PHONE (OPTIONAL)</Text>
      <TextInput style={[S.input, { marginTop: 6, marginBottom: 26 }]}
        keyboardType="phone-pad" value={phone} onChangeText={setPhone} />

      <TouchableOpacity style={[S.btn, busy && { opacity: 0.6 }]} onPress={start} disabled={busy}>
        <Text style={S.btnText}>{busy ? 'One moment…' : 'START BILLING'}</Text>
      </TouchableOpacity>

      <View style={{ marginTop: 22, padding: 15, backgroundColor: C.soft, borderRadius: 16 }}>
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
