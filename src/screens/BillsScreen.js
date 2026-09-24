import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, FlatList, Modal, Alert, ActivityIndicator,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';

import { supabase } from '../lib/supabase';
import { useApp } from '../AppContext';
import { fmt0 } from '../lib/money';
import { uqcShort } from '../lib/uqc';
import { invoiceHtml } from '../lib/invoice';
import { thermalHtml } from '../lib/receipt';
import { BackButton, Bar, Foot, MoreButton, Screen, Swipe, useTabSwipe } from '../components/Chrome';
import { showPurchase, showReturns } from '../lib/features';
import { C, S } from '../theme';
import { pdfName, sharePdf } from '../lib/pdf';
import { sayPlainly } from '../lib/offline';

// EVERY BILL EVER WRITTEN. Find one, read it, send it again, fix it, remove it.
//
// A shopkeeper is asked "send me last Tuesday's bill again" every week, and
// until now Skwik had no answer to that. This is the answer.

// The filter strip only offers what this shop has switched on, so a counter
// that never takes goods back is not asked to read the word "Returns".
const kindsFor = (org) => {
  // A SHOP THAT ONLY WRITES ESTIMATES HAS NO BILLS TAB.
  // It was always there and always empty, and an empty tab on a small screen
  // is one more thing to tap and be disappointed by.
  const estimateOnly = String(org?.mode || '') === 'estimate';
  return [
    { key: 'all',      label: 'All'       },
    !estimateOnly && { key: 'sale',     label: 'Bills'     },
    { key: 'estimate', label: 'Estimates' },
    showPurchase(org) && { key: 'purchase', label: 'Purchases' },
    showReturns(org)  && { key: 'returns',  label: 'Returns'   },
  ].filter(Boolean);
};

const dmy = (d) => `${String(d).slice(8, 10)}/${String(d).slice(5, 7)}/${String(d).slice(0, 4)}`;

