import React, { useCallback, useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, FlatList } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { supabase } from '../lib/supabase';
import { C, S } from '../theme';

export default function PartiesScreen({ navigation }) {
  const [rows, setRows] = useState([]);
  const [q, setQ] = useState('');

  useFocusEffect(useCallback(() => {
    supabase.from('parties').select('*').order('name').then(({ data }) => setRows(data || []));
  }, []));

  const shown = rows.filter((r) => r.name.toLowerCase().includes(q.toLowerCase()));

  return (
    <View style={S.screen}>
      <View style={[S.header, { paddingTop: 50 }]}>
        <TouchableOpacity onPress={() => navigation.goBack()} accessibilityLabel="Back"
          hitSlop={{ top: 14, bottom: 14, left: 14, right: 14 }}
          style={{ paddingVertical: 8, paddingRight: 10, paddingLeft: 2 }}>
          <Text style={{ fontSize: 26, color: C.ink }}>‹</Text>
        </TouchableOpacity>
        <Text style={S.h1}>Customers & suppliers</Text>
      </View>

      <View style={{ padding: 16 }}>
        <TextInput style={S.input} placeholder="Search a name" value={q} onChangeText={setQ} />
      </View>

      <FlatList
        data={shown}
        keyExtractor={(i) => i.id}
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 30 }}
        ListEmptyComponent={
          <Text style={{ color: C.muted, fontWeight: '600', textAlign: 'center', marginTop: 30 }}>
            Nobody yet. Names are saved automatically when you make a bill.
          </Text>}
        renderItem={({ item }) => (
          <TouchableOpacity
            onPress={() => navigation.navigate('Ledger', { partyId: item.id })}
            style={{ paddingVertical: 16, borderBottomWidth: 1, borderBottomColor: C.line }}>
            <Text style={{ fontSize: 17, fontWeight: '700', color: C.ink }}>{item.name}</Text>
            <Text style={{ fontSize: 12, fontWeight: '600', color: C.muted, marginTop: 2 }}>
              {item.state_name || ''}{item.gstin ? ` · ${item.gstin}` : ''}
            </Text>
          </TouchableOpacity>
        )} />
    </View>
  );
}
