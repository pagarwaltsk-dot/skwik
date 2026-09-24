import React, { useEffect, useRef, useState } from 'react';
import { StatusBar } from 'expo-status-bar';
import * as SplashScreen from 'expo-splash-screen';
import { NavigationContainer, createNavigationContainerRef } from '@react-navigation/native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { ActivityIndicator, View, Alert, Linking } from 'react-native';

import { supabase } from './src/lib/supabase';
import { AppProvider, useApp } from './src/AppContext';
import { C } from './src/theme';

import WelcomeScreen  from './src/screens/WelcomeScreen';
import RegisterScreen from './src/screens/RegisterScreen';
import ForgotScreen   from './src/screens/ForgotScreen';
import ResetScreen    from './src/screens/ResetScreen';
import OnboardScreen from './src/screens/OnboardScreen';
import HomeScreen    from './src/screens/HomeScreen';
import BillScreen    from './src/screens/BillScreen';
import BillsScreen   from './src/screens/BillsScreen';
import TransferScreen from './src/screens/TransferScreen';
import ReportsScreen from './src/screens/ReportsScreen';
import ReturnScreen  from './src/screens/ReturnScreen';
import MoneyScreen   from './src/screens/MoneyScreen';
import PartiesScreen from './src/screens/PartiesScreen';
import LedgerScreen  from './src/screens/LedgerScreen';
import ItemsScreen   from './src/screens/ItemsScreen';
import StockScreen   from './src/screens/StockScreen';
import ItemMovesScreen from './src/screens/ItemMovesScreen';
import BooksScreen   from './src/screens/BooksScreen';
import LedgersScreen from './src/screens/LedgersScreen';
import BanksScreen   from './src/screens/BanksScreen';
import WipeScreen    from './src/screens/WipeScreen';
import MoreScreen    from './src/screens/MoreScreen';
import SettingsScreen from './src/screens/SettingsScreen';
import ExpensesScreen from './src/screens/ExpensesScreen';
import UdharScreen from './src/screens/UdharScreen';
import ReconScreen from './src/screens/ReconScreen';
import StaffScreen from './src/screens/StaffScreen';
import GodownScreen from './src/screens/GodownScreen';
import SampleScreen from './src/screens/SampleScreen';

// NO FLASH BETWEEN THE ICON AND THE SHOP.
//
// The app used to put a spinner on the screen for the fraction of a second it
// takes to find out which shop this login belongs to. A spinner that appears
// and vanishes before it can be read is the single thing that makes an app
// feel unfinished, so the native splash — the icon on the shop's own
// background — is simply held up until the answer is in, and the first thing
// drawn after it is the real screen.
//
// Held up, not held for ever: if the server never answers, the splash comes
// down after a few seconds and the spinner takes over, because a shopkeeper
// staring at a frozen logo has no way to know anything is wrong.
SplashScreen.preventAutoHideAsync().catch(() => {});
SplashScreen.setOptions({ duration: 220, fade: true });

const PATIENCE = 6000;

const Stack = createNativeStackNavigator();

// THE LINK IN THE RESET EMAIL WENT NOWHERE.
//
// "I provided my mail id, I received a mail of password reset verification,
// but nothing happened then." Exactly so. Three separate things were missing:
//
//   * ResetScreen was imported at the top of this file and then never put in
//     the navigator, so there was no screen with that name to arrive at
//   * nothing anywhere listened for the link. The Supabase client is told
//     detectSessionInUrl: false, which is right on a phone — a phone has no
//     address bar and the library cannot see the URL that opened the app — so
//     the app has to pick the link up itself and it never did
//   * so the app opened on the home screen and the shopkeeper, standing there
//     having done everything he was asked, was shown nothing at all
//
// Now: Skwik catches skwik://reset however it arrives, turns whatever the
// email put on the end of it into a live session, and walks him to the screen
// where he types the new password.
//
// Supabase has sent these links three different ways across its versions, and
// which one a project sends depends on settings nobody should have to think
// about. All three are read here, so it works whichever this project is on.
const navRef = createNavigationContainerRef();

const partsOf = (url) => {
  const out = {};
  const grab = (blob) => String(blob || '').split('&').forEach((bit) => {
    const i = bit.indexOf('=');
    if (i > 0) out[decodeURIComponent(bit.slice(0, i))] = decodeURIComponent(bit.slice(i + 1));
  });
  const u = String(url || '');
  const h = u.indexOf('#');
  const q = u.indexOf('?');
  if (h >= 0) grab(u.slice(h + 1));
  if (q >= 0) grab(u.slice(q + 1, h >= 0 ? h : undefined));
  return out;
};

// Walk him to the password screen the moment the navigator is ready for it.
// The link can arrive before React Navigation has mounted, and a navigate()
// into a navigator that does not exist yet is simply lost.
const goReset = () => {
  if (navRef.isReady()) return navRef.navigate('Reset');
  setTimeout(goReset, 250);
};

