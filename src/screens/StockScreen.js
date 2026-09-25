import React, { useCallback, useMemo, useState } from 'react';
import { View, Text, TouchableOpacity, FlatList, TextInput } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { supabase, allRows } from '../lib/supabase';
import { useApp } from '../AppContext';
import { num, qty as qtyText, today as todayHere } from '../lib/money';
import { uqcShort } from '../lib/uqc';
import { showBatch, showExpiry, showGodowns, showVariants } from '../lib/features';
import { Head, Screen, Sections } from '../components/Chrome';
import { C, S } from '../theme';

// WHAT IS LEFT, AND WHERE IT IS.
//
// One store and no batches: a plain list, as it always was. A shop with two
// godowns gets a strip along the top to switch between them, and one keeping
// batches sees each batch on its own line with its expiry beside it — a date
// in red once it has passed.
//
// ONE ITEM IS ONE LINE, WHATEVER IS UNDERNEATH IT.
//
// He said: "In Batch number, item is deducted from main item, but updated
// figure is not shown in stock summary of item." Nothing was wrong with the
// figures — the screen was splitting them up. stock_in_hand_detail puts the
// opening stock in a row with no batch on it and every movement in a row with
// its own batch, and this screen grouped by item AND batch, so one item came
// out as a "(no batch)" line still holding the opening quantity plus a batch
// line for each sale. The opening line never moved, so it read as though the
// stock had not changed. Now the item gets ONE line carrying the total across
// every batch, and the batches sit underneath it. The line on top is the
// answer to "how much do I have"; the lines under it are the working.
//
// HOW DEEP IT GOES WHEN A SHOP KEEPS BOTH BATCHES AND SIZES.
//
// Item → size → batch is three levels, and on a phone one salt with four
// sizes and five batches each is twenty-one lines for one product. So when
// sizes are switched on the always-open levels are item → size, and the
// batches of any one line come out only when that line's batch button is
// tapped. A shop with batches but no sizes is only two levels deep, so its
// batches stay open the way he asked for.

const dmy = (d) => (d ? `${String(d).slice(8, 10)}/${String(d).slice(5, 7)}/${String(d).slice(2, 4)}` : '');

// The views hand back plain numbers. num() is the little calculator that reads
// what a shopkeeper types — "10x5", "1 1/2" — and it is far too much work to
// run on every one of several thousand stock rows. Here Number is enough.
const n = (v) => Number(v) || 0;

