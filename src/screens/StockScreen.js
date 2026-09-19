import React, { useCallback, useState } from 'react';
import { View, Text, TouchableOpacity, FlatList, TextInput } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { supabase } from '../lib/supabase';
import { fmt0 } from '../lib/money';
import { Head } from '../components/Chrome';
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
      <Head navigation={navigation} title="Stock in hand" />

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
