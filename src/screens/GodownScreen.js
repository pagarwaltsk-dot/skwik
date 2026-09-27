import React, { useCallback, useMemo, useState } from 'react';
import { View, Text, TouchableOpacity, ScrollView, Alert } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';

import { supabase, allRows } from '../lib/supabase';
import { useApp } from '../AppContext';
import { num } from '../lib/money';
import { sayPlainly } from '../lib/offline';
import { Box, Head, Screen } from '../components/Chrome';
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
  const [name, setName]   = useState('');
  // Android has no Alert.prompt, so the rename box is drawn in the row itself
  const [renaming, setRenaming] = useState(null);
  const [busy, setBusy]   = useState(false);


  const load = useCallback(async () => {
    // the stock rows are one per item PER STORE per batch, so a few hundred
    // items is already past the 1,000 the server hands back without a word
    const [{ data: gs }, st] = await Promise.all([
      supabase.from('godowns').select('*').order('name'),
      allRows(() => supabase.from('stock_in_hand_detail').select('*').order('item_id')),
    ]);
    setList(gs || []);
    setStock(st || []);
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const add = async () => {
    const n = name.trim();
    if (!n) return Alert.alert('Name', 'What is this godown called?');
    setBusy(true);
    const first = list.length === 0;
    const { data, error } = await supabase.from('godowns')
      .insert({ org_id: org.id, name: n, is_main: first }).select().single();
    if (!error && first) {
      // THE FIRST GODOWN SWITCHES GODOWNS ON. If this write fails the godown
      // exists and nothing in the app can see it, which looks exactly like the
      // add having failed -- except that adding it again makes two.
      const { error: oe } = await supabase.from('orgs')
        .update({ godowns_enabled: true, default_godown_id: data.id }).eq('id', org.id);
      if (oe) {
        setBusy(false);
        return Alert.alert(`${n} is saved, but stores are still switched off`,
          `${sayPlainly(oe)}\n\nTurn "More than one godown" on under Settings, or try again here.`);
      }
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

  // CHANGING THE MAIN STORE IS THREE WRITES, AND HALF OF IT IS WORSE THAN NONE.
  //
  // The first clears the flag everywhere, the second sets it on the new one,
  // the third points the firm at it. None of them was checked. If the first
  // went through and the second did not, the shop is left with NO main store
  // at all -- and every function that falls back to "the main one, or the
  // first by name" then quietly picks a different godown, so goods start
  // landing in the wrong store with nothing anywhere saying so.
  //
  // So each step is checked, and if the second fails the first is put back.
  const makeMain = async (g) => {
    const was = list.find((x) => x.is_main);
    const clear = await supabase.from('godowns')
      .update({ is_main: false }).eq('org_id', org.id);
    if (clear.error) return Alert.alert('Could not change the main store', sayPlainly(clear.error));

    const set = await supabase.from('godowns').update({ is_main: true }).eq('id', g.id);
    if (set.error) {
      // put it back the way it was, so the shop is never left without one
      if (was) await supabase.from('godowns').update({ is_main: true }).eq('id', was.id);
      return Alert.alert('Could not change the main store',
        `${sayPlainly(set.error)}\n\n${was ? `${was.name} is still the main store.` : ''}`);
    }

    const point = await supabase.from('orgs')
      .update({ default_godown_id: g.id }).eq('id', org.id);
    if (point.error) {
      return Alert.alert('Half done',
        `${g.name} is now the main store, but Skwik could not be told to use it by default: `
        + `${sayPlainly(point.error)} Try again.`);
    }
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

        {/* MOVING GOODS USED TO BE DONE HERE TOO, AND IS NOT ANY MORE.
            //
            // A shop with two stores had the transfer on this screen, three
            // taps inside Settings, which is the last place a man looks when
            // he is standing in front of a shelf. It lives under Stock now,
            // beside the list he is already reading, together with the stock
            // count that never existed at all. This screen does the one thing
            // its name promises: it names the stores. */}
        {list.length > 1 && (
          <TouchableOpacity onPress={() => navigation.navigate('StockMove')}
            style={{ marginTop: 26, paddingVertical: 14, paddingHorizontal: 13,
                     borderRadius: 11, borderWidth: 1, borderColor: C.line,
                     backgroundColor: C.surface }}>
            <Text style={{ fontSize: 15, fontWeight: '700', color: C.accent }}>
              Move goods between stores {'\u203A'}
            </Text>
            <Text style={{ fontSize: 12.5, color: C.muted, marginTop: 4, lineHeight: 18 }}>
              Under Stock, with the stock count. Nothing is bought or sold and no
              tax arises — the same goods are simply somewhere else.
            </Text>
          </TouchableOpacity>
        )}
      </ScrollView>

    </Screen>
  );
}
