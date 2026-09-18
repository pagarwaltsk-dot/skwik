import React, { useCallback, useState } from 'react';
import { View, Text, TouchableOpacity, ScrollView } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { supabase } from '../lib/supabase';
import { useApp } from '../AppContext';
import { fmt0 } from '../lib/money';
import { C, S } from '../theme';

const Tile = ({ label, onPress }) => (
  <TouchableOpacity onPress={onPress} style={{
    flex: 1, height: 90, borderRadius: 18, borderWidth: 1.5, borderColor: C.greyB,
    backgroundColor: C.grey, alignItems: 'center', justifyContent: 'center' }}>
    <Text style={{ fontSize: 15, fontWeight: '700', color: '#4A4944' }}>{label}</Text>
  </TouchableOpacity>
);

export default function HomeScreen({ navigation }) {
  const { org } = useApp();
  const [today, setToday] = useState({ total: 0, count: 0 });
  const [fyTotal, setFyTotal] = useState(0);

  useFocusEffect(useCallback(() => {
    let on = true;
    (async () => {
      const d = new Date().toISOString().slice(0, 10);
      const { data } = await supabase.from('vouchers')
        .select('total').eq('vtype', 'sale').eq('vdate', d);
      if (on && data) {
        setToday({ total: data.reduce((s, v) => s + Number(v.total || 0), 0), count: data.length });
      }

      // A composition dealer must leave the scheme BEFORE he crosses the limit,
      // so he needs to see the number coming. The app never stops him billing.
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

  return (
    <ScrollView style={S.screen} contentContainerStyle={{ padding: 18, paddingTop: 50 }}>
      <View style={S.row}>
        <Text style={{ flex: 1, fontSize: 20, fontWeight: '800', color: C.ink }}>
          {org?.name?.toUpperCase()}
        </Text>
        <TouchableOpacity onPress={() => navigation.navigate('More')} style={{
          width: 44, height: 44, borderRadius: 14, borderWidth: 1.5, borderColor: '#D9D6CC',
          backgroundColor: C.card, alignItems: 'center', justifyContent: 'center' }}>
          <Text style={{ fontSize: 18, fontWeight: '800', color: C.ink }}>⋯</Text>
        </TouchableOpacity>
      </View>

      {!!org?.trial_ends_at && org?.plan === 'trial' && (() => {
        const left = Math.ceil((new Date(org.trial_ends_at) - new Date()) / 86400000);
        return (
          <View style={{ marginTop: 14, padding: 12, borderRadius: 14,
                         backgroundColor: left > 2 ? C.soft : '#FBF3E2' }}>
            <Text style={{ fontSize: 13, fontWeight: '700',
                           color: left > 2 ? C.muted : '#7A5310' }}>
              {left > 0 ? `Free trial — ${left} day${left === 1 ? '' : 's'} left.`
                        : 'Your free trial has ended.'}
            </Text>
          </View>
        );
      })()}

      <View style={{ marginTop: 16, padding: 16, backgroundColor: C.card, borderWidth: 1.5,
                     borderColor: C.line, borderRadius: 18 }}>
        <Text style={S.label}>TODAY'S SALE</Text>
        <View style={[S.row, { marginTop: 2 }]}>
          <Text style={[{ flex: 1, fontSize: 32, fontWeight: '800', color: C.ink }, S.num]}>
            ₹ {fmt0(today.total)}
          </Text>
          <Text style={{ fontSize: 13, fontWeight: '700', color: C.muted }}>{today.count} bills</Text>
        </View>
      </View>

      {org?.is_composition && fyTotal >= 12000000 && (
        <View style={{ marginTop: 14, padding: 14, borderRadius: 16,
                       backgroundColor: fyTotal >= 15000000 ? '#FBEDEA' : '#FBF3E2',
                       borderWidth: 1.5,
                       borderColor: fyTotal >= 15000000 ? '#F0D2CA' : '#EBDBB6' }}>
          <Text style={{ fontSize: 13.5, fontWeight: '800',
                         color: fyTotal >= 15000000 ? '#8E3527' : '#7A5310' }}>
            {fyTotal >= 15000000
              ? `This year's sale is ₹${fmt0(fyTotal)} — above the ₹1.5 crore composition limit.`
              : `This year's sale is ₹${fmt0(fyTotal)}. The composition limit is ₹1.5 crore.`}
          </Text>
          <Text style={{ fontSize: 12, fontWeight: '600', marginTop: 5,
                         color: fyTotal >= 15000000 ? '#8E3527' : '#7A5310' }}>
            Speak to your accountant about leaving the scheme. Your billing carries on as normal.
          </Text>
        </View>
      )}

      <TouchableOpacity
        onPress={() => navigation.navigate('Bill', { vtype: 'sale' })}
        style={{ marginTop: 16, height: 250, backgroundColor: C.green, borderRadius: 26,
                 alignItems: 'center', justifyContent: 'center' }}>
        <Text style={{ fontSize: 56, fontWeight: '300', color: '#fff', marginBottom: 8 }}>+</Text>
        <Text style={{ fontSize: 36, fontWeight: '800', color: '#fff' }}>
          {org?.mode === 'estimate' ? 'NEW ESTIMATE' : 'NEW BILL'}
        </Text>
      </TouchableOpacity>

      <View style={[S.row, { marginTop: 16 }]}>
        <Tile label="Purchase" onPress={() => navigation.navigate('Bill',  { vtype: 'purchase' })} />
        <Tile label="Received" onPress={() => navigation.navigate('Money', { ptype: 'receipt' })} />
      </View>
      <View style={[S.row, { marginTop: 12 }]}>
        <Tile label="Paid" onPress={() => navigation.navigate('Money', { ptype: 'payment' })} />
        {org?.stock_enabled
          ? <Tile label="Stock" onPress={() => navigation.navigate('Stock')} />
          : <Tile label="Customers" onPress={() => navigation.navigate('Parties')} />}
      </View>
      <View style={[S.row, { marginTop: 12 }]}>
        {org?.stock_enabled
          ? <Tile label="Customers" onPress={() => navigation.navigate('Parties')} />
          : <Tile label="Items" onPress={() => navigation.navigate('Items')} />}
        {org?.stock_enabled
          ? <Tile label="Items" onPress={() => navigation.navigate('Items')} />
          : <View style={{ flex: 1 }} />}
      </View>
    </ScrollView>
  );
}
