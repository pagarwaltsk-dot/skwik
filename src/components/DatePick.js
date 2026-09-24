// A CALENDAR, EVERYWHERE THERE IS A DATE.
//
// Every date in Skwik was typed. That is fine for today's bill and hopeless
// for anything else: a day book from two months back meant tapping the back
// arrow sixty times, and a supplier's bill date meant remembering which way
// round the app wanted the numbers. A shopkeeper knows what a calendar is.
//
// This is written in plain React Native rather than pulled in as a phone
// calendar, for two reasons. It looks and behaves the same on every handset,
// old Androids included, and it adds nothing to the build — a new native
// piece would mean a new kind of thing to go wrong on somebody's phone for
// the sake of a date box.
//
// Typing still works. The field is a box he can write in exactly as before,
// and the calendar is the button beside it, so nothing he already knows how
// to do has been taken away.

import React, { useMemo, useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, Modal, ScrollView,
         useWindowDimensions } from 'react-native';
import { useKeyboardGap } from './Chrome';
import { today, parseDate, showDate } from '../lib/money';
import { C, S } from '../theme';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
const DOW = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

// the way a date is written on a bill in this country
const dmy = (d) => (d ? `${String(d).slice(8, 10)}/${String(d).slice(5, 7)}/${String(d).slice(0, 4)}` : '');

