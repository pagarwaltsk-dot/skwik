import React, { useCallback, useMemo, useState } from 'react';
import { View, Text, TouchableOpacity, FlatList, ActivityIndicator } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';

import { supabase } from '../lib/supabase';
import { sayPlainly } from '../lib/offline';
import { useApp } from '../AppContext';
import { fmt0, n2, num, qty as qtyText, today } from '../lib/money';
import { uqcShort } from '../lib/uqc';
import { Head, Screen } from '../components/Chrome';
import { C, S } from '../theme';

// WHERE THE GOODS WENT.
//
// The Stock screen answers "how many are left". It does not answer the
// question a shopkeeper actually asks when the figure on the screen is not
// the figure on the shelf, which is "where did they go". This is that
// register, the way a stock item ledger reads in Tally: the opening figure,
// then every movement in date order with the bill and the party against it,
// in on the left, out on the right, and the balance after each one.
//
// The opening figure is the item's own opening stock plus everything that
// moved before the period, so the register always starts where the last one
// finished and its closing figure is what the Stock screen shows.

const firstOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
const dmy = (d) => (d ? `${String(d).slice(8, 10)}/${String(d).slice(5, 7)}/${String(d).slice(2, 4)}` : '');

const RANGES = [
  { k: 'month', label: 'This month' },
  { k: 'last',  label: 'Last month' },
  { k: 'fy',    label: 'This year' },
  { k: 'all',   label: 'All' },
];

function rangeOf(k) {
  const now = new Date();
  if (k === 'month') return [firstOf(now), today()];
  if (k === 'last') {
    const s = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const e = new Date(now.getFullYear(), now.getMonth(), 0);
    return [firstOf(s), today(e)];
  }
  if (k === 'fy') {
    const y = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
    return [`${y}-04-01`, today()];
  }
  return ['2000-04-01', today()];
}

// What each movement is called on the screen. `reason` is what the database
// writes; a shopkeeper has never heard of 'purchase_return'.
const WORDS = {
  purchase:        'Purchase',
  sale:            'Sale',
  sale_return:     'Sales return',
  purchase_return: 'Purchase return',
  adjust:          'Adjustment',
  transfer_in:     'Moved in',
  transfer_out:    'Moved out',
  opening:         'Opening',
};

