import React, { useEffect, useRef, useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, Alert, ScrollView, Platform,
  BackHandler,
} from 'react-native';
import { useApp } from '../AppContext';
import { sayPlainly } from '../lib/offline';
import { STATES } from '../lib/states';
import { Box, KeyForm, Screen } from '../components/Chrome';
import { C, S } from '../theme';

// REGISTERING, AS A SERIES OF SINGLE QUESTIONS.
//
//   gst      Do you have a GST number?
//   scheme     -> yes: composition or regular?
//   turnover        -> regular: above 5 crore or below?
//   details   GST number, mobile, password
//   shop      Shop name
//
// Nobody is ever shown two questions at once, and the no-GST path is three
// taps from here to a working bill.

const Choice = ({ title, note, onPress, tone }) => (
  <TouchableOpacity onPress={onPress} style={{
    backgroundColor: tone === 'quiet' ? C.surface : C.accentSoft,
    borderWidth: 1, borderColor: tone === 'quiet' ? C.line : '#C9E4DF',
    borderRadius: 12, padding: 16, marginBottom: 12 }}>
    <Text style={{ fontSize: 17, fontWeight: '700',
                   color: tone === 'quiet' ? C.ink : C.accent }}>{title}</Text>
    {!!note && <Text style={{ fontSize: 13, color: C.muted, marginTop: 5, lineHeight: 18 }}>{note}</Text>}
  </TouchableOpacity>
);

