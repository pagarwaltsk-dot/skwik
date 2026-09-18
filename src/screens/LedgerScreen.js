import React, { useCallback, useState } from 'react';
import { View, Text, TouchableOpacity, ScrollView } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';

import { supabase } from '../lib/supabase';
import { useApp } from '../AppContext';
import { fmt0, n2 } from '../lib/money';
import { ledgerHtml } from '../lib/invoice';
import { C, S } from '../theme';

export default function LedgerScreen({ route, navigation }) {
  const partyId = route.params?.partyId;
  const { org } = useApp();
  const [party, setParty] = useState(null);
  const [data, setData]   = useState({ rows: [], opening: 0, opening_type: 'owes_you' });

  useFocusEffect(useCallback(() => {
    (async () => {
      const [{ data: p }, { data: led }] = await Promise.all([
        supabase.from('parties').select('*').eq('id', partyId).maybeSingle(),
        supabase.rpc('party_ledger', { p_party: partyId }),
      ]);
      setParty(p);
      if (led) setData(led);
    })();
  }, [partyId]));

  const rows = data.rows || [];
  const open = Number(data.opening || 0);
  const left  = rows.filter((r) => r.side === 'left');
  const right = rows.filter((r) => r.side === 'right');
  if (open > 0) (data.opening_type === 'you_owe' ? right : left)
    .unshift({ d: party?.opening_date || '', label: 'Opening', amt: open });

  const sum = (a) => a.reduce((s, r) => s + Number(r.amt || 0), 0);
  const balance = n2(sum(left) - sum(right));
  const owes = balance >= 0;

  const share = async () => {
    const html = ledgerHtml({ org, party, rows, opening: open,
                              openingType: data.opening_type, balance });
    const { uri } = await Print.printToFileAsync({ html });
    await Sharing.shareAsync(uri, { mimeType: 'application/pdf', dialogTitle: 'Send account' });
  };

  const Col = ({ list, right: alignRight }) => (
    <View style={{ flex: 1, paddingHorizontal: 10,
                   borderRightWidth: alignRight ? 0 : 1.5, borderRightColor: C.line }}>
      {list.length === 0 && <Text style={{ color: C.faint }}>—</Text>}
      {list.map((r, i) => (
        <View key={i} style={{ marginBottom: 14, alignItems: alignRight ? 'flex-end' : 'flex-start' }}>
          <Text style={{ fontSize: 11.5, fontWeight: '600', color: C.muted }}>
            {String(r.d).slice(8, 10)}/{String(r.d).slice(5, 7)} · {r.label}
          </Text>
          <Text style={[{ fontSize: 17, fontWeight: '800',
                          color: alignRight ? C.greenD : C.ink }, S.num]}>{fmt0(r.amt)}</Text>
        </View>
      ))}
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
        <Text style={S.h1}>{party?.name || ''}</Text>
      </View>

      <View style={{ margin: 16, padding: 15, borderRadius: 18, borderWidth: 1.5,
                     backgroundColor: owes ? C.redL : C.greenL,
                     borderColor: owes ? '#F0D2CA' : '#C6E4D3' }}>
        <Text style={[S.label, { color: owes ? C.red : C.greenD }]}>
          {owes ? `${(party?.name || '').toUpperCase()} OWES YOU` : `YOU OWE ${(party?.name || '').toUpperCase()}`}
        </Text>
        <Text style={[{ fontSize: 36, fontWeight: '800', marginTop: 2,
                        color: owes ? C.red : C.greenD }, S.num]}>
          ₹ {fmt0(Math.abs(balance))}
        </Text>
      </View>

      {!!party && (
        <View style={[S.row, { marginHorizontal: 16, marginBottom: 14 }]}>
          <Text style={[S.label, { marginRight: 10 }]}>PRICE LIST</Text>
          {[1, 2].map((n) => {
            const on = (Number(party.price_list) === 2 ? 2 : 1) === n;
            const nm = n === 1 ? (org?.price1_name || 'Wholesale') : (org?.price2_name || 'Retail');
            return (
              <TouchableOpacity key={n}
                onPress={async () => {
                  const { error } = await supabase.from('parties')
                    .update({ price_list: n }).eq('id', party.id);
                  if (!error) setParty((p) => ({ ...p, price_list: n }));
                }}
                style={{ flex: 1, paddingVertical: 7, marginLeft: 6, borderRadius: 9,
                         alignItems: 'center', borderWidth: 1.5,
                         borderColor: on ? C.green : C.greyB,
                         backgroundColor: on ? C.greenL : C.card }}>
                <Text style={{ fontSize: 12.5, fontWeight: '800', color: on ? C.greenD : C.muted }}>
                  {nm}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>
      )}

      <View style={[S.row, { marginHorizontal: 16, borderBottomWidth: 2,
                             borderBottomColor: C.ink, paddingBottom: 8 }]}>
        <Text style={[S.label, { flex: 1 }]}>SALES & GOODS GIVEN</Text>
        <Text style={[S.label, { flex: 1, textAlign: 'right' }]}>RECEIVED & RETURNS</Text>
      </View>

      <ScrollView contentContainerStyle={{ paddingHorizontal: 6, paddingTop: 14 }}>
        <View style={{ flexDirection: 'row' }}>
          <Col list={left} />
          <Col list={right} right />
        </View>
      </ScrollView>

      <View style={[S.row, { marginHorizontal: 16, borderTopWidth: 2,
                             borderTopColor: C.ink, paddingVertical: 10 }]}>
        <Text style={[{ flex: 1, fontSize: 18, fontWeight: '800', color: C.ink }, S.num]}>
          {fmt0(sum(left))}
        </Text>
        <Text style={[{ flex: 1, fontSize: 18, fontWeight: '800', color: C.ink, textAlign: 'right' }, S.num]}>
          {fmt0(sum(right))}
        </Text>
      </View>

      <View style={{ padding: 16, paddingBottom: 26 }}>
        <TouchableOpacity style={S.btn} onPress={share}>
          <Text style={S.btnText}>SEND THIS ACCOUNT</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}
