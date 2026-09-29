import React, { useCallback, useMemo, useRef, useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, ScrollView } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { supabase, allRows } from '../lib/supabase';
import { useApp } from '../AppContext';
import { fmt } from '../lib/money';
import { guessUqc, uqcName } from '../lib/uqc';
import { sayPlainly } from '../lib/offline';
import { STATES } from '../lib/states';
import { Head, Screen } from '../components/Chrome';
import { C, S } from '../theme';

// ONE BAR, AND HE FILLS IT AS FAST AS HE CAN TYPE.
//
// His own words: "A plain bar just like whatsapp... He just ticks on what he
// want to update... GLASS 50 (add)". A new shop has nothing in it, and the way
// Skwik asked him to fix that was a form of twenty boxes, once per item, eight
// hundred times. Nobody does that. So: he says WHICH three or four things he
// wants to type, and then types only those, item after item, without the form
// ever getting in the way.
//
// WHAT IS ON THE SCREEN, TOP TO BOTTOM
//
//   the tabs      items, customers, suppliers — the same bar does all three
//   the chips     the fields he wants, IN THE ORDER HE WANTS THEM. Tap to turn
//                 one on or off, drag one along to move it, hold one to call it
//                 by his own name. The chips read left to right exactly like
//                 the boxes underneath, so nothing has to explain the order.
//   three boxes   never more than three to a line, all the same width, all
//                 left aligned. The faded word in each box says what it is.
//   Save          the fourth cell, or a line of its own when the boxes fill
//                 the row exactly.
//   what he saved newest at the top, as a table with headings, because he is
//                 checking his own work and the eye runs down a column.
//
// AND THE KEY ON THE KEYBOARD SAYS NEXT, NEVER DONE.
//
// He has asked for this more than once: "TICK MARK STARTED APPEARING, INSTEAD
// OF TAB? SHALL I REPEAT EVERYTIME, I JUST WANT TAB, PLEASE REMBER THIS". So
// every box here is returnKeyType="next" — including the last one, which moves
// to Save rather than saving by itself. No custom keypad and no pop-ups.

const CHANGE = 'change';
const ANOTHER = 'another';

// THE FIELDS THERE ARE, per tab. `k` is the column it ends up in and never
// changes; `chip` is what Skwik calls it until he renames it; `short` is what a
// heading falls back to when there are five or six columns and no room for
// "Opening stock".
const FIELDS = {
  items: [
    { k: 'name',  chip: 'Item',          kind: 'text',  lock: true },
    { k: 'rate1', chip: 'Rate 1',        kind: 'money' },
    { k: 'rate2', chip: 'Rate 2',        kind: 'money' },
    { k: 'unit',  chip: 'UOM',           kind: 'unit'  },
    { k: 'stock', chip: 'Opening stock', kind: 'qty',   short: 'Op. stock' },
    { k: 'cost',  chip: 'Cost',          kind: 'money' },
    { k: 'hsn',   chip: 'HSN',           kind: 'digits' },
    { k: 'gst',   chip: 'GST %',         kind: 'pct'   },
  ],
  customers: [
    { k: 'name',  chip: 'Customer',   kind: 'text',  lock: true },
    { k: 'place', chip: 'Place',      kind: 'text'  },
    { k: 'phone', chip: 'Phone',      kind: 'phone' },
    { k: 'due',   chip: 'Owes me',    kind: 'money' },
    { k: 'gstin', chip: 'GST number', kind: 'text',  short: 'GST no.' },
  ],
  suppliers: [
    { k: 'name',  chip: 'Supplier',   kind: 'text',  lock: true },
    { k: 'place', chip: 'Place',      kind: 'text'  },
    { k: 'phone', chip: 'Phone',      kind: 'phone' },
    { k: 'due',   chip: 'I owe',      kind: 'money' },
    { k: 'gstin', chip: 'GST number', kind: 'text',  short: 'GST no.' },
  ],
};