export default function RegisterScreen({ navigation }) {
  const { register, registering } = useApp();
  const [step, setStep] = useState('gst');
  // GST number → mobile → password, then shop name → address
  const fGstin = useRef(null), fPhone = useRef(null), fPass = useRef(null);
  const fShop  = useRef(null), fAddr  = useRef(null);
  const [d, setD] = useState({
    gstin: '', scheme: null, aboveFiveCr: null,
    phone: '', password: '', shopName: '', address: '',
  });
  const set = (k) => (v) => setD((x) => ({ ...x, [k]: v }));

  const back = () => {
    if (step === 'gst') return navigation.goBack();
    if (step === 'scheme')   return setStep('gst');
    if (step === 'turnover') return setStep('scheme');
    if (step === 'details')  return setStep(d.gstin || d.scheme ? (d.scheme === 'regular' ? 'turnover' : 'scheme') : 'gst');
    if (step === 'shop')     return setStep('details');
    return setStep('gst');
  };

  // The phone's own back button walks back one question at a time, the same as
  // the arrow. Without this it leaves the whole sign-up in one press.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (registering) return true;
      back();
      return true;
    });
    return () => sub.remove();
  });

  const toDetails = () => setStep('details');

  const checkDetails = () => {
    const hasGst = d.scheme !== null;
    if (hasGst && d.gstin.trim().length !== 15) {
      return Alert.alert('Check the GST number', 'A GSTIN is 15 characters.');
    }
    if (hasGst && !STATES[d.gstin.slice(0, 2)]) {
      return Alert.alert('Check the GST number', 'The first two digits are not a state code.');
    }
    if (d.phone.replace(/\D/g, '').length < 10) {
      return Alert.alert('Check the number', 'Type your 10 digit mobile number.');
    }
    if (d.password.length < 6) {
      return Alert.alert('Password too short', 'Use at least 6 characters.');
    }
    setStep('shop');
  };

  const finish = async () => {
    if (!d.shopName.trim()) {
      return Alert.alert('Shop name', 'Type the name that should print on your bills.');
    }
    try {
      await register(d);
    } catch (e) {
      Alert.alert('Could not register', sayPlainly(e));
    }
  };

  const Head = ({ title, note }) => (
    <>
      <Text style={{ fontSize: 24, fontWeight: '700', color: C.ink, marginBottom: 6 }}>{title}</Text>
      {!!note && (
        <Text style={{ fontSize: 14, color: C.muted, marginBottom: 22, lineHeight: 20 }}>{note}</Text>
      )}
    </>
  );

  return (
    <Screen>
      <View style={[S.bar, { paddingTop: 46 }]}>
        <TouchableOpacity onPress={back} disabled={registering} accessibilityLabel="Back"
          hitSlop={{ top: 14, bottom: 14, left: 14, right: 14 }}
          style={{ paddingVertical: 8, paddingRight: 10, paddingLeft: 2 }}>
          <Text style={{ fontSize: 26, color: '#fff', opacity: 0.85 }}>‹</Text>
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={S.barName}>Skwik</Text>
          <Text style={S.barSub}>Register your shop</Text>
        </View>
      </View>

      <KeyForm contentContainerStyle={{ padding: 20, paddingTop: 28 }}>

        {step === 'gst' && (
          <>
            <Head title="Do you have a GST number?" />
            <Choice title="Yes, I have GST"
              note="Your bills will be proper tax invoices with GST on them."
              onPress={() => setStep('scheme')} />
            <Choice title="No GST" tone="quiet"
              note="Simple estimates, no tax, nothing to fill in. You can add GST later and nothing is lost."
              onPress={() => { setD((x) => ({ ...x, gstin: '', scheme: null, aboveFiveCr: null })); toDetails(); }} />
          </>
        )}

        {step === 'scheme' && (
          <>
            <Head title="Which scheme are you under?"
                  note="Your accountant will know this. It decides what your bills say." />
            <Choice title="Regular"
              note="You charge GST on your bills and claim input credit. Most businesses."
              onPress={() => { set('scheme')('regular'); setStep('turnover'); }} />
            <Choice title="Composition" tone="quiet"
              note="You pay a flat 1% yourself and cannot charge GST to customers. Your bills will say BILL OF SUPPLY."
              onPress={() => { set('scheme')('composition'); toDetails(); }} />
          </>
        )}

        {step === 'turnover' && (
          <>
            <Head title="Is your yearly sale above ₹5 crore?"
                  note="This only decides how many digits your HSN codes need." />
            <Choice title="Below ₹5 crore" tone="quiet"
              note="HSN codes of 4 digits are enough."
              onPress={() => { set('aboveFiveCr')(false); toDetails(); }} />
            <Choice title="Above ₹5 crore"
              note="HSN codes will need 6 digits or more."
              onPress={() => { set('aboveFiveCr')(true); toDetails(); }} />
          </>
        )}

        {step === 'details' && (
          <>
            <Head title="Your login"
                  note="This number and password are how you get into Skwik. Write them down." />

            {d.scheme !== null && (
              <>
                <Text style={S.label}>GST number</Text>
                <Box ref={fGstin} next={fPhone} style={{ marginBottom: 4 }} autoCapitalize="characters"
                  maxLength={15} placeholder="18AABCS1234F1Z5"
                  value={d.gstin} onChangeText={(t) => set('gstin')(t.toUpperCase().trim())} />
                <Text style={[S.hint, { marginBottom: 14 }]}>
                  {STATES[d.gstin.slice(0, 2)]
                    ? `State: ${STATES[d.gstin.slice(0, 2)]}`
                    : 'The state fills in from the first two digits.'}
                </Text>
              </>
            )}

            <Text style={S.label}>Mobile number</Text>
            <Box ref={fPhone} next={fPass} style={[S.num, { marginBottom: 14 }]}
              keyboardType="number-pad" maxLength={10} placeholder="98640 12345"
              value={d.phone} onChangeText={set('phone')} />

            <Text style={S.label}>Password</Text>
            <Box ref={fPass} onSubmit={checkDetails} secureTextEntry
              placeholder="At least 6 characters"
              value={d.password} onChangeText={set('password')} />

            <TouchableOpacity style={[S.btn, { marginTop: 22 }]} onPress={checkDetails}>
              <Text style={S.btnText}>Continue</Text>
            </TouchableOpacity>
          </>
        )}

        {step === 'shop' && (
          <>
            <Head title="Your shop" note="This prints at the top of every bill." />

            <Text style={S.label}>Shop name</Text>
            <Box ref={fShop} next={fAddr} style={{ fontSize: 19, marginBottom: 14 }} autoFocus
              placeholder="Sri Ganesh Store"
              value={d.shopName} onChangeText={set('shopName')} />

            <Text style={S.label}>Address (optional)</Text>
            <Box ref={fAddr} placeholder="M. G. Road, Jorhat"
              value={d.address} onChangeText={set('address')} />

            <View style={{ marginTop: 18, padding: 14, backgroundColor: C.surface, borderWidth: 1,
                           borderColor: C.line, borderRadius: 12 }}>
              <Text style={S.eyebrow}>What you are signing up for</Text>
              <Text style={{ fontSize: 13.5, color: C.ink, lineHeight: 20 }}>
                {d.scheme === null
                  ? 'Estimates, customers and money in and out. No GST anywhere.'
                  : d.scheme === 'composition'
                  ? 'Bills of supply with no GST charged, plus customers, stock and money in and out.'
                  : `Tax invoices with GST, HSN of ${d.aboveFiveCr ? '6' : '4'} digits or more, plus customers, stock and money in and out.`}
                {'\n'}Free for 7 days.
              </Text>
            </View>

            <TouchableOpacity style={[S.btn, { marginTop: 20 }, registering && { backgroundColor: C.faint }]}
              onPress={finish} disabled={registering}>
              <Text style={S.btnText}>{registering ? 'Setting up your shop…' : 'Start billing'}</Text>
            </TouchableOpacity>
          </>
        )}

        <View style={{ height: 40 }} />
      </KeyForm>
    </Screen>
  );
}