export default function StockScreen({ navigation }) {
  const { org, isOwner } = useApp();
  const [rows, setRows] = useState([]);
  const [godowns, setGodowns] = useState([]);
  const [kin, setKin] = useState([]);
  const [open, setOpen] = useState({});
  const [where, setWhere] = useState('all');
  const [q, setQ] = useState('');
  // AN ITEM WITH NOTHING LEFT IS STILL AN ITEM.
  //
  // He said it plainly: a stock item with a nil balance should still find a
  // place in the stock list, and hiding it should be HIS choice. It was not.
  // Two things were dropping them, and both are dealt with below: the detailed
  // list threw away any item that added up to nought, and the detailed view
  // itself only knows about items that have opening stock or have moved — an
  // item that has never had either was not in it at all.
  //
  // Shown by default now, because a shopkeeper looks for an item in this list
  // precisely to find out it is finished.
  const [hideNil, setHideNil] = useState(false);

  const detailed = showGodowns(org) || showBatch(org) || showExpiry(org);
  const bySize = showVariants(org);

  useFocusEffect(useCallback(() => {
    let on = true;
    (async () => {
      // THE SIZE IS NOT IN THE STOCK VIEWS.
      // Neither stock_in_hand nor stock_in_hand_detail carries variant_of or
      // variant, and both are read by other screens, so they are left alone
      // and the parentage is fetched beside them and joined here in memory.
      // Wanted for two reasons now: the parentage when sizes are on, and — when
      // the detailed view is in use — the only place an item with no stock and
      // no movement at all can come from. The plain view already lists every
      // item, so a shop with neither does not pay for this.
      const kinAsk = (bySize || detailed)
        ? allRows(() => supabase.from('items')
            .select('id, name, unit, variant_of, variant')
            .eq('is_active', true).order('id'))
        : Promise.resolve([]);

      if (!detailed) {
      // EVERY ROW, NOT THE FIRST THOUSAND.
      // PostgREST stops at 1,000 and says nothing, so a shop past that simply
      // had no stock for the rest of its items — shown as nothing in hand, and
      // refused when it tried to move them.
        const [data, ks] = await Promise.all([
          allRows(() => supabase.from('stock_in_hand')
            .select('*').order('name').order('item_id')),
          kinAsk,
        ]);
        if (on) { setRows(data || []); setKin(ks || []); }
        return;
      }
      const [st, { data: gs }, ks] = await Promise.all([
        allRows(() => supabase.from('stock_in_hand_detail')
          .select('*').order('item_name').order('item_id')),
        showGodowns(org) ? supabase.from('godowns').select('*').order('name')
                         : Promise.resolve({ data: [] }),
        kinAsk,
      ]);
      if (!on) return;
      setRows(st || []);
      setGodowns(gs || []);
      setKin(ks || []);
    })();
    return () => { on = false; };
  }, [detailed, bySize, org?.godowns_enabled, org?.variants_enabled]));

  const kinBy = useMemo(() => {
    const m = new Map();
    kin.forEach((k) => { if (k && k.id) m.set(k.id, k); });
    return m;
  }, [kin]);

  // THE ADDING UP, DONE ONCE.
  //
  // Several thousand rows go through here. It runs when the stock, the search
  // or the godown changes — never on a tap, and never while the list scrolls.
  const tree = useMemo(() => {
    const text = q.trim().toLowerCase();
    const byBatch = detailed && (showBatch(org) || showExpiry(org));
    // ITEMS ARE HIS TO HIDE; BATCHES ARE NOT.
    //
    // An item with nothing left is still one of his items and belongs on the
    // list unless he says otherwise. A BATCH with nothing left is different:
    // it is a lot that has been sold out, and keeping every one of them under
    // an item for ever turns a two-line item into forty. So the switch governs
    // items, and a spent batch still drops off the detailed view as it did.
    const keepEmpty = !hideNil;
    const keepBatch = !detailed;
    // NOT toISOString(). That answers in UTC, which is five and a half hours
    // behind India, so between midnight and half past five a batch expiring
    // today was drawn in red as though it had expired yesterday. today() is
    // the whole app's answer to this and every other date here goes through
    // it. The name stays `today` so the rest of this reads as it did.
    const today = todayHere();

    const src = detailed
      ? rows.filter((r) => (where === 'all' || (r.godown_id || 'none') === where))
      : rows;

    // one bucket per item, with its batches inside it
    const items = new Map();

    // EVERY ITEM HE HAS, FIRST — THEN WHAT HAS MOVED.
    //
    // The stock views are built from movements and opening figures, so an item
    // that has never had either is simply not in them. That is an item he
    // created this morning and has not bought yet, and it was invisible on the
    // stock screen: he would go looking for it, not find it, and wonder whether
    // he had really saved it.
    //
    // So the buckets are laid out from his own item list, and the figures are
    // added into them. An item nothing has happened to sits there at nought,
    // which is the true answer.
    //
    // Only while he is looking at everything: with one godown picked out, the
    // question is what is in THAT godown, and listing his whole catalogue
    // under it at nought would answer a question he did not ask.
    if (!detailed || where === 'all') {
      kin.forEach((k) => {
        if (!k?.id || items.has(k.id)) return;
        items.set(k.id, { id: k.id, name: k.name, unit: k.unit,
                          own: 0, total: null, places: new Set(),
                          batches: new Map(), kids: [] });
      });
    }

    src.forEach((r) => {
      const id = r.item_id || r.id;
      let it = items.get(id);
      if (!it) {
        it = { id, name: r.item_name || r.name, unit: r.unit,
               own: 0, total: null, places: new Set(), batches: new Map(), kids: [] };
        items.set(id, it);
      }
      it.own += n(r.qty);
      if (r.godown_name) it.places.add(r.godown_name);
      if (byBatch) {
        const bk = `${r.batch || ''}|${r.expiry || ''}`;
        let b = it.batches.get(bk);
        if (!b) {
          b = { bk, batch: r.batch || '', expiry: r.expiry || null, qty: 0, places: new Set() };
          it.batches.set(bk, b);
        }
        b.qty += n(r.qty);
        if (r.godown_name) b.places.add(r.godown_name);
      }
    });

    const dadOf = (id) => {
      if (!bySize) return null;
      const p = kinBy.get(id)?.variant_of || null;
      return p && p !== id ? p : null;
    };

    // WHAT THE SEARCH KEEPS.
    //
    // A size answers to the parent's name as well as its own — typing "Tata
    // Salt" has to bring 1kg and 5kg with it, or the parent line shows a total
    // that nothing underneath it adds up to, which is the exact complaint this
    // screen is fixing.
    const hit = new Set();
    items.forEach((it, id) => {
      if (String(it.name || '').toLowerCase().includes(text)) hit.add(id);
    });
    if (text && bySize) {
      const seed = new Set(hit);
      items.forEach((it, id) => {
        const p = dadOf(id);
        if (!p) return;
        if (seed.has(id)) hit.add(p);
        if (seed.has(p)) hit.add(id);
      });
    }

    const live = [];
    hit.forEach((id) => { if (items.has(id)) live.push(id); });

    const tops = [];
    live.forEach((id) => {
      const p = dadOf(id);
      // A size whose parent is not on this list — filtered out by the search,
      // or sitting in another godown — stands on its own rather than vanishing.
      if (p && items.has(p) && hit.has(p)) items.get(p).kids.push(id);
      else tops.push(id);
    });

    // the parent's figure is its own stock plus every size under it, so the
    // line on top always equals the lines beneath it
    const totalOf = (id, seen) => {
      const it = items.get(id);
      if (!it) return 0;
      if (it.total !== null) return it.total;
      if (seen.has(id)) return it.own;        // a size pointed back at itself
      seen.add(id);
      let t = it.own;
      it.kids.forEach((k) => { t += totalOf(k, seen); });
      it.total = t;
      return t;
    };
    live.forEach((id) => totalOf(id, new Set()));

    const liveBatches = (it) => {
      const bs = [];
      it.batches.forEach((b) => { if (keepBatch || n(b.qty) !== 0) bs.push(b); });
      // soonest to expire first, because that is the one to sell
      // An item that has never been given a batch comes out of the view as one
      // unlabelled line holding the whole figure. Repeating the total under
      // itself as "No batch" is noise, so it is left as the one line it is.
      if (bs.length === 1 && !bs[0].batch && !bs[0].expiry) return [];
      bs.sort((a, b) => String(a.expiry || '9999-99-99').localeCompare(String(b.expiry || '9999-99-99'))
                     || String(a.batch).localeCompare(String(b.batch)));
      return bs;
    };

    const sub = (parts) => parts.filter(Boolean).join(' · ');
    const spread = (places) => (where === 'all' && places.size > 1 ? [...places].join(' + ') : null);

    const node = (id, depth) => {
      const it = items.get(id);
      const kids = it.kids
        .filter((k) => keepEmpty || n(items.get(k).total) !== 0)
        .sort((a, b) =>
          String(kinBy.get(a)?.variant || items.get(a).name)
            .localeCompare(String(kinBy.get(b)?.variant || items.get(b).name)));
      const bs = liveBatches(it);
      const mine = {
        key: String(id),
        depth,
        item_id: id,
        item_name: it.name,
        unit: it.unit,
        // a size nested under its parent is known by its size alone; standing
        // on its own it needs the whole name back
        title: depth > 0 ? (kinBy.get(id)?.variant || it.name) : it.name,
        qty: it.total,
        sub: kids.length ? null : sub([spread(it.places)]),
        batches: kids.length ? [] : bs,
      };
      const out = [mine];
      if (kids.length) {
        // the parent's own loose stock, so the totals still tally
        if (n(it.own) !== 0 || (keepBatch && bs.length)) {
          out.push({
            key: `${id}|own`,
            depth: depth + 1,
            item_id: id,
            item_name: it.name,
            unit: it.unit,
            title: 'No size',
            qty: it.own,
            sub: sub([spread(it.places)]),
            batches: bs,
          });
        }
        kids.forEach((k) => { node(k, depth + 1).forEach((x) => out.push(x)); });
      }
      return out;
    };

    const lines = [];
    tops.sort((a, b) => String(items.get(a).name).localeCompare(String(items.get(b).name)));
    tops.forEach((id) => {
      if (!keepEmpty && n(items.get(id).total) === 0) return;
      node(id, 0).forEach((x) => lines.push(x));
    });

    return { lines, today, shut: bySize && byBatch };
  }, [rows, kin, kinBy, q, where, detailed, bySize, hideNil, org]);

  // The flattening is separate from the adding up so that opening one item's
  // batches does not re-total the whole shop.
  const shown = useMemo(() => {
    const { lines, today, shut } = tree;
    const out = [];
    lines.forEach((l) => {
      const bs = l.batches || [];
      const isOpen = !shut || !!open[l.key];
      out.push({ ...l, batchCount: shut ? bs.length : 0, isOpen });
      if (!bs.length || !isOpen) return;
      bs.forEach((b) => {
        const gone = !!b.expiry && b.expiry < today;
        out.push({
          key: `${l.key}|b|${b.bk}`,
          depth: l.depth + 1,
          item_id: l.item_id,
          item_name: l.item_name,
          unit: l.unit,
          // an empty batch label is a real thing — the opening stock, and
          // anything booked before batches were switched on. Blank on the line
          // reads as a bug, so it is named.
          title: b.batch || 'No batch',
          qty: b.qty,
          gone,
          sub: [b.expiry && `${gone ? 'expired' : 'expires'} ${dmy(b.expiry)}`,
                where === 'all' && b.places.size > 1 ? [...b.places].join(' + ') : null]
            .filter(Boolean).join(' · '),
          batchCount: 0,
        });
      });
    });
    return out;
  }, [tree, open, where]);

  const flip = useCallback((key) => {
    setOpen((o) => ({ ...o, [key]: !o[key] }));
  }, []);

  return (
    <Screen>
      <Head navigation={navigation} title="Stock in hand" />
      <Sections navigation={navigation} org={org} isOwner={isOwner} id="stock" />

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

        {/* HIS SWITCH, NOT SKWIK'S RULE. Off, and every item he has is on the
            list whether or not there is any of it left — which is how he finds
            out something is finished. */}
        <TouchableOpacity onPress={() => setHideNil((v) => !v)}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          style={[S.row, { marginTop: 10, gap: 9 }]}>
          <View style={{ width: 20, height: 20, borderRadius: 6, borderWidth: 1.5,
                         alignItems: 'center', justifyContent: 'center',
                         borderColor: hideNil ? C.accent : C.greyB,
                         backgroundColor: hideNil ? C.accent : 'transparent' }}>
            {hideNil && <Text style={{ color: '#fff', fontSize: 12, fontWeight: '800' }}>✓</Text>}
          </View>
          <Text style={{ flex: 1, fontSize: 13, fontWeight: '600', color: C.ink }}>
            Hide what I have none of
          </Text>
        </TouchableOpacity>

        <Text style={{ fontSize: 11.5, color: C.muted, marginTop: 8 }}>
          {tree.shut
            ? 'Tap any item to see every movement in and out of it. Tap Batches to open its batches.'
            : 'Tap any item to see every movement in and out of it.'}
        </Text>
      </View>

      <FlatList
        data={shown}
        keyExtractor={(i, ix) => `${i.key}|${ix}`}
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 30 }}
        renderItem={({ item }) => {
          const under = item.depth > 0;
          return (
            <TouchableOpacity
              disabled={!item.item_id}
              // THE REGISTER OPENS ON THE STORE THE STRIP ABOVE IS SET TO.
              // It used to open on the whole firm whichever button was lit,
              // so a shopkeeper looking at his godown tapped an item and was
              // shown his shop's sales in it.
              onPress={() => navigation.navigate('ItemMoves', {
                itemId: item.item_id,
                itemName: item.item_name,
                unit: item.unit,
                godownId: where === 'all' ? null : where,
                godownName: where === 'all' ? ''
                  : (godowns.find((g) => g.id === where)?.name || '') })}
              style={[S.row, { paddingVertical: under ? 10 : 14,
                               marginLeft: item.depth * 12,
                               paddingLeft: under ? 10 : 0,
                               borderLeftWidth: under ? 2 : 0,
                               borderLeftColor: C.line,
                               borderBottomWidth: 1,
                               borderBottomColor: C.line }]}>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text numberOfLines={1}
                  style={{ fontSize: under ? 13.5 : 15.5, fontWeight: under ? '600' : '700',
                           color: item.gone ? C.danger : C.ink }}>
                  {item.title}
                </Text>
                {!!item.sub && (
                  <Text style={{ fontSize: 11.5, marginTop: 2,
                                 color: item.gone ? C.danger : C.muted }}>
                    {item.sub}
                  </Text>
                )}
              </View>

              {item.batchCount > 0 && (
                <TouchableOpacity onPress={() => flip(item.key)}
                  hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                  style={[S.tapPill, { marginRight: 2 }]}>
                  <Text style={S.tapPillText}>
                    {item.batchCount} {item.batchCount === 1 ? 'batch' : 'batches'}
                    {item.isOpen ? ' ▴' : ' ▾'}
                  </Text>
                </TouchableOpacity>
              )}

              <Text style={[{ fontSize: under ? 14.5 : 17, fontWeight: under ? '700' : '800',
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