const TABS = [
  { id: 'items',     name: 'Items' },
  { id: 'customers', name: 'Customers' },
  { id: 'suppliers', name: 'Suppliers' },
];

const isNum = (s) => /^-?\d+(\.\d+)?$/.test(String(s).replace(/[, ]/g, ''));
const money = (v) => `₹${fmt(v)}`;
const GST_STEPS = [0, 0.1, 0.25, 1, 1.5, 3, 5, 6, 7.5, 12, 18, 28];

export default function QuickAddScreen({ navigation, route }) {
  const { org } = useApp();
  const [tab, setTab] = useState(
    route?.params?.tab === 'customers' || route?.params?.tab === 'suppliers'
      ? route.params.tab : 'items');

  // which fields he wants, in his order, per tab
  const [picked, setPicked] = useState({
    items: ['name', 'rate1', 'unit'],
    customers: ['name', 'due'],
    suppliers: ['name', 'due'],
  });
  // HIS OWN NAMES FOR THEM. "As for us uom means specific thing, rate1 means
  // specific thing, how we will tackle that?" — by letting him say so. The
  // column underneath never moves; only the word on the screen changes.
  const [labels, setLabels] = useState({ items: {}, customers: {}, suppliers: {} });
  const [renaming, setRenaming] = useState(null);
  const [renameText, setRenameText] = useState('');

  const [vals, setVals] = useState({});
  const [saved, setSaved] = useState({ items: [], customers: [], suppliers: [] });
  const [book, setBook] = useState({ items: [], customers: [], suppliers: [] });
  const [dupChoice, setDupChoice] = useState(null);
  const [busy, setBusy] = useState(false);
  const [fail, setFail] = useState('');
  const [wide, setWide] = useState(0);

  const boxes = useRef([]);

  const defs = FIELDS[tab];
  const byK = useMemo(() => {
    const m = {};
    defs.forEach((f) => { m[f.k] = f; });
    return m;
  }, [defs]);
  const chosen = useMemo(() => picked[tab].map((k) => byK[k]).filter(Boolean),
    [picked, tab, byK]);

  const labelOf = useCallback((f) => (f ? (labels[tab][f.k] || f.chip) : ''), [labels, tab]);
  // his own word always wins; only Skwik's own wording is ever shortened
  const headOf = useCallback((f, many) =>
    labels[tab][f.k] || (many && f.short ? f.short : f.chip), [labels, tab]);

  /* ---------------- what is already in his book ---------------- */
  useFocusEffect(useCallback(() => {
    let on = true;
    (async () => {
      const [its, pts] = await Promise.all([
        allRows(() => supabase.from('items')
          .select('id, name, unit, sale_price, price2, purchase_price, gst_rate, hsn, opening_stock')
          .eq('is_active', true).order('id')),
        allRows(() => supabase.from('parties')
          .select('id, name, kind, area, phone, opening_balance, opening_type, gstin')
          .order('id')),
      ]);
      if (!on) return;
      setBook({
        items: its || [],
        customers: (pts || []).filter((p) => p.kind !== 'supplier'),
        suppliers: (pts || []).filter((p) => p.kind === 'supplier'),
      });
    })();
    return () => { on = false; };
  }, []));

  /* ---------------- reading what he typed ---------------- */
  const read = () => {
    const out = {}; let bad = null; let said = null;
    chosen.forEach((f) => {
      const raw = String(vals[f.k] == null ? '' : vals[f.k]).trim();
      if (raw === '') { out[f.k] = null; return; }
      if (f.kind === 'money' || f.kind === 'qty' || f.kind === 'pct') {
        if (!isNum(raw)) {
          bad = bad || `${labelOf(f)} takes a number. “${raw}” is not one.`;
          return;
        }
        out[f.k] = Number(String(raw).replace(/[, ]/g, ''));
        if (f.kind === 'pct' && !GST_STEPS.includes(out[f.k])) {
          bad = bad || `${out[f.k]}% is not a GST rate. It is 0, 5, 12, 18 or 28.`;
        }
        return;
      }
      if (f.kind === 'phone') {
        const d = raw.replace(/\D/g, '');
        if (d.length !== 10) {
          bad = bad || `A phone number is ten digits. That one has ${d.length}.`;
          return;
        }
        out[f.k] = d; return;
      }
      if (f.kind === 'digits') {
        if (!/^\d+$/.test(raw)) { bad = bad || 'An HSN code is numbers only.'; return; }
        if (![4, 6, 8].includes(raw.length)) {
          bad = bad || 'An HSN code is 4, 6 or 8 digits.'; return;
        }
        out[f.k] = raw; return;
      }
      if (f.kind === 'unit') {
        // A UNIT IS NOT A LABEL. GST returns take only their own codes, so his
        // word has to land on one of them — and Skwik says which, out loud,
        // rather than quietly turning "gattha" into something else.
        const code = guessUqc(raw);
        if (!code) {
          bad = bad || `Skwik does not know the unit “${raw}”. GST returns take `
            + 'only their own list — pieces, bundles, bags, dozens and the rest. '
            + 'Type one of those, or the word you use for it.';
          return;
        }
        out[f.k] = code;
        if (code.toLowerCase() !== raw.toLowerCase()) said = { word: raw, code };
        return;
      }
      if (f.k === 'gstin') {
        // A GST NUMBER SAYS WHICH STATE HE IS IN, AND THAT DECIDES THE TAX.
        //
        // Its first two digits are the state code. Taken as the shop's own
        // state, an out-of-state customer is billed CGST and SGST where IGST is
        // due, and the bill goes into the wrong table of GSTR-1 — so it is read
        // off the number here rather than assumed.
        const g = raw.toUpperCase();
        if (g.length !== 15) {
          bad = bad || 'A GST number is 15 characters, or leave it empty.';
          return;
        }
        if (!STATES[g.slice(0, 2)]) {
          bad = bad || 'The first two digits of a GST number are a state code, '
            + `and ${g.slice(0, 2)} is not one.`;
          return;
        }
        out[f.k] = g;
        return;
      }
      out[f.k] = raw;
    });
    if (bad) return { error: bad };
    const nm = String(out.name || '').trim();
    if (!nm) return { blank: true };
    const hit = (book[tab] || []).find(
      (r) => String(r.name || '').trim().toLowerCase() === nm.toLowerCase()) || null;
    return { v: out, name: nm, existing: hit, said };
  };
  const p = read();

  /* ---------------- saving one line ---------------- */
  const commit = async () => {
    if (busy || p.blank || p.error) return;
    if (p.existing && !dupChoice) return;
    const changing = !!p.existing && dupChoice === CHANGE;
    setBusy(true); setFail('');

    const keys = picked[tab].filter((k) => k !== 'name');
    let body;
    if (tab === 'items') {
      body = { org_id: org.id, name: p.name };
      if (p.v.rate1 != null) body.sale_price = p.v.rate1;
      if (p.v.rate2 != null) body.price2 = p.v.rate2;
      if (p.v.cost != null) body.purchase_price = p.v.cost;
      if (p.v.gst != null) body.gst_rate = p.v.gst;
      if (p.v.hsn != null) body.hsn = p.v.hsn;
      if (p.v.stock != null) body.opening_stock = p.v.stock;
      if (p.v.unit != null) body.unit = p.v.unit;
      // AN ITEM HAS TO BE COUNTED IN SOMETHING. He has not been asked for the
      // unit, so it is pieces — which is what the item sheet defaults to, and
      // he can change it there.
      if (!changing && body.unit == null) body.unit = 'PCS';
      if (!changing) body.is_active = true;
    } else {
      body = { org_id: org.id, name: p.name,
               kind: tab === 'suppliers' ? 'supplier' : 'customer' };
      if (p.v.place != null) body.area = p.v.place;
      if (p.v.phone != null) body.phone = p.v.phone;
      if (p.v.gstin != null) {
        body.gstin = p.v.gstin;
        body.is_registered = true;
        body.state_code = p.v.gstin.slice(0, 2);
        body.state_name = STATES[body.state_code];
      }
      if (p.v.due != null) {
        // the amount is a plain number and which way it runs is opening_type's
        // job, exactly as the ledger screen writes it
        body.opening_balance = Math.abs(p.v.due);
        body.opening_type = tab === 'suppliers' ? 'you_owe' : 'owes_you';
      }
      if (!changing && body.state_code == null) {
        body.state_code = org.state_code || null;
        body.state_name = org.state_name || null;
      }
    }

    const table = tab === 'items' ? 'items' : 'parties';
    // WHAT IT WAS BEFORE, so Undo on a change can put it back. Only the fields
    // this line actually touched.
    const was = {};
    if (changing) Object.keys(body).forEach((k) => {
      if (k !== 'org_id' && k !== 'name') was[k] = p.existing[k] ?? null;
    });

    const { data, error } = changing
      ? await supabase.from(table).update(body).eq('id', p.existing.id).select().single()
      : await supabase.from(table).insert(body).select().single();
    setBusy(false);
    if (error) { setFail(sayPlainly(error)); return; }

    // WHICH ROW THIS WAS. On a change it is the one he matched, and that is
    // known here without asking the server for it back. On a new row only the
    // server knows the id, and without an id there is nothing for Undo to take
    // out again — so the line says so rather than offering an Undo that would
    // quietly do nothing.
    const row = changing
      ? { ...p.existing, ...body }
      : { ...body, id: data?.id || null };
    setBook((b) => ({ ...b,
      [tab]: changing
        ? b[tab].map((r) => (r.id === p.existing.id ? { ...r, ...body } : r))
        : [...b[tab], row] }));
    setSaved((s) => ({ ...s,
      [tab]: [{ id: changing ? p.existing.id : row.id, cols: keys, v: p.v, name: p.name,
                changed: changing, was, table }, ...s[tab]].slice(0, 30) }));
    setVals({});
    setDupChoice(null);
    setTimeout(() => {
      const first = boxes.current[0];
      if (first && first.focus) first.focus();
    }, 0);
  };

  const undo = async (i) => {
    const line = saved[tab][i];
    if (!line || busy || !line.id) return;
    setBusy(true); setFail('');
    const { error } = line.changed
      ? await supabase.from(line.table).update(line.was).eq('id', line.id)
      : await supabase.from(line.table).delete().eq('id', line.id);
    setBusy(false);
    if (error) { setFail(sayPlainly(error)); return; }
    setSaved((s) => ({ ...s, [tab]: s[tab].filter((_, j) => j !== i) }));
    setBook((b) => ({ ...b,
      [tab]: line.changed
        ? b[tab].map((r) => (r.id === line.id ? { ...r, ...line.was } : r))
        : b[tab].filter((r) => r.id !== line.id) }));
  };

  /* ---------------- the chips: a tap, and a hold ---------------- */
  //
  // TAPPING A FIELD BACK ON PUTS IT AT THE END, and that is how the order is
  // changed.
  //
  // The prototype let him drag a chip along the row, and it is not here. It
  // worked on the first drag and then stopped: a chip that has been moved does
  // not report its new place until its SIZE changes, so the second drag of a
  // session was measured against where the chips used to be. I could not get it
  // right without a real phone in hand to try it on, and a gesture that works
  // once is worse than one that is not offered -- he would think the screen was
  // broken, and he would be right.
  //
  // So: off and on again, which puts a field at the end. Three taps orders four
  // fields any way he likes, it cannot half-work, and the line under the chips
  // says so in those words.
  const flip = (k) => {
    setPicked((pk) => {
      const list = pk[tab];
      const i = list.indexOf(k);
      return { ...pk, [tab]: i >= 0 ? list.filter((x) => x !== k) : [...list, k] };
    });
    setDupChoice(null);
  };

  // HOLD A FIELD TO CALL IT BY YOUR OWN NAME.
  //
  // "As for us uom means specific thing, rate1 means specific thing, how we
  // will tackle that?" — by letting him say what he calls it. The box appears
  // UNDER the chips rather than in place of one, so nothing is taken off the
  // screen while his finger is still on it.
  const finishRename = (text) => {
    if (renaming == null) return;
    const f = byK[renaming];
    const t = String(text || '').trim();
    setLabels((L) => {
      const mine = { ...L[tab] };
      if (t && f && t.toLowerCase() !== f.chip.toLowerCase()) mine[f.k] = t;
      else if (f) delete mine[f.k];
      return { ...L, [tab]: mine };
    });
    setRenaming(null);
  };

  /* ---------------- laying the chips out, in his order ---------------- */
  const chipList = useMemo(() => {
    const on = picked[tab].map((k) => byK[k]).filter(Boolean);
    const off = defs.filter((f) => picked[tab].indexOf(f.k) < 0);
    return on.concat(off);
  }, [picked, tab, byK, defs]);

  /* ---------------- three to a line, measured, not guessed ---------------- */
  const GAP = 10;
  const cell = wide > 0 ? Math.floor((wide - GAP * 2) / 3) : 0;
  const fullSave = chosen.length % 3 === 0;

  const switchTab = (id) => {
    setTab(id); setVals({}); setDupChoice(null); setRenaming(null); setFail('');
  };

  /* ---------------- what he has just put in ---------------- */
  const table = useMemo(() => {
    const list = saved[tab];
    if (!list.length) return null;
    const fs = chosen;
    const many = fs.length >= 5;
    // EACH COLUMN GETS ROOM IN PROPORTION TO WHAT IT HOLDS. Sharing it equally
    // spends as much on UOM, which holds "PCS", as on the name, which holds
    // thirty characters — and then breaks the heading through the middle of a
    // word.
    const weight = (f, i) => (i === 0 ? 2.1
      : (f.kind === 'unit' || f.kind === 'pct') ? 0.95 : 1.15);
    return { fs, many, weight, list };
  }, [saved, tab, chosen]);

  const cellText = (f, line) => {
    const had = line.cols.indexOf(f.k) >= 0 || f.k === 'name';
    const v = f.k === 'name' ? line.name : (had ? line.v[f.k] : null);
    if (v == null) return { txt: '—', blank: true };
    if (f.kind === 'money') return { txt: money(v) };
    if (f.kind === 'pct') return { txt: `${v}%` };
    return { txt: String(v) };
  };

  return (
    <Screen>
      <Head navigation={navigation} title="Add many, quickly" />

      <ScrollView keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>

        {/* WHAT HE IS ADDING */}
        <View style={[S.row, { gap: 24, borderBottomWidth: 1, borderBottomColor: C.line }]}>
          {TABS.map((t) => {
            const on = tab === t.id;
            return (
              <TouchableOpacity key={t.id} onPress={() => switchTab(t.id)}
                hitSlop={{ top: 10, bottom: 10, left: 6, right: 6 }}
                style={{ paddingBottom: 11, borderBottomWidth: 2, marginBottom: -1,
                         borderBottomColor: on ? C.accent : 'transparent' }}>
                <Text style={{ fontSize: 15, fontWeight: '600',
                               color: on ? C.ink : C.faint }}>{t.name}</Text>
              </TouchableOpacity>
            );
          })}
        </View>

        {/* THE FIELDS HE WANTS, IN HIS ORDER */}
        <View style={[S.row, { flexWrap: 'wrap', gap: 8, marginTop: 18 }]}>
          {chipList.map((f) => {
            const on = picked[tab].indexOf(f.k) >= 0;
            return (
              <TouchableOpacity key={f.k}
                onPress={() => { if (!f.lock) flip(f.k); }}
                onLongPress={() => {
                  if (f.lock) return;
                  setRenaming(f.k);
                  setRenameText(labelOf(f));
                }}
                delayLongPress={500}
                hitSlop={{ top: 6, bottom: 6, left: 4, right: 4 }}
                style={{ paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999,
                         borderWidth: 1,
                         borderColor: on ? C.accent : C.line,
                         backgroundColor: on ? C.accentSoft : C.surface }}>
                <Text style={{ fontSize: 14, fontWeight: '600',
                               color: on ? C.accent : C.muted }}>{labelOf(f)}</Text>
              </TouchableOpacity>
            );
          })}
        </View>

        {/* AND THE BOX FOR HIS OWN NAME, UNDER THE CHIPS.
            In place of the chip it would be taken off the screen while his
            finger is still down, which is how the drag used to die. */}
        {renaming != null && (
          <View style={{ marginTop: 12 }}>
            <Text style={{ fontSize: 12, color: C.muted, marginBottom: 6 }}>
              What do you call {byK[renaming]?.chip}?
            </Text>
            <View style={[S.row, { gap: 10 }]}>
              <TextInput value={renameText} onChangeText={setRenameText}
                autoFocus selectTextOnFocus returnKeyType="next" blurOnSubmit={false}
                onSubmitEditing={() => finishRename(renameText)}
                placeholder={byK[renaming]?.chip} placeholderTextColor={C.faint}
                style={[S.input, { flex: 1, borderWidth: 1, borderColor: C.accent,
                                   borderRadius: 8 }]} />
              <TouchableOpacity onPress={() => finishRename(renameText)}
                style={{ paddingHorizontal: 16, justifyContent: 'center', borderRadius: 8,
                         borderWidth: 1, borderColor: C.line }}>
                <Text style={{ fontSize: 14, fontWeight: '700', color: C.accent }}>Done</Text>
              </TouchableOpacity>
            </View>
            <Text style={{ fontSize: 12, color: C.faint, marginTop: 6, lineHeight: 17 }}>
              Leave it empty to go back to {byK[renaming]?.chip}.
            </Text>
          </View>
        )}

        <Text style={{ fontSize: 12.5, color: C.faint, marginTop: 10, lineHeight: 18 }}>
          Tap a field to add it or take it away. One you add goes to the end, so
          off and on again moves it. Hold one to call it by your own name.
        </Text>

        {tab === 'items' && picked.items.indexOf('stock') >= 0 && (
          <Text style={{ fontSize: 13, color: C.muted, marginTop: 10, lineHeight: 19 }}>
            Opening stock is what was on the shelf when your books opened. It goes
            in as it stands today; move it between stores later if you keep more
            than one.
          </Text>
        )}

        {/* THE BOXES. Three to a line, every one the same width, every one left
            aligned, and the faded word inside says what it is. */}
        <View onLayout={(e) => setWide(e.nativeEvent.layout.width)}
          style={[S.row, { flexWrap: 'wrap', gap: GAP, marginTop: 16 }]}>
          {cell > 0 && chosen.map((f, i) => (
            <TextInput key={f.k}
              ref={(r) => { boxes.current[i] = r; }}
              value={vals[f.k] == null ? '' : String(vals[f.k])}
              onChangeText={(t) => { setVals((v) => ({ ...v, [f.k]: t })); setDupChoice(null); }}
              placeholder={labelOf(f)}
              placeholderTextColor={C.faint}
              autoCapitalize={f.kind === 'unit' ? 'characters'
                : f.kind === 'text' ? 'words' : 'none'}
              autoCorrect={false}
              keyboardType={f.kind === 'money' || f.kind === 'qty' || f.kind === 'pct'
                ? 'decimal-pad' : f.kind === 'phone' || f.kind === 'digits'
                ? 'number-pad' : 'default'}
              // NEXT, NEVER DONE — and the last box moves to Save instead of
              // saving on its own, so nothing is written by a key he pressed
              // to get out of a box.
              returnKeyType="next"
              blurOnSubmit={false}
              onSubmitEditing={() => {
                const nx = boxes.current[i + 1];
                if (nx && nx.focus) nx.focus();
                else if (boxes.current[0] && boxes.current[0].blur) boxes.current[0].blur();
              }}
              style={[S.input, { width: cell, textAlign: 'left',
                                 borderWidth: 1, borderColor: C.line, borderRadius: 8 }]} />
          ))}

          {cell > 0 && (
            <TouchableOpacity onPress={commit}
              disabled={busy || !!p.error || !!p.blank || (!!p.existing && !dupChoice)}
              style={{ width: fullSave ? '100%' : cell, borderRadius: 8, borderWidth: 1,
                       alignItems: 'center', justifyContent: 'center', paddingVertical: 13,
                       borderColor: (busy || p.error || p.blank || (p.existing && !dupChoice))
                         ? C.line : C.accent,
                       backgroundColor: (busy || p.error || p.blank || (p.existing && !dupChoice))
                         ? C.surface : C.accent }}>
              <Text style={{ fontSize: 14, fontWeight: '700',
                             color: (busy || p.error || p.blank || (p.existing && !dupChoice))
                               ? C.faint : '#fff' }}>
                {busy ? 'Saving…'
                  : (p.existing && dupChoice === CHANGE) ? 'Change' : 'Save'}
              </Text>
            </TouchableOpacity>
          )}
        </View>

        {/* WHAT SKWIK HAS TO SAY ABOUT THE LINE, BEFORE IT IS SAVED */}
        {!!p.error && (
          <View style={{ marginTop: 12, padding: 11, borderRadius: 8,
                         backgroundColor: C.redL }}>
            <Text style={{ fontSize: 13.5, color: C.danger, lineHeight: 20 }}>{p.error}</Text>
          </View>
        )}

        {!p.error && !!p.existing && !dupChoice && (
          <View style={{ marginTop: 12, padding: 11, borderRadius: 8,
                         backgroundColor: C.flagSoft }}>
            <Text style={{ fontSize: 13.5, color: C.flagInk, lineHeight: 20 }}>
              {p.name} is already in your book{alreadyHad(p.existing, chosen, labelOf)}.
            </Text>
            <View style={[S.row, { gap: 10, marginTop: 9, flexWrap: 'wrap' }]}>
              <TouchableOpacity onPress={() => setDupChoice(CHANGE)}
                style={{ paddingHorizontal: 13, paddingVertical: 7, borderRadius: 7,
                         borderWidth: 1, borderColor: C.flagInk, backgroundColor: C.flagInk }}>
                <Text style={{ fontSize: 13, fontWeight: '700', color: '#fff' }}>Change it</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => setDupChoice(ANOTHER)}
                style={{ paddingHorizontal: 13, paddingVertical: 7, borderRadius: 7,
                         borderWidth: 1, borderColor: C.flagInk }}>
                <Text style={{ fontSize: 13, fontWeight: '700', color: C.flagInk }}>
                  Add another
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        )}

        {!p.error && !p.existing && !!p.said && (
          <View style={{ marginTop: 12, padding: 11, borderRadius: 8,
                         backgroundColor: C.accentSoft }}>
            <Text style={{ fontSize: 13.5, color: C.muted, lineHeight: 20 }}>
              “{p.said.word}” is {uqcName(p.said.code)} — kept as {p.said.code},
              which is what GST returns take.
            </Text>
          </View>
        )}

        {!!fail && (
          <View style={{ marginTop: 12, padding: 11, borderRadius: 8, backgroundColor: C.redL }}>
            <Text style={{ fontSize: 13.5, color: C.danger, lineHeight: 20 }}>{fail}</Text>
          </View>
        )}

        {tab === 'items' && org?.is_gst_registered && picked.items.indexOf('hsn') < 0 && (
          <Text style={{ fontSize: 12.5, color: C.muted, marginTop: 12, lineHeight: 18 }}>
            A GST bill needs an HSN code against each item. Turn HSN on above to
            type them as you go, or add them later on the item.
          </Text>
        )}

        {/* AND WHAT HE HAS JUST PUT IN, NEWEST FIRST */}
        {!!table && (
          <View style={{ marginTop: 24 }}>
            <Text style={{ fontSize: 12, color: C.faint, marginBottom: 10 }}>
              Saved · newest first
            </Text>
            <Rows t={table} cellText={cellText} headOf={headOf} undo={undo} busy={busy} />
          </View>
        )}

        <Text style={{ fontSize: 12.5, color: C.faint, marginTop: 22, lineHeight: 19 }}>
          Every line is saved the moment you tap Save. Undo takes one back out
          again. When you are done, everything is on the Items and Ledgers
          screens as usual.
        </Text>
      </ScrollView>
    </Screen>
  );
}

