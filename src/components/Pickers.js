// Two pick-one-from-a-list fields, used on the item screen and in the
// quick-add sheet during billing. Both let him TYPE to search, but he can
// only ever end up with a value the GST portal accepts.

import React, { useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, Modal, FlatList,
         useWindowDimensions } from 'react-native';
import { useKeyboardGap } from './Chrome';
import { searchUqc, uqcShort, uqcName } from '../lib/uqc';
import { STATES, codeForState } from '../lib/states';
import { searchHsn, hsnDesc, minHsnDigits } from '../lib/hsn';
import { C, S } from '../theme';

// THE SHEET HAS TO FIT IN WHAT IS LEFT, NOT IN THE WHOLE SCREEN.
//
// It was eight tenths of the SCREEN tall and then pushed up by the height of
// the keyboard, so with the keyboard open it was taller than the room it had.
// The search box at the top went off the top of the phone and all he could
// see was a list of options stuck to the bottom, with nowhere to type.
//
// The height is now measured against the room actually left, and the list
// shrinks to fit inside it rather than shouldering the search box out.
function Sheet({ visible, title, hint, children, onClose }) {
  const gap = useKeyboardGap();
  const { height } = useWindowDimensions();
  const room = Math.max(260, Math.round((height - gap) * 0.9));
  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: '#3B3A35DD', justifyContent: 'flex-end',
                     paddingBottom: gap }}>
        <View style={{ backgroundColor: C.bg, borderTopLeftRadius: 26, borderTopRightRadius: 26,
                       padding: 18, maxHeight: room, flexShrink: 1 }}>
          <View style={[S.row, { marginBottom: 10 }]}>
            <Text style={{ flex: 1, fontSize: 20, fontWeight: '800', color: C.ink }}>{title}</Text>
            <TouchableOpacity onPress={onClose} style={{ padding: 6 }}>
              <Text style={{ fontSize: 16, fontWeight: '800', color: C.muted }}>CLOSE</Text>
            </TouchableOpacity>
          </View>
          {!!hint && (
            <Text style={{ fontSize: 12.5, fontWeight: '600', color: C.muted, marginBottom: 10 }}>
              {hint}
            </Text>
          )}
          {children}
        </View>
      </View>
    </Modal>
  );
}

// ---------------- UNIT ----------------

export function UomField({ value, onChange }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const list = searchUqc(q);

  return (
    <>
      <TouchableOpacity onPress={() => { setQ(''); setOpen(true); }}
        style={[S.input, { flexDirection: 'row', alignItems: 'center' }]}>
        <Text style={{ flex: 1, fontSize: 17, fontWeight: '700',
                       color: value ? C.ink : C.faint }}>
          {value ? `${uqcName(value)}  (${uqcShort(value)})` : 'Choose a unit'}
        </Text>
        <Text style={{ fontSize: 15, color: C.muted }}>▾</Text>
      </TouchableOpacity>

      <Sheet visible={open} title="Unit" onClose={() => setOpen(false)}
             hint="Type how you say it — kilo, gattha, peti, dozen.">
        <TextInput style={S.input} autoFocus placeholder="Search"
          value={q} onChangeText={setQ}
          returnKeyType="next" submitBehavior="submit"
          onSubmitEditing={() => {
            const top = list[0];
            if (top) { onChange(top.code); setOpen(false); }
          }} />
        <FlatList
          data={list}
          keyExtractor={(u) => u.code}
          keyboardShouldPersistTaps="handled"
          style={{ marginTop: 10, flexShrink: 1 }}
          renderItem={({ item }) => (
            <TouchableOpacity
              onPress={() => { onChange(item.code); setOpen(false); }}
              style={[S.row, { paddingVertical: 15, borderBottomWidth: 1, borderBottomColor: C.line }]}>
              <Text style={{ flex: 1, fontSize: 17, fontWeight: '700', color: C.ink }}>{item.name}</Text>
              <Text style={{ fontSize: 14, fontWeight: '700', color: C.muted }}>{item.short}</Text>
            </TouchableOpacity>
          )} />
      </Sheet>
    </>
  );
}

// ---------------- HSN ----------------

