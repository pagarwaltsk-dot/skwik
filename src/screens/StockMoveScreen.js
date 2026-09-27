import React, { useCallback, useMemo, useRef, useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, ScrollView, Alert } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';

import { supabase, allRows } from '../lib/supabase';
import { useApp } from '../AppContext';
import { fmt0, num, qty as qtyText, showDate, today } from '../lib/money';
import { uqcShort } from '../lib/uqc';
import { searchItems } from '../lib/search';
import { sayPlainly } from '../lib/offline';
import { showBatch, showGodowns, showMaking } from '../lib/features';
import { Head, Screen, Sections, Swipe, useChainSwipe, useSectionSwipe } from '../components/Chrome';
import { CalButton } from '../components/DatePick';
import { C, S } from '../theme';

// THE TWO THINGS THAT HAPPEN TO STOCK WITHOUT A BILL.
//
// Every movement Skwik has ever written came from a bill: a purchase put
// goods on the shelf, a sale took them off. But two things move stock that no
// customer was ever involved in.
//
//   MOVED     goods carried from one store to another. Nothing is bought or
//             sold, no money changes hands, no tax arises — the same goods
//             are simply somewhere else. Two movements, and they cancel out.
//
//   COUNTED   the shelf and the book disagree. Breakage, a sample given
//             away, something walking off, an opening figure typed as 500
//             when it was 50. He counts, and the difference is written down.
//
// Both were half-built. The transfer existed but was hidden in Settings under
// Godowns, where a man looking for his stock would never think to go. The
// count did not exist at all — the item register has had the word
// "Adjustment" in it since batches were added, with nothing in the app able
// to write one. So a wrong stock figure stayed wrong for ever, and every
// report standing on it stayed wrong too.
//
// They are one screen because they are the same question asked twice: where
// are my goods really, and how many of them are there really.

