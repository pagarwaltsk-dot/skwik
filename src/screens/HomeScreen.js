import React, { useCallback, useState } from 'react';
import { View, Text, TouchableOpacity, ScrollView, Alert } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { supabase } from '../lib/supabase';
import { useApp } from '../AppContext';
import { fmt0 } from '../lib/money';
import { Bar, MoreButton } from '../components/Chrome';
import { showPurchase, showReports, showStock } from '../lib/features';
import { C, S } from '../theme';

const Tile = ({ label, onPress }) => (
  <TouchableOpacity onPress={onPress} style={{
    flex: 1, paddingVertical: 16, borderRadius: 12, borderWidth: 1, borderColor: C.line,
    backgroundColor: C.surface, alignItems: 'center' }}>
    <Text style={{ fontSize: 14, fontWeight: '600', color: C.ink }}>{label}</Text>
  </TouchableOpacity>
);

export default function HomeScreen({ navigation }) {
  const { org, pending, countPending, sendPending } = useApp();
  const [sending, setSending] = useState(false);
  const [today, setToday] = useState({ total: 0, count: 0 });
  const [fyTotal, setFyTotal] = useState(0);
  const estimate = org?.mode === 'estimate';

  useFocusEffect(useCallback(() => {
    let on = true;
    (async () => {
      countPending?.();
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
  }, [org?.is_composition, countPending]));

  // Bills written with no signal. Tapping tries them again there and then.
  const pushNow = async () => {
    setSending(true);
    const r = await sendPending();
    setSending(false);
    if (r.stillOffline) {
      Alert.alert('Still no internet',
        'Your bills are safe on this phone. Try again when you have signal.');
    } else if (r.failed) {
      Alert.alert('Some could not be sent',
        `${r.sent} went through. ${r.failed} were refused by the server and are `
        + 'still here. Tell me the bill and I can look at it.');
    } else if (r.sent) {
      Alert.alert('Sent', `${r.sent} bill${r.sent === 1 ? '' : 's'} reached your books.`);
    }
  };

  // Two to a row, and only what this shop has switched on in Settings. A
  // counter that bills and takes cash sees four buttons, not ten.
  const tiles = [
    { label: 'Past bills', go: () => navigation.navigate('Bills') },
    showPurchase(org) &&
      { label: 'Purchase', go: () => navigation.navigate('Bill', { vtype: 'purchase' }) },
    { label: 'Received',  go: () => navigation.navigate('Money', { ptype: 'receipt' }) },
    { label: 'Paid',      go: () => navigation.navigate('Money', { ptype: 'payment' }) },
    { label: 'Customers', go: () => navigation.navigate('Parties') },
    { label: 'Items',     go: () => navigation.navigate('Items') },
    showReports(org) && { label: 'Reports', go: () => navigation.navigate('Reports') },
    showStock(org)   && { label: 'Stock',   go: () => navigation.navigate('Stock') },
  ].filter(Boolean);

  const rows = tiles.reduce((acc, t, i) => {
    if (i % 2 === 0) acc.push([t]); else acc[acc.length - 1].push(t);
    return acc;
  }, []);

  const trialLeft = org?.trial_ends_at && org?.plan === 'trial'
    ? Math.ceil((new Date(org.trial_ends_at) - new Date()) / 86400000) : null;

  return (
    <View style={S.screen}>
      <Bar>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text numberOfLines={1} style={S.barName}>{org?.name}</Text>
          <Text style={S.barSub}>{estimate ? 'Estimates' : 'GST billing'}</Text>
        </View>
        <MoreButton navigation={navigation} />
      </Bar>

      <ScrollView contentContainerStyle={{ padding: 12, paddingBottom: 30 }}>
        {pending > 0 && (
          <TouchableOpacity onPress={pushNow} disabled={sending}
            style={{ backgroundColor: C.flagSoft, borderWidth: 1, borderColor: C.flagLine,
                     borderRadius: 12, padding: 12, marginBottom: 12 }}>
            <Text style={{ fontSize: 13.5, fontWeight: '700', color: C.flagInk }}>
              {pending} bill{pending === 1 ? '' : 's'} waiting on this phone
            </Text>
            <Text style={{ fontSize: 12, color: C.flagInk, marginTop: 3 }}>
              {sending ? 'Sending…' : 'Written with no internet. Tap to send them now.'}
            </Text>
          </TouchableOpacity>
        )}

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

        <TouchableOpacity style={S.card} onPress={() => navigation.navigate('Bills')}>
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
          <Text style={{ fontSize: 12, fontWeight: '600', color: C.accent, marginTop: 8 }}>
            See all bills ›
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          onPress={() => navigation.navigate('Bill', { vtype: 'sale' })}
          style={[S.btn, { paddingVertical: 26, borderRadius: 12, marginBottom: 12 }]}>
          <Text style={{ fontSize: 22, fontWeight: '700', color: '#fff' }}>
            {estimate ? 'New estimate' : 'New bill'}
          </Text>
        </TouchableOpacity>

        {rows.map((row, i) => (
          <View key={i} style={[S.row, { marginBottom: 10 }]}>
            {row.map((t) => <Tile key={t.label} label={t.label} onPress={t.go} />)}
            {row.length === 1 && <View style={{ flex: 1 }} />}
          </View>
        ))}

      </ScrollView>
    </View>
  );
}
