import React from 'react';
import { View, Text, TouchableOpacity } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { C, S } from '../theme';

// THE EDGES OF THE SCREEN.
//
// A phone's own back and home buttons sit over the bottom of the app, and on
// the newer ones so does the gesture bar. Anything drawn at the very bottom —
// which on a billing app is the total and the Save button — ends up underneath
// them. The phone tells us how much room to leave; these two ask it, instead
// of every screen guessing a number that is right on one handset and wrong on
// the next.

export function Bar({ children, style }) {
  const insets = useSafeAreaInsets();
  return (
    <View style={[S.bar, { paddingTop: Math.max(insets.top, 12) + 10 }, style]}>
      {children}
    </View>
  );
}

export function Foot({ children, style }) {
  const insets = useSafeAreaInsets();
  return (
    <View style={[S.foot, { paddingBottom: Math.max(insets.bottom, 10) + 10 }, style]}>
      {children}
    </View>
  );
}

// THE WAY OUT OF ANYWHERE.
//
// Every screen used to be a cul-de-sac: the only way from one to another was
// back to the home screen first. This sits in the top bar of each screen and
// goes straight to the list of everything.
export function MoreButton({ navigation, light = true }) {
  return (
    <TouchableOpacity onPress={() => navigation.navigate('More')}
      accessibilityLabel="Everything else"
      hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
      style={{ paddingHorizontal: 8, paddingVertical: 4 }}>
      <Text style={{ fontSize: 22, color: light ? '#fff' : C.ink, opacity: light ? 0.85 : 0.6 }}>
        ⋯
      </Text>
    </TouchableOpacity>
  );
}

export function BackButton({ navigation, onPress, light = true }) {
  return (
    <TouchableOpacity onPress={onPress || (() => navigation.goBack())} accessibilityLabel="Back"
      hitSlop={{ top: 14, bottom: 14, left: 14, right: 14 }}
      style={{ paddingVertical: 8, paddingRight: 10, paddingLeft: 2 }}>
      <Text style={{ fontSize: 26, color: light ? '#fff' : C.ink, opacity: light ? 0.85 : 1 }}>‹</Text>
    </TouchableOpacity>
  );
}

// A light header for the screens that are not the billing screen: back on the
// left, the name of the screen, whatever that screen needs, and the way out on
// the right. It leaves room for the notch at the top, which the old headers
// did by guessing 50 and getting it wrong on tall phones.
export function Head({ navigation, title, onBack, children, more = true }) {
  const insets = useSafeAreaInsets();
  return (
    <View style={[S.header, { paddingTop: Math.max(insets.top, 12) + 10 }]}>
      <BackButton navigation={navigation} onPress={onBack} light={false} />
      <Text numberOfLines={1} style={S.h1}>{title}</Text>
      {children}
      {more && <MoreButton navigation={navigation} light={false} />}
    </View>
  );
}