// "Today", "Yesterday", then the plain date — the way somebody actually thinks
// about when a bill was written.
const dayLabel = (d) => {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const that  = new Date(`${d}T00:00:00`);
  const days  = Math.round((today - that) / 86400000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return dmy(d);
};

export default function BillsScreen({ navigation }) {
  const { org, isOwner } = useApp();
  const KINDS = kindsFor(org);
  const [rows, setRows]   = useState([]);
  const [busy, setBusy]   = useState(true);
  const [q, setQ]         = useState('');
  const [kind, setKind]   = useState('all');
  const swipe = useTabSwipe(KINDS.map((k) => k.key), kind, setKind);
  const [open, setOpen]   = useState(null);      // the bill tapped on
  const [lines, setLines] = useState(null);      // its lines, once fetched
  const [working, setWorking] = useState(false);

  const COLS = '*, parties(id, name, phone, gstin, address, state_name, '
             + 'state_code, opening_date)';

  // "SEND ME LAST TUESDAY'S BILL AGAIN" IS SOMETIMES A BILL FROM MARCH.
  //
  // This screen fetched the 400 most recent bills and searched inside them,
  // here on the phone. A shop writing 40 bills a day passes 400 in a
  // fortnight, so everything older than that simply could not be found — the
  // box came back "Nothing matches that" for a bill that is sitting in the
  // books, which is the one answer a search must never give.
  //
  // The recent list still comes down whole, because that is what the screen
  // opens on. The moment something is TYPED the question goes to the server,
  // where all the bills are.
  const load = useCallback(async () => {
    setBusy(true);
    const { data, error } = await supabase
      .from('vouchers').select(COLS)
      .order('vdate', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(400);
    if (error) Alert.alert('Could not load your bills', sayPlainly(error));
    setRows(data || []);
    setBusy(false);
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  // A % or an _ is a letter in a name and a wildcard in a query. Escaped,
  // they match themselves, which is what he meant by typing them.
  const forIlike = (t) => String(t).replace(/[\\%_]/g, (c) => `\\${c}`);

  const [hits, setHits] = useState(null);     // null = not searching
  const [looking, setLooking] = useState(false);
  const seek = useRef(null);
  const seq  = useRef(0);

  useEffect(() => {
    const t = q.trim();
    if (seek.current) clearTimeout(seek.current);
    if (t.length < 2) { setHits(null); setLooking(false); return; }
    setLooking(true);
    seek.current = setTimeout(async () => {
      const mine = ++seq.current;
      const like = `%${forIlike(t)}%`;
      // Asked as separate questions rather than one .or() string: the search
      // text would otherwise go into the middle of a comma-separated filter,
      // and a name with a comma in it breaks the whole query.
      const ask = (col) => supabase.from('vouchers').select(COLS)
        .ilike(col, like)
        .order('vdate', { ascending: false })
        .order('created_at', { ascending: false })
        .limit(200);
      try {
        const [a, b] = await Promise.all([ask('voucher_no'), ask('printed_name')]);
        if (mine !== seq.current) return;          // he has typed since
        const seen = new Set();
        const all = [...(a.data || []), ...(b.data || [])]
          .filter((v) => (seen.has(v.id) ? false : seen.add(v.id)))
          .sort((x, y) => String(y.vdate).localeCompare(String(x.vdate)));
        setHits(all);
      } catch (e) {
        if (mine === seq.current) setHits([]);
      } finally {
        if (mine === seq.current) setLooking(false);
      }
    }, 300);
    return () => { if (seek.current) clearTimeout(seek.current); };
  }, [q]);

  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    // What came back from the server when he is searching, and what is
    // already on the phone when he is not. Either way the rows on the phone
    // are also matched, so a customer NAME — which lives on the party row and
    // not on the bill — still finds its bills without a second question.
    const seen = new Set();
    const pool = s
      ? [...(hits || []), ...rows]
          .filter((v) => (seen.has(v.id) ? false : seen.add(v.id)))
          // the two lists are each in date order but not in one order, and
          // the day headings below read down a single sorted list
          .sort((x, y) => String(y.vdate).localeCompare(String(x.vdate))
                       || String(y.created_at).localeCompare(String(x.created_at)))
      : rows;
    return pool.filter((v) => {
      if (kind === 'returns') {
        if (v.vtype !== 'sale_return' && v.vtype !== 'purchase_return') return false;
      } else if (kind !== 'all' && v.vtype !== kind) return false;
      if (!s) return true;
      // Both names: the party may have been renamed since the bill was
      // printed, and the bill keeps the name it went out under.
      const names = `${v.parties?.name || ''} ${v.printed_name || ''}`.toLowerCase();
      return names.includes(s)
          || String(v.voucher_no || '').toLowerCase().includes(s)
          || String(Math.round(Number(v.total) || 0)).includes(s);
    });
  }, [rows, hits, q, kind]);

  // WHAT "SALES SHOWN" ACTUALLY MEANT.
  //
  // This added up everything on screen except purchases — so a 5,000 credit
  // note ADDED 5,000 to the day's sales, and a bill he had cancelled, drawn
  // struck through two inches below, still counted in full. The heading said
  // SALES SHOWN. It does now: cancelled bills are out, and a return comes off
  // instead of going on.
  const dayTotal = useMemo(
    () => shown.reduce((sum, v) => {
      if (v.cancelled_at) return sum;
      const amt = Number(v.total) || 0;
      if (v.vtype === 'purchase' || v.vtype === 'purchase_return') return sum;
      if (v.vtype === 'sale_return') return sum - amt;
      return sum + amt;
    }, 0),
    [shown]);

  /* ---------------- one bill ---------------- */

  const openBill = async (v) => {
    setOpen(v); setLines(null);
    const { data } = await supabase.from('voucher_lines')
      .select('*').eq('voucher_id', v.id).order('line_no');
    setLines(data || []);
  };

  const html = () => {
    const args = {
      org,
      voucher: { ...open, place_of_supply_name: open.parties?.state_name || org?.state_name || '' },
      party: open.parties,
      lines: lines || [],
    };
    const paper = String(org?.print_width || 'a4');
    return paper === 'a4' ? invoiceHtml(args) : thermalHtml({ ...args, width: paper });
  };

  const resend = async () => {
    if (!lines) return;
    setWorking(true);
    try {
      const { uri } = await Print.printToFileAsync({ html: html() });
      await sharePdf(uri, pdfName({
        who: open?.parties?.name || open?.printed_name || org?.name,
        no: open?.voucher_no,
        fallback: org?.name || 'Bill',
      }), 'Send again');
    } catch (e) {
      Alert.alert('Could not send', sayPlainly(e));
    } finally { setWorking(false); }
  };

  const reprint = async () => {
    if (!lines) return;
    try { await Print.printAsync({ html: html() }); }
    catch (e) { Alert.alert('Could not print', sayPlainly(e)); }
  };

  const edit = () => {
    const v = open;
    setOpen(null); setLines(null);
    navigation.navigate('Bill', { voucherId: v.id, vtype: v.vtype });
  };

  // Removing a bill is not undoable, so it is asked twice and says plainly
  // what else goes with it.
  const remove = () => {
    const v = open;
    const name = v.parties?.name || v.printed_name || 'this customer';
    Alert.alert(
      `Remove ${v.voucher_no ? `bill ${v.voucher_no}` : 'this bill'}?`,
      `₹${fmt0(v.total)} to ${name}.\n\nThe stock it moved goes back, and any cash `
      + `recorded against it is removed too.\n\nThe bill itself stays in your book, `
      + `marked cancelled, and keeps its number. GST wants an unbroken run of `
      + `numbers, and a bill that simply disappears leaves a hole in it.`,
      [
        { text: 'Keep it' },
        { text: 'Remove', style: 'destructive', onPress: async () => {
            setWorking(true);
            const { error } = await supabase.rpc('delete_voucher',
              { p_id: v.id, p_reason: null });
            setWorking(false);
            if (error) return Alert.alert('Could not remove it', sayPlainly(error));
            setOpen(null); setLines(null); load();
          } },
      ]);
  };

  /* ---------------- screen ---------------- */

  return (
    <Screen>
      <Bar>
        <BackButton navigation={navigation} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={S.barName}>Bills</Text>
          <Text style={S.barSub}>{shown.length} shown</Text>
        </View>
        <View style={{ alignItems: 'flex-end' }}>
          <Text style={S.barTotL}>SALES SHOWN</Text>
          <Text style={[S.barTot, S.num]}>₹{fmt0(dayTotal)}</Text>
        </View>
        <MoreButton navigation={navigation} />
      </Bar>

      <View style={{ backgroundColor: C.surface, paddingHorizontal: 12, paddingVertical: 8,
                     borderBottomWidth: 1, borderBottomColor: C.line }}>
        <TextInput style={S.input} placeholder="Name, bill number, or amount"
          placeholderTextColor={C.faint} value={q} onChangeText={setQ}
          returnKeyType="search" />
        <View style={[S.row, { marginTop: 8, gap: 6 }]}>
          {KINDS.map((k) => {
            const on = kind === k.key;
            return (
              <TouchableOpacity key={k.key} onPress={() => setKind(k.key)}
                style={{ flex: 1, paddingVertical: 7, borderRadius: 9, alignItems: 'center',
                         borderWidth: 1, borderColor: on ? C.accent : C.line,
                         backgroundColor: on ? C.accentSoft : C.surface }}>
                <Text style={{ fontSize: 12.5, fontWeight: '600', color: on ? C.accent : C.muted }}>
                  {k.label}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>
      </View>

      {/* Swipe sideways to move between All, Bills, Purchases and Returns. */}
      <Swipe {...swipe}>
      {busy ? (
        <View style={{ paddingTop: 60, alignItems: 'center' }}>
          <ActivityIndicator color={C.accent} />
        </View>
      ) : (
        <FlatList
          data={shown}
          keyExtractor={(v) => v.id}
          contentContainerStyle={{ padding: 12, paddingBottom: 30 }}
          ListEmptyComponent={
            <Text style={{ color: C.muted, fontWeight: '600', textAlign: 'center', marginTop: 40,
                           lineHeight: 20 }}>
              {looking
                ? 'Looking…'
                : q || kind !== 'all'
                ? 'Nothing matches that.'
                : 'No bills yet. Every bill you save will be here, and you can\nsend it again from here any time.'}
            </Text>}
          renderItem={({ item: v, index }) => {
            const prev = shown[index - 1];
            const newDay = !prev || prev.vdate !== v.vdate;
            const who = v.parties?.name || v.printed_name || 'CASH';
            const buy = v.vtype === 'purchase' || v.vtype === 'sale_return'
             || v.vtype === 'purchase_return';
            return (
              <>
                {newDay && (
                  <Text style={[S.eyebrow, { marginTop: index ? 14 : 0, marginBottom: 6 }]}>
                    {dayLabel(v.vdate)}
                  </Text>
                )}
                <TouchableOpacity onPress={() => openBill(v)} style={[S.line, { marginBottom: 8 }]}>
                  <View style={[S.row, { alignItems: 'flex-start' }]}>
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text numberOfLines={1} style={S.lineNm}>{who}</Text>
                      <Text style={{ fontSize: 11.5, color: C.muted, marginTop: 3 }}>
                        {v.voucher_no ? `${v.voucher_no} · ` : ''}
                        {/* HIS NUMBER IS NOT THE ONE HE LOOKS FOR ON A PURCHASE.
                            Skwik's own number means nothing on somebody else's
                            bill — what he is holding in his hand, and what the
                            supplier will quote back at him, is the number
                            printed on their bill. */}
                        {v.vtype === 'purchase' && v.supplier_invoice_no
                          ? `their bill ${v.supplier_invoice_no} · ` : ''}
                        {v.vtype === 'purchase' ? 'Purchase'
                          : v.vtype === 'estimate' ? 'Estimate'
                          : v.vtype === 'sale_return' ? `Credit note${v.ref_invoice_no ? ` on ${v.ref_invoice_no}` : ''}`
                          : v.vtype === 'purchase_return' ? `Debit note${v.ref_invoice_no ? ` on ${v.ref_invoice_no}` : ''}`
                          : 'Bill'}
                        {v.is_cash ? ' · Cash' : ''}
                      </Text>
                      {!!v.cancelled_at && (
                        <Text style={{ fontSize: 11, fontWeight: '800', letterSpacing: 0.6,
                                       color: C.danger, marginTop: 3 }}>
                          CANCELLED
                        </Text>
                      )}
                    </View>
                    <Text style={[S.amt, S.num,
                                  { color: v.cancelled_at ? C.faint : (buy ? C.muted : C.ink) },
                                  !!v.cancelled_at && { textDecorationLine: 'line-through' }]}>
                      ₹{fmt0(v.total)}
                    </Text>
                  </View>
                </TouchableOpacity>
              </>
            );
          }} />
      )}
      </Swipe>

      {/* ---------- one bill, and what can be done with it ---------- */}
      <Modal visible={!!open} transparent animationType="slide"
             onRequestClose={() => { setOpen(null); setLines(null); }}>
        <View style={{ flex: 1, backgroundColor: '#3B3A35DD', justifyContent: 'flex-end' }}>
          <View style={{ backgroundColor: C.bg, borderTopLeftRadius: 22, borderTopRightRadius: 22,
                         padding: 20, paddingBottom: 28 }}>
            {!!open && (
              <>
                <Text style={{ fontSize: 12, color: C.muted, letterSpacing: 1 }}>
                  {(open.vtype === 'purchase' ? 'PURCHASE'
                    : open.vtype === 'estimate' ? 'ESTIMATE'
                    : open.vtype === 'sale_return' ? 'CREDIT NOTE'
                    : open.vtype === 'purchase_return' ? 'DEBIT NOTE' : 'BILL')}
                  {open.voucher_no ? ` ${open.voucher_no}` : ''} · {dmy(open.vdate)}
                </Text>
                <Text numberOfLines={1} style={{ fontSize: 20, fontWeight: '700', color: C.ink,
                                                 marginTop: 4 }}>
                  {open.parties?.name || open.printed_name || 'CASH'}
                </Text>
                <Text style={[{ fontSize: 30, fontWeight: '700', color: C.ink, marginTop: 6 }, S.num]}>
                  ₹{fmt0(open.total)}
                </Text>

                <View style={{ marginTop: 14, marginBottom: 16, borderTopWidth: 1,
                               borderTopColor: C.line, paddingTop: 12 }}>
                  {lines === null ? (
                    <ActivityIndicator color={C.accent} />
                  ) : lines.length === 0 ? (
                    <Text style={{ color: C.muted }}>No lines on this bill.</Text>
                  ) : lines.map((l) => (
                    <View key={l.id} style={[S.row, { marginBottom: 5 }]}>
                      <Text numberOfLines={1} style={{ flex: 1, fontSize: 13.5, color: C.ink }}>
                        {l.item_name}
                      </Text>
                      <Text style={[{ fontSize: 12.5, color: C.muted, marginRight: 10 }, S.num]}>
                        {Number(l.qty)} {uqcShort(l.unit)} × {fmt0(l.rate)}
                      </Text>
                      <Text style={[{ fontSize: 13.5, fontWeight: '700', color: C.ink }, S.num]}>
                        {fmt0(l.amount)}
                      </Text>
                    </View>
                  ))}
                </View>

                <TouchableOpacity style={[S.btn, { backgroundColor: C.wa },
                                          (working || !lines) && { opacity: 0.5 }]}
                  onPress={resend} disabled={working || !lines}>
                  <Text style={S.btnText}>{working ? 'One moment…' : 'Send again on WhatsApp'}</Text>
                </TouchableOpacity>

                <View style={[S.row, { marginTop: 10, gap: 10 }]}>
                  <TouchableOpacity style={[S.btnGhost, { flex: 1, paddingVertical: 14 }]}
                    onPress={reprint} disabled={!lines}>
                    <Text style={[S.ghostText, { fontSize: 15 }]}>Print</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={[S.btnGhost, { flex: 1, paddingVertical: 14 }]}
                    onPress={edit}>
                    <Text style={[S.ghostText, { fontSize: 15 }]}>Change</Text>
                  </TouchableOpacity>
                </View>

                {/* goods coming back — a note against this bill, not an edit of it */}
                {showReturns(org) && (open.vtype === 'sale' || open.vtype === 'purchase') && (
                  <TouchableOpacity style={[S.btnGhost, { marginTop: 10, paddingVertical: 14 }]}
                    onPress={() => {
                      const v = open;
                      setOpen(null); setLines(null);
                      navigation.navigate('Return', { voucherId: v.id });
                    }}>
                    <Text style={[S.ghostText, { fontSize: 15 }]}>
                      {open.vtype === 'purchase' ? 'Send goods back' : 'Goods came back'}
                    </Text>
                  </TouchableOpacity>
                )}

                {isOwner && (
                  <TouchableOpacity onPress={remove} disabled={working}
                    style={{ marginTop: 14, alignItems: 'center', paddingVertical: 10 }}>
                    <Text style={{ fontSize: 14.5, fontWeight: '700', color: C.danger }}>
                      Remove this {open.vtype === 'purchase' ? 'purchase' : 'bill'}
                    </Text>
                  </TouchableOpacity>
                )}

                <TouchableOpacity onPress={() => { setOpen(null); setLines(null); }}
                  style={{ marginTop: 4, alignItems: 'center', paddingVertical: 10 }}>
                  <Text style={{ fontSize: 16, fontWeight: '600', color: C.muted }}>Close</Text>
                </TouchableOpacity>
              </>
            )}
          </View>
        </View>
      </Modal>
    </Screen>
  );
}
