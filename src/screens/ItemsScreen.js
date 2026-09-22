import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, FlatList, Modal, Alert, ScrollView,
  BackHandler } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { supabase, allRows } from '../lib/supabase';
import { useApp } from '../AppContext';
import { fmt0, num, settle, hsnApplies, SUPPLY_KINDS, supplyOf } from '../lib/money';
import { uqcShort } from '../lib/uqc';
import { checkHsn, hsnExists, hsnDesc } from '../lib/hsn';
import { HsnField, UomField } from '../components/Pickers';
import { Box, Foot, Head, KeyForm, Screen } from '../components/Chrome';
import { ScanSheet } from '../components/Scan';
import { showVariants } from '../lib/features';
import { C, S } from '../theme';
import { sayPlainly } from '../lib/offline';

const FIELD = {
  name: 'Name', hsn: 'HSN code', unit: 'Unit', sale_price: 'Selling price',
  purchase_price: 'Purchase price', gst_rate: 'GST rate', search_words: 'Search words',
};

const empty = { name: '', search_words: '', alias: '', hsn: '', unit: 'PCS', barcode: '',
  supply: 'taxable',
                sale_price: '', price2: '', purchase_price: '', gst_rate: '', opening_stock: '' };

// Has he already put something into one of the folded-away fields? If he has,
// the sheet must open with them showing: a value he cannot see on the screen
// is a value he cannot correct.
const hasMore = (e) => !!e && !!(
  (e.alias || '').trim() || (e.search_words || '').trim() || (e.hsn || '').trim()
  || (e.barcode || '').trim() || (e.variant || '').trim() || e.variant_of
  || num(e.gst_rate) || num(e.price2) || num(e.purchase_price) || num(e.opening_stock)
  || supplyOf(e) !== 'taxable');

