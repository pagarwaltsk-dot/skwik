import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, ScrollView, Alert, Modal, Platform,
  KeyboardAvoidingView, BackHandler,
} from 'react-native';
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';

import { supabase } from '../lib/supabase';
import { useApp } from '../AppContext';
import { computeBill, taxModeFor, fmt, fmt0, num, hsnApplies } from '../lib/money';
import { searchItems, parseQuery, highlightParts, tok } from '../lib/search';
import { uqcShort } from '../lib/uqc';
import { checkHsn, hsnExists } from '../lib/hsn';
import { HsnField, UomField } from '../components/Pickers';
import { invoiceHtml } from '../lib/invoice';
import { C, S } from '../theme';

// Matched letters shown marked, the way the estimate app does it.
const Marked = ({ text, toks, style }) => (
  <Text style={style} numberOfLines={1}>
    {highlightParts(text, toks).map((p, i) => (
      <Text key={i} style={p.hit ? { backgroundColor: C.greenL, color: C.greenD } : null}>
        {p.text}
      </Text>
    ))}
  </Text>
);

export default function BillScreen({ route, navigation }) {
  const vtypeParam = route.params?.vtype || 'sale';
  const { org } = useApp();
  const estimateMode = org?.mode === 'estimate';
  const vtype  = vtypeParam === 'sale' && estimateMode ? 'estimate' : vtypeParam;
  const isOut  = vtype === 'sale' || vtype === 'estimate';     // going out of the shop
  const isBuy  = vtype === 'purchase';

  const [items, setItems]     = useState([]);
  const [parties, setParties] = useState([]);

  const [custOpen, setCustOpen] = useState(true);
  const [cq, setCq]       = useState('');
  const [cust, setCust]   = useState(null);          // {id?, name, phone, state_code…}
  const [isCash, setIsCash] = useState(false);

  const [q, setQ]         = useState('');
  const [lines, setLines] = useState([]);            // newest FIRST
  const [swapFor, setSwapFor] = useState(null);
  const [sq, setSq]       = useState('');
  const [priceList, setPriceList] = useState(1);
  const [extra, setExtra] = useState('');
  const [extraNote, setExtraNote] = useState('');
  const [showExtra, setShowExtra] = useState(false);
  const [supNo, setSupNo] = useState('');
  const [supDate, setSupDate] = useState(new Date().toISOString().slice(0, 10));

  const [busy, setBusy]   = useState(false);
  const [nudged, setNudged] = useState(false);
  const [saved, setSaved] = useState(null);
  const [quick, setQuick] = useState(null);
  const qRef = useRef(null);
  const seq  = useRef(0);
  // Every qty and rate box on the bill, so the keyboard's next key can
  // walk from one to the next without anybody tapping.
  const cell = useRef({});
  const focusCell = (key, which) =>
    setTimeout(() => cell.current[`${key}:${which}`]?.focus(), 60);

  useEffect(() => {
    (async () => {
      const [i, p] = await Promise.all([
        supabase.from('items').select('*').eq('is_active', true).order('name'),
        supabase.from('parties').select('*').order('name'),
      ]);
      setItems(i.data || []);
      setParties(p.data || []);
    })();
  }, []);

  /* ---------------- customer ---------------- */

  const cashInfo = useMemo(() => {
    const t = cq.trim();
    if (!isOut) return { isCash: false, name: t };
    const m = t.match(/^cash\b\s*(.*)$/i);
    return m ? { isCash: true, name: m[1].trim() } : { isCash: false, name: t };
  }, [cq, isOut]);

  // by name OR phone number
  const custHits = cq.trim()
    ? parties.filter((p) => {
        const s = cashInfo.name.toLowerCase();
        if (!s) return false;
        return p.name.toLowerCase().indexOf(s) > -1 || String(p.phone || '').indexOf(s) > -1;
      }).slice(0, 8)
    : parties.slice(0, 8);

  const chooseCust = (p) => {
    setCust(p); setIsCash(cashInfo.isCash); setCustOpen(false);
    applyList(Number(p.price_list) === 2 ? 2 : 1);
    setTimeout(() => qRef.current?.focus(), 150);   // known name: straight to products
  };
  const newCust = () => {
    setCust({ name: cashInfo.name || 'CASH', isNew: true, phone: '',
              state_code: org?.state_code, state_name: org?.state_name });
    setIsCash(cashInfo.isCash);
    setCustOpen(false);
  };

  /* ---------------- product entry ---------------- */

  const hits = useMemo(() => searchItems(items, q), [items, q]);
  const parsed = parseQuery(q);

  // Which list this bill is on decides the rate. A rate already typed by hand
  // is never touched by it.
  const listRate = (p, list) => {
    if (isBuy) return p.purchase_price || p.sale_price;
    return (list || priceList) === 2 ? (p.price2 || p.sale_price) : p.sale_price;
  };

  const addHit = (h) => {
    const rate = listRate(h.p);
    seq.current += 1;
    const line = {
      key: seq.current, item_id: h.p.id, item_name: h.p.name, hsn: h.p.hsn || '',
      unit: h.p.unit || 'PCS', gst_rate: Number(h.p.gst_rate) || 0,
      qty: h.qty == null ? '' : String(h.qty), rate: String(rate || ''),
      rateEdited: false, flag: false, checked: false,
    };
    setLines((ls) => [line, ...ls]);                 // newest at the TOP
    setQ('');
    // quantity was typed: on to the next product. Not typed: ask for it,
    // with the cursor already sitting in the quantity box.
    if (h.qty != null) setTimeout(() => qRef.current?.focus(), 80);
    else focusCell(line.key, 'qty');

    if (cust?.id) lastRate(line.key, h.p.id);
  };

  const lastRate = async (key, itemId) => {
    const { data } = await supabase
      .from('voucher_lines')
      .select('rate, vouchers!inner(party_id, vtype, vdate)')
      .eq('item_id', itemId).eq('vouchers.party_id', cust.id)
      .in('vouchers.vtype', isBuy ? ['purchase'] : ['sale', 'estimate'])
      .order('vdate', { foreignTable: 'vouchers', ascending: false }).limit(1);
    if (data?.[0]?.rate) setLine(key, { rate: String(data[0].rate) });
  };

  const applyList = (list) => {
    setPriceList(list);
    setLines((ls) => ls.map((l) => {
      if (l.rateEdited || isBuy) return l;
      const p = items.find((x) => x.id === l.item_id);
      if (!p) return l;
      const r = list === 2 ? (p.price2 || p.sale_price) : p.sale_price;
      return { ...l, rate: String(r || '') };
    }));
  };

  const setLine = (key, patch) =>
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const removeLine = (key) => setLines((ls) => ls.filter((l) => l.key !== key));
  const toggleFlag  = (key) => setLines((ls) => ls.map((l) => l.key === key ? { ...l, flag: !l.flag } : l));
  const toggleCheck = (key) => setLines((ls) => ls.map((l) => l.key === key ? { ...l, checked: !l.checked } : l));

  const swapHits = useMemo(
    () => (swapFor == null ? [] : searchItems(items, sq || ' ', 12)), [items, sq, swapFor]);

  // Swap the product, keep the quantity, take the new rate.
  const doSwap = (h) => {
    setLine(swapFor, {
      item_id: h.p.id, item_name: h.p.name, hsn: h.p.hsn || '', unit: h.p.unit || 'PCS',
      gst_rate: Number(h.p.gst_rate) || 0,
      rate: String(listRate(h.p) || ''),
    });
    setSwapFor(null); setSq('');
  };

  /* ---------------- totals ---------------- */

  const mode = estimateMode ? 'none' : taxModeFor(org, cust);
  const good = lines.filter((l) => l.item_name.trim() && num(l.qty) > 0);
  const calc = computeBill(good, mode);
  const extraAmt = num(extra);
  const grandExact = calc.taxable + calc.cgst + calc.sgst + calc.igst + extraAmt;
  const grand = Math.round(grandExact);
  const roundOff = Math.round((grand - grandExact) * 100) / 100;
  const checked = lines.filter((l) => l.checked).length;

  /* ---------------- new product, mid-bill ---------------- */

  const saveQuick = async () => {
    if (!quick.name.trim()) return Alert.alert('Name needed', 'Type the item name.');
    if (!quick.unit) return Alert.alert('Unit needed', 'Choose how this item is counted.');
    const problem = checkHsn(quick.hsn, org);
    if (problem) return Alert.alert('HSN code', problem);

    const write = async () => {
      const { data, error } = await supabase.from('items').insert({
        org_id: org.id, name: quick.name.trim(), alias: quick.alias.trim(),
        unit: quick.unit, hsn: quick.hsn.trim(), gst_rate: num(quick.gst_rate),
        sale_price: isBuy ? 0 : num(quick.rate),
        purchase_price: isBuy ? num(quick.rate) : 0,
      }).select().single();
      if (error) return Alert.alert('Could not save', error.message);
      setItems((xs) => [...xs, data]);
      setQuick(null);
      addHit({ p: data, qty: quick.qty ? Number(quick.qty) : null, toks: [] });
    };
    if (hsnApplies(org) && quick.hsn && !hsnExists(quick.hsn)) {
      return Alert.alert('Check this HSN', `${quick.hsn} is not in our list. Save it anyway?`,
        [{ text: 'Let me check' }, { text: 'Save anyway', onPress: write }]);
    }
    write();
  };

  /* ---------------- save ---------------- */

  const findOrCreateParty = async (name) => {
    const hit = parties.find((p) => p.name.toLowerCase() === name.toLowerCase());
    if (hit) return hit;
    const { data, error } = await supabase.from('parties').insert({
      org_id: org.id, name, kind: isBuy ? 'supplier' : 'customer',
      phone: cust?.phone || null,
      price_list: isBuy ? 1 : priceList,
      state_code: cust?.state_code || org.state_code,
      state_name: cust?.state_name || org.state_name,
    }).select().single();
    if (error) throw error;
    setParties((ps) => [...ps, data]);
    return data;
  };

  const save = async (holdOnly) => {
    if (!good.length) return Alert.alert('Nothing to save', 'Add at least one item with a quantity.');
    if (!cust?.name) return Alert.alert('Who is it for?', 'Choose a customer first.');
    if (isOut && isCash && !cashInfo.name && grand >= 50000) {
      return Alert.alert('Name needed',
        'A cash bill of ₹50,000 or more must show the customer name.');
    }
    // some ticked and some not: ask once
    if (!nudged && checked > 0 && checked < lines.length) {
      setNudged(true);
      return Alert.alert('Not all lines ticked',
        `${lines.length - checked} line(s) are not ticked yet. Tap save again to go ahead.`);
    }

    setBusy(true);
    try {
      const pty = cust.id ? cust : await findOrCreateParty(cust.name);
      const m = estimateMode ? 'none' : taxModeFor(org, pty);
      const c = computeBill(good, m);
      const exact = c.taxable + c.cgst + c.sgst + c.igst + extraAmt;
      const total = Math.round(exact);

      const payload = {
        vtype, vdate: new Date().toISOString().slice(0, 10),
        party_id: pty.id, printed_name: cust.name, is_cash: isCash,
        supplier_invoice_no: isBuy ? supNo : null,
        supplier_invoice_date: isBuy ? supDate : null,
        place_of_supply_code: pty.state_code || org.state_code,
        tax_mode: m,
        taxable: c.taxable, cgst: c.cgst, sgst: c.sgst, igst: c.igst,
        extra_amount: extraAmt, extra_note: extraNote,
        round_off: Math.round((total - exact) * 100) / 100, total,
        lines: c.lines.map((l) => ({
          item_id: l.item_id, item_name: l.item_name, hsn: l.hsn, unit: l.unit,
          qty: num(l.qty), rate: num(l.rate), gst_rate: l.gst_rate,
          taxable: l.taxable, cgst: l.cgst, sgst: l.sgst, igst: l.igst,
          amount: l.amount, flag: !!l.flag, checked: !!l.checked,
        })),
      };
      const { data, error } = await supabase.rpc('save_voucher', { p: payload });
      if (error) throw error;

      const rec = {
        voucher: { ...payload, voucher_no: data.voucher_no || supNo,
                   place_of_supply_name: pty.state_name || org.state_name },
        party: pty, lines: c.lines,
      };
      if (holdOnly) { setSaved(null); navigation.navigate('Home'); }
      else setSaved(rec);
    } catch (e) {
      Alert.alert('Could not save', e.message || String(e));
    } finally { setBusy(false); }
  };

  const html = () => invoiceHtml({ org, voucher: saved.voucher, party: saved.party, lines: saved.lines });
  const onShare = async () => {
    const { uri } = await Print.printToFileAsync({ html: html() });
    await Sharing.shareAsync(uri, { mimeType: 'application/pdf', dialogTitle: 'Send' });
  };
  const onPrint = () => Print.printAsync({ html: html() });

  const docName = vtype === 'estimate' ? 'Estimate' : isBuy ? 'Purchase' : 'New Bill';

  /* ---------------- going back ---------------- */

  // One way out, used by both the arrow and the phone's own back button, so the
  // two never disagree. A bill with lines on it is never thrown away silently.
  const leave = () => {
    if (quick)          { setQuick(null);   return true; }
    if (swapFor != null){ setSwapFor(null); return true; }
    if (saved)          { return true; }              // already saved: use Done
    if (custOpen) {
      if (!cust) { navigation.goBack(); return true; } // no customer picked yet
      setCustOpen(false); return true;
    }
    if (lines.length) {
      Alert.alert('Leave this bill?',
        `${lines.length} line${lines.length > 1 ? 's' : ''} will be lost.`,
        [{ text: 'Stay on the bill' },
         { text: 'Leave', style: 'destructive', onPress: () => navigation.goBack() }]);
      return true;
    }
    navigation.goBack();
    return true;
  };

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', leave);
    return () => sub.remove();
  });

  /* ---------------- screen ---------------- */

  return (
    <KeyboardAvoidingView style={S.screen} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>

      {/* PINNED HEAD — who it is for, and what it comes to */}
      <View style={[S.bar, { paddingTop: 46 }]}>
        <TouchableOpacity onPress={leave} accessibilityLabel="Back"
          hitSlop={{ top: 14, bottom: 14, left: 14, right: 14 }}
          style={{ paddingVertical: 8, paddingRight: 10, paddingLeft: 2 }}>
          <Text style={{ fontSize: 26, color: '#fff', opacity: 0.85 }}>‹</Text>
        </TouchableOpacity>
        <TouchableOpacity style={{ flex: 1, minWidth: 0 }} onPress={() => setCustOpen(true)}>
          <Text numberOfLines={1} style={S.barName}>
            {cust ? (isCash ? `CASH ${cust.name}`.replace(/^CASH CASH$/, 'CASH') : cust.name)
                  : 'Tap to choose customer'}
          </Text>
          <Text numberOfLines={1} style={S.barSub}>{docName}</Text>
        </TouchableOpacity>
        <View style={{ alignItems: 'flex-end' }}>
          <Text style={S.barTotL}>TOTAL</Text>
          <Text style={[S.barTot, S.num]}>₹{fmt0(grand)}</Text>
        </View>
      </View>

      {/* THE ENTRY LINE — one box, product and quantity together */}
      {!!cust && (
        <View style={{ backgroundColor: C.surface, paddingHorizontal: 12, paddingVertical: 8,
                       borderBottomWidth: 1, borderBottomColor: C.line }}>
          <TextInput
            ref={qRef}
            style={S.input}
            placeholder="Type item and quantity — thali 12"
            placeholderTextColor={C.faint}
            value={q} onChangeText={setQ}
            returnKeyType="done" blurOnSubmit={false}
            onSubmitEditing={() => {
              if (hits.length) addHit(hits[0]);
              else if (q.trim()) setQuick({ name: parsed.base || parsed.full, alias: '',
                                            unit: 'PCS', hsn: '', gst_rate: '', rate: '',
                                            qty: parsed.qty == null ? '' : String(parsed.qty) });
            }} />
          {isOut && (
            <View style={[S.row, { marginTop: 8 }]}>
              {[1, 2].map((n) => {
                const on = priceList === n;
                const nm = n === 1 ? (org?.price1_name || 'Wholesale') : (org?.price2_name || 'Retail');
                return (
                  <TouchableOpacity key={n} onPress={() => applyList(n)}
                    style={{ flex: 1, paddingVertical: 7, borderRadius: 9, alignItems: 'center',
                             borderWidth: 1, borderColor: on ? C.accent : C.line,
                             backgroundColor: on ? C.accentSoft : C.surface }}>
                    <Text style={{ fontSize: 13, fontWeight: '600', color: on ? C.accent : C.muted }}>
                      {nm}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          )}

          {!!q.trim() && (
            <View style={{ marginTop: 6, maxHeight: 280, borderWidth: 1, borderColor: C.line,
                           borderRadius: 9, backgroundColor: C.surface, overflow: 'hidden' }}>
              <ScrollView keyboardShouldPersistTaps="handled">
                {hits.map((h) => (
                  <TouchableOpacity key={h.p.id} onPress={() => addHit(h)} style={S.hit}>
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <View style={[S.row, { gap: 6 }]}>
                        <Marked text={h.p.name} toks={h.toks} style={[S.hitName, { flexShrink: 1 }]} />
                        {h.qty != null && (
                          <Text style={[S.qbadge, S.num]}>&times; {h.qty}</Text>
                        )}
                      </View>
                      <Text numberOfLines={1} style={S.hitSub}>
                        {uqcShort(h.p.unit)}{h.p.alias ? ` · ${h.p.alias}` : ''}
                      </Text>
                    </View>
                    <View style={{ alignItems: 'flex-end' }}>
                      <Text style={[S.hitPr, S.num]}>{fmt0(listRate(h.p))}</Text>
                      <Text style={{ fontSize: 10, color: C.muted }}>
                        {priceList === 1 ? (org?.price1_name || 'Wholesale') : (org?.price2_name || 'Retail')}
                      </Text>
                    </View>
                  </TouchableOpacity>
                ))}
                <TouchableOpacity
                  onPress={() => setQuick({ name: parsed.base || parsed.full, alias: '', unit: 'PCS',
                                            hsn: '', gst_rate: '', rate: '',
                                            qty: parsed.qty == null ? '' : String(parsed.qty) })}
                  style={{ paddingVertical: 12, paddingHorizontal: 12, backgroundColor: C.soft }}>
                  <Text style={{ fontSize: 14, fontWeight: '600', color: C.accent }}>
                    + Add “{parsed.base || parsed.full}” as a new item
                  </Text>
                </TouchableOpacity>
              </ScrollView>
            </View>
          )}
        </View>
      )}

      <ScrollView keyboardShouldPersistTaps="handled"
                  contentContainerStyle={{ padding: 14, paddingBottom: 30 }}>

        {!lines.length && !!cust && (
          <Text style={{ color: C.muted, fontWeight: '600', textAlign: 'center', marginTop: 40 }}>
            Type an item above. Put the quantity after it — “thali 12” — and it
            goes straight in.
          </Text>
        )}

        {lines.map((l) => {
          const amt = num(l.qty) * num(l.rate);
          return (
            <View key={l.key} style={[S.line, {
              backgroundColor: l.flag ? C.flagSoft : C.surface,
              borderColor: l.flag ? C.flagLine : l.checked ? C.okLine : C.line,
              borderLeftWidth: (l.flag || l.checked) ? 4 : 1,
              borderLeftColor: l.flag ? C.flag : l.checked ? C.ok : C.line }]}>

              <View style={[S.row, { alignItems: 'flex-start', gap: 4, marginBottom: 10 }]}>
                <TouchableOpacity onPress={() => toggleCheck(l.key)} accessibilityLabel="I have re-checked this line"
                  style={{ borderWidth: 1.5, borderRadius: 7, paddingHorizontal: 6, paddingVertical: 3,
                           borderColor: l.checked ? C.ok : C.line,
                           backgroundColor: l.checked ? C.ok : 'transparent' }}>
                  <Text style={{ fontSize: 15, fontWeight: '700', color: l.checked ? '#fff' : C.greyB }}>✓</Text>
                </TouchableOpacity>

                <TouchableOpacity onPress={() => toggleFlag(l.key)} accessibilityLabel="Highlight this line on the bill"
                  style={{ paddingHorizontal: 3, paddingTop: 1 }}>
                  <Text style={{ fontSize: 21, color: l.flag ? C.flag : C.greyB }}>{l.flag ? '★' : '☆'}</Text>
                </TouchableOpacity>

                <TouchableOpacity style={{ flex: 1, paddingLeft: 4 }}
                  onPress={() => { setSwapFor(swapFor === l.key ? null : l.key); setSq(''); }}>
                  <Text numberOfLines={2} style={S.lineNm}>
                    {l.item_name}
                    <Text style={{ fontSize: 10, fontWeight: '600', color: C.muted }}>{'  change'}</Text>
                  </Text>
                  <Text style={[S.chip, { alignSelf: 'flex-start', marginTop: 4 }]}>{uqcShort(l.unit)}</Text>
                </TouchableOpacity>

                <TouchableOpacity onPress={() => removeLine(l.key)} accessibilityLabel="Remove line"
                  style={{ paddingHorizontal: 6, paddingVertical: 2 }}>
                  <Text style={{ fontSize: 22, color: C.danger }}>×</Text>
                </TouchableOpacity>
              </View>

              {swapFor === l.key && (
                <View style={{ marginBottom: 9 }}>
                  <TextInput style={[S.input, { paddingVertical: 9 }]} autoFocus
                    placeholder="Change to another item" value={sq} onChangeText={setSq} />
                  <ScrollView style={{ maxHeight: 180 }} keyboardShouldPersistTaps="handled">
                    {swapHits.map((h) => (
                      <TouchableOpacity key={h.p.id} onPress={() => doSwap(h)}
                        style={{ paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: C.line }}>
                        <Text style={{ fontSize: 14.5, fontWeight: '700', color: C.ink }}>{h.p.name}</Text>
                      </TouchableOpacity>
                    ))}
                  </ScrollView>
                  <TouchableOpacity onPress={() => setSwapFor(null)} style={{ paddingVertical: 8 }}>
                    <Text style={{ fontWeight: '700', color: C.muted }}>Keep this one</Text>
                  </TouchableOpacity>
                </View>
              )}

              <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 8 }}>
                <View style={{ flex: 1 }}>
                  <Text style={S.label}>Qty</Text>
                  <TextInput style={[S.input, S.num]} keyboardType="numeric" value={String(l.qty)}
                    ref={(r) => { cell.current[`${l.key}:qty`] = r; }}
                    selectTextOnFocus
                    returnKeyType="next" blurOnSubmit={false}
                    onSubmitEditing={() => focusCell(l.key, 'rate')}
                    onChangeText={(t) => setLine(l.key, { qty: t })} />
                </View>
                <Text style={{ fontSize: 13, color: C.muted, paddingBottom: 12 }}>×</Text>
                <View style={{ flex: 1 }}>
                  <Text style={S.label}>Rate</Text>
                  <TextInput style={[S.input, S.num]} keyboardType="numeric" value={String(l.rate)}
                    ref={(r) => { cell.current[`${l.key}:rate`] = r; }}
                    selectTextOnFocus
                    returnKeyType="next" blurOnSubmit={false}
                    onSubmitEditing={() => qRef.current?.focus()}
                    onChangeText={(t) => setLine(l.key, { rate: t, rateEdited: true })} />
                </View>
                <Text style={[S.amt, S.num, { paddingBottom: 11, minWidth: 74 }]}>
                  {amt ? fmt0(amt) : '–'}
                </Text>
              </View>
            </View>
          );
        })}

        {isBuy && (
          <View style={[S.row, { marginTop: 4, marginBottom: 12 }]}>
            <View style={{ flex: 1 }}>
              <Text style={S.label}>SUPPLIER BILL NO.</Text>
              <TextInput style={[S.input, { marginTop: 6 }]} value={supNo} onChangeText={setSupNo} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={S.label}>BILL DATE</Text>
              <TextInput style={[S.input, { marginTop: 6 }]} value={supDate} onChangeText={setSupDate} />
            </View>
          </View>
        )}

        {!!lines.length && (
          <View style={S.card}>
            <Row k="Items total" v={fmt(calc.taxable)} />
            {mode === 'cgst_sgst' && (<><Row k="CGST" v={fmt(calc.cgst)} /><Row k="SGST" v={fmt(calc.sgst)} /></>)}
            {mode === 'igst' && <Row k="IGST" v={fmt(calc.igst)} />}
            {!!extraAmt && <Row k={extraNote || 'Extra'} v={fmt(extraAmt)} />}
            {!!roundOff && <Row k="Round off" v={fmt(roundOff)} />}

            {!showExtra ? (
              <TouchableOpacity onPress={() => setShowExtra(true)} style={{ paddingTop: 8 }}>
                <Text style={{ fontSize: 13, fontWeight: '600', color: C.accent }}>
                  + Add freight or other charge
                </Text>
              </TouchableOpacity>
            ) : (
              <View style={[S.row, { marginTop: 10 }]}>
                <TextInput style={[S.input, { flex: 1 }]} placeholder="What for?"
                  value={extraNote} onChangeText={setExtraNote} />
                <TextInput style={[S.input, { width: 110 }, S.num]}
                  keyboardType="numeric" placeholder="0" value={extra} onChangeText={setExtra} />
              </View>
            )}

            <View style={[S.tline, { borderTopWidth: 2, borderTopColor: C.ink, marginTop: 8, paddingTop: 10 }]}>
              <Text style={{ fontSize: 20, fontWeight: '700', color: C.ink }}>Total</Text>
              <Text style={[{ fontSize: 20, fontWeight: '700', color: C.ink }, S.num]}>₹{fmt0(grand)}</Text>
            </View>

            {!!lines.length && checked > 0 && (
              <Text style={{ marginTop: 10, fontSize: 11.5, fontWeight: '600',
                             color: checked === lines.length ? C.ok : C.flagInk }}>
                {checked === lines.length
                  ? `All ${checked} lines re-checked.`
                  : `${checked} of ${lines.length} lines re-checked.`}
              </Text>
            )}
          </View>
        )}
      </ScrollView>

      <View style={S.foot}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={S.footL}>TOTAL</Text>
          <Text style={[S.footTot, S.num]}>₹{fmt0(grand)}</Text>
        </View>
        <TouchableOpacity onPress={() => save(true)} disabled={busy} style={S.btnGhost}>
          <Text style={[S.ghostText, { fontSize: 13, lineHeight: 16 }]}>{'Save\nonly'}</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => save(false)} disabled={busy}
          style={[S.btn, busy && { backgroundColor: C.faint }]}>
          <Text style={S.btnText}>{busy ? 'Saving…' : 'Save & send'}</Text>
        </TouchableOpacity>
      </View>

      {/* ---------- customer picker ---------- */}
      <Modal visible={custOpen} animationType="slide" onRequestClose={() => setCustOpen(false)}>
        <View style={[S.screen, { paddingTop: 50, paddingHorizontal: 16 }]}>
          <View style={S.row}>
            <Text style={S.h1}>{isBuy ? 'Who did you buy from?' : 'Who is it for?'}</Text>
            {!!cust && (
              <TouchableOpacity onPress={() => setCustOpen(false)}>
                <Text style={{ fontWeight: '800', color: C.muted }}>CLOSE</Text>
              </TouchableOpacity>
            )}
          </View>
          <TextInput style={[S.input, { marginTop: 14 }]} autoFocus
            placeholder={isOut ? 'Name, phone, or CASH' : 'Supplier name or phone'}
            value={cq} onChangeText={setCq} />
          {isOut && cashInfo.isCash && (
            <Text style={{ marginTop: 8, fontSize: 12.5, fontWeight: '700', color: C.green }}>
              Cash sale{cashInfo.name ? ` · ${cashInfo.name}'s name prints on the bill` : ''}
            </Text>
          )}
          <ScrollView keyboardShouldPersistTaps="handled" style={{ marginTop: 12 }}>
            {custHits.map((p) => (
              <TouchableOpacity key={p.id} onPress={() => chooseCust(p)}
                style={{ paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: C.line }}>
                <Text style={{ fontSize: 16.5, fontWeight: '700', color: C.ink }}>{p.name}</Text>
                <Text style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>
                  {[p.phone, p.state_name].filter(Boolean).join(' · ')}
                </Text>
              </TouchableOpacity>
            ))}
            {!!cashInfo.name && (
              <TouchableOpacity onPress={newCust}
                style={{ paddingVertical: 15, marginTop: 8, borderRadius: 12, backgroundColor: C.greenL,
                         paddingHorizontal: 13 }}>
                <Text style={{ fontSize: 15, fontWeight: '800', color: C.greenD }}>
                  + Bill “{cashInfo.name}” as a new {isBuy ? 'supplier' : 'customer'}
                </Text>
              </TouchableOpacity>
            )}
          </ScrollView>
        </View>
      </Modal>

      {/* ---------- new item, mid-bill ---------- */}
      <Modal visible={!!quick} transparent animationType="slide" onRequestClose={() => setQuick(null)}>
        <View style={{ flex: 1, backgroundColor: '#3B3A35DD', justifyContent: 'flex-end' }}>
          <ScrollView keyboardShouldPersistTaps="handled" style={{ maxHeight: '90%' }}
            contentContainerStyle={{ backgroundColor: C.bg, borderTopLeftRadius: 26,
                                     borderTopRightRadius: 26, padding: 20 }}>
            {!!quick && (
              <>
                <Text style={{ fontSize: 21, fontWeight: '800', color: C.ink }}>New item</Text>
                <Text style={{ fontSize: 13, fontWeight: '600', color: C.muted, marginTop: 4 }}>
                  Asked once. Next time it fills itself.
                </Text>

                <Text style={[S.label, { marginTop: 16 }]}>ITEM NAME</Text>
                <TextInput style={[S.input, { marginTop: 6 }]} value={quick.name}
                  onChangeText={(t) => setQuick((x) => ({ ...x, name: t }))} />

                <Text style={[S.label, { marginTop: 14 }]}>ALSO CALLED</Text>
                <TextInput style={[S.input, { marginTop: 6 }]} placeholder="balti, bucket, tub"
                  value={quick.alias} onChangeText={(t) => setQuick((x) => ({ ...x, alias: t }))} />
                <Text style={{ fontSize: 11.5, color: C.muted, marginTop: 5 }}>
                  Any of these words will find this item later.
                </Text>

                <Text style={[S.label, { marginTop: 14 }]}>UNIT</Text>
                <View style={{ marginTop: 6 }}>
                  <UomField value={quick.unit} onChange={(v) => setQuick((x) => ({ ...x, unit: v }))} />
                </View>

                {hsnApplies(org) && (
                  <>
                    <Text style={[S.label, { marginTop: 14 }]}>
                      {isBuy ? "HSN — COPY FROM YOUR SUPPLIER'S BILL" : 'HSN CODE'}
                    </Text>
                    <View style={{ marginTop: 6 }}>
                      <HsnField value={quick.hsn} org={org}
                        onChange={(v) => setQuick((x) => ({ ...x, hsn: v }))}
                        onRate={(v) => setQuick((x) => ({ ...x, gst_rate: v }))} />
                    </View>
                    <Text style={[S.label, { marginTop: 14 }]}>GST RATE %</Text>
                    <TextInput style={[S.input, { marginTop: 6 }]} keyboardType="numeric"
                      value={quick.gst_rate}
                      onChangeText={(t) => setQuick((x) => ({ ...x, gst_rate: t }))} />
                  </>
                )}

                <Text style={[S.label, { marginTop: 14 }]}>{isBuy ? 'PURCHASE RATE' : 'RATE'}</Text>
                <TextInput style={[S.input, { marginTop: 6 }]} keyboardType="numeric"
                  value={quick.rate} onChangeText={(t) => setQuick((x) => ({ ...x, rate: t }))} />

                <TouchableOpacity style={[S.btn, { marginTop: 22 }]} onPress={saveQuick}>
                  <Text style={S.btnText}>SAVE AND USE</Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={() => setQuick(null)}
                  style={{ marginTop: 12, alignItems: 'center', paddingVertical: 10 }}>
                  <Text style={{ fontSize: 16, fontWeight: '700', color: C.muted }}>Cancel</Text>
                </TouchableOpacity>
                <View style={{ height: 30 }} />
              </>
            )}
          </ScrollView>
        </View>
      </Modal>

      {/* ---------- saved ---------- */}
      <Modal visible={!!saved} transparent animationType="slide">
        <View style={{ flex: 1, backgroundColor: '#3B3A35EE', justifyContent: 'flex-end' }}>
          <View style={{ backgroundColor: '#fff', borderTopLeftRadius: 14, borderTopRightRadius: 14, padding: 20 }}>
            <Text style={{ fontSize: 13, color: C.muted, letterSpacing: 1 }}>
              {docName.toUpperCase()} {saved?.voucher?.voucher_no || ''}
            </Text>
            <Text style={[{ fontSize: 30, fontWeight: '700', color: C.ink, marginTop: 6, marginBottom: 16 },
                          S.num]}>
              ₹{fmt0(saved?.voucher?.total || 0)}
            </Text>
            <TouchableOpacity style={[S.btn, { backgroundColor: C.wa }]} onPress={onShare}>
              <Text style={S.btnText}>Send on WhatsApp</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[S.btnGhost, { marginTop: 10, paddingVertical: 14 }]} onPress={onPrint}>
              <Text style={[S.ghostText, { fontSize: 16 }]}>Print</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => { setSaved(null); navigation.navigate('Home'); }}
              style={{ marginTop: 16, alignItems: 'center', paddingVertical: 10 }}>
              <Text style={{ fontSize: 16, fontWeight: '600', color: C.muted }}>Done</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </KeyboardAvoidingView>
  );
}

const Row = ({ k, v }) => (
  <View style={[S.row, { marginBottom: 6 }]}>
    <Text style={{ flex: 1, fontSize: 13, fontWeight: '600', color: '#4A4944' }}>{k}</Text>
    <Text style={[{ fontSize: 13, fontWeight: '600', color: '#4A4944' }, S.num]}>{v}</Text>
  </View>
);
