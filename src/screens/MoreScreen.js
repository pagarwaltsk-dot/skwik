import React from 'react';
import { View, Text, TouchableOpacity, ScrollView, Alert } from 'react-native';
import { useApp } from '../AppContext';
import { C, S } from '../theme';

export default function MoreScreen({ navigation }) {
  const { org, signOut } = useApp();

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
    <ScrollView style={S.screen} contentContainerStyle={{ padding: 16, paddingTop: 50 }}>
      <View style={S.row}>
        <TouchableOpacity onPress={() => navigation.goBack()}>
          <Text style={{ fontSize: 26, color: C.ink }}>‹</Text>
        </TouchableOpacity>
        <Text style={S.h1}>More</Text>
      </View>

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

      <View style={{ marginTop: 10 }}>
        <Item label="Settings"              onPress={() => navigation.navigate('Settings')} />
        <Item label="Items"                 onPress={() => navigation.navigate('Items')} />
        <Item label="Customers & suppliers" onPress={() => navigation.navigate('Parties')} />
        {!!org?.stock_enabled &&
          <Item label="Stock in hand"       onPress={() => navigation.navigate('Stock')} />}
        <Item label="Log out" onPress={() =>
          Alert.alert('Log out?', 'You will need your number and password again.',
            [{ text: 'Cancel' }, { text: 'Log out', onPress: signOut }])} />
      </View>
    </ScrollView>
  );
}
