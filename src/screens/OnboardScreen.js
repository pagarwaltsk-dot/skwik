import React, { useRef, useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, ScrollView, Alert } from 'react-native';
import { supabase } from '../lib/supabase';
import { useApp } from '../AppContext';
import { STATES } from '../lib/states';
import { Box, KeyForm } from '../components/Chrome';
import { StateField } from '../components/Pickers';
import { C, S } from '../theme';
import { sayPlainly } from '../lib/offline';


// A SAFETY NET, not the usual way in. Registering happens on RegisterScreen.
// This shows only if someone has a login but no shop against it - an account
// made before this version, or a sign-up that stopped half way.
export default function OnboardScreen() {
  const { reloadOrg, signOut, joinShop } = useApp();
  const [name, setName] = useState('');
  // THE STATE DECIDES THE TAX, AND IT WAS TYPED IN FOR HIM.
  //
  // This screen put state_code '18' — Assam — on every shop it made, with no
  // field to say otherwise. For a shop anywhere else, every out-of-state bill
  // afterwards would be charged CGST and SGST instead of IGST and go into the
  // wrong table of GSTR-1. Assam stays the default, because that is where most
  // of these shops are; it is now a default and not a decision.
  const [stateCode, setStateCode] = useState('18');

  // WHICH OF THE TWO PEOPLE ARE YOU?
  //
  // This screen asked one of them and buried the other. It opened headed
  // "Your shop" with a Start billing button, and the box for the shop code —
  // the only thing the man who is going to stand at the counter came here
  // for — was the last card on a page he had to scroll to find. So of course
  // he tapped Start billing. And that was that: his login then owned an empty
  // shop of its own, the code was refused from then on, and there was no
  // screen left anywhere in Skwik that would take it.
  //
  // Now the question is asked first, in two words, before anything can be
  // tapped by mistake.
  const [who, setWho] = useState('');
  const fName = useRef(null), fPhone = useRef(null), fCode = useRef(null);
  const [code, setCode] = useState('');

  const join = async () => {
    if (code.trim().length < 4) {
      return Alert.alert('The code', 'Ask the owner for the six-character shop code.');
    }
    setBusy(true);
    try {
      const r = await joinShop(code);
      Alert.alert('You are in', `You can now write bills for ${r?.name || 'the shop'}.`);
    } catch (e) {
      Alert.alert('Could not join', sayPlainly(e));
    } finally { setBusy(false); }
  };
  const [phone, setPhone] = useState('');
  // WHICH KIND OF SHOP, asked once, because it decides the whole screen he
  // gets. 'plain' = no GST registration at all; 'comp' = registered under the
  // composition scheme, which may not collect GST either. A regular dealer
  // turns GST on in Settings afterwards -- it is not what v1 is sold for, and
  // asking three questions where two will do makes onboarding heavier for
  // everybody to serve the rarer case.
  const [grade, setGrade] = useState('plain');
  const [busy, setBusy] = useState(false);

  const start = async () => {
    if (!name.trim()) return Alert.alert('Shop name', 'Type the name that should print on your bills.');
    setBusy(true);
    const { data: { user } } = await supabase.auth.getUser();

    // THIRTY DAYS, NOT SEVEN.
    //
    // A shopkeeper decides this is worth paying for when he closes a month, or
    // files a CMP-08 and it comes out right. A seven-day trial never reaches
    // either, so it asked him to buy before he had seen the thing work.
    const trialEnds = new Date();
    trialEnds.setDate(trialEnds.getDate() + 30);

    const comp = grade === 'comp';

    // WHAT HE SEES ON HIS FIRST SCREEN, decided by the kind of shop he just
    // said he has.
    //
    // features.js reads every one of these off the firm row, and a column that
    // is missing counts as ON -- so a firm created without them showed Returns,
    // Reports, Transfer, Expenses and Reconcile from the first minute. Five
    // things a man who does not charge GST will never use, on the screen he is
    // trying to learn.
    //
    // Nothing is removed from Skwik. Each of these is a switch in Settings, and
    // the shop that wants one turns it on.
    const firstScreen = {
      show_purchase: true,         // everybody buys
      show_returns:  false,
      // A composition dealer needs Reports: his CMP-08 is in there. A shop with
      // no registration files nothing at all.
      show_reports:  comp,
      show_transfer: false,        // until he says he has a second godown
      show_expenses: false,
      // NEITHER GRADE HAS INPUT CREDIT, so there is nothing to reconcile
      // against 2B. This one is not merely hidden -- the screen could only
      // mislead him.
      show_recon:    false,
      stock_enabled:    false,
      godowns_enabled:  false,
      batch_enabled:    false,
      expiry_enabled:   false,
      variants_enabled: false,
    };

    const { data: org, error } = await supabase.from('orgs').insert({
      name: name.trim(),
      phone: phone.trim(),
      mode: 'estimate',
      // A composition dealer IS registered -- he simply may not collect the
      // tax. Marking him unregistered would fold his purchase tax into cost
      // correctly by luck and get his returns wrong on purpose.
      is_gst_registered: comp,
      is_composition: comp,
      state_code: stateCode || '18',
      state_name: STATES[stateCode || '18'] || '',
      plan: 'trial',
      trial_ends_at: trialEnds.toISOString(),
      ...firstScreen,
    }).select().single();

    if (error) { setBusy(false); return Alert.alert('Could not save', sayPlainly(error)); }

    const { error: e2 } = await supabase.from('profiles')
      .upsert({ id: user.id, org_id: org.id, phone: phone.trim() });
    setBusy(false);
    if (e2) return Alert.alert('Could not save', sayPlainly(e2));
    await reloadOrg();
  };

  if (!who) {
    return (
      <KeyForm style={S.screen} contentContainerStyle={{ padding: 24, paddingTop: 80 }}>
        <Text style={{ fontSize: 28, fontWeight: '700', color: C.ink }}>Welcome</Text>
        <Text style={{ fontSize: 15, color: C.muted, marginTop: 8, marginBottom: 28 }}>
          One question, and then you are billing.
        </Text>

        <TouchableOpacity onPress={() => setWho('owner')}
          style={{ backgroundColor: C.accentSoft, borderWidth: 1, borderColor: '#C9E4DF',
                   borderRadius: 12, padding: 18, marginBottom: 12 }}>
          <Text style={{ fontSize: 18, fontWeight: '700', color: C.accent }}>
            This is my shop
          </Text>
          <Text style={{ fontSize: 13, color: C.muted, marginTop: 5, lineHeight: 18 }}>
            Give it a name and start writing bills.
          </Text>
        </TouchableOpacity>

        <TouchableOpacity onPress={() => setWho('staff')}
          style={{ backgroundColor: C.surface, borderWidth: 1, borderColor: C.line,
                   borderRadius: 12, padding: 18 }}>
          <Text style={{ fontSize: 18, fontWeight: '700', color: C.ink }}>
            I work at a shop
          </Text>
          <Text style={{ fontSize: 13, color: C.muted, marginTop: 5, lineHeight: 18 }}>
            The owner already uses Skwik. He will read you a six-character code.
          </Text>
        </TouchableOpacity>

        <TouchableOpacity onPress={signOut} style={{ marginTop: 26, alignItems: 'center' }}>
          <Text style={{ fontSize: 14, fontWeight: '700', color: C.muted }}>Log out</Text>
        </TouchableOpacity>
      </KeyForm>
    );
  }

  if (who === 'staff') {
    return (
      <KeyForm style={S.screen} contentContainerStyle={{ padding: 24, paddingTop: 80 }}>
        <Text style={{ fontSize: 28, fontWeight: '700', color: C.ink }}>The shop code</Text>
        <Text style={{ fontSize: 15, color: C.muted, marginTop: 8, marginBottom: 24, lineHeight: 21 }}>
          Ask the owner to open Skwik, go to Settings → Who can bill, and tap
          Open. He will read you six letters and numbers. They only work for
          one hour, and for one phone.
        </Text>

        <Box ref={fCode} onSubmit={join} autoFocus
          style={[{ letterSpacing: 6, fontSize: 26, textAlign: 'center' }, S.num]}
          autoCapitalize="characters" maxLength={6} placeholder="ABC123"
          value={code} onChangeText={(t) => setCode(t.toUpperCase().replace(/[^A-Z0-9]/g, ''))} />

        <TouchableOpacity style={[S.btn, { marginTop: 18 }, busy && { opacity: 0.6 }]}
          onPress={join} disabled={busy}>
          <Text style={S.btnText}>{busy ? 'One moment…' : 'Join the shop'}</Text>
        </TouchableOpacity>

        <TouchableOpacity onPress={() => setWho('')}
          style={{ marginTop: 18, alignItems: 'center', paddingVertical: 10 }}>
          <Text style={{ fontSize: 15, fontWeight: '700', color: C.muted }}>Back</Text>
        </TouchableOpacity>
      </KeyForm>
    );
  }

  return (
    <KeyForm style={S.screen} contentContainerStyle={{ padding: 24, paddingTop: 80 }}>
      <Text style={{ fontSize: 28, fontWeight: '700', color: C.ink }}>Your shop</Text>
      <Text style={{ fontSize: 15, color: C.muted, marginTop: 8, marginBottom: 28 }}>
        Just the name for now. You can start billing straight away.
      </Text>

      <Text style={S.label}>Shop name</Text>
      <Box ref={fName} next={fPhone} style={{ marginTop: 6, marginBottom: 18, fontSize: 20 }}
        autoFocus placeholder="Your shop name"
        value={name} onChangeText={setName} />

      <Text style={S.label}>Which state?</Text>
      <View style={{ marginTop: 6, marginBottom: 18 }}>
        <StateField value={stateCode} homeCode={stateCode} onChange={setStateCode} />
      </View>

      <Text style={S.label}>Phone (optional)</Text>
      <Box ref={fPhone} onSubmit={start} style={{ marginTop: 6, marginBottom: 22 }}
        keyboardType="phone-pad" value={phone} onChangeText={setPhone} />

      {/* ONE MORE QUESTION, AND IT DECIDES THE WHOLE APP.
        *
        * Whether he charges GST settles what prints on his bills, which
        * returns are his, and what is on his screen at all. Asked here in his
        * own words rather than as "registration status", and changeable in
        * Settings if he picks wrong. */}
      <Text style={S.label}>Do you charge GST on your bills?</Text>
      <View style={{ marginTop: 8, marginBottom: 26, gap: 10 }}>
        {[['plain', 'No, I don\u2019t charge GST',
           'Your bills carry no tax and you file no returns.'],
          ['comp', 'I am on the composition scheme',
           'You pay a small tax on turnover every quarter and cannot charge GST to '
           + 'customers. Skwik works out your CMP-08.']].map(([key, title, why]) => {
          const on = grade === key;
          return (
            <TouchableOpacity key={key} onPress={() => setGrade(key)}
              style={{ borderWidth: 1.5, borderRadius: 12, padding: 14,
                       borderColor: on ? C.accent : C.line,
                       backgroundColor: on ? C.accentSoft : C.surface }}>
              <Text style={{ fontSize: 15.5, fontWeight: '700',
                             color: on ? C.accent : C.ink }}>{title}</Text>
              <Text style={{ fontSize: 12.5, color: C.muted, marginTop: 4, lineHeight: 18 }}>
                {why}
              </Text>
            </TouchableOpacity>
          );
        })}
        <Text style={{ fontSize: 11.5, color: C.muted, lineHeight: 16 }}>
          Charging GST as a regular dealer? Start here and turn it on in
          Settings once you are in.
        </Text>
      </View>

      <TouchableOpacity style={[S.btn, busy && { opacity: 0.6 }]} onPress={start} disabled={busy}>
        <Text style={S.btnText}>{busy ? 'One moment…' : 'Start billing'}</Text>
      </TouchableOpacity>

      <View style={{ marginTop: 22, padding: 14, backgroundColor: C.surface, borderWidth: 1,
                     borderColor: C.line, borderRadius: 12 }}>
        <Text style={{ fontSize: 13.5, fontWeight: '700', color: C.ink }}>
          Have a GST number?
        </Text>
        <Text style={{ fontSize: 12.5, fontWeight: '600', color: C.muted, marginTop: 5 }}>
          Add it later in Settings and your bills become proper tax invoices.
          Nothing you enter now is lost.
        </Text>
      </View>

      <TouchableOpacity onPress={() => setWho('staff')}
        style={{ marginTop: 18, alignItems: 'center', paddingVertical: 10 }}>
        <Text style={{ fontSize: 14, fontWeight: '700', color: C.accent }}>
          I work at a shop — I have a code
        </Text>
      </TouchableOpacity>

      <TouchableOpacity onPress={signOut} style={{ marginTop: 20, alignItems: 'center' }}>
        <Text style={{ fontSize: 14, fontWeight: '700', color: C.muted }}>Log out</Text>
      </TouchableOpacity>
    </KeyForm>
  );
}

export { STATES };
