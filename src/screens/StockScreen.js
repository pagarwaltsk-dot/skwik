import React, { useCallback, useState } from 'react';
import { View, Text, TouchableOpacity, FlatList, TextInput } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { supabase } from '../lib/supabase';
import { fmt0 } from '../lib/money';
import { C, S } from '../theme';

export default function StockScreen({ navigation }) {
  const [rows, setRows] = useState([]);
  const [q, setQ] = useState('');

  useFocusEffect(useCallback(() => {
    supabase.from('stock_in_hand').select('*').order('name')
      .then(({ data }) => setRows(data || []));
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
        <Text style={S.h1}>Stock in hand</Text>
      </View>

      <View style={{ padding: 16 }}>
        <TextInput style={S.input} placeholder="Search" value={q} onChangeText={setQ} />
      </View>

      <FlatList
        data={shown}
        keyExtractor={(i) => i.item_id}
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 30 }}
        renderItem={({ item }) => (
          <View style={[S.row, { paddingVertical: 15, borderBottomWidth: 1, borderBottomColor: C.line }]}>
            <Text style={{ flex: 1, fontSize: 16, fontWeight: '700', color: C.ink }}>{item.name}</Text>
            <Text style={[{ fontSize: 17, fontWeight: '800',
                            color: Number(item.qty) < 0 ? C.red : C.ink }, S.num]}>
              {fmt0(item.qty)} {item.unit}
            </Text>
          </View>
        )} />
    </View>
  );
}
