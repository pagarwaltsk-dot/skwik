import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, ScrollView, Keyboard, Platform,
  UIManager, useWindowDimensions, PanResponder } from 'react-native';
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
  const gap = useKeyboardGap();
  // With the keyboard up, the keyboard itself covers the navigation bar, so
  // the room left for it is no longer needed and would only waste height.
  return (
    <View style={[S.foot,
                  { paddingBottom: gap > 0 ? 10 : Math.max(insets.bottom, 10) + 10 },
                  style]}>
      {children}
    </View>
  );
}

// HOW MUCH OF THE SCREEN THE KEYBOARD HAS TAKEN.
//
// Android used to shrink the app when the keyboard came up, and every app got
// this for free. Since edge-to-edge became the default the app is drawn full
// height behind the keyboard instead, so the bottom of the screen — which on a
// billing app is the total and the Save button — ends up underneath it. The
// phone still announces how tall the keyboard is; this works out how much of
// that the app has not already been given, so the answer is right whether the
// window resized or not, and on both Android and iOS.
export function useKeyboardGap() {
  const [kb, setKb] = useState(0);
  const { height } = useWindowDimensions();
  const full = useRef(height);

  // the tallest the window has been with no keyboard up is its real height
  if (kb === 0 && height > full.current) full.current = height;

  useEffect(() => {
    const showEvt = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvt = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const a = Keyboard.addListener(showEvt, (e) => setKb(e?.endCoordinates?.height || 0));
    const b = Keyboard.addListener(hideEvt, () => setKb(0));
    return () => { a.remove(); b.remove(); };
  }, []);

  if (!kb) return 0;
  const shrank = Math.max(0, full.current - height);   // what Android already gave back
  return Math.max(0, Math.round(kb - shrank));
}

// THE SAME FIGURES, WRITTEN DOWN.
//
// Twice now a bottom bar has been reported as sitting under the keyboard, and
// twice it has been fixed by reasoning rather than by measuring — which is how
// you fix a thing twice. This returns what the phone actually says, so the
// numbers can be put on the screen and read off a photograph instead of
// guessed at from a thousand miles away. Nothing uses it unless the shop turns
// the switch on in Settings.
export function useKeyboardFacts() {
  const [kb, setKb] = useState(0);
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const full = useRef(height);
  if (kb === 0 && height > full.current) full.current = height;

  useEffect(() => {
    const showEvt = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvt = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const a = Keyboard.addListener(showEvt, (e) => setKb(e?.endCoordinates?.height || 0));
    const b = Keyboard.addListener(hideEvt, () => setKb(0));
    return () => { a.remove(); b.remove(); };
  }, []);

  const shrank = Math.max(0, full.current - height);
  return {
    kb: Math.round(kb),
    win: Math.round(height),
    full: Math.round(full.current),
    shrank: Math.round(shrank),
    gap: kb ? Math.max(0, Math.round(kb - shrank)) : 0,
    bottom: Math.round(insets.bottom),
    top: Math.round(insets.top),
  };
}

// A strip of those figures, pinned over everything, for one screenshot.
export function KeyboardRuler({ on }) {
  const f = useKeyboardFacts();
  if (!on) return null;
  return (
    <View pointerEvents="none"
      style={{ position: 'absolute', left: 0, right: 0, top: f.top + 4,
               alignItems: 'center', zIndex: 9999 }}>
      <Text style={{ fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
                     fontSize: 10, color: '#FFFFFF', backgroundColor: '#B4413CEE',
                     paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6,
                     overflow: 'hidden' }}>
        {`kb ${f.kb}  win ${f.win}/${f.full}  shrank ${f.shrank}  gap ${f.gap}  ins ${f.bottom}`}
      </Text>
    </View>
  );
}

