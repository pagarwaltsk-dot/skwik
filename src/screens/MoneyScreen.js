import React, { useEffect, useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, ScrollView, Alert } from 'react-native';
import { supabase } from '../lib/supabase';
import { useApp } from '../AppContext';
import { num, fmt0 } from '../lib/money';
import { C, S } from '../theme';

export default function MoneyScreen({ route, navigation }) {
  const ptype    = route.params?.ptype || 'receipt';
  const received = ptype === 'receipt';
  const { org } = useApp();

  const [parties, setParties] = useState([]);
  const [text, setText]   = useState('');
  const [party, setParty] = useState(null);
  const [mode, setMode]   = useState('cash');
  const [amount, setAmount] = useState('');
  const [busy, setBusy]   = useState(false);

  useEffect(() => {
    supabase.from('parties').select('*').order('name').then(({ data }) => setParties(data || []));
  }, []);

  const matches = text.trim() && !party
    ? parties.filter((p) => p.name.toLowerCase().includes(text.toLowerCase())).slice(0, 5)
    : [];

  const save = async () => {
    if (!party && !text.trim()) return Alert.alert('Who?', received ? 'Type who paid you.' : 'Type who you paid.');
    if (num(amount) <= 0)       return Alert.alert('Amount?', 'Type how much.');

    setBusy(true);
    try {
      let p = party;
      if (!p) {
        const hit = parties.find((x) => x.name.toLowerCase() === text.trim().toLowerCase());
        p = hit || (await supabase.from('parties').insert({
          org_id: org.id, name: text.trim(), kind: received ? 'customer' : 'supplier',
          state_code: org.state_code, state_name: org.state_name,
        }).select().single()).data;
      }

      const { error } = await supabase.from('payments').insert({
        org_id: org.id, ptype, party_id: p.id, mode, amount: num(amount),
        pdate: new Date().toISOString().slice(0, 10),
      });
      if (error) throw error;
      navigation.navigate('Ledger', { partyId: p.id });
    } catch (e) {
      Alert.alert('Could not save', e.message || String(e));
    } finally { setBusy(false); }
  };

  const Pick = ({ v, label }) => (
    <TouchableOpacity onPress={() => setMode(v)} style={{
      flex: 1, height: 70, borderRadius: 18, alignItems: 'center', justifyContent: 'center',
      borderWidth: 2, borderColor: mode === v ? C.green : C.greyB,
      backgroundColor: mode === v ? C.greenL : C.card }}>
      <Text style={{ fontSize: 18, fontWeight: '800', color: mode === v ? C.greenD : C.muted }}>{label}</Text>
    </TouchableOpacity>
  );

  return (
    <ScrollView style={S.screen} keyboardShouldPersistTaps="handled"
                contentContainerStyle={{ padding: 16, paddingTop: 50 }}>
      <View style={S.row}>
        <TouchableOpacity onPress={() => navigation.goBack()}>
          <Text style={{ fontSize: 26, color: C.ink }}>‹</Text>
        </TouchableOpacity>
        <Text style={S.h1}>{received ? 'Money received' : 'Money paid'}</Text>
      </View>

      <View style={{ height: 20 }} />
      <Text style={S.label}>{received ? 'RECEIVED FROM' : 'PAID TO'}</Text>
      <TextInput style={[S.input, { marginTop: 6 }]} placeholder="Type a name"
        value={text} onChangeText={(t) => { setText(t); setParty(null); }} />

      {matches.map((p) => (
        <TouchableOpacity key={p.id} onPress={() => { setParty(p); setText(p.name); }}
          style={{ padding: 12, backgroundColor: C.card, borderWidth: 1,
                   borderColor: C.line, borderRadius: 12, marginTop: 6 }}>
          <Text style={{ fontSize: 15, fontWeight: '700', color: C.ink }}>{p.name}</Text>
        </TouchableOpacity>
      ))}

      <View style={{ height: 22 }} />
      <Text style={S.label}>HOW?</Text>
      <View style={[S.row, { marginTop: 8 }]}>
        <Pick v="cash" label="CASH" />
        <Pick v="bank" label="BANK" />
      </View>

      <View style={{ height: 22 }} />
      <Text style={S.label}>HOW MUCH?</Text>
      <TextInput
        style={[S.input, { marginTop: 6, fontSize: 34, paddingVertical: 16 }, S.num]}
        keyboardType="numeric" placeholder="0" value={amount} onChangeText={setAmount} />

      <TouchableOpacity style={[S.btn, { marginTop: 26 }, busy && { opacity: 0.6 }]}
        onPress={save} disabled={busy}>
        <Text style={S.btnText}>{busy ? 'Saving…' : `SAVE ₹${fmt0(num(amount))}`}</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}
