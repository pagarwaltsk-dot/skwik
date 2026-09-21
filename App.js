import React, { useEffect, useRef, useState } from 'react';
import { StatusBar } from 'expo-status-bar';
import * as SplashScreen from 'expo-splash-screen';
import { NavigationContainer } from '@react-navigation/native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { ActivityIndicator, View } from 'react-native';

import { AppProvider, useApp } from './src/AppContext';
import { C } from './src/theme';

import WelcomeScreen  from './src/screens/WelcomeScreen';
import RegisterScreen from './src/screens/RegisterScreen';
import ForgotScreen   from './src/screens/ForgotScreen';
import NewPasswordScreen from './src/screens/NewPasswordScreen';
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

function Routes() {
  const { session, org, loading, registering, checking, recovering } = useApp();

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
      {/* A LOGIN THAT CAME IN THROUGH A RESET LINK IS GOOD FOR ONE THING.
          It must not drop him into his books with a password he still does
          not know — the next time he opens Skwik he would be locked out
          again, holding a link that has already been used. */}
      {recovering ? (
        <Stack.Screen name="NewPassword" component={NewPasswordScreen} />
      ) : !session ? (
        <>
          <Stack.Screen name="Welcome"  component={WelcomeScreen} />
          <Stack.Screen name="Register" component={RegisterScreen} />
          <Stack.Screen name="Forgot"   component={ForgotScreen} />
        </>
      ) : !org ? (
        <Stack.Screen name="Onboard" component={OnboardScreen} />
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
        </>
      )}
    </Stack.Navigator>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <AppProvider>
        <StatusBar style="dark" />
        <NavigationContainer>
          <Routes />
        </NavigationContainer>
      </AppProvider>
    </SafeAreaProvider>
  );
}
