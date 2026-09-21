import React, { useRef, useState } from 'react';
import { View, Text, TouchableOpacity, ScrollView, Alert } from 'react-native';
import { supabase } from '../lib/supabase';
import { sayPlainly } from '../lib/offline';
import { useApp } from '../AppContext';
import { Box, Screen } from '../components/Chrome';
import { C, S } from '../theme';

// THE OTHER HALF OF "FORGOTTEN YOUR PASSWORD".
//
// The e-mail carries a link back into Skwik itself — skwik://reset-password —
// and the app opens holding a login that is good for one thing only: setting
// a new password. Until now there was no such screen, so the link opened a
// web page that could not touch the app and the shopkeeper stayed locked out
// with a reset e-mail in his hand.
//
// He is not let past this screen until the password is actually changed. A
// recovery login is the one kind of session that must not simply drop him
// into his books.
export default function NewPasswordScreen() {
  const { finishRecovery, signOut } = useApp();
  const [pw, setPw] = useState('');
  const [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false);
  const fAgain = useRef(null);

  const save = async () => {
    if (pw.length < 6) {
      return Alert.alert('Too short', 'Use at least 6 characters.');
    }
    if (pw !== again) {
      return Alert.alert('The two do not match', 'Type the same password in both boxes.');
    }
    setBusy(true);
    try {
      const { error } = await supabase.auth.updateUser({ password: pw });
      if (error) throw error;
      finishRecovery();
      Alert.alert('Password changed',
        'Log in with your mobile number and this new password from now on.');
    } catch (e) {
      Alert.alert('Could not change it', sayPlainly(e));
    } finally { setBusy(false); }
  };

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ flexGrow: 1, justifyContent: 'center',
                                           paddingHorizontal: 24, paddingVertical: 40 }}
                  keyboardShouldPersistTaps="handled">
        <Text style={{ fontSize: 26, fontWeight: '800', color: C.ink, letterSpacing: -0.6 }}>
          Set a new password
        </Text>
        <Text style={{ fontSize: 14, color: C.muted, marginTop: 10, lineHeight: 21 }}>
          You came in from the link in your e-mail. Choose a password now — you
          will need it the next time you log in, with your mobile number as
          usual.
        </Text>

        <Text style={[S.label, { marginTop: 24 }]}>NEW PASSWORD</Text>
        <Box style={{ marginTop: 6 }} next={fAgain} autoFocus secureTextEntry
          placeholder="At least 6 characters" value={pw} onChangeText={setPw} />

        <Text style={[S.label, { marginTop: 16 }]}>TYPE IT AGAIN</Text>
        <Box ref={fAgain} style={{ marginTop: 6, marginBottom: 22 }} secureTextEntry
          placeholder="The same password" value={again} onChangeText={setAgain}
          onSubmit={save} />

        <TouchableOpacity style={[S.btn, busy && { opacity: 0.6 }]}
          onPress={save} disabled={busy}>
          <Text style={S.btnText}>{busy ? 'Saving…' : 'SAVE THE NEW PASSWORD'}</Text>
        </TouchableOpacity>

        <TouchableOpacity onPress={signOut}
          style={{ marginTop: 20, alignItems: 'center', paddingVertical: 8 }}>
          <Text style={{ fontSize: 15, fontWeight: '700', color: C.muted }}>
            Not now — back to logging in
          </Text>
        </TouchableOpacity>

        <Text style={{ fontSize: 12, color: C.muted, marginTop: 26, lineHeight: 18,
                       textAlign: 'center' }}>
          Nothing in your books changes. This only sets the password you use to
          get in.
        </Text>
      </ScrollView>
    </Screen>
  );
}
