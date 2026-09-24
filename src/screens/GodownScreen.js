import React, { useCallback, useMemo, useRef, useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, ScrollView, Alert } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';

import { supabase, allRows } from '../lib/supabase';
import { useApp } from '../AppContext';
import { fmt0, num, qty as qtyText, today } from '../lib/money';
import { uqcShort } from '../lib/uqc';
import { searchItems } from '../lib/search';
import { sayPlainly } from '../lib/offline';
import { Box, Head, Screen, Foot } from '../components/Chrome';
import { C, S } from '../theme';

// TWO STORES, ONE BOOK.
//
// A shop with a back godown and a counter store has the same item in two
// places, and "how many do I have" has two answers. Every movement already
// says where it happened; this is where he names the places and moves goods
// between them. A transfer is two movements and no money — nothing about the
// ledger or the tax changes.

export default function GodownScreen({ navigation }) {
  const { org, reloadOrg } = useApp();
  const [list, setList]   = useState([]);
  const [stock, setStock] = useState([]);
  const [items, setItems] = useState([]);
  const [name, setName]   = useState('');
  // Android has no Alert.prompt, so the rename box is drawn in the row itself
  const [renaming, setRenaming] = useState(null);
  const [busy, setBusy]   = useState(false);

  // the move being built
  const [from, setFrom] = useState(null);
  const [to, setTo]     = useState(null);
  const [q, setQ]       = useState('');
  const [lines, setLines] = useState([]);
  const seq = useRef(0);

  const load = useCallback(async () => {
    // the stock rows are one per item PER STORE per batch, so a few hundred
    // items is already past the 1,000 the server hands back without a word
    const [{ data: gs }, st, its] = await Promise.all([
      supabase.from('godowns').select('*').order('name'),
      allRows(() => supabase.from('stock_in_hand_detail').select('*').order('item_id')),
      allRows(() => supabase.from('items').select('id, name, unit')
        .eq('is_active', true).order('name').order('id')),
    ]);
    setList(gs || []);
    setStock(st || []);
    setItems(its || []);
    if (!from && (gs || []).length) setFrom(gs.find((g) => g.is_main)?.id || gs[0].id);
    if (!to && (gs || []).length > 1) setTo(gs.find((g) => g.id !== (gs[0].id))?.id || null);
  }, [from, to]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const add = async () => {
    const n = name.trim();
    if (!n) return Alert.alert('Name', 'What is this godown called?');
    setBusy(true);
    const first = list.length === 0;
    const { data, error } = await supabase.from('godowns')
      .insert({ org_id: org.id, name: n, is_main: first }).select().single();
    if (!error && first) {
      await supabase.from('orgs')
        .update({ godowns_enabled: true, default_godown_id: data.id }).eq('id', org.id);
      await reloadOrg();
    }
    setBusy(false);
    if (error) return Alert.alert('Could not add', sayPlainly(error));
    setName('');
    load();
  };

  // A GODOWN GETS ITS NAME WRONG ONCE AND KEEPS IT FOR EVER.
  //
  // There was no way to change it. A typo, a shed that moved, a name the men
  // stopped using — the only way out was a second godown and moving every
  // item across. Renaming touches nothing but the name: every entry ever
  // made points at the godown's id, not its name, so the whole history
  // follows it across without moving a single piece of stock.
  const rename = (g) => {
    Alert.prompt
      ? Alert.prompt('Rename this godown', `Now called ${g.name}.`,
          [{ text: 'Cancel', style: 'cancel' },
           { text: 'Save', onPress: (t) => doRename(g, t) }],
          'plain-text', g.name)
      : setRenaming({ id: g.id, name: g.name });
  };
  const doRename = async (g, t) => {
    const n = String(t || '').trim();
    if (!n) return;
    if (n === g.name) return setRenaming(null);
    const clash = list.some((x) => x.id !== g.id
      && x.name.trim().toLowerCase() === n.toLowerCase());
    if (clash) return Alert.alert('That name is taken',
      'Another godown is already called that. Two stores with one name make '
      + 'the stock summary impossible to read.');
    const { error } = await supabase.from('godowns').update({ name: n }).eq('id', g.id);
    if (error) return Alert.alert('Could not rename', sayPlainly(error));
    setRenaming(null);
    load();
  };

  const makeMain = async (g) => {
    await supabase.from('godowns').update({ is_main: false }).eq('org_id', org.id);
    await supabase.from('godowns').update({ is_main: true }).eq('id', g.id);
    await supabase.from('orgs').update({ default_godown_id: g.id }).eq('id', org.id);
    await reloadOrg();
    load();
  };

  // what is in a given godown right now
  const inGodown = useMemo(() => {
    const m = {};
    stock.forEach((r) => {
      const k = `${r.godown_id || 'none'}|${r.item_id}|${r.batch || ''}`;
      m[k] = m[k] || { ...r, qty: 0 };
      m[k].qty = num(m[k].qty) + num(r.qty);
    });
    return Object.values(m).filter((r) => num(r.qty) !== 0);
  }, [stock]);

  const hereNow = (itemId, batch) => {
    const r = inGodown.find((x) => x.item_id === itemId && (x.godown_id || null) === from
                                && (x.batch || '') === (batch || ''));
    return r ? num(r.qty) : 0;
  };

  const hits = q.trim() ? searchItems(items, q, 8) : [];

  const addLine = (h) => {
    seq.current += 1;
    setLines((ls) => [{ key: seq.current, item_id: h.p.id, item_name: h.p.name,
                        unit: h.p.unit, qty: '', batch: '' }, ...ls]);
    setQ('');
  };
  const setLine = (key, patch) =>
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  const move = async () => {
    if (!from || !to) return Alert.alert('Which godowns?', 'Choose where it goes from and to.');
    if (from === to) return Alert.alert('Same godown', 'Those are the same place.');
    const good = lines.filter((l) => num(l.qty) > 0);
    if (!good.length) return Alert.alert('Nothing to move', 'Add an item and a quantity.');

    const short = good.find((l) => num(l.qty) > hereNow(l.item_id, l.batch));
    if (short) {
      return Alert.alert('More than you have',
        `${short.item_name}: only ${qtyText(hereNow(short.item_id, short.batch))} `
        + 'is in that godown. Move it anyway?',
        [{ text: 'Let me check' }, { text: 'Move anyway', onPress: () => send(good) }]);
    }
    send(good);
  };

  const send = async (good) => {
    setBusy(true);
    const { error } = await supabase.rpc('transfer_stock', {
      p: { from_godown: from, to_godown: to, mdate: today(),
           lines: good.map((l) => ({ item_id: l.item_id, qty: num(l.qty),
                                     batch: (l.batch || '').trim() || null })) },
    });
    setBusy(false);
    if (error) return Alert.alert('Could not move it', sayPlainly(error));
    setLines([]);
    load();
    Alert.alert('Moved', `${good.length} item${good.length === 1 ? '' : 's'} moved.`);
  };

  const Pick = ({ value, onChange, not }) => (
    <View style={[S.row, { gap: 8, flexWrap: 'wrap', marginTop: 6 }]}>
      {list.filter((g) => g.id !== not).map((g) => {
        const on = value === g.id;
        return (
          <TouchableOpacity key={g.id} onPress={() => onChange(g.id)}
            style={{ paddingHorizontal: 13, paddingVertical: 9, borderRadius: 9,
                     borderWidth: 1, borderColor: on ? C.accent : C.line,
                     backgroundColor: on ? C.accentSoft : C.surface }}>
            <Text style={{ fontSize: 13.5, fontWeight: '700', color: on ? C.accent : C.muted }}>
              {g.name}
            </Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );

  return (
    <Screen>
      <Head navigation={navigation} title="Godowns" />
      <ScrollView keyboardShouldPersistTaps="handled"
                  contentContainerStyle={{ padding: 14, paddingBottom: 40 }}>

        <Text style={S.eyebrow}>Your stores</Text>
        {list.map((g) => {
          const held = inGodown.filter((r) => (r.godown_id || null) === g.id);
          return (
            <View key={g.id} style={[S.line, { marginBottom: 8 }]}>
              <View style={S.row}>
                <View style={{ flex: 1 }}>
                  {renaming && renaming.id === g.id ? (
                    <Box autoFocus value={renaming.name}
                      onChangeText={(t) => setRenaming((r) => ({ ...r, name: t }))}
                      onSubmit={() => doRename(g, renaming.name)} />
                  ) : (
                    <Text style={S.lineNm}>{g.name}{g.is_main ? '  · main' : ''}</Text>
                  )}
                  <Text style={{ fontSize: 11.5, color: C.muted, marginTop: 2 }}>
                    {held.length} item{held.length === 1 ? '' : 's'} in hand
                  </Text>
                </View>
                {renaming && renaming.id === g.id ? (
                  <View style={[S.row, { gap: 12 }]}>
                    <TouchableOpacity onPress={() => doRename(g, renaming.name)}>
                      <Text style={{ fontSize: 12, fontWeight: '800', color: C.accent }}>SAVE</Text>
                    </TouchableOpacity>
                    <TouchableOpacity onPress={() => setRenaming(null)}>
                      <Text style={{ fontSize: 12, fontWeight: '800', color: C.muted }}>CANCEL</Text>
                    </TouchableOpacity>
                  </View>
                ) : (
                  <View style={[S.row, { gap: 12 }]}>
                    <TouchableOpacity onPress={() => setRenaming({ id: g.id, name: g.name })}>
                      <Text style={{ fontSize: 12, fontWeight: '800', color: C.muted }}>RENAME</Text>
                    </TouchableOpacity>
                    {!g.is_main && (
                      <TouchableOpacity onPress={() => makeMain(g)}>
                        <Text style={{ fontSize: 12, fontWeight: '800', color: C.accent }}>
                          MAKE MAIN
                        </Text>
                      </TouchableOpacity>
                    )}
                  </View>
                )}
              </View>
            </View>
          );
        })}

        <View style={[S.row, { gap: 8, marginTop: 6 }]}>
          <Box style={{ flex: 1 }} value={name} onChangeText={setName}
            placeholder="Chamber Road" onSubmit={add} />
          <TouchableOpacity style={[S.btnGhost, { paddingHorizontal: 18, paddingVertical: 12 }]}
            onPress={add} disabled={busy}>
            <Text style={S.ghostText}>ADD</Text>
          </TouchableOpacity>
        </View>
        {list.length === 0 && (
          <Text style={{ fontSize: 12.5, color: C.muted, marginTop: 8, lineHeight: 18 }}>
            Add your main store first. Everything already in your books counts as
            being there, and a second store can be added after it.
          </Text>
        )}

        {list.length > 1 && (
          <>
            <Text style={[S.eyebrow, { marginTop: 26 }]}>Move goods</Text>
            <Text style={S.label}>FROM</Text>
            <Pick value={from} onChange={setFrom} not={to} />
            <Text style={[S.label, { marginTop: 12 }]}>TO</Text>
            <Pick value={to} onChange={setTo} not={from} />

            <TextInput style={[S.input, { marginTop: 14 }]} value={q} onChangeText={setQ}
              placeholder="Which item?" placeholderTextColor={C.faint}
              returnKeyType="next" submitBehavior="submit"
              onSubmitEditing={() => { if (hits.length) addLine(hits[0]); }} />
            {hits.map((h) => (
              <TouchableOpacity key={h.p.id} onPress={() => addLine(h)}
                style={{ paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: C.line }}>
                <Text style={{ fontSize: 15, fontWeight: '700', color: C.ink }}>{h.p.name}</Text>
                <Text style={{ fontSize: 11.5, color: C.muted, marginTop: 2 }}>
                  {qtyText(hereNow(h.p.id, ''))} {uqcShort(h.p.unit)} here
                </Text>
              </TouchableOpacity>
            ))}

            {lines.map((l) => (
              <View key={l.key} style={[S.line, { marginTop: 10 }]}>
                <View style={S.row}>
                  <Text style={[S.lineNm, { flex: 1 }]}>{l.item_name}</Text>
                  <TouchableOpacity onPress={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}>
                    <Text style={{ fontSize: 20, color: C.danger }}>×</Text>
                  </TouchableOpacity>
                </View>
                <View style={[S.row, { gap: 8, marginTop: 8 }]}>
                  <View style={{ flex: 1 }}>
                    <Text style={S.cellLabel}>How many</Text>
                    <TextInput style={[S.cell, S.num]} keyboardType="numeric"
                      value={l.qty} onChangeText={(t) => setLine(l.key, { qty: t })} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={S.cellLabel}>In that store</Text>
                    <Text style={{ fontSize: 15, fontWeight: '700', color: C.muted,
                                   paddingVertical: 11 }}>
                      {qtyText(hereNow(l.item_id, l.batch))} {uqcShort(l.unit)}
                    </Text>
                  </View>
                </View>
              </View>
            ))}
          </>
        )}
      </ScrollView>

      {list.length > 1 && lines.length > 0 && (
        <Foot>
          <View style={{ flex: 1 }}>
            <Text style={S.barTotL}>MOVING</Text>
            <Text style={{ fontSize: 17, fontWeight: '800', color: C.ink }}>
              {lines.filter((l) => num(l.qty) > 0).length} items
            </Text>
          </View>
          <TouchableOpacity style={[S.btn, busy && { backgroundColor: C.faint }]}
            onPress={move} disabled={busy}>
            <Text style={S.btnText}>{busy ? 'Moving…' : 'Move them'}</Text>
          </TouchableOpacity>
        </Foot>
      )}
    </Screen>
  );
}
