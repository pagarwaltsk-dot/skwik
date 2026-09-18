import React, { useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, Alert, ScrollView, KeyboardAvoidingView, Platform,
} from 'react-native';
import { supabase, phoneToEmail } from '../lib/supabase';
import { C, S } from '../theme';

// THE FIRST SCREEN. A name, a number, a password, and in.
export default function WelcomeScreen({ navigation }) {
  const [phone, setPhone] = useState('');
  const [pw, setPw]       = useState('');
  const [busy, setBusy]   = useState(false);

  const login = async () => {
    const p = phone.replace(/\D/g, '');
    if (p.length < 10) return Alert.alert('Check the number', 'Type your 10 digit mobile number.');
    if (!pw)           return Alert.alert('Password', 'Type your password.');

    setBusy(true);
    const { error } = await supabase.auth.signInWithPassword({
      email: phoneToEmail(p), password: pw,
    });
    setBusy(false);
    if (error) {
      Alert.alert('Could not log in',
        /invalid/i.test(error.message)
          ? 'That number and password do not match. Check both, or register a new shop.'
          : error.message);
    }
  };

  return (
    <KeyboardAvoidingView style={S.screen} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={{ flexGrow: 1, justifyContent: 'center', padding: 22 }}
                  keyboardShouldPersistTaps="handled">

        <View style={{ alignItems: 'center', marginBottom: 34 }}>
          <Text style={{ fontSize: 46, fontWeight: '700', color: C.accent, letterSpacing: -1.5 }}>
            Skwik
          </Text>
          <View style={{ width: 34, height: 3, backgroundColor: C.accent, borderRadius: 2,
                         marginTop: 10, opacity: 0.35 }} />
          <Text style={{ fontSize: 15, color: C.muted, marginTop: 14, textAlign: 'center',
                         letterSpacing: 0.3 }}>
            Smooth &amp; Quick
          </Text>
        </View>

        <View style={S.card}>
          <Text style={S.label}>Mobile number</Text>
          <TextInput style={[S.input, S.num]} keyboardType="number-pad" maxLength={10}
            placeholder="98640 12345" placeholderTextColor={C.faint}
            value={phone} onChangeText={setPhone} />

          <View style={{ height: 12 }} />

          <Text style={S.label}>Password</Text>
          <TextInput style={S.input} secureTextEntry placeholder="Your password"
            placeholderTextColor={C.faint} value={pw} onChangeText={setPw}
            onSubmitEditing={login} returnKeyType="go" />

          <TouchableOpacity style={[S.btn, { marginTop: 18 }, busy && { backgroundColor: C.faint }]}
            onPress={login} disabled={busy}>
            <Text style={S.btnText}>{busy ? 'Please wait…' : 'Log in'}</Text>
          </TouchableOpacity>
        </View>

        <View style={{ alignItems: 'center', marginTop: 10 }}>
          <Text style={{ fontSize: 13.5, color: C.muted }}>New to Skwik?</Text>
          <TouchableOpacity onPress={() => navigation.navigate('Register')}
            style={{ paddingVertical: 12, paddingHorizontal: 20 }}>
            <Text style={{ fontSize: 16, fontWeight: '700', color: C.accent }}>Register your shop</Text>
          </TouchableOpacity>
        </View>

      </ScrollView>
    </KeyboardAvoidingView>
  );
}