export default function StockMoveScreen({ navigation }) {
  const { org, isOwner } = useApp();
  const [tab, setTab] = useState('count');

  const [godowns, setGodowns] = useState([]);
  const [stock, setStock]     = useState([]);
  const [items, setItems]     = useState([]);
  const [busy, setBusy]       = useState(false);
  const [failed, setFailed]   = useState('');

  // the move being built
  const [from, setFrom] = useState(null);
  const [to, setTo]     = useState(null);

  // the count being made
  const [where, setWhere] = useState(null);      // which store he is standing in
  const [when, setWhen]   = useState(today());   // the day he counted, not the day he typed

  // the thing being made, and how many
  const [makeItem, setMakeItem] = useState(null);
  const [makeQty, setMakeQty]   = useState('');
  // A SHOP THAT TRACKS BATCHES HAS TO BE ABLE TO NAME THE ONE IT JUST MADE.
  // make_goods has always accepted it; without a box for it the goods landed
  // on the no-batch pile and the batch he sells by was never written down.
  const [makeBatch, setMakeBatch] = useState('');
  const [recipe, setRecipe]     = useState(null);   // null = not asked yet

  const [q, setQ] = useState('');
  const [lines, setLines] = useState([]);
  const seq = useRef(0);

  const manyStores = godowns.length > 1;
  const batches = showBatch(org);
  const making = showMaking(org);

  // ONLY THINGS THAT ARE ACTUALLY MADE. A shop with the switch on but nothing
  // marked as made has nothing to put on this tab, and is told so rather than
  // being given an empty search box.
  const madeItems = useMemo(
    () => items.filter((i) => i.build === 'made'),
    [items]);

  const load = useCallback(async () => {
    try {
      const [gs, st, its] = await Promise.all([
        showGodowns(org)
          ? allRows(() => supabase.from('godowns').select('*').order('name').order('id'))
          : Promise.resolve([]),
        // one row per item per store per batch, so a shop past a thousand
        // items needs every page of it, not the first
        allRows(() => supabase.from('stock_in_hand_detail')
          .select('item_id, item_name, unit, godown_id, batch, qty')),
        allRows(() => supabase.from('items')
          .select('id, name, unit, search_words, alias, barcode, hsn, build, purchase_price')
          .eq('is_active', true).order('name').order('id')),
      ]);
      setGodowns(gs || []);
      setStock(st || []);
      setItems(its || []);
      setFailed('');
      // MAIN FIRST, because that is where most of it is and where anything
      // with no store on it already counts as being.
      const main = (gs || []).find((g) => g.is_main) || (gs || [])[0] || null;
      setWhere((w) => w || main?.id || null);
      setFrom((f) => f || main?.id || null);
      // A SHOP WITH TWO STORES HAS ONLY ONE ANSWER TO "TO", so asking for it
      // is a tap that can only be made one way. The other store is filled in,
      // and a shop with three still gets to choose.
      setTo((t) => t || (gs || []).find((g) => g.id !== (main?.id || null))?.id || null);
    } catch (e) {
      setFailed(sayPlainly(e));
    }
  }, [org?.godowns_enabled]);
  useFocusEffect(useCallback(() => { load(); }, [load]));

  // WHAT THE BOOK SAYS IS HERE, right now, for one item in one store.
  //
  // The detailed view hands back several rows for one item — the opening
  // figure on one line and every batch on its own — so the figure he is
  // asked to check has to be the sum of them, not the first one found.
  // A store of null is the shop that keeps no stores at all.
  const hereNow = useCallback((store, itemId, batch) => {
    let t = 0;
    stock.forEach((r) => {
      if (r.item_id !== itemId) return;
      if ((r.godown_id || null) !== (store || null)) return;
      if (batches && (r.batch || '') !== (batch || '')) return;
      t += num(r.qty);
    });
    return t;
  }, [stock, batches]);

  // EVERY BATCH TOGETHER, for the one place the figure is only being shown to
  // him and not compared against anything: the list of things he makes. A
  // batch shop that made fifty in lot A12 should read fifty there, not none.
  const allHere = useCallback((store, itemId) => {
    let t = 0;
    stock.forEach((r) => {
      if (r.item_id !== itemId) return;
      if ((r.godown_id || null) !== (store || null)) return;
      t += num(r.qty);
    });
    return t;
  }, [stock]);

  const store = tab === 'move' ? from : where;
  const hits = q.trim() ? searchItems(items, q, 8) : [];

  const addLine = (h) => {
    seq.current += 1;
    setLines((ls) => [{ key: seq.current, item_id: h.p.id, item_name: h.p.name,
                        unit: h.p.unit, batch: '', qty: '', counted: '' }, ...ls]);
    setQ('');
  };
  const setLine = (key, patch) =>
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const dropLine = (key) => setLines((ls) => ls.filter((l) => l.key !== key));

  const swapTab = (t) => { setTab(t); setLines([]); setQ(''); };

  // WHAT GOES INTO IT, READ WHEN HE PICKS IT.
  //
  // Shown before he presses anything, because "make 20" is a sentence with a
  // lot hidden inside it and he should see the twenty bodies and twenty lids
  // leaving the shelf while he can still change his mind.
  const pickMake = async (it) => {
    setMakeItem(it); setMakeQty(''); setMakeBatch(''); setRecipe(null); setQ('');
    const { data } = await supabase.from('item_parts')
      .select('child_id, qty, items!item_parts_child_id_fkey(name, unit, purchase_price)')
      .eq('parent_id', it.id);
    setRecipe((data || []).map((r) => ({
      child_id: r.child_id, qty: num(r.qty),
      name: r.items?.name || '', unit: r.items?.unit || '',
      cost: num(r.items?.purchase_price) })));
  };

  const doMake = () => {
    const n = num(makeQty);
    if (!makeItem) return Alert.alert('What are you making?', 'Pick the item first.');
    if (n <= 0) return Alert.alert('How many?', 'Say how many you made.');
    if (!recipe || !recipe.length) {
      return Alert.alert('It is not made of anything yet',
        `Open ${makeItem.name} under Items and say what goes into it.`);
    }
    const short = recipe.find((r) => n * r.qty > hereNow(where, r.child_id, ''));
    const say = recipe.map((r) =>
      `${r.name}: ${qtyText(n * r.qty)} ${uqcShort(r.unit)}`).join('\n');
    Alert.alert(`Make ${qtyText(n)} ${makeItem.name}?`,
      `This takes off the shelf:\n${say}\n\n`
      + (short ? `You may not have enough ${short.name}. ` : '')
      + `And puts ${qtyText(n)} ${uqcShort(makeItem.unit)} of ${makeItem.name} on it.`,
      [{ text: 'Not yet' }, { text: 'Make it', onPress: sendMake }]);
  };

  const sendMake = async () => {
    setBusy(true);
    const { data, error } = await supabase.rpc('make_goods', {
      p: { item_id: makeItem.id, qty: num(makeQty), mdate: when, godown_id: where,
           batch: batches ? (makeBatch || '').trim() || null : null },
    });
    setBusy(false);
    if (error) return Alert.alert('Could not make it', sayPlainly(error));
    setMakeItem(null); setMakeQty(''); setMakeBatch(''); setRecipe(null);
    load();
    Alert.alert('Made',
      `${qtyText(data?.made)} ${makeItem.name} put on the shelf.\n\n`
      + `Each one cost \u20B9${fmt0(data?.cost_each)} to make, and that is now `
      + 'what the item is costed at — so the profit on it will be right.');
  };

  /* ---------------- moving ---------------- */

  // BOTH ENDS OF THE MOVE ARE HIS TO CHOOSE, AND WITH TWO STORES NEITHER WAS.
  //
  // Each picker used to hide the store the other one was sitting on — FROM
  // hid TO, TO hid FROM — which sounds like it stops him naming the same
  // place twice. In a shop with exactly two stores it does something else
  // entirely: the FROM row is left with ONE chip in it, the store it is
  // already on. Chamber Road to Napaukhry was not the default, it was the
  // only move the screen could write.
  //
  // So goods coming back the other way had nowhere to go. The evening
  // leftovers carried up from the shop, a wrong box sent down in the morning,
  // stock pulled back to make up a big order — all of it was either not
  // written at all, and the two stores' figures drifted apart for good, or
  // written as a count at each end: two corrections, each one an Adjustment
  // in the item's register, where there should have been one move.
  //
  // Every store is now offered at both ends, and picking the one the other
  // end is already on SWAPS them instead of refusing. One tap on Napaukhry
  // under FROM turns Chamber Road → Napaukhry into Napaukhry → Chamber
  // Road, which is the whole journey in one tap. The two can still never be
  // the same store — that is what the swap is for, and doMove checks it
  // again before anything is written — and the screen still opens on main
  // to other, so the move he makes every morning is still no taps at all.
  const pickFrom = (id) => { if (id === to) setTo(from); setFrom(id); };
  const pickTo   = (id) => { if (id === from) setFrom(to); setTo(id); };

  const doMove = () => {
    if (!from || !to)   return Alert.alert('Which stores?', 'Say where it goes from, and where to.');
    if (from === to)    return Alert.alert('Same store', 'Those are the same place.');
    const good = lines.filter((l) => num(l.qty) > 0);
    if (!good.length)   return Alert.alert('Nothing to move', 'Add an item and how many.');

    const short = good.find((l) => num(l.qty) > hereNow(from, l.item_id, l.batch));
    if (short) {
      return Alert.alert('More than you have',
        `${short.item_name}: only ${qtyText(hereNow(from, short.item_id, short.batch))} `
        + `${uqcShort(short.unit)} is in that store.\n\n`
        + 'Move it anyway if the goods really went — it is the stock figure that '
        + 'needs correcting, not the move.',
        [{ text: 'Let me check' }, { text: 'It really went', onPress: () => sendMove(good) }]);
    }
    sendMove(good);
  };

  const sendMove = async (good) => {
    setBusy(true);
    const { error } = await supabase.rpc('transfer_stock', {
      p: { from_godown: from, to_godown: to, mdate: when,
           lines: good.map((l) => ({ item_id: l.item_id, qty: num(l.qty),
                                     batch: (l.batch || '').trim() || null })) },
    });
    setBusy(false);
    if (error) return Alert.alert('Could not move it', sayPlainly(error));
    setLines([]);
    load();
    Alert.alert('Moved',
      `${good.length} item${good.length === 1 ? '' : 's'} moved from `
      + `${nameOf(from)} to ${nameOf(to)}.`);
  };

  /* ---------------- counting ---------------- */

  // WHAT HE TYPED AGAINST WHAT THE BOOK SAYS, worked out here so he can see
  // the difference BEFORE he saves it. The server works it out again at the
  // moment of saving, from the figures as they stand then — so a sale rung up
  // on another phone while he was counting cannot leave the books wrong. What
  // is shown here is the expectation; what is written is the truth.
  const counted = useMemo(() => lines.map((l) => {
    const typed = String(l.counted).trim();
    const have  = hereNow(where, l.item_id, l.batch);
    if (typed === '') return { ...l, have, diff: null };
    return { ...l, have, diff: num(typed) - have };
  }), [lines, where, hereNow]);

  const changing = counted.filter((l) => l.diff !== null && l.diff !== 0);
  const typedAny = counted.filter((l) => l.diff !== null);

  const doCount = () => {
    if (!typedAny.length) {
      return Alert.alert('Nothing counted yet',
        'Add an item and type how many of it are actually on the shelf.');
    }
    const minus = typedAny.find((l) => num(l.counted) < 0);
    if (minus) {
      return Alert.alert('That cannot be',
        `A shelf cannot hold less than nothing of ${minus.item_name}.`);
    }
    if (!changing.length) {
      return Alert.alert('Nothing to correct',
        'Everything you counted already agrees with the book. Nothing has been written.');
    }
    const say = changing.slice(0, 6).map((l) =>
      `${l.item_name}: book ${qtyText(l.have)} → counted ${qtyText(num(l.counted))}`
      + `  (${l.diff > 0 ? '+' : ''}${qtyText(l.diff)})`).join('\n')
      + (changing.length > 6 ? `\n+ ${changing.length - 6} more` : '');

    Alert.alert(`Correct ${changing.length} item${changing.length === 1 ? '' : 's'}?`,
      `${say}\n\nThe stock will become what you counted. No money, no tax and no `
      + 'customer’s account is touched.',
      [{ text: 'Let me check' }, { text: 'Write it', onPress: sendCount }]);
  };

  const sendCount = async () => {
    setBusy(true);
    const { data, error } = await supabase.rpc('adjust_stock', {
      p: { mdate: when, godown_id: where,
           lines: typedAny.map((l) => ({ item_id: l.item_id, counted: num(l.counted),
                                         batch: (l.batch || '').trim() || null })) },
    });
    setBusy(false);
    if (error) return Alert.alert('Could not write it', sayPlainly(error));
    setLines([]);
    load();
    const n = Number(data?.adjusted) || 0;
    const same = Number(data?.unchanged) || 0;
    Alert.alert('Counted',
      `${n} item${n === 1 ? '' : 's'} corrected`
      + (same ? `, ${same} already agreed.` : '.')
      + '\n\nEach one shows as an Adjustment in that item’s register.');
  };

  /* ---------------- screen ---------------- */

  const nameOf = (id) => godowns.find((g) => g.id === id)?.name || 'the shop';

  const section = useSectionSwipe(navigation, org, isOwner, 'moves');
  const tabs = ['count', manyStores && 'move', making && 'make'].filter(Boolean);
  const swipe = useChainSwipe(tabs, tab, swapTab, section);

  const Tab = ({ v, label }) => {
    const on = tab === v;
    return (
      <TouchableOpacity onPress={() => swapTab(v)}
        style={{ flex: 1, paddingVertical: 11, alignItems: 'center',
                 borderBottomWidth: 2, borderBottomColor: on ? C.accent : 'transparent' }}>
        <Text style={{ fontSize: 13.5, fontWeight: '800', color: on ? C.accent : C.muted }}>
          {label}
        </Text>
      </TouchableOpacity>
    );
  };

  const Pick = ({ value, onChange }) => (
    <View style={[S.row, { gap: 8, flexWrap: 'wrap', marginTop: 6 }]}>
      {godowns.map((g) => {
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

  // A FUNCTION, NOT A COMPONENT, AND THAT DISTINCTION IS THE WHOLE BUG.
  //
  // Written as a component declared inside the screen and used as a JSX tag,
  // React sees a BRAND NEW KIND of component on every redraw — it is a
  // different function object each time — and a new kind means throw the old
  // tree away and build a fresh one. The search box was destroyed and rebuilt
  // on every keystroke: it kept the first letter, lost the rest, and threw
  // the cursor out of the box. Measured on the way in — typing "steel" left
  // "s" behind.
  //
  // Called as a plain function, what comes back is the same kind of element
  // it was a moment ago, so React keeps the box that is already there.
  const finder = (placeholder) => (
    <>
      <TextInput style={[S.input, { marginTop: 14 }]} value={q} onChangeText={setQ}
        placeholder={placeholder} placeholderTextColor={C.faint}
        returnKeyType="next" submitBehavior="submit"
        onSubmitEditing={() => { if (hits.length) addLine(hits[0]); }} />
      {hits.map((h) => (
        <TouchableOpacity key={h.p.id} onPress={() => addLine(h)}
          style={{ paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: C.line }}>
          <Text style={{ fontSize: 15, fontWeight: '700', color: C.ink }}>{h.p.name}</Text>
          <Text style={{ fontSize: 11.5, color: C.muted, marginTop: 2 }}>
            {qtyText(hereNow(store, h.p.id, ''))} {uqcShort(h.p.unit)} here by the book
          </Text>
        </TouchableOpacity>
      ))}
    </>
  );

  return (
    <Screen>
      <Head navigation={navigation} title="Move & correct" />
      <Sections navigation={navigation} org={org} isOwner={isOwner} id="moves" />

      {tabs.length > 1 && (
        <View style={{ flexDirection: 'row', backgroundColor: C.surface,
                       borderBottomWidth: 1, borderBottomColor: C.line }}>
          <Tab v="count" label="Count" />
          {manyStores && <Tab v="move" label="Move" />}
          {making && <Tab v="make" label="Make" />}
        </View>
      )}

      <Swipe {...swipe} style={{ flex: 1 }}>
      <ScrollView keyboardShouldPersistTaps="handled"
                  contentContainerStyle={{ padding: 14, paddingBottom: 40 }}>

        {!!failed && (
          <Text style={{ fontSize: 13, fontWeight: '700', color: C.danger, marginBottom: 10 }}>
            {failed}
          </Text>
        )}

        {/* ---------------- the day ---------------- */}
        <View style={[S.row, { gap: 10 }]}>
          <View style={{ flex: 1 }}>
            <Text style={S.eyebrow}>
              {tab === 'move' ? 'Moved on' : tab === 'make' ? 'Made on' : 'Counted on'}
            </Text>
            <Text style={{ fontSize: 15, fontWeight: '700', color: C.ink, marginTop: 2 }}>
              {showDate(when)}
            </Text>
          </View>
          {/* HE COUNTS ON THE 30th AND TYPES IT ON THE 2nd, and the entry
              belongs on the day he counted. */}
          <CalButton value={when} max={today()}
            title={tab === 'move' ? 'Day it moved' : tab === 'make' ? 'Day you made it' : 'Day you counted'}
            onPick={(iso) => setWhen(iso)} />
        </View>

        {tab === 'make' ? (
          <>
            {manyStores && (
              <>
                <Text style={[S.label, { marginTop: 18 }]}>MADE AT</Text>
                <Pick value={where} onChange={setWhere} />
              </>
            )}

            {!madeItems.length ? (
              <Text style={{ fontSize: 13.5, color: C.muted, marginTop: 24, lineHeight: 20 }}>
                Nothing is marked as made yet. Open an item under Items, and under
                {' '}Made of other things choose {'\u201C'}Made first, then sold{'\u201D'} and
                say what goes into it.
              </Text>
            ) : !makeItem ? (
              <>
                <TextInput style={[S.input, { marginTop: 14 }]} value={q} onChangeText={setQ}
                  placeholder="What did you make?" placeholderTextColor={C.faint} />
                {madeItems
                  .filter((i) => !q.trim()
                    || i.name.toLowerCase().includes(q.trim().toLowerCase()))
                  .slice(0, 10)
                  .map((i) => (
                    <TouchableOpacity key={i.id} onPress={() => pickMake(i)}
                      style={{ paddingVertical: 13, borderBottomWidth: 1,
                               borderBottomColor: C.line }}>
                      <Text style={{ fontSize: 15.5, fontWeight: '700', color: C.ink }}>
                        {i.name}
                      </Text>
                      <Text style={{ fontSize: 11.5, color: C.muted, marginTop: 2 }}>
                        {qtyText(allHere(where, i.id))} {uqcShort(i.unit)} on the shelf
                      </Text>
                    </TouchableOpacity>
                  ))}
              </>
            ) : (
              <>
                <View style={[S.line, { marginTop: 14 }]}>
                  <View style={S.row}>
                    <Text style={[S.lineNm, { flex: 1 }]}>{makeItem.name}</Text>
                    <TouchableOpacity onPress={() => { setMakeItem(null); setRecipe(null); }}
                      hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
                      <Text style={{ fontSize: 12, fontWeight: '800', color: C.muted }}>
                        CHANGE
                      </Text>
                    </TouchableOpacity>
                  </View>
                  <Text style={[S.cellLabel, { marginTop: 10 }]}>
                    HOW MANY DID YOU MAKE
                  </Text>
                  <TextInput style={[S.cell, S.num, { marginTop: 4 }]} keyboardType="numeric"
                    autoFocus selectTextOnFocus
                    value={makeQty} onChangeText={setMakeQty} />

                  {batches && (
                    <>
                      <Text style={[S.cellLabel, { marginTop: 10 }]}>
                        BATCH, IF THIS LOT HAS ONE
                      </Text>
                      <TextInput style={[S.cell, { marginTop: 4 }]} value={makeBatch}
                        onChangeText={setMakeBatch} placeholder="Leave it empty if not"
                        placeholderTextColor={C.faint} />
                    </>
                  )}
                </View>

                {/* WHAT IT WILL TAKE, WORKED OUT WHILE HE TYPES.
                    Twenty drums is twenty bodies and twenty lids, and he
                    should see that before he presses anything. */}
                {recipe === null ? (
                  <Text style={[S.hint, { marginTop: 12 }]}>Reading what it is made of…</Text>
                ) : !recipe.length ? (
                  <Text style={{ fontSize: 13, fontWeight: '700', color: C.danger,
                                 marginTop: 12, lineHeight: 19 }}>
                    {makeItem.name} is not made of anything yet. Open it under Items
                    and say what goes into it.
                  </Text>
                ) : (
                  <>
                    <Text style={[S.eyebrow, { marginTop: 18 }]}>This will take off the shelf</Text>
                    {recipe.map((r) => {
                      const need = num(makeQty) * r.qty;
                      const have = hereNow(where, r.child_id, '');
                      const short = need > have;
                      return (
                        <View key={r.child_id} style={[S.row, { paddingVertical: 9,
                          borderBottomWidth: 1, borderBottomColor: C.line }]}>
                          <Text style={{ flex: 1, fontSize: 14, color: C.ink }} numberOfLines={2}>
                            {r.name}
                          </Text>
                          <Text style={[{ fontSize: 14, fontWeight: '800', width: 92,
                                          textAlign: 'right',
                                          color: short ? C.danger : C.ink }, S.num]}>
                            {qtyText(need)} {uqcShort(r.unit)}
                          </Text>
                        </View>
                      );
                    })}
                    <Text style={[S.hint, { marginTop: 8 }]}>
                      {num(makeQty) > 0
                        ? `That is \u20B9${fmt0(recipe.reduce((t, r) => t + num(makeQty) * r.qty * r.cost, 0))} of goods, or \u20B9${fmt0(recipe.reduce((t, r) => t + r.qty * r.cost, 0))} in each one \u2014 which is what it will be costed at.`
                        : 'Type how many and this will show what it takes.'}
                    </Text>

                    <TouchableOpacity onPress={doMake} disabled={busy}
                      style={[S.btn, { marginTop: 18 }, busy && { backgroundColor: C.faint }]}>
                      <Text style={S.btnText}>
                        {busy ? 'Making\u2026'
                              : num(makeQty) > 0
                                ? `Make ${qtyText(num(makeQty))} ${makeItem.name}`
                                : 'Say how many'}
                      </Text>
                    </TouchableOpacity>
                  </>
                )}
              </>
            )}
          </>
        ) : tab === 'move' ? (
          <>
            <Text style={[S.label, { marginTop: 18 }]}>FROM</Text>
            <Pick value={from} onChange={pickFrom} />
            <Text style={[S.label, { marginTop: 14 }]}>TO</Text>
            <Pick value={to} onChange={pickTo} />

            {finder('Which item is moving?')}

            {lines.map((l) => (
              <View key={l.key} style={[S.line, { marginTop: 10 }]}>
                <View style={S.row}>
                  <Text style={[S.lineNm, { flex: 1 }]}>{l.item_name}</Text>
                  <TouchableOpacity onPress={() => dropLine(l.key)}
                    hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
                    <Text style={{ fontSize: 20, color: C.danger }}>{'×'}</Text>
                  </TouchableOpacity>
                </View>
                <View style={[S.row, { gap: 8, marginTop: 8 }]}>
                  <View style={{ flex: 1 }}>
                    <Text style={S.cellLabel}>How many</Text>
                    <TextInput style={[S.cell, S.num]} keyboardType="numeric" selectTextOnFocus
                      value={l.qty} onChangeText={(t) => setLine(l.key, { qty: t })} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={S.cellLabel}>In {nameOf(from)}</Text>
                    <Text style={[{ fontSize: 15, fontWeight: '700', color: C.muted,
                                    paddingVertical: 11 }, S.num]}>
                      {qtyText(hereNow(from, l.item_id, l.batch))} {uqcShort(l.unit)}
                    </Text>
                  </View>
                </View>
                {batches && (
                  <View style={{ marginTop: 8 }}>
                    <Text style={S.cellLabel}>Batch (leave blank for all of it)</Text>
                    <TextInput style={S.cell} value={l.batch}
                      onChangeText={(t) => setLine(l.key, { batch: t })} />
                  </View>
                )}
              </View>
            ))}

            {!!lines.length && (
              <TouchableOpacity onPress={doMove} disabled={busy}
                style={[S.btn, { marginTop: 18 }, busy && { backgroundColor: C.faint }]}>
                <Text style={S.btnText}>
                  {busy ? 'Moving…'
                        : `Move ${lines.filter((l) => num(l.qty) > 0).length} to ${nameOf(to)}`}
                </Text>
              </TouchableOpacity>
            )}
          </>
        ) : (
          <>
            {manyStores && (
              <>
                <Text style={[S.label, { marginTop: 18 }]}>WHICH STORE ARE YOU STANDING IN</Text>
                <Pick value={where} onChange={(id) => { setWhere(id); setLines([]); }} />
              </>
            )}

            {finder('Which item did you count?')}

            {counted.map((l) => {
              const off = l.diff !== null && l.diff !== 0;
              return (
                <View key={l.key} style={[S.line, { marginTop: 10 },
                                          off && { borderColor: C.flagLine, backgroundColor: C.flagSoft }]}>
                  <View style={S.row}>
                    <Text style={[S.lineNm, { flex: 1 }]}>{l.item_name}</Text>
                    <TouchableOpacity onPress={() => dropLine(l.key)}
                      hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
                      <Text style={{ fontSize: 20, color: C.danger }}>{'×'}</Text>
                    </TouchableOpacity>
                  </View>
                  <View style={[S.row, { gap: 8, marginTop: 8 }]}>
                    <View style={{ flex: 1 }}>
                      <Text style={S.cellLabel}>The book says</Text>
                      <Text style={[{ fontSize: 15, fontWeight: '700', color: C.muted,
                                      paddingVertical: 11 }, S.num]}>
                        {qtyText(l.have)} {uqcShort(l.unit)}
                      </Text>
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={S.cellLabel}>You counted</Text>
                      <TextInput style={[S.cell, S.num]} keyboardType="numeric" selectTextOnFocus
                        value={l.counted} onChangeText={(t) => setLine(l.key, { counted: t })} />
                    </View>
                  </View>
                  {batches && (
                    <View style={{ marginTop: 8 }}>
                      <Text style={S.cellLabel}>Batch (blank counts the unbatched stock)</Text>
                      <TextInput style={S.cell} value={l.batch}
                        onChangeText={(t) => setLine(l.key, { batch: t })} />
                    </View>
                  )}
                  {/* THE DIFFERENCE, IN WORDS, BEFORE HE COMMITS TO IT. */}
                  {off && (
                    <Text style={{ fontSize: 12.5, fontWeight: '700', marginTop: 8,
                                   color: l.diff > 0 ? C.green : C.danger }}>
                      {l.diff > 0
                        ? `${qtyText(l.diff)} ${uqcShort(l.unit)} more than the book says`
                        : `${qtyText(-l.diff)} ${uqcShort(l.unit)} short`}
                    </Text>
                  )}
                </View>
              );
            })}

            {!!lines.length && (
              <TouchableOpacity onPress={doCount} disabled={busy}
                style={[S.btn, { marginTop: 18 }, busy && { backgroundColor: C.faint }]}>
                <Text style={S.btnText}>
                  {busy ? 'Writing…'
                    : changing.length
                      ? `Correct ${changing.length} item${changing.length === 1 ? '' : 's'}`
                      : 'Nothing to correct yet'}
                </Text>
              </TouchableOpacity>
            )}

            <Text style={[S.hint, { marginTop: 16, lineHeight: 18 }]}>
              Counting writes only the difference, and only to stock. No money, no
              tax and nobody{'’'}s account is touched. Each correction shows as an
              Adjustment in that item{'’'}s register, with the day you counted on it.
            </Text>
          </>
        )}

        {tab !== 'make' && !lines.length && !q.trim() && (
          <Text style={{ fontSize: 13, color: C.muted, textAlign: 'center',
                         marginTop: 26, paddingHorizontal: 20, lineHeight: 19 }}>
            {tab === 'move'
              ? 'Search for an item above to carry it from one store to another. Nothing is bought or sold.'
              : 'Search for an item above, then type how many are really on the shelf.'}
          </Text>
        )}
      </ScrollView>
      </Swipe>
    </Screen>
  );
}
