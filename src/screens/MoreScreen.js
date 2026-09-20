import React from 'react';
import { View, Text, TouchableOpacity, ScrollView, Alert } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useApp } from '../AppContext';
import { showGodowns, showTransfer } from '../lib/features';
import { Head, Screen } from '../components/Chrome';
import { C, S } from '../theme';

// The version on screen is READ from app.json, never typed here. A number
// kept by hand drifts, and the one time it matters is when you are trying to
// tell whether the build on the phone is the one you just made.
import app from '../../app.json';

export default function MoreScreen({ navigation }) {
  const { org, signOut, isOwner } = useApp();
  const insets = useSafeAreaInsets();

  const scheme = !org?.is_gst_registered ? 'Not registered under GST'
    : org?.is_composition ? 'Composition scheme — bills say BILL OF SUPPLY'
    : `Regular GST · HSN ${org?.turnover_above_5cr ? '6' : '4'} digits or more`;

  const Item = ({ label, onPress }) => (
    <TouchableOpacity onPress={onPress}
      style={{ paddingVertical: 18, borderBottomWidth: 1, borderBottomColor: C.line }}>
      <Text style={{ fontSize: 17, fontWeight: '700', color: C.ink }}>{label}</Text>
    </TouchableOpacity>
  );

  return (
    <Screen>
      <Head navigation={navigation} title="Everything" more={false} />
      <ScrollView contentContainerStyle={{ padding: 16,
                    paddingBottom: Math.max(insets.bottom, 12) + 24 }}>

      <View style={{ marginTop: 20, padding: 16, backgroundColor: C.card,
                     borderRadius: 18, borderWidth: 1.5, borderColor: C.line }}>
        <Text style={{ fontSize: 18, fontWeight: '800', color: C.ink }}>{org?.name}</Text>
        <Text style={{ fontSize: 12.5, fontWeight: '600', color: C.muted, marginTop: 4 }}>
          {org?.address}
        </Text>
        <Text style={{ fontSize: 12.5, fontWeight: '700', color: C.muted, marginTop: 6 }}>
          {org?.is_gst_registered ? `GSTIN ${org.gstin}` : 'No GST number'}
          {org?.state_name ? ` · ${org.state_name} (${org.state_code})` : ''}
        </Text>
        <Text style={{ fontSize: 12.5, fontWeight: '700', color: C.green, marginTop: 6 }}>
          {scheme}
        </Text>
      </View>

      {/* WHAT IS NOT ALREADY ON THE HOME SCREEN.
          The day book carries a strip of the things a shop does every day —
          sale, purchase, receipt, payment, udhar, stock, parties, items,
          reports, money out. Repeating them here makes the app look twice as
          big as it is and gives a shopkeeper two doors to the same room. This
          list is the rest: the things touched once a month or once ever. */}
      <View style={{ marginTop: 10 }}>
        <Item label="Past bills"            onPress={() => navigation.navigate('Bills')} />
        {isOwner &&
          <Item label="Cash & bank accounts" onPress={() => navigation.navigate('Banks')} />}
        {showGodowns(org) && isOwner &&
          <Item label="Godowns"             onPress={() => navigation.navigate('Godowns')} />}
        {showTransfer(org) && isOwner &&
          <Item label="Import & export"     onPress={() => navigation.navigate('Transfer')} />}
        <Item label="Who can bill"          onPress={() => navigation.navigate('Staff')} />
        {isOwner &&
          <Item label="Settings"            onPress={() => navigation.navigate('Settings')} />}
        {isOwner &&
          <Item label="Fill a month"        onPress={() => navigation.navigate('Sample')} />}
        <Item label="Log out" onPress={() =>
          Alert.alert('Log out?', 'You will need your number and password again.',
            [{ text: 'Cancel' }, { text: 'Log out', onPress: signOut }])} />
      </View>

      <View style={{ alignItems: 'center', marginTop: 30, marginBottom: 10 }}>
        <Text style={{ fontSize: 15, fontWeight: '700', color: C.accent, letterSpacing: -0.4 }}>
          Skwik
        </Text>
        <Text style={{ fontSize: 11.5, color: C.muted, marginTop: 3 }}>Smooth & Quick</Text>
        <Text style={[{ fontSize: 10.5, color: C.muted, marginTop: 2, opacity: 0.8 }, S.num]}>
          version {app?.expo?.version || '?'} ({app?.expo?.android?.versionCode ?? '?'})
        </Text>
      </View>
      </ScrollView>
    </Screen>
  );
}