export function HsnField({ value, onChange, org, onRate, hint }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const need = minHsnDigits(org);
  const typedCode = /^\d{4,8}$/.test(q.trim());
  const list = searchHsn(q);

  const take = (code, rate) => {
    onChange(code);
    if (rate != null && onRate) onRate(String(rate));
    setOpen(false);
  };

  return (
    <>
      <TouchableOpacity onPress={() => { setQ(''); setOpen(true); }}
        style={[S.input, { flexDirection: 'row', alignItems: 'center' }]}>
        <View style={{ flex: 1 }}>
          <Text style={{ fontSize: 17, fontWeight: '700', color: value ? C.ink : C.faint }}>
            {value || `Find HSN (${need} digits or more)`}
          </Text>
          {!!value && !!hsnDesc(value) && (
            <Text numberOfLines={1} style={{ fontSize: 11.5, fontWeight: '600', color: C.muted, marginTop: 2 }}>
              {hsnDesc(value)}
            </Text>
          )}
        </View>
        <Text style={{ fontSize: 15, color: C.muted }}>▾</Text>
      </TouchableOpacity>

      <Sheet visible={open} title="HSN code" onClose={() => setOpen(false)}
             hint={hint || `Type what the goods are — "bucket", "steel plate" — or the number itself. Your firm needs at least ${need} digits.`}>
        <TextInput style={S.input} autoFocus placeholder="bucket, steel, 3924…"
          value={q} onChangeText={setQ}
          returnKeyType="next" submitBehavior="submit"
          onSubmitEditing={() => {
            const top = list[0];
            if (top) return take(top.hsn, top.gst_rate);
            if (typedCode && q.trim().length >= need) take(q.trim());
          }} />

        <FlatList
          data={list}
          keyExtractor={(m) => m.hsn}
          keyboardShouldPersistTaps="handled"
          style={{ marginTop: 10, flexShrink: 1 }}
          ListFooterComponent={
            typedCode && q.trim().length >= need ? (
              <TouchableOpacity onPress={() => take(q.trim())}
                style={{ paddingVertical: 16, marginTop: 4 }}>
                <Text style={{ fontSize: 15, fontWeight: '800', color: C.green }}>
                  Use {q.trim()} — my own code
                </Text>
                <Text style={{ fontSize: 11.5, fontWeight: '600', color: C.muted, marginTop: 3 }}>
                  Only if you are sure. A wrong HSN is a tax problem, not a typo.
                </Text>
              </TouchableOpacity>
            ) : null}
          renderItem={({ item }) => (
            <TouchableOpacity onPress={() => take(item.hsn, item.gst_rate)}
              style={{ paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: C.line }}>
              <View style={S.row}>
                <Text style={[{ fontSize: 17, fontWeight: '800', color: C.ink }, S.num]}>{item.hsn}</Text>
                {item.gst_rate != null && (
                  <Text style={{ fontSize: 12, fontWeight: '700', color: C.green }}>
                    GST {item.gst_rate}%
                  </Text>
                )}
              </View>
              <Text style={{ fontSize: 12.5, fontWeight: '600', color: C.muted, marginTop: 3 }}>
                {item.desc}
              </Text>
            </TouchableOpacity>
          )} />
      </Sheet>
    </>
  );
}


// ---------------- STATE ----------------

// WHICH STATE, NOT WHICH NUMBER.
//
// A shopkeeper was being asked for a two-digit state code — 18 for Assam, 27
// for Maharashtra — which is a thing only the GST portal knows and nobody
// carries in their head. He types the name of the state; Skwik keeps the
// code, because the code is what decides CGST-and-SGST against IGST and what
// goes on the return.
const STATE_LIST = Object.entries(STATES)
  .map(([code, name]) => ({ code, name }))
  .sort((a, b) => a.name.localeCompare(b.name));

export function StateField({ value, onChange, homeCode, placeholder = 'Choose the State' }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');

  const t = q.trim().toLowerCase();
  const list = !t ? STATE_LIST : STATE_LIST.filter((x) =>
    x.name.toLowerCase().includes(t) || x.code === t || codeForState(t) === x.code);

  const take = (code) => { onChange(code, STATES[code] || ''); setOpen(false); };

  return (
    <>
      <TouchableOpacity onPress={() => { setQ(''); setOpen(true); }}
        style={[S.input, { flexDirection: 'row', alignItems: 'center' }]}>
        <View style={{ flex: 1 }}>
          <Text style={{ fontSize: 17, fontWeight: '700', color: value ? C.ink : C.faint }}>
            {value ? STATES[value] || value : placeholder}
          </Text>
          {!!value && (
            <Text style={{ fontSize: 11.5, fontWeight: '600', color: C.muted, marginTop: 2 }}>
              State code {value}
              {homeCode ? (value === homeCode ? ' · same State as your shop'
                                              : ' · another State, so IGST') : ''}
            </Text>
          )}
        </View>
        <Text style={{ fontSize: 15, color: C.muted }}>▾</Text>
      </TouchableOpacity>

      <Sheet visible={open} title="State" onClose={() => setOpen(false)}
             hint="Type the first few letters. Skwik fills in the code itself.">
        <TextInput style={S.input} autoFocus placeholder="Assam, Maharashtra…"
          value={q} onChangeText={setQ}
          returnKeyType="next" submitBehavior="submit"
          onSubmitEditing={() => { const top = list[0]; if (top) take(top.code); }} />
        <FlatList
          data={list}
          keyExtractor={(x) => x.code}
          keyboardShouldPersistTaps="handled"
          style={{ marginTop: 10, flexShrink: 1 }}
          renderItem={({ item }) => (
            <TouchableOpacity onPress={() => take(item.code)}
              style={[S.row, { paddingVertical: 15, borderBottomWidth: 1, borderBottomColor: C.line }]}>
              <Text style={{ flex: 1, fontSize: 17, fontWeight: '700', color: C.ink }}>{item.name}</Text>
              <Text style={[{ fontSize: 14, fontWeight: '700', color: C.muted }, S.num]}>{item.code}</Text>
            </TouchableOpacity>
          )} />
      </Sheet>
    </>
  );
}
