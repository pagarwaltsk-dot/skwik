import React, { useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, Alert, KeyboardAvoidingView, Platform } from 'react-native';
import { sayPlainly } from '../lib/offline';
import { supabase, phoneToEmail } from '../lib/supabase';
import { C, S } from '../theme';

export default function LoginScreen() {
  const [phone, setPhone] = useState('');
  const [pin, setPin]     = useState('');
  const [busy, setBusy]   = useState(false);
  const [isNew, setIsNew] = useState(false);

  const go = async () => {
    const p = phone.replace(/\D/g, '');
    if (p.length < 10)  return Alert.alert('Check the number', 'Type your 10 digit mobile number.');
    if (pin.length < 6) return Alert.alert('Password too short', 'Use at least 6 characters.');

    setBusy(true);
    const creds = { email: phoneToEmail(p), password: pin };
    const { error } = isNew
      ? await supabase.auth.signUp(creds)
      : await supabase.auth.signInWithPassword(creds);
    setBusy(false);

    if (error) {
      Alert.alert(isNew ? 'Could not create account' : 'Could not log in',
        sayPlainly(error));
      return;
    }
    if (isNew) {
      const { error: e2 } = await supabase.from('profiles')
        .upsert({ id: (await supabase.auth.getUser()).data.user.id, phone: p });
      if (e2) Alert.alert('Note', e2.message);
    }
  };

  return (
    <KeyboardAvoidingView style={S.screen} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={{ flex: 1, justifyContent: 'center', paddingHorizontal: 24 }}>
        <Text style={{ fontSize: 40, fontWeight: '800', color: C.ink, letterSpacing: -1 }}>Skwik</Text>
        <Text style={{ fontSize: 15, fontWeight: '600', color: C.muted, marginTop: 6, marginBottom: 28 }}>
          {isNew ? 'Make a new account for your shop' : 'Billing that keeps up with you'}
        </Text>

        <Text style={S.label}>MOBILE NUMBER</Text>
        <TextInput
          style={[S.input, { marginTop: 6, marginBottom: 16 }]}
          keyboardType="number-pad" maxLength={10} placeholder="98640 12345"
          value={phone} onChangeText={setPhone} />

        <Text style={S.label}>PASSWORD</Text>
        <TextInput
          style={[S.input, { marginTop: 6, marginBottom: 24 }]}
          secureTextEntry placeholder="At least 6 characters"
          value={pin} onChangeText={setPin} />

        <TouchableOpacity style={[S.btn, busy && { opacity: 0.6 }]} onPress={go} disabled={busy}>
          <Text style={S.btnText}>{busy ? 'Please wait…' : isNew ? 'CREATE ACCOUNT' : 'LOG IN'}</Text>
        </TouchableOpacity>

        <TouchableOpacity onPress={() => setIsNew(!isNew)} style={{ marginTop: 20, alignItems: 'center' }}>
          <Text style={{ fontSize: 15, fontWeight: '700', color: C.green }}>
            {isNew ? 'I already have an account' : 'New here? Create an account'}
          </Text>
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}
