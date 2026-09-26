import React, { useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, Switch } from 'react-native';

import { ask, commonest } from '../lib/ask';
import { C, S } from '../theme';

// ===========================================================================
//  A BOX YOU ASK A QUESTION, NOT A BOX YOU SEARCH.
//
//  A shopkeeper does not know his second store is called "godowns_enabled".
//  He knows what he wants: "what if I have more than one godown". So he types
//  that, and the switch comes up with the answer already written.
//
//  It sits at the TOP of the screen and never anywhere else. A box that
//  searches a long list and then grows downward pushes itself off the bottom
//  of a phone, and a man looking for something has to find the box first.
//
//  What a result carries, in this order:
//    the name he would recognise    -- "More than one godown", not a column
//    where it lives                 -- so he learns the app instead of the box
//    two or three sentences         -- written by us beforehand, never guessed
//    the switch itself              -- flipped here, or a button to the screen
// ===========================================================================

const Answer = ({ f, valueOf, onFlip, onOpen }) => {
  const isSwitch = f.kind === 'switch' && !!f.key;
  const on = isSwitch ? !!valueOf(f.key) : false;
  return (
    <View style={{ borderWidth: 1, borderColor: C.line, borderLeftWidth: 3,
                   borderLeftColor: C.accent, borderRadius: 10,
                   backgroundColor: C.surface, padding: 13, marginTop: 10 }}>
      <View style={[S.row, { alignItems: 'flex-start', gap: 10 }]}>
        <Text style={{ flex: 1, fontSize: 15.5, fontWeight: '700', color: C.ink }}>
          {f.name}
        </Text>
        <Text style={{ fontSize: 10.5, fontWeight: '700', color: C.faint,
                       letterSpacing: 0.6, textTransform: 'uppercase' }}>
          {f.where}
        </Text>
      </View>

      <Text style={{ fontSize: 13.5, color: C.muted, marginTop: 7, lineHeight: 19 }}>
        {f.msg}
      </Text>

      <View style={[S.row, { marginTop: 12, alignItems: 'center', gap: 10 }]}>
        {isSwitch ? (
          <>
            <Switch value={on} onValueChange={(v) => onFlip(f.key, v, f)}
              trackColor={{ true: C.accent, false: C.line }} />
            <Text style={{ fontSize: 13.5, fontWeight: '700',
                           color: on ? C.accent : C.muted }}>
              {on ? 'It is on' : 'Turn it on'}
            </Text>
          </>
        ) : null}
        <View style={{ flex: 1 }} />
        {!!f.route && (!isSwitch || on) && (
          <TouchableOpacity onPress={() => onOpen(f)}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
            <Text style={{ fontSize: 13.5, fontWeight: '800', color: C.accent }}>
              Open it {'›'}
            </Text>
          </TouchableOpacity>
        )}
      </View>
    </View>
  );
};

export default function AskBox({ valueOf, onFlip, onOpen, placeholder }) {
  const [q, setQ] = useState('');
  const hits = ask(q);
  const asked = !!q.trim();

  return (
    <View style={{ marginBottom: 18 }}>
      <View style={[S.row, { alignItems: 'center', gap: 8, borderWidth: 1,
                             borderColor: C.line, borderRadius: 11,
                             backgroundColor: C.surface, paddingHorizontal: 12 }]}>
        <Text style={{ fontSize: 15, color: C.faint }}>{'⌕'}</Text>
        <TextInput
          style={{ flex: 1, paddingVertical: 12, fontSize: 15, color: C.ink }}
          value={q} onChangeText={setQ}
          placeholder={placeholder || 'Ask anything — "I have two godowns"'}
          placeholderTextColor={C.faint}
          autoCorrect={false} returnKeyType="search" />
        {asked && (
          <TouchableOpacity onPress={() => setQ('')}
            hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
            <Text style={{ fontSize: 17, color: C.muted }}>{'×'}</Text>
          </TouchableOpacity>
        )}
      </View>

      {asked && hits.map((f) => (
        <Answer key={f.key || f.name} f={f} valueOf={valueOf} onFlip={onFlip} onOpen={onOpen} />
      ))}

      {/* NOT A SHRUG. A dead end with nowhere to go from it is what sends a
          shopkeeper to the phone; the things shops ask for most are offered
          instead, and they are usually what he meant. */}
      {asked && !hits.length && (
        <View style={{ marginTop: 10 }}>
          <Text style={{ fontSize: 13.5, color: C.muted, lineHeight: 19 }}>
            Nothing matched that. These are what shops ask for most often
            {' — '}or say it another way and try again.
          </Text>
          {commonest().map((f) => (
            <Answer key={f.key || f.name} f={f} valueOf={valueOf} onFlip={onFlip} onOpen={onOpen} />
          ))}
        </View>
      )}
    </View>
  );
}
