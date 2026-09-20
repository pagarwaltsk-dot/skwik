import React, { useRef, useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, Alert, ScrollView, Platform,
} from 'react-native';
import { supabase, phoneToEmail } from '../lib/supabase';
import { Box, Screen } from '../components/Chrome';
import { C, S } from '../theme';

// THE FIRST SCREEN. A name, a number, a password, and in.
export default function WelcomeScreen({ navigation }) {
  const [phone, setPhone] = useState('');
  const fPhone = useRef(null), fPw = useRef(null);
  const [pw, setPw]       = useState('');
  const [busy, setBusy]   = useState(false);

  const login = async () => {
    const p = phone.replace(/\D/g, '');
    if (p.length < 10) return Alert.alert('Check the number', 'Type your 10 digit mobile number.');
    if (!pw)           return Alert.alert('Password', 'Type your password.');

    setBusy(true);
    // The number stands in for an email address behind the scenes. But saving
    // a recovery email under Settings REPLACES that address on the account,
    // and then the made-up one matches nothing — which used to lock the
    // shopkeeper out of his own shop with the right password in his hand.
    // So: try the made-up address, and if the account has moved on, ask the
    // database which address that number belongs to now and try that.
    let { error } = await supabase.auth.signInWithPassword({
      email: phoneToEmail(p), password: pw,
    });

    if (error && /invalid/i.test(error.message)) {
      try {
        const { data: real } = await supabase.rpc('login_email_for_phone', { p_phone: p });
        if (real && real !== phoneToEmail(p)) {
          const second = await supabase.auth.signInWithPassword({ email: real, password: pw });
          error = second.error || null;
        }
      } catch (_) { /* offline, or an older database: leave the first answer */ }
    }

    setBusy(false);
    if (error) {
      Alert.alert('Could not log in',
        /invalid/i.test(error.message)
          ? 'That number and password do not match. Check both, or register a new shop.'
          : error.message);
    }
  };

  return (
    <Screen>
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
          <Box ref={fPhone} next={fPw} style={S.num} keyboardType="number-pad" maxLength={10}
            placeholder="98640 12345"
            value={phone} onChangeText={setPhone} />

          <View style={{ height: 12 }} />

          <Text style={S.label}>Password</Text>
          <Box ref={fPw} onSubmit={login} secureTextEntry placeholder="Your password"
            value={pw} onChangeText={setPw} />

          <TouchableOpacity style={[S.btn, { marginTop: 18 }, busy && { backgroundColor: C.faint }]}
            onPress={login} disabled={busy}>
            <Text style={S.btnText}>{busy ? 'Please wait…' : 'Log in'}</Text>
          </TouchableOpacity>
        </View>

        {/* There was no way to reset a password from anywhere in the app: the
            screen that could do it was never put in the navigator. */}
        <TouchableOpacity onPress={() => navigation.navigate('Forgot')}
          style={{ alignItems: 'center', marginTop: 16, paddingVertical: 8 }}>
          <Text style={{ fontSize: 14, fontWeight: '700', color: C.muted }}>
            Forgotten your password?
          </Text>
        </TouchableOpacity>

        <View style={{ alignItems: 'center', marginTop: 10 }}>
          <Text style={{ fontSize: 13.5, color: C.muted }}>New to Skwik?</Text>
          <TouchableOpacity onPress={() => navigation.navigate('Register')}
            style={{ paddingVertical: 12, paddingHorizontal: 20 }}>
            <Text style={{ fontSize: 16, fontWeight: '700', color: C.accent }}>Register your shop</Text>
          </TouchableOpacity>
        </View>

      </ScrollView>
    </Screen>
  );
}
