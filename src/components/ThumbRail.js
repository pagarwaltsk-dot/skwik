// ONE ARROW, WHERE HIS THUMB ALREADY IS.
//
// It has been three things. Beside the item list, which meant reaching up the
// screen — the one thing it existed to save. Pinned to the top edge of the
// keyboard, which put it UNDERNEATH the keyboard on his phone, because what
// Android reports for the keyboard's height and what the window actually does
// could not be reconciled. And then a bar carrying the item's name and rate
// and an OK button, which was all of it again in miniature: the name and the
// rate are already on the list three inches above, printed larger.
//
// So: an arrow. Tap it and the highlight walks down a line. Hold it and the
// highlighted line goes on the bill. Tab does the same, for a shop billing
// off a keyboard. Nothing else on it, because there is nothing else it needs
// to say.
//
// It floats, he drags it where his thumb falls, and it stays there — this
// phone, every bill after it. Measuring the keyboard is not attempted at all
// any more; it simply opens well clear of one.

import React, { useEffect, useRef, useState } from 'react';
import {
  View, Text, TouchableOpacity, PanResponder, useWindowDimensions,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { C } from '../theme';

const SIZE = 62;
const EDGE = 12;
const KEY  = 'skwik.thumbrail.at';

// What a phone keyboard costs, near enough, when nothing reliable can be
// measured. It opens above this much of the screen so it is usable on the
// first bill, before he has moved it anywhere.
const KEYBOARD_GUESS = 360;

export default function ThumbRail({ visible, count, onNext, onTake }) {
  const { width: winW, height: winH } = useWindowDimensions();

  const home = {
    x: winW - SIZE - EDGE,                                   // the thumb side
    y: Math.max(96, winH - KEYBOARD_GUESS - SIZE - 24),      // clear of the keys
  };

  const clamp = (x, y) => ({
    x: Math.min(Math.max(x, EDGE), Math.max(EDGE, winW - SIZE - EDGE)),
    y: Math.min(Math.max(y, 72), Math.max(72, winH - SIZE - EDGE)),
  });
  const clampRef = useRef(clamp);
  clampRef.current = clamp;

  const [at, setAt] = useState(home);
  const now   = useRef(home);     // where it is, readable inside the gesture
  const from  = useRef(home);     // where it was when the finger went down
  const [dragging, setDragging] = useState(false);
  const [took, setTook] = useState(false);   // a held press just landed
  const loaded = useRef(false);

  // Where he left it last time. A spot saved before the phone was turned on
  // its side is pulled back on screen rather than lost.
  useEffect(() => {
    let on = true;
    AsyncStorage.getItem(KEY).then((raw) => {
      if (!on || !raw) { loaded.current = true; return; }
      try {
        const p = JSON.parse(raw);
        if (typeof p?.x === 'number' && typeof p?.y === 'number') {
          const c = clampRef.current(p.x, p.y);
          now.current = c; setAt(c);
        }
      } catch (e) { /* nothing worth saying about a bad saved position */ }
      loaded.current = true;
    }).catch(() => { loaded.current = true; });
    return () => { on = false; };
  }, []);

  // A turn of the phone can leave it off the edge.
  useEffect(() => {
    if (!loaded.current) return;
    const c = clampRef.current(now.current.x, now.current.y);
    if (c.x !== now.current.x || c.y !== now.current.y) { now.current = c; setAt(c); }
  }, [winW, winH]);

  // DRAGGING AND TAPPING SHARE ONE FINGER, so they are told apart by
  // distance: under six points it is still a press and the button keeps it;
  // past six the bar takes the gesture and the press is cancelled — which is
  // also what stops a drag from being read as a hold.
  const pan = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => false,
    onMoveShouldSetPanResponder: (_e, g) => Math.abs(g.dx) > 6 || Math.abs(g.dy) > 6,
    onMoveShouldSetPanResponderCapture: (_e, g) => Math.abs(g.dx) > 6 || Math.abs(g.dy) > 6,
    onPanResponderGrant: () => { from.current = { ...now.current }; setDragging(true); },
    onPanResponderMove: (_e, g) => {
      const c = clampRef.current(from.current.x + g.dx, from.current.y + g.dy);
      now.current = c; setAt(c);
    },
    onPanResponderRelease: () => {
      setDragging(false);
      AsyncStorage.setItem(KEY, JSON.stringify(now.current)).catch(() => {});
    },
    onPanResponderTerminate: () => setDragging(false),
  })).current;

  // A held press puts goods on a bill, so it has to be felt as well as done.
  const take = () => {
    setTook(true);
    setTimeout(() => setTook(false), 220);
    onTake();
  };

  if (!visible) return null;

  return (
    <View
      {...pan.panHandlers}
      style={{ position: 'absolute', left: at.x, top: at.y, width: SIZE, height: SIZE }}>
      <TouchableOpacity
        activeOpacity={0.75}
        onPress={onNext}
        onLongPress={take}
        delayLongPress={300}
        disabled={count < 1}
        style={{
          width: SIZE, height: SIZE, borderRadius: 18,
          alignItems: 'center', justifyContent: 'center',
          backgroundColor: took ? C.accent : C.bg,
          borderWidth: 2, borderColor: took || dragging ? C.accent : C.line,
          shadowColor: '#000', shadowOpacity: dragging ? 0.3 : 0.2,
          shadowRadius: dragging ? 16 : 10, shadowOffset: { width: 0, height: 4 },
          elevation: dragging ? 12 : 8,
        }}>
        <Text style={{ fontSize: 30, fontWeight: '800', lineHeight: 34,
                       color: took ? '#fff' : C.ink }}>▼</Text>
      </TouchableOpacity>
    </View>
  );
}
