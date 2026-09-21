import React, { useState } from 'react';
import { View, Text, TouchableOpacity, Alert, ScrollView } from 'react-native';
import { supabase } from '../lib/supabase';
import { sayPlainly } from '../lib/offline';
import { Box, Screen } from '../components/Chrome';
import { C, S } from '../theme';

// GETTING BACK IN.
//
// Skwik signs a shopkeeper in on his mobile number, and behind the scenes that
// number stands in for an email address. That is fine until he forgets his
// password, because there is nowhere to send a link — the address is not real
// and nobody reads it.
//
// There is no clever way round that. A password can only be reset somewhere he
// can actually receive, so the honest answer is to ask for a real email ONCE,
// in advance, under Settings, and use it when the day comes.
//
// This screen used to exist and was never wired into the app: the login screen
// that carried it was not in the navigator at all, so there was no way to
// reach it from anywhere. It is reachable now, from the first screen.
export default function ForgotScreen({ navigation }) {
  const [mail, setMail] = useState('');
  const [busy, setBusy] = useState(false);

  const send = async () => {
    const e = mail.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) {
      return Alert.alert('Check the address', 'Type the email you saved in Settings.');
    }
    setBusy(true);
    // THE LINK HAS TO COME BACK INTO SKWIK.
    //
    // Sent without this, Supabase points the link at the project's Site URL —
    // a web page that knows nothing about this app — so the shopkeeper opened
    // it, saw a page he could do nothing with, and was still locked out.
    // `skwik://` is the app's own address (app.json, "scheme"), and the app
    // opens on the screen that sets a new password.
    const { error } = await supabase.auth.resetPasswordForEmail(e, {
      redirectTo: 'skwik://reset-password',
    });
    setBusy(false);
    if (error) return Alert.alert('Could not send it', sayPlainly(error));

    // Supabase never says whether the address was on an account, and that is
    // right: saying so would tell a stranger which addresses exist.
    Alert.alert('If that address is on the account, a link is on its way',
      'Open it ON THIS PHONE. Skwik opens by itself and asks you for a new '
      + 'password.\n\n'
      + 'Nothing arrives if that email was never saved in Settings. In that '
      + 'case write to us and we will sort it out by hand — your books are safe '
      + 'either way.',
      [{ text: 'All right', onPress: () => navigation.goBack() }]);
  };

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ flexGrow: 1, justifyContent: 'center',
                                           paddingHorizontal: 24, paddingVertical: 40 }}
                  keyboardShouldPersistTaps="handled">
        <Text style={{ fontSize: 26, fontWeight: '800', color: C.ink, letterSpacing: -0.6 }}>
          Forgotten password
        </Text>
        <Text style={{ fontSize: 14, color: C.muted, marginTop: 10, lineHeight: 21 }}>
          Type the email address saved under Settings → Getting back in. A link
          to set a new password goes there.
        </Text>

        <Text style={[S.label, { marginTop: 24 }]}>EMAIL</Text>
        <Box style={{ marginTop: 6, marginBottom: 22 }} autoCapitalize="none"
          autoFocus keyboardType="email-address" placeholder="you@example.com"
          value={mail} onChangeText={setMail} onSubmit={send} />

        <TouchableOpacity style={[S.btn, busy && { opacity: 0.6 }]}
          onPress={send} disabled={busy}>
          <Text style={S.btnText}>{busy ? 'Sending…' : 'SEND THE LINK'}</Text>
        </TouchableOpacity>

        <TouchableOpacity onPress={() => navigation.goBack()}
          style={{ marginTop: 20, alignItems: 'center', paddingVertical: 8 }}>
          <Text style={{ fontSize: 15, fontWeight: '700', color: C.muted }}>
            Back to logging in
          </Text>
        </TouchableOpacity>

        <Text style={{ fontSize: 12, color: C.muted, marginTop: 26, lineHeight: 18,
                       textAlign: 'center' }}>
          Never saved one? Nothing can be sent, and nothing is lost. Write to us
          and we will get you back in.
        </Text>
      </ScrollView>
    </Screen>
  );
}
