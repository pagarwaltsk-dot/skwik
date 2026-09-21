import React, { useEffect, useMemo, useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, ScrollView, Alert, ActivityIndicator, Platform, Modal,
} from 'react-native';
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';

import { supabase } from '../lib/supabase';
import { useApp } from '../AppContext';
import { computeBill, fmt, fmt0, num, settle, today, supplyOf } from '../lib/money';
import { uqcShort } from '../lib/uqc';
import { invoiceHtml } from '../lib/invoice';
import { thermalHtml } from '../lib/receipt';
import { uuid, sayPlainly } from '../lib/offline';
import { pdfName, sharePdf } from '../lib/pdf';
import { BackButton, Bar, Foot, MoreButton, Screen } from '../components/Chrome';
import { C, S } from '../theme';

// GOODS COMING BACK.
//
// Under GST a return is not a smaller bill — it is its own document. The
// customer keeps the original invoice, and you give him a credit note that
// says how much of it is cancelled. His account, your stock and your GST all
// move by that amount and no more.
//
// So this is always raised FROM a bill. You cannot return what was never
// sold, and the note has to name the invoice it cancels, because that is what
// the return goes into GSTR-1 as.

// Which line is this? An item can sit on a bill twice — two batches, or the
// same goods sold at two different rates — and the two are not the same line.
// What was returned against one must not come off the other.
const lineKey = (l) => `${l.item_id || l.item_name || ''}|${Number(l.rate || 0).toFixed(2)}`;

// SECTION 34(2). A credit note against a bill from an earlier year is only
// good for a return up to the 30th of November following that year. After
// that the note is still a real thing between the shop and the customer —
// the money does go back — but it cannot reduce the tax, so Skwik keeps it
// out of GSTR-1 and says so here rather than letting it be found later.
function pastGstDeadline(billDate, noteDate) {
  if (!billDate) return false;
  const b = new Date(billDate);
  if (Number.isNaN(b.getTime())) return false;
  const fyEndYear = b.getMonth() >= 3 ? b.getFullYear() + 1 : b.getFullYear();
  return new Date(noteDate) > new Date(`${fyEndYear}-11-30T23:59:59`);
}

