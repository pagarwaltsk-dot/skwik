import React, { useCallback, useMemo, useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, FlatList, Alert, Linking } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';

import { supabase } from '../lib/supabase';
import { useApp } from '../AppContext';
import { fmt0 } from '../lib/money';
import { sayPlainly } from '../lib/offline';
import { Head, Screen, Sections } from '../components/Chrome';
import { C, S } from '../theme';

// WHO OWES YOU, AND ASKING THEM.
//
// The money a shop is owed is its biggest number and the one nobody keeps
// properly. Skwik already knows it — every bill and every rupee taken is in
// there — so this is only a list, sorted by who owes most, with a message
// already written for each of them.
//
// The asking is the point. A reminder that takes one tap gets sent; one that
// needs typing does not.

const dmy = (d) => (d ? `${String(d).slice(8, 10)}/${String(d).slice(5, 7)}/${String(d).slice(2, 4)}` : '');

// WHEN SOMETHING HAPPENED, AS A WHOLE PHRASE.
//
// This used to hand back a word and the screen bolted " ago" onto it, which
// read as "paid today ago" and "Last bill yesterday ago". Today and yesterday
// are not lengths of time. The phrase is built here, once, and comes out
// finished.
const whenWas = (d) => {
  if (!d) return null;
  const days = Math.floor((new Date() - new Date(d)) / 86400000);
  if (days <= 0)  return 'today';
  if (days === 1) return 'yesterday';
  if (days < 31)  return `${days} days ago`;
  const m = Math.floor(days / 30);
  return m === 1 ? 'a month ago' : `${m} months ago`;
};

