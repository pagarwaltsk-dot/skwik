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
  // Which store the Stock screen was set to when he tapped the item. Empty
  // means Everywhere.
  const godownId   = route.params?.godownId || null;
  const godownName = route.params?.godownName || '';
  const { org } = useApp();

  const [range, setRange] = useState('month');
  const [data, setData]   = useState(null);     // { opening, rows }
  const [busy, setBusy]   = useState(true);
  // A register that could not be fetched must never be drawn as an empty one.
  // "No movement" is an answer a shopkeeper acts on.
  const [failed, setFailed] = useState('');
  // True when he asked for one store and the database could not give him one.
  const [stale, setStale] = useState(false);

  useFocusEffect(useCallback(() => {
    let on = true;
    (async () => {
      setBusy(true);
      try {
        const [from, to] = rangeOf(range);
        // ONE STORE IF HE ASKED FOR ONE.
        //
        // The four-argument form arrived with 1.9.20. A phone that has been
        // updated before the database still has to open the register, so a
        // missing function falls back to the old three-argument one and the
        // page says plainly that it is showing the whole firm.
        let d = null, error = null, whole = false;
        if (godownId) {
          ({ data: d, error } = await supabase.rpc('item_moves',
            { p_item: itemId, p_from: from, p_to: to, p_godown: godownId }));
          if (error) {
            ({ data: d, error } = await supabase.rpc('item_moves',
              { p_item: itemId, p_from: from, p_to: to }));
            whole = !error;
          }
        } else {
          ({ data: d, error } = await supabase.rpc('item_moves',
            { p_item: itemId, p_from: from, p_to: to }));
        }
        if (!on) return;
        if (error) { setFailed(sayPlainly(error)); setData(null); return; }
        setData(d || { opening: 0, rows: [] });
        setStale(whole);
        setFailed('');
      } catch (e) {
        if (on) { setFailed(sayPlainly(e)); setData(null); }
      } finally {
        if (on) setBusy(false);
      }
    })();
    return () => { on = false; };
  }, [itemId, range, godownId]));

  // He asked for one store but is being shown the firm — the old database.
  const onWholeFirm = !!godownId && stale;

  // Running balance, worked out once, so every line carries the figure that
  // stood after it.
  const { rows, opening, inTotal, outTotal, closing } = useMemo(() => {
    let raw = data?.rows || [];

    // MOVING YOUR OWN GOODS FROM ONE OF YOUR SHELVES TO ANOTHER IS NOT A
    // MOVEMENT OF THE FIRM'S STOCK.
    //
    // Across the whole firm a transfer is two rows of the same quantity, one
    // in and one out, and they cancel. Left in, they made the IN and OUT
    // totals read like trade that never happened — a carton walked across
    // the lane and the register called it a purchase and a sale. Inside ONE
    // store they are real and stay: that shelf genuinely gained or lost.
    if (!godownId || onWholeFirm) {
      raw = raw.filter((r) => r.reason !== 'transfer_in' && r.reason !== 'transfer_out');
    }

    let bal = num(data?.opening);
    let gotIn = 0, gotOut = 0;
    const out = raw.map((r) => {
      const qi = num(r.qty_in), qo = num(r.qty_out);
      bal = n2(bal + qi - qo);
      gotIn += qi; gotOut += qo;
      return { ...r, balance: bal };
    });
    // A REGISTER READS DOWNWARDS, OLDEST FIRST.
    //
    // The page used to be turned over at this point so the newest movement sat
    // on top. He has since said that reads wrong, and it does: a running
    // balance printed next to each line only makes sense going down the page
    // in the order things happened — upside down, each figure appears to be
    // the balance BEFORE its own line.
    return { rows: out, opening: num(data?.opening), inTotal: n2(gotIn),
             outTotal: n2(gotOut), closing: bal };
  }, [data, godownId, onWholeFirm]);

  // ONLY THE NEWEST FEW, AND THE TWO DIRECTIONS COUNTED APART.
  //
  // An item bought once and sold two hundred times would show its one purchase
  // and then bury it, so the answer to "when did this last come in" needs two
  // hundred rows of scrolling. Counting in and out separately keeps at least
  // the newest five of each on the page whatever the mix.
  //
  // The balances are already worked out, over EVERY movement, before any of
  // this — so the figure beside a line is right whether or not the line above
  // it is drawn. What the window changes is only how much is on the page.
  const FIRST = 5, STEP = 15;
  const [show, setShow] = useState(FIRST);
  const visible = useMemo(() => {
    // A register short enough to read in one go is left whole. Hiding three
    // lines out of ten behind a button is a puzzle, not a kindness — even if
    // the strict rule would trim a lopsided ten.
    if (rows.length <= show * 2) return { list: rows, hidden: 0 };
    let ins = 0, outs = 0;
    const keep = new Set();
    for (let i = rows.length - 1; i >= 0; i--) {
      const isIn = num(rows[i].qty_in) > 0;
      if (isIn && ins < show) { ins++; keep.add(i); }
      else if (!isIn && outs < show) { outs++; keep.add(i); }
      if (ins >= show && outs >= show) break;
    }
    const list = rows.filter((_, i) => keep.has(i));
    return { list, hidden: rows.length - list.length };
  }, [rows, show]);

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

      {/* WHOSE SHELF THIS IS. Two registers of the same item read almost the
          same, so the page has to say which one is open. */}
      {(!!godownName || !!godownId) && (
        <View style={{ paddingHorizontal: 16, paddingTop: 10 }}>
          <Text style={{ fontSize: 12.5, fontWeight: '700', color: C.accent }}>
            {onWholeFirm ? 'Whole firm' : godownName || 'One store'}
          </Text>
          {onWholeFirm && (
            <Text style={{ fontSize: 11.5, color: C.muted, marginTop: 2, lineHeight: 16 }}>
              One store on its own needs the 1.9.20 update run on your database.
              Until then this is every store together.
            </Text>
          )}
        </View>
      )}

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
          data={visible.list}
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
                {visible.hidden ? 'THE LATEST MOVEMENTS' : 'EVERY MOVEMENT'}
              </Text>
              {visible.hidden > 0 && (
                <TouchableOpacity
                  onPress={() => setShow((v) => (v === FIRST ? STEP : v + STEP))}
                  style={{ paddingVertical: 12, alignItems: 'center', marginBottom: 4,
                           borderWidth: 1, borderColor: C.line, borderRadius: 11,
                           backgroundColor: C.surface }}>
                  <Text style={{ fontSize: 13.5, fontWeight: '800', color: C.accent }}>
                    ↑ Show older — {visible.hidden} more
                  </Text>
                  <Text style={{ fontSize: 11, color: C.muted, marginTop: 2 }}>
                    newest {show} in and {show} out are shown; the balance beside
                    each line counts every movement
                  </Text>
                </TouchableOpacity>
              )}
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
