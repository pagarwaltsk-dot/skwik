import React, { useCallback, useState } from 'react';
import { View, Text, TouchableOpacity, ScrollView, Alert } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';

import { supabase } from '../lib/supabase';
import { sayPlainly } from '../lib/offline';
import { useApp } from '../AppContext';
import { fmt0, n2 } from '../lib/money';
import { invoiceHtml, ledgerHtml } from '../lib/invoice';
import { thermalHtml } from '../lib/receipt';
import { Head, Screen } from '../components/Chrome';
import { C, S } from '../theme';

export default function LedgerScreen({ route, navigation }) {
  const partyId = route.params?.partyId;
  const { org } = useApp();
  const [party, setParty] = useState(null);
  const [data, setData]   = useState({ rows: [], opening: 0, opening_type: 'owes_you' });
  // An account that could not be fetched must never be drawn as zero. A
  // shopkeeper standing at the counter reading "owes you ₹0" acts on it.
  const [failed, setFailed] = useState(false);
  const [making, setMaking] = useState(null);   // which bill's PDF is being built

  useFocusEffect(useCallback(() => {
    let on = true;
    (async () => {
      try {
        const [{ data: p, error: pe }, { data: led, error: le }] = await Promise.all([
          supabase.from('parties').select('*').eq('id', partyId).maybeSingle(),
          supabase.rpc('party_ledger', { p_party: partyId }),
        ]);
        if (!on) return;
        if (pe || le || !led) { setFailed(true); return; }
        setParty(p);
        setData(led);
        setFailed(false);
      } catch (e) { if (on) setFailed(true); }
    })();
    return () => { on = false; };
  }, [partyId]));

  const rows = data.rows || [];
  const open = Number(data.opening || 0);

  // NEWEST AT THE TOP.
  //
  // A shopkeeper opening an account wants the bill he raised this morning,
  // not the one from April. The opening balance is the oldest thing there is,
  // so it goes to the FOOT of its column rather than the head of it.
  const byNewest = (a, b) => String(b.d || '').localeCompare(String(a.d || ''));
  const left  = rows.filter((r) => r.side === 'left').sort(byNewest);
  const right = rows.filter((r) => r.side === 'right').sort(byNewest);
  if (open > 0) (data.opening_type === 'you_owe' ? right : left)
    .push({ d: party?.opening_date || '', label: 'Opening', amt: open });

  const sum = (a) => a.reduce((s, r) => s + Number(r.amt || 0), 0);
  const balance = n2(sum(left) - sum(right));
  const owes = balance >= 0;

  const share = async () => {
    try {
      if (!party) {
        return Alert.alert('Not loaded yet', 'This account has not come down from the '
          + 'server yet. Check your internet and open it again.');
      }
      const html = ledgerHtml({ org, party, rows, opening: open,
                                openingType: data.opening_type, balance });
      const { uri } = await Print.printToFileAsync({ html });
      if (!(await Sharing.isAvailableAsync())) {
        return Alert.alert('Nothing to share with',
          'This phone has no app set up to receive the file.');
      }
      await Sharing.shareAsync(uri, { mimeType: 'application/pdf', dialogTitle: 'Send account' });
    } catch (e) {
      Alert.alert('Could not send', sayPlainly(e));
    }
  };

  // EVERY LINE GOES SOMEWHERE.
  //
  // A ledger that only shows numbers leaves the question "which bill was
  // that?" unanswered, and answering it meant going to Past bills and hunting
  // by date. Each entry now opens the thing it came from.
  const openRow = (r) => {
    if (r.kind === 'voucher' && r.id) {
      if (r.vtype === 'sale_return' || r.vtype === 'purchase_return') {
        return navigation.navigate('Bills');       // notes are read, not edited
      }
      return navigation.navigate('Bill', { voucherId: r.id, vtype: r.vtype });
    }
    if (r.kind === 'payment') {
      return navigation.navigate('Money',
        { ptype: r.ptype || 'receipt', paymentId: r.id });
    }
  };

  // THE BILL ITSELF, FROM THE ACCOUNT.
  //
  // A customer ringing up about a figure on his statement wants that bill, not
  // a tour of the app. This fetches it and hands over the PDF then and there.
  //
  // It is built from the bill as it stands RIGHT NOW, every time — nothing is
  // kept or cached anywhere. So a bill corrected this morning produces a
  // corrected PDF this afternoon, and an old copy can never be sent by
  // accident.
  const pdfOf = async (r) => {
    if (r.kind !== 'voucher' || !r.id) return;
    setMaking(r.id);
    try {
      const [{ data: v, error: ve }, { data: ls, error: le }] = await Promise.all([
        supabase.from('vouchers').select('*').eq('id', r.id).maybeSingle(),
        supabase.from('voucher_lines').select('*').eq('voucher_id', r.id).order('line_no'),
      ]);
      if (ve || le || !v) throw (ve || le || new Error('That bill could not be read'));

      const paper = String(org?.print_width || 'a4');
      const html = paper === 'a4'
        ? invoiceHtml({ org, voucher: v, party, lines: ls || [] })
        : thermalHtml({ org, voucher: v, party, lines: ls || [], width: paper });

      const { uri } = await Print.printToFileAsync({ html });
      if (!(await Sharing.isAvailableAsync())) {
        return Alert.alert('Nothing to share with',
          'This phone has no app set up to receive files.');
      }
      await Sharing.shareAsync(uri, { mimeType: 'application/pdf',
                                      dialogTitle: r.label || 'Bill' });
    } catch (e) {
      Alert.alert('Could not make the PDF', sayPlainly(e));
    } finally { setMaking(null); }
  };

  const Col = ({ list, right: alignRight }) => (
    <View style={{ flex: 1, paddingHorizontal: 10,
                   borderRightWidth: alignRight ? 0 : 1.5, borderRightColor: C.line }}>
      {list.length === 0 && <Text style={{ color: C.faint }}>—</Text>}
      {list.map((r, i) => {
        const goes = !!r.id;
        return (
          <TouchableOpacity key={i} disabled={!goes} onPress={() => openRow(r)}
            style={{ marginBottom: 14, alignItems: alignRight ? 'flex-end' : 'flex-start' }}>
            <Text style={{ fontSize: 11.5, fontWeight: '600', color: C.muted }}>
              {String(r.d).slice(8, 10)}/{String(r.d).slice(5, 7)} · {r.label}
            </Text>
            <Text style={[{ fontSize: 17, fontWeight: '800',
                            color: alignRight ? C.greenD : C.ink },
                          goes && { textDecorationLine: 'underline',
                                    textDecorationColor: C.greyB },
                          S.num]}>
              {fmt0(r.amt)}
            </Text>
            {r.kind === 'voucher' && !!r.id && (
              <TouchableOpacity onPress={() => pdfOf(r)} disabled={making === r.id}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                style={{ marginTop: 3 }}>
                <Text style={{ fontSize: 11, fontWeight: '700',
                               color: making === r.id ? C.faint : C.accent }}>
                  {making === r.id ? 'making…' : 'PDF ↓'}
                </Text>
              </TouchableOpacity>
            )}
          </TouchableOpacity>
        );
      })}
    </View>
  );

  return (
    <Screen>
      <Head navigation={navigation} title={party?.name || ''} />

      {failed ? (
        <View style={{ margin: 12, padding: 12, backgroundColor: C.flagSoft,
                       borderWidth: 1, borderColor: C.flagLine, borderRadius: 12 }}>
          <Text style={{ fontSize: 13.5, fontWeight: '700', color: C.flagInk }}>
            This account could not be loaded
          </Text>
          <Text style={{ fontSize: 12, color: C.flagInk, marginTop: 3, lineHeight: 17 }}>
            What you see below is not his balance. Check your internet and open it again.
          </Text>
        </View>
      ) : (
        <Text style={{ fontSize: 12, color: C.muted, textAlign: 'center', marginTop: 10 }}>
          Tap any amount to open the bill or the entry behind it.
        </Text>
      )}

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

      {/* The price list a customer is on belongs on his record, under
          Customers, where it is set once and deliberately. A statement of
          account is for reading what he owes — not for changing how he is
          charged, which a stray tap here did silently to every future bill. */}

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
    </Screen>
  );
}
