import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, FlatList, Modal, Alert, ScrollView } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { supabase } from '../lib/supabase';
import { useApp } from '../AppContext';
import { fmt0, num, settle, hsnApplies } from '../lib/money';
import { uqcShort } from '../lib/uqc';
import { checkHsn, hsnExists, hsnDesc } from '../lib/hsn';
import { HsnField, UomField } from '../components/Pickers';
import { C, S } from '../theme';

const FIELD = {
  name: 'Name', hsn: 'HSN code', unit: 'Unit', sale_price: 'Selling price',
  purchase_price: 'Purchase price', gst_rate: 'GST rate', search_words: 'Search words',
};

const empty = { name: '', search_words: '', alias: '', hsn: '', unit: 'PCS',
                sale_price: '', price2: '', purchase_price: '', gst_rate: '', opening_stock: '' };

export default function ItemsScreen({ navigation }) {
  const { org } = useApp();
  const [rows, setRows] = useState([]);
  const [q, setQ] = useState('');
  const [edit, setEdit] = useState(null);
  const [history, setHistory] = useState([]);

  // CHANGING MANY RATES AT ONCE.
  // Opening every item one by one to put prices up 5% is an evening's work.
  // Here the list itself becomes editable: type over the rates you want, or
  // move the whole lot by a percentage, and save once.
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

  const saveBulk = async () => {
    if (!changed.length) { setBulk(false); return; }
    setSaving(true);
    try {
      for (const r of changed) {
        const { error } = await supabase.from('items')
          .update({ [which]: num(draft[r.id]) }).eq('id', r.id);
        if (error) throw error;
      }
      setBulk(false); setDraft({}); load();
    } catch (e) {
      Alert.alert('Could not save them all', e.message || String(e));
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

  const load = () => supabase.from('items').select('*').eq('is_active', true)
    .order('name').then(({ data }) => setRows(data || []));
  useFocusEffect(useCallback(() => { load(); }, []));

  const save = async () => {
    if (!edit.name.trim()) return Alert.alert('Name needed', 'Type the item name.');
    if (!edit.unit)        return Alert.alert('Unit needed', 'Choose how this item is counted.');

    // HSN is compulsory only for a GST-registered firm.
    const problem = checkHsn(edit.hsn, org);
    if (problem) return Alert.alert('HSN code', problem);

    const proceed = async () => {
      const body = {
        org_id: org.id,
        name: edit.name.trim(),
        search_words: edit.search_words.trim(),
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
      if (error) return Alert.alert('Could not save', error.message);
      setEdit(null); load();
    };

    // Right shape, but not a code we know. Warn, do not block — the bundled
    // list is not the whole master and he may have a genuine code.
    if (hsnApplies(org) && edit.hsn && !hsnExists(edit.hsn)) {
      return Alert.alert('Check this HSN',
        `${edit.hsn} is not in our list. Save it anyway?`,
        [{ text: 'Let me check' }, { text: 'Save anyway', onPress: proceed }]);
    }
    proceed();
  };

  const shown = rows.filter((r) =>
    `${r.name} ${r.search_words || ''}`.toLowerCase().includes(q.toLowerCase()));

  const set = (k) => (v) => setEdit((e) => ({ ...e, [k]: v }));

  return (
    <View style={S.screen}>
      <View style={[S.header, { paddingTop: 50 }]}>
        <TouchableOpacity onPress={() => navigation.goBack()} accessibilityLabel="Back"
          hitSlop={{ top: 14, bottom: 14, left: 14, right: 14 }}
          style={{ paddingVertical: 8, paddingRight: 10, paddingLeft: 2 }}>
          <Text style={{ fontSize: 26, color: C.ink }}>‹</Text>
        </TouchableOpacity>
        <Text style={S.h1}>Items</Text>
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
      </View>

      <View style={{ padding: 16, paddingBottom: bulk ? 10 : 16 }}>
        <TextInput style={S.input} placeholder="Search" placeholderTextColor={C.faint}
          value={q} onChangeText={setQ} />
      </View>

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
          <Text style={{ color: C.muted, fontWeight: '600', textAlign: 'center', marginTop: 30 }}>
            No items yet. You can add them here, or just start billing — a new
            name on a bill can be saved as an item there and then.
          </Text>}
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
              <Text style={{ fontSize: 11.5, fontWeight: '600', color: C.muted, marginTop: 2 }}>
                {item.hsn ? `HSN ${item.hsn} · ` : ''}GST {item.gst_rate || 0}% · per {uqcShort(item.unit)}
              </Text>
            </View>
            <Text style={[{ fontSize: 16, fontWeight: '800', color: C.ink }, S.num]}>
              ₹{fmt0(item.sale_price)}
            </Text>
          </TouchableOpacity>
        ))} />

      {bulk && (
        <View style={S.foot}>
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
        </View>
      )}

      <Modal visible={!!edit} animationType="slide">
        {!!edit && (
          <ScrollView style={S.screen} keyboardShouldPersistTaps="handled"
                      contentContainerStyle={{ padding: 20, paddingTop: 54 }}>
            <Text style={{ fontSize: 24, fontWeight: '800', color: C.ink }}>
              {edit.id ? 'Edit item' : 'New item'}
            </Text>

            <Text style={[S.label, { marginTop: 18 }]}>ITEM NAME</Text>
            <TextInput style={[S.input, { marginTop: 6 }]} value={edit.name} onChangeText={set('name')} />

            <Text style={[S.label, { marginTop: 14 }]}>ALSO CALLED</Text>
            <TextInput style={[S.input, { marginTop: 6 }]} placeholder="balti, bucket, tub"
              value={edit.alias || ''} onChangeText={set('alias')} />
            <Text style={{ fontSize: 11.5, color: C.muted, marginTop: 5 }}>
              Local names. Any of these words will find this item while billing.
            </Text>

            <Text style={[S.label, { marginTop: 14 }]}>OTHER SEARCH WORDS</Text>
            <TextInput style={[S.input, { marginTop: 6 }]} placeholder="thali, plate, steel"
              value={edit.search_words} onChangeText={set('search_words')} />

            <Text style={[S.label, { marginTop: 14 }]}>UNIT</Text>
            <View style={{ marginTop: 6 }}>
              <UomField value={edit.unit} onChange={set('unit')} />
            </View>

            {hsnApplies(org) && (
              <>
                <Text style={[S.label, { marginTop: 14 }]}>HSN CODE</Text>
                <View style={{ marginTop: 6 }}>
                  <HsnField value={edit.hsn} org={org} onChange={set('hsn')} onRate={set('gst_rate')} />
                </View>

                <Text style={[S.label, { marginTop: 14 }]}>GST RATE %</Text>
                <TextInput style={[S.input, { marginTop: 6 }]} keyboardType="numeric"
                  value={edit.gst_rate} onChangeText={set('gst_rate')} />
              </>
            )}

            <Text style={[S.label, { marginTop: 14 }]}>
              {(org?.price1_name || 'Wholesale').toUpperCase()} PRICE
            </Text>
            <TextInput style={[S.input, { marginTop: 6 }]} keyboardType="numeric"
              value={edit.sale_price} onChangeText={set('sale_price')} />

            <Text style={[S.label, { marginTop: 14 }]}>
              {(org?.price2_name || 'Retail').toUpperCase()} PRICE
            </Text>
            <TextInput style={[S.input, { marginTop: 6 }]} keyboardType="numeric"
              value={edit.price2} onChangeText={set('price2')} />

            <Text style={[S.label, { marginTop: 14 }]}>PURCHASE PRICE</Text>
            <TextInput style={[S.input, { marginTop: 6 }]} keyboardType="numeric"
              value={edit.purchase_price} onChangeText={set('purchase_price')} />

            {!edit.id && org?.stock_enabled && (
              <>
                <Text style={[S.label, { marginTop: 14 }]}>OPENING STOCK</Text>
                <TextInput style={[S.input, { marginTop: 6 }]} keyboardType="numeric"
                  value={edit.opening_stock} onChangeText={set('opening_stock')} />
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
              <Text style={S.btnText}>SAVE</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => setEdit(null)}
              style={{ marginTop: 14, alignItems: 'center', paddingVertical: 10 }}>
              <Text style={{ fontSize: 16, fontWeight: '700', color: C.muted }}>Cancel</Text>
            </TouchableOpacity>
            <View style={{ height: 40 }} />
          </ScrollView>
        )}
      </Modal>
    </View>
  );
}