export default function ItemsScreen({ navigation }) {
  const { org, isOwner } = useApp();
  const [rows, setRows] = useState([]);
  const [q, setQ] = useState('');
  const [edit, setEdit] = useState(null);

  // the way through the form: name → selling rate, and then, once the rest is
  // opened, also called → barcode → search words → GST → the other two prices
  // → opening stock. The arrow key on the keyboard walks it.
  const fName = useRef(null), fAlias = useRef(null), fWords = useRef(null);
  const fGst  = useRef(null), fSale  = useRef(null), fTwo   = useRef(null);
  const fBuy  = useRef(null), fOpen  = useRef(null), fCode = useRef(null);
  const [scanOpen, setScanOpen] = useState(false);
  const [history, setHistory] = useState([]);

  // THE SHEET OPENS SHOWING THREE THINGS.
  //
  // Every field this app knows about stood on the screen at once, and a shop
  // that sells rice and buckets had to read past HSN, kind of supply and two
  // other price lists before it reached the box it came for. A name, a rate
  // and a unit are what an item really needs; the rest is folded away until
  // he asks for it.
  const [more, setMore] = useState(false);

  // Fold it shut each time the sheet opens — unless this item already carries
  // something in one of the folded fields, in which case it opens showing.
  useEffect(() => { setMore(hasMore(edit)); }, [edit?.id, !!edit]);

  // CHANGING MANY RATES AT ONCE.
  // Opening every item one by one to put prices up 5% is an evening's work.
  // Here the list itself becomes editable: type over the rates you want, or
  // move the whole lot by a percentage, and save once.
  const [showGone, setShowGone] = useState(false);   // retired items
  const [bulk, setBulk]       = useState(false);
  const [draft, setDraft]     = useState({});     // item id -> the rate typed
  const [which, setWhich]     = useState('sale_price');
  const [pct, setPct]         = useState('');
  const [saving, setSaving]   = useState(false);

  const WHICH = [
    { k: 'sale_price',     label: org?.price1_name || 'Wholesale' },
    { k: 'price2',         label: org?.price2_name || 'Retail' },
    { k: 'purchase_price', label: 'Purchase' },
  ];

  const startBulk = () => {
    const d = {};
    rows.forEach((r) => { d[r.id] = String(r[which] ?? ''); });
    setDraft(d); setPct(''); setBulk(true);
  };

  const switchWhich = (k) => {
    setWhich(k);
    const d = {};
    rows.forEach((r) => { d[r.id] = String(r[k] ?? ''); });
    setDraft(d); setPct('');
  };

  // Move every rate on screen by a percentage. Applied to what is showing,
  // so a search narrows it to just those items.
  const applyPct = () => {
    const p = num(pct);
    if (!p) return Alert.alert('By how much?', 'Type a number — 5 for 5% up, -5 for 5% down.');
    const next = { ...draft };
    shown.forEach((r) => {
      const base = num(next[r.id] ?? r[which]);
      if (!base) return;
      next[r.id] = String(Math.round(base * (1 + p / 100) * 100) / 100);
    });
    setDraft(next);
  };

  const changed = rows.filter((r) => {
    const d = draft[r.id];
    return d !== undefined && num(d) !== num(r[which] ?? 0);
  });

  // THREE HUNDRED PRICES, ONE ROUND TRIP EACH, AND NO IDEA WHERE IT STOPPED.
  //
  // This sent one update per item and threw on the first failure, so a dropped
  // line at item 40 of 300 left 39 prices raised and 261 not — and the message
  // said only "Could not save them all", with the drafts still on screen and
  // no way to tell which was which. Blocks of a hundred, and when something
  // does go wrong he is told exactly how far it got and what is still showing
  // the old price.
  const saveBulk = async () => {
    if (!changed.length) { setBulk(false); return; }
    setSaving(true);
    let done = 0;
    try {
      for (let i = 0; i < changed.length; i += 100) {
        const block = changed.slice(i, i + 100)
          .map((r) => ({ id: r.id, [which]: num(draft[r.id]) }));
        const { error } = await supabase.from('items').upsert(block, { onConflict: 'id' });
        if (error) throw error;
        done += block.length;
      }
      setBulk(false); setDraft({}); load();
    } catch (e) {
      Alert.alert(
        done ? `${done} of ${changed.length} saved` : 'Nothing was saved',
        `${sayPlainly(e)}\n\n`
        + (done
            ? `The first ${done} are changed and the rest are not. The ones still `
              + `showing a new price below have not gone in — press save again.`
            : 'Nothing has been changed. Press save again.'));
      load();
    } finally { setSaving(false); }
  };

  // What was changed on this item, and when. Read only - the database does
  // not allow these rows to be edited or deleted by anyone.
  useEffect(() => {
    if (!edit?.id) { setHistory([]); return; }
    supabase.from('item_history')
      .select('changed_at, field, old_value, new_value')
      .eq('item_id', edit.id)
      .order('changed_at', { ascending: false })
      .limit(20)
      .then(({ data }) => setHistory(data || []));
  }, [edit?.id]);

  // Retired items are kept, never deleted — old bills must still be able to
  // show what was sold and at what rate.
  // Paged: a shop with more than 1,000 items was shown only the first 1,000,
  // with nothing on screen to say the rest existed.
  const load = () => allRows(() => supabase.from('items').select('*')
    .eq('is_active', !showGone)
    .order('name').order('id'))
    .then((data) => setRows(data || []))
    .catch(() => {});
  // Once. This had a useFocusEffect AND a useEffect on the same condition, so
  // every visit to this screen asked the server for the whole item list twice.
  useFocusEffect(useCallback(() => { load(); }, [showGone]));

  // THE PHONE'S OWN BACK BUTTON, WHILE AN ITEM IS OPEN.
  //
  // He reported that he could not back out of an item. The item sheet sits on
  // top of this screen, so a press of back walked out of Items altogether
  // instead of shutting the sheet. Back now does what Cancel does, and only
  // leaves the screen when nothing is open on top of it.
  //
  // The handler is read through a ref so the listener is not torn down and
  // built again on every keystroke, and useFocusEffect ties it to this screen
  // being the one in front.
  const backRef = useRef(null);
  backRef.current = () => {
    if (scanOpen) { setScanOpen(false); return true; }
    if (edit)     { setEdit(null);      return true; }
    return false;
  };
  useFocusEffect(useCallback(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress',
      () => backRef.current());
    return () => sub.remove();
  }, []));

  const retire = (item, back) => {
    const gone = !back;
    Alert.alert(
      gone ? `Stop using ${item.name}?` : `Use ${item.name} again?`,
      gone
        ? 'It disappears from billing and from this list. Nothing on a bill '
          + 'already written changes, and you can bring it back any time.'
        : 'It will show up while billing again.',
      [{ text: 'Cancel' },
       { text: gone ? 'Stop using it' : 'Bring it back',
         style: gone ? 'destructive' : 'default',
         onPress: async () => {
           const { error } = await supabase.from('items')
             .update({ is_active: back }).eq('id', item.id);
           if (error) return Alert.alert('Could not save', sayPlainly(error));
           setEdit(null); load();
         } }]);
  };

  const save = async () => {
    const taxed = org?.is_gst_registered && !org?.is_composition;
    if (!edit.name.trim()) return Alert.alert('Name needed', 'Type the item name.');
    if (!edit.unit)        return Alert.alert('Unit needed', 'Choose how this item is counted.');

    // HSN is compulsory only for a GST-registered firm.
    // Every field these three checks talk about is a folded-away one, so open
    // the section first — otherwise he is told to fix a box that is not on
    // the screen.
    const problem = checkHsn(edit.hsn, org);
    if (problem) { setMore(true); return Alert.alert('HSN code', problem); }

    const proceed = async () => {
      const body = {
        org_id: org.id,
        name: edit.name.trim(),
        search_words: edit.search_words.trim(),
        barcode: (edit.barcode || '').trim() || null,
        supply: supplyOf(edit),
        variant_of: edit.variant_of || null,
        variant: (edit.variant || '').trim() || null,
        alias: (edit.alias || '').trim(),
        hsn: edit.hsn.trim(),
        unit: edit.unit,
        sale_price: num(edit.sale_price),
        price2: num(edit.price2),
        purchase_price: num(edit.purchase_price),
        gst_rate: num(edit.gst_rate),
        opening_stock: num(edit.opening_stock),
      };
      const { error } = edit.id
        ? await supabase.from('items').update(body).eq('id', edit.id)
        : await supabase.from('items').insert(body);
      if (error) return Alert.alert('Could not save', sayPlainly(error));
      setEdit(null); load();
    };

    // A tax invoice with a 0% line on it undercharges the customer and
    // understates the return. The rate is the one field on this sheet with
    // money behind it, so it is the one field nobody may skip past.
    //
    // This used to stand ABOVE proceed, and proceed is a const. Reaching a
    // const before the line that declares it is a ReferenceError, so the one
    // moment this guard was meant to help — a GST shop saving an item with no
    // rate on it — was the moment the screen threw instead. It now stands
    // below, where proceed exists.
    if (taxed && !num(edit.gst_rate)) {
      setMore(true);
      return Alert.alert('GST rate?',
        'This item has no GST rate. A bill with it on will charge no tax. '
        + 'Put the rate in, or set it to 0 on purpose.',
        [{ text: 'Go back' }, { text: 'It really is 0%', onPress: proceed }]);
    }

    // Right shape, but not a code we know. Warn, do not block — the bundled
    // list is not the whole master and he may have a genuine code.
    if (hsnApplies(org) && edit.hsn && !hsnExists(edit.hsn)) {
      setMore(true);
      return Alert.alert('Check this HSN',
        `${edit.hsn} is not in our list. Save it anyway?`,
        [{ text: 'Let me check' }, { text: 'Save anyway', onPress: proceed }]);
    }
    proceed();
  };

  const shown = rows.filter((r) =>
    `${r.name} ${r.search_words || ''}`.toLowerCase().includes(q.toLowerCase()));

  const set = (k) => (v) => setEdit((e) => ({ ...e, [k]: v }));

  // A TYPO IN OPENING STOCK USED TO BE FOR EVER.
  //
  // This field disappeared the moment the item was saved, so 500 bags typed
  // where 50 were meant could never be put right — the count was wrong in
  // every stock summary from then on. It shows for an item already on the
  // books too, with a line under it saying what it is, because correcting the
  // count he started with is not the same as writing down a purchase.
  const showOpening = !!edit && !!org?.stock_enabled;

  return (
    <Screen>
      <Head navigation={navigation} title="Items">
        {!bulk && (
          <>
            <TouchableOpacity onPress={startBulk}
              hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
              style={{ paddingHorizontal: 10 }}>
              <Text style={{ fontSize: 15, fontWeight: '800', color: C.accent }}>RATES</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => setEdit({ ...empty })}
              hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
              <Text style={{ fontSize: 15, fontWeight: '800', color: C.green }}>+ NEW</Text>
            </TouchableOpacity>
          </>
        )}
        {bulk && (
          <TouchableOpacity onPress={() => { setBulk(false); setDraft({}); }}
            hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
            <Text style={{ fontSize: 15, fontWeight: '800', color: C.muted }}>CANCEL</Text>
          </TouchableOpacity>
        )}
      </Head>

      <View style={{ padding: 16, paddingBottom: bulk ? 10 : 16 }}>
        <TextInput style={S.input} placeholder="Search" placeholderTextColor={C.faint}
          value={q} onChangeText={setQ}  returnKeyType="search" />
      </View>

      {!bulk && (
        <TouchableOpacity onPress={() => setShowGone(!showGone)}
          style={{ paddingHorizontal: 16, paddingBottom: 10 }}>
          <Text style={{ fontSize: 13, fontWeight: '600', color: C.accent }}>
            {showGone ? '‹ Back to the items you use' : 'Show items you stopped using'}
          </Text>
        </TouchableOpacity>
      )}

      {bulk && (
        <View style={{ paddingHorizontal: 16, paddingBottom: 12 }}>
          <View style={[S.row, { gap: 6 }]}>
            {WHICH.map((w) => {
              const on = which === w.k;
              return (
                <TouchableOpacity key={w.k} onPress={() => switchWhich(w.k)}
                  style={{ flex: 1, paddingVertical: 7, borderRadius: 9, alignItems: 'center',
                           borderWidth: 1, borderColor: on ? C.accent : C.line,
                           backgroundColor: on ? C.accentSoft : C.surface }}>
                  <Text numberOfLines={1}
                    style={{ fontSize: 12, fontWeight: '600', color: on ? C.accent : C.muted }}>
                    {w.label}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>

          <View style={[S.row, { marginTop: 8, gap: 8 }]}>
            <TextInput style={[S.input, S.num, { flex: 1 }]} keyboardType="numeric"
              placeholder="Move all by %  —  5 or -5" placeholderTextColor={C.faint}
              value={pct} onChangeText={setPct} />
            <TouchableOpacity onPress={applyPct} style={[S.btnGhost, { paddingVertical: 12 }]}>
              <Text style={S.ghostText}>Apply</Text>
            </TouchableOpacity>
          </View>
          <Text style={S.hint}>
            Applies to the {shown.length} item{shown.length === 1 ? '' : 's'} showing.
            Nothing is saved until you tap Save.
          </Text>
        </View>
      )}

      <FlatList
        data={shown}
        keyExtractor={(i) => i.id}
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 30 }}
        ListEmptyComponent={
          // NOTHING MATCHED WHAT HE TYPED.
          // He had to clear the search, hunt for + NEW at the top and type the
          // same name a second time. The row he is already looking at opens the
          // item with the name filled in.
          (!bulk && !showGone && !!q.trim()) ? (
            <TouchableOpacity onPress={() => setEdit({ ...empty, name: q.trim() })}
              style={{ marginTop: 16, paddingVertical: 14, paddingHorizontal: 12,
                       backgroundColor: C.soft, borderRadius: 10 }}>
              <Text style={{ fontSize: 15, fontWeight: '700', color: C.accent }}>
                + Add “{q.trim()}” as a new item
              </Text>
            </TouchableOpacity>
          ) : (
            <Text style={{ color: C.muted, fontWeight: '600', textAlign: 'center', marginTop: 30 }}>
              No items yet. You can add them here, or just start billing — a new
              name on a bill can be saved as an item there and then.
            </Text>
          )}
        renderItem={({ item }) => (bulk ? (
          <View style={[S.row, { paddingVertical: 10, borderBottomWidth: 1,
                                 borderBottomColor: C.line }]}>
            <View style={{ flex: 1, minWidth: 0, paddingRight: 10 }}>
              <Text numberOfLines={1} style={{ fontSize: 15, fontWeight: '600', color: C.ink }}>
                {item.name}
              </Text>
              <Text style={{ fontSize: 11, color: C.muted, marginTop: 2 }}>
                was ₹{fmt0(item[which])}
              </Text>
            </View>
            <TextInput
              style={[S.input, S.num, { width: 104, paddingVertical: 9, textAlign: 'right' },
                      num(draft[item.id]) !== num(item[which] ?? 0)
                        && { borderColor: C.accent, backgroundColor: C.accentSoft }]}
              keyboardType="numeric" selectTextOnFocus
              value={String(draft[item.id] ?? '')}
              onBlur={() => setDraft((d) => ({ ...d, [item.id]: settle(d[item.id]) }))}
              onChangeText={(t) => setDraft((d) => ({ ...d, [item.id]: t }))} />
          </View>
        ) : (
          <TouchableOpacity
            onPress={() => setEdit({ ...item,
              unit: item.unit || 'PCS',
              sale_price: String(item.sale_price ?? ''),
              price2: String(item.price2 ?? ''),
              purchase_price: String(item.purchase_price ?? ''),
              gst_rate: String(item.gst_rate ?? ''),
              opening_stock: String(item.opening_stock ?? '') })}
            style={[S.row, { paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: C.line }]}>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 16, fontWeight: '700', color: C.ink }}>{item.name}</Text>
              {/* A shop with no GST number was shown "GST 0%" on every row of
                  its list, which says nothing and only makes him wonder what
                  he has got wrong. The unit always earns its place. */}
              <Text style={{ fontSize: 11.5, fontWeight: '600', color: C.muted, marginTop: 2 }}>
                {item.hsn ? `HSN ${item.hsn} · ` : ''}
                {hsnApplies(org) ? `GST ${item.gst_rate || 0}% · ` : ''}
                per {uqcShort(item.unit)}
              </Text>
            </View>
            <Text style={[{ fontSize: 16, fontWeight: '800', color: C.ink }, S.num]}>
              ₹{fmt0(item.sale_price)}
            </Text>
          </TouchableOpacity>
        ))} />

      {bulk && (
        <Foot>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={S.footL}>CHANGED</Text>
            <Text style={[S.footTot, S.num]}>{changed.length}</Text>
          </View>
          <TouchableOpacity onPress={saveBulk} disabled={saving || !changed.length}
            style={[S.btn, (saving || !changed.length) && { backgroundColor: C.faint }]}>
            <Text style={S.btnText}>
              {saving ? 'Saving…' : changed.length ? `Save ${changed.length} rate${changed.length === 1 ? '' : 's'}` : 'Nothing changed'}
            </Text>
          </TouchableOpacity>
        </Foot>
      )}

      {/* Android hands the back press to the sheet's own window, not to the
          screen underneath, so the listener above never sees it while the
          sheet is up. This is the same press, answered where it lands. */}
      <Modal visible={!!edit} animationType="slide"
        onRequestClose={() => { if (scanOpen) setScanOpen(false); else setEdit(null); }}>
        {!!edit && (
          <KeyForm style={S.screen} keyboardShouldPersistTaps="handled"
                      contentContainerStyle={{ padding: 20, paddingTop: 54 }}>
            <Text style={{ fontSize: 24, fontWeight: '800', color: C.ink }}>
              {edit.id ? 'Edit item' : 'New item'}
            </Text>

            <Text style={[S.label, { marginTop: 18 }]}>ITEM NAME</Text>
            <Box ref={fName} next={fSale} style={{ marginTop: 6 }}
              value={edit.name} onChangeText={set('name')} />

            <Text style={[S.label, { marginTop: 14 }]}>
              {(org?.price1_name || 'Wholesale').toUpperCase()} PRICE
            </Text>
            {/* HE TABS THROUGH THE WHOLE FORM — it is how he fills one in.
                Folding the rest away ended the chain after two fields and the
                keyboard offered a tick instead of the next arrow, which is a
                dead end for anyone who works that way. The arrow stays, and
                taking it opens the rest and carries on into it. */}
            <Box ref={fSale} next={fAlias} onSubmit={save}
              onSubmitEditing={() => {
                if (!more) { setMore(true); setTimeout(() => fAlias.current?.focus(), 60); }
              }}
              style={{ marginTop: 6 }} keyboardType="numeric"
              value={edit.sale_price} onChangeText={set('sale_price')} />

            <Text style={[S.label, { marginTop: 14 }]}>UNIT</Text>
            <View style={{ marginTop: 6 }}>
              <UomField value={edit.unit} onChange={set('unit')} />
            </View>

            {/* One row for everything else. Nothing is taken away — it is put
                behind a tap, so the three boxes that matter are not buried. */}
            <TouchableOpacity onPress={() => setMore(!more)}
              style={{ marginTop: 18, paddingVertical: 13, paddingHorizontal: 12,
                       backgroundColor: C.soft, borderRadius: 10 }}>
              <Text style={{ fontSize: 15, fontWeight: '700', color: C.accent }}>
                {more ? '– Hide the rest' : '+ More details'}
              </Text>
            </TouchableOpacity>

            {more && (
              <>
              <Text style={[S.label, { marginTop: 14 }]}>ALSO CALLED</Text>
              <Box ref={fAlias} next={fCode} style={{ marginTop: 6 }} placeholder="balti, bucket, tub"
                value={edit.alias || ''} onChangeText={set('alias')} />
              <Text style={{ fontSize: 11.5, color: C.muted, marginTop: 5 }}>
                Local names. Any of these words will find this item while billing.
              </Text>

              <Text style={[S.label, { marginTop: 14 }]}>BARCODE</Text>
              <View style={[S.row, { marginTop: 6, gap: 8 }]}>
                <Box ref={fCode} next={fWords} style={{ flex: 1 }} value={edit.barcode || ''}
                  onChangeText={set('barcode')} placeholder="Scan it, or type it" />
                <TouchableOpacity onPress={() => setScanOpen(true)}
                  style={[S.btnGhost, { paddingHorizontal: 16, paddingVertical: 12 }]}>
                  <Text style={S.ghostText}>SCAN</Text>
                </TouchableOpacity>
              </View>

              {/* WHAT KIND OF SUPPLY THIS IS.
                  After GST 2.0 a great deal of a kirana shop's counter is
                  nil-rated — milk, paneer, Indian breads — and billing those as
                  ordinary 0% taxable lines leaves Table 8 of GSTR-1 empty and
                  overstates the shop's taxable turnover. Set it once, on the
                  item, and every bill it goes on gets it right. */}
              {hsnApplies(org) && (
                <>
                  <Text style={[S.label, { marginTop: 14 }]}>KIND OF SUPPLY</Text>
                  <View style={[S.row, { marginTop: 6, gap: 6, flexWrap: 'wrap' }]}>
                    {SUPPLY_KINDS.map((k) => {
                      const on = supplyOf(edit) === k.key;
                      return (
                        <TouchableOpacity key={k.key} onPress={() => set('supply')(k.key)}
                          style={{ paddingHorizontal: 12, paddingVertical: 8, borderRadius: 10,
                                   borderWidth: 1,
                                   borderColor: on ? C.ink : C.greyB,
                                   backgroundColor: on ? C.ink : 'transparent' }}>
                          <Text style={{ fontSize: 12.5, fontWeight: '700',
                                         color: on ? '#fff' : C.muted }}>{k.label}</Text>
                        </TouchableOpacity>
                      );
                    })}
                  </View>
                  <Text style={{ fontSize: 11.5, color: C.muted, marginTop: 5, lineHeight: 17 }}>
                    {supplyOf(edit) === 'taxable'
                      ? 'Ordinary goods. Tax is charged at the rate below.'
                      : supplyOf(edit) === 'nil'
                      ? 'Nil-rated: inside GST, but the rate is zero — milk, bread, fresh produce.'
                      : supplyOf(edit) === 'exempt'
                      ? 'Exempted by notification. No tax, and reported apart from taxable sales.'
                      : 'Outside GST altogether — petrol, diesel, liquor, electricity.'}
                  </Text>
                </>
              )}

              <Text style={[S.label, { marginTop: 14 }]}>OTHER SEARCH WORDS</Text>
              <Box ref={fWords} next={fGst} style={{ marginTop: 6 }} placeholder="thali, plate, steel"
                value={edit.search_words} onChangeText={set('search_words')} />

              {hsnApplies(org) && (
                <>
                  <Text style={[S.label, { marginTop: 14 }]}>HSN CODE</Text>
                  <View style={{ marginTop: 6 }}>
                    <HsnField value={edit.hsn} org={org} onChange={set('hsn')} onRate={set('gst_rate')} />
                  </View>

                  <Text style={[S.label, { marginTop: 14 }]}>GST RATE %</Text>
                  <Box ref={fGst} next={fTwo} style={{ marginTop: 6 }} keyboardType="numeric"
                    value={edit.gst_rate} onChangeText={set('gst_rate')} />
                </>
              )}

              <Text style={[S.label, { marginTop: 14 }]}>
                {(org?.price2_name || 'Retail').toUpperCase()} PRICE
              </Text>
              <Box ref={fTwo} next={fBuy} style={{ marginTop: 6 }} keyboardType="numeric"
                value={edit.price2} onChangeText={set('price2')} />

              {isOwner && <Text style={[S.label, { marginTop: 14 }]}>PURCHASE PRICE</Text>}
              {isOwner && (
                <Box ref={fBuy} next={showOpening ? fOpen : null} onSubmit={save}
                  style={{ marginTop: 6 }} keyboardType="numeric"
                  value={edit.purchase_price} onChangeText={set('purchase_price')} />
              )}

              {showOpening && (
                <>
                  <Text style={[S.label, { marginTop: 14 }]}>OPENING STOCK</Text>
                  <Box ref={fOpen} onSubmit={save} style={{ marginTop: 6 }} keyboardType="numeric"
                    value={edit.opening_stock} onChangeText={set('opening_stock')} />
                  {!!edit.id && (
                    <Text style={S.hint}>
                      This is how much of it you had in hand the day you put this
                      item in Skwik. Change it only to correct a mistake — the
                      stock figure counts up from here, so it moves too. Stock you
                      have bought since then is not written here; write that down
                      as a purchase.
                    </Text>
                  )}
                </>
              )}

              {/* Another size belongs with the rest of the detail, not above the
                  Save button where it was the biggest thing on the sheet. */}
              {showVariants(org) && !!edit.id && (
                <TouchableOpacity style={[S.btnGhost, { marginTop: 22 }]}
                  onPress={() => {
                    // 9x2, 9x3, 10x2 clip tiffin are one product in three sizes.
                    // Each size keeps its own rate and its own stock, because it
                    // is its own item; they are simply tied together so the whole
                    // family is found by typing the name once.
                    const base = edit.variant ? edit.name.replace(new RegExp(`\\s*${edit.variant}$`), '')
                                              : edit.name;
                    setEdit({
                      ...edit, id: null, variant_of: edit.variant_of || edit.id,
                      name: `${base} `, variant: '', barcode: '', opening_stock: '',
                      search_words: edit.search_words || base,
                    });
                    Alert.alert('Another size',
                      'Add the size to the end of the name — Clip Tiffin 9x3 — and put its '
                      + 'own rate in. It keeps its own stock, and typing the product name '
                      + 'finds every size.');
                  }}>
                  <Text style={S.ghostText}>+ Another size of this</Text>
                </TouchableOpacity>
              )}
              </>
            )}

            {history.length > 0 && (
              <View style={{ marginTop: 26, padding: 14, backgroundColor: C.soft, borderRadius: 16 }}>
                <Text style={{ fontSize: 14, fontWeight: '800', color: C.ink }}>What changed</Text>
                <Text style={{ fontSize: 11.5, fontWeight: '600', color: C.muted, marginTop: 3 }}>
                  Bills already made keep their old rate and name. Changing this
                  item only affects bills you make from now on.
                </Text>
                {history.map((h, i) => (
                  <View key={i} style={{ marginTop: 10 }}>
                    <Text style={{ fontSize: 11.5, fontWeight: '600', color: C.muted }}>
                      {String(h.changed_at).slice(8, 10)}/{String(h.changed_at).slice(5, 7)}/
                      {String(h.changed_at).slice(0, 4)} · {FIELD[h.field] || h.field}
                    </Text>
                    <Text style={{ fontSize: 13.5, fontWeight: '700', color: C.ink }}>
                      {h.old_value || '—'}  →  {h.new_value || '—'}
                    </Text>
                  </View>
                ))}
              </View>
            )}

            <TouchableOpacity style={[S.btn, { marginTop: 26 }]} onPress={save}>
              <Text style={S.btnText}>Save</Text>
            </TouchableOpacity>

            {!!edit.id && (
              <TouchableOpacity onPress={() => retire(edit, edit.is_active === false)}
                style={{ marginTop: 18, alignItems: 'center', paddingVertical: 10 }}>
                <Text style={{ fontSize: 14.5, fontWeight: '700',
                               color: edit.is_active === false ? C.accent : C.danger }}>
                  {edit.is_active === false ? 'Use this item again' : 'Stop using this item'}
                </Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity onPress={() => setEdit(null)}
              style={{ marginTop: 14, alignItems: 'center', paddingVertical: 10 }}>
              <Text style={{ fontSize: 16, fontWeight: '700', color: C.muted }}>Cancel</Text>
            </TouchableOpacity>
            <View style={{ height: 40 }} />
          </KeyForm>
        )}
      </Modal>

      <ScanSheet visible={scanOpen} onClose={() => setScanOpen(false)}
        title="Point at the packet"
        note="The code is put on this item"
        onCode={(code) => { setEdit((e) => ({ ...e, barcode: code })); setScanOpen(false); }} />
    </Screen>
  );
}
