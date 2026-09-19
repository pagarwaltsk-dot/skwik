import React, { useCallback, useMemo, useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, FlatList, Modal, Alert, ActivityIndicator,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';

import { supabase } from '../lib/supabase';
import { useApp } from '../AppContext';
import { fmt0 } from '../lib/money';
import { invoiceHtml } from '../lib/invoice';
import { thermalHtml } from '../lib/receipt';
import { C, S } from '../theme';

// EVERY BILL EVER WRITTEN. Find one, read it, send it again, fix it, remove it.
//
// A shopkeeper is asked "send me last Tuesday's bill again" every week, and
// until now Skwik had no answer to that. This is the answer.

const KINDS = [
  { key: 'all',      label: 'All'        },
  { key: 'sale',     label: 'Bills'      },
  { key: 'estimate', label: 'Estimates'  },
  { key: 'purchase', label: 'Purchases'  },
];

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
  const { org } = useApp();
  const [rows, setRows]   = useState([]);
  const [busy, setBusy]   = useState(true);
  const [q, setQ]         = useState('');
  const [kind, setKind]   = useState('all');
  const [open, setOpen]   = useState(null);      // the bill tapped on
  const [lines, setLines] = useState(null);      // its lines, once fetched
  const [working, setWorking] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    const { data, error } = await supabase
      .from('vouchers')
      .select('*, parties(id, name, phone, gstin, address, state_name, state_code, opening_date)')
      .order('vdate', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(400);
    if (error) Alert.alert('Could not load your bills', error.message);
    setRows(data || []);
    setBusy(false);
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    return rows.filter((v) => {
      if (kind !== 'all' && v.vtype !== kind) return false;
      if (!s) return true;
      const who = v.parties?.name || v.printed_name || '';
      return who.toLowerCase().includes(s)
          || String(v.voucher_no || '').toLowerCase().includes(s)
          || String(Math.round(Number(v.total) || 0)).includes(s);
    });
  }, [rows, q, kind]);

  const dayTotal = useMemo(
    () => shown.reduce((sum, v) => sum + (v.vtype === 'purchase' ? 0 : Number(v.total) || 0), 0),
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
      await Sharing.shareAsync(uri, { mimeType: 'application/pdf', dialogTitle: 'Send again' });
    } catch (e) {
      Alert.alert('Could not send', e.message || String(e));
    } finally { setWorking(false); }
  };

  const reprint = async () => {
    if (!lines) return;
    try { await Print.printAsync({ html: html() }); }
    catch (e) { Alert.alert('Could not print', e.message || String(e)); }
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
      + `recorded against it is removed too. The bill number is not used again.`,
      [
        { text: 'Keep it' },
        { text: 'Remove', style: 'destructive', onPress: async () => {
            setWorking(true);
            const { error } = await supabase.rpc('delete_voucher', { p_id: v.id });
            setWorking(false);
            if (error) return Alert.alert('Could not remove it', error.message);
            setOpen(null); setLines(null); load();
          } },
      ]);
  };

  /* ---------------- screen ---------------- */

  return (
    <View style={S.screen}>
      <View style={[S.bar, { paddingTop: 46 }]}>
        <TouchableOpacity onPress={() => navigation.goBack()} accessibilityLabel="Back"
          hitSlop={{ top: 14, bottom: 14, left: 14, right: 14 }}
          style={{ paddingVertical: 8, paddingRight: 10, paddingLeft: 2 }}>
          <Text style={{ fontSize: 26, color: '#fff', opacity: 0.85 }}>‹</Text>
        </TouchableOpacity>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={S.barName}>Bills</Text>
          <Text style={S.barSub}>{shown.length} shown</Text>
        </View>
        <View style={{ alignItems: 'flex-end' }}>
          <Text style={S.barTotL}>SALES SHOWN</Text>
          <Text style={[S.barTot, S.num]}>₹{fmt0(dayTotal)}</Text>
        </View>
      </View>

      <View style={{ backgroundColor: C.surface, paddingHorizontal: 12, paddingVertical: 8,
                     borderBottomWidth: 1, borderBottomColor: C.line }}>
        <TextInput style={S.input} placeholder="Name, bill number, or amount"
          placeholderTextColor={C.faint} value={q} onChangeText={setQ} />
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
              {q || kind !== 'all'
                ? 'Nothing matches that.'
                : 'No bills yet. Every bill you save will be here, and you can\nsend it again from here any time.'}
            </Text>}
          renderItem={({ item: v, index }) => {
            const prev = shown[index - 1];
            const newDay = !prev || prev.vdate !== v.vdate;
            const who = v.parties?.name || v.printed_name || 'CASH';
            const buy = v.vtype === 'purchase';
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
                        {buy ? 'Purchase' : v.vtype === 'estimate' ? 'Estimate' : 'Bill'}
                        {v.is_cash ? ' · Cash' : ''}
                      </Text>
                    </View>
                    <Text style={[S.amt, S.num, { color: buy ? C.muted : C.ink }]}>
                      ₹{fmt0(v.total)}
                    </Text>
                  </View>
                </TouchableOpacity>
              </>
            );
          }} />
      )}

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
                    : open.vtype === 'estimate' ? 'ESTIMATE' : 'BILL')}
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
                        {Number(l.qty)} × {fmt0(l.rate)}
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

                <TouchableOpacity onPress={remove} disabled={working}
                  style={{ marginTop: 14, alignItems: 'center', paddingVertical: 10 }}>
                  <Text style={{ fontSize: 14.5, fontWeight: '700', color: C.danger }}>
                    Remove this {open.vtype === 'purchase' ? 'purchase' : 'bill'}
                  </Text>
                </TouchableOpacity>

                <TouchableOpacity onPress={() => { setOpen(null); setLines(null); }}
                  style={{ marginTop: 4, alignItems: 'center', paddingVertical: 10 }}>
                  <Text style={{ fontSize: 16, fontWeight: '600', color: C.muted }}>Close</Text>
                </TouchableOpacity>
              </>
            )}
          </View>
        </View>
      </Modal>
    </View>
  );
}