// WHAT THE BOOK ALREADY HOLDS FOR THIS NAME, in the fields he is typing — so
// "already there" is not a dead end but a comparison he can act on.
function alreadyHad(row, fields, labelOf) {
  const said = fields.filter((f) => f.k !== 'name').map((f) => {
    const col = { rate1: 'sale_price', rate2: 'price2', cost: 'purchase_price',
                  gst: 'gst_rate', stock: 'opening_stock', unit: 'unit', hsn: 'hsn',
                  place: 'area', phone: 'phone', due: 'opening_balance', gstin: 'gstin' }[f.k];
    const v = col ? row[col] : null;
    if (v == null || v === '' || v === 0) return null;
    return `${labelOf(f)} ${f.kind === 'money' ? money(v) : v}`;
  }).filter(Boolean).join(' · ');
  return said ? ` — ${said}` : '';
}

// The table is its own part so that typing in a box does not redraw every
// saved line underneath it.
const Rows = React.memo(function Rows({ t, cellText, headOf, undo, busy }) {
  const { fs, many, weight, list } = t;
  const total = fs.reduce((s, f, i) => s + weight(f, i), 0);
  const body = (
    <View>
      <View style={[S.row, { borderBottomWidth: 1, borderBottomColor: C.line,
                             paddingBottom: 8, alignItems: 'flex-start' }]}>
        {fs.map((f, i) => (
          <Text key={f.k} style={{ flex: weight(f, i) / total, fontSize: 10.5,
                                   fontWeight: '600', color: C.faint, lineHeight: 14,
                                   paddingRight: 6 }}>
            {headOf(f, many)}
          </Text>
        ))}
        <View style={{ width: 44 }} />
      </View>
      {list.map((line, ix) => (
        <View key={`${line.id}_${ix}`}
          style={[S.row, { borderBottomWidth: 1, borderBottomColor: C.line,
                           paddingVertical: 10, alignItems: 'flex-start' }]}>
          {fs.map((f, i) => {
            const { txt, blank } = cellText(f, line);
            return (
              <Text key={f.k} style={{ flex: weight(f, i) / total, paddingRight: 6,
                                       fontSize: f.k === 'name' ? 14 : 13.5, lineHeight: 18,
                                       color: blank ? C.faint : (line.changed ? C.flagInk : C.ink) }}>
                {txt}
              </Text>
            );
          })}
          <TouchableOpacity onPress={() => undo(ix)} disabled={busy || !line.id}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            style={{ width: 44, alignItems: 'flex-end' }}>
            <Text style={{ fontSize: 12.5, color: (busy || !line.id) ? C.faint : C.accent }}>
              {line.id ? 'Undo' : 'Saved'}
            </Text>
          </TouchableOpacity>
        </View>
      ))}
    </View>
  );
  // SIX FIELDS FIT THE PAGE. Past that a column gets narrower than the word
  // "Opening" and the heading breaks through the middle of it, which is worse
  // than a small sideways nudge — so seven or more keeps a floor under each
  // column and the table slides.
  if (fs.length <= 6) return body;
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator
      contentContainerStyle={{ minWidth: 110 + (fs.length - 1) * 74 + 44 }}>
      {body}
    </ScrollView>
  );
});
