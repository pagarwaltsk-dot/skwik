import React, { useCallback, useRef, useState } from 'react';
import { View, Text, TouchableOpacity, ScrollView, Alert, Modal } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';

import { supabase } from '../lib/supabase';
import { sayPlainly } from '../lib/offline';
import { useApp } from '../AppContext';
import { fmt0, n2, today } from '../lib/money';
import { invoiceHtml, ledgerHtml } from '../lib/invoice';
import { thermalHtml } from '../lib/receipt';
import { Head, Screen } from '../components/Chrome';
import { C, S } from '../theme';
import { pdfName, sharePdf } from '../lib/pdf';

const p2 = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;

const PERIODS = [
  { k: 'month', label: 'This month',   sub: 'from the 1st to today',       file: 'this-month' },
  { k: 'last',  label: 'Last month',   sub: 'the whole of it',             file: 'last-month' },
  { k: 'three', label: 'Last 3 months', sub: 'the usual reminder',         file: '3-months' },
  { k: 'fy',    label: 'This year',    sub: 'since 1 April',               file: 'this-year' },
  { k: 'all',   label: 'Everything',   sub: 'the account from the start',  file: 'account' },
];

function spanOf(k) {
  const now = new Date();
  const to = ymd(now);
  if (k === 'month') return [ymd(new Date(now.getFullYear(), now.getMonth(), 1)), to];
  if (k === 'last') {
    const a = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const b = new Date(now.getFullYear(), now.getMonth(), 0);
    return [ymd(a), ymd(b)];
  }
  if (k === 'three') return [ymd(new Date(now.getFullYear(), now.getMonth() - 2, 1)), to];
  if (k === 'fy') {
    const y = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
    return [`${y}-04-01`, to];
  }
  return [null, null];
}