async function handleLink(url) {
  if (!url || !/reset/i.test(url)) return;
  const p = partsOf(url);

  if (p.error_description || p.error) {
    return Alert.alert('That link did not work',
      /expired/i.test(p.error_description || p.error || '')
        ? 'It has expired. Ask for a new one from the login screen and open it as '
          + 'soon as it arrives.'
        : (p.error_description || p.error));
  }

  try {
    if (p.access_token && p.refresh_token) {
      const { error } = await supabase.auth.setSession({
        access_token: p.access_token, refresh_token: p.refresh_token });
      if (error) throw error;
    } else if (p.code) {
      const { error } = await supabase.auth.exchangeCodeForSession(p.code);
      if (error) throw error;
    } else if (p.token_hash) {
      const { error } = await supabase.auth.verifyOtp({
        token_hash: p.token_hash, type: p.type || 'recovery' });
      if (error) throw error;
    } else {
      return;      // skwik://reset with nothing on it: not a real reset link
    }
  } catch (e) {
    return Alert.alert('That link did not work',
      /expired|invalid|token/i.test(String(e?.message || ''))
        ? 'It has expired. Ask for a new one from the login screen and open it as '
          + 'soon as it arrives.'
        : String(e?.message || 'Please ask for a new link.'));
  }

  goReset();
}

function Routes() {
  const { session, org, loading, registering, checking } = useApp();

  // The set-up screen is only for a login with genuinely no shop behind it —
  // never for the second it takes to find out.
  const settling = loading || registering || (session && checking && !org);

  // Whether the native splash is still the thing on the screen.
  const [splashUp, setSplashUp] = useState(true);
  const dropped = useRef(false);

  const drop = () => {
    if (dropped.current) return;
    dropped.current = true;
    SplashScreen.hideAsync().catch(() => {}).finally(() => setSplashUp(false));
  };

  useEffect(() => { if (!settling) drop(); }, [settling]);
  useEffect(() => {
    const t = setTimeout(drop, PATIENCE);
    return () => clearTimeout(t);
  }, []);

  // Splash still up: draw nothing behind it, so nothing can flash past.
  if (settling && splashUp) return null;

  if (settling) {
    return (
      <View style={{ flex: 1, backgroundColor: C.bg, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator size="large" color={C.green} />
      </View>
    );
  }

  return (
    <Stack.Navigator screenOptions={{ headerShown: false }}>
      {!session ? (
        <>
          <Stack.Screen name="Welcome"  component={WelcomeScreen} />
          <Stack.Screen name="Register" component={RegisterScreen} />
          <Stack.Screen name="Forgot"   component={ForgotScreen} />
          <Stack.Screen name="Reset"    component={ResetScreen} />
        </>
      ) : !org ? (
        <>
          <Stack.Screen name="Onboard" component={OnboardScreen} />
          <Stack.Screen name="Reset"   component={ResetScreen} />
        </>
      ) : (
        <>
          <Stack.Screen name="Home"    component={HomeScreen} />
          <Stack.Screen name="Bill"    component={BillScreen} />
          <Stack.Screen name="Bills"   component={BillsScreen} />
          <Stack.Screen name="Transfer" component={TransferScreen} />
          <Stack.Screen name="Reports"  component={ReportsScreen} />
          <Stack.Screen name="Return"   component={ReturnScreen} />
          <Stack.Screen name="Money"   component={MoneyScreen} />
          <Stack.Screen name="Parties" component={PartiesScreen} />
          <Stack.Screen name="Ledger"  component={LedgerScreen} />
          <Stack.Screen name="Items"   component={ItemsScreen} />
          <Stack.Screen name="Stock"   component={StockScreen} />
          <Stack.Screen name="ItemMoves" component={ItemMovesScreen} />
          <Stack.Screen name="Books"   component={BooksScreen} />
          <Stack.Screen name="Ledgers" component={LedgersScreen} />
          <Stack.Screen name="Banks"   component={BanksScreen} />
          <Stack.Screen name="Wipe"    component={WipeScreen} />
          <Stack.Screen name="More"     component={MoreScreen} />
          <Stack.Screen name="Settings" component={SettingsScreen} />
          <Stack.Screen name="Expenses" component={ExpensesScreen} />
          <Stack.Screen name="Udhar"    component={UdharScreen} />
          <Stack.Screen name="Recon"    component={ReconScreen} />
          <Stack.Screen name="Staff"    component={StaffScreen} />
          <Stack.Screen name="Godowns"  component={GodownScreen} />
          <Stack.Screen name="Sample"   component={SampleScreen} />
          <Stack.Screen name="Reset"    component={ResetScreen} />
        </>
      )}
    </Stack.Navigator>
  );
}

export default function App() {
  // The link that opened the app from cold, and any that arrives while it is
  // already running — a man who taps the email twice gets the same answer.
  useEffect(() => {
    Linking.getInitialURL().then(handleLink).catch(() => {});
    const sub = Linking.addEventListener('url', ({ url }) => { handleLink(url); });
    return () => sub.remove();
  }, []);

  // And the belt to that brace: if the client itself works out that this is a
  // recovery — which it does when the session is restored from storage — the
  // password screen is still where he should be.
  useEffect(() => {
    const { data } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'PASSWORD_RECOVERY') goReset();
    });
    return () => data?.subscription?.unsubscribe?.();
  }, []);

  return (
    <SafeAreaProvider>
      <AppProvider>
        <StatusBar style="dark" />
        <NavigationContainer ref={navRef}>
          <Routes />
        </NavigationContainer>
      </AppProvider>
    </SafeAreaProvider>
  );
}