export default function ItemMovesScreen({ route, navigation }) {
  const itemId   = route.params?.itemId;
  const itemName = route.params?.itemName || 'Item';
  const unit     = route.params?.unit || '';
  const { org } = useApp();

  const [range, setRange] = useState('month');
  const [data, setData]   = useState(null);     // { opening, rows }
  const [busy, setBusy]   = useState(true);
  // A register that could not be fetched must never be drawn as an empty one.
  // "No movement" is an answer a shopkeeper acts on.
  const [failed, setFailed] = useState('');

  useFocusEffect(useCallback(() => {
    let on = true;
    (async () => {
      setBusy(true);
      try {
        const [from, to] = rangeOf(range);
        const { data: d, error } = await supabase.rpc('item_moves',
          { p_item: itemId, p_from: from, p_to: to });
        if (!on) return;
        if (error) { setFailed(sayPlainly(error)); setData(null); return; }
        setData(d || { opening: 0, rows: [] });
        setFailed('');
      } catch (e) {
        if (on) { setFailed(sayPlainly(e)); setData(null); }
      } finally {
        if (on) setBusy(false);
      }
    })();
    return () => { on = false; };
  }, [itemId, range]));

  // Running balance, worked out once, so every line carries the figure that
  // stood after it.
  const { rows, opening, inTotal, outTotal, closing } = useMemo(() => {
    const raw = data?.rows || [];
    let bal = num(data?.opening);
    let gotIn = 0, gotOut = 0;
    const out = raw.map((r) => {
      const qi = num(r.qty_in), qo = num(r.qty_out);
      bal = n2(bal + qi - qo);
      gotIn += qi; gotOut += qo;
      return { ...r, balance: bal };
    });
    // The running balance can only be worked out from the oldest entry
    // forward, so it is — and then the page is turned over, because what he
    // wants to see first is what moved today.
    return { rows: out.reverse(), opening: num(data?.opening), inTotal: n2(gotIn),
             outTotal: n2(gotOut), closing: bal };
  }, [data]);

  const u = uqcShort(unit);

  const Cell = ({ label, value, tone }) => (
    <View style={{ flex: 1 }}>
      <Text style={{ fontSize: 10.5, letterSpacing: 0.8, color: C.muted, fontWeight: '600' }}>
        {label}
      </Text>
      <Text style={[{ fontSize: 16, fontWeight: '800', marginTop: 2,
                      color: tone || C.ink }, S.num]}>
        {qtyText(value)} {u}
      </Text>
    </View>
  );

  return (
    <Screen>
      <Head navigation={navigation} title={itemName} />

      <View style={{ backgroundColor: C.surface, paddingHorizontal: 12, paddingVertical: 8,
                     borderBottomWidth: 1, borderBottomColor: C.line }}>
        <View style={[S.row, { gap: 6, flexWrap: 'wrap' }]}>
          {RANGES.map((g) => {
            const on = range === g.k;
            return (
              <TouchableOpacity key={g.k} onPress={() => setRange(g.k)}
                style={{ paddingHorizontal: 12, paddingVertical: 8, borderRadius: 9,
                         borderWidth: 1, borderColor: on ? C.accent : C.line,
                         backgroundColor: on ? C.accentSoft : C.surface }}>
                <Text style={{ fontSize: 12.5, fontWeight: '700',
                               color: on ? C.accent : C.muted }}>{g.label}</Text>
              </TouchableOpacity>
            );
          })}
        </View>
      </View>

      {busy ? (
        <View style={{ paddingTop: 40 }}><ActivityIndicator color={C.accent} /></View>
      ) : failed ? (
        <View style={{ padding: 20 }}>
          <Text style={{ fontSize: 14, fontWeight: '700', color: C.danger }}>
            Could not read the register
          </Text>
          <Text style={{ fontSize: 13, color: C.muted, marginTop: 6, lineHeight: 19 }}>
            {failed}
          </Text>
        </View>
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(r) => String(r.id)}
          contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 30 }}
          ListHeaderComponent={
            <>
              <View style={[S.card, { marginTop: 14, padding: 14 }]}>
                <View style={[S.row, { gap: 10 }]}>
                  <Cell label="OPENING" value={opening} />
                  <Cell label="IN" value={inTotal} tone={C.ok} />
                  <Cell label="OUT" value={outTotal} tone={C.danger} />
                </View>
                <View style={{ height: 1, backgroundColor: C.line, marginVertical: 12 }} />
                <View style={[S.row, { justifyContent: 'space-between', alignItems: 'flex-end' }]}>
                  <Text style={{ fontSize: 12.5, fontWeight: '700', color: C.muted }}>
                    CLOSING
                  </Text>
                  <Text style={[{ fontSize: 22, fontWeight: '800',
                                  color: closing < 0 ? C.red : C.ink }, S.num]}>
                    {qtyText(closing)} {u}
                  </Text>
                </View>
                {closing < 0 && (
                  <Text style={{ fontSize: 11.5, color: C.red, marginTop: 4, lineHeight: 16 }}>
                    Below zero — more has gone out than ever came in. Usually a
                    purchase bill that was never entered, or an opening figure
                    that was never put in.
                  </Text>
                )}
              </View>

              <Text style={[S.eyebrow, { marginTop: 18, marginBottom: 4 }]}>
                EVERY MOVEMENT
              </Text>
            </>
          }
          renderItem={({ item }) => {
            const isIn = num(item.qty_in) > 0;
            const q = isIn ? num(item.qty_in) : num(item.qty_out);
            const word = WORDS[item.reason] || item.reason || 'Movement';
            return (
              <TouchableOpacity
                disabled={!item.voucher_id}
                onPress={() => item.voucher_id
                  && navigation.navigate('Bill', { voucherId: item.voucher_id })}
                style={[S.row, { paddingVertical: 13, borderBottomWidth: 1,
                                 borderBottomColor: C.line, alignItems: 'flex-start' }]}>
                <View style={{ width: 52 }}>
                  <Text style={[{ fontSize: 12.5, fontWeight: '700', color: C.muted }, S.num]}>
                    {dmy(item.mdate)}
                  </Text>
                </View>

                <View style={{ flex: 1, minWidth: 0, paddingRight: 8 }}>
                  <Text numberOfLines={1} style={{ fontSize: 14.5, fontWeight: '700', color: C.ink }}>
                    {item.party || word}
                  </Text>
                  <Text numberOfLines={1} style={{ fontSize: 11.5, color: C.muted, marginTop: 2 }}>
                    {[word,
                      item.voucher_no ? `no. ${item.voucher_no}` : null,
                      item.godown,
                      item.batch ? `batch ${item.batch}` : null,
                      num(item.rate) > 0 ? `₹${fmt0(item.rate)}` : null]
                      .filter(Boolean).join(' · ')}
                  </Text>
                </View>

                <View style={{ alignItems: 'flex-end' }}>
                  <Text style={[{ fontSize: 15.5, fontWeight: '800',
                                  color: isIn ? C.ok : C.danger }, S.num]}>
                    {isIn ? '+' : '−'}{qtyText(q)}
                  </Text>
                  <Text style={[{ fontSize: 11.5, color: C.muted, marginTop: 2 }, S.num]}>
                    {qtyText(item.balance)} {u}
                  </Text>
                </View>
              </TouchableOpacity>
            );
          }}
          ListEmptyComponent={
            <Text style={{ fontSize: 13.5, color: C.muted, textAlign: 'center',
                           marginTop: 24, lineHeight: 20 }}>
              Nothing moved in this period.{'\n'}
              The opening figure above is what was already on the shelf.
            </Text>
          } />
      )}
    </Screen>
  );
}
