import React, { useState, useRef } from 'react';
import { View, Text, TouchableOpacity, Alert } from 'react-native';

import { useApp } from '../AppContext';
import { supabase } from '../lib/supabase';
import { sayPlainly } from '../lib/offline';
import { Box, Head, Screen } from '../components/Chrome';
import { C, S } from '../theme';

// WHERE THE LINK IN THE EMAIL LANDS.
//
// Skwik had a "Forgotten your password?" screen that sent a reset email and
// told him "open it on this phone and it will let you set a new password".
// That was not true. The link went nowhere — no redirect was asked for, the
// app had no deep link to catch one, and `updateUser({ password })` was not
// called anywhere in the whole of Skwik. There was no way to set a new
// password at all, for anybody, ever. A shopkeeper who forgot the password he
// invented on the day he signed up lost his books, and nobody could get them
// back for him.
//
// Tapping the link now opens Skwik on skwik://reset, AppContext takes the
// recovery login off the link, and this screen is what that login is for.
//
// WHILE IT IS UP IT IS THE WHOLE APP. A login that arrived through a reset
// link must not reach the books: he would be looking at his shop holding a
// password he still does not know, and the next time Skwik asked him for it
// he would be locked out again with a link already spent. So App.js draws
// this screen and nothing else until the password is actually changed —
// which is why leaving goes through `finishRecovery` and `signOut` rather
// than `navigation`, there being nowhere on this stack to go.
export default function ResetScreen() {
  const { finishRecovery, signOut } = useApp();
  const [pw1, setPw1] = useState('');
  const [pw2, setPw2] = useState('');
  const [busy, setBusy] = useState(false);
  const f2 = useRef(null);

  const save = async () => {
    if (pw1.length < 6) {
      return Alert.alert('Too short', 'A password needs at least 6 letters or numbers.');
    }
    if (pw1 !== pw2) {
      return Alert.alert('The two do not match', 'Type the same password in both boxes.');
    }
    setBusy(true);
    try {
      const { error } = await supabase.auth.updateUser({ password: pw1 });
      if (error) throw error;
      Alert.alert('Done',
        'Your new password is set. Use it the next time Skwik asks you to log in.',
        [{ text: 'OK', onPress: () => finishRecovery() }]);
    } catch (e) {
      // The commonest reason is a link that has been sitting in the inbox too
      // long, and that needs saying rather than the raw message.
      const raw = String(e?.message || '');
      Alert.alert('Could not change it',
        /expired|invalid|token/i.test(raw)
          ? 'That link has expired. Ask for a new one from the login screen and open it '
            + 'as soon as it arrives.'
          : sayPlainly(e));
    } finally { setBusy(false); }
  };

  return (
    <Screen>
      {/* Going back without setting one leaves him holding a recovery login
          and no password, so it hands the login back rather than keeping it. */}
      <Head title="Set a new password" more={false}
        onBack={() => { signOut(); finishRecovery(); }} />
      <View style={{ padding: 18 }}>
        <Text style={[S.hint, { marginTop: 0, marginBottom: 18 }]}>
          Choose something you will remember. Six letters or numbers at least.
        </Text>

        <Text style={S.label}>NEW PASSWORD</Text>
        <Box next={f2} style={{ marginTop: 6 }} value={pw1} onChangeText={setPw1}
          secureTextEntry autoCapitalize="none" autoCorrect={false} />

        <Text style={[S.label, { marginTop: 16 }]}>TYPE IT AGAIN</Text>
        <Box ref={f2} onSubmit={save} style={{ marginTop: 6 }} value={pw2} onChangeText={setPw2}
          secureTextEntry autoCapitalize="none" autoCorrect={false} />

        <TouchableOpacity style={[S.btn, { marginTop: 24 }]} onPress={save} disabled={busy}>
          <Text style={S.btnText}>{busy ? 'Saving…' : 'SAVE THE NEW PASSWORD'}</Text>
        </TouchableOpacity>

        <Text style={[S.hint, { marginTop: 18 }]}>
          Nothing in your books changes. Only the password you log in with.
        </Text>
      </View>
    </Screen>
  );
}
