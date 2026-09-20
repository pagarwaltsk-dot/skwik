import React, { useRef, useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, Alert, Platform } from 'react-native';
import { sayPlainly } from '../lib/offline';
import { supabase, phoneToEmail } from '../lib/supabase';
import { Box, Screen } from '../components/Chrome';
import { C, S } from '../theme';

// GETTING BACK IN.
//
// Skwik signs a shopkeeper in on his mobile number, and behind the scenes that
// number stands in for an email address. That is fine until he forgets his
// password, because there is nowhere to send a reset link — the address is not
// real, and nobody reads it.
//
// There is no clever way round that. A password can only be reset to somewhere
// the shop can actually receive, so the honest answer is to ask for a real
// email ONCE, in advance, from Settings, and use it when the day comes. A shop
// that never set one has to be reset by hand, and this screen says so rather
// than pretending a link is on its way.
export default function LoginScreen() {
  const [phone, setPhone] = useState('');
  const [pin, setPin]     = useState('');
  const [busy, setBusy]   = useState(false);
  const [isNew, setIsNew] = useState(false);
  const fPhone = useRef(null), fPin = useRef(null);
  const [forgot, setForgot] = useState(false);
  const [mail, setMail] = useState('');

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

  // Sends a reset link to the address the shop saved in Settings. Supabase
  // only sends it if that address really is on the account, and it never says
  // whether it was — which is correct, because saying so would tell a stranger
  // which addresses exist.
  const sendReset = async () => {
    const e = mail.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) {
      return Alert.alert('Check the address', 'Type the email you saved in Settings.');
    }
    setBusy(true);
    const { error } = await supabase.auth.resetPasswordForEmail(e);
    setBusy(false);
    if (error) return Alert.alert('Could not send it', sayPlainly(error));
    Alert.alert('If that address is on the account, a link is on its way',
      'Open it on this phone and it will let you set a new password.\n\n'
      + 'Nothing arrives if that email was never saved in Settings — in that '
      + 'case write to us and we will sort it out by hand.',
      [{ text: 'All right', onPress: () => setForgot(false) }]);
  };

  if (forgot) {
    return (
      <Screen>
        <View style={{ flex: 1, justifyContent: 'center', paddingHorizontal: 24 }}>
          <Text style={{ fontSize: 26, fontWeight: '800', color: C.ink, letterSpacing: -0.6 }}>
            Forgotten password
          </Text>
          <Text style={{ fontSize: 14, color: C.muted, marginTop: 10, lineHeight: 21 }}>
            Type the email address you saved under Settings → Getting back in.
            A link to set a new password goes there.
          </Text>

          <Text style={[S.label, { marginTop: 24 }]}>EMAIL</Text>
          <Box style={{ marginTop: 6, marginBottom: 22 }} autoCapitalize="none"
            keyboardType="email-address" placeholder="you@example.com"
            value={mail} onChangeText={setMail} onSubmit={sendReset} />

          <TouchableOpacity style={[S.btn, busy && { opacity: 0.6 }]}
            onPress={sendReset} disabled={busy}>
            <Text style={S.btnText}>{busy ? 'Sending…' : 'SEND THE LINK'}</Text>
          </TouchableOpacity>

          <TouchableOpacity onPress={() => setForgot(false)}
            style={{ marginTop: 20, alignItems: 'center' }}>
            <Text style={{ fontSize: 15, fontWeight: '700', color: C.muted }}>Back to logging in</Text>
          </TouchableOpacity>

          <Text style={{ fontSize: 12, color: C.muted, marginTop: 26, lineHeight: 18,
                         textAlign: 'center' }}>
            Never saved one? Nothing can be sent. Your books are safe — write to
            us and we will get you back in.
          </Text>
        </View>
      </Screen>
    );
  }

  return (
    <Screen>
      <View style={{ flex: 1, justifyContent: 'center', paddingHorizontal: 24 }}>
        <Text style={{ fontSize: 40, fontWeight: '800', color: C.ink, letterSpacing: -1 }}>Skwik</Text>
        <Text style={{ fontSize: 15, fontWeight: '600', color: C.muted, marginTop: 6, marginBottom: 28 }}>
          {isNew ? 'Make a new account for your shop' : 'Billing that keeps up with you'}
        </Text>

        <Text style={S.label}>MOBILE NUMBER</Text>
        <Box ref={fPhone} next={fPin}
          style={{ marginTop: 6, marginBottom: 16 }}
          keyboardType="number-pad" maxLength={10} placeholder="98640 12345"
          value={phone} onChangeText={setPhone} />

        <Text style={S.label}>PASSWORD</Text>
        <Box ref={fPin} onSubmit={go}
          style={{ marginTop: 6, marginBottom: 24 }}
          secureTextEntry placeholder="At least 6 characters"
          value={pin} onChangeText={setPin} />

        <TouchableOpacity style={[S.btn, busy && { opacity: 0.6 }]} onPress={go} disabled={busy}>
          <Text style={S.btnText}>{busy ? 'Please wait…' : isNew ? 'CREATE ACCOUNT' : 'LOG IN'}</Text>
        </TouchableOpacity>

        {!isNew && (
          <TouchableOpacity onPress={() => setForgot(true)}
            style={{ marginTop: 18, alignItems: 'center' }}>
            <Text style={{ fontSize: 14, fontWeight: '700', color: C.muted }}>
              Forgotten your password?
            </Text>
          </TouchableOpacity>
        )}

        <TouchableOpacity onPress={() => setIsNew(!isNew)} style={{ marginTop: 20, alignItems: 'center' }}>
          <Text style={{ fontSize: 15, fontWeight: '700', color: C.green }}>
            {isNew ? 'I already have an account' : 'New here? Create an account'}
          </Text>
        </TouchableOpacity>
      </View>
    </Screen>
  );
}
