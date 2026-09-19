import React, { useCallback, useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, FlatList, Modal, Alert, ScrollView,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { supabase } from '../lib/supabase';
import { useApp } from '../AppContext';
import { num } from '../lib/money';
import { STATES } from '../lib/states';
import { C, S } from '../theme';

// CUSTOMERS AND SUPPLIERS.
//
// Names still save themselves while billing. This screen is for everything
// the bill cannot ask for: the GST number that decides whether a customer is
// charged IGST, the phone the bill is sent to, and what he owed you before
// Skwik started.

const empty = {
  name: '', kind: 'customer', phone: '', gstin: '', address: '',
  state_code: '', state_name: '', price_list: 1,
  opening_balance: '', opening_type: 'owes_you',
  opening_date: new Date().toISOString().slice(0, 10),
};

export default function PartiesScreen({ navigation }) {
  const { org } = useApp();
  const [rows, setRows] = useState([]);
  const [q, setQ] = useState('');
  const [edit, setEdit] = useState(null);

  const load = () => supabase.from('parties').select('*').order('name')
    .then(({ data }) => setRows(data || []));
  useFocusEffect(useCallback(() => { load(); }, []));

  const shown = rows.filter((r) =>
    `${r.name} ${r.phone || ''} ${r.gstin || ''}`.toLowerCase().includes(q.toLowerCase()));

  const set = (k) => (v) => setEdit((e) => ({ ...e, [k]: v }));

  // Typing a GST number fills in the state by itself — the first two digits
  // are the state code, and getting it wrong is what puts CGST on a bill that
  // should carry IGST.
  const setGstin = (t) => {
    const g = t.toUpperCase().trim();
    const code = g.slice(0, 2);
    setEdit((e) => ({ ...e, gstin: g,
      ...(STATES[code] ? { state_code: code, state_name: STATES[code] } : {}) }));
  };

  const setStateCode = (t) => {
    const code = t.replace(/\D/g, '').slice(0, 2);
    setEdit((e) => ({ ...e, state_code: code, state_name: STATES[code] || '' }));
  };

  const save = async () => {
    if (!edit.name.trim()) return Alert.alert('Name needed', 'Type the name.');
    const g = edit.gstin.trim();
    if (g && g.length !== 15) {
      return Alert.alert('Check the GST number', 'A GSTIN is 15 characters, or leave it empty.');
    }
    if (g && !STATES[g.slice(0, 2)]) {
      return Alert.alert('Check the GST number', 'The first two digits are not a state code.');
    }

    const body = {
      org_id: org.id,
      name: edit.name.trim(),
      kind: edit.kind,
      phone: edit.phone.trim() || null,
      gstin: g || null,
      is_registered: !!g,
      address: edit.address.trim() || null,
      state_code: edit.state_code || org.state_code,
      state_name: edit.state_name || org.state_name,
      price_list: Number(edit.price_list) === 2 ? 2 : 1,
      opening_balance: num(edit.opening_balance),
      opening_type: edit.opening_type,
      opening_date: edit.opening_date || null,
    };

    const { error } = edit.id
      ? await supabase.from('parties').update(body).eq('id', edit.id)
      : await supabase.from('parties').insert(body);
    if (error) return Alert.alert('Could not save', error.message);
    setEdit(null); load();
  };

  const startEdit = (p) => setEdit({
    ...empty, ...p,
    phone: p.phone || '', gstin: p.gstin || '', address: p.address || '',
    state_code: p.state_code || '', state_name: p.state_name || '',
    price_list: Number(p.price_list) === 2 ? 2 : 1,
    opening_balance: p.opening_balance ? String(p.opening_balance) : '',
    opening_type: p.opening_type || 'owes_you',
    opening_date: p.opening_date || new Date().toISOString().slice(0, 10),
  });

  const Label = ({ children, top = 14 }) => (
    <Text style={[S.label, { marginTop: top }]}>{children}</Text>
  );

  const Pick = ({ options, value, onChange }) => (
    <View style={[S.row, { marginTop: 6, gap: 8 }]}>
      {options.map((o) => {
        const on = value === o.v;
        return (
          <TouchableOpacity key={String(o.v)} onPress={() => onChange(o.v)}
            style={{ flex: 1, paddingVertical: 10, borderRadius: 9, alignItems: 'center',
                     borderWidth: 1, borderColor: on ? C.accent : C.line,
                     backgroundColor: on ? C.accentSoft : C.surface }}>
            <Text style={{ fontSize: 13.5, fontWeight: '600', color: on ? C.accent : C.muted }}>
              {o.label}
            </Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );

  return (
    <View style={S.screen}>
      <View style={[S.header, { paddingTop: 50 }]}>
        <TouchableOpacity onPress={() => navigation.goBack()} accessibilityLabel="Back"
          hitSlop={{ top: 14, bottom: 14, left: 14, right: 14 }}
          style={{ paddingVertical: 8, paddingRight: 10, paddingLeft: 2 }}>
          <Text style={{ fontSize: 26, color: C.ink }}>‹</Text>
        </TouchableOpacity>
        <Text style={S.h1}>Customers &amp; suppliers</Text>
        <TouchableOpacity onPress={() => setEdit({ ...empty })}
          hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
          <Text style={{ fontSize: 15, fontWeight: '800', color: C.accent }}>+ NEW</Text>
        </TouchableOpacity>
      </View>

      <View style={{ padding: 16 }}>
        <TextInput style={S.input} placeholder="Search a name, phone or GST number"
          placeholderTextColor={C.faint} value={q} onChangeText={setQ} />
      </View>

      <FlatList
        data={shown}
        keyExtractor={(i) => i.id}
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 30 }}
        ListEmptyComponent={
          <Text style={{ color: C.muted, fontWeight: '600', textAlign: 'center', marginTop: 30,
                         lineHeight: 20 }}>
            Nobody yet. Names are saved automatically when you make a bill, or
            add one here with the details filled in.
          </Text>}
        renderItem={({ item }) => (
          <View style={[S.row, { borderBottomWidth: 1, borderBottomColor: C.line }]}>
            <TouchableOpacity
              onPress={() => navigation.navigate('Ledger', { partyId: item.id })}
              style={{ flex: 1, paddingVertical: 16 }}>
              <Text style={{ fontSize: 17, fontWeight: '700', color: C.ink }}>{item.name}</Text>
              <Text style={{ fontSize: 12, fontWeight: '600', color: C.muted, marginTop: 2 }}>
                {[item.phone, item.state_name, item.gstin].filter(Boolean).join(' · ') || 'No details yet'}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => startEdit(item)}
              hitSlop={{ top: 14, bottom: 14, left: 14, right: 14 }}
              style={{ paddingHorizontal: 8, paddingVertical: 16 }}>
              <Text style={{ fontSize: 13, fontWeight: '700', color: C.accent }}>EDIT</Text>
            </TouchableOpacity>
          </View>
        )} />

      <Modal visible={!!edit} animationType="slide" onRequestClose={() => setEdit(null)}>
        {!!edit && (
          <ScrollView style={S.screen} keyboardShouldPersistTaps="handled"
                      contentContainerStyle={{ padding: 20, paddingTop: 54 }}>
            <Text style={{ fontSize: 24, fontWeight: '700', color: C.ink }}>
              {edit.id ? edit.name || 'Edit' : 'New customer or supplier'}
            </Text>

            <Label top={18}>Name</Label>
            <TextInput style={[S.input, { marginTop: 6 }]} value={edit.name}
              onChangeText={set('name')} placeholder="Sri Ganesh Store"
              placeholderTextColor={C.faint} />

            <Label>They are a</Label>
            <Pick value={edit.kind} onChange={set('kind')}
              options={[{ v: 'customer', label: 'Customer' }, { v: 'supplier', label: 'Supplier' }]} />

            <Label>Phone</Label>
            <TextInput style={[S.input, S.num, { marginTop: 6 }]} keyboardType="phone-pad"
              value={edit.phone} onChangeText={set('phone')} placeholder="98640 12345"
              placeholderTextColor={C.faint} />

            <Label>GST number</Label>
            <TextInput style={[S.input, { marginTop: 6 }]} autoCapitalize="characters" maxLength={15}
              value={edit.gstin} onChangeText={setGstin} placeholder="Leave empty if unregistered"
              placeholderTextColor={C.faint} />

            <Label>State code</Label>
            <TextInput style={[S.input, S.num, { marginTop: 6 }]} keyboardType="number-pad"
              maxLength={2} value={String(edit.state_code || '')} onChangeText={setStateCode}
              placeholder="18" placeholderTextColor={C.faint} />
            <Text style={S.hint}>
              {edit.state_name
                ? `${edit.state_name}. ${edit.state_code === String(org?.state_code)
                    ? 'Same state as you, so bills carry CGST and SGST.'
                    : 'Different state, so bills carry IGST.'}`
                : 'This decides whether a bill carries CGST and SGST, or IGST.'}
            </Text>

            <Label>Address</Label>
            <TextInput style={[S.input, { marginTop: 6, height: 74, textAlignVertical: 'top' }]}
              multiline value={edit.address} onChangeText={set('address')} />

            <Label>Which price list</Label>
            <Pick value={Number(edit.price_list)} onChange={set('price_list')}
              options={[{ v: 1, label: org?.price1_name || 'Wholesale' },
                        { v: 2, label: org?.price2_name || 'Retail' }]} />

            <View style={{ marginTop: 24, padding: 14, backgroundColor: C.surface,
                           borderWidth: 1, borderColor: C.line, borderRadius: 12 }}>
              <Text style={S.eyebrow}>Before Skwik</Text>
              <Text style={{ fontSize: 12.5, color: C.muted, marginBottom: 10, lineHeight: 18 }}>
                What was already outstanding when you started. Leave it empty if
                nothing was.
              </Text>

              <TextInput style={[S.input, S.num]} keyboardType="numeric"
                value={edit.opening_balance} onChangeText={set('opening_balance')}
                placeholder="0" placeholderTextColor={C.faint} />

              <Pick value={edit.opening_type} onChange={set('opening_type')}
                options={[{ v: 'owes_you', label: 'They owe you' },
                          { v: 'you_owe', label: 'You owe them' }]} />

              <Label top={12}>As on</Label>
              <TextInput style={[S.input, S.num, { marginTop: 6 }]} value={edit.opening_date}
                onChangeText={set('opening_date')} placeholder="2026-04-01"
                placeholderTextColor={C.faint} />
            </View>

            <TouchableOpacity style={[S.btn, { marginTop: 24 }]} onPress={save}>
              <Text style={S.btnText}>Save</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => setEdit(null)}
              style={{ marginTop: 12, alignItems: 'center', paddingVertical: 10 }}>
              <Text style={{ fontSize: 16, fontWeight: '600', color: C.muted }}>Cancel</Text>
            </TouchableOpacity>
            <View style={{ height: 40 }} />
          </ScrollView>
        )}
      </Modal>
    </View>
  );
}
