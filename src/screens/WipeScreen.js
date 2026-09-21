import React, { useState } from 'react';
import {
  View, Text, TouchableOpacity, ScrollView, Alert, ActivityIndicator,
} from 'react-native';

import { supabase } from '../lib/supabase';
import { sayPlainly, forgetLocal } from '../lib/offline';
import { useApp } from '../AppContext';
import { fmt0 } from '../lib/money';
import { Box, Head, KeyForm, Screen } from '../components/Chrome';
import { C, S } from '../theme';

// STARTING THE BOOKS AGAIN.
//
// A shopkeeper who has spent a fortnight trying the app on invented figures
// wants to begin his real books on the 1st with nothing behind them. Until
// now the only way was a second firm, which left him with two and no way to
// tell them apart.
//
// This is deliberately the hardest thing in the app to do, because it cannot
// be undone:
//
//   the owner only          staff cannot reach this screen at all
//   his password, typed     not remembered, not from the session — typed
//                           again, here, and checked against the server
//   two separate warnings   one saying what goes, one asking him to type the
//                           word himself
//
// Nothing is deleted until all three are past. What it does not do is quietly
// fail: if the server refuses, he is told in plain words and nothing is gone.

export default function WipeScreen({ navigation }) {
  const { org, isOwner } = useApp();
  const [step, setStep] = useState('why');     // why → password → confirm → doing
  const [keepMasters, setKeepMasters] = useState(true);
  const [pw, setPw] = useState('');
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);

  if (!isOwner) {
    return (
      <Screen>
        <Head navigation={navigation} title="Start again" />
        <Text style={{ padding: 24, fontSize: 14, color: C.muted, lineHeight: 21 }}>
          Only the owner of the firm can empty its books.
        </Text>
      </Screen>
    );
  }

  // The password is checked against the server, not against anything held on
  // the phone — a session already signed in proves nothing about who is
  // holding the handset right now.
  const checkPassword = async () => {
    if (!pw) return Alert.alert('Password', 'Type your password.');
    setBusy(true);
    try {
      const { data: u } = await supabase.auth.getUser();
      const email = u?.user?.email;
      if (!email) {
        Alert.alert('Not signed in properly', 'Log out and in again, then try this.');
        return;
      }
      const { error } = await supabase.auth.signInWithPassword({ email, password: pw });
      if (error) {
        Alert.alert('That is not your password', 'Nothing has been touched. Try again.');
        return;
      }
      setStep('confirm');
    } catch (e) {
      Alert.alert('Could not check it', sayPlainly(e));
    } finally { setBusy(false); setPw(''); }
  };

  const doWipe = async () => {
    if (typed.trim().toUpperCase() !== 'ERASE') {
      return Alert.alert('Type it exactly', 'Type ERASE in capitals to go ahead.');
    }
    setBusy(true); setStep('doing');
    try {
      const { data, error } = await supabase.rpc('wipe_org', { p_keep_masters: keepMasters });
      if (error) throw error;
      // The copy this phone keeps for billing with no signal has just become
      // a copy of books that no longer exist — including the bill counter,
      // which would otherwise carry on from the old numbers.
      await forgetLocal();
      const d = data || {};
      Alert.alert('The books are empty',
        `${fmt0(d.vouchers || 0)} bills, ${fmt0(d.payments || 0)} money entries and `
        + `${fmt0(d.expenses || 0)} expenses are gone.`
        + (keepMasters
            ? '\n\nYour items and your customers are still there, with their '
              + 'opening figures set back to nil.'
            : `\n\n${fmt0(d.items || 0)} items and ${fmt0(d.parties || 0)} names went too.`)
        + '\n\nBill numbering starts from 1 again.',
        [{ text: 'Start billing', onPress: () => navigation.navigate('Home') }]);
    } catch (e) {
      setStep('confirm');
      Alert.alert('Nothing was deleted', sayPlainly(e));
    } finally { setBusy(false); }
  };

  const Warn = ({ children }) => (
    <View style={{ backgroundColor: C.redL, borderWidth: 1, borderColor: '#E7C4C2',
                   borderRadius: 12, padding: 14, marginTop: 16 }}>
      <Text style={{ fontSize: 13.5, color: '#7E2C28', lineHeight: 20 }}>{children}</Text>
    </View>
  );

  return (
    <Screen>
      <Head navigation={navigation} title="Start the books again" />
      <KeyForm keyboardShouldPersistTaps="handled"
               contentContainerStyle={{ padding: 20, paddingBottom: 50 }}>

        {step === 'why' && (
          <>
            <Text style={{ fontSize: 21, fontWeight: '700', color: C.ink, lineHeight: 28 }}>
              Empty {org?.name || 'this firm'} and begin from nothing
            </Text>
            <Text style={{ fontSize: 14, color: C.muted, marginTop: 8, lineHeight: 21 }}>
              For a shop that has been trying Skwik on made-up figures and now
              wants to start its real books.
            </Text>

            <Warn>
              Every bill, every receipt and payment, every expense and every
              stock movement will be deleted. This cannot be undone. There is no
              copy kept anywhere, and I cannot get it back for you afterwards.
            </Warn>

            {/* SECTION 36 OF THE CGST ACT.
                A shop trying Skwik on made-up figures loses nothing here. A
                shop that has done a month of real billing and then empties
                itself has destroyed records the law makes it keep for six
                years, and nothing on this screen said so. */}
            <Warn>
              If any of these are real bills, the GST law says you must keep
              them for 72 months from the due date of your annual return
              (section 36 of the CGST Act). Take a copy under Import &amp;
              export before you empty this, and keep it safe.
            </Warn>

            <Text style={[S.eyebrow, { marginTop: 26 }]}>What about your lists?</Text>
            {[[true,  'Keep my items and my customers',
                      'Their opening stock and opening balances go back to nil, '
                      + 'but the names, rates and HSN codes stay. This is what '
                      + 'almost everybody wants.'],
              [false, 'Delete those too',
                      'The firm goes back to the day you made it — no items, no '
                      + 'names, nothing.']].map(([v, label, body]) => {
              const on = keepMasters === v;
              return (
                <TouchableOpacity key={String(v)} onPress={() => setKeepMasters(v)}
                  style={{ marginTop: 10, padding: 14, borderRadius: 12, borderWidth: 1.5,
                           borderColor: on ? C.accent : C.line,
                           backgroundColor: on ? C.accentSoft : C.surface }}>
                  <Text style={{ fontSize: 15, fontWeight: '700',
                                 color: on ? C.accent : C.ink }}>{label}</Text>
                  <Text style={{ fontSize: 12.5, color: C.muted, marginTop: 4, lineHeight: 18 }}>
                    {body}
                  </Text>
                </TouchableOpacity>
              );
            })}

            <TouchableOpacity style={[S.btn, { marginTop: 26, backgroundColor: C.danger }]}
              onPress={() => setStep('password')}>
              <Text style={S.btnText}>I understand — go on</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => navigation.goBack()}
              style={{ marginTop: 14, alignItems: 'center', paddingVertical: 10 }}>
              <Text style={{ fontSize: 16, fontWeight: '700', color: C.muted }}>
                No, take me back
              </Text>
            </TouchableOpacity>
          </>
        )}

        {step === 'password' && (
          <>
            <Text style={{ fontSize: 21, fontWeight: '700', color: C.ink }}>
              Your password, please
            </Text>
            <Text style={{ fontSize: 14, color: C.muted, marginTop: 8, lineHeight: 21 }}>
              Anyone can be holding an unlocked phone. Type the password you log
              in with, and it is checked against the server.
            </Text>

            <Text style={[S.label, { marginTop: 22 }]}>Password</Text>
            <Box style={{ marginTop: 6 }} secureTextEntry autoFocus
              value={pw} onChangeText={setPw} onSubmit={checkPassword} />

            <TouchableOpacity style={[S.btn, { marginTop: 24 }, busy && { backgroundColor: C.faint }]}
              onPress={checkPassword} disabled={busy}>
              <Text style={S.btnText}>{busy ? 'Checking…' : 'Check it'}</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => setStep('why')}
              style={{ marginTop: 14, alignItems: 'center', paddingVertical: 10 }}>
              <Text style={{ fontSize: 16, fontWeight: '700', color: C.muted }}>Back</Text>
            </TouchableOpacity>
          </>
        )}

        {step === 'confirm' && (
          <>
            <Text style={{ fontSize: 21, fontWeight: '700', color: C.danger }}>
              Last chance
            </Text>
            <Warn>
              The moment you press the button below, every bill, receipt, payment,
              expense and stock movement in {org?.name || 'this firm'} is gone
              for good.{keepMasters ? ' Your items and names will remain.'
                                    : ' Your items and names will go too.'}
            </Warn>

            <Text style={[S.label, { marginTop: 24 }]}>
              Type ERASE, in capitals, to prove you mean it
            </Text>
            <Box style={[{ marginTop: 6 }, S.mono]} autoCapitalize="characters" autoFocus
              placeholder="ERASE" value={typed} onChangeText={setTyped} />

            <TouchableOpacity
              style={[S.btn, { marginTop: 24, backgroundColor: C.danger },
                      (busy || typed.trim().toUpperCase() !== 'ERASE')
                        && { backgroundColor: C.faint }]}
              onPress={doWipe}
              disabled={busy || typed.trim().toUpperCase() !== 'ERASE'}>
              <Text style={S.btnText}>Erase the books</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => { setTyped(''); navigation.goBack(); }}
              style={{ marginTop: 14, alignItems: 'center', paddingVertical: 10 }}>
              <Text style={{ fontSize: 16, fontWeight: '700', color: C.accent }}>
                Stop — keep my books
              </Text>
            </TouchableOpacity>
          </>
        )}

        {step === 'doing' && (
          <View style={{ paddingTop: 60, alignItems: 'center' }}>
            <ActivityIndicator size="large" color={C.danger} />
            <Text style={{ fontSize: 14, color: C.muted, marginTop: 16 }}>
              Emptying the books…
            </Text>
          </View>
        )}
      </KeyForm>
    </Screen>
  );
}
