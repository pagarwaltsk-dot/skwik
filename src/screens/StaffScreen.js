import React, { useCallback, useState } from 'react';
import { View, Text, TouchableOpacity, ScrollView, Alert, Share } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';

import { supabase } from '../lib/supabase';
import { useApp } from '../AppContext';
import { sayPlainly } from '../lib/offline';
import { Head, Screen } from '../components/Chrome';
import { C, S } from '../theme';

// THE MAN AT THE COUNTER.
//
// One login per shop meant handing the counter boy the owner's password, and
// with it the purchase prices, every customer's balance and the power to
// delete a bill. So: the shop has a code. He makes his own login, types the
// code once, and he can bill and take money. Nothing else.
//
// This is the thing shopkeepers complain about most in the apps they might
// buy instead, where a second person means a second licence.

export default function StaffScreen({ navigation }) {
  const { org, reloadOrg, isOwner } = useApp();
  const [list, setList] = useState([]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const { data } = await supabase.rpc('staff_list');
    setList(Array.isArray(data) ? data : []);
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const code = org?.join_code || '';

  const share = () => Share.share({
    message: `To bill for ${org?.name}:\n\n`
      + `1. Install Skwik\n`
      + `2. Make an account with your own mobile number\n`
      + `3. On the shop screen, tap "I work at a shop" and type this code:\n\n`
      + `${code}\n\nDo not give this code to anyone else.`,
  }).catch(() => {});

  const reset = () => Alert.alert('New code?',
    'The old one stops working straight away. Anyone who has already joined stays.',
    [{ text: 'Keep it' },
     { text: 'New code', onPress: async () => {
         setBusy(true);
         const { error } = await supabase.rpc('reset_join_code');
         setBusy(false);
         if (error) return Alert.alert('Could not change it', sayPlainly(error));
         await reloadOrg();
       } }]);

  const remove = (p) => Alert.alert('Remove him?',
    `${p.phone || 'This person'} will not be able to open your shop again. `
    + 'Bills he has already written stay exactly as they are.',
    [{ text: 'Keep him' },
     { text: 'Remove', style: 'destructive', onPress: async () => {
         const { error } = await supabase.rpc('remove_staff', { p_id: p.id });
         if (error) return Alert.alert('Could not remove', sayPlainly(error));
         load();
       } }]);

  if (!isOwner) {
    return (
      <Screen>
        <Head navigation={navigation} title="Your shop" />
        <View style={{ padding: 20 }}>
          <Text style={{ fontSize: 16, fontWeight: '700', color: C.ink }}>
            You bill for {org?.name}
          </Text>
          <Text style={{ fontSize: 13.5, color: C.muted, marginTop: 8, lineHeight: 20 }}>
            The owner decides who can open this shop. Ask him if you need
            anything changed.
          </Text>
        </View>
      </Screen>
    );
  }

  return (
    <Screen>
      <Head navigation={navigation} title="Who can bill" />
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>
        <View style={S.card}>
          <Text style={S.eyebrow}>Your shop code</Text>
          <Text style={[{ fontSize: 40, fontWeight: '800', color: C.ink,
                          letterSpacing: 6, textAlign: 'center', marginVertical: 8 }, S.num]}>
            {code || '—'}
          </Text>
          <Text style={{ fontSize: 12.5, color: C.muted, textAlign: 'center', lineHeight: 18 }}>
            Anyone with this code can join your shop and write bills. Give it to
            your own people only.
          </Text>
          <View style={[S.row, { gap: 10, marginTop: 16 }]}>
            <TouchableOpacity style={[S.btn, { flex: 1 }]} onPress={share}>
              <Text style={S.btnText}>Send it</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[S.btnGhost, { flex: 1 }]} onPress={reset} disabled={busy}>
              <Text style={S.ghostText}>New code</Text>
            </TouchableOpacity>
          </View>
        </View>

        <Text style={[S.eyebrow, { marginTop: 18 }]}>In your shop</Text>
        {list.map((p) => (
          <View key={p.id} style={[S.hit, { paddingHorizontal: 4 }]}>
            <View style={{ flex: 1 }}>
              <Text style={S.hitName}>
                {p.phone || '—'}{p.me ? '  (you)' : ''}
              </Text>
              <Text style={S.hitSub}>
                {p.role === 'owner' ? 'Owner — everything' : 'Counter — bills and money only'}
              </Text>
            </View>
            {p.role !== 'owner' && !p.me && (
              <TouchableOpacity onPress={() => remove(p)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                <Text style={{ fontSize: 13, fontWeight: '800', color: C.danger }}>REMOVE</Text>
              </TouchableOpacity>
            )}
          </View>
        ))}

        <View style={{ marginTop: 22, padding: 14, backgroundColor: C.soft, borderRadius: 14 }}>
          <Text style={{ fontSize: 13.5, fontWeight: '800', color: C.ink }}>
            What the counter can and cannot do
          </Text>
          <Text style={{ fontSize: 12.5, color: C.muted, marginTop: 6, lineHeight: 19 }}>
            He can write bills, take money and add a customer or an item.{'\n'}
            He cannot remove a bill, change your settings, see what you paid for
            your goods, or look at the reports.
          </Text>
        </View>
      </ScrollView>
    </Screen>
  );
}
