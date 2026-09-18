import React, { useCallback, useState } from 'react';
import { View, Text, TouchableOpacity, ScrollView } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { supabase } from '../lib/supabase';
import { useApp } from '../AppContext';
import { fmt0 } from '../lib/money';
import { C, S } from '../theme';

const Tile = ({ label, onPress }) => (
  <TouchableOpacity onPress={onPress} style={{
    flex: 1, paddingVertical: 16, borderRadius: 12, borderWidth: 1, borderColor: C.line,
    backgroundColor: C.surface, alignItems: 'center' }}>
    <Text style={{ fontSize: 14, fontWeight: '600', color: C.ink }}>{label}</Text>
  </TouchableOpacity>
);

export default function HomeScreen({ navigation }) {
  const { org } = useApp();
  const [today, setToday] = useState({ total: 0, count: 0 });
  const [fyTotal, setFyTotal] = useState(0);
  const estimate = org?.mode === 'estimate';

  useFocusEffect(useCallback(() => {
    let on = true;
    (async () => {
      const d = new Date().toISOString().slice(0, 10);
      const { data } = await supabase.from('vouchers')
        .select('total').in('vtype', ['sale', 'estimate']).eq('vdate', d);
      if (on && data) {
        setToday({ total: data.reduce((s, v) => s + Number(v.total || 0), 0), count: data.length });
      }
      if (org?.is_composition) {
        const now = new Date();
        const fyStart = `${now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1}-04-01`;
        const { data: fy } = await supabase.from('vouchers')
          .select('total').eq('vtype', 'sale').gte('vdate', fyStart);
        if (on && fy) setFyTotal(fy.reduce((s, v) => s + Number(v.total || 0), 0));
      }
    })();
    return () => { on = false; };
  }, [org?.is_composition]));

  const trialLeft = org?.trial_ends_at && org?.plan === 'trial'
    ? Math.ceil((new Date(org.trial_ends_at) - new Date()) / 86400000) : null;

  return (
    <View style={S.screen}>
      <View style={[S.bar, { paddingTop: 46 }]}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text numberOfLines={1} style={S.barName}>{org?.name}</Text>
          <Text style={S.barSub}>{estimate ? 'Estimates' : 'GST billing'}</Text>
        </View>
        <TouchableOpacity onPress={() => navigation.navigate('More')}
          style={{ paddingHorizontal: 8, paddingVertical: 4 }}>
          <Text style={{ fontSize: 22, color: '#fff', opacity: 0.85 }}>⋯</Text>
        </TouchableOpacity>
      </View>

      <ScrollView contentContainerStyle={{ padding: 12, paddingBottom: 30 }}>
        {trialLeft !== null && (
          <View style={{ backgroundColor: trialLeft > 2 ? C.accentSoft : C.editSoft,
                         borderWidth: 1, borderColor: trialLeft > 2 ? '#C9E4DF' : '#E8D7A8',
                         borderRadius: 12, padding: 12, marginBottom: 12 }}>
            <Text style={{ fontSize: 13, fontWeight: '600',
                           color: trialLeft > 2 ? C.accent : C.edit }}>
              {trialLeft > 0
                ? `Free trial — ${trialLeft} day${trialLeft === 1 ? '' : 's'} left`
                : 'Your free trial has ended'}
            </Text>
          </View>
        )}

        {org?.is_composition && fyTotal >= 12000000 && (
          <View style={{ backgroundColor: fyTotal >= 15000000 ? '#FBEDEC' : C.editSoft,
                         borderWidth: 1, borderColor: fyTotal >= 15000000 ? '#E7C4C2' : '#E8D7A8',
                         borderRadius: 12, padding: 12, marginBottom: 12 }}>
            <Text style={{ fontSize: 13, fontWeight: '600',
                           color: fyTotal >= 15000000 ? '#7E2C28' : C.edit }}>
              This year's sale is ₹{fmt0(fyTotal)}. The composition limit is ₹1.5 crore.
            </Text>
            <Text style={{ fontSize: 12, marginTop: 4,
                           color: fyTotal >= 15000000 ? '#7E2C28' : C.edit }}>
              Speak to your accountant. Your billing carries on as normal.
            </Text>
          </View>
        )}

        <View style={S.card}>
          <Text style={S.eyebrow}>Today</Text>
          <View style={{ flexDirection: 'row', alignItems: 'flex-end' }}>
            <Text style={[{ flex: 1, fontSize: 30, fontWeight: '700', color: C.ink,
                            letterSpacing: -0.5 }, S.num]}>
              ₹{fmt0(today.total)}
            </Text>
            <Text style={{ fontSize: 13, color: C.muted, paddingBottom: 5 }}>
              {today.count} {today.count === 1 ? 'bill' : 'bills'}
            </Text>
          </View>
        </View>

        <TouchableOpacity
          onPress={() => navigation.navigate('Bill', { vtype: 'sale' })}
          style={[S.btn, { paddingVertical: 26, borderRadius: 12, marginBottom: 12 }]}>
          <Text style={{ fontSize: 22, fontWeight: '700', color: '#fff' }}>
            {estimate ? 'New estimate' : 'New bill'}
          </Text>
        </TouchableOpacity>

        <View style={[S.row, { marginBottom: 10 }]}>
          <Tile label="Purchase" onPress={() => navigation.navigate('Bill',  { vtype: 'purchase' })} />
          <Tile label="Received" onPress={() => navigation.navigate('Money', { ptype: 'receipt' })} />
        </View>
        <View style={[S.row, { marginBottom: 10 }]}>
          <Tile label="Paid"      onPress={() => navigation.navigate('Money', { ptype: 'payment' })} />
          <Tile label="Customers" onPress={() => navigation.navigate('Parties')} />
        </View>
        <View style={S.row}>
          <Tile label="Items" onPress={() => navigation.navigate('Items')} />
          {org?.stock_enabled
            ? <Tile label="Stock" onPress={() => navigation.navigate('Stock')} />
            : <View style={{ flex: 1 }} />}
        </View>
      </ScrollView>
    </View>
  );
}
