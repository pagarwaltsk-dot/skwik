import React, { useCallback, useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, ScrollView, Alert,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { supabase } from '../lib/supabase';
import { useApp } from '../AppContext';
import { num, fmt0, settle } from '../lib/money';
import { C, S } from '../theme';

// MONEY IN, MONEY OUT — and putting it right when it was typed wrong.
//
// A wrong amount used to stay wrong for ever, and the customer's account
// stayed wrong with it. Recent entries are listed below the form now: tap one
// to correct it, or remove it.
//
// The receipts a cash bill writes by itself are shown but never edited here.
// They belong to the bill, and changing the bill is what changes them.

const dmy = (d) => `${String(d).slice(8, 10)}/${String(d).slice(5, 7)}/${String(d).slice(2, 4)}`;

export default function MoneyScreen({ route, navigation }) {
  const ptype    = route.params?.ptype || 'receipt';
  const received = ptype === 'receipt';
  const { org } = useApp();

  const [parties, setParties] = useState([]);
  const [recent, setRecent]   = useState([]);
  const [text, setText]   = useState('');
  const [party, setParty] = useState(null);
  const [mode, setMode]   = useState('cash');
  const [amount, setAmount] = useState('');
  const [note, setNote]   = useState('');
  const [editing, setEditing] = useState(null);   // the entry being corrected
  const [busy, setBusy]   = useState(false);

  const load = useCallback(async () => {
    const [{ data: ps }, { data: rs }] = await Promise.all([
      supabase.from('parties').select('*').order('name'),
      supabase.from('payments')
        .select('*, parties(name)')
        .eq('ptype', ptype)
        .order('pdate', { ascending: false })
        .order('created_at', { ascending: false })
        .limit(40),
    ]);
    setParties(ps || []);
    setRecent(rs || []);
  }, [ptype]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const matches = text.trim() && !party
    ? parties.filter((p) => p.name.toLowerCase().includes(text.toLowerCase())).slice(0, 5)
    : [];

  const clear = () => {
    setEditing(null); setParty(null); setText(''); setAmount(''); setNote(''); setMode('cash');
  };

  const startEdit = (p) => {
    if (p.ref_voucher_id) {
      return Alert.alert('This one came from a bill',
        'It was written when you saved a cash bill. To change it, change that '
        + 'bill under Past bills — the cash follows it.');
    }
    setEditing(p);
    setParty({ id: p.party_id, name: p.parties?.name || '' });
    setText(p.parties?.name || '');
    setMode(p.mode || 'cash');
    setAmount(String(Number(p.amount)));
    setNote(p.note || '');
  };

  const save = async () => {
    if (!party && !text.trim()) {
      return Alert.alert('Who?', received ? 'Type who paid you.' : 'Type who you paid.');
    }
    if (num(amount) <= 0) return Alert.alert('Amount?', 'Type how much.');

    setBusy(true);
    try {
      let p = party;
      if (!p?.id) {
        const hit = parties.find((x) => x.name.toLowerCase() === text.trim().toLowerCase());
        p = hit || (await supabase.from('parties').insert({
          org_id: org.id, name: text.trim(), kind: received ? 'customer' : 'supplier',
          state_code: org.state_code, state_name: org.state_name,
        }).select().single()).data;
      }

      const body = {
        org_id: org.id, ptype, party_id: p.id, mode,
        amount: num(amount), note: note.trim() || null,
      };

      if (editing) {
        const { error } = await supabase.from('payments').update(body).eq('id', editing.id);
        if (error) throw error;
        clear(); await load();
        Alert.alert('Changed', `Now ₹${fmt0(num(amount))}.`);
      } else {
        const { error } = await supabase.from('payments')
          .insert({ ...body, pdate: new Date().toISOString().slice(0, 10) });
        if (error) throw error;
        navigation.navigate('Ledger', { partyId: p.id });
      }
    } catch (e) {
      Alert.alert('Could not save', e.message || String(e));
    } finally { setBusy(false); }
  };

  const remove = (p) => {
    if (p.ref_voucher_id) {
      return Alert.alert('This one came from a bill',
        'Remove the bill under Past bills and this goes with it.');
    }
    Alert.alert(
      `Remove ₹${fmt0(p.amount)}?`,
      `${received ? 'Received from' : 'Paid to'} ${p.parties?.name || 'them'} on ${dmy(p.pdate)}.\n\n`
      + "Their account goes back to what it was before this entry.",
      [{ text: 'Keep it' },
       { text: 'Remove', style: 'destructive', onPress: async () => {
           const { error } = await supabase.from('payments').delete().eq('id', p.id);
           if (error) return Alert.alert('Could not remove it', error.message);
           if (editing?.id === p.id) clear();
           load();
         } }]);
  };

  const Pick = ({ v, label }) => (
    <TouchableOpacity onPress={() => setMode(v)} style={{
      flex: 1, height: 64, borderRadius: 14, alignItems: 'center', justifyContent: 'center',
      borderWidth: 1.5, borderColor: mode === v ? C.accent : C.line,
      backgroundColor: mode === v ? C.accentSoft : C.surface }}>
      <Text style={{ fontSize: 17, fontWeight: '700', color: mode === v ? C.accent : C.muted }}>
        {label}
      </Text>
    </TouchableOpacity>
  );

  return (
    <ScrollView style={S.screen} keyboardShouldPersistTaps="handled"
                contentContainerStyle={{ padding: 16, paddingTop: 50, paddingBottom: 40 }}>
      <View style={S.row}>
        <TouchableOpacity onPress={() => navigation.goBack()} accessibilityLabel="Back"
          hitSlop={{ top: 14, bottom: 14, left: 14, right: 14 }}
          style={{ paddingVertical: 8, paddingRight: 10, paddingLeft: 2 }}>
          <Text style={{ fontSize: 26, color: C.ink }}>‹</Text>
        </TouchableOpacity>
        <Text style={S.h1}>{received ? 'Money received' : 'Money paid'}</Text>
      </View>

      {!!editing && (
        <View style={{ marginTop: 14, padding: 12, backgroundColor: C.flagSoft,
                       borderWidth: 1, borderColor: C.flagLine, borderRadius: 12 }}>
          <Text style={{ fontSize: 13, fontWeight: '700', color: C.flagInk }}>
            Correcting the entry of {dmy(editing.pdate)}
          </Text>
          <TouchableOpacity onPress={clear} style={{ paddingTop: 6 }}>
            <Text style={{ fontSize: 13, fontWeight: '700', color: C.accent }}>
              Leave it alone and write a new one instead
            </Text>
          </TouchableOpacity>
        </View>
      )}

      <View style={{ height: 18 }} />
      <Text style={S.label}>{received ? 'Received from' : 'Paid to'}</Text>
      <TextInput style={[S.input, { marginTop: 6 }]} placeholder="Type a name"
        placeholderTextColor={C.faint}
        value={text} onChangeText={(t) => { setText(t); setParty(null); }} />

      {matches.map((p) => (
        <TouchableOpacity key={p.id} onPress={() => { setParty(p); setText(p.name); }}
          style={{ padding: 12, backgroundColor: C.surface, borderWidth: 1,
                   borderColor: C.line, borderRadius: 12, marginTop: 6 }}>
          <Text style={{ fontSize: 15, fontWeight: '700', color: C.ink }}>{p.name}</Text>
        </TouchableOpacity>
      ))}

      <View style={{ height: 18 }} />
      <Text style={S.label}>How?</Text>
      <View style={[S.row, { marginTop: 8, gap: 10 }]}>
        <Pick v="cash" label="Cash" />
        <Pick v="bank" label="Bank" />
      </View>

      <View style={{ height: 18 }} />
      <Text style={S.label}>How much?</Text>
      <TextInput
        style={[S.input, { marginTop: 6, fontSize: 32, paddingVertical: 14 }, S.num]}
        keyboardType="numeric" placeholder="0" placeholderTextColor={C.faint}
        value={amount} onChangeText={setAmount}
        onBlur={() => setAmount(settle(amount))} />

      <View style={{ height: 18 }} />
      <Text style={S.label}>What for (optional)</Text>
      <TextInput style={[S.input, { marginTop: 6 }]} placeholder="Against bill 41"
        placeholderTextColor={C.faint} value={note} onChangeText={setNote} />

      <TouchableOpacity style={[S.btn, { marginTop: 22 }, busy && { backgroundColor: C.faint }]}
        onPress={save} disabled={busy}>
        <Text style={S.btnText}>
          {busy ? 'Saving…' : editing ? `Save the change — ₹${fmt0(num(amount))}`
                                      : `Save ₹${fmt0(num(amount))}`}
        </Text>
      </TouchableOpacity>

      {/* ---------- what was entered lately ---------- */}
      {!!recent.length && (
        <>
          <Text style={[S.eyebrow, { marginTop: 30 }]}>
            Lately — tap one to put it right
          </Text>
          {recent.map((p) => (
            <View key={p.id} style={[S.row, { paddingVertical: 12, borderBottomWidth: 1,
                                              borderBottomColor: C.line }]}>
              <TouchableOpacity style={{ flex: 1, minWidth: 0 }} onPress={() => startEdit(p)}>
                <Text numberOfLines={1} style={{ fontSize: 15, fontWeight: '600', color: C.ink }}>
                  {p.parties?.name || '—'}
                </Text>
                <Text style={{ fontSize: 11.5, color: C.muted, marginTop: 2 }}>
                  {dmy(p.pdate)} · {p.mode === 'bank' ? 'Bank' : 'Cash'}
                  {p.ref_voucher_id ? ' · from a bill' : ''}
                  {p.note ? ` · ${p.note}` : ''}
                </Text>
              </TouchableOpacity>
              <Text style={[{ fontSize: 15, fontWeight: '700', color: C.ink, marginRight: 10 },
                            S.num]}>
                {fmt0(p.amount)}
              </Text>
              <TouchableOpacity onPress={() => remove(p)}
                hitSlop={{ top: 14, bottom: 14, left: 14, right: 14 }}
                style={{ paddingHorizontal: 6 }}>
                <Text style={{ fontSize: 20, color: p.ref_voucher_id ? C.greyB : C.danger }}>×</Text>
              </TouchableOpacity>
            </View>
          ))}
        </>
      )}
    </ScrollView>
  );
}
