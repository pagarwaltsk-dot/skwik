import React, { useCallback, useMemo, useState } from 'react';
import { View, Text, TouchableOpacity, FlatList, TextInput } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { supabase, allRows } from '../lib/supabase';
import { useApp } from '../AppContext';
import { num, qty as qtyText, today } from '../lib/money';
import { uqcShort } from '../lib/uqc';
import { showBatch, showExpiry, showGodowns } from '../lib/features';
import { Head, Screen } from '../components/Chrome';
import { C, S } from '../theme';

// WHAT IS LEFT, AND WHERE IT IS.
//
// One store and no batches: a plain list, as it always was. A shop with two
// godowns gets a strip along the top to switch between them, and one keeping
// batches sees each batch on its own line with its expiry beside it — a date
// in red once it has passed.

const dmy = (d) => (d ? `${String(d).slice(8, 10)}/${String(d).slice(5, 7)}/${String(d).slice(2, 4)}` : '');

export default function StockScreen({ navigation }) {
  const { org } = useApp();
  const [rows, setRows] = useState([]);
  const [godowns, setGodowns] = useState([]);
  const [where, setWhere] = useState('all');
  const [q, setQ] = useState('');

  const detailed = showGodowns(org) || showBatch(org) || showExpiry(org);

  useFocusEffect(useCallback(() => {
    let on = true;
    (async () => {
      if (!detailed) {
      // EVERY ROW, NOT THE FIRST THOUSAND.
      // PostgREST stops at 1,000 and says nothing, so a shop past that simply
      // had no stock for the rest of its items — shown as nothing in hand, and
      // refused when it tried to move them.
        const data = await allRows(() => supabase.from('stock_in_hand')
          .select('*').order('name').order('item_id'));
        if (on) setRows(data || []);
        return;
      }
      const [st, { data: gs }] = await Promise.all([
        allRows(() => supabase.from('stock_in_hand_detail')
          .select('*').order('item_name').order('item_id')),
        showGodowns(org) ? supabase.from('godowns').select('*').order('name')
                         : Promise.resolve({ data: [] }),
      ]);
      if (!on) return;
      setRows(st || []);
      setGodowns(gs || []);
    })();
    return () => { on = false; };
  }, [detailed, org?.godowns_enabled]));

  const shown = useMemo(() => {
    const text = q.trim().toLowerCase();
    if (!detailed) {
      return rows.filter((r) => String(r.name || '').toLowerCase().includes(text));
    }
    // roll up to one line per item, or per item and batch when batches are kept
    const keep = rows.filter((r) => (where === 'all' || (r.godown_id || 'none') === where));
    const m = {};
    keep.forEach((r) => {
      const k = showBatch(org) || showExpiry(org)
        ? `${r.item_id}|${r.batch || ''}|${r.expiry || ''}`
        : `${r.item_id}`;
      m[k] = m[k] || { ...r, qty: 0, places: new Set() };
      m[k].qty = num(m[k].qty) + num(r.qty);
      if (r.godown_name) m[k].places.add(r.godown_name);
    });
    return Object.values(m)
      .filter((r) => num(r.qty) !== 0)
      .filter((r) => String(r.item_name || '').toLowerCase().includes(text))
      .sort((a, b) => String(a.item_name).localeCompare(String(b.item_name)));
  }, [rows, q, where, detailed, org]);

  // toISOString() answers in UTC, which is five and a half hours behind
  // India: between midnight and half past five a batch expiring today was
  // still being drawn in red as expired yesterday. today() is the whole
  // app's answer to this and is what every other date here goes through.
  const todayStr = today();

  return (
    <Screen>
      <Head navigation={navigation} title="Stock in hand" />

      {godowns.length > 1 && (
        <View style={{ backgroundColor: C.surface, paddingHorizontal: 12, paddingVertical: 8,
                       borderBottomWidth: 1, borderBottomColor: C.line }}>
          <View style={[S.row, { gap: 6, flexWrap: 'wrap' }]}>
            {[{ id: 'all', name: 'Everywhere' }, ...godowns].map((g) => {
              const on = where === g.id;
              return (
                <TouchableOpacity key={g.id} onPress={() => setWhere(g.id)}
                  style={{ paddingHorizontal: 12, paddingVertical: 8, borderRadius: 9,
                           borderWidth: 1, borderColor: on ? C.accent : C.line,
                           backgroundColor: on ? C.accentSoft : C.surface }}>
                  <Text style={{ fontSize: 12.5, fontWeight: '700',
                                 color: on ? C.accent : C.muted }}>{g.name}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>
      )}

      <View style={{ padding: 16, paddingBottom: 10 }}>
        <TextInput style={S.input} placeholder="Search" value={q} onChangeText={setQ}
          placeholderTextColor={C.faint} returnKeyType="search" />
        <Text style={{ fontSize: 11.5, color: C.muted, marginTop: 8 }}>
          Tap any item to see every movement in and out of it.
        </Text>
      </View>

      <FlatList
        data={shown}
        keyExtractor={(i, ix) => `${i.item_id || i.id}|${i.batch || ''}|${ix}`}
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 30 }}
        renderItem={({ item }) => {
          const gone = item.expiry && item.expiry < todayStr;
          const id = item.item_id || item.id;
          return (
            <TouchableOpacity
              disabled={!id}
              onPress={() => navigation.navigate('ItemMoves', {
                itemId: id,
                itemName: item.item_name || item.name,
                unit: item.unit })}
              style={[S.row, { paddingVertical: 14, borderBottomWidth: 1,
                               borderBottomColor: C.line }]}>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text numberOfLines={1} style={{ fontSize: 15.5, fontWeight: '700', color: C.ink }}>
                  {item.item_name || item.name}
                </Text>
                {(item.batch || item.expiry || (where === 'all' && item.places?.size > 1)) && (
                  <Text style={{ fontSize: 11.5, marginTop: 2,
                                 color: gone ? C.danger : C.muted }}>
                    {[item.batch && `Batch ${item.batch}`,
                      item.expiry && `${gone ? 'expired' : 'expires'} ${dmy(item.expiry)}`,
                      where === 'all' && item.places?.size > 1
                        ? [...item.places].join(' + ') : null]
                      .filter(Boolean).join(' · ')}
                  </Text>
                )}
              </View>
              <Text style={[{ fontSize: 17, fontWeight: '800',
                              color: num(item.qty) < 0 ? C.red : C.ink }, S.num]}>
                {qtyText(item.qty)} {uqcShort(item.unit)}
              </Text>
            </TouchableOpacity>
          );
        }}
        ListEmptyComponent={
          <Text style={{ fontSize: 13.5, color: C.muted, textAlign: 'center', marginTop: 24 }}>
            Nothing in stock here yet.
          </Text>
        } />
    </Screen>
  );
}
