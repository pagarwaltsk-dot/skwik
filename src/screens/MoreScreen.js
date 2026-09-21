import React from 'react';
import { View, Text, TouchableOpacity, ScrollView, Alert } from 'react-native';
import { supabase } from '../lib/supabase';
import { sayPlainly, forgetLocal } from '../lib/offline';
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

  // CLOSING AN ACCOUNT FOR GOOD.
  //
  // There was no way to do this. "Wipe the books" emptied the ledgers and left
  // the login, the phone number, the shop name, the address and the GST number
  // exactly where they were — which is not deletion, and the Play Store does
  // not list an app that has no way to delete an account.
  //
  // He is warned about section 36 first, because a shopkeeper who closes his
  // account has destroyed records the law says he must keep for seventy-two
  // months from the due date of his annual return, and only he can decide
  // whether he has them elsewhere. The owner is sent to Import & export to
  // take a copy before he is allowed to go on.
  const closeAccount = () => {
    Alert.alert(
      'Close your Skwik account?',
      (isOwner
        ? 'Your shop, every bill, every customer and every entry in it are '
          + 'deleted. Nothing is kept anywhere and nobody can get it back — '
          + 'not you, not us.\n\n'
        : 'Your login is deleted. The shop and its books stay with the owner.\n\n')
      + 'The GST law (section 36) says you must keep your records for 72 '
      + 'months from the due date of your annual return. Take a copy under '
      + 'Import & export first if you do not have one.',
      [{ text: 'Keep my account' },
       { text: isOwner ? 'Take a copy first' : ' ',
         onPress: isOwner ? () => navigation.navigate('Transfer') : undefined },
       { text: 'Close it for good', style: 'destructive', onPress: confirmClose }]
        .filter((b) => b.text.trim()));
  };

  const confirmClose = () => {
    Alert.alert('Last check',
      'This cannot be undone. Tap "Yes, close it" and your account is gone.',
      [{ text: 'Cancel' },
       { text: 'Yes, close it', style: 'destructive', onPress: doClose }]);
  };

  const doClose = async () => {
    try {
      const { error } = await supabase.rpc('delete_my_account', { p_confirm: 'DELETE' });
      if (error) throw error;
      // An account that has been deleted must not leave its items, its
      // customers and its firm row sitting in the phone's own storage.
      await forgetLocal();
      Alert.alert('Closed', 'Your Skwik account has been deleted.');
      await signOut();
    } catch (e) {
      Alert.alert('Could not close it', sayPlainly(e));
    }
  };

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
        <Item label="Ledgers — every account" onPress={() => navigation.navigate('Ledgers')} />
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
        <Item label="Close my Skwik account" onPress={closeAccount} />
      </View>

      <Text style={{ fontSize: 11.5, color: C.muted, marginTop: 10, lineHeight: 17 }}>
        Closing your account removes your login from Skwik for good.
        {isOwner ? ' Your shop and every bill in it go with it.' : ''}
      </Text>

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
