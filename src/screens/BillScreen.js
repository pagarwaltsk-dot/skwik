import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, ScrollView, Alert, Modal, Platform, BackHandler,
  Linking,
} from 'react-native';
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';
import * as IntentLauncher from 'expo-intent-launcher';
import { File, Paths } from 'expo-file-system';
import * as FileSystem from 'expo-file-system/legacy';

import { useFocusEffect } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { supabase } from '../lib/supabase';
import { sayPlainly } from '../lib/offline';
import { useApp } from '../AppContext';
import {
  computeBill, fmt, fmt0, hsnApplies, num, pct, rateIsGuessed, saleRate, settle,
  taxModeFor, today, topRate,
} from '../lib/money';
import { STATES } from '../lib/states';
import { showBatch, showExpiry, showGodowns, showStock } from '../lib/features';
import { searchItems, parseQuery, highlightParts, tok } from '../lib/search';
import { uqcShort } from '../lib/uqc';
import { checkHsn, hsnExists } from '../lib/hsn';
import { HsnField, UomField } from '../components/Pickers';
import { invoiceHtml } from '../lib/invoice';
import { thermalHtml } from '../lib/receipt';
import {
  uuid, withTimeout, looksOffline, cacheItems, cacheParties,
  cachedItems, cachedParties, takeLocalNumber, queueAdd, flushQueue,
} from '../lib/offline';
import { BackButton, Bar, Box, Foot, KeyForm, MoreButton, Screen } from '../components/Chrome';
import { ScanSheet, ScanButton } from '../components/Scan';
import { ColHead } from '../components/Register';
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
  const editId = route.params?.voucherId || null;    // set when opening a saved bill
  const { org } = useApp();
  const insets = useSafeAreaInsets();
  const estimateMode = org?.mode === 'estimate';
  // A saved bill keeps the kind it was saved as, whatever the screen was opened with.
  const [loadedType, setLoadedType] = useState(null);
  const vtype  = loadedType
    || (vtypeParam === 'sale' && estimateMode ? 'estimate' : vtypeParam);
  const isOut  = vtype === 'sale' || vtype === 'estimate';     // going out of the shop
  const isBuy  = vtype === 'purchase';

  const [items, setItems]     = useState([]);
  const [parties, setParties] = useState([]);

  const [custOpen, setCustOpen] = useState(!route.params?.voucherId);
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
  const [scanOpen, setScanOpen] = useState(false);
  const [pendingCode, setPendingCode] = useState('');   // a code waiting for an item
  const [partySheet, setPartySheet] = useState(null);   // the sheet for a name not in the book
  const [godowns, setGodowns] = useState([]);
  const [godown, setGodown] = useState(null);           // which store the goods move through
  const [extraGst, setExtraGst] = useState('');    // '' = the dearest rate on the bill
  const [supNo, setSupNo] = useState('');
  const [supDate, setSupDate] = useState(today());
  const [vdate, setVdate] = useState(today());
  const [loadingBill, setLoadingBill] = useState(!!route.params?.voucherId);

  const [busy, setBusy]   = useState(false);
  const [nudged, setNudged] = useState(false);
  const [saved, setSaved] = useState(null);
  const [quick, setQuick] = useState(null);
  const qRef = useRef(null);
  const xRef = useRef(null);                       // freight amount
  const qName = useRef(null), qAlias = useRef(null);
  const npName = useRef(null), npPhone = useRef(null), npAddr = useRef(null);
  const npArea = useRef(null), npOpen = useRef(null);
  const npGst = useRef(null), npState = useRef(null);
  const qGst  = useRef(null), qRate  = useRef(null);
  const qRate2 = useRef(null), qBuy = useRef(null), qOpen = useRef(null);
  const seq  = useRef(0);
  // Every qty and rate box on the bill, so the keyboard's next key can
  // walk from one to the next without anybody tapping.
  const cell = useRef({});
  const focusCell = (key, which) =>
    setTimeout(() => cell.current[`${key}:${which}`]?.focus(), 60);

  // Items and customers are kept on the phone as well, so this screen opens
  // and bills can be written whether or not there is any signal.
  const [offline, setOffline] = useState(false);
  const newParty = useRef(null);     // a customer invented with no signal
  const newItems = useRef([]);       // items added mid-bill with no signal

  useEffect(() => {
    (async () => {
      try {
        const [i, p] = await withTimeout(Promise.all([
          supabase.from('items').select('*').eq('is_active', true).order('name'),
          supabase.from('parties').select('*').order('name'),
        ]));
        if (i.error || p.error) throw (i.error || p.error);
        setItems(i.data || []);
        setParties(p.data || []);
        setOffline(false);
        if (showGodowns(org)) {
          const { data: gs } = await supabase.from('godowns').select('*').order('name');
          setGodowns(gs || []);
          setGodown(org?.default_godown_id
            || (gs || []).find((g) => g.is_main)?.id || (gs || [])[0]?.id || null);
        }
        cacheItems(i.data || []);
        cacheParties(p.data || []);
      } catch (e) {
        // no signal, or the server is not answering: use what we copied last time
        const [ci, cp] = await Promise.all([cachedItems(), cachedParties()]);
        setItems(ci); setParties(cp);
        setOffline(true);
      }
    })();
  }, []);

  // Opening a bill that was already saved: put it back on the screen exactly
  // as it was written, ready to be changed.
  useEffect(() => {
    if (!editId) return;
    let alive = true;
    (async () => {
      const [{ data: v }, { data: ls }] = await Promise.all([
        supabase.from('vouchers').select('*, parties(*)').eq('id', editId).maybeSingle(),
        supabase.from('voucher_lines').select('*').eq('voucher_id', editId).order('line_no'),
      ]);
      if (!alive) return;
      if (!v) { setLoadingBill(false);
                return Alert.alert('Not found', 'That bill is no longer in your books.'); }

      setLoadedType(v.vtype);
      setVdate(v.vdate);
      setCust(v.parties || { name: v.printed_name || 'CASH' });
      setIsCash(!!v.is_cash);
      setExtra(Number(v.extra_amount) ? String(v.extra_amount) : '');
      setExtraGst(Number(v.extra_gst_rate) ? String(v.extra_gst_rate) : '');
      setExtraNote(v.extra_note || '');
      setShowExtra(!!Number(v.extra_amount));
      setSupNo(v.supplier_invoice_no || '');
      if (v.supplier_invoice_date) setSupDate(v.supplier_invoice_date);

      setLines((ls || []).map((l) => {
        seq.current += 1;
        return {
          key: seq.current, item_id: l.item_id, item_name: l.item_name,
          hsn: l.hsn || '', unit: l.unit || 'PCS', gst_rate: Number(l.gst_rate) || 0,
          qty: String(Number(l.qty)), rate: String(Number(l.rate)),
          disc: Number(l.disc) || 0,
          batch: l.batch || '', expiry: l.expiry || '',
          rateEdited: true, flag: !!l.flag, checked: !!l.checked, note: l.note || '',
        };
      }));
      setLoadingBill(false);
    })();
    return () => { alive = false; };
  }, [editId]);

  /* ---------------- customer ---------------- */

  const cashInfo = useMemo(() => {
    const t = cq.trim();
    if (!isOut) return { isCash: false, name: t };
    const m = t.match(/^cash\b\s*(.*)$/i);
    return m ? { isCash: true, name: m[1].trim() } : { isCash: false, name: t };
  }, [cq, isOut]);

  // by name OR phone number
  // Only what he is typing towards. A shop with three hundred customers does
  // not want the first eight of them in alphabetical order.
  // A purchase is to a supplier and a bill is to a customer, and nobody wants
  // to scroll past the wrong half of his book to find either. Anyone marked
  // "both" shows on both sides, and so does anyone never marked at all.
  const forThisBill = (p) => {
    const k = String(p.kind || '').toLowerCase();
    if (!k || k === 'both') return true;
    return isBuy ? k === 'supplier' : k === 'customer';
  };

  const custHits = cq.trim()
    ? parties.filter((p) => {
        const s = cashInfo.name.toLowerCase();
        if (!s || !forThisBill(p)) return false;
        return p.name.toLowerCase().indexOf(s) > -1 || String(p.phone || '').indexOf(s) > -1;
      }).slice(0, 8)
    : [];

  const chooseCust = (p) => {
    setCust(p); setIsCash(cashInfo.isCash); setCustOpen(false);
    applyList(Number(p.price_list) === 2 ? 2 : 1);
    setTimeout(() => qRef.current?.focus(), 150);   // known name: straight to products
  };
  const newCust = () => {
    // Asked once, here, rather than left for later — a customer with no phone
    // number is a reminder that can never be sent, and one with no state is a
    // bill that may carry the wrong tax.
    setPartySheet({
      name: cashInfo.name || 'CASH',
      kind: isBuy ? 'supplier' : 'customer',
      phone: '', area: '', address: '', gstin: '',
      opening_balance: '', opening_type: 'owes_you',
      price_list: String(priceList || 1),
      state_code: String(org?.state_code || ''),
    });
    setIsCash(cashInfo.isCash);
    setCustOpen(false);
  };

  // What the sheet collected, taken as the customer for this bill. He is
  // written to the book when the bill is saved, not before — a sheet closed
  // halfway leaves nothing behind.
  const takeNewParty = () => {
    const np = partySheet;
    if (!np?.name?.trim()) return Alert.alert('Name', 'Type the name.');
    const code = String(np.state_code || '').trim();
    setCust({
      name: np.name.trim(), isNew: true,
      kind: np.kind,
      phone: String(np.phone || '').replace(/\D/g, '').slice(-10),
      area: np.area?.trim() || '',
      address: np.address?.trim() || '',
      gstin: String(np.gstin || '').toUpperCase().trim(),
      opening_balance: num(np.opening_balance),
      opening_type: np.opening_type === 'you_owe' ? 'you_owe' : 'owes_you',
      price_list: Number(np.price_list) === 2 ? 2 : 1,
      state_code: code || org?.state_code,
      state_name: STATES[code] || org?.state_name,
    });
    if (!isBuy) applyList(Number(np.price_list) === 2 ? 2 : 1);
    setPartySheet(null);
    setTimeout(() => qRef.current?.focus(), 150);
  };

  /* ---------------- product entry ---------------- */

  const hits = useMemo(() => searchItems(items, q), [items, q]);
  const parsed = parseQuery(q);

  // Which list this bill is on decides the rate. A rate already typed by hand
  // is never touched by it.
  // On a purchase bill the rate is what he pays. On a sale bill it is what he
  // charges — and if nobody ever set that, it is his cost plus a tenth rather
  // than nothing at all, because a line at zero gives the goods away.
  const listRate = (p, list) => {
    if (isBuy) return p.purchase_price || p.sale_price;
    return saleRate(p, list || priceList);
  };

  // A packet scanned at the counter. Known code: the line goes on and the
  // quantity box is waiting. Scanned twice: the quantity goes up by one
  // instead of a second line appearing, which is what a shop actually wants.
  // Unknown code: he is asked once what it is, and it is remembered.
  const scanned = (code) => {
    const hit = items.find((it) => String(it.barcode || '').trim() === code);
    if (hit) {
      const already = lines.find((l) => l.item_id === hit.id);
      if (already) {
        setLine(already.key, { qty: String(num(already.qty) + 1) });
      } else {
        addHit({ p: hit, qty: 1, toks: [] });
      }
      return;
    }
    setScanOpen(false);
    Alert.alert('New barcode',
      'No item in your book carries that code. Add it to an item now?',
      [{ text: 'Not now' },
       { text: 'Yes', onPress: () => { setPendingCode(code); setQ(''); qRef.current?.focus(); } }]);
  };

  const addHit = (h) => {
    const rate = listRate(h.p);
    seq.current += 1;
    const line = {
      key: seq.current, item_id: h.p.id, item_name: h.p.name, hsn: h.p.hsn || '',
      unit: h.p.unit || 'PCS', gst_rate: Number(h.p.gst_rate) || 0,
      qty: h.qty == null ? '' : String(h.qty), rate: String(rate || ''),
      // the rate was worked out from cost, not set by anyone: the line says so
      rateGuessed: !isBuy && rateIsGuessed(h.p, priceList),
      rateEdited: false, flag: false, checked: false, note: '', disc: 0,
      batch: '', expiry: '',
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
    // This comes back seconds later, by which time he may already be typing
    // the rate himself. Whatever he has put in wins — a box that changes under
    // his finger is worse than no help at all.
    if (!data?.[0]?.rate) return;
    setLines((ls) => ls.map((l) => (
      l.key === key && !l.rateEdited && !l.rateTouched
        ? { ...l, rate: String(data[0].rate), fromHistory: true }
        : l)));
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
      rateGuessed: !isBuy && rateIsGuessed(h.p, priceList),
      rateEdited: false,
    });
    setSwapFor(null); setSq('');
  };

  /* ---------------- totals ---------------- */

  const mode = estimateMode ? 'none' : taxModeFor(org, cust);
  const good = lines.filter((l) => l.item_name.trim() && num(l.qty) > 0);
  const extraAmt  = num(extra);
  // Freight carries the dearest rate on the bill unless he says otherwise.
  const extraRate = extraGst === '' ? topRate(good) : num(extraGst);
  const calc = computeBill(good, mode, { amount: extraAmt, gst_rate: extraRate });
  const grand = calc.total;
  const roundOff = calc.round_off;
  const checked = lines.filter((l) => l.checked).length;
  const discTotal = good.reduce((t, l) => t + num(l.disc), 0);
  const wantBatch  = showBatch(org);
  const wantExpiry = showExpiry(org);

  /* ---------------- new product, mid-bill ---------------- */

  const saveQuick = async () => {
    const taxed = org?.is_gst_registered && !org?.is_composition;
    if (!quick.name.trim()) return Alert.alert('Name needed', 'Type the item name.');
    if (!quick.unit) return Alert.alert('Unit needed', 'Choose how this item is counted.');
    const problem = checkHsn(quick.hsn, org);
    if (problem) return Alert.alert('HSN code', problem);

    const write = async () => {
      const body = {
        id: uuid(),
        org_id: org.id, name: quick.name.trim(), alias: quick.alias.trim(),
        unit: quick.unit, hsn: quick.hsn.trim(), gst_rate: num(quick.gst_rate),
        barcode: pendingCode || null,
        // `rate` is whichever rate this bill is asking for; `other` is the one
        // it is not. An item born on a purchase bill used to go in with no
        // sale price at all, which left it priceless on every sale bill after
        // and invisible to anything that reads the shelf by value.
        sale_price:     isBuy ? num(quick.other) : num(quick.rate),
        purchase_price: isBuy ? num(quick.rate)  : num(quick.other),
        price2:         num(quick.rate2),
        opening_stock:  num(quick.opening_stock),
        is_active: true,
      };
      let saved = body;
      try {
        const { data, error } = await withTimeout(
          supabase.from('items').insert(body).select().single());
        if (error) throw error;
        saved = data;
      } catch (e) {
        if (!looksOffline(e)) return Alert.alert('Could not save', e.message || String(e));
        newItems.current = [...newItems.current, body];   // saved when the line comes back
        setOffline(true);
      }
      setItems((xs) => [...xs, saved]);
      setQuick(null);
      setPendingCode('');
      addHit({ p: saved, qty: quick.qty ? Number(quick.qty) : null, toks: [] });
    };

    // A tax invoice with a 0% line on it undercharges the customer and
    // understates the return. The rate is the one field on this sheet with
    // money behind it, so it is the one field nobody may skip past.
    if (taxed && !num(quick.gst_rate)) {
      return Alert.alert('GST rate?',
        'This item has no GST rate. A bill with it on will charge no tax. '
        + 'Put the rate in, or set it to 0 on purpose.',
        [{ text: 'Go back' }, { text: 'It really is 0%', onPress: write }]);
    }

    if (hsnApplies(org) && quick.hsn && !hsnExists(quick.hsn)) {
      return Alert.alert('Check this HSN', `${quick.hsn} is not in our list. Save it anyway?`,
        [{ text: 'Let me check' }, { text: 'Save anyway', onPress: write }]);
    }

    // An item bought but never priced is a rate typed by hand on every sale
    // bill for the rest of its life, and it is missing from anything that
    // reads the shelf by value. Asked once, here, while it is cheap to answer.
    if (isBuy && !num(quick.other)) {
      return Alert.alert('No sale rate',
        'This item has nothing to sell at. Every sale bill with it on will come '
        + 'up blank and you will type the rate in by hand.',
        [{ text: 'Let me put it in' }, { text: 'Leave it for now', onPress: write }]);
    }
    write();
  };

  /* ---------------- save ---------------- */

  const findOrCreateParty = async (name) => {
    const hit = parties.find((p) => p.name.toLowerCase() === name.toLowerCase());
    if (hit) return hit;

    // The phone decides the id, so the same customer cannot be created twice
    // when the queue is sent.
    const code = String(cust?.state_code || org.state_code || '').trim();
    const body = {
      id: uuid(),
      org_id: org.id, name,
      kind: cust?.kind || (isBuy ? 'supplier' : 'customer'),
      phone: cust?.phone || null,
      area: cust?.area || null,
      address: cust?.address || null,
      gstin: cust?.gstin || null,
      is_registered: !!cust?.gstin,
      // what he already owed before this bill — asked on the sheet, because a
      // customer entered mid-bill with a balance left out of him reads as
      // settled, and the udhar list is then wrong from the first day
      opening_balance: num(cust?.opening_balance),
      opening_type: cust?.opening_type === 'you_owe' ? 'you_owe' : 'owes_you',
      opening_date: cust?.opening_balance ? today() : null,
      price_list: isBuy ? 1 : (Number(cust?.price_list) || priceList),
      state_code: code,
      state_name: STATES[code] || cust?.state_name || org.state_name,
    };

    try {
      const { data, error } = await withTimeout(
        supabase.from('parties').insert(body).select().single());
      if (error) throw error;
      setParties((ps) => [...ps, data]);
      return data;
    } catch (e) {
      if (!looksOffline(e)) throw e;
      newParty.current = body;              // created when the line comes back
      setParties((ps) => [...ps, body]);
      setOffline(true);
      return body;
    }
  };

  const save = async (holdOnly) => {
    if (!good.length) return Alert.alert('Nothing to save', 'Add at least one item with a quantity.');
    if (!cust?.name) return Alert.alert('Who is it for?', 'Choose a customer first.');

    // NOTHING LEAVES THE SHOP AT NOTHING. A rate of zero on a sale is not a
    // discount, it is a giveaway, and it prints as 0.00 on the customer's copy.
    // Anything with a cost behind it has already been given cost plus a tenth
    // by the time it reaches here, so a zero at this point means the item has
    // no price of any kind and only he can say what it is worth.
    if (isOut) {
      const free = good.filter((l) => num(l.rate) <= 0);
      if (free.length) {
        return Alert.alert('This line has no rate',
          `${free[0].item_name} would go out at ₹0`
          + (free.length > 1 ? `, and ${free.length - 1} other line(s) too` : '')
          + '.\n\nThis item has no selling price and no purchase price either, '
          + 'so there is nothing to work one out from. Put the rate in.');
      }
    }
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
      const c = computeBill(good, m, { amount: extraAmt, gst_rate: extraRate });
      const total = c.total;

      const payload = {
        id: editId || uuid(),
        vtype,
        // A purchase belongs to the date on the supplier's bill. He often
        // enters August's bills in September, and they must land in August.
        vdate: editId ? vdate
             : (isBuy && supDate) ? supDate
             : today(),
        party_id: pty.id, printed_name: cust.name, is_cash: isCash,
        supplier_invoice_no: isBuy ? supNo : null,
        supplier_invoice_date: isBuy ? supDate : null,
        place_of_supply_code: pty.state_code || org.state_code,
        godown_id: godown || null,
        tax_mode: m,
        taxable: c.taxable, cgst: c.cgst, sgst: c.sgst, igst: c.igst,
        extra_amount: extraAmt, extra_note: extraNote, extra_gst_rate: c.extra_gst_rate,
        round_off: c.round_off, total,
        lines: c.lines.map((l) => ({
          item_id: l.item_id, item_name: l.item_name, hsn: l.hsn, unit: l.unit,
          qty: num(l.qty), rate: num(l.rate), gst_rate: l.gst_rate, disc: l.disc || 0,
          batch: (l.batch || '').trim() || null,
          expiry: (l.expiry || '').trim() || null,
          taxable: l.taxable, cgst: l.cgst, sgst: l.sgst, igst: l.igst,
          amount: l.amount, flag: !!l.flag, checked: !!l.checked,
          note: (l.note || '').trim() || null,
        })),
      };
      // Try the server. If there is no signal the bill is written into a
      // queue on this phone with its own number, printed straight away, and
      // sent by itself the next time anything gets through.
      let data, queued = false;
      try {
        const r = await withTimeout(supabase.rpc(
          editId ? 'update_voucher' : 'save_voucher', { p: payload }));
        if (r.error) throw r.error;
        data = r.data;
        setOffline(false);
        flushQueue(supabase);            // we have signal; send anything waiting
      } catch (e) {
        if (!looksOffline(e)) throw e;
        if (editId) {
          throw new Error('Changing a bill needs the internet. '
            + 'This bill is already saved and is safe — try again when you have signal.');
        }
        const localNo = await takeLocalNumber(org, vtype);
        payload.voucher_no = localNo;
        await queueAdd({
          id: payload.id, kind: 'bill', payload,
          newParty: newParty.current, newItems: newItems.current,
        });
        data = { voucher_no: localNo };
        queued = true;
        setOffline(true);
      }

      const rec = {
        voucher: { ...payload, voucher_no: data.voucher_no || supNo,
                   place_of_supply_name: pty.state_name || org.state_name },
        party: pty, lines: c.lines, queued,
      };
      newParty.current = null; newItems.current = [];
      if (holdOnly) { setSaved(null); navigation.navigate('Home'); }
      else setSaved(rec);
    } catch (e) {
      Alert.alert('Could not save', e.message || String(e));
    } finally { setBusy(false); }
  };

  // A4 for the file, a roll for the counter. The shop says which in Settings.
  const paper = String(org?.print_width || 'a4');
  const html = () => (paper === 'a4'
    ? invoiceHtml({ org, voucher: saved.voucher, party: saved.party, lines: saved.lines })
    : thermalHtml({ org, voucher: saved.voucher, party: saved.party, lines: saved.lines,
                    width: paper }));
  const onShare = async () => {
    const { uri } = await Print.printToFileAsync({ html: html() });
    await Sharing.shareAsync(uri, { mimeType: 'application/pdf', dialogTitle: 'Send' });
  };

  // THE PDF, STRAIGHT INTO WHATSAPP.
  //
  // Android can be told which app a file is going to, so the general sharing
  // sheet — WhatsApp, Gmail, Drive, Bluetooth, twenty icons — can be skipped
  // and WhatsApp opened directly with the bill already attached.
  //
  // What it still cannot do is choose the chat. Android gives no way to name
  // a recipient AND carry a file in the same breath; WhatsApp asks. So this
  // saves the sheet, not the tap. On anything that is not Android, or if
  // WhatsApp is not installed, it falls back to the sheet rather than failing.
  const onWhatsAppPdf = async () => {
    try {
      const { uri } = await Print.printToFileAsync({ html: html() });
      if (Platform.OS !== 'android') {
        return Sharing.shareAsync(uri, { mimeType: 'application/pdf', dialogTitle: 'Send' });
      }
      // a name the customer will recognise in his chat
      const v = saved?.voucher || {};
      const nice = `${(org?.name || 'Bill').replace(/[^A-Za-z0-9 ]/g, '')} ${v.voucher_no || ''}`
        .trim().replace(/\s+/g, '-') + '.pdf';
      let sendUri = uri;
      try {
        const src = new File(uri);
        const dst = new File(Paths.cache, nice);
        try { if (dst.exists) dst.delete(); } catch (e) { /* first time */ }
        src.copy(dst);
        sendUri = dst.uri;
      } catch (e) { /* keep the original name */ }

      const content = await FileSystem.getContentUriAsync(sendUri);
      await IntentLauncher.startActivityAsync('android.intent.action.SEND', {
        type: 'application/pdf',
        packageName: 'com.whatsapp',
        extra: { 'android.intent.extra.STREAM': content },
        flags: 1,                       // FLAG_GRANT_READ_URI_PERMISSION
      });
    } catch (e) {
      // no WhatsApp, or it refused the handover: the ordinary sheet still works
      try {
        const { uri } = await Print.printToFileAsync({ html: html() });
        await Sharing.shareAsync(uri, { mimeType: 'application/pdf', dialogTitle: 'Send' });
      } catch (e2) {
        Alert.alert('Could not send it', sayPlainly(e2));
      }
    }
  };

  // STRAIGHT INTO HIS CHAT.
  //
  // WhatsApp will open a named person's chat from a link, but it will NOT
  // carry a file in with it — no app can hand WhatsApp an attachment and a
  // recipient at the same time; only the sharing sheet can attach a file, and
  // the sharing sheet cannot choose the person. So there are two ways out of
  // this screen, and they do different jobs:
  //
  //   the chat      opens his own conversation with the figures written out,
  //                 no picking a name from a list, no typing
  //   the PDF       the sharing sheet, where he picks the chat himself
  //
  // Most counters want the first: the customer wants to know what he owes,
  // and the printed copy is already in his hand.
  const waNumber = () => {
    const raw = String(saved?.party?.phone || '').replace(/\D/g, '');
    if (!raw) return null;
    if (raw.length === 10) return `91${raw}`;             // an Indian number as everyone writes it
    if (raw.length === 12 && raw.startsWith('91')) return raw;
    if (raw.length > 12) return raw.slice(-12);
    return raw;
  };

  const onWhatsApp = async () => {
    const to = waNumber();
    const v = saved?.voucher || {};
    const body = [
      `${org?.name || 'Bill'}`,
      `${docName.replace('Editing ', '')} ${v.voucher_no || ''}`.trim(),
      `Amount: ₹${fmt0(v.total || 0)}`,
      v.vdate ? `Date: ${String(v.vdate).split('-').reverse().join('/')}` : null,
      '',
      'Thank you.',
    ].filter((x) => x !== null).join('\n');

    const url = to
      ? `whatsapp://send?phone=${to}&text=${encodeURIComponent(body)}`
      : `whatsapp://send?text=${encodeURIComponent(body)}`;
    try {
      await Linking.openURL(url);
    } catch (e) {
      Alert.alert('WhatsApp did not open',
        to ? 'This phone may not have WhatsApp installed. Use “Send the PDF” instead.'
           : 'Use “Send the PDF” instead.');
    }
  };
  const onPrint = () => Print.printAsync({ html: html() });

  const docName = editId
    ? (vtype === 'estimate' ? 'Editing estimate' : isBuy ? 'Editing purchase' : 'Editing bill')
    : (vtype === 'estimate' ? 'Estimate' : isBuy ? 'Purchase' : 'New Bill');

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

  // ONLY WHILE THIS SCREEN IS THE ONE IN FRONT.
  //
  // A bill screen stays alive underneath whatever is opened on top of it, so a
  // listener registered for as long as it is mounted goes on answering the
  // phone's back button from the ledger, from Stock, from anywhere — which is
  // how "Leave this bill?" ended up appearing on screens that have no bill on
  // them. useFocusEffect ties it to being in front instead of to being alive.
  //
  // The handler is read through a ref so it always runs the newest `leave`
  // without the listener being torn down and rebuilt on every keystroke.
  const leaveRef = useRef(leave);
  leaveRef.current = leave;
  useFocusEffect(useCallback(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress',
      () => leaveRef.current());
    return () => sub.remove();
  }, []));

  /* ---------------- screen ---------------- */

  return (
    <Screen ruler={!!org?.debug_keyboard}>

      {/* PINNED HEAD — who it is for, and what it comes to */}
      <Bar>
        <BackButton navigation={navigation} onPress={leave} />
        <TouchableOpacity style={{ flex: 1, minWidth: 0 }} onPress={() => setCustOpen(true)}>
          <Text numberOfLines={1} style={S.barName}>
            {cust ? (isCash ? `CASH ${cust.name}`.replace(/^CASH CASH$/, 'CASH') : cust.name)
                  : 'Tap to choose customer'}
          </Text>
          <Text numberOfLines={1} style={S.barSub}>{docName}</Text>
        </TouchableOpacity>
        {!!cust && <ScanButton light onPress={() => setScanOpen(true)} />}
        <View style={{ alignItems: 'flex-end' }}>
          <Text style={S.barTotL}>TOTAL</Text>
          <Text style={[S.barTot, S.num]}>₹{fmt0(grand)}</Text>
        </View>
      </Bar>

      {offline && (
        <View style={{ backgroundColor: C.flagSoft, borderBottomWidth: 1,
                       borderBottomColor: C.flagLine, paddingHorizontal: 12, paddingVertical: 7 }}>
          <Text style={{ fontSize: 12.5, fontWeight: '600', color: C.flagInk }}>
            No internet — carry on billing. It sends itself when the line comes back.
          </Text>
        </View>
      )}

      {/* A SUPPLIER'S BILL IS READ FROM THE TOP: his name, his bill number,
          its date, then the goods. Asking for the number at the end meant
          finding the paper again after the typing was done. */}
      {isBuy && !!cust && (
        <View style={{ backgroundColor: C.surface, paddingHorizontal: 12, paddingTop: 10,
                       paddingBottom: 4, borderBottomWidth: 1, borderBottomColor: C.line }}>
          <View style={[S.row, { gap: 10, alignItems: 'flex-start' }]}>
            <View style={{ flex: 1.2 }}>
              <Text style={S.cellLabel}>His bill number</Text>
              <TextInput style={S.cell} value={supNo} onChangeText={setSupNo}
                placeholder="e.g. 1024" placeholderTextColor={C.faint}
                autoCapitalize="characters"
                returnKeyType="next" submitBehavior="submit" />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={S.cellLabel}>Its date</Text>
              <TextInput style={[S.cell, S.num]} value={supDate} onChangeText={setSupDate}
                placeholder="2026-09-19" placeholderTextColor={C.faint}
                returnKeyType="next" submitBehavior="submit"
                onSubmitEditing={() => qRef.current?.focus()} />
            </View>
          </View>
          <Text style={[S.hint, { marginBottom: 8 }]}>
            The date on his bill, not today — a bill from last month is entered
            under last month.
          </Text>
        </View>
      )}

      {/* THE ENTRY LINE — one box, product and quantity together.
          Its key is the arrow, not the tick: every box on a bill carries you
          forward to the next one, so they all show the same thing. */}
      {!!cust && (
        <View style={{ backgroundColor: C.surface, paddingHorizontal: 12, paddingVertical: 8,
                       borderBottomWidth: 1, borderBottomColor: C.line }}>
          <TextInput
            ref={qRef}
            style={S.input}
            placeholder="Type item and quantity — thali 12"
            placeholderTextColor={C.faint}
            value={q} onChangeText={setQ}
            returnKeyType="next" submitBehavior="submit"
            onSubmitEditing={() => {
              if (hits.length) addHit(hits[0]);
              else if (q.trim()) setQuick({ name: parsed.base || parsed.full, alias: '',
                                            unit: 'PCS', hsn: '', gst_rate: '', rate: '',
                                            rate2: '', other: '', opening_stock: '',
                                            qty: parsed.qty == null ? '' : String(parsed.qty) });
            }} />
          {isOut && !cust?.price_list && (
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
                                            rate2: '', other: '', opening_stock: '',
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

      {/* the strip that names the columns, the way a ruled book does */}
      {!!lines.length && (
        <ColHead cols={[{ label: 'PARTICULARS' },
                        { label: 'QTY \u00D7 RATE', width: 118 },
                        { label: 'AMOUNT', width: 74 }]} />
      )}

      <ScrollView keyboardShouldPersistTaps="handled"
                  style={{ flex: 1 }}
                  contentContainerStyle={{ paddingBottom: 30 }}>

        {!lines.length && !!cust && (
          <Text style={{ color: C.muted, fontWeight: '600', textAlign: 'center',
                         marginTop: 40, paddingHorizontal: 24, lineHeight: 20 }}>
            Type an item above. Put the quantity after it — “thali 12” — and it
            goes straight in.
          </Text>
        )}

        {lines.map((l) => {
          const amt = num(l.qty) * num(l.rate);
          return (
            <View key={l.key} style={{
              backgroundColor: l.flag ? C.flagSoft : l.checked ? C.okSoft : C.surface,
              borderBottomWidth: 1, borderBottomColor: C.line,
              borderLeftWidth: (l.flag || l.checked) ? 3 : 0,
              borderLeftColor: l.flag ? C.flag : C.ok,
              paddingHorizontal: 14, paddingVertical: 12 }}>

              {/* the name line: what it is, and the two things you can do to it */}
              <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 6,
                             marginBottom: 12 }}>
                <TouchableOpacity onPress={() => toggleCheck(l.key)}
                  accessibilityLabel="I have re-checked this line"
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 4 }}
                  style={{ width: 24, height: 24, borderWidth: 1.5, borderRadius: 7,
                           alignItems: 'center', justifyContent: 'center', marginTop: 1,
                           borderColor: l.checked ? C.ok : C.greyB,
                           backgroundColor: l.checked ? C.ok : 'transparent' }}>
                  <Text style={{ fontSize: 14, fontWeight: '700',
                                 color: l.checked ? '#fff' : C.greyB }}>✓</Text>
                </TouchableOpacity>

                <TouchableOpacity onPress={() => toggleFlag(l.key)}
                  accessibilityLabel="Highlight this line on the bill"
                  hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}
                  style={{ paddingHorizontal: 2 }}>
                  <Text style={{ fontSize: 20, color: l.flag ? C.flag : C.greyB }}>
                    {l.flag ? '★' : '☆'}
                  </Text>
                </TouchableOpacity>

                <View style={{ flex: 1, minWidth: 0, paddingLeft: 2 }}>
                  <Text numberOfLines={2} style={S.lineNm}>{l.item_name}</Text>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 6 }}>
                    <TouchableOpacity style={S.tapPill}
                      onPress={() => { setSwapFor(swapFor === l.key ? null : l.key); setSq(''); }}>
                      <Text style={S.tapPillText}>change</Text>
                    </TouchableOpacity>
                    <Text style={S.unitPill}>{uqcShort(l.unit)}</Text>
                  </View>
                </View>

                <TouchableOpacity onPress={() => removeLine(l.key)} accessibilityLabel="Remove line"
                  hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                  style={{ paddingHorizontal: 4 }}>
                  <Text style={{ fontSize: 22, color: C.danger }}>×</Text>
                </TouchableOpacity>
              </View>

              {swapFor === l.key && (
                <View style={{ marginBottom: 9 }}>
                  <TextInput style={[S.input, { paddingVertical: 9 }]} autoFocus
                    placeholder="Change to another item" value={sq} onChangeText={setSq}
                    returnKeyType="next" submitBehavior="submit"
                    onSubmitEditing={() => { if (swapHits.length) doSwap(swapHits[0]); }} />
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
                  <Text style={S.cellLabel}>Qty</Text>
                  <TextInput style={[S.cell, S.num]} keyboardType="numeric" value={String(l.qty)}
                    ref={(r) => { cell.current[`${l.key}:qty`] = r; }}
                    selectTextOnFocus
                    returnKeyType="next" submitBehavior="submit"
                    onBlur={() => setLine(l.key, { qty: settle(l.qty) })}
                    onSubmitEditing={() => {
                      setLine(l.key, { qty: settle(l.qty) });
                      focusCell(l.key, 'rate');
                    }}
                    onChangeText={(t) => setLine(l.key, { qty: t })} />
                </View>
                <Text style={{ fontSize: 14, color: C.muted, paddingBottom: 11 }}>×</Text>
                <View style={{ flex: 1 }}>
                  <Text style={S.cellLabel}>Rate</Text>
                  <TextInput style={[S.cell, S.num]} keyboardType="numeric" value={String(l.rate)}
                    ref={(r) => { cell.current[`${l.key}:rate`] = r; }}
                    selectTextOnFocus
                    returnKeyType="next" submitBehavior="submit"
                    onBlur={() => setLine(l.key, { rate: settle(l.rate) })}
                    onSubmitEditing={() => {
                      setLine(l.key, { rate: settle(l.rate) });
                      qRef.current?.focus();
                    }}
                    onFocus={() => setLine(l.key, { rateTouched: true })}
                    onChangeText={(t) => setLine(l.key, { rate: t, rateEdited: true })} />
                </View>
                <Text style={[S.amt, { paddingBottom: 10, minWidth: 74 }]}>
                  {amt ? `₹${fmt0(amt)}` : '–'}
                </Text>
              </View>

              {/* the rate nobody set: say where it came from, so a worked-out
                  figure is never mistaken for a price somebody chose */}
              {l.rateGuessed && !l.rateEdited && (
                <Text style={{ fontSize: 11.5, color: C.edit, marginTop: 7, lineHeight: 16 }}>
                  No selling price on this item — this is what you paid plus 10%.
                  Change it if that is not your rate.
                </Text>
              )}

              {(wantBatch || wantExpiry) && (
                <View style={[S.row, { marginTop: 10, gap: 8 }]}>
                  {wantBatch && (
                    <View style={{ flex: 1 }}>
                      <Text style={S.cellLabel}>Batch</Text>
                      <TextInput style={S.cell} value={l.batch || ''}
                        placeholder="B-77" placeholderTextColor={C.faint}
                        autoCapitalize="characters"
                        returnKeyType="next" submitBehavior="submit"
                        onChangeText={(t) => setLine(l.key, { batch: t })} />
                    </View>
                  )}
                  {wantExpiry && (
                    <View style={{ flex: 1 }}>
                      <Text style={S.cellLabel}>Expiry</Text>
                      <TextInput style={[S.cell, S.num]} value={l.expiry || ''}
                        placeholder="2027-03-31" placeholderTextColor={C.faint}
                        keyboardType="numbers-and-punctuation"
                        returnKeyType="next" submitBehavior="submit"
                        onSubmitEditing={() => qRef.current?.focus()}
                        onChangeText={(t) => setLine(l.key, { expiry: t })} />
                    </View>
                  )}
                </View>
              )}

              {/* what came off this line. Hidden until he wants it, because
                  most lines have none, and the tax is worked out after it. */}
              {(l.disc > 0 || l.discOpen) ? (
                <View style={[S.row, { marginTop: 10, gap: 8 }]}>
                  <Text style={{ fontSize: 13, color: C.muted }}>Less</Text>
                  <TextInput style={[S.cell, S.num, { flex: 1 }]} keyboardType="numeric"
                    placeholder="0" placeholderTextColor={C.faint}
                    value={l.disc ? String(l.disc) : ''}
                    selectTextOnFocus
                    returnKeyType="next" submitBehavior="submit"
                    onSubmitEditing={() => qRef.current?.focus()}
                    onChangeText={(t) => setLine(l.key, { disc: num(t) })} />
                  <Text style={{ fontSize: 13, color: C.muted }}>
                    = {fmt(Math.max(0, num(l.qty) * num(l.rate) - num(l.disc)))}
                  </Text>
                </View>
              ) : null}

              {/* a word about this line, printed under it on the bill */}
              {l.noteOpen || l.note ? (
                <TextInput
                  style={[S.cell, { marginTop: 10, paddingVertical: 9, fontSize: 14 }]}
                  placeholder="Size, colour, anything the customer should see"
                  placeholderTextColor={C.faint} value={l.note || ''} autoFocus={!l.note}
                  returnKeyType="next" submitBehavior="submit"
                  onSubmitEditing={() => qRef.current?.focus()}
                  onChangeText={(t) => setLine(l.key, { note: t })} />
              ) : (
                <View style={[S.row, { gap: 8, marginTop: 10 }]}>
                  <TouchableOpacity style={[S.tapPill, { paddingVertical: 6, paddingHorizontal: 12 }]}
                    onPress={() => setLine(l.key, { noteOpen: true })}>
                    <Text style={S.tapPillText}>+ note</Text>
                  </TouchableOpacity>
                  {!l.disc && !l.discOpen && (
                    <TouchableOpacity style={[S.tapPill, { paddingVertical: 6, paddingHorizontal: 12 }]}
                      onPress={() => setLine(l.key, { discOpen: true })}>
                      <Text style={S.tapPillText}>+ less</Text>
                    </TouchableOpacity>
                  )}
                  <View style={{ flex: 1 }} />
                </View>
              )}
            </View>
          );
        })}

        {godowns.length > 1 && (
          <View style={[S.card, { paddingVertical: 10, marginHorizontal: 14, marginTop: 14 }]}>
            <Text style={S.eyebrow}>{isBuy ? 'Goods came into' : 'Goods went out of'}</Text>
            <View style={[S.row, { gap: 8, flexWrap: 'wrap' }]}>
              {godowns.map((g) => {
                const on = godown === g.id;
                return (
                  <TouchableOpacity key={g.id} onPress={() => setGodown(g.id)}
                    style={{ paddingHorizontal: 13, paddingVertical: 8, borderRadius: 9,
                             borderWidth: 1, borderColor: on ? C.accent : C.line,
                             backgroundColor: on ? C.accentSoft : C.surface }}>
                    <Text style={{ fontSize: 13, fontWeight: '700',
                                   color: on ? C.accent : C.muted }}>{g.name}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>
        )}

        {!!lines.length && (
          <View style={[S.card, { marginHorizontal: 14, marginTop: 14 }]}>
            <Text style={S.eyebrow}>Totals</Text>
            {!!discTotal && <Row k="Items" v={fmt(calc.taxable - extraAmt + discTotal)} />}
            {!!discTotal && <Row k="Less" v={`- ${fmt(discTotal)}`} />}
            <Row k={extraAmt ? 'Taxable value' : 'Items total'} v={fmt(calc.taxable)} />
            {mode === 'cgst_sgst' && (<><Row k="CGST" v={fmt(calc.cgst)} /><Row k="SGST" v={fmt(calc.sgst)} /></>)}
            {mode === 'igst' && <Row k="IGST" v={fmt(calc.igst)} />}
            {!!extraAmt && (
              <Row k={`${extraNote || 'Freight'}${mode !== 'none' && extraRate
                        ? ` (in the ${pct(extraRate)}% above)` : ''}`} v={fmt(extraAmt)} />
            )}
            {!!roundOff && <Row k="Round off" v={fmt(roundOff)} />}

            {!showExtra ? (
              <TouchableOpacity onPress={() => setShowExtra(true)} style={{ paddingTop: 8 }}>
                <Text style={{ fontSize: 13, fontWeight: '600', color: C.accent }}>
                  + Freight or other charge
                </Text>
              </TouchableOpacity>
            ) : (
              <View style={[S.row, { marginTop: 10 }]}>
                <TextInput style={[S.input, { flex: 1 }]} placeholder="What for?"
                  value={extraNote} onChangeText={setExtraNote}
                  returnKeyType="next" submitBehavior="submit"
                  onSubmitEditing={() => xRef.current?.focus()} />
                <TextInput style={[S.input, { width: 110 }, S.num]} ref={xRef}
                  keyboardType="numeric" placeholder="0" value={extra} onChangeText={setExtra}
                  returnKeyType="done" onBlur={() => setExtra(settle(extra))} />
              </View>
            )}

            {/* Freight is part of what is being supplied, so it carries tax
                like the goods do. The dearest rate on the bill is the usual
                answer and is offered; he can say otherwise. */}
            {showExtra && mode !== 'none' && !!extraAmt && (
              <View style={[S.row, { marginTop: 8, gap: 8, flexWrap: 'wrap' }]}>
                <Text style={{ fontSize: 12.5, color: C.muted }}>GST on it</Text>
                {[...new Set([topRate(good), 0, 5, 12, 18, 28])].map((r) => {
                  const on = extraRate === r;
                  return (
                    <TouchableOpacity key={r} onPress={() => setExtraGst(String(r))}
                      style={{ paddingHorizontal: 11, paddingVertical: 6, borderRadius: 8,
                               borderWidth: 1, borderColor: on ? C.accent : C.line,
                               backgroundColor: on ? C.accentSoft : C.surface }}>
                      <Text style={{ fontSize: 12.5, fontWeight: '700',
                                     color: on ? C.accent : C.muted }}>{pct(r)}%</Text>
                    </TouchableOpacity>
                  );
                })}
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

      {/* THE FOOT OF THE PAGE.
          A ruled book closes with its total on paper and nothing else beside
          it, so the figure a shopkeeper reads out loud at the counter is never
          crowded by buttons. The buttons go below it, on the dark bar, where
          the phone's own back and home keys used to steal them. */}
      <View style={{ backgroundColor: C.surface, borderTopWidth: 1.5, borderTopColor: C.ink,
                     paddingHorizontal: 14, paddingVertical: 10,
                     flexDirection: 'row', alignItems: 'baseline', gap: 10 }}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={S.footL}>
            {good.length} ITEM{good.length === 1 ? '' : 'S'}
            {mode !== 'none' && (calc.cgst + calc.sgst + calc.igst) > 0
              ? ` · GST ₹${fmt0(calc.cgst + calc.sgst + calc.igst)}` : ''}
          </Text>
          <Text style={S.footTot}>₹{fmt0(grand)}</Text>
        </View>
      </View>

      <Foot style={{ backgroundColor: C.barInk, borderTopWidth: 0,
                     paddingHorizontal: 12, gap: 8 }}>
        <TouchableOpacity onPress={() => save(true)} disabled={busy}
          style={[S.darkBtn, { flex: 0.8 }, busy && { opacity: 0.5 }]}>
          <Text style={S.darkBtnText}>Save only</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => save(false)} disabled={busy}
          style={[S.darkBtn, S.darkBtnOn, { flex: 1.4 }, busy && { opacity: 0.5 }]}>
          <Text style={S.darkBtnTextOn}>
            {busy ? 'Saving…' : editId ? 'Save changes' : 'Save & send'}
          </Text>
        </TouchableOpacity>
      </Foot>

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
            placeholderTextColor={C.faint}
            returnKeyType="next" submitBehavior="submit"
            onSubmitEditing={() => { if (custHits.length) chooseCust(custHits[0]);
                                     else if (cashInfo.name) newCust(); }}
            value={cq} onChangeText={setCq} />
          {isOut && cashInfo.isCash && (
            <Text style={{ marginTop: 8, fontSize: 12.5, fontWeight: '700', color: C.green }}>
              Cash sale{cashInfo.name ? ` · ${cashInfo.name}'s name prints on the bill` : ''}
            </Text>
          )}
          {!cq.trim() && (
            <Text style={{ fontSize: 13.5, color: C.muted, marginTop: 20, lineHeight: 20 }}>
              Start typing a name or a phone number.
              {isOut ? '\nFor a cash sale, type CASH, or CASH and the name.' : ''}
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

      {/* ---------- a name that is not in the book yet ---------- */}
      <Modal visible={!!partySheet} transparent animationType="slide"
             onRequestClose={() => setPartySheet(null)}>
        <View style={{ flex: 1, backgroundColor: '#3B3A35DD', justifyContent: 'flex-end' }}>
          <KeyForm style={{ maxHeight: '92%' }}
            contentContainerStyle={{ backgroundColor: C.bg, borderTopLeftRadius: 26,
                                     borderTopRightRadius: 26, padding: 20 }}>
            {!!partySheet && (
              <>
                <Text style={{ fontSize: 21, fontWeight: '800', color: C.ink }}>
                  New {partySheet.kind === 'supplier' ? 'supplier' : 'customer'}
                </Text>
                <Text style={{ fontSize: 13, fontWeight: '600', color: C.muted, marginTop: 4 }}>
                  Asked once. Everything here can be changed later under Customers.
                </Text>

                <Text style={[S.label, { marginTop: 16 }]}>NAME</Text>
                <Box ref={npName} next={npPhone} style={{ marginTop: 6 }} autoFocus
                  value={partySheet.name}
                  onChangeText={(t) => setPartySheet((x) => ({ ...x, name: t }))} />

                <Text style={[S.label, { marginTop: 14 }]}>PHONE — FOR WHATSAPP</Text>
                <Box ref={npPhone} next={npArea} style={[S.num, { marginTop: 6 }]}
                  keyboardType="phone-pad" maxLength={10} placeholder="98640 12345"
                  value={partySheet.phone}
                  onChangeText={(t) => setPartySheet((x) => ({ ...x, phone: t }))} />
                <Text style={{ fontSize: 11.5, color: C.muted, marginTop: 4 }}>
                  Without it his bill cannot be sent and no reminder can reach him.
                </Text>

                <Text style={[S.label, { marginTop: 14 }]}>AREA</Text>
                <Box ref={npArea} next={npAddr} style={{ marginTop: 6 }}
                  placeholder="Fancy Bazar, Ward 4, GS Road"
                  value={partySheet.area}
                  onChangeText={(t) => setPartySheet((x) => ({ ...x, area: t }))} />
                <Text style={{ fontSize: 11.5, color: C.muted, marginTop: 4 }}>
                  His locality, in your own words. Bills sort by it when you send
                  a boy out with four of them.
                </Text>

                <Text style={[S.label, { marginTop: 14 }]}>ADDRESS</Text>
                <Box ref={npAddr} next={npGst} style={{ marginTop: 6 }}
                  placeholder="Shop and street"
                  value={partySheet.address}
                  onChangeText={(t) => setPartySheet((x) => ({ ...x, address: t }))} />

                {/* THE STATE IS ALWAYS ASKED.
                    It used to be hidden behind "is this shop GST registered",
                    which meant a shop writing estimates today collected no
                    states at all — and the day it registers, every customer
                    on its book is silently assumed to be in its own state and
                    every out-of-state bill carries the wrong tax. It is one
                    field. It is asked now. */}
                {!!org?.is_gst_registered && (
                  <>
                    <Text style={[S.label, { marginTop: 14 }]}>GST NUMBER</Text>
                    <Box ref={npGst} next={npState} style={{ marginTop: 6 }}
                      autoCapitalize="characters" maxLength={15}
                      placeholder="Leave empty if he is unregistered"
                      value={partySheet.gstin}
                      onChangeText={(t) => {
                        const g = t.toUpperCase().trim();
                        setPartySheet((x) => ({ ...x, gstin: g,
                          state_code: g.length >= 2 && STATES[g.slice(0, 2)]
                            ? g.slice(0, 2) : x.state_code }));
                      }} />

                  </>
                )}

                <Text style={[S.label, { marginTop: 14 }]}>STATE CODE</Text>
                <Box ref={npState} next={npOpen} style={[S.num, { marginTop: 6 }]}
                  keyboardType="number-pad" maxLength={2}
                  value={String(partySheet.state_code || '')}
                  onChangeText={(t) => setPartySheet((x) => ({ ...x, state_code: t }))} />
                <Text style={{ fontSize: 11.5, color: C.muted, marginTop: 4 }}>
                  {STATES[partySheet.state_code]
                    ? `${STATES[partySheet.state_code]}${org?.is_gst_registered
                        ? ` — ${String(partySheet.state_code) === String(org?.state_code)
                            ? 'his bills carry CGST and SGST' : 'his bills carry IGST'}`
                        : ''}`
                    : 'Two digits — 18 for Assam. It decides whether a bill carries '
                      + 'CGST and SGST or IGST, and it is needed the day you register.'}
                </Text>

                {!isBuy && (
                  <>
                    <Text style={[S.label, { marginTop: 14 }]}>WHICH PRICE LIST</Text>
                    <View style={[S.row, { gap: 8, marginTop: 6 }]}>
                      {[[1, org?.price1_name || 'Wholesale'], [2, org?.price2_name || 'Retail']]
                        .map(([v, label]) => {
                          const on = Number(partySheet.price_list) === v;
                          return (
                            <TouchableOpacity key={v}
                              onPress={() => setPartySheet((x) => ({ ...x, price_list: String(v) }))}
                              style={{ flex: 1, paddingVertical: 11, borderRadius: 9,
                                       alignItems: 'center', borderWidth: 1,
                                       borderColor: on ? C.accent : C.line,
                                       backgroundColor: on ? C.accentSoft : C.surface }}>
                              <Text style={{ fontSize: 14, fontWeight: '700',
                                             color: on ? C.accent : C.muted }}>{label}</Text>
                            </TouchableOpacity>
                          );
                        })}
                    </View>
                    <Text style={{ fontSize: 11.5, color: C.muted, marginTop: 4 }}>
                      Chosen once. Every bill for him uses that list from now on.
                    </Text>
                  </>
                )}

                <Text style={[S.label, { marginTop: 14 }]}>
                  {isBuy ? 'ALREADY OWED TO HIM' : 'ALREADY OWES YOU'}
                </Text>
                <Box ref={npOpen} onSubmit={takeNewParty} style={[S.num, { marginTop: 6 }]}
                  keyboardType="numeric" placeholder="0"
                  value={partySheet.opening_balance}
                  onChangeText={(t) => setPartySheet((x) => ({ ...x, opening_balance: t }))} />
                {num(partySheet.opening_balance) > 0 ? (
                  <View style={[S.row, { gap: 8, marginTop: 8 }]}>
                    {[['owes_you', isBuy ? 'You owe him' : 'He owes you'],
                      ['you_owe',  isBuy ? 'He owes you' : 'You owe him']]
                      .map(([v, label]) => {
                        const on = (partySheet.opening_type || 'owes_you') === v;
                        return (
                          <TouchableOpacity key={v}
                            onPress={() => setPartySheet((x) => ({ ...x, opening_type: v }))}
                            style={{ flex: 1, paddingVertical: 11, borderRadius: 9,
                                     alignItems: 'center', borderWidth: 1,
                                     borderColor: on ? C.accent : C.line,
                                     backgroundColor: on ? C.accentSoft : C.surface }}>
                            <Text style={{ fontSize: 14, fontWeight: '700',
                                           color: on ? C.accent : C.muted }}>{label}</Text>
                          </TouchableOpacity>
                        );
                      })}
                  </View>
                ) : (
                  <Text style={{ fontSize: 11.5, color: C.muted, marginTop: 4 }}>
                    Old dues from before Skwik. Leave it empty if the slate is clean —
                    put in later and his account will read as settled when it is not.
                  </Text>
                )}

                <TouchableOpacity style={[S.btn, { marginTop: 22 }]} onPress={takeNewParty}>
                  <Text style={S.btnText}>Start his bill</Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={() => { setPartySheet(null); setCustOpen(true); }}
                  style={{ marginTop: 12, alignItems: 'center', paddingVertical: 10 }}>
                  <Text style={{ fontSize: 16, fontWeight: '700', color: C.muted }}>Back</Text>
                </TouchableOpacity>
                <View style={{ height: 30 }} />
              </>
            )}
          </KeyForm>
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
                <Box ref={qName} next={qAlias} style={{ marginTop: 6 }} value={quick.name}
                  onChangeText={(t) => setQuick((x) => ({ ...x, name: t }))} />

                <Text style={[S.label, { marginTop: 14 }]}>ALSO CALLED</Text>
                <Box ref={qAlias} next={hsnApplies(org) ? qGst : qRate} style={{ marginTop: 6 }}
                  placeholder="balti, bucket, tub"
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
                    <Box ref={qGst} next={qRate} style={{ marginTop: 6 }} keyboardType="numeric"
                      value={quick.gst_rate}
                      onChangeText={(t) => setQuick((x) => ({ ...x, gst_rate: t }))} />
                  </>
                )}

                <Text style={[S.label, { marginTop: 14 }]}>
                  {isBuy ? 'PURCHASE RATE' : `RATE — ${(org?.price1_name || 'WHOLESALE').toUpperCase()}`}
                </Text>
                <Box ref={qRate} next={isBuy ? qBuy : qRate2} style={{ marginTop: 6 }}
                  keyboardType="numeric"
                  value={quick.rate} onChangeText={(t) => setQuick((x) => ({ ...x, rate: t }))} />

                {!isBuy && (
                  <>
                    <Text style={[S.label, { marginTop: 14 }]}>
                      RATE — {(org?.price2_name || 'RETAIL').toUpperCase()}
                    </Text>
                    <Box ref={qRate2} next={qBuy} style={{ marginTop: 6 }} keyboardType="numeric"
                      placeholder="Leave empty to use the same rate"
                      value={quick.rate2}
                      onChangeText={(t) => setQuick((x) => ({ ...x, rate2: t }))} />
                  </>
                )}

                <Text style={[S.label, { marginTop: 14 }]}>
                  {isBuy ? 'SALE RATE' : 'PURCHASE RATE — WHAT IT COSTS YOU'}
                </Text>
                <Box ref={qBuy} next={showStock(org) ? qOpen : null}
                  onSubmit={showStock(org) ? undefined : saveQuick}
                  style={{ marginTop: 6 }} keyboardType="numeric"
                  placeholder={isBuy ? 'What you will sell it at' : 'For the profit figure'}
                  value={quick.other} onChangeText={(t) => setQuick((x) => ({ ...x, other: t }))} />
                <Text style={{ fontSize: 11.5, color: C.muted, marginTop: 4 }}>
                  {isBuy
                    ? 'Without it this item has no rate on any sale bill, and you will '
                      + 'be typing it in by hand every time.'
                    : 'Without it the profit figure counts this item as pure profit.'}
                </Text>

                {showStock(org) && (
                  <>
                    <Text style={[S.label, { marginTop: 14 }]}>
                      OPENING STOCK{quick.unit ? ` — ${uqcShort(quick.unit)}` : ''}
                    </Text>
                    <Box ref={qOpen} onSubmit={saveQuick} style={{ marginTop: 6 }}
                      keyboardType="numeric" placeholder="How many you already have"
                      value={quick.opening_stock}
                      onChangeText={(t) => setQuick((x) => ({ ...x, opening_stock: t }))} />
                    <Text style={{ fontSize: 11.5, color: C.muted, marginTop: 4 }}>
                      {isBuy
                        ? 'What was on the shelf BEFORE this purchase bill. The quantity '
                          + 'on this bill is added on top.'
                        : 'What is on the shelf now, before this bill goes out.'}
                    </Text>
                  </>
                )}

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
          <View style={{ backgroundColor: '#fff', borderTopLeftRadius: 18, borderTopRightRadius: 18,
                         padding: 20, paddingBottom: 20 + Math.max(insets.bottom, 10) }}>
            <Text style={{ fontSize: 13, color: C.muted, letterSpacing: 1 }}>
              {docName.toUpperCase()} {saved?.voucher?.voucher_no || ''}
            </Text>
            {saved?.queued && (
              <Text style={{ fontSize: 12.5, fontWeight: '600', color: C.flagInk, marginTop: 6 }}>
                Saved on this phone. Give the customer the bill as usual — it
                reaches your books by itself when the internet is back.
              </Text>
            )}
            <Text style={[{ fontSize: 30, fontWeight: '700', color: C.ink, marginTop: 6, marginBottom: 16 },
                          S.num]}>
              ₹{fmt0(saved?.voucher?.total || 0)}
            </Text>
            <TouchableOpacity style={[S.btn, { backgroundColor: C.wa }]} onPress={onWhatsApp}>
              <Text style={S.btnText}>
                {saved?.party?.phone
                  ? `WhatsApp ${String(saved.party.name || '').split(' ')[0]}`
                  : 'Send on WhatsApp'}
              </Text>
            </TouchableOpacity>
            {!saved?.party?.phone && (
              <Text style={{ fontSize: 11.5, color: C.muted, marginTop: 6, lineHeight: 16 }}>
                No phone number on his record, so you will have to pick the chat.
                Put his number under Customers and it opens straight into it.
              </Text>
            )}
            <View style={[S.row, { marginTop: 10, gap: 10 }]}>
              <TouchableOpacity style={[S.btnGhost, { flex: 1, paddingVertical: 14 }]}
                onPress={onWhatsAppPdf}>
                <Text style={[S.ghostText, { fontSize: 15 }]}>PDF on WhatsApp</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[S.btnGhost, { flex: 1, paddingVertical: 14 }]}
                onPress={onPrint}>
                <Text style={[S.ghostText, { fontSize: 15 }]}>Print</Text>
              </TouchableOpacity>
            </View>
            <TouchableOpacity onPress={() => { setSaved(null); navigation.navigate('Home'); }}
              style={{ marginTop: 16, alignItems: 'center', paddingVertical: 10 }}>
              <Text style={{ fontSize: 16, fontWeight: '600', color: C.muted }}>Done</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
      <ScanSheet visible={scanOpen} onClose={() => setScanOpen(false)} onCode={scanned}
        title="Point at the barcode"
        note="Scan the same packet twice and the quantity goes up" />
    </Screen>
  );
}

const Row = ({ k, v }) => (
  <View style={[S.row, { marginBottom: 6 }]}>
    <Text style={{ flex: 1, fontSize: 13, fontWeight: '600', color: '#4A4944' }}>{k}</Text>
    <Text style={[{ fontSize: 13, fontWeight: '600', color: '#4A4944' }, S.num]}>{v}</Text>
  </View>
);