export default function UdharScreen({ navigation }) {
  const { org, isOwner } = useApp();
  const [rows, setRows] = useState([]);
  const [q, setQ]       = useState('');
  const [side, setSide] = useState('owes_you');
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    const { data, error } = await supabase.rpc('outstanding');
    if (error || !Array.isArray(data)) { setFailed(true); return; }
    setRows(data); setFailed(false);
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const list = useMemo(() => {
    const want = side === 'owes_you' ? 1 : -1;
    return rows
      .filter((r) => Math.sign(Number(r.balance)) === want)
      .filter((r) => !q.trim() || r.name.toLowerCase().includes(q.trim().toLowerCase()));
  }, [rows, q, side]);

  const total = list.reduce((t, r) => t + Math.abs(Number(r.balance || 0)), 0);

  const ask = (r) => {
    const amt = Math.abs(Number(r.balance));
    const msg = `Namaste ${r.name},\n\n`
      + `₹${fmt0(amt)} is outstanding against your account`
      + (r.last_bill ? ` (last bill ${dmy(r.last_bill)})` : '') + '.\n\n'
      + 'Kindly arrange the payment.\n\n'
      + `${org?.name || ''}${org?.phone ? `\n${org.phone}` : ''}`;

    const phone = String(r.phone || '').replace(/\D/g, '').slice(-10);
    const url = phone
      ? `whatsapp://send?phone=91${phone}&text=${encodeURIComponent(msg)}`
      : `whatsapp://send?text=${encodeURIComponent(msg)}`;

    Linking.openURL(url).catch(() =>
      Linking.openURL(`https://wa.me/${phone ? '91' + phone : ''}?text=${encodeURIComponent(msg)}`)
        .catch(() => Alert.alert('No WhatsApp', 'WhatsApp is not installed on this phone.')));
  };

  const [queue, setQueue] = useState(null);
  const [at, setAt] = useState(0);

  const askAll = () => {
    const withPhone = list.filter((r) => String(r.phone || '').replace(/\D/g, '').length >= 10);
    if (!withPhone.length) {
      return Alert.alert('No numbers', 'None of these customers has a phone number saved. '
        + 'Add it under Customers and the reminder can go straight to him.');
    }
    // IT SAID "ONCE FOR EACH" AND OPENED ONCE.
    //
    // This called ask(withPhone[0]) and stopped. He read "Ask 14 of them?",
    // pressed Start, sent one message and came back to a screen that had
    // forgotten where it was — believing he had reminded fourteen customers
    // when he had reminded one. It walks the list now and says where he is.
    Alert.alert(`Ask ${withPhone.length} of them?`,
      'WhatsApp opens for the first one, with the message already written. '
      + 'Send it, come back, and Skwik will offer you the next.',
      [{ text: 'Not now' },
       { text: 'Start', onPress: () => { setQueue(withPhone); askFrom(withPhone, 0); } }]);
  };

  // The queue holds the customers as they were when he pressed Start. Coming
  // back from WhatsApp reloads the list underneath, which is right — but the
  // queue must not be thrown away by that reload, or he would be back to
  // sending exactly one.
  // One at a time, and after each one he is told how many are left.
  const askFrom = (arr, i) => {
    if (i >= arr.length) {
      setQueue(null);
      return Alert.alert('That is all of them', `${arr.length} reminder${arr.length === 1 ? '' : 's'} sent.`);
    }
    ask(arr[i]);
    setAt(i);
  };

  const askNext = () => {
    if (!queue) return;
    askFrom(queue, at + 1);
  };

  return (
    <Screen>
      <Head navigation={navigation} title="Udhar" />
      <Sections navigation={navigation} org={org} isOwner={isOwner} id="udhar" />

      <View style={{ backgroundColor: C.surface, paddingHorizontal: 12, paddingVertical: 8,
                     borderBottomWidth: 1, borderBottomColor: C.line }}>
        <View style={[S.row, { gap: 6 }]}>
          {[['owes_you', 'They owe you'], ['you_owe', 'You owe them']].map(([k, label]) => {
            const on = side === k;
            return (
              <TouchableOpacity key={k} onPress={() => setSide(k)}
                style={{ flex: 1, paddingVertical: 9, borderRadius: 9, alignItems: 'center',
                         borderWidth: 1, borderColor: on ? C.accent : C.line,
                         backgroundColor: on ? C.accentSoft : C.surface }}>
                <Text style={{ fontSize: 13, fontWeight: '700', color: on ? C.accent : C.muted }}>
                  {label}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>
        <TextInput style={[S.input, { marginTop: 8 }]} placeholder="Search a name"
          placeholderTextColor={C.faint} value={q} onChangeText={setQ} returnKeyType="search" />
      </View>

      <View style={{ paddingHorizontal: 14, paddingTop: 12 }}>
        <Text style={S.eyebrow}>{side === 'owes_you' ? 'Owed to you' : 'You owe'}</Text>
        <Text style={[{ fontSize: 30, fontWeight: '800', color: C.ink }, S.num]}>
          ₹{fmt0(total)}
        </Text>
        <Text style={{ fontSize: 12.5, color: C.muted, marginTop: 2 }}>
          {list.length} {list.length === 1 ? 'name' : 'names'}
        </Text>
      </View>

      {failed && (
        <View style={{ margin: 12, padding: 12, backgroundColor: C.flagSoft,
                       borderWidth: 1, borderColor: C.flagLine, borderRadius: 12 }}>
          <Text style={{ fontSize: 13, fontWeight: '700', color: C.flagInk }}>
            This list could not be loaded — check your internet.
          </Text>
        </View>
      )}

      <FlatList
        data={list}
        keyExtractor={(r) => r.id}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingTop: 10, paddingBottom: 30 }}
        renderItem={({ item: r }) => (
          <View style={[S.hit, { paddingHorizontal: 14 }]}>
            <TouchableOpacity style={{ flex: 1 }}
              onPress={() => navigation.navigate('Ledger', { partyId: r.id })}>
              <Text style={S.hitName}>{r.name}</Text>
              <Text style={S.hitSub}>
                {r.last_bill ? `Last bill ${whenWas(r.last_bill)}` : 'No bills yet'}
                {r.last_paid ? ` · paid ${whenWas(r.last_paid)}` : ''}
                {!r.phone ? ' · no phone number' : ''}
              </Text>
            </TouchableOpacity>
            <Text style={[S.hitPr, S.num, { marginRight: 10 }]}>
              ₹{fmt0(Math.abs(Number(r.balance)))}
            </Text>
            {side === 'owes_you' && (
              <TouchableOpacity onPress={() => ask(r)}
                style={{ paddingHorizontal: 12, paddingVertical: 8, borderRadius: 9,
                         backgroundColor: C.wa }}>
                <Text style={{ fontSize: 12.5, fontWeight: '800', color: '#fff' }}>ASK</Text>
              </TouchableOpacity>
            )}
          </View>
        )}
        ListEmptyComponent={
          <Text style={{ fontSize: 13.5, color: C.muted, textAlign: 'center', marginTop: 30 }}>
            {side === 'owes_you' ? 'Nobody owes you anything.' : 'You owe nobody anything.'}
          </Text>
        }
        ListFooterComponent={
          side === 'owes_you' && list.length > 1 ? (
            queue ? (
              <View style={{ margin: 14 }}>
                <TouchableOpacity style={[S.btn, { backgroundColor: C.wa }]} onPress={askNext}>
                  <Text style={S.btnText}>
                    Next reminder ({at + 2} of {queue.length})
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={() => setQueue(null)}
                  style={{ paddingVertical: 12, alignItems: 'center' }}>
                  <Text style={{ fontSize: 13, fontWeight: '700', color: C.muted }}>
                    Stop here — {at + 1} sent
                  </Text>
                </TouchableOpacity>
              </View>
            ) : (
            <TouchableOpacity style={[S.btn, { margin: 14, backgroundColor: C.wa }]} onPress={askAll}>
              <Text style={S.btnText}>Ask them all, one by one</Text>
            </TouchableOpacity>
            )
          ) : null
        }
      />
    </Screen>
  );
}
