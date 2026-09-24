import React, { useCallback, useRef, useState } from 'react';
import {
  View, Text, TouchableOpacity, ScrollView, Alert, ActivityIndicator,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';

import { supabase, allRows } from '../lib/supabase';
import { useApp } from '../AppContext';
import { computeBill, fmt0, num, taxModeFor } from '../lib/money';
import { planSample } from '../lib/sample';
import { sayPlainly } from '../lib/offline';
import { Box, Head, Screen } from '../components/Chrome';
import { CalButton } from '../components/DatePick';
import { C, S } from '../theme';

// SEEING IT WORK, BEFORE TRUSTING IT.
//
// The bills this writes are ordinary bills. They take his real numbers, carry
// his real tax, print like the rest and can be edited afterwards like the
// rest. Nothing about them says "sample", because a bill that behaved
// differently would tell him nothing about his own shop.
//
// It draws on three things he already has: the money he has taken and not yet
// billed, what is actually on his shelves, and his own customers.

const p2 = (n) => String(n).padStart(2, '0');
const firstOfMonth = (d) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-01`;
const lastOfMonth  = (d) => {
  const e = new Date(d.getFullYear(), d.getMonth() + 1, 0);
  return `${e.getFullYear()}-${p2(e.getMonth() + 1)}-${p2(e.getDate())}`;
};

export default function SampleScreen({ navigation }) {
  const { org } = useApp();
  const lastMonth = new Date(new Date().getFullYear(), new Date().getMonth() - 1, 1);

  const [from, setFrom]   = useState(firstOfMonth(lastMonth));
  const [to, setTo]       = useState(lastOfMonth(lastMonth));
  const [count, setCount] = useState('50');
  const [total, setTotal] = useState('320000');
  const [plan, setPlan]   = useState(null);
  const [busy, setBusy]   = useState('');
  const [runs, setRuns]   = useState([]);
  const [money, setMoney] = useState(null);     // what the bank ledger holds for the period

  const fCount = useRef(null), fTotal = useRef(null);

  const loadRuns = useCallback(async () => {
    const { data } = await supabase.from('sample_runs').select('*')
      .order('created_at', { ascending: false }).limit(5);
    setRuns(data || []);
  }, []);

  useFocusEffect(useCallback(() => { loadRuns(); }, [loadRuns]));

  // What he has taken in that period and not yet billed — straight out of his
  // own money-received entries. Nothing is uploaded and nothing is typed.
  const lookAtMoney = async () => {
    setBusy('reading');
    try {
      const { data, error } = await supabase.rpc('unbilled_receipts',
        { p_from: from, p_to: to });
      if (error) throw error;
      setMoney(Array.isArray(data) ? data : []);
      return Array.isArray(data) ? data : [];
    } catch (e) {
      Alert.alert('Could not read your ledger', sayPlainly(e));
      return [];
    } finally { setBusy(''); }
  };

  const makePlan = async () => {
    setBusy('planning');
    try {
      const [items, parties, { data: stock }, recs] = await Promise.all([
        // unpaged, these stopped at 1,000 — and a shop past that got a NEW
        // customer invented for one it already had
        allRows(() => supabase.from('items').select('*').eq('is_active', true).order('id')),
        allRows(() => supabase.from('parties').select('*').order('id')),
        supabase.rpc('stock_now'),
        lookAtMoney(),
      ]);

      const p = planSample({
        org,
        items: items || [], parties: parties || [],
        receipts: recs || [],
        // A shop that does not keep stock has nothing to run out of; one that
        // does may never be sold past what is on the shelf.
        stock: org?.stock_enabled ? (Array.isArray(stock) ? stock : []) : null,
        from, to,
        count: Math.max(1, Math.min(500, parseInt(count, 10) || 0)),
        total: num(total),
      });
      if (p.problem) return Alert.alert('Not yet', p.problem);
      setPlan(p);
    } catch (e) {
      Alert.alert('Could not work it out', sayPlainly(e));
    } finally { setBusy(''); }
  };

  /* ---------------- writing them ---------------- */

  const write = async () => {
    if (!plan?.bills?.length) return;
    setBusy('writing');
    const madeVouchers = [], madeParties = [], tiedPayments = [];
    let done = 0, failed = 0, untied = 0, firstError = '';

    try {
      for (const b of plan.bills) {
        let party = b.party;
        if (party && !party.id) {
          const { data } = await supabase.from('parties')
            .insert({ org_id: org.id, name: party.name, kind: 'customer',
                      state_code: org.state_code, state_name: org.state_name })
            .select().single();
          // and remember it ON THE PLAN, because a receipt that became
          // several bills shares one customer between them — without this
          // the same walk-in name was created once per part
          if (data) { party = data; b.party = data; madeParties.push(data.id); }
        }

        // his own rules decide the tax: none if he is unregistered or on
        // composition, CGST and SGST at home, IGST out of state
        const mode = org?.mode === 'estimate' ? 'none' : taxModeFor(org, party);
        const raw = b.lines.map((l) => ({
          item_id: l.item.id, item_name: l.item.name, hsn: l.item.hsn || null,
          unit: l.item.unit || 'PCS', qty: l.qty, rate: l.rate,
          gst_rate: Number(l.item.gst_rate) || 0,
        }));
        // the rounding the bill was fitted with belongs to the bill, not to
        // whichever line happened to be last
        const c = computeBill(raw, mode, { discount: b.lines.discount || 0 });

        const { data, error } = await supabase.rpc('save_voucher', {
          p: {
            vtype: 'sale', vdate: b.vdate,
            party_id: party?.id || null,
            printed_name: party?.name || 'CASH',
            is_cash: !!b.is_cash,
            place_of_supply_code: party?.state_code || org.state_code,
            tax_mode: mode,
            taxable: c.taxable, cgst: c.cgst, sgst: c.sgst, igst: c.igst,
            discount: c.discount, round_off: c.round_off, total: c.total,
            lines: c.lines.map((l) => ({
              item_id: l.item_id, item_name: l.item_name, hsn: l.hsn, unit: l.unit,
              qty: l.qty, rate: l.rate, gst_rate: l.gst_rate, disc: l.disc,
              taxable: l.taxable, cgst: l.cgst, sgst: l.sgst, igst: l.igst,
              amount: l.amount,
            })),
          },
        });
        if (error || !data?.id) {
          failed++;
          if (!firstError) firstError = error?.message || 'the server refused it';
          continue;
        }
        madeVouchers.push(data.id);
        done++;

        // tie the money he already took to the bill it was for, so the
        // customer's ledger settles exactly as it would have
        if (b.receipt?.id) {
          const { error: le } = await supabase.from('payments')
            .update({ ref_voucher_id: data.id }).eq('id', b.receipt.id);
          if (le) {
            // THIS USED TO BE SWALLOWED, AND IT IS THE WORST KIND OF FAILURE.
            // The bill is in his books, but the money he already took is
            // still sitting there unexplained — so the customer's ledger
            // shows the bill AND the receipt, and it looks as though Fill
            // ignored the money altogether. He has to be told.
            untied++;
            if (!firstError) firstError = le.message || 'the receipt could not be linked';
          } else tiedPayments.push(b.receipt.id);
        }
      }

      if (madeVouchers.length) {
        await supabase.from('sample_runs').insert({
          org_id: org.id,
          note: `${from} to ${to} · ${madeVouchers.length} bills`,
          voucher_ids: madeVouchers, party_ids: madeParties, payment_ids: tiedPayments,
        });
      }

      setPlan(null);
      setMoney(null);
      await loadRuns();
      Alert.alert(failed ? 'Mostly done' : 'Done',
        `${done} bills are in your books.`
        + (tiedPayments.length ? `\n${tiedPayments.length} of them are settled against `
            + 'money you had already received.' : '')
        + (untied ? `\n\n${untied} bills were written, but the money already received `
            + `could NOT be linked to them — ${firstError}.\nThat money will still show as `
            + 'unbilled. Tell me if you see this.' : '')
        + (failed ? `\n\n${failed} could not be written — ${firstError}` : '')
        + '\n\nLook at Past bills, Reports, Udhar and Stock. This is your own month.');
    } catch (e) {
      Alert.alert('Stopped', sayPlainly(e));
    } finally { setBusy(''); }
  };

  const undo = (run) => Alert.alert('Take that run back out?',
    `${run.note || 'That run'} — the bills go, and any money that was tied to them `
    + 'goes back to standing on its own. Nothing else is touched.',
    [{ text: 'Leave it' },
     { text: 'Take it out', style: 'destructive', onPress: async () => {
         setBusy('undoing');
         const { error } = await supabase.rpc('undo_sample_run', { p_run: run.id });
         setBusy('');
         if (error) return Alert.alert('Could not', sayPlainly(error));
         await loadRuns();
         Alert.alert('Out', 'Those bills are gone.');
       } }]);

  const s = plan?.summary;
  const moneyTotal = (money || []).reduce((a, x) => a + num(x.amount), 0);
  // Money through the bank has to be explained by a bill; cash is the part
  // that bends. Shown apart so he can see the bank side is covered.
  const moneyBank = (money || []).filter((x) => String(x.mode || '').toLowerCase() !== 'cash')
    .reduce((a, x) => a + Number(x.amount || 0), 0);

  const Line = ({ k, v, strong }) => (
    <View style={[S.tline, { paddingVertical: 6 }]}>
      <Text style={S.tlineK}>{k}</Text>
      <Text style={[S.tlineV, strong && { fontWeight: '800' }]}>{v}</Text>
    </View>
  );

  return (
    <Screen>
      <Head navigation={navigation} title="Fill a month" />
      <ScrollView keyboardShouldPersistTaps="handled"
                  contentContainerStyle={{ padding: 14, paddingBottom: 40 }}>

        <View style={S.card}>
          <Text style={{ fontSize: 16, fontWeight: '800', color: C.ink }}>
            See your own month, before you bill a day of it
          </Text>
          <Text style={{ fontSize: 13, color: C.muted, marginTop: 8, lineHeight: 19 }}>
            Skwik writes real bills from your own items at your own rates, to your
            own customers. They carry your numbering and your tax, they print like
            every other bill, and you can open and change any of them afterwards.
            {'\n\n'}
            Where money has already come in and has no bill against it, the bill is
            built to match that amount to the rupee and tied to it — so the ledger
            settles exactly as it would have. Nothing is sold that you do not have
            in stock.
          </Text>
        </View>

        <Text style={S.label}>FROM</Text>
        <View style={[S.row, { marginTop: 6, gap: 8, alignItems: 'center' }]}>
          <Box style={[S.num, { flex: 1, marginBottom: 0 }]} value={from} onChangeText={setFrom}
            placeholder="2026-04-01" next={fCount} />
          <CalButton value={from} onPick={setFrom} size={48} max={to || undefined}
            title="Start of the month to fill" />
        </View>

        <Text style={[S.label, { marginTop: 12 }]}>TO</Text>
        <View style={[S.row, { marginTop: 6, gap: 8, alignItems: 'center' }]}>
          <Box style={[S.num, { flex: 1, marginBottom: 0 }]} value={to} onChangeText={setTo}
            placeholder="2026-04-30" next={fCount} />
          <CalButton value={to} onPick={setTo} size={48} min={from || undefined}
            title="End of the month to fill" />
        </View>

        <TouchableOpacity style={[S.btnGhost, { marginTop: 12 }]} onPress={lookAtMoney}
          disabled={!!busy}>
          <Text style={S.ghostText}>
            {busy === 'reading' ? 'Looking…' : 'What money came in that month?'}
          </Text>
        </TouchableOpacity>
        {money !== null && (
          <Text style={{ fontSize: 12.5, color: money.length ? C.accent : C.muted,
                         marginTop: 8, lineHeight: 18 }}>
            {money.length
              ? `${money.length} receipts, ₹${fmt0(moneyTotal)}, with no bill against them.`
                + (moneyBank > 0
                    ? `\n₹${fmt0(moneyBank)} of it came through the bank, and that is `
                      + 'settled first — cash is only touched after.'
                    : '\nBills will be built to match each one.')
              : 'Nothing received in that period is waiting for a bill. The amounts '
                + 'below will be made up instead.'}
          </Text>
        )}

        <View style={[S.row, { gap: 10, marginTop: 16 }]}>
          <View style={{ flex: 1 }}>
            <Text style={S.label}>HOW MANY BILLS</Text>
            <Box ref={fCount} next={fTotal} style={[S.num, { marginTop: 6 }]}
              keyboardType="number-pad" value={count} onChangeText={setCount} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={S.label}>ADDING UP TO</Text>
            <Box ref={fTotal} onSubmit={makePlan} style={[S.num, { marginTop: 6 }]}
              keyboardType="numeric" value={total} onChangeText={setTotal} />
          </View>
        </View>
        {num(count) > 0 && num(total) > 0 && (
          <Text style={{ fontSize: 12, color: C.muted, marginTop: 6 }}>
            About ₹{fmt0(num(total) / num(count))} a bill — bigger and smaller,
            the way a real month goes. Nothing over ₹35,000; if your figure
            needs more bills than that, it writes more.
          </Text>
        )}

        {!plan ? (
          <TouchableOpacity style={[S.btn, { marginTop: 20 }]} onPress={makePlan} disabled={!!busy}>
            <Text style={S.btnText}>
              {busy === 'planning' ? 'Working it out…' : 'Show me what it will write'}
            </Text>
          </TouchableOpacity>
        ) : (
          <View style={[S.card, { marginTop: 20 }]}>
            <Text style={S.eyebrow}>About to write</Text>
            <Line k="Bills" v={s.n} />
            {/* HE ASKED FOR A NUMBER; THE CEILING DECIDED A DIFFERENT ONE.
                No bill Skwik writes goes over ₹35,000, because a shop this
                size does not write single bills of a lakh. If his figure
                cannot be reached in the number he asked for without one going
                over, more are written — and he is told, not surprised. */}
            {s.n > (s.askedBills || 0) && (
              <Text style={{ fontSize: 12, color: C.muted, marginTop: -2,
                             marginBottom: 6, lineHeight: 17 }}>
                You asked for {s.askedBills}. No bill goes over ₹35,000, so
                ₹{fmt0(s.value)} needs {s.n}.
              </Text>
            )}
            {!!s.shortDays && (
              <Text style={{ fontSize: 12, color: C.flagInk, marginTop: -2,
                             marginBottom: 6, lineHeight: 17 }}>
                Some money could not be billed because the dates you gave do not
                hold enough separate days — a big receipt becomes several bills,
                one to a day. Widen the dates and run it again.
              </Text>
            )}
            <Line k="Adding up to" v={`₹${fmt0(s.value)}`} strong />
            <Line k="Across" v={`${s.days} days`} />
            <Line k="Different items" v={s.items} />
            {s.fromReceipts > 0 && (
              <Line k="Settled against money received"
                    v={`${s.fromReceipts} · ₹${fmt0(s.receiptValue)}`} />
            )}
            <Line k="Cash bills" v={s.cash} />

            {s.pooled != null && s.catalog > s.pooled && (
              <View style={{ backgroundColor: C.flagSoft, borderWidth: 1, borderColor: C.flagLine,
                             borderRadius: 10, padding: 10, marginTop: 10 }}>
                <Text style={{ fontSize: 12.5, fontWeight: '700', color: C.flagInk }}>
                  {s.pooled} of your {s.catalog} items have stock
                </Text>
                <Text style={{ fontSize: 12, color: C.flagInk, marginTop: 3, lineHeight: 17 }}>
                  A bill cannot sell what the shop has none of, so only those{' '}
                  {s.pooled} can appear — which is why the same few keep coming up.
                  Put in opening stock or a purchase bill for the rest and run it again.
                </Text>
              </View>
            )}

            {s.capped && (
              <View style={{ backgroundColor: C.flagSoft, borderWidth: 1, borderColor: C.flagLine,
                             borderRadius: 10, padding: 10, marginTop: 10 }}>
                <Text style={{ fontSize: 12.5, fontWeight: '700', color: C.flagInk }}>
                  Your stock is worth ₹{fmt0(s.stockRoof)}
                </Text>
                <Text style={{ fontSize: 12, color: C.flagInk, marginTop: 3, lineHeight: 17 }}>
                  So it stops at ₹{fmt0(s.value)} rather than send an item negative.
                  Enter more purchases and run it again for the rest.
                </Text>
              </View>
            )}

            {/* WHERE HIS FIGURE IS COMING FROM.
                Money in the bank is money somebody can see, so he needs to
                know it is all accounted for before he looks at anything
                else. If any of it could not be reached, that is the first
                thing said, not the last. */}
            {(s.bankValue > 0 || s.bankLeftOver > 0) && (
              <View style={{ backgroundColor: s.bankLeftOver > 0 ? C.flagSoft : C.soft,
                             borderWidth: 1,
                             borderColor: s.bankLeftOver > 0 ? C.flagLine : C.line,
                             borderRadius: 10, padding: 10, marginTop: 10 }}>
                <Text style={{ fontSize: 12.5, fontWeight: '700',
                               color: s.bankLeftOver > 0 ? C.flagInk : C.ink }}>
                  {s.bankLeftOver > 0
                    ? `₹${fmt0(s.bankLeftOver)} of bank money has no bill against it`
                    : `All ₹${fmt0(s.bankValue)} that came through the bank is covered`}
                </Text>
                <Text style={{ fontSize: 12, marginTop: 3, lineHeight: 17,
                               color: s.bankLeftOver > 0 ? C.flagInk : C.muted }}>
                  {s.bankLeftOver > 0
                    ? (s.missed > 0
                        ? `${s.missed} receipts could not have a bill raised for them. `
                          + 'A bill cannot sell what the shop does not have, so this is '
                          + 'nearly always the shelf running short — enter the purchases '
                          + 'for that month and run it again.'
                        : 'Ask for more bills, and run it again — bank entries are taken '
                          + 'first, so the rest will follow.')
                    : `The big ones are written as several bills on different days, `
                      + `the way they were bought, and the receipt settles the lot.\n`
                      + `Then ₹${fmt0(s.cashValue)} of cash receipts`
                      + (s.overAndAbove > 0
                          ? `, and ₹${fmt0(s.overAndAbove)} of counter cash on top.` : '.')}
                </Text>
              </View>
            )}

            <Text style={[S.eyebrow, { marginTop: 14 }]}>The first few</Text>
            {plan.bills.slice(0, 5).map((b, i) => (
              <Text key={i} numberOfLines={1}
                    style={{ fontSize: 12.5, color: C.ink, marginBottom: 3 }}>
                {b.vdate} · {b.party?.name || 'CASH'}
                <Text style={{ color: C.muted }}>
                  {'  '}{b.lines.length} item{b.lines.length === 1 ? '' : 's'} · ₹
                  {fmt0(b.total)}
                  {b.receipt ? ' · against money received'
                  : (b.partOf ? ' · part of money received' : '')}
                </Text>
              </Text>
            ))}

            <TouchableOpacity style={[S.btn, { marginTop: 16 }]} onPress={write} disabled={!!busy}>
              <Text style={S.btnText}>
                {busy === 'writing' ? 'Writing…' : `Write these ${s.n} bills`}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => setPlan(null)}
              style={{ marginTop: 12, alignItems: 'center', paddingVertical: 10 }}>
              <Text style={{ fontSize: 15, fontWeight: '600', color: C.muted }}>
                Change something
              </Text>
            </TouchableOpacity>
          </View>
        )}

        {runs.length > 0 && (
          <>
            <Text style={[S.eyebrow, { marginTop: 26 }]}>Runs you have made</Text>
            {runs.map((run) => (
              <View key={run.id} style={[S.line, { marginBottom: 8 }]}>
                <View style={S.row}>
                  <View style={{ flex: 1 }}>
                    <Text style={S.lineNm}>{run.note || 'A run'}</Text>
                    <Text style={{ fontSize: 11.5, color: C.muted, marginTop: 2 }}>
                      {String(run.created_at).slice(0, 10)} ·
                      {' '}{(run.voucher_ids || []).length} bills
                    </Text>
                  </View>
                  <TouchableOpacity onPress={() => undo(run)} disabled={!!busy}
                    hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                    <Text style={{ fontSize: 12.5, fontWeight: '800', color: C.danger }}>
                      TAKE OUT
                    </Text>
                  </TouchableOpacity>
                </View>
              </View>
            ))}
          </>
        )}

        <Text style={{ fontSize: 11.5, color: C.muted, marginTop: 20, lineHeight: 17 }}>
          These take real bill numbers, so your numbering moves on. If you take a
          run back out, set your next bill number under Settings before you start
          billing for real.
        </Text>
      </ScrollView>

      {!!busy && busy !== 'planning' && busy !== 'reading' && (
        <View style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0,
                       backgroundColor: '#3B3A35AA', alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator size="large" color="#fff" />
          <Text style={{ color: '#fff', fontWeight: '700', marginTop: 12 }}>
            {busy === 'writing' ? 'Writing the bills…' : 'Taking them out…'}
          </Text>
        </View>
      )}
    </Screen>
  );
}