const ymd = (y, m, d) =>
  `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

// the month a date string sits in, or this month if it is not a date yet
function monthOf(iso) {
  const s = String(iso || '');
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  const now = new Date();
  if (!m) return { y: now.getFullYear(), m: now.getMonth() };
  return { y: Number(m[1]), m: Number(m[2]) - 1 };
}

const step = (y, m, by) => {
  const d = new Date(y, m + by, 1);
  return { y: d.getFullYear(), m: d.getMonth() };
};

// ---------------------------------------------------------------- the sheet

export function Calendar({ visible, value, onPick, onClose, title = 'Pick a date',
                           min, max, note }) {
  const start = monthOf(value);
  const [y, setY] = useState(start.y);
  const [m, setM] = useState(start.m);
  const [years, setYears] = useState(false);
  const gap = useKeyboardGap();
  // SEVEN COLUMNS, MEASURED, NOT ASKED FOR.
  // A share of the width — a seventh each — depends on the sheet already
  // knowing how wide it is, and the sheet is as wide as its children. That
  // circle resolves differently on different phones and pushed Saturday off
  // the edge of the screen. The width of the screen is a number; use it.
  const { width: screenW } = useWindowDimensions();
  const cellW = Math.floor((Math.max(280, screenW) - 36) / 7);

  // reopen on the month the value is in, not wherever it was left last time
  const [seen, setSeen] = useState(value);
  if (visible && seen !== value) {
    setSeen(value);
    const s = monthOf(value);
    setY(s.y); setM(s.m); setYears(false);
  }

  const weeks = useMemo(() => {
    const first = new Date(y, m, 1).getDay();          // 0 = Sunday
    const days = new Date(y, m + 1, 0).getDate();
    const cells = [];
    for (let i = 0; i < first; i++) cells.push(null);
    for (let d = 1; d <= days; d++) cells.push(d);
    while (cells.length % 7) cells.push(null);
    const out = [];
    for (let i = 0; i < cells.length; i += 7) out.push(cells.slice(i, i + 7));
    return out;
  }, [y, m]);

  const tday = today();
  const blocked = (iso) => (min && iso < min) || (max && iso > max);

  const Cell = ({ d }) => {
    if (!d) return <View style={{ width: cellW, height: 44 }} />;
    const iso = ymd(y, m, d);
    const on = iso === value;
    const isToday = iso === tday;
    const off = blocked(iso);
    return (
      <TouchableOpacity
        disabled={off}
        onPress={() => { onPick(iso); onClose(); }}
        style={{ width: cellW, height: 44, alignItems: 'center', justifyContent: 'center' }}>
        <View style={{ width: 38, height: 38, borderRadius: 11,
                       alignItems: 'center', justifyContent: 'center',
                       backgroundColor: on ? C.accent : 'transparent',
                       borderWidth: !on && isToday ? 1.5 : 0, borderColor: C.accent }}>
          <Text style={[S.num, { fontSize: 15.5, fontWeight: on ? '800' : '600',
                                 color: off ? C.faint : on ? '#fff' : C.ink }]}>
            {d}
          </Text>
        </View>
      </TouchableOpacity>
    );
  };

  // A SHOPKEEPER LOOKING FOR LAST YEAR SHOULD NOT PAGE THROUGH TWELVE MONTHS.
  // Tapping the month name opens the years instead.
  const thisYear = new Date().getFullYear();
  const yearList = [];
  for (let v = thisYear + 1; v >= thisYear - 12; v--) yearList.push(v);

  return (
    <Modal visible={!!visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: '#3B3A35DD', justifyContent: 'flex-end',
                     paddingBottom: gap }}>
        <View style={{ width: '100%', alignSelf: 'stretch', backgroundColor: C.bg,
                       borderTopLeftRadius: 26, borderTopRightRadius: 26,
                       padding: 18, paddingBottom: 22 }}>

          <View style={[S.row, { marginBottom: 12 }]}>
            <Text style={{ flex: 1, fontSize: 20, fontWeight: '800', color: C.ink }}>{title}</Text>
            <TouchableOpacity onPress={onClose} style={{ padding: 6 }}>
              <Text style={{ fontSize: 16, fontWeight: '800', color: C.muted }}>CLOSE</Text>
            </TouchableOpacity>
          </View>

          {!!note && (
            <Text style={{ fontSize: 12.5, fontWeight: '600', color: C.muted, marginBottom: 10 }}>
              {note}
            </Text>
          )}

          {years ? (
            <ScrollView style={{ maxHeight: 300 }}>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                {yearList.map((v) => (
                  <TouchableOpacity key={v} onPress={() => { setY(v); setYears(false); }}
                    style={{ paddingVertical: 12, paddingHorizontal: 18, borderRadius: 12,
                             borderWidth: 1.5,
                             borderColor: v === y ? C.accent : C.line,
                             backgroundColor: v === y ? C.accentSoft : C.card }}>
                    <Text style={[S.num, { fontSize: 15.5, fontWeight: '700',
                                           color: v === y ? C.accent : C.ink }]}>{v}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            </ScrollView>
          ) : (
            <>
              <View style={[S.row, { marginBottom: 6 }]}>
                <TouchableOpacity onPress={() => { const s = step(y, m, -1); setY(s.y); setM(s.m); }}
                  hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
                  style={{ padding: 8 }}>
                  <Text style={{ fontSize: 22, fontWeight: '700', color: C.muted }}>‹</Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={() => setYears(true)} style={{ flex: 1 }}>
                  <Text style={{ fontSize: 16.5, fontWeight: '800', color: C.ink,
                                 textAlign: 'center' }}>
                    {MONTHS[m]} {y}
                  </Text>
                  <Text style={{ fontSize: 11, fontWeight: '700', color: C.accent,
                                 textAlign: 'center', marginTop: 1 }}>
                    tap for another year
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={() => { const s = step(y, m, 1); setY(s.y); setM(s.m); }}
                  hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
                  style={{ padding: 8 }}>
                  <Text style={{ fontSize: 22, fontWeight: '700', color: C.muted }}>›</Text>
                </TouchableOpacity>
              </View>

              <View style={{ flexDirection: 'row', marginBottom: 2 }}>
                {DOW.map((d, i) => (
                  <Text key={i} style={{ width: cellW, textAlign: 'center', fontSize: 11,
                                         fontWeight: '700', color: C.muted }}>{d}</Text>
                ))}
              </View>

              {weeks.map((w, wi) => (
                <View key={wi} style={{ flexDirection: 'row' }}>
                  {w.map((d, i) => <Cell key={i} d={d} />)}
                </View>
              ))}

              <TouchableOpacity
                onPress={() => { if (!blocked(tday)) { onPick(tday); onClose(); } }}
                style={[S.btnGhost, { marginTop: 10 }]}>
                <Text style={[S.ghostText, { fontSize: 14.5 }]}>Today — {dmy(tday)}</Text>
              </TouchableOpacity>
            </>
          )}
        </View>
      </View>
    </Modal>
  );
}

// ------------------------------------------------------------- the field

// A date box with a calendar button on the end of it. `value` and `onChange`
// speak ISO (2026-09-24), which is what the database wants; what he sees and
// what he may type is 24/09/2026.
export function DateField({ value, onChange, placeholder = 'DD/MM/YYYY',
                            min, max, title, note, style, editable = true }) {
  const [text, setText] = useState(showDate(value));
  const [open, setOpen] = useState(false);

  // when the value is changed from outside — the calendar, or a reset — the
  // box has to follow it
  const [seen, setSeen] = useState(value);
  if (seen !== value) { setSeen(value); setText(showDate(value)); }

  return (
    <>
      <View style={[{ flexDirection: 'row', alignItems: 'center', gap: 8 }, style]}>
        <TextInput
          style={[S.input, { flex: 1, marginBottom: 0 }]}
          value={text}
          editable={editable}
          onChangeText={setText}
          onBlur={() => {
            const iso = parseDate(text);
            if (iso) { onChange(iso); setText(showDate(iso)); }
            else setText(showDate(value));       // nonsense typed: put it back
          }}
          placeholder={placeholder}
          placeholderTextColor={C.faint}
          keyboardType="numbers-and-punctuation" />
        <TouchableOpacity onPress={() => editable && setOpen(true)}
          style={{ width: 48, height: 48, borderRadius: 12, borderWidth: 1.5,
                   borderColor: C.line, backgroundColor: C.card,
                   alignItems: 'center', justifyContent: 'center' }}>
          <Text style={{ fontSize: 19 }}>📅</Text>
        </TouchableOpacity>
      </View>
      <Calendar visible={open} value={value || today()} min={min} max={max}
        title={title || 'Pick a date'} note={note}
        onPick={(iso) => { onChange(iso); setText(showDate(iso)); }}
        onClose={() => setOpen(false)} />
    </>
  );
}

// ------------------------------------------------------- the button alone

// SOME DATE BOXES CANNOT BE REPLACED WHOLESALE.
//
// A date sitting in a row of small cells, or inside a Box that already walks
// the keyboard's next key down a form, cannot become a DateField without the
// row around it changing shape. So this is the calendar on its own: a button
// the size of the box beside it, which opens the same sheet and writes the
// same ISO date back. Typing is untouched wherever it is used.
export function CalButton({ value, onPick, title, note, min, max, size = 44, style }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <TouchableOpacity onPress={() => setOpen(true)}
        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        style={[{ width: size, height: size, borderRadius: 11, borderWidth: 1.5,
                  borderColor: C.line, backgroundColor: C.card,
                  alignItems: 'center', justifyContent: 'center' }, style]}>
        <Text style={{ fontSize: size > 40 ? 19 : 16 }}>📅</Text>
      </TouchableOpacity>
      <Calendar visible={open} value={value || today()} min={min} max={max}
        title={title || 'Pick a date'} note={note}
        onPick={(iso) => onPick(iso)} onClose={() => setOpen(false)} />
    </>
  );
}