export default function ReturnScreen({ route, navigation }) {
  const { org } = useApp();
  const voucherId = route.params?.voucherId;

  const [bill, setBill]   = useState(null);
  const [rows, setRows]   = useState([]);     // the original lines, with what is coming back
  const [busy, setBusy]   = useState(false);
  const [loading, setLoading] = useState(true);
  const [isCash, setIsCash] = useState(false);
  const [saved, setSaved] = useState(null);
  const [lateOk, setLateOk] = useState(false);

  const isBuy = bill?.vtype === 'purchase';
  const docName = isBuy ? 'Debit note' : 'Credit note';

  useEffect(() => {
    (async () => {
      const [{ data: v }, { data: ls }] = await Promise.all([
        supabase.from('vouchers').select('*, parties(*)').eq('id', voucherId).maybeSingle(),
        supabase.from('voucher_lines').select('*').eq('voucher_id', voucherId).order('line_no'),
      ]);
      if (!v) { setLoading(false); return Alert.alert('Not found', 'That bill is no longer here.'); }

      // HOW MUCH OF EACH LINE HAS ALREADY COME BACK ON AN EARLIER NOTE?
      //
      // Two things used to go wrong here, and both gave goods away.
      //
      // First, the answer was thrown away if the question failed. A dropped
      // connection came back as "nothing has been returned", and the whole
      // bill could be returned a second time. A question that did not get
      // an answer is now a reason to stop, not a reason to carry on.
      //
      // Second, it counted by item NAME. A bill with the same item on two
      // lines — two batches, or the same goods at two rates — had the two
      // lines added together, so returning one emptied both. The count is
      // now kept per line, by what the line is and what it cost.
      const { data: earlier, error: eErr } = await supabase.from('vouchers')
        .select('id').eq('ref_voucher_id', voucherId).is('cancelled_at', null);
      if (eErr) {
        setLoading(false);
        return Alert.alert('Could not check',
          'Skwik could not find out what has already been returned against this '
          + 'bill, so it will not let you raise a note you might be raising twice. '
          + 'Try again when you have signal.');
      }

      const taken = {};
      if (earlier?.length) {
        const { data: tl, error: lErr } = await supabase.from('voucher_lines')
          .select('item_id, item_name, rate, qty, voucher_id')
          .in('voucher_id', earlier.map((e) => e.id));
        if (lErr) {
          setLoading(false);
          return Alert.alert('Could not check',
            'Skwik could not read the earlier notes against this bill. Try again '
            + 'when you have signal.');
        }
        (tl || []).forEach((l) => {
          const k = lineKey(l);
          taken[k] = (taken[k] || 0) + Number(l.qty || 0);
        });
      }

      setBill(v);
      setIsCash(!!v.is_cash);
      setRows((ls || []).map((l) => {
        const k = lineKey(l);
        const already = Math.min(taken[k] || 0, Number(l.qty) || 0);
        taken[k] = (taken[k] || 0) - already;       // spend it, so the next
        return {                                    // line of the same goods
          ...l,                                     // does not claim it again
          sold: Number(l.qty),
          already,
          left: Math.max(0, Number(l.qty) - already),
          back: '',
        };
      }));
      setLoading(false);
    })();
  }, [voucherId]);

  const setBack = (id, v) => setRows((rs) => rs.map((r) => (r.id === id ? { ...r, back: v } : r)));

  // WHAT IS COMING BACK, AT THE PRICE IT WENT OUT AT.
  //
  // The discount on the line used to be dropped here, so the note was worked
  // out from the full rate and refunded more than was ever taken. Ten pieces
  // at 200 with a tenth off were billed at 1,800 plus 324 of tax. Returned in
  // full, the note came to 2,360 — 236 of the shop's money, given away on
  // every discounted return.
  //
  // Half the goods back means half the discount back, so it is shared out in
  // proportion to what is returning.
  const coming = useMemo(() => rows
    .filter((r) => num(r.back) > 0)
    .map((r) => {
      const back = num(r.back);
      const sold = Number(r.sold) || 0;
      const share = sold > 0 ? back / sold : 0;
      return {
        item_id: r.item_id, item_name: r.item_name, hsn: r.hsn, unit: r.unit,
        gst_rate: Number(r.gst_rate) || 0, qty: back, rate: Number(r.rate),
        // A nil-rated packet coming back is still nil-rated. Dropping this
        // put the credit note into the taxable tables and left Table 8 of the
        // return one-sided — sales in it, returns not.
        supply: supplyOf(r),
        disc: Math.round(num(r.disc) * share * 100) / 100,
        note: r.note || null, flag: false, checked: false,
      };
    }), [rows]);

  // No bill-level discount is passed: the shares already sit on the lines,
  // worked out above from what each line actually carried. Reverse charge
  // follows the original bill — a note against a bill that collected no tax
  // must not refund any.
  const calc = useMemo(
    () => computeBill(coming, bill?.tax_mode || 'none',
      { reverseCharge: !!bill?.reverse_charge }),
    [coming, bill?.tax_mode, bill?.reverse_charge]);
  const exact = calc.taxable + calc.cgst + calc.sgst + calc.igst;
  const total = Math.round(exact);

  const tooMuch = rows.find((r) => num(r.back) > r.left);

  const save = async () => {
    if (!coming.length) {
      return Alert.alert('Nothing coming back', 'Type how many of each item are being returned.');
    }
    if (tooMuch) {
      return Alert.alert('More than was sold',
        `Only ${tooMuch.left} ${uqcShort(tooMuch.unit)} of ${tooMuch.item_name} can still come back.`);
    }

    if (!isBuy && pastGstDeadline(bill?.vdate, today()) && !lateOk) {
      return Alert.alert('Too late for the return',
        'This bill is from a year whose 30 November has gone. The note will be '
        + 'raised and the money will move, but it cannot reduce your tax and it '
        + 'will be left out of GSTR-1.',
        [{ text: 'Go back' },
         { text: 'Raise it anyway', onPress: () => { setLateOk(true); } }]);
    }

    setBusy(true);
    try {
      const payload = {
        id: uuid(),
        vtype: isBuy ? 'purchase_return' : 'sale_return',
        vdate: today(),
        party_id: bill.party_id, printed_name: bill.printed_name,
        is_cash: isCash,
        ref_voucher_id: bill.id,
        ref_invoice_no: bill.voucher_no,
        ref_invoice_date: bill.vdate,
        place_of_supply_code: bill.place_of_supply_code,
        tax_mode: bill.tax_mode,
        taxable: calc.taxable, cgst: calc.cgst, sgst: calc.sgst, igst: calc.igst,
        reverse_charge: !!bill?.reverse_charge,
        nil_rated: calc.nil_rated, exempt: calc.exempt, non_gst: calc.non_gst,
        // the share of the bill's discount that is coming back with these
        // goods, so the note reverses exactly what was charged
        discount: calc.discount,
        extra_amount: 0, extra_note: null,
        round_off: Math.round((total - exact) * 100) / 100, total,
        lines: calc.lines.map((l) => ({
          item_id: l.item_id, item_name: l.item_name, hsn: l.hsn, unit: l.unit,
          qty: num(l.qty), rate: num(l.rate), gst_rate: l.gst_rate,
          disc: num(l.disc), supply: l.supply || 'taxable',
          taxable: l.taxable, cgst: l.cgst, sgst: l.sgst, igst: l.igst,
          amount: l.amount, flag: false, checked: false, note: l.note,
        })),
      };

      const { data, error } = await supabase.rpc('save_voucher', { p: payload });
      if (error) throw error;

      setSaved({
        voucher: { ...payload, voucher_no: data.voucher_no,
                   place_of_supply_name: bill.parties?.state_name || org?.state_name },
        party: bill.parties, lines: calc.lines,
      });
    } catch (e) {
      Alert.alert('Could not save', sayPlainly(e));
    } finally { setBusy(false); }
  };

  const html = () => {
    const args = { org, voucher: saved.voucher, party: saved.party, lines: saved.lines };
    const paper = String(org?.print_width || 'a4');
    return paper === 'a4' ? invoiceHtml(args) : thermalHtml({ ...args, width: paper });
  };
  const onShare = async () => {
    const { uri } = await Print.printToFileAsync({ html: html() });
    await sharePdf(uri, pdfName({
      who: bill?.parties?.name || bill?.printed_name || org?.name,
      no: saved?.voucher?.voucher_no,
      what: isBuy ? 'debit_note' : 'credit_note',
      fallback: org?.name || 'Note',
    }));
  };

  if (loading) {
    return (
      <View style={[S.screen, { alignItems: 'center', justifyContent: 'center' }]}>
        <ActivityIndicator color={C.accent} />
      </View>
    );
  }

  return (
    <Screen>
      <Bar>
        <BackButton navigation={navigation} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text numberOfLines={1} style={S.barName}>
            {bill?.parties?.name || bill?.printed_name || 'CASH'}
          </Text>
          <Text style={S.barSub}>
            {docName} against {bill?.voucher_no || 'this bill'}
          </Text>
        </View>
        <View style={{ alignItems: 'flex-end' }}>
          <Text style={S.barTotL}>COMING BACK</Text>
          <Text style={[S.barTot, S.num]}>₹{fmt0(total)}</Text>
        </View>
      </Bar>

      <ScrollView keyboardShouldPersistTaps="handled"
                  contentContainerStyle={{ padding: 14, paddingBottom: 30 }}>

        <Text style={{ fontSize: 13, color: C.muted, marginBottom: 14, lineHeight: 19 }}>
          Type how many of each are coming back. The rest of the bill stands as
          it is — the customer keeps it, and this note says what is cancelled.
        </Text>

        {rows.map((r) => {
          const back = num(r.back);
          const over = back > r.left;
          return (
            <View key={r.id} style={[S.line, over && { borderColor: C.danger }]}>
              <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 8 }}>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text numberOfLines={2} style={S.lineNm}>{r.item_name}</Text>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 6 }}>
                    <Text style={S.unitPill}>{uqcShort(r.unit)}</Text>
                    <Text style={{ fontSize: 11.5, color: C.muted }}>
                      {r.sold} sold at {fmt0(r.rate)}
                      {r.already ? ` · ${r.already} already back` : ''}
                    </Text>
                  </View>
                </View>
                <View style={{ width: 92 }}>
                  <Text style={S.cellLabel}>Coming back</Text>
                  <TextInput
                    style={[S.cell, S.num, { textAlign: 'right' },
                            back > 0 && !over && { borderColor: C.accent, backgroundColor: C.accentSoft },
                            over && { borderColor: C.danger }]}
                    keyboardType="numeric" selectTextOnFocus placeholder="0"
                    placeholderTextColor={C.faint} value={String(r.back)}
                    onBlur={() => setBack(r.id, settle(r.back))}
                    onChangeText={(t) => setBack(r.id, t)} />
                </View>
              </View>

              {over && (
                <Text style={{ fontSize: 12, fontWeight: '600', color: C.danger, marginTop: 8 }}>
                  Only {r.left} can still come back.
                </Text>
              )}
              {!over && back > 0 && (
                <Text style={[{ fontSize: 13, color: C.ink, marginTop: 8, textAlign: 'right' },
                              S.num]}>
                  {back} × {fmt0(r.rate)} = <Text style={{ fontWeight: '700' }}>
                    ₹{fmt0(back * Number(r.rate))}</Text>
                </Text>
              )}
            </View>
          );
        })}

        {!!coming.length && (
          <View style={S.card}>
            <Text style={S.eyebrow}>Totals</Text>
            <View style={S.tline}>
              <Text style={S.tlineK}>Goods</Text>
              <Text style={[S.tlineV, S.num]}>{fmt(calc.taxable)}</Text>
            </View>
            {bill?.tax_mode === 'cgst_sgst' && (
              <>
                <View style={S.tline}>
                  <Text style={S.tlineK}>CGST</Text>
                  <Text style={[S.tlineV, S.num]}>{fmt(calc.cgst)}</Text>
                </View>
                <View style={S.tline}>
                  <Text style={S.tlineK}>SGST</Text>
                  <Text style={[S.tlineV, S.num]}>{fmt(calc.sgst)}</Text>
                </View>
              </>
            )}
            {bill?.tax_mode === 'igst' && (
              <View style={S.tline}>
                <Text style={S.tlineK}>IGST</Text>
                <Text style={[S.tlineV, S.num]}>{fmt(calc.igst)}</Text>
              </View>
            )}
            <View style={[S.tline, { borderTopWidth: 2, borderTopColor: C.ink,
                                     marginTop: 8, paddingTop: 10 }]}>
              <Text style={{ fontSize: 20, fontWeight: '700', color: C.ink }}>Total</Text>
              <Text style={[{ fontSize: 20, fontWeight: '700', color: C.ink }, S.num]}>
                ₹{fmt0(total)}
              </Text>
            </View>

            <TouchableOpacity onPress={() => setIsCash(!isCash)}
              style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 16 }}>
              <View style={{ width: 22, height: 22, borderRadius: 7, borderWidth: 1.5,
                             alignItems: 'center', justifyContent: 'center',
                             borderColor: isCash ? C.accent : C.greyB,
                             backgroundColor: isCash ? C.accent : 'transparent' }}>
                <Text style={{ color: '#fff', fontSize: 14, fontWeight: '700' }}>
                  {isCash ? '✓' : ''}
                </Text>
              </View>
              <Text style={{ flex: 1, fontSize: 14.5, color: C.ink }}>
                {isBuy ? 'They gave the money back in cash'
                       : 'I gave the money back in cash'}
              </Text>
            </TouchableOpacity>
            <Text style={S.hint}>
              {isCash
                ? 'The refund is recorded against their account as well.'
                : 'Nothing moves in cash — their account simply comes down by this much.'}
            </Text>
          </View>
        )}

        <View style={{ height: 30 }} />
      </ScrollView>

      <Foot>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={S.footL}>{docName.toUpperCase()}</Text>
          <Text style={[S.footTot, S.num]}>₹{fmt0(total)}</Text>
        </View>
        <TouchableOpacity onPress={save} disabled={busy || !coming.length || !!tooMuch}
          style={[S.btn, (busy || !coming.length || !!tooMuch) && { backgroundColor: C.faint }]}>
          <Text style={S.btnText}>{busy ? 'Saving…' : `Save ${docName.toLowerCase()}`}</Text>
        </TouchableOpacity>
      </Foot>

      <Modal visible={!!saved} transparent animationType="slide">
        <View style={{ flex: 1, backgroundColor: '#3B3A35EE', justifyContent: 'flex-end' }}>
          <View style={{ backgroundColor: '#fff', borderTopLeftRadius: 16,
                         borderTopRightRadius: 16, padding: 20, paddingBottom: 28 }}>
            <Text style={{ fontSize: 13, color: C.muted, letterSpacing: 1 }}>
              {docName.toUpperCase()} {saved?.voucher?.voucher_no || ''}
            </Text>
            <Text style={[{ fontSize: 30, fontWeight: '700', color: C.ink, marginTop: 6,
                            marginBottom: 6 }, S.num]}>
              ₹{fmt0(saved?.voucher?.total || 0)}
            </Text>
            <Text style={{ fontSize: 13, color: C.muted, marginBottom: 16 }}>
              Against bill {bill?.voucher_no}. Their account and your stock have both moved.
            </Text>
            <TouchableOpacity style={[S.btn, { backgroundColor: C.wa }]} onPress={onShare}>
              <Text style={S.btnText}>Send it on WhatsApp</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[S.btnGhost, { marginTop: 10, paddingVertical: 14 }]}
              onPress={() => Print.printAsync({ html: html() })}>
              <Text style={[S.ghostText, { fontSize: 16 }]}>Print</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => { setSaved(null); navigation.navigate('Home'); }}
              style={{ marginTop: 16, alignItems: 'center', paddingVertical: 10 }}>
              <Text style={{ fontSize: 16, fontWeight: '600', color: C.muted }}>Done</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </Screen>
  );
}
