import React from 'react';
import { StatusBar } from 'expo-status-bar';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { ActivityIndicator, View } from 'react-native';

import { AppProvider, useApp } from './src/AppContext';
import { C } from './src/theme';

import WelcomeScreen  from './src/screens/WelcomeScreen';
import RegisterScreen from './src/screens/RegisterScreen';
import OnboardScreen from './src/screens/OnboardScreen';
import HomeScreen    from './src/screens/HomeScreen';
import BillScreen    from './src/screens/BillScreen';
import BillsScreen   from './src/screens/BillsScreen';
import TransferScreen from './src/screens/TransferScreen';
import ReportsScreen from './src/screens/ReportsScreen';
import MoneyScreen   from './src/screens/MoneyScreen';
import PartiesScreen from './src/screens/PartiesScreen';
import LedgerScreen  from './src/screens/LedgerScreen';
import ItemsScreen   from './src/screens/ItemsScreen';
import StockScreen   from './src/screens/StockScreen';
import MoreScreen    from './src/screens/MoreScreen';
import SettingsScreen from './src/screens/SettingsScreen';

const Stack = createNativeStackNavigator();

function Routes() {
  const { session, org, loading, registering } = useApp();

  if (loading || registering) {
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
          <Stack.Screen name="Money"   component={MoneyScreen} />
          <Stack.Screen name="Parties" component={PartiesScreen} />
          <Stack.Screen name="Ledger"  component={LedgerScreen} />
          <Stack.Screen name="Items"   component={ItemsScreen} />
          <Stack.Screen name="Stock"   component={StockScreen} />
          <Stack.Screen name="More"     component={MoreScreen} />
          <Stack.Screen name="Settings" component={SettingsScreen} />
        </>
      )}
    </Stack.Navigator>
  );
}

export default function App() {
  return (
    <AppProvider>
      <StatusBar style="dark" />
      <NavigationContainer>
        <Routes />
      </NavigationContainer>
    </AppProvider>
  );
}