export default function LedgerScreen({ route, navigation }) {
  const partyId = route.params?.partyId;
  const { org, isOwner } = useApp();
  const [party, setParty] = useState(null);
  const [data, setData]   = useState({ rows: [], opening: 0, opening_type: 'owes_you' });
  // An account that could not be fetched must never be drawn as zero. A
  // shopkeeper standing at the counter reading "owes you ₹0" acts on it.
  const [failed, setFailed] = useState(false);
  const [making, setMaking] = useState(null);   // which bill's PDF is being built
  const [busy, setBusy] = useState(false);
  // HOW MANY OF EACH COLUMN ARE DRAWN.
  //
  // Five to begin with — the newest five, which is what he came to look at —
  // and each tap of Load more brings the window to fifteen and then fifteen
  // further back each time. Counted per column, so a customer with forty bills
  // against him and two receipts still shows both receipts.
  const FIRST = 5, STEP = 15;
  const [showL, setShowL] = useState(FIRST);
  const [showR, setShowR] = useState(FIRST);
  const [period, setPeriod] = useState(false);   // the "which months?" sheet
  // Back to five whenever a different account is opened.
  const seenParty = useRef(partyId);
  if (seenParty.current !== partyId) {
    seenParty.current = partyId;
    if (showL !== FIRST) setShowL(FIRST);
    if (showR !== FIRST) setShowR(FIRST);
  }

  const load = useCallback(async () => {
    try {
      const [{ data: p, error: pe }, { data: led, error: le }] = await Promise.all([
        supabase.from('parties').select('*').eq('id', partyId).maybeSingle(),
        supabase.rpc('party_ledger', { p_party: partyId }),
      ]);
      if (pe || le || !led) { setFailed(true); return; }
      setParty(p);
      setData(led);
      setFailed(false);
    } catch (e) { setFailed(true); }
  }, [partyId]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const rows = data.rows || [];
  const open = Number(data.opening || 0);

  // A LEDGER READS DOWNWARDS, OLDEST FIRST.
  //
  // It was the other way round — newest at the top — and that was my doing,
  // on his instruction, and he has since said it reads wrong. He is right: an
  // account with the opening at the bottom and April under September is not a
  // ledger, it is a list. Every book he has ever kept runs down the page in
  // the order things happened, and the balance at the foot is the answer.
  //
  // So it runs oldest to newest, the opening sits at the HEAD of its column
  // where it belongs, and the page is kept short a different way: only the
  // newest few entries of each column are drawn, with the older ones a tap
  // away. The two columns are counted apart, because a customer with forty
  // bills and two payments should still show both payments.
  const byOldest = (a, b) => String(a.d || '').localeCompare(String(b.d || ''));
  const left  = rows.filter((r) => r.side === 'left').sort(byOldest);
  const right = rows.filter((r) => r.side === 'right').sort(byOldest);
  // A NEGATIVE OPENING IS STILL AN OPENING.
  //
  // The direction lives in opening_type, and the amount should be a plain
  // number — but nothing stopped a shopkeeper typing "-500" into the box, and
  // this line then dropped it out of the ledger altogether while the udhar
  // list went on counting it. The two screens disagreed about the same
  // customer. A minus is read as the other direction, which is what he meant.
  if (open !== 0) {
    const theyOwe = open < 0 ? data.opening_type === 'you_owe'
                             : data.opening_type !== 'you_owe';
    (theyOwe ? left : right)
      .unshift({ d: party?.opening_date || '', label: 'Opening', amt: Math.abs(open) });
  }

  const sum = (a) => a.reduce((s, r) => s + Number(r.amt || 0), 0);
  const balance = n2(sum(left) - sum(right));
  const owes = balance >= 0;

  // Close a balance that is never going to be paid, or was rounded away at
  // the counter. It is a payment whose mode is neither cash nor bank, so the
  // cash book and the balance sheet both step over it by name.
  const askWriteOff = () => {
    const amt = n2(balance);
    Alert.alert(
      `Write off ₹${fmt0(Math.abs(amt))}?`,
      `${party?.name || 'This account'} will stand at nil.\n\n`
      + (amt > 0
          ? 'This is money you are giving up. It does not go in the cash book, '
            + 'because no cash came in — it shows in your profit and loss as '
            + 'money written off.'
          : 'This is money you owed and are not paying. It does not go in the '
            + 'cash book, because nothing left the cash box.'),
      [{ text: 'Leave it' },
       { text: 'Write it off', style: 'destructive', onPress: async () => {
           setBusy(true);
           const { error } = await supabase.rpc('write_off', {
             p_party: partyId, p_amount: amt, p_date: today(), p_note: 'Written off',
           });
           setBusy(false);
           if (error) return Alert.alert('Could not write it off', sayPlainly(error));
           load();
         } }]);
  };

  // WHICH MONTHS ARE ON THE STATEMENT.
  //
  // It sent the whole account, every time, back to the first entry. For a
  // customer of three years that is a document nobody reads, and it is not
  // what he is usually asking for — he wants "what you bought this month and
  // what you paid". So the period is asked before the PDF is made.
  //
  // A statement of part of an account is only honest if it opens with what was
  // carried into it, so everything before the period is added up and printed
  // as the opening figure. The closing balance is then the same number as the
  // box at the top of this screen, which is the one thing he will check.
  const periodRows = (from, to) => {
    const inIt = (d) => (!from || String(d || '') >= from) && (!to || String(d || '') <= to);
    // the account as it stood the day before the period began
    const signed = (() => {
      if (open === 0) return 0;
      const theyOwe = open < 0 ? data.opening_type === 'you_owe'
                               : data.opening_type !== 'you_owe';
      return theyOwe ? Math.abs(open) : -Math.abs(open);
    })();
    let carried = signed;
    rows.forEach((r) => {
      if (inIt(r.d)) return;
      if (from && String(r.d || '') >= from) return;      // after the period, not before it
      carried += (r.side === 'left' ? 1 : -1) * Number(r.amt || 0);
    });
    // AND THE CLOSING FIGURE IS THE PERIOD'S OWN.
    //
    // This very nearly went out printing TODAY'S balance at the foot of a
    // statement of last month — an opening from before the month, the month's
    // own entries, and then a closing figure that does not follow from either
    // of them. A customer checking the arithmetic would find it wrong, and he
    // would be right. So the closing is worked out from the same rows that are
    // on the page.
    const inPeriod = rows.filter((r) => inIt(r.d));
    const shut = inPeriod.reduce(
      (a, r) => a + (r.side === 'left' ? 1 : -1) * Number(r.amt || 0), carried);
    return {
      rows: inPeriod,
      opening: Math.abs(n2(carried)),
      openingType: carried >= 0 ? 'owes_you' : 'you_owe',
      closing: n2(shut),
    };
  };

  const sendFor = async (from, to, label) => {
    try {
      const cut = periodRows(from, to);
      const html = ledgerHtml({ org, party,
        rows: cut.rows, opening: cut.opening,
        openingType: cut.openingType, balance: cut.closing });
      const { uri } = await Print.printToFileAsync({ html });
      if (!(await Sharing.isAvailableAsync())) {
        return Alert.alert('Nothing to share with',
          'This phone has no app set up to receive the file.');
      }
      await sharePdf(uri, pdfName({ who: party?.name, what: label || 'account',
                                    fallback: org?.name || 'Account' }), 'Send account');
    } catch (e) {
      Alert.alert('Could not send', sayPlainly(e));
    } finally { setPeriod(false); }
  };

  const share = () => {
    if (!party) {
      return Alert.alert('Not loaded yet', 'This account has not come down from the '
        + 'server yet. Check your internet and open it again.');
    }
    setPeriod(true);
  };

  // EVERY LINE GOES SOMEWHERE.
  //
  // A ledger that only shows numbers leaves the question "which bill was
  // that?" unanswered, and answering it meant going to Past bills and hunting
  // by date. Each entry now opens the thing it came from.
  const openRow = (r) => {
    if (r.kind === 'voucher' && r.id) {
      if (r.vtype === 'sale_return' || r.vtype === 'purchase_return') {
        return navigation.navigate('Bills');       // notes are read, not edited
      }
      return navigation.navigate('Bill', { voucherId: r.id, vtype: r.vtype });
    }
    if (r.kind === 'payment') {
      return navigation.navigate('Money',
        { ptype: r.ptype || 'receipt', paymentId: r.id });
    }
  };

  // THE BILL ITSELF, FROM THE ACCOUNT.
  //
  // A customer ringing up about a figure on his statement wants that bill, not
  // a tour of the app. This fetches it and hands over the PDF then and there.
  //
  // It is built from the bill as it stands RIGHT NOW, every time — nothing is
  // kept or cached anywhere. So a bill corrected this morning produces a
  // corrected PDF this afternoon, and an old copy can never be sent by
  // accident.
  const pdfOf = async (r) => {
    if (r.kind !== 'voucher' || !r.id) return;
    setMaking(r.id);
    try {
      const [{ data: v, error: ve }, { data: ls, error: le }] = await Promise.all([
        supabase.from('vouchers').select('*').eq('id', r.id).maybeSingle(),
        supabase.from('voucher_lines').select('*').eq('voucher_id', r.id).order('line_no'),
      ]);
      if (ve || le || !v) throw (ve || le || new Error('That bill could not be read'));

      const paper = String(org?.print_width || 'a4');
      const html = paper === 'a4'
        ? invoiceHtml({ org, voucher: v, party, lines: ls || [] })
        : thermalHtml({ org, voucher: v, party, lines: ls || [], width: paper });

      const { uri } = await Print.printToFileAsync({ html });
      if (!(await Sharing.isAvailableAsync())) {
        return Alert.alert('Nothing to share with',
          'This phone has no app set up to receive files.');
      }
      await sharePdf(uri, pdfName({ who: party?.name, no: v?.voucher_no,
                                    fallback: org?.name || 'Bill' }), r.label || 'Bill');
    } catch (e) {
      Alert.alert('Could not make the PDF', sayPlainly(e));
    } finally { setMaking(null); }
  };

  const Col = ({ list, right: alignRight, show, more }) => {
    // The newest `show` of them, still in the order they happened. Older ones
    // are above, behind the button at the top of the column.
    const hidden = Math.max(0, list.length - show);
    const shown = hidden ? list.slice(hidden) : list;
    return (
    <View style={{ flex: 1, paddingHorizontal: 10,
                   borderRightWidth: alignRight ? 0 : 1.5, borderRightColor: C.line }}>
      {list.length === 0 && <Text style={{ color: C.faint }}>—</Text>}
      {hidden > 0 && (
        <TouchableOpacity onPress={more}
          style={{ marginBottom: 14, paddingVertical: 8,
                   alignItems: alignRight ? 'flex-end' : 'flex-start' }}>
          <Text style={{ fontSize: 12.5, fontWeight: '800', color: C.accent }}>
            ↑ {hidden} older
          </Text>
          <Text style={{ fontSize: 10.5, color: C.muted, marginTop: 2 }}>
            tap to show {Math.min(hidden, show === FIRST ? STEP - FIRST : STEP)} more
          </Text>
        </TouchableOpacity>
      )}
      {shown.map((r, i) => {
        const goes = !!r.id;
        return (
          <TouchableOpacity key={i} disabled={!goes} onPress={() => openRow(r)}
            style={{ marginBottom: 14, alignItems: alignRight ? 'flex-end' : 'flex-start' }}>
            <Text style={{ fontSize: 11.5, fontWeight: '600', color: C.muted }}>
              {/* An opening with no date on it read as "/ · Opening", which is
                  a shrug where a date should be. No date, no date. */}
              {r.d ? `${String(r.d).slice(8, 10)}/${String(r.d).slice(5, 7)} · ` : ''}{r.label}
            </Text>
            <Text style={[{ fontSize: 17, fontWeight: '800',
                            color: alignRight ? C.greenD : C.ink },
                          goes && { textDecorationLine: 'underline',
                                    textDecorationColor: C.greyB },
                          S.num]}>
              {fmt0(r.amt)}
            </Text>
            {r.kind === 'voucher' && !!r.id && (
              <TouchableOpacity onPress={() => pdfOf(r)} disabled={making === r.id}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                style={{ marginTop: 3 }}>
                <Text style={{ fontSize: 11, fontWeight: '700',
                               color: making === r.id ? C.faint : C.accent }}>
                  {making === r.id ? 'making…' : 'PDF ↓'}
                </Text>
              </TouchableOpacity>
            )}
          </TouchableOpacity>
        );
      })}
    </View>
    );
  };

  return (
    <Screen>
      <Head navigation={navigation} title={party?.name || ''} />

      {failed ? (
        <View style={{ margin: 12, padding: 12, backgroundColor: C.flagSoft,
                       borderWidth: 1, borderColor: C.flagLine, borderRadius: 12 }}>
          <Text style={{ fontSize: 13.5, fontWeight: '700', color: C.flagInk }}>
            This account could not be loaded
          </Text>
          <Text style={{ fontSize: 12, color: C.flagInk, marginTop: 3, lineHeight: 17 }}>
            What you see below is not his balance. Check your internet and open it again.
          </Text>
        </View>
      ) : (
        <Text style={{ fontSize: 12, color: C.muted, textAlign: 'center', marginTop: 10 }}>
          Tap any amount to open the bill or the entry behind it.
        </Text>
      )}

      <View style={{ margin: 16, padding: 15, borderRadius: 18, borderWidth: 1.5,
                     backgroundColor: owes ? C.redL : C.greenL,
                     borderColor: owes ? '#F0D2CA' : '#C6E4D3' }}>
        <Text style={[S.label, { color: owes ? C.red : C.greenD }]}>
          {owes ? `${(party?.name || '').toUpperCase()} OWES YOU` : `YOU OWE ${(party?.name || '').toUpperCase()}`}
        </Text>
        <Text style={[{ fontSize: 36, fontWeight: '800', marginTop: 2,
                        color: owes ? C.red : C.greenD }, S.num]}>
          ₹ {fmt0(Math.abs(balance))}
        </Text>

        {/* THE LAST HUNDRED RUPEES.

            A customer owing 10,100 pays 10,000 and both sides shake hands on
            it. There was no way to close the 100 except to enter cash that
            never came in, which put money in the cash book that is not in the
            cash box. Writing it off closes his account and touches neither
            the cash box nor the bank — it shows in the profit and loss for
            what it is, money given up. */}
        {isOwner && Math.abs(balance) > 0 && Math.abs(balance) <= 5000 && (
          <TouchableOpacity onPress={askWriteOff} disabled={busy}
            style={{ marginTop: 12, alignSelf: 'flex-start', paddingVertical: 8,
                     paddingHorizontal: 14, borderRadius: 10, borderWidth: 1,
                     borderColor: owes ? '#F0D2CA' : '#C6E4D3',
                     backgroundColor: C.surface }}>
            <Text style={{ fontSize: 13, fontWeight: '700',
                           color: owes ? C.red : C.greenD }}>
              {busy ? 'One moment…' : `Write off ₹${fmt0(Math.abs(balance))} and close it`}
            </Text>
          </TouchableOpacity>
        )}
      </View>

      {/* The price list a customer is on belongs on his record, under
          Customers, where it is set once and deliberately. A statement of
          account is for reading what he owes — not for changing how he is
          charged, which a stray tap here did silently to every future bill. */}

      <View style={[S.row, { marginHorizontal: 16, borderBottomWidth: 2,
                             borderBottomColor: C.ink, paddingBottom: 8 }]}>
        <Text style={[S.label, { flex: 1 }]}>SALES & GOODS GIVEN</Text>
        <Text style={[S.label, { flex: 1, textAlign: 'right' }]}>RECEIVED & RETURNS</Text>
      </View>

      <ScrollView contentContainerStyle={{ paddingHorizontal: 6, paddingTop: 14 }}>
        <View style={{ flexDirection: 'row' }}>
          <Col list={left} show={showL}
               more={() => setShowL((v) => (v === FIRST ? STEP : v + STEP))} />
          <Col list={right} right show={showR}
               more={() => setShowR((v) => (v === FIRST ? STEP : v + STEP))} />
        </View>
      </ScrollView>

      {/* THE TOTALS ARE OF THE WHOLE ACCOUNT, NOT OF WHAT IS ON SCREEN.
          Only the newest few entries are drawn, so a figure at the foot that
          added up only those would disagree with the balance in the box at the
          top — and he would have no way of telling which was the truth. */}
      <View style={[S.row, { marginHorizontal: 16, borderTopWidth: 2,
                             borderTopColor: C.ink, paddingVertical: 10 }]}>
        <Text style={[{ flex: 1, fontSize: 18, fontWeight: '800', color: C.ink }, S.num]}>
          {fmt0(sum(left))}
        </Text>
        <Text style={[{ flex: 1, fontSize: 18, fontWeight: '800', color: C.ink, textAlign: 'right' }, S.num]}>
          {fmt0(sum(right))}
        </Text>
      </View>
      {(left.length > showL || right.length > showR) && (
        <Text style={{ fontSize: 11, color: C.muted, textAlign: 'center', marginTop: -4 }}>
          Both figures are for the whole account, not only the entries shown.
        </Text>
      )}

      <View style={{ padding: 16, paddingBottom: 26 }}>
        <TouchableOpacity style={S.btn} onPress={share}>
          <Text style={S.btnText}>SEND THIS ACCOUNT</Text>
        </TouchableOpacity>
      </View>

      {/* WHICH MONTHS TO SEND. Asked once, before the PDF is built, because a
          statement running back three years is not what he meant by "send his
          account" and a customer will not read it. */}
      <Modal visible={period} transparent animationType="slide"
             onRequestClose={() => setPeriod(false)}>
        <View style={{ flex: 1, backgroundColor: '#3B3A35DD', justifyContent: 'flex-end' }}>
          <TouchableOpacity activeOpacity={1} style={{ flex: 1 }}
            onPress={() => setPeriod(false)} />
          <View style={{ backgroundColor: C.bg, borderTopLeftRadius: 26,
                         borderTopRightRadius: 26, padding: 20, paddingBottom: 28 }}>
            <Text style={{ fontSize: 20, fontWeight: '800', color: C.ink }}>
              How much of the account?
            </Text>
            <Text style={{ fontSize: 12.5, color: C.muted, marginTop: 5, lineHeight: 18 }}>
              Whatever you choose, the statement opens with the balance carried
              into it and closes on the balance at the end of it — so it adds up
              on its own, whichever months you send.
            </Text>
            {PERIODS.map((k) => (
              <TouchableOpacity key={k.k}
                onPress={() => { const [a, b] = spanOf(k.k); sendFor(a, b, k.file); }}
                style={{ paddingVertical: 15, borderBottomWidth: 1, borderBottomColor: C.line }}>
                <Text style={{ fontSize: 16, fontWeight: '700', color: C.ink }}>{k.label}</Text>
                <Text style={{ fontSize: 11.5, color: C.muted, marginTop: 2 }}>{k.sub}</Text>
              </TouchableOpacity>
            ))}
            <TouchableOpacity onPress={() => setPeriod(false)}
              style={{ marginTop: 14, alignItems: 'center', paddingVertical: 10 }}>
              <Text style={{ fontSize: 16, fontWeight: '700', color: C.muted }}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </Screen>
  );
}