// A screen that gets out of the keyboard's way. Everything inside rises by
// exactly the height the keyboard took, so a fixed bottom bar sits on top of
// the keys instead of behind them.
export function Screen({ children, style, ruler }) {
  const gap = useKeyboardGap();
  return (
    <View style={[S.screen, { paddingBottom: gap }, style]}>
      {children}
      <KeyboardRuler on={!!ruler} />
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

/* ================= forms that keep the field in sight ================= */

// Pushing the page up is only half of it. The field being typed in has to be
// above the keyboard as well, and on a long form — settings, a new customer —
// it usually is not. This scrolls it into view the moment it is tapped.

const BringCtx = createContext(null);

export function KeyForm({ children, contentContainerStyle, style, ...rest }) {
  const ref = useRef(null);
  const gap = useKeyboardGap();
  const insets = useSafeAreaInsets();

  const api = useMemo(() => ({
    bring: (node) => {
      const sv = ref.current;
      if (!sv || !node) return;
      const inner = sv.getInnerViewNode ? sv.getInnerViewNode() : null;
      if (!inner) return;
      try {
        UIManager.measureLayout(node, inner,
          () => {},                                   // could not measure: leave it
          (x, y) => sv.scrollTo({ y: Math.max(0, y - 90), animated: true }));
      } catch (_) { /* never let a scroll break typing */ }
    },
  }), []);

  return (
    <BringCtx.Provider value={api}>
      <ScrollView ref={ref} keyboardShouldPersistTaps="handled"
        keyboardDismissMode="none"
        style={style}
        contentContainerStyle={[
          contentContainerStyle,
          { paddingBottom: gap + Math.max(insets.bottom, 12) + 40 },
        ]}
        {...rest}>
        {children}
      </ScrollView>
    </BringCtx.Provider>
  );
}

// Spread onto any TextInput inside a KeyForm: <TextInput {...bring()} />
export function useBring() {
  const api = useContext(BringCtx);
  return (extra = {}) => ({
    onFocus: (e) => {
      api?.bring(e?.target);
      extra.onFocus?.(e);
    },
  });
}

// ONE FIELD, AND THE WAY TO THE NEXT ONE.
//
// A shopkeeper filling a form should never have to put his thumb down to move
// on. Give a field the ref of the one after it and the phone's own arrow key
// carries him there; the last field in a form says "done" and can save.
//
//   const rate = useRef(null);
//   <Box next={rate} … />
//   <Box ref={rate} onSubmit={save} … />
export const Box = React.forwardRef(function Box(
  { next, onSubmit, style, multiline, ...rest }, ref) {
  const bring = useBring();
  const last = !next;
  return (
    <TextInput
      ref={ref}
      style={[S.input, style]}
      placeholderTextColor={C.faint}
      multiline={multiline}
      returnKeyType={multiline ? undefined : (last ? 'done' : 'next')}
      submitBehavior={multiline ? 'newline' : (last ? 'blurAndSubmit' : 'submit')}
      {...rest}
      {...bring(rest)}
      onSubmitEditing={(e) => {
        rest.onSubmitEditing?.(e);
        if (next?.current?.focus) next.current.focus();
        else onSubmit?.();
      }}
    />
  );
});


// SWIPING BETWEEN THE TABS, THE WAY EVERY OTHER APP DOES IT.
//
// Tapping a tab at the top of the screen means reaching for the top of the
// screen, which on a big phone is a two-handed job. Everyone already swipes
// sideways in WhatsApp without being told, so the same thumb move moves
// between Skwik's tabs.
//
// It has to be careful not to fight the list underneath. A gesture only
// counts as a sideways one when it is clearly sideways — twice as much
// across as down, and far enough across to be deliberate — so an ordinary
// scroll up or down is never mistaken for it.
export function Swipe({ onLeft, onRight, children, style }) {
  const pan = React.useMemo(() => PanResponder.create({
    // never claim the gesture on the first touch: the list gets first refusal
    onStartShouldSetPanResponder: () => false,
    onMoveShouldSetPanResponder: (_e, g) => {
      const across = Math.abs(g.dx);
      const down   = Math.abs(g.dy);
      return across > 24 && across > down * 2;
    },
    onPanResponderRelease: (_e, g) => {
      if (Math.abs(g.dx) < 50) return;               // a nudge, not a swipe
      if (g.dx < 0) onLeft?.();                      // dragged left  → next
      else          onRight?.();                     // dragged right → previous
    },
  }), [onLeft, onRight]);

  return (
    <View style={[{ flex: 1 }, style]} {...pan.panHandlers}>
      {children}
    </View>
  );
}

// The tab either side of the one showing, so a screen only has to say what
// its tabs are and in what order.
export function useTabSwipe(tabs, current, set) {
  const i = tabs.indexOf(current);
  return {
    onLeft:  () => { if (i >= 0 && i < tabs.length - 1) set(tabs[i + 1]); },
    onRight: () => { if (i > 0) set(tabs[i - 1]); },
  };
}
